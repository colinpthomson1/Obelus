import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveAudioFrame } from '../live/ipcTypes';
import {
  beginCaptureClockGap,
  captureStartupError,
  completeCaptureClockGap,
  createCaptureTimelineClock,
  createLiveAudioWriteQueue,
  isValidSttPcmFrame,
  meetingTimeForWorkletFrame,
  openCaptureSources,
  requestMediaStreamWithTimeout,
  useLiveAudioCapture,
} from './useLiveAudioCapture';

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const originalLiveApi = window.electron.live;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalMediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, 'mediaDevices');
  }
  Object.assign(window.electron, { live: originalLiveApi });
});

function mediaStreamFixture() {
  const stop = vi.fn();
  return {
    stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
    stop,
  };
}

describe('live capture meeting clock', () => {
  it('preserves the uncaptured wall-clock gap across manual pause and resume', () => {
    const clock = createCaptureTimelineClock(10_000);

    expect(meetingTimeForWorkletFrame(clock, 0, 80)).toBe(0);
    expect(meetingTimeForWorkletFrame(clock, 80, 80)).toBe(80);
    beginCaptureClockGap(clock, 10_160);
    completeCaptureClockGap(clock, 15_160);

    expect(meetingTimeForWorkletFrame(clock, 160, 80)).toBe(5_160);
  });

  it('aligns the post-wake frame to elapsed wall time without moving backwards', () => {
    const clock = createCaptureTimelineClock(20_000);

    expect(meetingTimeForWorkletFrame(clock, 0, 80)).toBe(0);
    completeCaptureClockGap(clock, 26_000);
    expect(meetingTimeForWorkletFrame(clock, 80, 80)).toBe(6_000);

    completeCaptureClockGap(clock, 19_000);
    expect(meetingTimeForWorkletFrame(clock, 160, 80)).toBe(6_080);
  });
});

describe('live audio write queue', () => {
  it('preserves ordering beyond the old eight-frame cap and drains every frame on close', async () => {
    const releases: Array<() => void> = [];
    const appended: number[] = [];
    const accepted: number[] = [];
    const appendAudio = vi.fn(
      (frame: LiveAudioFrame) =>
        new Promise<{ accepted: boolean; duplicate: boolean; droppedFrames: number }>((resolve) => {
          appended.push(frame.sequence);
          releases.push(() => resolve({ accepted: true, duplicate: false, droppedFrames: 0 }));
        })
    );
    const queue = createLiveAudioWriteQueue({
      appendAudio,
      onAccepted: (_result, frame) => accepted.push(frame.sequence),
      maxPendingFrames: 32,
    });
    const frames = Array.from(
      { length: 24 },
      (_, sequence) =>
        ({
          meetingId: 'meeting_1',
          captureSessionId: 'capture_1',
          sequence,
          meetingTimeMs: sequence * 80,
          durationMs: 80,
          sampleRate: 16_000,
          channels: 1,
          pcm: {
            microphone: new ArrayBuffer(2_560),
            mixed: new ArrayBuffer(2_560),
          },
          meters: {
            microphone: { rms: 0.1, peak: 0.2 },
            mixed: { rms: 0.1, peak: 0.2 },
          },
          workletDroppedFrames: 0,
        }) satisfies LiveAudioFrame
    );

    for (const frame of frames) expect(queue.enqueue(frame)).toBe(true);
    expect(queue.pendingFrames()).toBe(24);

    let closed = false;
    const closing = queue.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);

    for (let index = 0; index < frames.length; index += 1) {
      await waitFor(() => expect(releases).toHaveLength(index + 1));
      expect(appended).toEqual(frames.slice(0, index + 1).map((frame) => frame.sequence));
      releases[index]();
    }
    await closing;

    expect(closed).toBe(true);
    expect(queue.pendingFrames()).toBe(0);
    expect(accepted).toEqual(frames.map((frame) => frame.sequence));
    expect(appendAudio).toHaveBeenCalledTimes(frames.length);
    expect(frames.every((frame) => frame.workletDroppedFrames === 0)).toBe(true);
  });

  it('fails the active drain when main stops accepting a queued frame', async () => {
    const onError = vi.fn();
    const queue = createLiveAudioWriteQueue({
      appendAudio: vi.fn(async () => ({ accepted: false, duplicate: false, droppedFrames: 0 })),
      onError,
    });
    const frame = {
      meetingId: 'meeting_1',
      captureSessionId: 'capture_1',
      sequence: 0,
      meetingTimeMs: 0,
      durationMs: 80,
      sampleRate: 16_000,
      channels: 1,
      pcm: { microphone: new ArrayBuffer(2_560), mixed: new ArrayBuffer(2_560) },
      meters: {
        microphone: { rms: 0.1, peak: 0.2 },
        mixed: { rms: 0.1, peak: 0.2 },
      },
      workletDroppedFrames: 0,
    } satisfies LiveAudioFrame;

    expect(queue.enqueue(frame)).toBe(true);
    await expect(queue.drain()).rejects.toThrow('stopped accepting frames');
    expect(onError).toHaveBeenCalledOnce();
    expect(queue.enqueue({ ...frame, sequence: 1 })).toBe(false);
  });
});

