use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use base64::Engine;

use crate::model::{DirEntry, DirListing, FilePayload, ProjectEntry, ProjectSnapshot};

const MAX_ENTRIES: usize = 5_000;
const MAX_DEPTH: usize = 10;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const IGNORED_NAMES: &[&str] = &[
    ".git",
    ".ade",
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
        "md" | "markdown" | "rst" => "markdown",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "svg"
        | "ico" | "heic" | "avif" => "image",
        // Legacy `.doc` (Word 97–2003 binary) and OpenDocument / RTF text
        // variants all share the "word" family so the tree icon and the
        // file inspector match what the user expects from a Word document.
        "doc" | "docx" | "docm" | "odt" | "rtf" => "word",
        // Legacy `.ppt` (PowerPoint 97–2003 binary) shares the slides
        // family so the project tree icon is consistent.
        "ppt" | "pptx" | "pptm" | "odp" => "slides",
        "xls" | "xlsx" | "xlsm" | "ods" | "csv" | "tsv" | "tab" => "sheet",
        "pdf" => "pdf",
        // Bioinformatics — sequence & raw read data
        "fa" | "fasta" | "fna" | "faa" | "ffn" | "frn" | "mpfa"
        | "fq" | "fastq" => "sequence",
        // Bioinformatics — annotated sequences (GenBank / EMBL flatfiles)
        "gb" | "gbk" | "genbank" | "embl" => "annotation",
        // Bioinformatics — feature tables
        "gff" | "gff2" | "gff3" | "gtf" | "bed" | "psl" => "feature",
        // Bioinformatics — variant data
        "vcf" | "bcf" => "variant",
        // Bioinformatics — alignment & tree formats
        "sam" | "maf" | "axt" | "blast" => "alignment",
        "nwk" | "newick" | "tree" | "nex" | "nexus" | "phy" | "phylip" | "sto"
        | "stockholm" | "aln" | "clustal" => "alignment",
        // Bioinformatics — structure & ontology
        "pdb" | "ent" | "cif" | "mmcif" => "structure",
        "obo" | "owl" => "ontology",
        // Plain text / code / data
        "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "go" | "java"
        | "kt" | "kts" | "rb" | "php" | "swift" | "c" | "cpp" | "cc" | "cxx" | "h"
        | "hpp" | "hxx" | "m" | "mm" | "cs" | "scala" | "dart" | "lua" | "r"
        | "pl" | "sh" | "bash" | "zsh" | "ps1" | "bat" | "cmd" | "fish"
        | "css" | "scss" | "sass" | "less" | "html" | "htm" | "vue" | "svelte"
        | "json" | "jsonc" | "json5" | "yaml" | "yml" | "toml" | "ini" | "cfg"
        | "conf" | "config" | "env" | "properties" | "xml" | "xsl" | "xslt"
        | "txt" | "log" | "mdx" | "tex" | "bib" | "ipynb" | "dot" | "gv"
        | "proto" | "graphql" | "sql" | "diff" | "patch" => "text",
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
            .then_with(|| {
                left.file_name().to_string_lossy().to_lowercase().cmp(&right.file_name().to_string_lossy().to_lowercase())
            })
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

pub fn canonical_root(root_path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root_path)
        .map_err(|error| format!("项目目录不存在或无法访问：{error}"))?;
    if !root.is_dir() {
        return Err("所选路径不是目录".into());
    }
    Ok(root)
}

pub fn safe_existing_path(root_path: &str, relative_path: &str) -> Result<(PathBuf, PathBuf), String> {
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
        "md" | "markdown" | "rst" | "mdx" | "txt" | "log" | "json" | "jsonc" | "yaml"
            | "yml" | "toml" | "ini" | "cfg" | "conf" | "env" | "properties" | "xml"
            | "csv" | "tsv" | "tab" | "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs"
            | "py" | "go" | "java" | "kt" | "kts" | "rb" | "php" | "swift" | "c"
            | "cpp" | "cc" | "cxx" | "h" | "hpp" | "hxx" | "m" | "mm" | "cs" | "scala"
            | "dart" | "lua" | "r" | "pl" | "sh" | "bash" | "zsh" | "ps1" | "bat"
            | "cmd" | "fish" | "css" | "scss" | "sass" | "less" | "html" | "htm"
            | "vue" | "svelte" | "tex" | "bib" | "ipynb" | "dot" | "gv" | "proto"
            | "graphql" | "sql" | "diff" | "patch"
            // Bioinformatics text formats — plain ASCII, safe to load as UTF-8
            | "fa" | "fasta" | "fna" | "faa" | "ffn" | "frn" | "mpfa"
            | "fq" | "fastq"
            | "gb" | "gbk" | "genbank" | "embl"
            | "gff" | "gff2" | "gff3" | "gtf" | "bed" | "psl"
            | "vcf"
            | "sam" | "maf" | "axt" | "blast"
            | "nwk" | "newick" | "tree" | "nex" | "nexus" | "phy" | "phylip"
            | "sto" | "stockholm" | "aln" | "clustal"
            | "pdb" | "ent" | "cif" | "mmcif"
            | "obo"
    )
}

