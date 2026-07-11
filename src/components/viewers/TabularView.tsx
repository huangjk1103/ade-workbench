import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, FilePayload } from "../../types/domain";

interface TabularViewProps {
  payload: FilePayload;
  pendingJump?: Annotation | null;
  onJumpMissed?: (annotation: Annotation) => void;
}

// Display formats that consist of a header comment followed by tab-separated
// columns. Each format has a different convention for what the header line
// looks like (if any).
const TABULAR_FORMATS = new Set([
  "gff", "gff2", "gff3", "gtf",
  "bed", "psl", "vcf",
  "sam", "axt",
  "tab", "tsv",
]);

interface ColumnSpec {
  name: string;
  // Optional friendly label for column tooltips. Used only for the well-known
  // bioinformatics specs to make the table legible.
  hint?: string;
}

const COLUMN_PRESETS: Record<string, ColumnSpec[]> = {
  gff: [
    { name: "seqid" }, { name: "source" }, { name: "type" }, { name: "start" }, { name: "end" },
    { name: "score" }, { name: "strand" }, { name: "phase" }, { name: "attributes" },
  ],
  gff3: [
    { name: "seqid" }, { name: "source" }, { name: "type" }, { name: "start" }, { name: "end" },
    { name: "score" }, { name: "strand" }, { name: "phase" }, { name: "attributes" },
  ],
  gtf: [
    { name: "seqid" }, { name: "source" }, { name: "type" }, { name: "start" }, { name: "end" },
    { name: "score" }, { name: "strand" }, { name: "frame" }, { name: "attributes" },
  ],
  bed: [
    { name: "chrom" }, { name: "start" }, { name: "end" }, { name: "name" },
    { name: "score" }, { name: "strand" }, { name: "thickStart" }, { name: "thickEnd" },
    { name: "itemRgb" }, { name: "blockCount" }, { name: "blockSizes" }, { name: "blockStarts" },
  ],
  vcf: [
    { name: "chrom" }, { name: "pos" }, { name: "id" }, { name: "ref" },
    { name: "alt" }, { name: "qual" }, { name: "filter" }, { name: "info" }, { name: "format" },
  ],
  sam: [
    { name: "qname" }, { name: "flag" }, { name: "rname" }, { name: "pos" },
    { name: "mapq" }, { name: "cigar" }, { name: "rnext" }, { name: "pnext" },
    { name: "tlen" }, { name: "seq" }, { name: "qual" },
  ],
};

interface Row {
  number: number;
  cells: string[];
  comment: string;
  meta: string;
}

const ROW_PAGE = 500;

function isComment(line: string): boolean {
  return line.startsWith("#");
}

function buildColumns(payload: FilePayload): ColumnSpec[] {
  const preset = COLUMN_PRESETS[payload.extension];
  if (preset) return preset;
  return [];
}

function parseRows(text: string, columns: ColumnSpec[]): { rows: Row[]; columnCount: number; inferred: boolean } {
  const rawLines = text.split(/\r?\n/);
  let inferred = false;
  let columnCount = columns.length;
  let headerAssigned = columns.length > 0;
  const rows: Row[] = [];
  let number = 0;
  for (const raw of rawLines) {
    if (!raw) continue;
    if (isComment(raw)) continue;
    const cells = raw.split("\t");
    if (!headerAssigned) {
      columnCount = Math.max(columnCount, cells.length);
      inferred = true;
    } else if (cells.length > columnCount) {
      columnCount = cells.length;
    }
    number += 1;
    rows.push({ number, cells, comment: "", meta: "" });
    if (rows.length >= ROW_PAGE * 4) break; // soft cap while we still stream
  }
  return { rows, columnCount, inferred };
}

function inferColumnNames(payload: FilePayload, count: number): ColumnSpec[] {
  const ext = payload.extension;
  if (ext === "tsv" || ext === "tab") {
    return Array.from({ length: count }, (_, index) => ({ name: `col${index + 1}` }));
  }
  return Array.from({ length: count }, (_, index) => ({ name: `field${index + 1}` }));
}

function collectMeta(text: string): string {
  // Surface header / directive lines (e.g. VCF `#CHROM`, GFF `##gff-version`)
  // as a separate metadata panel so the user can still see what was filtered
  // out from the table.
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith("#"));
  if (lines.length === 0) return "";
  // Cap the meta block to avoid pathological files flooding the panel.
  return lines.slice(0, 200).join("\n");
}

