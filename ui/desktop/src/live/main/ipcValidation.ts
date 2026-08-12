import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type {
  ClaimDetectionRequest,
  FactCheckStage,
  FactCheckSubmitRequest,
  GatewayTranscriptTurn,
  LiveAudioFrame,
  LiveAudioMeter,
  LiveAudioSourceKind,
  LiveCaptureStartConfig,
  RefinementInputPart,
  RefinementSubmitRequest,
  SttSessionRequest,
  SttSessionCompleteRequest,
} from '../ipcTypes';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_TITLE_LENGTH = 300;
const MAX_TURN_TEXT_LENGTH = 12_000;
const MAX_QUOTE_LENGTH = 4_000;
const MAX_NORMALIZED_CLAIM_LENGTH = 2_000;
const MAX_AUDIO_BYTES_PER_SOURCE = 32_768;
const MAX_AUDIO_FRAME_DURATION_MS = 200;
const AUDIO_SOURCES: ReadonlySet<LiveAudioSourceKind> = new Set(['microphone', 'system', 'mixed']);

export class LiveIpcValidationError extends Error {
  readonly code = 'INVALID_LIVE_REQUEST';

  constructor(message: string) {
    super(message);
    this.name = 'LiveIpcValidationError';
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LiveIpcValidationError(`${label} must be an object`);
  }
}

export function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new LiveIpcValidationError(`${label} is invalid`);
  }
}

function assertBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false
): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maxLength
  ) {
    throw new LiveIpcValidationError(`${label} is invalid`);
  }
}

function assertIdempotencyKey(value: unknown): asserts value is string {
  assertBoundedString(value, 'idempotencyKey', 256);
  if (value.length < 8) {
    throw new LiveIpcValidationError('idempotencyKey is invalid');
  }
}

export function validateIdempotencyKey(value: unknown): string {
  assertIdempotencyKey(value);
  return value;
}

function assertFiniteRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new LiveIpcValidationError(`${label} is outside the allowed range`);
  }
}

function assertAudioSource(value: unknown, label: string): asserts value is LiveAudioSourceKind {
  if (typeof value !== 'string' || !AUDIO_SOURCES.has(value as LiveAudioSourceKind)) {
    throw new LiveIpcValidationError(`${label} is invalid`);
  }
}

function assertMeter(value: unknown, label: string): asserts value is LiveAudioMeter {
  assertRecord(value, label);
  assertFiniteRange(value.rms, `${label}.rms`, 0, 1);
  assertFiniteRange(value.peak, `${label}.peak`, 0, 1);
}

export function validateStartConfig(value: unknown): LiveCaptureStartConfig {
  assertRecord(value, 'config');
  assertSafeId(value.meetingId, 'meetingId');
  if (value.mode !== 'call' && value.mode !== 'in_person') {
    throw new LiveIpcValidationError('mode is invalid');
  }
  if (value.strategy !== 'mixed_diarized' && value.strategy !== 'source_separated') {
    throw new LiveIpcValidationError('strategy is invalid');
  }
  if (typeof value.includeSystemAudio !== 'boolean') {
    throw new LiveIpcValidationError('includeSystemAudio must be a boolean');
  }
  if (value.mode === 'in_person' && value.includeSystemAudio) {
    throw new LiveIpcValidationError('In-person capture cannot include system audio');
  }
  if (value.microphoneDeviceId !== undefined) {
    assertBoundedString(value.microphoneDeviceId, 'microphoneDeviceId', 512);
  }
  if (value.title !== undefined) {
    assertBoundedString(value.title, 'title', MAX_TITLE_LENGTH, true);
  }
  return {
    meetingId: value.meetingId,
    mode: value.mode,
    strategy: value.strategy,
    includeSystemAudio: value.includeSystemAudio,
    ...(value.microphoneDeviceId === undefined
      ? {}
      : { microphoneDeviceId: value.microphoneDeviceId }),
    ...(value.title === undefined ? {} : { title: value.title }),
  };
}

