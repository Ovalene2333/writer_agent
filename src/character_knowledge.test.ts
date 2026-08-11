import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  applyCharacterKnowledgeChanges,
  characterKnowledgeProjection,
  createCharacterKnowledgeEntity,
  upsertCharacterPresentationPolicy,
  type CharacterKnowledgeBundle,
  type CharacterKnowledgeChange,
} from "./character_knowledge.js";
import { emptyCharacter } from "./characters.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";

function emptyBundle(): CharacterKnowledgeBundle {
  return {
    entity: createCharacterKnowledgeEntity({ id: 1, name: "林岚" }),
    events: [],
    policies: [],
  };
}

test("character knowledge keeps one active psychology model and bounds writing goals by projection", () => {
  const changes: CharacterKnowledgeChange[] = [
    { op: "upsert_record", record: { id: "psych-a", type: "psychological_model", summary: "先求稳", payload: { choiceLogic: "先保全关系" } } },
    { op: "upsert_record", record: { id: "psych-b", type: "psychological_model", summary: "承担风险", payload: { choiceLogic: "关键时刻承担风险" } } },
    ...[1, 2, 3, 4].map(index => ({
      op: "upsert_record" as const,
      record: { id: `goal-${index}`, type: "goal", summary: `目标${index}`, payload: { objective: `目标${index}`, priority: index * 10, status: "active" } },
    })),
    { op: "upsert_record", record: { id: "goal-done", type: "goal", summary: "旧目标", payload: { objective: "旧目标", status: "achieved" } } },
  ];
  const result = applyCharacterKnowledgeChanges(emptyBundle(), changes, new Set([1]));
  const psych = result.bundle.entity.records.filter(record => record.type === "psychological_model");
  assert.equal(psych.filter(record => record.status === "confirmed").length, 1);
  assert.equal(psych.find(record => record.id === "psych-a")?.status, "superseded");
  const writing = characterKnowledgeProjection(result.bundle, "writing", { limit: 20 });
  const writingRecords = writing.records as Array<{ type: string; id: string }>;
  assert.equal(writingRecords.filter(record => record.type === "goal").length, 3);
  const history = characterKnowledgeProjection(result.bundle, "history", { limit: 20 });
  assert.ok((history.records as Array<{ id: string }>).some(record => record.id === "goal-done"));
});

test("expression policy mutation preserves every fact record", () => {
  const facts = applyCharacterKnowledgeChanges(emptyBundle(), [{
    op: "upsert_record",
    record: { id: "appearance-1", type: "appearance_fact", summary: "黑发", payload: { text: "黑发" } },
  }], new Set([1])).bundle;
  const before = JSON.stringify({ entity: facts.entity.records, events: facts.events });
  const revised = upsertCharacterPresentationPolicy(facts, {
    instruction: "不要把卡面方位标签直接写进正文",
    avoid: ["左侧", "右侧"],
    preferredGuidance: "用现场可见的相对位置表达",
  });
  assert.equal(JSON.stringify({ entity: revised.bundle.entity.records, events: revised.bundle.events }), before);
  assert.equal(revised.policy.status, "active");
});

test("store archives v3 authority, writes v4 entities, and keeps simple roleplay cards", () => {
  const root = mkdtempSync(resolve(tmpdir(), "writer-character-knowledge-"));
  try {
    const project = WriterProject.init(root, "角色知识测试");
    project.writeCharacterCardsJsonl(`${JSON.stringify({ ...emptyCharacter("旧角色"), id: 1, updatedAt: new Date().toISOString() })}\n`);
    const store = new WriterStore(project);
    assert.deepEqual(store.characters(), []);
    assert.equal(existsSync(resolve(root, "characters", "characters.v3.backup.jsonl")), true);
    const saved = store.saveCharacter(emptyCharacter("新角色"));
    assert.equal(saved.identity.name, "新角色");
    assert.deepEqual(project.listCharacterKnowledgeEntityIds(), [saved.id]);
    assert.equal(existsSync(resolve(root, "characters", "entities", `char_${saved.id}.json`)), true);
    const simple = store.saveRoleplayInterlocutor({
      name: "试演对话者", identity: "访客", relationship: "初识", knowledge: "未明确", scene: "门口", goal: "询问",
    });
    assert.equal(store.roleplayInterlocutors()[0]?.id, simple.id);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
