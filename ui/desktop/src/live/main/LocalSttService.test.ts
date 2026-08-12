import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { LocalSttService, resolveLocalSttWorkerPath } from './LocalSttService';

interface FakeWorkerOptions {
  emitReady?: boolean;
  turnOnAppend?: boolean;
  ignoreStop?: boolean;
}

class FakeWorker extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  stopRequests = 0;

  constructor(options: FakeWorkerOptions = {}) {
    super();
    this.stdin.on('data', (packet: Buffer) => this.handlePacket(packet, options));
    if (options.emitReady !== false) {
      globalThis.queueMicrotask(() => this.stdout.write('{"type":"ready","model":"base.en"}\n'));
    }
  }

  kill(): boolean {
    this.killed = true;
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    return true;
  }

  private handlePacket(packet: Buffer, options: FakeWorkerOptions): void {
    const headerBytes = packet.readUInt32BE(0);
    const header = JSON.parse(packet.subarray(4, 4 + headerBytes).toString('utf8')) as {
      type: string;
      requestId: number;
    };
    if (header.type === 'append') {
      const turns = options.turnOnAppend
        ? [
            {
              turnId: 'local-turn-0',
              turnOrder: 0,
              revision: 0,
              durableFinal: true,
              utteranceBoundary: true,
              text: 'Local words.',
              startMs: 100,
              endMs: 800,
              words: [
                {
                  id: 'word-0',
                  text: 'Local words.',
                  startMs: 100,
                  endMs: 800,
                  confidence: 0.91,
                  final: true,
                },
              ],
            },
          ]
        : [];
      this.stdout.write(
        `${JSON.stringify({ type: 'result', requestId: header.requestId, turns })}\n`
      );
      return;
    }
    if (options.ignoreStop) return;
    this.stopRequests += 1;
    this.stdout.write(
      `${JSON.stringify({
        type: 'stopped',
        requestId: header.requestId,
        turns: [],
        audioDurationSeconds: 1.25,
      })}\n`
    );
    globalThis.queueMicrotask(() => this.emit('exit', 0, null));
  }
}

class SlowDecodeWorker extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sequences: number[] = [];
  ingestedBytes = 0;
  killed = false;

  constructor() {
    super();
    this.stdin.on('data', (packet: Buffer) => this.handlePacket(packet));
    globalThis.queueMicrotask(() => this.stdout.write('{"type":"ready","model":"base.en"}\n'));
  }

  kill(): boolean {
    this.killed = true;
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    return true;
  }

  releaseDecode(): void {
    this.stdout.write(
      `${JSON.stringify({
        type: 'turns',
        turns: [
          {
            turnId: 'local-turn-0',
            turnOrder: 0,
            revision: 0,
            durableFinal: true,
            utteranceBoundary: true,
            text: 'Continuous audio survived the slow decode.',
            startMs: 0,
            endMs: 44_900,
            words: [
              {
                id: 'word-continuity',
                text: 'Continuous',
                startMs: 0,
                endMs: 500,
                confidence: 0.9,
                final: true,
              },
            ],
          },
        ],
      })}\n`
    );
  }

  private handlePacket(packet: Buffer): void {
    const headerBytes = packet.readUInt32BE(0);
    const header = JSON.parse(packet.subarray(4, 4 + headerBytes).toString('utf8')) as {
      type: string;
      requestId: number;
      sequence?: number;
      pcmBytes?: number;
    };
    if (header.type === 'append') {
      this.sequences.push(header.sequence ?? -1);
      this.ingestedBytes += header.pcmBytes ?? 0;
      this.stdout.write(
        `${JSON.stringify({
          type: 'accepted',
          requestId: header.requestId,
          sequence: header.sequence,
        })}\n`
      );
      return;
    }
    this.stdout.write(
      `${JSON.stringify({
        type: 'stopped',
        requestId: header.requestId,
        turns: [],
        audioDurationSeconds: this.ingestedBytes / 32_000,
      })}\n`
    );
    globalThis.queueMicrotask(() => this.emit('exit', 0, null));
  }
}

