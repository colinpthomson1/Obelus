use super::*;
use crate::meetings::MeetingStoreError;

fn meeting_error(error: MeetingStoreError) -> agent_client_protocol::Error {
    match error {
        MeetingStoreError::Validation(_)
        | MeetingStoreError::NotFound
        | MeetingStoreError::Conflict => {
            agent_client_protocol::Error::invalid_params().data(error.to_string())
        }
        MeetingStoreError::SchemaTooNew
        | MeetingStoreError::Database(_)
        | MeetingStoreError::Serialization
        | MeetingStoreError::Initialization => {
            agent_client_protocol::Error::internal_error().data(error.to_string())
        }
    }
}

impl GooseAcpAgent {
    pub(super) async fn on_meeting_create(
        &self,
        request: MeetingCreateRequest,
    ) -> Result<MeetingCreateResponse, agent_client_protocol::Error> {
        self.meeting_store
            .create_meeting(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_update(
        &self,
        request: MeetingUpdateRequest,
    ) -> Result<MeetingUpdateResponse, agent_client_protocol::Error> {
        self.meeting_store
            .update_meeting(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_list(
        &self,
        request: MeetingListRequest,
    ) -> Result<MeetingListResponse, agent_client_protocol::Error> {
        self.meeting_store
            .list_meetings(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_get(
        &self,
        request: MeetingGetRequest,
    ) -> Result<MeetingGetResponse, agent_client_protocol::Error> {
        self.meeting_store
            .get_artifact(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_transcript_apply(
        &self,
        request: MeetingTranscriptApplyRequest,
    ) -> Result<MeetingTranscriptApplyResponse, agent_client_protocol::Error> {
        self.meeting_store
            .apply_transcript(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_speakers_apply(
        &self,
        request: MeetingSpeakersApplyRequest,
    ) -> Result<MeetingSpeakersApplyResponse, agent_client_protocol::Error> {
        self.meeting_store
            .apply_speakers(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_timeline_apply(
        &self,
        request: MeetingTimelineApplyRequest,
    ) -> Result<MeetingTimelineApplyResponse, agent_client_protocol::Error> {
        self.meeting_store
            .apply_timeline(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_audio_apply(
        &self,
        request: MeetingAudioApplyRequest,
    ) -> Result<MeetingAudioApplyResponse, agent_client_protocol::Error> {
        self.meeting_store
            .apply_audio(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_claims_apply(
        &self,
        request: MeetingClaimsApplyRequest,
    ) -> Result<MeetingClaimsApplyResponse, agent_client_protocol::Error> {
        self.meeting_store
            .apply_claims(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_research_apply(
        &self,
        request: MeetingResearchApplyRequest,
    ) -> Result<MeetingResearchApplyResponse, agent_client_protocol::Error> {
        self.meeting_store
            .apply_research(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_refinement_job_apply(
        &self,
        request: MeetingRefinementJobApplyRequest,
    ) -> Result<MeetingRefinementJobApplyResponse, agent_client_protocol::Error> {
        self.meeting_store
            .apply_refinement_job(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_refinement_result_apply(
        &self,
        request: MeetingRefinementResultApplyRequest,
    ) -> Result<MeetingRefinementResultApplyResponse, agent_client_protocol::Error> {
        self.meeting_store
            .apply_refinement_result(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_delete(
        &self,
        request: MeetingDeleteRequest,
    ) -> Result<MeetingDeleteResponse, agent_client_protocol::Error> {
        self.meeting_store
            .delete_meeting(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_cleanup_confirm(
        &self,
        request: MeetingCleanupConfirmRequest,
    ) -> Result<MeetingCleanupConfirmResponse, agent_client_protocol::Error> {
        self.meeting_store
            .confirm_cleanup(request)
            .await
            .map_err(meeting_error)
    }

    pub(super) async fn on_meeting_recover(
        &self,
        request: MeetingRecoverRequest,
    ) -> Result<MeetingRecoverResponse, agent_client_protocol::Error> {
        self.meeting_store
            .recover(request)
            .await
            .map_err(meeting_error)
    }
}
