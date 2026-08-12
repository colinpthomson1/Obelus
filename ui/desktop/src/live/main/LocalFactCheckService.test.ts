import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaimDetectionRequest,
  FactCheckSubmitRequest,
  GatewayJobResponse,
} from '../ipcTypes';
import type { LocalFactCheckAssessmentResult } from '../localFactCheckProtocol';
import {
  CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
  LOCAL_FACT_CHECK_MODEL,
} from '../localFactCheckProtocol';
import type {
  ChatGptClaimDetectionModelClient,
  ChatGptFactCheckModelClient,
} from './ChatGptSubscriptionFactCheckClient';
import { LocalFactCheckService, wikipediaQueriesForClaim } from './LocalFactCheckService';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function fetchInputUrl(input: FetchInput): URL {
  return new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
}

const request: FactCheckSubmitRequest = {
  meetingId: 'meeting-local-research-1',
  claimId: 'claim-1',
  claimVersionId: 'claim-version-1',
  idempotencyKey: 'claim-version-1:quick:1',
  exactQuote: 'Barnes and Noble is a bigger company than Amazon.',
  normalizedClaim: 'Barnes and Noble is a bigger company than Amazon.',
  contextTurns: [
    {
      id: 'turn-1',
      speakerId: null,
      startMs: 0,
      endMs: 2_000,
      text: 'Private adjacent transcript content must not appear in logs.',
    },
  ],
  origin: 'automatic',
};

const validDraft = {
  verdict: 'Unverifiable' as const,
  confidence: 'Low' as const,
  conclusion:
    'The comparison is underspecified because “bigger” does not name a company-size metric or comparison date.',
  conclusionCitationIds: ['src_1', 'src_2', 'src_3', 'src_4'],
};

const emptyModelSections = {
  supports: [],
  contradictions: [],
  caveats: [],
};

const detectNoClaims: ChatGptClaimDetectionModelClient['detectClaims'] = async () => ({
  candidates: [],
  provider: 'chatgpt_codex',
  model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function wikipediaResponse(kind: 'amazon' | 'barnes') {
  return {
    query: {
      pages: [
        kind === 'amazon'
          ? {
              pageid: 90451,
              title: 'Amazon (company)',
              extract:
                'Amazon is an American multinational technology company and the world’s biggest online retailer.',
              pageprops: { wikibase_item: 'Q3884' },
            }
          : {
              pageid: 191875,
              title: 'Barnes & Noble',
              extract:
                'Barnes & Noble operates more than 600 retail stores and is the largest United States bookstore chain.',
              pageprops: { wikibase_item: 'Q795454' },
            },
        {
          pageid: kind === 'amazon' ? 90002 : 190002,
          title: `${kind} secondary result`,
          extract: 'A lower-ranked search result that must not displace either compared entity.',
          pageprops: { wikibase_item: kind === 'amazon' ? 'Q90002' : 'Q190002' },
        },
        {
          pageid: kind === 'amazon' ? 90003 : 190003,
          title: `${kind} third result`,
          extract: 'Another lower-ranked search result.',
          pageprops: { wikibase_item: kind === 'amazon' ? 'Q90003' : 'Q190003' },
        },
      ],
    },
  };
}

function quantity(amount: string, unit: string, year?: number, rank = 'normal') {
  return {
    rank,
    mainsnak: { datavalue: { type: 'quantity', value: { amount, unit } } },
    qualifiers: year
      ? { P585: [{ datavalue: { value: { time: `+${year}-00-00T00:00:00Z` } } }] }
      : undefined,
  };
}

function wikidataEntitiesResponse() {
  const usd = 'http://www.wikidata.org/entity/Q4917';
  return {
    entities: {
      Q3884: {
        labels: { en: { value: 'Amazon' } },
        claims: {
          P1128: [quantity('+1500000', '1', 2023, 'preferred')],
          P2139: [quantity('+716924000000', usd, 2025, 'preferred')],
        },
      },
      Q795454: {
        labels: { en: { value: 'Barnes & Noble' } },
        claims: {
          P1128: [quantity('+26000', '1', 2017)],
          P2139: [quantity('+5200000000', usd)],
        },
      },
    },
  };
}

function completeFetch(draft: unknown = validDraft): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: FetchInput, init?: FetchInit) => {
    const url = fetchInputUrl(input);
    expect(init?.redirect).toBe('error');
    if (url.origin === 'http://127.0.0.1:11434' && url.pathname === '/api/tags') {
      return json({ models: [{ name: LOCAL_FACT_CHECK_MODEL }] });
    }
    if (url.origin === 'http://127.0.0.1:11434' && url.pathname === '/api/chat') {
      return json({ done: true, message: { content: JSON.stringify(draft) } });
    }
    if (url.origin === 'https://en.wikipedia.org') {
      const query = url.searchParams.get('gsrsearch') ?? '';
      return json(wikipediaResponse(query.includes('Barnes') ? 'barnes' : 'amazon'));
    }
    if (url.searchParams.get('action') === 'wbgetentities') {
      return json(wikidataEntitiesResponse());
    }
    if (url.origin === 'https://www.wikidata.org') return json({ search: [] });
    throw new Error(`Unexpected URL ${url.origin}${url.pathname}`);
  });
}

function sequencedDraftFetch(drafts: readonly unknown[]): ReturnType<typeof vi.fn> {
  const providerFetch = completeFetch();
  let synthesisIndex = 0;
  return vi.fn(async (input: FetchInput, init?: FetchInit) => {
    const url = fetchInputUrl(input);
    if (url.pathname === '/api/chat') {
      const body = JSON.parse(String(init?.body)) as { messages?: unknown[] };
      if ((body.messages?.length ?? 0) > 0) {
        const draft = drafts[Math.min(synthesisIndex, drafts.length - 1)];
        synthesisIndex += 1;
        return json({ done: true, message: { content: JSON.stringify(draft) } });
      }
    }
    return (providerFetch as unknown as typeof fetch)(input, init);
  });
}

