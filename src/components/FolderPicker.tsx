import { ArrowUp, ChevronRight, Check, HardDrive, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

interface Crumb {
  label: string;
  path: string;
}

/** Split an absolute path into clickable breadcrumb segments, rooted at "此电脑". */
function segments(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: "此电脑", path: "" }];
  if (!path) return crumbs;
  const drive = path.match(/^([A-Za-z]:)([\\/]?)(.*)$/);
  if (drive) {
    const letter = drive[1];
    crumbs.push({ label: `${letter}:`, path: `${letter}\\` });
    const rest = drive[3].replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
    let acc = `${letter}\\`;
    for (const part of rest.split(/[\\/]+/)) {
      acc = `${acc.replace(/[\\/]+$/, "")}\\${part}`;
      crumbs.push({ label: part, path: acc });
    }
  } else {
    const parts = path.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc.replace(/[\\/]+$/, "")}\\${part}` : part;
      crumbs.push({ label: part, path: acc });
    }
  }
  return crumbs;
}

/** Two-tone folder glyph reminiscent of a file-explorer folder icon. */
function FolderGlyph({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2.6 6.4A1.4 1.4 0 0 1 4 5h4.1c.37 0 .73.15 1 .41l1.2 1.2c.27.26.63.41 1 .41h8.7A1.4 1.4 0 0 1 21.4 8.4v9.2a1.4 1.4 0 0 1-1.4 1.4H4a1.4 1.4 0 0 1-1.4-1.4z"
        fill="#b8862c"
      />
      <path
        d="M2.6 8.6h18.8l-1.2 8a1.4 1.4 0 0 1-1.39 1.2H4.19a1.4 1.4 0 0 1-1.39-1.2z"
        fill="#e0ad4c"
      />
    </svg>
  );
}

export function FolderPicker({ onSelect, onClose, initialPath, title }: FolderPickerProps) {
  // Fall back to drives root only when no initialPath was supplied. A
  // missing initialPath (e.g. user has never picked before) also falls
  // back here - we don't try to canonicalise a non-existent path.
  const [path, setPath] = useState(initialPath ?? "");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Bumped by the refresh button to force a re-fetch without changing path.
  const [nonce, setNonce] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    listDirs(path)
      .then((res) => {
        if (!cancelled) {
          setEntries(res.entries);
          setLoading(false);
          // Seed keyboard focus on the first row so Arrow/Enter work at once.
          if (res.entries.length) {
            requestAnimationFrame(() => {
              if (cancelled) return;
              listRef.current?.querySelector<HTMLButtonElement>("button.fp-row")?.focus();
            });
          }
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
  }, [path, nonce]);

  // File-explorer-style keyboard navigation.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Backspace") {
        if (path) {
          e.preventDefault();
          setPath(parentOf(path));
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const rows = listRef.current
          ? Array.from(listRef.current.querySelectorAll<HTMLButtonElement>("button.fp-row"))
          : [];
        if (!rows.length) return;
        const cur = rows.findIndex((r) => r === document.activeElement);
        const next =
          cur === -1
            ? e.key === "ArrowDown"
              ? 0
              : rows.length - 1
            : e.key === "ArrowDown"
              ? (cur + 1) % rows.length
              : (cur - 1 + rows.length) % rows.length;
        rows[next].focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path, onClose]);

  const crumbs = segments(path);

  return (
    <div className="folder-picker-overlay" onClick={onClose}>
      <div className="folder-picker" onClick={(event) => event.stopPropagation()}>
        <header className="folder-picker-head">
          <strong>{title ?? "选择项目文件夹"}</strong>
          <button type="button" className="fp-close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="fp-toolbar">
          <button
            type="button"
            className="fp-icon-btn"
            disabled={!path}
            onClick={() => setPath(parentOf(path))}
            title="上一级 (Backspace)"
          >
            <ArrowUp size={15} />
          </button>
          <nav className="fp-address" aria-label="路径">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1;
              return (
                <span className="fp-crumb-wrap" key={c.path || "root"}>
                  {i > 0 && <ChevronRight size={13} className="fp-crumb-sep" />}
                  {last ? (
                    <span className="fp-crumb is-current">{c.label}</span>
                  ) : (
                    <button type="button" className="fp-crumb" onClick={() => setPath(c.path)}>
                      {c.label}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
          <button
            type="button"
            className="fp-icon-btn"
            onClick={() => setNonce((n) => n + 1)}
            title="刷新"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        <div className="fp-list" ref={listRef}>
          <div className="fp-list-head">
            <span>名称</span>
          </div>
          <div className="fp-list-body">
            {loading && <div className="fp-empty">加载中…</div>}
            {error && <div className="fp-empty">{error}</div>}
            {!loading && !error && entries.length === 0 && (
              <div className="fp-empty">此文件夹没有子文件夹</div>
            )}
            {!loading &&
              !error &&
              entries.map((entry) => {
                const isDrive = /^[A-Za-z]:\\$/.test(entry.path);
                return (
                  <button
                    key={entry.path}
                    type="button"
                    className="fp-row"
                    onClick={() => setPath(entry.path)}
                    onDoubleClick={() => setPath(entry.path)}
                    title={entry.path}
                  >
                    <span className="fp-row-icon">
                      {isDrive ? <HardDrive size={16} /> : <FolderGlyph />}
                    </span>
                    <span className="fp-row-name">{entry.name}</span>
                    {!isDrive && <ChevronRight size={14} className="fp-row-arrow" />}
                  </button>
                );
              })}
          </div>
        </div>

        <footer className="fp-foot">
          <span className="fp-foot-path">{path || "未选择"}</span>
          <button type="button" className="fp-secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="fp-primary"
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
