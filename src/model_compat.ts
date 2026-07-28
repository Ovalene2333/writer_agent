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

export type SamplingRequest = {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
};

export type SamplingRequestBody = {
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  reasoning_effort?: ModelConfig["reasoningEffort"];
  verbosity?: ModelConfig["verbosity"];
};

/**
 * Single choke point for configurable sampling and OpenAI request fields.
 *
 * Call sites must not spell `temperature:` into a request body directly. Most of
 * them used to hardcode a literal (`temperature: 0` for extraction and judging,
 * `?? 0.9` for prose), which meant clearing temperature in provider settings
 * changed almost nothing: the model config was consulted in 3 places out of 13,
 * and every other call still sent a value the provider had deprecated.
 *
 * Passing `disableSampling` drops the sampling group rather than just temperature;
 * configured reasoning effort and verbosity remain independent.
 * Models that reject `temperature` reject `top_p` and the penalties too, and an
 * omitted parameter simply falls back to the provider default — omitting can
 * never fail a request, so the safe superset costs nothing.
 */
export function samplingRequestOptions(
  model: Partial<Pick<ModelConfig, "provider" | "baseUrl" | "temperature" | "topP" | "frequencyPenalty" | "presencePenalty" | "reasoningEffort" | "verbosity" | "disableSampling">>,
  requested: SamplingRequest = {},
): SamplingRequestBody {
  const openAiOptions = model.provider === "deepseek" || (model.baseUrl && isDeepSeekModel(model as Pick<ModelConfig, "provider" | "baseUrl">))
    ? {}
    : {
        ...(model.reasoningEffort === undefined ? {} : { reasoning_effort: model.reasoningEffort }),
        ...(model.verbosity === undefined ? {} : { verbosity: model.verbosity }),
      };
  if (model.disableSampling) return openAiOptions;
  const temperature = requested.temperature ?? model.temperature;
  const topP = requested.topP ?? model.topP;
  const frequencyPenalty = requested.frequencyPenalty ?? model.frequencyPenalty;
  const presencePenalty = requested.presencePenalty ?? model.presencePenalty;
  return {
    ...openAiOptions,
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    ...(frequencyPenalty === undefined ? {} : { frequency_penalty: frequencyPenalty }),
    ...(presencePenalty === undefined ? {} : { presence_penalty: presencePenalty }),
  };
}

/** Keep deterministic extraction calls from spending their output budget on reasoning. */
export function nonThinkingRequestOptions(
  model: Pick<ModelConfig, "provider" | "baseUrl">,
): { thinking: { type: "disabled" } } | Record<string, never> {
  return isDeepSeekModel(model) ? { thinking: { type: "disabled" } } : {};
}
