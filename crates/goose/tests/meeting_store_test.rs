#![recursion_limit = "256"]

use goose::custom_requests::*;
use goose::meetings::{MeetingStore, MeetingStoreError};
use sqlx::{Connection, Row, SqliteConnection};
use uuid::Uuid;

fn id() -> String {
    Uuid::now_v7().to_string()
}

fn create_request() -> MeetingCreateRequest {
    MeetingCreateRequest {
        title: Some("Editorial review".to_string()),
        artifact_type: MeetingArtifactType::Meeting,
        mode: MeetingMode::Call,
        started_at_ms: 1_000,
        capture_config: MeetingCaptureConfigDto {
            live_strategy: MeetingLiveStrategy::MixedDiarized,
            microphone_device_id: None,
            system_audio_enabled: true,
            exact_speaker_count: Some(2),
        },
        initial_speakers: vec![],
    }
}

async fn store() -> (tempfile::TempDir, MeetingStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = MeetingStore::new(directory.path().to_path_buf()).unwrap();
    store.initialize().await.unwrap();
    (directory, store)
}

async fn create(store: &MeetingStore) -> MeetingCreateResponse {
    store.create_meeting(create_request()).await.unwrap()
}

async fn artifact(store: &MeetingStore, meeting_id: &str) -> MeetingArtifactDto {
    store
        .get_artifact(MeetingGetRequest {
            meeting_id: meeting_id.to_string(),
        })
        .await
        .unwrap()
        .artifact
}

fn version(
    version_id: &str,
    kind: MeetingTranscriptVersionKind,
    status: MeetingTranscriptVersionStatus,
    revision_number: u64,
) -> MeetingTranscriptVersionUpsertDto {
    MeetingTranscriptVersionUpsertDto {
        id: version_id.to_string(),
        kind,
        status,
        revision_number,
        provider: Some("test-transcriber".to_string()),
        model: Some("deterministic-fixture".to_string()),
        ..Default::default()
    }
}

fn segment(
    version_id: &str,
    segment_id: &str,
    namespace: &str,
    turn_id: &str,
    turn_order: i64,
    time_range_ms: (i64, i64),
    text: &str,
) -> MeetingTranscriptSegmentUpsertDto {
    MeetingTranscriptSegmentUpsertDto {
        id: segment_id.to_string(),
        transcript_version_id: version_id.to_string(),
        provider: "test-transcriber".to_string(),
        provider_namespace: namespace.to_string(),
        provider_session_id: Some(namespace.to_string()),
        provider_turn_id: turn_id.to_string(),
        provider_turn_order: turn_order,
        revision_number: 1,
        state: MeetingTranscriptSegmentState::Final,
        speaker_id: None,
        source_kind: MeetingAudioSourceKind::Mixed,
        start_ms: time_range_ms.0,
        end_ms: time_range_ms.1,
        text: text.to_string(),
        words: vec![],
        replaced_live_segment_ids: vec![],
    }
}

fn claim_gate_turn(segment: &MeetingTranscriptSegmentUpsertDto) -> MeetingClaimGateTurnDto {
    MeetingClaimGateTurnDto {
        id: segment.id.clone(),
        speaker_id: segment.speaker_id.clone(),
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        text: segment.text.clone(),
        revision_number: segment.revision_number,
        source_kind: segment.source_kind,
    }
}

fn refinement_job(
    created: &MeetingCreateResponse,
    job_id: &str,
    status: MeetingRefinementJobStatus,
    attempt_count: u32,
) -> MeetingRefinementJobUpsertDto {
    MeetingRefinementJobUpsertDto {
        id: job_id.to_string(),
        source_transcript_version_id: created.live_transcript_version.id.clone(),
        input_manifest_checksum: "manifest-v1".to_string(),
        provider: "test-gateway".to_string(),
        model: "deterministic-refinement".to_string(),
        gateway_job_id: Some("opaque-refinement-job".to_string()),
        idempotency_key: format!("refine-{}", created.meeting.id),
        status,
        attempt_count,
        next_retry_at_ms: None,
        usage: Some(serde_json::json!({"audioSeconds": 2})),
        latency_ms: None,
        started_at_ms: Some(2_000),
        completed_at_ms: None,
        error: None,
    }
}

fn research_job(
    claim_version_id: &str,
    job_id: &str,
    idempotency_key: &str,
    status: MeetingJobStatus,
    attempt_count: u32,
) -> MeetingResearchJobUpsertDto {
    MeetingResearchJobUpsertDto {
        id: job_id.to_string(),
        claim_version_id: claim_version_id.to_string(),
        stage: MeetingAssessmentStage::Preliminary,
        gateway_job_id: Some("opaque-research-job".to_string()),
        idempotency_key: idempotency_key.to_string(),
        status,
        attempt_count,
        next_retry_at_ms: None,
        started_at_ms: Some(2_000),
        completed_at_ms: None,
        error: None,
    }
}

fn transcript_request(
    created: &MeetingCreateResponse,
    segment_id: &str,
    revision_number: u64,
    text: &str,
) -> MeetingTranscriptApplyRequest {
    MeetingTranscriptApplyRequest {
        meeting_id: created.meeting.id.clone(),
        version: MeetingTranscriptVersionUpsertDto {
            id: created.live_transcript_version.id.clone(),
            kind: MeetingTranscriptVersionKind::Live,
            status: MeetingTranscriptVersionStatus::Complete,
            revision_number: 1,
            provider: Some("assemblyai".to_string()),
            completed_at_ms: Some(2_000),
            ..Default::default()
        },
        segments: vec![MeetingTranscriptSegmentUpsertDto {
            id: segment_id.to_string(),
            transcript_version_id: created.live_transcript_version.id.clone(),
            provider: "assemblyai".to_string(),
            provider_namespace: "live-primary".to_string(),
            provider_session_id: Some("session-a".to_string()),
            provider_turn_id: "turn-1".to_string(),
            provider_turn_order: 1,
            revision_number,
            state: MeetingTranscriptSegmentState::Final,
            speaker_id: None,
            source_kind: MeetingAudioSourceKind::Mixed,
            start_ms: 1_000,
            end_ms: 1_500,
            text: text.to_string(),
            words: vec![],
            replaced_live_segment_ids: vec![],
        }],
        speaker_observations: vec![],
        promote_canonical: true,
    }
}

#[tokio::test]
async fn initializes_versioned_wal_database_and_revises_transcript_idempotently() {
    let (_directory, store) = store().await;
    let mut connection =
        SqliteConnection::connect(&format!("sqlite://{}", store.database_path().display()))
            .await
            .unwrap();
    let journal_mode: String = sqlx::query("PRAGMA journal_mode")
        .fetch_one(&mut connection)
        .await
        .unwrap()
        .get(0);
    let schema_version: i64 = sqlx::query("SELECT MAX(version) FROM meeting_schema_version")
        .fetch_one(&mut connection)
        .await
        .unwrap()
        .get(0);
    let schema_table_count: i64 = sqlx::query(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('meeting_schema_version','meetings','speakers','transcript_versions','speaker_observations','transcript_segments','transcript_segment_replacements','audio_assets','timeline_events','claims','claim_versions','claim_version_segments','assessments','sources','research_jobs','transcript_refinement_jobs','refinement_inputs','cleanup_jobs','cleanup_job_assets','claim_gate_segments','claim_gate_batches','claim_gate_batch_segments','manual_fact_check_requests','manual_fact_check_request_context_turns','manual_fact_check_request_segments')",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap()
    .get(0);
    let explicit_index_count: i64 = sqlx::query(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_claims_duplicate_key','idx_assessments_current','idx_meetings_history','idx_meetings_status','idx_segments_timeline','idx_segments_speaker','idx_timeline_events','idx_claims_timeline','idx_research_jobs_recovery','idx_refinement_jobs_recovery','idx_cleanup_jobs_recovery','idx_claim_gate_segments_pending','idx_claim_gate_batches_pending','idx_claim_gate_batch_segment_revision','idx_manual_fact_check_requests_status','idx_claims_manual_request')",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap()
    .get(0);
    assert_eq!(journal_mode, "wal");
    assert_eq!(schema_version, 3);
    assert_eq!(schema_table_count, 25);
    assert_eq!(explicit_index_count, 16);
    store.initialize().await.unwrap();
    let migration_rows: i64 = sqlx::query("SELECT COUNT(*) FROM meeting_schema_version")
        .fetch_one(&mut connection)
        .await
        .unwrap()
        .get(0);
    assert_eq!(migration_rows, 3);

    let created = create(&store).await;
    let segment_id = id();
    let inserted = store
        .apply_transcript(transcript_request(
            &created,
            &segment_id,
            1,
            "Initial wording",
        ))
        .await
        .unwrap();
    assert_eq!(
        inserted.segment_outcomes[0].outcome,
        MeetingUpsertOutcomeKind::Inserted
    );
    let duplicate = store
        .apply_transcript(transcript_request(
            &created,
            &segment_id,
            1,
            "Initial wording",
        ))
        .await
        .unwrap();
    assert_eq!(
        duplicate.segment_outcomes[0].outcome,
        MeetingUpsertOutcomeKind::Duplicate
    );
    let revised = store
        .apply_transcript(transcript_request(
            &created,
            &segment_id,
            2,
            "Final wording",
        ))
        .await
        .unwrap();
    assert_eq!(
        revised.segment_outcomes[0].outcome,
        MeetingUpsertOutcomeKind::Revised
    );
    let stale = store
        .apply_transcript(transcript_request(&created, &segment_id, 1, "Old wording"))
        .await
        .unwrap();
    assert_eq!(
        stale.segment_outcomes[0].outcome,
        MeetingUpsertOutcomeKind::StaleIgnored
    );

    let artifact = store
        .get_artifact(MeetingGetRequest {
            meeting_id: created.meeting.id.clone(),
        })
        .await
        .unwrap()
        .artifact;
    assert_eq!(
        artifact.meeting.canonical_transcript_version_id,
        Some(created.live_transcript_version.id)
    );
    assert_eq!(artifact.transcript_segments[0].text, "Final wording");
}

#[tokio::test]
async fn zero_based_segment_and_speaker_observation_revisions_persist_idempotently() {
    let (_directory, store) = store().await;
    let created = create(&store).await;
    let segment_id = id();
    let observation_id = id();
    let mut zero_revision_segment = segment(
        &created.live_transcript_version.id,
        &segment_id,
        "live/session-zero",
        "turn-zero",
        0,
        (1_000, 1_250),
        "The first provider revision is zero-based.",
    );
    zero_revision_segment.revision_number = 0;
    let zero_revision_observation = MeetingSpeakerObservationUpsertDto {
        id: observation_id.clone(),
        transcript_version_id: created.live_transcript_version.id.clone(),
        speaker_id: None,
        provider: "test-transcriber".to_string(),
        provider_namespace: "live/session-zero".to_string(),
        provider_speaker_label: "A".to_string(),
        confidence: Some(0.75),
        ambiguous: true,
        revision_number: 0,
        source_hint: Some(MeetingAudioSourceKind::Mixed),
    };
    let request = MeetingTranscriptApplyRequest {
        meeting_id: created.meeting.id.clone(),
        version: version(
            &created.live_transcript_version.id,
            MeetingTranscriptVersionKind::Live,
            MeetingTranscriptVersionStatus::Complete,
            1,
        ),
        segments: vec![zero_revision_segment],
        speaker_observations: vec![zero_revision_observation],
        promote_canonical: true,
    };
    let inserted = store.apply_transcript(request.clone()).await.unwrap();
    assert_eq!(
        inserted.segment_outcomes[0].outcome,
        MeetingUpsertOutcomeKind::Inserted
    );
    assert_eq!(inserted.version.revision_number, 1);
    let duplicate = store.apply_transcript(request).await.unwrap();
    assert_eq!(
        duplicate.segment_outcomes[0].outcome,
        MeetingUpsertOutcomeKind::Duplicate
    );
    let version_zero_error = store
        .apply_transcript(MeetingTranscriptApplyRequest {
            meeting_id: created.meeting.id.clone(),
            version: version(
                &created.live_transcript_version.id,
                MeetingTranscriptVersionKind::Live,
                MeetingTranscriptVersionStatus::Complete,
                0,
            ),
            segments: vec![],
            speaker_observations: vec![],
            promote_canonical: true,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        version_zero_error,
        MeetingStoreError::Validation(_)
    ));

    let artifact = artifact(&store, &created.meeting.id).await;
    assert_eq!(artifact.transcript_segments.len(), 1);
    assert_eq!(artifact.transcript_segments[0].id, segment_id);
    assert_eq!(artifact.transcript_segments[0].revision_number, 0);
    assert_eq!(artifact.speaker_observations.len(), 1);
    assert_eq!(artifact.speaker_observations[0].id, observation_id);
    assert_eq!(artifact.speaker_observations[0].revision_number, 0);
}

#[tokio::test]
async fn durable_claim_gate_batches_survive_restart_ack_zero_candidates_and_requeue_revisions() {
    let (directory, store) = store().await;
    let created = create(&store).await;
    let earlier_segment_id = id();
    let later_segment_id = id();
    let mut earlier_segment = segment(
        &created.live_transcript_version.id,
        &earlier_segment_id,
        "live/session-gate",
        "turn-earlier",
        1,
        (1_000, 1_300),
        "The earlier finalized turn.",
    );
    earlier_segment.revision_number = 0;
    let mut later_segment = segment(
        &created.live_transcript_version.id,
        &later_segment_id,
        "live/session-gate",
        "turn-later",
        2,
        (1_400, 1_700),
        "The later finalized turn.",
    );
    later_segment.revision_number = 0;
    let live_request = MeetingTranscriptApplyRequest {
        meeting_id: created.meeting.id.clone(),
        version: version(
            &created.live_transcript_version.id,
            MeetingTranscriptVersionKind::Live,
            MeetingTranscriptVersionStatus::Complete,
            1,
        ),
        segments: vec![later_segment.clone(), earlier_segment.clone()],
        speaker_observations: vec![],
        promote_canonical: true,
    };
    store.apply_transcript(live_request.clone()).await.unwrap();
    let queued = artifact(&store, &created.meeting.id).await;
    assert_eq!(
        queued.pending_claim_gate_segment_ids,
        vec![earlier_segment_id.clone(), later_segment_id.clone()]
    );
    assert!(queued.pending_claim_gate_batches.is_empty());

    let first_batch_id = id();
    let first_batch = MeetingClaimGateBatchBeginDto {
        id: first_batch_id.clone(),
        idempotency_key: format!("{}:claim-gate:first", created.meeting.id),
        turns: vec![
            claim_gate_turn(&earlier_segment),
            claim_gate_turn(&later_segment),
        ],
    };
    let begin_first = MeetingClaimsApplyRequest {
        meeting_id: created.meeting.id.clone(),
        begin_claim_gate_batches: vec![first_batch.clone()],
        ..Default::default()
    };
    store.apply_claims(begin_first.clone()).await.unwrap();
    store.apply_claims(begin_first).await.unwrap();
    let batched = artifact(&store, &created.meeting.id).await;
    assert!(batched.pending_claim_gate_segment_ids.is_empty());
    assert_eq!(batched.pending_claim_gate_batches.len(), 1);
    assert_eq!(batched.pending_claim_gate_batches[0].id, first_batch_id);
    assert_eq!(
        batched.pending_claim_gate_batches[0].idempotency_key,
        first_batch.idempotency_key
    );
    assert_eq!(
        batched.pending_claim_gate_batches[0].segment_ids,
        vec![earlier_segment_id.clone(), later_segment_id.clone()]
    );
    let lock_error = store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            begin_claim_gate_batches: vec![MeetingClaimGateBatchBeginDto {
                id: id(),
                idempotency_key: format!("{}:claim-gate:collision", created.meeting.id),
                turns: vec![claim_gate_turn(&earlier_segment)],
            }],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(lock_error, MeetingStoreError::Conflict));

    drop(store);
    let store = MeetingStore::new(directory.path().to_path_buf()).unwrap();
    store.initialize().await.unwrap();
    let recovered = artifact(&store, &created.meeting.id).await;
    assert_eq!(recovered.pending_claim_gate_batches.len(), 1);
    assert_eq!(
        recovered.pending_claim_gate_batches[0].segment_ids,
        vec![earlier_segment_id.clone(), later_segment_id.clone()]
    );
    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            complete_claim_gate_batch_ids: vec![first_batch_id.clone()],
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            complete_claim_gate_batch_ids: vec![first_batch_id],
            ..Default::default()
        })
        .await
        .unwrap();
    let zero_candidate_ack = artifact(&store, &created.meeting.id).await;
    assert!(zero_candidate_ack.pending_claim_gate_segment_ids.is_empty());
    assert!(zero_candidate_ack.pending_claim_gate_batches.is_empty());

    let duplicate = store.apply_transcript(live_request).await.unwrap();
    assert!(duplicate
        .segment_outcomes
        .iter()
        .all(|outcome| outcome.outcome == MeetingUpsertOutcomeKind::Duplicate));
    assert!(artifact(&store, &created.meeting.id)
        .await
        .pending_claim_gate_segment_ids
        .is_empty());

    let mut revision_one = earlier_segment.clone();
    revision_one.revision_number = 1;
    revision_one.state = MeetingTranscriptSegmentState::Revised;
    revision_one.text = "The earlier turn after revision one.".to_string();
    store
        .apply_transcript(MeetingTranscriptApplyRequest {
            meeting_id: created.meeting.id.clone(),
            version: version(
                &created.live_transcript_version.id,
                MeetingTranscriptVersionKind::Live,
                MeetingTranscriptVersionStatus::Complete,
                1,
            ),
            segments: vec![revision_one.clone()],
            speaker_observations: vec![],
            promote_canonical: true,
        })
        .await
        .unwrap();
    assert_eq!(
        artifact(&store, &created.meeting.id)
            .await
            .pending_claim_gate_segment_ids,
        vec![earlier_segment_id.clone()]
    );
    let second_batch_id = id();
    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            begin_claim_gate_batches: vec![MeetingClaimGateBatchBeginDto {
                id: second_batch_id.clone(),
                idempotency_key: format!("{}:claim-gate:second", created.meeting.id),
                turns: vec![claim_gate_turn(&revision_one)],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    let mut revision_two = revision_one;
    revision_two.revision_number = 2;
    revision_two.text = "The earlier turn after revision two.".to_string();
    store
        .apply_transcript(MeetingTranscriptApplyRequest {
            meeting_id: created.meeting.id.clone(),
            version: version(
                &created.live_transcript_version.id,
                MeetingTranscriptVersionKind::Live,
                MeetingTranscriptVersionStatus::Complete,
                1,
            ),
            segments: vec![revision_two.clone()],
            speaker_observations: vec![],
            promote_canonical: true,
        })
        .await
        .unwrap();
    let revision_while_batched = artifact(&store, &created.meeting.id).await;
    assert_eq!(revision_while_batched.pending_claim_gate_batches.len(), 1);
    assert_eq!(
        revision_while_batched.pending_claim_gate_segment_ids,
        vec![earlier_segment_id.clone()]
    );
    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            complete_claim_gate_batch_ids: vec![second_batch_id],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        artifact(&store, &created.meeting.id)
            .await
            .pending_claim_gate_segment_ids,
        vec![earlier_segment_id.clone()]
    );

    let third_batch_id = id();
    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            begin_claim_gate_batches: vec![MeetingClaimGateBatchBeginDto {
                id: third_batch_id.clone(),
                idempotency_key: format!("{}:claim-gate:third", created.meeting.id),
                turns: vec![claim_gate_turn(&revision_two)],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    let claim_id = id();
    let claim_version_id = id();
    let mut committed_claim = claim_request(
        &created,
        &claim_id,
        &claim_version_id,
        "The earlier turn after revision two.",
    );
    committed_claim.claim_versions[0].segment_ids = vec![earlier_segment_id.clone()];
    committed_claim.complete_claim_gate_batch_ids = vec![third_batch_id];
    store.apply_claims(committed_claim).await.unwrap();
    let committed = artifact(&store, &created.meeting.id).await;
    assert_eq!(committed.claims.len(), 1);
    assert!(committed.pending_claim_gate_segment_ids.is_empty());
    assert!(committed.pending_claim_gate_batches.is_empty());

    let refinement_job_id = id();
    store
        .apply_refinement_job(MeetingRefinementJobApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: refinement_job(
                &created,
                &refinement_job_id,
                MeetingRefinementJobStatus::Processing,
                1,
            ),
        })
        .await
        .unwrap();
    let refined_version_id = id();
    let refined_segment_id = id();
    let refined_segment = segment(
        &refined_version_id,
        &refined_segment_id,
        "refinement/gate-fixture",
        "refined-turn",
        1,
        (1_000, 1_300),
        "A refined turn must not enter the automatic gate.",
    );
    store
        .apply_refinement_result(MeetingRefinementResultApplyRequest {
            meeting_id: created.meeting.id.clone(),
            refinement_job_id,
            version: version(
                &refined_version_id,
                MeetingTranscriptVersionKind::Refined,
                MeetingTranscriptVersionStatus::Complete,
                1,
            ),
            segments: vec![refined_segment.clone()],
            speaker_observations: vec![],
            mark_stale_claim_version_ids: vec![],
            replacement_claim_versions: vec![],
        })
        .await
        .unwrap();
    let after_refinement = artifact(&store, &created.meeting.id).await;
    assert!(after_refinement.pending_claim_gate_segment_ids.is_empty());
    assert!(after_refinement.pending_claim_gate_batches.is_empty());
    let refined_gate_error = store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            begin_claim_gate_batches: vec![MeetingClaimGateBatchBeginDto {
                id: id(),
                idempotency_key: format!("{}:claim-gate:refined", created.meeting.id),
                turns: vec![claim_gate_turn(&refined_segment)],
            }],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(refined_gate_error, MeetingStoreError::NotFound));
}

