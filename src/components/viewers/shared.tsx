import { AlertTriangle, LoaderCircle } from "lucide-react";
import type { FilePayload, TextSelectionContext } from "../../types/domain";

export function selectionContext(
  payload: FilePayload,
  selectedText: string,
  source: string,
): TextSelectionContext {
  const index = source.indexOf(selectedText);
  // 1-based line number where the selection starts. We count complete lines
  // by splitting at `\n` and using the count of leading segments. When the
  // text isn't found verbatim we leave the field undefined rather than
  // guessing — the prompt falls back to "前文/后文" in that case.
  const lineNumber = index >= 0 ? source.slice(0, index).split("\n").length : undefined;
  // Total line count is independent of whether we found the selection —
  // always useful so the agent can phrase "第 N 行 / 共 M 行".
  const totalLines = source ? source.split("\n").length : undefined;
  return {
    filePath: payload.relativePath,
    selectedText,
    prefix: index >= 0 ? source.slice(Math.max(0, index - 160), index) : "",
    suffix: index >= 0 ? source.slice(index + selectedText.length, index + selectedText.length + 160) : "",
    fileModifiedMs: payload.modifiedMs,
    lineNumber,
    totalLines,
  };
}

export function ViewerLoading({ label }: { label: string }) {
  return (
    <div className="viewer-state">
      <LoaderCircle className="spin" size={24} />
      <span>{label}</span>
    </div>
  );
}

export function ViewerError({ message }: { message: string }) {
  return (
    <div className="viewer-state viewer-state--error">
      <AlertTriangle size={24} />
      <strong>文件解析失败</strong>
      <span>{message}</span>
    </div>
  );
}
