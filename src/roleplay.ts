import type { AgentEvent, Character, ModelConfig, RoleplayInterlocutor, RoleplayParticipant, StepUsage, UsageSummary } from "./types.js";
import { characterName, characterPromptViews } from "./characters.js";
import { OutlineStore } from "./outline.js";
import { logModelRequest, logModelResponse } from "./model_debug.js";
import { calculateUsageCost } from "./pricing.js";
import { documentKind, WriterProject } from "./project.js";
import { WriterStore } from "./store.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type SetupMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

/** 会话内角色扮演状态（测试性子功能，不落库）。 */
export type RoleplayTarget = { characterId: number; name: string };

export function isRoleplayExitCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return /^(?:\/)?(?:roleplay|rp|扮演)\s+(?:off|exit|quit|end|退出|结束|关闭)$/i.test(normalized)
    || normalized === "/roleplay off"
    || normalized === "/rp off";
}

export function buildRoleplaySystemPrompt(character: Character | RoleplayInterlocutor, project?: WriterProject, interlocutor?: RoleplayInterlocutor | Character): string {
  const nodes = project ? new OutlineStore(project).sync().nodes : [];
  const full = "schemaVersion" in character;
  const views = full ? characterPromptViews(character, nodes) : { simple: character };
  const name = full ? characterName(character) : character.name;
  const interlocutorData = interlocutor && "schemaVersion" in interlocutor
    ? characterPromptViews(interlocutor, nodes)
    : interlocutorView(interlocutor ?? defaultInterlocutor());
  return `你正在进行「角色扮演试演」（Writer Agent 的测试性子功能）。
你就是「${name}」，不是写作助手、不是旁白 AI。用户在试你的人设、声线与反应是否对味。

扮演规则：
1. 始终以 ${name} 的第一人称说话与行动；保持 identity / psychology / voice 一致。
2. 这是实时对手戏，不是问答。每次先让角色对用户刚才的话产生具体反应，再说话或行动；反应可以是停顿、目光、呼吸、姿势、触碰物件、拉近/避开距离等，但只选当下最有表现力的一两处。
3. 只使用角色卡中已有的设定与合理推断；不知道的事就表现为不知道，不要编造关键背景来“圆场”。
4. 不要修改项目文档、不要提交提案、不要输出工具调用；这是纯对话试演。
5. 用户若用 OOC / （） / 【】 进行出戏说明，可短暂用 OOC 回答后立刻回到角色。
6. 用户要求结束扮演（如「退出扮演」「/roleplay off」）时，用一句 OOC 确认即可。
7. 这是成人向虚构作品试演：可按角色性格直写冲突、欲望与粗口，无需安全说教。
8. 上下文仅包含本角色扮演通道的历史对白与角色卡；看不到写作 Agent 的任务讨论，也不要假装记得那些内容。
9. 用户在本次试演中固定扮演下述“对话者”；按设定理解用户的身份、双方关系、已知信息和当前处境。不要替用户决定动作、台词或内心。

演出要求：
- 保持主动性：角色有自己的欲望、顾虑和当下目标。合乎人设时可转移话题、追问、试探、回避、撒谎、打断或采取一个小行动，不要永远等用户推动。
- 写出潜台词：不要直接宣布“我很紧张/生气/害羞”，优先让措辞、迟疑、动作和注意力落点泄露情绪。说出口的话可以与真实意图不完全一致。
- 保持现场连续：记住双方距离、姿势、已经出现的物件与刚发生的动作；环境只在能影响互动时落一笔，不凭空切换场景。
- 对白要像人在说话：句长和节奏随情绪变化，可有半句话、改口、沉默和打断；沿用 voice 中的措辞习惯，但不要机械复读口头禅或示例台词。
- 默认写 1–4 个短段，篇幅随情绪与事件变化。不要为了“简短”砍掉关键反应，也不要扩写成旁白主导的小说章节。
- 不要复述用户刚说的话，不要总结角色卡，不要使用客服式确认，不要每轮都用问题收尾。用户输入很短时，也应直接给出符合场景的鲜明反应，而不是出戏索要更多说明。
- 动作、对白、感官细节不必每轮全部出现；宁可抓住一个准确细节，也不要堆砌表情、形容词或舞台指示。

对话者设定（JSON）：
${JSON.stringify(interlocutorData, null, 2)}

角色资料（JSON，stable=稳定人设，dialogue=声线，scene=当前场景切片）：
${JSON.stringify(views, null, 2)}
`;
}

