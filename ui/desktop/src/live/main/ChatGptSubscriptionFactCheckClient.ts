import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const PROTOCOL_VERSION = 1;
const WORKER_ARGUMENT = 'live-fact-check-model';
const MAX_REQUEST_BYTES = 128 * 1_024;
const MAX_STDOUT_BYTES = 256 * 1_024;
const MAX_STDERR_BYTES = 64 * 1_024;
const SUPPORT_TIMEOUT_MS = 5_000;
const CLAIM_DETECTION_TIMEOUT_MS = 12_000;
const QUICK_TIMEOUT_MS = 40_000;
const DEEP_TIMEOUT_MS = 75_000;
const MAX_CLAIM_DETECTION_TURNS = 12;
const MAX_CLAIM_DETECTION_TURN_BYTES = 2_000;
const MAX_CLAIM_DETECTION_TRANSCRIPT_BYTES = 12_000;
const MAX_EXISTING_CLAIM_KEYS = 50;
const MAX_EXISTING_CLAIM_KEY_BYTES = 256;
const MAX_CLAIM_CANDIDATES = 4;
const MAX_CANDIDATE_SEGMENTS = 4;
const MAX_IDENTIFIER_BYTES = 80;
const MAX_EXACT_QUOTE_BYTES = 4_000;
const MAX_NORMALIZED_CLAIM_BYTES = 2_000;
const MAX_SELECTION_RATIONALE_BYTES = 500;

type FactCheckAbortSignal = InstanceType<typeof globalThis.AbortSignal>;
type FactCheckWorkerEnvironment = Record<string, string | undefined>;

type FactCheckStage = 'quick' | 'deep';
type Verdict = 'Supported' | 'Mostly supported' | 'Mixed' | 'Unsupported' | 'Unverifiable';
type Confidence = 'Low' | 'Medium' | 'High';

export interface ChatGptFactCheckEvidence {
  citationId: string;
  publisher: string;
  title: string;
  publicationDate: string | null;
  excerpt: string;
  retrievalKind: 'search_snippet' | 'page_extract';
}

export interface ChatGptFactCheckCitedStatement {
  text: string;
  citationIds: string[];
}

export interface ChatGptFactCheckRequest {
  stage: FactCheckStage;
  normalizedClaim: string;
  exactQuote: string;
  evidence: ChatGptFactCheckEvidence[];
}

export interface ChatGptFactCheckResult {
  verdict: Verdict;
  confidence: Confidence;
  conclusion: string;
  conclusionCitationIds: string[];
  supports: ChatGptFactCheckCitedStatement[];
  contradictions: ChatGptFactCheckCitedStatement[];
  caveats: ChatGptFactCheckCitedStatement[];
  provider: 'chatgpt_codex';
  model: string;
}

export interface ChatGptFactCheckSupport {
  available: boolean;
  provider: 'chatgpt_codex';
  model: string;
  reason?: string;
}

export interface ChatGptClaimDetectionTurn {
  id: string;
  speakerId: string | null;
  startMs: number;
  endMs: number;
  text: string;
  sourceKind?: 'microphone' | 'system' | 'mixed';
}

export interface ChatGptClaimDetectionRequest {
  turns: ChatGptClaimDetectionTurn[];
  requiredTurnIds: string[];
  existingClaimKeys: string[];
}

export interface ChatGptClaimDetectionCandidate {
  exactQuote: string;
  normalizedClaim: string;
  segmentIds: string[];
  checkworthy: boolean;
  consequenceScore: number;
  disputeLikelihoodScore: number;
  specificityScore: number;
  timeSensitive: boolean;
  selectionRationale: string;
}

export interface ChatGptClaimDetectionResult {
  candidates: ChatGptClaimDetectionCandidate[];
  provider: 'chatgpt_codex';
  model: string;
}

export interface ChatGptFactCheckModelClient {
  checkSupport(): Promise<ChatGptFactCheckSupport>;
  synthesize(
    request: ChatGptFactCheckRequest,
    signal?: FactCheckAbortSignal
  ): Promise<ChatGptFactCheckResult>;
  dispose?(): void;
}

