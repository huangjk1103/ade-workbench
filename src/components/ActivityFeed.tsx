import {
  Bot,
  CheckCircle2,
  FileEdit,
  FilePlus,
  FileSearch,
  History,
  MessageSquareText,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ActivityEntry, AdeCounters, AdeJournal, AgentDefinition } from "../types/domain";

interface ActivityFeedProps {
  journal: AdeJournal | null;
  events: ActivityEntry[];
  counters: AdeCounters;
  agents: AgentDefinition[];
  onJumpToFile?: (relativePath: string) => void;
  onRestoreSnapshot?: (snapshotId: string) => Promise<void> | void;
  onDeleteAnnotation?: (annotationId: string) => Promise<void> | void;
}

type Filter = "all" | "annotation" | "edit" | "agent" | "snapshot";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "annotation", label: "批注" },
  { id: "edit", label: "编辑" },
  { id: "agent", label: "Agent" },
  { id: "snapshot", label: "快照" },
];

// Human-readable labels for each event kind. Anything unknown falls back to
// the raw kind so a future schema addition still surfaces instead of being
// silently dropped from the timeline.
const KIND_META: Record<string, { label: string; icon: typeof FileEdit; category: Filter }> = {
  "file.open": { label: "打开文件", icon: FileSearch, category: "edit" },
  "file.edit": { label: "编辑文件", icon: FileEdit, category: "edit" },
  "file.save": { label: "保存文件", icon: FileEdit, category: "edit" },
  "file.create": { label: "新建文件", icon: FilePlus, category: "edit" },
  "file.delete": { label: "删除文件", icon: Trash2, category: "edit" },
  "annotation.create": { label: "新增批注", icon: MessageSquareText, category: "annotation" },
  "annotation.update": { label: "修改批注", icon: MessageSquareText, category: "annotation" },
  "annotation.resolve": { label: "解决批注", icon: CheckCircle2, category: "annotation" },
  "annotation.send": { label: "发送给 Agent", icon: Send, category: "annotation" },
  "agent.start": { label: "启动 Agent", icon: Bot, category: "agent" },
  "agent.exit": { label: "Agent 退出", icon: Bot, category: "agent" },
  "agent.message": { label: "Agent 输出", icon: Sparkles, category: "agent" },
  "snapshot.create": { label: "创建快照", icon: History, category: "snapshot" },
  "snapshot.restore": { label: "恢复快照", icon: History, category: "snapshot" },
  "project.open": { label: "打开项目", icon: FileSearch, category: "all" },
  "project.migrate": { label: "迁移全局批注", icon: History, category: "all" },
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function shortFile(path?: string): string {
  if (!path) return "";
  return path.length > 36 ? `…${path.slice(-35)}` : path;
}

export function ActivityFeed({
  journal,
  events,
  counters,
  agents,
  onJumpToFile,
  onRestoreSnapshot,
  onDeleteAnnotation,
}: ActivityFeedProps) {
  const [filter, setFilter] = useState<Filter>("all");

  // Defensive: if the events list is huge, only render the first 500 after
  // filtering. The backend already truncates to 500 by default, but this
  // protects against a stray large payload.
  const filtered = useMemo(() => {
    if (filter === "all") return events;
    const target = filter;
    return events.filter((entry) => (KIND_META[entry.kind]?.category ?? "all") === target);
  }, [events, filter]);

  // Synthesize rows from the journal itself for items that don't have an
  // explicit event (older annotations created before the events stream was
  // wired). Keeps the timeline consistent across migration.
  const syntheticFromJournal = useMemo(() => buildJournalDerivedEntries(journal), [journal]);

  const merged = useMemo(() => {
    const seen = new Set(events.map((entry) => `${entry.kind}:${entry.id}`));
    const extras = syntheticFromJournal.filter((entry) => !seen.has(`${entry.kind}:${entry.id}`));
    return [...events, ...extras].sort((a, b) => b.ts - a.ts).slice(0, 500);
  }, [events, syntheticFromJournal]);

  // Counts for the sidebar tabs. Sourced from server-side counters when
  // available, otherwise fall back to a quick scan.
  const filterCounts = useMemo(() => {
    const counts: Record<Filter, number> = { all: merged.length, annotation: 0, edit: 0, agent: 0, snapshot: 0 };
    for (const entry of merged) {
      const cat = KIND_META[entry.kind]?.category ?? "all";
      if (cat !== "all") counts[cat] += 1;
    }
    return counts;
  }, [merged]);

  return (
    <div className="activity-feed">
      <div className="inspector-heading">
        <div><span>ACTIVITY</span><strong>项目活动</strong></div>
        <em>{counters.annotationsOpen}</em>
      </div>

      <div className="activity-counters">
        <div className="activity-counter">
          <strong>{counters.annotations}</strong>
          <small>批注总数</small>
        </div>
        <div className="activity-counter">
          <strong>{counters.annotationsOpen}</strong>
          <small>待处理</small>
        </div>
        <div className="activity-counter">
          <strong>{counters.agentSessions}</strong>
          <small>Agent 会话</small>
        </div>
        <div className="activity-counter">
          <strong>{counters.snapshots}</strong>
          <small>快照</small>
        </div>
      </div>

      <div className="activity-filter-row">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={filter === entry.id ? "is-active" : ""}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
            <em>{filterCounts[entry.id]}</em>
          </button>
        ))}
      </div>

      <div className="activity-timeline">
        {merged.length === 0 && (
          <p className="activity-empty">尚无活动。打开文件、圈选内容或启动 Agent 后会在此累积。</p>
        )}
        {merged.map((entry) => (
          <ActivityRow
            key={`${entry.kind}:${entry.id}`}
            entry={entry}
            agents={agents}
            onJumpToFile={onJumpToFile}
            onRestoreSnapshot={onRestoreSnapshot}
            onDeleteAnnotation={onDeleteAnnotation}
          />
        ))}
      </div>
    </div>
  );
}

