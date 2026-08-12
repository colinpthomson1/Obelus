import {
  stableLiveUuid,
  type Claim,
  type ClaimGateTurnSnapshot,
  type TranscriptTurn,
} from './types';

export interface ClaimCandidate {
  exactQuote: string;
  normalizedClaim: string;
  contextTurnIds: string[];
  speakerId?: string;
  startMs: number;
  endMs: number;
  checkworthy: boolean;
  consequenceScore: number;
  disputeLikelihoodScore: number;
  specificityScore: number;
  timeSensitive: boolean;
  selectionRationale: string;
  semanticDuplicateKey: string;
}

export interface ClaimGateBatch {
  id: string;
  meetingId: string;
  idempotencyKey: string;
  turns: ClaimGateTurnSnapshot[];
}

export interface ClaimDetectionBatch extends ClaimGateBatch {
  existingClaims: Array<{
    duplicateKey: string;
    normalizedClaim: string;
  }>;
}

export interface ClaimSchedulerCallbacks {
  beginBatch: (batch: ClaimGateBatch) => Promise<void>;
  detect: (batch: ClaimDetectionBatch) => Promise<ClaimCandidate[] | ClaimDetectionResult>;
  commitBatch: (batch: ClaimGateBatch, candidates: ClaimCandidate[]) => Promise<void>;
  onBackpressure: (active: boolean, reason?: 'gateway' | 'limit') => void;
}

export interface ClaimDetectionResult {
  candidates: ClaimCandidate[];
  source: 'remote' | 'local';
  countAgainstRemoteBudget: boolean;
  gatewayCatchingUp?: boolean;
}

interface RemoteClaimDetectionResult {
  candidates: ClaimCandidate[];
  catchingUp: boolean;
}

export interface ClaimSchedulerOptions {
  maxGateCallsPerHour: number;
  maxAcceptedClaimsPerHour: number;
  maxBurstClaims: number;
  burstWindowMs: number;
  minBatchDelayMs: number;
  maxTurnsPerBatch: number;
}

interface ScheduledClaimGateBatch extends ClaimGateBatch {
  begun: boolean;
}

export const gatewayClaimSchedulerOptions: ClaimSchedulerOptions = {
  maxGateCallsPerHour: 30,
  maxAcceptedClaimsPerHour: 10,
  maxBurstClaims: 2,
  burstWindowMs: 60_000,
  minBatchDelayMs: 1_500,
  maxTurnsPerBatch: 4,
};

export const subscriptionClaimSchedulerOptions: ClaimSchedulerOptions = {
  ...gatewayClaimSchedulerOptions,
  maxGateCallsPerHour: 1_200,
};

const maxCompletedTurnRevisions = 10_000;
const maxReconstructedTurnChain = 3;
const maxReconstructedCharacters = 1_000;
const highTokenOverlapThreshold = 0.8;

function normalized(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}%$.-]+/gu, ' ')
    .trim();
}

const claimComparisonPattern =
  /\b(?:than|versus|compared (?:with|to)|largest|biggest|smallest|highest|lowest|best|worst)\b/i;
const claimQuantityPattern = /(?:\b\d[\d,.]*\b|\b\d+(?:\.\d+)?\s*%|[$€£¥]\s*\d)/;
const claimAssertionPattern =
  /\b(?:is|are|was|were|has|have|had|will|owns?|employs?|serves?|costs?|reached|grew|increased|decreased|fell|rose)\b/i;
const audioCalibrationPattern =
  /^(?:(?:(?:audio|mic|microphone)\s+(?:check|test))|test|testing)(?:[\s,:-]+(?:\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten))*[.!?]*$/i;
