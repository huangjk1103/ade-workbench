import {
  ChevronRight,
  Circle,
  FolderOpen,
  FolderPlus,
  ListTodo,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  FolderInput,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentDefinition, AgentSession, ProjectRecord } from "../types/domain";

interface ProjectSidebarProps {
  projects: ProjectRecord[];
  activeProjectId?: string;
  sessions: AgentSession[];
  agents: AgentDefinition[];
  annotationCount: number;
  onOpenProject: (project: ProjectRecord) => void;
  onAddProject: () => void;
  onOpenSession: (session: AgentSession) => void;
  onAcknowledgeSession: (session: AgentSession) => void;
  onRenameProject: (project: ProjectRecord) => void;
  onDeleteProject: (project: ProjectRecord) => void;
  onAddSubProject: (project: ProjectRecord) => void;
  onOpenProjectFolder: (project: ProjectRecord) => void;
  onOpenPreferences: () => void;
  onReorderProjects: (projects: ProjectRecord[]) => void;
  // Resize handle rendered along the sidebar's right edge. The hook lives
  // in App so the grid container can own the --sidebar-width CSS variable;
  // we just paint the affordance here. Optional — callers that don't pass
  // it get a static-width sidebar as before.
  resizeHandleProps?: {
    onMouseDown: (event: React.MouseEvent) => void;
    onPointerDown: (event: React.PointerEvent) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    onDoubleClick: (event: React.MouseEvent) => void;
    role: string;
    "aria-orientation": "vertical";
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
    title: string;
    tabIndex: number;
  };
  isResizing?: boolean;
}

interface ContextMenuState {
  projectId: string;
  x: number;
  y: number;
}

