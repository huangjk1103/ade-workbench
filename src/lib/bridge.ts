import type {
  AgentDefinition,
  AgentDetection,
  Annotation,
  FilePayload,
  PersistedState,
  ProjectSnapshot,
} from "../types/domain";

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

const API = "/api";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface BootstrapPayload {
  appVersion: string;
  platform: string;
  executionMode: string;
}

export function bootstrap(): Promise<BootstrapPayload> {
  return api<BootstrapPayload>("/bootstrap");
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface DirListing {
  path: string;
  entries: DirEntry[];
}

export function listDirs(path: string): Promise<DirListing> {
  return api<DirListing>(`/dirs?path=${encodeURIComponent(path)}`);
}

export function scanProject(rootPath: string): Promise<ProjectSnapshot> {
  return api<ProjectSnapshot>("/scan", { rootPath });
}

export function readProjectFile(rootPath: string, relativePath: string): Promise<FilePayload> {
  return api<FilePayload>("/read", { rootPath, relativePath });
}

export function writeProjectTextFile(
  rootPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  return api("/write", { rootPath, relativePath, content });
}

export function writeProjectBinaryFile(
  rootPath: string,
  relativePath: string,
  base64Content: string,
): Promise<void> {
  return api("/write-binary", { rootPath, relativePath, content: base64Content });
}

export function writeProjectDocx(
  rootPath: string,
  relativePath: string,
  html: string,
): Promise<void> {
  return api("/write-docx", { rootPath, relativePath, html });
}

export interface PowerPointTextShape {
  id: number;
  slideIndex: number;
  name: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zOrder: number;
  fontName: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  alignment: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  dataBase64?: string;
  imageExtension?: string;
}

export interface PowerPointSlideModel {
  index: number;
  backgroundColor: string;
  followMasterBackground: boolean;
  shapes: PowerPointTextShape[];
}

export interface PowerPointModel {
  slideWidth: number;
  slideHeight: number;
  slides: PowerPointSlideModel[];
}

export type PowerPointEditOperation =
  | ({ kind: "updateText"; slideIndex: number; shapeId: number } & Partial<Pick<PowerPointTextShape,
    "text" | "x" | "y" | "width" | "height" | "fontName" | "fontSize" | "color" | "bold" | "italic" | "underline" | "alignment"
  >>)
  | ({ kind: "addText"; slideIndex: number } & Pick<PowerPointTextShape,
    "text" | "x" | "y" | "width" | "height" | "fontName" | "fontSize" | "color" | "bold" | "italic" | "underline" | "alignment"
  >)
  | { kind: "addImage"; slideIndex: number; x: number; y: number; width: number; height: number; dataBase64: string; extension: string }
  | { kind: "deleteShape"; slideIndex: number; shapeId: number }
  | { kind: "setBackground"; slideIndex: number; color: string };

export function readPowerPointModel(rootPath: string, relativePath: string): Promise<PowerPointModel> {
  return api<PowerPointModel>("/pptx/model", { rootPath, relativePath });
}

export function editPowerPoint(
  rootPath: string,
  relativePath: string,
  operations: PowerPointEditOperation[],
): Promise<{ ok: boolean; operationCount: number }> {
  return api("/pptx/edit", { rootPath, relativePath, operations });
}

export async function loadPersistedState(): Promise<PersistedState> {
  return api<PersistedState>("/state");
}

export function savePersistedState(state: PersistedState): Promise<void> {
  return api("/state", state);
}

export function detectAgents(agents: AgentDefinition[]): Promise<AgentDetection[]> {
  return api<AgentDetection[]>("/detect-agents", {
    agents: agents.map(({ id, name, command }) => ({ id, name, command })),
  });
}

// ---------------------------------------------------------------------------
// Agent control (HTTP) + event bus (SSE)
// ---------------------------------------------------------------------------

export interface AgentReadinessResult {
  status: "ready" | "timeout" | "exited";
  bytesReceived: number;
}

export interface AgentReadinessOptions {
  stabilizeMs?: number;
  settleCapMs?: number;
  timeoutMs?: number;
}

type AgentBusMessage =
  | { type: "ready" }
  | { type: "output"; sessionId: string; data: string }
  | { type: "exit"; sessionId: string; reason: string };

// A single SSE connection buffers all agent output/exit events per session.
// Terminals subscribe late and still replay early output that would otherwise
// be lost between process start and listener registration.
const outputBuffers = new Map<string, string[]>();
const exitReasons = new Map<string, string>();
const outputListeners = new Map<string, Set<(data: string) => void>>();
const exitListeners = new Map<string, Set<(reason: string) => void>>();
let busSource: EventSource | null = null;
let busReady = false;
interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: number;
}
let readyWaiters: ReadyWaiter[] = [];

