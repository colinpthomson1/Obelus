import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { LiveAudioFrame, LiveAudioPortRequest, LiveAudioPortResponse } from './ipcTypes';
import { createLiveAudioTransport } from './preloadAudioTransport';

interface FakePort {
  onmessage: ((event: MessageEvent<LiveAudioPortResponse>) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  start: Mock<() => void>;
  close: Mock<() => void>;
  postMessage: Mock<(message: LiveAudioPortRequest) => void>;
}

function fakeChannel() {
  const port1: FakePort = {
    onmessage: null,
    onmessageerror: null,
    start: vi.fn(),
    close: vi.fn(),
    postMessage: vi.fn(),
  };
  return { port1, port2: {} };
}

function audioFrame(): LiveAudioFrame {
  return {
    meetingId: 'meeting_1',
    captureSessionId: 'capture_1',
    sequence: 0,
    meetingTimeMs: 0,
    durationMs: 80,
    sampleRate: 16_000,
    channels: 1,
    pcm: {
      microphone: new ArrayBuffer(2_560),
      mixed: new ArrayBuffer(2_560),
    },
    meters: {
      microphone: { rms: 0, peak: 0 },
      mixed: { rms: 0, peak: 0 },
    },
    workletDroppedFrames: 0,
  };
}

describe('preload live audio transport', () => {
  it('connects after live start and structured-clones bridged PCM without a transfer list', async () => {
    const channel = fakeChannel();
    const transferPort = vi.fn();
    const transport = createLiveAudioTransport({
      createChannel: () => channel,
      transferPort,
    });

    expect(transferPort).not.toHaveBeenCalled();
    transport.connect();
    expect(transferPort).toHaveBeenCalledWith(channel.port2);

    const frame = audioFrame();
    const result = transport.append(frame);
    expect(channel.port1.postMessage).toHaveBeenCalledTimes(1);
    expect(channel.port1.postMessage).toHaveBeenCalledWith({ requestId: 0, frame });
    expect(channel.port1.postMessage.mock.calls[0]).toHaveLength(1);

    channel.port1.onmessage?.({
      data: {
        requestId: 0,
        ok: true,
        result: { accepted: true, duplicate: false, droppedFrames: 0 },
      },
    } as MessageEvent<LiveAudioPortResponse>);
    await expect(result).resolves.toEqual({ accepted: true, duplicate: false, droppedFrames: 0 });
  });

  it('reconnects after an acknowledgement timeout', async () => {
    vi.useFakeTimers();
    const first = fakeChannel();
    const second = fakeChannel();
    const channels = [first, second];
    const transport = createLiveAudioTransport({
      createChannel: () => {
        const channel = channels.shift();
        if (!channel) throw new Error('No fake channel available');
        return channel;
      },
      transferPort: vi.fn(),
      ackTimeoutMs: 100,
    });

    const firstResult = transport.append(audioFrame());
    const firstRejection = expect(firstResult).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await firstRejection;
    expect(first.port1.close).toHaveBeenCalledOnce();

    const secondResult = transport.append({ ...audioFrame(), sequence: 1 });
    expect(second.port1.postMessage).toHaveBeenCalledWith(
      expect.objectContaining<LiveAudioPortRequest>({ requestId: 1, frame: expect.any(Object) })
    );
    second.port1.onmessage?.({
      data: {
        requestId: 1,
        ok: true,
        result: { accepted: true, duplicate: false, droppedFrames: 0 },
      },
    } as MessageEvent<LiveAudioPortResponse>);
    await expect(secondResult).resolves.toMatchObject({ accepted: true });
    vi.useRealTimers();
  });
});
