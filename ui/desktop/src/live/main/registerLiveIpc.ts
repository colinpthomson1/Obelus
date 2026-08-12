import type { IpcMain, MessagePortMain } from 'electron';
import type {
  FactCheckStage,
  FactCheckBackend,
  FactCheckSubmitRequest,
  GatewayJobResponse,
  GatewayAuthenticationStatus,
  LiveAudioAssetAcknowledgement,
  LiveAudioPortRequest,
  LiveAudioPortResponse,
  LiveSelectionRequest,
  LiveAudioSourceKind,
  LiveSupportStatus,
} from '../ipcTypes';
import { LIVE_IPC_CHANNELS } from '../ipcTypes';
import type { LiveAudioAssetStore } from './AudioAssetWriter';
import type { GatewayClient } from './GatewayClient';
import type { LiveCaptureCoordinator } from './LiveCaptureCoordinator';
import {
  assertSafeId,
  assertTrustedLiveSender,
  type TrustedLiveSenderOptions,
  validateAudioFrame,
  validateExternalSourceUrl,
  validateFactCheckEscalationReason,
  validateFactCheckRequest,
  validateFactCheckStage,
  validateIdempotencyKey,
  validateJobId,
  validateMeetingId,
  validateRefinementRequest,
  validateStartConfig,
  validateSttSessionCompleteRequest,
  validateSttSessionRequest,
  validateClaimDetectionRequest,
  validateUnresolvedSubquestions,
} from './ipcValidation';
import {
  LOCAL_STT_SAMPLE_RATE,
  type LocalSttAppendRequest,
  type LocalSttAppendResult,
  type LocalSttStartRequest,
  type LocalSttStartResponse,
  type LocalSttStopRequest,
  type LocalSttStopResult,
  type LocalSttSupport,
} from '../localSttProtocol';
import {
  isLocalFactCheckJobId,
  type LocalFactCheckAssessmentResult,
  type LocalFactCheckClient,
  type LocalFactCheckSupport,
} from '../localFactCheckProtocol';

interface LocalSttServiceBoundary {
  checkSupport(): Promise<LocalSttSupport>;
  startSession(request: LocalSttStartRequest): Promise<LocalSttStartResponse>;
  appendAudio(request: LocalSttAppendRequest): LocalSttAppendResult | Promise<LocalSttAppendResult>;
  stopSession(request: LocalSttStopRequest): Promise<LocalSttStopResult>;
  releaseMeeting(meetingId: string): void | Promise<void>;
}

interface LocalFactCheckServiceBoundary extends Pick<
  LocalFactCheckClient,
  | 'factCheckMode'
  | 'checkSupport'
  | 'detectClaims'
  | 'submitFactCheck'
  | 'pollFactCheck'
  | 'releaseMeeting'
> {
  checkSupport(): Promise<LocalFactCheckSupport>;
  submitFactCheck(
    stage: FactCheckStage,
    request: FactCheckSubmitRequest
  ): Promise<GatewayJobResponse<LocalFactCheckAssessmentResult>>;
}

export interface RegisterLiveIpcOptions {
  ipcMain: IpcMain;
  coordinator: LiveCaptureCoordinator;
  gateway: GatewayClient;
  gatewayIdentity?: {
    getAuthenticationStatus(): GatewayAuthenticationStatus;
    signIn(): Promise<GatewayAuthenticationStatus>;
    signOut(): Promise<GatewayAuthenticationStatus>;
  };
  localStt?: LocalSttServiceBoundary;
  localFactCheck?: LocalFactCheckServiceBoundary;
  factCheckRouting?: {
    preferred: FactCheckBackend;
    allowDirectFallback: boolean;
  };
  audioStore: LiveAudioAssetStore;
  sender: TrustedLiveSenderOptions;
  getSupportStatus: () => Promise<LiveSupportStatus>;
  openExternalSource: (url: string) => Promise<void>;
  getAudioPlaybackUrl: (meetingId: string, assetId: string) => Promise<string>;
}

