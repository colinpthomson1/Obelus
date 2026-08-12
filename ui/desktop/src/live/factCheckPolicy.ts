import type {
  Assessment,
  AssessmentResolution,
  Confidence,
  EvidenceRelation,
  LegacyVerdict,
  Verdict,
} from './types';

const findingAliases: Record<string, Verdict> = {
  supported: 'Supported',
  mostly_supported: 'Supported',
  'mostly supported': 'Supported',
  disputed: 'Disputed',
  unsupported: 'Disputed',
  needs_context: 'Needs context',
  'needs context': 'Needs context',
  mixed: 'Needs context',
  unverified: 'Unverified',
  unverifiable: 'Unverified',
};

const confidenceRank: Record<Confidence, number> = {
  Low: 1,
  Medium: 2,
  High: 3,
};

function assessmentStrength(assessment: Assessment): number {
  const finding = assessment.verdict;
  const resolution =
    assessment.resolution ?? (finding ? resolutionForFinding(finding) : 'unresolved');
  return confidenceRank[assessment.confidence ?? 'Low'] * 2 + (resolution === 'resolved' ? 1 : 0);
}

export function normalizeFinding(value: unknown): Verdict | undefined {
  if (typeof value !== 'string') return undefined;
  return findingAliases[value.trim().toLowerCase().replace(/-/g, '_')];
}

export function legacyFinding(value: Verdict): LegacyVerdict {
  switch (value) {
    case 'Supported':
      return 'Supported';
    case 'Disputed':
      return 'Unsupported';
    case 'Needs context':
      return 'Mixed';
    case 'Unverified':
      return 'Unverifiable';
  }
}

export function normalizeConfidence(value: unknown): Confidence | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'low') return 'Low';
  if (normalized === 'medium') return 'Medium';
  if (normalized === 'high') return 'High';
  return undefined;
}

export function resolutionForFinding(finding: Verdict): AssessmentResolution {
  return finding === 'Supported' || finding === 'Disputed' ? 'resolved' : 'unresolved';
}

export function evidenceRelationForFinding(finding: Verdict): EvidenceRelation {
  switch (finding) {
    case 'Supported':
      return 'supports';
    case 'Disputed':
      return 'contradicts';
    case 'Needs context':
      return 'qualified';
    case 'Unverified':
      return 'none';
  }
}

function hasCitedNewEvidence(preliminary: Assessment, deep: Assessment): boolean {
  if (!deep.changeExplanation?.trim()) return false;
  const preliminaryUrls = new Set(preliminary.sources.map((source) => source.canonicalUrl));
  const decisiveCitations = new Set([
    ...deep.citations.support.flat(),
    ...deep.citations.contradiction.flat(),
    ...deep.citations.caveats.flat(),
  ]);
  const explanationCitations = deep.changeExplanationCitations ?? deep.citations.conclusion;
  return deep.sources.some(
    (source) =>
      !preliminaryUrls.has(source.canonicalUrl) &&
      explanationCitations.includes(source.citationKey) &&
      decisiveCitations.has(source.citationKey)
  );
}

export function deepAssessmentSupersedesPreliminary(
  preliminary: Assessment,
  deep: Assessment
): boolean {
  const preliminaryFinding = preliminary.verdict;
  const deepFinding = deep.verdict;
  if (!preliminaryFinding) return Boolean(deepFinding);
  if (!deepFinding) return false;

  const preliminaryResolution = preliminary.resolution ?? resolutionForFinding(preliminaryFinding);
  const deepResolution = deep.resolution ?? resolutionForFinding(deepFinding);
  const preliminaryStrength = assessmentStrength(preliminary);
  const deepStrength = assessmentStrength(deep);

  if (preliminaryFinding === deepFinding) return deepStrength >= preliminaryStrength;
  if (
    preliminaryResolution === 'unresolved' &&
    deepResolution === 'resolved' &&
    deepStrength > preliminaryStrength
  ) {
    return true;
  }
  return hasCitedNewEvidence(preliminary, deep) && deepStrength >= preliminaryStrength;
}

export function preferredAssessment(
  preliminary: Assessment | undefined,
  deep: Assessment | undefined
): Assessment | undefined {
  if (!preliminary) return deep;
  if (!deep) return preliminary;
  if (preliminary.current !== deep.current) return preliminary.current ? preliminary : deep;
  return deepAssessmentSupersedesPreliminary(preliminary, deep) ? deep : preliminary;
}

export function policyRecommendsDeepResearch(
  stage: 'quick' | 'deep',
  result: {
    escalationRecommended?: boolean;
    escalation?: { recommended?: boolean };
  }
): boolean {
  if (stage !== 'quick') return false;
  if (typeof result.escalation?.recommended === 'boolean') {
    return result.escalation.recommended;
  }
  return result.escalationRecommended === true;
}
