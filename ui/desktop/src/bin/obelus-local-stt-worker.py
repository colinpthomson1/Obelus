#!/usr/bin/env python3
import argparse
import copy
import json
import queue
import struct
import sys
import threading
import time
import warnings

warnings.filterwarnings("ignore", category=RuntimeWarning)

import numpy as np
from faster_whisper import WhisperModel


SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
MAX_HEADER_BYTES = 16_384
MAX_QUEUED_AUDIO_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 60
MAX_DECODE_BATCH_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 6
DECODE_RETRY_DELAYS_SECONDS = (0.1, 0.25)
EMIT_LOCK = threading.Lock()


def emit(payload):
    with EMIT_LOCK:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def read_exact(length):
    chunks = bytearray()
    while len(chunks) < length:
        chunk = sys.stdin.buffer.read(length - len(chunks))
        if not chunk:
            raise EOFError()
        chunks.extend(chunk)
    return bytes(chunks)


def read_message():
    header_length = struct.unpack(">I", read_exact(4))[0]
    if header_length <= 0 or header_length > MAX_HEADER_BYTES:
        raise ValueError("invalid_header")
    header = json.loads(read_exact(header_length).decode("utf-8"))
    pcm_bytes = header.get("pcmBytes", 0)
    if not isinstance(pcm_bytes, int) or pcm_bytes < 0:
        raise ValueError("invalid_audio_length")
    return header, read_exact(pcm_bytes) if pcm_bytes else b""


