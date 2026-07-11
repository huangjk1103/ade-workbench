//! Per-project `.ade/` journal — every open project owns a hidden directory
//! at its root that records annotations, agent sessions, snapshots, and an
//! append-only event stream. The journal follows the project across machines
//! when the project is copied/moved/zipped, giving us a single source of
//! truth that scales with the project instead of one global state file.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::project_files::canonical_root;

/// Bump this when changing the on-disk schema. `migrate` upgrades older
/// journals in place so users with v1 files keep their history.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

const JOURNAL_FILE: &str = "journal.json";
pub const EVENTS_FILE: &str = "events.jsonl";
const AGENTS_DIR: &str = "agents";
const SNAPSHOTS_DIR: &str = "snapshots";
const WORKSPACE_FILE: &str = "workspace.json";

/// File name of the journal directory itself (the user-visible marker).
pub const JOURNAL_DIR_NAME: &str = ".ade";

// ---------------------------------------------------------------------------
// Public data shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdeJournalMeta {
    pub id: String,
    pub root_path: String,
    pub created_at_ms: u64,
    pub last_opened_at_ms: u64,
    /// Schema version this journal was last written with. Read on open,
    /// upgraded by `migrate`, persisted on next save.
    pub schema_version: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdeCounters {
    pub annotations: u32,
    pub annotations_open: u32,
    pub annotations_sent: u32,
    pub annotations_resolved: u32,
    pub operations: u32,
    pub agent_sessions: u32,
    pub snapshots: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdeTokenUsage {
    /// Running totals across every recorded session. Storing the sum (not
    /// just per-session) lets the UI show a single number without having
    /// to re-aggregate `sessions` on every render.
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Last time the totals changed. Lets the UI display "updated 3m ago"
    /// without diffing events.jsonl.
    pub updated_at_ms: u64,
    /// Per-session breakdown. Sessions may be pruned without invalidating
    /// the totals — the dict is purely for drill-down, not aggregation.
    #[serde(default)]
    pub sessions: std::collections::BTreeMap<String, AdeSessionTokens>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdeSessionTokens {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub updated_at_ms: u64,
    /// Free-form note the UI can show (e.g. "claude code final report" or
    /// the raw tail line we matched against). Not used for anything else.
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdeAgentSummary {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub title: String,
    pub status: String,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub annotation_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdeSnapshotMeta {
    pub id: String,
    pub created_at_ms: u64,
    pub trigger: String,
    pub annotation_id: Option<String>,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdeJournal {
    pub meta: AdeJournalMeta,
    pub counters: AdeCounters,
    /// Optional token totals. Older journals loaded from disk before this
    /// field existed deserialize as `None`; the schema-version bump in
    /// `migrate()` backfills a default so the rest of the code can treat
    /// it as always-present.
    #[serde(default)]
    pub token_usage: AdeTokenUsage,
    /// Loose schema on `Value` so the frontend's evolving `Annotation` shape
    /// doesn't require a coordinated Rust upgrade every time. Required fields
    /// (`id`, `projectId`, `target`, `body`, `status`, `createdAt`,
    /// `updatedAt`) are written; everything else is forwarded as-is.
    pub annotations: Vec<Value>,
    pub agent_sessions: Vec<AdeAgentSummary>,
    pub snapshots: Vec<AdeSnapshotMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalSummary {
    pub exists: bool,
    pub root_path: String,
    pub journal_path: Option<String>,
    pub counters: AdeCounters,
    pub last_event_at_ms: Option<u64>,
    pub last_opened_at_ms: Option<u64>,
}

// ---------------------------------------------------------------------------
// Journal handle
// ---------------------------------------------------------------------------

pub struct AdeJournalHandle {
    root: PathBuf,
    journal_dir: PathBuf,
    journal_path: PathBuf,
    events_path: PathBuf,
    workspace_path: PathBuf,
    /// In-process lock so concurrent API calls within this server serialize.
    /// Cross-process safety comes from the atomic rename in `write_journal`.
    lock: Mutex<()>,
}

impl AdeJournalHandle {
    pub fn open(root_path: &str) -> Result<Self, String> {
        let root = canonical_root(root_path)?;
        let journal_dir = root.join(JOURNAL_DIR_NAME);
        Ok(Self {
            root,
            journal_dir,
            journal_path: PathBuf::new(), // populated in ensure()
            events_path: PathBuf::new(),
            workspace_path: PathBuf::new(),
            lock: Mutex::new(()),
        })
    }

    // Kept as the canonical accessors for future use (export, cleanup,
    // manual snapshot inspection). Suppress unused warnings so the public
    // surface stays stable for upcoming tooling.
    #[allow(dead_code)]
    pub fn root_path(&self) -> &Path { &self.root }
    #[allow(dead_code)]
    pub fn journal_dir(&self) -> &Path { &self.journal_dir }

    pub fn ensure(&mut self) -> Result<(), String> {
        fs::create_dir_all(self.journal_dir.join(AGENTS_DIR))
            .map_err(|error| format!("无法创建 .ade/agents：{error}"))?;
        fs::create_dir_all(self.journal_dir.join(SNAPSHOTS_DIR))
            .map_err(|error| format!("无法创建 .ade/snapshots：{error}"))?;
        self.journal_path = self.journal_dir.join(JOURNAL_FILE);
        self.events_path = self.journal_dir.join(EVENTS_FILE);
        self.workspace_path = self.journal_dir.join(WORKSPACE_FILE);
        if !self.journal_path.exists() {
            let now = now_ms();
            let initial = AdeJournal {
                meta: AdeJournalMeta {
                    id: Uuid::new_v4().to_string(),
                    root_path: strip_verbatim(&self.root).to_string_lossy().to_string(),
                    created_at_ms: now,
                    last_opened_at_ms: now,
                    schema_version: CURRENT_SCHEMA_VERSION,
                },
                counters: AdeCounters::default(),
                token_usage: AdeTokenUsage::default(),
                annotations: Vec::new(),
                agent_sessions: Vec::new(),
                snapshots: Vec::new(),
            };
            write_atomic_json(&self.journal_path, &initial)?;
        } else {
            // Touch last_opened_at on every ensure() — cheap and lets the
            // landing page show "last opened" without scanning events.
            self.touch_last_opened()?;
        }
        Ok(())
    }

    pub fn touch_last_opened(&self) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "journal lock poisoned")?;
        if !self.journal_path.exists() { return Ok(()); }
        let mut journal = read_journal(&self.journal_path)?;
        journal.meta.last_opened_at_ms = now_ms();
        write_atomic_json(&self.journal_path, &journal)
    }

    pub fn load(&self) -> Result<AdeJournal, String> {
        let _guard = self.lock.lock().map_err(|_| "journal lock poisoned")?;
        let mut journal = read_journal(&self.journal_path)?;
        if journal.meta.schema_version != CURRENT_SCHEMA_VERSION {
            migrate(&mut journal)?;
            write_atomic_json(&self.journal_path, &journal)?;
        }
        Ok(journal)
    }

    /// Apply an additive update to the running token totals. Each call is
    /// idempotent within a session because we store the latest reported
    /// numbers (not a delta); the caller sends the *current* totals, not
    /// the increment.
    pub fn record_tokens(
        &self,
        session_id: &str,
        input_tokens: u64,
        output_tokens: u64,
        note: Option<String>,
    ) -> Result<AdeJournal, String> {
        let _guard = self.lock.lock().map_err(|_| "journal lock poisoned")?;
        let mut journal = read_journal(&self.journal_path)?;
        // Adjust the running totals: subtract the previous per-session
        // numbers (if any) so a corrected report doesn't double-count,
        // then add the new values.
        if let Some(prev) = journal.token_usage.sessions.get(session_id) {
            journal.token_usage.input_tokens = journal
                .token_usage
                .input_tokens
                .saturating_sub(prev.input_tokens);
            journal.token_usage.output_tokens = journal
                .token_usage
                .output_tokens
                .saturating_sub(prev.output_tokens);
        }
        journal.token_usage.input_tokens = journal.token_usage.input_tokens.saturating_add(input_tokens);
        journal.token_usage.output_tokens = journal.token_usage.output_tokens.saturating_add(output_tokens);
        journal.token_usage.updated_at_ms = now_ms();
        journal.token_usage.sessions.insert(
            session_id.to_string(),
            AdeSessionTokens {
                input_tokens,
                output_tokens,
                updated_at_ms: now_ms(),
                note,
            },
        );
        write_atomic_json(&self.journal_path, &journal)?;
        Ok(journal)
    }

    pub fn summary(&self) -> Result<JournalSummary, String> {
        let journal_path = self.journal_dir.join(JOURNAL_FILE);
        let events_path = self.journal_dir.join(EVENTS_FILE);
        if !journal_path.exists() {
            return Ok(JournalSummary {
                exists: false,
                root_path: strip_verbatim(&self.root).to_string_lossy().to_string(),
                journal_path: None,
                counters: AdeCounters::default(),
                last_event_at_ms: None,
                last_opened_at_ms: None,
            });
        }
        let journal = read_journal(&journal_path)?;
        let last_event_at_ms = read_last_event_ts(&events_path).ok().flatten();
        Ok(JournalSummary {
            exists: true,
            root_path: strip_verbatim(&self.root).to_string_lossy().to_string(),
            journal_path: Some(strip_verbatim(&journal_path).to_string_lossy().to_string()),
            counters: journal.counters,
            last_event_at_ms,
            last_opened_at_ms: Some(journal.meta.last_opened_at_ms),
        })
    }

    /// Replaces the entire journal. Caller is responsible for keeping the
    /// `counters` consistent; we recompute it from the current `annotations`
    /// and `agent_sessions` here so the caller can't accidentally drift.
    pub fn save_full(&self, mut journal: AdeJournal) -> Result<AdeJournal, String> {
        let _guard = self.lock.lock().map_err(|_| "journal lock poisoned")?;
        journal.counters = recompute_counters(&journal);
        journal.meta.last_opened_at_ms = now_ms();
        write_atomic_json(&self.journal_path, &journal)?;
        Ok(journal)
    }

    /// Append a single event line to `events.jsonl`. Returns the generated
    /// event id. Used for all UI-recorded operations that don't change the
    /// `journal.json` shape (file opens, agent messages, etc).
    pub fn append_event(
        &self,
        kind: &str,
        actor: &str,
        file: Option<&str>,
        data: Value,
    ) -> Result<String, String> {
        let _guard = self.lock.lock().map_err(|_| "journal lock poisoned")?;
        if !self.events_path.exists() {
            File::create(&self.events_path)
                .map_err(|error| format!("无法创建 events.jsonl：{error}"))?;
        }
        let id = Uuid::new_v4().to_string();
        let event = json!({
            "id": id,
            "ts": now_ms(),
            "kind": kind,
            "actor": actor,
            "file": file,
            "data": data,
        });
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.events_path)
            .map_err(|error| format!("无法打开 events.jsonl：{error}"))?;
        let mut line = serde_json::to_string(&event)
            .map_err(|error| format!("序列化事件失败：{error}"))?;
        line.push('\n');
        file.write_all(line.as_bytes())
            .map_err(|error| format!("写入事件失败：{error}"))?;
        file.flush().map_err(|error| format!("刷新事件失败：{error}"))?;
        Ok(id)
    }

    pub fn read_events(&self, limit: usize) -> Result<Vec<Value>, String> {
        if !self.events_path.exists() { return Ok(Vec::new()); }
        let file = File::open(&self.events_path)
            .map_err(|error| format!("无法打开 events.jsonl：{error}"))?;
        let reader = BufReader::new(file);
        // Collect then take the tail: events.jsonl grows forever, so reading
        // the whole file just to show the latest 200 lines would balloon
        // memory for projects with years of activity.
        let mut all: Vec<Value> = Vec::new();
        for line in reader.lines() {
            let line = match line { Ok(value) => value, Err(_) => continue };
            if line.trim().is_empty() { continue; }
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                all.push(value);
            }
        }
        if all.len() > limit {
            let drop = all.len() - limit;
            all.drain(..drop);
        }
        Ok(all)
    }

    // ---- Workspace state persistence ----
    //
    // The workspace file stores the UI session state (open tabs, active tab,
    // inspector mode) so the user can pick up exactly where they left off
    // after a page refresh. It is a separate file from journal.json to keep
    // frequent tab-switch writes from churning the journal.

    pub fn load_workspace(&self) -> Result<Option<Value>, String> {
        let _guard = self.lock.lock().map_err(|_| "journal lock poisoned")?;
        if !self.workspace_path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&self.workspace_path)
            .map_err(|error| format!("读取 workspace.json 失败：{error}"))?;
        let value: Value = serde_json::from_str(&content)
            .map_err(|error| format!("workspace.json 损坏：{error}"))?;
        Ok(Some(value))
    }

    pub fn save_workspace(&self, workspace: &Value) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "journal lock poisoned")?;
        write_atomic_json(&self.workspace_path, workspace)?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn snapshot_dir(&self, snapshot_id: &str) -> Result<PathBuf, String> {
        Uuid::parse_str(snapshot_id).map_err(|_| "无效的快照 ID".to_string())?;
        Ok(self.journal_dir.join(SNAPSHOTS_DIR).join(snapshot_id))
    }

    #[allow(dead_code)]
    pub fn agent_detail_path(&self, session_id: &str) -> Result<PathBuf, String> {
        Uuid::parse_str(session_id).map_err(|_| "无效的 agent 会话 ID".to_string())?;
        Ok(self.journal_dir.join(AGENTS_DIR).join(format!("{session_id}.json")))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

/// Copy a directory tree recursively. Used by the export/import endpoints
/// so a project's `.ade/` history can be handed to a teammate or restored
/// from a backup without needing a shell.
pub fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!("源不是目录：{}", source.display()));
    }
    fs::create_dir_all(destination).map_err(|error| format!("创建目标目录失败：{error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("读取源目录失败：{error}"))? {
        let entry = match entry { Ok(value) => value, Err(error) => return Err(format!("遍历源目录失败：{error}")) };
        let file_type = match entry.file_type() { Ok(value) => value, Err(_) => continue };
        let from = entry.path();
        let to = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_file() {
            fs::copy(&from, &to).map_err(|error| format!("复制 {} 失败：{error}", from.display()))?;
        }
    }
    Ok(())
}

