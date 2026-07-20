import type { ModelConfig } from "./types.js";

export function isDeepSeekModel(model: Pick<ModelConfig, "provider" | "baseUrl">): boolean {
  if (model.provider === "deepseek") return true;
  try {
    return new URL(model.baseUrl).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return model.baseUrl.toLowerCase().includes("api.deepseek.com");
  }
}

/** DeepSeek Thinking supports tools but rejects the OpenAI tool_choice field. */
export function modelSupportsToolChoice(model: Pick<ModelConfig, "provider" | "baseUrl">): boolean {
  return !isDeepSeekModel(model);
}

/** Make DeepSeek's default explicit so a multi-step tool job cannot drift modes. */
export function thinkingRequestOptions(
  model: Pick<ModelConfig, "provider" | "baseUrl">,
): { thinking: { type: "enabled" } } | Record<string, never> {
  return isDeepSeekModel(model) ? { thinking: { type: "enabled" } } : {};
}

/** Keep deterministic extraction calls from spending their output budget on reasoning. */
export function nonThinkingRequestOptions(
  model: Pick<ModelConfig, "provider" | "baseUrl">,
): { thinking: { type: "disabled" } } | Record<string, never> {
  return isDeepSeekModel(model) ? { thinking: { type: "disabled" } } : {};
}
