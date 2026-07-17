import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compileWritePack,
  findProseMetaLeaks,
  formatWritePackForWriter,
  sanitizeDiegeticText,
  sanitizeProseMetaLeaks,
  writePackDraftContractPrompt,
} from "./write_pack.js";
import {
  assembleChapterSceneDraft,
  beginChapterSceneDraft,
  chapterSceneDraftComplete,
  reviseChapterDraftStyle,
  writeChapterScene,
} from "./scene_pipeline.js";
import { emptyCharacter } from "./characters.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { executeTool } from "./tools/execute.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { sceneProseScore } from "./prose_metrics.js";
import { SCENE_CANDIDATE_SKIP_SCORE } from "./scene_candidates.js";

test("sanitizeDiegeticText rewrites 序章 meta into story-world phrasing", () => {
  const { text, stripped } = sanitizeDiegeticText("比序章里预估的还高了零点七。");
  assert.equal(text, "比先前预估的还高了零点七。");
  assert.ok(stripped.some(tag => tag.includes("序章")));
});

test("sanitizeDiegeticText strips path and draft chrome", () => {
  const { text, stripped } = sanitizeDiegeticText(
    "见 chapters/序章.md 与 lore/world.md；写作前草案写明资料已确认。",
    { targetPath: "chapters/第一章.md" },
  );
  assert.doesNotMatch(text, /chapters\/|lore\/|写作前草案|资料已确认/u);
  assert.ok(stripped.length >= 2);
});

test("compileWritePack parses structured draft sections", () => {
  const draft = `## 场景目标
苏醒后听李彦通报指标。

## 人物当下
- 千夏刚恢复意识
- 李彦克制、信息量控得很死

## 事件顺序
1. 通报质量与适应度
2. 千夏对照门缝里那句预估
3. 追问编号

## 已知事实
- 精神适应度预估曾为百分之九十八以上
- 实测百分之九十八点七

## 须自然落地
- 她是第三号

## 勿擅自补写
- 第四号下落

## 声线提醒
- 短句，少解释
`;
  const pack = compileWritePack(draft, { targetPath: "chapters/第一章.md" });
  assert.equal(pack.structured, true);
  assert.match(pack.sceneGoal, /苏醒/);
  assert.equal(pack.beatOrder.length, 3);
  assert.ok(pack.knownFacts.some(item => item.includes("九十八")));
  assert.ok(pack.mustLand.some(item => item.includes("第三号")));
  assert.ok(pack.doNotInvent.some(item => item.includes("第四号")));
});

test("compileWritePack rewrites 序章 inside known facts", () => {
  const draft = `## 已知事实
比序章里预估的还高了零点七。
`;
  const pack = compileWritePack(draft);
  assert.ok(pack.knownFacts.every(item => !item.includes("序章")));
  assert.ok(pack.knownFacts.some(item => item.includes("比先前")));
  assert.ok(pack.strippedMeta.length > 0);
});

