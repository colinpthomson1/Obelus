use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingArtifactType {
    #[default]
    Meeting,
    TextCheck,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingMode {
    #[default]
    Call,
    InPerson,
    Text,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingLifecycleStatus {
    Setup,
    Starting,
    #[default]
    Recording,
    Paused,
    Stopping,
    Finalizing,
    Complete,
    Interrupted,
    Error,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingCaptureStatus {
    #[default]
    NotStarted,
    Active,
    Paused,
    Finalizing,
    Complete,
    Interrupted,
    Error,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingRefinementStatus {
    #[default]
    NotStarted,
    Queued,
    Uploading,
    Processing,
    Reconciling,
    Complete,
    RetryWait,
    Failed,
    Cancelled,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingResearchStatus {
    #[default]
    NotStarted,
    Queued,
    Running,
    Partial,
    Complete,
    RetryWait,
    Failed,
    Cancelled,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingLiveStrategy {
    #[default]
    MixedDiarized,
    SourceSeparated,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingTranscriptVersionKind {
    #[default]
    Live,
    Refined,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingTranscriptVersionStatus {
    #[default]
    Active,
    Processing,
    Complete,
    Failed,
    Superseded,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingTranscriptSegmentState {
    Partial,
    #[default]
    Final,
    Revised,
    Superseded,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingAudioSourceKind {
    #[default]
    Mixed,
    Microphone,
    System,
    Text,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingAudioAssetStatus {
    #[default]
    Recording,
    Finalized,
    Interrupted,
    Missing,
    Deleted,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingTimelineEventKind {
    #[default]
    Pause,
    Resume,
    Sleep,
    Wake,
    CaptureGap,
    DeviceChange,
    SttReconnectGap,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingClaimOrigin {
    #[default]
    Automatic,
    Manual,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingClaimStatus {
    Detected,
    #[default]
    Queued,
    QuickRunning,
    Preliminary,
    DeepRunning,
    Complete,
    Stale,
    Rechecking,
    Failed,
    Cancelled,
    Superseded,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingClaimVersionLifecycle {
    #[default]
    Active,
    Stale,
    Rechecking,
    Superseded,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingManualFactCheckRequestStatus {
    #[default]
    Queued,
    Processing,
    RetryWait,
    Complete,
    Failed,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingAssessmentStage {
    #[default]
    Preliminary,
    Deep,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingAssessmentStatus {
    #[default]
    Complete,
    Failed,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingVerdict {
    Supported,
    MostlySupported,
    Mixed,
    Unsupported,
    #[default]
    Unverifiable,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingConfidence {
    #[default]
    Low,
    Medium,
    High,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingEvidenceStance {
    #[default]
    Supports,
    Contradicts,
    Context,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingJobStatus {
    #[default]
    Pending,
    Running,
    RetryWait,
    Complete,
    Failed,
    Cancelled,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingRefinementJobStatus {
    #[default]
    Queued,
    Uploading,
    Processing,
    Reconciling,
    Complete,
    RetryWait,
    Failed,
    Cancelled,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingCleanupStatus {
    #[default]
    Pending,
    Running,
    Complete,
    RetryWait,
    Failed,
    Unavailable,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MeetingUpsertOutcomeKind {
    #[default]
    Inserted,
    Revised,
    Duplicate,
    StaleIgnored,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTypedErrorDto {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCaptureConfigDto {
    pub live_strategy: MeetingLiveStrategy,
    pub microphone_device_id: Option<String>,
    pub system_audio_enabled: bool,
    pub exact_speaker_count: Option<u32>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDto {
    pub id: String,
    pub title: String,
    pub artifact_type: MeetingArtifactType,
    pub mode: MeetingMode,
    pub status: MeetingLifecycleStatus,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub capture_config: MeetingCaptureConfigDto,
    pub canonical_transcript_version_id: Option<String>,
    pub capture_status: MeetingCaptureStatus,
    pub refinement_status: MeetingRefinementStatus,
    pub research_status: MeetingResearchStatus,
    pub last_error: Option<MeetingTypedErrorDto>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeakerInputDto {
    pub id: Option<String>,
    pub default_label: String,
    pub display_name: Option<String>,
    pub display_name_source: Option<String>,
    pub manual_assignment_lock: bool,
    pub source_hint: Option<MeetingAudioSourceKind>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeakerDto {
    pub id: String,
    pub meeting_id: String,
    pub default_label: String,
    pub display_name: Option<String>,
    pub display_name_source: Option<String>,
    pub manual_assignment_lock: bool,
    pub source_hint: Option<MeetingAudioSourceKind>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeakerObservationUpsertDto {
    pub id: String,
    pub transcript_version_id: String,
    pub speaker_id: Option<String>,
    pub provider: String,
    pub provider_namespace: String,
    pub provider_speaker_label: String,
    pub confidence: Option<f32>,
    pub ambiguous: bool,
    pub revision_number: u64,
    pub source_hint: Option<MeetingAudioSourceKind>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeakerObservationDto {
    pub id: String,
    pub meeting_id: String,
    pub transcript_version_id: String,
    pub speaker_id: Option<String>,
    pub provider: String,
    pub provider_namespace: String,
    pub provider_speaker_label: String,
    pub confidence: Option<f32>,
    pub ambiguous: bool,
    pub revision_number: u64,
    pub source_hint: Option<MeetingAudioSourceKind>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranscriptVersionUpsertDto {
    pub id: String,
    pub kind: MeetingTranscriptVersionKind,
    pub status: MeetingTranscriptVersionStatus,
    pub revision_number: u64,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub gateway_job_id: Option<String>,
    pub parent_version_id: Option<String>,
    pub input_audio_checksum: Option<String>,
    pub detected_language: Option<String>,
    pub reconciliation_metadata: Option<serde_json::Value>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub error: Option<MeetingTypedErrorDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranscriptVersionDto {
    pub id: String,
    pub meeting_id: String,
    pub kind: MeetingTranscriptVersionKind,
    pub status: MeetingTranscriptVersionStatus,
    pub revision_number: u64,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub gateway_job_id: Option<String>,
    pub parent_version_id: Option<String>,
    pub input_audio_checksum: Option<String>,
    pub detected_language: Option<String>,
    pub reconciliation_metadata: Option<serde_json::Value>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub error: Option<MeetingTypedErrorDto>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTimedWordDto {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub confidence: Option<f32>,
    pub provider_speaker_label: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranscriptSegmentUpsertDto {
    pub id: String,
    pub transcript_version_id: String,
    pub provider: String,
    pub provider_namespace: String,
    pub provider_session_id: Option<String>,
    pub provider_turn_id: String,
    pub provider_turn_order: i64,
    pub revision_number: u64,
    pub state: MeetingTranscriptSegmentState,
    pub speaker_id: Option<String>,
    pub source_kind: MeetingAudioSourceKind,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub words: Vec<MeetingTimedWordDto>,
    pub replaced_live_segment_ids: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranscriptSegmentDto {
    pub id: String,
    pub meeting_id: String,
    pub transcript_version_id: String,
    pub provider: String,
    pub provider_namespace: String,
    pub provider_session_id: Option<String>,
    pub provider_turn_id: String,
    pub provider_turn_order: i64,
    pub revision_number: u64,
    pub state: MeetingTranscriptSegmentState,
    pub speaker_id: Option<String>,
    pub source_kind: MeetingAudioSourceKind,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub words: Vec<MeetingTimedWordDto>,
    pub replaced_live_segment_ids: Vec<String>,
    pub content_hash: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingUpsertOutcomeDto {
    pub id: String,
    pub outcome: MeetingUpsertOutcomeKind,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeakerSwapDto {
    pub first_speaker_id: String,
    pub second_speaker_id: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSegmentSpeakerUpdateDto {
    pub segment_id: String,
    pub speaker_id: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTimelineEventUpsertDto {
    pub id: String,
    pub kind: MeetingTimelineEventKind,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    pub source_kind: Option<MeetingAudioSourceKind>,
    pub provider_namespace: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTimelineEventDto {
    pub id: String,
    pub meeting_id: String,
    pub kind: MeetingTimelineEventKind,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    pub source_kind: Option<MeetingAudioSourceKind>,
    pub provider_namespace: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAudioAssetUpsertDto {
    pub id: String,
    pub source_kind: MeetingAudioSourceKind,
    pub timeline_part: u32,
    pub file_name: String,
    pub format: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub timeline_start_ms: i64,
    pub timeline_end_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub bytes: Option<u64>,
    pub checksum: Option<String>,
    pub status: MeetingAudioAssetStatus,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAudioAssetDto {
    pub id: String,
    pub meeting_id: String,
    pub source_kind: MeetingAudioSourceKind,
    pub timeline_part: u32,
    pub relative_path: String,
    pub format: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub timeline_start_ms: i64,
    pub timeline_end_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub bytes: Option<u64>,
    pub checksum: Option<String>,
    pub status: MeetingAudioAssetStatus,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRefinementInputUpsertDto {
    pub refinement_job_id: String,
    pub part_index: u32,
    pub audio_asset_id: String,
    pub source_kind: MeetingAudioSourceKind,
    pub checksum: String,
    pub meeting_start_ms: i64,
    pub meeting_end_ms: i64,
    pub provider_start_ms: i64,
    pub provider_end_ms: i64,
    pub manifest_checksum: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRefinementInputDto {
    pub refinement_job_id: String,
    pub part_index: u32,
    pub audio_asset_id: String,
    pub source_kind: MeetingAudioSourceKind,
    pub checksum: String,
    pub meeting_start_ms: i64,
    pub meeting_end_ms: i64,
    pub provider_start_ms: i64,
    pub provider_end_ms: i64,
    pub manifest_checksum: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingClaimVersionUpsertDto {
    pub claim_id: String,
    pub claim_version_id: String,
    pub manual_request_id: Option<String>,
    pub origin: MeetingClaimOrigin,
    pub duplicate_key: Option<String>,
    pub status: MeetingClaimStatus,
    pub version_number: u32,
    pub predecessor_id: Option<String>,
    pub superseded_by_id: Option<String>,
    pub source_transcript_version_id: Option<String>,
    pub exact_quote: String,
    pub normalized_claim: String,
    pub speaker_id: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub segment_ids: Vec<String>,
    pub selection_rationale: Option<String>,
    pub consequence_score: Option<f32>,
    pub dispute_score: Option<f32>,
    pub specificity_score: Option<f32>,
    pub time_sensitive: bool,
    pub lifecycle: MeetingClaimVersionLifecycle,
    pub set_current: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingClaimDto {
    pub id: String,
    pub meeting_id: String,
    pub manual_request_id: Option<String>,
    pub origin: MeetingClaimOrigin,
    pub duplicate_key: Option<String>,
    pub status: MeetingClaimStatus,
    pub current_claim_version_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingClaimVersionDto {
    pub id: String,
    pub claim_id: String,
    pub version_number: u32,
    pub predecessor_id: Option<String>,
    pub superseded_by_id: Option<String>,
    pub source_transcript_version_id: Option<String>,
    pub exact_quote: String,
    pub normalized_claim: String,
    pub speaker_id: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub segment_ids: Vec<String>,
    pub selection_rationale: Option<String>,
    pub consequence_score: Option<f32>,
    pub dispute_score: Option<f32>,
    pub specificity_score: Option<f32>,
    pub time_sensitive: bool,
    pub lifecycle: MeetingClaimVersionLifecycle,
    pub content_hash: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingClaimGateBatchBeginDto {
    pub id: String,
    pub idempotency_key: String,
    pub turns: Vec<MeetingClaimGateTurnDto>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingClaimGateTurnDto {
    pub id: String,
    pub speaker_id: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub revision_number: u64,
    pub source_kind: MeetingAudioSourceKind,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingManualFactCheckRequestUpsertDto {
    pub id: String,
    pub exact_selection: String,
    pub context_turns: Vec<MeetingClaimGateTurnDto>,
    pub source_segment_ids: Vec<String>,
    pub speaker_id: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub status: MeetingManualFactCheckRequestStatus,
    pub error: Option<MeetingTypedErrorDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingManualFactCheckRequestDto {
    pub id: String,
    pub meeting_id: String,
    pub exact_selection: String,
    pub context_turns: Vec<MeetingClaimGateTurnDto>,
    pub source_segment_ids: Vec<String>,
    pub speaker_id: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub status: MeetingManualFactCheckRequestStatus,
    pub error: Option<MeetingTypedErrorDto>,
    pub content_hash: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingClaimGateBatchDto {
    pub id: String,
    pub meeting_id: String,
    pub idempotency_key: String,
    pub segment_ids: Vec<String>,
    pub turns: Vec<MeetingClaimGateTurnDto>,
    pub created_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCitedStatementDto {
    pub text: String,
    pub citation_keys: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSourceInputDto {
    pub id: String,
    pub citation_key: String,
    pub url: String,
    pub canonical_url: String,
    pub publisher: String,
    pub title: String,
    pub publication_date: Option<String>,
    pub accessed_at_ms: i64,
    pub evidence_excerpt: String,
    pub stance: MeetingEvidenceStance,
    pub quality_score: Option<f32>,
    pub quality_rationale: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSourceDto {
    pub id: String,
    pub assessment_id: String,
    pub citation_key: String,
    pub url: String,
    pub canonical_url: String,
    pub publisher: String,
    pub title: String,
    pub publication_date: Option<String>,
    pub accessed_at_ms: i64,
    pub evidence_excerpt: String,
    pub stance: MeetingEvidenceStance,
    pub quality_score: Option<f32>,
    pub quality_rationale: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAssessmentApplyDto {
    pub id: String,
    pub claim_version_id: String,
    pub stage: MeetingAssessmentStage,
    pub attempt_number: u32,
    pub status: MeetingAssessmentStatus,
    pub supersedes_id: Option<String>,
    pub verdict: MeetingVerdict,
    pub confidence: MeetingConfidence,
    pub conclusion: Vec<MeetingCitedStatementDto>,
    pub support: Vec<MeetingCitedStatementDto>,
    pub contradiction: Vec<MeetingCitedStatementDto>,
    pub caveats: Vec<MeetingCitedStatementDto>,
    pub limitations: Vec<MeetingCitedStatementDto>,
    pub model_provider: String,
    pub model: String,
    pub model_version: Option<String>,
    pub usage: Option<serde_json::Value>,
    pub latency_ms: Option<i64>,
    pub started_at_ms: i64,
    pub completed_at_ms: i64,
    pub error: Option<MeetingTypedErrorDto>,
    pub sources: Vec<MeetingSourceInputDto>,
    pub set_current: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAssessmentDto {
    pub id: String,
    pub claim_version_id: String,
    pub stage: MeetingAssessmentStage,
    pub attempt_number: u32,
    pub status: MeetingAssessmentStatus,
    pub current: bool,
    pub supersedes_id: Option<String>,
    pub verdict: MeetingVerdict,
    pub confidence: MeetingConfidence,
    pub conclusion: Vec<MeetingCitedStatementDto>,
    pub support: Vec<MeetingCitedStatementDto>,
    pub contradiction: Vec<MeetingCitedStatementDto>,
    pub caveats: Vec<MeetingCitedStatementDto>,
    pub limitations: Vec<MeetingCitedStatementDto>,
    pub model_provider: String,
    pub model: String,
    pub model_version: Option<String>,
    pub usage: Option<serde_json::Value>,
    pub latency_ms: Option<i64>,
    pub started_at_ms: i64,
    pub completed_at_ms: i64,
    pub error: Option<MeetingTypedErrorDto>,
    pub sources: Vec<MeetingSourceDto>,
    pub created_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingResearchJobUpsertDto {
    pub id: String,
    pub claim_version_id: String,
    pub stage: MeetingAssessmentStage,
    pub gateway_job_id: Option<String>,
    pub idempotency_key: String,
    pub status: MeetingJobStatus,
    pub attempt_count: u32,
    pub next_retry_at_ms: Option<i64>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub error: Option<MeetingTypedErrorDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingResearchJobDto {
    pub id: String,
    pub claim_version_id: String,
    pub stage: MeetingAssessmentStage,
    pub gateway_job_id: Option<String>,
    pub idempotency_key: String,
    pub status: MeetingJobStatus,
    pub attempt_count: u32,
    pub next_retry_at_ms: Option<i64>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub error: Option<MeetingTypedErrorDto>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRefinementJobUpsertDto {
    pub id: String,
    pub source_transcript_version_id: String,
    pub input_manifest_checksum: String,
    pub provider: String,
    pub model: String,
    pub gateway_job_id: Option<String>,
    pub idempotency_key: String,
    pub status: MeetingRefinementJobStatus,
    pub attempt_count: u32,
    pub next_retry_at_ms: Option<i64>,
    pub usage: Option<serde_json::Value>,
    pub latency_ms: Option<i64>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub error: Option<MeetingTypedErrorDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRefinementJobDto {
    pub id: String,
    pub meeting_id: String,
    pub source_transcript_version_id: String,
    pub input_manifest_checksum: String,
    pub provider: String,
    pub model: String,
    pub gateway_job_id: Option<String>,
    pub idempotency_key: String,
    pub status: MeetingRefinementJobStatus,
    pub attempt_count: u32,
    pub next_retry_at_ms: Option<i64>,
    pub usage: Option<serde_json::Value>,
    pub latency_ms: Option<i64>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub error: Option<MeetingTypedErrorDto>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCleanupJobDto {
    pub id: String,
    pub meeting_id: String,
    pub local_status: MeetingCleanupStatus,
    pub gateway_status: MeetingCleanupStatus,
    pub provider_status: MeetingCleanupStatus,
    pub relative_audio_paths: Vec<String>,
    pub attempt_count: u32,
    pub next_retry_at_ms: Option<i64>,
    pub last_error: Option<MeetingTypedErrorDto>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingArtifactDto {
    pub meeting: MeetingDto,
    pub speakers: Vec<MeetingSpeakerDto>,
    pub speaker_observations: Vec<MeetingSpeakerObservationDto>,
    pub transcript_versions: Vec<MeetingTranscriptVersionDto>,
    pub transcript_segments: Vec<MeetingTranscriptSegmentDto>,
    pub timeline_events: Vec<MeetingTimelineEventDto>,
    pub audio_assets: Vec<MeetingAudioAssetDto>,
    pub refinement_inputs: Vec<MeetingRefinementInputDto>,
    pub claims: Vec<MeetingClaimDto>,
    pub claim_versions: Vec<MeetingClaimVersionDto>,
    pub manual_fact_check_requests: Vec<MeetingManualFactCheckRequestDto>,
    pub pending_claim_gate_segment_ids: Vec<String>,
    pub pending_claim_gate_batches: Vec<MeetingClaimGateBatchDto>,
    pub assessments: Vec<MeetingAssessmentDto>,
    pub research_jobs: Vec<MeetingResearchJobDto>,
    pub refinement_jobs: Vec<MeetingRefinementJobDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingListCursorDto {
    pub updated_at_ms: i64,
    pub meeting_id: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeetingListItemDto {
    pub meeting: MeetingDto,
    pub duration_ms: Option<i64>,
    pub speaker_names: Vec<String>,
    pub claim_count: u32,
    pub completed_research_count: u32,
    pub total_research_count: u32,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/create", response = MeetingCreateResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCreateRequest {
    pub title: Option<String>,
    pub artifact_type: MeetingArtifactType,
    pub mode: MeetingMode,
    pub started_at_ms: i64,
    pub capture_config: MeetingCaptureConfigDto,
    #[serde(default)]
    pub initial_speakers: Vec<MeetingSpeakerInputDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCreateResponse {
    pub meeting: MeetingDto,
    pub live_transcript_version: MeetingTranscriptVersionDto,
    pub speakers: Vec<MeetingSpeakerDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/update", response = MeetingUpdateResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingUpdateRequest {
    pub meeting_id: String,
    pub title: Option<String>,
    pub status: Option<MeetingLifecycleStatus>,
    pub ended_at_ms: Option<i64>,
    pub capture_status: Option<MeetingCaptureStatus>,
    pub refinement_status: Option<MeetingRefinementStatus>,
    pub research_status: Option<MeetingResearchStatus>,
    pub error: Option<MeetingTypedErrorDto>,
    pub clear_error: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingUpdateResponse {
    pub meeting: MeetingDto,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/list", response = MeetingListResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingListRequest {
    pub artifact_type: Option<MeetingArtifactType>,
    #[serde(default)]
    pub statuses: Vec<MeetingLifecycleStatus>,
    pub query: Option<String>,
    pub cursor: Option<MeetingListCursorDto>,
    pub limit: Option<u32>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingListResponse {
    pub items: Vec<MeetingListItemDto>,
    pub next_cursor: Option<MeetingListCursorDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/get", response = MeetingGetResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingGetRequest {
    pub meeting_id: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingGetResponse {
    pub artifact: MeetingArtifactDto,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/transcript/apply", response = MeetingTranscriptApplyResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranscriptApplyRequest {
    pub meeting_id: String,
    pub version: MeetingTranscriptVersionUpsertDto,
    #[serde(default)]
    pub segments: Vec<MeetingTranscriptSegmentUpsertDto>,
    #[serde(default)]
    pub speaker_observations: Vec<MeetingSpeakerObservationUpsertDto>,
    pub promote_canonical: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTranscriptApplyResponse {
    pub version: MeetingTranscriptVersionDto,
    pub segment_outcomes: Vec<MeetingUpsertOutcomeDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/speakers/apply", response = MeetingSpeakersApplyResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeakersApplyRequest {
    pub meeting_id: String,
    #[serde(default)]
    pub speakers: Vec<MeetingSpeakerInputDto>,
    #[serde(default)]
    pub swaps: Vec<MeetingSpeakerSwapDto>,
    #[serde(default)]
    pub segment_updates: Vec<MeetingSegmentSpeakerUpdateDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeakersApplyResponse {
    pub speakers: Vec<MeetingSpeakerDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/timeline/apply", response = MeetingTimelineApplyResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTimelineApplyRequest {
    pub meeting_id: String,
    #[serde(default)]
    pub events: Vec<MeetingTimelineEventUpsertDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTimelineApplyResponse {
    pub events: Vec<MeetingTimelineEventDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/audio/apply", response = MeetingAudioApplyResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAudioApplyRequest {
    pub meeting_id: String,
    #[serde(default)]
    pub assets: Vec<MeetingAudioAssetUpsertDto>,
    pub replace_refinement_manifest_for_job_id: Option<String>,
    #[serde(default)]
    pub refinement_inputs: Vec<MeetingRefinementInputUpsertDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAudioApplyResponse {
    pub assets: Vec<MeetingAudioAssetDto>,
    pub refinement_inputs: Vec<MeetingRefinementInputDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/claims/apply", response = MeetingClaimsApplyResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingClaimsApplyRequest {
    pub meeting_id: String,
    #[serde(default)]
    pub manual_fact_check_requests: Vec<MeetingManualFactCheckRequestUpsertDto>,
    #[serde(default)]
    pub claim_versions: Vec<MeetingClaimVersionUpsertDto>,
    #[serde(default)]
    pub mark_stale_claim_version_ids: Vec<String>,
    #[serde(default)]
    pub begin_claim_gate_batches: Vec<MeetingClaimGateBatchBeginDto>,
    #[serde(default)]
    pub complete_claim_gate_batch_ids: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingClaimsApplyResponse {
    pub claims: Vec<MeetingClaimDto>,
    pub claim_versions: Vec<MeetingClaimVersionDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/research/apply", response = MeetingResearchApplyResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingResearchApplyRequest {
    pub meeting_id: String,
    pub job: Option<MeetingResearchJobUpsertDto>,
    pub assessment: Option<MeetingAssessmentApplyDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingResearchApplyResponse {
    pub job: Option<MeetingResearchJobDto>,
    pub assessment: Option<MeetingAssessmentDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/refinement/job/apply", response = MeetingRefinementJobApplyResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRefinementJobApplyRequest {
    pub meeting_id: String,
    pub job: MeetingRefinementJobUpsertDto,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRefinementJobApplyResponse {
    pub job: MeetingRefinementJobDto,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/refinement/result/apply", response = MeetingRefinementResultApplyResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRefinementResultApplyRequest {
    pub meeting_id: String,
    pub refinement_job_id: String,
    pub version: MeetingTranscriptVersionUpsertDto,
    #[serde(default)]
    pub segments: Vec<MeetingTranscriptSegmentUpsertDto>,
    #[serde(default)]
    pub speaker_observations: Vec<MeetingSpeakerObservationUpsertDto>,
    #[serde(default)]
    pub mark_stale_claim_version_ids: Vec<String>,
    #[serde(default)]
    pub replacement_claim_versions: Vec<MeetingClaimVersionUpsertDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRefinementResultApplyResponse {
    pub canonical_version: MeetingTranscriptVersionDto,
    pub segment_outcomes: Vec<MeetingUpsertOutcomeDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/delete", response = MeetingDeleteResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDeleteRequest {
    pub meeting_id: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDeleteResponse {
    pub cleanup_job: MeetingCleanupJobDto,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/cleanup/confirm", response = MeetingCleanupConfirmResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCleanupConfirmRequest {
    pub cleanup_job_id: String,
    pub local_status: MeetingCleanupStatus,
    pub gateway_status: MeetingCleanupStatus,
    pub provider_status: MeetingCleanupStatus,
    pub error: Option<MeetingTypedErrorDto>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCleanupConfirmResponse {
    pub cleanup_job: Option<MeetingCleanupJobDto>,
    pub records_removed: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/meetings/recover", response = MeetingRecoverResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRecoverRequest {
    #[serde(default)]
    pub reconcile_active_work: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRecoverResponse {
    pub interrupted_meeting_ids: Vec<String>,
    pub refinement_job_ids: Vec<String>,
    pub research_job_ids: Vec<String>,
    pub cleanup_job_ids: Vec<String>,
    pub refinement_jobs: Vec<MeetingRefinementJobDto>,
    pub research_jobs: Vec<MeetingResearchJobDto>,
    pub cleanup_jobs: Vec<MeetingCleanupJobDto>,
}
