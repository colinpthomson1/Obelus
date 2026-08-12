import { Check, Pencil, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { Claim, Speaker, TranscriptTurn } from '../../live/types';
import { speakerName } from '../../live/types';
import { LiveUtterance } from './LiveUtterance';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';

interface SpeakerTranscriptRowProps {
  turn: TranscriptTurn;
  speaker?: Speaker;
  claims: Claim[];
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function SpeakerTranscriptRow({ turn, speaker, claims }: SpeakerTranscriptRowProps) {
  const { renameSpeaker } = useLiveMeetingRuntime();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(speaker?.displayName ?? '');

  useEffect(() => setName(speaker?.displayName ?? ''), [speaker?.displayName]);

  const commitName = () => {
    if (speaker) void renameSpeaker(speaker.id, name);
    setEditing(false);
  };

  return (
    <article
      id={`turn-${turn.id}`}
      className="grid min-w-0 grid-cols-[112px_minmax(0,1fr)] gap-5 py-4 sm:grid-cols-[148px_minmax(0,1fr)] sm:gap-7"
    >
      <div className="min-w-0 pt-0.5 text-right">
        {editing && speaker ? (
          <div className="ml-auto flex max-w-36 items-center gap-1">
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitName();
                if (event.key === 'Escape') setEditing(false);
              }}
              aria-label={`Rename ${speaker.defaultLabel}`}
              maxLength={80}
              className="h-7 px-2 text-xs"
            />
            <Button
              size="xs"
              shape="round"
              variant="ghost"
              aria-label="Save speaker name"
              onClick={commitName}
            >
              <Check className="size-3" />
            </Button>
            <Button
              size="xs"
              shape="round"
              variant="ghost"
              aria-label="Cancel rename"
              onClick={() => setEditing(false)}
            >
              <X className="size-3" />
            </Button>
          </div>
        ) : (
          <button
            type="button"
            disabled={!speaker}
            onClick={() => setEditing(true)}
            className="group/name ml-auto flex max-w-full items-center justify-end gap-1 text-sm font-semibold text-text-primary hover:text-brand-blue disabled:cursor-default"
          >
            <span className="truncate">{speakerName(speaker, turn.provisionalSpeakerLabel)}</span>
            {speaker && (
              <Pencil
                className="size-3 opacity-0 transition-opacity group-hover/name:opacity-100"
                aria-hidden
              />
            )}
          </button>
        )}
        <time className="mt-1 block font-mono text-[11px] tabular-nums text-text-tertiary">
          {formatTime(turn.startMs)}
        </time>
      </div>
      <LiveUtterance turn={turn} claims={claims} />
    </article>
  );
}