describe('live capture stop boundary', () => {
  it('drains the exact pre-pause boundary, ignores transcript-only tails, and stops while paused', async () => {
    const microphoneTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const microphone = {
      getTracks: () => [microphoneTrack],
      getAudioTracks: () => [microphoneTrack],
      getVideoTracks: () => [],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => microphone),
        enumerateDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    type FakeWorkletPort = {
      onmessage: ((event: MessageEvent) => void) | null;
      postMessage: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
    };
    let workletNode: { port: FakeWorkletPort } | undefined;
    class FakeAudioWorkletNode {
      port: FakeWorkletPort = {
        onmessage: null,
        postMessage: vi.fn(),
        start: vi.fn(),
      };
      constructor() {
        workletNode = { port: this.port };
      }
      connect<T>(target: T): T {
        return target;
      }
      disconnect = vi.fn();
    }
    class FakeAudioContext {
      state = 'running';
      destination = {};
      audioWorklet = { addModule: vi.fn(async () => undefined) };
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
      createGain = vi.fn(() => {
        const gain = {
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        gain.connect.mockReturnValue(gain);
        return gain;
      });
      resume = vi.fn(async () => undefined);
      suspend = vi.fn(async () => undefined);
      close = vi.fn(async () => {
        this.state = 'closed';
      });
    }
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    vi.stubGlobal('AudioContext', FakeAudioContext);

    let releaseBlockedWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      releaseBlockedWrite = resolve;
    });
    const appendAudio = vi.fn(async (frame: LiveAudioFrame) => {
      if (frame.sequence === 1) await blockedWrite;
      return { accepted: true, duplicate: false, droppedFrames: 0 };
    });
    Object.assign(window.electron, {
      live: { appendAudio } as unknown as typeof window.electron.live,
    });

    const onAudioFrame = vi.fn();
    const view = renderHook(() => useLiveAudioCapture());
    let starting!: Promise<{ includeSystemAudio: boolean }>;
    act(() => {
      starting = view.result.current.startCapture({
        mode: 'in_person',
        strategy: 'mixed_diarized',
        includeSystemAudio: false,
        onAudioFrame,
      });
    });
    await waitFor(() => expect(workletNode).toBeDefined());

    const emitFrame = (
      sequence: number,
      active: boolean,
      microphonePcm = new ArrayBuffer(2_560),
      mixedPcm = new ArrayBuffer(2_560)
    ) => {
      workletNode?.port.onmessage?.({
        data: {
          type: 'frame',
          active,
          sequence,
          timestampMs: sequence * 80,
          durationMs: 80,
          droppedFrames: 0,
          pcm: { microphone: microphonePcm, mixed: mixedPcm },
          meters: {
            microphone: { rms: 0.01, peak: 0.02 },
            mixed: { rms: 0.01, peak: 0.02 },
          },
        },
      } as MessageEvent);
    };
    const frame0MicrophonePcm = new ArrayBuffer(2_560);
    const frame1MicrophonePcm = new ArrayBuffer(2_560);
    const frame2MicrophonePcm = new ArrayBuffer(2_560);
    act(() => emitFrame(0, false, frame0MicrophonePcm));
    await act(async () => starting);

    let activating!: Promise<void>;
    act(() => {
      activating = view.result.current.activateCapture('meeting_1');
    });
    await waitFor(() =>
      expect(workletNode?.port.postMessage).toHaveBeenCalledWith({ type: 'activate' })
    );
    act(() => {
      workletNode?.port.onmessage?.({ data: { type: 'activated' } } as MessageEvent);
      emitFrame(0, true, frame0MicrophonePcm);
    });
    await act(async () => activating);
    await waitFor(() => expect(appendAudio).toHaveBeenCalledTimes(1));

    act(() => emitFrame(1, true, frame1MicrophonePcm));
    await waitFor(() => expect(appendAudio).toHaveBeenCalledTimes(2));

    act(() => emitFrame(2, true, frame2MicrophonePcm));
    expect(appendAudio).toHaveBeenCalledTimes(2);

    let pausing!: Promise<void>;
    act(() => {
      pausing = view.result.current.pauseCapture();
    });
    const postBoundaryMicrophonePcm = new ArrayBuffer(2_560);
    act(() => emitFrame(3, true, postBoundaryMicrophonePcm));
    expect(appendAudio).toHaveBeenCalledTimes(2);
    expect(
      onAudioFrame.mock.calls.some(
        ([sourceKind, pcm]) => sourceKind === 'microphone' && pcm === postBoundaryMicrophonePcm
      )
    ).toBe(false);

    releaseBlockedWrite();
    await waitFor(() => expect(appendAudio).toHaveBeenCalledTimes(3));
    await act(async () => pausing);

    let stopping!: Promise<void>;
    act(() => {
      stopping = view.result.current.stopCapture();
    });
    await waitFor(() =>
      expect(workletNode?.port.postMessage).toHaveBeenCalledWith({ type: 'flush' })
    );
    const stoppedTailMicrophonePcm = new ArrayBuffer(2_560);
    act(() => {
      emitFrame(4, true, stoppedTailMicrophonePcm);
      workletNode?.port.onmessage?.({ data: { type: 'flushed', sequence: 5 } } as MessageEvent);
    });
    await act(async () => stopping);

    expect(microphoneTrack.stop).toHaveBeenCalledOnce();
    expect(appendAudio.mock.calls.map(([frame]) => frame.sequence)).toEqual([0, 1, 2]);
    expect(appendAudio.mock.calls.filter(([frame]) => frame.sequence === 2)).toHaveLength(1);
    expect(
      onAudioFrame.mock.calls
        .filter(([sourceKind]) => sourceKind === 'microphone')
        .map(([, pcm]) => pcm)
    ).toEqual([frame0MicrophonePcm, frame1MicrophonePcm, frame2MicrophonePcm]);
    expect(appendAudio.mock.calls.some(([frame]) => frame.sequence >= 3)).toBe(false);
    expect(
      onAudioFrame.mock.calls.some(
        ([sourceKind, pcm]) => sourceKind === 'microphone' && pcm === stoppedTailMicrophonePcm
      )
    ).toBe(false);
    view.unmount();
  });
});