export interface LiveIpcRegistration {
  releaseSender(senderId: number): Promise<void>;
}

interface AudioPortConnection {
  port: MessagePortMain;
  queue: Promise<void>;
  pending: number;
  accepting: boolean;
}

const MAX_PENDING_AUDIO_FRAMES = 16;
const LIVE_ERROR_PREFIX = 'OBELUS_LIVE_ERROR:';

export function registerLiveIpc(options: RegisterLiveIpcOptions): LiveIpcRegistration {
  const sttSessionOwners = new Map<string, { meetingId: string; senderId: number }>();
  const localSttSessionOwners = new Map<string, { meetingId: string; senderId: number }>();
  const factCheckJobOwners = new Map<string, { meetingId: string; senderId: number }>();
  const refinementJobOwners = new Map<string, { meetingId: string; senderId: number }>();
  const audioConnections = new Map<number, AudioPortConnection>();
  const localStt = () => {
    if (!options.localStt) throw new Error('Local transcription is unavailable');
    return options.localStt;
  };
  const localFactCheck = () => {
    if (!options.localFactCheck) throw new Error('Local fact-checking is unavailable');
    return options.localFactCheck;
  };
  const factCheckRouting = options.factCheckRouting ?? {
    preferred: options.localFactCheck ? ('direct' as const) : ('hosted' as const),
    allowDirectFallback: false,
  };
  const directFallbackBeforeHostedRequest = async (): Promise<boolean> => {
    if (!factCheckRouting.allowDirectFallback || !options.localFactCheck) return false;
    const health = await options.gateway.checkHealth();
    return !health.available;
  };
  const handle = (
    channel: string,
    callback: (senderId: number, ...args: unknown[]) => unknown | Promise<unknown>
  ) => {
    options.ipcMain.handle(channel, async (event, ...args) => {
      const senderId = assertTrustedLiveSender(event, options.sender);
      try {
        return await callback(senderId, ...args);
      } catch (error) {
        throw safeIpcError(error);
      }
    });
  };

  handle(LIVE_IPC_CHANNELS.getSnapshot, () => options.coordinator.getSnapshot());
  handle(LIVE_IPC_CHANNELS.getSupportStatus, () => options.getSupportStatus());
  handle(LIVE_IPC_CHANNELS.getGatewayAuthenticationStatus, () =>
    options.gatewayIdentity
      ? options.gatewayIdentity.getAuthenticationStatus()
      : {
          configured: false,
          authenticated: false,
          reason: 'Hosted research sign-in is not configured.',
        }
  );
  handle(LIVE_IPC_CHANNELS.signInGateway, () => {
    if (!options.gatewayIdentity) throw new Error('Hosted research sign-in is not configured');
    return options.gatewayIdentity.signIn();
  });
  handle(LIVE_IPC_CHANNELS.signOutGateway, () => {
    if (!options.gatewayIdentity) throw new Error('Hosted research sign-in is not configured');
    return options.gatewayIdentity.signOut();
  });
  handle(LIVE_IPC_CHANNELS.getLocalSttSupport, () =>
    options.localStt
      ? options.localStt.checkSupport()
      : {
          available: false,
          model: 'base.en' as const,
          reason: 'Local transcription is unavailable.',
        }
  );
  handle(LIVE_IPC_CHANNELS.start, async (senderId, config) => {
    const snapshot = await options.coordinator.start(validateStartConfig(config), senderId);
    const connection = audioConnections.get(senderId);
    if (connection) connection.accepting = true;
    return snapshot;
  });
  handle(LIVE_IPC_CHANNELS.pause, async (senderId) => {
    const connection = audioConnections.get(senderId);
    if (connection) {
      connection.accepting = false;
      await connection.queue;
    }
    return await options.coordinator.pause(senderId);
  });
  handle(LIVE_IPC_CHANNELS.resume, async (senderId) => {
    const snapshot = await options.coordinator.resume(senderId);
    const connection = audioConnections.get(senderId);
    if (connection) connection.accepting = true;
    return snapshot;
  });
  handle(LIVE_IPC_CHANNELS.stop, async (senderId) => {
    const connection = audioConnections.get(senderId);
    if (connection) {
      connection.accepting = false;
      await connection.queue;
    }
    return await options.coordinator.stop(senderId);
  });
  handle(LIVE_IPC_CHANNELS.acknowledgeAudioAssetsPersisted, async (senderId, acknowledgement) => {
    const validated = validateAudioAssetAcknowledgement(acknowledgement);
    options.coordinator.assertMeetingOwner(validated.meetingId, senderId);
    await options.audioStore.acknowledgeAudioAssetsPersisted(validated);
    options.coordinator.acknowledgeAudioAssetsPersisted(validated.meetingId);
  });
  handle(LIVE_IPC_CHANNELS.getSttSession, async (senderId, request) => {
    const validated = validateSttSessionRequest(request);
    options.coordinator.assertMeetingOwner(validated.meetingId, senderId);
    const response = await options.gateway.getSttSession(validated);
    sttSessionOwners.set(response.sessionId, { meetingId: validated.meetingId, senderId });
    return response;
  });
  handle(LIVE_IPC_CHANNELS.completeSttSession, async (senderId, sessionId, request) => {
    assertSafeId(sessionId, 'sessionId');
    const validated = validateSttSessionCompleteRequest(request);
    options.coordinator.assertMeetingOwner(validated.meetingId, senderId);
    assertScopedSessionOwner(sttSessionOwners, sessionId, validated.meetingId, senderId);
    await options.gateway.completeSttSession(sessionId, validated);
    sttSessionOwners.delete(sessionId);
  });
  handle(LIVE_IPC_CHANNELS.startLocalStt, async (senderId, request) => {
    const validated = validateLocalSttStartRequest(request);
    options.coordinator.assertMeetingOwner(validated.meetingId, senderId);
    const response = await localStt().startSession(validated);
    assertSafeId(response.sessionId, 'sessionId');
    assertSafeId(response.providerSessionId, 'providerSessionId');
    localSttSessionOwners.set(response.sessionId, {
      meetingId: validated.meetingId,
      senderId,
    });
    return response;
  });
  handle(LIVE_IPC_CHANNELS.appendLocalSttAudio, async (senderId, request) => {
    const validated = validateLocalSttAppendRequest(request);
    options.coordinator.assertMeetingOwner(validated.meetingId, senderId);
    assertOwnedLocalSttSession(
      localSttSessionOwners,
      validated.sessionId,
      validated.meetingId,
      senderId
    );
    return localStt().appendAudio(validated);
  });
  handle(LIVE_IPC_CHANNELS.stopLocalStt, async (senderId, request) => {
    const validated = validateLocalSttStopRequest(request);
    options.coordinator.assertMeetingOwner(validated.meetingId, senderId);
    assertOwnedLocalSttSession(
      localSttSessionOwners,
      validated.sessionId,
      validated.meetingId,
      senderId
    );
    try {
      return await localStt().stopSession(validated);
    } finally {
      localSttSessionOwners.delete(validated.sessionId);
    }
  });
  handle(LIVE_IPC_CHANNELS.submitClaimDetection, async (senderId, request) => {
    const validated = validateClaimDetectionRequest(request);
    options.coordinator.assertMeetingOwner(validated.meetingId, senderId);
    if (
      factCheckRouting.preferred === 'direct' &&
      validated.manual !== true &&
      options.localFactCheck?.factCheckMode === 'subscription_web'
    ) {
      const foreground = options.coordinator.getSnapshot().meetingId === validated.meetingId;
      return options.localFactCheck.detectClaims(validated, foreground);
    }
    if (
      factCheckRouting.preferred === 'hosted' &&
      validated.manual !== true &&
      options.localFactCheck?.factCheckMode === 'subscription_web' &&
      (await directFallbackBeforeHostedRequest())
    ) {
      const foreground = options.coordinator.getSnapshot().meetingId === validated.meetingId;
      return options.localFactCheck.detectClaims(validated, foreground);
    }
    return options.gateway.submitClaimDetection(validated);
  });
  handle(LIVE_IPC_CHANNELS.submitFactCheck, async (senderId, stage, request) => {
    const validated = validateFactCheckRequest(request);
    options.coordinator.assertMeetingOwner(validated.meetingId, senderId);
    const validatedStage = validateFactCheckStage(stage);
    const useDirect =
      factCheckRouting.preferred === 'direct' ||
      (factCheckRouting.preferred === 'hosted' && (await directFallbackBeforeHostedRequest()));
    const response = useDirect
      ? {
          ...(await localFactCheck().submitFactCheck(validatedStage, validated)),
          backend: 'direct' as const,
        }
      : await options.gateway.submitFactCheck(validatedStage, validated);
    factCheckJobOwners.set(response.jobId, { meetingId: validated.meetingId, senderId });
    return response;
  });
  handle(LIVE_IPC_CHANNELS.pollFactCheck, (senderId, meetingId, jobId, stage) => {
    const validatedMeetingId = validateMeetingId(meetingId);
    const validatedJobId = validateJobId(jobId);
    const validatedStage = stage === undefined ? 'quick' : validateFactCheckStage(stage);
    options.coordinator.assertMeetingOwner(validatedMeetingId, senderId);
    assertScopedResourceOwner(factCheckJobOwners, validatedJobId, validatedMeetingId, senderId);
    return isLocalFactCheckJobId(validatedJobId)
      ? localFactCheck()
          .pollFactCheck(validatedMeetingId, validatedJobId)
          .then((response) => ({ ...response, backend: 'direct' as const }))
      : options.gateway.pollFactCheck(validatedJobId, validatedStage);
  });
  handle(
    LIVE_IPC_CHANNELS.escalateFactCheck,
    (senderId, meetingId, checkId, idempotencyKey, reason, unresolvedSubquestions) => {
      const validatedMeetingId = validateMeetingId(meetingId);
      const validatedCheckId = validateJobId(checkId);
      const validatedIdempotencyKey = validateIdempotencyKey(idempotencyKey);
      const validatedReason = validateFactCheckEscalationReason(reason);
      const validatedSubquestions = validateUnresolvedSubquestions(unresolvedSubquestions);
      options.coordinator.assertMeetingOwner(validatedMeetingId, senderId);
      assertScopedResourceOwner(factCheckJobOwners, validatedCheckId, validatedMeetingId, senderId);
      if (isLocalFactCheckJobId(validatedCheckId)) {
        throw new Error('Direct fact-checks cannot be escalated through the hosted gateway.');
      }
      return options.gateway.escalateFactCheck(
        validatedCheckId,
        validatedIdempotencyKey,
        validatedReason,
        validatedSubquestions
      );
    }
  );
  handle(LIVE_IPC_CHANNELS.submitRefinement, async (senderId, request) => {
    const validated = validateRefinementRequest(request);
    options.coordinator.assertMeetingOwner(validated.meetingId, senderId);
    const response = await options.gateway.submitRefinement(validated);
    refinementJobOwners.set(response.jobId, { meetingId: validated.meetingId, senderId });
    return response;
  });
  handle(LIVE_IPC_CHANNELS.pollRefinement, (senderId, meetingId, jobId) => {
    const validatedMeetingId = validateMeetingId(meetingId);
    const validatedJobId = validateJobId(jobId);
    options.coordinator.assertMeetingOwner(validatedMeetingId, senderId);
    assertScopedResourceOwner(refinementJobOwners, validatedJobId, validatedMeetingId, senderId);
    return options.gateway.pollRefinement(validatedJobId);
  });
  handle(LIVE_IPC_CHANNELS.deleteRemoteMeeting, (senderId, meetingId) => {
    const validatedMeetingId = validateMeetingId(meetingId);
    options.coordinator.assertMeetingOwner(validatedMeetingId, senderId);
    if (factCheckRouting.preferred === 'direct' && options.localFactCheck) {
      if (options.localFactCheck.factCheckMode === 'subscription_web') {
        return {
          meetingId: validatedMeetingId,
          status: 'partial' as const,
          gatewayCleanup: 'complete' as const,
          providerCleanup: 'unsupported' as const,
          limitation:
            'ChatGPT does not expose per-operation deletion for claim identification or fact-checking through this subscription session; provider retention follows the signed-in ChatGPT workspace policy. Local deletion is reported separately.',
        };
      }
      return {
        meetingId: validatedMeetingId,
        status: 'complete' as const,
        gatewayCleanup: 'complete' as const,
        providerCleanup: 'complete' as const,
      };
    }
    return options.gateway.deleteRemoteMeeting(validatedMeetingId);
  });
  handle(LIVE_IPC_CHANNELS.deleteLocalMeetingAssets, async (senderId, meetingId) => {
    const validatedMeetingId = validateMeetingId(meetingId);
    options.coordinator.assertMeetingOwner(validatedMeetingId, senderId);
    const cleanup = await Promise.allSettled([
      options.audioStore.deleteMeetingAssets(validatedMeetingId),
      options.localFactCheck?.releaseMeeting(validatedMeetingId),
    ]);
    if (cleanup.every((result) => result.status === 'fulfilled')) {
      options.coordinator.clearFinalizedMeeting(validatedMeetingId);
      return { status: 'complete' as const };
    }
    return {
      status: 'failed' as const,
      error: 'Obelus could not remove one or more local meeting files.',
    };
  });
  handle(LIVE_IPC_CHANNELS.getAudioPlaybackUrl, (senderId, meetingId, assetId) => {
    const validatedMeetingId = validateMeetingId(meetingId);
    assertSafeId(assetId, 'assetId');
    options.coordinator.assertMeetingOwner(validatedMeetingId, senderId);
    return options.getAudioPlaybackUrl(validatedMeetingId, assetId);
  });
  handle(LIVE_IPC_CHANNELS.openSource, async (_senderId, url) => {
    await options.openExternalSource(validateExternalSourceUrl(url));
  });

  options.ipcMain.on(LIVE_IPC_CHANNELS.audioPort, (event) => {
    let senderId: number;
    try {
      senderId = assertTrustedLiveSender(event, options.sender);
    } catch {
      event.ports.forEach((port) => port.close());
      return;
    }
    const port = event.ports[0];
    if (!port || event.ports.length !== 1) {
      event.ports.forEach((candidate) => candidate.close());
      return;
    }

    audioConnections.get(senderId)?.port.close();
    const snapshot = options.coordinator.getSnapshot();
    const connection: AudioPortConnection = {
      port,
      queue: Promise.resolve(),
      pending: 0,
      accepting:
        snapshot.ownerWebContentsId === senderId &&
        (snapshot.lifecycle === 'starting' || snapshot.lifecycle === 'recording'),
    };
    audioConnections.set(senderId, connection);
    port.on('message', (messageEvent) => {
      const request = parseAudioPortRequest(messageEvent.data);
      if (!request) {
        port.close();
        return;
      }
      if (!connection.accepting) {
        postAudioResponse(port, {
          requestId: request.requestId,
          ok: true,
          result: { accepted: false, duplicate: false, droppedFrames: 0 },
        });
        return;
      }
      if (connection.pending >= MAX_PENDING_AUDIO_FRAMES) {
        postAudioResponse(port, {
          requestId: request.requestId,
          ok: false,
          error: 'The local audio queue is full',
        });
        return;
      }

      connection.pending += 1;
      connection.queue = connection.queue
        .then(async () => {
          try {
            const result = await options.coordinator.appendAudio(
              validateAudioFrame(request.frame),
              senderId
            );
            postAudioResponse(port, { requestId: request.requestId, ok: true, result });
          } catch (error) {
            postAudioResponse(port, {
              requestId: request.requestId,
              ok: false,
              error: safeIpcError(error).message,
            });
          }
        })
        .finally(() => {
          connection.pending -= 1;
        });
    });
    port.on('close', () => {
      if (audioConnections.get(senderId)?.port === port) audioConnections.delete(senderId);
    });
    port.start();
  });

  return {
    async releaseSender(senderId) {
      const connection = audioConnections.get(senderId);
      if (connection) {
        connection.accepting = false;
        await connection.queue;
      }
      deleteOwnedResources(sttSessionOwners, senderId, (owner) => owner.senderId);
      const localMeetingIds = new Set(
        [...localSttSessionOwners.values()]
          .filter((owner) => owner.senderId === senderId)
          .map((owner) => owner.meetingId)
      );
      deleteOwnedResources(localSttSessionOwners, senderId, (owner) => owner.senderId);
      await Promise.allSettled(
        [...localMeetingIds].map((meetingId) => options.localStt?.releaseMeeting(meetingId))
      );
      deleteOwnedResources(factCheckJobOwners, senderId, (owner) => owner.senderId);
      deleteOwnedResources(refinementJobOwners, senderId, (owner) => owner.senderId);
      connection?.port.close();
      audioConnections.delete(senderId);
    },
  };
}

