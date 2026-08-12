import { joinTranscriptFragments, normalizeManualSelection } from './claimScheduler';
import type { LiveSelectionRequest } from './ipcTypes';
import type { LiveMeetingState, TranscriptTurn } from './types';

export interface TranscriptSelectionFactCheckInput {
  text: string;
  turnIds: string[];
  speakerId?: string;
  startMs: number;
  endMs: number;
  nearbyContext: string;
  anchor: { x: number; y: number };
}

function canonicalSelectionText(value: string): string {
  return normalizeManualSelection(value, 20_000)
    .toLocaleLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function transcriptTurnIdAtAnchor(selection: LiveSelectionRequest): string | undefined {
  if (!selection.anchor || typeof document.elementFromPoint !== 'function') return undefined;
  const element = document.elementFromPoint(selection.anchor.x, selection.anchor.y);
  const row = element?.closest<HTMLElement>('[data-turn-id]');
  const turnId = row?.dataset.turnId;
  if (!turnId || !row.querySelector('[data-transcript-text]')) return undefined;
  return turnId;
}

function contiguousOccurrenceCount(haystack: string, needle: string): number {
  const paddedHaystack = ` ${haystack} `;
  const paddedNeedle = ` ${needle} `;
  let count = 0;
  let fromIndex = 0;
  while (fromIndex < paddedHaystack.length) {
    const index = paddedHaystack.indexOf(paddedNeedle, fromIndex);
    if (index < 0) break;
    count += 1;
    fromIndex = index + 1;
  }
  return count;
}

export function transcriptSelectionFactCheckInputAtAnchor(
  selection: LiveSelectionRequest,
  state: Pick<LiveMeetingState, 'artifact' | 'activeTurns'>
): TranscriptSelectionFactCheckInput | undefined {
  const selectedText = normalizeManualSelection(selection.text);
  const selectedCanonical = canonicalSelectionText(selectedText);
  if (!selectedCanonical || !selection.anchor) return undefined;

  const anchorTurnId = transcriptTurnIdAtAnchor(selection);
  if (!anchorTurnId) return undefined;
  const turnsById = new Map<string, TranscriptTurn>();
  for (const turn of state.artifact?.turns ?? []) turnsById.set(turn.id, turn);
  for (const turn of Object.values(state.activeTurns)) turnsById.set(turn.id, turn);
  const anchorTurn = turnsById.get(anchorTurnId);
  if (!anchorTurn || anchorTurn.status === 'partial') return undefined;

  const orderedTurns = [...turnsById.values()]
    .filter(
      (turn) =>
        turn.transcriptVersionId === anchorTurn.transcriptVersionId && turn.status !== 'partial'
    )
    .sort((left, right) => {
      if (left.startMs !== right.startMs) return left.startMs - right.startMs;
      if (left.providerTurnOrder !== right.providerTurnOrder) {
        return left.providerTurnOrder - right.providerTurnOrder;
      }
      return left.id.localeCompare(right.id);
    });
  const anchorIndex = orderedTurns.findIndex((turn) => turn.id === anchorTurnId);
  if (anchorIndex < 0) return undefined;

  const candidates: Array<{ turns: TranscriptTurn[]; text: string }> = [];
  for (let size = 1; size <= 3; size += 1) {
    const firstStart = Math.max(0, anchorIndex - size + 1);
    const lastStart = Math.min(anchorIndex, orderedTurns.length - size);
    for (let start = firstStart; start <= lastStart; start += 1) {
      const turns = orderedTurns.slice(start, start + size);
      if (!turns.some((turn) => turn.id === anchorTurnId)) continue;
      const text = turns
        .map((turn) => turn.text)
        .reduce((joined, fragment) => joinTranscriptFragments(joined, fragment), '');
      if (contiguousOccurrenceCount(canonicalSelectionText(text), selectedCanonical) === 1) {
        candidates.push({ turns, text });
      }
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length !== 1) return undefined;
  const match = candidates[0];
  const speakers = new Set(match.turns.map((turn) => turn.speakerId).filter(Boolean));

  return {
    text: selectedText,
    turnIds: match.turns.map((turn) => turn.id),
    speakerId: speakers.size === 1 ? match.turns[0].speakerId : undefined,
    startMs: Math.min(...match.turns.map((turn) => turn.startMs)),
    endMs: Math.max(...match.turns.map((turn) => turn.endMs)),
    nearbyContext: normalizeManualSelection(match.text, 20_000),
    anchor: selection.anchor,
  };
}
