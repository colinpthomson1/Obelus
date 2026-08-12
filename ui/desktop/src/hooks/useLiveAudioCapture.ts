import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LiveAppendAudioResult,
  LiveAudioFrame,
  LiveAudioMeter,
  LiveAudioSourceKind,
  LiveCaptureError,
  LiveMeetingMode,
  LiveStreamingStrategy,
} from '../live/ipcTypes';

const TARGET_SAMPLE_RATE = 16_000 as const;
const MIN_STT_FRAME_BYTES = 1_600;
const MAX_STT_FRAME_BYTES = 32_000;
const MEDIA_REQUEST_TIMEOUT_MS = 12_000;
const SYSTEM_AUDIO_FALLBACK_TIMEOUT_MS = 2_500;
const AUDIO_WARMUP_TIMEOUT_MS = 5_000;
const MAX_PENDING_AUDIO_FRAMES = 750;
const WORKLET_URL = new URL('live-audio-capture-worklet.js', window.location.href.split('#')[0])
  .href;

interface WorkletFrameMessage {
  type: 'frame';
  active: boolean;
  sequence: number;
  timestampMs: number;
  durationMs: number;
  droppedFrames: number;
  pcm: Partial<Record<LiveAudioSourceKind, ArrayBuffer>>;
  meters: Partial<Record<LiveAudioSourceKind, LiveAudioMeter>>;
}

interface WorkletFlushedMessage {
  type: 'flushed';
  sequence: number;
}

interface WorkletActivatedMessage {
  type: 'activated';
}

type WorkletMessage = WorkletFrameMessage | WorkletFlushedMessage | WorkletActivatedMessage;
type LivePermissionState = 'denied' | 'granted' | 'prompt';

export interface LiveCaptureWarningRecovery {
  code: 'system_audio_silent';
}

export interface LiveCaptureStartOptions {
  meetingId?: string;
  mode: LiveMeetingMode;
  microphoneDeviceId?: string;
  strategy: LiveStreamingStrategy;
  includeSystemAudio?: boolean;
  onAudioFrame?: (
    sourceKind: LiveAudioSourceKind,
    frame: ArrayBuffer,
    meetingTimeMs: number
  ) => void;
  onCaptureError?: (error: LiveCaptureError) => void;
  onCaptureWarningRecovered?: (recovery: LiveCaptureWarningRecovery) => void;
  onSystemResume?: () => void | Promise<void>;
}

export interface LiveAudioCaptureState {
  devices: MediaDeviceInfo[];
  permission: LivePermissionState | 'unknown';
  microphoneMeter: LiveAudioMeter;
  systemMeter: LiveAudioMeter;
  startCapture: (options: LiveCaptureStartOptions) => Promise<LiveCaptureStartResult>;
  activateCapture: (meetingId: string) => Promise<void>;
  pauseCapture: () => Promise<void>;
  resumeCapture: () => void;
  stopCapture: () => Promise<void>;
  testMicrophone: (deviceId?: string) => Promise<void>;
  refreshDevices: () => Promise<void>;
  error?: LiveCaptureError;
}

export interface LiveCaptureStartResult {
  includeSystemAudio: boolean;
}

interface CaptureSources {
  microphone: MediaStream;
  system?: MediaStream;
  includeSystemAudio: boolean;
  systemFallbackCause?: unknown;
}

interface CaptureSourceOpeners {
  microphone: (deviceId?: string) => Promise<MediaStream>;
  system: () => Promise<MediaStream>;
}

interface CaptureSourceStartupOptions {
  signal?: globalThis.AbortSignal;
  systemFallbackTimeoutMs?: number;
}

interface ActiveCapture {
  context: AudioContext;
  node: AudioWorkletNode;
  microphone: MediaStream;
  system?: MediaStream;
  silentGain: { disconnect(): void };
  options: LiveCaptureStartOptions;
  activated: boolean;
  paused: boolean;
  acceptingFrames: boolean;
  firstFrameAccepted: boolean;
  timelineClock?: CaptureTimelineClock;
  resolveActivated?: () => void;
  rejectActivated?: (error: Error) => void;
  resolveFirstFrame?: () => void;
  rejectFirstFrame?: (error: Error) => void;
  resolveFlushed?: () => void;
  writeQueue: LiveAudioWriteQueue;
}

