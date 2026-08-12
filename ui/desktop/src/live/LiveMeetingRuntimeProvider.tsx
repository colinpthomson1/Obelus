import type {
  MeetingAssessmentApplyDto,
  MeetingClaimVersionUpsertDto,
  MeetingRefinementJobUpsertDto,
  MeetingResearchJobUpsertDto,
  MeetingTranscriptVersionUpsertDto,
} from '@aaif/goose-sdk';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router';
import {
  applyRefinedTranscript,
  applySpeakers,
  applyTimelineEvent,
  confirmMeetingCleanup,
  createMeeting,
  deleteMeeting as deleteMeetingArtifact,
  getMeeting,
  listMeetings,
  persistAudioAssets,
  persistClaimVersions,
  persistRefinementJob,
  persistResearch,
  persistTranscriptTurn,
  recoverMeetingJobs,
  updateMeeting,
} from '../acp/meetings';
import { useLiveAudioCapture } from '../hooks/useLiveAudioCapture';
import {
  AssemblyStreamingAdapter,
  type StreamingSessionConfiguration,
  type StreamingTranscriptionProvider,
} from './assemblyStreamingAdapter';
import { LocalWhisperStreamingAdapter } from './LocalWhisperStreamingAdapter';
import { isLocalFactCheckJobId } from './localFactCheckProtocol';
import { LOCAL_STT_MODEL, LOCAL_STT_SAMPLE_RATE } from './localSttProtocol';
import { routeManualFactCheckSelection } from './manualFactCheckPrivacy';
import { transcriptSelectionFactCheckInputAtAnchor } from './manualFactCheckSelection';
import {
  evidenceRelationForFinding,
  normalizeConfidence,
  normalizeFinding,
  policyRecommendsDeepResearch,
  preferredAssessment,
  resolutionForFinding,
} from './factCheckPolicy';
import {
  automaticClaimIdentity,
  claimGateBatchBeginInput,
  ClaimScheduler,
  detectClaimCandidatesWithLocalFallback,
  expandLocalClaimContext,
  gatewayClaimSchedulerOptions,
  joinTranscriptFragments,
  normalizeManualSelection,
  subscriptionClaimSchedulerOptions,
  type ClaimCandidate,
} from './claimScheduler';
import { initialMeetingState, meetingReducer } from './meetingReducer';
import { reconcileRefinement } from './refinementReconciler';
import { resolveProviderSpeaker, type SpeakerObservation } from './transcriptReconciler';
import type {
  ClaimDetectionRequest,
  FactCheckSubmitRequest,
  GatewayDeleteResponse,
  GatewayJobResponse,
  LiveAudioAsset,
  LiveAudioMeter,
  LiveCaptureSnapshot,
  LiveElectronApi,
  LiveSelectionRequest,
  LiveSupportStatus,
  LiveTimelineEvent,
  RefinementSubmitRequest,
  SttSessionResponse,
  LiveAudioSourceKind,
} from './ipcTypes';
import {
  stableLiveUuid,
  type Assessment,
  type Claim,
  type ClaimGateTurnSnapshot,
  type ClaimVersion,
  type GatewayState,
  type LiveMeetingState,
  type LiveSetup,
  type MeetingArtifact,
  type ManualFactCheckRequest,
  type MeetingSummary,
  type RefinementState,
  type RefinementJob,
  type ResearchJob,
  type SttState,
  type StreamingTranscriptionEvent,
  type TimelineEvent,
  type TranscriptTurn,
  type TranscriptVersionKind,
  type TypedError,
} from './types';

interface LiveSupportView {
  checkingPermissions: boolean;
  systemAudioSupported: boolean;
  systemAudioPermission: LiveSupportStatus['systemAudioPermission'];
  microphonePermission: LiveSupportStatus['microphonePermission'];
  gatewayState: GatewayState;
  gatewayUnavailableReason?: string;
  gatewayAuthentication: import('./ipcTypes').GatewayAuthenticationStatus;
  localSttAvailable: boolean;
  localSttModel?: string;
  localSttUnavailableReason?: string;
  localFactCheckMode: LiveSupportStatus['localFactCheckMode'];
  localFactCheckAvailable: boolean;
  localFactCheckModel?: string;
  localFactCheckEvidenceScope?: string;
  localFactCheckUnavailableReason?: string;
  directFactCheckFallbackEnabled: boolean;
  callUnavailableReason?: string;
}

export interface SelectionFactCheckInput {
  text: string;
  turnIds?: string[];
  speakerId?: string;
  startMs?: number;
  endMs?: number;
  nearbyContext?: string;
  anchor?: { x: number; y: number };
}

interface LiveMeetingRuntimeValue {
  state: LiveMeetingState;
  meetings: MeetingSummary[];
  devices: MediaDeviceInfo[];
  microphoneMeter: LiveAudioMeter;
  systemMeter: LiveAudioMeter;
  support: LiveSupportView;
  setSetup: (patch: Partial<LiveSetup>) => void;
  startMeeting: (micOnly?: boolean) => Promise<void>;
  pauseMeeting: () => Promise<void>;
  resumeMeeting: () => Promise<void>;
  stopMeeting: () => Promise<void>;
  openMeeting: (meetingId: string) => Promise<void>;
  closeArtifact: () => void;
  deleteMeeting: (meetingId: string) => Promise<void>;
  renameSpeaker: (speakerId: string, displayName?: string) => Promise<void>;
  swapSpeakers: (firstSpeakerId: string, secondSpeakerId: string) => Promise<void>;
  factCheckSelection: (selection: SelectionFactCheckInput) => Promise<void>;
  rerunClaim: (claimId: string) => Promise<void>;
  escalateClaim: (claimId: string) => Promise<void>;
  reportClaimProblem: (claimId: string) => void;
  retryRefinement: () => Promise<void>;
  openSource: (url: string) => Promise<void>;
  selectClaim: (claimId?: string) => void;
  setViewVersion: (version: TranscriptVersionKind) => void;
  setFollowingLive: (following: boolean) => void;
  jumpToLive: () => void;
  setClaimRailOpen: (open: boolean) => void;
  refreshDevices: () => Promise<void>;
  testMicrophone: (deviceId?: string) => Promise<void>;
  signInGateway: () => Promise<void>;
  signOutGateway: () => Promise<void>;
}

interface GatewayAssessmentResult {
  stage: 'preliminary' | 'deep';
  originalQuote: string;
  normalizedClaim: string;
  verdict?: string;
  finding?: string;
  resolution?: 'resolved' | 'unresolved';
  evidenceRelation?: 'supports' | 'contradicts' | 'qualified' | 'conflicts' | 'none';
  confidence?: string;
  conclusion: string;
  conclusionCitationIds: string[];
  statements: GatewayCitedStatement[];
  supports: GatewayCitedStatement[];
  contradictions: GatewayCitedStatement[];
  caveats: GatewayCitedStatement[];
  limitations: GatewayCitedStatement[];
  sources: Array<{
    citationId: string;
    stance: 'supports' | 'contradicts' | 'context';
    qualityScore: number;
    qualityRationale: string;
  }>;
  inventory: Array<{
    citationId: string;
    url: string;
    canonicalUrl: string;
    publisher: string;
    title: string;
    publicationDate: string | null;
    accessedAt: string;
    excerpt: string;
    retrievalKind?: 'search_snippet' | 'page_extract';
  }>;
  completedAt: string;
  aiGenerated: true;
  provenance?: {
    provider: string;
    model: string;
    local?: boolean;
    evidenceScope?: string;
  };
  changeExplanation?: string;
  changeExplanationCitationIds?: string[];
  escalationRecommended?: boolean;
  escalationReasons?: string[];
  escalation?: {
    recommended?: boolean;
    requested?: boolean;
    reasons?: string[];
    unresolvedSubquestions?: string[];
  };
  policyVersion?: string;
  contractVersion?: string;
}

const GATEWAY_AUTH_STATUS_TIMER_MAX_DELAY_MS = 60_000;

interface GatewayCitedStatement {
  text: string;
  citationIds: string[];
}

const EVIDENCE_UNAVAILABLE_ERROR: TypedError = {
  code: 'evidence_unavailable',
  message: 'No retrievable evidence was available, so Obelus did not produce a factual finding.',
  retryable: false,
};

interface GatewayRefinementResult {
  detectedLanguage: string | null;
  speechModelUsed: string | null;
  audioDurationSeconds: number | null;
  manifestChecksum: string;
  sourceTranscriptVersionId: string;
  utterances: Array<{
    id: string;
    text: string;
    startMs: number;
    endMs: number;
    speakerLabel: string | null;
    words: Array<{
      text: string;
      startMs: number;
      endMs: number;
      speakerLabel: string | null;
      confidence: number | null;
    }>;
  }>;
}

interface ActiveSttSession {
  meetingId: string;
  sourceKind: LiveAudioSourceKind;
  gatewaySessionId: string;
  providerSessionId: string;
  provider: 'assemblyai' | 'faster_whisper';
  model: string;
  adapter: StreamingTranscriptionProvider;
  startedAtMs: number;
  maxSessionSeconds: number;
  audioDurationSeconds: number;
  meetingTimeOriginMs?: number;
  completed: boolean;
  releasing?: boolean;
}

interface PendingSttFrame {
  frame: ArrayBuffer;
  meetingTimeMs: number;
}

interface QueuedTranscriptWrite {
  revision: number;
  turn: TranscriptTurn;
  execute: () => Promise<void>;
}

const MAX_PENDING_STT_FRAMES = 64;

export async function retryDurableOperation<T>(
  operation: () => Promise<T>,
  retryDelaysMs: readonly number[] = [200, 500, 1_000],
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => window.setTimeout(resolve, delayMs))
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const delayMs = retryDelaysMs[attempt];
      if (delayMs !== undefined) await wait(delayMs);
    }
  }
  throw lastError;
}

export function sttSourcesForCapture(
  strategy: LiveSetup['strategy'],
  includeSystemAudio: boolean
): LiveAudioSourceKind[] {
  if (strategy === 'mixed_diarized') return ['mixed'];
  return includeSystemAudio ? ['microphone', 'system'] : ['microphone'];
}

export function deriveSttState(
  desiredSources: readonly LiveAudioSourceKind[],
  activeSources: ReadonlySet<LiveAudioSourceKind>,
  streamingSources: ReadonlySet<LiveAudioSourceKind>,
  reconnectingSources: ReadonlySet<LiveAudioSourceKind>,
  fallback: SttState = 'disconnected'
): SttState {
  if (desiredSources.length === 0) return fallback;
  if (desiredSources.every((sourceKind) => streamingSources.has(sourceKind))) return 'streaming';
  if (fallback === 'error') return 'error';
  if (reconnectingSources.size > 0) return 'reconnecting';
  if (streamingSources.size > 0 || activeSources.size > 0) {
    return fallback === 'reconnecting' ? 'reconnecting' : 'connecting';
  }
  return fallback;
}

export function canRunSttSession(
  lifecycle: LiveMeetingState['runtime']['lifecycle'],
  suspendedForGap: boolean
): boolean {
  return !suspendedForGap && ['starting', 'recording'].includes(lifecycle);
}

export function gatewayStateAfterSttBegin(
  current: GatewayState,
  provider: 'assemblyai' | 'faster_whisper',
  allSourcesStreaming: boolean
): GatewayState {
  if (provider === 'faster_whisper') return current;
  return allSourcesStreaming ? 'ready' : 'degraded';
}

export function shouldReconnectStt(
  provider: 'assemblyai' | 'faster_whisper',
  retryable: boolean,
  attempt = 0
): boolean {
  return retryable && (provider === 'assemblyai' || attempt < 3);
}

export async function terminateSttProvidersForGap(
  providers: readonly StreamingTranscriptionProvider[]
): Promise<void> {
  await Promise.allSettled(
    providers.map(async (provider) => {
      try {
        await provider.terminate();
      } catch {
        await releaseSttProvider(provider);
      }
    })
  );
}

export async function releaseSttProvider(provider: StreamingTranscriptionProvider): Promise<void> {
  provider.close();
  await provider.waitUntilReleased?.().catch(() => undefined);
}

function captureTimelineLabel(event: LiveTimelineEvent): string {
  switch (event.kind) {
    case 'pause':
      return 'Recording paused';
    case 'resume':
      return 'Recording resumed';
    case 'sleep':
      return 'Computer slept · audio was not captured';
    case 'wake':
      return 'Computer woke · recording resumed';
    case 'capture_gap':
      return event.droppedFrames
        ? `${event.droppedFrames} audio frame${event.droppedFrames === 1 ? '' : 's'} not captured`
        : 'Audio was not captured';
    case 'device_change':
      return 'Audio device changed';
    case 'stt_reconnect_gap':
      return 'Live transcription reconnected · local audio continued';
  }
}

export function timelineEventFromCapture(
  meetingId: string,
  event: LiveTimelineEvent
): TimelineEvent {
  return {
    id: event.id,
    meetingId,
    kind: event.kind,
    startMs: event.startMs,
    endMs: event.endMs,
    sourceKind: event.sourceKind,
    label: captureTimelineLabel(event),
  };
}

export function captureTimelineEventIsDurable(event: LiveTimelineEvent): boolean {
  return Boolean(event.id);
}

export function reconstructArtifactAudioAssets(artifact: MeetingArtifact): LiveAudioAsset[] {
  return artifact.audioAssets.flatMap((asset): LiveAudioAsset[] => {
    if (
      asset.format !== 'wav' ||
      asset.sampleRate !== 16_000 ||
      asset.channels !== 1 ||
      !asset.checksum ||
      asset.timelineEndMs === undefined ||
      asset.bytes === undefined ||
      asset.status === 'recording'
    ) {
      return [];
    }
    return [
      {
        assetId: asset.id,
        meetingId: artifact.id,
        sourceKind: asset.sourceKind,
        relativePath: `${artifact.id}/${asset.sourceKind}.wav`,
        format: 'wav',
        sampleRate: 16_000,
        channels: 1,
        durationMs: asset.durationMs ?? Math.max(0, asset.timelineEndMs - asset.timelineStartMs),
        bytes: asset.bytes,
        checksumSha256: asset.checksum,
        timelineStartMs: asset.timelineStartMs,
        timelineEndMs: asset.timelineEndMs,
        status: asset.status,
      },
    ];
  });
}

export function recoveredAssetsMissingPersistence(
  artifact: MeetingArtifact,
  recoveredAssets: readonly LiveAudioAsset[]
): LiveAudioAsset[] {
  return recoveredAssets.filter((recovered) => {
    const persisted = artifact.audioAssets.find((asset) => asset.id === recovered.assetId);
    return !(
      persisted &&
      persisted.meetingId === recovered.meetingId &&
      persisted.sourceKind === recovered.sourceKind &&
      persisted.format === recovered.format &&
      persisted.sampleRate === recovered.sampleRate &&
      persisted.channels === recovered.channels &&
      persisted.timelineStartMs === recovered.timelineStartMs &&
      persisted.timelineEndMs === recovered.timelineEndMs &&
      persisted.durationMs === recovered.durationMs &&
      persisted.bytes === recovered.bytes &&
      persisted.checksum === recovered.checksumSha256 &&
      persisted.status === recovered.status
    );
  });
}

function audioAssetAcknowledgement(meetingId: string, assets: readonly LiveAudioAsset[]) {
  return {
    meetingId,
    assets: assets.map((asset) => ({
      assetId: asset.assetId,
      checksumSha256: asset.checksumSha256,
    })),
  };
}

export function translateSttEventToMeetingClock(
  event: StreamingTranscriptionEvent,
  meetingTimeOriginMs: number
): StreamingTranscriptionEvent {
  if (meetingTimeOriginMs === 0) return event;
  if (event.type === 'turn') {
    return {
      ...event,
      startMs: event.startMs + meetingTimeOriginMs,
      endMs: event.endMs + meetingTimeOriginMs,
      words: event.words.map((word) => ({
        ...word,
        startMs: word.startMs + meetingTimeOriginMs,
        endMs: word.endMs + meetingTimeOriginMs,
      })),
    };
  }
  if (event.type === 'speaker_revision') {
    return {
      ...event,
      revisions: event.revisions.map((revision) => ({
        ...revision,
        words: revision.words.map((word) => ({
          ...word,
          startMs: word.startMs + meetingTimeOriginMs,
          endMs: word.endMs + meetingTimeOriginMs,
        })),
      })),
    };
  }
  return event;
}

const LiveMeetingRuntimeContext = createContext<LiveMeetingRuntimeValue | undefined>(undefined);

const defaultSupport: LiveSupportView = {
  checkingPermissions: true,
  systemAudioSupported: false,
  systemAudioPermission: 'unknown',
  microphonePermission: 'unknown',
  gatewayState: 'unavailable',
  gatewayAuthentication: {
    configured: false,
    authenticated: false,
    reason: 'Hosted research sign-in is not configured.',
  },
  localSttAvailable: false,
  localFactCheckMode: 'hosted',
  localFactCheckAvailable: false,
  directFactCheckFallbackEnabled: false,
};

function liveApi(): LiveElectronApi | undefined {
  return (window.electron as typeof window.electron & { live?: LiveElectronApi }).live;
}

function sourceSnapshot(source: LiveCaptureSnapshot['sources']['microphone']) {
  return {
    state: source.state,
    meter: {
      rms: source.meter.rms,
      peak: source.meter.peak,
      active: source.state === 'active',
      silentForMs: source.meter.rms > 0.001 ? 0 : 5_000,
    },
    droppedFrames: source.droppedFrames,
  };
}

export function captureLifecycle(
  lifecycle: LiveCaptureSnapshot['lifecycle']
): LiveMeetingState['runtime']['lifecycle'] {
  switch (lifecycle) {
    case 'idle':
      return 'setup';
    default:
      return lifecycle;
  }
}

export function meetingStopTerminalState(
  snapshot: {
    lifecycle: LiveCaptureSnapshot['lifecycle'];
    finalizedAssets: ReadonlyArray<Pick<LiveAudioAsset, 'status'>>;
  },
  transcriptPersistenceFailed: boolean
): {
  lifecycle: Extract<LiveMeetingState['runtime']['lifecycle'], 'complete' | 'interrupted'>;
  captureStatus: 'complete' | 'interrupted';
  refinementStatus: Extract<RefinementState, 'queued' | 'retry_wait'>;
} {
  const captureInterrupted =
    snapshot.lifecycle === 'interrupted' ||
    snapshot.lifecycle === 'error' ||
    snapshot.finalizedAssets.some((asset) => asset.status === 'interrupted');
  return {
    lifecycle: captureInterrupted || transcriptPersistenceFailed ? 'interrupted' : 'complete',
    captureStatus: captureInterrupted ? 'interrupted' : 'complete',
    refinementStatus: transcriptPersistenceFailed ? 'retry_wait' : 'queued',
  };
}

export function reusableFactCheckArtifact(
  selection: Pick<SelectionFactCheckInput, 'turnIds'>,
  state: Pick<LiveMeetingState, 'artifact' | 'runtime'>
): MeetingArtifact | undefined {
  const artifact = state.artifact;
  if (!artifact) return undefined;
  if ((selection.turnIds?.length ?? 0) > 0) return artifact;
  if (state.runtime.meetingId !== artifact.id) return undefined;
  return ['starting', 'recording', 'paused'].includes(state.runtime.lifecycle)
    ? artifact
    : undefined;
}

export function artifactOwnsPresentation(
  state: Pick<LiveMeetingState, 'artifact'>,
  meetingId: string
): boolean {
  return state.artifact?.id === meetingId;
}

export async function resolveCaptureArtifact(
  meetingId: string | null | undefined,
  selectedArtifact: MeetingArtifact | undefined,
  loadArtifact: (meetingId: string) => Promise<MeetingArtifact> = getMeeting
): Promise<MeetingArtifact | undefined> {
  if (!meetingId) return undefined;
  return selectedArtifact?.id === meetingId ? selectedArtifact : await loadArtifact(meetingId);
}