describe('LocalSttService', () => {
  it('resolves deterministic packaged and development worker locations', () => {
    expect(
      resolveLocalSttWorkerPath({
        isPackaged: true,
        appPath: '/app',
        resourcesPath: '/Obelus.app/Contents/Resources',
      })
    ).toBe('/Obelus.app/Contents/Resources/bin/obelus-local-stt-worker.py');
    expect(
      resolveLocalSttWorkerPath({
        isPackaged: false,
        appPath: '/workspace/ui/desktop',
        resourcesPath: '/unused',
      })
    ).toBe('/workspace/ui/desktop/src/bin/obelus-local-stt-worker.py');
  });

  it('starts a meeting-scoped worker, returns committed turns, and flushes stop', async () => {
    const worker = new FakeWorker({ turnOnAppend: true });
    const spawnWorker = vi.fn((_executable: string, _args: string[]) => worker as never);
    const service = new LocalSttService({
      workerPath: '/private/worker.py',
      spawnWorker,
    });
    const started = await service.startSession({
      meetingId: 'meeting-1',
      sourceKind: 'mixed',
      sampleRate: 16_000,
    });
    const appended = await service.appendAudio({
      meetingId: 'meeting-1',
      sessionId: started.sessionId,
      sequence: 0,
      pcm: new ArrayBuffer(3_200),
    });
    const stopped = await service.stopSession({
      meetingId: 'meeting-1',
      sessionId: started.sessionId,
    });

    expect(started).toMatchObject({
      providerSessionId: `local-${started.sessionId}`,
      model: 'base.en',
    });
    expect(appended.turns).toMatchObject([{ text: 'Local words.', startMs: 100, endMs: 800 }]);
    expect(stopped).toEqual({ turns: [], audioDurationSeconds: 1.25 });
    expect(worker.killed).toBe(true);
    expect(spawnWorker.mock.calls[0]?.[1]).toContain('base.en');
  });

  it('rejects cross-meeting access and out-of-order audio', async () => {
    const worker = new FakeWorker();
    const service = new LocalSttService({
      workerPath: '/private/worker.py',
      spawnWorker: () => worker as never,
    });
    const started = await service.startSession({
      meetingId: 'meeting-owner',
      sourceKind: 'microphone',
      sampleRate: 16_000,
    });

    await expect(
      service.appendAudio({
        meetingId: 'meeting-other',
        sessionId: started.sessionId,
        sequence: 0,
        pcm: new ArrayBuffer(3_200),
      })
    ).rejects.toThrow('session is unavailable');
    await expect(
      service.appendAudio({
        meetingId: 'meeting-owner',
        sessionId: started.sessionId,
        sequence: 2,
        pcm: new ArrayBuffer(3_200),
      })
    ).rejects.toThrow('out of order');
    await service.close();
  });

  it('fails closed and terminates a worker that never becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker({ emitReady: false });
      const service = new LocalSttService({
        workerPath: '/private/worker.py',
        startupTimeoutMs: 50,
        spawnWorker: () => worker as never,
      });
      const start = service.startSession({
        meetingId: 'meeting-timeout',
        sourceKind: 'system',
        sampleRate: 16_000,
      });
      const rejection = expect(start).rejects.toThrow('Local transcription is unavailable');
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      expect(worker.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates a worker when flushing the tail times out', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker({ ignoreStop: true });
      const service = new LocalSttService({
        workerPath: '/private/worker.py',
        stopTimeoutMs: 50,
        spawnWorker: () => worker as never,
      });
      const started = await service.startSession({
        meetingId: 'meeting-stop-timeout',
        sourceKind: 'mixed',
        sampleRate: 16_000,
      });
      const stop = service.stopSession({
        meetingId: 'meeting-stop-timeout',
        sessionId: started.sessionId,
      });
      const rejection = expect(stop).rejects.toThrow('took too long');
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      expect(worker.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps accepting continuous PCM while inference is stalled and delivers queued turns after recovery', async () => {
    vi.useFakeTimers();
    try {
      const worker = new SlowDecodeWorker();
      const service = new LocalSttService({
        workerPath: '/private/worker.py',
        requestTimeoutMs: 50,
        spawnWorker: () => worker as never,
      });
      const started = await service.startSession({
        meetingId: 'meeting-slow-decode',
        sourceKind: 'mixed',
        sampleRate: 16_000,
      });

      for (let sequence = 0; sequence < 450; sequence += 1) {
        await expect(
          service.appendAudio({
            meetingId: 'meeting-slow-decode',
            sessionId: started.sessionId,
            sequence,
            pcm: new ArrayBuffer(3_200),
          })
        ).resolves.toMatchObject({ accepted: true, droppedFrames: 0 });
      }
      await vi.advanceTimersByTimeAsync(20_000);

      expect(worker.killed).toBe(false);
      expect(worker.sequences).toEqual(Array.from({ length: 450 }, (_, index) => index));
      expect(worker.ingestedBytes).toBe(450 * 3_200);

      worker.releaseDecode();
      const recovered = await service.appendAudio({
        meetingId: 'meeting-slow-decode',
        sessionId: started.sessionId,
        sequence: 450,
        pcm: new ArrayBuffer(3_200),
      });
      expect(recovered.turns).toMatchObject([
        {
          text: 'Continuous audio survived the slow decode.',
          endMs: 44_900,
        },
      ]);

      await expect(
        service.stopSession({
          meetingId: 'meeting-slow-decode',
          sessionId: started.sessionId,
        })
      ).resolves.toMatchObject({ audioDurationSeconds: 45.1 });
      expect(worker.sequences).toEqual(Array.from({ length: 451 }, (_, index) => index));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one tail flush across concurrent stops and frees the source for restart', async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const service = new LocalSttService({
      workerPath: '/private/worker.py',
      spawnWorker: () => workers.shift() as never,
    });
    const first = await service.startSession({
      meetingId: 'meeting-reconnect',
      sourceKind: 'microphone',
      sampleRate: 16_000,
    });

    const firstStop = service.stopSession({
      meetingId: 'meeting-reconnect',
      sessionId: first.sessionId,
    });
    const secondStop = service.stopSession({
      meetingId: 'meeting-reconnect',
      sessionId: first.sessionId,
    });
    await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([
      { turns: [], audioDurationSeconds: 1.25 },
      { turns: [], audioDurationSeconds: 1.25 },
    ]);
    expect(firstWorker.stopRequests).toBe(1);

    await expect(
      service.startSession({
        meetingId: 'meeting-reconnect',
        sourceKind: 'microphone',
        sampleRate: 16_000,
      })
    ).resolves.toMatchObject({ model: 'base.en' });
    await service.close();
  });

  it('releases source ownership when a worker exits cleanly without a stop request', async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const workers = [firstWorker, secondWorker];
    const service = new LocalSttService({
      workerPath: '/private/worker.py',
      spawnWorker: () => workers.shift() as never,
    });
    await service.startSession({
      meetingId: 'meeting-worker-exit',
      sourceKind: 'mixed',
      sampleRate: 16_000,
    });

    firstWorker.emit('exit', 0, null);

    await expect(
      service.startSession({
        meetingId: 'meeting-worker-exit',
        sourceKind: 'mixed',
        sampleRate: 16_000,
      })
    ).resolves.toMatchObject({ model: 'base.en' });
    expect(firstWorker.killed).toBe(true);
    await service.close();
  });
});