test("formatWritePackForWriter does not expose draft chrome or paths", () => {
  const pack = compileWritePack(`## 场景目标
醒来听指标。

## 已知事实
比序章里预估的还高了零点七。
`);
  const formatted = formatWritePackForWriter(pack);
  assert.match(formatted, /本场写作材料/);
  assert.match(formatted, /【本场要完成】/);
  assert.doesNotMatch(formatted, /比序章|写作前草案|chapters\//u);
  assert.doesNotMatch(formatted, /【已成立的事实】[\s\S]*序章/u);
  assert.match(formatted, /比先前/);
});

test("unstructured draft falls back to sanitized narrativeBrief", () => {
  const pack = compileWritePack("自由文本：比序章里预估的还高了零点七。不要写成清单。");
  assert.equal(pack.structured, false);
  assert.match(pack.narrativeBrief, /比先前/);
  assert.doesNotMatch(pack.narrativeBrief, /序章/u);
});

test("writePackDraftContractPrompt forbids chapter labels", () => {
  const prompt = writePackDraftContractPrompt();
  assert.match(prompt, /场景目标/);
  assert.match(prompt, /禁止出现/);
  assert.match(prompt, /序章/);
});

test("sanitizeProseMetaLeaks preserves chapter titles but fixes referential leaks", () => {
  const body = "# 序章\n\n比序章里预估的还高了零点七。\n";
  const { text, stripped } = sanitizeProseMetaLeaks(body);
  assert.match(text, /^# 序章/u);
  assert.match(text, /比先前预估的还高了零点七/u);
  assert.doesNotMatch(text, /比序章/u);
  assert.ok(stripped.length > 0);
  assert.deepEqual(findProseMetaLeaks(text), []);
});

test("findProseMetaLeaks flags residual document referents", () => {
  assert.ok(findProseMetaLeaks("他想起大纲里的安排。").includes("大纲指称"));
  assert.ok(findProseMetaLeaks("见 chapters/foo.md").includes("分区路径"));
});

test("findProseMetaLeaks flags character-card unlock inventory diction", () => {
  const line = "不是「霜烬」，不是「鸣雷」——档案上的专属武装还锁着。";
  const hits = findProseMetaLeaks(line);
  assert.ok(hits.some(tag => tag.includes("档案") || tag.includes("双否定") || tag.includes("卡面") || tag.includes("未解锁") || tag.includes("锁")));
  assert.ok(findProseMetaLeaks(line).length >= 1);
});

const sceneChain = [
  {
    id: "arrival",
    title: "迟到",
    goal: "让主角进入封闭训练区",
    entryState: ["主角相信这只是常规训练"],
    characterIntent: ["主角想尽快证明自己", "教官想观察她是否服从"],
    obstacle: "通行证被临时冻结",
    turn: "冻结命令来自主角父亲",
    outcome: "主角绕过教官独自进入",
    handoff: "违规进入触发警报，把双方送入同一场处置",
  },
  {
    id: "alarm",
    title: "警报",
    goal: "迫使主角在任务与同伴之间选择",
    entryState: ["主角已经违规", "教官必须决定是否上报"],
    characterIntent: ["主角想继续训练", "教官想控制损失"],
    obstacle: "训练靶被警报切换成实弹防卫",
    turn: "教官为保护主角主动承担违规责任",
    outcome: "训练取消，但两人的关系由审视变成秘密共担",
    handoff: "",
    dividerBefore: true,
  },
];

function actualState(label: string) {
  return {
    situation: [label], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
  };
}

test("chapter scene pipeline assembles causal scenes without writing partial documents", () => {
  let draft = beginChapterSceneDraft({
    path: "chapters/第一章.md",
    mode: "create",
    heading: "第一章",
    chapterGoal: "主角与教官从互相审视变成共同隐瞒一次违规",
    baseContent: "",
    baseHash: "empty",
    scenes: sceneChain,
  });
  assert.equal(draft.completed.length, 0);
  draft = writeChapterScene(draft, "arrival", "门禁灯从绿变红。".repeat(20), actualState("主角违规进入训练区")).draft;
  assert.equal(chapterSceneDraftComplete(draft), false);
  draft = writeChapterScene(draft, "alarm", "警报在合金墙间响起。".repeat(20), actualState("教官替主角承担违规责任")).draft;
  assert.equal(chapterSceneDraftComplete(draft), true);
  const chapter = assembleChapterSceneDraft(draft);
  assert.match(chapter, /^# 第一章/u);
  assert.match(chapter, /\n\n---\n\n/u);
  assert.match(chapter, /\n## 迟到\n\n门禁灯/u);
  assert.match(chapter, /---\n\n## 警报\n\n/u);
  assert.match(chapter, /门禁灯/u);
  assert.match(chapter, /警报/u);
  assert.throws(
    () => writeChapterScene(draft, "arrival", `## 自带标题\n\n${"门禁灯从绿变红。".repeat(20)}`, actualState("重写")),
    /markdown 标题/u,
  );
});

test("revising an earlier scene invalidates dependent later scenes", () => {
  let draft = beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变",
    baseContent: "", baseHash: "empty", scenes: sceneChain,
  });
  draft = writeChapterScene(draft, "arrival", "旧版本场景。".repeat(20), actualState("旧变化")).draft;
  draft = writeChapterScene(draft, "alarm", "后续场景。".repeat(20), actualState("后续变化")).draft;
  const revised = writeChapterScene(draft, "arrival", "新版本场景。".repeat(20), actualState("新变化"));
  assert.deepEqual(revised.invalidatedSceneIds, ["alarm"]);
  assert.equal(revised.draft.completed.length, 1);
  assert.equal(revised.draft.inspectedVersion, undefined);
});

test("prose-only chapter draft edits preserve later scenes and state", () => {
  let draft = beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变",
    baseContent: "", baseHash: "empty", scenes: sceneChain,
  });
  draft = writeChapterScene(
    draft,
    "arrival",
    `${"门禁灯从绿变红。".repeat(20)}\n\n她不是害怕。是在计算距离。`,
    actualState("主角违规进入训练区"),
  ).draft;
  draft = writeChapterScene(
    draft,
    "alarm",
    "警报在合金墙间响起。".repeat(20),
    actualState("教官替主角承担违规责任"),
  ).draft;
  const statesBefore = draft.completed.map(scene => scene.actualState);
  const revised = reviseChapterDraftStyle(draft, [{
    search: "她不是害怕。是在计算距离。",
    replace: "她盯着门框，默算两步距离。",
  }]);
  assert.deepEqual(revised.editedSceneIds, ["arrival"]);
  assert.deepEqual(revised.preservedSceneIds, ["alarm"]);
  assert.equal(revised.draft.completed.length, 2);
  assert.deepEqual(revised.draft.completed.map(scene => scene.actualState), statesBefore);
  assert.match(revised.draft.completed[0].content, /默算两步距离/u);
  assert.match(revised.draft.completed[1].content, /警报/u);
  assert.equal(revised.draft.inspectedVersion, undefined);
});

test("scene pipeline rejects empty state change and repeated scene functions", () => {
  const draft = beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变",
    baseContent: "", baseHash: "empty", scenes: sceneChain,
  });
  assert.throws(() => writeChapterScene(draft, "arrival", "只有动作。".repeat(20), {
    situation: [], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
  }), /实际局面变化/);
  assert.throws(() => beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "变化",
    baseContent: "", baseHash: "empty", scenes: [sceneChain[0], {
      ...sceneChain[1], goal: sceneChain[0].goal, turn: sceneChain[0].turn, outcome: sceneChain[0].outcome,
    }],
  }), /完全重复/);
  assert.throws(() => beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "变化",
    baseContent: "", baseHash: "empty",
    scenes: Array.from({ length: 6 }, (_, index) => ({
      ...sceneChain[0],
      id: `scene-${index + 1}`,
      goal: `目标 ${index + 1}`,
      turn: `转折 ${index + 1}`,
      outcome: `结果 ${index + 1}`,
      handoff: index === 5 ? "" : `交给场景 ${index + 2}`,
    })),
  }), /1—5/);

  const expanded = beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "变化",
    baseContent: "", baseHash: "empty", maxScenes: 7,
    scenes: Array.from({ length: 6 }, (_, index) => ({
      ...sceneChain[0],
      id: `expanded-${index + 1}`,
      goal: `扩展目标 ${index + 1}`,
      turn: `扩展转折 ${index + 1}`,
      outcome: `扩展结果 ${index + 1}`,
      handoff: index === 5 ? "" : `交给扩展场景 ${index + 2}`,
    })),
  });
  assert.equal(expanded.scenes.length, 6);
});

