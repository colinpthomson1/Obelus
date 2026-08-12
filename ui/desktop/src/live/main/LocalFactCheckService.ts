import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  ClaimDetectionRequest,
  ClaimDetectionResponse,
  FactCheckStage,
  FactCheckSubmitRequest,
  GatewayJobResponse,
  GatewayJobStatus,
  LiveCaptureError,
  LiveFactCheckMode,
} from '../ipcTypes';
import {
  LOCAL_FACT_CHECK_EVIDENCE_SCOPE,
  LOCAL_FACT_CHECK_JOB_PREFIX,
  LOCAL_FACT_CHECK_MODEL,
  SUBSCRIPTION_WEB_EVIDENCE_SCOPE,
  isLocalFactCheckJobId,
  type LocalFactCheckAssessmentResult,
  type LocalFactCheckCitedStatement,
  type LocalFactCheckClient,
  type LocalFactCheckSupport,
} from '../localFactCheckProtocol';
import type {
  ChatGptClaimDetectionModelClient,
  ChatGptFactCheckModelClient,
  ChatGptFactCheckResult,
} from './ChatGptSubscriptionFactCheckClient';
import { WebEvidenceRetriever, type WebEvidenceItem } from './WebEvidenceRetriever';

const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';
const OLLAMA_CHAT_URL = 'http://127.0.0.1:11434/api/chat';
const WIKIPEDIA_API_URL = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API_URL = 'https://www.wikidata.org/w/api.php';
const STORE_VERSION = 1;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_OLLAMA_RESPONSE_BYTES = 512 * 1_024;
const MAX_EVIDENCE_ITEMS = 7;
const MAX_EXCERPT_LENGTH = 1_800;
const MAX_STORED_JOBS = 500;
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_WIKIMEDIA_TIMEOUT_MS = 10_000;
const DEFAULT_OLLAMA_TIMEOUT_MS = 90_000;
const SUPPORT_CACHE_TTL_MS = 5_000;
const MAX_CACHED_CLAIM_DETECTIONS = 2_048;

type Verdict = LocalFactCheckAssessmentResult['verdict'];
type Confidence = LocalFactCheckAssessmentResult['confidence'];

interface LocalEvidenceItem {
  citationId: string;
  url: string;
  canonicalUrl: string;
  publisher: string;
  title: string;
  publicationDate: string | null;
  accessedAt: string;
  excerpt: string;
  retrievalKind?: WebEvidenceItem['retrievalKind'];
}

interface WikipediaSearchResult {
  sources: Array<Omit<LocalEvidenceItem, 'citationId'>>;
  entityIds: string[];
  requestFailures: number;
}

interface LocalAssessmentDraft {
  verdict: Verdict;
  confidence: Confidence;
  conclusion: string;
  conclusionCitationIds: string[];
  supports: LocalFactCheckCitedStatement[];
  contradictions: LocalFactCheckCitedStatement[];
  caveats: LocalFactCheckCitedStatement[];
}

interface AssessmentProvenance {
  provider: 'ollama' | 'chatgpt_codex';
  model: string;
  local: boolean;
  evidenceScope: string;
}

interface StoredFactCheckRequest {
  meetingId: string;
  claimId: string;
  claimVersionId: string;
  idempotencyKey: string;
  exactQuote: string;
  normalizedClaim: string;
  origin: 'automatic' | 'manual';
}

interface StoredLocalFactCheckJob {
  version: typeof STORE_VERSION;
  jobId: string;
  meetingId: string;
  stage: FactCheckStage;
  request: StoredFactCheckRequest;
  status: GatewayJobStatus;
  result?: LocalFactCheckAssessmentResult;
  error?: LiveCaptureError;
  createdAtMs: number;
  updatedAtMs: number;
}

interface CachedClaimDetection {
  meetingId: string;
  requestFingerprint: string;
  response: ClaimDetectionResponse;
}

interface OllamaChatResponse {
  message?: { content?: unknown };
  model?: unknown;
  done?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

interface LocalFactCheckServiceBaseOptions {
  storeDirectory: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  wikimediaTimeoutMs?: number;
  ollamaTimeoutMs?: number;
}

export type LocalFactCheckServiceOptions = LocalFactCheckServiceBaseOptions &
  (
    | {
        mode: 'subscription_web';
        modelClient: ChatGptFactCheckModelClient & ChatGptClaimDetectionModelClient;
        evidenceRetriever?: Pick<WebEvidenceRetriever, 'retrieve'>;
      }
    | {
        mode: 'local_wikimedia';
        modelClient?: never;
        evidenceRetriever?: never;
      }
  );

export class LocalFactCheckService implements LocalFactCheckClient {
  readonly factCheckMode: Extract<LiveFactCheckMode, 'subscription_web' | 'local_wikimedia'>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly wikimediaTimeoutMs: number;
  private readonly ollamaTimeoutMs: number;
  private readonly mode: Extract<LiveFactCheckMode, 'subscription_web' | 'local_wikimedia'>;
  private readonly modelClient?: ChatGptFactCheckModelClient & ChatGptClaimDetectionModelClient;
  private readonly evidenceRetriever?: Pick<WebEvidenceRetriever, 'retrieve'>;
  private readonly jobs = new Map<string, StoredLocalFactCheckJob>();
  private readonly runningJobs = new Set<string>();
  private readonly activeSynthesis = new Map<string, AbortController>();
  private readonly activeDetections = new Map<
    string,
    { meetingId: string; controller: AbortController }
  >();
  private readonly cachedClaimDetections = new Map<string, CachedClaimDetection>();
  private readonly releasedMeetings = new Set<string>();
  private readonly meetingPersistence = new Map<string, Promise<void>>();
  private workQueue: Promise<void> = Promise.resolve();
  private manualWorkQueue: Promise<void> = Promise.resolve();
  private deepWorkQueue: Promise<void> = Promise.resolve();
  private backgroundDetectionQueue: Promise<void> = Promise.resolve();
  private readonly detectionWorkQueues = new Map<string, Promise<void>>();
  private initialized?: Promise<void>;
  private supportPromise?: Promise<LocalFactCheckSupport>;
  private supportCheckedAtMs = Number.NEGATIVE_INFINITY;
  private warmupPromise?: Promise<void>;
  private disposed = false;

  constructor(private readonly options: LocalFactCheckServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.wikimediaTimeoutMs = options.wikimediaTimeoutMs ?? DEFAULT_WIKIMEDIA_TIMEOUT_MS;
    this.ollamaTimeoutMs = options.ollamaTimeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
    this.mode = options.mode;
    this.factCheckMode = options.mode;
    this.modelClient = options.mode === 'subscription_web' ? options.modelClient : undefined;
    this.evidenceRetriever =
      options.mode === 'subscription_web'
        ? (options.evidenceRetriever ?? new WebEvidenceRetriever({ now: this.now }))
        : undefined;
  }

  checkSupport(): Promise<LocalFactCheckSupport> {
    if (!this.supportPromise || this.now() - this.supportCheckedAtMs >= SUPPORT_CACHE_TTL_MS) {
      this.supportCheckedAtMs = this.now();
      this.supportPromise = this.probeSupport();
    }
    return this.supportPromise;
  }

