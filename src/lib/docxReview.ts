import DOMPurify from "dompurify";
import JSZip from "jszip";
import type { DocxReviewModel, ReviewComment, ReviewReply, TrackChange } from "../types/domain";
import { tiffBase64ToPngDataUrl } from "./tiff";

// OOXML namespaces used by .docx parts. We look elements up by namespace +
// localName so the converter is immune to prefix renames in the wild.
const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  w15: "http://schemas.microsoft.com/office/word/2012/wordml",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
};

const AUTHOR_COLORS = [
  "#d97757", "#5ba58c", "#6e8ecb", "#c88a65", "#b07cc6",
  "#4aa3a3", "#cb6f6f", "#7a9b57", "#9a7cb8", "#3f8fbf",
];

function authorColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Word highlight color names -> CSS. Covers the built-in palette.
const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff",
  blue: "#0000ff", red: "#ff0000", darkBlue: "#00008b", darkCyan: "#008b8b",
  darkGreen: "#006400", darkMagenta: "#8b008b", darkRed: "#8b0000",
  darkYellow: "#8b8b00", darkGray: "#a9a9a9", lightGray: "#d3d3d3", black: "#000000",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function isW(el: Element, name: string): boolean {
  return el.namespaceURI === NS.w && el.localName === name;
}
// `childNodes`-based (not `el.children`) so the same code runs in the browser
// and in node-side tests with DOM polyfills that lack the `children` getter.
function childrenOf(el: Element): Element[] {
  return Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1);
}
function wChild(el: Element, name: string): Element | null {
  for (const c of childrenOf(el)) if (isW(c, name)) return c;
  return null;
}
function wChildren(el: Element, name: string): Element[] {
  return childrenOf(el).filter((c) => isW(c, name));
}
// `w:val`, `w:id`, `w:author` etc. live in the w namespace. Try the namespaced
// lookup first, then the prefixed form as a fallback for parsers that drop NS.
function wAttr(el: Element, name: string): string {
  return el.getAttributeNS(NS.w, name) ?? el.getAttribute("w:" + name) ?? "";
}

function parseDate(value: string): number {
  const n = Date.parse(value);
  return Number.isNaN(n) ? 0 : n;
}

interface NumberingInfo {
  ordered(numId: string, ilvl: string): boolean;
}

async function loadNumbering(zip: JSZip): Promise<NumberingInfo> {
  const file = zip.file("word/numbering.xml");
  if (!file) return { ordered: () => false };
  const text = await file.async("string");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  // abstractNumId per numId
  const numToAbstract = new Map<string, string>();
  for (const num of Array.from(doc.getElementsByTagNameNS(NS.w, "num"))) {
    const numId = wAttr(num, "numId");
    const abs = wChild(num, "abstractNumId");
    if (numId && abs) numToAbstract.set(numId, wAttr(abs, "val"));
  }
  // numFmt per (abstractNumId, ilvl)
  const fmt = new Map<string, boolean>();
  for (const abs of Array.from(doc.getElementsByTagNameNS(NS.w, "abstractNum"))) {
    const absId = wAttr(abs, "abstractNumId");
    for (const lvl of wChildren(abs, "lvl")) {
      const ilvl = wAttr(lvl, "ilvl");
      const numFmt = wChild(lvl, "numFmt");
      const v = numFmt ? wAttr(numFmt, "val") : "";
      // Anything decimal/letter/roman = ordered; bullet/none = unordered.
      const ordered = /decimal|Letter|letter|Roman|roman|chicago|ordinal/.test(v);
      fmt.set(`${absId}:${ilvl}`, ordered);
    }
  }
  return {
    ordered(numId, ilvl) {
      const abs = numToAbstract.get(numId);
      if (!abs) return false;
      return fmt.get(`${abs}:${ilvl}`) ?? fmt.get(`${abs}:0`) ?? false;
    },
  };
}