/// Like `safe_existing_path` but allows the target file to not exist yet, so
/// new files can be created. The parent directory must exist and stay within
/// the project root; an existing target is canonicalized (resolving symlinks)
/// and re-checked so a symlink escaping the project cannot be written through.
fn safe_writable_path(root_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    let root = canonical_root(root_path)?;
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
        })
    {
        return Err("文件路径必须位于项目目录内".into());
    }
    let target = root.join(relative_path);
    if target.exists() {
        let canonical = fs::canonicalize(&target)
            .map_err(|error| format!("文件路径不可访问：{error}"))?;
        if !canonical.starts_with(&root) {
            return Err("拒绝访问项目目录之外的文件".into());
        }
        Ok(canonical)
    } else {
        let parent = target.parent().ok_or("文件路径没有父目录")?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|error| format!("父目录不可访问：{error}"))?;
        if !canonical_parent.starts_with(&root) {
            return Err("拒绝访问项目目录之外的文件".into());
        }
        let name = target.file_name().ok_or("文件路径没有文件名")?;
        Ok(canonical_parent.join(name))
    }
}

/// Strip the `\\?\` (and `\\?\UNC\`) extended-length path prefix that
/// `fs::canonicalize` adds on Windows. ShellExecuteW does not reliably handle
/// verbatim paths, and the web folder picker also prefers clean paths.
pub fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

pub fn scan_project(root_path: &str) -> Result<ProjectSnapshot, String> {
    let root = canonical_root(root_path)?;
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Project")
        .to_string();
    let mut count = 0;
    let mut truncated = false;
    let entries = scan_directory(&root, &root, 0, &mut count, &mut truncated)?;
    Ok(ProjectSnapshot {
        root_path: strip_verbatim_prefix(&root).to_string_lossy().to_string(),
        name,
        entries,
        truncated,
    })
}

pub fn read_project_file(root_path: &str, relative_path: &str) -> Result<FilePayload, String> {
    let (_, target) = safe_existing_path(root_path, relative_path)?;
    let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("所选项目项不是文件".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!("文件超过 {} MB 的首期读取限制", MAX_FILE_BYTES / 1024 / 1024));
    }
    let bytes = fs::read(&target).map_err(|error| format!("读取文件失败：{error}"))?;
    let ext = extension(&target);

    // Legacy `.doc` files use a binary Word 97-2003 format that no
    // browser-side library (mammoth) can parse. Convert the payload to
    // `.docx` on the way in so the existing DocxView renders it without
    // any client-side changes. The on-disk path stays `.doc`; the
    // reported extension is the *content* format we hand to the viewer.
    if ext == "doc" {
        let docx_bytes = convert_word_format(&bytes, "doc-to-docx")?;
        return Ok(FilePayload {
            relative_path: relative_path.to_string(),
            name: target.file_name().and_then(|value| value.to_str()).unwrap_or("file").to_string(),
            extension: "docx".to_string(),
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
            encoding: "base64".to_string(),
            content: base64::engine::general_purpose::STANDARD.encode(docx_bytes),
        });
    }

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
        relative_path: relative_path.to_string(),
        name: target.file_name().and_then(|value| value.to_str()).unwrap_or("file").to_string(),
        extension: ext,
        size: metadata.len(),
        modified_ms: modified_ms(&metadata),
        encoding,
        content,
    })
}

pub fn write_project_text_file(root_path: &str, relative_path: &str, content: &str) -> Result<(), String> {
    let target = safe_writable_path(root_path, relative_path)?;
    let ext = extension(&target);
    if !is_text_extension(&ext) {
        return Err("首期只允许直接保存文本类文件".into());
    }
    fs::write(target, content.as_bytes()).map_err(|error| format!("保存文件失败：{error}"))
}

pub fn write_project_binary_file(root_path: &str, relative_path: &str, base64_content: &str) -> Result<(), String> {
    let target = safe_writable_path(root_path, relative_path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_content)
        .map_err(|error| format!("Base64 解码失败：{error}"))?;
    fs::write(target, bytes).map_err(|error| format!("保存文件失败：{error}"))
}

pub fn open_in_system(root_path: &str, relative_path: &str) -> Result<(), String> {
    let (_, target) = safe_existing_path(root_path, relative_path)?;
    if !target.is_file() {
        return Err("只能用系统程序打开文件".into());
    }
    open::that(strip_verbatim_prefix(&target))
        .map_err(|error| format!("系统打开失败：{error}"))
}

/// Open the project root in the platform's file manager (Explorer on Windows,
/// Finder on macOS, the XDG default on Linux). Rejects any path that is not a
/// directory so a typo'd rootPath cannot silently launch an unexpected app.
pub fn open_folder_in_system(root_path: &str) -> Result<(), String> {
    let root = canonical_root(root_path)?;
    open::that(strip_verbatim_prefix(&root))
        .map_err(|error| format!("打开文件管理器失败：{error}"))
}

