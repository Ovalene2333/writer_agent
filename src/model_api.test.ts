import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderCompletionBody,
  messagesToResponsesPayload,
  modelCompletionEndpoint,
  parseProviderCompletionPayload,
  toolsToResponsesFormat,
  usesResponsesApi,
} from "./model_api.js";
import type { ModelConfig } from "./types.js";

const chatModel = {
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk",
  model: "gpt-4.1-mini",
} as ModelConfig;

const responsesModel = {
  provider: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk",
  model: "gpt-5",
  reasoningEffort: "medium",
  verbosity: "low",
} as ModelConfig;

test("usesResponsesApi and endpoint selection", () => {
  assert.equal(usesResponsesApi(chatModel), false);
  assert.equal(usesResponsesApi(responsesModel), true);
  assert.equal(modelCompletionEndpoint(chatModel), "https://api.openai.com/v1/chat/completions");
  assert.equal(modelCompletionEndpoint(responsesModel), "https://api.openai.com/v1/responses");
});

test("messages and tools convert to Responses payload", () => {
  const { instructions, input } = messagesToResponsesPayload([
    { role: "system", content: "规则" },
    { role: "user", content: "你好" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", function: { name: "search_project", arguments: "{\"q\":\"x\"}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "{\"ok\":true}" },
  ]);
  assert.equal(instructions, "规则");
  assert.deepEqual(input[0], { role: "user", content: "你好" });
  assert.equal((input[1] as { type: string }).type, "function_call");
  assert.equal((input[2] as { type: string }).type, "function_call_output");
  const tools = toolsToResponsesFormat([
    { type: "function", function: { name: "search_project", description: "d", parameters: { type: "object" } } },
  ]);
  assert.deepEqual(tools?.[0], {
    type: "function",
    name: "search_project",
    description: "d",
    parameters: { type: "object" },
  });
});

test("buildProviderCompletionBody shapes chat vs responses", () => {
  const chat = buildProviderCompletionBody({
    model: chatModel,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    responseFormat: { type: "json_object" },
  });
  assert.equal(chat.stream, true);
  assert.ok(Array.isArray(chat.messages));
  assert.deepEqual(chat.response_format, { type: "json_object" });

  const responses = buildProviderCompletionBody({
    model: responsesModel,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    stream: true,
    maxTokens: 100,
    userId: "project-cache-key",
    responseFormat: { type: "json_object" },
  });
  assert.equal(responses.stream, true);
  assert.equal(responses.instructions, "sys");
  assert.ok(Array.isArray(responses.input));
  assert.equal(responses.max_output_tokens, 100);
  assert.equal(responses.prompt_cache_key, "project-cache-key");
  assert.deepEqual(responses.reasoning, { effort: "medium" });
  assert.deepEqual(responses.text, { verbosity: "low", format: { type: "json_object" } });
  assert.equal(responses.messages, undefined);
});

test("buildProviderCompletionBody maps thinking intent by ProviderId only", () => {
  const deepseek = buildProviderCompletionBody({
    model: {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk",
      model: "deepseek-chat",
      reasoningEffort: "medium",
    } as ModelConfig,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
  });
  assert.deepEqual(deepseek.thinking, { type: "disabled" });
  assert.equal(deepseek.reasoning_effort, undefined);

  // openai-compatible protocol is identical whether the model id is gpt or deepseek.
  const openAiDeepseekWeights = buildProviderCompletionBody({
    model: {
      provider: "openai-compatible",
      baseUrl: "https://opencode.example/v1",
      apiKey: "sk",
      model: "deepseek-v4-flash",
      reasoningEffort: "medium",
    } as ModelConfig,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
  });
  assert.equal(openAiDeepseekWeights.thinking, undefined);
  assert.equal(openAiDeepseekWeights.reasoning_effort, "none");

  const openAi = buildProviderCompletionBody({
    model: {
      ...chatModel,
      reasoningEffort: "medium",
    },
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
  });
  assert.equal(openAi.thinking, undefined);
  assert.equal(openAi.reasoning_effort, "none");
});

test("parseProviderCompletionPayload reads both protocols", () => {
  const chat = parseProviderCompletionPayload({
    choices: [{ finish_reason: "stop", message: { content: "回答", tool_calls: [] } }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  });
  assert.equal(chat.content, "回答");
  assert.equal(chat.usage?.promptTokens, 10);

  const responses = parseProviderCompletionPayload({
    status: "completed",
    output_text: "你好",
    output: [
      { type: "message", content: [{ type: "output_text", text: "你好" }] },
      { type: "function_call", call_id: "c1", name: "search_project", arguments: "{}" },
    ],
    usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } },
  });
  assert.equal(responses.content, "你好");
  assert.equal(responses.toolCalls[0]?.name, "search_project");
  assert.equal(responses.usage?.cacheHitTokens, 2);
});
