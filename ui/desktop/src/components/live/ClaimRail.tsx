import { ChevronDown, PanelRightClose, SearchCheck } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '../ui/button';
import { ClaimCard } from './ClaimCard';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';

export function ClaimRail() {
  const { state, support, setClaimRailOpen } = useLiveMeetingRuntime();
  const scrollRef = useRef<HTMLDivElement>(null);
  const claims = state.artifact?.claims ?? [];
  const pendingManualRequest = [...(state.artifact?.manualFactCheckRequests ?? [])]
    .reverse()
    .find((request) => ['queued', 'processing', 'retry_wait', 'failed'].includes(request.status));

  useEffect(() => {
    if (!state.selectedClaimId) return;
    const escapedId = window.CSS?.escape
      ? window.CSS.escape(state.selectedClaimId)
      : state.selectedClaimId.replace(/[^a-zA-Z0-9_-]/g, '');
    const element = scrollRef.current?.querySelector(`#claim-${escapedId}`);
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [state.selectedClaimId]);

  return (
    <aside
      aria-label="Fact-check findings"
      className="flex h-full min-h-0 min-w-[360px] flex-col bg-brand-paper dark:bg-brand-ink-elevated"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-primary px-5">
        <div className="flex items-center gap-2">
          <SearchCheck className="size-4 text-brand-blue" aria-hidden />
          <h2 className="text-sm font-semibold text-text-primary">Findings</h2>
          <span className="font-mono text-[11px] text-text-tertiary">{claims.length}</span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          shape="round"
          onClick={() => setClaimRailOpen(false)}
          aria-label="Close findings"
        >
          <PanelRightClose className="size-4" />
        </Button>
      </div>
      {state.backpressure && (
        <div className="border-b border-status-context/20 bg-status-context-bg px-5 py-2 text-xs font-medium text-status-context">
          {state.backpressureReason === 'limit'
            ? 'Automatic claim limit reached. Additional candidates were not queued; select transcript text to request a manual check.'
            : state.runtime.gateway === 'unavailable'
              ? 'Evidence research is unavailable. Identified claims remain anchored in the transcript.'
              : 'Fact-checking is catching up. New claims remain anchored in the transcript.'}
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {claims.length === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center px-8 text-center">
            <SearchCheck className="size-5 text-brand-blue" aria-hidden />
            <p className="mt-3 text-sm font-medium text-text-primary">
              {pendingManualRequest ? 'Manual check queued' : 'Listening for checkable claims'}
            </p>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              {pendingManualRequest
                ? (pendingManualRequest.error?.message ??
                  'Obelus is preparing the selected claim before evidence research begins.')
                : 'Consequential, specific, or disputed statements will appear here in the order they were spoken.'}
            </p>
            <div className="mt-5 flex items-center gap-1 text-xs text-text-tertiary">
              Select transcript text for a manual check <ChevronDown className="size-3" />
            </div>
          </div>
        ) : (
          claims.map((claim) => (
            <ClaimCard key={claim.id} claim={claim} selected={state.selectedClaimId === claim.id} />
          ))
        )}
      </div>
      <div className="shrink-0 border-t border-border-primary px-5 py-3 text-[11px] leading-4 text-text-tertiary">
        {support?.directFactCheckFallbackEnabled
          ? 'AI-generated research · The Obelus gateway is preferred. If it is unavailable before accepting a check, explicit direct fallback may send bounded claim context and retrieved public-web evidence to ChatGPT. Fallback never occurs after a hosted check ID is accepted.'
          : support?.localFactCheckMode === 'subscription_web'
            ? 'Preliminary AI research · Bounded finalized transcript excerpts, identified claims, and retrieved evidence go to ChatGPT; searches and page requests go to public web sources. Review cited sources before relying on a finding.'
            : support?.localFactCheckMode === 'local_wikimedia'
              ? 'Preliminary local research · Claim text is sent to English Wikipedia and Wikidata; assessment stays on this Mac. Review cited secondary sources before relying on a finding.'
              : 'AI-generated research · Follow source links and review limitations before relying on a finding.'}
      </div>
    </aside>
  );
}