const sentenceBoundaryPattern = /[.!?]["')\]]?$/;
const nonEntityWords = new Set([
  'A',
  'An',
  'He',
  'I',
  'In',
  'It',
  'She',
  'So',
  'That',
  'The',
  'These',
  'They',
  'This',
  'Those',
  'We',
]);

interface ReconstructedClaimStatement {
  text: string;
  turns: ClaimGateTurnSnapshot[];
}

interface ComparisonParts {
  subject: string[];
  relation: string[];
  object: string[];
}

function orderedTurns(turns: readonly ClaimGateTurnSnapshot[]): ClaimGateTurnSnapshot[] {
  return [...new Map(turns.map((turn) => [turn.id, turn])).values()].sort((left, right) => {
    if (left.startMs !== right.startMs) return left.startMs - right.startMs;
    if (left.endMs !== right.endMs) return left.endMs - right.endMs;
    return left.id.localeCompare(right.id);
  });
}

function fragmentsAreAdjacent(left: ClaimGateTurnSnapshot, right: ClaimGateTurnSnapshot): boolean {
  if (sentenceBoundaryPattern.test(left.text.trim())) return false;
  if (right.startMs - left.endMs > 2_500) return false;
  if (left.sourceKind !== right.sourceKind) return false;
  if (left.speakerId && right.speakerId && left.speakerId !== right.speakerId) return false;
  return true;
}

function boundaryToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}&]+/gu, '');
}

function normalizedTokens(value: string): string[] {
  return normalized(value)
    .split(/\s+/u)
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ''))
    .filter(Boolean);
}

const capitalizedEntityWord = String.raw`[\p{Lu}][\p{L}\p{N}'’.-]*`;
const capitalizedEntity = String.raw`${capitalizedEntityWord}(?:\s+(?:(?:&|and|of|the)\s+)?${capitalizedEntityWord}){0,5}`;
const leftEntityPattern = new RegExp(`(${capitalizedEntity})\\s*$`, 'u');
const rightEntityPattern = new RegExp(`^\\s*(?:(?:[Tt]he|[Aa]n?)\\s+)?(${capitalizedEntity})`, 'u');
const comparisonMarkerPattern = /\b(?:than|versus|compared (?:with|to))\b/i;
const comparisonAssertionPattern = /\b(?:is|are|was|were|has|have|had)\b/gi;
const reconstructedStatementBoundaryPattern = new RegExp(
  String.raw`(?<=[.!?])\s+|[,;]\s+(?=${capitalizedEntity}\s+(?:is|are|was|were|has|have|had)\b[^.!?]{0,240}\b(?:than|versus|compared (?:with|to))\b)`,
  'gu'
);
const comparisonRightHandSideFillers = new Set(['a', 'an', 'the']);
const comparisonLeftHandSideFillers = new Set([
  'a',
  'an',
  'he',
  'i',
  'it',
  'she',
  'that',
  'the',
  'these',
  'they',
  'this',
  'those',
  'we',
]);

function hasConcreteComparisonRightHandSide(value: string): boolean {
  const markers = [...value.matchAll(/\b(?:than|versus|compared (?:with|to))\b/gi)];
  return markers.every((marker) => {
    const markerEnd = (marker.index ?? 0) + marker[0].length;
    return normalizedTokens(value.slice(markerEnd)).some(
      (token) => !comparisonRightHandSideFillers.has(token)
    );
  });
}

function hasConcreteComparisonLeftHandSide(value: string): boolean {
  const marker = comparisonMarkerPattern.exec(value);
  if (!marker || marker.index <= 0) return false;
  const beforeMarker = value.slice(0, marker.index);
  const assertions = [...beforeMarker.matchAll(comparisonAssertionPattern)];
  const assertion = assertions[assertions.length - 1];
  if (!assertion || assertion.index === undefined) return false;
  const subjectTokens = normalizedTokens(beforeMarker.slice(0, assertion.index));
  const relationTokens = normalizedTokens(
    beforeMarker.slice(assertion.index + assertion[0].length)
  );
  return (
    relationTokens.length > 0 &&
    subjectTokens.some((token) => token !== '&' && !comparisonLeftHandSideFillers.has(token))
  );
}

