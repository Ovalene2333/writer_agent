/** Shared web types & pure constants extracted from main.tsx. */

import type { AgentStepBudgetMode, AutoVolumeSettings, ChapterNamingSettings, ProseLengthSettings, ProviderCatalog, RoleplaySettings, ScenePipelineSettings, WritingExecutionMode } from "./model_config";

/** Rule-layer writing-quality picture. Absent on非正文提案与旧提案 —— 渲染时必须容忍。 */
export type ProseQualityReport = {
  characters: number;
  /** 越高越好。 */
  vividness: { score: number; summary: string };
  /** 越高越可疑（AI 味）。 */
  aiTells: { score: number; summary: string };
  grade: "good" | "fair" | "weak";
  /** 本轮篇幅目标与实际；偏短不阻断交付，只在这里露出来。 */
  length?: { target: number; actual: number; status: "ok" | "too_short" | "too_long" };
  warnings: Array<{ source: "metrics" | "vividness" | "ai_tells" | "dialogue"; code: string; message: string; examples: string[] }>;
};

export type Proposal = {
  id: number;
  /** 门禁修订中的中间草稿不可审批，只有交付就绪提案进入审阅队列。 */
  deliveryReady: boolean;
  path: string;
  summary: string;
  beforeContent: string;
  afterContent: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  qualityReport?: ProseQualityReport;
};

export const QUALITY_GRADE_LABEL: Record<ProseQualityReport["grade"], string> = {
  good: "良好",
  fair: "尚可",
  weak: "偏弱",
};

export const QUALITY_SOURCE_LABEL: Record<ProseQualityReport["warnings"][number]["source"], string> = {
  metrics: "节奏",
  vividness: "现场感",
  ai_tells: "AI 味",
  dialogue: "对白",
};

/**
 * Advisory card: everything blocking已在提案创建前拦掉，这里只是让作者在按 Accept
 * 之前看到这一章的质量画像。默认折叠明细，避免把审阅 dock 撑开。
 */
export type MessageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storagePath: string;
  imageGeneration?: {
    finalPrompt: string;
    revisedPrompt?: string;
    referenceAttachmentIds?: string[];
  };
};

export type PendingAttachment = {
  localId: string;
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
  previewUrl: string;
};

export type Message = {
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

export const MULTIMODAL_MAX_ATTACHMENTS = 4;
export const MULTIMODAL_MAX_BYTES = 4 * 1024 * 1024;
export const MULTIMODAL_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]);