export function validateAudioFrame(value: unknown): LiveAudioFrame {
  assertRecord(value, 'frame');
  assertSafeId(value.meetingId, 'meetingId');
  assertSafeId(value.captureSessionId, 'captureSessionId');
  assertFiniteRange(value.sequence, 'sequence', 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(value.sequence)) {
    throw new LiveIpcValidationError('sequence must be an integer');
  }
  assertFiniteRange(value.meetingTimeMs, 'meetingTimeMs', 0, Number.MAX_SAFE_INTEGER);
  assertFiniteRange(value.durationMs, 'durationMs', 1, MAX_AUDIO_FRAME_DURATION_MS);
  if (value.sampleRate !== 16000 || value.channels !== 1) {
    throw new LiveIpcValidationError('audio must be 16 kHz mono PCM');
  }
  assertFiniteRange(value.workletDroppedFrames, 'workletDroppedFrames', 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(value.workletDroppedFrames)) {
    throw new LiveIpcValidationError('workletDroppedFrames must be an integer');
  }

  assertRecord(value.pcm, 'pcm');
  const entries = Object.entries(value.pcm);
  if (entries.length === 0 || entries.length > AUDIO_SOURCES.size) {
    throw new LiveIpcValidationError('pcm must contain one or more known sources');
  }
  const pcm: LiveAudioFrame['pcm'] = {};
  for (const [source, buffer] of entries) {
    assertAudioSource(source, 'pcm source');
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
      throw new LiveIpcValidationError(`pcm.${source} must be a non-empty ArrayBuffer`);
    }
    if (buffer.byteLength > MAX_AUDIO_BYTES_PER_SOURCE || buffer.byteLength % 2 !== 0) {
      throw new LiveIpcValidationError(`pcm.${source} has an invalid size`);
    }
    const expectedBytes = Math.round((value.durationMs / 1000) * value.sampleRate) * 2;
    if (Math.abs(buffer.byteLength - expectedBytes) > 4) {
      throw new LiveIpcValidationError(`pcm.${source} does not match frame duration`);
    }
    pcm[source] = buffer;
  }

  assertRecord(value.meters, 'meters');
  const meters: LiveAudioFrame['meters'] = {};
  for (const [source, meter] of Object.entries(value.meters)) {
    assertAudioSource(source, 'meter source');
    assertMeter(meter, `meters.${source}`);
    meters[source] = { rms: meter.rms, peak: meter.peak };
  }
  return {
    meetingId: value.meetingId,
    captureSessionId: value.captureSessionId,
    sequence: value.sequence,
    meetingTimeMs: value.meetingTimeMs,
    durationMs: value.durationMs,
    sampleRate: 16000,
    channels: 1,
    pcm,
    meters,
    workletDroppedFrames: value.workletDroppedFrames,
  };
}

function validateTurn(value: unknown, label: string): GatewayTranscriptTurn {
  assertRecord(value, label);
  assertSafeId(value.id, `${label}.id`);
  if (value.speakerId !== undefined && value.speakerId !== null) {
    assertSafeId(value.speakerId, `${label}.speakerId`);
  }
  assertFiniteRange(value.startMs, `${label}.startMs`, 0, Number.MAX_SAFE_INTEGER);
  assertFiniteRange(value.endMs, `${label}.endMs`, value.startMs, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(value.startMs) || !Number.isInteger(value.endMs)) {
    throw new LiveIpcValidationError(`${label} timestamps must be integers`);
  }
  assertBoundedString(value.text, `${label}.text`, MAX_TURN_TEXT_LENGTH);
  if (value.sourceKind !== undefined) assertAudioSource(value.sourceKind, `${label}.sourceKind`);
  return {
    id: value.id,
    speakerId: value.speakerId ?? null,
    startMs: value.startMs,
    endMs: value.endMs,
    text: value.text,
    ...(value.sourceKind === undefined ? {} : { sourceKind: value.sourceKind }),
  };
}

function validateTurns(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 1
): GatewayTranscriptTurn[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new LiveIpcValidationError(`${label} has an invalid number of turns`);
  }
  return value.map((turn, index) => validateTurn(turn, `${label}[${index}]`));
}

export function validateSttSessionRequest(value: unknown): SttSessionRequest {
  assertRecord(value, 'request');
  assertSafeId(value.meetingId, 'meetingId');
  assertIdempotencyKey(value.idempotencyKey);
  if (value.strategy !== 'mixed_diarized' && value.strategy !== 'source_separated') {
    throw new LiveIpcValidationError('strategy is invalid');
  }
  assertAudioSource(value.sourceKind, 'sourceKind');
  if (value.maxSessionSeconds !== undefined) {
    assertFiniteRange(value.maxSessionSeconds, 'maxSessionSeconds', 60, 10_800);
    if (!Number.isInteger(value.maxSessionSeconds)) {
      throw new LiveIpcValidationError('maxSessionSeconds must be an integer');
    }
  }
  return {
    meetingId: value.meetingId,
    idempotencyKey: value.idempotencyKey,
    strategy: value.strategy,
    sourceKind: value.sourceKind,
    ...(value.maxSessionSeconds === undefined
      ? {}
      : { maxSessionSeconds: value.maxSessionSeconds }),
  };
}

