import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Heading1,
  Heading2,
  Highlighter,
  History,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  MessageSquareText,
  MessageSquarePlus,
  Minimize2,
  Palette,
  RefreshCw,
  RemoveFormatting,
  Save,
  Strikethrough,
  Send,
  Subscript,
  Superscript,
  Type,
  Underline,
  WrapText,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import mammoth from "mammoth";
import { decodeBase64 } from "../../lib/bridge";
import { parseDocxForReview } from "../../lib/docxReview";
import { tiffBase64ToPngDataUrl } from "../../lib/tiff";
import type { Annotation, DocxReviewModel, FilePayload, ReviewComment, TextSelectionContext } from "../../types/domain";
import { selectionContext, ViewerError, ViewerLoading } from "./shared";

// Targeted by `pendingReviewJump` from the parent. Either a track-change
// (`w:ins` / `w:del`) or a Word-style comment — both surfaces that used
// to live in the old in-document review pane.
export type DocxReviewJumpKind = "change" | "comment";

export interface DocxReviewJumpTarget {
  kind: DocxReviewJumpKind;
  // Identifier of the targeted change / comment as rendered into the
  // document body via `data-change-id` / `data-comment-id`.
  id: string;
  // Bumped whenever the parent re-emits the same id (mirrors the
  // pendingJump pattern) so DocxView's effect refires without the user
  // having to close & reopen the file.
  nonce: number;
}

interface DocxViewProps {
  payload: FilePayload;
  onDocxSave?: (html: string) => void;
  onSelection: (selection: TextSelectionContext) => void;
  // When provided, enables the "划词批注" (select-to-annotate) flow: an inline
  // composer floats next to the selection so users can create an annotation
  // without touching the right-hand inspector (Orca ADE style).
  onCreateAnnotation?: (body: string, priority: Annotation["priority"], agentId?: string) => Promise<void>;
  agents?: { id: string; name: string; available: boolean }[];
  // Annotation forwarded from the right-hand inspector. We resolve it
  // against the rendered DOM (paragraph index, then prefix/suffix match),
  // wrap the matched range in an outline span, scroll it into view, and
  // briefly flash a dashed border so the user can find the source spot.
  pendingJump?: Annotation | null;
  onJumpMissed?: (annotation: Annotation) => void;
  // Fired whenever the parsed review model changes (including null when the
  // doc has no review data). App.tsx forwards this to the right-hand
  // AnnotationPanel so it can list Word-style comments / tracked changes
  // alongside the user's own annotations — the legacy in-document review
  // pane has been retired in favour of that single merged surface.
  onReviewChange?: (model: DocxReviewModel | null) => void;
  // Jump to a docx-native review item (track-change or Word comment) when
  // the user clicks its entry in the right-hand AnnotationPanel. The id is
  // the change/comment id rendered into the document as `data-*`.
  pendingReviewJump?: DocxReviewJumpTarget | null;
  // Re-read the file from disk so the user can see the latest content after
  // an external agent modifies it. App.tsx owns the actual fetch + tab
  // state update; DocxView only renders the toolbar button and forwards
  // the click (after confirming any unsaved changes). Optional so other
  // callers can keep using the read-only review surface.
  onRefresh?: () => Promise<void> | void;
  // Open the right-hand review panel and switch to the annotations tab so
  // Word-style comments + tracked changes show up next to the document.
  // App.tsx owns the inspector state; we just forward the click.
  onOpenReview?: () => void;
}

interface AnnotateComposerState {
  x: number;
  y: number;
  selectedText: string;
}

function exec(command: string, value: string | undefined = undefined) {
  document.execCommand(command, false, value);
}

const FONT_FAMILIES = [
  { label: "默认字体", value: "" },
  { label: "宋体", value: "SimSun, 宋体, serif" },
  { label: "黑体", value: "SimHei, 黑体, sans-serif" },
  { label: "楷体", value: "KaiTi, 楷体, serif" },
  { label: "仿宋", value: "FangSong, 仿宋, serif" },
  { label: "微软雅黑", value: "'Microsoft YaHei', 微软雅黑, sans-serif" },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Times New Roman", value: "'Times New Roman', serif" },
];

const FONT_SIZES = [
  { label: "10", value: "1" },
  { label: "12", value: "2" },
  { label: "14", value: "3" },
  { label: "16", value: "4" },
  { label: "18", value: "5" },
  { label: "24", value: "6" },
  { label: "32", value: "7" },
];

function setFontFamily(value: string) {
  if (!value) return;
  document.execCommand("styleWithCSS", false, "true");
  exec("fontName", value);
}

function setFontSize(value: string) {
  document.execCommand("styleWithCSS", false, "true");
  exec("fontSize", value);
}

// Block-level elements that the docx converter emits. The selection's start
// node is mapped up to the nearest ancestor matching this list, then we count
// earlier siblings in document order — including blocks nested inside list
// items / table cells — to give the agent a stable paragraph index it can
// replicate by walking the OOXML body.
const DOCX_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, tr";

function convertTiffImages(html: string): string {
  return html.replace(/<img[^>]*src="data:image\/tiff;base64,([^"]+)"[^>]*>/gi, (match, b64) => {
    const pngUrl = tiffBase64ToPngDataUrl(b64);
    if (pngUrl) return match.replace(/data:image\/tiff;base64,[^"]+/, pngUrl);
    return match;
  });
}

// Walk up to the nearest block ancestor (the host root is itself the document
// root, so we never escape) and return its 0-based index among document-order
// blocks. Returns -1 when no block ancestor is found.
function paragraphIndexBefore(host: HTMLElement, node: Node | null): number {
  if (!node) return -1;
  let cursor: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
  while (cursor && cursor !== host) {
    if (cursor.matches(DOCX_BLOCK_SELECTOR)) break;
    cursor = cursor.parentElement;
  }
  if (!cursor || cursor === host) return -1;
  const blocks = Array.from(host.querySelectorAll(DOCX_BLOCK_SELECTOR));
  return blocks.indexOf(cursor);
}

function clearFormat() {
  document.execCommand("styleWithCSS", false, "true");
  exec("removeFormat");
}