function claimGateTurnSnapshot(turn: TranscriptTurn): ClaimGateTurnSnapshot {
  return {
    id: turn.id,
    speakerId: turn.speakerId,
    startMs: turn.startMs,
    endMs: turn.endMs,
    text: turn.text,
    revision: turn.revision,
    sourceKind: turn.sourceKind,
  };
}

export function manualFactCheckContext(
  artifact: MeetingArtifact,
  selection: SelectionFactCheckInput,
  requestId: string,
  exactSelection: string
): Pick<ManualFactCheckRequest, 'contextTurns' | 'sourceSegmentIds'> {
  const selectedIds = new Set(selection.turnIds ?? []);
  const selectedTurn = artifact.turns.find((turn) => selectedIds.has(turn.id));
  if (selectedTurn) {
    const orderedTurns = artifact.turns
      .filter((turn) => turn.transcriptVersionId === selectedTurn.transcriptVersionId)
      .sort((left, right) => {
        if (left.startMs !== right.startMs) return left.startMs - right.startMs;
        if (left.providerTurnOrder !== right.providerTurnOrder) {
          return left.providerTurnOrder - right.providerTurnOrder;
        }
        return left.id.localeCompare(right.id);
      });
    const selectedIndexes = orderedTurns.flatMap((turn, index) =>
      selectedIds.has(turn.id) ? [index] : []
    );
    const firstIndex = Math.max(0, Math.min(...selectedIndexes) - 1);
    const lastIndex = Math.min(orderedTurns.length - 1, Math.max(...selectedIndexes) + 1);
    return {
      contextTurns: orderedTurns.slice(firstIndex, lastIndex + 1).map(claimGateTurnSnapshot),
      sourceSegmentIds: orderedTurns
        .filter((turn) => selectedIds.has(turn.id))
        .map((turn) => turn.id),
    };
  }
  return {
    contextTurns: [
      {
        id: stableLiveUuid(`manual-selection-turn:${artifact.id}:${requestId}`),
        speakerId: selection.speakerId,
        startMs: selection.startMs ?? 0,
        endMs: selection.endMs ?? selection.startMs ?? 0,
        text: normalizeManualSelection(selection.nearbyContext ?? exactSelection, 20_000),
        revision: 0,
        sourceKind: 'text',
      },
    ],
    sourceSegmentIds: [],
  };
}

function selectedTextWithinTranscriptNode(
  range: ReturnType<typeof document.createRange>,
  node: HTMLElement
): string {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text) textNodes.push(current);
    current = walker.nextNode();
  }
  return textNodes
    .flatMap((textNode) => {
      try {
        if (!range.intersectsNode(textNode)) return [];
      } catch {
        return [];
      }
      const start = textNode === range.startContainer ? range.startOffset : 0;
      const end = textNode === range.endContainer ? range.endOffset : textNode.data.length;
      return [textNode.data.slice(start, end)];
    })
    .join('');
}

export function selectionFactCheckInputFromActiveDom(
  nativeSelection: LiveSelectionRequest,
  state: Pick<LiveMeetingState, 'artifact' | 'activeTurns'>
): SelectionFactCheckInput {
  const fallback = transcriptSelectionFactCheckInputAtAnchor(nativeSelection, state) ?? {
    text: normalizeManualSelection(nativeSelection.text),
  };
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return fallback;
  const range = selection.getRangeAt(0);
  const turnsById = new Map<string, TranscriptTurn>();
  for (const turn of state.artifact?.turns ?? []) turnsById.set(turn.id, turn);
  for (const turn of Object.values(state.activeTurns)) turnsById.set(turn.id, turn);
  const selected = [...document.querySelectorAll<HTMLElement>('[data-turn-id]')]
    .flatMap((element) => {
      const transcript = element.querySelector<HTMLElement>('[data-transcript-text]');
      const turnId = element.dataset.turnId;
      const turn = turnId ? turnsById.get(turnId) : undefined;
      if (!transcript || !turn) return [];
      try {
        if (!range.intersectsNode(transcript)) return [];
      } catch {
        return [];
      }
      return [{ turn, text: selectedTextWithinTranscriptNode(range, transcript) }];
    })
    .slice(0, 12);
  if (selected.length === 0) return fallback;
  const text = normalizeManualSelection(
    selected
      .map((entry) => entry.text)
      .filter(Boolean)
      .reduce((joined, fragment) => joinTranscriptFragments(joined, fragment), '')
  );
  if (!text) return fallback;
  const speakers = new Set(selected.map(({ turn }) => turn.speakerId).filter(Boolean));
  const rect =
    typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : undefined;
  return {
    text,
    turnIds: selected.map(({ turn }) => turn.id),
    speakerId: speakers.size === 1 ? selected[0].turn.speakerId : undefined,
    startMs: Math.min(...selected.map(({ turn }) => turn.startMs)),
    endMs: Math.max(...selected.map(({ turn }) => turn.endMs)),
    nearbyContext: normalizeManualSelection(
      selected
        .map(({ turn }) => turn.text)
        .reduce((joined, fragment) => joinTranscriptFragments(joined, fragment), ''),
      20_000
    ),
    anchor:
      rect && Number.isFinite(rect.left) && Number.isFinite(rect.top)
        ? { x: rect.left + rect.width / 2, y: rect.top }
        : undefined,
  };
}

function manualFactCheckRequestUpsert(
  request: ManualFactCheckRequest,
  status: ManualFactCheckRequest['status'],
  error?: TypedError
) {
  return {
    id: request.id,
    exactSelection: request.exactSelection,
    contextTurns: request.contextTurns.map((turn) => ({
      id: turn.id,
      speakerId: turn.speakerId ?? null,
      startMs: turn.startMs,
      endMs: turn.endMs,
      text: turn.text,
      revisionNumber: turn.revision,
      sourceKind: turn.sourceKind,
    })),
    sourceSegmentIds: request.sourceSegmentIds,
    speakerId: request.speakerId ?? null,
    startMs: request.startMs ?? null,
    endMs: request.endMs ?? null,
    status,
    error: error ?? null,
  };
}

export function manualClaimIdentity(
  meetingId: string,
  manualRequestId: string,
  semanticDuplicateKey: string
): { claimId: string; claimVersionId: string } {
  const claimId = stableLiveUuid(
    `manual-claim:${meetingId}:${manualRequestId}:${semanticDuplicateKey}`
  );
  return {
    claimId,
    claimVersionId: stableLiveUuid(`manual-claim-version:${claimId}:1`),
  };
}

export async function resolveManualClaimCandidates(
  request: ManualFactCheckRequest,
  detected: ClaimCandidate[]
): Promise<ClaimCandidate[]> {
  const fallback: ClaimCandidate = {
    exactQuote: request.exactSelection,
    normalizedClaim: request.exactSelection,
    contextTurnIds: request.sourceSegmentIds,
    speakerId: request.speakerId,
    startMs: request.startMs ?? 0,
    endMs: request.endMs ?? request.startMs ?? 0,
    checkworthy: true,
    consequenceScore: 1,
    disputeLikelihoodScore: 1,
    specificityScore: 1,
    timeSensitive: false,
    selectionRationale: 'Selected manually for fact-checking.',
    semanticDuplicateKey: await sha256(request.exactSelection.toLocaleLowerCase()),
  };
  const candidates = detected.length > 0 ? detected : [fallback];
  return [
    ...new Map(candidates.map((candidate) => [candidate.semanticDuplicateKey, candidate])).values(),
  ].map((candidate) => ({
    ...candidate,
    contextTurnIds: request.sourceSegmentIds,
  }));
}

export async function resolveManualClaimCandidatesWithFallback(
  request: ManualFactCheckRequest,
  detectRemotely: () => Promise<ClaimCandidate[]>
): Promise<ClaimCandidate[]> {
  try {
    return resolveManualClaimCandidates(request, await detectRemotely());
  } catch {
    return resolveManualClaimCandidates(request, []);
  }
}

interface MeetingRecoveryControls {
  acknowledgeStartupReconciliation: () => void;
  isCancelled: () => boolean;
}

interface MeetingRecoveryLoopState {
  startupReconciled: boolean;
  startupReconciliationInFlight: boolean;
}

export function startMeetingRecoveryLoop(
  runPass: (reconcileActiveWork: boolean, controls: MeetingRecoveryControls) => Promise<void>,
  intervalMs = 60_000,
  loopState: MeetingRecoveryLoopState = {
    startupReconciled: false,
    startupReconciliationInFlight: false,
  }
): () => void {
  let cancelled = false;
  let timer: number | undefined;
  const recover = async () => {
    if (!loopState.startupReconciled && loopState.startupReconciliationInFlight) {
      if (!cancelled) timer = window.setTimeout(recover, intervalMs);
      return;
    }
    const reconcileActiveWork = !loopState.startupReconciled;
    if (reconcileActiveWork) loopState.startupReconciliationInFlight = true;
    try {
      await runPass(reconcileActiveWork, {
        acknowledgeStartupReconciliation: () => {
          loopState.startupReconciled = true;
        },
        isCancelled: () => cancelled,
      });
    } catch {
      // The next pass retries the same recovery mode after a bounded delay.
    } finally {
      if (reconcileActiveWork) loopState.startupReconciliationInFlight = false;
      if (!cancelled) timer = window.setTimeout(recover, intervalMs);
    }
  };
  void recover();
  return () => {
    cancelled = true;
    if (timer !== undefined) window.clearTimeout(timer);
  };
}

export async function runExclusiveLiveOperation<T>(
  inFlight: Set<string>,
  operationId: string,
  operation: () => Promise<T>
): Promise<T | undefined> {
  if (inFlight.has(operationId)) return undefined;
  inFlight.add(operationId);
  try {
    return await operation();
  } finally {
    inFlight.delete(operationId);
  }
}

export function resumableRecoveredResearchJob(status: ResearchJob['status']): boolean {
  return status === 'pending' || status === 'running' || status === 'retry_wait';
}

const MAX_AUTOMATIC_RESEARCH_ATTEMPTS = 3;
const MAX_AUTOMATIC_REFINEMENT_ATTEMPTS = 3;
export const FACT_CHECK_POLL_DELAYS_MS = [500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000];

function activeGatewayJob(job: GatewayJobResponse<unknown>): boolean {
  return job.status === 'pending' || job.status === 'running' || job.status === 'retry_wait';
}

async function abortablePollDelay(
  delayMs: number,
  signal?: globalThis.AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve(true);
    }, delayMs);
    const cancel = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(false);
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export async function pollGatewayJobUntilSettled(
  initial: GatewayJobResponse<unknown>,
  poll: (jobId: string) => Promise<GatewayJobResponse<unknown>>,
  options: {
    signal?: globalThis.AbortSignal;
    delaysMs?: readonly number[];
    wait?: (delayMs: number, signal?: globalThis.AbortSignal) => Promise<boolean>;
  } = {}
): Promise<GatewayJobResponse<unknown>> {
  let current = initial;
  const wait = options.wait ?? abortablePollDelay;
  for (const delayMs of options.delaysMs ?? FACT_CHECK_POLL_DELAYS_MS) {
    if (!activeGatewayJob(current) || options.signal?.aborted) break;
    if (!(await wait(delayMs, options.signal))) break;
    if (options.signal?.aborted) break;
    current = await poll(current.jobId);
  }
  return current;
}

export function researchAttemptPlan(
  claimVersionId: string,
  stage: 'quick' | 'deep',
  recoveryJob?: ResearchJob
): {
  attemptCount: number;
  idempotencyKey: string;
  pollJobId?: string;
  startedAtMs: number;
} {
  const resumeExisting =
    recoveryJob !== undefined &&
    (recoveryJob.status === 'pending' ||
      recoveryJob.status === 'running' ||
      recoveryJob.status === 'retry_wait');
  const attemptCount = resumeExisting
    ? Math.max(1, recoveryJob.attemptCount)
    : (recoveryJob?.attemptCount ?? 0) + 1;
  return {
    attemptCount,
    idempotencyKey: resumeExisting
      ? recoveryJob.idempotencyKey
      : `${claimVersionId}:${stage}:${attemptCount}`,
    pollJobId: resumeExisting ? recoveryJob.gatewayJobId : undefined,
    startedAtMs: resumeExisting ? (recoveryJob.startedAtMs ?? Date.now()) : Date.now(),
  };
}

export function researchFailureDisposition(
  error: TypedError,
  attemptCount: number,
  cancelled = false
): {
  status: Extract<ResearchJob['status'], 'retry_wait' | 'failed' | 'cancelled'>;
  nextRetryAtMs: number | null;
  completedAtMs: number | null;
  error: TypedError;
} {
  if (cancelled) {
    return {
      status: 'cancelled',
      nextRetryAtMs: null,
      completedAtMs: Date.now(),
      error: { ...error, retryable: false },
    };
  }
  const retryable = error.retryable && attemptCount < MAX_AUTOMATIC_RESEARCH_ATTEMPTS;
  return {
    status: retryable ? 'retry_wait' : 'failed',
    nextRetryAtMs: retryable ? Date.now() + 5_000 : null,
    completedAtMs: retryable ? null : Date.now(),
    error: { ...error, retryable },
  };
}

type RefinementJobProgressPatch = Partial<
  Pick<
    MeetingRefinementJobUpsertDto,
    'gatewayJobId' | 'status' | 'nextRetryAtMs' | 'usage' | 'latencyMs' | 'completedAtMs' | 'error'
  >
>;

export function refinementFailureDisposition(
  error: TypedError,
  attemptCount: number,
  nowMs = Date.now()
): {
  status: Extract<RefinementJob['status'], 'retry_wait' | 'failed'>;
  nextRetryAtMs: number | null;
  completedAtMs: number | null;
  error: TypedError;
} {
  const retryable = error.retryable && attemptCount < MAX_AUTOMATIC_REFINEMENT_ATTEMPTS;
  return {
    status: retryable ? 'retry_wait' : 'failed',
    nextRetryAtMs: retryable ? nowMs + 5_000 : null,
    completedAtMs: retryable ? null : nowMs,
    error: { ...error, retryable },
  };
}

export async function runDurableRefinementOperation<T>(
  meetingId: string,
  initialJob: MeetingRefinementJobUpsertDto,
  operation: (updateJob: (patch: RefinementJobProgressPatch) => Promise<void>) => Promise<T>,
  persistJob: (
    meetingId: string,
    job: MeetingRefinementJobUpsertDto
  ) => Promise<void> = persistRefinementJob,
  failureFallback = 'Transcript refinement failed; the local recording remains available.',
  now: () => number = Date.now
): Promise<
  | { ok: true; value: T; job: MeetingRefinementJobUpsertDto }
  | {
      ok: false;
      error: TypedError;
      failure: ReturnType<typeof refinementFailureDisposition>;
      job: MeetingRefinementJobUpsertDto;
    }
> {
  let job = initialJob;
  const updateJob = async (patch: RefinementJobProgressPatch) => {
    job = { ...job, ...patch };
    await persistJob(meetingId, job);
  };
  try {
    await updateJob({});
    return { ok: true, value: await operation(updateJob), job };
  } catch (error) {
    const typed = gatewayError(error, failureFallback);
    const failure = refinementFailureDisposition(typed, job.attemptCount, now());
    await updateJob(failure);
    return { ok: false, error: failure.error, failure, job };
  }
}

export function resumableRecoveredRefinementJob(status: RefinementJob['status']): boolean {
  return status === 'queued' || status === 'retry_wait';
}

export function resumableArtifactRefinementWithoutJob(artifact: MeetingArtifact): boolean {
  if (!['complete', 'interrupted'].includes(artifact.status)) return false;
  if (!['queued', 'retry_wait'].includes(artifact.refinementStatus)) return false;
  if (!artifact.liveTranscriptVersionId) return false;
  if (
    artifact.refinementJobs.some((job) =>
      ['queued', 'uploading', 'processing', 'reconciling', 'retry_wait'].includes(job.status)
    )
  ) {
    return false;
  }
  return reconstructArtifactAudioAssets(artifact).some((asset) => asset.sourceKind === 'mixed');
}

export function resumableRecoveredCleanupJob(
  job: {
    localStatus: string;
    gatewayStatus: string;
    providerStatus: string;
  },
  includePending = true
): boolean {
  const statuses = [job.localStatus, job.gatewayStatus, job.providerStatus];
  if (
    statuses.some(
      (status) => !['pending', 'retry_wait', 'complete', 'unavailable'].includes(status)
    )
  ) {
    return false;
  }
  return statuses.some(
    (status) => status === 'retry_wait' || (includePending && status === 'pending')
  );
}

type CleanupStatus = 'complete' | 'retry_wait' | 'running' | 'unavailable';

export function meetingCleanupConfirmation(
  localStatus: 'complete' | 'retry_wait',
  remote?: GatewayDeleteResponse
): {
  localStatus: 'complete' | 'retry_wait';
  gatewayStatus: CleanupStatus;
  providerStatus: CleanupStatus;
  limitation?: string;
  error?: TypedError;
} {
  const gatewayCleanup =
    remote?.gatewayCleanup ??
    (remote?.status === 'complete' || remote?.status === 'partial'
      ? 'complete'
      : remote?.status === 'pending'
        ? 'pending'
        : 'failed');
  const providerCleanup =
    remote?.providerCleanup ??
    (remote?.status === 'partial'
      ? 'partial'
      : remote?.status === 'complete'
        ? 'complete'
        : remote?.status === 'pending'
          ? 'pending'
          : 'failed');
  const gatewayStatus =
    gatewayCleanup === 'complete'
      ? 'complete'
      : gatewayCleanup === 'pending'
        ? 'running'
        : 'retry_wait';
  const providerStatus =
    providerCleanup === 'complete'
      ? 'complete'
      : providerCleanup === 'partial' || providerCleanup === 'unsupported'
        ? 'unavailable'
        : providerCleanup === 'pending'
          ? 'running'
          : 'retry_wait';
  const limitation =
    providerStatus === 'unavailable'
      ? (remote?.limitation ??
        (providerCleanup === 'partial'
          ? 'Some provider-held objects cannot be deleted early under the provider retention policy.'
          : 'This provider does not support early deletion for all retained objects.'))
      : undefined;
  const terminal =
    localStatus === 'complete' &&
    gatewayStatus === 'complete' &&
    (providerStatus === 'complete' || providerStatus === 'unavailable');
  return {
    localStatus,
    gatewayStatus,
    providerStatus,
    limitation,
    error: limitation
      ? {
          code: 'provider_retention_limitation',
          message: limitation,
          retryable: false,
        }
      : terminal
        ? undefined
        : {
            code: 'cleanup_retry_wait',
            message: 'Deletion cleanup remains pending.',
            retryable: true,
          },
  };
}

function gatewayError(
  error: unknown,
  fallback = 'The operation could not be completed.'
): TypedError {
  if (error && typeof error === 'object') {
    const candidate = error as Partial<TypedError>;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return {
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable === true,
      };
    }
  }
  return { code: 'live_operation_failed', message: fallback, retryable: true };
}

export function transcriptVersionUpsert(
  artifact: MeetingArtifact,
  provider: string,
  model?: string
): MeetingTranscriptVersionUpsertDto {
  const version = artifact.versions.find(
    (candidate) => candidate.id === artifact.liveTranscriptVersionId
  );
  return {
    id:
      version?.id ??
      artifact.liveTranscriptVersionId ??
      stableLiveUuid(`live-transcript-version:${artifact.id}`),
    kind: 'live',
    status: 'active',
    revisionNumber: version?.revision ?? 0,
    provider,
    model: model ?? version?.model ?? null,
    gatewayJobId: null,
    parentVersionId: null,
    inputAudioChecksum: null,
    detectedLanguage: null,
    reconciliationMetadata: null,
    startedAtMs: artifact.startedAtMs ?? Date.now(),
    completedAtMs: null,
    error: null,
  };
}

function isClaimCandidate(value: unknown): value is ClaimCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ClaimCandidate>;
  return (
    typeof candidate.exactQuote === 'string' &&
    typeof candidate.normalizedClaim === 'string' &&
    Array.isArray(candidate.contextTurnIds) &&
    typeof candidate.startMs === 'number' &&
    typeof candidate.endMs === 'number' &&
    typeof candidate.checkworthy === 'boolean' &&
    typeof candidate.semanticDuplicateKey === 'string'
  );
}

