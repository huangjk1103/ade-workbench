import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Annotation, FilePayload, TextSelectionContext } from "../../types/domain";
import { selectionContext } from "./shared";

interface MarkdownViewProps {
  payload: FilePayload;
  content: string;
  onSelection: (selection: TextSelectionContext) => void;
  pendingJump?: Annotation | null;
  onJumpMissed?: (annotation: Annotation) => void;
}

export default function MarkdownView({ payload, content, onSelection, pendingJump, onJumpMissed }: MarkdownViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const captureSelection = () => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";
    if (!selectedText || !selection?.anchorNode || !hostRef.current?.contains(selection.anchorNode)) return;
    onSelection(selectionContext(payload, selectedText, content));
  };

  // Jump-to-source: parse `lineNumber` to find the corresponding markdown
  // block (we treat each block-level element as one logical line) and wrap
  // the matched substring in a dashed outline. Same orchestration as
  // DocxView, just without paragraph indexes — falling back to selectedText
  // / prefix when no line number is present.
  const jumpKey = pendingJump ? `${pendingJump.id}:${pendingJump.updatedAt}` : null;
  useEffect(() => {
    if (!pendingJump || !hostRef.current) return;
    const host = hostRef.current;
    const target = pendingJump.target;
    const blocks = host.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, table");
    let block: HTMLElement | null = null;
    if (target.lineNumber && target.lineNumber >= 1 && target.lineNumber <= blocks.length) {
      block = blocks[target.lineNumber - 1];
    }
    if (!block) {
      const needle = (target.selectedText ?? "").trim();
      if (needle) {
        for (const candidate of Array.from(blocks)) {
          if ((candidate.textContent ?? "").includes(needle)) { block = candidate; break; }
        }
      }
    }
    if (!block) {
      onJumpMissed?.(pendingJump);
      return;
    }
    const range = document.createRange();
    const needle = (target.selectedText ?? "").trim();
    let located = false;
    if (needle) {
      const text = block.textContent ?? "";
      const idx = text.indexOf(needle);
      if (idx >= 0) {
        locateRangeInText(block, idx, needle.length, range);
        located = true;
      }
    }
    document.querySelectorAll(".ade-jump-outline").forEach((node) => {
      node.classList.remove("ade-jump-outline");
    });
    if (!located) {
      const whole = document.createRange();
      whole.selectNodeContents(block);
      try { wrapRangeWithOutline(whole, host); } catch { /* ignore */ }
    } else {
      try { wrapRangeWithOutline(range, host); } catch { /* ignore */ }
    }
    block.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [jumpKey, onJumpMissed, pendingJump]);

  return (
    <div className="rich-document markdown-document" ref={hostRef} onMouseUp={captureSelection}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

// Reused directly from the docx flow. We re-declare small primitives here
// rather than exporting them to keep viewers loosely coupled: a future move
// to a different markdown renderer shouldn't pull DocxView along with it.
function locateRangeInText(host: HTMLElement, start: number, length: number, range: Range): boolean {
  if (length <= 0) return false;
  let cursor = 0;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const text = textNode.textContent ?? "";
    const nodeStart = cursor;
    const nodeEnd = cursor + text.length;
    cursor = nodeEnd;
    const segStart = Math.max(start, nodeStart);
    const segEnd = Math.min(start + length, nodeEnd);
    if (segEnd > segStart) {
      range.setStart(textNode, segStart - nodeStart);
      if (start + length <= nodeEnd) {
        range.setEnd(textNode, segEnd - nodeStart);
      } else {
        range.setEnd(textNode, text.length);
      }
      return true;
    }
  }
  return false;
}

function wrapRangeWithOutline(range: Range, host: HTMLElement) {
  if (range.collapsed) return;
  const container = document.createElement("span");
  container.className = "ade-jump-outline";
  try {
    range.surroundContents(container);
    host.appendChild(container);
  } catch {
    try {
      range.deleteContents();
      range.insertNode(container);
      host.appendChild(container);
    } catch { return; }
  }
  window.setTimeout(() => {
    const parent = container.parentNode;
    if (!parent) return;
    while (container.firstChild) parent.insertBefore(container.firstChild, container);
    parent.removeChild(container);
    parent.normalize();
  }, 2300);
}
