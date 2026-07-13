import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptyCharacter } from "./characters.js";
import { buildRoleplaySystemPrompt, isRoleplayExitCommand } from "./roleplay.js";
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
    assert.ok(prompt.includes("\"name\": \"林千夏\"") || prompt.includes("\"name\":\"林千夏\""));
  });

  test("exit command detection accepts common variants", () => {
    assert.equal(isRoleplayExitCommand("/roleplay off"), true);
    assert.equal(isRoleplayExitCommand("/rp exit"), true);
    assert.equal(isRoleplayExitCommand("扮演 退出"), true);
    assert.equal(isRoleplayExitCommand("你好"), false);
    assert.equal(isRoleplayExitCommand("/roleplay 林千夏"), false);
  });
});
