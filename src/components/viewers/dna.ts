// SnapGene `.dna` file parser (defensive / best-effort).
//
// SnapGene's on-disk format is proprietary, but its classic binary block
// layout is well covered by public reverse-engineering. The first byte is a
// document-properties block (`0x09`), followed by big-endian block lengths;
// block `0` stores the raw DNA sequence and block `10` stores feature XML.
// The implementation below mirrors the public SnapGeneReader project:
// https://github.com/Edinburgh-Genome-Foundry/SnapGeneReader
//
// Some third-party writers use alternative gzip/zlib JSON envelopes, so we
// keep those sniffing strategies as fallbacks. The first strategy that
// produces a sensible sequence document wins.

import { decodeBase64ToBytes } from "./ab1";

export interface DnaFeature {
  name: string;
  type?: string;
  start: number; // 1-based inclusive
  end: number;   // 1-based inclusive
  strand?: 1 | -1;
  color?: string;
}

export interface DnaDocument {
  /** Top-level shape after one of the parsing strategies succeeded. */
  topology: "circular" | "linear";
  /** Raw nucleotide string (uppercased, ACGTN alphabet). */
  sequence: string;
  features: DnaFeature[];
  /** Optional descriptive metadata (sample, source, etc.). */
  meta: Record<string, string>;
  /** Which decoding strategy produced this document (for debugging / UI). */
  strategy: string;
}

interface ParseAttempt {
  name: string;
  ok: boolean;
  doc?: DnaDocument;
  error?: string;
}

export interface DnaParseResult {
  attempts: ParseAttempt[];
  document: DnaDocument | null;
}

const FEATURE_COLORS = [
  "#d18a6a", "#7fbf7f", "#7faecf", "#c8a868", "#c57474",
  "#9d7fc8", "#5ba58c", "#d4a35f", "#7a9ec0", "#b8859a",
];

// Codon → amino acid table (standard genetic code, one-letter symbols,
// "*" = stop, "-" = unknown). We only translate frame +1 for now; that is
// the most common reading frame in the SnapGene viewer.
const CODON_TABLE: Record<string, string> = {
  TTT: "F", TTC: "F", TTA: "L", TTG: "L",
  CTT: "L", CTC: "L", CTA: "L", CTG: "L",
  ATT: "I", ATC: "I", ATA: "I", ATG: "M",
  GTT: "V", GTC: "V", GTA: "V", GTG: "V",
  TCT: "S", TCC: "S", TCA: "S", TCG: "S",
  CCT: "P", CCC: "P", CCA: "P", CCG: "P",
  ACT: "T", ACC: "T", ACA: "T", ACG: "T",
  GCT: "A", GCC: "A", GCA: "A", GCG: "A",
  TAT: "Y", TAC: "Y", TAA: "*", TAG: "*",
  CAT: "H", CAC: "H", CAA: "Q", CAG: "Q",
  AAT: "N", AAC: "N", AAA: "K", AAG: "K",
  GAT: "D", GAC: "D", GAA: "E", GAG: "E",
  TGT: "C", TGC: "C", TGA: "*", TGG: "W",
  CGT: "R", CGC: "R", CGA: "R", CGG: "R",
  AGT: "S", AGC: "S", AGA: "R", AGG: "R",
  GGT: "G", GGC: "G", GGA: "G", GGG: "G",
};

/** Translate a DNA sequence using frame +1 (standard genetic code). */
export function translate(dna: string): string {
  const cleaned = dna.toUpperCase().replace(/[^ACGTN]/g, "");
  const padded = cleaned + "".padEnd((3 - (cleaned.length % 3)) % 3, "N");
  let out = "";
  for (let index = 0; index < padded.length; index += 3) {
    const codon = padded.slice(index, index + 3);
    out += CODON_TABLE[codon] ?? "X";
  }
  return out;
}

function looksLikeDnaJson(value: unknown): value is { sequence?: unknown; features?: unknown; topology?: unknown; circular?: unknown; [key: string]: unknown } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.sequence !== "string") return false;
  return true;
}

