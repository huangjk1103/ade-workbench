import { ArrowUpRight, CheckCircle2, FileText, Highlighter, History, MessageSquare, MessageSquarePlus, MessageSquareText, Pencil, Send, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AgentDefinition,
  AgentDetection,
  Annotation,
  DocxReviewModel,
  ReviewComment,
  TextSelectionContext,
  TrackChange,
} from "../types/domain";

interface AnnotationPanelProps {
  projectId: string;
  activeFilePath?: string;
  selection?: TextSelectionContext;
  // Annotations now come from the project's `.ade/journal.json` instead of
  // a global state file, so the panel only sees the currently-open project.
  annotations: Annotation[];
  agents: AgentDefinition[];
  detections: AgentDetection[];
  onCreate: (body: string, priority: Annotation["priority"], agentId?: string) => Promise<void>;
  onSend: (annotation: Annotation, agentId: string) => Promise<void>;
  onResolve: (annotation: Annotation) => void;
  onRestore: (annotation: Annotation) => Promise<void>;
  onDelete?: (annotation: Annotation) => Promise<void> | void;
  // When provided, clicking the body of an annotation card jumps the
  // workspace to the matching file and paints a dashed outline around the
  // selected text so the user can find the source spot immediately.
  onJump?: (annotation: Annotation) => void;
  // Highlight the card whose file the user just opened so they remember
  // which annotation they were navigating from.
  jumpSourceId?: string;
  // When true, hide the inline create composer (and empty prompt) and only
  // show the annotation history. Used for viewers that create annotations
  // through their own in-context flow (e.g. docx 划词批注).
  hideComposer?: boolean;
  // Docx review data — track changes (`w:ins` / `w:del`) and Word-style
  // comments — surfaced here so the legacy in-document review pane can be
  // retired. Both sections only render when `activeFilePath` is a docx and
  // the model contains at least one entry of the corresponding kind.
  docxReview?: DocxReviewModel | null;
  onJumpReviewChange?: (changeId: string) => void;
  onJumpReviewComment?: (commentId: string) => void;
}

// Unified row shape. We unify ADE annotations with docx-native comments +
// tracked changes so the list can render every note for the current file
// in one place. Each row carries a discriminator and a precomputed
// timestamp so the sort step stays a one-liner.
type UnifiedRow =
  | { source: "ade"; ts: number; annotation: Annotation }
  | { source: "docx-comment"; ts: number; comment: ReviewComment; author: string }
  | { source: "docx-change"; ts: number; change: TrackChange };

// Visual constants for each row type. Centralising the colors here keeps
// the three sources visually consistent with the rest of the inspector
// while making it trivial to retune later.
const SOURCE_BADGES: Record<UnifiedRow["source"], { label: string; color: string; Icon: typeof MessageSquare }> = {
  ade: { label: "ADE 批注", color: "#d6a866", Icon: MessageSquarePlus },
  "docx-comment": { label: "Word 批注", color: "#5fd3c6", Icon: MessageSquareText },
  "docx-change": { label: "Word 修改", color: "#9c7ca7", Icon: Pencil },
};

