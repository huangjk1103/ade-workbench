import {
  Bot,
  Compass,
  Download,
  Folder,
  FolderOpen,
  FolderSearch,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  compactJournalEvents,
  exportJournal,
  importJournal,
  openJournalFolder,
} from "../lib/bridge";
import { FolderPicker } from "./FolderPicker";
import type { AdeJournal, AdeJournalSummary, AgentDefinition, AgentDetection } from "../types/domain";
import {
  applyBackgroundStyle,
  BACKGROUND_STYLES,
  loadPreferences,
  savePreferences,
  type Preferences,
} from "../lib/preferences";

interface SettingsPanelProps {
  agents: AgentDefinition[];
  detections: AgentDetection[];
  journal?: AdeJournal | null;
  journalSummary?: AdeJournalSummary | null;
  // When the user opens settings from the project context, this points at
  // the active project's rootPath so `.ade` data actions have a target.
  // Settings opened from the landing page pass `undefined` and disables
  // the data tab.
  projectRootPath?: string;
  initialTab?: SettingsTab;
  onChange: (agents: AgentDefinition[]) => void;
  onClose: () => void;
  onDetect?: () => void;
  onJournalChanged?: () => void;
}

export type SettingsTab = "agents" | "preferences";

const presetColors = ["#d97757", "#c88a65", "#6e8ecb", "#5ba58c", "#9c7ca7", "#b37965", "#d6a866", "#75b98b"];

