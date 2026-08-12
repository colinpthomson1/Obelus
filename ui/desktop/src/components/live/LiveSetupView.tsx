import { AlertCircle, AudioLines, Check, Info, Mic, MonitorUp, Users } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { cn } from '../../utils';
import { AudioLevelMeter } from './AudioLevelMeter';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';
import type { LiveFactCheckMode } from '../../live/ipcTypes';

export function gatewayUnavailableSetupMessage(
  localSttAvailable: boolean,
  reason?: string,
  localFactCheckMode: LiveFactCheckMode = 'hosted',
  localFactCheckAvailable = false,
  localFactCheckUnavailableReason?: string
): string {
  const localAudioMessage = localSttAvailable
    ? 'Local audio and on-device transcription are available now.'
    : 'Local audio can record now.';
  if (localFactCheckMode === 'subscription_web') {
    if (localFactCheckAvailable) {
      return `${localAudioMessage} Preliminary fact-checks using ChatGPT and public-web evidence are available now.`;
    }
    const unavailableReason = localFactCheckUnavailableReason?.trim().replace(/\.+$/, '');
    return `${localAudioMessage} Fact-checking with ChatGPT and public-web evidence is unavailable${
      unavailableReason ? `: ${unavailableReason}` : ''
    }.`;
  }
  if (localFactCheckMode === 'local_wikimedia') {
    if (localFactCheckAvailable) {
      return `${localAudioMessage} Preliminary Wikimedia checks are available now, with assessment on this Mac.`;
    }
    const unavailableReason = localFactCheckUnavailableReason?.trim().replace(/\.+$/, '');
    return `${localAudioMessage} Preliminary checks use Wikipedia and Wikidata, with assessment on this Mac, but local assessment is unavailable${
      unavailableReason ? `: ${unavailableReason}` : ''
    }.`;
  }
  const requiresConfiguration =
    reason !== undefined &&
    /(?:not configured|authentication is disabled|not signed in|signed out|sign in)/i.test(reason);
  if (localSttAvailable) {
    return requiresConfiguration
      ? 'Local audio and on-device transcription are available now. Evidence research needs the Obelus gateway to be configured and signed in.'
      : 'Local audio and on-device transcription are available now. Evidence research will reconnect when the Obelus gateway is reachable.';
  }
  return requiresConfiguration
    ? 'Local audio can record now. Live transcription and evidence research need the Obelus gateway to be configured and signed in.'
    : 'Local audio can record now. Live transcription and evidence research will reconnect when the Obelus gateway is reachable.';
}

export function factCheckProcessingDisclosure(localFactCheckMode: LiveFactCheckMode): string {
  if (localFactCheckMode === 'subscription_web') {
    return 'Automatic detection sends bounded finalized transcript excerpts to ChatGPT. Checks send search queries and page requests to public web sources; identified claims and retrieved evidence also go to ChatGPT. Findings are preliminary and limited to the sources retrieved.';
  }
  if (localFactCheckMode === 'local_wikimedia') {
    return 'Automatic and manual checks send the claim text as search terms to English Wikipedia and Wikidata. Assessment runs on this Mac; findings are preliminary and limited to those secondary sources.';
  }
  return 'Automatic and manual checks use the configured Obelus research gateway and its disclosed providers.';
}

