export interface WriterConfig {
  title: string;
  language: string;
  style?: string;
}

export interface ModelConfig {
  baseUrl: string;
  proxyUrl?: string;
  apiKey: string;
  model: string;
  provider?: ProviderId;
  /** User-facing provider profile name for per-call usage attribution. */
  providerName?: string;
  pricing?: TokenPricing;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /** OpenAI-compatible reasoning depth. Omitted to use the provider default. */
  reasoningEffort?: ReasoningEffort;
  /** OpenAI-compatible response detail. Omitted to use the provider default. */
  verbosity?: ResponseVerbosity;
  /**
   * Suppress every sampling / penalty parameter for this model.
   *
   * Newer model families (GPT-5, o-series and their compatible clones) reject
   * `temperature` outright rather than ignoring it, and reject `top_p` and the
   * penalty fields alongside it. Omitting a parameter is never an error — sending
   * a rejected one fails the whole request — so this switch drops the entire group
   * and lets the provider apply its own defaults.
   */
  disableSampling?: boolean;
  /**
   * Model accepts OpenAI-style multimodal user content (text + image_url parts).
   * When false/undefined, image attachments are reduced to text placeholders.
   */
  supportsMultimodal?: boolean;
}

/** 峰谷/分时计费：高峰时段使用 peak 单价，平时使用基础单价。 */
export interface PeakBilling {
  /** IANA 时区，DeepSeek 为 Asia/Shanghai（北京时间） */
  timezone: string;
  /** 高峰窗口，本地时钟 HH:MM，半开区间 [start, end) */
  windows: Array<{ start: string; end: string }>;
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

export interface TokenPricing {
  /** 缺省为按量计费；非按量模式仍记录 token，但不累计调用费用。 */
  billingMode?: "metered" | "unmetered";
  /** 平时（非高峰）单价：百万 tokens */
  cacheHit: number;
  cacheMiss: number;
  output: number;
  currency: "CNY" | "USD";
  contextWindow: number;
  /** 可选分时计费；存在时按调用时刻在高峰窗口内使用高峰单价 */
  peakBilling?: PeakBilling;
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
  cost: number;
  currency: string;
  lastPromptTokens: number;
  /** Provider-reported cache hit ratio. Estimated calls are never persisted or included. */
  cacheHitRate: number;
  /** Session totals grouped by provider profile and model for billing inspection. */
  callBreakdown: UsageCallSummary[];
}

export interface UsageCallSummary {
  providerName: string;
  model: string;
  callCount: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cost: number;
  currency: string;
}

/** Provider-reported token counts before pricing/UI normalization. */
export interface ModelTokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export type ProviderId = "deepseek" | "openai-compatible";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ResponseVerbosity = "low" | "medium" | "high";

export interface ProviderPublicConfig {
  profileId?: string;
  modelId?: string;
  provider: ProviderId;
  baseUrl: string;
  proxyUrl?: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  source: "project" | "environment";
  pricing: TokenPricing;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  reasoningEffort?: ReasoningEffort;
  verbosity?: ResponseVerbosity;
  disableSampling?: boolean;
  supportsMultimodal?: boolean;
}

export interface ProviderModelPublic {
  id: string;
  name: string;
  pricing: TokenPricing;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  reasoningEffort?: ReasoningEffort;
  verbosity?: ResponseVerbosity;
  /** See ModelConfig.disableSampling — set per model, since this is a model capability. */
  disableSampling?: boolean;
  /** See ModelConfig.supportsMultimodal — set per model. */
  supportsMultimodal?: boolean;
}

export interface ProviderProfilePublic {
  id: string;
  name: string;
  provider: ProviderId;
  baseUrl: string;
  proxyUrl?: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  models: ProviderModelPublic[];
}

export interface ProviderCatalogPublic {
  activeProviderId: string;
  activeModelId: string;
  assignments: Record<ModelUsageRole, { providerId: string; modelId: string }>;
  providers: ProviderProfilePublic[];
}

// "drafter" is retained for compatibility with existing providers.json files;
// the writing pipeline no longer assigns or invokes it.
export type ModelUsageRole = "agent" | "roleplay" | "flash" | "drafter" | "inline" | "writer" | "reviewer" | "summarizer";

export interface StyleTemplate {
  id: string;
  name: string;
  description: string;
  systemPromptAddition: string;
  exampleContent: string;
  exampleNotes: string;
}

/** 消息来源通道：写作 Agent 与角色扮演试演分流上下文。 */
export type MessageChannel = "agent" | "roleplay";

/** OpenAI Chat Completions multimodal content part. */
export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

/** Wire-level message content: plain text, multimodal parts, or null (assistant tool-only). */
export type MessageContent = string | MessageContentPart[] | null;

/** Persisted user image attachment metadata (bytes live under `.writer/attachments/`). */
export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Path relative to project privateDir, e.g. `attachments/<session>/<id>.png`. */
  storagePath: string;
}

