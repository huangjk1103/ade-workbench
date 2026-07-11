import { useEffect, useRef, useState } from "react";
import ExcelJS from "exceljs";
import { decodeBase64 } from "../../lib/bridge";
import type { Annotation, FilePayload } from "../../types/domain";
import { ViewerError, ViewerLoading } from "./shared";

type SheetPreview = { name: string; rows: string[][] };

function stringifyCell(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("text" in value) return String(value.text);
    if ("result" in value) return String(value.result ?? "");
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    return JSON.stringify(value);
  }
  return String(value);
}

export default function SpreadsheetView({ payload, pendingJump, onJumpMissed }: { payload: FilePayload; pendingJump?: Annotation | null; onJumpMissed?: (annotation: Annotation) => void }) {
  const [sheets, setSheets] = useState<SheetPreview[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState("");
  const sheetRef = useRef<HTMLDivElement>(null);

  // Jump-to-source for spreadsheets: switch to the sheet that contains the
  // selectedText (col 1-5 heuristic — spreadsheet annotations are rare) and
  // outline the matching row with a dashed border. The active-sheet
  // heuristic is good enough for short tabular notes; if no sheet contains
  // the text we surface `onJumpMissed` so the user gets feedback.
  const jumpKey = pendingJump ? `${pendingJump.id}:${pendingJump.updatedAt}` : null;
  useEffect(() => {
    if (!pendingJump || sheets.length === 0) return;
    const target = pendingJump.target;
    const needle = (target.selectedText ?? "").trim();
    if (!needle) { onJumpMissed?.(pendingJump); return; }
    const matchIndex = sheets.findIndex((sheet) => sheet.rows.some((row) => row.some((cell) => cell.includes(needle))));
    if (matchIndex < 0) { onJumpMissed?.(pendingJump); return; }
    setActiveSheet(matchIndex);
    window.setTimeout(() => {
      const host = sheetRef.current;
      if (!host) return;
      const row = Array.from(host.querySelectorAll<HTMLTableRowElement>("tbody tr")).find((tr) => {
        return Array.from(tr.querySelectorAll<HTMLElement>("td")).some((td) => (td.textContent ?? "").includes(needle));
      });
      if (!row) return;
      row.classList.add("ade-jump-outline-row");
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      window.setTimeout(() => row.classList.remove("ade-jump-outline-row"), 2300);
    }, 80);
  }, [jumpKey, onJumpMissed, pendingJump, sheets]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (payload.extension === "csv" || payload.extension === "tsv") {
        const delimiter = payload.extension === "tsv" ? "\t" : ",";
        const rows = payload.content.split(/\r?\n/).slice(0, 500).map((line) => line.split(delimiter).slice(0, 80));
        if (!cancelled) setSheets([{ name: payload.name, rows }]);
        return;
      }
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(decodeBase64(payload.content));
      const nextSheets: SheetPreview[] = [];
      workbook.eachSheet((sheet) => {
        const rows: string[][] = [];
        sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
          if (rowNumber > 500) return;
          const values: string[] = [];
          for (let column = 1; column <= Math.min(sheet.columnCount, 80); column += 1) {
            values.push(stringifyCell(row.getCell(column).value));
          }
          rows.push(values);
        });
        nextSheets.push({ name: sheet.name, rows });
      });
      if (!cancelled) setSheets(nextSheets);
    };
    void load().catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [payload]);

  if (error) return <ViewerError message={error} />;
  if (!sheets.length) return <ViewerLoading label="正在解析 Excel 工作簿…" />;
  const sheet = sheets[activeSheet] ?? sheets[0];
  return (
    <div className="spreadsheet-viewer">
      <div className="sheet-scroll" ref={sheetRef}>
        <table>
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th>{rowIndex + 1}</th>
                {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sheet-tabs">
        {sheets.map((item, index) => (
          <button key={item.name} type="button" className={activeSheet === index ? "is-active" : ""} onClick={() => setActiveSheet(index)}>{item.name}</button>
        ))}
      </div>
    </div>
  );
}