test("chapter scene tool compiles notes inline and submits only after inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-scene-pipeline-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "场景流水线");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("逐场写作");
    const context: ToolExecutionContext = {
      permissionMode: "ask", requireWritePack: true, requireScenePipeline: true,
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {}, undefined, context,
    );
    const begun = JSON.parse(await call("begin_chapter_draft", {
      path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变", scenes: [sceneChain[0]],
    })) as Record<string, unknown>;
    assert.equal(begun.status, "started");
    assert.equal(begun.sceneCount, 1);
    assert.equal("scenes" in begun, false, "begin result must not echo the full scene chain");
    // Planning-only steps mid-draft get steered back to write_chapter_scene.
    const todosNudge = JSON.parse(await call("manage_todos", {
      todos: [{ id: "t1", content: "自定义步骤", status: "in_progress" }],
    })) as Record<string, unknown>;
    assert.match(String(todosNudge.message), /write_chapter_scene/);
    const missingNotes = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival", content: "门禁灯变红。".repeat(20), actualState: actualState("违规进入"),
    })) as Record<string, unknown>;
    assert.match(String(missingNotes.error), /notes/);
    const oversizedNotes = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 事件顺序\n主角进入训练区。".repeat(400),
      content: "门禁灯变红。".repeat(20),
      actualState: actualState("违规进入"),
    })) as Record<string, unknown>;
    assert.match(String(oversizedNotes.error), /1500/);
    const denseStyle = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。\n## 已知事实\n门禁灯会在违规时变红。",
      content: [
        "走廊尽头有动静。不是埋伏。是逃跑。",
        "空气发涩。不是气体。是悬浮颗粒。",
        "地面反光。不是水。是油性液体。",
        "立柱在颤。不是塌方。是预埋装药。",
      ].join(""),
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(denseStyle.code, "SCENE_STYLE_DENSE");
    assert.equal(denseStyle.status, "style_revision_required");
    assert.equal(context.chapterSceneDraft?.completed.length, 0);
    // AA repeats are auto-fixed in-tool: the deduped scene enters the draft directly.
    const duplicated = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。",
      content: `${"她沿着走廊走到尽头的门前。".repeat(2)}${Array.from({ length: 10 }, (_, index) =>
        `第${String.fromCharCode(65 + index)}区的警报灯保持沉默。`).join("")}`,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(duplicated.status, "written");
    const autoFixes = duplicated.autoFixes as { duplicateSentencesRemoved: string[] };
    assert.deepEqual(autoFixes.duplicateSentencesRemoved, ["她沿着走廊走到尽头的门前。"]);
    assert.equal(context.chapterSceneDraft?.completed.length, 1);
    assert.ok(!context.chapterSceneDraft?.completed[0].content.includes("她沿着走廊走到尽头的门前。她沿着走廊走到尽头的门前。"));
    // Same sceneId again = structural revision replacing the auto-fixed draft above.
    const sceneContent = `${Array.from({ length: 20 }, (_, index) =>
      `门禁灯第${String.fromCharCode(65 + index)}区从绿变红。`).join("")}\n\n她停下脚步。`;
    const written = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。\n## 已知事实\n门禁灯会在违规时变红。",
      content: sceneContent,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(written.complete, true);
    assert.equal(typeof written.writePackCharacters, "number");
    const auditedDraft = JSON.parse(await call("audit_prose_style", {
      path: "chapters/第一章.md",
    })) as Record<string, unknown>;
    assert.equal(auditedDraft.source, "chapter_draft");
    const draftHashBeforeRevision = auditedDraft.sourceHash;
    const styleRevised = JSON.parse(await call("revise_chapter_draft_style", {
      edits: [{ search: "她停下脚步。", replace: "她在红灯前停步。" }],
    })) as Record<string, unknown>;
    assert.equal(styleRevised.status, "style_revised");
    assert.deepEqual(styleRevised.invalidatedSceneIds, []);
    assert.equal(styleRevised.completedScenes, 1);
    // Inline re-gate: clean prose reports passed so the model skips a probe inspect.
    assert.equal(styleRevised.styleRecheck, "passed");
    assert.equal("styleBlockers" in styleRevised, false);
    const auditedRevisedDraft = JSON.parse(await call("audit_prose_style", {
      path: "chapters/第一章.md",
    })) as Record<string, unknown>;
    assert.equal(auditedRevisedDraft.source, "chapter_draft");
    assert.notEqual(auditedRevisedDraft.sourceHash, draftHashBeforeRevision);
    assert.equal("reused" in auditedRevisedDraft, false);
    const beforeInspect = JSON.parse(await call("propose_chapter_draft", {
      summary: "新建第一章", chapterChange: "关系改变", reviewNotes: "已检查",
    })) as Record<string, unknown>;
    assert.match(String(beforeInspect.error), /inspect_chapter_draft/);
    const inspectedRaw = await call("inspect_chapter_draft", {});
    const inspected = JSON.parse(inspectedRaw) as Record<string, unknown>;
    assert.equal(inspected.status, "inspection_required");
    assert.equal(typeof inspected.contentCharacters, "number");
    // Scene texts no longer live in the agent context; inspect must hand over the
    // assembled chapter exactly once for final review.
    assert.match(String(inspected.content), /^# 第一章/u);
    assert.match(String(inspected.content), /门禁灯/u);
    assert.equal(String(inspected.content).length, inspected.contentCharacters);
    const proposed = JSON.parse(await call("propose_chapter_draft", {
      summary: "新建第一章", chapterChange: "主角从服从转为违规", reviewNotes: "单场章无需接缝；目标与结果一致",
    })) as Record<string, unknown>;
    assert.equal(proposed.status, "pending");
    assert.equal(project.documentExists("chapters/第一章.md"), false);
    assert.equal(context.chapterSceneDraft, undefined);
    assert.equal(context.completedChapterHandoff?.path, "chapters/第一章.md");
    assert.equal(context.completedChapterHandoff?.sceneCount, 1);
    assert.deepEqual(context.completedChapterHandoff?.finalActualState?.situation, ["主角违规进入训练区"]);

    const malformed = JSON.parse(await executeTool(
      { id: "bad-json", name: "inspect_chapter_draft", arguments: "{" },
      project, activeStore, sessionId, () => {}, undefined, context,
    )) as Record<string, unknown>;
    assert.equal(malformed.code, "INVALID_TOOL_ARGUMENTS_JSON");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scene dense gate bounces once then accepts with a deferred style warning", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-scene-dense-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "密度回弹");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("密度回弹");
    const context: ToolExecutionContext = {
      permissionMode: "ask", requireWritePack: true, requireScenePipeline: true,
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {}, undefined, context,
    );
    await call("begin_chapter_draft", {
      path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变", scenes: [sceneChain[0]],
    });
    const dense = [
      "走廊尽头有动静。不是埋伏。是逃跑。",
      "空气发涩。不是气体。是悬浮颗粒。",
      "地面反光。不是水。是油性液体。",
      "立柱在颤。不是塌方。是预埋装药。",
      "警报灯亮着。不是故障。是提醒。",
      "脚步声停了。不是犹豫。是等待。",
    ].join("");
    const first = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。",
      content: dense,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(first.code, "SCENE_STYLE_DENSE");
    assert.equal(context.chapterSceneDraft?.completed.length, 0);
    // Second dense submission of the same scene enters the draft with styleDeferred
    // instead of burning another full-scene regeneration.
    const second = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。",
      content: dense,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(second.status, "written");
    assert.equal((second.styleDeferred as Record<string, unknown>).code, "SCENE_STYLE_DENSE");
    assert.equal(context.chapterSceneDraft?.completed.length, 1);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scene candidate sampling skips clean originals without extra model calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-scene-skip-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "候选跳过");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("候选跳过");
    const context: ToolExecutionContext = {
      permissionMode: "ask", requireWritePack: true, requireScenePipeline: true,
      scenePipelineSettings: { preferredMinScenes: 1, preferredMaxScenes: 3, maxScenes: 5, candidateCount: 2 },
      // Unreachable endpoint: the test fails with skipped=rewrite_error if a rewrite call is ever attempted.
      sceneCandidates: { model: { baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "test" } },
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {}, undefined, context,
    );
    await call("begin_chapter_draft", {
      path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变", scenes: [sceneChain[0]],
    });
    const clean = [
      "傍晚的风从山谷里上来，带着一点松脂的气味，把晾在绳上的衬衫吹得鼓起来又落下。",
      "老周蹲在灶前添柴，火光映在他脸上，忽明忽暗。",
      "「明天还去吗？」孩子问。",
      "他没有立刻回答，先把一根柴推进去，看着火苗舔上来，才说：「去。」",
      "夜里下了点雨，屋檐滴水的声音断断续续，到天亮才停。",
    ].join("\n\n");
    assert.ok(sceneProseScore(clean) >= SCENE_CANDIDATE_SKIP_SCORE, "fixture must score clean");
    const written = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。",
      content: clean,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(written.status, "written");
    const sampling = written.candidateSampling as Record<string, unknown>;
    assert.equal(sampling.skipped, "original_clean");
    assert.equal(sampling.chosen, "original");
    assert.equal(sampling.generated, 0);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("read_document quote locates quoted prose in one call", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-quote-locate-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "定位");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("定位");
    const path = "chapters/第一章.md";
    project.writeRaw(path, ["# 第一章", "", "走廊尽头的灯亮了。", "她停在门口。", "老人的体重数字出现在她脑子里。", "她收回手。", ""].join("\n"));
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {},
    );
    const located = JSON.parse(await call("read_document", {
      path, quote: "老人的体重数字出现在她脑子里。",
    })) as { occurrences: number; matches: Array<{ startLine: number; endLine: number; context: string }> };
    assert.equal(located.occurrences, 1);
    assert.equal(located.matches[0].startLine, 5);
    assert.equal(located.matches[0].endLine, 5);
    assert.match(located.matches[0].context, /她停在门口/);
    assert.match(located.matches[0].context, /她收回手/);
    // Ellipsis-joined quotes fall back to the longest fragment instead of failing.
    const approx = JSON.parse(await call("read_document", {
      path, quote: "走廊尽头的灯亮了。……她收回手。",
    })) as { occurrences: number; matchedFragment?: string; matches: Array<{ startLine: number }> };
    assert.equal(approx.occurrences, 1);
    assert.equal(approx.matchedFragment, "走廊尽头的灯亮了。");
    assert.equal(approx.matches[0].startLine, 3);
    const missing = JSON.parse(await call("read_document", {
      path, quote: "文中不存在的一句话",
    })) as { occurrences: number; hint?: string };
    assert.equal(missing.occurrences, 0);
    assert.match(String(missing.hint), /缩短|search_project/);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("light chapter patch bypasses pipeline gates; heavy patch stays blocked", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-light-patch-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "小修");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("小修");
    const path = "chapters/第一章.md";
    project.writeRaw(path, "# 第一章\n\n她伸出手。老人的体重数字出现在她脑子里。她收回手。\n");
    const context: ToolExecutionContext = {
      permissionMode: "ask", requireWritePack: true, requireScenePipeline: true,
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {}, undefined, context,
    );
    // Sentence-level fix goes straight to a proposal without begin_chapter_draft/compile_write_pack.
    const light = JSON.parse(await call("propose_document_patch", {
      path,
      edits: [{ search: "老人的体重数字出现在她脑子里。", replace: "她凭手上传来的分量估出老人很轻。" }],
      summary: "修正OOC描写",
    })) as Record<string, unknown>;
    assert.equal(light.status, "pending");
    assert.equal(light.edits, 1);
    // A patch large enough to rewrite prose wholesale keeps the pipeline contract.
    const heavy = JSON.parse(await call("propose_document_patch", {
      path,
      edits: [{ search: "她收回手。", replace: "长句替换。".repeat(400) }],
      summary: "大改",
    })) as Record<string, unknown>;
    assert.match(String(heavy.error), /场景|流水线/);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposal characterChanges validate ops at propose time and accept synonyms", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-proposal-charops-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "演进校验");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("演进校验");
    const card = activeStore.saveCharacter(emptyCharacter("甲"));
    const path = "chapters/第一章.md";
    project.writeRaw(path, "# 第一章\n\n她伸出手。她收回手。\n");
    const context: ToolExecutionContext = { permissionMode: "ask" };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {}, undefined, context,
    );
    // Unknown op fails at propose time with the valid-op hint, not silently at accept time.
    const bad = JSON.parse(await call("propose_document_patch", {
      path,
      edits: [{ search: "她收回手。", replace: "她缓缓收回手。" }],
      summary: "小修",
      characterChanges: [{ characterId: card.id, reason: "确认经历", changes: [{ op: "add", label: "x" }] }],
    })) as Record<string, unknown>;
    assert.match(String(bad.error), /op 无效/);
    assert.match(String(bad.error), /可用 op/);
    // Common synonyms (append_/add_/update_*) are normalized and go through.
    const ok = JSON.parse(await call("propose_document_patch", {
      path,
      edits: [{ search: "她收回手。", replace: "她缓缓收回手。" }],
      summary: "小修",
      characterChanges: [{ characterId: card.id, reason: "确认经历", changes: [{ op: "append_experience", label: "初次外勤", description: "桥上协同" }] }],
    })) as Record<string, unknown>;
    assert.equal(ok.status, "pending");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
