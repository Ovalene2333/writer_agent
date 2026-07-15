import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyCharacterChanges,
  applyCharacterInput,
  competenciesWritingPayload,
  competencyPromptView,
  emptyCharacter,
  normalizeV3Character,
  resolveCharacterAt,
  upsertById,
} from "./characters.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import type { Character, OutlineNode } from "./types.js";

test("competency unlock state is normalized and defaults to locked", () => {
  const base = emptyCharacter("Tester");
  const locked = normalizeV3Character({
    ...base,
    id: 1,
    updatedAt: "",
    competencies: [{
      id: "skill-locked", name: "Locked", summary: "Public hint", level: "", description: "Secret detail",
      resources: [], limitations: [], costs: [], sourceRefs: [],
    }],
  });
  const unlocked = normalizeV3Character({
    ...base,
    id: 1,
    updatedAt: "",
    competencies: [{
      id: "skill-unlocked", name: "Unlocked", summary: "Public hint", level: "", unlocked: true, description: "Full detail",
      resources: [], limitations: [], costs: [], sourceRefs: [],
    }],
  });
  assert.equal(locked.competencies[0].unlocked, false);
  assert.equal(unlocked.competencies[0].unlocked, true);
  assert.deepEqual(competencyPromptView(locked.competencies[0]), { name: "Locked", summary: "Public hint", unlocked: false });
  assert.deepEqual(competencyPromptView(unlocked.competencies[0]), unlocked.competencies[0]);
});

test("competenciesWritingPayload splits inPlay without unlocked:false flags", () => {
  const comps = [
    {
      id: "a", name: "可用", summary: "s", level: "", unlocked: true, description: "d",
      resources: [] as string[], limitations: [] as string[], costs: [] as string[], sourceRefs: [] as [],
    },
    {
      id: "b", name: "专属武装——「霜烬」", summary: "剑", level: "", unlocked: false, description: "secret",
      resources: [] as string[], limitations: [] as string[], costs: [] as string[], sourceRefs: [] as [],
    },
  ];
  const payload = competenciesWritingPayload(comps);
  assert.equal(payload.inPlay.length, 1);
  assert.equal(payload.inPlay[0].name, "可用");
  assert.equal(payload.notInPlay.length, 1);
  assert.equal(payload.notInPlay[0].name, "专属武装——「霜烬」");
  assert.equal("unlocked" in payload.notInPlay[0], false);
  assert.match(payload.rule, /还锁着|未解锁/);
});

test("experiences default to empty and normalize from partial cards", () => {
  const base = emptyCharacter("Tester");
  assert.deepEqual(base.experiences, []);
  const card = normalizeV3Character({
    ...base,
    id: 1,
    updatedAt: "",
    // omit experiences
    experiences: undefined,
  });
  assert.deepEqual(card.experiences, []);
  const withExp = normalizeV3Character({
    ...base,
    id: 1,
    updatedAt: "",
    experiences: [{ id: "exp-1", label: "觉醒", description: "获得灵视", sourceRefs: [] }],
  });
  assert.equal(withExp.experiences[0].label, "觉醒");
});

test("upsertById merges without dropping other entries", () => {
  const base = [
    { id: "a", value: 1 },
    { id: "b", value: 2 },
  ];
  const merged = upsertById(base, [{ id: "b", value: 9 }, { id: "c", value: 3 }]);
  assert.deepEqual(merged, [
    { id: "a", value: 1 },
    { id: "b", value: 9 },
    { id: "c", value: 3 },
  ]);
});

