import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  ChatGptSubscriptionFactCheckClient,
  factCheckWorkerEnvironment,
} from './ChatGptSubscriptionFactCheckClient';

function fakeWorker(responseFor: (request: Record<string, unknown>) => unknown, exitCode = 0) {
  const requests: Record<string, unknown>[] = [];
  const spawnWorker = vi.fn((_command, _args, _options) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: ChildProcessWithoutNullStreams['signalCode'];
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    const chunks: Buffer[] = [];
    child.stdin.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.stdin.on('finish', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push(request);
      child.stdout.end(`${JSON.stringify(responseFor(request))}\n`);
      child.exitCode = exitCode;
      globalThis.queueMicrotask(() => child.emit('close', exitCode, null));
    });
    return child;
  });
  return { spawnWorker, requests };
}

function claimDetectionRequest() {
  return {
    turns: [
      {
        id: 'turn_1',
        speakerId: null,
        startMs: 0,
        endMs: 1_000,
        text: 'Night is light.',
      },
      {
        id: 'turn_2',
        speakerId: null,
        startMs: 1_000,
        endMs: 2_000,
        text: 'This is context.',
      },
      {
        id: 'turn_3',
        speakerId: null,
        startMs: 2_000,
        endMs: 3_000,
        text: 'Day is dark.',
      },
    ],
    requiredTurnIds: ['turn_3'],
    existingClaimKeys: [],
  };
}

function claimDetectionCandidate(overrides: Record<string, unknown> = {}) {
  return {
    exactQuote: 'Day is dark.',
    normalizedClaim: 'Day is dark.',
    segmentIds: ['turn_3'],
    checkworthy: true,
    consequenceScore: 0.5,
    disputeLikelihoodScore: 0.9,
    specificityScore: 0.8,
    timeSensitive: false,
    selectionRationale: 'This is a concrete factual assertion.',
    ...overrides,
  };
}

