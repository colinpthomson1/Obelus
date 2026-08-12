import { stableLiveUuid, type SourceKind, type Speaker, type TranscriptTurn } from './types';

export interface SpeakerObservation {
  providerSessionId: string;
  providerLabel: string;
  speakerId: string;
  sourceHint?: SourceKind;
}

export interface SpeakerResolution {
  speaker?: Speaker;
  observation?: SpeakerObservation;
  speakers: Speaker[];
}

function nextSpeakerNumber(speakers: Speaker[]): number {
  const used = new Set(
    speakers
      .map((speaker) => /Speaker (\d+)/.exec(speaker.defaultLabel)?.[1])
      .flatMap((value) => (value ? [Number(value)] : []))
  );
  let next = 1;
  while (used.has(next)) next += 1;
  return next;
}

export function resolveProviderSpeaker(
  speakers: Speaker[],
  observations: SpeakerObservation[],
  providerSessionId: string,
  providerLabel: string | undefined,
  sourceHint?: SourceKind
): SpeakerResolution {
  if (!providerLabel || providerLabel === 'UNKNOWN') return { speakers };
  const existingObservation = observations.find(
    (observation) =>
      observation.providerSessionId === providerSessionId &&
      observation.providerLabel === providerLabel
  );
  if (existingObservation) {
    return {
      speakers,
      speaker: speakers.find((speaker) => speaker.id === existingObservation.speakerId),
      observation: existingObservation,
    };
  }
  const number = nextSpeakerNumber(speakers);
  const speaker: Speaker = {
    id: stableLiveUuid(`speaker:${providerSessionId}:${providerLabel}`),
    defaultLabel: `Speaker ${number}`,
    displayNameSource: 'generic',
    manualAssignmentLocked: false,
    sourceHint,
  };
  return {
    speakers: [...speakers, speaker],
    speaker,
    observation: {
      providerSessionId,
      providerLabel,
      speakerId: speaker.id,
      sourceHint,
    },
  };
}

export function applySpeakerRevisionToTurns(
  turns: TranscriptTurn[],
  providerSessionId: string,
  turnOrder: number,
  providerLabel: string
): TranscriptTurn[] {
  return turns.map((turn) =>
    turn.providerSessionId === providerSessionId && turn.providerTurnOrder === turnOrder
      ? {
          ...turn,
          provisionalSpeakerLabel: providerLabel,
          revision: turn.revision + 1,
          status: turn.status === 'partial' ? 'partial' : 'revised',
        }
      : turn
  );
}

export function mergeTurnsDeterministically(turns: TranscriptTurn[]): TranscriptTurn[] {
  const unique = new Map<string, TranscriptTurn>();
  for (const turn of turns) {
    const key = `${turn.providerSessionId}:${turn.providerTurnId}`;
    const previous = unique.get(key);
    if (!previous || turn.revision > previous.revision) unique.set(key, turn);
  }
  return [...unique.values()].sort((left, right) => {
    if (left.startMs !== right.startMs) return left.startMs - right.startMs;
    if (left.endMs !== right.endMs) return left.endMs - right.endMs;
    const leftFirstSeen = left.finalizedAtMs ?? left.receivedAtMs;
    const rightFirstSeen = right.finalizedAtMs ?? right.receivedAtMs;
    if (leftFirstSeen !== rightFirstSeen) return leftFirstSeen - rightFirstSeen;
    return left.id.localeCompare(right.id);
  });
}

function normalizedTokens(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}%$.-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function likelyBleedDuplicate(left: TranscriptTurn, right: TranscriptTurn): boolean {
  if (
    left.sourceKind === right.sourceKind ||
    left.sourceKind === 'mixed' ||
    right.sourceKind === 'mixed'
  ) {
    return false;
  }
  const overlap = Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs);
  if (overlap <= 0) return false;
  const shorterDuration = Math.max(
    1,
    Math.min(left.endMs - left.startMs, right.endMs - right.startMs)
  );
  if (overlap / shorterDuration < 0.75) return false;
  const leftTokens = new Set(normalizedTokens(left.text));
  const rightTokens = new Set(normalizedTokens(right.text));
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / Math.min(leftTokens.size, rightTokens.size) >= 0.85;
}

export function deduplicateSourceBleed(turns: TranscriptTurn[]): TranscriptTurn[] {
  const ordered = mergeTurnsDeterministically(turns);
  const removed = new Set<string>();
  for (let index = 0; index < ordered.length; index += 1) {
    const left = ordered[index];
    if (removed.has(left.id)) continue;
    for (let other = index + 1; other < ordered.length; other += 1) {
      const right = ordered[other];
      if (right.startMs > left.endMs) break;
      if (!likelyBleedDuplicate(left, right)) continue;
      removed.add(right.id);
    }
  }
  return ordered.filter((turn) => !removed.has(turn.id));
}