#[tokio::test]
async fn claim_gate_batch_recovery_keeps_an_immutable_turn_snapshot_across_revisions() {
    let (directory, store) = store().await;
    let created = create(&store).await;
    let first_speaker_id = id();
    let second_speaker_id = id();
    store
        .apply_speakers(MeetingSpeakersApplyRequest {
            meeting_id: created.meeting.id.clone(),
            speakers: vec![
                MeetingSpeakerInputDto {
                    id: Some(first_speaker_id.clone()),
                    default_label: "Speaker 1".to_string(),
                    source_hint: Some(MeetingAudioSourceKind::Mixed),
                    ..Default::default()
                },
                MeetingSpeakerInputDto {
                    id: Some(second_speaker_id.clone()),
                    default_label: "Speaker 2".to_string(),
                    source_hint: Some(MeetingAudioSourceKind::System),
                    ..Default::default()
                },
            ],
            ..Default::default()
        })
        .await
        .unwrap();

    let segment_id = id();
    let mut revision_zero = segment(
        &created.live_transcript_version.id,
        &segment_id,
        "live/retry-snapshot",
        "turn-1",
        1,
        (1_000, 1_500),
        "Original finalized wording.",
    );
    revision_zero.revision_number = 0;
    revision_zero.speaker_id = Some(first_speaker_id.clone());
    store
        .apply_transcript(MeetingTranscriptApplyRequest {
            meeting_id: created.meeting.id.clone(),
            version: version(
                &created.live_transcript_version.id,
                MeetingTranscriptVersionKind::Live,
                MeetingTranscriptVersionStatus::Complete,
                1,
            ),
            segments: vec![revision_zero.clone()],
            speaker_observations: vec![],
            promote_canonical: true,
        })
        .await
        .unwrap();

    let first_batch_id = id();
    let first_batch = MeetingClaimGateBatchBeginDto {
        id: first_batch_id.clone(),
        idempotency_key: format!("{}:claim-gate:snapshot-0", created.meeting.id),
        turns: vec![claim_gate_turn(&revision_zero)],
    };

    let mut revision_one = revision_zero;
    revision_one.revision_number = 1;
    revision_one.state = MeetingTranscriptSegmentState::Revised;
    revision_one.speaker_id = Some(second_speaker_id);
    revision_one.source_kind = MeetingAudioSourceKind::System;
    revision_one.start_ms = 1_100;
    revision_one.end_ms = 1_700;
    revision_one.text = "Revised finalized wording.".to_string();
    store
        .apply_transcript(MeetingTranscriptApplyRequest {
            meeting_id: created.meeting.id.clone(),
            version: version(
                &created.live_transcript_version.id,
                MeetingTranscriptVersionKind::Live,
                MeetingTranscriptVersionStatus::Complete,
                1,
            ),
            segments: vec![revision_one.clone()],
            speaker_observations: vec![],
            promote_canonical: true,
        })
        .await
        .unwrap();
    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            begin_claim_gate_batches: vec![first_batch.clone()],
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            begin_claim_gate_batches: vec![first_batch.clone()],
            ..Default::default()
        })
        .await
        .unwrap();
    let mut conflicting_replay = first_batch;
    conflicting_replay.turns[0].text = "A different paid request body.".to_string();
    let replay_error = store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            begin_claim_gate_batches: vec![conflicting_replay],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(replay_error, MeetingStoreError::Conflict));

    drop(store);
    let store = MeetingStore::new(directory.path().to_path_buf()).unwrap();
    store.initialize().await.unwrap();
    let recovered = artifact(&store, &created.meeting.id).await;
    assert_eq!(
        recovered.pending_claim_gate_segment_ids,
        vec![segment_id.clone()]
    );
    assert_eq!(recovered.pending_claim_gate_batches.len(), 1);
    let recovered_batch = &recovered.pending_claim_gate_batches[0];
    assert_eq!(recovered_batch.id, first_batch_id);
    assert_eq!(recovered_batch.turns.len(), 1);
    let recovered_turn = &recovered_batch.turns[0];
    assert_eq!(recovered_turn.id, segment_id);
    assert_eq!(
        recovered_turn.speaker_id.as_deref(),
        Some(first_speaker_id.as_str())
    );
    assert_eq!(
        (recovered_turn.start_ms, recovered_turn.end_ms),
        (1_000, 1_500)
    );
    assert_eq!(recovered_turn.text, "Original finalized wording.");
    assert_eq!(recovered_turn.revision_number, 0);
    assert_eq!(recovered_turn.source_kind, MeetingAudioSourceKind::Mixed);
    let current_segment = recovered
        .transcript_segments
        .iter()
        .find(|segment| segment.id == recovered_turn.id)
        .unwrap();
    assert_eq!(current_segment.revision_number, 1);
    assert_eq!(current_segment.text, "Revised finalized wording.");

    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            complete_claim_gate_batch_ids: vec![first_batch_id],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        artifact(&store, &created.meeting.id)
            .await
            .pending_claim_gate_segment_ids,
        vec![segment_id.clone()]
    );

    let second_batch_id = id();
    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            begin_claim_gate_batches: vec![MeetingClaimGateBatchBeginDto {
                id: second_batch_id.clone(),
                idempotency_key: format!("{}:claim-gate:snapshot-1", created.meeting.id),
                turns: vec![claim_gate_turn(&revision_one)],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    let revision_batch_artifact = artifact(&store, &created.meeting.id).await;
    assert!(revision_batch_artifact
        .pending_claim_gate_segment_ids
        .is_empty());
    assert_eq!(revision_batch_artifact.pending_claim_gate_batches.len(), 1);
    assert_eq!(
        revision_batch_artifact.pending_claim_gate_batches[0].id,
        second_batch_id
    );
    assert_eq!(
        revision_batch_artifact.pending_claim_gate_batches[0].turns[0].text,
        revision_one.text
    );
    assert_eq!(
        revision_batch_artifact.pending_claim_gate_batches[0].turns[0].revision_number,
        1
    );
}

#[tokio::test]
async fn claim_gate_batches_reject_cross_meeting_segments_and_completion_atomically() {
    let (_directory, store) = store().await;
    let first = create(&store).await;
    let second = create(&store).await;
    let first_segment_id = id();
    let second_segment_id = id();
    let first_transcript = transcript_request(
        &first,
        &first_segment_id,
        0,
        "A segment owned by the first meeting.",
    );
    let second_transcript = transcript_request(
        &second,
        &second_segment_id,
        0,
        "A segment owned by the second meeting.",
    );
    store
        .apply_transcript(first_transcript.clone())
        .await
        .unwrap();
    store
        .apply_transcript(second_transcript.clone())
        .await
        .unwrap();

    let claim_id = id();
    let claim_version_id = id();
    let mut invalid_candidate = claim_request(
        &first,
        &claim_id,
        &claim_version_id,
        "This candidate must roll back with its invalid batch.",
    );
    invalid_candidate.begin_claim_gate_batches = vec![MeetingClaimGateBatchBeginDto {
        id: id(),
        idempotency_key: format!("{}:claim-gate:cross-meeting", first.meeting.id),
        turns: vec![claim_gate_turn(&second_transcript.segments[0])],
    }];
    let error = store.apply_claims(invalid_candidate).await.unwrap_err();
    assert!(matches!(error, MeetingStoreError::NotFound));
    let first_after_rollback = artifact(&store, &first.meeting.id).await;
    assert!(first_after_rollback.claims.is_empty());
    assert_eq!(
        first_after_rollback.pending_claim_gate_segment_ids,
        vec![first_segment_id]
    );
    assert_eq!(
        artifact(&store, &second.meeting.id)
            .await
            .pending_claim_gate_segment_ids,
        vec![second_segment_id.clone()]
    );

    let second_batch_id = id();
    let second_idempotency_key = format!("{}:claim-gate:owned", second.meeting.id);
    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: second.meeting.id.clone(),
            begin_claim_gate_batches: vec![MeetingClaimGateBatchBeginDto {
                id: second_batch_id.clone(),
                idempotency_key: second_idempotency_key.clone(),
                turns: vec![claim_gate_turn(&second_transcript.segments[0])],
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    let completion_error = store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: first.meeting.id.clone(),
            complete_claim_gate_batch_ids: vec![second_batch_id.clone()],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(completion_error, MeetingStoreError::Conflict));
    let key_collision = store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: second.meeting.id.clone(),
            begin_claim_gate_batches: vec![MeetingClaimGateBatchBeginDto {
                id: id(),
                idempotency_key: second_idempotency_key,
                turns: vec![claim_gate_turn(&second_transcript.segments[0])],
            }],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(key_collision, MeetingStoreError::Conflict));
    let second_pending = artifact(&store, &second.meeting.id).await;
    assert_eq!(second_pending.pending_claim_gate_batches.len(), 1);
    assert_eq!(
        second_pending.pending_claim_gate_batches[0].id,
        second_batch_id
    );
}

#[tokio::test]
async fn manual_fact_check_parent_is_atomic_replayable_restart_safe_and_cleanup_safe() {
    let (directory, store) = store().await;
    let first = create(&store).await;
    let second = create(&store).await;
    let first_segment_id = id();
    let second_segment_id = id();
    let first_transcript = transcript_request(
        &first,
        &first_segment_id,
        0,
        "The selected statement belongs to the first meeting.",
    );
    let second_transcript = transcript_request(
        &second,
        &second_segment_id,
        0,
        "The selected statement belongs to the second meeting.",
    );
    store
        .apply_transcript(first_transcript.clone())
        .await
        .unwrap();
    store
        .apply_transcript(second_transcript.clone())
        .await
        .unwrap();

    let manual_request_id = id();
    let manual_request = MeetingManualFactCheckRequestUpsertDto {
        id: manual_request_id.clone(),
        exact_selection: "The selected statement belongs to the first meeting.".to_string(),
        context_turns: vec![claim_gate_turn(&first_transcript.segments[0])],
        source_segment_ids: vec![first_segment_id.clone()],
        speaker_id: None,
        start_ms: Some(1_000),
        end_ms: Some(1_500),
        status: MeetingManualFactCheckRequestStatus::Complete,
        error: None,
    };

    let mut cross_meeting_anchor = manual_request.clone();
    cross_meeting_anchor.source_segment_ids = vec![second_segment_id.clone()];
    let anchor_error = store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: first.meeting.id.clone(),
            manual_fact_check_requests: vec![cross_meeting_anchor],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(anchor_error, MeetingStoreError::NotFound));
    assert!(artifact(&store, &first.meeting.id)
        .await
        .manual_fact_check_requests
        .is_empty());

    let claim_id = id();
    let claim_version_id = id();
    let mut atomic_request = claim_request(
        &first,
        &claim_id,
        &claim_version_id,
        "The selected statement belongs to the first meeting.",
    );
    atomic_request.manual_fact_check_requests = vec![manual_request.clone()];
    atomic_request.claim_versions[0].manual_request_id = Some(manual_request_id.clone());
    atomic_request.claim_versions[0].origin = MeetingClaimOrigin::Manual;
    atomic_request.claim_versions[0].duplicate_key = Some("manual-parent:child-1".to_string());
    atomic_request.claim_versions[0].segment_ids = vec![second_segment_id.clone()];
    let child_error = store
        .apply_claims(atomic_request.clone())
        .await
        .unwrap_err();
    assert!(matches!(child_error, MeetingStoreError::NotFound));
    let after_child_rollback = artifact(&store, &first.meeting.id).await;
    assert!(after_child_rollback.manual_fact_check_requests.is_empty());
    assert!(after_child_rollback.claims.is_empty());

    atomic_request.claim_versions[0].segment_ids = vec![first_segment_id.clone()];
    store.apply_claims(atomic_request.clone()).await.unwrap();
    let first_commit_updated_at_ms = artifact(&store, &first.meeting.id)
        .await
        .manual_fact_check_requests[0]
        .updated_at_ms;
    store.apply_claims(atomic_request.clone()).await.unwrap();
    let committed = artifact(&store, &first.meeting.id).await;
    assert_eq!(committed.manual_fact_check_requests.len(), 1);
    assert_eq!(
        committed.manual_fact_check_requests[0].context_turns[0].text,
        first_transcript.segments[0].text
    );
    assert_eq!(
        committed.manual_fact_check_requests[0].source_segment_ids,
        vec![first_segment_id.clone()]
    );
    assert_eq!(
        committed.manual_fact_check_requests[0].status,
        MeetingManualFactCheckRequestStatus::Complete
    );
    assert_eq!(
        committed.manual_fact_check_requests[0].updated_at_ms,
        first_commit_updated_at_ms
    );
    assert_eq!(
        committed.claims[0].manual_request_id.as_deref(),
        Some(manual_request_id.as_str())
    );

    let mut stale_replay = manual_request.clone();
    stale_replay.status = MeetingManualFactCheckRequestStatus::RetryWait;
    let stale_error = store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: first.meeting.id.clone(),
            manual_fact_check_requests: vec![stale_replay],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(stale_error, MeetingStoreError::Conflict));
    let mut content_conflict = manual_request.clone();
    content_conflict.exact_selection = "Mutated selection.".to_string();
    let content_error = store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: first.meeting.id.clone(),
            manual_fact_check_requests: vec![content_conflict],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(content_error, MeetingStoreError::Conflict));

    let second_manual_request_id = id();
    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: second.meeting.id.clone(),
            manual_fact_check_requests: vec![MeetingManualFactCheckRequestUpsertDto {
                id: second_manual_request_id.clone(),
                exact_selection: second_transcript.segments[0].text.clone(),
                context_turns: vec![claim_gate_turn(&second_transcript.segments[0])],
                source_segment_ids: vec![second_segment_id],
                status: MeetingManualFactCheckRequestStatus::Queued,
                ..Default::default()
            }],
            ..Default::default()
        })
        .await
        .unwrap();
    let mut cross_parent_claim = claim_request(&first, &id(), &id(), "Cross-parent child.");
    cross_parent_claim.claim_versions[0].manual_request_id = Some(second_manual_request_id);
    cross_parent_claim.claim_versions[0].origin = MeetingClaimOrigin::Manual;
    let parent_error = store.apply_claims(cross_parent_claim).await.unwrap_err();
    assert!(matches!(parent_error, MeetingStoreError::NotFound));

    drop(store);
    let store = MeetingStore::new(directory.path().to_path_buf()).unwrap();
    store.initialize().await.unwrap();
    let recovered = artifact(&store, &first.meeting.id).await;
    assert_eq!(recovered.manual_fact_check_requests.len(), 1);
    assert_eq!(recovered.claims.len(), 1);
    assert_eq!(
        recovered.manual_fact_check_requests[0].status,
        MeetingManualFactCheckRequestStatus::Complete
    );

    let cleanup_job = store
        .delete_meeting(MeetingDeleteRequest {
            meeting_id: first.meeting.id,
        })
        .await
        .unwrap()
        .cleanup_job;
    let cleaned = store
        .confirm_cleanup(MeetingCleanupConfirmRequest {
            cleanup_job_id: cleanup_job.id,
            local_status: MeetingCleanupStatus::Unavailable,
            gateway_status: MeetingCleanupStatus::Unavailable,
            provider_status: MeetingCleanupStatus::Unavailable,
            error: None,
        })
        .await
        .unwrap();
    assert!(cleaned.records_removed);
}

