import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { modelFetch } from "./model_fetch.js";
import type { WriterProject } from "./project.js";

const DEFAULT_MODEL = "grok-build-0.1";
const DEFAULT_UPSTREAM = "https://cli-chat-proxy.grok.com/v1";
const OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const OAUTH_AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize";
const OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const OAUTH_REDIRECT_URI = "http://127.0.0.1:56121/callback";
const GROK_CLI_VERSION = "0.2.93";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

type GrokCredentials = {
  version: 1;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  localApiKey: string;
  cacheKey: string;
};

type OAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type ChatToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type ChatMessage = {
  role?: string;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
};

type ChatRequest = {
  model?: string;
  messages?: ChatMessage[];
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown; strict?: boolean } }>;
  tool_choice?: unknown;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  parallel_tool_calls?: boolean;
  instructions?: string;
};

type ProxyOptions = {
  project: WriterProject;
  host?: string;
  port?: number;
  model?: string;
  upstream?: string;
  proxyUrl?: string;
  forceLogin?: boolean;
  openUrl?: (url: string) => void;
};

type StreamState = {
  id: string;
  model: string;
  created: number;
  roleSent: boolean;
  finalized: boolean;
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  outputToolIndexes: Map<number, number>;
  includeUsage: boolean;
  usage?: Record<string, unknown>;
  finishReason: "stop" | "length" | "content_filter" | "tool_calls";
};