function validateLocalSttStartRequest(value: unknown): LocalSttStartRequest {
  const record = objectRecord(value, 'Local transcription start request');
  const meetingId = validateMeetingId(record.meetingId);
  const sourceKind = validateLocalSttSourceKind(record.sourceKind);
  if (record.sampleRate !== LOCAL_STT_SAMPLE_RATE) {
    throw new Error('Local transcription sampleRate must be 16000');
  }
  return { meetingId, sourceKind, sampleRate: LOCAL_STT_SAMPLE_RATE };
}

function validateAudioAssetAcknowledgement(value: unknown): LiveAudioAssetAcknowledgement {
  const record = objectRecord(value, 'Audio acknowledgement');
  const meetingId = validateMeetingId(record.meetingId);
  if (!Array.isArray(record.assets) || record.assets.length === 0 || record.assets.length > 3) {
    throw new Error('Audio acknowledgement assets are invalid');
  }
  const seen = new Set<string>();
  const assets = record.assets.map((entry) => {
    const asset = objectRecord(entry, 'Audio acknowledgement asset');
    assertSafeId(asset.assetId, 'assetId');
    if (typeof asset.checksumSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.checksumSha256)) {
      throw new Error('Audio acknowledgement checksum is invalid');
    }
    if (seen.has(asset.assetId)) {
      throw new Error('Audio acknowledgement contains duplicate assets');
    }
    seen.add(asset.assetId);
    return { assetId: asset.assetId, checksumSha256: asset.checksumSha256 };
  });
  return { meetingId, assets };
}