#[tokio::test]
async fn rejects_a_database_from_a_newer_schema_version() {
    let (directory, store) = store().await;
    let mut connection =
        SqliteConnection::connect(&format!("sqlite://{}", store.database_path().display()))
            .await
            .unwrap();
    sqlx::query("INSERT INTO meeting_schema_version(version, applied_at_ms) VALUES (4, 0)")
        .execute(&mut connection)
        .await
        .unwrap();
    drop(connection);

    let reopened = MeetingStore::new(directory.path().to_path_buf()).unwrap();
    let error = reopened.initialize().await.unwrap_err();
    assert!(matches!(error, MeetingStoreError::SchemaTooNew));
}

#[tokio::test]
async fn migrations_two_and_three_backfill_the_gate_and_add_manual_request_storage() {
    let directory = tempfile::tempdir().unwrap();
    let store = MeetingStore::new(directory.path().to_path_buf()).unwrap();
    store.initialize().await.unwrap();
    let created = create(&store).await;
    let segment_id = id();
    store
        .apply_transcript(transcript_request(
            &created,
            &segment_id,
            0,
            "A pre-migration finalized segment.",
        ))
        .await
        .unwrap();
    let database_path = store.database_path().to_path_buf();
    drop(store);

    let mut connection =
        SqliteConnection::connect(&format!("sqlite://{}", database_path.display()))
            .await
            .unwrap();
    sqlx::query("DROP INDEX idx_claims_manual_request")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE claims DROP COLUMN manual_request_id")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DROP TABLE manual_fact_check_request_segments")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DROP TABLE manual_fact_check_request_context_turns")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DROP TABLE manual_fact_check_requests")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DROP TABLE claim_gate_batch_segments")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DROP TABLE claim_gate_batches")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DROP TABLE claim_gate_segments")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("DELETE FROM meeting_schema_version WHERE version >= 2")
        .execute(&mut connection)
        .await
        .unwrap();
    drop(connection);

    let reopened = MeetingStore::new(directory.path().to_path_buf()).unwrap();
    reopened.initialize().await.unwrap();
    let migrated = artifact(&reopened, &created.meeting.id).await;
    assert_eq!(migrated.pending_claim_gate_segment_ids, vec![segment_id]);
    assert!(migrated.pending_claim_gate_batches.is_empty());
    let mut connection =
        SqliteConnection::connect(&format!("sqlite://{}", database_path.display()))
            .await
            .unwrap();
    let versions: Vec<i64> =
        sqlx::query("SELECT version FROM meeting_schema_version ORDER BY version")
            .fetch_all(&mut connection)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get(0))
            .collect();
    assert_eq!(versions, vec![1, 2, 3]);
}

