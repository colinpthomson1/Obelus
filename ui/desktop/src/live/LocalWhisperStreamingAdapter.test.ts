import { describe, expect, it, vi } from 'vitest';
import type { LocalSttAppendRequest, LocalSttClient, LocalSttTurn } from './localSttProtocol';
import { LocalWhisperStreamingAdapter } from './LocalWhisperStreamingAdapter';
import type { StreamingTranscriptionEvent } from './types';

const meetingId = 'meeting-local-stt';
const session = {
  sessionId: 'local-session',
  providerSessionId: 'local-provider-session',
  model: 'base.en' as const,
};

function turn(turnOrder: number, text: string): LocalSttTurn {
  return {
    turnId: `turn-${turnOrder}`,
    turnOrder,
    revision: 0,
    durableFinal: true,
    utteranceBoundary: true,
    text,
    startMs: turnOrder * 5_000,
    endMs: turnOrder * 5_000 + 900,
    words: [
      {
        id: `word-${turnOrder}`,
        text,
        startMs: turnOrder * 5_000,
        endMs: turnOrder * 5_000 + 900,
        confidence: 0.9,
        final: true,
      },
    ],
  };
}

function client(overrides: Partial<LocalSttClient> = {}): LocalSttClient {
  return {
    getLocalSttSupport: vi.fn().mockResolvedValue({ available: true, model: 'base.en' }),
    startLocalStt: vi.fn().mockResolvedValue(session),
    appendLocalSttAudio: vi.fn().mockResolvedValue({ accepted: true, droppedFrames: 0, turns: [] }),
    stopLocalStt: vi.fn().mockResolvedValue({ turns: [], audioDurationSeconds: 0 }),
    ...overrides,
  };
}

