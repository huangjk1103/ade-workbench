use std::fs;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn state_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(directory.join("state.json"))
}

#[tauri::command]
pub fn load_persisted_state(app: AppHandle) -> Result<Value, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(json!({
            "version": 1,
            "projects": [],
            "annotations": [],
            "agentDefinitions": []
        }));
    }
    let content = fs::read_to_string(path).map_err(|error| format!("读取应用状态失败：{error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("应用状态文件损坏：{error}"))
}

#[tauri::command]
pub fn save_persisted_state(app: AppHandle, state: Value) -> Result<(), String> {
    let path = state_path(&app)?;
    let content = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    fs::write(path, content.as_bytes()).map_err(|error| format!("保存应用状态失败：{error}"))
}