async function loadRels(zip: JSZip): Promise<Map<string, string>> {
  const file = zip.file("word/_rels/document.xml.rels");
  const map = new Map<string, string>();
  if (!file) return map;
  const text = await file.async("string");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  for (const rel of Array.from(doc.getElementsByTagNameNS(NS.rel, "Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) map.set(id, target);
  }
  return map;
}

function mimeFor(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
    svg: "image/svg+xml", emf: "image/x-emf", wmf: "image/x-wmf",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

function isTiffMime(mime: string): boolean {
  return mime === "image/tiff" || mime === "image/tif";
}

interface ReviewContext {
  activeCommentIds: string[];
  anchoredCommentIds: Set<string>;
  changes: TrackChange[];
  comments: Map<string, ReviewComment>;
  commentOrder: string[];
  numbering: NumberingInfo;
  rels: Map<string, string>;
  zip: JSZip;
  imageCache: Map<string, string>;
  inList: boolean;
  lastListTag: string;
  seq: number;
  nextId(): string;
  pushComment(id: string): void;
  popComment(id: string): void;
}

function commentAnchor(id: string, ctx: ReviewContext): string {
  if (ctx.anchoredCommentIds.has(id)) return "";
  ctx.anchoredCommentIds.add(id);
  const n = ctx.commentOrder.indexOf(id) + 1;
  // Resolved comments keep their numeric index but get a "resolved" class so
  // they render dimmed in the document body (Word's behaviour).
  const comment = ctx.comments.get(id);
  const resolvedClass = comment?.resolved ? " docx-comment-resolved" : "";
  const tooltip = comment ? `${escapeAttr(comment.author)}: ${escapeAttr(comment.text.slice(0, 80))}` : "";
  const titleAttr = tooltip ? ` title="${tooltip}"` : "";
  return `<sup class="docx-comment-marker${resolvedClass}" data-comment-id="${escapeAttr(id)}"${titleAttr}>${n}</sup>`;
}

function wrapCommentRanges(inner: string, ctx: ReviewContext): string {
  let h = inner;
  // Wrap from outermost so the deepest range is the innermost span. This keeps
  // nested comment ranges visually stacked. Resolved comments get a
  // `docx-comment-resolved` modifier so CSS can dim them while keeping the
  // text fully editable.
  for (const cid of ctx.activeCommentIds) {
    const resolved = ctx.comments.get(cid)?.resolved ? " docx-comment-resolved" : "";
    h = `<span class="docx-comment-range${resolved}" data-comment-id="${escapeAttr(cid)}">${h}</span>`;
  }
  return h;
}

// Resolve a relationship target string into a real zip entry path.
// Word emits targets in several shapes; the most surprising ones are the
// absolute "\" prefix that some Windows-era Word builds add to relative
// paths, percent-encoded UTF-8 for non-ASCII names, and backslash-as-
// separator for compatibility with legacy Windows tooling. Each of these
// is common in academic .docx files that include Chinese figures.
function resolveDocxPartPath(rawTarget: string, zip: JSZip): string | null {
  if (!rawTarget) return null;
  const candidates: string[] = [];
  // 1. Normalise backslashes -> forward slashes (some Word builds emit
  //    "media\\1.png" instead of "media/1.png").
  let t = rawTarget.replace(/\\\\/g, "/").replace(/\\/g, "/");
  // 2. Try the URL-decoded variant first, since most non-ASCII names are
  //    stored percent-encoded in the rels XML. Keep both forms available.
  let decoded = "";
  try { decoded = decodeURIComponent(t); } catch { decoded = t; }
  const variants = [t];
  if (decoded !== t) variants.push(decoded);
  for (const variant of variants) {
    const v = variant;
    // Absolute "/word/..." or "/media/..." paths.
    if (v.startsWith("/")) candidates.push(v.slice(1));
    // Absolute "/word/..." -> strip the leading slash then prefix "word/".
    else candidates.push(`word/${v}`);
  }
  // Also try the literal target without normalisation, in case the rels
  // already contain a clean path we don't want to double-prefix.
  candidates.push(rawTarget);
  if (rawTarget.startsWith("/")) candidates.push(rawTarget.slice(1));
  candidates.push(`word/${rawTarget}`);

  for (const candidate of candidates) {
    if (zip.file(candidate)) return candidate;
  }
  // Last-ditch: scan the zip for a file whose name matches the basename
  // of the target. This catches oddities like a rels file that points at
  // "../media/中文.png" while the zip stores it as "word/media/中文.png".
  const baseName = (rawTarget.split(/[\\/]/).pop() ?? "").trim();
  if (baseName) {
    // First try a direct basename lookup across the zip.
    for (const name of Object.keys((zip as any).files ?? {})) {
      if (name.endsWith(baseName)) return name;
    }
    // Then try a decoded basename for percent-encoded targets.
    let decodedBase = "";
    try { decodedBase = decodeURIComponent(baseName); } catch { decodedBase = baseName; }
    if (decodedBase !== baseName) {
      for (const name of Object.keys((zip as any).files ?? {})) {
        if (name.endsWith(decodedBase)) return name;
      }
    }
  }
  return null;
}

// Extract drawing geometry in pixels so we can emit <img> with width/height
// attributes that match what Word renders on screen. Word stores sizes in EMU
// (English Metric Units): 914400 EMU = 1 inch, 9525 EMU = 1 pixel at 96 DPI.
// We pin to 96 DPI to match how the editor's CSS-zoom model scales content,
// which means a 5271135×5252085 EMU extent becomes ~553×550 CSS pixels.
function extractDrawingExtentPx(el: Element): { width: number; height: number } | null {
  const extents = Array.from(el.getElementsByTagNameNS(NS.wp, "extent"));
  for (const ext of extents) {
    const cx = parseInt(ext.getAttribute("cx") ?? "0", 10);
    const cy = parseInt(ext.getAttribute("cy") ?? "0", 10);
    if (cx > 0 && cy > 0) {
      return { width: Math.round(cx / 9525), height: Math.round(cy / 9525) };
    }
  }
  // Fallback: a:ext on the picture's spPr (used by some image editors).
  const exts = Array.from(el.getElementsByTagNameNS(NS.a, "ext"));
  for (const ext of exts) {
    const cx = parseInt(ext.getAttribute("cx") ?? "0", 10);
    const cy = parseInt(ext.getAttribute("cy") ?? "0", 10);
    if (cx > 0 && cy > 0) {
      return { width: Math.round(cx / 9525), height: Math.round(cy / 9525) };
    }
  }
  return null;
}

// Wrap an inline-block figure around an <img> so the size attributes are
// respected. Without an inline-block container, browsers happily stretch an
// <img> with explicit dimensions beyond its parent (max-width: 100% works on
// %-sized but not px-sized images).
function renderImageHtml(dataUrl: string, alt: string, extent: { width: number; height: number } | null, anchor: boolean): string {
  // Constrain absurd sizes: Word sometimes emits extents wider than the page
  // (e.g. when a figure was authored on an 11×17 / A3 layout). The document
  // body content area is ~676px wide (820px frame minus 72px padding), so
  // capping at 640px keeps the image comfortably inside the column even when
  // the user zooms in. Aspect ratio is preserved by rescaling height.
  const cap = 640;
  let styleParts = ["display:block", "max-width:100%", "height:auto", "margin:10px auto", "border-radius:2px"];
  let widthAttr = "";
  let heightAttr = "";
  if (extent) {
    let w = extent.width;
    let h = extent.height;
    if (w > cap) {
      h = Math.round((h * cap) / w);
      w = cap;
    }
    widthAttr = ` width="${w}"`;
    heightAttr = ` height="${h}"`;
  }
  const style = ` style="${styleParts.join(";")}"`;
  const figureClass = anchor ? "docx-figure docx-figure-anchor" : "docx-figure docx-figure-inline";
  return `<figure class="${figureClass}"${style}><img src="${dataUrl}" alt="${escapeAttr(alt)}"${widthAttr}${heightAttr} /></figure>`;
}

async function emitDrawing(el: Element, ctx: ReviewContext): Promise<string> {
  // Capture extent up-front so we can apply width/height to whichever image
  // variant we end up emitting. Many drawings carry multiple extents (e.g.
  // inline + behindDoc); the first one is the visible size.
  const extent = extractDrawingExtentPx(el);
  // Pull alt text from wp:docPr (`descr` is the long description, `name` is
  // the short label). Both survive into the <img alt="..."> so screen
  // readers and hover tooltips see what Word authored. We strip the trailing
  // AI-warning text some image generators inject so the alt stays clean.
  const docPr = Array.from(el.getElementsByTagNameNS(NS.wp, "docPr"))[0];
  const descr = docPr?.getAttribute("descr")?.trim() ?? "";
  const docPrName = docPr?.getAttribute("name")?.trim() ?? "";
  const alt = (descr || docPrName || "")
    .replace(/AI\s*生成的内容可能不正确\.?$/i, "")
    .trim();

  // Pictures (modern path): find the blip (r:embed -> image relationship).
  const blips = Array.from(el.getElementsByTagNameNS(NS.a, "blip"));
  for (const blip of blips) {
    const embed = blip.getAttributeNS(NS.r, "embed") ?? blip.getAttribute("r:embed");
    if (!embed) continue;
    const target = ctx.rels.get(embed);
    if (!target) continue;
    const partPath = resolveDocxPartPath(target, ctx.zip);
    if (!partPath) continue;
    let dataUrl = ctx.imageCache.get(partPath);
    if (!dataUrl) {
      const part = ctx.zip.file(partPath);
      if (part) {
        try {
          const b64 = await part.async("base64");
          const ext = partPath.split(".").pop() ?? "";
          const mime = mimeFor(ext);
          if (isTiffMime(mime)) {
            // TIFF can't be embedded in <img> directly; convert to PNG first.
            // tiffBase64ToPngDataUrl returns null on failure, in which case we
            // fall through to a placeholder so the user at least sees a hint
            // about which figure went missing.
            const pngUrl = tiffBase64ToPngDataUrl(b64);
            if (pngUrl) dataUrl = pngUrl;
          } else {
            dataUrl = `data:${mime};base64,${b64}`;
          }
          // Always cache so we don't re-decode the same image. We cache the
          // PNG version for TIFFs (so subsequent paragraphs reuse the
          // converted data), or the original raw data URL for everything else.
          ctx.imageCache.set(partPath, dataUrl ?? "");
        } catch (reason) {
          // Failed to decode this specific image; keep going so other images
          // in the document still render. The placeholder below will mark
          // the spot.
          console.warn("[docxReview] failed to read image part", partPath, reason);
        }
      }
    }
    if (dataUrl) return renderImageHtml(dataUrl, alt, extent, true);
  }
  // Legacy VML pictures (`<w:pict>` containing `<v:shape>` with
  // `<v:imagedata r:id="..."/>`). The rels format is identical to blips so
  // we can reuse the same resolution path.
  const imageData = Array.from(el.getElementsByTagNameNS("urn:schemas-microsoft-com:vml", "imagedata"));
  for (const img of imageData) {
    const rid = img.getAttributeNS(NS.r, "id") ?? img.getAttribute("r:id");
    if (!rid) continue;
    const target = ctx.rels.get(rid);
    if (!target) continue;
    const partPath = resolveDocxPartPath(target, ctx.zip);
    if (!partPath) continue;
    let dataUrl = ctx.imageCache.get(partPath);
    if (!dataUrl) {
      const part = ctx.zip.file(partPath);
      if (part) {
        try {
          const b64 = await part.async("base64");
          const ext = partPath.split(".").pop() ?? "";
          const mime = mimeFor(ext);
          if (isTiffMime(mime)) {
            const pngUrl = tiffBase64ToPngDataUrl(b64);
            if (pngUrl) dataUrl = pngUrl;
          } else {
            dataUrl = `data:${mime};base64,${b64}`;
          }
          ctx.imageCache.set(partPath, dataUrl ?? "");
        } catch (reason) {
          console.warn("[docxReview] failed to read VML image", partPath, reason);
        }
      }
    }
    if (dataUrl) return renderImageHtml(dataUrl, alt, extent, false);
  }
  // Drawing without a recognised image source: shape, chart, SmartArt,
  // text-box, etc. Render a small placeholder so the user knows the spot
  // exists even though we can't reproduce the artwork.
  return `<span class="docx-drawing-placeholder" contenteditable="false">[图]</span>`;
}

function runStyleHtml(rPr: Element | null): { open: string; close: string; style: string } {
  if (!rPr) return { open: "", close: "", style: "" };
  const tags: string[] = [];
  const styles: string[] = [];
  if (wChild(rPr, "b")) tags.push("b");
  if (wChild(rPr, "i")) tags.push("i");
  if (wChild(rPr, "u")) tags.push("u");
  if (wChild(rPr, "strike") || wChild(rPr, "dstrike")) tags.push("s");
  const vert = wChild(rPr, "vertAlign");
  if (vert) {
    const v = wAttr(vert, "val");
    if (v === "superscript") tags.push("sup");
    else if (v === "subscript") tags.push("sub");
  }
  const color = wChild(rPr, "color");
  if (color) {
    const v = wAttr(color, "val");
    if (v && v !== "auto") styles.push(`color:#${v}`);
  }
  const sz = wChild(rPr, "sz");
  if (sz) {
    const v = parseInt(wAttr(sz, "val"), 10);
    if (v) styles.push(`font-size:${v / 2}pt`);
  }
  const rFonts = wChild(rPr, "rFonts");
  if (rFonts) {
    const ascii = wAttr(rFonts, "ascii") || wAttr(rFonts, "hAnsi");
    if (ascii) styles.push(`font-family:'${ascii}'`);
  }
  const hl = wChild(rPr, "highlight");
  if (hl) {
    const v = wAttr(hl, "val");
    if (v && v !== "none") styles.push(`background:${HIGHLIGHT_COLORS[v] ?? v}`);
  }
  const vanish = wChild(rPr, "vanish");
  if (vanish) styles.push("display:none");
  const open = tags.map((t) => `<${t}>`).join("");
  const close = tags.slice().reverse().map((t) => `</${t}>`).join("");
  return { open, close, style: styles.join(";") };
}

async function emitRun(r: Element, ctx: ReviewContext): Promise<string> {
  const rPr = wChild(r, "rPr");
  const { open, close, style } = runStyleHtml(rPr);
  let inner = "";
  for (const c of childrenOf(r)) {
    if (isW(c, "t") || isW(c, "delText")) {
      inner += escapeHtml(c.textContent ?? "");
    } else if (isW(c, "tab")) {
      inner += "\t";
    } else if (isW(c, "br")) {
      const v = wAttr(c, "type");
      inner += v === "page" ? '<span class="docx-page-break"></span>' : "<br/>";
    } else if (isW(c, "noBreakHyphen") || isW(c, "softHyphen")) {
      inner += "-";
    } else if (isW(c, "sym")) {
      const ch = wAttr(c, "char");
      if (ch) inner += escapeHtml(String.fromCodePoint(parseInt(ch, 16)));
    } else if (isW(c, "drawing") || isW(c, "pict") || isW(c, "object")) {
      inner += await emitDrawing(c, ctx);
    }
    // rPr itself is skipped (already consumed).
  }
  let runHtml = open + inner + close;
  if (style) runHtml = `<span style="${escapeAttr(style)}">${runHtml}</span>`;
  return wrapCommentRanges(runHtml, ctx);
}

async function emitHyperlink(el: Element, ctx: ReviewContext): Promise<string> {
  const anchor = wAttr(el, "anchor");
  const rid = el.getAttributeNS(NS.r, "id") ?? el.getAttribute("r:id");
  let href = "";
  if (anchor) href = `#${anchor}`;
  else if (rid) href = ctx.rels.get(rid) ?? "";
  let inner = "";
  for (const c of childrenOf(el)) {
    if (isW(c, "r")) inner += await emitRun(c, ctx);
  }
  const hrefAttr = href ? ` href="${escapeAttr(href)}"` : "";
  return `<a${hrefAttr}>${inner}</a>`;
}

async function emitIns(el: Element, ctx: ReviewContext): Promise<string> {
  const author = wAttr(el, "author") || "未知作者";
  const date = parseDate(wAttr(el, "date"));
  const changeId = `ins-${wAttr(el, "id") || ctx.nextId()}`;
  let inner = "";
  for (const c of childrenOf(el)) {
    if (isW(c, "r")) inner += await emitRun(c, ctx);
    else if (isW(c, "hyperlink")) inner += await emitHyperlink(c, ctx);
  }
  ctx.changes.push({ id: changeId, kind: "insert", author, dateMs: date, text: textOf(el) });
  const color = authorColor(author);
  return `<ins class="docx-track-ins" data-change-id="${escapeAttr(changeId)}" data-author="${escapeAttr(author)}" data-date="${date}" style="color:${color}">${inner}</ins>`;
}

async function emitDel(el: Element, ctx: ReviewContext): Promise<string> {
  const author = wAttr(el, "author") || "未知作者";
  const date = parseDate(wAttr(el, "date"));
  const changeId = `del-${wAttr(el, "id") || ctx.nextId()}`;
  let inner = "";
  for (const c of childrenOf(el)) {
    if (isW(c, "r")) inner += await emitRun(c, ctx);
  }
  ctx.changes.push({ id: changeId, kind: "delete", author, dateMs: date, text: textOf(el) });
  const color = authorColor(author);
  return `<del class="docx-track-del" data-change-id="${escapeAttr(changeId)}" data-author="${escapeAttr(author)}" data-date="${date}" style="color:${color}">${inner}</del>`;
}

function textOf(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function emitParagraph(p: Element, ctx: ReviewContext): Promise<string> {
  const pPr = wChild(p, "pPr");
  let tag = "p";
  const styles: string[] = [];
  let isListItem = false;
  let ordered = false;
  if (pPr) {
    const pStyle = wChild(pPr, "pStyle");
    if (pStyle) {
      const v = wAttr(pStyle, "val").toLowerCase();
      if (v === "heading1" || v === "title") tag = "h1";
      else if (v === "heading2") tag = "h2";
      else if (v === "heading3") tag = "h3";
      else if (v === "heading4") tag = "h4";
      else if (v === "heading5") tag = "h5";
      else if (v === "heading6") tag = "h6";
    }
    const numPr = wChild(pPr, "numPr");
    if (numPr) {
      const numIdEl = wChild(numPr, "numId");
      const ilvlEl = wChild(numPr, "ilvl");
      const numId = numIdEl ? wAttr(numIdEl, "val") : "";
      const ilvl = ilvlEl ? wAttr(ilvlEl, "val") : "0";
      isListItem = true;
      ordered = ctx.numbering.ordered(numId, ilvl);
    }
    const jc = wChild(pPr, "jc");
    if (jc) {
      const v = wAttr(jc, "val");
      if (v === "center") styles.push("text-align:center");
      else if (v === "right") styles.push("text-align:right");
      else if (v === "both" || v === "distribute") styles.push("text-align:justify");
    }
    const ind = wChild(pPr, "ind");
    if (ind) {
      const left = wAttr(ind, "left") || wAttr(ind, "leftChars");
      if (left) styles.push(`margin-left:${parseInt(left, 10) / 20}pt`);
      const firstLine = wAttr(ind, "firstLine");
      if (firstLine) styles.push(`text-indent:${parseInt(firstLine, 10) / 20}pt`);
    }
    const spacing = wChild(pPr, "spacing");
    if (spacing) {
      const before = wAttr(spacing, "before");
      const after = wAttr(spacing, "after");
      if (before) styles.push(`margin-top:${parseInt(before, 10) / 20}pt`);
      if (after) styles.push(`margin-bottom:${parseInt(after, 10) / 20}pt`);
    }
  }

  let inner = "";
  for (const c of childrenOf(p)) {
    if (isW(c, "r")) inner += await emitRun(c, ctx);
    else if (isW(c, "ins")) inner += await emitIns(c, ctx);
    else if (isW(c, "del")) inner += await emitDel(c, ctx);
    else if (isW(c, "hyperlink")) inner += await emitHyperlink(c, ctx);
    else if (isW(c, "commentRangeStart")) {
      const id = wAttr(c, "id");
      if (id) { ctx.pushComment(id); inner += commentAnchor(id, ctx); }
    } else if (isW(c, "commentRangeEnd")) {
      ctx.popComment(wAttr(c, "id"));
    } else if (isW(c, "commentReference")) {
      const id = wAttr(c, "id");
      if (id && !ctx.anchoredCommentIds.has(id)) inner += commentAnchor(id, ctx);
    }
    // pPr / bookmarkStart / bookmarkEnd / proofErr etc. are ignored.
  }

  const styleAttr = styles.length ? ` style="${escapeAttr(styles.join(";"))}"` : "";
  const listTag = ordered ? "ol" : "ul";
  let prefix = "";
  if (isListItem && !ctx.inList) { prefix = `<${listTag}>`; ctx.inList = true; }
  else if (!isListItem && ctx.inList) { prefix = `</${ctx.lastListTag || "ul"}>`; ctx.inList = false; }
  // When switching between ol/ul mid-list, close+reopen. Best effort.
  if (isListItem && ctx.inList && ctx.lastListTag && ctx.lastListTag !== listTag) {
    prefix = `</${ctx.lastListTag}><${listTag}>`;
  }
  if (isListItem) ctx.lastListTag = listTag; else ctx.lastListTag = "";
  if (isListItem) return `${prefix}<li${styleAttr}>${inner}</li>`;
  return `${prefix}<${tag}${styleAttr}>${inner}</${tag}>`;
}

async function emitTable(tbl: Element, ctx: ReviewContext): Promise<string> {
  let rows = "";
  for (const tr of wChildren(tbl, "tr")) {
    let cells = "";
    for (const tc of wChildren(tr, "tc")) {
      const tcPr = wChild(tc, "tcPr");
      let cellStyle = "";
      let colspan = "";
      if (tcPr) {
        const gridSpan = wChild(tcPr, "gridSpan");
        if (gridSpan) { const v = parseInt(wAttr(gridSpan, "val"), 10); if (v > 1) colspan = ` colspan="${v}"`; }
        const vMerge = wChild(tcPr, "vMerge");
        if (vMerge && wAttr(vMerge, "val") !== "restart") continue; // skip continued vertical-merge cells
        const tcW = wChild(tcPr, "tcW");
        if (tcW) { const v = parseInt(wAttr(tcW, "w"), 10); if (v) cellStyle = `width:${Math.round(v / 20)}pt;`; }
      }
      let cellInner = "";
      for (const child of childrenOf(tc)) {
        if (isW(child, "p")) cellInner += await emitParagraph(child, ctx);
      }
      cells += `<td${colspan}${cellStyle ? ` style="${escapeAttr(cellStyle)}"` : ""}>${cellInner}</td>`;
    }
    rows += `<tr>${cells}</tr>`;
  }
  if (ctx.inList) { rows = `</${ctx.lastListTag || "ul"}>${rows}`; ctx.inList = false; }
  return `<table>${rows}</table>`;
}

async function emitBlock(el: Element, ctx: ReviewContext): Promise<string> {
  if (isW(el, "p")) return await emitParagraph(el, ctx);
  if (isW(el, "tbl")) return await emitTable(el, ctx);
  if (isW(el, "sdt")) {
    const content = wChild(el, "sdtContent");
    if (!content) return "";
    let out = "";
    for (const c of childrenOf(content)) out += await emitBlock(c, ctx);
    return out;
  }
  // Fallback: recurse so we never silently drop a block's text.
  let out = "";
  for (const c of childrenOf(el)) {
    if (isW(c, "p") || isW(c, "tbl") || isW(c, "sdt")) out += await emitBlock(c, ctx);
  }
  return out;
}

async function loadComments(zip: JSZip, ctx: ReviewContext): Promise<void> {
  const file = zip.file("word/comments.xml");
  if (!file) return;
  const text = await file.async("string");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const list: ReviewComment[] = [];
  const paraIdToId = new Map<string, string>();
  for (const c of Array.from(doc.getElementsByTagNameNS(NS.w, "comment"))) {
    const id = wAttr(c, "id");
    if (!id) continue;
    const author = wAttr(c, "author") || "未知作者";
    const date = parseDate(wAttr(c, "date"));
    const text = (c.textContent ?? "").replace(/\s+/g, " ").trim();
    const comment: ReviewComment = { id, author, dateMs: date, text, replies: [], resolved: false };
    list.push(comment);
    ctx.comments.set(id, comment);
    const paraId = c.getAttributeNS(NS.w14, "paraId") ?? c.getAttribute("w14:paraId");
    if (paraId) paraIdToId.set(paraId, id);
  }
  // Order by numeric id for stable anchor numbering.
  ctx.commentOrder = list.map((c) => c.id).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  // Replies: commentsExtended.xml links a comment's paraId to a parent paraId.
  const ext = zip.file("word/commentsExtended.xml");
  if (ext) {
    const extText = await ext.async("string");
    const extDoc = new DOMParser().parseFromString(extText, "application/xml");
    const parentOf = new Map<string, string>(); // commentId -> parent commentId
    for (const ex of Array.from(extDoc.getElementsByTagNameNS(NS.w15, "commentEx"))) {
      const done = ex.getAttributeNS(NS.w15, "done");
      const paraId = ex.getAttributeNS(NS.w15, "paraId") ?? ex.getAttribute("w15:paraId");
      const parent = ex.getAttributeNS(NS.w15, "paraIdParent") ?? ex.getAttribute("w15:paraIdParent");
      const cid = paraId ? paraIdToId.get(paraId) : undefined;
      if (cid && done === "1") ctx.comments.get(cid)!.resolved = true;
      if (cid && parent) {
        const parentId = paraIdToId.get(parent);
        if (parentId) parentOf.set(cid, parentId);
      }
    }
    // Attach replies to their parent; remove from top-level order.
    for (const [cid, parentId] of parentOf) {
      const reply = ctx.comments.get(cid);
      const parent = ctx.comments.get(parentId);
      if (reply && parent) {
        parent.replies.push({ id: reply.id, author: reply.author, dateMs: reply.dateMs, text: reply.text } as ReviewReply);
        ctx.comments.delete(cid);
        ctx.commentOrder = ctx.commentOrder.filter((x) => x !== cid);
      }
    }
  }
}

export interface DocxReviewResult {
  html: string;
  model: DocxReviewModel;
}

export async function parseDocxForReview(buffer: ArrayBuffer): Promise<DocxReviewResult> {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("不是有效的 .docx：缺少 word/document.xml");
  const xml = await docFile.async("string");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("无法解析 word/document.xml");
  }

  const ctx: ReviewContext = {
    activeCommentIds: [],
    anchoredCommentIds: new Set(),
    changes: [],
    comments: new Map(),
    commentOrder: [],
    numbering: await loadNumbering(zip),
    rels: await loadRels(zip),
    zip,
    imageCache: new Map(),
    inList: false,
    lastListTag: "",
    seq: 0,
    nextId() { return `c${++this.seq}`; },
    pushComment(id) { this.activeCommentIds.push(id); },
    popComment(id) {
      const i = this.activeCommentIds.lastIndexOf(id);
      if (i >= 0) this.activeCommentIds.splice(i, 1);
    },
  };

  await loadComments(zip, ctx);

  const body = Array.from(doc.getElementsByTagNameNS(NS.w, "body"))[0];
  if (!body) throw new Error("文档缺少 w:body");
  let html = "";
  for (const child of childrenOf(body)) {
    if (isW(child, "p") || isW(child, "tbl") || isW(child, "sdt")) {
      html += await emitBlock(child, ctx);
    }
  }
  if (ctx.inList) html += `</${ctx.lastListTag || "ul"}>`;

  // Build the author roster from all changes + comments.
  const authorSet = new Map<string, string>();
  for (const ch of ctx.changes) authorSet.set(ch.author, authorColor(ch.author));
  for (const c of ctx.comments.values()) {
    authorSet.set(c.author, authorColor(c.author));
    for (const r of c.replies) authorSet.set(r.author, authorColor(r.author));
  }
  const authors = Array.from(authorSet, ([name, color]) => ({ id: name, name, initials: initialsOf(name), color }));

  const comments = ctx.commentOrder.map((id) => ctx.comments.get(id)!).filter(Boolean);

  const sanitized = DOMPurify.sanitize(html, {
    ADD_ATTR: ["data-change-id", "data-comment-id", "data-author", "data-date"],
    ADD_TAGS: ["ins", "del", "figure", "figcaption"],
    // data: URLs are already allowed for <img> by DOMPurify's default
    // DATA_URI_TAGS list, so we don't need to override ALLOWED_URI_REGEXP.
  });

  return {
    html: sanitized,
    model: { changes: ctx.changes, comments, authors },
  };
}
