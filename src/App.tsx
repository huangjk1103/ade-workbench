import {
  ChevronDown,
  FileText,
  Files,
  FolderOpen,
  GitCompare,
  History,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  RefreshCw,
  Settings,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
// SlidersHorizontal is imported lazily below by the data-action buttons in
// SettingsPanel — keeping the import set minimal here.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ActivityFeed } from "./components/ActivityFeed";
import { AgentTerminal } from "./components/AgentTerminal";
import { AnnotationPanel } from "./components/AnnotationPanel";
import { FolderPicker } from "./components/FolderPicker";
import { Landing } from "./components/Landing";
import { ProjectFileTree } from "./components/ProjectFileTree";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  appendJournalAnnotation,
  awaitAgentReady,
  createJournalSnapshot,
  createTaskSnapshot,
  deleteJournalAnnotation,
  detectAgents,
  loadJournal,
  loadJournalEvents,
  loadJournalSummary,
  loadPersistedState,
  loadWorkspace,
  logJournalEvent,
  openFileExternally,
  openProjectFolder,
  readProjectFile,
  recordJournalTokens,
  restoreJournalSnapshot,
  restoreTaskSnapshot,
  savePersistedState,
  saveWorkspace,
  scanProject,
  startAgent,
  updateJournalAnnotation,
  upsertJournalAgent,
  writeAgent,
  writeProjectBinaryFile,
  writeProjectDocx,
  writeProjectTextFile,
} from "./lib/bridge";
import type { WorkspaceState } from "./lib/bridge";
import type {
  ActivityEntry,
  AdeCounters,
  AdeJournal,
  AdeJournalSummary,
  AgentDefinition,
  AgentDetection,
  AgentSession,
  AgentTab,
  Annotation,
  AnnotationRect,
  DocxReviewModel,
  FileTab,
  PersistedState,
  ProjectRecord,
  ProjectSnapshot,
  TextSelectionContext,
  WorkspaceTab,
} from "./types/domain";
import type { SettingsTab } from "./components/SettingsPanel";
import type { DocxReviewJumpTarget } from "./components/viewers/DocxView";
import { selectionContext } from "./components/viewers/shared";
import { defaultAgents } from "./types/domain";
import { useResizableSidebar } from "./lib/useResizableSidebar";

const FileViewer = lazy(() => import("./components/FileViewer").then((module) => ({ default: module.FileViewer })));

type InspectorMode = "files" | "annotations" | "activity";

const emptyState: PersistedState = {
  version: 1,
  projects: [],
  // Annotations are now stored per-project in `<rootPath>/.ade/journal.json`.
  // The legacy `annotations` array on the global state file is intentionally
  // left empty for fresh installs; on upgrade we migrate once and clear it.
  annotations: [],
  agentDefinitions: defaultAgents,
};

const EMPTY_COUNTERS: AdeCounters = {
  annotations: 0,
  annotationsOpen: 0,
  annotationsSent: 0,
  annotationsResolved: 0,
  operations: 0,
  agentSessions: 0,
  snapshots: 0,
};

function flattenEntries<T extends { children: T[] }>(entries: T[]): T[] {
  return entries.flatMap((entry) => [entry, ...flattenEntries(entry.children)]);
}

function normalizeRootPath(path: string): string {
  let p = path.trim();
  // Strip Windows verbatim prefix (`\\?\` or `\\?\UNC\`) so two
  // representations of the same path compare equal.
  if (p.startsWith("\\\\?\\")) {
    p = p.slice(4);
    if (p.startsWith("UNC\\")) {
      p = "\\\\" + p.slice(4);
    }
  }
  return p.replace(/\//g, "\\").toLowerCase();
}

function dedupeProjects(projects: ProjectRecord[]): ProjectRecord[] {
  const seen = new Map<string, ProjectRecord>();
  for (const p of projects) {
    const key = normalizeRootPath(p.rootPath);
    const prev = seen.get(key);
    if (!prev || p.lastOpenedAt > prev.lastOpenedAt) {
      seen.set(key, p);
    }
  }
  return Array.from(seen.values());
}

function fileKindOf(filePath: string): {
  kind: string;
  hint: string;
  positionLabel: "行" | "段" | "页" | "位置";
} {
  const ext = filePath.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "docx":
    case "docm":
      return {
        kind: "Word 文档（OOXML / zip+XML；ADE 通过 mammoth + 自研 docxReview 解析为 HTML 后用 contenteditable 编辑）",
        positionLabel: "段",
        hint: [
          ".docx 本质上是 zip 包，没有真实行号；ADE 把段落以 <p>/<h1>/<h2>/<li> 等块级元素渲染，块级元素之间在 textContent 中无换行符，因此 ADE 给出的位置是“段落序号”。",
          "读回/编辑建议：",
          "  • Node：npx -y mammoth <file>.docx --output-format=text   （直接拿到段落文本流）",
          "  • Python：pip install python-docx，然后",
          "      python3 -c \"from docx import Document; [print(f'{i}: {p.text}') for i, p in enumerate(Document('<file>').paragraphs)]\"",
          "  • 查看原批注 / 修订痕迹（w:ins, w:del, w:comment）：把 .docx 当 zip 解压后读 word/document.xml 与 word/comments.xml。",
          "写回时务必保留 zip + OOXML 结构，不要把整个文件当普通文本覆盖；若必须修改原文件建议用 python-docx 之类的库。",
        ].join("\n"),
      };
    case "doc":
      return {
        kind: "Word 旧版（.doc，二进制；ADE 把 .doc 一律按 docx 路径编辑后通过 html-to-docx → docx → Word COM 转回 .doc）",
        positionLabel: "段",
        hint: [
          ".doc 是 Word 97-2003 二进制格式，没有稳定行号；ADE 实际上把它当 docx 处理（解析 → 编辑 → 写回）。",
          "读回建议先转 docx 再走 docx 的方案：`soffice --headless --convert-to docx <file>.doc`，然后用 mammoth / python-docx 按段落定位。",
        ].join("\n"),
      };
    case "pdf":
      return {
        kind: "PDF（二进制；ADE 用 pdf.js 渲染并取页码 + 选择矩形作为定位依据）",
        positionLabel: "页",
        hint: [
          "PDF 没有行号，按页码定位；ADE 给的位置是 pageNumber。",
          "读回建议：",
          "  • pdftotext -layout <file>.pdf -                  （保留版式，输出纯文本）",
          "  • Python：pip install pdfplumber",
          "      python3 -c \"import pdfplumber; pdf=pdfplumber.open('<file>'); [print(f'--- p{i+1} ---', page.extract_text()) for i, page in enumerate(pdf.pages)]\"",
        ].join("\n"),
      };
    case "md":
    case "markdown":
    case "mdx":
    case "rst":
      return {
        kind: "Markdown / RST（utf-8 文本；ADE 用 react-markdown 渲染后再捕获选区）",
        positionLabel: "行",
        hint: "直接以 utf-8 文本读取即可使用 Read / cat / sed，路径相对当前项目根目录。",
      };
    case "fasta":
    case "fa":
    case "fna":
    case "faa":
    case "ffn":
    case "frn":
    case "mpfa":
    case "fq":
    case "fastq":
      return {
        kind: "FASTA / FASTQ 序列（utf-8 文本；ADE 用 SequenceView 渲染，序列每 60-80 个字符会强制折行，因此“行号”仅供大致参考）",
        positionLabel: "行",
        hint: "直接 Read 即可；如需按记录分段，可 `grep -n '^>' <file>` 或 `awk '/^>/{i++}{print i\":\"$0}'`。",
      };
    default:
      return {
        kind: ext ? `${ext.toUpperCase()} 文本/源码（utf-8；ADE 用 Monaco Editor / 通用 CodeEditor 渲染，按真实行号定位）` : "文本（utf-8）",
        positionLabel: "行",
        hint: "直接以 utf-8 文本按相对路径读取即可，使用 Read / cat / sed 等工具。",
      };
  }
}

