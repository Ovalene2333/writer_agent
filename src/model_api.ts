/**
 * Provider wire adapter: Chat Completions vs OpenAI Responses API.
 * Call sites keep a chat-style messages/tools shape; this module maps to the selected protocol.
 */
import type { ModelConfig } from "./types.js";
import { samplingRequestOptions } from "./model_compat.js";
import { modelFetch } from "./model_fetch.js";
import { logModelRequest, logModelResponse } from "./model_debug.js";
import { parseModelTokenUsage } from "./model_usage.js";

export type ProviderWireMessage = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
};

export type ProviderToolCall = { id: string; name: string; arguments: string };

export type ProviderUsage = {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
};

export type ProviderCompletionResult = {
  content: string;
  reasoningContent: string;
  toolCalls: ProviderToolCall[];
  finishReason?: string;
  usage?: ProviderUsage;
};

export type ProviderCompletionRequest = {
  model: ModelConfig;
  messages: ProviderWireMessage[];
  tools?: readonly unknown[];
  toolChoice?: unknown;
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  responseFormat?: { type: string };
  thinking?: { type: string };
  userId?: string;
  extra?: Record<string, unknown>;
};

export function usesResponsesApi(model: Pick<ModelConfig, "provider"> | undefined): boolean {
  return model?.provider === "openai-responses";
}

export function modelCompletionEndpoint(model: Pick<ModelConfig, "provider" | "baseUrl">): string {
  const base = model.baseUrl.replace(/\/+$/, "");
  return usesResponsesApi(model) ? `${base}/responses` : `${base}/chat/completions`;
}

export function providerDisplayName(model: Pick<ModelConfig, "provider" | "providerName">): string {
  if (model.providerName?.trim()) return model.providerName.trim();
  if (model.provider === "deepseek") return "DeepSeek";
  if (model.provider === "openai-responses") return "OpenAI Responses";
  return "OpenAI 兼容";
}

function contentToPlainText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") return [record.text];
    if (record.type === "output_text" && typeof record.text === "string") return [record.text];
    if (record.type === "input_text" && typeof record.text === "string") return [record.text];
    return [];
  }).join("\n");
}

function contentToResponsesUserContent(content: unknown): unknown {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push({ type: "input_text", text: record.text });
      continue;
    }
    if (record.type === "image_url") {
      const image = record.image_url && typeof record.image_url === "object"
        ? record.image_url as Record<string, unknown>
        : undefined;
      const url = typeof image?.url === "string" ? image.url : "";
      if (url) parts.push({ type: "input_image", image_url: url });
    }
  }
  if (!parts.length) return contentToPlainText(content);
  if (parts.length === 1 && parts[0].type === "input_text") return parts[0].text;
  return parts;
}

/** Convert chat-completions tools to Responses function tools. */
export function toolsToResponsesFormat(tools: readonly unknown[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
    const record = tool as Record<string, unknown>;
    if (record.type === "function" && record.function && typeof record.function === "object") {
      const fn = record.function as Record<string, unknown>;
      return {
        type: "function",
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
        ...(fn.strict === undefined ? {} : { strict: fn.strict }),
      };
    }
    return tool;
  });
}

/** Split chat messages into Responses instructions + input items. */
export function messagesToResponsesPayload(messages: ProviderWireMessage[]): {
  instructions?: string;
  input: unknown[];
} {
  const instructions: string[] = [];
  const input: unknown[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role === "system" || role === "developer") {
      const text = contentToPlainText(message.content).trim();
      if (text) instructions.push(text);
      continue;
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id || "",
        output: contentToPlainText(message.content),
      });
      continue;
    }
    if (role === "assistant") {
      if (message.tool_calls?.length) {
        for (const call of message.tool_calls) {
          input.push({
            type: "function_call",
            call_id: call.id || "",
            name: call.function?.name || "",
            arguments: call.function?.arguments || "{}",
          });
        }
      }
      const text = contentToPlainText(message.content);
      if (text) {
        input.push({ role: "assistant", content: text });
      }
      continue;
    }
    // user and any other role
    input.push({
      role: role === "user" ? "user" : role,
      content: contentToResponsesUserContent(message.content),
    });
  }
  return {
    ...(instructions.length ? { instructions: instructions.join("\n\n") } : {}),
    input,
  };
}

