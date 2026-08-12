import type {
  MeetingArtifactDto,
  MeetingArtifactType,
  MeetingAssessmentApplyDto,
  MeetingAssessmentDto,
  MeetingAudioAssetUpsertDto,
  MeetingAudioAssetDto,
  MeetingClaimGateBatchBeginDto,
  MeetingClaimVersionUpsertDto,
  MeetingClaimGateBatchDto,
  MeetingClaimGateTurnDto,
  MeetingClaimDto,
  MeetingClaimVersionDto,
  MeetingDto,
  MeetingCaptureStatus,
  MeetingListItemDto,
  MeetingManualFactCheckRequestDto,
  MeetingManualFactCheckRequestUpsertDto,
  MeetingRefinementStatus,
  MeetingRefinementInputUpsertDto,
  MeetingRefinementJobUpsertDto,
  MeetingResearchJobUpsertDto,
  MeetingResearchStatus,
  MeetingSourceDto,
  MeetingSpeakerDto,
  MeetingTimelineEventDto,
  MeetingTranscriptSegmentDto,
  MeetingTranscriptSegmentUpsertDto,
  MeetingSpeakerObservationUpsertDto,
  MeetingTranscriptVersionDto,
  MeetingTranscriptVersionUpsertDto,
} from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';
import { evidenceRelationForFinding, resolutionForFinding } from '../live/factCheckPolicy';
import type {
  Assessment,
  AudioAsset,
  Claim,
  ClaimVersion,
  ClaimGateTurnSnapshot,
  ManualFactCheckRequest,
  MeetingArtifact,
  MeetingSummary,
  PendingClaimGateBatch,
  Speaker,
  TimelineEvent,
  TranscriptTurn,
  TranscriptVersion,
  TypedError,
} from '../live/types';

export type ClaimGateBatchBeginInput = MeetingClaimGateBatchBeginDto & {
  turns: NonNullable<MeetingClaimGateBatchBeginDto['turns']>;
};

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function typedError(
  error: { code: string; message: string; retryable: boolean } | null | undefined
): TypedError | undefined {
  return error
    ? { code: error.code, message: error.message, retryable: error.retryable }
    : undefined;
}

function mapRefinementStatus(status: MeetingRefinementStatus): MeetingArtifact['refinementStatus'] {
  return status;
}

function mapResearchStatus(status: MeetingResearchStatus): MeetingArtifact['researchStatus'] {
  switch (status) {
    case 'complete':
      return 'complete';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'retry_wait':
      return 'retry_wait';
    case 'running':
    case 'partial':
      return 'running';
    case 'queued':
    case 'not_started':
      return 'pending';
  }
}

function mapMeeting(meeting: MeetingDto) {
  return {
    id: meeting.id,
    title: meeting.title,
    artifactType: meeting.artifactType,
    mode: meeting.mode,
    status: meeting.status,
    strategy: meeting.captureConfig.liveStrategy,
    startedAtMs: meeting.startedAtMs,
    endedAtMs: meeting.endedAtMs ?? undefined,
    createdAt: iso(meeting.createdAtMs),
    updatedAt: iso(meeting.updatedAtMs),
    canonicalTranscriptVersionId: meeting.canonicalTranscriptVersionId ?? undefined,
    refinementStatus: mapRefinementStatus(meeting.refinementStatus),
    researchStatus: mapResearchStatus(meeting.researchStatus),
    error: typedError(meeting.lastError),
  };
}

function mapSpeaker(speaker: MeetingSpeakerDto): Speaker {
  return {
    id: speaker.id,
    defaultLabel: speaker.defaultLabel,
    displayName: speaker.displayName ?? undefined,
    displayNameSource: speaker.displayNameSource === 'manual' ? 'manual' : 'generic',
    manualAssignmentLocked: speaker.manualAssignmentLock,
    sourceHint: speaker.sourceHint ?? undefined,
  };
}

function mapVersion(version: MeetingTranscriptVersionDto): TranscriptVersion {
  return {
    id: version.id,
    meetingId: version.meetingId,
    kind: version.kind,
    status:
      version.status === 'superseded'
        ? 'complete'
        : version.status === 'active'
          ? 'active'
          : version.status,
    revision: version.revisionNumber,
    provider: version.provider ?? undefined,
    model: version.model ?? undefined,
    gatewayJobId: version.gatewayJobId ?? undefined,
    parentVersionId: version.parentVersionId ?? undefined,
    detectedLanguage: version.detectedLanguage ?? undefined,
    createdAt: iso(version.createdAtMs),
    completedAt: version.completedAtMs ? iso(version.completedAtMs) : undefined,
    error: typedError(version.error),
  };
}