function normaliseFeatures(raw: unknown): DnaFeature[] {
  if (!Array.isArray(raw)) return [];
  const list: DnaFeature[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") continue;
    // SnapGene variants store coordinates under different names depending
    // on the writer. Try the common shapes in order.
    const range = (() => {
      if (typeof item.start === "number" && typeof item.end === "number") {
        return { start: item.start, end: item.end };
      }
      const seg = item.segments;
      if (Array.isArray(seg) && seg.length > 0) {
        const first = seg[0] as Record<string, unknown> | null;
        if (first && typeof first.start === "number" && typeof first.end === "number") {
          return { start: first.start, end: first.end };
        }
      }
      return null;
    })();
    if (!range) continue;
    const strand = typeof item.strand === "number" ? (item.strand === -1 ? -1 : 1) : undefined;
    list.push({
      name: typeof item.name === "string" ? item.name : `Feature ${index + 1}`,
      type: typeof item.type === "string" ? item.type : undefined,
      start: range.start + 1, // convert 0-based to 1-based for display
      end: range.end + 1,
      strand,
      color: typeof item.color === "string" ? item.color : FEATURE_COLORS[index % FEATURE_COLORS.length],
    });
  }
  return list;
}

function buildDocument(raw: unknown, strategy: string): DnaDocument | null {
  if (!looksLikeDnaJson(raw)) return null;
  const sequence = String(raw.sequence ?? "").toUpperCase().replace(/\s+/g, "");
  if (sequence.length === 0) return null;
  const topology: "circular" | "linear" =
    raw.topology === "linear" || raw.circular === false ? "linear" : "circular";
  const features = normaliseFeatures(raw.features);
  const meta: Record<string, string> = {};
  for (const key of ["name", "description", "sample", "source", "author", "created"]) {
    if (typeof raw[key] === "string") meta[key] = raw[key] as string;
  }
  return { topology, sequence, features, meta, strategy };
}

async function inflate(bytes: Uint8Array, format: "gzip" | "deflate"): Promise<string> {
  // Copy into a fresh ArrayBuffer so the Blob's BlobPart typing is satisfied
  // regardless of whether the source Uint8Array was a SharedArrayBuffer view
  // or carried an arbitrary underlying buffer.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream(format));
  const text = await new Response(stream).text();
  return text;
}

function tryJsonString(text: string): unknown | null {
  try { return JSON.parse(text); } catch { return null; }
}

