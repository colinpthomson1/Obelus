import { describe, expect, it } from 'vitest';
import { materiallyChangesMeaning, reconcileRefinement } from './refinementReconciler';
import type { Claim, Speaker, TranscriptTurn } from './types';

const speaker: Speaker = {
  id: 'speaker-1',
  defaultLabel: 'Speaker 1',
  displayName: 'Avery',
  displayNameSource: 'manual',
  manualAssignmentLocked: true,
};

const liveTurn: TranscriptTurn = {
  id: 'live-1',
  meetingId: 'meeting-1',
  transcriptVersionId: 'live-version',
  provider: 'assemblyai',
  providerSessionId: 'live-session',
  providerTurnId: '1',
  providerTurnOrder: 1,
  revision: 0,
  status: 'final',
  speakerId: 'speaker-1',
  sourceKind: 'mixed',
  startMs: 1_000,
  endMs: 4_000,
  text: 'Participation nearly doubled in a single year.',
  words: [],
  utteranceBoundary: true,
  endOfTurn: true,
  formatted: true,
  receivedAtMs: 5_000,
};

describe('refinement reconciliation', () => {
  it('detects materially changed numbers but not punctuation cleanup', () => {
    expect(
      materiallyChangesMeaning(
        'Participation increased 92 percent.',
        'Participation increased 71 percent.'
      )
    ).toBe(true);
    expect(
      materiallyChangesMeaning(
        'Participation nearly doubled in a single year',
        'Participation nearly doubled in a single year.'
      )
    ).toBe(false);
  });

  it('maps refined clusters by overlap while preserving a manual display name', () => {
    const claim: Claim = {
      id: 'claim-1',
      meetingId: 'meeting-1',
      origin: 'automatic',
      duplicateKey: 'participation',
      status: 'complete',
      currentVersionId: 'claim-version-1',
      spokenAtMs: 1_000,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      versions: [
        {
          id: 'claim-version-1',
          claimId: 'claim-1',
          version: 1,
          sourceTranscriptVersionId: 'live-version',
          exactQuote: liveTurn.text,
          normalizedClaim: liveTurn.text,
          speakerId: 'speaker-1',
          startMs: 1_000,
          endMs: 4_000,
          segmentIds: ['live-1'],
          lifecycle: 'active',
          createdAt: '2026-01-01T00:00:00Z',
          assessments: [],
        },
      ],
    };
    const result = reconcileRefinement(
      'meeting-1',
      'refined-version',
      [liveTurn],
      [
        {
          id: 'refined-1',
          speakerCluster: 'A',
          text: 'Participation increased by 71 percent in a single year.',
          startMs: 1_050,
          endMs: 3_950,
          words: [],
        },
      ],
      [speaker],
      [claim]
    );
    expect(result.turns[0].speakerId).toBe('speaker-1');
    expect(result.speakers[0].displayName).toBe('Avery');
    expect(result.materiallyChangedClaimIds).toEqual(['claim-1']);
  });

  it('namespaces newly discovered speaker IDs by meeting', () => {
    const segment = {
      id: 'refined-1',
      speakerCluster: 'A',
      text: 'A newly identified speaker.',
      startMs: 0,
      endMs: 1_000,
      words: [],
    };
    const first = reconcileRefinement('meeting-1', 'refined-version-1', [], [segment], [], []);
    const second = reconcileRefinement('meeting-2', 'refined-version-2', [], [segment], [], []);

    expect(first.speakers[0].id).not.toBe(second.speakers[0].id);
    expect(
      reconcileRefinement('meeting-1', 'replayed-version', [], [segment], [], []).speakers[0].id
    ).toBe(first.speakers[0].id);
  });
});
