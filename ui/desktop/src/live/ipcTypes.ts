export const LIVE_IPC_CHANNELS = {
  getSnapshot: 'obelus-live:get-snapshot',
  getSupportStatus: 'obelus-live:get-support-status',
  getGatewayAuthenticationStatus: 'obelus-live:get-gateway-authentication-status',
  signInGateway: 'obelus-live:sign-in-gateway',
  signOutGateway: 'obelus-live:sign-out-gateway',
  start: 'obelus-live:start',
  audioPort: 'obelus-live:audio-port',
  pause: 'obelus-live:pause',
  resume: 'obelus-live:resume',
  stop: 'obelus-live:stop',
  acknowledgeAudioAssetsPersisted: 'obelus-live:acknowledge-audio-assets-persisted',
  getSttSession: 'obelus-live:get-stt-session',
  completeSttSession: 'obelus-live:complete-stt-session',
  getLocalSttSupport: 'obelus-live:get-local-stt-support',
  startLocalStt: 'obelus-live:start-local-stt',
  appendLocalSttAudio: 'obelus-live:append-local-stt-audio',
  stopLocalStt: 'obelus-live:stop-local-stt',
  submitClaimDetection: 'obelus-live:submit-claim-detection',
  submitFactCheck: 'obelus-live:submit-fact-check',
  pollFactCheck: 'obelus-live:poll-fact-check',
  escalateFactCheck: 'obelus-live:escalate-fact-check',
  submitRefinement: 'obelus-live:submit-refinement',
  pollRefinement: 'obelus-live:poll-refinement',
  deleteRemoteMeeting: 'obelus-live:delete-remote-meeting',
  deleteLocalMeetingAssets: 'obelus-live:delete-local-meeting-assets',
  getAudioPlaybackUrl: 'obelus-live:get-audio-playback-url',
  openSource: 'obelus-live:open-source',
  snapshot: 'obelus-live:snapshot',
  selection: 'obelus-live:selection',
} as const;

export type LiveMeetingMode = 'call' | 'in_person';
export type LiveStreamingStrategy = 'mixed_diarized' | 'source_separated';
export type LiveAudioSourceKind = 'microphone' | 'system' | 'mixed';
export type LiveCaptureLifecycle =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'complete'
  | 'interrupted'
  | 'error';
export type LiveCaptureSourceState =
  | 'unavailable'
  | 'requesting'
  | 'ready'
  | 'active'
  | 'muted'
  | 'ended'
  | 'error';

export interface LiveCaptureError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface LiveCaptureStartConfig {
  meetingId: string;
  mode: LiveMeetingMode;
  strategy: LiveStreamingStrategy;
  microphoneDeviceId?: string;
  includeSystemAudio: boolean;
  title?: string;
}

export interface LiveAudioMeter {
  rms: number;
  peak: number;
}

export interface LiveAudioFrame {
  meetingId: string;
  captureSessionId: string;
  sequence: number;
  meetingTimeMs: number;
  durationMs: number;
  sampleRate: 16000;
  channels: 1;
  pcm: Partial<Record<LiveAudioSourceKind, ArrayBuffer>>;
  meters: Partial<Record<LiveAudioSourceKind, LiveAudioMeter>>;
  workletDroppedFrames: number;
}

export interface LiveAppendAudioResult {
  accepted: boolean;
  duplicate: boolean;
  droppedFrames: number;
}

export interface LiveAudioPortRequest {
  requestId: number;
  frame: LiveAudioFrame;
}

export type LiveAudioPortResponse =
  | { requestId: number; ok: true; result: LiveAppendAudioResult }
  | { requestId: number; ok: false; error: string };

export type LiveTimelineEventKind =
  | 'pause'
  | 'resume'
  | 'sleep'
  | 'wake'
  | 'capture_gap'
  | 'device_change'
  | 'stt_reconnect_gap';

export interface LiveTimelineEvent {
  id: string;
  kind: LiveTimelineEventKind;
  startMs: number;
  endMs?: number;
  sourceKind?: LiveAudioSourceKind;
  droppedFrames?: number;
}

export interface LiveAudioAsset {
  assetId: string;
  meetingId: string;
  sourceKind: LiveAudioSourceKind;
  relativePath: string;
  format: 'wav';
  sampleRate: 16000;
  channels: 1;
  durationMs: number;
  bytes: number;
  checksumSha256: string;
  timelineStartMs: number;
  timelineEndMs: number;
  status: 'finalized' | 'interrupted';
}

