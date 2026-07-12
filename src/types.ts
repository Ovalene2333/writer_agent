export interface WriterConfig {
  title: string;
  language: string;
  chapters: string[];
  style?: string;
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: ProviderId;
  pricing?: TokenPricing;
  temperature?: number;
  topP?: number;
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
}

export type ProviderId = "deepseek" | "openai-compatible";

export interface ProviderPublicConfig {
  profileId?: string;
  modelId?: string;
  provider: ProviderId;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  source: "project" | "environment";
  pricing: TokenPricing;
  temperature?: number;
  topP?: number;
}

export interface ProviderModelPublic {
  id: string;
  name: string;
  pricing: TokenPricing;
  temperature?: number;
  topP?: number;
}

export interface ProviderProfilePublic {
  id: string;
  name: string;
  provider: ProviderId;
  baseUrl: string;
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
export type ModelUsageRole = "agent" | "drafter" | "inline" | "writer" | "reviewer" | "summarizer";

export interface StyleTemplate {
  id: string;
  name: string;
  description: string;
  systemPromptAddition: string;
  suggestedTemperature: number;
  suggestedTopP: number;
  exampleContent: string;
  exampleNotes: string;
}

export interface Message {
  id: number;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
}

export interface Character {
  schemaVersion: 2;
  id: number;
  name: string;
  aliases: string[];
  narrativeRole: string;
  identity: string;
  appearance: string;
  personality: string;
  values: string;
  speechStyle: string;
  background: string;
  longTermGoal: string;
  currentGoal: string;
  fears: string;
  capabilities: string;
  limitations: string;
  relationships: CharacterRelationship[];
  notes: string;
  updatedAt: string;
}

export interface CharacterRelationship {
  characterId: number;
  type: string;
  description: string;
  attitude: string;
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
}

/** Full revision payload for browse-only diff (not exposed to the agent). */
export interface DocumentVersionDetail extends DocumentVersionMeta {
  beforeContent: string;
  afterContent: string;
}

/** Per-model-call token stats (one agent step / draft call). */
export interface StepUsage {
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
}

export type AgentTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface AgentTodoItem {
  id: string;
  content: string;
  status: AgentTodoStatus;
}

export type PermissionMode = "ask" | "auto" | "plan";

export type AgentEvent =
  | { type: "step_start"; step: number }
  | { type: "text"; text: string; channel?: "output" | "reasoning" }
  | { type: "tool"; name: string }
  | { type: "step_done"; step: number }
  | { type: "proposal"; proposal: Proposal }
  | { type: "todos"; todos: AgentTodoItem[] }
  | { type: "mode"; mode: PermissionMode }
  | { type: "character"; character: Character }
  | { type: "done"; sessionId: string }
  | { type: "cancelled"; sessionId: string }
  | { type: "waiting_for_input"; sessionId: string; question: string; options?: string[] }
  | { type: "usage"; usage: UsageSummary; step?: number; call?: StepUsage }
  | { type: "error"; message: string };