export function buildProviderCompletionBody(request: ProviderCompletionRequest): Record<string, unknown> {
  const model = request.model;
  const sampling = samplingRequestOptions(model, {
    temperature: request.temperature,
    topP: request.topP,
    frequencyPenalty: request.frequencyPenalty,
    presencePenalty: request.presencePenalty,
  });

  if (!usesResponsesApi(model)) {
    return {
      model: model.model,
      messages: request.messages,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
      ...(request.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
      ...(request.thinking ? { thinking: request.thinking } : {}),
      ...(request.userId ? { user_id: request.userId } : {}),
      ...sampling,
      ...(request.extra ?? {}),
    };
  }

  const { instructions, input } = messagesToResponsesPayload(request.messages);
  const text: Record<string, unknown> = {};
  if (sampling.verbosity) text.verbosity = sampling.verbosity;
  if (request.responseFormat?.type === "json_object") {
    text.format = { type: "json_object" };
  } else if (request.responseFormat?.type === "text") {
    text.format = { type: "text" };
  }

  const body: Record<string, unknown> = {
    model: model.model,
    input,
    ...(instructions ? { instructions } : {}),
    ...(request.stream ? { stream: true } : {}),
    ...(request.maxTokens ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.tools?.length ? { tools: toolsToResponsesFormat(request.tools) } : {}),
    ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice } : {}),
    ...(request.userId ? { user: request.userId } : {}),
    ...(sampling.temperature === undefined ? {} : { temperature: sampling.temperature }),
    ...(sampling.top_p === undefined ? {} : { top_p: sampling.top_p }),
    // Responses does not use frequency/presence penalties in the same way; omit them.
    ...(sampling.reasoning_effort ? { reasoning: { effort: sampling.reasoning_effort } } : {}),
    ...(Object.keys(text).length ? { text } : {}),
    ...(request.extra ?? {}),
  };
  return body;
}

export function usageFromProviderPayload(raw: unknown): ProviderUsage | undefined {
  const parsed = parseModelTokenUsage(raw);
  if (!parsed) return undefined;
  return {
    promptTokens: parsed.promptTokens,
    completionTokens: parsed.completionTokens,
    cacheHitTokens: parsed.cacheHitTokens,
    cacheMissTokens: parsed.cacheMissTokens,
  };
}

/** Parse a non-stream chat/completions or Responses JSON body into a unified result. */
export function parseProviderCompletionPayload(payload: unknown): ProviderCompletionResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { content: "", reasoningContent: "", toolCalls: [] };
  }
  const record = payload as Record<string, unknown>;

  // Chat Completions
  if (Array.isArray(record.choices)) {
    const choice = record.choices[0] as Record<string, unknown> | undefined;
    const message = choice?.message && typeof choice.message === "object"
      ? choice.message as Record<string, unknown>
      : undefined;
    const toolCalls: ProviderToolCall[] = [];
    if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!call || typeof call !== "object") continue;
        const item = call as Record<string, unknown>;
        const fn = item.function && typeof item.function === "object"
          ? item.function as Record<string, unknown>
          : undefined;
        toolCalls.push({
          id: typeof item.id === "string" ? item.id : "",
          name: typeof fn?.name === "string" ? fn.name : "",
          arguments: typeof fn?.arguments === "string" ? fn.arguments : "",
        });
      }
    }
    return {
      content: typeof message?.content === "string" ? message.content : contentToPlainText(message?.content),
      reasoningContent: typeof message?.reasoning_content === "string" ? message.reasoning_content : "",
      toolCalls,
      ...(typeof choice?.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}),
      ...(usageFromProviderPayload(record.usage) ? { usage: usageFromProviderPayload(record.usage) } : {}),
    };
  }

  // Responses API
  const toolCalls: ProviderToolCall[] = [];
  let content = "";
  let reasoningContent = "";
  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "message" && Array.isArray(entry.content)) {
      for (const part of entry.content) {
        if (!part || typeof part !== "object") continue;
        const block = part as Record<string, unknown>;
        if ((block.type === "output_text" || block.type === "text") && typeof block.text === "string") {
          content += block.text;
        }
      }
    } else if (entry.type === "function_call" || entry.type === "custom_tool_call") {
      toolCalls.push({
        id: typeof entry.call_id === "string" ? entry.call_id : (typeof entry.id === "string" ? entry.id : ""),
        name: typeof entry.name === "string" ? entry.name : "",
        arguments: typeof entry.arguments === "string" ? entry.arguments : "",
      });
    } else if (entry.type === "reasoning") {
      if (typeof entry.content === "string") reasoningContent += entry.content;
      if (Array.isArray(entry.summary)) {
        for (const part of entry.summary) {
          if (part && typeof part === "object" && typeof (part as { text?: string }).text === "string") {
            reasoningContent += (part as { text: string }).text;
          }
        }
      }
    }
  }
  // Convenience field when output items are omitted or empty.
  if (!content && typeof record.output_text === "string") content = record.output_text;
  const status = typeof record.status === "string" ? record.status : undefined;
  const finishReason = toolCalls.length
    ? "tool_calls"
    : status === "incomplete"
      ? "length"
      : status === "completed"
        ? "stop"
        : undefined;
  return {
    content,
    reasoningContent,
    toolCalls,
    ...(finishReason ? { finishReason } : {}),
    ...(usageFromProviderPayload(record.usage) ? { usage: usageFromProviderPayload(record.usage) } : {}),
  };
}

