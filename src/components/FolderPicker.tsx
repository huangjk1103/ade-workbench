import { ArrowUp, ChevronRight, Check, Folder, HardDrive, X } from "lucide-react";
import { useEffect, useState } from "react";
import { listDirs, type DirEntry } from "../lib/bridge";

interface FolderPickerProps {
  onSelect: (path: string) => void;
  onClose: () => void;
  // Optional starting directory. When omitted (or pointing at a missing
  // path) the picker starts at the drives root, matching the legacy
  // behaviour.
  initialPath?: string;
  // Optional heading text. Defaults to "选择项目文件夹" so the
  // LandingPage continues to work unchanged.
  title?: string;
}

/** Compute the parent directory for the "up" button. Drive roots go to "" (drives). */
function parentOf(path: string): string {
  if (!path) return "";
  if (/^[A-Za-z]:\\$/.test(path)) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  const sep = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (sep <= 2) return trimmed.slice(0, 3);
  return trimmed.slice(0, sep);
}

export function FolderPicker({ onSelect, onClose, initialPath, title }: FolderPickerProps) {
  // Fall back to drives root only when no initialPath was supplied. A
  // missing initialPath (e.g. user has never picked before) also falls
  // back here — we don't try to canonicalise a non-existent path.
  const [path, setPath] = useState(initialPath ?? "");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    listDirs(path)
      .then((res) => {
        if (!cancelled) {
          setEntries(res.entries);
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(String(reason));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="folder-picker-overlay" onClick={onClose}>
      <div className="folder-picker" onClick={(event) => event.stopPropagation()}>
        <header className="folder-picker-head">
          <strong>{title ?? "选择项目文件夹"}</strong>
          <button type="button" onClick={onClose} title="关闭"><X size={16} /></button>
        </header>
        <div className="folder-picker-crumbs">
          <button type="button" className="fp-up" disabled={!path} onClick={() => setPath(parentOf(path))}>
            <ArrowUp size={14} /> 上级
          </button>
          <span className="folder-picker-path">{path || "我的电脑"}</span>
        </div>
        <div className="folder-picker-list">
          {loading && <div className="folder-picker-empty">加载中…</div>}
          {error && <div className="folder-picker-empty">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="folder-picker-empty">没有子文件夹</div>
          )}
          {!loading &&
            !error &&
            entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="folder-picker-item"
                onClick={() => setPath(entry.path)}
              >
                {/^[A-Za-z]:\\$/.test(entry.path) ? <HardDrive size={15} /> : <Folder size={15} />}
                <span>{entry.name}</span>
                <ChevronRight size={14} />
              </button>
            ))}
        </div>
        <footer className="folder-picker-foot">
          <button
            type="button"
            className="is-primary"
            disabled={!path}
            onClick={() => onSelect(path)}
          >
            <Check size={14} /> 选择此文件夹
          </button>
        </footer>
      </div>
    </div>
  );
}
