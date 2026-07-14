import type {
  AgentEvent,
  Character,
  ModelConfig,
  RoleplayInterlocutor,
  RoleplayParticipant,
  RoleplaySessionMemory,
  RoleplayWorkingState,
  StepUsage,
  UsageSummary,
} from "./types.js";
import { characterName, characterPromptCard, characterPromptViews } from "./characters.js";
import { OutlineStore } from "./outline.js";
import { logModelRequest, logModelResponse } from "./model_debug.js";
import { calculateUsageCost } from "./pricing.js";
import { documentKind, WriterProject } from "./project.js";
import { emptyRoleplayWorkingState, WriterStore } from "./store.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type SetupMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

/** Recent full user/assistant messages kept in the roleplay prompt (not turns). ~8 dialogue turns. */
export const ROLEPLAY_RECENT_MESSAGES = 16;
/** When older-than-window unsummarized messages reach this count, fold them into the rolling summary. */
export const ROLEPLAY_SUMMARY_BATCH = 8;
/** Refresh working-state via model every N assistant replies when no batch summary is needed. */
export const ROLEPLAY_STATE_REFRESH_EVERY = 4;

/**
 * Roleplay prompt / prefix-cache contract (separate from agent.ts):
 * 1) Fixed system slots first: rules+cards | summary | memory card | anti-formula
 * 2) Never omit a slot — use stable placeholder text so indices do not shift
 * 3) Stable slot 0 must stay byte-stable within a session (no live scene / turn counters)
 * 4) Recent history is short; older facts live in summary + memory, not full transcripts
 * 5) Anti-formula is dynamic-tail only and must stay short
 */

/** 会话内角色扮演状态（测试性子功能，不落库）。 */
export type RoleplayTarget = { characterId: number; name: string };

export function isRoleplayExitCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return /^(?:\/)?(?:roleplay|rp|扮演)\s+(?:off|exit|quit|end|退出|结束|关闭)$/i.test(normalized)
    || normalized === "/roleplay off"
    || normalized === "/rp off";
}

export function roleplayPerformerKey(participant: RoleplayParticipant): string {
  if (participant.kind === "normal" && participant.id) return `normal:${participant.id}`;
  if (participant.kind === "simple" && participant.id) return `simple:${participant.id}`;
  return `generated:${participant.name}`;
}

/** Slim stable character payload: voice boundaries, not example-line machines. */
export function slimRoleplayCharacterViews(
  character: Character | RoleplayInterlocutor,
  project?: WriterProject,
): unknown {
  if (!("schemaVersion" in character)) {
    return {
      simple: {
        name: character.name,
        identity: character.identity,
        relationship: character.relationship,
        knowledge: character.knowledge,
        scene: character.scene,
        goal: character.goal,
      },
    };
  }
  const nodes = project ? new OutlineStore(project).sync().nodes : [];
  const views = characterPromptViews(character, nodes);
  return {
    stable: {
      id: views.stable.id,
      identity: views.stable.identity,
      profile: {
        appearanceSummary: views.stable.profile.appearanceSummary,
        distinguishingFeatures: views.stable.profile.distinguishingFeatures.slice(0, 6),
        backgroundSummary: views.stable.profile.backgroundSummary.slice(0, 400),
      },
      psychology: {
        summary: views.stable.psychology.summary,
        traits: views.stable.psychology.traits.slice(0, 6),
        values: views.stable.psychology.values.slice(0, 4),
        fears: views.stable.psychology.fears.slice(0, 4),
        conflicts: views.stable.psychology.conflicts.slice(0, 4),
      },
      competencies: views.stable.competencies,
      notes: views.stable.notes.slice(0, 300),
    },
    dialogue: {
      name: views.dialogue.name,
      voice: {
        summary: views.dialogue.voice.summary,
        register: views.dialogue.voice.register,
        diction: views.dialogue.voice.diction.slice(0, 8),
        verbalHabits: views.dialogue.voice.verbalHabits.slice(0, 4),
        avoidedExpressions: views.dialogue.voice.avoidedExpressions.slice(0, 6),
        // Examples are boundaries, not per-turn templates — keep at most one.
        exampleHint: views.dialogue.voice.examples[0]?.slice(0, 80) ?? "",
      },
    },
  };
}

