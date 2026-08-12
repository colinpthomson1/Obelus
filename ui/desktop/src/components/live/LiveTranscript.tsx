import { ArrowDown, CloudOff, Pause, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Button } from '../ui/button';
import { ObelusLoader } from '../brand/ObelusLoader';
import { cn } from '../../utils';
import { hasDistinctRefinedTranscript } from '../../live/meetingReducer';
import type {
  Claim,
  MeetingLifecycle,
  SttState,
  TimelineEvent,
  TranscriptTurn,
} from '../../live/types';
import { currentClaimVersion } from '../../live/types';
import { SpeakerTranscriptRow } from './SpeakerTranscriptRow';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';

type TimelineEntry =
  | { kind: 'turn'; at: number; turn: TranscriptTurn }
  | { kind: 'event'; at: number; event: TimelineEvent };

function eventPresentation(event: TimelineEvent) {
  switch (event.kind) {
    case 'pause':
      return { icon: Pause, label: event.label ?? 'Recording paused' };
    case 'resume':
      return { icon: RotateCw, label: event.label ?? 'Recording resumed' };
    case 'sleep':
      return { icon: Pause, label: event.label ?? 'Computer slept · audio was not captured' };
    case 'wake':
      return { icon: RotateCw, label: event.label ?? 'Computer woke · capture resumed' };
    case 'device_change':
      return { icon: RotateCw, label: event.label ?? 'Audio device changed' };
    case 'capture_gap':
    case 'stt_reconnect_gap':
      return { icon: TriangleAlert, label: event.label ?? 'Capture gap' };
  }
}

function claimsForTurn(turn: TranscriptTurn, claims: Claim[]): Claim[] {
  return claims.filter((claim) => {
    const version = currentClaimVersion(claim);
    if (!version) return false;
    if (version.segmentIds.includes(turn.id)) return true;
    if (version.startMs === undefined || version.endMs === undefined) return false;
    return Math.min(turn.endMs, version.endMs) - Math.max(turn.startMs, version.startMs) > 0;
  });
}

export function isRecordingWithoutTranscription(
  lifecycle: MeetingLifecycle,
  stt: SttState
): boolean {
  return lifecycle === 'recording' && ['disconnected', 'closed', 'error'].includes(stt);
}

export function localTranscriptionEmptyStateDetail(
  stt: SttState,
  localSttAvailable: boolean
): string | undefined {
  if (!localSttAvailable) return undefined;
  if (stt === 'streaming') {
    return 'On-device transcription is active. The first words can take a few seconds to appear.';
  }
  if (stt === 'connecting') {
    return 'On-device transcription is starting. The first words can take a few seconds to appear.';
  }
  if (stt === 'reconnecting') {
    return 'On-device transcription is reconnecting. Your local recording is continuing.';
  }
  return undefined;
}

