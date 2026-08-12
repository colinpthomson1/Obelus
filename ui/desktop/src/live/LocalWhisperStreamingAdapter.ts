import type { StreamingTranscriptionProvider } from './assemblyStreamingAdapter';
import type { LiveAudioSourceKind } from './ipcTypes';
import {
  LOCAL_STT_SAMPLE_RATE,
  type LocalSttAppendRequest,
  type LocalSttClient,
  type LocalSttStartResponse,
  type LocalSttTurn,
} from './localSttProtocol';
import type { StreamingTranscriptionEvent, TypedError } from './types';

const MAX_QUEUED_AUDIO_BYTES = LOCAL_STT_SAMPLE_RATE * 2 * 60;
const BACKPRESSURE_RETRY_MS = 25;

export interface LocalWhisperStreamingConfiguration {
  meetingId: string;
  sourceKind: LiveAudioSourceKind;
  sampleRate: typeof LOCAL_STT_SAMPLE_RATE;
}

function localError(code: string, message: string, retryable: boolean): TypedError {
  return { code, message, retryable };
}

export class LocalWhisperStreamingAdapter implements StreamingTranscriptionProvider {
  private session?: LocalSttStartResponse;
  private connectPromise?: Promise<void>;
  private queue: ArrayBuffer[] = [];
  private queuedBytes = 0;
  private sequence = 0;
  private pumpPromise?: Promise<void>;
  private releasePromise?: Promise<void>;
  private accepting = true;
  private closed = false;
  private errorReported = false;

  constructor(
    private readonly configuration: LocalWhisperStreamingConfiguration,
    private readonly client: LocalSttClient,
    private readonly onEvent: (event: StreamingTranscriptionEvent) => void
  ) {}

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal();
    return this.connectPromise;
  }

  sendAudio(frame: ArrayBuffer): void {
    if (!this.accepting || this.closed || frame.byteLength === 0) return;
    if (this.queuedBytes + frame.byteLength > MAX_QUEUED_AUDIO_BYTES) {
      this.reportError(
        'local_stt_backpressure',
        'Local transcription fell behind. Local audio recording will continue while Obelus reconnects.',
        true
      );
      return;
    }
    const ownedFrame = frame.slice(0);
    this.queue.push(ownedFrame);
    this.queuedBytes += ownedFrame.byteLength;
    this.startPump();
  }

  async terminate(): Promise<void> {
    if (this.releasePromise) {
      await this.releasePromise;
      return;
    }
    if (this.closed) return;
    this.accepting = false;
    do {
      this.startPump();
      await this.pumpPromise;
    } while (this.queue.length > 0 || this.pumpPromise);
    if (this.releasePromise) {
      await this.releasePromise;
      return;
    }
    await this.releaseSession(true);
  }

  close(): void {
    if (this.releasePromise) return;
    this.accepting = false;
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    void this.releaseSession(false).catch(() => undefined);
  }

  waitUntilReleased(): Promise<void> {
    return this.releasePromise ?? Promise.resolve();
  }

  private async connectInternal(): Promise<void> {
    try {
      const session = await this.client.startLocalStt({
        meetingId: this.configuration.meetingId,
        sourceKind: this.configuration.sourceKind,
        sampleRate: this.configuration.sampleRate,
      });
      this.session = session;
      if (this.closed) return;
      this.onEvent({
        type: 'begin',
        providerSessionId: session.providerSessionId,
        requestedModel: session.model,
        configuredModel: session.model,
      });
      this.startPump();
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : 'Local transcription could not start. Local audio recording will continue.';
      this.reportError('local_stt_unavailable', message, false);
      throw new Error(message);
    }
  }

  private startPump(): void {
    if (!this.session || this.pumpPromise || this.closed) return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = undefined;
      if (this.queue.length > 0 && !this.closed) this.startPump();
    });
  }

  private async pump(): Promise<void> {
    while (this.queue.length > 0 && !this.closed) {
      const pcm = this.queue.shift();
      if (!pcm) return;
      const request: LocalSttAppendRequest = {
        meetingId: this.configuration.meetingId,
        sessionId: this.session!.sessionId,
        sequence: this.sequence,
        pcm,
      };
      try {
        const result = await this.client.appendLocalSttAudio(request);
        for (const turn of result.turns) this.emitTurn(turn);
        if (!result.accepted) {
          this.queue.unshift(pcm);
          await new Promise((resolve) => setTimeout(resolve, BACKPRESSURE_RETRY_MS));
          continue;
        }
        this.sequence += 1;
        this.queuedBytes = Math.max(0, this.queuedBytes - pcm.byteLength);
      } catch {
        this.queuedBytes = Math.max(0, this.queuedBytes - pcm.byteLength);
        this.reportError(
          'local_stt_transport_error',
          'Local transcription disconnected. Local audio recording will continue.',
          true
        );
        return;
      }
    }
  }

  private releaseSession(emitTermination: boolean): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    const operation = (async () => {
      await this.connectPromise?.catch(() => undefined);
      const session = this.session;
      if (!session) return;
      const result = await this.client.stopLocalStt({
        meetingId: this.configuration.meetingId,
        sessionId: session.sessionId,
      });
      for (const turn of result.turns) this.emitTurn(turn);
      if (emitTermination) {
        this.onEvent({
          type: 'termination',
          providerSessionId: session.providerSessionId,
          audioDurationSeconds: result.audioDurationSeconds,
        });
      }
    })().finally(() => {
      this.accepting = false;
      this.closed = true;
      this.queue = [];
      this.queuedBytes = 0;
    });
    this.releasePromise = operation;
    return operation;
  }

  private emitTurn(turn: LocalSttTurn): void {
    const providerSessionId = this.session?.providerSessionId;
    if (!providerSessionId) return;
    this.onEvent({
      type: 'turn',
      providerSessionId,
      turnId: turn.turnId,
      turnOrder: turn.turnOrder,
      revision: turn.revision,
      transcript: turn.text,
      words: turn.words,
      startMs: turn.startMs,
      endMs: turn.endMs,
      utteranceBoundary: turn.utteranceBoundary,
      endOfTurn: turn.durableFinal,
      turnIsFormatted: turn.durableFinal,
      durableFinal: turn.durableFinal,
      receivedAtMs: Date.now(),
    });
  }

  private reportError(code: string, message: string, retryable: boolean): void {
    if (this.errorReported) return;
    this.errorReported = true;
    this.onEvent({
      type: 'error',
      providerSessionId: this.session?.providerSessionId,
      error: localError(code, message, retryable),
    });
  }
}