#[tokio::test]
async fn meeting_crud_list_pagination_status_type_and_text_filters_are_deterministic() {
    let (_directory, store) = store().await;
    let first = create(&store).await;
    let mut second_request = create_request();
    second_request.title = Some("Mars briefing".to_string());
    let second = store.create_meeting(second_request).await.unwrap();
    let mut third_request = create_request();
    third_request.title = Some("Mars memo".to_string());
    third_request.artifact_type = MeetingArtifactType::TextCheck;
    third_request.mode = MeetingMode::Text;
    let third = store.create_meeting(third_request).await.unwrap();
    let mut fourth_request = create_request();
    fourth_request.title = Some("Budget review".to_string());
    let fourth = store.create_meeting(fourth_request).await.unwrap();

    let updated = store
        .update_meeting(MeetingUpdateRequest {
            meeting_id: second.meeting.id.clone(),
            title: Some("Mars briefing — final".to_string()),
            status: Some(MeetingLifecycleStatus::Complete),
            ended_at_ms: Some(5_000),
            capture_status: Some(MeetingCaptureStatus::Complete),
            refinement_status: Some(MeetingRefinementStatus::Complete),
            research_status: Some(MeetingResearchStatus::Partial),
            error: Some(MeetingTypedErrorDto {
                code: "research_partial".to_string(),
                message: "One optional source was unavailable".to_string(),
                retryable: true,
            }),
            clear_error: false,
        })
        .await
        .unwrap()
        .meeting;
    assert_eq!(updated.title, "Mars briefing — final");
    assert_eq!(updated.ended_at_ms, Some(5_000));
    assert_eq!(updated.last_error.unwrap().code, "research_partial");
    let cleared = store
        .update_meeting(MeetingUpdateRequest {
            meeting_id: second.meeting.id.clone(),
            clear_error: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(cleared.meeting.last_error.is_none());
    store
        .update_meeting(MeetingUpdateRequest {
            meeting_id: fourth.meeting.id.clone(),
            status: Some(MeetingLifecycleStatus::Interrupted),
            capture_status: Some(MeetingCaptureStatus::Interrupted),
            ..Default::default()
        })
        .await
        .unwrap();
    let searchable_segment_id = id();
    store
        .apply_transcript(transcript_request(
            &first,
            &searchable_segment_id,
            1,
            "The quasar needle appears only in the transcript.",
        ))
        .await
        .unwrap();

    let mut cursor = None;
    let mut paged_ids = Vec::new();
    loop {
        let page = store
            .list_meetings(MeetingListRequest {
                cursor,
                limit: Some(2),
                ..Default::default()
            })
            .await
            .unwrap();
        paged_ids.extend(page.items.into_iter().map(|item| item.meeting.id));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    let unique_ids = paged_ids.iter().collect::<std::collections::HashSet<_>>();
    assert_eq!(paged_ids.len(), 4);
    assert_eq!(unique_ids.len(), 4);

    let complete = store
        .list_meetings(MeetingListRequest {
            statuses: vec![MeetingLifecycleStatus::Complete],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(complete.items.len(), 2);
    assert!(complete
        .items
        .iter()
        .any(|item| { item.meeting.id == second.meeting.id && item.duration_ms == Some(4_000) }));
    let text_checks = store
        .list_meetings(MeetingListRequest {
            artifact_type: Some(MeetingArtifactType::TextCheck),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(text_checks.items.len(), 1);
    assert_eq!(text_checks.items[0].meeting.id, third.meeting.id);
    let title_search = store
        .list_meetings(MeetingListRequest {
            query: Some("mArS".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(title_search.items.len(), 2);
    let transcript_search = store
        .list_meetings(MeetingListRequest {
            query: Some("QUASAR NEEDLE".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(transcript_search.items.len(), 1);
    assert_eq!(transcript_search.items[0].meeting.id, first.meeting.id);
}

fn claim_request(
    created: &MeetingCreateResponse,
    claim_id: &str,
    claim_version_id: &str,
    quote: &str,
) -> MeetingClaimsApplyRequest {
    MeetingClaimsApplyRequest {
        meeting_id: created.meeting.id.clone(),
        claim_versions: vec![MeetingClaimVersionUpsertDto {
            claim_id: claim_id.to_string(),
            claim_version_id: claim_version_id.to_string(),
            manual_request_id: None,
            origin: MeetingClaimOrigin::Automatic,
            duplicate_key: Some("normalized-key".to_string()),
            status: MeetingClaimStatus::Queued,
            version_number: 1,
            predecessor_id: None,
            superseded_by_id: None,
            source_transcript_version_id: Some(created.live_transcript_version.id.clone()),
            exact_quote: quote.to_string(),
            normalized_claim: "A bounded factual claim".to_string(),
            speaker_id: None,
            start_ms: Some(1_000),
            end_ms: Some(1_500),
            segment_ids: vec![],
            selection_rationale: Some("Material and externally checkable".to_string()),
            consequence_score: Some(0.8),
            dispute_score: Some(0.5),
            specificity_score: Some(0.9),
            time_sensitive: false,
            lifecycle: MeetingClaimVersionLifecycle::Active,
            set_current: true,
        }],
        mark_stale_claim_version_ids: vec![],
        manual_fact_check_requests: vec![],
        begin_claim_gate_batches: vec![],
        complete_claim_gate_batch_ids: vec![],
    }
}

#[tokio::test]
async fn namespaced_speaker_revisions_preserve_manual_names_and_claim_segment_anchors() {
    let (_directory, store) = store().await;
    let created = create(&store).await;
    let first_speaker_id = id();
    let second_speaker_id = id();
    store
        .apply_speakers(MeetingSpeakersApplyRequest {
            meeting_id: created.meeting.id.clone(),
            speakers: vec![
                MeetingSpeakerInputDto {
                    id: Some(first_speaker_id.clone()),
                    default_label: "Speaker 1".to_string(),
                    display_name: Some("Alex".to_string()),
                    display_name_source: Some("manual".to_string()),
                    manual_assignment_lock: true,
                    source_hint: Some(MeetingAudioSourceKind::Microphone),
                },
                MeetingSpeakerInputDto {
                    id: Some(second_speaker_id.clone()),
                    default_label: "Speaker 2".to_string(),
                    display_name: Some("Blair".to_string()),
                    display_name_source: Some("manual".to_string()),
                    manual_assignment_lock: true,
                    source_hint: Some(MeetingAudioSourceKind::System),
                },
            ],
            swaps: vec![],
            segment_updates: vec![],
        })
        .await
        .unwrap();

    let segment_id = id();
    let observation_id = id();
    let mut live_segment = segment(
        &created.live_transcript_version.id,
        &segment_id,
        "live/session-1",
        "turn-1",
        1,
        (1_000, 1_500),
        "The observed number was forty-two.",
    );
    live_segment.speaker_id = Some(first_speaker_id.clone());
    store
        .apply_transcript(MeetingTranscriptApplyRequest {
            meeting_id: created.meeting.id.clone(),
            version: version(
                &created.live_transcript_version.id,
                MeetingTranscriptVersionKind::Live,
                MeetingTranscriptVersionStatus::Complete,
                1,
            ),
            segments: vec![live_segment],
            speaker_observations: vec![MeetingSpeakerObservationUpsertDto {
                id: observation_id.clone(),
                transcript_version_id: created.live_transcript_version.id.clone(),
                speaker_id: Some(first_speaker_id.clone()),
                provider: "test-transcriber".to_string(),
                provider_namespace: "live/session-1".to_string(),
                provider_speaker_label: "A".to_string(),
                confidence: Some(0.81),
                ambiguous: false,
                revision_number: 1,
                source_hint: Some(MeetingAudioSourceKind::Microphone),
            }],
            promote_canonical: true,
        })
        .await
        .unwrap();
    let claim_id = id();
    let claim_version_id = id();
    let mut anchored_claim = claim_request(
        &created,
        &claim_id,
        &claim_version_id,
        "The observed number was forty-two.",
    );
    anchored_claim.claim_versions[0].speaker_id = Some(first_speaker_id.clone());
    anchored_claim.claim_versions[0].segment_ids = vec![segment_id.clone()];
    store.apply_claims(anchored_claim).await.unwrap();

    store
        .apply_transcript(MeetingTranscriptApplyRequest {
            meeting_id: created.meeting.id.clone(),
            version: version(
                &created.live_transcript_version.id,
                MeetingTranscriptVersionKind::Live,
                MeetingTranscriptVersionStatus::Complete,
                1,
            ),
            segments: vec![],
            speaker_observations: vec![
                MeetingSpeakerObservationUpsertDto {
                    id: observation_id,
                    transcript_version_id: created.live_transcript_version.id.clone(),
                    speaker_id: Some(second_speaker_id.clone()),
                    provider: "test-transcriber".to_string(),
                    provider_namespace: "live/session-1".to_string(),
                    provider_speaker_label: "A".to_string(),
                    confidence: Some(0.96),
                    ambiguous: false,
                    revision_number: 2,
                    source_hint: Some(MeetingAudioSourceKind::System),
                },
                MeetingSpeakerObservationUpsertDto {
                    id: id(),
                    transcript_version_id: created.live_transcript_version.id.clone(),
                    speaker_id: Some(first_speaker_id.clone()),
                    provider: "test-transcriber".to_string(),
                    provider_namespace: "live/session-2".to_string(),
                    provider_speaker_label: "A".to_string(),
                    confidence: Some(0.92),
                    ambiguous: false,
                    revision_number: 1,
                    source_hint: Some(MeetingAudioSourceKind::Microphone),
                },
            ],
            promote_canonical: true,
        })
        .await
        .unwrap();
    store
        .apply_speakers(MeetingSpeakersApplyRequest {
            meeting_id: created.meeting.id.clone(),
            speakers: vec![MeetingSpeakerInputDto {
                id: Some(first_speaker_id.clone()),
                default_label: "Speaker 1 revised".to_string(),
                display_name: Some("Provider overwrite".to_string()),
                display_name_source: Some("provider".to_string()),
                manual_assignment_lock: false,
                source_hint: Some(MeetingAudioSourceKind::Mixed),
            }],
            swaps: vec![],
            segment_updates: vec![MeetingSegmentSpeakerUpdateDto {
                segment_id: segment_id.clone(),
                speaker_id: second_speaker_id.clone(),
            }],
        })
        .await
        .unwrap();

    let artifact = artifact(&store, &created.meeting.id).await;
    assert_eq!(artifact.speaker_observations.len(), 2);
    let revised_observation = artifact
        .speaker_observations
        .iter()
        .find(|observation| observation.provider_namespace == "live/session-1")
        .unwrap();
    assert_eq!(revised_observation.revision_number, 2);
    assert_eq!(
        revised_observation.speaker_id.as_deref(),
        Some(second_speaker_id.as_str())
    );
    assert_eq!(
        artifact.transcript_segments[0].speaker_id,
        Some(second_speaker_id)
    );
    let manually_named = artifact
        .speakers
        .iter()
        .find(|speaker| speaker.id == first_speaker_id)
        .unwrap();
    assert_eq!(manually_named.display_name.as_deref(), Some("Alex"));
    assert!(manually_named.manual_assignment_lock);
    assert_eq!(artifact.claim_versions[0].segment_ids, vec![segment_id]);
    assert_eq!(
        artifact.claim_versions[0].exact_quote,
        "The observed number was forty-two."
    );
}

#[tokio::test]
async fn claim_versions_are_immutable_and_staleness_preserves_history() {
    let (_directory, store) = store().await;
    let created = create(&store).await;
    let claim_id = id();
    let claim_version_id = id();
    store
        .apply_claims(claim_request(
            &created,
            &claim_id,
            &claim_version_id,
            "Original quote",
        ))
        .await
        .unwrap();
    let error = store
        .apply_claims(claim_request(
            &created,
            &claim_id,
            &claim_version_id,
            "Mutated quote",
        ))
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Conflict));

    store
        .apply_claims(MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            manual_fact_check_requests: vec![],
            claim_versions: vec![],
            mark_stale_claim_version_ids: vec![claim_version_id.clone()],
            begin_claim_gate_batches: vec![],
            complete_claim_gate_batch_ids: vec![],
        })
        .await
        .unwrap();
    let artifact = store
        .get_artifact(MeetingGetRequest {
            meeting_id: created.meeting.id.clone(),
        })
        .await
        .unwrap()
        .artifact;
    assert_eq!(artifact.claim_versions.len(), 1);
    assert_eq!(artifact.claim_versions[0].exact_quote, "Original quote");
    assert_eq!(
        artifact.claim_versions[0].lifecycle,
        MeetingClaimVersionLifecycle::Stale
    );
    assert_eq!(artifact.claims[0].status, MeetingClaimStatus::Stale);
}

#[tokio::test]
async fn claim_version_relationships_reject_cross_claim_and_cross_meeting_ids() {
    let (_directory, store) = store().await;
    let created = create(&store).await;
    let other_meeting = create(&store).await;
    let claim_id = id();
    let first_version_id = id();
    store
        .apply_claims(claim_request(
            &created,
            &claim_id,
            &first_version_id,
            "The first version belongs to the primary claim.",
        ))
        .await
        .unwrap();

    let other_claim_id = id();
    let other_claim_version_id = id();
    let mut other_claim = claim_request(
        &created,
        &other_claim_id,
        &other_claim_version_id,
        "A different logical claim in the same meeting.",
    );
    other_claim.claim_versions[0].duplicate_key = Some("other-claim-key".to_string());
    store.apply_claims(other_claim).await.unwrap();

    let cross_meeting_claim_id = id();
    let cross_meeting_version_id = id();
    store
        .apply_claims(claim_request(
            &other_meeting,
            &cross_meeting_claim_id,
            &cross_meeting_version_id,
            "A claim from another meeting.",
        ))
        .await
        .unwrap();

    let rejected_version_id = id();
    let mut cross_claim_predecessor = claim_request(
        &created,
        &claim_id,
        &rejected_version_id,
        "This invalid version points at another logical claim.",
    );
    cross_claim_predecessor.claim_versions[0].version_number = 2;
    cross_claim_predecessor.claim_versions[0].predecessor_id = Some(other_claim_version_id.clone());
    let error = store
        .apply_claims(cross_claim_predecessor)
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Conflict));

    let mut cross_meeting_predecessor = claim_request(
        &created,
        &claim_id,
        &rejected_version_id,
        "This invalid version points at another meeting.",
    );
    cross_meeting_predecessor.claim_versions[0].version_number = 2;
    cross_meeting_predecessor.claim_versions[0].predecessor_id = Some(cross_meeting_version_id);
    let error = store
        .apply_claims(cross_meeting_predecessor)
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Conflict));

    let mut cross_claim_successor = claim_request(
        &created,
        &claim_id,
        &first_version_id,
        "The first version belongs to the primary claim.",
    );
    cross_claim_successor.claim_versions[0].superseded_by_id = Some(other_claim_version_id);
    cross_claim_successor.claim_versions[0].lifecycle = MeetingClaimVersionLifecycle::Superseded;
    let error = store.apply_claims(cross_claim_successor).await.unwrap_err();
    assert!(matches!(error, MeetingStoreError::Conflict));

    let after_rejections = artifact(&store, &created.meeting.id).await;
    let primary_claim = after_rejections
        .claims
        .iter()
        .find(|claim| claim.id == claim_id)
        .unwrap();
    assert_eq!(
        primary_claim.current_claim_version_id.as_deref(),
        Some(first_version_id.as_str())
    );
    assert!(after_rejections
        .claim_versions
        .iter()
        .all(|version| version.id != rejected_version_id));
    assert_eq!(
        after_rejections
            .claim_versions
            .iter()
            .find(|version| version.id == first_version_id)
            .unwrap()
            .superseded_by_id,
        None
    );

    let valid_second_version_id = id();
    let mut valid_successor = claim_request(
        &created,
        &claim_id,
        &valid_second_version_id,
        "The valid second version belongs to the primary claim.",
    );
    valid_successor.claim_versions[0].version_number = 2;
    valid_successor.claim_versions[0].predecessor_id = Some(first_version_id.clone());
    store.apply_claims(valid_successor).await.unwrap();
    let valid_artifact = artifact(&store, &created.meeting.id).await;
    assert_eq!(
        valid_artifact
            .claims
            .iter()
            .find(|claim| claim.id == claim_id)
            .unwrap()
            .current_claim_version_id
            .as_deref(),
        Some(valid_second_version_id.as_str())
    );
    assert_eq!(
        valid_artifact
            .claim_versions
            .iter()
            .find(|version| version.id == first_version_id)
            .unwrap()
            .superseded_by_id
            .as_deref(),
        Some(valid_second_version_id.as_str())
    );
}

#[tokio::test]
async fn claim_supersession_assessment_attempt_history_and_research_recovery_are_immutable() {
    let (_directory, store) = store().await;
    let created = create(&store).await;
    let claim_id = id();
    let first_claim_version_id = id();
    store
        .apply_claims(claim_request(
            &created,
            &claim_id,
            &first_claim_version_id,
            "The initial quote says forty-two.",
        ))
        .await
        .unwrap();

    let first_assessment_id = id();
    let first_assessment = assessment(
        &first_assessment_id,
        &first_claim_version_id,
        MeetingAssessmentStage::Preliminary,
        1,
        None,
        MeetingVerdict::Supported,
    );
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(first_assessment.clone()),
        })
        .await
        .unwrap();
    let mut replay_with_mutated_output = first_assessment;
    replay_with_mutated_output.verdict = MeetingVerdict::Unsupported;
    replay_with_mutated_output.conclusion[0].text =
        "This mutated replay must not overwrite history.".to_string();
    let replayed = store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(replay_with_mutated_output),
        })
        .await
        .unwrap()
        .assessment
        .unwrap();
    assert_eq!(replayed.verdict, MeetingVerdict::Supported);
    assert_eq!(
        replayed.conclusion[0].text,
        "The fixture evidence supports this assessment."
    );

    let second_assessment_id = id();
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(assessment(
                &second_assessment_id,
                &first_claim_version_id,
                MeetingAssessmentStage::Preliminary,
                2,
                Some(first_assessment_id.clone()),
                MeetingVerdict::Mixed,
            )),
        })
        .await
        .unwrap();

    let second_claim_version_id = id();
    let mut superseding = claim_request(
        &created,
        &claim_id,
        &second_claim_version_id,
        "The refined quote says forty-three.",
    );
    superseding.claim_versions[0].version_number = 2;
    superseding.claim_versions[0].predecessor_id = Some(first_claim_version_id.clone());
    superseding.claim_versions[0].normalized_claim =
        "The measured quantity was forty-three.".to_string();
    superseding.claim_versions[0].status = MeetingClaimStatus::Rechecking;
    superseding.claim_versions[0].lifecycle = MeetingClaimVersionLifecycle::Rechecking;
    store.apply_claims(superseding).await.unwrap();

    let job_id = id();
    let idempotency_key = format!("research-{second_claim_version_id}-preliminary");
    let running = research_job(
        &second_claim_version_id,
        &job_id,
        &idempotency_key,
        MeetingJobStatus::Running,
        1,
    );
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(running.clone()),
            assessment: None,
        })
        .await
        .unwrap();
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(running),
            assessment: None,
        })
        .await
        .unwrap();
    let idempotency_collision = store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(research_job(
                &second_claim_version_id,
                &id(),
                &idempotency_key,
                MeetingJobStatus::Pending,
                0,
            )),
            assessment: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(idempotency_collision, MeetingStoreError::Conflict));

    let recovered = store
        .recover(MeetingRecoverRequest {
            reconcile_active_work: true,
        })
        .await
        .unwrap();
    assert_eq!(recovered.research_job_ids, vec![job_id.clone()]);
    assert_eq!(
        recovered.research_jobs[0].status,
        MeetingJobStatus::RetryWait
    );
    let mut completed = research_job(
        &second_claim_version_id,
        &job_id,
        &idempotency_key,
        MeetingJobStatus::Complete,
        2,
    );
    completed.next_retry_at_ms = Some(3_000);
    completed.completed_at_ms = Some(3_500);
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(completed),
            assessment: None,
        })
        .await
        .unwrap();

    let artifact = artifact(&store, &created.meeting.id).await;
    assert_eq!(artifact.claims.len(), 1);
    assert_eq!(
        artifact.claims[0].current_claim_version_id.as_deref(),
        Some(second_claim_version_id.as_str())
    );
    let first_claim_version = artifact
        .claim_versions
        .iter()
        .find(|version| version.id == first_claim_version_id)
        .unwrap();
    assert_eq!(
        first_claim_version.lifecycle,
        MeetingClaimVersionLifecycle::Superseded
    );
    assert_eq!(
        first_claim_version.superseded_by_id.as_deref(),
        Some(second_claim_version_id.as_str())
    );
    assert_eq!(artifact.assessments.len(), 2);
    let first_attempt = artifact
        .assessments
        .iter()
        .find(|assessment| assessment.id == first_assessment_id)
        .unwrap();
    let second_attempt = artifact
        .assessments
        .iter()
        .find(|assessment| assessment.id == second_assessment_id)
        .unwrap();
    assert!(!first_attempt.current);
    assert!(second_attempt.current);
    assert_eq!(
        second_attempt.supersedes_id.as_deref(),
        Some(first_assessment_id.as_str())
    );
    assert_eq!(artifact.research_jobs.len(), 1);
    assert_eq!(artifact.research_jobs[0].status, MeetingJobStatus::Complete);
    assert_eq!(artifact.research_jobs[0].attempt_count, 2);

    let listed = store
        .list_meetings(MeetingListRequest {
            query: Some("Editorial".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(listed.items.len(), 1);
    assert_eq!(listed.items[0].claim_count, 1);
    assert_eq!(listed.items[0].total_research_count, 1);
    assert_eq!(listed.items[0].completed_research_count, 1);
}

#[tokio::test]
async fn research_transitions_claim_status_transactionally_and_preserves_prior_findings() {
    let (_directory, store) = store().await;
    let created = create(&store).await;
    let claim_id = id();
    let claim_version_id = id();
    store
        .apply_claims(claim_request(
            &created,
            &claim_id,
            &claim_version_id,
            "The fixture claim has a durable research lifecycle.",
        ))
        .await
        .unwrap();

    let preliminary_job_id = id();
    let preliminary_idempotency_key = format!("research-{claim_version_id}-preliminary");
    let preliminary_running = research_job(
        &claim_version_id,
        &preliminary_job_id,
        &preliminary_idempotency_key,
        MeetingJobStatus::Running,
        1,
    );
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(preliminary_running),
            assessment: None,
        })
        .await
        .unwrap();
    assert_eq!(
        artifact(&store, &created.meeting.id).await.claims[0].status,
        MeetingClaimStatus::QuickRunning
    );

    let preliminary_assessment_id = id();
    let preliminary_assessment = assessment(
        &preliminary_assessment_id,
        &claim_version_id,
        MeetingAssessmentStage::Preliminary,
        1,
        None,
        MeetingVerdict::Supported,
    );
    let preliminary_source_id = preliminary_assessment.sources[0].id.clone();
    let mut preliminary_complete = research_job(
        &claim_version_id,
        &preliminary_job_id,
        &preliminary_idempotency_key,
        MeetingJobStatus::Complete,
        1,
    );
    preliminary_complete.completed_at_ms = Some(2_500);
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(preliminary_complete),
            assessment: Some(preliminary_assessment),
        })
        .await
        .unwrap();
    let after_preliminary = artifact(&store, &created.meeting.id).await;
    assert_eq!(
        after_preliminary.claims[0].status,
        MeetingClaimStatus::Preliminary
    );
    assert_eq!(after_preliminary.assessments.len(), 1);

    let deep_job_id = id();
    let deep_idempotency_key = format!("research-{claim_version_id}-deep");
    let mut deep_running = research_job(
        &claim_version_id,
        &deep_job_id,
        &deep_idempotency_key,
        MeetingJobStatus::Running,
        1,
    );
    deep_running.stage = MeetingAssessmentStage::Deep;
    let mut invalid_deep_assessment = assessment(
        &id(),
        &claim_version_id,
        MeetingAssessmentStage::Deep,
        1,
        None,
        MeetingVerdict::Supported,
    );
    invalid_deep_assessment.sources[0].id = preliminary_source_id;
    let transaction_error = store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(deep_running.clone()),
            assessment: Some(invalid_deep_assessment),
        })
        .await
        .unwrap_err();
    assert!(matches!(transaction_error, MeetingStoreError::Conflict));
    let after_rollback = artifact(&store, &created.meeting.id).await;
    assert_eq!(
        after_rollback.claims[0].status,
        MeetingClaimStatus::Preliminary
    );
    assert_eq!(after_rollback.assessments.len(), 1);
    assert_eq!(after_rollback.research_jobs.len(), 1);

    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(deep_running.clone()),
            assessment: None,
        })
        .await
        .unwrap();
    assert_eq!(
        artifact(&store, &created.meeting.id).await.claims[0].status,
        MeetingClaimStatus::DeepRunning
    );

    let mut deep_failed = deep_running.clone();
    deep_failed.status = MeetingJobStatus::Failed;
    deep_failed.attempt_count = 2;
    deep_failed.completed_at_ms = Some(3_000);
    deep_failed.error = Some(MeetingTypedErrorDto {
        code: "deep_research_failed".to_string(),
        message: "The deterministic deep fixture failed".to_string(),
        retryable: true,
    });
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(deep_failed),
            assessment: None,
        })
        .await
        .unwrap();
    let after_failure = artifact(&store, &created.meeting.id).await;
    assert_eq!(after_failure.claims[0].status, MeetingClaimStatus::Failed);
    assert_eq!(after_failure.assessments.len(), 1);
    assert_eq!(after_failure.assessments[0].id, preliminary_assessment_id);

    let mut deep_cancelled = deep_running.clone();
    deep_cancelled.status = MeetingJobStatus::Cancelled;
    deep_cancelled.attempt_count = 3;
    deep_cancelled.completed_at_ms = Some(3_100);
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(deep_cancelled),
            assessment: None,
        })
        .await
        .unwrap();
    assert_eq!(
        artifact(&store, &created.meeting.id).await.claims[0].status,
        MeetingClaimStatus::Cancelled
    );

    let deep_assessment = assessment(
        &id(),
        &claim_version_id,
        MeetingAssessmentStage::Deep,
        1,
        None,
        MeetingVerdict::MostlySupported,
    );
    let mut deep_complete = deep_running.clone();
    deep_complete.status = MeetingJobStatus::Complete;
    deep_complete.attempt_count = 4;
    deep_complete.completed_at_ms = Some(3_500);
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(deep_complete),
            assessment: Some(deep_assessment.clone()),
        })
        .await
        .unwrap();
    let after_deep = artifact(&store, &created.meeting.id).await;
    assert_eq!(after_deep.claims[0].status, MeetingClaimStatus::Complete);
    assert_eq!(after_deep.assessments.len(), 2);

    let mut failed_after_completion = deep_running;
    failed_after_completion.status = MeetingJobStatus::Failed;
    failed_after_completion.attempt_count = 5;
    failed_after_completion.completed_at_ms = Some(3_600);
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(failed_after_completion),
            assessment: None,
        })
        .await
        .unwrap();
    assert_eq!(
        artifact(&store, &created.meeting.id).await.claims[0].status,
        MeetingClaimStatus::Failed
    );
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(deep_assessment),
        })
        .await
        .unwrap();
    assert_eq!(
        artifact(&store, &created.meeting.id).await.claims[0].status,
        MeetingClaimStatus::Complete
    );
}

