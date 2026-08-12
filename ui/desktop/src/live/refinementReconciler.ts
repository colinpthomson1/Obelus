import { stableLiveUuid, type Claim, type Speaker, type TranscriptTurn } from './types';

export interface RefinedSegmentInput {
  id: string;
  speakerCluster: string;
  text: string;
  startMs: number;
  endMs: number;
  words: TranscriptTurn['words'];
}

export interface ReconciledRefinement {
  turns: TranscriptTurn[];
  speakers: Speaker[];
  ambiguousClusterIds: string[];
  materiallyChangedClaimIds: string[];
}

function overlapMs(
  left: { startMs: number; endMs: number },
  right: { startMs: number; endMs: number }
): number {
  return Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs));
}

function normalizedMeaning(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}%$.-]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 1)
  );
}

export function materiallyChangesMeaning(before: string, after: string): boolean {
  const left = normalizedMeaning(before);
  const right = normalizedMeaning(after);
  const leftNumbers = [...left].filter((token) => /\d/.test(token));
  const rightNumbers = [...right].filter((token) => /\d/.test(token));
  if (leftNumbers.join('|') !== rightNumbers.join('|')) return true;
  if (left.size === 0 || right.size === 0) return before.trim() !== after.trim();
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union < 0.68;
}

function mapClusters(
  meetingId: string,
  liveTurns: TranscriptTurn[],
  refinedSegments: RefinedSegmentInput[],
  speakers: Speaker[]
): { mapping: Map<string, string>; ambiguous: string[]; speakers: Speaker[] } {
  const clusters = [...new Set(refinedSegments.map((segment) => segment.speakerCluster))];
  const mapping = new Map<string, string>();
  const ambiguous: string[] = [];
  const nextSpeakers = [...speakers];

  for (const cluster of clusters) {
    const segments = refinedSegments.filter((segment) => segment.speakerCluster === cluster);
    const scores = new Map<string, number>();
    for (const segment of segments) {
      for (const turn of liveTurns) {
        if (!turn.speakerId) continue;
        scores.set(turn.speakerId, (scores.get(turn.speakerId) ?? 0) + overlapMs(segment, turn));
      }
    }
    const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
    const [best, runnerUp] = ranked;
    const totalDuration = segments.reduce(
      (sum, segment) => sum + (segment.endMs - segment.startMs),
      0
    );
    if (
      best &&
      best[1] >= Math.max(500, totalDuration * 0.45) &&
      (!runnerUp || best[1] >= runnerUp[1] * 1.4)
    ) {
      mapping.set(cluster, best[0]);
      continue;
    }
    const nextNumber = nextSpeakers.length + 1;
    const speaker: Speaker = {
      id: stableLiveUuid(`refined-speaker:${meetingId}:${cluster}`),
      defaultLabel: `Speaker ${nextNumber}`,
      displayNameSource: 'generic',
      manualAssignmentLocked: false,
    };
    nextSpeakers.push(speaker);
    mapping.set(cluster, speaker.id);
    ambiguous.push(cluster);
  }
  return { mapping, ambiguous, speakers: nextSpeakers };
}

export function reconcileRefinement(
  meetingId: string,
  refinedVersionId: string,
  liveTurns: TranscriptTurn[],
  refinedSegments: RefinedSegmentInput[],
  speakers: Speaker[],
  claims: Claim[]
): ReconciledRefinement {
  const {
    mapping,
    ambiguous,
    speakers: reconciledSpeakers,
  } = mapClusters(meetingId, liveTurns, refinedSegments, speakers);
  const turns = refinedSegments.map(
    (segment, index): TranscriptTurn => ({
      id: stableLiveUuid(`refined-turn:${meetingId}:${refinedVersionId}:${segment.id}`),
      meetingId,
      transcriptVersionId: refinedVersionId,
      provider: 'assemblyai',
      providerSessionId: refinedVersionId,
      providerTurnId: segment.id,
      providerTurnOrder: index,
      revision: 0,
      status: 'final',
      speakerId: mapping.get(segment.speakerCluster),
      provisionalSpeakerLabel: segment.speakerCluster,
      sourceKind: 'mixed',
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      words: segment.words.map((word) => ({ ...word, final: true })),
      utteranceBoundary: true,
      endOfTurn: true,
      formatted: true,
      receivedAtMs: Date.now(),
      finalizedAtMs: Date.now(),
    })
  );

  const materiallyChangedClaimIds = claims.flatMap((claim) => {
    const version = claim.versions.find((candidate) => candidate.id === claim.currentVersionId);
    if (!version || version.startMs === undefined || version.endMs === undefined) return [];
    const refinedQuote = turns
      .filter((turn) => overlapMs(turn, { startMs: version.startMs!, endMs: version.endMs! }) > 0)
      .map((turn) => turn.text)
      .join(' ')
      .trim();
    return refinedQuote && materiallyChangesMeaning(version.exactQuote, refinedQuote)
      ? [claim.id]
      : [];
  });

  return {
    turns,
    speakers: reconciledSpeakers,
    ambiguousClusterIds: ambiguous,
    materiallyChangedClaimIds,
  };
}
