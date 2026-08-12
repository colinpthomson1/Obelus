import { describe, expect, it } from 'vitest';
import { initialMeetingState, meetingReducer } from './meetingReducer';
import type { MeetingArtifact, ProviderTurnEvent } from './types';

function turn(patch: Partial<ProviderTurnEvent> = {}): ProviderTurnEvent {
  return {
    type: 'turn',
    providerSessionId: 'session-1',
    turnId: '7',
    turnOrder: 7,
    revision: 0,
    transcript: 'Participation',
    speakerLabel: 'A',
    words: [],
    startMs: 1_000,
    endMs: 1_400,
    utteranceBoundary: false,
    endOfTurn: false,
    turnIsFormatted: false,
    durableFinal: false,
    receivedAtMs: 2_000,
    ...patch,
  };
}

function artifactFixture(patch: Partial<MeetingArtifact> = {}): MeetingArtifact {
  return {
    id: 'f46bc702-a584-4f71-b3e8-3b8ae7bc5f7f',
    title: 'Lifecycle fixture',
    artifactType: 'meeting',
    mode: 'call',
    status: 'recording',
    strategy: 'mixed_diarized',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    refinementStatus: 'not_started',
    researchStatus: 'pending',
    versions: [],
    turns: [],
    speakers: [],
    timeline: [],
    claims: [],
    manualFactCheckRequests: [],
    pendingClaimGateSegmentIds: [],
    pendingClaimGateBatches: [],
    audioAssets: [],
    researchJobs: [],
    refinementJobs: [],
    ...patch,
  };
}