export interface ChatGptClaimDetectionModelClient {
  detectClaims(
    request: ChatGptClaimDetectionRequest,
    signal?: FactCheckAbortSignal
  ): Promise<ChatGptClaimDetectionResult>;
  dispose?(): void;
}

interface WorkerError {
  code: string;
  message: string;
  retryable: boolean;
}

interface WorkerEnvelope {
  protocolVersion?: unknown;
  requestId?: unknown;
  ok?: unknown;
  support?: unknown;
  claimDetection?: unknown;
  result?: unknown;
  error?: unknown;
}

type SpawnWorker = (
  command: string,
  args: readonly string[],
  options: { env: FactCheckWorkerEnvironment; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true }
) => ChildProcessWithoutNullStreams;

export interface ChatGptSubscriptionFactCheckClientOptions {
  gooseBinaryPath: string;
  spawnWorker?: SpawnWorker;
  environment?: FactCheckWorkerEnvironment;
}

export class ChatGptSubscriptionFactCheckClient
  implements ChatGptFactCheckModelClient, ChatGptClaimDetectionModelClient
{
  private readonly spawnWorker: SpawnWorker;
  private readonly environment: FactCheckWorkerEnvironment;
  private readonly activeWorkers = new Map<ChildProcessWithoutNullStreams, () => void>();
  private disposed = false;

  constructor(private readonly options: ChatGptSubscriptionFactCheckClientOptions) {
    this.spawnWorker = options.spawnWorker ?? spawn;
    this.environment = options.environment ?? factCheckWorkerEnvironment(process.env);
  }

  async checkSupport(): Promise<ChatGptFactCheckSupport> {
    const requestId = workerRequestId('support');
    const envelope = await this.runWorker(
      { protocolVersion: PROTOCOL_VERSION, requestId, operation: 'support' },
      requestId,
      SUPPORT_TIMEOUT_MS
    );
    if (!envelope.ok) throw workerFailure(envelope.error);
    return parseSupport(envelope.support);
  }

  async synthesize(
    request: ChatGptFactCheckRequest,
    signal?: FactCheckAbortSignal
  ): Promise<ChatGptFactCheckResult> {
    const requestId = workerRequestId('fact');
    const envelope = await this.runWorker(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        operation: 'synthesize',
        request,
      },
      requestId,
      request.stage === 'quick' ? QUICK_TIMEOUT_MS : DEEP_TIMEOUT_MS,
      signal
    );
    if (!envelope.ok) throw workerFailure(envelope.error);
    return parseResult(
      envelope.result,
      new Set(request.evidence.map((item) => item.citationId)),
      request.stage
    );
  }

  async detectClaims(
    request: ChatGptClaimDetectionRequest,
    signal?: FactCheckAbortSignal
  ): Promise<ChatGptClaimDetectionResult> {
    const validatedRequest = validateClaimDetectionRequest(request);
    const requestId = workerRequestId('claims');
    const envelope = await this.runWorker(
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        operation: 'detect_claims',
        request: validatedRequest,
      },
      requestId,
      CLAIM_DETECTION_TIMEOUT_MS,
      signal
    );
    if (!envelope.ok) throw workerFailure(envelope.error);
    return parseClaimDetection(
      envelope.claimDetection,
      validatedRequest.turns,
      new Set(validatedRequest.requiredTurnIds),
      new Set(validatedRequest.existingClaimKeys.map(normalizedDetectionText))
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancel of [...this.activeWorkers.values()]) cancel();
  }

  private runWorker(
    request: Record<string, unknown>,
    requestId: string,
    timeoutMs: number,
    signal?: FactCheckAbortSignal
  ): Promise<WorkerEnvelope> {
    if (this.disposed || signal?.aborted) {
      return Promise.reject(
        factCheckWorkerError('The ChatGPT fact-check was cancelled.', 'chatgpt_cancelled', false)
      );
    }
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
      return Promise.reject(
        factCheckWorkerError('The ChatGPT fact-check request was too large.', 'invalid_request')
      );
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnWorker(this.options.gooseBinaryPath, [WORKER_ARGUMENT], {
          env: this.environment,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        reject(
          factCheckWorkerError(
            'Obelus could not start its ChatGPT fact-check worker.',
            'chatgpt_worker_unavailable',
            true
          )
        );
        return;
      }

      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let forcedKill: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cancelled = () => {
        if (settled) return;
        terminate();
        finish(
          factCheckWorkerError('The ChatGPT fact-check was cancelled.', 'chatgpt_cancelled', false)
        );
      };

      const finish = (error?: Error, envelope?: WorkerEnvelope) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', cancelled);
        if (error) reject(error);
        else resolve(envelope!);
      };

      const terminate = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        forcedKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 1_000);
        forcedKill.unref?.();
      };

      timeout = setTimeout(() => {
        terminate();
        finish(
          factCheckWorkerError(
            'ChatGPT took too long to complete this fact-check.',
            'chatgpt_timeout',
            true
          )
        );
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          terminate();
          finish(factCheckWorkerError('The ChatGPT worker response was too large.'));
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_STDERR_BYTES) {
          terminate();
          finish(factCheckWorkerError('The ChatGPT worker emitted too much diagnostic output.'));
        }
      });
      child.once('error', () => {
        this.activeWorkers.delete(child);
        if (forcedKill) clearTimeout(forcedKill);
        finish(
          factCheckWorkerError(
            'Obelus could not start its ChatGPT fact-check worker.',
            'chatgpt_worker_unavailable',
            true
          )
        );
      });
      child.once('close', (code) => {
        this.activeWorkers.delete(child);
        if (forcedKill) clearTimeout(forcedKill);
        if (settled) return;
        if (code !== 0) {
          finish(
            factCheckWorkerError(
              'The ChatGPT fact-check worker stopped unexpectedly.',
              'chatgpt_worker_failed',
              true
            )
          );
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8').trim()) as unknown;
          const envelope = parseEnvelope(parsed, requestId);
          finish(undefined, envelope);
        } catch {
          finish(factCheckWorkerError('The ChatGPT fact-check worker returned invalid data.'));
        }
      });
      child.stdin.once('error', () => {
        terminate();
        finish(
          factCheckWorkerError(
            'Obelus could not send work to its ChatGPT fact-check worker.',
            'chatgpt_worker_failed',
            true
          )
        );
      });
      this.activeWorkers.set(child, cancelled);
      signal?.addEventListener('abort', cancelled, { once: true });
      if (this.disposed || signal?.aborted) {
        cancelled();
        return;
      }
      child.stdin.end(`${serialized}\n`);
    });
  }
}

