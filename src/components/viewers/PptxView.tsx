import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ImagePlus,
  Italic,
  Maximize2,
  MessageSquarePlus,
  MousePointer2,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
  Play,
  Save,
  Search,
  Trash2,
  Type,
  Underline,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { init as initPptx } from "pptx-preview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeBase64,
  editPowerPoint,
  readPowerPointModel,
  type PowerPointEditOperation,
  type PowerPointModel,
  type PowerPointTextShape,
} from "../../lib/bridge";
import type { Annotation, FilePayload, TextSelectionContext } from "../../types/domain";
import { selectionContext, ViewerError } from "./shared";

const BASE_SLIDE_WIDTH = 960;
const DEFAULT_SLIDE_HEIGHT = 540;
const THUMBNAIL_WIDTH = 140;
const MIN_ZOOM = 25;
const MAX_ZOOM = 200;
const FONT_OPTIONS = ["微软雅黑", "宋体", "黑体", "楷体", "Arial", "Calibri", "Aptos", "Times New Roman"];

interface PptxViewProps {
  payload: FilePayload;
  rootPath: string;
  onOpenExternal: () => void;
  onRefresh?: () => Promise<void>;
  onSelection?: (selection: TextSelectionContext) => void;
  pendingJump?: Annotation | null;
  onJumpMissed?: (annotation: Annotation) => void;
}

interface LocalShape extends PowerPointTextShape {
  dataBase64?: string;
  imageExtension?: string;
}

interface LocalPowerPointModel extends Omit<PowerPointModel, "slides"> {
  slides: Array<Omit<PowerPointModel["slides"][number], "shapes"> & { shapes: LocalShape[] }>;
}

const DESIGN_PRESETS = {
  original: { label: "原始样式", background: "", text: "", title: "" },
  minimal: { label: "简洁白", background: "FFFFFF", text: "24272C", title: "D45B32" },
  academic: { label: "学术蓝", background: "F4F7FB", text: "20344A", title: "1F5F8B" },
  dark: { label: "深色演示", background: "172033", text: "F4F7FB", title: "63C7E5" },
  warm: { label: "暖色报告", background: "FBF5EA", text: "4B3A2B", title: "A85D35" },
} as const;

function cloneModel(model: PowerPointModel): LocalPowerPointModel {
  return structuredClone(model) as LocalPowerPointModel;
}

function clampSlide(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index));
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(element.tagName);
}

function normalizedColor(value: string): string {
  return value.replace("#", "").toUpperCase().padStart(6, "0").slice(-6);
}

function textShapeChanged(before: LocalShape, after: LocalShape): boolean {
  const fields: Array<keyof LocalShape> = [
    "text", "x", "y", "width", "height", "fontName", "fontSize", "color",
    "bold", "italic", "underline", "alignment",
  ];
  return fields.some((field) => before[field] !== after[field]);
}

function buildEditOperations(baseline: LocalPowerPointModel | null, current: LocalPowerPointModel | null): PowerPointEditOperation[] {
  if (!baseline || !current) return [];
  const operations: PowerPointEditOperation[] = [];
  current.slides.forEach((slide, slideOffset) => {
    const originalSlide = baseline.slides[slideOffset];
    if (!originalSlide) return;
    if (normalizedColor(slide.backgroundColor) !== normalizedColor(originalSlide.backgroundColor)
      || slide.followMasterBackground !== originalSlide.followMasterBackground) {
      operations.push({ kind: "setBackground", slideIndex: slide.index, color: normalizedColor(slide.backgroundColor) });
    }

    const currentById = new Map(slide.shapes.map((shape) => [shape.id, shape]));
    originalSlide.shapes.forEach((before) => {
      const after = currentById.get(before.id);
      if (!after) {
        operations.push({ kind: "deleteShape", slideIndex: slide.index, shapeId: before.id });
      } else if (textShapeChanged(before, after)) {
        operations.push({
          kind: "updateText",
          slideIndex: slide.index,
          shapeId: after.id,
          text: after.text,
          x: after.x,
          y: after.y,
          width: after.width,
          height: after.height,
          fontName: after.fontName,
          fontSize: after.fontSize,
          color: normalizedColor(after.color),
          bold: after.bold,
          italic: after.italic,
          underline: after.underline,
          alignment: after.alignment,
        });
      }
    });

    slide.shapes.filter((shape) => shape.id < 0).forEach((shape) => {
      if (shape.dataBase64) {
        operations.push({
          kind: "addImage",
          slideIndex: slide.index,
          x: shape.x,
          y: shape.y,
          width: shape.width,
          height: shape.height,
          dataBase64: shape.dataBase64,
          extension: shape.imageExtension || "png",
        });
      } else {
        operations.push({
          kind: "addText",
          slideIndex: slide.index,
          text: shape.text,
          x: shape.x,
          y: shape.y,
          width: shape.width,
          height: shape.height,
          fontName: shape.fontName,
          fontSize: shape.fontSize,
          color: normalizedColor(shape.color),
          bold: shape.bold,
          italic: shape.italic,
          underline: shape.underline,
          alignment: shape.alignment,
        });
      }
    });
  });
  return operations;
}

async function replaceEmbeddedTiffImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>("img[src^='data:']"));
  const candidates = images.filter((image) => {
    const source = image.getAttribute("src") ?? "";
    const data = source.slice(source.indexOf(",") + 1).replace(/\s/g, "");
    return /image\/(?:tif|tiff)/i.test(source) || data.startsWith("SUkq") || data.startsWith("TU0A");
  });
  if (!candidates.length) return;
  const { tiffDataUrlToPngDataUrl } = await import("../../lib/tiff");
  for (const image of candidates) {
    const converted = tiffDataUrlToPngDataUrl(image.getAttribute("src") ?? "");
    if (converted) image.src = converted;
  }
}

function SlideThumbnail({ source, height }: { source: HTMLElement; height: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const clone = source.cloneNode(true) as HTMLElement;
        clone.style.display = "block";
        clone.style.margin = "0";
        clone.removeAttribute("hidden");
        host.replaceChildren(clone);
      });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(source, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      host.replaceChildren();
    };
  }, [source]);
  const scale = THUMBNAIL_WIDTH / BASE_SLIDE_WIDTH;
  return (
    <div className="pptx-thumbnail-viewport" style={{ width: THUMBNAIL_WIDTH, height: height * scale }}>
      <div className="pptx-thumbnail-content" ref={hostRef} style={{ width: BASE_SLIDE_WIDTH, height, transform: `scale(${scale})` }} />
    </div>
  );
}