export function validateSttSessionCompleteRequest(value: unknown): SttSessionCompleteRequest {
  assertRecord(value, 'request');
  assertSafeId(value.meetingId, 'meetingId');
  if (value.providerSessionId !== undefined) {
    assertBoundedString(value.providerSessionId, 'providerSessionId', 256);
  }
  if (value.sessionDurationSeconds !== undefined) {
    assertFiniteRange(value.sessionDurationSeconds, 'sessionDurationSeconds', 0, 10_800);
  }
  if (value.audioDurationSeconds !== undefined) {
    assertFiniteRange(value.audioDurationSeconds, 'audioDurationSeconds', 0, 10_800);
  }
  if (!['terminated', 'rotated', 'disconnected', 'error'].includes(String(value.endedReason))) {
    throw new LiveIpcValidationError('endedReason is invalid');
  }
  return {
    meetingId: value.meetingId,
    endedReason: value.endedReason as SttSessionCompleteRequest['endedReason'],
    ...(value.providerSessionId === undefined
      ? {}
      : { providerSessionId: value.providerSessionId }),
    ...(value.sessionDurationSeconds === undefined
      ? {}
      : { sessionDurationSeconds: value.sessionDurationSeconds }),
    ...(value.audioDurationSeconds === undefined
      ? {}
      : { audioDurationSeconds: value.audioDurationSeconds }),
  };
}

export function validateClaimDetectionRequest(value: unknown): ClaimDetectionRequest {
  assertRecord(value, 'request');
  assertSafeId(value.meetingId, 'meetingId');
  assertIdempotencyKey(value.idempotencyKey);
  const turns = validateTurns(value.turns, 'turns', 40);
  const contextTurns =
    value.contextTurns === undefined
      ? undefined
      : validateTurns(value.contextTurns, 'contextTurns', 20);
  const availableTurnIds = new Set((contextTurns ?? turns).map((turn) => turn.id));
  let requiredTurnIds: string[] | undefined;
  if (value.requiredTurnIds !== undefined) {
    if (!Array.isArray(value.requiredTurnIds) || value.requiredTurnIds.length === 0) {
      throw new LiveIpcValidationError('requiredTurnIds is invalid');
    }
    requiredTurnIds = value.requiredTurnIds.map((turnId, index) => {
      assertSafeId(turnId, `requiredTurnIds[${index}]`);
      if (!availableTurnIds.has(turnId)) {
        throw new LiveIpcValidationError('requiredTurnIds must reference supplied turns');
      }
      return turnId;
    });
    if (new Set(requiredTurnIds).size !== requiredTurnIds.length) {
      throw new LiveIpcValidationError('requiredTurnIds must be unique');
    }
  }
  if (value.existingClaimKeys !== undefined) {
    if (!Array.isArray(value.existingClaimKeys) || value.existingClaimKeys.length > 50) {
      throw new LiveIpcValidationError('existingClaimKeys is invalid');
    }
    for (const key of value.existingClaimKeys) {
      assertBoundedString(key, 'existingClaimKey', 256);
    }
  }
  if (value.manual !== undefined && typeof value.manual !== 'boolean') {
    throw new LiveIpcValidationError('manual is invalid');
  }
  if (value.manual === true) {
    assertBoundedString(value.manualSelection, 'manualSelection', 4_000);
  } else if (value.manualSelection !== undefined) {
    throw new LiveIpcValidationError('manualSelection requires manual claim detection');
  }
  return {
    meetingId: value.meetingId,
    idempotencyKey: value.idempotencyKey,
    turns,
    ...(contextTurns === undefined ? {} : { contextTurns }),
    ...(requiredTurnIds === undefined ? {} : { requiredTurnIds }),
    ...(value.existingClaimKeys === undefined
      ? {}
      : { existingClaimKeys: [...value.existingClaimKeys] as string[] }),
    ...(value.manual === undefined ? {} : { manual: value.manual }),
    ...(value.manualSelection === undefined
      ? {}
      : { manualSelection: value.manualSelection as string }),
  };
}

