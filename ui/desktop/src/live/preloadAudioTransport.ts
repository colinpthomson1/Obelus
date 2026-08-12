import type {
  LiveAppendAudioResult,
  LiveAudioFrame,
  LiveAudioPortRequest,
  LiveAudioPortResponse,
} from './ipcTypes';

interface AudioMessagePort {
  onmessage: ((event: MessageEvent<LiveAudioPortResponse>) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  start(): void;
  close(): void;
  postMessage(message: LiveAudioPortRequest): void;
}

interface AudioMessageChannel<TPort> {
  port1: AudioMessagePort;
  port2: TPort;
}

export interface LiveAudioTransportOptions<TPort> {
  createChannel: () => AudioMessageChannel<TPort>;
  transferPort: (port: TPort) => void;
  maxPendingFrames?: number;
  ackTimeoutMs?: number;
}

export interface LiveAudioTransport {
  connect(): void;
  append(frame: LiveAudioFrame): Promise<LiveAppendAudioResult>;
  close(): void;
}

interface PendingAudioRequest {
  resolve: (result: LiveAppendAudioResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_MAX_PENDING_FRAMES = 8;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;

export function createLiveAudioTransport<TPort>(
  options: LiveAudioTransportOptions<TPort>
): LiveAudioTransport {
  const maxPendingFrames = options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES;
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const pending = new Map<number, PendingAudioRequest>();
  let channel: AudioMessageChannel<TPort> | undefined;
  let nextRequestId = 0;

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  const releaseChannel = (error?: Error) => {
    const released = channel;
    channel = undefined;
    if (released) {
      released.port1.onmessage = null;
      released.port1.onmessageerror = null;
      released.port1.close();
    }
    if (error) rejectPending(error);
  };

  const connect = () => {
    releaseChannel(
      pending.size > 0 ? new Error('The local audio channel was reconnected') : undefined
    );
    const next = options.createChannel();
    channel = next;
    next.port1.onmessage = (event) => {
      if (channel !== next) return;
      const response = event.data;
      if (!response || !Number.isSafeInteger(response.requestId)) {
        releaseChannel(new Error('The local audio channel returned an invalid response'));
        return;
      }
      const request = pending.get(response.requestId);
      if (!request) return;
      pending.delete(response.requestId);
      clearTimeout(request.timeout);
      if (response.ok) request.resolve(response.result);
      else request.reject(new Error(response.error));
    };
    next.port1.onmessageerror = () => {
      if (channel === next) {
        releaseChannel(new Error('The local audio channel closed unexpectedly'));
      }
    };
    next.port1.start();
    options.transferPort(next.port2);
  };

  const append = (frame: LiveAudioFrame): Promise<LiveAppendAudioResult> => {
    if (pending.size >= maxPendingFrames) {
      return Promise.reject(new Error('The local audio queue is full'));
    }
    if (!channel) connect();
    const activeChannel = channel;
    if (!activeChannel) return Promise.reject(new Error('The local audio channel is unavailable'));

    const requestId = nextRequestId;
    nextRequestId = (nextRequestId + 1) % Number.MAX_SAFE_INTEGER;
    const request: LiveAudioPortRequest = { requestId, frame };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('The local audio write timed out'));
        if (channel === activeChannel) {
          releaseChannel(new Error('The local audio channel closed unexpectedly'));
        }
      }, ackTimeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      try {
        // These ArrayBuffers crossed contextBridge to reach preload. Re-transferring them makes
        // Electron deliver a null MessagePort payload; structured cloning preserves the bytes.
        activeChannel.port1.postMessage(request);
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(requestId);
        if (channel === activeChannel) releaseChannel();
        reject(error instanceof Error ? error : new Error('The local audio write failed'));
      }
    });
  };

  return {
    connect,
    append,
    close: () => releaseChannel(new Error('The local audio channel closed unexpectedly')),
  };
}
