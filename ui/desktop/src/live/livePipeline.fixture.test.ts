import { describe, expect, it, vi } from 'vitest';
import {
  AssemblyStreamingAdapter,
  type StreamingSessionConfiguration,
} from './assemblyStreamingAdapter';
import { ClaimScheduler, type ClaimCandidate } from './claimScheduler';
import { initialMeetingState, meetingReducer } from './meetingReducer';
import { reconcileRefinement } from './refinementReconciler';
import {
  stableLiveUuid,
  transcriptTurnKey,
  type Assessment,
  type Claim,
  type MeetingArtifact,
  type Speaker,
  type StreamingTranscriptionEvent,
} from './types';

class ScriptedSttSocket {
  readyState: number = window.WebSocket.CONNECTING;
  binaryType = '';
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();

  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(value: unknown) {
    this.sent.push(value);
  }

  close(code = 1000) {
    this.readyState = window.WebSocket.CLOSED;
    this.emit('close', { code });
  }

  begin(model: string) {
    this.readyState = window.WebSocket.OPEN;
    this.message({ type: 'Begin', id: 'vendor-session-1', configuration: { model } });
  }

  message(value: Record<string, unknown>) {
    this.emit('message', { data: JSON.stringify(value) });
  }

  private emit(type: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const meetingId = '3703f37e-e2c7-4ee1-a7ac-09facbf0e357';
const liveVersionId = 'd45f451a-a20f-44bb-9ba5-54ce1d36b5cd';
const refinedVersionId = '727c39d3-29d8-47a3-9869-7e3202350527';
const speakerAId = 'ec333b08-3689-40b2-9df1-22bd1d27c55e';
const speakerBId = '3ee27558-2253-479b-a9d2-5c1a5c89c3ca';

const speakers: Speaker[] = [
  {
    id: speakerAId,
    defaultLabel: 'Speaker 1',
    displayName: 'Avery',
    displayNameSource: 'manual',
    manualAssignmentLocked: true,
  },
  {
    id: speakerBId,
    defaultLabel: 'Speaker 2',
    displayName: 'Morgan',
    displayNameSource: 'manual',
    manualAssignmentLocked: true,
  },
];

function emptyArtifact(): MeetingArtifact {
  return {
    id: meetingId,
    title: 'Fixture interview',
    artifactType: 'meeting',
    mode: 'call',
    status: 'recording',
    strategy: 'mixed_diarized',
    startedAtMs: 0,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    liveTranscriptVersionId: liveVersionId,
    refinementStatus: 'not_started',
    researchStatus: 'pending',
    versions: [
      {
        id: liveVersionId,
        meetingId,
        kind: 'live',
        status: 'active',
        revision: 0,
        provider: 'assemblyai',
        model: 'universal-streaming-english',
        createdAt: '2026-08-10T00:00:00.000Z',
      },
    ],
    turns: [],
    speakers,
    timeline: [],
    claims: [],
    manualFactCheckRequests: [],
    pendingClaimGateSegmentIds: [],
    pendingClaimGateBatches: [],
    audioAssets: [],
    researchJobs: [],
    refinementJobs: [],
  };
}

function configuration(): StreamingSessionConfiguration {
  return {
    token: 'fixture-token',
    providerSessionId: 'desktop-session-1',
    model: 'universal-streaming-english',
    sampleRate: 16_000,
    speakerLabels: true,
    expiresAtMs: Date.now() + 60_000,
    maxSessionDurationSeconds: 10_800,
  };
}

function completedAssessment(
  claimVersionId: string,
  stage: Assessment['stage'],
  attempt: number
): Assessment {
  return {
    id: stableLiveUuid(`fixture-assessment:${stage}:${attempt}`),
    claimVersionId,
    stage,
    attempt,
    status: 'complete',
    current: true,
    verdict: stage === 'deep' ? 'Disputed' : 'Needs context',
    confidence: stage === 'deep' ? 'High' : 'Medium',
    conclusion:
      stage === 'deep'
        ? 'The audited result was 12,000, not the stated 18,000.'
        : 'An early source reports an increase.',
    support: ['Participation increased year over year.'],
    contradiction: stage === 'deep' ? ['The audited total is lower than stated.'] : [],
    caveats: [],
    limitations: [],
    citations: {
      conclusion: [stage === 'deep' ? 'S2' : 'S1'],
      support: [[stage === 'deep' ? 'S2' : 'S1']],
      contradiction: stage === 'deep' ? [['S2']] : [],
      caveats: [],
      limitations: [],
    },
    sources: [
      {
        id: stableLiveUuid(`fixture-source:${stage}:${attempt}`),
        citationKey: stage === 'deep' ? 'S2' : 'S1',
        url: `https://example.org/${stage}`,
        canonicalUrl: `https://example.org/${stage}`,
        publisher: stage === 'deep' ? 'State Auditor' : 'Program Office',
        title: stage === 'deep' ? 'Audited table' : 'Program summary',
        accessedAt: '2026-08-10T00:00:00.000Z',
        excerpt: 'Participation increased.',
        stance: stage === 'deep' ? 'contradicts' : 'supports',
        qualityScore: stage === 'deep' ? 0.95 : 0.7,
        qualityRationale: stage === 'deep' ? 'Primary audited data.' : 'Official summary.',
      },
    ],
  };
}

describe('fixture-driven live pipeline', () => {
  it('normalizes scripted STT revisions, gates only finals, preserves research stages, and reconciles refinement', async () => {
    vi.useFakeTimers();
    let state = meetingReducer(
      {
        ...initialMeetingState,
        runtime: {
          ...initialMeetingState.runtime,
          meetingId,
          lifecycle: 'recording',
          stt: 'streaming',
        },
      },
      { type: 'artifact_loaded', artifact: emptyArtifact() }
    );
    const detectedBatches: Array<{ turnIds: string[]; texts: string[] }> = [];
    const acceptedCandidates: ClaimCandidate[] = [];

    const scheduler = new ClaimScheduler(
      meetingId,
      () => state.artifact?.claims ?? [],
      {
        beginBatch: async () => undefined,
        detect: async (batch) => {
          detectedBatches.push({
            turnIds: batch.turns.map((candidate) => candidate.id),
            texts: batch.turns.map((candidate) => candidate.text),
          });
          const anchor = batch.turns.find((candidate) => candidate.text.includes('18,000'));
          if (!anchor) return [];
          return [
            {
              exactQuote: anchor.text,
              normalizedClaim: 'The program served 18,000 people last year.',
              contextTurnIds: [anchor.id],
              speakerId: anchor.speakerId,
              startMs: anchor.startMs,
              endMs: anchor.endMs,
              checkworthy: true,
              consequenceScore: 0.9,
              disputeLikelihoodScore: 0.75,
              specificityScore: 0.95,
              timeSensitive: false,
              selectionRationale: 'Specific public-program participation total.',
              semanticDuplicateKey: 'program-participation-18000',
            },
          ];
        },
        commitBatch: async (_batch, candidates) => {
          for (const candidate of candidates) {
            acceptedCandidates.push(candidate);
            const claimId = stableLiveUuid(`fixture-claim:${candidate.semanticDuplicateKey}`);
            const versionId = stableLiveUuid(`fixture-claim-version:${claimId}:1`);
            const claim: Claim = {
              id: claimId,
              meetingId,
              origin: 'automatic',
              duplicateKey: candidate.semanticDuplicateKey,
              status: 'queued',
              currentVersionId: versionId,
              spokenAtMs: candidate.startMs,
              createdAt: '2026-08-10T00:00:00.000Z',
              updatedAt: '2026-08-10T00:00:00.000Z',
              versions: [
                {
                  id: versionId,
                  claimId,
                  version: 1,
                  sourceTranscriptVersionId: liveVersionId,
                  exactQuote: candidate.exactQuote,
                  normalizedClaim: candidate.normalizedClaim,
                  speakerId: candidate.speakerId,
                  startMs: candidate.startMs,
                  endMs: candidate.endMs,
                  segmentIds: candidate.contextTurnIds,
                  lifecycle: 'active',
                  createdAt: '2026-08-10T00:00:00.000Z',
                  assessments: [],
                },
              ],
            };
            state = meetingReducer(state, { type: 'claim_upserted', claim });
          }
        },
        onBackpressure: (active) => {
          state = meetingReducer(state, { type: 'backpressure_changed', active });
        },
      },
      {
        maxGateCallsPerHour: 30,
        maxAcceptedClaimsPerHour: 10,
        maxBurstClaims: 2,
        burstWindowMs: 60_000,
        minBatchDelayMs: 10_000,
        maxTurnsPerBatch: 4,
      },
      () => 10_000
    );

    const socket = new ScriptedSttSocket();
    const protocolEvents: StreamingTranscriptionEvent[] = [];
    const adapter = new AssemblyStreamingAdapter(
      configuration(),
      (event) => {
        protocolEvents.push(event);
        if (event.type === 'turn') {
          state = meetingReducer(state, {
            type: 'provider_turn',
            event,
            speakerId: event.turnOrder === 1 ? speakerAId : speakerBId,
            turnId: stableLiveUuid(`fixture-turn:${event.providerSessionId}:${event.turnId}`),
          });
          if (event.durableFinal) {
            const durable =
              state.activeTurns[transcriptTurnKey(event.providerSessionId, event.turnId)];
            scheduler.addFinalTurn(durable);
          }
        } else if (event.type === 'speaker_revision') {
          state = meetingReducer(state, { type: 'speaker_revision', event });
        }
      },
      () => socket as unknown as InstanceType<typeof window.WebSocket>
    );

    const connected = adapter.connect();
    socket.begin('universal-streaming-english');
    await connected;

    socket.message({
      type: 'Turn',
      turn_id: 'turn-1',
      turn_order: 1,
      speaker_label: 'A',
      transcript: 'The program served',
      turn_start: 0,
      turn_end: 550,
      end_of_turn: false,
      turn_is_formatted: false,
    });
    expect(state.turnOrder).toHaveLength(1);
    expect(Object.values(state.activeTurns)[0]).toMatchObject({
      text: 'The program served',
      status: 'partial',
      provisionalSpeakerLabel: 'A',
    });

    socket.message({
      type: 'Turn',
      turn_id: 'turn-1',
      turn_order: 1,
      speaker_label: 'B',
      transcript: 'The program served 18,000 people',
      turn_start: 0,
      turn_end: 1_050,
      end_of_turn: false,
      turn_is_formatted: false,
    });
    expect(state.turnOrder).toHaveLength(1);
    expect(Object.values(state.activeTurns)[0]).toMatchObject({
      text: 'The program served 18,000 people',
      status: 'partial',
      provisionalSpeakerLabel: 'B',
    });

    const unformattedFinal = {
      type: 'Turn',
      turn_id: 'turn-1',
      turn_order: 1,
      speaker_label: 'B',
      transcript: 'The program served 18,000 people last year.',
      turn_start: 0,
      turn_end: 1_600,
      end_of_turn: true,
      turn_is_formatted: false,
    };
    socket.message(unformattedFinal);
    expect(Object.values(state.activeTurns)[0].status).toBe('partial');

    const formattedFinal = { ...unformattedFinal, turn_is_formatted: true };
    socket.message(formattedFinal);
    socket.message(formattedFinal);
    socket.message({
      type: 'Turn',
      turn_id: 'turn-2',
      turn_order: 2,
      speaker_label: 'A',
      transcript: 'That number came from the annual summary.',
      turn_start: 1_650,
      turn_end: 2_900,
      end_of_turn: true,
      turn_is_formatted: true,
    });
    socket.message({
      type: 'SpeakerRevision',
      revisions: [
        { turn_order: 1, speaker_label: 'A', words: [] },
        { turn_order: 2, speaker_label: 'B', words: [] },
      ],
    });

    expect(state.turnOrder).toHaveLength(2);
    expect(state.activeTurns['desktop-session-1:turn-1']).toMatchObject({
      status: 'revised',
      provisionalSpeakerLabel: 'A',
      text: 'The program served 18,000 people last year.',
    });
    expect(state.activeTurns['desktop-session-1:turn-2']).toMatchObject({
      provisionalSpeakerLabel: 'B',
    });

    await scheduler.flush();
    expect(detectedBatches).toEqual([
      {
        turnIds: [
          stableLiveUuid('fixture-turn:desktop-session-1:turn-1'),
          stableLiveUuid('fixture-turn:desktop-session-1:turn-2'),
        ],
        texts: [
          'The program served 18,000 people last year.',
          'That number came from the annual summary.',
        ],
      },
    ]);
    expect(acceptedCandidates).toHaveLength(1);
    expect(state.artifact?.claims).toHaveLength(1);
    expect(state.backpressure).toBe(false);

    const claim = state.artifact!.claims[0];
    const preliminary = completedAssessment(claim.currentVersionId, 'preliminary', 1);
    state = meetingReducer(state, {
      type: 'assessment_upserted',
      claimId: claim.id,
      assessment: preliminary,
    });
    expect(state.artifact?.claims[0]).toMatchObject({ status: 'preliminary' });
    expect(state.artifact?.claims[0].versions[0].assessments).toEqual([preliminary]);

    const failedDeep: Assessment = {
      ...completedAssessment(claim.currentVersionId, 'deep', 1),
      status: 'failed',
      verdict: undefined,
      confidence: undefined,
      conclusion: undefined,
      sources: [],
      error: { code: 'gateway_timeout', message: 'Deep search timed out.', retryable: true },
    };
    state = meetingReducer(state, {
      type: 'assessment_upserted',
      claimId: claim.id,
      assessment: failedDeep,
    });
    expect(state.artifact?.claims[0].status).toBe('preliminary');
    expect(state.artifact?.claims[0].versions[0].assessments).toContainEqual(preliminary);

    const deep = completedAssessment(claim.currentVersionId, 'deep', 2);
    state = meetingReducer(state, {
      type: 'assessment_upserted',
      claimId: claim.id,
      assessment: deep,
    });
    expect(state.artifact?.claims[0].status).toBe('complete');
    expect(state.artifact?.claims[0].versions[0].assessments).toEqual([
      preliminary,
      failedDeep,
      deep,
    ]);

    const liveTurns = state.turnOrder.map((key) => state.activeTurns[key]);
    const reconciliation = reconcileRefinement(
      meetingId,
      refinedVersionId,
      liveTurns,
      [
        {
          id: 'refined-1',
          speakerCluster: 'A',
          text: 'The program served 12,000 people last year.',
          startMs: 20,
          endMs: 1_580,
          words: [],
        },
        {
          id: 'refined-2',
          speakerCluster: 'B',
          text: 'That number came from the audited annual summary.',
          startMs: 1_670,
          endMs: 2_880,
          words: [],
        },
      ],
      state.artifact!.speakers,
      state.artifact!.claims
    );

    expect(reconciliation.speakers).toEqual(speakers);
    expect(reconciliation.ambiguousClusterIds).toEqual([]);
    expect(reconciliation.materiallyChangedClaimIds).toEqual([claim.id]);
    expect(reconciliation.turns.map((candidate) => candidate.text)).toEqual([
      'The program served 12,000 people last year.',
      'That number came from the audited annual summary.',
    ]);

    state = meetingReducer(state, {
      type: 'artifact_loaded',
      artifact: {
        ...state.artifact!,
        status: 'complete',
        canonicalTranscriptVersionId: refinedVersionId,
        refinementStatus: 'complete',
        versions: [
          ...state.artifact!.versions,
          {
            id: refinedVersionId,
            meetingId,
            kind: 'refined',
            status: 'complete',
            revision: 0,
            provider: 'assemblyai',
            model: 'universal-3-pro',
            parentVersionId: liveVersionId,
            createdAt: '2026-08-10T00:01:00.000Z',
            completedAt: '2026-08-10T00:01:10.000Z',
          },
        ],
        turns: [...liveTurns, ...reconciliation.turns],
        speakers: reconciliation.speakers,
      },
    });
    expect(
      state.artifact?.turns.filter((candidate) => candidate.transcriptVersionId === liveVersionId)
    ).toHaveLength(2);
    expect(
      state.artifact?.turns.filter(
        (candidate) => candidate.transcriptVersionId === refinedVersionId
      )
    ).toHaveLength(2);
    expect(state.artifact?.canonicalTranscriptVersionId).toBe(refinedVersionId);
    expect(state.viewVersion).toBe('refined');

    const termination = adapter.terminate(100);
    expect(socket.sent).toContain(JSON.stringify({ type: 'Terminate' }));
    socket.message({
      type: 'Termination',
      audio_duration_seconds: 2.9,
      session_duration_seconds: 3.2,
    });
    await termination;
    expect(protocolEvents[protocolEvents.length - 1]).toMatchObject({ type: 'termination' });
    scheduler.dispose();
    vi.useRealTimers();
  });
});
