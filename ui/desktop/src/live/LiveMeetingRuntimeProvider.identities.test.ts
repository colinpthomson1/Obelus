import { describe, expect, it, vi } from 'vitest';
import {
  assessmentDto,
  localAssessment,
  manualClaimIdentity,
  publishAssessmentAfterPersistence,
  refinedTranscriptVersionIdentity,
  refinementClaimVersionDtos,
} from './LiveMeetingRuntimeProvider';
import type { MeetingArtifact, TranscriptTurn } from './types';

describe('gateway result replay identities', () => {
  it('derives deterministic manual child claim IDs from the durable parent request', () => {
    const first = manualClaimIdentity('meeting-1', 'manual-request-1', 'semantic-child-1');
    expect(manualClaimIdentity('meeting-1', 'manual-request-1', 'semantic-child-1')).toEqual(first);
    expect(manualClaimIdentity('meeting-1', 'manual-request-1', 'semantic-child-2')).not.toEqual(
      first
    );
  });

  it('rebuilds the same assessment and source IDs after a lost ACP response', () => {
    const result: Parameters<typeof localAssessment>[1] = {
      stage: 'preliminary',
      originalQuote: 'The program served 18,000 people.',
      normalizedClaim: 'The program served 18,000 people.',
      verdict: 'Supported',
      confidence: 'High',
      conclusion: 'The published total supports the claim.',
      conclusionCitationIds: ['source-1'],
      statements: [],
      supports: [{ text: 'The annual report lists 18,000 people.', citationIds: ['source-1'] }],
      contradictions: [],
      caveats: [],
      limitations: [],
      sources: [
        {
          citationId: 'source-1',
          stance: 'supports',
          qualityScore: 0.9,
          qualityRationale: 'Primary annual report.',
        },
      ],
      inventory: [
        {
          citationId: 'source-1',
          url: 'https://example.com/report',
          canonicalUrl: 'https://example.com/report',
          publisher: 'Program Office',
          title: 'Annual report',
          publicationDate: '2026-01-01',
          accessedAt: '2026-08-10T00:00:00.000Z',
          excerpt: '18,000 people received services.',
        },
      ],
      completedAt: '2026-08-10T00:00:05.000Z',
      aiGenerated: true,
    };

    const first = localAssessment('claim-version-1', result, 1, 'gateway-job-1');
    const replay = localAssessment('claim-version-1', result, 1, 'gateway-job-1');

    expect(replay).toEqual(first);
    expect(replay.id).toBe(first.id);
    expect(replay.sources.map((source) => source.id)).toEqual(
      first.sources.map((source) => source.id)
    );
  });

  it('maps a valid empty-evidence result to a structurally empty factual assessment', () => {
    const result: Parameters<typeof localAssessment>[1] = {
      stage: 'preliminary',
      originalQuote: 'Barnes and Noble is bigger than Amazon.',
      normalizedClaim: 'Barnes and Noble is bigger than Amazon.',
      verdict: 'Unverified',
      confidence: 'Low',
      conclusion: 'No retrievable evidence was available for this check.',
      conclusionCitationIds: [],
      statements: [],
      supports: [],
      contradictions: [],
      caveats: [],
      limitations: [],
      sources: [],
      inventory: [],
      completedAt: '2026-08-10T00:00:05.000Z',
      aiGenerated: true,
    };
    const assessment = localAssessment('claim-version-1', result, 1, 'gateway-job-1');
    const dto = assessmentDto(assessment, result, null, 1_000);

    expect(assessment).toMatchObject({
      verdict: 'Unverified',
      confidence: 'Low',
      error: {
        code: 'evidence_unavailable',
        retryable: false,
      },
    });
    expect(assessment.conclusion).toBeUndefined();
    expect(assessment.sources).toEqual([]);
    expect(dto.conclusion).toEqual([]);
    expect(dto.support).toEqual([]);
    expect(dto.contradiction).toEqual([]);
    expect(dto.caveats).toEqual([]);
    expect(dto.limitations).toEqual([]);
    expect(dto.sources).toEqual([]);
    expect(dto.error).toMatchObject({ code: 'evidence_unavailable', retryable: false });
  });

  it('persists truthful local model provenance in the assessment DTO', () => {
    const result: Parameters<typeof localAssessment>[1] = {
      stage: 'preliminary',
      originalQuote: 'Barnes and Noble is bigger than Amazon.',
      normalizedClaim: 'Barnes and Noble is bigger than Amazon.',
      verdict: 'Unverifiable',
      confidence: 'Low',
      conclusion: 'The comparison does not specify a common size metric.',
      conclusionCitationIds: ['wikipedia-barnes', 'wikipedia-amazon'],
      statements: [],
      supports: [],
      contradictions: [],
      caveats: [],
      limitations: [
        {
          text: 'This preliminary check is limited to English Wikipedia and Wikidata.',
          citationIds: ['wikipedia-barnes', 'wikipedia-amazon'],
        },
      ],
      sources: [
        {
          citationId: 'wikipedia-barnes',
          stance: 'context',
          qualityScore: 0.65,
          qualityRationale: 'Secondary reference source.',
        },
        {
          citationId: 'wikipedia-amazon',
          stance: 'context',
          qualityScore: 0.65,
          qualityRationale: 'Secondary reference source.',
        },
      ],
      inventory: [
        {
          citationId: 'wikipedia-barnes',
          url: 'https://en.wikipedia.org/wiki/Barnes_%26_Noble',
          canonicalUrl: 'https://en.wikipedia.org/wiki/Barnes_%26_Noble',
          publisher: 'Wikipedia',
          title: 'Barnes & Noble',
          publicationDate: null,
          accessedAt: '2026-08-10T00:00:00.000Z',
          excerpt: 'Barnes & Noble is an American bookseller.',
        },
        {
          citationId: 'wikipedia-amazon',
          url: 'https://en.wikipedia.org/wiki/Amazon_(company)',
          canonicalUrl: 'https://en.wikipedia.org/wiki/Amazon_(company)',
          publisher: 'Wikipedia',
          title: 'Amazon',
          publicationDate: null,
          accessedAt: '2026-08-10T00:00:00.000Z',
          excerpt: 'Amazon is an American technology company.',
        },
      ],
      completedAt: '2026-08-10T00:00:05.000Z',
      aiGenerated: true,
      provenance: {
        provider: 'ollama',
        model: 'qwen3.5:9b-q4_K_M',
        local: true,
        evidenceScope: 'English Wikipedia and Wikidata',
      },
    };

    const assessment = localAssessment('claim-version-1', result, 1, 'local-fact-job-1');
    const dto = assessmentDto(assessment, result, null, 1_000);

    expect(dto).toMatchObject({
      modelProvider: 'ollama',
      model: 'qwen3.5:9b-q4_K_M',
    });
  });

  it('does not publish a completed verdict before durable ACP validation succeeds', async () => {
    const publish = vi.fn();
    await expect(
      publishAssessmentAfterPersistence(
        async () => {
          throw new Error('ACP rejected unknown citation');
        },
        'claim-1',
        'claim-version-1',
        'assessment-1',
        publish
      )
    ).rejects.toThrow('ACP rejected unknown citation');
    expect(publish).not.toHaveBeenCalled();
  });

  it('rebuilds the same refined version and successor claim payload after a lost response', () => {
    const artifact = {
      id: 'meeting-1',
      claims: [
        {
          id: 'claim-1',
          meetingId: 'meeting-1',
          origin: 'automatic',
          duplicateKey: 'served-people',
          status: 'complete',
          currentVersionId: 'claim-version-1',
          spokenAtMs: 0,
          createdAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:00.000Z',
          versions: [
            {
              id: 'claim-version-1',
              claimId: 'claim-1',
              version: 1,
              exactQuote: 'The program served 80,000 people.',
              normalizedClaim: 'The program served 80,000 people.',
              startMs: 0,
              endMs: 1_000,
              segmentIds: ['live-turn-1'],
              lifecycle: 'active',
              createdAt: '2026-08-10T00:00:00.000Z',
              assessments: [],
            },
          ],
        },
      ],
    } as unknown as MeetingArtifact;
    const refinedTurn = {
      id: 'refined-turn-1',
      meetingId: artifact.id,
      revision: 0,
      status: 'final',
      sourceKind: 'mixed',
      startMs: 0,
      endMs: 1_000,
      text: 'The program served 18,000 people.',
    } as TranscriptTurn;
    const refinedVersionId = refinedTranscriptVersionIdentity(
      artifact.id,
      'gateway-refinement-job-1',
      'manifest-checksum-1'
    );

    const first = refinementClaimVersionDtos(
      artifact,
      refinedVersionId,
      [refinedTurn],
      ['claim-1']
    );
    const replay = refinementClaimVersionDtos(
      artifact,
      refinedVersionId,
      [refinedTurn],
      ['claim-1']
    );

    expect(replay).toEqual(first);
    expect(replay[0].claimVersionId).toBe(first[0].claimVersionId);
    expect(
      refinedTranscriptVersionIdentity(
        artifact.id,
        'gateway-refinement-job-1',
        'manifest-checksum-1'
      )
    ).toBe(refinedVersionId);
  });
});
