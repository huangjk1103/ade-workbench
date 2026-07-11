export type ProjectEntryKind =
  | "folder"
  | "markdown"
  | "image"
  | "word"
  | "slides"
  | "sheet"
  | "pdf"
  | "text"
  | "sequence"
  | "annotation"
  | "feature"
  | "variant"
  | "alignment"
  | "structure"
  | "ontology"
  | "binary";

export interface ProjectEntry {
  name: string;
  relativePath: string;
  kind: ProjectEntryKind;
  extension: string;
  size: number;
  modifiedMs: number;
  children: ProjectEntry[];
}

export interface ProjectSnapshot {
  rootPath: string;
  name: string;
  entries: ProjectEntry[];
  truncated: boolean;
}

export interface FilePayload {
  relativePath: string;
  name: string;
  extension: string;
  size: number;
  modifiedMs: number;
  encoding: "utf8" | "base64";
  content: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  lastOpenedAt: number;
}

export interface AgentDefinition {
  id: string;
  name: string;
  command: string;
  args: string[];
  role: string;
  color: string;
}

export interface AgentDetection {
  id: string;
  name: string;
  available: boolean;
  resolvedPath?: string;
}

export interface AgentSession {
  id: string;
  agentId: string;
  projectId: string;
  title: string;
  status: "running" | "stopped";
  /** "working" = agent is producing output; "idle" = running but quiet;
   *  "notify" = agent finished and has unread results. */
  phase: "working" | "idle" | "notify";
  /** True once the user has opened the session tab after a "notify". */
  acknowledged: boolean;
}

export interface AnnotationRect {
  // CSS-pixel rectangle relative to the page viewport at zoom 1. The
  // viewer scales these to the current zoom factor when rendering, so
  // highlights stay aligned with their original text even when the user
  // changes zoom level.
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationTarget {
  filePath: string;
  selectedText: string;
  prefix: string;
  suffix: string;
  fileModifiedMs: number;
  // 1-based position of the selection start. For text / code files this is a
  // line number; for `.docx` it is a paragraph index (textContent concatenates
  // blocks without separators so \n-counting would be meaningless); for `.pdf`
  // leave this undefined and prefer `pageNumber`. The agent prompt consumes
  // these to tell the user / model how to navigate back to the selection.
  lineNumber?: number;
  // Total lines / paragraphs in the source, paired with `lineNumber` so the
  // prompt can phrase "第 42 段 / 共 280 段".
  totalLines?: number;
  // Optional PDF-specific positioning data. `pageNumber` is 1-based to match
  // pdf.js convention; `rects` are absolute within the page viewport.
  pageNumber?: number;
  rects?: AnnotationRect[];
  // Highlight color overrides the priority default when set. Accepts any
  // CSS color value; the highlighter UI surfaces a small palette.
  color?: string;
}

export interface Annotation {
  id: string;
  projectId: string;
  target: AnnotationTarget;
  body: string;
  status: "open" | "sent" | "resolved";
  priority: "normal" | "high";
  agentId?: string;
  snapshotId?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Word review (track changes + comments)
// ---------------------------------------------------------------------------

export interface ReviewAuthor {
  id: string;
  name: string;
  initials: string;
  color: string;
}

export interface TrackChange {
  id: string;
  kind: "insert" | "delete";
  author: string;
  dateMs: number;
  text: string;
}

export interface ReviewReply {
  id: string;
  author: string;
  dateMs: number;
  text: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  dateMs: number;
  text: string;
  replies: ReviewReply[];
  resolved: boolean;
}

export interface DocxReviewModel {
  changes: TrackChange[];
  comments: ReviewComment[];
  authors: ReviewAuthor[];
}

export interface PersistedState {
  version: 1;
  projects: ProjectRecord[];
  annotations: Annotation[];
  agentDefinitions: AgentDefinition[];
  lastProjectId?: string;
}

export interface FileTab {
  id: string;
  type: "file";
  projectId: string;
  title: string;
  relativePath: string;
  payload: FilePayload;
  dirty: boolean;
}

export interface AgentTab {
  id: string;
  type: "agent";
  projectId: string;
  title: string;
  sessionId: string;
  agentId: string;
}

export type WorkspaceTab = FileTab | AgentTab;

export interface TextSelectionContext {
  filePath: string;
  selectedText: string;
  prefix: string;
  suffix: string;
  fileModifiedMs: number;
  // See AnnotationTarget.lineNumber — kept here so viewers can populate it
  // without a separate round-trip through the annotation target.
  lineNumber?: number;
  totalLines?: number;
}

export const defaultAgents: AgentDefinition[] = [
  { id: "hermes", name: "Hermes", command: "hermes", args: [], role: "研究与执行", color: "#d97757" },
  { id: "claude", name: "Claude Code", command: "claude", args: [], role: "文档与代码", color: "#c88a65" },
  { id: "kimi", name: "Kimi Code", command: "kimi", args: [], role: "长上下文分析", color: "#6e8ecb" },
  { id: "codex", name: "Codex", command: "codex", args: [], role: "工程实现", color: "#5ba58c" },
];

// ---------------------------------------------------------------------------
// Activity / journal types
// ---------------------------------------------------------------------------

export type ActivityKind =
  | "file.open"
  | "file.edit"
  | "file.save"
  | "annotation.create"
  | "annotation.update"
  | "annotation.resolve"
  | "annotation.send"
  | "agent.start"
  | "agent.exit"
  | "agent.message"
  | "snapshot.create"
  | "snapshot.restore"
  | "project.open"
  | "project.migrate";

export interface ActivityEntry {
  id: string;
  ts: number;
  kind: ActivityKind | string;
  actor: string;
  file?: string;
  data: Record<string, unknown>;
}

export interface AdeCounters {
  annotations: number;
  annotationsOpen: number;
  annotationsSent: number;
  annotationsResolved: number;
  operations: number;
  agentSessions: number;
  snapshots: number;
}

export interface AdeAgentSummary {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  status: string;
  startedAtMs: number;
  endedAtMs?: number;
  annotationIds: string[];
}

export interface AdeSnapshotMeta {
  id: string;
  createdAtMs: number;
  trigger: string;
  annotationId?: string;
  files: string[];
}

export interface AdeJournalMeta {
  id: string;
  rootPath: string;
  createdAtMs: number;
  lastOpenedAtMs: number;
  schemaVersion: number;
}

export interface AdeJournal {
  meta: AdeJournalMeta;
  counters: AdeCounters;
  annotations: Annotation[];
  agentSessions: AdeAgentSummary[];
  snapshots: AdeSnapshotMeta[];
  // Token usage tracking is optional on disk (older journals pre-date this
  // field). The frontend always normalizes missing values to defaults so
  // downstream code can treat `tokenUsage` as required.
  tokenUsage?: AdeTokenUsage;
}

export interface AdeSessionTokens {
  inputTokens: number;
  outputTokens: number;
  updatedAtMs: number;
  note?: string;
}

export interface AdeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  updatedAtMs: number;
  sessions: Record<string, AdeSessionTokens>;
}

export interface AdeJournalSummary {
  exists: boolean;
  rootPath: string;
  journalPath?: string;
  counters: AdeCounters;
  lastEventAtMs?: number;
  lastOpenedAtMs?: number;
}
