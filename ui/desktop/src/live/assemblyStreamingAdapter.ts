import type {
  ProviderSpeakerRevisionEvent,
  ProviderTurnEvent,
  StreamingTranscriptionEvent,
  TimedWord,
  TypedError,
} from './types';

export interface StreamingSessionConfiguration {
  token: string;
  websocketUrl?: string;
  providerSessionId: string;
  model: string;
  sampleRate: number;
  speakerLabels: boolean;
  expiresAtMs: number;
  maxSessionDurationSeconds: number;
}

export interface StreamingTranscriptionProvider {
  connect(): Promise<void>;
  sendAudio(frame: ArrayBuffer): void;
  terminate(timeoutMs?: number): Promise<void>;
  close(): void;
  waitUntilReleased?(): Promise<void>;
}

type AssemblyMessage = Record<string, unknown> & { type?: string };
type BrowserWebSocket = InstanceType<typeof window.WebSocket>;

const UNIVERSAL_STREAMING_MODELS = new Set([
  'universal-streaming-english',
  'universal-streaming-multilingual',
]);
const MAX_WEBSOCKET_BUFFER_BYTES = 1_048_576;

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function configurationModel(message: AssemblyMessage): string {
  const configuration = message.configuration;
  if (configuration && typeof configuration === 'object') {
    return stringValue((configuration as Record<string, unknown>).model);
  }
  return stringValue(message.speech_model ?? message.model);
}

function typedProviderError(code: string, message: string, retryable: boolean): TypedError {
  return { code, message, retryable };
}

function parseWords(message: AssemblyMessage, turnIdentity: string): TimedWord[] {
  if (!Array.isArray(message.words)) return [];
  return message.words.flatMap((rawWord, index) => {
    if (!rawWord || typeof rawWord !== 'object') return [];
    const word = rawWord as Record<string, unknown>;
    const text = stringValue(word.text).trim();
    if (!text) return [];
    return [
      {
        id: `${turnIdentity}:word:${index}`,
        text,
        startMs: numberValue(word.start),
        endMs: numberValue(word.end),
        speakerLabel: typeof word.speaker === 'string' ? word.speaker : undefined,
        confidence:
          typeof word.confidence === 'number' && Number.isFinite(word.confidence)
            ? word.confidence
            : undefined,
        final: booleanValue(message.end_of_turn),
      },
    ];
  });
}

export function isDurableAssemblyTurn(model: string, message: AssemblyMessage): boolean {
  if (!booleanValue(message.end_of_turn)) return false;
  if (UNIVERSAL_STREAMING_MODELS.has(model)) return booleanValue(message.turn_is_formatted);
  return true;
}

export function buildAssemblyStreamingUrl(configuration: StreamingSessionConfiguration): string {
  const url = new URL(configuration.websocketUrl ?? 'wss://streaming.assemblyai.com/v3/ws');
  url.searchParams.delete('model');
  url.searchParams.set('token', configuration.token);
  url.searchParams.set('sample_rate', String(configuration.sampleRate));
  url.searchParams.set('speech_model', configuration.model);
  url.searchParams.set('speaker_labels', String(configuration.speakerLabels));
  if (UNIVERSAL_STREAMING_MODELS.has(configuration.model)) {
    url.searchParams.set('format_turns', 'true');
  }
  return url.toString();
}

export class AssemblyStreamingAdapter implements StreamingTranscriptionProvider {
  private socket?: BrowserWebSocket;
  private connectPromise?: Promise<void>;
  private readonly revisions = new Map<number, { fingerprint: string; revision: number }>();
  private terminationResolve?: () => void;
  private terminated = false;