/** Inbound image payload from the web/API before it is written to disk. */
export interface MessageAttachmentInput {
  name?: string;
  mimeType: string;
  /** Raw base64 (no data: prefix). */
  dataBase64: string;
}

export interface Message {
  id: number;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  /** agent=写作协作；roleplay=角色扮演试演。默认 agent。 */
  channel: MessageChannel;
  /** How a roleplay user message was submitted. Omitted for non-roleplay and assistant messages. */
  roleplayInputMode?: RoleplayInputMode;
  /** Stable group shared by regenerated copies of the same turn. */
  variantGroupId?: string;
  /** Number of saved/live assistant answers in this regeneration group. */
  variantCount?: number;
  /** User-attached images for this message (agent channel). */
  attachments?: MessageAttachment[];
}

export interface CharacterTemporal { validFrom?: string; validUntil?: string }
export interface CharacterTextEntry extends CharacterTemporal { id: string; label: string; description: string }
export interface CharacterGoal extends CharacterTemporal {
  id: string; category: "longTerm" | "current"; status: "active" | "achieved" | "abandoned" | "blocked" | "unknown";
  priority: number; summary: string; stakes: string; obstacles: string[];
}
export interface CharacterRelationship extends CharacterTemporal {
  id: string; characterId: number; type: string; attitude: string;
  status: "active" | "ended" | "strained" | "unknown"; description: string;
}
export interface CharacterCompetency extends CharacterTemporal {
  id: string; name: string; summary: string; level: string; unlocked: boolean; description: string; resources: string[]; limitations: string[]; costs: string[];
}
export interface CharacterFeature {
  id: string; name: string; summary: string; description: string;
}
export interface CharacterStoryState extends CharacterTemporal {
  id: string; outlineNodeId?: string; unanchored?: boolean; location: string; physical: string; emotion: string;
  knowledge: CharacterTextEntry[]; beliefs: CharacterTextEntry[]; intentions: string[]; temporaryGoals: CharacterGoal[]; notes: string;
}
export interface Character {
  schemaVersion: 3;
  id: number;
  identity: { name: string; aliases: string[]; tags: string[]; narrativeRole: string; summary: string };
  profile: { appearance: string; appearanceSummary: string; background: string; backgroundSummary: string; biography: string };
  psychology: { summary: string; traits: CharacterTextEntry[]; values: CharacterTextEntry[]; fears: CharacterTextEntry[]; conflicts: CharacterTextEntry[] };
  motivations: CharacterGoal[];
  voice: { summary: string; register: string; diction: string[]; verbalHabits: string[]; avoidedExpressions: string[]; examples: string[] };
  /** Stable details that shape portrayal but are not abilities (habits, physiology, quirks, etc.). */
  features: CharacterFeature[];
  competencies: CharacterCompetency[];
  relationships: CharacterRelationship[];
  storyStates: CharacterStoryState[];
  /** Confirmed plot events / formative history (structured; not free-text biography). */
  experiences: CharacterTextEntry[];
  notes: string;
  updatedAt: string;
  extensions?: Record<string, unknown>;
}