function dispatchBus(msg: AgentBusMessage): void {
  if (msg.type === "ready") return;
  if (msg.type === "output") {
    const buffers = outputBuffers.get(msg.sessionId);
    if (buffers) {
      buffers.push(msg.data);
      // Bound memory: keep the most recent chunks so a chatty long-running
      // agent can't grow the buffer without limit or freeze late replay.
      if (buffers.length > 4000) buffers.splice(0, buffers.length - 2000);
    } else {
      outputBuffers.set(msg.sessionId, [msg.data]);
    }
    outputListeners.get(msg.sessionId)?.forEach((handler) => handler(msg.data));
    return;
  }
  exitReasons.set(msg.sessionId, msg.reason);
  exitListeners.get(msg.sessionId)?.forEach((handler) => handler(msg.reason));
}

function startBusIfNeeded(): void {
  if (busSource) return;
  const es = new EventSource("/api/agent/stream");
  busSource = es;
  es.onmessage = (event) => {
    let msg: AgentBusMessage;
    try {
      msg = JSON.parse(event.data) as AgentBusMessage;
    } catch {
      return;
    }
    if (msg.type === "ready") {
      // The server re-emits "ready" on every (re)connect. Re-arm readiness so a
      // startAgent after a drop waits for a live subscription again.
      busReady = true;
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const waiter of waiters) {
        window.clearTimeout(waiter.timer);
        waiter.resolve();
      }
      return;
    }
    dispatchBus(msg);
  };
  es.onerror = () => {
    // EventSource auto-reconnects; mark not-ready until the next "ready".
    busReady = false;
  };
}

function ensureAgentEventBus(): Promise<void> {
  if (busReady) return Promise.resolve();
  startBusIfNeeded();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      readyWaiters = readyWaiters.filter((waiter) => waiter.timer !== timer);
      reject(new Error("连接 Agent 事件流超时，请确认本地服务已启动"));
    }, 15000);
    readyWaiters.push({ resolve, reject, timer });
  });
}

export interface AgentSessionHandlers {
  onOutput?: (data: string) => void;
  onExit?: (reason: string) => void;
}

export function subscribeAgentSession(
  sessionId: string,
  handlers: AgentSessionHandlers,
): () => void {
  // Register live listeners first (synchronously), then replay buffered events.
  // Because JS is single-threaded, no bus callback can run between these
  // statements, so nothing is duplicated or dropped across the subscribe tick.
  if (handlers.onOutput) {
    let set = outputListeners.get(sessionId);
    if (!set) { set = new Set(); outputListeners.set(sessionId, set); }
    set.add(handlers.onOutput);
  }
  if (handlers.onExit) {
    let set = exitListeners.get(sessionId);
    if (!set) { set = new Set(); exitListeners.set(sessionId, set); }
    set.add(handlers.onExit);
  }

  const buffered = outputBuffers.get(sessionId);
  if (buffered && handlers.onOutput) handlers.onOutput(buffered.join(""));
  const reason = exitReasons.get(sessionId);
  if (reason && handlers.onExit) handlers.onExit(reason);

  return () => {
    if (handlers.onOutput) outputListeners.get(sessionId)?.delete(handlers.onOutput);
    if (handlers.onExit) exitListeners.get(sessionId)?.delete(handlers.onExit);
  };
}

