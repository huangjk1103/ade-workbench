import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import type { Annotation, FilePayload, TextSelectionContext } from "../../types/domain";
import { selectionContext } from "./shared";

function languageFor(extension: string) {
  const aliases: Record<string, string> = {
    md: "markdown", markdown: "markdown", mdx: "markdown", rst: "markdown",
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript", vue: "html", svelte: "html",
    py: "python", rs: "rust", yml: "yaml", sh: "shell", bash: "shell", zsh: "shell",
    ps1: "powershell", bat: "bat", cmd: "bat", fish: "shell",
    proto: "protobuf", graphql: "graphql",
    css: "css", scss: "scss", sass: "scss", less: "less",
    htm: "html",
    jsonc: "json", json5: "json",
    // Bioinformatics formats: no native Monaco grammar, fall back to plaintext
    // so we never crash the editor when a token-set is missing.
  };
  return aliases[extension] ?? (extension || "plaintext");
}

interface CodeEditorProps {
  payload: FilePayload;
  content: string;
  wordWrap: boolean;
  onContentChange: (content: string) => void;
  onSelection: (selection: TextSelectionContext) => void;
  pendingJump?: Annotation | null;
  onJumpMissed?: (annotation: Annotation) => void;
}

export default function CodeEditor({ payload, content, wordWrap, onContentChange, onSelection, pendingJump, onJumpMissed }: CodeEditorProps) {
  // `editorRef` holds the Monaco editor instance after mount so the jump
  // effect below can call decoration/reveal APIs without re-running the
  // heavy onMount callback on every selection change. `decorationsRef`
  // stores the decoration identifiers returned by Monaco's
  // `deltaDecorations`; passing these back removes the matching outlines
  // on the next call.
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.onDidChangeCursorSelection(({ selection }) => {
      const selectedText = editor.getModel()?.getValueInRange(selection).trim() ?? "";
      if (selectedText) onSelection(selectionContext(payload, selectedText, content));
    });
  };

  // Jump-to-source for code/markdown-source. Monaco gives us precise line
  // + column ranges via the IRange API, so we locate `selectedText` (or
  // the prefix+head fragment as a fallback), reveal the line in the centre
  // of the viewport, set the cursor + selection, and paint a dashed outline
  // via `deltaDecorations`. The decoration uses the `.ade-jump-monaco`
  // CSS class defined in styles.css.
  const jumpKey = pendingJump ? `${pendingJump.id}:${pendingJump.updatedAt}` : null;
  useEffect(() => {
    if (!pendingJump) return;
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const target = pendingJump.target;

    // Resolve a 1-based line number from `lineNumber` and locate the
    // matching substring on that line. If the line is empty or the
    // substring moved, fall back to scanning the full text.
    const needle = (target.selectedText ?? "").trim();
    let lineNumber = target.lineNumber;
    let lineRange: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | null = null;

    if (lineNumber && lineNumber >= 1 && lineNumber <= model.getLineCount()) {
      const lineText = model.getLineContent(lineNumber);
      const idx = needle ? lineText.indexOf(needle) : -1;
      const safeStart = idx >= 0 ? idx + 1 : 1;
      const safeEnd = idx >= 0 ? idx + 1 + needle.length : lineText.length + 1;
      lineRange = { startLineNumber: lineNumber, startColumn: safeStart, endLineNumber: lineNumber, endColumn: safeEnd };
    }

    if (!lineRange && needle) {
      const haystack = model.getValue();
      const idx = haystack.indexOf(needle);
      if (idx >= 0) {
        // Walk the offset back to a (line, column) pair.
        const before = haystack.slice(0, idx);
        const lines = before.split("\n");
        const line = lines.length;
        const col = lines[lines.length - 1].length + 1;
        lineRange = { startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col + needle.length };
      } else {
        // Last-ditch: prefix+first-quarter of needle. Works for whitespace-
        // drifted text where the user's selection embedded line breaks.
        const prefix = (target.prefix ?? "").slice(-40);
        const tail = needle.slice(0, Math.max(8, Math.floor(needle.length / 4)));
        const fragment = `${prefix}${tail}`;
        const fragmentIdx = fragment ? haystack.indexOf(fragment) : -1;
        if (fragmentIdx >= 0) {
          const start = fragmentIdx + prefix.length;
          const before = haystack.slice(0, start);
          const lines = before.split("\n");
          const line = lines.length;
          const col = lines[lines.length - 1].length + 1;
          lineRange = { startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col + needle.length };
        }
      }
    }

    if (!lineRange) {
      onJumpMissed?.(pendingJump);
      return;
    }
    const range = {
      startLineNumber: lineRange.startLineNumber,
      startColumn: lineRange.startColumn,
      endLineNumber: lineRange.endLineNumber,
      endColumn: lineRange.endColumn,
    };
    editor.revealLineInCenter(lineRange.startLineNumber);
    editor.setSelection(range);
    // Drop the previous outline before adding a new one so repeated jumps
    // don't leave a trail of overlapping decorations.
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [
      {
        range,
        options: {
          className: "ade-jump-monaco",
          isWholeLine: false,
          inlineClassName: undefined,
          stickiness: 1,
        },
      },
    ]);
    window.setTimeout(() => {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
    }, 2300);
  }, [jumpKey, onJumpMissed, pendingJump]);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <Editor
        height="100%"
        language={languageFor(payload.extension)}
        value={content}
        onChange={(value) => onContentChange(value ?? "")}
        onMount={handleEditorMount}
        theme="vs-dark"
        options={{
          minimap: { enabled: false },
          wordWrap: wordWrap ? "on" : "off",
          fontFamily: '"Cascadia Code", Consolas, monospace',
          fontSize: 13,
          lineHeight: 21,
          padding: { top: 18, bottom: 28 },
          smoothScrolling: true,
          automaticLayout: true,
          renderWhitespace: "selection",
        }}
      />
    </div>
  );
}
