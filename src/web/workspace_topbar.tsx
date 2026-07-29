import React from "react";
import {
  BookOpenText, ChevronDown, Drama, IdCard, Library, LockKeyhole, MessageSquare,
  MoreHorizontal, RefreshCw, Settings, Share2, Sun, Wifi, Zap,
} from "lucide-react";
import type { ConnectionInfo } from "./connection";
import type { SettingsSection } from "./model_config";
import type { PermissionMode, Provider, Usage, UiThemeId, WorkspaceMode } from "./types";
import { PERMISSION_MODES } from "./types";
import { IconButton, HeaderMoreMenu, LayoutControls, SettingsMenu } from "./ui_primitives";
import { realCacheHitRate, formatTokenCount } from "./agent_steps";

export function WorkspaceTopbar({
  title,
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
  onCharacters,
  onRoleplay,
  onSessions,
  onUsage,
  onShare,
  onConnection,
  onToggleSettings,
  onCloseSettings,
  onSelectSettings,
  onReviewRules,
  onContinuityFacts,
  onToggleMore,
  onCloseMore,
  onRefresh,
  onModeChange,
  onToggleDocuments,
}: {
  title: string;
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
  onCharacters: () => void;
  onRoleplay: () => void;
  onSessions: () => void;
  onUsage: () => void;
  onShare: () => void;
  onConnection: () => void;
  onToggleSettings: () => void;
  onCloseSettings: () => void;
  onSelectSettings: (section: SettingsSection) => void;
  onReviewRules: () => void;
  onContinuityFacts: () => void;
  onToggleMore: () => void;
  onCloseMore: () => void;
  onRefresh: () => void;
  onModeChange: (mode: WorkspaceMode) => void;
  onToggleDocuments: () => void;
}) {
  const usageLabel = usageUnmetered ? "非按量" : `${usageCurrency === "CNY" ? "¥" : "$"}${usageCost.toFixed(2)}`;
  return (
    <header className="workspace-topbar">
      <div className="header-left">
        <span className="logo" aria-hidden="true"><span className="logo-mark">W</span></span>
        <div className="title-stack">
          <span className="product-line">Writer</span>
          <h1 title={title}>{title}</h1>
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
          className="usage-strip"
          onClick={onUsage}
          title={`${model} · 上下文 ${usagePct}% · ${usageUnmetered ? "非按量计费" : `费用 ${usageLabel}`}`}
        >
          <span className="model-name">{model}</span>
          <span className="context-meter" title={`上下文 ${usagePct}%`} aria-hidden="true">
            <i style={{ width: `${Math.min(100, Math.max(2, usagePct))}%` }} />
          </span>
          <span className="usage-pct">{usagePct}%</span>
          <span className="usage-cost">{usageUnmetered ? "非按量计费" : `${usageCurrency === "CNY" ? "¥" : "$"}${usageCost.toFixed(4)}`}</span>
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
              <SettingsMenu
                open={settingsOpen}
                connectionAvailable={connection.dualMode}
                onClose={onCloseSettings}
                onSelect={onSelectSettings}
                onReviewRules={onReviewRules}
                onContinuityFacts={onContinuityFacts}
              />
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
      </div>
    </header>
  );
}