class RollingTranscriber:
    def __init__(
        self,
        model,
        session_id,
        chunk_seconds,
        stride_seconds,
        initial_partial_seconds,
        update_seconds,
    ):
        self.model = model
        self.session_id = session_id
        self.chunk_samples = chunk_seconds * SAMPLE_RATE
        self.stride_samples = stride_seconds * SAMPLE_RATE
        self.initial_partial_samples = round(initial_partial_seconds * SAMPLE_RATE)
        self.update_samples = round(update_seconds * SAMPLE_RATE)
        self.partial_tail_guard_samples = round(0.2 * SAMPLE_RATE)
        self.buffer = bytearray()
        self.buffer_start_sample = 0
        self.total_samples = 0
        self.turn_order = 0
        self.revision = -1
        self.last_decode_samples = 0
        self.last_commit_samples = 0
        self.last_fingerprint = None
        self.last_turn = None

    def snapshot(self):
        return {
            "buffer": bytes(self.buffer),
            "buffer_start_sample": self.buffer_start_sample,
            "total_samples": self.total_samples,
            "turn_order": self.turn_order,
            "revision": self.revision,
            "last_decode_samples": self.last_decode_samples,
            "last_commit_samples": self.last_commit_samples,
            "last_fingerprint": self.last_fingerprint,
            "last_turn": copy.deepcopy(self.last_turn),
        }

    def restore(self, state):
        self.buffer = bytearray(state["buffer"])
        self.buffer_start_sample = state["buffer_start_sample"]
        self.total_samples = state["total_samples"]
        self.turn_order = state["turn_order"]
        self.revision = state["revision"]
        self.last_decode_samples = state["last_decode_samples"]
        self.last_commit_samples = state["last_commit_samples"]
        self.last_fingerprint = state["last_fingerprint"]
        self.last_turn = state["last_turn"]

    def append(self, pcm):
        if len(pcm) % BYTES_PER_SAMPLE != 0:
            raise ValueError("unaligned_audio")
        self.buffer.extend(pcm)
        self.total_samples += len(pcm) // BYTES_PER_SAMPLE
        turns = []
        chunk_bytes = self.chunk_samples * BYTES_PER_SAMPLE
        stride_bytes = self.stride_samples * BYTES_PER_SAMPLE
        while len(self.buffer) >= chunk_bytes:
            window = bytes(self.buffer[:chunk_bytes])
            if self.last_turn and self.last_commit_samples >= self.stride_samples:
                turns.extend(self.finalize_cached_turn())
            else:
                turns.extend(self.transcribe(window, self.stride_samples, True))
            del self.buffer[:stride_bytes]
            self.buffer_start_sample += self.stride_samples
            self.finish_turn()
        buffer_samples = len(self.buffer) // BYTES_PER_SAMPLE
        if self.should_emit_partial(buffer_samples):
            commit_samples = min(
                self.stride_samples,
                max(0, buffer_samples - self.partial_tail_guard_samples),
            )
            if commit_samples > 0:
                turns.extend(self.transcribe(bytes(self.buffer), commit_samples, False))
            self.last_decode_samples = buffer_samples
        return turns

    def flush(self):
        if not self.buffer:
            return []
        window = bytes(self.buffer)
        commit_samples = len(window) // BYTES_PER_SAMPLE
        turns = self.transcribe(window, commit_samples, True)
        if not turns and self.last_turn and not self.last_turn["durableFinal"]:
            turns = self.finalize_cached_turn()
        self.buffer.clear()
        self.buffer_start_sample += commit_samples
        self.finish_turn()
        return turns

    def should_emit_partial(self, buffer_samples):
        if self.last_decode_samples == 0:
            return buffer_samples >= self.initial_partial_samples
        return buffer_samples - self.last_decode_samples >= self.update_samples

    def transcribe(self, pcm, commit_samples, durable_final):
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _info = self.model.transcribe(
            audio,
            language="en",
            beam_size=1,
            best_of=1,
            condition_on_previous_text=False,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300, "speech_pad_ms": 100},
            word_timestamps=True,
        )
        commit_end_seconds = commit_samples / SAMPLE_RATE
        selected = []
        for segment in segments:
            for word in segment.words or []:
                midpoint = (word.start + word.end) / 2
                if midpoint < commit_end_seconds:
                    selected.append(word)
        if not selected:
            return []

        turn_order = self.turn_order
        base_ms = self.buffer_start_sample * 1000 / SAMPLE_RATE
        words = []
        for index, word in enumerate(selected):
            words.append(
                {
                    "id": f"{self.session_id}:turn:{turn_order}:word:{index}",
                    "text": word.word.strip(),
                    "startMs": round(base_ms + word.start * 1000),
                    "endMs": round(base_ms + word.end * 1000),
                    "confidence": float(word.probability),
                    "final": durable_final,
                }
            )
        text = "".join(word.word for word in selected).strip()
        fingerprint = json.dumps(
            [
                text,
                [(word["text"], word["startMs"], word["endMs"]) for word in words],
                durable_final,
            ],
            separators=(",", ":"),
        )
        if fingerprint == self.last_fingerprint:
            return []
        self.revision += 1
        turn = {
            "turnId": f"local-turn-{turn_order}",
            "turnOrder": turn_order,
            "revision": self.revision,
            "durableFinal": durable_final,
            "utteranceBoundary": durable_final,
            "text": text,
            "words": words,
            "startMs": words[0]["startMs"],
            "endMs": words[-1]["endMs"],
        }
        self.last_fingerprint = fingerprint
        self.last_commit_samples = commit_samples
        self.last_turn = turn
        return [turn]

    def finalize_cached_turn(self):
        if not self.last_turn or self.last_turn["durableFinal"]:
            return []
        self.revision += 1
        turn = {
            **self.last_turn,
            "revision": self.revision,
            "durableFinal": True,
            "utteranceBoundary": True,
            "words": [{**word, "final": True} for word in self.last_turn["words"]],
        }
        self.last_turn = turn
        self.last_fingerprint = json.dumps(
            [
                turn["text"],
                [(word["text"], word["startMs"], word["endMs"]) for word in turn["words"]],
                True,
            ],
            separators=(",", ":"),
        )
        return [turn]

    def finish_turn(self):
        if self.last_turn:
            self.turn_order += 1
        self.revision = -1
        self.last_decode_samples = 0
        self.last_commit_samples = 0
        self.last_fingerprint = None
        self.last_turn = None


def load_model(model_name):
    return WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        cpu_threads=6,
        num_workers=1,
        local_files_only=True,
    )


class ContinuityQueue:
    def __init__(self):
        self.commands = queue.Queue()
        self.condition = threading.Condition()
        self.queued_audio_bytes = 0
        self.failed = False

    def put_audio(self, pcm):
        with self.condition:
            while (
                not self.failed
                and self.queued_audio_bytes + len(pcm) > MAX_QUEUED_AUDIO_BYTES
            ):
                self.condition.wait()
            if self.failed:
                raise RuntimeError("decoder_unavailable")
            self.queued_audio_bytes += len(pcm)
        self.commands.put(("append", pcm))

    def put_stop(self, request_id):
        self.commands.put(("stop", request_id))

    def release_audio(self, byte_count):
        with self.condition:
            self.queued_audio_bytes -= byte_count
            self.condition.notify_all()

    def fail(self):
        with self.condition:
            self.failed = True
            self.condition.notify_all()


