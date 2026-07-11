use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use uuid::Uuid;

use crate::model::{
    AgentDescriptor, AgentDetection, AgentEvent, AgentEventSender, AgentStartRequest, AgentStarted,
};
use crate::project_files::strip_verbatim_prefix;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

pub struct AgentManager {
    // Arc<Mutex<..>> so the reader thread can remove the session on natural exit
    // without holding a reference to the whole AgentManager.
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    events: AgentEventSender,
}

impl AgentManager {
    pub fn new(events: AgentEventSender) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            events,
        }
    }
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

impl AgentManager {
    pub fn start(&self, request: AgentStartRequest) -> Result<AgentStarted, String> {
        let cwd = std::fs::canonicalize(&request.cwd)
            .map_err(|error| format!("Agent 工作目录不可用：{error}"))?;
        if !cwd.is_dir() {
            return Err("Agent 工作目录不是文件夹".into());
        }
        // CreateProcessW does not reliably accept `\\?\`-prefixed cwd paths, so
        // strip the verbatim prefix that canonicalize adds on Windows.
        let cwd = strip_verbatim_prefix(&cwd);
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
        let events = self.events.clone();
        let sessions = self.sessions.clone();
        let reader_session_id = session_id.clone();
        thread::spawn(move || {
            let mut leftover: Vec<u8> = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let length = match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                leftover.extend_from_slice(&buffer[..length]);
                // Decode only up to the last complete UTF-8 boundary so a
                // multi-byte character straddling the 8 KB read boundary is
                // not turned into U+FFFD replacement chars.
                let cut = match std::str::from_utf8(&leftover) {
                    Ok(_) => leftover.len(),
                    Err(error) => error.valid_up_to(),
                };
                if cut > 0 {
                    let data = std::str::from_utf8(&leftover[..cut])
                        .unwrap_or("")
                        .to_string();
                    let _ = events.send(AgentEvent::Output {
                        session_id: reader_session_id.clone(),
                        data,
                    });
                    leftover = leftover[cut..].to_vec();
                }
            }
            let remove_id = reader_session_id.clone();
            let _ = events.send(AgentEvent::Exit {
                session_id: reader_session_id,
                reason: "process-ended".into(),
            });
            // Drop the session on natural exit so PTY handles don't leak.
            if let Ok(mut sessions) = sessions.lock() {
                sessions.remove(&remove_id);
            }
        });

        self.sessions
            .lock()
            .map_err(|_| "Agent 会话锁损坏".to_string())?
            .insert(
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

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Agent 会话锁损坏".to_string())?;
        let session = sessions.get_mut(session_id).ok_or("Agent 会话不存在")?;
        session
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| session.writer.flush())
            .map_err(|error| format!("写入 Agent 失败：{error}"))
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Agent 会话锁损坏".to_string())?;
        let session = sessions.get(session_id).ok_or("Agent 会话不存在")?;
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

    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        // Idempotent for an already-removed session. Kill before removing so a
        // kill failure leaves the session retryable rather than orphaned.
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Agent 会话锁损坏".to_string())?;
        // Kill while the get_mut borrow is live, then drop it before removing.
        let kill_result = match sessions.get_mut(session_id) {
            Some(session) => session.child.kill(),
            None => return Ok(()),
        };
        match kill_result {
            Ok(()) => {
                sessions.remove(session_id);
                Ok(())
            }
            Err(error) => Err(format!("停止 Agent 失败：{error}")),
        }
    }
}