function synthesisBodies(fetchImpl: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchImpl.mock.calls.flatMap(([input, init]) => {
    if (fetchInputUrl(input).pathname !== '/api/chat') return [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Array.isArray(body.messages) && body.messages.length > 0 ? [body] : [];
  });
}

async function service(fetchImpl = completeFetch()) {
  const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-local-fact-check-'));
  return {
    storeDirectory,
    fetchImpl,
    instance: new LocalFactCheckService({
      mode: 'local_wikimedia',
      storeDirectory,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      wikimediaTimeoutMs: 1_000,
      ollamaTimeoutMs: 1_000,
      now: () => Date.parse('2026-08-10T20:00:00.000Z'),
    }),
  };
}

async function terminalJob(
  instance: LocalFactCheckService,
  meetingId: string,
  initial: GatewayJobResponse<LocalFactCheckAssessmentResult>
): Promise<GatewayJobResponse<LocalFactCheckAssessmentResult>> {
  let current = initial;
  for (
    let attempt = 0;
    attempt < 100 && ['pending', 'running', 'retry_wait'].includes(current.status);
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    current = await instance.pollFactCheck(meetingId, current.jobId);
  }
  return current;
}

describe('LocalFactCheckService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('derives an anchored automatic candidate from split microphone transcript turns', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-subscription-detection-'));
    const detectClaims = vi.fn(async () => ({
      candidates: [
        {
          exactQuote:
            'The difference between night and day is that night is light and day is dark.',
          normalizedClaim: 'The Moon is larger than Earth and was never spoken.',
          segmentIds: ['turn_1', 'turn_2', 'turn_3'],
          checkworthy: true,
          consequenceScore: 0.5,
          disputeLikelihoodScore: 0.8,
          specificityScore: 0.9,
          timeSensitive: false,
          selectionRationale: 'This is a concrete factual assertion that can be checked.',
        },
      ],
      provider: 'chatgpt_codex' as const,
      model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
    }));
    const instance = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      modelClient: {
        detectClaims,
        checkSupport: async () => ({
          available: true,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
        synthesize: async () => ({
          ...validDraft,
          ...emptyModelSections,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
      },
    });
    const turns = [
      {
        id: 'turn_1',
        speakerId: 'speaker_1',
        startMs: 6_120,
        endMs: 8_300,
        text: 'The difference between night and day',
        sourceKind: 'microphone' as const,
      },
      {
        id: 'turn_2',
        speakerId: 'speaker_1',
        startMs: 8_200,
        endMs: 10_500,
        text: 'is that night is light and',
        sourceKind: 'microphone' as const,
      },
      {
        id: 'turn_3',
        speakerId: 'speaker_1',
        startMs: 10_400,
        endMs: 12_900,
        text: 'and day is dark.',
        sourceKind: 'microphone' as const,
      },
    ];

    const result = await instance.detectClaims({
      meetingId: 'meeting_1',
      idempotencyKey: 'claim-detection-night-day-1',
      turns: [turns[2]!],
      contextTurns: turns,
      requiredTurnIds: ['turn_3'],
      existingClaimKeys: [],
    });

    expect(detectClaims).toHaveBeenCalledWith(
      { turns, requiredTurnIds: ['turn_3'], existingClaimKeys: [] },
      expect.any(globalThis.AbortSignal)
    );
    expect(result).toEqual({
      candidates: [
        expect.objectContaining({
          exactQuote:
            'The difference between night and day is that night is light and day is dark.',
          normalizedClaim:
            'The difference between night and day is that night is light and day is dark.',
          contextTurnIds: ['turn_1', 'turn_2', 'turn_3'],
          speakerId: 'speaker_1',
          startMs: 6_120,
          endMs: 12_900,
          checkworthy: true,
          semanticDuplicateKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ],
      catchingUp: false,
    });
  });

  it('does not send transcript text when a meeting is deleted during the support check', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-detection-delete-race-'));
    let resolveSupport!: () => void;
    const supportCanFinish = new Promise<void>((resolve) => {
      resolveSupport = resolve;
    });
    let signalSupportStarted!: () => void;
    const supportStarted = new Promise<void>((resolve) => {
      signalSupportStarted = resolve;
    });
    const detectClaims = vi.fn(detectNoClaims);
    const instance = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      modelClient: {
        detectClaims,
        checkSupport: async () => {
          signalSupportStarted();
          await supportCanFinish;
          return {
            available: true,
            provider: 'chatgpt_codex' as const,
            model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
          };
        },
        synthesize: async () => ({
          ...validDraft,
          ...emptyModelSections,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
      },
    });
    const detectionRequest: ClaimDetectionRequest = {
      meetingId: 'meeting-delete-during-support',
      idempotencyKey: 'claim-detection-delete-race',
      turns: [
        {
          id: 'turn-delete-race',
          speakerId: null,
          startMs: 0,
          endMs: 1_000,
          text: 'This transcript must not be sent after deletion.',
        },
      ],
      requiredTurnIds: ['turn-delete-race'],
      existingClaimKeys: [],
    };

    const detection = instance.detectClaims(detectionRequest);
    await supportStarted;
    await instance.releaseMeeting(detectionRequest.meetingId);
    resolveSupport();

    await expect(detection).rejects.toMatchObject({
      code: 'local_research_interrupted',
      retryable: true,
    });
    expect(detectClaims).not.toHaveBeenCalled();
  });

  it('reuses a validated automatic detection result for the same idempotency key', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-detection-idempotency-'));
    const detectClaims = vi.fn(async () => ({
      candidates: [
        {
          exactQuote: 'The Moon is larger than Earth.',
          normalizedClaim: 'The Moon is larger than Earth.',
          segmentIds: ['turn-moon'],
          checkworthy: true,
          consequenceScore: 0.4,
          disputeLikelihoodScore: 0.9,
          specificityScore: 0.9,
          timeSensitive: false,
          selectionRationale: 'A concrete physical comparison can be checked.',
        },
      ],
      provider: 'chatgpt_codex' as const,
      model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
    }));
    const instance = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      modelClient: {
        detectClaims,
        checkSupport: async () => ({
          available: true,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
        synthesize: async () => ({
          ...validDraft,
          ...emptyModelSections,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
      },
    });
    const detectionRequest: ClaimDetectionRequest = {
      meetingId: 'meeting-idempotent-detection',
      idempotencyKey: 'claim-detection-idempotent-1',
      turns: [
        {
          id: 'turn-moon',
          speakerId: 'speaker-1',
          startMs: 0,
          endMs: 1_500,
          text: 'The Moon is larger than Earth.',
          sourceKind: 'microphone',
        },
      ],
      requiredTurnIds: ['turn-moon'],
      existingClaimKeys: [],
    };

    const first = await instance.detectClaims(detectionRequest);
    const replay = await instance.detectClaims({
      ...detectionRequest,
      existingClaimKeys: ['claim-created-after-first-detection'],
    });

    expect(replay).toEqual(first);
    expect(detectClaims).toHaveBeenCalledOnce();
  });

  it('does not let recovered detection work block a different active meeting', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-detection-priority-'));
    let releaseRecovered!: () => void;
    const recoveredPending = new Promise<void>((resolve) => {
      releaseRecovered = resolve;
    });
    const detectClaims = vi.fn(
      async (modelRequest: Parameters<ChatGptClaimDetectionModelClient['detectClaims']>[0]) => {
        if (modelRequest.turns[0]?.text === 'Recovered meeting assertion.') {
          await recoveredPending;
        }
        return {
          candidates: [],
          provider: 'chatgpt_codex' as const,
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        };
      }
    );
    const instance = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      modelClient: {
        detectClaims,
        checkSupport: async () => ({
          available: true,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
        synthesize: async () => ({
          ...validDraft,
          ...emptyModelSections,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
      },
    });
    const detectionRequest = (meetingId: string, text: string) => ({
      meetingId,
      idempotencyKey: `claim-detection-${meetingId}`,
      turns: [{ id: `turn-${meetingId}`, speakerId: null, startMs: 0, endMs: 1_000, text }],
      requiredTurnIds: [`turn-${meetingId}`],
      existingClaimKeys: [],
    });

    const recovered = instance.detectClaims(
      detectionRequest('meeting-recovered', 'Recovered meeting assertion.')
    );
    await vi.waitFor(() => expect(detectClaims).toHaveBeenCalledOnce());
    await expect(
      instance.detectClaims(detectionRequest('meeting-active', 'Active meeting assertion.'), true)
    ).resolves.toMatchObject({ candidates: [] });
    expect(detectClaims).toHaveBeenCalledTimes(2);
    const secondRecovered = instance.detectClaims(
      detectionRequest('meeting-recovered-2', 'Second recovered assertion.')
    );
    await Promise.resolve();
    expect(detectClaims).toHaveBeenCalledTimes(2);

    releaseRecovered();
    await expect(recovered).resolves.toMatchObject({ candidates: [] });
    await expect(secondRecovered).resolves.toMatchObject({ candidates: [] });
    expect(detectClaims).toHaveBeenCalledTimes(3);
  });

  it('checks the Barnes & Noble comparison with cited, explicitly limited secondary evidence', async () => {
    const { instance, fetchImpl } = await service();
    const submitted = await instance.submitFactCheck('quick', request);
    expect(submitted.status).toBe('pending');

    const completed = await terminalJob(instance, request.meetingId, submitted);

    expect(completed.status).toBe('complete');
    expect(completed.result).toMatchObject({
      stage: 'preliminary',
      verdict: 'Unverifiable',
      confidence: 'Low',
      provenance: { provider: 'ollama', model: LOCAL_FACT_CHECK_MODEL, local: true },
    });
    expect(completed.result?.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ publisher: 'English Wikipedia', title: 'Amazon (company)' }),
        expect.objectContaining({ publisher: 'English Wikipedia', title: 'Barnes & Noble' }),
        expect.objectContaining({
          publisher: 'Wikidata',
          title: 'Amazon — structured company-size fields',
          excerpt: expect.stringContaining('employees 1,500,000 (2023'),
        }),
        expect.objectContaining({
          publisher: 'Wikidata',
          title: 'Barnes & Noble — structured company-size fields',
          excerpt: expect.stringContaining('date not supplied'),
        }),
      ])
    );
    expect(completed.result?.limitations[0]).toMatchObject({
      text: expect.stringContaining('did not search the wider web or primary-source databases'),
    });
    expect(completed.result?.sources.every((source) => source.qualityScore <= 0.5)).toBe(true);
    expect(
      completed.result?.statements.every(
        (statement) =>
          statement.citationIds.length > 0 &&
          statement.citationIds.every((id) =>
            completed.result?.inventory.some((source) => source.citationId === id)
          )
      )
    ).toBe(true);
    expect(
      fetchImpl.mock.calls.every(([input]) => {
        const url = fetchInputUrl(input);
        return [
          'http://127.0.0.1:11434',
          'https://en.wikipedia.org',
          'https://www.wikidata.org',
        ].includes(url.origin);
      })
    ).toBe(true);
    expect(
      fetchImpl.mock.calls
        .map(([input]) => fetchInputUrl(input))
        .filter((url) => url.origin === 'https://en.wikipedia.org')
        .map((url) => url.searchParams.get('gsrsearch'))
    ).toEqual(['Barnes & Noble company', 'Amazon company']);
    const entityRequest = fetchImpl.mock.calls
      .map(([input]) => fetchInputUrl(input))
      .find((url) => url.searchParams.get('action') === 'wbgetentities');
    expect(entityRequest?.searchParams.get('ids')?.split('|')).toEqual(
      expect.arrayContaining(['Q795454', 'Q3884'])
    );
  });

  it('uses broad web evidence and the signed-in ChatGPT model in subscription mode', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-subscription-fact-check-'));
    const retrieve = vi.fn(async () => ({
      provider: 'DuckDuckGo HTML' as const,
      queryCount: 1,
      requestFailures: 0,
      items: [
        {
          url: 'https://science.nasa.gov/moon/by-the-numbers/',
          canonicalUrl: 'https://science.nasa.gov/moon/by-the-numbers/',
          publisher: 'NASA',
          title: 'Moon by the numbers',
          publicationDate: null,
          accessedAt: '2026-08-10T20:00:00.000Z',
          excerpt: 'The Moon is 3.7 times smaller than Earth and has a diameter of 3,475 km.',
          retrievalKind: 'page_extract' as const,
        },
        {
          url: 'https://science.nasa.gov/earth/facts/',
          canonicalUrl: 'https://science.nasa.gov/earth/facts/',
          publisher: 'NASA',
          title: 'Earth facts',
          publicationDate: null,
          accessedAt: '2026-08-10T20:00:00.000Z',
          excerpt: 'Earth has an equatorial diameter of 12,756 kilometers.',
          retrievalKind: 'page_extract' as const,
        },
      ],
    }));
    const synthesize = vi.fn(async () => ({
      verdict: 'Unsupported' as const,
      confidence: 'High' as const,
      conclusion: "NASA's cited measurements show that Earth is larger than the Moon.",
      conclusionCitationIds: ['src_1', 'src_2'],
      ...emptyModelSections,
      provider: 'chatgpt_codex' as const,
      model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
    }));
    const modelClient: ChatGptFactCheckModelClient & ChatGptClaimDetectionModelClient = {
      detectClaims: detectNoClaims,
      checkSupport: async () => ({
        available: true,
        provider: 'chatgpt_codex',
        model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
      }),
      synthesize,
    };
    const instance = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      evidenceRetriever: { retrieve },
      modelClient,
      now: () => Date.parse('2026-08-10T20:00:00.000Z'),
    });
    const moonRequest = {
      ...request,
      exactQuote: 'The Moon is larger than the Earth.',
      normalizedClaim: 'The Moon is larger than the Earth.',
    };

    const completed = await terminalJob(
      instance,
      moonRequest.meetingId,
      await instance.submitFactCheck('quick', moonRequest)
    );

    expect(completed).toMatchObject({
      status: 'complete',
      result: {
        verdict: 'Unsupported',
        confidence: 'High',
        provenance: {
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
          local: false,
        },
      },
    });
    expect(completed.result?.inventory.map((item) => item.publisher)).toEqual(['NASA', 'NASA']);
    expect(completed.result?.limitations[0]?.text).toContain('public-web inventory');
    expect(retrieve).toHaveBeenCalledWith(moonRequest.normalizedClaim, 'quick');
    expect(synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'quick',
        normalizedClaim: moonRequest.normalizedClaim,
        evidence: expect.arrayContaining([
          expect.objectContaining({ citationId: 'src_1', publisher: 'NASA' }),
        ]),
      }),
      expect.anything()
    );
  });

  it('does not persist high confidence from third-party estimates alone', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-subscription-calibration-'));
    const instance = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      evidenceRetriever: {
        retrieve: async () => ({
          provider: 'DuckDuckGo HTML',
          queryCount: 1,
          requestFailures: 0,
          items: [
            {
              url: 'https://estimates.example.com/company-size',
              canonicalUrl: 'https://estimates.example.com/company-size',
              publisher: 'estimates.example.com',
              title: 'Estimated company headcount',
              publicationDate: null,
              accessedAt: '2026-08-10T20:00:00.000Z',
              excerpt: 'A third-party estimate lists one company as larger by employee count.',
              retrievalKind: 'page_extract',
            },
          ],
        }),
      },
      modelClient: {
        detectClaims: detectNoClaims,
        checkSupport: async () => ({
          available: true,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
        synthesize: async () => ({
          verdict: 'Unsupported',
          confidence: 'High',
          conclusion: 'The third-party estimate contradicts the comparison.',
          conclusionCitationIds: ['src_1'],
          ...emptyModelSections,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
      },
    });

    const completed = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );

    expect(completed).toMatchObject({
      status: 'complete',
      result: { verdict: 'Unsupported', confidence: 'Medium' },
    });
  });

  it('persists citation-bound supports, contradictions, and caveats from deep research', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-subscription-deep-'));
    const retrieve = vi.fn(async () => ({
      provider: 'DuckDuckGo HTML' as const,
      queryCount: 2,
      requestFailures: 0,
      items: [
        {
          url: 'https://science.nasa.gov/moon/',
          canonicalUrl: 'https://science.nasa.gov/moon/',
          publisher: 'NASA',
          title: 'Moon facts',
          publicationDate: null,
          accessedAt: '2026-08-10T20:00:00.000Z',
          excerpt: 'The Moon has a diameter of about 3,475 kilometers.',
          retrievalKind: 'page_extract' as const,
        },
        {
          url: 'https://science.nasa.gov/earth/',
          canonicalUrl: 'https://science.nasa.gov/earth/',
          publisher: 'NASA',
          title: 'Earth facts',
          publicationDate: null,
          accessedAt: '2026-08-10T20:00:00.000Z',
          excerpt: 'Earth has an equatorial diameter of 12,756 kilometers.',
          retrievalKind: 'page_extract' as const,
        },
      ],
    }));
    const instance = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      evidenceRetriever: { retrieve },
      modelClient: {
        detectClaims: detectNoClaims,
        checkSupport: async () => ({
          available: true,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
        synthesize: async () => ({
          verdict: 'Unsupported',
          confidence: 'High',
          conclusion: 'Earth is larger than the Moon by diameter.',
          conclusionCitationIds: ['src_1', 'src_2'],
          supports: [{ text: 'Earth measures 12,756 km across.', citationIds: ['src_2'] }],
          contradictions: [
            { text: 'The Moon measures only about 3,475 km across.', citationIds: ['src_1'] },
          ],
          caveats: [
            {
              text: 'The comparison uses diameter as the stated size metric.',
              citationIds: ['src_1', 'src_2'],
            },
          ],
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
      },
    });
    const moonRequest = {
      ...request,
      exactQuote: 'The Moon is larger than Earth.',
      normalizedClaim: 'The Moon is larger than Earth.',
      idempotencyKey: 'moon-deep:1',
      claimId: 'moon-claim',
      claimVersionId: 'moon-version',
    };

    const completed = await terminalJob(
      instance,
      moonRequest.meetingId,
      await instance.submitFactCheck('deep', moonRequest)
    );

    expect(completed).toMatchObject({
      status: 'complete',
      result: {
        stage: 'deep',
        supports: [{ citationIds: ['src_2'] }],
        contradictions: [{ citationIds: ['src_1'] }],
        caveats: [{ citationIds: ['src_1', 'src_2'] }],
        sources: expect.arrayContaining([
          expect.objectContaining({ citationId: 'src_1', stance: 'contradicts' }),
          expect.objectContaining({ citationId: 'src_2', stance: 'supports' }),
        ]),
      },
    });
    expect(retrieve).toHaveBeenCalledWith(moonRequest.normalizedClaim, 'deep');
  });

  it('does not let an in-flight deep check block a later manual quick check', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-subscription-priority-'));
    let signalDeepStarted: (() => void) | undefined;
    const deepStarted = new Promise<void>((resolve) => {
      signalDeepStarted = resolve;
    });
    let finishDeep: (() => void) | undefined;
    const deepCanFinish = new Promise<void>((resolve) => {
      finishDeep = resolve;
    });
    let signalQuickStarted: (() => void) | undefined;
    const quickStarted = new Promise<void>((resolve) => {
      signalQuickStarted = resolve;
    });
    const result = {
      verdict: 'Unsupported' as const,
      confidence: 'High' as const,
      conclusion: 'The cited measurement contradicts the claim.',
      conclusionCitationIds: ['src_1'],
      supports: [{ text: 'The cited measurement supports the finding.', citationIds: ['src_1'] }],
      contradictions: [],
      caveats: [],
      provider: 'chatgpt_codex' as const,
      model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
    };
    const instance = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      evidenceRetriever: {
        retrieve: async () => ({
          provider: 'DuckDuckGo HTML',
          queryCount: 1,
          requestFailures: 0,
          items: [
            {
              url: 'https://science.nasa.gov/moon/',
              canonicalUrl: 'https://science.nasa.gov/moon/',
              publisher: 'NASA',
              title: 'Moon facts',
              publicationDate: null,
              accessedAt: '2026-08-10T20:00:00.000Z',
              excerpt: 'The Moon is smaller than Earth.',
              retrievalKind: 'page_extract',
            },
          ],
        }),
      },
      modelClient: {
        detectClaims: detectNoClaims,
        checkSupport: async () => ({
          available: true,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
        synthesize: async (modelRequest) => {
          if (modelRequest.stage === 'deep') {
            signalDeepStarted?.();
            await deepCanFinish;
          } else {
            signalQuickStarted?.();
          }
          return result;
        },
      },
    });
    const deepRequest = {
      ...request,
      idempotencyKey: 'claim-version-deep:deep:1',
      claimId: 'claim-deep',
      claimVersionId: 'claim-version-deep',
    };
    const quickRequest = {
      ...request,
      idempotencyKey: 'claim-version-manual:quick:1',
      claimId: 'claim-manual',
      claimVersionId: 'claim-version-manual',
      origin: 'manual' as const,
    };

    await instance.submitFactCheck('deep', deepRequest);
    await deepStarted;
    const submittedQuick = await instance.submitFactCheck('quick', quickRequest);
    await quickStarted;
    const completedQuick = await terminalJob(instance, quickRequest.meetingId, submittedQuick);

    expect(completedQuick.status).toBe('complete');
    finishDeep?.();
    await (instance as unknown as { deepWorkQueue: Promise<void> }).deepWorkQueue;
  });

  it('starts a manual quick check ahead of queued automatic quick checks', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-subscription-manual-'));
    let signalAutomaticStarted: (() => void) | undefined;
    const automaticStarted = new Promise<void>((resolve) => {
      signalAutomaticStarted = resolve;
    });
    let finishAutomatic: (() => void) | undefined;
    const automaticCanFinish = new Promise<void>((resolve) => {
      finishAutomatic = resolve;
    });
    let signalManualStarted: (() => void) | undefined;
    const manualStarted = new Promise<void>((resolve) => {
      signalManualStarted = resolve;
    });
    const startedClaims: string[] = [];
    const instance = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      evidenceRetriever: {
        retrieve: async () => ({
          provider: 'DuckDuckGo HTML',
          queryCount: 1,
          requestFailures: 0,
          items: [
            {
              url: 'https://science.nasa.gov/moon/',
              canonicalUrl: 'https://science.nasa.gov/moon/',
              publisher: 'NASA',
              title: 'Moon facts',
              publicationDate: null,
              accessedAt: '2026-08-10T20:00:00.000Z',
              excerpt: 'The Moon is smaller than Earth.',
              retrievalKind: 'page_extract',
            },
          ],
        }),
      },
      modelClient: {
        detectClaims: detectNoClaims,
        checkSupport: async () => ({
          available: true,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
        synthesize: async (modelRequest) => {
          startedClaims.push(modelRequest.normalizedClaim);
          if (modelRequest.normalizedClaim === 'Automatic claim one.') {
            signalAutomaticStarted?.();
            await automaticCanFinish;
          }
          if (modelRequest.normalizedClaim === 'Manual claim.') signalManualStarted?.();
          return {
            verdict: 'Unsupported',
            confidence: 'High',
            conclusion: 'The cited measurement contradicts the claim.',
            conclusionCitationIds: ['src_1'],
            ...emptyModelSections,
            provider: 'chatgpt_codex',
            model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
          };
        },
      },
    });
    const firstAutomatic = {
      ...request,
      normalizedClaim: 'Automatic claim one.',
      exactQuote: 'Automatic claim one.',
      idempotencyKey: 'automatic-one:quick:1',
      claimId: 'automatic-one',
      claimVersionId: 'automatic-one-version',
    };
    const secondAutomatic = {
      ...request,
      normalizedClaim: 'Automatic claim two.',
      exactQuote: 'Automatic claim two.',
      idempotencyKey: 'automatic-two:quick:1',
      claimId: 'automatic-two',
      claimVersionId: 'automatic-two-version',
    };
    const manual = {
      ...request,
      normalizedClaim: 'Manual claim.',
      exactQuote: 'Manual claim.',
      idempotencyKey: 'manual:quick:1',
      claimId: 'manual',
      claimVersionId: 'manual-version',
      origin: 'manual' as const,
    };

    await instance.submitFactCheck('quick', firstAutomatic);
    await automaticStarted;
    await instance.submitFactCheck('quick', secondAutomatic);
    const submittedManual = await instance.submitFactCheck('quick', manual);
    await manualStarted;
    const completedManual = await terminalJob(instance, manual.meetingId, submittedManual);

    expect(completedManual.status).toBe('complete');
    expect(startedClaims).toEqual(['Automatic claim one.', 'Manual claim.']);
    finishAutomatic?.();
    await (instance as unknown as { workQueue: Promise<void> }).workQueue;
    expect(startedClaims).toEqual([
      'Automatic claim one.',
      'Manual claim.',
      'Automatic claim two.',
    ]);
  });

  it('constrains Ollama citations to the exact retrieved inventory', async () => {
    const { instance, fetchImpl } = await service();

    await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );

    const [body] = synthesisBodies(fetchImpl);
    expect(body.format).toMatchObject({
      type: 'object',
      properties: {
        conclusionCitationIds: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: {
            type: 'string',
            enum: ['src_1', 'src_2', 'src_3', 'src_4'],
          },
        },
      },
    });
  });

  it('deduplicates duplicate Wikidata entities before assigning citation IDs', async () => {
    const providerFetch = completeFetch();
    const fetchImpl = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = fetchInputUrl(input);
      if (
        url.origin === 'https://www.wikidata.org' &&
        url.searchParams.get('action') === 'wbsearchentities'
      ) {
        return json({
          search: [
            {
              id: 'Q3884',
              label: 'Amazon',
              description: 'American multinational technology company',
            },
            {
              id: 'Q795454',
              label: 'Barnes & Noble',
              description: 'American bookseller',
            },
          ],
        });
      }
      return (providerFetch as unknown as typeof fetch)(input, init);
    });
    const { instance } = await service(fetchImpl);

    const completed = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );

    expect(completed.status).toBe('complete');
    const inventory = completed.result?.inventory ?? [];
    const canonicalUrls = inventory.map((source) => source.canonicalUrl);
    expect(new Set(canonicalUrls).size).toBe(canonicalUrls.length);
    expect(inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalUrl: 'https://www.wikidata.org/wiki/Q3884',
          title: 'Amazon — structured company-size fields',
        }),
        expect.objectContaining({
          canonicalUrl: 'https://www.wikidata.org/wiki/Q795454',
          title: 'Barnes & Noble — structured company-size fields',
        }),
      ])
    );
    expect(
      completed.result?.statements.every((statement) =>
        statement.citationIds.every((citationId) =>
          inventory.some((source) => source.citationId === citationId)
        )
      )
    ).toBe(true);
  });

  it('splits a comparison into entity searches instead of trusting the noisy whole-claim search', () => {
    expect(wikipediaQueriesForClaim('Barnes and Noble is a bigger company than Amazon.')).toEqual([
      'Barnes & Noble company',
      'Amazon company',
    ]);
  });

  it('retries an unknown citation once, then returns a conservative cited assessment', async () => {
    const invalid = {
      ...validDraft,
      conclusion: 'RAW MODEL CONCLUSION THAT MUST NEVER BE SURFACED',
      conclusionCitationIds: ['src_99'],
    };
    const fetchImpl = completeFetch(invalid);
    const { instance } = await service(fetchImpl);

    const completed = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );

    expect(completed).toMatchObject({
      status: 'complete',
      result: {
        verdict: 'Unverifiable',
        confidence: 'Low',
        conclusion: expect.not.stringContaining('RAW MODEL CONCLUSION'),
      },
    });
    expect(completed.result?.conclusionCitationIds).toEqual(['src_1', 'src_2', 'src_3', 'src_4']);
    expect(synthesisBodies(fetchImpl)).toHaveLength(2);
  });

  it('retries duplicate citations once, then returns a unique cited fallback', async () => {
    const duplicate = {
      ...validDraft,
      conclusionCitationIds: ['src_1', 'src_1'],
    };
    const fetchImpl = completeFetch(duplicate);
    const { instance } = await service(fetchImpl);

    const completed = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );

    expect(completed).toMatchObject({
      status: 'complete',
      result: { verdict: 'Unverifiable', confidence: 'Low' },
    });
    expect(new Set(completed.result?.conclusionCitationIds).size).toBe(
      completed.result?.conclusionCitationIds.length
    );
    expect(synthesisBodies(fetchImpl)).toHaveLength(2);
  });

  it('uses the one serialized repair result when its citations validate', async () => {
    const fetchImpl = sequencedDraftFetch([
      { ...validDraft, conclusionCitationIds: ['src_unknown'] },
      validDraft,
    ]);
    const { instance } = await service(fetchImpl);

    const completed = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );

    expect(completed).toMatchObject({
      status: 'complete',
      result: {
        conclusion: validDraft.conclusion,
        conclusionCitationIds: validDraft.conclusionCitationIds,
      },
    });
    const bodies = synthesisBodies(fetchImpl);
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1])).not.toContain('src_unknown');
  });

  it('reports unavailable Ollama without creating an assessment', async () => {
    const fetchImpl = completeFetch();
    fetchImpl.mockImplementation(async (input: FetchInput) => {
      const url = fetchInputUrl(input);
      if (url.pathname === '/api/tags') return json({ models: [] });
      throw new Error('No other provider should be called');
    });
    const { instance } = await service(fetchImpl);
    await expect(instance.checkSupport()).resolves.toMatchObject({ available: false });

    const completed = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );

    expect(completed).toMatchObject({
      status: 'failed',
      result: undefined,
      error: { code: 'local_research_unavailable', retryable: true },
    });
  });

  it('returns support before a content-free model warmup finishes', async () => {
    let finishWarmup: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(async (input: FetchInput, _init?: FetchInit) => {
      const url = fetchInputUrl(input);
      if (url.pathname === '/api/tags') {
        return json({ models: [{ name: LOCAL_FACT_CHECK_MODEL }] });
      }
      if (url.pathname === '/api/chat') {
        return new Promise<Response>((resolve) => {
          finishWarmup = resolve;
        });
      }
      throw new Error('Unexpected warmup request');
    });
    const { instance } = await service(fetchImpl);

    await expect(instance.checkSupport()).resolves.toMatchObject({ available: true });
    const warmupCall = fetchImpl.mock.calls.find(([input]) =>
      fetchInputUrl(input).pathname.includes('/api/chat')
    );
    expect(warmupCall).toBeDefined();
    const body = JSON.parse(String(warmupCall?.[1]?.body)) as {
      messages: unknown[];
      model: string;
      options: { num_ctx: number };
    };
    expect(body).toEqual(
      expect.objectContaining({
        model: LOCAL_FACT_CHECK_MODEL,
        messages: [],
        options: { num_ctx: 4_096 },
      })
    );
    expect(String(warmupCall?.[1]?.body)).not.toContain(request.exactQuote);
    expect(String(warmupCall?.[1]?.body)).not.toContain(request.contextTurns[0]?.text ?? '');

    finishWarmup?.(json({ done: true, done_reason: 'load' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('returns a typed evidence limitation and no assessment when Wikimedia finds nothing', async () => {
    const fetchImpl = completeFetch();
    fetchImpl.mockImplementation(async (input: FetchInput) => {
      const url = fetchInputUrl(input);
      if (url.pathname === '/api/tags') {
        return json({ models: [{ name: LOCAL_FACT_CHECK_MODEL }] });
      }
      if (url.origin === 'https://en.wikipedia.org') return json({ query: { pages: [] } });
      if (url.origin === 'https://www.wikidata.org') return json({ search: [] });
      throw new Error('Ollama synthesis must not run without evidence');
    });
    const { instance } = await service(fetchImpl);

    const completed = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );

    expect(completed).toMatchObject({
      status: 'failed',
      result: undefined,
      error: {
        code: 'local_evidence_unavailable',
        retryable: false,
        message: expect.stringContaining('English Wikipedia and Wikidata'),
      },
    });
    expect(
      fetchImpl.mock.calls.some(([input, init]) => {
        if (!fetchInputUrl(input).pathname.includes('/api/chat')) return false;
        const body = JSON.parse(String(init?.body)) as { messages?: unknown[] };
        return (body.messages?.length ?? 0) > 0;
      })
    ).toBe(false);
  });

  it('reports a retryable provider outage instead of treating failed Wikimedia requests as no evidence', async () => {
    const fetchImpl = vi.fn(async (input: FetchInput) => {
      const url = fetchInputUrl(input);
      if (url.pathname === '/api/tags') {
        return json({ models: [{ name: LOCAL_FACT_CHECK_MODEL }] });
      }
      if (url.pathname === '/api/chat') {
        return json({ done: true, done_reason: 'load', message: { content: '' } });
      }
      throw new Error('Wikimedia is temporarily offline');
    });
    const { instance } = await service(fetchImpl);

    const completed = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );

    expect(completed).toMatchObject({
      status: 'failed',
      result: undefined,
      error: {
        code: 'local_research_provider_unavailable',
        retryable: true,
      },
    });
  });

  it('uses partial Wikipedia evidence when Wikidata is temporarily unavailable', async () => {
    const partialDraft = {
      ...validDraft,
      conclusionCitationIds: ['src_1', 'src_2'],
    };
    const providerFetch = completeFetch(partialDraft);
    const fetchImpl = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = fetchInputUrl(input);
      if (url.origin === 'https://www.wikidata.org') {
        throw new Error('Wikidata is temporarily offline');
      }
      return (providerFetch as unknown as typeof fetch)(input, init);
    });
    const { instance } = await service(fetchImpl);

    const completed = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );

    expect(completed.status).toBe('complete');
    expect(completed.result?.inventory).toHaveLength(2);
    expect(
      completed.result?.inventory.every((source) => source.publisher === 'English Wikipedia')
    ).toBe(true);
  });

  it('never writes transcript or claim content to process logs', async () => {
    const logSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];
    const { instance } = await service();
    await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );

    expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('replays a durable idempotent result after restart and purges it with meeting deletion', async () => {
    const { instance, storeDirectory, fetchImpl } = await service();
    const first = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );
    const replay = await instance.submitFactCheck('quick', request);
    expect(replay).toEqual(first);

    const restartedFetch = vi.fn(async () => {
      throw new Error('A complete durable job must not call a provider after restart');
    });
    const restarted = new LocalFactCheckService({
      mode: 'local_wikimedia',
      storeDirectory,
      fetchImpl: restartedFetch as unknown as typeof fetch,
      now: () => Date.parse('2026-08-10T20:01:00.000Z'),
    });
    await expect(restarted.pollFactCheck(request.meetingId, first.jobId)).resolves.toEqual(first);
    expect(restartedFetch).not.toHaveBeenCalled();

    const meetingDirectory = path.join(storeDirectory, request.meetingId);
    const files = (await import('node:fs/promises')).readdir(meetingDirectory);
    const [jobFile] = await files;
    expect((await stat(meetingDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(meetingDirectory, jobFile))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(meetingDirectory, jobFile), 'utf8')).not.toContain(
      request.contextTurns[0]?.text ?? ''
    );

    await restarted.releaseMeeting(request.meetingId);
    const afterDeletion = new LocalFactCheckService({
      mode: 'local_wikimedia',
      storeDirectory,
      fetchImpl: restartedFetch as unknown as typeof fetch,
    });
    await expect(afterDeletion.pollFactCheck(request.meetingId, first.jobId)).rejects.toThrow(
      'not found'
    );
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('cannot recreate a meeting job when deletion races an in-flight atomic write', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-local-fact-race-'));
    const probePath = path.join(storeDirectory, 'file-handle-probe');
    const probe = await open(probePath, 'w');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as Pick<FileHandle, 'sync'>;
    const originalSync = fileHandlePrototype.sync;
    await probe.close();
    await rm(probePath, { force: true });

    let signalSyncStarted: (() => void) | undefined;
    const syncStarted = new Promise<void>((resolve) => {
      signalSyncStarted = resolve;
    });
    let continueSync: (() => void) | undefined;
    const syncCanFinish = new Promise<void>((resolve) => {
      continueSync = resolve;
    });
    vi.spyOn(fileHandlePrototype, 'sync').mockImplementation(async function (this: FileHandle) {
      signalSyncStarted?.();
      await syncCanFinish;
      await originalSync.call(this);
    });

    const instance = new LocalFactCheckService({
      mode: 'local_wikimedia',
      storeDirectory,
      fetchImpl: completeFetch() as unknown as typeof fetch,
    });
    const submission = instance.submitFactCheck('quick', request);
    await syncStarted;
    const deletion = instance.releaseMeeting(request.meetingId);
    await Promise.resolve();
    continueSync?.();

    await expect(submission).rejects.toThrow('deleted');
    await deletion;
    await expect(stat(path.join(storeDirectory, request.meetingId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fences a late synthesis completion after meeting deletion', async () => {
    let signalSynthesisStarted: (() => void) | undefined;
    const synthesisStarted = new Promise<void>((resolve) => {
      signalSynthesisStarted = resolve;
    });
    let continueSynthesis: (() => void) | undefined;
    const synthesisCanFinish = new Promise<void>((resolve) => {
      continueSynthesis = resolve;
    });
    const providerFetch = completeFetch();
    const fetchImpl = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = fetchInputUrl(input);
      if (url.pathname === '/api/chat') {
        const body = JSON.parse(String(init?.body)) as { messages?: unknown[] };
        if ((body.messages?.length ?? 0) > 0) {
          signalSynthesisStarted?.();
          await synthesisCanFinish;
        }
      }
      return (providerFetch as unknown as typeof fetch)(input, init);
    });
    const { instance, storeDirectory } = await service(fetchImpl);
    await instance.submitFactCheck('quick', request);
    await synthesisStarted;
    const queuedWork = (instance as unknown as { workQueue: Promise<void> }).workQueue;

    await instance.releaseMeeting(request.meetingId);
    continueSynthesis?.();
    await queuedWork;

    await expect(stat(path.join(storeDirectory, request.meetingId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      instance.pollFactCheck(request.meetingId, `local-fact-${'a'.repeat(40)}`)
    ).rejects.toThrow('not found');
  });

  it('cancels subscription synthesis before deleting a meeting', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-subscription-delete-'));
    let signalSynthesisStarted: (() => void) | undefined;
    const synthesisStarted = new Promise<void>((resolve) => {
      signalSynthesisStarted = resolve;
    });
    let observedSignal: InstanceType<typeof globalThis.AbortSignal> | undefined;
    const modelClient: ChatGptFactCheckModelClient & ChatGptClaimDetectionModelClient = {
      detectClaims: detectNoClaims,
      checkSupport: async () => ({
        available: true,
        provider: 'chatgpt_codex',
        model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
      }),
      synthesize: async (_modelRequest, signal) => {
        observedSignal = signal;
        signalSynthesisStarted?.();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () =>
              reject(
                Object.assign(new Error('cancelled'), {
                  code: 'chatgpt_cancelled',
                  retryable: false,
                })
              ),
            { once: true }
          );
        });
      },
    };
    const instance = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      modelClient,
      evidenceRetriever: {
        retrieve: async () => ({
          provider: 'DuckDuckGo HTML',
          queryCount: 1,
          requestFailures: 0,
          items: [
            {
              url: 'https://science.nasa.gov/moon/',
              canonicalUrl: 'https://science.nasa.gov/moon/',
              publisher: 'NASA',
              title: 'Moon facts',
              publicationDate: null,
              accessedAt: '2026-08-10T20:00:00.000Z',
              excerpt: 'The Moon is smaller than Earth.',
              retrievalKind: 'page_extract',
            },
          ],
        }),
      },
    });

    await instance.submitFactCheck('quick', request);
    await synthesisStarted;
    const queuedWork = (instance as unknown as { workQueue: Promise<void> }).workQueue;

    await instance.releaseMeeting(request.meetingId);
    await queuedWork;

    expect(observedSignal?.aborted).toBe(true);
    await expect(stat(path.join(storeDirectory, request.meetingId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('disposes the subscription model client during app shutdown', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-subscription-dispose-'));
    const dispose = vi.fn();
    const instance = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      modelClient: {
        detectClaims: detectNoClaims,
        checkSupport: async () => ({
          available: true,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
        synthesize: async () => ({
          verdict: 'Unverifiable' as const,
          confidence: 'Low' as const,
          conclusion: validDraft.conclusion,
          conclusionCitationIds: validDraft.conclusionCitationIds,
          ...emptyModelSections,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
        dispose,
      },
    });

    instance.dispose();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it('leaves interrupted subscription work resumable after app shutdown', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-subscription-resume-'));
    const evidenceRetriever = {
      retrieve: async () => ({
        provider: 'DuckDuckGo HTML' as const,
        queryCount: 1,
        requestFailures: 0,
        items: [
          {
            url: 'https://science.nasa.gov/moon/',
            canonicalUrl: 'https://science.nasa.gov/moon/',
            publisher: 'NASA',
            title: 'Moon facts',
            publicationDate: null,
            accessedAt: '2026-08-10T20:00:00.000Z',
            excerpt: 'The Moon is smaller than Earth.',
            retrievalKind: 'page_extract' as const,
          },
        ],
      }),
    };
    let signalSynthesisStarted: (() => void) | undefined;
    const synthesisStarted = new Promise<void>((resolve) => {
      signalSynthesisStarted = resolve;
    });
    const interrupted = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      evidenceRetriever,
      modelClient: {
        detectClaims: detectNoClaims,
        checkSupport: async () => ({
          available: true,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
        synthesize: async (_modelRequest, signal) => {
          signalSynthesisStarted?.();
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () =>
                reject(
                  Object.assign(new Error('cancelled'), {
                    code: 'chatgpt_cancelled',
                    retryable: false,
                  })
                ),
              { once: true }
            );
          });
        },
      },
    });
    const submitted = await interrupted.submitFactCheck('quick', request);
    await synthesisStarted;

    interrupted.dispose();
    await (interrupted as unknown as { workQueue: Promise<void> }).workQueue;
    await expect(
      interrupted.pollFactCheck(request.meetingId, submitted.jobId)
    ).resolves.toMatchObject({
      status: 'retry_wait',
      error: { code: 'local_research_interrupted', retryable: true },
    });

    const restarted = new LocalFactCheckService({
      mode: 'subscription_web',
      storeDirectory,
      evidenceRetriever,
      modelClient: {
        detectClaims: detectNoClaims,
        checkSupport: async () => ({
          available: true,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
        synthesize: async () => ({
          verdict: 'Unsupported',
          confidence: 'High',
          conclusion: 'The cited measurement contradicts the claim.',
          conclusionCitationIds: ['src_1'],
          ...emptyModelSections,
          provider: 'chatgpt_codex',
          model: CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
        }),
      },
    });
    const resumed = await restarted.submitFactCheck('quick', request);
    const completed = await terminalJob(restarted, request.meetingId, resumed);

    expect(completed.status).toBe('complete');
  });

  it('refreshes unavailable support and completes a new durable retry attempt', async () => {
    const storeDirectory = await mkdtemp(path.join(tmpdir(), 'obelus-local-fact-retry-'));
    let ollamaAvailable = false;
    const providerFetch = completeFetch();
    const fetchImpl = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = fetchInputUrl(input);
      if (url.pathname === '/api/tags') {
        return json({ models: ollamaAvailable ? [{ name: LOCAL_FACT_CHECK_MODEL }] : [] });
      }
      return (providerFetch as unknown as typeof fetch)(input, init);
    });
    const instance = new LocalFactCheckService({
      mode: 'local_wikimedia',
      storeDirectory,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => Date.parse('2026-08-10T20:00:00.000Z'),
    });
    const first = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', request)
    );
    expect(first).toMatchObject({
      status: 'failed',
      error: { code: 'local_research_unavailable', retryable: true },
    });

    ollamaAvailable = true;
    const retryRequest = { ...request, idempotencyKey: 'claim-version-1:quick:2' };
    const retry = await terminalJob(
      instance,
      request.meetingId,
      await instance.submitFactCheck('quick', retryRequest)
    );
    expect(retry.status).toBe('complete');
    expect(retry.jobId).not.toBe(first.jobId);

    const reopened = new LocalFactCheckService({
      mode: 'local_wikimedia',
      storeDirectory,
      fetchImpl: vi.fn(async () => {
        throw new Error('A reopened complete retry must remain local and durable');
      }) as unknown as typeof fetch,
    });
    await expect(reopened.pollFactCheck(request.meetingId, retry.jobId)).resolves.toEqual(retry);
  });
});
