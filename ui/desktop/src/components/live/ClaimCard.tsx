import { AlertTriangle, CheckCircle2, CircleHelp, LoaderCircle, Scale } from 'lucide-react';
import { cn } from '../../utils';
import { useState } from 'react';
import type { Claim, Confidence, Verdict } from '../../live/types';
import { currentClaimVersion } from '../../live/types';
import { preferredAssessment } from '../../live/factCheckPolicy';
import { isLocalFactCheckJobId } from '../../live/localFactCheckProtocol';
import { ObelusLoader } from '../brand/ObelusLoader';
import { Button } from '../ui/button';
import { ResearchPacket } from './ResearchPacket';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';

interface ClaimCardProps {
  claim: Claim;
  selected: boolean;
}

const verdictPresentation: Record<
  Verdict,
  { icon: typeof CheckCircle2; className: string; background: string }
> = {
  Supported: {
    icon: CheckCircle2,
    className: 'text-status-supported',
    background: 'bg-status-supported-bg',
  },
  Disputed: {
    icon: AlertTriangle,
    className: 'text-status-disputed',
    background: 'bg-status-disputed-bg',
  },
  'Needs context': {
    icon: Scale,
    className: 'text-status-context',
    background: 'bg-status-context-bg',
  },
  Unverified: {
    icon: CircleHelp,
    className: 'text-status-unverified',
    background: 'bg-status-unverified-bg',
  },
};

function confidenceLabel(confidence?: Confidence): string {
  return confidence ? `${confidence} confidence` : 'Evidence still developing';
}