export function SettingsPanel({
  agents,
  detections,
  journal,
  journalSummary,
  projectRootPath,
  initialTab = "agents",
  onChange,
  onClose,
  onDetect,
  onJournalChanged,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [draft, setDraft] = useState<AgentDefinition[]>(() => JSON.parse(JSON.stringify(agents)) as AgentDefinition[]);
  const [prefs, setPrefs] = useState<Preferences>(loadPreferences);
  const [busyAction, setBusyAction] = useState<string>("");
  const [actionMessage, setActionMessage] = useState<string>("");

  // The tab prop is captured once at mount time. If the parent reopens with
  // a different initial tab (e.g. user clicks the sidebar Settings2 button
  // while the panel was previously on "agents"), honor it.
  useEffect(() => { setTab(initialTab); }, [initialTab]);

  const detectionMap = useMemo(() => {
    const map = new Map<string, AgentDetection>();
    detections.forEach((d) => map.set(d.id, d));
    return map;
  }, [detections]);

  function updateAgent(index: number, patch: Partial<AgentDefinition>) {
    setDraft((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item));
  }

  function updateArgs(index: number, value: string) {
    const args = value.split("\n").map((s) => s.trim()).filter(Boolean);
    setDraft((items) => items.map((item, i) => i === index ? { ...item, args } : item));
  }

  function removeAgent(index: number) {
    setDraft((items) => items.filter((_, i) => i !== index));
  }

  function addAgent() {
    const id = `agent-${draft.length + 1}`;
    setDraft((items) => [...items, {
      id,
      name: `Agent ${draft.length + 1}`,
      command: "",
      args: [],
      role: "自定义",
      color: presetColors[draft.length % presetColors.length],
    }]);
  }

  function saveAgents() {
    onChange(draft);
    savePreferences(prefs);
    onDetect?.();
    onClose();
  }

  function updatePrefs(patch: Partial<Preferences>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePreferences(next);
    // Mirror the background style onto <html> immediately so the user sees
    // the change behind the (translucent) settings overlay without a reload.
    if (patch.backgroundStyle) applyBackgroundStyle(patch.backgroundStyle);
  }

  async function handleAction(label: string, fn: () => Promise<void>) {
    setBusyAction(label);
    setActionMessage("");
    try {
      await fn();
      onJournalChanged?.();
    } catch (reason) {
      setActionMessage(`失败：${String(reason)}`);
    } finally {
      setBusyAction("");
    }
  }

  return (
    <div className="settings-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="settings-panel">
        <div className="settings-head">
          <div className="settings-tabs">
            <button type="button" className={tab === "agents" ? "is-active" : ""} onClick={() => setTab("agents")}>
              <Bot size={13} /> Agent 配置
            </button>
            <button type="button" className={tab === "preferences" ? "is-active" : ""} onClick={() => setTab("preferences")}>
              <Sparkles size={13} /> 偏好与数据
            </button>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <div className="settings-body">
          {tab === "agents" ? (
            <AgentConfigSection
              draft={draft}
              detectionMap={detectionMap}
              onUpdate={updateAgent}
              onUpdateArgs={updateArgs}
              onRemove={removeAgent}
              onAdd={addAgent}
            />
          ) : (
            <PreferencesSection
              prefs={prefs}
              onChange={updatePrefs}
              projectRootPath={projectRootPath}
              journal={journal}
              journalSummary={journalSummary}
              busyAction={busyAction}
              actionMessage={actionMessage}
              onAction={handleAction}
            />
          )}
        </div>
        {tab === "agents" && (
          <div className="settings-foot">
            <button type="button" onClick={onClose}>取消</button>
            <button type="button" className="is-primary" onClick={saveAgents}>保存</button>
          </div>
        )}
        {tab === "preferences" && (
          <div className="settings-foot">
            <span className="settings-foot-hint">偏好已自动保存到本地</span>
            <button type="button" className="is-primary" onClick={onClose}>完成</button>
          </div>
        )}
      </div>
    </div>
  );
}

interface AgentConfigSectionProps {
  draft: AgentDefinition[];
  detectionMap: Map<string, AgentDetection>;
  onUpdate: (index: number, patch: Partial<AgentDefinition>) => void;
  onUpdateArgs: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}

function AgentConfigSection({ draft, detectionMap, onUpdate, onUpdateArgs, onRemove, onAdd }: AgentConfigSectionProps) {
  return (
    <div className="settings-section">
      <h3>Agent 配置</h3>
      <p className="settings-hint">配置本地 Agent 命令，保存后会重新检测可用性。未检测到的 Agent 仍可在菜单中查看，但无法启动。</p>
      <div className="agent-config-list">
        {draft.map((agent, index) => {
          const detection = detectionMap.get(agent.id);
          return (
            <div key={index} className="agent-config-row">
              <div className="agent-config-fields">
                <input
                  value={agent.name}
                  onChange={(e) => onUpdate(index, { name: e.target.value })}
                  placeholder="显示名称"
                />
                <input
                  value={agent.command}
                  onChange={(e) => onUpdate(index, { command: e.target.value })}
                  placeholder="命令"
                />
                <textarea
                  value={agent.args.join("\n")}
                  onChange={(e) => onUpdateArgs(index, e.target.value)}
                  placeholder="参数（每行一个）"
                  rows={2}
                />
                <div className="agent-config-meta">
                  <input
                    value={agent.id}
                    onChange={(e) => onUpdate(index, { id: e.target.value })}
                    placeholder="ID"
                  />
                  <div className="color-presets">
                    {presetColors.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={agent.color === color ? "is-active" : ""}
                        style={{ background: color }}
                        onClick={() => onUpdate(index, { color })}
                        aria-label={`选择颜色 ${color}`}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div className="agent-config-status">
                <span className={detection?.available ? "is-ready" : ""}>
                  {detection?.available ? "可用" : (detection ? `未检测到` : "待检测")}
                </span>
                <button type="button" onClick={() => onRemove(index)} aria-label="删除"><Trash2 size={14} /></button>
              </div>
            </div>
          );
        })}
      </div>
      <button type="button" className="settings-add-agent" onClick={onAdd}><Bot size={14} /> 添加 Agent</button>
    </div>
  );
}

interface PreferencesSectionProps {
  prefs: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
  projectRootPath?: string;
  journal?: AdeJournal | null;
  journalSummary?: AdeJournalSummary | null;
  busyAction: string;
  actionMessage: string;
  onAction: (label: string, fn: () => Promise<void>) => void;
}

function PreferencesSection({ prefs, onChange, projectRootPath, journal, journalSummary, busyAction, actionMessage, onAction }: PreferencesSectionProps) {
  return (
    <div className="settings-section">
      <h3>界面</h3>
      <div className="pref-grid">
        <label className="pref-row">
          <span>主题</span>
          <select value={prefs.theme} onChange={(event) => onChange({ theme: event.target.value as Preferences["theme"] })}>
            <option value="dark">暗色</option>
            <option value="light">亮色</option>
            <option value="system">跟随系统</option>
          </select>
        </label>
        <label className="pref-row">
          <span>密度</span>
          <select value={prefs.density} onChange={(event) => onChange({ density: event.target.value as Preferences["density"] })}>
            <option value="compact">紧凑</option>
            <option value="standard">标准</option>
            <option value="comfortable">宽松</option>
          </select>
        </label>
        <label className="pref-row">
          <span>侧边栏默认展开</span>
          <input
            type="checkbox"
            checked={prefs.sidebarExpandedByDefault}
            onChange={(event) => onChange({ sidebarExpandedByDefault: event.target.checked })}
          />
        </label>
      </div>

      <div className="pref-row pref-row--block">
        <span>背景风格</span>
        <div className="bg-style-grid">
          {BACKGROUND_STYLES.map((style) => (
            <button
              key={style.value}
              type="button"
              className={"bg-style-option" + (prefs.backgroundStyle === style.value ? " is-active" : "")}
              onClick={() => onChange({ backgroundStyle: style.value })}
              title={style.hint}
              aria-pressed={prefs.backgroundStyle === style.value}
            >
              <span className="bg-style-preview" data-style={style.value} />
              <span className="bg-style-name">{style.label}</span>
            </button>
          ))}
        </div>
      </div>

      <h3>行为</h3>
      <div className="pref-grid">
        <label className="pref-row">
          <span>自动保存（毫秒）</span>
          <input
            type="number"
            min={0}
            step={250}
            value={prefs.autoSaveMs}
            onChange={(event) => onChange({ autoSaveMs: Math.max(0, Number(event.target.value) || 0) })}
          />
        </label>
        <label className="pref-row">
          <span>发送批注前自动快照</span>
          <input
            type="checkbox"
            checked={prefs.autoSnapshotOnSend}
            onChange={(event) => onChange({ autoSnapshotOnSend: event.target.checked })}
          />
        </label>
        <label className="pref-row">
          <span>events.jsonl 保留条数</span>
          <input
            type="number"
            min={100}
            step={100}
            value={prefs.journalKeepRecent}
            onChange={(event) => onChange({ journalKeepRecent: Math.max(100, Number(event.target.value) || 100) })}
          />
        </label>
      </div>

      <h3><Compass size={13} /> .ade 数据管理</h3>
      <p className="settings-hint">每个项目自带一个 <code>.ade</code> 目录，记录批注、Agent 会话、文件快照与事件流。下面这些操作只影响当前项目。</p>
      {!projectRootPath ? (
        <p className="settings-hint settings-hint--muted">打开一个项目后再来管理它的 .ade 数据。</p>
      ) : (
        <DataManagementPanel
          projectRootPath={projectRootPath}
          journal={journal}
          journalSummary={journalSummary}
          prefs={prefs}
          busyAction={busyAction}
          actionMessage={actionMessage}
          onAction={onAction}
        />
      )}
    </div>
  );
}

interface DataManagementPanelProps {
  projectRootPath: string;
  journal?: AdeJournal | null;
  journalSummary?: AdeJournalSummary | null;
  prefs: Preferences;
  busyAction: string;
  actionMessage: string;
  onAction: (label: string, fn: () => Promise<void>) => void;
}

function DataManagementPanel({ projectRootPath, journal, journalSummary, prefs, busyAction, actionMessage, onAction }: DataManagementPanelProps) {
  const counters = journal?.counters;
  const tokens = journal?.tokenUsage;
  // Display path in POSIX form so we never have to worry about the
  // verbatim prefix (`\\?\`) showing up on Windows. `sanitizePath` also
  // strips any verbatim prefix that slipped through from the server.
  const eventsPath = sanitizePath(`${projectRootPath}/.ade/events.jsonl`);
  const exportInputId = `pref-export-${useStableId()}`;
  const importInputId = `pref-import-${useStableId()}`;
  // Persist the user's chosen paths across re-renders so the "浏览…"
  // button can pre-seed the picker with their previous pick. The picker
  // also falls back to the project root so the user can browse from a
  // familiar starting point on first use.
  const [exportPath, setExportPath] = useState("");
  const [importPath, setImportPath] = useState("");
  const [exportPickerOpen, setExportPickerOpen] = useState(false);
  const [importPickerOpen, setImportPickerOpen] = useState(false);

  async function handleOpenFolder() {
    await onAction("open", async () => {
      await openJournalFolder(projectRootPath);
    });
  }

  async function handleExport(destination: string) {
    if (!destination) return;
    await onAction("export", async () => {
      const result = await exportJournal(projectRootPath, destination);
      window.alert(`已导出到：${result.destination}`);
    });
  }

  async function handleImport(source: string) {
    if (!source) return;
    await onAction("import", async () => {
      const result = await importJournal(projectRootPath, source);
      const backupNote = result.backup ? `\n原数据已备份到：${result.backup}` : "";
      window.alert(`导入完成：${result.importedFrom}${backupNote}`);
    });
  }

  async function handleCompact() {
    await onAction("compact", async () => {
      const result = await compactJournalEvents(projectRootPath, prefs.journalKeepRecent);
      window.alert(`保留 ${result.kept} 条；归档 ${result.archived} 条${result.archive ? ` → ${result.archive}` : ""}`);
    });
  }

  return (
    <div className="data-mgmt">
      <div className="data-mgmt-summary">
        <div>
          <span>批注</span>
          <strong>{counters?.annotations ?? 0}</strong>
          <small>{counters?.annotationsOpen ?? 0} 待处理</small>
        </div>
        <div>
          <span>Agent 会话</span>
          <strong>{counters?.agentSessions ?? 0}</strong>
        </div>
        <div>
          <span>快照</span>
          <strong>{counters?.snapshots ?? 0}</strong>
        </div>
        <div className="data-mgmt-token-cell">
          <span>Token 消耗</span>
          <strong>{formatTokens(tokens?.inputTokens ?? 0, tokens?.outputTokens ?? 0)}</strong>
          <small>
            in {(tokens?.inputTokens ?? 0).toLocaleString("en-US")} · out {(tokens?.outputTokens ?? 0).toLocaleString("en-US")}
          </small>
        </div>
        <div className="data-mgmt-path-cell">
          <span>事件流位置</span>
          <strong title={eventsPath}>{shorten(eventsPath, 36)}</strong>
          <small>{journalSummary?.lastEventAtMs ? new Date(journalSummary.lastEventAtMs).toLocaleString("zh-CN") : "暂无事件"}</small>
        </div>
      </div>

      <div className="data-mgmt-actions">
        <button type="button" onClick={handleOpenFolder} disabled={busyAction === "open"}>
          <FolderOpen size={13} /> 在文件管理器中打开
        </button>
        <div className="data-mgmt-row">
          <label htmlFor={exportInputId} className="data-mgmt-action-label">
            <Download size={13} /> 导出 .ade 到…
            <input
              id={exportInputId}
              type="text"
              placeholder="目标目录绝对路径（不存在会自动创建）"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleExport((event.target as HTMLInputElement).value.trim());
                }
              }}
            />
          </label>
          <button
            type="button"
            className="data-mgmt-browse"
            onClick={() => setExportPickerOpen(true)}
            title="选择导出目录"
            aria-label="选择导出目录"
          >
            <FolderSearch size={13} /> 浏览…
          </button>
          <button
            type="button"
            className="data-mgmt-confirm"
            disabled={busyAction === "export" || !exportPath.trim()}
            onClick={() => void handleExport(exportPath.trim())}
            title="导出 .ade 目录到指定位置"
          >
            <Download size={13} /> {busyAction === "export" ? "正在导出…" : "开始导出"}
          </button>
        </div>
        <div className="data-mgmt-row">
          <label htmlFor={importInputId} className="data-mgmt-action-label">
            <Upload size={13} /> 从… 导入 .ade
            <input
              id={importInputId}
              type="text"
              placeholder=".ade 目录或其父目录绝对路径"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleImport((event.target as HTMLInputElement).value.trim());
                }
              }}
            />
          </label>
          <button
            type="button"
            className="data-mgmt-browse"
            onClick={() => setImportPickerOpen(true)}
            title="选择 .ade 目录或其父目录"
            aria-label="选择 .ade 目录或其父目录"
          >
            <FolderSearch size={13} /> 浏览…
          </button>
          <button
            type="button"
            className="data-mgmt-confirm"
            disabled={busyAction === "import" || !importPath.trim()}
            onClick={() => void handleImport(importPath.trim())}
            title="从指定位置导入 .ade"
          >
            <Upload size={13} /> {busyAction === "import" ? "正在导入…" : "开始导入"}
          </button>
        </div>
        <button type="button" onClick={handleCompact} disabled={busyAction === "compact"} title="把较早的事件归档到 events-archive-<ts>.jsonl">
          <Folder size={13} /> 整理事件流（保留最近 {prefs.journalKeepRecent} 条）
        </button>
      </div>

      {exportPickerOpen && (
        <FolderPicker
          title="选择导出 .ade 的目标目录"
          initialPath={exportPath || projectRootPath || ""}
          onSelect={(path) => { setExportPath(path); setExportPickerOpen(false); }}
          onClose={() => setExportPickerOpen(false)}
        />
      )}
      {importPickerOpen && (
        <FolderPicker
          title="选择 .ade 目录或其父目录"
          initialPath={importPath || projectRootPath || ""}
          onSelect={(path) => { setImportPath(path); setImportPickerOpen(false); }}
          onClose={() => setImportPickerOpen(false)}
        />
      )}

      {actionMessage && <div className="inline-error">{actionMessage}</div>}

      <p className="settings-hint settings-hint--muted">
        导入会先把现有 <code>.ade</code> 改名为 <code>.ade.bak-&lt;ts&gt;</code>，避免误覆盖。
      </p>
    </div>
  );
}

// `useId` would be cleaner but the React 19 typings in this project don't
// always expose it consistently; a tiny counter is enough to keep label
// associations unique across multiple panels.
let stableIdCounter = 0;
function useStableId() {
  return useMemo(() => `pref-${++stableIdCounter}`, []);
}

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  // Use ASCII ellipsis (...) rather than `…` (U+2026) — some font stacks
  // on Windows fall back to a glyph that renders as garbage when combined
  // with backslashes, which is what produced the "乱码" feedback.
  return `...${text.slice(-max + 3)}`;
}

// Strip any leftover Windows verbatim prefix and normalise separators so
// the path is always safe to embed in DOM text / `title` attributes.
// `sanitizePath` is intentionally permissive: anything that looks like
// a verbatim prefix (`\\?\` or `//?/`) is removed.
function sanitizePath(input: string): string {
  let path = input.trim();
  if (path.startsWith("\\\\?\\")) {
    path = path.slice(4);
    if (path.startsWith("UNC\\")) path = "\\\\" + path.slice(4);
  }
  if (path.startsWith("//?/")) {
    path = path.slice(4);
  }
  return path.replace(/\\/g, "/");
}

function formatTokens(input: number, output: number): string {
  const total = input + output;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(2)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return String(total);
}