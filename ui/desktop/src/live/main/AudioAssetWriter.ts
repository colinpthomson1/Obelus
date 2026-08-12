import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  LiveAudioAsset,
  LiveAudioAssetAcknowledgement,
  LiveAudioFrame,
  LiveAudioSourceKind,
} from '../ipcTypes';
import { assertSafeId } from './ipcValidation';

const WAV_HEADER_BYTES = 44;
const WAV_SAMPLE_RATE = 16_000;
const WAV_CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const MAX_WAV_DATA_BYTES = 0xffffffff - 36;
const ZERO_CHUNK = Buffer.alloc(64 * 1024);
const RECORDING_MARKER = '.recording';
const PENDING_ACP_MARKER = '.pending-acp';
const ACP_HANDOFF_MIGRATION = '.acp-handoff-v1';
const ACP_HANDOFF_MIGRATION_PART = '.acp-handoff-v1.part';
const ASSET_MANIFEST = '.assets.json';
const ASSET_MANIFEST_PART = '.assets.json.part';
const SOURCE_KINDS: readonly LiveAudioSourceKind[] = ['microphone', 'system', 'mixed'];

interface OpenAsset {
  sourceKind: LiveAudioSourceKind;
  partPath: string;
  finalPath: string;
  relativePath: string;
  handle: FileHandle;
  bytesWritten: number;
  position: number;
  timelineStartMs: number | null;
  timelineEndMs: number;
  writeQueue: Promise<void>;
  closed: boolean;
}

export interface ResolvedAudioAsset {
  absolutePath: string;
  filename: string;
  size: number;
  assetId: string;
  meetingId: string;
  sourceKind: LiveAudioSourceKind;
  checksumSha256: string;
  timelineStartMs: number;
  timelineEndMs: number;
}

export class AudioFinalizeError extends Error {
  constructor(
    message: string,
    readonly recoveredAssets: LiveAudioAsset[]
  ) {
    super(message);
    this.name = 'AudioFinalizeError';
  }
}

export interface LiveAudioAssetStore {
  startMeeting(meetingId: string, sources: readonly LiveAudioSourceKind[]): Promise<void>;
  appendFrame(frame: LiveAudioFrame): Promise<Record<LiveAudioSourceKind, number>>;
  finalizeMeeting(
    meetingId: string,
    status?: 'finalized' | 'interrupted'
  ): Promise<LiveAudioAsset[]>;
  acknowledgeAudioAssetsPersisted(acknowledgement: LiveAudioAssetAcknowledgement): Promise<void>;
  deleteMeetingAssets(meetingId: string): Promise<void>;
}