  detectClaims(
    request: ClaimDetectionRequest,
    foreground = false
  ): Promise<ClaimDetectionResponse> {
    if (this.mode !== 'subscription_web' || request.manual === true) {
      return Promise.reject(
        localFactCheckError(
          'ChatGPT automatic claim detection is unavailable.',
          'local_research_unavailable'
        )
      );
    }
    const previous = this.detectionWorkQueues.get(request.meetingId) ?? Promise.resolve();
    const operation = previous.then(() =>
      foreground ? this.runClaimDetection(request) : this.runBackgroundClaimDetection(request)
    );
    const queue = operation.then(
      () => undefined,
      () => undefined
    );
    this.detectionWorkQueues.set(request.meetingId, queue);
    void queue.finally(() => {
      if (this.detectionWorkQueues.get(request.meetingId) === queue) {
        this.detectionWorkQueues.delete(request.meetingId);
      }
    });
    return operation;
  }

  private runBackgroundClaimDetection(
    request: ClaimDetectionRequest
  ): Promise<ClaimDetectionResponse> {
    const operation = this.backgroundDetectionQueue.then(() => this.runClaimDetection(request));
    this.backgroundDetectionQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  async submitFactCheck(
    stage: FactCheckStage,
    request: FactCheckSubmitRequest
  ): Promise<GatewayJobResponse<LocalFactCheckAssessmentResult>> {
    await this.initialize();
    if (this.releasedMeetings.has(request.meetingId)) {
      throw localFactCheckError('This meeting has been deleted.', 'local_research_not_found');
    }
    const storedRequest = minimalStoredRequest(request);
    const jobId = localJobId(request.meetingId, request.idempotencyKey);
    const existing = await this.getJob(jobId, request.meetingId);
    if (this.releasedMeetings.has(request.meetingId)) {
      throw localFactCheckError('This meeting has been deleted.', 'local_research_not_found');
    }
    if (existing) {
      assertIdempotentReplay(existing, stage, storedRequest);
      if (isRunnable(existing.status)) this.enqueue(existing.jobId);
      return publicJob(existing);
    }

    const now = this.now();
    const job: StoredLocalFactCheckJob = {
      version: STORE_VERSION,
      jobId,
      meetingId: request.meetingId,
      stage,
      request: storedRequest,
      status: 'pending',
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.jobs.set(jobId, job);
    try {
      await this.persistJob(job);
    } catch (error) {
      if (!this.releasedMeetings.has(job.meetingId)) throw error;
    }
    if (this.releasedMeetings.has(job.meetingId)) {
      this.jobs.delete(jobId);
      throw localFactCheckError('This meeting has been deleted.', 'local_research_not_found');
    }
    this.enqueue(jobId);
    return publicJob(job);
  }

  async pollFactCheck(
    meetingId: string,
    jobId: string
  ): Promise<GatewayJobResponse<LocalFactCheckAssessmentResult>> {
    await this.initialize();
    if (this.releasedMeetings.has(meetingId)) {
      throw localFactCheckError('Local fact-check job was not found.', 'local_research_not_found');
    }
    if (!isLocalFactCheckJobId(jobId))
      throw localFactCheckError('Local fact-check job is invalid.');
    const job = await this.getJob(jobId, meetingId);
    if (!job || job.meetingId !== meetingId) {
      throw localFactCheckError('Local fact-check job was not found.', 'local_research_not_found');
    }
    if (isRunnable(job.status)) this.enqueue(job.jobId);
    return publicJob(job);
  }

  async releaseMeeting(meetingId: string): Promise<void> {
    assertSafeMeetingId(meetingId);
    this.releasedMeetings.add(meetingId);
    for (const detection of this.activeDetections.values()) {
      if (detection.meetingId === meetingId) detection.controller.abort();
    }
    for (const [detectionId, detection] of this.cachedClaimDetections) {
      if (detection.meetingId === meetingId) this.cachedClaimDetections.delete(detectionId);
    }
    this.detectionWorkQueues.delete(meetingId);
    await this.initialize();
    for (const [jobId, job] of this.jobs) {
      if (job.meetingId === meetingId) {
        this.activeSynthesis.get(jobId)?.abort();
        this.jobs.delete(jobId);
      }
    }
    await this.meetingPersistence.get(meetingId)?.catch(() => undefined);
    await rm(this.meetingDirectory(meetingId), { recursive: true, force: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.activeSynthesis.values()) controller.abort();
    this.activeSynthesis.clear();
    for (const detection of this.activeDetections.values()) detection.controller.abort();
    this.activeDetections.clear();
    this.cachedClaimDetections.clear();
    this.detectionWorkQueues.clear();
    this.modelClient?.dispose?.();
  }

  private async runClaimDetection(request: ClaimDetectionRequest): Promise<ClaimDetectionResponse> {
    if (this.disposed || this.releasedMeetings.has(request.meetingId)) {
      throw localFactCheckError(
        'Automatic claim detection was interrupted.',
        'local_research_interrupted',
        true
      );
    }
    const detectionId = `${request.meetingId}:${request.idempotencyKey}`;
    const requestFingerprint = claimDetectionRequestFingerprint(request);
    const cached = this.cachedClaimDetections.get(detectionId);
    if (cached) {
      if (cached.requestFingerprint !== requestFingerprint) {
        throw localFactCheckError(
          'Automatic claim detection idempotency key was reused with different transcript content.',
          'local_research_invalid_request'
        );
      }
      return cached.response;
    }
    const support = await this.checkSupport();
    if (this.disposed || this.releasedMeetings.has(request.meetingId)) {
      throw localFactCheckError(
        'Automatic claim detection was interrupted.',
        'local_research_interrupted',
        true
      );
    }
    if (!support.available) {
      this.invalidateSupport();
      throw localFactCheckError(
        support.reason ?? 'Sign in to ChatGPT in Obelus before using automatic claim detection.',
        'chatgpt_auth_required'
      );
    }

    const turns = request.contextTurns ?? request.turns;
    const requiredTurnIds = request.requiredTurnIds ?? request.turns.map((turn) => turn.id);
    const controller = new AbortController();
    this.activeDetections.set(detectionId, { meetingId: request.meetingId, controller });
    try {
      const detection = await this.modelClient!.detectClaims(
        {
          turns,
          requiredTurnIds,
          existingClaimKeys: request.existingClaimKeys ?? [],
        },
        controller.signal
      );
      if (this.disposed || this.releasedMeetings.has(request.meetingId)) {
        throw localFactCheckError(
          'Automatic claim detection was interrupted.',
          'local_research_interrupted',
          true
        );
      }
      const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
      const response: ClaimDetectionResponse = {
        candidates: detection.candidates.map((candidate) => {
          const citedTurns = candidate.segmentIds.map((id) => turnsById.get(id)!);
          const speakerIds = new Set(
            citedTurns.map((turn) => turn.speakerId).filter((speakerId) => speakerId !== null)
          );
          const normalizedClaim = candidate.exactQuote
            .normalize('NFKC')
            .replace(/\s+/g, ' ')
            .trim();
          const duplicateKey = normalizedClaim.toLocaleLowerCase();
          return {
            exactQuote: candidate.exactQuote,
            normalizedClaim,
            contextTurnIds: candidate.segmentIds,
            ...(speakerIds.size === 1 ? { speakerId: [...speakerIds][0] } : {}),
            startMs: citedTurns[0]!.startMs,
            endMs: citedTurns[citedTurns.length - 1]!.endMs,
            checkworthy: candidate.checkworthy,
            consequenceScore: candidate.consequenceScore,
            disputeLikelihoodScore: candidate.disputeLikelihoodScore,
            specificityScore: candidate.specificityScore,
            timeSensitive: candidate.timeSensitive,
            selectionRationale: candidate.selectionRationale,
            semanticDuplicateKey: createHash('sha256').update(duplicateKey).digest('hex'),
          };
        }),
        catchingUp: false,
      };
      this.cachedClaimDetections.set(detectionId, {
        meetingId: request.meetingId,
        requestFingerprint,
        response,
      });
      while (this.cachedClaimDetections.size > MAX_CACHED_CLAIM_DETECTIONS) {
        const oldest = this.cachedClaimDetections.keys().next().value;
        if (oldest === undefined) break;
        this.cachedClaimDetections.delete(oldest);
      }
      return response;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'chatgpt_auth_required'
      ) {
        this.invalidateSupport();
      }
      throw error;
    } finally {
      const active = this.activeDetections.get(detectionId);
      if (active?.controller === controller) this.activeDetections.delete(detectionId);
    }
  }

  private initialize(): Promise<void> {
    this.initialized ??= this.initializeStore();
    return this.initialized;
  }

  private async initializeStore(): Promise<void> {
    await mkdir(this.options.storeDirectory, { recursive: true, mode: 0o700 });
    await this.pruneStoredJobs();
  }

  private enqueue(jobId: string): void {
    if (this.disposed) return;
    if (this.runningJobs.has(jobId)) return;
    const job = this.jobs.get(jobId);
    if (!job || this.releasedMeetings.has(job.meetingId)) return;
    this.runningJobs.add(jobId);
    const queueName =
      this.mode === 'subscription_web' && job.stage === 'quick' && job.request.origin === 'manual'
        ? ('manualWorkQueue' as const)
        : this.mode === 'subscription_web' && job.stage === 'deep'
          ? ('deepWorkQueue' as const)
          : ('workQueue' as const);
    this[queueName] = this[queueName]
      .then(() => this.runJob(jobId))
      .catch(() => undefined)
      .finally(() => {
        this.runningJobs.delete(jobId);
      });
  }

  private async runJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || !isRunnable(job.status) || this.releasedMeetings.has(job.meetingId)) return;
    await this.updateJob(job, { status: 'running', error: undefined });
    if (this.releasedMeetings.has(job.meetingId)) return;
    try {
      const support = await this.checkSupport();
      if (this.releasedMeetings.has(job.meetingId)) return;
      if (!support.available) {
        this.invalidateSupport();
        await this.updateJob(job, {
          status: 'failed',
          error: {
            code: 'local_research_unavailable',
            message:
              support.reason ??
              (this.mode === 'subscription_web'
                ? 'Sign in to ChatGPT in Obelus before using live fact-checking.'
                : `Local fact-checking needs Ollama with ${LOCAL_FACT_CHECK_MODEL} installed.`),
            retryable: this.mode !== 'subscription_web',
          },
        });
        return;
      }

      const inventory = await this.retrieveEvidence(job.request.normalizedClaim, job.stage);
      if (this.releasedMeetings.has(job.meetingId)) return;
      if (inventory.length === 0) {
        const evidenceScope =
          this.mode === 'subscription_web'
            ? SUBSCRIPTION_WEB_EVIDENCE_SCOPE
            : LOCAL_FACT_CHECK_EVIDENCE_SCOPE;
        await this.updateJob(job, {
          status: 'failed',
          error: {
            code: 'local_evidence_unavailable',
            message: `No relevant evidence was found in the configured research scope. ${evidenceScope}`,
            retryable: false,
          },
        });
        return;
      }

      const { draft, provenance } = await this.synthesize(job, inventory);
      if (this.releasedMeetings.has(job.meetingId)) return;
      const result = finishAssessment(job, inventory, draft, provenance, this.now());
      await this.updateJob(job, { status: 'complete', result, error: undefined });
    } catch (error) {
      if (this.releasedMeetings.has(job.meetingId)) return;
      if (this.disposed) {
        await this.updateJob(job, {
          status: 'retry_wait',
          error: {
            code: 'local_research_interrupted',
            message: 'Fact-checking was interrupted when Obelus closed and will resume.',
            retryable: true,
          },
          result: undefined,
        });
        return;
      }
      const typed = normalizeLocalError(error);
      if (typed.code === 'chatgpt_auth_required') this.invalidateSupport();
      await this.updateJob(job, { status: 'failed', error: typed, result: undefined });
    }
  }