function parseEnvelope(value: unknown, requestId: string): WorkerEnvelope {
  const envelope = asRecord(value) as WorkerEnvelope | undefined;
  if (
    !envelope ||
    envelope.protocolVersion !== PROTOCOL_VERSION ||
    envelope.requestId !== requestId ||
    typeof envelope.ok !== 'boolean'
  ) {
    throw new Error('invalid envelope');
  }
  if (envelope.ok) {
    if (envelope.error !== undefined) throw new Error('unexpected error');
  } else if (!validWorkerError(envelope.error)) {
    throw new Error('invalid worker error');
  }
  return envelope;
}

function parseSupport(value: unknown): ChatGptFactCheckSupport {
  const support = asRecord(value);
  if (
    !support ||
    typeof support.available !== 'boolean' ||
    support.provider !== 'chatgpt_codex' ||
    typeof support.model !== 'string' ||
    !support.model.trim() ||
    (support.reason !== undefined && typeof support.reason !== 'string')
  ) {
    throw factCheckWorkerError('The ChatGPT fact-check worker returned invalid support data.');
  }
  return {
    available: support.available,
    provider: 'chatgpt_codex',
    model: support.model,
    reason: typeof support.reason === 'string' ? support.reason.slice(0, 1_000) : undefined,
  };
}