function mapTurn(segment: MeetingTranscriptSegmentDto): TranscriptTurn {
  return {
    id: segment.id,
    meetingId: segment.meetingId,
    transcriptVersionId: segment.transcriptVersionId,
    provider: segment.provider,
    providerSessionId: segment.providerSessionId ?? segment.providerNamespace,
    providerTurnId: segment.providerTurnId,
    providerTurnOrder: segment.providerTurnOrder,
    revision: segment.revisionNumber,
    status: segment.state,
    speakerId: segment.speakerId ?? undefined,
    sourceKind: segment.sourceKind,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    words: segment.words.map((word, index) => ({
      id: `${segment.id}:word:${index}`,
      text: word.text,
      startMs: word.startMs,
      endMs: word.endMs,
      speakerLabel: word.providerSpeakerLabel ?? undefined,
      confidence: word.confidence ?? undefined,
      final: true,
    })),
    utteranceBoundary: true,
    endOfTurn: true,
    formatted: true,
    receivedAtMs: segment.updatedAtMs,
    finalizedAtMs: segment.updatedAtMs,
  };
}

function mapTimeline(event: MeetingTimelineEventDto): TimelineEvent {
  const metadata = (event.metadata ?? {}) as Record<string, unknown>;
  return {
    id: event.id,
    meetingId: event.meetingId,
    kind: event.kind,
    startMs: event.startMs,
    endMs: event.endMs ?? undefined,
    sourceKind: event.sourceKind ?? undefined,
    providerSessionId: event.providerNamespace ?? undefined,
    label: typeof metadata.label === 'string' ? metadata.label : undefined,
  };
}

function mapSource(source: MeetingSourceDto) {
  return {
    id: source.id,
    citationKey: source.citationKey,
    url: source.url,
    canonicalUrl: source.canonicalUrl,
    publisher: source.publisher,
    title: source.title,
    publicationDate: source.publicationDate ?? undefined,
    accessedAt: iso(source.accessedAtMs),
    excerpt: source.evidenceExcerpt,
    stance: source.stance,
    qualityScore: source.qualityScore ?? 0,
    qualityRationale: source.qualityRationale,
  } as const;
}

function mapAssessment(assessment: MeetingAssessmentDto): Assessment {
  const finding =
    assessment.verdict === 'supported'
      ? ('Supported' as const)
      : assessment.verdict === 'unsupported'
        ? ('Disputed' as const)
        : assessment.verdict === 'mixed' || assessment.verdict === 'mostly_supported'
          ? ('Needs context' as const)
          : ('Unverified' as const);
  return {
    id: assessment.id,
    claimVersionId: assessment.claimVersionId,
    stage: assessment.stage,
    attempt: assessment.attemptNumber,
    status: assessment.status === 'complete' ? 'complete' : 'failed',
    current: assessment.current,
    verdict: finding,
    resolution: resolutionForFinding(finding),
    evidenceRelation: evidenceRelationForFinding(finding),
    confidence:
      assessment.confidence === 'high'
        ? 'High'
        : assessment.confidence === 'medium'
          ? 'Medium'
          : 'Low',
    conclusion: assessment.conclusion.map((statement) => statement.text).join(' '),
    support: assessment.support.map((statement) => statement.text),
    contradiction: assessment.contradiction.map((statement) => statement.text),
    caveats: assessment.caveats.map((statement) => statement.text),
    limitations: assessment.limitations.map((statement) => statement.text),
    citations: {
      conclusion: [
        ...new Set(assessment.conclusion.flatMap((statement) => statement.citationKeys)),
      ],
      support: assessment.support.map((statement) => statement.citationKeys),
      contradiction: assessment.contradiction.map((statement) => statement.citationKeys),
      caveats: assessment.caveats.map((statement) => statement.citationKeys),
      limitations: assessment.limitations.map((statement) => statement.citationKeys),
    },
    sources: assessment.sources.map(mapSource),
    provider: assessment.modelProvider,
    model: assessment.model,
    startedAt: iso(assessment.startedAtMs),
    completedAt: iso(assessment.completedAtMs),
    latencyMs: assessment.latencyMs ?? undefined,
    error: typedError(assessment.error),
  };
}

