import { describe, expect, it, vi } from 'vitest';
import type { LiveAudioAssetStore } from './AudioAssetWriter';
import { LiveCaptureCoordinator } from './LiveCaptureCoordinator';

function createAudioStore(): LiveAudioAssetStore {
  return {
    startMeeting: vi.fn(async () => undefined),
    appendFrame: vi.fn(async () => ({ microphone: 320, system: 0, mixed: 320 })),
    finalizeMeeting: vi.fn(async () => []),
    acknowledgeAudioAssetsPersisted: vi.fn(async () => undefined),
    deleteMeetingAssets: vi.fn(async () => undefined),
  };
}

describe('LiveCaptureCoordinator', () => {
  it('owns the meeting, finalizes once, and freezes elapsed time at the last captured frame', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const audioStore = createAudioStore();
    const coordinator = new LiveCaptureCoordinator({ audioStore, now: () => now });
    const starting = await coordinator.start(
      {
        meetingId: 'meeting_1',
        mode: 'in_person',
        strategy: 'mixed_diarized',
        includeSystemAudio: false,
      },
      7
    );
    expect(starting.lifecycle).toBe('starting');
    await coordinator.appendAudio(
      {
        meetingId: 'meeting_1',
        captureSessionId: 'capture_1',
        sequence: 0,
        meetingTimeMs: 0,
        durationMs: 80,
        sampleRate: 16000,
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
      },
      7
    );
    now = 2_000;
    await coordinator.pause(7);
    now = 3_000;
    await coordinator.resume(7);
    now = 50_000;
    const [first, second] = await Promise.all([coordinator.stop(7), coordinator.stop(7)]);

    expect(first.lifecycle).toBe('complete');
    expect(second).toEqual(first);
    expect(audioStore.finalizeMeeting).toHaveBeenCalledTimes(1);
    expect(first.timelineEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'pause', startMs: 1_000, endMs: 2_000 }),
        expect.objectContaining({ kind: 'resume', startMs: 2_000 }),
      ])
    );

    now = 100_000;
    expect(coordinator.getSnapshot().elapsedMs).toBe(80);
    vi.useRealTimers();
  });

  it('rejects a second owner while a recording is active', async () => {
    vi.useFakeTimers();
    const coordinator = new LiveCaptureCoordinator({ audioStore: createAudioStore() });
    await coordinator.start(
      {
        meetingId: 'meeting_1',
        mode: 'call',
        strategy: 'mixed_diarized',
        includeSystemAudio: true,
      },
      7
    );
    await expect(
      coordinator.start(
        {
          meetingId: 'meeting_2',
          mode: 'call',
          strategy: 'mixed_diarized',
          includeSystemAudio: true,
        },
        8
      )
    ).rejects.toThrow('already active');
    await coordinator.stop(7);
    vi.useRealTimers();
  });

  it('preserves every recovered meeting group in the main snapshot', () => {
    const recoveredAssets = ['meeting_1', 'meeting_2'].map((meetingId, index) => ({
      assetId: `00000000-0000-5000-8000-00000000000${index}`,
      meetingId,
      sourceKind: 'mixed' as const,
      relativePath: `${meetingId}/mixed.wav`,
      format: 'wav' as const,
      sampleRate: 16000 as const,
      channels: 1 as const,
      durationMs: 80,
      bytes: 2_604,
      checksumSha256: String(index).repeat(64),
      timelineStartMs: 0,
      timelineEndMs: 80,
      status: index === 0 ? ('finalized' as const) : ('interrupted' as const),
    }));
    const coordinator = new LiveCaptureCoordinator({
      audioStore: createAudioStore(),
      recoveredAssets,
    });

    const snapshot = coordinator.getSnapshot();
    expect(snapshot.lifecycle).toBe('interrupted');
    expect(snapshot.recoveredMeetings).toEqual([
      { meetingId: 'meeting_1', assets: [recoveredAssets[0]] },
      { meetingId: 'meeting_2', assets: [recoveredAssets[1]] },
    ]);
  });

  it('removes an acknowledged recovered target without disturbing active capture', async () => {
    const recoveredAsset = {
      assetId: '00000000-0000-5000-8000-000000000000',
      meetingId: 'meeting_recovered',
      sourceKind: 'mixed' as const,
      relativePath: 'meeting_recovered/mixed.wav',
      format: 'wav' as const,
      sampleRate: 16000 as const,
      channels: 1 as const,
      durationMs: 80,
      bytes: 2_604,
      checksumSha256: 'a'.repeat(64),
      timelineStartMs: 0,
      timelineEndMs: 80,
      status: 'finalized' as const,
    };
    const coordinator = new LiveCaptureCoordinator({
      audioStore: createAudioStore(),
      recoveredAssets: [recoveredAsset],
    });

    coordinator.acknowledgeAudioAssetsPersisted('meeting_recovered');
    expect(coordinator.getSnapshot()).toMatchObject({
      lifecycle: 'idle',
      meetingId: null,
      finalizedAssets: [],
      recoveredMeetings: [],
    });

    const withActiveCapture = new LiveCaptureCoordinator({
      audioStore: createAudioStore(),
      recoveredAssets: [recoveredAsset],
    });
    await withActiveCapture.start(
      {
        meetingId: 'meeting_active',
        mode: 'in_person',
        strategy: 'mixed_diarized',
        includeSystemAudio: false,
      },
      7
    );
    withActiveCapture.acknowledgeAudioAssetsPersisted('meeting_recovered');
    expect(withActiveCapture.getSnapshot()).toMatchObject({
      lifecycle: 'starting',
      meetingId: 'meeting_active',
      recoveredMeetings: [],
    });
  });

  it('returns already-finalized interrupted assets after a local write failure', async () => {
    const interruptedAsset = {
      assetId: '00000000-0000-5000-8000-000000000001',
      meetingId: 'meeting_1',
      sourceKind: 'mixed' as const,
      relativePath: 'meeting_1/mixed.wav',
      format: 'wav' as const,
      sampleRate: 16000 as const,
      channels: 1 as const,
      durationMs: 80,
      bytes: 2_604,
      checksumSha256: 'a'.repeat(64),
      timelineStartMs: 0,
      timelineEndMs: 80,
      status: 'interrupted' as const,
    };
    const audioStore = createAudioStore();
    vi.mocked(audioStore.appendFrame).mockRejectedValueOnce(new Error('disk full'));
    vi.mocked(audioStore.finalizeMeeting).mockResolvedValueOnce([interruptedAsset]);
    const coordinator = new LiveCaptureCoordinator({ audioStore });
    await coordinator.start(
      {
        meetingId: 'meeting_1',
        mode: 'in_person',
        strategy: 'mixed_diarized',
        includeSystemAudio: false,
      },
      7
    );

    await expect(
      coordinator.appendAudio(
        {
          meetingId: 'meeting_1',
          captureSessionId: 'capture_1',
          sequence: 0,
          meetingTimeMs: 0,
          durationMs: 80,
          sampleRate: 16000,
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
        },
        7
      )
    ).rejects.toThrow('Unable to write live audio');

    await expect(coordinator.stop(7)).resolves.toMatchObject({
      lifecycle: 'error',
      finalizedAssets: [interruptedAsset],
    });
    expect(audioStore.finalizeMeeting).toHaveBeenCalledTimes(1);
  });
});