fn source(source_id: &str) -> MeetingSourceInputDto {
    MeetingSourceInputDto {
        id: source_id.to_string(),
        citation_key: "source-1".to_string(),
        url: "https://example.com/report".to_string(),
        canonical_url: "https://example.com/report".to_string(),
        publisher: "Example publisher".to_string(),
        title: "Primary report".to_string(),
        publication_date: Some("2026-08-10".to_string()),
        accessed_at_ms: 2_000,
        evidence_excerpt: "A short relevant excerpt.".to_string(),
        stance: MeetingEvidenceStance::Supports,
        quality_score: Some(0.9),
        quality_rationale: "Direct primary source".to_string(),
    }
}

fn assessment(
    assessment_id: &str,
    claim_version_id: &str,
    stage: MeetingAssessmentStage,
    attempt_number: u32,
    supersedes_id: Option<String>,
    verdict: MeetingVerdict,
) -> MeetingAssessmentApplyDto {
    MeetingAssessmentApplyDto {
        id: assessment_id.to_string(),
        claim_version_id: claim_version_id.to_string(),
        stage,
        attempt_number,
        status: MeetingAssessmentStatus::Complete,
        supersedes_id,
        verdict,
        confidence: MeetingConfidence::High,
        conclusion: vec![MeetingCitedStatementDto {
            text: "The fixture evidence supports this assessment.".to_string(),
            citation_keys: vec!["source-1".to_string()],
        }],
        support: vec![],
        contradiction: vec![],
        caveats: vec![],
        limitations: vec![],
        model_provider: "test".to_string(),
        model: "deterministic-model".to_string(),
        model_version: Some("fixture-v1".to_string()),
        usage: Some(serde_json::json!({"inputTokens": 10, "outputTokens": 5})),
        latency_ms: Some(100),
        started_at_ms: 2_000 + i64::from(attempt_number) * 100,
        completed_at_ms: 2_050 + i64::from(attempt_number) * 100,
        error: None,
        sources: vec![source(&id())],
        set_current: true,
    }
}

#[tokio::test]
async fn assessment_and_citations_commit_atomically() {
    let (_directory, store) = store().await;
    let created = create(&store).await;
    let claim_id = id();
    let claim_version_id = id();
    store
        .apply_claims(claim_request(
            &created,
            &claim_id,
            &claim_version_id,
            "Source claim",
        ))
        .await
        .unwrap();
    let assessment_id = id();
    let mut assessment = MeetingAssessmentApplyDto {
        id: assessment_id.clone(),
        claim_version_id,
        stage: MeetingAssessmentStage::Preliminary,
        attempt_number: 1,
        status: MeetingAssessmentStatus::Complete,
        supersedes_id: None,
        verdict: MeetingVerdict::Supported,
        confidence: MeetingConfidence::High,
        conclusion: vec![MeetingCitedStatementDto {
            text: "The available source supports the claim.".to_string(),
            citation_keys: vec!["missing".to_string()],
        }],
        support: vec![],
        contradiction: vec![],
        caveats: vec![],
        limitations: vec![],
        model_provider: "test".to_string(),
        model: "test-model".to_string(),
        model_version: None,
        usage: None,
        latency_ms: Some(100),
        started_at_ms: 2_000,
        completed_at_ms: 2_100,
        error: None,
        sources: vec![source(&id())],
        set_current: true,
    };
    let error = store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(assessment.clone()),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Validation(_)));
    let empty_artifact = store
        .get_artifact(MeetingGetRequest {
            meeting_id: created.meeting.id.clone(),
        })
        .await
        .unwrap()
        .artifact;
    assert!(empty_artifact.assessments.is_empty());

    assessment.conclusion[0].citation_keys = vec!["source-1".to_string()];
    assessment.sources.push(source(&id()));
    let error = store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(assessment.clone()),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Validation(_)));
    assert!(artifact(&store, &created.meeting.id)
        .await
        .assessments
        .is_empty());
    assessment.sources.pop();
    let response = store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(assessment.clone()),
        })
        .await
        .unwrap();
    let stored = response.assessment.unwrap();
    assert_eq!(stored.id, assessment_id);
    assert_eq!(stored.sources.len(), 1);
    assert!(stored.current);

    let mut reused_source_attempt = assessment;
    reused_source_attempt.id = id();
    reused_source_attempt.attempt_number = 2;
    reused_source_attempt.supersedes_id = Some(assessment_id.clone());
    reused_source_attempt.started_at_ms = 2_200;
    reused_source_attempt.completed_at_ms = 2_300;
    let error = store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(reused_source_attempt),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Conflict));
    let after_collision = artifact(&store, &created.meeting.id).await;
    assert_eq!(after_collision.assessments.len(), 1);
    assert_eq!(after_collision.assessments[0].id, assessment_id);
    assert!(after_collision.assessments[0].current);
}