function setHiliteColor(color: string) {
  // Modern browsers support hiliteColor; fall back to backColor for older engines.
  document.execCommand("styleWithCSS", false, "true");
  const ok = document.execCommand("hiliteColor", false, color);
  if (!ok) exec("backColor", color);
}

function formatTime(ms: number): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// Walk the text nodes inside `host` to locate a substring of `length` that
// starts at character `start` when concatenated. Returns true when the range
// was positioned on a real text intersection.
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
      // Set the end on the same node when the segment is fully contained,
      // otherwise point to the next node via setStart() above and set the
      // end at the last node's natural length; this avoids zero-width
      // ranges that browsers refuse to render selection on.
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

// Track the pending cleanup timeout for the current outline span so we can
// cancel it when a new jump fires. Without this, rapid double-clicks on
// annotations leave two setTimeouts racing each other, and the second
// `.remove()` (run before its scheduled cleanup) wipes the wrapped text.
let pendingOutlineCleanup: number | null = null;

// Move every child of `span` back to its parent in document order, then
// remove the span. Calling `.remove()` directly would orphan the wrapped
// nodes (and therefore delete them from the visible document), so we
// always restore children first.
function unwrapOutlineSpan(span: Element) {
  const parent = span.parentNode;
  if (!parent) return;
  while (span.firstChild) {
    parent.insertBefore(span.firstChild, span);
  }
  parent.removeChild(span);
  if (parent instanceof Element) parent.normalize();
}

// Restore any outline spans left over from a previous jump. Called before
// applying a new outline so the old wrap is unwrapped (not removed) and we
// don't lose the text that was inside it.
function clearExistingOutlines() {
  document.querySelectorAll(".ade-jump-outline").forEach((node) => {
    unwrapOutlineSpan(node);
  });
  if (pendingOutlineCleanup !== null) {
    window.clearTimeout(pendingOutlineCleanup);
    pendingOutlineCleanup = null;
  }
}

// Wrap a Range in a `<span class="ade-jump-outline">` so the dashed border
// + flash animation kicks in. Splits text nodes cleanly so the underlying
// editor stays editable after the wrap is removed by the animation.
//
// `range.surroundContents` throws when the range crosses element boundaries
// (e.g. a selection that spans `<strong>` and plain text inside the same
// paragraph). For docx/markdown documents that's the common case since the
// review model bakes `<ins>`/`<del>` markers into the DOM. We take a more
// surgical approach here: split the start/end text nodes, replace the run
// between them with a single span holding the highlighted text, and bail
// out (by outlining the whole block) when the geometry doesn't work out.
function wrapRangeWithOutline(range: Range) {
  // Unwrap any previous outline before applying the new one — the wrapped
  // text must end up back in its parent paragraph, otherwise it disappears
  // from the editor. Critical for the "click annotation card twice in a
  // row" case where the first cleanup is still pending.
  clearExistingOutlines();
  if (range.collapsed) return;
  const span = document.createElement("span");
  span.className = "ade-jump-outline";
  try {
    const endNode = range.endContainer;
    const endOffset = range.endOffset;
    if (endNode.nodeType === Node.TEXT_NODE && endOffset < (endNode.textContent ?? "").length) {
      (endNode as Text).splitText(endOffset);
    }
    const startNode = range.startContainer;
    const startOffset = range.startOffset;
    let firstFragment: Node | null = null;
    if (startNode.nodeType === Node.TEXT_NODE && startOffset > 0) {
      const tail = (startNode as Text).splitText(startOffset);
      firstFragment = tail;
    } else {
      firstFragment = startNode;
    }
    if (!firstFragment) return;
    // Walk sibling nodes until we reach the (post-split) end node and
    // bundle them into the span. This avoids mutate-the-DOM-in-place
    // problems when `surroundContents` would throw.
    const collect: Node[] = [];
    let cursor: Node | null = firstFragment;
    while (cursor) {
      const next: Node | null = cursor.nextSibling;
      collect.push(cursor);
      if (cursor === endNode) break;
      cursor = next;
    }
    const host = firstFragment.parentNode;
    if (!host) return;
    if (collect.length === 0) return;
    host.insertBefore(span, collect[0]);
    for (const node of collect) {
      span.appendChild(node);
    }
  } catch {
    // Worst case: outline the whole block so the user still sees a hint.
    // We DON'T call clearExistingOutlines here because the existing wrap
    // (if any) is still inside the same paragraph; only the fallback wrap
    // was applied to the block.
    const blockHost = range.commonAncestorContainer;
    const block = (blockHost.nodeType === Node.ELEMENT_NODE ? blockHost as HTMLElement : blockHost.parentElement);
    if (!block) return;
    block.classList.add("ade-jump-outline");
    const blockEl = block;
    const timer = window.setTimeout(() => {
      blockEl.classList.remove("ade-jump-outline");
      if (pendingOutlineCleanup === timer) pendingOutlineCleanup = null;
    }, 2300);
    pendingOutlineCleanup = timer;
    return;
  }
  // Strip the span after the animation so the editor stays clean. The
  // unwrap routine restores the original DOM order — moving every child
  // back to the parent before detaching the span — so text is preserved
  // even if another jump fires before this timer elapses.
  const newSpan = span;
  const timer = window.setTimeout(() => {
    unwrapOutlineSpan(newSpan);
    if (pendingOutlineCleanup === timer) pendingOutlineCleanup = null;
  }, 2300);
  pendingOutlineCleanup = timer;
}

interface PopoverState {
  comment: ReviewComment;
  x: number;
  y: number;
}

