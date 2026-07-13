import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { emptyCharacter } from "./characters.js";
import { WriterProject } from "./project.js";
import { buildRoleplaySystemPrompt, isRoleplayExitCommand } from "./roleplay.js";
import { WriterStore } from "./store.js";
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
      examples: ["别盯着我看。"],
    },
    psychology: {
      ...base.psychology,
      summary: "外表冷静，内里紧绷",
    },
  };
}

describe("roleplay prompts", () => {
  test("system prompt embeds character voice and experimental rules", () => {
    const prompt = buildRoleplaySystemPrompt(sampleCharacter());
    assert.match(prompt, /角色扮演试演/);
    assert.match(prompt, /林千夏/);
    assert.match(prompt, /简洁、略带吐槽/);
    assert.match(prompt, /不要修改项目文档/);
    assert.match(prompt, /第一人称/);
    assert.match(prompt, /看不到写作 Agent/);
    assert.match(prompt, /未透露姓名的来访者/);
    assert.ok(prompt.includes("\"name\": \"林千夏\"") || prompt.includes("\"name\":\"林千夏\""));
  });

  test("system prompt fixes the generated interlocutor identity without controlling the user", () => {
    const prompt = buildRoleplaySystemPrompt(sampleCharacter(), undefined, {
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