  private async retrieveEvidence(
    claim: string,
    stage: FactCheckStage
  ): Promise<LocalEvidenceItem[]> {
    if (this.mode === 'subscription_web') {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await this.evidenceRetriever!.retrieve(claim, stage);
          const items = deduplicateEvidenceByCanonicalUrl(result.items).slice(
            0,
            MAX_EVIDENCE_ITEMS
          );
          if (items.length > 0 || result.requestFailures === 0) {
            return items.map((source, index) => ({ ...source, citationId: `src_${index + 1}` }));
          }
        } catch {
          if (attempt === 1) break;
        }
      }
      throw localFactCheckError(
        'Public-web evidence search is temporarily unavailable.',
        'local_research_provider_unavailable',
        true
      );
    }

    const accessedAt = new Date(this.now()).toISOString();
    const [wikipedia, wikidata] = await Promise.allSettled([
      this.searchWikipedia(claim, accessedAt),
      this.searchWikidata(claim, accessedAt),
    ]);
    const wikipediaResult =
      wikipedia.status === 'fulfilled'
        ? wikipedia.value
        : ({ sources: [], entityIds: [], requestFailures: 1 } satisfies WikipediaSearchResult);
    const [structuredWikidata] = await Promise.allSettled([
      this.searchWikidataEntities(wikipediaResult.entityIds.slice(0, 3), accessedAt),
    ]);
    const candidates = deduplicateEvidenceByCanonicalUrl([
      ...wikipediaResult.sources,
      ...(structuredWikidata.status === 'fulfilled' ? structuredWikidata.value : []),
      ...(wikidata.status === 'fulfilled' ? wikidata.value : []),
    ]).slice(0, MAX_EVIDENCE_ITEMS);
    const requestFailures =
      wikipediaResult.requestFailures +
      (wikidata.status === 'rejected' ? 1 : 0) +
      (structuredWikidata.status === 'rejected' ? 1 : 0);
    if (candidates.length === 0 && requestFailures > 0) {
      throw localFactCheckError(
        'English Wikipedia or Wikidata is temporarily unavailable.',
        'local_research_provider_unavailable',
        true
      );
    }
    return candidates.map((source, index) => ({ ...source, citationId: `src_${index + 1}` }));
  }

  private async searchWikipedia(claim: string, accessedAt: string): Promise<WikipediaSearchResult> {
    const queries = wikipediaQueriesForClaim(claim);
    const responses = await Promise.allSettled(
      queries.map((query) => this.searchWikipediaQuery(query))
    );
    const fulfilledPages = responses.map((response) =>
      response.status === 'fulfilled' ? response.value : []
    );
    const pages: unknown[] = [];
    const maxResults = Math.max(0, ...fulfilledPages.map((results) => results.length));
    for (let index = 0; index < maxResults; index += 1) {
      for (const results of fulfilledPages) {
        const result = results[index];
        if (result !== undefined) pages.push(result);
      }
    }
    const seenPageIds = new Set<number>();
    const entityIds: string[] = [];
    const sources = pages.flatMap((page): Omit<LocalEvidenceItem, 'citationId'>[] => {
      const record = optionalRecord(page);
      const pageId = positiveInteger(record?.pageid);
      const title = boundedText(record?.title, 500);
      const excerpt = boundedText(record?.extract, MAX_EXCERPT_LENGTH);
      if (!pageId || !title || !excerpt || seenPageIds.has(pageId)) return [];
      seenPageIds.add(pageId);
      const pageProps = optionalRecord(record?.pageprops);
      if (
        typeof pageProps?.wikibase_item === 'string' &&
        /^Q[1-9][0-9]*$/.test(pageProps.wikibase_item)
      ) {
        entityIds.push(pageProps.wikibase_item);
      }
      const canonicalUrl = `https://en.wikipedia.org/?curid=${pageId}`;
      return [
        {
          url: canonicalUrl,
          canonicalUrl,
          publisher: 'English Wikipedia',
          title,
          publicationDate: null,
          accessedAt,
          excerpt,
        },
      ];
    });
    const sourceLimit = queries.length > 1 ? Math.min(4, queries.length) : 4;
    return {
      sources: sources.slice(0, sourceLimit),
      entityIds: [...new Set(entityIds)].slice(0, 4),
      requestFailures: responses.filter((response) => response.status === 'rejected').length,
    };
  }

  private async searchWikipediaQuery(queryText: string): Promise<unknown[]> {
    const url = new URL(WIKIPEDIA_API_URL);
    url.search = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: queryText,
      gsrlimit: '3',
      prop: 'extracts|info|pageprops',
      ppprop: 'wikibase_item',
      explaintext: '1',
      exintro: '1',
      exsentences: '8',
      inprop: 'url',
      format: 'json',
      formatversion: '2',
    }).toString();
    const value = asRecord(
      await this.requestJson(url, this.wikimediaTimeoutMs, MAX_RESPONSE_BYTES),
      'Wikipedia response'
    );
    const query = optionalRecord(value.query);
    return Array.isArray(query?.pages) ? query.pages : [];
  }

  private async searchWikidataEntities(
    entityIds: readonly string[],
    accessedAt: string
  ): Promise<Omit<LocalEvidenceItem, 'citationId'>[]> {
    const safeIds = entityIds.filter((id) => /^Q[1-9][0-9]*$/.test(id)).slice(0, 3);
    if (safeIds.length === 0) return [];
    const url = new URL(WIKIDATA_API_URL);
    url.search = new URLSearchParams({
      action: 'wbgetentities',
      ids: safeIds.join('|'),
      props: 'labels|claims',
      languages: 'en',
      format: 'json',
      formatversion: '2',
      origin: '*',
    }).toString();
    const value = asRecord(
      await this.requestJson(url, this.wikimediaTimeoutMs, MAX_RESPONSE_BYTES),
      'Wikidata entity response'
    );
    const entities = optionalRecord(value.entities) ?? {};
    return safeIds.flatMap((id): Omit<LocalEvidenceItem, 'citationId'>[] => {
      const entity = optionalRecord(entities[id]);
      const labels = optionalRecord(entity?.labels);
      const englishLabel = optionalRecord(labels?.en);
      const title = boundedText(englishLabel?.value, 300);
      const claims = optionalRecord(entity?.claims);
      if (!title || !claims) return [];
      const facts = [
        latestQuantityFact(claims.P1128, 'employees'),
        latestQuantityFact(claims.P2139, 'total revenue'),
        latestQuantityFact(claims.P2403, 'total assets'),
      ].filter((fact): fact is string => Boolean(fact));
      if (facts.length === 0) return [];
      const canonicalUrl = `https://www.wikidata.org/wiki/${id}`;
      return [
        {
          url: canonicalUrl,
          canonicalUrl,
          publisher: 'Wikidata',
          title: `${title} — structured company-size fields`,
          publicationDate: null,
          accessedAt,
          excerpt: `${title}: ${facts.join('; ')}. Values can use different or missing dates, so comparisons must name a metric and account for date asymmetry.`,
        },
      ];
    });
  }

  private async searchWikidata(
    claim: string,
    accessedAt: string
  ): Promise<Omit<LocalEvidenceItem, 'citationId'>[]> {
    const url = new URL(WIKIDATA_API_URL);
    url.search = new URLSearchParams({
      action: 'wbsearchentities',
      search: boundedClaim(claim),
      language: 'en',
      uselang: 'en',
      type: 'item',
      limit: '2',
      format: 'json',
      origin: '*',
    }).toString();
    const value = asRecord(
      await this.requestJson(url, this.wikimediaTimeoutMs, MAX_RESPONSE_BYTES),
      'Wikidata response'
    );
    const search = Array.isArray(value.search) ? value.search : [];
    return search.flatMap((entry): Omit<LocalEvidenceItem, 'citationId'>[] => {
      const record = optionalRecord(entry);
      const id =
        typeof record?.id === 'string' && /^Q[1-9][0-9]*$/.test(record.id) ? record.id : '';
      const label = boundedText(record?.label, 300);
      const description = boundedText(record?.description, 1_400);
      if (!id || !label || !description) return [];
      const canonicalUrl = `https://www.wikidata.org/wiki/${id}`;
      return [
        {
          url: canonicalUrl,
          canonicalUrl,
          publisher: 'Wikidata',
          title: label,
          publicationDate: null,
          accessedAt,
          excerpt: `${label}: ${description}`,
        },
      ];
    });
  }

  private async synthesize(
    job: StoredLocalFactCheckJob,
    inventory: readonly LocalEvidenceItem[]
  ): Promise<{ draft: LocalAssessmentDraft; provenance: AssessmentProvenance }> {
    if (this.mode === 'subscription_web') {
      const controller = new AbortController();
      this.activeSynthesis.set(job.jobId, controller);
      let result: ChatGptFactCheckResult;
      try {
        result = await this.modelClient!.synthesize(
          {
            stage: job.stage,
            normalizedClaim: job.request.normalizedClaim,
            exactQuote: job.request.exactQuote,
            evidence: inventory.map((source) => ({
              citationId: source.citationId,
              publisher: source.publisher,
              title: source.title,
              publicationDate: source.publicationDate,
              excerpt: source.excerpt,
              retrievalKind: source.retrievalKind ?? 'search_snippet',
            })),
          },
          controller.signal
        );
      } finally {
        if (this.activeSynthesis.get(job.jobId) === controller) {
          this.activeSynthesis.delete(job.jobId);
        }
      }
      const draft = calibrateSubscriptionConfidence(
        validateAssessmentDraft(result, inventory),
        inventory
      );
      return {
        draft,
        provenance: {
          provider: 'chatgpt_codex',
          model: result.model,
          local: false,
          evidenceScope: SUBSCRIPTION_WEB_EVIDENCE_SCOPE,
        },
      };
    }

    const evidence = inventory
      .map(
        (source) =>
          `${source.citationId}\nTitle: ${source.title}\nPublisher: ${source.publisher}\nExcerpt: ${source.excerpt.slice(0, 700)}`
      )
      .join('\n\n');
    await this.warmupPromise?.catch(() => undefined);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return {
          draft: await this.synthesisAttempt(job, inventory, evidence, attempt === 1),
          provenance: {
            provider: 'ollama',
            model: LOCAL_FACT_CHECK_MODEL,
            local: true,
            evidenceScope: LOCAL_FACT_CHECK_EVIDENCE_SCOPE,
          },
        };
      } catch (error) {
        if (!isInvalidModelResponse(error)) throw error;
      }
    }
    return {
      draft: conservativeAssessmentDraft(inventory),
      provenance: {
        provider: 'ollama',
        model: LOCAL_FACT_CHECK_MODEL,
        local: true,
        evidenceScope: LOCAL_FACT_CHECK_EVIDENCE_SCOPE,
      },
    };
  }

  private async synthesisAttempt(
    job: StoredLocalFactCheckJob,
    inventory: readonly LocalEvidenceItem[],
    evidence: string,
    repair: boolean
  ): Promise<LocalAssessmentDraft> {
    const rawResponse = await this.requestJson(
      new URL(OLLAMA_CHAT_URL),
      this.ollamaTimeoutMs,
      MAX_OLLAMA_RESPONSE_BYTES,
      {
        method: 'POST',
        body: JSON.stringify({
          model: LOCAL_FACT_CHECK_MODEL,
          stream: false,
          think: false,
          keep_alive: '10m',
          format: assessmentJsonSchema(inventory),
          options: {
            temperature: 0,
            num_ctx: 4_096,
            num_predict: job.stage === 'quick' ? 220 : 320,
          },
          messages: [
            {
              role: 'system',
              content:
                'Create one compact preliminary fact-check using only the supplied evidence inventory. Treat every item as a secondary reference source and never use outside knowledge. Return one conclusion sentence under 240 characters. Cite only supplied IDs that directly support that sentence. A word such as bigger is ambiguous unless the claim names a metric and date. Use Unverifiable and Low confidence when the inventory does not answer the claim. Return only the four requested JSON fields.',
            },
            ...(repair
              ? [
                  {
                    role: 'system',
                    content:
                      'The prior local generation failed structural or citation validation. Generate a fresh response that follows the schema exactly; do not quote or reproduce the prior response.',
                  },
                ]
              : []),
            {
              role: 'user',
              content: `Stage: ${job.stage}\nClaim: ${job.request.normalizedClaim}\nExact quote: ${job.request.exactQuote}\n\nEvidence inventory:\n${evidence}`,
            },
          ],
        }),
      }
    );
    const response = optionalRecord(rawResponse) as OllamaChatResponse | undefined;
    if (!response || response.done !== true || typeof response.message?.content !== 'string') {
      throw invalidModelResponse();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.message.content);
    } catch {
      throw invalidModelResponse();
    }
    return validateAssessmentDraft(parsed, inventory);
  }

  private async probeSupport(): Promise<LocalFactCheckSupport> {
    if (this.mode === 'subscription_web') {
      const support = await this.modelClient!.checkSupport();
      return {
        available: support.available,
        mode: 'subscription_web',
        model: support.model,
        evidenceScope: SUBSCRIPTION_WEB_EVIDENCE_SCOPE,
        reason: support.reason,
      };
    }
    try {
      const response = asRecord(
        await this.requestJson(new URL(OLLAMA_TAGS_URL), 3_000, MAX_OLLAMA_RESPONSE_BYTES),
        'Ollama model list'
      );
      const models = Array.isArray(response.models) ? response.models : [];
      const installed = models.some((model) => {
        const record = optionalRecord(model);
        return record?.name === LOCAL_FACT_CHECK_MODEL || record?.model === LOCAL_FACT_CHECK_MODEL;
      });
      if (installed && !this.warmupPromise) {
        this.warmupPromise = this.warmModel();
        void this.warmupPromise.catch(() => {
          this.warmupPromise = undefined;
        });
      }
      return {
        available: installed,
        mode: 'local_wikimedia',
        model: LOCAL_FACT_CHECK_MODEL,
        evidenceScope: LOCAL_FACT_CHECK_EVIDENCE_SCOPE,
        reason: installed
          ? undefined
          : `Local fact-checking needs Ollama with ${LOCAL_FACT_CHECK_MODEL} installed.`,
      };
    } catch {
      return {
        available: false,
        mode: 'local_wikimedia',
        model: LOCAL_FACT_CHECK_MODEL,
        evidenceScope: LOCAL_FACT_CHECK_EVIDENCE_SCOPE,
        reason: 'Local fact-checking needs Ollama running on this Mac.',
      };
    }
  }

  private async warmModel(): Promise<void> {
    await this.requestJson(
      new URL(OLLAMA_CHAT_URL),
      this.ollamaTimeoutMs,
      MAX_OLLAMA_RESPONSE_BYTES,
      {
        method: 'POST',
        body: JSON.stringify({
          model: LOCAL_FACT_CHECK_MODEL,
          stream: false,
          think: false,
          keep_alive: '10m',
          options: { num_ctx: 4_096 },
          messages: [],
        }),
      }
    );
  }

  private invalidateSupport(): void {
    this.supportPromise = undefined;
    this.supportCheckedAtMs = Number.NEGATIVE_INFINITY;
  }

  private async requestJson(
    url: URL,
    timeoutMs: number,
    maxBytes: number,
    init: { method?: 'GET' | 'POST'; body?: string } = {}
  ): Promise<unknown> {
    assertAllowlistedRequest(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (init.body) headers['Content-Type'] = 'application/json';
      if (url.origin === 'https://en.wikipedia.org' || url.origin === 'https://www.wikidata.org') {
        headers['User-Agent'] =
          'ObelusDesktop/1.45 local-fact-check (fixed-scope Wikimedia API client)';
      }
      const response = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        signal: controller.signal,
        redirect: 'error',
      });
      const parsed = await readBoundedJson(response, maxBytes);
      if (!response.ok) {
        throw localFactCheckError(
          'A local research provider is unavailable.',
          'local_research_unavailable',
          true
        );
      }
      return parsed;
    } catch (error) {
      if (controller.signal.aborted) {
        throw localFactCheckError(
          'Local fact-checking took too long to respond.',
          'local_research_timeout',
          true
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async getJob(
    jobId: string,
    meetingId: string
  ): Promise<StoredLocalFactCheckJob | undefined> {
    const cached = this.jobs.get(jobId);
    if (cached) return cached.meetingId === meetingId ? cached : undefined;
    try {
      const raw = await readFile(this.jobPath(meetingId, jobId), 'utf8');
      const job = parseStoredJob(JSON.parse(raw));
      if (job.meetingId !== meetingId || this.releasedMeetings.has(meetingId)) return undefined;
      this.jobs.set(job.jobId, job);
      return job;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      return undefined;
    }
  }

  private async updateJob(
    job: StoredLocalFactCheckJob,
    patch: Pick<StoredLocalFactCheckJob, 'status'> &
      Partial<Pick<StoredLocalFactCheckJob, 'result' | 'error'>>
  ): Promise<void> {
    if (this.releasedMeetings.has(job.meetingId)) return;
    const next: StoredLocalFactCheckJob = {
      ...job,
      status: patch.status,
      updatedAtMs: this.now(),
    };
    if ('result' in patch) next.result = patch.result;
    if ('error' in patch) next.error = patch.error;
    await this.persistJob(next);
    if (this.releasedMeetings.has(job.meetingId)) return;
    Object.assign(job, next);
    this.jobs.set(job.jobId, job);
  }

  private async persistJob(job: StoredLocalFactCheckJob): Promise<void> {
    if (this.releasedMeetings.has(job.meetingId)) return;
    const previous = this.meetingPersistence.get(job.meetingId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.releasedMeetings.has(job.meetingId)) return;
        const directory = this.meetingDirectory(job.meetingId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (this.releasedMeetings.has(job.meetingId)) {
          await rm(directory, { recursive: true, force: true });
          return;
        }
        const destination = this.jobPath(job.meetingId, job.jobId);
        const temporary = path.join(directory, `.${job.jobId}.${process.pid}.${randomUUID()}.tmp`);
        let committed = false;
        try {
          const file = await open(temporary, 'wx', 0o600);
          try {
            await file.writeFile(JSON.stringify(job), 'utf8');
            await file.sync();
          } finally {
            await file.close();
          }
          if (this.releasedMeetings.has(job.meetingId)) return;
          await rename(temporary, destination);
          committed = true;
          if (this.releasedMeetings.has(job.meetingId)) {
            await rm(directory, { recursive: true, force: true });
          }
        } finally {
          if (!committed) await unlink(temporary).catch(() => undefined);
        }
      });
    let tracked: Promise<void>;
    tracked = operation.finally(() => {
      if (this.meetingPersistence.get(job.meetingId) === tracked) {
        this.meetingPersistence.delete(job.meetingId);
      }
    });
    this.meetingPersistence.set(job.meetingId, tracked);
    await tracked;
  }

  private jobPath(meetingId: string, jobId: string): string {
    if (!isLocalFactCheckJobId(jobId)) {
      throw localFactCheckError('Local fact-check job is invalid.');
    }
    return path.join(this.meetingDirectory(meetingId), `${jobId}.json`);
  }

  private meetingDirectory(meetingId: string): string {
    assertSafeMeetingId(meetingId);
    return path.join(this.options.storeDirectory, meetingId);
  }

  private async pruneStoredJobs(): Promise<void> {
    const meetingNames = (await readdir(this.options.storeDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isSafeMeetingId(entry.name))
      .map((entry) => entry.name);
    const files = (
      await Promise.all(
        meetingNames.map(async (meetingId) => {
          const directory = this.meetingDirectory(meetingId);
          return Promise.all(
            (await readdir(directory))
              .filter((name) => /^local-fact-[a-f0-9]{40}\.json$/.test(name))
              .map(async (name) => ({
                absolutePath: path.join(directory, name),
                modifiedAtMs: (await stat(path.join(directory, name))).mtimeMs,
              }))
          );
        })
      )
    ).flat();
    files.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
    const cutoff = this.now() - JOB_RETENTION_MS;
    await Promise.allSettled(
      files
        .filter((file, index) => index >= MAX_STORED_JOBS || file.modifiedAtMs < cutoff)
        .map((file) => unlink(file.absolutePath))
    );
  }
}

function finishAssessment(
  job: StoredLocalFactCheckJob,
  inventory: readonly LocalEvidenceItem[],
  draft: LocalAssessmentDraft,
  provenance: AssessmentProvenance,
  completedAtMs: number
): LocalFactCheckAssessmentResult {
  const limitation: LocalFactCheckCitedStatement = {
    text:
      provenance.provider === 'chatgpt_codex'
        ? `This ${job.stage === 'quick' ? 'preliminary' : 'follow-up'} finding is bounded to the cited public-web inventory available at check time; it is not an exhaustive search of every source.`
        : `This local ${job.stage === 'quick' ? 'preliminary' : 'follow-up'} check considered only the cited English Wikipedia and Wikidata entries; it did not search the wider web or primary-source databases.`,
    citationIds: inventory.map((source) => source.citationId),
  };
  const statements = uniqueStatements([
    { text: draft.conclusion, citationIds: draft.conclusionCitationIds },
    ...draft.supports,
    ...draft.contradictions,
    ...draft.caveats,
    limitation,
  ]);
  const citedIds = new Set(statements.flatMap((statement) => statement.citationIds));
  const supportingIds = new Set(draft.supports.flatMap((statement) => statement.citationIds));
  const contradictingIds = new Set(
    draft.contradictions.flatMap((statement) => statement.citationIds)
  );
  return {
    stage: job.stage === 'quick' ? 'preliminary' : 'deep',
    originalQuote: job.request.exactQuote,
    normalizedClaim: job.request.normalizedClaim,
    verdict: draft.verdict,
    confidence: draft.confidence,
    conclusion: draft.conclusion,
    conclusionCitationIds: draft.conclusionCitationIds,
    statements,
    supports: draft.supports,
    contradictions: draft.contradictions,
    caveats: draft.caveats,
    limitations: [limitation],
    sources: inventory
      .filter((source) => citedIds.has(source.citationId))
      .map((source) => ({
        citationId: source.citationId,
        stance:
          supportingIds.has(source.citationId) && !contradictingIds.has(source.citationId)
            ? ('supports' as const)
            : contradictingIds.has(source.citationId) && !supportingIds.has(source.citationId)
              ? ('contradicts' as const)
              : ('context' as const),
        qualityScore: evidenceQuality(source),
        qualityRationale: evidenceQualityRationale(source),
      })),
    inventory: inventory.map((source) => ({ ...source })),
    completedAt: new Date(completedAtMs).toISOString(),
    aiGenerated: true,
    provenance,
  };
}

function evidenceQuality(source: LocalEvidenceItem): number {
  if (source.publisher === 'English Wikipedia' || source.publisher === 'Wikidata') return 0.5;
  let score = /\.(?:gov|mil|edu)(?:\/|$)/i.test(source.canonicalUrl) ? 0.9 : 0.65;
  if (source.retrievalKind === 'search_snippet') score = Math.min(score, 0.65);
  return score;
}

function calibrateSubscriptionConfidence(
  draft: LocalAssessmentDraft,
  inventory: readonly LocalEvidenceItem[]
): LocalAssessmentDraft {
  if (draft.confidence !== 'High') return draft;
  const cited = new Set(draft.conclusionCitationIds);
  const strongestCitedEvidence = inventory
    .filter((source) => cited.has(source.citationId))
    .reduce((maximum, source) => Math.max(maximum, evidenceQuality(source)), 0);
  return strongestCitedEvidence >= 0.8 ? draft : { ...draft, confidence: 'Medium' };
}

function evidenceQualityRationale(source: LocalEvidenceItem): string {
  if (source.publisher === 'English Wikipedia' || source.publisher === 'Wikidata') {
    return `${source.publisher} is a secondary, community-maintained reference source; verify consequential findings against primary sources.`;
  }
  const material =
    source.retrievalKind === 'page_extract' ? 'page extract' : 'search-result excerpt';
  return `${source.publisher} was discovered through public-web search and represented by a bounded ${material}; open the cited source to assess its full context and authority.`;
}

function deduplicateEvidenceByCanonicalUrl(
  sources: readonly Omit<LocalEvidenceItem, 'citationId'>[]
): Array<Omit<LocalEvidenceItem, 'citationId'>> {
  const unique = new Map<string, Omit<LocalEvidenceItem, 'citationId'>>();
  for (const source of sources) {
    const existing = unique.get(source.canonicalUrl);
    if (!existing || evidenceRichness(source) > evidenceRichness(existing)) {
      unique.set(source.canonicalUrl, source);
    }
  }
  return [...unique.values()];
}

function evidenceRichness(source: Omit<LocalEvidenceItem, 'citationId'>): number {
  const structuredCompanyFields = source.title.endsWith('— structured company-size fields');
  return (structuredCompanyFields ? MAX_EXCERPT_LENGTH * 2 : 0) + source.excerpt.length;
}

export function validateAssessmentDraft(
  value: unknown,
  inventory: readonly Pick<LocalEvidenceItem, 'citationId'>[]
): LocalAssessmentDraft {
  const record = asRecord(value, 'Local assessment');
  const allowed = new Set(inventory.map((source) => source.citationId));
  if (allowed.size === 0 || allowed.size !== inventory.length) throw invalidModelResponse();
  const verdicts: Verdict[] = [
    'Supported',
    'Mostly supported',
    'Mixed',
    'Unsupported',
    'Unverifiable',
  ];
  const confidences: Confidence[] = ['Low', 'Medium', 'High'];
  const verdict = verdicts.includes(record.verdict as Verdict) ? (record.verdict as Verdict) : null;
  const confidence = confidences.includes(record.confidence as Confidence)
    ? (record.confidence as Confidence)
    : null;
  const conclusion = boundedText(record.conclusion, 280);
  const conclusionCitationIds = citationIds(record.conclusionCitationIds, allowed);
  const supports = citedStatementDrafts(record.supports, allowed);
  const contradictions = citedStatementDrafts(record.contradictions, allowed);
  const caveats = citedStatementDrafts(record.caveats, allowed);
  if (
    !verdict ||
    !confidence ||
    !conclusion ||
    conclusionCitationIds.length === 0 ||
    containsInlineCitationMarker(conclusion, allowed)
  ) {
    throw invalidModelResponse();
  }
  return {
    verdict,
    confidence,
    conclusion,
    conclusionCitationIds,
    supports,
    contradictions,
    caveats,
  };
}

function citedStatementDrafts(
  value: unknown,
  allowed: ReadonlySet<string>
): LocalFactCheckCitedStatement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw invalidModelResponse();
  return value.map((entry) => {
    const statement = optionalRecord(entry);
    const text = boundedText(statement?.text, 500);
    const statementCitationIds = citationIds(statement?.citationIds, allowed);
    if (
      !text ||
      Buffer.byteLength(text, 'utf8') > 500 ||
      containsInlineCitationMarker(text, allowed)
    ) {
      throw invalidModelResponse();
    }
    return { text, citationIds: statementCitationIds };
  });
}

function containsInlineCitationMarker(text: string, allowed: ReadonlySet<string>): boolean {
  if (/[【】]/u.test(text)) return true;
  return [...allowed].some((citationId) => text.includes(citationId));
}

function citationIds(value: unknown, allowed: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw invalidModelResponse();
  }
  const ids = value.map((id) => (typeof id === 'string' ? id : ''));
  if (new Set(ids).size !== ids.length || ids.some((id) => !allowed.has(id))) {
    throw invalidModelResponse();
  }
  return ids;
}

