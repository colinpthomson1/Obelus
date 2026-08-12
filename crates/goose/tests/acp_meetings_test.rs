#![recursion_limit = "256"]

use goose::acp::server::{
    AcpBuiltinSelection, AcpProviderFactory, GooseAcpAgent, GooseAcpAgentOptions,
};
use goose::agents::GoosePlatform;
use goose::custom_requests::*;
use serial_test::serial;
use std::sync::Arc;
use uuid::Uuid;

fn id() -> String {
    Uuid::now_v7().to_string()
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

async fn custom<Request, Response>(
    agent: &GooseAcpAgent,
    method: &str,
    request: Request,
) -> Response
where
    Request: serde::Serialize,
    Response: serde::de::DeserializeOwned,
{
    let value = agent
        .dispatch_custom_request(method, serde_json::to_value(request).unwrap())
        .await
        .unwrap_or_else(|error| panic!("{method} failed: {error:?}"));
    serde_json::from_value(value).unwrap()
}

#[tokio::test(flavor = "current_thread")]
#[serial]
async fn meeting_custom_methods_round_trip_storage_and_recovery() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().to_string_lossy().to_string();
    let _environment = env_lock::lock_env([
        ("GOOSE_PATH_ROOT", Some(root_path.as_str())),
        ("GOOSE_DISABLE_KEYRING", Some("1")),
    ]);
    let provider_factory: AcpProviderFactory = Arc::new(|_, _, _| {
        Box::pin(async {
            Err(anyhow::anyhow!(
                "provider is not used by meeting storage tests"
            ))
        })
    });
    let agent = GooseAcpAgent::new(GooseAcpAgentOptions {
        provider_factory,
        builtin_selection: AcpBuiltinSelection::default(),
        data_dir: root.path().to_path_buf(),
        config_dir: root.path().to_path_buf(),
        disable_session_naming: true,
        goose_platform: GoosePlatform::GooseCli,
        additional_source_roots: vec![],
        scheduler: None,
    })
    .await
    .unwrap();
    let speaker_id = id();
    let created: MeetingCreateResponse = custom(
        &agent,
        "_goose/unstable/meetings/create",
        MeetingCreateRequest {
            title: Some("ACP storage round trip".to_string()),
            artifact_type: MeetingArtifactType::Meeting,
            mode: MeetingMode::Call,
            started_at_ms: 1_000,
            capture_config: MeetingCaptureConfigDto {
                live_strategy: MeetingLiveStrategy::MixedDiarized,
                microphone_device_id: None,
                system_audio_enabled: true,
                exact_speaker_count: Some(1),
            },
            initial_speakers: vec![MeetingSpeakerInputDto {
                id: Some(speaker_id.clone()),
                default_label: "Speaker 1".to_string(),
                display_name: Some("Host".to_string()),
                display_name_source: Some("manual".to_string()),
                manual_assignment_lock: true,
                source_hint: Some(MeetingAudioSourceKind::Microphone),
            }],
        },
    )
    .await;
    let invalid_enum = agent
        .dispatch_custom_request(
            "_goose/unstable/meetings/update",
            serde_json::json!({
                "meetingId": created.meeting.id.clone(),
                "title": null,
                "status": "truth_score_complete",
                "endedAtMs": null,
                "captureStatus": null,
                "refinementStatus": null,
                "researchStatus": null,
                "error": null,
                "clearError": false
            }),
        )
        .await;
    assert!(invalid_enum.is_err());
    let updated: MeetingUpdateResponse = custom(
        &agent,
        "_goose/unstable/meetings/update",
        MeetingUpdateRequest {
            meeting_id: created.meeting.id.clone(),
            title: Some("ACP storage round trip — revised".to_string()),
            error: Some(MeetingTypedErrorDto {
                code: "fixture_warning".to_string(),
                message: "Deterministic warning".to_string(),
                retryable: true,
            }),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(updated.meeting.title, "ACP storage round trip — revised");
    assert_eq!(updated.meeting.last_error.unwrap().code, "fixture_warning");
    let segment_id = id();
    let observation_id = id();
    let transcript_segment = MeetingTranscriptSegmentUpsertDto {
        id: segment_id.clone(),
        transcript_version_id: created.live_transcript_version.id.clone(),
        provider: "assemblyai".to_string(),
        provider_namespace: "live-primary".to_string(),
        provider_session_id: Some("provider-session".to_string()),
        provider_turn_id: "turn-1".to_string(),
        provider_turn_order: 1,
        revision_number: 0,
        state: MeetingTranscriptSegmentState::Final,
        speaker_id: Some(speaker_id.clone()),
        source_kind: MeetingAudioSourceKind::Microphone,
        start_ms: 1_000,
        end_ms: 1_500,
        text: "A durable finalized transcript segment.".to_string(),
        words: vec![],
        replaced_live_segment_ids: vec![],
    };
    let applied: MeetingTranscriptApplyResponse = custom(
        &agent,
        "_goose/unstable/meetings/transcript/apply",
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
            segments: vec![transcript_segment.clone()],
            speaker_observations: vec![MeetingSpeakerObservationUpsertDto {
                id: observation_id.clone(),
                transcript_version_id: created.live_transcript_version.id.clone(),
                speaker_id: Some(speaker_id.clone()),
                provider: "assemblyai".to_string(),
                provider_namespace: "live-primary".to_string(),
                provider_speaker_label: "A".to_string(),
                confidence: Some(0.95),
                ambiguous: false,
                revision_number: 0,
                source_hint: Some(MeetingAudioSourceKind::Microphone),
            }],
            promote_canonical: true,
        },
    )
    .await;
    assert_eq!(
        applied.segment_outcomes[0].outcome,
        MeetingUpsertOutcomeKind::Inserted
    );

    let speakers: MeetingSpeakersApplyResponse = custom(
        &agent,
        "_goose/unstable/meetings/speakers/apply",
        MeetingSpeakersApplyRequest {
            meeting_id: created.meeting.id.clone(),
            speakers: vec![MeetingSpeakerInputDto {
                id: Some(speaker_id.clone()),
                default_label: "Speaker 1".to_string(),
                display_name: Some("Host revised".to_string()),
                display_name_source: Some("manual".to_string()),
                manual_assignment_lock: true,
                source_hint: Some(MeetingAudioSourceKind::Microphone),
            }],
            swaps: vec![],
            segment_updates: vec![MeetingSegmentSpeakerUpdateDto {
                segment_id: segment_id.clone(),
                speaker_id: speaker_id.clone(),
            }],
        },
    )
    .await;
    assert_eq!(
        speakers.speakers[0].display_name.as_deref(),
        Some("Host revised")
    );
    let timeline_event_id = id();
    let timeline: MeetingTimelineApplyResponse = custom(
        &agent,
        "_goose/unstable/meetings/timeline/apply",
        MeetingTimelineApplyRequest {
            meeting_id: created.meeting.id.clone(),
            events: vec![MeetingTimelineEventUpsertDto {
                id: timeline_event_id.clone(),
                kind: MeetingTimelineEventKind::Pause,
                start_ms: 1_500,
                end_ms: Some(1_650),
                source_kind: Some(MeetingAudioSourceKind::Mixed),
                provider_namespace: Some("live/session-2".to_string()),
                metadata: Some(serde_json::json!({"reason": "fixture"})),
            }],
        },
    )
    .await;
    assert_eq!(timeline.events[0].id, timeline_event_id);
    assert_eq!(timeline.events[0].end_ms, Some(1_650));

    let claim_id = id();
    let claim_version_id = id();
    let claim_gate_batch_id = id();
    let claims: MeetingClaimsApplyResponse = custom(
        &agent,
        "_goose/unstable/meetings/claims/apply",
        MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            claim_versions: vec![MeetingClaimVersionUpsertDto {
                claim_id: claim_id.clone(),
                claim_version_id: claim_version_id.clone(),
                manual_request_id: None,
                origin: MeetingClaimOrigin::Automatic,
                duplicate_key: Some("acp-fixture-claim".to_string()),
                status: MeetingClaimStatus::Queued,
                version_number: 1,
                predecessor_id: None,
                superseded_by_id: None,
                source_transcript_version_id: Some(created.live_transcript_version.id.clone()),
                exact_quote: "A durable finalized transcript segment.".to_string(),
                normalized_claim: "The transcript segment is durable.".to_string(),
                speaker_id: Some(speaker_id.clone()),
                start_ms: Some(1_000),
                end_ms: Some(1_500),
                segment_ids: vec![segment_id.clone()],
                selection_rationale: Some("Deterministic ACP fixture".to_string()),
                consequence_score: Some(0.5),
                dispute_score: Some(0.3),
                specificity_score: Some(0.8),
                time_sensitive: false,
                lifecycle: MeetingClaimVersionLifecycle::Active,
                set_current: true,
            }],
            manual_fact_check_requests: vec![],
            mark_stale_claim_version_ids: vec![],
            begin_claim_gate_batches: vec![MeetingClaimGateBatchBeginDto {
                id: claim_gate_batch_id.clone(),
                idempotency_key: format!("{}:claim-gate:acp", created.meeting.id),
                turns: vec![claim_gate_turn(&transcript_segment)],
            }],
            complete_claim_gate_batch_ids: vec![claim_gate_batch_id],
        },
    )
    .await;
    assert_eq!(claims.claims[0].id, claim_id);

    let research_job_id = id();
    let assessment_id = id();
    let source_id = id();
    let research: MeetingResearchApplyResponse = custom(
        &agent,
        "_goose/unstable/meetings/research/apply",
        MeetingResearchApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: Some(MeetingResearchJobUpsertDto {
                id: research_job_id.clone(),
                claim_version_id: claim_version_id.clone(),
                stage: MeetingAssessmentStage::Preliminary,
                gateway_job_id: Some("opaque-research-job".to_string()),
                idempotency_key: format!("research-{claim_version_id}"),
                status: MeetingJobStatus::Running,
                attempt_count: 1,
                next_retry_at_ms: None,
                started_at_ms: Some(2_000),
                completed_at_ms: None,
                error: None,
            }),
            assessment: Some(MeetingAssessmentApplyDto {
                id: assessment_id.clone(),
                claim_version_id: claim_version_id.clone(),
                stage: MeetingAssessmentStage::Preliminary,
                attempt_number: 1,
                status: MeetingAssessmentStatus::Complete,
                supersedes_id: None,
                verdict: MeetingVerdict::Supported,
                confidence: MeetingConfidence::High,
                conclusion: vec![MeetingCitedStatementDto {
                    text: "The fixture source supports the claim.".to_string(),
                    citation_keys: vec!["source-1".to_string()],
                }],
                support: vec![],
                contradiction: vec![],
                caveats: vec![],
                limitations: vec![],
                model_provider: "test".to_string(),
                model: "deterministic".to_string(),
                model_version: None,
                usage: Some(serde_json::json!({"inputTokens": 2, "outputTokens": 1})),
                latency_ms: Some(25),
                started_at_ms: 2_000,
                completed_at_ms: 2_025,
                error: None,
                sources: vec![MeetingSourceInputDto {
                    id: source_id,
                    citation_key: "source-1".to_string(),
                    url: "https://example.com/source".to_string(),
                    canonical_url: "https://example.com/source".to_string(),
                    publisher: "Example".to_string(),
                    title: "Fixture source".to_string(),
                    publication_date: Some("2026-08-10".to_string()),
                    accessed_at_ms: 2_000,
                    evidence_excerpt: "A deterministic evidence excerpt.".to_string(),
                    stance: MeetingEvidenceStance::Supports,
                    quality_score: Some(0.9),
                    quality_rationale: "Direct fixture source".to_string(),
                }],
                set_current: true,
            }),
        },
    )
    .await;
    assert_eq!(research.job.unwrap().id, research_job_id);
    assert_eq!(research.assessment.unwrap().id, assessment_id);

    let refinement_job_id = id();
    let refinement: MeetingRefinementJobApplyResponse = custom(
        &agent,
        "_goose/unstable/meetings/refinement/job/apply",
        MeetingRefinementJobApplyRequest {
            meeting_id: created.meeting.id.clone(),
            job: MeetingRefinementJobUpsertDto {
                id: refinement_job_id.clone(),
                source_transcript_version_id: created.live_transcript_version.id.clone(),
                input_manifest_checksum: "manifest-checksum".to_string(),
                provider: "test".to_string(),
                model: "deterministic".to_string(),
                gateway_job_id: Some("opaque-refinement-job".to_string()),
                idempotency_key: format!("refinement-{}", created.meeting.id),
                status: MeetingRefinementJobStatus::Processing,
                attempt_count: 1,
                next_retry_at_ms: None,
                usage: None,
                latency_ms: None,
                started_at_ms: Some(2_000),
                completed_at_ms: None,
                error: None,
            },
        },
    )
    .await;
    assert_eq!(refinement.job.id, refinement_job_id);
    let audio_asset_id = id();
    let audio: MeetingAudioApplyResponse = custom(
        &agent,
        "_goose/unstable/meetings/audio/apply",
        MeetingAudioApplyRequest {
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
                bytes: Some(192_044),
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
        },
    )
    .await;
    assert_eq!(audio.assets.len(), 1);
    assert_eq!(audio.refinement_inputs.len(), 1);

    let fetched: MeetingGetResponse = custom(
        &agent,
        "_goose/unstable/meetings/get",
        MeetingGetRequest {
            meeting_id: created.meeting.id.clone(),
        },
    )
    .await;
    assert_eq!(fetched.artifact.transcript_segments.len(), 1);
    assert_eq!(fetched.artifact.transcript_segments[0].revision_number, 0);
    assert_eq!(fetched.artifact.speaker_observations[0].id, observation_id);
    assert_eq!(fetched.artifact.speaker_observations[0].revision_number, 0);
    assert_eq!(fetched.artifact.timeline_events.len(), 1);
    assert_eq!(
        fetched.artifact.claims[0].status,
        MeetingClaimStatus::Preliminary
    );
    assert!(fetched.artifact.pending_claim_gate_segment_ids.is_empty());
    assert!(fetched.artifact.pending_claim_gate_batches.is_empty());
    assert_eq!(fetched.artifact.claim_versions.len(), 1);
    assert_eq!(fetched.artifact.assessments.len(), 1);
    assert_eq!(fetched.artifact.audio_assets.len(), 1);
    assert_eq!(fetched.artifact.refinement_inputs.len(), 1);

    let listed: MeetingListResponse = custom(
        &agent,
        "_goose/unstable/meetings/list",
        MeetingListRequest {
            limit: Some(10),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(listed.items.len(), 1);

    let recovered: MeetingRecoverResponse = custom(
        &agent,
        "_goose/unstable/meetings/recover",
        MeetingRecoverRequest {
            reconcile_active_work: true,
        },
    )
    .await;
    assert_eq!(
        recovered.interrupted_meeting_ids,
        vec![created.meeting.id.clone()]
    );
    assert_eq!(recovered.research_job_ids, vec![research_job_id]);
    assert_eq!(
        recovered.refinement_job_ids,
        vec![refinement_job_id.clone()]
    );

    let refined_version_id = id();
    let refined_segment_id = id();
    let refined: MeetingRefinementResultApplyResponse = custom(
        &agent,
        "_goose/unstable/meetings/refinement/result/apply",
        MeetingRefinementResultApplyRequest {
            meeting_id: created.meeting.id.clone(),
            refinement_job_id: refinement_job_id.clone(),
            version: MeetingTranscriptVersionUpsertDto {
                id: refined_version_id.clone(),
                kind: MeetingTranscriptVersionKind::Refined,
                status: MeetingTranscriptVersionStatus::Complete,
                revision_number: 1,
                provider: Some("test".to_string()),
                model: Some("deterministic".to_string()),
                gateway_job_id: Some("opaque-refinement-job".to_string()),
                parent_version_id: Some(created.live_transcript_version.id.clone()),
                input_audio_checksum: Some("manifest-checksum".to_string()),
                detected_language: Some("en".to_string()),
                reconciliation_metadata: Some(serde_json::json!({"strategy": "fixture"})),
                started_at_ms: Some(2_000),
                completed_at_ms: Some(3_000),
                error: None,
            },
            segments: vec![MeetingTranscriptSegmentUpsertDto {
                id: refined_segment_id,
                transcript_version_id: refined_version_id.clone(),
                provider: "test".to_string(),
                provider_namespace: format!("refinement/{refinement_job_id}"),
                provider_session_id: None,
                provider_turn_id: "refined-turn-1".to_string(),
                provider_turn_order: 1,
                revision_number: 1,
                state: MeetingTranscriptSegmentState::Final,
                speaker_id: Some(speaker_id),
                source_kind: MeetingAudioSourceKind::Mixed,
                start_ms: 1_000,
                end_ms: 1_500,
                text: "A refined durable transcript segment.".to_string(),
                words: vec![],
                replaced_live_segment_ids: vec![segment_id],
            }],
            speaker_observations: vec![],
            mark_stale_claim_version_ids: vec![claim_version_id],
            replacement_claim_versions: vec![],
        },
    )
    .await;
    assert_eq!(refined.canonical_version.id, refined_version_id);
    let refined_artifact: MeetingGetResponse = custom(
        &agent,
        "_goose/unstable/meetings/get",
        MeetingGetRequest {
            meeting_id: created.meeting.id.clone(),
        },
    )
    .await;
    assert_eq!(refined_artifact.artifact.transcript_versions.len(), 2);
    assert_eq!(
        refined_artifact
            .artifact
            .meeting
            .canonical_transcript_version_id,
        Some(refined_version_id)
    );
    assert_eq!(
        refined_artifact.artifact.claim_versions[0].lifecycle,
        MeetingClaimVersionLifecycle::Stale
    );

    let deleted: MeetingDeleteResponse = custom(
        &agent,
        "_goose/unstable/meetings/delete",
        MeetingDeleteRequest {
            meeting_id: created.meeting.id,
        },
    )
    .await;
    let cleanup_recovery: MeetingRecoverResponse = custom(
        &agent,
        "_goose/unstable/meetings/recover",
        MeetingRecoverRequest::default(),
    )
    .await;
    assert_eq!(cleanup_recovery.cleanup_jobs.len(), 1);
    assert_eq!(
        cleanup_recovery.cleanup_jobs[0].meeting_id,
        deleted.cleanup_job.meeting_id
    );
    let confirmed: MeetingCleanupConfirmResponse = custom(
        &agent,
        "_goose/unstable/meetings/cleanup/confirm",
        MeetingCleanupConfirmRequest {
            cleanup_job_id: deleted.cleanup_job.id,
            local_status: MeetingCleanupStatus::Unavailable,
            gateway_status: MeetingCleanupStatus::Unavailable,
            provider_status: MeetingCleanupStatus::Unavailable,
            error: None,
        },
    )
    .await;
    assert!(confirmed.records_removed);
    assert!(confirmed.cleanup_job.is_none());
}

#[tokio::test(flavor = "current_thread")]
#[serial]
async fn text_only_manual_fact_check_parent_and_child_round_trip_over_acp() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().to_string_lossy().to_string();
    let _environment = env_lock::lock_env([
        ("GOOSE_PATH_ROOT", Some(root_path.as_str())),
        ("GOOSE_DISABLE_KEYRING", Some("1")),
    ]);
    let provider_factory: AcpProviderFactory = Arc::new(|_, _, _| {
        Box::pin(async {
            Err(anyhow::anyhow!(
                "provider is not used by meeting storage tests"
            ))
        })
    });
    let agent = GooseAcpAgent::new(GooseAcpAgentOptions {
        provider_factory,
        builtin_selection: AcpBuiltinSelection::default(),
        data_dir: root.path().to_path_buf(),
        config_dir: root.path().to_path_buf(),
        disable_session_naming: true,
        goose_platform: GoosePlatform::GooseCli,
        additional_source_roots: vec![],
        scheduler: None,
    })
    .await
    .unwrap();
    let created: MeetingCreateResponse = custom(
        &agent,
        "_goose/unstable/meetings/create",
        MeetingCreateRequest {
            title: Some("Text-only manual check".to_string()),
            artifact_type: MeetingArtifactType::TextCheck,
            mode: MeetingMode::Text,
            started_at_ms: 1_000,
            capture_config: MeetingCaptureConfigDto {
                live_strategy: MeetingLiveStrategy::MixedDiarized,
                microphone_device_id: None,
                system_audio_enabled: false,
                exact_speaker_count: None,
            },
            initial_speakers: vec![],
        },
    )
    .await;
    let manual_request_id = id();
    let claim_id = id();
    let claim_version_id = id();
    let synthetic_turn_id = id();
    let claims: MeetingClaimsApplyResponse = custom(
        &agent,
        "_goose/unstable/meetings/claims/apply",
        MeetingClaimsApplyRequest {
            meeting_id: created.meeting.id.clone(),
            manual_fact_check_requests: vec![MeetingManualFactCheckRequestUpsertDto {
                id: manual_request_id.clone(),
                exact_selection: "A synthetic text selection can be checked durably.".to_string(),
                context_turns: vec![MeetingClaimGateTurnDto {
                    id: synthetic_turn_id.clone(),
                    speaker_id: None,
                    start_ms: 0,
                    end_ms: 0,
                    text: "A synthetic text selection can be checked durably.".to_string(),
                    revision_number: 0,
                    source_kind: MeetingAudioSourceKind::Text,
                }],
                source_segment_ids: vec![],
                speaker_id: None,
                start_ms: None,
                end_ms: None,
                status: MeetingManualFactCheckRequestStatus::Complete,
                error: None,
            }],
            claim_versions: vec![MeetingClaimVersionUpsertDto {
                claim_id: claim_id.clone(),
                claim_version_id,
                manual_request_id: Some(manual_request_id.clone()),
                origin: MeetingClaimOrigin::Manual,
                duplicate_key: Some(format!("{manual_request_id}:text-child")),
                status: MeetingClaimStatus::Queued,
                version_number: 1,
                predecessor_id: None,
                superseded_by_id: None,
                source_transcript_version_id: Some(created.live_transcript_version.id.clone()),
                exact_quote: "A synthetic text selection can be checked durably.".to_string(),
                normalized_claim: "A synthetic text selection can be checked durably.".to_string(),
                speaker_id: None,
                start_ms: None,
                end_ms: None,
                segment_ids: vec![],
                selection_rationale: Some("Selected manually.".to_string()),
                consequence_score: Some(1.0),
                dispute_score: Some(1.0),
                specificity_score: Some(1.0),
                time_sensitive: false,
                lifecycle: MeetingClaimVersionLifecycle::Active,
                set_current: true,
            }],
            ..Default::default()
        },
    )
    .await;
    assert_eq!(claims.claims[0].id, claim_id);
    assert_eq!(
        claims.claims[0].manual_request_id.as_deref(),
        Some(manual_request_id.as_str())
    );

    let fetched: MeetingGetResponse = custom(
        &agent,
        "_goose/unstable/meetings/get",
        MeetingGetRequest {
            meeting_id: created.meeting.id,
        },
    )
    .await;
    assert_eq!(fetched.artifact.manual_fact_check_requests.len(), 1);
    assert_eq!(
        fetched.artifact.manual_fact_check_requests[0].context_turns[0].id,
        synthetic_turn_id
    );
    assert!(fetched.artifact.manual_fact_check_requests[0]
        .source_segment_ids
        .is_empty());
}