function validateLocalSttAppendRequest(value: unknown): LocalSttAppendRequest {
  const record = objectRecord(value, 'Local transcription audio request');
  const meetingId = validateMeetingId(record.meetingId);
  assertSafeId(record.sessionId, 'sessionId');
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0) {
    throw new Error('Local transcription sequence must be a non-negative integer');
  }
  if (
    !(record.pcm instanceof ArrayBuffer) ||
    record.pcm.byteLength === 0 ||
    record.pcm.byteLength > 32_000 ||
    record.pcm.byteLength % 2 !== 0
  ) {
    throw new Error('Local transcription audio must be a bounded PCM ArrayBuffer');
  }
  return {
    meetingId,
    sessionId: record.sessionId as string,
    sequence: record.sequence as number,
    pcm: record.pcm,
  };
}

function validateLocalSttStopRequest(value: unknown): LocalSttStopRequest {
  const record = objectRecord(value, 'Local transcription stop request');
  const meetingId = validateMeetingId(record.meetingId);
  assertSafeId(record.sessionId, 'sessionId');
  return { meetingId, sessionId: record.sessionId as string };
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateLocalSttSourceKind(value: unknown): LiveAudioSourceKind {
  if (value !== 'microphone' && value !== 'system' && value !== 'mixed') {
    throw new Error('Local transcription sourceKind is invalid');
  }
  return value;
}

function assertOwnedLocalSttSession(
  owners: Map<string, { meetingId: string; senderId: number }>,
  sessionId: string,
  meetingId: string,
  senderId: number
): void {
  const owner = owners.get(sessionId);
  if (!owner || owner.senderId !== senderId || owner.meetingId !== meetingId) {
    throw new Error('Local transcription session is not owned by this meeting and window');
  }
}

function parseAudioPortRequest(value: unknown): LiveAudioPortRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.requestId) ||
    (record.requestId as number) < 0 ||
    !('frame' in record)
  ) {
    return null;
  }
  return {
    requestId: record.requestId as number,
    frame: record.frame as LiveAudioPortRequest['frame'],
  };
}