export function LiveTranscript() {
  const { state, support, setFollowingLive, jumpToLive, setViewVersion } = useLiveMeetingRuntime();
  const scrollRef = useRef<HTMLDivElement>(null);
  const artifact = state.artifact;
  const hasRefinedTranscript = hasDistinctRefinedTranscript(artifact);
  const versionId =
    state.viewVersion === 'refined' && hasRefinedTranscript
      ? artifact?.canonicalTranscriptVersionId
      : artifact?.liveTranscriptVersionId;
  const turns = useMemo(() => {
    const all = state.turnOrder.map((key) => state.activeTurns[key]).filter(Boolean);
    if (!versionId) return all;
    return all.filter(
      (turn) => turn.transcriptVersionId === versionId || turn.status === 'partial'
    );
  }, [state.activeTurns, state.turnOrder, versionId]);
  const entries = useMemo<TimelineEntry[]>(() => {
    const timeline = artifact?.timeline ?? [];
    return [
      ...turns.map((turn): TimelineEntry => ({ kind: 'turn', at: turn.startMs, turn })),
      ...timeline.map((event): TimelineEntry => ({ kind: 'event', at: event.startMs, event })),
    ].sort((left, right) => left.at - right.at);
  }, [artifact?.timeline, turns]);
  const latestCommitted = [...turns].reverse().find((turn) => turn.status !== 'partial');
  const latestTurnText = turns[turns.length - 1]?.text;
  const recordingWithoutTranscription = isRecordingWithoutTranscription(
    state.runtime.lifecycle,
    state.runtime.stt
  );
  const awaitingFirstWords =
    state.runtime.lifecycle === 'recording' &&
    ['connecting', 'streaming', 'reconnecting'].includes(state.runtime.stt);
  const stoppedWithoutTranscript =
    state.runtime.lifecycle !== 'recording' &&
    artifact?.refinementStatus === 'failed' &&
    entries.length === 0;
  const localEmptyStateDetail = localTranscriptionEmptyStateDetail(
    state.runtime.stt,
    support?.localSttAvailable === true
  );

  useEffect(() => {
    if (!state.followingLive) return;
    const element = scrollRef.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, [entries.length, latestTurnText, state.followingLive]);

  useEffect(() => {
    if (!state.selectedClaimId) return;
    const claim = artifact?.claims.find((candidate) => candidate.id === state.selectedClaimId);
    const version = claim ? currentClaimVersion(claim) : undefined;
    const turnId = version?.segmentIds.find((segmentId) =>
      turns.some((turn) => turn.id === segmentId)
    );
    const element = turnId ? document.getElementById(`turn-${turnId}`) : undefined;
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [artifact?.claims, state.selectedClaimId, turns]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    if (nearBottom !== state.followingLive) setFollowingLive(nearBottom);
  };

  const handleJump = () => {
    jumpToLive();
    const element = scrollRef.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  };

  return (
    <section
      aria-labelledby="live-transcript-heading"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-brand-cloud dark:bg-brand-ink"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-primary px-5 sm:px-7">
        <h2 id="live-transcript-heading" className="text-sm font-semibold text-text-primary">
          Transcript
        </h2>
        <div className="flex items-center gap-1 rounded-md bg-brand-paper p-0.5 text-xs dark:bg-brand-ink-elevated">
          <button
            type="button"
            className={cn(
              'rounded px-2.5 py-1',
              state.viewVersion === 'refined' &&
                'bg-brand-cloud font-medium text-brand-blue dark:bg-brand-ink-muted'
            )}
            onClick={() => setViewVersion('refined')}
            aria-pressed={state.viewVersion === 'refined'}
            disabled={!hasRefinedTranscript}
          >
            Refined
          </button>
          <button
            type="button"
            className={cn(
              'rounded px-2.5 py-1',
              state.viewVersion === 'live' &&
                'bg-brand-cloud font-medium text-brand-blue dark:bg-brand-ink-muted'
            )}
            aria-pressed={state.viewVersion === 'live'}
            onClick={() => setViewVersion('live')}
          >
            Live
          </button>
        </div>
      </div>

      {state.runtime.stt === 'reconnecting' && (
        <div className="flex items-center justify-center gap-2 border-b border-status-context/20 bg-status-context-bg px-4 py-2 text-sm font-medium text-status-context">
          <CloudOff className="size-4" aria-hidden /> Recording locally · Reconnecting
          transcription…
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 sm:px-7"
      >
        {entries.length === 0 ? (
          <div className="flex h-full min-h-72 flex-col items-center justify-center text-center">
            <ObelusLoader
              variant={state.runtime.lifecycle === 'recording' ? 'transcript-scan' : 'proof-pulse'}
              width={44}
              height={44}
            />
            <p className="mt-5 text-base font-medium text-text-primary">
              {recordingWithoutTranscription
                ? 'Recording audio · transcript unavailable'
                : stoppedWithoutTranscript
                  ? 'Recording saved · no transcript'
                  : state.runtime.lifecycle === 'recording'
                    ? awaitingFirstWords
                      ? 'Listening for the first words…'
                      : 'Preparing transcription…'
                    : 'The transcript will appear here'}
            </p>
            <p className="mt-1 max-w-sm text-sm leading-6 text-text-secondary">
              {recordingWithoutTranscription
                ? 'Your local recording is continuing. Live words cannot appear until the Obelus transcription gateway is connected.'
                : stoppedWithoutTranscript
                  ? 'Your audio is available for playback. Connect the Obelus transcription gateway, then retry refinement to create a transcript.'
                  : awaitingFirstWords && localEmptyStateDetail
                    ? localEmptyStateDetail
                    : 'Every live utterance stays beside its current speaker label and settles in place when finalized.'}
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-4xl pb-28 pt-4">
            {entries.map((entry) => {
              if (entry.kind === 'event') {
                const presentation = eventPresentation(entry.event);
                const Icon = presentation.icon;
                return (
                  <div
                    key={entry.event.id}
                    className="my-3 flex items-center gap-3 py-2 text-xs text-text-secondary"
                  >
                    <span className="h-px flex-1 bg-border-primary" />
                    <span className="flex items-center gap-1.5 font-mono">
                      <Icon className="size-3.5" aria-hidden /> {presentation.label}
                    </span>
                    <span className="h-px flex-1 bg-border-primary" />
                  </div>
                );
              }
              const speaker = artifact?.speakers.find(
                (candidate) => candidate.id === entry.turn.speakerId
              );
              return (
                <SpeakerTranscriptRow
                  key={entry.turn.id}
                  turn={entry.turn}
                  speaker={speaker}
                  claims={claimsForTurn(entry.turn, artifact?.claims ?? [])}
                />
              );
            })}
          </div>
        )}
      </div>

      {!state.followingLive && (
        <Button
          onClick={handleJump}
          className="absolute bottom-5 left-1/2 -translate-x-1/2 bg-brand-ink text-brand-cloud dark:bg-brand-cloud dark:text-brand-ink"
        >
          <ArrowDown className="size-4" /> Jump to live
          {state.unseenFinalTurns > 0 && (
            <span className="rounded-full bg-brand-coral px-1.5 py-0.5 font-mono text-[10px] text-brand-ink">
              {state.unseenFinalTurns}
            </span>
          )}
        </Button>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {latestCommitted ? `Committed transcript: ${latestCommitted.text}` : ''}
      </div>
    </section>
  );
}
