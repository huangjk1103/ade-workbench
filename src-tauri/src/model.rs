use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutputEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExitEvent {
    pub session_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub files: Vec<String>,
}