/// Convert edited HTML back to a DOCX file by delegating to the Node-based
/// html-to-docx converter. The converter script lives next to the server
/// binary so the bundled app can ship it without extra install steps.
///
/// Accepts legacy `.doc` targets as well: the HTML is first rendered into
/// a temporary `.docx`, then Microsoft Word COM (via the
/// `doc-format-convert.cjs` helper) downgrades it back to the binary
/// `.doc` format so the on-disk file keeps its original extension.
pub fn write_project_docx(root_path: &str, relative_path: &str, html: &str) -> Result<(), String> {
    let target = safe_writable_path(root_path, relative_path)?;
    let ext = extension(&target);
    if !matches!(ext.as_str(), "docx" | "docm" | "doc") {
        return Err("write_project_docx 只能用于 docx/docm/doc 文件".into());
    }

    let script_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("html-to-docx.cjs");
    if !script_path.is_file() {
        return Err(format!("DOCX 转换脚本不存在：{}", script_path.display()));
    }

    let output = Command::new("node")
        .arg(&script_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(stdin) = child.stdin.take() {
                let mut writer = stdin;
                writer.write_all(html.as_bytes())?;
            }
            child.wait_with_output()
        })
        .map_err(|error| format!("启动 DOCX 转换失败：{error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("DOCX 转换失败：{stderr}"));
    }

    let base64 = String::from_utf8(output.stdout)
        .map_err(|error| format!("DOCX 转换输出不是有效 UTF-8：{error}"))?;
    let docx_bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|error| format!("DOCX 转换输出 Base64 解码失败：{error}"))?;

    if ext == "doc" {
        let doc_bytes = convert_word_format(&docx_bytes, "docx-to-doc")
            .map_err(|error| format!("DOC 转换失败：{error}"))?;
        fs::write(target, doc_bytes).map_err(|error| format!("保存 DOC 文件失败：{error}"))
    } else {
        fs::write(target, docx_bytes).map_err(|error| format!("保存 DOCX 文件失败：{error}"))
    }
}

/// Convert a `.doc` ↔ `.docx` payload by shelling out to the
/// `doc-format-convert.cjs` helper, which uses Microsoft Word COM
/// automation (only available on Windows where Word is installed).
///
/// `mode` is either `"doc-to-docx"` or `"docx-to-doc"`. The wrapper takes
/// base64 via stdin so we never have to write the user's files to disk.
fn convert_word_format(input: &[u8], mode: &str) -> Result<Vec<u8>, String> {
    let script_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("doc-format-convert.cjs");
    if !script_path.is_file() {
        return Err(format!("Word 格式转换脚本不存在：{}", script_path.display()));
    }

    let payload = serde_json::json!({
        "mode": mode,
        "inputBase64": base64::engine::general_purpose::STANDARD.encode(input),
    });
    let payload_bytes = serde_json::to_vec(&payload)
        .map_err(|error| format!("序列化 Word 转换请求失败：{error}"))?;

    let output = Command::new("node")
        .arg(&script_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(stdin) = child.stdin.take() {
                let mut writer = stdin;
                writer.write_all(&payload_bytes)?;
            }
            child.wait_with_output()
        })
        .map_err(|error| format!("启动 Word 格式转换失败：{error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Word 格式转换失败（退出码 {:?}）：{}",
            output.status.code(),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8(output.stdout)
        .map_err(|error| format!("Word 格式转换输出不是有效 UTF-8：{error}"))?;
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|error| format!("Word 格式转换输出解析失败：{error}"))?;
    let output_b64 = parsed
        .get("outputBase64")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Word 格式转换输出缺少 outputBase64".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(output_b64.trim())
        .map_err(|error| format!("Word 格式转换输出 Base64 解码失败：{error}"))
}

// ---- Directory browser for the web folder picker ----

#[cfg(windows)]
fn list_roots() -> Result<Vec<DirEntry>, String> {
    let mut drives = Vec::new();
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if Path::new(&root).is_dir() {
            drives.push(DirEntry {
                name: format!("{}:", letter as char),
                path: root,
                is_dir: true,
            });
        }
    }
    Ok(drives)
}

#[cfg(not(windows))]
fn list_roots() -> Result<Vec<DirEntry>, String> {
    Ok(vec![DirEntry {
        name: "/".to_string(),
        path: "/".to_string(),
        is_dir: true,
    }])
}

pub fn list_dirs(path: &str) -> Result<DirListing, String> {
    if path.is_empty() {
        return Ok(DirListing {
            path: String::new(),
            entries: list_roots()?,
        });
    }
    let root = fs::canonicalize(path).map_err(|error| format!("目录不存在：{error}"))?;
    if !root.is_dir() {
        return Err("路径不是目录".into());
    }
    let mut entries = Vec::new();
    for item in fs::read_dir(&root)
        .map_err(|error| format!("无法读取目录：{error}"))?
        .filter_map(Result::ok)
    {
        let file_type = match item.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_string();
        let clean = strip_verbatim_prefix(&item.path());
        entries.push(DirEntry {
            name,
            path: clean.to_string_lossy().to_string(),
            is_dir: true,
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(DirListing {
        path: strip_verbatim_prefix(&root).to_string_lossy().to_string(),
        entries,
    })
}
