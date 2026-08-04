import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { emptyCharacter } from "./characters.js";
import { WriterProject } from "./project.js";
import {
  applyRoleplayDirectorSceneUpdate,
  buildRoleplayChatMessages,
  buildRoleplayAutoReplyMessages,
  buildRoleplayPerceptionMessages,
  buildRoleplayPerceptionRetryMessages,
  buildRoleplayStablePrefix,
  buildRoleplaySystemPrompt,
  deriveInterlocutorFromCharacter,
  emptyRoleplaySessionMemory,
  extractAntiFormulaHints,
  formatRoleplayAntiFormulaSlot,
  formatRoleplayMemorySlot,
  formatRoleplayOocDirective,
  countRoleplayContinuationStreak,
  formatRoleplayPerformerAutoReplyDirective,
  formatRoleplayPerception,
  formatRoleplayPerceptionForModel,
  formatRoleplayPlayerTurn,
  formatRoleplayQualityRewrite,
  formatRoleplayLengthGuidance,
  formatRoleplayRerunControls,
  formatRoleplayRerunDirections,
  formatRoleplaySummarySlot,
  isRoleplayContinuationContent,
  isRoleplayExitCommand,
  isRoleplayOocInput,
  parseRoleplayPerception,
  parseRoleplayAutoReply,
  parseRoleplayQualityReview,
  parseGeneratedRoleplayScene,
  parseStoredRoleplayPerception,
  normalizeRoleplayRerunControls,
  roleplayLengthPreset,
  roleplayTurnPresentationBudget,
  ROLEPLAY_RECENT_MESSAGES,
  ROLEPLAY_EPISTEMIC_MEMORY_VERSION,
  roleplayContextKey,
  roleplayCacheBatch,
  roleplayPerceptionNeedsSemanticRetry,
  roleplayPerceptionForMemory,
  roleplayPerformerKey,
  roleplaySampling,
  roleplaySummaryBatchDue,
  renderRoleplayWirePresentation,
  slimRoleplayCharacterViews,
  serializeRoleplayPerception,
  storedRoleplayPerceptionForDisplay,
  storedRoleplayPerceptionForModel,
  stripRoleplayOocMarker,
} from "./roleplay.js";
import { WriterStore } from "./store.js";
import { handleGetSimpleCharacter, handleListSimpleCharacters, handleSaveSimpleCharacter } from "./tools/characters.js";
import { handleInspectConversation, handleReadConversation } from "./tools/conversation.js";
import type { Character } from "./types.js";

function sampleCharacter(): Character {
  const base = emptyCharacter("林千夏");
  return {
    ...base,
    id: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    identity: {
      ...base.identity,
      name: "林千夏",
      narrativeRole: "主角",
      summary: "S 级机娘",
      aliases: ["千夏"],
    },
    voice: {
      ...base.voice,
      summary: "简洁、略带吐槽",
      register: "口语",
      verbalHabits: ["……嗯"],
      examples: ["别盯着我看。", "第二条例句不应整卡注入。"],
    },
    psychology: {
      ...base.psychology,
      summary: "外表冷静，内里紧绷",
    },
    competencies: [{
      id: "locked-skill", name: "终焉协议", summary: "尚未掌握的禁忌能力",
      level: "绝密", unlocked: false, description: "未解锁能力的秘密说明",
      resources: ["秘密资源"], limitations: ["秘密限制"], costs: ["秘密代价"],
    }],
  };
}

