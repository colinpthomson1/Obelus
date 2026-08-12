use super::MeetingStoreError;
use goose_sdk_types::custom_requests::{
    MeetingCitedStatementDto, MeetingTimedWordDto, MeetingTypedErrorDto,
};
use std::path::{Component, Path};
use url::Url;
use uuid::Uuid;

pub const MAX_TITLE_BYTES: usize = 512;
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_CLAIM_BYTES: usize = 16 * 1024;
pub const MAX_EXCERPT_BYTES: usize = 8 * 1024;
pub const MAX_URL_BYTES: usize = 8 * 1024;
pub const MAX_METADATA_BYTES: usize = 256 * 1024;
pub const MAX_SEGMENTS_PER_BATCH: usize = 256;
pub const MAX_WORDS_PER_SEGMENT: usize = 4_096;
pub const MAX_SOURCES_PER_ASSESSMENT: usize = 32;
pub const MAX_STATEMENTS_PER_FIELD: usize = 64;
pub const MAX_SPEAKERS_PER_BATCH: usize = 128;
pub const MAX_EVENTS_PER_BATCH: usize = 256;
pub const MAX_ASSETS_PER_BATCH: usize = 128;
pub const MAX_CLAIMS_PER_BATCH: usize = 64;
pub const DEFAULT_PAGE_SIZE: u32 = 50;
pub const MAX_PAGE_SIZE: u32 = 200;

pub fn uuid(value: &str) -> Result<(), MeetingStoreError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| MeetingStoreError::validation("invalid identifier"))
}

pub fn nonempty(value: &str, max: usize, field: &'static str) -> Result<(), MeetingStoreError> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') {
        return Err(MeetingStoreError::validation(field));
    }
    Ok(())
}

pub fn optional(
    value: Option<&str>,
    max: usize,
    field: &'static str,
) -> Result<(), MeetingStoreError> {
    if let Some(value) = value {
        if value.len() > max || value.contains('\0') {
            return Err(MeetingStoreError::validation(field));
        }
    }
    Ok(())
}

pub fn timestamp_range(start: i64, end: Option<i64>) -> Result<(), MeetingStoreError> {
    if start < 0 || end.is_some_and(|end| end < start) {
        return Err(MeetingStoreError::validation("invalid timestamp range"));
    }
    Ok(())
}

pub fn score(score: Option<f32>) -> Result<(), MeetingStoreError> {
    if score.is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
        return Err(MeetingStoreError::validation("invalid score"));
    }
    Ok(())
}

pub fn json_size(value: Option<&serde_json::Value>) -> Result<(), MeetingStoreError> {
    if let Some(value) = value {
        let encoded = serde_json::to_vec(value)
            .map_err(|_| MeetingStoreError::validation("invalid metadata"))?;
        if encoded.len() > MAX_METADATA_BYTES {
            return Err(MeetingStoreError::validation("metadata is too large"));
        }
    }
    Ok(())
}

pub fn words(
    words: &[MeetingTimedWordDto],
    segment_start: i64,
    segment_end: i64,
) -> Result<(), MeetingStoreError> {
    if words.len() > MAX_WORDS_PER_SEGMENT {
        return Err(MeetingStoreError::validation("too many timed words"));
    }
    let mut previous_start = segment_start;
    for word in words {
        nonempty(&word.text, 1_024, "invalid timed word")?;
        if word.start_ms < segment_start
            || word.end_ms < word.start_ms
            || word.end_ms > segment_end
            || word.start_ms < previous_start
        {
            return Err(MeetingStoreError::validation("invalid timed word range"));
        }
        score(word.confidence)?;
        optional(
            word.provider_speaker_label.as_deref(),
            256,
            "invalid provider speaker label",
        )?;
        previous_start = word.start_ms;
    }
    Ok(())
}

pub fn controlled_file_name(value: &str) -> Result<(), MeetingStoreError> {
    nonempty(value, 255, "invalid audio file name")?;
    let mut components = Path::new(value).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(MeetingStoreError::validation("invalid audio file name"));
    }
    Ok(())
}

pub fn controlled_relative_path(value: &str) -> Result<(), MeetingStoreError> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(MeetingStoreError::validation("invalid controlled path"));
    }
    Ok(())
}

pub fn source_url(value: &str) -> Result<(), MeetingStoreError> {
    nonempty(value, MAX_URL_BYTES, "invalid source URL")?;
    let url = Url::parse(value).map_err(|_| MeetingStoreError::validation("invalid source URL"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(MeetingStoreError::validation("invalid source URL"));
    }
    Ok(())
}

pub fn typed_error(value: Option<&MeetingTypedErrorDto>) -> Result<(), MeetingStoreError> {
    if let Some(value) = value {
        nonempty(&value.code, 128, "invalid error code")?;
        nonempty(&value.message, 1_024, "invalid error message")?;
    }
    Ok(())
}

pub fn statements(values: &[MeetingCitedStatementDto]) -> Result<(), MeetingStoreError> {
    statements_with_citation_policy(values, false)
}

pub fn conclusion_statements(values: &[MeetingCitedStatementDto]) -> Result<(), MeetingStoreError> {
    statements_with_citation_policy(values, true)
}

fn statements_with_citation_policy(
    values: &[MeetingCitedStatementDto],
    allow_empty_citations: bool,
) -> Result<(), MeetingStoreError> {
    if values.len() > MAX_STATEMENTS_PER_FIELD {
        return Err(MeetingStoreError::validation(
            "too many assessment statements",
        ));
    }
    for value in values {
        nonempty(&value.text, MAX_CLAIM_BYTES, "invalid assessment statement")?;
        if (!allow_empty_citations && value.citation_keys.is_empty())
            || value.citation_keys.len() > 16
        {
            return Err(MeetingStoreError::validation(
                "assessment statement citations are invalid",
            ));
        }
        for citation in &value.citation_keys {
            nonempty(citation, 128, "invalid citation key")?;
        }
    }
    Ok(())
}
