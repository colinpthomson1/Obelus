use super::MeetingStoreError;
use sqlx::{Pool, Sqlite};

pub const CURRENT_SCHEMA_VERSION: i32 = 3;

const SCHEMA_V1: &[&str] = &[
    r#"CREATE TABLE IF NOT EXISTS meeting_schema_version (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artifact_type TEXT NOT NULL CHECK (artifact_type IN ('meeting','text_check')),
        mode TEXT NOT NULL CHECK (mode IN ('call','in_person','text')),
        status TEXT NOT NULL CHECK (status IN ('setup','starting','recording','paused','stopping','finalizing','complete','interrupted','error')),
        started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
        ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
        capture_config_json TEXT NOT NULL CHECK (json_valid(capture_config_json)),
        canonical_transcript_version_id TEXT,
        capture_status TEXT NOT NULL CHECK (capture_status IN ('not_started','active','paused','finalizing','complete','interrupted','error')),
        refinement_status TEXT NOT NULL CHECK (refinement_status IN ('not_started','queued','uploading','processing','reconciling','complete','retry_wait','failed','cancelled')),
        research_status TEXT NOT NULL CHECK (research_status IN ('not_started','queued','running','partial','complete','retry_wait','failed','cancelled')),
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0,1)),
        deleted_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(canonical_transcript_version_id) REFERENCES transcript_versions(id) ON DELETE SET NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS speakers (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        default_label TEXT NOT NULL,
        display_name TEXT,
        display_name_source TEXT,
        manual_assignment_lock INTEGER NOT NULL DEFAULT 0 CHECK (manual_assignment_lock IN (0,1)),
        source_hint TEXT CHECK (source_hint IS NULL OR source_hint IN ('mixed','microphone','system','text')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(id, meeting_id),
        UNIQUE(meeting_id, default_label)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS transcript_versions (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('live','refined')),
        status TEXT NOT NULL CHECK (status IN ('active','processing','complete','failed','superseded')),
        revision_number INTEGER NOT NULL CHECK (revision_number >= 0),
        provider TEXT,
        model TEXT,
        gateway_job_id TEXT,
        parent_version_id TEXT REFERENCES transcript_versions(id) ON DELETE SET NULL,
        input_audio_checksum TEXT,
        detected_language TEXT,
        reconciliation_metadata_json TEXT CHECK (reconciliation_metadata_json IS NULL OR json_valid(reconciliation_metadata_json)),
        started_at_ms INTEGER,
        completed_at_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0,1)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(id, meeting_id),
        UNIQUE(meeting_id, kind, revision_number)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS speaker_observations (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        transcript_version_id TEXT NOT NULL,
        speaker_id TEXT REFERENCES speakers(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        provider_namespace TEXT NOT NULL,
        provider_speaker_label TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0,1)),
        revision_number INTEGER NOT NULL CHECK (revision_number >= 0),
        source_hint TEXT CHECK (source_hint IS NULL OR source_hint IN ('mixed','microphone','system','text')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(transcript_version_id, meeting_id) REFERENCES transcript_versions(id, meeting_id) ON DELETE CASCADE,
        UNIQUE(meeting_id, transcript_version_id, provider, provider_namespace, provider_speaker_label)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS transcript_segments (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        transcript_version_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_namespace TEXT NOT NULL,
        provider_session_id TEXT,
        provider_turn_id TEXT NOT NULL,
        provider_turn_order INTEGER NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number >= 0),
        state TEXT NOT NULL CHECK (state IN ('partial','final','revised','superseded')),
        speaker_id TEXT REFERENCES speakers(id) ON DELETE SET NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('mixed','microphone','system','text')),
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
        finalized_text TEXT NOT NULL,
        words_json TEXT NOT NULL CHECK (json_valid(words_json)),
        content_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(transcript_version_id, meeting_id) REFERENCES transcript_versions(id, meeting_id) ON DELETE CASCADE,
        UNIQUE(id, meeting_id),
        UNIQUE(meeting_id, transcript_version_id, provider, provider_namespace, provider_turn_id)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS transcript_segment_replacements (
        refined_segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
        live_segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE RESTRICT,
        PRIMARY KEY(refined_segment_id, live_segment_id)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS audio_assets (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('mixed','microphone','system','text')),
        timeline_part INTEGER NOT NULL CHECK (timeline_part >= 0),
        relative_path TEXT NOT NULL,
        format TEXT NOT NULL,
        sample_rate INTEGER NOT NULL CHECK (sample_rate > 0),
        channels INTEGER NOT NULL CHECK (channels > 0),
        timeline_start_ms INTEGER NOT NULL CHECK (timeline_start_ms >= 0),
        timeline_end_ms INTEGER CHECK (timeline_end_ms IS NULL OR timeline_end_ms >= timeline_start_ms),
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        bytes INTEGER CHECK (bytes IS NULL OR bytes >= 0),
        checksum TEXT,
        status TEXT NOT NULL CHECK (status IN ('recording','finalized','interrupted','missing','deleted')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(id, meeting_id),
        UNIQUE(meeting_id, source_kind, timeline_part, relative_path)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS timeline_events (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('pause','resume','sleep','wake','capture_gap','device_change','stt_reconnect_gap')),
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER CHECK (end_ms IS NULL OR end_ms >= start_ms),
        source_kind TEXT CHECK (source_kind IS NULL OR source_kind IN ('mixed','microphone','system','text')),
        provider_namespace TEXT,
        metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
        created_at_ms INTEGER NOT NULL,
        UNIQUE(id, meeting_id)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        origin TEXT NOT NULL CHECK (origin IN ('automatic','manual')),
        duplicate_key TEXT,
        status TEXT NOT NULL CHECK (status IN ('detected','queued','quick_running','preliminary','deep_running','complete','stale','rechecking','failed','cancelled','superseded')),
        current_claim_version_id TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(current_claim_version_id) REFERENCES claim_versions(id) ON DELETE SET NULL,
        UNIQUE(id, meeting_id)
    )"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_duplicate_key ON claims(meeting_id, duplicate_key) WHERE duplicate_key IS NOT NULL"#,
    r#"CREATE TABLE IF NOT EXISTS claim_versions (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL CHECK (version_number > 0),
        predecessor_id TEXT REFERENCES claim_versions(id) ON DELETE SET NULL,
        superseded_by_id TEXT REFERENCES claim_versions(id) ON DELETE SET NULL,
        source_transcript_version_id TEXT REFERENCES transcript_versions(id) ON DELETE SET NULL,
        exact_quote TEXT NOT NULL,
        normalized_claim TEXT NOT NULL,
        speaker_id TEXT REFERENCES speakers(id) ON DELETE SET NULL,
        start_ms INTEGER,
        end_ms INTEGER,
        selection_rationale TEXT,
        consequence_score REAL CHECK (consequence_score IS NULL OR (consequence_score >= 0 AND consequence_score <= 1)),
        dispute_score REAL CHECK (dispute_score IS NULL OR (dispute_score >= 0 AND dispute_score <= 1)),
        specificity_score REAL CHECK (specificity_score IS NULL OR (specificity_score >= 0 AND specificity_score <= 1)),
        time_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (time_sensitive IN (0,1)),
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','stale','rechecking','superseded')),
        content_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        CHECK (start_ms IS NULL OR start_ms >= 0),
        CHECK (end_ms IS NULL OR start_ms IS NULL OR end_ms >= start_ms),
        UNIQUE(claim_id, version_number)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS claim_version_segments (
        claim_version_id TEXT NOT NULL REFERENCES claim_versions(id) ON DELETE CASCADE,
        segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY(claim_version_id, segment_id),
        UNIQUE(claim_version_id, ordinal)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS assessments (
        id TEXT PRIMARY KEY,
        claim_version_id TEXT NOT NULL REFERENCES claim_versions(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK (stage IN ('preliminary','deep')),
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        status TEXT NOT NULL CHECK (status IN ('complete','failed')),
        is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
        supersedes_id TEXT REFERENCES assessments(id) ON DELETE SET NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('supported','mostly_supported','mixed','unsupported','unverifiable')),
        confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
        conclusion_json TEXT NOT NULL CHECK (json_valid(conclusion_json)),
        support_json TEXT NOT NULL CHECK (json_valid(support_json)),
        contradiction_json TEXT NOT NULL CHECK (json_valid(contradiction_json)),
        caveats_json TEXT NOT NULL CHECK (json_valid(caveats_json)),
        limitations_json TEXT NOT NULL CHECK (json_valid(limitations_json)),
        model_provider TEXT NOT NULL,
        model TEXT NOT NULL,
        model_version TEXT,
        usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
        latency_ms INTEGER,
        started_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0,1)),
        created_at_ms INTEGER NOT NULL,
        UNIQUE(claim_version_id, stage, attempt_number)
    )"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS idx_assessments_current ON assessments(claim_version_id, stage) WHERE is_current = 1"#,
    r#"CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
        citation_key TEXT NOT NULL,
        url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        publisher TEXT NOT NULL,
        title TEXT NOT NULL,
        publication_date TEXT,
        accessed_at_ms INTEGER NOT NULL,
        evidence_excerpt TEXT NOT NULL,
        stance TEXT NOT NULL CHECK (stance IN ('supports','contradicts','context')),
        quality_score REAL CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
        quality_rationale TEXT NOT NULL,
        UNIQUE(assessment_id, citation_key),
        UNIQUE(assessment_id, canonical_url)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS research_jobs (
        id TEXT PRIMARY KEY,
        claim_version_id TEXT NOT NULL REFERENCES claim_versions(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK (stage IN ('preliminary','deep')),
        gateway_job_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('pending','running','retry_wait','complete','failed','cancelled')),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        next_retry_at_ms INTEGER,
        started_at_ms INTEGER,
        completed_at_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0,1)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS transcript_refinement_jobs (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        source_transcript_version_id TEXT NOT NULL REFERENCES transcript_versions(id) ON DELETE RESTRICT,
        input_manifest_checksum TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        gateway_job_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('queued','uploading','processing','reconciling','complete','retry_wait','failed','cancelled')),
        attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
        next_retry_at_ms INTEGER,
        usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
        latency_ms INTEGER,
        started_at_ms INTEGER,
        completed_at_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0,1)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(id, meeting_id)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS refinement_inputs (
        refinement_job_id TEXT NOT NULL REFERENCES transcript_refinement_jobs(id) ON DELETE CASCADE,
        part_index INTEGER NOT NULL CHECK (part_index >= 0),
        audio_asset_id TEXT NOT NULL REFERENCES audio_assets(id) ON DELETE RESTRICT,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('mixed','microphone','system','text')),
        checksum TEXT NOT NULL,
        meeting_start_ms INTEGER NOT NULL,
        meeting_end_ms INTEGER NOT NULL,
        provider_start_ms INTEGER NOT NULL,
        provider_end_ms INTEGER NOT NULL,
        manifest_checksum TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        CHECK (meeting_start_ms >= 0 AND meeting_end_ms >= meeting_start_ms),
        CHECK (provider_start_ms >= 0 AND provider_end_ms >= provider_start_ms),
        PRIMARY KEY(refinement_job_id, part_index)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS cleanup_jobs (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        local_status TEXT NOT NULL CHECK (local_status IN ('pending','running','complete','retry_wait','failed','unavailable')),
        gateway_status TEXT NOT NULL CHECK (gateway_status IN ('pending','running','complete','retry_wait','failed','unavailable')),
        provider_status TEXT NOT NULL CHECK (provider_status IN ('pending','running','complete','retry_wait','failed','unavailable')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0,1)),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(meeting_id)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS cleanup_job_assets (
        cleanup_job_id TEXT NOT NULL REFERENCES cleanup_jobs(id) ON DELETE CASCADE,
        audio_asset_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        PRIMARY KEY(cleanup_job_id, audio_asset_id)
    )"#,
    r#"CREATE INDEX IF NOT EXISTS idx_meetings_history ON meetings(deleted_at_ms, updated_at_ms DESC, id DESC)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status, updated_at_ms DESC)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_segments_timeline ON transcript_segments(meeting_id, transcript_version_id, start_ms, provider_turn_order)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_segments_speaker ON transcript_segments(meeting_id, speaker_id, start_ms)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_timeline_events ON timeline_events(meeting_id, start_ms)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_claims_timeline ON claim_versions(claim_id, start_ms)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_research_jobs_recovery ON research_jobs(status, next_retry_at_ms)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_refinement_jobs_recovery ON transcript_refinement_jobs(status, next_retry_at_ms)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_cleanup_jobs_recovery ON cleanup_jobs(local_status, gateway_status, provider_status, next_retry_at_ms)"#,
];

