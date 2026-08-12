import type {
  Assessment,
  Claim,
  LiveMeetingState,
  LiveSetup,
  MeetingArtifact,
  ProviderSpeakerRevisionEvent,
  ProviderTurnEvent,
  RuntimeSnapshot,
  SourceKind,
  Speaker,
  TimelineEvent,
  TranscriptTurn,
  TranscriptVersionKind,
  TypedError,
} from './types';
import { transcriptTurnKey } from './types';
import { deduplicateSourceBleed } from './transcriptReconciler';

export type MeetingAction =
  | { type: 'setup_updated'; patch: Partial<LiveSetup> }
  | { type: 'meeting_start_requested'; gateway: RuntimeSnapshot['gateway'] }
  | { type: 'runtime_updated'; snapshot: RuntimeSnapshot }
  | { type: 'artifact_loaded'; artifact: MeetingArtifact }
  | {
      type: 'provider_turn';
      event: ProviderTurnEvent;
      speakerId?: string;
      turnId?: string;
      sourceKind?: SourceKind;
      provider?: string;
    }
  | { type: 'speaker_revision'; event: ProviderSpeakerRevisionEvent }
  | { type: 'speaker_renamed'; speakerId: string; displayName?: string }
  | { type: 'speakers_replaced'; speakers: Speaker[] }
  | { type: 'speakers_swapped'; firstSpeakerId: string; secondSpeakerId: string }
  | { type: 'turn_relabelled'; turnId: string; speakerId: string }
  | { type: 'timeline_added'; event: TimelineEvent }
  | { type: 'claim_upserted'; claim: Claim }
  | { type: 'claim_status_changed'; claimId: string; status: Claim['status'] }
  | { type: 'assessment_upserted'; claimId: string; assessment: Assessment }
  | { type: 'claim_selected'; claimId?: string }
  | { type: 'view_version_changed'; version: TranscriptVersionKind }
  | { type: 'following_live_changed'; following: boolean }
  | { type: 'jumped_to_live' }
  | { type: 'claim_rail_changed'; open: boolean }
  | { type: 'backpressure_changed'; active: boolean; reason?: 'gateway' | 'limit' }
  | { type: 'failed'; error: TypedError }
  | { type: 'capture_warning_recovered'; code: 'system_audio_silent' }
  | { type: 'error_cleared' }
  | { type: 'cleared' };

const emptyMeter = { rms: 0, peak: 0, active: false, silentForMs: 0 };
const emptySource = {
  state: 'unavailable' as const,
  meter: emptyMeter,
  droppedFrames: 0,
};

export const initialRuntimeSnapshot: RuntimeSnapshot = {
  lifecycle: 'setup',
  elapsedMs: 0,
  microphone: emptySource,
  system: emptySource,
  stt: 'disconnected',
  gateway: 'unavailable',
  refinement: 'not_started',
  activeProviderSessions: [],
};

export const initialMeetingState: LiveMeetingState = {
  setup: {
    title: '',
    mode: 'call',
    speakerNames: ['', ''],
    strategy: 'mixed_diarized',
    micOnly: false,
  },
  runtime: initialRuntimeSnapshot,
  activeTurns: {},
  turnOrder: [],
  viewVersion: 'live',
  followingLive: true,
  unseenFinalTurns: 0,
  claimRailOpen: true,
  backpressure: false,
};

export function hasDistinctRefinedTranscript(artifact: MeetingArtifact | undefined): boolean {
  const canonicalId = artifact?.canonicalTranscriptVersionId;
  if (!artifact || !canonicalId || canonicalId === artifact.liveTranscriptVersionId) return false;
  return artifact.versions.some(
    (version) =>
      version.id === canonicalId && version.kind === 'refined' && version.status === 'complete'
  );
}

function orderedTurnKeys(turns: Record<string, TranscriptTurn>): string[] {
  return Object.entries(turns)
    .sort(([, left], [, right]) => {
      if (left.startMs !== right.startMs) return left.startMs - right.startMs;
      if (left.providerSessionId !== right.providerSessionId) {
        return left.providerSessionId.localeCompare(right.providerSessionId);
      }
      return left.providerTurnOrder - right.providerTurnOrder;
    })
    .map(([key]) => key);
}