describe("roleplay prompts", () => {
  test("stable prefix embeds character voice without formula checklist or multi examples", () => {
    const prompt = buildRoleplayStablePrefix(sampleCharacter());
    assert.match(prompt, /角色扮演试演/);
    assert.match(prompt, /林千夏/);
    assert.match(prompt, /简洁、略带吐槽/);
    assert.match(prompt, /不要修改项目文档/);
    assert.match(prompt, /第一人称/);
    assert.doesNotMatch(prompt, /"name": "终焉协议"|尚未掌握的禁忌能力/u);
    assert.doesNotMatch(prompt, /"unlocked": false/);
    assert.doesNotMatch(prompt, /未解锁能力的秘密说明|绝密|秘密资源|秘密限制|秘密代价/);
    assert.match(prompt, /未透露姓名的来访者/);
    assert.match(prompt, /只决定一个核心反应/);
    assert.match(prompt, /完整的小节拍/);
    assert.match(prompt, /篇幅由最终用户消息/);
    assert.match(prompt, /不得因为它仍是一个小节拍就压成一两个块/);
    assert.match(prompt, /不要引用、改写或概括玩家原句/);
    assert.match(prompt, /解释角色为什么这样想、这样感受或这样行动/);
    assert.match(prompt, /可以按自身声线自然说明、追问或说长话/);
    assert.match(prompt, /信息缺口确有需要时自然提问/);
    assert.doesNotMatch(prompt, /默认零解释|普通回合默认零提问/u);
    assert.match(prompt, /具体数值只能引用上下文中已有的数值/);
    assert.match(prompt, /长档应在同一核心反应内依次完成/);
    assert.match(prompt, /开场同样服从本轮块数安排/);
    assert.match(prompt, /先否定再改判/);
    assert.match(prompt, /不是……是\/而是……/);
    assert.doesNotMatch(prompt, /字符|回复长度/);
    assert.match(prompt, /不要为了追求短而截断表达/);
    assert.doesNotMatch(prompt, /停顿、目光、呼吸、姿势/);
    assert.ok(prompt.includes("\"name\": \"林千夏\"") || prompt.includes("\"name\":\"林千夏\""));
    assert.match(prompt, /exampleHint/);
    assert.match(prompt, /spoken_dialogue_only/);
    assert.doesNotMatch(prompt, /第二条例句不应整卡注入/);
    // Backward-compatible alias still works.
    assert.equal(buildRoleplaySystemPrompt(sampleCharacter()), prompt);
  });

  test("slim views keep at most one voice example as hint", () => {
    const views = slimRoleplayCharacterViews(sampleCharacter()) as {
      dialogue: {
        owner: { characterId: number; name: string; appliesTo: string };
        voice: { exampleHint: string; verbalHabits: string[] };
      };
    };
    assert.equal(views.dialogue.voice.exampleHint, "别盯着我看。");
    assert.deepEqual(views.dialogue.voice.verbalHabits, ["……嗯"]);
    assert.deepEqual(views.dialogue.owner, {
      characterId: 1,
      name: "林千夏",
      appliesTo: "spoken_dialogue_only",
    });
  });

  test("roleplay sampling stays lively without allowing incoherent extremes", () => {
    assert.deepEqual(roleplaySampling({}), { temperature: 0.95, topP: 0.95 });
    assert.deepEqual(roleplaySampling({ temperature: 0.2, topP: 0.5 }), { temperature: 0.85, topP: 0.9 });
    assert.deepEqual(roleplaySampling({ temperature: 1.8, topP: 1.2 }), { temperature: 1.3, topP: 1 });
  });

  test("stable prefix fixes the generated interlocutor identity without controlling the user", () => {
    const prompt = buildRoleplayStablePrefix(sampleCharacter(), undefined, {
      name: "苏远",
      identity: "泛亚基地教官",
      relationship: "林千夏信任的搭档",
      knowledge: "知道本次训练安排",
      scene: "训练结束后的医务室",
      goal: "确认林千夏的状态",
    });
    assert.match(prompt, /对话者设定/);
    assert.match(prompt, /泛亚基地教官/);
    assert.match(prompt, /训练结束后的医务室/);
    assert.match(prompt, /叙事权限只覆盖/);
    assert.match(prompt, /不要替对话者、其他角色或世界决定/);
    assert.match(prompt, /current_perception/);
    assert.match(prompt, /信息缺口确有需要时自然提问/);
    assert.doesNotMatch(prompt, /普通回合默认零提问/u);
  });

  test("exit command detection accepts common variants", () => {
    assert.equal(isRoleplayExitCommand("/roleplay off"), true);
    assert.equal(isRoleplayExitCommand("/rp exit"), true);
    assert.equal(isRoleplayExitCommand("扮演 退出"), true);
    assert.equal(isRoleplayExitCommand("你好"), false);
    assert.equal(isRoleplayExitCommand("/roleplay 林千夏"), false);
  });

  test("fixed slots keep four system messages before history", () => {
    const messages = buildRoleplayChatMessages({
      stablePrefix: "STABLE",
      summary: "用户提到训练事故",
      state: {
        scene: "医务室",
        proximity: "一臂",
        mood: "紧绷",
        openThreads: ["事故"],
        promises: [],
        revealed: ["手在抖"],
        relationshipDelta: "试探性信任",
        beat: "试探",
        timeInScene: "数分钟后",
      },
      sameBeatTurns: 3,
      recentAssistantReplies: ["（目光移开）……你说什么？"],
      history: [
        { role: "user", content: "你还好吗？" },
        { role: "assistant", content: "还行。" },
      ],
      userText: "看着我。",
    });
    assert.equal(messages.length, 7);
    assert.deepEqual(messages.map(item => item.role), [
      "system", "system", "system", "system", "user", "assistant", "user",
    ]);
    assert.equal(messages[0].content, "STABLE");
    assert.match(messages[1].content, /滚动记忆路由/);
    assert.doesNotMatch(messages[1].content, /训练事故/);
    assert.match(messages[2].content, /现场记忆路由/);
    assert.doesNotMatch(messages[2].content, /已连续 3 轮/);
    assert.match(messages[3].content, /固定回合契约/);
    assert.match(messages[3].content, /可按稳定扮演规则自然说明、追问或说长话/);
    assert.doesNotMatch(messages[3].content, /默认零解释、零提问/u);
    assert.match(messages[6].content, /本轮角色可用动态上下文/);
    assert.match(messages[6].content, /训练事故/);
    assert.match(messages[6].content, /现场记忆卡/);
    assert.match(messages[6].content, /已连续 3 轮/);
    assert.match(messages[6].content, /当前玩家回合/);
    assert.match(messages[6].content, /看着我。/);
    assert.match(messages[6].content, /本轮动态演出提示/);
    assert.match(messages[6].content, /本轮演出/);
    assert.equal(roleplayPerceptionForMemory(messages[6].content), "看着我。");
  });

  test("all four system slots stay cache-stable while live context remains after history", () => {
    const base = {
      stablePrefix: "stable", summary: "", state: { scene: "", proximity: "", mood: "", openThreads: [], promises: [], revealed: [], relationshipDelta: "", beat: "", timeInScene: "" },
      history: [{ role: "assistant" as const, content: "「好。」" }], userText: "继续",
    };
    const first = buildRoleplayChatMessages({ ...base, recentAssistantReplies: ["「好。」"] });
    const second = buildRoleplayChatMessages({
      ...base,
      summary: "更早的回合已经变化",
      state: { ...base.state, scene: "新的现场", beat: "转折" },
      recentAssistantReplies: ["「真的吗？」"],
    });
    assert.deepEqual(first.slice(0, 4), second.slice(0, 4));
    assert.deepEqual(first.slice(4, -1), second.slice(4, -1));
    assert.notEqual(first.at(-1)?.content, second.at(-1)?.content);
    assert.equal(roleplayPerceptionForMemory(first.at(-1)?.content ?? ""), "继续");
    assert.equal(roleplayPerceptionForMemory(second.at(-1)?.content ?? ""), "继续");
  });

  test("directed reruns only change the dynamic tail", () => {
    const base = {
      stablePrefix: "stable",
      summary: "",
      state: { scene: "", proximity: "", mood: "", openThreads: [], promises: [], revealed: [], relationshipDelta: "", beat: "", timeInScene: "" },
      recentAssistantReplies: ["「好。」"],
      history: [{ role: "assistant" as const, content: "「好。」" }],
      userText: "<current_perception>\n听见对话者说：继续。\n</current_perception>",
    };
    const normal = buildRoleplayChatMessages(base);
    const directed = buildRoleplayChatMessages({ ...base, rerunDirections: ["shorter", "no_question"] });
    assert.deepEqual(normal.slice(0, -1), directed.slice(0, -1));
    assert.match(directed.at(-1)?.content ?? "", /本轮定向重演/);
    assert.match(directed.at(-1)?.content ?? "", /更短|不用问题/);
    assert.doesNotMatch(normal.at(-1)?.content ?? "", /本轮定向重演/);
    assert.equal(formatRoleplayRerunDirections(["shorter", "shorter", "no_question"]).match(/^- /gm)?.length, 2);
  });

  test("persisted model input makes the next roleplay request append to the cached prefix", () => {
    const base = {
      stablePrefix: "stable",
      summary: "摘要",
      state: { scene: "现场", proximity: "", mood: "", openThreads: [], promises: [], revealed: [], relationshipDelta: "", beat: "", timeInScene: "" },
      recentAssistantReplies: [] as string[],
      history: [] as Array<{ role: "user" | "assistant"; content: string }>,
      userText: "<current_perception>第一轮</current_perception>",
    };
    const first = buildRoleplayChatMessages(base);
    const second = buildRoleplayChatMessages({
      ...base,
      history: [
        { role: "user", content: first.at(-1)!.content },
        { role: "assistant", content: "<dialogue>第一轮回复</dialogue>" },
      ],
      userText: "<current_perception>第二轮</current_perception>",
    });
    assert.deepEqual(second.slice(0, first.length), first);
  });

  test("rerun sliders and content rating stay normalized in the dynamic tail", () => {
    const controls = normalizeRoleplayRerunControls({
      length: 9,
      pace: -1.4,
      emotion: -9,
      action: 1,
      initiative: 0,
      contentRating: "nsfw",
    });
    assert.deepEqual(controls, {
      length: 2,
      pace: -1,
      emotion: -2,
      action: 1,
      initiative: 0,
      contentRating: "nsfw",
    });
    const formatted = formatRoleplayRerunControls(controls);
    assert.match(formatted, /本轮演出参数/);
    assert.match(formatted, /篇幅：展开/);
    assert.match(formatted, /4–5 个相互连贯的演出块/);
    assert.match(formatted, /每块尽量写到约 100–140 字/);
    assert.match(formatted, /放慢节奏/);
    assert.match(formatted, /强制 NSFW/);
    assert.match(formatted, /成人向/);
    // Length is a standing control expressed structurally through presentation blocks.
    const defaults = formatRoleplayRerunControls(undefined);
    assert.match(defaults, /篇幅：适中/);
    assert.match(defaults, /2–3 个相互连贯的演出块/);
    assert.match(defaults, /每块尽量写到约 80–110 字/);
    assert.equal(roleplayLengthPreset(0).rangeLabel, "180–320 字");
    assert.deepEqual(roleplayTurnPresentationBudget(-2), {
      minBlocks: 1,
      maxBlocks: 1,
      preferredMinCharsPerBlock: 60,
      preferredMaxCharsPerBlock: 100,
    });
    assert.equal(roleplayTurnPresentationBudget(-1).minBlocks, 2);
    assert.equal(roleplayTurnPresentationBudget(2).maxBlocks, 5);
    assert.equal(roleplayTurnPresentationBudget(2).minBlocks, 4);
    assert.match(formatRoleplayLengthGuidance(1), /3–4 个相互连贯的演出块/);
    assert.match(formatRoleplayLengthGuidance(1), /每块尽量写到约 90–120 字/);
  });

  test("quality review parsing and rewrite instructions stay structural", () => {
    assert.deepEqual(parseRoleplayQualityReview('{"pass":false,"issues":["analysis_report","invented_fact","unknown"]}'), {
      pass: false,
      issues: ["analysis_report", "invented_fact"],
    });
    assert.deepEqual(parseRoleplayQualityReview('{"pass":true,"issues":[]}'), { pass: true, issues: [] });
    const rewrite = formatRoleplayQualityRewrite(["analysis_report", "question_list", "contrast_frame"], ["dialogue_only"]);
    assert.match(rewrite, /不是新的剧情回合/);
    assert.match(rewrite, /删除评估、解释和报告腔/);
    assert.match(rewrite, /不要列问题/);
    assert.match(rewrite, /先否定再改判/);
    assert.match(rewrite, /只输出一块 dialogue/);
  });

  test("rewinding to one branch point preserves the full prefix before the edited player turn", () => {
    const base = {
      stablePrefix: "stable",
      summary: "已经建立的摘要",
      state: { scene: "医务室", proximity: "一臂", mood: "警惕", openThreads: [], promises: [], revealed: [], relationshipDelta: "", beat: "试探", timeInScene: "片刻后" },
      recentAssistantReplies: ["「说吧。」"],
      history: [
        { role: "user" as const, content: "你好。" },
        { role: "assistant" as const, content: "「说吧。」" },
      ],
    };
    const original = buildRoleplayChatMessages({ ...base, userText: "原来的回合" });
    const edited = buildRoleplayChatMessages({ ...base, userText: "编辑后的回合" });
    assert.deepEqual(original.slice(0, -1), edited.slice(0, -1));
    const originalTurn = original.at(-1)?.content ?? "";
    const editedTurn = edited.at(-1)?.content ?? "";
    const originalMarker = originalTurn.indexOf("原来的回合");
    const editedMarker = editedTurn.indexOf("编辑后的回合");
    assert.ok(originalMarker > 0);
    assert.equal(originalTurn.slice(0, originalMarker), editedTurn.slice(0, editedMarker));
  });

  test("player turn envelope separates declarations from performer knowledge", () => {
    const framed = formatRoleplayPlayerTurn("我心里已经知道真相，悄悄藏起钥匙。『你猜。』");
    assert.match(framed, /不是自动成立的世界状态/);
    assert.match(framed, /内心、意图、回忆、隐藏行为/);
    assert.match(framed, /动作结果仍须留白/);
    assert.match(framed, /<player_turn>/);
    assert.match(framed, /我心里已经知道真相/);
  });

  test("roleplay wire protocol renders action, dialogue, and OOC deterministically", () => {
    const rendered = renderRoleplayWirePresentation([
      "<action>我把杯子推到桌边。</action>",
      "<dialogue>「先喝一点。」</dialogue>",
      "<ooc>场景将在这里暂停。</ooc>",
    ].join("\n"));
    assert.equal(rendered.valid, true);
    assert.equal(rendered.blocks.length, 3);
    assert.match(rendered.markdown, /^\*我把杯子推到桌边。\*/);
    assert.match(rendered.markdown, /「先喝一点。」/);
    assert.match(rendered.markdown, /> OOC：场景将在这里暂停。/);
    assert.doesNotMatch(rendered.markdown, /<action>|<dialogue>|<ooc>/);
    assert.equal(renderRoleplayWirePresentation("没有协议的混合文本").valid, false);
    assert.equal(renderRoleplayWirePresentation("<action>*她点点头。*</action>").markdown, "*她点点头。*");
  });

  test("Flash perception projection omits private content from the performer payload", () => {
    const projection = parseRoleplayPerception(JSON.stringify({
      speech: ["第一次见面？"],
      knowableFacts: ["对话者把一件无法辨认的东西收进口袋（动作尝试）"],
      unknowableFacts: ["对话者认出照片里的人是卧底"],
      potentialSensations: [],
    }));
    const displayPayload = formatRoleplayPerception(projection);
    const performerPayload = formatRoleplayPerceptionForModel(projection);
    assert.match(displayPayload, /话语：/);
    assert.match(performerPayload, /第一次见面/);
    assert.match(performerPayload, /无法辨认的东西/);
    assert.match(performerPayload, /current_perception/);
    assert.doesNotMatch(performerPayload, /话语：|可知事实：|^- /m);
    assert.match(displayPayload, /其他事实（不优先使用）/);
    assert.doesNotMatch(performerPayload, /卧底|照片里的人|unknowableFacts/);
    const onlyOther = parseRoleplayPerception(JSON.stringify({
      speech: [],
      knowableFacts: [],
      unknowableFacts: ["对话者心里认定对方已经适应"],
      potentialSensations: [],
    }));
    const onlyOtherPayload = formatRoleplayPerceptionForModel(onlyOther);
    assert.match(onlyOtherPayload, /不优先采用的附加线索/);
    assert.match(onlyOtherPayload, /心里认定对方已经适应/);
    assert.doesNotMatch(onlyOtherPayload, /没有接收到新的可确认/);
    const stored = serializeRoleplayPerception(projection);
    assert.match(stored, /"version":2/);
    assert.deepEqual(parseStoredRoleplayPerception(stored), projection);
    assert.equal(storedRoleplayPerceptionForModel(stored), performerPayload);
    assert.equal(storedRoleplayPerceptionForDisplay(stored), displayPayload);
    assert.throws(() => parseRoleplayPerception('{"speech":[],"knowableFacts":[]}'), /四个规定字段/);
    assert.throws(() => parseRoleplayPerception('```json\n{"speech":[],"knowableFacts":[],"unknowableFacts":[],"potentialSensations":[]}\n```'), /严格 JSON/);
    assert.throws(() => parseRoleplayPerception('{"speech":[],"knowableFacts":[],"unknowableFacts":[],"potentialSensations":[],"note":"extra"}'), /只能返回四个规定字段/);
  });

  test("perception compiler receives only the current player turn", () => {
    const messages = buildRoleplayPerceptionMessages("我把杯子推过去。「喝吧。」");
    const nextTurn = buildRoleplayPerceptionMessages("我走到门边，按下开关。");
    assert.deepEqual(messages.map(message => message.role), ["system", "user"]);
    // The Token Plan endpoint only reports cache hits once the stable prefix spans its 1024-token block.
    assert.ok(messages[0].content.length >= 2_200);
    assert.equal(messages[0].content, nextTurn[0].content);
    assert.notEqual(messages[1].content, nextTurn[1].content);
    assert.match(messages[0].content, /currentPlayerTurn 是唯一内容来源/);
    assert.match(messages[0].content, /第一人称叙述不自动等于 speech/);
    assert.match(messages[0].content, /来自“角色内”输入框/);
    assert.match(messages[0].content, /按扮演角色本轮的认知权限拆入四类/);
    assert.match(messages[0].content, /knowableFacts（可知事实）/);
    assert.match(messages[0].content, /unknowableFacts（其他事实，不优先使用）/);
    assert.match(messages[0].content, /potentialSensations（潜在感受）/);
    assert.match(messages[0].content, /禁止把整段可传达内容只放进 unknowableFacts/);
    assert.match(messages[0].content, /歧义时优先保证意图可达/);
    assert.match(messages[0].content, /必须且只能包含这四个键/);
    assert.deepEqual(JSON.parse(messages[1].content), {
      inputMode: "in_character",
      currentPlayerTurn: "我把杯子推过去。「喝吧。」",
    });
    assert.doesNotMatch(messages[1].content, /observableWorkingState|establishedScene|performer|playerIdentity/);
  });

  test("four-way perception receives a semantic coverage finalizer", () => {
    const input = "千夏，根据上面的安排，现在你已经和 bci 和超算适应了一段时间了，是时候展开一些压测了，过程可能会不舒服。";
    const empty = {
      speech: [], knowableFacts: [], unknowableFacts: [], potentialSensations: [],
    };
    assert.equal(roleplayPerceptionNeedsSemanticRetry(empty), true);
    assert.equal(roleplayPerceptionNeedsSemanticRetry({ ...empty, unknowableFacts: [input] }), false);
    assert.equal(roleplayPerceptionNeedsSemanticRetry({ ...empty, speech: [input] }), false);

    const messages = buildRoleplayPerceptionRetryMessages(input, empty);
    assert.deepEqual(messages.map(message => message.role), ["system", "user", "assistant", "user"]);
    assert.deepEqual(JSON.parse(messages[1].content), { inputMode: "in_character", currentPlayerTurn: input });
    assert.deepEqual(JSON.parse(messages[2].content), empty);
    assert.match(messages[3].content, /semantic_coverage_finalize/);
    assert.match(messages[3].content, /每个实质语义单元恰好进入四类之一/);
    assert.match(messages[3].content, /连续发言的尾随解释和列表仍属于 speech/);
  });

  test("perception projection exposes an opaque bodily effect without its hidden mechanism", () => {
    const projection = parseRoleplayPerception(JSON.stringify({
      speech: [],
      knowableFacts: ["对话者开始按摩角色的手臂"],
      unknowableFacts: ["对话者正在暗中调节神经递质"],
      potentialSensations: ["手臂可能逐渐放松，并出现舒适感"],
    }));
    const performerPayload = formatRoleplayPerceptionForModel(projection);
    assert.match(performerPayload, /按摩角色的手臂/);
    assert.match(performerPayload, /放松/);
    assert.match(performerPayload, /舒适感/);
    assert.doesNotMatch(performerPayload, /神经递质|调试器|多巴胺|内啡肽|override/);
  });

  test("automatic reply writes only the player-side identity turn", () => {
    const performer = { kind: "simple" as const, id: 1, name: "林千夏", card: { name: "林千夏", identity: "机娘", relationship: "搭档", knowledge: "知道训练安排", scene: "医务室", goal: "隐瞒伤势" } };
    const identity = { kind: "simple" as const, id: 2, name: "苏远", card: { name: "苏远", identity: "教官", relationship: "搭档", knowledge: "知道她刚结束训练", scene: "医务室", goal: "确认她的状态" } };
    const messages = buildRoleplayAutoReplyMessages({
      performer,
      identity,
      recentTranscript: [
        { role: "assistant", content: "<dialogue>「我没事。」</dialogue>" },
      ],
    });
    assert.deepEqual(messages.map(message => message.role), ["system", "user"]);
    assert.match(messages[0].content, /playerIdentity 是用户在本场对话中使用的身份/u);
    assert.match(messages[0].content, /绝不能代替 performedCharacter 回复/u);
    assert.match(messages[0].content, /role=user 的历史消息属于 playerIdentity/u);
    assert.match(messages[0].content, /不得替 performedCharacter 或其他角色决定/);
    assert.match(messages[0].content, /必须始终采用第一人称主观视角/);
    assert.match(messages[0].content, /不得用 playerIdentity 的姓名、“他”“她”或“TA”指代自己/);
    assert.match(messages[0].content, /角色卡即使以第三人称描述，也不能改变 reply 的第一人称视角/);
    assert.match(messages[0].content, /30–100 个汉字/);
    const payload = JSON.parse(messages[1].content) as Record<string, unknown>;
    assert.equal(payload.playerIdentity, "苏远");
    assert.equal(payload.performedCharacter, "林千夏");
    assert.deepEqual(payload.playerIdentityCard, identity.card);
    assert.deepEqual(payload.performedCharacterCard, performer.card);
    assert.deepEqual(payload.recentTranscript, [
      { role: "assistant", content: "<dialogue>「我没事。」</dialogue>" },
    ]);
    assert.equal(parseRoleplayAutoReply('{"reply":"我把水杯推近一点。「先喝水。」"}'), "我把水杯推近一点。「先喝水。」");
    assert.throws(() => parseRoleplayAutoReply('{"reply":"   "}'), /空的身份代答/);
  });

  test("context key isolates identity and scene revisions", () => {
    const performer = { kind: "normal" as const, id: 1, name: "林千夏", card: { name: "林千夏", identity: "", relationship: "", knowledge: "", scene: "", goal: "" } };
    const first = { kind: "simple" as const, id: 2, name: "苏远", card: { name: "苏远", identity: "", relationship: "", knowledge: "", scene: "", goal: "" } };
    const second = { ...first, id: 3, name: "李岚" };
    const scene = { id: 4, name: "医务室", setting: "基地", premise: "训练后", tone: "克制", timelineAnchor: "第一幕", performerGoal: "", identityGoal: "", stakes: [], openingVariants: [], endConditions: [], loreBindings: [], revision: 1, createdAt: "", updatedAt: "" };
    assert.notEqual(roleplayContextKey(performer, first, scene), roleplayContextKey(performer, second, scene));
    assert.notEqual(roleplayContextKey(performer, first, scene), roleplayContextKey(performer, first, { ...scene, revision: 2 }));
    assert.match(roleplayContextKey(performer, first, scene), new RegExp(`knowledge:v${ROLEPLAY_EPISTEMIC_MEMORY_VERSION}$`));
  });

  test("dynamic tail carries scene, facts, and lore without adding a fifth system slot", () => {
    const scene = { id: 1, name: "雨夜重逢", setting: "旧港", premise: "三年后重逢", tone: "紧张", timelineAnchor: "第二卷后", performerGoal: "追问", identityGoal: "隐瞒", stakes: ["身份暴露"], openingVariants: [], endConditions: ["一方离场"], loreBindings: ["lore/旧港.md"], revision: 1, createdAt: "", updatedAt: "" };
    const messages = buildRoleplayChatMessages({
      stablePrefix: "stable", summary: "", state: { scene: "旧港", proximity: "", mood: "", openThreads: [], promises: [], revealed: [], relationshipDelta: "", beat: "", timeInScene: "" },
      scene,
      facts: [{ id: 1, sessionId: "s", contextKey: "k", kind: "promise", content: "答应天亮前离开", sourceMessageId: 9, knownBy: ["public"], importance: 90, status: "active", pinned: true, createdAt: "", updatedAt: "" }],
      lore: [{ path: "lore/旧港.md", excerpt: "旧港午夜封锁。", reason: "地点相关", sourceHash: "h" }],
      recentAssistantReplies: [], history: [], userText: "继续",
    });
    assert.equal(messages.filter(message => message.role === "system").length, 4);
    assert.doesNotMatch(messages[2].content, /雨夜重逢/);
    assert.match(messages.at(-1)?.content ?? "", /雨夜重逢/);
    assert.match(messages.at(-1)?.content ?? "", /答应天亮前离开/);
    assert.match(messages.at(-1)?.content ?? "", /旧港午夜封锁/);
  });

  test("empty summary and memory use stable placeholders", () => {
    assert.equal(formatRoleplaySummarySlot(""), "角色可用的滚动记忆：无。");
    assert.match(formatRoleplayMemorySlot({
      scene: "", proximity: "", mood: "", openThreads: [], promises: [],
      revealed: [], relationshipDelta: "", beat: "", timeInScene: "",
    }), /现场记忆卡：无/);
    assert.match(formatRoleplayAntiFormulaSlot([]), /本轮演出/);
  });

  test("anti-formula extracts openings and repeated gestures", () => {
    const hints = extractAntiFormulaHints([
      "（目光低垂，呼吸一滞）你说完了。",
      "（嘴角动了动）……算了。",
    ]);
    assert.ok(hints.openings.some(item => item.includes("目光") || item.includes("（")));
    assert.ok(hints.gestures.includes("目光") || hints.gestures.includes("呼吸") || hints.gestures.includes("嘴角"));
    assert.equal(hints.usedQuestionEnd, false);
    assert.equal(hints.usedActionThenSpeech, true);
    const slot = formatRoleplayAntiFormulaSlot([
      "（目光低垂）你到底想怎样？",
    ]);
    assert.match(slot, /本轮演出/);
    assert.match(slot, /直接开口|沉默/);
    assert.doesNotMatch(slot, /禁用开场|目光低垂/);
  });

  test("anti-formula escalates on question-end streak and hard-bans question marks", () => {
    const hints = extractAntiFormulaHints([
      "「你饿了？」",
      "「那你想去哪？」",
      "「真的吗？」",
    ]);
    assert.equal(hints.questionEndStreak, 3);
    const slot = formatRoleplayAntiFormulaSlot([
      "「那你想去哪？」",
      "「真的吗？」",
    ]);
    assert.match(slot, /陈述、动作或留白/);
    // Single question-end stays at the soft warning.
    const soft = extractAntiFormulaHints(["「好。」", "「真的吗？」"]);
    assert.equal(soft.questionEndStreak, 1);
    assert.doesNotMatch(formatRoleplayAntiFormulaSlot(["「好。」", "「真的吗？」"]), /连续用问题/);
  });

  test("anti-formula nudges scene participation when recent replies lack environment", () => {
    const sceneless = extractAntiFormulaHints([
      "「随你。」",
      "（别过脸）「我没这么说。」",
    ]);
    assert.equal(sceneless.lacksScene, true);
    assert.match(formatRoleplayAntiFormulaSlot(["「随你。」", "（别过脸）「我没这么说。」"]), /已经建立的现场细节/);
    // Environment words in any recent reply suppress the nudge.
    const grounded = extractAntiFormulaHints([
      "（把杯子推过去）「喝完再说。」",
      "「随你。」",
    ]);
    assert.equal(grounded.lacksScene, false);
    // A single reply is too early to demand scene grounding.
    assert.equal(extractAntiFormulaHints(["「随你。」"]).lacksScene, false);
  });

  test("recent window constant stays short for cache and anti-echo", () => {
    assert.equal(ROLEPLAY_RECENT_MESSAGES, 8);
  });

  test("rolling summary waits for a full cold-history batch", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({ id: index + 1 }));
    assert.equal(roleplaySummaryBatchDue(messages, 8, 0), false);
    assert.equal(roleplaySummaryBatchDue(messages, 9, 0), true);
    assert.equal(roleplaySummaryBatchDue(messages, 12, 3), true);
    assert.equal(roleplaySummaryBatchDue(messages, 12, 4), false);
    assert.deepEqual(roleplayCacheBatch(messages, 0).map(message => message.id), messages.map(message => message.id));
    assert.deepEqual(roleplayCacheBatch(messages, 8).map(message => message.id), [9, 10, 11, 12]);
  });

  test("normal identity card keeps relationship / scene / knowledge instead of blanking them", () => {
    const performer = { ...sampleCharacter(), id: 1 };
    const identity: Character = {
      ...sampleCharacter(),
      id: 2,
      identity: { ...sampleCharacter().identity, name: "苏远", summary: "泛亚基地教官" },
      relationships: [{
        id: "rel-1", characterId: 1, type: "搭档", attitude: "信任但担忧",
        status: "active", description: "带过林千夏的实战训练",
      }],
      storyStates: [{
        id: "st-1", location: "训练结束后的医务室", physical: "疲惫", emotion: "克制的关切",
        knowledge: [{ id: "k1", label: "训练安排", description: "知道今天的训练强度超标" }],
        beliefs: [], intentions: [], temporaryGoals: [], notes: "",
      }],
      motivations: [{
        id: "m1", category: "current", status: "active", priority: 1,
        summary: "确认林千夏的身体状态", stakes: "", obstacles: [],
      }],
    };
    const derived = deriveInterlocutorFromCharacter(identity, performer);
    assert.equal(derived.name, "苏远");
    assert.match(derived.relationship, /搭档/);
    assert.match(derived.relationship, /带过林千夏/);
    assert.match(derived.scene, /医务室/);
    assert.match(derived.knowledge, /训练强度超标/);
    assert.match(derived.goal, /身体状态/);
    // And it flows into the stable prefix.
    const prompt = buildRoleplayStablePrefix(performer, undefined, identity);
    assert.match(prompt, /医务室/);
    assert.match(prompt, /带过林千夏/);
  });

  test("OOC input detection and marker stripping", () => {
    assert.equal(isRoleplayOocInput("（时间跳到当晚）"), true);
    assert.equal(isRoleplayOocInput("(她的态度冷淡一点)"), true);
    assert.equal(isRoleplayOocInput("/ooc 换到雨夜的巷口"), true);
    assert.equal(isRoleplayOocInput("你还好吗？"), false);
    assert.equal(isRoleplayOocInput("（叹气）我没事。"), false);
    assert.equal(stripRoleplayOocMarker("（时间跳到当晚）"), "时间跳到当晚");
    assert.equal(stripRoleplayOocMarker("/ooc：换到雨夜的巷口"), "换到雨夜的巷口");
    assert.match(formatRoleplayOocDirective("时间跳到当晚"), /OOC 导演指示/);
    assert.match(formatRoleplayOocDirective("时间跳到当晚"), /时间跳到当晚/);
  });

  test("director input immediately replaces the session-local scene state", () => {
    const memory = emptyRoleplaySessionMemory("roleplay-context");
    memory.state.scene = "旧港仓库";
    const updated = applyRoleplayDirectorSceneUpdate(memory, "千夏用尽力气启动一部分武装展开。 ");
    assert.equal(updated.state.scene, "千夏用尽力气启动一部分武装展开。");
    assert.equal(memory.state.scene, "旧港仓库");
  });

  test("generated scene cards keep only the three simple fields", () => {
    assert.deepEqual(parseGeneratedRoleplayScene('{"name":"清晨离港","setting":"次日清晨，旧港","premise":"两人在分别前处理昨夜未解决的争执。","tone":"ignored"}'), {
      name: "清晨离港",
      setting: "次日清晨，旧港",
      premise: "两人在分别前处理昨夜未解决的争执。",
    });
  });

  test("performer auto reply continues without inventing a player turn", () => {
    const directive = formatRoleplayPerformerAutoReplyDirective("林千夏", {
      lastPerformance: "*她把门带上，蹲在巷子里擦掉刃片上的血。*",
    });
    assert.match(directive, /旁观续演/);
    assert.match(directive, /用户暂时不说话/);
    assert.match(directive, /推进已经开始的行动链/);
    assert.match(directive, /不要假定对方已回答/);
    assert.match(directive, /把门带上/);
    assert.match(directive, /林千夏/);
    assert.equal(isRoleplayContinuationContent("<续演>"), true);
    assert.equal(isRoleplayContinuationContent("继续"), false);
    assert.equal(countRoleplayContinuationStreak([
      { role: "user", content: "推进" },
      { role: "assistant", content: "第一拍" },
      { role: "user", content: "<续演>" },
      { role: "assistant", content: "第二拍" },
      { role: "user", content: "<续演>" },
      { role: "assistant", content: "第三拍" },
    ]), 2);
    const chained = formatRoleplayPerformerAutoReplyDirective("林千夏", { continuationStreak: 2 });
    assert.match(chained, /连续第 3 次旁观续演/);
    assert.match(chained, /禁止重写开场/);
    const spectatorHints = formatRoleplayAntiFormulaSlot(["*动作。*\n\n「说。」"], { spectatorContinuation: true });
    assert.match(spectatorHints, /旁观续演/);
    assert.match(spectatorHints, /禁止重演已完成的动作/);
  });
});