const SCHEMA_V2: &[&str] = &[
    r#"CREATE TABLE IF NOT EXISTS claim_gate_segments (
        meeting_id TEXT NOT NULL,
        segment_id TEXT NOT NULL,
        queued_revision_number INTEGER NOT NULL CHECK (queued_revision_number >= 0),
        processed_revision_number INTEGER CHECK (processed_revision_number IS NULL OR processed_revision_number >= 0),
        enqueued_at_ms INTEGER NOT NULL,
        processed_at_ms INTEGER,
        PRIMARY KEY(meeting_id, segment_id),
        FOREIGN KEY(segment_id, meeting_id) REFERENCES transcript_segments(id, meeting_id) ON DELETE CASCADE
    )"#,
    r#"CREATE TABLE IF NOT EXISTS claim_gate_batches (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        processed_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        UNIQUE(id, meeting_id),
        UNIQUE(meeting_id, idempotency_key)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS claim_gate_batch_segments (
        batch_id TEXT NOT NULL REFERENCES claim_gate_batches(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
        segment_revision_number INTEGER NOT NULL CHECK (segment_revision_number >= 0),
        snapshot_speaker_id TEXT,
        snapshot_start_ms INTEGER NOT NULL CHECK (snapshot_start_ms >= 0),
        snapshot_end_ms INTEGER NOT NULL CHECK (snapshot_end_ms >= snapshot_start_ms),
        snapshot_text TEXT NOT NULL,
        snapshot_source_kind TEXT NOT NULL CHECK (snapshot_source_kind IN ('mixed','microphone','system','text')),
        PRIMARY KEY(batch_id, ordinal),
        UNIQUE(batch_id, segment_id)
    )"#,
    r#"CREATE INDEX IF NOT EXISTS idx_claim_gate_segments_pending
        ON claim_gate_segments(meeting_id, enqueued_at_ms, segment_id)
        WHERE processed_revision_number IS NULL OR queued_revision_number > processed_revision_number"#,
    r#"CREATE INDEX IF NOT EXISTS idx_claim_gate_batches_pending
        ON claim_gate_batches(meeting_id, created_at_ms, id)
        WHERE processed_at_ms IS NULL"#,
    r#"CREATE INDEX IF NOT EXISTS idx_claim_gate_batch_segment_revision
        ON claim_gate_batch_segments(segment_id, segment_revision_number, batch_id)"#,
    r#"INSERT OR IGNORE INTO claim_gate_segments (
        meeting_id, segment_id, queued_revision_number, enqueued_at_ms
    ) SELECT ts.meeting_id, ts.id, ts.revision_number, ts.updated_at_ms
      FROM transcript_segments ts
      JOIN transcript_versions tv ON tv.id = ts.transcript_version_id
      WHERE tv.kind = 'live' AND ts.state IN ('final', 'revised')"#,
];

