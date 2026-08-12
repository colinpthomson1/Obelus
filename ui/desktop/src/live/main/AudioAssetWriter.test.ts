import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AudioAssetWriter, AudioFinalizeError } from './AudioAssetWriter';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('AudioAssetWriter', () => {
  it('writes controlled WAV assets, represents capture gaps as silence, and deletes by meeting id', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'obelus-live-audio-'));
    temporaryDirectories.push(root);
    const writer = new AudioAssetWriter(root);
    await writer.initialize();
    await writer.startMeeting('meeting_1', ['mixed']);

    const pcm = new Int16Array(1_280).fill(1).buffer;
    await writer.appendFrame({
      meetingId: 'meeting_1',
      captureSessionId: 'capture_1',
      sequence: 0,
      meetingTimeMs: 0,
      durationMs: 80,
      sampleRate: 16000,
      channels: 1,
      pcm: { mixed: pcm },
      meters: { mixed: { rms: 0.1, peak: 0.2 } },
      workletDroppedFrames: 0,
    });
    await writer.appendFrame({
      meetingId: 'meeting_1',
      captureSessionId: 'capture_1',
      sequence: 2,
      meetingTimeMs: 160,
      durationMs: 80,
      sampleRate: 16000,
      channels: 1,
      pcm: { mixed: pcm.slice(0) },
      meters: { mixed: { rms: 0.1, peak: 0.2 } },
      workletDroppedFrames: 1,
    });

    const [asset] = await writer.finalizeMeeting('meeting_1');
    expect(asset.durationMs).toBe(240);
    expect(asset.assetId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
    );
    const wav = await readFile(path.join(root, 'meeting_1', 'mixed.wav'));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(7_680);

    await writer.deleteMeetingAssets('meeting_1');
    await expect(stat(path.join(root, 'meeting_1'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not accept traversal as a meeting identifier', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'obelus-live-audio-'));
    temporaryDirectories.push(root);
    const writer = new AudioAssetWriter(root);
    await writer.initialize();
    await expect(writer.deleteMeetingAssets('../outside')).rejects.toThrow('invalid');
  });

  it('replays finalized assets until the exact ACP manifest is acknowledged', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'obelus-live-audio-'));
    temporaryDirectories.push(root);
    const writer = new AudioAssetWriter(root);
    await writer.initialize();
    await writer.startMeeting('meeting_handoff', ['mixed']);
    const pcm = new Int16Array(1_280).fill(3).buffer;
    await writer.appendFrame({
      meetingId: 'meeting_handoff',
      captureSessionId: 'capture_handoff',
      sequence: 0,
      meetingTimeMs: 0,
      durationMs: 80,
      sampleRate: 16000,
      channels: 1,
      pcm: { mixed: pcm },
      meters: { mixed: { rms: 0.1, peak: 0.2 } },
      workletDroppedFrames: 0,
    });
    const assets = await writer.finalizeMeeting('meeting_handoff');
    await expect(stat(path.join(root, 'meeting_handoff', '.pending-acp'))).resolves.toMatchObject({
      size: 0,
    });

    const restarted = new AudioAssetWriter(root);
    await expect(restarted.initialize()).resolves.toEqual([
      expect.objectContaining({
        meetingId: 'meeting_handoff',
        sourceKind: 'mixed',
        status: 'finalized',
      }),
    ]);
    await expect(
      restarted.acknowledgeAudioAssetsPersisted({
        meetingId: 'meeting_handoff',
        assets: [{ assetId: assets[0].assetId, checksumSha256: '0'.repeat(64) }],
      })
    ).rejects.toThrow('does not match');

    const afterFailedAcknowledgement = new AudioAssetWriter(root);
    await expect(afterFailedAcknowledgement.initialize()).resolves.toHaveLength(1);
    await afterFailedAcknowledgement.acknowledgeAudioAssetsPersisted({
      meetingId: 'meeting_handoff',
      assets: assets.map((asset) => ({
        assetId: asset.assetId,
        checksumSha256: asset.checksumSha256,
      })),
    });
    await expect(stat(path.join(root, 'meeting_handoff', '.pending-acp'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const acknowledgedRestart = new AudioAssetWriter(root);
    await expect(acknowledgedRestart.initialize()).resolves.toEqual([]);
  });

  it('surfaces legacy finalized manifests once for ACP handoff migration', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'obelus-live-audio-'));
    temporaryDirectories.push(root);
    const writer = new AudioAssetWriter(root);
    await writer.initialize();
    await writer.startMeeting('meeting_legacy_handoff', ['mixed']);
    await writer.appendFrame({
      meetingId: 'meeting_legacy_handoff',
      captureSessionId: 'capture_legacy_handoff',
      sequence: 0,
      meetingTimeMs: 0,
      durationMs: 80,
      sampleRate: 16000,
      channels: 1,
      pcm: { mixed: new Int16Array(1_280).fill(4).buffer },
      meters: { mixed: { rms: 0.1, peak: 0.2 } },
      workletDroppedFrames: 0,
    });
    const assets = await writer.finalizeMeeting('meeting_legacy_handoff');
    await rm(path.join(root, 'meeting_legacy_handoff', '.pending-acp'));
    await rm(path.join(root, '.acp-handoff-v1'));

    const migrated = new AudioAssetWriter(root);
    await expect(migrated.initialize()).resolves.toEqual([
      expect.objectContaining({ meetingId: 'meeting_legacy_handoff', status: 'finalized' }),
    ]);
    await expect(
      stat(path.join(root, 'meeting_legacy_handoff', '.pending-acp'))
    ).resolves.toBeDefined();
    await migrated.acknowledgeAudioAssetsPersisted({
      meetingId: 'meeting_legacy_handoff',
      assets: assets.map((asset) => ({
        assetId: asset.assetId,
        checksumSha256: asset.checksumSha256,
      })),
    });

    const afterMigration = new AudioAssetWriter(root);
    await expect(afterMigration.initialize()).resolves.toEqual([]);
  });

  it('preserves finalized siblings and recovers every interrupted meeting asset', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'obelus-live-audio-'));
    temporaryDirectories.push(root);
    const writer = new AudioAssetWriter(root);
    await writer.initialize();
    await writer.startMeeting('meeting_recovery', ['mixed', 'system']);
    const pcm = new Int16Array(1_280).fill(2).buffer;
    await writer.appendFrame({
      meetingId: 'meeting_recovery',
      captureSessionId: 'capture_1',
      sequence: 0,
      meetingTimeMs: 0,
      durationMs: 80,
      sampleRate: 16000,
      channels: 1,
      pcm: { mixed: pcm, system: pcm.slice(0) },
      meters: {
        mixed: { rms: 0.1, peak: 0.2 },
        system: { rms: 0.1, peak: 0.2 },
      },
      workletDroppedFrames: 0,
    });

    const blockingTarget = path.join(root, 'meeting_recovery', 'system.wav');
    await mkdir(blockingTarget);
    let finalizeError: unknown;
    try {
      await writer.finalizeMeeting('meeting_recovery');
    } catch (error) {
      finalizeError = error;
    }
    expect(finalizeError).toBeInstanceOf(AudioFinalizeError);
    expect((finalizeError as AudioFinalizeError).recoveredAssets).toEqual([
      expect.objectContaining({ sourceKind: 'mixed', status: 'interrupted' }),
    ]);

    await writer.startMeeting('meeting_recovery_2', ['mixed']);
    await writer.appendFrame({
      meetingId: 'meeting_recovery_2',
      captureSessionId: 'capture_2',
      sequence: 0,
      meetingTimeMs: 0,
      durationMs: 80,
      sampleRate: 16000,
      channels: 1,
      pcm: { mixed: pcm.slice(0) },
      meters: { mixed: { rms: 0.1, peak: 0.2 } },
      workletDroppedFrames: 0,
    });
    const secondBlockingTarget = path.join(root, 'meeting_recovery_2', 'mixed.wav');
    await mkdir(secondBlockingTarget);
    await expect(writer.finalizeMeeting('meeting_recovery_2')).rejects.toBeInstanceOf(
      AudioFinalizeError
    );

    await rm(blockingTarget, { recursive: true });
    await rm(secondBlockingTarget, { recursive: true });
    const restarted = new AudioAssetWriter(root);
    const recovered = await restarted.initialize();
    expect(recovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ meetingId: 'meeting_recovery', sourceKind: 'mixed' }),
        expect.objectContaining({ meetingId: 'meeting_recovery', sourceKind: 'system' }),
        expect.objectContaining({ meetingId: 'meeting_recovery_2', sourceKind: 'mixed' }),
      ])
    );
    expect(recovered).toHaveLength(3);

    const afterRecoveryRestart = new AudioAssetWriter(root);
    await expect(afterRecoveryRestart.initialize()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ meetingId: 'meeting_recovery', sourceKind: 'mixed' }),
        expect.objectContaining({ meetingId: 'meeting_recovery', sourceKind: 'system' }),
        expect.objectContaining({ meetingId: 'meeting_recovery_2', sourceKind: 'mixed' }),
      ])
    );
    await expect(
      afterRecoveryRestart.resolveFinalizedAsset(
        'meeting_recovery',
        recovered.find((asset) => asset.sourceKind === 'mixed')!.assetId,
        'mixed'
      )
    ).resolves.toMatchObject({
      meetingId: 'meeting_recovery',
      sourceKind: 'mixed',
      timelineStartMs: 0,
      timelineEndMs: 80,
    });
  });
});