export function validateFactCheckStage(value: unknown): FactCheckStage {
  if (value !== 'quick' && value !== 'deep') {
    throw new LiveIpcValidationError('stage is invalid');
  }
  return value;
}

export function validateFactCheckRequest(value: unknown): FactCheckSubmitRequest {
  assertRecord(value, 'request');
  assertSafeId(value.meetingId, 'meetingId');
  assertSafeId(value.claimId, 'claimId');
  assertSafeId(value.claimVersionId, 'claimVersionId');
  assertIdempotencyKey(value.idempotencyKey);
  assertBoundedString(value.exactQuote, 'exactQuote', MAX_QUOTE_LENGTH);
  assertBoundedString(value.normalizedClaim, 'normalizedClaim', MAX_NORMALIZED_CLAIM_LENGTH);
  if (value.origin !== 'automatic' && value.origin !== 'manual') {
    throw new LiveIpcValidationError('origin is invalid');
  }
  if (value.timeSensitive !== undefined && typeof value.timeSensitive !== 'boolean') {
    throw new LiveIpcValidationError('timeSensitive is invalid');
  }
  if (value.consequenceScore !== undefined) {
    assertFiniteRange(value.consequenceScore, 'consequenceScore', 0, 1);
  }
  if (value.autoEscalate !== undefined && typeof value.autoEscalate !== 'boolean') {
    throw new LiveIpcValidationError('autoEscalate is invalid');
  }
  const contextTurns = validateTurns(value.contextTurns, 'contextTurns', 20, 0);
  let requiredTurnIds: string[] | undefined;
  if (value.requiredTurnIds !== undefined) {
    if (!Array.isArray(value.requiredTurnIds) || value.requiredTurnIds.length > 20) {
      throw new LiveIpcValidationError('requiredTurnIds is invalid');
    }
    const contextTurnIds = new Set(contextTurns.map((turn) => turn.id));
    requiredTurnIds = value.requiredTurnIds.map((turnId, index) => {
      assertSafeId(turnId, `requiredTurnIds[${index}]`);
      if (!contextTurnIds.has(turnId)) {
        throw new LiveIpcValidationError('requiredTurnIds must reference supplied contextTurns');
      }
      return turnId;
    });
    if (new Set(requiredTurnIds).size !== requiredTurnIds.length) {
      throw new LiveIpcValidationError('requiredTurnIds must be unique');
    }
  }
  return {
    meetingId: value.meetingId,
    claimId: value.claimId,
    claimVersionId: value.claimVersionId,
    idempotencyKey: value.idempotencyKey,
    exactQuote: value.exactQuote,
    normalizedClaim: value.normalizedClaim,
    contextTurns,
    ...(requiredTurnIds === undefined ? {} : { requiredTurnIds }),
    origin: value.origin,
    ...(value.timeSensitive === undefined ? {} : { timeSensitive: value.timeSensitive }),
    ...(value.consequenceScore === undefined ? {} : { consequenceScore: value.consequenceScore }),
    ...(value.autoEscalate === undefined ? {} : { autoEscalate: value.autoEscalate }),
  };
}

export function validateFactCheckEscalationReason(value: unknown): 'user' | 'policy' {
  if (value !== 'user' && value !== 'policy') {
    throw new LiveIpcValidationError('fact-check escalation reason is invalid');
  }
  return value;
}

export function validateUnresolvedSubquestions(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 8) {
    throw new LiveIpcValidationError('unresolvedSubquestions is invalid');
  }
  return value.map((item, index) => {
    assertBoundedString(item, `unresolvedSubquestions[${index}]`, 500);
    return item;
  });
}

