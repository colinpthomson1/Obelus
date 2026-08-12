import { AlertTriangle, CheckCircle2, RotateCw } from 'lucide-react';
import { ObelusLoader } from '../brand/ObelusLoader';
import { Button } from '../ui/button';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';

const labels = {
  not_started: 'Finalizing live transcript',
  queued: 'Refining complete recording',
  uploading: 'Uploading aligned audio',
  processing: 'Refining complete recording',
  reconciling: 'Reconciling speakers',
  complete: 'Refined transcript ready',
  retry_wait: 'Refinement will retry',
  failed: 'Refinement failed',
  cancelled: 'Refinement cancelled',
} as const;

export function TranscriptRefinementStatus() {
  const { state, retryRefinement } = useLiveMeetingRuntime();
  const status = state.artifact?.refinementStatus ?? state.runtime.refinement;
  const label =
    status === 'failed' && state.runtime.gateway !== 'ready'
      ? 'Refinement unavailable'
      : labels[status];
  const pendingResearch =
    state.artifact?.researchJobs.filter(
      (job) => job.status === 'pending' || job.status === 'running' || job.status === 'retry_wait'
    ).length ?? 0;
  if (status === 'not_started' && state.runtime.lifecycle === 'recording') return null;

  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border-primary bg-brand-paper px-5 py-2 text-xs dark:bg-brand-ink-elevated sm:px-7">
      <div className="flex items-center gap-2 font-medium text-text-secondary">
        {status === 'complete' ? (
          <CheckCircle2 className="size-4 text-status-supported" aria-hidden />
        ) : status === 'failed' ? (
          <AlertTriangle className="size-4 text-status-disputed" aria-hidden />
        ) : (
          <ObelusLoader
            variant={status === 'reconciling' ? 'obelus-resolve' : 'progress-divide'}
            progress={
              status === 'queued'
                ? 0.2
                : status === 'uploading'
                  ? 0.4
                  : status === 'processing'
                    ? 0.65
                    : status === 'reconciling'
                      ? 0.85
                      : 0.1
            }
            width={18}
            height={18}
            label={label}
          />
        )}
        <span>{label}</span>
        {pendingResearch > 0 && (
          <span className="font-normal text-text-tertiary">
            · {pendingResearch} research packet{pendingResearch === 1 ? '' : 's'} still running
          </span>
        )}
      </div>
      {status === 'failed' && (
        <Button variant="ghost" size="xs" onClick={() => void retryRefinement()}>
          <RotateCw className="size-3.5" /> Retry
        </Button>
      )}
    </div>
  );
}
