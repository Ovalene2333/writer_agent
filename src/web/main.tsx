import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
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
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  IdCard,
  ImagePlus,
  Library,
  ListOrdered,
  LockKeyhole,
  Menu,
  MessageSquare,
  Minus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  Save,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
  WandSparkles,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import { Marked, type Token, type Tokens } from "marked";
import { documentDiff, renderDiffHtml } from "../diff";
import { characterEditorSaveInput } from "../character_editor_payload";
import type { CharacterSummaryKind } from "./character_editor";
import {
  apiUrl,
  buildReadonlyEntryUrl,
  buildEntryUrl,
  ensureConnection,
  failoverFrom,
  getAccessToken,
  getActiveBase,
  getConnectionInfo,
  initConnection,
  probeConnectionRoutes,
  setConnectionPreference,
  startConnectionMonitor,
  subscribeConnection,
  type ConnectionInfo,
  type ConnectionProbeResults,
  type ConnectionPreference,
} from "./connection";
import type { ProseLengthSettings, ProviderCatalog, ScenePipelineSettings, SettingsSection, WritingExecutionMode } from "./model_config";

/** Heavy management panels — code-split so first paint does not pay for them. */
const CharacterEditor = React.lazy(async () => {
  const mod = await import("./character_editor");
  return { default: mod.CharacterEditor };
});
const ModelConfig = React.lazy(async () => {
  const mod = await import("./model_config");
  return { default: mod.ModelConfig };
});

/** 后端未回篇幅设置时的兜底档，与 agent_runtime 的 DEFAULT_SETTINGS.proseLength 保持一致。 */
const DEFAULT_PROSE_LENGTH: ProseLengthSettings = { chapterTargetCharacters: 3000, enforceMinimum: false };
import "./style.css";

/** Rule-layer writing-quality picture. Absent on非正文提案与旧提案 —— 渲染时必须容忍。 */
type ProseQualityReport = {
  characters: number;
  /** 越高越好。 */
  vividness: { score: number; summary: string };
  /** 越高越可疑（AI 味）。 */
  aiTells: { score: number; summary: string };
  grade: "good" | "fair" | "weak";
  /** 本轮篇幅目标与实际；偏短不阻断交付，只在这里露出来。 */
  length?: { target: number; actual: number; status: "ok" | "too_short" | "too_long" };
  warnings: Array<{ source: "metrics" | "vividness" | "ai_tells"; code: string; message: string; examples: string[] }>;
};

type Proposal = {
  id: number;
  path: string;
  summary: string;
  beforeContent: string;
  afterContent: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  qualityReport?: ProseQualityReport;
};

const QUALITY_GRADE_LABEL: Record<ProseQualityReport["grade"], string> = {
  good: "良好",
  fair: "尚可",
  weak: "偏弱",
};

const QUALITY_SOURCE_LABEL: Record<ProseQualityReport["warnings"][number]["source"], string> = {
  metrics: "节奏",
  vividness: "现场感",
  ai_tells: "AI 味",
};

/**
 * Advisory card: everything blocking已在提案创建前拦掉，这里只是让作者在按 Accept
 * 之前看到这一章的质量画像。默认折叠明细，避免把审阅 dock 撑开。
 */
function ProposalQualityCard({ report }: { report: ProseQualityReport }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`proposal-quality grade-${report.grade}`}>
      <div className="proposal-quality-head">
        <span className="proposal-quality-grade">{QUALITY_GRADE_LABEL[report.grade]}</span>
        <span className="proposal-quality-metric" title={report.vividness.summary}>
          现场感 {report.vividness.score}
        </span>
        <span className="proposal-quality-metric" title={report.aiTells.summary}>
          AI 味 {report.aiTells.score}
        </span>
        {report.length
          ? <span
              className={`proposal-quality-chars length-${report.length.status}`}
              title={`目标 ${report.length.target} 字${report.length.status === "too_short" ? "；偏短，想更长直接说一句" : report.length.status === "too_long" ? "；偏长" : ""}`}
            >{report.length.actual} / {report.length.target} 字</span>
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

function mergeProposalEvent(current: Proposal[], incoming: Proposal): Proposal[] {
  const existing = current.find(item => item.id === incoming.id);
  // Replayed SSE history may contain the original pending event after a refresh
  // has already observed the terminal database state. Never downgrade it.
  if (incoming.status === "pending" && existing && existing.status !== "pending") return current;
  return [incoming, ...current.filter(item => item.id !== incoming.id)];
}
type MessageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storagePath: string;
};

type PendingAttachment = {
  localId: string;
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
  previewUrl: string;
};

type Message = {
  id: number;
  role: string;
  content: string;
  channel?: "agent" | "roleplay";
  roleplayInputMode?: RoleplayInputMode;
  roleplayPerception?: string;
  roleplayPerceptionData?: RoleplayPerceptionProjection;
  variantGroupId?: string;
  variantCount?: number;
  attachments?: MessageAttachment[];
};

const MULTIMODAL_MAX_ATTACHMENTS = 4;
const MULTIMODAL_MAX_BYTES = 4 * 1024 * 1024;
const MULTIMODAL_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]);

function isSupportedComposerImage(file: File): boolean {
  return MULTIMODAL_MIME.has(file.type.toLowerCase());
}

async function fileToPendingAttachment(file: File): Promise<PendingAttachment> {
  if (!isSupportedComposerImage(file)) throw new Error(`不支持的图片类型：${file.type || file.name}`);
  if (file.size > MULTIMODAL_MAX_BYTES) throw new Error("单张图片不能超过 4MB");
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "image.png",
    mimeType: file.type === "image/jpg" ? "image/jpeg" : file.type,
    size: file.size,
    dataBase64: btoa(binary),
    previewUrl: URL.createObjectURL(file),
  };
}

