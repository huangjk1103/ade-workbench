import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileWarning,
  Highlighter,
  LoaderCircle,
  Maximize2,
  Minimize2,
  RotateCw,
  Send,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
  Annotation,
  AnnotationRect,
  FilePayload,
} from "../../types/domain";
import { selectionContext as buildSelectionContext } from "./shared";

// Configure the worker once at module load.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfViewProps {
  payload: FilePayload;
  annotations: Annotation[];
  onSelection: (selection: ReturnType<typeof buildSelectionContext> & { pageNumber?: number; rects?: AnnotationRect[] }) => void;
  onCreateAnnotation: (params: { body: string; priority: Annotation["priority"]; color?: string; pageNumber?: number; rects?: AnnotationRect[]; selectedText: string; agentId?: string }) => void;
  agents: { id: string; name: string; available: boolean }[];
  onOpenExternal: () => void;
  // Annotation forwarded from the right-hand inspector. We scroll to the
  // matching page and overlay a temporary dashed border on each stored
  // rect so the user sees exactly which run of text the card refers to.
  pendingJump?: Annotation | null;
  onJumpMissed?: (annotation: Annotation) => void;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes / 1024 / 1024 < 100 ? (bytes / 1024 / 1024).toFixed(2) : Math.round(bytes / 1024 / 1024)} MB`;
}

// Palette surfaced by the floating toolbar.
export const PDF_HIGHLIGHT_PALETTE: Array<{ id: string; label: string; color: string }> = [
  { id: "yellow", label: "默认", color: "#f5c971" },
  { id: "coral", label: "重要", color: "#ff8e72" },
  { id: "rose", label: "风险", color: "#d97a7a" },
  { id: "mint", label: "通过", color: "#5fd3c6" },
  { id: "lavender", label: "讨论", color: "#9c8fcf" },
];

function colorForAnnotation(annotation: Annotation): string {
  if (annotation.status === "resolved") return "rgba(120, 130, 140, 0.18)";
  if (annotation.target.color) return annotation.target.color;
  if (annotation.priority === "high") return PDF_HIGHLIGHT_PALETTE[1].color;
  return PDF_HIGHLIGHT_PALETTE[0].color;
}

// Bitmap rasterization width. 2400px ≈ 2× the previous 1200px target, so the
// rendered page stays sharp through typical zoom ranges. We re-render at a
// higher resolution on demand if the user pushes beyond ~2×.
const BITMAP_TARGET_WIDTH = 2400;

interface PageData {
  pageNumber: number;
  // Bitmap dimensions in CSS pixels. Matches the viewport scale used when
  // rasterizing, so the .pdf-page div sized to width × height aligns
  // exactly with the bitmap image.
  width: number;
  height: number;
  dataUrl: string;
  // Structured text content used to render the selectable overlay. Stored
  // per page so each PdfPage component can build its own TextLayer once the
  // bitmap and the text layer have a chance to share a coordinate system.
  textContent: TextContent | null;
  // PDF page dimensions in user units (points). Used to build the viewport
  // the text layer renders against.
  naturalWidth: number;
  naturalHeight: number;
  // Scale used to rasterize the bitmap. The text layer viewport must use
  // the same scale so its spans sit on top of the bitmap glyphs.
  renderScale: number;
}

interface FloatingToolbarState {
  pageNumber: number;
  rects: AnnotationRect[];
  selectedText: string;
  pageLeft: number;
  pageTop: number;
  fullSource: string;
}

export default function PdfView({ payload, annotations, onSelection, onCreateAnnotation, agents, onOpenExternal, pendingJump, onJumpMissed }: PdfViewProps) {
  const [pages, setPages] = useState<PageData[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [scale, setScale] = useState<number | null>(null);
  const [rotation, setRotation] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [toolbar, setToolbar] = useState<FloatingToolbarState | null>(null);
  const [toolbarAgentId, setToolbarAgentId] = useState(agents.find((agent) => agent.available)?.id ?? agents[0]?.id ?? "");
  const [toolbarNote, setToolbarNote] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const downloadUrl = useMemo(() => {
    if (payload.encoding !== "base64") return null;
    return URL.createObjectURL(bytesToBlob(base64ToBytes(payload.content), "application/pdf"));
  }, [payload.content, payload.encoding]);

  useEffect(() => () => {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  }, [downloadUrl]);

  // Track the scroll host's width so we can auto-fit and re-fit on resize.
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    setContainerWidth(host.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Render each page once: rasterize the bitmap and capture the structured
  // text content. Both share the same renderScale so positions in the text
  // layer match the bitmap glyphs exactly.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
    setPages([]);
    setPageIndex(0);
    setError("");
    setLoading(true);
    setProgress(0);
    setToolbar(null);
    setScale(null);

    if (payload.encoding !== "base64" || !payload.content) {
      setError("PDF 内容为空或编码格式不正确");
      setLoading(false);
      return;
    }

    try {
      const data = base64ToBytes(payload.content);
      loadingTask = pdfjs.getDocument({ data, disableRange: true, disableStream: true });
      loadingTask.onProgress = (loaded: { loaded: number; total: number }) => {
        if (cancelled || !loaded.total) return;
        setProgress(Math.min(99, Math.round((loaded.loaded / loaded.total) * 100)));
      };
      loadingTask.promise.then(async (document) => {
        if (cancelled) {
          await document.destroy();
          return;
        }
        const rendered: PageData[] = [];
        try {
          for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            if (cancelled) break;
            const page = await document.getPage(pageNumber);
            const defaultViewport = page.getViewport({ scale: 1, rotation: 0 });
            const renderScale = BITMAP_TARGET_WIDTH / defaultViewport.width;
            const viewport = page.getViewport({ scale: renderScale, rotation: 0 });
            const canvas = globalThis.document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext("2d");
            if (!context) {
              page.cleanup();
              continue;
            }
            await page.render({ canvasContext: context, viewport }).promise;
            let textContent: TextContent | null = null;
            try {
              textContent = await page.getTextContent();
            } catch {
              textContent = null;
            }
            rendered.push({
              pageNumber,
              width: viewport.width,
              height: viewport.height,
              dataUrl: canvas.toDataURL("image/png"),
              textContent,
              naturalWidth: defaultViewport.width,
              naturalHeight: defaultViewport.height,
              renderScale,
            });
            setProgress(Math.round((pageNumber / document.numPages) * 100));
            page.cleanup();
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        } finally {
          await document.destroy();
        }
        if (cancelled) return;
        setPages(rendered);
        setLoading(false);
      }).catch((reason) => {
        if (cancelled) return;
        setError(String(reason?.message ?? reason));
        setLoading(false);
      });
    } catch (reason) {
      setError(String(reason));
      setLoading(false);
    }
    return () => {
      cancelled = true;
      if (loadingTask) loadingTask.destroy();
    };
  }, [payload.content, payload.encoding, payload.relativePath]);

  // Auto-fit the first page to the available container width once both
  // values are known.
  useEffect(() => {
    if (scale !== null) return;
    if (!pages.length || containerWidth <= 0) return;
    const firstPage = pages[0];
    const usable = Math.max(200, containerWidth - 32);
    const fitted = usable / firstPage.width;
    setScale(Math.min(1, fitted));
  }, [pages, containerWidth, scale]);

  // Track which page is closest to the viewport center.
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      if (visible.length === 0) return;
      const center = host.scrollTop + host.clientHeight / 2;
      const closest = visible.reduce((acc, entry) => {
        const rect = entry.boundingClientRect;
        const distance = Math.abs(rect.top - center);
        return distance < acc.distance ? { entry, distance } : acc;
      }, { entry: visible[0], distance: Number.POSITIVE_INFINITY });
      const index = pages.findIndex((page) => `pdf-page-${page.pageNumber}` === closest.entry.target.id);
      if (index >= 0) setPageIndex(index);
    }, { root: host, threshold: [0, 0.5, 1] });
    pages.forEach((page) => {
      const element = document.getElementById(`pdf-page-${page.pageNumber}`);
      if (element) observer.observe(element);
    });
    return () => observer.disconnect();
  }, [pages]);

  const goToPage = useCallback((index: number) => {
    const target = pages[index];
    if (!target) return;
    document.getElementById(`pdf-page-${target.pageNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [pages]);

  // -------------------------------------------------------------------------
  // Jump-to-source for PDFs. PDF annotations don't carry DOM offsets so we
  // hop to the page and overlay a dashed-border rectangle directly on top
  // of each stored `rect`. We deliberately render the outline as an overlay
  // (not a permanent highlight) because the user already has a permanent
  // highlight from the annotation itself; the overlay is the "you are
  // looking here" affordance and disappears after ~2s.
  // -------------------------------------------------------------------------
  const jumpKey = pendingJump ? `${pendingJump.id}:${pendingJump.updatedAt}` : null;
  useEffect(() => {
    if (!pendingJump) return;
    if (pages.length === 0) return;
    const target = pendingJump.target;
    if (!target.pageNumber) {
      onJumpMissed?.(pendingJump);
      return;
    }
    const pageIndexForTarget = pages.findIndex((page) => page.pageNumber === target.pageNumber);
    if (pageIndexForTarget < 0) {
      onJumpMissed?.(pendingJump);
      return;
    }
    // Wipe any existing outlines so back-to-back jumps stay clean.
    document.querySelectorAll(".pdf-jump-outline").forEach((node) => node.remove());
    // Smooth scroll to the target page; the overlay is added after the
    // scrollIntoView promise (a microtask is enough since we're not waiting
    // for an actual scrollend event).
    document.getElementById(`pdf-page-${target.pageNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    const host = document.getElementById(`pdf-page-${target.pageNumber}`);
    if (!host) {
      onJumpMissed?.(pendingJump);
      return;
    }
    const rects = target.rects && target.rects.length > 0 ? target.rects : null;
    if (!rects) {
      onJumpMissed?.(pendingJump);
      return;
    }
    // Append to the existing annotation layer so the dashed border sits on
    // top of the permanent highlights; appending directly to `.pdf-page`
    // risks being drawn under the text layer's transparent characters.
    const layer = host.querySelector<HTMLElement>(".pdf-annotation-layer") ?? host;
    for (const rect of rects) {
      const overlay = document.createElement("div");
      overlay.className = "pdf-jump-outline";
      overlay.style.left = `${rect.x}px`;
      overlay.style.top = `${rect.y}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      layer.appendChild(overlay);
    }
    setPageIndex(pageIndexForTarget);
    window.setTimeout(() => {
      layer.querySelectorAll(".pdf-jump-outline").forEach((node) => node.remove());
    }, 2300);
  }, [jumpKey, pages, onJumpMissed, pendingJump]);

  const fitToWidth = useCallback(() => {
    if (!pages.length || containerWidth <= 0) return;
    const firstPage = pages[0];
    const usable = Math.max(200, containerWidth - 32);
    setScale(Math.min(2, usable / firstPage.width));
  }, [pages, containerWidth]);

  const handleDownload = () => {
    if (!downloadUrl) return;
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = payload.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  useEffect(() => {
    if (!toolbar) return;
    function handleMouseDown(event: MouseEvent) {
      if (!toolbarRef.current) return;
      const target = event.target as Node;
      if (!toolbarRef.current.contains(target)) {
        if (event.button !== 0) return;
        if ((target as HTMLElement).closest?.(".pdf-page")) return;
        setToolbar(null);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [toolbar]);

  function commitHighlight(color: string, withNote: boolean) {
    if (!toolbar) return;
    const agent = agents.find((item) => item.id === toolbarAgentId);
    onCreateAnnotation({
      body: withNote ? (toolbarNote.trim() || "请查看选中内容") : "请查看选中内容",
      priority: color === PDF_HIGHLIGHT_PALETTE[2].color ? "high" : "normal",
      color,
      pageNumber: toolbar.pageNumber,
      rects: toolbar.rects,
      selectedText: toolbar.selectedText,
      agentId: withNote && agent?.available ? toolbarAgentId : undefined,
    });
    setToolbar(null);
    setToolbarNote("");
    window.getSelection()?.removeAllRanges();
  }

  const currentPage = pages[pageIndex];
  const annotationsByPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const annotation of annotations) {
      if (annotation.target.filePath !== payload.relativePath) continue;
      if (!annotation.target.pageNumber) continue;
      const list = map.get(annotation.target.pageNumber) ?? [];
      list.push(annotation);
      map.set(annotation.target.pageNumber, list);
    }
    return map;
  }, [annotations, payload.relativePath]);

  if (error) {
    return (
      <div className="viewer-state pdf-fallback">
        <AlertTriangle size={28} />
        <strong>无法解析 PDF 文件</strong>
        <span>{error}</span>
        <div className="pdf-fallback-actions">
          <button type="button" className="is-primary" onClick={onOpenExternal}>
            <ExternalLink size={14} /> 使用系统 PDF 阅读器打开
          </button>
          <button type="button" onClick={handleDownload} disabled={!downloadUrl}>
            <Download size={14} /> 下载到本地
          </button>
        </div>
        <small>{payload.relativePath}</small>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="viewer-state pdf-loading-state">
        <LoaderCircle className="spin" size={28} />
        <strong>正在解析 PDF…</strong>
        <div className="pdf-progress">
          <div className="pdf-progress-bar" style={{ width: `${progress}%` }} />
        </div>
        <small>{progress}% · {formatBytes(payload.size)}</small>
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div className="viewer-state pdf-fallback">
        <FileWarning size={28} />
        <strong>PDF 文件没有可显示的页面</strong>
        <div className="pdf-fallback-actions">
          <button type="button" className="is-primary" onClick={onOpenExternal}>
            <ExternalLink size={14} /> 使用系统 PDF 阅读器打开
          </button>
          <button type="button" onClick={handleDownload} disabled={!downloadUrl}>
            <Download size={14} /> 下载到本地
          </button>
        </div>
      </div>
    );
  }

  const effectiveScale = scale ?? Math.min(1, (containerWidth || 800) / pages[0].width);

  return (
    <div className="pdf-host">
      <div className="pdf-toolbar">
        <span className="pdf-toolbar-title">{payload.name}</span>
        <span className="pdf-toolbar-meta">{formatBytes(payload.size)} · {pages.length} 页</span>
        <div className="pdf-toolbar-group">
          <button type="button" onClick={() => goToPage(pageIndex - 1)} disabled={pageIndex <= 0} title="上一页">
            <ChevronLeft size={13} />
          </button>
          <span className="pdf-toolbar-page">
            {currentPage ? currentPage.pageNumber : pageIndex + 1} / {pages.length}
          </span>
          <button type="button" onClick={() => goToPage(pageIndex + 1)} disabled={pageIndex >= pages.length - 1} title="下一页">
            <ChevronRight size={13} />
          </button>
        </div>
        <div className="pdf-toolbar-group">
          <button type="button" onClick={() => setScale((value) => (value ?? effectiveScale) - 0.2)} title="缩小">
            <ZoomOut size={13} />
          </button>
          <span className="pdf-toolbar-scale">{Math.round(effectiveScale * 100)}%</span>
          <button type="button" onClick={() => setScale((value) => (value ?? effectiveScale) + 0.2)} title="放大">
            <ZoomIn size={13} />
          </button>
          <button type="button" onClick={() => setScale(1)} title="实际大小 (100%)"><Maximize2 size={12} /></button>
          <button type="button" onClick={fitToWidth} title="适合宽度"><Minimize2 size={12} /></button>
          <button type="button" onClick={() => setRotation((value) => (value + 90) % 360)} title="旋转">
            <RotateCw size={13} />
          </button>
        </div>
        <div className="pdf-toolbar-spacer" />
        <button type="button" onClick={onOpenExternal} title="使用系统 PDF 阅读器打开">
          <ExternalLink size={13} /> 系统打开
        </button>
        <button type="button" onClick={handleDownload} disabled={!downloadUrl} title="下载到本地">
          <Download size={13} /> 下载
        </button>
      </div>
      <div className="pdf-scroll" ref={scrollRef}>
        <div
          className="pdf-pages"
          style={{
            width: pages[0] ? `${pages[0].width}px` : undefined,
            height: pages[0] ? `${pages[0].height * effectiveScale}px` : undefined,
            transform: `scale(${effectiveScale}) rotate(${rotation}deg)`,
            transformOrigin: "top left",
          }}
        >
          {pages.map((page) => (
            <PdfPage
              key={page.pageNumber}
              page={page}
              scale={effectiveScale}
              annotations={annotationsByPage.get(page.pageNumber) ?? []}
              onSelection={(info) => {
                setToolbar(info);
                onSelection({
                  ...buildSelectionContext(payload, info.selectedText, info.fullSource),
                  pageNumber: info.pageNumber,
                  rects: info.rects,
                });
              }}
              onDismissToolbar={() => setToolbar((current) => current && current.pageNumber === page.pageNumber ? null : current)}
            />
          ))}
        </div>
        {toolbar && (
          <div
            className="pdf-floating-toolbar"
            ref={toolbarRef}
            style={{
              position: "fixed",
              left: `${toolbar.pageLeft + (toolbar.rects[toolbar.rects.length - 1].x + toolbar.rects[toolbar.rects.length - 1].width / 2) * effectiveScale}px`,
              top: `${toolbar.pageTop + (toolbar.rects[toolbar.rects.length - 1].y + toolbar.rects[toolbar.rects.length - 1].height) * effectiveScale + 6}px`,
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="pdf-floating-row">
              {PDF_HIGHLIGHT_PALETTE.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  title={`${entry.label} 高亮`}
                  aria-label={entry.label}
                  style={{ background: entry.color }}
                  onClick={() => commitHighlight(entry.color, false)}
                />
              ))}
              <span className="pdf-floating-divider" />
              <button type="button" className="pdf-floating-note" title="添加批注并发送给 Agent" onClick={() => commitHighlight(PDF_HIGHLIGHT_PALETTE[0].color, true)}>
                <Highlighter size={12} /> 批注
              </button>
            </div>
            <div className="pdf-floating-row">
              <select value={toolbarAgentId} onChange={(event) => setToolbarAgentId(event.target.value)} title="派发目标 Agent">
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id} disabled={!agent.available}>{agent.name}{agent.available ? "" : "（未检测）"}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="补充说明（可空）"
                value={toolbarNote}
                onChange={(event) => setToolbarNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitHighlight(PDF_HIGHLIGHT_PALETTE[0].color, true);
                  if (event.key === "Escape") setToolbar(null);
                }}
              />
              <button type="button" className="pdf-floating-send" title="保存批注并发送给 Agent" onClick={() => commitHighlight(PDF_HIGHLIGHT_PALETTE[0].color, true)} disabled={!agents.find((agent) => agent.id === toolbarAgentId)?.available}>
                <Send size={12} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface PdfPageProps {
  page: PageData;
  scale: number;
  annotations: Annotation[];
  onSelection: (info: FloatingToolbarState) => void;
  onDismissToolbar: () => void;
}

function PdfPage({ page, scale, annotations, onSelection, onDismissToolbar }: PdfPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

  // Render the pdf.js text layer directly into the visible page element.
  //
  // Earlier we captured the layer's innerHTML in an off-screen container and
  // re-injected it here, but pdf.js writes span positions as
  // `calc(var(--scale-factor) * Xpx)` and bakes the host's --scale-factor
  // into that expression. Moving the spans to a new host without restoring
  // the variable silently zeroed out the positions, which is why selection
  // felt broken. Rendering in-place lets pdf.js set up --scale-factor (via
  // setLayerDimensions), the container size, and the font measurement in a
  // single pass against the live DOM.
  useEffect(() => {
    let cancelled = false;
    let textLayer: pdfjs.TextLayer | null = null;
    const host = textLayerRef.current;
    if (!host) return;
    host.innerHTML = "";
    if (!page.textContent) return;

    // Build a viewport matching the rendered bitmap so the text layer's
    // coordinates land on the same pixels as the canvas.
    //
    // pdf.js's PageViewport class isn't exported, so we pass a minimal
    // duck-typed object that exposes only the fields the TextLayer reads:
    // `scale`, `rotation`, and `rawDims`. The `instanceof PageViewport`
    // check inside `setLayerDimensions` will skip the inline width/height
    // assignment, but we set both manually on the host below, which is
    // sufficient for the spans (they use percentages relative to the
    // container when it's also the root container, and `calc(--scale-factor
    // * Xpx)` otherwise).
    const viewport = {
      scale: page.renderScale,
      rotation: 0,
      get rawDims() {
        return {
          pageWidth: page.naturalWidth,
          pageHeight: page.naturalHeight,
          pageX: 0,
          pageY: 0,
        };
      },
    } as unknown as pdfjs.PageViewport;

    // Set --scale-factor and container size up front so the TextLayer's
    // calc() expressions resolve to the right CSS pixels.
    host.style.setProperty("--scale-factor", String(page.renderScale));
    host.style.width = `${page.width}px`;
    host.style.height = `${page.height}px`;

    try {
      textLayer = new pdfjs.TextLayer({
        textContentSource: page.textContent,
        container: host,
        viewport,
      });
    } catch (reason) {
      console.warn("TextLayer init failed", reason);
      return;
    }

    void textLayer.render().catch((reason) => {
      if (!cancelled) console.warn("TextLayer render failed", reason);
    });

    return () => {
      cancelled = true;
      if (textLayer) textLayer.cancel();
      host.innerHTML = "";
    };
  }, [page]);

  function handleMouseUp(event: React.MouseEvent<HTMLDivElement>) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      if (!selection?.toString()) onDismissToolbar();
      return;
    }
    const selectedText = selection.toString().trim();
    if (!selectedText) return;
    const range = selection.getRangeAt(0);
    const pageRect = pageRef.current?.getBoundingClientRect();
    if (!pageRect) return;
    const rects: AnnotationRect[] = [];
    const iterator = document.createNodeIterator(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = iterator.nextNode())) {
      const textNode = node as Text;
      if (!selection.containsNode(textNode, true)) continue;
      const span = textNode.parentElement?.getBoundingClientRect();
      if (!span) continue;
      rects.push({
        x: (span.left - pageRect.left) / scale,
        y: (span.top - pageRect.top) / scale,
        width: span.width / scale,
        height: span.height / scale,
      });
    }
    if (rects.length === 0) {
      const fallback = range.getBoundingClientRect();
      if (!fallback.width && !fallback.height) return;
      rects.push({
        x: (fallback.left - pageRect.left) / scale,
        y: (fallback.top - pageRect.top) / scale,
        width: fallback.width / scale,
        height: fallback.height / scale,
      });
    }
    onSelection({
      pageNumber: page.pageNumber,
      rects,
      selectedText,
      pageLeft: pageRect.left,
      pageTop: pageRect.top,
      fullSource: page.dataUrl,
    });
    event.stopPropagation();
  }

  return (
    <div
      className="pdf-page"
      id={`pdf-page-${page.pageNumber}`}
      data-pdf-page-number={page.pageNumber}
      ref={pageRef}
      style={{ width: `${page.width}px`, height: `${page.height}px` }}
      onMouseUp={handleMouseUp}
    >
      <img src={page.dataUrl} alt={`第 ${page.pageNumber} 页`} draggable={false} />
      <div className="pdf-text-layer" ref={textLayerRef} />
      <div className="pdf-annotation-layer" aria-hidden="true">
        {annotations.flatMap((annotation) =>
          (annotation.target.rects ?? []).map((rect, index) => (
            <div
              key={`${annotation.id}-${index}`}
              className={`pdf-highlight pdf-highlight--${annotation.status}`}
              style={{
                left: rect.x,
                top: rect.y,
                width: rect.width,
                height: rect.height,
                background: colorForAnnotation(annotation),
              }}
              title={annotation.body}
            />
          )),
        )}
      </div>
      <div className="pdf-page-number">{page.pageNumber}</div>
    </div>
  );
}