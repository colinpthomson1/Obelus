export type MeetingMode = 'call' | 'in_person' | 'text';
export type ArtifactType = 'meeting' | 'text_check';
export type LiveStrategy = 'mixed_diarized' | 'source_separated';

export type MeetingLifecycle =
  | 'setup'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'finalizing'
  | 'complete'
  | 'interrupted'
  | 'error';

export type CaptureSourceState =
  | 'unavailable'
  | 'requesting'
  | 'ready'
  | 'active'
  | 'muted'
  | 'ended'
  | 'error';

export type SttState =
  | 'disconnected'
  | 'connecting'
  | 'streaming'
  | 'reconnecting'
  | 'finalizing'
  | 'closed'
  | 'error';

export type GatewayState = 'unavailable' | 'connecting' | 'ready' | 'degraded' | 'error';

export type RefinementState =
  | 'not_started'
  | 'queued'
  | 'uploading'
  | 'processing'
  | 'reconciling'
  | 'complete'
  | 'retry_wait'
  | 'failed'
  | 'cancelled';

export type TranscriptVersionKind = 'live' | 'refined';
export type TranscriptTurnState = 'partial' | 'final' | 'revised' | 'superseded';
export type SourceKind = 'microphone' | 'system' | 'mixed' | 'text';
export type TimelineEventKind =
  | 'pause'
  | 'resume'
  | 'sleep'
  | 'wake'
  | 'capture_gap'
  | 'device_change'
  | 'stt_reconnect_gap';

export type ClaimOrigin = 'automatic' | 'manual';
export type ClaimLifecycle =
  | 'detected'
  | 'queued'
  | 'quick_running'
  | 'preliminary'
  | 'deep_running'
  | 'complete'
  | 'stale'
  | 'rechecking'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export type ResearchJobState =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'complete'
  | 'failed'
  | 'cancelled';

export type Verdict = 'Supported' | 'Disputed' | 'Needs context' | 'Unverified';

export type LegacyVerdict =
  | 'Supported'
  | 'Mostly supported'
  | 'Mixed'
  | 'Unsupported'
  | 'Unverifiable';

export type AssessmentResolution = 'resolved' | 'unresolved';
export type EvidenceRelation = 'supports' | 'contradicts' | 'qualified' | 'conflicts' | 'none';

export type Confidence = 'Low' | 'Medium' | 'High';
export type AssessmentStage = 'preliminary' | 'deep';
export type EvidenceStance = 'supports' | 'contradicts' | 'context';

export interface TypedError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface MeterState {
  rms: number;
  peak: number;
  active: boolean;
  silentForMs: number;
}

export interface CaptureSourceStatus {
  state: CaptureSourceState;
  meter: MeterState;
  deviceId?: string;
  label?: string;
  droppedFrames: number;
  error?: TypedError;
}

export interface TimedWord {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  speakerLabel?: string;
  confidence?: number;
  final: boolean;
}

export interface Speaker {
  id: string;
  defaultLabel: string;
  displayName?: string;
  displayNameSource: 'generic' | 'manual';
  manualAssignmentLocked: boolean;
  sourceHint?: SourceKind;
}

export interface TranscriptTurn {
  id: string;
  meetingId: string;
  transcriptVersionId: string;
  provider: string;
  providerSessionId: string;
  providerTurnId: string;
  providerTurnOrder: number;
  revision: number;
  status: TranscriptTurnState;
  speakerId?: string;
  provisionalSpeakerLabel?: string;
  sourceKind: SourceKind;
  startMs: number;
  endMs: number;
  text: string;
  words: TimedWord[];
  utteranceBoundary: boolean;
  endOfTurn: boolean;
  formatted: boolean;
  receivedAtMs: number;
  finalizedAtMs?: number;
}

export interface TranscriptVersion {
  id: string;
  meetingId: string;
  kind: TranscriptVersionKind;
  status: 'active' | 'processing' | 'complete' | 'failed';
  revision: number;
  provider?: string;
  model?: string;
  parentVersionId?: string;
  gatewayJobId?: string;
  detectedLanguage?: string;
  speechModelUsed?: string;
  createdAt: string;
  completedAt?: string;
  error?: TypedError;
}

export interface TimelineEvent {
  id: string;
  meetingId: string;
  kind: TimelineEventKind;
  startMs: number;
  endMs?: number;
  sourceKind?: SourceKind;
  providerSessionId?: string;
  label?: string;
}