export interface LiveAudioAssetAcknowledgement {
  meetingId: string;
  assets: Array<{
    assetId: string;
    checksumSha256: string;
  }>;
}

export interface LiveCaptureSourceSnapshot {
  state: LiveCaptureSourceState;
  meter: LiveAudioMeter;
  bytesWritten: number;
  droppedFrames: number;
}

export interface LiveRecoveredMeeting {
  meetingId: string;
  assets: LiveAudioAsset[];
}

export interface LiveCaptureSnapshot {
  lifecycle: LiveCaptureLifecycle;
  meetingId: string | null;
  ownerWebContentsId: number | null;
  mode: LiveMeetingMode | null;
  strategy: LiveStreamingStrategy | null;
  includeSystemAudio: boolean;
  startedAtEpochMs: number | null;
  elapsedMs: number;
  pausedAtMs: number | null;
  sources: Record<LiveAudioSourceKind, LiveCaptureSourceSnapshot>;
  timelineEvents: LiveTimelineEvent[];
  finalizedAssets: LiveAudioAsset[];
  recoveredMeetings: LiveRecoveredMeeting[];
  lastError: LiveCaptureError | null;
}

export type MediaPermissionState =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

export type LiveFactCheckMode = 'subscription_web' | 'local_wikimedia' | 'hosted';

export interface GatewayAuthenticationStatus {
  configured: boolean;
  authenticated: boolean;
  expiresAtEpochMs?: number;
  reason?: string;
}

export interface LiveSupportStatus {
  platform: string;
  systemVersion: string;
  macosVersion: string | null;
  microphoneOnlySupported: boolean;
  fullCallCaptureSupported: boolean;
  systemAudioRequiresHealthCheck: boolean;
  microphonePermission: MediaPermissionState;
  systemAudioPermission: MediaPermissionState;
  gatewayAvailable: boolean;
  gatewayUnavailableReason?: string;
  localSttAvailable: boolean;
  localSttModel?: string;
  localSttUnavailableReason?: string;
  localFactCheckMode: LiveFactCheckMode;
  localFactCheckAvailable: boolean;
  localFactCheckModel?: string;
  localFactCheckEvidenceScope?: string;
  localFactCheckUnavailableReason?: string;
  directFactCheckFallbackEnabled: boolean;
  callUnavailableReason?: string;
}

export interface SttSessionRequest {
  meetingId: string;
  idempotencyKey: string;
  strategy: LiveStreamingStrategy;
  sourceKind: LiveAudioSourceKind;
  maxSessionSeconds?: number;
}

export interface SttSessionResponse {
  sessionId: string;
  websocketUrl: string;
  token: string;
  expiresAtEpochMs: number;
  model: string;
  configuration: Record<string, string | number | boolean | null>;
}

export interface SttSessionCompleteRequest {
  meetingId: string;
  providerSessionId?: string;
  sessionDurationSeconds?: number;
  audioDurationSeconds?: number;
  endedReason: 'terminated' | 'rotated' | 'disconnected' | 'error';
}

export interface GatewayTranscriptTurn {
  id: string;
  speakerId: string | null;
  startMs: number;
  endMs: number;
  text: string;
  sourceKind?: LiveAudioSourceKind;
}

export interface ClaimDetectionRequest {
  meetingId: string;
  idempotencyKey: string;
  turns: GatewayTranscriptTurn[];
  contextTurns?: GatewayTranscriptTurn[];
  requiredTurnIds?: string[];
  existingClaimKeys?: string[];
  manual?: boolean;
  manualSelection?: string;
}

export interface ClaimDetectionResponse {
  candidates: unknown[];
  catchingUp: boolean;
}

export interface FactCheckSubmitRequest {
  meetingId: string;
  claimId: string;
  claimVersionId: string;
  idempotencyKey: string;
  exactQuote: string;
  normalizedClaim: string;
  contextTurns: GatewayTranscriptTurn[];
  requiredTurnIds?: string[];
  origin: 'automatic' | 'manual';
  timeSensitive?: boolean;
  consequenceScore?: number;
  autoEscalate?: boolean;
}

export type FactCheckStage = 'quick' | 'deep';
export type FactCheckBackend = 'hosted' | 'direct';
export type FactCheckEscalationReason = 'user' | 'policy';

export interface RefinementInputPart {
  assetId: string;
  sourceKind: LiveAudioSourceKind;
  checksumSha256: string;
  timelineStartMs: number;
  timelineEndMs: number;
  providerInputStartMs: number;
  providerInputEndMs: number;
}