function stripSnapGeneHeader(bytes: Uint8Array): { body: Uint8Array; skipped: number } {
  // SnapGene writes a small header before the gzip stream. We try a handful
  // of plausible sizes and see which one produces a valid gzip header at
  // the next byte. The magic numbers are documented in
  // https://github.com/mauriciovillegas/SnapGene-Reader (research note):
  //   "SnapGene\x00" or 16/24/32-byte fixed-size headers are common.
  const GZIP_MAGIC = [0x1f, 0x8b];
  for (const headerLength of [0, 16, 24, 32]) {
    if (bytes.length <= headerLength + 2) continue;
    if (bytes[headerLength] === GZIP_MAGIC[0] && bytes[headerLength + 1] === GZIP_MAGIC[1]) {
      return { body: bytes.subarray(headerLength), skipped: headerLength };
    }
  }
  return { body: bytes, skipped: 0 };
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  const end = Math.min(bytes.length, offset + length);
  for (let index = offset; index < end; index += 1) {
    const code = bytes[index];
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function cleanXmlText(value: string): string {
  return decodeXmlEntities(
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function parseXmlAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(attrPattern)) {
    attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function parseSnapGeneRange(raw: string | undefined): { start: number; end: number } | null {
  if (!raw) return null;
  const values = raw.match(/\d+/g)?.map((part) => Number.parseInt(part, 10)).filter((value) => Number.isFinite(value) && value > 0) ?? [];
  if (values.length === 0) return null;
  const first = values[0];
  const second = values[1] ?? first;
  return { start: Math.min(first, second), end: Math.max(first, second) };
}

function qualifierText(featureBody: string, qualifierName: string): string | null {
  const qualifierPattern = /<Q\b([^>]*)>([\s\S]*?)<\/Q>/gi;
  for (const match of featureBody.matchAll(qualifierPattern)) {
    const attrs = parseXmlAttributes(match[1]);
    if (attrs.name !== qualifierName) continue;
    const valueMatch = /<V\b([^>]*)\/?\s*>/i.exec(match[2]);
    if (valueMatch) {
      const valueAttrs = parseXmlAttributes(valueMatch[1]);
      const value = valueAttrs.text ?? valueAttrs.predef ?? valueAttrs.int ?? Object.values(valueAttrs)[0];
      if (value) return cleanXmlText(value);
    }
    const text = cleanXmlText(match[2]);
    if (text) return text;
  }
  return null;
}

function parseSnapGeneFeaturesXml(xml: string): DnaFeature[] {
  const features: DnaFeature[] = [];
  const featurePattern = /<Feature\b([^>]*)>([\s\S]*?)<\/Feature>/gi;
  let featureIndex = 0;
  for (const match of xml.matchAll(featurePattern)) {
    const featureAttrs = parseXmlAttributes(match[1]);
    const featureBody = match[2];
    const ranges: Array<{ start: number; end: number }> = [];
    let color: string | undefined;
    const segmentPattern = /<Segment\b([^>]*)\/?\s*>/gi;
    for (const segmentMatch of featureBody.matchAll(segmentPattern)) {
      const segmentAttrs = parseXmlAttributes(segmentMatch[1]);
      const range = parseSnapGeneRange(segmentAttrs.range);
      if (range) ranges.push(range);
      if (!color && segmentAttrs.color) color = segmentAttrs.color;
    }
    if (ranges.length === 0) continue;

    const directionality = featureAttrs.directionality;
    const strand: 1 | -1 | undefined = directionality === "2" ? -1 : directionality === "1" ? 1 : undefined;
    const label = qualifierText(featureBody, "label");
    const start = Math.min(...ranges.map((range) => range.start));
    const end = Math.max(...ranges.map((range) => range.end));
    features.push({
      name: featureAttrs.name || label || `Feature ${featureIndex + 1}`,
      type: featureAttrs.type || undefined,
      start,
      end,
      strand,
      color: color ?? FEATURE_COLORS[featureIndex % FEATURE_COLORS.length],
    });
    featureIndex += 1;
  }
  return features;
}

function parseSnapGeneNotesXml(xml: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const noteKeys = [
    "Description",
    "CustomMapLabel",
    "Comments",
    "Type",
    "Created",
    "LastModified",
    "AccessionNumber",
    "SequenceClass",
    "TransformedInto",
    "UUID",
  ];
  for (const key of noteKeys) {
    const pattern = new RegExp(`<${key}\\b[^>]*>([\\s\\S]*?)<\\/${key}>`, "i");
    const match = pattern.exec(xml);
    if (!match) continue;
    const value = cleanXmlText(match[1]);
    if (value) meta[key] = value;
  }
  return meta;
}

function parseSnapGeneBinaryBlocks(bytes: Uint8Array): DnaDocument | null {
  if (bytes.length < 19 || bytes[0] !== 0x09) {
    throw new Error("未检测到 SnapGeneReader 兼容的 0x09 文档属性块");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(1, false);
  const title = readAscii(bytes, 5, 8);
  if (headerLength !== 14 || title !== "SnapGene") {
    throw new Error(`文档属性块不匹配（length=${headerLength}, title=${title || "空"}）`);
  }

  const meta: Record<string, string> = {
    isDNA: String(view.getUint16(13, false)),
    exportVersion: String(view.getUint16(15, false)),
    importVersion: String(view.getUint16(17, false)),
  };
  let cursor = 1 + 4 + headerLength;
  let sequence = "";
  let topology: "circular" | "linear" = "linear";
  const features: DnaFeature[] = [];

  while (cursor < bytes.length) {
    if (cursor + 5 > bytes.length) {
      throw new Error(`块头在偏移 ${cursor} 处截断`);
    }
    const blockType = view.getUint8(cursor);
    const blockSize = view.getUint32(cursor + 1, false);
    cursor += 5;
    if (cursor + blockSize > bytes.length) {
      throw new Error(`块 ${blockType} 声明长度 ${blockSize}，超出文件剩余 ${bytes.length - cursor} 字节`);
    }
    const block = bytes.subarray(cursor, cursor + blockSize);

    if (blockType === 0) {
      if (block.length < 1) throw new Error("0 号 DNA 序列块为空");
      const props = block[0];
      topology = (props & 0x01) > 0 ? "circular" : "linear";
      meta.strandedness = (props & 0x02) > 0 ? "double" : "single";
      if ((props & 0x04) > 0) meta.damMethylated = "true";
      if ((props & 0x08) > 0) meta.dcmMethylated = "true";
      if ((props & 0x10) > 0) meta.ecoKIMethylated = "true";
      sequence = readAscii(block, 1, block.length - 1).replace(/\s+/g, "").toUpperCase();
    } else if (blockType === 6) {
      Object.assign(meta, parseSnapGeneNotesXml(decodeUtf8(block)));
    } else if (blockType === 10) {
      features.push(...parseSnapGeneFeaturesXml(decodeUtf8(block)));
    }

    cursor += blockSize;
  }

  if (!sequence) throw new Error("未找到 0 号 DNA 序列块");
  return {
    topology,
    sequence,
    features,
    meta,
    strategy: "SnapGeneReader 二进制块解析",
  };
}

export async function parseDna(b64: string): Promise<DnaParseResult> {
  const bytes = decodeBase64ToBytes(b64);
  const attempts: ParseAttempt[] = [];

  // Strategy 1: classic SnapGene binary block layout, matching the public
  // SnapGeneReader implementation. This is the format used by ordinary
  // `.dna` files whose first bytes look like:
  //   09 00 00 00 0e 53 6e 61 70 47 65 6e 65 ...
  try {
    const doc = parseSnapGeneBinaryBlocks(bytes);
    if (doc) {
      attempts.push({ name: "SnapGeneReader 二进制块", ok: true, doc });
      return { attempts, document: doc };
    }
    attempts.push({ name: "SnapGeneReader 二进制块", ok: false, error: "未找到可显示的 DNA 序列" });
  } catch (error) {
    attempts.push({ name: "SnapGeneReader 二进制块", ok: false, error: String(error) });
  }

  // Strategy 2: snapgene-header + gzip + JSON.
  try {
    const { body, skipped } = stripSnapGeneHeader(bytes);
    if (skipped > 0 && body[0] === 0x1f && body[1] === 0x8b) {
      const text = await inflate(body, "gzip");
      const parsed = tryJsonString(text);
      const doc = parsed ? buildDocument(parsed, `gzip(跳过 ${skipped} 字节头部)`) : null;
      if (doc) {
        attempts.push({ name: "gzip + JSON", ok: true, doc });
        return { attempts, document: doc };
      }
      attempts.push({ name: "gzip + JSON", ok: false, error: "解压成功但 JSON 结构不符合 SnapGene 文档" });
    } else {
      attempts.push({ name: "gzip + JSON", ok: false, error: "未检测到 SnapGene 文件头 / gzip 魔数" });
    }
  } catch (error) {
    attempts.push({ name: "gzip + JSON", ok: false, error: String(error) });
  }

  // Strategy 3: raw gzip.
  try {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const text = await inflate(bytes, "gzip");
      const parsed = tryJsonString(text);
      const doc = parsed ? buildDocument(parsed, "gzip(无头部)") : null;
      if (doc) {
        attempts.push({ name: "raw gzip + JSON", ok: true, doc });
        return { attempts, document: doc };
      }
      attempts.push({ name: "raw gzip + JSON", ok: false, error: "解压后 JSON 结构不符合预期" });
    }
  } catch (error) {
    attempts.push({ name: "raw gzip + JSON", ok: false, error: String(error) });
  }

  // Strategy 4: zlib-wrapped JSON (no gzip header).
  try {
    if (bytes[0] === 0x78 && (bytes[1] === 0x01 || bytes[1] === 0x5e || bytes[1] === 0x9c || bytes[1] === 0xda)) {
      const text = await inflate(bytes, "deflate");
      const parsed = tryJsonString(text);
      const doc = parsed ? buildDocument(parsed, "zlib + JSON") : null;
      if (doc) {
        attempts.push({ name: "zlib + JSON", ok: true, doc });
        return { attempts, document: doc };
      }
    }
  } catch {
    // fall through
  }

  // Strategy 5: plain JSON or XML.
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = tryJsonString(trimmed);
      const doc = parsed ? buildDocument(parsed, "纯 JSON") : null;
      if (doc) {
        attempts.push({ name: "纯 JSON", ok: true, doc });
        return { attempts, document: doc };
      }
    }
    if (trimmed.startsWith("<")) {
      // Some SnapGene exporters wrap the data in a minimal XML envelope.
      // Extract anything between `<sequence>` and `</sequence>` and treat
      // it as the nucleotide string. We deliberately keep this loose —
      // SnapGene's official XML export is rare, but it's a reasonable
      // last-ditch fallback.
      const match = /<sequence[^>]*>([\s\S]*?)<\/sequence>/i.exec(trimmed);
      if (match) {
        const sequence = match[1].replace(/\s+/g, "").toUpperCase();
        if (sequence.length > 0) {
          const doc: DnaDocument = {
            topology: /circular/i.test(trimmed) ? "circular" : "linear",
            sequence,
            features: [],
            meta: {},
            strategy: "XML 包装",
          };
          attempts.push({ name: "XML", ok: true, doc });
          return { attempts, document: doc };
        }
      }
    }
    attempts.push({ name: "纯文本 / XML", ok: false, error: "未识别出有效 SnapGene 内容" });
  } catch (error) {
    attempts.push({ name: "纯文本 / XML", ok: false, error: String(error) });
  }

  return { attempts, document: null };
}

/** Hex dump of the first N bytes for debugging / display. */
export function hexPreview(bytes: Uint8Array, length = 16): string {
  const cap = Math.min(bytes.length, length);
  const parts: string[] = [];
  for (let index = 0; index < cap; index += 1) {
    parts.push(bytes[index].toString(16).padStart(2, "0"));
  }
  return parts.join(" ");
}