function uniqueStatements(
  statements: readonly LocalFactCheckCitedStatement[]
): LocalFactCheckCitedStatement[] {
  const unique = new Map<string, LocalFactCheckCitedStatement>();
  for (const statement of statements) {
    const key = `${statement.text}\u0000${statement.citationIds.join(',')}`;
    unique.set(key, statement);
  }
  return [...unique.values()].slice(0, 16);
}

function assessmentJsonSchema(
  inventory: readonly Pick<LocalEvidenceItem, 'citationId'>[]
): Record<string, unknown> {
  const citationIds = [...new Set(inventory.map((source) => source.citationId))];
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'confidence', 'conclusion', 'conclusionCitationIds'],
    properties: {
      verdict: {
        type: 'string',
        enum: ['Supported', 'Mostly supported', 'Mixed', 'Unsupported', 'Unverifiable'],
      },
      confidence: { type: 'string', enum: ['Low', 'Medium', 'High'] },
      conclusion: { type: 'string', minLength: 1, maxLength: 280 },
      conclusionCitationIds: {
        type: 'array',
        minItems: 1,
        maxItems: Math.min(4, citationIds.length),
        uniqueItems: true,
        items: { type: 'string', enum: citationIds },
      },
    },
  };
}

function conservativeAssessmentDraft(
  inventory: readonly Pick<LocalEvidenceItem, 'citationId'>[]
): LocalAssessmentDraft {
  return {
    verdict: 'Unverifiable',
    confidence: 'Low',
    conclusion:
      'The available secondary references do not establish a reliable finding for this claim.',
    conclusionCitationIds: inventory.slice(0, 4).map((source) => source.citationId),
    supports: [],
    contradictions: [],
    caveats: [],
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw localFactCheckError('A local research response exceeded the allowed size.');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw localFactCheckError('A local research response exceeded the allowed size.');
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw localFactCheckError('A local research provider returned an invalid response.');
  }
}

