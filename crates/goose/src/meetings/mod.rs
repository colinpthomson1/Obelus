mod migrations;
mod store;
mod validation;

pub use store::{MeetingStore, MeetingStoreError};

pub const MEETINGS_FOLDER: &str = "meetings";
pub const MEETINGS_DB_NAME: &str = "meetings.db";
pub const MEETINGS_AUDIO_FOLDER: &str = "audio";