function createWavHeader(dataBytes: number): Buffer {
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataBytes > MAX_WAV_DATA_BYTES) {
    throw new Error('WAV asset is too large to finalize');
  }
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(WAV_CHANNELS, 22);
  header.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  header.writeUInt32LE(WAV_SAMPLE_RATE * WAV_CHANNELS * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(WAV_CHANNELS * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sourceAssetId(meetingId: string, sourceKind: LiveAudioSourceKind): string {
  const bytes = createHash('sha256').update(`${meetingId}:${sourceKind}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertSourceKind(value: string): asserts value is LiveAudioSourceKind {
  if (!SOURCE_KINDS.includes(value as LiveAudioSourceKind)) {
    throw new Error('Invalid audio source');
  }
}

export class AudioAssetWriter implements LiveAudioAssetStore {
  private readonly openMeetings = new Map<string, Map<LiveAudioSourceKind, OpenAsset>>();
  private readonly finalizedAssets = new Map<string, Map<LiveAudioSourceKind, LiveAudioAsset>>();

  constructor(private readonly audioRoot: string) {}

  private meetingDirectory(meetingId: string): string {
    assertSafeId(meetingId, 'meetingId');
    const directory = path.resolve(this.audioRoot, meetingId);
    const expectedParent = `${path.resolve(this.audioRoot)}${path.sep}`;
    if (!directory.startsWith(expectedParent)) {
      throw new Error('Invalid meeting audio directory');
    }
    return directory;
  }

  async initialize(): Promise<LiveAudioAsset[]> {
    await mkdir(this.audioRoot, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.audioRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Live audio root is invalid');
    }
    const migrateLegacyHandoffs = await this.needsLegacyHandoffMigration();
    const recovered = await this.recoverInterruptedAssets(migrateLegacyHandoffs);
    if (migrateLegacyHandoffs) await this.completeLegacyHandoffMigration();
    return recovered;
  }

  async startMeeting(meetingId: string, sources: readonly LiveAudioSourceKind[]): Promise<void> {
    if (this.openMeetings.has(meetingId)) {
      throw new Error('Meeting audio is already open');
    }
    if (sources.length === 0) {
      throw new Error('At least one audio source is required');
    }

    const uniqueSources = [...new Set(sources)];
    uniqueSources.forEach(assertSourceKind);
    const directory = this.meetingDirectory(meetingId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Meeting audio directory is invalid');
    }
    const assets = new Map<LiveAudioSourceKind, OpenAsset>();
    for (const sourceKind of uniqueSources) {
      try {
        await lstat(path.join(directory, `${sourceKind}.wav`));
        throw new Error('Meeting audio asset already exists');
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    const markerPath = path.join(directory, RECORDING_MARKER);
    const marker = await open(markerPath, 'wx', 0o600);
    await marker.close();

    try {
      for (const sourceKind of uniqueSources) {
        const partPath = path.join(directory, `${sourceKind}.wav.part`);
        const finalPath = path.join(directory, `${sourceKind}.wav`);
        const handle = await open(partPath, 'wx+', 0o600);
        try {
          await handle.write(createWavHeader(0), 0, WAV_HEADER_BYTES, 0);
        } catch (error) {
          await handle.close().catch(() => undefined);
          await rm(partPath, { force: true });
          throw error;
        }
        assets.set(sourceKind, {
          sourceKind,
          partPath,
          finalPath,
          relativePath: `${meetingId}/${sourceKind}.wav`,
          handle,
          bytesWritten: 0,
          position: WAV_HEADER_BYTES,
          timelineStartMs: null,
          timelineEndMs: 0,
          writeQueue: Promise.resolve(),
          closed: false,
        });
      }
      this.openMeetings.set(meetingId, assets);
    } catch (error) {
      await Promise.allSettled(
        [...assets.values()].map(async (asset) => {
          asset.closed = true;
          await asset.handle.close();
          await rm(asset.partPath, { force: true });
        })
      );
      await rm(markerPath, { force: true });
      throw error;
    }
  }

  async appendFrame(frame: LiveAudioFrame): Promise<Record<LiveAudioSourceKind, number>> {
    const assets = this.openMeetings.get(frame.meetingId);
    if (!assets) {
      throw new Error('Meeting audio is not open');
    }

    const bytesBySource: Record<LiveAudioSourceKind, number> = {
      microphone: 0,
      system: 0,
      mixed: 0,
    };
    const queuedWrites: Promise<void>[] = [];

    for (const [sourceName, arrayBuffer] of Object.entries(frame.pcm)) {
      if (!arrayBuffer) continue;
      assertSourceKind(sourceName);
      const asset = assets.get(sourceName);
      if (!asset || asset.closed) {
        throw new Error('Audio source is not open');
      }
      const pcm = Buffer.from(arrayBuffer);
      const gapMs =
        asset.timelineStartMs === null ? 0 : Math.max(0, frame.meetingTimeMs - asset.timelineEndMs);
      const gapBytes = Math.round((gapMs / 1_000) * WAV_SAMPLE_RATE) * BYTES_PER_SAMPLE;
      const writeLength = gapBytes + pcm.byteLength;
      if (asset.bytesWritten + writeLength > MAX_WAV_DATA_BYTES) {
        throw new Error('WAV asset reached its size limit');
      }

      const position = asset.position;
      asset.position += writeLength;
      asset.bytesWritten += writeLength;
      asset.timelineStartMs ??= Math.round(frame.meetingTimeMs);
      asset.timelineEndMs = Math.max(
        asset.timelineEndMs,
        Math.round(frame.meetingTimeMs + frame.durationMs)
      );
      bytesBySource[sourceName] = asset.bytesWritten;
      asset.writeQueue = asset.writeQueue.then(async () => {
        await writeSilence(asset.handle, gapBytes, position);
        await writeAll(asset.handle, pcm, position + gapBytes);
      });
      queuedWrites.push(asset.writeQueue);
    }

    await Promise.all(queuedWrites);
    return bytesBySource;
  }

  async finalizeMeeting(
    meetingId: string,
    status: 'finalized' | 'interrupted' = 'finalized'
  ): Promise<LiveAudioAsset[]> {
    const assets = this.openMeetings.get(meetingId);
    if (!assets) {
      throw new Error('Meeting audio is not open');
    }
    this.openMeetings.delete(meetingId);
    const results = await Promise.allSettled(
      [...assets.values()].map((asset) => this.finalizeOpenAsset(meetingId, asset, status))
    );
    const finalized = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    );
    const failed = results.some((result) => result.status === 'rejected');
    const exposedAssets = failed
      ? finalized.map((asset) => ({ ...asset, status: 'interrupted' as const }))
      : finalized;

    try {
      await this.persistManifest(meetingId, exposedAssets);
      if (!failed) {
        await this.markPendingAcpHandoff(meetingId);
      }
    } catch {
      this.cacheAssets(exposedAssets);
      throw new AudioFinalizeError('Unable to persist live audio metadata', exposedAssets);
    }
    this.cacheAssets(exposedAssets);
    if (failed) {
      throw new AudioFinalizeError('One or more live audio assets need recovery', exposedAssets);
    }
    return exposedAssets;
  }

  async acknowledgeAudioAssetsPersisted(
    acknowledgement: LiveAudioAssetAcknowledgement
  ): Promise<void> {
    const meetingId = acknowledgement.meetingId;
    const directory = this.meetingDirectory(meetingId);
    if (this.openMeetings.has(meetingId)) {
      throw new Error('Live audio cannot be acknowledged while recording');
    }
    if (!Array.isArray(acknowledgement.assets) || acknowledgement.assets.length === 0) {
      throw new Error('Audio acknowledgement is empty');
    }

    const acknowledged = new Map<string, string>();
    for (const asset of acknowledgement.assets) {
      assertSafeId(asset.assetId, 'assetId');
      if (!SHA256.test(asset.checksumSha256)) {
        throw new Error('Audio acknowledgement checksum is invalid');
      }
      if (acknowledged.has(asset.assetId)) {
        throw new Error('Audio acknowledgement contains duplicate assets');
      }
      acknowledged.set(asset.assetId, asset.checksumSha256);
    }

    const manifest = await this.loadManifest(meetingId);
    if (manifest.length !== acknowledged.size) {
      throw new Error('Audio acknowledgement does not match the finalized manifest');
    }
    for (const asset of manifest) {
      if (acknowledged.get(asset.assetId) !== asset.checksumSha256) {
        throw new Error('Audio acknowledgement does not match the finalized manifest');
      }
    }

    const markerPath = path.join(directory, PENDING_ACP_MARKER);
    try {
      const markerStat = await lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
        throw new Error('Audio acknowledgement marker is invalid');
      }
      await rm(markerPath, { force: false });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private async finalizeOpenAsset(
    meetingId: string,
    asset: OpenAsset,
    status: 'finalized' | 'interrupted'
  ): Promise<LiveAudioAsset> {
    try {
      await asset.writeQueue;
      await asset.handle.write(createWavHeader(asset.bytesWritten), 0, WAV_HEADER_BYTES, 0);
      await asset.handle.sync();
    } finally {
      asset.closed = true;
      await asset.handle.close();
    }
    await rename(asset.partPath, asset.finalPath);
    const checksumSha256 = await sha256File(asset.finalPath);
    const timelineStartMs = asset.timelineStartMs ?? 0;
    const durationMs = Math.round(
      (asset.bytesWritten / (WAV_SAMPLE_RATE * WAV_CHANNELS * BYTES_PER_SAMPLE)) * 1000
    );
    return {
      assetId: sourceAssetId(meetingId, asset.sourceKind),
      meetingId,
      sourceKind: asset.sourceKind,
      relativePath: asset.relativePath,
      format: 'wav',
      sampleRate: WAV_SAMPLE_RATE,
      channels: WAV_CHANNELS,
      durationMs,
      bytes: WAV_HEADER_BYTES + asset.bytesWritten,
      checksumSha256,
      timelineStartMs,
      timelineEndMs: Math.max(timelineStartMs, asset.timelineEndMs),
      status,
    };
  }

  async resolveFinalizedAsset(
    meetingId: string,
    assetId: string,
    sourceKind: LiveAudioSourceKind
  ): Promise<ResolvedAudioAsset> {
    assertSourceKind(sourceKind);
    if (assetId !== sourceAssetId(meetingId, sourceKind)) {
      throw new Error('Audio asset does not belong to this meeting');
    }
    const directory = this.meetingDirectory(meetingId);
    const absolutePath = path.join(directory, `${sourceKind}.wav`);
    const fileStat = await lstat(absolutePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error('Audio asset is unavailable');
    }
    let metadata = (await this.loadManifest(meetingId)).find(
      (asset) => asset.sourceKind === sourceKind
    );
    if (!metadata) {
      metadata = await this.reconstructFinalAsset(meetingId, sourceKind, 'finalized');
      await this.persistManifest(meetingId, [
        ...(this.finalizedAssets.get(meetingId)?.values() ?? []),
        metadata,
      ]);
      this.cacheAssets([metadata]);
    }
    if (metadata.assetId !== assetId || metadata.bytes !== fileStat.size) {
      throw new Error('Audio asset metadata does not match the controlled file');
    }
    return {
      absolutePath,
      filename: `${sourceKind}.wav`,
      size: fileStat.size,
      assetId: metadata.assetId,
      meetingId: metadata.meetingId,
      sourceKind: metadata.sourceKind,
      checksumSha256: metadata.checksumSha256,
      timelineStartMs: metadata.timelineStartMs,
      timelineEndMs: metadata.timelineEndMs,
    };
  }

  async deleteMeetingAssets(meetingId: string): Promise<void> {
    if (this.openMeetings.has(meetingId)) {
      throw new Error('Stop the live meeting before deleting its audio');
    }
    const directory = this.meetingDirectory(meetingId);
    let directoryStat;
    try {
      directoryStat = await lstat(directory);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        this.finalizedAssets.delete(meetingId);
        return;
      }
      throw error;
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Meeting audio directory is invalid');
    }
    await rm(directory, { recursive: true, force: false, maxRetries: 2 });
    this.finalizedAssets.delete(meetingId);
  }

  private async recoverInterruptedAssets(
    migrateLegacyHandoffs: boolean
  ): Promise<LiveAudioAsset[]> {
    const recovered: LiveAudioAsset[] = [];
    const meetingEntries = await readdir(this.audioRoot, { withFileTypes: true });

    for (const meetingEntry of meetingEntries) {
      if (!meetingEntry.isDirectory() || !SAFE_MEETING_DIRECTORY.test(meetingEntry.name)) continue;
      const directory = this.meetingDirectory(meetingEntry.name);
      const fileEntries = await readdir(directory, { withFileTypes: true });
      const partSources = fileEntries.flatMap((fileEntry) => {
        const match = /^(microphone|system|mixed)\.wav\.part$/.exec(fileEntry.name);
        return fileEntry.isFile() && match ? [match[1] as LiveAudioSourceKind] : [];
      });
      const hasRecordingMarker = fileEntries.some(
        (fileEntry) => fileEntry.isFile() && fileEntry.name === RECORDING_MARKER
      );
      const hasPendingAcpMarker = fileEntries.some(
        (fileEntry) => fileEntry.isFile() && fileEntry.name === PENDING_ACP_MARKER
      );
      let manifest: LiveAudioAsset[];
      let manifestInvalid = false;
      try {
        manifest = await this.loadManifest(meetingEntry.name);
      } catch {
        manifest = [];
        manifestInvalid = true;
      }
      if (!hasRecordingMarker && partSources.length === 0 && !manifestInvalid) {
        this.cacheAssets(manifest);
        if (manifest.length > 0 && (hasPendingAcpMarker || migrateLegacyHandoffs)) {
          await this.ensurePendingAcpMarker(meetingEntry.name);
          recovered.push(...manifest);
        }
        continue;
      }

      const bySource = new Map<LiveAudioSourceKind, LiveAudioAsset>(
        manifest.map((asset) => [asset.sourceKind, { ...asset, status: 'interrupted' as const }])
      );
      for (const sourceKind of partSources) {
        const partPath = path.join(directory, `${sourceKind}.wav.part`);
        const finalPath = path.join(directory, `${sourceKind}.wav`);
        try {
          const finalStat = await lstat(finalPath);
          if (finalStat.isFile() && !finalStat.isSymbolicLink()) {
            await rm(partPath, { force: true });
            continue;
          }
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
        bySource.set(
          sourceKind,
          await this.recoverPartAsset(meetingEntry.name, sourceKind, partPath, finalPath)
        );
      }
      for (const sourceKind of SOURCE_KINDS) {
        if (bySource.has(sourceKind)) continue;
        if (
          fileEntries.some(
            (fileEntry) => fileEntry.isFile() && fileEntry.name === `${sourceKind}.wav`
          )
        ) {
          bySource.set(
            sourceKind,
            await this.reconstructFinalAsset(meetingEntry.name, sourceKind, 'interrupted')
          );
        }
      }
      const meetingAssets = [...bySource.values()];
      await this.persistManifest(meetingEntry.name, meetingAssets);
      await this.markPendingAcpHandoff(meetingEntry.name);
      await rm(path.join(directory, ASSET_MANIFEST_PART), { force: true });
      this.cacheAssets(meetingAssets);
      recovered.push(...meetingAssets);
    }
    return recovered;
  }

  private async markPendingAcpHandoff(meetingId: string): Promise<void> {
    const directory = this.meetingDirectory(meetingId);
    const recordingPath = path.join(directory, RECORDING_MARKER);
    const pendingPath = path.join(directory, PENDING_ACP_MARKER);
    try {
      await rename(recordingPath, pendingPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await this.ensurePendingAcpMarker(meetingId);
    }
  }

  private async ensurePendingAcpMarker(meetingId: string): Promise<void> {
    const markerPath = path.join(this.meetingDirectory(meetingId), PENDING_ACP_MARKER);
    try {
      const markerStat = await lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
        throw new Error('Audio acknowledgement marker is invalid');
      }
      return;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const marker = await open(markerPath, 'wx', 0o600);
    await marker.close();
  }

  private async needsLegacyHandoffMigration(): Promise<boolean> {
    const markerPath = path.join(this.audioRoot, ACP_HANDOFF_MIGRATION);
    try {
      const markerStat = await lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
        throw new Error('Audio handoff migration marker is invalid');
      }
      return false;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true;
      throw error;
    }
  }

  private async completeLegacyHandoffMigration(): Promise<void> {
    const partPath = path.join(this.audioRoot, ACP_HANDOFF_MIGRATION_PART);
    const markerPath = path.join(this.audioRoot, ACP_HANDOFF_MIGRATION);
    await writeFile(partPath, 'complete\n', { encoding: 'utf8', mode: 0o600 });
    await rename(partPath, markerPath);
  }

  private async recoverPartAsset(
    meetingId: string,
    sourceKind: LiveAudioSourceKind,
    partPath: string,
    finalPath: string
  ): Promise<LiveAudioAsset> {
    const partStat = await stat(partPath);
    const rawDataBytes = Math.max(0, partStat.size - WAV_HEADER_BYTES);
    const dataBytes = rawDataBytes - (rawDataBytes % BYTES_PER_SAMPLE);
    const handle = await open(partPath, 'r+');
    try {
      await handle.truncate(WAV_HEADER_BYTES + dataBytes);
      await handle.write(createWavHeader(dataBytes), 0, WAV_HEADER_BYTES, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(partPath, finalPath);
    return await this.reconstructFinalAsset(meetingId, sourceKind, 'interrupted');
  }

  private async reconstructFinalAsset(
    meetingId: string,
    sourceKind: LiveAudioSourceKind,
    status: 'finalized' | 'interrupted'
  ): Promise<LiveAudioAsset> {
    const finalPath = path.join(this.meetingDirectory(meetingId), `${sourceKind}.wav`);
    const dataBytes = await readWavDataBytes(finalPath);
    const durationMs = Math.round(
      (dataBytes / (WAV_SAMPLE_RATE * WAV_CHANNELS * BYTES_PER_SAMPLE)) * 1000
    );
    return {
      assetId: sourceAssetId(meetingId, sourceKind),
      meetingId,
      sourceKind,
      relativePath: `${meetingId}/${sourceKind}.wav`,
      format: 'wav',
      sampleRate: WAV_SAMPLE_RATE,
      channels: WAV_CHANNELS,
      durationMs,
      bytes: WAV_HEADER_BYTES + dataBytes,
      checksumSha256: await sha256File(finalPath),
      timelineStartMs: 0,
      timelineEndMs: durationMs,
      status,
    };
  }

  private cacheAssets(assets: readonly LiveAudioAsset[]): void {
    for (const asset of assets) {
      let meeting = this.finalizedAssets.get(asset.meetingId);
      if (!meeting) {
        meeting = new Map();
        this.finalizedAssets.set(asset.meetingId, meeting);
      }
      meeting.set(asset.sourceKind, { ...asset });
    }
  }

  private async loadManifest(meetingId: string): Promise<LiveAudioAsset[]> {
    const cached = this.finalizedAssets.get(meetingId);
    if (cached) return [...cached.values()].map((asset) => ({ ...asset }));
    const manifestPath = path.join(this.meetingDirectory(meetingId), ASSET_MANIFEST);
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length > SOURCE_KINDS.length) {
      throw new Error('Invalid audio manifest');
    }
    const assets = parsed.map((value) => parseStoredAsset(value, meetingId));
    if (new Set(assets.map((asset) => asset.sourceKind)).size !== assets.length) {
      throw new Error('Invalid audio manifest');
    }
    this.cacheAssets(assets);
    return assets;
  }

  private async persistManifest(
    meetingId: string,
    assets: readonly LiveAudioAsset[]
  ): Promise<void> {
    const directory = this.meetingDirectory(meetingId);
    const partPath = path.join(directory, ASSET_MANIFEST_PART);
    const manifestPath = path.join(directory, ASSET_MANIFEST);
    await writeFile(partPath, JSON.stringify(assets), { encoding: 'utf8', mode: 0o600 });
    await rename(partPath, manifestPath);
  }
}

const SAFE_MEETING_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function parseStoredAsset(value: unknown, meetingId: string): LiveAudioAsset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid audio manifest');
  }
  const asset = value as Record<string, unknown>;
  if (typeof asset.sourceKind !== 'string') throw new Error('Invalid audio manifest');
  assertSourceKind(asset.sourceKind);
  const expectedAssetId = sourceAssetId(meetingId, asset.sourceKind);
  const expectedRelativePath = `${meetingId}/${asset.sourceKind}.wav`;
  if (
    asset.assetId !== expectedAssetId ||
    asset.meetingId !== meetingId ||
    asset.relativePath !== expectedRelativePath ||
    asset.format !== 'wav' ||
    asset.sampleRate !== WAV_SAMPLE_RATE ||
    asset.channels !== WAV_CHANNELS ||
    typeof asset.checksumSha256 !== 'string' ||
    !SHA256.test(asset.checksumSha256) ||
    (asset.status !== 'finalized' && asset.status !== 'interrupted')
  ) {
    throw new Error('Invalid audio manifest');
  }
  for (const field of ['durationMs', 'bytes', 'timelineStartMs', 'timelineEndMs'] as const) {
    const number = asset[field];
    if (!Number.isSafeInteger(number) || (number as number) < 0) {
      throw new Error('Invalid audio manifest');
    }
  }
  if (
    (asset.bytes as number) < WAV_HEADER_BYTES ||
    (asset.timelineEndMs as number) < (asset.timelineStartMs as number)
  ) {
    throw new Error('Invalid audio manifest');
  }
  return {
    assetId: expectedAssetId,
    meetingId,
    sourceKind: asset.sourceKind,
    relativePath: expectedRelativePath,
    format: 'wav',
    sampleRate: WAV_SAMPLE_RATE,
    channels: WAV_CHANNELS,
    durationMs: asset.durationMs as number,
    bytes: asset.bytes as number,
    checksumSha256: asset.checksumSha256,
    timelineStartMs: asset.timelineStartMs as number,
    timelineEndMs: asset.timelineEndMs as number,
    status: asset.status,
  };
}

async function readWavDataBytes(filePath: string): Promise<number> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size < WAV_HEADER_BYTES) {
    throw new Error('Invalid WAV asset');
  }
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(WAV_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const dataBytes = fileStat.size - WAV_HEADER_BYTES;
    if (
      bytesRead !== WAV_HEADER_BYTES ||
      header.toString('ascii', 0, 4) !== 'RIFF' ||
      header.toString('ascii', 8, 12) !== 'WAVE' ||
      header.readUInt16LE(20) !== 1 ||
      header.readUInt16LE(22) !== WAV_CHANNELS ||
      header.readUInt32LE(24) !== WAV_SAMPLE_RATE ||
      header.readUInt16LE(34) !== BYTES_PER_SAMPLE * 8 ||
      header.readUInt32LE(40) !== dataBytes
    ) {
      throw new Error('Invalid WAV asset');
    }
    return dataBytes;
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function writeSilence(
  handle: FileHandle,
  byteLength: number,
  position: number
): Promise<void> {
  let remaining = byteLength;
  let offset = position;
  while (remaining > 0) {
    const chunkLength = Math.min(remaining, ZERO_CHUNK.byteLength);
    await writeAll(handle, ZERO_CHUNK.subarray(0, chunkLength), offset);
    remaining -= chunkLength;
    offset += chunkLength;
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset
    );
    if (result.bytesWritten <= 0) {
      throw new Error('Incomplete audio write');
    }
    offset += result.bytesWritten;
  }
}
