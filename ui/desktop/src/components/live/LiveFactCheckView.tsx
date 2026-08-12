import { LiveMeetingView } from './LiveMeetingView';
import { LiveSetupView } from './LiveSetupView';
import { MeetingHistory } from './MeetingHistory';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';

export default function LiveFactCheckView() {
  const { state } = useLiveMeetingRuntime();
  if (state.artifact || state.runtime.meetingId) return <LiveMeetingView />;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-brand-cloud dark:bg-brand-ink md:flex-row md:overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <LiveSetupView />
      </div>
      <MeetingHistory />
    </div>
  );
}