interface LiveAudioWriteQueue {
  enqueue(frame: LiveAudioFrame): boolean;
  drain(): Promise<void>;
  close(): Promise<void>;
  pendingFrames(): number;
}

interface LiveAudioWriteQueueOptions {
  appendAudio: (frame: LiveAudioFrame) => Promise<LiveAppendAudioResult>;
  onAccepted?: (result: LiveAppendAudioResult, frame: LiveAudioFrame) => void;
  onError?: (error: Error) => void;
  maxPendingFrames?: number;
}

export interface CaptureTimelineClock {
  activatedAtEpochMs: number;
  offsetMs: number;
  lastWorkletEndMs: number;
  lastMeetingEndMs: number;
  gapStartedAtEpochMs?: number;
}

interface LiveWakeLockSentinel {
  release(): Promise<void>;
  released: boolean;
}

const EMPTY_METER = { rms: 0, peak: 0 };

export function createLiveAudioWriteQueue(
  options: LiveAudioWriteQueueOptions
): LiveAudioWriteQueue {
  const maxPendingFrames = options.maxPendingFrames ?? MAX_PENDING_AUDIO_FRAMES;
  if (!Number.isSafeInteger(maxPendingFrames) || maxPendingFrames < 1) {
    throw new Error('The local audio queue size is invalid');
  }

  let accepting = true;
  let pendingFrames = 0;
  let failure: Error | undefined;
  let tail = Promise.resolve();

  const fail = (cause: unknown) => {
    if (failure) return;
    failure = cause instanceof Error ? cause : new Error('The local audio write failed');
    accepting = false;
    options.onError?.(failure);
  };

  return {
    enqueue(frame) {
      if (!accepting) return false;
      if (pendingFrames >= maxPendingFrames) {
        const overflow = new Error('The local audio writer could not keep up with the recording.');
        fail(overflow);
        throw overflow;
      }

      pendingFrames += 1;
      tail = tail
        .then(async () => {
          if (failure) return;
          try {
            const result = await options.appendAudio(frame);
            if (!result.accepted) {
              throw new Error(
                result.duplicate
                  ? 'The local audio writer rejected a duplicate frame.'
                  : 'The local audio writer stopped accepting frames before the renderer queue drained.'
              );
            }
            options.onAccepted?.(result, frame);
          } catch (error) {
            fail(error);
          }
        })
        .finally(() => {
          pendingFrames -= 1;
        });
      return true;
    },
    async drain() {
      await tail;
      if (failure) throw failure;
    },
    async close() {
      accepting = false;
      await tail;
      if (failure) throw failure;
    },
    pendingFrames: () => pendingFrames,
  };
}

export function createCaptureTimelineClock(activatedAtEpochMs: number): CaptureTimelineClock {
  return {
    activatedAtEpochMs,
    offsetMs: 0,
    lastWorkletEndMs: 0,
    lastMeetingEndMs: 0,
  };
}

export function beginCaptureClockGap(clock: CaptureTimelineClock, nowEpochMs: number): void {
  clock.gapStartedAtEpochMs ??= nowEpochMs;
}

export function completeCaptureClockGap(clock: CaptureTimelineClock, nowEpochMs: number): void {
  if (clock.gapStartedAtEpochMs !== undefined) {
    clock.offsetMs += Math.max(0, nowEpochMs - clock.gapStartedAtEpochMs);
    clock.gapStartedAtEpochMs = undefined;
    return;
  }
  const wallClockElapsedMs = Math.max(0, nowEpochMs - clock.activatedAtEpochMs);
  const mappedWorkletEndMs = clock.lastWorkletEndMs + clock.offsetMs;
  clock.offsetMs += Math.max(0, wallClockElapsedMs - mappedWorkletEndMs);
}