function validateClaimDetectionRequest(value: unknown): ChatGptClaimDetectionRequest {
  const request = asRecord(value);
  if (
    !request ||
    !Array.isArray(request.turns) ||
    request.turns.length === 0 ||
    request.turns.length > MAX_CLAIM_DETECTION_TURNS ||
    !Array.isArray(request.requiredTurnIds) ||
    request.requiredTurnIds.length === 0 ||
    request.requiredTurnIds.length > MAX_CLAIM_DETECTION_TURNS ||
    !Array.isArray(request.existingClaimKeys) ||
    request.existingClaimKeys.length > MAX_EXISTING_CLAIM_KEYS
  ) {
    throw invalidClaimDetectionRequest();
  }

  let transcriptBytes = 0;
  const seenTurnIds = new Set<string>();
  const turns = request.turns.map((value) => {
    const turn = asRecord(value);
    if (
      !turn ||
      !isValidIdentifier(turn.id) ||
      seenTurnIds.has(turn.id) ||
      (turn.speakerId !== null && !isValidIdentifier(turn.speakerId)) ||
      !Number.isSafeInteger(turn.startMs) ||
      !Number.isSafeInteger(turn.endMs) ||
      (turn.startMs as number) < 0 ||
      (turn.endMs as number) < (turn.startMs as number) ||
      !isBoundedNonEmptyString(turn.text, MAX_CLAIM_DETECTION_TURN_BYTES) ||
      (turn.sourceKind !== undefined &&
        turn.sourceKind !== 'microphone' &&
        turn.sourceKind !== 'system' &&
        turn.sourceKind !== 'mixed')
    ) {
      throw invalidClaimDetectionRequest();
    }
    seenTurnIds.add(turn.id);
    transcriptBytes += Buffer.byteLength(turn.text, 'utf8');
    return {
      id: turn.id,
      speakerId: turn.speakerId,
      startMs: turn.startMs,
      endMs: turn.endMs,
      text: turn.text,
      ...(turn.sourceKind === undefined ? {} : { sourceKind: turn.sourceKind }),
    } as ChatGptClaimDetectionTurn;
  });
  if (transcriptBytes > MAX_CLAIM_DETECTION_TRANSCRIPT_BYTES) {
    throw invalidClaimDetectionRequest();
  }

  const requiredTurnIds = parseUniqueBoundedStrings(
    request.requiredTurnIds,
    MAX_CLAIM_DETECTION_TURNS,
    MAX_IDENTIFIER_BYTES
  );
  if (requiredTurnIds.some((id) => !seenTurnIds.has(id))) {
    throw invalidClaimDetectionRequest();
  }
  const existingClaimKeys = parseUniqueBoundedStrings(
    request.existingClaimKeys,
    MAX_EXISTING_CLAIM_KEYS,
    MAX_EXISTING_CLAIM_KEY_BYTES
  );
  return { turns, requiredTurnIds, existingClaimKeys };
}

