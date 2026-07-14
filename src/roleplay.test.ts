import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { emptyCharacter } from "./characters.js";
import { WriterProject } from "./project.js";
import {
  buildRoleplayChatMessages,
  buildRoleplayStablePrefix,
  buildRoleplaySystemPrompt,
  emptyRoleplaySessionMemory,
  extractAntiFormulaHints,
  formatRoleplayAntiFormulaSlot,
  formatRoleplayMemorySlot,
  formatRoleplaySummarySlot,
  isRoleplayExitCommand,
  ROLEPLAY_RECENT_MESSAGES,
  roleplayPerformerKey,
  roleplaySampling,
  slimRoleplayCharacterViews,
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
      resources: ["秘密资源"], limitations: ["秘密限制"], costs: ["秘密代价"], sourceRefs: [],
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
    assert.match(prompt, /看不到写作 Agent/);
    assert.match(prompt, /"name": "终焉协议"/);
    assert.match(prompt, /"summary": "尚未掌握的禁忌能力"/);
    assert.match(prompt, /"unlocked": false/);
    assert.doesNotMatch(prompt, /未解锁能力的秘密说明|绝密|秘密资源|秘密限制|秘密代价/);
    assert.match(prompt, /未透露姓名的来访者/);
    assert.match(prompt, /实时对手戏，不是问答/);
    assert.match(prompt, /写出潜台词/);
    assert.match(prompt, /不要每轮用问题收尾/);
    assert.match(prompt, /禁止把「动作→对白/);
    assert.match(prompt, /滚动事实摘要/);
    assert.doesNotMatch(prompt, /停顿、目光、呼吸、姿势/);
    assert.ok(prompt.includes("\"name\": \"林千夏\"") || prompt.includes("\"name\":\"林千夏\""));
    assert.match(prompt, /exampleHint/);
    assert.doesNotMatch(prompt, /第二条例句不应整卡注入/);
    // Backward-compatible alias still works.
    assert.equal(buildRoleplaySystemPrompt(sampleCharacter()), prompt);
  });

  test("slim views keep at most one voice example as hint", () => {
    const views = slimRoleplayCharacterViews(sampleCharacter()) as {
      dialogue: { voice: { exampleHint: string; verbalHabits: string[] } };
    };
    assert.equal(views.dialogue.voice.exampleHint, "别盯着我看。");
    assert.deepEqual(views.dialogue.voice.verbalHabits, ["……嗯"]);
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
    assert.match(prompt, /不要替用户决定动作、台词或内心/);
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
    assert.match(messages[1].content, /滚动事实摘要/);
    assert.match(messages[1].content, /训练事故/);
    assert.match(messages[2].content, /现场记忆卡/);
    assert.match(messages[2].content, /已连续 3 轮/);
    assert.match(messages[3].content, /本轮反公式/);
    assert.equal(messages[6].content, "看着我。");
  });

  test("empty summary and memory use stable placeholders", () => {
    assert.equal(formatRoleplaySummarySlot(""), "滚动事实摘要：无。");
    assert.match(formatRoleplayMemorySlot({
      scene: "", proximity: "", mood: "", openThreads: [], promises: [],
      revealed: [], relationshipDelta: "", beat: "", timeInScene: "",
    }), /现场记忆卡：无/);
    assert.match(formatRoleplayAntiFormulaSlot([]), /本轮反公式/);
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
    assert.match(slot, /禁用开场|本轮反公式/);
    assert.match(slot, /不要再用问题收束|问句/);
  });

  test("recent window constant stays short for cache and anti-echo", () => {
    assert.ok(ROLEPLAY_RECENT_MESSAGES <= 20);
    assert.ok(ROLEPLAY_RECENT_MESSAGES >= 8);
  });
});

describe("roleplay memory store", () => {
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

  test("active roleplay survives store reopen and clears on exit", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-active-roleplay-"));
    try {
      const project = WriterProject.init(root, "当前试演");
      let store = new WriterStore(project);
      const character = store.saveCharacter({ identity: emptyCharacter("林千夏").identity });
      const sessionId = store.createSession("试演会话");
      store.saveActiveRoleplay(sessionId, character.id, {
        name: "苏远",
        identity: "基地教官",
        relationship: "林千夏的搭档",
        knowledge: "知道训练安排",
        scene: "医务室",
        goal: "确认她的状态",
      });
      store.close();

      store = new WriterStore(project);
      const restored = store.activeRoleplay(sessionId);
      assert.equal(restored?.performer.id, character.id);
      assert.equal(restored?.performer.name, "林千夏");
      assert.equal(restored?.identity.name, "苏远");
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
