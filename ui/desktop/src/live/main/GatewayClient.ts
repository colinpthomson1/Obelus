import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type {
  ClaimDetectionRequest,
  ClaimDetectionResponse,
  FactCheckEscalationReason,
  FactCheckStage,
  FactCheckSubmitRequest,
  GatewayDeleteResponse,
  GatewayJobResponse,
  RefinementInputPart,
  RefinementSubmitRequest,
  SttSessionRequest,
  SttSessionResponse,
  SttSessionCompleteRequest,
} from '../ipcTypes';
import type { ResolvedAudioAsset } from './AudioAssetWriter';
import type { GatewaySessionAvailability, GatewaySessionProvider } from './GatewaySessionProvider';

const WAV_HEADER_BYTES = 44;
const WAV_SAMPLE_RATE = 16_000;
const MAX_REFINEMENT_BYTES = 1024 * 1024 * 1024;
const DEFAULT_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type FetchBody = FetchInit['body'];

interface ResolvedPart {
  input: RefinementInputPart;
  asset: ResolvedAudioAsset;
  dataBytes: number;
  silenceBeforeBytes: number;
}

export interface GatewayAudioAssetResolver {
  (
    meetingId: string,
    assetId: string,
    sourceKind: RefinementInputPart['sourceKind']
  ): Promise<ResolvedAudioAsset>;
}

export interface GatewayClientOptions {
  baseUrl?: string;
  sessionProvider: GatewaySessionProvider;
  resolveAudioAsset: GatewayAudioAssetResolver;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

export class GatewayClient {
  private readonly baseUrl: URL | null;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: GatewayClientOptions) {
    this.baseUrl = parseGatewayBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES;
  }

  getAvailability(): GatewaySessionAvailability {
    if (!this.baseUrl) {
      return { available: false, reason: 'The Obelus research gateway is not configured.' };
    }
    return this.options.sessionProvider.getAvailability();
  }

  async checkHealth(): Promise<GatewaySessionAvailability> {
    const availability = this.getAvailability();
    if (!availability.available) return availability;
    try {
      await this.options.sessionProvider.getAuthorizationHeader();
      await this.requestJson('/health', { method: 'GET', authenticated: false, timeoutMs: 3_000 });
      return { available: true };
    } catch {
      return { available: false, reason: 'The Obelus research gateway is unreachable.' };
    }
  }

  async getSttSession(request: SttSessionRequest): Promise<SttSessionResponse> {
    const raw = await this.requestJson('/v1/stt/session', {
      method: 'POST',
      body: {
        meetingId: request.meetingId,
        idempotencyKey: request.idempotencyKey,
        strategy: request.strategy,
        sourceKind: request.sourceKind,
        maxSessionSeconds: request.maxSessionSeconds,
      },
    });
    const value = asRecord(raw, 'streaming session');
    const configuration = asRecord(value.configuration, 'streaming configuration');
    if (
      configuration.sampleRate !== WAV_SAMPLE_RATE ||
      configuration.encoding !== 'pcm_s16le' ||
      configuration.speakerLabels !== true
    ) {
      throw new Error('Gateway returned an unsupported streaming configuration');
    }
    const expires = value.expiresAtEpochMs ?? value.tokenExpiresAt;
    const expiresAtEpochMs =
      typeof expires === 'string' ? Date.parse(expires) : requireFiniteNumber(expires, 'expiry');
    if (!Number.isFinite(expiresAtEpochMs)) throw new Error('Gateway returned an invalid expiry');
    return {
      sessionId: requireBoundedString(value.sessionId, 'session ID', 256),
      websocketUrl: requireSecureWebSocketUrl(value.websocketUrl),
      token: requireBoundedString(value.token, 'streaming token', 16_384),
      expiresAtEpochMs,
      model: requireBoundedString(configuration.model, 'streaming model', 128),
      configuration: boundedScalarRecord(configuration),
    };
  }