export interface WritingExample {
  id: number;
  title: string;
  category: string;
  content: string;
  notes: string;
  updatedAt: string;
}

export type OutlineNodeType = "act" | "chapter" | "scene";
export type OutlineNodeStatus = "idea" | "planned" | "drafted" | "diverged";

export interface OutlineNode {
  id: string;
  parentId?: string;
  type: OutlineNodeType;
  title: string;
  summary: string;
  cause: string;
  action: string;
  outcome: string;
  stateChange: string;
  povCharacterId?: number;
  characterIds: number[];
  location: string;
  time: string;
  plotlines: string[];
  setups: string[];
  payoffs: string[];
  status: OutlineNodeStatus;
  documentPath?: string;
  documentHeading?: string;
  level: number;
  order: number;
  startLine: number;
  endLine: number;
}

export interface OutlineSnapshot {
  schemaVersion: 1;
  sourcePath: string;
  sourceHash: string;
  updatedAt: string;
  nodes: OutlineNode[];
}

export interface Proposal {
  id: number;
  sessionId: string;
  path: string;
  summary: string;
  beforeContent: string;
  afterContent: string;
  baseHash: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  createdAt: string;
  /** Applied only when the linked document proposal is accepted. */
  characterChanges: ProposalCharacterChange[];
  /** Rule-layer writing-quality picture, attached to narrative proposals only. */
  qualityReport?: ProseQualityReport;
}

/**
 * Final writing-quality picture shown to the author before Accept.
 * Built by `buildProseQualityReport` (src/final_quality.ts) from the three
 * deterministic layers; advisory only — it never blocks a proposal.
 */
export interface ProseQualityReport {
  characters: number;
  /** 0–100, higher is better (现场感). */
  vividness: { score: number; summary: string };
  /** 0–100, higher is WORSE (AI 味). */
  aiTells: { score: number; summary: string };
  grade: "good" | "fair" | "weak";
  /**
   * 本轮篇幅目标与实际值。偏短不再阻断交付，作者据这一行决定要不要让它再长一点。
   * 没有目标（例如非章节文档）时缺省。
   */
  length?: { target: number; actual: number; status: "ok" | "too_short" | "too_long" };
  warnings: Array<{
    source: "metrics" | "vividness" | "ai_tells";
    code: string;
    message: string;
    examples: string[];
  }>;
}

export interface ProposalCharacterChange {
  characterId: number;
  reason: string;
  changes: Array<{ op: string; [key: string]: unknown }>;
}

export type ChangeSetFileOperation = "write" | "patch" | "move" | "delete";

export interface ChangeSetFileChange {
  id: number;
  operation: ChangeSetFileOperation;
  path: string;
  targetPath?: string;
  beforeContent: string;
  afterContent: string;
  baseHash: string;
  targetBaseHash?: string;
}

export interface ChangeSet {
  id: number;
  sessionId: string;
  summary: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  undone: boolean;
  createdAt: string;
  files: ChangeSetFileChange[];
  characterChanges: ProposalCharacterChange[];
}

/** Metadata for a document snapshot in browse-only version history. */
export interface DocumentVersionMeta {
  id: number;
  path: string;
  createdAt: string;
  /** Linked proposal summary when the revision came from an accepted proposal. */
  summary: string;
  /** True when this revision's after content matches the live file. */
  isCurrent: boolean;
  createdFile: boolean;
  /** True when this revision was rolled back (still browsable). */
  undone?: boolean;
}

/** Full revision payload for browse-only diff (not exposed to the agent). */
export interface DocumentVersionDetail extends DocumentVersionMeta {
  beforeContent: string;
  afterContent: string;
}

/** Compact metadata used by the chapter workspace without loading every body in the browser. */
export interface ChapterSummary {
  path: string;
  title: string;
  volume: string;
  wordCount: number;
  versionCount: number;
  updatedAt: string;
}

