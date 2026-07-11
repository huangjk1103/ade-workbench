import { useEffect, useMemo, type CSSProperties } from "react";
import type { Annotation, FilePayload, TextSelectionContext } from "../../types/domain";
import { selectionContext } from "./shared";
import { useRef } from "react";

interface SequenceViewProps {
  payload: FilePayload;
  onSelection: (selection: TextSelectionContext) => void;
  pendingJump?: Annotation | null;
  onJumpMissed?: (annotation: Annotation) => void;
}

// FASTA / FASTQ records: a header line (starts with `>` for FASTA, `@` for
// FASTQ) followed by one or more sequence lines. FASTQ adds a `+` separator
// and quality scores after each sequence block.
interface SeqRecord {
  header: string;
  sequence: string;
  quality?: string;
}

function parseFasta(text: string): SeqRecord[] {
  const records: SeqRecord[] = [];
  let current: SeqRecord | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith(">")) {
      if (current) records.push(current);
      current = { header: line.slice(1).trim(), sequence: "" };
    } else if (current && line.length > 0) {
      current.sequence += line;
    }
  }
  if (current) records.push(current);
  return records;
}

function parseFastq(text: string): SeqRecord[] {
  const records: SeqRecord[] = [];
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const header = lines[index]?.trim();
    if (!header || !header.startsWith("@")) { index += 1; continue; }
    const sequence = lines[index + 1]?.trim() ?? "";
    // line index+2 is the "+" separator — ignore
    const quality = lines[index + 3]?.trim() ?? "";
    records.push({ header: header.slice(1).trim(), sequence, quality });
    index += 4;
  }
  return records;
}

// Color residues by chemical group. Ambiguity codes get a neutral gray so
// the eye can scan past them. Uppercase only — we already uppercased on parse.
const NUCLEOTIDE_COLORS: Record<string, string> = {
  A: "#7fbf7f",
  T: "#d18a6a",
  U: "#d18a6a",
  G: "#c8a868",
  C: "#7faecf",
  N: "#5f666f",
};

function detectAlphabets(sequences: string[]): { dna: boolean; protein: boolean } {
  let dna = false;
  let protein = false;
  for (const seq of sequences) {
    const upper = seq.toUpperCase();
    if (/^[ACGTUN]+$/.test(upper)) dna = true;
    else if (/^[ACDEFGHIKLMNPQRSTVWY\*\-\.]+$/.test(upper)) protein = true;
    if (dna && protein) break;
  }
  return { dna, protein };
}