describe('LocalWhisperStreamingAdapter', () => {
  it('normalizes direct RPC turns into durable provider events and flushes the tail', async () => {
    const events: StreamingTranscriptionEvent[] = [];
    const api = client({
      appendLocalSttAudio: vi
        .fn()
        .mockResolvedValue({ accepted: true, droppedFrames: 0, turns: [turn(0, 'First words.')] }),
      stopLocalStt: vi
        .fn()
        .mockResolvedValue({ turns: [turn(1, 'Tail words.')], audioDurationSeconds: 6.4 }),
    });
    const adapter = new LocalWhisperStreamingAdapter(
      { meetingId, sourceKind: 'mixed', sampleRate: 16_000 },
      api,
      (event) => events.push(event)
    );

    await adapter.connect();
    adapter.sendAudio(new ArrayBuffer(3_200));
    await vi.waitFor(() => expect(events.some((event) => event.type === 'turn')).toBe(true));
    await adapter.terminate();

    expect(events.map((event) => event.type)).toEqual(['begin', 'turn', 'turn', 'termination']);
    const turns = events.filter((event) => event.type === 'turn');
    expect(turns.map((event) => event.transcript)).toEqual(['First words.', 'Tail words.']);
    expect(turns.every((event) => event.durableFinal)).toBe(true);
    expect(api.stopLocalStt).toHaveBeenCalledWith({ meetingId, sessionId: session.sessionId });
  });

  it('preserves stable partial revisions before a durable final', async () => {
    const events: StreamingTranscriptionEvent[] = [];
    const partial = {
      ...turn(0, 'Progressive words'),
      revision: 0,
      durableFinal: false,
      utteranceBoundary: false,
      words: turn(0, 'Progressive words').words.map((word) => ({ ...word, final: false })),
    };
    const final = { ...turn(0, 'Progressive words complete.'), revision: 1 };
    const api = client({
      appendLocalSttAudio: vi
        .fn()
        .mockResolvedValueOnce({ accepted: true, droppedFrames: 0, turns: [partial] })
        .mockResolvedValueOnce({ accepted: true, droppedFrames: 0, turns: [final] }),
    });
    const adapter = new LocalWhisperStreamingAdapter(
      { meetingId, sourceKind: 'mixed', sampleRate: 16_000 },
      api,
      (event) => events.push(event)
    );
    await adapter.connect();

    adapter.sendAudio(new ArrayBuffer(3_200));
    adapter.sendAudio(new ArrayBuffer(3_200));
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'turn')).toHaveLength(2));

    const turns = events.filter((event) => event.type === 'turn');
    expect(turns).toMatchObject([
      { turnId: 'turn-0', revision: 0, durableFinal: false, endOfTurn: false },
      { turnId: 'turn-0', revision: 1, durableFinal: true, endOfTurn: true },
    ]);
    adapter.close();
  });

  it('preserves forty-five seconds of continuous PCM while transport is stalled, then drains in order', async () => {
    const events: StreamingTranscriptionEvent[] = [];
    let releaseFirstAppend: (() => void) | undefined;
    const firstAppendGate = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    const appendLocalSttAudio = vi.fn(async (request: LocalSttAppendRequest) => {
      if (request.sequence === 0) await firstAppendGate;
      return { accepted: true, droppedFrames: 0, turns: [] };
    });
    const api = client({ appendLocalSttAudio });
    const adapter = new LocalWhisperStreamingAdapter(
      { meetingId, sourceKind: 'microphone', sampleRate: 16_000 },
      api,
      (event) => events.push(event)
    );
    await adapter.connect();

    for (let frame = 0; frame < 450; frame += 1) {
      adapter.sendAudio(new ArrayBuffer(3_200));
    }
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);

    releaseFirstAppend?.();
    await adapter.terminate();

    expect(appendLocalSttAudio).toHaveBeenCalledTimes(450);
    expect(appendLocalSttAudio.mock.calls.map(([request]) => request.sequence)).toEqual(
      Array.from({ length: 450 }, (_, index) => index)
    );
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(events[events.length - 1]?.type).toBe('termination');
  });

  it('bounds the secondary renderer continuity guard at sixty seconds and reports pressure once', async () => {
    const events: StreamingTranscriptionEvent[] = [];
    let releaseAppend: (() => void) | undefined;
    const blockedAppend = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendLocalSttAudio = vi.fn(async () => {
      await blockedAppend;
      return { accepted: true, droppedFrames: 0, turns: [] };
    });
    const api = client({ appendLocalSttAudio });
    const adapter = new LocalWhisperStreamingAdapter(
      { meetingId, sourceKind: 'microphone', sampleRate: 16_000 },
      api,
      (event) => events.push(event)
    );
    await adapter.connect();

    for (let second = 0; second < 62; second += 1) {
      adapter.sendAudio(new ArrayBuffer(32_000));
    }
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      error: { code: 'local_stt_backpressure', retryable: true },
    });

    releaseAppend?.();
    await vi.waitFor(() => expect(appendLocalSttAudio).toHaveBeenCalled());
    adapter.close();
  });

  it('retries an unaccepted frame with the same sequence instead of discarding it', async () => {
    const events: StreamingTranscriptionEvent[] = [];
    const appendLocalSttAudio = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false, droppedFrames: 0, turns: [] })
      .mockResolvedValueOnce({ accepted: true, droppedFrames: 0, turns: [] });
    const api = client({ appendLocalSttAudio });
    const adapter = new LocalWhisperStreamingAdapter(
      { meetingId, sourceKind: 'microphone', sampleRate: 16_000 },
      api,
      (event) => events.push(event)
    );
    await adapter.connect();

    adapter.sendAudio(new ArrayBuffer(3_200));
    await adapter.terminate();

    expect(appendLocalSttAudio).toHaveBeenCalledTimes(2);
    expect(appendLocalSttAudio.mock.calls.map(([request]) => request.sequence)).toEqual([0, 0]);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(events[events.length - 1]?.type).toBe('termination');
  });

  it('fails closed when the local worker cannot start', async () => {
    const events: StreamingTranscriptionEvent[] = [];
    const api = client({
      startLocalStt: vi.fn().mockRejectedValue(new Error('Offline model unavailable.')),
    });
    const adapter = new LocalWhisperStreamingAdapter(
      { meetingId, sourceKind: 'system', sampleRate: 16_000 },
      api,
      (event) => events.push(event)
    );

    await expect(adapter.connect()).rejects.toThrow('Offline model unavailable.');
    expect(events).toEqual([
      {
        type: 'error',
        providerSessionId: undefined,
        error: {
          code: 'local_stt_unavailable',
          message: 'Offline model unavailable.',
          retryable: false,
        },
      },
    ]);
  });

  it('releases and tail-flushes a pressured session before a reconnect can claim its source', async () => {
    const events: StreamingTranscriptionEvent[] = [];
    let active = false;
    let sessionNumber = 0;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const startLocalStt = vi.fn(async () => {
      if (active) throw new Error('Local transcription is already active for this audio source.');
      active = true;
      sessionNumber += 1;
      return {
        sessionId: `local-session-${sessionNumber}`,
        providerSessionId: `local-provider-session-${sessionNumber}`,
        model: 'base.en' as const,
      };
    });
    const stopLocalStt = vi.fn(async () => {
      await stopGate;
      active = false;
      return { turns: [turn(1, 'Tail words.')], audioDurationSeconds: 4.2 };
    });
    const api = client({
      startLocalStt,
      appendLocalSttAudio: vi.fn().mockRejectedValue(new Error('worker transport closed')),
      stopLocalStt,
    });
    let first!: LocalWhisperStreamingAdapter;
    first = new LocalWhisperStreamingAdapter(
      { meetingId, sourceKind: 'microphone', sampleRate: 16_000 },
      api,
      (event) => {
        events.push(event);
        if (event.type === 'error') first.close();
      }
    );
    await first.connect();
    first.sendAudio(new ArrayBuffer(3_200));

    await vi.waitFor(() => expect(stopLocalStt).toHaveBeenCalledOnce());
    expect(startLocalStt).toHaveBeenCalledOnce();

    let reconnected = false;
    const reconnect = first.waitUntilReleased().then(async () => {
      const second = new LocalWhisperStreamingAdapter(
        { meetingId, sourceKind: 'microphone', sampleRate: 16_000 },
        api,
        () => undefined
      );
      await second.connect();
      reconnected = true;
      second.close();
      await second.waitUntilReleased();
    });
    await Promise.resolve();
    expect(reconnected).toBe(false);
    expect(startLocalStt).toHaveBeenCalledOnce();

    releaseStop();
    await reconnect;

    expect(startLocalStt).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === 'turn')).toMatchObject([
      { turnId: 'turn-1', transcript: 'Tail words.', durableFinal: true },
    ]);
  });

  it('waits for a start already in flight, then releases the late worker exactly once', async () => {
    let resolveStart!: (value: typeof session) => void;
    const pendingStart = new Promise<typeof session>((resolve) => {
      resolveStart = resolve;
    });
    const stopLocalStt = vi.fn().mockResolvedValue({ turns: [], audioDurationSeconds: 0 });
    const api = client({ startLocalStt: vi.fn(() => pendingStart), stopLocalStt });
    const adapter = new LocalWhisperStreamingAdapter(
      { meetingId, sourceKind: 'mixed', sampleRate: 16_000 },
      api,
      () => undefined
    );

    const connecting = adapter.connect();
    adapter.close();
    const released = adapter.waitUntilReleased();
    resolveStart(session);
    await connecting;
    await released;

    expect(stopLocalStt).toHaveBeenCalledOnce();
    expect(stopLocalStt).toHaveBeenCalledWith({ meetingId, sessionId: session.sessionId });
  });
});
