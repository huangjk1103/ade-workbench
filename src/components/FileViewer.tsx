import { ExternalLink, FileQuestion, LoaderCircle } from "lucide-react";
import { Suspense, lazy, useMemo, useState } from "react";
import type {
  Annotation,
  AnnotationRect,
  FilePayload,
  TextSelectionContext,
} from "../types/domain";

const MarkdownView = lazy(() => import("./viewers/MarkdownView"));
const CodeEditor = lazy(() => import("./viewers/CodeEditor"));
const DocxView = lazy(() => import("./viewers/DocxView"));
const SpreadsheetView = lazy(() => import("./viewers/SpreadsheetView"));
const PptxView = lazy(() => import("./viewers/PptxView"));
const PdfView = lazy(() => import("./viewers/PdfView"));
const SequenceView = lazy(() => import("./viewers/SequenceView"));
const Ab1View = lazy(() => import("./viewers/Ab1View"));
const DnaView = lazy(() => import("./viewers/DnaView"));
const TabularView = lazy(() => import("./viewers/TabularView"));
const TreeView = lazy(() => import("./viewers/TreeView"));
const TiffView = lazy(() => import("./viewers/TiffView"));

function ViewerFallback() {
  return <div className="viewer-state"><LoaderCircle className="spin" size={24} /><span>正在加载查看器…</span></div>;
}

interface FileViewerProps {
  rootPath: string;
  payload: FilePayload;
  content: string;
  onContentChange: (content: string) => void;
  onSelection: (selection: TextSelectionContext) => void;
  onOpenExternal: () => void;
  onBinarySave?: (base64Content: string) => void;
  onDocxSave?: (html: string) => void;
  // PDF annotation inputs
  annotations?: Annotation[];
  onCreatePdfAnnotation?: (params: { body: string; priority: Annotation["priority"]; color?: string; pageNumber?: number; rects?: AnnotationRect[]; selectedText: string; agentId?: string }) => void;
  pdfAgents?: { id: string; name: string; available: boolean }[];
  // Docx select-to-annotate inputs (划词批注). Uses the current selection
  // context already reported through onSelection.
  onCreateAnnotation?: (body: string, priority: Annotation["priority"], agentId?: string) => Promise<void>;
  // Annotation forwarded from the right-hand inspector when the user
  // clicks a card. Each viewer interprets it against its own document
  // model (paragraph index for docx, page + rects for PDF, line number for
  // code/markdown, etc.). When the source text can't be located we surface
  // a toast via onJumpMissed and otherwise swallow it silently.
  pendingJump?: Annotation | null;
  onJumpMissed?: (annotation: Annotation) => void;
  // Docx review forwarding — DocxView parses its own track-changes /
  // comments model and emits it upward so App.tsx can route it to the
  // right-hand AnnotationPanel (the in-document review pane is gone).
  onDocxReviewChange?: (model: import("../types/domain").DocxReviewModel | null) => void;
  pendingDocxReviewJump?: import("./viewers/DocxView").DocxReviewJumpTarget | null;
  // Refresh the active docx file from disk (used by the toolbar refresh
  // button so users can pick up changes an external agent made). App.tsx
  // owns the actual fetch + tab state update.
  onRefreshFile?: () => Promise<void>;
  // Open the right-hand inspector panel and switch to the annotations
  // tab so the docx review surface is visible. Used by the toolbar "审阅"
  // button to mirror Word's review pane behaviour.
  onOpenReview?: () => void;
}