function taskPrompt(annotation: Annotation, cwd: string): string {
  const meta = fileKindOf(annotation.target.filePath);
  const t = annotation.target;
  // Build the position phrase. Prefer pageNumber for PDF (no line numbers
  // exist); otherwise prefer lineNumber with totalLines. When neither is
  // available we fall back to "未捕获" and tell the agent to rely on the
  // prefix / suffix snippet.
  let positionPhrase: string;
  if (t.pageNumber !== undefined) {
    positionPhrase = `第 ${t.pageNumber} 页（PDF，按页定位，无行号）`;
  } else if (t.lineNumber !== undefined && t.totalLines !== undefined) {
    positionPhrase = `第 ${t.lineNumber} ${meta.positionLabel} / 共 ${t.totalLines} ${meta.positionLabel}`;
  } else if (t.lineNumber !== undefined) {
    positionPhrase = `第 ${t.lineNumber} ${meta.positionLabel}（总数未知）`;
  } else {
    positionPhrase = "位置未捕获（请优先用前文/后文 + 选中内容定位）";
  }

  const snippet = [
    t.prefix ? `…${t.prefix}⟵ 前文` : "",
    `▷ ${t.selectedText} ◁ ← 选中内容（这是定位的第一锚点）`,
    t.suffix ? `后文⟶${t.suffix}…` : "",
  ].filter(Boolean).join("\n");

  return [
    `[ADE 批注任务]`,
    `文件（相对当前项目根目录）：${t.filePath}`,
    `文件类型：${meta.kind}`,
    `定位信息：${positionPhrase}`,
    ``,
    `选中片段（含前/后文便于定位）：`,
    snippet,
    ``,
    `批注意见（用户的实际需求）：`,
    annotation.body,
    ``,
    `──────────────────────────────────────────`,
    `当前工作目录 (cwd)：${cwd}`,
    `请你按下面的指引快速读回文件并定位上下文：`,
    meta.hint,
    ``,
    `定位优先级：选中内容 > 前/后文 > 段落/行号/页码 > 文件路径。`,
    `完成后请说明：(a) 修改了哪些文件与具体改动；(b) 验证方式（命令或打开方式）；(c) 若修改了 .docx/.doc，请保持 zip+XML/二进制结构，必要时说明回写方式。`,
  ].filter(Boolean).join("\n");
}

