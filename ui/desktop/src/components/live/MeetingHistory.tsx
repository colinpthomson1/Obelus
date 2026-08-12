import { Clock3, FileSearch, Search, Trash2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';

function formatMeetingDate(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatDuration(durationMs?: number): string {
  if (!durationMs) return 'No recorded audio';
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function MeetingHistory() {
  const { meetings, openMeeting, deleteMeeting } = useLiveMeetingRuntime();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const clean = query.trim().toLocaleLowerCase();
    if (!clean) return meetings;
    return meetings.filter((meeting) =>
      [meeting.title, ...meeting.speakerNames].some((value) =>
        value.toLocaleLowerCase().includes(clean)
      )
    );
  }, [meetings, query]);

  return (
    <aside className="w-full border-t border-border-primary bg-brand-paper px-6 pb-8 pt-6 dark:bg-brand-ink-elevated md:w-[360px] md:border-l md:border-t-0 md:px-7 md:pt-16">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-text-tertiary">
            Library
          </p>
          <h2 className="mt-1 text-lg font-semibold text-text-primary">Recent checks</h2>
        </div>
        <span className="font-mono text-xs tabular-nums text-text-tertiary">{meetings.length}</span>
      </div>
      <label className="relative mb-5 block">
        <Search
          className="pointer-events-none absolute left-3 top-2.5 size-4 text-text-tertiary"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search meetings"
          aria-label="Search meetings"
          className="pl-9 dark:bg-brand-ink"
        />
      </label>

      {filtered.length === 0 ? (
        <div className="py-14 text-center">
          <FileSearch className="mx-auto size-5 text-brand-blue" aria-hidden />
          <p className="mt-3 text-sm font-medium text-text-primary">
            {meetings.length === 0 ? 'Your evidence trail starts here' : 'No matching meetings'}
          </p>
          <p className="mx-auto mt-1 max-w-56 text-sm leading-5 text-text-secondary">
            {meetings.length === 0
              ? 'Completed recordings and text checks remain available to reopen.'
              : 'Try a title or speaker name.'}
          </p>
        </div>
      ) : (
        <ol className="space-y-1">
          {filtered.map((meeting) => (
            <li
              key={meeting.id}
              className="group relative border-b border-border-primary py-4 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => void openMeeting(meeting.id)}
                className="w-full pr-8 text-left"
              >
                <span className="block truncate text-sm font-medium text-text-primary group-hover:text-brand-blue">
                  {meeting.title ||
                    (meeting.artifactType === 'text_check'
                      ? 'Text fact-check'
                      : 'Untitled meeting')}
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                  <span className="flex items-center gap-1">
                    <Clock3 className="size-3" aria-hidden /> {formatMeetingDate(meeting.updatedAt)}
                  </span>
                  <span className="font-mono tabular-nums">
                    {formatDuration(meeting.durationMs)}
                  </span>
                  {meeting.speakerNames.length > 0 && (
                    <span className="flex min-w-0 items-center gap-1 truncate">
                      <Users className="size-3 shrink-0" aria-hidden />{' '}
                      {meeting.speakerNames.join(', ')}
                    </span>
                  )}
                </span>
                <span className="mt-2 flex items-center gap-2 font-mono text-[11px] text-text-tertiary">
                  <span>{meeting.claimCount} claims</span>
                  <span aria-hidden>·</span>
                  <span>
                    {meeting.completedResearchCount}/{meeting.claimCount} packets
                  </span>
                  {meeting.refinementStatus !== 'complete' &&
                    meeting.artifactType === 'meeting' && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{meeting.refinementStatus.replace(/_/g, ' ')}</span>
                      </>
                    )}
                </span>
              </button>
              <Button
                variant="ghost"
                size="xs"
                shape="round"
                className="absolute right-0 top-3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                aria-label={`Delete ${meeting.title || 'meeting'}`}
                onClick={() => void deleteMeeting(meeting.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