test("saveCharacter upserts arrays and supports replaceSections", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-character-upsert-"));
  try {
    const project = WriterProject.init(root, "upsert");
    const store = new WriterStore(project);
    const card = store.saveCharacter({
      ...emptyCharacter("甲"),
      competencies: [
        { id: "c1", name: "追踪", summary: "尾随", level: "", unlocked: false, description: "d1", resources: [], limitations: [], costs: [], sourceRefs: [] },
        { id: "c2", name: "格斗", summary: "近战", level: "", unlocked: false, description: "d2", resources: [], limitations: [], costs: [], sourceRefs: [] },
      ],
      psychology: {
        summary: "谨慎",
        traits: [{ id: "t1", label: "谨慎", description: "先观察", sourceRefs: [] }],
        values: [],
        fears: [],
        conflicts: [],
      },
    });
    const patched = store.saveCharacter({
      id: card.id,
      competencies: [
        { id: "c1", name: "追踪", summary: "尾随", level: "中", unlocked: true, description: "d1+", resources: [], limitations: [], costs: [], sourceRefs: [] },
      ],
      psychology: {
        summary: "谨慎但更狠",
        traits: [{ id: "t2", label: "狠厉", description: "下手不留情", sourceRefs: [] }],
      },
    });
    assert.equal(patched.competencies.length, 2);
    assert.equal(patched.competencies.find(x => x.id === "c1")?.unlocked, true);
    assert.equal(patched.competencies.find(x => x.id === "c2")?.name, "格斗");
    assert.equal(patched.psychology.traits.length, 2);
    assert.equal(patched.psychology.summary, "谨慎但更狠");

    const replaced = store.saveCharacter({
      id: card.id,
      competencies: [
        { id: "c3", name: "新技能", summary: "新", level: "", unlocked: false, description: "x", resources: [], limitations: [], costs: [], sourceRefs: [] },
      ],
      replaceSections: ["competencies"],
    });
    assert.equal(replaced.competencies.length, 1);
    assert.equal(replaced.competencies[0].id, "c3");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCharacterChanges unlocks, adds experience, and updates personality", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-character-apply-"));
  try {
    const project = WriterProject.init(root, "演进");
    const store = new WriterStore(project);
    const card = store.saveCharacter({
      ...emptyCharacter("乙"),
      competencies: [
        { id: "spirit-sight", name: "灵视", summary: "看见灵体", level: "", unlocked: false, description: "详细机制", resources: [], limitations: [], costs: [], sourceRefs: [] },
      ],
      psychology: {
        summary: "怯懦",
        traits: [{ id: "trait-shy", label: "怯懦", description: "怕事", sourceRefs: [] }],
        values: [],
        fears: [],
        conflicts: [],
      },
    });
    const result = store.applyCharacterChanges(card.id, {
      reason: "第3章确认觉醒灵视",
      sourceRef: { type: "document", ref: "chapters/第3章.md" },
      changes: [
        { op: "set_unlocked", competencyId: "spirit-sight", unlocked: true },
        { op: "add_experience", id: "exp-awaken", label: "灵视觉醒", description: "在废墟中首次看清灵体" },
        { op: "set_psychology_summary", summary: "外表冷静，内里仍紧绷" },
        { op: "upsert_psychology_entry", group: "traits", entry: { id: "trait-resolute", label: "决断", description: "关键时不再退缩" } },
        { op: "unknown_op", foo: 1 },
      ],
    });
    assert.ok(result.applied.length >= 4);
    assert.equal(result.skipped.some(x => x.op === "unknown_op"), true);
    assert.equal(result.character.competencies[0].unlocked, true);
    assert.equal(result.character.competencies[0].sourceRefs.some(x => x.ref === "chapters/第3章.md"), true);
    assert.equal(result.character.experiences.length, 1);
    assert.equal(result.character.experiences[0].label, "灵视觉醒");
    assert.equal(result.character.psychology.summary, "外表冷静，内里仍紧绷");
    assert.equal(result.character.psychology.traits.length, 2);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyCharacterInput pure merge preserves experience history", () => {
  const base = normalizeV3Character({
    ...emptyCharacter("丙"),
    id: 1,
    updatedAt: "",
    experiences: [{ id: "e1", label: "旧伤", description: "童年事故", sourceRefs: [] }],
  });
  const next = applyCharacterInput(base, {
    experiences: [{ id: "e2", label: "新伤", description: "战场", sourceRefs: [] }],
  });
  assert.equal(next.experiences.length, 2);
  const cleared = applyCharacterInput(next, { deleteEntryIds: { experiences: ["e1"] } });
  assert.equal(cleared.experiences.length, 1);
  assert.equal(cleared.experiences[0].id, "e2");
});