function postAudioResponse(port: MessagePortMain, response: LiveAudioPortResponse): void {
  try {
    port.postMessage(response);
  } catch {
    port.close();
  }
}

function deleteOwnedResources<TOwner>(
  owners: Map<string, TOwner>,
  senderId: number,
  getSenderId: (owner: TOwner) => number
): void {
  for (const [resourceId, owner] of owners) {
    if (getSenderId(owner) === senderId) owners.delete(resourceId);
  }
}

function assertScopedResourceOwner(
  owners: Map<string, { meetingId: string; senderId: number }>,
  resourceId: string,
  meetingId: string,
  senderId: number
): void {
  const owner = owners.get(resourceId);
  if (owner && (owner.senderId !== senderId || owner.meetingId !== meetingId)) {
    throw new Error('Live operation is owned by another meeting or window');
  }
  owners.set(resourceId, { meetingId, senderId });
}

function assertScopedSessionOwner(
  owners: Map<string, { meetingId: string; senderId: number }>,
  sessionId: string,
  meetingId: string,
  senderId: number
): void {
  const owner = owners.get(sessionId);
  if (owner && (owner.senderId !== senderId || owner.meetingId !== meetingId)) {
    throw new Error('Streaming session is owned by another meeting or window');
  }
  owners.set(sessionId, { meetingId, senderId });
}

