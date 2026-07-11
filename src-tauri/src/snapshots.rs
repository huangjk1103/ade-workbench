use std::fs;
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::model::SnapshotInfo;
use crate::project_files::{canonical_root, safe_existing_path};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    root_path: String,
    files: Vec<String>,
}

fn snapshots_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("snapshots");
    fs::create_dir_all(&path).map_err(|error| format!("无法创建快照目录：{error}"))?;
    Ok(path)
}

fn safe_restore_target(root: &Path, relative_path: &str) -> Result<std::path::PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
        })
    {
        return Err("快照包含非法路径".into());
    }
    let target = root.join(relative);
    let parent = target.parent().ok_or("快照目标没有父目录")?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| format!("恢复目标目录不存在：{error}"))?;
    if !canonical_parent.starts_with(root) {
        return Err("拒绝将快照恢复到项目目录之外".into());
    }
    Ok(target)
}

#[tauri::command]
pub fn create_task_snapshot(
    app: AppHandle,
    root_path: String,
    relative_paths: Vec<String>,
) -> Result<SnapshotInfo, String> {
    let root = canonical_root(&root_path)?;
    let snapshot_id = Uuid::new_v4().to_string();
    let snapshot_dir = snapshots_root(&app)?.join(&snapshot_id);
    let files_dir = snapshot_dir.join("files");
    fs::create_dir_all(&files_dir).map_err(|error| format!("无法创建任务快照：{error}"))?;

    let mut copied = Vec::new();
    for relative_path in relative_paths {
        let (_, source) = safe_existing_path(&root_path, &relative_path)?;
        if !source.is_file() {
            continue;
        }
        let destination = files_dir.join(Path::new(&relative_path));
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&source, &destination).map_err(|error| format!("创建文件快照失败：{error}"))?;
        copied.push(relative_path);
    }
    let manifest = SnapshotManifest {
        root_path: root.to_string_lossy().to_string(),
        files: copied.clone(),
    };
    let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    fs::write(snapshot_dir.join("manifest.json"), manifest_json)
        .map_err(|error| format!("写入快照清单失败：{error}"))?;
    Ok(SnapshotInfo { id: snapshot_id, files: copied })
}

#[tauri::command]
pub fn restore_task_snapshot(
    app: AppHandle,
    root_path: String,
    snapshot_id: String,
) -> Result<Vec<String>, String> {
    let root = canonical_root(&root_path)?;
    let snapshot_dir = snapshots_root(&app)?.join(&snapshot_id);
    let manifest_content = fs::read(snapshot_dir.join("manifest.json"))
        .map_err(|error| format!("快照不存在：{error}"))?;
    let manifest: SnapshotManifest = serde_json::from_slice(&manifest_content)
        .map_err(|error| format!("快照清单损坏：{error}"))?;
    let manifest_root = fs::canonicalize(&manifest.root_path)
        .map_err(|error| format!("快照原项目不可用：{error}"))?;
    if manifest_root != root {
        return Err("快照不属于当前项目".into());
    }
    for relative_path in &manifest.files {
        let source = snapshot_dir.join("files").join(Path::new(relative_path));
        let target = safe_restore_target(&root, relative_path)?;
        fs::copy(source, target).map_err(|error| format!("恢复快照失败：{error}"))?;
    }
    Ok(manifest.files)
}