export default function PptxView({ payload, rootPath, onOpenExternal, onRefresh, onSelection, pendingJump, onJumpMissed }: PptxViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const nextLocalIdRef = useRef(-1);
  const [slides, setSlides] = useState<HTMLElement[]>([]);
  const [slideHeight, setSlideHeight] = useState(DEFAULT_SLIDE_HEIGHT);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [fitMode, setFitMode] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [editorEnabled, setEditorEnabled] = useState(false);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [baselineModel, setBaselineModel] = useState<LocalPowerPointModel | null>(null);
  const [editorModel, setEditorModel] = useState<LocalPowerPointModel | null>(null);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState("");
  const [selectedShapeId, setSelectedShapeId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorNotice, setEditorNotice] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    host.replaceChildren();
    const previewer = initPptx(host, { width: BASE_SLIDE_WIDTH, height: DEFAULT_SLIDE_HEIGHT, mode: "list" });
    setLoading(true);
    setError("");
    setSlides([]);
    void previewer.preview(decodeBase64(payload.content)).then(async () => {
      if (cancelled) return;
      await replaceEmbeddedTiffImages(host);
      if (cancelled) return;
      const renderedSlides = Array.from(host.querySelectorAll<HTMLElement>(".pptx-preview-slide-wrapper"));
      if (!renderedSlides.length) throw new Error("演示文稿中没有可显示的幻灯片");
      const measuredHeight = Number.parseFloat(renderedSlides[0].style.height) || DEFAULT_SLIDE_HEIGHT;
      setSlideHeight(measuredHeight);
      setSlides(renderedSlides);
      setCurrentSlide((index) => clampSlide(index, renderedSlides.length));
      setLoading(false);
    }).catch((reason) => {
      if (cancelled) return;
      setLoading(false);
      setError(String(reason));
    });
    return () => {
      cancelled = true;
      previewer.destroy();
      host.replaceChildren();
    };
  }, [payload.content]);

  useEffect(() => {
    let cancelled = false;
    setModelLoading(true);
    setModelError("");
    void readPowerPointModel(rootPath, payload.relativePath).then((model) => {
      if (cancelled) return;
      const local = cloneModel(model);
      setBaselineModel(local);
      setEditorModel(cloneModel(model));
      setSelectedShapeId(null);
      setModelLoading(false);
    }).catch((reason) => {
      if (cancelled) return;
      setModelLoading(false);
      setModelError(String(reason));
    });
    return () => { cancelled = true; };
  }, [payload.modifiedMs, payload.relativePath, rootPath]);

  useEffect(() => {
    slides.forEach((slide, index) => {
      slide.style.display = index === currentSlide ? "block" : "none";
      slide.style.margin = "0";
    });
  }, [currentSlide, slides]);

  const goToSlide = useCallback((index: number) => {
    setCurrentSlide(clampSlide(index, slides.length));
    setSelectedShapeId(null);
  }, [slides.length]);

  const fitToStage = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !slides.length) return;
    const padding = document.fullscreenElement === stage ? 28 : 48;
    const widthScale = (stage.clientWidth - padding) / BASE_SLIDE_WIDTH;
    const heightScale = (stage.clientHeight - padding) / slideHeight;
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(Math.min(widthScale, heightScale) * 100))));
  }, [slideHeight, slides.length]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !fitMode) return;
    const observer = new ResizeObserver(() => fitToStage());
    observer.observe(stage);
    const frame = requestAnimationFrame(fitToStage);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [fitMode, fitToStage, editorEnabled]);

  const setManualZoom = useCallback((next: number) => {
    setFitMode(false);
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  }, []);

  const useFitZoom = useCallback(() => {
    setFitMode(true);
    requestAnimationFrame(fitToStage);
  }, [fitToStage]);

  const startPresentation = useCallback(async (fromStart: boolean) => {
    const stage = stageRef.current;
    if (!stage) return;
    if (fromStart) setCurrentSlide(0);
    setFitMode(true);
    try { await stage.requestFullscreen(); } catch (reason) { setError(`无法进入全屏放映：${String(reason)}`); }
  }, []);

  useEffect(() => {
    const handleFullscreen = () => {
      const fullscreen = document.fullscreenElement === stageRef.current;
      setIsFullscreen(fullscreen);
      if (fullscreen) { setFitMode(true); requestAnimationFrame(fitToStage); }
    };
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () => document.removeEventListener("fullscreenchange", handleFullscreen);
  }, [fitToStage]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === "F5") { event.preventDefault(); void startPresentation(!event.shiftKey); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && editorEnabled) {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>(".pptx-editor-save")?.click();
        return;
      }
      if (["ArrowRight", "ArrowDown", "PageDown"].includes(event.key) || (isFullscreen && event.key === " ")) {
        event.preventDefault(); goToSlide(currentSlide + 1);
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault(); goToSlide(currentSlide - 1);
      } else if (event.key === "Home") { event.preventDefault(); goToSlide(0); }
      else if (event.key === "End") { event.preventDefault(); goToSlide(slides.length - 1); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [currentSlide, editorEnabled, goToSlide, isFullscreen, slides.length, startPresentation]);

  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return [];
    return slides.flatMap((slide, index) => (slide.textContent ?? "").toLocaleLowerCase().includes(query) ? [index] : []);
  }, [searchQuery, slides]);

  const moveSearch = useCallback((direction: 1 | -1) => {
    if (!searchMatches.length) return;
    const currentMatch = searchMatches.indexOf(currentSlide);
    const nextMatch = currentMatch < 0 ? (direction === 1 ? 0 : searchMatches.length - 1) : (currentMatch + direction + searchMatches.length) % searchMatches.length;
    goToSlide(searchMatches[nextMatch]);
  }, [currentSlide, goToSlide, searchMatches]);

  const currentSlideModel = editorModel?.slides[currentSlide];
  const selectedShape = currentSlideModel?.shapes.find((shape) => shape.id === selectedShapeId) ?? null;
  const editOperations = useMemo(() => buildEditOperations(baselineModel, editorModel), [baselineModel, editorModel]);
  const hasEdits = editOperations.length > 0;

  const updateCurrentSlide = useCallback((updater: (slide: LocalPowerPointModel["slides"][number]) => LocalPowerPointModel["slides"][number]) => {
    setEditorModel((model) => {
      if (!model) return model;
      return { ...model, slides: model.slides.map((slide, index) => index === currentSlide ? updater(slide) : slide) };
    });
  }, [currentSlide]);

  const updateSelectedShape = useCallback((patch: Partial<LocalShape>) => {
    if (selectedShapeId === null) return;
    updateCurrentSlide((slide) => ({
      ...slide,
      shapes: slide.shapes.map((shape) => shape.id === selectedShapeId ? { ...shape, ...patch } : shape),
    }));
  }, [selectedShapeId, updateCurrentSlide]);

  const insertText = useCallback(() => {
    if (!editorModel) return;
    const id = nextLocalIdRef.current--;
    const width = 300;
    const height = 64;
    const shape: LocalShape = {
      id, slideIndex: currentSlide + 1, name: "新文本框", text: "输入文本",
      x: (editorModel.slideWidth - width) / 2, y: (editorModel.slideHeight - height) / 2,
      width, height, rotation: 0, zOrder: 9999, fontName: "微软雅黑", fontSize: 24,
      color: "20242A", bold: false, italic: false, underline: false, alignment: 1,
      marginLeft: 5, marginRight: 5, marginTop: 3, marginBottom: 3,
    };
    updateCurrentSlide((slide) => ({ ...slide, shapes: [...slide.shapes, shape] }));
    setSelectedShapeId(id);
    setAnnotationMode(false);
    setEditorNotice("已插入文本框，可在工具栏中修改内容和格式");
  }, [currentSlide, editorModel, updateCurrentSlide]);

  const insertImage = useCallback(async (file: File) => {
    if (!editorModel) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const dimensions = await new Promise<{ width: number; height: number }>((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth || 4, height: image.naturalHeight || 3 });
      image.onerror = () => resolve({ width: 4, height: 3 });
      image.src = dataUrl;
    });
    const maxWidth = Math.min(360, editorModel.slideWidth * 0.55);
    const maxHeight = Math.min(260, editorModel.slideHeight * 0.55);
    const ratio = Math.min(maxWidth / dimensions.width, maxHeight / dimensions.height);
    const width = Math.max(40, dimensions.width * ratio);
    const height = Math.max(30, dimensions.height * ratio);
    const id = nextLocalIdRef.current--;
    const shape: LocalShape = {
      id, slideIndex: currentSlide + 1, name: file.name, text: "",
      x: (editorModel.slideWidth - width) / 2, y: (editorModel.slideHeight - height) / 2,
      width, height, rotation: 0, zOrder: 9999, fontName: "Arial", fontSize: 18,
      color: "000000", bold: false, italic: false, underline: false, alignment: 1,
      marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0,
      dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      imageExtension: file.name.split(".").pop()?.toLowerCase() || "png",
    };
    updateCurrentSlide((slide) => ({ ...slide, shapes: [...slide.shapes, shape] }));
    setSelectedShapeId(id);
    setAnnotationMode(false);
    setEditorNotice("图片已插入，保存后写入演示文稿");
  }, [currentSlide, editorModel, updateCurrentSlide]);

  const removeSelectedShape = useCallback(() => {
    if (selectedShapeId === null) return;
    updateCurrentSlide((slide) => ({ ...slide, shapes: slide.shapes.filter((shape) => shape.id !== selectedShapeId) }));
    setSelectedShapeId(null);
  }, [selectedShapeId, updateCurrentSlide]);

  const applyDesign = useCallback((key: keyof typeof DESIGN_PRESETS) => {
    if (!baselineModel) return;
    const preset = DESIGN_PRESETS[key];
    const originalSlide = baselineModel.slides[currentSlide];
    updateCurrentSlide((slide) => {
      const topBoundary = (editorModel?.slideHeight ?? 540) * 0.25;
      return {
        ...slide,
        backgroundColor: key === "original" ? originalSlide.backgroundColor : preset.background,
        followMasterBackground: key === "original" ? originalSlide.followMasterBackground : false,
        shapes: slide.shapes.map((shape) => {
          const original = originalSlide.shapes.find((candidate) => candidate.id === shape.id);
          if (key === "original" && original) {
            return { ...shape, fontName: original.fontName, fontSize: original.fontSize, color: original.color, bold: original.bold, italic: original.italic, underline: original.underline };
          }
          if (key === "original" || shape.dataBase64) return shape;
          const titleLike = shape.y < topBoundary || /title|标题/i.test(shape.name);
          return { ...shape, fontName: "微软雅黑", color: titleLike ? preset.title : preset.text, bold: titleLike ? true : shape.bold };
        }),
      };
    });
    setEditorNotice(`已应用“${preset.label}”到当前页，保存后重绘预览`);
  }, [baselineModel, currentSlide, editorModel?.slideHeight, updateCurrentSlide]);

  const captureSelection = useCallback(() => {
    if (!annotationMode || !onSelection || !currentSlideModel) return;
    const selection = window.getSelection();
    const layer = stageRef.current?.querySelector<HTMLElement>(".pptx-editor-layer");
    if (!selection || !layer || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return;
    if (!layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return;
    const selectedText = selection.toString().trim();
    if (!selectedText) return;
    const sourceText = currentSlideModel.shapes.map((shape) => shape.text).filter(Boolean).join("\n");
    onSelection({
      ...selectionContext(payload, selectedText, sourceText),
      lineNumber: currentSlide + 1,
      totalLines: slides.length,
    });
    setEditorNotice("已捕获选中文字，请在右侧批注面板填写批注意见");
  }, [annotationMode, currentSlide, currentSlideModel, onSelection, payload, slides.length]);

  useEffect(() => {
    if (!pendingJump || !slides.length) return;
    const requested = pendingJump.target.lineNumber;
    let targetIndex = requested && requested > 0 && requested <= slides.length ? requested - 1 : -1;
    if (targetIndex < 0 && pendingJump.target.selectedText) {
      targetIndex = slides.findIndex((slide) => (slide.textContent ?? "").includes(pendingJump.target.selectedText));
    }
    if (targetIndex < 0) { onJumpMissed?.(pendingJump); return; }
    goToSlide(targetIndex);
    const matchingShape = editorModel?.slides[targetIndex]?.shapes.find((shape) => shape.text.includes(pendingJump.target.selectedText));
    if (matchingShape) setSelectedShapeId(matchingShape.id);
    const target = slides[targetIndex];
    target.classList.remove("pptx-jump-flash");
    requestAnimationFrame(() => {
      target.classList.add("pptx-jump-flash");
      window.setTimeout(() => target.classList.remove("pptx-jump-flash"), 1800);
    });
  }, [editorModel, goToSlide, onJumpMissed, pendingJump, slides]);

  const saveEdits = useCallback(async () => {
    if (!hasEdits || saving) return;
    setSaving(true);
    setEditorNotice("正在由 PowerPoint 写入并重绘预览…");
    try {
      await editPowerPoint(rootPath, payload.relativePath, editOperations);
      await onRefresh?.();
      setEditorNotice(`已保存 ${editOperations.length} 项修改`);
      setSelectedShapeId(null);
    } catch (reason) {
      setEditorNotice("");
      setError(`保存演示文稿失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  }, [editOperations, hasEdits, onRefresh, payload.relativePath, rootPath, saving]);

  const scale = zoom / 100;
  const currentMatchNumber = searchMatches.indexOf(currentSlide) + 1;
  const modelScaleX = editorModel ? BASE_SLIDE_WIDTH / editorModel.slideWidth : 1;
  const modelScaleY = editorModel ? slideHeight / editorModel.slideHeight : 1;

  return (
    <div className={`pptx-workbench${sidebarOpen ? " has-sidebar" : ""}${editorEnabled ? " is-editing" : ""}`}>
      <div className="pptx-toolbar">
        <button type="button" onClick={() => setSidebarOpen((value) => !value)} title={sidebarOpen ? "隐藏缩略图" : "显示缩略图"}>
          {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </button>
        <div className="pptx-toolbar-document"><strong>{payload.name}</strong><span>{slides.length ? `${slides.length} 张幻灯片` : "正在读取演示文稿"}</span></div>
        <div className="pptx-search">
          <Search size={13} />
          <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); moveSearch(event.shiftKey ? -1 : 1); } }} placeholder="搜索幻灯片" aria-label="搜索幻灯片" />
          {searchQuery && <span>{searchMatches.length ? `${currentMatchNumber || "–"}/${searchMatches.length}` : "0/0"}</span>}
        </div>
        <div className="pptx-toolbar-spacer" />
        <div className="pptx-toolbar-group">
          <button type="button" onClick={() => setManualZoom(zoom - 10)} disabled={zoom <= MIN_ZOOM} title="缩小"><ZoomOut size={15} /></button>
          <button type="button" className={fitMode ? "is-active" : ""} onClick={useFitZoom} title="适合窗口">{zoom}%</button>
          <button type="button" onClick={() => setManualZoom(zoom + 10)} disabled={zoom >= MAX_ZOOM} title="放大"><ZoomIn size={15} /></button>
        </div>
        <button type="button" className={editorEnabled && !annotationMode ? "is-active" : ""} onClick={() => { setEditorEnabled(true); setAnnotationMode(false); }} title="在 ADE 中编辑"><PencilLine size={15} /><span>编辑</span></button>
        <button type="button" className={annotationMode ? "is-active" : ""} onClick={() => { setEditorEnabled(true); setAnnotationMode((value) => !value); setSelectedShapeId(null); }} title="选中文字并创建批注"><MessageSquarePlus size={15} /><span>批注</span></button>
        <button type="button" onClick={onOpenExternal} title="使用 PowerPoint 或系统程序打开"><ExternalLink size={15} /></button>
        <button type="button" className="pptx-present-button" onClick={() => void startPresentation(true)} title="从头放映（F5）"><Play size={15} /><span>放映</span></button>
      </div>

      {editorEnabled && (
        <div className="pptx-editor-ribbon">
          <div className="pptx-ribbon-group">
            <button type="button" onClick={insertText} disabled={!editorModel || saving} title="插入文本框"><Type size={15} /><span>文本</span></button>
            <button type="button" onClick={() => imageInputRef.current?.click()} disabled={!editorModel || saving} title="插入图片"><ImagePlus size={15} /><span>图片</span></button>
            <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertImage(file); event.currentTarget.value = ""; }} />
          </div>
          <div className="pptx-ribbon-group pptx-format-group">
            <select value={selectedShape?.fontName ?? "微软雅黑"} onChange={(event) => updateSelectedShape({ fontName: event.target.value })} disabled={!selectedShape || !!selectedShape.dataBase64 || saving} title="字体">
              {selectedShape?.fontName && !FONT_OPTIONS.includes(selectedShape.fontName) && <option value={selectedShape.fontName}>{selectedShape.fontName}</option>}
              {FONT_OPTIONS.map((font) => <option key={font} value={font}>{font}</option>)}
            </select>
            <input className="pptx-font-size" type="number" min="6" max="144" step="1" value={Math.round(selectedShape?.fontSize ?? 18)} onChange={(event) => updateSelectedShape({ fontSize: Number(event.target.value) || 18 })} disabled={!selectedShape || !!selectedShape.dataBase64 || saving} title="字号" />
            <button type="button" className={selectedShape?.bold ? "is-active" : ""} onClick={() => updateSelectedShape({ bold: !selectedShape?.bold })} disabled={!selectedShape || !!selectedShape.dataBase64 || saving} title="粗体"><Bold size={14} /></button>
            <button type="button" className={selectedShape?.italic ? "is-active" : ""} onClick={() => updateSelectedShape({ italic: !selectedShape?.italic })} disabled={!selectedShape || !!selectedShape.dataBase64 || saving} title="斜体"><Italic size={14} /></button>
            <button type="button" className={selectedShape?.underline ? "is-active" : ""} onClick={() => updateSelectedShape({ underline: !selectedShape?.underline })} disabled={!selectedShape || !!selectedShape.dataBase64 || saving} title="下划线"><Underline size={14} /></button>
            <label className="pptx-color-control" title="文字颜色"><span>A</span><input type="color" value={`#${normalizedColor(selectedShape?.color ?? "000000")}`} onChange={(event) => updateSelectedShape({ color: normalizedColor(event.target.value) })} disabled={!selectedShape || !!selectedShape.dataBase64 || saving} /></label>
            <button type="button" className={selectedShape?.alignment === 1 ? "is-active" : ""} onClick={() => updateSelectedShape({ alignment: 1 })} disabled={!selectedShape || !!selectedShape.dataBase64 || saving} title="左对齐"><AlignLeft size={14} /></button>
            <button type="button" className={selectedShape?.alignment === 2 ? "is-active" : ""} onClick={() => updateSelectedShape({ alignment: 2 })} disabled={!selectedShape || !!selectedShape.dataBase64 || saving} title="居中"><AlignCenter size={14} /></button>
            <button type="button" className={selectedShape?.alignment === 3 ? "is-active" : ""} onClick={() => updateSelectedShape({ alignment: 3 })} disabled={!selectedShape || !!selectedShape.dataBase64 || saving} title="右对齐"><AlignRight size={14} /></button>
          </div>
          <input className="pptx-text-input" value={selectedShape?.dataBase64 ? selectedShape.name : selectedShape?.text ?? ""} onChange={(event) => updateSelectedShape({ text: event.target.value })} disabled={!selectedShape || !!selectedShape.dataBase64 || saving} placeholder={annotationMode ? "拖动选择幻灯片文字以创建批注" : "选择文本框后编辑内容"} title="文本内容" />
          <div className="pptx-ribbon-group">
            <Palette size={14} />
            <select defaultValue="original" onChange={(event) => applyDesign(event.target.value as keyof typeof DESIGN_PRESETS)} disabled={!editorModel || saving} title="当前页设计样式">
              {Object.entries(DESIGN_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
            </select>
          </div>
          <button type="button" onClick={removeSelectedShape} disabled={!selectedShape || saving} title="删除所选对象"><Trash2 size={15} /></button>
          <button type="button" className="pptx-editor-save" onClick={() => void saveEdits()} disabled={!hasEdits || saving} title="保存到原 PowerPoint（Ctrl+S)"><Save size={15} /><span>{saving ? "保存中" : `保存${hasEdits ? ` (${editOperations.length})` : ""}`}</span></button>
          <span className={`pptx-editor-notice${modelError ? " is-error" : ""}`} title={modelError || editorNotice}>
            {modelLoading ? "正在读取可编辑对象…" : modelError ? "基础编辑需要本机 PowerPoint" : annotationMode ? "拖动选择文字后在右侧填写批注" : editorNotice || "点击幻灯片中的文本框开始编辑"}
          </span>
        </div>
      )}

      <div className="pptx-workspace">
        {sidebarOpen && (
          <aside className="pptx-thumbnails" aria-label="幻灯片缩略图">
            {slides.map((slide, index) => (
              <button type="button" key={index} className={`${index === currentSlide ? "is-active" : ""}${searchMatches.includes(index) ? " is-search-match" : ""}`} onClick={() => goToSlide(index)} aria-current={index === currentSlide ? "page" : undefined} title={`幻灯片 ${index + 1}`}>
                <span className="pptx-thumbnail-number">{index + 1}</span><SlideThumbnail source={slide} height={slideHeight} />
              </button>
            ))}
          </aside>
        )}

        <div className="pptx-stage" ref={stageRef} onDoubleClick={() => { if (!editorEnabled) void startPresentation(false); }}>
          <div className="pptx-canvas-viewport" style={{ width: BASE_SLIDE_WIDTH * scale, height: slideHeight * scale }}>
            <div className="pptx-canvas-host" ref={hostRef} style={{ width: BASE_SLIDE_WIDTH, height: slideHeight, transform: `scale(${scale})` }} />
            {editorEnabled && currentSlideModel && (
              <div className={`pptx-editor-layer${annotationMode ? " is-annotating" : ""}`} style={{ width: BASE_SLIDE_WIDTH, height: slideHeight, transform: `scale(${scale})` }} onMouseUp={captureSelection}>
                {currentSlideModel.shapes.map((shape) => {
                  const left = shape.x * modelScaleX;
                  const top = shape.y * modelScaleY;
                  const width = shape.width * modelScaleX;
                  const height = shape.height * modelScaleY;
                  const selected = shape.id === selectedShapeId;
                  return (
                    <div
                      key={shape.id}
                      className={`pptx-editor-shape${shape.dataBase64 ? " is-image" : " is-text"}${selected ? " is-selected" : ""}`}
                      style={{ left, top, width, height, transform: `rotate(${shape.rotation || 0}deg)`, zIndex: 20 + shape.zOrder }}
                      role={annotationMode ? undefined : "button"}
                      tabIndex={annotationMode ? -1 : 0}
                      title={annotationMode ? "拖动选择文字" : `${shape.name} · 点击编辑`}
                      onClick={(event) => { if (!annotationMode) { event.stopPropagation(); setSelectedShapeId(shape.id); } }}
                      onKeyDown={(event) => { if (!annotationMode && (event.key === "Enter" || event.key === " ")) setSelectedShapeId(shape.id); }}
                    >
                      {shape.dataBase64 ? (
                        <img src={`data:image/${shape.imageExtension || "png"};base64,${shape.dataBase64}`} alt={shape.name} />
                      ) : (
                        <div
                          className="pptx-editor-shape-text"
                          style={{
                            padding: `${shape.marginTop * modelScaleY}px ${shape.marginRight * modelScaleX}px ${shape.marginBottom * modelScaleY}px ${shape.marginLeft * modelScaleX}px`,
                            color: `#${normalizedColor(shape.color)}`,
                            fontFamily: shape.fontName,
                            fontSize: shape.fontSize * modelScaleY,
                            fontWeight: shape.bold ? 700 : 400,
                            fontStyle: shape.italic ? "italic" : "normal",
                            textDecoration: shape.underline ? "underline" : "none",
                            textAlign: shape.alignment === 2 ? "center" : shape.alignment === 3 ? "right" : "left",
                          }}
                        >{shape.text}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {loading && <div className="pptx-stage-message"><span className="spin pptx-loading-ring" />正在解析演示文稿…</div>}
          {error && <div className="pptx-stage-error"><ViewerError message={error} /></div>}
          {!loading && !error && slides.length > 0 && (
            <>
              <button type="button" className="pptx-stage-nav is-previous" onClick={() => goToSlide(currentSlide - 1)} disabled={currentSlide === 0} title="上一张"><ChevronLeft size={24} /></button>
              <button type="button" className="pptx-stage-nav is-next" onClick={() => goToSlide(currentSlide + 1)} disabled={currentSlide === slides.length - 1} title="下一张"><ChevronRight size={24} /></button>
              <div className="pptx-stage-counter">{currentSlide + 1} / {slides.length}</div>
              <div className="pptx-stage-fullscreen-hint"><Maximize2 size={13} /> 双击画布或按 F5 放映</div>
            </>
          )}
        </div>
      </div>

      <div className="pptx-statusbar">
        <span>幻灯片 {slides.length ? currentSlide + 1 : 0} / {slides.length}</span>
        <span>{Math.round(BASE_SLIDE_WIDTH)} × {Math.round(slideHeight)}</span>
        <span>{isFullscreen ? "正在放映 · Esc 退出" : editorEnabled ? annotationMode ? "选中批注模式" : `${selectedShape ? `已选择：${selectedShape.name}` : "编辑模式"}${hasEdits ? " · 有未保存修改" : ""}` : "方向键翻页 · Shift+F5 从当前页放映"}</span>
      </div>
    </div>
  );
}
