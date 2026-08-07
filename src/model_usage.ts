import type { AgentEvent, ModelConfig, ModelTokenUsage, RequestComponentUsage, StepUsage } from "./types.js";
import type { WriterStore } from "./store.js";
import { calculateUsageCost } from "./pricing.js";

export type ModelUsageMeta = {
  callKind: string;
  step?: number;
  jobId?: string;
  requestComponents?: RequestComponentUsage[];
  /** Wall-clock provider request duration when measured by the caller. */
  durationMs?: number;
};

export type ModelUsageReporter = (
  model: ModelConfig,
  usage: ModelTokenUsage,
  meta: ModelUsageMeta,
) => void;

/** Pure visible completion tokens (completion − reasoning when reasoning is nested in completion). */
export function pureOutputTokens(usage: {
  completionTokens: number;
  reasoningTokens?: number;
}): number {
  const reasoning = Math.max(0, Math.round(usage.reasoningTokens ?? 0));
  return Math.max(0, usage.completionTokens - Math.min(reasoning, usage.completionTokens));
}

function readReasoningTokens(raw: Record<string, unknown>): number | undefined {
  const completionDetails = raw.completion_tokens_details && typeof raw.completion_tokens_details === "object"
    ? raw.completion_tokens_details as Record<string, unknown>
    : undefined;
  const outputDetails = raw.output_tokens_details && typeof raw.output_tokens_details === "object"
    ? raw.output_tokens_details as Record<string, unknown>
    : undefined;
  const candidates = [
    completionDetails?.reasoning_tokens,
    outputDetails?.reasoning_tokens,
    raw.reasoning_tokens,
    raw.thinking_tokens,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  // Explicit zero is still useful for “no reasoning this call”.
  for (const value of candidates) {
    if (value === 0 || value === "0") return 0;
  }
  return undefined;
}

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
  const cacheWriteTokens = Number(raw.cache_creation_input_tokens ?? details?.cache_write_tokens ?? 0);
  const reasoningTokens = readReasoningTokens(raw);
  if (!(promptTokens > 0 || completionTokens > 0)) return undefined;
  return {
    promptTokens,
    completionTokens,
    cacheHitTokens,
    cacheMissTokens: Number(raw.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens)),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
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
  const providerName = model.providerName?.trim()
    || (model.provider === "deepseek"
      ? "DeepSeek"
      : model.provider === "openai-responses"
        ? "OpenAI Responses"
        : "API");
  const call: StepUsage = {
    model: model.model,
    providerName,
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
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(meta.durationMs !== undefined && Number.isFinite(meta.durationMs)
      ? { durationMs: Math.max(0, Math.round(meta.durationMs)) }
      : {}),
    ...(meta.requestComponents?.length
      ? { requestComponents: meta.requestComponents.map(component => ({ ...component, callKind: meta.callKind })) }
      : {}),
  };
  // Always persist a row — failed dependency calls often have 0 tokens but must remain
  // queryable by job_id / call_kind for product diagnostics.
  const pricing = model.pricing ?? {
    billingMode: "unmetered" as const,
    cacheHit: 0,
    cacheMiss: 0,
    output: 0,
    currency: "CNY" as const,
    contextWindow: 128_000,
  };
  const summary = store.recordUsage(
    sessionId,
    model.model,
    normalized,
    pricing,
    new Date(),
    { ...meta, providerName },
  );
  return {
    type: "usage",
    usage: summary,
    call,
    ...(meta.step === undefined ? {} : { step: meta.step }),
    callKind: meta.callKind,
    ...(meta.jobId ? { jobId: meta.jobId } : {}),
  };
}