function applyProviderTurn(
  state: LiveMeetingState,
  event: ProviderTurnEvent,
  speakerId?: string,
  turnId?: string,
  sourceKind: SourceKind = 'mixed',
  provider = 'assemblyai'
): LiveMeetingState {
  const key = transcriptTurnKey(event.providerSessionId, event.turnId);
  const previous = state.activeTurns[key];
  if (previous && event.revision <= previous.revision) return state;

  const wasFinal = previous?.status === 'final' || previous?.status === 'revised';
  const isFinal = event.durableFinal;
  const turn: TranscriptTurn = {
    id: previous?.id ?? turnId ?? key,
    meetingId: state.runtime.meetingId ?? state.artifact?.id ?? '',
    transcriptVersionId:
      previous?.transcriptVersionId ?? state.artifact?.liveTranscriptVersionId ?? 'live-pending',
    provider,
    providerSessionId: event.providerSessionId,
    providerTurnId: event.turnId,
    providerTurnOrder: event.turnOrder,
    revision: event.revision,
    status: isFinal ? (previous ? 'revised' : 'final') : 'partial',
    speakerId: speakerId ?? previous?.speakerId,
    provisionalSpeakerLabel: event.speakerLabel ?? previous?.provisionalSpeakerLabel,
    sourceKind: previous?.sourceKind ?? sourceKind,
    startMs: event.startMs,
    endMs: event.endMs,
    text: event.transcript,
    words: event.words,
    utteranceBoundary: event.utteranceBoundary,
    endOfTurn: event.endOfTurn,
    formatted: event.turnIsFormatted,
    receivedAtMs: event.receivedAtMs,
    finalizedAtMs: previous?.finalizedAtMs ?? (isFinal ? event.receivedAtMs : undefined),
  };
  const activeTurns = Object.fromEntries(
    deduplicateSourceBleed(Object.values({ ...state.activeTurns, [key]: turn })).map(
      (candidate) => [
        transcriptTurnKey(candidate.providerSessionId, candidate.providerTurnId),
        candidate,
      ]
    )
  );
  const newlyFinalized = isFinal && !wasFinal && key in activeTurns;

  return {
    ...state,
    activeTurns,
    turnOrder: orderedTurnKeys(activeTurns),
    unseenFinalTurns:
      newlyFinalized && !state.followingLive ? state.unseenFinalTurns + 1 : state.unseenFinalTurns,
  };
}

function applySpeakerRevision(
  state: LiveMeetingState,
  event: ProviderSpeakerRevisionEvent
): LiveMeetingState {
  let changed = false;
  const activeTurns = { ...state.activeTurns };
  for (const revision of event.revisions) {
    const entry = Object.entries(activeTurns).find(
      ([, turn]) =>
        turn.providerSessionId === event.providerSessionId &&
        turn.providerTurnOrder === revision.turnOrder
    );
    if (!entry) continue;
    const [key, turn] = entry;
    if (
      turn.provisionalSpeakerLabel === revision.speakerLabel &&
      JSON.stringify(turn.words) === JSON.stringify(revision.words)
    ) {
      continue;
    }
    changed = true;
    activeTurns[key] = {
      ...turn,
      provisionalSpeakerLabel: revision.speakerLabel,
      words: revision.words.length > 0 ? revision.words : turn.words,
      revision: turn.revision + 1,
      status: turn.status === 'partial' ? 'partial' : 'revised',
    };
  }
  return changed ? { ...state, activeTurns } : state;
}

function updateArtifactSpeakers(
  artifact: MeetingArtifact | undefined,
  update: (speakers: Speaker[]) => Speaker[]
): MeetingArtifact | undefined {
  if (!artifact) return artifact;
  return { ...artifact, speakers: update(artifact.speakers), updatedAt: new Date().toISOString() };
}

function renameSpeaker(
  state: LiveMeetingState,
  speakerId: string,
  displayName?: string
): LiveMeetingState {
  const cleanName = displayName?.trim() || undefined;
  return {
    ...state,
    artifact: updateArtifactSpeakers(state.artifact, (speakers) =>
      speakers.map((speaker) =>
        speaker.id === speakerId
          ? {
              ...speaker,
              displayName: cleanName,
              displayNameSource: cleanName ? 'manual' : 'generic',
              manualAssignmentLocked: Boolean(cleanName),
            }
          : speaker
      )
    ),
  };
}

function swapSpeakers(
  state: LiveMeetingState,
  firstSpeakerId: string,
  secondSpeakerId: string
): LiveMeetingState {
  const activeTurns = Object.fromEntries(
    Object.entries(state.activeTurns).map(([key, turn]) => [
      key,
      {
        ...turn,
        speakerId:
          turn.speakerId === firstSpeakerId
            ? secondSpeakerId
            : turn.speakerId === secondSpeakerId
              ? firstSpeakerId
              : turn.speakerId,
      },
    ])
  );
  const artifact = state.artifact
    ? {
        ...state.artifact,
        turns: state.artifact.turns.map((turn) => ({
          ...turn,
          speakerId:
            turn.speakerId === firstSpeakerId
              ? secondSpeakerId
              : turn.speakerId === secondSpeakerId
                ? firstSpeakerId
                : turn.speakerId,
        })),
        claims: state.artifact.claims.map((claim) => ({
          ...claim,
          versions: claim.versions.map((version) => ({
            ...version,
            speakerId:
              version.speakerId === firstSpeakerId
                ? secondSpeakerId
                : version.speakerId === secondSpeakerId
                  ? firstSpeakerId
                  : version.speakerId,
          })),
        })),
      }
    : undefined;
  return { ...state, activeTurns, artifact };
}