  async completeSttSession(sessionId: string, request: SttSessionCompleteRequest): Promise<void> {
    await this.requestJson(`/v1/stt/session/${encodeURIComponent(sessionId)}/complete`, {
      method: 'POST',
      body: request,
    });
  }

  async submitClaimDetection(request: ClaimDetectionRequest): Promise<ClaimDetectionResponse> {
    const serializeTurn = (turn: ClaimDetectionRequest['turns'][number]) => ({
      id: turn.id,
      speakerId: turn.speakerId,
      startMs: turn.startMs,
      endMs: turn.endMs,
      text: turn.text,
      ...(turn.sourceKind === undefined ? {} : { sourceKind: turn.sourceKind }),
    });
    const gatewayRequest = {
      meetingId: request.meetingId,
      idempotencyKey: request.idempotencyKey,
      turns: request.turns.map(serializeTurn),
      ...(request.contextTurns === undefined
        ? {}
        : { contextTurns: request.contextTurns.map(serializeTurn) }),
      ...(request.requiredTurnIds === undefined
        ? {}
        : { requiredTurnIds: request.requiredTurnIds }),
      ...(request.existingClaimKeys === undefined
        ? {}
        : { existingClaimKeys: request.existingClaimKeys }),
      ...(request.manual === undefined ? {} : { manual: request.manual }),
      ...(request.manualSelection === undefined
        ? {}
        : { manualSelection: request.manualSelection }),
    };
    const value = asRecord(
      await this.requestJson('/v1/claims/detect', { method: 'POST', body: gatewayRequest }),
      'claim detection response'
    );
    if (!Array.isArray(value.candidates) || value.candidates.length > 100) {
      throw new Error('Gateway returned invalid claim candidates');
    }
    return { candidates: value.candidates, catchingUp: value.catchingUp === true };
  }

  async submitFactCheck(
    stage: FactCheckStage,
    request: FactCheckSubmitRequest
  ): Promise<GatewayJobResponse<unknown>> {
    if (stage === 'deep') {
      throw new Error('Deep research must escalate an accepted fact-check.');
    }
    return parseFactCheckResponse(
      await this.requestJson('/v2/fact-checks', { method: 'POST', body: request }),
      stage
    );
  }

  async pollFactCheck(
    checkId: string,
    stage: FactCheckStage = 'quick'
  ): Promise<GatewayJobResponse<unknown>> {
    return parseFactCheckResponse(
      await this.requestJson(`/v2/fact-checks/${encodeURIComponent(checkId)}`, { method: 'GET' }),
      stage
    );
  }