test("applyCharacterChanges requires reason and at least one change", () => {
  const base = normalizeV3Character({ ...emptyCharacter("丁"), id: 1, updatedAt: "" });
  assert.throws(() => applyCharacterChanges(base, { reason: "", changes: [{ op: "set_psychology_summary", summary: "x" }] }), /reason/);
  assert.throws(() => applyCharacterChanges(base, { reason: "ok", changes: [] }), /changes/);
});

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
    assert.deepEqual(card.experiences, []);
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
  ], experiences: [
    { id: "exp-early", label: "出发", description: "登车", sourceRefs: [], validFrom: "early" },
    { id: "exp-late", label: "真相", description: "得知凶手", sourceRefs: [], validFrom: "late" },
  ], storyStates: [
    { id: "state-early", outlineNodeId: "early", location: "车站", physical: "健康", emotion: "犹豫", knowledge: [], beliefs: [], intentions: ["登车"], temporaryGoals: [], notes: "", sourceRefs: [] },
    { id: "state-late", outlineNodeId: "late", location: "医院", physical: "受伤", emotion: "愤怒", knowledge: [{ id: "secret", label: "真相", description: "凶手身份", sourceRefs: [] }], beliefs: [], intentions: ["复仇"], temporaryGoals: [], notes: "", sourceRefs: [] },
  ] };
  const nodes = ["early", "middle", "late"].map((id, order) => ({ id, order })) as OutlineNode[];
  const early = resolveCharacterAt(card, nodes, "early"); assert.equal(early.goals[0].id, "early-goal"); assert.equal(early.storyState?.id, "state-early"); assert.equal(JSON.stringify(early).includes("凶手身份"), false);
  assert.equal(early.experiences.some(x => x.id === "exp-late"), false);
  assert.equal(early.experiences.some(x => x.id === "exp-early"), true);
  const late = resolveCharacterAt(card, nodes, "late"); assert.equal(late.goals[0].id, "late-goal"); assert.equal(late.storyState?.physical, "受伤");
  assert.equal(late.experiences.some(x => x.id === "exp-late"), true);
  assert.equal(resolveCharacterAt(card, nodes).storyState, undefined);
});

test("corrupt JSONL reports a visible line diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-character-corrupt-"));
  try { const project = WriterProject.init(root, "损坏"); project.writeCharacterCardsJsonl("{broken}\n"); assert.throws(() => new WriterStore(project), /characters\.jsonl:1/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("proposal approval applies deferred ability unlock and undo keeps it atomic", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-character-proposal-"));
  try {
    const project = WriterProject.init(root, "渐进解锁");
    const store = new WriterStore(project);
    const character = store.saveCharacter({
      ...emptyCharacter("闻溪"),
      competencies: [{
        id: "spirit-sight", name: "灵视", summary: "偶尔看见异常轮廓", level: "初阶", unlocked: false,
        description: "能够稳定辨认灵体", resources: [], limitations: [], costs: [], sourceRefs: [],
      }],
    });
    const sessionId = store.createSession("能力解锁");
    const change = [{
      characterId: character.id,
      reason: "正文中付出代价后首次稳定辨认灵体",
      changes: [{ op: "set_unlocked", competencyId: "spirit-sight", unlocked: true }],
    }];

    const rejected = store.createProposal(sessionId, "chapters/弃案.md", "未采用的版本", "候选场景", change);
    assert.equal(store.characters()[0].competencies[0].unlocked, false);
    store.rejectProposal(rejected.id);
    assert.equal(store.characters()[0].competencies[0].unlocked, false);

    const proposal = store.createProposal(sessionId, "chapters/觉醒.md", "她终于看清了门后的影子。", "完成灵视觉醒场景", change);
    assert.equal(store.characters()[0].competencies[0].unlocked, false);
    store.acceptProposal(proposal.id);
    let competency = store.characters()[0].competencies[0];
    assert.equal(competency.unlocked, true);
    assert.ok(competency.sourceRefs.some(ref => ref.type === "document" && ref.ref === "chapters/觉醒.md"));

    store.undo(sessionId);
    assert.equal(store.characters()[0].competencies[0].unlocked, false);
    assert.equal(project.documentExists("chapters/觉醒.md"), false);
    store.redo(sessionId);
    competency = store.characters()[0].competencies[0];
    assert.equal(competency.unlocked, true);
    assert.equal(project.documentExists("chapters/觉醒.md"), true);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
