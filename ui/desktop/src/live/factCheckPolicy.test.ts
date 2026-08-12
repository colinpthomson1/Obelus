import { describe, expect, it } from 'vitest';
import type { Assessment } from './types';
import {
  normalizeFinding,
  policyRecommendsDeepResearch,
  preferredAssessment,
} from './factCheckPolicy';

function assessment(patch: Partial<Assessment>): Assessment {
  return {
    id: patch.id ?? 'assessment_1',
    claimVersionId: 'version_1',
    stage: patch.stage ?? 'preliminary',
    attempt: patch.attempt ?? 1,
    status: 'complete',
    current: true,
    verdict: patch.verdict ?? 'Supported',
    confidence: patch.confidence ?? 'High',
    conclusion: patch.conclusion ?? 'A cited conclusion.',
    support: [],
    contradiction: [],
    caveats: [],
    limitations: [],
    citations: patch.citations ?? {
      conclusion: ['S1'],
      support: [],
      contradiction: [],
      caveats: [],
      limitations: [],
    },
    sources: patch.sources ?? [
      {
        id: 'source_1',
        citationKey: 'S1',
        url: 'https://example.org/one',
        canonicalUrl: 'https://example.org/one',
        publisher: 'Example',
        title: 'Source one',
        accessedAt: '2030-01-01T00:00:00.000Z',
        excerpt: 'Evidence.',
        stance: 'supports',
        qualityScore: 0.8,
        qualityRationale: 'Primary evidence.',
      },
    ],
    ...patch,
  };
}

describe('fact-check policy', () => {
  it('normalizes legacy and V2 findings to the four UI labels', () => {
    expect(normalizeFinding('mostly_supported')).toBe('Supported');
    expect(normalizeFinding('unsupported')).toBe('Disputed');
    expect(normalizeFinding('mixed')).toBe('Needs context');
    expect(normalizeFinding('unverifiable')).toBe('Unverified');
  });

  it('requires an explicit policy recommendation before escalating', () => {
    expect(policyRecommendsDeepResearch('quick', {})).toBe(false);
    expect(policyRecommendsDeepResearch('quick', { escalation: { recommended: true } })).toBe(true);
    expect(policyRecommendsDeepResearch('deep', { escalation: { recommended: true } })).toBe(false);
  });

  it('retains a stronger preliminary assessment against weaker deep output', () => {
    const preliminary = assessment({ id: 'preliminary', verdict: 'Supported', confidence: 'High' });
    const deep = assessment({
      id: 'deep',
      stage: 'deep',
      verdict: 'Needs context',
      confidence: 'Medium',
    });

    expect(preferredAssessment(preliminary, deep)).toBe(preliminary);
  });

  it('allows a changed deep finding only with cited new evidence and an explanation', () => {
    const preliminary = assessment({
      id: 'preliminary',
      verdict: 'Supported',
      confidence: 'Medium',
    });
    const deep = assessment({
      id: 'deep',
      stage: 'deep',
      verdict: 'Disputed',
      changeExplanation: 'A newly retrieved audit changes the finding.',
      changeExplanationCitations: ['S2'],
      citations: {
        conclusion: ['S2'],
        support: [],
        contradiction: [['S2']],
        caveats: [],
        limitations: [],
      },
      contradiction: ['The new audit directly contradicts the claim.'],
      sources: [
        {
          ...preliminary.sources[0],
          id: 'source_2',
          citationKey: 'S2',
          url: 'https://example.org/two',
          canonicalUrl: 'https://example.org/two',
        },
      ],
    });

    expect(preferredAssessment(preliminary, deep)).toBe(deep);
  });

  it('uses the SQLite current flag as the durable canonical resolver after reload', () => {
    const preliminary = assessment({ id: 'preliminary', current: false });
    const deep = assessment({
      id: 'deep',
      stage: 'deep',
      current: true,
      verdict: 'Disputed',
      changeExplanation: undefined,
      changeExplanationCitations: undefined,
    });

    expect(preferredAssessment(preliminary, deep)).toBe(deep);
  });
});