describe('live capture startup', () => {
  it('reports system-audio recovery exactly once after a silence warning', async () => {
    vi.useFakeTimers();
    const microphoneTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const systemTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const videoTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const microphone = {
      getTracks: () => [microphoneTrack],
      getAudioTracks: () => [microphoneTrack],
      getVideoTracks: () => [],
    } as unknown as MediaStream;
    const system = {
      getTracks: () => [systemTrack, videoTrack],
      getAudioTracks: () => [systemTrack],
      getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => microphone),
        getDisplayMedia: vi.fn(async () => system),
        enumerateDevices: vi.fn(async () => []),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    type FakeWorkletPort = {
      onmessage: ((event: MessageEvent) => void) | null;
      postMessage: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
    };
    let workletNode: { port: FakeWorkletPort } | undefined;
    class FakeAudioWorkletNode {
      port: FakeWorkletPort = {
        onmessage: null,
        postMessage: vi.fn(),
        start: vi.fn(),
      };
      constructor() {
        workletNode = { port: this.port };
      }
      connect<T>(target: T): T {
        return target;
      }
      disconnect = vi.fn();
    }
    class FakeAudioContext {
      state = 'running';
      destination = {};
      audioWorklet = { addModule: vi.fn(async () => undefined) };
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
      createGain = vi.fn(() => {
        const gain = {
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        gain.connect.mockReturnValue(gain);
        return gain;
      });
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => {
        this.state = 'closed';
      });
    }
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    vi.stubGlobal('AudioContext', FakeAudioContext);

    const onCaptureError = vi.fn();
    const onCaptureWarningRecovered = vi.fn();
    const view = renderHook(() => useLiveAudioCapture());
    let starting: Promise<{ includeSystemAudio: boolean }> | undefined;
    act(() => {
      starting = view.result.current.startCapture({
        mode: 'call',
        strategy: 'mixed_diarized',
        includeSystemAudio: true,
        onCaptureError,
        onCaptureWarningRecovered,
      });
    });
    for (let index = 0; index < 20 && !workletNode; index += 1) {
      await act(async () => Promise.resolve());
    }
    expect(workletNode).toBeDefined();

    const emitFrame = (systemRms: number) => {
      workletNode?.port.onmessage?.({
        data: {
          type: 'frame',
          active: false,
          sequence: 0,
          timestampMs: 0,
          durationMs: 80,
          droppedFrames: 0,
          pcm: {},
          meters: {
            microphone: { rms: 0.01, peak: 0.02 },
            system: { rms: systemRms, peak: systemRms },
          },
        },
      } as MessageEvent);
    };
    act(() => emitFrame(0));
    await act(async () => {
      await starting;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onCaptureError).toHaveBeenCalledOnce();
    expect(onCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'system_audio_silent' })
    );
    expect(view.result.current.error?.code).toBe('system_audio_silent');

    act(() => emitFrame(0.001));
    expect(onCaptureWarningRecovered).not.toHaveBeenCalled();
    expect(view.result.current.error?.code).toBe('system_audio_silent');

    act(() => emitFrame(0.01));
    expect(onCaptureWarningRecovered).toHaveBeenCalledOnce();
    expect(onCaptureWarningRecovered).toHaveBeenCalledWith({ code: 'system_audio_silent' });
    expect(view.result.current.error).toBeUndefined();

    act(() => emitFrame(0.02));
    expect(onCaptureWarningRecovered).toHaveBeenCalledOnce();

    let stopping: Promise<void> | undefined;
    act(() => {
      stopping = view.result.current.stopCapture();
    });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      await stopping;
    });

    workletNode = undefined;
    act(() => {
      starting = view.result.current.startCapture({
        mode: 'call',
        strategy: 'mixed_diarized',
        includeSystemAudio: true,
        onCaptureError,
        onCaptureWarningRecovered,
      });
    });
    for (let index = 0; index < 20 && !workletNode; index += 1) {
      await act(async () => Promise.resolve());
    }
    expect(workletNode).toBeDefined();
    act(() => emitFrame(0.01));
    await act(async () => {
      await starting;
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(onCaptureError).toHaveBeenCalledOnce();
    expect(onCaptureWarningRecovered).toHaveBeenCalledOnce();

    act(() => {
      stopping = view.result.current.stopCapture();
    });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      await stopping;
    });
    view.unmount();
  });

  it('preserves the actionable startup failure across the provider boundary', () => {
    expect(
      captureStartupError(
        new DOMException('The audio device did not become ready.', 'TimeoutError')
      )
    ).toMatchObject({
      code: 'capture_start_timeout',
      message: 'The audio device did not become ready.',
    });
    expect(
      captureStartupError(new Error('The microphone did not produce audio frames.'))
    ).toMatchObject({
      code: 'microphone_no_frames',
      message: expect.stringContaining('no audio frames'),
    });
  });

  it('forwards only AssemblyAI-compatible 50–1000 ms PCM16 frames', () => {
    expect(isValidSttPcmFrame(1_599)).toBe(false);
    expect(isValidSttPcmFrame(1_600)).toBe(true);
    expect(isValidSttPcmFrame(2_560)).toBe(true);
    expect(isValidSttPcmFrame(32_000)).toBe(true);
    expect(isValidSttPcmFrame(32_001)).toBe(false);
  });
  it('stops a late media stream after the permission request times out', async () => {
    vi.useFakeTimers();
    const fixture = mediaStreamFixture();
    let resolveRequest: ((stream: MediaStream) => void) | undefined;
    const result = requestMediaStreamWithTimeout(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveRequest = resolve;
        }),
      100,
      'Microphone access did not respond.'
    );
    const rejection = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    resolveRequest?.(fixture.stream);
    await Promise.resolve();

    expect(fixture.stop).toHaveBeenCalledOnce();
  });

  it('falls back to microphone-only when system audio cannot open', async () => {
    const microphone = mediaStreamFixture().stream;
    const result = await openCaptureSources(
      { mode: 'call', includeSystemAudio: true },
      {
        microphone: vi.fn(async () => microphone),
        system: vi.fn(async () => {
          throw new DOMException('System Audio denied', 'NotAllowedError');
        }),
      }
    );

    expect(result).toMatchObject({ microphone, includeSystemAudio: false });
    expect(result.systemFallbackCause).toMatchObject({ name: 'NotAllowedError' });
  });

  it('does not let a hanging system picker block microphone-only startup', async () => {
    vi.useFakeTimers();
    const microphone = mediaStreamFixture().stream;
    const lateSystem = mediaStreamFixture();
    let resolveSystem: ((stream: MediaStream) => void) | undefined;
    const system = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveSystem = resolve;
        })
    );
    const microphoneOpener = vi.fn(async () => microphone);
    const result = openCaptureSources(
      { mode: 'call', includeSystemAudio: true },
      { microphone: microphoneOpener, system },
      { systemFallbackTimeoutMs: 100 }
    );

    expect(system).toHaveBeenCalledOnce();
    expect(microphoneOpener).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toMatchObject({
      microphone,
      includeSystemAudio: false,
      systemFallbackCause: { name: 'TimeoutError' },
    });

    resolveSystem?.(lateSystem.stream);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateSystem.stop).toHaveBeenCalledOnce();
  });

  it('tears down microphone and a late system stream when startup is aborted', async () => {
    const microphone = mediaStreamFixture();
    const lateSystem = mediaStreamFixture();
    const controller = new AbortController();
    let resolveSystem: ((stream: MediaStream) => void) | undefined;
    const result = openCaptureSources(
      { mode: 'call', includeSystemAudio: true },
      {
        microphone: vi.fn(async () => microphone.stream),
        system: vi.fn(
          () =>
            new Promise<MediaStream>((resolve) => {
              resolveSystem = resolve;
            })
        ),
      },
      { signal: controller.signal, systemFallbackTimeoutMs: 10_000 }
    );

    await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(microphone.stop).toHaveBeenCalledOnce();

    resolveSystem?.(lateSystem.stream);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateSystem.stop).toHaveBeenCalledOnce();
  });

  it('starts system audio before waiting for the microphone request', async () => {
    const microphone = mediaStreamFixture().stream;
    const system = mediaStreamFixture().stream;
    let resolveMicrophone: ((stream: MediaStream) => void) | undefined;
    const microphoneOpener = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveMicrophone = resolve;
        })
    );
    const systemOpener = vi.fn(async () => system);

    const result = openCaptureSources(
      { mode: 'call', includeSystemAudio: true },
      { microphone: microphoneOpener, system: systemOpener }
    );

    expect(systemOpener).toHaveBeenCalledOnce();
    expect(microphoneOpener).toHaveBeenCalledOnce();
    expect(systemOpener.mock.invocationCallOrder[0]).toBeLessThan(
      microphoneOpener.mock.invocationCallOrder[0]
    );
    resolveMicrophone?.(microphone);
    await expect(result).resolves.toEqual({ microphone, system, includeSystemAudio: true });
  });

  it('stops system audio when concurrent microphone acquisition fails', async () => {
    const systemFixture = mediaStreamFixture();
    let resolveSystem: ((stream: MediaStream) => void) | undefined;
    const microphoneFailure = new DOMException('Microphone denied', 'NotAllowedError');
    const result = openCaptureSources(
      { mode: 'call', includeSystemAudio: true },
      {
        microphone: vi.fn(async () => {
          throw microphoneFailure;
        }),
        system: vi.fn(
          () =>
            new Promise<MediaStream>((resolve) => {
              resolveSystem = resolve;
            })
        ),
      }
    );

    resolveSystem?.(systemFixture.stream);
    await expect(result).rejects.toBe(microphoneFailure);
    expect(systemFixture.stop).toHaveBeenCalledOnce();
  });

  it('does not request system audio for in-person recording', async () => {
    const microphone = mediaStreamFixture().stream;
    const system = vi.fn(async () => mediaStreamFixture().stream);
    const result = await openCaptureSources(
      { mode: 'in_person', includeSystemAudio: true },
      { microphone: vi.fn(async () => microphone), system }
    );

    expect(result).toEqual({ microphone, includeSystemAudio: false });
    expect(system).not.toHaveBeenCalled();
  });
});