export interface EvidenceSource {
  id: string;
  citationKey: string;
  url: string;
  canonicalUrl: string;
  publisher: string;
  title: string;
  publicationDate?: string;
  accessedAt: string;
  excerpt: string;
  retrievalKind?: 'search_snippet' | 'page_extract';
  stance: EvidenceStance;
  qualityScore: number;
  qualityRationale: string;
}

export interface Assessment {
  id: string;
  claimVersionId: string;
  stage: AssessmentStage;
  attempt: number;
  status: ResearchJobState;
  current: boolean;
  verdict?: Verdict;
  resolution?: AssessmentResolution;
  evidenceRelation?: EvidenceRelation;
  confidence?: Confidence;
  conclusion?: string;
  support: string[];
  contradiction: string[];
  caveats: string[];
  limitations: string[];
  citations: {
    conclusion: string[];
    support: string[][];
    contradiction: string[][];
    caveats: string[][];
    limitations: string[][];
  };
  sources: EvidenceSource[];
  provider?: string;
  model?: string;
  policyVersion?: string;
  contractVersion?: string;
  changeExplanation?: string;
  changeExplanationCitations?: string[];
  escalationRecommended?: boolean;
  escalationReasons?: string[];
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  error?: TypedError;
}

export interface ClaimVersion {
  id: string;
  claimId: string;
  version: number;
  predecessorId?: string;
  successorId?: string;
  sourceTranscriptVersionId?: string;
  exactQuote: string;
  normalizedClaim: string;
  speakerId?: string;
  startMs?: number;
  endMs?: number;
  segmentIds: string[];
  selectionRationale?: string;
  consequenceScore?: number;
  disputeScore?: number;
  specificityScore?: number;
  timeSensitive?: boolean;
  lifecycle: 'active' | 'stale' | 'rechecking' | 'superseded';
  parentManualRequestId?: string;
  createdAt: string;
  assessments: Assessment[];
}

