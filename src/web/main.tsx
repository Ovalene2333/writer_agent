import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Marked, type Token, type Tokens } from "marked";
import { documentDiff, renderDiffHtml } from "../diff";
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
};
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
  usage?: Usage;
  call?: StepUsage;
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
  sessions: Array<{ id: string; title: string; updatedAt: string; autoTitleDone?: boolean }>;
  characters: Character[];
  roleplayInterlocutors: SavedRoleplayInterlocutor[];
  activeRoleplay: ActiveRoleplayState | null;
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
/** Agent orb easter-egg lines (shown after multi-tap overdrive). */
const ORB_EGG_LINES = [
  "写作核心已过载 · 灵感滤镜开启",
  "能量球低语：删掉形容词，留下心跳",
  "今日配额：无限草稿，有限自我怀疑",
  "检测到人类作者 · 建议继续摸鱼写作",
  "过载模式：把「突然」全部换成具体动作",
  "球说：大纲是地图，正文是迷路的勇气",
];

/** Visual UI themes (workspace chrome). Not writing style templates. */
type UiThemeId = "parchment" | "midnight" | "ink" | "aurora" | "sakura" | "carbon";

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
    id: "parchment",
    name: "羊皮纸",
    tag: "默认浅色",
    description: "暖纸张底 + 墨绿强调，现有工作台的经典配色。",
    example: "长篇正文阅读、白天连载写作",
    preview: { bg: "#f3f0e9", surface: "#fffdfa", surface2: "#f8f5ef", border: "#e0d9cc", accent: "#3d5a45", text: "#2c332b" },
    dark: false,
  },
  {
    id: "midnight",
    name: "午夜林",
    tag: "默认深色",
    description: "深绿夜色 + 薄荷强调，现有暗色模式的演进版。",
    example: "夜间写作、降亮度长时间改稿",
    preview: { bg: "#151c17", surface: "#1b231d", surface2: "#1d2820", border: "#2e3a30", accent: "#8bb89a", text: "#d5dfd8" },
    dark: true,
  },
  {
    id: "ink",
    name: "墨砚",
    tag: "纸墨",
    description: "近黑正文与朱砂点缀，偏传统出版与中文排版气质。",
    example: "严肃文学、设定文档校对",
    preview: { bg: "#f2efe8", surface: "#fbfaf6", surface2: "#f4f1ea", border: "#d4cfc3", accent: "#b33a2b", text: "#1a1a1a" },
    dark: false,
  },
  {
    id: "aurora",
    name: "极光",
    tag: "现代",
    description: "冷调蓝紫工具感，侧栏与对话更像产品工作台。",
    example: "规划大纲、工具调用密集的 Agent 会话",
    preview: { bg: "#eef2f8", surface: "#fbfcfe", surface2: "#f3f6fb", border: "#d3dbe8", accent: "#4f6ef7", text: "#1c2433" },
    dark: false,
  },
  {
    id: "sakura",
    name: "樱色",
    tag: "柔和",
    description: "浅粉纸感与玫红强调，阅读区更轻、更“轻小说”。",
    example: "日常/恋爱线正文精读",
    preview: { bg: "#faf4f5", surface: "#fffafb", surface2: "#fbf5f6", border: "#ead5da", accent: "#c45c7a", text: "#3a2a2e" },
    dark: false,
  },
  {
    id: "carbon",
    name: "碳黑",
    tag: "编辑器",
    description: "高对比深灰 + 电青强调，接近代码编辑器的夜间界面。",
    example: "深夜改设定、对照检索与补丁提案",
    preview: { bg: "#0e0f12", surface: "#16181d", surface2: "#12141a", border: "#2a2e38", accent: "#64d2ff", text: "#e8eaef" },
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
  if (stored === "light") return "parchment";
  if (stored === "dark") return "midnight";
  if (stored && UI_THEME_IDS.has(stored)) return stored as UiThemeId;
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "midnight";
  return "parchment";
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

function FileTreeItem({
  node,
  depth,
  activePath,
  ancestorHidden = false,
  onSelect,
  onRename,
  onDelete,
  onToggleHidden,
  onDropFile,
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
  onDropFile: (filePath: string, targetFolder: string) => void;
  onNewChild: (parentFolder: string, kind: "file" | "folder") => void;
  expandedFolders: Set<string>;
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const isExpanded = node.kind === "folder" && expandedFolders.has(node.path);
  const isEffectivelyHidden = ancestorHidden || node.hidden;
  const [dragOver, setDragOver] = useState(false);

  const handleDragStart = (e: React.DragEvent) => {
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
    const filePath = e.dataTransfer.getData("text/plain");
    if (filePath && node.kind === "folder" && filePath !== node.path) {
      onDropFile(filePath, node.path);
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
        draggable={node.kind === "file"}
        onDragStart={node.kind === "file" ? handleDragStart : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        aria-expanded={node.kind === "folder" ? isExpanded : undefined}
      >
        {node.kind === "folder" ? (
          <span className={`tree-arrow ${isExpanded ? "expanded" : ""}`} onClick={toggleFolder} aria-hidden="true">
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </span>
        ) : (
          <span className="tree-arrow-spacer" />
        )}
        <span className={`tree-icon ${node.kind === "folder" ? (isExpanded ? "folder-open" : "folder") : "file"}`} aria-hidden="true">
          {node.kind === "folder" ? (
            isExpanded ? (
              <svg viewBox="0 0 20 20" width="15" height="15"><path d="M2.5 6.5h5l1.2 1.3H17.5v7.2a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V6.5z" fill="currentColor" opacity=".92"/><path d="M2.5 8.2h15l-1.1 6.4A1.4 1.4 0 0 1 15 16H5a1.4 1.4 0 0 1-1.4-1.2L2.5 8.2z" fill="currentColor" opacity=".55"/></svg>
            ) : (
              <svg viewBox="0 0 20 20" width="15" height="15"><path d="M2.5 5.2A1.7 1.7 0 0 1 4.2 3.5h3.1l1.4 1.5h7.1A1.7 1.7 0 0 1 17.5 6.7v7.6a1.7 1.7 0 0 1-1.7 1.7H4.2a1.7 1.7 0 0 1-1.7-1.7V5.2z" fill="currentColor"/></svg>
            )
          ) : (
            <svg viewBox="0 0 20 20" width="14" height="14"><path d="M5.2 2.8h6.1L14.8 6.3v10.4a1.2 1.2 0 0 1-1.2 1.2H5.2a1.2 1.2 0 0 1-1.2-1.2V4a1.2 1.2 0 0 1 1.2-1.2z" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M11.2 2.9v3.2h3.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M6.6 10.2h6.2M6.6 12.8h4.6" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" opacity=".7"/></svg>
          )}
        </span>
        <span className="tree-label" title={node.path}>
          <span className="tree-name">{node.name}</span>
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
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/><path d="M3 13L13 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            ) : (
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>
            )}
          </button>
          {node.kind === "folder" && (
            <button
              className="tree-action-btn"
              title="在此新建文档"
              onClick={(e) => {
                e.stopPropagation();
                onNewChild(node.path, "file");
              }}
            >
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
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
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9.2 3.4l3.4 3.4M3 13l1.1-3.9L11.4 1.8a1.1 1.1 0 0 1 1.6 0l1.2 1.2a1.1 1.1 0 0 1 0 1.6L6.9 11.9 3 13z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round"/></svg>
          </button>
          <button
            className="tree-action-btn danger"
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.path, node.kind);
            }}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 4.5h9M6 4.5V3.4h4v1.1M5.2 4.5l.5 8.1h4.6l.5-8.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
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
            onDropFile={onDropFile}
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
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** Agent orb easter egg: tap feedback + rare overdrive mode. */
  const [orbTap, setOrbTap] = useState(false);
  const [orbEgg, setOrbEgg] = useState(false);
  const [orbEggLine, setOrbEggLine] = useState(0);
  const orbClickRef = useRef({ count: 0, lastAt: 0 });
  const orbTapTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const orbEggTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [mobileTab, setMobileTab] = useState<"docs" | "editor" | "agent">("editor");
  const [theme, setTheme] = useState<UiThemeId>(() => loadUiTheme());
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showStylePicker, setShowStylePicker] = useState(false);
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleDraft, setStyleDraft] = useState<StyleTemplateDraft | null>(null);
  const [managementView, setManagementView] = useState<"characters" | "sessions" | null>(null);
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
  const [showSettings, setShowSettings] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
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
  const [roleplaySetup, setRoleplaySetup] = useState<{ performer: RoleplayParticipant | null; identity: RoleplayParticipant | null; request: string; persist: boolean } | null>(null);
  const [simpleCardDraft, setSimpleCardDraft] = useState<(RoleplayInterlocutor & { id?: number }) | null>(null);
  const [roleplaySetupBusy, setRoleplaySetupBusy] = useState(false);
  const [roleplaySetupPhase, setRoleplaySetupPhase] = useState<RoleplaySetupPhase | null>(null);
  const [roleplaySetupElapsed, setRoleplaySetupElapsed] = useState(0);
  const [todosCollapsed, setTodosCollapsed] = useState(false);
  /** Collapsed final Assistant bubbles (steps already have their own expand state). */
  const [collapsedAssistantIds, setCollapsedAssistantIds] = useState<Set<number>>(() => new Set());
  const [resizing, setResizing] = useState<"sidebar" | "agent" | null>(null);
  const [connection, setConnection] = useState<ConnectionInfo>(() => getConnectionInfo());
  const [showConnectionPanel, setShowConnectionPanel] = useState(false);
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
  const documentReaderRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
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
    localStorage.setItem("writer-theme", theme === "midnight" || theme === "carbon" ? "dark" : "light");
    const meta = window.document.querySelector('meta[name="theme-color"]');
    const active = UI_THEMES.find((item) => item.id === theme);
    if (meta && active) meta.setAttribute("content", active.preview.accent);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("writer-outline-collapsed", String(outlineCollapsed));
  }, [outlineCollapsed]);

  useEffect(() => {
    if (!showThemePicker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowThemePicker(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showThemePicker]);

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
          return current.map((s, i) => (i === idx ? { ...s, usage: event.call } : s));
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
    if (event.type === "todos" && event.todos) {
      setState((prev) => (prev ? { ...prev, todos: event.todos } : prev));
    }
    if (event.type === "mode" && event.mode) {
      setState((prev) =>
        prev
          ? { ...prev, agentSettings: { ...(prev.agentSettings ?? { permissionMode: "ask", scenePipeline: { preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5 } }), permissionMode: event.mode! } }
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
          ? { ...prev, agentSettings: { ...(prev.agentSettings ?? { permissionMode: "ask", scenePipeline: { preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5 } }), permissionMode: result.permissionMode } }
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
          // Client safety net: if server still has open todos after a successful job, show them closed.
          // Persist path is server-side; this only heals stale UI if an older process missed finalize.
          const openTodos = (next.todos ?? []).filter(
            (item) => item.status === "pending" || item.status === "in_progress",
          );
          if (openTodos.length > 0) {
            setState((prev) => {
              if (!prev?.todos?.length) return prev;
              return {
                ...prev,
                todos: prev.todos.map((item) =>
                  item.status === "pending" || item.status === "in_progress"
                    ? { ...item, status: "completed" as const }
                    : item,
                ),
              };
            });
          }
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
            ? { mode: "roleplay", performer: activeRoleplay.performer, identity: activeRoleplay.identity }
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

  function pokeAgentOrb() {
    const now = Date.now();
    // Reset combo if the user pauses too long between taps.
    if (now - orbClickRef.current.lastAt > 1600) orbClickRef.current.count = 0;
    orbClickRef.current.lastAt = now;
    orbClickRef.current.count += 1;

    setOrbTap(true);
    if (orbTapTimerRef.current) clearTimeout(orbTapTimerRef.current);
    orbTapTimerRef.current = setTimeout(() => setOrbTap(false), 420);

    if (orbEgg) {
      // Already awake: cycle witty lines on each poke.
      setOrbEggLine((n) => (n + 1) % ORB_EGG_LINES.length);
      return;
    }

    if (orbClickRef.current.count >= 7) {
      orbClickRef.current.count = 0;
      setOrbEgg(true);
      setOrbEggLine(Math.floor(Math.random() * ORB_EGG_LINES.length));
      setNotice("✦ 能量球过载：写作核心已解锁隐藏滤镜");
      if (orbEggTimerRef.current) clearTimeout(orbEggTimerRef.current);
      // Fade back to normal after a while so it stays an easter egg.
      orbEggTimerRef.current = setTimeout(() => {
        setOrbEgg(false);
        setNotice("");
      }, 28_000);
    }
  }

  useEffect(() => () => {
    if (orbTapTimerRef.current) clearTimeout(orbTapTimerRef.current);
    if (orbEggTimerRef.current) clearTimeout(orbEggTimerRef.current);
  }, []);

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
      if (activePath === oldPath) setActivePath(newPath);
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
      if (activePath === path) setActivePath("");
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

  async function handleDropFile(filePath: string, targetFolder: string) {
    const parts = filePath.split("/");
    const name = parts.pop()!;
    const newPath = `${targetFolder}/${name}`;
    if (newPath === filePath) return;
    try {
      await api("/api/document/rename", {
        method: "PUT",
        body: JSON.stringify({ fromPath: filePath, toPath: newPath }),
      });
      if (activePath === filePath) setActivePath(newPath);
      await refresh(state?.sessionId);
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
    await api("/api/characters", { method: "POST", body: JSON.stringify(characterDraft) });
    setCharacterDraft(null);
    await refresh(state?.sessionId);
  }

  async function summarizeCompetency(competency: Competency): Promise<string> {
    const result = await api<{ summary: string }>("/api/characters/competencies/summarize", {
      method: "POST",
      body: JSON.stringify({ competency }),
    });
    return result.summary;
  }

  function normalParticipant(character: Character): RoleplayParticipant {
    return {
      kind: "normal", id: character.id, name: character.identity.name,
      card: {
        name: character.identity.name,
        identity: character.identity.summary || character.identity.narrativeRole,
        relationship: "", knowledge: "", scene: "",
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
    setRoleplaySetup({ performer, identity: null, request: "", persist: true });
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
          body: JSON.stringify({ performer: roleplaySetup.performer, request: roleplaySetup.request }),
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
    setShowSettings(true);
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

  if (!state) {
    return (
      <main className="app-shell">
        <p>{error || "Loading..."}</p>
      </main>
    );
  }

  const pendingProposals = state.proposals.filter((p) => p.status === "pending");
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
    <div className="app">
      <div
        className={`resize-handle${resizing === "sidebar" ? " active" : ""}`}
        style={{ left: `calc(var(--sidebar-w, 248px) - 2.5px)` }}
        onMouseDown={() => setResizing("sidebar")}
      />
      <div
        className={`resize-handle${resizing === "agent" ? " active" : ""}`}
        style={{ right: `calc(var(--agent-w, 380px) - 2.5px)` }}
        onMouseDown={() => setResizing("agent")}
      />
      <header>
        <div className="header-left">
          <span className="logo"><span className="logo-mark">W</span><span>Writer</span></span>
          <div className="title-stack">
            <span className="product-line">AI Writing Agent</span>
            <h1>{state.config.title || "Writer Agent"}</h1>
          </div>
          {connection.dualMode && (
            <button
              type="button"
              className={`connection-pill route-${connection.route}${connection.lanBlockedByMixedContent ? " mixed-block" : ""}`}
              title="连接通道：点击查看说明与切换"
              aria-label={`当前${connection.label}，打开连接设置`}
              onClick={() => {
                setConnectionPanelMsg("");
                setShowConnectionPanel(true);
              }}
            >
              <i aria-hidden="true" />
              <span className="connection-pill-label">{connection.label}</span>
            </button>
          )}
        </div>
        <div className="header-right">
          <button className="usage-strip" onClick={openProviderSettings} title="打开设置">
            <span className="model-name">{state.provider.model}</span>
            <span className="context-meter" title={`${usagePct}% context`} aria-hidden="true">
              <i style={{ width: `${Math.min(100, Math.max(2, usagePct))}%` }} />
            </span>
            <span title="Context window used">{usagePct}%</span>
            <span>{state.usage.totalTokens.toLocaleString()} tokens</span>
            <span title="仅统计供应商真实返回的缓存 hit/miss；不含估算调用">
              cache {(realCacheHitRate(state.usage) * 100).toFixed(1)}%
            </span>
            <span className="usage-number">
              {state.usage.currency === "CNY" ? "¥" : "$"}{state.usage.cost.toFixed(4)}
            </span>
            <span className="settings-glyph" aria-hidden="true">⚙</span>
          </button>
          <button
            className="ghost nav-action"
            title="角色卡"
            onClick={() => {
              setSessionBatchMode(false);
              setSelectedSessionIds(new Set());
              setManagementView("characters");
            }}
          >角色</button>
          <button
            className="ghost nav-action"
            title="选择扮演者与当前身份"
            disabled={busy}
            onClick={() => beginRoleplaySetup()}
          >扮演</button>
          <button
            className="ghost nav-action"
            title="会话"
            onClick={() => {
              setSessionBatchMode(false);
              setSelectedSessionIds(new Set());
              setManagementView("sessions");
            }}
          >会话</button>
          <button
            className={`ghost nav-action${activeStyle ? " style-active" : ""}`}
            title={activeStyle ? `写作风格：${activeStyle.name}` : "写作风格模板"}
            aria-label="选择写作风格模板"
            onClick={() => setShowStylePicker(true)}
          >风格</button>
          <button
            className="icon"
            title="界面风格"
            aria-label="选择界面风格"
            onClick={() => setShowThemePicker(true)}
          >
            ◐
          </button>
          <button
            className="ghost"
            title="New session"
            onClick={async () => {
              // New session: stop rendering previous trail (storage for old session kept for later switch-back).
              clearAgentStream({ abort: true });
              const r = await api<{ sessionId: string }>("/api/session", { method: "POST" });
              await refresh(r.sessionId);
            }}
          >
            + New
          </button>
          <button className="ghost" onClick={() => void refresh(state.sessionId)} title="Refresh">
            Refresh
          </button>
        </div>
      </header>

      <nav className="mobile-tabs" aria-label="主区域">
        <button
          type="button"
          className={mobileTab === "docs" ? "active" : ""}
          onClick={() => {
            setManagementView(null);
            setMobileTab("docs");
          }}
        >
          <span className="tab-icon" aria-hidden="true">☷</span><span>文档</span>
        </button>
        <button
          type="button"
          className={mobileTab === "editor" ? "active" : ""}
          onClick={() => {
            setManagementView(null);
            setMobileTab("editor");
          }}
        >
          <span className="tab-icon" aria-hidden="true">✎</span><span>正文</span>
        </button>
        <button
          type="button"
          className={mobileTab === "agent" ? "active" : ""}
          onClick={() => {
            setManagementView(null);
            setMobileTab("agent");
          }}
        >
          <span className="tab-icon" aria-hidden="true">✦</span><span>Agent</span>
        </button>
      </nav>

      <aside className={`documents ${mobileTab === "docs" ? "mobile-active" : ""}`}>
        <div className="file-manager-head">
          <div>
            <span className="file-manager-kicker">Workspace</span>
            <h2>项目文件</h2>
          </div>
          <span className="file-manager-count">{state.documents.length} 篇</span>
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
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.2 2.5h5.2L12.5 5.6v7.4a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.35"/><path d="M9.3 2.6v3h3" fill="none" stroke="currentColor" strokeWidth="1.35"/><path d="M5.5 9.2h5M8 6.7v5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
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
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.2 4.2A1.2 1.2 0 0 1 3.4 3h2.4l1.1 1.2h5.7A1.2 1.2 0 0 1 13.8 5.4v6a1.2 1.2 0 0 1-1.2 1.2H3.4A1.2 1.2 0 0 1 2.2 11.4V4.2z" fill="none" stroke="currentColor" strokeWidth="1.35"/><path d="M8 7v4.2M5.9 9.1H10.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
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
                <svg viewBox="0 0 40 40" width="36" height="36"><path d="M8 11h9l3 3h12v15a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3V11z" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M16 22h8M20 18v8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".7"/></svg>
              </div>
              <strong>还没有文档</strong>
              <span>点击上方按钮创建文档或文件夹</span>
            </div>
          ) : (
            <div className="document-tree">
              {tree.map((node) => (
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
                  onDropFile={handleDropFile}
                  onNewChild={handleNewChild}
                  expandedFolders={expandedFolders}
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
                  <button onClick={() => setReaderFontSize((v) => Math.max(12, v - 1))} title="Decrease font size">-</button>
                  <span className="ctrl-val">{readerFontSize}</span>
                  <button onClick={() => setReaderFontSize((v) => Math.min(24, v + 1))} title="Increase font size">+</button>
                </div>
                <div className="ctrl-group">
                  <span className="ctrl-label">W</span>
                  <button onClick={() => setReaderWidth((v) => Math.max(420, v - 60))} title="Narrower margins">-</button>
                  <span className="ctrl-val">{readerWidth}</span>
                  <button onClick={() => setReaderWidth((v) => Math.min(1200, v + 60))} title="Wider margins">+</button>
                </div>
              </div>
            )}
            <div className="editor-bar-actions">
              {browsingVersion ? (
                <button className="primary" onClick={exitVersionBrowse} title="回到磁盘上的当前版本">
                  返回当前
                </button>
              ) : editingDocument ? (
                <>
                  <button onClick={cancelEdit}>Cancel</button>
                  <button className="primary" onClick={() => void saveDocument()}>
                    Save
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
                    版本
                  </button>
                  <button disabled={!activePath} onClick={() => setEditingDocument(true)}>
                    Edit
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
                <div className={`document-reader-layout ${outlineCollapsed ? "outline-collapsed" : ""}`}>
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
                          {outlineCollapsed ? "☰" : "‹"}
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

      <section className={`agent-panel ${mobileTab === "agent" ? "mobile-active" : ""} ${busy ? "agent-busy" : ""} ${orbEgg ? "orb-egg" : ""}`}>
        <div className="agent-head">
          <div className="agent-head-brand">
            <button
              type="button"
              className={`agent-orb${orbTap ? " orb-tap" : ""}${orbEgg ? " orb-egg-active" : ""}`}
              aria-label={orbEgg ? "写作能量球（过载中）" : "写作能量球"}
              title={orbEgg ? "再点一下听它多说两句" : "连点试试？"}
              onClick={pokeAgentOrb}
            >
              <span className="agent-orb-core" aria-hidden="true" />
              <span className="agent-orb-spark agent-orb-spark-a" aria-hidden="true" />
              <span className="agent-orb-spark agent-orb-spark-b" aria-hidden="true" />
              <span className="agent-orb-spark agent-orb-spark-c" aria-hidden="true" />
            </button>
            <h2>
              Agent
              <small>
                {orbEgg
                  ? ORB_EGG_LINES[orbEggLine]
                  : busy
                    ? "Thinking & writing…"
                    : "Ready for your task"}
              </small>
            </h2>
          </div>
          <div className="agent-head-actions">
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
              <strong>角色扮演试演</strong>
              <details className="roleplay-session-details">
                <summary>「{roleplay.performer.name}」×「{roleplay.identity.name}」</summary>
                <div className="roleplay-session-body">
                  <span>扮演者：{roleplay.performer.name}（{roleplay.performer.kind === "normal" ? "普通卡" : "简易卡"}）</span>
                  <dl>
                    <div><dt>身份</dt><dd>{roleplay.identity.card.identity}</dd></div>
                    <div><dt>关系</dt><dd>{roleplay.identity.card.relationship}</dd></div>
                    <div><dt>已知</dt><dd>{roleplay.identity.card.knowledge}</dd></div>
                    <div><dt>场景</dt><dd>{roleplay.identity.card.scene}</dd></div>
                    <div><dt>目标</dt><dd>{roleplay.identity.card.goal}</dd></div>
                  </dl>
                </div>
              </details>
            </div>
            <div className="roleplay-banner-actions">
              {roleplay.identity.kind === "generated" && (
                <button type="button" disabled={busy} onClick={() => void saveCurrentRoleplayInterlocutor()}>保存身份</button>
              )}
              <button type="button" disabled={busy} onClick={() => beginRoleplaySetup()}>重新设定</button>
              <button type="button" disabled={busy} onClick={() => void exitRoleplay()}>退出扮演</button>
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
        <div
          className="conversation"
          ref={conversationRef}
          onScroll={(event) => {
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
        <div className="composer">
          <div className="composer-shell">
            <textarea
              ref={composerRef}
              value={prompt}
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
                ? `以「${roleplay.identity.name}」身份对「${roleplay.performer.name}」说话…（Ctrl+Enter 发送）`
                : "Describe your writing task… (Ctrl+Enter to send)"}
              disabled={busy}
            />
            <div className="composer-actions">
              <span className="composer-hint">{busy ? "Esc to stop" : roleplay ? "RP · Ctrl+Enter" : "Ctrl+Enter"}</span>
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
        {pendingProposals.length > 0 && (
          <div className="mobile-proposals">
            <h2>
              Proposals
              <span style={{ fontWeight: 400, marginLeft: 8 }}>({pendingProposals.length})</span>
            </h2>
            {pendingProposals.map((p) => (
              <div className="proposal-card" key={p.id}>
                <h3>{p.path}</h3>
                <p>{p.summary}</p>
                <div className="proposal-actions">
                  <button onClick={() => void decide(p, "reject")}>Reject</button>
                  <button className="primary" onClick={() => void decide(p, "accept")}>
                    Accept
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="proposals">
        <h2>
          Proposals
          {pendingProposals.length > 0 && (
            <span className="proposal-count">{pendingProposals.length}</span>
          )}
        </h2>
        {pendingProposals.length === 0 ? (
          <div className="block-empty">No pending proposals</div>
        ) : (
          pendingProposals.map((p) => (
            <div className="proposal-card" key={p.id}>
              <h3>{p.path}</h3>
              <p>{p.summary}</p>
              <div className="proposal-actions">
                <button onClick={() => void decide(p, "reject")}>Reject</button>
                <button className="primary" onClick={() => void decide(p, "accept")}>
                  Accept
                </button>
              </div>
            </div>
          ))
        )}
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
              <button
                className="icon"
                aria-label="关闭"
                disabled={styleBusy}
                onClick={() => setShowStylePicker(false)}
              >×</button>
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
              <button className="icon" aria-label="关闭" onClick={() => setShowConnectionPanel(false)}>×</button>
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
                <h2>界面风格</h2>
                <p>
                  选择工作台配色。下方「案例」对应典型用法。写作文风请点顶栏「风格」配置。
                </p>
              </div>
              <button className="icon" aria-label="关闭" onClick={() => setShowThemePicker(false)}>×</button>
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
                    <small>{item.description}</small>
                    <span className="theme-example">{item.example}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {managementView && (
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
                    <button className="ghost" onClick={() => setSimpleCardDraft({ name: "", identity: "", relationship: "", knowledge: "", scene: "", goal: "" })}>+ 简易角色</button>
                    <button className="primary" onClick={() => setCharacterDraft({ ...EMPTY_CHARACTER })}>+ 普通角色</button>
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
                      }} title="新建会话并清除当前 step 渲染">+ Session</button>
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
                >×</button>
              </div>
            </div>

            {managementView === "characters" ? (
              <div className="character-grid">
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
                {state.roleplayInterlocutors.map((card) => (
                  <div className={`character-card-wrap simple${agentHiddenCharacterCards.has(`simple:${card.id}`) ? " agent-hidden" : ""}`} key={`simple-${card.id}`}>
                    <button className="character-card" onClick={() => setSimpleCardDraft({ ...card })}>
                      <span className="character-avatar">{card.name.slice(0, 1)}</span>
                      <span className="character-card-body">
                        <strong title={card.name}>{card.name}</strong>
                        <small>简易角色卡</small>
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
                          <button className="icon" title="Rename" onClick={() => void renameSession(session.id, session.title)}>✎</button>
                          <button className="icon danger" title="Delete" onClick={() => void deleteSession(session.id)}>×</button>
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

      {showSettings && <ModelConfig
        initialCatalog={state.providerCatalog}
        scenePipeline={state.agentSettings?.scenePipeline ?? { preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5 }}
        request={api}
        onClose={() => setShowSettings(false)}
        onChanged={() => { void refresh(state.sessionId); }}
        onScenePipelineChanged={scenePipeline => setState(previous => previous ? {
          ...previous,
          agentSettings: {
            permissionMode: previous.agentSettings?.permissionMode ?? "ask",
            scenePipeline,
          },
        } : previous)}
      />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
