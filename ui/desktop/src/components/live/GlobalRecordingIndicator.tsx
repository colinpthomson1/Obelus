import { ArrowRight, Pause } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '../ui/button';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function GlobalRecordingIndicator() {
  const { state } = useLiveMeetingRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  const active = state.runtime.lifecycle === 'recording' || state.runtime.lifecycle === 'paused';
  if (!active || location.pathname === '/live') return null;
  return (
    <div className="absolute bottom-5 right-5 z-[80] flex items-center gap-4 rounded-xl border border-brand-ink-muted bg-brand-ink px-4 py-3 text-brand-cloud shadow-default">
      <span className="flex items-center gap-2 text-sm font-semibold">
        {state.runtime.lifecycle === 'paused' ? (
          <Pause className="size-3.5" />
        ) : (
          <span className="size-2.5 animate-pulse rounded-full bg-brand-coral motion-reduce:animate-none" />
        )}
        {state.runtime.lifecycle === 'paused' ? 'Paused' : 'Recording'}
      </span>
      <time className="font-mono text-xs tabular-nums text-neutral-300">
        {formatElapsed(state.runtime.elapsedMs)}
      </time>
      <Button
        size="sm"
        className="bg-brand-cloud text-brand-ink hover:bg-brand-paper"
        onClick={() => navigate('/live')}
      >
        Return to live meeting <ArrowRight className="size-3.5" />
      </Button>
    </div>
  );
}