function mapClaimVersion(
  version: MeetingClaimVersionDto,
  assessments: MeetingAssessmentDto[],
  parentManualRequestId?: string
): ClaimVersion {
  return {
    id: version.id,
    claimId: version.claimId,
    version: version.versionNumber,
    predecessorId: version.predecessorId ?? undefined,
    successorId: version.supersededById ?? undefined,
    sourceTranscriptVersionId: version.sourceTranscriptVersionId ?? undefined,
    exactQuote: version.exactQuote,
    normalizedClaim: version.normalizedClaim,
    speakerId: version.speakerId ?? undefined,
    startMs: version.startMs ?? undefined,
    endMs: version.endMs ?? undefined,
    segmentIds: version.segmentIds,
    selectionRationale: version.selectionRationale ?? undefined,
    consequenceScore: version.consequenceScore ?? undefined,
    disputeScore: version.disputeScore ?? undefined,
    specificityScore: version.specificityScore ?? undefined,
    timeSensitive: version.timeSensitive,
    lifecycle: version.lifecycle,
    parentManualRequestId,
    createdAt: iso(version.createdAtMs),
    assessments: assessments
      .filter((item) => item.claimVersionId === version.id)
      .map(mapAssessment),
  };
}

function mapClaims(
  claims: MeetingClaimDto[],
  versions: MeetingClaimVersionDto[],
  assessments: MeetingAssessmentDto[]
): Claim[] {
  return claims.map((claim) => {
    const parentManualRequestId = claim.manualRequestId ?? undefined;
    const claimVersions = versions
      .filter((version) => version.claimId === claim.id)
      .map((version) => mapClaimVersion(version, assessments, parentManualRequestId));
    const current = claimVersions.find((version) => version.id === claim.currentClaimVersionId);
    return {
      id: claim.id,
      meetingId: claim.meetingId,
      manualRequestId: parentManualRequestId,
      origin: claim.origin,
      duplicateKey: claim.duplicateKey ?? claim.id,
      status: claim.status,
      currentVersionId:
        claim.currentClaimVersionId ?? claimVersions[claimVersions.length - 1]?.id ?? '',
      versions: claimVersions,
      spokenAtMs: current?.startMs ?? 0,
      createdAt: iso(claim.createdAtMs),
      updatedAt: iso(claim.updatedAtMs),
    };
  });
}

function mapAudioAsset(asset: MeetingAudioAssetDto): AudioAsset {
  return {
    id: asset.id,
    meetingId: asset.meetingId,
    sourceKind: asset.sourceKind === 'text' ? 'mixed' : asset.sourceKind,
    timelinePart: asset.timelinePart,
    format: asset.format === 'pcm_s16le' ? 'pcm_s16le' : 'wav',
    sampleRate: asset.sampleRate,
    channels: asset.channels,
    timelineStartMs: asset.timelineStartMs,
    timelineEndMs: asset.timelineEndMs ?? undefined,
    durationMs: asset.durationMs ?? undefined,
    bytes: asset.bytes ?? undefined,
    checksum: asset.checksum ?? undefined,
    status:
      asset.status === 'finalized'
        ? 'finalized'
        : asset.status === 'recording'
          ? 'recording'
          : 'interrupted',
  };
}

export function claimGateTurnSnapshotFromDto(turn: MeetingClaimGateTurnDto): ClaimGateTurnSnapshot {
  return {
    id: turn.id,
    speakerId: turn.speakerId ?? undefined,
    startMs: turn.startMs,
    endMs: turn.endMs,
    text: turn.text,
    revision: turn.revisionNumber,
    sourceKind: turn.sourceKind,
  };
}

export function pendingClaimGateBatchFromDto(
  batch: MeetingClaimGateBatchDto
): PendingClaimGateBatch {
  return {
    id: batch.id,
    meetingId: batch.meetingId,
    idempotencyKey: batch.idempotencyKey,
    turns: batch.turns.map(claimGateTurnSnapshotFromDto),
    createdAtMs: batch.createdAtMs,
  };
}