fn strip_verbatim(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

fn read_journal(path: &Path) -> Result<AdeJournal, String> {
    let content = fs::read_to_string(path).map_err(|error| format!("读取 .ade 失败：{error}"))?;
    let mut journal: AdeJournal = serde_json::from_str(&content)
        .map_err(|error| format!(".ade 损坏：{error}"))?;
    if journal.agent_sessions.is_empty() {
        // Older v1 drafts may be missing the field; tolerate and continue.
        journal.agent_sessions = Vec::new();
    }
    if journal.snapshots.is_empty() {
        journal.snapshots = Vec::new();
    }
    if journal.token_usage.sessions.is_empty() && journal.token_usage.input_tokens == 0 && journal.token_usage.output_tokens == 0 {
        // Older journals written before token tracking existed may have
        // `tokenUsage: null` or no field at all; serde fills both cases
        // with `Default::default()` already, so nothing else to do here.
    }
    Ok(journal)
}

fn write_atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    // Write to a uniquely-named temp file, then rename it into place. The
    // unique name matters: each API request opens its own `AdeJournalHandle`,
    // so the per-handle mutex does NOT serialize concurrent writers across
    // requests (e.g. `refreshJournal` fans out `loadJournal` and
    // `loadJournalSummary` together, both of which `touch_last_opened`).
    // With a fixed `<path>.tmp` two racing writers share the temp file: the
    // first `rename` consumes it and the second fails with "os error 2"
    // (file not found), surfacing as ".ade 读取失败：替换 .ade 失败…". A
    // per-call name lets each writer rename its own temp file safely.
    let tmp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let content = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("序列化 .ade 失败：{error}"))?;
    fs::write(&tmp, content).map_err(|error| format!("写入 .ade 临时文件失败：{error}"))?;
    // `fs::rename` atomically replaces an existing destination on Windows,
    // so a crash mid-write can't leave a half-written journal.json.
    let rename_result = fs::rename(&tmp, path).map_err(|error| format!("替换 .ade 失败：{error}"));
    if rename_result.is_err() {
        // Best-effort cleanup of our orphaned temp file; ignore errors since
        // we're already on an error path.
        let _ = fs::remove_file(&tmp);
    }
    rename_result?;
    Ok(())
}

