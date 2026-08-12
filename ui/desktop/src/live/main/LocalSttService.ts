import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import type { Readable, Writable } from 'stream';
import {
  LOCAL_STT_MODEL,
  LOCAL_STT_SAMPLE_RATE,
  type LocalSttAppendRequest,
  type LocalSttAppendResult,
  type LocalSttStartRequest,
  type LocalSttStartResponse,
  type LocalSttStopRequest,
  type LocalSttStopResult,
  type LocalSttSupport,
  type LocalSttTurn,
} from '../localSttProtocol';

const MAX_WORKER_JSON_LINE_BYTES = 500 * 1_024;
const MAX_AUDIO_FRAME_BYTES = LOCAL_STT_SAMPLE_RATE * 2 * 2;
const MAX_CONCURRENT_SESSIONS = 2;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 75_000;
const DEFAULT_STOP_TIMEOUT_MS = 180_000;

interface WorkerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  kill(signal?: string): boolean;
}

type SpawnWorker = (
  executable: string,
  args: string[],
  options: { env: Record<string, string | undefined>; stdio: ['pipe', 'pipe', 'pipe'] }
) => WorkerProcess;

interface PendingRequest {
  resolve: (message: WorkerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerSession {
  meetingId: string;
  sessionId: string;
  providerSessionId: string;
  sourceKind: LocalSttStartRequest['sourceKind'];
  process: WorkerProcess;
  stdoutBuffer: Buffer;
  pending: Map<number, PendingRequest>;
  nextRequestId: number;
  nextSequence: number;
  droppedFrames: number;
  queuedTurns: LocalSttTurn[];
  ready: boolean;
  stopped: boolean;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readyPromise: Promise<void>;
  stopPromise?: Promise<LocalSttStopResult>;
}

type WorkerMessage = Record<string, unknown> & { type?: string; requestId?: number };

export interface LocalSttServiceOptions {
  workerPath: string;
  pythonPath?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  spawnWorker?: SpawnWorker;
}

export interface ResolveLocalSttWorkerPathOptions {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}

export function resolveLocalSttWorkerPath(options: ResolveLocalSttWorkerPathOptions): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, 'bin', 'obelus-local-stt-worker.py')
    : path.join(options.appPath, 'src', 'bin', 'obelus-local-stt-worker.py');
}

export class LocalSttService {
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly pythonPath: string;
  private readonly spawnWorker: SpawnWorker;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private supportPromise?: Promise<LocalSttSupport>;

