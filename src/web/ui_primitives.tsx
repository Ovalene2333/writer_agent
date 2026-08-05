import React, { useEffect, useRef, useState } from "react";
import {
  BookOpenText, Bot, Columns3, Drama, IdCard, Menu, MessageSquare, MoreHorizontal,
  PanelLeftClose, PanelLeftOpen, PanelRight, Pencil, RefreshCw, Settings, Share2, ShieldCheck,
  Sun, WandSparkles, Wifi, X,
} from "lucide-react";
import type { SettingsSection } from "./model_config";
import type { UiThemeId, WorkspaceMode } from "./types";
import { AGENT_HIDDEN_CHARACTER_CARDS_KEY, UI_THEMES, UI_THEME_IDS } from "./types";

export function loadAgentHiddenCharacterCards(): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(AGENT_HIDDEN_CHARACTER_CARDS_KEY) || "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

export function loadUiTheme(): UiThemeId {
  const stored = localStorage.getItem("writer-ui-theme") || localStorage.getItem("writer-theme");
  if (stored && UI_THEME_IDS.has(stored)) return stored as UiThemeId;
  if (stored === "aurora") return "ocean";
  if (stored === "sakura") return "rose";
  if (stored === "carbon") return "graphite";
  if (stored === "parchment") return "light";
  if (stored === "midnight") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export const PERFORMANCE_MODE_STORAGE_KEY = "writer-performance-mode";

export function loadPerformanceMode(): boolean {
  try {
    return localStorage.getItem(PERFORMANCE_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function loadWorkspaceMode(): WorkspaceMode {
  const stored = localStorage.getItem("writer-workspace-mode");
  return stored === "editor-focus" || stored === "agent-focus" ? stored : "split";
}

export const LAST_SESSION_KEY = "writer-last-session-id";

export function readLastSessionId(): string | undefined {
  try {
    const id = localStorage.getItem(LAST_SESSION_KEY)?.trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

export function rememberLastSessionId(id: string | undefined): void {
  if (!id) return;
  try {
    localStorage.setItem(LAST_SESSION_KEY, id);
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearLastSessionId(): void {
  try {
    localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    /* ignore unavailable storage */
  }
}
export function IconButton({ label, children, className = "", onClick, disabled = false }: {
  label: string;
  children: React.ReactNode;
  className?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={`icon ${className}`.trim()} title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export type RowMenuItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/** Collapse secondary row actions into one overflow menu to reduce button clutter. */
export function RowOverflowMenu({
  items,
  label = "更多操作",
  className = "",
}: {
  items: RowMenuItem[];
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const visible = items.filter(Boolean);
  if (!visible.length) return null;
  return (
    <div className={`row-overflow ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        className="tree-action-btn row-overflow-trigger"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(current => !current);
        }}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="row-overflow-menu" role="menu" onClick={(event) => event.stopPropagation()}>
          {visible.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`row-overflow-item${item.danger ? " danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon ? <span className="row-overflow-icon" aria-hidden="true">{item.icon}</span> : null}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LayoutControls({ mode, documentsCollapsed, onModeChange, onToggleDocuments }: {
  mode: WorkspaceMode;
  documentsCollapsed: boolean;
  onModeChange: (mode: WorkspaceMode) => void;
  onToggleDocuments: () => void;
}) {
  return (
    <div className="layout-controls" role="group" aria-label="工作区布局">
      <IconButton label={documentsCollapsed ? "展开文档栏" : "折叠文档栏"} onClick={onToggleDocuments}>
        {documentsCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </IconButton>
      <IconButton label="三栏布局" className={mode === "split" ? "active" : ""} onClick={() => onModeChange("split")}>
        <Columns3 size={16} />
      </IconButton>
      <IconButton label="聚焦正文" className={mode === "editor-focus" ? "active" : ""} onClick={() => onModeChange("editor-focus")}>
        <BookOpenText size={16} />
      </IconButton>
      <IconButton label="聚焦 Agent" className={mode === "agent-focus" ? "active" : ""} onClick={() => onModeChange("agent-focus")}>
        <PanelRight size={16} />
      </IconButton>
    </div>
  );
}

export function SettingsMenu({ open, connectionAvailable, onClose, onSelect, onReviewRules }: {
  open: boolean;
  connectionAvailable: boolean;
  onClose: () => void;
  onSelect: (section: SettingsSection) => void;
  onReviewRules: () => void;
}) {
  if (!open) return null;
  const pick = (action: () => void) => () => {
    action();
    onClose();
  };
  return (
    <div className="settings-menu-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="settings-menu" role="menu" aria-label="设置快捷入口" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" role="menuitem" onClick={pick(() => onSelect("models"))}><Bot size={16} aria-hidden="true" />模型与分工</button>
        <button type="button" role="menuitem" onClick={pick(() => onSelect("writing"))}><Pencil size={16} aria-hidden="true" />写作行为</button>
        <button type="button" role="menuitem" onClick={pick(() => onSelect("style"))}><WandSparkles size={16} aria-hidden="true" />写作风格</button>
        <i className="settings-menu-separator" aria-hidden="true" />
        <button type="button" role="menuitem" onClick={pick(onReviewRules)}><ShieldCheck size={16} aria-hidden="true" />作者复审规则</button>
        <i className="settings-menu-separator" aria-hidden="true" />
        <button type="button" role="menuitem" disabled={!connectionAvailable} onClick={pick(() => onSelect("connection"))}><Wifi size={16} aria-hidden="true" />连接设置</button>
        <button type="button" role="menuitem" onClick={pick(() => onSelect("appearance"))}><Sun size={16} aria-hidden="true" />外观与动效</button>
      </div>
    </div>
  );
}

export function HeaderMoreMenu({
  open,
  busy,
  readOnly,
  onClose,
  onCharacters,
  onRoleplay,
  onSessions,
  onShare,
  onSettings,
  onRefresh,
}: {
  open: boolean;
  busy: boolean;
  readOnly: boolean;
  onClose: () => void;
  onCharacters: () => void;
  onRoleplay: () => void;
  onSessions: () => void;
  onShare: () => void;
  onSettings: () => void;
  onRefresh: () => void;
}) {
  if (!open) return null;
  const pick = (action: () => void) => () => {
    action();
    onClose();
  };
  return (
    <div className="settings-menu-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="settings-menu header-more-menu" role="menu" aria-label="更多操作" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" role="menuitem" onClick={pick(onCharacters)}><IdCard size={16} aria-hidden="true" />角色</button>
        <button type="button" role="menuitem" disabled={busy || readOnly} onClick={pick(onRoleplay)}><Drama size={16} aria-hidden="true" />扮演</button>
        <button type="button" role="menuitem" onClick={pick(onSessions)}><MessageSquare size={16} aria-hidden="true" />会话</button>
        <i className="settings-menu-separator" aria-hidden="true" />
        {!readOnly && (
          <button type="button" role="menuitem" onClick={pick(onShare)}><Share2 size={16} aria-hidden="true" />分享</button>
        )}
        {!readOnly && (
          <button type="button" role="menuitem" onClick={pick(onSettings)}><Settings size={16} aria-hidden="true" />设置</button>
        )}
        <button type="button" role="menuitem" onClick={pick(onRefresh)}><RefreshCw size={16} aria-hidden="true" />刷新</button>
      </div>
    </div>
  );
}

export function WorkspaceShell({ mode, documentsCollapsed, readOnly = false, children }: {
  mode: WorkspaceMode;
  documentsCollapsed: boolean;
  readOnly?: boolean;
  children: React.ReactNode;
}) {
  return <div className={`app workspace-${mode}${documentsCollapsed ? " documents-collapsed" : ""}${readOnly ? " readonly" : ""}`}>{children}</div>;
}