function upsertAssessment(claim: Claim, assessment: Assessment): Claim {
  return {
    ...claim,
    versions: claim.versions.map((version) =>
      version.id === assessment.claimVersionId
        ? {
            ...version,
            assessments: [
              ...version.assessments.filter((existing) => existing.id !== assessment.id),
              assessment,
            ],
          }
        : version
    ),
    status:
      assessment.status === 'complete'
        ? assessment.stage === 'deep'
          ? 'complete'
          : 'preliminary'
        : claim.status,
    updatedAt: new Date().toISOString(),
  };
}

export function meetingReducer(state: LiveMeetingState, action: MeetingAction): LiveMeetingState {
  switch (action.type) {
    case 'setup_updated':
      return { ...state, setup: { ...state.setup, ...action.patch } };
    case 'meeting_start_requested':
      return {
        ...initialMeetingState,
        setup: state.setup,
        runtime: {
          ...initialRuntimeSnapshot,
          lifecycle: 'starting',
          gateway: action.gateway,
        },
      };
    case 'runtime_updated':
      return { ...state, runtime: action.snapshot };
    case 'artifact_loaded': {
      if (
        ['starting', 'recording', 'paused', 'stopping', 'finalizing'].includes(
          state.runtime.lifecycle
        ) &&
        (!state.runtime.meetingId || action.artifact.id !== state.runtime.meetingId)
      ) {
        return state;
      }
      const activeTurns = Object.fromEntries(
        action.artifact.turns.map((turn) => [
          transcriptTurnKey(turn.providerSessionId, turn.providerTurnId),
          turn,
        ])
      );
      return {
        ...state,
        artifact: action.artifact,
        activeTurns,
        turnOrder: orderedTurnKeys(activeTurns),
        viewVersion: hasDistinctRefinedTranscript(action.artifact) ? 'refined' : 'live',
      };
    }
    case 'provider_turn':
      if (
        state.runtime.meetingId &&
        state.artifact &&
        state.artifact.id !== state.runtime.meetingId
      ) {
        return state;
      }
      return applyProviderTurn(
        state,
        action.event,
        action.speakerId,
        action.turnId,
        action.sourceKind,
        action.provider
      );
    case 'speaker_revision':
      return applySpeakerRevision(state, action.event);
    case 'speaker_renamed':
      return renameSpeaker(state, action.speakerId, action.displayName);
    case 'speakers_replaced':
      return state.artifact
        ? { ...state, artifact: { ...state.artifact, speakers: action.speakers } }
        : state;
    case 'speakers_swapped':
      return swapSpeakers(state, action.firstSpeakerId, action.secondSpeakerId);
    case 'turn_relabelled': {
      const activeTurns = Object.fromEntries(
        Object.entries(state.activeTurns).map(([key, turn]) => [
          key,
          turn.id === action.turnId ? { ...turn, speakerId: action.speakerId } : turn,
        ])
      );
      return { ...state, activeTurns };
    }
    case 'timeline_added':
      return state.artifact
        ? {
            ...state,
            artifact: {
              ...state.artifact,
              timeline: [
                ...state.artifact.timeline.filter((event) => event.id !== action.event.id),
                action.event,
              ].sort((left, right) => left.startMs - right.startMs),
            },
          }
        : state;
    case 'claim_upserted':
      return state.artifact
        ? {
            ...state,
            artifact: {
              ...state.artifact,
              claims: [
                ...state.artifact.claims.filter((claim) => claim.id !== action.claim.id),
                action.claim,
              ].sort((left, right) => left.spokenAtMs - right.spokenAtMs),
            },
          }
        : state;
    case 'claim_status_changed':
      return state.artifact
        ? {
            ...state,
            artifact: {
              ...state.artifact,
              claims: state.artifact.claims.map((claim) =>
                claim.id === action.claimId
                  ? { ...claim, status: action.status, updatedAt: new Date().toISOString() }
                  : claim
              ),
            },
          }
        : state;
    case 'assessment_upserted':
      return state.artifact
        ? {
            ...state,
            artifact: {
              ...state.artifact,
              claims: state.artifact.claims.map((claim) =>
                claim.id === action.claimId ? upsertAssessment(claim, action.assessment) : claim
              ),
            },
          }
        : state;
    case 'claim_selected':
      return { ...state, selectedClaimId: action.claimId };
    case 'view_version_changed':
      return { ...state, viewVersion: action.version };
    case 'following_live_changed':
      return { ...state, followingLive: action.following };
    case 'jumped_to_live':
      return { ...state, followingLive: true, unseenFinalTurns: 0 };
    case 'claim_rail_changed':
      return { ...state, claimRailOpen: action.open };
    case 'backpressure_changed':
      return {
        ...state,
        backpressure: action.active,
        backpressureReason: action.active ? action.reason : undefined,
      };
    case 'failed':
      return { ...state, error: action.error };
    case 'capture_warning_recovered':
      return state.error?.code === action.code ? { ...state, error: undefined } : state;
    case 'error_cleared':
      return { ...state, error: undefined };
    case 'cleared':
      return initialMeetingState;
  }
}