  constructor(private readonly options: LocalSttServiceOptions) {
    this.pythonPath =
      options.pythonPath ?? (process.platform === 'darwin' ? '/usr/bin/python3' : 'python3');
    this.spawnWorker = options.spawnWorker ?? (spawn as unknown as SpawnWorker);
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  checkSupport(): Promise<LocalSttSupport> {
    this.supportPromise ??= this.probeSupport();
    return this.supportPromise;
  }

  async startSession(request: LocalSttStartRequest): Promise<LocalSttStartResponse> {
    validateStartRequest(request);
    if (
      [...this.sessions.values()].some(
        (session) =>
          session.meetingId === request.meetingId && session.sourceKind === request.sourceKind
      )
    ) {
      throw localSttError('Local transcription is already active for this audio source.');
    }
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      throw localSttError('Local transcription is already active for this meeting.');
    }
    const sessionId = randomUUID();
    const providerSessionId = `local-${sessionId}`;
    const worker = this.createWorker(['--session-id', providerSessionId]);
    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = () => resolve();
      rejectReady = (error) => reject(error);
    });
    const session: WorkerSession = {
      meetingId: request.meetingId,
      sessionId,
      providerSessionId,
      sourceKind: request.sourceKind,
      process: worker,
      stdoutBuffer: Buffer.alloc(0),
      pending: new Map(),
      nextRequestId: 0,
      nextSequence: 0,
      droppedFrames: 0,
      queuedTurns: [],
      ready: false,
      stopped: false,
      resolveReady,
      rejectReady,
      readyPromise,
    };
    this.sessions.set(sessionId, session);
    this.attachWorker(session);

    const startupTimer = setTimeout(() => {
      session.rejectReady(localSttError('Local transcription took too long to start.'));
    }, this.startupTimeoutMs);
    try {
      await session.readyPromise;
    } catch {
      this.disposeSession(session, true);
      throw localSttError(
        'Local transcription is unavailable. Local audio recording can continue without it.'
      );
    } finally {
      clearTimeout(startupTimer);
    }

    return {
      sessionId,
      providerSessionId,
      model: LOCAL_STT_MODEL,
    };
  }

  async appendAudio(request: LocalSttAppendRequest): Promise<LocalSttAppendResult> {
    const session = this.getOwnedSession(request.meetingId, request.sessionId);
    if (!Number.isSafeInteger(request.sequence) || request.sequence !== session.nextSequence) {
      throw localSttError('Local transcription received audio out of order.');
    }
    session.nextSequence += 1;
    if (
      request.pcm.byteLength === 0 ||
      request.pcm.byteLength > MAX_AUDIO_FRAME_BYTES ||
      request.pcm.byteLength % 2 !== 0
    ) {
      throw localSttError('Local transcription received an invalid audio frame.');
    }

    const packet = encodeWorkerMessage(
      {
        type: 'append',
        requestId: session.nextRequestId,
        sequence: request.sequence,
        pcmBytes: request.pcm.byteLength,
      },
      request.pcm
    );
    const message = await this.sendRequest(session, packet);
    if (message.type !== 'accepted' && message.type !== 'result') {
      throw localSttError('Local transcription returned an invalid response.');
    }
    return {
      accepted: true,
      droppedFrames: session.droppedFrames,
      turns: [...this.drainTurns(session), ...parseWorkerTurns(message.turns)],
    };
  }

  async stopSession(request: LocalSttStopRequest): Promise<LocalSttStopResult> {
    const session = this.getSession(request.meetingId, request.sessionId);
    if (session.stopPromise) return session.stopPromise;
    session.stopped = true;
    const packet = encodeWorkerMessage({
      type: 'stop',
      requestId: session.nextRequestId,
      pcmBytes: 0,
    });
    const operation = (async () => {
      try {
        const message = await this.sendRequest(session, packet, this.stopTimeoutMs);
        return {
          turns: [...this.drainTurns(session), ...parseWorkerTurns(message.turns)],
          audioDurationSeconds: finiteNumber(message.audioDurationSeconds),
        };
      } finally {
        this.disposeSession(session, true);
      }
    })();
    session.stopPromise = operation;
    return operation;
  }

  async releaseMeeting(meetingId: string): Promise<void> {
    const owned = [...this.sessions.values()].filter((session) => session.meetingId === meetingId);
    await Promise.allSettled(
      owned.map((session) =>
        this.stopSession({ meetingId: session.meetingId, sessionId: session.sessionId })
      )
    );
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(
      sessions.map((session) =>
        this.stopSession({ meetingId: session.meetingId, sessionId: session.sessionId })
      )
    );
    for (const session of this.sessions.values()) this.disposeSession(session, true);
  }

  private createWorker(extraArgs: string[]): WorkerProcess {
    return this.spawnWorker(
      this.pythonPath,
      [
        this.options.workerPath,
        '--model',
        LOCAL_STT_MODEL,
        '--chunk-seconds',
        '4',
        '--stride-seconds',
        '3',
        '--initial-partial-seconds',
        '1.5',
        '--update-seconds',
        '1',
        ...extraArgs,
      ],
      { env: localWorkerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] }
    );
  }

  private attachWorker(session: WorkerSession): void {
    session.process.stdout.on('data', (chunk: Buffer | string) => {
      session.stdoutBuffer = Buffer.concat([session.stdoutBuffer, Buffer.from(chunk)]);
      if (session.stdoutBuffer.byteLength > MAX_WORKER_JSON_LINE_BYTES) {
        this.failSession(
          session,
          localSttError('Local transcription returned an invalid response.')
        );
        return;
      }
      while (true) {
        const newline = session.stdoutBuffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = session.stdoutBuffer.subarray(0, newline);
        session.stdoutBuffer = session.stdoutBuffer.subarray(newline + 1);
        this.handleWorkerLine(session, line);
      }
    });
    session.process.stderr.on('data', () => undefined);
    session.process.once('error', () => {
      this.failSession(session, localSttError('Local transcription could not start.'));
    });
    session.process.once('exit', () => {
      if (!session.stopped) {
        this.failSession(session, localSttError('Local transcription stopped unexpectedly.'));
      }
    });
  }

  private handleWorkerLine(session: WorkerSession, line: Buffer): void {
    let message: WorkerMessage;
    try {
      const parsed = JSON.parse(line.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      message = parsed as WorkerMessage;
    } catch {
      this.failSession(session, localSttError('Local transcription returned an invalid response.'));
      return;
    }

    if (message.type === 'ready') {
      if (message.model !== LOCAL_STT_MODEL) {
        this.failSession(session, localSttError('Local transcription loaded an unexpected model.'));
        return;
      }
      session.ready = true;
      session.resolveReady();
      return;
    }
    if (message.type === 'error') {
      this.failSession(session, localSttError('Local transcription is unavailable.'));
      return;
    }
    if (message.type === 'turns') {
      session.queuedTurns.push(...parseWorkerTurns(message.turns));
      return;
    }
    if (!Number.isSafeInteger(message.requestId)) return;
    const pending = session.pending.get(message.requestId as number);
    if (!pending) return;
    session.pending.delete(message.requestId as number);
    clearTimeout(pending.timer);
    if (message.type === 'requestError') {
      pending.reject(localSttError('Local transcription could not decode this audio window.'));
      return;
    }
    if (message.type === 'accepted' || message.type === 'result' || message.type === 'stopped') {
      pending.resolve(message);
    }
  }

  private sendRequest(
    session: WorkerSession,
    packet: Buffer,
    timeoutMs = this.requestTimeoutMs
  ): Promise<WorkerMessage> {
    if (!session.ready || session.process.stdin.destroyed) {
      return Promise.reject(localSttError('Local transcription is not running.'));
    }
    const requestId = session.nextRequestId;
    session.nextRequestId += 1;
    return new Promise<WorkerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(requestId);
        const error = localSttError('Local transcription took too long to process audio.');
        reject(error);
        this.failSession(session, error);
      }, timeoutMs);
      session.pending.set(requestId, { resolve, reject, timer });
      const failWrite = () => {
        const pending = session.pending.get(requestId);
        if (!pending) return;
        session.pending.delete(requestId);
        clearTimeout(pending.timer);
        const error = localSttError('Local transcription could not receive audio.');
        pending.reject(error);
        this.failSession(session, error);
      };
      try {
        session.process.stdin.write(packet, (error?: Error | null) => {
          if (error) failWrite();
        });
      } catch {
        failWrite();
      }
    });
  }

  private drainTurns(session: WorkerSession): LocalSttTurn[] {
    if (session.queuedTurns.length === 0) return [];
    return session.queuedTurns.splice(0, session.queuedTurns.length);
  }

  private getOwnedSession(meetingId: string, sessionId: string): WorkerSession {
    const session = this.getSession(meetingId, sessionId);
    if (session.stopped) {
      throw localSttError('Local transcription session is unavailable.');
    }
    return session;
  }

  private getSession(meetingId: string, sessionId: string): WorkerSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.meetingId !== meetingId) {
      throw localSttError('Local transcription session is unavailable.');
    }
    return session;
  }

  private failSession(session: WorkerSession, error: Error): void {
    if (!session.ready) session.rejectReady(error);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
    this.disposeSession(session, true);
  }

  private disposeSession(session: WorkerSession, terminate: boolean): void {
    session.stopped = true;
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
    if (terminate && !session.process.stdin.destroyed) session.process.kill('SIGTERM');
  }

  private async probeSupport(): Promise<LocalSttSupport> {
    let worker: WorkerProcess;
    try {
      worker = this.createWorker(['--probe']);
    } catch {
      return unavailableSupport();
    }
    worker.stderr.on('data', () => undefined);
    return await new Promise<LocalSttSupport>((resolve) => {
      let settled = false;
      let output = Buffer.alloc(0);
      const finish = (support: LocalSttSupport) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(support);
      };
      const timer = setTimeout(() => {
        worker.kill('SIGTERM');
        finish(unavailableSupport());
      }, this.startupTimeoutMs);
      worker.stdout.on('data', (chunk: Buffer | string) => {
        output = Buffer.concat([output, Buffer.from(chunk)]);
        if (output.byteLength > MAX_WORKER_JSON_LINE_BYTES) {
          worker.kill('SIGTERM');
          finish(unavailableSupport());
          return;
        }
        const newline = output.indexOf(0x0a);
        if (newline < 0) return;
        try {
          const message = JSON.parse(output.subarray(0, newline).toString('utf8')) as WorkerMessage;
          finish({
            available: message.type === 'support' && message.available === true,
            model: LOCAL_STT_MODEL,
            ...(message.available === true ? {} : { reason: unavailableSupport().reason }),
          });
        } catch {
          finish(unavailableSupport());
        }
      });
      worker.once('error', () => finish(unavailableSupport()));
      worker.once('exit', () => finish(unavailableSupport()));
    });
  }
}