function interlocutorBaseline(value: RoleplayInterlocutor | Character | undefined): unknown {
  if (!value) return interlocutorView(defaultInterlocutor());
  if ("schemaVersion" in value) {
    return {
      name: value.identity.name,
      identity: value.identity.summary || value.identity.narrativeRole,
      relationship: "",
      knowledge: "",
      scene: "",
      goal: value.motivations.find(item => item.status === "active")?.summary ?? "",
    };
  }
  return interlocutorView(value);
}

/** Stable system slot 0: rules + slim cards. CACHE: keep session-stable. */
export function buildRoleplayStablePrefix(
  character: Character | RoleplayInterlocutor,
  project?: WriterProject,
  interlocutor?: RoleplayInterlocutor | Character,
): string {
  const name = "schemaVersion" in character ? characterName(character) : character.name;
  const views = slimRoleplayCharacterViews(character, project);
  const interlocutorData = interlocutorBaseline(interlocutor);
  return `你正在进行「角色扮演试演」（Writer Agent 的测试性子功能）。
你就是「${name}」，不是写作助手、不是旁白 AI。用户在试你的人设、声线与反应是否对味。

扮演规则：
1. 始终以 ${name} 的第一人称说话与行动；保持 identity / psychology / voice 一致。
2. 这是实时对手戏，不是问答。对用户刚说的话先有具体反应，再开口或行动；不要每轮把「反应清单」勾完。
3. 只使用角色卡中已有的设定与合理推断；不知道的事就表现为不知道，不要编造关键背景来“圆场”。能力标记 unlocked=false 时只知道其名称与摘要，不得推断隐藏详情，也不得在行动中使用。
4. 不要修改项目文档、不要提交提案、不要输出工具调用；这是纯对话试演。
5. 用户若用 OOC / （） / 【】 进行出戏说明，可短暂用 OOC 回答后立刻回到角色。
6. 用户要求结束扮演（如「退出扮演」「/roleplay off」）时，用一句 OOC 确认即可。
7. 这是成人向虚构作品试演：可按角色性格直写冲突、欲望与粗口，无需安全说教。
8. 上下文含：稳定人设、滚动事实摘要、现场记忆卡、近期对白；看不到写作 Agent 任务讨论，也不要假装记得那些内容。更早的对白细节以摘要与记忆卡为准，不要编造未出现的情节。
9. 用户在本次试演中固定扮演下述“对话者”；按设定理解用户的身份、双方关系、已知信息和当前处境。不要替用户决定动作、台词或内心。

演出要求（偏禁止连用，避免公式化）：
- 保持主动性：角色有欲望、顾虑与当下目标；可转移话题、追问、试探、回避、撒谎、打断或只做一个小行动，不要永远等用户推动。
- 写出潜台词：不要直接宣布情绪标签；说出口的话可以与真实意图不完全一致。
- 现场状态以「现场记忆卡」为准；摘要只提供更早事实。环境只在影响互动时落笔，不凭空换场景。
- 对白要像人：句长随情绪变，可有半句、改口、沉默、打断。voice 是用词边界，不是每句要贴的标签；不要机械复读 verbalHabits 或 exampleHint。
- 篇幅默认可以很短（一句话或一个动作即可）。只有冲击大时才写 2–4 短段。禁止扩成旁白主导的小说章。
- 不要复述用户刚说的话，不要总结角色卡，不要客服式确认，不要每轮用问题收尾。
- 禁止把「动作→对白→再动作→反问」当成每轮固定配方。连续两轮已有微动作/眼神/呼吸描写时，本轮优先纯对白或沉默，除非冲突明显升级。
- 动作、对白、感官不必每轮齐全；宁可一个准细节，也不要堆砌舞台指示。

对话者设定（JSON，基线；现场变化见记忆卡）：
${JSON.stringify(interlocutorData, null, 2)}

角色资料（JSON，stable=人设，dialogue=声线边界）：
${JSON.stringify(views, null, 2)}
`;
}