function parseClaimDetection(
  value: unknown,
  turns: readonly ChatGptClaimDetectionTurn[],
  requiredTurnIds: ReadonlySet<string>,
  existingClaimKeys: ReadonlySet<string>
): ChatGptClaimDetectionResult {
  const detection = asRecord(value);
  if (
    !detection ||
    !Array.isArray(detection.candidates) ||
    detection.candidates.length > MAX_CLAIM_CANDIDATES
  ) {
    throw invalidClaimDetectionResponse();
  }

  const turnIndex = new Map(turns.map((turn, index) => [turn.id, index]));
  if (
    detection.provider !== 'chatgpt_codex' ||
    !isBoundedNonEmptyString(detection.model, MAX_IDENTIFIER_BYTES)
  ) {
    throw invalidClaimDetectionResponse();
  }

  const normalizedClaims = new Set<string>();
  const exactQuotes = new Set<string>();
  const candidates = detection.candidates.map((value) => {
    const candidate = asRecord(value);
    if (
      !candidate ||
      !isBoundedNonEmptyString(candidate.exactQuote, MAX_EXACT_QUOTE_BYTES) ||
      !isBoundedNonEmptyString(candidate.normalizedClaim, MAX_NORMALIZED_CLAIM_BYTES) ||
      !Array.isArray(candidate.segmentIds) ||
      candidate.segmentIds.length === 0 ||
      candidate.segmentIds.length > MAX_CANDIDATE_SEGMENTS ||
      candidate.exactQuote.trim() !== candidate.exactQuote ||
      candidate.normalizedClaim.trim() !== candidate.normalizedClaim ||
      candidate.checkworthy !== true ||
      !hasAcceptedClaimScores(
        candidate.consequenceScore,
        candidate.disputeLikelihoodScore,
        candidate.specificityScore
      ) ||
      typeof candidate.timeSensitive !== 'boolean' ||
      !isBoundedNonEmptyString(candidate.selectionRationale, MAX_SELECTION_RATIONALE_BYTES) ||
      candidate.selectionRationale.trim() !== candidate.selectionRationale
    ) {
      throw invalidClaimDetectionResponse();
    }

    const segmentIds = parseUniqueBoundedStrings(
      candidate.segmentIds,
      MAX_CANDIDATE_SEGMENTS,
      MAX_IDENTIFIER_BYTES,
      invalidClaimDetectionResponse
    );
    const indexes = segmentIds.map((id) => turnIndex.get(id));
    const normalizedClaim = normalizedDetectionText(candidate.normalizedClaim);
    const exactQuote = normalizedDetectionText(candidate.exactQuote);
    if (
      indexes.some((index) => index === undefined) ||
      indexes.some((index, position) => position > 0 && index !== indexes[position - 1]! + 1) ||
      !segmentIds.some((id) => requiredTurnIds.has(id)) ||
      existingClaimKeys.has(normalizedClaim) ||
      normalizedClaims.has(normalizedClaim) ||
      exactQuotes.has(exactQuote)
    ) {
      throw invalidClaimDetectionResponse();
    }
    const citedTurns = indexes.map((index) => turns[index!]!);
    const distinctSpeakers = new Set(
      citedTurns.map((turn) => turn.speakerId).filter((speakerId) => speakerId !== null)
    );
    const distinctSourceKinds = new Set(
      citedTurns.map((turn) => turn.sourceKind).filter((sourceKind) => sourceKind !== undefined)
    );
    if (
      distinctSpeakers.size > 1 ||
      distinctSourceKinds.size > 1 ||
      citedTurns.some(
        (turn, index) => index > 0 && turn.startMs - citedTurns[index - 1]!.endMs > 2_500
      ) ||
      !quoteIsBackedByEveryTurn(candidate.exactQuote, citedTurns)
    ) {
      throw invalidClaimDetectionResponse();
    }
    normalizedClaims.add(normalizedClaim);
    exactQuotes.add(exactQuote);

    return {
      exactQuote: candidate.exactQuote,
      normalizedClaim: candidate.normalizedClaim,
      segmentIds,
      checkworthy: candidate.checkworthy,
      consequenceScore: candidate.consequenceScore,
      disputeLikelihoodScore: candidate.disputeLikelihoodScore,
      specificityScore: candidate.specificityScore,
      timeSensitive: candidate.timeSensitive,
      selectionRationale: candidate.selectionRationale,
    } as ChatGptClaimDetectionCandidate;
  });
  return {
    candidates,
    provider: 'chatgpt_codex',
    model: detection.model,
  };
}

function parseUniqueBoundedStrings(
  value: unknown[],
  maximumItems: number,
  maximumBytes: number,
  error: () => Error = invalidClaimDetectionRequest
): string[] {
  if (
    value.length > maximumItems ||
    value.some((item) => !isBoundedNonEmptyString(item, maximumBytes))
  ) {
    throw error();
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) throw error();
  return [...strings];
}

function isBoundedNonEmptyString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
  );
}

function isValidIdentifier(value: unknown): value is string {
  return isBoundedNonEmptyString(value, MAX_IDENTIFIER_BYTES) && /^[A-Za-z0-9_-]+$/u.test(value);
}

