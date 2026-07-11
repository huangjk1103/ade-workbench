use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

use serde::{Deserialize, Serialize};

use crate::model::SnapshotInfo;
use crate::project_files::{canonical_root, safe_existing_path};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    root_path: String,
    files: Vec<String>,
}

fn data_dir() -> Result<PathBuf, String> {
    let dir = dirs::data_dir()
        .ok_or_else(|| "无法定位应用数据目录".to_string())?
        .join("ade-workbench");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(dir)
}

fn snapshots_root() -> Result<PathBuf, String> {
    let path = data_dir()?.join("snapshots");
    fs::create_dir_all(&path).map_err(|error| format!("无法创建快照目录：{error}"))?;
    Ok(path)
}

fn safe_restore_target(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
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
    let canonical_parent =
        fs::canonicalize(parent).map_err(|error| format!("恢复目标目录不存在：{error}"))?;
    if !canonical_parent.starts_with(root) {
        return Err("拒绝将快照恢复到项目目录之外".into());
    }
    let name = target.file_name().ok_or("快照目标没有文件名")?;
    let target = canonical_parent.join(name);
    // If the leaf already exists (possibly a symlink), canonicalize it and
    // re-check so we don't write through a symlink that escapes the project.
    if target.exists() {
        let canonical_target =
            fs::canonicalize(&target).map_err(|error| format!("恢复目标不可访问：{error}"))?;
        if !canonical_target.starts_with(root) {
            return Err("拒绝将快照恢复到项目目录之外".into());
        }
        Ok(canonical_target)
    } else {
        Ok(target)
    }
}

pub fn create_task_snapshot(root_path: &str, relative_paths: &[String]) -> Result<SnapshotInfo, String> {
    let root = canonical_root(root_path)?;
    let snapshot_id = Uuid::new_v4().to_string();
    let snapshot_dir = snapshots_root()?.join(&snapshot_id);
    let files_dir = snapshot_dir.join("files");
    fs::create_dir_all(&files_dir).map_err(|error| format!("无法创建任务快照：{error}"))?;

    let mut copied = Vec::new();
    for relative_path in relative_paths {
        let (_, source) = safe_existing_path(root_path, relative_path)?;
        if !source.is_file() {
            continue;
        }
        let destination = files_dir.join(Path::new(relative_path));
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&source, &destination).map_err(|error| format!("创建文件快照失败：{error}"))?;
        copied.push(relative_path.clone());
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

pub fn restore_task_snapshot(root_path: &str, snapshot_id: &str) -> Result<Vec<String>, String> {
    let root = canonical_root(root_path)?;
    // Validate snapshot_id is a UUID so an absolute or `..`-traversing value
    // can't escape the snapshots directory via Path::join.
    Uuid::parse_str(snapshot_id).map_err(|_| "无效的快照 ID".to_string())?;
    let snapshot_dir = snapshots_root()?.join(snapshot_id);
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