function assertAllowlistedRequest(url: URL): void {
  const allowed =
    (url.origin === 'http://127.0.0.1:11434' &&
      (url.pathname === '/api/tags' || url.pathname === '/api/chat')) ||
    (url.origin === 'https://en.wikipedia.org' && url.pathname === '/w/api.php') ||
    (url.origin === 'https://www.wikidata.org' && url.pathname === '/w/api.php');
  if (!allowed || url.username || url.password || url.hash) {
    throw localFactCheckError('Local research request was blocked by its source allowlist.');
  }
}

function minimalStoredRequest(request: FactCheckSubmitRequest): StoredFactCheckRequest {
  return {
    meetingId: request.meetingId,
    claimId: request.claimId,
    claimVersionId: request.claimVersionId,
    idempotencyKey: request.idempotencyKey,
    exactQuote: request.exactQuote,
    normalizedClaim: request.normalizedClaim,
    origin: request.origin,
  };
}

function assertIdempotentReplay(
  job: StoredLocalFactCheckJob,
  stage: FactCheckStage,
  request: StoredFactCheckRequest
): void {
  if (
    job.stage !== stage ||
    JSON.stringify(job.request) !== JSON.stringify(request) ||
    job.meetingId !== request.meetingId
  ) {
    throw localFactCheckError(
      'The local fact-check idempotency key was already used for different input.',
      'local_research_conflict'
    );
  }
}