  async escalateFactCheck(
    checkId: string,
    idempotencyKey: string,
    reason: FactCheckEscalationReason,
    unresolvedSubquestions?: string[]
  ): Promise<GatewayJobResponse<unknown>> {
    return parseFactCheckResponse(
      await this.requestJson(`/v2/fact-checks/${encodeURIComponent(checkId)}/escalate`, {
        method: 'POST',
        body: {
          reason,
          ...(unresolvedSubquestions === undefined ? {} : { unresolvedSubquestions }),
        },
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
      'deep'
    );
  }

  async submitRefinement(request: RefinementSubmitRequest): Promise<GatewayJobResponse<unknown>> {
    const body = await this.buildRefinementBody(request);
    return parseJobResponse(
      await this.requestJson('/v1/transcripts/refine', {
        method: 'POST',
        body: body.stream,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${body.boundary}`,
          'Content-Length': String(body.contentLength),
        },
        streamingBody: true,
        timeoutMs: Math.max(this.requestTimeoutMs, 10 * 60_000),
      })
    );
  }

  async pollRefinement(jobId: string): Promise<GatewayJobResponse<unknown>> {
    return parseJobResponse(
      await this.requestJson(`/v1/transcripts/refine/${encodeURIComponent(jobId)}`, {
        method: 'GET',
      })
    );
  }

  async deleteRemoteMeeting(meetingId: string): Promise<GatewayDeleteResponse> {
    const value = asRecord(
      await this.requestJson(`/v1/meetings/${encodeURIComponent(meetingId)}`, {
        method: 'DELETE',
      }),
      'meeting deletion'
    );
    const gatewayState = value.gateway_state ?? value.gatewayState;
    const providerState = value.provider_state ?? value.providerState;
    if (
      value.meetingId === meetingId &&
      typeof value.cleanupJobId === 'string' &&
      typeof gatewayState === 'string'
    ) {
      const gatewayCleanup = normalizeGatewayCleanup(gatewayState);
      const providerCleanup = normalizeProviderCleanup(providerState);
      return {
        meetingId,
        cleanupJobId: requireBoundedString(value.cleanupJobId, 'cleanup job ID', 128),
        alreadyDeleted: value.alreadyDeleted === true,
        gatewayCleanup,
        providerCleanup,
        limitation:
          typeof value.limitation === 'string'
            ? requireBoundedString(value.limitation, 'deletion limitation', 2_000)
            : undefined,
        status:
          gatewayCleanup === 'failed'
            ? 'failed'
            : gatewayCleanup !== 'complete'
              ? 'pending'
              : providerCleanup === 'partial' || providerCleanup === 'unsupported'
                ? 'partial'
                : providerCleanup === 'failed'
                  ? 'failed'
                  : 'complete',
      };
    }
    if (value.meetingId === meetingId && isDeleteStatus(value.status)) {
      return {
        meetingId,
        status: value.status,
        providerCleanup: isProviderCleanup(value.providerCleanup)
          ? value.providerCleanup
          : undefined,
        limitation:
          typeof value.limitation === 'string'
            ? requireBoundedString(value.limitation, 'deletion limitation', 2_000)
            : undefined,
      };
    }
    const job = parseJobResponse(value);
    return {
      meetingId,
      status:
        job.status === 'complete'
          ? 'complete'
          : job.status === 'failed' || job.status === 'cancelled'
            ? 'failed'
            : 'pending',
      providerCleanup: job.status === 'complete' ? 'complete' : 'pending',
    };
  }

  private async buildRefinementBody(request: RefinementSubmitRequest): Promise<{
    boundary: string;
    contentLength: number;
    stream: Readable;
  }> {
    const expectedManifestChecksum = createHash('sha256')
      .update(
        request.parts
          .map(
            (part) =>
              `${part.assetId}:${part.checksumSha256}:${part.timelineStartMs}:${part.timelineEndMs}`
          )
          .join('|')
      )
      .digest('hex');
    if (expectedManifestChecksum !== request.manifestChecksum.toLowerCase()) {
      throw new Error('Refinement manifest checksum does not match its controlled assets');
    }
    const parts = await this.resolveRefinementParts(request);
    const totalDataBytes = parts.reduce(
      (total, part) => total + part.silenceBeforeBytes + part.dataBytes,
      0
    );
    if (totalDataBytes <= 0 || totalDataBytes > MAX_REFINEMENT_BYTES) {
      throw new Error('Refinement audio is outside the allowed size');
    }
    const wavHeader = createWavHeader(totalDataBytes);
    const audioChecksum = await this.hashAlignedAudio(wavHeader, parts);
    const metadata = JSON.stringify({
      meetingId: request.meetingId,
      idempotencyKey: request.idempotencyKey,
      sourceTranscriptVersionId: request.sourceTranscriptVersionId,
      manifestChecksum: request.manifestChecksum,
      audioChecksum,
      contentType: request.contentType,
      knownSpeakerCount: request.knownSpeakerCount,
      parts: request.parts.map((part) => ({
        assetId: part.assetId,
        sourceKind: part.sourceKind,
        checksum: part.checksumSha256,
        timelineStartMs: part.timelineStartMs,
        timelineEndMs: part.timelineEndMs,
        providerStartMs: part.providerInputStartMs,
        providerEndMs: part.providerInputEndMs,
      })),
    });
    const boundary = `obelus-${randomBytes(18).toString('hex')}`;
    const metadataPrefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`
    );
    const audioPrefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="aligned.wav"\r\nContent-Type: ${request.contentType}\r\n\r\n`
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength =
      metadataPrefix.byteLength +
      audioPrefix.byteLength +
      wavHeader.byteLength +
      totalDataBytes +
      suffix.byteLength;

    const stream = Readable.from(
      this.alignedMultipartChunks(metadataPrefix, audioPrefix, wavHeader, parts, suffix)
    );
    return { boundary, contentLength, stream };
  }

  private async resolveRefinementParts(request: RefinementSubmitRequest): Promise<ResolvedPart[]> {
    const resolved: ResolvedPart[] = [];
    const seenAssetIds = new Set<string>();
    let providerCursorMs = 0;
    for (const input of request.parts) {
      if (input.sourceKind !== 'mixed') {
        throw new Error('Refinement accepts only the controlled aligned mix');
      }
      if (seenAssetIds.has(input.assetId)) {
        throw new Error('Refinement audio assets must be unique');
      }
      seenAssetIds.add(input.assetId);
      if (input.providerInputStartMs < providerCursorMs) {
        throw new Error('Refinement audio parts overlap');
      }
      const asset = await this.options.resolveAudioAsset(
        request.meetingId,
        input.assetId,
        input.sourceKind
      );
      if (
        asset.meetingId !== request.meetingId ||
        asset.assetId !== input.assetId ||
        asset.sourceKind !== input.sourceKind ||
        asset.checksumSha256 !== input.checksumSha256 ||
        asset.timelineStartMs !== input.timelineStartMs ||
        asset.timelineEndMs !== input.timelineEndMs ||
        input.providerInputStartMs !== asset.timelineStartMs ||
        input.providerInputEndMs !== asset.timelineEndMs
      ) {
        throw new Error('Refinement manifest does not match the controlled audio metadata');
      }
      if (asset.size <= WAV_HEADER_BYTES) throw new Error('Refinement audio asset is empty');
      await assertWavAsset(asset, input.checksumSha256);
      const dataBytes = asset.size - WAV_HEADER_BYTES;
      const expectedDurationMs = (dataBytes / (WAV_SAMPLE_RATE * 2)) * 1000;
      const mappedDurationMs = input.providerInputEndMs - input.providerInputStartMs;
      if (Math.abs(mappedDurationMs - expectedDurationMs) > 250) {
        throw new Error('Refinement audio mapping does not match the controlled asset');
      }
      const silenceBeforeBytes = millisecondsToPcmBytes(
        input.providerInputStartMs - providerCursorMs
      );
      resolved.push({ input, asset, dataBytes, silenceBeforeBytes });
      providerCursorMs = input.providerInputStartMs + expectedDurationMs;
    }
    return resolved;
  }

  private async hashAlignedAudio(header: Buffer, parts: readonly ResolvedPart[]): Promise<string> {
    const hash = createHash('sha256');
    hash.update(header);
    for (const part of parts) {
      updateHashWithSilence(hash, part.silenceBeforeBytes);
      for await (const chunk of createReadStream(part.asset.absolutePath, {
        start: WAV_HEADER_BYTES,
      })) {
        hash.update(chunk);
      }
    }
    return hash.digest('hex');
  }

  private async *alignedMultipartChunks(
    metadataPrefix: Buffer,
    audioPrefix: Buffer,
    wavHeader: Buffer,
    parts: readonly ResolvedPart[],
    suffix: Buffer
  ): AsyncGenerator<Buffer> {
    yield metadataPrefix;
    yield audioPrefix;
    yield wavHeader;
    for (const part of parts) {
      yield* silenceChunks(part.silenceBeforeBytes);
      for await (const chunk of createReadStream(part.asset.absolutePath, {
        start: WAV_HEADER_BYTES,
      })) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    }
    yield suffix;
  }

  private async requestJson(
    pathname: string,
    options: {
      method: 'GET' | 'POST' | 'DELETE';
      body?: unknown;
      headers?: Record<string, string>;
      authenticated?: boolean;
      streamingBody?: boolean;
      timeoutMs?: number;
    }
  ): Promise<unknown> {
    if (!this.baseUrl) throw new Error('The Obelus research gateway is not configured');
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
    };
    if (options.authenticated !== false) {
      headers.Authorization = await this.options.sessionProvider.getAuthorizationHeader();
    }
    let body: FetchBody;
    if (options.body !== undefined) {
      if (options.streamingBody) {
        body = options.body as FetchBody;
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.requestTimeoutMs
    );
    try {
      const init: FetchInit & { duplex?: 'half' } = {
        method: options.method,
        headers,
        body,
        signal: controller.signal,
      };
      if (options.streamingBody) init.duplex = 'half';
      const response = await this.fetchImpl(new URL(pathname, this.baseUrl), init);
      const parsed = await readBoundedJson(response, this.maxResponseBytes);
      if (!response.ok) throw gatewayResponseError(response.status, parsed);
      return parsed;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('The gateway request timed out');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseGatewayBaseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    if (
      (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) {
      return null;
    }
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('Gateway response exceeded the allowed size');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Gateway response exceeded the allowed size');
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error('Gateway returned an invalid response');
  }
}

function gatewayResponseError(status: number, value: unknown): Error {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const nested =
    record?.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : record;
  const message =
    nested && typeof nested.message === 'string' && nested.message.length <= 500
      ? nested.message
      : `Gateway request failed (${status})`;
  const code =
    nested && typeof nested.code === 'string' && nested.code.length <= 128
      ? nested.code
      : 'gateway_request_failed';
  return Object.assign(new Error(message), {
    code,
    retryable:
      nested && typeof nested.retryable === 'boolean'
        ? nested.retryable
        : status === 408 || status === 429 || status >= 500,
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Gateway returned an invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Gateway returned an invalid ${label}`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Gateway returned an invalid ${label}`);
  }
  return value;
}

function requireSecureWebSocketUrl(value: unknown): string {
  const raw = requireBoundedString(value, 'streaming URL', 2_048);
  const parsed = new URL(raw);
  if (parsed.protocol !== 'wss:' || parsed.hostname !== 'streaming.assemblyai.com') {
    throw new Error('Gateway returned an untrusted streaming URL');
  }
  return parsed.href;
}

function boundedScalarRecord(
  value: Record<string, unknown>
): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 128 || Object.keys(output).length >= 32) break;
    if (item === null || typeof item === 'number' || typeof item === 'boolean') output[key] = item;
    if (typeof item === 'string' && item.length <= 1_024) output[key] = item;
  }
  return output;
}

function parseFactCheckResponse(
  value: unknown,
  expectedStage: FactCheckStage
): GatewayJobResponse<unknown> {
  const record = asRecord(value, 'fact-check response');
  if (typeof record.checkId !== 'string') {
    return { ...parseJobResponse(record), backend: 'hosted' };
  }

  const checkId = requireBoundedString(record.checkId, 'check ID', 128);
  const remoteStatus = requireBoundedString(record.status, 'fact-check status', 64);
  if (!isFactCheckStatus(remoteStatus)) {
    throw new Error('Gateway returned an invalid fact-check status');
  }

  const preliminary = optionalRecord(record.preliminaryAssessment);
  const deep = optionalRecord(record.deepAssessment);
  const canonical = optionalRecord(record.canonicalAssessment);
  const canonicalStage = normalizeAssessmentStage(canonical?.stage);
  const selected =
    expectedStage === 'deep'
      ? (deep ?? (canonicalStage === 'deep' ? canonical : undefined))
      : (preliminary ?? (canonicalStage !== 'deep' ? canonical : undefined));
  const escalation = parseEscalation(record.escalation);
  const result = selected
    ? normalizeFactCheckAssessment(
        selected,
        expectedStage,
        record.evidence,
        record.provenance,
        escalation,
        record.policyVersion,
        record.contractVersion,
        record.completedAt ?? record.updatedAt
      )
    : undefined;
  const error = parseJobError(record.error);

  return {
    jobId: checkId,
    status: factCheckJobStatus(remoteStatus, result !== undefined),
    result,
    error:
      error ??
      (remoteStatus === 'research_unavailable'
        ? {
            code: 'research_unavailable',
            message: 'Research is temporarily unavailable.',
            retryable: false,
          }
        : undefined),
    usage: Array.isArray(record.usage) ? record.usage.slice(0, 100) : undefined,
    cost: optionalRecord(record.cost),
    evidence: Array.isArray(record.evidence) ? record.evidence.slice(0, 100) : undefined,
    provenance: Array.isArray(record.provenance) ? record.provenance.slice(0, 100) : undefined,
    version:
      typeof record.version === 'number' && Number.isSafeInteger(record.version)
        ? record.version
        : undefined,
    createdAt: boundedOptionalString(record.createdAt, 128),
    updatedAt: boundedOptionalString(record.updatedAt, 128),
    completedAt:
      record.completedAt === null ? null : boundedOptionalString(record.completedAt, 128),
    expiresAt: boundedOptionalString(record.expiresAt, 128),
    backend: 'hosted',
    remoteStage:
      typeof record.stage === 'string' && record.stage.length <= 64 ? record.stage : remoteStatus,
    policyVersion: boundedOptionalString(record.policyVersion, 128),
    contractVersion: boundedOptionalString(record.contractVersion, 128),
    escalation,
  };
}

function normalizeFactCheckAssessment(
  assessment: Record<string, unknown>,
  expectedStage: FactCheckStage,
  envelopeEvidence: unknown,
  envelopeProvenance: unknown,
  escalation: GatewayJobResponse['escalation'],
  policyVersion: unknown,
  contractVersion: unknown,
  completedAt: unknown
): Record<string, unknown> {
  const evidenceValue = Array.isArray(assessment.inventory)
    ? assessment.inventory
    : Array.isArray(assessment.evidence)
      ? assessment.evidence
      : Array.isArray(envelopeEvidence)
        ? envelopeEvidence
        : [];
  const evidence = evidenceValue.slice(0, 100).map((item) => {
    const source = optionalRecord(item);
    if (!source) return item;
    return {
      ...source,
      citationId: source.citationId ?? source.citationKey ?? source.id,
      retrievalKind: source.retrievalKind ?? source.excerptType,
    };
  });
  const stage =
    normalizeAssessmentStage(assessment.stage) ??
    (expectedStage === 'deep' ? 'deep' : 'preliminary');
  const conclusion =
    boundedOptionalString(assessment.conclusion, 20_000) ??
    boundedOptionalString(assessment.summary, 20_000) ??
    '';
  const conclusionCitationIds = stringArray(
    assessment.conclusionCitationIds ?? assessment.conclusionCitationKeys
  );
  const sourcesValue = Array.isArray(assessment.sources)
    ? assessment.sources.slice(0, 100)
    : evidence;
  const sources = sourcesValue.map((item) => {
    const source = optionalRecord(item) ?? {};
    return {
      citationId: source.citationId ?? source.citationKey ?? source.id ?? '',
      stance: normalizeSourceStance(source.stance ?? source.relation),
      qualityScore: source.qualityScore ?? 0,
      qualityRationale: source.qualityRationale ?? 'Source quality was not scored.',
    };
  });

  return {
    ...assessment,
    stage,
    verdict: assessment.verdict ?? assessment.finding,
    conclusion,
    conclusionCitationIds,
    statements: citedStatementArray(assessment.statements),
    supports: citedStatementArray(assessment.supports ?? assessment.support),
    contradictions: citedStatementArray(assessment.contradictions ?? assessment.contradiction),
    caveats: citedStatementArray(assessment.caveats),
    limitations: citedStatementArray(assessment.limitations),
    sources,
    inventory: evidence,
    completedAt:
      boundedOptionalString(assessment.completedAt, 128) ??
      boundedOptionalString(completedAt, 128) ??
      new Date().toISOString(),
    aiGenerated: true,
    provenance: normalizeProvenance(assessment.provenance ?? envelopeProvenance, stage),
    escalation,
    escalationRecommended: escalation?.recommended === true,
    escalationReasons: escalation?.reasons ?? [],
    policyVersion:
      boundedOptionalString(assessment.policyVersion, 128) ??
      boundedOptionalString(policyVersion, 128),
    contractVersion:
      boundedOptionalString(assessment.contractVersion, 128) ??
      boundedOptionalString(contractVersion, 128),
    changeExplanation:
      boundedOptionalString(assessment.changeExplanation, 2_000) ??
      boundedOptionalString(optionalRecord(assessment.changeExplanation)?.text, 2_000),
    changeExplanationCitationIds: stringArray(
      optionalRecord(assessment.changeExplanation)?.citationIds ??
        optionalRecord(assessment.changeExplanation)?.citationKeys
    ),
  };
}

function normalizeSourceStance(value: unknown): 'supports' | 'contradicts' | 'context' {
  if (value === 'supports') return 'supports';
  if (value === 'contradicts') return 'contradicts';
  return 'context';
}

function normalizeProvenance(
  value: unknown,
  stage: 'preliminary' | 'deep'
): Record<string, unknown> | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  const records = candidates.flatMap((candidate) => {
    const record = optionalRecord(candidate);
    return record ? [record] : [];
  });
  const selected =
    records.find(
      (record) => record.stage === stage || (stage === 'preliminary' && record.stage === 'quick')
    ) ?? records[0];
  if (!selected) return undefined;
  return {
    provider: boundedOptionalString(selected.provider, 128) ?? 'gateway-configured',
    model: boundedOptionalString(selected.model, 256) ?? 'gateway-configured',
  };
}

function citedStatementArray(value: unknown): Array<{ text: string; citationIds: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item) => {
    if (typeof item === 'string') return [{ text: item, citationIds: [] }];
    const statement = optionalRecord(item);
    const text = boundedOptionalString(statement?.text, 20_000);
    if (!text) return [];
    return [
      {
        text,
        citationIds: stringArray(statement?.citationIds ?? statement?.citationKeys),
      },
    ];
  });
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 100)
    .filter((item): item is string => typeof item === 'string' && item.length <= 512);
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedOptionalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function normalizeAssessmentStage(value: unknown): 'preliminary' | 'deep' | undefined {
  if (value === 'preliminary' || value === 'quick') return 'preliminary';
  if (value === 'deep') return 'deep';
  return undefined;
}

function parseEscalation(value: unknown): GatewayJobResponse['escalation'] {
  const record = optionalRecord(value);
  if (!record) return undefined;
  return {
    recommended: record.recommended === true,
    requested: record.requested === true,
    reasons: stringArray(record.reasons),
    unresolvedSubquestions: stringArray(record.unresolvedSubquestions),
  };
}

function parseJobError(value: unknown): GatewayJobResponse['error'] {
  const record = optionalRecord(value);
  if (!record) return undefined;
  const code = boundedOptionalString(record.code, 128);
  const message = boundedOptionalString(record.message, 1_000);
  if (!code || !message) return undefined;
  return { code, message, retryable: record.retryable === true };
}

function factCheckJobStatus(
  status: string,
  hasExpectedAssessment: boolean
): GatewayJobResponse['status'] {
  if (hasExpectedAssessment) return 'complete';
  if (status === 'pending' || status === 'deep_pending') return 'pending';
  if (status === 'running' || status === 'preliminary' || status === 'deep_running') {
    return 'running';
  }
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

function isFactCheckStatus(value: string): boolean {
  return [
    'pending',
    'running',
    'preliminary',
    'deep_pending',
    'deep_running',
    'complete',
    'failed',
    'cancelled',
    'research_unavailable',
  ].includes(value);
}

function parseJobResponse(value: unknown): GatewayJobResponse<unknown> {
  const record = asRecord(value, 'job response');
  const jobId = requireBoundedString(record.jobId, 'job ID', 128);
  if (!isJobStatus(record.status)) throw new Error('Gateway returned an invalid job status');
  const errorValue = record.error;
  const errorRecord =
    errorValue && typeof errorValue === 'object' && !Array.isArray(errorValue)
      ? (errorValue as Record<string, unknown>)
      : null;
  return {
    jobId,
    status: record.status,
    result: record.result,
    usage: Array.isArray(record.usage) ? record.usage.slice(0, 100) : undefined,
    error: errorRecord
      ? {
          code: requireBoundedString(errorRecord.code, 'job error code', 128),
          message: requireBoundedString(errorRecord.message, 'job error message', 1_000),
          retryable: errorRecord.retryable === true,
        }
      : undefined,
  };
}

function isJobStatus(value: unknown): value is GatewayJobResponse['status'] {
  return ['pending', 'running', 'retry_wait', 'complete', 'failed', 'cancelled'].includes(
    String(value)
  );
}

function isDeleteStatus(value: unknown): value is GatewayDeleteResponse['status'] {
  return ['pending', 'complete', 'partial', 'failed'].includes(String(value));
}

function isProviderCleanup(
  value: unknown
): value is NonNullable<GatewayDeleteResponse['providerCleanup']> {
  return ['pending', 'complete', 'partial', 'unsupported', 'failed'].includes(String(value));
}

function normalizeGatewayCleanup(
  value: string
): NonNullable<GatewayDeleteResponse['gatewayCleanup']> {
  if (value === 'complete') return 'complete';
  if (value === 'failed') return 'failed';
  return 'pending';
}

function normalizeProviderCleanup(
  value: unknown
): NonNullable<GatewayDeleteResponse['providerCleanup']> {
  if (value === 'complete') return 'complete';
  if (value === 'partial') return 'partial';
  if (value === 'unsupported') return 'unsupported';
  if (value === 'failed') return 'failed';
  return 'pending';
}

async function assertWavAsset(asset: ResolvedAudioAsset, expectedChecksum: string): Promise<void> {
  const handle = await open(asset.absolutePath, 'r');
  try {
    const header = Buffer.alloc(WAV_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== WAV_HEADER_BYTES ||
      header.toString('ascii', 0, 4) !== 'RIFF' ||
      header.toString('ascii', 8, 12) !== 'WAVE' ||
      header.readUInt16LE(20) !== 1 ||
      header.readUInt16LE(22) !== 1 ||
      header.readUInt32LE(24) !== WAV_SAMPLE_RATE ||
      header.readUInt16LE(34) !== 16 ||
      header.readUInt32LE(40) !== asset.size - WAV_HEADER_BYTES
    ) {
      throw new Error('Refinement audio asset has an invalid WAV format');
    }
  } finally {
    await handle.close();
  }

  const hash = createHash('sha256');
  for await (const chunk of createReadStream(asset.absolutePath)) hash.update(chunk);
  if (hash.digest('hex') !== expectedChecksum.toLowerCase()) {
    throw new Error('Refinement audio asset checksum does not match its manifest');
  }
}

function createWavHeader(dataBytes: number): Buffer {
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataBytes > 0xffffffff - 36) {
    throw new Error('Refinement WAV is too large');
  }
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  header.writeUInt32LE(WAV_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function millisecondsToPcmBytes(milliseconds: number): number {
  const samples = Math.round((milliseconds / 1_000) * WAV_SAMPLE_RATE);
  return samples * 2;
}

function* silenceChunks(byteLength: number): Generator<Buffer> {
  let remaining = byteLength;
  while (remaining > 0) {
    const length = Math.min(remaining, 64 * 1024);
    yield Buffer.alloc(length);
    remaining -= length;
  }
}

function updateHashWithSilence(hash: ReturnType<typeof createHash>, byteLength: number): void {
  for (const chunk of silenceChunks(byteLength)) hash.update(chunk);
}