function atomicComparisonStatement(value: string): string | undefined {
  const marker = comparisonMarkerPattern.exec(value);
  if (!marker || marker.index <= 0) return undefined;
  const beforeMarker = value.slice(0, marker.index);
  const assertions = [...beforeMarker.matchAll(comparisonAssertionPattern)];
  const assertion = assertions[assertions.length - 1];
  if (!assertion || assertion.index === undefined) return undefined;
  const left = leftEntityPattern.exec(value.slice(0, assertion.index));
  const right = rightEntityPattern.exec(value.slice(marker.index + marker[0].length));
  if (!left || left.index === undefined || !right) return undefined;
  const start = left.index;
  const rightStart = marker.index + marker[0].length + (right.index ?? 0);
  const end = rightStart + right[0].length;
  const terminalPunctuation = /^[.!?]/.exec(value.slice(end))?.[0] ?? '';
  return `${value.slice(start, end).trim()}${terminalPunctuation}`;
}

function comparisonParts(value: string): ComparisonParts | undefined {
  const atomic = atomicComparisonStatement(value);
  if (!atomic) return undefined;
  const marker = comparisonMarkerPattern.exec(atomic);
  if (!marker) return undefined;
  const beforeMarker = atomic.slice(0, marker.index);
  const assertions = [...beforeMarker.matchAll(comparisonAssertionPattern)];
  const assertion = assertions[assertions.length - 1];
  if (!assertion || assertion.index === undefined) return undefined;
  return {
    subject: normalizedTokens(atomic.slice(0, assertion.index)),
    relation: normalizedTokens(atomic.slice(assertion.index, marker.index)),
    object: normalizedTokens(atomic.slice(marker.index + marker[0].length)),
  };
}

function tokenSequenceContains(
  container: readonly string[],
  candidate: readonly string[]
): boolean {
  if (candidate.length === 0 || candidate.length > container.length) return false;
  return container.some((_, index) =>
    candidate.every((token, offset) => container[index + offset] === token)
  );
}

function equivalentEntityTokens(left: readonly string[], right: readonly string[]): boolean {
  return tokenSequenceContains(left, right) || tokenSequenceContains(right, left);
}

function highNormalizedTokenOverlap(left: string, right: string): boolean {
  const leftTokens = new Set(normalizedTokens(left));
  const rightTokens = new Set(normalizedTokens(right));
  const smallerSize = Math.min(leftTokens.size, rightTokens.size);
  if (smallerSize === 0) return false;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared / smallerSize >= highTokenOverlapThreshold;
}

function sharesSourceSegment(left: readonly string[], right: readonly string[]): boolean {
  const leftIds = new Set(left);
  return right.some((id) => leftIds.has(id));
}

function comparisonSemanticsMatch(left: ComparisonParts, right: ComparisonParts): boolean {
  return (
    equivalentEntityTokens(left.subject, right.subject) &&
    tokenSequenceContains(left.relation, right.relation) &&
    tokenSequenceContains(right.relation, left.relation) &&
    equivalentEntityTokens(left.object, right.object)
  );
}

function sourceBackedSemanticDuplicate(
  left: Pick<ClaimCandidate, 'normalizedClaim' | 'contextTurnIds'>,
  right: Pick<ClaimCandidate, 'normalizedClaim' | 'contextTurnIds'>
): boolean {
  if (!sharesSourceSegment(left.contextTurnIds, right.contextTurnIds)) return false;
  const leftAtomic = atomicComparisonStatement(left.normalizedClaim) ?? left.normalizedClaim;
  const rightAtomic = atomicComparisonStatement(right.normalizedClaim) ?? right.normalizedClaim;
  if (!highNormalizedTokenOverlap(leftAtomic, rightAtomic)) return false;
  const leftComparison = comparisonParts(leftAtomic);
  const rightComparison = comparisonParts(rightAtomic);
  if (leftComparison || rightComparison) {
    return Boolean(
      leftComparison && rightComparison && comparisonSemanticsMatch(leftComparison, rightComparison)
    );
  }
  const leftTokens = normalizedTokens(leftAtomic);
  const rightTokens = normalizedTokens(rightAtomic);
  return (
    tokenSequenceContains(leftTokens, rightTokens) || tokenSequenceContains(rightTokens, leftTokens)
  );
}