function App() {
  const [state, setState] = useState<PersistedState>(emptyState);
  const [detections, setDetections] = useState<AgentDetection[]>([]);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  // Per-project journal state. The journal is the single source of truth for
  // annotations, agent session summaries, snapshots, and counters; it lives
  // at `<rootPath>/.ade/journal.json` so it follows the project across
  // machines instead of being trapped in a global state file.
  const [journal, setJournal] = useState<AdeJournal | null>(null);
  const [events, setEvents] = useState<ActivityEntry[]>([]);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selection, setSelection] = useState<TextSelectionContext>();
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("files");
  // Docx review model lifted out of DocxView so the right-hand
  // AnnotationPanel can list Word-style comments / tracked changes next
  // to the user's own annotations (the in-document review pane has been
  // retired). Reset every time the active file changes so a quick file
  // switch doesn't briefly leak entries from the previous doc.
  const [docxReview, setDocxReview] = useState<DocxReviewModel | null>(null);
  // Stamped when a docx-native review item is clicked in the right
  // panel. DocxView's effect re-runs on every nonce bump so a re-click
  // on the same entry still re-flashes the matching paragraph.
  const [pendingDocxReviewJump, setPendingDocxReviewJump] = useState<DocxReviewJumpTarget | null>(null);
  const docxReviewJumpNonce = useRef(0);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Track which SettingsPanel tab the user opened from. Topbar gear lands on
  // "agents" (default); sidebar sliders button lands on "preferences" so
  // `.ade` data management is one click away.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("agents");
  const [journalSummary, setJournalSummary] = useState<AdeJournalSummary | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  // When the user clicks an annotation card, we stash the target annotation
  // here so the corresponding viewer can paint a dashed outline around the
  // source text once it mounts. We forward a fresh annotation object (not a
  // reference) on every jump so the viewer's effect re-runs even if the
  // user clicks the same card twice in a row.
  const [pendingJump, setPendingJump] = useState<Annotation | null>(null);
  // Tracks the id of the most recently jumped-to annotation so the right-hand
  // list can briefly highlight its source row. Cleared after a short delay
  // by an effect below.
  const [jumpSourceId, setJumpSourceId] = useState<string | undefined>();
  // Guards against the persist-workspace effect overwriting restored state
  // during initialization. Set to true once the first restore is complete.
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const subProjectParentRef = useRef<ProjectRecord | null>(null);
  stateRef.current = state;
  const journalRef = useRef<AdeJournal | null>(null);
  journalRef.current = journal;

  // Debounced workspace state persistence. Whenever tabs, activeTabId, or
  // inspectorMode change we schedule a save to `.ade/workspace.json` after a
  // short quiet period. This avoids hammering the file on every keystroke
  // while still capturing the state before a potential page close.
  const workspaceSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function persistWorkspace(rootPath: string, currentTabs: WorkspaceTab[], currentActiveTabId: string | undefined, currentInspectorMode: InspectorMode) {
    if (workspaceSaveTimer.current) clearTimeout(workspaceSaveTimer.current);
    workspaceSaveTimer.current = setTimeout(() => {
      const workspace: WorkspaceState = {
        tabs: currentTabs.map((tab) => tab.type === "file"
          ? { id: tab.id, type: "file", projectId: tab.projectId, title: tab.title, relativePath: tab.relativePath }
          : { id: tab.id, type: "agent", projectId: tab.projectId, title: tab.title, sessionId: tab.sessionId, agentId: tab.agentId }),
        activeTabId: currentActiveTabId ?? null,
        inspectorMode: currentInspectorMode,
      };
      void saveWorkspace(rootPath, workspace).catch(() => undefined);
    }, 400);
  }

  const agents = state.agentDefinitions.length ? state.agentDefinitions : defaultAgents;
  const activeRecord = state.projects.find((item) => item.id === activeProjectId);
  const projectTabs = tabs.filter((tab) => tab.projectId === activeProjectId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId && tab.projectId === activeProjectId);
  const activeFileTab = activeTab?.type === "file" ? activeTab : undefined;
  const allFiles = useMemo(() => project ? flattenEntries(project.entries).filter((entry) => entry.kind !== "folder") : [], [project]);
  const agentStatuses = useMemo(() => {
    const map = new Map<string, AgentDetection>();
    detections.forEach((d) => map.set(d.id, d));
    return map;
  }, [detections]);
  const counters: AdeCounters = journal?.counters ?? EMPTY_COUNTERS;
  const annotations = useMemo(() => journal?.annotations ?? [], [journal]);

  // ---------------------------------------------------------------------------
  // Resizable sidebars.
  //
  // Both sidebars expose a draggable handle. The hook owns width state,
  // clamps it to the available container width, persists to localStorage,
   // and exposes a `style` object that sets the CSS variable used by the
  // grid layout. The handle is rendered in the sidebar itself
  // (`.sidebar-resize-handle` for left, `.inspector-resize-handle` for
  // right) so it sits exactly on the boundary with the centre column.
  // ---------------------------------------------------------------------------
  const shellRef = useRef<HTMLElement | null>(null);
  const workspaceBodyRef = useRef<HTMLDivElement | null>(null);
  const leftSidebar = useResizableSidebar({
    defaultWidth: 248,
    minWidth: 180,
    maxWidth: 420,
    side: "left",
    persistKey: "left",
    containerRef: shellRef,
  });
  const rightSidebar = useResizableSidebar({
    defaultWidth: 300,
    minWidth: 200,
    maxWidth: 520,
    side: "right",
    persistKey: "right",
    containerRef: workspaceBodyRef,
    reservedCenter: 280,
  });
  const isResizingAny = leftSidebar.isDragging || rightSidebar.isDragging;

  function commitState(update: (current: PersistedState) => PersistedState) {
    setState((current) => {
      const next = update(current);
      stateRef.current = next;
      void savePersistedState(next).catch((reason) => setError(String(reason)));
      return next;
    });
  }

  // Replace the local journal snapshot with a fresh one from the server.
  // All annotation CRUD paths funnel through here so the UI never diverges
  // from `.ade/journal.json` for more than one render.
  function applyJournal(next: AdeJournal) {
    journalRef.current = next;
    setJournal(next);
  }

  async function refreshJournal(rootPath: string) {
    const [fresh, freshEvents, summary] = await Promise.all([
      loadJournal(rootPath),
      loadJournalEvents(rootPath, 500).catch(() => [] as ActivityEntry[]),
      loadJournalSummary(rootPath).catch(() => null),
    ]);
    applyJournal(fresh);
    setEvents(freshEvents);
    setJournalSummary(summary);
  }

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      try {
        const loaded = await loadPersistedState();
        const cleanedProjects = dedupeProjects(loaded?.projects ?? []);
        const normalized: PersistedState = {
          ...emptyState,
          ...loaded,
          projects: cleanedProjects,
          annotations: [], // legacy field kept empty; annotations now live in `.ade`
          agentDefinitions: loaded?.agentDefinitions?.length ? loaded.agentDefinitions : defaultAgents,
        };
        if (cancelled) return;
        // If dedup removed entries, persist the cleaned list immediately.
        if (cleanedProjects.length !== (loaded?.projects?.length ?? 0)) {
          void savePersistedState(normalized).catch(() => undefined);
        }
        setState(normalized);
        stateRef.current = normalized;
        setDetections(await detectAgents(normalized.agentDefinitions));
        const recent = normalized.projects.find((item) => item.id === normalized.lastProjectId) ?? normalized.projects[0];
        if (recent) {
          try {
            const snapshot = await scanProject(recent.rootPath);
            if (!cancelled) {
              setProject(snapshot);
              setActiveProjectId(recent.id);
              try {
                await refreshJournal(recent.rootPath);
              } catch (reason) {
                if (!cancelled) setError(`项目 .ade 读取失败：${String(reason)}`);
              }
              // Restore workspace state (open file tabs, active tab, inspector
              // mode) from `.ade/workspace.json`. Agent tabs are skipped because
              // their PTY processes don't survive a page refresh; only file
              // tabs are reopened by re-reading the file from disk.
              try {
                const ws = await loadWorkspace(recent.rootPath);
                if (!cancelled && ws && ws.tabs?.length) {
                  const fileEntries = flattenEntries(snapshot.entries).filter((entry) => entry.kind !== "folder");
                  const restoredTabs: WorkspaceTab[] = [];
                  for (const savedTab of ws.tabs) {
                    if (savedTab.type !== "file" || !savedTab.relativePath) continue;
                    // Only restore tabs whose files still exist on disk.
                    const entry = fileEntries.find((entry) => entry.relativePath === savedTab.relativePath);
                    if (!entry) continue;
                    try {
                      const payload = await readProjectFile(snapshot.rootPath, savedTab.relativePath);
                      restoredTabs.push({
                        id: savedTab.id,
                        type: "file",
                        projectId: recent.id,
                        title: entry.name,
                        relativePath: savedTab.relativePath,
                        payload,
                        dirty: false,
                      });
                    } catch { /* file may have been deleted or locked */ }
                  }
                  if (restoredTabs.length) {
                    setTabs(restoredTabs);
                    const stillExists = restoredTabs.some((tab) => tab.id === ws.activeTabId);
                    setActiveTabId(stillExists ? ws.activeTabId! : restoredTabs[0]?.id);
                  }
                  if (ws.inspectorMode === "files" || ws.inspectorMode === "annotations" || ws.inspectorMode === "activity") {
                    setInspectorMode(ws.inspectorMode);
                  }
                }
              } catch { /* workspace.json missing or corrupt — non-fatal */ }
              setWorkspaceReady(true);
            }
          } catch (reason) {
            if (!cancelled) setError(`最近项目无法打开：${String(reason)}`);
          }
        }
      } catch (reason) {
        if (!cancelled) setError(String(reason));
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void initialize();
    return () => { cancelled = true; };
  }, []);

  // Reset the docx review snapshot whenever the user switches files —
  // otherwise the previous doc's tracked changes / comments would still
  // appear under the new doc's annotation panel for a frame.
  useEffect(() => {
    setDocxReview(null);
    setPendingDocxReviewJump(null);
  }, [activeFileTab?.id]);

  // Persist workspace state (open tabs, active tab, inspector mode) to
  // `.ade/workspace.json` whenever it changes, so a page refresh restores
  // the user's working context. Gated by `workspaceReady` to avoid
  // overwriting restored state during initialization.
  useEffect(() => {
    if (!activeRecord || !workspaceReady) return;
    persistWorkspace(activeRecord.rootPath, tabs, activeTabId, inspectorMode);
  }, [tabs, activeTabId, inspectorMode, activeRecord, workspaceReady]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "s" && activeFileTab?.dirty) {
        event.preventDefault();
        void saveActiveFile();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  useEffect(() => {
    if (!agentMenuOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!agentMenuRef.current?.contains(event.target as Node)) {
        setAgentMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [agentMenuOpen]);

  async function registerProject(rootPath: string) {
    setBusy(true);
    setError("");
    try {
      const snapshot = await scanProject(rootPath);
      const current = stateRef.current;
      const existing = current.projects.find((item) => normalizeRootPath(item.rootPath) === normalizeRootPath(snapshot.rootPath));
      const record: ProjectRecord = existing ?? {
        id: crypto.randomUUID(),
        name: snapshot.name,
        rootPath: snapshot.rootPath,
        lastOpenedAt: Date.now(),
      };
      const nextRecord = { ...record, name: snapshot.name, rootPath: snapshot.rootPath, lastOpenedAt: Date.now() };
      commitState((value) => {
        const has = value.projects.some((item) => item.id === nextRecord.id);
        return {
          ...value,
          projects: has
            ? value.projects.map((item) => item.id === nextRecord.id ? nextRecord : item)
            : [...value.projects, nextRecord],
          lastProjectId: nextRecord.id,
        };
      });
      setProject(snapshot);
      setActiveProjectId(nextRecord.id);
      setSelection(undefined);
      // Open / migrate the project's `.ade/` journal. `loadJournal` is
      // idempotent: it creates the directory on first open and migrates
      // older journal versions transparently.
      try {
        await refreshJournal(snapshot.rootPath);
        await logJournalEvent(snapshot.rootPath, "project.open", "user", undefined, { name: snapshot.name });
      } catch (reason) {
        setError(`.ade 读取失败：${String(reason)}`);
      }
      // Restore workspace state (open file tabs, active tab, inspector
      // mode) from `.ade/workspace.json` so switching projects or
      // refreshing the page brings back the user's working context.
      try {
        const ws = await loadWorkspace(snapshot.rootPath);
        if (ws && ws.tabs?.length) {
          const fileEntries = flattenEntries(snapshot.entries).filter((entry) => entry.kind !== "folder");
          const restoredTabs: WorkspaceTab[] = [];
          for (const savedTab of ws.tabs) {
            if (savedTab.type !== "file" || !savedTab.relativePath) continue;
            const entry = fileEntries.find((entry) => entry.relativePath === savedTab.relativePath);
            if (!entry) continue;
            try {
              const payload = await readProjectFile(snapshot.rootPath, savedTab.relativePath);
              restoredTabs.push({
                id: savedTab.id,
                type: "file",
                projectId: nextRecord.id,
                title: entry.name,
                relativePath: savedTab.relativePath,
                payload,
                dirty: false,
              });
            } catch { /* file may have been deleted or locked */ }
          }
          setTabs(restoredTabs);
          const stillExists = restoredTabs.some((tab) => tab.id === ws.activeTabId);
          setActiveTabId(stillExists ? ws.activeTabId! : restoredTabs[0]?.id);
          if (ws.inspectorMode === "files" || ws.inspectorMode === "annotations" || ws.inspectorMode === "activity") {
            setInspectorMode(ws.inspectorMode);
          }
        } else {
          setTabs([]);
          setActiveTabId(undefined);
        }
      } catch { /* workspace.json missing or corrupt — non-fatal */ }
      setWorkspaceReady(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  function chooseProject() {
    setShowFolderPicker(true);
  }

  async function onFolderPicked(rootPath: string) {
    setShowFolderPicker(false);
    subProjectParentRef.current = null;
    await registerProject(rootPath);
  }

  async function openRecent(record: ProjectRecord) {
    await registerProject(record.rootPath);
  }

  function renameProject(record: ProjectRecord) {
    const name = window.prompt("重命名项目", record.name);
    if (!name || name === record.name) return;
    commitState((current) => ({
      ...current,
      projects: current.projects.map((p) => p.id === record.id ? { ...p, name } : p),
    }));
    if (record.id === activeProjectId && project) {
      setProject({ ...project, name });
    }
  }

  function deleteProject(record: ProjectRecord) {
    if (!window.confirm(`确定要移除项目「${record.name}」吗？\n（仅从列表移除，不会删除文件夹）`)) return;
    commitState((current) => {
      const projects = current.projects.filter((p) => p.id !== record.id);
      const lastProjectId = current.lastProjectId === record.id
        ? projects[0]?.id
        : current.lastProjectId;
      return { ...current, projects, lastProjectId };
    });
    setSessions((items) => items.filter((s) => s.projectId !== record.id));
    if (record.id === activeProjectId) {
      const remaining = stateRef.current.projects.filter((p) => p.id !== record.id);
      if (remaining.length > 0) {
        void registerProject(remaining[0].rootPath);
      } else {
        setProject(null);
        setActiveProjectId(undefined);
        setTabs([]);
        setJournal(null);
      }
    }
  }

  function addSubProject(record: ProjectRecord) {
    setShowFolderPicker(true);
    subProjectParentRef.current = record;
  }

  async function openProjectFolderInExplorer(record: ProjectRecord) {
    setError("");
    try {
      await openProjectFolder(record.rootPath);
    } catch (reason) {
      setError(`打开文件管理器失败：${String(reason)}`);
    }
  }

  function acknowledgeSession(session: AgentSession) {
    setSessions((items) => items.map((s) => s.id === session.id ? { ...s, acknowledged: true } : s));
  }

  async function refreshProject() {
    if (activeRecord) await registerProject(activeRecord.rootPath);
  }

  async function openFile(entry: { relativePath: string; kind: string; name: string }) {
    if (!project || !activeProjectId || entry.kind === "folder") return;
    const id = `file:${activeProjectId}:${entry.relativePath}`;
    const existing = tabs.find((tab) => tab.id === id);
    if (existing) {
      setActiveTabId(id);
      setSelection(undefined);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = await readProjectFile(project.rootPath, entry.relativePath);
      const tab: FileTab = {
        id,
        type: "file",
        projectId: activeProjectId,
        title: entry.name,
        relativePath: entry.relativePath,
        payload,
        dirty: false,
      };
      setTabs((items) => [...items, tab]);
      setActiveTabId(id);
      setSelection(undefined);
      // Best-effort activity log: failing to log an open shouldn't block the
      // user from reading the file.
      void logJournalEvent(project.rootPath, "file.open", "user", entry.relativePath, { tabId: id })
        .then(() => loadJournalEvents(project.rootPath, 500))
        .then(setEvents)
        .catch(() => undefined);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  function updateFileContent(tabId: string, content: string) {
    setTabs((items) => items.map((tab) => tab.id === tabId && tab.type === "file"
      ? { ...tab, dirty: content !== tab.payload.content, payload: { ...tab.payload, content } }
      : tab));
  }

  async function saveActiveFile() {
    if (!project || !activeFileTab || activeFileTab.payload.encoding !== "utf8") return;
    setError("");
    try {
      await writeProjectTextFile(project.rootPath, activeFileTab.relativePath, activeFileTab.payload.content);
      setTabs((items) => items.map((tab) => tab.id === activeFileTab.id && tab.type === "file"
        ? { ...tab, dirty: false, payload: { ...tab.payload, modifiedMs: Date.now() } }
        : tab));
      void logJournalEvent(project.rootPath, "file.save", "user", activeFileTab.relativePath, {
        bytes: activeFileTab.payload.content.length,
      })
        .then(() => loadJournalEvents(project.rootPath, 500))
        .then(setEvents)
        .catch(() => undefined);
    } catch (reason) {
      setError(String(reason));
    }
  }

  // Re-read the active file from disk so the user can see whatever an
  // external agent just wrote. Used by the docx toolbar's "刷新" button.
  // We only touch the active file tab (which is always the one rendered
  // into the viewer) and swap in a fresh payload + clear the dirty flag.
  async function refreshFile() {
    if (!project || !activeFileTab) return;
    setError("");
    try {
      const payload = await readProjectFile(project.rootPath, activeFileTab.relativePath);
      setTabs((items) => items.map((tab) => tab.id === activeFileTab.id && tab.type === "file"
        ? { ...tab, dirty: false, payload }
        : tab));
    } catch (reason) {
      setError(String(reason));
      throw reason;
    }
  }

  // Open the right-hand inspector panel on the annotations tab so the
  // user can see all Word-style comments and tracked changes. Mirrors
  // clicking Word's "审阅" ribbon button.
  function openReviewPanel() {
    setSelection(undefined);
    setInspectorMode("annotations");
  }

  async function saveBinaryFile(tabId: string, base64Content: string) {
    const tab = tabs.find((item): item is FileTab => item.id === tabId && item.type === "file");
    if (!project || !tab || tab.payload.encoding !== "base64") return;
    setError("");
    try {
      await writeProjectBinaryFile(project.rootPath, tab.relativePath, base64Content);
      setTabs((items) => items.map((item) => item.id === tabId && item.type === "file"
        ? { ...item, dirty: false, payload: { ...item.payload, content: base64Content, modifiedMs: Date.now() } }
        : item));
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function saveDocx(tabId: string, html: string) {
    const tab = tabs.find((item): item is FileTab => item.id === tabId && item.type === "file");
    // `.doc` files round-trip through the docx converter (server reads them
    // as docx, edits happen in the rich editor, save goes back through
    // html-to-docx → docx → doc via Word COM). `.docm` shares the same path.
    if (!project || !tab || tab.payload.encoding !== "base64" || !tab.relativePath.match(/\.(docx|docm|doc)$/i)) return;
    setError("");
    try {
      await writeProjectDocx(project.rootPath, tab.relativePath, html);
      setTabs((items) => items.map((item) => item.id === tabId && item.type === "file"
        ? { ...item, dirty: false, payload: { ...item.payload, modifiedMs: Date.now() } }
        : item));
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function launchAgent(agent: AgentDefinition): Promise<AgentSession> {
    if (!project || !activeProjectId) throw new Error("请先打开项目");
    const detection = detections.find((item) => item.id === agent.id);
    if (!detection?.available) throw new Error(`未检测到 ${agent.name} 命令`);
    const started = await startAgent(agent, project.rootPath);
    const session: AgentSession = {
      id: started.sessionId,
      agentId: agent.id,
      projectId: activeProjectId,
      title: `${agent.name} ${sessions.filter((item) => item.agentId === agent.id).length + 1}`,
      status: "running",
      phase: "idle",
      acknowledged: false,
    };
    const tab: AgentTab = {
      id: `agent:${session.id}`,
      type: "agent",
      projectId: activeProjectId,
      title: session.title,
      sessionId: session.id,
      agentId: agent.id,
    };
    setSessions((items) => [...items, session]);
    setTabs((items) => [...items, tab]);
    setActiveTabId(tab.id);
    // Persist the session summary in the project journal so it shows up in
    // the activity timeline and survives an app restart.
    void upsertJournalAgent(project.rootPath, {
      id: session.id,
      agentId: session.agentId,
      agentName: agent.name,
      title: session.title,
      status: "running",
      startedAtMs: Date.now(),
      annotationIds: [],
    }).then((fresh) => {
      applyJournal(fresh);
      return loadJournalEvents(project.rootPath, 500);
    }).then(setEvents).catch(() => undefined);
    return session;
  }

  function openSession(session: AgentSession) {
    const id = `agent:${session.id}`;
    if (!tabs.some((tab) => tab.id === id)) {
      setTabs((items) => [...items, {
        id,
        type: "agent",
        projectId: session.projectId,
        title: session.title,
        sessionId: session.id,
        agentId: session.agentId,
      }]);
    }
    setActiveTabId(id);
  }

  async function ensureAgentSession(agentId: string): Promise<AgentSession> {
    const existing = sessions.find((session) => session.projectId === activeProjectId && session.agentId === agentId && session.status === "running");
    if (existing) {
      openSession(existing);
      return existing;
    }
    const agent = agents.find((item) => item.id === agentId);
    if (!agent) throw new Error("Agent 配置不存在");
    return launchAgent(agent);
  }

  async function deliverAnnotation(annotation: Annotation, agentId: string) {
    if (!project) throw new Error("项目未打开");
    try {
      const snapshot = annotation.snapshotId
        ? { id: annotation.snapshotId }
        : await createTaskSnapshot(project.rootPath, [annotation.target.filePath]);
      if (!annotation.snapshotId) {
        await updateJournalAnnotation(project.rootPath, annotation.id, { snapshotId: snapshot.id, status: "open", updatedAt: Date.now() });
      }
      const session = await ensureAgentSession(agentId);
      const readiness = await awaitAgentReady(session.id);
      if (readiness.status === "exited") {
        throw new Error("Agent 进程已结束，未能发送批注");
      }
      await writeAgent(session.id, `${taskPrompt(annotation, project.rootPath)}\r`);
      await updateJournalAnnotation(project.rootPath, annotation.id, { status: "sent", agentId, snapshotId: snapshot.id, updatedAt: Date.now() });
      // Snapshot metadata also gets a journal row so users can find it via
      // the activity feed and restore it independently of the annotation.
      if (!annotation.snapshotId) {
        try {
          const result = await createJournalSnapshot(
            project.rootPath,
            [annotation.target.filePath],
            "annotation",
            annotation.id,
          );
          applyJournal(result.journal);
        } catch { /* non-fatal: the in-memory journal already reflects the snapshot id */ }
      }
      const fresh = await loadJournal(project.rootPath);
      applyJournal(fresh);
      const freshEvents = await loadJournalEvents(project.rootPath, 500).catch(() => [] as ActivityEntry[]);
      setEvents(freshEvents);
      void logJournalEvent(project.rootPath, "annotation.send", "user", annotation.target.filePath, {
        annotationId: annotation.id,
        agentId,
        status: "sent",
      }).catch(() => undefined);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function restoreAnnotationSnapshot(annotation: Annotation) {
    if (!project || !annotation.snapshotId) return;
    await restoreTaskSnapshot(project.rootPath, annotation.snapshotId);
    await refreshProject();
    const openTab = tabs.find((tab): tab is FileTab => tab.type === "file" && tab.projectId === activeProjectId && tab.relativePath === annotation.target.filePath);
    if (openTab) {
      const payload = await readProjectFile(project.rootPath, openTab.relativePath);
      setTabs((items) => items.map((tab) => tab.id === openTab.id && tab.type === "file" ? { ...tab, payload, dirty: false } : tab));
    }
    void logJournalEvent(project.rootPath, "snapshot.restore", "user", annotation.target.filePath, {
      snapshotId: annotation.snapshotId,
      annotationId: annotation.id,
    })
      .then(() => loadJournalEvents(project.rootPath, 500))
      .then(setEvents)
      .catch(() => undefined);
  }

  async function createAnnotation(body: string, priority: Annotation["priority"], agentId?: string) {
    if (!selection || !activeProjectId || !project) throw new Error("请先圈选文件内容");
    const annotation: Annotation = {
      id: crypto.randomUUID(),
      projectId: activeProjectId,
      target: selection,
      body,
      status: "open",
      priority,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const fresh = await appendJournalAnnotation(project.rootPath, annotation);
    applyJournal(fresh);
    void logJournalEvent(project.rootPath, "annotation.create", "user", selection.filePath, {
      annotationId: annotation.id,
      body,
      priority,
    })
      .then(() => loadJournalEvents(project.rootPath, 500))
      .then(setEvents)
      .catch(() => undefined);
    if (agentId) await deliverAnnotation(annotation, agentId);
  }

  // PDF quick-annotation path. Receives the precomputed selection context
  // (pageNumber + rects) from the PdfView floating toolbar and creates an
  // annotation that carries its own positioning data so the highlight stays
  // pinned to the right text even after the user closes the file.
  async function createPdfAnnotation(params: { body: string; priority: Annotation["priority"]; color?: string; pageNumber?: number; rects?: AnnotationRect[]; selectedText: string; agentId?: string }) {
    if (!activeFileTab || !activeProjectId || !project) throw new Error("请先打开一个 PDF 文件");
    const filePath = activeFileTab.relativePath;
    const payload = activeFileTab.payload;
    const sourceText = payload.encoding === "utf8" ? payload.content : "";
    const context = sourceText.length > 0
      ? selectionContext(payload, params.selectedText, sourceText)
      : { filePath, selectedText: params.selectedText, prefix: "", suffix: "", fileModifiedMs: payload.modifiedMs };
    const annotation: Annotation = {
      id: crypto.randomUUID(),
      projectId: activeProjectId,
      target: {
        ...context,
        filePath,
        pageNumber: params.pageNumber,
        rects: params.rects,
        color: params.color,
      },
      body: params.body,
      status: "open",
      priority: params.priority,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const fresh = await appendJournalAnnotation(project.rootPath, annotation);
    applyJournal(fresh);
    void logJournalEvent(project.rootPath, "annotation.create", "user", filePath, {
      annotationId: annotation.id,
      body: params.body,
      priority: params.priority,
      pageNumber: params.pageNumber,
    })
      .then(() => loadJournalEvents(project.rootPath, 500))
      .then(setEvents)
      .catch(() => undefined);
    if (params.agentId) await deliverAnnotation(annotation, params.agentId);
  }

  async function resolveAnnotation(annotation: Annotation) {
    if (!project) return;
    const fresh = await updateJournalAnnotation(project.rootPath, annotation.id, { status: "resolved", updatedAt: Date.now() });
    applyJournal(fresh);
    void logJournalEvent(project.rootPath, "annotation.resolve", "user", annotation.target.filePath, {
      annotationId: annotation.id,
    })
      .then(() => loadJournalEvents(project.rootPath, 500))
      .then(setEvents)
      .catch(() => undefined);
  }

  async function deleteAnnotation(annotation: Annotation) {
    if (!project) return;
    const fresh = await deleteJournalAnnotation(project.rootPath, annotation.id);
    applyJournal(fresh);
    void logJournalEvent(project.rootPath, "annotation.update", "user", annotation.target.filePath, {
      annotationId: annotation.id,
      status: "deleted",
    })
      .then(() => loadJournalEvents(project.rootPath, 500))
      .then(setEvents)
      .catch(() => undefined);
  }

  async function restoreSnapshotById(snapshotId: string) {
    if (!project) return;
    try {
      await restoreJournalSnapshot(project.rootPath, snapshotId);
      await refreshProject();
      void logJournalEvent(project.rootPath, "snapshot.restore", "user", undefined, { snapshotId })
        .then(() => loadJournalEvents(project.rootPath, 500))
        .then(setEvents)
        .catch(() => undefined);
    } catch (reason) {
      setError(String(reason));
    }
  }

  function jumpToFile(relativePath: string) {
    const entry = allFiles.find((item) => item.relativePath === relativePath);
    if (entry) void openFile(entry);
  }

  // -------------------------------------------------------------------------
  // Annotation "jump to source" — when a card in the right-hand list is
  // clicked we want the corresponding viewer to open the file (if it isn't
  // already), scroll to the matching paragraph/page/line, and paint a
  // dashed outline around the original text. We stage the operation via
  // `pendingJump`, which each viewer subscribes to via the FileViewer prop.
  // -------------------------------------------------------------------------
  const pendingJumpRef = useRef<Annotation | null>(null);
  function requestJump(annotation: Annotation) {
    setInspectorMode("annotations");
    setError("");
    const targetPath = annotation.target.filePath;
    const isAlreadyOpen = activeFileTab?.relativePath === targetPath;
    setJumpSourceId(annotation.id);
    if (isAlreadyOpen) {
      // Same file: swap in a fresh reference so the viewer's effect fires
      // even when the user re-clicks the same card (otherwise the prop is
      // referentially stable and the effect would be a no-op).
      pendingJumpRef.current = annotation;
      setPendingJump({ ...annotation });
      return;
    }
    const entry = allFiles.find((item) => item.relativePath === targetPath);
    if (!entry) {
      // The annotation points to a file that no longer exists on disk. Show
      // a friendly hint but don't crash; the user can decide whether to
      // delete the stale annotation from the activity feed.
      setError(`批注指向的文件不存在：${targetPath}`);
      return;
    }
    // Stage the jump before opening so the effect below sees it the moment
    // the file tab flips active.
    pendingJumpRef.current = annotation;
    void openFile(entry);
  }

  // Bridge between requestJump's "open the file, then jump" sequence and
  // the viewer. Once the active file matches the target we hand the
  // staged annotation to the FileViewer. We also pulse the source card so
  // the right list stays readable.
  useEffect(() => {
    const staged = pendingJumpRef.current;
    if (!staged) return;
    if (activeFileTab?.relativePath !== staged.target.filePath) return;
    setPendingJump({ ...staged });
    pendingJumpRef.current = null;
  }, [activeFileTab, tabs]);

  // Drop the source-card highlight after a short pause so the annotation
  // list returns to a calm state once the user's eyes have caught up.
  useEffect(() => {
    if (!jumpSourceId) return;
    const timer = window.setTimeout(() => setJumpSourceId(undefined), 1800);
    return () => window.clearTimeout(timer);
  }, [jumpSourceId]);

  function closeTab(tab: WorkspaceTab) {
    setTabs((items) => items.filter((item) => item.id !== tab.id));
    if (activeTabId === tab.id) {
      const remaining = projectTabs.filter((item) => item.id !== tab.id);
      setActiveTabId(remaining.at(-1)?.id);
    }
  }

  if (!project) {
    return (
      <>
        <Landing
          projects={state.projects}
          agents={agents}
          detections={detections}
          busy={busy}
          error={error || undefined}
          onOpenFolder={() => void chooseProject()}
          onOpenRecent={(record) => void openRecent(record)}
        />
        {showFolderPicker && (
          <FolderPicker
            onSelect={(path) => void onFolderPicked(path)}
            onClose={() => setShowFolderPicker(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
    <main
      className={`ade-shell${isResizingAny ? " is-resizing" : ""}`}
      ref={shellRef}
      style={leftSidebar.style}
    >
      <ProjectSidebar
        projects={state.projects}
        activeProjectId={activeProjectId}
        sessions={sessions}
        agents={agents}
        annotationCount={counters.annotationsOpen}
        onOpenProject={(record) => void openRecent(record)}
        onAddProject={() => void chooseProject()}
        onOpenSession={openSession}
        onAcknowledgeSession={acknowledgeSession}
        onRenameProject={renameProject}
        onDeleteProject={deleteProject}
        onAddSubProject={addSubProject}
        onOpenProjectFolder={(record) => void openProjectFolderInExplorer(record)}
        onOpenPreferences={() => { setSettingsTab("preferences"); setSettingsOpen(true); }}
        onReorderProjects={(reordered) => commitState((current) => ({ ...current, projects: reordered }))}
        resizeHandleProps={leftSidebar.handleProps}
        isResizing={leftSidebar.isDragging}
      />
      <section className="main-workspace">
        <header className="workspace-topbar">
          <div className="project-crumb-host" ref={agentMenuRef}>
            <button className="project-crumb" type="button" onClick={() => setAgentMenuOpen((open) => !open)}>
              <span>{project.name.slice(0, 2).toUpperCase()}</span>
              <strong>{project.name}</strong>
              <ChevronDown size={13} />
            </button>
            {agentMenuOpen && (
              <div className="agent-dropdown">
                <div className="agent-dropdown-heading">调用 Agent</div>
                {agents.map((agent) => {
                  const available = agentStatuses.get(agent.id)?.available ?? false;
                  const resolvedPath = agentStatuses.get(agent.id)?.resolvedPath;
                  const activeSession = sessions.find((s) => s.agentId === agent.id && s.projectId === activeProjectId && s.status === "running");
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      disabled={!available}
                      title={available ? (resolvedPath ? `路径：${resolvedPath}` : `启动 ${agent.name}`) : `未检测到 ${agent.name} 命令`}
                      onClick={() => {
                        setAgentMenuOpen(false);
                        void launchAgent(agent).catch((reason) => setError(String(reason)));
                      }}
                    >
                      <i style={{ background: agent.color }} />
                      <span><strong>{agent.name}</strong><small>{agent.role}{activeSession ? " · 已在运行" : ""}</small></span>
                      {!available && <small className="agent-unavail">未检测到</small>}
                      {available && activeSession && <small className="agent-active-tag">活跃</small>}
                    </button>
                  );
                })}
                {agents.length === 0 && <span className="agent-dropdown-empty">没有配置 Agent</span>}
              </div>
            )}
          </div>
          <div className="workspace-actions">
            {busy && <LoaderCircle className="spin" size={15} />}
            <span className="safe-mode" title="直接事务模式：Agent 直接在真实项目目录写入。任务前创建快照，可恢复变更。"><ShieldCheck size={13} /> 直接事务</span>
            <button type="button" onClick={() => { setSettingsTab("agents"); setSettingsOpen(true); }} title="Agent 配置"><Settings size={15} /></button>
            <button type="button"><MoreHorizontal size={16} /></button>
          </div>
        </header>

        <div className="workspace-body" ref={workspaceBodyRef} style={rightSidebar.style}>
          <section className="tab-workspace">
            <div className="workspace-tabs">
              {projectTabs.map((tab) => (
                <button key={tab.id} type="button" className={tab.id === activeTabId ? "is-active" : ""} onClick={() => setActiveTabId(tab.id)}>
                  {tab.type === "agent" ? <Terminal size={13} /> : <FileText size={13} />}
                  <span>{tab.title}</span>
                  {tab.type === "file" && tab.dirty && <i />}
                  <X size={12} onClick={(event) => { event.stopPropagation(); closeTab(tab); }} />
                </button>
              ))}
            </div>

            {error && <div className="workspace-error"><span>{error}</span><button type="button" onClick={() => setError("")}><X size={13} /></button></div>}

            <div className="workspace-content">
              {!activeTab && (
                <div className="workspace-empty">
                  <FolderOpen size={34} />
                  <h2>{project.name}</h2>
                  <p>从右侧文件树打开文档，或从顶部启动一个 Agent。</p>
                  <div>
                    <span>{allFiles.length} 个文件</span>
                    <span>{detections.filter((item) => item.available).length} 个可用 Agent</span>
                    <span>{counters.annotations} 条批注 · {counters.annotationsOpen} 待处理</span>
                  </div>
                </div>
              )}

              {activeFileTab && (
                <Suspense fallback={<div className="viewer-state"><LoaderCircle className="spin" size={24} /><span>正在加载文件查看器…</span></div>}>
                  <FileViewer
                    key={activeFileTab.id}
                    payload={activeFileTab.payload}
                    content={activeFileTab.payload.content}
                    onContentChange={(content) => updateFileContent(activeFileTab.id, content)}
                    onBinarySave={(base64) => void saveBinaryFile(activeFileTab.id, base64)}
                    onDocxSave={(html) => void saveDocx(activeFileTab.id, html)}
                    onRefreshFile={() => refreshFile()}
                    onOpenReview={openReviewPanel}
                    onSelection={(value) => { setSelection(value); setInspectorMode("annotations"); }}
                    onOpenExternal={() => void openFileExternally(project.rootPath, activeFileTab.relativePath)}
                    annotations={annotations}
                    onCreatePdfAnnotation={(params) => void createPdfAnnotation(params).catch((reason) => setError(String(reason)))}
                    onCreateAnnotation={createAnnotation}
                    pdfAgents={agents.map((agent) => ({
                      id: agent.id,
                      name: agent.name,
                      available: detections.find((d) => d.id === agent.id)?.available ?? false,
                    }))}
                    pendingJump={pendingJump}
                    onJumpMissed={(annotation) => {
                      // Render as a temporary toast via the error slot — the
                      // message disappears the next time the user types
                      // anywhere or clicks another annotation card.
                      setError(`未找到批注正文：${(annotation.target.selectedText ?? "").slice(0, 40)}…`);
                    }}
                    onDocxReviewChange={setDocxReview}
                    pendingDocxReviewJump={pendingDocxReviewJump}
                  />
                </Suspense>
              )}

              {projectTabs.filter((tab): tab is AgentTab => tab.type === "agent").map((tab) => (
                <AgentTerminal
                  key={tab.sessionId}
                  sessionId={tab.sessionId}
                  active={tab.id === activeTabId}
                  onExit={() => {
                    setSessions((items) => items.map((session) => session.id === tab.sessionId ? { ...session, status: "stopped", phase: "notify", acknowledged: false } : session));
                    if (project) {
                      void upsertJournalAgent(project.rootPath, {
                        id: tab.sessionId,
                        agentId: tab.agentId,
                        agentName: agents.find((a) => a.id === tab.agentId)?.name ?? tab.agentId,
                        title: tab.title,
                        status: "stopped",
                        startedAtMs: Date.now(),
                        endedAtMs: Date.now(),
                        annotationIds: [],
                      }).then((fresh) => {
                        applyJournal(fresh);
                        return loadJournalEvents(project.rootPath, 500);
                      }).then(setEvents).catch(() => undefined);
                    }
                  }}
                  // Forward detected token reports straight to the journal
                  // so the data-management panel can show running totals.
                  onTokenUsage={(input, output, note) => {
                    if (!project) return;
                    void recordJournalTokens(project.rootPath, tab.sessionId, input, output, note)
                      .then((fresh) => applyJournal(fresh))
                      .catch(() => undefined);
                  }}
                  onActivityChange={(isActive) => {
                    setSessions((items) => items.map((session) => session.id === tab.sessionId && session.status === "running"
                      ? { ...session, phase: isActive ? "working" : "idle" }
                      : session));
                  }}
                />
              ))}
            </div>
          </section>

          <aside className="workspace-inspector">
            <div
              className={`inspector-resize-handle${rightSidebar.isDragging ? " is-dragging" : ""}`}
              {...rightSidebar.handleProps}
            />
            <div className="inspector-tabs">
              <button type="button" className={inspectorMode === "files" ? "is-active" : ""} onClick={() => setInspectorMode("files")}><Files size={14} /> 文件</button>
              <button type="button" className={inspectorMode === "annotations" ? "is-active" : ""} onClick={() => setInspectorMode("annotations")}><MessageSquareText size={14} /> 批注 <em>{(() => {
                const filePath = activeFileTab?.relativePath;
                const openAde = filePath
                  ? annotations.filter((a) => a.projectId === activeProjectId && a.target.filePath === filePath && a.status !== "resolved").length
                  : counters.annotationsOpen;
                const docxNative = filePath && /\.(docx|docm|doc)$/i.test(filePath) && docxReview
                  ? docxReview.comments.filter((c) => !c.resolved).length + docxReview.changes.length
                  : 0;
                return openAde + docxNative;
              })()}</em></button>
              <button type="button" className={inspectorMode === "activity" ? "is-active" : ""} onClick={() => setInspectorMode("activity")}><History size={14} /> 活动</button>
              <button
                type="button"
                className="inspector-refresh"
                onClick={() => void refreshProject()}
                disabled={!project || busy}
                title={busy ? "正在重新扫描..." : "重新扫描项目目录"}
                aria-label={busy ? "正在重新扫描项目目录" : "重新扫描项目目录"}
              >
                {busy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
              </button>
            </div>
            {inspectorMode === "files" ? (
              <div className="file-inspector">
                <div className="inspector-heading"><div><span>PROJECT FILES</span><strong>{project.name}</strong></div><em>{allFiles.length}</em></div>
                {project.truncated && <div className="tree-warning">项目过大，仅显示前 5000 项。</div>}
                <ProjectFileTree entries={project.entries} activePath={activeFileTab?.relativePath} onOpen={(entry) => void openFile(entry)} />
              </div>
            ) : inspectorMode === "annotations" ? (
              <AnnotationPanel
                projectId={activeProjectId!}
                activeFilePath={activeFileTab?.relativePath}
                selection={selection?.filePath === activeFileTab?.relativePath ? selection : undefined}
                hideComposer={/\.(docx|docm|doc)$/i.test(activeFileTab?.relativePath ?? "")}
                annotations={annotations}
                agents={agents}
                detections={detections}
                onCreate={createAnnotation}
                onSend={deliverAnnotation}
                onResolve={resolveAnnotation}
                onRestore={restoreAnnotationSnapshot}
                onDelete={deleteAnnotation}
                onJump={requestJump}
                jumpSourceId={jumpSourceId}
                docxReview={docxReview}
                onJumpReviewChange={(id) => {
                  docxReviewJumpNonce.current += 1;
                  setInspectorMode("annotations");
                  setPendingDocxReviewJump({ kind: "change", id, nonce: docxReviewJumpNonce.current });
                }}
                onJumpReviewComment={(id) => {
                  docxReviewJumpNonce.current += 1;
                  setInspectorMode("annotations");
                  setPendingDocxReviewJump({ kind: "comment", id, nonce: docxReviewJumpNonce.current });
                }}
              />
            ) : (
              <ActivityFeed
                journal={journal}
                events={events}
                counters={counters}
                agents={agents}
                onJumpToFile={jumpToFile}
                onRestoreSnapshot={(id) => void restoreSnapshotById(id)}
                onDeleteAnnotation={(id) => {
                  const annotation = annotations.find((a) => a.id === id);
                  if (annotation) void deleteAnnotation(annotation);
                }}
              />
            )}
          </aside>
        </div>
        <footer className="statusbar">
          <span><GitCompare size={12} /> {project.rootPath}</span>
          <span>{sessions.filter((item) => item.status === "running").length} 个 Agent 运行中</span>
          <span>{counters.annotationsOpen} 条待处理批注</span>
          <span>.ade/{journal ? `${counters.operations} 条操作记录` : "尚未初始化"}</span>
        </footer>
      </section>
    </main>
    {settingsOpen && (
      <SettingsPanel
        agents={agents}
        detections={detections}
        journal={journal}
        journalSummary={journalSummary}
        projectRootPath={project?.rootPath}
        initialTab={settingsTab}
        onChange={(next) => commitState((current) => ({ ...current, agentDefinitions: next }))}
        onClose={() => setSettingsOpen(false)}
        onDetect={() => void detectAgents(agents).then(setDetections).catch((reason) => setError(String(reason)))}
        onJournalChanged={() => project ? void refreshJournal(project.rootPath) : undefined}
      />
    )}
    {showFolderPicker && (
      <FolderPicker
        onSelect={(path) => void onFolderPicked(path)}
        onClose={() => setShowFolderPicker(false)}
      />
    )}
    </>
  );
}

export default App;