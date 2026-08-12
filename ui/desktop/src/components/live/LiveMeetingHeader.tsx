import {
  ArrowLeftRight,
  AudioLines,
  Cloud,
  CloudOff,
  Mic,
  Pause,
  Play,
  Square,
} from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../utils';
import { AudioLevelMeter } from './AudioLevelMeter';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';
import { MeetingAudioPlayer } from './MeetingAudioPlayer';

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function LiveMeetingHeader() {
  const { state, support, pauseMeeting, resumeMeeting, stopMeeting, closeArtifact, swapSpeakers } =
    useLiveMeetingRuntime();
  const { runtime, artifact } = state;
  const recording = runtime.lifecycle === 'recording' || runtime.lifecycle === 'paused';
  const paused = runtime.lifecycle === 'paused';
  const subscriptionResearch = support?.localFactCheckMode === 'subscription_web';
  const legacyLocalResearch = support?.localFactCheckMode === 'local_wikimedia';
  const directResearch = subscriptionResearch || legacyLocalResearch;
  const directResearchAvailable = directResearch && support.localFactCheckAvailable;
  const directResearchLabel = subscriptionResearch ? 'ChatGPT' : 'local';

  return (
    <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-border-primary bg-brand-cloud px-5 py-2 dark:bg-brand-ink sm:px-7">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {recording ? (
            <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <span
                className={cn(
                  'size-2.5 rounded-full bg-brand-coral',
                  !paused && 'animate-pulse motion-reduce:animate-none'
                )}
                aria-hidden
              />
              {paused ? 'Paused' : 'Recording'}
            </span>
          ) : (
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-tertiary">
              {artifact?.status === 'complete'
                ? 'Meeting artifact'
                : (artifact?.status ?? 'Live fact check')}
            </span>
          )}
          <time className="font-mono text-sm font-medium tabular-nums text-text-secondary">
            {formatElapsed(
              runtime.elapsedMs ||
                (artifact?.endedAtMs && artifact.startedAtMs
                  ? artifact.endedAtMs - artifact.startedAtMs
                  : 0)
            )}
          </time>
        </div>
        <h1 className="mt-0.5 truncate text-sm font-semibold text-text-primary">
          {artifact?.title || 'Untitled live session'}
        </h1>
      </div>

      {recording && (
        <div className="hidden items-center gap-4 xl:flex">
          <div
            className="flex items-center gap-2"
            title={`Microphone: ${runtime.microphone.state}`}
          >
            <Mic className="size-4 text-text-secondary" aria-hidden />
            <AudioLevelMeter
              label="Microphone"
              value={runtime.microphone.meter.rms * 4}
              active={runtime.microphone.state === 'active'}
              compact
            />
          </div>
          {artifact?.mode === 'call' && (
            <div
              className="flex items-center gap-2"
              title={`System audio: ${runtime.system.state}`}
            >
              <AudioLines className="size-4 text-text-secondary" aria-hidden />
              <AudioLevelMeter
                label="System audio"
                value={runtime.system.meter.rms * 4}
                active={runtime.system.state === 'active'}
                compact
              />
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 text-xs text-text-secondary">
        <span className="flex items-center gap-1.5" title={`Transcription: ${runtime.stt}`}>
          {runtime.stt === 'streaming' || runtime.stt === 'closed' ? (
            <Cloud className="size-3.5 text-status-supported" />
          ) : (
            <CloudOff className="size-3.5 text-status-context" />
          )}
          <span className="hidden lg:inline">STT {runtime.stt}</span>
        </span>
        <span
          className="flex items-center gap-1.5"
          title={
            subscriptionResearch
              ? directResearchAvailable
                ? 'Research: ChatGPT with public-web evidence'
                : `Research: ChatGPT with public-web evidence unavailable${
                    support.localFactCheckUnavailableReason
                      ? ` · ${support.localFactCheckUnavailableReason}`
                      : ''
                  }`
              : legacyLocalResearch
                ? directResearchAvailable
                  ? 'Research: local preliminary Wikimedia check'
                  : `Research: local preliminary Wikimedia check unavailable${
                      support.localFactCheckUnavailableReason
                        ? ` · ${support.localFactCheckUnavailableReason}`
                        : ''
                    }`
                : `Research gateway: ${runtime.gateway}`
          }
        >
          <span
            className={cn(
              'size-2 rounded-full',
              directResearch
                ? directResearchAvailable
                  ? 'bg-brand-aqua'
                  : 'bg-status-disputed'
                : runtime.gateway === 'ready'
                  ? 'bg-brand-aqua'
                  : runtime.gateway === 'degraded'
                    ? 'bg-status-context'
                    : 'bg-status-disputed'
            )}
          />
          <span className="hidden lg:inline">
            Research{' '}
            {directResearch
              ? directResearchAvailable
                ? `${directResearchLabel} · preliminary`
                : `${directResearchLabel} · unavailable`
              : runtime.gateway}
          </span>
        </span>
      </div>

      <div className="flex items-center gap-2">
        {artifact?.speakers.length === 2 && (
          <Button
            variant="ghost"
            size="sm"
            title="Swap every transcript and claim anchor between these two speakers"
            onClick={() => void swapSpeakers(artifact.speakers[0].id, artifact.speakers[1].id)}
          >
            <ArrowLeftRight className="size-3.5" />
            <span className="hidden 2xl:inline">Swap speakers</span>
          </Button>
        )}
        {!recording && <MeetingAudioPlayer />}
        {recording ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void (paused ? resumeMeeting() : pauseMeeting())}
            >
              {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button
              className="bg-brand-ink text-brand-cloud dark:bg-brand-cloud dark:text-brand-ink"
              size="sm"
              onClick={() => void stopMeeting()}
            >
              <Square className="size-3.5 fill-current" /> Stop
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={closeArtifact}>
            Back to live
          </Button>
        )}
      </div>
    </header>
  );
}