export async function runRoleplayChat(options: {
  project: WriterProject;
  store: WriterStore;
  sessionId: string;
  performer?: RoleplayParticipant;
  characterId?: number;
  identity?: RoleplayParticipant;
  interlocutor?: RoleplayInterlocutor;
  prompt: string;
  model: ModelConfig;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}): Promise<void> {
  const emit = options.onEvent ?? (() => undefined);
  if (!options.store.sessionExists(options.sessionId)) throw new Error("会话不存在");
  const participant = options.performer ?? (Number.isInteger(options.characterId) ? participantFromNormal(options.store, options.characterId!) : undefined);
  if (!participant) throw new Error("扮演者角色卡不存在");
  const character = participant.kind === "normal" && participant.id
    ? options.store.characters().find(item => item.id === participant.id)
    : participant.card;
  if (!character) throw new Error("扮演者角色卡不存在");
  if (!options.model.apiKey && !options.model.baseUrl.includes("localhost") && !options.model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未设置模型 API Key");
  }

  const userText = options.prompt.trim();
  if (!userText) throw new Error("扮演消息不能为空");

  options.store.addMessage(options.sessionId, "user", userText, "roleplay");
  emit({ type: "step_start", step: 1 });

  // Roleplay history is independent of the writing Agent prompt assembly
  // (agent.ts PROMPT / PREFIX-CACHE CONTRACT does not apply here).
  // Only this channel; full message bodies; last 24 turns (not the agent history preview).
  // Long archives for writing must use inspect_conversation / read_conversation on the agent path.
  const history = options.store.messages(options.sessionId, 24, { channel: "roleplay" })
    .filter(message => message.role === "user" || message.role === "assistant")
    .slice(0, -1) // exclude the user message just written
    .map(message => ({ role: message.role as "user" | "assistant", content: message.content }));

  const identity = options.identity?.kind === "normal" && options.identity.id
    ? options.store.characters().find(item => item.id === options.identity!.id)
    : options.identity?.card ?? options.interlocutor;
  const messages: ChatMessage[] = [
    { role: "system", content: buildRoleplaySystemPrompt(character, options.project, identity) },
    ...history,
    { role: "user", content: userText },
  ];

  let full = "";
  try {
    const result = await streamRoleplayText(options.model, messages, options.signal, (text) => {
      full += text;
      emit({ type: "text", text, channel: "output" });
    });
    const reply = (full || result.content).trim() || `（${participant.name} 沉默了一会儿）`;
    if (!full.trim() && result.content.trim()) {
      emit({ type: "text", text: result.content, channel: "output" });
    }
    options.store.addMessage(options.sessionId, "assistant", reply, "roleplay");
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

export function defaultInterlocutor(): RoleplayInterlocutor {
  return {
    name: "未透露姓名的来访者",
    identity: "身份未知，由用户自行通过对话表现",
    relationship: "与角色的关系尚未明确",
    knowledge: "只知道对话中由角色直接告知的信息",
    scene: "在不预设具体地点与时间的情况下开始对话",
    goal: "与角色交谈并测试其反应",
  };
}

function interlocutorView(value: RoleplayInterlocutor): RoleplayInterlocutor {
  return {
    name: value.name,
    identity: value.identity,
    relationship: value.relationship,
    knowledge: value.knowledge,
    scene: value.scene,
    goal: value.goal,
  };
}

/** 根据自然语言要求建立试演对话者；模型可按需查询角色卡与世界观，但不会写入项目。 */
export async function generateRoleplayInterlocutor(options: {
  project: WriterProject;
  store: WriterStore;
  performer?: RoleplayParticipant;
  characterId?: number;
  request: string;
  model: ModelConfig;
  signal?: AbortSignal;
}): Promise<RoleplayInterlocutor> {
  const performer = options.performer ?? (Number.isInteger(options.characterId) ? participantFromNormal(options.store, options.characterId!) : undefined);
  if (!performer) throw new Error("扮演者角色卡不存在");
  const target = performer.kind === "normal" && performer.id
    ? options.store.characters().find(item => item.id === performer.id)
    : performer.card;
  if (!target) throw new Error("扮演者角色卡不存在");
  const request = options.request.trim();
  if (!request) return defaultInterlocutor();
  if (!options.model.apiKey && !options.model.baseUrl.includes("localhost") && !options.model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未设置模型 API Key");
  }

  const characters = options.store.characters();
  const lorePaths = options.project.listDocuments()
    .filter(path => documentKind(path) === "lore" && !options.project.isDocumentHidden(path))
    .slice(0, 60);
  const loreSet = new Set(lorePaths);
  const messages: SetupMessage[] = [
    { role: "system", content: `你负责为小说角色扮演试演建立“用户所扮演的对话者”身份。根据用户要求形成一份可直接用于对话的设定。你可以查询项目角色卡和 lore/ 世界观；涉及专名、组织、能力、地点或既有角色时必须先查询，不得凭空补关键设定。只读，不修改任何资料。不要替用户规定具体台词、动作或内心。

最终只输出 JSON 对象，且恰好包含这些字符串字段：name、identity、relationship、knowledge、scene、goal。内容应具体、简洁；资料没有定义的细节明确保留为空白或写“未明确”。` },
    { role: "user", content: `被试演角色：
${JSON.stringify("schemaVersion" in target ? characterPromptViews(target, new OutlineStore(options.project).sync().nodes) : { simple: target }, null, 2)}

对话者设定要求：${request}` },
  ];
  const tools = [
    { type: "function", function: { name: "list_characters", description: "列出项目角色卡目录，用于识别要求中提到的既有角色。", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    { type: "function", function: { name: "get_character", description: "读取一张相关角色卡。", parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"], additionalProperties: false } } },
    { type: "function", function: { name: "search_worldview", description: "在 lore/ 世界观文档中检索专名、组织、地点、规则或背景事实。", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
    { type: "function", function: { name: "read_lore", description: "读取一份相关的 lore/ 世界观文档。", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  ];
  const endpoint = `${options.model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  for (let turn = 0; turn < 6; turn += 1) {
    const requestBody = JSON.stringify({
      model: options.model.model, messages, tools, tool_choice: "auto", stream: false,
      temperature: options.model.temperature ?? 0.4,
      ...(options.model.topP === undefined ? {} : { top_p: options.model.topP }),
    });
    logModelRequest(endpoint, requestBody);
    const response = await fetch(endpoint, {
      method: "POST", signal: options.signal,
      headers: { "content-type": "application/json", ...(options.model.apiKey ? { authorization: `Bearer ${options.model.apiKey}` } : {}) },
      body: requestBody,
    });
    const responseBody = await response.text();
    logModelResponse(endpoint, responseBody);
    if (!response.ok) throw new Error(`对话者设定失败（${response.status}）：${responseBody.slice(0, 500)}`);
    const payload = JSON.parse(responseBody) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }> };
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("模型没有返回对话者设定");
    const calls = message.tool_calls ?? [];
    if (!calls.length) return parseInterlocutor(message.content ?? "");
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let result: unknown;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        if (call.function.name === "list_characters") {
          result = characters.map(item => ({ id: item.id, name: item.identity.name, aliases: item.identity.aliases, summary: item.identity.summary }));
        } else if (call.function.name === "get_character") {
          const id = Number(args.id);
          const character = characters.find(item => item.id === id);
          if (!character) throw new Error("角色不存在");
          result = character;
        } else if (call.function.name === "search_worldview") {
          const query = typeof args.query === "string" ? args.query.trim() : "";
          if (!query) throw new Error("检索词不能为空");
          result = options.store.search(query, 8, { scope: "lore", mode: "any", contextLines: 3 })
            .filter(item => !options.project.isDocumentHidden(item.path));
        } else if (call.function.name === "read_lore") {
          const path = typeof args.path === "string" ? args.path : "";
          if (!loreSet.has(path)) throw new Error("只能读取可见的 lore/ 世界观文档");
          const content = options.project.read(path);
          result = { path, content: content.slice(0, 12_000), truncated: content.length > 12_000 };
        } else throw new Error("未知工具");
      } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error("对话者设定查询次数过多，请缩短要求后重试");
}

function parseInterlocutor(text: string): RoleplayInterlocutor {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回有效的对话者设定 JSON");
  let value: Record<string, unknown>;
  try { value = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>; }
  catch { throw new Error("模型返回的对话者设定无法解析"); }
  const fallback = defaultInterlocutor();
  const field = (key: keyof RoleplayInterlocutor) => typeof value[key] === "string" && value[key].trim() ? value[key].trim() : fallback[key];
  return { name: field("name"), identity: field("identity"), relationship: field("relationship"), knowledge: field("knowledge"), scene: field("scene"), goal: field("goal") };
}

export function participantFromNormal(store: WriterStore, id: number): RoleplayParticipant | undefined {
  const character = store.characters().find(item => item.id === id);
  if (!character) return undefined;
  return {
    kind: "normal",
    id: character.id,
    name: character.identity.name,
    card: {
      name: character.identity.name,
      identity: character.identity.summary || character.identity.narrativeRole,
      relationship: "",
      knowledge: "",
      scene: "",
      goal: character.motivations.find(item => item.status === "active")?.summary ?? "",
    },
  };
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

/** Roleplay stays warmer than task-oriented agent calls, while avoiding incoherent extremes. */
export function roleplaySampling(model: Pick<ModelConfig, "temperature" | "topP">): { temperature: number; topP: number } {
  return {
    temperature: Math.min(1.3, Math.max(0.85, model.temperature ?? 0.95)),
    topP: Math.min(1, Math.max(0.9, model.topP ?? 0.95)),
  };
}

async function streamRoleplayText(
  model: ModelConfig,
  messages: ChatMessage[],
  signal: AbortSignal | undefined,
  onText: (text: string) => void,
): Promise<{ content: string; usage?: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number } }> {
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const sampling = roleplaySampling(model);
  const requestBody = JSON.stringify({
    model: model.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: sampling.temperature,
    top_p: sampling.topP,
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