// Extensions that already have a dedicated rich viewer.
const OFFICE_EXTENSIONS = new Set(["docx", "docm", "xlsx", "xlsm", "pptx", "pptm"]);
// Office formats without a built-in viewer (legacy binary + OpenDocument +
// RTF). We still surface them as Office documents — clicking falls back to
// the system shell handler so Word / Excel / PowerPoint can take over.
const OFFICE_EXTERNAL_ONLY = new Set([
  // Legacy Microsoft Office binary
  "doc", "ppt", "xls",
  // OpenDocument
  "odt", "ods", "odp",
  // Rich Text Format
  "rtf",
]);
const OFFICE_WORD = new Set(["docx", "docm", "doc", "odt", "rtf"]);
const OFFICE_SHEET = new Set(["xlsx", "xlsm", "xls", "ods"]);
const OFFICE_SLIDES = new Set(["pptx", "pptm", "ppt", "odp"]);
// Tabular bioinformatics formats get a structured table view rather than the
// raw code editor so users can actually scan rows.
const TABULAR_EXTENSIONS = new Set([
  "gff", "gff2", "gff3", "gtf", "bed", "psl", "vcf", "sam", "axt", "maf",
]);
const TREE_EXTENSIONS = new Set([
  "nwk", "newick", "tree", "nex", "nexus", "phy", "phylip",
  "sto", "stockholm", "aln", "clustal",
]);
// CSV/TSV already pass through SpreadsheetView above; explicit `tab` is
// included here so plain tab-delimited tables share the table experience.
// SpreadsheetView handles csv/tsv natively, so we only forward `tab`.
const SPREADSHEET_EXTRA = new Set(["tab"]);
// Image formats that the browser can decode directly from the data URI.
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "heic", "tif", "tiff"]);
// Sanger sequencing traces (ABIF / Applied Biosystems) — binary, parsed by
// Ab1View. We add it to BINARY_OPENABLE so the generic "binary not
// supported" fallback is bypassed and the dedicated viewer can take over.
const AB1_EXTENSIONS = new Set(["ab1"]);
// SnapGene plasmid files (.dna) — proprietary binary container, parsed by
// DnaView. Same gating as AB1.
const DNA_EXTENSIONS = new Set(["dna"]);
// Binary formats the user can still open via the OS shell handler.
const BINARY_OPENABLE = new Set([
  ...IMAGE_EXTENSIONS,
  "pdf",
  ...OFFICE_EXTENSIONS,
  ...OFFICE_EXTERNAL_ONLY,
  ...TABULAR_EXTENSIONS,
  ...TREE_EXTENSIONS,
  // zip-like archives fall back to OS handler
  "zip", "gz", "tgz", "tar", "7z", "rar", "bz2", "xz", "zst",
  // media
  "mp4", "mov", "mkv", "webm", "avi", "wmv", "flv", "m4v",
  "mp3", "wav", "flac", "ogg", "m4a", "opus",
  // disk images / databases
  "iso", "img", "vmdk", "vhd", "sqlite", "db",
  // executable / bytecode
  "exe", "msi", "dll", "so", "dylib", "class", "jar", "war",
  // 3D / fonts / misc binary
  "glb", "gltf", "obj", "fbx", "stl", "blend",
  "ttf", "otf", "woff", "woff2", "eot",
  "parquet", "arrow", "feather", "h5", "hdf5", "npy", "npz", "mat",
]);