function quoteIsBackedByEveryTurn(
  quote: string,
  turns: readonly ChatGptClaimDetectionTurn[]
): boolean {
  const { text, ranges } = joinOverlappingClaimDetectionTurns(turns);
  let matchStart = text.indexOf(quote);
  while (matchStart >= 0) {
    const matchEnd = matchStart + quote.length;
    if (ranges.every((range) => matchStart < range.end && matchEnd > range.start)) return true;
    matchStart = text.indexOf(quote, matchStart + 1);
  }
  return false;
}

function joinOverlappingClaimDetectionTurns(turns: readonly ChatGptClaimDetectionTurn[]): {
  text: string;
  ranges: Array<{ start: number; end: number }>;
} {
  let text = '';
  const ranges: Array<{ start: number; end: number }> = [];
  for (const turn of turns) {
    const next = turn.text.trim().split(/\s+/u).join(' ');
    const previousTokens = tokenSpans(text);
    const nextTokens = tokenSpans(next);
    const overlap = longestTokenOverlap(previousTokens, nextTokens);
    if (overlap === 0) {
      if (text) text += ' ';
      const start = text.length;
      text += next;
      ranges.push({ start, end: text.length });
      continue;
    }

    const start = previousTokens[previousTokens.length - overlap]!.start;
    const remainder = next.slice(nextTokens[overlap - 1]!.end).trimStart();
    if (remainder) text += ` ${remainder}`;
    ranges.push({ start, end: text.length });
  }
  return { text, ranges };
}

interface TokenSpan {
  normalized: string;
  start: number;
  end: number;
}

function tokenSpans(value: string): TokenSpan[] {
  return [...value.matchAll(/\S+/gu)].map((match) => ({
    normalized: normalizedOverlapToken(match[0]),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function normalizedOverlapToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}&]+/gu, '');
}

function longestTokenOverlap(previous: readonly TokenSpan[], next: readonly TokenSpan[]): number {
  for (let size = Math.min(8, previous.length, next.length); size > 0; size -= 1) {
    const previousStart = previous.length - size;
    if (
      next
        .slice(0, size)
        .every(
          (token, index) =>
            token.normalized && token.normalized === previous[previousStart + index]!.normalized
        )
    ) {
      return size;
    }
  }
  return 0;
}

function hasAcceptedClaimScores(
  consequence: unknown,
  disputeLikelihood: unknown,
  specificity: unknown
): boolean {
  return (
    isUnitScore(consequence) &&
    isUnitScore(disputeLikelihood) &&
    isUnitScore(specificity) &&
    specificity >= 0.5 &&
    (consequence >= 0.45 || disputeLikelihood >= 0.55)
  );
}

function normalizedDetectionText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function isUnitScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function invalidClaimDetectionRequest(): Error {
  return factCheckWorkerError(
    'The ChatGPT claim detection request could not be validated.',
    'invalid_request'
  );
}

function invalidClaimDetectionResponse(): Error {
  return factCheckWorkerError(
    'ChatGPT returned claim detection data that could not be validated.',
    'invalid_chatgpt_claim_detection_response',
    true
  );
}