describe("roleplay memory store", () => {
  test("stores scenes, correctable facts, and restores message-point snapshots", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-roleplay-p0-"));
    try {
      const project = WriterProject.init(root, "P0");
      const store = new WriterStore(project);
      const sessionId = store.createSession("scene-memory");
      const scene = store.saveRoleplayScene({
        name: "雨夜旧港", setting: "旧港", premise: "失联后重逢", tone: "紧张", timelineAnchor: "第二卷后",
        performerGoal: "追问", identityGoal: "隐瞒", stakes: ["身份暴露"], openingVariants: ["从警报声开始"],
        endConditions: ["一方离场"], loreBindings: [],
      });
      assert.equal(scene.revision, 1);
      const editedScene = store.saveRoleplayScene({ ...scene, tone: "克制" });
      assert.equal(editedScene.revision, 2);

      const contextKey = "normal:1|simple:2|scene:1@2";
      const fact = store.saveRoleplayMemoryFact(sessionId, contextKey, {
        content: "苏远答应天亮前离开", kind: "promise", knownBy: ["public"], importance: 90,
        status: "active", pinned: false, sourceMessageId: 12,
      });
      const corrected = store.saveRoleplayMemoryFact(sessionId, contextKey, { ...fact, content: "苏远答应日出前离开", pinned: true });
      assert.equal(corrected.content, "苏远答应日出前离开");
      assert.equal(store.roleplayMemoryFacts(sessionId, contextKey).length, 1);

      const snapshot = emptyRoleplaySessionMemory(contextKey);
      snapshot.summary = "旧摘要";
      snapshot.turnCount = 2;
      store.saveRoleplayMemory(sessionId, snapshot);
      store.saveRoleplayMemorySnapshot(sessionId, 10, snapshot);
      store.saveRoleplayMemory(sessionId, { ...snapshot, summary: "错误分支", turnCount: 5 });
      store.restoreRoleplayMemoryBefore(sessionId, 11);
      assert.equal(store.roleplayMemory(sessionId)?.summary, "旧摘要");
      assert.equal(store.roleplayMemory(sessionId)?.turnCount, 2);
      // Manually pinned facts survive rewind even when their source message is newer.
      assert.equal(store.roleplayMemoryFacts(sessionId, contextKey)[0].pinned, true);
      store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("persists memory and clears with active roleplay exit", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-roleplay-memory-"));
    try {
      const project = WriterProject.init(root, "扮演记忆");
      const store = new WriterStore(project);
      const character = store.saveCharacter({ identity: emptyCharacter("林千夏").identity });
      const sessionId = store.createSession("记忆会话");
      store.saveActiveRoleplay(sessionId, character.id, {
        name: "苏远",
        identity: "基地教官",
        relationship: "搭档",
        knowledge: "训练安排",
        scene: "医务室",
        goal: "确认状态",
      });
      const key = roleplayPerformerKey({
        kind: "normal",
        id: character.id,
        name: "林千夏",
        card: { name: "林千夏", identity: "", relationship: "", knowledge: "", scene: "", goal: "" },
      });
      const memory = emptyRoleplaySessionMemory(key);
      memory.summary = "用户提到训练事故；角色回避细节。";
      memory.summarizedThroughId = 12;
      memory.state.scene = "医务室";
      memory.state.beat = "试探";
      memory.turnCount = 5;
      memory.sameBeatTurns = 3;
      store.saveRoleplayMemory(sessionId, memory);

      const restored = store.roleplayMemory(sessionId);
      assert.equal(restored?.performerKey, `normal:${character.id}`);
      assert.match(restored?.summary ?? "", /训练事故/);
      assert.equal(restored?.summarizedThroughId, 12);
      assert.equal(restored?.state.scene, "医务室");
      assert.equal(restored?.sameBeatTurns, 3);

      store.clearActiveRoleplay(sessionId, { preserveMemory: true });
      assert.match(store.roleplayMemory(sessionId)?.summary ?? "", /训练事故/);

      store.clearActiveRoleplay(sessionId);
      assert.equal(store.roleplayMemory(sessionId), undefined);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("message channel isolation", () => {
  test("roleplay filter hides agent turns while unfiltered history keeps both", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-channel-"));
    try {
      const project = WriterProject.init(root, "通道隔离");
      const store = new WriterStore(project);
      const sessionId = store.createSession("扮演测试");
      store.addMessage(sessionId, "user", "写第二章开场", "agent");
      store.addMessage(sessionId, "assistant", "已起草开场", "agent");
      store.addMessage(sessionId, "user", "你今天感觉如何？", "roleplay");
      store.addMessage(sessionId, "assistant", "……还行。", "roleplay");

      const all = store.messages(sessionId, 20);
      assert.equal(all.length, 4);
      assert.deepEqual(all.map(item => item.channel), ["agent", "agent", "roleplay", "roleplay"]);

      const roleplayOnly = store.messages(sessionId, 20, { channel: "roleplay" });
      assert.equal(roleplayOnly.length, 2);
      assert.ok(roleplayOnly.every(item => item.channel === "roleplay"));
      assert.equal(roleplayOnly[0].content, "你今天感觉如何？");

      const agentOnly = store.messages(sessionId, 20, { channel: "agent" });
      assert.equal(agentOnly.length, 2);
      assert.ok(agentOnly.every(item => item.channel === "agent"));
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists a roleplay perception separately from the raw player message", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-perception-"));
    try {
      const project = WriterProject.init(root, "感知投影");
      const store = new WriterStore(project);
      const sessionId = store.createSession("投影测试");
      const messageId = store.addMessage(sessionId, "user", "我暗自认出卧底。『你好。』", "roleplay");
      store.saveRoleplayPerception(sessionId, messageId, "可听见的话语：你好。");
      assert.equal(store.roleplayPerception(sessionId, messageId), "可听见的话语：你好。");
      assert.equal(store.messages(sessionId, 10, { channel: "roleplay" })[0].content, "我暗自认出卧底。『你好。』");
      store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("director input mode is persisted and returned when rerunning the turn", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-roleplay-director-mode-"));
    try {
      const project = WriterProject.init(root, "导演消息模式");
      const store = new WriterStore(project);
      const sessionId = store.createSession("导演消息");
      const userId = store.addMessage(
        sessionId,
        "user",
        "把时间推进到第二天。",
        "roleplay",
        undefined,
        "director",
      );
      store.saveRoleplayPerception(sessionId, userId, "［OOC 导演指示——把时间推进到第二天。］");
      const assistantId = store.addMessage(sessionId, "assistant", "次日清晨。", "roleplay");

      assert.equal(store.messages(sessionId, 10, { channel: "roleplay" })[0].roleplayInputMode, "director");
      assert.equal(store.prepareMessageRerun(sessionId, assistantId).inputMode, "director");
      store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("roleplay branches restore messages, perceptions, and working memory", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-roleplay-branches-"));
    try {
      const project = WriterProject.init(root, "分支切换");
      const store = new WriterStore(project);
      const sessionId = store.createSession("分支");
      const firstUser = store.addMessage(sessionId, "user", "第一版输入", "roleplay");
      const firstProjection = serializeRoleplayPerception({
        speech: ["第一版"], knowableFacts: [], unknowableFacts: [], potentialSensations: [],
      });
      store.saveRoleplayPerception(sessionId, firstUser, firstProjection);
      store.saveRoleplayModelInput(sessionId, firstUser, "第一版模型输入");
      const firstAssistant = store.addMessage(sessionId, "assistant", "「第一版回复。」", "roleplay");
      const firstMemory = { ...emptyRoleplaySessionMemory("context"), summary: "第一版记忆", turnCount: 1 };
      store.saveRoleplayMemory(sessionId, firstMemory);
      store.saveRoleplayMemorySnapshot(sessionId, firstAssistant, firstMemory);

      const rerun = store.prepareMessageRerun(sessionId, firstAssistant);
      const secondUser = store.addMessage(sessionId, "user", "第一版输入", "roleplay", rerun.variantGroupId);
      const secondProjection = serializeRoleplayPerception({
        speech: ["第二版"], knowableFacts: [], unknowableFacts: [], potentialSensations: [],
      });
      store.saveRoleplayPerception(sessionId, secondUser, secondProjection);
      store.saveRoleplayModelInput(sessionId, secondUser, "第二版模型输入");
      const secondAssistant = store.addMessage(sessionId, "assistant", "「第二版回复。」", "roleplay", rerun.variantGroupId);
      const secondMemory = { ...emptyRoleplaySessionMemory("context"), summary: "第二版记忆", turnCount: 1 };
      store.saveRoleplayMemory(sessionId, secondMemory);
      store.saveRoleplayMemorySnapshot(sessionId, secondAssistant, secondMemory);

      const firstBranch = store.roleplayBranches(sessionId, rerun.variantGroupId)[0];
      assert.ok(firstBranch);
      store.activateRoleplayBranch(sessionId, firstBranch.id);
      assert.equal(store.messages(sessionId, 20, { channel: "roleplay" }).at(-1)?.content, "「第一版回复。」");
      const restoredFirstUser = store.messages(sessionId, 20, { channel: "roleplay" }).find(message => message.role === "user")!;
      assert.equal(store.roleplayPerception(sessionId, restoredFirstUser.id), firstProjection);
      assert.equal(store.roleplayModelInput(sessionId, restoredFirstUser.id), "第一版模型输入");
      assert.equal(store.roleplayMemory(sessionId)?.summary, "第一版记忆");

      const secondBranch = store.roleplayBranches(sessionId, rerun.variantGroupId)
        .find(branch => branch.preview.includes("第二版回复"));
      assert.ok(secondBranch);
      store.activateRoleplayBranch(sessionId, secondBranch.id);
      assert.equal(store.messages(sessionId, 20, { channel: "roleplay" }).at(-1)?.content, "「第二版回复。」");
      const restoredSecondUser = store.messages(sessionId, 20, { channel: "roleplay" }).find(message => message.role === "user")!;
      assert.equal(store.roleplayPerception(sessionId, restoredSecondUser.id), secondProjection);
      assert.equal(store.roleplayModelInput(sessionId, restoredSecondUser.id), "第二版模型输入");
      assert.equal(store.roleplayMemory(sessionId)?.summary, "第二版记忆");
      store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("saved roleplay interlocutors", () => {
  test("agent tool saves a generated simple character card", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-simple-character-tool-"));
    try {
      const project = WriterProject.init(root, "简易角色工具");
      const store = new WriterStore(project);
      const sessionId = store.createSession("创建简易角色");
      const result = JSON.parse(handleSaveSimpleCharacter({
        input: {
          name: "李技术员", identity: "夏展展开后武装的检修技术员", relationship: "负责支援夏展",
          knowledge: "了解展开后武装的检查流程", scene: "整备区", goal: "完成检查与调节",
        },
        project, store, sessionId, emit: () => undefined, context: { permissionMode: "auto" },
      })) as { kind: string; created: boolean };
      assert.equal(result.kind, "simple");
      assert.equal(result.created, true);
      assert.equal(store.roleplayInterlocutors()[0].name, "李技术员");
      assert.equal(store.characters().length, 0);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent tools list and read complete simple character cards", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-simple-character-read-"));
    try {
      const project = WriterProject.init(root, "simple read");
      const store = new WriterStore(project);
      const sessionId = store.createSession("read");
      const saved = store.saveRoleplayInterlocutor({
        name: "Technician Li", identity: "maintenance technician", relationship: "supports the lead",
        knowledge: "inspection procedure", scene: "hangar", goal: "finish calibration",
      });
      const args = { project, store, sessionId, emit: () => undefined, context: { permissionMode: "auto" as const } };
      const listed = JSON.parse(handleListSimpleCharacters({ ...args, input: {} })) as Array<{ id: number }>;
      assert.equal(listed[0].id, saved.id);
      const card = JSON.parse(handleGetSimpleCharacter({ ...args, input: { id: saved.id } })) as { knowledge: string };
      assert.equal(card.knowledge, "inspection procedure");
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent tools honor the UI visibility scope for simple character cards", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-simple-character-scope-"));
    try {
      const project = WriterProject.init(root, "simple scope");
      const store = new WriterStore(project);
      const sessionId = store.createSession("scope");
      const visible = store.saveRoleplayInterlocutor({
        name: "Visible", identity: "visible identity", relationship: "", knowledge: "", scene: "", goal: "",
      });
      const hidden = store.saveRoleplayInterlocutor({
        name: "Hidden", identity: "hidden identity", relationship: "", knowledge: "", scene: "", goal: "",
      });
      const args = {
        project, store, sessionId, emit: () => undefined,
        context: { permissionMode: "auto" as const, simpleCharacterScope: [visible.id] },
      };
      const listed = JSON.parse(handleListSimpleCharacters({ ...args, input: {} })) as Array<{ id: number }>;
      assert.deepEqual(listed.map(card => card.id), [visible.id]);
      assert.throws(() => handleGetSimpleCharacter({ ...args, input: { id: hidden.id } }), /不在本次可读范围/);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persist separately from full character cards and support update/delete", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-roleplay-card-"));
    try {
      const project = WriterProject.init(root, "试演身份库");
      const store = new WriterStore(project);
      const characterCount = store.characters().length;
      const saved = store.saveRoleplayInterlocutor({
        name: "苏远",
        identity: "基地教官",
        relationship: "林千夏的搭档",
        knowledge: "知道训练安排",
        scene: "医务室",
        goal: "确认她的状态",
      });
      assert.ok(saved.id > 0);
      assert.equal(store.characters().length, characterCount);
      assert.equal(store.roleplayInterlocutors()[0].name, "苏远");
      const simpleCardsPath = join(root, "characters", "simple-characters.jsonl");
      assert.equal(existsSync(simpleCardsPath), true);
      assert.equal(JSON.parse(readFileSync(simpleCardsPath, "utf8").trim()).name, "苏远");
      assert.equal(Number(store.database.prepare("SELECT COUNT(*) count FROM roleplay_interlocutors").get()!.count), 0);

      const updated = store.saveRoleplayInterlocutor({ ...saved, identity: "泛亚基地教官" });
      assert.equal(updated.id, saved.id);
      assert.equal(store.roleplayInterlocutors()[0].identity, "泛亚基地教官");

      store.deleteRoleplayInterlocutor(saved.id);
      assert.deepEqual(store.roleplayInterlocutors(), []);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("migrates legacy SQLite simple cards into characters JSONL", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-simple-card-migration-"));
    try {
      const project = WriterProject.init(root, "简易角色迁移");
      let store = new WriterStore(project);
      store.database.prepare(`INSERT INTO roleplay_interlocutors(
        target_character_id,name,identity,relationship,knowledge,scene,goal,created_at,updated_at
      ) VALUES(NULL,?,?,?,?,?,?,?,?)`).run(
        "旧卡", "旧身份", "旧关系", "旧知识", "旧场景", "旧目标",
        "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z",
      );
      store.close();

      store = new WriterStore(project);
      assert.equal(store.roleplayInterlocutors()[0].name, "旧卡");
      assert.equal(Number(store.database.prepare("SELECT COUNT(*) count FROM roleplay_interlocutors").get()!.count), 0);
      const persisted = readFileSync(join(root, "characters", "simple-characters.jsonl"), "utf8");
      assert.match(persisted, /"name":"旧卡"/);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("active roleplay survives store reopen and clears on exit", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-active-roleplay-"));
    try {
      const project = WriterProject.init(root, "当前试演");
      let store = new WriterStore(project);
      const character = store.saveCharacter({ identity: emptyCharacter("林千夏").identity });
      const sessionId = store.createSession("试演会话");
      const arrival = store.saveRoleplayScene({ name: "抵达", setting: "雨夜旧港", premise: "失联后重逢" });
      const departure = store.saveRoleplayScene({ name: "离开", setting: "次日清晨", premise: "决定是否同行" });
      store.saveActiveRoleplay(sessionId, character.id, {
        name: "苏远",
        identity: "基地教官",
        relationship: "林千夏的搭档",
        knowledge: "知道训练安排",
        scene: "医务室",
        goal: "确认她的状态",
      }, departure.id, "sfw", [arrival.id, departure.id], 1);
      store.close();

      store = new WriterStore(project);
      const restored = store.activeRoleplay(sessionId);
      assert.equal(restored?.performer.id, character.id);
      assert.equal(restored?.performer.name, "林千夏");
      assert.equal(restored?.identity.name, "苏远");
      assert.deepEqual(restored?.sceneSequence.map(scene => scene.name), ["抵达", "离开"]);
      assert.equal(restored?.sceneIndex, 1);
      assert.equal(restored?.scene?.name, "离开");
      assert.equal(restored?.contentRating, "sfw");
      store.clearActiveRoleplay(sessionId);
      assert.equal(store.activeRoleplay(sessionId), undefined);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("simple and normal cards can be selected on either side", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-roleplay-participants-"));
    try {
      const project = WriterProject.init(root, "双向角色卡");
      let store = new WriterStore(project);
      const normal = store.saveCharacter({ identity: emptyCharacter("林千夏").identity });
      const simple = store.saveRoleplayInterlocutor({
        name: "苏远", identity: "基地教官", relationship: "搭档",
        knowledge: "知道训练安排", scene: "医务室", goal: "确认她的状态",
      });
      const sessionId = store.createSession("双向选择");
      store.saveActiveRoleplay(
        sessionId,
        { kind: "simple", id: simple.id, name: simple.name, card: simple },
        { kind: "normal", id: normal.id, name: normal.identity.name, card: { name: normal.identity.name, identity: "", relationship: "", knowledge: "", scene: "", goal: "" } },
      );
      store.close();

      store = new WriterStore(project);
      const restored = store.activeRoleplay(sessionId);
      assert.equal(restored?.performer.kind, "simple");
      assert.equal(restored?.performer.name, "苏远");
      assert.equal(restored?.identity.kind, "normal");
      assert.equal(restored?.identity.name, "林千夏");
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reruns a model-initiated opening without requiring or borrowing a user instruction", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-roleplay-opening-rerun-"));
    try {
      const project = WriterProject.init(root, "开场重跑");
      const store = new WriterStore(project);
      const sessionId = store.createSession("开场");
      store.addMessage(sessionId, "user", "先前的写作任务", "agent");
      store.addMessage(sessionId, "assistant", "先前的写作回复", "agent");
      const openingId = store.addMessage(sessionId, "assistant", "「第一次开场。」", "roleplay");
      const memory = { ...emptyRoleplaySessionMemory("context"), summary: "第一次开场记忆", turnCount: 1 };
      store.saveRoleplayMemory(sessionId, memory);
      store.saveRoleplayMemorySnapshot(sessionId, openingId, memory);

      const rerun = store.prepareMessageRerun(sessionId, openingId);
      assert.equal(rerun.modelInitiatedRoleplay, "opening");
      assert.equal(rerun.fromId, openingId);
      assert.equal(rerun.prompt, "");
      assert.equal(rerun.channel, "roleplay");
      assert.equal(store.messages(sessionId, 20, { channel: "roleplay" }).length, 0);
      assert.equal(store.roleplayMemory(sessionId), undefined);

      const secondOpeningId = store.addMessage(sessionId, "assistant", "「第二次开场。」", "roleplay", rerun.variantGroupId);
      assert.deepEqual(
        store.messageVersions(sessionId, secondOpeningId).versions.map(version => version.content),
        ["「第一次开场。」", "「第二次开场。」"],
      );
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reruns a continuation placeholder as a model-initiated continuation", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-roleplay-continuation-rerun-"));
    try {
      const project = WriterProject.init(root, "续演重跑");
      const store = new WriterStore(project);
      const sessionId = store.createSession("续演");
      const continuationId = store.addMessage(sessionId, "user", "<续演>", "roleplay", undefined, "dialogue");
      store.addMessage(sessionId, "assistant", "「那我继续说。」", "roleplay");

      const rerun = store.prepareMessageRerun(sessionId, continuationId);
      assert.equal(rerun.modelInitiatedRoleplay, "continuation");
      assert.equal(rerun.fromId, continuationId);
      assert.equal(rerun.prompt, "<续演>");
      assert.equal(rerun.channel, "roleplay");
      assert.equal(store.messages(sessionId, 20, { channel: "roleplay" }).length, 0);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("conversation archive retrieval", () => {
  test("pages roleplay history from the beginning without mixing agent messages", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-conversation-archive-"));
    try {
      const project = WriterProject.init(root, "archive");
      const store = new WriterStore(project);
      const sessionId = store.createSession("archive");
      store.addMessage(sessionId, "user", "agent-only", "agent");
      store.addMessage(sessionId, "user", "roleplay-one", "roleplay");
      store.addMessage(sessionId, "assistant", "roleplay-two", "roleplay");
      store.addMessage(sessionId, "user", "roleplay-three", "roleplay");
      const args = { project, store, sessionId, emit: () => undefined, context: { permissionMode: "auto" as const } };
      const stats = JSON.parse(handleInspectConversation({ ...args, input: {} })) as { roleplay: number; agent: number };
      assert.equal(stats.roleplay, 3);
      assert.equal(stats.agent, 1);
      const newest = store.conversationMessagesBefore(sessionId, undefined, 2);
      assert.deepEqual(newest.map(message => message.content), ["roleplay-two", "roleplay-three"]);
      const older = store.conversationMessagesBefore(sessionId, newest[0].id, 2);
      assert.deepEqual(older.map(message => message.content), ["agent-only", "roleplay-one"]);
      const first = JSON.parse(handleReadConversation({ ...args, input: { channel: "roleplay", afterId: 0, limit: 2 } })) as { content: string; hasMore: boolean; nextAfterId: number };
      assert.match(first.content, /roleplay-one/);
      assert.match(first.content, /roleplay-two/);
      assert.doesNotMatch(first.content, /agent-only/);
      assert.equal(first.hasMore, true);
      const second = JSON.parse(handleReadConversation({ ...args, input: { channel: "roleplay", afterId: first.nextAfterId, limit: 2 } })) as { content: string; hasMore: boolean };
      assert.match(second.content, /roleplay-three/);
      assert.equal(second.hasMore, false);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