#[tokio::test]
async fn operational_failure_is_not_an_assessment_but_unaddressed_evidence_can_be_unverified() {
    let (directory, store) = store().await;
    let created = create(&store).await;
    let claim_id = id();
    let claim_version_id = id();
    store
        .apply_claims(claim_request(
            &created,
            &claim_id,
            &claim_version_id,
            "Claim without retrievable evidence",
        ))
        .await
        .unwrap();

    let mut operational_failure = MeetingAssessmentApplyDto {
        id: id(),
        claim_version_id: claim_version_id.clone(),
        stage: MeetingAssessmentStage::Preliminary,
        attempt_number: 1,
        status: MeetingAssessmentStatus::Complete,
        supersedes_id: None,
        verdict: MeetingVerdict::Unverifiable,
        confidence: MeetingConfidence::Low,
        conclusion: vec![],
        support: vec![],
        contradiction: vec![],
        caveats: vec![],
        limitations: vec![],
        model_provider: "test".to_string(),
        model: "unavailable-model".to_string(),
        model_version: None,
        usage: None,
        latency_ms: Some(100),
        started_at_ms: 2_000,
        completed_at_ms: 2_100,
        error: Some(MeetingTypedErrorDto {
            code: "evidence_unavailable".to_string(),
            message: "No retrievable evidence was available; no factual finding was produced."
                .to_string(),
            retryable: false,
        }),
        sources: vec![],
        set_current: true,
    };

    let error = store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(operational_failure.clone()),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Validation(_)));

    operational_failure.id = id();
    operational_failure.status = MeetingAssessmentStatus::Failed;
    let error = store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(operational_failure),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Validation(_)));

    let research_job_id = id();
    let idempotency_key = format!("research-{claim_version_id}-operational-failure");
    let running = research_job(
        &claim_version_id,
        &research_job_id,
        &idempotency_key,
        MeetingJobStatus::Running,
        1,
    );
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(running.clone()),
            assessment: None,
        })
        .await
        .unwrap();
    let mut failed = running;
    failed.status = MeetingJobStatus::Failed;
    failed.attempt_count = 2;
    failed.completed_at_ms = Some(2_200);
    failed.error = Some(MeetingTypedErrorDto {
        code: "evidence_unavailable".to_string(),
        message: "Research did not return evidence.".to_string(),
        retryable: true,
    });
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(failed),
            assessment: None,
        })
        .await
        .unwrap();

    let mut context_source = source(&id());
    context_source.stance = MeetingEvidenceStance::Context;
    context_source.evidence_excerpt =
        "The retrieved overview discusses materials but gives no durability measurement."
            .to_string();
    let unverified = MeetingAssessmentApplyDto {
        id: id(),
        claim_version_id,
        stage: MeetingAssessmentStage::Preliminary,
        attempt_number: 2,
        status: MeetingAssessmentStatus::Complete,
        supersedes_id: None,
        verdict: MeetingVerdict::Unverifiable,
        confidence: MeetingConfidence::Low,
        conclusion: vec![MeetingCitedStatementDto {
            text: "The retrieved evidence does not address the claimed lifetime.".to_string(),
            citation_keys: vec![],
        }],
        support: vec![],
        contradiction: vec![],
        caveats: vec![],
        limitations: vec![MeetingCitedStatementDto {
            text: "The overview supplies no durability measurement.".to_string(),
            citation_keys: vec!["source-1".to_string()],
        }],
        model_provider: "test".to_string(),
        model: "deterministic-model".to_string(),
        model_version: None,
        usage: None,
        latency_ms: Some(100),
        started_at_ms: 2_300,
        completed_at_ms: 2_400,
        error: None,
        sources: vec![context_source],
        set_current: true,
    };
    let stored = store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(unverified),
        })
        .await
        .unwrap()
        .assessment
        .unwrap();
    assert_eq!(stored.verdict, MeetingVerdict::Unverifiable);
    assert_eq!(stored.confidence, MeetingConfidence::Low);
    assert!(stored.conclusion[0].citation_keys.is_empty());
    assert!(stored.error.is_none());

    drop(store);
    let reopened = MeetingStore::new(directory.path().to_path_buf()).unwrap();
    reopened.initialize().await.unwrap();
    let persisted = artifact(&reopened, &created.meeting.id).await;
    assert_eq!(persisted.assessments.len(), 1);
    assert_eq!(persisted.research_jobs.len(), 1);
    assert_eq!(persisted.research_jobs[0].status, MeetingJobStatus::Failed);
    assert!(persisted.assessments[0].error.is_none());
}

#[tokio::test]
async fn refined_result_atomically_replaces_stale_claims_and_replays_without_state_drift() {
    let (_directory, store) = store().await;
    let created = create(&store).await;
    let live_segment_id = id();
    store
        .apply_transcript(transcript_request(
            &created,
            &live_segment_id,
            1,
            "The live transcript says forty two units.",
        ))
        .await
        .unwrap();
    let claim_id = id();
    let claim_version_id = id();
    let mut anchored_claim = claim_request(
        &created,
        &claim_id,
        &claim_version_id,
        "The live transcript says forty two units.",
    );
    anchored_claim.claim_versions[0].segment_ids = vec![live_segment_id.clone()];
    store.apply_claims(anchored_claim).await.unwrap();
    let assessment_id = id();
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(assessment(
                &assessment_id,
                &claim_version_id,
                MeetingAssessmentStage::Preliminary,
                1,
                None,
                MeetingVerdict::Supported,
            )),
        })
        .await
        .unwrap();

    let job_id = id();
    let processing_job =
        refinement_job(&created, &job_id, MeetingRefinementJobStatus::Processing, 1);
    store
        .apply_refinement_job(MeetingRefinementJobApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: processing_job.clone(),
        })
        .await
        .unwrap();
    store
        .apply_refinement_job(MeetingRefinementJobApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: processing_job,
        })
        .await
        .unwrap();

    let refined_version_id = id();
    let refined_segment_id = id();
    let mut valid_refined_segment = segment(
        &refined_version_id,
        &refined_segment_id,
        &format!("refinement/{job_id}"),
        "refined-turn-1",
        1,
        (1_000, 1_500),
        "The refined transcript says 43 units.",
    );
    valid_refined_segment.replaced_live_segment_ids = vec![live_segment_id.clone()];
    let mut invalid_refined_segment = segment(
        &refined_version_id,
        &id(),
        &format!("refinement/{job_id}"),
        "refined-turn-2",
        2,
        (1_500, 1_800),
        "This row has an invalid source-ledger reference.",
    );
    invalid_refined_segment.replaced_live_segment_ids = vec![id()];
    let mut refined_version = version(
        &refined_version_id,
        MeetingTranscriptVersionKind::Refined,
        MeetingTranscriptVersionStatus::Complete,
        1,
    );
    refined_version.parent_version_id = Some(created.live_transcript_version.id.clone());
    refined_version.gateway_job_id = Some("opaque-refinement-job".to_string());
    refined_version.input_audio_checksum = Some("manifest-v1".to_string());
    refined_version.reconciliation_metadata = Some(serde_json::json!({
        "strategy": "timestamp_overlap",
        "sourceVersionId": created.live_transcript_version.id,
    }));
    let error = store
        .apply_refinement_result(MeetingRefinementResultApplyRequest {
            meeting_id: created.meeting.id.clone(),
            refinement_job_id: job_id.clone(),
            version: refined_version.clone(),
            segments: vec![valid_refined_segment.clone(), invalid_refined_segment],
            speaker_observations: vec![],
            mark_stale_claim_version_ids: vec![claim_version_id.clone()],
            replacement_claim_versions: vec![],
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::NotFound));
    let after_rollback = artifact(&store, &created.meeting.id).await;
    assert_eq!(after_rollback.transcript_versions.len(), 1);
    assert_eq!(after_rollback.transcript_segments.len(), 1);
    assert_eq!(
        after_rollback.meeting.canonical_transcript_version_id,
        Some(created.live_transcript_version.id.clone())
    );
    assert_eq!(
        after_rollback.claim_versions[0].lifecycle,
        MeetingClaimVersionLifecycle::Active
    );
    assert_eq!(
        after_rollback.refinement_jobs[0].status,
        MeetingRefinementJobStatus::Processing
    );

    let recovered = store
        .recover(MeetingRecoverRequest {
            reconcile_active_work: true,
        })
        .await
        .unwrap();
    assert_eq!(recovered.refinement_job_ids, vec![job_id.clone()]);
    assert_eq!(
        recovered.refinement_jobs[0].status,
        MeetingRefinementJobStatus::RetryWait
    );
    let mut retry_job =
        refinement_job(&created, &job_id, MeetingRefinementJobStatus::Processing, 2);
    retry_job.next_retry_at_ms = Some(3_000);
    store
        .apply_refinement_job(MeetingRefinementJobApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: retry_job,
        })
        .await
        .unwrap();

    let replacement_claim_version_id = id();
    let mut replacement_request = claim_request(
        &created,
        &claim_id,
        &replacement_claim_version_id,
        "The refined transcript says 43 units.",
    );
    let mut replacement = replacement_request.claim_versions.remove(0);
    replacement.status = MeetingClaimStatus::Rechecking;
    replacement.version_number = 2;
    replacement.predecessor_id = Some(claim_version_id.clone());
    replacement.source_transcript_version_id = Some(refined_version_id.clone());
    replacement.exact_quote = "The refined transcript says 43 units.".to_string();
    replacement.normalized_claim = "The refined transcript says 43 units.".to_string();
    replacement.segment_ids = vec![refined_segment_id.clone()];
    replacement.lifecycle = MeetingClaimVersionLifecycle::Rechecking;

    let mut invalid_replacement = replacement.clone();
    invalid_replacement.segment_ids = vec![id()];
    let replacement_error = store
        .apply_refinement_result(MeetingRefinementResultApplyRequest {
            meeting_id: created.meeting.id.clone(),
            refinement_job_id: job_id.clone(),
            version: refined_version.clone(),
            segments: vec![valid_refined_segment.clone()],
            speaker_observations: vec![],
            mark_stale_claim_version_ids: vec![claim_version_id.clone()],
            replacement_claim_versions: vec![invalid_replacement],
        })
        .await
        .unwrap_err();
    assert!(matches!(replacement_error, MeetingStoreError::NotFound));
    let replacement_rollback = artifact(&store, &created.meeting.id).await;
    assert_eq!(replacement_rollback.transcript_versions.len(), 1);
    assert_eq!(replacement_rollback.claim_versions.len(), 1);
    assert_eq!(
        replacement_rollback.claim_versions[0].lifecycle,
        MeetingClaimVersionLifecycle::Active
    );
    assert_eq!(
        replacement_rollback.refinement_jobs[0].status,
        MeetingRefinementJobStatus::Processing
    );

    let refined_observation_id = id();
    let valid_request = MeetingRefinementResultApplyRequest {
        meeting_id: created.meeting.id.clone(),
        refinement_job_id: job_id.clone(),
        version: refined_version,
        segments: vec![valid_refined_segment],
        speaker_observations: vec![MeetingSpeakerObservationUpsertDto {
            id: refined_observation_id,
            transcript_version_id: refined_version_id.clone(),
            speaker_id: None,
            provider: "test-transcriber".to_string(),
            provider_namespace: format!("refinement/{job_id}"),
            provider_speaker_label: "A".to_string(),
            confidence: Some(0.9),
            ambiguous: true,
            revision_number: 1,
            source_hint: Some(MeetingAudioSourceKind::Mixed),
        }],
        mark_stale_claim_version_ids: vec![claim_version_id.clone()],
        replacement_claim_versions: vec![replacement],
    };
    store
        .apply_refinement_result(valid_request.clone())
        .await
        .unwrap();
    store.apply_refinement_result(valid_request).await.unwrap();
    let artifact = artifact(&store, &created.meeting.id).await;
    assert_eq!(
        artifact.meeting.canonical_transcript_version_id,
        Some(refined_version_id.clone())
    );
    assert_eq!(
        artifact.meeting.refinement_status,
        MeetingRefinementStatus::Complete
    );
    assert_eq!(artifact.transcript_versions.len(), 2);
    let live_version = artifact
        .transcript_versions
        .iter()
        .find(|value| value.kind == MeetingTranscriptVersionKind::Live)
        .unwrap();
    assert_eq!(live_version.id, created.live_transcript_version.id);
    let refined_version = artifact
        .transcript_versions
        .iter()
        .find(|value| value.kind == MeetingTranscriptVersionKind::Refined)
        .unwrap();
    assert_eq!(
        refined_version.parent_version_id.as_deref(),
        Some(created.live_transcript_version.id.as_str())
    );
    let stored_live_segment = artifact
        .transcript_segments
        .iter()
        .find(|value| value.id == live_segment_id)
        .unwrap();
    assert_eq!(
        stored_live_segment.text,
        "The live transcript says forty two units."
    );
    let stored_refined_segment = artifact
        .transcript_segments
        .iter()
        .find(|value| value.id == refined_segment_id)
        .unwrap();
    assert_eq!(
        stored_refined_segment.replaced_live_segment_ids,
        vec![live_segment_id]
    );
    assert_eq!(artifact.speaker_observations.len(), 1);
    assert_eq!(
        artifact.speaker_observations[0].provider_namespace,
        format!("refinement/{job_id}")
    );
    assert_eq!(artifact.claims[0].status, MeetingClaimStatus::Rechecking);
    assert_eq!(
        artifact.claims[0].current_claim_version_id.as_deref(),
        Some(replacement_claim_version_id.as_str())
    );
    assert_eq!(artifact.claim_versions.len(), 2);
    let original_claim_version = artifact
        .claim_versions
        .iter()
        .find(|version| version.id == claim_version_id)
        .unwrap();
    assert_eq!(
        original_claim_version.lifecycle,
        MeetingClaimVersionLifecycle::Superseded
    );
    let replacement_claim_version = artifact
        .claim_versions
        .iter()
        .find(|version| version.id == replacement_claim_version_id)
        .unwrap();
    assert_eq!(
        replacement_claim_version.lifecycle,
        MeetingClaimVersionLifecycle::Rechecking
    );
    assert_eq!(artifact.assessments.len(), 1);
    assert_eq!(artifact.assessments[0].id, assessment_id);
    assert_eq!(artifact.assessments[0].claim_version_id, claim_version_id);
    assert_eq!(
        artifact.refinement_jobs[0].status,
        MeetingRefinementJobStatus::Complete
    );
    assert_eq!(artifact.refinement_jobs[0].attempt_count, 2);
}

