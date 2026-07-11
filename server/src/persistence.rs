use std::fs;

use serde_json::{json, Value};

fn state_path() -> Result<std::path::PathBuf, String> {
    let directory = dirs::data_dir()
        .ok_or_else(|| "无法定位应用数据目录".to_string())?
        .join("ade-workbench");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(directory.join("state.json"))
}

pub fn load_persisted_state() -> Result<Value, String> {
    let path = state_path()?;
    if !path.exists() {
        return Ok(json!({
            "version": 1,
            "projects": [],
            "annotations": [],
            "agentDefinitions": []
        }));
    }
    let content = fs::read_to_string(&path).map_err(|error| format!("读取应用状态失败：{error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("应用状态文件损坏：{error}"))
}

pub fn save_persisted_state(state: Value) -> Result<(), String> {
    let path = state_path()?;
    let content = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    fs::write(path, content.as_bytes()).map_err(|error| format!("保存应用状态失败：{error}"))
}