function isFastq(payload: FilePayload): boolean {
  return payload.extension === "fq" || payload.extension === "fastq";
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function colorFor(char: string, alphabet: { dna: boolean; protein: boolean }): string | undefined {
  const upper = char.toUpperCase();
  if (alphabet.dna) return NUCLEOTIDE_COLORS[upper];
  if (alphabet.protein) {
    // Hydrophobicity color scale for the 20 amino acids.
    const map: Record<string, string> = {
      A: "#7fbf7f", V: "#7fbf7f", L: "#7fbf7f", I: "#7fbf7f", M: "#7fbf7f", F: "#7fbf7f", W: "#7fbf7f", P: "#7fbf7f",
      G: "#c8a868", C: "#c8a868", S: "#c8a868", T: "#c8a868", Y: "#c8a868", N: "#c8a868", Q: "#c8a868",
      D: "#c57474", E: "#c57474",
      K: "#7faecf", R: "#7faecf", H: "#7faecf",
    };
    return map[upper];
  }
  return undefined;
}

export default function SequenceView({ payload, onSelection, pendingJump, onJumpMissed }: SequenceViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fastq = isFastq(payload);

  const records = useMemo(() => {
    const text = payload.content;
    if (!text) return [] as SeqRecord[];
    return fastq ? parseFastq(text) : parseFasta(text);
  }, [payload.content, fastq]);

  const stats = useMemo(() => {
    const lengths = records.map((record) => record.sequence.length);
    const total = lengths.reduce((sum, value) => sum + value, 0);
    const max = lengths.reduce((acc, value) => (value > acc ? value : acc), 0);
    const min = lengths.length ? lengths.reduce((acc, value) => (value < acc ? value : acc), lengths[0]) : 0;
    const alphabet = detectAlphabets(records.map((record) => record.sequence));
    return { count: records.length, total, max, min, alphabet };
  }, [records]);

  // Jump-to-source for FASTA / FASTQ. The selectedText on a sequence
  // annotation is usually a short residue substring ("ATGCG…") — we scan
  // every record's `.sequence-body` pre block, paint the line(s) with a
  // dashed outline, and scroll the first match into view.
  const jumpKey = pendingJump ? `${pendingJump.id}:${pendingJump.updatedAt}` : null;
  useEffect(() => {
    if (!pendingJump || !hostRef.current) return;
    const host = hostRef.current;
    const target = pendingJump.target;
    const needle = (target.selectedText ?? "").trim().toUpperCase();
    if (!needle) {
      onJumpMissed?.(pendingJump);
      return;
    }
    const records = Array.from(host.querySelectorAll<HTMLElement>(".sequence-record"));
    let firstMatch: HTMLElement | null = null;
    for (const record of records) {
      const body = record.querySelector<HTMLPreElement>(".sequence-body");
      if (!body) continue;
      const text = (body.textContent ?? "").toUpperCase();
      const idx = text.indexOf(needle);
      if (idx < 0) continue;
      if (!firstMatch) firstMatch = record;
      // Highlight each 60-bp line that overlaps the match index.
      const lines = Array.from(record.querySelectorAll<HTMLElement>(".sequence-body > span"));
      let cursor = 0;
      let lineIndex = 0;
      const needleStart = idx;
      const needleEnd = idx + needle.length;
      for (const line of lines) {
        const lineLen = (line.textContent ?? "").length;
        const lineStart = cursor;
        const lineEnd = cursor + lineLen;
        if (lineEnd >= needleStart && lineStart < needleEnd) {
          line.classList.add("ade-jump-monaco");
          line.dataset.jumpExpiresAt = String(Date.now() + 2300);
        }
        cursor = lineEnd;
        lineIndex += 1;
      }
    }
    if (!firstMatch) {
      onJumpMissed?.(pendingJump);
      return;
    }
    // Strip the temporary outline class when the animation runs out so the
    // original color-by-alphabet rendering returns.
    window.setTimeout(() => {
      document.querySelectorAll(".ade-jump-monaco").forEach((node) => {
        if ((node as HTMLElement).dataset.jumpExpiresAt && Number((node as HTMLElement).dataset.jumpExpiresAt) <= Date.now()) {
          node.classList.remove("ade-jump-monaco");
          delete (node as HTMLElement).dataset.jumpExpiresAt;
        }
      });
    }, 2400);
    firstMatch.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [jumpKey, onJumpMissed, pendingJump]);

  const captureSelection = () => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? "";
    if (!selectedText || !selection?.anchorNode || !hostRef.current?.contains(selection.anchorNode)) return;
    onSelection(selectionContext(payload, selectedText, payload.content));
  };

  if (records.length === 0) {
    return (
      <div className="viewer-state">
        <strong>{fastq ? "FASTQ" : "FASTA"} 文件为空或无法解析</strong>
        <span>{payload.relativePath}</span>
      </div>
    );
  }

  return (
    <div className="sequence-view" ref={hostRef} onMouseUp={captureSelection}>
      <div className="sequence-summary">
        <div>
          <span>{fastq ? "FASTQ" : "FASTA"}</span>
          <strong>{stats.count.toLocaleString("en-US")} 条记录</strong>
        </div>
        <div>
          <em>{formatNumber(stats.total)} bp</em>
          <span>最长 {formatNumber(stats.max)} · 最短 {formatNumber(stats.min)}</span>
        </div>
        <div className="sequence-alphabet">
          {stats.alphabet.dna && <i style={{ background: NUCLEOTIDE_COLORS.A }} />}<span>核酸</span>
          {stats.alphabet.protein && <i style={{ background: "#7faecf" }} />}<span>蛋白</span>
        </div>
      </div>
      <div className="sequence-records">
        {records.map((record, recordIndex) => (
          <div className="sequence-record" key={`${recordIndex}-${record.header}`}>
            <div className="sequence-header">
              <span className="sequence-tag">{fastq ? "@" : ">"}</span>
              <span className="sequence-name">{record.header || "(无名序列)"}</span>
              <em>{formatNumber(record.sequence.length)} {fastq ? "bp" : "aa"}</em>
            </div>
            <pre className="sequence-body">
              {renderSequence(record.sequence, stats.alphabet)}
            </pre>
            {record.quality && (
              <pre className="sequence-quality">{renderQuality(record.quality)}</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function renderSequence(sequence: string, alphabet: { dna: boolean; protein: boolean }) {
  const upper = sequence.toUpperCase();
  const chunks: Array<{ key: string; style: CSSProperties; text: string }> = [];
  let buffer = "";
  let bufferColor: string | undefined;
  for (let index = 0; index < upper.length; index += 1) {
    const char = upper[index];
    if (!/[A-Z\-\.\*]/.test(char)) {
      // Whitespace, digits, etc. — flush current buffer and emit as plain.
      if (buffer) { chunks.push({ key: `${index}-plain`, text: buffer, style: {} }); buffer = ""; }
      chunks.push({ key: `${index}-raw`, text: char, style: {} });
      continue;
    }
    const color = colorFor(char, alphabet);
    if (color !== bufferColor && buffer) {
      chunks.push({ key: `${index}-${bufferColor ?? "x"}`, text: buffer, style: bufferColor ? { color: bufferColor } : {} });
      buffer = "";
    }
    buffer += char;
    bufferColor = color;
  }
  if (buffer) {
    chunks.push({ key: `tail-${bufferColor ?? "x"}`, text: buffer, style: bufferColor ? { color: bufferColor } : {} });
  }
  return chunks.map((chunk) => <span key={chunk.key} style={chunk.style}>{chunk.text}</span>);
}

function renderQuality(quality: string) {
  // Render each Phred character as a tile whose opacity reflects its ASCII
  // score. Printable quality strings fall in the 33–73 range (Sanger) so we
  // remap that band into 0.35–1 opacity.
  return Array.from(quality).map((char, index) => {
    const code = char.charCodeAt(0);
    const opacity = Math.min(1, Math.max(0.35, (code - 33) / 40));
    return <span key={index} style={{ opacity }}>{char}</span>;
  });
}