#[tokio::test]
async fn ordered_refinement_manifest_timeline_mapping_and_interrupted_audio_survive_recovery() {
    let (_directory, store) = store().await;
    let created = create(&store).await;
    let refinement_job_id = id();
    store
        .apply_refinement_job(MeetingRefinementJobApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: refinement_job(
                &created,
                &refinement_job_id,
                MeetingRefinementJobStatus::Queued,
                0,
            ),
        })
        .await
        .unwrap();
    let first_asset_id = id();
    let second_asset_id = id();
    let audio = store
        .apply_audio(MeetingAudioApplyRequest {
            meeting_id: created.meeting.id.clone(),
            assets: vec![
                MeetingAudioAssetUpsertDto {
                    id: second_asset_id.clone(),
                    source_kind: MeetingAudioSourceKind::Mixed,
                    timeline_part: 1,
                    file_name: "part-1.wav".to_string(),
                    format: "wav".to_string(),
                    sample_rate: 48_000,
                    channels: 2,
                    timeline_start_ms: 3_000,
                    timeline_end_ms: Some(4_000),
                    duration_ms: Some(1_000),
                    bytes: Some(192_044),
                    checksum: Some("audio-part-1".to_string()),
                    status: MeetingAudioAssetStatus::Finalized,
                },
                MeetingAudioAssetUpsertDto {
                    id: first_asset_id.clone(),
                    source_kind: MeetingAudioSourceKind::Mixed,
                    timeline_part: 0,
                    file_name: "part-0.wav".to_string(),
                    format: "wav".to_string(),
                    sample_rate: 48_000,
                    channels: 2,
                    timeline_start_ms: 1_000,
                    timeline_end_ms: Some(2_000),
                    duration_ms: Some(1_000),
                    bytes: Some(192_044),
                    checksum: Some("audio-part-0".to_string()),
                    status: MeetingAudioAssetStatus::Finalized,
                },
            ],
            replace_refinement_manifest_for_job_id: Some(refinement_job_id.clone()),
            refinement_inputs: vec![
                MeetingRefinementInputUpsertDto {
                    refinement_job_id: refinement_job_id.clone(),
                    part_index: 1,
                    audio_asset_id: second_asset_id.clone(),
                    source_kind: MeetingAudioSourceKind::Mixed,
                    checksum: "audio-part-1".to_string(),
                    meeting_start_ms: 3_000,
                    meeting_end_ms: 4_000,
                    provider_start_ms: 1_000,
                    provider_end_ms: 2_000,
                    manifest_checksum: "manifest-v1".to_string(),
                },
                MeetingRefinementInputUpsertDto {
                    refinement_job_id: refinement_job_id.clone(),
                    part_index: 0,
                    audio_asset_id: first_asset_id.clone(),
                    source_kind: MeetingAudioSourceKind::Mixed,
                    checksum: "audio-part-0".to_string(),
                    meeting_start_ms: 1_000,
                    meeting_end_ms: 2_000,
                    provider_start_ms: 0,
                    provider_end_ms: 1_000,
                    manifest_checksum: "manifest-v1".to_string(),
                },
            ],
        })
        .await
        .unwrap();
    assert_eq!(
        audio
            .assets
            .iter()
            .map(|asset| asset.timeline_part)
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert!(audio.assets.iter().all(|asset| {
        asset
            .relative_path
            .starts_with(&format!("audio/{}/", created.meeting.id))
    }));
    assert_eq!(
        audio
            .refinement_inputs
            .iter()
            .map(|input| input.part_index)
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(audio.refinement_inputs[0].meeting_start_ms, 1_000);
    assert_eq!(audio.refinement_inputs[0].provider_start_ms, 0);
    assert_eq!(audio.refinement_inputs[1].meeting_start_ms, 3_000);
    assert_eq!(audio.refinement_inputs[1].provider_start_ms, 1_000);

    let events = vec![
        MeetingTimelineEventUpsertDto {
            id: id(),
            kind: MeetingTimelineEventKind::Wake,
            start_ms: 3_000,
            end_ms: None,
            source_kind: None,
            provider_namespace: None,
            metadata: None,
        },
        MeetingTimelineEventUpsertDto {
            id: id(),
            kind: MeetingTimelineEventKind::Pause,
            start_ms: 2_000,
            end_ms: Some(3_000),
            source_kind: Some(MeetingAudioSourceKind::Mixed),
            provider_namespace: Some("live/session-1".to_string()),
            metadata: Some(serde_json::json!({"reason": "user"})),
        },
        MeetingTimelineEventUpsertDto {
            id: id(),
            kind: MeetingTimelineEventKind::Sleep,
            start_ms: 2_500,
            end_ms: Some(2_900),
            source_kind: None,
            provider_namespace: None,
            metadata: None,
        },
        MeetingTimelineEventUpsertDto {
            id: id(),
            kind: MeetingTimelineEventKind::CaptureGap,
            start_ms: 4_000,
            end_ms: Some(4_100),
            source_kind: Some(MeetingAudioSourceKind::System),
            provider_namespace: None,
            metadata: Some(serde_json::json!({"device": "fixture"})),
        },
        MeetingTimelineEventUpsertDto {
            id: id(),
            kind: MeetingTimelineEventKind::SttReconnectGap,
            start_ms: 4_100,
            end_ms: Some(4_250),
            source_kind: Some(MeetingAudioSourceKind::Mixed),
            provider_namespace: Some("live/session-2".to_string()),
            metadata: None,
        },
    ];
    let timeline = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: events.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        timeline
            .events
            .iter()
            .map(|event| event.start_ms)
            .collect::<Vec<_>>(),
        vec![2_000, 2_500, 3_000, 4_000, 4_100]
    );
    let duplicate = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: events.clone(),
        })
        .await
        .unwrap();
    assert_eq!(duplicate.events.len(), events.len());
    let mut conflicting = events[0].clone();
    conflicting.start_ms = 3_001;
    let conflict = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![conflicting],
        })
        .await
        .unwrap_err();
    assert!(matches!(conflict, MeetingStoreError::Conflict));

    let recording_asset_id = id();
    store
        .apply_audio(MeetingAudioApplyRequest {
            meeting_id: created.meeting.id.clone(),
            assets: vec![MeetingAudioAssetUpsertDto {
                id: recording_asset_id.clone(),
                source_kind: MeetingAudioSourceKind::Mixed,
                timeline_part: 2,
                file_name: "part-2.wav.part".to_string(),
                format: "pcm".to_string(),
                sample_rate: 48_000,
                channels: 2,
                timeline_start_ms: 4_250,
                timeline_end_ms: None,
                duration_ms: None,
                bytes: Some(9_600),
                checksum: None,
                status: MeetingAudioAssetStatus::Recording,
            }],
            replace_refinement_manifest_for_job_id: None,
            refinement_inputs: vec![],
        })
        .await
        .unwrap();
    let recovered = store
        .recover(MeetingRecoverRequest {
            reconcile_active_work: true,
        })
        .await
        .unwrap();
    assert_eq!(
        recovered.interrupted_meeting_ids,
        vec![created.meeting.id.clone()]
    );
    let recovered_artifact = artifact(&store, &created.meeting.id).await;
    assert_eq!(
        recovered_artifact.meeting.status,
        MeetingLifecycleStatus::Interrupted
    );
    assert_eq!(
        recovered_artifact.meeting.capture_status,
        MeetingCaptureStatus::Interrupted
    );
    assert_eq!(recovered_artifact.timeline_events.len(), events.len());
    let interrupted_asset = recovered_artifact
        .audio_assets
        .iter()
        .find(|asset| asset.id == recording_asset_id)
        .unwrap();
    assert_eq!(
        interrupted_asset.status,
        MeetingAudioAssetStatus::Interrupted
    );
    let second_recovery = store
        .recover(MeetingRecoverRequest {
            reconcile_active_work: true,
        })
        .await
        .unwrap();
    assert!(second_recovery.interrupted_meeting_ids.is_empty());
}

#[tokio::test]
async fn recovery_scans_are_read_only_and_startup_reconciliation_transitions_active_work_once() {
    let request: MeetingRecoverRequest = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(!request.reconcile_active_work);

    let (_directory, store) = store().await;
    let created = create(&store).await;
    let claim_id = id();
    let claim_version_id = id();
    store
        .apply_claims(claim_request(
            &created,
            &claim_id,
            &claim_version_id,
            "A recovery fixture claim.",
        ))
        .await
        .unwrap();

    let running_research_id = id();
    let pending_research_id = id();
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(research_job(
                &claim_version_id,
                &running_research_id,
                "recovery-running-research",
                MeetingJobStatus::Running,
                1,
            )),
            assessment: None,
        })
        .await
        .unwrap();
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(research_job(
                &claim_version_id,
                &pending_research_id,
                "recovery-pending-research",
                MeetingJobStatus::Pending,
                0,
            )),
            assessment: None,
        })
        .await
        .unwrap();

    let processing_refinement_id = id();
    let queued_refinement_id = id();
    let mut processing_refinement = refinement_job(
        &created,
        &processing_refinement_id,
        MeetingRefinementJobStatus::Processing,
        1,
    );
    processing_refinement.idempotency_key = "recovery-processing-refinement".to_string();
    store
        .apply_refinement_job(MeetingRefinementJobApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: processing_refinement,
        })
        .await
        .unwrap();
    let mut queued_refinement = refinement_job(
        &created,
        &queued_refinement_id,
        MeetingRefinementJobStatus::Queued,
        0,
    );
    queued_refinement.idempotency_key = "recovery-queued-refinement".to_string();
    store
        .apply_refinement_job(MeetingRefinementJobApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: queued_refinement,
        })
        .await
        .unwrap();

    let cleanup_meeting = create(&store).await;
    let cleanup_job = store
        .delete_meeting(MeetingDeleteRequest {
            meeting_id: cleanup_meeting.meeting.id,
        })
        .await
        .unwrap()
        .cleanup_job;

    let first_scan = store
        .recover(MeetingRecoverRequest::default())
        .await
        .unwrap();
    assert!(first_scan.interrupted_meeting_ids.is_empty());
    assert!(first_scan.research_job_ids.is_empty());
    assert!(first_scan.refinement_job_ids.is_empty());
    assert_eq!(first_scan.cleanup_job_ids, vec![cleanup_job.id.clone()]);
    let unchanged = artifact(&store, &created.meeting.id).await;
    assert_eq!(unchanged.meeting.status, MeetingLifecycleStatus::Recording);
    assert_eq!(
        unchanged
            .research_jobs
            .iter()
            .find(|job| job.id == running_research_id)
            .unwrap()
            .status,
        MeetingJobStatus::Running
    );
    assert_eq!(
        unchanged
            .refinement_jobs
            .iter()
            .find(|job| job.id == processing_refinement_id)
            .unwrap()
            .status,
        MeetingRefinementJobStatus::Processing
    );

    store
        .confirm_cleanup(MeetingCleanupConfirmRequest {
            cleanup_job_id: cleanup_job.id.clone(),
            local_status: MeetingCleanupStatus::Running,
            gateway_status: MeetingCleanupStatus::Running,
            provider_status: MeetingCleanupStatus::Running,
            error: None,
        })
        .await
        .unwrap();
    let running_scan = store
        .recover(MeetingRecoverRequest::default())
        .await
        .unwrap();
    assert!(running_scan.interrupted_meeting_ids.is_empty());
    assert!(running_scan.research_job_ids.is_empty());
    assert!(running_scan.refinement_job_ids.is_empty());
    assert!(running_scan.cleanup_job_ids.is_empty());

    let startup_recovery = store
        .recover(MeetingRecoverRequest {
            reconcile_active_work: true,
        })
        .await
        .unwrap();
    assert_eq!(
        startup_recovery.interrupted_meeting_ids,
        vec![created.meeting.id.clone()]
    );
    assert_eq!(startup_recovery.research_jobs.len(), 2);
    assert_eq!(startup_recovery.refinement_jobs.len(), 2);
    assert_eq!(startup_recovery.cleanup_jobs.len(), 1);
    let recovered_running_research = startup_recovery
        .research_jobs
        .iter()
        .find(|job| job.id == running_research_id)
        .unwrap();
    assert_eq!(
        recovered_running_research.status,
        MeetingJobStatus::RetryWait
    );
    let recovered_processing_refinement = startup_recovery
        .refinement_jobs
        .iter()
        .find(|job| job.id == processing_refinement_id)
        .unwrap();
    assert_eq!(
        recovered_processing_refinement.status,
        MeetingRefinementJobStatus::RetryWait
    );
    assert_eq!(
        startup_recovery.cleanup_jobs[0].local_status,
        MeetingCleanupStatus::RetryWait
    );
    assert_eq!(
        startup_recovery.cleanup_jobs[0].gateway_status,
        MeetingCleanupStatus::RetryWait
    );
    assert_eq!(
        startup_recovery.cleanup_jobs[0].provider_status,
        MeetingCleanupStatus::RetryWait
    );
    let recovered_artifact = artifact(&store, &created.meeting.id).await;
    assert_eq!(
        recovered_artifact.meeting.status,
        MeetingLifecycleStatus::Interrupted
    );
    let meeting_updated_at_ms = recovered_artifact.meeting.updated_at_ms;
    let research_updated_at_ms = recovered_running_research.updated_at_ms;
    let refinement_updated_at_ms = recovered_processing_refinement.updated_at_ms;
    let cleanup_updated_at_ms = startup_recovery.cleanup_jobs[0].updated_at_ms;

    let repeated_startup_recovery = store
        .recover(MeetingRecoverRequest {
            reconcile_active_work: true,
        })
        .await
        .unwrap();
    assert!(repeated_startup_recovery.interrupted_meeting_ids.is_empty());
    assert_eq!(
        repeated_startup_recovery
            .research_jobs
            .iter()
            .find(|job| job.id == running_research_id)
            .unwrap()
            .updated_at_ms,
        research_updated_at_ms
    );
    assert_eq!(
        repeated_startup_recovery
            .refinement_jobs
            .iter()
            .find(|job| job.id == processing_refinement_id)
            .unwrap()
            .updated_at_ms,
        refinement_updated_at_ms
    );
    assert_eq!(
        repeated_startup_recovery.cleanup_jobs[0].updated_at_ms,
        cleanup_updated_at_ms
    );
    assert_eq!(
        artifact(&store, &created.meeting.id)
            .await
            .meeting
            .updated_at_ms,
        meeting_updated_at_ms
    );
    let periodic_after_startup = store
        .recover(MeetingRecoverRequest::default())
        .await
        .unwrap();
    assert_eq!(
        periodic_after_startup.research_job_ids,
        vec![running_research_id]
    );
    assert_eq!(
        periodic_after_startup.refinement_job_ids,
        vec![processing_refinement_id]
    );
    assert_eq!(periodic_after_startup.cleanup_job_ids, vec![cleanup_job.id]);
}