/** @deprecated Prefer buildRoleplayStablePrefix + fixed slots; kept for callers/tests. */
export function buildRoleplaySystemPrompt(
  character: Character | RoleplayInterlocutor,
  project?: WriterProject,
  interlocutor?: RoleplayInterlocutor | Character,
): string {
  return buildRoleplayStablePrefix(character, project, interlocutor);
}

export function formatRoleplaySummarySlot(summary: string): string {
  const text = summary.trim();
  return text
    ? `滚动事实摘要（更早对白已压缩；只含事件/关系/承诺/已暴露信息，不含句式模板）：\n${text}`
    : "滚动事实摘要：无。";
}

export function formatRoleplayMemorySlot(state: RoleplayWorkingState, sameBeatTurns = 0): string {
  const empty = !state.scene && !state.proximity && !state.mood && !state.beat
    && !state.relationshipDelta && !state.timeInScene
    && !state.openThreads.length && !state.promises.length && !state.revealed.length;
  if (empty) return "现场记忆卡：无。开场后根据互动自行建立现场，并在后续轮次与记忆卡保持连续。";
  const beatHint = sameBeatTurns >= 3
    ? `\n节拍提示：已连续 ${sameBeatTurns} 轮停留在「${state.beat || "同一节拍"}」。本轮须在人设内推进或打破（摊牌、撒谎、拒绝、离场、换话题、沉默拒答等），禁止温吞重复。`
    : "";
  return `现场记忆卡（舞台连续性以本卡为准）：
${JSON.stringify(state, null, 2)}${beatHint}`;
}

const GESTURE_RE = /目光|眼神|视线|呼吸|嘴角|唇|手指|指尖|攥|握拳|沉默|顿了|停顿|抬眼|低头|偏头|咬唇|吞咽|喉结|肩膀|后退|靠近|皱眉|眯眼|笑了笑|轻笑/g;