/** Per-model-call token stats (one agent step / draft call). */
export interface RequestComponentUsage {
  kind: "stable_system" | "replayed_turn" | "dynamic_system" | "tool_schema" | "user" | "assistant" | "tool_result" | "other";
  label: string;
  characters: number;
  estimatedTokens: number;
  /** Short content hash for diagnosing whether a supposedly stable prefix drifted. */
  fingerprint?: string;
  callKind?: string;
}

export interface StepUsage {
  /** Actual provider model used for this call; aggregate values may say multiple models. */
  model?: string;
  /** Provider profile used for this call. */
  providerName?: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
  cost: number;
  currency: string;
  /** True when numbers were estimated because the provider omitted stream usage. */
  estimated?: boolean;
  /** Undefined for estimated calls; otherwise cacheHit/(cacheHit+cacheMiss). */
  cacheHitRate?: number;
  /** Pre-request estimate by message/schema component; provider usage remains authoritative. */
  requestComponents?: RequestComponentUsage[];
}

/** Compact Agent step card persisted for workspace refresh / session reload. */
export interface PersistedStreamStep {
  id: number;
  output: string;
  reasoning: string;
  tools: string[];
  status: "running" | "completed" | "failed";
  usage?: StepUsage;
}

/** Server-side step trail keyed by the user (source) message of a turn. */
export interface MessageStepTrail {
  sourceMessageId: number;
  jobId?: string;
  steps: PersistedStreamStep[];
  updatedAt: string;
}

/**
 * One frozen conversation turn (dynamic context block + its tool transcript),
 * replayed byte-verbatim on later turns of the same session so the provider
 * prefix cache keeps hitting. `messages` is the exact wire shape that was sent;
 * never lean-ify it in place — a rewritten body costs one extra full miss.
 */
export interface AgentTurnBlock {
  turnIndex: number;
  messages: AgentTurnMessage[];
  estimatedTokens: number;
  createdAt: string;
}

export interface AgentTurnMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  reasoning_content?: string;
}

export type AgentTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface AgentCheckpoint {
  version: 1;
  stage: "task_started" | "draft_started" | "scene_written" | "guide_revised" | "style_repaired" | "review_blocked" | "review_passed" |
    "document_revision_started" | "proposal_submitted";
  path?: string;
  sourceHash?: string;
  draftVersion?: number;
  completedScenes?: number;
  totalScenes?: number;
  unresolved?: string[];
  reviewRepair?: { mode: "style" | "structural"; targetSceneIds?: string[] };
  artifactIds?: number[];
  proposalId?: number;
  draft?: unknown;
  updatedAt: string;
}

export interface AgentTodoItem {
  id: string;
  content: string;
  status: AgentTodoStatus;
}

export type AgentEvaluationStatus = "running" | "passed" | "failed" | "error";

export interface AgentEvaluationCaseResult {
  id: number;
  runId: string;
  caseId: string;
  sessionId: string;
  prompt: string;
  status: Exclude<AgentEvaluationStatus, "running">;
  expected: Record<string, unknown>;
  result: Record<string, unknown>;
  events: AgentEvent[];
  createdAt: string;
}

export interface AgentEvaluationRun {
  id: string;
  providerSource: string;
  model: string;
  status: AgentEvaluationStatus;
  summary: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
  cases?: AgentEvaluationCaseResult[];
}

/** A compact character card containing only the essentials needed for roleplay. */
export interface SimpleCharacterCard {
  name: string;
  identity: string;
  relationship: string;
  knowledge: string;
  scene: string;
  goal: string;
}

/** Backward-compatible name used by the roleplay generation pipeline. */
export type RoleplayInterlocutor = SimpleCharacterCard;

/** Persisted roleplay-only persona; intentionally separate from full character cards. */
export interface SavedRoleplayInterlocutor extends SimpleCharacterCard {
  id: number;
  targetCharacterId?: number;
  createdAt: string;
  updatedAt: string;
}

export type RoleplayParticipant = {
  kind: "simple" | "normal" | "generated";
  id?: number;
  name: string;
  card: SimpleCharacterCard;
};