export async function startGrokBuildProxy(options: ProxyOptions): Promise<{
  url: string;
  apiKey: string;
  model: string;
  credentialsPath: string;
  proxyEnabled: boolean;
  close: () => Promise<void>;
}> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4101;
  const model = options.model?.trim() || DEFAULT_MODEL;
  const upstream = normalizeUpstream(options.upstream);
  const proxyUrl = resolveOutboundProxy(options.proxyUrl);
  const credentialsPath = resolve(options.project.privateDir, "grok-proxy.json");
  let credentials = loadCredentials(credentialsPath);

  if (options.forceLogin || !credentials?.accessToken) {
    credentials = await loginWithBrowser(proxyUrl, options.openUrl);
    const previous = loadCredentials(credentialsPath);
    credentials.localApiKey = previous?.localApiKey || `sk-grok-local-${randomBytes(18).toString("base64url")}`;
    credentials.cacheKey = previous?.cacheKey || randomUUID();
    saveCredentials(credentialsPath, credentials);
  }

  let activeCredentials = await refreshCredentialsIfNeeded(credentialsPath, credentials, proxyUrl);
  let queue = Promise.resolve();
  const server = createServer((request, response) => {
    const run = async () => {
      activeCredentials = await handleRequest(request, response, {
        credentials: activeCredentials,
        credentialsPath,
        model,
        upstream,
        proxyUrl,
      });
    };
    const current = queue.then(run, run);
    queue = current.catch(() => undefined);
    void current.catch((error) => {
      if (response.headersSent) response.destroy(error instanceof Error ? error : new Error(String(error)));
      else writeError(response, 500, errorMessage(error));
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    url: `http://${formatHost(publicHost)}:${actualPort}/v1`,
    apiKey: activeCredentials.localApiKey,
    model,
    credentialsPath,
    proxyEnabled: Boolean(proxyUrl),
    close: () => new Promise<void>((resolvePromise, reject) => {
      server.close(error => error ? reject(error) : resolvePromise());
    }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    credentials: GrokCredentials;
    credentialsPath: string;
    model: string;
    upstream: string;
    proxyUrl?: string;
  },
): Promise<GrokCredentials> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
  if (request.method === "GET" && (path === "/health" || path === "/v1/health")) {
    writeJSON(response, 200, { ok: true, model: context.model });
    return context.credentials;
  }
  if (!authorized(request, context.credentials.localApiKey)) {
    writeJSON(response, 401, { error: { type: "authentication_error", message: "Grok 反代 API Key 无效" } });
    return context.credentials;
  }
  if (request.method === "GET" && (path === "/models" || path === "/v1/models")) {
    writeJSON(response, 200, { object: "list", data: [{ id: context.model, object: "model", owned_by: "xai" }] });
    return context.credentials;
  }
  if (request.method !== "POST" || (path !== "/chat/completions" && path !== "/v1/chat/completions")) {
    writeJSON(response, 404, { error: { type: "invalid_request_error", message: "仅支持 /v1/models 与 /v1/chat/completions" } });
    return context.credentials;
  }

  const body = await readJSONBody(request);
  const chat = validateChatRequest(body);
  let credentials = await refreshCredentialsIfNeeded(context.credentialsPath, context.credentials, context.proxyUrl);
  let upstreamResponse = await requestGrok(chat, credentials.accessToken, context);
  if (upstreamResponse.status === 401 && credentials.refreshToken) {
    credentials = await refreshCredentials(context.credentialsPath, credentials, context.proxyUrl);
    upstreamResponse = await requestGrok(chat, credentials.accessToken, context);
  }
  if (!upstreamResponse.ok) {
    const errorBody = await upstreamResponse.text();
    response.statusCode = upstreamResponse.status;
    response.setHeader("content-type", upstreamResponse.headers.get("content-type") || "application/json; charset=utf-8");
    response.end(errorBody || JSON.stringify({ error: { message: `xAI upstream returned ${upstreamResponse.status}` } }));
    return credentials;
  }
  if (!upstreamResponse.body) throw new Error("xAI 上游没有返回响应体");

  if (chat.stream) {
    await streamChatResponse(upstreamResponse.body, response, chat, context.model);
  } else {
    const state = createStreamState(context.model);
    await consumeSSE(upstreamResponse.body, event => applyResponseEvent(event, state));
    writeJSON(response, 200, bufferedChatResponse(state));
  }
  return credentials;
}

async function requestGrok(
  chat: ChatRequest,
  accessToken: string,
  context: { model: string; upstream: string; proxyUrl?: string; credentials: GrokCredentials },
): Promise<Response> {
  const responseBody = chatToResponses(chat, context.model, context.credentials.cacheKey);
  return modelFetch(`${context.upstream}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "writer-agent-grok/1.0",
      "x-grok-client-version": GROK_CLI_VERSION,
      "x-grok-client-mode": "interactive",
      "x-grok-conv-id": context.credentials.cacheKey,
    },
    body: JSON.stringify(responseBody),
  }, context.proxyUrl);
}

function chatToResponses(chat: ChatRequest, model: string, cacheKey: string): Record<string, unknown> {
  const input: unknown[] = [];
  for (const message of chat.messages ?? []) {
    const role = message.role;
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: requiredString(message.tool_call_id, "tool_call_id"),
        output: messageContentText(message.content) || "(empty)",
      });
      continue;
    }
    if (role === "assistant") {
      const content = responsesMessageContent(message.content, "assistant");
      if (content !== "" && (!Array.isArray(content) || content.length > 0)) input.push({ role: "assistant", content });
      for (const call of message.tool_calls ?? []) {
        if (call.type && call.type !== "function") throw new Error(`不支持的工具调用类型：${call.type}`);
        input.push({
          type: "function_call",
          call_id: requiredString(call.id, "tool_calls[].id"),
          name: requiredString(call.function?.name, "tool_calls[].function.name"),
          arguments: call.function?.arguments ?? "{}",
        });
      }
      continue;
    }
    if (role !== "system" && role !== "developer" && role !== "user") throw new Error(`不支持的消息角色：${String(role)}`);
    input.push({ role, content: responsesMessageContent(message.content, role) });
  }

  const tools = (chat.tools ?? []).map(tool => {
    if (tool.type !== "function" || !tool.function) throw new Error("Grok Build 反代仅支持 function 工具");
    return {
      type: "function",
      name: requiredString(tool.function.name, "tools[].function.name"),
      ...(tool.function.description ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters ?? { type: "object", properties: {} },
      strict: tool.function.strict ?? false,
    };
  });
  const maxTokens = chat.max_completion_tokens ?? chat.max_tokens;
  return {
    model,
    input,
    stream: true,
    store: false,
    prompt_cache_key: cacheKey,
    ...(chat.instructions ? { instructions: chat.instructions } : {}),
    ...(maxTokens !== undefined ? { max_output_tokens: Math.max(128, maxTokens) } : {}),
    ...(chat.parallel_tool_calls !== undefined ? { parallel_tool_calls: chat.parallel_tool_calls } : {}),
    ...(tools.length ? { tools } : {}),
    ...(chat.tool_choice !== undefined && tools.length ? { tool_choice: convertToolChoice(chat.tool_choice) } : {}),
  };
}

function responsesMessageContent(content: unknown, role: string): string | unknown[] {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) throw new Error(`${role} 消息 content 必须是字符串或内容数组`);
  return content.flatMap<unknown>(part => {
    if (!part || typeof part !== "object") return [];
    const value = part as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") return [{ type: "input_text", text: value.text }];
    const image = value.image_url;
    if (value.type === "image_url" && image && typeof image === "object" && typeof (image as Record<string, unknown>).url === "string") {
      return [{ type: "input_image", image_url: (image as Record<string, unknown>).url }];
    }
    return [];
  });
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => {
    if (!part || typeof part !== "object") return [];
    const value = part as Record<string, unknown>;
    return typeof value.text === "string" ? [value.text] : [];
  }).join("");
}

function convertToolChoice(choice: unknown): unknown {
  if (typeof choice === "string") return choice;
  if (!choice || typeof choice !== "object") throw new Error("tool_choice 格式无效");
  const value = choice as Record<string, unknown>;
  const fn = value.function;
  if (value.type === "function" && fn && typeof fn === "object") {
    return { type: "function", name: requiredString((fn as Record<string, unknown>).name, "tool_choice.function.name") };
  }
  throw new Error("Grok Build 反代不支持该 tool_choice 格式");
}

async function streamChatResponse(body: ReadableStream<Uint8Array>, response: ServerResponse, chat: ChatRequest, model: string): Promise<void> {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  const includeUsage = chat.stream_options?.include_usage === true;
  const state = createStreamState(model, includeUsage);
  await consumeSSE(body, event => {
    const chunks = applyResponseEvent(event, state);
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  });
  if (!state.finalized) {
    for (const chunk of finalizeChunks(state)) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

async function consumeSSE(body: ReadableStream<Uint8Array>, onEvent: (event: Record<string, unknown>) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const normalized = buffer.replace(/\r\n/g, "\n");
    const events = normalized.split("\n\n");
    buffer = events.pop() ?? "";
    for (const block of events) parseSSEBlock(block, onEvent);
    if (done) break;
  }
  if (buffer.trim()) parseSSEBlock(buffer, onEvent);
}

function parseSSEBlock(block: string, onEvent: (event: Record<string, unknown>) => void): void {
  const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return;
  const parsed = JSON.parse(data) as unknown;
  if (parsed && typeof parsed === "object") onEvent(parsed as Record<string, unknown>);
}

function applyResponseEvent(event: Record<string, unknown>, state: StreamState): unknown[] {
  const type = typeof event.type === "string" ? event.type : "";
  const response = objectValue(event.response);
  if (response) {
    if (typeof response.id === "string") state.id = response.id;
    if (typeof response.model === "string") state.model = response.model;
    const usage = objectValue(response.usage);
    if (usage) state.usage = chatUsage(usage);
  }
  const usage = objectValue(event.usage);
  if (usage) state.usage = chatUsage(usage);
  const chunks: unknown[] = [];
  const ensureRole = () => {
    if (!state.roleSent) {
      state.roleSent = true;
      chunks.push(chatChunk(state, { role: "assistant" }, null));
    }
  };
  if (type === "response.created") ensureRole();
  else if (type === "response.output_text.delta" && typeof event.delta === "string") {
    ensureRole(); state.content += event.delta; chunks.push(chatChunk(state, { content: event.delta }, null));
  } else if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && typeof event.delta === "string") {
    ensureRole(); state.reasoning += event.delta; chunks.push(chatChunk(state, { reasoning_content: event.delta }, null));
  } else if (type === "response.output_item.added") {
    const item = objectValue(event.item);
    if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      ensureRole();
      const toolIndex = state.toolCalls.length;
      const outputIndex = numberValue(event.output_index, toolIndex);
      const call = {
        id: stringValue(item.call_id) || `call_${randomBytes(9).toString("base64url")}`,
        type: "function" as const,
        function: { name: stringValue(item.name), arguments: "" },
      };
      state.outputToolIndexes.set(outputIndex, toolIndex);
      state.toolCalls.push(call);
      chunks.push(chatChunk(state, { tool_calls: [{ index: toolIndex, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }, null));
    }
  } else if ((type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta") && typeof event.delta === "string") {
    const index = state.outputToolIndexes.get(numberValue(event.output_index, -1));
    if (index !== undefined) {
      state.toolCalls[index].function.arguments += event.delta;
      chunks.push(chatChunk(state, { tool_calls: [{ index, function: { arguments: event.delta } }] }, null));
    }
  } else if (type === "response.output_item.done") {
    const item = objectValue(event.item);
    if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      const index = state.outputToolIndexes.get(numberValue(event.output_index, -1));
      if (index !== undefined) fillToolCallFromItem(state.toolCalls[index], item);
    }
  } else if (type === "response.completed" || type === "response.done" || type === "response.incomplete" || type === "response.failed") {
    hydrateFromTerminalResponse(response, state);
    state.finishReason = terminalFinishReason(response, state.toolCalls.length > 0);
    state.finalized = true;
    chunks.push(chatChunk(state, { content: "" }, state.finishReason));
    if (state.includeUsage && state.usage) chunks.push(usageChunk(state));
  }
  return chunks;
}

function hydrateFromTerminalResponse(response: Record<string, unknown> | undefined, state: StreamState): void {
  if (!response) return;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const raw of output) {
    const item = objectValue(raw);
    if (!item) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        const part = objectValue(rawPart);
        if (!state.content && part?.type === "output_text" && typeof part.text === "string") state.content += part.text;
      }
    } else if (item.type === "function_call") {
      const callID = stringValue(item.call_id);
      const existing = state.toolCalls.find(call => call.id === callID);
      if (existing) fillToolCallFromItem(existing, item);
      else state.toolCalls.push({
        id: callID, type: "function",
        function: { name: stringValue(item.name), arguments: stringValue(item.arguments) || "{}" },
      });
    }
  }
}

function fillToolCallFromItem(
  call: { id: string; type: "function"; function: { name: string; arguments: string } },
  item: Record<string, unknown>,
): void {
  if (!call.id) call.id = stringValue(item.call_id);
  if (!call.function.name) call.function.name = stringValue(item.name);
  if (!call.function.arguments) call.function.arguments = stringValue(item.arguments) || "{}";
}

function bufferedChatResponse(state: StreamState): Record<string, unknown> {
  return {
    id: state.id,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: state.content || null,
        ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
        ...(state.toolCalls.length ? { tool_calls: state.toolCalls } : {}),
      },
      finish_reason: state.finishReason,
    }],
    ...(state.usage ? { usage: state.usage } : {}),
  };
}

function createStreamState(model: string, includeUsage = true): StreamState {
  return {
    id: `chatcmpl-${randomBytes(12).toString("hex")}`,
    model,
    created: Math.floor(Date.now() / 1000),
    roleSent: false,
    finalized: false,
    content: "",
    reasoning: "",
    toolCalls: [],
    outputToolIndexes: new Map(),
    includeUsage,
    finishReason: "stop",
  };
}

function finalizeChunks(state: StreamState): unknown[] {
  state.finalized = true;
  state.finishReason = state.toolCalls.length ? "tool_calls" : "stop";
  const chunks = [chatChunk(state, { content: "" }, state.finishReason)];
  if (state.includeUsage && state.usage) chunks.push(usageChunk(state));
  return chunks;
}

function chatChunk(state: StreamState, delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
  return {
    id: state.id, object: "chat.completion.chunk", created: state.created, model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function usageChunk(state: StreamState): Record<string, unknown> {
  return { id: state.id, object: "chat.completion.chunk", created: state.created, model: state.model, choices: [], usage: state.usage };
}

function chatUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const promptTokens = numberValue(usage.input_tokens, 0);
  const completionTokens = numberValue(usage.output_tokens, 0);
  const inputDetails = objectValue(usage.input_tokens_details);
  const outputDetails = objectValue(usage.output_tokens_details);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(inputDetails ? { prompt_tokens_details: { cached_tokens: numberValue(inputDetails.cached_tokens, 0) } } : {}),
    ...(outputDetails ? { completion_tokens_details: { reasoning_tokens: numberValue(outputDetails.reasoning_tokens, 0) } } : {}),
  };
}

function terminalFinishReason(response: Record<string, unknown> | undefined, hasTools: boolean): StreamState["finishReason"] {
  if (response?.status === "incomplete") {
    const reason = objectValue(response.incomplete_details)?.reason;
    if (reason === "max_output_tokens") return "length";
    if (reason === "content_filter") return "content_filter";
  }
  return hasTools ? "tool_calls" : "stop";
}

async function loginWithBrowser(proxyUrl?: string, openUrl?: (url: string) => void): Promise<GrokCredentials> {
  const state = randomBytes(18).toString("hex");
  const nonce = randomBytes(18).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeUrl = new URL(OAUTH_AUTHORIZE_URL);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    plan: "generic",
    referrer: "sub2api",
  }).toString();

  const code = await waitForOAuthAuthorization(state, authorizeUrl.toString(), openUrl);
  const token = await requestOAuthToken(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OAUTH_CLIENT_ID,
    code,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: verifier,
  }), proxyUrl);
  return credentialsFromToken(token, {
    version: 1,
    accessToken: "",
    localApiKey: "",
    cacheKey: "",
  });
}

async function waitForOAuthAuthorization(state: string, authorizeUrl: string, openUrl?: (url: string) => void): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const input = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", OAUTH_REDIRECT_URI);
      if (url.pathname !== "/callback") {
        response.statusCode = 404; response.end("Not found"); return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      if (error || !code || returnedState !== state) {
        response.statusCode = 400;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("Grok 授权失败，可以关闭此页面并返回终端。\n");
        finish(undefined, new Error(error ? `xAI OAuth 拒绝授权：${error}` : "xAI OAuth 回调 state 或 code 无效"));
        return;
      }
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Grok 授权完成，可以关闭此页面并返回终端。\n");
      finish(code);
    });
    const finish = (code?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input?.close();
      if (server.listening) server.close();
      if (error) reject(error); else resolvePromise(code!);
    };
    server.once("error", error => finish(undefined, error));
    server.listen(56121, "127.0.0.1", () => {
      process.stdout.write(`请在浏览器完成 Grok 授权：\n${authorizeUrl}\n`);
      openUrl?.(authorizeUrl);
      if (input) {
        void input.question("若授权页显示代码，请粘贴到这里并按回车：").then(raw => {
          const authorization = parseAuthorizationInput(raw);
          if (!authorization.code) {
            finish(undefined, new Error("未输入有效的 xAI 授权码"));
            return;
          }
          if (authorization.requiresState && authorization.state !== state) {
            finish(undefined, new Error("xAI OAuth 手动回调 state 不匹配"));
            return;
          }
          finish(authorization.code);
        }).catch(error => finish(undefined, error instanceof Error ? error : new Error(String(error))));
      } else {
        process.stdout.write("当前终端不能读取输入，请等待浏览器自动回调。\n");
      }
    });
    timer = setTimeout(() => {
      finish(undefined, new Error("等待 xAI OAuth 授权超时"));
    }, 5 * 60_000);
  });
}

function parseAuthorizationInput(raw: string): { code: string; state: string; requiresState: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { code: "", state: "", requiresState: false };
  try {
    const parsed = new URL(trimmed);
    const code = parsed.searchParams.get("code")?.trim() ?? "";
    if (code) return { code, state: parsed.searchParams.get("state")?.trim() ?? "", requiresState: true };
  } catch { /* A bare authorization code is expected on the manual flow. */ }
  const query = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
  if (query.includes("=")) {
    const params = new URLSearchParams(query);
    const code = params.get("code")?.trim() ?? "";
    if (code) return { code, state: params.get("state")?.trim() ?? "", requiresState: true };
  }
  return { code: trimmed, state: "", requiresState: false };
}

async function refreshCredentialsIfNeeded(path: string, credentials: GrokCredentials, proxyUrl?: string): Promise<GrokCredentials> {
  const expiresAt = credentials.expiresAt ? Date.parse(credentials.expiresAt) : Number.POSITIVE_INFINITY;
  if (expiresAt - Date.now() > 60_000) return credentials;
  if (!credentials.refreshToken) throw new Error("Grok access token 已过期且没有 refresh token，请使用 --login 重新授权");
  return refreshCredentials(path, credentials, proxyUrl);
}

async function refreshCredentials(path: string, credentials: GrokCredentials, proxyUrl?: string): Promise<GrokCredentials> {
  if (!credentials.refreshToken) throw new Error("缺少 Grok refresh token");
  const token = await requestOAuthToken(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: credentials.refreshToken,
  }), proxyUrl);
  const next = credentialsFromToken(token, credentials);
  saveCredentials(path, next);
  return next;
}

async function requestOAuthToken(form: URLSearchParams, proxyUrl?: string): Promise<OAuthTokenResponse> {
  let response: Response;
  try {
    response = await modelFetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "writer-agent-grok-oauth/1.0" },
      body: form.toString(),
    }, proxyUrl);
  } catch (error) {
    throw new Error(`无法连接 xAI OAuth token 端点（${proxyUrl ? "已启用网络代理" : "直连"}）：${errorMessage(error)}`);
  }
  const text = await response.text();
  let payload: OAuthTokenResponse;
  try { payload = JSON.parse(text) as OAuthTokenResponse; }
  catch { throw new Error(`xAI OAuth 返回无法解析（${response.status}）`); }
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `xAI OAuth 请求失败（${response.status}）`);
  }
  return payload;
}

function credentialsFromToken(token: OAuthTokenResponse, previous: GrokCredentials): GrokCredentials {
  return {
    ...previous,
    version: 1,
    accessToken: token.access_token!,
    refreshToken: token.refresh_token || previous.refreshToken,
    expiresAt: Number.isFinite(token.expires_in) ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : previous.expiresAt,
  };
}

function loadCredentials(path: string): GrokCredentials | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GrokCredentials>;
    if (value.version !== 1 || typeof value.accessToken !== "string" || typeof value.localApiKey !== "string" || typeof value.cacheKey !== "string") {
      throw new Error("字段不完整");
    }
    return value as GrokCredentials;
  } catch (error) {
    throw new Error(`Grok 凭据文件无效：${errorMessage(error)}`);
  }
}

function saveCredentials(path: string, credentials: GrokCredentials): void {
  const temporary = `${path}.writer-tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* Windows does not implement POSIX modes. */ }
}

async function readJSONBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("请求体超过 16 MiB 限制");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("请求体不是有效 JSON"); }
}

