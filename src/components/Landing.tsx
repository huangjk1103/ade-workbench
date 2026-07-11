import { Bot, FolderOpen, HardDrive, ShieldCheck } from "lucide-react";
import type { AgentDefinition, AgentDetection, ProjectRecord } from "../types/domain";

interface LandingProps {
  projects: ProjectRecord[];
  agents: AgentDefinition[];
  detections: AgentDetection[];
  busy: boolean;
  error?: string;
  onOpenFolder: () => void;
  onOpenRecent: (project: ProjectRecord) => void;
}

export function Landing({
  projects,
  agents,
  detections,
  busy,
  error,
  onOpenFolder,
  onOpenRecent,
}: LandingProps) {
  const availableCount = detections.filter((item) => item.available).length;

  return (
    <div className="landing-page">
      <div className="landing-brand"><span>A</span><strong>ADE</strong></div>
      <section className="landing-hero">
        <p className="landing-eyebrow">AGENTIC DOCUMENT ENVIRONMENT</p>
        <h1>打开一个项目，<br />让多个 Agent 围绕成果工作。</h1>
        <p className="landing-description">
          在真实项目目录中阅读文件、圈选批注、启动 Hermes、Claude Code、Kimi Code 或 Codex，
          并将批注直接发送到它们的终端会话。
        </p>
        <button className="landing-primary" type="button" onClick={onOpenFolder} disabled={busy}>
          <FolderOpen size={18} /> {busy ? "正在读取项目…" : "打开项目文件夹"}
        </button>
        {error && <div className="landing-error">{error}</div>}
      </section>

      <section className="landing-grid">
        <div className="landing-card recent-projects">
          <div className="landing-card-title"><HardDrive size={16} /><span>最近项目</span></div>
          {projects.length === 0 ? (
            <p className="landing-empty">还没有项目。选择任意本地文件夹即可开始。</p>
          ) : (
            <div className="recent-list">
              {projects.slice(0, 6).map((project) => (
                <button key={project.id} type="button" onClick={() => onOpenRecent(project)}>
                  <span className="recent-monogram">{project.name.slice(0, 2).toUpperCase()}</span>
                  <span><strong>{project.name}</strong><small>{project.rootPath}</small></span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="landing-card agent-readiness">
          <div className="landing-card-title"><Bot size={16} /><span>本机 Agent</span><em>{availableCount}/{agents.length}</em></div>
          <div className="readiness-list">
            {agents.map((agent) => {
              const detection = detections.find((item) => item.id === agent.id);
              return (
                <div key={agent.id}>
                  <i style={{ background: agent.color }} />
                  <span><strong>{agent.name}</strong><small>{agent.role}</small></span>
                  <b className={detection?.available ? "is-ready" : ""}>
                    {detection?.available ? "可用" : "未检测"}
                  </b>
                </div>
              );
            })}
          </div>
          <div className="landing-safety"><ShieldCheck size={14} /> Agent 始终以项目文件夹作为工作目录</div>
        </div>
      </section>
    </div>
  );
}

