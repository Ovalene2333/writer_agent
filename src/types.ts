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

export interface TokenPricing {
  cacheHit: number;
  cacheMiss: number;
  output: number;
  currency: "CNY" | "USD";
  contextWindow: number;
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

// "drafter" is retained for compatibility with existing provider.json files;
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
  id: number;
  name: string;
  aliases: string[];
  role: string;
  appearance: string;
  traits: string;
  background: string;
  goals: string;
  relationships: string;
  relatedCharacterIds: number[];
  abilities: string;
  notes: string;
  updatedAt: string;
}

export interface WritingExample {
  id: number;
  title: string;
  category: string;
  content: string;
  notes: string;
  updatedAt: string;
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

export type AgentEvent =
  | { type: "step_start"; step: number }
  | { type: "text"; text: string; channel?: "output" | "reasoning" }
  | { type: "tool"; name: string }
  | { type: "step_done"; step: number }
  | { type: "proposal"; proposal: Proposal }
  | { type: "character"; character: Character }
  | { type: "done"; sessionId: string }
  | { type: "cancelled"; sessionId: string }
  | { type: "usage"; usage: UsageSummary }
  | { type: "error"; message: string };