/** Session-scoped roleplay selection restored after refresh/session switching. */
export type RoleplayContentRating = "default" | "sfw" | "nsfw";

export interface ActiveRoleplayState {
  performer: RoleplayParticipant;
  identity: RoleplayParticipant;
  scene?: RoleplayScene;
  sceneSequence: RoleplayScene[];
  sceneIndex: number;
  contentRating: RoleplayContentRating;
}

export type RoleplayInputMode = "dialogue" | "director";

/** Reusable scene setup kept separate from character identity. */
export interface RoleplayScene {
  id: number;
  name: string;
  setting: string;
  premise: string;
  tone: string;
  timelineAnchor: string;
  performerGoal: string;
  identityGoal: string;
  stakes: string[];
  openingVariants: string[];
  endConditions: string[];
  loreBindings: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type RoleplayMemoryFactKind = "event" | "promise" | "relationship" | "secret" | "preference";
export type RoleplayMemoryFactStatus = "active" | "superseded" | "retracted";
export type RoleplayKnowledgeScope = "public" | "performer" | "identity";

/** Inspectable roleplay fact with provenance and actor knowledge boundaries. */
export interface RoleplayMemoryFact {
  id: number;
  sessionId: string;
  contextKey: string;
  kind: RoleplayMemoryFactKind;
  content: string;
  sourceMessageId?: number;
  knownBy: RoleplayKnowledgeScope[];
  importance: number;
  status: RoleplayMemoryFactStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoleplayLoreEvidence {
  path: string;
  excerpt: string;
  reason: string;
  sourceHash: string;
}

/** Structured on-stage facts for long roleplay (not prose / not style templates). */
export interface RoleplayWorkingState {
  scene: string;
  proximity: string;
  mood: string;
  openThreads: string[];
  promises: string[];
  revealed: string[];
  relationshipDelta: string;
  /** Dramatic beat label, e.g. 试探 / 僵持 / 缓和 / 冲突升级 */
  beat: string;
  timeInScene: string;
}

/**
 * Long-term roleplay memory for one session+performer.
 * Summary holds cold facts; working state holds live stage continuity.
 */
export interface RoleplaySessionMemory {
  /** Full performer+identity+scene context key. Column name remains performer_key for compatibility. */
  performerKey: string;
  summary: string;
  /** Last message id folded into summary (0 = none). */
  summarizedThroughId: number;
  state: RoleplayWorkingState;
  /** Assistant replies produced while this memory is active. */
  turnCount: number;
  /** Consecutive turns that stayed on the same beat label. */
  sameBeatTurns: number;
  updatedAt: string;
}

export type PermissionMode = "ask" | "auto" | "plan";

export type AgentEvent =
  | { type: "step_start"; step: number }
  | { type: "source_message"; messageId: number; channel?: MessageChannel }
  | { type: "task_contract"; contract: {
      mode: string;
      outcome: "answer" | "document" | "character" | "review" | "multiple";
      evidence: "none" | "project" | "target" | "continuation";
      mutation: "none" | "document" | "character" | "mixed";
      planning: "direct" | "adaptive";
      capabilities: string[];
      workflow?: "free" | "scene_graph" | "chapter_delivery";
      qualityProfile?: "fast" | "standard" | "strict";
    } }
  | { type: "text"; text: string; channel?: "output" | "reasoning" }
  | { type: "tool"; name: string }
  | { type: "step_done"; step: number }
  | { type: "proposal"; proposal: Proposal }
  | { type: "change_set"; changeSet: ChangeSet }
  | { type: "todos"; todos: AgentTodoItem[] }
  | { type: "mode"; mode: PermissionMode }
  | { type: "character"; character: Character }
  | { type: "done"; sessionId: string }
  | { type: "cancelled"; sessionId: string }
  | { type: "waiting_for_input"; sessionId: string; question: string; options?: string[] }
  | { type: "usage"; usage: UsageSummary; step?: number; call?: StepUsage; callKind?: string; jobId?: string }
  | { type: "error"; message: string };