function validateChatRequest(value: unknown): ChatRequest {
  if (!value || typeof value !== "object") throw new Error("请求体必须是 JSON 对象");
  const chat = value as ChatRequest;
  if (!Array.isArray(chat.messages) || !chat.messages.length) throw new Error("messages 必须是非空数组");
  if (chat.stream !== undefined && typeof chat.stream !== "boolean") throw new Error("stream 必须是布尔值");
  return chat;
}

function authorized(request: IncomingMessage, apiKey: string): boolean {
  const authorization = request.headers.authorization ?? "";
  return authorization.replace(/^Bearer\s+/i, "") === apiKey;
}

function writeJSON(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function writeError(response: ServerResponse, status: number, message: string): void {
  writeJSON(response, status, { error: { type: "proxy_error", message } });
}

function normalizeUpstream(value?: string): string {
  const raw = value?.trim() || DEFAULT_UPSTREAM;
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("Grok upstream 必须使用 HTTPS");
  return raw.replace(/\/+$/, "");
}

function resolveOutboundProxy(explicit?: string): string | undefined {
  return explicit?.trim()
    || process.env.HTTPS_PROXY?.trim()
    || process.env.https_proxy?.trim()
    || process.env.HTTP_PROXY?.trim()
    || process.env.http_proxy?.trim()
    || undefined;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空`);
  return value;
}

function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function numberValue(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause) return error.message;
  const detail = errorMessage(cause);
  return detail && detail !== error.message ? `${error.message}: ${detail}` : error.message;
}