/** Extract short anti-template hints from the model's own recent replies. */
export function extractAntiFormulaHints(recentAssistantReplies: string[]): {
  openings: string[];
  gestures: string[];
  usedQuestionEnd: boolean;
  usedActionThenSpeech: boolean;
} {
  const openings: string[] = [];
  const gestureCounts = new Map<string, number>();
  let usedQuestionEnd = false;
  let usedActionThenSpeech = false;

  for (const raw of recentAssistantReplies.slice(-2)) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const opening = text.slice(0, 24).trim();
    if (opening) openings.push(opening);
    if (/[？?]\s*$/.test(text) || /[？?][^。！!]{0,12}$/.test(text)) usedQuestionEnd = true;
    if (/^[（(【\[]/.test(text) || /[）)】\]]\s*[「"‘']?/.test(text.slice(0, 40))) usedActionThenSpeech = true;
    const matches = text.match(GESTURE_RE) ?? [];
    for (const match of matches) gestureCounts.set(match, (gestureCounts.get(match) ?? 0) + 1);
  }

  const gestures = [...gestureCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([word]) => word);

  return { openings, gestures, usedQuestionEnd, usedActionThenSpeech };
}

export function formatRoleplayAntiFormulaSlot(recentAssistantReplies: string[]): string {
  if (!recentAssistantReplies.length) {
    return "本轮反公式：开场可自由；避免客服腔与每轮完整小舞台段。";
  }
  const hints = extractAntiFormulaHints(recentAssistantReplies);
  const lines = [
    "本轮反公式（打断自我模仿；只约束结构，不改人设）：",
    "- 禁止重复你最近回复的开场结构与骨架；本轮只选一种主表达：对白主导 / 动作主导 / 沉默主导 / 转移话题。",
  ];
  if (hints.openings.length) {
    lines.push(`- 禁用开场（勿再以相同开头起笔）：${hints.openings.map(item => `「${item}」`).join("、")}`);
  }
  if (hints.gestures.length) {
    lines.push(`- 近期已用微动作/感官词，本轮尽量避开：${hints.gestures.join("、")}`);
  }
  if (hints.usedActionThenSpeech) {
    lines.push("- 最近用过「动作/括号→对白」骨架，本轮改用其他形态。");
  }
  if (hints.usedQuestionEnd) {
    lines.push("- 最近以问句收尾过，本轮不要再用问题收束。");
  }
  lines.push("- 若无新信息，宁可短促，不要写完整的“一小节表演”。");
  return lines.join("\n");
}

/**
 * Fixed-count roleplay message assembly.
 * Slot map: 0 stable | 1 summary | 2 memory | 3 anti-formula | recent history | current user
 */
export function buildRoleplayChatMessages(parts: {
  stablePrefix: string;
  summary: string;
  state: RoleplayWorkingState;
  sameBeatTurns?: number;
  recentAssistantReplies: string[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userText: string;
}): ChatMessage[] {
  return [
    { role: "system", content: parts.stablePrefix },
    { role: "system", content: formatRoleplaySummarySlot(parts.summary) },
    { role: "system", content: formatRoleplayMemorySlot(parts.state, parts.sameBeatTurns ?? 0) },
    { role: "system", content: formatRoleplayAntiFormulaSlot(parts.recentAssistantReplies) },
    ...parts.history,
    { role: "user", content: parts.userText },
  ];
}

export function emptyRoleplaySessionMemory(performerKey: string): RoleplaySessionMemory {
  return {
    performerKey,
    summary: "",
    summarizedThroughId: 0,
    state: emptyRoleplayWorkingState(),
    turnCount: 0,
    sameBeatTurns: 0,
    updatedAt: new Date().toISOString(),
  };
}

function seedStateFromInterlocutor(interlocutor?: RoleplayInterlocutor | Character): RoleplayWorkingState {
  const state = emptyRoleplayWorkingState();
  if (!interlocutor) return state;
  if ("schemaVersion" in interlocutor) {
    state.scene = "";
    return state;
  }
  state.scene = interlocutor.scene.slice(0, 400);
  state.relationshipDelta = interlocutor.relationship.slice(0, 400);
  if (interlocutor.goal) state.openThreads = [interlocutor.goal.slice(0, 200)];
  state.beat = "开场";
  return state;
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
  /** Optional cheaper model for rolling summary / working-state refresh. */
  summarizer?: ModelConfig;
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

  const identitySource = options.identity?.kind === "normal" && options.identity.id
    ? options.store.characters().find(item => item.id === options.identity!.id)
    : options.identity?.card ?? options.interlocutor;

  const performerKey = roleplayPerformerKey(participant);
  let memory: RoleplaySessionMemory = options.store.roleplayMemory(options.sessionId)
    ?? emptyRoleplaySessionMemory(performerKey);
  if (memory.performerKey !== performerKey) {
    memory = emptyRoleplaySessionMemory(performerKey);
    memory.state = seedStateFromInterlocutor(identitySource ?? options.interlocutor);
    options.store.saveRoleplayMemory(options.sessionId, memory);
  } else if (memory.turnCount === 0 && !memory.summary && !memory.state.scene) {
    memory = {
      ...memory,
      state: seedStateFromInterlocutor(identitySource ?? options.interlocutor),
    };
    options.store.saveRoleplayMemory(options.sessionId, memory);
  }

  // Full archive stays in DB; prompt only loads a short recent window + memory.
  const channelAll = options.store.messages(options.sessionId, 500, { channel: "roleplay" })
    .filter(message => message.role === "user" || message.role === "assistant");
  // Exclude the user message just written from "history" pairs shown before current user.
  const prior = channelAll.slice(0, -1);
  const recent = prior.slice(-ROLEPLAY_RECENT_MESSAGES);
  const history = recent.map(message => ({
    role: message.role as "user" | "assistant",
    content: message.content,
  }));
  const recentAssistantReplies = recent
    .filter(message => message.role === "assistant")
    .map(message => message.content);

  // Fold older turns into rolling summary before the main completion when needed.
  const firstRecentId = recent[0]?.id ?? channelAll[channelAll.length - 1]?.id ?? 0;
  const needsSummary = prior.some(message => message.id < firstRecentId && message.id > memory.summarizedThroughId);
  const dueStateRefresh = memory.turnCount > 0 && memory.turnCount % ROLEPLAY_STATE_REFRESH_EVERY === 0;
  if (needsSummary || dueStateRefresh) {
    try {
      memory = await refreshRoleplayMemory({
        store: options.store,
        sessionId: options.sessionId,
        memory,
        prior,
        firstRecentId,
        model: options.summarizer ?? options.model,
        signal: options.signal,
        forceStateOnly: !needsSummary && dueStateRefresh,
      });
    } catch {
      // Memory refresh is best-effort; roleplay reply still proceeds.
      if (needsSummary) {
        memory = foldExtractiveSummary(memory, prior, firstRecentId);
        options.store.saveRoleplayMemory(options.sessionId, memory);
      }
    }
  }

  const messages = buildRoleplayChatMessages({
    stablePrefix: buildRoleplayStablePrefix(character, options.project, identitySource),
    summary: memory.summary,
    state: memory.state,
    sameBeatTurns: memory.sameBeatTurns,
    recentAssistantReplies,
    history,
    userText,
  });

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

    // Lightweight post-turn bookkeeping (no extra model call).
    memory = {
      ...memory,
      turnCount: memory.turnCount + 1,
      sameBeatTurns: memory.state.beat ? memory.sameBeatTurns + 1 : 0,
      updatedAt: new Date().toISOString(),
    };
    options.store.saveRoleplayMemory(options.sessionId, memory);

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
          result = characterPromptCard(character);
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
    // Mild de-echo for long chats; structure still relies on anti-formula slots.
    frequency_penalty: 0.3,
    presence_penalty: 0.15,
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

type RoleplayHistoryMessage = { id: number; role: string; content: string };

async function refreshRoleplayMemory(options: {
  store: WriterStore;
  sessionId: string;
  memory: RoleplaySessionMemory;
  prior: RoleplayHistoryMessage[];
  firstRecentId: number;
  model: ModelConfig;
  signal?: AbortSignal;
  forceStateOnly?: boolean;
}): Promise<RoleplaySessionMemory> {
  const { memory, prior, firstRecentId, model } = options;
  const older = prior.filter(message => message.id < firstRecentId && message.id > memory.summarizedThroughId);
  const batch = older.slice(0, Math.max(ROLEPLAY_SUMMARY_BATCH, older.length));
  const recentForState = prior.slice(-ROLEPLAY_RECENT_MESSAGES);
  const transcript = (options.forceStateOnly ? recentForState : batch.length ? batch : recentForState)
    .map(message => `${message.role === "user" ? "用户" : "角色"}: ${message.content.replace(/\s+/g, " ").slice(0, 220)}`)
    .join("\n");

  if (!transcript.trim()) return memory;

  const canCall = Boolean(model.apiKey) || model.baseUrl.includes("localhost") || model.baseUrl.includes("127.0.0.1");
  if (!canCall) {
    return options.forceStateOnly ? memory : foldExtractiveSummary(memory, prior, firstRecentId);
  }

  const previousBeat = memory.state.beat;
  const system = `你维护角色扮演试演的长期记忆。只输出 JSON，不要 markdown。
字段：
- summary: string，滚动事实摘要（事件/关系变化/承诺/已暴露信息/未决线索）。合并旧摘要与新对白，控制在 600 字内。禁止描写句式模板或逐句复述。
- state: object，字段 scene, proximity, mood, openThreads(string[]), promises(string[]), revealed(string[]), relationshipDelta, beat, timeInScene。简洁。
若 forceStateOnly，summary 可原样返回旧摘要并主要更新 state。`;

  const user = `旧摘要：
${memory.summary || "（无）"}

旧现场记忆卡：
${JSON.stringify(memory.state)}

模式：${options.forceStateOnly ? "forceStateOnly" : "mergeSummaryAndState"}

新对白：
${transcript}`;

  const content = await completeJsonText(model, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], options.signal);

  const parsed = parseMemoryRefresh(content, memory);
  const beatChanged = Boolean(parsed.state.beat) && parsed.state.beat !== previousBeat;
  const summarizedThroughId = options.forceStateOnly || !batch.length
    ? memory.summarizedThroughId
    : Math.max(memory.summarizedThroughId, batch[batch.length - 1].id);

  const next: RoleplaySessionMemory = {
    ...memory,
    summary: options.forceStateOnly
      ? (parsed.summary.trim() || memory.summary).slice(0, 4_000)
      : parsed.summary.slice(0, 4_000),
    summarizedThroughId,
    state: parsed.state,
    sameBeatTurns: beatChanged ? 0 : memory.sameBeatTurns,
    updatedAt: new Date().toISOString(),
  };
  return options.store.saveRoleplayMemory(options.sessionId, next);
}

function foldExtractiveSummary(
  memory: RoleplaySessionMemory,
  prior: RoleplayHistoryMessage[],
  firstRecentId: number,
): RoleplaySessionMemory {
  const older = prior.filter(message => message.id < firstRecentId && message.id > memory.summarizedThroughId);
  if (!older.length) return memory;
  const batch = older.slice(0, ROLEPLAY_SUMMARY_BATCH * 2);
  const lines = batch.map(message => {
    const label = message.role === "user" ? "用户" : "角色";
    return `- ${label}: ${message.content.replace(/\s+/g, " ").slice(0, 100)}`;
  });
  const merged = [memory.summary.trim(), "更早对白要点：", ...lines].filter(Boolean).join("\n").slice(-2_400);
  return {
    ...memory,
    summary: merged,
    summarizedThroughId: batch[batch.length - 1].id,
    updatedAt: new Date().toISOString(),
  };
}

function parseMemoryRefresh(text: string, fallback: RoleplaySessionMemory): { summary: string; state: RoleplayWorkingState } {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { summary: fallback.summary || cleaned.slice(0, 800), state: fallback.state };
  }
  try {
    const value = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const summary = typeof value.summary === "string" && value.summary.trim()
      ? value.summary.trim()
      : fallback.summary;
    const stateRaw = value.state && typeof value.state === "object" && !Array.isArray(value.state)
      ? value.state
      : value;
    const base = emptyRoleplayWorkingState();
    const str = (key: keyof RoleplayWorkingState) => {
      const v = (stateRaw as Record<string, unknown>)[key];
      return typeof v === "string" ? v.trim().slice(0, 400) : "";
    };
    const list = (key: "openThreads" | "promises" | "revealed") => {
      const v = (stateRaw as Record<string, unknown>)[key];
      return Array.isArray(v)
        ? v.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, 12)
        : fallback.state[key];
    };
    const state: RoleplayWorkingState = {
      scene: str("scene") || fallback.state.scene || base.scene,
      proximity: str("proximity") || fallback.state.proximity,
      mood: str("mood") || fallback.state.mood,
      openThreads: list("openThreads"),
      promises: list("promises"),
      revealed: list("revealed"),
      relationshipDelta: str("relationshipDelta") || fallback.state.relationshipDelta,
      beat: str("beat") || fallback.state.beat,
      timeInScene: str("timeInScene") || fallback.state.timeInScene,
    };
    return { summary, state };
  } catch {
    return { summary: fallback.summary || cleaned.slice(0, 800), state: fallback.state };
  }
}

async function completeJsonText(
  model: ModelConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const requestBody = JSON.stringify({
    model: model.model,
    messages,
    stream: false,
    temperature: 0.2,
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
  const responseBody = await response.text();
  logModelResponse(endpoint, responseBody);
  if (!response.ok) throw new Error(`扮演记忆刷新失败（${response.status}）：${responseBody.slice(0, 300)}`);
  const payload = JSON.parse(responseBody) as { choices?: Array<{ message?: { content?: string | null } }> };
  return payload.choices?.[0]?.message?.content ?? "";
}