  constructor(
    private readonly configuration: StreamingSessionConfiguration,
    private readonly onEvent: (event: StreamingTranscriptionEvent) => void,
    private readonly createSocket: (url: string) => BrowserWebSocket = (url) =>
      new window.WebSocket(url)
  ) {}

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = this.createSocket(buildAssemblyStreamingUrl(this.configuration));
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      let connectionSettled = false;
      let connectionOpened = false;
      const rejectConnection = (error: TypedError) => {
        if (connectionSettled) return;
        connectionSettled = true;
        this.onEvent({
          type: 'error',
          providerSessionId: this.configuration.providerSessionId,
          error,
        });
        reject(new Error(error.message));
      };
      socket.addEventListener('message', (event) => {
        const message = this.decodeMessage(event.data);
        if (!message) return;
        if (message.type === 'Begin') {
          const configuredModel = configurationModel(message);
          if (configuredModel !== this.configuration.model) {
            const error = typedProviderError(
              'stt_model_mismatch',
              'The transcription provider started a different model than requested.',
              false
            );
            rejectConnection(error);
            socket.close(1008, 'model mismatch');
            return;
          }
          this.onEvent({
            type: 'begin',
            providerSessionId: stringValue(
              message.id ?? message.session_id,
              this.configuration.providerSessionId
            ),
            requestedModel: this.configuration.model,
            configuredModel,
            expiresAtMs: this.configuration.expiresAtMs,
          });
          connectionOpened = true;
          connectionSettled = true;
          resolve();
          return;
        }
        this.handleMessage(message);
      });
      socket.addEventListener('error', () => {
        const error = typedProviderError(
          'stt_connection_error',
          'Live transcription connection failed.',
          true
        );
        if (!connectionOpened) rejectConnection(error);
        else {
          this.onEvent({
            type: 'error',
            providerSessionId: this.configuration.providerSessionId,
            error,
          });
        }
      });
      socket.addEventListener('close', (event) => {
        if (!connectionSettled) {
          rejectConnection(
            typedProviderError(
              'stt_connection_closed',
              'Live transcription closed before the provider confirmed the session.',
              true
            )
          );
        }
        if (connectionOpened && !this.terminated && event.code !== 1000) {
          this.onEvent({
            type: 'error',
            providerSessionId: this.configuration.providerSessionId,
            error: typedProviderError(
              'stt_connection_closed',
              'Live transcription disconnected while local recording continued.',
              true
            ),
          });
        }
        this.finishTermination();
      });
    });
    return this.connectPromise;
  }

  sendAudio(frame: ArrayBuffer): void {
    if (frame.byteLength === 0) return;
    const socket = this.socket;
    if (socket?.readyState !== window.WebSocket.OPEN) return;
    if (socket.bufferedAmount + frame.byteLength > MAX_WEBSOCKET_BUFFER_BYTES) {
      this.terminated = true;
      this.onEvent({
        type: 'error',
        providerSessionId: this.configuration.providerSessionId,
        error: typedProviderError(
          'stt_backpressure',
          'Live transcription fell behind; local recording continued while Obelus reconnected.',
          true
        ),
      });
      socket.close(1013, 'audio backpressure');
      this.finishTermination();
      return;
    }
    socket.send(frame);
  }

  async terminate(timeoutMs = 2_500): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState === window.WebSocket.CLOSED) return;
    this.terminated = true;
    const terminated = new Promise<void>((resolve) => {
      this.terminationResolve = resolve;
    });
    if (socket.readyState === window.WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'Terminate' }));
    } else {
      socket.close(1000, 'meeting stopped');
    }
    await Promise.race([
      terminated,
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (socket.readyState !== window.WebSocket.CLOSED) socket.close(1000, 'meeting stopped');
  }

  close(): void {
    this.terminated = true;
    this.socket?.close(1000, 'client closed');
    this.finishTermination();
  }

  private decodeMessage(data: unknown): AssemblyMessage | undefined {
    try {
      const raw = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as AssemblyMessage) : undefined;
    } catch {
      this.onEvent({
        type: 'error',
        providerSessionId: this.configuration.providerSessionId,
        error: typedProviderError(
          'stt_invalid_message',
          'Live transcription returned an invalid message.',
          false
        ),
      });
      return undefined;
    }
  }

  private handleMessage(message: AssemblyMessage): void {
    switch (message.type) {
      case 'Turn':
        this.onEvent(this.parseTurn(message));
        break;
      case 'SpeakerRevision':
        this.onEvent(this.parseSpeakerRevision(message));
        break;
      case 'Termination':
        this.onEvent({
          type: 'termination',
          providerSessionId: this.configuration.providerSessionId,
          sessionDurationSeconds: optionalNumber(message.session_duration_seconds),
          audioDurationSeconds: optionalNumber(message.audio_duration_seconds),
        });
        this.finishTermination();
        break;
      case 'Error':
        this.onEvent({
          type: 'error',
          providerSessionId: this.configuration.providerSessionId,
          error: typedProviderError(
            stringValue(message.error_code, 'stt_provider_error'),
            'The transcription provider could not continue this stream.',
            numberValue(message.status) >= 500 || numberValue(message.status) === 429
          ),
        });
        break;
    }
  }

  private parseTurn(message: AssemblyMessage): ProviderTurnEvent {
    const turnOrder = numberValue(message.turn_order);
    const turnId = stringValue(message.turn_id, String(turnOrder));
    const transcript = stringValue(message.transcript);
    const speakerLabel = stringValue(message.speaker_label) || undefined;
    const fingerprint = JSON.stringify([
      transcript,
      speakerLabel,
      message.end_of_turn,
      message.turn_is_formatted,
      message.words,
    ]);
    const previous = this.revisions.get(turnOrder);
    const revision =
      previous && previous.fingerprint === fingerprint
        ? previous.revision
        : (previous?.revision ?? -1) + 1;
    this.revisions.set(turnOrder, { fingerprint, revision });
    const identity = `${this.configuration.providerSessionId}:${turnId}`;
    const words = parseWords(message, identity);
    const startMs = optionalNumber(message.turn_start ?? message.start) ?? words[0]?.startMs ?? 0;
    const endMs =
      optionalNumber(message.turn_end ?? message.end) ?? words[words.length - 1]?.endMs ?? startMs;

    return {
      type: 'turn',
      providerSessionId: this.configuration.providerSessionId,
      turnId,
      turnOrder,
      revision,
      transcript,
      speakerLabel,
      words,
      startMs,
      endMs,
      utteranceBoundary: booleanValue(message.utterance_boundary ?? message.end_of_turn),
      endOfTurn: booleanValue(message.end_of_turn),
      turnIsFormatted: booleanValue(message.turn_is_formatted),
      durableFinal: isDurableAssemblyTurn(this.configuration.model, message),
      receivedAtMs: Date.now(),
    };
  }

  private parseSpeakerRevision(message: AssemblyMessage): ProviderSpeakerRevisionEvent {
    const revisions = Array.isArray(message.revisions)
      ? message.revisions.flatMap((rawRevision) => {
          if (!rawRevision || typeof rawRevision !== 'object') return [];
          const revision = rawRevision as AssemblyMessage;
          const turnOrder = numberValue(revision.turn_order);
          return [
            {
              turnOrder,
              speakerLabel: stringValue(revision.speaker_label, 'UNKNOWN'),
              words: parseWords(
                { ...revision, end_of_turn: true },
                `${this.configuration.providerSessionId}:${turnOrder}`
              ),
            },
          ];
        })
      : [];
    return {
      type: 'speaker_revision',
      providerSessionId: this.configuration.providerSessionId,
      revisions,
    };
  }

  private finishTermination(): void {
    this.terminationResolve?.();
    this.terminationResolve = undefined;
  }
}