export type RoleplayPerceptionProjection = {
  speech: string[];
  knowableFacts: string[];
  unknowableFacts: string[];
  potentialSensations: string[];
};
export type RoleplayRerunDirection = "shorter" | "more_emotional" | "less_explanation" | "more_subtext" | "warmer" | "more_confrontational" | "dialogue_only" | "with_action" | "no_question" | "change_tactic";
export type RoleplayContentRating = "default" | "sfw" | "nsfw";
export type RoleplayRerunControls = {
  length: number;
  pace: number;
  emotion: number;
  action: number;
  initiative: number;
  contentRating: RoleplayContentRating;
};
/** Rerun-only sliders (length is a normal-turn control, not listed here). */
export type RoleplayRerunSliderKey = Exclude<keyof RoleplayRerunControls, "contentRating" | "length">;
export const DEFAULT_ROLEPLAY_RERUN_CONTROLS: RoleplayRerunControls = {
  length: 0,
  pace: 0,
  emotion: 0,
  action: 0,
  initiative: 0,
  contentRating: "default",
};
export const ROLEPLAY_CONTINUATION_PLACEHOLDER = "<续演>";
/** Ongoing qualitative length preference. Numeric budgets remain an internal implementation detail. */
export type RoleplayLengthLevel = -2 | -1 | 0 | 1 | 2;
export const ROLEPLAY_LENGTH_OPTIONS: Array<{
  level: RoleplayLengthLevel;
  label: string;
}> = [
  { level: -2, label: "极简" },
  { level: -1, label: "精简" },
  { level: 0, label: "适中" },
  { level: 1, label: "充分" },
  { level: 2, label: "展开" },
];
export function roleplayLengthOption(level: number) {
  const normalized = Math.max(-2, Math.min(2, Math.round(level || 0))) as RoleplayLengthLevel;
  return ROLEPLAY_LENGTH_OPTIONS.find(item => item.level === normalized) ?? ROLEPLAY_LENGTH_OPTIONS[2];
}
export const ROLEPLAY_RERUN_SLIDERS: Array<{ id: RoleplayRerunSliderKey; label: string; low: string; high: string }> = [
  { id: "pace", label: "节奏", low: "舒缓", high: "紧凑" },
  { id: "emotion", label: "情绪", low: "克制", high: "强烈" },
  { id: "action", label: "动作占比", low: "台词", high: "动作" },
  { id: "initiative", label: "主动程度", low: "迟疑", high: "主动" },
];
export const ROLEPLAY_RERUN_DIRECTION_OPTIONS: Array<{ id: RoleplayRerunDirection; label: string; description: string }> = [
  { id: "less_explanation", label: "减少解释", description: "删除分析与归纳" },
  { id: "more_subtext", label: "增加潜台词", description: "把意图留在言外" },
  { id: "warmer", label: "更加柔和", description: "表达更多善意" },
  { id: "more_confrontational", label: "更有锋芒", description: "表达直接且有张力" },
  { id: "no_question", label: "不要提问", description: "不以问题推进" },
  { id: "change_tactic", label: "改变策略", description: "目标不变，换一种做法" },
];
export type RoleplayBranchSummary = {
  id: string;
  groupId: string;
  fromMessageId: number;
  label: string;
  preview: string;
  messageCount: number;
  createdAt: string;
};
export type MessageVersionBundle = {
  current: number;
  versions: Array<{ key: string; content: string; createdAt: string }>;
};
export type RoleplayInterlocutor = {
  name: string;
  identity: string;
  relationship: string;
  knowledge: string;
  scene: string;
  goal: string;
};
export type SavedRoleplayInterlocutor = RoleplayInterlocutor & {
  id: number;
  targetCharacterId?: number;
  createdAt: string;
  updatedAt: string;
};
export type RoleplayParticipant = {
  kind: "simple" | "normal" | "generated";
  id?: number;
  name: string;
  card: RoleplayInterlocutor;
};
export type ActiveRoleplayState = {
  performer: RoleplayParticipant;
  identity: RoleplayParticipant;
  scene?: RoleplayScene;
  sceneSequence: RoleplayScene[];
  sceneIndex: number;
  contentRating: RoleplayContentRating;
};
export type ChangeSet = {
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
  characterChanges: Array<{
    characterId: number;
    reason: string;
    changes: Array<{ op: string }>;
    operation?: "evolve" | "create" | "replace";
    after?: { identity?: { name?: string } };
  }>;
};
export type RoleplayInputMode = "dialogue" | "director";
export type RoleplayScene = {
  id: number; name: string; setting: string; premise: string; tone: string; timelineAnchor: string;
  performerGoal: string; identityGoal: string; stakes: string[]; openingVariants: string[];
  endConditions: string[]; loreBindings: string[]; revision: number; createdAt: string; updatedAt: string;
};
export type RoleplayMemoryFact = {
  id: number; sessionId: string; contextKey: string; kind: "event" | "promise" | "relationship" | "secret" | "preference";
  content: string; sourceMessageId?: number; knownBy: Array<"public" | "performer" | "identity">;
  importance: number; status: "active" | "superseded" | "retracted"; pinned: boolean; createdAt: string; updatedAt: string;
};
export type RoleplaySessionMemory = {
  performerKey: string;
  summary: string;
  summarizedThroughId: number;
  state: { scene: string };
  turnCount: number;
  sameBeatTurns: number;
};
export type RoleplaySetupPhase = "generating" | "saving" | "entering";
export const ROLEPLAY_SETUP_PHASE_LABELS: Record<RoleplaySetupPhase, string> = {
  generating: "\u6b63\u5728\u751f\u6210\u7b80\u6613\u89d2\u8272\u5361",
  saving: "\u6b63\u5728\u4fdd\u5b58\u7b80\u6613\u89d2\u8272\u5361",
  entering: "\u6b63\u5728\u8fdb\u5165\u89d2\u8272\u626e\u6f14",
};
export const ROLEPLAY_SETUP_STEP_LABELS: Record<RoleplaySetupPhase, string> = {
  generating: "\u751f\u6210\u8eab\u4efd",
  saving: "\u4fdd\u5b58\u89d2\u8272\u5361",
  entering: "\u51c6\u5907\u4f1a\u8bdd",
};