export function LiveSetupView() {
  const {
    state,
    devices,
    microphoneMeter,
    systemMeter,
    support,
    setSetup,
    startMeeting,
    refreshDevices,
    testMicrophone,
  } = useLiveMeetingRuntime();
  const { setup, runtime } = state;
  const starting = runtime.lifecycle === 'starting';
  const callMode = setup.mode === 'call';
  const checkingPermissions = support.checkingPermissions;
  const systemUnavailable =
    !checkingPermissions &&
    (!support.systemAudioSupported ||
      support.systemAudioPermission === 'denied' ||
      support.systemAudioPermission === 'restricted');

  return (
    <section
      aria-labelledby="live-setup-title"
      className="min-w-0 flex-1 px-8 pb-10 pt-16 md:px-12"
    >
      <div className="mx-auto max-w-3xl">
        <div className="mb-10 max-w-2xl">
          <p className="mb-2 font-mono text-xs font-medium uppercase tracking-[0.12em] text-brand-blue">
            Live fact check
          </p>
          <h1
            id="live-setup-title"
            className="text-[28px] font-semibold leading-[1.15] text-text-primary"
          >
            Start with the conversation.
          </h1>
          <p className="mt-3 max-w-xl text-base leading-7 text-text-secondary">
            Capture a call or room conversation, follow the transcript as it develops, and build an
            evidence trail around the claims that matter.
          </p>
        </div>

        <div className="space-y-8">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-text-primary">Meeting title</span>
            <Input
              value={setup.title}
              onChange={(event) => setSetup({ title: event.target.value })}
              maxLength={160}
              placeholder="Untitled live session"
              className="h-11 bg-brand-cloud text-base dark:bg-brand-ink-elevated"
            />
          </label>

          <fieldset>
            <legend className="mb-3 text-sm font-medium text-text-primary">Recording mode</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                aria-pressed={setup.mode === 'call'}
                onClick={() => setSetup({ mode: 'call', micOnly: false })}
                className={cn(
                  'group flex min-h-24 items-start gap-4 rounded-xl border p-4 text-left transition-colors duration-200',
                  setup.mode === 'call'
                    ? 'border-brand-blue bg-brand-blue-soft text-brand-ink dark:border-blue-100 dark:bg-brand-ink-elevated dark:text-brand-cloud'
                    : 'border-border-primary bg-brand-cloud hover:border-border-secondary dark:bg-brand-ink-elevated'
                )}
              >
                <MonitorUp className="mt-0.5 size-5 shrink-0" />
                <span>
                  <span className="flex items-center gap-2 font-medium">
                    Call {setup.mode === 'call' && <Check className="size-4" aria-hidden />}
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-text-secondary">
                    Capture your microphone and call audio when available. Obelus falls back to the
                    microphone if system audio cannot start.
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-pressed={setup.mode === 'in_person'}
                onClick={() => setSetup({ mode: 'in_person', micOnly: true })}
                className={cn(
                  'group flex min-h-24 items-start gap-4 rounded-xl border p-4 text-left transition-colors duration-200',
                  setup.mode === 'in_person'
                    ? 'border-brand-blue bg-brand-blue-soft text-brand-ink dark:border-blue-100 dark:bg-brand-ink-elevated dark:text-brand-cloud'
                    : 'border-border-primary bg-brand-cloud hover:border-border-secondary dark:bg-brand-ink-elevated'
                )}
              >
                <Users className="mt-0.5 size-5 shrink-0" />
                <span>
                  <span className="flex items-center gap-2 font-medium">
                    In person{' '}
                    {setup.mode === 'in_person' && <Check className="size-4" aria-hidden />}
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-text-secondary">
                    Everyone is captured through the selected microphone.
                  </span>
                </span>
              </button>
            </div>
          </fieldset>

          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor="live-microphone" className="text-sm font-medium text-text-primary">
                  Microphone
                </label>
                <button
                  type="button"
                  onClick={() => void refreshDevices()}
                  className="text-xs font-medium text-brand-blue hover:underline"
                >
                  Refresh
                </button>
              </div>
              <select
                id="live-microphone"
                value={setup.microphoneDeviceId ?? ''}
                onChange={(event) => {
                  const microphoneDeviceId = event.target.value || undefined;
                  setSetup({ microphoneDeviceId });
                  void testMicrophone(microphoneDeviceId);
                }}
                className="h-11 w-full rounded-md border border-border-primary bg-brand-cloud px-3 text-sm text-text-primary dark:bg-brand-ink-elevated"
              >
                <option value="">System default</option>
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || 'Microphone'}
                  </option>
                ))}
              </select>
              <div className="mt-3 flex items-center gap-3">
                <Mic className="size-4 text-text-secondary" aria-hidden />
                <AudioLevelMeter
                  label="Microphone"
                  value={(microphoneMeter?.rms ?? runtime.microphone.meter.rms) * 4}
                  active={runtime.microphone.state !== 'error'}
                />
              </div>
            </div>

            {callMode && (
              <div>
                <span className="mb-2 block text-sm font-medium text-text-primary">
                  System Audio
                </span>
                <div
                  aria-live="polite"
                  className={cn(
                    'flex min-h-11 items-center gap-3 rounded-md border px-3 text-sm',
                    systemUnavailable
                      ? 'border-status-context/30 bg-status-context-bg text-status-context'
                      : 'border-border-primary bg-brand-cloud text-text-primary dark:bg-brand-ink-elevated'
                  )}
                >
                  {systemUnavailable ? (
                    <AlertCircle className="size-4" />
                  ) : (
                    <AudioLines className="size-4" />
                  )}
                  <span>
                    {checkingPermissions
                      ? 'Checking microphone and system audio…'
                      : !support.systemAudioSupported
                        ? 'System audio unavailable · microphone-only works'
                        : support.systemAudioPermission === 'denied'
                          ? 'Blocked in macOS settings · microphone-only works'
                          : support.systemAudioPermission === 'restricted'
                            ? 'Restricted by macOS · microphone-only works'
                            : 'Checked when recording starts'}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <MonitorUp className="size-4 text-text-secondary" aria-hidden />
                  <AudioLevelMeter
                    label="System audio"
                    value={(systemMeter?.rms ?? runtime.system.meter.rms) * 4}
                    active={!systemUnavailable && runtime.system.state !== 'error'}
                  />
                </div>
              </div>
            )}
          </div>

          <fieldset>
            <legend className="mb-1 text-sm font-medium text-text-primary">Speaker names</legend>
            <p className="mb-3 text-sm text-text-secondary">
              Optional. Obelus starts with generic labels and applies names immediately when you add
              them.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {setup.speakerNames.map((name, index) => (
                <Input
                  key={index}
                  aria-label={`Speaker ${index + 1} name`}
                  value={name}
                  onChange={(event) => {
                    const speakerNames = [...setup.speakerNames] as [string, string];
                    speakerNames[index] = event.target.value;
                    setSetup({ speakerNames });
                  }}
                  maxLength={80}
                  placeholder={`Speaker ${index + 1} name`}
                  className="h-11 bg-brand-cloud dark:bg-brand-ink-elevated"
                />
              ))}
            </div>
          </fieldset>

          <div className="flex items-center justify-between gap-4 border-y border-border-primary py-4">
            <div>
              <p className="text-sm font-medium text-text-primary">Fact-check mode</p>
              <p className="mt-0.5 text-sm text-text-secondary">Important or disputed claims</p>
              <p className="mt-2 max-w-xl text-xs leading-5 text-text-tertiary">
                {factCheckProcessingDisclosure(support.localFactCheckMode)}
              </p>
              {support.directFactCheckFallbackEnabled && (
                <p className="mt-2 max-w-xl text-xs leading-5 text-text-tertiary">
                  Direct fallback is enabled. The Obelus gateway is preferred; if it is unavailable
                  before accepting a check, bounded claim context and retrieved public-web evidence
                  may go to ChatGPT. Fallback never occurs after a hosted check ID is accepted.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Info className="size-4" aria-hidden /> Select any transcript text to check it
              manually.
            </div>
          </div>

          <div className="rounded-xl bg-brand-paper p-5 dark:bg-brand-ink-elevated">
            <p className="flex items-start gap-3 text-sm font-medium text-text-primary">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-brand-coral" aria-hidden />
              Tell everyone before recording. Recording laws vary by location.
            </p>
            <p className="ml-7 mt-2 text-xs leading-5 text-text-secondary">
              {support.localFactCheckMode === 'subscription_web'
                ? `${
                    support.localSttAvailable
                      ? 'Recorded audio and on-device transcription stay on this Mac.'
                      : 'Recorded audio stays on this Mac.'
                  } Bounded finalized transcript excerpts go to ChatGPT for automatic claim identification. Search queries and page requests go to public web sources. Identified claims and retrieved evidence go to ChatGPT under the signed-in account's workspace data policy. Local meeting and research-job data remain until you delete the meeting.`
                : support.localFactCheckMode === 'local_wikimedia'
                  ? `${
                      support.localSttAvailable
                        ? 'Audio and transcription processing stay on this Mac.'
                        : 'Recorded audio stays on this Mac.'
                    } Identified or selected claim text is sent as search terms to English Wikipedia and Wikidata. Assessment stays on this Mac. Local meeting and research-job data remain until you delete the meeting.`
                  : support.gatewayState === 'unavailable' && support.localSttAvailable
                    ? 'Audio and transcription processing stay on this Mac. Local meeting data remain until you delete the meeting.'
                    : 'Audio and transcript text may be processed by configured third-party AI services and retained until you delete the meeting.'}
            </p>
            {state.error && (
              <div
                role="alert"
                className="ml-7 mt-4 rounded-md border border-status-context/30 bg-status-context-bg px-3 py-2 text-sm text-status-context"
              >
                {state.error.message} You can adjust the microphone or permissions and try again.
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                onClick={() => void startMeeting(systemUnavailable || setup.micOnly)}
                disabled={starting || checkingPermissions}
                className="min-w-40 bg-brand-blue text-brand-cloud hover:bg-brand-blue-dark"
              >
                <span className="size-2 rounded-full bg-brand-coral" aria-hidden />
                {checkingPermissions
                  ? 'Checking permissions…'
                  : starting
                    ? 'Starting…'
                    : systemUnavailable && callMode
                      ? 'Start mic only'
                      : 'Start recording'}
              </Button>
              {callMode && !systemUnavailable && !setup.micOnly && (
                <Button
                  variant="ghost"
                  size="lg"
                  onClick={() => void startMeeting(true)}
                  disabled={starting || checkingPermissions}
                >
                  Start mic only
                </Button>
              )}
              {support.gatewayState === 'unavailable' && (
                <span className="text-sm text-status-context">
                  {gatewayUnavailableSetupMessage(
                    support.localSttAvailable,
                    support.gatewayUnavailableReason,
                    support.localFactCheckMode,
                    support.localFactCheckAvailable,
                    support.localFactCheckUnavailableReason
                  )}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