function localJobId(meetingId: string, idempotencyKey: string): string {
  return `${LOCAL_FACT_CHECK_JOB_PREFIX}${createHash('sha256')
    .update(meetingId)
    .update('\u0000')
    .update(idempotencyKey)
    .digest('hex')
    .slice(0, 40)}`;
}

function publicJob(
  job: StoredLocalFactCheckJob
): GatewayJobResponse<LocalFactCheckAssessmentResult> {
  return {
    jobId: job.jobId,
    status: job.status,
    result: job.result,
    error: job.error,
    usage:
      job.status === 'complete'
        ? [
            {
              provider: job.result?.provenance.provider ?? 'unknown',
              model: job.result?.provenance.model ?? 'unknown',
              estimatedCostUsd: 0,
              provenance: job.result?.provenance.local ? 'local' : 'subscription',
            },
          ]
        : undefined,
  };
}

function parseStoredJob(value: unknown): StoredLocalFactCheckJob {
  const record = asRecord(value, 'Stored local fact-check job');
  if (
    record.version !== STORE_VERSION ||
    typeof record.jobId !== 'string' ||
    !isLocalFactCheckJobId(record.jobId) ||
    typeof record.meetingId !== 'string' ||
    (record.stage !== 'quick' && record.stage !== 'deep') ||
    !isGatewayJobStatus(record.status) ||
    typeof record.createdAtMs !== 'number' ||
    typeof record.updatedAtMs !== 'number'
  ) {
    throw localFactCheckError('Stored local fact-check job is invalid.');
  }
  const request = asRecord(record.request, 'Stored local fact-check request');
  if (
    request.meetingId !== record.meetingId ||
    typeof request.claimId !== 'string' ||
    typeof request.claimVersionId !== 'string' ||
    typeof request.idempotencyKey !== 'string' ||
    typeof request.exactQuote !== 'string' ||
    typeof request.normalizedClaim !== 'string' ||
    (request.origin !== 'automatic' && request.origin !== 'manual')
  ) {
    throw localFactCheckError('Stored local fact-check request is invalid.');
  }
  return record as unknown as StoredLocalFactCheckJob;
}

