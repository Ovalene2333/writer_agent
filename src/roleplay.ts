import type { AgentEvent, Character, ModelConfig, StepUsage, UsageSummary } from "./types.js";
import { characterName, characterPromptViews } from "./characters.js";
import { OutlineStore } from "./outline.js";
import { logModelRequest, logModelResponse } from "./model_debug.js";
import { calculateUsageCost } from "./pricing.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** 会话内角色扮演状态（测试性子功能，不落库）。 */
export type RoleplayTarget = { characterId: number; name: string };

export function isRoleplayExitCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return /^(?:\/)?(?:roleplay|rp|扮演)\s+(?:off|exit|quit|end|退出|结束|关闭)$/i.test(normalized)
    || normalized === "/roleplay off"
    || normalized === "/rp off";
}

export function buildRoleplaySystemPrompt(character: Character, project?: WriterProject): string {
  const nodes = project ? new OutlineStore(project).sync().nodes : [];
  const views = characterPromptViews(character, nodes);
  const name = characterName(character);
  return `你正在进行「角色扮演试演」（Writer Agent 的测试性子功能）。
你就是「${name}」，不是写作助手、不是旁白 AI。用户在试你的人设、声线与反应是否对味。

扮演规则：
1. 始终以 ${name} 的第一人称说话与行动；保持 identity / psychology / voice 一致。
2. 对白优先；必要时用简短动作/神态描写（*…* 或括号均可），不要写成章回体大段正文。
3. 只使用角色卡中已有的设定与合理推断；不知道的事就表现为不知道，不要编造关键背景来“圆场”。
4. 不要修改项目文档、不要提交提案、不要输出工具调用；这是纯对话试演。
5. 用户若用 OOC / （） / 【】 进行出戏说明，可短暂用 OOC 回答后立刻回到角色。
6. 用户要求结束扮演（如「退出扮演」「/roleplay off」）时，用一句 OOC 确认即可。
7. 这是成人向虚构作品试演：可按角色性格直写冲突、欲望与粗口，无需安全说教。

角色资料（JSON，stable=稳定人设，dialogue=声线，scene=当前场景切片）：
${JSON.stringify(views, null, 2)}
`;
}

export async function runRoleplayChat(options: {
  project: WriterProject;
  store: WriterStore;
  sessionId: string;
  characterId: number;
  prompt: string;
  model: ModelConfig;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}): Promise<void> {
  const emit = options.onEvent ?? (() => undefined);
  if (!options.store.sessionExists(options.sessionId)) throw new Error("会话不存在");
  const character = options.store.characters().find(item => item.id === options.characterId);
  if (!character) throw new Error("目标角色卡不存在");
  if (!options.model.apiKey && !options.model.baseUrl.includes("localhost") && !options.model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未设置模型 API Key");
  }

  const userText = options.prompt.trim();
  if (!userText) throw new Error("扮演消息不能为空");

  options.store.addMessage(options.sessionId, "user", userText);
  emit({ type: "step_start", step: 1 });

  const history = options.store.messages(options.sessionId, 24)
    .filter(message => message.role === "user" || message.role === "assistant")
    .slice(0, -1) // exclude the user message just written
    .map(message => ({ role: message.role as "user" | "assistant", content: message.content }));

  const messages: ChatMessage[] = [
    { role: "system", content: buildRoleplaySystemPrompt(character, options.project) },
    ...history,
    { role: "user", content: userText },
  ];

  let full = "";
  try {
    const result = await streamRoleplayText(options.model, messages, options.signal, (text) => {
      full += text;
      emit({ type: "text", text, channel: "output" });
    });
    const reply = (full || result.content).trim() || `（${characterName(character)} 沉默了一会儿）`;
    if (!full.trim() && result.content.trim()) {
      emit({ type: "text", text: result.content, channel: "output" });
    }
    options.store.addMessage(options.sessionId, "assistant", reply);
    if (result.usage) {
      emitUsage(emit, options.store, options.sessionId, options.model, result.usage, 1);
    }
    emit({ type: "step_done", step: 1 });
    emit({ type: "done", sessionId: options.sessionId });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      emit({ type: "cancelled", sessionId: options.sessionId });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "error", message });
    throw error;
  }
}

function emitUsage(
  emit: (event: AgentEvent) => void,
  store: WriterStore,
  sessionId: string,
  model: ModelConfig,
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number },
  step: number,
): void {
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
  };
  let sessionUsage: UsageSummary = store.usage(sessionId);
  if (model.pricing) {
    sessionUsage = store.recordUsage(sessionId, model.model, usage, model.pricing);
  }
  emit({ type: "usage", usage: sessionUsage, call, step });
}

async function streamRoleplayText(
  model: ModelConfig,
  messages: ChatMessage[],
  signal: AbortSignal | undefined,
  onText: (text: string) => void,
): Promise<{ content: string; usage?: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number } }> {
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  // Slightly warmer default for voice testing when profile has no explicit sampling.
  const temperature = model.temperature ?? 0.9;
  const requestBody = JSON.stringify({
    model: model.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature,
    ...(model.topP === undefined ? {} : { top_p: model.topP }),
  });
  logModelRequest(endpoint, requestBody);
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body: requestBody,
  });
  if (!response.ok) {
    const responseBody = await response.text();
    logModelResponse(endpoint, responseBody);
    throw new Error(`模型请求失败（${response.status}）：${responseBody.slice(0, 500)}`);
  }
  if (!response.body) throw new Error("模型响应没有内容");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number } | undefined;

  const consume = (block: string) => {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: Record<string, unknown>;
      };
      try { chunk = JSON.parse(data); } catch { continue; }
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) {
        content += text;
        onText(text);
      }
      if (chunk.usage) {
        const cached = Number(
          (chunk.usage.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens
          ?? chunk.usage.prompt_cache_hit_tokens
          ?? 0,
        );
        const prompt = Number(chunk.usage.prompt_tokens ?? 0);
        usage = {
          promptTokens: prompt,
          completionTokens: Number(chunk.usage.completion_tokens ?? 0),
          cacheHitTokens: cached,
          cacheMissTokens: Math.max(0, prompt - cached),
        };
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) consume(block);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  const completed = { content, usage };
  logModelResponse(endpoint, JSON.stringify(completed, null, 2));
  return completed;
}