function formatTime(ms: number): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function AnnotationPanel({
  projectId,
  activeFilePath,
  selection,
  annotations,
  agents,
  detections,
  onCreate,
  onSend,
  onResolve,
  onRestore,
  onDelete,
  onJump,
  jumpSourceId,
  hideComposer,
  docxReview,
  onJumpReviewChange,
  onJumpReviewComment,
}: AnnotationPanelProps) {
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<Annotation["priority"]>("normal");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Source filter — defaults to "all" so users see the merged list on
  // first load. Per the design feedback, docx-native comments must
  // surface alongside ADE annotations by default; this filter is just a
  // convenience for power users who want to focus on one stream.
  const [sourceFilter, setSourceFilter] = useState<"all" | UnifiedRow["source"]>("all");

  useEffect(() => {
    setBody("");
    setError("");
  }, [selection?.selectedText]);

  const { fileAnnotations, otherFileAnnotations, unifiedRows, docxStats } = useMemo(() => {
    const filtered = annotations.filter((item) => item.projectId === projectId);
    const sorted = [...filtered].sort((left, right) => right.createdAt - left.createdAt);
    const fileAde = activeFilePath ? sorted.filter((item) => item.target.filePath === activeFilePath) : sorted;
    const fileOther = activeFilePath ? sorted.filter((item) => item.target.filePath !== activeFilePath) : [];
    const rows: UnifiedRow[] = [];
    for (const annotation of fileAde) rows.push({ source: "ade", ts: annotation.createdAt, annotation });
    const docxIsActive = !!activeFilePath && /\.(docx|docm|doc)$/i.test(activeFilePath);
    if (docxIsActive && docxReview) {
      for (const c of docxReview.comments) rows.push({ source: "docx-comment", ts: c.dateMs, comment: c, author: c.author });
      for (const ch of docxReview.changes) rows.push({ source: "docx-change", ts: ch.dateMs, change: ch });
    }
    // Newest first so the most recently added note floats to the top,
    // matching the legacy ADE behaviour.
    rows.sort((a, b) => b.ts - a.ts);
    const stats = docxIsActive && docxReview
      ? { comments: docxReview.comments.length, openComments: docxReview.comments.filter((c) => !c.resolved).length, changes: docxReview.changes.length }
      : { comments: 0, openComments: 0, changes: 0 };
    return { fileAnnotations: fileAde, otherFileAnnotations: fileOther, unifiedRows: rows, docxStats: stats };
  }, [activeFilePath, annotations, projectId, docxReview]);
  const selectedAgentAvailable = detections.find((item) => item.id === agentId)?.available ?? false;

  async function submit(send: boolean) {
    if (!selection || !body.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(body.trim(), priority, send ? agentId : undefined);
      setBody("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const filteredRows = sourceFilter === "all" ? unifiedRows : unifiedRows.filter((row) => row.source === sourceFilter);
  const totalOpen = fileAnnotations.filter((a) => a.status !== "resolved").length + docxStats.openComments + docxStats.changes;

  return (
    <div className="annotation-panel">
      <div className="inspector-heading">
        <div><span>ANNOTATIONS</span><strong>批注与任务</strong></div>
        <em>{totalOpen}</em>
      </div>

      {hideComposer ? (
        <div className="annotation-hint">
          <Highlighter size={14} />
          <span>在文档中开启“划词批注”后，选中文字即可就地创建批注。下方为当前文件的批注历史。</span>
        </div>
      ) : selection ? (
        <div className="annotation-composer">
          <div className="selection-quote"><Highlighter size={14} /><span>“{selection.selectedText}”</span></div>
          <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="说明需要修改、核验或补充的内容…" />
          <div className="composer-options">
            <select value={priority} onChange={(event) => setPriority(event.target.value as Annotation["priority"])}>
              <option value="normal">普通优先级</option><option value="high">高优先级</option>
            </select>
            <span>{body.length}/1000</span>
          </div>
          <div className="composer-agent-row">
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.map((agent) => {
                const available = detections.find((item) => item.id === agent.id)?.available;
                return <option key={agent.id} value={agent.id} disabled={!available}>{agent.name}{available ? "" : "（未检测）"}</option>;
              })}
            </select>
          </div>
          {error && <div className="inline-error">{error}</div>}
          <div className="composer-actions">
            <button type="button" onClick={() => void submit(false)} disabled={busy || !body.trim()}>
              <MessageSquarePlus size={14} /> 仅保存批注
            </button>
            <button className="is-primary" type="button" onClick={() => void submit(true)} disabled={busy || !body.trim() || !selectedAgentAvailable}>
              <Send size={14} /> {busy ? "正在发送…" : "发送给 Agent"}
            </button>
          </div>
        </div>
      ) : (
        <div className="annotation-empty">
          <MessageSquarePlus size={24} />
          <strong>圈选内容以创建批注</strong>
          <span>支持 Markdown、文本、Word、PDF 中的文字选区。PDF 选区后会浮出颜色与高亮工具，可直接发送给 Agent 讨论。</span>
        </div>
      )}

      {docxReview && docxReview.authors.length > 0 && (
        <div className="docx-review-authors-row">
          {docxReview.authors.map((a) => (
            <span key={a.id} className="docx-review-author-chip" title={a.name}>
              <i style={{ background: a.color }} /> {a.name}
            </span>
          ))}
        </div>
      )}

      {/* Per-source filter chips. Default is "all" so the merged list
          shows every kind of note on first load, as requested in the
          design feedback ("默认显示所有类型的批注"). */}
      <div className="annotation-source-filter">
        <button type="button" className={sourceFilter === "all" ? "is-active" : ""} onClick={() => setSourceFilter("all")}>
          全部 <em>{unifiedRows.length}</em>
        </button>
        <button type="button" className={sourceFilter === "ade" ? "is-active" : ""} onClick={() => setSourceFilter("ade")}>
          <span className="annotation-source-dot" style={{ background: SOURCE_BADGES.ade.color }} /> ADE 批注 <em>{unifiedRows.filter((r) => r.source === "ade").length}</em>
        </button>
        <button type="button" className={sourceFilter === "docx-comment" ? "is-active" : ""} onClick={() => setSourceFilter("docx-comment")}>
          <span className="annotation-source-dot" style={{ background: SOURCE_BADGES["docx-comment"].color }} /> Word 批注 <em>{docxStats.comments}</em>
        </button>
        <button type="button" className={sourceFilter === "docx-change" ? "is-active" : ""} onClick={() => setSourceFilter("docx-change")}>
          <span className="annotation-source-dot" style={{ background: SOURCE_BADGES["docx-change"].color }} /> Word 修改 <em>{docxStats.changes}</em>
        </button>
      </div>

      <div className="annotation-list-title"><span>当前文件</span><em>{filteredRows.length}</em></div>
      <div className="real-annotation-list">
        {filteredRows.map((row) => {
          if (row.source === "ade") {
            const annotation = row.annotation;
            const isJumpSource = jumpSourceId === annotation.id;
            const badge = SOURCE_BADGES.ade;
            const cardClasses = [
              "real-annotation",
              "unified-source-ade",
              `real-annotation--${annotation.status}`,
              isJumpSource ? "is-jump-source" : "",
            ].filter(Boolean).join(" ");
            return (
              <article
                key={`ade-${annotation.id}`}
                className={cardClasses}
                style={{ borderLeftColor: annotation.target.color ?? badge.color, borderLeftWidth: 3 }}
                onClick={onJump ? () => onJump(annotation) : undefined}
                onKeyDown={(event) => {
                  if (!onJump) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onJump(annotation);
                  }
                }}
                role={onJump ? "button" : undefined}
                tabIndex={onJump ? 0 : undefined}
                title={onJump ? "点击跳转到对应文字位置" : undefined}
              >
                {onJump && (
                  <span className="annotation-jump-hint" aria-hidden="true">
                    <ArrowUpRight size={11} />
                  </span>
                )}
                <div className="annotation-topline">
                  <span className="annotation-source-tag" style={{ background: `${badge.color}26`, color: badge.color }}>
                    <badge.Icon size={10} /> {badge.label}
                  </span>
                  <span>{annotation.status === "open" ? "待处理" : annotation.status === "sent" ? "已发送" : "已解决"}</span>
                  {annotation.priority === "high" && <b>高优先级</b>}
                  {annotation.target.pageNumber && <i><FileText size={10} /> 第 {annotation.target.pageNumber} 页</i>}
                </div>
                <blockquote>“{annotation.target.selectedText}”</blockquote>
                <p>{annotation.body}</p>
                <div
                  className="annotation-footer"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <small>{formatTime(annotation.createdAt)}</small>
                  <div>
                    {annotation.status === "open" && (
                      <button type="button" onClick={() => void onSend(annotation, agentId)} disabled={!selectedAgentAvailable} title="发送给当前 Agent"><Sparkles size={13} /></button>
                    )}
                    {annotation.status !== "resolved" && (
                      <button type="button" onClick={() => onResolve(annotation)} title="标记已解决"><CheckCircle2 size={13} /></button>
                    )}
                    {annotation.snapshotId && (
                      <button type="button" onClick={() => void onRestore(annotation)} title="恢复发送任务前的文件"><History size={13} /></button>
                    )}
                    {onDelete && (
                      <button type="button" onClick={() => void onDelete(annotation)} title="删除批注"><Trash2 size={13} /></button>
                    )}
                  </div>
                </div>
              </article>
            );
          }
          if (row.source === "docx-comment") {
            const c = row.comment;
            const badge = SOURCE_BADGES["docx-comment"];
            return (
              <article
                key={`docxc-${c.id}`}
                className="real-annotation unified-source-docx-comment"
                style={{ borderLeftColor: badge.color, borderLeftWidth: 3 }}
                role={onJumpReviewComment ? "button" : undefined}
                tabIndex={onJumpReviewComment ? 0 : undefined}
                onClick={onJumpReviewComment ? () => onJumpReviewComment(c.id) : undefined}
                onKeyDown={(event) => {
                  if (!onJumpReviewComment) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onJumpReviewComment(c.id);
                  }
                }}
                title={onJumpReviewComment ? "跳转到文档中对应位置" : undefined}
              >
                <div className="annotation-topline">
                  <span className="annotation-source-tag" style={{ background: `${badge.color}26`, color: badge.color }}>
                    <badge.Icon size={10} /> {badge.label}
                  </span>
                  <span>{c.resolved ? "已解决" : "未解决"}</span>
                  <i title={c.author} style={{ color: badge.color }}>{c.author}</i>
                </div>
                <blockquote>“{c.text || "（空）"}”</blockquote>
                {c.replies.length > 0 && <small className="docx-review-replies">{c.replies.length} 条回复</small>}
                <div className="annotation-footer" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  <small>{formatTime(c.dateMs)}</small>
                  <div>
                    {onJumpReviewComment && (
                      <button type="button" onClick={() => onJumpReviewComment(c.id)} title="跳转到文档中对应位置"><ArrowUpRight size={13} /></button>
                    )}
                  </div>
                </div>
              </article>
            );
          }
          // docx-change
          const ch = row.change;
          const kindColor = ch.kind === "insert" ? "#7fd1b3" : "#e29a9a";
          const badge = SOURCE_BADGES["docx-change"];
          return (
            <article
              key={`docxch-${ch.id}`}
              className={`real-annotation unified-source-docx-change docx-review-card--${ch.kind}`}
              style={{ borderLeftColor: kindColor, borderLeftWidth: 3 }}
              role={onJumpReviewChange ? "button" : undefined}
              tabIndex={onJumpReviewChange ? 0 : undefined}
              onClick={onJumpReviewChange ? () => onJumpReviewChange(ch.id) : undefined}
              onKeyDown={(event) => {
                if (!onJumpReviewChange) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onJumpReviewChange(ch.id);
                }
              }}
              title={onJumpReviewChange ? "跳转到文档中对应位置" : undefined}
            >
              <div className="annotation-topline">
                <span className="annotation-source-tag" style={{ background: `${badge.color}26`, color: badge.color }}>
                  <badge.Icon size={10} /> {badge.label}
                </span>
                <span style={{ color: kindColor }}>{ch.kind === "insert" ? "插入" : "删除"}</span>
                <i title={ch.author} style={{ color: kindColor }}>{ch.author}</i>
              </div>
              <blockquote>“{ch.text.slice(0, 200) || "（空）"}”</blockquote>
              <div className="annotation-footer" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                <small>{formatTime(ch.dateMs)}</small>
                <div>
                  {onJumpReviewChange && (
                    <button type="button" onClick={() => onJumpReviewChange(ch.id)} title="跳转到文档中对应位置"><ArrowUpRight size={13} /></button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
        {filteredRows.length === 0 && (
          <p className="annotation-list-empty">
            {sourceFilter === "all" ? "当前文件还没有批注。" : "当前筛选下没有匹配的批注。"}
          </p>
        )}
      </div>

      {otherFileAnnotations.length > 0 && (
        <>
          <div className="annotation-list-title annotation-list-title--other">
            <span>其他文件</span>
            <em>{otherFileAnnotations.length}</em>
          </div>
          <div className="real-annotation-list real-annotation-list--other">
            {otherFileAnnotations.map((annotation) => {
              const isJumpSource = jumpSourceId === annotation.id;
              const cardClasses = [
                "real-annotation",
                `real-annotation--${annotation.status}`,
                isJumpSource ? "is-jump-source" : "",
              ].filter(Boolean).join(" ");
              const fileName = annotation.target.filePath.split(/[\\/]/).pop() ?? annotation.target.filePath;
              return (
                <article
                  key={annotation.id}
                  className={cardClasses}
                  style={{ borderLeftColor: annotation.target.color ?? undefined, borderLeftWidth: annotation.target.color ? 3 : undefined }}
                  onClick={onJump ? () => onJump(annotation) : undefined}
                  onKeyDown={(event) => {
                    if (!onJump) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onJump(annotation);
                    }
                  }}
                  role={onJump ? "button" : undefined}
                  tabIndex={onJump ? 0 : undefined}
                  title={onJump ? `跳转到 ${annotation.target.filePath} 中的选中文字` : undefined}
                >
                  {onJump && (
                    <span className="annotation-jump-hint" aria-hidden="true">
                      <ArrowUpRight size={11} />
                    </span>
                  )}
                  <div className="annotation-topline">
                    <span>{annotation.status === "open" ? "待处理" : annotation.status === "sent" ? "已发送" : "已解决"}</span>
                    <i title={annotation.target.filePath}><FileText size={10} /> {fileName}</i>
                  </div>
                  <blockquote>“{annotation.target.selectedText}”</blockquote>
                  <p>{annotation.body}</p>
                  <div
                    className="annotation-footer"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <small>{formatTime(annotation.createdAt)}</small>
                    <div>
                      {onJump && (
                        <button type="button" onClick={() => onJump(annotation)} title={`打开并跳转到 ${fileName}`}>
                          <ArrowUpRight size={13} />
                        </button>
                      )}
                      {onDelete && (
                        <button type="button" onClick={() => void onDelete(annotation)} title="删除批注"><Trash2 size={13} /></button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