export function FileViewer({ rootPath, payload, content, onContentChange, onSelection, onOpenExternal, onBinarySave, onDocxSave, annotations, onCreatePdfAnnotation, pdfAgents, onCreateAnnotation, pendingJump, onJumpMissed, onDocxReviewChange, pendingDocxReviewJump, onRefreshFile, onOpenReview }: FileViewerProps) {
  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">("preview");
  const isMarkdown = payload.extension === "md" || payload.extension === "markdown" || payload.extension === "mdx";
  const isRst = payload.extension === "rst";
  // Keep FASTA-family files in the default text editor so their original
  // headers, wrapping and sequence lines remain untouched. The richer record
  // viewer is reserved for FASTQ and freeform `.seq` inputs.
  const isSequence = payload.extension === "fq" || payload.extension === "fastq"
    || (payload.extension === "seq" && payload.encoding === "utf8");
  const isText = payload.encoding === "utf8" && !["csv", "tsv"].includes(payload.extension);
  const isPdf = payload.extension === "pdf";
  const isTabular = TABULAR_EXTENSIONS.has(payload.extension);
  const isTree = TREE_EXTENSIONS.has(payload.extension);
  const isSpreadsheetExtra = SPREADSHEET_EXTRA.has(payload.extension);
  const isImage = IMAGE_EXTENSIONS.has(payload.extension);
  const isTiff = payload.extension === "tif" || payload.extension === "tiff";
  // Office family files that don't have a dedicated built-in viewer yet —
  // they go through the OS shell handler (Word / Excel / PowerPoint) instead
  // of the generic "binary not supported" fallback.
  const isExternalOffice = OFFICE_EXTERNAL_ONLY.has(payload.extension);
  const officeFamily = useMemo(() => {
    if (OFFICE_WORD.has(payload.extension)) return "word";
    if (OFFICE_SHEET.has(payload.extension)) return "sheet";
    if (OFFICE_SLIDES.has(payload.extension)) return "slides";
    return null;
  }, [payload.extension]);
  const officeLabel = useMemo(() => {
    switch (officeFamily) {
      case "word": return "Word 文档";
      case "sheet": return "Excel 工作簿";
      case "slides": return "PowerPoint 演示文稿";
      default: return "Office 文档";
    }
  }, [officeFamily]);
  const isAb1Binary = AB1_EXTENSIONS.has(payload.extension) && payload.encoding === "base64";
  const isDnaBinary = DNA_EXTENSIONS.has(payload.extension) && payload.encoding === "base64";
  const isBinary = payload.encoding === "base64"
    && !BINARY_OPENABLE.has(payload.extension)
    && !isAb1Binary
    && !isDnaBinary;

  const imageMime = useMemo(() => {
    const aliases: Record<string, string> = {
      jpg: "jpeg", svg: "svg+xml", tif: "tiff", ico: "x-icon", avif: "avif",
    };
    return `image/${aliases[payload.extension] ?? payload.extension}`;
  }, [payload.extension]);

  return (
    <div className="file-viewer">
      {isMarkdown && (
        <div className="viewer-floating-tools">
          <button type="button" className={markdownMode === "preview" ? "is-active" : ""} onClick={() => setMarkdownMode("preview")}>预览</button>
          <button type="button" className={markdownMode === "source" ? "is-active" : ""} onClick={() => setMarkdownMode("source")}>源码</button>
        </div>
      )}
      {isRst && (
        <div className="viewer-floating-tools">
          <span className="viewer-floating-note">reStructuredText 源码</span>
        </div>
      )}

      <Suspense fallback={<ViewerFallback />}>
        {isPdf && (
          <PdfView
            payload={payload}
            annotations={annotations ?? []}
            onSelection={onSelection}
            onCreateAnnotation={(params) => onCreatePdfAnnotation?.(params)}
            agents={pdfAgents ?? []}
            onOpenExternal={onOpenExternal}
            pendingJump={pendingJump ?? null}
            onJumpMissed={onJumpMissed}
          />
        )}
        {payload.encoding === "base64" && isImage && !isTiff && (
          <div className="image-viewer">
            <img src={`data:${imageMime};base64,${payload.content}`} alt={payload.name} />
          </div>
        )}
        {payload.encoding === "base64" && isTiff && (
          <TiffView payload={payload} onOpenExternal={onOpenExternal} />
        )}
        {isSequence && payload.encoding === "utf8" && (
          <SequenceView payload={payload} onSelection={onSelection} pendingJump={pendingJump ?? null} onJumpMissed={onJumpMissed} />
        )}
        {isAb1Binary && (
          <Ab1View payload={payload} onSelection={onSelection} pendingJump={pendingJump ?? null} onJumpMissed={onJumpMissed} />
        )}
        {isDnaBinary && (
          <DnaView payload={payload} onSelection={onSelection} pendingJump={pendingJump ?? null} onJumpMissed={onJumpMissed} onOpenExternal={onOpenExternal} />
        )}
        {isTabular && payload.encoding === "utf8" && (
          <TabularView payload={payload} pendingJump={pendingJump ?? null} onJumpMissed={onJumpMissed} />
        )}
        {isTree && payload.encoding === "utf8" && (
          <TreeView payload={payload} pendingJump={pendingJump ?? null} onJumpMissed={onJumpMissed} />
        )}
        {OFFICE_EXTENSIONS.has(payload.extension) && payload.extension.startsWith("doc") && (
          <DocxView
            payload={payload}
            onSelection={onSelection}
            onDocxSave={onDocxSave}
            onCreateAnnotation={onCreateAnnotation}
            agents={pdfAgents ?? []}
            pendingJump={pendingJump ?? null}
            onJumpMissed={onJumpMissed}
            onReviewChange={onDocxReviewChange}
            pendingReviewJump={pendingDocxReviewJump ?? null}
            onRefresh={onRefreshFile ? () => onRefreshFile() : undefined}
            onOpenReview={onOpenReview}
          />
        )}
        {(payload.extension === "xlsx" || payload.extension === "xlsm" || payload.extension === "csv" || payload.extension === "tsv" || isSpreadsheetExtra) && (
          <SpreadsheetView payload={payload} pendingJump={pendingJump ?? null} onJumpMissed={onJumpMissed} />
        )}
        {(payload.extension === "pptx" || payload.extension === "pptm") && (
          <PptxView
            payload={payload}
            rootPath={rootPath}
            onOpenExternal={onOpenExternal}
            onRefresh={onRefreshFile}
            onSelection={onSelection}
            pendingJump={pendingJump ?? null}
            onJumpMissed={onJumpMissed}
          />
        )}
        {isMarkdown && markdownMode === "preview" && (
          <MarkdownView payload={payload} content={content} onSelection={onSelection} pendingJump={pendingJump ?? null} onJumpMissed={onJumpMissed} />
        )}
        {isText && (!isMarkdown || markdownMode === "source") && !isSequence && !isTabular && !isTree && (
          <CodeEditor
            payload={payload}
            content={content}
            wordWrap={isMarkdown || isRst}
            onContentChange={onContentChange}
            onSelection={onSelection}
            pendingJump={pendingJump ?? null}
            onJumpMissed={onJumpMissed}
          />
        )}
      </Suspense>

      {isExternalOffice && (
        <div className="viewer-state">
          <FileQuestion size={28} /><strong>{officeLabel}暂不支持内置预览</strong>
          <span>{payload.relativePath}</span>
          <span className="viewer-state-hint">当前会调用系统默认的 Office 程序（如 Microsoft Word / WPS / LibreOffice）打开，请在系统提示中选择“是”以启动外部查看器。</span>
          <button type="button" onClick={onOpenExternal}><ExternalLink size={15} /> 使用系统程序打开</button>
        </div>
      )}

      {isBinary && (
        <div className="viewer-state">
          <FileQuestion size={28} /><strong>此二进制格式暂不支持内置预览</strong>
          <span>{payload.relativePath}</span>
          <button type="button" onClick={onOpenExternal}><ExternalLink size={15} /> 使用系统程序打开</button>
        </div>
      )}
    </div>
  );
}