function parseResult(
  value: unknown,
  allowedCitations: ReadonlySet<string>,
  stage: FactCheckStage
): ChatGptFactCheckResult {
  const result = asRecord(value);
  const verdicts = new Set<Verdict>([
    'Supported',
    'Mostly supported',
    'Mixed',
    'Unsupported',
    'Unverifiable',
  ]);
  const confidences = new Set<Confidence>(['Low', 'Medium', 'High']);
  const citations = Array.isArray(result?.conclusionCitationIds)
    ? result.conclusionCitationIds
    : [];
  const supports = parseCitedStatements(result?.supports, allowedCitations);
  const contradictions = parseCitedStatements(result?.contradictions, allowedCitations);
  const caveats = parseCitedStatements(result?.caveats, allowedCitations);
  const sectionCount = supports.length + contradictions.length + caveats.length;
  const sectionTextBytes = [...supports, ...contradictions, ...caveats].reduce(
    (total, statement) => total + Buffer.byteLength(statement.text, 'utf8'),
    0
  );
  if (
    !result ||
    !verdicts.has(result.verdict as Verdict) ||
    !confidences.has(result.confidence as Confidence) ||
    typeof result.conclusion !== 'string' ||
    !result.conclusion.trim() ||
    result.conclusion.length > 280 ||
    containsInlineCitationMarker(result.conclusion, allowedCitations) ||
    result.provider !== 'chatgpt_codex' ||
    typeof result.model !== 'string' ||
    !result.model.trim() ||
    citations.length === 0 ||
    citations.length > 4 ||
    citations.some((citation) => typeof citation !== 'string' || !allowedCitations.has(citation)) ||
    new Set(citations).size !== citations.length ||
    sectionCount > 8 ||
    sectionTextBytes > 2_400 ||
    (stage === 'quick' && sectionCount !== 0) ||
    (stage === 'deep' && sectionCount === 0)
  ) {
    throw factCheckWorkerError('ChatGPT returned a fact-check result that could not be validated.');
  }
  return {
    verdict: result.verdict as Verdict,
    confidence: result.confidence as Confidence,
    conclusion: result.conclusion,
    conclusionCitationIds: citations as string[],
    supports,
    contradictions,
    caveats,
    provider: 'chatgpt_codex',
    model: result.model,
  };
}

function parseCitedStatements(
  value: unknown,
  allowedCitations: ReadonlySet<string>
): ChatGptFactCheckCitedStatement[] {
  if (!Array.isArray(value) || value.length > 4) {
    throw factCheckWorkerError('ChatGPT returned a fact-check result that could not be validated.');
  }
  return value.map((entry) => {
    const statement = asRecord(entry);
    const citations = Array.isArray(statement?.citationIds) ? statement.citationIds : [];
    if (
      !statement ||
      typeof statement.text !== 'string' ||
      !statement.text.trim() ||
      Buffer.byteLength(statement.text, 'utf8') > 500 ||
      containsInlineCitationMarker(statement.text, allowedCitations) ||
      citations.length === 0 ||
      citations.length > 4 ||
      citations.some(
        (citation) => typeof citation !== 'string' || !allowedCitations.has(citation)
      ) ||
      new Set(citations).size !== citations.length
    ) {
      throw factCheckWorkerError(
        'ChatGPT returned a fact-check result that could not be validated.'
      );
    }
    return { text: statement.text, citationIds: citations as string[] };
  });
}

function containsInlineCitationMarker(
  text: string,
  allowedCitations: ReadonlySet<string>
): boolean {
  if (/[【】]/u.test(text)) return true;
  return [...allowedCitations].some((citationId) => text.includes(citationId));
}

function validWorkerError(value: unknown): value is WorkerError {
  const error = asRecord(value);
  return Boolean(
    error &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    typeof error.retryable === 'boolean'
  );
}

function workerFailure(value: unknown): Error {
  if (!validWorkerError(value)) {
    return factCheckWorkerError('The ChatGPT fact-check worker returned an invalid error.');
  }
  return factCheckWorkerError(value.message.slice(0, 1_000), value.code, value.retryable);
}

function factCheckWorkerError(
  message: string,
  code = 'invalid_chatgpt_fact_check_response',
  retryable = false
): Error {
  return Object.assign(new Error(message), { code, retryable });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function workerRequestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function factCheckWorkerEnvironment(
  source: FactCheckWorkerEnvironment
): FactCheckWorkerEnvironment {
  const environment: FactCheckWorkerEnvironment = {
    GOOSE_TELEMETRY_OFF: 'true',
    RUST_LOG: 'error',
  };
  for (const name of [
    'HOME',
    'USERPROFILE',
    'PATH',
    'Path',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'GOOSE_PATH_ROOT',
    'GOOSE_KEYRING_SERVICE',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    if (source[name]) environment[name] = source[name];
  }
  return environment;
}
