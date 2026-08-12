import { describe, expect, it, vi } from 'vitest';
import {
  AssemblyStreamingAdapter,
  buildAssemblyStreamingUrl,
  isDurableAssemblyTurn,
  type StreamingSessionConfiguration,
} from './assemblyStreamingAdapter';
import type { StreamingTranscriptionEvent } from './types';

class FakeSocket {
  readyState: number = window.WebSocket.CONNECTING;
  binaryType = '';
  bufferedAmount = 0;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();

  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(value: unknown) {
    this.sent.push(value);
  }

  close(code = 1000) {
    this.readyState = window.WebSocket.CLOSED;
    this.emit('close', { code });
  }

  begin(model = 'universal-3-5-pro') {
    this.readyState = window.WebSocket.OPEN;
    this.message({
      type: 'Begin',
      id: 'vendor-session',
      expires_at: Math.floor(Date.now() / 1_000) + 10_800,
      configuration: {
        model,
        mode: 'balanced',
        api_version: '2025-05-12',
        speaker_labels: true,
      },
    });
  }

  message(value: Record<string, unknown>) {
    this.emit('message', { data: JSON.stringify(value) });
  }

  emit(type: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function configuration(model = 'universal-3-5-pro'): StreamingSessionConfiguration {
  return {
    token: 'temporary-token',
    providerSessionId: 'gateway-session',
    model,
    sampleRate: 16_000,
    speakerLabels: true,
    expiresAtMs: Date.now() + 60_000,
    maxSessionDurationSeconds: 10_800,
  };
}

describe('AssemblyStreamingAdapter protocol normalization', () => {
  it('adds format_turns only for universal streaming models', () => {
    const common = {
      token: 'temporary-token',
      providerSessionId: 'session-1',
      sampleRate: 16_000,
      speakerLabels: true,
      expiresAtMs: Date.now() + 60_000,
      maxSessionDurationSeconds: 10_800,
    };
    const economical = new URL(
      buildAssemblyStreamingUrl({ ...common, model: 'universal-streaming-english' })
    );
    const premium = new URL(buildAssemblyStreamingUrl({ ...common, model: 'universal-3-5-pro' }));
    expect(economical.searchParams.get('format_turns')).toBe('true');
    expect(premium.searchParams.has('format_turns')).toBe(false);
    expect(premium.searchParams.get('speaker_labels')).toBe('true');
    expect(premium.searchParams.get('speech_model')).toBe('universal-3-5-pro');
    expect(premium.searchParams.has('model')).toBe(false);
  });

  it('replaces a legacy model query parameter with the authoritative speech_model', () => {
    const url = new URL(
      buildAssemblyStreamingUrl({
        ...configuration(),
        websocketUrl: 'wss://streaming.assemblyai.com/v3/ws?model=legacy-model',
      })
    );
    expect(url.searchParams.has('model')).toBe(false);
    expect(url.searchParams.get('speech_model')).toBe('universal-3-5-pro');
  });

  it('does not durable-finalize the unformatted duplicate universal streaming turn', () => {
    expect(
      isDurableAssemblyTurn('universal-streaming-multilingual', {
        end_of_turn: true,
        turn_is_formatted: false,
      })
    ).toBe(false);
    expect(
      isDurableAssemblyTurn('universal-streaming-multilingual', {
        end_of_turn: true,
        turn_is_formatted: true,
      })
    ).toBe(true);
    expect(
      isDurableAssemblyTurn('universal-3-5-pro', {
        end_of_turn: true,
        turn_is_formatted: false,
      })
    ).toBe(true);
  });

  it('keeps partial/final revisions on one identity and waits for final speaker revision', async () => {
    const socket = new FakeSocket();
    const events: StreamingTranscriptionEvent[] = [];
    const adapter = new AssemblyStreamingAdapter(
      configuration(),
      (event) => events.push(event),
      () => socket as unknown as InstanceType<typeof window.WebSocket>
    );
    const connected = adapter.connect();
    socket.begin();
    await connected;
    socket.message({
      type: 'Turn',
      turn_id: 'turn-1',
      turn_order: 1,
      speaker_label: 'A',
      transcript: 'The reported',
      end_of_turn: false,
      turn_is_formatted: false,
      words: [
        { text: 'The', start: 120, end: 300, confidence: 0.99 },
        { text: 'reported', start: 340, end: 600, confidence: 0.97 },
      ],
    });
    socket.message({
      type: 'Turn',
      turn_id: 'turn-1',
      turn_order: 1,
      speaker_label: 'A',
      transcript: 'The reported figure was 42 percent.',
      end_of_turn: true,
      turn_is_formatted: false,
      words: [
        { text: 'The', start: 120, end: 300, confidence: 0.99 },
        { text: 'reported', start: 340, end: 600, confidence: 0.97 },
        { text: 'figure was 42 percent.', start: 650, end: 1_600, confidence: 0.95 },
      ],
    });

    const turns = events.filter((event) => event.type === 'turn');
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.turnId)).toEqual(['turn-1', 'turn-1']);
    expect(turns.map((turn) => turn.revision)).toEqual([0, 1]);
    expect(turns[1].durableFinal).toBe(true);
    expect(turns[1]).toMatchObject({ startMs: 120, endMs: 1_600 });

    const termination = adapter.terminate(500);
    expect(socket.sent).toContain(JSON.stringify({ type: 'Terminate' }));
    socket.message({
      type: 'SpeakerRevision',
      revisions: [{ turn_order: 1, speaker_label: 'B', words: [] }],
    });
    socket.message({
      type: 'Termination',
      audio_duration_seconds: 1.6,
      session_duration_seconds: 2.1,
    });
    await termination;

    expect(events.map((event) => event.type)).toEqual([
      'begin',
      'turn',
      'turn',
      'speaker_revision',
      'termination',
    ]);
    expect(events.find((event) => event.type === 'speaker_revision')).toMatchObject({
      revisions: [{ turnOrder: 1, speakerLabel: 'B' }],
    });
  });

  it('bounds queued WebSocket audio and reconnects instead of growing renderer memory', async () => {
    const socket = new FakeSocket();
    const events: StreamingTranscriptionEvent[] = [];
    const adapter = new AssemblyStreamingAdapter(
      configuration(),
      (event) => events.push(event),
      () => socket as unknown as InstanceType<typeof window.WebSocket>
    );
    const connected = adapter.connect();
    socket.begin();
    await connected;
    socket.bufferedAmount = 1_048_576;

    adapter.sendAudio(new ArrayBuffer(2_560));

    expect(socket.readyState).toBe(window.WebSocket.CLOSED);
    expect(socket.sent).not.toContainEqual(expect.any(ArrayBuffer));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'stt_backpressure', retryable: true }),
      })
    );
  });

  it('fails closed when Begin echoes a different model and reports abrupt disconnects', async () => {
    const socket = new FakeSocket();
    const onEvent = vi.fn();
    const adapter = new AssemblyStreamingAdapter(
      configuration(),
      onEvent,
      () => socket as unknown as InstanceType<typeof window.WebSocket>
    );
    const connected = adapter.connect();
    socket.begin('universal-2');
    await expect(connected).rejects.toThrow('different model');
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'stt_model_mismatch', retryable: false }),
      })
    );

    const abruptSocket = new FakeSocket();
    const abruptEvents: StreamingTranscriptionEvent[] = [];
    const abrupt = new AssemblyStreamingAdapter(
      configuration(),
      (event) => abruptEvents.push(event),
      () => abruptSocket as unknown as InstanceType<typeof window.WebSocket>
    );
    const abruptConnected = abrupt.connect();
    abruptSocket.begin();
    await abruptConnected;
    abruptSocket.close(1006);
    expect(abruptEvents[abruptEvents.length - 1]).toMatchObject({
      type: 'error',
      error: { code: 'stt_connection_closed', retryable: true },
    });
  });

  it('rejects promptly when the provider closes before Begin', async () => {
    const socket = new FakeSocket();
    const onEvent = vi.fn();
    const adapter = new AssemblyStreamingAdapter(
      configuration(),
      onEvent,
      () => socket as unknown as InstanceType<typeof window.WebSocket>
    );
    const connected = adapter.connect();
    socket.close(1000);

    await expect(connected).rejects.toThrow('closed before');
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'stt_connection_closed', retryable: true }),
      })
    );
  });
});