export default function TabularView({ payload, pendingJump, onJumpMissed }: TabularViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = useState(ROW_PAGE);
  const [pageIndex, setPageIndex] = useState(0);

  // Jump-to-source: pick the row that contains the selectedText and
  // briefly ring it with a dashed outline. We mutate the row directly via
  // a CSS class instead of wrapping DOM nodes (which would be expensive on
  // 500-row pages and could break the table layout).
  const jumpKey = pendingJump ? `${pendingJump.id}:${pendingJump.updatedAt}` : null;
  useEffect(() => {
    if (!pendingJump) return;
    const target = pendingJump.target;
    const needle = (target.selectedText ?? "").trim();
    if (!needle) { onJumpMissed?.(pendingJump); return; }
    const lines = payload.content.split(/\r?\n/);
    let rowNumber = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(needle)) { rowNumber = i + 1; break; }
    }
    if (rowNumber < 0) { onJumpMissed?.(pendingJump); return; }
    const host = hostRef.current;
    if (!host) return;
    // Walk through pages until we land on the row. setPageIndex triggers a
    // re-render and the next pass finds the right table row in the DOM.
    const targetPage = Math.floor((rowNumber - 1) / pageSize);
    if (targetPage !== pageIndex) {
      setPageIndex(targetPage);
      // Defer outline painting until after the table re-renders.
      window.setTimeout(() => paintRowOutline(host, rowNumber), 80);
    } else {
      paintRowOutline(host, rowNumber);
    }
  }, [jumpKey, onJumpMissed, pageIndex, pageSize, payload.content, pendingJump]);

  if (!TABULAR_FORMATS.has(payload.extension)) {
    return (
      <div className="viewer-state">
        <strong>暂不支持的表格格式：{payload.extension}</strong>
      </div>
    );
  }

  const meta = useMemo(() => collectMeta(payload.content), [payload.content]);
  const { rows, columnCount, inferred } = useMemo(() => parseRows(payload.content, buildColumns(payload)), [payload.content, payload.extension]);
  const columns = useMemo<ColumnSpec[]>(() => {
    if (columnCount === 0) return [];
    if (inferred) return inferColumnNames(payload, columnCount);
    if (columnCount > buildColumns(payload).length) {
      const base = buildColumns(payload);
      const extras: ColumnSpec[] = Array.from({ length: columnCount - base.length }, (_, index) => ({
        name: `extra${index + 1}`,
      }));
      return [...base, ...extras];
    }
    return buildColumns(payload);
  }, [columnCount, inferred, payload]);

  const pageStart = pageIndex * pageSize;
  const pageEnd = Math.min(rows.length, pageStart + pageSize);
  const visibleRows = rows.slice(pageStart, pageEnd);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));

  return (
    <div className="tabular-view" ref={hostRef}>
      <div className="tabular-summary">
        <div>
          <span>{payload.extension.toUpperCase()}</span>
          <strong>{rows.length.toLocaleString("en-US")} 行 · {columnCount} 列</strong>
        </div>
        <div className="tabular-pagination">
          <button type="button" onClick={() => setPageIndex(0)} disabled={pageIndex === 0}>«</button>
          <button type="button" onClick={() => setPageIndex((value) => Math.max(0, value - 1))} disabled={pageIndex === 0}>‹</button>
          <span>{pageIndex + 1} / {totalPages}</span>
          <button type="button" onClick={() => setPageIndex((value) => Math.min(totalPages - 1, value + 1))} disabled={pageIndex >= totalPages - 1}>›</button>
          <button type="button" onClick={() => setPageIndex(totalPages - 1)} disabled={pageIndex >= totalPages - 1}>»</button>
          <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPageIndex(0); }}>
            <option value={200}>200 / 页</option>
            <option value={500}>500 / 页</option>
            <option value={1000}>1000 / 页</option>
            <option value={5000}>5000 / 页</option>
          </select>
        </div>
      </div>
      {meta && (
        <details className="tabular-meta">
          <summary>头部 / 注释 ({meta.split("\n").length})</summary>
          <pre>{meta}</pre>
        </details>
      )}
      <div className="tabular-scroll">
        <table>
          <thead>
            <tr>
              <th className="tabular-rownum">#</th>
              {columns.map((column, index) => (
                <th key={column.name} title={column.hint}>{column.name}<small>{index + 1}</small></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.number}>
                <td className="tabular-rownum">{row.number}</td>
                {columns.map((column, index) => (
                  <td key={`${row.number}-${column.name}`} title={row.cells[index]}>
                    {row.cells[index] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <div className="viewer-state">
          <strong>{payload.extension.toUpperCase()} 文件没有可显示的数据行</strong>
          {meta && <span>查看头部 / 注释获取更多信息。</span>}
        </div>
      )}
    </div>
  );
}

// Paint a dashed outline around the matching `<tr>`. We add an inline class
// because the table already has very tight cell padding and any DOM-wrap
// would shift the layout.
function paintRowOutline(host: HTMLElement, rowNumber: number) {
  const row = host.querySelector<HTMLTableRowElement>(`tbody tr td.tabular-rownum`);
  // Find the row that contains a rownum cell matching `rowNumber`.
  const targetRow = Array.from(host.querySelectorAll<HTMLTableRowElement>("tbody tr")).find((tr) => {
    const cell = tr.querySelector<HTMLElement>("td.tabular-rownum");
    return cell?.textContent === String(rowNumber);
  });
  if (!targetRow) return;
  targetRow.classList.add("ade-jump-outline-row");
  targetRow.scrollIntoView({ block: "center", behavior: "smooth" });
  window.setTimeout(() => targetRow.classList.remove("ade-jump-outline-row"), 2300);
}