function validateRefinementPart(value: unknown, index: number): RefinementInputPart {
  const label = `parts[${index}]`;
  assertRecord(value, label);
  assertSafeId(value.assetId, `${label}.assetId`);
  assertAudioSource(value.sourceKind, `${label}.sourceKind`);
  if (typeof value.checksumSha256 !== 'string' || !SHA256.test(value.checksumSha256)) {
    throw new LiveIpcValidationError(`${label}.checksumSha256 is invalid`);
  }
  assertFiniteRange(value.timelineStartMs, `${label}.timelineStartMs`, 0, Number.MAX_SAFE_INTEGER);
  assertFiniteRange(
    value.timelineEndMs,
    `${label}.timelineEndMs`,
    value.timelineStartMs,
    Number.MAX_SAFE_INTEGER
  );
  assertFiniteRange(
    value.providerInputStartMs,
    `${label}.providerInputStartMs`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  assertFiniteRange(
    value.providerInputEndMs,
    `${label}.providerInputEndMs`,
    value.providerInputStartMs,
    Number.MAX_SAFE_INTEGER
  );
  if (
    !Number.isInteger(value.timelineStartMs) ||
    !Number.isInteger(value.timelineEndMs) ||
    !Number.isInteger(value.providerInputStartMs) ||
    !Number.isInteger(value.providerInputEndMs)
  ) {
    throw new LiveIpcValidationError(`${label} timestamps must be integers`);
  }
  if (
    value.timelineEndMs <= value.timelineStartMs ||
    value.providerInputEndMs <= value.providerInputStartMs
  ) {
    throw new LiveIpcValidationError(`${label} must have positive time ranges`);
  }
  return {
    assetId: value.assetId,
    sourceKind: value.sourceKind,
    checksumSha256: value.checksumSha256.toLowerCase(),
    timelineStartMs: value.timelineStartMs,
    timelineEndMs: value.timelineEndMs,
    providerInputStartMs: value.providerInputStartMs,
    providerInputEndMs: value.providerInputEndMs,
  };
}

export function validateRefinementRequest(value: unknown): RefinementSubmitRequest {
  assertRecord(value, 'request');
  assertSafeId(value.meetingId, 'meetingId');
  assertIdempotencyKey(value.idempotencyKey);
  assertSafeId(value.sourceTranscriptVersionId, 'sourceTranscriptVersionId');
  if (typeof value.manifestChecksum !== 'string' || !SHA256.test(value.manifestChecksum)) {
    throw new LiveIpcValidationError('manifestChecksum is invalid');
  }
  if (value.contentType !== 'audio/wav' && value.contentType !== 'audio/x-wav') {
    throw new LiveIpcValidationError('contentType is invalid');
  }
  if (value.knownSpeakerCount !== undefined) {
    assertFiniteRange(value.knownSpeakerCount, 'knownSpeakerCount', 1, 20);
    if (!Number.isInteger(value.knownSpeakerCount)) {
      throw new LiveIpcValidationError('knownSpeakerCount must be an integer');
    }
  }
  if (!Array.isArray(value.parts) || value.parts.length === 0 || value.parts.length > 32) {
    throw new LiveIpcValidationError('parts has an invalid length');
  }
  const parts = value.parts.map(validateRefinementPart);
  const assetIds = new Set<string>();
  for (let index = 1; index < parts.length; index += 1) {
    if (parts[index].timelineStartMs < parts[index - 1].timelineStartMs) {
      throw new LiveIpcValidationError('parts must be sorted by timelineStartMs');
    }
  }
  for (const part of parts) {
    if (assetIds.has(part.assetId)) {
      throw new LiveIpcValidationError('parts must reference unique assets');
    }
    assetIds.add(part.assetId);
  }
  return {
    meetingId: value.meetingId,
    idempotencyKey: value.idempotencyKey,
    sourceTranscriptVersionId: value.sourceTranscriptVersionId,
    manifestChecksum: value.manifestChecksum.toLowerCase(),
    contentType: value.contentType,
    ...(value.knownSpeakerCount === undefined
      ? {}
      : { knownSpeakerCount: value.knownSpeakerCount }),
    parts,
  };
}

export function validateJobId(value: unknown): string {
  assertSafeId(value, 'jobId');
  return value;
}

export function validateMeetingId(value: unknown): string {
  assertSafeId(value, 'meetingId');
  return value;
}

export function validateExternalSourceUrl(value: unknown): string {
  assertBoundedString(value, 'url', 4096);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LiveIpcValidationError('url is invalid');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname) {
    throw new LiveIpcValidationError('Only HTTP and HTTPS source URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new LiveIpcValidationError('Source URLs cannot contain credentials');
  }
  return parsed.href;
}

export interface TrustedLiveSenderOptions {
  isKnownWebContents: (webContents: WebContents) => boolean;
  isTrustedUrl: (url: string) => boolean;
}

export function assertTrustedLiveSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  options: TrustedLiveSenderOptions
): number {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) {
    throw new Error('Live operation denied');
  }
  if (!options.isKnownWebContents(event.sender) || !options.isTrustedUrl(frame.url)) {
    throw new Error('Live operation denied');
  }
  return event.sender.id;
}