describe('meetingReducer', () => {
  it('starts a fresh meeting without carrying the selected artifact or its runtime forward', () => {
    const previous = meetingReducer(
      meetingReducer(initialMeetingState, {
        type: 'artifact_loaded',
        artifact: artifactFixture({ id: 'previous-meeting', title: 'Previous meeting' }),
      }),
      {
        type: 'runtime_updated',
        snapshot: {
          ...initialMeetingState.runtime,
          meetingId: 'previous-meeting',
          lifecycle: 'complete',
          elapsedMs: 58_000,
          stt: 'closed',
          refinement: 'failed',
        },
      }
    );
    const titled = meetingReducer(previous, {
      type: 'setup_updated',
      patch: { title: 'Fresh title' },
    });

    const starting = meetingReducer(titled, {
      type: 'meeting_start_requested',
      gateway: 'unavailable',
    });

    expect(starting.setup.title).toBe('Fresh title');
    expect(starting.artifact).toBeUndefined();
    expect(starting.activeTurns).toEqual({});
    expect(starting.runtime.meetingId).toBeUndefined();
    expect(starting.runtime).toMatchObject({
      lifecycle: 'starting',
      elapsedMs: 0,
      stt: 'disconnected',
      refinement: 'not_started',
    });
  });

  it('ignores a stale artifact load while another meeting owns the active runtime', () => {
    const active = meetingReducer(
      meetingReducer(initialMeetingState, {
        type: 'artifact_loaded',
        artifact: artifactFixture({ id: 'meeting-b', title: 'Meeting B' }),
      }),
      {
        type: 'runtime_updated',
        snapshot: {
          ...initialMeetingState.runtime,
          meetingId: 'meeting-b',
          lifecycle: 'recording',
        },
      }
    );

    const stale = meetingReducer(active, {
      type: 'artifact_loaded',
      artifact: artifactFixture({ id: 'meeting-a', title: 'Meeting A' }),
    });

    expect(stale).toBe(active);
    expect(stale.artifact?.id).toBe('meeting-b');
  });

  it('keeps the on-device transcription provider on local turns', () => {
    const state = meetingReducer(initialMeetingState, {
      type: 'provider_turn',
      event: turn({ durableFinal: true, transcript: 'Local words appear.' }),
      provider: 'faster_whisper',
      sourceKind: 'mixed',
    });

    expect(Object.values(state.activeTurns)[0]).toMatchObject({
      provider: 'faster_whisper',
      text: 'Local words appear.',
      sourceKind: 'mixed',
    });
  });

  it('clears only the system-audio silence warning when capture later becomes active', () => {
    const silenceWarning = meetingReducer(initialMeetingState, {
      type: 'failed',
      error: {
        code: 'system_audio_silent',
        message: 'System Audio is connected but silent.',
        retryable: true,
      },
    });

    const recovered = meetingReducer(silenceWarning, {
      type: 'capture_warning_recovered',
      code: 'system_audio_silent',
    });

    expect(recovered.error).toBeUndefined();

    const unrelatedFailure = meetingReducer(silenceWarning, {
      type: 'failed',
      error: {
        code: 'audio_writer_unavailable',
        message: 'Local audio could not be written.',
        retryable: false,
      },
    });
    const preserved = meetingReducer(unrelatedFailure, {
      type: 'capture_warning_recovered',
      code: 'system_audio_silent',
    });

    expect(preserved).toBe(unrelatedFailure);
    expect(preserved.error?.code).toBe('audio_writer_unavailable');

    const noWarning = meetingReducer(initialMeetingState, {
      type: 'capture_warning_recovered',
      code: 'system_audio_silent',
    });
    expect(noWarning).toBe(initialMeetingState);
  });

  it('does not present the live canonical version as refined and transitions after refinement', () => {
    const liveVersionId = '1738bb22-aa73-43d9-bf1d-f5622d9ccbc0';
    const refinedVersionId = '94c15b58-6aaa-41e0-9bca-dcfda2838935';
    const liveArtifact = artifactFixture({
      liveTranscriptVersionId: liveVersionId,
      canonicalTranscriptVersionId: liveVersionId,
      versions: [
        {
          id: liveVersionId,
          meetingId: 'f46bc702-a584-4f71-b3e8-3b8ae7bc5f7f',
          kind: 'live',
          status: 'active',
          revision: 0,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const liveState = meetingReducer(initialMeetingState, {
      type: 'artifact_loaded',
      artifact: liveArtifact,
    });
    expect(liveState.viewVersion).toBe('live');

    const refinedState = meetingReducer(liveState, {
      type: 'artifact_loaded',
      artifact: {
        ...liveArtifact,
        canonicalTranscriptVersionId: refinedVersionId,
        versions: [
          ...liveArtifact.versions,
          {
            id: refinedVersionId,
            meetingId: liveArtifact.id,
            kind: 'refined',
            status: 'complete',
            revision: 1,
            createdAt: '2026-01-01T00:10:00Z',
          },
        ],
      },
    });
    expect(refinedState.viewVersion).toBe('refined');
  });

  it('updates a main-process timeline event in place when its gap closes', () => {
    const loaded = meetingReducer(initialMeetingState, {
      type: 'artifact_loaded',
      artifact: artifactFixture(),
    });
    const open = meetingReducer(loaded, {
      type: 'timeline_added',
      event: {
        id: '660842f5-c78f-45ea-bf61-d9f34f518c0c',
        meetingId: loaded.artifact!.id,
        kind: 'pause',
        startMs: 1_000,
        label: 'Recording paused',
      },
    });
    const closed = meetingReducer(open, {
      type: 'timeline_added',
      event: {
        ...open.artifact!.timeline[0],
        endMs: 6_000,
      },
    });

    expect(closed.artifact?.timeline).toHaveLength(1);
    expect(closed.artifact?.timeline[0]).toMatchObject({ startMs: 1_000, endMs: 6_000 });
  });

  it('revises a partial in the same speaker-adjacent turn without duplication', () => {
    const first = meetingReducer(initialMeetingState, {
      type: 'provider_turn',
      event: turn(),
      speakerId: 'speaker-1',
    });
    const revised = meetingReducer(first, {
      type: 'provider_turn',
      event: turn({ revision: 1, transcript: 'Participation nearly doubled' }),
      speakerId: 'speaker-1',
    });

    expect(revised.turnOrder).toHaveLength(1);
    expect(Object.values(revised.activeTurns)[0]).toMatchObject({
      text: 'Participation nearly doubled',
      speakerId: 'speaker-1',
      provisionalSpeakerLabel: 'A',
      status: 'partial',
    });
  });

  it('ignores stale revisions and promotes a formatted final exactly once', () => {
    const partial = meetingReducer(initialMeetingState, {
      type: 'provider_turn',
      event: turn({ revision: 2, transcript: 'The grant closes October 31.' }),
    });
    const stale = meetingReducer(partial, {
      type: 'provider_turn',
      event: turn({ revision: 1, transcript: 'The grant closes.' }),
    });
    const final = meetingReducer(stale, {
      type: 'provider_turn',
      event: turn({
        revision: 3,
        transcript: 'The grant closes on October 31.',
        endOfTurn: true,
        turnIsFormatted: true,
        durableFinal: true,
      }),
    });
    const duplicate = meetingReducer(final, {
      type: 'provider_turn',
      event: turn({
        revision: 3,
        transcript: 'The grant closes on October 31.',
        endOfTurn: true,
        turnIsFormatted: true,
        durableFinal: true,
      }),
    });

    expect(stale).toBe(partial);
    expect(Object.values(final.activeTurns)[0].status).toBe('revised');
    expect(duplicate).toBe(final);
  });

  it('applies speaker-only revisions without changing text or turn identity', () => {
    const original = meetingReducer(initialMeetingState, {
      type: 'provider_turn',
      event: turn({ durableFinal: true, endOfTurn: true }),
    });
    const revised = meetingReducer(original, {
      type: 'speaker_revision',
      event: {
        type: 'speaker_revision',
        providerSessionId: 'session-1',
        revisions: [{ turnOrder: 7, speakerLabel: 'B', words: [] }],
      },
    });

    const before = Object.values(original.activeTurns)[0];
    const after = Object.values(revised.activeTurns)[0];
    expect(after.id).toBe(before.id);
    expect(after.text).toBe(before.text);
    expect(after.provisionalSpeakerLabel).toBe('B');
  });

  it('keeps claim order chronological when results arrive out of order', () => {
    const artifact = {
      id: 'meeting-1',
      title: 'Interview',
      artifactType: 'meeting' as const,
      mode: 'call' as const,
      status: 'recording' as const,
      strategy: 'mixed_diarized' as const,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      refinementStatus: 'not_started' as const,
      researchStatus: 'pending' as const,
      versions: [],
      turns: [],
      speakers: [],
      timeline: [],
      claims: [],
      manualFactCheckRequests: [],
      pendingClaimGateSegmentIds: [],
      pendingClaimGateBatches: [],
      audioAssets: [],
      researchJobs: [],
      refinementJobs: [],
    };
    const withArtifact = meetingReducer(initialMeetingState, { type: 'artifact_loaded', artifact });
    const claim = (id: string, spokenAtMs: number) => ({
      id,
      meetingId: 'meeting-1',
      origin: 'automatic' as const,
      duplicateKey: id,
      status: 'queued' as const,
      currentVersionId: `${id}-v1`,
      versions: [],
      spokenAtMs,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const later = meetingReducer(withArtifact, {
      type: 'claim_upserted',
      claim: claim('later', 9_000),
    });
    const earlier = meetingReducer(later, {
      type: 'claim_upserted',
      claim: claim('earlier', 1_000),
    });
    expect(earlier.artifact?.claims.map((item) => item.id)).toEqual(['earlier', 'later']);
  });

  it('propagates rename and swap repairs through active, durable, and claim speaker anchors', () => {
    const firstSpeaker = '40d5d5cd-0841-49d3-8e67-900320298346';
    const secondSpeaker = 'e6006b95-1287-4095-9cc1-3c7002c7048c';
    const activeTurn = turn({ durableFinal: true, endOfTurn: true });
    let state = meetingReducer(initialMeetingState, {
      type: 'provider_turn',
      event: activeTurn,
      speakerId: firstSpeaker,
      turnId: 'ab634bcd-b7a3-4a95-8075-89d09dd29071',
    });
    state = meetingReducer(state, {
      type: 'artifact_loaded',
      artifact: {
        id: 'f46bc702-a584-4f71-b3e8-3b8ae7bc5f7f',
        title: 'Repair fixture',
        artifactType: 'meeting',
        mode: 'call',
        status: 'recording',
        strategy: 'mixed_diarized',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        refinementStatus: 'not_started',
        researchStatus: 'pending',
        versions: [],
        turns: [
          {
            ...Object.values(state.activeTurns)[0],
            speakerId: firstSpeaker,
          },
        ],
        speakers: [
          {
            id: firstSpeaker,
            defaultLabel: 'Speaker 1',
            displayNameSource: 'generic',
            manualAssignmentLocked: false,
          },
          {
            id: secondSpeaker,
            defaultLabel: 'Speaker 2',
            displayNameSource: 'generic',
            manualAssignmentLocked: false,
          },
        ],
        timeline: [],
        claims: [
          {
            id: '7c8c6358-c399-4420-a94c-0b0bc99fc614',
            meetingId: 'f46bc702-a584-4f71-b3e8-3b8ae7bc5f7f',
            origin: 'automatic',
            duplicateKey: 'speaker-anchor',
            status: 'queued',
            currentVersionId: '94c15b58-6aaa-41e0-9bca-dcfda2838935',
            spokenAtMs: 1_000,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            versions: [
              {
                id: '94c15b58-6aaa-41e0-9bca-dcfda2838935',
                claimId: '7c8c6358-c399-4420-a94c-0b0bc99fc614',
                version: 1,
                exactQuote: activeTurn.transcript,
                normalizedClaim: activeTurn.transcript,
                speakerId: firstSpeaker,
                segmentIds: ['ab634bcd-b7a3-4a95-8075-89d09dd29071'],
                lifecycle: 'active',
                createdAt: '2026-01-01T00:00:00Z',
                assessments: [],
              },
            ],
          },
        ],
        manualFactCheckRequests: [],
        pendingClaimGateSegmentIds: [],
        pendingClaimGateBatches: [],
        audioAssets: [],
        researchJobs: [],
        refinementJobs: [],
      },
    });

    state = meetingReducer(state, {
      type: 'speaker_renamed',
      speakerId: firstSpeaker,
      displayName: 'Avery',
    });
    expect(state.artifact?.speakers[0]).toMatchObject({
      displayName: 'Avery',
      displayNameSource: 'manual',
      manualAssignmentLocked: true,
    });

    state = meetingReducer(state, {
      type: 'speakers_swapped',
      firstSpeakerId: firstSpeaker,
      secondSpeakerId: secondSpeaker,
    });
    expect(Object.values(state.activeTurns)[0].speakerId).toBe(secondSpeaker);
    expect(state.artifact?.turns[0].speakerId).toBe(secondSpeaker);
    expect(state.artifact?.claims[0].versions[0].speakerId).toBe(secondSpeaker);
  });
});