export function joinTranscriptFragments(left: string, right: string): string {
  const leftWords = left.trim().split(/\s+/u);
  const rightWords = right.trim().split(/\s+/u);
  const maxOverlap = Math.min(8, leftWords.length, rightWords.length);
  let overlap = 0;
  for (let size = maxOverlap; size > 0; size -= 1) {
    const leftBoundary = leftWords.slice(-size).map(boundaryToken);
    const rightBoundary = rightWords.slice(0, size).map(boundaryToken);
    if (leftBoundary.every((word, index) => word && word === rightBoundary[index])) {
      overlap = size;
      break;
    }
  }
  return [...leftWords, ...rightWords.slice(overlap)].join(' ').trim();
}

function reconstructedClaimStatements(
  turns: readonly ClaimGateTurnSnapshot[]
): ReconstructedClaimStatement[] {
  const statements: ReconstructedClaimStatement[] = [];
  let group: ClaimGateTurnSnapshot[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const text = group.reduce(
      (joined, turn) => (joined ? joinTranscriptFragments(joined, turn.text) : turn.text.trim()),
      ''
    );
    for (const statement of text
      .split(reconstructedStatementBoundaryPattern)
      .map((candidate) => candidate.trim())
      .filter(Boolean)) {
      statements.push({ text: statement, turns: [...group] });
    }
    group = [];
  };
  for (const turn of orderedTurns(turns)) {
    const previous = group[group.length - 1];
    if (
      previous &&
      (!fragmentsAreAdjacent(previous, turn) ||
        group.length >= maxReconstructedTurnChain ||
        group.reduce((sum, candidate) => sum + candidate.text.length, 0) + turn.text.length >
          maxReconstructedCharacters)
    ) {
      flush();
    }
    group.push(turn);
    if (sentenceBoundaryPattern.test(turn.text.trim())) flush();
  }
  flush();
  return statements;
}