function isGatewayJobStatus(value: unknown): value is GatewayJobStatus {
  return ['pending', 'running', 'retry_wait', 'complete', 'failed', 'cancelled'].includes(
    value as GatewayJobStatus
  );
}

function isRunnable(status: GatewayJobStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'retry_wait';
}

function boundedClaim(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function wikipediaQueriesForClaim(value: string): string[] {
  const claim = boundedClaim(value);
  const comparison =
    /^(.{1,120}?)\s+(?:is|are|was|were)\s+.{1,120}?\bthan\s+(.{1,120}?)[.!?]?$/i.exec(claim);
  if (!comparison) return claim ? [claim] : [];
  const entities = [comparison[1], comparison[2]]
    .map((entity) =>
      entity
        ?.replace(/\b(and)\b/gi, '&')
        .replace(/[.!?]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((entity): entity is string => Boolean(entity));
  return [...new Set(entities.map((entity) => `${entity} company`.slice(0, 160)))];
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function latestQuantityFact(value: unknown, label: string): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const candidates = value.flatMap((statement) => {
    const record = optionalRecord(statement);
    if (record?.rank === 'deprecated') return [];
    const mainsnak = optionalRecord(record?.mainsnak);
    const dataValue = optionalRecord(mainsnak?.datavalue);
    const quantity = optionalRecord(dataValue?.value);
    if (dataValue?.type !== 'quantity' || typeof quantity?.amount !== 'string') return [];
    const amount = Number(quantity.amount);
    if (!Number.isFinite(amount) || amount < 0) return [];
    const unit = quantity.unit;
    if (unit !== '1' && unit !== 'http://www.wikidata.org/entity/Q4917') return [];
    const qualifiers = optionalRecord(record?.qualifiers);
    const pointInTime = Array.isArray(qualifiers?.P585)
      ? optionalRecord(optionalRecord(qualifiers.P585[0])?.datavalue)?.value
      : undefined;
    const time = optionalRecord(pointInTime)?.time;
    const year =
      typeof time === 'string' && /^\+[0-9]{4}-/.test(time) ? Number(time.slice(1, 5)) : undefined;
    return [
      {
        amount,
        unit: unit as '1' | 'http://www.wikidata.org/entity/Q4917',
        year,
        preferred: record?.rank === 'preferred',
      },
    ];
  });
  candidates.sort((left, right) => {
    if (left.preferred !== right.preferred) return left.preferred ? -1 : 1;
    return (right.year ?? -1) - (left.year ?? -1);
  });
  const latest = candidates[0];
  if (!latest) return undefined;
  const amount =
    latest.unit === '1'
      ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(latest.amount)
      : new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          notation: latest.amount >= 1_000_000_000 ? 'compact' : 'standard',
          maximumFractionDigits: 3,
        }).format(latest.amount);
  const date = latest.year ? String(latest.year) : 'date not supplied';
  const rank = latest.preferred ? ', Wikidata preferred statement' : '';
  return `${label} ${amount} (${date}${rank})`;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) throw localFactCheckError(`${name} is invalid.`);
  return record;
}

