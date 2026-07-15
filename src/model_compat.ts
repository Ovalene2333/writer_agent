import type { ModelConfig } from "./types.js";

/** DeepSeek Thinking supports tools but rejects the OpenAI tool_choice field. */
export function modelSupportsToolChoice(model: Pick<ModelConfig, "provider" | "baseUrl">): boolean {
  if (model.provider === "deepseek") return false;
  try {
    return new URL(model.baseUrl).hostname.toLowerCase() !== "api.deepseek.com";
  } catch {
    return !model.baseUrl.toLowerCase().includes("api.deepseek.com");
  }
}
