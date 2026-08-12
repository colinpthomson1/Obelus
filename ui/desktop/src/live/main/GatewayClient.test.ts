import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioAssetWriter } from './AudioAssetWriter';
import { GatewayClient } from './GatewayClient';
import { GatewaySessionProvider } from './GatewaySessionProvider';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function jsonResponse(body: unknown): Response {
  return new globalThis.Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GatewayClient', () => {
  it('uses fixed authenticated operations and normalizes STT and claim responses', async () => {
    const requests: Array<{ url: string; authorization: string | null; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url = String(input);
      requests.push({
        url,
        authorization: new globalThis.Headers(init?.headers).get('Authorization'),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      if (url.endsWith('/v1/stt/session')) {
        return jsonResponse({
          sessionId: 'session_1',
          token: 'single-use-token',
          tokenExpiresAt: '2030-01-01T00:00:00.000Z',
          websocketUrl: 'wss://streaming.assemblyai.com/v3/ws',
          configuration: {
            model: 'universal-3-5-pro',
            sampleRate: 16000,
            encoding: 'pcm_s16le',
            speakerLabels: true,
          },
        });
      }
      return jsonResponse({ candidates: [{ claim: 'A' }], catchingUp: true });
    }) as typeof fetch;
    const sessionProvider = new GatewaySessionProvider({
      mode: 'dev-static',
      devToken: 'local-test-token-with-at-least-32-characters',
      isPackaged: false,
      isProduction: false,
    });
    const client = new GatewayClient({
      baseUrl: 'http://127.0.0.1:8787',
      sessionProvider,
      fetchImpl,
      resolveAudioAsset: async () => {
        throw new Error('not used');
      },
    });

    await expect(client.checkHealth()).resolves.toEqual({ available: true });
    const session = await client.getSttSession({
      meetingId: 'meeting_1',
      idempotencyKey: 'stt-session-1',
      strategy: 'mixed_diarized',
      sourceKind: 'mixed',
    });
    expect(session).toMatchObject({
      sessionId: 'session_1',
      model: 'universal-3-5-pro',
    });
    const claims = await client.submitClaimDetection({
      meetingId: 'meeting_1',
      idempotencyKey: 'claim-request-1',
      turns: [
        {
          id: 'turn_1',
          speakerId: null,
          startMs: 0,
          endMs: 100,
          text: 'A',
          sourceKind: 'microphone',
        },
      ],
      contextTurns: [
        { id: 'context_1', speakerId: null, startMs: 0, endMs: 100, text: 'Private context' },
      ],
      requiredTurnIds: ['context_1'],
    });
    expect(claims).toEqual({ candidates: [{ claim: 'A' }], catchingUp: true });
    expect(requests.find((request) => request.url.endsWith('/v1/claims/detect'))?.body).toEqual({
      meetingId: 'meeting_1',
      idempotencyKey: 'claim-request-1',
      turns: [
        {
          id: 'turn_1',
          speakerId: null,
          startMs: 0,
          endMs: 100,
          text: 'A',
          sourceKind: 'microphone',
        },
      ],
      contextTurns: [
        {
          id: 'context_1',
          speakerId: null,
          startMs: 0,
          endMs: 100,
          text: 'Private context',
        },
      ],
      requiredTurnIds: ['context_1'],
    });
    expect(requests[0].authorization).toBeNull();
    expect(
      requests
        .slice(1)
        .every(
          (request) =>
            request.authorization === 'Bearer local-test-token-with-at-least-32-characters'
        )
    ).toBe(true);
  });

  it('submits, polls, and escalates one tolerant V2 fact-check envelope', async () => {
    const requests: Array<{
      url: string;
      method?: string;
      idempotencyKey: string | null;
      body?: unknown;
    }> = [];
    let getCount = 0;
    const assessment = {
      stage: 'preliminary',
      finding: 'needs_context',
      confidence: 'medium',
      conclusion: 'The available source supports only part of the claim.',
      conclusionCitationKeys: ['S1'],
      support: [{ text: 'One part is documented.', citationKeys: ['S1'] }],
    };
    const envelope = (patch: Record<string, unknown>) => ({
      checkId: 'check_1',
      status: 'pending',
      stage: 'quick',
      policyVersion: 'policy-v1',
      contractVersion: '2',
      escalation: {
        recommended: true,
        requested: false,
        reasons: ['High consequence'],
        unresolvedSubquestions: ['What was the final total?'],
      },
      evidence: [
        {
          citationKey: 'S1',
          url: 'https://example.org/report',
          canonicalUrl: 'https://example.org/report',
          publisher: 'Example Institute',
          title: 'Annual report',
          accessedAt: '2030-01-01T00:00:00.000Z',
          excerpt: 'A bounded excerpt.',
        },
      ],
      ...patch,
    });
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url = String(input);
      requests.push({
        url,
        method: init?.method,
        idempotencyKey: new globalThis.Headers(init?.headers).get('Idempotency-Key'),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      if (url.endsWith('/escalate')) {
        return jsonResponse(
          envelope({
            status: 'deep_pending',
            stage: 'deep',
            preliminaryAssessment: assessment,
            escalation: {
              recommended: true,
              requested: true,
              reasons: ['High consequence'],
              unresolvedSubquestions: ['What was the final total?'],
            },
          })
        );
      }
      if (init?.method === 'GET') {
        getCount += 1;
        return getCount === 1
          ? jsonResponse(envelope({ status: 'preliminary', preliminaryAssessment: assessment }))
          : jsonResponse(
              envelope({
                status: 'complete',
                stage: 'deep',
                deepAssessment: { ...assessment, stage: 'deep', finding: 'disputed' },
              })
            );
      }
      return jsonResponse(envelope({ status: 'pending' }));
    }) as typeof fetch;
    const client = new GatewayClient({
      baseUrl: 'http://127.0.0.1:8787',
      sessionProvider: new GatewaySessionProvider({
        mode: 'dev-static',
        devToken: 'local-test-token-with-at-least-32-characters',
        isPackaged: false,
        isProduction: false,
      }),
      fetchImpl,
      resolveAudioAsset: async () => {
        throw new Error('not used');
      },
    });
    const request = {
      meetingId: 'meeting_1',
      claimId: 'claim_1',
      claimVersionId: 'version_1',
      idempotencyKey: 'fact-check-request-1',
      exactQuote: 'A claim',
      normalizedClaim: 'A claim',
      contextTurns: [{ id: 'turn_1', speakerId: null, startMs: 0, endMs: 100, text: 'A claim' }],
      requiredTurnIds: ['turn_1'],
      origin: 'manual' as const,
      timeSensitive: true,
      consequenceScore: 0.9,
      autoEscalate: false,
    };

    await expect(client.submitFactCheck('quick', request)).resolves.toMatchObject({
      jobId: 'check_1',
      status: 'pending',
      backend: 'hosted',
    });
    await expect(client.pollFactCheck('check_1', 'quick')).resolves.toMatchObject({
      jobId: 'check_1',
      status: 'complete',
      result: {
        stage: 'preliminary',
        verdict: 'needs_context',
        conclusionCitationIds: ['S1'],
        inventory: [expect.objectContaining({ citationKey: 'S1' })],
        escalationRecommended: true,
      },
    });
    await expect(
      client.escalateFactCheck('check_1', 'deep-request-1', 'policy', ['What was the final total?'])
    ).resolves.toMatchObject({ jobId: 'check_1', status: 'pending', remoteStage: 'deep' });
    await expect(client.pollFactCheck('check_1', 'deep')).resolves.toMatchObject({
      jobId: 'check_1',
      status: 'complete',
      result: { stage: 'deep', verdict: 'disputed' },
    });

    expect(requests[0]).toMatchObject({
      url: 'http://127.0.0.1:8787/v2/fact-checks',
      method: 'POST',
      body: request,
    });
    expect(requests[2]).toMatchObject({
      url: 'http://127.0.0.1:8787/v2/fact-checks/check_1/escalate',
      idempotencyKey: 'deep-request-1',
      body: { reason: 'policy', unresolvedSubquestions: ['What was the final total?'] },
    });
  });

  it('keeps legacy job envelopes readable during the V2 migration', async () => {
    const client = new GatewayClient({
      baseUrl: 'http://127.0.0.1:8787',
      sessionProvider: new GatewaySessionProvider({
        mode: 'dev-static',
        devToken: 'local-test-token-with-at-least-32-characters',
        isPackaged: false,
        isProduction: false,
      }),
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          jobId: 'legacy_job_1',
          status: 'complete',
          result: { stage: 'preliminary', verdict: 'Mixed' },
          usage: [],
        })
      ) as typeof fetch,
      resolveAudioAsset: async () => {
        throw new Error('not used');
      },
    });

    await expect(
      client.submitFactCheck('quick', {
        meetingId: 'meeting_1',
        claimId: 'claim_1',
        claimVersionId: 'version_1',
        idempotencyKey: 'fact-check-request-1',
        exactQuote: 'A claim',
        normalizedClaim: 'A claim',
        contextTurns: [],
        origin: 'manual',
      })
    ).resolves.toMatchObject({
      jobId: 'legacy_job_1',
      status: 'complete',
      backend: 'hosted',
      result: { verdict: 'Mixed' },
    });
  });

  it('returns research unavailability as an operational failure without a finding', async () => {
    const client = new GatewayClient({
      baseUrl: 'http://127.0.0.1:8787',
      sessionProvider: new GatewaySessionProvider({
        mode: 'dev-static',
        devToken: 'local-test-token-with-at-least-32-characters',
        isPackaged: false,
        isProduction: false,
      }),
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          checkId: 'check_1',
          status: 'research_unavailable',
          stage: 'preliminary_research',
          preliminaryAssessment: null,
          deepAssessment: null,
          canonicalAssessment: null,
          escalation: {
            recommended: false,
            requested: false,
            reasons: [],
            unresolvedSubquestions: [],
          },
          evidence: [],
          provenance: [],
          usage: [],
          error: null,
        })
      ) as typeof fetch,
      resolveAudioAsset: async () => {
        throw new Error('not used');
      },
    });

    await expect(client.pollFactCheck('check_1')).resolves.toMatchObject({
      jobId: 'check_1',
      status: 'failed',
      result: undefined,
      error: { code: 'research_unavailable', retryable: false },
    });
  });

  it('does not accept insecure remote gateway URLs', () => {
    const client = new GatewayClient({
      baseUrl: 'http://example.com',
      sessionProvider: new GatewaySessionProvider({
        mode: 'jwt',
        isPackaged: true,
        isProduction: true,
      }),
      resolveAudioAsset: async () => {
        throw new Error('not used');
      },
    });
    expect(client.getAvailability()).toEqual({
      available: false,
      reason: 'The Obelus research gateway is not configured.',
    });
  });

  it('preserves typed gateway error semantics for renderer retry policy', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new globalThis.Response(
          JSON.stringify({
            error: {
              code: 'spend_limit_reached',
              message: 'The meeting research allowance has been reached.',
              retryable: false,
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        )
    ) as typeof fetch;
    const client = new GatewayClient({
      baseUrl: 'http://127.0.0.1:8787',
      sessionProvider: new GatewaySessionProvider({
        mode: 'dev-static',
        devToken: 'local-test-token-with-at-least-32-characters',
        isPackaged: false,
        isProduction: false,
      }),
      fetchImpl,
      resolveAudioAsset: async () => {
        throw new Error('not used');
      },
    });

    await expect(
      client.submitClaimDetection({
        meetingId: 'meeting_1',
        idempotencyKey: 'claim-request-1',
        turns: [{ id: 'turn_1', speakerId: null, startMs: 0, endMs: 100, text: 'A' }],
      })
    ).rejects.toMatchObject({
      code: 'spend_limit_reached',
      message: 'The meeting research allowance has been reached.',
      retryable: false,
    });
  });

  it('preserves a terminal provider-retention limitation from meeting deletion', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        meetingId: 'meeting_1',
        cleanupJobId: 'cleanup_1',
        gateway_state: 'complete',
        provider_state: 'partial',
        limitation: 'One provider upload follows the provider retention policy.',
      })
    ) as typeof fetch;
    const client = new GatewayClient({
      baseUrl: 'http://127.0.0.1:8787',
      sessionProvider: new GatewaySessionProvider({
        mode: 'dev-static',
        devToken: 'local-test-token-with-at-least-32-characters',
        isPackaged: false,
        isProduction: false,
      }),
      fetchImpl,
      resolveAudioAsset: async () => {
        throw new Error('not used');
      },
    });

    await expect(client.deleteRemoteMeeting('meeting_1')).resolves.toEqual({
      meetingId: 'meeting_1',
      cleanupJobId: 'cleanup_1',
      alreadyDeleted: false,
      gatewayCleanup: 'complete',
      providerCleanup: 'partial',
      status: 'partial',
      limitation: 'One provider upload follows the provider retention policy.',
    });
  });

  it('rejects renderer-shifted refinement timing before reading or uploading audio', async () => {
    const checksum = 'a'.repeat(64);
    const assetId = 'asset_1';
    const timelineStartMs = 1_000;
    const timelineEndMs = 1_080;
    const manifestChecksum = createHash('sha256')
      .update(`${assetId}:${checksum}:${timelineStartMs}:${timelineEndMs}`)
      .digest('hex');
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new GatewayClient({
      baseUrl: 'http://127.0.0.1:8787',
      sessionProvider: new GatewaySessionProvider({
        mode: 'dev-static',
        devToken: 'local-test-token-with-at-least-32-characters',
        isPackaged: false,
        isProduction: false,
      }),
      fetchImpl,
      resolveAudioAsset: async () => ({
        absolutePath: '/controlled/mixed.wav',
        filename: 'mixed.wav',
        size: 2_604,
        assetId,
        meetingId: 'meeting_1',
        sourceKind: 'mixed',
        checksumSha256: checksum,
        timelineStartMs: 0,
        timelineEndMs: 80,
      }),
    });

    await expect(
      client.submitRefinement({
        meetingId: 'meeting_1',
        idempotencyKey: 'refinement-request-1',
        sourceTranscriptVersionId: 'transcript_1',
        manifestChecksum,
        contentType: 'audio/wav',
        parts: [
          {
            assetId,
            sourceKind: 'mixed',
            checksumSha256: checksum,
            timelineStartMs,
            timelineEndMs,
            providerInputStartMs: timelineStartMs,
            providerInputEndMs: timelineEndMs,
          },
        ],
      })
    ).rejects.toThrow('controlled audio metadata');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('streams controlled refinement metadata before aligned WAV bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'obelus-gateway-audio-'));
    temporaryDirectories.push(root);
    const writer = new AudioAssetWriter(root);
    await writer.initialize();
    await writer.startMeeting('meeting_1', ['mixed']);
    await writer.appendFrame({
      meetingId: 'meeting_1',
      captureSessionId: 'capture_1',
      sequence: 0,
      meetingTimeMs: 0,
      durationMs: 80,
      sampleRate: 16000,
      channels: 1,
      pcm: { mixed: new Int16Array(1_280).fill(3).buffer },
      meters: { mixed: { rms: 0.1, peak: 0.2 } },
      workletDroppedFrames: 0,
    });
    const [asset] = await writer.finalizeMeeting('meeting_1');
    const manifestChecksum = createHash('sha256')
      .update(
        `${asset.assetId}:${asset.checksumSha256}:${asset.timelineStartMs}:${asset.timelineEndMs}`
      )
      .digest('hex');
    let multipartBody = '';
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [, init] = args;
      const chunks: Buffer[] = [];
      for await (const chunk of init?.body as unknown as Readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      multipartBody = Buffer.concat(chunks).toString('latin1');
      return jsonResponse({ jobId: 'refinement_job_1', status: 'pending', result: null });
    }) as typeof fetch;
    const client = new GatewayClient({
      baseUrl: 'http://127.0.0.1:8787',
      sessionProvider: new GatewaySessionProvider({
        mode: 'dev-static',
        devToken: 'local-test-token-with-at-least-32-characters',
        isPackaged: false,
        isProduction: false,
      }),
      fetchImpl,
      resolveAudioAsset: (meetingId, assetId, sourceKind) =>
        writer.resolveFinalizedAsset(meetingId, assetId, sourceKind),
    });

    await expect(
      client.submitRefinement({
        meetingId: 'meeting_1',
        idempotencyKey: 'refinement-request-1',
        sourceTranscriptVersionId: 'transcript_1',
        manifestChecksum,
        contentType: 'audio/wav',
        parts: [
          {
            assetId: asset.assetId,
            sourceKind: 'mixed',
            checksumSha256: asset.checksumSha256,
            timelineStartMs: asset.timelineStartMs,
            timelineEndMs: asset.timelineEndMs,
            providerInputStartMs: asset.timelineStartMs,
            providerInputEndMs: asset.timelineEndMs,
          },
        ],
      })
    ).resolves.toMatchObject({ jobId: 'refinement_job_1', status: 'pending' });
    expect(multipartBody.indexOf('name="metadata"')).toBeGreaterThanOrEqual(0);
    expect(multipartBody.indexOf('name="metadata"')).toBeLessThan(
      multipartBody.indexOf('name="audio"')
    );
    expect(multipartBody).toContain(`"checksum":"${asset.checksumSha256}"`);
    expect(multipartBody).toMatch(/"audioChecksum":"[a-f0-9]{64}"/);
  });
});