#[tokio::test]
async fn pause_and_sleep_timeline_intervals_close_once_and_reject_other_mutations() {
    let (_directory, store) = store().await;
    let created = create(&store).await;
    let pause_id = id();
    let open_pause = MeetingTimelineEventUpsertDto {
        id: pause_id.clone(),
        kind: MeetingTimelineEventKind::Pause,
        start_ms: 2_000,
        end_ms: None,
        source_kind: Some(MeetingAudioSourceKind::Mixed),
        provider_namespace: Some("main/capture".to_string()),
        metadata: Some(serde_json::json!({"owner": "main"})),
    };
    let opened = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![open_pause.clone()],
        })
        .await
        .unwrap();
    assert_eq!(opened.events[0].end_ms, None);

    let mut closed_pause = open_pause.clone();
    closed_pause.end_ms = Some(2_750);
    let closed = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![closed_pause.clone()],
        })
        .await
        .unwrap();
    assert_eq!(closed.events[0].end_ms, Some(2_750));
    let idempotent = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![closed_pause.clone()],
        })
        .await
        .unwrap();
    assert_eq!(idempotent.events.len(), 1);
    assert_eq!(idempotent.events[0].end_ms, Some(2_750));

    let mut second_close = closed_pause.clone();
    second_close.end_ms = Some(2_800);
    let error = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![second_close],
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Conflict));
    let error = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![open_pause],
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Conflict));
    let mut changed_metadata = closed_pause;
    changed_metadata.metadata = Some(serde_json::json!({"owner": "renderer"}));
    let error = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![changed_metadata],
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Conflict));

    let sleep_id = id();
    let open_sleep = MeetingTimelineEventUpsertDto {
        id: sleep_id.clone(),
        kind: MeetingTimelineEventKind::Sleep,
        start_ms: 3_000,
        end_ms: None,
        source_kind: None,
        provider_namespace: Some("main/power".to_string()),
        metadata: None,
    };
    store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![open_sleep.clone()],
        })
        .await
        .unwrap();
    let mut closed_sleep = open_sleep;
    closed_sleep.end_ms = Some(3_500);
    let closed = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![closed_sleep],
        })
        .await
        .unwrap();
    assert_eq!(closed.events.len(), 2);
    assert_eq!(
        closed
            .events
            .iter()
            .find(|event| event.id == sleep_id)
            .unwrap()
            .end_ms,
        Some(3_500)
    );

    let gap_id = id();
    let open_gap = MeetingTimelineEventUpsertDto {
        id: gap_id,
        kind: MeetingTimelineEventKind::CaptureGap,
        start_ms: 4_000,
        end_ms: None,
        source_kind: Some(MeetingAudioSourceKind::System),
        provider_namespace: None,
        metadata: None,
    };
    store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![open_gap.clone()],
        })
        .await
        .unwrap();
    let mut closed_gap = open_gap;
    closed_gap.end_ms = Some(4_100);
    let error = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![closed_gap],
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Conflict));
    let persisted = artifact(&store, &created.meeting.id).await;
    assert_eq!(
        persisted
            .timeline_events
            .iter()
            .find(|event| event.id == pause_id)
            .unwrap()
            .end_ms,
        Some(2_750)
    );
}

#[tokio::test]
async fn rejects_invalid_enums_identifiers_oversized_content_and_untrusted_urls_atomically() {
    let (_directory, store) = store().await;
    let mut oversized_create = create_request();
    oversized_create.title = Some("x".repeat(513));
    let error = store.create_meeting(oversized_create).await.unwrap_err();
    assert!(matches!(error, MeetingStoreError::Validation(_)));
    assert!(store
        .list_meetings(MeetingListRequest::default())
        .await
        .unwrap()
        .items
        .is_empty());

    let created = create(&store).await;
    let invalid_enum = serde_json::from_value::<MeetingUpdateRequest>(serde_json::json!({
        "meetingId": created.meeting.id,
        "title": null,
        "status": "verified_true",
        "endedAtMs": null,
        "captureStatus": null,
        "refinementStatus": null,
        "researchStatus": null,
        "error": null,
        "clearError": false
    }));
    assert!(invalid_enum.is_err());
    let invalid_id = store
        .get_artifact(MeetingGetRequest {
            meeting_id: "../../meeting.db".to_string(),
        })
        .await
        .unwrap_err();
    assert!(matches!(invalid_id, MeetingStoreError::Validation(_)));

    let mut oversized_segment = segment(
        &created.live_transcript_version.id,
        &id(),
        "live/session-1",
        "oversized-turn",
        1,
        (1_000, 1_500),
        &"x".repeat(64 * 1024 + 1),
    );
    oversized_segment.state = MeetingTranscriptSegmentState::Final;
    let error = store
        .apply_transcript(MeetingTranscriptApplyRequest {
            meeting_id: created.meeting.id.clone(),
            version: version(
                &created.live_transcript_version.id,
                MeetingTranscriptVersionKind::Live,
                MeetingTranscriptVersionStatus::Complete,
                1,
            ),
            segments: vec![oversized_segment],
            speaker_observations: vec![],
            promote_canonical: true,
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Validation(_)));
    let partial_error = store
        .apply_transcript(MeetingTranscriptApplyRequest {
            meeting_id: created.meeting.id.clone(),
            version: version(
                &created.live_transcript_version.id,
                MeetingTranscriptVersionKind::Live,
                MeetingTranscriptVersionStatus::Complete,
                1,
            ),
            segments: vec![MeetingTranscriptSegmentUpsertDto {
                state: MeetingTranscriptSegmentState::Partial,
                ..segment(
                    &created.live_transcript_version.id,
                    &id(),
                    "live/session-1",
                    "partial-turn",
                    2,
                    (1_500, 1_700),
                    "Transient text",
                )
            }],
            speaker_observations: vec![],
            promote_canonical: true,
        })
        .await
        .unwrap_err();
    assert!(matches!(partial_error, MeetingStoreError::Validation(_)));
    assert!(artifact(&store, &created.meeting.id)
        .await
        .transcript_segments
        .is_empty());

    let metadata_error = store
        .apply_timeline(MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![MeetingTimelineEventUpsertDto {
                id: id(),
                kind: MeetingTimelineEventKind::CaptureGap,
                start_ms: 1_000,
                end_ms: Some(1_100),
                source_kind: Some(MeetingAudioSourceKind::System),
                provider_namespace: None,
                metadata: Some(serde_json::json!({"payload": "x".repeat(256 * 1024)})),
            }],
        })
        .await
        .unwrap_err();
    assert!(matches!(metadata_error, MeetingStoreError::Validation(_)));

    let claim_id = id();
    let claim_version_id = id();
    store
        .apply_claims(claim_request(
            &created,
            &claim_id,
            &claim_version_id,
            "A claim with an untrusted source URL.",
        ))
        .await
        .unwrap();
    let mut invalid_source_assessment = assessment(
        &id(),
        &claim_version_id,
        MeetingAssessmentStage::Preliminary,
        1,
        None,
        MeetingVerdict::Unverifiable,
    );
    invalid_source_assessment.sources[0].url = "file:///etc/passwd".to_string();
    let error = store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: None,
            assessment: Some(invalid_source_assessment),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Validation(_)));
    assert!(artifact(&store, &created.meeting.id)
        .await
        .assessments
        .is_empty());
}

#[tokio::test]
async fn rejects_audio_path_traversal_and_recovers_then_tombstones_meetings() {
    let (_directory, store) = store().await;
    let created = create(&store).await;
    let segment_id = id();
    store
        .apply_transcript(transcript_request(
            &created,
            &segment_id,
            1,
            "Claim-bearing transcript",
        ))
        .await
        .unwrap();
    let claim_id = id();
    let claim_version_id = id();
    let mut claim = claim_request(
        &created,
        &claim_id,
        &claim_version_id,
        "Claim-bearing transcript",
    );
    claim.claim_versions[0].segment_ids = vec![segment_id];
    store.apply_claims(claim).await.unwrap();
    let research_job_id = id();
    store
        .apply_research(MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(MeetingResearchJobUpsertDto {
                id: research_job_id.clone(),
                claim_version_id,
                stage: MeetingAssessmentStage::Preliminary,
                gateway_job_id: None,
                idempotency_key: format!("research-{research_job_id}"),
                status: MeetingJobStatus::Running,
                attempt_count: 1,
                next_retry_at_ms: None,
                started_at_ms: Some(2_000),
                completed_at_ms: None,
                error: None,
            }),
            assessment: None,
        })
        .await
        .unwrap();
    let refinement_job_id = id();
    store
        .apply_refinement_job(MeetingRefinementJobApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: MeetingRefinementJobUpsertDto {
                id: refinement_job_id.clone(),
                source_transcript_version_id: created.live_transcript_version.id.clone(),
                input_manifest_checksum: "manifest-checksum".to_string(),
                provider: "test".to_string(),
                model: "test-model".to_string(),
                gateway_job_id: None,
                idempotency_key: format!("refinement-{refinement_job_id}"),
                status: MeetingRefinementJobStatus::Processing,
                attempt_count: 1,
                next_retry_at_ms: None,
                usage: None,
                latency_ms: None,
                started_at_ms: None,
                completed_at_ms: None,
                error: None,
            },
        })
        .await
        .unwrap();
    let audio_asset_id = id();
    store
        .apply_audio(MeetingAudioApplyRequest {
            meeting_id: created.meeting.id.clone(),
            assets: vec![MeetingAudioAssetUpsertDto {
                id: audio_asset_id.clone(),
                source_kind: MeetingAudioSourceKind::Mixed,
                timeline_part: 0,
                file_name: "part-0.wav".to_string(),
                format: "wav".to_string(),
                sample_rate: 48_000,
                channels: 2,
                timeline_start_ms: 1_000,
                timeline_end_ms: Some(2_000),
                duration_ms: Some(1_000),
                bytes: Some(100),
                checksum: Some("audio-checksum".to_string()),
                status: MeetingAudioAssetStatus::Finalized,
            }],
            replace_refinement_manifest_for_job_id: Some(refinement_job_id.clone()),
            refinement_inputs: vec![MeetingRefinementInputUpsertDto {
                refinement_job_id: refinement_job_id.clone(),
                part_index: 0,
                audio_asset_id,
                source_kind: MeetingAudioSourceKind::Mixed,
                checksum: "audio-checksum".to_string(),
                meeting_start_ms: 1_000,
                meeting_end_ms: 2_000,
                provider_start_ms: 0,
                provider_end_ms: 1_000,
                manifest_checksum: "manifest-checksum".to_string(),
            }],
        })
        .await
        .unwrap();
    let error = store
        .apply_audio(MeetingAudioApplyRequest {
            meeting_id: created.meeting.id.clone(),
            assets: vec![MeetingAudioAssetUpsertDto {
                id: id(),
                source_kind: MeetingAudioSourceKind::Mixed,
                timeline_part: 0,
                file_name: "../outside.wav".to_string(),
                format: "wav".to_string(),
                sample_rate: 48_000,
                channels: 2,
                timeline_start_ms: 1_000,
                timeline_end_ms: Some(2_000),
                duration_ms: Some(1_000),
                bytes: Some(100),
                checksum: Some("checksum".to_string()),
                status: MeetingAudioAssetStatus::Finalized,
            }],
            replace_refinement_manifest_for_job_id: None,
            refinement_inputs: vec![],
        })
        .await
        .unwrap_err();
    assert!(matches!(error, MeetingStoreError::Validation(_)));

    let recovered = store
        .recover(MeetingRecoverRequest {
            reconcile_active_work: true,
        })
        .await
        .unwrap();
    assert_eq!(
        recovered.interrupted_meeting_ids,
        vec![created.meeting.id.clone()]
    );
    assert_eq!(
        recovered.refinement_job_ids,
        vec![refinement_job_id.clone()]
    );
    assert_eq!(recovered.refinement_jobs[0].id, refinement_job_id);
    assert_eq!(recovered.research_job_ids, vec![research_job_id.clone()]);
    assert_eq!(recovered.research_jobs[0].id, research_job_id);
    let deleted = store
        .delete_meeting(MeetingDeleteRequest {
            meeting_id: created.meeting.id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(deleted.cleanup_job.relative_audio_paths.len(), 1);
    assert!(store
        .get_artifact(MeetingGetRequest {
            meeting_id: created.meeting.id.clone(),
        })
        .await
        .is_err());
    let cleanup_recovery = store
        .recover(MeetingRecoverRequest::default())
        .await
        .unwrap();
    assert_eq!(
        cleanup_recovery.cleanup_job_ids,
        vec![deleted.cleanup_job.id.clone()]
    );
    assert_eq!(
        cleanup_recovery.cleanup_jobs[0].meeting_id,
        created.meeting.id
    );
    let retryable_cleanup = store
        .confirm_cleanup(MeetingCleanupConfirmRequest {
            cleanup_job_id: deleted.cleanup_job.id.clone(),
            local_status: MeetingCleanupStatus::Complete,
            gateway_status: MeetingCleanupStatus::RetryWait,
            provider_status: MeetingCleanupStatus::Failed,
            error: Some(MeetingTypedErrorDto {
                code: "remote_cleanup_pending".to_string(),
                message: "Remote cleanup will be retried".to_string(),
                retryable: true,
            }),
        })
        .await
        .unwrap();
    assert!(!retryable_cleanup.records_removed);
    let retryable_job = retryable_cleanup.cleanup_job.unwrap();
    assert_eq!(retryable_job.attempt_count, 1);
    assert_eq!(
        retryable_job.gateway_status,
        MeetingCleanupStatus::RetryWait
    );
    assert_eq!(
        retryable_job.last_error.unwrap().code,
        "remote_cleanup_pending"
    );
    let retry_recovery = store
        .recover(MeetingRecoverRequest::default())
        .await
        .unwrap();
    assert_eq!(
        retry_recovery.cleanup_job_ids,
        vec![deleted.cleanup_job.id.clone()]
    );
    let confirmed = store
        .confirm_cleanup(MeetingCleanupConfirmRequest {
            cleanup_job_id: deleted.cleanup_job.id,
            local_status: MeetingCleanupStatus::Unavailable,
            gateway_status: MeetingCleanupStatus::Unavailable,
            provider_status: MeetingCleanupStatus::Unavailable,
            error: None,
        })
        .await
        .unwrap();
    assert!(confirmed.records_removed);
    assert!(confirmed.cleanup_job.is_none());
}