export function ProjectSidebar({
  projects,
  activeProjectId,
  sessions,
  agents,
  annotationCount,
  onOpenProject,
  onAddProject,
  onOpenSession,
  onAcknowledgeSession,
  onRenameProject,
  onDeleteProject,
  onAddSubProject,
  onOpenProjectFolder,
  onOpenPreferences,
  onReorderProjects,
  resizeHandleProps,
  isResizing,
}: ProjectSidebarProps) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set(activeProjectId ? [activeProjectId] : []));
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const handler = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menu]);

  function toggleExpand(projectId: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  function isExpanded(projectId: string) {
    return expandedProjects.has(projectId);
  }

  function openMenu(e: React.MouseEvent, projectId: string) {
    e.stopPropagation();
    setMenu({ projectId, x: e.clientX, y: e.clientY });
  }

  return (
    <aside className="orca-sidebar">
      <div className="sidebar-titlebar">
        <span className="sidebar-logo">A</span><strong>ADE</strong>
        <button type="button" aria-label="偏好与数据" title="偏好与 .ade 数据管理" onClick={onOpenPreferences}><Settings2 size={15} /></button>
      </div>
      <nav className="sidebar-global">
        <button type="button"><ListTodo size={15} /><span>任务</span></button>
        <button type="button"><Search size={15} /><span>搜索</span></button>
      </nav>

      <div className="sidebar-section-heading">
        <span>项目</span>
        <button type="button" onClick={onAddProject} aria-label="添加项目"><FolderPlus size={15} /></button>
      </div>
      <div className="project-list">
        {projects.map((project) => {
          const projectSessions = sessions.filter((session) => session.projectId === project.id);
          const expanded = isExpanded(project.id);
          const isActive = project.id === activeProjectId;
          const hasNotify = projectSessions.some((s) => s.phase === "notify" && !s.acknowledged);
          return (
            <div
              key={project.id}
              className={`project-item${isActive ? " is-active" : ""}${expanded ? " is-expanded" : ""}${dragOverId === project.id ? " is-drag-over" : ""}${dragId === project.id ? " is-dragging" : ""}`}
              draggable
              onDragStart={(e) => { setDragId(project.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragEnd={() => { setDragId(null); setDragOverId(null); }}
              onDragOver={(e) => { e.preventDefault(); if (dragId && dragId !== project.id) setDragOverId(project.id); }}
              onDrop={(e) => {
                e.preventDefault();
                if (!dragId || dragId === project.id) { setDragId(null); setDragOverId(null); return; }
                const fromIdx = projects.findIndex((p) => p.id === dragId);
                const toIdx = projects.findIndex((p) => p.id === project.id);
                if (fromIdx === -1 || toIdx === -1) { setDragId(null); setDragOverId(null); return; }
                const reordered = [...projects];
                const [moved] = reordered.splice(fromIdx, 1);
                reordered.splice(toIdx, 0, moved);
                onReorderProjects(reordered);
                setDragId(null); setDragOverId(null);
              }}
            >
              <button
                type="button"
                className="project-row"
                onClick={() => onOpenProject(project)}
              >
                <span className={`project-dot${hasNotify ? " has-notify" : ""}`}><Circle size={7} fill="currentColor" /></span>
                <span><strong>{project.name}</strong><small>{project.rootPath}</small></span>
                <span className="project-ellipsis" onClick={(e) => openMenu(e, project.id)}>
                  <MoreHorizontal size={14} />
                </span>
              </button>
              <button
                type="button"
                className="project-expand-toggle"
                onClick={() => toggleExpand(project.id)}
                aria-label={expanded ? "收起" : "展开"}
              >
                <ChevronRight size={12} />
              </button>
              {expanded && (
                <div className="project-agents">
                  {projectSessions.length === 0 && <p className="project-agents-empty">无活跃 Agent</p>}
                  {projectSessions.map((session) => {
                    const agent = agents.find((item) => item.id === session.agentId);
                    const isWorking = session.phase === "working";
                    const isNotify = session.phase === "notify" && !session.acknowledged;
                    return (
                      <button
                        key={session.id}
                        type="button"
                        className={`agent-session-row${isWorking ? " is-working" : ""}${isNotify ? " is-notify" : ""}`}
                        onClick={() => {
                          onOpenSession(session);
                          if (isNotify) onAcknowledgeSession(session);
                        }}
                      >
                        <span className="agent-session-indicator">
                          {isWorking ? (
                            <LoaderCircle size={11} className="spin" style={{ color: agent?.color }} />
                          ) : isNotify ? (
                            <Sparkles size={11} style={{ color: agent?.color }} />
                          ) : (
                            <i style={{ background: agent?.color }} />
                          )}
                        </span>
                        <span><strong>{session.title}</strong><small>{agent?.name} · {isWorking ? "执行中" : isNotify ? "有新结果" : session.status === "running" ? "空闲" : "已停止"}</small></span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {menu && (
        <div ref={menuRef} className="project-context-menu" style={{ top: menu.y, left: menu.x }}>
          {(() => {
            const project = projects.find((p) => p.id === menu.projectId);
            if (!project) return null;
            return (
              <>
                <button type="button" onClick={() => { setMenu(null); onRenameProject(project); }}>
                  <Pencil size={13} /><span>重命名</span>
                </button>
                <button type="button" onClick={() => { setMenu(null); onAddSubProject(project); }}>
                  <FolderInput size={13} /><span>添加子项目</span>
                </button>
                <button type="button" onClick={() => { setMenu(null); onOpenProjectFolder(project); }}>
                  <FolderOpen size={13} /><span>在文件管理器中打开</span>
                </button>
                <div className="project-context-divider" />
                <button type="button" className="danger" onClick={() => { setMenu(null); onDeleteProject(project); }}>
                  <Trash2 size={13} /><span>删除项目</span>
                </button>
              </>
            );
          })()}
        </div>
      )}
      {resizeHandleProps && (
        <div
          className={`sidebar-resize-handle${isResizing ? " is-dragging" : ""}`}
          {...resizeHandleProps}
        />
      )}
    </aside>
  );
}