export function manualFactCheckRequestFromDto(
  request: MeetingManualFactCheckRequestDto
): ManualFactCheckRequest {
  return {
    id: request.id,
    meetingId: request.meetingId,
    exactSelection: request.exactSelection,
    contextTurns: request.contextTurns.map(claimGateTurnSnapshotFromDto),
    sourceSegmentIds: request.sourceSegmentIds,
    speakerId: request.speakerId ?? undefined,
    startMs: request.startMs ?? undefined,
    endMs: request.endMs ?? undefined,
    status: request.status,
    error: typedError(request.error),
    createdAtMs: request.createdAtMs,
    updatedAtMs: request.updatedAtMs,
  };
}

export function meetingArtifactFromDto(dto: MeetingArtifactDto): MeetingArtifact {
  const meeting = mapMeeting(dto.meeting);
  const versions = dto.transcriptVersions.map(mapVersion);
  return {
    ...meeting,
    liveTranscriptVersionId: versions.find((version) => version.kind === 'live')?.id,
    versions,
    turns: dto.transcriptSegments.map(mapTurn),
    speakers: dto.speakers.map(mapSpeaker),
    timeline: dto.timelineEvents.map(mapTimeline),
    claims: mapClaims(dto.claims, dto.claimVersions, dto.assessments),
    manualFactCheckRequests: dto.manualFactCheckRequests.map(manualFactCheckRequestFromDto),
    pendingClaimGateSegmentIds: dto.pendingClaimGateSegmentIds,
    pendingClaimGateBatches: dto.pendingClaimGateBatches.map(pendingClaimGateBatchFromDto),
    audioAssets: dto.audioAssets.map(mapAudioAsset),
    researchJobs: dto.researchJobs.map((job) => ({
      id: job.id,
      claimVersionId: job.claimVersionId,
      stage: job.stage,
      gatewayJobId: job.gatewayJobId ?? undefined,
      idempotencyKey: job.idempotencyKey,
      status: job.status,
      attemptCount: job.attemptCount,
      nextRetryAtMs: job.nextRetryAtMs ?? undefined,
      startedAtMs: job.startedAtMs ?? undefined,
      completedAtMs: job.completedAtMs ?? undefined,
      error: typedError(job.error),
    })),
    refinementJobs: dto.refinementJobs.map((job) => ({
      id: job.id,
      meetingId: job.meetingId,
      sourceTranscriptVersionId: job.sourceTranscriptVersionId,
      inputManifestChecksum: job.inputManifestChecksum,
      provider: job.provider,
      model: job.model,
      gatewayJobId: job.gatewayJobId ?? undefined,
      idempotencyKey: job.idempotencyKey,
      status: job.status,
      attemptCount: job.attemptCount,
      nextRetryAtMs: job.nextRetryAtMs ?? undefined,
      startedAtMs: job.startedAtMs ?? undefined,
      completedAtMs: job.completedAtMs ?? undefined,
      error: typedError(job.error),
    })),
  };
}

function summaryFromDto(item: MeetingListItemDto): MeetingSummary {
  const meeting = mapMeeting(item.meeting);
  return {
    id: meeting.id,
    title: meeting.title,
    artifactType: meeting.artifactType,
    mode: meeting.mode,
    status: meeting.status,
    startedAtMs: meeting.startedAtMs,
    durationMs: item.durationMs ?? undefined,
    speakerNames: item.speakerNames,
    claimCount: item.claimCount,
    completedResearchCount: item.completedResearchCount,
    refinementStatus: meeting.refinementStatus,
    updatedAt: meeting.updatedAt,
  };
}

export interface CreateMeetingInput {
  title?: string;
  artifactType: MeetingArtifactType;
  mode: 'call' | 'in_person' | 'text';
  startedAtMs: number;
  strategy: 'mixed_diarized' | 'source_separated';
  microphoneDeviceId?: string;
  systemAudioEnabled: boolean;
  speakerNames?: string[];
}

export async function createMeeting(input: CreateMeetingInput): Promise<MeetingArtifact> {
  const client = await getAcpClient();
  const response = await client.goose.meetingsCreate_unstable({
    title: input.title || null,
    artifactType: input.artifactType,
    mode: input.mode,
    startedAtMs: input.startedAtMs,
    captureConfig: {
      liveStrategy: input.strategy,
      microphoneDeviceId: input.microphoneDeviceId ?? null,
      systemAudioEnabled: input.systemAudioEnabled,
      exactSpeakerCount: null,
    },
    initialSpeakers: (input.speakerNames ?? []).map((name, index) => ({
      id: null,
      defaultLabel: `Speaker ${index + 1}`,
      displayName: name.trim() || null,
      displayNameSource: name.trim() ? 'manual' : 'generic',
      manualAssignmentLock: Boolean(name.trim()),
      sourceHint: null,
    })),
  });
  return {
    ...mapMeeting(response.meeting),
    liveTranscriptVersionId: response.liveTranscriptVersion.id,
    versions: [mapVersion(response.liveTranscriptVersion)],
    turns: [],
    speakers: response.speakers.map(mapSpeaker),
    timeline: [],
    claims: [],
    manualFactCheckRequests: [],
    pendingClaimGateSegmentIds: [],
    pendingClaimGateBatches: [],
    audioAssets: [],
    researchJobs: [],
    refinementJobs: [],
  };
}