export function roleplaySetupPhases(persist: boolean): RoleplaySetupPhase[] {
  return persist ? ["generating", "saving", "entering"] : ["generating", "entering"];
}
export type RoleplaySceneDraft = Omit<RoleplayScene, "id" | "revision" | "createdAt" | "updatedAt"> & { id?: number };
export const emptyRoleplayScene = (): RoleplaySceneDraft => ({
  name: "", setting: "", premise: "", tone: "", timelineAnchor: "", performerGoal: "", identityGoal: "",
  stakes: [], openingVariants: [], endConditions: [], loreBindings: [],
});
export type RoleplayFactDraft = Omit<RoleplayMemoryFact, "id" | "sessionId" | "contextKey" | "createdAt" | "updatedAt"> & { id?: number };
export type DocumentData = { content: string; hash: string; qualityReport?: ProseQualityReport };
export type DocumentVersionMeta = {
  id: number;
  path: string;
  createdAt: string;
  summary: string;
  isCurrent: boolean;
  createdFile: boolean;
  undone?: boolean;
  qualityReport?: ProseQualityReport;
};
export type DocumentVersionDetail = DocumentVersionMeta & {
  beforeContent: string;
  afterContent: string;
};
export type ChapterSummary = {
  path: string;
  title: string;
  volume: string;
  wordCount: number;
  versionCount: number;
  updatedAt: string;
};
export type MarkdownHeading = { id: string; level: number; text: string };
export type Temporal = { validFrom?: string; validUntil?: string };
export type TextEntry = Temporal & { id: string; label: string; description: string };
export type Goal = Temporal & { id: string; category: "longTerm" | "current"; status: "active" | "achieved" | "abandoned" | "blocked" | "unknown"; priority: number; summary: string; stakes: string; obstacles: string[] };
export type Relationship = Temporal & { id: string; characterId: number; type: string; description: string; attitude: string; status: "active" | "ended" | "strained" | "unknown" };
export type Competency = Temporal & { id: string; name: string; summary: string; level: string; unlocked: boolean; description: string; resources: string[]; limitations: string[]; costs: string[] };
export type CompetencyAvailability = "available" | "latent" | "blocked" | "lost" | "unknown";
export type CompetencyState = { id: string; competencyId: string; state: CompetencyAvailability; reason: string; evidence?: string };
export type Feature = { id: string; name: string; summary: string; description: string };
export type VoiceMode = {
  id: string;
  context: string;
  intent: string;
  informationStrategy: string;
  interactionStrategy: string;
  register: string;
};
export type StoryState = Temporal & { id: string; outlineNodeId?: string; unanchored?: boolean; location: string; physical: string; emotion: string; knowledge: TextEntry[]; beliefs: TextEntry[]; intentions: string[]; temporaryGoals: Goal[]; competencyStates?: CompetencyState[]; notes: string };
export type Character = {
  schemaVersion: 3; id: number;
  identity: { name: string; aliases: string[]; tags: string[]; narrativeRole: string; summary: string };
  profile: { appearance: string; appearanceSummary: string; background: string; backgroundSummary: string; biography: string };
  psychology: { summary: string; traits: TextEntry[]; values: TextEntry[]; fears: TextEntry[]; conflicts: TextEntry[] };
  motivations: Goal[]; voice: {
    summary: string; register: string; diction: string[]; verbalHabits: string[];
    avoidedExpressions: string[]; examples: string[]; interactionPrinciples: string[]; modes: VoiceMode[];
  };
  features: Feature[]; competencies: Competency[]; relationships: Relationship[]; storyStates: StoryState[]; experiences: TextEntry[]; notes: string; updatedAt: string;
};
export type CharacterDraft = Omit<Character, "id" | "updatedAt"> & { id?: number };
export type StepUsageCall = {
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
  reasoningTokens?: number;
  durationMs?: number;
};
export type StepUsage = {
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
  reasoningTokens?: number;
  durationMs?: number;
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
export function callKindLabel(callKind: string): string {
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
export type StreamStep = {
  id: number;
  output: string;
  reasoning: string;
  tools: string[];
  status: "running" | "completed" | "failed";
  expanded: boolean;
  usage?: StepUsage;
};
export type StoredStepTrail = {
  sessionId: string;
  messageId: number;
  steps: StreamStep[];
  updatedAt: string;
};
export type AgentJob = {
  id: string;
  sessionId: string;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  kind?: string;
  promptPreview?: string;
  sourceMessageId?: number;
  terminalMessage?: string;
};
export type PermissionMode = "ask" | "auto" | "plan";
export type AgentStreamEvent = {
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
  proposal?: { id: number; deliveryReady: boolean; path: string; summary: string; beforeContent: string; afterContent: string; status: "pending" | "accepted" | "rejected" | "stale" };
  changeSet?: ChangeSet;
  usage?: Usage;
  call?: StepUsage;
  callKind?: string;
  mode?: PermissionMode;
  /** provider_status */
  phase?: "queued" | "rate_limited" | "retrying" | "circuit_open" | "dispatched";
  key?: string;
  position?: number;
  attempt?: number;
  maxAttempts?: number;
  waitMs?: number;
  /** error */
  code?: string;
  retryable?: boolean;
  action?: string;
};
export type Usage = {
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
export type Provider = {
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
export type StyleTemplateInfo = {
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
  /** The current default example has passed semantic review. */
  exampleReviewed?: boolean;
  exampleReviewStatus?: "unreviewed" | "reviewing" | "reviewed" | "failed";
  exampleReviewError?: string;
};
export type StyleTemplateDraft = StyleTemplateInfo & { isNew: boolean };
export type ProseGateRule = {
  id: string;
  label?: string;
  instruction: string;
  revisionIntent?: string;
  kind: "hard_gate" | "style_preference";
  severity: "block" | "warn";
  enabled: boolean;
  builtIn?: boolean;
  /** Present when this runtime gate is projected from an AuthorPolicy. */
  policyId?: string;
  documentKinds: Array<"chapter" | "side" | "lore" | "outline" | "archive" | "other" | "writing_example">;
  pathPrefixes: string[];
  sourceFeedback: string;
  createdAt: string;
  updatedAt: string;
};
export type ProseGateRuleDraft = Pick<ProseGateRule, "id" | "instruction" | "kind" | "severity" | "enabled" | "documentKinds" | "pathPrefixes" | "sourceFeedback">
  & { isNew: boolean };
export type AuthorPolicyStatus = "draft" | "trial" | "active" | "paused" | "deprecated";
export type AuthorPolicyEnforcement = "observe" | "advise" | "block";
export type AuthorPolicy = {
  id: string;
  title: string;
  userIntent: string;
  semanticCriterion: string;
  evidenceRequirement: string;
  allowConditions: string[];
  revisionIntent: string;
  dislikedExamples: string[];
  acceptableExamples: string[];
  scope: {
    documentKinds: ProseGateRule["documentKinds"];
    pathPrefixes: string[];
    characterIds: string[];
    sceneKinds: string[];
  };
  enforcement: AuthorPolicyEnforcement;
  status: AuthorPolicyStatus;
  skillId?: string;
  version?: number;
  sourceFeedback: string;
  createdAt?: string;
  updatedAt?: string;
};
export type AuthorPolicyFeedback = {
  id: string;
  policyId: string;
  policyVersion: number;
  disposition: "accepted" | "dismissed" | "edited" | "false_positive";
  issueId?: string;
  evidence?: string;
  note?: string;
  createdAt: string;
};
export type MessageStepTrail = {
  sourceMessageId: number;
  jobId?: string;
  jobStatus?: string;
  jobKind?: string;
  jobCreatedAt?: string;
  jobUpdatedAt?: string;
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
export type ContextGraphNode = {
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
export type ContextGraphEdge = {
  id: string;
  sessionId: string;
  fromId: string;
  toId: string;
  kind: string;
  createdAt: string;
};
export type ContextGraphView = {
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
export type ProjectSummary = {
  /** Workspace-relative project ID. `.` is the project at the workspace root. */
  id: string;
  title: string;
};
export type State = {
  accessMode?: "owner" | "readonly";
  project: ProjectSummary;
  /** Increments every time the server replaces its active project resources. */
  projectEpoch: number;
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
  agentSettings?: {
    permissionMode: PermissionMode;
    writingMode: WritingExecutionMode;
    characterEvolutionEnabled: boolean;
    reviewFollowsProseModel?: boolean;
    stepBudgetMode?: AgentStepBudgetMode;
    maxAgentSteps?: number;
    scenePipeline: ScenePipelineSettings;
    proseLength?: ProseLengthSettings;
    autoVolume?: AutoVolumeSettings;
    chapterNaming?: ChapterNamingSettings;
    proseGateTimeouts?: { primarySeconds: number; finalSeconds: number };
    roleplay?: RoleplaySettings;
  };
  proseGateRules?: ProseGateRule[];
  authorPolicies?: AuthorPolicy[];
  authorPolicyFeedback?: AuthorPolicyFeedback[];
  projectInstructions?: string | null;
  skills?: Array<{ id: string; name: string; description: string }>;
};

export const PERMISSION_MODES: Array<{ id: PermissionMode; label: string; hint: string }> = [
  { id: "ask", label: "审批", hint: "提案需人工审批后写入" },
  { id: "auto", label: "自动", hint: "提案自动写入磁盘" },
  { id: "plan", label: "规划", hint: "只读规划，不改文件" },
];

export type TreeNode = {
  name: string;
  path: string;
  kind: "file" | "folder";
  children: TreeNode[];
  hidden: boolean;
};

export const EMPTY_CHARACTER: CharacterDraft = {
  schemaVersion: 3, identity: { name: "", aliases: [], tags: [], narrativeRole: "", summary: "" },
  profile: { appearance: "", appearanceSummary: "", background: "", backgroundSummary: "", biography: "" },
  psychology: { summary: "", traits: [], values: [], fears: [], conflicts: [] }, motivations: [],
  voice: {
    summary: "", register: "", diction: [], verbalHabits: [], avoidedExpressions: [], examples: [],
    interactionPrinciples: [], modes: [],
  },
  features: [], competencies: [], relationships: [], storyStates: [], experiences: [], notes: "",
};
/** Visual UI themes (workspace chrome). Not writing style templates. */
export type UiThemeId = "light" | "dark" | "ink" | "rose" | "ocean" | "graphite";
export type WorkspaceMode = "split" | "editor-focus" | "agent-focus";
export type DocumentSidebarMode = "chapters" | "files";
export type ManagementView = "characters" | "sessions" | "models" | "prose-gates" | "context-graph";

export type UiTheme = {
  id: UiThemeId;
  name: string;
  tag: string;
  description: string;
  example: string;
  /** Mini preview swatches: bg, surface, surface2, border, accent, text */
  preview: { bg: string; surface: string; surface2: string; border: string; accent: string; text: string };
  dark: boolean;
};

export const UI_THEMES: UiTheme[] = [
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

export const UI_THEME_IDS = new Set<string>(UI_THEMES.map((item) => item.id));
export const AGENT_HIDDEN_CHARACTER_CARDS_KEY = "writer-agent-hidden-character-cards";
