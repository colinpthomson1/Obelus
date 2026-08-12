import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { Session } from 'electron';
import type { ResolvedAudioAsset } from './AudioAssetWriter';
import { assertSafeId } from './ipcValidation';

export const LIVE_AUDIO_SCHEME = 'obelus-audio';

export interface PlaybackAudioResolver {
  (meetingId: string, assetId: string): Promise<ResolvedAudioAsset>;
}

export class AudioPlaybackProtocol {
  private readonly signingKey: Buffer;

  constructor(
    private readonly resolveAudio: PlaybackAudioResolver,
    signingKey: Buffer = randomBytes(32)
  ) {
    if (signingKey.byteLength < 32) throw new Error('Playback signing key is too short');
    this.signingKey = Buffer.from(signingKey);
  }

  register(targetSession: Session): void {
    targetSession.protocol.handle(LIVE_AUDIO_SCHEME, (request) => this.handleRequest(request));
  }

  async getPlaybackUrl(meetingId: string, assetId: string): Promise<string> {
    assertSafeId(meetingId, 'meetingId');
    assertSafeId(assetId, 'assetId');
    await this.resolveAudio(meetingId, assetId);
    const signature = this.sign(meetingId, assetId);
    return `${LIVE_AUDIO_SCHEME}://asset/${encodeURIComponent(meetingId)}/${encodeURIComponent(assetId)}.wav?signature=${signature}`;
  }

  async handleRequest(
    request: InstanceType<typeof globalThis.Request>
  ): Promise<InstanceType<typeof globalThis.Response>> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
    const parsed = parsePlaybackUrl(request.url);
    if (!parsed || !this.validSignature(parsed.meetingId, parsed.assetId, parsed.signature)) {
      return notFound();
    }

    let asset: ResolvedAudioAsset;
    try {
      asset = await this.resolveAudio(parsed.meetingId, parsed.assetId);
    } catch {
      return notFound();
    }
    const range = parseRange(request.headers.get('range'), asset.size);
    if (range === 'invalid') {
      return new globalThis.Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${asset.size}`, 'Cache-Control': 'no-store' },
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? asset.size - 1;
    const contentLength = Math.max(0, end - start + 1);
    const headers = new globalThis.Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': String(contentLength),
      'Content-Type': 'audio/wav',
      'X-Content-Type-Options': 'nosniff',
    });
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${asset.size}`);
    if (request.method === 'HEAD') {
      return new globalThis.Response(null, { status: range ? 206 : 200, headers });
    }

    const file = createReadStream(asset.absolutePath, { start, end });
    request.signal.addEventListener('abort', () => file.destroy(), { once: true });
    const body = Readable.toWeb(file) as ReadableStream<Uint8Array>;
    return new globalThis.Response(body, { status: range ? 206 : 200, headers });
  }

  private sign(meetingId: string, assetId: string): string {
    return createHmac('sha256', this.signingKey).update(`${meetingId}\0${assetId}`).digest('hex');
  }

  private validSignature(meetingId: string, assetId: string, signature: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(signature)) return false;
    const expected = Buffer.from(this.sign(meetingId, assetId), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }
}

function parsePlaybackUrl(
  rawUrl: string
): { meetingId: string; assetId: string; signature: string } | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== `${LIVE_AUDIO_SCHEME}:` || parsed.hostname !== 'asset') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length !== 2 || !segments[1].endsWith('.wav')) return null;
    const meetingId = decodeURIComponent(segments[0]);
    const assetId = decodeURIComponent(segments[1].slice(0, -4));
    assertSafeId(meetingId, 'meetingId');
    assertSafeId(assetId, 'assetId');
    if ([...parsed.searchParams.keys()].some((key) => key !== 'signature')) return null;
    return { meetingId, assetId, signature: parsed.searchParams.get('signature') ?? '' };
  } catch {
    return null;
  }
}

function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return 'invalid';
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return 'invalid';
  }
  return { start, end: Math.min(end, size - 1) };
}

function notFound(): InstanceType<typeof globalThis.Response> {
  return new globalThis.Response(null, {
    status: 404,
    headers: { 'Cache-Control': 'no-store' },
  });
}
