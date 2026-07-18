import type { AgentEvent, ModelConfig, ModelTokenUsage, StepUsage } from "./types.js";
import type { WriterStore } from "./store.js";
import { calculateUsageCost } from "./pricing.js";

export type ModelUsageMeta = {
  callKind: string;
  step?: number;
  jobId?: string;
};

export type ModelUsageReporter = (
  model: ModelConfig,
  usage: ModelTokenUsage,
  meta: ModelUsageMeta,
) => void;

export function parseModelTokenUsage(value: unknown): ModelTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const details = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === "object"
    ? raw.prompt_tokens_details as Record<string, unknown>
    : raw.input_tokens_details && typeof raw.input_tokens_details === "object"
      ? raw.input_tokens_details as Record<string, unknown>
      : undefined;
  const promptTokens = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0);
  const completionTokens = Number(raw.completion_tokens ?? raw.output_tokens ?? 0);
  const cacheHitTokens = Number(raw.prompt_cache_hit_tokens ?? details?.cached_tokens ?? 0);
  if (!(promptTokens > 0 || completionTokens > 0)) return undefined;
  return {
    promptTokens,
    completionTokens,
    cacheHitTokens,
    cacheMissTokens: Number(raw.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens)),
  };
}

export function buildRecordedUsageEvent(
  store: WriterStore,
  sessionId: string,
  model: ModelConfig,
  usage: ModelTokenUsage,
  meta: ModelUsageMeta,
): AgentEvent {
  const cacheMissTokens = usage.cacheMissTokens || Math.max(0, usage.promptTokens - usage.cacheHitTokens);
  const normalized = { ...usage, cacheMissTokens };
  const call: StepUsage = {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens,
    totalTokens: usage.promptTokens + usage.completionTokens,
    cost: model.pricing ? calculateUsageCost(normalized, model.pricing) : 0,
    currency: model.pricing?.currency ?? "CNY",
    cacheHitRate: usage.cacheHitTokens + cacheMissTokens > 0
      ? usage.cacheHitTokens / (usage.cacheHitTokens + cacheMissTokens)
      : 0,
  };
  const summary = model.pricing
    ? store.recordUsage(sessionId, model.model, normalized, model.pricing, new Date(), meta)
    : store.usage(sessionId);
  return {
    type: "usage",
    usage: summary,
    call,
    ...(meta.step === undefined ? {} : { step: meta.step }),
    callKind: meta.callKind,
    ...(meta.jobId ? { jobId: meta.jobId } : {}),
  };
}
