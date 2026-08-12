import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlaybackProtocol } from './AudioPlaybackProtocol';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('AudioPlaybackProtocol', () => {
  it('returns a signed path-free URL and serves controlled seekable ranges', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'obelus-playback-'));
    temporaryDirectories.push(root);
    const audioPath = path.join(root, 'mixed.wav');
    await writeFile(audioPath, Buffer.from('0123456789'));
    const resolveAudio = vi.fn(async () => ({
      absolutePath: audioPath,
      filename: 'mixed.wav',
      size: 10,
      assetId: 'asset_1',
      meetingId: 'meeting_1',
      sourceKind: 'mixed' as const,
      checksumSha256: '0'.repeat(64),
      timelineStartMs: 0,
      timelineEndMs: 10,
    }));
    const playback = new AudioPlaybackProtocol(resolveAudio, Buffer.alloc(32, 7));
    const url = await playback.getPlaybackUrl('meeting_1', 'asset_1');

    expect(url).toMatch(/^obelus-audio:\/\/asset\/meeting_1\/asset_1\.wav\?signature=/);
    expect(url).not.toContain(root);
    const response = await playback.handleRequest(
      new globalThis.Request(url, { headers: { Range: 'bytes=2-5' } })
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(await response.text()).toBe('2345');
  });

  it('does not resolve a URL with a modified signature', async () => {
    const resolveAudio = vi.fn(async () => ({
      absolutePath: '/controlled/mixed.wav',
      filename: 'mixed.wav',
      size: 10,
      assetId: 'asset_1',
      meetingId: 'meeting_1',
      sourceKind: 'mixed' as const,
      checksumSha256: '0'.repeat(64),
      timelineStartMs: 0,
      timelineEndMs: 10,
    }));
    const playback = new AudioPlaybackProtocol(resolveAudio, Buffer.alloc(32, 9));
    const url = await playback.getPlaybackUrl('meeting_1', 'asset_1');
    resolveAudio.mockClear();
    const response = await playback.handleRequest(
      new globalThis.Request(url.replace(/.$/, (last) => (last === '0' ? '1' : '0')))
    );
    expect(response.status).toBe(404);
    expect(resolveAudio).not.toHaveBeenCalled();
  });
});