export async function listMeetings(query?: string): Promise<MeetingSummary[]> {
  const client = await getAcpClient();
  const response = await client.goose.meetingsList_unstable({
    artifactType: null,
    statuses: [],
    query: query?.trim() || null,
    cursor: null,
    limit: 100,
  });
  return response.items.map(summaryFromDto);
}

export async function getMeeting(meetingId: string): Promise<MeetingArtifact> {
  const client = await getAcpClient();
  const response = await client.goose.meetingsGet_unstable({ meetingId });
  return meetingArtifactFromDto(response.artifact);
}

export async function updateMeeting(
  meetingId: string,
  patch: {
    title?: string;
    status?: MeetingArtifact['status'];
    endedAtMs?: number;
    captureStatus?: MeetingCaptureStatus;
    refinementStatus?: MeetingArtifact['refinementStatus'];
  }
): Promise<ReturnType<typeof mapMeeting>> {
  const client = await getAcpClient();
  const response = await client.goose.meetingsUpdate_unstable({
    meetingId,
    title: patch.title ?? null,
    status: patch.status ?? null,
    endedAtMs: patch.endedAtMs ?? null,
    captureStatus: patch.captureStatus ?? null,
    refinementStatus: patch.refinementStatus ?? null,
    researchStatus: null,
    error: null,
    clearError: false,
  });
  return mapMeeting(response.meeting);
}

export async function persistTranscriptTurn(
  meetingId: string,
  version: MeetingTranscriptVersionUpsertDto,
  turn: TranscriptTurn,
  speakerObservations: MeetingSpeakerObservationUpsertDto[] = []
): Promise<void> {
  const client = await getAcpClient();
  await client.goose.meetingsTranscriptApply_unstable({
    meetingId,
    version,
    segments: [
      {
        id: turn.id,
        transcriptVersionId: turn.transcriptVersionId,
        provider: turn.provider,
        providerNamespace: turn.providerSessionId,
        providerSessionId: turn.providerSessionId,
        providerTurnId: turn.providerTurnId,
        providerTurnOrder: turn.providerTurnOrder,
        revisionNumber: turn.revision,
        state: turn.status,
        speakerId: turn.speakerId ?? null,
        sourceKind: turn.sourceKind,
        startMs: turn.startMs,
        endMs: turn.endMs,
        text: turn.text,
        words: turn.words.map((word) => ({
          text: word.text,
          startMs: word.startMs,
          endMs: word.endMs,
          confidence: word.confidence ?? null,
          providerSpeakerLabel: word.speakerLabel ?? null,
        })),
        replacedLiveSegmentIds: [],
      },
    ],
    speakerObservations,
    promoteCanonical: false,
  });
}

export async function applySpeakers(
  meetingId: string,
  speakers: Speaker[],
  swaps: Array<{ firstSpeakerId: string; secondSpeakerId: string }> = [],
  segmentUpdates: Array<{ segmentId: string; speakerId: string }> = []
): Promise<Speaker[]> {
  const client = await getAcpClient();
  const response = await client.goose.meetingsSpeakersApply_unstable({
    meetingId,
    speakers: speakers.map((speaker) => ({
      id: speaker.id,
      defaultLabel: speaker.defaultLabel,
      displayName: speaker.displayName ?? null,
      displayNameSource: speaker.displayNameSource,
      manualAssignmentLock: speaker.manualAssignmentLocked,
      sourceHint: speaker.sourceHint ?? null,
    })),
    swaps,
    segmentUpdates,
  });
  return response.speakers.map(mapSpeaker);
}

