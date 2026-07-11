use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::model::{
    AgentDescriptor, AgentDetection, AgentExitEvent, AgentOutputEvent, AgentStartRequest,
    AgentStarted,
};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct AgentManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

fn resolve_command(command: &str) -> Option<PathBuf> {
    let direct = Path::new(command);
    if direct.exists() {
        return std::fs::canonicalize(direct).ok();
    }
    let output = Command::new("where.exe").arg(command).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let candidates: Vec<PathBuf> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect();
    // On Windows, `where.exe` returns multiple matches. The first match is
    // often an extensionless Unix shell script that CreateProcessW cannot
    // execute (os error 193). Prefer Windows-executable extensions.
    let preferred = ["exe", "cmd", "bat", "ps1"];
    candidates
        .iter()
        .find(|path| {
            path.extension()
                .and_then(OsStr::to_str)
                .map(|ext| preferred.contains(&ext.to_ascii_lowercase().as_str()))
                .unwrap_or(false)
        })
        .or_else(|| candidates.first())
        .cloned()
}

fn command_builder(resolved: &Path, args: &[String]) -> CommandBuilder {
    let extension = resolved
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "cmd" || extension == "bat" {
        let mut builder = CommandBuilder::new("cmd.exe");
        builder.args(["/d", "/s", "/c"]);
        builder.arg(resolved.as_os_str());
        builder.args(args);
        return builder;
    }
    if extension == "ps1" {
        let mut builder = CommandBuilder::new("powershell.exe");
        builder.args(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
        builder.arg(resolved.as_os_str());
        builder.args(args);
        return builder;
    }
    let mut builder = CommandBuilder::new(resolved.as_os_str());
    builder.args(args);
    builder
}

#[tauri::command]
pub fn detect_agents(agents: Vec<AgentDescriptor>) -> Vec<AgentDetection> {
    agents
        .into_iter()
        .map(|agent| {
            let resolved = resolve_command(&agent.command);
            AgentDetection {
                id: agent.id,
                name: agent.name,
                available: resolved.is_some(),
                resolved_path: resolved.map(|path| path.to_string_lossy().to_string()),
            }
        })
        .collect()
}

#[tauri::command]
pub fn start_agent(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    request: AgentStartRequest,
) -> Result<AgentStarted, String> {
    let cwd = std::fs::canonicalize(&request.cwd)
        .map_err(|error| format!("Agent 工作目录不可用：{error}"))?;
    if !cwd.is_dir() {
        return Err("Agent 工作目录不是文件夹".into());
    }
    let resolved = resolve_command(&request.command)
        .ok_or_else(|| format!("未找到 Agent 命令：{}", request.command))?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: request.rows.max(2),
            cols: request.cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("创建 ConPTY 失败：{error}"))?;

    let mut builder = command_builder(&resolved, &request.args);
    builder.cwd(&cwd);
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    builder.env("FORCE_COLOR", "1");
    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|error| format!("启动 Agent 失败：{error}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("连接 Agent 输出失败：{error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("连接 Agent 输入失败：{error}"))?;
    let session_id = Uuid::new_v4().to_string();
    let event_session_id = session_id.clone();
    let event_app = app.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    let data = String::from_utf8_lossy(&buffer[..length]).to_string();
                    let _ = event_app.emit(
                        "agent-output",
                        AgentOutputEvent {
                            session_id: event_session_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = event_app.emit(
            "agent-exit",
            AgentExitEvent {
                session_id: event_session_id,
                reason: "process-ended".into(),
            },
        );
    });

    manager.sessions.lock().map_err(|_| "Agent 会话锁损坏".to_string())?.insert(
        session_id.clone(),
        PtySession {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(AgentStarted {
        session_id,
        agent_id: request.agent_id,
    })
}

#[tauri::command]
pub fn write_agent(
    manager: State<'_, AgentManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().map_err(|_| "Agent 会话锁损坏".to_string())?;
    let session = sessions.get_mut(&session_id).ok_or("Agent 会话不存在")?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|error| format!("写入 Agent 失败：{error}"))
}

#[tauri::command]
pub fn resize_agent(
    manager: State<'_, AgentManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = manager.sessions.lock().map_err(|_| "Agent 会话锁损坏".to_string())?;
    let session = sessions.get(&session_id).ok_or("Agent 会话不存在")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("调整 Agent 终端失败：{error}"))
}

#[tauri::command]
pub fn stop_agent(
    manager: State<'_, AgentManager>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = manager.sessions.lock().map_err(|_| "Agent 会话锁损坏".to_string())?;
    let mut session = sessions.remove(&session_id).ok_or("Agent 会话不存在")?;
    session.child.kill().map_err(|error| format!("停止 Agent 失败：{error}"))
}

