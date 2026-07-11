mod ade_journal;
mod agents;
mod model;
mod persistence;
mod project_files;
mod snapshots;

use std::io;
use std::sync::Arc;
use std::time::Duration;

use async_stream::stream;
use axum::{
    extract::{DefaultBodyLimit, Query, State},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::broadcast;
use tower_http::services::{ServeDir, ServeFile};

use agents::AgentManager;
use model::{
    AgentDescriptor, AgentDetection, AgentEventSender, AgentStartRequest, AgentStarted,
    DirListing, FilePayload, JournalAgentReq, JournalAnnotationDeleteReq,
    JournalAnnotationPatchReq, JournalAnnotationReq, JournalCompactReq, JournalEventReq,
    JournalEventsQuery, JournalExportReq, JournalImportReq, JournalOpenReq, JournalPathReq,
    JournalSnapshotCreateReq, JournalSnapshotRestoreReq, JournalTokensReq, JournalWorkspaceReq,
    OpenFolderReq, ProjectSnapshot, SnapshotInfo,
};

const JOURNAL_DIR_NAME: &str = ade_journal::JOURNAL_DIR_NAME;

#[derive(Clone)]
struct AppState {
    agents: Arc<AgentManager>,
    events: AgentEventSender,
}

#[derive(Debug)]
struct AppError(pub String);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (axum::http::StatusCode::INTERNAL_SERVER_ERROR, self.0).into_response()
    }
}