interface ActivityRowProps {
  entry: ActivityEntry;
  agents: AgentDefinition[];
  onJumpToFile?: (relativePath: string) => void;
  onRestoreSnapshot?: (snapshotId: string) => Promise<void> | void;
  onDeleteAnnotation?: (annotationId: string) => Promise<void> | void;
}

function ActivityRow({ entry, agents, onJumpToFile, onRestoreSnapshot, onDeleteAnnotation }: ActivityRowProps) {
  const meta = KIND_META[entry.kind] ?? { label: entry.kind, icon: Sparkles, category: "all" as const };
  const Icon = meta.icon;
  const file = typeof entry.file === "string" ? entry.file : undefined;
  const agentId = typeof entry.data?.agentId === "string" ? entry.data.agentId : undefined;
  const agent = agentId ? agents.find((item) => item.id === agentId) : undefined;
  const snapshotId = typeof entry.data?.snapshotId === "string" ? entry.data.snapshotId : undefined;
  const annotationId = typeof entry.data?.annotationId === "string" ? entry.data.annotationId : undefined;

  return (
    <article className={`activity-row activity-row--${meta.category}`}>
      <span className="activity-row-icon"><Icon size={13} /></span>
      <div className="activity-row-body">
        <div className="activity-row-headline">
          <strong>{meta.label}</strong>
          {agent && <i style={{ background: agent.color }} />}
          <em>{entry.actor}</em>
          <small>{formatTime(entry.ts)}</small>
        </div>
        {file && (
          <button
            type="button"
            className="activity-row-file"
            onClick={() => onJumpToFile?.(file)}
            title={file}
          >
            {shortFile(file)}
          </button>
        )}
        <ActivityRowDetail entry={entry} />
      </div>
      {(snapshotId && onRestoreSnapshot) && (
        <button type="button" className="activity-row-action" title="恢复快照" onClick={() => onRestoreSnapshot(snapshotId)}>
          <History size={12} />
        </button>
      )}
      {(annotationId && onDeleteAnnotation && entry.kind.startsWith("annotation.")) && (
        <button type="button" className="activity-row-action" title="删除批注" onClick={() => onDeleteAnnotation(annotationId)}>
          <Trash2 size={12} />
        </button>
      )}
    </article>
  );
}

function ActivityRowDetail({ entry }: { entry: ActivityEntry }) {
  const summary = describeData(entry.kind, entry.data);
  if (!summary) return null;
  return <p className="activity-row-detail">{summary}</p>;
}

function describeData(kind: string, data: Record<string, unknown>): string | null {
  if (!data || Object.keys(data).length === 0) return null;
  switch (kind) {
    case "annotation.create":
    case "annotation.update":
      return typeof data.body === "string" ? truncate(data.body, 120) : null;
    case "annotation.send":
      return typeof data.status === "string" ? `状态：${data.status}` : null;
    case "agent.start":
      return typeof data.command === "string" ? `命令：${data.command}` : null;
    case "snapshot.create":
      return Array.isArray(data.files) ? `文件：${(data.files as string[]).join(", ")}` : null;
    case "snapshot.restore":
      return typeof data.snapshotId === "string" ? `快照 ${data.snapshotId}` : null;
    case "file.edit":
    case "file.save":
      return typeof data.bytes === "number" ? `${data.bytes} 字节` : null;
    default:
      // Generic fallback: render the JSON compactly so unknown kinds still
      // surface context instead of looking empty.
      try {
        return truncate(JSON.stringify(data), 140);
      } catch {
        return null;
      }
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Synthesize timeline entries from the journal itself for items that don't
// have a corresponding events.jsonl entry yet (e.g. annotations created by
// an older version of the app). Without this, the timeline would look empty
// for migrated projects.
function buildJournalDerivedEntries(journal: AdeJournal | null): ActivityEntry[] {
  if (!journal) return [];
  const entries: ActivityEntry[] = [];
  for (const annotation of journal.annotations) {
    entries.push({
      id: annotation.id,
      ts: annotation.createdAt,
      kind: "annotation.create",
      actor: "user",
      file: annotation.target.filePath,
      data: {
        annotationId: annotation.id,
        body: annotation.body,
        status: annotation.status,
      },
    });
    if (annotation.updatedAt && annotation.updatedAt !== annotation.createdAt) {
      entries.push({
        id: `${annotation.id}:updated`,
        ts: annotation.updatedAt,
        kind: "annotation.update",
        actor: "user",
        file: annotation.target.filePath,
        data: { annotationId: annotation.id, status: annotation.status },
      });
    }
  }
  for (const session of journal.agentSessions) {
    entries.push({
      id: `${session.id}:start`,
      ts: session.startedAtMs,
      kind: "agent.start",
      actor: session.agentName,
      data: { agentId: session.agentId, command: session.title },
    });
    if (session.endedAtMs) {
      entries.push({
        id: `${session.id}:exit`,
        ts: session.endedAtMs,
        kind: "agent.exit",
        actor: session.agentName,
        data: { agentId: session.agentId },
      });
    }
  }
  for (const snapshot of journal.snapshots) {
    entries.push({
      id: `${snapshot.id}:created`,
      ts: snapshot.createdAtMs,
      kind: "snapshot.create",
      actor: "user",
      data: { snapshotId: snapshot.id, annotationId: snapshot.annotationId, files: snapshot.files },
    });
  }
  return entries;
}

// Used by the landing page for project activity previews; kept here so the
// label map is co-located with the renderer.
export function describeActivityKind(kind: string): string {
  return KIND_META[kind]?.label ?? kind;
}