type StreamAccumulator = {
  content: string;
  reasoningContent: string;
  toolCalls: Map<number, ProviderToolCall>;
  finishReason?: string;
  usage?: ProviderUsage;
};

function applyChatStreamChunk(chunk: Record<string, unknown>, state: StreamAccumulator, handlers: {
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
}): void {
  if (chunk.usage) {
    const usage = usageFromProviderPayload(chunk.usage);
    if (usage) state.usage = usage;
  }
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] as Record<string, unknown> | undefined : undefined;
  if (typeof choice?.finish_reason === "string") state.finishReason = choice.finish_reason;
  const delta = choice?.delta && typeof choice.delta === "object"
    ? choice.delta as Record<string, unknown>
    : undefined;
  if (!delta) return;
  if (typeof delta.content === "string" && delta.content) {
    state.content += delta.content;
    handlers.onText?.(delta.content);
  }
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    state.reasoningContent += delta.reasoning_content;
    handlers.onReasoning?.(delta.reasoning_content);
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tool of delta.tool_calls) {
      if (!tool || typeof tool !== "object") continue;
      const item = tool as Record<string, unknown>;
      const index = Number(item.index ?? 0);
      const current = state.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof item.id === "string") current.id += item.id;
      const fn = item.function && typeof item.function === "object"
        ? item.function as Record<string, unknown>
        : undefined;
      if (typeof fn?.name === "string") current.name += fn.name;
      if (typeof fn?.arguments === "string") current.arguments += fn.arguments;
      state.toolCalls.set(index, current);
    }
  }
}

function applyResponsesStreamEvent(event: Record<string, unknown>, state: StreamAccumulator, handlers: {
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
}): void {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "response.output_text.delta" && typeof event.delta === "string") {
    state.content += event.delta;
    handlers.onText?.(event.delta);
    return;
  }
  if (
    (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta")
    && typeof event.delta === "string"
  ) {
    state.reasoningContent += event.delta;
    handlers.onReasoning?.(event.delta);
    return;
  }
  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : undefined;
    if (item && (item.type === "function_call" || item.type === "custom_tool_call")) {
      const index = Number(event.output_index ?? state.toolCalls.size);
      const current = state.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof item.call_id === "string" && item.call_id) current.id = item.call_id;
      else if (typeof item.id === "string" && item.id && !current.id) current.id = item.id;
      if (typeof item.name === "string" && item.name) current.name = item.name;
      if (typeof item.arguments === "string" && item.arguments) current.arguments = item.arguments;
      state.toolCalls.set(index, current);
    }
    return;
  }
  if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
    const index = Number(event.output_index ?? 0);
    const current = state.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
    current.arguments += event.delta;
    if (typeof event.call_id === "string" && event.call_id) current.id = event.call_id;
    state.toolCalls.set(index, current);
    return;
  }
  if (type === "response.function_call_arguments.done") {
    const index = Number(event.output_index ?? 0);
    const current = state.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
    if (typeof event.arguments === "string") current.arguments = event.arguments;
    if (typeof event.call_id === "string" && event.call_id) current.id = event.call_id;
    if (typeof event.name === "string" && event.name) current.name = event.name;
    state.toolCalls.set(index, current);
    return;
  }
  if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
    const response = event.response && typeof event.response === "object"
      ? event.response as Record<string, unknown>
      : event;
    const usage = usageFromProviderPayload(response.usage);
    if (usage) state.usage = usage;
    const parsed = parseProviderCompletionPayload(response);
    if (!state.content && parsed.content) state.content = parsed.content;
    if (!state.reasoningContent && parsed.reasoningContent) state.reasoningContent = parsed.reasoningContent;
    if (!state.toolCalls.size && parsed.toolCalls.length) {
      parsed.toolCalls.forEach((call, index) => state.toolCalls.set(index, call));
    }
    if (parsed.finishReason) state.finishReason = parsed.finishReason;
    else if (type === "response.completed") state.finishReason = state.toolCalls.size ? "tool_calls" : "stop";
    else if (type === "response.incomplete") state.finishReason = "length";
  }
}

function consumeSseDataLine(
  data: string,
  state: StreamAccumulator,
  handlers: { onText?: (text: string) => void; onReasoning?: (text: string) => void },
  forceResponses: boolean,
): void {
  if (!data || data === "[DONE]") return;
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  if (forceResponses || (typeof chunk.type === "string" && chunk.type.startsWith("response."))) {
    applyResponsesStreamEvent(chunk, state, handlers);
    return;
  }
  if (Array.isArray(chunk.choices) || chunk.usage) {
    applyChatStreamChunk(chunk, state, handlers);
  }
}