export default function DocxView({ payload, onDocxSave, onSelection, onCreateAnnotation, agents = [], pendingJump, onJumpMissed, onReviewChange, pendingReviewJump, onRefresh, onOpenReview }: DocxViewProps) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Tracks an in-flight file refresh so the toolbar button can show a
  // spinner instead of the static icon. We disable the button while the
  // refresh is running to avoid double-clicks re-issuing the same fetch.
  const [refreshing, setRefreshing] = useState(false);
  // Review (track changes + comments) model. Null when the doc has no review
  // data or when we fell back to mammoth after our converter failed.
  const [review, setReview] = useState<DocxReviewModel | null>(null);
  const [showMarks, setShowMarks] = useState(true);
  const [showComments, setShowComments] = useState(true);
  // The legacy in-document review pane has been retired. We still let
  // docx-native comments float a small popover next to the matched
  // paragraph (mirrors what Word does), but the list view now lives in
  // the right-hand AnnotationPanel.
  const [popover, setPopover] = useState<PopoverState | null>(null);
  // "划词批注" mode: when on, releasing a text selection floats an inline
  // annotation composer next to the selection.
  const [annotateMode, setAnnotateMode] = useState(false);
  const [composer, setComposer] = useState<AnnotateComposerState | null>(null);
  // Document zoom (CSS `zoom` works reliably inside our Chromium-based
  // viewer and naturally cascades font sizes / images / tables the way
  // Word does). 1 = 100%. We clamp to [0.5, 2.5] so users can comfortably
  // read dense figures without overflowing the editor.
  const [zoom, setZoom] = useState(1);
  const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
  const setClosestZoom = (next: number) => {
    const clamped = Math.min(2.5, Math.max(0.5, next));
    // Snap to the nearest preset so the displayed % matches a known step
    // and feels intentional (mirrors the WPS / Word zoom selector).
    let best = ZOOM_STEPS[0];
    let bestDist = Math.abs(clamped - best);
    for (const step of ZOOM_STEPS) {
      const dist = Math.abs(clamped - step);
      if (dist < bestDist) { best = step; bestDist = dist; }
    }
    setZoom(best);
  };
  // Mirror `zoom` into a ref so `fitToWidth` (called from the file-open
  // effect and the toolbar button) reads the live value without going stale
  // behind a closure captured at an older render.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const hostRef = useRef<HTMLDivElement>(null);
  const fontSelectRef = useRef<HTMLSelectElement | null>(null);
  const fontHandlerRef = useRef<(() => void) | null>(null);
  const sizeSelectRef = useRef<HTMLSelectElement | null>(null);
  const sizeHandlerRef = useRef<(() => void) | null>(null);
  const savedRangeRef = useRef<Range | null>(null);

  // Whether the current document carries docx-native review data (track
  // changes or comments). Gates the 修改痕迹 / 批注 toolbar group so docs
  // without review data don't render dead controls. Mirrors the
  // `hasReviewData` check used during loading (see parse loop).
  const hasReview = !!review && (review.changes.length > 0 || review.comments.length > 0);

  const saveSelection = () => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && hostRef.current?.contains(selection.anchorNode)) {
      savedRangeRef.current = selection.getRangeAt(0).cloneRange();
    }
  };

  const restoreSelection = () => {
    const editor = hostRef.current;
    const saved = savedRangeRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return;
    if (!saved) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    selection.removeAllRanges();
    selection.addRange(saved);
  };

  const runCommand = (command: string, value?: string) => {
    restoreSelection();
    document.execCommand("styleWithCSS", false, "true");
    exec(command, value);
    setDirty(true);
  };

  // Prevent toolbar controls from stealing focus from the contentEditable.
  // Using mousedown + preventDefault keeps the selection alive so that
  // execCommand operates on the correct range.
  const preventFocusLoss = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  // Fit the document width to the visible editor window. We briefly drop to
  // zoom=1 so the measurement reflects the document's natural width (the
  // `width: max-content` frame otherwise bakes the current zoom in), then
  // snap to the closest preset. Called both from the toolbar button and on
  // every file open so each doc starts adapted to the window instead of
  // inheriting the previous file's zoom.
  function fitToWidth() {
    const node = hostRef.current;
    const container = node?.parentElement?.parentElement as HTMLElement | null; // .docx-document-frame > .docx-editor-body
    if (!node || !container) return;
    const previousZoom = zoomRef.current;
    setZoom(1);
    // Wait two RAFs: one for React to commit the zoom=1 update, one for the
    // browser to lay out the resulting natural width.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const naturalWidth = node.scrollWidth || node.offsetWidth;
      const containerWidth = container.clientWidth;
      if (naturalWidth > 0 && containerWidth > 0) {
        // Use the exact ratio (clamped to the zoom range) rather than snapping
        // to a preset: snapping up spills past the right edge and defeats the
        // point of fit-to-width. The dropdown below renders the live value as
        // a dynamic option so non-preset percentages still display correctly.
        setZoom(Math.min(2.5, Math.max(0.5, containerWidth / naturalWidth)));
      } else {
        setZoom(previousZoom);
      }
    }));
  }

  const bindFontSelect = (el: HTMLSelectElement | null) => {
    if (fontSelectRef.current && fontHandlerRef.current) {
      fontSelectRef.current.removeEventListener("change", fontHandlerRef.current);
    }
    fontSelectRef.current = el;
    if (!el) { fontHandlerRef.current = null; return; }
    const handler = () => {
      const value = el.value;
      if (!value) return;
      restoreSelection();
      setFontFamily(value);
      el.value = "";
      setDirty(true);
    };
    fontHandlerRef.current = handler;
    el.addEventListener("change", handler);
  };

  const bindSizeSelect = (el: HTMLSelectElement | null) => {
    if (sizeSelectRef.current && sizeHandlerRef.current) {
      sizeSelectRef.current.removeEventListener("change", sizeHandlerRef.current);
    }
    sizeSelectRef.current = el;
    if (!el) { sizeHandlerRef.current = null; return; }
    const handler = () => {
      const value = el.value;
      if (!value) return;
      restoreSelection();
      setFontSize(value);
      el.value = "";
      setDirty(true);
    };
    sizeHandlerRef.current = handler;
    el.addEventListener("change", handler);
  };

  useEffect(() => {
    let cancelled = false;
    const buffer = decodeBase64(payload.content);
    (window as any).__docxStatus = { step: "start", size: buffer.byteLength, relativePath: payload.relativePath };

    // Primary path: parse the docx ourselves so track changes (w:ins/w:del)
    // and comments survive into the editor. mammoth drops both, so we only
    // fall back to it if our converter fails outright — or if the doc has no
    // review data at all, in which case mammoth's higher fidelity wins.
    parseDocxForReview(buffer)
      .then((result) => {
        if (cancelled) return;
        const hasReviewData = result.model.changes.length > 0 || result.model.comments.length > 0;
        if (!hasReviewData) {
          // Plain doc: prefer mammoth for body fidelity.
          (window as any).__docxStatus = { step: "plain-mammoth" };
          void mammoth.convertToHtml({ arrayBuffer: buffer, buffer: buffer as never })
            .then((mammothResult) => {
              if (cancelled) return;
              setReview(null);
              setHtml(convertTiffImages(DOMPurify.sanitize(mammothResult.value)));
            })
            .catch(() => { if (!cancelled) { setReview(null); setHtml(result.html); } });
          return;
        }
        (window as any).__docxStatus = { step: "success-review", changes: result.model.changes.length, comments: result.model.comments.length };
        setReview(result.model);
        setHtml(result.html);
        setError("");
      })
      .catch(() => {
        // Converter failed: fall back to mammoth (clean HTML, no review data).
        (window as any).__docxStatus = { step: "fallback-mammoth" };
        void mammoth.convertToHtml({ arrayBuffer: buffer, buffer: buffer as never })
          .then((mammothResult) => {
            if (cancelled) return;
            setReview(null);
            setHtml(convertTiffImages(DOMPurify.sanitize(mammothResult.value)));
          })
          .catch((mammothReason) => {
            if (!cancelled) setError(String(mammothReason));
          });
      });

    return () => { cancelled = true; };
  }, [payload.content]);

  // When a new file's HTML is rendered, reset the scroll position to the
  // top-left and fit the document to the window. Without this, the zoom and
  // scroll chosen for the previous file carry over - a zoomed-in or scrolled
  // doc would open off-screen (content above/left of the viewport) and force
  // the user to scroll back to the start. scrollTop/Left=0 is set on the
  // .docx-editor-body scroll container directly; it survives the subsequent
  // zoom change because that container isn't re-created on re-render.
  useEffect(() => {
    if (!html) return;
    const container = hostRef.current?.parentElement?.parentElement as HTMLElement | null;
    if (container) { container.scrollTop = 0; container.scrollLeft = 0; }
    fitToWidth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && hostRef.current?.contains(selection.anchorNode)) {
        savedRangeRef.current = selection.getRangeAt(0).cloneRange();
      }
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  // Ctrl/Cmd + "+/-/0" zoom shortcuts. The listener is bound on the editor
  // surface only so it doesn't intercept global shortcuts (e.g. Cmd+= in
  // the right-hand inspector).
  useEffect(() => {
    if (!hostRef.current) return;
    const node = hostRef.current;
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      // Avoid hijacking shortcuts while the user is typing into a form field.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        setClosestZoom(zoom + 0.1);
      } else if (event.key === "-") {
        event.preventDefault();
        setClosestZoom(zoom - 0.1);
      } else if (event.key === "0") {
        event.preventDefault();
        setZoom(1);
      }
    };
    node.addEventListener("keydown", handler);
    return () => node.removeEventListener("keydown", handler);
  }, [zoom]);

  const captureSelection = () => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";
    if (!selectedText || !selection?.anchorNode || !hostRef.current?.contains(selection.anchorNode)) return;
    // When 划词批注 is off, do nothing here: leave the native selection intact
    // so the user can immediately apply formatting (bold, color, …) to it.
    // We deliberately skip onSelection so the inspector doesn't switch away.
    if (!annotateMode || !onCreateAnnotation) return;
    const host = hostRef.current;
    // textContent concatenates `<p>` blocks without separators, so counting
    // `\n` in it would yield nonsense. Instead we walk the rendered DOM to
    // (a) count block-level siblings before the selection and (b) get a total
    // block count. The result is a "paragraph index" the agent can use to
    // navigate the file with python-docx / mammoth.
    const ctx = selectionContext(payload, selectedText, host?.textContent ?? "");
    const paragraphIndex = host ? paragraphIndexBefore(host, selection.anchorNode) : -1;
    const totalParagraphs = host ? host.querySelectorAll(DOCX_BLOCK_SELECTOR).length : 0;
    if (paragraphIndex >= 0) {
      ctx.lineNumber = paragraphIndex + 1;
      ctx.totalLines = totalParagraphs;
    }
    onSelection(ctx);
    // Float the inline composer next to the selection so the user can annotate
    // immediately — no need to visit the right inspector.
    if (selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setComposer({
        x: rect.left + rect.width / 2,
        y: rect.bottom + 6,
        selectedText,
      });
    }
  };

  const handleInput = () => {
    setDirty(true);
  };

  const handleHostClick = (e: React.MouseEvent) => {
    // Event delegation: clicking a `[N]` comment badge opens a popover with
    // the comment text + replies.
    const marker = (e.target as HTMLElement).closest("[data-comment-id]") as HTMLElement | null;
    if (!marker) return;
    const id = marker.getAttribute("data-comment-id");
    if (!id || !review) return;
    const comment = review.comments.find((c) => c.id === id);
    if (!comment) return;
    const rect = marker.getBoundingClientRect();
    setPopover({ comment, x: rect.left, y: rect.bottom });
  };

  const flashElement = (id: string) => {
    const host = hostRef.current;
    if (!host) return;
    const escaped = CSS.escape(id);
    const el = host.querySelector<HTMLElement>(`[data-change-id="${escaped}"], [data-comment-id="${escaped}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("docx-flash");
    window.setTimeout(() => el.classList.remove("docx-flash"), 1600);
  };

  // Forward the parsed review model up to the parent so it can list
  // Word-style comments / tracked changes inside the right-hand
  // AnnotationPanel. Reset to null first when the payload changes so a
  // quick file switch doesn't briefly show the previous file's review
  // entries under the new file's annotations.
  useEffect(() => {
    onReviewChange?.(review);
  }, [review, onReviewChange]);

  // When the user clicks a docx-native review entry (track-change /
  // Word comment) in the right-hand panel, the parent forwards a
  // `pendingReviewJump` target. We flash the matching element in the
  // document and, for comments, surface the existing popover so the
  // thread stays readable. Bumping `nonce` re-runs the effect even when
  // the same id is clicked twice in a row (matches the pendingJump
  // pattern below).
  useEffect(() => {
    if (!pendingReviewJump || !html || !hostRef.current) return;
    const id = pendingReviewJump.id;
    if (pendingReviewJump.kind === "comment") {
      const reviewModel = review;
      const comment = reviewModel?.comments.find((c) => c.id === id);
      if (comment) {
        const rect = hostRef.current
          .querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`)
          ?.getBoundingClientRect();
        setPopover({ comment, x: rect?.left ?? window.innerWidth - 360, y: rect?.bottom ?? 80 });
      }
    }
    flashElement(id);
  }, [pendingReviewJump?.id, pendingReviewJump?.nonce, pendingReviewJump?.kind, html, review]); // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // "Jump to source" — when the user clicks an annotation card the right-hand
  // inspector forwards a `pendingJump` Annotation. We locate the matching
  // paragraph by `lineNumber` (paragraph index, 1-based) and wrap the text
  // range with a dashed outline so it catches the eye. When `lineNumber` is
  // missing we fall back to a prefix/suffix search. If neither strategy hits
  // we surface a toast via `onJumpMissed` and bail.
  //
  // Re-triggering the jump on the same card requires fresh effect runs. We
  // achieve that by appending `pendingJump.updatedAt` to the key so a re-click
  // (which produces a new object via `setPendingJump({ ...annotation })` in
  // App.tsx) re-fires this effect even when the user clicks the same row.
  // -------------------------------------------------------------------------
  const jumpKey = pendingJump ? `${pendingJump.id}:${pendingJump.updatedAt}` : null;
  useEffect(() => {
    if (!pendingJump || !html || !hostRef.current) return;
    const host = hostRef.current;
    const target = pendingJump.target;
    const lines = host.querySelectorAll<HTMLElement>(DOCX_BLOCK_SELECTOR);
    // 1) Resolve paragraph via lineNumber. We treat it as 1-based to match
    //    what the user reads on screen ("第 12 段"). When it's missing or out
    //    of range we drop to step 2 instead of silently failing.
    let targetBlock: HTMLElement | null = null;
    if (target.lineNumber && target.lineNumber >= 1 && target.lineNumber <= lines.length) {
      targetBlock = lines[target.lineNumber - 1];
    }
    // 2) Fallback: scan every block for a substring that contains both the
    //    stored prefix and the selected text. Without prefix we still try
    //    selectedText alone, accepting the first block whose textContent
    //    contains it.
    if (!targetBlock) {
      const needle = (target.selectedText ?? "").trim();
      if (needle) {
        for (const block of Array.from(lines)) {
          const text = block.textContent ?? "";
          if (text.includes(needle)) { targetBlock = block; break; }
        }
      }
    }
    if (!targetBlock) {
      onJumpMissed?.(pendingJump);
      return;
    }

    // 3) Locate the matched text within the block. We build a DOM Range
    //    around the first occurrence that fits inside the visible
    //    textContent. selectedText may include newlines (because docxReview
    //    inserts paragraph breaks as \n), so we ask for the substring's
    //    first occurrence index in textContent and walk the text nodes.
    const needle = (target.selectedText ?? "").trim();
    const range = document.createRange();
    let located = false;
    if (needle) {
      const blockText = targetBlock.textContent ?? "";
      const idx = blockText.indexOf(needle);
      if (idx >= 0) {
        locateRangeInText(targetBlock, idx, needle.length, range);
        located = true;
      } else {
        // Use prefix/suffix if available — that's the diagnostic snippet
        // captured at annotation time and is usually enough to find the
        // same sentence even when whitespace differs.
        const prefix = (target.prefix ?? "").slice(-40).trim();
        const tail = needle.slice(0, Math.max(8, Math.floor(needle.length / 4)));
        const fragment = `${prefix}${tail}`;
        const fIdx = fragment ? blockText.indexOf(fragment) : -1;
        if (fIdx >= 0) {
          locateRangeInText(targetBlock, fIdx + prefix.length, needle.length, range);
          located = true;
        }
      }
    }
    if (!located) {
      // The block exists but we can't find the specific range — still
      // scroll to the block and outline the whole paragraph so the user
      // sees their annotation landed somewhere sensible.
      const wholeRange = document.createRange();
      wholeRange.selectNodeContents(targetBlock);
      wrapRangeWithOutline(wholeRange);
    } else {
      wrapRangeWithOutline(range);
    }
    targetBlock.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [jumpKey, html, onJumpMissed, pendingJump]);

  const handleSave = async () => {
    if (!hostRef.current || saving || !onDocxSave) return;
    setSaving(true);
    setError("");
    try {
      const editedHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${hostRef.current.innerHTML}</body></html>`;
      await onDocxSave(editedHtml);
      setDirty(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  // Re-read the file from disk so the user can see whatever an external
  // agent just wrote. We prompt when there are unsaved changes — losing
  // them silently would be hostile, and the in-flight `payload.content`
  // becomes stale the moment the fetch lands anyway.
  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    if (dirty) {
      const ok = window.confirm("当前文档有未保存的修改，刷新后会丢失。是否继续？");
      if (!ok) return;
    }
    setRefreshing(true);
    setError("");
    try {
      await onRefresh();
      // Successful refresh resets dirty + review state: the new payload
      // arrives via the `payload.content` effect, but the dirty flag is
      // our local tracking and would otherwise stay stuck at "modified".
      setDirty(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRefreshing(false);
    }
  };

  // Insert an image from disk at the current caret position. We render the
  // image as a base64 data URL so it survives the html-to-docx round-trip
  // (the html-to-docx library embeds base64 <img> tags directly into the
  // resulting docx's media folder). A figure wrapper mirrors how Word
  // anchors images so the layout matches the rest of the document.
  //
  // We deliberately keep the data URL inline (rather than extracting it
  // to a separate part) because:
  //   1. The editor's contentEditable already inlines images this way for
  //      paste/drop, so behavior stays consistent.
  //   2. It avoids touching the relationship / content-type plumbing that
  //      mammoth strips on load — we'd have to rebuild it on save.
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const handleInsertImage = () => {
    imageInputRef.current?.click();
  };

  // Re-flow the document text at the current editor width. We can't rely on
  // the browser alone because:
  //   - The docx is loaded with `white-space: pre-wrap` so whitespace and
  //     soft line breaks from Word round-trip cleanly. But that also means
  //     longer lines are kept on a single line until they overflow.
  //   - The italicize-taxa script splits runs and can drop the boundary
  //     space between an italic and non-italic run, producing run-together
  //     text like "Planctomycetotaare". The browser has no way to know a
  //     missing space was *supposed* to be there.
  //
  // The rewrap pass does three things:
  //   1. Collapse runs of whitespace (multi-space / NBSP / soft newlines)
//      into a single regular space.
//   2. Insert a missing space between adjacent text nodes whose boundary
//      dropped it — only when both ends are letter/digit, so we don't
//      break legitimate compound identifiers.
//   3. Let the browser reflow each block at its current width.
  //
  // We intentionally leave <br>, <figure>, and other block-level elements
  // alone so the structure survives the round-trip back to docx.
  const handleRewrap = () => {
    const host = hostRef.current;
    if (!host) return;

    // Pass 1: collapse stray whitespace inside each text node.
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let textNode: Node | null;
    while ((textNode = walker.nextNode())) {
      const node = textNode as Text;
      const original = node.nodeValue ?? "";
      if (!/[ \t\f\v\n]{2,}|\u00a0/.test(original)) continue;
      const normalized = original
        .replace(/\u00a0/g, " ")
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/[ \t]*\n[ \t]*/g, " ");
      if (normalized !== original) node.nodeValue = normalized;
    }

    // Pass 2: re-insert boundary whitespace between adjacent text nodes when
    // one ends with [A-Za-z0-9] and the next begins with [A-Za-z0-9]. We
    // only patch the *first* missing space per node, otherwise a chain of
    // concatenated runs could balloon into "  " between words.
    const wordChar = /[A-Za-z0-9]/;
    const blocks = host.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote");
    blocks.forEach((block) => {
      const walker2 = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          // Skip text inside <code>/<pre> — those are literal monospace
          // blocks where adding spaces would be wrong.
          const parent = (n as Text).parentElement;
          if (parent && (parent.closest("code") || parent.closest("pre"))) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let prev: Text | null = null;
      let node: Node | null;
      while ((node = walker2.nextNode())) {
        const t = node as Text;
        const value = t.nodeValue ?? "";
        if (prev) {
          const prevVal = prev.nodeValue ?? "";
          const prevEnd = prevVal.slice(-1);
          const currStart = value.charAt(0);
          if (prevEnd && currStart && wordChar.test(prevEnd) && wordChar.test(currStart)) {
            // Insert exactly one space before `t`. Using a fresh text node
            // keeps the inline structure intact; replacing the leading char
            // would clobber formatting on the second run.
            const space = document.createTextNode(" ");
            t.parentNode?.insertBefore(space, t);
          }
        }
        if (value.length > 0) prev = t;
      }
    });

    setDirty(true);
  };
  const handleImageFileChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    // Always reset so picking the same file twice still triggers change.
    input.value = "";
    if (!file || !hostRef.current) return;
    // Refuse anything we can't reliably round-trip through html-to-docx.
    // PDF/SVG/TIFF are technically possible but the html-to-docx pipeline
    // is happiest with PNG/JPG/GIF/WebP — keep the UI consistent.
    const allowedTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
    if (!allowedTypes.has(file.type)) {
      setError(`不支持的图片格式：${file.type || "未知"}。请使用 PNG / JPG / GIF / WebP / BMP。`);
      return;
    }
    // Cap at 8 MB to avoid blowing up the docx with a 50 MB chart. Users
    // can always downscale externally and re-insert.
    if (file.size > 8 * 1024 * 1024) {
      setError(`图片过大（${(file.size / 1024 / 1024).toFixed(1)} MB），请压缩到 8 MB 以下。`);
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
      // Insert at the current selection (or wherever the editor chooses).
      // We restoreSelection() so the user's caret/anchor matters; execCommand
      // inserts the <img> as an inline element at that point.
      restoreSelection();
      // Use a figure wrapper to keep the image centered + max-width
      // constrained, matching the styling we apply to images parsed out of
      // docx natively (see docxReview.ts → renderImageHtml).
      const figure = document.createElement("figure");
      figure.className = "docx-figure docx-figure-inline";
      figure.setAttribute("style", "display:block;max-width:100%;height:auto;margin:10px auto;border-radius:2px");
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = file.name;
      figure.appendChild(img);
      const ok = document.execCommand("insertHTML", false, figure.outerHTML);
      if (!ok) {
        // Fallback: append at the end of the editor if execCommand refuses
        // (some browsers disable it on non-editable hosts).
        hostRef.current.appendChild(figure);
      }
      setDirty(true);
    } catch (reason) {
      setError(`插入图片失败：${String(reason)}`);
    }
  };

  const bodyClasses = useMemo(
    () => [
      "rich-document",
      "docx-document",
      showMarks ? "" : "hide-marks",
      showComments ? "" : "hide-comments",
    ].filter(Boolean).join(" "),
    [showMarks, showComments],
  );

  // CSS `zoom` resizes the box; we pair it with `width: max-content` so the
  // frame hugs the document's natural width at the chosen scale and the
  // surrounding scroll container picks up scrollbars accordingly.
  const frameStyle = useMemo(() => ({
    width: "max-content",
    minWidth: "100%",
    zoom,
  }), [zoom]);

  // The contentEditable surface must NOT be reconciled by React on unrelated
  // parent/state re-renders — doing so can collapse the user's active text
  // selection (the "selection flashes and disappears" bug). We memoise the
  // element so its reference stays stable across re-renders (React then skips
  // reconciling the subtree entirely) and only rebuilds it when the HTML or
  // class list actually changes. Live handlers are routed through a ref so the
  // memoised element always calls the latest closures.
  const handlersRef = useRef({
    onMouseDown: () => {},
    onMouseUp: () => {},
    onInput: () => {},
    onClick: (_e: React.MouseEvent) => {},
  });
  handlersRef.current = {
    onMouseDown: () => { if (composer) setComposer(null); },
    onMouseUp: () => { saveSelection(); captureSelection(); },
    onInput: handleInput,
    onClick: handleHostClick,
  };
  const editorSurface = useMemo(() => (
    <div className="docx-document-frame" style={frameStyle}>
      <div
        className={bodyClasses}
        ref={hostRef}
        contentEditable
        suppressContentEditableWarning
        onMouseDown={() => handlersRef.current.onMouseDown()}
        onMouseUp={() => handlersRef.current.onMouseUp()}
        onInput={() => handlersRef.current.onInput()}
        onClick={(e) => handlersRef.current.onClick(e)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  ), [html, bodyClasses, frameStyle]);

  return (
    <div className="docx-editor">
      <div className="docx-toolbar">
        <div className="docx-toolbar-group">
          <select
            ref={bindFontSelect}
            className="docx-toolbar-select"
            title="字体"
            defaultValue=""
            onMouseDown={saveSelection}
          >
            {FONT_FAMILIES.map((font) => (
              <option key={font.label} value={font.value} style={{ fontFamily: font.value || undefined }}>{font.label}</option>
            ))}
          </select>
          <select
            ref={bindSizeSelect}
            className="docx-toolbar-select"
            title="字号"
            defaultValue=""
            onMouseDown={saveSelection}
          >
            <option value="">字号</option>
            {FONT_SIZES.map((size) => (
              <option key={size.value} value={size.value}>{size.label}</option>
            ))}
          </select>
        </div>
        <div className="docx-toolbar-group">
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("bold")} title="加粗"><Bold size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("italic")} title="斜体"><Italic size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("underline")} title="下划线"><Underline size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("strikeThrough")} title="删除线"><Strikethrough size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("superscript")} title="上标"><Superscript size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("subscript")} title="下标"><Subscript size={14} /></button>
        </div>
        <div className="docx-toolbar-group">
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("justifyLeft")} title="左对齐"><AlignLeft size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("justifyCenter")} title="居中"><AlignCenter size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("justifyRight")} title="右对齐"><AlignRight size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("outdent")} title="减少缩进"><IndentDecrease size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("indent")} title="增加缩进"><IndentIncrease size={14} /></button>
        </div>
        <div className="docx-toolbar-group">
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("formatBlock", "H1")} title="标题 1"><Heading1 size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("formatBlock", "H2")} title="标题 2"><Heading2 size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("formatBlock", "P")} title="正文"><Type size={14} /></button>
        </div>
        <div className="docx-toolbar-group">
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("insertUnorderedList")} title="无序列表"><List size={14} /></button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => runCommand("insertOrderedList")} title="有序列表"><ListOrdered size={14} /></button>
        </div>
        <div className="docx-toolbar-group">
          <label className="docx-toolbar-color" title="文字颜色">
            <Palette size={14} />
            <input type="color" onMouseDown={saveSelection} onChange={(event) => { const value = event.target.value; restoreSelection(); document.execCommand("styleWithCSS", false, "true"); exec("foreColor", value); event.target.value = "#000000"; setDirty(true); }} />
          </label>
          <label className="docx-toolbar-color" title="高亮颜色">
            <Highlighter size={14} />
            <input type="color" onMouseDown={saveSelection} onChange={(event) => { const value = event.target.value; restoreSelection(); setHiliteColor(value); event.target.value = "#ffff00"; setDirty(true); }} />
          </label>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => { restoreSelection(); clearFormat(); setDirty(true); }} title="清除格式"><RemoveFormatting size={14} /></button>
        </div>
        <div className="docx-toolbar-group docx-zoom-group">
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => setClosestZoom(zoom - 0.1)} disabled={zoom <= ZOOM_STEPS[0]} title="缩小 (Ctrl + -)">
            <ZoomOut size={14} />
          </button>
          <select
            className="docx-toolbar-zoom-select"
            value={zoom}
            onMouseDown={preventFocusLoss}
            onChange={(event) => {
              const value = parseFloat(event.target.value);
              if (!Number.isNaN(value)) setZoom(value);
            }}
            title="选择缩放比例"
            aria-label="缩放比例"
          >
            {/* When fit-to-width picks a non-preset ratio (e.g. 0.73), render
                it as a leading option so the dropdown shows the real value
                instead of falling back to the first preset. */}
            {!ZOOM_STEPS.includes(zoom) && (
              <option value={zoom}>{Math.round(zoom * 100)}%</option>
            )}
            {ZOOM_STEPS.map((step) => (
              <option key={step} value={step}>{Math.round(step * 100)}%</option>
            ))}
          </select>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => setClosestZoom(zoom + 0.1)} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} title="放大 (Ctrl + +)">
            <ZoomIn size={14} />
          </button>
          <button type="button" onMouseDown={preventFocusLoss} onClick={() => setZoom(1)} title="实际大小 100%">
            <Maximize2 size={12} />
          </button>
          <button
            type="button"
            onMouseDown={preventFocusLoss}
            onClick={fitToWidth}
            title="适合宽度"
          >
            <Minimize2 size={12} />
          </button>
        </div>
        {hasReview && (
          <div className="docx-toolbar-group docx-review-group">
            <button type="button" className={showMarks ? "is-active" : ""} onMouseDown={preventFocusLoss} onClick={() => setShowMarks((v) => !v)} title="显示/隐藏修改痕迹">
              <History size={14} /> 修改痕迹
            </button>
            <button type="button" className={showComments ? "is-active" : ""} onMouseDown={preventFocusLoss} onClick={() => setShowComments((v) => !v)} title="显示/隐藏批注">
              <MessageSquare size={14} /> 批注
            </button>
          </div>
        )}
        {onOpenReview && (
          <div className="docx-toolbar-group">
            <button
              type="button"
              onMouseDown={preventFocusLoss}
              onClick={onOpenReview}
              title="打开审阅面板，查看所有 Word 修改痕迹与批注（类似 Word 审阅栏）"
            >
              <MessageSquareText size={14} /> 审阅
            </button>
          </div>
        )}
        {onRefresh && (
          <div className="docx-toolbar-group">
            <button
              type="button"
              onMouseDown={preventFocusLoss}
              onClick={handleRefresh}
              disabled={refreshing}
              title="重新从磁盘读取文档（Agent 修改后可点击查看最新内容）"
              aria-label="刷新文档"
            >
              {refreshing ? (
                <>
                  <LoaderCircle size={14} className="spin" /> 刷新中…
                </>
              ) : (
                <>
                  <RefreshCw size={14} /> 刷新
                </>
              )}
            </button>
          </div>
        )}
        <div className="docx-toolbar-group">
          <button
            type="button"
            onMouseDown={preventFocusLoss}
            onClick={handleRewrap}
            title="重新排版：合并多余空格 / 不间断空格为普通空格，浏览器会自动重新换行（不保存也能看效果）"
            aria-label="重新排版"
          >
            <WrapText size={14} /> 重新排版
          </button>
          <button
            type="button"
            onMouseDown={preventFocusLoss}
            onClick={handleInsertImage}
            title="在光标位置插入图片（支持 PNG / JPG / GIF / WebP / BMP，最大 8MB）"
            aria-label="插入图片"
          >
            <ImageIcon size={14} /> 插入图片
          </button>
          {/* Hidden file input — clicking the toolbar button triggers it. */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            style={{ display: "none" }}
            onChange={handleImageFileChosen}
          />
        </div>
        {onCreateAnnotation && (
          <div className="docx-toolbar-group docx-annotate-group">
            <button
              type="button"
              className={annotateMode ? "is-active" : ""}
              onMouseDown={preventFocusLoss}
              onClick={() => { setAnnotateMode((v) => !v); setComposer(null); }}
              title={annotateMode ? "关闭划词批注" : "开启划词批注：选中文字后自动弹出批注"}
            >
              <MessageSquarePlus size={14} /> 划词批注
            </button>
          </div>
        )}
        <div className="docx-toolbar-group">
          <button type="button" className="docx-save" disabled={!dirty || saving} onClick={handleSave} title="保存">
            <Save size={14} /> {saving ? "保存中…" : "保存"}
            {dirty && <i />}
          </button>
        </div>
      </div>
      <div className="docx-editor-row">
        <div className="docx-editor-body">
          {editorSurface}
        </div>
      </div>
      {popover && (
        <CommentPopover state={popover} onClose={() => setPopover(null)} />
      )}
      {composer && onCreateAnnotation && (
        <AnnotateComposer
          state={composer}
          agents={agents}
          onClose={() => setComposer(null)}
          onSubmit={async (body, priority, agentId) => {
            await onCreateAnnotation(body, priority, agentId);
            setComposer(null);
          }}
        />
      )}
    </div>
  );
}

function CommentPopover({ state, onClose }: { state: PopoverState; onClose: () => void }) {
  const { comment, x, y } = state;
  // Keep the popover on-screen.
  const left = Math.min(x, window.innerWidth - 340);
  const top = y + 8;
  return (
    <div className="docx-comment-popover" style={{ left, top }} role="dialog">
      <div className="docx-comment-popover-head">
        <strong>{comment.author}</strong>
        <small>{formatTime(comment.dateMs)}</small>
        <button type="button" onClick={onClose} aria-label="关闭">✕</button>
      </div>
      <p className="docx-comment-popover-body">{comment.text}</p>
      {comment.replies.length > 0 && (
        <div className="docx-comment-popover-replies">
          {comment.replies.map((r) => (
            <div key={r.id} className="docx-comment-reply">
              <span>{r.author}</span>
              <p>{r.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AnnotateComposer({ state, agents, onClose, onSubmit }: {
  state: AnnotateComposerState;
  agents: { id: string; name: string; available: boolean }[];
  onClose: () => void;
  onSubmit: (body: string, priority: Annotation["priority"], agentId?: string) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<Annotation["priority"]>("normal");
  const [agentId, setAgentId] = useState(agents.find((a) => a.available)?.id ?? agents[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { textareaRef.current?.focus(); }, []);

  // Keep the composer on-screen.
  const left = Math.min(Math.max(state.x, 170), window.innerWidth - 170);
  const top = Math.min(state.y, window.innerHeight - 220);
  const selectedAgentAvailable = agents.find((a) => a.id === agentId)?.available ?? false;

  async function commit(send: boolean) {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(body.trim(), priority, send ? agentId : undefined);
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  }

  return (
    <div
      className="docx-annotate-composer"
      style={{ left, top }}
      role="dialog"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="docx-annotate-quote"><Highlighter size={12} /><span>“{state.selectedText}”</span></div>
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="说明需要修改、核验或补充的内容…"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit(false);
        }}
      />
      <div className="docx-annotate-row">
        <select value={priority} onChange={(e) => setPriority(e.target.value as Annotation["priority"])}>
          <option value="normal">普通优先级</option>
          <option value="high">高优先级</option>
        </select>
        {agents.length > 0 && (
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.available}>{a.name}{a.available ? "" : "（未检测）"}</option>
            ))}
          </select>
        )}
      </div>
      {error && <div className="docx-annotate-error">{error}</div>}
      <div className="docx-annotate-actions">
        <button type="button" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" onClick={() => void commit(false)} disabled={busy || !body.trim()}>
          <MessageSquarePlus size={12} /> 仅保存
        </button>
        <button type="button" className="is-primary" onClick={() => void commit(true)} disabled={busy || !body.trim() || !selectedAgentAvailable}>
          <Send size={12} /> {busy ? "发送中…" : "发送给 Agent"}
        </button>
      </div>
    </div>
  );
}