export function ClaimCard({ claim, selected }: ClaimCardProps) {
  const { state, selectClaim, openSource, rerunClaim } = useLiveMeetingRuntime();
  const [showPriorVersion, setShowPriorVersion] = useState(false);
  const version = currentClaimVersion(claim);
  if (!version) return null;
  const validAssessments = version.assessments
    .filter((assessment) => assessment.status === 'complete')
    .sort((left, right) => (left.stage === 'deep' ? 1 : 0) - (right.stage === 'deep' ? 1 : 0));
  const preliminary = [...validAssessments]
    .reverse()
    .find((assessment) => assessment.stage === 'preliminary');
  const deep = [...validAssessments].reverse().find((assessment) => assessment.stage === 'deep');
  const current = preferredAssessment(preliminary, deep);
  const preliminaryRetained = Boolean(preliminary && deep && current?.id === preliminary.id);
  const finding = current?.verdict ? verdictPresentation[current.verdict] : undefined;
  const FindingIcon = finding?.icon;
  const pending = !current || ['detected', 'queued', 'quick_running'].includes(claim.status);
  const activeDeepJob = state?.artifact?.researchJobs.some(
    (job) =>
      job.claimVersionId === version.id &&
      job.stage === 'deep' &&
      ['pending', 'running', 'retry_wait'].includes(job.status)
  );
  const hostedPreliminaryJob = state?.artifact?.researchJobs.some(
    (job) =>
      job.claimVersionId === version.id &&
      job.stage === 'preliminary' &&
      job.status === 'complete' &&
      Boolean(job.gatewayJobId) &&
      !isLocalFactCheckJobId(job.gatewayJobId ?? '')
  );
  const deepRunning = Boolean(
    preliminary && !deep && (claim.status === 'deep_running' || activeDeepJob)
  );
  const priorVersion = version.predecessorId
    ? claim.versions.find((candidate) => candidate.id === version.predecessorId)
    : undefined;
  const latestResearchJob = [...(state?.artifact?.researchJobs ?? [])]
    .filter((job) => job.claimVersionId === version.id && job.error)
    .sort((left, right) => right.attemptCount - left.attemptCount)[0];
  const researchError = latestResearchJob?.error;
  const researchUnavailable = [
    'research_unavailable',
    'gateway_unavailable',
    'provider_unavailable',
    'budget_denied',
  ].includes(researchError?.code ?? '');
  const acceptedStillRunning = researchError?.code === 'research_poll_window_elapsed';
  const retryAvailable =
    latestResearchJob?.status === 'retry_wait' || latestResearchJob?.status === 'failed';

  return (
    <article
      id={`claim-${claim.id}`}
      className={cn(
        'border-b border-border-primary px-6 py-6 transition-colors duration-200 first:border-t-0',
        selected && 'bg-brand-blue-soft/55 dark:bg-brand-blue/10'
      )}
      aria-current={selected ? 'true' : undefined}
    >
      <button type="button" onClick={() => selectClaim(claim.id)} className="w-full text-left">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary">
            {claim.origin === 'manual' ? 'Manual check' : 'Claim'} ·{' '}
            {Math.floor(claim.spokenAtMs / 60_000)}:
            {String(Math.floor((claim.spokenAtMs % 60_000) / 1_000)).padStart(2, '0')}
          </span>
          {version.lifecycle === 'rechecking' || version.lifecycle === 'stale' ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-status-context-bg px-2 py-1 text-[10px] font-semibold text-status-context">
              <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" /> Transcript
              changed · Rechecking
            </span>
          ) : current ? (
            <span className="rounded-full bg-brand-blue-soft px-2 py-1 text-[10px] font-semibold text-brand-blue-dark">
              {deep ? 'Research complete' : 'Preliminary'}
            </span>
          ) : null}
        </div>
        <h3 className="mt-3 text-[16px] font-semibold leading-6 text-text-primary">
          {version.normalizedClaim}
        </h3>
      </button>

      {pending ? (
        <div className="mt-4 text-sm text-text-secondary">
          {researchError && !acceptedStillRunning ? (
            <div role="status">
              <p className="flex items-center gap-2 font-medium text-status-context">
                <AlertTriangle className="size-4 shrink-0" aria-hidden />
                {researchUnavailable ? 'Research unavailable' : 'Research interrupted'}
              </p>
              <p className="mt-2 leading-6 text-status-context">{researchError.message}</p>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <ObelusLoader variant="proof-pulse" width={22} height={22} label="Checking sources" />
              <span>
                {acceptedStillRunning
                  ? 'Accepted check still running · polling will resume'
                  : claim.status === 'detected'
                    ? 'Claim detected'
                    : claim.status === 'queued'
                      ? 'Queued for checking'
                      : 'Checking sources'}
              </span>
            </div>
          )}
        </div>
      ) : current && finding && FindingIcon ? (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
                finding.className,
                finding.background
              )}
            >
              <FindingIcon className="size-3.5" aria-hidden /> {current.verdict}
            </span>
            <span className="text-xs text-text-secondary">
              {confidenceLabel(current.confidence)}
            </span>
          </div>
          {current.conclusion && (
            <p className="mt-3 text-sm leading-6 text-text-secondary">
              {current.conclusion}{' '}
              {current.citations.conclusion.length > 0 ? (
                [...new Set(current.citations.conclusion)].map((key) => {
                  const source = current.sources.find((candidate) => candidate.citationKey === key);
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={!source}
                      onClick={() => source && void openSource(source.url)}
                      className="mr-1 font-mono text-[11px] font-semibold text-brand-blue hover:underline disabled:text-status-context disabled:no-underline"
                      aria-label={source ? `Open source ${key}` : `Missing source ${key}`}
                    >
                      [{key}]
                    </button>
                  );
                })
              ) : (
                <span className="text-xs font-medium text-status-context">
                  Citation unavailable
                </span>
              )}
            </p>
          )}
          {current.error?.code === 'evidence_unavailable' && (
            <p className="mt-3 text-sm leading-6 text-status-context" role="status">
              Evidence limitation: {current.error.message}
            </p>
          )}
          {current.sources.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {current.sources.slice(0, 4).map((source) => (
                <button
                  key={source.id}
                  type="button"
                  onClick={() => void openSource(source.url)}
                  className="max-w-full truncate rounded-md border border-border-primary bg-brand-cloud px-2 py-1 text-xs font-medium text-text-secondary hover:border-brand-blue hover:text-brand-blue dark:bg-brand-ink"
                >
                  {source.publisher || source.title}
                </button>
              ))}
            </div>
          )}
          {deepRunning && (
            <div className="mt-4 flex items-center gap-2 text-xs font-medium text-brand-blue">
              <ObelusLoader
                variant="source-exchange"
                width={18}
                height={18}
                label="Researching further"
              />{' '}
              Researching more…
            </div>
          )}
          {preliminaryRetained && (
            <p className="mt-4 text-xs leading-5 text-text-secondary" role="status">
              Preliminary finding retained. Deeper research did not provide stronger cited evidence
              for changing it.
            </p>
          )}
          {selected && current && (
            <ResearchPacket
              version={version}
              assessment={current}
              canEscalate={Boolean(
                current.stage === 'preliminary' && !deep && !activeDeepJob && hostedPreliminaryJob
              )}
            />
          )}
        </div>
      ) : null}

      {retryAvailable && (
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => void rerunClaim(claim.id)}
        >
          {acceptedStillRunning ? 'Resume status check' : 'Retry check now'}
        </Button>
      )}

      {priorVersion && (
        <div className="mt-4 border-l-2 border-status-context pl-3 text-xs leading-5 text-text-secondary">
          <button
            type="button"
            className="font-semibold text-status-context hover:underline"
            onClick={() => setShowPriorVersion((visible) => !visible)}
            aria-expanded={showPriorVersion}
          >
            {showPriorVersion ? 'Hide' : 'Review'} prior quote and evidence
          </button>
          {showPriorVersion && (
            <div className="mt-2 space-y-2">
              <p>“{priorVersion.exactQuote}”</p>
              {priorVersion.assessments
                .filter((assessment) => assessment.status === 'complete')
                .map((assessment) => (
                  <p key={assessment.id}>
                    {assessment.stage === 'deep' ? 'Prior research' : 'Prior preliminary finding'}:{' '}
                    {assessment.verdict ?? 'No verdict'}
                    {assessment.conclusion ? ` — ${assessment.conclusion}` : ''}
                    {assessment.citations.conclusion.length > 0
                      ? ` [${assessment.citations.conclusion.join(', ')}]`
                      : ' [Citation unavailable]'}
                  </p>
                ))}
            </div>
          )}
        </div>
      )}

      {claim.status === 'failed' && !current && (
        <p className="mt-4 inline-flex items-center gap-2 text-sm text-status-disputed">
          <AlertTriangle className="size-4" /> This check could not finish. You can retry it without
          losing the transcript.
        </p>
      )}
      {claim.status === 'failed' && current && (
        <p className="mt-4 inline-flex items-center gap-2 text-sm text-status-context">
          <AlertTriangle className="size-4" /> Deeper research could not finish. The preliminary
          finding and its sources remain available.
        </p>
      )}
    </article>
  );
}