impl From<String> for AppError {
    fn from(value: String) -> Self { AppError(value) }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self { AppError(value.to_string()) }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirsQuery {
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathReq {
    root_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TwoPathReq {
    root_path: String,
    relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteReq {
    root_path: String,
    relative_path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinaryWriteReq {
    root_path: String,
    relative_path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocxWriteReq {
    root_path: String,
    relative_path: String,
    html: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetectReq {
    agents: Vec<AgentDescriptor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionReq {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionWriteReq {
    session_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionResizeReq {
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotCreateReq {
    root_path: String,
    relative_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRestoreReq {
    root_path: String,
    snapshot_id: String,
}

async fn bootstrap() -> Json<Value> {
    Json(serde_json::json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "platform": if cfg!(windows) { "windows" } else { "unix" },
        "executionMode": "direct-transaction",
    }))
}

async fn list_dirs(Query(q): Query<DirsQuery>) -> Result<Json<DirListing>, AppError> {
    Ok(Json(project_files::list_dirs(&q.path).map_err(AppError)?))
}

async fn scan(State(_): State<AppState>, Json(req): Json<PathReq>) -> Result<Json<ProjectSnapshot>, AppError> {
    Ok(Json(project_files::scan_project(&req.root_path).map_err(AppError)?))
}

async fn read_file(State(_): State<AppState>, Json(req): Json<TwoPathReq>) -> Result<Json<FilePayload>, AppError> {
    Ok(Json(
        project_files::read_project_file(&req.root_path, &req.relative_path).map_err(AppError)?,
    ))
}

async fn write_file(State(_): State<AppState>, Json(req): Json<WriteReq>) -> Result<Json<Value>, AppError> {
    project_files::write_project_text_file(&req.root_path, &req.relative_path, &req.content)
        .map_err(AppError)?;
    Ok(Json(serde_json::json!({})))
}

async fn write_binary_file(State(_): State<AppState>, Json(req): Json<BinaryWriteReq>) -> Result<Json<Value>, AppError> {
    project_files::write_project_binary_file(&req.root_path, &req.relative_path, &req.content)
        .map_err(AppError)?;
    Ok(Json(serde_json::json!({})))
}

async fn write_docx_file(State(_): State<AppState>, Json(req): Json<DocxWriteReq>) -> Result<Json<Value>, AppError> {
    project_files::write_project_docx(&req.root_path, &req.relative_path, &req.html)
        .map_err(AppError)?;
    Ok(Json(serde_json::json!({})))
}

async fn open_file(State(_): State<AppState>, Json(req): Json<TwoPathReq>) -> Result<Json<Value>, AppError> {
    project_files::open_in_system(&req.root_path, &req.relative_path).map_err(AppError)?;
    Ok(Json(serde_json::json!({})))
}

async fn open_folder(State(_): State<AppState>, Json(req): Json<OpenFolderReq>) -> Result<Json<Value>, AppError> {
    project_files::open_folder_in_system(&req.root_path).map_err(AppError)?;
    Ok(Json(serde_json::json!({})))
}

async fn detect_agents(State(_): State<AppState>, Json(req): Json<DetectReq>) -> Result<Json<Vec<AgentDetection>>, AppError> {
    Ok(Json(agents::detect_agents(req.agents)))
}

async fn agent_start(State(state): State<AppState>, Json(req): Json<AgentStartRequest>) -> Result<Json<AgentStarted>, AppError> {
    Ok(Json(state.agents.start(req).map_err(AppError)?))
}

async fn agent_write(State(state): State<AppState>, Json(req): Json<SessionWriteReq>) -> Result<Json<Value>, AppError> {
    state.agents.write(&req.session_id, &req.data).map_err(AppError)?;
    Ok(Json(serde_json::json!({})))
}

async fn agent_resize(State(state): State<AppState>, Json(req): Json<SessionResizeReq>) -> Result<Json<Value>, AppError> {
    state.agents.resize(&req.session_id, req.cols, req.rows).map_err(AppError)?;
    Ok(Json(serde_json::json!({})))
}

async fn agent_stop(State(state): State<AppState>, Json(req): Json<SessionReq>) -> Result<Json<Value>, AppError> {
    state.agents.stop(&req.session_id).map_err(AppError)?;
    Ok(Json(serde_json::json!({})))
}

async fn snapshot_create(State(_): State<AppState>, Json(req): Json<SnapshotCreateReq>) -> Result<Json<SnapshotInfo>, AppError> {
    Ok(Json(
        snapshots::create_task_snapshot(&req.root_path, &req.relative_paths).map_err(AppError)?,
    ))
}

async fn snapshot_restore(State(_): State<AppState>, Json(req): Json<SnapshotRestoreReq>) -> Result<Json<Value>, AppError> {
    let files = snapshots::restore_task_snapshot(&req.root_path, &req.snapshot_id).map_err(AppError)?;
    Ok(Json(serde_json::json!({ "files": files })))
}

async fn state_load(State(_): State<AppState>) -> Result<Json<Value>, AppError> {
    Ok(Json(persistence::load_persisted_state().map_err(AppError)?))
}

async fn state_save(State(_): State<AppState>, Json(state): Json<Value>) -> Result<Json<Value>, AppError> {
    persistence::save_persisted_state(state).map_err(AppError)?;
    Ok(Json(serde_json::json!({})))
}

// ---- Journal handlers ----
//
// Each journal request takes a `rootPath` and opens (or creates) the
// project's `.ade/` directory on demand. We hold an `AdeJournalHandle` per
// request; the handle keeps an in-process mutex so concurrent edits within
// the same server serialize cleanly.

fn open_journal(req_root: &str) -> Result<ade_journal::AdeJournalHandle, AppError> {
    let mut handle = ade_journal::AdeJournalHandle::open(req_root).map_err(AppError)?;
    handle.ensure().map_err(AppError)?;
    Ok(handle)
}

async fn journal_summary(Query(q): Query<JournalPathReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&q.root_path)?;
    Ok(Json(serde_json::to_value(handle.summary().map_err(AppError)?).unwrap_or_default()))
}

async fn journal_load(Query(q): Query<JournalPathReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&q.root_path)?;
    let journal = handle.load().map_err(AppError)?;
    Ok(Json(serde_json::to_value(journal).unwrap_or_default()))
}

async fn journal_events(Query(q): Query<JournalEventsQuery>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&q.root_path)?;
    let events = handle.read_events(q.limit.unwrap_or(500)).map_err(AppError)?;
    Ok(Json(serde_json::to_value(events).unwrap_or_default()))
}

async fn journal_log_event(Json(req): Json<JournalEventReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    let id = handle
        .append_event(&req.kind, &req.actor, req.file.as_deref(), req.data)
        .map_err(AppError)?;
    Ok(Json(serde_json::json!({ "id": id })))
}

async fn journal_append_annotation(Json(req): Json<JournalAnnotationReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    let mut journal = handle.load().map_err(AppError)?;
    // Insert at the head so the UI sees newest-first without sorting.
    journal.annotations.insert(0, req.annotation);
    let saved = handle.save_full(journal).map_err(AppError)?;
    Ok(Json(serde_json::to_value(saved).unwrap_or_default()))
}

async fn journal_update_annotation(Json(req): Json<JournalAnnotationPatchReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    let mut journal = handle.load().map_err(AppError)?;
    let mut found = false;
    for annotation in journal.annotations.iter_mut() {
        if annotation.get("id").and_then(|value| value.as_str()) == Some(req.id.as_str()) {
            // Apply the patch with `Value::patch_in_place` semantics: object
            // merge, null clears. We implement it manually so the frontend
            // can express "remove field" without serde_json's `Option`.
            merge_value(annotation, &req.patch);
            if let Some(updated) = annotation.get_mut("updatedAt") {
                *updated = serde_json::json!(chrono_like_now_ms());
            } else {
                annotation.as_object_mut()
                    .map(|map| map.insert("updatedAt".into(), serde_json::json!(chrono_like_now_ms())));
            }
            found = true;
            break;
        }
    }
    if !found {
        return Err(AppError(format!("批注不存在：{}", req.id)));
    }
    let saved = handle.save_full(journal).map_err(AppError)?;
    Ok(Json(serde_json::to_value(saved).unwrap_or_default()))
}

async fn journal_delete_annotation(Json(req): Json<JournalAnnotationDeleteReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    let mut journal = handle.load().map_err(AppError)?;
    let before = journal.annotations.len();
    journal.annotations.retain(|annotation| {
        annotation.get("id").and_then(|value| value.as_str()) != Some(req.id.as_str())
    });
    if journal.annotations.len() == before {
        return Err(AppError(format!("批注不存在：{}", req.id)));
    }
    let saved = handle.save_full(journal).map_err(AppError)?;
    Ok(Json(serde_json::to_value(saved).unwrap_or_default()))
}

async fn journal_upsert_agent(Json(req): Json<JournalAgentReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    let mut journal = handle.load().map_err(AppError)?;
    let id = req.session.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
    if let Some(ref id) = id {
        let mut found = false;
        for existing in journal.agent_sessions.iter_mut() {
            if existing.id == *id {
                merge_agent_summary(existing, &req.session);
                found = true;
                break;
            }
        }
        if !found {
            journal.agent_sessions.push(session_to_summary(&req.session));
        }
    } else {
        journal.agent_sessions.push(session_to_summary(&req.session));
    }
    let saved = handle.save_full(journal).map_err(AppError)?;
    Ok(Json(serde_json::to_value(saved).unwrap_or_default()))
}

async fn journal_snapshot_create(Json(req): Json<JournalSnapshotCreateReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    let mut journal = handle.load().map_err(AppError)?;
    let snapshot_id = snapshots::create_task_snapshot(&req.root_path, &req.relative_paths)
        .map_err(AppError)?;
    let now = chrono_like_now_ms();
    journal.snapshots.insert(0, ade_journal::AdeSnapshotMeta {
        id: snapshot_id.id.clone(),
        created_at_ms: now,
        trigger: req.trigger.unwrap_or_else(|| "manual".into()),
        annotation_id: req.annotation_id,
        files: snapshot_id.files.clone(),
    });
    let saved = handle.save_full(journal).map_err(AppError)?;
    Ok(Json(serde_json::json!({
        "snapshotId": snapshot_id.id,
        "files": snapshot_id.files,
        "journal": serde_json::to_value(saved).unwrap_or_default(),
    })))
}

async fn journal_snapshot_restore(Json(req): Json<JournalSnapshotRestoreReq>) -> Result<Json<Value>, AppError> {
    let files = snapshots::restore_task_snapshot(&req.root_path, &req.snapshot_id).map_err(AppError)?;
    Ok(Json(serde_json::json!({ "files": files })))
}

// ---- `.ade` data management ----
//
// Three small operations the user can run from the preferences panel:
// reveal the directory in the OS file manager, copy it elsewhere for
// backup/handoff, or import a copy another project produced. Compact keeps
// the append-only events.jsonl from growing without bound; the live state
// in journal.json is untouched so the activity feed stays intact.

async fn journal_open_folder(Json(req): Json<JournalOpenReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    let path = handle.journal_dir().to_path_buf();
    if !path.exists() {
        return Err(AppError(format!(".ade 目录不存在：{}", path.display())));
    }
    open::that(project_files::strip_verbatim_prefix(&path))?;
    Ok(Json(serde_json::json!({
        "path": project_files::strip_verbatim_prefix(&path).to_string_lossy(),
    })))
}

async fn journal_export(Json(req): Json<JournalExportReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    let source = handle.journal_dir().to_path_buf();
    if !source.exists() {
        return Err(AppError(format!("当前项目还没有 .ade 目录，请先打开项目再导出")));
    }
    // Destination is treated as a directory; the .ade folder is placed at
    // `<destination>/.ade` so the export mirrors the on-disk layout. If
    // the destination doesn't exist we create it rather than rejecting the
    // request — typing a fresh folder path is the natural flow when the
    // user wants to "export to a new location".
    let destination = std::path::PathBuf::from(&req.destination);
    if destination.as_os_str().is_empty() {
        return Err(AppError("导出目标路径为空，请选择一个目录".into()));
    }
    if !destination.exists() {
        std::fs::create_dir_all(&destination).map_err(|error| {
            AppError(format!(
                "无法创建导出目录 {}：{}",
                destination.display(),
                error
            ))
        })?;
    }
    if !destination.is_dir() {
        return Err(AppError(format!(
            "导出路径不是目录：{}",
            destination.display()
        )));
    }
    let destination = fs_canonicalize(&destination)
        .map_err(|error| AppError(format!("无法解析导出目录：{}", error)))?;
    let dest_ade = destination.join(JOURNAL_DIR_NAME);
    ade_journal::copy_dir_recursive(&source, &dest_ade)?;
    Ok(Json(serde_json::json!({
        "source": project_files::strip_verbatim_prefix(&source).to_string_lossy(),
        "destination": project_files::strip_verbatim_prefix(&dest_ade).to_string_lossy(),
    })))
}

// Canonicalise an existing path. We can't reuse `canonical_root` because
// it rejects non-existent paths, but the export endpoint already creates
// the directory by the time we get here. `fs::canonicalize` returns the
// verbatim-prefixed form on Windows; `strip_verbatim_prefix` in
// `project_files` handles the cosmetic cleanup for the response.
fn fs_canonicalize(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    std::fs::canonicalize(path)
}

async fn journal_import(Json(req): Json<JournalImportReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    let target = handle.journal_dir().to_path_buf();
    // Accept either a path that points directly at a `.ade` directory or a
    // parent directory that contains one. This matches what `journal_export`
    // produces (`<dest>/.ade`) and what a user manually copies.
    let source_path = std::path::PathBuf::from(&req.source);
    let source_ade = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| *name == JOURNAL_DIR_NAME)
        .map(|_| source_path.clone())
        .unwrap_or_else(|| source_path.join(JOURNAL_DIR_NAME));
    if !source_ade.is_dir() {
        return Err(AppError(format!("未找到 .ade 目录：{}", source_ade.display())));
    }
    let mut backup: Option<std::path::PathBuf> = None;
    if target.exists() {
        let ts = chrono_like_now_ms();
        let backup_path = handle.root_path().join(format!(".ade.bak-{ts}"));
        std::fs::rename(&target, &backup_path)?;
        backup = Some(backup_path);
    }
    ade_journal::copy_dir_recursive(&source_ade, &target)?;
    Ok(Json(serde_json::json!({
        "importedFrom": project_files::strip_verbatim_prefix(&source_ade).to_string_lossy(),
        "backup": backup.map(|path| project_files::strip_verbatim_prefix(&path).to_string_lossy().to_string()),
    })))
}

async fn journal_compact_events(Json(req): Json<JournalCompactReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    let events_path = handle.journal_dir().join(ade_journal::EVENTS_FILE);
    if !events_path.exists() {
        return Ok(Json(serde_json::json!({ "kept": 0, "archived": 0 })));
    }
    let content = std::fs::read_to_string(&events_path)?;
    let mut lines: Vec<String> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|s| s.to_string())
        .collect();
    let total = lines.len();
    if req.keep_recent == 0 || (total as u64) <= req.keep_recent {
        return Ok(Json(serde_json::json!({ "kept": total, "archived": 0 })));
    }
    let keep_from = total - req.keep_recent as usize;
    let archived: Vec<String> = lines.drain(..keep_from).collect();
    let ts = chrono_like_now_ms();
    let archive_path = handle.journal_dir().join(format!("events-archive-{ts}.jsonl"));
    std::fs::write(&archive_path, format!("{}\n", archived.join("\n")))?;
    std::fs::write(&events_path, format!("{}\n", lines.join("\n")))?;
    Ok(Json(serde_json::json!({
        "kept": lines.len(),
        "archived": total - lines.len(),
        "archive": project_files::strip_verbatim_prefix(&archive_path).to_string_lossy(),
    })))
}

/// Record token usage for a session. The agent terminal hooks this up by
/// regex-matching the agent's output stream for token reports and calling
/// here so the running totals stay up-to-date without user action.
async fn journal_record_tokens(Json(req): Json<JournalTokensReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    let journal = handle
        .record_tokens(&req.session_id, req.input_tokens, req.output_tokens, req.note)
        .map_err(AppError)?;
    Ok(Json(serde_json::to_value(journal).unwrap_or_default()))
}

async fn journal_workspace_load(Query(q): Query<JournalPathReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&q.root_path)?;
    let workspace = handle.load_workspace().map_err(AppError)?;
    Ok(Json(workspace.unwrap_or(serde_json::json!({
        "tabs": [],
        "activeTabId": null,
        "inspectorMode": "files",
    }))))
}

async fn journal_workspace_save(Json(req): Json<JournalWorkspaceReq>) -> Result<Json<Value>, AppError> {
    let handle = open_journal(&req.root_path)?;
    handle.save_workspace(&req.workspace).map_err(AppError)?;
    Ok(Json(serde_json::json!({})))
}

fn chrono_like_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

/// Merge `patch` into `target`. Objects recurse; arrays and primitives
/// replace; explicit JSON `null` removes the key.
fn merge_value(target: &mut Value, patch: &Value) {
    match (target.as_object_mut(), patch.as_object()) {
        (Some(target_map), Some(patch_map)) => {
            for (key, value) in patch_map {
                if value.is_null() {
                    target_map.remove(key);
                    continue;
                }
                if let Some(existing) = target_map.get_mut(key) {
                    if existing.is_object() && value.is_object() {
                        merge_value(existing, value);
                        continue;
                    }
                }
                target_map.insert(key.clone(), value.clone());
            }
        }
        _ => *target = patch.clone(),
    }
}

fn session_to_summary(value: &Value) -> ade_journal::AdeAgentSummary {
    ade_journal::AdeAgentSummary {
        id: value.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        agent_id: value.get("agentId").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        agent_name: value.get("agentName").and_then(|v| v.as_str())
            .or_else(|| value.get("agentId").and_then(|v| v.as_str()))
            .unwrap_or_default()
            .to_string(),
        title: value.get("title").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        status: value.get("status").and_then(|v| v.as_str()).unwrap_or("running").to_string(),
        started_at_ms: value.get("startedAt").and_then(|v| v.as_u64()).unwrap_or_else(chrono_like_now_ms),
        ended_at_ms: value.get("endedAt").and_then(|v| v.as_u64()),
        annotation_ids: value.get("annotationIds")
            .and_then(|v| v.as_array())
            .map(|items| items.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
    }
}

fn merge_agent_summary(target: &mut ade_journal::AdeAgentSummary, patch: &Value) {
    if let Some(value) = patch.get("agentId").and_then(|v| v.as_str()) { target.agent_id = value.to_string(); }
    if let Some(value) = patch.get("agentName").and_then(|v| v.as_str()) { target.agent_name = value.to_string(); }
    if let Some(value) = patch.get("title").and_then(|v| v.as_str()) { target.title = value.to_string(); }
    if let Some(value) = patch.get("status").and_then(|v| v.as_str()) { target.status = value.to_string(); }
    if let Some(value) = patch.get("endedAt").and_then(|v| v.as_u64()) { target.ended_at_ms = Some(value); }
    if let Some(arr) = patch.get("annotationIds").and_then(|v| v.as_array()) {
        target.annotation_ids = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
    }
}

async fn agent_stream(
    State(state): State<AppState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, io::Error>>> {
    let mut rx = state.events.subscribe();
    let s = stream! {
        // "ready" handshake: guarantees the server is subscribed to the event
        // bus before the client starts any agent, so no early output is lost.
        yield Ok(Event::default().data(r#"{"type":"ready"}"#));
        loop {
            match rx.recv().await {
                Ok(event) => match serde_json::to_string(&event) {
                    Ok(json) => yield Ok(Event::default().data(json)),
                    Err(_) => continue,
                },
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(s).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

fn app(dist_dir: &str) -> Router {
    let (events, _rx): (AgentEventSender, _) = broadcast::channel(4096);
    // Drop the initial receiver: clients subscribe via SSE on demand. broadcast
    // keeps the channel open as long as a Sender exists.
    drop(_rx);
    let state = AppState {
        agents: Arc::new(AgentManager::new(events.clone())),
        events,
    };

    let api = Router::new()
        .route("/bootstrap", get(bootstrap))
        .route("/dirs", get(list_dirs))
        .route("/scan", post(scan))
        .route("/read", post(read_file))
        .route("/write", post(write_file))
        .route("/write-binary", post(write_binary_file))
        .route("/write-docx", post(write_docx_file))
        .route("/open", post(open_file))
        .route("/open-folder", post(open_folder))
        .route("/detect-agents", post(detect_agents))
        .route("/agent/start", post(agent_start))
        .route("/agent/write", post(agent_write))
        .route("/agent/resize", post(agent_resize))
        .route("/agent/stop", post(agent_stop))
        .route("/snapshot/create", post(snapshot_create))
        .route("/snapshot/restore", post(snapshot_restore))
        .route("/state", get(state_load).post(state_save))
        .route("/agent/stream", get(agent_stream))
        .route("/journal/summary", get(journal_summary))
        .route("/journal/load", get(journal_load))
        .route("/journal/events", get(journal_events))
        .route("/journal/log-event", post(journal_log_event))
        .route("/journal/append-annotation", post(journal_append_annotation))
        .route("/journal/update-annotation", post(journal_update_annotation))
        .route("/journal/delete-annotation", post(journal_delete_annotation))
        .route("/journal/upsert-agent", post(journal_upsert_agent))
        .route("/journal/snapshot-create", post(journal_snapshot_create))
        .route("/journal/snapshot-restore", post(journal_snapshot_restore))
        .route("/journal/open-folder", post(journal_open_folder))
        .route("/journal/export", post(journal_export))
        .route("/journal/import", post(journal_import))
        .route("/journal/compact-events", post(journal_compact_events))
        .route("/journal/record-tokens", post(journal_record_tokens))
        .route("/journal/workspace", get(journal_workspace_load).post(journal_workspace_save))
        .with_state(state);

    // The docx save path ships the edited document as HTML, which for a real
    // paper carries every embedded image as a base64 `data:` URL and easily
    // clears axum's default 2 MiB Json body limit. Hitting that limit makes
    // axum reset the connection mid-upload, which browsers surface as a
    // opaque "TypeError: Failed to fetch" on the Save button. Raise the cap
    // for the whole API (write/write-binary/write-docx/journal all take
    // caller-supplied content) to something a large document can fit through.
    let api = api.layer(DefaultBodyLimit::max(100 * 1024 * 1024));

    // Production: serve the built frontend. Dev uses Vite (proxies /api to us).
    let serve = ServeDir::new(dist_dir).fallback(ServeFile::new(format!("{dist_dir}/index.html")));

    Router::new()
        .nest("/api", api)
        .fallback_service(serve)
        // No CORS layer: the UI is same-origin in both dev (Vite proxies /api)
        // and prod (ServeDir on this host). Blocking cross-origin access
        // prevents a malicious website from driving the local API (which can
        // spawn processes / write files).
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("ADE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1717);
    let dist_dir = std::env::var("ADE_DIST_DIR").unwrap_or_else(|_| "dist".to_string());
    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("failed to bind ADE server");
    println!("ADE server listening on http://{addr} (dist: {dist_dir})");
    axum::serve(listener, app(&dist_dir)).await.expect("ADE server error");
}