export function awaitAgentReady(
  sessionId: string,
  options: AgentReadinessOptions = {},
): Promise<AgentReadinessResult> {
  const stabilizeMs = options.stabilizeMs ?? 200;
  const settleCapMs = options.settleCapMs ?? 1500;
  const timeoutMs = options.timeoutMs ?? 6000;

  return new Promise<AgentReadinessResult>((resolve) => {
    let bytesReceived = 0;
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => finish("timeout"), timeoutMs);
    let unsub: () => void = () => {};

    function finish(status: AgentReadinessResult["status"]): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (quietTimer) clearTimeout(quietTimer);
      if (capTimer) clearTimeout(capTimer);
      unsub();
      resolve({ status, bytesReceived });
    }

    unsub = subscribeAgentSession(sessionId, {
      onOutput: (data) => {
        bytesReceived += data.length;
        if (!capTimer) capTimer = setTimeout(() => finish("ready"), settleCapMs);
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish("ready"), stabilizeMs);
      },
      onExit: () => finish("exited"),
    });
    if (settled) unsub();
  });
}

export async function startAgent(
  agent: AgentDefinition,
  cwd: string,
  cols = 120,
  rows = 32,
): Promise<{ sessionId: string; agentId: string }> {
  // Ensure the SSE bus is connected and the server has subscribed before we
  // start the agent, otherwise output produced between process start and the
  // subscription would be lost.
  await ensureAgentEventBus();
  return api<{ sessionId: string; agentId: string }>("/agent/start", {
    agentId: agent.id,
    command: agent.command,
    args: agent.args,
    cwd,
    cols,
    rows,
  });
}

export function writeAgent(sessionId: string, data: string): Promise<void> {
  return api("/agent/write", { sessionId, data });
}

export function resizeAgent(sessionId: string, cols: number, rows: number): Promise<void> {
  return api("/agent/resize", { sessionId, cols, rows });
}

export function stopAgent(sessionId: string): Promise<void> {
  return api("/agent/stop", { sessionId });
}

// ---------------------------------------------------------------------------
// Snapshots + misc
// ---------------------------------------------------------------------------

export function createTaskSnapshot(
  rootPath: string,
  relativePaths: string[],
): Promise<{ id: string; files: string[] }> {
  return api("/snapshot/create", { rootPath, relativePaths });
}

export function restoreTaskSnapshot(
  rootPath: string,
  snapshotId: string,
): Promise<string[]> {
  return api<{ files: string[] }>("/snapshot/restore", { rootPath, snapshotId }).then((r) => r.files);
}

export async function openFileExternally(rootPath: string, relativePath: string): Promise<void> {
  // Delegated to the Rust `open` command on the server: it validates the path
  // is inside the project, strips the Windows `\\?\` verbatim prefix, and
  // invokes the system default application via ShellExecuteW.
  await api("/open", { rootPath, relativePath });
}

export async function openProjectFolder(rootPath: string): Promise<void> {
  // Opens the project's root directory in the platform file manager
  // (Explorer / Finder / XDG default). The server canonicalizes the path,
  // confirms it is a directory, and then hands it to the `open` crate.
  await api("/open-folder", { rootPath });
}

export function decodeBase64(content: string): ArrayBuffer {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

// Kept referenced so the SSE source is reachable for diagnostics / teardown.
export { busSource as _agentEventSource };

// ---------------------------------------------------------------------------
// Per-project `.ade/` journal
// ---------------------------------------------------------------------------
//
// Each open project owns a `.ade/` directory at its root. All annotations,
// agent sessions, snapshots, and an append-only event stream live there, so
// the project's history follows it when copied/moved/zipped instead of being
// trapped in a global state file.

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
}

export interface AdeJournalSummary {
  exists: boolean;
  rootPath: string;
  journalPath?: string;
  counters: AdeCounters;
  lastEventAtMs?: number;
  lastOpenedAtMs?: number;
}

export interface AdeEvent {
  id: string;
  ts: number;
  kind: string;
  actor: string;
  file?: string;
  data: Record<string, unknown>;
}

export interface AdeJournalResult<T = AdeJournal> {
  journal: T;
}

function queryWith(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  });
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export function loadJournal(rootPath: string): Promise<AdeJournal> {
  return api<AdeJournal>(`/journal/load${queryWith({ rootPath })}`);
}

export function loadJournalSummary(rootPath: string): Promise<AdeJournalSummary> {
  return api<AdeJournalSummary>(`/journal/summary${queryWith({ rootPath })}`);
}