function concreteNamedEntity(text: string): boolean {
  return (text.match(/\b[A-Z][\p{L}\p{N}&'.-]*\b/gu) ?? []).some(
    (word) => !nonEntityWords.has(word.replace(/[’'](?:d|ll|m|re|s|ve)$/i, ''))
  );
}

function normalizedClaimWording(text: string): string {
  return text
    .replace(
      /^(?:so\s+)?(?:in my experience|i think|i believe|from what i(?:'ve| have) seen)\s*,?\s*/i,
      ''
    )
    .trim();
}

function canonicalAutomaticComparisonCandidate(candidate: ClaimCandidate): ClaimCandidate {
  const exactQuote = atomicComparisonStatement(candidate.exactQuote);
  if (!exactQuote) return candidate;
  const normalizedClaim = atomicComparisonStatement(candidate.normalizedClaim) ?? exactQuote;
  return {
    ...candidate,
    exactQuote,
    normalizedClaim: normalizedClaimWording(normalizedClaim),
  };
}

export function expandLocalClaimContext(
  batchTurns: readonly ClaimGateTurnSnapshot[],
  availableTurns: readonly ClaimGateTurnSnapshot[]
): ClaimGateTurnSnapshot[] {
  const ordered = orderedTurns([...availableTurns, ...batchTurns]);
  const batchIds = new Set(batchTurns.map((turn) => turn.id));
  const included = new Set(batchIds);
  for (let seedIndex = 0; seedIndex < ordered.length; seedIndex += 1) {
    if (!batchIds.has(ordered[seedIndex].id)) continue;
    let componentStart = seedIndex;
    let componentEnd = seedIndex;
    while (
      componentStart > 0 &&
      fragmentsAreAdjacent(ordered[componentStart - 1], ordered[componentStart])
    ) {
      componentStart -= 1;
    }
    while (
      componentEnd + 1 < ordered.length &&
      fragmentsAreAdjacent(ordered[componentEnd], ordered[componentEnd + 1])
    ) {
      componentEnd += 1;
    }
    const windowStart = Math.max(
      componentStart,
      Math.min(
        seedIndex - Math.floor((maxReconstructedTurnChain - 1) / 2),
        componentEnd - maxReconstructedTurnChain + 1
      )
    );
    const windowEnd = Math.min(componentEnd, windowStart + maxReconstructedTurnChain - 1);
    for (let index = windowStart; index <= windowEnd; index += 1) {
      included.add(ordered[index].id);
    }
  }
  return ordered.filter((turn) => included.has(turn.id));
}

export function detectLocalClaimCandidates(
  turns: readonly ClaimGateTurnSnapshot[],
  existingClaims: readonly { duplicateKey: string; normalizedClaim: string }[] = [],
  requiredTurnIds: ReadonlySet<string> = new Set(turns.map((turn) => turn.id))
): ClaimCandidate[] {
  const existingKeys = new Set(existingClaims.map((claim) => claim.duplicateKey));
  const existingNormalized = new Set(
    existingClaims.map((claim) => normalized(claim.normalizedClaim))
  );
  const candidates: ClaimCandidate[] = [];
  for (const reconstructed of reconstructedClaimStatements(turns)) {
    if (!reconstructed.turns.some((turn) => requiredTurnIds.has(turn.id))) continue;
    const statement = reconstructed.text;
    if (
      statement.length < 12 ||
      statement.endsWith('?') ||
      audioCalibrationPattern.test(statement)
    ) {
      continue;
    }
    const comparison = claimComparisonPattern.test(statement);
    const quantity = claimQuantityPattern.test(statement);
    const assertion = claimAssertionPattern.test(statement);
    const explicitComparison = comparisonMarkerPattern.test(statement);
    if (comparison && !hasConcreteComparisonRightHandSide(statement)) continue;
    if (
      comparison &&
      explicitComparison &&
      !quantity &&
      !hasConcreteComparisonLeftHandSide(statement)
    ) {
      continue;
    }
    const concreteAssertion =
      assertion && concreteNamedEntity(statement) && sentenceBoundaryPattern.test(statement);
    if (!comparison && !quantity && !concreteAssertion) continue;
    const exactQuote = atomicComparisonStatement(statement) ?? statement;
    const normalizedWording = normalizedClaimWording(exactQuote);
    const normalizedClaim = normalized(normalizedWording);
    const semanticDuplicateKey = stableLiveUuid(`local-claim-candidate:${normalizedClaim}`);
    if (existingKeys.has(semanticDuplicateKey) || existingNormalized.has(normalizedClaim)) {
      continue;
    }
    const specific = comparison || quantity;
    const statementTurns = reconstructed.turns;
    candidates.push({
      exactQuote,
      normalizedClaim: normalizedWording,
      contextTurnIds: statementTurns.map((turn) => turn.id),
      speakerId: statementTurns.find((turn) => turn.speakerId)?.speakerId,
      startMs: statementTurns[0].startMs,
      endMs: statementTurns[statementTurns.length - 1].endMs,
      checkworthy: true,
      consequenceScore: specific ? 0.65 : 0.5,
      disputeLikelihoodScore: comparison ? 0.75 : 0.6,
      specificityScore: specific ? 0.85 : 0.65,
      timeSensitive: /\b(?:today|current(?:ly)?|now|this (?:week|month|year)|latest)\b/i.test(
        statement
      ),
      selectionRationale:
        'Identified locally as a specific factual claim. Evidence research is still required.',
      semanticDuplicateKey,
    });
    existingKeys.add(semanticDuplicateKey);
    existingNormalized.add(normalizedClaim);
  }
  return candidates;
}

export async function detectClaimCandidatesWithLocalFallback(
  detectRemotely: () => Promise<ClaimCandidate[] | RemoteClaimDetectionResult>,
  turns: readonly ClaimGateTurnSnapshot[],
  existingClaims: readonly { duplicateKey: string; normalizedClaim: string }[] = [],
  localContextTurns: readonly ClaimGateTurnSnapshot[] = turns
): Promise<ClaimDetectionResult> {
  const requiredTurnIds = new Set(turns.map((turn) => turn.id));
  try {
    const response = await detectRemotely();
    const remote = Array.isArray(response) ? response : response.candidates;
    const gatewayCatchingUp = Array.isArray(response) ? false : response.catchingUp;
    if (remote.length > 0) {
      return {
        candidates: remote,
        source: 'remote',
        countAgainstRemoteBudget: true,
        gatewayCatchingUp,
      };
    }
    return {
      candidates: detectLocalClaimCandidates(localContextTurns, existingClaims, requiredTurnIds),
      source: 'local',
      countAgainstRemoteBudget: true,
      gatewayCatchingUp,
    };
  } catch (error) {
    const localCandidates = detectLocalClaimCandidates(
      localContextTurns,
      existingClaims,
      requiredTurnIds
    );
    if (localCandidates.length === 0) throw error;
    return {
      candidates: localCandidates,
      source: 'local',
      countAgainstRemoteBudget: false,
    };
  }
}

function turnRevisionKey(turn: ClaimGateTurnSnapshot): string {
  return `${turn.id}:${turn.revision}`;
}

function snapshotTurn(turn: ClaimGateTurnSnapshot): ClaimGateTurnSnapshot {
  return {
    id: turn.id,
    speakerId: turn.speakerId,
    startMs: turn.startMs,
    endMs: turn.endMs,
    text: turn.text,
    revision: turn.revision,
    sourceKind: turn.sourceKind,
  };
}

export function createClaimGateBatch(
  meetingId: string,
  turns: readonly ClaimGateTurnSnapshot[]
): ClaimGateBatch {
  const inventory = turns.map(turnRevisionKey).join('|');
  const id = stableLiveUuid(`claim-gate-batch:${meetingId}:${inventory}`);
  return {
    id,
    meetingId,
    idempotencyKey: `claim-gate:${id}`,
    turns: turns.map(snapshotTurn),
  };
}

export function claimGateBatchBeginInput(batch: ClaimGateBatch) {
  return {
    id: batch.id,
    idempotencyKey: batch.idempotencyKey,
    turns: batch.turns.map((turn) => ({
      id: turn.id,
      speakerId: turn.speakerId ?? null,
      startMs: turn.startMs,
      endMs: turn.endMs,
      text: turn.text,
      revisionNumber: turn.revision,
      sourceKind: turn.sourceKind,
    })),
  };
}

export function automaticClaimIdentity(
  meetingId: string,
  batchId: string,
  semanticDuplicateKey: string
): { claimId: string; claimVersionId: string } {
  const claimId = stableLiveUuid(`automatic-claim:${meetingId}:${batchId}:${semanticDuplicateKey}`);
  return {
    claimId,
    claimVersionId: stableLiveUuid(`automatic-claim-version:${claimId}:1`),
  };
}

export class ClaimScheduler {
  private readonly pendingTurns: TranscriptTurn[] = [];
  private readonly pendingBatches: ScheduledClaimGateBatch[] = [];
  private readonly knownBatchIds = new Set<string>();
  private readonly completedTurnRevisions = new Set<string>();
  private readonly gateCallTimes: number[] = [];
  private readonly acceptedClaimTimes: number[] = [];
  private timer?: number;
  private running = false;
  private consecutiveFailures = 0;
  private gatewayCatchingUp = false;
  private limitReached = false;
  private disposed = false;

  constructor(
    private readonly meetingId: string,
    private readonly listClaims: () => Claim[],
    private readonly callbacks: ClaimSchedulerCallbacks,
    private options: ClaimSchedulerOptions = gatewayClaimSchedulerOptions,
    private readonly now: () => number = Date.now
  ) {}

  recoverBatch(batch: ClaimGateBatch): void {
    if (this.disposed) return;
    if (batch.meetingId !== this.meetingId || batch.turns.length === 0) return;
    if (this.hasBatch(batch.id)) return;
    this.knownBatchIds.add(batch.id);
    this.pendingBatches.push({ ...batch, turns: batch.turns.map(snapshotTurn), begun: true });
    this.scheduleFlush();
  }

  addFinalTurn(turn: TranscriptTurn): void {
    if (this.disposed) return;
    if (turn.status !== 'final' && turn.status !== 'revised') return;
    if (turn.meetingId !== this.meetingId || this.hasTurnRevision(turn)) return;
    this.pendingTurns.push(turn);
    this.pendingTurns.sort((left, right) => {
      if (left.startMs !== right.startMs) return left.startMs - right.startMs;
      if (left.providerTurnOrder !== right.providerTurnOrder) {
        return left.providerTurnOrder - right.providerTurnOrder;
      }
      return turnRevisionKey(left).localeCompare(turnRevisionKey(right));
    });
    if (this.pendingTurns.length >= this.options.maxTurnsPerBatch) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (
      this.disposed ||
      this.running ||
      (this.pendingBatches.length === 0 && this.pendingTurns.length === 0)
    )
      return;
    this.pruneBudgets();
    if (this.gateCallTimes.length >= this.options.maxGateCallsPerHour) {
      this.limitReached = true;
      this.callbacks.onBackpressure(true, 'limit');
      return;
    }
    this.running = true;
    const batch = this.nextBatch();
    let retryDelay = this.options.minBatchDelayMs;
    try {
      if (!batch.begun) {
        await this.callbacks.beginBatch(batch);
        if (this.disposed) return;
        batch.begun = true;
      }
      const existingClaims = this.listClaims();
      const detection = await this.callbacks.detect({
        ...batch,
        existingClaims: existingClaims.map((claim) => ({
          duplicateKey: claim.duplicateKey,
          normalizedClaim:
            claim.versions.find((version) => version.id === claim.currentVersionId)
              ?.normalizedClaim ?? '',
        })),
      });
      if (this.disposed) return;
      const candidates = Array.isArray(detection) ? detection : detection.candidates;
      if (Array.isArray(detection) || detection.countAgainstRemoteBudget) {
        this.gateCallTimes.push(this.now());
      }
      if (!Array.isArray(detection) && detection.gatewayCatchingUp !== undefined) {
        this.gatewayCatchingUp = detection.gatewayCatchingUp;
      }
      const selection = this.acceptedCandidates(candidates, existingClaims);
      await this.callbacks.commitBatch(batch, selection.accepted);
      if (this.disposed) return;
      this.knownBatchIds.delete(batch.id);
      for (const turn of batch.turns) this.markTurnRevisionCompleted(turn);
      for (let index = 0; index < selection.accepted.length; index += 1) {
        this.acceptedClaimTimes.push(this.now());
      }
      this.consecutiveFailures = 0;
      this.limitReached = selection.rateLimited;
      const reason = this.limitReached ? 'limit' : this.gatewayCatchingUp ? 'gateway' : undefined;
      this.callbacks.onBackpressure(reason !== undefined, reason);
    } catch {
      if (this.disposed) return;
      this.pendingBatches.unshift(batch);
      this.consecutiveFailures += 1;
      retryDelay = Math.min(60_000, 1_000 * 2 ** this.consecutiveFailures);
      this.callbacks.onBackpressure(true, 'gateway');
    } finally {
      this.running = false;
      if (!this.disposed && (this.pendingBatches.length > 0 || this.pendingTurns.length > 0)) {
        this.scheduleFlush(retryDelay);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingTurns.length = 0;
    this.pendingBatches.length = 0;
    this.knownBatchIds.clear();
    this.completedTurnRevisions.clear();
  }

  setMaxGateCallsPerHour(maxGateCallsPerHour: number): void {
    if (this.disposed) return;
    if (!Number.isInteger(maxGateCallsPerHour) || maxGateCallsPerHour < 1) return;
    this.options = { ...this.options, maxGateCallsPerHour };
    this.pruneBudgets();
    if (
      this.limitReached &&
      this.gateCallTimes.length < maxGateCallsPerHour &&
      (this.pendingBatches.length > 0 || this.pendingTurns.length > 0)
    ) {
      this.limitReached = false;
      this.scheduleFlush(0);
    }
  }

  private nextBatch(): ScheduledClaimGateBatch {
    const pending = this.pendingBatches.shift();
    if (pending) return pending;
    const batch = {
      ...createClaimGateBatch(
        this.meetingId,
        this.pendingTurns.splice(0, this.options.maxTurnsPerBatch)
      ),
      begun: false,
    };
    this.knownBatchIds.add(batch.id);
    return batch;
  }

  private acceptedCandidates(
    candidates: ClaimCandidate[],
    existingClaims: Claim[]
  ): { accepted: ClaimCandidate[]; rateLimited: boolean } {
    this.pruneBudgets();
    const burstStart = this.now() - this.options.burstWindowMs;
    let remainingHourly = Math.max(
      0,
      this.options.maxAcceptedClaimsPerHour - this.acceptedClaimTimes.length
    );
    let remainingBurst = Math.max(
      0,
      this.options.maxBurstClaims -
        this.acceptedClaimTimes.filter((time) => time >= burstStart).length
    );
    const existingKeys = new Set(existingClaims.map((claim) => claim.duplicateKey));
    const knownCandidates = existingClaims.flatMap((claim) => {
      const current = claim.versions.find((version) => version.id === claim.currentVersionId);
      return current
        ? [
            {
              normalizedClaim: current.normalizedClaim,
              contextTurnIds: current.segmentIds,
            },
          ]
        : [];
    });
    const existingNormalized = new Set(
      knownCandidates.map((candidate) => normalized(candidate.normalizedClaim))
    );
    const accepted: ClaimCandidate[] = [];
    let rateLimited = false;
    for (const detectedCandidate of candidates) {
      const candidate = canonicalAutomaticComparisonCandidate(detectedCandidate);
      if (!candidate.checkworthy || candidate.specificityScore < 0.5) continue;
      if (candidate.consequenceScore < 0.45 && candidate.disputeLikelihoodScore < 0.55) continue;
      const normalizedClaim = normalized(candidate.normalizedClaim);
      if (
        existingKeys.has(candidate.semanticDuplicateKey) ||
        existingNormalized.has(normalizedClaim) ||
        knownCandidates.some((known) => sourceBackedSemanticDuplicate(candidate, known))
      ) {
        continue;
      }
      if (remainingHourly === 0 || remainingBurst === 0) {
        rateLimited = true;
        continue;
      }
      accepted.push(candidate);
      existingKeys.add(candidate.semanticDuplicateKey);
      existingNormalized.add(normalizedClaim);
      knownCandidates.push(candidate);
      remainingHourly -= 1;
      remainingBurst -= 1;
    }
    return { accepted, rateLimited };
  }

  private hasBatch(batchId: string): boolean {
    return this.knownBatchIds.has(batchId);
  }

  private hasTurnRevision(turn: TranscriptTurn): boolean {
    const key = turnRevisionKey(turn);
    return (
      this.pendingTurns.some((candidate) => turnRevisionKey(candidate) === key) ||
      this.completedTurnRevisions.has(key) ||
      this.pendingBatches.some((batch) =>
        batch.turns.some((candidate) => turnRevisionKey(candidate) === key)
      )
    );
  }

  private markTurnRevisionCompleted(turn: ClaimGateTurnSnapshot): void {
    const key = turnRevisionKey(turn);
    this.completedTurnRevisions.delete(key);
    this.completedTurnRevisions.add(key);
    if (this.completedTurnRevisions.size > maxCompletedTurnRevisions) {
      const oldest = this.completedTurnRevisions.values().next().value;
      if (oldest !== undefined) this.completedTurnRevisions.delete(oldest);
    }
  }

  private scheduleFlush(delayMs = this.options.minBatchDelayMs): void {
    if (this.disposed || this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
  }

  private pruneBudgets(): void {
    const cutoff = this.now() - 3_600_000;
    while (this.gateCallTimes[0] !== undefined && this.gateCallTimes[0] < cutoff) {
      this.gateCallTimes.shift();
    }
    while (this.acceptedClaimTimes[0] !== undefined && this.acceptedClaimTimes[0] < cutoff) {
      this.acceptedClaimTimes.shift();
    }
  }
}

export function normalizeManualSelection(selection: string, maxCharacters = 2_000): string {
  return selection.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, maxCharacters);
}
