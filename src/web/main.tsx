import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  BookOpenText,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  Drama,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  IdCard,
  Library,
  Menu,
  MessageSquare,
  Minus,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Save,
  Settings,
  Sun,
  Trash2,
  WandSparkles,
  Wifi,
  X,
} from "lucide-react";
import { Marked, type Token, type Tokens } from "marked";
import { documentDiff, renderDiffHtml } from "../diff";
import { characterEditorSaveInput } from "../character_editor_payload";
import { CharacterEditor } from "./character_editor";
import {
  apiUrl,
  buildEntryUrl,
  ensureConnection,
  failoverFrom,
  getAccessToken,
  getActiveBase,
  getConnectionInfo,
  initConnection,
  setConnectionPreference,
  startConnectionMonitor,
  subscribeConnection,
  type ConnectionInfo,
  type ConnectionPreference,
} from "./connection";
import { ModelConfig, type ProviderCatalog, type ScenePipelineSettings } from "./model_config";
import "./style.css";

type Proposal = {
  id: number;
  path: string;
  summary: string;
  beforeContent: string;
  afterContent: string;
  status: "pending" | "accepted" | "rejected" | "stale";
};
type Message = {
  id: number;
  role: string;
  content: string;
  channel?: "agent" | "roleplay";
  variantGroupId?: string;
  variantCount?: number;
};
type MessageVersionBundle = {
  current: number;
  versions: Array<{ key: string; content: string; createdAt: string }>;
};
type RoleplayInterlocutor = {
  name: string;
  identity: string;
  relationship: string;
  knowledge: string;
  scene: string;
  goal: string;
};
type SavedRoleplayInterlocutor = RoleplayInterlocutor & {
  id: number;
  targetCharacterId?: number;
  createdAt: string;
  updatedAt: string;
};
type RoleplayParticipant = {
  kind: "simple" | "normal" | "generated";
  id?: number;
  name: string;
  card: RoleplayInterlocutor;
};
type ActiveRoleplayState = {
  performer: RoleplayParticipant;
  identity: RoleplayParticipant;
  scene?: RoleplayScene;
};
type ChangeSet = {
  id: number;
  summary: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  undone: boolean;
  files: Array<{
    id: number;
    operation: "write" | "patch" | "move" | "delete";
    path: string;
    targetPath?: string;
    beforeContent: string;
    afterContent: string;
  }>;
  characterChanges: Array<{ characterId: number; reason: string; changes: Array<{ op: string }> }>;
};
type RoleplayInputMode = "dialogue" | "director";
type RoleplayScene = {
  id: number; name: string; setting: string; premise: string; tone: string; timelineAnchor: string;
  performerGoal: string; identityGoal: string; stakes: string[]; openingVariants: string[];
  endConditions: string[]; loreBindings: string[]; revision: number; createdAt: string; updatedAt: string;
};
type RoleplayMemoryFact = {
  id: number; sessionId: string; contextKey: string; kind: "event" | "promise" | "relationship" | "secret" | "preference";
  content: string; sourceMessageId?: number; knownBy: Array<"public" | "performer" | "identity">;
  importance: number; status: "active" | "superseded" | "retracted"; pinned: boolean; createdAt: string; updatedAt: string;
};
type RoleplaySessionMemory = { performerKey: string; summary: string; summarizedThroughId: number; turnCount: number; sameBeatTurns: number };
type RoleplaySetupPhase = "generating" | "saving" | "entering";
const ROLEPLAY_SETUP_PHASE_LABELS: Record<RoleplaySetupPhase, string> = {
  generating: "\u6b63\u5728\u751f\u6210\u7b80\u6613\u89d2\u8272\u5361",
  saving: "\u6b63\u5728\u4fdd\u5b58\u7b80\u6613\u89d2\u8272\u5361",
  entering: "\u6b63\u5728\u8fdb\u5165\u89d2\u8272\u626e\u6f14",
};
const ROLEPLAY_SETUP_STEP_LABELS: Record<RoleplaySetupPhase, string> = {
  generating: "\u751f\u6210\u8eab\u4efd",
  saving: "\u4fdd\u5b58\u89d2\u8272\u5361",
  entering: "\u51c6\u5907\u4f1a\u8bdd",
};

function roleplaySetupPhases(persist: boolean): RoleplaySetupPhase[] {
  return persist ? ["generating", "saving", "entering"] : ["generating", "entering"];
}
type RoleplaySceneDraft = Omit<RoleplayScene, "id" | "revision" | "createdAt" | "updatedAt"> & { id?: number };
const emptyRoleplayScene = (): RoleplaySceneDraft => ({
  name: "", setting: "", premise: "", tone: "", timelineAnchor: "", performerGoal: "", identityGoal: "",
  stakes: [], openingVariants: [], endConditions: [], loreBindings: [],
});
type RoleplayFactDraft = Omit<RoleplayMemoryFact, "id" | "sessionId" | "contextKey" | "createdAt" | "updatedAt"> & { id?: number };
type DocumentData = { content: string; hash: string };
type DocumentVersionMeta = {
  id: number;
  path: string;
  createdAt: string;
  summary: string;
  isCurrent: boolean;
  createdFile: boolean;
  undone?: boolean;
};
type DocumentVersionDetail = DocumentVersionMeta & {
  beforeContent: string;
  afterContent: string;
};
type MarkdownHeading = { id: string; level: number; text: string };
type Temporal = { sourceRefs: Array<{ type: "outline" | "document" | "manual"; ref: string; note?: string }>; validFrom?: string; validUntil?: string };
type TextEntry = Temporal & { id: string; label: string; description: string };
type Goal = Temporal & { id: string; category: "longTerm" | "current"; status: "active" | "achieved" | "abandoned" | "blocked" | "unknown"; priority: number; summary: string; stakes: string; obstacles: string[] };
type Relationship = Temporal & { id: string; characterId: number; type: string; description: string; attitude: string; status: "active" | "ended" | "strained" | "unknown" };
type Competency = Temporal & { id: string; name: string; summary: string; level: string; unlocked: boolean; description: string; resources: string[]; limitations: string[]; costs: string[] };
type StoryState = Temporal & { id: string; outlineNodeId?: string; unanchored?: boolean; location: string; physical: string; emotion: string; knowledge: TextEntry[]; beliefs: TextEntry[]; intentions: string[]; temporaryGoals: Goal[]; notes: string };
type Character = {
  schemaVersion: 3; id: number;
  identity: { name: string; aliases: string[]; tags: string[]; narrativeRole: string; summary: string };
  profile: { appearanceSummary: string; distinguishingFeatures: string[]; backgroundSummary: string; biography: string };
  psychology: { summary: string; traits: TextEntry[]; values: TextEntry[]; fears: TextEntry[]; conflicts: TextEntry[] };
  motivations: Goal[]; voice: { summary: string; register: string; diction: string[]; verbalHabits: string[]; avoidedExpressions: string[]; examples: string[] };
  competencies: Competency[]; relationships: Relationship[]; storyStates: StoryState[]; experiences: TextEntry[]; notes: string; updatedAt: string;
};
type CharacterDraft = Omit<Character, "id" | "updatedAt"> & { id?: number };
type StepUsage = {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
  cost: number;
  currency: string;
  estimated?: boolean;
  cacheHitRate?: number;
  callBreakdown?: Array<{
    callKind: string;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    cost: number;
    currency: string;
    estimated?: boolean;
  }>;
  requestComponents?: Array<{
    kind: "stable_system" | "dynamic_system" | "tool_schema" | "user" | "assistant" | "tool_result" | "other";
    label: string;
    characters: number;
    estimatedTokens: number;
    callKind?: string;
  }>;
};
type StreamStep = {
  id: number;
  output: string;
  reasoning: string;
  tools: string[];
  status: "running" | "completed" | "failed";
  expanded: boolean;
  usage?: StepUsage;
};
type StoredStepTrail = {
  sessionId: string;
  messageId: number;
  steps: StreamStep[];
  updatedAt: string;
};
type AgentJob = {
  id: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
};
type PermissionMode = "ask" | "auto" | "plan";
type AgentTodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
};
type AgentStreamEvent = {
  type: string;
  step?: number;
  text?: string;
  channel?: "output" | "reasoning";
  name?: string;
  message?: string;
  sessionId?: string;
  question?: string;
  options?: string[];
  proposal?: { id: number; path: string; summary: string; beforeContent: string; afterContent: string; status: "pending" | "accepted" | "rejected" | "stale" };
  changeSet?: ChangeSet;
  usage?: Usage;
  call?: StepUsage;
  callKind?: string;
  todos?: AgentTodoItem[];
  mode?: PermissionMode;
};
type Usage = {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
  cost: number;
  currency: string;
  lastPromptTokens: number;
  cacheHitRate?: number;
};
type Provider = {
  provider: "deepseek" | "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  source: "project" | "environment";
  pricing: {
    billingMode?: "metered" | "unmetered";
    cacheHit: number;
    cacheMiss: number;
    output: number;
    currency: "CNY" | "USD";
    contextWindow: number;
    peakBilling?: {
      timezone: string;
      windows: Array<{ start: string; end: string }>;
      cacheHit: number;
      cacheMiss: number;
      output: number;
    };
  };
  temperature?: number;
  topP?: number;
};
type StyleTemplateInfo = {
  id: string;
  name: string;
  description: string;
  systemPromptAddition: string;
  exampleContent: string;
  exampleNotes: string;
  suggestedTemperature: number;
  suggestedTopP: number;
  builtIn?: boolean;
  customized?: boolean;
  /** Built-in templates cannot be edited or overridden. */
  readOnly?: boolean;
};
type StyleTemplateDraft = StyleTemplateInfo & { isNew: boolean };
type State = {
  config: { title: string; style?: string };
  documents: string[];
  documentFolders: string[];
  hiddenDocuments: string[];
  hiddenFolders: string[];
  sessionId: string;
  messages: Message[];
  messagesHasMore: boolean;
  proposals: Proposal[];
  changeSets: ChangeSet[];
  sessions: Array<{ id: string; title: string; updatedAt: string; autoTitleDone?: boolean }>;
  characters: Character[];
  roleplayInterlocutors: SavedRoleplayInterlocutor[];
  roleplayScenes: RoleplayScene[];
  activeRoleplay: ActiveRoleplayState | null;
  roleplayMemory: RoleplaySessionMemory | null;
  roleplayMemoryFacts: RoleplayMemoryFact[];
  usage: Usage;
  provider: Provider;
  providerCatalog: ProviderCatalog;
  activeJobs?: AgentJob[];
  styleTemplates?: StyleTemplateInfo[];
  todos?: AgentTodoItem[];
  agentSettings?: { permissionMode: PermissionMode; scenePipeline: ScenePipelineSettings };
  projectInstructions?: string | null;
  skills?: Array<{ id: string; name: string; description: string }>;
};

const PERMISSION_MODES: Array<{ id: PermissionMode; label: string; hint: string }> = [
  { id: "ask", label: "Ask", hint: "提案需审批" },
  { id: "auto", label: "Auto", hint: "提案自动写入" },
  { id: "plan", label: "Plan", hint: "只读规划" },
];