const SCHEMA_V3: &[&str] = &[
    r#"CREATE TABLE IF NOT EXISTS manual_fact_check_requests (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        exact_selection TEXT NOT NULL,
        speaker_id TEXT,
        start_ms INTEGER,
        end_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN ('queued','processing','retry_wait','complete','failed')),
        error_code TEXT,
        error_message TEXT,
        error_retryable INTEGER NOT NULL DEFAULT 0 CHECK (error_retryable IN (0,1)),
        content_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(id, meeting_id),
        CHECK ((start_ms IS NULL AND end_ms IS NULL) OR
               (start_ms IS NOT NULL AND start_ms >= 0 AND
                (end_ms IS NULL OR end_ms >= start_ms)))
    )"#,
    r#"CREATE TABLE IF NOT EXISTS manual_fact_check_request_context_turns (
        request_id TEXT NOT NULL REFERENCES manual_fact_check_requests(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        turn_id TEXT NOT NULL,
        speaker_id TEXT,
        start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
        end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
        finalized_text TEXT NOT NULL,
        revision_number INTEGER NOT NULL CHECK (revision_number >= 0),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('mixed','microphone','system','text')),
        PRIMARY KEY(request_id, ordinal),
        UNIQUE(request_id, turn_id)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS manual_fact_check_request_segments (
        request_id TEXT NOT NULL REFERENCES manual_fact_check_requests(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE RESTRICT,
        PRIMARY KEY(request_id, ordinal),
        UNIQUE(request_id, segment_id)
    )"#,
    r#"ALTER TABLE claims ADD COLUMN manual_request_id TEXT REFERENCES manual_fact_check_requests(id) ON DELETE CASCADE"#,
    r#"CREATE INDEX IF NOT EXISTS idx_manual_fact_check_requests_status
        ON manual_fact_check_requests(meeting_id, status, updated_at_ms, id)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_claims_manual_request
        ON claims(meeting_id, manual_request_id, created_at_ms, id)"#,
];

