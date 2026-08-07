import React from "react";
import {
  BookOpenText, Check, ChevronDown, Drama, FolderKanban, IdCard, Library, LockKeyhole, MessageSquare,
  MoreHorizontal, RefreshCw, Settings, Share2, ShieldCheck, Sun, Wifi, Zap,
} from "lucide-react";
import type { ConnectionInfo } from "./connection";
import type { SettingsSection } from "./model_config";
import type { PermissionMode, ProjectSummary, Provider, Usage, UiThemeId, WorkspaceMode } from "./types";
import { PERMISSION_MODES } from "./types";
import { IconButton, HeaderMoreMenu, LayoutControls, SettingsMenu } from "./ui_primitives";
import { realCacheHitRate, formatTokenCount } from "./agent_steps";

export function WorkspaceTopbar({
  title,
  project,
  projects,
  projectSwitching,
  connection,
  model,
  usagePct,
  usageCost,
  usageCurrency,
  usageUnmetered,
  busy,
  readOnly,
  settingsOpen,
  moreOpen,
  workspaceMode,
  documentsCollapsed,
  pendingReviewCount = 0,
  onCharacters,
  onSwitchProject,
  onRoleplay,
  onSessions,
  onUsage,
  onShare,
  onConnection,
  onToggleSettings,
  onCloseSettings,
  onSelectSettings,
  onReviewRules,
  onOpenReview,
  onToggleMore,
  onCloseMore,
  onRefresh,
  onModeChange,
  onToggleDocuments,
}: {
  title: string;
  project: ProjectSummary;
  projects: ProjectSummary[];
  projectSwitching: boolean;
  connection: ConnectionInfo;
  model: string;
  usagePct: number;
  usageCost: number;
  usageCurrency: string;
  usageUnmetered: boolean;
  busy: boolean;
  readOnly: boolean;
  settingsOpen: boolean;
  moreOpen: boolean;
  workspaceMode: WorkspaceMode;
  documentsCollapsed: boolean;
  /** 待审阅提案 + 批量改动数量；>0 时在顶栏显示入口 */
  pendingReviewCount?: number;
  onCharacters: () => void;
  onSwitchProject: (projectId: string) => void;
  onRoleplay: () => void;
  onSessions: () => void;
  onUsage: () => void;
  onShare: () => void;
  onConnection: () => void;
  onToggleSettings: () => void;
  onCloseSettings: () => void;
  onSelectSettings: (section: SettingsSection) => void;
  onReviewRules: () => void;
  onOpenReview?: () => void;
  onToggleMore: () => void;
  onCloseMore: () => void;
  onRefresh: () => void;
  onModeChange: (mode: WorkspaceMode) => void;
  onToggleDocuments: () => void;
}) {
  const [projectsOpen, setProjectsOpen] = React.useState(false);
  React.useEffect(() => setProjectsOpen(false), [project.id]);
  const usageLabel = usageUnmetered ? "非按量" : `${usageCurrency === "CNY" ? "¥" : "$"}${usageCost.toFixed(2)}`;
  return (
    <header className="workspace-topbar">
      <div className="header-left">
        <span className="logo" aria-hidden="true"><span className="logo-mark">W</span></span>
        <div className="title-stack">
          <span className="product-line">Writer</span>
          <h1 title={title}>{title}</h1>
        </div>
        <div className="project-switcher">
          <IconButton
            label="切换项目"
            className={projectsOpen ? "active" : ""}
            onClick={() => setProjectsOpen((open) => !open)}
            disabled={projectSwitching}
          >
            <FolderKanban size={16} />
          </IconButton>
          {projectsOpen && (
            <div className="project-menu" role="menu" aria-label="项目列表">
              {projects.map((candidate) => {
                const current = candidate.id === project.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`project-menu-item${current ? " active" : ""}`}
                    role="menuitemradio"
                    aria-checked={current}
                    disabled={current || projectSwitching}
                    title={candidate.title}
                    onClick={() => {
                      setProjectsOpen(false);
                      onSwitchProject(candidate.id);
                    }}
                  >
                    <span>{candidate.title}</span>
                    {current && <Check size={15} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {connection.dualMode && (
          <button
            type="button"
            className={`connection-pill route-${connection.route}${connection.lanBlockedByMixedContent ? " mixed-block" : ""}`}
            title="连接通道：点击查看说明与切换"
            aria-label={`当前${connection.label}，打开连接设置`}
            onClick={onConnection}
          >
            <i aria-hidden="true" />
            <span className="connection-pill-label">{connection.label}</span>
          </button>
        )}
        {readOnly && <span className="readonly-pill"><LockKeyhole size={12} />只读</span>}
      </div>
      <div className="header-right">
        <LayoutControls
          mode={workspaceMode}
          documentsCollapsed={documentsCollapsed}
          onModeChange={onModeChange}
          onToggleDocuments={onToggleDocuments}
        />
        <nav className="nav-cluster nav-workspace" aria-label="工作区入口">
          {pendingReviewCount > 0 && onOpenReview && (
            <button
              type="button"
              className="ghost nav-action review-nav-btn"
              aria-label={`${pendingReviewCount} 条改动待审阅`}
              title={`${pendingReviewCount} 条改动待审阅`}
              onClick={onOpenReview}
            >
              <ShieldCheck size={17} aria-hidden="true" /><span>审阅</span>
              <span className="proposal-count">{pendingReviewCount}</span>
            </button>
          )}
          <button type="button" className="ghost nav-action" aria-label="角色" title="角色" onClick={onCharacters}>
            <IdCard size={17} aria-hidden="true" /><span>角色</span>
          </button>
          <button type="button" className="ghost nav-action" aria-label="扮演" title="扮演" disabled={busy || readOnly} onClick={onRoleplay}>
            <Drama size={17} aria-hidden="true" /><span>扮演</span>
          </button>
          <button type="button" className="ghost nav-action nav-sessions" aria-label="会话" title="会话" onClick={onSessions}>
            <MessageSquare size={16} aria-hidden="true" /><span>会话</span>
          </button>
        </nav>
        <button
          type="button"
          className={`usage-strip${usagePct >= 85 ? " usage-hot" : usagePct >= 60 ? " usage-warm" : ""}`}
          onClick={onUsage}
          title={`${model} · 上下文 ${usagePct}% · ${usageUnmetered ? "非按量计费" : `费用 ${usageLabel}`}`}
        >
          <span className="model-name">{model}</span>
          <span className="context-meter" title={`上下文 ${usagePct}%`} aria-hidden="true">
            <i style={{ width: `${Math.min(100, Math.max(2, usagePct))}%` }} />
          </span>
          <span className="usage-pct">{usagePct}%</span>
          <span className="usage-cost">
            {usageUnmetered
              ? "非按量"
              : `${usageCurrency === "CNY" ? "¥" : "$"}${usageCost >= 1 ? usageCost.toFixed(2) : usageCost.toFixed(3)}`}
          </span>
          <ChevronDown size={13} className="usage-chevron-icon" aria-hidden="true" />
        </button>
        <div className="header-utility">
          {!readOnly && (
            <button type="button" className="ghost nav-action nav-share" onClick={onShare} title="生成只读分享链接" aria-label="分享">
              <Share2 size={16} aria-hidden="true" /><span>分享</span>
            </button>
          )}
          {!readOnly && (
            <div className="settings-anchor">
              <IconButton label="设置" className={settingsOpen ? "active" : ""} onClick={onToggleSettings}>
                <Settings size={17} />
              </IconButton>
            </div>
          )}
          <IconButton label="刷新工作区" className="nav-refresh" onClick={onRefresh}>
            <RefreshCw size={17} />
          </IconButton>
        </div>
        <div className="header-more-anchor">
          <IconButton
            label="更多"
            className={`header-more-btn${moreOpen ? " active" : ""}`}
            onClick={onToggleMore}
          >
            <MoreHorizontal size={18} />
          </IconButton>
          <HeaderMoreMenu
            open={moreOpen}
            busy={busy}
            readOnly={readOnly}
            onClose={onCloseMore}
            onCharacters={onCharacters}
            onRoleplay={onRoleplay}
            onSessions={onSessions}
            onShare={onShare}
            onSettings={onToggleSettings}
            onRefresh={onRefresh}
          />
        </div>
        {/*
          SettingsMenu must not live under .header-utility: that cluster is display:none
          on mobile, which also hides position:fixed descendants. Mount at header-right.
        */}
        {!readOnly && (
          <SettingsMenu
            open={settingsOpen}
            connectionAvailable={connection.dualMode}
            onClose={onCloseSettings}
            onSelect={onSelectSettings}
            onReviewRules={onReviewRules}
          />
        )}
      </div>
    </header>
  );
}