describe('ChatGptSubscriptionFactCheckClient', () => {
  it('checks cached ChatGPT support through the hidden bounded worker', async () => {
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      support: {
        available: true,
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/Applications/Obelus.app/Contents/Resources/bin/goose',
      spawnWorker: worker.spawnWorker as never,
      environment: { GOOSE_PATH_ROOT: '/private/obelus/backend' },
    });

    await expect(client.checkSupport()).resolves.toEqual({
      available: true,
      provider: 'chatgpt_codex',
      model: 'gpt-5.6-sol',
      reason: undefined,
    });
    expect(worker.spawnWorker).toHaveBeenCalledWith(
      '/Applications/Obelus.app/Contents/Resources/bin/goose',
      ['live-fact-check-model'],
      expect.objectContaining({
        env: { GOOSE_PATH_ROOT: '/private/obelus/backend' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
    expect(worker.requests[0]).toMatchObject({ operation: 'support', protocolVersion: 1 });
  });

  it('detects a claim spanning contiguous transcript turns through the bounded worker', async () => {
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      claimDetection: {
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
        candidates: [
          {
            exactQuote:
              'The difference between night and day is that night is light and day is dark.',
            normalizedClaim: 'Night is light and day is dark.',
            segmentIds: ['turn_1', 'turn_2', 'turn_3'],
            checkworthy: true,
            consequenceScore: 0.5,
            disputeLikelihoodScore: 0.95,
            specificityScore: 0.9,
            timeSensitive: false,
            selectionRationale: 'This is a concrete factual assertion about night and day.',
          },
        ],
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: worker.spawnWorker as never,
    });
    const request = {
      turns: [
        {
          id: 'turn_1',
          speakerId: 'speaker_1',
          startMs: 6_120,
          endMs: 8_000,
          text: 'The difference between night and day',
          sourceKind: 'microphone' as const,
        },
        {
          id: 'turn_2',
          speakerId: 'speaker_1',
          startMs: 8_000,
          endMs: 10_000,
          text: 'is that night is light and',
          sourceKind: 'microphone' as const,
        },
        {
          id: 'turn_3',
          speakerId: 'speaker_1',
          startMs: 10_000,
          endMs: 12_900,
          text: 'and day is dark.',
          sourceKind: 'microphone' as const,
        },
      ],
      requiredTurnIds: ['turn_3'],
      existingClaimKeys: ['existing-claim'],
    };

    await expect(client.detectClaims(request)).resolves.toEqual({
      provider: 'chatgpt_codex',
      model: 'gpt-5.6-sol',
      candidates: [
        expect.objectContaining({
          normalizedClaim: 'Night is light and day is dark.',
          segmentIds: ['turn_1', 'turn_2', 'turn_3'],
          disputeLikelihoodScore: 0.95,
        }),
      ],
    });
    expect(worker.requests[0]).toMatchObject({
      protocolVersion: 1,
      operation: 'detect_claims',
      request,
    });
  });

  it('rejects a detected quote that is not present in its cited transcript turns', async () => {
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      claimDetection: {
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
        candidates: [claimDetectionCandidate({ exactQuote: 'The Moon is made of cheese.' })],
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: worker.spawnWorker as never,
    });

    await expect(client.detectClaims(claimDetectionRequest())).rejects.toMatchObject({
      code: 'invalid_chatgpt_claim_detection_response',
      retryable: true,
    });
  });

  it('rejects noncontiguous or stale transcript references from claim detection', async () => {
    const responses = [
      claimDetectionCandidate({
        exactQuote: 'Night is light. Day is dark.',
        segmentIds: ['turn_1', 'turn_3'],
      }),
      claimDetectionCandidate({
        exactQuote: 'Night is light.',
        segmentIds: ['turn_1'],
      }),
    ];
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      claimDetection: {
        candidates: [responses.shift()],
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: worker.spawnWorker as never,
    });

    await expect(client.detectClaims(claimDetectionRequest())).rejects.toMatchObject({
      code: 'invalid_chatgpt_claim_detection_response',
    });
    await expect(client.detectClaims(claimDetectionRequest())).rejects.toMatchObject({
      code: 'invalid_chatgpt_claim_detection_response',
    });
  });

  it('rejects multi-turn claims across timing gaps or conflicting speakers', async () => {
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      claimDetection: {
        candidates: [
          claimDetectionCandidate({
            exactQuote: 'Night is light. This is context.',
            normalizedClaim: 'Night is light and this is context.',
            segmentIds: ['turn_1', 'turn_2'],
          }),
        ],
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: worker.spawnWorker as never,
    });
    const base = claimDetectionRequest();

    await expect(
      client.detectClaims({
        ...base,
        turns: base.turns.map((turn, index) => ({
          ...turn,
          speakerId: 'speaker_1',
          ...(index === 1 ? { startMs: 4_000, endMs: 5_000 } : {}),
        })),
        requiredTurnIds: ['turn_2'],
      })
    ).rejects.toMatchObject({ code: 'invalid_chatgpt_claim_detection_response' });

    await expect(
      client.detectClaims({
        ...base,
        turns: base.turns.map((turn, index) => ({
          ...turn,
          speakerId: index === 0 ? 'speaker_1' : 'speaker_2',
        })),
        requiredTurnIds: ['turn_2'],
      })
    ).rejects.toMatchObject({ code: 'invalid_chatgpt_claim_detection_response' });
  });

  it('rejects a claim assembled across microphone and system-audio turns', async () => {
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      claimDetection: {
        candidates: [
          claimDetectionCandidate({
            exactQuote: 'Night is light. This is context.',
            normalizedClaim: 'Night is light and this is context.',
            segmentIds: ['turn_1', 'turn_2'],
          }),
        ],
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: worker.spawnWorker as never,
    });
    const base = claimDetectionRequest();

    await expect(
      client.detectClaims({
        ...base,
        turns: base.turns.map((turn, index) => ({
          ...turn,
          sourceKind: index === 0 ? ('microphone' as const) : ('system' as const),
        })),
        requiredTurnIds: ['turn_2'],
      })
    ).rejects.toMatchObject({
      code: 'invalid_chatgpt_claim_detection_response',
      retryable: true,
    });
  });

  it('rejects out-of-range claim detection scores and oversized input before spawning', async () => {
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      claimDetection: {
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
        candidates: [claimDetectionCandidate({ specificityScore: 1.1 })],
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: worker.spawnWorker as never,
    });

    await expect(client.detectClaims(claimDetectionRequest())).rejects.toMatchObject({
      code: 'invalid_chatgpt_claim_detection_response',
    });
    await expect(
      client.detectClaims({
        ...claimDetectionRequest(),
        turns: [
          {
            ...claimDetectionRequest().turns[0],
            text: 'a'.repeat(2 * 1_024 + 1),
          },
        ],
        requiredTurnIds: ['turn_1'],
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      client.detectClaims({
        ...claimDetectionRequest(),
        turns: [
          {
            ...claimDetectionRequest().turns[0],
            sourceKind: 'text' as never,
          },
        ],
        requiredTurnIds: ['turn_1'],
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(worker.spawnWorker).toHaveBeenCalledTimes(1);
  });

  it('rejects candidates below the automatic claim gate score thresholds', async () => {
    const responses = [
      claimDetectionCandidate({ specificityScore: 0.49 }),
      claimDetectionCandidate({
        consequenceScore: 0.44,
        disputeLikelihoodScore: 0.54,
      }),
    ];
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      claimDetection: {
        candidates: [responses.shift()],
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: worker.spawnWorker as never,
    });

    await expect(client.detectClaims(claimDetectionRequest())).rejects.toMatchObject({
      code: 'invalid_chatgpt_claim_detection_response',
    });
    await expect(client.detectClaims(claimDetectionRequest())).rejects.toMatchObject({
      code: 'invalid_chatgpt_claim_detection_response',
    });
  });

  it('does not start claim detection after its meeting signal is cancelled', async () => {
    const spawnWorker = vi.fn();
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: spawnWorker as never,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.detectClaims(claimDetectionRequest(), controller.signal)
    ).rejects.toMatchObject({
      code: 'chatgpt_cancelled',
      retryable: false,
    });
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it('sends the claim through stdin and accepts only inventory-bound citations', async () => {
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      result: {
        verdict: 'Unsupported',
        confidence: 'High',
        conclusion: "NASA's cited measurements show that Earth is larger than the Moon.",
        conclusionCitationIds: ['src_1', 'src_2'],
        supports: [],
        contradictions: [],
        caveats: [],
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: worker.spawnWorker as never,
    });

    await expect(
      client.synthesize({
        stage: 'quick',
        normalizedClaim: 'The Moon is larger than Earth.',
        exactQuote: 'The moon is larger than the earth.',
        evidence: [
          {
            citationId: 'src_1',
            publisher: 'NASA',
            title: 'Moon facts',
            publicationDate: null,
            excerpt: 'The Moon has a diameter of about 3,475 km.',
            retrievalKind: 'page_extract',
          },
          {
            citationId: 'src_2',
            publisher: 'NASA',
            title: 'Earth facts',
            publicationDate: null,
            excerpt: 'Earth has a diameter of about 12,756 km.',
            retrievalKind: 'page_extract',
          },
        ],
      })
    ).resolves.toMatchObject({
      verdict: 'Unsupported',
      confidence: 'High',
      provider: 'chatgpt_codex',
    });
    expect(worker.spawnWorker.mock.calls[0]?.[1]).toEqual(['live-fact-check-model']);
    expect(JSON.stringify(worker.requests[0])).toContain('The Moon is larger than Earth');
  });

  it('rejects a worker citation that is absent from the retrieved inventory', async () => {
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      result: {
        verdict: 'Unsupported',
        confidence: 'High',
        conclusion: 'The claim is unsupported.',
        conclusionCitationIds: ['invented_source'],
        supports: [],
        contradictions: [],
        caveats: [],
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: worker.spawnWorker as never,
    });

    await expect(
      client.synthesize({
        stage: 'quick',
        normalizedClaim: 'The Moon is larger than Earth.',
        exactQuote: 'The Moon is larger than Earth.',
        evidence: [
          {
            citationId: 'src_1',
            publisher: 'NASA',
            title: 'Moon facts',
            publicationDate: null,
            excerpt: 'The Moon is smaller than Earth.',
            retrievalKind: 'page_extract',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'invalid_chatgpt_fact_check_response', retryable: false });
  });

  it('accepts citation-bound evidence sections for a deep result', async () => {
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      result: {
        verdict: 'Unsupported',
        confidence: 'High',
        conclusion: 'Earth is larger than the Moon by diameter.',
        conclusionCitationIds: ['src_1', 'src_2'],
        supports: [{ text: 'Earth is 12,756 km across.', citationIds: ['src_2'] }],
        contradictions: [{ text: 'The Moon is 3,475 km across.', citationIds: ['src_1'] }],
        caveats: [{ text: 'The comparison uses diameter.', citationIds: ['src_1', 'src_2'] }],
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: worker.spawnWorker as never,
    });

    await expect(
      client.synthesize({
        stage: 'deep',
        normalizedClaim: 'The Moon is larger than Earth.',
        exactQuote: 'The Moon is larger than Earth.',
        evidence: [
          {
            citationId: 'src_1',
            publisher: 'NASA',
            title: 'Moon facts',
            publicationDate: null,
            excerpt: 'The Moon is 3,475 km across.',
            retrievalKind: 'page_extract',
          },
          {
            citationId: 'src_2',
            publisher: 'NASA',
            title: 'Earth facts',
            publicationDate: null,
            excerpt: 'Earth is 12,756 km across.',
            retrievalKind: 'page_extract',
          },
        ],
      })
    ).resolves.toMatchObject({
      supports: [{ citationIds: ['src_2'] }],
      contradictions: [{ citationIds: ['src_1'] }],
      caveats: [{ citationIds: ['src_1', 'src_2'] }],
    });
  });

  it('rejects raw inline citation markers in model-authored text', async () => {
    const worker = fakeWorker((request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      result: {
        verdict: 'Unsupported',
        confidence: 'High',
        conclusion: 'Earth is larger than the Moon.【src_1】',
        conclusionCitationIds: ['src_1'],
        supports: [],
        contradictions: [],
        caveats: [],
        provider: 'chatgpt_codex',
        model: 'gpt-5.6-sol',
      },
    }));
    const client = new ChatGptSubscriptionFactCheckClient({
      gooseBinaryPath: '/opt/obelus/goose',
      spawnWorker: worker.spawnWorker as never,
    });

    await expect(
      client.synthesize({
        stage: 'quick',
        normalizedClaim: 'The Moon is larger than Earth.',
        exactQuote: 'The Moon is larger than Earth.',
        evidence: [
          {
            citationId: 'src_1',
            publisher: 'NASA',
            title: 'Moon facts',
            publicationDate: null,
            excerpt: 'The Moon is smaller than Earth.',
            retrievalKind: 'page_extract',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'invalid_chatgpt_fact_check_response' });
  });

  it('passes only the environment needed for the isolated ChatGPT worker', () => {
    expect(
      factCheckWorkerEnvironment({
        HOME: '/Users/test',
        PATH: '/usr/bin',
        GOOSE_PATH_ROOT: '/private/obelus/backend',
        OPENAI_API_KEY: 'must-not-cross',
        ANTHROPIC_API_KEY: 'must-not-cross',
        OBELUS_GATEWAY_DEV_TOKEN: 'must-not-cross',
      })
    ).toEqual({
      GOOSE_TELEMETRY_OFF: 'true',
      RUST_LOG: 'error',
      HOME: '/Users/test',
      PATH: '/usr/bin',
      GOOSE_PATH_ROOT: '/private/obelus/backend',
    });
  });

  it('terminates and then force-kills a worker that ignores its deadline', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        signalCode: ChildProcessWithoutNullStreams['signalCode'];
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => true);
      const client = new ChatGptSubscriptionFactCheckClient({
        gooseBinaryPath: '/opt/obelus/goose',
        spawnWorker: vi.fn(() => child) as never,
      });

      const support = client.checkSupport();
      const rejection = expect(support).rejects.toMatchObject({
        code: 'chatgpt_timeout',
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds live claim detection to its 12-second deadline', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        signalCode: ChildProcessWithoutNullStreams['signalCode'];
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => true);
      const client = new ChatGptSubscriptionFactCheckClient({
        gooseBinaryPath: '/opt/obelus/goose',
        spawnWorker: vi.fn(() => child) as never,
      });

      const detection = client.detectClaims(claimDetectionRequest());
      const rejection = expect(detection).rejects.toMatchObject({
        code: 'chatgpt_timeout',
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(11_999);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates an in-flight synthesis when its meeting is cancelled', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        signalCode: ChildProcessWithoutNullStreams['signalCode'];
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => true);
      const client = new ChatGptSubscriptionFactCheckClient({
        gooseBinaryPath: '/opt/obelus/goose',
        spawnWorker: vi.fn(() => child) as never,
      });
      const controller = new AbortController();
      const synthesis = client.synthesize(
        {
          stage: 'quick',
          normalizedClaim: 'The Moon is larger than Earth.',
          exactQuote: 'The Moon is larger than Earth.',
          evidence: [
            {
              citationId: 'src_1',
              publisher: 'NASA',
              title: 'Moon facts',
              publicationDate: null,
              excerpt: 'The Moon is smaller than Earth.',
              retrievalKind: 'page_extract',
            },
          ],
        },
        controller.signal
      );
      const rejection = expect(synthesis).rejects.toMatchObject({
        code: 'chatgpt_cancelled',
        retryable: false,
      });

      controller.abort();
      await rejection;
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates every active worker when the client is disposed', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        signalCode: ChildProcessWithoutNullStreams['signalCode'];
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => true);
      const client = new ChatGptSubscriptionFactCheckClient({
        gooseBinaryPath: '/opt/obelus/goose',
        spawnWorker: vi.fn(() => child) as never,
      });
      const support = client.checkSupport();
      const rejection = expect(support).rejects.toMatchObject({
        code: 'chatgpt_cancelled',
        retryable: false,
      });

      client.dispose();
      await rejection;
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      await expect(client.checkSupport()).rejects.toMatchObject({ code: 'chatgpt_cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles cancellation that occurs synchronously while spawning the worker', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        signalCode: ChildProcessWithoutNullStreams['signalCode'];
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => true);
      const client = new ChatGptSubscriptionFactCheckClient({
        gooseBinaryPath: '/opt/obelus/goose',
        spawnWorker: vi.fn(() => {
          controller.abort();
          return child;
        }) as never,
      });

      await expect(
        client.synthesize(
          {
            stage: 'quick',
            normalizedClaim: 'The Moon is larger than Earth.',
            exactQuote: 'The Moon is larger than Earth.',
            evidence: [
              {
                citationId: 'src_1',
                publisher: 'NASA',
                title: 'Moon facts',
                publicationDate: null,
                excerpt: 'The Moon is smaller than Earth.',
                retrievalKind: 'page_extract',
              },
            ],
          },
          controller.signal
        )
      ).rejects.toMatchObject({ code: 'chatgpt_cancelled' });

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(() => child.emit('error', new Error('late spawn error'))).not.toThrow();
      expect(
        (
          client as unknown as {
            activeWorkers: Map<unknown, unknown>;
          }
        ).activeWorkers.size
      ).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