def transcribe_with_retry(transcriber, pcm):
    state = transcriber.snapshot()
    for retry_delay in (*DECODE_RETRY_DELAYS_SECONDS, None):
        try:
            return transcriber.append(pcm)
        except Exception:
            transcriber.restore(state)
            if retry_delay is None:
                raise
            time.sleep(retry_delay)
    return []


def run_decoder(transcriber, continuity_queue):
    try:
        while True:
            command_type, value = continuity_queue.commands.get()
            if command_type == "stop":
                turns = transcriber.flush()
                emit(
                    {
                        "type": "stopped",
                        "requestId": value,
                        "turns": turns,
                        "audioDurationSeconds": transcriber.total_samples / SAMPLE_RATE,
                    }
                )
                return

            pending_audio = bytearray(value)
            stop_request_id = None
            while True:
                try:
                    next_type, next_value = continuity_queue.commands.get_nowait()
                except queue.Empty:
                    break
                if next_type == "stop":
                    stop_request_id = next_value
                    break
                pending_audio.extend(next_value)

            for offset in range(0, len(pending_audio), MAX_DECODE_BATCH_BYTES):
                batch = bytes(pending_audio[offset : offset + MAX_DECODE_BATCH_BYTES])
                turns = transcribe_with_retry(transcriber, batch)
                if turns:
                    emit({"type": "turns", "turns": turns})
                continuity_queue.release_audio(len(batch))

            if stop_request_id is not None:
                turns = transcriber.flush()
                emit(
                    {
                        "type": "stopped",
                        "requestId": stop_request_id,
                        "turns": turns,
                        "audioDurationSeconds": transcriber.total_samples / SAMPLE_RATE,
                    }
                )
                return
    except Exception:
        continuity_queue.fail()
        emit({"type": "error", "code": "local_stt_decode_failed", "retryable": True})


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model", default="base.en")
    parser.add_argument("--session-id", default="probe")
    parser.add_argument("--chunk-seconds", type=int, default=4)
    parser.add_argument("--stride-seconds", type=int, default=3)
    parser.add_argument("--initial-partial-seconds", type=float, default=1.5)
    parser.add_argument("--update-seconds", type=float, default=1.0)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    if (
        args.model != "base.en"
        or args.chunk_seconds != 4
        or args.stride_seconds != 3
        or args.initial_partial_seconds != 1.5
        or args.update_seconds != 1.0
    ):
        raise ValueError("unsupported_configuration")

    try:
        model = load_model(args.model)
    except Exception:
        if args.probe:
            emit({"type": "support", "available": False, "model": args.model})
            return 2
        emit({"type": "error", "code": "local_stt_unavailable", "retryable": False})
        return 2

    if args.probe:
        emit({"type": "support", "available": True, "model": args.model})
        return 0

    transcriber = RollingTranscriber(
        model,
        args.session_id,
        args.chunk_seconds,
        args.stride_seconds,
        args.initial_partial_seconds,
        args.update_seconds,
    )
    continuity_queue = ContinuityQueue()
    decoder = threading.Thread(
        target=run_decoder,
        args=(transcriber, continuity_queue),
        name="obelus-local-stt-decoder",
        daemon=True,
    )
    decoder.start()
    emit({"type": "ready", "model": args.model})
    expected_sequence = 0
    while True:
        try:
            header, pcm = read_message()
        except EOFError:
            return 0
        except Exception:
            emit({"type": "error", "code": "local_stt_protocol_error", "retryable": False})
            return 2

        request_id = header.get("requestId")
        try:
            if header.get("type") == "append":
                sequence = header.get("sequence")
                if sequence != expected_sequence or not pcm or len(pcm) % BYTES_PER_SAMPLE != 0:
                    raise ValueError("invalid_audio_sequence")
                continuity_queue.put_audio(pcm)
                expected_sequence += 1
                emit(
                    {
                        "type": "accepted",
                        "requestId": request_id,
                        "sequence": sequence,
                    }
                )
            elif header.get("type") == "stop":
                continuity_queue.put_stop(request_id)
                decoder.join()
                return 0
            else:
                raise ValueError("invalid_message")
        except Exception:
            emit(
                {
                    "type": "requestError",
                    "requestId": request_id,
                    "code": "local_stt_decode_failed",
                    "retryable": True,
                }
            )


if __name__ == "__main__":
    sys.exit(main())