export interface RefinementSubmitRequest {
  meetingId: string;
  idempotencyKey: string;
  sourceTranscriptVersionId: string;
  manifestChecksum: string;
  contentType: 'audio/wav' | 'audio/x-wav';
  knownSpeakerCount?: number;
  parts: RefinementInputPart[];
}

export type GatewayJobStatus =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface GatewayJobResponse<TResult = unknown> {
  jobId: string;
  status: GatewayJobStatus;
  result?: TResult;
  error?: LiveCaptureError;
  usage?: unknown[];
  cost?: unknown;
  evidence?: unknown[];
  provenance?: unknown[];
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  expiresAt?: string;
  backend?: FactCheckBackend;
  remoteStage?: string;
  policyVersion?: string;
  contractVersion?: string;
  escalation?: {
    recommended: boolean;
    requested: boolean;
    reasons: string[];
    unresolvedSubquestions: string[];
  };
}

export interface GatewayDeleteResponse {
  meetingId: string;
  status: 'pending' | 'complete' | 'partial' | 'failed';
  cleanupJobId?: string;
  alreadyDeleted?: boolean;
  gatewayCleanup?: 'pending' | 'complete' | 'failed';
  providerCleanup?: 'pending' | 'complete' | 'partial' | 'unsupported' | 'failed';
  limitation?: string;
}

export interface LocalAssetDeleteResponse {
  status: 'complete' | 'failed';
  error?: string;
}

export interface LiveSelectionRequest {
  text: string;
  source: 'context-menu';
  capturedAtEpochMs: number;
  factCheckMode?: LiveFactCheckMode;
  anchor?: { x: number; y: number };
}

export interface LiveElectronApi {
  getSnapshot: () => Promise<LiveCaptureSnapshot>;
  getSupportStatus: () => Promise<LiveSupportStatus>;
  getGatewayAuthenticationStatus: () => Promise<GatewayAuthenticationStatus>;
  signInGateway: () => Promise<GatewayAuthenticationStatus>;
  signOutGateway: () => Promise<GatewayAuthenticationStatus>;
  start: (config: LiveCaptureStartConfig) => Promise<LiveCaptureSnapshot>;
  appendAudio: (frame: LiveAudioFrame) => Promise<LiveAppendAudioResult>;
  pause: () => Promise<LiveCaptureSnapshot>;
  resume: () => Promise<LiveCaptureSnapshot>;
  stop: () => Promise<LiveCaptureSnapshot>;
  acknowledgeAudioAssetsPersisted: (
    acknowledgement: LiveAudioAssetAcknowledgement
  ) => Promise<void>;
  getSttSession: (request: SttSessionRequest) => Promise<SttSessionResponse>;
  completeSttSession: (sessionId: string, request: SttSessionCompleteRequest) => Promise<void>;
  getLocalSttSupport: import('./localSttProtocol').LocalSttClient['getLocalSttSupport'];
  startLocalStt: import('./localSttProtocol').LocalSttClient['startLocalStt'];
  appendLocalSttAudio: import('./localSttProtocol').LocalSttClient['appendLocalSttAudio'];
  stopLocalStt: import('./localSttProtocol').LocalSttClient['stopLocalStt'];
  submitClaimDetection: (request: ClaimDetectionRequest) => Promise<ClaimDetectionResponse>;
  submitFactCheck: (
    stage: FactCheckStage,
    request: FactCheckSubmitRequest
  ) => Promise<GatewayJobResponse<unknown>>;
  pollFactCheck: (
    meetingId: string,
    jobId: string,
    stage?: FactCheckStage
  ) => Promise<GatewayJobResponse<unknown>>;
  escalateFactCheck: (
    meetingId: string,
    checkId: string,
    idempotencyKey: string,
    reason: FactCheckEscalationReason,
    unresolvedSubquestions?: string[]
  ) => Promise<GatewayJobResponse<unknown>>;
  submitRefinement: (request: RefinementSubmitRequest) => Promise<GatewayJobResponse<unknown>>;
  pollRefinement: (meetingId: string, jobId: string) => Promise<GatewayJobResponse<unknown>>;
  deleteRemoteMeeting: (meetingId: string) => Promise<GatewayDeleteResponse>;
  deleteLocalMeetingAssets: (meetingId: string) => Promise<LocalAssetDeleteResponse>;
  getAudioPlaybackUrl: (meetingId: string, assetId: string) => Promise<string>;
  openSource: (url: string) => Promise<void>;
  subscribeSnapshot: (callback: (snapshot: LiveCaptureSnapshot) => void) => () => void;
  subscribeSelection: (callback: (selection: LiveSelectionRequest) => void) => () => void;
}