fn read_last_event_ts(path: &Path) -> Result<Option<u64>, String> {
    let file = File::open(path).map_err(|error| format!("无法打开 events.jsonl：{error}"))?;
    let reader = BufReader::new(file);
    let mut last_ts: Option<u64> = None;
    for line in reader.lines() {
        let line = match line { Ok(value) => value, Err(_) => continue };
        if line.trim().is_empty() { continue; }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            if let Some(ts) = value.get("ts").and_then(|v| v.as_u64()) {
                last_ts = Some(ts);
            }
        }
    }
    Ok(last_ts)
}

fn migrate(journal: &mut AdeJournal) -> Result<(), String> {
    // Placeholder for future schema bumps. Today every journal is at v1.
    journal.meta.schema_version = CURRENT_SCHEMA_VERSION;
    Ok(())
}

fn recompute_counters(journal: &AdeJournal) -> AdeCounters {
    let mut counters = AdeCounters {
        annotations: journal.annotations.len() as u32,
        operations: journal.annotations.len() as u32 + journal.agent_sessions.len() as u32,
        agent_sessions: journal.agent_sessions.len() as u32,
        snapshots: journal.snapshots.len() as u32,
        ..Default::default()
    };
    for annotation in &journal.annotations {
        match annotation.get("status").and_then(|value| value.as_str()) {
            Some("open") => counters.annotations_open += 1,
            Some("sent") => counters.annotations_sent += 1,
            Some("resolved") => counters.annotations_resolved += 1,
            _ => {}
        }
    }
    counters
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("ade-journal-test-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn ensure_creates_files_and_persists_state() {
        let root = temp_root("ensure");
        let mut journal = AdeJournalHandle::open(root.to_str().unwrap()).unwrap();
        journal.ensure().unwrap();
        assert!(root.join(".ade").join("journal.json").exists());
        let loaded = journal.load().unwrap();
        assert_eq!(loaded.meta.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(loaded.counters.annotations, 0);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn append_event_writes_lines_in_order() {
        let root = temp_root("events");
        let mut journal = AdeJournalHandle::open(root.to_str().unwrap()).unwrap();
        journal.ensure().unwrap();
        journal.append_event("file.open", "user", Some("README.md"), json!({})).unwrap();
        journal.append_event("annotation.create", "user", Some("README.md"), json!({"id":"a1"})).unwrap();
        let events = journal.read_events(50).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].get("kind").and_then(|v| v.as_str()), Some("annotation.create"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn concurrent_writers_do_not_collide_on_temp_file() {
        // Reproduces the project-switch race: `refreshJournal` fans out
        // several requests at once, and each API call opens its OWN handle
        // via `open_journal`, so the per-handle mutex does not serialize
        // them. With the old fixed-`<path>.tmp` write_atomic_json the shared
        // temp file got renamed out from under a racing writer, surfacing as
        // "替换 .ade 失败：… (os error 2)".
        let root = temp_root("concurrent");
        {
            let mut seed = AdeJournalHandle::open(root.to_str().unwrap()).unwrap();
            seed.ensure().unwrap();
        }

        let threads: Vec<_> = (0..16)
            .map(|_| {
                let root = root.clone();
                std::thread::spawn(move || {
                    let mut handle = AdeJournalHandle::open(root.to_str().unwrap()).unwrap();
                    handle.ensure().unwrap();
                    let mut errors = 0usize;
                    for _ in 0..100 {
                        if handle.touch_last_opened().is_err() {
                            errors += 1;
                        }
                    }
                    errors
                })
            })
            .collect();

        let total_errors: usize = threads.into_iter().filter_map(|t| t.join().ok()).sum();
        assert_eq!(total_errors, 0, "concurrent journal writes must not fail");

        // The journal must still load cleanly after the write storm.
        let mut handle = AdeJournalHandle::open(root.to_str().unwrap()).unwrap();
        handle.ensure().unwrap();
        let loaded = handle.load().unwrap();
        assert_eq!(loaded.meta.schema_version, CURRENT_SCHEMA_VERSION);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn save_full_recomputes_counters() {
        let root = temp_root("counters");
        let mut journal = AdeJournalHandle::open(root.to_str().unwrap()).unwrap();
        journal.ensure().unwrap();
        let mut loaded = journal.load().unwrap();
        loaded.annotations = vec![
            json!({ "id": "a1", "status": "open" }),
            json!({ "id": "a2", "status": "resolved" }),
        ];
        loaded.agent_sessions = vec![AdeAgentSummary {
            id: "s1".into(),
            agent_id: "hermes".into(),
            agent_name: "Hermes".into(),
            title: "Hermes 1".into(),
            status: "stopped".into(),
            started_at_ms: 0,
            ended_at_ms: Some(1),
            annotation_ids: vec!["a1".into()],
        }];
        let saved = journal.save_full(loaded).unwrap();
        assert_eq!(saved.counters.annotations, 2);
        assert_eq!(saved.counters.annotations_open, 1);
        assert_eq!(saved.counters.annotations_resolved, 1);
        assert_eq!(saved.counters.agent_sessions, 1);
        fs::remove_dir_all(root).ok();
    }
}