pub async fn migrate(pool: &Pool<Sqlite>) -> Result<(), MeetingStoreError> {
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(MeetingStoreError::database)?;
    let table_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meeting_schema_version')",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(MeetingStoreError::database)?;
    let current = if table_exists {
        sqlx::query_scalar::<_, Option<i32>>("SELECT MAX(version) FROM meeting_schema_version")
            .fetch_one(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?
            .unwrap_or(0)
    } else {
        0
    };
    if current > CURRENT_SCHEMA_VERSION {
        return Err(MeetingStoreError::schema_too_new());
    }
    for version in (current + 1)..=CURRENT_SCHEMA_VERSION {
        apply_migration(&mut tx, version).await?;
        sqlx::query("INSERT INTO meeting_schema_version(version, applied_at_ms) VALUES (?, ?)")
            .bind(version)
            .bind(chrono::Utc::now().timestamp_millis())
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
    }
    tx.commit().await.map_err(MeetingStoreError::database)
}

async fn apply_migration(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    version: i32,
) -> Result<(), MeetingStoreError> {
    match version {
        1 => {
            for statement in SCHEMA_V1 {
                sqlx::query(statement)
                    .execute(&mut **tx)
                    .await
                    .map_err(MeetingStoreError::database)?;
            }
        }
        2 => {
            for statement in SCHEMA_V2 {
                sqlx::query(statement)
                    .execute(&mut **tx)
                    .await
                    .map_err(MeetingStoreError::database)?;
            }
        }
        3 => {
            for statement in SCHEMA_V3 {
                sqlx::query(statement)
                    .execute(&mut **tx)
                    .await
                    .map_err(MeetingStoreError::database)?;
            }
        }
        _ => return Err(MeetingStoreError::unknown_migration()),
    }
    Ok(())
}
