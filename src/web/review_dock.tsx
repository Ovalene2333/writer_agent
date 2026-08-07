/**
 * 审阅坞：提案 / 批量改动的 diff 预览与审批。
 * 从 main.tsx 抽出，避免工作台主文件继续膨胀。
 */
import React, { useMemo, useState } from "react";
import { Check, ChevronRight, FileText, Layers, X } from "lucide-react";
import { documentDiff, renderDiffHtml } from "../diff";
import {
  QUALITY_GRADE_LABEL,
  QUALITY_SOURCE_LABEL,
  type ChangeSet,
  type Proposal,
  type ProseQualityReport,
} from "./types";

const OPERATION_LABEL: Record<ChangeSet["files"][number]["operation"], string> = {
  write: "写入",
  patch: "补丁",
  move: "移动",
  delete: "删除",
};

const CHANGE_SET_STATUS_LABEL: Record<string, string> = {
  pending: "待审",
  accepted: "已接受",
  rejected: "已拒绝",
  stale: "已过期",
  "rolled back": "已回滚",
};

function pathBase(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function pathDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "";
}

/** Track-changes view: deletions strikethrough + fill, insertions background fill. */
export function DocumentDiffView({ before, after }: { before: string; after: string }) {
  const html = useMemo(() => {
    const parts = documentDiff(before, after);
    return renderDiffHtml(parts) || "（空文档）";
  }, [before, after]);
  return (
    <div
      className="markdown document-diff"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Advisory card: blocking 已在提案创建前完成；此处只给作者 Accept 前的质量画像。
 * 默认折叠明细，避免撑开审阅坞。
 */
export function ProposalQualityCard({ report }: { report: ProseQualityReport }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`proposal-quality grade-${report.grade}`}>
      <div className="proposal-quality-head">
        <span className="proposal-quality-grade">{QUALITY_GRADE_LABEL[report.grade]}</span>
        <span className="proposal-quality-metric" title={report.vividness.summary}>
          现场感 {report.vividness.score}
        </span>
        <span className="proposal-quality-metric" title={report.aiTells.summary}>
          模式风险 {report.aiTells.score}
        </span>
        {report.length
          ? (
            <span
              className={`proposal-quality-chars length-${report.length.status}`}
              title={`目标 ${report.length.target} 字${report.length.status === "too_short" ? "；偏短，想更长直接说一句" : report.length.status === "too_long" ? "；偏长" : ""}`}
            >
              {report.length.actual} / {report.length.target} 字
            </span>
          )
          : <span className="proposal-quality-chars">{report.characters} 字</span>}
      </div>
      {report.warnings.length > 0 && (
        <>
          <button type="button" className="proposal-quality-toggle" onClick={() => setOpen(value => !value)} aria-expanded={open}>
            {open ? "收起" : `${report.warnings.length} 条提示`}
          </button>
          {open && (
            <ul className="proposal-quality-warnings">
              {report.warnings.map((warning, index) => (
                <li key={`${warning.source}-${warning.code}-${index}`}>
                  <span className="proposal-quality-source">{QUALITY_SOURCE_LABEL[warning.source] ?? warning.source}</span>
                  <span className="proposal-quality-message">{warning.message}</span>
                  {warning.examples.length > 0 && (
                    <span className="proposal-quality-examples">{warning.examples.join(" / ")}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function ChangeSetCard({ value, onAction, onOpenPath }: {
  value: ChangeSet;
  onAction: (changeSet: ChangeSet, action: "accept" | "reject" | "undo" | "redo") => void;
  onOpenPath?: (path: string) => void;
}) {
  const stateKey = value.status === "accepted" && value.undone ? "rolled back" : value.status;
  const stateLabel = CHANGE_SET_STATUS_LABEL[stateKey] ?? stateKey;
  const fileCount = value.files.length;
  const charCount = value.characterChanges.length;
  return (
    <div className={`proposal-card change-set-card status-${value.status}${value.undone ? " undone" : ""}`}>
      <div className="proposal-card-head">
        <div className="proposal-card-title">
          <span className="proposal-card-icon" aria-hidden="true"><Layers size={14} /></span>
          <div className="proposal-card-title-text">
            <h3>批量改动 #{value.id}</h3>
            <span className="proposal-card-meta">
              {fileCount > 0 ? `${fileCount} 个文件` : ""}
              {fileCount > 0 && charCount > 0 ? " · " : ""}
              {charCount > 0 ? `${charCount} 项角色` : ""}
            </span>
          </div>
        </div>
        <span className={`change-set-status status-${stateKey.replace(/\s+/g, "-")}`}>{stateLabel}</span>
      </div>
      {value.summary ? <p className="proposal-card-summary">{value.summary}</p> : null}
      {value.files.map((file) => (
        <details className="change-set-file" key={file.id} open={value.files.length === 1}>
          <summary>
            <span className="change-set-op">{OPERATION_LABEL[file.operation] ?? file.operation}</span>
            <span className="change-set-file-name" title={file.path}>
              {pathBase(file.path)}
              {file.targetPath ? ` → ${pathBase(file.targetPath)}` : ""}
            </span>
            {onOpenPath && file.operation !== "delete" && (
              <button
                type="button"
                className="proposal-open-doc"
                title="在正文区打开"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenPath(file.path);
                }}
              >
                <FileText size={12} aria-hidden="true" />打开
              </button>
            )}
          </summary>
          {file.operation !== "move" && <DocumentDiffView before={file.beforeContent} after={file.afterContent} />}
        </details>
      ))}
      {value.characterChanges.length > 0 && (
        <details className="change-set-file">
          <summary><strong>角色卡</strong> {value.characterChanges.length} 项</summary>
          {value.characterChanges.map((change) => (
            <p key={change.characterId}>
              #{change.characterId}: {change.reason}（{change.changes.map(item => item.op).join("、")}）
            </p>
          ))}
        </details>
      )}
      <div className="proposal-actions">
        {value.status === "pending" && (
          <>
            <button type="button" className="proposal-reject" onClick={() => onAction(value, "reject")}>
              <X size={13} aria-hidden="true" />拒绝
            </button>
            <button type="button" className="primary" onClick={() => onAction(value, "accept")}>
              <Check size={13} aria-hidden="true" />全部接受
            </button>
          </>
        )}
        {value.status === "accepted" && !value.undone && (
          <button type="button" onClick={() => onAction(value, "undo")}>全部回滚</button>
        )}
        {value.status === "accepted" && value.undone && (
          <button type="button" onClick={() => onAction(value, "redo")}>全部重做</button>
        )}
      </div>
    </div>
  );
}

function ProposalCard({
  value,
  onDecide,
  onOpenPath,
}: {
  value: Proposal;
  onDecide: (proposal: Proposal, action: "accept" | "reject") => void;
  onOpenPath?: (path: string) => void;
}) {
  const hasDiff = value.beforeContent !== value.afterContent
    || Boolean(value.beforeContent)
    || Boolean(value.afterContent);
  const base = pathBase(value.path);
  const dir = pathDir(value.path);
  return (
    <div className="proposal-card">
      <div className="proposal-card-head">
        <div className="proposal-card-title">
          <span className="proposal-card-icon" aria-hidden="true"><FileText size={14} /></span>
          <div className="proposal-card-title-text">
            <h3 title={value.path}>{base}</h3>
            {dir ? <span className="proposal-card-meta" title={value.path}>{dir}</span> : null}
          </div>
        </div>
        {onOpenPath && (
          <button
            type="button"
            className="proposal-open-doc standalone"
            title="在正文区打开该文档"
            onClick={() => onOpenPath(value.path)}
          >
            <FileText size={12} aria-hidden="true" />打开
          </button>
        )}
      </div>
      {value.summary ? <p className="proposal-card-summary">{value.summary}</p> : null}
      {value.qualityReport && <ProposalQualityCard report={value.qualityReport} />}
      {hasDiff && (
        <details className="change-set-file proposal-diff" open>
          <summary>改动对比</summary>
          <DocumentDiffView before={value.beforeContent} after={value.afterContent} />
        </details>
      )}
      <div className="proposal-actions">
        <button type="button" className="proposal-reject" onClick={() => onDecide(value, "reject")}>
          <X size={13} aria-hidden="true" />拒绝
        </button>
        <button type="button" className="primary" onClick={() => onDecide(value, "accept")}>
          <Check size={13} aria-hidden="true" />接受
        </button>
      </div>
    </div>
  );
}

/** 可折叠审阅坞（待审批量改动 + 提案），挂在 Agent 面板底部。 */
export function ReviewDock({
  changeSets,
  proposals,
  pendingCount,
  open,
  onToggle,
  onChangeSetAction,
  onProposalDecide,
  onOpenPath,
}: {
  changeSets: ChangeSet[];
  proposals: Proposal[];
  pendingCount: number;
  open: boolean;
  onToggle: () => void;
  onChangeSetAction: (changeSet: ChangeSet, action: "accept" | "reject" | "undo" | "redo") => void;
  onProposalDecide: (proposal: Proposal, action: "accept" | "reject") => void;
  onOpenPath?: (path: string) => void;
}) {
  const total = changeSets.length + proposals.length;
  return (
    <section className={`review-drawer${open ? " open" : ""}${pendingCount > 0 ? " has-pending" : ""}`} aria-label="待审阅的改动">
      <button type="button" className="review-drawer-toggle" onClick={onToggle} aria-expanded={open}>
        <span className="review-drawer-chevron" aria-hidden="true">
          <ChevronRight size={12} />
        </span>
        <span className="review-drawer-title">待审阅</span>
        {pendingCount > 0 && <span className="proposal-count">{pendingCount}</span>}
        <span className="review-drawer-hint">{open ? "收起" : total > 0 ? `${total} 项改动` : "暂无"}</span>
      </button>
      {open && (
        <div className="review-drawer-body">
          {changeSets.length > 0 && (
            <div className="review-group">
              <h4 className="review-group-head">批量改动</h4>
              {changeSets.map((changeSet) => (
                <ChangeSetCard
                  key={changeSet.id}
                  value={changeSet}
                  onAction={onChangeSetAction}
                  onOpenPath={onOpenPath}
                />
              ))}
            </div>
          )}
          {proposals.length > 0 && (
            <div className="review-group">
              <h4 className="review-group-head">改动提案</h4>
              {proposals.map((p) => (
                <ProposalCard
                  key={p.id}
                  value={p}
                  onDecide={onProposalDecide}
                  onOpenPath={onOpenPath}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 合并 SSE 提案事件；门禁中间草稿与已终态回放不得降级。 */
export function mergeProposalEvent(current: Proposal[], incoming: Proposal): Proposal[] {
  if (incoming.status === "pending" && !incoming.deliveryReady) return current;
  const existing = current.find(item => item.id === incoming.id);
  if (incoming.status === "pending" && existing && existing.status !== "pending") return current;
  return [incoming, ...current.filter(item => item.id !== incoming.id)];
}