export function createLiveSelectionRequest(
  selectionText: string,
  now: () => number = Date.now,
  anchor?: { x: number; y: number }
): LiveSelectionRequest | null {
  const text = selectionText.trim();
  if (!text) return null;
  const safeAnchor =
    anchor &&
    Number.isFinite(anchor.x) &&
    Number.isFinite(anchor.y) &&
    anchor.x >= 0 &&
    anchor.y >= 0
      ? anchor
      : undefined;
  return {
    text: text.slice(0, 4_000),
    source: 'context-menu',
    capturedAtEpochMs: now(),
    ...(safeAnchor ? { anchor: safeAnchor } : {}),
  };
}

function safeIpcError(error: unknown): Error {
  const message = error instanceof Error ? error.message : 'Live operation failed';
  if (message.length > 1_000 || /bearer\s|token=|api[_-]?key/i.test(message)) {
    return new Error('Live operation failed');
  }
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; retryable?: unknown };
    if (
      typeof candidate.code === 'string' &&
      candidate.code.length > 0 &&
      candidate.code.length <= 128 &&
      typeof candidate.retryable === 'boolean'
    ) {
      return new Error(
        `${LIVE_ERROR_PREFIX}${JSON.stringify({
          code: candidate.code,
          message,
          retryable: candidate.retryable,
        })}`
      );
    }
  }
  return new Error(message);
}
