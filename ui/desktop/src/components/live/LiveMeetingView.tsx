import { PanelRightOpen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { ClaimRail } from './ClaimRail';
import { LiveMeetingHeader } from './LiveMeetingHeader';
import { LiveTranscript } from './LiveTranscript';
import { TranscriptRefinementStatus } from './TranscriptRefinementStatus';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';
import type { LiveMeetingState, TypedError } from '../../live/types';
import './live.css';

const MIN_CLAIM_WIDTH = 360;
const MAX_CLAIM_WIDTH = 620;

function errorMessage(error: TypedError, state: LiveMeetingState): string {
  if (error.code === 'system_audio_silent') {
    return 'Computer audio is connected but quiet. Your microphone is still recording. Play audio from the call to confirm computer-audio capture.';
  }

  const refinementFailed =
    state.artifact?.refinementStatus === 'failed' || state.runtime.refinement === 'failed';
  if (refinementFailed) {
    const hasLiveTranscript =
      state.artifact?.turns.some((turn) => turn.text.trim().length > 0) === true ||
      Object.values(state.activeTurns).some((turn) => turn.text.trim().length > 0);
    return hasLiveTranscript
      ? 'Transcript refinement failed. Your local recording is saved, and the live transcript remains available.'
      : 'Transcript refinement failed. Your local recording is saved, but no live transcript was produced.';
  }

  return `${error.message}${
    error.retryable ? ' Obelus will keep the local artifact and retry when possible.' : ''
  }`;
}

export function LiveMeetingView() {
  const { state, setClaimRailOpen } = useLiveMeetingRuntime();
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; width: number } | undefined>(undefined);
  const [claimWidth, setClaimWidth] = useState(430);

  const clampWidth = useCallback((width: number) => {
    const hostWidth = hostRef.current?.clientWidth ?? 1200;
    return Math.max(MIN_CLAIM_WIDTH, Math.min(MAX_CLAIM_WIDTH, Math.min(width, hostWidth - 520)));
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragRef.current) return;
      setClaimWidth(clampWidth(dragRef.current.width + dragRef.current.x - event.clientX));
    };
    const onUp = () => {
      dragRef.current = undefined;
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [clampWidth]);

  return (
    <div
      ref={hostRef}
      className="live-workspace flex h-full min-h-0 flex-col bg-brand-cloud dark:bg-brand-ink"
    >
      <LiveMeetingHeader />
      {state.runtime.lifecycle === 'finalizing' ||
      (state.artifact && state.artifact.refinementStatus !== 'not_started') ? (
        <TranscriptRefinementStatus />
      ) : null}
      {state.error && (
        <div
          role="alert"
          className="border-b border-status-context/25 bg-status-context-bg px-5 py-2 text-sm text-status-context sm:px-7"
        >
          {errorMessage(state.error, state)}
        </div>
      )}
      <div className="live-workspace-body relative flex min-h-0 flex-1">
        <LiveTranscript />
        {!state.claimRailOpen && (
          <Button
            variant="outline"
            size="sm"
            className="absolute right-4 top-4 z-20 bg-brand-cloud dark:bg-brand-ink-elevated"
            onClick={() => setClaimRailOpen(true)}
          >
            <PanelRightOpen className="size-4" /> Findings
          </Button>
        )}
        {state.claimRailOpen && (
          <>
            <div
              role="separator"
              tabIndex={0}
              aria-label="Resize findings panel"
              aria-orientation="vertical"
              aria-valuemin={MIN_CLAIM_WIDTH}
              aria-valuemax={MAX_CLAIM_WIDTH}
              aria-valuenow={claimWidth}
              className="live-claim-separator w-1 shrink-0 cursor-col-resize border-l border-border-primary hover:bg-brand-aqua/25 focus-visible:bg-brand-aqua/30"
              onMouseDown={(event) => {
                dragRef.current = { x: event.clientX, width: claimWidth };
                document.body.style.cursor = 'col-resize';
                event.preventDefault();
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') setClaimWidth((width) => clampWidth(width + 16));
                if (event.key === 'ArrowRight') setClaimWidth((width) => clampWidth(width - 16));
                if (event.key === 'Home') setClaimWidth(MIN_CLAIM_WIDTH);
                if (event.key === 'End') setClaimWidth(MAX_CLAIM_WIDTH);
              }}
            />
            <div className="live-claim-panel shrink-0" style={{ width: claimWidth }}>
              <ClaimRail />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
