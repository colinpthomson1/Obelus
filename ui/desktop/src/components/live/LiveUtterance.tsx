import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '../../utils';
import type { Claim, TranscriptTurn } from '../../live/types';
import { currentClaimVersion } from '../../live/types';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';

interface LiveUtteranceProps {
  turn: TranscriptTurn;
  claims: Claim[];
}

interface TextPart {
  text: string;
  claimId?: string;
}

interface PendingFactCheck {
  text: string;
  turnIds: string[];
  speakerId?: string;
  startMs: number;
  endMs: number;
  nearbyContext: string;
  anchor: { x: number; y: number };
}

function annotateClaims(text: string, claims: Claim[]): TextPart[] {
  const ranges = claims
    .flatMap((claim) => {
      const version = currentClaimVersion(claim);
      if (!version) return [];
      const index = text.toLocaleLowerCase().indexOf(version.exactQuote.toLocaleLowerCase());
      return index >= 0
        ? [{ start: index, end: index + version.exactQuote.length, claimId: claim.id }]
        : [];
    })
    .sort((left, right) => left.start - right.start)
    .filter((range, index, ranges) => index === 0 || range.start >= ranges[index - 1].end);
  if (ranges.length === 0) return [{ text }];
  const parts: TextPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start) });
    parts.push({ text: text.slice(range.start, range.end), claimId: range.claimId });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

export function LiveUtterance({ turn, claims }: LiveUtteranceProps) {
  const { factCheckSelection, selectClaim, support } = useLiveMeetingRuntime();
  const [pendingFactCheck, setPendingFactCheck] = useState<PendingFactCheck>();
  const parts = useMemo(() => annotateClaims(turn.text, claims), [turn.text, claims]);
  const partial = turn.status === 'partial';

  const handleSelection = () => {
    if (partial) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer.parentElement?.closest(
      `[data-turn-id="${turn.id}"]`
    );
    if (!container) return;
    const rect = range.getBoundingClientRect();
    setPendingFactCheck({
      text,
      turnIds: [turn.id],
      speakerId: turn.speakerId,
      startMs: turn.startMs,
      endMs: turn.endMs,
      nearbyContext: turn.text,
      anchor: { x: rect.left + rect.width / 2, y: rect.top },
    });
  };

  const submitPendingFactCheck = () => {
    if (!pendingFactCheck) return;
    const request = pendingFactCheck;
    setPendingFactCheck(undefined);
    window.getSelection()?.removeAllRanges();
    void factCheckSelection(request);
  };

  return (
    <div
      className="group/utterance relative min-w-0"
      data-turn-id={turn.id}
      onMouseUp={handleSelection}
    >
      <p
        data-transcript-text
        className={cn(
          'max-w-[72ch] select-text text-[17px] leading-[1.58] text-text-primary',
          partial && 'text-neutral-600 dark:text-neutral-300'
        )}
      >
        {parts.map((part, index) =>
          part.claimId ? (
            <button
              key={`${part.claimId}:${index}`}
              type="button"
              className="rounded-[3px] border-b-2 border-brand-blue bg-brand-blue-soft/70 px-0.5 text-left text-inherit transition-colors hover:bg-brand-blue-soft dark:bg-brand-blue/15"
              onClick={() => selectClaim(part.claimId)}
              aria-label={`Open fact-check for “${part.text}”`}
            >
              {part.text}
            </button>
          ) : (
            <span key={index}>{part.text}</span>
          )
        )}
        {partial && (
          <span
            className="ml-1 inline-flex translate-y-[2px] items-center text-brand-aqua"
            aria-hidden
          >
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
          </span>
        )}
      </p>
      {pendingFactCheck && (
        <button
          type="button"
          className="fixed z-50 -translate-x-1/2 -translate-y-[calc(100%+8px)] rounded-md bg-brand-ink px-3 py-1.5 text-xs font-semibold text-brand-cloud shadow-lg outline-none ring-brand-aqua focus-visible:ring-2 dark:bg-brand-cloud dark:text-brand-ink"
          style={{ left: pendingFactCheck.anchor.x, top: pendingFactCheck.anchor.y }}
          onMouseUp={(event) => event.stopPropagation()}
          onClick={submitPendingFactCheck}
          aria-label={`Fact-check selected text: ${pendingFactCheck.text}`}
          title={
            support?.localFactCheckMode === 'subscription_web'
              ? 'Searches public web sources, then sends the selected claim and retrieved evidence to ChatGPT.'
              : support?.localFactCheckMode === 'local_wikimedia'
                ? 'Sends the selected claim text to English Wikipedia and Wikidata; assessment stays on this Mac.'
                : undefined
          }
        >
          {support?.localFactCheckMode === 'subscription_web'
            ? 'Check with ChatGPT + web'
            : support?.localFactCheckMode === 'local_wikimedia'
              ? 'Check with Wikimedia'
              : 'Fact-check'}
        </button>
      )}
      {claims.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {claims.map((claim) => (
            <button
              key={claim.id}
              type="button"
              onClick={() => selectClaim(claim.id)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-blue hover:underline"
            >
              {claim.status === 'complete' || claim.status === 'preliminary' ? (
                <CheckCircle2 className="size-3.5" aria-hidden />
              ) : (
                <LoaderCircle
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              )}
              {claim.status === 'complete'
                ? 'Research complete'
                : claim.status === 'preliminary'
                  ? 'Preliminary finding'
                  : 'Checking sources'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