function validateStartRequest(request: LocalSttStartRequest): void {
  if (!request.meetingId || request.meetingId.length > 128) {
    throw localSttError('Local transcription received an invalid meeting.');
  }
  if (!['microphone', 'system', 'mixed'].includes(request.sourceKind)) {
    throw localSttError('Local transcription received an invalid audio source.');
  }
  if (request.sampleRate !== LOCAL_STT_SAMPLE_RATE) {
    throw localSttError('Local transcription requires 16 kHz mono audio.');
  }
}

function encodeWorkerMessage(header: Record<string, unknown>, pcm?: ArrayBuffer): Buffer {
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(encodedHeader.byteLength);
  return pcm
    ? Buffer.concat([prefix, encodedHeader, Buffer.from(pcm)])
    : Buffer.concat([prefix, encodedHeader]);
}

function parseWorkerTurns(value: unknown): LocalSttTurn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const turn = candidate as Record<string, unknown>;
    if (
      typeof turn.turnId !== 'string' ||
      !Number.isSafeInteger(turn.turnOrder) ||
      !Number.isSafeInteger(turn.revision) ||
      typeof turn.durableFinal !== 'boolean' ||
      typeof turn.utteranceBoundary !== 'boolean' ||
      typeof turn.text !== 'string' ||
      !Array.isArray(turn.words)
    ) {
      return [];
    }
    const words = turn.words.flatMap((candidateWord) => {
      if (!candidateWord || typeof candidateWord !== 'object' || Array.isArray(candidateWord)) {
        return [];
      }
      const word = candidateWord as Record<string, unknown>;
      if (
        typeof word.id !== 'string' ||
        typeof word.text !== 'string' ||
        typeof word.startMs !== 'number' ||
        typeof word.endMs !== 'number'
      ) {
        return [];
      }
      return [
        {
          id: word.id,
          text: word.text,
          startMs: word.startMs,
          endMs: word.endMs,
          confidence: typeof word.confidence === 'number' ? word.confidence : undefined,
          final: word.final === true,
        },
      ];
    });
    return [
      {
        turnId: turn.turnId,
        turnOrder: turn.turnOrder as number,
        revision: turn.revision as number,
        durableFinal: turn.durableFinal,
        utteranceBoundary: turn.utteranceBoundary,
        text: turn.text,
        words,
        startMs: finiteNumber(turn.startMs),
        endMs: finiteNumber(turn.endMs),
      },
    ];
  });
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function localWorkerEnvironment(): Record<string, string | undefined> {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    PYTHONUNBUFFERED: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    TOKENIZERS_PARALLELISM: 'false',
    OMP_NUM_THREADS: '6',
  };
}

function unavailableSupport(): LocalSttSupport {
  return {
    available: false,
    model: LOCAL_STT_MODEL,
    reason: 'Offline transcription is not installed or its local model is unavailable.',
  };
}

function localSttError(message: string): Error {
  return Object.assign(new Error(message), { code: 'local_stt_error', retryable: false });
}