export async function applyTimelineEvent(meetingId: string, event: TimelineEvent): Promise<void> {
  const client = await getAcpClient();
  await client.goose.meetingsTimelineApply_unstable({
    meetingId,
    events: [
      {
        id: event.id,
        kind: event.kind,
        startMs: event.startMs,
        endMs: event.endMs ?? null,
        sourceKind: event.sourceKind ?? null,
        providerNamespace: event.providerSessionId ?? null,
        metadata: event.label ? { label: event.label } : null,
      },
    ],
  });
}

export async function persistClaimVersions(
  meetingId: string,
  claimVersions: MeetingClaimVersionUpsertDto[],
  markStaleClaimVersionIds: string[] = [],
  claimGate: {
    manualFactCheckRequests?: MeetingManualFactCheckRequestUpsertDto[];
    beginBatches?: ClaimGateBatchBeginInput[];
    completeBatchIds?: string[];
  } = {}
): Promise<MeetingArtifact> {
  const client = await getAcpClient();
  const request = {
    meetingId,
    manualFactCheckRequests: claimGate.manualFactCheckRequests ?? [],
    claimVersions,
    markStaleClaimVersionIds,
    beginClaimGateBatches: claimGate.beginBatches ?? [],
    completeClaimGateBatchIds: claimGate.completeBatchIds ?? [],
  };
  await client.goose.meetingsClaimsApply_unstable(request);
  return getMeeting(meetingId);
}

export async function persistResearch(
  meetingId: string,
  job: MeetingResearchJobUpsertDto | null,
  assessment: MeetingAssessmentApplyDto | null
): Promise<MeetingArtifact> {
  const client = await getAcpClient();
  await client.goose.meetingsResearchApply_unstable({ meetingId, job, assessment });
  return getMeeting(meetingId);
}

export async function persistRefinementJob(
  meetingId: string,
  job: MeetingRefinementJobUpsertDto
): Promise<void> {
  const client = await getAcpClient();
  await client.goose.meetingsRefinementJobApply_unstable({ meetingId, job });
}

export async function persistAudioAssets(
  meetingId: string,
  assets: MeetingAudioAssetUpsertDto[],
  refinementJobId?: string,
  refinementInputs: MeetingRefinementInputUpsertDto[] = []
): Promise<void> {
  const client = await getAcpClient();
  await client.goose.meetingsAudioApply_unstable({
    meetingId,
    assets,
    replaceRefinementManifestForJobId: refinementJobId ?? null,
    refinementInputs,
  });
}

export async function applyRefinedTranscript(input: {
  meetingId: string;
  refinementJobId: string;
  version: MeetingTranscriptVersionUpsertDto;
  segments: MeetingTranscriptSegmentUpsertDto[];
  speakerObservations: MeetingSpeakerObservationUpsertDto[];
  markStaleClaimVersionIds: string[];
  replacementClaimVersions: MeetingClaimVersionUpsertDto[];
}): Promise<MeetingArtifact> {
  const client = await getAcpClient();
  const request = {
    meetingId: input.meetingId,
    refinementJobId: input.refinementJobId,
    version: input.version,
    segments: input.segments,
    speakerObservations: input.speakerObservations,
    markStaleClaimVersionIds: input.markStaleClaimVersionIds,
    replacementClaimVersions: input.replacementClaimVersions,
  };
  await client.goose.meetingsRefinementResultApply_unstable(request);
  return getMeeting(input.meetingId);
}

export async function deleteMeeting(meetingId: string) {
  const client = await getAcpClient();
  return client.goose.meetingsDelete_unstable({ meetingId });
}

export async function confirmMeetingCleanup(
  cleanupJobId: string,
  statuses: {
    localStatus: 'pending' | 'running' | 'complete' | 'retry_wait' | 'failed' | 'unavailable';
    gatewayStatus: 'pending' | 'running' | 'complete' | 'retry_wait' | 'failed' | 'unavailable';
    providerStatus: 'pending' | 'running' | 'complete' | 'retry_wait' | 'failed' | 'unavailable';
    error?: { code: string; message: string; retryable: boolean };
  }
) {
  const client = await getAcpClient();
  return client.goose.meetingsCleanupConfirm_unstable({
    cleanupJobId,
    localStatus: statuses.localStatus,
    gatewayStatus: statuses.gatewayStatus,
    providerStatus: statuses.providerStatus,
    error: statuses.error ?? null,
  });
}

export async function recoverMeetingJobs(reconcileActiveWork: boolean) {
  const client = await getAcpClient();
  return client.goose.meetingsRecover_unstable({ reconcileActiveWork });
}