function attachmentImageUrl(sessionId: string, attachmentId: string): string {
  const token = getAccessToken() || "";
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return apiUrl(`/api/session/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}${query}`);
}
type RoleplayPerceptionProjection = {
  speech: string[];
  knowableFacts: string[];
  unknowableFacts: string[];
  potentialSensations: string[];
};
type RoleplayRerunDirection = "shorter" | "more_emotional" | "less_explanation" | "more_subtext" | "warmer" | "more_confrontational" | "dialogue_only" | "with_action" | "no_question" | "change_tactic";
type RoleplayContentRating = "default" | "sfw" | "nsfw";
type RoleplayRerunControls = {
  length: number;
  pace: number;
  emotion: number;
  action: number;
  initiative: number;
  contentRating: RoleplayContentRating;
};
type RoleplayRerunSliderKey = Exclude<keyof RoleplayRerunControls, "contentRating">;
const DEFAULT_ROLEPLAY_RERUN_CONTROLS: RoleplayRerunControls = {
  length: 0,
  pace: 0,
  emotion: 0,
  action: 0,
  initiative: 0,
  contentRating: "default",
};
const ROLEPLAY_CONTINUATION_PLACEHOLDER = "<续演>";
const ROLEPLAY_RERUN_SLIDERS: Array<{ id: RoleplayRerunSliderKey; label: string; low: string; high: string }> = [
  { id: "length", label: "篇幅", low: "精简", high: "充分" },
  { id: "pace", label: "节奏", low: "舒缓", high: "紧凑" },
  { id: "emotion", label: "情绪", low: "克制", high: "强烈" },
  { id: "action", label: "动作占比", low: "台词", high: "动作" },
  { id: "initiative", label: "主动程度", low: "迟疑", high: "主动" },
];
const ROLEPLAY_RERUN_DIRECTION_OPTIONS: Array<{ id: RoleplayRerunDirection; label: string; description: string }> = [
  { id: "less_explanation", label: "减少解释", description: "删除分析与归纳" },
  { id: "more_subtext", label: "增加潜台词", description: "把意图留在言外" },
  { id: "warmer", label: "更加柔和", description: "表达更多善意" },
  { id: "more_confrontational", label: "更有锋芒", description: "表达直接且有张力" },
  { id: "no_question", label: "不要提问", description: "不以问题推进" },
  { id: "change_tactic", label: "改变策略", description: "目标不变，换一种做法" },
];
type RoleplayBranchSummary = {
  id: string;
  groupId: string;
  fromMessageId: number;
  label: string;
  preview: string;
  messageCount: number;
  createdAt: string;
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
  sceneSequence: RoleplayScene[];
  sceneIndex: number;
  contentRating: RoleplayContentRating;
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
type RoleplaySessionMemory = {
  performerKey: string;
  summary: string;
  summarizedThroughId: number;
  state: { scene: string };
  turnCount: number;
  sameBeatTurns: number;
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
type ChapterSummary = {
  path: string;
  title: string;
  volume: string;
  wordCount: number;
  versionCount: number;
  updatedAt: string;
};
type MarkdownHeading = { id: string; level: number; text: string };
type Temporal = { validFrom?: string; validUntil?: string };
type TextEntry = Temporal & { id: string; label: string; description: string };
type Goal = Temporal & { id: string; category: "longTerm" | "current"; status: "active" | "achieved" | "abandoned" | "blocked" | "unknown"; priority: number; summary: string; stakes: string; obstacles: string[] };
type Relationship = Temporal & { id: string; characterId: number; type: string; description: string; attitude: string; status: "active" | "ended" | "strained" | "unknown" };
type Competency = Temporal & { id: string; name: string; summary: string; level: string; unlocked: boolean; description: string; resources: string[]; limitations: string[]; costs: string[] };
type Feature = { id: string; name: string; summary: string; description: string };
type StoryState = Temporal & { id: string; outlineNodeId?: string; unanchored?: boolean; location: string; physical: string; emotion: string; knowledge: TextEntry[]; beliefs: TextEntry[]; intentions: string[]; temporaryGoals: Goal[]; notes: string };
type Character = {
  schemaVersion: 3; id: number;
  identity: { name: string; aliases: string[]; tags: string[]; narrativeRole: string; summary: string };
  profile: { appearance: string; appearanceSummary: string; background: string; backgroundSummary: string; biography: string };
  psychology: { summary: string; traits: TextEntry[]; values: TextEntry[]; fears: TextEntry[]; conflicts: TextEntry[] };
  motivations: Goal[]; voice: { summary: string; register: string; diction: string[]; verbalHabits: string[]; avoidedExpressions: string[]; examples: string[] };
  features: Feature[]; competencies: Competency[]; relationships: Relationship[]; storyStates: StoryState[]; experiences: TextEntry[]; notes: string; updatedAt: string;
};
type CharacterDraft = Omit<Character, "id" | "updatedAt"> & { id?: number };
type StepUsageCall = {
  model?: string;
  providerName?: string;
  callKind: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cost: number;
  currency: string;
  estimated?: boolean;
};
type StepUsage = {
  model?: string;
  providerName?: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
  cost: number;
  currency: string;
  estimated?: boolean;
  cacheHitRate?: number;
  callBreakdown?: StepUsageCall[];
  requestComponents?: Array<{
    kind: "stable_system" | "dynamic_system" | "tool_schema" | "user" | "assistant" | "tool_result" | "other";
    label: string;
    characters: number;
    estimatedTokens: number;
    fingerprint?: string;
    callKind?: string;
  }>;
};

/** Human labels for nested call kinds shown in step usage breakdown. */
function callKindLabel(callKind: string): string {
  const key = callKind.trim();
  const map: Record<string, string> = {
    agent_step: "Agent 主步",
    planner: "任务规划",
    prose_gate: "句式门禁",
    learned_prose_gate: "学习门禁",
    direct_chapter_review: "整章终审",
    chapter_review: "章节终审",
    auto_title: "自动标题",
    unspecified: "未标注",
    本步汇总: "本步汇总（无分项）",
  };
  return map[key] ?? key;
}
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
  messageId?: number;
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
  callBreakdown: Array<{
    providerName: string;
    model: string;
    callCount: number;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    cost: number;
    currency: string;
  }>;
};
type Provider = {
  provider: "deepseek" | "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  source: "project" | "environment";
  supportsMultimodal?: boolean;
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
  builtIn?: boolean;
  customized?: boolean;
  /** Built-in templates cannot be edited or overridden. */
  readOnly?: boolean;
};
type StyleTemplateDraft = StyleTemplateInfo & { isNew: boolean };
type ProseGateRule = {
  id: string;
  instruction: string;
  kind: "hard_gate" | "style_preference";
  severity: "block" | "warn";
  enabled: boolean;
  sourceFeedback: string;
  createdAt: string;
  updatedAt: string;
};
type ProseGateRuleDraft = Pick<ProseGateRule, "id" | "instruction" | "kind" | "severity" | "enabled" | "sourceFeedback">
  & { isNew: boolean };
type ContinuityFact = {
  id: number;
  statement: string;
  kind: "milieu" | "character" | "location" | "event" | "object" | "relationship" | "organization" | "other";
  scopeKind: "global" | "era" | "arc" | "chapter" | "location" | "character";
  scopeValue: string;
  validFrom: string;
  validUntil: string;
  epistemic: "objective" | "character_knowledge" | "rumor";
  knownBy: string[];
  importance: number;
  status: "active" | "conflict" | "pending" | "stale" | "retracted";
  sourcePath: string;
  sourceHash: string;
  sourceEvidence: string;
  sourceAnchorId: string;
  sourceProposalId?: number;
  conflictsWith: number[];
  supersedes: number[];
  createdAt: string;
  updatedAt: string;
};
type ContinuityFactDraft = Omit<ContinuityFact, "id" | "sourceHash" | "sourceAnchorId" | "sourceProposalId" | "createdAt" | "updatedAt">
  & { id?: number };
type MessageStepTrail = {
  sourceMessageId: number;
  jobId?: string;
  steps: Array<{
    id: number;
    output: string;
    reasoning: string;
    tools: string[];
    status: "running" | "completed" | "failed";
    usage?: StepUsage;
  }>;
  updatedAt: string;
};
type ContextGraphNode = {
  id: string;
  sessionId: string;
  kind: string;
  status: "active" | "archived";
  label: string;
  sourceMessageId?: number;
  jobId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
type ContextGraphEdge = {
  id: string;
  sessionId: string;
  fromId: string;
  toId: string;
  kind: string;
  createdAt: string;
};
type ContextGraphView = {
  sessionId: string;
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
  activeHandoffs: ContextGraphNode[];
  activeEpochs: ContextGraphNode[];
  activeTrunks?: ContextGraphNode[];
  recentSlices: ContextGraphNode[];
  stats: {
    activeNodes: number;
    archivedNodes: number;
    edgeCount: number;
    handoffCount: number;
    trunkCount?: number;
    totalNodes: number;
  };
  /** True when `nodes` is a recent window rather than the whole session. */
  truncated: boolean;
};
type State = {
  accessMode?: "owner" | "readonly";
  config: { title: string; style?: string };
  documents: string[];
  documentFolders: string[];
  hiddenDocuments: string[];
  hiddenFolders: string[];
  sessionId: string;
  messages: Message[];
  messagesHasMore: boolean;
  /** Server-persisted step trails for messages on the current page. */
  stepTrails?: MessageStepTrail[];
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
  agentSettings?: { permissionMode: PermissionMode; writingMode: WritingExecutionMode; characterEvolutionEnabled: boolean; continuityFactsEnabled?: boolean; reviewFollowsProseModel?: boolean; scenePipeline: ScenePipelineSettings; proseLength?: ProseLengthSettings };
  proseGateRules?: ProseGateRule[];
  continuityFacts?: ContinuityFact[];
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
  profile: { appearance: "", appearanceSummary: "", background: "", backgroundSummary: "", biography: "" },
  psychology: { summary: "", traits: [], values: [], fears: [], conflicts: [] }, motivations: [],
  voice: { summary: "", register: "", diction: [], verbalHabits: [], avoidedExpressions: [], examples: [] },
  features: [], competencies: [], relationships: [], storyStates: [], experiences: [], notes: "",
};
/** Visual UI themes (workspace chrome). Not writing style templates. */
type UiThemeId = "light" | "dark" | "ink" | "rose" | "ocean" | "graphite";
type WorkspaceMode = "split" | "editor-focus" | "agent-focus";
type DocumentSidebarMode = "chapters" | "files";
type ManagementView = "characters" | "sessions" | "models" | "prose-gates" | "continuity-facts" | "context-graph";

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

const LAST_SESSION_KEY = "writer-last-session-id";

function readLastSessionId(): string | undefined {
  try {
    const id = localStorage.getItem(LAST_SESSION_KEY)?.trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

function rememberLastSessionId(id: string | undefined): void {
  if (!id) return;
  try {
    localStorage.setItem(LAST_SESSION_KEY, id);
  } catch {
    /* ignore quota / private mode */
  }
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

const ARCHIVE_ROOT = "archive";

function isArchivedPath(path: string): boolean {
  return path === ARCHIVE_ROOT || path.startsWith(`${ARCHIVE_ROOT}/`);
}

/** Move under archive/ while preserving the original relative path. */
function archiveDestinationPath(path: string): string {
  if (isArchivedPath(path)) return path;
  return `${ARCHIVE_ROOT}/${path}`;
}

/** Restore from archive/<original>. */
function unarchiveDestinationPath(path: string): string | null {
  if (!isArchivedPath(path) || path === ARCHIVE_ROOT) return null;
  return path.slice(ARCHIVE_ROOT.length + 1);
}

type RowMenuItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/** Collapse secondary row actions into one overflow menu to reduce button clutter. */
function RowOverflowMenu({
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

function SettingsMenu({ open, connectionAvailable, onClose, onSelect, onReviewRules, onContinuityFacts }: {
  open: boolean;
  connectionAvailable: boolean;
  onClose: () => void;
  onSelect: (section: SettingsSection) => void;
  onReviewRules: () => void;
  onContinuityFacts: () => void;
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
        <button type="button" role="menuitem" onClick={pick(onContinuityFacts)}><Library size={16} aria-hidden="true" />连续性事实</button>
        <i className="settings-menu-separator" aria-hidden="true" />
        <button type="button" role="menuitem" disabled={!connectionAvailable} onClick={pick(() => onSelect("connection"))}><Wifi size={16} aria-hidden="true" />连接设置</button>
        <button type="button" role="menuitem" onClick={pick(() => onSelect("appearance"))}><Sun size={16} aria-hidden="true" />界面主题</button>
      </div>
    </div>
  );
}

function HeaderMoreMenu({
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

function WorkspaceShell({ mode, documentsCollapsed, readOnly = false, children }: {
  mode: WorkspaceMode;
  documentsCollapsed: boolean;
  readOnly?: boolean;
  children: React.ReactNode;
}) {
  return <div className={`app workspace-${mode}${documentsCollapsed ? " documents-collapsed" : ""}${readOnly ? " readonly" : ""}`}>{children}</div>;
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
const STEP_TRAIL_MAX_SESSIONS = 20;
const STEP_TRAIL_MAX_TEXT_LENGTH = 24_000;
const STEP_TRAIL_MAX_STORAGE_LENGTH = 2_500_000;

function compactStepTrailText(value: string): string {
  if (value.length <= STEP_TRAIL_MAX_TEXT_LENGTH) return value;
  const tailLength = 5_000;
  const headLength = STEP_TRAIL_MAX_TEXT_LENGTH - tailLength;
  return `${value.slice(0, headLength)}\n\n[内容过长，已截断]\n\n${value.slice(-tailLength)}`;
}

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

function saveStepTrail(sessionId: string, messageId: number, steps: StreamStep[]): void {
  if (!sessionId || !steps.length) return;
  // Negative ids are optimistic anchors. Persist them too so a refresh during a job
  // does not erase the trail before the server assigns the real message id.
  if (!Number.isFinite(messageId) || messageId === 0) return;
  const map = readStepTrailMap();
  map[sessionId] = {
    sessionId,
    messageId,
    steps: steps.map((step) => ({
      ...step,
      output: compactStepTrailText(step.output),
      reasoning: compactStepTrailText(step.reasoning),
      expanded: false,
    })),
    updatedAt: new Date().toISOString(),
  };
  // Bound both session count and serialized size. Full model output can otherwise
  // exceed the browser quota and make setItem fail without preserving this run.
  const entries = Object.entries(map).sort((a, b) => (b[1].updatedAt || "").localeCompare(a[1].updatedAt || ""));
  const kept = entries.slice(0, STEP_TRAIL_MAX_SESSIONS);
  let serialized = JSON.stringify(Object.fromEntries(kept));
  while (serialized.length > STEP_TRAIL_MAX_STORAGE_LENGTH && kept.length > 1) {
    kept.pop();
    serialized = JSON.stringify(Object.fromEntries(kept));
  }
  try {
    localStorage.setItem(STEP_TRAIL_STORAGE_KEY, serialized);
  } catch {
    // Other local data may consume the quota. Retry after evicting older trails.
    while (kept.length > 1) {
      kept.pop();
      try {
        localStorage.setItem(STEP_TRAIL_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
        return;
      } catch {
        /* keep evicting */
      }
    }
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
  const multi = (usage.callBreakdown?.length ?? 0) > 1 || usage.model === "多个模型";
  const parts = [
    usage.estimated ? "估算" : null,
    multi ? "多模型合计" : usage.model ?? null,
    `输入 ${usage.promptTokens.toLocaleString()}`,
    `输出 ${usage.completionTokens.toLocaleString()}`,
    `缓存命中 ${usage.cacheHitTokens.toLocaleString()}`,
    usage.cacheHitRate !== undefined
      ? `${multi ? "合计命中率" : "命中率"} ${(usage.cacheHitRate * 100).toFixed(1)}%`
      : null,
    usage.cost > 0
      ? `费用 ${usage.currency === "CNY" ? "¥" : "$"}${usage.cost.toFixed(6)}`
      : null,
    multi && usage.callBreakdown?.length
      ? usage.callBreakdown
          .map(call => {
            const m = call.cacheHitTokens + call.cacheMissTokens;
            const rate = m > 0 ? `${((call.cacheHitTokens / m) * 100).toFixed(0)}%` : "—";
            return `${callKindLabel(call.callKind)}/${call.model ?? "?"} ${rate}`;
          })
          .join("；")
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
  const models = [...new Set(withUsage.flatMap(step =>
    step.usage?.callBreakdown?.map(call => call.model).filter((model): model is string => Boolean(model))
      ?? (step.usage?.model ? [step.usage.model] : []),
  ))];
  const currency = withUsage.find((step) => step.usage!.cost > 0)?.usage?.currency
    ?? withUsage[0].usage!.currency
    ?? "CNY";
  const measured = withUsage.filter(step => !step.usage?.estimated);
  const measuredHits = measured.reduce((sum, step) => sum + (step.usage?.cacheHitTokens ?? 0), 0);
  const measuredMisses = measured.reduce((sum, step) => sum + (step.usage?.cacheMissTokens ?? 0), 0);
  return {
    ...(models.length ? { model: models.length === 1 ? models[0] : "多个模型" } : {}),
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


function stepsFromServerTrail(trail: MessageStepTrail): StreamStep[] {
  return trail.steps.map((step) => ({
    id: step.id,
    output: step.output ?? "",
    reasoning: step.reasoning ?? "",
    tools: Array.isArray(step.tools) ? step.tools : [],
    status: step.status === "running" || step.status === "failed" || step.status === "completed"
      ? step.status
      : "completed",
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
let markdownSourceText = "";
let markdownSourceCursor = 0;
let markdownSourceRangesEnabled = false;

function markdownSourceRangeAttributes(raw: string): string {
  if (!markdownSourceRangesEnabled || !raw) return "";
  let start = markdownSourceText.indexOf(raw, markdownSourceCursor);
  if (start < 0) start = markdownSourceText.indexOf(raw);
  if (start < 0) return "";
  const end = start + raw.length;
  markdownSourceCursor = end;
  return ` data-source-start="${start}" data-source-end="${end}"`;
}

markdownParser.use({
  renderer: {
    heading({ tokens, depth, raw }: Tokens.Heading) {
      const text = this.parser.parseInline(tokens);
      const id = markdownHeadingPrefix
        ? ` id="${markdownHeadingPrefix}-section-${++markdownHeadingIndex}"`
        : "";
      return `<h${depth}${id}${markdownSourceRangeAttributes(raw)}>${text}</h${depth}>\n`;
    },
    paragraph({ tokens, raw }: Tokens.Paragraph) {
      return `<p${markdownSourceRangeAttributes(raw)}>${this.parser.parseInline(tokens)}</p>\n`;
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
  markdownSourceText = normalized;
  markdownSourceCursor = 0;
  markdownSourceRangesEnabled = headingPrefix === "document";
  try {
    const html = markdownParser.parse(normalized, { async: false });
    return typeof html === "string" ? html : "";
  } catch {
    // Fallback: plain escaped text so the reader never goes blank.
    return `<p>${escapeHtml(normalized).replace(/\n/g, "<br/>")}</p>`;
  }
}

function documentWordCount(content: string): number {
  return Array.from(content).filter(character => !/\s/u.test(character)).length;
}

function originalOffsetForNormalized(source: string, normalizedOffset: number): number {
  let original = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let normalized = 0;
  while (original < source.length && normalized < normalizedOffset) {
    if (source[original] === "\r" && source[original + 1] === "\n") original += 2;
    else original += 1;
    normalized += 1;
  }
  return original;
}

type DocumentContextSelection = {
  id: string;
  path: string;
  text: string;
};

type ReaderTextSelection = DocumentContextSelection & {
  start: number;
  end: number;
  blockCount: number;
  left: number;
  top: number;
};

function readingProgressStorageKey(path: string): string {
  return `writer-reading-progress:v1:${getActiveBase()}:${path}`;
}

function loadReadingProgress(path: string): number | undefined {
  if (!path) return undefined;
  const value = Number(localStorage.getItem(readingProgressStorageKey(path)));
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
}

function saveReadingProgress(path: string, ratio: number): void {
  if (!path) return;
  localStorage.setItem(readingProgressStorageKey(path), String(Math.max(0, Math.min(1, ratio))));
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

function shortProviderName(value?: string): string {
  const full = value?.trim();
  return full ? Array.from(full).slice(0, 2).join("") : "未知";
}

function RoleplayPerceptionDetails({ content, data, disabled, onSave, onReplay }: {
  content: string;
  data?: RoleplayPerceptionProjection;
  disabled?: boolean;
  onSave: (value: RoleplayPerceptionProjection) => Promise<void>;
  onReplay: (value: RoleplayPerceptionProjection) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RoleplayPerceptionProjection | null>(null);
  const [saving, setSaving] = useState(false);
  const beginEdit = () => {
    if (!data) return;
    setDraft({ ...data, speech: [...data.speech], knowableFacts: [...data.knowableFacts], unknowableFacts: [...data.unknowableFacts], potentialSensations: [...data.potentialSensations] });
    setEditing(true);
  };
  const setLines = (key: keyof RoleplayPerceptionProjection, value: string) => {
    setDraft(current => current ? { ...current, [key]: value.split("\n").map(item => item.trim()).filter(Boolean) } : current);
  };
  const submit = async (replay: boolean) => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      if (replay) await onReplay(draft);
      else await onSave(draft);
      setEditing(false);
    } finally { setSaving(false); }
  };
  const perceptionGroups = data ? [
    { key: "speech", label: "话语", items: data.speech },
    { key: "knowable", label: "可知事实", items: data.knowableFacts },
    { key: "unknowable", label: "不可知事实", items: data.unknowableFacts },
    { key: "sensations", label: "潜在感受", items: data.potentialSensations },
  ].filter(group => group.items.length > 0) : [];
  return (
    <details className="roleplay-perception-details">
      <summary>角色感知</summary>
      {!editing ? (
        <>
          {data ? (
            <div className="roleplay-perception-content">
              {perceptionGroups.length ? perceptionGroups.map(group => (
                <div className="roleplay-perception-group" key={group.key}>
                  <span>{group.label}</span>
                  <div>{group.items.map((item, index) => <p key={`${group.key}-${index}`}>{item}</p>)}</div>
                </div>
              )) : (
                <p className="roleplay-perception-empty">没有可确认的可感知内容</p>
              )}
            </div>
          ) : (
            <Markdown content={content} className="roleplay-perception-content roleplay-perception-legacy" />
          )}
          {data && <button className="roleplay-perception-edit" type="button" disabled={disabled} onClick={beginEdit} title="修正角色实际能够感知的内容">
            <Pencil size={13} aria-hidden="true" />编辑感知
          </button>}
        </>
      ) : draft ? (
        <div className="roleplay-perception-editor">
          <label><span>话语</span><textarea value={draft.speech.join("\n")} onChange={event => setLines("speech", event.target.value)} /></label>
          <label><span>可知事实</span><textarea value={draft.knowableFacts.join("\n")} onChange={event => setLines("knowableFacts", event.target.value)} /></label>
          <label><span>不可知事实</span><textarea value={draft.unknowableFacts.join("\n")} onChange={event => setLines("unknowableFacts", event.target.value)} /></label>
          <label><span>潜在感受</span><textarea value={draft.potentialSensations.join("\n")} onChange={event => setLines("potentialSensations", event.target.value)} /></label>
          <div className="roleplay-perception-actions">
            <button type="button" disabled={saving} onClick={() => setEditing(false)}>取消</button>
            <button type="button" disabled={saving} onClick={() => void submit(false)}><Save size={13} aria-hidden="true" />保存</button>
            <button type="button" className="primary" disabled={saving} onClick={() => void submit(true)}><RefreshCw size={13} aria-hidden="true" />保存并重演</button>
          </div>
        </div>
      ) : null}
    </details>
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
                  {p.qualityReport && <ProposalQualityCard report={p.qualityReport} />}
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

type ChapterGroup = { id: string; label: string; folderPath: string; chapters: ChapterSummary[] };

function buildChapterGroups(chapters: ChapterSummary[], folders: string[]): ChapterGroup[] {
  const volumes = new Set<string>([""]);
  for (const folder of folders) {
    if (folder.startsWith("chapters/")) volumes.add(folder.slice("chapters/".length));
  }
  for (const chapter of chapters) volumes.add(chapter.volume);
  return [...volumes]
    .sort((a, b) => {
      if (!a) return -1;
      if (!b) return 1;
      return a.localeCompare(b, "zh-CN", { numeric: true });
    })
    .map(volume => ({
      id: volume || "__ungrouped__",
      label: volume || "未分卷",
      folderPath: volume ? `chapters/${volume}` : "chapters",
      chapters: chapters.filter(chapter => chapter.volume === volume),
    }));
}

function ChapterManager({
  groups,
  query,
  activePath,
  readOnly,
  collapsed,
  onToggleGroup,
  onSelect,
  onVersions,
  onRename,
  onDelete,
  onDuplicate,
  onMove,
  onRequestMove,
  onArchive,
  onNewChapter,
}: {
  groups: ChapterGroup[];
  query: string;
  activePath: string;
  readOnly: boolean;
  collapsed: Set<string>;
  onToggleGroup: (id: string) => void;
  onSelect: (path: string) => void;
  onVersions: (path: string) => void;
  onRename: (path: string, kind: "file" | "folder") => void;
  onDelete: (path: string, kind: "file" | "folder") => void;
  onDuplicate: (path: string) => void;
  onMove: (path: string, kind: "file" | "folder", target: string) => void;
  onRequestMove: (chapter: ChapterSummary) => void;
  onArchive: (path: string, kind: "file" | "folder", label: string) => void;
  onNewChapter: (folderPath: string) => void;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = groups.flatMap(group => {
    const chapters = normalizedQuery
      ? group.chapters.filter(chapter => `${chapter.title} ${chapter.path}`.toLocaleLowerCase().includes(normalizedQuery))
      : group.chapters;
    return chapters.length || !normalizedQuery ? [{ ...group, chapters }] : [];
  });
  if (!visible.some(group => group.chapters.length)) {
    return (
      <div className="sidebar-empty compact">
        <BookOpenText size={24} aria-hidden="true" />
        <strong>{normalizedQuery ? "没有匹配的章节" : "还没有章节"}</strong>
        <span>{normalizedQuery ? "可按章节标题或路径搜索" : "从上方新建章节开始写作"}</span>
      </div>
    );
  }
  return (
    <div className="chapter-manager">
      {visible.map(group => {
        const isCollapsed = collapsed.has(group.id) && !normalizedQuery;
        const words = group.chapters.reduce((total, chapter) => total + chapter.wordCount, 0);
        return (
          <section
            className="chapter-group"
            key={group.id}
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault();
              const raw = event.dataTransfer.getData("application/x-writer-node");
              if (!raw) return;
              const payload = JSON.parse(raw) as { path: string; kind: "file" | "folder" };
              if (payload.kind === "file") onMove(payload.path, payload.kind, group.folderPath);
            }}
          >
            <div className="chapter-group-head">
              <button type="button" className="chapter-group-toggle" onClick={() => onToggleGroup(group.id)}>
                <ChevronRight size={14} className={isCollapsed ? "" : "expanded"} />
                <span>{group.label}</span>
              </button>
              <span className="chapter-group-stats">{group.chapters.length} 章 · {words.toLocaleString("zh-CN")} 字</span>
              {!readOnly && (
                <div className="chapter-group-actions">
                  <IconButton label={`在${group.label}中新建章节`} onClick={() => onNewChapter(group.folderPath)}><Plus size={13} /></IconButton>
                  {group.id !== "__ungrouped__" && (
                    <RowOverflowMenu
                      label={`${group.label} · 更多`}
                      items={[
                        {
                          id: "rename",
                          label: "重命名卷",
                          icon: <Pencil size={13} />,
                          onSelect: () => onRename(group.folderPath, "folder"),
                        },
                        {
                          id: "archive",
                          label: "归档卷",
                          icon: <Archive size={13} />,
                          onSelect: () => onArchive(group.folderPath, "folder", group.label),
                        },
                        {
                          id: "delete",
                          label: "删除卷",
                          icon: <Trash2 size={13} />,
                          danger: true,
                          onSelect: () => onDelete(group.folderPath, "folder"),
                        },
                      ]}
                    />
                  )}
                </div>
              )}
            </div>
            {!isCollapsed && (
              <div className="chapter-list">
                {group.chapters.length === 0 ? (
                  <button type="button" className="chapter-group-empty" onClick={() => onNewChapter(group.folderPath)}>在本卷新建第一章</button>
                ) : group.chapters.map(chapter => (
                  <div
                    key={chapter.path}
                    className={`chapter-row${activePath === chapter.path ? " active" : ""}`}
                    draggable={!readOnly}
                    onDragStart={event => {
                      event.dataTransfer.setData("application/x-writer-node", JSON.stringify({ path: chapter.path, kind: "file" }));
                      event.dataTransfer.effectAllowed = "move";
                    }}
                  >
                    <button type="button" className="chapter-open" onClick={() => onSelect(chapter.path)} title={chapter.path}>
                      <span className="chapter-title">{chapter.title}</span>
                      <span className="chapter-meta">
                        {chapter.wordCount.toLocaleString("zh-CN")} 字
                        {chapter.versionCount > 0 && <> · {chapter.versionCount} 个版本</>}
                      </span>
                    </button>
                    <div className="chapter-row-actions">
                      <IconButton label="版本历史" onClick={() => onVersions(chapter.path)}><History size={13} /></IconButton>
                      {!readOnly && (
                        <RowOverflowMenu
                          label={`${chapter.title} · 更多`}
                          items={[
                            {
                              id: "move",
                              label: "移动到其他卷",
                              icon: <FolderInput size={13} />,
                              onSelect: () => onRequestMove(chapter),
                            },
                            {
                              id: "duplicate",
                              label: "创建副本",
                              icon: <Copy size={13} />,
                              onSelect: () => onDuplicate(chapter.path),
                            },
                            {
                              id: "rename",
                              label: "重命名",
                              icon: <Pencil size={13} />,
                              onSelect: () => onRename(chapter.path, "file"),
                            },
                            {
                              id: "archive",
                              label: "归档章节",
                              icon: <Archive size={13} />,
                              onSelect: () => onArchive(chapter.path, "file", chapter.title),
                            },
                            {
                              id: "delete",
                              label: "删除章节",
                              icon: <Trash2 size={13} />,
                              danger: true,
                              onSelect: () => onDelete(chapter.path, "file"),
                            },
                          ]}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
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
  onArchive,
  onUnarchive,
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
  onArchive: (path: string, kind: "file" | "folder", label: string) => void;
  onUnarchive: (path: string, kind: "file" | "folder", label: string) => void;
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
          {isArchivedPath(node.path) && node.path !== ARCHIVE_ROOT ? (
            <span className="tree-badge archived" title="已归档，不计入现行章节与 Agent 主事实">归档</span>
          ) : null}
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
          <RowOverflowMenu
            label={`${node.name} · 更多`}
            items={[
              ...(node.kind === "folder"
                ? [
                    {
                      id: "new-file",
                      label: "在此新建文档",
                      icon: <Plus size={13} />,
                      onSelect: () => onNewChild(node.path, "file"),
                    },
                    {
                      id: "new-folder",
                      label: "在此新建文件夹",
                      icon: <FolderPlus size={13} />,
                      onSelect: () => onNewChild(node.path, "folder"),
                    },
                  ]
                : [
                    {
                      id: "duplicate",
                      label: "创建副本",
                      icon: <Copy size={13} />,
                      onSelect: () => onDuplicate(node.path),
                    },
                  ]),
              {
                id: "rename",
                label: "重命名",
                icon: <Pencil size={13} />,
                onSelect: () => onRename(node.path, node.kind),
              },
              ...(node.path !== ARCHIVE_ROOT
                ? isArchivedPath(node.path)
                  ? [{
                      id: "unarchive",
                      label: node.kind === "folder" ? "取消归档文件夹" : "取消归档文件",
                      icon: <ArchiveRestore size={13} />,
                      onSelect: () => onUnarchive(node.path, node.kind, node.name),
                    }]
                  : [{
                      id: "archive",
                      label: node.kind === "folder" ? "归档文件夹" : "归档文件",
                      icon: <Archive size={13} />,
                      onSelect: () => onArchive(node.path, node.kind, node.name),
                    }]
                : []),
              {
                id: "delete",
                label: "删除",
                icon: <Trash2 size={13} />,
                danger: true,
                onSelect: () => onDelete(node.path, node.kind),
              },
            ]}
          />
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
            onArchive={onArchive}
            onUnarchive={onUnarchive}
            expandedFolders={expandedFolders}
            setExpandedFolders={setExpandedFolders}
          />
        ))}
        </div>
      )}
    </div>
  );
}

/**
 * Detect mid-job context cut from consecutive step prompt sizes.
 * Chapter boundary typically drops ~40%+ of prompt (e.g. 53k → 16k).
 */
function detectStepContextReset(
  prev: StreamStep | undefined,
  step: StreamStep,
): { fromStep: number; toStep: number; before: number; after: number; ratio: number } | null {
  if (!prev || prev.id < 1 || step.id < 1) return null;
  const before = prev.usage?.promptTokens ?? 0;
  const after = step.usage?.promptTokens ?? 0;
  if (before < 8_000 || after < 1_000) return null;
  if (after >= before * 0.62) return null;
  // Prefer cuts after a document delivery / scene write.
  const prevTools = prev.tools.join(" ");
  const likelyBoundary = /propose_document|propose_chapter|write_chapter_scene|write_document/.test(prevTools)
    || before - after > 12_000;
  if (!likelyBoundary) return null;
  return {
    fromStep: prev.id,
    toStep: step.id,
    before,
    after,
    ratio: after / before,
  };
}

function AgentStepContextResetBanner({
  reset,
}: {
  reset: { fromStep: number; toStep: number; before: number; after: number; ratio: number };
}) {
  const saved = reset.before - reset.after;
  return (
    <div
      className="agent-step-context-reset"
      title="完成一章或一场后会收束上下文：保留稳定规则、项目索引与章节衔接，丢弃上一章的过程细节。之后若再读设定或前章，属于按需补充，属正常行为。"
    >
      <span className="agent-step-context-reset-badge">上下文收束</span>
      <span className="agent-step-context-reset-flow">
        Step {reset.fromStep} → {reset.toStep}
      </span>
      <span className="agent-step-context-reset-tokens">
        {formatGraphTokens(reset.before)} → {formatGraphTokens(reset.after)}
        <em>−{formatGraphTokens(saved)}</em>
      </span>
      <span className="agent-step-context-reset-hint">
        章节切换 · 保留规则与衔接 · 清空过程痕迹
      </span>
    </div>
  );
}

function AgentStepCard({
  step,
  prevStep,
  onToggle,
}: {
  step: StreamStep;
  prevStep?: StreamStep;
  onToggle: () => void;
}) {
  const label =
    step.id === 0
      ? "Planning"
      : step.status === "running"
      ? `Step ${step.id}`
      : step.status === "failed"
        ? `Step ${step.id} failed`
        : `Step ${step.id} done`;
  const reset = detectStepContextReset(prevStep, step);

  return (
    <>
    {reset ? <AgentStepContextResetBanner reset={reset} /> : null}
    <article className={`agent-step ${step.status}${reset ? " after-context-reset" : ""}`}>
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
          {reset ? (
            <div className="agent-step-context-reset-detail">
              <strong>本章节起重新装载的上下文</strong>
              <ul>
                <li>写作规则与项目索引（跨章可复用）</li>
                <li>当前任务说明与上一章/场的衔接摘要</li>
                <li>
                  已卸下约 {formatGraphTokens(reset.before - reset.after)} 的过程痕迹
                  （草稿全文、重试与中间工具结果）
                </li>
                <li>
                  若随后仍读取设定或前章：索引不含全文细节，按需补充属正常
                </li>
              </ul>
            </div>
          ) : null}
          <div className="agent-step-usage-detail">
            {step.usage
              ? (
                <>
                  本步合计{step.usage.estimated ? "（含估算）" : ""}
                  {step.usage.model === "多个模型" || (step.usage.callBreakdown?.length ?? 0) > 1
                    ? " · 多模型"
                    : step.usage.model
                      ? ` · ${step.usage.model}`
                      : ""}
                  ：总计 {step.usage.totalTokens.toLocaleString()}
                  {" · "}
                  输入 {step.usage.promptTokens.toLocaleString()}
                  {" · "}输出 {step.usage.completionTokens.toLocaleString()}
                  {" · "}缓存 {step.usage.cacheHitTokens.toLocaleString()}
                  {step.usage.cacheHitRate !== undefined
                    ? ` · 合计命中 ${(step.usage.cacheHitRate * 100).toFixed(1)}%`
                    : ""}
                  {step.usage.cost > 0
                    ? ` · ${step.usage.currency === "CNY" ? "¥" : "$"}${step.usage.cost.toFixed(6)}`
                    : ""}
                  {(step.usage.callBreakdown?.length ?? 0) > 1
                    ? "（展开查看各调用）"
                    : ""}
                </>
              )
              : "本步暂无 token 数据（供应商未返回 usage 且未能估算）"}
          </div>
          {step.usage && ((step.usage.callBreakdown?.length ?? 0) > 0 || step.usage.model) ? (
            <details className="agent-step-context-breakdown" open>
              <summary>
                模型调用明细
                {(step.usage.callBreakdown?.length ?? 0) > 1
                  ? `（${step.usage.callBreakdown!.length} 次）`
                  : ""}
              </summary>
              <div className="agent-step-context-list">
                {(step.usage.callBreakdown?.length
                  ? step.usage.callBreakdown
                  : [{
                      model: step.usage.model,
                      providerName: step.usage.providerName,
                      callKind: "本步汇总",
                      promptTokens: step.usage.promptTokens,
                      completionTokens: step.usage.completionTokens,
                      cacheHitTokens: step.usage.cacheHitTokens,
                      cacheMissTokens: step.usage.cacheMissTokens,
                      cost: step.usage.cost,
                      currency: step.usage.currency,
                    }]).map((call, index) => {
                  const measured = call.cacheHitTokens + call.cacheMissTokens;
                  const rate = measured > 0 ? call.cacheHitTokens / measured : 0;
                  const kind = callKindLabel(call.callKind);
                  return (
                    <div className="agent-step-context-row agent-step-model-call-row" key={`${call.model ?? "unknown"}-${call.callKind}-${index}`}>
                      <div className="agent-step-model-call-heading">
                        <span className="agent-step-provider-chip" title={call.providerName?.trim() || "供应商信息未记录"}>
                          {shortProviderName(call.providerName)}
                        </span>
                        <strong title={call.model ?? "未知模型"}>{call.model && call.model !== "多个模型" ? call.model : "未知模型"}</strong>
                        <span title={call.callKind}>{kind}</span>
                      </div>
                      <div className="agent-step-model-call-metrics">
                        <span><small>总计</small>{(call.promptTokens + call.completionTokens).toLocaleString()}</span>
                        <span><small>输入</small>{call.promptTokens.toLocaleString()}</span>
                        <span><small>输出</small>{call.completionTokens.toLocaleString()}</span>
                        <span><small>缓存</small>{call.cacheHitTokens.toLocaleString()} <em>{(rate * 100).toFixed(1)}%</em></span>
                        {call.cost > 0
                          ? <span><small>费用</small>{call.currency === "CNY" ? "¥" : "$"}{call.cost.toFixed(6)}</span>
                          : null}
                      </div>
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
                      <span>
                        {component.callKind ? `${component.callKind} · ` : ""}
                        {component.label}
                        {component.fingerprint ? ` · #${component.fingerprint}` : ""}
                      </span>
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
    </>
  );
}


const CONTEXT_GRAPH_KIND_LABEL: Record<string, string> = {
  message: "消息",
  epoch: "任务",
  handoff: "衔接",
  artifact: "交付",
  assemble_slice: "装载",
  project_note: "索引",
};

const CONTEXT_GRAPH_EDGE_LABEL: Record<string, string> = {
  caused_by: "触发",
  uses: "使用",
  produces: "产出",
  supersedes: "取代",
  archives: "归档",
  includes: "包含",
  replays: "续写",
  tree_child: "子节点",
  tree_next: "下一轮",
};

/** Child kind order under a turn (outline readability). */
const CONTEXT_GRAPH_TURN_CHILD_ORDER: Record<string, number> = {
  epoch: 0,
  assemble_slice: 1,
  handoff: 2,
  artifact: 3,
  project_note: 4,
  message: 5,
};

const CONTEXT_GRAPH_LAYER_LABEL: Record<string, string> = {
  L0: "规则与项目索引",
  L1: "历史续写",
  L2: "章节衔接",
  L3: "本轮过程",
};

/** Soften old graph payload jargon when rendering kept/dropped lines. */
function humanizeContextCopy(text: string): string {
  return text
    .replace(/L0\s*/g, "")
    .replace(/L1\s*/g, "")
    .replace(/L2\s*/g, "")
    .replace(/L3\s*/g, "")
    .replace(/handoff/gi, "衔接")
    .replace(/replay/gi, "续写")
    .replace(/材料架/g, "已读材料")
    .replace(/项目树干/g, "项目索引")
    .replace(/树干/g, "索引")
    .replace(/冻块/g, "历史块")
    .replace(/稳定系统前缀/g, "写作规则")
    .replace(/稳定前缀/g, "写作规则")
    .replace(/工具 schema/g, "工具定义")
    .replace(/跨 turn /g, "跨轮 ")
    .replace(/跨章字节稳定[，,]?/g, "跨章可复用")
    .replace(/下一批 step 仍可前缀命中/g, "后续步骤可复用缓存")
    .replace(/前缀命中/g, "缓存命中")
    .replace(/actualState/g, "已写状态")
    .replace(/sourceHash 未变则 materials_shelf_hit/g, "文件未改则直接复用")
    .replace(/materials_shelf_hit/g, "直接复用")
    .replace(/同 session 持久 digests[；;]?/g, "本会话已读摘要；")
    .replace(/digests/g, "摘要")
    .replace(/tok\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[·.\-—]\s*$/g, "")
    .trim();
}

/**
 * The number the card shows, when the payload carries one worth showing.
 *
 * An assemble slice knows how its prompt split across L0~L3; an epoch knows what
 * it froze and — since the runtime writes provider usage back — how much of that
 * the cache actually covered. Everything else stays a plain card rather than
 * inventing a metric.
 */
type ContextGraphNodeMetric =
  | { kind: "layers"; segments: Array<{ layer: string; label: string; tokens: number }>; total: number }
  | { kind: "cache"; frozenTokens?: number; hitRate?: number; promptTokens?: number }
  | null;

function contextGraphNodeMetric(node: ContextGraphNode): ContextGraphNodeMetric {
  if (node.kind === "assemble_slice") {
    const raw = Array.isArray(node.payload?.layers) ? (node.payload.layers as Array<Record<string, unknown>>) : [];
    // Merge same layer code (e.g. L0 stable + L0 trunk) so the bar stays readable.
    const byLayer = new Map<string, { layer: string; label: string; tokens: number }>();
    for (const layer of raw) {
      const code = typeof layer.layer === "string" ? layer.layer : "L3";
      const tokens = typeof layer.estimatedTokens === "number" && layer.estimatedTokens > 0 ? layer.estimatedTokens : 0;
      if (tokens <= 0) continue;
      const label = typeof layer.label === "string" ? layer.label : "";
      const prev = byLayer.get(code);
      if (prev) {
        prev.tokens += tokens;
        if (label && !prev.label.includes(label.slice(0, 6))) prev.label = `${prev.label} · ${label}`;
      } else {
        byLayer.set(code, { layer: code, label, tokens });
      }
    }
    const segments = [...byLayer.values()];
    if (!segments.length) return null;
    return { kind: "layers", segments, total: segments.reduce((sum, segment) => sum + segment.tokens, 0) };
  }
  if (node.kind === "epoch") {
    const frozenTokens = typeof node.payload?.frozenTokens === "number" ? node.payload.frozenTokens : undefined;
    const cache = node.payload?.cache as { hitRate?: unknown; promptTokens?: unknown } | undefined;
    const hitRate = typeof cache?.hitRate === "number" ? cache.hitRate : undefined;
    const promptTokens = typeof cache?.promptTokens === "number" ? cache.promptTokens : undefined;
    if (frozenTokens == null && hitRate == null) return null;
    return { kind: "cache", frozenTokens, hitRate, promptTokens };
  }
  if (node.kind === "project_note" && node.payload?.kind === "trunk") {
    const estimatedTokens = typeof node.payload.estimatedTokens === "number" ? node.payload.estimatedTokens : undefined;
    if (estimatedTokens == null || estimatedTokens <= 0) return null;
    return {
      kind: "layers",
      segments: [{ layer: "L0", label: "项目索引", tokens: estimatedTokens }],
      total: estimatedTokens,
    };
  }
  return null;
}

/** Compact token count: 1240 → "1.2k". */
function formatGraphTokens(tokens: number): string {
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

/**
 * Session-level hit rate over the most recent measured turns.
 *
 * Token-weighted rather than a mean of per-turn rates: one tiny turn should not
 * count as much as a long one when the question is "how much of what we paid for
 * was already cached".
 */
function contextGraphCacheSummary(
  nodes: ContextGraphNode[],
  recent = 20,
): { hitRate: number; promptTokens: number; turns: number } | null {
  const measured = nodes
    .filter((node) => node.kind === "epoch")
    .map((node) => node.payload?.cache as { promptTokens?: unknown; cacheHitTokens?: unknown } | undefined)
    .filter((cache): cache is { promptTokens: number; cacheHitTokens: number } =>
      typeof cache?.promptTokens === "number" && cache.promptTokens > 0 && typeof cache.cacheHitTokens === "number")
    .slice(-recent);
  if (!measured.length) return null;
  const promptTokens = measured.reduce((sum, cache) => sum + cache.promptTokens, 0);
  const hitTokens = measured.reduce((sum, cache) => sum + cache.cacheHitTokens, 0);
  return { hitRate: hitTokens / promptTokens, promptTokens, turns: measured.length };
}

const CONTEXT_GRAPH_NODE_H = 58;
const CONTEXT_GRAPH_NODE_H_TALL = 74;

/** Cards carrying a metric strip need the extra row; everything else stays compact. */
function contextGraphNodeHeight(node: ContextGraphNode): number {
  return contextGraphNodeMetric(node) ? CONTEXT_GRAPH_NODE_H_TALL : CONTEXT_GRAPH_NODE_H;
}

type ContextGraphLayoutNode = ContextGraphNode & {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  treeRole: "root" | "turn" | "leaf";
};

type ContextGraphTreeLink = {
  id: string;
  fromId: string;
  toId: string;
  /** next = turn chain (prefix grows); child = process under a turn */
  kind: "tree_next" | "tree_child";
  label: string;
};

type ContextGraphLayout = {
  placed: ContextGraphLayoutNode[];
  width: number;
  height: number;
  nodeW: number;
  nodeHeights: number[];
  /** Only these edges are drawn — pure tree, no spaghetti. */
  treeLinks: ContextGraphTreeLink[];
};

type ContextGraphTreeItem = {
  node: ContextGraphNode;
  role: "root" | "turn" | "leaf";
  children: ContextGraphTreeItem[];
};

function epochHitRate(node: ContextGraphNode): number | undefined {
  const cache = node.payload?.cache as { hitRate?: unknown } | undefined;
  return typeof cache?.hitRate === "number" ? cache.hitRate : undefined;
}

function assembleReplayTurns(node: ContextGraphNode): number | undefined {
  const replay = node.payload?.replay as { turns?: unknown } | undefined;
  return typeof replay?.turns === "number" ? replay.turns : undefined;
}

function isTrunkNode(node: ContextGraphNode): boolean {
  return node.kind === "project_note" && node.payload?.kind === "trunk";
}

function turnGroupKey(node: ContextGraphNode): string {
  if (node.sourceMessageId != null) return `msg:${node.sourceMessageId}`;
  if (node.jobId) return `job:${node.jobId}`;
  return `solo:${node.id}`;
}

/**
 * Build one session tree:
 *   root(trunk/L0)
 *     └─ turn1 ─┬─ epoch / assemble / handoff …
 *               └─ turn2 ─┬─ …
 *                         └─ turn3 …
 * Nesting turns expresses growing prefix cache; process nodes hang off each turn.
 */
function buildContextGraphTree(nodes: ContextGraphNode[]): ContextGraphTreeItem | null {
  if (!nodes.length) return null;

  const trunks = nodes.filter(isTrunkNode).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rest = nodes.filter((node) => !isTrunkNode(node));

  const groups = new Map<string, ContextGraphNode[]>();
  for (const node of rest) {
    const key = turnGroupKey(node);
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }

  const turns = [...groups.entries()]
    .map(([key, list]) => {
      const sorted = list.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const message = sorted.find((node) => node.kind === "message");
      const epoch = sorted.find((node) => node.kind === "epoch");
      const sortAt = sorted[0]!.createdAt;
      const msgId = message?.sourceMessageId
        ?? sorted.find((node) => node.sourceMessageId != null)?.sourceMessageId
        ?? 0;
      return { key, list: sorted, message, epoch, sortAt, msgId };
    })
    .sort((a, b) => a.sortAt.localeCompare(b.sortAt) || a.msgId - b.msgId);

  const sessionId = nodes[0]!.sessionId;
  const rootNode: ContextGraphNode = trunks[0] ?? {
    id: `virtual-root-${sessionId}`,
    sessionId,
    kind: "project_note",
    status: "active",
    label: "会话共享基础",
    payload: { kind: "trunk", virtual: true, estimatedTokens: 0 },
    createdAt: turns[0]?.sortAt ?? new Date().toISOString(),
    updatedAt: turns[0]?.sortAt ?? new Date().toISOString(),
  };

  // Build turn chain from the end so each turn's last child is the next turn.
  let nextTurnItem: ContextGraphTreeItem | undefined;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const turnRoot = turn.message ?? turn.epoch ?? turn.list[0]!;
    const processKids = turn.list
      .filter((node) => node.id !== turnRoot.id)
      .slice()
      .sort((a, b) => {
        const oa = CONTEXT_GRAPH_TURN_CHILD_ORDER[a.kind] ?? 9;
        const ob = CONTEXT_GRAPH_TURN_CHILD_ORDER[b.kind] ?? 9;
        if (oa !== ob) return oa - ob;
        return a.createdAt.localeCompare(b.createdAt);
      })
      .map((node): ContextGraphTreeItem => ({ node, role: "leaf", children: [] }));

    const children: ContextGraphTreeItem[] = [...processKids];
    if (nextTurnItem) children.push(nextTurnItem);

    nextTurnItem = { node: turnRoot, role: "turn", children };
  }

  return {
    node: rootNode,
    role: "root",
    children: nextTurnItem ? [nextTurnItem] : [],
  };
}

/** Approximate display units: CJK ≈ 2, ASCII ≈ 1. Avoids SVG text overflowing cards. */
function graphLabelUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += /[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe1f\ufe30-\ufe6f\uff00-\uffef]/.test(ch) ? 2 : 1;
  }
  return units;
}

function truncateGraphLabel(value: string, maxUnits = 18): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (graphLabelUnits(text) <= maxUnits) return text;
  let out = "";
  let units = 0;
  for (const ch of text) {
    const add = /[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe1f\ufe30-\ufe6f\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (units + add > maxUnits - 1) break;
    out += ch;
    units += add;
  }
  return `${out}…`;
}

function contextGraphStatusLabel(status: string): string {
  if (status === "active") return "活跃";
  if (status === "archived") return "归档";
  return status;
}

function contextGraphNodeTitle(node: ContextGraphNode): string {
  const raw = node.label.replace(/\s+/g, " ").trim();
  if (node.kind === "message") {
    return truncateGraphLabel(raw.replace(/^用户\s*[·.\-—]\s*/, ""), 22);
  }
  if (node.kind === "epoch") {
    return truncateGraphLabel(raw.replace(/^任务\s*[·.\-—]\s*/, ""), 20);
  }
  if (node.kind === "handoff" || node.kind === "artifact") {
    return truncateGraphLabel(raw.replace(/^(章节衔接|章交接|交付)\s*[·.\-—]\s*/, ""), 20);
  }
  if (node.kind === "project_note" && node.payload?.kind === "trunk") {
    const chars = typeof node.payload.characterCount === "number" ? node.payload.characterCount : undefined;
    const outline = typeof node.payload.outlineNodeCount === "number" ? node.payload.outlineNodeCount : undefined;
    if (chars != null || outline != null) {
      return truncateGraphLabel(`角色 ${chars ?? 0} · 大纲 ${outline ?? 0}`, 22);
    }
    return truncateGraphLabel(raw.replace(/^树干\s*[·.\-—]\s*/, "") || "项目索引", 18);
  }
  if (node.kind === "assemble_slice") {
    const note = typeof node.payload?.note === "string" ? node.payload.note : "";
    const step = typeof node.payload?.step === "number" ? node.payload.step : undefined;
    const transition = node.payload?.transition as { kind?: string } | undefined;
    const stepTag = step != null && step > 0 ? ` · Step ${step}` : "";
    if (transition?.kind === "chapter_boundary" || raw.includes("章边界") || note.includes("章边界") || /chapter boundary/i.test(note)) {
      return truncateGraphLabel(`章节切换${stepTag}`, 22);
    }
    if (transition?.kind === "scene_boundary" || raw.includes("场边界") || note.includes("场边界")) {
      return truncateGraphLabel(`场次切换${stepTag}`, 22);
    }
    if (transition?.kind === "open_turn" || note.includes("开轮") || /initial assemble/i.test(note)) {
      return "本轮开场";
    }
    if (note) return truncateGraphLabel(humanizeContextCopy(note), 20);
    return truncateGraphLabel(raw.replace(/^装配\s*[·.\-—]\s*/, "") || "本轮开场", 18);
  }
  return truncateGraphLabel(raw, 20);
}

function contextGraphNodeMeta(node: ContextGraphNode): string {
  const time = new Date(node.createdAt).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (node.kind === "assemble_slice") {
    const t = node.payload?.transition as {
      beforeTokens?: number;
      afterTokens?: number;
      atStep?: number;
    } | undefined;
    if (typeof t?.beforeTokens === "number" && typeof t?.afterTokens === "number" && t.beforeTokens > t.afterTokens) {
      return `${formatGraphTokens(t.beforeTokens)}→${formatGraphTokens(t.afterTokens)} · ${time}`;
    }
  }
  if (node.sourceMessageId != null) return `#${node.sourceMessageId} · ${time}`;
  return time;
}

type ContextTransitionView = {
  kind: string;
  atStep?: number;
  beforeTokens?: number;
  afterTokens?: number;
  beforeMessageCount?: number;
  afterMessageCount?: number;
  path?: string;
  kept: Array<{ id: string; label: string; detail?: string }>;
  dropped: Array<{ id: string; label: string; detail?: string }>;
  reReadHint?: string;
};

function contextTransitionFromPayload(payload: Record<string, unknown> | undefined): ContextTransitionView | null {
  if (!payload) return null;
  const raw = payload.transition;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  const kept = Array.isArray(t.kept)
    ? t.kept.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.label !== "string") return [];
      return [{
        id: typeof row.id === "string" ? row.id : row.label,
        label: row.label,
        ...(typeof row.detail === "string" ? { detail: row.detail } : {}),
      }];
    })
    : [];
  const dropped = Array.isArray(t.dropped)
    ? t.dropped.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.label !== "string") return [];
      return [{
        id: typeof row.id === "string" ? row.id : row.label,
        label: row.label,
        ...(typeof row.detail === "string" ? { detail: row.detail } : {}),
      }];
    })
    : [];
  if (!kept.length && !dropped.length && t.kind !== "open_turn") return null;
  return {
    kind: typeof t.kind === "string" ? t.kind : "unknown",
    ...(typeof t.atStep === "number" ? { atStep: t.atStep } : {}),
    ...(typeof t.beforeTokens === "number" ? { beforeTokens: t.beforeTokens } : {}),
    ...(typeof t.afterTokens === "number" ? { afterTokens: t.afterTokens } : {}),
    ...(typeof t.beforeMessageCount === "number" ? { beforeMessageCount: t.beforeMessageCount } : {}),
    ...(typeof t.afterMessageCount === "number" ? { afterMessageCount: t.afterMessageCount } : {}),
    ...(typeof t.path === "string" ? { path: t.path } : {}),
    kept,
    dropped,
    ...(typeof t.reReadHint === "string" ? { reReadHint: t.reReadHint } : {}),
  };
}

function ContextTransitionDetail({ transition }: { transition: ContextTransitionView }) {
  const kindLabel = transition.kind === "chapter_boundary"
    ? "章节切换"
    : transition.kind === "scene_boundary"
      ? "场次切换"
      : transition.kind === "open_turn"
        ? "本轮开场"
        : "上下文变化";
  const saved = transition.beforeTokens != null && transition.afterTokens != null
    ? Math.max(0, transition.beforeTokens - transition.afterTokens)
    : undefined;
  return (
    <div className="context-transition-detail">
      <h4>装载对照 · {kindLabel}</h4>
      {transition.atStep != null ? (
        <p className="context-transition-step">
          发生在 Step {transition.atStep} 结束时
          {transition.path ? ` · ${transition.path}` : ""}
          {" → 下一步只携带收束后的上下文"}
        </p>
      ) : null}
      {transition.beforeTokens != null && transition.afterTokens != null ? (
        <div className="context-transition-bar" aria-hidden="true">
          <div className="context-transition-bar-before" title={`收束前 ${transition.beforeTokens.toLocaleString()}`}>
            <span>前 {formatGraphTokens(transition.beforeTokens)}</span>
          </div>
          <div
            className="context-transition-bar-after"
            style={{
              width: `${Math.max(12, Math.min(100, (transition.afterTokens / Math.max(1, transition.beforeTokens)) * 100))}%`,
            }}
            title={`收束后 ${transition.afterTokens.toLocaleString()}`}
          >
            <span>后 {formatGraphTokens(transition.afterTokens)}</span>
          </div>
          {saved != null && saved > 0 ? (
            <em className="context-transition-saved">省 {formatGraphTokens(saved)}</em>
          ) : null}
        </div>
      ) : null}
      {transition.kept.length ? (
        <div className="context-transition-col keep">
          <strong>继续携带</strong>
          <ul>
            {transition.kept.map((item) => (
              <li key={item.id}>
                <span>{humanizeContextCopy(item.label)}</span>
                {item.detail ? <small>{humanizeContextCopy(item.detail)}</small> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {transition.dropped.length ? (
        <div className="context-transition-col drop">
          <strong>卸下不带</strong>
          <ul>
            {transition.dropped.map((item) => (
              <li key={item.id}>
                <span>{humanizeContextCopy(item.label)}</span>
                {item.detail ? <small>{humanizeContextCopy(item.detail)}</small> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {transition.reReadHint ? (
        <p className="context-transition-reread">
          <strong>之后仍会读文件？</strong>
          {humanizeContextCopy(transition.reReadHint)}
        </p>
      ) : null}
    </div>
  );
}

function treeChildEdgeLabel(item: ContextGraphTreeItem): string {
  if (item.node.kind === "epoch") return "任务";
  if (item.node.kind === "handoff" || item.node.kind === "artifact") return "产出";
  if (item.node.kind === "assemble_slice") return "装载";
  return "子节点";
}

/**
 * Flatten nested turn chain into sibling turns under the root for left→right layout.
 * Process leaves stay attached to their turn.
 */
function flattenContextGraphTurns(tree: ContextGraphTreeItem): Array<{
  turn: ContextGraphTreeItem;
  leaves: ContextGraphTreeItem[];
}> {
  const bands: Array<{ turn: ContextGraphTreeItem; leaves: ContextGraphTreeItem[] }> = [];
  let cursor: ContextGraphTreeItem | undefined = tree.role === "root"
    ? tree.children.find((child) => child.role === "turn")
    : tree.role === "turn"
      ? tree
      : undefined;
  while (cursor) {
    const leaves = cursor.children.filter((child) => child.role !== "turn");
    const next = cursor.children.find((child) => child.role === "turn");
    bands.push({ turn: cursor, leaves });
    cursor = next;
  }
  return bands;
}

type ContextGraphMeasure = {
  item: ContextGraphTreeItem;
  height: number;
  children: ContextGraphMeasure[];
};

/**
 * Left→right tidy tree (参考：父节点在左，子节点在右同列纵向平铺，竖轨连接).
 *
 *   [root]──┬──[turn1]──┬── process
 *           │           └── process
 *           ├──[turn2]── process
 *           └──[turn3]──┬── process
 *                       └── process
 *
 * Turns are siblings under root so the graph grows sideways, not a diagonal staircase.
 */
function layoutContextGraphNodes(nodes: ContextGraphNode[]): ContextGraphLayout {
  const nodeW = 176;
  const colGap = 56; // horizontal gap between parent column and child column
  const vGap = 12;   // vertical gap between sibling cards
  const padX = 20;
  const padTop = 16;
  const padBottom = 20;
  const padRight = 20;

  const tree = buildContextGraphTree(nodes);
  const placed: ContextGraphLayoutNode[] = [];
  const treeLinks: ContextGraphTreeLink[] = [];
  if (!tree) {
    return { placed: [], width: 520, height: 200, nodeW, nodeHeights: [], treeLinks };
  }

  // Display tree: root → turns (siblings) → process leaves
  const turns = flattenContextGraphTurns(tree);
  const displayRoot: ContextGraphTreeItem = {
    node: tree.node,
    role: "root",
    children: turns.map(({ turn, leaves }) => ({
      node: turn.node,
      role: "turn" as const,
      children: leaves,
    })),
  };

  const measure = (item: ContextGraphTreeItem): ContextGraphMeasure => {
    const selfH = contextGraphNodeHeight(item.node);
    if (!item.children.length) {
      return { item, height: selfH, children: [] };
    }
    const childMeasures = item.children.map(measure);
    const childrenH = childMeasures.reduce((sum, child, index) => (
      sum + child.height + (index > 0 ? vGap : 0)
    ), 0);
    return {
      item,
      height: Math.max(selfH, childrenH),
      children: childMeasures,
    };
  };

  const measured = measure(displayRoot);

  const place = (m: ContextGraphMeasure, depth: number, x: number, yTop: number): void => {
    const selfH = contextGraphNodeHeight(m.item.node);
    // Parent vertically centered against the whole child block (or just itself).
    const y = yTop + Math.max(0, (m.height - selfH) / 2);
    placed.push({
      ...m.item.node,
      x,
      y,
      w: nodeW,
      h: selfH,
      depth,
      treeRole: m.item.role,
    });

    if (!m.children.length) return;
    const childX = x + nodeW + colGap;
    let childY = yTop;
    // If children block is shorter than parent, center the block under parent.
    const childrenH = m.children.reduce((sum, child, index) => (
      sum + child.height + (index > 0 ? vGap : 0)
    ), 0);
    if (childrenH < m.height) {
      childY = yTop + (m.height - childrenH) / 2;
    }
    for (const child of m.children) {
      place(child, depth + 1, childX, childY);
      childY += child.height + vGap;
    }
  };

  place(measured, 0, padX, padTop);

  const link = (
    fromId: string,
    toId: string,
    kind: ContextGraphTreeLink["kind"],
    label: string,
  ) => {
    treeLinks.push({
      id: `tree-${fromId}-${toId}`,
      fromId,
      toId,
      kind,
      label,
    });
  };

  // Root → each turn; turn → process leaves; consecutive turns "下一轮"
  for (const turnItem of displayRoot.children) {
    link(
      displayRoot.node.id,
      turnItem.node.id,
      "tree_child",
      "轮次",
    );
    for (const leaf of turnItem.children) {
      link(turnItem.node.id, leaf.node.id, "tree_child", treeChildEdgeLabel(leaf));
    }
  }
  for (let index = 0; index < displayRoot.children.length - 1; index += 1) {
    const a = displayRoot.children[index]!;
    const b = displayRoot.children[index + 1]!;
    link(a.node.id, b.node.id, "tree_next", "下一轮");
  }

  const seen = new Set<string>();
  const unique = placed.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });

  const maxX = unique.reduce((m, node) => Math.max(m, node.x + node.w), padX + nodeW);
  const maxY = unique.reduce((m, node) => Math.max(m, node.y + node.h), padTop + CONTEXT_GRAPH_NODE_H);

  return {
    placed: unique,
    width: Math.max(480, maxX + padRight),
    height: Math.max(180, maxY + padBottom),
    nodeW,
    nodeHeights: [...new Set(unique.map((node) => node.h))],
    treeLinks,
  };
}

/**
 * Parent→child elbow with a vertical bus in the column gutter
 * (matches the left-parent / right-stacked-children diagram).
 * Same-column links (e.g. 下一轮 between sibling turns) use a short side rail.
 */
function treeEdgeRoute(from: ContextGraphLayoutNode, to: ContextGraphLayoutNode): {
  d: string;
  labelX: number;
  labelY: number;
} {
  const tip = 6;
  const fromCy = from.y + from.h / 2;
  const toCy = to.y + to.h / 2;
  const sameColumn = Math.abs(to.x - from.x) < 8;

  // Sibling stack in one column (turn → next turn): rail on the left gutter.
  if (sameColumn) {
    const goingDown = to.y >= from.y;
    const startY = goingDown ? from.y + from.h : from.y;
    const endY = goingDown ? to.y - tip : to.y + to.h + tip;
    const railX = from.x - 14;
    return {
      d: `M ${from.x} ${startY} L ${railX} ${startY} L ${railX} ${endY} L ${to.x} ${endY}`,
      labelX: railX - 2,
      labelY: (startY + endY) / 2,
    };
  }

  const goingRight = to.x > from.x;
  const startX = goingRight ? from.x + from.w : from.x;
  const endX = goingRight ? to.x - tip : to.x + to.w + tip;
  const busX = goingRight
    ? from.x + from.w + Math.max(16, (to.x - (from.x + from.w)) * 0.45)
    : from.x - Math.max(16, (from.x - (to.x + to.w)) * 0.45);

  // Same row: straight horizontal.
  if (Math.abs(toCy - fromCy) < 1.5) {
    return {
      d: `M ${startX} ${fromCy} L ${endX} ${toCy}`,
      labelX: (startX + endX) / 2,
      labelY: fromCy - 10,
    };
  }

  // Bracket: out from parent mid → vertical bus → into child mid-left/right.
  return {
    d: `M ${startX} ${fromCy} L ${busX} ${fromCy} L ${busX} ${toCy} L ${endX} ${toCy}`,
    labelX: busX,
    labelY: (fromCy + toCy) / 2,
  };
}

function ContextGraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // Layout uses only the filtered `nodes`; tree structure is rebuilt from them.
  const layout = React.useMemo(() => layoutContextGraphNodes(nodes), [nodes]);
  const pos = React.useMemo(() => {
    const map = new Map<string, ContextGraphLayoutNode>();
    for (const node of layout.placed) map.set(node.id, node);
    return map;
  }, [layout.placed]);

  const relatedIds = React.useMemo(() => {
    if (!selectedId) return new Set<string>();
    const set = new Set<string>([selectedId]);
    // Walk tree links both ways so selecting a turn highlights its process + next turn.
    let grew = true;
    while (grew) {
      grew = false;
      for (const link of layout.treeLinks) {
        if (set.has(link.fromId) && !set.has(link.toId)) {
          set.add(link.toId);
          grew = true;
        }
        if (set.has(link.toId) && !set.has(link.fromId)) {
          set.add(link.fromId);
          grew = true;
        }
      }
    }
    return set;
  }, [selectedId, layout.treeLinks]);

  /** Handoffs a later delivery of the same chapter retired. */
  const supersededIds = React.useMemo(() => {
    const set = new Set<string>();
    for (const edge of edges) if (edge.kind === "supersedes") set.add(edge.toId);
    return set;
  }, [edges]);

  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [viewport, setViewport] = React.useState({ scale: 1, tx: 0, ty: 0 });
  const dragRef = React.useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [panning, setPanning] = React.useState(false);

  const toUserSpace = React.useCallback((event: { clientX: number; clientY: number }) => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }, []);

  const zoomAround = React.useCallback((factor: number, anchor: { x: number; y: number } | null) => {
    setViewport((current) => {
      const scale = Math.min(2.4, Math.max(0.4, current.scale * factor));
      if (Math.abs(scale - current.scale) < 1e-4) return current;
      const point = anchor ?? { x: current.tx, y: current.ty };
      const cx = (point.x - current.tx) / current.scale;
      const cy = (point.y - current.ty) / current.scale;
      return { scale, tx: point.x - cx * scale, ty: point.y - cy * scale };
    });
  }, []);

  React.useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAround(Math.exp(-event.deltaY * 0.0016), toUserSpace(event));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAround, toUserSpace, nodes.length]);

  if (!nodes.length) {
    return (
      <div className="context-graph-canvas empty">
        <div className="context-graph-empty-card">
          <GitBranch size={22} aria-hidden="true" />
          <strong>暂无上下文节点</strong>
          <span>跑一轮写作任务后，这里会展示会话树：共享基础 → 各轮消息 → 任务与衔接。</span>
        </div>
      </div>
    );
  }

  const svgHeight = Math.min(560, Math.max(220, layout.height + 4));

  return (
    <div className="context-graph-canvas" role="img" aria-label="上下文会话树">
      <div className="context-graph-legend" aria-hidden="true">
        {(["project_note", "message", "epoch", "handoff", "assemble_slice"] as const).map((kind) => (
          <span key={kind} className={`context-graph-legend-item kind-${kind}`}>
            <i />
            {CONTEXT_GRAPH_KIND_LABEL[kind]}
          </span>
        ))}
        <span className="context-graph-legend-sep" />
        <span className="context-graph-legend-item edge-replays"><i />下一轮 · 续写</span>
        <span className="context-graph-legend-item status-archived"><i />归档</span>
        <span className="context-graph-legend-hint">
          左右平铺 · 父在左 · 子在右纵向排列
        </span>
      </div>
      <div className="context-graph-viewport-controls">
        <button type="button" onClick={() => zoomAround(1 / 1.2, null)} aria-label="缩小" title="缩小">−</button>
        <button type="button" onClick={() => setViewport({ scale: 1, tx: 0, ty: 0 })} title="适应画布">适应</button>
        <button type="button" onClick={() => zoomAround(1.2, null)} aria-label="放大" title="放大">＋</button>
        <span className="context-graph-viewport-readout">{Math.round(viewport.scale * 100)}% · {layout.placed.length} 节点</span>
      </div>
      <svg
        ref={svgRef}
        className={panning ? "panning" : ""}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width="100%"
        height={svgHeight}
        preserveAspectRatio="xMinYMin meet"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const point = toUserSpace(event);
          if (!point) return;
          dragRef.current = { x: point.x, y: point.y, tx: viewport.tx, ty: viewport.ty };
          setPanning(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          const point = toUserSpace(event);
          if (!point) return;
          setViewport((current) => ({ ...current, tx: drag.tx + (point.x - drag.x), ty: drag.ty + (point.y - drag.y) }));
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          setPanning(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { dragRef.current = null; setPanning(false); }}
      >
        <defs>
          <filter id="ctx-node-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="2.4" floodOpacity="0.16" />
          </filter>
          {layout.nodeHeights.map((height) => (
            <clipPath key={height} id={`ctx-node-clip-${height}`}>
              <rect x="0" y="0" width={layout.nodeW} height={height} rx="12" ry="12" />
            </clipPath>
          ))}
          {/* userSpaceOnUse keeps arrow size stable regardless of stroke width */}
          <marker id="ctx-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0.5 L9,4.5 L0,8.5 Z" className="context-graph-arrow" />
          </marker>
          <marker id="ctx-arrow-active" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0.5 L9,4.5 L0,8.5 Z" className="context-graph-arrow active" />
          </marker>
          <marker id="ctx-arrow-next" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0.5 L9,4.5 L0,8.5 Z" className="context-graph-arrow next" />
          </marker>
        </defs>

        <g transform={`translate(${viewport.tx}, ${viewport.ty}) scale(${viewport.scale})`}>
        {/* Edges under cards (paths only). Labels are painted after nodes so chips never sit under cards. */}
        {layout.treeLinks.map((link) => {
          const from = pos.get(link.fromId);
          const to = pos.get(link.toId);
          if (!from || !to) return null;
          const route = treeEdgeRoute(from, to);
          const isNext = link.kind === "tree_next";
          const edgeActive = Boolean(selectedId && (link.fromId === selectedId || link.toId === selectedId));
          const inCluster = Boolean(selectedId && relatedIds.has(link.fromId) && relatedIds.has(link.toId));
          const lit = edgeActive || (inCluster && isNext) || (!selectedId && isNext);
          return (
            <g
              key={`path-${link.id}`}
              className={`context-graph-edge-g${lit ? " active" : selectedId && !edgeActive ? " dim" : ""}${isNext ? " replays" : ""}`}
              pointerEvents="none"
            >
              <path
                d={route.d}
                className={`context-graph-edge-line kind-${link.kind}${lit ? " active" : ""}`}
                markerEnd={isNext ? "url(#ctx-arrow-next)" : lit ? "url(#ctx-arrow-active)" : "url(#ctx-arrow)"}
              />
            </g>
          );
        })}

        {layout.placed.map((node) => {
          const selected = node.id === selectedId;
          const related = relatedIds.has(node.id);
          const dim = Boolean(selectedId && !related);
          const kindLabel = node.treeRole === "root"
            ? "会话根"
            : node.treeRole === "turn"
              ? "轮次"
              : (CONTEXT_GRAPH_KIND_LABEL[node.kind] ?? node.kind);
          const title = contextGraphNodeTitle(node);
          const meta = contextGraphNodeMeta(node);
          const metric = contextGraphNodeMetric(node);
          const superseded = supersededIds.has(node.id);
          const pillText = superseded ? "已被取代" : "归档";
          const pillW = Math.max(30, graphLabelUnits(pillText) * 5.4 + 10);
          const barX = 12;
          const barW = node.w - 24;
          const barY = node.h - 10;
          const replayTurns = node.kind === "assemble_slice" ? assembleReplayTurns(node) : undefined;
          return (
            <g
              key={node.id}
              className={`context-graph-svg-node kind-${node.kind} role-${node.treeRole} status-${node.status}${superseded ? " superseded" : ""}${selected ? " selected" : ""}${related && !selected ? " related" : ""}${dim ? " dim" : ""}`}
              transform={`translate(${node.x}, ${node.y})`}
              onClick={() => onSelect(node.id)}
              style={{ cursor: "pointer" }}
            >
              <title>{`${kindLabel}: ${node.label}`}</title>
              <rect width={node.w} height={node.h} rx={10} ry={10} className="context-graph-svg-card" filter="url(#ctx-node-shadow)" />
              <g clipPath={`url(#ctx-node-clip-${node.h})`}>
                <rect x={0} y={0} width={3} height={node.h} className="context-graph-svg-accent" />
                <text x={12} y={18} className="context-graph-svg-kind">{kindLabel}</text>
                {node.status === "archived" ? (
                  <g transform={`translate(${node.w - pillW - 10}, 8)`}>
                    <rect width={pillW} height={12} rx={6} className="context-graph-status-pill" />
                    <text x={pillW / 2} y={9} textAnchor="middle" className="context-graph-status-pill-text">{pillText}</text>
                  </g>
                ) : null}
                <text x={12} y={36} className="context-graph-svg-label">{title}</text>
                <text x={12} y={50} className="context-graph-svg-meta">
                  {meta}{replayTurns != null && replayTurns > 0 ? ` · 历史 ${replayTurns} 轮` : ""}
                </text>
                {metric?.kind === "layers" ? (
                  <>
                    <text x={12} y={63} className="context-graph-svg-metric">
                      {`共 ${formatGraphTokens(metric.total)}`}
                    </text>
                    {(() => {
                      let offset = 0;
                      return metric.segments.map((segment) => {
                        const width = Math.max(2, (segment.tokens / metric.total) * barW);
                        const x = barX + offset;
                        offset += width;
                        return (
                          <rect
                            key={`${segment.layer}-${segment.label}`}
                            x={x}
                            y={barY}
                            width={Math.min(width, barX + barW - x)}
                            height={6}
                            className={`context-graph-layer-seg layer-${segment.layer}`}
                          >
                            <title>{`${CONTEXT_GRAPH_LAYER_LABEL[segment.layer] ?? segment.layer} · ${formatGraphTokens(segment.tokens)} tok`}</title>
                          </rect>
                        );
                      });
                    })()}
                  </>
                ) : null}
                {metric?.kind === "cache" ? (
                  <>
                    <text x={12} y={63} className="context-graph-svg-metric">
                      {[
                        metric.frozenTokens != null ? `冻结 ${formatGraphTokens(metric.frozenTokens)}` : null,
                        metric.hitRate != null ? `命中 ${Math.round(metric.hitRate * 100)}%` : "命中 未实测",
                      ].filter(Boolean).join(" · ")}
                    </text>
                    <rect x={barX} y={barY} width={barW} height={6} rx={3} className="context-graph-hit-track" />
                    {metric.hitRate != null ? (
                      <rect
                        x={barX}
                        y={barY}
                        width={Math.max(2, Math.min(1, metric.hitRate) * barW)}
                        height={6}
                        rx={3}
                        className="context-graph-hit-fill"
                      >
                        <title>{`缓存命中 ${Math.round(metric.hitRate * 100)}%${metric.promptTokens ? ` · 输入 ${formatGraphTokens(metric.promptTokens)}` : ""}`}</title>
                      </rect>
                    ) : null}
                  </>
                ) : null}
              </g>
            </g>
          );
        })}

        {/* Edge chips above cards, anchored in the depth gutter (never under a node face). */}
        {layout.treeLinks.map((link) => {
          const from = pos.get(link.fromId);
          const to = pos.get(link.toId);
          if (!from || !to) return null;
          const isNext = link.kind === "tree_next";
          const edgeActive = Boolean(selectedId && (link.fromId === selectedId || link.toId === selectedId));
          // Default: only annotate turn-chain links. Child edges stay quiet unless that edge is selected.
          if (!isNext && !edgeActive) return null;
          const route = treeEdgeRoute(from, to);
          const childEpochHit = isNext
            ? (() => {
                const turnNode = pos.get(link.toId);
                if (!turnNode) return undefined;
                for (const node of layout.placed) {
                  if (node.kind !== "epoch") continue;
                  if (node.sourceMessageId != null && turnNode.sourceMessageId === node.sourceMessageId) {
                    return epochHitRate(node);
                  }
                }
                return undefined;
              })()
            : undefined;
          const label = isNext && childEpochHit != null
            ? `下一轮 ${Math.round(childEpochHit * 100)}%`
            : link.label;
          // Keep chips narrow so they fit inside depthGap.
          const labelW = Math.min(76, Math.max(28, graphLabelUnits(label) * 5.6 + 12));
          return (
            <g
              key={`label-${link.id}`}
              className={`context-graph-edge-g${isNext ? " replays" : ""}${edgeActive ? " active" : ""}`}
              pointerEvents="none"
            >
              <rect
                x={route.labelX - labelW / 2}
                y={route.labelY - 8}
                width={labelW}
                height={15}
                rx={7}
                className={`context-graph-edge-chip${isNext || edgeActive ? " active" : ""}${isNext ? " replays" : ""}`}
              />
              <text
                x={route.labelX}
                y={route.labelY + 3}
                textAnchor="middle"
                className={`context-graph-edge-label${isNext || edgeActive ? " active" : ""}`}
              >
                {label}
              </text>
            </g>
          );
        })}
        </g>
      </svg>
    </div>
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

function mergeStepCallUsage(current: StepUsage | undefined, next: StepUsage, callKind = "unspecified"): StepUsage {
  const nextCalls: StepUsageCall[] = next.callBreakdown?.length
    ? next.callBreakdown
    : [{
        model: next.model,
        providerName: next.providerName,
        callKind,
        promptTokens: next.promptTokens,
        completionTokens: next.completionTokens,
        cacheHitTokens: next.cacheHitTokens,
        cacheMissTokens: next.cacheMissTokens,
        cost: next.cost,
        currency: next.currency,
        ...(next.estimated ? { estimated: true } : {}),
      }];
  if (!current) return { ...next, callBreakdown: nextCalls };
  const cacheHitTokens = current.cacheHitTokens + next.cacheHitTokens;
  const cacheMissTokens = current.cacheMissTokens + next.cacheMissTokens;
  const estimated = Boolean(current.estimated || next.estimated);
  const models = [...new Set(
    [...(current.callBreakdown ?? []).map(call => call.model), ...nextCalls.map(call => call.model), current.model, next.model]
      .filter((value): value is string => Boolean(value) && value !== "多个模型"),
  )];
  const providers = [...new Set(
    [...(current.callBreakdown ?? []).map(call => call.providerName), ...nextCalls.map(call => call.providerName), current.providerName, next.providerName]
      .filter((value): value is string => Boolean(value?.trim())),
  )];
  return {
    model: models.length <= 1 ? (models[0] ?? current.model ?? next.model) : "多个模型",
    ...(providers.length
      ? { providerName: providers.length === 1 ? providers[0] : providers.join(",") }
      : {}),
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
    callBreakdown: [...(current.callBreakdown ?? []), ...nextCalls],
  };
}

function App() {
  const [state, setState] = useState<State>();
  const [activePath, setActivePath] = useState("");
  const [document, setDocument] = useState<DocumentData>({ content: "", hash: "" });
  const [documentDraft, setDocumentDraft] = useState("");
  const [editingDocument, setEditingDocument] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  /**
   * Live step buffer for the *current* Agent job only.
   * Completed / historical trails render from `state.stepTrails` (server truth).
   * Never rehydrate an older turn into this buffer — that made a new message
   * briefly (or permanently until reload) show the previous turn's steps.
   */
  const [streamSteps, setStreamSteps] = useState<StreamStep[]>([]);
  /** User message id the live streamSteps belong to (temp negative id until source_message). */
  const [streamStepsAnchorId, setStreamStepsAnchorId] = useState<number | null>(null);
  /** Expand toggles for server-backed trails (key = `${messageId}:${stepId}`). */
  const [stepTrailExpanded, setStepTrailExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [conversationAtBottom, setConversationAtBottom] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileTab, setMobileTab] = useState<"docs" | "editor" | "agent">("editor");
  const [reviewOpen, setReviewOpen] = useState(false);
  const prevPendingReviewRef = useRef(0);
  const [theme, setTheme] = useState<UiThemeId>(() => loadUiTheme());
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleDraft, setStyleDraft] = useState<StyleTemplateDraft | null>(null);
  const [proseGateDraft, setProseGateDraft] = useState<ProseGateRuleDraft | null>(null);
  const [proseGateBusy, setProseGateBusy] = useState(false);
  const [continuityFactDraft, setContinuityFactDraft] = useState<ContinuityFactDraft | null>(null);
  const [continuityFactBusy, setContinuityFactBusy] = useState(false);
  const [managementView, setManagementView] = useState<ManagementView | null>(null);
  const [contextGraph, setContextGraph] = useState<ContextGraphView | null>(null);
  const [contextGraphLoading, setContextGraphLoading] = useState(false);
  const [contextGraphSelectedId, setContextGraphSelectedId] = useState<string | null>(null);
  const [contextGraphFilter, setContextGraphFilter] = useState<"all" | "active" | "handoff" | "epoch" | "slice">("all");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("models");
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [headerMoreOpen, setHeaderMoreOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(loadWorkspaceMode);
  const [documentsCollapsed, setDocumentsCollapsed] = useState(() =>
    localStorage.getItem("writer-documents-collapsed") === "true",
  );
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
    inputMode?: RoleplayInputMode;
    rerunDirections: RoleplayRerunDirection[];
    rerunControls: RoleplayRerunControls;
    perceptionOverride?: RoleplayPerceptionProjection;
  } | null>(null);
  const [roleplayBranchTimeline, setRoleplayBranchTimeline] = useState<{
    message: Message;
    branches: RoleplayBranchSummary[];
  } | null>(null);
  const [roleplayBranchBusy, setRoleplayBranchBusy] = useState(false);
  const [agentHiddenCharacterCards, setAgentHiddenCharacterCards] = useState<Set<string>>(loadAgentHiddenCharacterCards);
  const [characterDraft, setCharacterDraft] = useState<CharacterDraft | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("writer-expanded-folders") || "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const [documentSidebarMode, setDocumentSidebarMode] = useState<DocumentSidebarMode>(() =>
    localStorage.getItem("writer-document-sidebar-mode") === "files" ? "files" : "chapters",
  );
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [movingChapter, setMovingChapter] = useState<ChapterSummary | null>(null);
  const [moveChapterTarget, setMoveChapterTarget] = useState("");
  const [collapsedChapterVolumes, setCollapsedChapterVolumes] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("writer-collapsed-chapter-volumes") || "[]") as string[]);
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
  const [readingProgress, setReadingProgress] = useState(0);
  const [readerSelection, setReaderSelection] = useState<ReaderTextSelection | null>(null);
  const [documentContextSelections, setDocumentContextSelections] = useState<DocumentContextSelection[]>([]);
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
  const [roleplaySceneGenerateRequest, setRoleplaySceneGenerateRequest] = useState("");
  const [roleplaySceneGenerateBusy, setRoleplaySceneGenerateBusy] = useState(false);
  const [roleplaySceneManagerOpen, setRoleplaySceneManagerOpen] = useState(false);
  const [roleplaySceneManagerBusy, setRoleplaySceneManagerBusy] = useState(false);
  const [roleplayMemoryOpen, setRoleplayMemoryOpen] = useState(false);
  const [roleplayFactDraft, setRoleplayFactDraft] = useState<RoleplayFactDraft | null>(null);
  const [roleplayInputMode, setRoleplayInputMode] = useState<RoleplayInputMode>("dialogue");
  const [directorSuggestions, setDirectorSuggestions] = useState<string[]>([]);
  const [directorSuggestionBusy, setDirectorSuggestionBusy] = useState(false);
  const [directorSuggestionError, setDirectorSuggestionError] = useState("");
  const [roleplayAutoReplyBusy, setRoleplayAutoReplyBusy] = useState<"performer" | "identity" | null>(null);
  const [roleplaySetupBusy, setRoleplaySetupBusy] = useState(false);
  const [roleplaySetupPhase, setRoleplaySetupPhase] = useState<RoleplaySetupPhase | null>(null);
  const [roleplaySetupElapsed, setRoleplaySetupElapsed] = useState(0);
  const [todosCollapsed, setTodosCollapsed] = useState(false);
  /** Collapsed final Assistant bubbles (steps already have their own expand state). */
  const [collapsedAssistantIds, setCollapsedAssistantIds] = useState<Set<number>>(() => new Set());
  const [resizing, setResizing] = useState<"sidebar" | "agent" | null>(null);
  const [connection, setConnection] = useState<ConnectionInfo>(() => getConnectionInfo());
  const [connectionProbeResults, setConnectionProbeResults] = useState<ConnectionProbeResults | null>(null);
  const [showUsagePopover, setShowUsagePopover] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionPanelMsg, setConnectionPanelMsg] = useState("");
  const abortRef = useRef<AbortController | undefined>(undefined);
  const currentJobRef = useRef<string | undefined>(undefined);
  const streamOutputRef = useRef("");
  const streamStepsRef = useRef<StreamStep[]>([]);
  const streamStepsAnchorIdRef = useRef<number | null>(null);
  const streamStepsRafRef = useRef<number | null>(null);
  const refreshSeqRef = useRef(0);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const todosCompletionRef = useRef({ sessionId: "", complete: false });
  const activePathRef = useRef(activePath);
  const editingDocumentRef = useRef(editingDocument);
  activePathRef.current = activePath;
  editingDocumentRef.current = editingDocument;
  /** Apply step updates immediately to the ref; coalesce React renders to one per frame. */
  const updateStreamSteps = useCallback((update: React.SetStateAction<StreamStep[]>) => {
    const current = streamStepsRef.current;
    const next = typeof update === "function" ? update(current) : update;
    streamStepsRef.current = next;
    if (streamStepsRafRef.current != null) return;
    streamStepsRafRef.current = window.requestAnimationFrame(() => {
      streamStepsRafRef.current = null;
      setStreamSteps(streamStepsRef.current);
    });
  }, []);
  const flushStreamStepsNow = useCallback(() => {
    if (streamStepsRafRef.current != null) {
      window.cancelAnimationFrame(streamStepsRafRef.current);
      streamStepsRafRef.current = null;
    }
    setStreamSteps(streamStepsRef.current);
  }, []);
  const updateStreamStepsAnchorId = useCallback((messageId: number | null) => {
    streamStepsAnchorIdRef.current = messageId;
    setStreamStepsAnchorId(messageId);
  }, []);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const fileSearchRef = useRef<HTMLInputElement>(null);
  const documentReaderRef = useRef<HTMLDivElement>(null);
  const documentEditorRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const readingProgressTimerRef = useRef<number | undefined>(undefined);
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
  useEffect(() => {
    setDocumentContextSelections([]);
    setReaderSelection(null);
  }, [state?.sessionId]);

  const headings = useMemo(() => markdownHeadings(document.content, "document"), [document.content]);
  const visibleDocumentWordCount = useMemo(
    () => documentWordCount(editingDocument ? documentDraft : browsingVersion?.afterContent ?? document.content),
    [browsingVersion?.afterContent, document.content, documentDraft, editingDocument],
  );

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
    if (streamStepsRafRef.current != null) {
      window.cancelAnimationFrame(streamStepsRafRef.current);
      streamStepsRafRef.current = null;
    }
    streamStepsRef.current = [];
    setStreamSteps([]);
    updateStreamStepsAnchorId(null);
    streamOutputRef.current = "";
  }, [updateStreamStepsAnchorId]);

  /**
   * Merge a server conversation page with local UI state.
   * - Keep paginated older messages that the latest page no longer includes.
   * - Keep optimistic (negative-id) bubbles while a job is live so a mid-run
   *   workspace refresh cannot blank the chat after re-run/edit rewind.
   * - Prefer server rows for positive ids (variant metadata, perception, etc.).
   */
  const mergeConversationMessages = useCallback((local: Message[], remote: Message[], liveJob: boolean): Message[] => {
    const optimistic = local.filter((message) => message.id < 0);
    if (remote.length === 0) {
      // Re-run/edit deletes the turn before the new user row is written; a refresh
      // in that window must not wipe the optimistic bubble (and leave the pane empty).
      if (liveJob && local.length > 0) return local;
      // Intentional empty server page (e.g. edit-rewind of the first turn).
      return optimistic.length && liveJob ? optimistic : remote;
    }
    const remoteById = new Map(remote.map((message) => [message.id, message]));
    const remoteMinPositive = remote.reduce((min, message) => (
      message.id > 0 && message.id < min ? message.id : min
    ), Number.POSITIVE_INFINITY);
    const olderLocal = local.filter((message) => (
      message.id > 0
      && !remoteById.has(message.id)
      && message.id < remoteMinPositive
    ));
    // Drop local positive ids that are missing from the remote page but are not
    // older-than-page history — they were deleted by rewind/re-run.
    const merged = [...olderLocal, ...remote];
    if (!liveJob || !optimistic.length) return merged;
    const remoteHasSameTurn = (candidate: Message) => remote.some((message) => (
      message.role === candidate.role
      && message.channel === candidate.channel
      && message.content === candidate.content
    ));
    for (const message of optimistic) {
      if (!remoteHasSameTurn(message)) merged.push(message);
    }
    return merged;
  }, []);

  /**
   * Align a temporary (negative) live anchor to the real user message id after
   * the server has written the turn. Never re-point a live buffer at an older
   * completed turn — that is how previous-round steps appeared under a new message.
   */
  const reconcileStreamStepsAnchor = useCallback((messages: Message[]) => {
    if (!streamStepsRef.current.length) return;
    const anchor = streamStepsAnchorIdRef.current;
    if (anchor != null && anchor > 0 && messages.some((message) => message.id === anchor)) return;
    // Only upgrade optimistic anchors. If the anchor is already a real id that
    // disappeared (rewind), clear the live buffer instead of grafting it onto lastUser.
    if (anchor != null && anchor > 0) {
      if (streamStepsRafRef.current != null) {
        window.cancelAnimationFrame(streamStepsRafRef.current);
        streamStepsRafRef.current = null;
      }
      streamStepsRef.current = [];
      setStreamSteps([]);
      updateStreamStepsAnchorId(null);
      return;
    }
    if (anchor == null || anchor >= 0) return;
    // Match optimistic bubble content when possible; otherwise newest user row.
    const optimistic = messages.find((message) => message.id === anchor);
    const lastUser = [...messages].reverse().find((message) => (
      message.role === "user" && message.id > 0 && message.content.trim()
      && (!optimistic || message.content === optimistic.content)
    )) ?? [...messages].reverse().find((message) => (
      message.role === "user" && message.id > 0 && message.content.trim()
    ));
    if (lastUser) updateStreamStepsAnchorId(lastUser.id);
  }, [updateStreamStepsAnchorId]);

  const refresh = useCallback(
    async (targetSession?: string) => {
      const seq = ++refreshSeqRef.current;
      // Prefer explicit switch → current live session → last visited in this browser.
      const requestedSession = targetSession ?? sessionIdRef.current ?? readLastSessionId();
      const next = await api<State>(
        `/api/state${requestedSession ? `?session=${encodeURIComponent(requestedSession)}` : ""}`,
      );
      // Drop stale responses so an older in-flight refresh (e.g. snapshot taken in the
      // re-run rewind gap) cannot overwrite a newer complete conversation.
      if (seq !== refreshSeqRef.current) return next;
      if (requestedSession && next.sessionId !== requestedSession && sessionIdRef.current === requestedSession) {
        return next;
      }
      rememberLastSessionId(next.sessionId);
      let appliedMessages = next.messages;
      setState((current) => {
        if (seq !== refreshSeqRef.current) return current ?? next;
        if (!current || current.sessionId !== next.sessionId) {
          appliedMessages = next.messages;
          return next;
        }
        const liveJob = Boolean(currentJobRef.current)
          || Boolean(next.activeJobs?.some((job) => job.sessionId === next.sessionId));
        const messages = mergeConversationMessages(current.messages, next.messages, liveJob);
        appliedMessages = messages;
        // If we already paged in older history, keep hasMore consistent with the merge.
        const messagesHasMore = next.messagesHasMore
          || messages.some((message) => message.id > 0 && !next.messages.some((remote) => remote.id === message.id));
        const fromServer = next.activeJobs ?? [];
        const activeJobs = liveJob && currentJobRef.current && !fromServer.some((job) => job.id === currentJobRef.current)
          ? (() => {
              const localJob = (current.activeJobs ?? []).find((job) => job.id === currentJobRef.current);
              return localJob
                ? [...fromServer.filter((job) => job.sessionId !== localJob.sessionId), localJob]
                : fromServer;
            })()
          : next.activeJobs;
        return { ...next, messages, messagesHasMore, activeJobs };
      });
      if (seq === refreshSeqRef.current) {
        // Live buffer only: upgrade temp anchors. History is rendered from next.stepTrails.
        if (currentJobRef.current && streamStepsRef.current.length) {
          reconcileStreamStepsAnchor(appliedMessages);
        } else if (!currentJobRef.current && streamStepsRef.current.length) {
          // Job finished: if the server already has *this* turn's trail, drop the live
          // buffer so a subsequent new message cannot inherit it via re-anchor.
          const anchor = streamStepsAnchorIdRef.current;
          const serverHasThisTurn = anchor != null && anchor > 0
            && Boolean(next.stepTrails?.some((trail) => trail.sourceMessageId === anchor && trail.steps.length > 0));
          if (serverHasThisTurn) {
            if (streamStepsRafRef.current != null) {
              window.cancelAnimationFrame(streamStepsRafRef.current);
              streamStepsRafRef.current = null;
            }
            streamStepsRef.current = [];
            setStreamSteps([]);
            updateStreamStepsAnchorId(null);
          } else {
            reconcileStreamStepsAnchor(appliedMessages);
          }
        }
      }
      if (!activePathRef.current && next.documents[0]) setActivePath(next.documents[0]);
      return next;
    },
    [mergeConversationMessages, reconcileStreamStepsAnchor, updateStreamStepsAnchorId],
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
      await api("/api/style", {
        method: "PUT",
        body: JSON.stringify({ styleId }),
      });
      await refresh(state?.sessionId);
      if (!styleId) {
        setNotice("已关闭写作风格模板");
      } else {
        setNotice(`已激活写作风格：${label || styleId}`);
      }
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
        builtIn: false,
        customized: true,
        readOnly: false,
        isNew: true,
      });
      return;
    }
    const readOnly = Boolean(template.readOnly || template.builtIn);
    setStyleDraft({
      ...template,
      readOnly,
      isNew: false,
    });
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

  // Switching sessions: drop the live buffer. History comes from state.stepTrails.
  useEffect(() => {
    const nextId = state?.sessionId;
    if (!nextId) return;
    rememberLastSessionId(nextId);
    const prevId = sessionIdRef.current;
    sessionIdRef.current = nextId;
    if (prevId && prevId !== nextId) {
      abortRef.current?.abort();
      abortRef.current = undefined;
      currentJobRef.current = undefined;
      setBusy(false);
      streamOutputRef.current = "";
      setCollapsedAssistantIds(new Set());
      setStepTrailExpanded({});
      if (streamStepsRafRef.current != null) {
        window.cancelAnimationFrame(streamStepsRafRef.current);
        streamStepsRafRef.current = null;
      }
      streamStepsRef.current = [];
      setStreamSteps([]);
      updateStreamStepsAnchorId(null);
      setNotice("");
      setError("");
      setComposerBranch(null);
      setMessageVersionViews({});
    }
  }, [state?.sessionId, updateStreamStepsAnchorId]);

  useEffect(() => {
    if (!state?.sessionId) return;
    setRoleplay(state.activeRoleplay);
  }, [state?.sessionId, state?.activeRoleplay]);

  useEffect(() => {
    if (!state?.sessionId) return;
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

  // Intentionally do NOT rehydrate completed trails into streamSteps when idle.
  // History is rendered from state.stepTrails per message. Rehydrating the latest
  // server trail into the live buffer caused new messages to inherit previous steps
  // once source_message re-anchored the buffer to the new user id.

  // Persist live steps locally (collapsed) only while a job is active — crash recovery.
  useEffect(() => {
    const sessionId = state?.sessionId;
    if (!sessionId || streamStepsAnchorId == null || streamStepsAnchorId === 0) return;
    if (!streamSteps.length || !busy) return;
    const timer = window.setTimeout(() => {
      saveStepTrail(sessionId, streamStepsAnchorId, streamSteps);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [state?.sessionId, streamStepsAnchorId, streamSteps, busy]);

  useEffect(() => {
    const persistBeforeUnload = () => {
      const sessionId = sessionIdRef.current;
      const anchorId = streamStepsAnchorIdRef.current;
      if (!sessionId || anchorId == null || anchorId === 0 || !streamStepsRef.current.length) return;
      saveStepTrail(sessionId, anchorId, streamStepsRef.current);
    };
    window.addEventListener("beforeunload", persistBeforeUnload);
    return () => window.removeEventListener("beforeunload", persistBeforeUnload);
  }, []);

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
    const overlayOpen = showUsagePopover || settingsMenuOpen || headerMoreOpen || managementView !== null
      || styleDraft !== null || characterDraft !== null || simpleCardDraft !== null
      || roleplaySetup !== null || roleplaySceneDraft !== null || roleplaySceneManagerOpen || roleplayFactDraft !== null
      || branchConfirm !== null || roleplayBranchTimeline !== null;
    if (!overlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (styleDraft) {
        setStyleDraft(null);
        return;
      }
      if (characterDraft) { setCharacterDraft(null); return; }
      if (simpleCardDraft) { setSimpleCardDraft(null); return; }
      if (roleplayFactDraft) { setRoleplayFactDraft(null); return; }
      if (roleplaySceneDraft && !roleplaySceneGenerateBusy) { setRoleplaySceneDraft(null); return; }
      if (roleplaySceneManagerOpen && !roleplaySceneManagerBusy) { setRoleplaySceneManagerOpen(false); return; }
      if (roleplaySetup && !roleplaySetupBusy) { setRoleplaySetup(null); return; }
      if (branchConfirm) { setBranchConfirm(null); return; }
      if (roleplayBranchTimeline) { setRoleplayBranchTimeline(null); return; }
      if (headerMoreOpen) { setHeaderMoreOpen(false); return; }
      if (settingsMenuOpen) { setSettingsMenuOpen(false); return; }
      if (showUsagePopover) { setShowUsagePopover(false); return; }
      if (managementView) { setManagementView(null); return; }
      setShowUsagePopover(false);
      setManagementView(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    showUsagePopover, settingsMenuOpen, headerMoreOpen, managementView, styleDraft, characterDraft, simpleCardDraft, roleplaySetup, roleplaySetupBusy,
    roleplaySceneDraft, roleplaySceneGenerateBusy, roleplaySceneManagerOpen, roleplaySceneManagerBusy, roleplayFactDraft, branchConfirm, roleplayBranchTimeline,
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
    setReaderSelection(null);
    void api<DocumentData>(`/api/document?path=${encodeURIComponent(activePath)}`)
      .then((value) => {
        setDocument(value);
        setDocumentDraft(value.content);
        setEditingDocument(false);
      })
      .catch((e) => setError(String(e)));
  }, [activePath]);

  useEffect(() => {
    if (!activePath || editingDocument || browsingVersion || !document.content) return;
    const frame = window.requestAnimationFrame(() => {
      const reader = documentReaderRef.current;
      if (!reader) return;
      const saved = loadReadingProgress(activePath) ?? 0;
      const scrollable = Math.max(0, reader.scrollHeight - reader.clientHeight);
      reader.scrollTop = scrollable * saved;
      setReadingProgress(scrollable === 0 ? 1 : saved);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activePath, document.hash, editingDocument, browsingVersion]);

  useEffect(() => () => {
    if (readingProgressTimerRef.current !== undefined) {
      window.clearTimeout(readingProgressTimerRef.current);
    }
  }, []);

  function handleReaderScroll(event: React.UIEvent<HTMLDivElement>) {
    const reader = event.currentTarget;
    const scrollable = Math.max(0, reader.scrollHeight - reader.clientHeight);
    const ratio = scrollable === 0 ? 1 : reader.scrollTop / scrollable;
    setReadingProgress(ratio);
    setReaderSelection(null);
    if (!activePath || browsingVersion) return;
    if (readingProgressTimerRef.current !== undefined) {
      window.clearTimeout(readingProgressTimerRef.current);
    }
    readingProgressTimerRef.current = window.setTimeout(() => {
      saveReadingProgress(activePath, ratio);
      readingProgressTimerRef.current = undefined;
    }, 180);
  }

  function handleReaderTextSelection() {
    if (!activePath || editingDocument || browsingVersion) return;
    window.requestAnimationFrame(() => {
      const reader = documentReaderRef.current;
      const selection = window.getSelection();
      if (!reader || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        setReaderSelection(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const elementForNode = (node: Node): Element | null =>
        node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
      const startBlock = elementForNode(range.startContainer)?.closest<HTMLElement>("[data-source-start][data-source-end]");
      const endBlock = elementForNode(range.endContainer)?.closest<HTMLElement>("[data-source-start][data-source-end]");
      if (!startBlock || !endBlock || !reader.contains(startBlock) || !reader.contains(endBlock)) {
        setReaderSelection(null);
        return;
      }
      let normalizedStart = Number(startBlock.dataset.sourceStart);
      let normalizedEnd = Number(endBlock.dataset.sourceEnd);
      if (!Number.isInteger(normalizedStart) || !Number.isInteger(normalizedEnd)) {
        setReaderSelection(null);
        return;
      }
      if (normalizedEnd < normalizedStart) [normalizedStart, normalizedEnd] = [normalizedEnd, normalizedStart];
      const normalizedSource = normalizeMarkdownSource(document.content);
      const selectedText = selection.toString().trim();
      const envelope = normalizedSource.slice(normalizedStart, normalizedEnd);
      const exactOffset = selectedText ? envelope.indexOf(selectedText) : -1;
      if (exactOffset >= 0 && exactOffset === envelope.lastIndexOf(selectedText)) {
        normalizedStart += exactOffset;
        normalizedEnd = normalizedStart + selectedText.length;
      } else {
        while (normalizedStart < normalizedEnd && /\s/u.test(normalizedSource[normalizedStart] ?? "")) normalizedStart += 1;
        while (normalizedEnd > normalizedStart && /\s/u.test(normalizedSource[normalizedEnd - 1] ?? "")) normalizedEnd -= 1;
      }
      const start = originalOffsetForNormalized(document.content, normalizedStart);
      const end = originalOffsetForNormalized(document.content, normalizedEnd);
      const text = document.content.slice(start, end);
      if (!text.trim()) {
        setReaderSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const blockCount = startBlock === endBlock ? 1 : 2;
      setReaderSelection({
        id: `${activePath}:${start}:${end}`,
        path: activePath,
        text,
        start,
        end,
        blockCount,
        left: Math.max(12, Math.min(window.innerWidth - 260, rect.left + rect.width / 2 - 120)),
        top: Math.max(12, rect.top - 48),
      });
    });
  }

  function addReaderSelectionToContext() {
    if (!readerSelection) return;
    setDocumentContextSelections(current => {
      if (current.some(item => item.path === readerSelection.path && item.text === readerSelection.text)) return current;
      return [...current, {
        id: readerSelection.id,
        path: readerSelection.path,
        text: readerSelection.text,
      }];
    });
    setNotice(`已将 ${readerSelection.path} 的选段加入下一次 Agent 请求`);
    setReaderSelection(null);
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function editReaderSelectionDirectly() {
    if (!readerSelection || state?.accessMode === "readonly") return;
    const { start, end } = readerSelection;
    setDocumentDraft(document.content);
    setEditingDocument(true);
    setReaderSelection(null);
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => {
      const editor = documentEditorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(start, end);
    });
  }

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

  const loadChapters = useCallback(async () => {
    setChaptersLoading(true);
    try {
      const result = await api<{ chapters: ChapterSummary[] }>("/api/chapters");
      setChapters(result.chapters);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChaptersLoading(false);
    }
  }, []);

  async function loadContextGraph(sessionId?: string) {
    const id = sessionId ?? state?.sessionId;
    if (!id) return;
    setContextGraphLoading(true);
    setError("");
    try {
      const graph = await api<ContextGraphView>(`/api/session/${encodeURIComponent(id)}/context-graph`);
      setContextGraph(graph);
      if (graph.nodes.length && !graph.nodes.some(node => node.id === contextGraphSelectedId)) {
        setContextGraphSelectedId(graph.recentSlices[0]?.id ?? graph.nodes[graph.nodes.length - 1]?.id ?? null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setContextGraphLoading(false);
    }
  }

  async function openContextGraph() {
    setManagementView("context-graph");
    setContextGraphFilter("all");
    await loadContextGraph();
  }

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

  async function openChapterVersions(path: string) {
    setActivePath(path);
    setBrowsingVersion(null);
    setEditingDocument(false);
    setVersionPanelOpen(true);
    setMobileTab("editor");
    await loadVersions(path);
  }

  async function restoreBrowsingVersion() {
    if (!activePath || !browsingVersion || state?.accessMode === "readonly") return;
    if (!confirm(`将历史版本 #${browsingVersion.id} 恢复为当前内容？当前内容会保留在版本历史中。`)) return;
    setVersionBusy(true);
    setError("");
    try {
      const live = await api<DocumentData>(`/api/document?path=${encodeURIComponent(activePath)}`);
      await api("/api/document/version/restore", {
        method: "POST",
        body: JSON.stringify({ path: activePath, id: browsingVersion.id, baseHash: live.hash }),
      });
      const next = await api<DocumentData>(`/api/document?path=${encodeURIComponent(activePath)}`);
      setDocument(next);
      setDocumentDraft(next.content);
      setBrowsingVersion(null);
      await Promise.all([loadVersions(activePath), loadChapters(), refresh(state?.sessionId)]);
      setNotice(`已将版本 #${browsingVersion.id} 恢复为新版本`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVersionBusy(false);
    }
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
    localStorage.setItem("writer-document-sidebar-mode", documentSidebarMode);
  }, [documentSidebarMode]);

  useEffect(() => {
    localStorage.setItem("writer-collapsed-chapter-volumes", JSON.stringify([...collapsedChapterVolumes]));
  }, [collapsedChapterVolumes]);

  useEffect(() => {
    if (!state) return;
    void loadChapters();
  }, [loadChapters, state?.documents]);

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
    if (event.type === "source_message" && typeof event.messageId === "number" && Number.isFinite(event.messageId)) {
      updateStreamStepsAnchorId(event.messageId);
    }
    if (event.type === "step_start") {
      updateStreamSteps((current) => {
        const id = event.step ?? current.length + 1;
        if (current.some((s) => s.id === id)) return current;
        // New steps stay collapsed; expand only on user click. Content still streams into state.
        return [...current, { id, output: "", reasoning: "", tools: [], status: "running", expanded: false }];
      });
    }
    if (event.type === "text" && event.text) {
      if (event.channel !== "reasoning") streamOutputRef.current += event.text;
      updateStreamSteps((current) => {
        const idx = activeStepIndex(current);
        if (idx < 0) return current;
        const key = event.channel === "reasoning" ? "reasoning" : "output";
        const isDraftPreview = event.channel !== "reasoning" && event.text!.includes("草稿预览（终审仍在继续）");
        return current.map((s, i) => (i === idx
          ? { ...s, [key]: s[key] + event.text, ...(isDraftPreview ? { expanded: true } : {}) }
          : s));
      });
    }
    if (event.type === "tool" && event.name) {
      updateStreamSteps((current) => {
        const idx = activeStepIndex(current);
        return current.map((s, i) => (i === idx ? { ...s, tools: [...s.tools, event.name!] } : s));
      });
    }
    if (event.type === "usage") {
      if (event.usage) {
        setState((prev) => (prev ? { ...prev, usage: event.usage! } : prev));
      }
      if (event.call) {
        updateStreamSteps((current) => {
          const targetId = event.step;
          const idx = targetId != null
            ? current.findIndex((s) => s.id === targetId)
            : activeStepIndex(current);
          if (idx < 0) {
            if (targetId == null) return current;
            return [...current, {
              id: targetId,
              output: "",
              reasoning: "",
              tools: [],
              status: "completed" as const,
              expanded: false,
              usage: mergeStepCallUsage(undefined, event.call!, event.callKind),
            }].sort((left, right) => left.id - right.id);
          }
          return current.map((s, i) => (i === idx ? { ...s, usage: mergeStepCallUsage(s.usage, event.call!, event.callKind) } : s));
        });
      }
    }
    if (event.type === "step_done") {
      updateStreamSteps((current) =>
        current.map((s) => (s.id === event.step
          ? { ...s, status: "completed", expanded: s.output.includes("草稿预览（终审仍在继续）") }
          : s)),
      );
    }
    if (event.type === "error") {
      setError(event.message || "Agent failed");
      updateStreamSteps((current) =>
        current.map((s) => (s.status === "running" ? { ...s, status: "failed", expanded: false } : s)),
      );
    }
    if (event.type === "waiting_for_input") {
      setNotice(event.question?.trim()
        ? event.question.trim()
        : "Agent 等待输入。");
    }
    if (event.type === "proposal" && event.proposal) {
      setState((prev) => {
        if (!prev) return prev;
        return { ...prev, proposals: mergeProposalEvent(prev.proposals, event.proposal as Proposal) };
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
          ? { ...prev, agentSettings: { ...(prev.agentSettings ?? { permissionMode: "ask", writingMode: "fast", characterEvolutionEnabled: true, scenePipeline: { enabled: false, preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5, notesMaxCharacters: 3000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1 } }), permissionMode: event.mode! } }
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
          ? { ...prev, agentSettings: { ...(prev.agentSettings ?? { permissionMode: "ask", writingMode: "fast", characterEvolutionEnabled: true, scenePipeline: { enabled: false, preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5, notesMaxCharacters: 3000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1 } }), permissionMode: result.permissionMode } }
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
          if (sessionIdRef.current !== sessionId) continue;
          handleAgentEvent(event);
          if (event.type === "proposal" && event.proposal) completedProposal = event.proposal;
          if (event.type === "done" || event.type === "cancelled" || event.type === "error" || event.type === "waiting_for_input") {
            terminal = true;
            terminalType = event.type;
          }
        }
        // Push coalesced step UI after each SSE chunk so the trail does not lag a full frame behind.
        if (streamStepsRafRef.current != null) flushStreamStepsNow();
        if (done) break;
      }
      if (terminal) {
        if (sessionIdRef.current !== sessionId) return;
        flushStreamStepsNow();
        // Snapshot live steps for the brief window before refresh returns stepTrails.
        // After refresh, history is owned by state.stepTrails — clear the live buffer
        // whenever the server has this turn so a later new message cannot inherit it.
        const next = await refresh(sessionId);
        const messages = next.messages;
        let anchorId = streamStepsAnchorIdRef.current;
        if (
          streamStepsRef.current.length
          && (anchorId == null || anchorId <= 0 || !messages.some((message) => message.id === anchorId))
        ) {
          const lastUser = [...messages].reverse().find((message) => (
            message.role === "user" && message.id > 0 && message.content.trim()
          ));
          if (lastUser) anchorId = lastUser.id;
        }
        // Only accept a server trail for *this* turn's source message — never the
        // globally latest trail (that is how a new turn inherited the previous one).
        const serverTrail = anchorId != null && anchorId > 0
          ? next.stepTrails?.find((trail) => trail.sourceMessageId === anchorId && trail.steps.length > 0)
          : undefined;
        if (serverTrail) {
          // Server is source of truth for completed turns. Drop live buffer so it
          // cannot be re-anchored onto the next user message.
          if (streamStepsRafRef.current != null) {
            window.cancelAnimationFrame(streamStepsRafRef.current);
            streamStepsRafRef.current = null;
          }
          streamStepsRef.current = [];
          setStreamSteps([]);
          updateStreamStepsAnchorId(null);
          clearStepTrail(sessionId);
        } else if (anchorId != null && anchorId !== 0 && streamStepsRef.current.length) {
          // Server trail not ready yet — keep live cards under this turn only.
          updateStreamStepsAnchorId(anchorId);
          saveStepTrail(sessionId, anchorId, streamStepsRef.current);
        }
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
          setNotice("已中断。可在带「生成已中断」的回复上点「续跑」。");
        } else if (terminalType === "waiting_for_input") {
          // notice already set from the event question (budget pause / ask_user)
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

  const activeJobId = state?.activeJobs?.find((job) => job.sessionId === state.sessionId)?.id;
  useEffect(() => {
    const currentSessionId = state?.sessionId;
    if (!currentSessionId || !activeJobId) return;
    if (currentJobRef.current === activeJobId) return;
    const previousJob = currentJobRef.current;
    const switchingJob = Boolean(previousJob && previousJob !== activeJobId);
    // Re-subscribe to the same in-flight job (e.g. after connection drop) must keep
    // the live buffer. Attaching to a *different* job, or starting a job while leftover
    // completed steps are still in the buffer, must reset so history cannot leak.
    const leftoverCompletedTrail = !previousJob && streamStepsRef.current.length > 0
      && streamStepsAnchorIdRef.current != null
      && streamStepsAnchorIdRef.current > 0
      && Boolean(state?.stepTrails?.some((trail) => (
        trail.sourceMessageId === streamStepsAnchorIdRef.current && trail.steps.length > 0
      )));
    if (switchingJob || leftoverCompletedTrail) {
      if (streamStepsRafRef.current != null) {
        window.cancelAnimationFrame(streamStepsRafRef.current);
        streamStepsRafRef.current = null;
      }
      streamStepsRef.current = [];
      setStreamSteps([]);
      streamOutputRef.current = "";
    }
    if (streamStepsAnchorIdRef.current == null || switchingJob || leftoverCompletedTrail) {
      const lastUser = [...(state?.messages ?? [])]
        .reverse()
        .find((msg) => msg.role === "user" && msg.content.trim());
      updateStreamStepsAnchorId(lastUser?.id ?? null);
    }
    void subscribeAgentJob(activeJobId, currentSessionId);
  }, [state?.sessionId, activeJobId, state?.stepTrails, state?.messages, updateStreamStepsAnchorId]);

  useEffect(() => {
    if (!activeJobId) return;
    const timer = window.setInterval(() => {
      void api<{ activeJobs: AgentJob[] }>("/api/chat/jobs")
        .then((result) => setState((current) => {
          if (!current) return current;
          const nextJobs = result.activeJobs;
          const prev = current.activeJobs ?? [];
          if (
            prev.length === nextJobs.length
            && prev.every((job, index) => job.id === nextJobs[index]?.id && job.status === nextJobs[index]?.status)
          ) {
            return current;
          }
          return { ...current, activeJobs: nextJobs };
        }))
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [activeJobId]);

  function roleplayRequestControls(controls?: RoleplayRerunControls): RoleplayRerunControls {
    return {
      ...DEFAULT_ROLEPLAY_RERUN_CONTROLS,
      ...controls,
      contentRating: roleplay?.contentRating ?? "default",
    };
  }

  async function toggleFastWritingMode() {
    if (!state || busy || roleplay) return;
    const current = state.agentSettings?.writingMode ?? "fast";
    const writingMode: WritingExecutionMode = current === "fast" ? "delegated" : "fast";
    setError("");
    try {
      const result = await api<{ writingMode: WritingExecutionMode }>("/api/agent-settings", {
        method: "POST",
        body: JSON.stringify({ writingMode }),
      });
      setState((prev) =>
        prev
          ? {
              ...prev,
              agentSettings: {
                ...(prev.agentSettings ?? {
                  permissionMode: "ask",
                  writingMode: "fast",
                  characterEvolutionEnabled: true,
                  scenePipeline: {
                    enabled: false,
                    preferredMinScenes: 3,
                    preferredMaxScenes: 5,
                    maxScenes: 5,
                    notesMaxCharacters: 3000,
                    isolatedWriterMaxRatio: 2,
                    isolatedWriter: false,
                    candidateCount: 1,
                  },
                }),
                writingMode: result.writingMode,
              },
            }
          : prev,
      );
      setNotice(result.writingMode === "fast"
        ? "快速模式已开启：全部写作步骤使用 Agent，不调用正文 Writer"
        : "快速模式已关闭：恢复 Agent 分工执行");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function toggleScenePipeline() {
    if (!state || busy || roleplay) return;
    const enabled = !(state.agentSettings?.scenePipeline.enabled ?? false);
    setError("");
    try {
      const result = await api<{ scenePipeline: ScenePipelineSettings }>("/api/agent-settings", {
        method: "POST",
        body: JSON.stringify({ scenePipeline: { enabled } }),
      });
      setState(prev => prev ? {
        ...prev,
        agentSettings: {
          ...(prev.agentSettings ?? {
            permissionMode: "ask",
            writingMode: "fast",
            characterEvolutionEnabled: true,
            scenePipeline: result.scenePipeline,
          }),
          scenePipeline: result.scenePipeline,
        },
      } : prev);
      setNotice(result.scenePipeline.enabled
        ? "场景链已开启：Agent 可在长篇连续状态确有收益时选择分场"
        : "场景链已关闭：正文将直接成稿");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function createReadonlyShareLink() {
    if (!state || state.accessMode === "readonly") return;
    setError("");
    try {
      const result = await api<{ token: string; accessMode: "readonly" }>("/api/share/readonly", {
        method: "POST",
      });
      const url = buildReadonlyEntryUrl(result.token);
      if (!url) throw new Error("当前连接没有可分享的访问地址");
      try {
        await navigator.clipboard.writeText(url);
        setNotice("新的只读分享链接已复制；此前生成的只读链接已失效");
      } catch {
        window.prompt("复制只读分享链接", url);
        setNotice("已生成只读分享链接；此前生成的只读链接已失效");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function addComposerImages(files: FileList | File[]) {
    const list = Array.from(files).filter(isSupportedComposerImage);
    if (!list.length) {
      setError("仅支持 jpeg / png / gif / webp 图片");
      return;
    }
    try {
      const next: PendingAttachment[] = [];
      for (const file of list) next.push(await fileToPendingAttachment(file));
      setPendingAttachments((current) => {
        const merged = [...current, ...next].slice(0, MULTIMODAL_MAX_ATTACHMENTS);
        if (current.length + next.length > MULTIMODAL_MAX_ATTACHMENTS) {
          setNotice(`单次最多 ${MULTIMODAL_MAX_ATTACHMENTS} 张图片，已截断`);
        }
        return merged;
      });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function clearPendingAttachments() {
    setPendingAttachments((current) => {
      for (const item of current) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
  }

  async function sendChat(options?: {
    text?: string;
    channel?: "agent" | "roleplay";
    inputMode?: RoleplayInputMode;
    variantGroupId?: string;
    replaceFromId?: number;
    rerunDirections?: RoleplayRerunDirection[];
    rerunControls?: RoleplayRerunControls;
    perceptionOverride?: RoleplayPerceptionProjection;
    resumeInterrupted?: boolean;
  }) {
    const text = (options?.text ?? prompt).trim();
    const requestedChannel = options?.channel ?? composerBranch?.channel;
    const activeRoleplay = requestedChannel === undefined ? roleplay : requestedChannel === "roleplay" ? roleplay : null;
    const variantGroupId = options?.variantGroupId ?? composerBranch?.variantGroupId;
    const replaceFromId = options?.replaceFromId ?? composerBranch?.fromId;
    const requestDocumentSelections = !activeRoleplay && options?.text === undefined
      ? documentContextSelections
      : [];
    // Roleplay / rerun paths ignore pending images; agent composer can send image-only.
    const outboundAttachments = !activeRoleplay && options?.text === undefined
      ? pendingAttachments
      : [];
    if (!state || busy || (!text && !outboundAttachments.length)) return;
    if (requestedChannel === "roleplay" && !activeRoleplay) {
      setError("当前角色扮演身份已退出，无法重新运行这条扮演消息。");
      return;
    }
    const tempMessageId = -Date.now();
    const tempAttachments: MessageAttachment[] | undefined = outboundAttachments.length
      ? outboundAttachments.map((item) => ({
          id: item.localId,
          name: item.name,
          mimeType: item.mimeType,
          size: item.size,
          // Optimistic bubble uses the local object URL until refresh replaces it.
          storagePath: item.previewUrl,
        }))
      : undefined;
    if (options?.text === undefined) setPrompt("");
    setError("");
    setNotice("");
    // New turn replaces the previous trail for this session.
    clearStepTrail(state.sessionId);
    if (streamStepsRafRef.current != null) {
      window.cancelAnimationFrame(streamStepsRafRef.current);
      streamStepsRafRef.current = null;
    }
    streamStepsRef.current = [];
    setStreamSteps([]);
    updateStreamStepsAnchorId(tempMessageId);
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
              content: text || (tempAttachments?.length ? "请结合附图完成写作任务。" : ""),
              channel: activeRoleplay ? "roleplay" : "agent",
              ...(activeRoleplay ? { roleplayInputMode: options?.inputMode ?? roleplayInputMode } : {}),
              ...(tempAttachments ? { attachments: tempAttachments } : {}),
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
      const result = await api<{ jobId: string; job: AgentJob }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          sessionId: state.sessionId,
          prompt: text,
          permissionMode: state.agentSettings?.permissionMode ?? "ask",
          ...(options?.resumeInterrupted ? { resumeInterrupted: true } : {}),
          ...(variantGroupId ? { variantGroupId } : {}),
          ...(options?.rerunDirections?.length ? { rerunDirections: options.rerunDirections } : {}),
          ...(activeRoleplay ? { rerunControls: roleplayRequestControls(options?.rerunControls) } : {}),
          ...(options?.perceptionOverride ? { perceptionOverride: options.perceptionOverride } : {}),
          ...(!activeRoleplay ? {
            ...(characterScope !== undefined ? { characterScope } : {}),
            ...(simpleCharacterScope !== undefined ? { simpleCharacterScope } : {}),
            ...(requestDocumentSelections.length
              ? {
                  documentSelections: requestDocumentSelections.map(selection => ({
                    path: selection.path,
                    text: selection.text,
                  })),
                }
              : {}),
            ...(outboundAttachments.length
              ? {
                  attachments: outboundAttachments.map(item => ({
                    name: item.name,
                    mimeType: item.mimeType,
                    dataBase64: item.dataBase64,
                  })),
                }
              : {}),
          } : {}),
          ...(activeRoleplay
            ? { mode: "roleplay", performer: activeRoleplay.performer, identity: activeRoleplay.identity, scene: activeRoleplay.scene, inputMode: options?.inputMode ?? roleplayInputMode }
            : {}),
        }),
      });
      setState(current => current
        ? { ...current, activeJobs: [...(current.activeJobs ?? []).filter(job => job.id !== result.job.id), result.job] }
        : current);
      if (requestDocumentSelections.length) setDocumentContextSelections([]);
      if (outboundAttachments.length) clearPendingAttachments();
      setComposerBranch(null);
      await subscribeAgentJob(result.jobId, state.sessionId, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      clearAgentStream();
      await refresh(state.sessionId).catch(() => {
        setState(current => current
          ? { ...current, messages: current.messages.filter(message => message.id !== tempMessageId) }
          : current);
      });
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
    setBranchConfirm({
      mode: "edit",
      message,
      inputMode: message.channel === "roleplay" ? message.roleplayInputMode ?? "dialogue" : undefined,
      rerunDirections: [],
      rerunControls: { ...DEFAULT_ROLEPLAY_RERUN_CONTROLS },
    });
  }

  function requestRerunMessage(message: Message, perceptionOverride?: RoleplayPerceptionProjection) {
    if (!state || busy || message.id < 1) return;
    if (message.channel === "roleplay" && !roleplay) {
      setError("当前角色扮演身份已退出，无法重新运行这条扮演消息。");
      return;
    }
    const sourceUser = message.role === "user"
      ? message
      : [...state.messages].reverse().find(item => item.id <= message.id && item.role === "user" && item.channel === "roleplay");
    const inputMode = sourceUser
      ? sourceUser.roleplayInputMode ?? "dialogue"
      : undefined;
    const sourcePerception = inputMode === "director"
      ? undefined
      : perceptionOverride ?? sourceUser?.roleplayPerceptionData;
    setBranchConfirm({
      mode: "rerun",
      message,
      inputMode,
      rerunDirections: [],
      rerunControls: { ...DEFAULT_ROLEPLAY_RERUN_CONTROLS },
      perceptionOverride: sourcePerception,
    });
  }

  async function resumeInterruptedAgent(message: Message) {
    if (!state || busy || readOnly || message.id < 1) return;
    setError("");
    setNotice("");
    try {
      const result = await api<{ prompt: string; fromId: number }>(`/api/messages/${message.id}/resume`, {
        method: "POST",
        body: JSON.stringify({ sessionId: state.sessionId }),
      });
      await sendChat({
        text: result.prompt,
        channel: "agent",
        resumeInterrupted: true,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function confirmBranchAction(keepChanges: boolean) {
    if (!state || !branchConfirm) return;
    const { mode, message, inputMode, rerunDirections, rerunControls, perceptionOverride } = branchConfirm;
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
        inputMode?: RoleplayInputMode;
        modelInitiatedRoleplay?: "opening" | "continuation";
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
        if (result.channel === "roleplay") setRoleplayInputMode(inputMode ?? result.inputMode ?? "dialogue");
        await refresh(state.sessionId);
        requestAnimationFrame(() => composerRef.current?.focus());
        return;
      }
      setComposerBranch(null);
      if (result.modelInitiatedRoleplay === "opening") {
        await requestRoleplayOpening({
          variantGroupId: result.variantGroupId,
          replaceFromId: result.fromId,
          rerunDirections,
          rerunControls,
        });
        return;
      }
      if (result.modelInitiatedRoleplay === "continuation") {
        await requestPerformerAutoReply({
          variantGroupId: result.variantGroupId,
          replaceFromId: result.fromId,
          rerunDirections,
          rerunControls,
        });
        return;
      }
      await sendChat({
        text: result.prompt,
        channel: result.channel,
        inputMode: inputMode ?? result.inputMode,
        variantGroupId: result.variantGroupId,
        replaceFromId: result.fromId,
        rerunDirections,
        rerunControls,
        perceptionOverride: (inputMode ?? result.inputMode) === "director" ? undefined : perceptionOverride,
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
      const result = await api<{ continuityFacts?: number; continuityFactWarning?: string; continuityFactsPending?: boolean }>(
        `/api/proposals/${proposal.id}/${action}`,
        { method: "POST" },
      );
      await refresh(state?.sessionId);
      if (action === "accept" && result.continuityFactsPending) setNotice("内容已接受，事实索引正在后台更新。");
      else if (result.continuityFactWarning) setNotice(result.continuityFactWarning);
      else if (action === "accept" && result.continuityFacts) setNotice(`已更新 ${result.continuityFacts} 条连续性事实`);
      if (action === "accept" && proposal.path === activePath) {
        const next = await api<DocumentData>(`/api/document?path=${encodeURIComponent(activePath)}`);
        setDocument(next);
        setDocumentDraft(next.content);
        setBrowsingVersion(null);
        if (versionPanelOpen) await loadVersions(activePath);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // The visible card may come from a replayed/stale pending event. Reconcile
      // even on 409 so an already-processed proposal disappears immediately.
      await refresh(state?.sessionId).catch(() => undefined);
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
      if (oldPath.startsWith("chapters/")) await loadChapters();
    } catch (e) {
      setError(String(e));
    }
    setRenaming(null);
  }

  async function handleDelete(path: string, kind: "file" | "folder") {
    if (kind === "folder") {
      const volume = chapterGroups.find(group => group.folderPath === path);
      const containedChapters = chapters.filter(chapter => chapter.path.startsWith(`${path}/`)).length;
      if (volume && containedChapters > 0) {
        setNotice(`“${volume.label}”及其子卷中还有 ${containedChapters} 个章节，请先移动或删除这些章节`);
        return;
      }
    }
    const label = kind === "file" ? "文档" : "卷";
    if (!confirm(`确定删除${label}“${path}”吗？此操作不可撤销。`)) return;
    try {
      const endpoint = kind === "file" ? "/api/document" : "/api/folder";
      await api(`${endpoint}?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      if (activePath === path || activePath.startsWith(`${path}/`)) setActivePath("");
      await refresh(state?.sessionId);
      if (path.startsWith("chapters/")) await loadChapters();
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

  async function handleArchive(path: string, kind: "file" | "folder", label: string) {
    if (isArchivedPath(path)) {
      setNotice("该项已在归档区");
      return;
    }
    const desiredPath = archiveDestinationPath(path);
    const kindLabel = kind === "folder"
      ? (path.startsWith("chapters/") ? "卷" : "文件夹")
      : (path.startsWith("chapters/") ? "章节" : "文件");
    const chapterCount = kind === "folder"
      ? chapters.filter(chapter => chapter.path === path || chapter.path.startsWith(`${path}/`)).length
      : 0;
    const hint = chapterCount > 0
      ? `（含 ${chapterCount} 个章节）`
      : "";
    if (!confirm(`将${kindLabel}「${label}」${hint}归档到 archive/ ？\n若归档区已有同名项，会自动加「-归档」等后缀，两边都保留。\n归档后不再计入现行章节；可在「全部文件 → archive」中取消归档。`)) {
      return;
    }
    try {
      const result = await api<{ path: string; renamedDueToConflict?: boolean }>(
        kind === "file" ? "/api/document/rename" : "/api/folder/rename",
        {
          method: "PUT",
          body: JSON.stringify({ fromPath: path, toPath: desiredPath, uniqueIfExists: true }),
        },
      );
      const finalPath = result.path || desiredPath;
      if (activePath === path || activePath.startsWith(`${path}/`)) {
        setActivePath(`${finalPath}${activePath.slice(path.length)}`);
      }
      setExpandedFolders((prev) => new Set(prev).add(ARCHIVE_ROOT));
      await refresh(state?.sessionId);
      await loadChapters();
      setNotice(
        result.renamedDueToConflict
          ? `已归档${kindLabel}「${label}」→ ${finalPath}（目标已占用，已自动改名）`
          : `已归档${kindLabel}「${label}」→ ${finalPath}`,
      );
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleUnarchive(path: string, kind: "file" | "folder", label: string) {
    const desiredPath = unarchiveDestinationPath(path);
    if (!desiredPath) {
      setNotice("无法取消归档：路径无效");
      return;
    }
    if (!confirm(`将「${label}」从归档恢复？\n目标默认 ${desiredPath}；若现行区已有同名，会自动加「-归档」等后缀，两边都保留。`)) {
      return;
    }
    try {
      const result = await api<{ path: string; renamedDueToConflict?: boolean }>(
        kind === "file" ? "/api/document/rename" : "/api/folder/rename",
        {
          method: "PUT",
          body: JSON.stringify({ fromPath: path, toPath: desiredPath, uniqueIfExists: true }),
        },
      );
      const finalPath = result.path || desiredPath;
      if (activePath === path || activePath.startsWith(`${path}/`)) {
        setActivePath(`${finalPath}${activePath.slice(path.length)}`);
      }
      const parent = finalPath.includes("/") ? finalPath.slice(0, finalPath.lastIndexOf("/")) : "";
      if (parent) setExpandedFolders((prev) => new Set(prev).add(parent));
      await refresh(state?.sessionId);
      await loadChapters();
      setNotice(
        result.renamedDueToConflict
          ? `已恢复「${label}」→ ${finalPath}（目标已占用，已自动改名）`
          : `已恢复「${label}」→ ${finalPath}`,
      );
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleMoveNode(path: string, kind: "file" | "folder", targetFolder: string): Promise<boolean> {
    if (kind === "folder" && (targetFolder === path || targetFolder.startsWith(`${path}/`))) {
      setNotice("不能把文件夹移动到自身内部");
      return false;
    }
    const parts = path.split("/");
    const name = parts.pop()!;
    const newPath = targetFolder ? `${targetFolder}/${name}` : name;
    if (newPath === path) return false;
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
      if (path.startsWith("chapters/") || newPath.startsWith("chapters/")) await loadChapters();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  function requestMoveChapter(chapter: ChapterSummary) {
    const currentFolder = chapter.path.slice(0, chapter.path.lastIndexOf("/"));
    const firstTarget = chapterGroups.find(group => group.folderPath !== currentFolder)?.folderPath ?? "";
    if (!firstTarget) {
      setNotice("请先新建另一个卷，再移动章节");
      return;
    }
    setMovingChapter(chapter);
    setMoveChapterTarget(firstTarget);
  }

  async function submitMoveChapter() {
    if (!movingChapter || !moveChapterTarget) return;
    const moved = await handleMoveNode(movingChapter.path, "file", moveChapterTarget);
    if (!moved) return;
    const targetLabel = chapterGroups.find(group => group.folderPath === moveChapterTarget)?.label ?? moveChapterTarget;
    setNotice(`已将“${movingChapter.title}”移动到“${targetLabel}”`);
    setMovingChapter(null);
    setMoveChapterTarget("");
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

  function handleNewChapter(parent = "chapters") {
    const maxNumber = chapters.reduce((max, chapter) => {
      const match = chapter.path.split("/").pop()?.match(/^chapter-(\d+)\.md$/iu);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    setCreating({ parent, kind: "file" });
    setCreateValue(`chapter-${String(maxNumber + 1).padStart(3, "0")}`);
  }

  function handleNewVolume() {
    const volumeCount = new Set(chapters.map(chapter => chapter.volume).filter(Boolean)).size;
    setCreating({ parent: "chapters", kind: "folder" });
    setCreateValue(`第${volumeCount + 1}卷`);
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
        const stem = name.replace(/\.md$/iu, "");
        const numberedChapter = fullPath.startsWith("chapters/") ? stem.match(/^chapter-(\d+)$/iu) : null;
        const heading = numberedChapter ? `第${Number(numberedChapter[1])}章` : stem;
        await api("/api/document", {
          method: "POST",
          body: JSON.stringify({ path: fullPath, content: `# ${heading || "新文档"}\n\n` }),
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
      if (fullPath.startsWith("chapters/")) await loadChapters();
      if (creating.kind === "file") setActivePath(fullPath);
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

  async function summarizeCharacter(kind: CharacterSummaryKind, source: unknown): Promise<string> {
    const result = await api<{ summary: string }>("/api/characters/summarize", {
      method: "POST",
      body: JSON.stringify({ sessionId: state?.sessionId, kind, source }),
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
        sceneIds: value.sceneSequence.map(scene => scene.id),
        sceneIndex: value.sceneIndex,
        contentRating: value.contentRating,
      }),
    });
  }

  async function updateRoleplayContentRating(contentRating: RoleplayContentRating) {
    if (!roleplay || busy) return;
    const previous = roleplay;
    const next = { ...roleplay, contentRating };
    setRoleplay(next);
    try {
      setRoleplay(await persistActiveRoleplay(next));
    } catch (cause) {
      setRoleplay(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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
      const previousSequence = roleplay?.sceneSequence ?? [];
      const selectedSceneIndex = roleplaySetup.scene
        ? previousSequence.findIndex(scene => scene.id === roleplaySetup.scene!.id)
        : -1;
      const sceneSequence = roleplaySetup.scene
        ? selectedSceneIndex >= 0 ? previousSequence : [roleplaySetup.scene]
        : [];
      const sceneIndex = selectedSceneIndex >= 0 ? selectedSceneIndex : 0;
      const active = await persistActiveRoleplay({
        performer: roleplaySetup.performer,
        identity,
        ...(roleplaySetup.scene ? { scene: roleplaySetup.scene } : {}),
        sceneSequence,
        sceneIndex,
        contentRating: roleplay?.contentRating ?? "default",
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
      const result = await api<{ continuityFacts?: number; continuityFactWarnings?: string[]; continuityFactsPending?: boolean }>(
        `/api/change-sets/${changeSet.id}/${action}`,
        { method: "POST" },
      );
      await refresh(state?.sessionId);
      if (action === "accept" && result.continuityFactsPending) setNotice("内容已接受，事实索引正在后台更新。");
      else if (result.continuityFactWarnings?.length) setNotice(result.continuityFactWarnings.join("；"));
      else if (action === "accept" && result.continuityFacts) setNotice(`已更新 ${result.continuityFacts} 条连续性事实`);
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
      if (roleplay?.sceneSequence.some(scene => scene.id === saved.id)) {
        const sceneSequence = roleplay.sceneSequence.map(scene => scene.id === saved.id ? saved : scene);
        const active = await persistActiveRoleplay({
          ...roleplay,
          sceneSequence,
          ...(roleplay.scene?.id === saved.id ? { scene: saved } : {}),
        });
        setRoleplay(active);
        setState(current => current ? { ...current, activeRoleplay: active } : current);
      }
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
      if (roleplay?.sceneSequence.some(scene => scene.id === id)) {
        const sceneSequence = roleplay.sceneSequence.filter(scene => scene.id !== id);
        const sceneIndex = Math.min(roleplay.sceneIndex, Math.max(0, sceneSequence.length - 1));
        const { scene: _removedScene, ...rest } = roleplay;
        const active = await persistActiveRoleplay({
          ...rest,
          ...(sceneSequence[sceneIndex] ? { scene: sceneSequence[sceneIndex] } : {}),
          sceneSequence,
          sceneIndex,
        });
        setRoleplay(active);
        setState(current => current ? { ...current, activeRoleplay: active } : current);
      }
      await refresh(state?.sessionId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function beginRoleplaySceneDraft(scene?: RoleplayScene) {
    setRoleplaySceneGenerateRequest("");
    setRoleplaySceneDraft(scene ? { ...scene } : emptyRoleplayScene());
  }

  async function generateRoleplaySceneDraft() {
    if (!state || !roleplaySceneDraft || roleplaySceneDraft.id || !roleplaySceneGenerateRequest.trim() || roleplaySceneGenerateBusy) return;
    setRoleplaySceneGenerateBusy(true);
    setError("");
    try {
      const generated = await api<Pick<RoleplayScene, "name" | "setting" | "premise">>("/api/roleplay/scenes/generate", {
        method: "POST",
        body: JSON.stringify({
          sessionId: state.sessionId,
          request: roleplaySceneGenerateRequest,
          performer: roleplaySetup?.performer ?? roleplay?.performer,
          identity: roleplaySetup?.identity ?? roleplay?.identity,
          currentScene: roleplay?.scene,
        }),
      });
      setRoleplaySceneDraft(current => current ? { ...current, ...generated } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRoleplaySceneGenerateBusy(false);
    }
  }

  async function updateRoleplaySceneSequence(sceneSequence: RoleplayScene[], requestedIndex: number) {
    if (!roleplay || roleplaySceneManagerBusy) return;
    const previous = roleplay;
    const sceneIndex = sceneSequence.length
      ? Math.min(Math.max(requestedIndex, 0), sceneSequence.length - 1)
      : 0;
    const { scene: _previousScene, ...rest } = roleplay;
    const next: ActiveRoleplayState = {
      ...rest,
      ...(sceneSequence[sceneIndex] ? { scene: sceneSequence[sceneIndex] } : {}),
      sceneSequence,
      sceneIndex,
    };
    setRoleplay(next);
    setRoleplaySceneManagerBusy(true);
    try {
      const saved = await persistActiveRoleplay(next);
      setRoleplay(saved);
      setState(current => current ? { ...current, activeRoleplay: saved } : current);
    } catch (cause) {
      setRoleplay(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRoleplaySceneManagerBusy(false);
    }
  }

  function addRoleplaySceneToSequence(scene: RoleplayScene) {
    if (!roleplay || roleplay.sceneSequence.some(item => item.id === scene.id)) return;
    const sceneSequence = [...roleplay.sceneSequence, scene];
    void updateRoleplaySceneSequence(sceneSequence, roleplay.sceneSequence.length ? roleplay.sceneIndex : 0);
  }

  function moveRoleplaySceneInSequence(index: number, offset: -1 | 1) {
    if (!roleplay) return;
    const target = index + offset;
    if (target < 0 || target >= roleplay.sceneSequence.length) return;
    const sceneSequence = [...roleplay.sceneSequence];
    [sceneSequence[index], sceneSequence[target]] = [sceneSequence[target], sceneSequence[index]];
    const sceneIndex = roleplay.sceneIndex === index ? target : roleplay.sceneIndex === target ? index : roleplay.sceneIndex;
    void updateRoleplaySceneSequence(sceneSequence, sceneIndex);
  }

  function removeRoleplaySceneFromSequence(index: number) {
    if (!roleplay) return;
    const sceneSequence = roleplay.sceneSequence.filter((_, itemIndex) => itemIndex !== index);
    const sceneIndex = index < roleplay.sceneIndex
      ? roleplay.sceneIndex - 1
      : Math.min(roleplay.sceneIndex, Math.max(0, sceneSequence.length - 1));
    void updateRoleplaySceneSequence(sceneSequence, sceneIndex);
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

  async function requestRoleplayOpening(options?: {
    variantGroupId?: string;
    replaceFromId?: number;
    rerunDirections?: RoleplayRerunDirection[];
    rerunControls?: RoleplayRerunControls;
  }) {
    if (!state || busy || !roleplay) return;
    setError("");
    setNotice("");
    clearStepTrail(state.sessionId);
    if (streamStepsRafRef.current != null) {
      window.cancelAnimationFrame(streamStepsRafRef.current);
      streamStepsRafRef.current = null;
    }
    streamStepsRef.current = [];
    setStreamSteps([]);
    // No user bubble for an opening; anchor the live stream to a temp id so it renders via the orphan path.
    updateStreamStepsAnchorId(-Date.now());
    streamOutputRef.current = "";
    if (options?.replaceFromId !== undefined) {
      setState(current => current ? {
        ...current,
        messages: current.messages.filter(message => message.id < options.replaceFromId!),
      } : current);
    }
    try {
      const result = await api<{ jobId: string; job: AgentJob }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          sessionId: state.sessionId,
          prompt: "",
          mode: "roleplay",
          opening: true,
          ...(options?.variantGroupId ? { variantGroupId: options.variantGroupId } : {}),
          ...(options?.rerunDirections?.length ? { rerunDirections: options.rerunDirections } : {}),
          rerunControls: roleplayRequestControls(options?.rerunControls),
          permissionMode: state.agentSettings?.permissionMode ?? "ask",
          performer: roleplay.performer,
          identity: roleplay.identity,
          scene: roleplay.scene,
        }),
      });
      setState(current => current
        ? { ...current, activeJobs: [...(current.activeJobs ?? []).filter(job => job.id !== result.job.id), result.job] }
        : current);
      await subscribeAgentJob(result.jobId, state.sessionId, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      clearAgentStream();
    }
  }

  async function requestPerformerAutoReply(options?: {
    variantGroupId?: string;
    replaceFromId?: number;
    rerunDirections?: RoleplayRerunDirection[];
    rerunControls?: RoleplayRerunControls;
  }) {
    if (!state || busy || roleplayAutoReplyBusy || !roleplay) return;
    const tempMessageId = -Date.now();
    setRoleplayAutoReplyBusy("performer");
    setError("");
    setNotice("");
    clearStepTrail(state.sessionId);
    if (streamStepsRafRef.current != null) {
      window.cancelAnimationFrame(streamStepsRafRef.current);
      streamStepsRafRef.current = null;
    }
    streamStepsRef.current = [];
    setStreamSteps([]);
    updateStreamStepsAnchorId(tempMessageId);
    streamOutputRef.current = "";
    setState(current => current ? {
      ...current,
      messages: [
        ...current.messages.filter(message => options?.replaceFromId === undefined || message.id < options.replaceFromId),
        {
          id: tempMessageId,
          role: "user",
          content: ROLEPLAY_CONTINUATION_PLACEHOLDER,
          channel: "roleplay",
          roleplayInputMode: "dialogue",
        },
      ],
    } : current);
    try {
      const result = await api<{ jobId: string; job: AgentJob }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          sessionId: state.sessionId,
          prompt: "",
          mode: "roleplay",
          performerAutoReply: true,
          ...(options?.variantGroupId ? { variantGroupId: options.variantGroupId } : {}),
          ...(options?.rerunDirections?.length ? { rerunDirections: options.rerunDirections } : {}),
          rerunControls: roleplayRequestControls(options?.rerunControls),
          permissionMode: state.agentSettings?.permissionMode ?? "ask",
          performer: roleplay.performer,
          identity: roleplay.identity,
          scene: roleplay.scene,
        }),
      });
      setState(current => current
        ? { ...current, activeJobs: [...(current.activeJobs ?? []).filter(job => job.id !== result.job.id), result.job] }
        : current);
      await subscribeAgentJob(result.jobId, state.sessionId, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      clearAgentStream();
      await refresh(state.sessionId).catch(() => undefined);
    } finally {
      setRoleplayAutoReplyBusy(null);
    }
  }

  async function requestRoleplayAutoReply() {
    if (!state?.sessionId || !roleplay || busy || roleplayAutoReplyBusy) return;
    setRoleplayAutoReplyBusy("identity");
    setError("");
    setNotice("");
    try {
      const result = await api<{ reply: string }>("/api/roleplay/auto-reply", {
        method: "POST",
        body: JSON.stringify({ sessionId: state.sessionId }),
      });
      setRoleplayInputMode("dialogue");
      setPrompt(result.reply);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRoleplayAutoReplyBusy(null);
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

  function openSettings(section: SettingsSection = "models") {
    setSettingsMenuOpen(false);
    setSettingsSection(section);
    setManagementView("models");
  }

  function openProviderSettings() {
    openSettings("models");
  }

  function openProseGateRules() {
    setProseGateDraft(null);
    openSettings("prose-gates");
  }

  function openContinuityFacts() {
    setContinuityFactDraft(null);
    openSettings("continuity-facts");
  }

  async function saveProseGateRule() {
    if (!proseGateDraft) return;
    setProseGateBusy(true);
    setError("");
    try {
      const result = await api<{ rules: ProseGateRule[] }>("/api/prose-gates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proseGateDraft),
      });
      setState(current => current ? { ...current, proseGateRules: result.rules } : current);
      setProseGateDraft(null);
      setNotice("作者复审规则已保存，将从下一次正文复审开始生效。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProseGateBusy(false);
    }
  }

  async function setProseGateRuleEnabled(rule: ProseGateRule, enabled: boolean) {
    setProseGateBusy(true);
    setError("");
    try {
      const result = await api<{ rules: ProseGateRule[] }>(
        `/api/prose-gates/${encodeURIComponent(rule.id)}/enabled`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      setState(current => current ? { ...current, proseGateRules: result.rules } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProseGateBusy(false);
    }
  }

  async function deleteProseGateRule(rule: ProseGateRule) {
    if (!confirm(`删除作者复审规则“${rule.id}”？`)) return;
    setProseGateBusy(true);
    setError("");
    try {
      const result = await api<{ rules: ProseGateRule[] }>(
        `/api/prose-gates/${encodeURIComponent(rule.id)}`,
        { method: "DELETE" },
      );
      setState(current => current ? { ...current, proseGateRules: result.rules } : current);
      if (proseGateDraft?.id === rule.id) setProseGateDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProseGateBusy(false);
    }
  }

  async function saveContinuityFact() {
    if (!continuityFactDraft) return;
    setContinuityFactBusy(true);
    setError("");
    try {
      const result = await api<{ facts: ContinuityFact[] }>("/api/continuity-facts", {
        method: "POST",
        body: JSON.stringify(continuityFactDraft),
      });
      setState(current => current ? { ...current, continuityFacts: result.facts } : current);
      setContinuityFactDraft(null);
      setNotice("连续性事实已保存，将从下一次任务开始进入相关事实包。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setContinuityFactBusy(false);
    }
  }

  async function retractContinuityFact(fact: ContinuityFact) {
    if (!confirm(`撤回事实“${fact.statement}”？原始记录仍会保留以便追溯。`)) return;
    setContinuityFactBusy(true);
    setError("");
    try {
      const result = await api<{ facts: ContinuityFact[] }>(
        `/api/continuity-facts/${fact.id}`,
        { method: "DELETE" },
      );
      setState(current => current ? { ...current, continuityFacts: result.facts } : current);
      if (continuityFactDraft?.id === fact.id) setContinuityFactDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setContinuityFactBusy(false);
    }
  }

  async function saveRoleplayPerception(message: Message, perception: RoleplayPerceptionProjection): Promise<void> {
    if (!state) return;
    const result = await api<{ perception: RoleplayPerceptionProjection; display: string }>(
      `/api/roleplay/messages/${message.id}/perception`,
      { method: "PUT", body: JSON.stringify({ sessionId: state.sessionId, perception }) },
    );
    setState(current => current ? {
      ...current,
      messages: current.messages.map(item => item.id === message.id
        ? { ...item, roleplayPerception: result.display, roleplayPerceptionData: result.perception }
        : item),
    } : current);
  }

  async function saveAndReplayRoleplayPerception(message: Message, perception: RoleplayPerceptionProjection): Promise<void> {
    await saveRoleplayPerception(message, perception);
    requestRerunMessage({ ...message, roleplayPerceptionData: perception }, perception);
  }

  async function openRoleplayBranchTimeline(message: Message) {
    if (!state || !message.variantGroupId) return;
    try {
      const result = await api<{ branches: RoleplayBranchSummary[] }>(
        `/api/roleplay/branches?session=${encodeURIComponent(state.sessionId)}&group=${encodeURIComponent(message.variantGroupId)}`,
      );
      setRoleplayBranchTimeline({ message, branches: result.branches });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function activateRoleplayBranch(branch: RoleplayBranchSummary) {
    if (!state || roleplayBranchBusy) return;
    setRoleplayBranchBusy(true);
    try {
      await api(`/api/roleplay/branches/${encodeURIComponent(branch.id)}/activate`, {
        method: "POST",
        body: JSON.stringify({ sessionId: state.sessionId }),
      });
      setRoleplayBranchTimeline(null);
      setMessageVersionViews({});
      clearAgentStream({ abort: true, clearStorage: true, sessionId: state.sessionId });
      await refresh(state.sessionId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRoleplayBranchBusy(false); }
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
    if (state?.activeJobs?.some(job => job.sessionId === id)) return;
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
  const chapterGroups = useMemo(() => buildChapterGroups(chapters, state?.documentFolders ?? []), [chapters, state?.documentFolders]);
  const totalChapterWords = useMemo(() => chapters.reduce((total, chapter) => total + chapter.wordCount, 0), [chapters]);

  if (!state) {
    return (
      <main className="app-shell">
        <p>{error || "Loading..."}</p>
      </main>
    );
  }

  const pendingProposals = state.proposals.filter((p) => p.status === "pending");
  const readOnly = state.accessMode === "readonly";
  const pendingChangeSets = state.changeSets.filter((item) => item.status === "pending");
  const visibleMessages = state.messages.filter((msg) =>
    (msg.role === "user" || msg.role === "assistant")
    && (msg.content.trim() || Boolean(msg.attachments?.length)),
  );
  const agentSupportsMultimodal = Boolean(state.provider.supportsMultimodal);
  const usagePct = state.provider.pricing.contextWindow
    ? Math.round((state.usage.lastPromptTokens / state.provider.pricing.contextWindow) * 100)
    : 0;
  const styleTemplates = state.styleTemplates ?? [];
  const activeStyleId = state.config.style?.trim() || "";
  const activeStyle = activeStyleId
    ? styleTemplates.find((item) => item.id === activeStyleId)
    : undefined;
  const connectionProbeLabel = (preference: ConnectionPreference): string | null => {
    if (!connectionProbeResults) return null;
    const route = preference === "auto"
      ? (connection.route === "lan" || connection.route === "public" ? connection.route : null)
      : preference;
    if (!route) return "当前为本机";
    const result = connectionProbeResults[route];
    const routeName = route === "lan" ? "局域网" : "公网";
    const value = result.status === "ok"
      ? `${result.latencyMs} ms`
      : result.status === "blocked"
        ? "浏览器受限"
        : result.status === "unconfigured"
          ? "未配置"
          : "不可达";
    return preference === "auto" ? `${routeName} · ${value}` : value;
  };
  // Legacy picker shells remain unreachable while their content is hosted by the unified settings page.
  const showStylePicker = false;
  const showConnectionPanel = false;
  const showThemePicker = false;
  const proseGatesSettingsContent = <div className="settings-section-body prose-gate-manager">
    <p className="prose-gate-intro">
      项目级语义复审会在正文出口运行。确定错误可设为阻断；偏好、倾向和可能误报的规则建议使用提醒。
    </p>
    <div className="style-picker-actions">
      <button
        type="button"
        className="primary"
        disabled={proseGateBusy || readOnly || Boolean(proseGateDraft)}
        onClick={() => setProseGateDraft({
          id: "",
          instruction: "",
          kind: "style_preference",
          severity: "warn",
          enabled: true,
          sourceFeedback: "",
          isNew: true,
        })}
      ><Plus size={15} />新增规则</button>
    </div>
    {proseGateDraft && (
      <div className="prose-gate-editor">
        <div className="prose-gate-editor-grid">
          <label>
            <span>稳定 ID</span>
            <input
              value={proseGateDraft.id}
              disabled={!proseGateDraft.isNew || proseGateBusy}
              placeholder="例如 dialogue-register"
              onChange={(event) => setProseGateDraft(current => current
                ? { ...current, id: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") }
                : current)}
            />
          </label>
          <label>
            <span>级别</span>
            <select
              value={proseGateDraft.severity}
              disabled={proseGateBusy}
              onChange={(event) => setProseGateDraft(current => current
                ? {
                  ...current,
                  severity: event.target.value === "block" ? "block" : "warn",
                  kind: event.target.value === "block" ? "hard_gate" : "style_preference",
                }
                : current)}
            >
              <option value="warn">提醒</option>
              <option value="block">阻断</option>
            </select>
          </label>
        </div>
        <label>
          <span>核验标准</span>
          <textarea
            value={proseGateDraft.instruction}
            disabled={proseGateBusy}
            maxLength={500}
            rows={4}
            placeholder="写成可以独立执行的检查标准；说明何时适用、什么算违规。"
            onChange={(event) => setProseGateDraft(current => current
              ? { ...current, instruction: event.target.value }
              : current)}
          />
        </label>
        <label>
          <span>作者反馈来源</span>
          <textarea
            value={proseGateDraft.sourceFeedback}
            disabled={proseGateBusy}
            maxLength={500}
            rows={2}
            placeholder="简要记录为什么增加这条规则，不粘贴长对话。"
            onChange={(event) => setProseGateDraft(current => current
              ? { ...current, sourceFeedback: event.target.value }
              : current)}
          />
        </label>
        <label className="prose-gate-enabled">
          <input
            type="checkbox"
            checked={proseGateDraft.enabled}
            disabled={proseGateBusy}
            onChange={(event) => setProseGateDraft(current => current
              ? { ...current, enabled: event.target.checked }
              : current)}
          />
          保存后立即启用
        </label>
        <div className="prose-gate-editor-actions">
          <button
            type="button"
            className="primary"
            disabled={proseGateBusy || !proseGateDraft.id.trim() || !proseGateDraft.instruction.trim()}
            onClick={() => void saveProseGateRule()}
          ><Save size={15} />保存</button>
          <button type="button" disabled={proseGateBusy} onClick={() => setProseGateDraft(null)}>取消</button>
        </div>
      </div>
    )}
    <div className="prose-gate-list">
      {(state.proseGateRules ?? []).map(rule => (
        <article className={`prose-gate-card${rule.enabled ? "" : " disabled"}`} key={rule.id}>
          <div className="prose-gate-card-head">
            <div>
              <strong>{rule.id}</strong>
              <span className={`prose-gate-severity ${rule.severity}`}>{rule.severity === "block" ? "阻断" : "提醒"}</span>
            </div>
            <label className="prose-gate-switch">
              <input
                type="checkbox"
                checked={rule.enabled}
                disabled={proseGateBusy || readOnly}
                onChange={(event) => void setProseGateRuleEnabled(rule, event.target.checked)}
              />
              {rule.enabled ? "启用" : "停用"}
            </label>
          </div>
          <p>{rule.instruction}</p>
          {rule.sourceFeedback && <small>{rule.sourceFeedback}</small>}
          <div className="prose-gate-card-foot">
            <time dateTime={rule.updatedAt}>更新于 {new Date(rule.updatedAt).toLocaleString()}</time>
            <div>
              <button
                className="ghost"
                disabled={proseGateBusy || readOnly || Boolean(proseGateDraft)}
                onClick={() => setProseGateDraft({
                  id: rule.id,
                  instruction: rule.instruction,
                  kind: rule.kind ?? (rule.severity === "block" ? "hard_gate" : "style_preference"),
                  severity: rule.severity,
                  enabled: rule.enabled,
                  sourceFeedback: rule.sourceFeedback,
                  isNew: false,
                })}
              ><Pencil size={14} />编辑</button>
              <button
                className="ghost danger"
                disabled={proseGateBusy || readOnly}
                onClick={() => void deleteProseGateRule(rule)}
              ><Trash2 size={14} />删除</button>
            </div>
          </div>
        </article>
      ))}
      {(state.proseGateRules ?? []).length === 0 && (
        <div className="management-empty">暂无作者复审规则，可以从右上角新增。</div>
      )}
    </div>
  </div>;
  const continuityFactsSettingsContent = <div className="settings-section-body continuity-fact-manager">
    <p className="prose-gate-intro">
      这是原文的可追溯连续性索引，不替代正文和设定。环境事实记录长期生活常识；离散事实记录局部人物、事件与物品状态。冲突项不会自动覆盖旧事实。
    </p>
    <div className="style-picker-actions">
      <button
        type="button"
        className="primary"
        disabled={continuityFactBusy || readOnly || Boolean(continuityFactDraft)}
        onClick={() => setContinuityFactDraft({
          statement: "",
          kind: "milieu",
          scopeKind: "global",
          scopeValue: "",
          validFrom: "",
          validUntil: "",
          epistemic: "objective",
          knownBy: [],
          importance: 50,
          status: "active",
          sourcePath: "",
          sourceEvidence: "",
          conflictsWith: [],
          supersedes: [],
        })}
      ><Plus size={15} />新增事实</button>
    </div>
    {continuityFactDraft && (
      <div className="continuity-fact-editor">
        <label className="continuity-fact-statement">
          <span>事实陈述</span>
          <textarea
            rows={3}
            value={continuityFactDraft.statement}
            disabled={continuityFactBusy}
            onChange={(event) => setContinuityFactDraft(current => current ? { ...current, statement: event.target.value } : current)}
          />
        </label>
        <div className="continuity-fact-editor-grid">
          <label><span>类型</span><select value={continuityFactDraft.kind} disabled={continuityFactBusy}
            onChange={(event) => setContinuityFactDraft(current => current ? { ...current, kind: event.target.value as ContinuityFact["kind"] } : current)}>
            {["milieu", "character", "location", "event", "object", "relationship", "organization", "other"].map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <label><span>范围</span><select value={continuityFactDraft.scopeKind} disabled={continuityFactBusy}
            onChange={(event) => setContinuityFactDraft(current => current ? { ...current, scopeKind: event.target.value as ContinuityFact["scopeKind"] } : current)}>
            {["global", "era", "arc", "chapter", "location", "character"].map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <label><span>认知状态</span><select value={continuityFactDraft.epistemic} disabled={continuityFactBusy}
            onChange={(event) => setContinuityFactDraft(current => current ? { ...current, epistemic: event.target.value as ContinuityFact["epistemic"] } : current)}>
            {["objective", "character_knowledge", "rumor"].map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <label><span>状态</span><select value={continuityFactDraft.status} disabled={continuityFactBusy}
            onChange={(event) => setContinuityFactDraft(current => current ? { ...current, status: event.target.value as ContinuityFact["status"] } : current)}>
            {["active", "conflict", "pending", "stale", "retracted"].map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <label><span>范围值</span><input value={continuityFactDraft.scopeValue} disabled={continuityFactBusy}
            onChange={(event) => setContinuityFactDraft(current => current ? { ...current, scopeValue: event.target.value } : current)} /></label>
          <label><span>重要度</span><input type="number" min={0} max={100} value={continuityFactDraft.importance}
            disabled={continuityFactBusy}
            onChange={(event) => setContinuityFactDraft(current => current ? { ...current, importance: Number(event.target.value) } : current)} /></label>
          <label><span>起始</span><input value={continuityFactDraft.validFrom} disabled={continuityFactBusy}
            onChange={(event) => setContinuityFactDraft(current => current ? { ...current, validFrom: event.target.value } : current)} /></label>
          <label><span>结束</span><input value={continuityFactDraft.validUntil} disabled={continuityFactBusy}
            onChange={(event) => setContinuityFactDraft(current => current ? { ...current, validUntil: event.target.value } : current)} /></label>
        </div>
        <label><span>知情者</span>
          <input value={continuityFactDraft.knownBy.join("、")} disabled={continuityFactBusy}
            onChange={(event) => setContinuityFactDraft(current => current ? { ...current, knownBy: event.target.value.split(/[、,，]/).map(item => item.trim()).filter(Boolean) } : current)} />
        </label>
        <div className="continuity-fact-editor-grid source">
          <label><span>来源路径</span>
            <input value={continuityFactDraft.sourcePath} disabled={continuityFactBusy}
              onChange={(event) => setContinuityFactDraft(current => current ? { ...current, sourcePath: event.target.value } : current)} />
          </label>
          <label><span>来源原文</span>
            <input value={continuityFactDraft.sourceEvidence} disabled={continuityFactBusy}
              onChange={(event) => setContinuityFactDraft(current => current ? { ...current, sourceEvidence: event.target.value } : current)} />
          </label>
        </div>
        <div className="prose-gate-editor-actions">
          <button className="primary" disabled={continuityFactBusy || !continuityFactDraft.statement.trim()}
            onClick={() => void saveContinuityFact()}><Save size={15} />保存</button>
          <button disabled={continuityFactBusy} onClick={() => setContinuityFactDraft(null)}>取消</button>
        </div>
      </div>
    )}
    <div className="continuity-fact-list">
      {(state.continuityFacts ?? []).map(fact => (
        <article className={`continuity-fact-card status-${fact.status}`} key={fact.id}>
          <div className="continuity-fact-card-head">
            <div>
              <span className={`continuity-fact-kind kind-${fact.kind}`}>{fact.kind}</span>
              <span className={`continuity-fact-status status-${fact.status}`}>{fact.status}</span>
            </div>
            <small>{fact.scopeKind}{fact.scopeValue ? ` · ${fact.scopeValue}` : ""}</small>
          </div>
          <p>{fact.statement}</p>
          <div className="continuity-fact-meta">
            <span>重要度 {fact.importance}</span>
            <span>{fact.epistemic}</span>
            {fact.validFrom && <span>from {fact.validFrom}</span>}
            {fact.validUntil && <span>until {fact.validUntil}</span>}
          </div>
          {fact.sourceEvidence && <blockquote>{fact.sourceEvidence}</blockquote>}
          <div className="prose-gate-card-foot">
            <time dateTime={fact.updatedAt}>更新于 {new Date(fact.updatedAt).toLocaleString()}</time>
            <div>
              <button className="ghost" disabled={continuityFactBusy || readOnly || Boolean(continuityFactDraft)}
                onClick={() => setContinuityFactDraft({
                  id: fact.id,
                  statement: fact.statement,
                  kind: fact.kind,
                  scopeKind: fact.scopeKind,
                  scopeValue: fact.scopeValue,
                  validFrom: fact.validFrom,
                  validUntil: fact.validUntil,
                  epistemic: fact.epistemic,
                  knownBy: fact.knownBy,
                  importance: fact.importance,
                  status: fact.status,
                  sourcePath: fact.sourcePath,
                  sourceEvidence: fact.sourceEvidence,
                  conflictsWith: fact.conflictsWith,
                  supersedes: fact.supersedes,
                })}><Pencil size={14} />编辑</button>
              {fact.status !== "retracted" && (
                <button className="ghost danger" disabled={continuityFactBusy || readOnly}
                  onClick={() => void retractContinuityFact(fact)}><Trash2 size={14} />撤回</button>
              )}
            </div>
          </div>
        </article>
      ))}
      {(state.continuityFacts ?? []).length === 0 && (
        <div className="management-empty">暂无连续性事实。接受新的设定或正文后会增量提取，也可以手动添加。</div>
      )}
    </div>
  </div>;

  return (
    <WorkspaceShell mode={workspaceMode} documentsCollapsed={documentsCollapsed} readOnly={readOnly}>
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
        readOnly={readOnly}
        settingsOpen={settingsMenuOpen}
        moreOpen={headerMoreOpen}
        workspaceMode={workspaceMode}
        documentsCollapsed={documentsCollapsed}
        onCharacters={() => {
          setHeaderMoreOpen(false);
          setSessionBatchMode(false);
          setSelectedSessionIds(new Set());
          setManagementView("characters");
        }}
        onRoleplay={() => {
          setHeaderMoreOpen(false);
          beginRoleplaySetup();
        }}
        onSessions={() => {
          setHeaderMoreOpen(false);
          setSessionBatchMode(false);
          setSelectedSessionIds(new Set());
          setManagementView("sessions");
        }}
        onUsage={() => setShowUsagePopover(true)}
        onShare={() => void createReadonlyShareLink()}
        onConnection={() => {
          setConnectionPanelMsg("");
          openSettings("connection");
        }}
        onToggleSettings={() => {
          setHeaderMoreOpen(false);
          setSettingsMenuOpen((value) => !value);
        }}
        onCloseSettings={() => setSettingsMenuOpen(false)}
        onSelectSettings={openSettings}
        onReviewRules={openProseGateRules}
        onContinuityFacts={openContinuityFacts}
        onToggleMore={() => {
          setSettingsMenuOpen(false);
          setHeaderMoreOpen((value) => !value);
        }}
        onCloseMore={() => setHeaderMoreOpen(false)}
        onRefresh={() => void refresh(state.sessionId)}
        onModeChange={setWorkspaceMode}
        onToggleDocuments={() => setDocumentsCollapsed((value) => !value)}
      />
      {readOnly && (
        <div className="readonly-banner" role="status">
          <LockKeyhole size={14} />
          只读模式：可以浏览和导出内容，不能聊天、编辑、审批或修改项目设置。
        </div>
      )}

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
            <h2>{documentSidebarMode === "chapters" ? "章节管理" : "项目文件"}</h2>
          </div>
          <span className="file-manager-count">
            {documentSidebarMode === "chapters"
              ? `${chapters.length} 章 · ${totalChapterWords.toLocaleString("zh-CN")} 字`
              : fileQuery.trim() ? `${state.documents.length - visibleTree.reduce((sum, node) => sum + countFiles(node), 0)} 条已筛除` : `${state.documents.length} 篇`}
          </span>
        </div>

        <div className="document-mode-switch" role="tablist" aria-label="文档视图">
          <button type="button" role="tab" aria-selected={documentSidebarMode === "chapters"} className={documentSidebarMode === "chapters" ? "active" : ""} onClick={() => setDocumentSidebarMode("chapters")}>
            <BookOpenText size={14} />章节
          </button>
          <button type="button" role="tab" aria-selected={documentSidebarMode === "files"} className={documentSidebarMode === "files" ? "active" : ""} onClick={() => setDocumentSidebarMode("files")}>
            <Folder size={14} />全部文件
          </button>
        </div>

        <div className="file-manager-tools">
          <label className="file-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={fileSearchRef}
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder={documentSidebarMode === "chapters" ? "搜索章节标题或路径…" : "搜索文件或路径…"}
              aria-label="搜索项目文件"
              aria-keyshortcuts="/"
            />
            {fileQuery && <button type="button" title="清除搜索" onClick={() => setFileQuery("")}><X size={13} /></button>}
          </label>
          <div className="file-view-actions">
            {documentSidebarMode === "files" && <>
              <button type="button" title="展开全部" onClick={() => setExpandedFolders(new Set(collectFolderPaths(tree)))}>
                <ChevronDown size={14} />
              </button>
              <button type="button" title="收起全部" onClick={() => setExpandedFolders(new Set())}>
                <Minus size={14} />
              </button>
            </>}
            <button type="button" title="刷新" onClick={() => void Promise.all([refresh(state.sessionId), loadChapters()])}>
              <RefreshCw size={14} />
            </button>
          </div>
        </div>
        {!readOnly && <div className="file-manager-actions">
          {documentSidebarMode === "chapters" ? <>
            <button type="button" className="fm-btn" onClick={() => handleNewChapter()}>
              <FilePlus2 size={15} aria-hidden="true" />新建章节
            </button>
            <button type="button" className="fm-btn" onClick={handleNewVolume}>
              <FolderPlus size={15} aria-hidden="true" />新建卷
            </button>
          </> : <>
            <button type="button" className="fm-btn" onClick={() => { setCreating({ parent: "", kind: "file" }); setCreateValue("新文档"); }}>
              <FilePlus2 size={15} aria-hidden="true" />新建文档
            </button>
            <button type="button" className="fm-btn" onClick={() => { setCreating({ parent: "", kind: "folder" }); setCreateValue("新文件夹"); }}>
              <FolderPlus size={15} aria-hidden="true" />新建文件夹
            </button>
          </>}
        </div>}

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
          {documentSidebarMode === "chapters" ? (
            chaptersLoading && chapters.length === 0
              ? <div className="sidebar-empty compact"><RefreshCw size={22} /><span>正在整理章节…</span></div>
              : <ChapterManager
                  groups={chapterGroups}
                  query={fileQuery}
                  activePath={activePath}
                  readOnly={readOnly}
                  collapsed={collapsedChapterVolumes}
                  onToggleGroup={(id) => setCollapsedChapterVolumes(current => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id); else next.add(id);
                    return next;
                  })}
                  onSelect={(path) => { setActivePath(path); setMobileTab("editor"); }}
                  onVersions={(path) => void openChapterVersions(path)}
                  onRename={handleRename}
                  onDelete={handleDelete}
                  onDuplicate={handleDuplicate}
                  onMove={handleMoveNode}
                  onRequestMove={requestMoveChapter}
                  onArchive={handleArchive}
                  onNewChapter={handleNewChapter}
                />
          ) : tree.length === 0 ? (
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
                  onArchive={handleArchive}
                  onUnarchive={handleUnarchive}
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
            {activePath && (
              <span className="document-reading-stats">
                {visibleDocumentWordCount.toLocaleString("zh-CN")} 字
                {!browsingVersion && !editingDocument && <> · 阅读 {Math.round(readingProgress * 100)}%</>}
              </span>
            )}
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
              onClick={() => openSettings("style")}
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
                <button
                  className="mobile-reader-action"
                  disabled={!activePath || focusedExportBusy}
                  onClick={() => void exportFocusedDocument()}
                  title="下载当前正在浏览的 Markdown 文件"
                  aria-label="下载当前文档"
                >
                  <Download size={14} /><span className="mobile-reader-action-label">下载</span>
                </button>
              )}
              {browsingVersion ? (
                <>
                  {!readOnly && !browsingVersion.isCurrent && (
                    <button disabled={versionBusy} onClick={() => void restoreBrowsingVersion()} title="把这个历史快照恢复为新的当前版本">
                      <RotateCcw size={14} />恢复此版本
                    </button>
                  )}
                  <button className="primary" onClick={exitVersionBrowse} title="回到磁盘上的当前版本">
                    返回当前
                  </button>
                </>
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
                    className={`mobile-reader-action${versionPanelOpen ? " active" : ""}`}
                    disabled={!activePath}
                    onClick={() => void toggleVersionPanel()}
                    title="浏览文档历史版本（只读，Agent 仅见当前版）"
                    aria-label="浏览文档版本历史"
                  >
                    <History size={14} /><span className="mobile-reader-action-label">版本</span>
                  </button>
                  <button
                    className="mobile-reader-action"
                    disabled={!activePath || readOnly}
                    onClick={() => setEditingDocument(true)}
                    title="编辑当前文档"
                    aria-label="编辑当前文档"
                  >
                    <Pencil size={14} /><span className="mobile-reader-action-label">编辑</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
        {editingDocument ? (
          <textarea ref={documentEditorRef} value={documentDraft} onChange={(e) => setDocumentDraft(e.target.value)} />
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
            <div
              className="document-reader"
              ref={documentReaderRef}
              onScroll={handleReaderScroll}
              onMouseUp={handleReaderTextSelection}
              onKeyUp={handleReaderTextSelection}
            >
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
            {readerSelection && (
              <div
                className="reader-selection-toolbar"
                style={{ left: readerSelection.left, top: readerSelection.top }}
                role="toolbar"
                aria-label="选中文字操作"
                onMouseDown={event => event.preventDefault()}
              >
                <span>{readerSelection.blockCount > 1 ? "跨段" : "选段"} · {documentWordCount(readerSelection.text)} 字</span>
                <button type="button" onClick={addReaderSelectionToContext}>
                  <MessageSquare size={13} />加入上下文
                </button>
                <button type="button" className="primary" onClick={editReaderSelectionDirectly}>
                  <Pencil size={13} />直接编辑
                </button>
              </div>
            )}
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
            <button
              type="button"
              className="ghost context-graph-open-btn"
              title="查看上下文图（任务 / 衔接 / 装载）"
              onClick={() => void openContextGraph()}
            >
              <GitBranch size={15} aria-hidden="true" />
              <span>上下文图</span>
            </button>
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
          <div className="agent-mode-controls">
            <div className="permission-mode-switch" role="group" aria-label="Permission mode">
              {PERMISSION_MODES.map((mode) => {
                const active = (state.agentSettings?.permissionMode ?? "ask") === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    className={`permission-mode-btn${active ? " active" : ""}`}
                    title={mode.hint}
                    disabled={busy || Boolean(roleplay) || readOnly}
                    onClick={() => void setPermissionMode(mode.id)}
                  >
                    {mode.label}
                  </button>
                );
              })}
              <span className="agent-mode-divider" aria-hidden="true" />
              <button
                type="button"
                className={`permission-mode-btn fast-mode-btn${state.agentSettings?.writingMode === "fast" ? " active" : ""}`}
                title={state.agentSettings?.writingMode === "fast"
                  ? "关闭快速模式，恢复 Agent 分工与隔离 Writer"
                  : "开启传统快速模式；全部写作步骤使用 Agent，不调用正文 Writer"}
                aria-pressed={state.agentSettings?.writingMode === "fast"}
                disabled={busy || Boolean(roleplay) || readOnly}
                onClick={() => void toggleFastWritingMode()}
              >
                <Zap size={11} aria-hidden="true" />
                Fast
              </button>
              <button
                type="button"
                className={`permission-mode-btn fast-mode-btn${state.agentSettings?.scenePipeline.enabled ? " active" : ""}`}
                title={state.agentSettings?.scenePipeline.enabled
                  ? "关闭场景链；正文直接成稿"
                  : "开启可选场景链；仅在长篇连续状态确有收益时使用"}
                aria-pressed={state.agentSettings?.scenePipeline.enabled ?? false}
                disabled={busy || Boolean(roleplay) || readOnly}
                onClick={() => void toggleScenePipeline()}
              >
                <ListOrdered size={11} aria-hidden="true" />
                场景链
              </button>
            </div>
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
                {roleplay.scene && <span className="roleplay-scene-chip">
                  {roleplay.sceneSequence.length > 1 ? `${roleplay.sceneIndex + 1}/${roleplay.sceneSequence.length} · ` : ""}{roleplay.scene.name}
                </span>}
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
                      <div><dt>地点/时间</dt><dd>{roleplay.scene.setting}</dd></div>
                      <div><dt>场景要点</dt><dd>{roleplay.scene.premise}</dd></div>
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
              <div className="roleplay-action-group roleplay-action-group-primary">
                <button type="button" disabled={busy} title={`让「${roleplay.performer.name}」根据场景先开口`} onClick={() => void requestRoleplayOpening()}>
                  <Drama size={13} aria-hidden="true" />主动开场
                </button>
                <button
                  type="button"
                  className="roleplay-primary-action"
                  disabled={busy || Boolean(roleplayAutoReplyBusy)}
                  title={`让「${roleplay.performer.name}」在没有新玩家输入时继续演绎当前场景`}
                  onClick={() => void requestPerformerAutoReply()}
                >
                  <MessageSquare size={13} aria-hidden="true" />{roleplayAutoReplyBusy === "performer" ? "续演中…" : "角色续演"}
                </button>
                <button
                  type="button"
                  disabled={busy || Boolean(roleplayAutoReplyBusy)}
                  title={`让「${roleplay.identity.name}」生成一段简短的下一轮草稿`}
                  onClick={() => void requestRoleplayAutoReply()}
                >
                  <WandSparkles size={13} aria-hidden="true" />{roleplayAutoReplyBusy === "identity" ? "生成中…" : "身份代答"}
                </button>
                {roleplay.identity.kind === "generated" && (
                  <button type="button" disabled={busy} onClick={() => void saveCurrentRoleplayInterlocutor()}>保存身份</button>
                )}
              </div>
              <div className="roleplay-action-group roleplay-action-group-secondary">
                <button type="button" disabled={busy} onClick={() => setRoleplaySceneManagerOpen(true)} title="场景管理与场景序列">
                  <ListOrdered size={13} aria-hidden="true" /><span>场景</span>
                </button>
                <details className={`roleplay-rating-menu rating-${roleplay.contentRating ?? "default"}`}>
                  <summary title={`内容分级：${(roleplay.contentRating ?? "default") === "default" ? "默认" : (roleplay.contentRating ?? "default").toUpperCase()}`}>
                    <ShieldCheck size={13} aria-hidden="true" /><span>分级</span>
                  </summary>
                  <div role="menu" aria-label="角色扮演内容分级">
                    {(["default", "sfw", "nsfw"] as RoleplayContentRating[]).map(contentRating => {
                      const active = (roleplay.contentRating ?? "default") === contentRating;
                      return (
                        <button
                          key={contentRating}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          className={active ? "active" : ""}
                          disabled={busy}
                          title={contentRating === "default" ? "沿用角色与场景设定" : contentRating === "sfw" ? "强制非露骨内容" : "强制成人向内容；仅限明确成年角色"}
                          onClick={(event) => {
                            event.currentTarget.closest("details")?.removeAttribute("open");
                            void updateRoleplayContentRating(contentRating);
                          }}
                        >
                          <span>{contentRating === "default" ? "默认" : contentRating.toUpperCase()}</span>
                        </button>
                      );
                    })}
                  </div>
                </details>
                <button type="button" disabled={busy} onClick={() => setRoleplayMemoryOpen(true)} title="事实记忆">
                  <History size={13} aria-hidden="true" /><span>记忆</span>
                </button>
                <button type="button" disabled={busy} onClick={() => beginRoleplaySetup()} title="更换角色与场景设定">
                  <Settings size={13} aria-hidden="true" /><span>设定</span>
                </button>
                <button type="button" className="roleplay-exit-button" disabled={busy} onClick={() => void exitRoleplay()} title="退出角色扮演">
                  <X size={13} aria-hidden="true" /><span>退出</span>
                </button>
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
              const directorMessage = msg.role === "user" && msg.channel === "roleplay" && msg.roleplayInputMode === "director";
              const continuationMessage = msg.role === "user" && msg.channel === "roleplay"
                && displayContent === ROLEPLAY_CONTINUATION_PLACEHOLDER;
              const interruptedAgentMessage = msg.role === "assistant" && msg.channel !== "roleplay"
                && displayContent.includes("[生成已中断]");
              const resumableAgentStepAnchor = msg.role === "user" && msg.channel !== "roleplay"
                && (
                  (streamStepsAnchorId === msg.id && streamSteps.length > 0)
                  || Boolean(state.stepTrails?.some((trail) => trail.sourceMessageId === msg.id && trail.steps.length > 0))
                );
              return (
            <article className={`${msg.role}${msg.channel === "roleplay" ? " roleplay-msg" : ""}${directorMessage ? " roleplay-director-msg" : ""}${continuationMessage ? " roleplay-continuation-msg" : ""}${assistantCollapsed ? " collapsed" : ""}`}>
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
              ) : !continuationMessage ? (
                <div className="msg-label">
                  {directorMessage
                    ? <><Drama size={12} aria-hidden="true" /><span>导演指令</span></>
                    : <span>You</span>}
                  {msg.channel === "roleplay" && !directorMessage ? (
                    <span
                      className="msg-channel-tag"
                      title={msg.roleplayInputMode === "director" ? "导演指示" : "角色内消息"}
                    >
                      {msg.roleplayInputMode === "director" ? "导演" : "扮演"}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {msg.role === "assistant" ? (
                assistantCollapsed
                  ? <p className="msg-preview">{messagePreview(displayContent)}</p>
                  : <Markdown content={displayContent} />
              ) : (
                <>
                  {msg.attachments?.length ? (
                    <div className="message-attachments" aria-label="附图">
                      {msg.attachments.map((item) => {
                        const localPreview = item.storagePath.startsWith("blob:") || item.storagePath.startsWith("data:");
                        const src = msg.id > 0
                          ? attachmentImageUrl(state.sessionId, item.id)
                          : localPreview
                            ? item.storagePath
                            : "";
                        return (
                          <a
                            key={item.id}
                            className="message-attachment-thumb"
                            href={src || "#"}
                            target="_blank"
                            rel="noreferrer"
                            title={item.name}
                          >
                            {src ? (
                              <img src={src} alt={item.name} loading="lazy" />
                            ) : (
                              <span className="message-attachment-fallback">{item.name}</span>
                            )}
                          </a>
                        );
                      })}
                    </div>
                  ) : null}
                  {msg.channel === "roleplay"
                    ? continuationMessage
                      ? <div className="roleplay-continuation-placeholder">
                          <RefreshCw size={14} aria-hidden="true" />
                          <strong>续演</strong>
                          <span>角色主动推进当前场景</span>
                          {msg.id > 0 && (
                            <button
                              type="button"
                              className="roleplay-continuation-rerun"
                              disabled={busy}
                              onClick={() => requestRerunMessage(msg)}
                              title="重新运行续演"
                              aria-label="重新运行续演"
                            >
                              <RefreshCw size={13} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      : <Markdown content={displayContent} />
                    : displayContent ? <div>{displayContent}</div> : null}
                  {msg.channel === "roleplay" && msg.roleplayInputMode !== "director" && msg.roleplayPerception
                    && displayContent !== ROLEPLAY_CONTINUATION_PLACEHOLDER
                    ? <RoleplayPerceptionDetails
                        content={msg.roleplayPerception}
                        data={msg.roleplayPerceptionData}
                        disabled={busy}
                        onSave={(value) => saveRoleplayPerception(msg, value)}
                        onReplay={(value) => saveAndReplayRoleplayPerception(msg, value)}
                      />
                    : null}
                </>
              )}
              {msg.id > 0 && !continuationMessage && <div className="message-actions">
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
                {msg.role === "user" && !continuationMessage && <button disabled={busy} onClick={() => requestRewindMessage(msg)} title="从此消息重新编辑">编辑</button>}
                {(interruptedAgentMessage || resumableAgentStepAnchor) && <button disabled={busy || readOnly} onClick={() => void resumeInterruptedAgent(msg)} title="从中断处继续运行 Agent">续跑</button>}
                <button disabled={busy} onClick={() => requestRerunMessage(msg)} title="重新运行这条消息所在的轮次">重新运行</button>
                {msg.channel === "roleplay" && msg.variantGroupId && (msg.variantCount ?? 1) > 1
                  ? <button disabled={busy} onClick={() => void openRoleplayBranchTimeline(msg)} title="查看并切换这一轮保存的完整对话分支">分支</button>
                  : null}
                {msg.channel === "roleplay" && msg.roleplayInputMode !== "director" && !continuationMessage && <button disabled={busy} onClick={() => { setRoleplayFactDraft(newFactDraft(msg)); setRoleplayMemoryOpen(true); }} title="把这条消息保存为可纠错的事实记忆">记住</button>}
              </div>}
            </article>
              );
            })()}
            {(() => {
              // Live buffer only for the turn currently streaming (or the brief
              // post-complete gap before stepTrails catches up). Never let live
              // steps shadow a different message's server trail.
              const liveHere = streamStepsAnchorId === msg.id && streamSteps.length > 0;
              const serverTrail = state.stepTrails?.find((trail) => trail.sourceMessageId === msg.id);
              const stepsHere = liveHere
                ? streamSteps
                : serverTrail
                  ? stepsFromServerTrail(serverTrail).map((step) => {
                      const key = `${msg.id}:${step.id}`;
                      return stepTrailExpanded[key] !== undefined
                        ? { ...step, expanded: stepTrailExpanded[key] }
                        : step;
                    })
                  : [];
              if (!stepsHere.length) return null;
              return (
              <>
                {stepsHere.map((step, index) => (
                  <AgentStepCard
                    key={`${msg.id}-${step.id}`}
                    step={step}
                    prevStep={index > 0 ? stepsHere[index - 1] : undefined}
                    onToggle={() => {
                      if (liveHere) {
                        updateStreamSteps((current) =>
                          current.map((s) => (s.id === step.id ? { ...s, expanded: !s.expanded } : s)),
                        );
                        return;
                      }
                      // Keep expand state local — never promote history into the live buffer.
                      const key = `${msg.id}:${step.id}`;
                      setStepTrailExpanded((current) => ({
                        ...current,
                        [key]: !(current[key] ?? false),
                      }));
                    }}
                  />
                ))}
                {(() => {
                  const total = sumStepUsage(stepsHere);
                  if (!total || stepsHere.length < 1) return null;
                  return (
                    <div className="agent-step-trail-total" title={stepUsageTitle(total)}>
                      <span>本轮合计{total.estimated ? "（含估算）" : ""}</span>
                      <StepTokenBadge usage={total} />
                    </div>
                  );
                })()}
              </>
              );
            })()}
            </React.Fragment>
          ))}
          {/* Steps for a turn whose user bubble is not in the filtered list yet. */}
          {streamSteps.length > 0 && streamStepsAnchorId != null
            && !visibleMessages.some((msg) => msg.id === streamStepsAnchorId) && (
            <>
              {streamSteps.map((step, index) => (
                <AgentStepCard
                  key={`orphan-${step.id}`}
                  step={step}
                  prevStep={index > 0 ? streamSteps[index - 1] : undefined}
                  onToggle={() =>
                    updateStreamSteps((current) =>
                      current.map((s) => (s.id === step.id ? { ...s, expanded: !s.expanded } : s)),
                    )
                  }
                />
              ))}
            </>
          )}
          {state.messages.length === 0 && streamSteps.length === 0 && !(state.stepTrails?.length) && (
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
            {!roleplay && documentContextSelections.length > 0 && (
              <div className="composer-context-selections" aria-label="下一次请求的文档上下文">
                <div className="composer-context-heading">
                  <span>文档上下文 · {documentContextSelections.length} 段</span>
                  <button type="button" disabled={busy} onClick={() => setDocumentContextSelections([])}>清空</button>
                </div>
                <div className="composer-context-chips">
                  {documentContextSelections.map(selection => (
                    <span className="composer-context-chip" key={selection.id} title={selection.text}>
                      <FileText size={12} />
                      <span>{selection.path.split("/").at(-1)} · {documentWordCount(selection.text)} 字</span>
                      <button
                        type="button"
                        aria-label={`移除 ${selection.path} 选段`}
                        disabled={busy}
                        onClick={() => setDocumentContextSelections(current => current.filter(item => item.id !== selection.id))}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {roleplay && roleplayInputMode === "director" && (
              <div className="director-mode-guide" role="note">
                <div className="director-mode-guide-title">
                  <div>
                    <span>导演模式</span>
                    <small>推荐用于推进与校准剧情</small>
                  </div>
                  <button type="button" disabled={busy || directorSuggestionBusy} onClick={() => void requestDirectorSuggestions()}>
                    {directorSuggestionBusy ? "建议生成中…" : directorSuggestions.length ? "换一组" : "导演建议"}
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
                    : <span className="director-mode-empty">由当前角色模型读取现场目标、张力与最近对话，生成三个具体的下一拍选择。</span>}
                </div>
              </div>
            )}
            {!roleplay && pendingAttachments.length > 0 && (
              <div className="composer-attachments" aria-label="待发送附图">
                {pendingAttachments.map((item) => (
                  <span className="composer-attachment-chip" key={item.localId} title={item.name}>
                    <img src={item.previewUrl} alt={item.name} />
                    <button
                      type="button"
                      className="composer-attachment-remove"
                      aria-label={`移除 ${item.name}`}
                      disabled={busy}
                      onClick={() => setPendingAttachments((current) => {
                        const target = current.find((entry) => entry.localId === item.localId);
                        if (target) URL.revokeObjectURL(target.previewUrl);
                        return current.filter((entry) => entry.localId !== item.localId);
                      })}
                    >
                      <X size={11} strokeWidth={2.5} />
                    </button>
                  </span>
                ))}
                <span className="composer-attachments-meta">
                  {pendingAttachments.length}/{MULTIMODAL_MAX_ATTACHMENTS}
                </span>
              </div>
            )}
            <textarea
              ref={composerRef}
              value={prompt}
              onFocus={() => { composerFocusedAtBottomRef.current = conversationAtBottomRef.current; }}
              onBlur={() => { composerFocusedAtBottomRef.current = false; }}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={(event) => {
                if (roleplay || readOnly || busy) return;
                const files = Array.from(event.clipboardData?.files ?? []).filter(isSupportedComposerImage);
                if (!files.length) return;
                event.preventDefault();
                void addComposerImages(files);
              }}
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
              placeholder={readOnly
                ? "只读分享模式不能发送消息"
                : roleplay
                  ? roleplayInputMode === "director"
                    ? "输入导演指示，例如：加快节奏，让冲突在三轮内升级…"
                    : `以「${roleplay.identity.name}」身份对「${roleplay.performer.name}」说话…（Ctrl+Enter 发送）`
                  : agentSupportsMultimodal
                    ? "写作任务…可粘贴或添加图片（Ctrl+Enter 发送）"
                    : "写作任务…（Ctrl+Enter 发送；附图需模型开启多模态）"}
              disabled={readOnly || busy || Boolean(roleplayAutoReplyBusy)}
            />
            <div className="composer-actions">
              <span className="composer-hint">
                {busy
                  ? "Esc to stop"
                  : roleplay
                    ? `${roleplayInputMode === "director" ? "导演指示" : "角色内"} · Ctrl+Enter`
                    : agentSupportsMultimodal
                      ? "粘贴或添加图片 · Ctrl+Enter"
                      : "Ctrl+Enter"}
              </span>
              <div className="composer-actions-right">
                {!roleplay && (
                  <>
                    <input
                      ref={attachmentInputRef}
                      type="file"
                      className="composer-file-input"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      multiple
                      tabIndex={-1}
                      aria-hidden="true"
                      onChange={(event) => {
                        const files = event.target.files;
                        if (files?.length) void addComposerImages(files);
                        event.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      className={`composer-attach${pendingAttachments.length ? " has-files" : ""}${agentSupportsMultimodal ? "" : " muted"}`}
                      title={agentSupportsMultimodal
                        ? "添加图片（可多选，也可直接粘贴）"
                        : "添加图片（当前 Agent 模型未开启多模态，将以文字占位发送）"}
                      aria-label="添加图片"
                      disabled={readOnly || busy || pendingAttachments.length >= MULTIMODAL_MAX_ATTACHMENTS}
                      onClick={() => attachmentInputRef.current?.click()}
                    >
                      <ImagePlus size={16} strokeWidth={1.9} />
                      {pendingAttachments.length > 0 && (
                        <span className="composer-attach-badge">{pendingAttachments.length}</span>
                      )}
                    </button>
                  </>
                )}
                <button
                  className={`composer-send ${busy ? "stop" : "primary"}`}
                  onClick={busy ? stop : () => void sendChat()}
                  disabled={readOnly || Boolean(roleplayAutoReplyBusy) || (!busy && !prompt.trim() && !pendingAttachments.length)}
                >
                  {busy ? "Stop" : "Send"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {movingChapter && (() => {
        const currentFolder = movingChapter.path.slice(0, movingChapter.path.lastIndexOf("/"));
        const targets = chapterGroups.filter(group => group.folderPath !== currentFolder);
        return (
          <div className="modal-backdrop" role="presentation" onMouseDown={() => setMovingChapter(null)}>
            <div
              className="modal chapter-move-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="chapter-move-title"
              onMouseDown={event => event.stopPropagation()}
            >
              <h2 id="chapter-move-title">移动章节</h2>
              <p>将“{movingChapter.title}”移动到其他卷。文件名和版本历史保持不变。</p>
              <label>
                <span>目标卷</span>
                <select value={moveChapterTarget} onChange={event => setMoveChapterTarget(event.target.value)} autoFocus>
                  {targets.map(group => (
                    <option key={group.id} value={group.folderPath}>{group.label}</option>
                  ))}
                </select>
              </label>
              <div className="modal-actions">
                <button type="button" onClick={() => setMovingChapter(null)}>取消</button>
                <button type="button" className="primary" disabled={!moveChapterTarget} onClick={() => void submitMoveChapter()}>
                  <FolderInput size={14} />移动
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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
            {branchConfirm.message.channel === "roleplay" && branchConfirm.inputMode && (
              <div className="roleplay-input-mode" role="group" aria-label="重新发送的角色扮演输入模式">
                <button
                  type="button"
                  className={branchConfirm.inputMode === "dialogue" ? "active" : ""}
                  onClick={() => setBranchConfirm(current => current ? { ...current, inputMode: "dialogue" } : current)}
                >
                  角色内
                </button>
                <button
                  type="button"
                  className={branchConfirm.inputMode === "director" ? "active" : ""}
                  onClick={() => setBranchConfirm(current => current ? {
                    ...current,
                    inputMode: "director",
                    perceptionOverride: undefined,
                  } : current)}
                >
                  导演
                </button>
              </div>
            )}
            {branchConfirm.mode === "rerun" && branchConfirm.message.channel === "roleplay" && (
              <fieldset className="roleplay-rerun-directions">
                <legend>演出调整</legend>
                <div className="roleplay-rerun-sliders">
                  {ROLEPLAY_RERUN_SLIDERS.map(slider => {
                    const value = branchConfirm.rerunControls[slider.id];
                    return <label key={slider.id}>
                      <span className="roleplay-slider-heading">
                        <strong>{slider.label}</strong>
                        <small>{value === 0 ? "默认" : value < 0 ? slider.low : slider.high}{value === 0 ? "" : ` ${Math.abs(value)}/2`}</small>
                      </span>
                      <span className="roleplay-slider-control">
                        <small>{slider.low}</small>
                        <input
                          type="range"
                          min="-2"
                          max="2"
                          step="1"
                          value={value}
                          onChange={event => {
                            const next = Number(event.currentTarget.value);
                            setBranchConfirm(current => current ? {
                              ...current,
                              rerunControls: { ...current.rerunControls, [slider.id]: next },
                            } : current);
                          }}
                        />
                        <small>{slider.high}</small>
                      </span>
                    </label>;
                  })}
                </div>
                <div className="roleplay-rerun-options">
                  {ROLEPLAY_RERUN_DIRECTION_OPTIONS.map(option => {
                    const checked = branchConfirm.rerunDirections.includes(option.id);
                    return <label key={option.id} className={checked ? "selected" : ""}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && branchConfirm.rerunDirections.length >= 3}
                        onChange={() => setBranchConfirm(current => current ? {
                          ...current,
                          rerunDirections: checked
                            ? current.rerunDirections.filter(item => item !== option.id)
                            : [...current.rerunDirections, option.id],
                        } : current)}
                      />
                      <span><strong>{option.label}</strong><small>{option.description}</small></span>
                    </label>;
                  })}
                </div>
              </fieldset>
            )}
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

      {roleplayBranchTimeline && (
        <div className="modal-backdrop nested" role="presentation" onMouseDown={() => !roleplayBranchBusy && setRoleplayBranchTimeline(null)}>
          <div className="modal roleplay-branch-modal" role="dialog" aria-modal="true" aria-labelledby="roleplay-branch-title" onMouseDown={event => event.stopPropagation()}>
            <span className="eyebrow">Roleplay branches</span>
            <h2 id="roleplay-branch-title">分支时间线</h2>
            <p>切换会同时恢复该分支的消息、角色感知、现场记忆和来源事实。</p>
            <div className="roleplay-branch-list">
              <div className="roleplay-branch-item current">
                <div><strong>当前分支</strong><span>正在使用的对话上下文</span></div>
                <span className="roleplay-branch-current">当前</span>
              </div>
              {roleplayBranchTimeline.branches.map((branch, index) => (
                <div className="roleplay-branch-item" key={branch.id}>
                  <div>
                    <strong>版本 {roleplayBranchTimeline.branches.length - index}</strong>
                    <span>{branch.preview || branch.label}</span>
                    <small>{new Date(branch.createdAt).toLocaleString()} · {branch.messageCount} 条消息</small>
                  </div>
                  <button type="button" disabled={roleplayBranchBusy} onClick={() => void activateRoleplayBranch(branch)}>切换</button>
                </div>
              ))}
              {!roleplayBranchTimeline.branches.length && <div className="roleplay-branch-empty">还没有可切换的历史分支。</div>}
            </div>
            <div className="modal-actions"><button type="button" disabled={roleplayBranchBusy} onClick={() => setRoleplayBranchTimeline(null)}>关闭</button></div>
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
              <span>场景卡（可选，开始后可编排序列）</span>
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
              <button type="button" disabled={roleplaySetupBusy} onClick={() => beginRoleplaySceneDraft()}>新建场景</button>
              {roleplaySetup.scene && <button type="button" disabled={roleplaySetupBusy} onClick={() => beginRoleplaySceneDraft(roleplaySetup.scene!)}>编辑当前场景</button>}
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

      {roleplaySceneManagerOpen && roleplay && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !roleplaySceneManagerBusy && setRoleplaySceneManagerOpen(false)}>
          <div className="modal roleplay-scene-manager-modal" role="dialog" aria-modal="true" aria-labelledby="roleplay-scene-manager-title" onMouseDown={event => event.stopPropagation()}>
            <div className="roleplay-scene-manager-head">
              <div>
                <span className="eyebrow">Roleplay scenes</span>
                <h2 id="roleplay-scene-manager-title">场景管理</h2>
              </div>
              <button type="button" onClick={() => beginRoleplaySceneDraft()} disabled={roleplaySceneManagerBusy}>
                <Plus size={14} aria-hidden="true" />新建场景
              </button>
            </div>
            <div className="roleplay-scene-manager-layout">
              {state.roleplayMemory?.state.scene && (
                <div className="roleplay-live-scene">
                  <strong>当前现场</strong>
                  <p>{state.roleplayMemory.state.scene}</p>
                </div>
              )}
              <section>
                <header>
                  <strong>当前序列</strong>
                  <small>{roleplay.sceneSequence.length ? `${roleplay.sceneIndex + 1} / ${roleplay.sceneSequence.length}` : "尚未添加"}</small>
                </header>
                <div className="roleplay-scene-sequence">
                  {roleplay.sceneSequence.length ? roleplay.sceneSequence.map((scene, index) => (
                    <div key={scene.id} className={`roleplay-scene-sequence-item${index === roleplay.sceneIndex ? " current" : ""}`}>
                      <button
                        type="button"
                        className="roleplay-scene-sequence-main"
                        disabled={roleplaySceneManagerBusy}
                        onClick={() => void updateRoleplaySceneSequence(roleplay.sceneSequence, index)}
                      >
                        <span>{index + 1}</span>
                        <span><strong>{scene.name}</strong><small>{scene.setting || "未填写地点/时间"}</small></span>
                      </button>
                      <div className="roleplay-scene-sequence-actions">
                        <button type="button" title="上移" disabled={roleplaySceneManagerBusy || index === 0} onClick={() => moveRoleplaySceneInSequence(index, -1)}><ArrowUp size={14} /></button>
                        <button type="button" title="下移" disabled={roleplaySceneManagerBusy || index === roleplay.sceneSequence.length - 1} onClick={() => moveRoleplaySceneInSequence(index, 1)}><ArrowDown size={14} /></button>
                        <button type="button" title="移出序列" disabled={roleplaySceneManagerBusy} onClick={() => removeRoleplaySceneFromSequence(index)}><X size={14} /></button>
                      </div>
                    </div>
                  )) : <div className="roleplay-scene-empty">从右侧场景卡加入场景</div>}
                </div>
              </section>
              <section>
                <header><strong>场景卡</strong><small>{state.roleplayScenes.length} 张</small></header>
                <div className="roleplay-scene-library">
                  {state.roleplayScenes.length ? state.roleplayScenes.map(scene => {
                    const included = roleplay.sceneSequence.some(item => item.id === scene.id);
                    return <article key={scene.id}>
                      <div>
                        <strong>{scene.name}</strong>
                        <small>{scene.setting || "未填写地点/时间"}</small>
                        {scene.premise && <p>{scene.premise}</p>}
                      </div>
                      <div>
                        <button type="button" title="编辑场景" disabled={roleplaySceneManagerBusy} onClick={() => beginRoleplaySceneDraft(scene)}><Pencil size={14} /></button>
                        <button type="button" title={included ? "已在序列中" : "加入序列"} disabled={roleplaySceneManagerBusy || included} onClick={() => addRoleplaySceneToSequence(scene)}><Plus size={14} /></button>
                      </div>
                    </article>;
                  }) : <div className="roleplay-scene-empty">还没有场景卡</div>}
                </div>
              </section>
            </div>
            <div className="modal-actions">
              <button type="button" disabled={roleplaySceneManagerBusy} onClick={() => setRoleplaySceneManagerOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {roleplaySceneDraft && (
        <div className="modal-backdrop nested" role="presentation" onMouseDown={() => !roleplaySceneGenerateBusy && setRoleplaySceneDraft(null)}>
          <div className="modal roleplay-setup-modal roleplay-scene-editor-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <span className="eyebrow">Roleplay scene</span>
            <h2>{roleplaySceneDraft.id ? "编辑场景卡" : "新建场景卡"}</h2>
            <p>只记录本场演出需要的基础信息，可在不同角色和场景序列中复用。</p>
            {!roleplaySceneDraft.id && (
              <div className="roleplay-scene-generator">
                <label>
                  <span>场景描述</span>
                  <textarea
                    autoFocus
                    rows={3}
                    disabled={roleplaySceneGenerateBusy}
                    value={roleplaySceneGenerateRequest}
                    placeholder="例如：第二天清晨，两人在旧港仓库外准备分别，但昨夜的争执还没有解决。"
                    onChange={event => setRoleplaySceneGenerateRequest(event.target.value)}
                    onKeyDown={event => {
                      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void generateRoleplaySceneDraft();
                    }}
                  />
                </label>
                <button type="button" disabled={roleplaySceneGenerateBusy || !roleplaySceneGenerateRequest.trim()} onClick={() => void generateRoleplaySceneDraft()}>
                  <WandSparkles size={14} aria-hidden="true" />{roleplaySceneGenerateBusy ? "生成中…" : "自动生成"}
                </button>
              </div>
            )}
            {([[
              "name", "名称（必填）"], ["setting", "地点/时间"], ["premise", "场景要点"],
            ] as Array<[keyof RoleplaySceneDraft, string]>).map(([field, label]) => <label key={field}>
              <span>{label}</span>
              {field === "name" ? <input value={String(roleplaySceneDraft[field])} onChange={event => setRoleplaySceneDraft({ ...roleplaySceneDraft, [field]: event.target.value })} />
                : <textarea rows={field === "premise" ? 4 : 2} value={String(roleplaySceneDraft[field])} onChange={event => setRoleplaySceneDraft({ ...roleplaySceneDraft, [field]: event.target.value })} />}
            </label>)}
            <div className="modal-actions">
              {roleplaySceneDraft.id && <button type="button" className="danger" disabled={roleplaySceneGenerateBusy} onClick={() => void deleteRoleplayScene(roleplaySceneDraft.id!)}>删除</button>}
              <button type="button" disabled={roleplaySceneGenerateBusy} onClick={() => setRoleplaySceneDraft(null)}>取消</button>
              <button type="button" className="primary" disabled={roleplaySceneGenerateBusy || !roleplaySceneDraft.name.trim()} onClick={() => void saveRoleplayScene()}>保存场景</button>
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
        <div className="modal-backdrop nested" role="presentation" onMouseDown={() => setSimpleCardDraft(null)}>
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
          onMouseDown={() => !styleBusy && setManagementView(null)}
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
                  激活后会注入对应系统提示与范文示例。模型请求参数在供应商配置中独立管理。
                </p>
              </div>
              <IconButton label="关闭" disabled={styleBusy} onClick={() => setManagementView(null)}><X size={17} /></IconButton>
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
                ? "内置模板只读。可查看完整写作指令与范文；模型请求参数由供应商配置独立管理。"
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
            </div>
            <div className="modal-actions">
              <button type="button" disabled={styleBusy} onClick={() => setStyleDraft(null)}>
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
          onMouseDown={() => setManagementView(null)}
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
              <IconButton label="关闭" onClick={() => setManagementView(null)}><X size={17} /></IconButton>
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
              {state.usage.callBreakdown?.map((call, index) => (
                <div className="usage-detail-row usage-model-row" key={`${call.providerName}-${call.model}-${index}`}>
                  <span className="usage-detail-label usage-model-label">
                    <small>{call.providerName}</small>
                    <span>{call.model}</span>
                  </span>
                  <span className="usage-detail-value usage-model-value">
                    <strong>{(call.promptTokens + call.completionTokens).toLocaleString()} tokens</strong>
                    <small>
                      输入 {call.promptTokens.toLocaleString()} · 输出 {call.completionTokens.toLocaleString()} · 缓存 {call.cacheHitTokens.toLocaleString()}
                      {call.cost > 0 ? ` · ${call.currency === "CNY" ? "¥" : "$"}${call.cost.toFixed(6)}` : ""}
                    </small>
                  </span>
                </div>
              ))}
              <div className="usage-detail-row">
                <span className="usage-detail-label">上下文占用</span>
                <span className="usage-detail-value">{usagePct}% · {state.usage.lastPromptTokens.toLocaleString()} / {state.provider.pricing.contextWindow.toLocaleString()}</span>
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
                <span className="usage-detail-value usage-number">{state.provider.pricing.billingMode === "unmetered"
                  ? "非按量计费"
                  : `${state.usage.currency === "CNY" ? "¥" : "$"}${state.usage.cost.toFixed(4)}`}</span>
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
          onMouseDown={() => setManagementView(null)}
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
              <IconButton label="关闭" onClick={() => setManagementView(null)}><X size={17} /></IconButton>
            </div>
            <div className="theme-grid">
              {UI_THEMES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`theme-card${theme === item.id ? " active" : ""}`}
                  onClick={() => {
                    setTheme(item.id);
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
                <h2>{managementView === "characters"
                  ? "角色卡"
                  : managementView === "sessions"
                    ? "会话"
                    : managementView === "prose-gates"
                      ? "作者复审规则"
                      : managementView === "context-graph"
                        ? "上下文图"
                      : "连续性事实"}</h2>
              </div>
              <div className="management-actions">
                {managementView === "context-graph" ? (
                  <button className="ghost" disabled={contextGraphLoading} onClick={() => void loadContextGraph()}>
                    <RefreshCw size={15} />{contextGraphLoading ? "加载中…" : "刷新"}
                  </button>
                ) : managementView === "characters" ? (
                  <>
                    <button className="ghost" onClick={() => setSimpleCardDraft({ name: "", identity: "", relationship: "", knowledge: "", scene: "", goal: "" })}><Plus size={15} />简易角色</button>
                    <button className="primary" onClick={() => setCharacterDraft({ ...EMPTY_CHARACTER })}><Plus size={15} />普通角色</button>
                  </>
                ) : managementView === "sessions" ? (
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
                ) : managementView === "prose-gates" ? (
                  <button
                    className="primary"
                    disabled={proseGateBusy || readOnly || Boolean(proseGateDraft)}
                    onClick={() => setProseGateDraft({
                      id: "",
                      instruction: "",
                      kind: "style_preference",
                      severity: "warn",
                      enabled: true,
                      sourceFeedback: "",
                      isNew: true,
                    })}
                  ><Plus size={15} />新增规则</button>
                ) : (
                  <button
                    className="primary"
                    disabled={continuityFactBusy || readOnly || Boolean(continuityFactDraft)}
                    onClick={() => setContinuityFactDraft({
                      statement: "",
                      kind: "milieu",
                      scopeKind: "global",
                      scopeValue: "",
                      validFrom: "",
                      validUntil: "",
                      epistemic: "objective",
                      knownBy: [],
                      importance: 50,
                      status: "active",
                      sourcePath: "",
                      sourceEvidence: "",
                      conflictsWith: [],
                      supersedes: [],
                    })}
                  ><Plus size={15} />新增事实</button>
                )}
                <button
                  className="icon"
                  aria-label="Close"
                  onClick={() => {
                    setManagementView(null);
                    setProseGateDraft(null);
                    setContinuityFactDraft(null);
                    setSessionBatchMode(false);
                    setSelectedSessionIds(new Set());
                  }}
                ><X size={17} /></button>
              </div>
            </div>

            {managementView === "context-graph" ? (
              <div className="context-graph-panel">
                <div className="context-graph-stats">
                  <span>活跃 {contextGraph?.stats.activeNodes ?? 0}</span>
                  <span>归档 {contextGraph?.stats.archivedNodes ?? 0}</span>
                  <span>衔接 {contextGraph?.stats.handoffCount ?? 0}</span>
                  <span>索引 {contextGraph?.stats.trunkCount ?? contextGraph?.activeTrunks?.length ?? 0}</span>
                  <span>关联 {contextGraph?.stats.edgeCount ?? 0}</span>
                  {(() => {
                    const summary = contextGraphCacheSummary(contextGraph?.nodes ?? []);
                    if (!summary) return null;
                    return (
                      <span
                        className="context-graph-stat-cache"
                        title={`近 ${summary.turns} 轮：输入共 ${summary.promptTokens.toLocaleString()}`}
                      >
                        近 {summary.turns} 轮缓存命中 {Math.round(summary.hitRate * 100)}%
                      </span>
                    );
                  })()}
                  {contextGraph?.truncated ? (
                    <span className="context-graph-stat-truncated">
                      仅显示最近 {contextGraph.nodes.length} / {contextGraph.stats.totalNodes} 个节点
                    </span>
                  ) : null}
                </div>
                <p className="context-graph-hint">
                  查看<strong>章节/场次切换</strong>节点，可知步骤之间继续携带了什么、卸下了什么。
                  步骤条在输入骤降处也会标「上下文收束」。项目索引不含全文；切换后按需再读设定属正常。
                </p>
                {(() => {
                  const cuts = (contextGraph?.nodes ?? [])
                    .filter((node) => node.kind === "assemble_slice")
                    .map((node) => ({ node, transition: contextTransitionFromPayload(node.payload) }))
                    .filter((row) => row.transition && (row.transition.kind === "chapter_boundary" || row.transition.kind === "scene_boundary"))
                    .sort((a, b) => a.node.createdAt.localeCompare(b.node.createdAt));
                  if (!cuts.length) return null;
                  return (
                    <div className="context-graph-cut-timeline" aria-label="上下文收束时间线">
                      <strong>本会话收束</strong>
                      <ol>
                        {cuts.map(({ node, transition }) => {
                          const t = transition!;
                          return (
                            <li key={node.id}>
                              <button
                                type="button"
                                className={contextGraphSelectedId === node.id ? "active" : ""}
                                onClick={() => setContextGraphSelectedId(node.id)}
                              >
                                <span className="cut-kind">
                                  {t.kind === "scene_boundary" ? "场" : "章"}
                                  {t.atStep != null ? ` · Step ${t.atStep}` : ""}
                                </span>
                                <span className="cut-path" title={t.path}>{t.path ? t.path.replace(/^chapters\//, "") : "—"}</span>
                                {t.beforeTokens != null && t.afterTokens != null ? (
                                  <span className="cut-tokens">
                                    {formatGraphTokens(t.beforeTokens)}→{formatGraphTokens(t.afterTokens)}
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  );
                })()}
                <div className="context-graph-filters" role="tablist" aria-label="节点筛选">
                  {([
                    ["all", "全部"],
                    ["active", "活跃"],
                    ["epoch", "任务"],
                    ["handoff", "衔接"],
                    ["slice", "装载"],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      className={contextGraphFilter === id ? "active" : ""}
                      aria-selected={contextGraphFilter === id}
                      onClick={() => setContextGraphFilter(id)}
                    >{label}</button>
                  ))}
                </div>
                {(() => {
                  const filteredNodes = (contextGraph?.nodes ?? []).filter((node) => {
                    if (contextGraphFilter === "all") return true;
                    if (contextGraphFilter === "active") return node.status === "active";
                    if (contextGraphFilter === "epoch") return node.kind === "epoch";
                    if (contextGraphFilter === "handoff") return node.kind === "handoff";
                    if (contextGraphFilter === "slice") return node.kind === "assemble_slice";
                    return true;
                  });
                  return (
                <>
                <ContextGraphCanvas
                  nodes={filteredNodes}
                  edges={contextGraph?.edges ?? []}
                  selectedId={contextGraphSelectedId}
                  onSelect={setContextGraphSelectedId}
                />
                <div className="context-graph-layout">
                  <ul className="context-graph-list">
                    {(() => {
                      // Tree preorder (root → turns → process), matching the canvas — not reverse chronology.
                      const tree = buildContextGraphTree(filteredNodes);
                      const ordered: ContextGraphNode[] = [];
                      const walk = (item: ContextGraphTreeItem | null) => {
                        if (!item) return;
                        // Skip pure-virtual root when it was synthesized (not in the filtered set).
                        if (filteredNodes.some((node) => node.id === item.node.id)) ordered.push(item.node);
                        for (const child of item.children) walk(child);
                      };
                      walk(tree);
                      // Any nodes the tree builder dropped (unexpected kinds) still show up at the end.
                      const seen = new Set(ordered.map((node) => node.id));
                      for (const node of filteredNodes) {
                        if (!seen.has(node.id)) ordered.push(node);
                      }
                      return ordered.map((node) => {
                        const title = contextGraphNodeTitle(node);
                        return (
                          <li key={node.id}>
                            <button
                              type="button"
                              className={`context-graph-node ${contextGraphSelectedId === node.id ? "selected" : ""} status-${node.status}`}
                              onClick={() => setContextGraphSelectedId(node.id)}
                            >
                              <span className="context-graph-kind">{CONTEXT_GRAPH_KIND_LABEL[node.kind] ?? node.kind}</span>
                              <strong title={node.label}>{title || node.label}</strong>
                              <small>
                                {contextGraphStatusLabel(node.status)}
                                {node.sourceMessageId != null ? ` · msg #${node.sourceMessageId}` : ""}
                                {" · "}
                                {new Date(node.createdAt).toLocaleString(undefined, {
                                  month: "numeric",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </small>
                            </button>
                          </li>
                        );
                      });
                    })()}
                    {!contextGraphLoading && !(contextGraph?.nodes.length) && (
                      <li className="context-graph-empty">暂无节点。跑一轮写作任务后，这里会出现任务、衔接与装载记录。</li>
                    )}
                    {contextGraphLoading && <li className="context-graph-empty">加载上下文图…</li>}
                  </ul>
                  <div className="context-graph-detail">
                    {(() => {
                      const node = contextGraph?.nodes.find((item) => item.id === contextGraphSelectedId)
                        ?? filteredNodes.find((item) => item.id === contextGraphSelectedId);
                      if (!node) return <p className="context-graph-empty">选择左侧节点查看详情。</p>;
                      const related = (contextGraph?.edges ?? []).filter(
                        (edge) => edge.fromId === node.id || edge.toId === node.id,
                      );
                      const kindLabel = CONTEXT_GRAPH_KIND_LABEL[node.kind] ?? node.kind;
                      const title = contextGraphNodeTitle(node) || node.label;
                      const statusLabel = contextGraphStatusLabel(node.status);
                      const transition = contextTransitionFromPayload(node.payload);
                      return (
                        <>
                          <header>
                            <span className="context-graph-detail-eyebrow">
                              <span>{kindLabel}</span>
                              <span className={`context-graph-detail-status ${node.status}`}>{statusLabel}</span>
                            </span>
                            <h3 title={node.label}>{title}</h3>
                            <ul className="context-graph-detail-meta">
                              <li>
                                <span className="meta-key">节点</span>
                                <code className="meta-value">{node.id}</code>
                              </li>
                              {node.jobId ? (
                                <li>
                                  <span className="meta-key">任务</span>
                                  <code className="meta-value">{node.jobId}</code>
                                </li>
                              ) : null}
                              {node.sourceMessageId != null ? (
                                <li>
                                  <span className="meta-key">消息</span>
                                  <span className="meta-value">#{node.sourceMessageId}</span>
                                </li>
                              ) : null}
                              <li>
                                <span className="meta-key">时间</span>
                                <span className="meta-value">{new Date(node.createdAt).toLocaleString()}</span>
                              </li>
                            </ul>
                          </header>
                          {transition ? <ContextTransitionDetail transition={transition} /> : null}
                          {related.length > 0 && (
                            <div className="context-graph-edges">
                              <h4>关系</h4>
                              <ul>
                                {related.map((edge) => {
                                  const otherId = edge.fromId === node.id ? edge.toId : edge.fromId;
                                  const other = contextGraph?.nodes.find((item) => item.id === otherId);
                                  const direction = edge.fromId === node.id ? "→" : "←";
                                  const edgeLabel = CONTEXT_GRAPH_EDGE_LABEL[edge.kind] ?? edge.kind;
                                  const otherTitle = other
                                    ? (contextGraphNodeTitle(other) || other.label)
                                    : otherId;
                                  return (
                                    <li key={edge.id}>
                                      <button type="button" className="ghost" onClick={() => setContextGraphSelectedId(otherId)}>
                                        <span className="context-graph-edge-kind">{edgeLabel}</span>
                                        <span>{direction}</span>
                                        <span className="context-graph-edge-target" title={other?.label ?? otherId}>{otherTitle}</span>
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          )}
                          <div className="context-graph-payload">
                            <h4>原始载荷</h4>
                            <pre>{JSON.stringify(node.payload, null, 2)}</pre>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
                </>
                  );
                })()}
              </div>
            ) : managementView === "characters" ? (
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
            ) : managementView === "sessions" ? (
              <div className="session-manager">
                {sessionBatchMode && (
                  <div className="session-batch-bar">
                    <label className="session-batch-select-all">
                      <input
                        type="checkbox"
                        checked={state.sessions.some(session => !state.activeJobs?.some(job => job.sessionId === session.id))
                          && selectedSessionIds.size === state.sessions.filter(session => !state.activeJobs?.some(job => job.sessionId === session.id)).length}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedSessionIds(new Set(state.sessions
                            .filter(session => !state.activeJobs?.some(job => job.sessionId === session.id))
                            .map(session => session.id)));
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
                  {state.sessions.map((session) => {
                    const running = state.activeJobs?.some(job => job.sessionId === session.id) ?? false;
                    return (
                    <div
                      className={`session-card ${session.id === state.sessionId ? "active" : ""} ${selectedSessionIds.has(session.id) ? "selected" : ""} ${running ? "running" : ""}`}
                      key={session.id}
                    >
                      {sessionBatchMode && (
                        <label className="session-check" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedSessionIds.has(session.id)}
                            disabled={running}
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
                      {running && <span className="session-running-badge"><span aria-hidden="true" />Running</span>}
                      {!sessionBatchMode && (
                        <>
                          <button className="icon" aria-label="重命名会话" title="重命名" onClick={() => void renameSession(session.id, session.title)}><Pencil size={15} /></button>
                          <button className="icon danger" aria-label="删除会话" title={running ? "任务运行时不能删除" : "删除"} disabled={running} onClick={() => void deleteSession(session.id)}><Trash2 size={15} /></button>
                        </>
                      )}
                    </div>
                    );
                  })}
                  {state.sessions.length === 0 && <div className="management-empty">暂无会话</div>}
                </div>
              </div>
            ) : managementView === "prose-gates" ? (
              <div className="prose-gate-manager">
                <p className="prose-gate-intro">
                  项目级语义复审会在正文出口运行。确定错误可设为阻断；偏好、倾向和可能误报的规则建议使用提醒。
                </p>
                {proseGateDraft && (
                  <div className="prose-gate-editor">
                    <div className="prose-gate-editor-grid">
                      <label>
                        <span>稳定 ID</span>
                        <input
                          value={proseGateDraft.id}
                          disabled={!proseGateDraft.isNew || proseGateBusy}
                          placeholder="例如 dialogue-register"
                          onChange={(event) => setProseGateDraft(current => current
                            ? { ...current, id: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") }
                            : current)}
                        />
                      </label>
                      <label>
                        <span>级别</span>
                        <select
                          value={proseGateDraft.severity}
                          disabled={proseGateBusy}
                          onChange={(event) => setProseGateDraft(current => current
                            ? {
                              ...current,
                              severity: event.target.value === "block" ? "block" : "warn",
                              kind: event.target.value === "block" ? "hard_gate" : "style_preference",
                            }
                            : current)}
                        >
                          <option value="warn">提醒</option>
                          <option value="block">阻断</option>
                        </select>
                      </label>
                    </div>
                    <label>
                      <span>核验标准</span>
                      <textarea
                        value={proseGateDraft.instruction}
                        disabled={proseGateBusy}
                        maxLength={500}
                        rows={4}
                        placeholder="写成可以独立执行的检查标准；说明何时适用、什么算违规。"
                        onChange={(event) => setProseGateDraft(current => current
                          ? { ...current, instruction: event.target.value }
                          : current)}
                      />
                    </label>
                    <label>
                      <span>作者反馈来源</span>
                      <textarea
                        value={proseGateDraft.sourceFeedback}
                        disabled={proseGateBusy}
                        maxLength={500}
                        rows={2}
                        placeholder="简要记录为什么增加这条规则，不粘贴长对话。"
                        onChange={(event) => setProseGateDraft(current => current
                          ? { ...current, sourceFeedback: event.target.value }
                          : current)}
                      />
                    </label>
                    <label className="prose-gate-enabled">
                      <input
                        type="checkbox"
                        checked={proseGateDraft.enabled}
                        disabled={proseGateBusy}
                        onChange={(event) => setProseGateDraft(current => current
                          ? { ...current, enabled: event.target.checked }
                          : current)}
                      />
                      保存后立即启用
                    </label>
                    <div className="prose-gate-editor-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={proseGateBusy || !proseGateDraft.id.trim() || !proseGateDraft.instruction.trim()}
                        onClick={() => void saveProseGateRule()}
                      ><Save size={15} />保存</button>
                      <button type="button" disabled={proseGateBusy} onClick={() => setProseGateDraft(null)}>取消</button>
                    </div>
                  </div>
                )}
                <div className="prose-gate-list">
                  {(state.proseGateRules ?? []).map(rule => (
                    <article className={`prose-gate-card${rule.enabled ? "" : " disabled"}`} key={rule.id}>
                      <div className="prose-gate-card-head">
                        <div>
                          <strong>{rule.id}</strong>
                          <span className={`prose-gate-severity ${rule.severity}`}>{rule.severity === "block" ? "阻断" : "提醒"}</span>
                        </div>
                        <label className="prose-gate-switch">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            disabled={proseGateBusy || readOnly}
                            onChange={(event) => void setProseGateRuleEnabled(rule, event.target.checked)}
                          />
                          {rule.enabled ? "启用" : "停用"}
                        </label>
                      </div>
                      <p>{rule.instruction}</p>
                      {rule.sourceFeedback && <small>{rule.sourceFeedback}</small>}
                      <div className="prose-gate-card-foot">
                        <time dateTime={rule.updatedAt}>更新于 {new Date(rule.updatedAt).toLocaleString()}</time>
                        <div>
                          <button
                            className="ghost"
                            disabled={proseGateBusy || readOnly || Boolean(proseGateDraft)}
                            onClick={() => setProseGateDraft({
                              id: rule.id,
                              instruction: rule.instruction,
                              kind: rule.kind ?? (rule.severity === "block" ? "hard_gate" : "style_preference"),
                              severity: rule.severity,
                              enabled: rule.enabled,
                              sourceFeedback: rule.sourceFeedback,
                              isNew: false,
                            })}
                          ><Pencil size={14} />编辑</button>
                          <button
                            className="ghost danger"
                            disabled={proseGateBusy || readOnly}
                            onClick={() => void deleteProseGateRule(rule)}
                          ><Trash2 size={14} />删除</button>
                        </div>
                      </div>
                    </article>
                  ))}
                  {(state.proseGateRules ?? []).length === 0 && (
                    <div className="management-empty">暂无作者复审规则，可以从右上角新增。</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="continuity-fact-manager">
                <p className="prose-gate-intro">
                  这是原文的可追溯连续性索引，不替代正文和设定。环境事实记录长期生活常识；离散事实记录局部人物、事件与物品状态。冲突项不会自动覆盖旧事实。
                </p>
                {continuityFactDraft && (
                  <div className="continuity-fact-editor">
                    <label className="continuity-fact-statement">
                      <span>事实陈述</span>
                      <textarea
                        rows={3}
                        maxLength={280}
                        value={continuityFactDraft.statement}
                        disabled={continuityFactBusy}
                        placeholder="写成脱离上下文仍然成立的一条事实。"
                        onChange={(event) => setContinuityFactDraft(current => current
                          ? { ...current, statement: event.target.value }
                          : current)}
                      />
                    </label>
                    <div className="continuity-fact-editor-grid">
                      <label>
                        <span>类型</span>
                        <select value={continuityFactDraft.kind} disabled={continuityFactBusy}
                          onChange={(event) => setContinuityFactDraft(current => current
                            ? { ...current, kind: event.target.value as ContinuityFact["kind"] }
                            : current)}>
                          <option value="milieu">环境常识</option>
                          <option value="character">角色</option>
                          <option value="location">地点</option>
                          <option value="event">事件</option>
                          <option value="object">物品</option>
                          <option value="relationship">关系</option>
                          <option value="organization">组织</option>
                          <option value="other">其他</option>
                        </select>
                      </label>
                      <label>
                        <span>作用域</span>
                        <select value={continuityFactDraft.scopeKind} disabled={continuityFactBusy}
                          onChange={(event) => setContinuityFactDraft(current => current
                            ? { ...current, scopeKind: event.target.value as ContinuityFact["scopeKind"] }
                            : current)}>
                          <option value="global">全局</option>
                          <option value="era">年代</option>
                          <option value="arc">剧情线</option>
                          <option value="chapter">章节</option>
                          <option value="location">地点</option>
                          <option value="character">角色</option>
                        </select>
                      </label>
                      <label>
                        <span>事实性质</span>
                        <select value={continuityFactDraft.epistemic} disabled={continuityFactBusy}
                          onChange={(event) => setContinuityFactDraft(current => current
                            ? { ...current, epistemic: event.target.value as ContinuityFact["epistemic"] }
                            : current)}>
                          <option value="objective">客观事实</option>
                          <option value="character_knowledge">人物认知</option>
                          <option value="rumor">传闻／不确定</option>
                        </select>
                      </label>
                      <label>
                        <span>状态</span>
                        <select value={continuityFactDraft.status} disabled={continuityFactBusy}
                          onChange={(event) => setContinuityFactDraft(current => current
                            ? { ...current, status: event.target.value as ContinuityFact["status"] }
                            : current)}>
                          <option value="active">有效</option>
                          <option value="pending">待确认</option>
                          <option value="conflict">冲突</option>
                          <option value="stale">来源过期</option>
                          <option value="retracted">已撤回</option>
                        </select>
                      </label>
                      <label>
                        <span>作用域值</span>
                        <input value={continuityFactDraft.scopeValue} disabled={continuityFactBusy}
                          placeholder="如 北港、第五章、角色 ID"
                          onChange={(event) => setContinuityFactDraft(current => current
                            ? { ...current, scopeValue: event.target.value }
                            : current)} />
                      </label>
                      <label>
                        <span>重要度</span>
                        <input type="number" min={0} max={100} value={continuityFactDraft.importance}
                          disabled={continuityFactBusy}
                          onChange={(event) => setContinuityFactDraft(current => current
                            ? { ...current, importance: Math.max(0, Math.min(100, Number(event.target.value) || 0)) }
                            : current)} />
                      </label>
                      <label>
                        <span>从何时有效</span>
                        <input value={continuityFactDraft.validFrom} disabled={continuityFactBusy}
                          onChange={(event) => setContinuityFactDraft(current => current
                            ? { ...current, validFrom: event.target.value }
                            : current)} />
                      </label>
                      <label>
                        <span>到何时失效</span>
                        <input value={continuityFactDraft.validUntil} disabled={continuityFactBusy}
                          onChange={(event) => setContinuityFactDraft(current => current
                            ? { ...current, validUntil: event.target.value }
                            : current)} />
                      </label>
                    </div>
                    <label>
                      <span>知情角色</span>
                      <input value={continuityFactDraft.knownBy.join("、")} disabled={continuityFactBusy}
                        placeholder="用顿号或逗号分隔；公共客观事实可留空"
                        onChange={(event) => setContinuityFactDraft(current => current
                          ? { ...current, knownBy: event.target.value.split(/[、,，]/u).map(item => item.trim()).filter(Boolean) }
                          : current)} />
                    </label>
                    <div className="continuity-fact-editor-grid source">
                      <label>
                        <span>来源文档</span>
                        <input value={continuityFactDraft.sourcePath} disabled={continuityFactBusy}
                          placeholder="可留空；自动提取时会记录"
                          onChange={(event) => setContinuityFactDraft(current => current
                            ? { ...current, sourcePath: event.target.value }
                            : current)} />
                      </label>
                      <label>
                        <span>连续原文证据</span>
                        <input value={continuityFactDraft.sourceEvidence} disabled={continuityFactBusy}
                          placeholder="填写来源时，证据必须存在于当前文档"
                          onChange={(event) => setContinuityFactDraft(current => current
                            ? { ...current, sourceEvidence: event.target.value }
                            : current)} />
                      </label>
                    </div>
                    <div className="prose-gate-editor-actions">
                      <button className="primary" disabled={continuityFactBusy || !continuityFactDraft.statement.trim()}
                        onClick={() => void saveContinuityFact()}><Save size={15} />保存</button>
                      <button disabled={continuityFactBusy} onClick={() => setContinuityFactDraft(null)}>取消</button>
                    </div>
                  </div>
                )}
                <div className="continuity-fact-list">
                  {(state.continuityFacts ?? []).map(fact => (
                    <article className={`continuity-fact-card status-${fact.status}`} key={fact.id}>
                      <div className="continuity-fact-card-head">
                        <div>
                          <span className={`continuity-fact-kind kind-${fact.kind}`}>
                            {fact.kind === "milieu" ? "环境" : fact.kind}
                          </span>
                          <span className={`continuity-fact-status status-${fact.status}`}>{fact.status}</span>
                          <small>#{fact.id} · 重要度 {fact.importance}</small>
                        </div>
                        <span>{fact.scopeKind}{fact.scopeValue ? ` · ${fact.scopeValue}` : ""}</span>
                      </div>
                      <p>{fact.statement}</p>
                      <div className="continuity-fact-meta">
                        <span>{fact.epistemic === "objective" ? "客观事实" : fact.epistemic === "rumor" ? "传闻" : "人物认知"}</span>
                        {fact.knownBy.length > 0 && <span>知情：{fact.knownBy.join("、")}</span>}
                        {fact.sourcePath && <span title={fact.sourceEvidence}>{fact.sourcePath}</span>}
                        {(fact.conflictsWith.length > 0 || fact.supersedes.length > 0) && (
                          <span>关联：{[...fact.conflictsWith, ...fact.supersedes].map(id => `#${id}`).join("、")}</span>
                        )}
                      </div>
                      <div className="prose-gate-card-foot">
                        <time dateTime={fact.updatedAt}>更新于 {new Date(fact.updatedAt).toLocaleString()}</time>
                        <div>
                          <button className="ghost" disabled={continuityFactBusy || readOnly || Boolean(continuityFactDraft)}
                            onClick={() => setContinuityFactDraft({
                              id: fact.id,
                              statement: fact.statement,
                              kind: fact.kind,
                              scopeKind: fact.scopeKind,
                              scopeValue: fact.scopeValue,
                              validFrom: fact.validFrom,
                              validUntil: fact.validUntil,
                              epistemic: fact.epistemic,
                              knownBy: fact.knownBy,
                              importance: fact.importance,
                              status: fact.status,
                              sourcePath: fact.sourcePath,
                              sourceEvidence: fact.sourceEvidence,
                              conflictsWith: fact.conflictsWith,
                              supersedes: fact.supersedes,
                            })}><Pencil size={14} />编辑</button>
                          {fact.status !== "retracted" && (
                            <button className="ghost danger" disabled={continuityFactBusy || readOnly}
                              onClick={() => void retractContinuityFact(fact)}><Trash2 size={14} />撤回</button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                  {(state.continuityFacts ?? []).length === 0 && (
                    <div className="management-empty">暂无连续性事实。接受新的设定或正文后会增量提取，也可以手动添加。</div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {characterDraft && (
                <React.Suspense fallback={<div className="management-empty">加载角色编辑器…</div>}>
          <CharacterEditor
          draft={characterDraft}
          characters={state?.characters ?? []}
          busy={busy}
          onChange={setCharacterDraft}
          onClose={() => setCharacterDraft(null)}
          onSave={() => void saveCharacter()}
          onSummarizeCharacter={summarizeCharacter}
          onDelete={characterDraft.id ? () => void deleteCharacter(characterDraft as Character) : undefined}
          />
        </React.Suspense>
      )}

      {managementView === "models" && (
        <React.Suspense fallback={<div className="management-empty">加载模型设置…</div>}>
          <ModelConfig
          initialCatalog={state.providerCatalog}
          scenePipeline={state.agentSettings?.scenePipeline ?? { enabled: false, preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5, notesMaxCharacters: 3000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1 }}
          proseLength={state.agentSettings?.proseLength ?? DEFAULT_PROSE_LENGTH}
          writingMode={state.agentSettings?.writingMode ?? "fast"}
          characterEvolutionEnabled={state.agentSettings?.characterEvolutionEnabled ?? true}
          continuityFactsEnabled={state.agentSettings?.continuityFactsEnabled ?? false}
          reviewFollowsProseModel={state.agentSettings?.reviewFollowsProseModel ?? true}
          section={settingsSection}
          onSectionChanged={setSettingsSection}
          connectionAvailable={connection.dualMode}
          styleContent={<div className="settings-section-body">
          <div className="style-picker-actions">
          <button type="button" className="primary" disabled={styleBusy} onClick={() => openStyleTemplate()}>新建模板</button>
          {activeStyle && <button type="button" disabled={styleBusy} onClick={() => openStyleTemplate(activeStyle)}>
          {(activeStyle.readOnly || activeStyle.builtIn) ? "浏览当前模板" : "编辑当前模板"}
          </button>}
          <button type="button" className={`style-off${activeStyleId ? "" : " active"}`} disabled={styleBusy || !activeStyleId} onClick={() => void applyWritingStyle("")}>不使用模板</button>
          {activeStyle && <span className="style-active-hint">当前：{activeStyle.name}{(activeStyle.readOnly || activeStyle.builtIn) ? "（内置·只读）" : ""}</span>}
          </div>
          <div className="theme-grid style-grid">
          {styleTemplates.length === 0 ? <div className="management-empty">暂无写作风格模板</div> : styleTemplates.map((item) => {
          const selected = item.id === activeStyleId;
          const readOnly = Boolean(item.readOnly || item.builtIn);
          const preview = (item.exampleContent ?? "").replace(/\s+/g, " ").trim().slice(0, 96);
          return <div key={item.id} className={`theme-card style-card${selected ? " active" : ""}`}>
          <button type="button" className="style-card-select" disabled={styleBusy} onClick={() => void applyWritingStyle(item.id, item.name)}>
          <div className="theme-card-meta">
          <strong>{item.name}{selected && <span className="theme-tag">使用中</span>}{readOnly && <span className="theme-tag">内置</span>}{!readOnly && item.customized && <span className="theme-tag">自定义</span>}</strong>
          <small>{item.description}</small>
          {preview && <span className="theme-example style-example">{preview}{preview.length >= 96 ? "…" : ""}</span>}
          </div>
          </button>
          <button type="button" className="style-card-edit" disabled={styleBusy} onClick={() => openStyleTemplate(item)}>{readOnly ? "浏览" : "编辑"}</button>
          </div>;
          })}
          </div>
          </div>}
          proseGatesContent={proseGatesSettingsContent}
          continuityFactsContent={continuityFactsSettingsContent}
          connectionContent={connection.dualMode ? <div className="settings-section-body connection-settings">
          <div className="connection-status-row">
          <span className={`connection-status-dot route-${connection.route}`} aria-hidden="true" />
          <div className="connection-status-meta"><strong>{connection.label}</strong><small title={connection.base}>{connection.base}</small></div>
          <button type="button" className="ghost" disabled={connectionBusy} onClick={() => {
          setConnectionBusy(true);
          setConnectionPanelMsg("");
          void Promise.all([ensureConnection(), probeConnectionRoutes()]).then(([info, probes]) => {
          setConnection(info);
          setConnectionProbeResults(probes);
          setConnectionPanelMsg(`已重新探测：${info.label}`);
          }).catch((e) => setConnectionPanelMsg(String(e))).finally(() => setConnectionBusy(false));
          }}>重新探测</button>
          </div>
          <div className="connection-section">
          <h3>通道偏好</h3>
          <div className="connection-pref-grid">{([
          { id: "auto" as const, name: "自动", desc: "局域网优先，不可达则公网" },
          { id: "lan" as const, name: "局域网", desc: "尽量锁定，低延迟" },
          { id: "public" as const, name: "公网", desc: "Cloudflare 隧道" },
          ] satisfies Array<{ id: ConnectionPreference; name: string; desc: string }>).map((item) => <button
          key={item.id}
          type="button"
          className={`connection-pref-card${connection.preference === item.id ? " active" : ""}${connection.route === item.id ? " live" : ""}`}
          disabled={connectionBusy}
          onClick={() => {
          setConnectionBusy(true);
          setConnectionPanelMsg("");
          void setConnectionPreference(item.id).then((result) => {
          setConnection(getConnectionInfo());
          if (result.needNavigate || result.error) {
          setConnectionPanelMsg(result.error || "请用下方入口链接打开对应通道");
          return;
          }
          setConnectionPanelMsg(item.id === "auto" ? `已设为自动 · 当前 ${result.label}` : `已切换到${item.name}`);
          }).finally(() => setConnectionBusy(false));
          }}
          >
          <span className="connection-pref-title">
          <strong>{item.name}</strong>
          {connectionProbeLabel(item.id) && <em>{connectionProbeLabel(item.id)}</em>}
          </span>
          <small>{item.desc}</small>
          </button>)}</div>
          </div>
          <div className="connection-section">
          <h3>入口链接</h3>
          <p className="connection-hint">在家 Wi‑Fi 推荐使用局域网入口；公网 HTTPS 页面受浏览器混合内容限制，不能直接探测局域网 HTTP。</p>
          {connection.lanBlockedByMixedContent && <p className="connection-warn">当前是 HTTPS 公网页，回家后请用下方局域网链接打开工作区。</p>}
          {([
          { kind: "lan" as const, name: "局域网", base: connection.lanBase },
          { kind: "public" as const, name: "公网", base: connection.publicBase },
          ]).map((item) => {
          const entry = buildEntryUrl(item.kind);
          return <div key={item.kind} className="connection-link-row">
          <div className="connection-link-meta"><strong>{item.name}</strong><small title={item.base || undefined}>{item.base || "未配置"}</small></div>
          <div className="connection-link-actions">
          <button type="button" className="ghost" disabled={!entry} onClick={() => entry && void navigator.clipboard?.writeText(entry).then(() => setConnectionPanelMsg(`已复制${item.name}链接`)).catch(() => setConnectionPanelMsg(entry))}>复制</button>
          <button type="button" className="ghost" disabled={!entry} onClick={() => entry && window.open(entry, "_blank", "noopener,noreferrer")}>新标签</button>
          <button type="button" className="primary" disabled={!entry} onClick={() => entry && window.location.assign(entry)}>打开</button>
          </div>
          </div>;
          })}
          </div>
          {connectionPanelMsg && <p className="connection-panel-msg" role="status">{connectionPanelMsg}</p>}
          </div> : <div className="management-empty">当前环境只配置了单一连接通道。</div>}
          appearanceContent={<div className="settings-section-body"><div className="theme-grid">
          {UI_THEMES.map((item) => <button key={item.id} type="button" className={`theme-card${theme === item.id ? " active" : ""}`} onClick={() => setTheme(item.id)}>
          <div className="theme-preview" style={{
          ["--tp-bg"]: item.preview.bg,
          ["--tp-surface"]: item.preview.surface,
          ["--tp-surface2"]: item.preview.surface2,
          ["--tp-border"]: item.preview.border,
          ["--tp-accent"]: item.preview.accent,
          ["--tp-text"]: item.preview.text,
          } as React.CSSProperties} aria-hidden="true">
          <div className="theme-preview-chrome"><i/><i/><i/></div>
          <div className="theme-preview-body"><div className="theme-preview-side"/><div className="theme-preview-main"><span/><span/><span/></div><div className="theme-preview-agent"/></div>
          </div>
          <div className="theme-card-meta"><strong>{item.name}<span className="theme-tag">{item.tag}</span></strong></div>
          </button>)}
          </div></div>}
          request={api}
          onClose={() => setManagementView(null)}
          onChanged={() => { void refresh(state.sessionId); }}
          onScenePipelineChanged={scenePipeline => setState(previous => previous ? {
          ...previous,
          agentSettings: {
          permissionMode: previous.agentSettings?.permissionMode ?? "ask",
          writingMode: previous.agentSettings?.writingMode ?? "fast",
          characterEvolutionEnabled: previous.agentSettings?.characterEvolutionEnabled ?? true,
          continuityFactsEnabled: previous.agentSettings?.continuityFactsEnabled ?? false,
          reviewFollowsProseModel: previous.agentSettings?.reviewFollowsProseModel ?? true,
          scenePipeline,
          proseLength: previous.agentSettings?.proseLength ?? DEFAULT_PROSE_LENGTH,
          },
          } : previous)}
          onProseLengthChanged={proseLength => setState(previous => previous ? {
          ...previous,
          agentSettings: {
          permissionMode: previous.agentSettings?.permissionMode ?? "ask",
          writingMode: previous.agentSettings?.writingMode ?? "fast",
          characterEvolutionEnabled: previous.agentSettings?.characterEvolutionEnabled ?? true,
          continuityFactsEnabled: previous.agentSettings?.continuityFactsEnabled ?? false,
          reviewFollowsProseModel: previous.agentSettings?.reviewFollowsProseModel ?? true,
          scenePipeline: previous.agentSettings?.scenePipeline ?? { enabled: false, preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5, notesMaxCharacters: 3000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1 },
          proseLength,
          },
          } : previous)}
          onCharacterEvolutionChanged={characterEvolutionEnabled => setState(previous => previous ? {
          ...previous,
          agentSettings: {
          permissionMode: previous.agentSettings?.permissionMode ?? "ask",
          writingMode: previous.agentSettings?.writingMode ?? "fast",
          characterEvolutionEnabled,
          continuityFactsEnabled: previous.agentSettings?.continuityFactsEnabled ?? false,
          reviewFollowsProseModel: previous.agentSettings?.reviewFollowsProseModel ?? true,
          scenePipeline: previous.agentSettings?.scenePipeline ?? { enabled: false, preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5, notesMaxCharacters: 3000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1 },
          proseLength: previous.agentSettings?.proseLength ?? DEFAULT_PROSE_LENGTH,
          },
          } : previous)}
          onContinuityFactsChanged={continuityFactsEnabled => setState(previous => previous ? {
          ...previous,
          agentSettings: {
          permissionMode: previous.agentSettings?.permissionMode ?? "ask",
          writingMode: previous.agentSettings?.writingMode ?? "fast",
          characterEvolutionEnabled: previous.agentSettings?.characterEvolutionEnabled ?? true,
          continuityFactsEnabled,
          reviewFollowsProseModel: previous.agentSettings?.reviewFollowsProseModel ?? true,
          scenePipeline: previous.agentSettings?.scenePipeline ?? { enabled: false, preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5, notesMaxCharacters: 3000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1 },
          proseLength: previous.agentSettings?.proseLength ?? DEFAULT_PROSE_LENGTH,
          },
          } : previous)}
          onReviewFollowsProseModelChanged={reviewFollowsProseModel => setState(previous => previous ? {
          ...previous,
          agentSettings: {
          permissionMode: previous.agentSettings?.permissionMode ?? "ask",
          writingMode: previous.agentSettings?.writingMode ?? "fast",
          characterEvolutionEnabled: previous.agentSettings?.characterEvolutionEnabled ?? true,
          continuityFactsEnabled: previous.agentSettings?.continuityFactsEnabled ?? false,
          reviewFollowsProseModel,
          scenePipeline: previous.agentSettings?.scenePipeline ?? { enabled: false, preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5, notesMaxCharacters: 3000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1 },
          proseLength: previous.agentSettings?.proseLength ?? DEFAULT_PROSE_LENGTH,
          },
          } : previous)}
          />
        </React.Suspense>
      )}
    </WorkspaceShell>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