export function meetingTimeForWorkletFrame(
  clock: CaptureTimelineClock,
  workletStartMs: number,
  durationMs: number
): number {
  const meetingTimeMs = Math.max(clock.lastMeetingEndMs, workletStartMs + clock.offsetMs);
  clock.lastWorkletEndMs = Math.max(clock.lastWorkletEndMs, workletStartMs + durationMs);
  clock.lastMeetingEndMs = Math.max(clock.lastMeetingEndMs, meetingTimeMs + durationMs);
  return meetingTimeMs;
}

export function isValidSttPcmFrame(byteLength: number): boolean {
  return byteLength >= MIN_STT_FRAME_BYTES && byteLength <= MAX_STT_FRAME_BYTES;
}

function captureError(code: string, message: string, retryable: boolean): LiveCaptureError {
  return { code, message, retryable };
}

export function captureStartupError(cause: unknown): LiveCaptureError {
  const denied = cause instanceof DOMException && cause.name === 'NotAllowedError';
  const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
  const missing = cause instanceof DOMException && cause.name === 'NotFoundError';
  const message =
    cause instanceof DOMException ? cause.message : cause instanceof Error ? cause.message : '';
  const noFrames = message === 'The microphone did not produce audio frames.';

  return captureError(
    denied
      ? 'microphone_permission_denied'
      : timedOut
        ? 'capture_start_timeout'
        : missing
          ? 'microphone_unavailable'
          : noFrames
            ? 'microphone_no_frames'
            : 'capture_start_failed',
    denied
      ? 'Microphone permission was not granted. Enable it in System Settings and try again.'
      : timedOut
        ? message || 'Audio startup did not respond. Check microphone permission and try again.'
        : missing
          ? 'No microphone is available. Connect one or choose another input and try again.'
          : noFrames
            ? 'The microphone opened, but no audio frames arrived. Choose another input and try again.'
            : 'Obelus could not start the selected microphone.',
    true
  );
}

function timeoutError(message: string): DOMException {
  return new DOMException(message, 'TimeoutError');
}

function captureAbortedError(): DOMException {
  return new DOMException('Audio capture start was cancelled.', 'AbortError');
}