function invalidModelResponse(): Error {
  return localFactCheckError(
    'The local research model returned claims or citations that could not be validated.',
    'invalid_local_research_response'
  );
}

function claimDetectionRequestFingerprint(request: ClaimDetectionRequest): string {
  const turnFingerprint = (turn: ClaimDetectionRequest['turns'][number]) => ({
    id: turn.id,
    speakerId: turn.speakerId,
    sourceKind: turn.sourceKind ?? null,
    startMs: turn.startMs,
    endMs: turn.endMs,
    text: turn.text,
  });
  return createHash('sha256')
    .update(
      JSON.stringify({
        turns: request.turns.map(turnFingerprint),
        contextTurns: request.contextTurns?.map(turnFingerprint) ?? null,
        requiredTurnIds: request.requiredTurnIds ?? null,
      })
    )
    .digest('hex');
}

function isInvalidModelResponse(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'invalid_local_research_response'
  );
}

function localFactCheckError(
  message: string,
  code = 'local_research_unavailable',
  retryable = false
): Error {
  return Object.assign(new Error(message), { code, retryable });
}

function normalizeLocalError(error: unknown): LiveCaptureError {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (
      typeof candidate.code === 'string' &&
      typeof candidate.message === 'string' &&
      typeof candidate.retryable === 'boolean'
    ) {
      return {
        code: candidate.code,
        message: candidate.message.slice(0, 1_000),
        retryable: candidate.retryable,
      };
    }
  }
  return {
    code: 'local_research_failed',
    message: 'Fact-checking could not complete against the retrieved evidence inventory.',
    retryable: true,
  };
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isSafeMeetingId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) && value !== '.' && value !== '..';
}

function assertSafeMeetingId(value: string): void {
  if (!isSafeMeetingId(value)) throw localFactCheckError('Local meeting ID is invalid.');
}
