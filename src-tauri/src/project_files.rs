use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine;

use crate::model::{FilePayload, ProjectEntry, ProjectSnapshot};

const MAX_ENTRIES: usize = 5_000;
const MAX_DEPTH: usize = 10;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const IGNORED_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".idea",
    ".vscode",
    "__pycache__",
];

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn normalize_relative(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn entry_kind(path: &Path, is_dir: bool) -> String {
    if is_dir {
        return "folder".into();
    }
    match extension(path).as_str() {
        "md" | "markdown" => "markdown",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "svg" => {
            "image"
        }
        "docx" | "docm" => "word",
        "pptx" | "pptm" => "slides",
        "xlsx" | "xlsm" | "csv" | "tsv" => "sheet",
        "pdf" => "pdf",
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "java" | "c" | "cpp"
        | "h" | "hpp" | "css" | "html" | "json" | "yaml" | "yml" | "toml" | "xml"
        | "txt" | "log" | "sh" | "ps1" | "sql" => "text",
        _ => "binary",
    }
    .into()
}

fn scan_directory(
    root: &Path,
    current: &Path,
    depth: usize,
    count: &mut usize,
    truncated: &mut bool,
) -> Result<Vec<ProjectEntry>, String> {
    if depth > MAX_DEPTH || *count >= MAX_ENTRIES {
        *truncated = true;
        return Ok(Vec::new());
    }

    let mut raw_entries = fs::read_dir(current)
        .map_err(|error| format!("无法读取目录 {}：{error}", current.display()))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    raw_entries.sort_by(|left, right| {
        let left_dir = left.file_type().map(|value| value.is_dir()).unwrap_or(false);
        let right_dir = right.file_type().map(|value| value.is_dir()).unwrap_or(false);
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.file_name().to_string_lossy().to_lowercase().cmp(&right.file_name().to_string_lossy().to_lowercase()))
    });

    let mut entries = Vec::new();
    for item in raw_entries {
        if *count >= MAX_ENTRIES {
            *truncated = true;
            break;
        }
        let file_name = item.file_name().to_string_lossy().to_string();
        if IGNORED_NAMES.iter().any(|ignored| file_name.eq_ignore_ascii_case(ignored)) {
            continue;
        }
        let file_type = match item.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = item.path();
        let metadata = match item.metadata() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let relative = path.strip_prefix(root).unwrap_or(&path);
        *count += 1;
        let children = if file_type.is_dir() {
            scan_directory(root, &path, depth + 1, count, truncated)?
        } else {
            Vec::new()
        };
        entries.push(ProjectEntry {
            name: file_name,
            relative_path: normalize_relative(relative),
            kind: entry_kind(&path, file_type.is_dir()),
            extension: extension(&path),
            size: if file_type.is_file() { metadata.len() } else { 0 },
            modified_ms: modified_ms(&metadata),
            children,
        });
    }
    Ok(entries)
}

pub(crate) fn canonical_root(root_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root_path)
        .map_err(|error| format!("项目目录不存在或无法访问：{error}"))?;
    if !root.is_dir() {
        return Err("所选路径不是目录".into());
    }
    Ok(root)
}

pub(crate) fn safe_existing_path(root_path: &str, relative_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_root(root_path)?;
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
        })
    {
        return Err("文件路径必须位于项目目录内".into());
    }
    let target = fs::canonicalize(root.join(relative_path))
        .map_err(|error| format!("文件不存在或无法访问：{error}"))?;
    if !target.starts_with(&root) {
        return Err("拒绝访问项目目录之外的文件".into());
    }
    Ok((root, target))
}

fn is_text_extension(extension: &str) -> bool {
    matches!(
        extension,
        "md" | "markdown" | "txt" | "log" | "json" | "yaml" | "yml" | "toml" | "xml"
            | "csv" | "tsv" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go"
            | "java" | "c" | "cpp" | "h" | "hpp" | "css" | "html" | "sh" | "ps1"
            | "sql"
    )
}

#[tauri::command]
pub fn scan_project(root_path: String) -> Result<ProjectSnapshot, String> {
    let root = canonical_root(&root_path)?;
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Project")
        .to_string();
    let mut count = 0;
    let mut truncated = false;
    let entries = scan_directory(&root, &root, 0, &mut count, &mut truncated)?;
    Ok(ProjectSnapshot {
        root_path: root.to_string_lossy().to_string(),
        name,
        entries,
        truncated,
    })
}

#[tauri::command]
pub fn read_project_file(root_path: String, relative_path: String) -> Result<FilePayload, String> {
    let (_, target) = safe_existing_path(&root_path, &relative_path)?;
    let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("所选项目项不是文件".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!("文件超过 {} MB 的首期读取限制", MAX_FILE_BYTES / 1024 / 1024));
    }
    let bytes = fs::read(&target).map_err(|error| format!("读取文件失败：{error}"))?;
    let ext = extension(&target);
    let (encoding, content) = if is_text_extension(&ext) {
        (
            "utf8".to_string(),
            String::from_utf8(bytes).map_err(|_| "文本文件不是有效的 UTF-8 编码".to_string())?,
        )
    } else {
        (
            "base64".to_string(),
            base64::engine::general_purpose::STANDARD.encode(bytes),
        )
    };
    Ok(FilePayload {
        relative_path,
        name: target.file_name().and_then(|value| value.to_str()).unwrap_or("file").to_string(),
        extension: ext,
        size: metadata.len(),
        modified_ms: modified_ms(&metadata),
        encoding,
        content,
    })
}

#[tauri::command]
pub fn write_project_text_file(
    root_path: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    let (_, target) = safe_existing_path(&root_path, &relative_path)?;
    let ext = extension(&target);
    if !is_text_extension(&ext) {
        return Err("首期只允许直接保存文本类文件".into());
    }
    fs::write(target, content.as_bytes()).map_err(|error| format!("保存文件失败：{error}"))
}

/// Strip the `\\?\` (and `\\?\UNC\`) extended-length path prefix that
/// `fs::canonicalize` adds on Windows. ShellExecuteW does not reliably handle
/// verbatim paths, so we normalize before delegating to the system opener.
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

#[tauri::command]
pub fn open_in_system(root_path: String, relative_path: String) -> Result<(), String> {
    let (_, target) = safe_existing_path(&root_path, &relative_path)?;
    if !target.is_file() {
        return Err("只能用系统程序打开文件".into());
    }
    open::that(strip_verbatim_prefix(&target))
        .map_err(|error| format!("系统打开失败：{error}"))
}
