import { useEffect, useMemo, useRef } from "react";
import type { Annotation, FilePayload } from "../../types/domain";

interface TreeViewProps {
  payload: FilePayload;
  pendingJump?: Annotation | null;
  onJumpMissed?: (annotation: Annotation) => void;
}

// Newick is a parenthetical format: `(A:0.1,B:0.2,(C:0.3,D:0.4)E:0.5)F;`.
// We render the raw text in a readable monospace view, with the parenthesis
// structure highlighted and branch-length annotations tagged. This is meant
// for quick inspection; full Newick rendering (with a real graphical tree)
// is out of scope for the inline viewer.
const TREE_EXTENSIONS = new Set(["nwk", "newick", "tree", "nex", "nexus", "phy", "phylip", "sto", "stockholm", "aln", "clustal"]);

export default function TreeView({ payload, pendingJump, onJumpMissed }: TreeViewProps) {
  const sourceRef = useRef<HTMLPreElement>(null);
  const jumpKey = pendingJump ? `${pendingJump.id}:${pendingJump.updatedAt}` : null;
  useEffect(() => {
    if (!pendingJump || !sourceRef.current) return;
    const target = pendingJump.target;
    const needle = (target.selectedText ?? "").trim();
    if (!needle) { onJumpMissed?.(pendingJump); return; }
    const text = payload.content;
    const idx = text.indexOf(needle);
    if (idx < 0) { onJumpMissed?.(pendingJump); return; }
    // For the tree viewer we can't easily highlight in the middle of a
    // pre without breaking tokenization; instead we scroll the source block
    // and add an outline to the pre itself so the user gets feedback.
    sourceRef.current.classList.add("ade-jump-outline");
    sourceRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(() => sourceRef.current?.classList.remove("ade-jump-outline"), 2300);
  }, [jumpKey, onJumpMissed, pendingJump, payload.content]);

  if (!TREE_EXTENSIONS.has(payload.extension)) {
    return (
      <div className="viewer-state">
        <strong>不支持的进化树格式：{payload.extension}</strong>
      </div>
    );
  }

  const tokens = useMemo(() => tokenize(payload.content), [payload.content]);
  const stats = useMemo(() => {
    const open = (payload.content.match(/\(/g) ?? []).length;
    const close = (payload.content.match(/\)/g) ?? []).length;
    const leaves = (payload.content.match(/[,()]/g) ?? []).filter((char) => char === ",").length + (open > 0 ? 0 : 0);
    return { open, close, leaves: leaves + 1 };
  }, [payload.content]);

  return (
    <div className="tree-view">
      <div className="tree-summary">
        <div>
          <span>{payload.extension.toUpperCase()}</span>
          <strong>括号配对 {stats.open} 开 / {stats.close} 闭</strong>
        </div>
        <div>
          <em>约 {stats.leaves.toLocaleString("en-US")} 个叶节点</em>
          <span>{payload.name}</span>
        </div>
      </div>
      <pre className="tree-source" ref={sourceRef}>
        {tokens.map((token, index) => (
          <span key={index} className={`tree-token tree-token--${token.type}`}>{token.text}</span>
        ))}
      </pre>
      <details className="tree-meta">
        <summary>原始文本</summary>
        <pre>{payload.content}</pre>
      </details>
    </div>
  );
}

type Token = { type: "paren" | "branch" | "name" | "punct" | "text"; text: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let buffer = "";
  function flush() {
    if (!buffer) return;
    tokens.push({ type: "text", text: buffer });
    buffer = "";
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(" || char === ")") {
      flush();
      tokens.push({ type: "paren", text: char });
    } else if (char === "," || char === ";" || char === ":") {
      flush();
      tokens.push({ type: "punct", text: char });
    } else {
      buffer += char;
    }
  }
  flush();
  return tokens;
}