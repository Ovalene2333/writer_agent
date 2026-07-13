import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyCharacter, resolveCharacterAt } from "./characters.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import type { Character, OutlineNode } from "./types.js";

test("v2 cards migrate once with deterministic entries and backup", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-character-migrate-"));
  try {
    const project = WriterProject.init(root, "迁移");
    const v2 = { schemaVersion: 2, id: 1, name: "千夏", aliases: ["夏"], narrativeRole: "主角", identity: "调查员", appearance: "红围巾", personality: "谨慎", values: "守诺", speechStyle: "短句", background: "北城长大", longTermGoal: "查清真相", currentGoal: "找到证人", fears: "失去同伴", capabilities: "追踪", limitations: "怕水", relationships: [], notes: "原注释", updatedAt: "2026-01-01T00:00:00.000Z" };
    project.writeCharacterCardsJsonl(`${JSON.stringify(v2)}\n`);
    let store = new WriterStore(project);
    const card = store.characters()[0];
    assert.equal(card.schemaVersion, 3); assert.equal(card.identity.name, "千夏"); assert.equal(card.profile.appearanceSummary, "红围巾");
    assert.equal(card.psychology.summary, "谨慎"); assert.equal(card.motivations[0].id, "goal-1-long-term"); assert.equal(card.updatedAt, v2.updatedAt);
    assert.ok(existsSync(join(project.charactersDir, "characters.v2.backup.jsonl")));
    const first = project.readCharacterCardsJsonl(); store.close();
    store = new WriterStore(project); assert.equal(project.readCharacterCardsJsonl(), first); store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v3 nested updates preserve omitted sections and validate relationships", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-character-save-"));
  try {
    const project = WriterProject.init(root, "读写"); const store = new WriterStore(project);
    const a = emptyCharacter("甲"); const b = emptyCharacter("乙");
    const first = store.saveCharacter({ ...a, extensions: { custom: { 中文: true } } });
    const second = store.saveCharacter(b);
    store.saveCharacter({ id: first.id, motivations: [{ id: "goal-main", category: "current", status: "active", priority: 80, summary: "保护乙", stakes: "失败会分离", obstacles: [], sourceRefs: [] }], relationships: [{ id: "rel-b", characterId: second.id, type: "同盟", attitude: "信任", status: "active", description: "并肩行动", sourceRefs: [] }] });
    const updated = store.saveCharacter({ id: first.id, identity: { ...first.identity, summary: "队长" } });
    assert.equal(updated.motivations.length, 1); assert.equal(updated.relationships.length, 1); assert.deepEqual(updated.extensions, { custom: { 中文: true } });
    const deleted = store.saveCharacter({ id: first.id, deleteEntryIds: { motivations: ["goal-main"] } }); assert.equal(deleted.motivations.length, 0);
    assert.throws(() => store.saveCharacter({ id: first.id, relationships: [{ id: "bad", characterId: 999, type: "敌对", attitude: "", status: "active", description: "", sourceRefs: [] }] }), /目标角色不存在/);
    store.deleteCharacter(second.id); assert.equal(store.characters()[0].relationships.length, 0); store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scene resolver prevents later state and knowledge leaking earlier", () => {
  const base = emptyCharacter("甲");
  const card: Character = { ...base, id: 1, updatedAt: "", motivations: [
    { id: "early-goal", category: "current", status: "active", priority: 50, summary: "出发", stakes: "", obstacles: [], sourceRefs: [], validFrom: "early", validUntil: "middle" },
    { id: "late-goal", category: "current", status: "active", priority: 50, summary: "复仇", stakes: "", obstacles: [], sourceRefs: [], validFrom: "late" },
  ], storyStates: [
    { id: "state-early", outlineNodeId: "early", location: "车站", physical: "健康", emotion: "犹豫", knowledge: [], beliefs: [], intentions: ["登车"], temporaryGoals: [], notes: "", sourceRefs: [] },
    { id: "state-late", outlineNodeId: "late", location: "医院", physical: "受伤", emotion: "愤怒", knowledge: [{ id: "secret", label: "真相", description: "凶手身份", sourceRefs: [] }], beliefs: [], intentions: ["复仇"], temporaryGoals: [], notes: "", sourceRefs: [] },
  ] };
  const nodes = ["early", "middle", "late"].map((id, order) => ({ id, order })) as OutlineNode[];
  const early = resolveCharacterAt(card, nodes, "early"); assert.equal(early.goals[0].id, "early-goal"); assert.equal(early.storyState?.id, "state-early"); assert.equal(JSON.stringify(early).includes("凶手身份"), false);
  const late = resolveCharacterAt(card, nodes, "late"); assert.equal(late.goals[0].id, "late-goal"); assert.equal(late.storyState?.physical, "受伤");
  assert.equal(resolveCharacterAt(card, nodes).storyState, undefined);
});

test("corrupt JSONL reports a visible line diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-character-corrupt-"));
  try { const project = WriterProject.init(root, "损坏"); project.writeCharacterCardsJsonl("{broken}\n"); assert.throws(() => new WriterStore(project), /characters\.jsonl:1/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