export async function streamProviderCompletion(
  request: ProviderCompletionRequest,
  handlers: {
    onText?: (text: string) => void;
    onReasoning?: (text: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ProviderCompletionResult> {
  const endpoint = modelCompletionEndpoint(request.model);
  const body = buildProviderCompletionBody({ ...request, stream: true });
  const requestBody = JSON.stringify(body);
  logModelRequest(endpoint, requestBody);
  const response = await modelFetch(endpoint, {
    method: "POST",
    signal: handlers.signal,
    headers: {
      "content-type": "application/json",
      ...(request.model.apiKey ? { authorization: `Bearer ${request.model.apiKey}` } : {}),
    },
    body: requestBody,
  }, request.model.proxyUrl);
  if (!response.ok) {
    const responseBody = await response.text();
    logModelResponse(endpoint, responseBody);
    throw new Error(`模型请求失败（${response.status}）：${responseBody.slice(0, 600)}`);
  }
  if (!response.body) throw new Error("模型响应没有可读取的数据流");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state: StreamAccumulator = {
    content: "",
    reasoningContent: "",
    toolCalls: new Map(),
  };
  let buffer = "";
  const forceResponses = usesResponsesApi(request.model);

  const consumeBlock = (block: string) => {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      consumeSseDataLine(line.slice(5).trim(), state, handlers, forceResponses);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) consumeBlock(block);
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);

  const toolCalls = [...state.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call)
    .filter(call => call.name || call.arguments || call.id);
  const result: ProviderCompletionResult = {
    content: state.content,
    reasoningContent: state.reasoningContent,
    toolCalls,
    ...(state.finishReason ? { finishReason: state.finishReason } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
  };
  logModelResponse(endpoint, JSON.stringify(result, null, 2));
  return result;
}

/**
 * Convert a chat-completions-shaped body for the active protocol.
 * Existing call sites can keep assembling OpenAI Chat fields; Responses is mapped here.
 */
export function serializeProviderChatBody(
  model: ModelConfig,
  chatBody: Record<string, unknown>,
): { endpoint: string; body: string } {
  const endpoint = modelCompletionEndpoint(model);
  if (!usesResponsesApi(model)) {
    return { endpoint, body: JSON.stringify(chatBody) };
  }
  const responseFormat = chatBody.response_format && typeof chatBody.response_format === "object"
    ? chatBody.response_format as { type: string }
    : undefined;
  const thinking = chatBody.thinking && typeof chatBody.thinking === "object"
    ? chatBody.thinking as { type: string }
    : undefined;
  const converted = buildProviderCompletionBody({
    model,
    messages: Array.isArray(chatBody.messages) ? chatBody.messages as ProviderWireMessage[] : [],
    tools: Array.isArray(chatBody.tools) ? chatBody.tools : undefined,
    toolChoice: chatBody.tool_choice,
    stream: chatBody.stream === true,
    maxTokens: typeof chatBody.max_tokens === "number" ? chatBody.max_tokens : undefined,
    temperature: typeof chatBody.temperature === "number" ? chatBody.temperature : undefined,
    topP: typeof chatBody.top_p === "number" ? chatBody.top_p : undefined,
    frequencyPenalty: typeof chatBody.frequency_penalty === "number" ? chatBody.frequency_penalty : undefined,
    presencePenalty: typeof chatBody.presence_penalty === "number" ? chatBody.presence_penalty : undefined,
    responseFormat,
    thinking,
    userId: typeof chatBody.user_id === "string"
      ? chatBody.user_id
      : typeof chatBody.user === "string"
        ? chatBody.user
        : undefined,
  });
  return { endpoint, body: JSON.stringify(converted) };
}

/** Prefer unified content extraction; falls back for raw chat/Responses payloads. */
export function contentFromProviderResponseBody(responseBody: string): ProviderCompletionResult {
  try {
    return parseProviderCompletionPayload(JSON.parse(responseBody));
  } catch {
    return { content: "", reasoningContent: "", toolCalls: [] };
  }
}

export async function completeProviderCompletion(
  request: ProviderCompletionRequest,
  signal?: AbortSignal,
): Promise<ProviderCompletionResult> {
  const endpoint = modelCompletionEndpoint(request.model);
  const body = buildProviderCompletionBody({ ...request, stream: false });
  const requestBody = JSON.stringify(body);
  logModelRequest(endpoint, requestBody);
  const response = await modelFetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(request.model.apiKey ? { authorization: `Bearer ${request.model.apiKey}` } : {}),
    },
    body: requestBody,
  }, request.model.proxyUrl);
  const responseBody = await response.text();
  logModelResponse(endpoint, responseBody);
  if (!response.ok) {
    throw new Error(`模型请求失败（${response.status}）：${responseBody.slice(0, 600)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(responseBody);
  } catch {
    throw new Error("模型响应不是有效 JSON");
  }
  return parseProviderCompletionPayload(payload);
}