function todoStatusMark(status: AgentTodoItem["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "›";
  if (status === "cancelled") return "–";
  return "○";
}

type TreeNode = {
  name: string;
  path: string;
  kind: "file" | "folder";
  children: TreeNode[];
  hidden: boolean;
};

const EMPTY_CHARACTER: CharacterDraft = {
  schemaVersion: 3, identity: { name: "", aliases: [], tags: [], narrativeRole: "", summary: "" },
  profile: { appearanceSummary: "", distinguishingFeatures: [], backgroundSummary: "", biography: "" },
  psychology: { summary: "", traits: [], values: [], fears: [], conflicts: [] }, motivations: [],
  voice: { summary: "", register: "", diction: [], verbalHabits: [], avoidedExpressions: [], examples: [] },
  competencies: [], relationships: [], storyStates: [], experiences: [], notes: "",
};
/** Visual UI themes (workspace chrome). Not writing style templates. */
type UiThemeId = "light" | "dark" | "ink" | "rose" | "ocean" | "graphite";
type WorkspaceMode = "split" | "editor-focus" | "agent-focus";
type ManagementView = "characters" | "sessions" | "models";

type UiTheme = {
  id: UiThemeId;
  name: string;
  tag: string;
  description: string;
  example: string;
  /** Mini preview swatches: bg, surface, surface2, border, accent, text */
  preview: { bg: string; surface: string; surface2: string; border: string; accent: string; text: string };
  dark: boolean;
};

const UI_THEMES: UiTheme[] = [
  {
    id: "light",
    name: "云白",
    tag: "中性浅色",
    description: "中性灰白工作台，适合白天写作与长篇阅读。",
    example: "正文写作、资料整理与审阅",
    preview: { bg: "#f4f6f7", surface: "#ffffff", surface2: "#f7f9fa", border: "#d8dee2", accent: "#0f766e", text: "#182126" },
    dark: false,
  },
  {
    id: "dark",
    name: "夜幕",
    tag: "中性深色",
    description: "中性深灰工作台，减少夜间长时间工作的眩光。",
    example: "夜间写作、密集 Agent 会话",
    preview: { bg: "#111719", surface: "#182023", surface2: "#1d272a", border: "#344044", accent: "#2dd4bf", text: "#e5ecee" },
    dark: true,
  },
  {
    id: "ink",
    name: "纸墨",
    tag: "朱红",
    description: "清晰纸面与克制朱红强调。",
    example: "校对与出版排版",
    preview: { bg: "#eef0ef", surface: "#fbfbf8", surface2: "#f3f4f1", border: "#d5d9d5", accent: "#b44232", text: "#191d1c" },
    dark: false,
  },
  {
    id: "rose",
    name: "冷樱",
    tag: "莓红",
    description: "冷灰底色与莓红强调。",
    example: "人物与情感线写作",
    preview: { bg: "#f3f2f5", surface: "#fefcfe", surface2: "#f7f4f7", border: "#ded8df", accent: "#a73d68", text: "#262027" },
    dark: false,
  },
  {
    id: "ocean",
    name: "海盐",
    tag: "海蓝",
    description: "冷白工作面与深海蓝强调。",
    example: "规划与资料整理",
    preview: { bg: "#edf2f4", surface: "#fbfdfe", surface2: "#f2f6f7", border: "#d2dde1", accent: "#176b87", text: "#17252b" },
    dark: false,
  },
  {
    id: "graphite",
    name: "石墨",
    tag: "琥珀深色",
    description: "石墨灰工作面与琥珀强调。",
    example: "夜间审阅与长会话",
    preview: { bg: "#121415", surface: "#1c1f20", surface2: "#222627", border: "#3a4042", accent: "#e0ae45", text: "#ecebea" },
    dark: true,
  },
];

const UI_THEME_IDS = new Set<string>(UI_THEMES.map((item) => item.id));
const AGENT_HIDDEN_CHARACTER_CARDS_KEY = "writer-agent-hidden-character-cards";

function loadAgentHiddenCharacterCards(): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(AGENT_HIDDEN_CHARACTER_CARDS_KEY) || "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function loadUiTheme(): UiThemeId {
  const stored = localStorage.getItem("writer-ui-theme") || localStorage.getItem("writer-theme");
  if (stored && UI_THEME_IDS.has(stored)) return stored as UiThemeId;
  if (stored === "aurora") return "ocean";
  if (stored === "sakura") return "rose";
  if (stored === "carbon") return "graphite";
  if (stored === "parchment") return "light";
  if (stored === "midnight") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function loadWorkspaceMode(): WorkspaceMode {
  const stored = localStorage.getItem("writer-workspace-mode");
  return stored === "editor-focus" || stored === "agent-focus" ? stored : "split";
}

function IconButton({ label, children, className = "", onClick, disabled = false }: {
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

function LayoutControls({ mode, documentsCollapsed, onModeChange, onToggleDocuments }: {
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

function SettingsMenu({ open, theme, connectionAvailable, onClose, onTheme, onModels, onStyle, onConnection, onRefresh }: {
  open: boolean;
  theme: UiThemeId;
  connectionAvailable: boolean;
  onClose: () => void;
  onTheme: () => void;
  onModels: () => void;
  onStyle: () => void;
  onConnection: () => void;
  onRefresh: () => void;
}) {
  if (!open) return null;
  return (
    <div className="settings-menu-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="settings-menu" role="menu" aria-label="设置" onMouseDown={(event) => event.stopPropagation()}>
        <button role="menuitem" onClick={onTheme}>{UI_THEMES.find((item) => item.id === theme)?.dark ? <Moon size={16} /> : <Sun size={16} />}界面主题</button>
        <button role="menuitem" onClick={onModels}><Settings size={16} />模型与场景链</button>
        <button role="menuitem" onClick={onStyle}><WandSparkles size={16} />写作风格</button>
        <button role="menuitem" disabled={!connectionAvailable} onClick={onConnection}><Wifi size={16} />连接设置</button>
        <span className="settings-menu-separator" />
        <button role="menuitem" onClick={onRefresh}><RefreshCw size={16} />刷新工作区</button>
      </div>
    </div>
  );
}

function WorkspaceShell({ mode, documentsCollapsed, children }: {
  mode: WorkspaceMode;
  documentsCollapsed: boolean;
  children: React.ReactNode;
}) {
  return <div className={`app workspace-${mode}${documentsCollapsed ? " documents-collapsed" : ""}`}>{children}</div>;
}

const token = initConnection();

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${getAccessToken() || token}` };
  if (init?.body != null) headers["content-type"] = "application/json";
  if (init?.headers) Object.assign(headers, init.headers);

  const run = async () => {
    const response = await fetch(apiUrl(path), { ...init, headers });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { error: text.slice(0, 200) };
      }
    }
    return { response, body };
  };

  try {
    let { response, body } = await run();
    if (!response.ok && response.status >= 502) {
      if (await failoverFrom(getActiveBase())) {
        ({ response, body } = await run());
      }
    }
    if (!response.ok) throw new Error((body.error as string) || `Request failed: ${response.status}`);
    return body as T;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Request failed:")) throw error;
    if (await failoverFrom(getActiveBase())) {
      const { response, body } = await run();
      if (!response.ok) throw new Error((body.error as string) || `Request failed: ${response.status}`);
      return body as T;
    }
    throw error;
  }
}

/** fetch 包装：用于 SSE 等非 JSON 请求，失败时自动 failover 一次。 */
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${getAccessToken() || token}`);
  }
  const attempt = () => fetch(apiUrl(path), { ...init, headers });
  try {
    const response = await attempt();
    if (response.ok || response.status < 502) return response;
    if (await failoverFrom(getActiveBase())) return attempt();
    return response;
  } catch (error) {
    if (await failoverFrom(getActiveBase())) return attempt();
    throw error;
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function activeStepIndex(steps: StreamStep[]): number {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].status === "running") return i;
  }
  return -1;
}

const STEP_TRAIL_STORAGE_KEY = "writer-agent-step-trails";

function readStepTrailMap(): Record<string, StoredStepTrail> {
  try {
    const raw = localStorage.getItem(STEP_TRAIL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, StoredStepTrail>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadStepTrail(sessionId: string): StoredStepTrail | null {
  if (!sessionId) return null;
  const trail = readStepTrailMap()[sessionId];
  if (!trail || !Array.isArray(trail.steps) || !trail.steps.length) return null;
  return trail;
}

function saveStepTrail(sessionId: string, messageId: number, steps: StreamStep[]): void {
  if (!sessionId || !steps.length) return;
  // Only persist completed trails against real message ids (not optimistic temp ids).
  if (!Number.isFinite(messageId) || messageId <= 0) return;
  const map = readStepTrailMap();
  map[sessionId] = {
    sessionId,
    messageId,
    steps: steps.map((step) => ({ ...step, expanded: false })),
    updatedAt: new Date().toISOString(),
  };
  // Cap stored sessions to avoid unbounded localStorage growth.
  const entries = Object.entries(map).sort((a, b) => (b[1].updatedAt || "").localeCompare(a[1].updatedAt || ""));
  const trimmed = Object.fromEntries(entries.slice(0, 40));
  try {
    localStorage.setItem(STEP_TRAIL_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota / private mode */
  }
}

function clearStepTrail(sessionId: string): void {
  if (!sessionId) return;
  const map = readStepTrailMap();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  try {
    localStorage.setItem(STEP_TRAIL_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function formatStepCost(usage: StepUsage): string | null {
  if (!(usage.cost > 0)) return null;
  const symbol = usage.currency === "CNY" ? "¥" : "$";
  return `${symbol}${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(3)}`;
}

function stepUsageTitle(usage: StepUsage): string {
  const parts = [
    usage.estimated ? "估算" : null,
    `输入 ${usage.promptTokens.toLocaleString()}`,
    `输出 ${usage.completionTokens.toLocaleString()}`,
    `缓存命中 ${usage.cacheHitTokens.toLocaleString()}`,
    usage.cacheHitRate !== undefined ? `真实命中率 ${(usage.cacheHitRate * 100).toFixed(1)}%` : null,
    usage.cost > 0
      ? `费用 ${usage.currency === "CNY" ? "¥" : "$"}${usage.cost.toFixed(6)}`
      : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Compact per-step usage: in · out · cache · cost (no Σ total). */
function StepTokenBadge({ usage, pending }: { usage?: StepUsage; pending?: boolean }) {
  if (!usage) {
    return (
      <span className={`agent-step-tokens pending`} title={pending ? "等待本步 token 统计…" : "本步未拿到 token 统计"}>
        {pending ? "token…" : "—"}
      </span>
    );
  }
  const cost = formatStepCost(usage);
  return (
    <span
      className={`agent-step-tokens${usage.estimated ? " estimated" : ""}`}
      title={stepUsageTitle(usage)}
    >
      <span className="tok-metric tok-in" title={`输入 ${usage.promptTokens.toLocaleString()}`}>
        <span className="tok-ico" aria-hidden="true">I</span>
        {formatTokenCount(usage.promptTokens)}
      </span>
      <span className="tok-metric tok-out" title={`输出 ${usage.completionTokens.toLocaleString()}`}>
        <span className="tok-ico" aria-hidden="true">O</span>
        {formatTokenCount(usage.completionTokens)}
      </span>
      <span className="tok-metric tok-cache" title={`缓存命中 ${usage.cacheHitTokens.toLocaleString()}`}>
        <span className="tok-ico" aria-hidden="true">C</span>
        {formatTokenCount(usage.cacheHitTokens)}
      </span>
      {cost && <span className="tok-metric tok-cost">{cost}</span>}
      {usage.estimated && <em className="est">估</em>}
    </span>
  );
}

function sumStepUsage(steps: StreamStep[]): StepUsage | undefined {
  const withUsage = steps.filter((step) => step.usage);
  if (!withUsage.length) return undefined;
  const currency = withUsage.find((step) => step.usage!.cost > 0)?.usage?.currency
    ?? withUsage[0].usage!.currency
    ?? "CNY";
  const measured = withUsage.filter(step => !step.usage?.estimated);
  const measuredHits = measured.reduce((sum, step) => sum + (step.usage?.cacheHitTokens ?? 0), 0);
  const measuredMisses = measured.reduce((sum, step) => sum + (step.usage?.cacheMissTokens ?? 0), 0);
  return {
    promptTokens: withUsage.reduce((sum, step) => sum + (step.usage?.promptTokens ?? 0), 0),
    completionTokens: withUsage.reduce((sum, step) => sum + (step.usage?.completionTokens ?? 0), 0),
    cacheHitTokens: withUsage.reduce((sum, step) => sum + (step.usage?.cacheHitTokens ?? 0), 0),
    cacheMissTokens: withUsage.reduce((sum, step) => sum + (step.usage?.cacheMissTokens ?? 0), 0),
    totalTokens: withUsage.reduce((sum, step) => sum + (step.usage?.totalTokens ?? 0), 0),
    cost: withUsage.reduce((sum, step) => sum + (step.usage?.cost ?? 0), 0),
    currency,
    estimated: withUsage.some((step) => step.usage?.estimated),
    ...(measuredHits + measuredMisses > 0 ? { cacheHitRate: measuredHits / (measuredHits + measuredMisses) } : {}),
    requestComponents: withUsage.flatMap(step => step.usage?.requestComponents ?? []),
    callBreakdown: withUsage.flatMap(step => step.usage?.callBreakdown ?? []),
  };
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

function realCacheHitRate(usage: Pick<Usage, "cacheHitRate" | "cacheHitTokens" | "cacheMissTokens">): number {
  if (typeof usage.cacheHitRate === "number" && Number.isFinite(usage.cacheHitRate)) {
    return Math.max(0, Math.min(1, usage.cacheHitRate));
  }
  const hit = Number.isFinite(usage.cacheHitTokens) ? Math.max(0, usage.cacheHitTokens) : 0;
  const miss = Number.isFinite(usage.cacheMissTokens) ? Math.max(0, usage.cacheMissTokens) : 0;
  return hit + miss > 0 ? hit / (hit + miss) : 0;
}

function restoreTrailSteps(trail: StoredStepTrail): StreamStep[] {
  return trail.steps.map((step) => ({
    id: step.id,
    output: step.output ?? "",
    reasoning: step.reasoning ?? "",
    tools: Array.isArray(step.tools) ? step.tools : [],
    status: step.status === "running" ? "completed" : step.status,
    expanded: false,
    ...(step.usage ? { usage: step.usage } : {}),
  }));
}

/** One-line plain preview for collapsed assistant bubbles. */
function messagePreview(content: string, max = 140): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#`|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "（空回复）";
  return plain.length <= max ? plain : `${plain.slice(0, max)}…`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeMarkdownSource(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
}

/** Shared GFM parser for document reader + agent chat. */
const markdownParser = new Marked({
  gfm: true,
  // Single newlines → <br> — better for Chinese prose / novel drafts without blank lines.
  breaks: true,
  pedantic: false,
  silent: true,
});

let markdownHeadingIndex = 0;
let markdownHeadingPrefix = "";

markdownParser.use({
  renderer: {
    heading({ tokens, depth }: Tokens.Heading) {
      const text = this.parser.parseInline(tokens);
      const id = markdownHeadingPrefix
        ? ` id="${markdownHeadingPrefix}-section-${++markdownHeadingIndex}"`
        : "";
      return `<h${depth}${id}>${text}</h${depth}>\n`;
    },
    // Never execute raw HTML from documents / model output.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const safeHref = href ?? "";
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      const external = /^https?:\/\//i.test(safeHref);
      const rel = external ? ' target="_blank" rel="noreferrer noopener"' : "";
      return `<a href="${escapeHtml(safeHref)}"${titleAttr}${rel}>${text}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      const alt = escapeHtml(text || "");
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(href || "")}" alt="${alt}"${titleAttr} loading="lazy" />`;
    },
    codespan({ text }: Tokens.Codespan) {
      return `<code>${escapeHtml(text)}</code>`;
    },
    code({ text, lang }: Tokens.Code) {
      const language = lang ? ` class="language-${escapeHtml(lang.split(/\s+/)[0] ?? "")}"` : "";
      return `<pre><code${language}>${escapeHtml(text)}</code></pre>\n`;
    },
  },
});

/** Walk block tokens in render order (matches marked's heading traversal for IDs). */
function walkBlockTokens(tokens: Token[], visit: (token: Token) => void): void {
  for (const token of tokens) {
    visit(token);
    if (token.type === "blockquote" && "tokens" in token && token.tokens) {
      walkBlockTokens(token.tokens, visit);
    } else if (token.type === "list") {
      for (const item of token.items) {
        if (item.tokens) walkBlockTokens(item.tokens, visit);
      }
    }
  }
}

function markdownHeadings(content: string, prefix: string): MarkdownHeading[] {
  const normalized = normalizeMarkdownSource(content);
  if (!normalized.trim()) return [];
  const tokens = markdownParser.lexer(normalized);
  const headings: MarkdownHeading[] = [];
  let index = 0;
  walkBlockTokens(tokens, (token) => {
    if (token.type !== "heading") return;
    index += 1;
    headings.push({
      id: `${prefix}-section-${index}`,
      level: token.depth,
      text: token.text.replace(/\s+#+\s*$/, "").trim(),
    });
  });
  return headings;
}

function renderMarkdownHtml(content: string, headingPrefix?: string): string {
  const normalized = normalizeMarkdownSource(content);
  if (!normalized.trim()) return "";
  markdownHeadingIndex = 0;
  markdownHeadingPrefix = headingPrefix ?? "";
  try {
    const html = markdownParser.parse(normalized, { async: false });
    return typeof html === "string" ? html : "";
  } catch {
    // Fallback: plain escaped text so the reader never goes blank.
    return `<p>${escapeHtml(normalized).replace(/\n/g, "<br/>")}</p>`;
  }
}

function Markdown({ content, className, headingPrefix }: { content: string; className?: string; headingPrefix?: string }) {
  const html = useMemo(
    () => renderMarkdownHtml(content, headingPrefix),
    [content, headingPrefix],
  );
  return (
    <div
      className={`markdown ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html || "<p></p>" }}
    />
  );
}

/** Track-changes view: deletions strikethrough + fill, insertions background fill. */
function DocumentDiffView({ before, after }: { before: string; after: string }) {
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

function ChangeSetCard({ value, onAction }: {
  value: ChangeSet;
  onAction: (changeSet: ChangeSet, action: "accept" | "reject" | "undo" | "redo") => void;
}) {
  const stateLabel = value.status === "accepted" && value.undone ? "rolled back" : value.status;
  return (
    <div className="proposal-card change-set-card">
      <h3>Change set #{value.id}</h3>
      <p>{value.summary}</p>
      <span className="change-set-status">{stateLabel}</span>
      {value.files.map((file) => (
        <details className="change-set-file" key={file.id}>
          <summary>
            <strong>{file.operation}</strong> {file.path}{file.targetPath ? ` -> ${file.targetPath}` : ""}
          </summary>
          {file.operation !== "move" && <DocumentDiffView before={file.beforeContent} after={file.afterContent} />}
        </details>
      ))}
      {value.characterChanges.length > 0 && (
        <details className="change-set-file">
          <summary><strong>characters</strong> {value.characterChanges.length}</summary>
          {value.characterChanges.map((change) => (
            <p key={change.characterId}>#{change.characterId}: {change.reason} ({change.changes.map(item => item.op).join(", ")})</p>
          ))}
        </details>
      )}
      <div className="proposal-actions">
        {value.status === "pending" && <>
          <button onClick={() => onAction(value, "reject")}>Reject</button>
          <button className="primary" onClick={() => onAction(value, "accept")}>Accept all</button>
        </>}
        {value.status === "accepted" && !value.undone && <button onClick={() => onAction(value, "undo")}>Roll back all</button>}
        {value.status === "accepted" && value.undone && <button onClick={() => onAction(value, "redo")}>Reapply all</button>}
      </div>
    </div>
  );
}

/** Collapsible review dock (pending change-sets + proposals) docked in the agent panel. */
function ReviewDock({
  changeSets,
  proposals,
  pendingCount,
  open,
  onToggle,
  onChangeSetAction,
  onProposalDecide,
}: {
  changeSets: ChangeSet[];
  proposals: Proposal[];
  pendingCount: number;
  open: boolean;
  onToggle: () => void;
  onChangeSetAction: (changeSet: ChangeSet, action: "accept" | "reject" | "undo" | "redo") => void;
  onProposalDecide: (proposal: Proposal, action: "accept" | "reject") => void;
}) {
  const total = changeSets.length + proposals.length;
  return (
    <section className={`review-drawer${open ? " open" : ""}`} aria-label="待审阅的改动">
      <button type="button" className="review-drawer-toggle" onClick={onToggle} aria-expanded={open}>
        <span className="review-drawer-chevron" aria-hidden="true">
          <ChevronRight size={12} />
        </span>
        <span className="review-drawer-title">审阅</span>
        {pendingCount > 0 && <span className="proposal-count">{pendingCount}</span>}
        <span className="review-drawer-hint">{open ? "收起" : `${total} 项`}</span>
      </button>
      {open && (
        <div className="review-drawer-body">
          {changeSets.length > 0 && (
            <div className="review-group">
              <h4 className="review-group-head">Change sets</h4>
              {changeSets.map((changeSet) => (
                <ChangeSetCard key={changeSet.id} value={changeSet} onAction={onChangeSetAction} />
              ))}
            </div>
          )}
          {proposals.length > 0 && (
            <div className="review-group">
              <h4 className="review-group-head">Proposals</h4>
              {proposals.map((p) => (
                <div className="proposal-card" key={p.id}>
                  <h3>{p.path}</h3>
                  <p>{p.summary}</p>
                  <div className="proposal-actions">
                    <button onClick={() => onProposalDecide(p, "reject")}>Reject</button>
                    <button className="primary" onClick={() => onProposalDecide(p, "accept")}>Accept</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function formatVersionTime(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function buildTree(docs: string[], folders: string[], hiddenDocs: string[], hiddenFolders: string[]): TreeNode[] {
  const folderKey = (path: string) => path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const hiddenFolderKeys = new Set(hiddenFolders.map(folderKey));
  const folderMap = new Map<string, TreeNode>();
  for (const path of folders) {
    const key = folderKey(path);
    const parts = key.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    folderMap.set(key, {
      name: parts[parts.length - 1],
      path: key,
      kind: "folder",
      children: [],
      hidden: hiddenFolderKeys.has(key),
    });
  }

  const roots: TreeNode[] = [];
  for (const [key, node] of folderMap) {
    const slash = key.lastIndexOf("/");
    const parentPath = slash >= 0 ? key.slice(0, slash) : "";
    const parent = folderMap.get(parentPath);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const path of docs) {
    const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = normalizedPath.split("/");
    const name = parts.pop()!;
    const parentPath = parts.join("/");
    const fileNode: TreeNode = {
      name,
      path: normalizedPath,
      kind: "file",
      children: [],
      hidden: hiddenDocs.includes(path) || hiddenDocs.includes(normalizedPath),
    };

    const parent = folderMap.get(parentPath);
    if (parent) {
      parent.children.push(fileNode);
    } else {
      roots.push(fileNode);
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return nodes;
  return nodes.flatMap((node) => {
    const children = filterTree(node.children, normalized);
    const matches = node.name.toLocaleLowerCase().includes(normalized)
      || node.path.toLocaleLowerCase().includes(normalized);
    if (matches) return [node];
    return children.length ? [{ ...node, children }] : [];
  });
}

function collectFolderPaths(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "folder"
    ? [node.path, ...collectFolderPaths(node.children)]
    : []);
}

function countFiles(node: TreeNode): number {
  return node.kind === "file" ? 1 : node.children.reduce((total, child) => total + countFiles(child), 0);
}

function FileTreeItem({
  node,
  depth,
  activePath,
  ancestorHidden = false,
  onSelect,
  onRename,
  onDelete,
  onToggleHidden,
  onMoveNode,
  onDuplicate,
  onNewChild,
  expandedFolders,
  setExpandedFolders,
}: {
  node: TreeNode;
  depth: number;
  activePath: string;
  ancestorHidden?: boolean;
  onSelect: (path: string) => void;
  onRename: (oldPath: string, kind: "file" | "folder") => void;
  onDelete: (path: string, kind: "file" | "folder") => void;
  onToggleHidden: (path: string, kind: "file" | "folder", current: boolean) => void;
  onMoveNode: (path: string, kind: "file" | "folder", targetFolder: string) => void;
  onDuplicate: (path: string) => void;
  onNewChild: (parentFolder: string, kind: "file" | "folder") => void;
  expandedFolders: Set<string>;
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const isExpanded = node.kind === "folder" && expandedFolders.has(node.path);
  const isEffectivelyHidden = ancestorHidden || node.hidden;
  const [dragOver, setDragOver] = useState(false);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/x-writer-node", JSON.stringify({ path: node.path, kind: node.kind }));
    e.dataTransfer.setData("text/plain", node.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (node.kind !== "folder") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const raw = e.dataTransfer.getData("application/x-writer-node");
    const payload = raw ? JSON.parse(raw) as { path: string; kind: "file" | "folder" } : null;
    if (payload && node.kind === "folder" && payload.path !== node.path) {
      onMoveNode(payload.path, payload.kind, node.path);
    }
  };

  const toggleFolder = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) {
        // Collapsing a branch also resets every nested folder. Reopening the
        // parent should not leave descendants visually expanded out of sync.
        for (const path of next) {
          if (path === node.path || path.startsWith(`${node.path}/`)) next.delete(path);
        }
      } else {
        next.add(node.path);
      }
      return next;
    });
  };

  const handleClick = () => {
    if (node.kind === "file") onSelect(node.path);
    else toggleFolder({ stopPropagation: () => {} } as React.MouseEvent);
  };

  return (
    <div className={`tree-node ${isEffectivelyHidden ? "agent-hidden" : ""} ${node.kind}`}>
      <div
        className={`tree-row ${activePath === node.path ? "active" : ""} ${dragOver ? "drop-target" : ""}`}
        style={{ paddingLeft: depth * 16 + 4 }}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        aria-expanded={node.kind === "folder" ? isExpanded : undefined}
      >
        {node.kind === "folder" ? (
          <span className={`tree-arrow ${isExpanded ? "expanded" : ""}`} onClick={toggleFolder} aria-hidden="true">
            <ChevronRight size={13} />
          </span>
        ) : (
          <span className="tree-arrow-spacer" />
        )}
        <span className={`tree-icon ${node.kind === "folder" ? (isExpanded ? "folder-open" : "folder") : "file"}`} aria-hidden="true">
          {node.kind === "folder" ? (
            isExpanded ? (
              <FolderOpen size={15} />
            ) : (
              <Folder size={15} />
            )
          ) : (
            <FileText size={14} />
          )}
        </span>
        <span className="tree-label" title={node.path}>
          <span className="tree-name">{node.name}</span>
          {node.kind === "folder" && <span className="tree-count">{countFiles(node)}</span>}
        </span>
        <div className="tree-actions">
          <button
            className="tree-action-btn"
            title={node.hidden ? "对 AI 显示" : "对 AI 隐藏"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleHidden(node.path, node.kind, node.hidden);
            }}
          >
            {isEffectivelyHidden ? (
              <EyeOff size={13} aria-hidden="true" />
            ) : (
              <Eye size={13} aria-hidden="true" />
            )}
          </button>
          {node.kind === "folder" && (
            <>
              <button
                className="tree-action-btn"
                title="在此新建文档"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewChild(node.path, "file");
                }}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
              <button
                className="tree-action-btn"
                title="在此新建文件夹"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewChild(node.path, "folder");
                }}
              >
                <FolderPlus size={13} aria-hidden="true" />
              </button>
            </>
          )}
          {node.kind === "file" && (
            <button
              className="tree-action-btn"
              title="创建副本"
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate(node.path);
              }}
            >
              <Copy size={13} aria-hidden="true" />
            </button>
          )}
          <button
            className="tree-action-btn"
            title="重命名"
            onClick={(e) => {
              e.stopPropagation();
              onRename(node.path, node.kind);
            }}
          >
            <Pencil size={13} aria-hidden="true" />
          </button>
          <button
            className="tree-action-btn danger"
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.path, node.kind);
            }}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
      {isExpanded && (
        <div className="tree-children">
        {node.children.map((child) => (
          <FileTreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            ancestorHidden={isEffectivelyHidden}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
            onToggleHidden={onToggleHidden}
            onMoveNode={onMoveNode}
            onDuplicate={onDuplicate}
            onNewChild={onNewChild}
            expandedFolders={expandedFolders}
            setExpandedFolders={setExpandedFolders}
          />
        ))}
        </div>
      )}
    </div>
  );
}

function AgentStepCard({ step, onToggle }: { step: StreamStep; onToggle: () => void }) {
  const label =
    step.status === "running"
      ? `Step ${step.id}`
      : step.status === "failed"
        ? `Step ${step.id} failed`
        : `Step ${step.id} done`;

  return (
    <article className={`agent-step ${step.status}`}>
      <button className="agent-step-summary" onClick={onToggle} type="button">
        <span className="agent-step-indicator" />
        <strong>{label}</strong>
        <StepTokenBadge usage={step.usage} pending={step.status === "running"} />
        {step.tools.length > 0 && (() => {
          const maxVisible = 2;
          const visible = step.tools.slice(0, maxVisible);
          const hidden = step.tools.length - visible.length;
          const allTitle = step.tools.join(" · ");
          return (
            <span className="agent-step-tools" title={allTitle}>
              {visible.map((tool, index) => (
                <span className="tool-chip" key={`${step.id}-${index}-${tool}`} title={tool}>
                  {tool}
                </span>
              ))}
              {hidden > 0 && (
                <span className="tool-chip tool-chip-more" title={step.tools.slice(maxVisible).join(" · ")}>
                  +{hidden}
                </span>
              )}
            </span>
          );
        })()}
        <span className="agent-step-chevron" aria-hidden="true">
          {step.expanded ? "▴" : "▾"}
        </span>
      </button>
      {step.expanded && (
        <div className="agent-step-content">
          <div className="agent-step-usage-detail">
            {step.usage
              ? (
                <>
                  本步 token{step.usage.estimated ? "（估算）" : ""}：
                  输入 {step.usage.promptTokens.toLocaleString()}
                  {" · "}输出 {step.usage.completionTokens.toLocaleString()}
                  {" · "}缓存 {step.usage.cacheHitTokens.toLocaleString()}
                  {step.usage.cacheHitRate !== undefined
                    ? ` · 命中率 ${(step.usage.cacheHitRate * 100).toFixed(1)}%`
                    : ""}
                  {step.usage.cost > 0
                    ? ` · ${step.usage.currency === "CNY" ? "¥" : "$"}${step.usage.cost.toFixed(6)}`
                    : ""}
                </>
              )
              : "本步暂无 token 数据（供应商未返回 usage 且未能估算）"}
          </div>
          {(step.usage?.callBreakdown?.length ?? 0) > 1 ? (
            <details className="agent-step-context-breakdown" open>
              <summary>模型调用明细</summary>
              <div className="agent-step-context-list">
                {step.usage!.callBreakdown!.map((call, index) => {
                  const measured = call.cacheHitTokens + call.cacheMissTokens;
                  const rate = measured > 0 ? call.cacheHitTokens / measured : 0;
                  return (
                    <div className="agent-step-context-row" key={`${call.callKind}-${index}`}>
                      <span>{call.callKind}</span>
                      <span>
                        输入 {call.promptTokens.toLocaleString()} · 缓存 {(rate * 100).toFixed(1)}% · 输出 {call.completionTokens.toLocaleString()}
                        {call.cost > 0 ? ` · ${call.currency === "CNY" ? "¥" : "$"}${call.cost.toFixed(6)}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </details>
          ) : null}
          {step.usage?.requestComponents?.length ? (
            <details className="agent-step-context-breakdown">
              <summary>请求上下文组成（发送前估算）</summary>
              <div className="agent-step-context-list">
                {[...step.usage.requestComponents]
                  .sort((a, b) => b.estimatedTokens - a.estimatedTokens)
                  .map((component, index) => (
                    <div className="agent-step-context-row" key={`${component.callKind ?? "call"}-${component.kind}-${index}`}>
                      <span>{component.callKind ? `${component.callKind} · ` : ""}{component.label}</span>
                      <span>{component.estimatedTokens.toLocaleString()} tok · {component.characters.toLocaleString()} chars</span>
                    </div>
                  ))}
              </div>
            </details>
          ) : null}
          {step.reasoning && (
            <div className="agent-step-reasoning">
              <Markdown content={step.reasoning} />
            </div>
          )}
          {step.output && <Markdown content={step.output} />}
          {!step.reasoning && !step.output && (
            <p className="agent-step-waiting">Waiting for model response…</p>
          )}
        </div>
      )}
    </article>
  );
}

function WorkspaceTopbar({
  title,
  connection,
  model,
  usagePct,
  usageCost,
  usageCurrency,
  usageUnmetered,
  busy,
  theme,
  settingsOpen,
  workspaceMode,
  documentsCollapsed,
  onCharacters,
  onRoleplay,
  onSessions,
  onUsage,
  onConnection,
  onToggleSettings,
  onCloseSettings,
  onTheme,
  onModels,
  onStyle,
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
  theme: UiThemeId;
  settingsOpen: boolean;
  workspaceMode: WorkspaceMode;
  documentsCollapsed: boolean;
  onCharacters: () => void;
  onRoleplay: () => void;
  onSessions: () => void;
  onUsage: () => void;
  onConnection: () => void;
  onToggleSettings: () => void;
  onCloseSettings: () => void;
  onTheme: () => void;
  onModels: () => void;
  onStyle: () => void;
  onRefresh: () => void;
  onModeChange: (mode: WorkspaceMode) => void;
  onToggleDocuments: () => void;
}) {
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
      </div>
      <div className="header-right">
        <LayoutControls
          mode={workspaceMode}
          documentsCollapsed={documentsCollapsed}
          onModeChange={onModeChange}
          onToggleDocuments={onToggleDocuments}
        />
        <nav className="nav-cluster" aria-label="工作区入口">
          <button type="button" className="ghost nav-action" aria-label="角色" title="角色" onClick={onCharacters}><IdCard size={17} aria-hidden="true" /><span>角色</span></button>
          <button type="button" className="ghost nav-action" aria-label="扮演" title="扮演" disabled={busy} onClick={onRoleplay}><Drama size={17} aria-hidden="true" /><span>扮演</span></button>
          <button type="button" className="ghost nav-action" aria-label="会话" title="会话" onClick={onSessions}><MessageSquare size={16} aria-hidden="true" /><span>会话</span></button>
        </nav>
        <button className="usage-strip" onClick={onUsage} title="当前会话用量与计费明细">
          <span className="model-name">{model}</span>
          <span className="context-meter" title={`${usagePct}% context`} aria-hidden="true">
            <i style={{ width: `${Math.min(100, Math.max(2, usagePct))}%` }} />
          </span>
          <span>{usagePct}%</span>
          <span className="usage-cost">{usageUnmetered ? "非按量计费" : `${usageCurrency === "CNY" ? "¥" : "$"}${usageCost.toFixed(4)}`}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        <div className="settings-anchor">
          <IconButton label="设置" className={settingsOpen ? "active" : ""} onClick={onToggleSettings}><Settings size={17} /></IconButton>
          <SettingsMenu
            open={settingsOpen}
            theme={theme}
            connectionAvailable={connection.dualMode}
            onClose={onCloseSettings}
            onTheme={onTheme}
            onModels={onModels}
            onStyle={onStyle}
            onConnection={onConnection}
            onRefresh={onRefresh}
          />
        </div>
      </div>
    </header>
  );
}

function mergeStepCallUsage(current: StepUsage | undefined, next: StepUsage, callKind = "unspecified"): StepUsage {
  const nextCall = {
    callKind,
    promptTokens: next.promptTokens,
    completionTokens: next.completionTokens,
    cacheHitTokens: next.cacheHitTokens,
    cacheMissTokens: next.cacheMissTokens,
    cost: next.cost,
    currency: next.currency,
    ...(next.estimated ? { estimated: true } : {}),
  };
  if (!current) return { ...next, callBreakdown: [nextCall] };
  const cacheHitTokens = current.cacheHitTokens + next.cacheHitTokens;
  const cacheMissTokens = current.cacheMissTokens + next.cacheMissTokens;
  const estimated = Boolean(current.estimated || next.estimated);
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    cacheHitTokens,
    cacheMissTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    cost: current.cost + next.cost,
    currency: current.cost > 0 ? current.currency : next.currency,
    ...(estimated ? { estimated: true } : {}),
    ...(!estimated && cacheHitTokens + cacheMissTokens > 0
      ? { cacheHitRate: cacheHitTokens / (cacheHitTokens + cacheMissTokens) }
      : {}),
    requestComponents: [...(current.requestComponents ?? []), ...(next.requestComponents ?? [])],
    callBreakdown: [...(current.callBreakdown ?? []), nextCall],
  };
}

function App() {
  const [state, setState] = useState<State>();
  const [activePath, setActivePath] = useState("");
  const [document, setDocument] = useState<DocumentData>({ content: "", hash: "" });
  const [documentDraft, setDocumentDraft] = useState("");
  const [editingDocument, setEditingDocument] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [streamSteps, setStreamSteps] = useState<StreamStep[]>([]);
  /** User message id these steps belong to. Kept after job ends; cleared on rewind / session switch. */
  const [streamStepsAnchorId, setStreamStepsAnchorId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [conversationAtBottom, setConversationAtBottom] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileTab, setMobileTab] = useState<"docs" | "editor" | "agent">("editor");
  const [reviewOpen, setReviewOpen] = useState(false);
  const prevPendingReviewRef = useRef(0);
  const [theme, setTheme] = useState<UiThemeId>(() => loadUiTheme());
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showStylePicker, setShowStylePicker] = useState(false);
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleDraft, setStyleDraft] = useState<StyleTemplateDraft | null>(null);
  const [managementView, setManagementView] = useState<ManagementView | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(loadWorkspaceMode);
  const [documentsCollapsed, setDocumentsCollapsed] = useState(() =>
    localStorage.getItem("writer-documents-collapsed") === "true",
  );
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [focusedExportBusy, setFocusedExportBusy] = useState(false);
  const [sessionBatchMode, setSessionBatchMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [messageVersionViews, setMessageVersionViews] = useState<Record<number, MessageVersionBundle>>({});
  const [composerBranch, setComposerBranch] = useState<{
    variantGroupId: string;
    channel: "agent" | "roleplay";
    fromId: number;
  } | null>(null);
  /** Edit / re-run confirmation: choose whether to keep accepted document & character changes. */
  const [branchConfirm, setBranchConfirm] = useState<{
    mode: "edit" | "rerun";
    message: Message;
  } | null>(null);
  const [agentHiddenCharacterCards, setAgentHiddenCharacterCards] = useState<Set<string>>(loadAgentHiddenCharacterCards);
  const [characterDraft, setCharacterDraft] = useState<CharacterDraft | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("writer-expanded-folders") || "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const [fileQuery, setFileQuery] = useState("");
  const [renaming, setRenaming] = useState<{ path: string; kind: "file" | "folder" } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creating, setCreating] = useState<{ parent: string; kind: "file" | "folder" } | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    Number(localStorage.getItem("writer-sidebar-w")) || 248,
  );
  const [agentWidth, setAgentWidth] = useState(() =>
    Number(localStorage.getItem("writer-agent-w")) || 380,
  );
  const [readerFontSize, setReaderFontSize] = useState(() =>
    Number(localStorage.getItem("writer-reader-fs")) || 16,
  );
  const [readerWidth, setReaderWidth] = useState(() =>
    Number(localStorage.getItem("writer-reader-w")) || 760,
  );
  const [outlineCollapsed, setOutlineCollapsed] = useState(() =>
    localStorage.getItem("writer-outline-collapsed") === "true",
  );
  /** Browse-only version history (never applied to agent context). */
  const [versionPanelOpen, setVersionPanelOpen] = useState(false);
  const [versions, setVersions] = useState<DocumentVersionMeta[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [browsingVersion, setBrowsingVersion] = useState<DocumentVersionDetail | null>(null);
  const [versionBusy, setVersionBusy] = useState(false);
  /** Experimental: roleplay voice-test against a character card. */
  const [roleplay, setRoleplay] = useState<ActiveRoleplayState | null>(null);
  const [roleplaySetup, setRoleplaySetup] = useState<{ performer: RoleplayParticipant | null; identity: RoleplayParticipant | null; scene: RoleplayScene | null; request: string; persist: boolean } | null>(null);
  const [simpleCardDraft, setSimpleCardDraft] = useState<(RoleplayInterlocutor & { id?: number }) | null>(null);
  const [roleplaySceneDraft, setRoleplaySceneDraft] = useState<RoleplaySceneDraft | null>(null);
  const [roleplayMemoryOpen, setRoleplayMemoryOpen] = useState(false);
  const [roleplayFactDraft, setRoleplayFactDraft] = useState<RoleplayFactDraft | null>(null);
  const [roleplayInputMode, setRoleplayInputMode] = useState<RoleplayInputMode>("dialogue");
  const [directorSuggestions, setDirectorSuggestions] = useState<string[]>([]);
  const [directorSuggestionBusy, setDirectorSuggestionBusy] = useState(false);
  const [directorSuggestionError, setDirectorSuggestionError] = useState("");
  const [roleplaySetupBusy, setRoleplaySetupBusy] = useState(false);
  const [roleplaySetupPhase, setRoleplaySetupPhase] = useState<RoleplaySetupPhase | null>(null);
  const [roleplaySetupElapsed, setRoleplaySetupElapsed] = useState(0);
  const [todosCollapsed, setTodosCollapsed] = useState(false);
  /** Collapsed final Assistant bubbles (steps already have their own expand state). */
  const [collapsedAssistantIds, setCollapsedAssistantIds] = useState<Set<number>>(() => new Set());
  const [resizing, setResizing] = useState<"sidebar" | "agent" | null>(null);
  const [connection, setConnection] = useState<ConnectionInfo>(() => getConnectionInfo());
  const [showConnectionPanel, setShowConnectionPanel] = useState(false);
  const [showUsagePopover, setShowUsagePopover] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionPanelMsg, setConnectionPanelMsg] = useState("");
  const abortRef = useRef<AbortController | undefined>(undefined);
  const currentJobRef = useRef<string | undefined>(undefined);
  const streamOutputRef = useRef("");
  const sessionIdRef = useRef<string | undefined>(undefined);
  const todosCompletionRef = useRef({ sessionId: "", complete: false });
  const activePathRef = useRef(activePath);
  const editingDocumentRef = useRef(editingDocument);
  activePathRef.current = activePath;
  editingDocumentRef.current = editingDocument;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const fileSearchRef = useRef<HTMLInputElement>(null);
  const documentReaderRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const conversationAtBottomRef = useRef(true);
  const composerFocusedAtBottomRef = useRef(false);
  const updateConversationBottom = useCallback((viewport: HTMLDivElement | null = conversationRef.current) => {
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const atBottom = distance <= 48;
    conversationAtBottomRef.current = atBottom;
    setConversationAtBottom(atBottom);
  }, []);
  const scrollConversationToBottom = useCallback(() => {
    const viewport = conversationRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, []);
  // Auto-open the review dock when new pending marks (change-sets / proposals) arrive.
  useEffect(() => {
    if (!state) return;
    const pending = state.proposals.filter((p) => p.status === "pending").length
      + state.changeSets.filter((c) => c.status === "pending").length;
    if (pending > prevPendingReviewRef.current) setReviewOpen(true);
    prevPendingReviewRef.current = pending;
  }, [state?.proposals, state?.changeSets]);
  useEffect(() => {
    const viewport = conversationRef.current;
    if (!viewport) return;
    conversationAtBottomRef.current = true;
    setConversationAtBottom(true);
    let frame = 0;
    const sync = (preserveFocusedBottom = false) => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const shouldStayAtBottom = conversationAtBottomRef.current
          || (preserveFocusedBottom && composerFocusedAtBottomRef.current);
        if (shouldStayAtBottom) {
          viewport.scrollTop = viewport.scrollHeight;
          conversationAtBottomRef.current = true;
          setConversationAtBottom(true);
          return;
        }
        updateConversationBottom(viewport);
      });
    };
    const mutationObserver = new MutationObserver(() => sync());
    mutationObserver.observe(viewport, { childList: true, subtree: true, characterData: true });
    const resizeObserver = new ResizeObserver(() => sync());
    resizeObserver.observe(viewport);
    const visualViewport = window.visualViewport;
    const handleVisualViewportResize = () => sync(true);
    visualViewport?.addEventListener("resize", handleVisualViewportResize);
    sync();
    return () => {
      window.cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      visualViewport?.removeEventListener("resize", handleVisualViewportResize);
    };
  }, [state?.sessionId, updateConversationBottom]);
  useEffect(() => {
    if (!roleplaySetupBusy) {
      setRoleplaySetupElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setRoleplaySetupElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [roleplaySetupBusy]);
  useEffect(() => {
    setDirectorSuggestions([]);
    setDirectorSuggestionError("");
  }, [state?.sessionId, roleplay?.performer.name, roleplay?.identity.name, roleplay?.scene?.id, roleplay?.scene?.revision]);

  const headings = useMemo(() => markdownHeadings(document.content, "document"), [document.content]);

  /**
   * Drop agent step UI. Clears localStorage trail for the current session when
   * requested (edit/rewind, new session). Optionally abort the live SSE subscription.
   */
  const clearAgentStream = useCallback((options?: { abort?: boolean; clearStorage?: boolean; sessionId?: string }) => {
    if (options?.abort) {
      abortRef.current?.abort();
      abortRef.current = undefined;
      currentJobRef.current = undefined;
      setBusy(false);
    }
    if (options?.clearStorage) {
      clearStepTrail(options.sessionId ?? sessionIdRef.current ?? "");
    }
    setStreamSteps([]);
    setStreamStepsAnchorId(null);
    streamOutputRef.current = "";
  }, []);

  const refresh = useCallback(
    async (targetSession?: string) => {
      const next = await api<State>(
        `/api/state${targetSession ? `?session=${encodeURIComponent(targetSession)}` : ""}`,
      );
      setState(next);
      if (!activePath && next.documents[0]) setActivePath(next.documents[0]);
      return next;
    },
    [activePath],
  );

  const loadOlderMessages = useCallback(async () => {
    if (!state?.sessionId || !state.messagesHasMore || olderMessagesLoading) return;
    const firstId = state.messages[0]?.id;
    if (!firstId) return;
    const viewport = conversationRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    const previousTop = viewport?.scrollTop ?? 0;
    setOlderMessagesLoading(true);
    try {
      const page = await api<{ messages: Message[]; hasMore: boolean }>(
        `/api/session/${encodeURIComponent(state.sessionId)}/messages?before=${firstId}&limit=50`,
      );
      setState(current => {
        if (!current || current.sessionId !== state.sessionId) return current;
        const known = new Set(current.messages.map(message => message.id));
        const prepended = page.messages.filter(message => !known.has(message.id));
        return { ...current, messages: [...prepended, ...current.messages], messagesHasMore: page.hasMore };
      });
      window.requestAnimationFrame(() => {
        if (viewport) viewport.scrollTop = viewport.scrollHeight - previousHeight + previousTop;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setOlderMessagesLoading(false);
    }
  }, [state?.sessionId, state?.messages, state?.messagesHasMore, olderMessagesLoading]);

  const applyWritingStyle = useCallback(async (styleId: string, label?: string) => {
    setStyleBusy(true);
    setError("");
    try {
      const result = await api<{
        active?: StyleTemplateInfo | null;
        sampling?: { temperature: number; topP: number; updatedModels: number } | null;
      }>("/api/style", {
        method: "PUT",
        body: JSON.stringify({ styleId }),
      });
      await refresh(state?.sessionId);
      if (!styleId) {
        setNotice("已关闭写作风格模板");
      } else {
        const sampling = result.sampling;
        const samplingHint = sampling
          ? ` · 已写入 sampling temp ${sampling.temperature} / topP ${sampling.topP}${sampling.updatedModels ? `（${sampling.updatedModels} 个模型）` : ""}`
          : "";
        setNotice(`已激活写作风格：${label || styleId}${samplingHint}`);
      }
      setShowStylePicker(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setStyleBusy(false);
    }
  }, [refresh, state?.sessionId]);

  /** Open editor for custom templates, or read-only viewer for built-ins. */
  const openStyleTemplate = useCallback((template?: StyleTemplateInfo) => {
    if (!template) {
      setStyleDraft({
        id: "",
        name: "",
        description: "",
        systemPromptAddition: "写作风格指令：\n- ",
        exampleContent: "",
        exampleNotes: "",
        suggestedTemperature: 0.8,
        suggestedTopP: 0.92,
        builtIn: false,
        customized: true,
        readOnly: false,
        isNew: true,
      });
      setShowStylePicker(false);
      return;
    }
    const readOnly = Boolean(template.readOnly || template.builtIn);
    setStyleDraft({
      ...template,
      readOnly,
      isNew: false,
    });
    setShowStylePicker(false);
  }, []);

  const saveStyleTemplate = useCallback(async () => {
    if (!styleDraft) return;
    if (styleDraft.readOnly || styleDraft.builtIn) {
      setError("内置模板不可编辑；请新建自定义模板。");
      return;
    }
    setStyleBusy(true);
    setError("");
    try {
      const payload = {
        ...styleDraft,
        id: styleDraft.id || undefined,
        isNew: undefined,
        builtIn: undefined,
        customized: undefined,
        readOnly: undefined,
      };
      const result = await api<{ template: StyleTemplateInfo }>("/api/style/templates", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await refresh(state?.sessionId);
      setStyleDraft(null);
      setShowStylePicker(true);
      setNotice(`${styleDraft.isNew ? "已创建" : "已保存"}写作模板：${result.template.name}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setStyleBusy(false);
    }
  }, [refresh, state?.sessionId, styleDraft]);

  useEffect(() => {
    const stopMonitor = startConnectionMonitor();
    const unsubscribe = subscribeConnection(setConnection);
    void ensureConnection()
      .then(() => refresh())
      .catch((e) => setError(String(e)));
    return () => {
      stopMonitor();
      unsubscribe();
    };
  }, []);

  // Switching sessions: hide previous trail; restore this session's local collapsed trail if any.
  useEffect(() => {
    const nextId = state?.sessionId;
    if (!nextId) return;
    const prevId = sessionIdRef.current;
    sessionIdRef.current = nextId;
    if (prevId && prevId !== nextId) {
      abortRef.current?.abort();
      abortRef.current = undefined;
      currentJobRef.current = undefined;
      setBusy(false);
      streamOutputRef.current = "";
      setCollapsedAssistantIds(new Set());
      const trail = loadStepTrail(nextId);
      if (trail) {
        setStreamSteps(restoreTrailSteps(trail));
        setStreamStepsAnchorId(trail.messageId);
      } else {
        setStreamSteps([]);
        setStreamStepsAnchorId(null);
      }
      setNotice("");
      setError("");
      setComposerBranch(null);
      setMessageVersionViews({});
    }
  }, [state?.sessionId]);

  useEffect(() => {
    if (!state?.sessionId) return;
    setRoleplay(state.activeRoleplay);
    setRoleplaySetup(null);
  }, [state?.sessionId]);

  useEffect(() => {
    const sessionId = state?.sessionId ?? "";
    const todos = state?.todos ?? [];
    const complete = todos.length > 0 && todos.every(item => item.status === "completed");
    const previous = todosCompletionRef.current;
    if (sessionId !== previous.sessionId) {
      setTodosCollapsed(complete);
    } else if (complete && !previous.complete) {
      setTodosCollapsed(true);
    } else if (!complete && previous.complete) {
      setTodosCollapsed(false);
    }
    todosCompletionRef.current = { sessionId, complete };
  }, [state?.sessionId, state?.todos]);

  // Initial load: restore collapsed step trail for the active session.
  useEffect(() => {
    if (!state?.sessionId || busy || currentJobRef.current) return;
    if (streamSteps.length > 0) return;
    const trail = loadStepTrail(state.sessionId);
    if (!trail) return;
    const messageStillExists = state.messages.some((msg) => msg.id === trail.messageId);
    if (!messageStillExists) {
      clearStepTrail(state.sessionId);
      return;
    }
    setStreamSteps(restoreTrailSteps(trail));
    setStreamStepsAnchorId(trail.messageId);
  }, [state?.sessionId, state?.messages, busy, streamSteps.length]);

  // Persist live/completed steps locally (collapsed) for the current user message.
  useEffect(() => {
    const sessionId = state?.sessionId;
    if (!sessionId || streamStepsAnchorId == null || streamStepsAnchorId <= 0) return;
    if (!streamSteps.length) return;
    saveStepTrail(sessionId, streamStepsAnchorId, streamSteps);
  }, [state?.sessionId, streamStepsAnchorId, streamSteps]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.dataset.theme = theme;
    localStorage.setItem("writer-ui-theme", theme);
    const active = UI_THEMES.find((item) => item.id === theme);
    localStorage.setItem("writer-theme", active?.dark ? "dark" : "light");
    const meta = window.document.querySelector('meta[name="theme-color"]');
    if (meta && active) meta.setAttribute("content", active.preview.accent);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("writer-workspace-mode", workspaceMode);
    localStorage.setItem("writer-documents-collapsed", String(documentsCollapsed));
  }, [workspaceMode, documentsCollapsed]);

  useEffect(() => {
    localStorage.setItem("writer-outline-collapsed", String(outlineCollapsed));
  }, [outlineCollapsed]);

  useEffect(() => {
    const overlayOpen = showThemePicker || showStylePicker || showConnectionPanel
      || showUsagePopover || settingsMenuOpen || managementView !== null
      || styleDraft !== null || characterDraft !== null || simpleCardDraft !== null
      || roleplaySetup !== null || roleplaySceneDraft !== null || roleplayFactDraft !== null
      || branchConfirm !== null;
    if (!overlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (styleDraft) {
        setStyleDraft(null);
        setShowStylePicker(true);
        return;
      }
      if (characterDraft) { setCharacterDraft(null); return; }
      if (simpleCardDraft) { setSimpleCardDraft(null); return; }
      if (roleplayFactDraft) { setRoleplayFactDraft(null); return; }
      if (roleplaySceneDraft) { setRoleplaySceneDraft(null); return; }
      if (roleplaySetup && !roleplaySetupBusy) { setRoleplaySetup(null); return; }
      if (branchConfirm) { setBranchConfirm(null); return; }
      if (settingsMenuOpen) { setSettingsMenuOpen(false); return; }
      if (showUsagePopover) { setShowUsagePopover(false); return; }
      if (showThemePicker) { setShowThemePicker(false); return; }
      if (showStylePicker) { setShowStylePicker(false); return; }
      if (showConnectionPanel) { setShowConnectionPanel(false); return; }
      if (managementView) { setManagementView(null); return; }
      setShowThemePicker(false);
      setShowStylePicker(false);
      setShowConnectionPanel(false);
      setShowUsagePopover(false);
      setSettingsMenuOpen(false);
      setManagementView(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    showThemePicker, showStylePicker, showConnectionPanel, showUsagePopover, settingsMenuOpen,
    managementView, styleDraft, characterDraft, simpleCardDraft, roleplaySetup, roleplaySetupBusy,
    roleplaySceneDraft, roleplayFactDraft, branchConfirm,
  ]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.style.setProperty("--sidebar-w", `${sidebarWidth}px`);
    root.style.setProperty("--agent-w", `${agentWidth}px`);
    root.style.setProperty("--reader-font-size", `${readerFontSize}px`);
    root.style.setProperty("--reader-width", `${readerWidth}px`);
    localStorage.setItem("writer-sidebar-w", String(sidebarWidth));
    localStorage.setItem("writer-agent-w", String(agentWidth));
    localStorage.setItem("writer-reader-fs", String(readerFontSize));
    localStorage.setItem("writer-reader-w", String(readerWidth));
  }, [sidebarWidth, agentWidth, readerFontSize, readerWidth]);

  useEffect(() => {
    if (!resizing) return;
    const handleMove = (e: MouseEvent) => {
      if (resizing === "sidebar") {
        setSidebarWidth((w) => Math.max(180, Math.min(480, w + e.movementX)));
      } else {
        setAgentWidth((w) => Math.max(240, Math.min(560, w - e.movementX)));
      }
    };
    const handleUp = () => setResizing(null);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [resizing]);

  useEffect(() => {
    if (!activePath) return;
    setVersionPanelOpen(false);
    setVersions([]);
    setBrowsingVersion(null);
    void api<DocumentData>(`/api/document?path=${encodeURIComponent(activePath)}`)
      .then((value) => {
        setDocument(value);
        setDocumentDraft(value.content);
        setEditingDocument(false);
      })
      .catch((e) => setError(String(e)));
  }, [activePath]);

  const loadVersions = useCallback(async (path: string) => {
    if (!path) return;
    setVersionsLoading(true);
    try {
      const result = await api<{ versions: DocumentVersionMeta[] }>(
        `/api/document/versions?path=${encodeURIComponent(path)}`,
      );
      setVersions(result.versions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  async function toggleVersionPanel() {
    if (!activePath || editingDocument) return;
    if (versionPanelOpen) {
      setVersionPanelOpen(false);
      return;
    }
    setVersionPanelOpen(true);
    await loadVersions(activePath);
  }

  async function openVersion(meta: DocumentVersionMeta) {
    if (!activePath) return;
    setVersionBusy(true);
    setError("");
    try {
      const result = await api<{ version: DocumentVersionDetail }>(
        `/api/document/version?path=${encodeURIComponent(activePath)}&id=${meta.id}`,
      );
      setBrowsingVersion(result.version);
      setEditingDocument(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVersionBusy(false);
    }
  }

  function exitVersionBrowse() {
    setBrowsingVersion(null);
  }

  useEffect(() => {
    if (renaming && renameInputRef.current) renameInputRef.current.focus();
  }, [renaming]);

  useEffect(() => {
    if (creating && createInputRef.current) createInputRef.current.focus();
  }, [creating]);

  useEffect(() => {
    localStorage.setItem("writer-expanded-folders", JSON.stringify([...expandedFolders]));
  }, [expandedFolders]);

  useEffect(() => {
    if (!activePath.includes("/")) return;
    const parts = activePath.split("/").slice(0, -1);
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      parts.forEach((_, index) => next.add(parts.slice(0, index + 1).join("/")));
      return next;
    });
  }, [activePath]);

  useEffect(() => {
    const handleFileSearchShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, [contenteditable='true']");
      if (event.key === "/" && !isTyping && workspaceMode !== "agent-focus") {
        event.preventDefault();
        fileSearchRef.current?.focus();
      }
      if (event.key === "Escape" && window.document.activeElement === fileSearchRef.current) {
        setFileQuery("");
        fileSearchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handleFileSearchShortcut);
    return () => window.removeEventListener("keydown", handleFileSearchShortcut);
  }, [workspaceMode]);

  function handleAgentEvent(event: AgentStreamEvent) {
    if (event.type === "step_start") {
      setStreamSteps((current) => {
        const id = event.step ?? current.length + 1;
        if (current.some((s) => s.id === id)) return current;
        // New steps stay collapsed; expand only on user click. Content still streams into state.
        return [...current, { id, output: "", reasoning: "", tools: [], status: "running", expanded: false }];
      });
    }
    if (event.type === "text" && event.text) {
      if (event.channel !== "reasoning") streamOutputRef.current += event.text;
      setStreamSteps((current) => {
        const idx = activeStepIndex(current);
        if (idx < 0) return current;
        const key = event.channel === "reasoning" ? "reasoning" : "output";
        return current.map((s, i) => (i === idx ? { ...s, [key]: s[key] + event.text } : s));
      });
    }
    if (event.type === "tool" && event.name) {
      setStreamSteps((current) => {
        const idx = activeStepIndex(current);
        return current.map((s, i) => (i === idx ? { ...s, tools: [...s.tools, event.name!] } : s));
      });
    }
    if (event.type === "usage") {
      if (event.usage) {
        setState((prev) => (prev ? { ...prev, usage: event.usage! } : prev));
      }
      if (event.call) {
        setStreamSteps((current) => {
          const targetId = event.step;
          const idx = targetId != null
            ? current.findIndex((s) => s.id === targetId)
            : activeStepIndex(current);
          if (idx < 0) return current;
          return current.map((s, i) => (i === idx ? { ...s, usage: mergeStepCallUsage(s.usage, event.call!, event.callKind) } : s));
        });
      }
    }
    if (event.type === "step_done") {
      setStreamSteps((current) =>
        current.map((s) => (s.id === event.step ? { ...s, status: "completed", expanded: false } : s)),
      );
    }
    if (event.type === "error") {
      setError(event.message || "Agent failed");
      setStreamSteps((current) =>
        current.map((s) => (s.status === "running" ? { ...s, status: "failed", expanded: false } : s)),
      );
    }
    if (event.type === "waiting_for_input") {
      setNotice("");
    }
    if (event.type === "proposal" && event.proposal) {
      setState((prev) => {
        if (!prev) return prev;
        const rest = prev.proposals.filter((item) => item.id !== event.proposal!.id);
        return { ...prev, proposals: [event.proposal as Proposal, ...rest] };
      });
      // Auto mode writes immediately; surface that so it is not mistaken for silent overwrite.
      if (event.proposal.status === "accepted") {
        setNotice(`Auto：提案 #${event.proposal.id} 已写入 ${event.proposal.path}`);
      } else if (event.proposal.status === "pending") {
        setNotice(`提案 #${event.proposal.id} 待审批：${event.proposal.path}`);
      }
    }
    if (event.type === "change_set" && event.changeSet) {
      setState((prev) => {
        if (!prev) return prev;
        const rest = prev.changeSets.filter((item) => item.id !== event.changeSet!.id);
        return { ...prev, changeSets: [event.changeSet!, ...rest] };
      });
      setNotice(event.changeSet.status === "accepted"
        ? `Auto: change set #${event.changeSet.id} applied`
        : `Change set #${event.changeSet.id} awaiting approval`);
    }
    if (event.type === "todos" && event.todos) {
      setState((prev) => (prev ? { ...prev, todos: event.todos } : prev));
    }
    if (event.type === "mode" && event.mode) {
      setState((prev) =>
        prev
          ? { ...prev, agentSettings: { ...(prev.agentSettings ?? { permissionMode: "ask", scenePipeline: { preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5, notesMaxCharacters: 3000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1 } }), permissionMode: event.mode! } }
          : prev,
      );
    }
  }

  async function setPermissionMode(mode: PermissionMode) {
    if (!state || busy) return;
    const current = state.agentSettings?.permissionMode ?? "ask";
    if (current === mode) return;
    setError("");
    try {
      const result = await api<{ permissionMode: PermissionMode }>("/api/agent-settings", {
        method: "POST",
        body: JSON.stringify({ permissionMode: mode }),
      });
      setState((prev) =>
        prev
          ? { ...prev, agentSettings: { ...(prev.agentSettings ?? { permissionMode: "ask", scenePipeline: { preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5, notesMaxCharacters: 3000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1 } }), permissionMode: result.permissionMode } }
          : prev,
      );
      setNotice(`权限模式：${PERMISSION_MODES.find((item) => item.id === result.permissionMode)?.label ?? result.permissionMode}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function subscribeAgentJob(jobId: string, sessionId: string, clearContextOnDone = false) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    currentJobRef.current = jobId;
    setBusy(true);
    try {
      const response = await apiFetch(`/api/chat/jobs/${encodeURIComponent(jobId)}/events`, {
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("Cannot connect to Agent job");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminal = false;
      let terminalType: AgentStreamEvent["type"] | null = null;
      let completedProposal: NonNullable<AgentStreamEvent["proposal"]> | undefined;
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const line = block.split(/\r?\n/).find((item) => item.startsWith("data:"));
          if (!line) continue;
          const event = JSON.parse(line.slice(5)) as AgentStreamEvent;
          handleAgentEvent(event);
          if (event.type === "proposal" && event.proposal) completedProposal = event.proposal;
          if (event.type === "done" || event.type === "cancelled" || event.type === "error" || event.type === "waiting_for_input") {
            terminal = true;
            terminalType = event.type;
          }
        }
        if (done) break;
      }
      if (terminal) {
        // Intentionally keep streamSteps so the tool trail stays visible after completion.
        // Re-anchor to the persisted user message id (temp negative ids are replaced by refresh).
        const next = await refresh(sessionId);
        const lastUser = [...next.messages]
          .reverse()
          .find((msg) => msg.role === "user" && msg.content.trim());
        setStreamStepsAnchorId(lastUser?.id ?? null);
        // Auto mode may have written the open document; reload so the editor matches disk.
        const pathToReload = activePathRef.current;
        if (pathToReload && !editingDocumentRef.current) {
          try {
            const doc = await api<DocumentData>(`/api/document?path=${encodeURIComponent(pathToReload)}`);
            setDocument(doc);
            setDocumentDraft(doc.content);
            setBrowsingVersion(null);
          } catch {
            /* path may be new / deleted; tree refresh is enough */
          }
        }
        if (clearContextOnDone && terminalType === "done") {
          const pendingCount = (next.proposals ?? []).filter((item) => item.status === "pending").length;
          setNotice(
            completedProposal?.status === "accepted"
              ? `Agent job completed · 已写入 ${completedProposal.path}`
              : completedProposal?.status === "pending"
                ? `Agent job completed · 提案 #${completedProposal.id} 待审批：${completedProposal.path}`
                : pendingCount > 0
              ? `Agent job completed · ${pendingCount} 条提案待审批（Ask 模式不会直接改文件）`
              : "Agent job completed.",
          );
        } else if (terminalType === "cancelled") {
          setNotice("Agent job cancelled.");
        }
      }
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === "AbortError")) {
        setNotice("Connection interrupted. The background job is still running on the server.");
        await refresh(sessionId).catch((e) => setError(String(e)));
      }
    } finally {
      streamOutputRef.current = "";
      if (currentJobRef.current === jobId) {
        abortRef.current = undefined;
        currentJobRef.current = undefined;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    const job = state?.activeJobs?.[0];
    if (!job || currentJobRef.current === job.id) return;
    setStreamSteps([]);
    streamOutputRef.current = "";
    const lastUser = [...(state.messages ?? [])]
      .reverse()
      .find((msg) => msg.role === "user" && msg.content.trim());
    setStreamStepsAnchorId(lastUser?.id ?? null);
    void subscribeAgentJob(job.id, job.sessionId);
  }, [state?.activeJobs?.[0]?.id]);

  async function sendChat(options?: {
    text?: string;
    channel?: "agent" | "roleplay";
    variantGroupId?: string;
    replaceFromId?: number;
  }) {
    const text = (options?.text ?? prompt).trim();
    const requestedChannel = options?.channel ?? composerBranch?.channel;
    const activeRoleplay = requestedChannel === undefined ? roleplay : requestedChannel === "roleplay" ? roleplay : null;
    const variantGroupId = options?.variantGroupId ?? composerBranch?.variantGroupId;
    const replaceFromId = options?.replaceFromId ?? composerBranch?.fromId;
    if (!state || busy || !text) return;
    if (requestedChannel === "roleplay" && !activeRoleplay) {
      setError("当前角色扮演身份已退出，无法重新运行这条扮演消息。");
      return;
    }
    const tempMessageId = -Date.now();
    if (options?.text === undefined) setPrompt("");
    setError("");
    setNotice("");
    // New turn replaces the previous trail for this session.
    clearStepTrail(state.sessionId);
    setStreamSteps([]);
    setStreamStepsAnchorId(tempMessageId);
    streamOutputRef.current = "";
    setState((value) =>
      value
        ? {
          ...value,
          messages: [
            ...value.messages.filter((message) => replaceFromId === undefined || message.id < replaceFromId),
            {
              id: tempMessageId,
              role: "user",
              content: text,
              channel: activeRoleplay ? "roleplay" : "agent",
            },
          ],
        }
        : value,
    );
    try {
      // Keep the default unrestricted behavior byte-for-byte: only send a scope when
      // the user has hidden at least one card of that kind.
      const characterScope = state.characters.some((character) => agentHiddenCharacterCards.has(`normal:${character.id}`))
        ? state.characters
          .filter((character) => !agentHiddenCharacterCards.has(`normal:${character.id}`))
          .map((character) => character.id)
        : undefined;
      const simpleCharacterScope = state.roleplayInterlocutors.some((card) => agentHiddenCharacterCards.has(`simple:${card.id}`))
        ? state.roleplayInterlocutors
          .filter((card) => !agentHiddenCharacterCards.has(`simple:${card.id}`))
          .map((card) => card.id)
        : undefined;
      const result = await api<{ jobId: string }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          sessionId: state.sessionId,
          prompt: text,
          permissionMode: state.agentSettings?.permissionMode ?? "ask",
          ...(variantGroupId ? { variantGroupId } : {}),
          ...(!activeRoleplay ? {
            ...(characterScope !== undefined ? { characterScope } : {}),
            ...(simpleCharacterScope !== undefined ? { simpleCharacterScope } : {}),
          } : {}),
          ...(activeRoleplay
            ? { mode: "roleplay", performer: activeRoleplay.performer, identity: activeRoleplay.identity, scene: activeRoleplay.scene, inputMode: roleplayInputMode }
            : {}),
        }),
      });
      setComposerBranch(null);
      await subscribeAgentJob(result.jobId, state.sessionId, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      clearAgentStream();
    }
  }

  function toggleAgentCharacterVisibility(key: string) {
    setAgentHiddenCharacterCards((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(AGENT_HIDDEN_CHARACTER_CARDS_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  function stop() {
    const jobId = currentJobRef.current;
    if (jobId) void api(`/api/chat/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    abortRef.current?.abort();
  }

  function requestRewindMessage(message: Message) {
    if (!state || busy || message.role !== "user") return;
    if (message.channel === "roleplay" && !roleplay) {
      setError("当前角色扮演身份已退出，无法编辑这条扮演消息。");
      return;
    }
    setBranchConfirm({ mode: "edit", message });
  }

  function requestRerunMessage(message: Message) {
    if (!state || busy || message.id < 1) return;
    if (message.channel === "roleplay" && !roleplay) {
      setError("当前角色扮演身份已退出，无法重新运行这条扮演消息。");
      return;
    }
    setBranchConfirm({ mode: "rerun", message });
  }

  async function confirmBranchAction(keepChanges: boolean) {
    if (!state || !branchConfirm) return;
    const { mode, message } = branchConfirm;
    setBranchConfirm(null);
    setError("");
    setNotice("");
    // Edit/rewind: drop step trail from UI and localStorage.
    clearAgentStream({ abort: true, clearStorage: true, sessionId: state.sessionId });
    try {
      const result = await api<{
        fromId: number;
        prompt: string;
        channel: "agent" | "roleplay";
        variantGroupId: string;
        keepChanges?: boolean;
      }>(`/api/messages/${message.id}/rerun`, {
        method: "POST",
        body: JSON.stringify({ sessionId: state.sessionId, keepChanges }),
      });
      setMessageVersionViews({});
      if (activePath) {
        try {
          const next = await api<DocumentData>(`/api/document?path=${encodeURIComponent(activePath)}`);
          setDocument(next);
          setDocumentDraft(next.content);
        } catch {
          setDocument({ content: "", hash: "" });
          setDocumentDraft("");
        }
      }
      if (mode === "edit") {
        setComposerBranch({
          variantGroupId: result.variantGroupId,
          channel: result.channel,
          fromId: result.fromId,
        });
        setPrompt(result.prompt);
        await refresh(state.sessionId);
        requestAnimationFrame(() => composerRef.current?.focus());
        return;
      }
      setComposerBranch(null);
      await sendChat({
        text: result.prompt,
        channel: result.channel,
        variantGroupId: result.variantGroupId,
        replaceFromId: result.fromId,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh(state.sessionId);
    }
  }

  async function shiftMessageVersion(message: Message, delta: -1 | 1) {
    if (!state || (message.role !== "user" && message.role !== "assistant") || message.id < 1) return;
    try {
      const bundle = messageVersionViews[message.id] ?? await api<MessageVersionBundle>(
        `/api/messages/${message.id}/versions?session=${encodeURIComponent(state.sessionId)}`,
      );
      const nextIndex = Math.max(0, Math.min(bundle.versions.length - 1, bundle.current + delta));
      setMessageVersionViews((current) => ({
        ...current,
        [message.id]: { ...bundle, current: nextIndex },
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function saveDocument() {
    if (!activePath) return;
    const result = await api<{ hash: string }>("/api/document", {
      method: "PUT",
      body: JSON.stringify({ path: activePath, content: documentDraft, baseHash: document.hash }),
    });
    setDocument({ content: documentDraft, hash: result.hash });
    setEditingDocument(false);
    setBrowsingVersion(null);
    await refresh(state?.sessionId);
    if (versionPanelOpen) await loadVersions(activePath);
  }

  function cancelEdit() {
    setEditingDocument(false);
    setDocumentDraft(document.content);
  }

  async function decide(proposal: Proposal, action: "accept" | "reject") {
    try {
      await api(`/api/proposals/${proposal.id}/${action}`, { method: "POST" });
      await refresh(state?.sessionId);
      if (action === "accept" && proposal.path === activePath) {
        const next = await api<DocumentData>(`/api/document?path=${encodeURIComponent(activePath)}`);
        setDocument(next);
        setDocumentDraft(next.content);
        setBrowsingVersion(null);
        if (versionPanelOpen) await loadVersions(activePath);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRename(oldPath: string, kind: "file" | "folder") {
    setRenaming({ path: oldPath, kind });
    setRenameValue(oldPath.split("/").pop()!);
  }

  async function submitRename() {
    if (!renaming || !renameValue.trim()) {
      setRenaming(null);
      return;
    }
    const oldPath = renaming.path;
    const parts = oldPath.split("/");
    parts[parts.length - 1] = renameValue.trim();
    if (renaming.kind === "file" && !parts[parts.length - 1].endsWith(".md")) {
      parts[parts.length - 1] += ".md";
    }
    const newPath = parts.join("/");
    try {
      const endpoint = renaming.kind === "file" ? "/api/document/rename" : "/api/folder/rename";
      await api(endpoint, {
        method: "PUT",
        body: JSON.stringify({ fromPath: oldPath, toPath: newPath }),
      });
      if (activePath === oldPath || activePath.startsWith(`${oldPath}/`)) {
        setActivePath(`${newPath}${activePath.slice(oldPath.length)}`);
      }
      await refresh(state?.sessionId);
    } catch (e) {
      setError(String(e));
    }
    setRenaming(null);
  }

  async function handleDelete(path: string, kind: "file" | "folder") {
    const label = kind === "file" ? "document" : "folder";
    if (!confirm(`Delete ${label} "${path}"? This cannot be undone.`)) return;
    try {
      const endpoint = kind === "file" ? "/api/document" : "/api/folder";
      await api(`${endpoint}?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      if (activePath === path || activePath.startsWith(`${path}/`)) setActivePath("");
      await refresh(state?.sessionId);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleToggleHidden(path: string, kind: "file" | "folder", current: boolean) {
    try {
      const endpoint = kind === "file" ? "/api/document/visibility" : "/api/folder/visibility";
      await api(endpoint, {
        method: "PUT",
        body: JSON.stringify({ path, hidden: !current }),
      });
      await refresh(state?.sessionId);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleMoveNode(path: string, kind: "file" | "folder", targetFolder: string) {
    if (kind === "folder" && (targetFolder === path || targetFolder.startsWith(`${path}/`))) {
      setNotice("不能把文件夹移动到自身内部");
      return;
    }
    const parts = path.split("/");
    const name = parts.pop()!;
    const newPath = targetFolder ? `${targetFolder}/${name}` : name;
    if (newPath === path) return;
    try {
      await api(kind === "file" ? "/api/document/rename" : "/api/folder/rename", {
        method: "PUT",
        body: JSON.stringify({ fromPath: path, toPath: newPath }),
      });
      if (activePath === path || activePath.startsWith(`${path}/`)) {
        setActivePath(`${newPath}${activePath.slice(path.length)}`);
      }
      if (targetFolder) setExpandedFolders((prev) => new Set(prev).add(targetFolder));
      await refresh(state?.sessionId);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDuplicate(path: string) {
    try {
      const source = await api<DocumentData>(`/api/document?path=${encodeURIComponent(path)}`);
      const slash = path.lastIndexOf("/");
      const parent = slash >= 0 ? path.slice(0, slash + 1) : "";
      const filename = slash >= 0 ? path.slice(slash + 1) : path;
      const stem = filename.replace(/\.md$/i, "");
      let index = 1;
      let copyPath = `${parent}${stem} - 副本.md`;
      while (state?.documents.includes(copyPath)) {
        index += 1;
        copyPath = `${parent}${stem} - 副本 ${index}.md`;
      }
      await api("/api/document", {
        method: "POST",
        body: JSON.stringify({ path: copyPath, content: source.content }),
      });
      await refresh(state?.sessionId);
      setActivePath(copyPath);
      setNotice(`已创建 ${copyPath}`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleNewChild(parent: string, kind: "file" | "folder") {
    setCreating({ parent, kind });
    setCreateValue(kind === "file" ? "新文档" : "新文件夹");
  }

  async function submitCreate() {
    if (!creating || !createValue.trim()) {
      setCreating(null);
      return;
    }
    const name = createValue.trim();
    const fullPath = creating.parent
      ? `${creating.parent}/${name}${creating.kind === "file" && !name.endsWith(".md") ? ".md" : ""}`
      : `${name}${creating.kind === "file" && !name.endsWith(".md") ? ".md" : ""}`;
    try {
      if (creating.kind === "file") {
        await api("/api/document", {
          method: "POST",
          body: JSON.stringify({ path: fullPath, content: "# New Document\n\n" }),
        });
      } else {
        await api("/api/folder", {
          method: "POST",
          body: JSON.stringify({ path: fullPath }),
        });
      }
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.add(creating.parent);
        return next;
      });
      await refresh(state?.sessionId);
    } catch (e) {
      setError(String(e));
    }
    setCreating(null);
  }

  async function saveCharacter() {
    if (!characterDraft?.identity.name.trim()) return;
    await api("/api/characters", {
      method: "POST",
      body: JSON.stringify(characterEditorSaveInput(characterDraft)),
    });
    setCharacterDraft(null);
    await refresh(state?.sessionId);
  }

  async function summarizeCompetency(competency: Competency): Promise<string> {
    const result = await api<{ summary: string }>("/api/characters/competencies/summarize", {
      method: "POST",
      body: JSON.stringify({ sessionId: state?.sessionId, competency }),
    });
    return result.summary;
  }

  function normalParticipant(character: Character): RoleplayParticipant {
    // Fill scene/knowledge/goal from the card so the banner isn't blank; relationship is
    // performer-dependent and is derived server-side at chat time, so leave it empty here.
    const latestState = character.storyStates[character.storyStates.length - 1];
    const scene = latestState
      ? [latestState.location, latestState.physical, latestState.emotion].map((part) => part?.trim()).filter(Boolean).join("；")
      : "";
    const known = latestState?.knowledge?.map((entry) => (entry.description || entry.label).trim()).filter(Boolean) ?? [];
    return {
      kind: "normal", id: character.id, name: character.identity.name,
      card: {
        name: character.identity.name,
        identity: character.identity.summary || character.identity.narrativeRole,
        relationship: "",
        knowledge: known.join("；"),
        scene,
        goal: character.motivations.find(item => item.status === "active")?.summary ?? "",
      },
    };
  }

  function simpleParticipant(card: SavedRoleplayInterlocutor): RoleplayParticipant {
    return {
      kind: "simple", id: card.id, name: card.name,
      card: { name: card.name, identity: card.identity, relationship: card.relationship, knowledge: card.knowledge, scene: card.scene, goal: card.goal },
    };
  }

  function roleplayCards(): RoleplayParticipant[] {
    return [...(state?.characters ?? []).map(normalParticipant), ...(state?.roleplayInterlocutors ?? []).map(simpleParticipant)];
  }

  function beginRoleplaySetup() {
    const normal = state?.characters[0];
    const simple = state?.roleplayInterlocutors[0];
    const performer = normal ? normalParticipant(normal) : simple ? simpleParticipant(simple) : null;
    setRoleplaySetup({ performer, identity: null, scene: roleplay?.scene ?? null, request: "", persist: true });
    setCharacterDraft(null);
    setManagementView(null);
  }

  async function persistActiveRoleplay(value: ActiveRoleplayState): Promise<ActiveRoleplayState> {
    if (!state?.sessionId) throw new Error("当前会话不存在");
    return api<ActiveRoleplayState>("/api/roleplay/state", {
      method: "PUT",
      body: JSON.stringify({
        sessionId: state.sessionId,
        performer: value.performer,
        identity: value.identity,
        sceneId: value.scene?.id,
      }),
    });
  }

  async function confirmRoleplaySetup() {
    if (!roleplaySetup || roleplaySetupBusy) return;
    setRoleplaySetupBusy(true);
    setRoleplaySetupPhase(roleplaySetup.identity ? "entering" : "generating");
    setError("");
    try {
      if (!roleplaySetup.performer) throw new Error("请选择扮演者角色卡");
      let identity = roleplaySetup.identity;
      if (!identity) {
        const generated = await api<RoleplayInterlocutor>("/api/roleplay/interlocutor", {
          method: "POST",
          body: JSON.stringify({ sessionId: state?.sessionId, performer: roleplaySetup.performer, request: roleplaySetup.request }),
        });
        if (roleplaySetup.persist) {
          setRoleplaySetupPhase("saving");
          const saved = await api<SavedRoleplayInterlocutor>("/api/roleplay/interlocutors", {
            method: "POST",
            body: JSON.stringify(generated),
          });
          identity = simpleParticipant(saved);
          await refresh(state?.sessionId);
        } else identity = { kind: "generated", name: generated.name, card: generated };
      }
      setRoleplaySetupPhase("entering");
      const active = await persistActiveRoleplay({
        performer: roleplaySetup.performer,
        identity,
        ...(roleplaySetup.scene ? { scene: roleplaySetup.scene } : {}),
      });
      setRoleplay(active);
      setRoleplaySetup(null);
      setMobileTab("agent");
      setNotice(`已进入角色扮演：${active.performer.name}。当前身份为“${active.identity.name}”。`);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRoleplaySetupBusy(false);
      setRoleplaySetupPhase(null);
    }
  }

  async function useSavedRoleplayInterlocutor(interlocutor: SavedRoleplayInterlocutor) {
    if (!roleplaySetup) return;
    setRoleplaySetup({ ...roleplaySetup, identity: simpleParticipant(interlocutor) });
  }

  async function deleteSavedRoleplayInterlocutor(id: number) {
    try {
      await api(`/api/roleplay/interlocutors/${id}`, { method: "DELETE" });
      await refresh(state?.sessionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function saveSimpleCard() {
    if (!simpleCardDraft?.name.trim()) return;
    try {
      await api<SavedRoleplayInterlocutor>("/api/roleplay/interlocutors", {
        method: "POST",
        body: JSON.stringify(simpleCardDraft),
      });
      setSimpleCardDraft(null);
      await refresh(state?.sessionId);
      setNotice(simpleCardDraft.id ? "简易角色卡已更新" : "简易角色卡已创建");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function saveCurrentRoleplayInterlocutor() {
    if (!roleplay || roleplay.identity.kind !== "generated") return;
    try {
      const saved = await api<SavedRoleplayInterlocutor>("/api/roleplay/interlocutors", {
        method: "POST",
        body: JSON.stringify(roleplay.identity.card),
      });
      const active = await persistActiveRoleplay({ ...roleplay, identity: simpleParticipant(saved) });
      setRoleplay(active);
      await refresh(state?.sessionId);
      setNotice(`已保存试演身份：${saved.name}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function decideChangeSet(changeSet: ChangeSet, action: "accept" | "reject" | "undo" | "redo") {
    try {
      await api(`/api/change-sets/${changeSet.id}/${action}`, { method: "POST" });
      await refresh(state?.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveRoleplayScene() {
    if (!roleplaySceneDraft?.name.trim()) return;
    try {
      const saved = await api<RoleplayScene>("/api/roleplay/scenes", { method: "PUT", body: JSON.stringify(roleplaySceneDraft) });
      setRoleplaySceneDraft(null);
      if (roleplaySetup) setRoleplaySetup({ ...roleplaySetup, scene: saved });
      await refresh(state?.sessionId);
      setNotice(roleplaySceneDraft.id ? "场景卡已更新" : "场景卡已创建");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function deleteRoleplayScene(id: number) {
    if (!confirm("删除这张场景卡？")) return;
    try {
      await api(`/api/roleplay/scenes/${id}`, { method: "DELETE" });
      setRoleplaySceneDraft(null);
      if (roleplaySetup?.scene?.id === id) setRoleplaySetup({ ...roleplaySetup, scene: null });
      await refresh(state?.sessionId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function newFactDraft(source?: Message): RoleplayFactDraft {
    return {
      kind: "event", content: source?.content.slice(0, 1_000) ?? "", ...(source ? { sourceMessageId: source.id } : {}),
      knownBy: ["public"], importance: source ? 80 : 50, status: "active", pinned: Boolean(source),
    };
  }

  async function saveRoleplayFact() {
    if (!state || !roleplayFactDraft?.content.trim()) return;
    try {
      await api<RoleplayMemoryFact>("/api/roleplay/memory/facts", {
        method: "PUT",
        body: JSON.stringify({ ...roleplayFactDraft, sessionId: state.sessionId, contextKey: state.roleplayMemory?.performerKey }),
      });
      setRoleplayFactDraft(null);
      await refresh(state.sessionId);
      setRoleplayMemoryOpen(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function deleteRoleplayFact(id: number) {
    if (!state) return;
    try {
      await api(`/api/roleplay/memory/facts/${id}?session=${encodeURIComponent(state.sessionId)}`, { method: "DELETE" });
      setRoleplayFactDraft(null);
      await refresh(state.sessionId);
      setRoleplayMemoryOpen(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function requestDirectorSuggestions() {
    if (!state?.sessionId || !roleplay || busy || directorSuggestionBusy) return;
    setDirectorSuggestionBusy(true);
    setDirectorSuggestionError("");
    try {
      const result = await api<{ suggestions: string[] }>("/api/roleplay/director-suggestions", {
        method: "POST",
        body: JSON.stringify({ sessionId: state.sessionId }),
      });
      setDirectorSuggestions(result.suggestions);
    } catch (cause) {
      setDirectorSuggestionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDirectorSuggestionBusy(false);
    }
  }

  async function requestRoleplayOpening() {
    if (!state || busy || !roleplay) return;
    setError("");
    setNotice("");
    clearStepTrail(state.sessionId);
    setStreamSteps([]);
    // No user bubble for an opening; anchor the live stream to a temp id so it renders via the orphan path.
    setStreamStepsAnchorId(-Date.now());
    streamOutputRef.current = "";
    try {
      const result = await api<{ jobId: string }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          sessionId: state.sessionId,
          prompt: "",
          mode: "roleplay",
          opening: true,
          permissionMode: state.agentSettings?.permissionMode ?? "ask",
          performer: roleplay.performer,
          identity: roleplay.identity,
          scene: roleplay.scene,
        }),
      });
      await subscribeAgentJob(result.jobId, state.sessionId, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      clearAgentStream();
    }
  }

  async function exitRoleplay() {
    if (!roleplay || !state?.sessionId) return;
    try {
      await api(`/api/roleplay/state/${encodeURIComponent(state.sessionId)}`, { method: "DELETE" });
      setRoleplay(null);
      setNotice(`已退出角色扮演（${roleplay.performer.name}）`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function openProviderSettings() {
    setSettingsMenuOpen(false);
    setManagementView("models");
  }

  async function exportFocusedDocument() {
    if (!activePath) return;
    const path = activePath;
    setFocusedExportBusy(true);
    setError("");
    try {
      const content = browsingVersion?.afterContent
        ?? (await api<DocumentData>(`/api/document?path=${encodeURIComponent(path)}`)).content;
      const filename = path.split("/").at(-1) || "document.md";
      downloadBlob(new Blob([content], { type: "text/markdown;charset=utf-8" }), filename);
      setNotice(`已下载 ${filename}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFocusedExportBusy(false);
    }
  }

  async function deleteCharacter(character: Character) {
    if (!confirm(`Delete character “${character.identity.name}”?`)) return;
    await api(`/api/characters/${character.id}`, { method: "DELETE" });
    setCharacterDraft(null);
    await refresh(state?.sessionId);
  }

  async function renameSession(id: string, currentTitle: string) {
    const title = window.prompt("Session title", currentTitle)?.trim();
    if (!title || title === currentTitle) return;
    await api(`/api/session/${id}`, { method: "PUT", body: JSON.stringify({ title }) });
    await refresh(state?.sessionId);
  }

  async function deleteSession(id: string) {
    if (!confirm("Delete this session? This cannot be undone.")) return;
    await api(`/api/session/${id}`, { method: "DELETE" });
    await refresh(id === state?.sessionId ? undefined : state?.sessionId);
  }

  async function batchDeleteSessions(ids: string[]) {
    if (ids.length === 0) return;
    if (!confirm(`删除选中的 ${ids.length} 个会话？此操作不可撤销。`)) return;
    try {
      const result = await api<{ remainingSessionId: string }>("/api/sessions/batch-delete", {
        method: "POST",
        body: JSON.stringify({ ids, keepSessionId: state?.sessionId }),
      });
      setSelectedSessionIds(new Set());
      setSessionBatchMode(false);
      await refresh(result.remainingSessionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function toggleSessionSelected(id: string) {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const tree = useMemo(() => {
    if (!state) return [];
    return buildTree(state.documents, state.documentFolders, state.hiddenDocuments, state.hiddenFolders);
  }, [state?.documents, state?.documentFolders, state?.hiddenDocuments, state?.hiddenFolders]);
  const visibleTree = useMemo(() => filterTree(tree, fileQuery), [tree, fileQuery]);
  const visibleExpandedFolders = useMemo(() => fileQuery.trim()
    ? new Set([...expandedFolders, ...collectFolderPaths(visibleTree)])
    : expandedFolders, [expandedFolders, fileQuery, visibleTree]);

  if (!state) {
    return (
      <main className="app-shell">
        <p>{error || "Loading..."}</p>
      </main>
    );
  }

  const pendingProposals = state.proposals.filter((p) => p.status === "pending");
  const pendingChangeSets = state.changeSets.filter((item) => item.status === "pending");
  const visibleMessages = state.messages.filter((msg) => (msg.role === "user" || msg.role === "assistant") && msg.content.trim());
  const usagePct = state.provider.pricing.contextWindow
    ? Math.round((state.usage.lastPromptTokens / state.provider.pricing.contextWindow) * 100)
    : 0;
  const styleTemplates = state.styleTemplates ?? [];
  const activeStyleId = state.config.style?.trim() || "";
  const activeStyle = activeStyleId
    ? styleTemplates.find((item) => item.id === activeStyleId)
    : undefined;

  return (
    <WorkspaceShell mode={workspaceMode} documentsCollapsed={documentsCollapsed}>
      {!documentsCollapsed && workspaceMode !== "agent-focus" && <div
        className={`resize-handle${resizing === "sidebar" ? " active" : ""}`}
        style={{ left: `calc(var(--sidebar-w, 248px) - 2.5px)` }}
        onMouseDown={() => setResizing("sidebar")}
      />}
      {workspaceMode === "split" && <div
        className={`resize-handle${resizing === "agent" ? " active" : ""}`}
        style={{ right: `calc(var(--agent-w, 380px) - 2.5px)` }}
        onMouseDown={() => setResizing("agent")}
      />}
      <WorkspaceTopbar
        title={state.config.title || "Writer Agent"}
        connection={connection}
        model={state.provider.model}
        usagePct={usagePct}
        usageCost={state.usage.cost}
        usageCurrency={state.usage.currency}
        usageUnmetered={state.provider.pricing.billingMode === "unmetered"}
        busy={busy}
        theme={theme}
        settingsOpen={settingsMenuOpen}
        workspaceMode={workspaceMode}
        documentsCollapsed={documentsCollapsed}
        onCharacters={() => {
          setSessionBatchMode(false);
          setSelectedSessionIds(new Set());
          setManagementView("characters");
        }}
        onRoleplay={() => beginRoleplaySetup()}
        onSessions={() => {
          setSessionBatchMode(false);
          setSelectedSessionIds(new Set());
          setManagementView("sessions");
        }}
        onUsage={() => setShowUsagePopover(true)}
        onConnection={() => {
          setSettingsMenuOpen(false);
          setConnectionPanelMsg("");
          setShowConnectionPanel(true);
        }}
        onToggleSettings={() => setSettingsMenuOpen((value) => !value)}
        onCloseSettings={() => setSettingsMenuOpen(false)}
        onTheme={() => { setSettingsMenuOpen(false); setShowThemePicker(true); }}
        onModels={openProviderSettings}
        onStyle={() => { setSettingsMenuOpen(false); setShowStylePicker(true); }}
        onRefresh={() => { setSettingsMenuOpen(false); void refresh(state.sessionId); }}
        onModeChange={setWorkspaceMode}
        onToggleDocuments={() => setDocumentsCollapsed((value) => !value)}
      />

      <nav className="mobile-tabs" aria-label="主区域">
        <button
          type="button"
          className={mobileTab === "docs" ? "active" : ""}
          onClick={() => {
            setManagementView(null);
            setMobileTab("docs");
          }}
        >
          <Library className="tab-icon" size={19} aria-hidden="true" /><span>文档</span>
        </button>
        <button
          type="button"
          className={mobileTab === "editor" ? "active" : ""}
          onClick={() => {
            setManagementView(null);
            setMobileTab("editor");
          }}
        >
          <BookOpenText className="tab-icon" size={19} aria-hidden="true" /><span>正文</span>
        </button>
        <button
          type="button"
          className={mobileTab === "agent" ? "active" : ""}
          onClick={() => {
            setManagementView(null);
            setMobileTab("agent");
          }}
        >
          <Bot className="tab-icon" size={19} aria-hidden="true" /><span>Agent</span>
        </button>
      </nav>

      <aside className={`documents ${mobileTab === "docs" ? "mobile-active" : ""}`}>
        <div className="file-manager-head">
          <div>
            <span className="file-manager-kicker">Workspace</span>
            <h2>项目文件</h2>
          </div>
          <span className="file-manager-count">
            {fileQuery.trim() ? `${state.documents.length - visibleTree.reduce((sum, node) => sum + countFiles(node), 0)} 条已筛除` : `${state.documents.length} 篇`}
          </span>
        </div>

        <div className="file-manager-tools">
          <label className="file-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={fileSearchRef}
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="搜索文件或路径…"
              aria-label="搜索项目文件"
              aria-keyshortcuts="/"
            />
            {fileQuery && <button type="button" title="清除搜索" onClick={() => setFileQuery("")}><X size={13} /></button>}
          </label>
          <div className="file-view-actions">
            <button type="button" title="展开全部" onClick={() => setExpandedFolders(new Set(collectFolderPaths(tree)))}>
              <ChevronDown size={14} />
            </button>
            <button type="button" title="收起全部" onClick={() => setExpandedFolders(new Set())}>
              <Minus size={14} />
            </button>
            <button type="button" title="刷新文件列表" onClick={() => void refresh(state.sessionId)}>
              <RefreshCw size={14} />
            </button>
          </div>
        </div>
        <div className="file-manager-actions">
          <button
            type="button"
            className="fm-btn"
            onClick={() => {
              setCreating({ parent: "", kind: "file" });
              setCreateValue("新文档");
            }}
          >
            <FilePlus2 size={15} aria-hidden="true" />
            新建文档
          </button>
          <button
            type="button"
            className="fm-btn"
            onClick={() => {
              setCreating({ parent: "", kind: "folder" });
              setCreateValue("新文件夹");
            }}
          >
            <FolderPlus size={15} aria-hidden="true" />
            新建文件夹
          </button>
        </div>

        {renaming && (
          <div className="inline-edit">
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={submitRename}
              placeholder="新名称…"
            />
          </div>
        )}

        {creating && (
          <div className="inline-edit">
            <input
              ref={createInputRef}
              value={createValue}
              onChange={(e) => setCreateValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCreate();
                if (e.key === "Escape") setCreating(null);
              }}
              onBlur={submitCreate}
              placeholder={creating.kind === "file" ? "文件名.md" : "文件夹名称"}
            />
          </div>
        )}

        <div className="sidebar-section docs">
          {tree.length === 0 ? (
            <div className="sidebar-empty">
              <div className="sidebar-empty-icon" aria-hidden="true">
                <FolderPlus size={32} />
              </div>
              <strong>还没有文档</strong>
              <span>点击上方按钮创建文档或文件夹</span>
            </div>
          ) : visibleTree.length === 0 ? (
            <div className="sidebar-empty compact">
              <Search size={24} aria-hidden="true" />
              <strong>没有匹配的文件</strong>
              <span>换个名称或路径关键词试试</span>
              <button type="button" onClick={() => setFileQuery("")}>清除搜索</button>
            </div>
          ) : (
            <div
              className="document-tree"
              title="可将文件或文件夹拖到此处，移回项目根目录"
              onDragOver={(event) => {
                if (event.currentTarget === event.target) event.preventDefault();
              }}
              onDrop={(event) => {
                if (event.currentTarget !== event.target) return;
                event.preventDefault();
                const raw = event.dataTransfer.getData("application/x-writer-node");
                if (!raw) return;
                const payload = JSON.parse(raw) as { path: string; kind: "file" | "folder" };
                void handleMoveNode(payload.path, payload.kind, "");
              }}
            >
              {visibleTree.map((node) => (
                <FileTreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  activePath={activePath}
                  onSelect={(path) => {
                    setActivePath(path);
                    setMobileTab("editor");
                  }}
                  onRename={handleRename}
                  onDelete={handleDelete}
                  onToggleHidden={handleToggleHidden}
                  onMoveNode={handleMoveNode}
                  onDuplicate={handleDuplicate}
                  onNewChild={handleNewChild}
                  expandedFolders={visibleExpandedFolders}
                  setExpandedFolders={setExpandedFolders}
                />
              ))}
            </div>
          )}
        </div>

      </aside>

      <main className={`editor ${mobileTab === "editor" ? "mobile-active" : ""}`}>
        <div className="editor-bar">
          <span className="doc-path">
            {activePath || "No document selected"}
            {browsingVersion && (
              <span className="version-badge" title="仅浏览历史版本，不影响 Agent 上下文">
                历史 · #{browsingVersion.id}
              </span>
            )}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className={`style-chip${activeStyle ? " active" : ""}`}
              title={activeStyle ? `写作风格：${activeStyle.name}（点击更换）` : "配置写作风格模板"}
              onClick={() => setShowStylePicker(true)}
            >
              {activeStyle ? `风格 · ${activeStyle.name}` : "风格 · 未设置"}
            </button>
            {!editingDocument && (document.content || browsingVersion) && (
              <div className="reader-controls">
                <div className="ctrl-group">
                  <span className="ctrl-label">A</span>
                  <button onClick={() => setReaderFontSize((v) => Math.max(12, v - 1))} title="减小字号" aria-label="减小字号"><Minus size={12} /></button>
                  <span className="ctrl-val">{readerFontSize}</span>
                  <button onClick={() => setReaderFontSize((v) => Math.min(24, v + 1))} title="增大字号" aria-label="增大字号"><Plus size={12} /></button>
                </div>
                <div className="ctrl-group">
                  <span className="ctrl-label">W</span>
                  <button onClick={() => setReaderWidth((v) => Math.max(420, v - 60))} title="缩窄正文" aria-label="缩窄正文"><Minus size={12} /></button>
                  <span className="ctrl-val">{readerWidth}</span>
                  <button onClick={() => setReaderWidth((v) => Math.min(1200, v + 60))} title="加宽正文" aria-label="加宽正文"><Plus size={12} /></button>
                </div>
              </div>
            )}
            <div className="editor-bar-actions">
              {!editingDocument && (
                <button disabled={!activePath || focusedExportBusy} onClick={() => void exportFocusedDocument()} title="下载当前正在浏览的 Markdown 文件">
                  <Download size={14} />下载
                </button>
              )}
              {browsingVersion ? (
                <button className="primary" onClick={exitVersionBrowse} title="回到磁盘上的当前版本">
                  返回当前
                </button>
              ) : editingDocument ? (
                <>
                  <button onClick={cancelEdit}><X size={14} />取消</button>
                  <button className="primary" onClick={() => void saveDocument()}>
                    <Save size={14} />保存
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={versionPanelOpen ? "active" : ""}
                    disabled={!activePath}
                    onClick={() => void toggleVersionPanel()}
                    title="浏览文档历史版本（只读，Agent 仅见当前版）"
                  >
                    <History size={14} />版本
                  </button>
                  <button disabled={!activePath} onClick={() => setEditingDocument(true)}>
                    <Pencil size={14} />编辑
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
        {editingDocument ? (
          <textarea value={documentDraft} onChange={(e) => setDocumentDraft(e.target.value)} />
        ) : (
          <div className={`document-reader-shell${versionPanelOpen ? " with-versions" : ""}`}>
            {versionPanelOpen && (
              <aside className="version-panel" aria-label="文档版本历史">
                <div className="version-panel-head">
                  <strong>版本历史</strong>
                  <span className="version-panel-hint">仅浏览 · Agent 只见当前</span>
                </div>
                {versionsLoading ? (
                  <div className="version-panel-empty">加载中…</div>
                ) : versions.length === 0 ? (
                  <div className="version-panel-empty">暂无历史版本。接受提案或保存编辑后会出现记录。</div>
                ) : (
                  <ul className="version-list">
                    <li>
                      <button
                        type="button"
                        className={`version-item${!browsingVersion ? " active" : ""}`}
                        onClick={exitVersionBrowse}
                      >
                        <span className="version-item-title">当前版本</span>
                        <span className="version-item-meta">磁盘上的最新内容</span>
                      </button>
                    </li>
                    {versions.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className={`version-item${browsingVersion?.id === item.id ? " active" : ""}${item.undone ? " version-undone" : ""}`}
                          disabled={versionBusy}
                          onClick={() => void openVersion(item)}
                        >
                          <span className="version-item-title">
                            #{item.id}
                            {item.isCurrent && <em className="version-tag">当前</em>}
                            {item.undone && <em className="version-tag version-tag-undone">已回退</em>}
                            {item.createdFile && !item.undone && <em className="version-tag">新建</em>}
                          </span>
                          <span className="version-item-meta">
                            {formatVersionTime(item.createdAt)} · {item.summary}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </aside>
            )}
            <div className="document-reader" ref={documentReaderRef}>
              {browsingVersion ? (
                <div className="version-browse-layout">
                  <div className="version-browse-banner">
                    <div>
                      <strong>历史版本 #{browsingVersion.id}</strong>
                      <span>
                        {formatVersionTime(browsingVersion.createdAt)} · {browsingVersion.summary}
                      </span>
                    </div>
                    <span className="version-legend">
                      <span className="legend-remove">删除</span>
                      <span className="legend-add">新增</span>
                    </span>
                  </div>
                  <DocumentDiffView
                    before={browsingVersion.beforeContent}
                    after={browsingVersion.afterContent}
                  />
                </div>
              ) : document.content ? (
                <div className={`document-reader-layout${headings.length === 0 ? " without-outline" : ""}${outlineCollapsed ? " outline-collapsed" : ""}`}>
                  {headings.length > 0 && (
                    <nav className={`document-outline ${outlineCollapsed ? "collapsed" : ""}`} aria-label="Document sections">
                      <div className="document-outline-head">
                        {!outlineCollapsed && <strong>Sections</strong>}
                        <button
                          className="document-outline-toggle"
                          onClick={() => setOutlineCollapsed((value) => !value)}
                          title={outlineCollapsed ? "Expand sections" : "Collapse sections"}
                          aria-label={outlineCollapsed ? "Expand sections" : "Collapse sections"}
                          aria-expanded={!outlineCollapsed}
                        >
                          {outlineCollapsed ? <Menu size={15} /> : <ChevronLeft size={15} />}
                        </button>
                      </div>
                      {!outlineCollapsed && headings.map((heading) => (
                          <button
                            key={heading.id}
                            className={`document-outline-item level-${heading.level}`}
                            title={heading.text}
                            onClick={() => documentReaderRef.current?.querySelector(`#${heading.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                          >
                            {heading.text}
                          </button>
                        ))}
                    </nav>
                  )}
                  <Markdown content={document.content} headingPrefix="document" />
                </div>
              ) : (
                <div className="empty-state reader-empty">
                  <p>Select a document</p>
                  <span className="empty-hint">Open a file from the workspace to read or edit</span>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      <section className={`agent-panel ${mobileTab === "agent" ? "mobile-active" : ""} ${busy ? "agent-busy" : ""}`}>
        <div className="agent-head">
          <div className="agent-head-brand">
            <span className="agent-mark" aria-hidden="true"><Bot size={17} /></span>
            <h2>
              Agent
              <small>
                {busy ? "Thinking & writing…" : "Ready for your task"}
              </small>
            </h2>
          </div>
          <div className="agent-head-actions">
            {!busy && (
              <IconButton
                label="新建会话"
                onClick={() => void (async () => {
                  clearAgentStream({ abort: true });
                  const result = await api<{ sessionId: string }>("/api/session", { method: "POST" });
                  await refresh(result.sessionId);
                })()}
              ><Plus size={16} /></IconButton>
            )}
            <span className={`agent-status ${busy ? "running" : ""}`}>{busy ? "Running" : "Idle"}</span>
            {busy && (
              <button className="agent-stop-btn" onClick={stop}>
                Stop
              </button>
            )}
          </div>
        </div>
        <div className="agent-control-bar">
          <div className="permission-mode-switch" role="group" aria-label="Permission mode">
            {PERMISSION_MODES.map((mode) => {
              const active = (state.agentSettings?.permissionMode ?? "ask") === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  className={`permission-mode-btn${active ? " active" : ""}`}
                  title={mode.hint}
                  disabled={busy || Boolean(roleplay)}
                  onClick={() => void setPermissionMode(mode.id)}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
          {state.projectInstructions && (
            <span className="agent-control-meta" title="已加载项目指令">
              {state.projectInstructions}
            </span>
          )}
        </div>
        {roleplay && (
          <div className="roleplay-banner" role="status">
            <div className="roleplay-banner-copy">
              <div className="roleplay-banner-heading">
                <span className="roleplay-banner-kicker">角色扮演</span>
                <strong>「{roleplay.performer.name}」×「{roleplay.identity.name}」</strong>
                {roleplay.scene && <span className="roleplay-scene-chip">{roleplay.scene.name}</span>}
              </div>
              <details className="roleplay-session-details">
                <summary>查看当前角色与场景设定</summary>
                <div className="roleplay-session-body">
                  <span>扮演者：{roleplay.performer.name}（{roleplay.performer.kind === "normal" ? "普通卡" : "简易卡"}）</span>
                  <dl>
                    <div><dt>身份</dt><dd>{roleplay.identity.card.identity}</dd></div>
                    <div><dt>关系</dt><dd>{roleplay.identity.card.relationship}</dd></div>
                    <div><dt>已知</dt><dd>{roleplay.identity.card.knowledge}</dd></div>
                    <div><dt>场景</dt><dd>{roleplay.identity.card.scene}</dd></div>
                    <div><dt>目标</dt><dd>{roleplay.identity.card.goal}</dd></div>
                    {roleplay.scene && <>
                      <div><dt>独立场景</dt><dd>{roleplay.scene.name}</dd></div>
                      <div><dt>前提</dt><dd>{roleplay.scene.premise}</dd></div>
                      <div><dt>时间</dt><dd>{roleplay.scene.timelineAnchor}</dd></div>
                    </>}
                  </dl>
                </div>
              </details>
            </div>
            <div className="roleplay-banner-actions">
              <div className="roleplay-input-mode" role="group" aria-label="角色扮演输入模式">
                <button type="button" className={roleplayInputMode === "dialogue" ? "active" : ""} onClick={() => setRoleplayInputMode("dialogue")}>角色内</button>
                <button type="button" className={roleplayInputMode === "director" ? "active" : ""} onClick={() => setRoleplayInputMode("director")}>导演</button>
              </div>
              <div className="roleplay-action-group">
                <button type="button" disabled={busy} title={`让「${roleplay.performer.name}」根据场景先开口`} onClick={() => void requestRoleplayOpening()}>主动开场</button>
                <button type="button" disabled={busy} onClick={() => setRoleplayMemoryOpen(true)}>事实记忆</button>
                {roleplay.identity.kind === "generated" && (
                  <button type="button" disabled={busy} onClick={() => void saveCurrentRoleplayInterlocutor()}>保存身份</button>
                )}
              </div>
              <div className="roleplay-action-group roleplay-action-group-secondary">
                <button type="button" disabled={busy} onClick={() => beginRoleplaySetup()}>更换设定</button>
                <button type="button" className="roleplay-exit-button" disabled={busy} onClick={() => void exitRoleplay()}>退出</button>
              </div>
            </div>
          </div>
        )}
        {(state.todos?.length ?? 0) > 0 && (
          <div className="agent-todos" aria-label="Agent task list">
            <button
              type="button"
              className="agent-todos-head"
              aria-expanded={!todosCollapsed}
              onClick={() => setTodosCollapsed(value => !value)}
            >
              <strong>Tasks</strong>
              <span>
                {state.todos!.filter((item) => item.status === "completed").length}/{state.todos!.length}
              </span>
            </button>
            {!todosCollapsed && <ul className="agent-todos-list">
              {state.todos!.map((todo) => (
                <li key={todo.id} className={`todo-${todo.status}`}>
                  <span className="todo-mark" aria-hidden="true">{todoStatusMark(todo.status)}</span>
                  <span className="todo-body">
                    <code>{todo.id}</code>
                    {todo.content}
                  </span>
                </li>
              ))}
            </ul>}
          </div>
        )}
        <div className="conversation-region">
          <div
            className="conversation"
            ref={conversationRef}
            onScroll={(event) => {
              updateConversationBottom(event.currentTarget);
              if (event.currentTarget.scrollTop <= 80) void loadOlderMessages();
            }}
          >
          {state.messagesHasMore && (
            <button className="load-older-messages" type="button" disabled={olderMessagesLoading} onClick={() => void loadOlderMessages()}>
              {olderMessagesLoading ? "\u6b63\u5728\u52a0\u8f7d..." : "\u52a0\u8f7d\u66f4\u65e9\u6d88\u606f"}
            </button>
          )}
          {visibleMessages.map((msg) => (
            <React.Fragment key={msg.id}>
            {(() => {
              const displayContent = messageVersionViews[msg.id]?.versions[messageVersionViews[msg.id].current]?.content ?? msg.content;
              const assistantCollapsed = msg.role === "assistant" && collapsedAssistantIds.has(msg.id);
              return (
            <article className={`${msg.role}${msg.channel === "roleplay" ? " roleplay-msg" : ""}${assistantCollapsed ? " collapsed" : ""}`}>
              {msg.role === "assistant" ? (
                <button
                  type="button"
                  className="msg-label msg-label-toggle"
                  aria-expanded={!assistantCollapsed}
                  title={assistantCollapsed ? "展开回复" : "折叠回复"}
                  onClick={() =>
                    setCollapsedAssistantIds((current) => {
                      const next = new Set(current);
                      if (next.has(msg.id)) next.delete(msg.id);
                      else next.add(msg.id);
                      return next;
                    })
                  }
                >
                  <span>{msg.channel === "roleplay" ? "角色" : "Assistant"}</span>
                  {msg.channel === "roleplay" ? <span className="msg-channel-tag" title="角色扮演试演；写作 Agent 可读，扮演模式不读写作对话">扮演</span> : null}
                  <span className="msg-chevron" aria-hidden="true">{assistantCollapsed ? "▾" : "▴"}</span>
                </button>
              ) : (
                <div className="msg-label">
                  <span>You</span>
                  {msg.channel === "roleplay" ? <span className="msg-channel-tag" title="角色扮演试演；写作 Agent 可读，扮演模式不读写作对话">扮演</span> : null}
                </div>
              )}
              {msg.role === "assistant" ? (
                assistantCollapsed
                  ? <p className="msg-preview">{messagePreview(displayContent)}</p>
                  : <Markdown content={displayContent} />
              ) : (
                <div>{displayContent}</div>
              )}
              {msg.id > 0 && <div className="message-actions">
                {(msg.variantCount ?? 1) > 1 && (() => {
                  const current = messageVersionViews[msg.id]?.current ?? (msg.variantCount ?? 1) - 1;
                  const total = messageVersionViews[msg.id]?.versions.length ?? msg.variantCount ?? 1;
                  return <span className="message-version-nav" title="查看此分支的不同消息版本">
                    <button
                      disabled={busy || current <= 0}
                      onClick={() => void shiftMessageVersion(msg, -1)}
                      aria-label="上一个消息版本"
                    >‹</button>
                    <span>{current + 1}/{total}</span>
                    <button
                      disabled={busy || current >= total - 1}
                      onClick={() => void shiftMessageVersion(msg, 1)}
                      aria-label="下一个消息版本"
                    >›</button>
                  </span>;
                })()}
                {msg.role === "user" && <button disabled={busy} onClick={() => requestRewindMessage(msg)} title="从此消息重新编辑">编辑</button>}
                <button disabled={busy} onClick={() => requestRerunMessage(msg)} title="重新运行这条消息所在的轮次">重新运行</button>
                {msg.channel === "roleplay" && <button disabled={busy} onClick={() => { setRoleplayFactDraft(newFactDraft(msg)); setRoleplayMemoryOpen(true); }} title="把这条消息保存为可纠错的事实记忆">记住</button>}
              </div>}
            </article>
              );
            })()}
            {streamStepsAnchorId === msg.id && (
              <>
                {streamSteps.map((step) => (
                  <AgentStepCard
                    key={step.id}
                    step={step}
                    onToggle={() =>
                      setStreamSteps((current) =>
                        current.map((s) => (s.id === step.id ? { ...s, expanded: !s.expanded } : s)),
                      )
                    }
                  />
                ))}
                {(() => {
                  const total = sumStepUsage(streamSteps);
                  if (!total || streamSteps.length < 1) return null;
                  return (
                    <div className="agent-step-trail-total" title={stepUsageTitle(total)}>
                      <span>本轮合计{total.estimated ? "（含估算）" : ""}</span>
                      <StepTokenBadge usage={total} />
                    </div>
                  );
                })()}
              </>
            )}
            </React.Fragment>
          ))}
          {/* Steps for a turn whose user bubble is not in the filtered list yet. */}
          {streamSteps.length > 0 && streamStepsAnchorId != null
            && !visibleMessages.some((msg) => msg.id === streamStepsAnchorId) && (
            <>
              {streamSteps.map((step) => (
                <AgentStepCard
                  key={`orphan-${step.id}`}
                  step={step}
                  onToggle={() =>
                    setStreamSteps((current) =>
                      current.map((s) => (s.id === step.id ? { ...s, expanded: !s.expanded } : s)),
                    )
                  }
                />
              ))}
            </>
          )}
          {state.messages.length === 0 && streamSteps.length === 0 && (
            <div className="empty-state">
              <div className="empty-orb" aria-hidden="true" />
              <p>Agent is ready</p>
              <span className="empty-hint">Describe a writing task — outline, revise, or continue a scene</span>
            </div>
          )}
          {notice && <article className="notice">{notice}</article>}
          {error && <article className="error">{error}</article>}
          </div>
          {!conversationAtBottom && (
            <button
              type="button"
              className="conversation-to-bottom"
              aria-label="到达对话最底部"
              title="到达对话最底部"
              onClick={scrollConversationToBottom}
            >
              <span aria-hidden="true">›</span>
            </button>
          )}
        </div>
        {(pendingChangeSets.length > 0 || pendingProposals.length > 0) && (
          <ReviewDock
            changeSets={pendingChangeSets}
            proposals={pendingProposals}
            pendingCount={pendingChangeSets.length + pendingProposals.length}
            open={reviewOpen}
            onToggle={() => setReviewOpen((v) => !v)}
            onChangeSetAction={(value, action) => void decideChangeSet(value, action)}
            onProposalDecide={(p, action) => void decide(p, action)}
          />
        )}
        <div className="composer">
          <div className="composer-shell">
            {roleplay && roleplayInputMode === "director" && (
              <div className="director-mode-guide" role="note">
                <div className="director-mode-guide-title">
                  <div>
                    <span>导演模式</span>
                    <small>推荐用于推进与校准剧情</small>
                  </div>
                  <button type="button" disabled={busy || directorSuggestionBusy} onClick={() => void requestDirectorSuggestions()}>
                    {directorSuggestionBusy ? "推荐中…" : directorSuggestions.length ? "换一组" : "Flash 推荐"}
                  </button>
                </div>
                <p>说明场景、时间、节奏、角色态度或新增前提；角色对白请切回「角色内」。</p>
                {directorSuggestionError && <div className="director-mode-error">{directorSuggestionError}</div>}
                <div className="director-mode-examples" aria-label="导演指令示例">
                  {directorSuggestions.length
                    ? directorSuggestions.map((suggestion, index) => (
                        <button
                          type="button"
                          key={index + ":" + suggestion}
                          onClick={() => {
                            setPrompt(suggestion);
                            requestAnimationFrame(() => composerRef.current?.focus());
                          }}
                        >
                          {suggestion}
                        </button>
                      ))
                    : <span className="director-mode-empty">使用通用 Flash 模型，根据当前场景与最近对话生成可直接发送的指令。</span>}
                </div>
              </div>
            )}
            <textarea
              ref={composerRef}
              value={prompt}
              onFocus={() => { composerFocusedAtBottomRef.current = conversationAtBottomRef.current; }}
              onBlur={() => { composerFocusedAtBottomRef.current = false; }}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void sendChat();
                }
                if (busy && e.key === "Escape") {
                  e.preventDefault();
                  stop();
                }
              }}
              placeholder={roleplay
                ? roleplayInputMode === "director"
                  ? "输入导演指示，例如：加快节奏，让冲突在三轮内升级…"
                  : `以「${roleplay.identity.name}」身份对「${roleplay.performer.name}」说话…（Ctrl+Enter 发送）`
                : "Describe your writing task… (Ctrl+Enter to send)"}
              disabled={busy}
            />
            <div className="composer-actions">
              <span className="composer-hint">
                {busy ? "Esc to stop" : roleplay ? `${roleplayInputMode === "director" ? "导演指示" : "角色内"} · Ctrl+Enter` : "Ctrl+Enter"}
              </span>
              <button
                className={`composer-send ${busy ? "stop" : "primary"}`}
                onClick={busy ? stop : () => void sendChat()}
                disabled={!busy && !prompt.trim()}
              >
                {busy ? "Stop" : "Send"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {branchConfirm && (
        <div
          className="modal-backdrop nested"
          role="presentation"
          onMouseDown={() => setBranchConfirm(null)}
        >
          <div
            className="modal branch-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="branch-confirm-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">{branchConfirm.mode === "edit" ? "Edit branch" : "Rerun turn"}</span>
            <h2 id="branch-confirm-title">
              {branchConfirm.mode === "edit" ? "编辑这条消息" : "重新运行这一轮"}
            </h2>
            <p>
              当前回答会保存为历史版本；此消息之后的对话会撤销。
              已接受的<strong>文档修改</strong>与<strong>角色卡修改</strong>可选择保留或回退。
            </p>
            <div className="modal-actions branch-confirm-actions">
              <button type="button" onClick={() => setBranchConfirm(null)}>取消</button>
              <button
                type="button"
                className="danger"
                onClick={() => void confirmBranchAction(false)}
                title="回退该轮之后已接受的文档与角色卡修改"
              >
                回退更改
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void confirmBranchAction(true)}
                title="保留该轮之后已接受的文档与角色卡修改"
              >
                保留更改
              </button>
            </div>
          </div>
        </div>
      )}

      {roleplaySetup && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => !roleplaySetupBusy && setRoleplaySetup(null)}
        >
          <div
            className="modal roleplay-setup-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="roleplay-setup-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">Roleplay audition</span>
            <h2 id="roleplay-setup-title">开始角色扮演</h2>
            <p>分别选择由 AI 扮演的角色卡和你当前使用的身份。两边都支持简易角色卡或普通角色卡。</p>
            <label>
              <span>扮演者</span>
              <select
                value={roleplaySetup.performer ? `${roleplaySetup.performer.kind}:${roleplaySetup.performer.id}` : ""}
                disabled={roleplaySetupBusy}
                onChange={(event) => setRoleplaySetup({ ...roleplaySetup, performer: roleplayCards().find(item => `${item.kind}:${item.id}` === event.target.value) ?? null })}
              >
                <option value="">请选择角色卡</option>
                <optgroup label="普通角色卡">{state.characters.map(item => <option key={`normal-${item.id}`} value={`normal:${item.id}`}>{item.identity.name}</option>)}</optgroup>
                <optgroup label="简易角色卡">{state.roleplayInterlocutors.map(item => <option key={`simple-${item.id}`} value={`simple:${item.id}`}>{item.name}</option>)}</optgroup>
              </select>
            </label>
            <label>
              <span>当前身份</span>
              <select
                value={roleplaySetup.identity ? `${roleplaySetup.identity.kind}:${roleplaySetup.identity.id}` : "generated"}
                disabled={roleplaySetupBusy}
                onChange={(event) => setRoleplaySetup({ ...roleplaySetup, identity: event.target.value === "generated" ? null : roleplayCards().find(item => `${item.kind}:${item.id}` === event.target.value) ?? null })}
              >
                <option value="generated">根据描述生成简易角色卡（默认）</option>
                <optgroup label="普通角色卡">{state.characters.map(item => <option key={`identity-normal-${item.id}`} value={`normal:${item.id}`}>{item.identity.name}</option>)}</optgroup>
                <optgroup label="简易角色卡">{state.roleplayInterlocutors.map(item => <option key={`identity-simple-${item.id}`} value={`simple:${item.id}`}>{item.name}</option>)}</optgroup>
              </select>
            </label>
            <label>
              <span>场景卡（可选）</span>
              <select
                value={roleplaySetup.scene?.id ?? ""}
                disabled={roleplaySetupBusy}
                onChange={(event) => setRoleplaySetup({ ...roleplaySetup, scene: state.roleplayScenes.find(item => item.id === Number(event.target.value)) ?? null })}
              >
                <option value="">不使用独立场景卡</option>
                {state.roleplayScenes.map(scene => <option key={scene.id} value={scene.id}>{scene.name}</option>)}
              </select>
            </label>
            <div className="roleplay-inline-actions">
              <button type="button" disabled={roleplaySetupBusy} onClick={() => setRoleplaySceneDraft(emptyRoleplayScene())}>新建场景</button>
              {roleplaySetup.scene && <button type="button" disabled={roleplaySetupBusy} onClick={() => setRoleplaySceneDraft({ ...roleplaySetup.scene! })}>编辑当前场景</button>}
            </div>
            {!roleplaySetup.identity && <>
            <label>
              <span>生成要求（可留空）</span>
              <textarea
                autoFocus
                rows={6}
                disabled={roleplaySetupBusy}
                value={roleplaySetup.request}
                placeholder="例如：我是她失联三年的旧搭档，刚在泛亚空间站重逢；沿用项目中已有组织与事件设定。"
                onChange={(event) => setRoleplaySetup({ ...roleplaySetup, request: event.target.value })}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void confirmRoleplaySetup();
                }}
              />
            </label>
            <small>留空会使用“身份未知的来访者”，不调用模型查询。</small>
            <label className="roleplay-persist-choice">
              <input
                type="checkbox"
                disabled={roleplaySetupBusy}
                checked={roleplaySetup.persist}
                onChange={(event) => setRoleplaySetup({ ...roleplaySetup, persist: event.target.checked })}
              />
              <span>生成后保存为简易角色卡</span>
            </label>
            </>}
            {roleplaySetupBusy && roleplaySetupPhase && (
              <div className="roleplay-setup-progress" role="status" aria-live="polite" aria-busy="true">
                <div className="roleplay-progress-head">
                  <span className="roleplay-progress-spinner" aria-hidden="true" />
                  <span>
                    <strong>{ROLEPLAY_SETUP_PHASE_LABELS[roleplaySetupPhase]}</strong>
                    <small aria-hidden="true">{"\u4ecd\u5728\u8fd0\u884c \u00b7 \u5df2\u7528\u65f6"} {roleplaySetupElapsed} {"\u79d2"}</small>
                  </span>
                </div>
                <div className="roleplay-progress-track" aria-hidden="true"><span /></div>
                <div className="roleplay-progress-steps" aria-hidden="true">
                  {roleplaySetupPhases(roleplaySetup.persist).map((phase, index, phases) => {
                    const current = phases.indexOf(roleplaySetupPhase);
                    return <span key={phase} className={index < current ? "done" : index === current ? "active" : ""}>{ROLEPLAY_SETUP_STEP_LABELS[phase]}</span>;
                  })}
                </div>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" disabled={roleplaySetupBusy} onClick={() => setRoleplaySetup(null)}>取消</button>
              <button type="button" className="primary" disabled={roleplaySetupBusy} onClick={() => void confirmRoleplaySetup()}>
                {roleplaySetupBusy ? "正在设定…" : "开始扮演"}
              </button>
            </div>
          </div>
        </div>
      )}

      {roleplaySceneDraft && (
        <div className="modal-backdrop nested" role="presentation" onMouseDown={() => setRoleplaySceneDraft(null)}>
          <div className="modal roleplay-setup-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <span className="eyebrow">Roleplay scene</span>
            <h2>{roleplaySceneDraft.id ? "编辑场景卡" : "新建场景卡"}</h2>
            <p>场景独立于角色卡，可复用于不同角色；绑定的 lore 会经过语义重排后按需注入。</p>
            {([[
              "name", "名称（必填）"], ["setting", "地点与环境"], ["premise", "场景前提"], ["tone", "基调"],
              ["timelineAnchor", "时间/剧情阶段"], ["performerGoal", "AI 角色目标"], ["identityGoal", "用户身份目标"],
            ] as Array<[keyof RoleplaySceneDraft, string]>).map(([field, label]) => <label key={field}>
              <span>{label}</span>
              {field === "name" ? <input value={String(roleplaySceneDraft[field])} onChange={event => setRoleplaySceneDraft({ ...roleplaySceneDraft, [field]: event.target.value })} />
                : <textarea rows={2} value={String(roleplaySceneDraft[field])} onChange={event => setRoleplaySceneDraft({ ...roleplaySceneDraft, [field]: event.target.value })} />}
            </label>)}
            {([[
              "stakes", "风险/悬念（每行一项）"], ["openingVariants", "开场意图（每行一项）"],
              ["endConditions", "结束条件（每行一项）"], ["loreBindings", "绑定 lore 路径（每行一项，如 lore/组织.md）"],
            ] as Array<["stakes" | "openingVariants" | "endConditions" | "loreBindings", string]>).map(([field, label]) => <label key={field}>
              <span>{label}</span>
              <textarea rows={3} value={roleplaySceneDraft[field].join("\n")} onChange={event => setRoleplaySceneDraft({ ...roleplaySceneDraft, [field]: event.target.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean) })} />
            </label>)}
            <div className="modal-actions">
              {roleplaySceneDraft.id && <button type="button" className="danger" onClick={() => void deleteRoleplayScene(roleplaySceneDraft.id!)}>删除</button>}
              <button type="button" onClick={() => setRoleplaySceneDraft(null)}>取消</button>
              <button type="button" className="primary" disabled={!roleplaySceneDraft.name.trim()} onClick={() => void saveRoleplayScene()}>保存场景</button>
            </div>
          </div>
          </div>
      )}

      {roleplayMemoryOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { setRoleplayMemoryOpen(false); setRoleplayFactDraft(null); }}>
          <div className="modal roleplay-memory-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <span className="eyebrow">Roleplay memory</span>
            <h2>事实记忆</h2>
            <p>这些事实会进入当前角色、身份与场景组合的上下文。可以纠错、撤回、置顶，并限制谁知道。</p>
            {state.roleplayMemory?.summary && <details><summary>滚动摘要</summary><pre className="roleplay-memory-summary">{state.roleplayMemory.summary}</pre></details>}
            <div className="roleplay-memory-list">
              {state.roleplayMemoryFacts.filter(fact => !state.roleplayMemory || fact.contextKey === state.roleplayMemory.performerKey).map(fact => (
                <button type="button" className={`roleplay-memory-item status-${fact.status}`} key={fact.id} onClick={() => setRoleplayFactDraft({
                  id: fact.id, kind: fact.kind, content: fact.content, ...(fact.sourceMessageId ? { sourceMessageId: fact.sourceMessageId } : {}),
                  knownBy: fact.knownBy, importance: fact.importance, status: fact.status, pinned: fact.pinned,
                })}>
                  <span>{fact.pinned ? "📌 " : ""}{fact.content}</span>
                  <small>{fact.kind} · {fact.knownBy.join("/")} · {fact.importance}{fact.sourceMessageId ? ` · #${fact.sourceMessageId}` : ""}</small>
                </button>
              ))}
              {!state.roleplayMemoryFacts.some(fact => !state.roleplayMemory || fact.contextKey === state.roleplayMemory.performerKey) && <p className="management-empty">还没有事实记忆。</p>}
            </div>
            {roleplayFactDraft ? <div className="roleplay-fact-editor">
              <label><span>事实</span><textarea rows={4} value={roleplayFactDraft.content} onChange={event => setRoleplayFactDraft({ ...roleplayFactDraft, content: event.target.value })} /></label>
              <div className="roleplay-fact-grid">
                <label><span>类型</span><select value={roleplayFactDraft.kind} onChange={event => setRoleplayFactDraft({ ...roleplayFactDraft, kind: event.target.value as RoleplayFactDraft["kind"] })}>
                  <option value="event">事件</option><option value="promise">承诺</option><option value="relationship">关系</option><option value="secret">秘密</option><option value="preference">偏好</option>
                </select></label>
                <label><span>谁知道</span><select value={roleplayFactDraft.knownBy[0] ?? "public"} onChange={event => setRoleplayFactDraft({ ...roleplayFactDraft, knownBy: [event.target.value as "public" | "performer" | "identity"] })}>
                  <option value="public">双方/公开</option><option value="performer">仅 AI 角色</option><option value="identity">仅用户身份</option>
                </select></label>
                <label><span>状态</span><select value={roleplayFactDraft.status} onChange={event => setRoleplayFactDraft({ ...roleplayFactDraft, status: event.target.value as RoleplayFactDraft["status"] })}>
                  <option value="active">有效</option><option value="superseded">已被取代</option><option value="retracted">撤回</option>
                </select></label>
                <label><span>重要度 {roleplayFactDraft.importance}</span><input type="range" min="0" max="100" value={roleplayFactDraft.importance} onChange={event => setRoleplayFactDraft({ ...roleplayFactDraft, importance: Number(event.target.value) })} /></label>
              </div>
              <label className="roleplay-persist-choice"><input type="checkbox" checked={roleplayFactDraft.pinned} onChange={event => setRoleplayFactDraft({ ...roleplayFactDraft, pinned: event.target.checked })} /><span>置顶，不随普通回滚自动删除</span></label>
              <div className="modal-actions">
                {roleplayFactDraft.id && <button type="button" className="danger" onClick={() => void deleteRoleplayFact(roleplayFactDraft.id!)}>删除</button>}
                <button type="button" onClick={() => setRoleplayFactDraft(null)}>取消编辑</button>
                <button type="button" className="primary" disabled={!roleplayFactDraft.content.trim()} onClick={() => void saveRoleplayFact()}>保存事实</button>
              </div>
            </div> : <div className="modal-actions"><button type="button" onClick={() => setRoleplayFactDraft(newFactDraft())}>新增事实</button><button type="button" onClick={() => setRoleplayMemoryOpen(false)}>关闭</button></div>}
          </div>
        </div>
      )}

      {simpleCardDraft && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSimpleCardDraft(null)}>
          <div className="modal roleplay-setup-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <span className="eyebrow">Simple character card</span>
            <h2>{simpleCardDraft.id ? "编辑简易角色卡" : "新建简易角色卡"}</h2>
            <p>只保留角色扮演所需的少量信息，可作为扮演者或当前身份使用。</p>
            {([
              ["name", "名称（必填）"], ["identity", "身份"], ["relationship", "关系"],
              ["knowledge", "已知信息"], ["scene", "场景"], ["goal", "目标"],
            ] as Array<[keyof RoleplayInterlocutor, string]>).map(([field, label]) => (
              <label key={field}>
                <span>{label}</span>
                {field === "name" ? (
                  <input autoFocus value={simpleCardDraft[field]} onChange={(event) => setSimpleCardDraft({ ...simpleCardDraft, [field]: event.target.value })} />
                ) : (
                  <textarea rows={2} value={simpleCardDraft[field]} onChange={(event) => setSimpleCardDraft({ ...simpleCardDraft, [field]: event.target.value })} />
                )}
              </label>
            ))}
            <div className="modal-actions">
              {simpleCardDraft.id && <button className="danger" type="button" onClick={async () => {
                await deleteSavedRoleplayInterlocutor(simpleCardDraft.id!);
                setSimpleCardDraft(null);
              }}>删除</button>}
              <button type="button" onClick={() => setSimpleCardDraft(null)}>取消</button>
              <button className="primary" type="button" disabled={!simpleCardDraft.name.trim()} onClick={() => void saveSimpleCard()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {showStylePicker && (
        <div
          className="theme-picker-backdrop"
          onMouseDown={() => !styleBusy && setShowStylePicker(false)}
          role="presentation"
        >
          <div
            className="theme-picker style-picker"
            role="dialog"
            aria-modal="true"
            aria-label="写作风格模板"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="theme-picker-head">
              <div>
                <span className="eyebrow">Writing style</span>
                <h2>写作风格模板</h2>
                <p>
                  激活后会注入对应系统提示与范文示例，并应用建议的 temperature / topP。可随时关闭。
                </p>
              </div>
              <IconButton label="关闭" disabled={styleBusy} onClick={() => setShowStylePicker(false)}><X size={17} /></IconButton>
            </div>
            <div className="style-picker-actions">
              <button type="button" className="primary" disabled={styleBusy} onClick={() => openStyleTemplate()}>
                新建模板
              </button>
              {activeStyle && (
                <button type="button" disabled={styleBusy} onClick={() => openStyleTemplate(activeStyle)}>
                  {(activeStyle.readOnly || activeStyle.builtIn) ? "浏览当前模板" : "编辑当前模板"}
                </button>
              )}
              <button
                type="button"
                className={`style-off${activeStyleId ? "" : " active"}`}
                disabled={styleBusy || !activeStyleId}
                onClick={() => void applyWritingStyle("")}
              >
                不使用模板
              </button>
              {activeStyle && (
                <span className="style-active-hint">
                  当前：{activeStyle.name}
                  {(activeStyle.readOnly || activeStyle.builtIn) ? "（内置·只读）" : ""}
                  {activeStyle.suggestedTemperature != null && ` · temp ${activeStyle.suggestedTemperature}`}
                  {activeStyle.suggestedTopP != null && ` · topP ${activeStyle.suggestedTopP}`}
                </span>
              )}
            </div>
            <div className="theme-grid style-grid">
              {styleTemplates.length === 0 ? (
                <div className="management-empty">暂无写作风格模板</div>
              ) : (
                styleTemplates.map((item) => {
                  const selected = item.id === activeStyleId;
                  const readOnly = Boolean(item.readOnly || item.builtIn);
                  const preview = (item.exampleContent ?? "").replace(/\s+/g, " ").trim().slice(0, 96);
                  return (
                    <div
                      key={item.id}
                      className={`theme-card style-card${selected ? " active" : ""}`}
                    >
                      <button
                        type="button"
                        className="style-card-select"
                        disabled={styleBusy}
                        onClick={() => void applyWritingStyle(item.id, item.name)}
                      >
                        <div className="theme-card-meta">
                        <strong>
                          {item.name}
                          {selected && <span className="theme-tag">使用中</span>}
                          {readOnly && <span className="theme-tag">内置</span>}
                          {!readOnly && item.customized && <span className="theme-tag">自定义</span>}
                        </strong>
                        <small>{item.description}</small>
                        {preview && (
                          <span className="theme-example style-example">{preview}{preview.length >= 96 ? "…" : ""}</span>
                        )}
                        {(item.suggestedTemperature != null || item.suggestedTopP != null) && (
                          <span className="style-params">
                            {item.suggestedTemperature != null && `temp ${item.suggestedTemperature}`}
                            {item.suggestedTemperature != null && item.suggestedTopP != null && " · "}
                            {item.suggestedTopP != null && `topP ${item.suggestedTopP}`}
                          </span>
                        )}
                        </div>
                      </button>
                      <button
                        type="button"
                        className="style-card-edit"
                        disabled={styleBusy}
                        onClick={() => openStyleTemplate(item)}
                      >
                        {readOnly ? "浏览" : "编辑"}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {styleDraft && (() => {
        const viewing = Boolean(styleDraft.readOnly || styleDraft.builtIn) && !styleDraft.isNew;
        return (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !styleBusy && setStyleDraft(null)}>
          <div className="modal style-template-editor" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <span className="eyebrow">Writing style template</span>
            <h2>
              {styleDraft.isNew
                ? "新建写作模板"
                : viewing
                  ? `浏览模板 · ${styleDraft.name}`
                  : `编辑模板 · ${styleDraft.name}`}
            </h2>
            <p>
              {viewing
                ? "内置模板只读。可查看完整写作指令与范文；激活后会把建议 temperature / topP 写入当前各角色模型。"
                : "自定义模板保存在当前项目的 .writer 目录中。内置模板不可编辑或覆盖，请使用新的模板 ID。"}
            </p>
            <div className="style-template-form">
              <label>
                <span>名称</span>
                <input autoFocus={!viewing} value={styleDraft.name} maxLength={80} disabled={viewing} onChange={(event) => setStyleDraft({ ...styleDraft, name: event.target.value })} />
              </label>
              <label>
                <span>模板 ID {styleDraft.isNew ? "（可留空自动生成）" : ""}</span>
                <input value={styleDraft.id} disabled={!styleDraft.isNew || viewing} placeholder="modern-drama" onChange={(event) => setStyleDraft({ ...styleDraft, id: event.target.value.toLowerCase() })} />
              </label>
              <label className="wide">
                <span>简介</span>
                <textarea rows={2} value={styleDraft.description} maxLength={500} disabled={viewing} onChange={(event) => setStyleDraft({ ...styleDraft, description: event.target.value })} />
              </label>
              <label className="wide">
                <span>写作指令</span>
                <textarea rows={12} value={styleDraft.systemPromptAddition} disabled={viewing} onChange={(event) => setStyleDraft({ ...styleDraft, systemPromptAddition: event.target.value })} />
              </label>
              <label className="wide">
                <span>正向范文</span>
                <textarea rows={8} value={styleDraft.exampleContent} disabled={viewing} onChange={(event) => setStyleDraft({ ...styleDraft, exampleContent: event.target.value })} />
              </label>
              <label className="wide">
                <span>范文备注</span>
                <textarea rows={3} value={styleDraft.exampleNotes} disabled={viewing} onChange={(event) => setStyleDraft({ ...styleDraft, exampleNotes: event.target.value })} />
              </label>
              <label>
                <span>Temperature（0–2）</span>
                <input type="number" min="0" max="2" step="0.05" value={styleDraft.suggestedTemperature} disabled={viewing} onChange={(event) => setStyleDraft({ ...styleDraft, suggestedTemperature: Number(event.target.value) })} />
              </label>
              <label>
                <span>Top P（0–1）</span>
                <input type="number" min="0.05" max="1" step="0.01" value={styleDraft.suggestedTopP} disabled={viewing} onChange={(event) => setStyleDraft({ ...styleDraft, suggestedTopP: Number(event.target.value) })} />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" disabled={styleBusy} onClick={() => { setStyleDraft(null); setShowStylePicker(true); }}>
                {viewing ? "返回" : "取消"}
              </button>
              {viewing ? (
                <button
                  type="button"
                  className="primary"
                  disabled={styleBusy}
                  onClick={() => {
                    setStyleDraft(null);
                    void applyWritingStyle(styleDraft.id, styleDraft.name);
                  }}
                >
                  激活此模板
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={styleBusy || !styleDraft.name.trim() || !styleDraft.description.trim() || !styleDraft.systemPromptAddition.trim()}
                  onClick={() => void saveStyleTemplate()}
                >{styleBusy ? "保存中…" : "保存模板"}</button>
              )}
            </div>
          </div>
        </div>
        );
      })()}

      {showConnectionPanel && connection.dualMode && (
        <div
          className="theme-picker-backdrop"
          onMouseDown={() => setShowConnectionPanel(false)}
          role="presentation"
        >
          <div
            className="theme-picker connection-panel"
            role="dialog"
            aria-modal="true"
            aria-label="连接通道"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="theme-picker-head">
              <div>
                <span className="eyebrow">Network</span>
                <h2>连接通道</h2>
                <p>
                  当前走 <strong>{connection.label}</strong>
                  {connection.preference !== "auto" ? `（已锁定，偏好：${connection.preference === "lan" ? "局域网" : "公网"}）` : "（自动）"}
                  。在家优先局域网，出门自动切公网；也可手动锁定或打开对应链接。
                </p>
              </div>
              <IconButton label="关闭" onClick={() => setShowConnectionPanel(false)}><X size={17} /></IconButton>
            </div>

            <div className="connection-status-row">
              <span className={`connection-status-dot route-${connection.route}`} aria-hidden="true" />
              <div className="connection-status-meta">
                <strong>{connection.label}</strong>
                <small title={connection.base}>{connection.base}</small>
              </div>
              <button
                type="button"
                className="ghost"
                disabled={connectionBusy}
                onClick={() => {
                  setConnectionBusy(true);
                  setConnectionPanelMsg("");
                  void ensureConnection()
                    .then((info) => {
                      setConnection(info);
                      setConnectionPanelMsg(`已重新探测：${info.label}`);
                    })
                    .catch((e) => setConnectionPanelMsg(String(e)))
                    .finally(() => setConnectionBusy(false));
                }}
              >
                重新探测
              </button>
            </div>

            <div className="connection-section">
              <h3>通道偏好</h3>
              <div className="connection-pref-grid">
                {(
                  [
                    { id: "auto" as const, name: "自动", desc: "局域网优先，不可达则公网" },
                    { id: "lan" as const, name: "局域网", desc: "尽量锁定，低延迟" },
                    { id: "public" as const, name: "公网", desc: "Cloudflare 隧道" },
                  ] satisfies Array<{ id: ConnectionPreference; name: string; desc: string }>
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`connection-pref-card${connection.preference === item.id ? " active" : ""}${connection.route === item.id ? " live" : ""}`}
                    disabled={connectionBusy}
                    onClick={() => {
                      setConnectionBusy(true);
                      setConnectionPanelMsg("");
                      void setConnectionPreference(item.id)
                        .then((result) => {
                          setConnection(getConnectionInfo());
                          if (result.needNavigate) {
                            setConnectionPanelMsg(result.error || "请用下方入口链接打开对应通道");
                            return;
                          }
                          if (result.error) {
                            setConnectionPanelMsg(result.error);
                            return;
                          }
                          setConnectionPanelMsg(
                            item.id === "auto"
                              ? `已设为自动 · 当前 ${result.label}`
                              : `已切换到${item.name}`,
                          );
                        })
                        .finally(() => setConnectionBusy(false));
                    }}
                  >
                    <strong>{item.name}</strong>
                    <small>{item.desc}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="connection-section">
              <h3>入口链接</h3>
              <p className="connection-hint">
                推荐在家 Wi‑Fi 用<strong>局域网</strong>入口（可自动切换）。仅公网页无法探测局域网 HTTP（浏览器混合内容限制）。
              </p>
              {connection.lanBlockedByMixedContent && (
                <p className="connection-warn">
                  当前是 HTTPS 公网页，无法在页内切到局域网 API。回家后请打开下方局域网链接（或重新扫终端二维码）。
                </p>
              )}
              {(
                [
                  { kind: "lan" as const, name: "局域网", base: connection.lanBase },
                  { kind: "public" as const, name: "公网", base: connection.publicBase },
                ]
              ).map((item) => {
                const entry = buildEntryUrl(item.kind);
                return (
                  <div key={item.kind} className="connection-link-row">
                    <div className="connection-link-meta">
                      <strong>{item.name}</strong>
                      <small title={item.base || undefined}>{item.base || "未配置"}</small>
                    </div>
                    <div className="connection-link-actions">
                      <button
                        type="button"
                        className="ghost"
                        disabled={!entry}
                        onClick={() => {
                          if (!entry) return;
                          void navigator.clipboard?.writeText(entry)
                            .then(() => setConnectionPanelMsg(`已复制${item.name}链接`))
                            .catch(() => setConnectionPanelMsg(entry));
                        }}
                      >
                        复制
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={!entry}
                        onClick={() => {
                          if (!entry) return;
                          window.open(entry, "_blank", "noopener,noreferrer");
                        }}
                      >
                        新标签
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={!entry}
                        onClick={() => {
                          if (!entry) return;
                          window.location.assign(entry);
                        }}
                      >
                        打开
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {connectionPanelMsg && (
              <p className="connection-panel-msg" role="status">{connectionPanelMsg}</p>
            )}
          </div>
        </div>
      )}

      {showUsagePopover && (
        <div
          className="theme-picker-backdrop"
          onMouseDown={() => setShowUsagePopover(false)}
          role="presentation"
        >
          <div
            className="theme-picker usage-popover"
            role="dialog"
            aria-modal="true"
            aria-label="用量与计费"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="theme-picker-head">
              <div>
                <span className="eyebrow">Usage</span>
                <h2>用量与计费</h2>
                <p>本会话累计的上下文占用、token 与费用。</p>
              </div>
              <IconButton label="关闭" onClick={() => setShowUsagePopover(false)}><X size={17} /></IconButton>
            </div>
            <div className="usage-detail">
              <div className="usage-detail-row">
                <span className="usage-detail-label">模型</span>
                <span className="usage-detail-value">{state.provider.model}</span>
              </div>
              <div className="usage-detail-row">
                <span className="usage-detail-label">上下文占用</span>
                <span className="usage-detail-value">
                  {usagePct}% · {state.usage.lastPromptTokens.toLocaleString()} / {state.provider.pricing.contextWindow.toLocaleString()}
                </span>
              </div>
              <div className="usage-detail-row">
                <span className="usage-detail-label">累计 tokens</span>
                <span className="usage-detail-value">{state.usage.totalTokens.toLocaleString()}</span>
              </div>
              <div className="usage-detail-row" title="仅统计供应商真实返回的缓存 hit/miss；不含估算调用">
                <span className="usage-detail-label">缓存命中率</span>
                <span className="usage-detail-value">{(realCacheHitRate(state.usage) * 100).toFixed(1)}%</span>
              </div>
              <div className="usage-detail-row">
                <span className="usage-detail-label">累计费用</span>
                <span className="usage-detail-value usage-number">
                  {state.provider.pricing.billingMode === "unmetered"
                    ? "非按量计费"
                    : `${state.usage.currency === "CNY" ? "¥" : "$"}${state.usage.cost.toFixed(4)}`}
                </span>
              </div>
            </div>
            <div className="usage-popover-actions">
              <button className="primary" onClick={() => { setShowUsagePopover(false); openProviderSettings(); }}>
                打开模型设置
              </button>
            </div>
          </div>
        </div>
      )}

      {showThemePicker && (
        <div
          className="theme-picker-backdrop"
          onMouseDown={() => setShowThemePicker(false)}
          role="presentation"
        >
          <div
            className="theme-picker"
            role="dialog"
            aria-modal="true"
            aria-label="界面风格"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="theme-picker-head">
              <div>
                <span className="eyebrow">Appearance</span>
                <h2>界面主题</h2>
              </div>
              <IconButton label="关闭" onClick={() => setShowThemePicker(false)}><X size={17} /></IconButton>
            </div>
            <div className="theme-grid">
              {UI_THEMES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`theme-card${theme === item.id ? " active" : ""}`}
                  onClick={() => {
                    setTheme(item.id);
                    setShowThemePicker(false);
                  }}
                >
                  <div
                    className="theme-preview"
                    style={{
                      ["--tp-bg"]: item.preview.bg,
                      ["--tp-surface"]: item.preview.surface,
                      ["--tp-surface2"]: item.preview.surface2,
                      ["--tp-border"]: item.preview.border,
                      ["--tp-accent"]: item.preview.accent,
                      ["--tp-text"]: item.preview.text,
                    } as React.CSSProperties}
                    aria-hidden="true"
                  >
                    <div className="theme-preview-chrome">
                      <i /><i /><i />
                    </div>
                    <div className="theme-preview-body">
                      <div className="theme-preview-side" />
                      <div className="theme-preview-main">
                        <span /><span /><span />
                      </div>
                      <div className="theme-preview-agent" />
                    </div>
                  </div>
                  <div className="theme-card-meta">
                    <strong>
                      {item.name}
                      <span className="theme-tag">{item.tag}</span>
                    </strong>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {managementView && managementView !== "models" && (
        <div className="management-backdrop" onMouseDown={() => setManagementView(null)}>
          <section className="management-view" onMouseDown={(e) => e.stopPropagation()}>
            <div className="management-head">
              <div>
                <span className="eyebrow">Workspace</span>
                <h2>{managementView === "characters" ? "角色卡" : "会话"}</h2>
              </div>
              <div className="management-actions">
                {managementView === "characters" ? (
                  <>
                    <button className="ghost" onClick={() => setSimpleCardDraft({ name: "", identity: "", relationship: "", knowledge: "", scene: "", goal: "" })}><Plus size={15} />简易角色</button>
                    <button className="primary" onClick={() => setCharacterDraft({ ...EMPTY_CHARACTER })}><Plus size={15} />普通角色</button>
                  </>
                ) : (
                  <>
                    <button
                      className={sessionBatchMode ? "primary" : "ghost"}
                      onClick={() => {
                        setSessionBatchMode((value) => !value);
                        setSelectedSessionIds(new Set());
                      }}
                    >
                      {sessionBatchMode ? "完成" : "批量"}
                    </button>
                    {!sessionBatchMode && (
                      <button className="primary" onClick={async () => {
                        clearAgentStream({ abort: true });
                        const result = await api<{ sessionId: string }>("/api/session", { method: "POST" });
                        await refresh(result.sessionId);
                        setManagementView(null);
                        setSessionBatchMode(false);
                        setSelectedSessionIds(new Set());
                      }} title="新建会话并清除当前 step 渲染"><Plus size={15} />新建会话</button>
                    )}
                  </>
                )}
                <button
                  className="icon"
                  aria-label="Close"
                  onClick={() => {
                    setManagementView(null);
                    setSessionBatchMode(false);
                    setSelectedSessionIds(new Set());
                  }}
                ><X size={17} /></button>
              </div>
            </div>

            {managementView === "characters" ? (
              <div className="character-grid">
                {state.characters.length > 0 && (
                  <div className="character-section-heading">
                    <div><strong>普通角色卡</strong><span>完整设定，供写作 Agent 与角色扮演使用</span></div>
                    <small>{state.characters.length} 张</small>
                  </div>
                )}
                {state.characters.map((character) => (
                  <div className={`character-card-wrap${agentHiddenCharacterCards.has(`normal:${character.id}`) ? " agent-hidden" : ""}`} key={character.id}>
                    <button className="character-card" onClick={() => setCharacterDraft({ ...character, experiences: character.experiences ?? [] })}>
                      <span className="character-avatar">{character.identity.name.slice(0, 1)}</span>
                      <span className="character-card-body">
                        <strong title={character.identity.name}>{character.identity.name}</strong>
                        <small title={character.identity.narrativeRole || undefined}>
                          {character.identity.narrativeRole.trim() || "未设定位"}
                        </small>
                        <span title={character.psychology.summary || character.profile.backgroundSummary || character.identity.summary || undefined}>
                          {character.psychology.summary
                            || character.profile.backgroundSummary
                            || character.identity.summary
                            || "暂无简介"}
                        </span>
                      </span>
                    </button>
                    <button
                      className="character-agent-visibility"
                      type="button"
                      aria-pressed={!agentHiddenCharacterCards.has(`normal:${character.id}`)}
                      title={agentHiddenCharacterCards.has(`normal:${character.id}`) ? "允许 Agent 读取这张角色卡" : "对 Agent 隐藏这张角色卡"}
                      onClick={() => toggleAgentCharacterVisibility(`normal:${character.id}`)}
                    >
                      <span aria-hidden="true">{agentHiddenCharacterCards.has(`normal:${character.id}`) ? "○" : "●"}</span>
                      {agentHiddenCharacterCards.has(`normal:${character.id}`) ? "Agent 隐藏" : "Agent 可见"}
                    </button>
                  </div>
                ))}
                {state.roleplayInterlocutors.length > 0 && (
                  <div className="character-section-heading simple">
                    <div><strong>简易角色卡</strong><span>独立的轻量扮演身份，不会覆盖普通角色卡</span></div>
                    <small>{state.roleplayInterlocutors.length} 张</small>
                  </div>
                )}
                {state.roleplayInterlocutors.map((card) => (
                  <div className={`character-card-wrap simple${agentHiddenCharacterCards.has(`simple:${card.id}`) ? " agent-hidden" : ""}`} key={`simple-${card.id}`}>
                    <button className="character-card" onClick={() => setSimpleCardDraft({ ...card })}>
                      <span className="character-avatar">{card.name.slice(0, 1)}</span>
                      <span className="character-card-body">
                        <strong title={card.name}>{card.name}</strong>
                        <small>{state.characters.some(character => character.identity.name.trim() === card.name.trim()) ? "简易角色卡 · 与普通卡同名" : "简易角色卡"}</small>
                        <span title={card.identity || undefined}>{card.identity || "暂无身份简介"}</span>
                      </span>
                    </button>
                    <button
                      className="character-agent-visibility"
                      type="button"
                      aria-pressed={!agentHiddenCharacterCards.has(`simple:${card.id}`)}
                      title={agentHiddenCharacterCards.has(`simple:${card.id}`) ? "允许 Agent 读取这张简易角色卡" : "对 Agent 隐藏这张简易角色卡"}
                      onClick={() => toggleAgentCharacterVisibility(`simple:${card.id}`)}
                    >
                      <span aria-hidden="true">{agentHiddenCharacterCards.has(`simple:${card.id}`) ? "○" : "●"}</span>
                      {agentHiddenCharacterCards.has(`simple:${card.id}`) ? "Agent 隐藏" : "Agent 可见"}
                    </button>
                  </div>
                ))}
                {state.characters.length === 0 && state.roleplayInterlocutors.length === 0 && <div className="management-empty">还没有角色卡，点右上角新建。</div>}
              </div>
            ) : (
              <div className="session-manager">
                {sessionBatchMode && (
                  <div className="session-batch-bar">
                    <label className="session-batch-select-all">
                      <input
                        type="checkbox"
                        checked={state.sessions.length > 0 && selectedSessionIds.size === state.sessions.length}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedSessionIds(new Set(state.sessions.map((s) => s.id)));
                          else setSelectedSessionIds(new Set());
                        }}
                      />
                      <span>全选</span>
                    </label>
                    <span className="session-batch-count">已选 {selectedSessionIds.size}</span>
                    <button
                      className="danger primary"
                      disabled={selectedSessionIds.size === 0 || selectedSessionIds.size >= state.sessions.length}
                      title={selectedSessionIds.size >= state.sessions.length ? "至少保留一个会话" : "删除选中会话"}
                      onClick={() => void batchDeleteSessions([...selectedSessionIds])}
                    >
                      删除选中
                    </button>
                  </div>
                )}
                <div className="session-list">
                  {state.sessions.map((session) => (
                    <div
                      className={`session-card ${session.id === state.sessionId ? "active" : ""} ${selectedSessionIds.has(session.id) ? "selected" : ""}`}
                      key={session.id}
                    >
                      {sessionBatchMode && (
                        <label className="session-check" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedSessionIds.has(session.id)}
                            onChange={() => toggleSessionSelected(session.id)}
                          />
                        </label>
                      )}
                      <button
                        className="session-main"
                        onClick={() => {
                          if (sessionBatchMode) {
                            toggleSessionSelected(session.id);
                            return;
                          }
                          if (session.id !== state.sessionId) clearAgentStream({ abort: true });
                          void refresh(session.id);
                          setManagementView(null);
                          setMobileTab("agent");
                        }}
                      >
                        <strong>
                          {session.title}
                          {session.autoTitleDone ? <span className="session-auto-tag" title="标题已自动总结">AI</span> : null}
                        </strong>
                        <span>{new Date(session.updatedAt).toLocaleString()}</span>
                      </button>
                      {session.id === state.sessionId && <span className="current-badge">Current</span>}
                      {!sessionBatchMode && (
                        <>
                          <button className="icon" aria-label="重命名会话" title="重命名" onClick={() => void renameSession(session.id, session.title)}><Pencil size={15} /></button>
                          <button className="icon danger" aria-label="删除会话" title="删除" onClick={() => void deleteSession(session.id)}><Trash2 size={15} /></button>
                        </>
                      )}
                    </div>
                  ))}
                  {state.sessions.length === 0 && <div className="management-empty">暂无会话</div>}
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {characterDraft && (
        <CharacterEditor
          draft={characterDraft}
          characters={state?.characters ?? []}
          busy={busy}
          onChange={setCharacterDraft}
          onClose={() => setCharacterDraft(null)}
          onSave={() => void saveCharacter()}
          onSummarizeCompetency={summarizeCompetency}
          onDelete={characterDraft.id ? () => void deleteCharacter(characterDraft as Character) : undefined}
        />
      )}

      {managementView === "models" && <ModelConfig
        initialCatalog={state.providerCatalog}
        scenePipeline={state.agentSettings?.scenePipeline ?? { preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5, notesMaxCharacters: 3000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1 }}
        request={api}
        onClose={() => setManagementView(null)}
        onChanged={() => { void refresh(state.sessionId); }}
        onScenePipelineChanged={scenePipeline => setState(previous => previous ? {
          ...previous,
          agentSettings: {
            permissionMode: previous.agentSettings?.permissionMode ?? "ask",
            scenePipeline,
          },
        } : previous)}
      />}
    </WorkspaceShell>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