function isGatewayAssessment(value: unknown): value is GatewayAssessmentResult {
  if (!value || typeof value !== 'object') return false;
  const assessment = value as Partial<GatewayAssessmentResult>;
  return (
    (assessment.stage === 'preliminary' || assessment.stage === 'deep') &&
    typeof assessment.conclusion === 'string' &&
    Array.isArray(assessment.conclusionCitationIds) &&
    Array.isArray(assessment.statements) &&
    Array.isArray(assessment.supports) &&
    Array.isArray(assessment.contradictions) &&
    Array.isArray(assessment.caveats) &&
    Array.isArray(assessment.limitations) &&
    Array.isArray(assessment.inventory) &&
    Array.isArray(assessment.sources) &&
    assessment.aiGenerated === true
  );
}

function isGatewayRefinement(value: unknown): value is GatewayRefinementResult {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray((value as Partial<GatewayRefinementResult>).utterances)
  );
}

export function shouldRunDeepResearch(
  stage: 'quick' | 'deep',
  result: Pick<GatewayAssessmentResult, 'escalation' | 'escalationRecommended'>
): boolean {
  return policyRecommendsDeepResearch(stage, result);
}

async function sha256(value: string): Promise<string> {
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function citedStatements(statements: GatewayCitedStatement[]) {
  return statements.map((statement) => ({
    text: statement.text,
    citationKeys: statement.citationIds,
  }));
}

export function localAssessment(
  claimVersionId: string,
  result: GatewayAssessmentResult,
  attempt: number,
  gatewayJobId: string
): Assessment {
  const evidenceUnavailable = result.inventory.length === 0;
  const finding = normalizeFinding(result.finding ?? result.verdict);
  const confidence = normalizeConfidence(result.confidence);
  const quality = new Map(result.sources.map((source) => [source.citationId, source]));
  const assessmentId = stableLiveUuid(
    `research-assessment:${gatewayJobId}:${result.stage}:${claimVersionId}`
  );
  return {
    id: assessmentId,
    claimVersionId,
    stage: result.stage,
    attempt,
    status: 'complete',
    current: true,
    verdict: finding,
    resolution: result.resolution ?? (finding ? resolutionForFinding(finding) : undefined),
    evidenceRelation:
      result.evidenceRelation ?? (finding ? evidenceRelationForFinding(finding) : undefined),
    confidence,
    conclusion: evidenceUnavailable ? undefined : result.conclusion,
    support: result.supports.map((statement) => statement.text),
    contradiction: result.contradictions.map((statement) => statement.text),
    caveats: result.caveats.map((statement) => statement.text),
    limitations: result.limitations.map((statement) => statement.text),
    citations: {
      conclusion: result.conclusionCitationIds,
      support: result.supports.map((statement) => statement.citationIds),
      contradiction: result.contradictions.map((statement) => statement.citationIds),
      caveats: result.caveats.map((statement) => statement.citationIds),
      limitations: result.limitations.map((statement) => statement.citationIds),
    },
    sources: result.inventory.map((source, index) => {
      const sourceQuality = quality.get(source.citationId);
      return {
        id: stableLiveUuid(
          `research-source:${assessmentId}:${index}:${source.citationId}:${source.canonicalUrl}`
        ),
        citationKey: source.citationId,
        url: source.url,
        canonicalUrl: source.canonicalUrl,
        publisher: source.publisher,
        title: source.title,
        publicationDate: source.publicationDate ?? undefined,
        accessedAt: source.accessedAt,
        excerpt: source.excerpt,
        retrievalKind: source.retrievalKind,
        stance: sourceQuality?.stance ?? 'context',
        qualityScore: sourceQuality?.qualityScore ?? 0,
        qualityRationale: sourceQuality?.qualityRationale ?? 'Source quality was not scored.',
      };
    }),
    policyVersion: result.policyVersion,
    contractVersion: result.contractVersion,
    changeExplanation: result.changeExplanation,
    changeExplanationCitations: result.changeExplanationCitationIds,
    escalationRecommended: result.escalation?.recommended ?? result.escalationRecommended,
    escalationReasons: result.escalation?.reasons ?? result.escalationReasons,
    completedAt: result.completedAt,
    error: evidenceUnavailable ? EVIDENCE_UNAVAILABLE_ERROR : undefined,
  };
}

export function assessmentDto(
  assessment: Assessment,
  result: GatewayAssessmentResult,
  usage: unknown,
  startedAtMs: number,
  setCurrent = true
): MeetingAssessmentApplyDto {
  const evidenceUnavailable = result.inventory.length === 0;
  return {
    id: assessment.id,
    claimVersionId: assessment.claimVersionId,
    stage: assessment.stage,
    attemptNumber: assessment.attempt,
    status: 'complete',
    supersedesId: null,
    verdict:
      assessment.verdict === 'Supported'
        ? 'supported'
        : assessment.verdict === 'Disputed'
          ? 'unsupported'
          : assessment.verdict === 'Needs context'
            ? 'mixed'
            : assessment.verdict === 'Unverified'
              ? 'unverifiable'
              : 'unverifiable',
    confidence:
      assessment.confidence?.toLocaleLowerCase() as MeetingAssessmentApplyDto['confidence'],
    conclusion: evidenceUnavailable
      ? []
      : [{ text: result.conclusion, citationKeys: result.conclusionCitationIds }],
    support: citedStatements(result.supports),
    contradiction: citedStatements(result.contradictions),
    caveats: citedStatements(result.caveats),
    limitations: citedStatements(result.limitations),
    modelProvider: result.provenance?.provider ?? 'anthropic',
    model: result.provenance?.model ?? 'gateway-configured',
    modelVersion: null,
    usage: (usage ?? null) as MeetingAssessmentApplyDto['usage'],
    latencyMs: null,
    startedAtMs,
    completedAtMs: new Date(result.completedAt).getTime(),
    error: evidenceUnavailable ? EVIDENCE_UNAVAILABLE_ERROR : null,
    sources: assessment.sources.map((source) => ({
      id: source.id,
      citationKey: source.citationKey,
      url: source.url,
      canonicalUrl: source.canonicalUrl,
      publisher: source.publisher,
      title: source.title,
      publicationDate: source.publicationDate ?? null,
      accessedAtMs: new Date(source.accessedAt).getTime(),
      evidenceExcerpt: source.excerpt,
      stance: source.stance,
      qualityScore: source.qualityScore,
      qualityRationale: source.qualityRationale,
    })),
    setCurrent,
  };
}

export async function publishAssessmentAfterPersistence(
  persist: () => Promise<MeetingArtifact>,
  claimId: string,
  claimVersionId: string,
  assessmentId: string,
  publish: (assessment: Assessment) => void
): Promise<MeetingArtifact> {
  const artifact = await persist();
  const assessment = artifact.claims
    .find((claim) => claim.id === claimId)
    ?.versions.find((version) => version.id === claimVersionId)
    ?.assessments.find((candidate) => candidate.id === assessmentId);
  if (!assessment || assessment.status !== 'complete') {
    throw new Error('Persisted research response did not contain the completed assessment.');
  }
  publish(assessment);
  return artifact;
}

function claimDraft(
  artifact: MeetingArtifact,
  candidate: ClaimCandidate,
  origin: 'automatic' | 'manual',
  parentManualRequestId?: string,
  identity?: { claimId: string; claimVersionId: string }
): { claim: Claim; version: ClaimVersion; dto: MeetingClaimVersionUpsertDto } {
  const claimId = identity?.claimId ?? window.crypto.randomUUID();
  const versionId = identity?.claimVersionId ?? window.crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const version: ClaimVersion = {
    id: versionId,
    claimId,
    version: 1,
    sourceTranscriptVersionId: artifact.liveTranscriptVersionId,
    exactQuote: candidate.exactQuote,
    normalizedClaim: candidate.normalizedClaim,
    speakerId: candidate.speakerId,
    startMs: candidate.startMs,
    endMs: candidate.endMs,
    segmentIds: candidate.contextTurnIds,
    selectionRationale: candidate.selectionRationale,
    consequenceScore: candidate.consequenceScore,
    disputeScore: candidate.disputeLikelihoodScore,
    specificityScore: candidate.specificityScore,
    timeSensitive: candidate.timeSensitive,
    lifecycle: 'active',
    parentManualRequestId,
    createdAt,
    assessments: [],
  };
  const claim: Claim = {
    id: claimId,
    meetingId: artifact.id,
    manualRequestId: parentManualRequestId,
    origin,
    duplicateKey: parentManualRequestId
      ? `${parentManualRequestId}:${candidate.semanticDuplicateKey}`
      : candidate.semanticDuplicateKey,
    status: 'queued',
    currentVersionId: versionId,
    versions: [version],
    spokenAtMs: candidate.startMs,
    createdAt,
    updatedAt: createdAt,
  };
  return {
    claim,
    version,
    dto: {
      claimId,
      claimVersionId: versionId,
      manualRequestId: parentManualRequestId ?? null,
      origin,
      duplicateKey: claim.duplicateKey,
      status: 'queued',
      versionNumber: 1,
      predecessorId: null,
      supersededById: null,
      sourceTranscriptVersionId: version.sourceTranscriptVersionId ?? null,
      exactQuote: version.exactQuote,
      normalizedClaim: version.normalizedClaim,
      speakerId: version.speakerId ?? null,
      startMs: version.startMs ?? null,
      endMs: version.endMs ?? null,
      segmentIds: version.segmentIds,
      selectionRationale: version.selectionRationale ?? null,
      consequenceScore: version.consequenceScore ?? null,
      disputeScore: version.disputeScore ?? null,
      specificityScore: version.specificityScore ?? null,
      timeSensitive: version.timeSensitive ?? false,
      lifecycle: 'active',
      setCurrent: true,
    },
  };
}

export function refinedTranscriptVersionIdentity(
  meetingId: string,
  gatewayJobId: string,
  manifestChecksum: string
): string {
  return stableLiveUuid(
    `refined-transcript-version:${meetingId}:${gatewayJobId}:${manifestChecksum}`
  );
}

export function refinementClaimVersionDtos(
  artifact: MeetingArtifact,
  refinedVersionId: string,
  refinedTurns: TranscriptTurn[],
  materiallyChangedClaimIds: readonly string[]
): MeetingClaimVersionUpsertDto[] {
  const changedClaimIds = new Set(materiallyChangedClaimIds);
  return artifact.claims.flatMap((claim) => {
    if (!changedClaimIds.has(claim.id)) return [];
    const previous = claim.versions.find((version) => version.id === claim.currentVersionId);
    if (!previous || previous.startMs === undefined || previous.endMs === undefined) return [];
    const overlappingTurns = refinedTurns.filter(
      (turn) =>
        Math.min(turn.endMs, previous.endMs!) - Math.max(turn.startMs, previous.startMs!) > 0
    );
    const refinedQuote = overlappingTurns
      .map((turn) => turn.text)
      .join(' ')
      .trim();
    if (!refinedQuote) return [];
    return [
      {
        claimId: claim.id,
        claimVersionId: stableLiveUuid(
          `refined-claim-version:${refinedVersionId}:${claim.id}:${previous.id}`
        ),
        manualRequestId: claim.manualRequestId ?? previous.parentManualRequestId ?? null,
        origin: claim.origin,
        duplicateKey: claim.duplicateKey,
        status: 'rechecking' as const,
        versionNumber: Math.max(...claim.versions.map((version) => version.version)) + 1,
        predecessorId: previous.id,
        supersededById: null,
        sourceTranscriptVersionId: refinedVersionId,
        exactQuote: refinedQuote,
        normalizedClaim: refinedQuote,
        speakerId: overlappingTurns.find((turn) => turn.speakerId)?.speakerId ?? null,
        startMs: overlappingTurns[0]?.startMs ?? previous.startMs,
        endMs: overlappingTurns[overlappingTurns.length - 1]?.endMs ?? previous.endMs,
        segmentIds: overlappingTurns.map((turn) => turn.id),
        selectionRationale: 'Transcript refinement materially changed the checked wording.',
        consequenceScore: previous.consequenceScore ?? null,
        disputeScore: previous.disputeScore ?? null,
        specificityScore: previous.specificityScore ?? null,
        timeSensitive: previous.timeSensitive ?? false,
        lifecycle: 'rechecking' as const,
        setCurrent: true,
      },
    ];
  });
}

export function LiveMeetingRuntimeProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [state, dispatch] = useReducer(meetingReducer, initialMeetingState);
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [support, setSupport] = useState<LiveSupportView>(defaultSupport);
  const capture = useLiveAudioCapture();
  const stateRef = useRef(state);
  const activeMeetingArtifactRef = useRef<MeetingArtifact | undefined>(undefined);
  const artifactNavigationEpochRef = useRef(0);
  const sttStateRef = useRef<SttState>('disconnected');
  const gatewayStateRef = useRef<GatewayState>('unavailable');
  const gatewayAuthenticationRef = useRef(defaultSupport.gatewayAuthentication);
  const refinementStateRef = useRef<RefinementState>('not_started');
  const activeSttSessionsRef = useRef(new Map<LiveAudioSourceKind, ActiveSttSession>());
  const desiredSttSourcesRef = useRef<LiveAudioSourceKind[]>([]);
  const streamingSttSourcesRef = useRef(new Set<LiveAudioSourceKind>());
  const sttSuspendedForGapRef = useRef(false);
  const rotationTimersRef = useRef(new Map<LiveAudioSourceKind, number>());
  const reconnectTimersRef = useRef(new Map<LiveAudioSourceKind, number>());
  const reconnectAttemptsRef = useRef(new Map<LiveAudioSourceKind, number>());
  const startingSttSourcesRef = useRef(new Set<string>());
  const localSttSourcesRef = useRef(new Set<LiveAudioSourceKind>());
  const stopPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const stopMeetingActionRef = useRef<() => Promise<void>>(async () => undefined);
  const persistedTurnsRef = useRef(new Map<string, number>());
  const pendingTurnWritesRef = useRef(new Set<Promise<void>>());
  const queuedTurnWritesRef = useRef(new Map<string, QueuedTranscriptWrite>());
  const activeTurnWriteIdsRef = useRef(new Set<string>());
  const terminalTurnWriteRevisionsRef = useRef(new Map<string, number>());
  const drainTurnWritesRef = useRef<(turnId: string) => void>(() => undefined);
  const speakerObservationsRef = useRef<SpeakerObservation[]>([]);
  const providerTurnIdsRef = useRef(new Map<string, string>());
  const providerSessionSourcesRef = useRef(new Map<string, LiveAudioSourceKind>());
  const providerSessionModelsRef = useRef(new Map<string, string>());
  const pendingSttFramesRef = useRef(new Map<LiveAudioSourceKind, PendingSttFrame[]>());
  const claimSchedulersRef = useRef(new Map<string, ClaimScheduler>());
  const claimSchedulerArtifactsRef = useRef(new Map<string, MeetingArtifact>());
  const timelineArtifactIdRef = useRef<string | undefined>(undefined);
  const observedTimelineEventsRef = useRef(new Map<string, string>());
  const persistedTimelineEventsRef = useRef(new Map<string, string>());
  const recoverCapturedMeetingsRef = useRef<(snapshot: LiveCaptureSnapshot) => void>(
    () => undefined
  );
  const recoveredMeetingsInFlightRef = useRef(new Set<string>());
  const recoveredMeetingsHandledRef = useRef(new Set<string>());
  const researchJobsInFlightRef = useRef(new Set<string>());
  const refinementJobsInFlightRef = useRef(new Set<string>());
  const refinementMeetingsInFlightRef = useRef(new Set<string>());
  const recoveredCleanupJobsInFlightRef = useRef(new Set<string>());
  const shownCleanupLimitationsRef = useRef(new Set<string>());
  const manualFactCheckRequestsInFlightRef = useRef(new Set<string>());
  const researchPollingAbortRef = useRef(new AbortController());
  const meetingRecoveryLoopStateRef = useRef<MeetingRecoveryLoopState>({
    startupReconciled: false,
    startupReconciliationInFlight: false,
  });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refreshHistory = useCallback(async () => {
    try {
      setMeetings(await listMeetings());
    } catch {
      setMeetings([]);
    }
  }, []);

  const updateRuntime = useCallback((patch: Partial<LiveMeetingState['runtime']>) => {
    const runtime = { ...stateRef.current.runtime, ...patch };
    stateRef.current = { ...stateRef.current, runtime };
    dispatch({ type: 'runtime_updated', snapshot: runtime });
  }, []);

  const applyCaptureSnapshot = useCallback((snapshot: LiveCaptureSnapshot) => {
    const runtime: LiveMeetingState['runtime'] = {
      meetingId: snapshot.meetingId ?? undefined,
      lifecycle: captureLifecycle(snapshot.lifecycle),
      startedAtMs: snapshot.startedAtEpochMs ?? undefined,
      elapsedMs: snapshot.elapsedMs,
      pausedAtMs: snapshot.pausedAtMs ?? undefined,
      microphone: sourceSnapshot(snapshot.sources.microphone),
      system: sourceSnapshot(snapshot.sources.system),
      stt: sttStateRef.current,
      gateway: gatewayStateRef.current,
      refinement: refinementStateRef.current,
      activeProviderSessions: [...activeSttSessionsRef.current.values()].map(
        (session) => session.providerSessionId
      ),
      error: snapshot.lastError ?? undefined,
    };
    stateRef.current = { ...stateRef.current, runtime };
    dispatch({ type: 'runtime_updated', snapshot: runtime });

    const artifact = stateRef.current.artifact;
    if (artifact && snapshot.meetingId === artifact.id) {
      if (timelineArtifactIdRef.current !== artifact.id) {
        timelineArtifactIdRef.current = artifact.id;
        observedTimelineEventsRef.current.clear();
        persistedTimelineEventsRef.current.clear();
        for (const event of artifact.timeline) {
          observedTimelineEventsRef.current.set(event.id, JSON.stringify(event));
          persistedTimelineEventsRef.current.set(event.id, JSON.stringify(event));
        }
      }
      for (const captureEvent of snapshot.timelineEvents) {
        const event = timelineEventFromCapture(artifact.id, captureEvent);
        const fingerprint = JSON.stringify(event);
        if (observedTimelineEventsRef.current.get(event.id) !== fingerprint) {
          observedTimelineEventsRef.current.set(event.id, fingerprint);
          dispatch({ type: 'timeline_added', event });
        }
        const persistedFingerprint = persistedTimelineEventsRef.current.get(event.id);
        if (captureTimelineEventIsDurable(captureEvent) && persistedFingerprint !== fingerprint) {
          persistedTimelineEventsRef.current.set(event.id, fingerprint);
          void applyTimelineEvent(artifact.id, event).catch(() => {
            if (persistedFingerprint === undefined) {
              persistedTimelineEventsRef.current.delete(event.id);
            } else {
              persistedTimelineEventsRef.current.set(event.id, persistedFingerprint);
            }
          });
        }
      }
    }
    recoverCapturedMeetingsRef.current(snapshot);
  }, []);

  useEffect(() => {
    const api = liveApi();
    void refreshHistory();
    if (!api) return;
    const unsubscribeSnapshot = api.subscribeSnapshot(applyCaptureSnapshot);
    const unsubscribeSelection = api.subscribeSelection((selection: LiveSelectionRequest) => {
      routeManualFactCheckSelection({
        selection,
        pathname: location.pathname,
        confirmExternalSend: (message) => window.confirm(message),
        onAccepted: (acceptedSelection) => {
          void factCheckSelectionRef.current(
            selectionFactCheckInputFromActiveDom(acceptedSelection, stateRef.current)
          );
        },
      });
    });
    void api
      .getSnapshot()
      .then(applyCaptureSnapshot)
      .catch(() => undefined);
    return () => {
      unsubscribeSnapshot();
      unsubscribeSelection();
    };
  }, [applyCaptureSnapshot, location.pathname, refreshHistory]);

  useEffect(() => {
    const api = liveApi();
    if (!api || location.pathname !== '/live') return;
    let cancelled = false;
    void Promise.all([api.getSupportStatus(), api.getGatewayAuthenticationStatus()])
      .then(([status, authentication]) => {
        if (cancelled) return;
        gatewayStateRef.current = status.gatewayAvailable ? 'ready' : 'unavailable';
        gatewayAuthenticationRef.current = authentication;
        setSupport({
          checkingPermissions: false,
          systemAudioSupported: status.systemAudioRequiresHealthCheck,
          systemAudioPermission: status.systemAudioPermission,
          microphonePermission: status.microphonePermission,
          gatewayState: gatewayStateRef.current,
          gatewayAuthentication: authentication,
          localSttAvailable: status.localSttAvailable,
          localSttModel: status.localSttModel,
          localSttUnavailableReason: status.localSttUnavailableReason,
          localFactCheckMode: status.localFactCheckMode,
          localFactCheckAvailable: status.localFactCheckAvailable,
          localFactCheckModel: status.localFactCheckModel,
          localFactCheckEvidenceScope: status.localFactCheckEvidenceScope,
          localFactCheckUnavailableReason: status.localFactCheckUnavailableReason,
          directFactCheckFallbackEnabled: status.directFactCheckFallbackEnabled,
          gatewayUnavailableReason: status.gatewayUnavailableReason,
          callUnavailableReason: status.callUnavailableReason,
        });
        updateRuntime({ gateway: gatewayStateRef.current });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [location.pathname, updateRuntime]);

  const applyGatewaySupport = useCallback(async () => {
    const api = liveApi();
    if (!api) return;
    const [status, authentication] = await Promise.all([
      api.getSupportStatus(),
      api.getGatewayAuthenticationStatus(),
    ]);
    gatewayStateRef.current = status.gatewayAvailable ? 'ready' : 'unavailable';
    gatewayAuthenticationRef.current = authentication;
    setSupport((current) => ({
      ...current,
      gatewayState: gatewayStateRef.current,
      gatewayAuthentication: authentication,
      gatewayUnavailableReason: status.gatewayUnavailableReason,
    }));
    updateRuntime({ gateway: gatewayStateRef.current });
  }, [updateRuntime]);

  const signInGateway = useCallback(async () => {
    const api = liveApi();
    if (!api) throw new Error('Hosted research sign-in is unavailable');
    await api.signInGateway();
    await applyGatewaySupport();
  }, [applyGatewaySupport]);

  const signOutGateway = useCallback(async () => {
    const api = liveApi();
    if (!api) throw new Error('Hosted research sign-in is unavailable');
    let signOutFailed = false;
    let signOutError: unknown;
    try {
      await api.signOutGateway();
    } catch (error) {
      signOutFailed = true;
      signOutError = error;
    }
    try {
      await applyGatewaySupport();
    } catch (error) {
      if (!signOutFailed) throw error;
    }
    if (signOutFailed) throw signOutError;
  }, [applyGatewaySupport]);

  useEffect(() => {
    const authentication = support.gatewayAuthentication;
    const expiresAtEpochMs = authentication.expiresAtEpochMs;
    if (
      location.pathname !== '/live' ||
      !authentication.authenticated ||
      !Number.isSafeInteger(expiresAtEpochMs) ||
      !expiresAtEpochMs
    ) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    const markExpired = (reason: string) => {
      if (cancelled || gatewayAuthenticationRef.current.expiresAtEpochMs !== expiresAtEpochMs) {
        return;
      }
      const expiredAuthentication = {
        configured: gatewayAuthenticationRef.current.configured,
        authenticated: false,
        reason,
      };
      gatewayAuthenticationRef.current = expiredAuthentication;
      gatewayStateRef.current = 'unavailable';
      setSupport((current) => ({
        ...current,
        gatewayState: 'unavailable',
        gatewayAuthentication: expiredAuthentication,
        gatewayUnavailableReason: reason,
      }));
      updateRuntime({ gateway: 'unavailable' });
    };
    const refreshAtExpiry = () => {
      const remainingMs = expiresAtEpochMs - Date.now();
      if (remainingMs > 0) {
        timer = window.setTimeout(
          refreshAtExpiry,
          Math.min(remainingMs, GATEWAY_AUTH_STATUS_TIMER_MAX_DELAY_MS)
        );
        return;
      }
      const api = liveApi();
      if (!api) {
        markExpired('Your hosted research session expired. Sign in again.');
        return;
      }
      void api
        .getGatewayAuthenticationStatus()
        .then((currentAuthentication) => {
          if (cancelled || gatewayAuthenticationRef.current.expiresAtEpochMs !== expiresAtEpochMs) {
            return;
          }
          if (
            !currentAuthentication.authenticated ||
            !Number.isSafeInteger(currentAuthentication.expiresAtEpochMs) ||
            !currentAuthentication.expiresAtEpochMs ||
            currentAuthentication.expiresAtEpochMs <= Date.now()
          ) {
            markExpired(
              currentAuthentication.reason ?? 'Your hosted research session expired. Sign in again.'
            );
            return;
          }
          gatewayAuthenticationRef.current = currentAuthentication;
          setSupport((current) => ({
            ...current,
            gatewayAuthentication: currentAuthentication,
          }));
        })
        .catch(() => markExpired('Your hosted research session expired. Sign in again.'));
    };

    refreshAtExpiry();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [location.pathname, support.gatewayAuthentication, updateRuntime]);

  const startTurnWriteDrain = useCallback((turnId: string) => {
    if (activeTurnWriteIdsRef.current.has(turnId)) return;
    activeTurnWriteIdsRef.current.add(turnId);
    const operation = (async () => {
      while (true) {
        const queued = queuedTurnWritesRef.current.get(turnId);
        if (!queued) return;
        queuedTurnWritesRef.current.delete(turnId);
        if ((persistedTurnsRef.current.get(turnId) ?? -1) >= queued.revision) continue;
        try {
          await retryDurableOperation(queued.execute);
          persistedTurnsRef.current.set(turnId, queued.revision);
          terminalTurnWriteRevisionsRef.current.delete(turnId);
          claimSchedulersRef.current.get(queued.turn.meetingId)?.addFinalTurn(queued.turn);
        } catch {
          terminalTurnWriteRevisionsRef.current.set(turnId, queued.revision);
          dispatch({
            type: 'failed',
            error: {
              code: 'transcript_persistence_failed',
              message:
                'A finalized transcript turn could not be saved locally. Obelus will retry before refinement.',
              retryable: true,
            },
          });
          return;
        }
      }
    })();
    const tracked = operation.finally(() => {
      pendingTurnWritesRef.current.delete(tracked);
      activeTurnWriteIdsRef.current.delete(turnId);
      if (queuedTurnWritesRef.current.has(turnId)) drainTurnWritesRef.current(turnId);
    });
    pendingTurnWritesRef.current.add(tracked);
  }, []);
  drainTurnWritesRef.current = startTurnWriteDrain;

  const queueTranscriptTurnWrite = useCallback(
    (artifact: MeetingArtifact, turn: TranscriptTurn, retryTerminal = false) => {
      if ((persistedTurnsRef.current.get(turn.id) ?? -1) >= turn.revision) return;
      if (
        !retryTerminal &&
        (terminalTurnWriteRevisionsRef.current.get(turn.id) ?? -1) >= turn.revision
      ) {
        return;
      }
      if (retryTerminal) terminalTurnWriteRevisionsRef.current.delete(turn.id);
      const existing = queuedTurnWritesRef.current.get(turn.id);
      if (existing && existing.revision > turn.revision) return;
      const sourceKind = providerSessionSourcesRef.current.get(turn.providerSessionId);
      const sourcedTurn = sourceKind ? { ...turn, sourceKind } : turn;
      const transcriptVersion = transcriptVersionUpsert(
        artifact,
        sourcedTurn.provider,
        providerSessionModelsRef.current.get(turn.providerSessionId)
      );
      const observations = speakerObservationsRef.current
        .filter((observation) => observation.providerSessionId === turn.providerSessionId)
        .map((observation) => ({
          id: stableLiveUuid(
            `speaker-observation:${transcriptVersion.id}:${observation.providerSessionId}:${observation.providerLabel}`
          ),
          transcriptVersionId: transcriptVersion.id,
          speakerId: observation.speakerId,
          provider: sourcedTurn.provider,
          providerNamespace: observation.providerSessionId,
          providerSpeakerLabel: observation.providerLabel,
          confidence: null,
          ambiguous: false,
          revisionNumber: turn.revision,
          sourceHint: observation.sourceHint ?? null,
        }));
      queuedTurnWritesRef.current.set(turn.id, {
        revision: turn.revision,
        turn: sourcedTurn,
        execute: () =>
          persistTranscriptTurn(artifact.id, transcriptVersion, sourcedTurn, observations),
      });
      startTurnWriteDrain(turn.id);
    },
    [startTurnWriteDrain]
  );

  useEffect(() => {
    const artifact = activeMeetingArtifactRef.current;
    if (!artifact || state.runtime.meetingId !== artifact.id) return;
    for (const turn of Object.values(state.activeTurns)) {
      if (turn.meetingId !== artifact.id) continue;
      if (turn.status === 'partial') continue;
      queueTranscriptTurnWrite(artifact, turn);
    }
  }, [queueTranscriptTurnWrite, state.activeTurns, state.runtime.meetingId]);

  const completeSttSession = useCallback(
    async (
      session: ActiveSttSession,
      event?: Extract<StreamingTranscriptionEvent, { type: 'termination' }>,
      endedReason: 'terminated' | 'rotated' | 'disconnected' | 'error' = 'terminated'
    ) => {
      if (session.completed) return;
      session.completed = true;
      if (session.provider === 'faster_whisper') return;
      const api = liveApi() as
        | (LiveElectronApi & {
            completeSttSession?: (
              sessionId: string,
              request: Record<string, unknown>
            ) => Promise<unknown>;
          })
        | undefined;
      await api?.completeSttSession?.(session.gatewaySessionId, {
        meetingId: session.meetingId,
        providerSessionId: session.providerSessionId,
        sourceKind: session.sourceKind,
        sessionDurationSeconds:
          event?.sessionDurationSeconds ?? (Date.now() - session.startedAtMs) / 1_000,
        audioDurationSeconds: event?.audioDurationSeconds ?? session.audioDurationSeconds,
        endedReason,
      });
    },
    []
  );

  const setSttState = useCallback(
    (next: SttState) => {
      sttStateRef.current = next;
      updateRuntime({ stt: next });
    },
    [updateRuntime]
  );

  const refreshSttRuntime = useCallback(
    (fallback: SttState = sttStateRef.current) => {
      const next = deriveSttState(
        desiredSttSourcesRef.current,
        new Set(activeSttSessionsRef.current.keys()),
        streamingSttSourcesRef.current,
        new Set(reconnectTimersRef.current.keys()),
        fallback
      );
      sttStateRef.current = next;
      updateRuntime({
        stt: next,
        activeProviderSessions: [...activeSttSessionsRef.current.values()].map(
          (session) => session.providerSessionId
        ),
      });
    },
    [updateRuntime]
  );

  const handleProviderEventRef = useRef<
    (
      sourceKind: LiveAudioSourceKind,
      gatewaySessionId: string,
      event: StreamingTranscriptionEvent
    ) => void
  >(() => undefined);
  const startSttSessionRef = useRef<(sourceKind: LiveAudioSourceKind) => Promise<void>>(
    async () => undefined
  );

  const scheduleReconnect = useCallback(
    (sourceKind: LiveAudioSourceKind) => {
      if (!desiredSttSourcesRef.current.includes(sourceKind)) return;
      if (!canRunSttSession(stateRef.current.runtime.lifecycle, sttSuspendedForGapRef.current)) {
        return;
      }
      if (reconnectTimersRef.current.has(sourceKind)) return;
      const attempt = reconnectAttemptsRef.current.get(sourceKind) ?? 0;
      if (localSttSourcesRef.current.has(sourceKind) && attempt >= 3) {
        refreshSttRuntime('error');
        return;
      }
      reconnectAttemptsRef.current.set(sourceKind, attempt + 1);
      const delay = Math.min(10_000, 1_000 * 2 ** attempt);
      const timer = window.setTimeout(() => {
        reconnectTimersRef.current.delete(sourceKind);
        refreshSttRuntime('reconnecting');
        void startSttSessionRef.current(sourceKind).catch(() => undefined);
      }, delay);
      reconnectTimersRef.current.set(sourceKind, timer);
      refreshSttRuntime('reconnecting');
    },
    [refreshSttRuntime]
  );

  const handleProviderEvent = useCallback(
    (
      sourceKind: LiveAudioSourceKind,
      gatewaySessionId: string,
      rawEvent: StreamingTranscriptionEvent
    ) => {
      const session = activeSttSessionsRef.current.get(sourceKind);
      if (!session || session.gatewaySessionId !== gatewaySessionId) return;
      if (
        stateRef.current.runtime.meetingId &&
        stateRef.current.runtime.meetingId !== session.meetingId
      ) {
        return;
      }
      const event = translateSttEventToMeetingClock(rawEvent, session.meetingTimeOriginMs ?? 0);
      if (event.type === 'begin') {
        session.providerSessionId = event.providerSessionId;
        providerSessionSourcesRef.current.set(event.providerSessionId, sourceKind);
        providerSessionModelsRef.current.set(event.providerSessionId, session.model);
        if (session.provider === 'assemblyai') reconnectAttemptsRef.current.set(sourceKind, 0);
        streamingSttSourcesRef.current.add(sourceKind);
        const allSourcesStreaming = desiredSttSourcesRef.current.every((desiredSource) =>
          streamingSttSourcesRef.current.has(desiredSource)
        );
        if (allSourcesStreaming) {
          dispatch({ type: 'error_cleared' });
        }
        if (session.provider === 'assemblyai') {
          const gatewayState = gatewayStateAfterSttBegin(
            gatewayStateRef.current,
            session.provider,
            allSourcesStreaming
          );
          gatewayStateRef.current = gatewayState;
          setSupport((current) => ({ ...current, gatewayState }));
          updateRuntime({ gateway: gatewayState });
        }
        const pendingFrames = pendingSttFramesRef.current.get(sourceKind) ?? [];
        if (pendingFrames.length > 0) {
          session.meetingTimeOriginMs ??= pendingFrames[0].meetingTimeMs;
          for (const pending of pendingFrames) {
            session.audioDurationSeconds += pending.frame.byteLength / (16_000 * 2);
            session.adapter.sendAudio(pending.frame);
          }
          pendingSttFramesRef.current.delete(sourceKind);
        }
        refreshSttRuntime('connecting');
        return;
      }
      if (event.type === 'turn') {
        if (session.provider === 'faster_whisper') {
          reconnectAttemptsRef.current.set(sourceKind, 0);
        }
        const ownedArtifact = activeMeetingArtifactRef.current;
        if (!ownedArtifact || ownedArtifact.id !== session.meetingId) return;
        const artifact =
          stateRef.current.artifact?.id === session.meetingId
            ? stateRef.current.artifact
            : ownedArtifact;
        const resolution = resolveProviderSpeaker(
          artifact.speakers,
          speakerObservationsRef.current,
          event.providerSessionId,
          event.speakerLabel,
          sourceKind
        );
        if (
          resolution.observation &&
          !speakerObservationsRef.current.includes(resolution.observation)
        ) {
          speakerObservationsRef.current.push(resolution.observation);
        }
        if (resolution.speakers.length !== artifact.speakers.length) {
          dispatch({ type: 'speakers_replaced', speakers: resolution.speakers });
          activeMeetingArtifactRef.current = {
            ...artifact,
            speakers: resolution.speakers,
          };
          stateRef.current = {
            ...stateRef.current,
            artifact: { ...artifact, speakers: resolution.speakers },
          };
          void applySpeakers(artifact.id, resolution.speakers);
        }
        const turnId = stableLiveUuid(`live-turn:${event.providerSessionId}:${event.turnId}`);
        providerTurnIdsRef.current.set(`${event.providerSessionId}:${event.turnOrder}`, turnId);
        dispatch({
          type: 'provider_turn',
          event,
          speakerId: resolution.speaker?.id,
          turnId,
          sourceKind,
          provider: session.provider,
        });
        return;
      }
      if (event.type === 'speaker_revision') {
        dispatch({ type: 'speaker_revision', event });
        const ownedArtifact = activeMeetingArtifactRef.current;
        if (ownedArtifact?.id === session.meetingId) {
          const artifact =
            stateRef.current.artifact?.id === session.meetingId
              ? stateRef.current.artifact
              : ownedArtifact;
          let speakers = artifact.speakers;
          const segmentUpdates: Array<{ segmentId: string; speakerId: string }> = [];
          for (const revision of event.revisions) {
            const resolution = resolveProviderSpeaker(
              speakers,
              speakerObservationsRef.current,
              event.providerSessionId,
              revision.speakerLabel,
              sourceKind
            );
            speakers = resolution.speakers;
            if (
              resolution.observation &&
              !speakerObservationsRef.current.some(
                (observation) =>
                  observation.providerSessionId === resolution.observation!.providerSessionId &&
                  observation.providerLabel === resolution.observation!.providerLabel
              )
            ) {
              speakerObservationsRef.current.push(resolution.observation);
            }
            const turn = Object.values(stateRef.current.activeTurns).find(
              (candidate) =>
                candidate.providerSessionId === event.providerSessionId &&
                candidate.providerTurnOrder === revision.turnOrder
            );
            const turnId =
              turn?.id ??
              providerTurnIdsRef.current.get(`${event.providerSessionId}:${revision.turnOrder}`);
            if (turnId && resolution.speaker) {
              dispatch({
                type: 'turn_relabelled',
                turnId,
                speakerId: resolution.speaker.id,
              });
              if (turn) {
                segmentUpdates.push({ segmentId: turn.id, speakerId: resolution.speaker.id });
              }
            }
          }
          if (speakers !== artifact.speakers || segmentUpdates.length > 0) {
            dispatch({ type: 'speakers_replaced', speakers });
            activeMeetingArtifactRef.current = { ...artifact, speakers };
            stateRef.current = {
              ...stateRef.current,
              artifact: { ...artifact, speakers },
            };
            void applySpeakers(artifact.id, speakers, [], segmentUpdates);
          }
        }
        return;
      }
      if (event.type === 'termination') {
        const shouldRecover =
          desiredSttSourcesRef.current.includes(sourceKind) &&
          canRunSttSession(stateRef.current.runtime.lifecycle, sttSuspendedForGapRef.current);
        const rotationTimer = rotationTimersRef.current.get(sourceKind);
        if (rotationTimer !== undefined) window.clearTimeout(rotationTimer);
        rotationTimersRef.current.delete(sourceKind);
        activeSttSessionsRef.current.delete(sourceKind);
        streamingSttSourcesRef.current.delete(sourceKind);
        if (shouldRecover && session.provider === 'assemblyai') {
          gatewayStateRef.current = 'degraded';
          setSupport((current) => ({ ...current, gatewayState: 'degraded' }));
          updateRuntime({ gateway: 'degraded' });
        }
        void completeSttSession(session, event);
        refreshSttRuntime('closed');
        if (shouldRecover && session.provider === 'assemblyai') scheduleReconnect(sourceKind);
        return;
      }
      if (event.type === 'error') {
        if (session.releasing) return;
        session.releasing = true;
        dispatch({ type: 'failed', error: event.error });
        const ownedArtifact = activeMeetingArtifactRef.current;
        if (ownedArtifact?.id === session.meetingId) {
          const artifact =
            stateRef.current.artifact?.id === session.meetingId
              ? stateRef.current.artifact
              : ownedArtifact;
          const gap: TimelineEvent = {
            id: window.crypto.randomUUID(),
            meetingId: artifact.id,
            kind: 'stt_reconnect_gap',
            startMs: stateRef.current.runtime.elapsedMs,
            sourceKind,
            providerSessionId: event.providerSessionId,
            label: `${sourceKind === 'system' ? 'System audio' : sourceKind === 'microphone' ? 'Microphone' : 'Mixed audio'} transcription disconnected · local audio continued`,
          };
          dispatch({ type: 'timeline_added', event: gap });
          void applyTimelineEvent(artifact.id, gap);
        }
        const rotationTimer = rotationTimersRef.current.get(sourceKind);
        if (rotationTimer !== undefined) window.clearTimeout(rotationTimer);
        rotationTimersRef.current.delete(sourceKind);
        streamingSttSourcesRef.current.delete(sourceKind);
        if (
          session.provider === 'assemblyai' &&
          desiredSttSourcesRef.current.includes(sourceKind)
        ) {
          gatewayStateRef.current = 'degraded';
          setSupport((current) => ({ ...current, gatewayState: 'degraded' }));
          updateRuntime({ gateway: 'degraded' });
        }
        const shouldReconnect = shouldReconnectStt(
          session.provider,
          event.error.retryable,
          reconnectAttemptsRef.current.get(sourceKind) ?? 0
        );
        refreshSttRuntime(shouldReconnect ? 'reconnecting' : 'error');
        void (async () => {
          await releaseSttProvider(session.adapter);
          if (activeSttSessionsRef.current.get(sourceKind) === session) {
            activeSttSessionsRef.current.delete(sourceKind);
          }
          await completeSttSession(
            session,
            undefined,
            event.error.retryable ? 'disconnected' : 'error'
          ).catch(() => undefined);
          refreshSttRuntime(shouldReconnect ? 'reconnecting' : 'error');
          if (shouldReconnect) scheduleReconnect(sourceKind);
        })();
      }
    },
    [completeSttSession, refreshSttRuntime, scheduleReconnect, updateRuntime]
  );
  handleProviderEventRef.current = handleProviderEvent;

  const startSttSession = useCallback(
    async (sourceKind: LiveAudioSourceKind) => {
      await runExclusiveLiveOperation(startingSttSourcesRef.current, sourceKind, async () => {
        const api = liveApi();
        const artifact = activeMeetingArtifactRef.current;
        if (!api || !artifact) throw new Error('Live transcription is unavailable');
        if (stateRef.current.runtime.meetingId !== artifact.id) return;
        if (!desiredSttSourcesRef.current.includes(sourceKind)) return;
        if (!canRunSttSession(stateRef.current.runtime.lifecycle, sttSuspendedForGapRef.current)) {
          return;
        }

        const rotationTimer = rotationTimersRef.current.get(sourceKind);
        if (rotationTimer !== undefined) window.clearTimeout(rotationTimer);
        rotationTimersRef.current.delete(sourceKind);
        const reconnectTimer = reconnectTimersRef.current.get(sourceKind);
        if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
        reconnectTimersRef.current.delete(sourceKind);

        const previous = activeSttSessionsRef.current.get(sourceKind);
        if (previous) {
          try {
            await previous.adapter.terminate();
          } catch {
            await releaseSttProvider(previous.adapter);
          }
          if (activeSttSessionsRef.current.get(sourceKind) === previous) {
            activeSttSessionsRef.current.delete(sourceKind);
            streamingSttSourcesRef.current.delete(sourceKind);
          }
          await completeSttSession(previous, undefined, 'rotated').catch(() => undefined);
        }
        refreshSttRuntime(previous ? 'reconnecting' : 'connecting');

        const connectLocalStt = async () => {
          const localSupport = await api.getLocalSttSupport().catch(() => ({
            available: false,
            model: LOCAL_STT_MODEL,
            reason: 'Local transcription could not be started.',
          }));
          setSupport((current) => ({
            ...current,
            localSttAvailable: localSupport.available,
            localSttModel: localSupport.model,
            localSttUnavailableReason: localSupport.reason,
          }));
          if (!localSupport.available) throw new Error(localSupport.reason);
          if (
            stateRef.current.artifact?.id !== artifact.id ||
            !desiredSttSourcesRef.current.includes(sourceKind) ||
            !canRunSttSession(stateRef.current.runtime.lifecycle, sttSuspendedForGapRef.current)
          ) {
            return;
          }

          localSttSourcesRef.current.add(sourceKind);
          const localSessionKey = `local-${window.crypto.randomUUID()}`;
          const adapter = new LocalWhisperStreamingAdapter(
            {
              meetingId: artifact.id,
              sourceKind,
              sampleRate: LOCAL_STT_SAMPLE_RATE,
            },
            api,
            (event) => handleProviderEventRef.current(sourceKind, localSessionKey, event)
          );
          const session: ActiveSttSession = {
            meetingId: artifact.id,
            sourceKind,
            gatewaySessionId: localSessionKey,
            providerSessionId: localSessionKey,
            provider: 'faster_whisper',
            model: localSupport.model,
            adapter,
            startedAtMs: Date.now(),
            maxSessionSeconds: Number.POSITIVE_INFINITY,
            audioDurationSeconds: 0,
            completed: false,
          };
          activeSttSessionsRef.current.set(sourceKind, session);
          providerSessionSourcesRef.current.set(localSessionKey, sourceKind);
          providerSessionModelsRef.current.set(localSessionKey, localSupport.model);
          refreshSttRuntime(previous ? 'reconnecting' : 'connecting');
          try {
            await adapter.connect();
          } catch (error) {
            session.releasing = true;
            await releaseSttProvider(adapter);
            if (activeSttSessionsRef.current.get(sourceKind) === session) {
              activeSttSessionsRef.current.delete(sourceKind);
              streamingSttSourcesRef.current.delete(sourceKind);
              refreshSttRuntime('error');
            }
            throw error;
          }
        };

        if (localSttSourcesRef.current.has(sourceKind)) {
          await connectLocalStt();
          return;
        }

        let grant: SttSessionResponse;
        try {
          grant = await api.getSttSession({
            meetingId: artifact.id,
            idempotencyKey: `${artifact.id}:stt:${sourceKind}:${window.crypto.randomUUID()}`,
            strategy: artifact.strategy,
            sourceKind,
            maxSessionSeconds: 10_800,
          });
        } catch (hostedError) {
          try {
            await connectLocalStt();
            return;
          } catch (localError) {
            if (localSttSourcesRef.current.has(sourceKind)) throw localError;
            scheduleReconnect(sourceKind);
            throw hostedError;
          }
        }
        if (
          !desiredSttSourcesRef.current.includes(sourceKind) ||
          !canRunSttSession(stateRef.current.runtime.lifecycle, sttSuspendedForGapRef.current)
        ) {
          await api
            .completeSttSession(grant.sessionId, {
              meetingId: artifact.id,
              providerSessionId: grant.sessionId,
              endedReason: 'error',
            })
            .catch(() => undefined);
          return;
        }
        const maxSessionSeconds =
          typeof grant.configuration.maxSessionDurationSeconds === 'number'
            ? grant.configuration.maxSessionDurationSeconds
            : 10_800;
        const configuration: StreamingSessionConfiguration = {
          token: grant.token,
          websocketUrl: grant.websocketUrl,
          providerSessionId: grant.sessionId,
          model: grant.model,
          sampleRate: 16_000,
          speakerLabels: true,
          expiresAtMs: grant.expiresAtEpochMs,
          maxSessionDurationSeconds: maxSessionSeconds,
        };
        const adapter = new AssemblyStreamingAdapter(configuration, (event) =>
          handleProviderEventRef.current(sourceKind, grant.sessionId, event)
        );
        const session: ActiveSttSession = {
          meetingId: artifact.id,
          sourceKind,
          gatewaySessionId: grant.sessionId,
          providerSessionId: grant.sessionId,
          provider: 'assemblyai',
          model: grant.model,
          adapter,
          startedAtMs: Date.now(),
          maxSessionSeconds,
          audioDurationSeconds: 0,
          completed: false,
        };
        activeSttSessionsRef.current.set(sourceKind, session);
        providerSessionSourcesRef.current.set(session.providerSessionId, sourceKind);
        refreshSttRuntime(previous ? 'reconnecting' : 'connecting');
        try {
          await adapter.connect();
        } catch (error) {
          session.releasing = true;
          await releaseSttProvider(adapter);
          if (activeSttSessionsRef.current.get(sourceKind) === session) {
            activeSttSessionsRef.current.delete(sourceKind);
            streamingSttSourcesRef.current.delete(sourceKind);
            await completeSttSession(session, undefined, 'disconnected').catch(() => undefined);
          }
          throw error;
        }
        if (activeSttSessionsRef.current.get(sourceKind) !== session) return;
        const rotationDelayMs = Math.max(1_000, (maxSessionSeconds - 60) * 1_000);
        const timer = window.setTimeout(
          () => void startSttSessionRef.current(sourceKind).catch(() => undefined),
          rotationDelayMs
        );
        rotationTimersRef.current.set(sourceKind, timer);
      });
    },
    [completeSttSession, refreshSttRuntime, scheduleReconnect]
  );
  startSttSessionRef.current = startSttSession;

  const startSttSessions = useCallback(
    async (sourceKinds: LiveAudioSourceKind[]) => {
      desiredSttSourcesRef.current = [...sourceKinds];
      const results = await Promise.allSettled(
        sourceKinds.map((sourceKind) => startSttSession(sourceKind))
      );
      if (results.some((result) => result.status === 'rejected')) {
        const hasTerminalFailure = results.some(
          (result, index) =>
            result.status === 'rejected' && !reconnectTimersRef.current.has(sourceKinds[index])
        );
        gatewayStateRef.current = 'degraded';
        setSupport((current) => ({ ...current, gatewayState: 'degraded' }));
        updateRuntime({ gateway: 'degraded' });
        refreshSttRuntime(hasTerminalFailure ? 'error' : 'reconnecting');
      }
    },
    [refreshSttRuntime, startSttSession, updateRuntime]
  );

  const pollGatewayJob = useCallback(
    async (
      meetingId: string,
      job: GatewayJobResponse<unknown>,
      refinement = false,
      stage: 'quick' | 'deep' = 'quick'
    ): Promise<GatewayJobResponse<unknown>> => {
      const api = liveApi();
      if (!api) throw new Error('Gateway is unavailable');
      return pollGatewayJobUntilSettled(
        job,
        (jobId) =>
          refinement
            ? api.pollRefinement(meetingId, jobId)
            : api.pollFactCheck(meetingId, jobId, stage),
        { signal: researchPollingAbortRef.current.signal }
      );
    },
    []
  );

  const runResearchStage = useCallback(
    async (
      claim: Claim,
      version: ClaimVersion,
      stage: 'quick' | 'deep',
      recoveryJob?: ResearchJob,
      artifactOverride?: MeetingArtifact,
      acceptedCheckId?: string,
      unresolvedSubquestions?: string[],
      preliminaryAssessmentOverride?: Assessment,
      escalationReason: 'user' | 'policy' = 'policy'
    ) => {
      const api = liveApi();
      const artifact = artifactOverride ?? stateRef.current.artifact;
      if (!api || !artifact) return;
      const jobId = recoveryJob?.id ?? window.crypto.randomUUID();
      return runExclusiveLiveOperation(researchJobsInFlightRef.current, jobId, async () => {
        const attempt = researchAttemptPlan(version.id, stage, recoveryJob);
        const idempotencyKey = attempt.idempotencyKey;
        const contextTurns = version.segmentIds
          .map(
            (segmentId) =>
              stateRef.current.activeTurns[segmentId] ??
              artifact.turns.find((turn) => turn.id === segmentId)
          )
          .filter(Boolean)
          .map((turn) => ({
            id: turn.id,
            speakerId: turn.speakerId ?? null,
            startMs: turn.startMs,
            endMs: turn.endMs,
            text: turn.text,
          }));
        const request: FactCheckSubmitRequest = {
          meetingId: artifact.id,
          claimId: claim.id,
          claimVersionId: version.id,
          idempotencyKey,
          exactQuote: version.exactQuote,
          normalizedClaim: version.normalizedClaim,
          contextTurns,
          requiredTurnIds: contextTurns.map((turn) => turn.id),
          origin: claim.origin,
          timeSensitive: version.timeSensitive,
          consequenceScore: version.consequenceScore,
          autoEscalate: false,
        };
        const pendingJob: MeetingResearchJobUpsertDto = {
          id: jobId,
          claimVersionId: version.id,
          stage: stage === 'quick' ? 'preliminary' : 'deep',
          gatewayJobId: attempt.pollJobId ?? null,
          idempotencyKey,
          status: 'pending',
          attemptCount: attempt.attemptCount,
          nextRetryAtMs: null,
          startedAtMs: attempt.startedAtMs,
          completedAtMs: null,
          error: null,
        };
        dispatch({
          type: 'claim_status_changed',
          claimId: claim.id,
          status: stage === 'quick' ? 'quick_running' : 'deep_running',
        });
        let acceptedGatewayJobId = pendingJob.gatewayJobId ?? undefined;
        try {
          await persistResearch(artifact.id, pendingJob, null);
          let submitted: GatewayJobResponse<unknown>;
          if (attempt.pollJobId) {
            submitted = await api.pollFactCheck(artifact.id, attempt.pollJobId, stage);
          } else if (stage === 'deep') {
            const preliminaryCheckId =
              acceptedCheckId ??
              [...artifact.researchJobs]
                .filter(
                  (candidate) =>
                    candidate.claimVersionId === version.id &&
                    candidate.stage === 'preliminary' &&
                    candidate.gatewayJobId
                )
                .sort((left, right) => right.attemptCount - left.attemptCount)[0]?.gatewayJobId;
            if (!preliminaryCheckId) {
              throw new Error('Deep research needs an accepted preliminary check.');
            }
            submitted = await api.escalateFactCheck(
              artifact.id,
              preliminaryCheckId,
              idempotencyKey,
              escalationReason,
              unresolvedSubquestions
            );
          } else {
            submitted = await api.submitFactCheck(stage, request);
          }
          acceptedGatewayJobId = submitted.jobId;
          await persistResearch(
            artifact.id,
            { ...pendingJob, gatewayJobId: submitted.jobId, status: submitted.status },
            null
          );
          const completed = await pollGatewayJob(artifact.id, submitted, false, stage);
          if (activeGatewayJob(completed)) {
            const canonical = await persistResearch(
              artifact.id,
              {
                ...pendingJob,
                gatewayJobId: completed.jobId,
                status: 'retry_wait',
                nextRetryAtMs: Date.now() + 5_000,
                error: {
                  code: 'research_poll_window_elapsed',
                  message: 'The accepted check is still running. Obelus will resume polling it.',
                  retryable: true,
                },
              },
              null
            );
            if (stateRef.current.artifact?.id === artifact.id) {
              stateRef.current = { ...stateRef.current, artifact: canonical };
              dispatch({ type: 'artifact_loaded', artifact: canonical });
            }
            dispatch({
              type: 'claim_status_changed',
              claimId: claim.id,
              status: stage === 'deep' ? 'preliminary' : 'queued',
            });
            return;
          }
          if (completed.status !== 'complete' || !isGatewayAssessment(completed.result)) {
            const failure = researchFailureDisposition(
              completed.error
                ? {
                    code: completed.error.code,
                    message: completed.error.message,
                    retryable: completed.error.retryable,
                  }
                : {
                    code: 'research_failed',
                    message: 'Research did not return a valid packet.',
                    retryable: true,
                  },
              pendingJob.attemptCount,
              completed.status === 'cancelled'
            );
            const canonical = await persistResearch(
              artifact.id,
              {
                ...pendingJob,
                gatewayJobId: submitted.jobId,
                ...failure,
              },
              null
            );
            if (stateRef.current.artifact?.id === artifact.id) {
              stateRef.current = { ...stateRef.current, artifact: canonical };
              dispatch({ type: 'artifact_loaded', artifact: canonical });
            }
            dispatch({
              type: 'claim_status_changed',
              claimId: claim.id,
              status:
                stage === 'deep'
                  ? 'preliminary'
                  : failure.status === 'retry_wait'
                    ? 'queued'
                    : 'failed',
            });
            return;
          }
          const result = completed.result;
          const assessment = localAssessment(
            version.id,
            result,
            pendingJob.attemptCount,
            completed.jobId
          );
          const persistedPreliminary =
            preliminaryAssessmentOverride ??
            artifact.claims
              .find((candidate) => candidate.id === claim.id)
              ?.versions.find((candidate) => candidate.id === version.id)
              ?.assessments.filter(
                (candidate) => candidate.stage === 'preliminary' && candidate.status === 'complete'
              )
              .sort((left, right) => right.attempt - left.attempt)[0];
          const setCurrentAssessment =
            stage === 'quick' ||
            preferredAssessment(persistedPreliminary, assessment)?.id === assessment.id;
          await publishAssessmentAfterPersistence(
            () =>
              persistResearch(
                artifact.id,
                {
                  ...pendingJob,
                  gatewayJobId: completed.jobId,
                  status: 'complete',
                  completedAtMs: Date.now(),
                },
                assessmentDto(
                  assessment,
                  result,
                  (completed as { usage?: unknown }).usage,
                  pendingJob.startedAtMs ?? new Date(result.completedAt).getTime(),
                  setCurrentAssessment
                )
              ),
            claim.id,
            version.id,
            assessment.id,
            (durableAssessment) =>
              dispatch({
                type: 'assessment_upserted',
                claimId: claim.id,
                assessment: durableAssessment,
              })
          );
          if (shouldRunDeepResearch(stage, result)) {
            await runResearchStage(
              claim,
              version,
              'deep',
              undefined,
              artifact,
              completed.jobId,
              completed.escalation?.unresolvedSubquestions,
              assessment
            );
          }
        } catch (error) {
          const typed = gatewayError(
            error,
            gatewayStateRef.current === 'unavailable'
              ? 'Claim saved locally. Evidence research needs the Obelus research gateway, which is not configured.'
              : 'Research will retry when the gateway is available.'
          );
          const failure = researchFailureDisposition(typed, pendingJob.attemptCount);
          const canonical = await persistResearch(
            artifact.id,
            {
              ...pendingJob,
              gatewayJobId: acceptedGatewayJobId,
              ...failure,
            },
            null
          ).catch(() => undefined);
          if (canonical && stateRef.current.artifact?.id === artifact.id) {
            stateRef.current = { ...stateRef.current, artifact: canonical };
            dispatch({ type: 'artifact_loaded', artifact: canonical });
          }
          dispatch({
            type: 'claim_status_changed',
            claimId: claim.id,
            status:
              stage === 'deep'
                ? 'preliminary'
                : failure.status === 'retry_wait'
                  ? 'queued'
                  : 'failed',
          });
        }
      });
    },
    [pollGatewayJob]
  );

  const runManualFactCheckRequest = useCallback(
    async (artifact: MeetingArtifact, request: ManualFactCheckRequest) =>
      runExclusiveLiveOperation(
        manualFactCheckRequestsInFlightRef.current,
        request.id,
        async () => {
          const api = liveApi();
          if (!api) return;
          try {
            await persistClaimVersions(artifact.id, [], [], {
              manualFactCheckRequests: [manualFactCheckRequestUpsert(request, 'processing')],
            });
            const uniqueCandidates = await resolveManualClaimCandidatesWithFallback(
              request,
              async () => {
                const response = (await api.submitClaimDetection({
                  meetingId: artifact.id,
                  idempotencyKey: `manual-claim-detection:${request.id}`,
                  turns: request.contextTurns.map((turn) => ({
                    id: turn.id,
                    speakerId: turn.speakerId ?? null,
                    startMs: turn.startMs,
                    endMs: turn.endMs,
                    text: turn.text,
                  })),
                  existingClaimKeys: artifact.claims.map((claim) => claim.duplicateKey),
                  manual: true,
                  manualSelection: request.exactSelection,
                })) as unknown as {
                  candidates?: unknown[];
                  result?: { candidates?: unknown[] };
                };
                return (response.result?.candidates ?? response.candidates ?? []).filter(
                  isClaimCandidate
                );
              }
            );
            const drafts = uniqueCandidates.map((candidate) =>
              claimDraft(
                artifact,
                candidate,
                'manual',
                request.id,
                manualClaimIdentity(artifact.id, request.id, candidate.semanticDuplicateKey)
              )
            );
            const canonical = await persistClaimVersions(
              artifact.id,
              drafts.map((draft) => draft.dto),
              [],
              {
                manualFactCheckRequests: [manualFactCheckRequestUpsert(request, 'complete')],
              }
            );
            if (stateRef.current.artifact?.id === artifact.id) {
              stateRef.current = { ...stateRef.current, artifact: canonical };
              dispatch({ type: 'artifact_loaded', artifact: canonical });
            }
            let selectedManualClaim = false;
            for (const draft of drafts) {
              const claim = canonical.claims.find((candidate) => candidate.id === draft.claim.id);
              const version = claim?.versions.find(
                (candidate) => candidate.id === draft.version.id
              );
              if (!claim || !version) continue;
              if (stateRef.current.artifact?.id === artifact.id) {
                dispatch({ type: 'claim_upserted', claim });
                if (!selectedManualClaim) {
                  selectedManualClaim = true;
                  dispatch({ type: 'claim_selected', claimId: claim.id });
                }
              }
              void runResearchStage(claim, version, 'quick', undefined, canonical);
            }
          } catch (error) {
            const typed = gatewayError(error, 'Manual fact-checking will retry when available.');
            const failedArtifact = await persistClaimVersions(artifact.id, [], [], {
              manualFactCheckRequests: [
                manualFactCheckRequestUpsert(
                  request,
                  typed.retryable ? 'retry_wait' : 'failed',
                  typed
                ),
              ],
            }).catch(() => undefined);
            if (failedArtifact && stateRef.current.artifact?.id === artifact.id) {
              stateRef.current = { ...stateRef.current, artifact: failedArtifact };
              dispatch({ type: 'artifact_loaded', artifact: failedArtifact });
              dispatch({ type: 'claim_rail_changed', open: true });
            }
          }
        }
      ),
    [runResearchStage]
  );

  const createScheduler = useCallback(
    (artifact: MeetingArtifact) => {
      claimSchedulerArtifactsRef.current.set(artifact.id, artifact);
      const existing = claimSchedulersRef.current.get(artifact.id);
      const schedulerOptions =
        support.localFactCheckMode === 'subscription_web'
          ? subscriptionClaimSchedulerOptions
          : gatewayClaimSchedulerOptions;
      if (existing) {
        existing.setMaxGateCallsPerHour(schedulerOptions.maxGateCallsPerHour);
        return existing;
      }
      const meetingId = artifact.id;
      const scheduler = new ClaimScheduler(
        meetingId,
        () => {
          const current = stateRef.current.artifact;
          return current?.id === meetingId
            ? current.claims
            : (claimSchedulerArtifactsRef.current.get(meetingId)?.claims ?? []);
        },
        {
          beginBatch: async (batch) => {
            const canonical = await persistClaimVersions(meetingId, [], [], {
              beginBatches: [claimGateBatchBeginInput(batch)],
            });
            claimSchedulerArtifactsRef.current.set(meetingId, canonical);
          },
          detect: async (batch) => {
            const api = liveApi();
            const schedulerArtifact = claimSchedulerArtifactsRef.current.get(meetingId);
            const activeTurns =
              stateRef.current.artifact?.id === meetingId
                ? Object.values(stateRef.current.activeTurns)
                : [];
            const localContextTurns = expandLocalClaimContext(
              batch.turns,
              [...(schedulerArtifact?.turns ?? []), ...activeTurns]
                .filter((turn) => turn.status === 'final' || turn.status === 'revised')
                .map(claimGateTurnSnapshot)
            );
            const transcriptTurn = (turn: ClaimGateTurnSnapshot) => ({
              id: turn.id,
              speakerId: turn.speakerId ?? null,
              startMs: turn.startMs,
              endMs: turn.endMs,
              text: turn.text,
              ...(turn.sourceKind === 'text' ? {} : { sourceKind: turn.sourceKind }),
            });
            const request: ClaimDetectionRequest = {
              meetingId,
              idempotencyKey: batch.idempotencyKey,
              turns: batch.turns.map(transcriptTurn),
              contextTurns: localContextTurns.map(transcriptTurn),
              requiredTurnIds: batch.turns.map((turn) => turn.id),
              existingClaimKeys: batch.existingClaims.map((claim) => claim.duplicateKey),
            };
            return detectClaimCandidatesWithLocalFallback(
              async () => {
                if (!api) throw new Error('Claim detection is unavailable');
                const response = (await api.submitClaimDetection(request)) as unknown as {
                  candidates?: unknown[];
                  catchingUp?: boolean;
                  result?: { candidates?: unknown[]; catchingUp?: boolean };
                };
                const payload = response.result ?? response;
                return {
                  candidates: (payload.candidates ?? []).filter(isClaimCandidate),
                  catchingUp: payload.catchingUp === true,
                };
              },
              batch.turns,
              batch.existingClaims,
              localContextTurns
            );
          },
          commitBatch: async (batch, candidates) => {
            const sourceArtifact = claimSchedulerArtifactsRef.current.get(meetingId) ?? artifact;
            const drafts = candidates.map((candidate) =>
              claimDraft(
                sourceArtifact,
                candidate,
                'automatic',
                undefined,
                automaticClaimIdentity(meetingId, batch.id, candidate.semanticDuplicateKey)
              )
            );
            const canonical = await persistClaimVersions(
              meetingId,
              drafts.map((draft) => draft.dto),
              [],
              { completeBatchIds: [batch.id] }
            );
            claimSchedulerArtifactsRef.current.set(meetingId, canonical);
            if (stateRef.current.artifact?.id === meetingId) {
              stateRef.current = {
                ...stateRef.current,
                artifact: { ...stateRef.current.artifact, claims: canonical.claims },
              };
            }
            for (const draft of drafts) {
              const claim = canonical.claims.find((candidate) => candidate.id === draft.claim.id);
              const version = claim?.versions.find(
                (candidate) => candidate.id === draft.version.id
              );
              if (!claim || !version) continue;
              if (stateRef.current.artifact?.id === meetingId) {
                dispatch({ type: 'claim_upserted', claim });
              }
              void runResearchStage(claim, version, 'quick', undefined, canonical);
            }
          },
          onBackpressure: (active, reason) => {
            if (stateRef.current.artifact?.id === meetingId) {
              dispatch({ type: 'backpressure_changed', active, reason });
            }
          },
        },
        schedulerOptions
      );
      claimSchedulersRef.current.set(meetingId, scheduler);
      return scheduler;
    },
    [runResearchStage, support.localFactCheckMode]
  );

  useEffect(() => {
    const maxGateCallsPerHour =
      support.localFactCheckMode === 'subscription_web'
        ? subscriptionClaimSchedulerOptions.maxGateCallsPerHour
        : gatewayClaimSchedulerOptions.maxGateCallsPerHour;
    for (const scheduler of claimSchedulersRef.current.values()) {
      scheduler.setMaxGateCallsPerHour(maxGateCallsPerHour);
    }
  }, [support.localFactCheckMode]);

  const recoverClaimGateArtifact = useCallback(
    (artifact: MeetingArtifact) => {
      const scheduler = createScheduler(artifact);
      for (const pendingBatch of artifact.pendingClaimGateBatches) {
        scheduler.recoverBatch({
          id: pendingBatch.id,
          meetingId: pendingBatch.meetingId,
          idempotencyKey: pendingBatch.idempotencyKey,
          turns: pendingBatch.turns,
        });
      }
      for (const segmentId of artifact.pendingClaimGateSegmentIds) {
        const turn = artifact.turns.find((candidate) => candidate.id === segmentId);
        if (turn) scheduler.addFinalTurn(turn);
      }
    },
    [createScheduler]
  );

  const closeSttSessionsForGap = useCallback(async () => {
    sttSuspendedForGapRef.current = true;
    pendingSttFramesRef.current.clear();
    for (const timer of rotationTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of reconnectTimersRef.current.values()) window.clearTimeout(timer);
    rotationTimersRef.current.clear();
    reconnectTimersRef.current.clear();
    const sessions = [...activeSttSessionsRef.current.values()];
    await terminateSttProvidersForGap(sessions.map((session) => session.adapter));
    activeSttSessionsRef.current.clear();
    streamingSttSourcesRef.current.clear();
    await Promise.allSettled(
      sessions.map((session) => completeSttSession(session, undefined, 'rotated'))
    );
    setSttState('closed');
  }, [completeSttSession, setSttState]);

  const startSttSessionsAfterGap = useCallback(() => {
    if (!['starting', 'recording'].includes(stateRef.current.runtime.lifecycle)) return;
    const sources = [...desiredSttSourcesRef.current];
    if (sources.length === 0) return;
    sttSuspendedForGapRef.current = false;
    reconnectAttemptsRef.current.clear();
    void startSttSessions(sources);
  }, [startSttSessions]);

  const restartSttSessionsAfterGap = useCallback(async () => {
    await closeSttSessionsForGap();
    startSttSessionsAfterGap();
  }, [closeSttSessionsForGap, startSttSessionsAfterGap]);

  const startMeeting = useCallback(
    async (micOnly = false) => {
      const api = liveApi();
      if (!api || stopPromiseRef.current) return;
      if (
        stateRef.current.runtime.lifecycle !== 'setup' ||
        stateRef.current.runtime.meetingId ||
        stateRef.current.artifact
      ) {
        return;
      }
      const setup = stateRef.current.setup;
      artifactNavigationEpochRef.current += 1;
      sttStateRef.current = 'disconnected';
      refinementStateRef.current = 'not_started';
      activeMeetingArtifactRef.current = undefined;
      const startAction = {
        type: 'meeting_start_requested' as const,
        gateway: gatewayStateRef.current,
      };
      stateRef.current = meetingReducer(stateRef.current, startAction);
      dispatch(startAction);
      let artifact: MeetingArtifact | undefined;
      try {
        let includeSystemAudio = setup.mode === 'call' && !micOnly;
        persistedTurnsRef.current.clear();
        pendingTurnWritesRef.current.clear();
        queuedTurnWritesRef.current.clear();
        activeTurnWriteIdsRef.current.clear();
        terminalTurnWriteRevisionsRef.current.clear();
        speakerObservationsRef.current = [];
        providerTurnIdsRef.current.clear();
        providerSessionSourcesRef.current.clear();
        providerSessionModelsRef.current.clear();
        pendingSttFramesRef.current.clear();
        desiredSttSourcesRef.current = [];
        streamingSttSourcesRef.current.clear();
        sttSuspendedForGapRef.current = false;
        reconnectAttemptsRef.current.clear();
        localSttSourcesRef.current.clear();
        const captureResult = await capture.startCapture({
          mode: setup.mode,
          strategy: setup.strategy,
          microphoneDeviceId: setup.microphoneDeviceId,
          includeSystemAudio,
          onAudioFrame: (sourceKind, frame, meetingTimeMs) => {
            const session = activeSttSessionsRef.current.get(sourceKind);
            if (!session || !streamingSttSourcesRef.current.has(sourceKind)) {
              if (!desiredSttSourcesRef.current.includes(sourceKind)) return;
              const pending = pendingSttFramesRef.current.get(sourceKind) ?? [];
              pending.push({ frame: frame.slice(0), meetingTimeMs });
              if (pending.length > MAX_PENDING_STT_FRAMES) pending.shift();
              pendingSttFramesRef.current.set(sourceKind, pending);
              return;
            }
            session.meetingTimeOriginMs ??= meetingTimeMs;
            session.audioDurationSeconds += frame.byteLength / (16_000 * 2);
            session.adapter.sendAudio(frame);
          },
          onCaptureError: (nextError) => {
            dispatch({ type: 'failed', error: nextError });
            if (
              artifact &&
              (nextError.code === 'audio_device_ended' ||
                nextError.code === 'audio_writer_unavailable')
            ) {
              void stopMeetingActionRef.current();
            }
          },
          onCaptureWarningRecovered: (recovery) => {
            dispatch({ type: 'capture_warning_recovered', code: recovery.code });
          },
          onSystemResume: async () => {
            const resumedSnapshot = await api.getSnapshot();
            applyCaptureSnapshot(resumedSnapshot);
            if (stateRef.current.runtime.lifecycle !== 'recording') return;
            await restartSttSessionsAfterGap();
          },
        });
        includeSystemAudio = captureResult.includeSystemAudio;
        const sttSources = sttSourcesForCapture(setup.strategy, includeSystemAudio);
        desiredSttSourcesRef.current = sttSources;
        if (setup.mode === 'call' && !includeSystemAudio) {
          const action = { type: 'setup_updated' as const, patch: { micOnly: true } };
          stateRef.current = meetingReducer(stateRef.current, action);
          dispatch(action);
        }
        artifact = await createMeeting({
          title: setup.title,
          artifactType: 'meeting',
          mode: setup.mode,
          startedAtMs: Date.now(),
          strategy: setup.strategy,
          microphoneDeviceId: setup.microphoneDeviceId,
          systemAudioEnabled: includeSystemAudio,
          speakerNames: setup.speakerNames,
        });
        activeMeetingArtifactRef.current = artifact;
        updateRuntime({ meetingId: artifact.id });
        const loadedAction = { type: 'artifact_loaded' as const, artifact };
        stateRef.current = meetingReducer(stateRef.current, loadedAction);
        dispatch(loadedAction);
        createScheduler(artifact);
        const snapshot = await api.start({
          meetingId: artifact.id,
          mode: setup.mode,
          strategy: setup.strategy,
          microphoneDeviceId: setup.microphoneDeviceId,
          includeSystemAudio,
          title: setup.title,
        });
        applyCaptureSnapshot(snapshot);
        void startSttSessions(sttSources);
        await capture.activateCapture(artifact.id);
        await updateMeeting(artifact.id, { status: 'recording' });
        await refreshHistory();
      } catch (error) {
        await capture.stopCapture().catch(() => undefined);
        desiredSttSourcesRef.current = [];
        pendingSttFramesRef.current.clear();
        for (const timer of rotationTimersRef.current.values()) window.clearTimeout(timer);
        for (const timer of reconnectTimersRef.current.values()) window.clearTimeout(timer);
        rotationTimersRef.current.clear();
        reconnectTimersRef.current.clear();
        const startingSessions = [...activeSttSessionsRef.current.values()];
        for (const session of startingSessions) session.adapter.close();
        activeSttSessionsRef.current.clear();
        streamingSttSourcesRef.current.clear();
        await Promise.allSettled(
          startingSessions.map((session) => completeSttSession(session, undefined, 'error'))
        );
        await api.stop().catch(() => undefined);
        if (activeMeetingArtifactRef.current?.id === artifact?.id) {
          activeMeetingArtifactRef.current = undefined;
        }
        if (artifact)
          await updateMeeting(artifact.id, { status: 'interrupted', endedAtMs: Date.now() });
        const nextError = gatewayError(error, 'Obelus could not start this meeting.');
        updateRuntime({
          meetingId: artifact?.id,
          lifecycle: 'error',
          error: nextError,
        });
        dispatch({ type: 'failed', error: nextError });
      }
    },
    [
      applyCaptureSnapshot,
      capture,
      completeSttSession,
      createScheduler,
      refreshHistory,
      restartSttSessionsAfterGap,
      startSttSessions,
      updateRuntime,
    ]
  );

  const pauseMeeting = useCallback(async () => {
    const api = liveApi();
    const artifact = activeMeetingArtifactRef.current;
    if (!api || !artifact || stateRef.current.runtime.meetingId !== artifact.id) return;
    sttSuspendedForGapRef.current = true;
    await capture.pauseCapture();
    const [snapshot] = await Promise.all([api.pause(), closeSttSessionsForGap()]);
    applyCaptureSnapshot(snapshot);
    await updateMeeting(artifact.id, { status: 'paused' });
  }, [applyCaptureSnapshot, capture, closeSttSessionsForGap]);

  const resumeMeeting = useCallback(async () => {
    const api = liveApi();
    const artifact = activeMeetingArtifactRef.current;
    if (!api || !artifact || stateRef.current.runtime.meetingId !== artifact.id) return;
    const snapshot = await api.resume();
    applyCaptureSnapshot(snapshot);
    startSttSessionsAfterGap();
    capture.resumeCapture();
    await updateMeeting(artifact.id, { status: 'recording' });
  }, [applyCaptureSnapshot, capture, startSttSessionsAfterGap]);

  const submitRefinement = useCallback(
    async (
      artifact: MeetingArtifact,
      assets: LiveCaptureSnapshot['finalizedAssets'],
      recoveryJob?: RefinementJob
    ) => {
      const api = liveApi();
      if (!api || !artifact.liveTranscriptVersionId) return;
      const sourceTranscriptVersionId = artifact.liveTranscriptVersionId;
      const mixed = assets.filter((asset) => asset.sourceKind === 'mixed');
      if (mixed.length === 0) {
        await updateMeeting(artifact.id, { refinementStatus: 'failed' });
        return;
      }
      const manifestChecksum = await sha256(
        mixed
          .map(
            (asset) =>
              `${asset.assetId}:${asset.checksumSha256}:${asset.timelineStartMs}:${asset.timelineEndMs}`
          )
          .join('|')
      );
      const refinementJobId = recoveryJob?.id ?? window.crypto.randomUUID();
      return runExclusiveLiveOperation(refinementMeetingsInFlightRef.current, artifact.id, () =>
        runExclusiveLiveOperation(refinementJobsInFlightRef.current, refinementJobId, async () => {
          const idempotencyKey =
            recoveryJob?.idempotencyKey ?? `${artifact.id}:${manifestChecksum}:assemblyai`;
          const jobBase: MeetingRefinementJobUpsertDto = {
            id: refinementJobId,
            sourceTranscriptVersionId,
            inputManifestChecksum: manifestChecksum,
            provider: recoveryJob?.provider ?? 'assemblyai',
            model: recoveryJob?.model ?? 'gateway-configured',
            gatewayJobId: recoveryJob?.gatewayJobId ?? null,
            idempotencyKey,
            status: 'uploading',
            attemptCount: recoveryJob?.gatewayJobId
              ? Math.max(1, recoveryJob.attemptCount)
              : (recoveryJob?.attemptCount ?? 0) + 1,
            nextRetryAtMs: null,
            usage: null,
            latencyMs: null,
            startedAtMs: recoveryJob?.startedAtMs ?? Date.now(),
            completedAtMs: null,
            error: null,
          };
          if (artifactOwnsPresentation(stateRef.current, artifact.id)) {
            refinementStateRef.current = 'uploading';
            updateRuntime({ refinement: 'uploading' });
          }
          const attempt = await runDurableRefinementOperation(
            artifact.id,
            jobBase,
            async (updateJob) => {
              await persistAudioAssets(
                artifact.id,
                assets.map((asset, index) => ({
                  id: asset.assetId,
                  sourceKind: asset.sourceKind,
                  timelinePart: index,
                  fileName:
                    asset.relativePath.split('/')[asset.relativePath.split('/').length - 1] ??
                    `${asset.assetId}.wav`,
                  format: asset.format,
                  sampleRate: asset.sampleRate,
                  channels: asset.channels,
                  timelineStartMs: asset.timelineStartMs,
                  timelineEndMs: asset.timelineEndMs,
                  durationMs: asset.durationMs,
                  bytes: asset.bytes,
                  checksum: asset.checksumSha256,
                  status: asset.status,
                })),
                refinementJobId,
                mixed.map((asset, index) => ({
                  refinementJobId,
                  partIndex: index,
                  audioAssetId: asset.assetId,
                  sourceKind: asset.sourceKind,
                  checksum: asset.checksumSha256,
                  meetingStartMs: asset.timelineStartMs,
                  meetingEndMs: asset.timelineEndMs,
                  providerStartMs: asset.timelineStartMs,
                  providerEndMs: asset.timelineEndMs,
                  manifestChecksum,
                }))
              );
              const request: RefinementSubmitRequest = {
                meetingId: artifact.id,
                idempotencyKey,
                sourceTranscriptVersionId,
                manifestChecksum,
                contentType: 'audio/wav',
                parts: mixed.map((asset) => ({
                  assetId: asset.assetId,
                  sourceKind: asset.sourceKind,
                  checksumSha256: asset.checksumSha256,
                  timelineStartMs: asset.timelineStartMs,
                  timelineEndMs: asset.timelineEndMs,
                  providerInputStartMs: asset.timelineStartMs,
                  providerInputEndMs: asset.timelineEndMs,
                })),
              };
              const submitted = recoveryJob?.gatewayJobId
                ? await api.pollRefinement(artifact.id, recoveryJob.gatewayJobId)
                : await api.submitRefinement(request);
              await updateJob({
                gatewayJobId: submitted.jobId,
                status:
                  submitted.status === 'pending'
                    ? 'queued'
                    : submitted.status === 'running'
                      ? 'processing'
                      : submitted.status,
              });
              const completed = await pollGatewayJob(artifact.id, submitted, true);
              if (completed.status !== 'complete' || !isGatewayRefinement(completed.result)) {
                throw (
                  completed.error ?? {
                    code: 'refinement_failed',
                    message: 'Transcript refinement did not return a valid result.',
                    retryable: completed.status !== 'cancelled',
                  }
                );
              }
              if (artifactOwnsPresentation(stateRef.current, artifact.id)) {
                refinementStateRef.current = 'reconciling';
                updateRuntime({ refinement: 'reconciling' });
              }
              await updateJob({
                gatewayJobId: completed.jobId,
                status: 'reconciling',
              });
              const refinedVersionId = refinedTranscriptVersionIdentity(
                artifact.id,
                completed.jobId,
                manifestChecksum
              );
              const result = reconcileRefinement(
                artifact.id,
                refinedVersionId,
                artifact.turns,
                completed.result.utterances.map((utterance) => ({
                  id: utterance.id,
                  speakerCluster: utterance.speakerLabel ?? 'UNKNOWN',
                  text: utterance.text,
                  startMs: utterance.startMs,
                  endMs: utterance.endMs,
                  words: utterance.words.map((word, index) => ({
                    id: `${utterance.id}:word:${index}`,
                    text: word.text,
                    startMs: word.startMs,
                    endMs: word.endMs,
                    speakerLabel: word.speakerLabel ?? undefined,
                    confidence: word.confidence ?? undefined,
                    final: true,
                  })),
                })),
                artifact.speakers,
                artifact.claims
              );
              const staleVersionIds = artifact.claims.flatMap((claim) =>
                result.materiallyChangedClaimIds.includes(claim.id) ? [claim.currentVersionId] : []
              );
              await applySpeakers(artifact.id, result.speakers);
              const refinedSpeakerObservations = result.turns.flatMap((turn) => {
                if (!turn.provisionalSpeakerLabel) return [];
                return [
                  {
                    id: stableLiveUuid(
                      `speaker-observation:${refinedVersionId}:${completed.jobId}:${turn.provisionalSpeakerLabel}`
                    ),
                    transcriptVersionId: refinedVersionId,
                    speakerId: turn.speakerId ?? null,
                    provider: 'assemblyai',
                    providerNamespace: completed.jobId,
                    providerSpeakerLabel: turn.provisionalSpeakerLabel,
                    confidence: null,
                    ambiguous: result.ambiguousClusterIds.includes(turn.provisionalSpeakerLabel),
                    revisionNumber: 0,
                    sourceHint: 'mixed' as const,
                  },
                ];
              });
              const uniqueRefinedSpeakerObservations = [
                ...new Map(
                  refinedSpeakerObservations.map((observation) => [observation.id, observation])
                ).values(),
              ];
              const recheckDtos = refinementClaimVersionDtos(
                artifact,
                refinedVersionId,
                result.turns,
                result.materiallyChangedClaimIds
              );
              const canonical = await applyRefinedTranscript({
                meetingId: artifact.id,
                refinementJobId,
                version: {
                  id: refinedVersionId,
                  kind: 'refined',
                  status: 'complete',
                  revisionNumber: 1,
                  provider: 'assemblyai',
                  model: completed.result.speechModelUsed,
                  gatewayJobId: completed.jobId,
                  parentVersionId: artifact.liveTranscriptVersionId,
                  inputAudioChecksum: manifestChecksum,
                  detectedLanguage: completed.result.detectedLanguage,
                  reconciliationMetadata: {
                    ambiguousClusterIds: result.ambiguousClusterIds,
                    audioDurationSeconds: completed.result.audioDurationSeconds,
                  },
                  startedAtMs: Date.now(),
                  completedAtMs: Date.now(),
                  error: null,
                },
                segments: result.turns.map((turn) => ({
                  id: turn.id,
                  transcriptVersionId: refinedVersionId,
                  provider: 'assemblyai',
                  providerNamespace: completed.jobId,
                  providerSessionId: null,
                  providerTurnId: turn.providerTurnId,
                  providerTurnOrder: turn.providerTurnOrder,
                  revisionNumber: turn.revision,
                  state: turn.status,
                  speakerId: turn.speakerId ?? null,
                  sourceKind: turn.sourceKind,
                  startMs: turn.startMs,
                  endMs: turn.endMs,
                  text: turn.text,
                  words: turn.words.map((word) => ({
                    text: word.text,
                    startMs: word.startMs,
                    endMs: word.endMs,
                    confidence: word.confidence ?? null,
                    providerSpeakerLabel: word.speakerLabel ?? null,
                  })),
                  replacedLiveSegmentIds: artifact.turns
                    .filter(
                      (liveTurn) =>
                        Math.min(liveTurn.endMs, turn.endMs) -
                          Math.max(liveTurn.startMs, turn.startMs) >
                        0
                    )
                    .map((liveTurn) => liveTurn.id),
                })),
                speakerObservations: uniqueRefinedSpeakerObservations,
                markStaleClaimVersionIds: staleVersionIds,
                replacementClaimVersions: recheckDtos,
              });
              await updateJob({
                gatewayJobId: completed.jobId,
                status: 'complete',
                completedAtMs: Date.now(),
                usage: ((completed as { usage?: unknown }).usage ??
                  null) as MeetingRefinementJobUpsertDto['usage'],
              });
              return { canonical, result };
            },
            persistRefinementJob,
            gatewayStateRef.current === 'unavailable'
              ? 'Transcript refinement needs the Obelus research gateway, which is not configured. The local recording and live transcript remain available.'
              : 'Transcript refinement failed; the local recording and live transcript remain available.'
          );
          if (!attempt.ok) {
            if (artifactOwnsPresentation(stateRef.current, artifact.id)) {
              const loaded = await getMeeting(artifact.id);
              if (artifactOwnsPresentation(stateRef.current, artifact.id)) {
                refinementStateRef.current = attempt.failure.status;
                updateRuntime({ refinement: attempt.failure.status });
                const loadedAction = { type: 'artifact_loaded' as const, artifact: loaded };
                stateRef.current = meetingReducer(stateRef.current, loadedAction);
                stateRef.current = meetingReducer(stateRef.current, {
                  type: 'failed',
                  error: attempt.error,
                });
                dispatch(loadedAction);
                dispatch({ type: 'failed', error: attempt.error });
              }
            }
            await refreshHistory();
            return;
          }
          const { canonical, result } = attempt.value;
          if (artifactOwnsPresentation(stateRef.current, artifact.id)) {
            refinementStateRef.current = 'complete';
            updateRuntime({ refinement: 'complete' });
            const loadedAction = { type: 'artifact_loaded' as const, artifact: canonical };
            stateRef.current = meetingReducer(stateRef.current, loadedAction);
            dispatch(loadedAction);
          }
          await refreshHistory();
          for (const claim of canonical.claims) {
            if (!result.materiallyChangedClaimIds.includes(claim.id)) continue;
            const version = claim.versions.find(
              (candidate) => candidate.id === claim.currentVersionId
            );
            if (version) void runResearchStage(claim, version, 'quick', undefined, canonical);
          }
        })
      );
    },
    [pollGatewayJob, refreshHistory, runResearchStage, updateRuntime]
  );

  const recoverCapturedMeetings = useCallback(
    async (snapshot: LiveCaptureSnapshot) => {
      const api = liveApi();
      if (!api) return;
      for (const recovered of snapshot.recoveredMeetings) {
        if (
          recoveredMeetingsHandledRef.current.has(recovered.meetingId) ||
          recoveredMeetingsInFlightRef.current.has(recovered.meetingId)
        ) {
          continue;
        }
        recoveredMeetingsInFlightRef.current.add(recovered.meetingId);
        try {
          let artifact = await getMeeting(recovered.meetingId);
          const captureWasActive = !['complete', 'interrupted'].includes(artifact.status);
          const captureNeedsTerminalWrite = captureWasActive || artifact.endedAtMs === undefined;
          const recoveredRefinementStatus = artifact.refinementStatus;
          const hasMixedAudio = recovered.assets.some(
            (asset) =>
              asset.sourceKind === 'mixed' &&
              (asset.status === 'interrupted' || asset.status === 'finalized') &&
              asset.bytes > 44 &&
              asset.checksumSha256.length === 64
          );
          const hasActiveRefinement = artifact.refinementJobs.some((job) =>
            ['queued', 'uploading', 'processing', 'reconciling', 'retry_wait'].includes(job.status)
          );
          const recoverableNotStarted =
            recoveredRefinementStatus === 'not_started' &&
            artifact.status !== 'complete' &&
            (captureNeedsTerminalWrite || artifact.status === 'interrupted');
          const canAutoEnqueueRefinement =
            hasMixedAudio &&
            Boolean(artifact.liveTranscriptVersionId) &&
            (recoverableNotStarted ||
              ['queued', 'retry_wait'].includes(recoveredRefinementStatus)) &&
            !hasActiveRefinement;
          const missingAssets = recoveredAssetsMissingPersistence(artifact, recovered.assets);
          if (missingAssets.length > 0) {
            await persistAudioAssets(
              artifact.id,
              missingAssets.map((asset) => ({
                id: asset.assetId,
                sourceKind: asset.sourceKind,
                timelinePart: recovered.assets.findIndex(
                  (candidate) => candidate.assetId === asset.assetId
                ),
                fileName: `${asset.sourceKind}.wav`,
                format: asset.format,
                sampleRate: asset.sampleRate,
                channels: asset.channels,
                timelineStartMs: asset.timelineStartMs,
                timelineEndMs: asset.timelineEndMs,
                durationMs: asset.durationMs,
                bytes: asset.bytes,
                checksum: asset.checksumSha256,
                status: asset.status,
              }))
            );
          }
          if (captureNeedsTerminalWrite || canAutoEnqueueRefinement) {
            await updateMeeting(artifact.id, {
              ...(captureWasActive
                ? { status: 'interrupted' as const, captureStatus: 'interrupted' as const }
                : {}),
              ...(captureNeedsTerminalWrite
                ? {
                    endedAtMs:
                      artifact.endedAtMs ??
                      (artifact.startedAtMs === undefined
                        ? Date.now()
                        : Math.round(
                            artifact.startedAtMs +
                              Math.max(0, ...recovered.assets.map((asset) => asset.timelineEndMs))
                          )),
                  }
                : {}),
              ...(canAutoEnqueueRefinement ? { refinementStatus: 'queued' as const } : {}),
            });
          }
          artifact = await getMeeting(artifact.id);
          await api.acknowledgeAudioAssetsPersisted(
            audioAssetAcknowledgement(artifact.id, recovered.assets)
          );
          if (stateRef.current.artifact?.id === artifact.id) {
            const action = { type: 'artifact_loaded' as const, artifact };
            stateRef.current = meetingReducer(stateRef.current, action);
            dispatch(action);
          }

          if (canAutoEnqueueRefinement) {
            void submitRefinement(artifact, recovered.assets).catch(() => undefined);
          }
          recoveredMeetingsHandledRef.current.add(recovered.meetingId);
        } catch {
          // A snapshot remains recoverable and can be retried on the next main-process update.
        } finally {
          recoveredMeetingsInFlightRef.current.delete(recovered.meetingId);
        }
      }
      await refreshHistory();
    },
    [refreshHistory, submitRefinement]
  );
  recoverCapturedMeetingsRef.current = (snapshot) => {
    void recoverCapturedMeetings(snapshot);
  };

  const flushFinalTranscriptWrites = useCallback(
    async (artifact: MeetingArtifact) => {
      const settlePendingWrites = async () => {
        while (pendingTurnWritesRef.current.size > 0) {
          await Promise.all([...pendingTurnWritesRef.current]);
        }
      };
      await settlePendingWrites();
      const unresolved = () =>
        Object.values(stateRef.current.activeTurns).filter(
          (turn) =>
            turn.meetingId === artifact.id &&
            turn.status !== 'partial' &&
            (persistedTurnsRef.current.get(turn.id) ?? -1) < turn.revision
        );
      for (const turn of unresolved()) queueTranscriptTurnWrite(artifact, turn, true);
      await settlePendingWrites();
      if (unresolved().length > 0) throw new Error('Final transcript persistence did not complete');
    },
    [queueTranscriptTurnWrite]
  );

  const stopMeeting = useCallback(async () => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const operation = (async () => {
      const api = liveApi();
      if (!api) return;
      const captureSnapshot = await api.getSnapshot().catch(() => undefined);
      const captureMeetingId = captureSnapshot?.meetingId ?? stateRef.current.runtime.meetingId;
      let artifact = await resolveCaptureArtifact(
        captureMeetingId,
        activeMeetingArtifactRef.current ?? stateRef.current.artifact
      );
      if (!captureMeetingId || !artifact) {
        dispatch({
          type: 'failed',
          error: {
            code: 'capture_identity_unavailable',
            message:
              'Obelus could not identify the active recording. Local audio recovery remains available.',
            retryable: true,
          },
        });
        return;
      }
      activeMeetingArtifactRef.current = artifact;
      if (stateRef.current.artifact?.id !== artifact.id) {
        const loadedAction = { type: 'artifact_loaded' as const, artifact };
        stateRef.current = meetingReducer(stateRef.current, loadedAction);
        dispatch(loadedAction);
      }
      updateRuntime({ lifecycle: 'stopping', stt: 'finalizing' });
      setSttState('finalizing');
      await capture.stopCapture();
      let snapshot: LiveCaptureSnapshot;
      try {
        snapshot = await api.stop();
      } catch (stopError) {
        const recoveredSnapshot = await api.getSnapshot();
        if (recoveredSnapshot.finalizedAssets.length === 0) throw stopError;
        snapshot = recoveredSnapshot;
      }
      sttSuspendedForGapRef.current = true;
      desiredSttSourcesRef.current = [];
      pendingSttFramesRef.current.clear();
      for (const timer of rotationTimersRef.current.values()) window.clearTimeout(timer);
      for (const timer of reconnectTimersRef.current.values()) window.clearTimeout(timer);
      rotationTimersRef.current.clear();
      reconnectTimersRef.current.clear();
      const sttSessions = [...activeSttSessionsRef.current.values()];
      await Promise.allSettled(sttSessions.map((session) => session.adapter.terminate()));
      await Promise.allSettled(
        sttSessions.map((session) => completeSttSession(session, undefined, 'terminated'))
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      let transcriptPersistenceFailed = false;
      try {
        await flushFinalTranscriptWrites(artifact);
      } catch {
        transcriptPersistenceFailed = true;
      }
      activeSttSessionsRef.current.clear();
      streamingSttSourcesRef.current.clear();
      reconnectAttemptsRef.current.clear();
      localSttSourcesRef.current.clear();
      providerSessionSourcesRef.current.clear();
      providerSessionModelsRef.current.clear();
      applyCaptureSnapshot(snapshot);
      const finalizedMeetingId = snapshot.meetingId ?? captureMeetingId;
      if (finalizedMeetingId !== artifact.id) {
        const authoritativeArtifact = await resolveCaptureArtifact(
          finalizedMeetingId,
          activeMeetingArtifactRef.current
        );
        if (!authoritativeArtifact) {
          dispatch({
            type: 'failed',
            error: {
              code: 'capture_identity_mismatch',
              message:
                'The finalized audio did not match the selected meeting. Obelus left it for local recovery instead of attaching it to the wrong artifact.',
              retryable: true,
            },
          });
          return;
        }
        artifact = authoritativeArtifact;
        activeMeetingArtifactRef.current = authoritativeArtifact;
      }
      if (snapshot.finalizedAssets.length > 0) {
        await persistAudioAssets(
          artifact.id,
          snapshot.finalizedAssets.map((asset, index) => ({
            id: asset.assetId,
            sourceKind: asset.sourceKind,
            timelinePart: index,
            fileName: `${asset.sourceKind}.wav`,
            format: asset.format,
            sampleRate: asset.sampleRate,
            channels: asset.channels,
            timelineStartMs: asset.timelineStartMs,
            timelineEndMs: asset.timelineEndMs,
            durationMs: asset.durationMs,
            bytes: asset.bytes,
            checksum: asset.checksumSha256,
            status: asset.status,
          }))
        );
      }
      const terminalState = meetingStopTerminalState(snapshot, transcriptPersistenceFailed);
      const captureStartedAtMs = artifact.startedAtMs ?? snapshot.startedAtEpochMs;
      await updateMeeting(artifact.id, {
        status: terminalState.lifecycle,
        endedAtMs:
          captureStartedAtMs === null
            ? Date.now()
            : Math.round(captureStartedAtMs + snapshot.elapsedMs),
        captureStatus: terminalState.captureStatus,
        refinementStatus: terminalState.refinementStatus,
      });
      if (snapshot.finalizedAssets.length > 0) {
        await api.acknowledgeAudioAssetsPersisted(
          audioAssetAcknowledgement(artifact.id, snapshot.finalizedAssets)
        );
      }
      const availableArtifact = await getMeeting(artifact.id);
      const loadedAction = { type: 'artifact_loaded' as const, artifact: availableArtifact };
      stateRef.current = meetingReducer(stateRef.current, loadedAction);
      dispatch(loadedAction);
      activeMeetingArtifactRef.current = undefined;
      refinementStateRef.current = terminalState.refinementStatus;
      updateRuntime({
        lifecycle: terminalState.lifecycle,
        refinement: refinementStateRef.current,
        stt: 'closed',
      });
      await refreshHistory();
      if (transcriptPersistenceFailed) {
        dispatch({
          type: 'failed',
          error: {
            code: 'transcript_persistence_failed',
            message:
              'The local audio is safe, but finalized transcript turns could not be saved. Refinement is paused until local persistence recovers.',
            retryable: true,
          },
        });
        return;
      }
      void submitRefinement(availableArtifact, snapshot.finalizedAssets).catch((error) => {
        if (!artifactOwnsPresentation(stateRef.current, availableArtifact.id)) return;
        refinementStateRef.current = 'failed';
        updateRuntime({ refinement: 'failed' });
        dispatch({
          type: 'failed',
          error: gatewayError(
            error,
            'Transcript refinement failed; the live transcript remains available.'
          ),
        });
      });
    })()
      .catch(async () => {
        const recoverySnapshot = await liveApi()
          ?.getSnapshot()
          .catch(() => undefined);
        const localAudioIsRecoverable = Boolean(
          recoverySnapshot?.finalizedAssets.length ||
          recoverySnapshot?.recoveredMeetings.some(
            (meeting) => meeting.meetingId === activeMeetingArtifactRef.current?.id
          )
        );
        updateRuntime({ lifecycle: 'error', stt: 'closed' });
        dispatch({
          type: 'failed',
          error: {
            code: 'meeting_finalization_failed',
            message: localAudioIsRecoverable
              ? 'Obelus saved the local audio but could not finish attaching it to this meeting. It will retry recovery the next time Obelus opens.'
              : 'Obelus could not finish stopping this meeting. Try again before closing the app.',
            retryable: true,
          },
        });
      })
      .finally(() => {
        stopPromiseRef.current = undefined;
      });
    stopPromiseRef.current = operation;
    return operation;
  }, [
    applyCaptureSnapshot,
    capture,
    completeSttSession,
    flushFinalTranscriptWrites,
    refreshHistory,
    setSttState,
    submitRefinement,
    updateRuntime,
  ]);
  stopMeetingActionRef.current = stopMeeting;

  useEffect(
    () =>
      startMeetingRecoveryLoop(
        async (reconcileActiveWork, controls) => {
          const api = liveApi();
          if (!api) return;
          const recovery = await recoverMeetingJobs(reconcileActiveWork);
          if (reconcileActiveWork) controls.acknowledgeStartupReconciliation();
          const summaries = await listMeetings();
          const artifacts = await Promise.all(
            summaries.map((summary) => getMeeting(summary.id).catch(() => undefined))
          );

          for (const artifact of artifacts) {
            if (controls.isCancelled()) return;
            if (artifact) recoverClaimGateArtifact(artifact);
          }

          for (const artifact of artifacts) {
            if (!artifact) continue;
            for (const request of artifact.manualFactCheckRequests) {
              if (controls.isCancelled()) return;
              const resumable = reconcileActiveWork
                ? ['queued', 'processing', 'retry_wait'].includes(request.status)
                : request.status === 'retry_wait';
              if (resumable) await runManualFactCheckRequest(artifact, request);
            }
          }

          for (const job of recovery.researchJobs) {
            if (controls.isCancelled()) return;
            if (
              researchJobsInFlightRef.current.has(job.id) ||
              (!reconcileActiveWork && job.status !== 'retry_wait')
            ) {
              continue;
            }
            const artifact = artifacts.find((candidate) =>
              candidate?.researchJobs.some((candidateJob) => candidateJob.id === job.id)
            );
            const localJob = artifact?.researchJobs.find(
              (candidateJob) => candidateJob.id === job.id
            );
            if (!localJob || !resumableRecoveredResearchJob(localJob.status)) continue;
            const claim = artifact?.claims.find((candidate) =>
              candidate.versions.some((version) => version.id === job.claimVersionId)
            );
            const version = claim?.versions.find(
              (candidate) => candidate.id === job.claimVersionId
            );
            if (claim && version) {
              await runResearchStage(
                claim,
                version,
                job.stage === 'deep' ? 'deep' : 'quick',
                localJob,
                artifact
              );
            }
          }

          const recoveredRefinementMeetings = new Set<string>();
          for (const job of recovery.refinementJobs) {
            if (controls.isCancelled() || recoveredRefinementMeetings.has(job.meetingId)) continue;
            if (
              refinementJobsInFlightRef.current.has(job.id) ||
              (!reconcileActiveWork && job.status !== 'retry_wait')
            ) {
              continue;
            }
            recoveredRefinementMeetings.add(job.meetingId);
            const artifact =
              artifacts.find((candidate) => candidate?.id === job.meetingId) ??
              (await getMeeting(job.meetingId).catch(() => undefined));
            if (!artifact) continue;
            const localRefinementJob = artifact.refinementJobs.find(
              (candidate) => candidate.id === job.id
            );
            if (
              !localRefinementJob ||
              !resumableRecoveredRefinementJob(localRefinementJob.status)
            ) {
              continue;
            }
            const assets = reconstructArtifactAudioAssets(artifact);
            if (assets.some((asset) => asset.sourceKind === 'mixed')) {
              await submitRefinement(artifact, assets, localRefinementJob);
            }
          }

          for (const artifact of artifacts) {
            if (controls.isCancelled()) return;
            if (
              !artifact ||
              recoveredRefinementMeetings.has(artifact.id) ||
              !resumableArtifactRefinementWithoutJob(artifact)
            ) {
              continue;
            }
            recoveredRefinementMeetings.add(artifact.id);
            await submitRefinement(artifact, reconstructArtifactAudioAssets(artifact));
          }

          for (const cleanupJob of recovery.cleanupJobs) {
            if (controls.isCancelled()) return;
            if (
              recoveredCleanupJobsInFlightRef.current.has(cleanupJob.id) ||
              !resumableRecoveredCleanupJob(cleanupJob, reconcileActiveWork)
            ) {
              continue;
            }
            recoveredCleanupJobsInFlightRef.current.add(cleanupJob.id);
            try {
              const [local, remote] = await Promise.allSettled([
                api.deleteLocalMeetingAssets(cleanupJob.meetingId),
                api.deleteRemoteMeeting(cleanupJob.meetingId),
              ]);
              const confirmation = meetingCleanupConfirmation(
                local.status === 'fulfilled' && local.value.status === 'complete'
                  ? 'complete'
                  : 'retry_wait',
                remote.status === 'fulfilled' ? remote.value : undefined
              );
              if (
                confirmation.limitation &&
                !shownCleanupLimitationsRef.current.has(cleanupJob.id)
              ) {
                shownCleanupLimitationsRef.current.add(cleanupJob.id);
                await window.electron.showMessageBox({
                  type: 'info',
                  title: 'Provider retention limitation',
                  message: 'Some provider-held data cannot be deleted early.',
                  detail: confirmation.limitation,
                  buttons: ['Done'],
                });
              }
              await confirmMeetingCleanup(cleanupJob.id, confirmation);
            } finally {
              recoveredCleanupJobsInFlightRef.current.delete(cleanupJob.id);
            }
          }
          await refreshHistory();
        },
        60_000,
        meetingRecoveryLoopStateRef.current
      ),
    [
      recoverClaimGateArtifact,
      refreshHistory,
      runManualFactCheckRequest,
      runResearchStage,
      submitRefinement,
    ]
  );

  const factCheckSelectionRef = useRef<(selection: SelectionFactCheckInput) => Promise<void>>(
    async () => undefined
  );

  const factCheckSelection = useCallback(
    async (selection: SelectionFactCheckInput) => {
      const text = normalizeManualSelection(selection.text);
      if (!text) return;
      let artifact = reusableFactCheckArtifact(selection, stateRef.current);
      if (!artifact) {
        const createdArtifact = await createMeeting({
          title: text.length > 72 ? `${text.slice(0, 69)}…` : text,
          artifactType: 'text_check',
          mode: 'text',
          startedAtMs: Date.now(),
          strategy: 'mixed_diarized',
          systemAudioEnabled: false,
        });
        const updatedMeeting = await updateMeeting(createdArtifact.id, {
          status: 'complete',
          endedAtMs: Date.now(),
        });
        artifact = { ...createdArtifact, ...updatedMeeting };
        dispatch({ type: 'artifact_loaded', artifact });
        stateRef.current = { ...stateRef.current, artifact };
      }
      if (!artifact) return;
      const selectionArtifact = artifact;
      const selectedTurnIds = [...new Set(selection.turnIds ?? [])];
      if (
        selectedTurnIds.length > 0 &&
        !selectedTurnIds.every((turnId) =>
          selectionArtifact.turns.some((turn) => turn.id === turnId)
        )
      ) {
        let refreshedArtifact: MeetingArtifact | undefined;
        try {
          const selectedTurns = Object.values(stateRef.current.activeTurns).filter(
            (turn) => selectedTurnIds.includes(turn.id) && turn.status !== 'partial'
          );
          for (const turn of selectedTurns) {
            queueTranscriptTurnWrite(selectionArtifact, turn, true);
          }
          while (pendingTurnWritesRef.current.size > 0) {
            await Promise.all([...pendingTurnWritesRef.current]);
          }
          refreshedArtifact = await getMeeting(selectionArtifact.id);
        } catch {
          refreshedArtifact = undefined;
        }
        if (
          !refreshedArtifact ||
          !selectedTurnIds.every((turnId) =>
            refreshedArtifact.turns.some((turn) => turn.id === turnId)
          )
        ) {
          dispatch({
            type: 'failed',
            error: {
              code: 'manual_fact_check_anchor_unavailable',
              message:
                'The selected transcript text is still being saved. Select it again after it appears as final text.',
              retryable: true,
            },
          });
          return;
        }
        artifact = refreshedArtifact;
      }
      const requestId = window.crypto.randomUUID();
      const context = manualFactCheckContext(artifact, selection, requestId, text);
      const now = Date.now();
      const request: ManualFactCheckRequest = {
        id: requestId,
        meetingId: artifact.id,
        exactSelection: text,
        contextTurns: context.contextTurns,
        sourceSegmentIds: context.sourceSegmentIds,
        speakerId: selection.speakerId,
        startMs: selection.startMs,
        endMs: selection.endMs,
        status: 'queued',
        createdAtMs: now,
        updatedAtMs: now,
      };
      const queuedArtifact = await persistClaimVersions(artifact.id, [], [], {
        manualFactCheckRequests: [manualFactCheckRequestUpsert(request, 'queued')],
      });
      artifact = queuedArtifact;
      stateRef.current = { ...stateRef.current, artifact: queuedArtifact };
      dispatch({ type: 'artifact_loaded', artifact: queuedArtifact });
      dispatch({ type: 'claim_rail_changed', open: true });
      await runManualFactCheckRequest(queuedArtifact, request);
      await refreshHistory();
    },
    [queueTranscriptTurnWrite, refreshHistory, runManualFactCheckRequest]
  );
  factCheckSelectionRef.current = factCheckSelection;

  const setSetup = useCallback((patch: Partial<LiveSetup>) => {
    const action = { type: 'setup_updated' as const, patch };
    stateRef.current = meetingReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  const openMeeting = useCallback(async (meetingId: string) => {
    const navigationEpoch = ++artifactNavigationEpochRef.current;
    const artifact = await getMeeting(meetingId);
    if (artifactNavigationEpochRef.current !== navigationEpoch) return;
    if (
      ['starting', 'recording', 'paused', 'stopping', 'finalizing'].includes(
        stateRef.current.runtime.lifecycle
      )
    ) {
      return;
    }
    const action = { type: 'artifact_loaded' as const, artifact };
    stateRef.current = meetingReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  const closeArtifact = useCallback(() => {
    if (
      ['recording', 'paused', 'starting', 'stopping', 'finalizing'].includes(
        stateRef.current.runtime.lifecycle
      )
    )
      return;
    artifactNavigationEpochRef.current += 1;
    activeMeetingArtifactRef.current = undefined;
    sttStateRef.current = 'disconnected';
    refinementStateRef.current = 'not_started';
    timelineArtifactIdRef.current = undefined;
    observedTimelineEventsRef.current.clear();
    persistedTimelineEventsRef.current.clear();
    const action = { type: 'cleared' as const };
    stateRef.current = meetingReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  const deleteMeeting = useCallback(
    async (meetingId: string) => {
      const confirmation = await window.electron.showMessageBox({
        type: 'warning',
        title: 'Delete meeting?',
        message: 'Delete this meeting and its local audio?',
        detail:
          'Obelus will also request deletion from the gateway and providers. Third-party retention limits are reported separately.',
        buttons: ['Cancel', 'Delete'],
        defaultId: 0,
      });
      if (confirmation.response !== 1) return;
      claimSchedulersRef.current.get(meetingId)?.dispose();
      claimSchedulersRef.current.delete(meetingId);
      claimSchedulerArtifactsRef.current.delete(meetingId);
      const { cleanupJob } = await deleteMeetingArtifact(meetingId);
      const api = liveApi();
      recoveredCleanupJobsInFlightRef.current.add(cleanupJob.id);
      try {
        const [localResult, remoteResult] = await Promise.allSettled([
          api?.deleteLocalMeetingAssets(meetingId) ??
            Promise.resolve({ status: 'failed' as const, error: 'Local asset API unavailable' }),
          api?.deleteRemoteMeeting(meetingId) ??
            Promise.resolve({
              meetingId,
              status: 'failed' as const,
              gatewayCleanup: 'failed' as const,
              providerCleanup: 'failed' as const,
            }),
        ]);
        const cleanup = meetingCleanupConfirmation(
          localResult.status === 'fulfilled' && localResult.value.status === 'complete'
            ? 'complete'
            : 'retry_wait',
          remoteResult.status === 'fulfilled' ? remoteResult.value : undefined
        );
        if (cleanup.limitation && !shownCleanupLimitationsRef.current.has(cleanupJob.id)) {
          shownCleanupLimitationsRef.current.add(cleanupJob.id);
          await window.electron.showMessageBox({
            type: 'info',
            title: 'Provider retention limitation',
            message: 'Some provider-held data cannot be deleted early.',
            detail: cleanup.limitation,
            buttons: ['Done'],
          });
        }
        await confirmMeetingCleanup(cleanupJob.id, cleanup);
        if (
          cleanup.localStatus !== 'complete' ||
          cleanup.gatewayStatus !== 'complete' ||
          !['complete', 'unavailable'].includes(cleanup.providerStatus)
        ) {
          await window.electron.showMessageBox({
            type: 'info',
            title: 'Deletion is still being completed',
            message: 'The meeting is hidden locally while deletion finishes.',
            detail:
              'Obelus will keep a cleanup record and retry gateway or provider deletion. Third-party retention may not be immediately reducible.',
            buttons: ['Done'],
          });
        }
      } finally {
        recoveredCleanupJobsInFlightRef.current.delete(cleanupJob.id);
      }
      if (stateRef.current.artifact?.id === meetingId) closeArtifact();
      await refreshHistory();
    },
    [closeArtifact, refreshHistory]
  );

  const renameSpeaker = useCallback(async (speakerId: string, displayName?: string) => {
    const artifact = stateRef.current.artifact;
    if (!artifact) return;
    const speakers = artifact.speakers.map((speaker) =>
      speaker.id === speakerId
        ? {
            ...speaker,
            displayName: displayName?.trim() || undefined,
            displayNameSource: displayName?.trim() ? ('manual' as const) : ('generic' as const),
            manualAssignmentLocked: Boolean(displayName?.trim()),
          }
        : speaker
    );
    dispatch({ type: 'speaker_renamed', speakerId, displayName });
    await applySpeakers(artifact.id, speakers);
  }, []);

  const swapSpeakers = useCallback(async (firstSpeakerId: string, secondSpeakerId: string) => {
    const artifact = stateRef.current.artifact;
    if (!artifact) return;
    dispatch({ type: 'speakers_swapped', firstSpeakerId, secondSpeakerId });
    await applySpeakers(artifact.id, [], [{ firstSpeakerId, secondSpeakerId }]);
  }, []);

  const rerunClaim = useCallback(
    async (claimId: string) => {
      const claim = stateRef.current.artifact?.claims.find((candidate) => candidate.id === claimId);
      const version = claim?.versions.find((candidate) => candidate.id === claim.currentVersionId);
      const recoveryJob = stateRef.current.artifact?.researchJobs
        .filter((job) => job.claimVersionId === version?.id && job.stage === 'preliminary')
        .sort((left, right) => right.attemptCount - left.attemptCount)[0];
      if (claim && version) await runResearchStage(claim, version, 'quick', recoveryJob);
    },
    [runResearchStage]
  );

  const escalateClaim = useCallback(
    async (claimId: string) => {
      const artifact = stateRef.current.artifact;
      const claim = artifact?.claims.find((candidate) => candidate.id === claimId);
      const version = claim?.versions.find((candidate) => candidate.id === claim.currentVersionId);
      const preliminaryJob = artifact?.researchJobs
        .filter(
          (job) =>
            job.claimVersionId === version?.id &&
            job.stage === 'preliminary' &&
            job.status === 'complete' &&
            job.gatewayJobId &&
            !isLocalFactCheckJobId(job.gatewayJobId)
        )
        .sort((left, right) => right.attemptCount - left.attemptCount)[0];
      const preliminaryAssessment = version?.assessments
        .filter(
          (assessment) => assessment.stage === 'preliminary' && assessment.status === 'complete'
        )
        .sort((left, right) => right.attempt - left.attempt)[0];
      if (!artifact || !claim || !version || !preliminaryJob?.gatewayJobId) return;
      await runResearchStage(
        claim,
        version,
        'deep',
        undefined,
        artifact,
        preliminaryJob.gatewayJobId,
        undefined,
        preliminaryAssessment,
        'user'
      );
    },
    [runResearchStage]
  );

  const reportClaimProblem = useCallback((claimId: string) => {
    void window.electron.showMessageBox({
      type: 'info',
      title: 'Report noted',
      message: 'This finding has been flagged locally.',
      detail: `Reference: ${claimId}. No transcript text was sent in this report.`,
      buttons: ['Done'],
    });
  }, []);

  const retryRefinement = useCallback(async () => {
    const api = liveApi();
    const artifact = stateRef.current.artifact;
    if (!api || !artifact) return;
    const snapshot = await api.getSnapshot();
    const snapshotAssets =
      snapshot.meetingId === artifact.id ? snapshot.finalizedAssets : ([] as LiveAudioAsset[]);
    const assets = snapshotAssets.some((asset) => asset.sourceKind === 'mixed')
      ? snapshotAssets
      : reconstructArtifactAudioAssets(artifact);
    await submitRefinement(artifact, assets);
  }, [submitRefinement]);

  const value = useMemo<LiveMeetingRuntimeValue>(
    () => ({
      state,
      meetings,
      devices: capture.devices,
      microphoneMeter: capture.microphoneMeter,
      systemMeter: capture.systemMeter,
      support,
      setSetup,
      startMeeting,
      pauseMeeting,
      resumeMeeting,
      stopMeeting,
      openMeeting,
      closeArtifact,
      deleteMeeting,
      renameSpeaker,
      swapSpeakers,
      factCheckSelection,
      rerunClaim,
      escalateClaim,
      reportClaimProblem,
      retryRefinement,
      openSource: async (url) => {
        const api = liveApi();
        if (api) await api.openSource(url);
      },
      selectClaim: (claimId) => dispatch({ type: 'claim_selected', claimId }),
      setViewVersion: (version) => dispatch({ type: 'view_version_changed', version }),
      setFollowingLive: (following) => dispatch({ type: 'following_live_changed', following }),
      jumpToLive: () => dispatch({ type: 'jumped_to_live' }),
      setClaimRailOpen: (open) => dispatch({ type: 'claim_rail_changed', open }),
      refreshDevices: capture.refreshDevices,
      testMicrophone: capture.testMicrophone,
      signInGateway,
      signOutGateway,
    }),
    [
      capture.devices,
      capture.microphoneMeter,
      capture.refreshDevices,
      capture.systemMeter,
      capture.testMicrophone,
      closeArtifact,
      deleteMeeting,
      factCheckSelection,
      meetings,
      openMeeting,
      pauseMeeting,
      renameSpeaker,
      reportClaimProblem,
      rerunClaim,
      escalateClaim,
      resumeMeeting,
      retryRefinement,
      startMeeting,
      state,
      setSetup,
      signInGateway,
      signOutGateway,
      stopMeeting,
      support,
      swapSpeakers,
    ]
  );

  useEffect(
    () => () => {
      for (const scheduler of claimSchedulersRef.current.values()) scheduler.dispose();
      claimSchedulersRef.current.clear();
      claimSchedulerArtifactsRef.current.clear();
      researchJobsInFlightRef.current.clear();
      refinementJobsInFlightRef.current.clear();
      refinementMeetingsInFlightRef.current.clear();
      recoveredCleanupJobsInFlightRef.current.clear();
      shownCleanupLimitationsRef.current.clear();
      manualFactCheckRequestsInFlightRef.current.clear();
      researchPollingAbortRef.current.abort();
      desiredSttSourcesRef.current = [];
      localSttSourcesRef.current.clear();
      sttSuspendedForGapRef.current = true;
      for (const session of activeSttSessionsRef.current.values()) session.adapter.close();
      activeSttSessionsRef.current.clear();
      streamingSttSourcesRef.current.clear();
      providerSessionSourcesRef.current.clear();
      providerSessionModelsRef.current.clear();
      pendingSttFramesRef.current.clear();
      for (const timer of rotationTimersRef.current.values()) window.clearTimeout(timer);
      for (const timer of reconnectTimersRef.current.values()) window.clearTimeout(timer);
      rotationTimersRef.current.clear();
      reconnectTimersRef.current.clear();
    },
    []
  );

  return (
    <LiveMeetingRuntimeContext.Provider value={value}>
      {children}
    </LiveMeetingRuntimeContext.Provider>
  );
}

export function useLiveMeetingRuntime(): LiveMeetingRuntimeValue {
  const value = useContext(LiveMeetingRuntimeContext);
  if (!value)
    throw new Error('useLiveMeetingRuntime must be used within LiveMeetingRuntimeProvider');
  return value;
}