export interface Claim {
  id: string;
  meetingId: string;
  manualRequestId?: string;
  origin: ClaimOrigin;
  duplicateKey: string;
  status: ClaimLifecycle;
  currentVersionId: string;
  versions: ClaimVersion[];
  spokenAtMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface AudioAsset {
  id: string;
  meetingId: string;
  sourceKind: Exclude<SourceKind, 'text'>;
  timelinePart: number;
  format: 'wav' | 'pcm_s16le';
  sampleRate: number;
  channels: number;
  timelineStartMs: number;
  timelineEndMs?: number;
  durationMs?: number;
  bytes?: number;
  checksum?: string;
  status: 'recording' | 'finalized' | 'interrupted';
}

export interface ResearchJob {
  id: string;
  claimVersionId: string;
  stage: AssessmentStage;
  gatewayJobId?: string;
  idempotencyKey: string;
  status: ResearchJobState;
  attemptCount: number;
  nextRetryAtMs?: number;
  startedAtMs?: number;
  completedAtMs?: number;
  error?: TypedError;
}

export interface ClaimGateTurnSnapshot {
  id: string;
  speakerId?: string;
  startMs: number;
  endMs: number;
  text: string;
  revision: number;
  sourceKind: SourceKind;
}

export interface PendingClaimGateBatch {
  id: string;
  meetingId: string;
  idempotencyKey: string;
  turns: ClaimGateTurnSnapshot[];
  createdAtMs: number;
}

export type ManualFactCheckRequestStatus =
  | 'queued'
  | 'processing'
  | 'retry_wait'
  | 'complete'
  | 'failed';

export interface ManualFactCheckRequest {
  id: string;
  meetingId: string;
  exactSelection: string;
  contextTurns: ClaimGateTurnSnapshot[];
  sourceSegmentIds: string[];
  speakerId?: string;
  startMs?: number;
  endMs?: number;
  status: ManualFactCheckRequestStatus;
  error?: TypedError;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RefinementJob {
  id: string;
  meetingId: string;
  sourceTranscriptVersionId: string;
  inputManifestChecksum: string;
  provider: string;
  model: string;
  gatewayJobId?: string;
  idempotencyKey: string;
  status: RefinementState;
  attemptCount: number;
  nextRetryAtMs?: number;
  startedAtMs?: number;
  completedAtMs?: number;
  error?: TypedError;
}

export interface MeetingArtifact {
  id: string;
  title: string;
  artifactType: ArtifactType;
  mode: MeetingMode;
  status: MeetingLifecycle;
  strategy: LiveStrategy;
  startedAtMs?: number;
  endedAtMs?: number;
  createdAt: string;
  updatedAt: string;
  liveTranscriptVersionId?: string;
  canonicalTranscriptVersionId?: string;
  refinementStatus: RefinementState;
  researchStatus: ResearchJobState;
  versions: TranscriptVersion[];
  turns: TranscriptTurn[];
  speakers: Speaker[];
  timeline: TimelineEvent[];
  claims: Claim[];
  manualFactCheckRequests: ManualFactCheckRequest[];
  pendingClaimGateSegmentIds: string[];
  pendingClaimGateBatches: PendingClaimGateBatch[];
  audioAssets: AudioAsset[];
  researchJobs: ResearchJob[];
  refinementJobs: RefinementJob[];
  error?: TypedError;
}

export interface MeetingSummary {
  id: string;
  title: string;
  artifactType: ArtifactType;
  mode: MeetingMode;
  status: MeetingLifecycle;
  startedAtMs?: number;
  durationMs?: number;
  speakerNames: string[];
  claimCount: number;
  completedResearchCount: number;
  refinementStatus: RefinementState;
  updatedAt: string;
}

export interface LiveSetup {
  title: string;
  mode: Extract<MeetingMode, 'call' | 'in_person'>;
  microphoneDeviceId?: string;
  speakerNames: [string, string];
  strategy: LiveStrategy;
  micOnly: boolean;
}

export interface RuntimeSnapshot {
  meetingId?: string;
  lifecycle: MeetingLifecycle;
  startedAtMs?: number;
  elapsedMs: number;
  pausedAtMs?: number;
  microphone: CaptureSourceStatus;
  system: CaptureSourceStatus;
  stt: SttState;
  gateway: GatewayState;
  refinement: RefinementState;
  activeProviderSessions: string[];
  error?: TypedError;
}

export interface LiveMeetingState {
  setup: LiveSetup;
  runtime: RuntimeSnapshot;
  artifact?: MeetingArtifact;
  activeTurns: Record<string, TranscriptTurn>;
  turnOrder: string[];
  viewVersion: TranscriptVersionKind;
  followingLive: boolean;
  unseenFinalTurns: number;
  selectedClaimId?: string;
  claimRailOpen: boolean;
  backpressure: boolean;
  backpressureReason?: 'gateway' | 'limit';
  error?: TypedError;
}

export interface ProviderBeginEvent {
  type: 'begin';
  providerSessionId: string;
  requestedModel: string;
  configuredModel: string;
  expiresAtMs?: number;
}

export interface ProviderTurnEvent {
  type: 'turn';
  providerSessionId: string;
  turnId: string;
  turnOrder: number;
  revision: number;
  transcript: string;
  speakerLabel?: string;
  words: TimedWord[];
  startMs: number;
  endMs: number;
  utteranceBoundary: boolean;
  endOfTurn: boolean;
  turnIsFormatted: boolean;
  durableFinal: boolean;
  receivedAtMs: number;
}

export interface ProviderSpeakerRevisionEvent {
  type: 'speaker_revision';
  providerSessionId: string;
  revisions: Array<{
    turnOrder: number;
    speakerLabel: string;
    words: TimedWord[];
  }>;
}

export interface ProviderTerminationEvent {
  type: 'termination';
  providerSessionId: string;
  sessionDurationSeconds?: number;
  audioDurationSeconds?: number;
}

export interface ProviderErrorEvent {
  type: 'error';
  providerSessionId?: string;
  error: TypedError;
}

export type StreamingTranscriptionEvent =
  | ProviderBeginEvent
  | ProviderTurnEvent
  | ProviderSpeakerRevisionEvent
  | ProviderTerminationEvent
  | ProviderErrorEvent;

export function transcriptTurnKey(providerSessionId: string, turnId: string): string {
  return `${providerSessionId}:${turnId}`;
}

export function stableLiveUuid(scope: string): string {
  return uuidv5(`obelus-live:${scope}`, LIVE_UUID_NAMESPACE);
}

export function currentClaimVersion(claim: Claim): ClaimVersion | undefined {
  return claim.versions.find((version) => version.id === claim.currentVersionId);
}

export function speakerName(speaker: Speaker | undefined, provisional?: string): string {
  if (speaker?.displayName) return speaker.displayName;
  if (speaker?.defaultLabel) return speaker.defaultLabel;
  if (provisional && provisional !== 'UNKNOWN') return provisional;
  return 'Identifying speaker…';
}
import { v5 as uuidv5 } from 'uuid';

const LIVE_UUID_NAMESPACE = 'c6467531-d6b0-4ab3-82d9-8b433531e9d8';
