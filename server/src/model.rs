use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

// ---- Project / file models ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: String,
    pub extension: String,
    pub size: u64,
    pub modified_ms: u64,
    pub children: Vec<ProjectEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub root_path: String,
    pub name: String,
    pub entries: Vec<ProjectEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePayload {
    pub relative_path: String,
    pub name: String,
    pub extension: String,
    pub size: u64,
    pub modified_ms: u64,
    pub encoding: String,
    pub content: String,
}

// ---- Directory browser (web folder picker) ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<DirEntry>,
}

// ---- Agent models ----

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    pub id: String,
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetection {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub resolved_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartRequest {
    pub agent_id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    120
}

fn default_rows() -> u16 {
    32
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStarted {
    pub session_id: String,
    pub agent_id: String,
}

// ---- Snapshot models ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub files: Vec<String>,
}

// ---- Agent event bus (broadcast) ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AgentEvent {
    // The container `rename_all` only renames variant names; per-variant
    // `rename_all` is required so the fields serialize as camelCase to match
    // the frontend's AgentBusMessage (sessionId, not session_id).
    #[serde(rename_all = "camelCase")]
    Output { session_id: String, data: String },
    #[serde(rename_all = "camelCase")]
    Exit { session_id: String, reason: String },
}

pub type AgentEventSender = broadcast::Sender<AgentEvent>;

// ---- Journal requests ----
//
// These are intentionally `Value` rather than typed structs: the
// `Annotation` schema lives in TypeScript and evolves quickly. Locking the
// Rust server to a Rust struct would force a coordinated upgrade every time
// the frontend adds a field. We just validate the request shape (presence of
// `rootPath`) and forward the rest.

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalPathReq {
    pub root_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEventReq {
    pub root_path: String,
    pub kind: String,
    pub actor: String,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub data: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalAnnotationReq {
    pub root_path: String,
    pub annotation: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalAnnotationPatchReq {
    pub root_path: String,
    pub id: String,
    /// Partial patch applied over the stored annotation. Use `null` to clear
    /// an optional field; any other value replaces the existing one.
    pub patch: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalAnnotationDeleteReq {
    pub root_path: String,
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalAgentReq {
    pub root_path: String,
    pub session: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalSnapshotCreateReq {
    pub root_path: String,
    pub relative_paths: Vec<String>,
    #[serde(default)]
    pub trigger: Option<String>,
    #[serde(default)]
    pub annotation_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalSnapshotRestoreReq {
    pub root_path: String,
    pub snapshot_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEventsQuery {
    pub root_path: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalOpenReq {
    pub root_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalExportReq {
    pub root_path: String,
    pub destination: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalImportReq {
    pub root_path: String,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalCompactReq {
    pub root_path: String,
    pub keep_recent: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalTokensReq {
    pub root_path: String,
    pub session_id: String,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFolderReq {
    pub root_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalWorkspaceReq {
    pub root_path: String,
    pub workspace: Value,
}