export async function loadJournalEvents(rootPath: string, limit = 500): Promise<AdeEvent[]> {
  const res = await api<unknown>(`/journal/events${queryWith({ rootPath, limit })}`);
  return Array.isArray(res) ? res : Array.isArray((res as Record<string, unknown>)?.events) ? (res as Record<string, unknown>).events as AdeEvent[] : [];
}

export function logJournalEvent(
  rootPath: string,
  kind: string,
  actor: string,
  file?: string,
  data: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return api<{ id: string }>(`/journal/log-event`, { rootPath, kind, actor, file, data });
}

export function appendJournalAnnotation(rootPath: string, annotation: Annotation): Promise<AdeJournal> {
  return api<AdeJournal>(`/journal/append-annotation`, { rootPath, annotation });
}

export function updateJournalAnnotation(
  rootPath: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<AdeJournal> {
  return api<AdeJournal>(`/journal/update-annotation`, { rootPath, id, patch });
}

export function deleteJournalAnnotation(rootPath: string, id: string): Promise<AdeJournal> {
  return api<AdeJournal>(`/journal/delete-annotation`, { rootPath, id });
}

export function upsertJournalAgent(rootPath: string, session: AdeAgentSummary): Promise<AdeJournal> {
  return api<AdeJournal>(`/journal/upsert-agent`, { rootPath, session });
}

export interface CreateJournalSnapshotResult {
  snapshotId: string;
  files: string[];
  journal: AdeJournal;
}

export function createJournalSnapshot(
  rootPath: string,
  relativePaths: string[],
  trigger: string,
  annotationId?: string,
): Promise<CreateJournalSnapshotResult> {
  return api<CreateJournalSnapshotResult>(`/journal/snapshot-create`, {
    rootPath,
    relativePaths,
    trigger,
    annotationId,
  });
}

export function restoreJournalSnapshot(rootPath: string, snapshotId: string): Promise<{ files: string[] }> {
  return api<{ files: string[] }>(`/journal/snapshot-restore`, { rootPath, snapshotId });
}

// `.ade` data management endpoints. Kept separate from journal CRUD so the
// preferences panel can talk to them without loading the whole journal.
export function openJournalFolder(rootPath: string): Promise<{ path: string }> {
  return api<{ path: string }>(`/journal/open-folder`, { rootPath });
}

export function exportJournal(rootPath: string, destination: string): Promise<{ source: string; destination: string }> {
  return api<{ source: string; destination: string }>(`/journal/export`, { rootPath, destination });
}

export function importJournal(rootPath: string, source: string): Promise<{ importedFrom: string; backup?: string }> {
  return api<{ importedFrom: string; backup?: string }>(`/journal/import`, { rootPath, source });
}

export interface CompactJournalResult {
  kept: number;
  archived: number;
  archive?: string;
}

export function compactJournalEvents(rootPath: string, keepRecent: number): Promise<CompactJournalResult> {
  return api<CompactJournalResult>(`/journal/compact-events`, { rootPath, keepRecent });
}

// Token usage tracking — called by AgentTerminal when it matches a token
// report line in the agent's output. The server updates running totals
// keyed by session id.
export function recordJournalTokens(
  rootPath: string,
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  note?: string,
): Promise<AdeJournal> {
  return api<AdeJournal>(`/journal/record-tokens`, {
    rootPath,
    sessionId,
    inputTokens,
    outputTokens,
    note,
  });
}

// ---------------------------------------------------------------------------
// Workspace state persistence
// ---------------------------------------------------------------------------

export interface WorkspaceState {
  tabs: Array<{
    id: string;
    type: "file" | "agent";
    projectId: string;
    title: string;
    relativePath?: string;
    sessionId?: string;
    agentId?: string;
  }>;
  activeTabId: string | null;
  inspectorMode: string;
}

export function loadWorkspace(rootPath: string): Promise<WorkspaceState | null> {
  return api<WorkspaceState | null>(`/journal/workspace${queryWith({ rootPath })}`);
}

export function saveWorkspace(rootPath: string, workspace: WorkspaceState): Promise<void> {
  return api(`/journal/workspace`, { rootPath, workspace });
}