function stopMediaStream(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function closeCaptureFrameBoundary(active: ActiveCapture): void {
  if (!active.acceptingFrames) return;
  active.acceptingFrames = false;
  stopMediaStream(active.microphone);
  stopMediaStream(active.system);
}

export async function requestMediaStreamWithTimeout(
  request: () => Promise<MediaStream>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<MediaStream> {
  let expired = false;
  let timeoutId: number | undefined;
  const pending = request().then((stream) => {
    if (expired) {
      stream.getTracks().forEach((track) => track.stop());
      throw timeoutError(timeoutMessage);
    }
    return stream;
  });
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      expired = true;
      reject(timeoutError(timeoutMessage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

async function operationWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(timeoutError(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

async function openMicrophone(deviceId?: string): Promise<MediaStream> {
  const constraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  try {
    return await requestMediaStreamWithTimeout(
      () => navigator.mediaDevices.getUserMedia({ audio: constraints, video: false }),
      MEDIA_REQUEST_TIMEOUT_MS,
      'Microphone access did not respond.'
    );
  } catch (error) {
    if (
      deviceId &&
      error instanceof DOMException &&
      (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')
    ) {
      delete constraints.deviceId;
      return requestMediaStreamWithTimeout(
        () => navigator.mediaDevices.getUserMedia({ audio: constraints, video: false }),
        MEDIA_REQUEST_TIMEOUT_MS,
        'Microphone access did not respond.'
      );
    }
    throw error;
  }
}

async function openSystemAudio(): Promise<MediaStream> {
  const stream = await requestMediaStreamWithTimeout(
    () =>
      navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: { ideal: 2 }, height: { ideal: 2 }, frameRate: { ideal: 1 } },
      }),
    MEDIA_REQUEST_TIMEOUT_MS,
    'System Audio access did not respond.'
  );
  stream.getVideoTracks().forEach((track) => track.stop());
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new DOMException('No system audio track was granted', 'NotAllowedError');
  }
  return stream;
}

export async function openCaptureSources(
  options: Pick<LiveCaptureStartOptions, 'mode' | 'includeSystemAudio' | 'microphoneDeviceId'>,
  openers: CaptureSourceOpeners = { microphone: openMicrophone, system: openSystemAudio },
  startup: CaptureSourceStartupOptions = {}
): Promise<CaptureSources> {
  if (startup.signal?.aborted) throw captureAbortedError();
  const systemRequested = options.mode === 'call' && options.includeSystemAudio !== false;
  if (!systemRequested) {
    const microphone = await openers.microphone(options.microphoneDeviceId);
    return { microphone, includeSystemAudio: false };
  }

  let operationAbandoned = false;
  let microphone: MediaStream | undefined;
  let system: MediaStream | undefined;
  let systemAbandoned = false;
  let systemAbandonReason: unknown;
  let abortHandler: (() => void) | undefined;
  let systemFallbackTimer: number | undefined;

  const abandonSystem = (reason: unknown) => {
    systemAbandoned = true;
    systemAbandonReason = reason;
    stopMediaStream(system);
    system = undefined;
  };
  const abandonOperation = (reason: unknown) => {
    operationAbandoned = true;
    abandonSystem(reason);
    stopMediaStream(microphone);
    microphone = undefined;
  };

  let abortPromise: Promise<never> | undefined;
  if (startup.signal) {
    abortPromise = new Promise<never>((_, reject) => {
      abortHandler = () => {
        const error = captureAbortedError();
        abandonOperation(error);
        reject(error);
      };
      startup.signal?.addEventListener('abort', abortHandler, { once: true });
    });
  }
  const withAbort = <T>(operation: Promise<T>): Promise<T> =>
    abortPromise ? Promise.race([operation, abortPromise]) : operation;

  // getDisplayMedia must be invoked during the click activation. Keep its ownership separate so
  // the microphone can become usable even when the system picker never settles.
  const systemRequest = invokeMediaStreamOpener(openers.system);
  const microphoneRequest = invokeMediaStreamOpener(() =>
    openers.microphone(options.microphoneDeviceId)
  );
  const systemOutcome = systemRequest.then(
    (stream) => {
      if (operationAbandoned || systemAbandoned) {
        stopMediaStream(stream);
        return {
          status: 'rejected' as const,
          reason: systemAbandonReason ?? captureAbortedError(),
        };
      }
      system = stream;
      return { status: 'fulfilled' as const, value: stream };
    },
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  );
  const fallbackCause = timeoutError(
    'System Audio did not respond in time, so Obelus started microphone-only capture.'
  );
  const systemFallback = new Promise<{ status: 'rejected'; reason: unknown }>((resolve) => {
    systemFallbackTimer = window.setTimeout(() => {
      abandonSystem(fallbackCause);
      resolve({ status: 'rejected', reason: fallbackCause });
    }, startup.systemFallbackTimeoutMs ?? SYSTEM_AUDIO_FALLBACK_TIMEOUT_MS);
  });

  try {
    microphone = await withAbort(
      microphoneRequest.then((stream) => {
        if (operationAbandoned) {
          stopMediaStream(stream);
          throw captureAbortedError();
        }
        return stream;
      })
    );
    const systemResult = await withAbort(Promise.race([systemOutcome, systemFallback]));
    if (!microphone) throw captureAbortedError();
    const acceptedMicrophone = microphone;
    microphone = undefined;
    if (systemResult.status === 'rejected') {
      abandonSystem(systemResult.reason);
      return {
        microphone: acceptedMicrophone,
        includeSystemAudio: false,
        systemFallbackCause: systemResult.reason,
      };
    }
    const acceptedSystem = systemResult.value;
    system = undefined;
    return {
      microphone: acceptedMicrophone,
      system: acceptedSystem,
      includeSystemAudio: true,
    };
  } catch (error) {
    abandonOperation(error);
    throw error;
  } finally {
    if (systemFallbackTimer !== undefined) window.clearTimeout(systemFallbackTimer);
    if (startup.signal && abortHandler) {
      startup.signal.removeEventListener('abort', abortHandler);
    }
  }
}

function invokeMediaStreamOpener(opener: () => Promise<MediaStream>): Promise<MediaStream> {
  try {
    return opener();
  } catch (error) {
    return Promise.reject(error);
  }
}

export function useLiveAudioCapture(): LiveAudioCaptureState {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [permission, setPermission] = useState<LivePermissionState | 'unknown'>('unknown');
  const [microphoneMeter, setMicrophoneMeter] = useState<LiveAudioMeter>(EMPTY_METER);
  const [systemMeter, setSystemMeter] = useState<LiveAudioMeter>(EMPTY_METER);
  const [error, setError] = useState<LiveCaptureError>();
  const activeRef = useRef<ActiveCapture | undefined>(undefined);
  const stopPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const startupAbortRef = useRef<AbortController | undefined>(undefined);
  const captureSessionIdRef = useRef(window.crypto.randomUUID());
  const firstMicrophoneFrameRef = useRef<(() => void) | undefined>(undefined);
  const systemHealthTimerRef = useRef<number | undefined>(undefined);
  const latestSystemActivityRef = useRef(0);
  const wakeLockRef = useRef<LiveWakeLockSentinel | undefined>(undefined);

  const releaseWakeLock = useCallback(async () => {
    const lock = wakeLockRef.current;
    wakeLockRef.current = undefined;
    if (lock && !lock.released) await lock.release().catch(() => undefined);
  }, []);

  const acquireWakeLock = useCallback(async () => {
    const wakeLock = (
      navigator as typeof navigator & {
        wakeLock?: { request(type: 'screen'): Promise<LiveWakeLockSentinel> };
      }
    ).wakeLock;
    if (!wakeLock || document.visibilityState !== 'visible') return;
    await releaseWakeLock();
    wakeLockRef.current = await wakeLock.request('screen').catch(() => undefined);
  }, [releaseWakeLock]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices(all.filter((device) => device.kind === 'audioinput'));
  }, []);

  useEffect(() => {
    void refreshDevices();
    const onDeviceChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', onDeviceChange);
    if (navigator.permissions?.query) {
      void navigator.permissions
        .query({ name: 'microphone' } as Parameters<typeof navigator.permissions.query>[0])
        .then((status) => {
          setPermission(status.state);
          status.addEventListener('change', () => setPermission(status.state));
        })
        .catch(() => setPermission('unknown'));
    }
    return () => navigator.mediaDevices?.removeEventListener('devicechange', onDeviceChange);
  }, [refreshDevices]);

  const stopCapture = useCallback((): Promise<void> => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const operation = (async () => {
      startupAbortRef.current?.abort();
      startupAbortRef.current = undefined;
      if (systemHealthTimerRef.current !== undefined) {
        window.clearTimeout(systemHealthTimerRef.current);
        systemHealthTimerRef.current = undefined;
      }
      firstMicrophoneFrameRef.current = undefined;
      await releaseWakeLock();
      const active = activeRef.current;
      if (!active) return;
      const stoppedError = new Error('Audio capture stopped before it became active');
      active.rejectActivated?.(stoppedError);
      active.rejectFirstFrame?.(stoppedError);
      await Promise.race([
        new Promise<void>((resolve) => {
          active.resolveFlushed = resolve;
          active.node.port.postMessage({ type: 'flush' });
        }),
        new Promise<void>((resolve) => window.setTimeout(resolve, 500)),
      ]);
      closeCaptureFrameBoundary(active);
      await active.writeQueue.close().catch(() => undefined);
      activeRef.current = undefined;
      active.node.port.onmessage = null;
      active.node.disconnect();
      active.silentGain.disconnect();
      await active.context.close().catch(() => undefined);
      setMicrophoneMeter(EMPTY_METER);
      setSystemMeter(EMPTY_METER);
    })();
    stopPromiseRef.current = operation.finally(() => {
      stopPromiseRef.current = undefined;
    });
    return stopPromiseRef.current;
  }, [releaseWakeLock]);

  const startCapture = useCallback(
    async (options: LiveCaptureStartOptions) => {
      await stopCapture();
      setError(undefined);
      captureSessionIdRef.current = window.crypto.randomUUID();
      latestSystemActivityRef.current = 0;
      const startupAbort = new AbortController();
      startupAbortRef.current = startupAbort;

      let microphone: MediaStream | undefined;
      let system: MediaStream | undefined;
      let context: AudioContext | undefined;
      let systemSilenceWarningActive = false;
      try {
        const sources = await openCaptureSources(options, undefined, {
          signal: startupAbort.signal,
        });
        if (startupAbort.signal.aborted) throw captureAbortedError();
        microphone = sources.microphone;
        system = sources.system;
        const includeSystemAudio = sources.includeSystemAudio;
        options.includeSystemAudio = includeSystemAudio;
        if (sources.systemFallbackCause !== undefined) {
          const fallback = captureError(
            'system_audio_fallback',
            'System Audio could not start, so this meeting is recording the microphone only.',
            false
          );
          setError(fallback);
          options.onCaptureError?.(fallback);
        }

        context = new AudioContext({ latencyHint: 'interactive' });
        await operationWithTimeout(
          context.audioWorklet.addModule(WORKLET_URL),
          AUDIO_WARMUP_TIMEOUT_MS,
          'The audio processor did not load.'
        );
        if (startupAbort.signal.aborted) throw captureAbortedError();
        const node = new AudioWorkletNode(context, 'obelus-live-audio-capture', {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { includeSystemAudio },
        });
        const microphoneSource = context.createMediaStreamSource(microphone);
        microphoneSource.connect(node, 0, 0);
        if (system) context.createMediaStreamSource(system).connect(node, 0, 1);
        const silentGain = context.createGain();
        silentGain.gain.value = 0;
        node.connect(silentGain).connect(context.destination);

        let activeCapture: ActiveCapture;
        const writeQueue = createLiveAudioWriteQueue({
          appendAudio: (frame) => window.electron.live.appendAudio(frame),
          onAccepted: (result) => {
            if (
              result.accepted &&
              activeRef.current === activeCapture &&
              !activeCapture.firstFrameAccepted
            ) {
              activeCapture.firstFrameAccepted = true;
              activeCapture.resolveFirstFrame?.();
              activeCapture.resolveFirstFrame = undefined;
              activeCapture.rejectFirstFrame = undefined;
            }
          },
          onError: () => {
            if (activeRef.current !== activeCapture) return;
            const nextError = captureError(
              'audio_writer_unavailable',
              'Local audio could not be written. Recording has stopped to protect the artifact.',
              false
            );
            setError(nextError);
            activeCapture.rejectFirstFrame?.(new Error(nextError.message));
            options.onCaptureError?.(nextError);
            void stopCapture();
          },
        });
        activeCapture = {
          context,
          node,
          microphone,
          system,
          silentGain,
          options,
          activated: false,
          paused: false,
          acceptingFrames: true,
          firstFrameAccepted: false,
          writeQueue,
        };
        activeRef.current = activeCapture;
        const handleTrackEnded = () => {
          if (activeRef.current?.node !== node || !activeCapture.acceptingFrames) return;
          const nextError = captureError(
            'audio_device_ended',
            'An audio source disconnected. Local recording stopped so the gap is explicit.',
            true
          );
          setError(nextError);
          options.onCaptureError?.(nextError);
          void stopCapture();
        };
        microphone
          .getAudioTracks()
          .forEach((track) => track.addEventListener('ended', handleTrackEnded, { once: true }));
        system
          ?.getAudioTracks()
          .forEach((track) => track.addEventListener('ended', handleTrackEnded, { once: true }));
        node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
          const message = event.data;
          if (activeRef.current?.node !== node) return;
          if (message.type === 'activated') {
            activeRef.current.activated = true;
            activeRef.current.resolveActivated?.();
            activeRef.current.resolveActivated = undefined;
            activeRef.current.rejectActivated = undefined;
            return;
          }
          if (message.type === 'flushed') {
            closeCaptureFrameBoundary(activeCapture);
            activeCapture.resolveFlushed?.();
            activeCapture.resolveFlushed = undefined;
            return;
          }
          if (!activeCapture.acceptingFrames || activeCapture.paused) return;
          const micMeter = message.meters.microphone;
          const desktopMeter = message.meters.system;
          if (micMeter) {
            setMicrophoneMeter(micMeter);
            firstMicrophoneFrameRef.current?.();
            firstMicrophoneFrameRef.current = undefined;
          }
          if (desktopMeter) {
            setSystemMeter(desktopMeter);
            if (desktopMeter.rms > 0.001) {
              latestSystemActivityRef.current = Date.now();
              if (systemSilenceWarningActive) {
                systemSilenceWarningActive = false;
                setError((current) =>
                  current?.code === 'system_audio_silent' ? undefined : current
                );
                options.onCaptureWarningRecovered?.({ code: 'system_audio_silent' });
              }
            }
          }
          if (!message.active) return;
          const meetingId = options.meetingId;
          if (!meetingId) return;
          const clock = activeRef.current.timelineClock;
          if (!clock) return;
          const meetingTimeMs = meetingTimeForWorkletFrame(
            clock,
            message.timestampMs,
            message.durationMs
          );
          for (const [sourceKind, frame] of Object.entries(message.pcm) as Array<
            [LiveAudioSourceKind, ArrayBuffer | undefined]
          >) {
            if (frame && isValidSttPcmFrame(frame.byteLength)) {
              options.onAudioFrame?.(sourceKind, frame, meetingTimeMs);
            }
          }
          const frame: LiveAudioFrame = {
            meetingId,
            captureSessionId: captureSessionIdRef.current,
            sequence: message.sequence,
            meetingTimeMs,
            durationMs: message.durationMs,
            sampleRate: TARGET_SAMPLE_RATE,
            channels: 1,
            pcm: message.pcm,
            meters: message.meters,
            workletDroppedFrames: message.droppedFrames,
          };
          try {
            activeCapture.writeQueue.enqueue(frame);
          } catch {
            return;
          }
        };
        const firstFrame = Promise.race([
          new Promise<void>((resolve) => {
            firstMicrophoneFrameRef.current = resolve;
          }),
          new Promise<never>((_, reject) => {
            window.setTimeout(
              () => reject(new Error('The microphone did not produce audio frames.')),
              2_500
            );
          }),
        ]);
        node.port.start();
        await operationWithTimeout(
          context.resume(),
          AUDIO_WARMUP_TIMEOUT_MS,
          'The audio device did not become ready.'
        );
        await firstFrame;
        if (startupAbort.signal.aborted) throw captureAbortedError();
        void acquireWakeLock();

        if (includeSystemAudio) {
          systemHealthTimerRef.current = window.setTimeout(() => {
            systemHealthTimerRef.current = undefined;
            if (activeRef.current?.node !== node) return;
            if (latestSystemActivityRef.current === 0) {
              systemSilenceWarningActive = true;
              const nextError = captureError(
                'system_audio_silent',
                'System Audio is connected but silent. Play call audio to confirm capture before relying on it.',
                true
              );
              setError(nextError);
              options.onCaptureError?.(nextError);
            }
          }, 5_000);
        }
        void refreshDevices();
        return { includeSystemAudio };
      } catch (cause) {
        firstMicrophoneFrameRef.current = undefined;
        if (activeRef.current?.microphone === microphone) {
          await stopCapture();
        } else {
          microphone?.getTracks().forEach((track) => track.stop());
          system?.getTracks().forEach((track) => track.stop());
          if (context && context.state !== 'closed') await context.close();
        }
        if (startupAbort.signal.aborted) {
          throw captureError('capture_start_cancelled', 'Audio capture start was cancelled.', true);
        }
        const nextError = captureStartupError(cause);
        setError(nextError);
        options.onCaptureError?.(nextError);
        throw nextError;
      } finally {
        if (startupAbortRef.current === startupAbort) startupAbortRef.current = undefined;
      }
    },
    [acquireWakeLock, refreshDevices, stopCapture]
  );

  const activateCapture = useCallback(async (meetingId: string) => {
    const active = activeRef.current;
    if (!active) throw new Error('Audio capture is not ready');
    active.options.meetingId = meetingId;
    if (active.activated && active.firstFrameAccepted) return;
    captureSessionIdRef.current = window.crypto.randomUUID();
    active.timelineClock = createCaptureTimelineClock(Date.now());
    const firstFrame = new Promise<void>((resolve, reject) => {
      active.resolveFirstFrame = resolve;
      active.rejectFirstFrame = reject;
    });
    if (!active.activated) {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          active.resolveActivated = resolve;
          active.rejectActivated = reject;
          active.node.port.postMessage({ type: 'activate' });
        }),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error('Audio capture activation timed out')), 2_500);
        }),
      ]);
    }
    await Promise.race([
      firstFrame,
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('The first audio frame was not accepted')), 2_500);
      }),
    ]);
  }, []);

  const pauseCapture = useCallback(async () => {
    const active = activeRef.current;
    if (!active || active.paused) return;
    active.paused = true;
    if (active.timelineClock) beginCaptureClockGap(active.timelineClock, Date.now());
    await active.context.suspend();
    await active.writeQueue.drain();
  }, []);
  const resumeCapture = useCallback(() => {
    const active = activeRef.current;
    if (!active || !active.paused) return;
    active.paused = false;
    if (active.timelineClock) completeCaptureClockGap(active.timelineClock, Date.now());
    void active.context.resume();
  }, []);

  const testMicrophone = useCallback(async (deviceId?: string) => {
    const stream = await openMicrophone(deviceId);
    const context = new AudioContext({ latencyHint: 'interactive' });
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const started = window.performance.now();
    try {
      while (window.performance.now() - started < 1_500) {
        analyser.getFloatTimeDomainData(samples);
        let peak = 0;
        let sum = 0;
        for (const sample of samples) {
          peak = Math.max(peak, Math.abs(sample));
          sum += sample * sample;
        }
        setMicrophoneMeter({ rms: Math.sqrt(sum / samples.length), peak });
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
    } finally {
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
    }
  }, []);

  useEffect(() => () => void stopCapture(), [stopCapture]);

  useEffect(() => {
    const reacquire = () => {
      if (document.visibilityState === 'visible' && activeRef.current) void acquireWakeLock();
    };
    document.addEventListener('visibilitychange', reacquire);
    return () => document.removeEventListener('visibilitychange', reacquire);
  }, [acquireWakeLock]);

  useEffect(() => {
    const resumeAfterSystemWake = () => {
      const active = activeRef.current;
      if (!active) return;
      if (active.timelineClock) completeCaptureClockGap(active.timelineClock, Date.now());
      void (async () => {
        await Promise.resolve(active.options.onSystemResume?.()).catch(() => undefined);
        if (activeRef.current !== active || active.paused) return;
        await active.context.resume();
        await acquireWakeLock();
      })();
    };
    window.electron.on('system-resume', resumeAfterSystemWake);
    return () => window.electron.off('system-resume', resumeAfterSystemWake);
  }, [acquireWakeLock]);

  return {
    devices,
    permission,
    microphoneMeter,
    systemMeter,
    startCapture,
    activateCapture,
    pauseCapture,
    resumeCapture,
    stopCapture,
    testMicrophone,
    refreshDevices,
    error,
  };
}
