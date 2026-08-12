import { describe, expect, it } from 'vitest';
import { deduplicateSourceBleed, resolveProviderSpeaker } from './transcriptReconciler';
import type { TranscriptTurn } from './types';

function sourceTurn(sourceKind: 'microphone' | 'system', id: string): TranscriptTurn {
  return {
    id,
    meetingId: '98ebcb83-3a95-4fc4-b289-e3cce64ac7d6',
    transcriptVersionId: 'dd966fe5-56d5-4c9d-ac67-b96588311e61',
    provider: 'assemblyai',
    providerSessionId: `${sourceKind}-session`,
    providerTurnId: '1',
    providerTurnOrder: 1,
    revision: 0,
    status: 'final',
    sourceKind,
    startMs: 1_000,
    endMs: 2_000,
    text: 'The annual grant closes on October 31.',
    words: [
      {
        id: `${id}-word`,
        text: 'grant',
        startMs: 1_100,
        endMs: 1_300,
        confidence: 0.9,
        final: true,
      },
    ],
    utteranceBoundary: true,
    endOfTurn: true,
    formatted: true,
    receivedAtMs: 2_100,
  };
}

describe('transcript speaker/source reconciliation', () => {
  it('scopes identical provider labels to their streaming session', () => {
    const first = resolveProviderSpeaker([], [], 'session-one', 'A', 'mixed');
    const second = resolveProviderSpeaker(
      first.speakers,
      first.observation ? [first.observation] : [],
      'session-two',
      'A',
      'mixed'
    );
    expect(second.speaker?.id).not.toBe(first.speaker?.id);
    expect(second.observation).toMatchObject({
      providerSessionId: 'session-two',
      providerLabel: 'A',
    });
  });

  it('removes high-overlap cross-source bleed without merging provider identities', () => {
    const microphone = sourceTurn('microphone', 'c04374fb-4ca1-4315-b4ad-020a3f4f27b0');
    const system = sourceTurn('system', '6417cf3f-ded7-4d7a-b506-c0fb6301a763');
    const deduplicated = deduplicateSourceBleed([microphone, system]);
    expect(deduplicated).toHaveLength(1);
    expect([microphone.id, system.id]).toContain(deduplicated[0].id);
  });
});
