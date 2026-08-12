use super::migrations;
use super::validation;
use super::{MEETINGS_AUDIO_FOLDER, MEETINGS_DB_NAME, MEETINGS_FOLDER};
use goose_sdk_types::custom_requests::*;
use serde::de::DeserializeOwned;
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow};
use sqlx::{Pool, QueryBuilder, Row, Sqlite};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum MeetingStoreError {
    #[error("invalid meeting request: {0}")]
    Validation(&'static str),
    #[error("meeting artifact not found")]
    NotFound,
    #[error("meeting artifact conflicts with existing data")]
    Conflict,
    #[error("meeting storage schema is newer than this application")]
    SchemaTooNew,
    #[error("meeting storage operation failed")]
    Database(#[source] sqlx::Error),
    #[error("meeting storage serialization failed")]
    Serialization,
    #[error("meeting storage initialization failed")]
    Initialization,
}

impl MeetingStoreError {
    pub(crate) fn validation(message: &'static str) -> Self {
        Self::Validation(message)
    }

    pub(crate) fn database(error: sqlx::Error) -> Self {
        Self::Database(error)
    }

    pub(crate) fn schema_too_new() -> Self {
        Self::SchemaTooNew
    }

    pub(crate) fn unknown_migration() -> Self {
        Self::Initialization
    }
}

pub struct MeetingStore {
    pool: Pool<Sqlite>,
    initialized: tokio::sync::OnceCell<()>,
    database_path: PathBuf,
    audio_root: PathBuf,
}

impl MeetingStore {
    pub fn new(data_dir: PathBuf) -> Result<Self, MeetingStoreError> {
        let meeting_dir = data_dir.join(MEETINGS_FOLDER);
        let audio_root = meeting_dir.join(MEETINGS_AUDIO_FOLDER);
        std::fs::create_dir_all(&audio_root).map_err(|_| MeetingStoreError::Initialization)?;
        let database_path = meeting_dir.join(MEETINGS_DB_NAME);
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(30))
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect_lazy_with(options);
        Ok(Self {
            pool,
            initialized: tokio::sync::OnceCell::new(),
            database_path,
            audio_root,
        })
    }

    pub async fn initialize(&self) -> Result<(), MeetingStoreError> {
        self.initialized
            .get_or_try_init(|| async { migrations::migrate(&self.pool).await })
            .await
            .map(|_| ())
    }

    pub fn database_path(&self) -> &std::path::Path {
        &self.database_path
    }

    pub fn audio_root(&self) -> &std::path::Path {
        &self.audio_root
    }

    async fn pool(&self) -> Result<&Pool<Sqlite>, MeetingStoreError> {
        self.initialize().await?;
        Ok(&self.pool)
    }

    pub async fn create_meeting(
        &self,
        request: MeetingCreateRequest,
    ) -> Result<MeetingCreateResponse, MeetingStoreError> {
        validation::timestamp_range(request.started_at_ms, None)?;
        validation::optional(
            request.title.as_deref(),
            validation::MAX_TITLE_BYTES,
            "invalid meeting title",
        )?;
        validation::json_size(Some(&encode_value(&request.capture_config)?))?;
        if request.initial_speakers.len() > validation::MAX_SPEAKERS_PER_BATCH {
            return Err(MeetingStoreError::validation("too many speakers"));
        }
        validate_capture_config(&request.capture_config)?;
        for speaker in &request.initial_speakers {
            validate_speaker_input(speaker)?;
        }

        let pool = self.pool().await?;
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(MeetingStoreError::database)?;
        let now = now_ms();
        let meeting_id = Uuid::now_v7().to_string();
        let live_version_id = Uuid::now_v7().to_string();
        let title = request
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Untitled meeting");
        let initial_status = if request.artifact_type == MeetingArtifactType::TextCheck {
            MeetingLifecycleStatus::Complete
        } else {
            MeetingLifecycleStatus::Recording
        };
        let capture_status = if request.artifact_type == MeetingArtifactType::TextCheck {
            MeetingCaptureStatus::Complete
        } else {
            MeetingCaptureStatus::Active
        };
        sqlx::query(
            r#"INSERT INTO meetings (
                id, title, artifact_type, mode, status, started_at_ms,
                capture_config_json, canonical_transcript_version_id, capture_status,
                refinement_status, research_status, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&meeting_id)
        .bind(title)
        .bind(enum_string(&request.artifact_type)?)
        .bind(enum_string(&request.mode)?)
        .bind(enum_string(&initial_status)?)
        .bind(request.started_at_ms)
        .bind(json_string(&request.capture_config)?)
        .bind(Option::<&str>::None)
        .bind(enum_string(&capture_status)?)
        .bind(enum_string(&MeetingRefinementStatus::NotStarted)?)
        .bind(enum_string(&MeetingResearchStatus::NotStarted)?)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(MeetingStoreError::database)?;
        sqlx::query(
            r#"INSERT INTO transcript_versions (
                id, meeting_id, kind, status, revision_number, provider,
                started_at_ms, created_at_ms, updated_at_ms
            ) VALUES (?, ?, 'live', ?, 1, 'assemblyai', ?, ?, ?)"#,
        )
        .bind(&live_version_id)
        .bind(&meeting_id)
        .bind(enum_string(&MeetingTranscriptVersionStatus::Active)?)
        .bind(request.started_at_ms)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(MeetingStoreError::database)?;
        sqlx::query("UPDATE meetings SET canonical_transcript_version_id = ? WHERE id = ?")
            .bind(&live_version_id)
            .bind(&meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;

        for (index, speaker) in request.initial_speakers.iter().enumerate() {
            let speaker_id = speaker
                .id
                .clone()
                .unwrap_or_else(|| Uuid::now_v7().to_string());
            validation::uuid(&speaker_id)?;
            let default_label = if speaker.default_label.trim().is_empty() {
                format!("Speaker {}", index + 1)
            } else {
                speaker.default_label.trim().to_string()
            };
            insert_speaker(
                &mut tx,
                &meeting_id,
                &speaker_id,
                &default_label,
                speaker,
                now,
            )
            .await?;
        }
        tx.commit().await.map_err(MeetingStoreError::database)?;

        let meeting = self.get_meeting(&meeting_id, false).await?;
        let live_transcript_version = self.get_transcript_version(&live_version_id).await?;
        let speakers = self.list_speakers(&meeting_id).await?;
        Ok(MeetingCreateResponse {
            meeting,
            live_transcript_version,
            speakers,
        })
    }

    pub async fn update_meeting(
        &self,
        request: MeetingUpdateRequest,
    ) -> Result<MeetingUpdateResponse, MeetingStoreError> {
        validation::uuid(&request.meeting_id)?;
        validation::optional(
            request.title.as_deref(),
            validation::MAX_TITLE_BYTES,
            "invalid meeting title",
        )?;
        validation::typed_error(request.error.as_ref())?;
        let existing = self.get_meeting(&request.meeting_id, false).await?;
        validation::timestamp_range(
            existing.started_at_ms,
            request.ended_at_ms.or(existing.ended_at_ms),
        )?;
        let title = request.title.unwrap_or(existing.title);
        let status = request.status.unwrap_or(existing.status);
        let capture_status = request.capture_status.unwrap_or(existing.capture_status);
        let refinement_status = request
            .refinement_status
            .unwrap_or(existing.refinement_status);
        let research_status = request.research_status.unwrap_or(existing.research_status);
        let error = if request.clear_error {
            None
        } else {
            request.error.or(existing.last_error)
        };
        let now = now_ms();
        sqlx::query(
            r#"UPDATE meetings SET title = ?, status = ?, ended_at_ms = ?, capture_status = ?,
               refinement_status = ?, research_status = ?, error_code = ?, error_message = ?,
               error_retryable = ?, updated_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL"#,
        )
        .bind(title.trim())
        .bind(enum_string(&status)?)
        .bind(request.ended_at_ms.or(existing.ended_at_ms))
        .bind(enum_string(&capture_status)?)
        .bind(enum_string(&refinement_status)?)
        .bind(enum_string(&research_status)?)
        .bind(error.as_ref().map(|value| value.code.as_str()))
        .bind(error.as_ref().map(|value| value.message.as_str()))
        .bind(error.as_ref().is_some_and(|value| value.retryable))
        .bind(now)
        .bind(&request.meeting_id)
        .execute(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        Ok(MeetingUpdateResponse {
            meeting: self.get_meeting(&request.meeting_id, false).await?,
        })
    }

    pub async fn list_meetings(
        &self,
        request: MeetingListRequest,
    ) -> Result<MeetingListResponse, MeetingStoreError> {
        if request.statuses.len() > 16 {
            return Err(MeetingStoreError::validation("too many status filters"));
        }
        validation::optional(
            request.query.as_deref(),
            256,
            "invalid meeting search query",
        )?;
        if let Some(cursor) = &request.cursor {
            validation::uuid(&cursor.meeting_id)?;
            if cursor.updated_at_ms < 0 {
                return Err(MeetingStoreError::validation("invalid meeting list cursor"));
            }
        }
        let limit = request
            .limit
            .unwrap_or(validation::DEFAULT_PAGE_SIZE)
            .clamp(1, validation::MAX_PAGE_SIZE);
        let mut builder = QueryBuilder::<Sqlite>::new(
            r#"SELECT m.*,
                (SELECT COUNT(*) FROM claims c WHERE c.meeting_id = m.id) AS claim_count,
                (SELECT COUNT(*) FROM research_jobs r JOIN claim_versions cv ON cv.id = r.claim_version_id
                  JOIN claims c ON c.id = cv.claim_id WHERE c.meeting_id = m.id) AS total_research_count,
                (SELECT COUNT(*) FROM research_jobs r JOIN claim_versions cv ON cv.id = r.claim_version_id
                  JOIN claims c ON c.id = cv.claim_id WHERE c.meeting_id = m.id AND r.status = 'complete') AS completed_research_count
                FROM meetings m WHERE m.deleted_at_ms IS NULL"#,
        );
        if let Some(artifact_type) = request.artifact_type {
            builder
                .push(" AND m.artifact_type = ")
                .push_bind(enum_string(&artifact_type)?);
        }
        if !request.statuses.is_empty() {
            builder.push(" AND m.status IN (");
            let mut separated = builder.separated(", ");
            for status in &request.statuses {
                separated.push_bind(enum_string(status)?);
            }
            separated.push_unseparated(")");
        }
        if let Some(query) = request
            .query
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            builder
                .push(" AND (instr(lower(m.title), lower(")
                .push_bind(query)
                .push(")) > 0 OR EXISTS (SELECT 1 FROM transcript_segments ts WHERE ts.meeting_id = m.id AND instr(lower(ts.finalized_text), lower(")
                .push_bind(query)
                .push(")) > 0))");
        }
        if let Some(cursor) = &request.cursor {
            builder
                .push(" AND (m.updated_at_ms < ")
                .push_bind(cursor.updated_at_ms)
                .push(" OR (m.updated_at_ms = ")
                .push_bind(cursor.updated_at_ms)
                .push(" AND m.id < ")
                .push_bind(&cursor.meeting_id)
                .push("))");
        }
        builder
            .push(" ORDER BY m.updated_at_ms DESC, m.id DESC LIMIT ")
            .push_bind(i64::from(limit + 1));
        let rows = builder
            .build()
            .fetch_all(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?;
        let has_more = rows.len() > limit as usize;
        let mut items = Vec::with_capacity(rows.len().min(limit as usize));
        for row in rows.into_iter().take(limit as usize) {
            let meeting = meeting_from_row(&row)?;
            let speakers = self.list_speakers(&meeting.id).await?;
            items.push(MeetingListItemDto {
                duration_ms: meeting
                    .ended_at_ms
                    .map(|ended| ended.saturating_sub(meeting.started_at_ms)),
                speaker_names: speakers
                    .into_iter()
                    .map(|speaker| speaker.display_name.unwrap_or(speaker.default_label))
                    .collect(),
                claim_count: row.try_get::<i64, _>("claim_count").unwrap_or(0).max(0) as u32,
                completed_research_count: row
                    .try_get::<i64, _>("completed_research_count")
                    .unwrap_or(0)
                    .max(0) as u32,
                total_research_count: row
                    .try_get::<i64, _>("total_research_count")
                    .unwrap_or(0)
                    .max(0) as u32,
                meeting,
            });
        }
        let next_cursor = has_more && !items.is_empty();
        Ok(MeetingListResponse {
            next_cursor: next_cursor.then(|| {
                let meeting = &items.last().expect("checked non-empty").meeting;
                MeetingListCursorDto {
                    updated_at_ms: meeting.updated_at_ms,
                    meeting_id: meeting.id.clone(),
                }
            }),
            items,
        })
    }

    async fn get_meeting(
        &self,
        meeting_id: &str,
        include_deleted: bool,
    ) -> Result<MeetingDto, MeetingStoreError> {
        let sql = if include_deleted {
            "SELECT * FROM meetings WHERE id = ?"
        } else {
            "SELECT * FROM meetings WHERE id = ? AND deleted_at_ms IS NULL"
        };
        let row = sqlx::query(sql)
            .bind(meeting_id)
            .fetch_optional(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?
            .ok_or(MeetingStoreError::NotFound)?;
        meeting_from_row(&row)
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn enum_string<T: Serialize>(value: &T) -> Result<String, MeetingStoreError> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .ok_or(MeetingStoreError::Serialization)
}

fn enum_from_str<T: DeserializeOwned>(value: &str) -> Result<T, MeetingStoreError> {
    serde_json::from_value(serde_json::Value::String(value.to_string()))
        .map_err(|_| MeetingStoreError::Serialization)
}

fn json_string<T: Serialize>(value: &T) -> Result<String, MeetingStoreError> {
    serde_json::to_string(value).map_err(|_| MeetingStoreError::Serialization)
}

fn json_from_str<T: DeserializeOwned>(value: &str) -> Result<T, MeetingStoreError> {
    serde_json::from_str(value).map_err(|_| MeetingStoreError::Serialization)
}

fn encode_value<T: Serialize>(value: &T) -> Result<serde_json::Value, MeetingStoreError> {
    serde_json::to_value(value).map_err(|_| MeetingStoreError::Serialization)
}

fn typed_error_from_row(
    row: &SqliteRow,
) -> Result<Option<MeetingTypedErrorDto>, MeetingStoreError> {
    let code: Option<String> = row
        .try_get("error_code")
        .map_err(MeetingStoreError::database)?;
    let message: Option<String> = row
        .try_get("error_message")
        .map_err(MeetingStoreError::database)?;
    Ok(match (code, message) {
        (Some(code), Some(message)) => Some(MeetingTypedErrorDto {
            code,
            message,
            retryable: row
                .try_get::<bool, _>("error_retryable")
                .map_err(MeetingStoreError::database)?,
        }),
        _ => None,
    })
}

fn meeting_from_row(row: &SqliteRow) -> Result<MeetingDto, MeetingStoreError> {
    Ok(MeetingDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        title: row.try_get("title").map_err(MeetingStoreError::database)?,
        artifact_type: enum_from_str(
            &row.try_get::<String, _>("artifact_type")
                .map_err(MeetingStoreError::database)?,
        )?,
        mode: enum_from_str(
            &row.try_get::<String, _>("mode")
                .map_err(MeetingStoreError::database)?,
        )?,
        status: enum_from_str(
            &row.try_get::<String, _>("status")
                .map_err(MeetingStoreError::database)?,
        )?,
        started_at_ms: row
            .try_get("started_at_ms")
            .map_err(MeetingStoreError::database)?,
        ended_at_ms: row
            .try_get("ended_at_ms")
            .map_err(MeetingStoreError::database)?,
        capture_config: json_from_str(
            &row.try_get::<String, _>("capture_config_json")
                .map_err(MeetingStoreError::database)?,
        )?,
        canonical_transcript_version_id: row
            .try_get("canonical_transcript_version_id")
            .map_err(MeetingStoreError::database)?,
        capture_status: enum_from_str(
            &row.try_get::<String, _>("capture_status")
                .map_err(MeetingStoreError::database)?,
        )?,
        refinement_status: enum_from_str(
            &row.try_get::<String, _>("refinement_status")
                .map_err(MeetingStoreError::database)?,
        )?,
        research_status: enum_from_str(
            &row.try_get::<String, _>("research_status")
                .map_err(MeetingStoreError::database)?,
        )?,
        last_error: typed_error_from_row(row)?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

fn validate_capture_config(config: &MeetingCaptureConfigDto) -> Result<(), MeetingStoreError> {
    validation::optional(
        config.microphone_device_id.as_deref(),
        512,
        "invalid microphone device identifier",
    )?;
    if config
        .exact_speaker_count
        .is_some_and(|count| !(1..=64).contains(&count))
    {
        return Err(MeetingStoreError::validation("invalid exact speaker count"));
    }
    Ok(())
}

fn validate_speaker_input(speaker: &MeetingSpeakerInputDto) -> Result<(), MeetingStoreError> {
    if let Some(id) = &speaker.id {
        validation::uuid(id)?;
    }
    validation::optional(Some(&speaker.default_label), 256, "invalid speaker label")?;
    validation::optional(
        speaker.display_name.as_deref(),
        256,
        "invalid speaker display name",
    )?;
    validation::optional(
        speaker.display_name_source.as_deref(),
        128,
        "invalid speaker name source",
    )
}

async fn insert_speaker(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    speaker_id: &str,
    default_label: &str,
    speaker: &MeetingSpeakerInputDto,
    now: i64,
) -> Result<(), MeetingStoreError> {
    sqlx::query(
        r#"INSERT INTO speakers (
            id, meeting_id, default_label, display_name, display_name_source,
            manual_assignment_lock, source_hint, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(speaker_id)
    .bind(meeting_id)
    .bind(default_label)
    .bind(speaker.display_name.as_deref().map(str::trim))
    .bind(speaker.display_name_source.as_deref())
    .bind(speaker.manual_assignment_lock)
    .bind(
        speaker
            .source_hint
            .map(|value| enum_string(&value))
            .transpose()?,
    )
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(map_constraint_conflict)?;
    Ok(())
}

impl MeetingStore {
    pub async fn apply_transcript(
        &self,
        request: MeetingTranscriptApplyRequest,
    ) -> Result<MeetingTranscriptApplyResponse, MeetingStoreError> {
        validate_transcript_request(&request)?;
        self.get_meeting(&request.meeting_id, false).await?;
        let pool = self.pool().await?;
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(MeetingStoreError::database)?;
        upsert_transcript_version(&mut tx, &request.meeting_id, &request.version).await?;
        let mut outcomes = Vec::with_capacity(request.segments.len());
        for segment in &request.segments {
            let outcome = upsert_transcript_segment(&mut tx, &request.meeting_id, segment).await?;
            if request.version.kind == MeetingTranscriptVersionKind::Live
                && matches!(
                    segment.state,
                    MeetingTranscriptSegmentState::Final | MeetingTranscriptSegmentState::Revised
                )
                && matches!(
                    outcome.outcome,
                    MeetingUpsertOutcomeKind::Inserted | MeetingUpsertOutcomeKind::Revised
                )
            {
                enqueue_claim_gate_segment(
                    &mut tx,
                    &request.meeting_id,
                    &segment.id,
                    segment.revision_number,
                    now_ms(),
                )
                .await?;
            }
            outcomes.push(outcome);
        }
        for observation in &request.speaker_observations {
            upsert_speaker_observation(&mut tx, &request.meeting_id, observation).await?;
        }
        if request.promote_canonical {
            if request.version.status != MeetingTranscriptVersionStatus::Complete {
                return Err(MeetingStoreError::validation(
                    "only a complete transcript can become canonical",
                ));
            }
            sqlx::query(
                "UPDATE meetings SET canonical_transcript_version_id = ?, updated_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL",
            )
            .bind(&request.version.id)
            .bind(now_ms())
            .bind(&request.meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
        }
        tx.commit().await.map_err(MeetingStoreError::database)?;
        Ok(MeetingTranscriptApplyResponse {
            version: self.get_transcript_version(&request.version.id).await?,
            segment_outcomes: outcomes,
        })
    }

    pub async fn apply_speakers(
        &self,
        request: MeetingSpeakersApplyRequest,
    ) -> Result<MeetingSpeakersApplyResponse, MeetingStoreError> {
        validation::uuid(&request.meeting_id)?;
        if request.speakers.len() > validation::MAX_SPEAKERS_PER_BATCH
            || request.swaps.len() > validation::MAX_SPEAKERS_PER_BATCH
            || request.segment_updates.len() > validation::MAX_SEGMENTS_PER_BATCH
        {
            return Err(MeetingStoreError::validation(
                "speaker update batch is too large",
            ));
        }
        self.get_meeting(&request.meeting_id, false).await?;
        for speaker in &request.speakers {
            validate_speaker_input(speaker)?;
            let id = speaker.id.as_deref().ok_or(MeetingStoreError::validation(
                "speaker identifier is required",
            ))?;
            validation::uuid(id)?;
        }
        let pool = self.pool().await?;
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(MeetingStoreError::database)?;
        let now = now_ms();
        for speaker in &request.speakers {
            let id = speaker.id.as_deref().expect("validated");
            let existing = sqlx::query(
                "SELECT manual_assignment_lock FROM speakers WHERE id = ? AND meeting_id = ?",
            )
            .bind(id)
            .bind(&request.meeting_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
            if let Some(existing) = existing {
                let locked: bool = existing
                    .try_get("manual_assignment_lock")
                    .map_err(MeetingStoreError::database)?;
                if locked && !speaker.manual_assignment_lock {
                    sqlx::query(
                        "UPDATE speakers SET default_label = ?, source_hint = COALESCE(?, source_hint), updated_at_ms = ? WHERE id = ? AND meeting_id = ?",
                    )
                    .bind(speaker.default_label.trim())
                    .bind(speaker.source_hint.map(|value| enum_string(&value)).transpose()?)
                    .bind(now)
                    .bind(id)
                    .bind(&request.meeting_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(MeetingStoreError::database)?;
                } else {
                    sqlx::query(
                        r#"UPDATE speakers SET default_label = ?, display_name = ?, display_name_source = ?,
                           manual_assignment_lock = ?, source_hint = ?, updated_at_ms = ?
                           WHERE id = ? AND meeting_id = ?"#,
                    )
                    .bind(speaker.default_label.trim())
                    .bind(speaker.display_name.as_deref().map(str::trim))
                    .bind(speaker.display_name_source.as_deref())
                    .bind(speaker.manual_assignment_lock)
                    .bind(speaker.source_hint.map(|value| enum_string(&value)).transpose()?)
                    .bind(now)
                    .bind(id)
                    .bind(&request.meeting_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(MeetingStoreError::database)?;
                }
            } else {
                insert_speaker(
                    &mut tx,
                    &request.meeting_id,
                    id,
                    speaker.default_label.trim(),
                    speaker,
                    now,
                )
                .await?;
            }
        }
        for swap in &request.swaps {
            validation::uuid(&swap.first_speaker_id)?;
            validation::uuid(&swap.second_speaker_id)?;
            if swap.first_speaker_id == swap.second_speaker_id {
                return Err(MeetingStoreError::validation(
                    "speaker swap identifiers must differ",
                ));
            }
            let rows = sqlx::query(
                "SELECT id, display_name, display_name_source, manual_assignment_lock FROM speakers WHERE meeting_id = ? AND id IN (?, ?)",
            )
            .bind(&request.meeting_id)
            .bind(&swap.first_speaker_id)
            .bind(&swap.second_speaker_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
            if rows.len() != 2 {
                return Err(MeetingStoreError::NotFound);
            }
            let mut values = HashMap::new();
            for row in rows {
                values.insert(
                    row.try_get::<String, _>("id")
                        .map_err(MeetingStoreError::database)?,
                    (
                        row.try_get::<Option<String>, _>("display_name")
                            .map_err(MeetingStoreError::database)?,
                        row.try_get::<Option<String>, _>("display_name_source")
                            .map_err(MeetingStoreError::database)?,
                        row.try_get::<bool, _>("manual_assignment_lock")
                            .map_err(MeetingStoreError::database)?,
                    ),
                );
            }
            let first = values
                .get(&swap.first_speaker_id)
                .cloned()
                .ok_or(MeetingStoreError::NotFound)?;
            let second = values
                .get(&swap.second_speaker_id)
                .cloned()
                .ok_or(MeetingStoreError::NotFound)?;
            for (id, value) in [
                (&swap.first_speaker_id, second),
                (&swap.second_speaker_id, first),
            ] {
                sqlx::query(
                    "UPDATE speakers SET display_name = ?, display_name_source = ?, manual_assignment_lock = ?, updated_at_ms = ? WHERE id = ? AND meeting_id = ?",
                )
                .bind(value.0)
                .bind(value.1)
                .bind(value.2)
                .bind(now)
                .bind(id)
                .bind(&request.meeting_id)
                .execute(&mut *tx)
                .await
                .map_err(MeetingStoreError::database)?;
            }
        }
        for update in &request.segment_updates {
            validation::uuid(&update.segment_id)?;
            validation::uuid(&update.speaker_id)?;
            let result = sqlx::query(
                r#"UPDATE transcript_segments SET speaker_id = ?, updated_at_ms = ?
                   WHERE id = ? AND meeting_id = ?
                     AND EXISTS (SELECT 1 FROM speakers WHERE id = ? AND meeting_id = ?)"#,
            )
            .bind(&update.speaker_id)
            .bind(now)
            .bind(&update.segment_id)
            .bind(&request.meeting_id)
            .bind(&update.speaker_id)
            .bind(&request.meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
            if result.rows_affected() != 1 {
                return Err(MeetingStoreError::NotFound);
            }
        }
        sqlx::query("UPDATE meetings SET updated_at_ms = ? WHERE id = ?")
            .bind(now)
            .bind(&request.meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
        tx.commit().await.map_err(MeetingStoreError::database)?;
        Ok(MeetingSpeakersApplyResponse {
            speakers: self.list_speakers(&request.meeting_id).await?,
        })
    }

    async fn list_speakers(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingSpeakerDto>, MeetingStoreError> {
        let rows = sqlx::query(
            "SELECT * FROM speakers WHERE meeting_id = ? ORDER BY created_at_ms, default_label, id",
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        rows.iter().map(speaker_from_row).collect()
    }

    async fn get_transcript_version(
        &self,
        version_id: &str,
    ) -> Result<MeetingTranscriptVersionDto, MeetingStoreError> {
        let row = sqlx::query("SELECT * FROM transcript_versions WHERE id = ?")
            .bind(version_id)
            .fetch_optional(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?
            .ok_or(MeetingStoreError::NotFound)?;
        transcript_version_from_row(&row)
    }
}

fn validate_transcript_request(
    request: &MeetingTranscriptApplyRequest,
) -> Result<(), MeetingStoreError> {
    validation::uuid(&request.meeting_id)?;
    validate_transcript_version(&request.version)?;
    if request.segments.len() > validation::MAX_SEGMENTS_PER_BATCH
        || request.speaker_observations.len() > validation::MAX_SEGMENTS_PER_BATCH
    {
        return Err(MeetingStoreError::validation(
            "transcript batch is too large",
        ));
    }
    for segment in &request.segments {
        validate_transcript_segment(segment, &request.version.id)?;
    }
    for observation in &request.speaker_observations {
        validate_speaker_observation(observation, &request.version.id)?;
    }
    Ok(())
}

fn validate_transcript_version(
    value: &MeetingTranscriptVersionUpsertDto,
) -> Result<(), MeetingStoreError> {
    validation::uuid(&value.id)?;
    if value.revision_number == 0 {
        return Err(MeetingStoreError::validation(
            "invalid transcript version revision",
        ));
    }
    if let Some(parent) = &value.parent_version_id {
        validation::uuid(parent)?;
    }
    validation::optional(
        value.provider.as_deref(),
        128,
        "invalid transcript provider",
    )?;
    validation::optional(value.model.as_deref(), 256, "invalid transcript model")?;
    validation::optional(
        value.gateway_job_id.as_deref(),
        512,
        "invalid gateway job identifier",
    )?;
    validation::optional(
        value.input_audio_checksum.as_deref(),
        256,
        "invalid audio checksum",
    )?;
    validation::optional(
        value.detected_language.as_deref(),
        64,
        "invalid detected language",
    )?;
    validation::json_size(value.reconciliation_metadata.as_ref())?;
    validation::typed_error(value.error.as_ref())?;
    if value.started_at_ms.is_some_and(|time| time < 0)
        || value.completed_at_ms.is_some_and(|time| time < 0)
        || matches!((value.started_at_ms, value.completed_at_ms), (Some(start), Some(end)) if end < start)
    {
        return Err(MeetingStoreError::validation(
            "invalid transcript version timestamps",
        ));
    }
    Ok(())
}

fn validate_transcript_segment(
    value: &MeetingTranscriptSegmentUpsertDto,
    version_id: &str,
) -> Result<(), MeetingStoreError> {
    validation::uuid(&value.id)?;
    if value.transcript_version_id != version_id {
        return Err(MeetingStoreError::validation(
            "segment transcript version mismatch",
        ));
    }
    if value.state == MeetingTranscriptSegmentState::Partial {
        return Err(MeetingStoreError::validation(
            "partial transcript segments are not durable",
        ));
    }
    validation::nonempty(&value.provider, 128, "invalid transcript provider")?;
    validation::nonempty(&value.provider_namespace, 256, "invalid provider namespace")?;
    validation::optional(
        value.provider_session_id.as_deref(),
        256,
        "invalid provider session identifier",
    )?;
    validation::nonempty(
        &value.provider_turn_id,
        256,
        "invalid provider turn identifier",
    )?;
    if let Some(speaker_id) = &value.speaker_id {
        validation::uuid(speaker_id)?;
    }
    validation::timestamp_range(value.start_ms, Some(value.end_ms))?;
    validation::nonempty(
        &value.text,
        validation::MAX_TEXT_BYTES,
        "invalid transcript text",
    )?;
    validation::words(&value.words, value.start_ms, value.end_ms)?;
    if value.replaced_live_segment_ids.len() > validation::MAX_SEGMENTS_PER_BATCH {
        return Err(MeetingStoreError::validation(
            "too many replacement segment references",
        ));
    }
    for id in &value.replaced_live_segment_ids {
        validation::uuid(id)?;
    }
    Ok(())
}

fn validate_speaker_observation(
    value: &MeetingSpeakerObservationUpsertDto,
    version_id: &str,
) -> Result<(), MeetingStoreError> {
    validation::uuid(&value.id)?;
    if value.transcript_version_id != version_id {
        return Err(MeetingStoreError::validation(
            "speaker observation transcript version mismatch",
        ));
    }
    if let Some(speaker_id) = &value.speaker_id {
        validation::uuid(speaker_id)?;
    }
    validation::nonempty(&value.provider, 128, "invalid speaker observation provider")?;
    validation::nonempty(
        &value.provider_namespace,
        256,
        "invalid speaker observation namespace",
    )?;
    validation::nonempty(
        &value.provider_speaker_label,
        256,
        "invalid provider speaker label",
    )?;
    validation::score(value.confidence)?;
    Ok(())
}

async fn upsert_transcript_version(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    value: &MeetingTranscriptVersionUpsertDto,
) -> Result<(), MeetingStoreError> {
    if let Some(row) = sqlx::query(
        "SELECT meeting_id, kind, revision_number FROM transcript_versions WHERE id = ?",
    )
    .bind(&value.id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?
    {
        let stored_meeting: String = row
            .try_get("meeting_id")
            .map_err(MeetingStoreError::database)?;
        let stored_kind: String = row.try_get("kind").map_err(MeetingStoreError::database)?;
        let stored_revision: i64 = row
            .try_get("revision_number")
            .map_err(MeetingStoreError::database)?;
        if stored_meeting != meeting_id
            || stored_kind != enum_string(&value.kind)?
            || stored_revision != value.revision_number as i64
        {
            return Err(MeetingStoreError::Conflict);
        }
    }
    let now = now_ms();
    let metadata = value
        .reconciliation_metadata
        .as_ref()
        .map(json_string)
        .transpose()?;
    sqlx::query(
        r#"INSERT INTO transcript_versions (
            id, meeting_id, kind, status, revision_number, provider, model, gateway_job_id,
            parent_version_id, input_audio_checksum, detected_language, reconciliation_metadata_json,
            started_at_ms, completed_at_ms, error_code, error_message, error_retryable,
            created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, provider = excluded.provider,
            model = excluded.model, gateway_job_id = excluded.gateway_job_id,
            parent_version_id = excluded.parent_version_id,
            input_audio_checksum = excluded.input_audio_checksum,
            detected_language = excluded.detected_language,
            reconciliation_metadata_json = excluded.reconciliation_metadata_json,
            started_at_ms = COALESCE(excluded.started_at_ms, transcript_versions.started_at_ms),
            completed_at_ms = excluded.completed_at_ms,
            error_code = excluded.error_code, error_message = excluded.error_message,
            error_retryable = excluded.error_retryable, updated_at_ms = excluded.updated_at_ms"#,
    )
    .bind(&value.id)
    .bind(meeting_id)
    .bind(enum_string(&value.kind)?)
    .bind(enum_string(&value.status)?)
    .bind(value.revision_number as i64)
    .bind(value.provider.as_deref())
    .bind(value.model.as_deref())
    .bind(value.gateway_job_id.as_deref())
    .bind(value.parent_version_id.as_deref())
    .bind(value.input_audio_checksum.as_deref())
    .bind(value.detected_language.as_deref())
    .bind(metadata)
    .bind(value.started_at_ms)
    .bind(value.completed_at_ms)
    .bind(value.error.as_ref().map(|error| error.code.as_str()))
    .bind(value.error.as_ref().map(|error| error.message.as_str()))
    .bind(value.error.as_ref().is_some_and(|error| error.retryable))
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    Ok(())
}

async fn upsert_transcript_segment(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    value: &MeetingTranscriptSegmentUpsertDto,
) -> Result<MeetingUpsertOutcomeDto, MeetingStoreError> {
    if let Some(row) = sqlx::query(
        r#"SELECT meeting_id, transcript_version_id, provider, provider_namespace, provider_turn_id
           FROM transcript_segments WHERE id = ?"#,
    )
    .bind(&value.id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?
    {
        let identity_matches = row
            .try_get::<String, _>("meeting_id")
            .map_err(MeetingStoreError::database)?
            == meeting_id
            && row
                .try_get::<String, _>("transcript_version_id")
                .map_err(MeetingStoreError::database)?
                == value.transcript_version_id
            && row
                .try_get::<String, _>("provider")
                .map_err(MeetingStoreError::database)?
                == value.provider
            && row
                .try_get::<String, _>("provider_namespace")
                .map_err(MeetingStoreError::database)?
                == value.provider_namespace
            && row
                .try_get::<String, _>("provider_turn_id")
                .map_err(MeetingStoreError::database)?
                == value.provider_turn_id;
        if !identity_matches {
            return Err(MeetingStoreError::Conflict);
        }
    }
    let identity = sqlx::query(
        r#"SELECT id, revision_number, content_hash FROM transcript_segments
           WHERE meeting_id = ? AND transcript_version_id = ? AND provider = ?
             AND provider_namespace = ? AND provider_turn_id = ?"#,
    )
    .bind(meeting_id)
    .bind(&value.transcript_version_id)
    .bind(&value.provider)
    .bind(&value.provider_namespace)
    .bind(&value.provider_turn_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    if let Some(row) = &identity {
        let existing_id: String = row.try_get("id").map_err(MeetingStoreError::database)?;
        if existing_id != value.id {
            return Err(MeetingStoreError::Conflict);
        }
    }
    let content_hash = transcript_segment_hash(value)?;
    let previous = if let Some(row) = identity {
        Some((
            row.try_get::<i64, _>("revision_number")
                .map_err(MeetingStoreError::database)?,
            row.try_get::<String, _>("content_hash")
                .map_err(MeetingStoreError::database)?,
        ))
    } else {
        None
    };
    if let Some((revision, hash)) = &previous {
        if value.revision_number as i64 <= *revision {
            return Ok(MeetingUpsertOutcomeDto {
                id: value.id.clone(),
                outcome: if value.revision_number as i64 == *revision && content_hash == *hash {
                    MeetingUpsertOutcomeKind::Duplicate
                } else {
                    MeetingUpsertOutcomeKind::StaleIgnored
                },
            });
        }
    }
    if let Some(speaker_id) = &value.speaker_id {
        ensure_speaker(tx, meeting_id, speaker_id).await?;
    }
    let now = now_ms();
    sqlx::query(
        r#"INSERT INTO transcript_segments (
            id, meeting_id, transcript_version_id, provider, provider_namespace,
            provider_session_id, provider_turn_id, provider_turn_order, revision_number,
            state, speaker_id, source_kind, start_ms, end_ms, finalized_text, words_json,
            content_hash, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET provider_session_id = excluded.provider_session_id,
            provider_turn_order = excluded.provider_turn_order,
            revision_number = excluded.revision_number, state = excluded.state,
            speaker_id = excluded.speaker_id, source_kind = excluded.source_kind,
            start_ms = excluded.start_ms, end_ms = excluded.end_ms,
            finalized_text = excluded.finalized_text, words_json = excluded.words_json,
            content_hash = excluded.content_hash, updated_at_ms = excluded.updated_at_ms
        WHERE excluded.revision_number > transcript_segments.revision_number"#,
    )
    .bind(&value.id)
    .bind(meeting_id)
    .bind(&value.transcript_version_id)
    .bind(&value.provider)
    .bind(&value.provider_namespace)
    .bind(value.provider_session_id.as_deref())
    .bind(&value.provider_turn_id)
    .bind(value.provider_turn_order)
    .bind(value.revision_number as i64)
    .bind(enum_string(&value.state)?)
    .bind(value.speaker_id.as_deref())
    .bind(enum_string(&value.source_kind)?)
    .bind(value.start_ms)
    .bind(value.end_ms)
    .bind(&value.text)
    .bind(json_string(&value.words)?)
    .bind(&content_hash)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    sqlx::query("DELETE FROM transcript_segment_replacements WHERE refined_segment_id = ?")
        .bind(&value.id)
        .execute(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
    for replaced_id in &value.replaced_live_segment_ids {
        let result = sqlx::query(
            r#"INSERT INTO transcript_segment_replacements(refined_segment_id, live_segment_id)
               SELECT ?, ts.id FROM transcript_segments ts
               JOIN transcript_versions tv ON tv.id = ts.transcript_version_id
               WHERE ts.id = ? AND ts.meeting_id = ? AND tv.kind = 'live'"#,
        )
        .bind(&value.id)
        .bind(replaced_id)
        .bind(meeting_id)
        .execute(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
        if result.rows_affected() != 1 {
            return Err(MeetingStoreError::NotFound);
        }
    }
    Ok(MeetingUpsertOutcomeDto {
        id: value.id.clone(),
        outcome: if previous.is_some() {
            MeetingUpsertOutcomeKind::Revised
        } else {
            MeetingUpsertOutcomeKind::Inserted
        },
    })
}

async fn enqueue_claim_gate_segment(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    segment_id: &str,
    revision_number: u64,
    enqueued_at_ms: i64,
) -> Result<(), MeetingStoreError> {
    sqlx::query(
        r#"INSERT INTO claim_gate_segments (
            meeting_id, segment_id, queued_revision_number, enqueued_at_ms
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(meeting_id, segment_id) DO UPDATE SET
            queued_revision_number = excluded.queued_revision_number,
            enqueued_at_ms = excluded.enqueued_at_ms
        WHERE excluded.queued_revision_number > claim_gate_segments.queued_revision_number"#,
    )
    .bind(meeting_id)
    .bind(segment_id)
    .bind(revision_number as i64)
    .bind(enqueued_at_ms)
    .execute(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    Ok(())
}

async fn upsert_speaker_observation(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    value: &MeetingSpeakerObservationUpsertDto,
) -> Result<(), MeetingStoreError> {
    if let Some(speaker_id) = &value.speaker_id {
        ensure_speaker(tx, meeting_id, speaker_id).await?;
    }
    if let Some(row) = sqlx::query(
        r#"SELECT meeting_id, transcript_version_id, provider, provider_namespace,
                  provider_speaker_label FROM speaker_observations WHERE id = ?"#,
    )
    .bind(&value.id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?
    {
        let identity_matches = row
            .try_get::<String, _>("meeting_id")
            .map_err(MeetingStoreError::database)?
            == meeting_id
            && row
                .try_get::<String, _>("transcript_version_id")
                .map_err(MeetingStoreError::database)?
                == value.transcript_version_id
            && row
                .try_get::<String, _>("provider")
                .map_err(MeetingStoreError::database)?
                == value.provider
            && row
                .try_get::<String, _>("provider_namespace")
                .map_err(MeetingStoreError::database)?
                == value.provider_namespace
            && row
                .try_get::<String, _>("provider_speaker_label")
                .map_err(MeetingStoreError::database)?
                == value.provider_speaker_label;
        if !identity_matches {
            return Err(MeetingStoreError::Conflict);
        }
    }
    let existing = sqlx::query(
        r#"SELECT id FROM speaker_observations WHERE meeting_id = ? AND transcript_version_id = ?
           AND provider = ? AND provider_namespace = ? AND provider_speaker_label = ?"#,
    )
    .bind(meeting_id)
    .bind(&value.transcript_version_id)
    .bind(&value.provider)
    .bind(&value.provider_namespace)
    .bind(&value.provider_speaker_label)
    .fetch_optional(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    if let Some(row) = existing {
        let id: String = row.try_get("id").map_err(MeetingStoreError::database)?;
        if id != value.id {
            return Err(MeetingStoreError::Conflict);
        }
    }
    let now = now_ms();
    sqlx::query(
        r#"INSERT INTO speaker_observations (
            id, meeting_id, transcript_version_id, speaker_id, provider, provider_namespace,
            provider_speaker_label, confidence, ambiguous, revision_number, source_hint,
            created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET speaker_id = excluded.speaker_id,
            confidence = excluded.confidence, ambiguous = excluded.ambiguous,
            revision_number = excluded.revision_number, source_hint = excluded.source_hint,
            updated_at_ms = excluded.updated_at_ms
        WHERE excluded.revision_number > speaker_observations.revision_number"#,
    )
    .bind(&value.id)
    .bind(meeting_id)
    .bind(&value.transcript_version_id)
    .bind(value.speaker_id.as_deref())
    .bind(&value.provider)
    .bind(&value.provider_namespace)
    .bind(&value.provider_speaker_label)
    .bind(value.confidence)
    .bind(value.ambiguous)
    .bind(value.revision_number as i64)
    .bind(
        value
            .source_hint
            .map(|source| enum_string(&source))
            .transpose()?,
    )
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    Ok(())
}

async fn ensure_speaker(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    speaker_id: &str,
) -> Result<(), MeetingStoreError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM speakers WHERE id = ? AND meeting_id = ?)",
    )
    .bind(speaker_id)
    .bind(meeting_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    if !exists {
        return Err(MeetingStoreError::NotFound);
    }
    Ok(())
}

fn transcript_segment_hash(
    value: &MeetingTranscriptSegmentUpsertDto,
) -> Result<String, MeetingStoreError> {
    let bytes = serde_json::to_vec(value).map_err(|_| MeetingStoreError::Serialization)?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

fn speaker_from_row(row: &SqliteRow) -> Result<MeetingSpeakerDto, MeetingStoreError> {
    let source_hint = row
        .try_get::<Option<String>, _>("source_hint")
        .map_err(MeetingStoreError::database)?
        .map(|value| enum_from_str(&value))
        .transpose()?;
    Ok(MeetingSpeakerDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        meeting_id: row
            .try_get("meeting_id")
            .map_err(MeetingStoreError::database)?,
        default_label: row
            .try_get("default_label")
            .map_err(MeetingStoreError::database)?,
        display_name: row
            .try_get("display_name")
            .map_err(MeetingStoreError::database)?,
        display_name_source: row
            .try_get("display_name_source")
            .map_err(MeetingStoreError::database)?,
        manual_assignment_lock: row
            .try_get("manual_assignment_lock")
            .map_err(MeetingStoreError::database)?,
        source_hint,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

fn transcript_version_from_row(
    row: &SqliteRow,
) -> Result<MeetingTranscriptVersionDto, MeetingStoreError> {
    let metadata = row
        .try_get::<Option<String>, _>("reconciliation_metadata_json")
        .map_err(MeetingStoreError::database)?
        .map(|value| json_from_str(&value))
        .transpose()?;
    Ok(MeetingTranscriptVersionDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        meeting_id: row
            .try_get("meeting_id")
            .map_err(MeetingStoreError::database)?,
        kind: enum_from_str(
            &row.try_get::<String, _>("kind")
                .map_err(MeetingStoreError::database)?,
        )?,
        status: enum_from_str(
            &row.try_get::<String, _>("status")
                .map_err(MeetingStoreError::database)?,
        )?,
        revision_number: row
            .try_get::<i64, _>("revision_number")
            .map_err(MeetingStoreError::database)?
            .max(0) as u64,
        provider: row
            .try_get("provider")
            .map_err(MeetingStoreError::database)?,
        model: row.try_get("model").map_err(MeetingStoreError::database)?,
        gateway_job_id: row
            .try_get("gateway_job_id")
            .map_err(MeetingStoreError::database)?,
        parent_version_id: row
            .try_get("parent_version_id")
            .map_err(MeetingStoreError::database)?,
        input_audio_checksum: row
            .try_get("input_audio_checksum")
            .map_err(MeetingStoreError::database)?,
        detected_language: row
            .try_get("detected_language")
            .map_err(MeetingStoreError::database)?,
        reconciliation_metadata: metadata,
        started_at_ms: row
            .try_get("started_at_ms")
            .map_err(MeetingStoreError::database)?,
        completed_at_ms: row
            .try_get("completed_at_ms")
            .map_err(MeetingStoreError::database)?,
        error: typed_error_from_row(row)?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

impl MeetingStore {
    pub async fn apply_timeline(
        &self,
        request: MeetingTimelineApplyRequest,
    ) -> Result<MeetingTimelineApplyResponse, MeetingStoreError> {
        validation::uuid(&request.meeting_id)?;
        if request.events.len() > validation::MAX_EVENTS_PER_BATCH {
            return Err(MeetingStoreError::validation(
                "timeline event batch is too large",
            ));
        }
        self.get_meeting(&request.meeting_id, false).await?;
        for event in &request.events {
            validation::uuid(&event.id)?;
            validation::timestamp_range(event.start_ms, event.end_ms)?;
            validation::optional(
                event.provider_namespace.as_deref(),
                256,
                "invalid event namespace",
            )?;
            validation::json_size(event.metadata.as_ref())?;
        }
        let pool = self.pool().await?;
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(MeetingStoreError::database)?;
        let now = now_ms();
        for event in &request.events {
            let metadata = event.metadata.as_ref().map(json_string).transpose()?;
            let source_kind = event
                .source_kind
                .map(|source| enum_string(&source))
                .transpose()?;
            if let Some(row) = sqlx::query(
                r#"SELECT meeting_id, kind, start_ms, end_ms, source_kind,
                          provider_namespace, metadata_json FROM timeline_events WHERE id = ?"#,
            )
            .bind(&event.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?
            {
                let stored_end_ms = row
                    .try_get::<Option<i64>, _>("end_ms")
                    .map_err(MeetingStoreError::database)?;
                let immutable_fields_match = row
                    .try_get::<String, _>("meeting_id")
                    .map_err(MeetingStoreError::database)?
                    == request.meeting_id
                    && row
                        .try_get::<String, _>("kind")
                        .map_err(MeetingStoreError::database)?
                        == enum_string(&event.kind)?
                    && row
                        .try_get::<i64, _>("start_ms")
                        .map_err(MeetingStoreError::database)?
                        == event.start_ms
                    && row
                        .try_get::<Option<String>, _>("source_kind")
                        .map_err(MeetingStoreError::database)?
                        == source_kind
                    && row
                        .try_get::<Option<String>, _>("provider_namespace")
                        .map_err(MeetingStoreError::database)?
                        == event.provider_namespace
                    && row
                        .try_get::<Option<String>, _>("metadata_json")
                        .map_err(MeetingStoreError::database)?
                        == metadata;
                if !immutable_fields_match {
                    return Err(MeetingStoreError::Conflict);
                }
                if stored_end_ms == event.end_ms {
                    continue;
                }
                let closes_open_interval = matches!(
                    event.kind,
                    MeetingTimelineEventKind::Pause | MeetingTimelineEventKind::Sleep
                ) && stored_end_ms.is_none()
                    && event.end_ms.is_some();
                if !closes_open_interval {
                    return Err(MeetingStoreError::Conflict);
                }
                let result = sqlx::query(
                    "UPDATE timeline_events SET end_ms = ? WHERE id = ? AND meeting_id = ? AND end_ms IS NULL",
                )
                .bind(event.end_ms)
                .bind(&event.id)
                .bind(&request.meeting_id)
                .execute(&mut *tx)
                .await
                .map_err(MeetingStoreError::database)?;
                if result.rows_affected() != 1 {
                    return Err(MeetingStoreError::Conflict);
                }
                continue;
            }
            sqlx::query(
                r#"INSERT INTO timeline_events (
                    id, meeting_id, kind, start_ms, end_ms, source_kind,
                    provider_namespace, metadata_json, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING"#,
            )
            .bind(&event.id)
            .bind(&request.meeting_id)
            .bind(enum_string(&event.kind)?)
            .bind(event.start_ms)
            .bind(event.end_ms)
            .bind(source_kind)
            .bind(event.provider_namespace.as_deref())
            .bind(metadata)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
        }
        sqlx::query("UPDATE meetings SET updated_at_ms = ? WHERE id = ?")
            .bind(now)
            .bind(&request.meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
        tx.commit().await.map_err(MeetingStoreError::database)?;
        Ok(MeetingTimelineApplyResponse {
            events: self.list_timeline_events(&request.meeting_id).await?,
        })
    }

    pub async fn apply_audio(
        &self,
        request: MeetingAudioApplyRequest,
    ) -> Result<MeetingAudioApplyResponse, MeetingStoreError> {
        validation::uuid(&request.meeting_id)?;
        if request.assets.len() > validation::MAX_ASSETS_PER_BATCH
            || request.refinement_inputs.len() > validation::MAX_ASSETS_PER_BATCH
        {
            return Err(MeetingStoreError::validation(
                "audio metadata batch is too large",
            ));
        }
        self.get_meeting(&request.meeting_id, false).await?;
        for asset in &request.assets {
            validate_audio_asset(asset)?;
        }
        if let Some(job_id) = &request.replace_refinement_manifest_for_job_id {
            validation::uuid(job_id)?;
        }
        for input in &request.refinement_inputs {
            validate_refinement_input(input)?;
        }
        let pool = self.pool().await?;
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(MeetingStoreError::database)?;
        let now = now_ms();
        for asset in &request.assets {
            let relative_path = format!(
                "{}/{}/{}",
                MEETINGS_AUDIO_FOLDER, request.meeting_id, asset.file_name
            );
            validation::controlled_relative_path(&relative_path)?;
            let existing = sqlx::query(
                "SELECT meeting_id, source_kind, timeline_part, relative_path FROM audio_assets WHERE id = ?",
            )
            .bind(&asset.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
            if let Some(row) = existing {
                let identity_matches = row
                    .try_get::<String, _>("meeting_id")
                    .map_err(MeetingStoreError::database)?
                    == request.meeting_id
                    && row
                        .try_get::<String, _>("source_kind")
                        .map_err(MeetingStoreError::database)?
                        == enum_string(&asset.source_kind)?
                    && row
                        .try_get::<i64, _>("timeline_part")
                        .map_err(MeetingStoreError::database)?
                        == i64::from(asset.timeline_part)
                    && row
                        .try_get::<String, _>("relative_path")
                        .map_err(MeetingStoreError::database)?
                        == relative_path;
                if !identity_matches {
                    return Err(MeetingStoreError::Conflict);
                }
            }
            let bytes = asset
                .bytes
                .map(i64::try_from)
                .transpose()
                .map_err(|_| MeetingStoreError::validation("audio byte count is too large"))?;
            sqlx::query(
                r#"INSERT INTO audio_assets (
                    id, meeting_id, source_kind, timeline_part, relative_path, format,
                    sample_rate, channels, timeline_start_ms, timeline_end_ms, duration_ms,
                    bytes, checksum, status, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET format = excluded.format,
                    sample_rate = excluded.sample_rate, channels = excluded.channels,
                    timeline_end_ms = excluded.timeline_end_ms, duration_ms = excluded.duration_ms,
                    bytes = excluded.bytes, checksum = excluded.checksum,
                    status = excluded.status, updated_at_ms = excluded.updated_at_ms"#,
            )
            .bind(&asset.id)
            .bind(&request.meeting_id)
            .bind(enum_string(&asset.source_kind)?)
            .bind(i64::from(asset.timeline_part))
            .bind(relative_path)
            .bind(&asset.format)
            .bind(i64::from(asset.sample_rate))
            .bind(i64::from(asset.channels))
            .bind(asset.timeline_start_ms)
            .bind(asset.timeline_end_ms)
            .bind(asset.duration_ms)
            .bind(bytes)
            .bind(asset.checksum.as_deref())
            .bind(enum_string(&asset.status)?)
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
        }
        if let Some(job_id) = &request.replace_refinement_manifest_for_job_id {
            ensure_refinement_job(&mut tx, &request.meeting_id, job_id).await?;
            sqlx::query("DELETE FROM refinement_inputs WHERE refinement_job_id = ?")
                .bind(job_id)
                .execute(&mut *tx)
                .await
                .map_err(MeetingStoreError::database)?;
        }
        for input in &request.refinement_inputs {
            ensure_refinement_job(&mut tx, &request.meeting_id, &input.refinement_job_id).await?;
            let asset_exists = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM audio_assets WHERE id = ? AND meeting_id = ?)",
            )
            .bind(&input.audio_asset_id)
            .bind(&request.meeting_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
            if !asset_exists {
                return Err(MeetingStoreError::NotFound);
            }
            sqlx::query(
                r#"INSERT INTO refinement_inputs (
                    refinement_job_id, part_index, audio_asset_id, source_kind, checksum,
                    meeting_start_ms, meeting_end_ms, provider_start_ms, provider_end_ms,
                    manifest_checksum, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(refinement_job_id, part_index) DO UPDATE SET
                    audio_asset_id = excluded.audio_asset_id, source_kind = excluded.source_kind,
                    checksum = excluded.checksum, meeting_start_ms = excluded.meeting_start_ms,
                    meeting_end_ms = excluded.meeting_end_ms, provider_start_ms = excluded.provider_start_ms,
                    provider_end_ms = excluded.provider_end_ms, manifest_checksum = excluded.manifest_checksum"#,
            )
            .bind(&input.refinement_job_id)
            .bind(i64::from(input.part_index))
            .bind(&input.audio_asset_id)
            .bind(enum_string(&input.source_kind)?)
            .bind(&input.checksum)
            .bind(input.meeting_start_ms)
            .bind(input.meeting_end_ms)
            .bind(input.provider_start_ms)
            .bind(input.provider_end_ms)
            .bind(&input.manifest_checksum)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
        }
        sqlx::query("UPDATE meetings SET updated_at_ms = ? WHERE id = ?")
            .bind(now)
            .bind(&request.meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
        tx.commit().await.map_err(MeetingStoreError::database)?;
        Ok(MeetingAudioApplyResponse {
            assets: self.list_audio_assets(&request.meeting_id).await?,
            refinement_inputs: self.list_refinement_inputs(&request.meeting_id).await?,
        })
    }

    async fn list_timeline_events(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingTimelineEventDto>, MeetingStoreError> {
        let rows =
            sqlx::query("SELECT * FROM timeline_events WHERE meeting_id = ? ORDER BY start_ms, id")
                .bind(meeting_id)
                .fetch_all(self.pool().await?)
                .await
                .map_err(MeetingStoreError::database)?;
        rows.iter().map(timeline_event_from_row).collect()
    }

    async fn list_audio_assets(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingAudioAssetDto>, MeetingStoreError> {
        let rows = sqlx::query(
            "SELECT * FROM audio_assets WHERE meeting_id = ? ORDER BY timeline_start_ms, timeline_part, id",
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        rows.iter().map(audio_asset_from_row).collect()
    }

    async fn list_refinement_inputs(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingRefinementInputDto>, MeetingStoreError> {
        let rows = sqlx::query(
            r#"SELECT ri.* FROM refinement_inputs ri
               JOIN transcript_refinement_jobs rj ON rj.id = ri.refinement_job_id
               WHERE rj.meeting_id = ? ORDER BY ri.refinement_job_id, ri.part_index"#,
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        rows.iter().map(refinement_input_from_row).collect()
    }
}

fn validate_audio_asset(value: &MeetingAudioAssetUpsertDto) -> Result<(), MeetingStoreError> {
    validation::uuid(&value.id)?;
    validation::controlled_file_name(&value.file_name)?;
    validation::nonempty(&value.format, 32, "invalid audio format")?;
    if !value
        .format
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(MeetingStoreError::validation("invalid audio format"));
    }
    if value.sample_rate == 0
        || value.sample_rate > 384_000
        || value.channels == 0
        || value.channels > 32
    {
        return Err(MeetingStoreError::validation(
            "invalid audio format metadata",
        ));
    }
    validation::timestamp_range(value.timeline_start_ms, value.timeline_end_ms)?;
    if value.duration_ms.is_some_and(|duration| duration < 0) {
        return Err(MeetingStoreError::validation("invalid audio duration"));
    }
    validation::optional(value.checksum.as_deref(), 256, "invalid audio checksum")
}

fn validate_refinement_input(
    value: &MeetingRefinementInputUpsertDto,
) -> Result<(), MeetingStoreError> {
    validation::uuid(&value.refinement_job_id)?;
    validation::uuid(&value.audio_asset_id)?;
    validation::nonempty(&value.checksum, 256, "invalid refinement input checksum")?;
    validation::nonempty(
        &value.manifest_checksum,
        256,
        "invalid refinement manifest checksum",
    )?;
    validation::timestamp_range(value.meeting_start_ms, Some(value.meeting_end_ms))?;
    validation::timestamp_range(value.provider_start_ms, Some(value.provider_end_ms))
}

async fn ensure_refinement_job(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    job_id: &str,
) -> Result<(), MeetingStoreError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM transcript_refinement_jobs WHERE id = ? AND meeting_id = ?)",
    )
    .bind(job_id)
    .bind(meeting_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    if !exists {
        return Err(MeetingStoreError::NotFound);
    }
    Ok(())
}

fn timeline_event_from_row(row: &SqliteRow) -> Result<MeetingTimelineEventDto, MeetingStoreError> {
    Ok(MeetingTimelineEventDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        meeting_id: row
            .try_get("meeting_id")
            .map_err(MeetingStoreError::database)?,
        kind: enum_from_str(
            &row.try_get::<String, _>("kind")
                .map_err(MeetingStoreError::database)?,
        )?,
        start_ms: row
            .try_get("start_ms")
            .map_err(MeetingStoreError::database)?,
        end_ms: row.try_get("end_ms").map_err(MeetingStoreError::database)?,
        source_kind: row
            .try_get::<Option<String>, _>("source_kind")
            .map_err(MeetingStoreError::database)?
            .map(|value| enum_from_str(&value))
            .transpose()?,
        provider_namespace: row
            .try_get("provider_namespace")
            .map_err(MeetingStoreError::database)?,
        metadata: row
            .try_get::<Option<String>, _>("metadata_json")
            .map_err(MeetingStoreError::database)?
            .map(|value| json_from_str(&value))
            .transpose()?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

fn audio_asset_from_row(row: &SqliteRow) -> Result<MeetingAudioAssetDto, MeetingStoreError> {
    let bytes = row
        .try_get::<Option<i64>, _>("bytes")
        .map_err(MeetingStoreError::database)?
        .map(u64::try_from)
        .transpose()
        .map_err(|_| MeetingStoreError::Serialization)?;
    Ok(MeetingAudioAssetDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        meeting_id: row
            .try_get("meeting_id")
            .map_err(MeetingStoreError::database)?,
        source_kind: enum_from_str(
            &row.try_get::<String, _>("source_kind")
                .map_err(MeetingStoreError::database)?,
        )?,
        timeline_part: row
            .try_get::<i64, _>("timeline_part")
            .map_err(MeetingStoreError::database)?
            .max(0) as u32,
        relative_path: row
            .try_get("relative_path")
            .map_err(MeetingStoreError::database)?,
        format: row.try_get("format").map_err(MeetingStoreError::database)?,
        sample_rate: row
            .try_get::<i64, _>("sample_rate")
            .map_err(MeetingStoreError::database)?
            .max(0) as u32,
        channels: row
            .try_get::<i64, _>("channels")
            .map_err(MeetingStoreError::database)?
            .max(0) as u16,
        timeline_start_ms: row
            .try_get("timeline_start_ms")
            .map_err(MeetingStoreError::database)?,
        timeline_end_ms: row
            .try_get("timeline_end_ms")
            .map_err(MeetingStoreError::database)?,
        duration_ms: row
            .try_get("duration_ms")
            .map_err(MeetingStoreError::database)?,
        bytes,
        checksum: row
            .try_get("checksum")
            .map_err(MeetingStoreError::database)?,
        status: enum_from_str(
            &row.try_get::<String, _>("status")
                .map_err(MeetingStoreError::database)?,
        )?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

fn refinement_input_from_row(
    row: &SqliteRow,
) -> Result<MeetingRefinementInputDto, MeetingStoreError> {
    Ok(MeetingRefinementInputDto {
        refinement_job_id: row
            .try_get("refinement_job_id")
            .map_err(MeetingStoreError::database)?,
        part_index: row
            .try_get::<i64, _>("part_index")
            .map_err(MeetingStoreError::database)?
            .max(0) as u32,
        audio_asset_id: row
            .try_get("audio_asset_id")
            .map_err(MeetingStoreError::database)?,
        source_kind: enum_from_str(
            &row.try_get::<String, _>("source_kind")
                .map_err(MeetingStoreError::database)?,
        )?,
        checksum: row
            .try_get("checksum")
            .map_err(MeetingStoreError::database)?,
        meeting_start_ms: row
            .try_get("meeting_start_ms")
            .map_err(MeetingStoreError::database)?,
        meeting_end_ms: row
            .try_get("meeting_end_ms")
            .map_err(MeetingStoreError::database)?,
        provider_start_ms: row
            .try_get("provider_start_ms")
            .map_err(MeetingStoreError::database)?,
        provider_end_ms: row
            .try_get("provider_end_ms")
            .map_err(MeetingStoreError::database)?,
        manifest_checksum: row
            .try_get("manifest_checksum")
            .map_err(MeetingStoreError::database)?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

impl MeetingStore {
    pub async fn apply_claims(
        &self,
        request: MeetingClaimsApplyRequest,
    ) -> Result<MeetingClaimsApplyResponse, MeetingStoreError> {
        validate_claims_request(&request)?;
        self.get_meeting(&request.meeting_id, false).await?;
        let pool = self.pool().await?;
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(MeetingStoreError::database)?;
        let now = now_ms();
        for manual_request in &request.manual_fact_check_requests {
            upsert_manual_fact_check_request(&mut tx, &request.meeting_id, manual_request, now)
                .await?;
        }
        for batch in &request.begin_claim_gate_batches {
            begin_claim_gate_batch(&mut tx, &request.meeting_id, batch, now).await?;
        }
        for value in &request.claim_versions {
            apply_claim_version(&mut tx, &request.meeting_id, value).await?;
        }
        mark_claim_versions_stale(
            &mut tx,
            &request.meeting_id,
            &request.mark_stale_claim_version_ids,
        )
        .await?;
        for batch_id in &request.complete_claim_gate_batch_ids {
            complete_claim_gate_batch(&mut tx, &request.meeting_id, batch_id, now).await?;
        }
        sqlx::query("UPDATE meetings SET updated_at_ms = ? WHERE id = ?")
            .bind(now)
            .bind(&request.meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
        tx.commit().await.map_err(MeetingStoreError::database)?;
        Ok(MeetingClaimsApplyResponse {
            claims: self.list_claims(&request.meeting_id).await?,
            claim_versions: self.list_claim_versions(&request.meeting_id).await?,
        })
    }

    async fn list_claims(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingClaimDto>, MeetingStoreError> {
        let rows =
            sqlx::query("SELECT * FROM claims WHERE meeting_id = ? ORDER BY created_at_ms, id")
                .bind(meeting_id)
                .fetch_all(self.pool().await?)
                .await
                .map_err(MeetingStoreError::database)?;
        rows.iter().map(claim_from_row).collect()
    }

    async fn list_claim_versions(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingClaimVersionDto>, MeetingStoreError> {
        let rows = sqlx::query(
            r#"SELECT cv.* FROM claim_versions cv JOIN claims c ON c.id = cv.claim_id
               WHERE c.meeting_id = ? ORDER BY cv.created_at_ms, cv.claim_id, cv.version_number"#,
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        let mut values = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id").map_err(MeetingStoreError::database)?;
            let segment_rows = sqlx::query(
                "SELECT segment_id FROM claim_version_segments WHERE claim_version_id = ? ORDER BY ordinal",
            )
            .bind(&id)
            .fetch_all(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?;
            values.push(claim_version_from_row(
                &row,
                segment_rows
                    .iter()
                    .map(|segment| {
                        segment
                            .try_get("segment_id")
                            .map_err(MeetingStoreError::database)
                    })
                    .collect::<Result<Vec<String>, MeetingStoreError>>()?,
            )?);
        }
        Ok(values)
    }

    async fn list_manual_fact_check_requests(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingManualFactCheckRequestDto>, MeetingStoreError> {
        let rows = sqlx::query(
            "SELECT * FROM manual_fact_check_requests WHERE meeting_id = ? ORDER BY created_at_ms, id",
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        let mut values = Vec::with_capacity(rows.len());
        for row in rows {
            let request_id: String = row.try_get("id").map_err(MeetingStoreError::database)?;
            let turn_rows = sqlx::query(
                r#"SELECT turn_id AS segment_id, revision_number AS segment_revision_number,
                          speaker_id AS snapshot_speaker_id, start_ms AS snapshot_start_ms,
                          end_ms AS snapshot_end_ms, finalized_text AS snapshot_text,
                          source_kind AS snapshot_source_kind
                   FROM manual_fact_check_request_context_turns
                   WHERE request_id = ? ORDER BY ordinal"#,
            )
            .bind(&request_id)
            .fetch_all(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?;
            let context_turns = turn_rows
                .iter()
                .map(claim_gate_turn_from_row)
                .collect::<Result<Vec<_>, _>>()?;
            let segment_rows = sqlx::query(
                "SELECT segment_id FROM manual_fact_check_request_segments WHERE request_id = ? ORDER BY ordinal",
            )
            .bind(&request_id)
            .fetch_all(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?;
            values.push(MeetingManualFactCheckRequestDto {
                id: request_id,
                meeting_id: row
                    .try_get("meeting_id")
                    .map_err(MeetingStoreError::database)?,
                exact_selection: row
                    .try_get("exact_selection")
                    .map_err(MeetingStoreError::database)?,
                context_turns,
                source_segment_ids: string_column(&segment_rows, "segment_id")?,
                speaker_id: row
                    .try_get("speaker_id")
                    .map_err(MeetingStoreError::database)?,
                start_ms: row
                    .try_get("start_ms")
                    .map_err(MeetingStoreError::database)?,
                end_ms: row.try_get("end_ms").map_err(MeetingStoreError::database)?,
                status: enum_from_str(
                    &row.try_get::<String, _>("status")
                        .map_err(MeetingStoreError::database)?,
                )?,
                error: typed_error_from_row(&row)?,
                content_hash: row
                    .try_get("content_hash")
                    .map_err(MeetingStoreError::database)?,
                created_at_ms: row
                    .try_get("created_at_ms")
                    .map_err(MeetingStoreError::database)?,
                updated_at_ms: row
                    .try_get("updated_at_ms")
                    .map_err(MeetingStoreError::database)?,
            });
        }
        Ok(values)
    }

    async fn list_pending_claim_gate_segment_ids(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<String>, MeetingStoreError> {
        let rows = sqlx::query(
            r#"SELECT cgs.segment_id FROM claim_gate_segments cgs
               JOIN transcript_segments ts ON ts.id = cgs.segment_id AND ts.meeting_id = cgs.meeting_id
               JOIN transcript_versions tv ON tv.id = ts.transcript_version_id
               WHERE cgs.meeting_id = ? AND tv.kind = 'live'
                 AND ts.state IN ('final', 'revised')
                 AND (cgs.processed_revision_number IS NULL
                      OR cgs.queued_revision_number > cgs.processed_revision_number)
                 AND NOT EXISTS (
                     SELECT 1 FROM claim_gate_batch_segments cgbs
                     JOIN claim_gate_batches cgb ON cgb.id = cgbs.batch_id
                     WHERE cgbs.segment_id = cgs.segment_id
                       AND cgbs.segment_revision_number = cgs.queued_revision_number
                       AND cgb.processed_at_ms IS NULL
                 )
               ORDER BY ts.start_ms, ts.provider_turn_order, ts.id"#,
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        string_column(&rows, "segment_id")
    }

    async fn list_pending_claim_gate_batches(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingClaimGateBatchDto>, MeetingStoreError> {
        let rows = sqlx::query(
            r#"SELECT id, meeting_id, idempotency_key, created_at_ms
               FROM claim_gate_batches
               WHERE meeting_id = ? AND processed_at_ms IS NULL
               ORDER BY created_at_ms, id"#,
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        let mut batches = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id").map_err(MeetingStoreError::database)?;
            let turn_rows = sqlx::query(
                r#"SELECT segment_id, segment_revision_number, snapshot_speaker_id,
                          snapshot_start_ms, snapshot_end_ms, snapshot_text,
                          snapshot_source_kind
                   FROM claim_gate_batch_segments
                   WHERE batch_id = ? ORDER BY ordinal"#,
            )
            .bind(&id)
            .fetch_all(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?;
            let mut segment_ids = Vec::with_capacity(turn_rows.len());
            let mut turns = Vec::with_capacity(turn_rows.len());
            for turn_row in turn_rows {
                let turn = claim_gate_turn_from_row(&turn_row)?;
                segment_ids.push(turn.id.clone());
                turns.push(turn);
            }
            batches.push(MeetingClaimGateBatchDto {
                id,
                meeting_id: row
                    .try_get("meeting_id")
                    .map_err(MeetingStoreError::database)?,
                idempotency_key: row
                    .try_get("idempotency_key")
                    .map_err(MeetingStoreError::database)?,
                segment_ids,
                turns,
                created_at_ms: row
                    .try_get("created_at_ms")
                    .map_err(MeetingStoreError::database)?,
            });
        }
        Ok(batches)
    }
}

fn claim_gate_turn_from_row(row: &SqliteRow) -> Result<MeetingClaimGateTurnDto, MeetingStoreError> {
    Ok(MeetingClaimGateTurnDto {
        id: row
            .try_get("segment_id")
            .map_err(MeetingStoreError::database)?,
        speaker_id: row
            .try_get("snapshot_speaker_id")
            .map_err(MeetingStoreError::database)?,
        start_ms: row
            .try_get("snapshot_start_ms")
            .map_err(MeetingStoreError::database)?,
        end_ms: row
            .try_get("snapshot_end_ms")
            .map_err(MeetingStoreError::database)?,
        text: row
            .try_get("snapshot_text")
            .map_err(MeetingStoreError::database)?,
        revision_number: row
            .try_get::<i64, _>("segment_revision_number")
            .map_err(MeetingStoreError::database)?
            .max(0) as u64,
        source_kind: enum_from_str(
            &row.try_get::<String, _>("snapshot_source_kind")
                .map_err(MeetingStoreError::database)?,
        )?,
    })
}

fn validate_manual_fact_check_request(
    value: &MeetingManualFactCheckRequestUpsertDto,
) -> Result<(), MeetingStoreError> {
    validation::uuid(&value.id)?;
    validation::nonempty(
        &value.exact_selection,
        validation::MAX_TEXT_BYTES,
        "invalid manual fact-check selection",
    )?;
    if value.context_turns.is_empty()
        || value.context_turns.len() > validation::MAX_SEGMENTS_PER_BATCH
        || value.source_segment_ids.len() > validation::MAX_SEGMENTS_PER_BATCH
    {
        return Err(MeetingStoreError::validation(
            "manual fact-check context is too large",
        ));
    }
    if let Some(speaker_id) = &value.speaker_id {
        validation::uuid(speaker_id)?;
    }
    match (value.start_ms, value.end_ms) {
        (Some(start), end) => validation::timestamp_range(start, end)?,
        (None, Some(_)) => {
            return Err(MeetingStoreError::validation(
                "invalid manual fact-check timestamp range",
            ));
        }
        _ => {}
    }
    validation::typed_error(value.error.as_ref())?;
    if value.status == MeetingManualFactCheckRequestStatus::Complete && value.error.is_some() {
        return Err(MeetingStoreError::validation(
            "completed manual fact-check request cannot have an error",
        ));
    }
    let mut turn_ids = HashSet::new();
    for turn in &value.context_turns {
        validation::uuid(&turn.id)?;
        if let Some(speaker_id) = &turn.speaker_id {
            validation::uuid(speaker_id)?;
        }
        validation::timestamp_range(turn.start_ms, Some(turn.end_ms))?;
        validation::nonempty(
            &turn.text,
            validation::MAX_TEXT_BYTES,
            "invalid manual fact-check context turn",
        )?;
        if turn.revision_number > i64::MAX as u64 || !turn_ids.insert(turn.id.as_str()) {
            return Err(MeetingStoreError::validation(
                "invalid manual fact-check context turn",
            ));
        }
    }
    let mut source_ids = HashSet::new();
    for segment_id in &value.source_segment_ids {
        validation::uuid(segment_id)?;
        if !source_ids.insert(segment_id.as_str()) {
            return Err(MeetingStoreError::validation(
                "duplicate manual fact-check source segment",
            ));
        }
    }
    Ok(())
}

fn validate_claims_request(request: &MeetingClaimsApplyRequest) -> Result<(), MeetingStoreError> {
    validation::uuid(&request.meeting_id)?;
    if request.claim_versions.len() > validation::MAX_CLAIMS_PER_BATCH
        || request.manual_fact_check_requests.len() > validation::MAX_CLAIMS_PER_BATCH
        || request.mark_stale_claim_version_ids.len() > validation::MAX_CLAIMS_PER_BATCH
        || request.begin_claim_gate_batches.len() > validation::MAX_CLAIMS_PER_BATCH
        || request.complete_claim_gate_batch_ids.len() > validation::MAX_CLAIMS_PER_BATCH
    {
        return Err(MeetingStoreError::validation("claim batch is too large"));
    }
    for manual_request in &request.manual_fact_check_requests {
        validate_manual_fact_check_request(manual_request)?;
    }
    for value in &request.claim_versions {
        validation::uuid(&value.claim_id)?;
        validation::uuid(&value.claim_version_id)?;
        if let Some(manual_request_id) = &value.manual_request_id {
            validation::uuid(manual_request_id)?;
            if value.origin != MeetingClaimOrigin::Manual {
                return Err(MeetingStoreError::validation(
                    "automatic claim cannot reference a manual request",
                ));
            }
        }
        if value.version_number == 0 {
            return Err(MeetingStoreError::validation(
                "invalid claim version number",
            ));
        }
        if let Some(id) = &value.predecessor_id {
            validation::uuid(id)?;
        }
        if let Some(id) = &value.superseded_by_id {
            validation::uuid(id)?;
        }
        if let Some(id) = &value.source_transcript_version_id {
            validation::uuid(id)?;
        }
        if let Some(id) = &value.speaker_id {
            validation::uuid(id)?;
        }
        validation::optional(
            value.duplicate_key.as_deref(),
            512,
            "invalid claim duplicate key",
        )?;
        validation::nonempty(
            &value.exact_quote,
            validation::MAX_CLAIM_BYTES,
            "invalid claim quote",
        )?;
        validation::nonempty(
            &value.normalized_claim,
            validation::MAX_CLAIM_BYTES,
            "invalid normalized claim",
        )?;
        validation::optional(
            value.selection_rationale.as_deref(),
            2_048,
            "invalid claim selection rationale",
        )?;
        validation::score(value.consequence_score)?;
        validation::score(value.dispute_score)?;
        validation::score(value.specificity_score)?;
        match (value.start_ms, value.end_ms) {
            (Some(start), end) => validation::timestamp_range(start, end)?,
            (None, Some(_)) => {
                return Err(MeetingStoreError::validation(
                    "invalid claim timestamp range",
                ));
            }
            _ => {}
        }
        if value.segment_ids.len() > validation::MAX_SEGMENTS_PER_BATCH {
            return Err(MeetingStoreError::validation(
                "too many claim segment references",
            ));
        }
        for id in &value.segment_ids {
            validation::uuid(id)?;
        }
    }
    for id in &request.mark_stale_claim_version_ids {
        validation::uuid(id)?;
    }
    let mut batch_ids = HashSet::new();
    let mut idempotency_keys = HashSet::new();
    for batch in &request.begin_claim_gate_batches {
        validation::uuid(&batch.id)?;
        validation::nonempty(
            &batch.idempotency_key,
            512,
            "invalid claim gate idempotency key",
        )?;
        if batch.turns.is_empty() || batch.turns.len() > validation::MAX_SEGMENTS_PER_BATCH {
            return Err(MeetingStoreError::validation(
                "invalid claim gate batch segments",
            ));
        }
        if !batch_ids.insert(batch.id.as_str())
            || !idempotency_keys.insert(batch.idempotency_key.as_str())
        {
            return Err(MeetingStoreError::validation("duplicate claim gate batch"));
        }
        let mut segment_ids = HashSet::new();
        for turn in &batch.turns {
            validation::uuid(&turn.id)?;
            if let Some(speaker_id) = &turn.speaker_id {
                validation::uuid(speaker_id)?;
            }
            validation::timestamp_range(turn.start_ms, Some(turn.end_ms))?;
            validation::nonempty(
                &turn.text,
                validation::MAX_TEXT_BYTES,
                "invalid claim gate turn text",
            )?;
            if turn.revision_number > i64::MAX as u64 {
                return Err(MeetingStoreError::validation(
                    "invalid claim gate turn revision",
                ));
            }
            if !segment_ids.insert(turn.id.as_str()) {
                return Err(MeetingStoreError::validation(
                    "duplicate claim gate segment",
                ));
            }
        }
    }
    for batch_id in &request.complete_claim_gate_batch_ids {
        validation::uuid(batch_id)?;
    }
    Ok(())
}

async fn upsert_manual_fact_check_request(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    value: &MeetingManualFactCheckRequestUpsertDto,
    now: i64,
) -> Result<(), MeetingStoreError> {
    if let Some(speaker_id) = &value.speaker_id {
        ensure_speaker(tx, meeting_id, speaker_id).await?;
    }
    for turn in &value.context_turns {
        if turn.source_kind != MeetingAudioSourceKind::Text {
            ensure_meeting_segment(tx, meeting_id, &turn.id).await?;
        }
        if let Some(speaker_id) = &turn.speaker_id {
            ensure_speaker(tx, meeting_id, speaker_id).await?;
        }
    }
    for segment_id in &value.source_segment_ids {
        ensure_meeting_segment(tx, meeting_id, segment_id).await?;
    }
    let content_hash = manual_fact_check_request_hash(value)?;
    if let Some(row) = sqlx::query(
        r#"SELECT meeting_id, content_hash, status, error_code, error_message,
                  error_retryable FROM manual_fact_check_requests WHERE id = ?"#,
    )
    .bind(&value.id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?
    {
        if row
            .try_get::<String, _>("meeting_id")
            .map_err(MeetingStoreError::database)?
            != meeting_id
            || row
                .try_get::<String, _>("content_hash")
                .map_err(MeetingStoreError::database)?
                != content_hash
        {
            return Err(MeetingStoreError::Conflict);
        }
        let existing_status: MeetingManualFactCheckRequestStatus = enum_from_str(
            &row.try_get::<String, _>("status")
                .map_err(MeetingStoreError::database)?,
        )?;
        let error_matches = row
            .try_get::<Option<String>, _>("error_code")
            .map_err(MeetingStoreError::database)?
            == value.error.as_ref().map(|error| error.code.clone())
            && row
                .try_get::<Option<String>, _>("error_message")
                .map_err(MeetingStoreError::database)?
                == value.error.as_ref().map(|error| error.message.clone())
            && row
                .try_get::<bool, _>("error_retryable")
                .map_err(MeetingStoreError::database)?
                == value.error.as_ref().is_some_and(|error| error.retryable);
        if existing_status == value.status && error_matches {
            return Ok(());
        }
        if !manual_fact_check_status_transition_allowed(existing_status, value.status) {
            return Err(MeetingStoreError::Conflict);
        }
        sqlx::query(
            r#"UPDATE manual_fact_check_requests SET status = ?, error_code = ?,
               error_message = ?, error_retryable = ?, updated_at_ms = ? WHERE id = ?"#,
        )
        .bind(enum_string(&value.status)?)
        .bind(value.error.as_ref().map(|error| error.code.as_str()))
        .bind(value.error.as_ref().map(|error| error.message.as_str()))
        .bind(value.error.as_ref().is_some_and(|error| error.retryable))
        .bind(now)
        .bind(&value.id)
        .execute(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
        return Ok(());
    }
    sqlx::query(
        r#"INSERT INTO manual_fact_check_requests (
            id, meeting_id, exact_selection, speaker_id, start_ms, end_ms, status,
            error_code, error_message, error_retryable, content_hash, created_at_ms,
            updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&value.id)
    .bind(meeting_id)
    .bind(&value.exact_selection)
    .bind(value.speaker_id.as_deref())
    .bind(value.start_ms)
    .bind(value.end_ms)
    .bind(enum_string(&value.status)?)
    .bind(value.error.as_ref().map(|error| error.code.as_str()))
    .bind(value.error.as_ref().map(|error| error.message.as_str()))
    .bind(value.error.as_ref().is_some_and(|error| error.retryable))
    .bind(&content_hash)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(map_constraint_conflict)?;
    for (ordinal, turn) in value.context_turns.iter().enumerate() {
        sqlx::query(
            r#"INSERT INTO manual_fact_check_request_context_turns (
                request_id, ordinal, turn_id, speaker_id, start_ms, end_ms,
                finalized_text, revision_number, source_kind
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&value.id)
        .bind(ordinal as i64)
        .bind(&turn.id)
        .bind(turn.speaker_id.as_deref())
        .bind(turn.start_ms)
        .bind(turn.end_ms)
        .bind(&turn.text)
        .bind(turn.revision_number as i64)
        .bind(enum_string(&turn.source_kind)?)
        .execute(&mut **tx)
        .await
        .map_err(map_constraint_conflict)?;
    }
    for (ordinal, segment_id) in value.source_segment_ids.iter().enumerate() {
        sqlx::query(
            "INSERT INTO manual_fact_check_request_segments (request_id, ordinal, segment_id) VALUES (?, ?, ?)",
        )
        .bind(&value.id)
        .bind(ordinal as i64)
        .bind(segment_id)
        .execute(&mut **tx)
        .await
        .map_err(map_constraint_conflict)?;
    }
    Ok(())
}

fn manual_fact_check_status_transition_allowed(
    existing: MeetingManualFactCheckRequestStatus,
    next: MeetingManualFactCheckRequestStatus,
) -> bool {
    existing == next
        || matches!(
            (existing, next),
            (
                MeetingManualFactCheckRequestStatus::Queued,
                MeetingManualFactCheckRequestStatus::Processing
                    | MeetingManualFactCheckRequestStatus::RetryWait
                    | MeetingManualFactCheckRequestStatus::Complete
                    | MeetingManualFactCheckRequestStatus::Failed
            ) | (
                MeetingManualFactCheckRequestStatus::Processing,
                MeetingManualFactCheckRequestStatus::RetryWait
                    | MeetingManualFactCheckRequestStatus::Complete
                    | MeetingManualFactCheckRequestStatus::Failed
            ) | (
                MeetingManualFactCheckRequestStatus::RetryWait,
                MeetingManualFactCheckRequestStatus::Processing
                    | MeetingManualFactCheckRequestStatus::Complete
                    | MeetingManualFactCheckRequestStatus::Failed
            )
        )
}

async fn ensure_meeting_segment(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    segment_id: &str,
) -> Result<(), MeetingStoreError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM transcript_segments WHERE id = ? AND meeting_id = ?)",
    )
    .bind(segment_id)
    .bind(meeting_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    if !exists {
        return Err(MeetingStoreError::NotFound);
    }
    Ok(())
}

fn manual_fact_check_request_hash(
    value: &MeetingManualFactCheckRequestUpsertDto,
) -> Result<String, MeetingStoreError> {
    let semantic = serde_json::json!({
        "exactSelection": value.exact_selection,
        "contextTurns": value.context_turns,
        "sourceSegmentIds": value.source_segment_ids,
        "speakerId": value.speaker_id,
        "startMs": value.start_ms,
        "endMs": value.end_ms,
    });
    let bytes = serde_json::to_vec(&semantic).map_err(|_| MeetingStoreError::Serialization)?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

async fn begin_claim_gate_batch(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    batch: &MeetingClaimGateBatchBeginDto,
    now: i64,
) -> Result<(), MeetingStoreError> {
    if let Some(row) =
        sqlx::query("SELECT meeting_id, idempotency_key FROM claim_gate_batches WHERE id = ?")
            .bind(&batch.id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(MeetingStoreError::database)?
    {
        let identity_matches = row
            .try_get::<String, _>("meeting_id")
            .map_err(MeetingStoreError::database)?
            == meeting_id
            && row
                .try_get::<String, _>("idempotency_key")
                .map_err(MeetingStoreError::database)?
                == batch.idempotency_key;
        if !identity_matches {
            return Err(MeetingStoreError::Conflict);
        }
        let rows = sqlx::query(
            r#"SELECT segment_id, segment_revision_number, snapshot_speaker_id,
                      snapshot_start_ms, snapshot_end_ms, snapshot_text,
                      snapshot_source_kind
               FROM claim_gate_batch_segments WHERE batch_id = ? ORDER BY ordinal"#,
        )
        .bind(&batch.id)
        .fetch_all(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
        let stored_turns = rows
            .iter()
            .map(claim_gate_turn_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        if stored_turns != batch.turns {
            return Err(MeetingStoreError::Conflict);
        }
        return Ok(());
    }

    for turn in &batch.turns {
        let row = sqlx::query(
            r#"SELECT cgs.queued_revision_number, cgs.processed_revision_number,
                      ts.revision_number, ts.speaker_id, ts.start_ms, ts.end_ms,
                      ts.finalized_text, ts.source_kind
               FROM claim_gate_segments cgs
               JOIN transcript_segments ts ON ts.id = cgs.segment_id AND ts.meeting_id = cgs.meeting_id
               JOIN transcript_versions tv ON tv.id = ts.transcript_version_id
               WHERE cgs.meeting_id = ? AND cgs.segment_id = ?
                 AND tv.kind = 'live' AND ts.state IN ('final', 'revised')"#,
        )
        .bind(meeting_id)
        .bind(&turn.id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?
        .ok_or(MeetingStoreError::NotFound)?;
        let queued_revision: i64 = row
            .try_get("queued_revision_number")
            .map_err(MeetingStoreError::database)?;
        let processed_revision: Option<i64> = row
            .try_get("processed_revision_number")
            .map_err(MeetingStoreError::database)?;
        let submitted_revision = turn.revision_number as i64;
        if submitted_revision > queued_revision
            || processed_revision.is_some_and(|processed| processed >= submitted_revision)
        {
            return Err(MeetingStoreError::Conflict);
        }
        let current_revision: i64 = row
            .try_get("revision_number")
            .map_err(MeetingStoreError::database)?;
        if submitted_revision == current_revision {
            let current_turn = MeetingClaimGateTurnDto {
                id: turn.id.clone(),
                speaker_id: row
                    .try_get("speaker_id")
                    .map_err(MeetingStoreError::database)?,
                start_ms: row
                    .try_get("start_ms")
                    .map_err(MeetingStoreError::database)?,
                end_ms: row.try_get("end_ms").map_err(MeetingStoreError::database)?,
                text: row
                    .try_get("finalized_text")
                    .map_err(MeetingStoreError::database)?,
                revision_number: current_revision.max(0) as u64,
                source_kind: enum_from_str(
                    &row.try_get::<String, _>("source_kind")
                        .map_err(MeetingStoreError::database)?,
                )?,
            };
            if current_turn != *turn {
                return Err(MeetingStoreError::Conflict);
            }
        }
        let locked_batch_id = sqlx::query_scalar::<_, String>(
            r#"SELECT cgb.id FROM claim_gate_batch_segments cgbs
               JOIN claim_gate_batches cgb ON cgb.id = cgbs.batch_id
               WHERE cgbs.segment_id = ? AND cgbs.segment_revision_number = ?
                 AND cgb.processed_at_ms IS NULL"#,
        )
        .bind(&turn.id)
        .bind(submitted_revision)
        .fetch_optional(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
        if locked_batch_id.is_some() {
            return Err(MeetingStoreError::Conflict);
        }
    }

    sqlx::query(
        r#"INSERT INTO claim_gate_batches (
            id, meeting_id, idempotency_key, created_at_ms
        ) VALUES (?, ?, ?, ?)"#,
    )
    .bind(&batch.id)
    .bind(meeting_id)
    .bind(&batch.idempotency_key)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(map_constraint_conflict)?;
    for (ordinal, turn) in batch.turns.iter().enumerate() {
        sqlx::query(
            r#"INSERT INTO claim_gate_batch_segments (
                batch_id, ordinal, segment_id, segment_revision_number,
                snapshot_speaker_id, snapshot_start_ms, snapshot_end_ms,
                snapshot_text, snapshot_source_kind
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&batch.id)
        .bind(ordinal as i64)
        .bind(&turn.id)
        .bind(turn.revision_number as i64)
        .bind(&turn.speaker_id)
        .bind(turn.start_ms)
        .bind(turn.end_ms)
        .bind(&turn.text)
        .bind(enum_string(&turn.source_kind)?)
        .execute(&mut **tx)
        .await
        .map_err(map_constraint_conflict)?;
    }
    Ok(())
}

async fn complete_claim_gate_batch(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    batch_id: &str,
    now: i64,
) -> Result<(), MeetingStoreError> {
    let row =
        sqlx::query("SELECT meeting_id, processed_at_ms FROM claim_gate_batches WHERE id = ?")
            .bind(batch_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(MeetingStoreError::database)?
            .ok_or(MeetingStoreError::NotFound)?;
    if row
        .try_get::<String, _>("meeting_id")
        .map_err(MeetingStoreError::database)?
        != meeting_id
    {
        return Err(MeetingStoreError::Conflict);
    }
    if row
        .try_get::<Option<i64>, _>("processed_at_ms")
        .map_err(MeetingStoreError::database)?
        .is_some()
    {
        return Ok(());
    }
    let items = sqlx::query(
        r#"SELECT segment_id, segment_revision_number
           FROM claim_gate_batch_segments WHERE batch_id = ? ORDER BY ordinal"#,
    )
    .bind(batch_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    if items.is_empty() {
        return Err(MeetingStoreError::Conflict);
    }
    for item in items {
        let segment_id: String = item
            .try_get("segment_id")
            .map_err(MeetingStoreError::database)?;
        let revision_number: i64 = item
            .try_get("segment_revision_number")
            .map_err(MeetingStoreError::database)?;
        let result = sqlx::query(
            r#"UPDATE claim_gate_segments SET
                processed_revision_number = CASE
                    WHEN processed_revision_number IS NULL OR processed_revision_number < ? THEN ?
                    ELSE processed_revision_number
                END,
                processed_at_ms = ?
               WHERE meeting_id = ? AND segment_id = ?"#,
        )
        .bind(revision_number)
        .bind(revision_number)
        .bind(now)
        .bind(meeting_id)
        .bind(segment_id)
        .execute(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
        if result.rows_affected() != 1 {
            return Err(MeetingStoreError::NotFound);
        }
    }
    let result = sqlx::query(
        "UPDATE claim_gate_batches SET processed_at_ms = ? WHERE id = ? AND processed_at_ms IS NULL",
    )
    .bind(now)
    .bind(batch_id)
    .execute(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    if result.rows_affected() != 1 {
        return Err(MeetingStoreError::Conflict);
    }
    Ok(())
}

async fn apply_claim_version(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    value: &MeetingClaimVersionUpsertDto,
) -> Result<(), MeetingStoreError> {
    if let Some(manual_request_id) = &value.manual_request_id {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM manual_fact_check_requests WHERE id = ? AND meeting_id = ?)",
        )
        .bind(manual_request_id)
        .bind(meeting_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
        if !exists {
            return Err(MeetingStoreError::NotFound);
        }
    }
    if let Some(speaker_id) = &value.speaker_id {
        ensure_speaker(tx, meeting_id, speaker_id).await?;
    }
    if let Some(version_id) = &value.source_transcript_version_id {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM transcript_versions WHERE id = ? AND meeting_id = ?)",
        )
        .bind(version_id)
        .bind(meeting_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
        if !exists {
            return Err(MeetingStoreError::NotFound);
        }
    }
    for related_version_id in [&value.predecessor_id, &value.superseded_by_id]
        .into_iter()
        .flatten()
    {
        ensure_claim_version_relationship(tx, meeting_id, &value.claim_id, related_version_id)
            .await?;
    }
    let now = now_ms();
    let existing_claim =
        sqlx::query("SELECT meeting_id, origin, manual_request_id FROM claims WHERE id = ?")
            .bind(&value.claim_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(MeetingStoreError::database)?;
    if let Some(row) = existing_claim {
        if row
            .try_get::<String, _>("meeting_id")
            .map_err(MeetingStoreError::database)?
            != meeting_id
            || row
                .try_get::<String, _>("origin")
                .map_err(MeetingStoreError::database)?
                != enum_string(&value.origin)?
            || row
                .try_get::<Option<String>, _>("manual_request_id")
                .map_err(MeetingStoreError::database)?
                != value.manual_request_id
        {
            return Err(MeetingStoreError::Conflict);
        }
        sqlx::query(
            "UPDATE claims SET duplicate_key = COALESCE(?, duplicate_key), status = ?, updated_at_ms = ? WHERE id = ?",
        )
        .bind(value.duplicate_key.as_deref())
        .bind(enum_string(&value.status)?)
        .bind(now)
        .bind(&value.claim_id)
        .execute(&mut **tx)
        .await
        .map_err(map_constraint_conflict)?;
    } else {
        sqlx::query(
            r#"INSERT INTO claims (
                id, meeting_id, manual_request_id, origin, duplicate_key, status,
                created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&value.claim_id)
        .bind(meeting_id)
        .bind(value.manual_request_id.as_deref())
        .bind(enum_string(&value.origin)?)
        .bind(value.duplicate_key.as_deref())
        .bind(enum_string(&value.status)?)
        .bind(now)
        .bind(now)
        .execute(&mut **tx)
        .await
        .map_err(map_constraint_conflict)?;
    }
    let content_hash = claim_version_hash(value)?;
    if let Some(row) = sqlx::query(
        "SELECT claim_id, version_number, content_hash FROM claim_versions WHERE id = ?",
    )
    .bind(&value.claim_version_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?
    {
        let same = row
            .try_get::<String, _>("claim_id")
            .map_err(MeetingStoreError::database)?
            == value.claim_id
            && row
                .try_get::<i64, _>("version_number")
                .map_err(MeetingStoreError::database)?
                == i64::from(value.version_number)
            && row
                .try_get::<String, _>("content_hash")
                .map_err(MeetingStoreError::database)?
                == content_hash;
        if !same {
            return Err(MeetingStoreError::Conflict);
        }
        sqlx::query(
            "UPDATE claim_versions SET lifecycle = ?, superseded_by_id = COALESCE(?, superseded_by_id) WHERE id = ?",
        )
        .bind(enum_string(&value.lifecycle)?)
        .bind(value.superseded_by_id.as_deref())
        .bind(&value.claim_version_id)
        .execute(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
    } else {
        sqlx::query(
            r#"INSERT INTO claim_versions (
                id, claim_id, version_number, predecessor_id, superseded_by_id,
                source_transcript_version_id, exact_quote, normalized_claim, speaker_id,
                start_ms, end_ms, selection_rationale, consequence_score, dispute_score,
                specificity_score, time_sensitive, lifecycle, content_hash, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&value.claim_version_id)
        .bind(&value.claim_id)
        .bind(i64::from(value.version_number))
        .bind(value.predecessor_id.as_deref())
        .bind(value.superseded_by_id.as_deref())
        .bind(value.source_transcript_version_id.as_deref())
        .bind(&value.exact_quote)
        .bind(&value.normalized_claim)
        .bind(value.speaker_id.as_deref())
        .bind(value.start_ms)
        .bind(value.end_ms)
        .bind(value.selection_rationale.as_deref())
        .bind(value.consequence_score)
        .bind(value.dispute_score)
        .bind(value.specificity_score)
        .bind(value.time_sensitive)
        .bind(enum_string(&value.lifecycle)?)
        .bind(content_hash)
        .bind(now)
        .execute(&mut **tx)
        .await
        .map_err(map_constraint_conflict)?;
        for (ordinal, segment_id) in value.segment_ids.iter().enumerate() {
            let result = sqlx::query(
                r#"INSERT INTO claim_version_segments(claim_version_id, segment_id, ordinal)
                   SELECT ?, id, ? FROM transcript_segments WHERE id = ? AND meeting_id = ?"#,
            )
            .bind(&value.claim_version_id)
            .bind(ordinal as i64)
            .bind(segment_id)
            .bind(meeting_id)
            .execute(&mut **tx)
            .await
            .map_err(MeetingStoreError::database)?;
            if result.rows_affected() != 1 {
                return Err(MeetingStoreError::NotFound);
            }
        }
    }
    if value.set_current {
        let previous: Option<String> =
            sqlx::query_scalar("SELECT current_claim_version_id FROM claims WHERE id = ?")
                .bind(&value.claim_id)
                .fetch_one(&mut **tx)
                .await
                .map_err(MeetingStoreError::database)?;
        if let Some(previous) = previous.filter(|id| id != &value.claim_version_id) {
            sqlx::query(
                "UPDATE claim_versions SET lifecycle = 'superseded', superseded_by_id = ? WHERE id = ?",
            )
            .bind(&value.claim_version_id)
            .bind(previous)
            .execute(&mut **tx)
            .await
            .map_err(MeetingStoreError::database)?;
        }
        if let Some(predecessor) = &value.predecessor_id {
            sqlx::query(
                "UPDATE claim_versions SET lifecycle = 'superseded', superseded_by_id = ? WHERE id = ?",
            )
                .bind(&value.claim_version_id)
                .bind(predecessor)
                .execute(&mut **tx)
                .await
                .map_err(MeetingStoreError::database)?;
        }
        sqlx::query(
            "UPDATE claims SET current_claim_version_id = ?, status = ?, updated_at_ms = ? WHERE id = ?",
        )
        .bind(&value.claim_version_id)
        .bind(enum_string(&value.status)?)
        .bind(now)
        .bind(&value.claim_id)
        .execute(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
    }
    Ok(())
}

async fn ensure_claim_version_relationship(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    claim_id: &str,
    claim_version_id: &str,
) -> Result<(), MeetingStoreError> {
    let row = sqlx::query(
        r#"SELECT cv.claim_id, c.meeting_id FROM claim_versions cv
           JOIN claims c ON c.id = cv.claim_id WHERE cv.id = ?"#,
    )
    .bind(claim_version_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?
    .ok_or(MeetingStoreError::NotFound)?;
    let related_claim_id: String = row
        .try_get("claim_id")
        .map_err(MeetingStoreError::database)?;
    let related_meeting_id: String = row
        .try_get("meeting_id")
        .map_err(MeetingStoreError::database)?;
    if related_claim_id != claim_id || related_meeting_id != meeting_id {
        return Err(MeetingStoreError::Conflict);
    }
    Ok(())
}

async fn mark_claim_versions_stale(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    ids: &[String],
) -> Result<(), MeetingStoreError> {
    for id in ids {
        let result = sqlx::query(
            r#"UPDATE claim_versions SET lifecycle = 'stale' WHERE id = ? AND claim_id IN
               (SELECT id FROM claims WHERE meeting_id = ?)"#,
        )
        .bind(id)
        .bind(meeting_id)
        .execute(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
        if result.rows_affected() != 1 {
            return Err(MeetingStoreError::NotFound);
        }
        sqlx::query(
            r#"UPDATE claims SET status = 'stale', updated_at_ms = ?
               WHERE meeting_id = ? AND current_claim_version_id = ?"#,
        )
        .bind(now_ms())
        .bind(meeting_id)
        .bind(id)
        .execute(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
    }
    Ok(())
}

fn claim_version_hash(value: &MeetingClaimVersionUpsertDto) -> Result<String, MeetingStoreError> {
    let semantic = serde_json::json!({
        "claimId": value.claim_id,
        "manualRequestId": value.manual_request_id,
        "versionNumber": value.version_number,
        "predecessorId": value.predecessor_id,
        "sourceTranscriptVersionId": value.source_transcript_version_id,
        "exactQuote": value.exact_quote,
        "normalizedClaim": value.normalized_claim,
        "speakerId": value.speaker_id,
        "startMs": value.start_ms,
        "endMs": value.end_ms,
        "segmentIds": value.segment_ids,
        "selectionRationale": value.selection_rationale,
        "consequenceScore": value.consequence_score,
        "disputeScore": value.dispute_score,
        "specificityScore": value.specificity_score,
        "timeSensitive": value.time_sensitive,
    });
    let bytes = serde_json::to_vec(&semantic).map_err(|_| MeetingStoreError::Serialization)?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

fn map_constraint_conflict(error: sqlx::Error) -> MeetingStoreError {
    if matches!(&error, sqlx::Error::Database(database) if database.is_unique_violation()) {
        MeetingStoreError::Conflict
    } else {
        MeetingStoreError::database(error)
    }
}

fn claim_from_row(row: &SqliteRow) -> Result<MeetingClaimDto, MeetingStoreError> {
    Ok(MeetingClaimDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        meeting_id: row
            .try_get("meeting_id")
            .map_err(MeetingStoreError::database)?,
        manual_request_id: row
            .try_get("manual_request_id")
            .map_err(MeetingStoreError::database)?,
        origin: enum_from_str(
            &row.try_get::<String, _>("origin")
                .map_err(MeetingStoreError::database)?,
        )?,
        duplicate_key: row
            .try_get("duplicate_key")
            .map_err(MeetingStoreError::database)?,
        status: enum_from_str(
            &row.try_get::<String, _>("status")
                .map_err(MeetingStoreError::database)?,
        )?,
        current_claim_version_id: row
            .try_get("current_claim_version_id")
            .map_err(MeetingStoreError::database)?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

fn claim_version_from_row(
    row: &SqliteRow,
    segment_ids: Vec<String>,
) -> Result<MeetingClaimVersionDto, MeetingStoreError> {
    Ok(MeetingClaimVersionDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        claim_id: row
            .try_get("claim_id")
            .map_err(MeetingStoreError::database)?,
        version_number: row
            .try_get::<i64, _>("version_number")
            .map_err(MeetingStoreError::database)?
            .max(0) as u32,
        predecessor_id: row
            .try_get("predecessor_id")
            .map_err(MeetingStoreError::database)?,
        superseded_by_id: row
            .try_get("superseded_by_id")
            .map_err(MeetingStoreError::database)?,
        source_transcript_version_id: row
            .try_get("source_transcript_version_id")
            .map_err(MeetingStoreError::database)?,
        exact_quote: row
            .try_get("exact_quote")
            .map_err(MeetingStoreError::database)?,
        normalized_claim: row
            .try_get("normalized_claim")
            .map_err(MeetingStoreError::database)?,
        speaker_id: row
            .try_get("speaker_id")
            .map_err(MeetingStoreError::database)?,
        start_ms: row
            .try_get("start_ms")
            .map_err(MeetingStoreError::database)?,
        end_ms: row.try_get("end_ms").map_err(MeetingStoreError::database)?,
        segment_ids,
        selection_rationale: row
            .try_get("selection_rationale")
            .map_err(MeetingStoreError::database)?,
        consequence_score: row
            .try_get("consequence_score")
            .map_err(MeetingStoreError::database)?,
        dispute_score: row
            .try_get("dispute_score")
            .map_err(MeetingStoreError::database)?,
        specificity_score: row
            .try_get("specificity_score")
            .map_err(MeetingStoreError::database)?,
        time_sensitive: row
            .try_get("time_sensitive")
            .map_err(MeetingStoreError::database)?,
        lifecycle: enum_from_str(
            &row.try_get::<String, _>("lifecycle")
                .map_err(MeetingStoreError::database)?,
        )?,
        content_hash: row
            .try_get("content_hash")
            .map_err(MeetingStoreError::database)?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

impl MeetingStore {
    pub async fn get_artifact(
        &self,
        request: MeetingGetRequest,
    ) -> Result<MeetingGetResponse, MeetingStoreError> {
        validation::uuid(&request.meeting_id)?;
        let meeting = self.get_meeting(&request.meeting_id, false).await?;
        Ok(MeetingGetResponse {
            artifact: MeetingArtifactDto {
                speakers: self.list_speakers(&request.meeting_id).await?,
                speaker_observations: self.list_speaker_observations(&request.meeting_id).await?,
                transcript_versions: self.list_transcript_versions(&request.meeting_id).await?,
                transcript_segments: self.list_transcript_segments(&request.meeting_id).await?,
                timeline_events: self.list_timeline_events(&request.meeting_id).await?,
                audio_assets: self.list_audio_assets(&request.meeting_id).await?,
                refinement_inputs: self.list_refinement_inputs(&request.meeting_id).await?,
                claims: self.list_claims(&request.meeting_id).await?,
                claim_versions: self.list_claim_versions(&request.meeting_id).await?,
                manual_fact_check_requests: self
                    .list_manual_fact_check_requests(&request.meeting_id)
                    .await?,
                pending_claim_gate_segment_ids: self
                    .list_pending_claim_gate_segment_ids(&request.meeting_id)
                    .await?,
                pending_claim_gate_batches: self
                    .list_pending_claim_gate_batches(&request.meeting_id)
                    .await?,
                assessments: self.list_assessments(&request.meeting_id).await?,
                research_jobs: self.list_research_jobs(&request.meeting_id).await?,
                refinement_jobs: self.list_refinement_jobs(&request.meeting_id).await?,
                meeting,
            },
        })
    }

    pub async fn apply_research(
        &self,
        request: MeetingResearchApplyRequest,
    ) -> Result<MeetingResearchApplyResponse, MeetingStoreError> {
        validation::uuid(&request.meeting_id)?;
        if request.job.is_none() && request.assessment.is_none() {
            return Err(MeetingStoreError::validation("research update is empty"));
        }
        if let Some(job) = &request.job {
            validate_research_job(job)?;
        }
        if let Some(assessment) = &request.assessment {
            validate_assessment(assessment)?;
        }
        self.get_meeting(&request.meeting_id, false).await?;
        let pool = self.pool().await?;
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(MeetingStoreError::database)?;
        let now = now_ms();
        if let Some(job) = &request.job {
            upsert_research_job(&mut tx, &request.meeting_id, job).await?;
            update_claim_status_for_version(
                &mut tx,
                &request.meeting_id,
                &job.claim_version_id,
                claim_status_for_research_job(job.stage, job.status),
                now,
            )
            .await?;
        }
        if let Some(assessment) = &request.assessment {
            insert_assessment(&mut tx, &request.meeting_id, assessment).await?;
            update_claim_status_for_version(
                &mut tx,
                &request.meeting_id,
                &assessment.claim_version_id,
                claim_status_for_assessment(assessment.stage, assessment.status),
                now,
            )
            .await?;
        }
        if let Some(job) = &request.job {
            let research_status = match job.status {
                MeetingJobStatus::Pending => MeetingResearchStatus::Queued,
                MeetingJobStatus::Running => MeetingResearchStatus::Running,
                MeetingJobStatus::RetryWait => MeetingResearchStatus::RetryWait,
                MeetingJobStatus::Complete => MeetingResearchStatus::Complete,
                MeetingJobStatus::Failed => MeetingResearchStatus::Failed,
                MeetingJobStatus::Cancelled => MeetingResearchStatus::Cancelled,
            };
            sqlx::query("UPDATE meetings SET research_status = ?, updated_at_ms = ? WHERE id = ?")
                .bind(enum_string(&research_status)?)
                .bind(now)
                .bind(&request.meeting_id)
                .execute(&mut *tx)
                .await
                .map_err(MeetingStoreError::database)?;
        } else {
            sqlx::query("UPDATE meetings SET updated_at_ms = ? WHERE id = ?")
                .bind(now)
                .bind(&request.meeting_id)
                .execute(&mut *tx)
                .await
                .map_err(MeetingStoreError::database)?;
        }
        tx.commit().await.map_err(MeetingStoreError::database)?;
        Ok(MeetingResearchApplyResponse {
            job: match request.job {
                Some(job) => Some(self.get_research_job(&job.id).await?),
                None => None,
            },
            assessment: match request.assessment {
                Some(assessment) => Some(self.get_assessment(&assessment.id).await?),
                None => None,
            },
        })
    }

    pub async fn apply_refinement_job(
        &self,
        request: MeetingRefinementJobApplyRequest,
    ) -> Result<MeetingRefinementJobApplyResponse, MeetingStoreError> {
        validation::uuid(&request.meeting_id)?;
        validate_refinement_job(&request.job)?;
        self.get_meeting(&request.meeting_id, false).await?;
        let pool = self.pool().await?;
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(MeetingStoreError::database)?;
        upsert_refinement_job(&mut tx, &request.meeting_id, &request.job).await?;
        let refinement_status = refinement_status_for_job(request.job.status);
        sqlx::query("UPDATE meetings SET refinement_status = ?, updated_at_ms = ? WHERE id = ?")
            .bind(enum_string(&refinement_status)?)
            .bind(now_ms())
            .bind(&request.meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
        tx.commit().await.map_err(MeetingStoreError::database)?;
        Ok(MeetingRefinementJobApplyResponse {
            job: self.get_refinement_job(&request.job.id).await?,
        })
    }

    pub async fn apply_refinement_result(
        &self,
        request: MeetingRefinementResultApplyRequest,
    ) -> Result<MeetingRefinementResultApplyResponse, MeetingStoreError> {
        validation::uuid(&request.refinement_job_id)?;
        if request.version.kind != MeetingTranscriptVersionKind::Refined
            || request.version.status != MeetingTranscriptVersionStatus::Complete
        {
            return Err(MeetingStoreError::validation(
                "refinement result must be a complete refined transcript",
            ));
        }
        validate_transcript_request(&MeetingTranscriptApplyRequest {
            meeting_id: request.meeting_id.clone(),
            version: request.version.clone(),
            segments: request.segments.clone(),
            speaker_observations: request.speaker_observations.clone(),
            promote_canonical: true,
        })?;
        if request.mark_stale_claim_version_ids.len() + request.replacement_claim_versions.len()
            > validation::MAX_CLAIMS_PER_BATCH
        {
            return Err(MeetingStoreError::validation("claim batch is too large"));
        }
        for id in &request.mark_stale_claim_version_ids {
            validation::uuid(id)?;
        }
        validate_claims_request(&MeetingClaimsApplyRequest {
            meeting_id: request.meeting_id.clone(),
            claim_versions: request.replacement_claim_versions.clone(),
            ..Default::default()
        })?;
        let stale_ids = request
            .mark_stale_claim_version_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut predecessor_ids = HashSet::new();
        for replacement in &request.replacement_claim_versions {
            let Some(predecessor_id) = replacement.predecessor_id.as_deref() else {
                return Err(MeetingStoreError::validation(
                    "refinement replacement requires a predecessor",
                ));
            };
            if !stale_ids.contains(predecessor_id)
                || !predecessor_ids.insert(predecessor_id)
                || replacement.source_transcript_version_id.as_deref()
                    != Some(request.version.id.as_str())
                || replacement.status != MeetingClaimStatus::Rechecking
                || replacement.lifecycle != MeetingClaimVersionLifecycle::Rechecking
                || !replacement.set_current
            {
                return Err(MeetingStoreError::validation(
                    "invalid refinement replacement claim version",
                ));
            }
        }
        self.get_meeting(&request.meeting_id, false).await?;
        let pool = self.pool().await?;
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(MeetingStoreError::database)?;
        ensure_refinement_job(&mut tx, &request.meeting_id, &request.refinement_job_id).await?;
        upsert_transcript_version(&mut tx, &request.meeting_id, &request.version).await?;
        let mut outcomes = Vec::with_capacity(request.segments.len());
        for segment in &request.segments {
            outcomes.push(upsert_transcript_segment(&mut tx, &request.meeting_id, segment).await?);
        }
        for observation in &request.speaker_observations {
            upsert_speaker_observation(&mut tx, &request.meeting_id, observation).await?;
        }
        mark_claim_versions_stale(
            &mut tx,
            &request.meeting_id,
            &request.mark_stale_claim_version_ids,
        )
        .await?;
        for replacement in &request.replacement_claim_versions {
            apply_claim_version(&mut tx, &request.meeting_id, replacement).await?;
        }
        let now = now_ms();
        sqlx::query(
            "UPDATE transcript_refinement_jobs SET status = 'complete', completed_at_ms = COALESCE(completed_at_ms, ?), error_code = NULL, error_message = NULL, error_retryable = 0, updated_at_ms = ? WHERE id = ?",
        )
        .bind(now)
        .bind(now)
        .bind(&request.refinement_job_id)
        .execute(&mut *tx)
        .await
        .map_err(MeetingStoreError::database)?;
        sqlx::query(
            "UPDATE meetings SET canonical_transcript_version_id = ?, refinement_status = 'complete', updated_at_ms = ? WHERE id = ? AND deleted_at_ms IS NULL",
        )
        .bind(&request.version.id)
        .bind(now)
        .bind(&request.meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(MeetingStoreError::database)?;
        tx.commit().await.map_err(MeetingStoreError::database)?;
        Ok(MeetingRefinementResultApplyResponse {
            canonical_version: self.get_transcript_version(&request.version.id).await?,
            segment_outcomes: outcomes,
        })
    }

    pub async fn delete_meeting(
        &self,
        request: MeetingDeleteRequest,
    ) -> Result<MeetingDeleteResponse, MeetingStoreError> {
        validation::uuid(&request.meeting_id)?;
        self.get_meeting(&request.meeting_id, true).await?;
        let pool = self.pool().await?;
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(MeetingStoreError::database)?;
        let existing_id =
            sqlx::query_scalar::<_, String>("SELECT id FROM cleanup_jobs WHERE meeting_id = ?")
                .bind(&request.meeting_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(MeetingStoreError::database)?;
        let cleanup_job_id = existing_id.unwrap_or_else(|| Uuid::now_v7().to_string());
        let now = now_ms();
        sqlx::query(
            "UPDATE meetings SET deleted_at_ms = COALESCE(deleted_at_ms, ?), updated_at_ms = ? WHERE id = ?",
        )
        .bind(now)
        .bind(now)
        .bind(&request.meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(MeetingStoreError::database)?;
        sqlx::query(
            r#"INSERT INTO cleanup_jobs (
                id, meeting_id, local_status, gateway_status, provider_status,
                attempt_count, created_at_ms, updated_at_ms
            ) VALUES (?, ?, 'pending', 'pending', 'pending', 0, ?, ?)
            ON CONFLICT(meeting_id) DO NOTHING"#,
        )
        .bind(&cleanup_job_id)
        .bind(&request.meeting_id)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(MeetingStoreError::database)?;
        let asset_rows =
            sqlx::query("SELECT id, relative_path FROM audio_assets WHERE meeting_id = ?")
                .bind(&request.meeting_id)
                .fetch_all(&mut *tx)
                .await
                .map_err(MeetingStoreError::database)?;
        for row in asset_rows {
            let asset_id: String = row.try_get("id").map_err(MeetingStoreError::database)?;
            let relative_path: String = row
                .try_get("relative_path")
                .map_err(MeetingStoreError::database)?;
            validation::controlled_relative_path(&relative_path)?;
            sqlx::query(
                "INSERT OR IGNORE INTO cleanup_job_assets(cleanup_job_id, audio_asset_id, relative_path) VALUES (?, ?, ?)",
            )
            .bind(&cleanup_job_id)
            .bind(asset_id)
            .bind(relative_path)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
        }
        tx.commit().await.map_err(MeetingStoreError::database)?;
        Ok(MeetingDeleteResponse {
            cleanup_job: self.get_cleanup_job(&cleanup_job_id).await?,
        })
    }

    pub async fn confirm_cleanup(
        &self,
        request: MeetingCleanupConfirmRequest,
    ) -> Result<MeetingCleanupConfirmResponse, MeetingStoreError> {
        validation::uuid(&request.cleanup_job_id)?;
        validation::typed_error(request.error.as_ref())?;
        let pool = self.pool().await?;
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(MeetingStoreError::database)?;
        let result = sqlx::query(
            r#"UPDATE cleanup_jobs SET local_status = ?, gateway_status = ?, provider_status = ?,
               error_code = ?, error_message = ?, error_retryable = ?,
               attempt_count = attempt_count + 1, updated_at_ms = ? WHERE id = ?"#,
        )
        .bind(enum_string(&request.local_status)?)
        .bind(enum_string(&request.gateway_status)?)
        .bind(enum_string(&request.provider_status)?)
        .bind(request.error.as_ref().map(|error| error.code.as_str()))
        .bind(request.error.as_ref().map(|error| error.message.as_str()))
        .bind(request.error.as_ref().is_some_and(|error| error.retryable))
        .bind(now_ms())
        .bind(&request.cleanup_job_id)
        .execute(&mut *tx)
        .await
        .map_err(MeetingStoreError::database)?;
        if result.rows_affected() != 1 {
            return Err(MeetingStoreError::NotFound);
        }
        let terminal = cleanup_terminal(request.local_status)
            && cleanup_terminal(request.gateway_status)
            && cleanup_terminal(request.provider_status);
        if terminal {
            let meeting_id: String =
                sqlx::query_scalar("SELECT meeting_id FROM cleanup_jobs WHERE id = ?")
                    .bind(&request.cleanup_job_id)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(MeetingStoreError::database)?;
            sqlx::query(
                r#"DELETE FROM transcript_segment_replacements
                   WHERE refined_segment_id IN (
                       SELECT id FROM transcript_segments WHERE meeting_id = ?
                   ) OR live_segment_id IN (
                       SELECT id FROM transcript_segments WHERE meeting_id = ?
                   )"#,
            )
            .bind(&meeting_id)
            .bind(&meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
            sqlx::query("DELETE FROM meetings WHERE id = ? AND deleted_at_ms IS NOT NULL")
                .bind(&meeting_id)
                .execute(&mut *tx)
                .await
                .map_err(MeetingStoreError::database)?;
            tx.commit().await.map_err(MeetingStoreError::database)?;
            return Ok(MeetingCleanupConfirmResponse {
                cleanup_job: None,
                records_removed: true,
            });
        }
        tx.commit().await.map_err(MeetingStoreError::database)?;
        Ok(MeetingCleanupConfirmResponse {
            cleanup_job: Some(self.get_cleanup_job(&request.cleanup_job_id).await?),
            records_removed: false,
        })
    }

    pub async fn recover(
        &self,
        request: MeetingRecoverRequest,
    ) -> Result<MeetingRecoverResponse, MeetingStoreError> {
        let pool = self.pool().await?;
        let mut tx = if request.reconcile_active_work {
            pool.begin_with("BEGIN IMMEDIATE").await
        } else {
            pool.begin().await
        }
        .map_err(MeetingStoreError::database)?;
        let mut interrupted_meeting_ids = Vec::new();
        if request.reconcile_active_work {
            let interrupted_rows = sqlx::query(
                "SELECT id FROM meetings WHERE deleted_at_ms IS NULL AND status IN ('starting','recording','paused','stopping','finalizing') ORDER BY id",
            )
            .fetch_all(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
            interrupted_meeting_ids = string_column(&interrupted_rows, "id")?;
            let now = now_ms();
            sqlx::query(
                "UPDATE meetings SET status = 'interrupted', capture_status = 'interrupted', updated_at_ms = ? WHERE deleted_at_ms IS NULL AND status IN ('starting','recording','paused','stopping','finalizing')",
            )
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
            sqlx::query(
                "UPDATE audio_assets SET status = 'interrupted', updated_at_ms = ? WHERE status = 'recording'",
            )
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
            sqlx::query(
                "UPDATE research_jobs SET status = 'retry_wait', next_retry_at_ms = COALESCE(next_retry_at_ms, ?), updated_at_ms = ? WHERE status = 'running'",
            )
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
            sqlx::query(
                "UPDATE transcript_refinement_jobs SET status = 'retry_wait', next_retry_at_ms = COALESCE(next_retry_at_ms, ?), updated_at_ms = ? WHERE status IN ('uploading','processing','reconciling')",
            )
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
            sqlx::query(
                "UPDATE cleanup_jobs SET local_status = CASE WHEN local_status = 'running' THEN 'retry_wait' ELSE local_status END, gateway_status = CASE WHEN gateway_status = 'running' THEN 'retry_wait' ELSE gateway_status END, provider_status = CASE WHEN provider_status = 'running' THEN 'retry_wait' ELSE provider_status END, next_retry_at_ms = COALESCE(next_retry_at_ms, ?), updated_at_ms = ? WHERE local_status = 'running' OR gateway_status = 'running' OR provider_status = 'running'",
            )
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?;
        }
        let refinement_query = if request.reconcile_active_work {
            "SELECT id FROM transcript_refinement_jobs WHERE status IN ('queued','retry_wait') ORDER BY id"
        } else {
            "SELECT id FROM transcript_refinement_jobs WHERE status = 'retry_wait' ORDER BY id"
        };
        let refinement_job_ids = string_column(
            &sqlx::query(refinement_query)
                .fetch_all(&mut *tx)
                .await
                .map_err(MeetingStoreError::database)?,
            "id",
        )?;
        let research_query = if request.reconcile_active_work {
            "SELECT id FROM research_jobs WHERE status IN ('pending','retry_wait') ORDER BY id"
        } else {
            "SELECT id FROM research_jobs WHERE status = 'retry_wait' ORDER BY id"
        };
        let research_job_ids = string_column(
            &sqlx::query(research_query)
                .fetch_all(&mut *tx)
                .await
                .map_err(MeetingStoreError::database)?,
            "id",
        )?;
        let cleanup_job_ids = string_column(
            &sqlx::query(
                "SELECT id FROM cleanup_jobs WHERE (local_status IN ('pending','retry_wait') OR gateway_status IN ('pending','retry_wait') OR provider_status IN ('pending','retry_wait')) AND local_status != 'running' AND gateway_status != 'running' AND provider_status != 'running' ORDER BY id",
            )
            .fetch_all(&mut *tx)
            .await
            .map_err(MeetingStoreError::database)?,
            "id",
        )?;
        tx.commit().await.map_err(MeetingStoreError::database)?;
        let mut refinement_jobs = Vec::with_capacity(refinement_job_ids.len());
        for id in &refinement_job_ids {
            refinement_jobs.push(self.get_refinement_job(id).await?);
        }
        let mut research_jobs = Vec::with_capacity(research_job_ids.len());
        for id in &research_job_ids {
            research_jobs.push(self.get_research_job(id).await?);
        }
        let mut cleanup_jobs = Vec::with_capacity(cleanup_job_ids.len());
        for id in &cleanup_job_ids {
            cleanup_jobs.push(self.get_cleanup_job(id).await?);
        }
        Ok(MeetingRecoverResponse {
            interrupted_meeting_ids,
            refinement_job_ids,
            research_job_ids,
            cleanup_job_ids,
            refinement_jobs,
            research_jobs,
            cleanup_jobs,
        })
    }

    async fn list_speaker_observations(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingSpeakerObservationDto>, MeetingStoreError> {
        let rows = sqlx::query(
            "SELECT * FROM speaker_observations WHERE meeting_id = ? ORDER BY transcript_version_id, provider_namespace, provider_speaker_label",
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        rows.iter().map(speaker_observation_from_row).collect()
    }

    async fn list_transcript_versions(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingTranscriptVersionDto>, MeetingStoreError> {
        let rows = sqlx::query(
            "SELECT * FROM transcript_versions WHERE meeting_id = ? ORDER BY revision_number, created_at_ms, id",
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        rows.iter().map(transcript_version_from_row).collect()
    }

    async fn list_transcript_segments(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingTranscriptSegmentDto>, MeetingStoreError> {
        let rows = sqlx::query(
            "SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY transcript_version_id, start_ms, provider_turn_order, id",
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        let mut values = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id").map_err(MeetingStoreError::database)?;
            let replacements = sqlx::query(
                "SELECT live_segment_id FROM transcript_segment_replacements WHERE refined_segment_id = ? ORDER BY live_segment_id",
            )
            .bind(&id)
            .fetch_all(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?;
            values.push(transcript_segment_from_row(
                &row,
                string_column(&replacements, "live_segment_id")?,
            )?);
        }
        Ok(values)
    }

    async fn list_assessments(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingAssessmentDto>, MeetingStoreError> {
        let rows = sqlx::query(
            r#"SELECT a.* FROM assessments a
               JOIN claim_versions cv ON cv.id = a.claim_version_id
               JOIN claims c ON c.id = cv.claim_id
               WHERE c.meeting_id = ? ORDER BY a.started_at_ms, a.id"#,
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        let mut values = Vec::with_capacity(rows.len());
        for row in rows {
            values.push(self.assessment_from_row_with_sources(&row).await?);
        }
        Ok(values)
    }

    async fn list_research_jobs(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingResearchJobDto>, MeetingStoreError> {
        let rows = sqlx::query(
            r#"SELECT r.* FROM research_jobs r
               JOIN claim_versions cv ON cv.id = r.claim_version_id
               JOIN claims c ON c.id = cv.claim_id
               WHERE c.meeting_id = ? ORDER BY r.created_at_ms, r.id"#,
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        rows.iter().map(research_job_from_row).collect()
    }

    async fn list_refinement_jobs(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<MeetingRefinementJobDto>, MeetingStoreError> {
        let rows = sqlx::query(
            "SELECT * FROM transcript_refinement_jobs WHERE meeting_id = ? ORDER BY created_at_ms, id",
        )
        .bind(meeting_id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        rows.iter().map(refinement_job_from_row).collect()
    }

    async fn get_research_job(&self, id: &str) -> Result<MeetingResearchJobDto, MeetingStoreError> {
        let row = sqlx::query("SELECT * FROM research_jobs WHERE id = ?")
            .bind(id)
            .fetch_optional(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?
            .ok_or(MeetingStoreError::NotFound)?;
        research_job_from_row(&row)
    }

    async fn get_refinement_job(
        &self,
        id: &str,
    ) -> Result<MeetingRefinementJobDto, MeetingStoreError> {
        let row = sqlx::query("SELECT * FROM transcript_refinement_jobs WHERE id = ?")
            .bind(id)
            .fetch_optional(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?
            .ok_or(MeetingStoreError::NotFound)?;
        refinement_job_from_row(&row)
    }

    async fn get_assessment(&self, id: &str) -> Result<MeetingAssessmentDto, MeetingStoreError> {
        let row = sqlx::query("SELECT * FROM assessments WHERE id = ?")
            .bind(id)
            .fetch_optional(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?
            .ok_or(MeetingStoreError::NotFound)?;
        self.assessment_from_row_with_sources(&row).await
    }

    async fn assessment_from_row_with_sources(
        &self,
        row: &SqliteRow,
    ) -> Result<MeetingAssessmentDto, MeetingStoreError> {
        let assessment_id: String = row.try_get("id").map_err(MeetingStoreError::database)?;
        let source_rows =
            sqlx::query("SELECT * FROM sources WHERE assessment_id = ? ORDER BY citation_key, id")
                .bind(&assessment_id)
                .fetch_all(self.pool().await?)
                .await
                .map_err(MeetingStoreError::database)?;
        assessment_from_row(
            row,
            source_rows
                .iter()
                .map(source_from_row)
                .collect::<Result<Vec<_>, _>>()?,
        )
    }

    async fn get_cleanup_job(&self, id: &str) -> Result<MeetingCleanupJobDto, MeetingStoreError> {
        let row = sqlx::query("SELECT * FROM cleanup_jobs WHERE id = ?")
            .bind(id)
            .fetch_optional(self.pool().await?)
            .await
            .map_err(MeetingStoreError::database)?
            .ok_or(MeetingStoreError::NotFound)?;
        let paths = sqlx::query(
            "SELECT relative_path FROM cleanup_job_assets WHERE cleanup_job_id = ? ORDER BY relative_path",
        )
        .bind(id)
        .fetch_all(self.pool().await?)
        .await
        .map_err(MeetingStoreError::database)?;
        cleanup_job_from_row(&row, string_column(&paths, "relative_path")?)
    }
}

fn validate_research_job(value: &MeetingResearchJobUpsertDto) -> Result<(), MeetingStoreError> {
    validation::uuid(&value.id)?;
    validation::uuid(&value.claim_version_id)?;
    validation::nonempty(
        &value.idempotency_key,
        512,
        "invalid research idempotency key",
    )?;
    validation::optional(
        value.gateway_job_id.as_deref(),
        512,
        "invalid gateway job identifier",
    )?;
    validation::typed_error(value.error.as_ref())?;
    validate_optional_time(value.next_retry_at_ms)?;
    validate_optional_time(value.started_at_ms)?;
    validate_optional_time(value.completed_at_ms)
}

fn claim_status_for_research_job(
    stage: MeetingAssessmentStage,
    status: MeetingJobStatus,
) -> MeetingClaimStatus {
    match status {
        MeetingJobStatus::Pending | MeetingJobStatus::RetryWait => MeetingClaimStatus::Queued,
        MeetingJobStatus::Running => match stage {
            MeetingAssessmentStage::Preliminary => MeetingClaimStatus::QuickRunning,
            MeetingAssessmentStage::Deep => MeetingClaimStatus::DeepRunning,
        },
        MeetingJobStatus::Complete => completed_claim_status(stage),
        MeetingJobStatus::Failed => MeetingClaimStatus::Failed,
        MeetingJobStatus::Cancelled => MeetingClaimStatus::Cancelled,
    }
}

fn claim_status_for_assessment(
    stage: MeetingAssessmentStage,
    status: MeetingAssessmentStatus,
) -> MeetingClaimStatus {
    match status {
        MeetingAssessmentStatus::Complete => completed_claim_status(stage),
        MeetingAssessmentStatus::Failed => MeetingClaimStatus::Failed,
    }
}

fn completed_claim_status(stage: MeetingAssessmentStage) -> MeetingClaimStatus {
    match stage {
        MeetingAssessmentStage::Preliminary => MeetingClaimStatus::Preliminary,
        MeetingAssessmentStage::Deep => MeetingClaimStatus::Complete,
    }
}

async fn update_claim_status_for_version(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    claim_version_id: &str,
    status: MeetingClaimStatus,
    now: i64,
) -> Result<(), MeetingStoreError> {
    let result = sqlx::query(
        r#"UPDATE claims SET status = ?, updated_at_ms = ?
           WHERE meeting_id = ? AND id = (
               SELECT claim_id FROM claim_versions WHERE id = ?
           )"#,
    )
    .bind(enum_string(&status)?)
    .bind(now)
    .bind(meeting_id)
    .bind(claim_version_id)
    .execute(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    if result.rows_affected() != 1 {
        return Err(MeetingStoreError::NotFound);
    }
    Ok(())
}

fn validate_refinement_job(value: &MeetingRefinementJobUpsertDto) -> Result<(), MeetingStoreError> {
    validation::uuid(&value.id)?;
    validation::uuid(&value.source_transcript_version_id)?;
    validation::nonempty(
        &value.input_manifest_checksum,
        512,
        "invalid refinement manifest checksum",
    )?;
    validation::nonempty(&value.provider, 128, "invalid refinement provider")?;
    validation::nonempty(&value.model, 256, "invalid refinement model")?;
    validation::optional(
        value.gateway_job_id.as_deref(),
        512,
        "invalid gateway job identifier",
    )?;
    validation::nonempty(
        &value.idempotency_key,
        512,
        "invalid refinement idempotency key",
    )?;
    validation::json_size(value.usage.as_ref())?;
    validation::typed_error(value.error.as_ref())?;
    if value.latency_ms.is_some_and(|latency| latency < 0) {
        return Err(MeetingStoreError::validation("invalid refinement latency"));
    }
    validate_optional_time(value.next_retry_at_ms)?;
    validate_optional_time(value.started_at_ms)?;
    validate_optional_time(value.completed_at_ms)
}

fn validate_optional_time(value: Option<i64>) -> Result<(), MeetingStoreError> {
    if value.is_some_and(|value| value < 0) {
        Err(MeetingStoreError::validation("invalid timestamp"))
    } else {
        Ok(())
    }
}

fn validate_assessment(value: &MeetingAssessmentApplyDto) -> Result<(), MeetingStoreError> {
    validation::uuid(&value.id)?;
    validation::uuid(&value.claim_version_id)?;
    if value.attempt_number == 0 {
        return Err(MeetingStoreError::validation("invalid assessment attempt"));
    }
    if let Some(id) = &value.supersedes_id {
        validation::uuid(id)?;
    }
    validation::timestamp_range(value.started_at_ms, Some(value.completed_at_ms))?;
    validation::conclusion_statements(&value.conclusion)?;
    validation::statements(&value.support)?;
    validation::statements(&value.contradiction)?;
    validation::statements(&value.caveats)?;
    validation::statements(&value.limitations)?;
    validation::nonempty(&value.model_provider, 128, "invalid assessment provider")?;
    validation::nonempty(&value.model, 256, "invalid assessment model")?;
    validation::optional(
        value.model_version.as_deref(),
        256,
        "invalid assessment model version",
    )?;
    validation::json_size(value.usage.as_ref())?;
    validation::typed_error(value.error.as_ref())?;
    if value.status != MeetingAssessmentStatus::Complete || value.error.is_some() {
        return Err(MeetingStoreError::validation(
            "operational failure cannot be stored as an assessment",
        ));
    }
    if value.latency_ms.is_some_and(|latency| latency < 0)
        || value.sources.len() > validation::MAX_SOURCES_PER_ASSESSMENT
    {
        return Err(MeetingStoreError::validation("invalid assessment metadata"));
    }
    let mut source_ids = HashSet::new();
    let mut citation_keys = HashSet::new();
    let mut canonical_urls = HashSet::new();
    for source in &value.sources {
        validation::uuid(&source.id)?;
        validation::nonempty(&source.citation_key, 128, "invalid citation key")?;
        validation::source_url(&source.url)?;
        validation::source_url(&source.canonical_url)?;
        validation::nonempty(&source.publisher, 512, "invalid source publisher")?;
        validation::nonempty(&source.title, 2_048, "invalid source title")?;
        validation::optional(
            source.publication_date.as_deref(),
            64,
            "invalid publication date",
        )?;
        validate_optional_time(Some(source.accessed_at_ms))?;
        validation::nonempty(
            &source.evidence_excerpt,
            validation::MAX_EXCERPT_BYTES,
            "invalid evidence excerpt",
        )?;
        validation::score(source.quality_score)?;
        validation::nonempty(
            &source.quality_rationale,
            4_096,
            "invalid source quality rationale",
        )?;
        if !source_ids.insert(source.id.as_str())
            || !citation_keys.insert(source.citation_key.as_str())
            || !canonical_urls.insert(source.canonical_url.as_str())
        {
            return Err(MeetingStoreError::validation("duplicate assessment source"));
        }
    }

    if value.sources.is_empty() {
        return Err(MeetingStoreError::validation(
            "an assessment requires retrieved evidence",
        ));
    }
    if value.conclusion.is_empty() {
        return Err(MeetingStoreError::validation(
            "assessment conclusion is missing",
        ));
    }
    let has_uncited_conclusion = value
        .conclusion
        .iter()
        .any(|statement| statement.citation_keys.is_empty());
    if has_uncited_conclusion
        && !(value.verdict == MeetingVerdict::Unverifiable
            && value.confidence == MeetingConfidence::Low
            && value.support.is_empty()
            && value.contradiction.is_empty()
            && value.caveats.is_empty()
            && !value.limitations.is_empty())
    {
        return Err(MeetingStoreError::validation(
            "uncited conclusion is only valid for an evidence-bounded unverified finding",
        ));
    }

    for statement in value
        .conclusion
        .iter()
        .chain(&value.support)
        .chain(&value.contradiction)
        .chain(&value.caveats)
        .chain(&value.limitations)
    {
        if statement
            .citation_keys
            .iter()
            .any(|key| !citation_keys.contains(key.as_str()))
        {
            return Err(MeetingStoreError::validation(
                "assessment citation is missing a source",
            ));
        }
    }
    Ok(())
}

async fn ensure_claim_version(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    claim_version_id: &str,
) -> Result<(), MeetingStoreError> {
    let exists = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(SELECT 1 FROM claim_versions cv
           JOIN claims c ON c.id = cv.claim_id
           WHERE cv.id = ? AND c.meeting_id = ?)"#,
    )
    .bind(claim_version_id)
    .bind(meeting_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    if exists {
        Ok(())
    } else {
        Err(MeetingStoreError::NotFound)
    }
}

async fn upsert_research_job(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    value: &MeetingResearchJobUpsertDto,
) -> Result<(), MeetingStoreError> {
    ensure_claim_version(tx, meeting_id, &value.claim_version_id).await?;
    if let Some(row) = sqlx::query(
        "SELECT claim_version_id, stage, idempotency_key FROM research_jobs WHERE id = ?",
    )
    .bind(&value.id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?
    {
        if row
            .try_get::<String, _>("claim_version_id")
            .map_err(MeetingStoreError::database)?
            != value.claim_version_id
            || row
                .try_get::<String, _>("stage")
                .map_err(MeetingStoreError::database)?
                != enum_string(&value.stage)?
            || row
                .try_get::<String, _>("idempotency_key")
                .map_err(MeetingStoreError::database)?
                != value.idempotency_key
        {
            return Err(MeetingStoreError::Conflict);
        }
    }
    let now = now_ms();
    sqlx::query(
        r#"INSERT INTO research_jobs (
            id, claim_version_id, stage, gateway_job_id, idempotency_key, status,
            attempt_count, next_retry_at_ms, started_at_ms, completed_at_ms,
            error_code, error_message, error_retryable, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET gateway_job_id = excluded.gateway_job_id,
            status = excluded.status, attempt_count = excluded.attempt_count,
            next_retry_at_ms = excluded.next_retry_at_ms,
            started_at_ms = COALESCE(excluded.started_at_ms, research_jobs.started_at_ms),
            completed_at_ms = excluded.completed_at_ms, error_code = excluded.error_code,
            error_message = excluded.error_message, error_retryable = excluded.error_retryable,
            updated_at_ms = excluded.updated_at_ms"#,
    )
    .bind(&value.id)
    .bind(&value.claim_version_id)
    .bind(enum_string(&value.stage)?)
    .bind(value.gateway_job_id.as_deref())
    .bind(&value.idempotency_key)
    .bind(enum_string(&value.status)?)
    .bind(i64::from(value.attempt_count))
    .bind(value.next_retry_at_ms)
    .bind(value.started_at_ms)
    .bind(value.completed_at_ms)
    .bind(value.error.as_ref().map(|error| error.code.as_str()))
    .bind(value.error.as_ref().map(|error| error.message.as_str()))
    .bind(value.error.as_ref().is_some_and(|error| error.retryable))
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(map_constraint_conflict)?;
    Ok(())
}

async fn insert_assessment(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    value: &MeetingAssessmentApplyDto,
) -> Result<(), MeetingStoreError> {
    ensure_claim_version(tx, meeting_id, &value.claim_version_id).await?;
    if let Some(row) =
        sqlx::query("SELECT claim_version_id, stage, attempt_number FROM assessments WHERE id = ?")
            .bind(&value.id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(MeetingStoreError::database)?
    {
        let same = row
            .try_get::<String, _>("claim_version_id")
            .map_err(MeetingStoreError::database)?
            == value.claim_version_id
            && row
                .try_get::<String, _>("stage")
                .map_err(MeetingStoreError::database)?
                == enum_string(&value.stage)?
            && row
                .try_get::<i64, _>("attempt_number")
                .map_err(MeetingStoreError::database)?
                == i64::from(value.attempt_number);
        return if same {
            Ok(())
        } else {
            Err(MeetingStoreError::Conflict)
        };
    }
    if let Some(supersedes_id) = &value.supersedes_id {
        let valid = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM assessments WHERE id = ? AND claim_version_id = ? AND stage = ?)",
        )
        .bind(supersedes_id)
        .bind(&value.claim_version_id)
        .bind(enum_string(&value.stage)?)
        .fetch_one(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
        if !valid {
            return Err(MeetingStoreError::Conflict);
        }
    }
    if value.set_current {
        sqlx::query(
            "UPDATE assessments SET is_current = 0 WHERE claim_version_id = ? AND stage = ?",
        )
        .bind(&value.claim_version_id)
        .bind(enum_string(&value.stage)?)
        .execute(&mut **tx)
        .await
        .map_err(MeetingStoreError::database)?;
    }
    sqlx::query(
        r#"INSERT INTO assessments (
            id, claim_version_id, stage, attempt_number, status, is_current, supersedes_id,
            verdict, confidence, conclusion_json, support_json, contradiction_json,
            caveats_json, limitations_json, model_provider, model, model_version,
            usage_json, latency_ms, started_at_ms, completed_at_ms, error_code,
            error_message, error_retryable, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&value.id)
    .bind(&value.claim_version_id)
    .bind(enum_string(&value.stage)?)
    .bind(i64::from(value.attempt_number))
    .bind(enum_string(&value.status)?)
    .bind(value.set_current)
    .bind(value.supersedes_id.as_deref())
    .bind(enum_string(&value.verdict)?)
    .bind(enum_string(&value.confidence)?)
    .bind(json_string(&value.conclusion)?)
    .bind(json_string(&value.support)?)
    .bind(json_string(&value.contradiction)?)
    .bind(json_string(&value.caveats)?)
    .bind(json_string(&value.limitations)?)
    .bind(&value.model_provider)
    .bind(&value.model)
    .bind(value.model_version.as_deref())
    .bind(value.usage.as_ref().map(json_string).transpose()?)
    .bind(value.latency_ms)
    .bind(value.started_at_ms)
    .bind(value.completed_at_ms)
    .bind(value.error.as_ref().map(|error| error.code.as_str()))
    .bind(value.error.as_ref().map(|error| error.message.as_str()))
    .bind(value.error.as_ref().is_some_and(|error| error.retryable))
    .bind(now_ms())
    .execute(&mut **tx)
    .await
    .map_err(map_constraint_conflict)?;
    for source in &value.sources {
        sqlx::query(
            r#"INSERT INTO sources (
                id, assessment_id, citation_key, url, canonical_url, publisher, title,
                publication_date, accessed_at_ms, evidence_excerpt, stance,
                quality_score, quality_rationale
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&source.id)
        .bind(&value.id)
        .bind(&source.citation_key)
        .bind(&source.url)
        .bind(&source.canonical_url)
        .bind(&source.publisher)
        .bind(&source.title)
        .bind(source.publication_date.as_deref())
        .bind(source.accessed_at_ms)
        .bind(&source.evidence_excerpt)
        .bind(enum_string(&source.stance)?)
        .bind(source.quality_score)
        .bind(&source.quality_rationale)
        .execute(&mut **tx)
        .await
        .map_err(map_constraint_conflict)?;
    }
    Ok(())
}

async fn upsert_refinement_job(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    meeting_id: &str,
    value: &MeetingRefinementJobUpsertDto,
) -> Result<(), MeetingStoreError> {
    let source_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM transcript_versions WHERE id = ? AND meeting_id = ?)",
    )
    .bind(&value.source_transcript_version_id)
    .bind(meeting_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?;
    if !source_exists {
        return Err(MeetingStoreError::NotFound);
    }
    if let Some(row) = sqlx::query(
        "SELECT meeting_id, source_transcript_version_id, input_manifest_checksum, provider, model, idempotency_key FROM transcript_refinement_jobs WHERE id = ?",
    )
    .bind(&value.id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(MeetingStoreError::database)?
    {
        let identity_matches = row
            .try_get::<String, _>("meeting_id")
            .map_err(MeetingStoreError::database)?
            == meeting_id
            && row
                .try_get::<String, _>("source_transcript_version_id")
                .map_err(MeetingStoreError::database)?
                == value.source_transcript_version_id
            && row
                .try_get::<String, _>("input_manifest_checksum")
                .map_err(MeetingStoreError::database)?
                == value.input_manifest_checksum
            && row
                .try_get::<String, _>("provider")
                .map_err(MeetingStoreError::database)?
                == value.provider
            && row
                .try_get::<String, _>("model")
                .map_err(MeetingStoreError::database)?
                == value.model
            && row
                .try_get::<String, _>("idempotency_key")
                .map_err(MeetingStoreError::database)?
                == value.idempotency_key;
        if !identity_matches {
            return Err(MeetingStoreError::Conflict);
        }
    }
    let now = now_ms();
    sqlx::query(
        r#"INSERT INTO transcript_refinement_jobs (
            id, meeting_id, source_transcript_version_id, input_manifest_checksum,
            provider, model, gateway_job_id, idempotency_key, status, attempt_count,
            next_retry_at_ms, usage_json, latency_ms, started_at_ms, completed_at_ms,
            error_code, error_message, error_retryable, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET gateway_job_id = excluded.gateway_job_id,
            status = excluded.status, attempt_count = excluded.attempt_count,
            next_retry_at_ms = excluded.next_retry_at_ms, usage_json = excluded.usage_json,
            latency_ms = excluded.latency_ms,
            started_at_ms = COALESCE(excluded.started_at_ms, transcript_refinement_jobs.started_at_ms),
            completed_at_ms = excluded.completed_at_ms, error_code = excluded.error_code,
            error_message = excluded.error_message, error_retryable = excluded.error_retryable,
            updated_at_ms = excluded.updated_at_ms"#,
    )
    .bind(&value.id)
    .bind(meeting_id)
    .bind(&value.source_transcript_version_id)
    .bind(&value.input_manifest_checksum)
    .bind(&value.provider)
    .bind(&value.model)
    .bind(value.gateway_job_id.as_deref())
    .bind(&value.idempotency_key)
    .bind(enum_string(&value.status)?)
    .bind(i64::from(value.attempt_count))
    .bind(value.next_retry_at_ms)
    .bind(value.usage.as_ref().map(json_string).transpose()?)
    .bind(value.latency_ms)
    .bind(value.started_at_ms)
    .bind(value.completed_at_ms)
    .bind(value.error.as_ref().map(|error| error.code.as_str()))
    .bind(value.error.as_ref().map(|error| error.message.as_str()))
    .bind(value.error.as_ref().is_some_and(|error| error.retryable))
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await
    .map_err(map_constraint_conflict)?;
    Ok(())
}

fn refinement_status_for_job(status: MeetingRefinementJobStatus) -> MeetingRefinementStatus {
    match status {
        MeetingRefinementJobStatus::Queued => MeetingRefinementStatus::Queued,
        MeetingRefinementJobStatus::Uploading => MeetingRefinementStatus::Uploading,
        MeetingRefinementJobStatus::Processing => MeetingRefinementStatus::Processing,
        MeetingRefinementJobStatus::Reconciling => MeetingRefinementStatus::Reconciling,
        MeetingRefinementJobStatus::Complete => MeetingRefinementStatus::Complete,
        MeetingRefinementJobStatus::RetryWait => MeetingRefinementStatus::RetryWait,
        MeetingRefinementJobStatus::Failed => MeetingRefinementStatus::Failed,
        MeetingRefinementJobStatus::Cancelled => MeetingRefinementStatus::Cancelled,
    }
}

fn cleanup_terminal(status: MeetingCleanupStatus) -> bool {
    matches!(
        status,
        MeetingCleanupStatus::Complete | MeetingCleanupStatus::Unavailable
    )
}

fn string_column(rows: &[SqliteRow], column: &str) -> Result<Vec<String>, MeetingStoreError> {
    rows.iter()
        .map(|row| row.try_get(column).map_err(MeetingStoreError::database))
        .collect()
}

fn speaker_observation_from_row(
    row: &SqliteRow,
) -> Result<MeetingSpeakerObservationDto, MeetingStoreError> {
    Ok(MeetingSpeakerObservationDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        meeting_id: row
            .try_get("meeting_id")
            .map_err(MeetingStoreError::database)?,
        transcript_version_id: row
            .try_get("transcript_version_id")
            .map_err(MeetingStoreError::database)?,
        speaker_id: row
            .try_get("speaker_id")
            .map_err(MeetingStoreError::database)?,
        provider: row
            .try_get("provider")
            .map_err(MeetingStoreError::database)?,
        provider_namespace: row
            .try_get("provider_namespace")
            .map_err(MeetingStoreError::database)?,
        provider_speaker_label: row
            .try_get("provider_speaker_label")
            .map_err(MeetingStoreError::database)?,
        confidence: row
            .try_get("confidence")
            .map_err(MeetingStoreError::database)?,
        ambiguous: row
            .try_get("ambiguous")
            .map_err(MeetingStoreError::database)?,
        revision_number: row
            .try_get::<i64, _>("revision_number")
            .map_err(MeetingStoreError::database)?
            .max(0) as u64,
        source_hint: row
            .try_get::<Option<String>, _>("source_hint")
            .map_err(MeetingStoreError::database)?
            .map(|value| enum_from_str(&value))
            .transpose()?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

fn transcript_segment_from_row(
    row: &SqliteRow,
    replaced_live_segment_ids: Vec<String>,
) -> Result<MeetingTranscriptSegmentDto, MeetingStoreError> {
    Ok(MeetingTranscriptSegmentDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        meeting_id: row
            .try_get("meeting_id")
            .map_err(MeetingStoreError::database)?,
        transcript_version_id: row
            .try_get("transcript_version_id")
            .map_err(MeetingStoreError::database)?,
        provider: row
            .try_get("provider")
            .map_err(MeetingStoreError::database)?,
        provider_namespace: row
            .try_get("provider_namespace")
            .map_err(MeetingStoreError::database)?,
        provider_session_id: row
            .try_get("provider_session_id")
            .map_err(MeetingStoreError::database)?,
        provider_turn_id: row
            .try_get("provider_turn_id")
            .map_err(MeetingStoreError::database)?,
        provider_turn_order: row
            .try_get("provider_turn_order")
            .map_err(MeetingStoreError::database)?,
        revision_number: row
            .try_get::<i64, _>("revision_number")
            .map_err(MeetingStoreError::database)?
            .max(0) as u64,
        state: enum_from_str(
            &row.try_get::<String, _>("state")
                .map_err(MeetingStoreError::database)?,
        )?,
        speaker_id: row
            .try_get("speaker_id")
            .map_err(MeetingStoreError::database)?,
        source_kind: enum_from_str(
            &row.try_get::<String, _>("source_kind")
                .map_err(MeetingStoreError::database)?,
        )?,
        start_ms: row
            .try_get("start_ms")
            .map_err(MeetingStoreError::database)?,
        end_ms: row.try_get("end_ms").map_err(MeetingStoreError::database)?,
        text: row
            .try_get("finalized_text")
            .map_err(MeetingStoreError::database)?,
        words: json_from_str(
            &row.try_get::<String, _>("words_json")
                .map_err(MeetingStoreError::database)?,
        )?,
        replaced_live_segment_ids,
        content_hash: row
            .try_get("content_hash")
            .map_err(MeetingStoreError::database)?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

fn source_from_row(row: &SqliteRow) -> Result<MeetingSourceDto, MeetingStoreError> {
    Ok(MeetingSourceDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        assessment_id: row
            .try_get("assessment_id")
            .map_err(MeetingStoreError::database)?,
        citation_key: row
            .try_get("citation_key")
            .map_err(MeetingStoreError::database)?,
        url: row.try_get("url").map_err(MeetingStoreError::database)?,
        canonical_url: row
            .try_get("canonical_url")
            .map_err(MeetingStoreError::database)?,
        publisher: row
            .try_get("publisher")
            .map_err(MeetingStoreError::database)?,
        title: row.try_get("title").map_err(MeetingStoreError::database)?,
        publication_date: row
            .try_get("publication_date")
            .map_err(MeetingStoreError::database)?,
        accessed_at_ms: row
            .try_get("accessed_at_ms")
            .map_err(MeetingStoreError::database)?,
        evidence_excerpt: row
            .try_get("evidence_excerpt")
            .map_err(MeetingStoreError::database)?,
        stance: enum_from_str(
            &row.try_get::<String, _>("stance")
                .map_err(MeetingStoreError::database)?,
        )?,
        quality_score: row
            .try_get("quality_score")
            .map_err(MeetingStoreError::database)?,
        quality_rationale: row
            .try_get("quality_rationale")
            .map_err(MeetingStoreError::database)?,
    })
}

fn assessment_from_row(
    row: &SqliteRow,
    sources: Vec<MeetingSourceDto>,
) -> Result<MeetingAssessmentDto, MeetingStoreError> {
    Ok(MeetingAssessmentDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        claim_version_id: row
            .try_get("claim_version_id")
            .map_err(MeetingStoreError::database)?,
        stage: enum_from_str(
            &row.try_get::<String, _>("stage")
                .map_err(MeetingStoreError::database)?,
        )?,
        attempt_number: row
            .try_get::<i64, _>("attempt_number")
            .map_err(MeetingStoreError::database)?
            .max(0) as u32,
        status: enum_from_str(
            &row.try_get::<String, _>("status")
                .map_err(MeetingStoreError::database)?,
        )?,
        current: row
            .try_get("is_current")
            .map_err(MeetingStoreError::database)?,
        supersedes_id: row
            .try_get("supersedes_id")
            .map_err(MeetingStoreError::database)?,
        verdict: enum_from_str(
            &row.try_get::<String, _>("verdict")
                .map_err(MeetingStoreError::database)?,
        )?,
        confidence: enum_from_str(
            &row.try_get::<String, _>("confidence")
                .map_err(MeetingStoreError::database)?,
        )?,
        conclusion: json_from_str(
            &row.try_get::<String, _>("conclusion_json")
                .map_err(MeetingStoreError::database)?,
        )?,
        support: json_from_str(
            &row.try_get::<String, _>("support_json")
                .map_err(MeetingStoreError::database)?,
        )?,
        contradiction: json_from_str(
            &row.try_get::<String, _>("contradiction_json")
                .map_err(MeetingStoreError::database)?,
        )?,
        caveats: json_from_str(
            &row.try_get::<String, _>("caveats_json")
                .map_err(MeetingStoreError::database)?,
        )?,
        limitations: json_from_str(
            &row.try_get::<String, _>("limitations_json")
                .map_err(MeetingStoreError::database)?,
        )?,
        model_provider: row
            .try_get("model_provider")
            .map_err(MeetingStoreError::database)?,
        model: row.try_get("model").map_err(MeetingStoreError::database)?,
        model_version: row
            .try_get("model_version")
            .map_err(MeetingStoreError::database)?,
        usage: row
            .try_get::<Option<String>, _>("usage_json")
            .map_err(MeetingStoreError::database)?
            .map(|value| json_from_str(&value))
            .transpose()?,
        latency_ms: row
            .try_get("latency_ms")
            .map_err(MeetingStoreError::database)?,
        started_at_ms: row
            .try_get("started_at_ms")
            .map_err(MeetingStoreError::database)?,
        completed_at_ms: row
            .try_get("completed_at_ms")
            .map_err(MeetingStoreError::database)?,
        error: typed_error_from_row(row)?,
        sources,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

fn research_job_from_row(row: &SqliteRow) -> Result<MeetingResearchJobDto, MeetingStoreError> {
    Ok(MeetingResearchJobDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        claim_version_id: row
            .try_get("claim_version_id")
            .map_err(MeetingStoreError::database)?,
        stage: enum_from_str(
            &row.try_get::<String, _>("stage")
                .map_err(MeetingStoreError::database)?,
        )?,
        gateway_job_id: row
            .try_get("gateway_job_id")
            .map_err(MeetingStoreError::database)?,
        idempotency_key: row
            .try_get("idempotency_key")
            .map_err(MeetingStoreError::database)?,
        status: enum_from_str(
            &row.try_get::<String, _>("status")
                .map_err(MeetingStoreError::database)?,
        )?,
        attempt_count: row
            .try_get::<i64, _>("attempt_count")
            .map_err(MeetingStoreError::database)?
            .max(0) as u32,
        next_retry_at_ms: row
            .try_get("next_retry_at_ms")
            .map_err(MeetingStoreError::database)?,
        started_at_ms: row
            .try_get("started_at_ms")
            .map_err(MeetingStoreError::database)?,
        completed_at_ms: row
            .try_get("completed_at_ms")
            .map_err(MeetingStoreError::database)?,
        error: typed_error_from_row(row)?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

fn refinement_job_from_row(row: &SqliteRow) -> Result<MeetingRefinementJobDto, MeetingStoreError> {
    Ok(MeetingRefinementJobDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        meeting_id: row
            .try_get("meeting_id")
            .map_err(MeetingStoreError::database)?,
        source_transcript_version_id: row
            .try_get("source_transcript_version_id")
            .map_err(MeetingStoreError::database)?,
        input_manifest_checksum: row
            .try_get("input_manifest_checksum")
            .map_err(MeetingStoreError::database)?,
        provider: row
            .try_get("provider")
            .map_err(MeetingStoreError::database)?,
        model: row.try_get("model").map_err(MeetingStoreError::database)?,
        gateway_job_id: row
            .try_get("gateway_job_id")
            .map_err(MeetingStoreError::database)?,
        idempotency_key: row
            .try_get("idempotency_key")
            .map_err(MeetingStoreError::database)?,
        status: enum_from_str(
            &row.try_get::<String, _>("status")
                .map_err(MeetingStoreError::database)?,
        )?,
        attempt_count: row
            .try_get::<i64, _>("attempt_count")
            .map_err(MeetingStoreError::database)?
            .max(0) as u32,
        next_retry_at_ms: row
            .try_get("next_retry_at_ms")
            .map_err(MeetingStoreError::database)?,
        usage: row
            .try_get::<Option<String>, _>("usage_json")
            .map_err(MeetingStoreError::database)?
            .map(|value| json_from_str(&value))
            .transpose()?,
        latency_ms: row
            .try_get("latency_ms")
            .map_err(MeetingStoreError::database)?,
        started_at_ms: row
            .try_get("started_at_ms")
            .map_err(MeetingStoreError::database)?,
        completed_at_ms: row
            .try_get("completed_at_ms")
            .map_err(MeetingStoreError::database)?,
        error: typed_error_from_row(row)?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}

fn cleanup_job_from_row(
    row: &SqliteRow,
    relative_audio_paths: Vec<String>,
) -> Result<MeetingCleanupJobDto, MeetingStoreError> {
    Ok(MeetingCleanupJobDto {
        id: row.try_get("id").map_err(MeetingStoreError::database)?,
        meeting_id: row
            .try_get("meeting_id")
            .map_err(MeetingStoreError::database)?,
        local_status: enum_from_str(
            &row.try_get::<String, _>("local_status")
                .map_err(MeetingStoreError::database)?,
        )?,
        gateway_status: enum_from_str(
            &row.try_get::<String, _>("gateway_status")
                .map_err(MeetingStoreError::database)?,
        )?,
        provider_status: enum_from_str(
            &row.try_get::<String, _>("provider_status")
                .map_err(MeetingStoreError::database)?,
        )?,
        relative_audio_paths,
        attempt_count: row
            .try_get::<i64, _>("attempt_count")
            .map_err(MeetingStoreError::database)?
            .max(0) as u32,
        next_retry_at_ms: row
            .try_get("next_retry_at_ms")
            .map_err(MeetingStoreError::database)?,
        last_error: typed_error_from_row(row)?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(MeetingStoreError::database)?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(MeetingStoreError::database)?,
    })
}
