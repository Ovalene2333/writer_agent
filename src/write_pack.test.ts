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
import { ChapterReviewRequestError } from "./chapter_review.js";
import { documentSpans } from "./document_spans.js";

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

test("side prose uses a multi-scene pipeline with meaningful length targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-side-scene-pipeline-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "支线场景链");
    store = new WriterStore(project);
    const sessionId = store.createSession("展开支线片段");
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      requireWritePack: true,
      requireScenePipeline: true,
      scenePipelineSettings: {
        preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5,
        notesMaxCharacters: 3_000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1,
      },
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, store!, sessionId, () => {}, undefined, context,
    );
    const makeScene = (index: number) => ({
      id: `side-${index}`,
      title: `支线场景 ${index}`,
      goal: `推动支线变化 ${index}`,
      obstacle: `形成直接阻力 ${index}`,
      turn: `产生局面转折 ${index}`,
      outcome: `留下实际结果 ${index}`,
      handoff: index === 3 ? "" : `结果迫使人物进入场景 ${index + 1}`,
      targetCharacters: 2_000,
    });

    const tooFew = JSON.parse(await call("begin_chapter_draft", {
      path: "side/arc-08.md", mode: "create", heading: "ARC-08", chapterGoal: "城邦覆灭",
      scenes: [makeScene(1), makeScene(2)],
    })) as Record<string, unknown>;
    assert.match(String(tooFew.error), /至少需要 3 个/u);

    const missingTarget = JSON.parse(await call("begin_chapter_draft", {
      path: "side/arc-08.md", mode: "create", heading: "ARC-08", chapterGoal: "城邦覆灭",
      scenes: [makeScene(1), { ...makeScene(2), targetCharacters: undefined }, makeScene(3)],
    })) as Record<string, unknown>;
    assert.match(String(missingTarget.error), /targetCharacters/u);

    const begun = JSON.parse(await call("begin_chapter_draft", {
      path: "side/arc-08.md", mode: "create", heading: "ARC-08", chapterGoal: "城邦覆灭",
      scenes: [makeScene(1), makeScene(2), makeScene(3)],
    })) as Record<string, unknown>;
    assert.equal(begun.status, "started");
    assert.equal(begun.sceneCount, 3);
    assert.throws(() => writeChapterScene(
      context.chapterSceneDraft!, "side-1", "她向城门走去。".repeat(30), actualState("她抵达城门"),
    ), /明显低于目标 2000 字/u);

    const bypass = JSON.parse(await call("propose_document", {
      path: "side/arc-08.md", content: "试图绕过场景链。".repeat(30), summary: "支线片段",
    })) as Record<string, unknown>;
    assert.match(String(bypass.error), /不能跳过逐场景/u);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
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
    const evolvingCharacter = activeStore.saveCharacter(emptyCharacter("学员"));
    const chapterReviewUsage: Array<{ model: string; callKind: string }> = [];
    const context: ToolExecutionContext = {
      permissionMode: "ask", requireWritePack: true, requireScenePipeline: true,
      scenePipelineSettings: {
        preferredMinScenes: 1, preferredMaxScenes: 3, maxScenes: 5,
        notesMaxCharacters: 3_000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 1,
      },
      modelUsageReporter: (model, _usage, meta) => {
        chapterReviewUsage.push({ model: model.model, callKind: meta.callKind });
      },
      chapterReviewer: {
        model: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "reviewer-test" },
        fallbackModel: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "writer-test" },
        run: async (model, input) => {
          assert.match(input.content, /^# 第一章/u);
          assert.match(input.content, /门禁灯/u);
          if (model.model === "reviewer-test") {
            throw new ChapterReviewRequestError(
              "终审 JSON 无法解析",
              { promptTokens: 700, completionTokens: 80, cacheHitTokens: 0, cacheMissTokens: 700 },
            );
          }
          return {
            review: {
              verdict: "pass" as const,
              chapterChange: "主角从服从转为违规",
              reviewNotes: "单场章无需接缝；目标与结果一致",
              issues: [],
            },
            usage: { promptTokens: 800, completionTokens: 120, cacheHitTokens: 0, cacheMissTokens: 800 },
          };
        },
      },
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
    assert.match(String(oversizedNotes.error), /3000/);
    context.scenePipelineSettings!.notesMaxCharacters = 4_000;
    const relaxedNotes = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: `## 场景目标\n${"主角继续向前。".repeat(450)}`,
    })) as Record<string, unknown>;
    assert.doesNotMatch(String(relaxedNotes.error), /notes 过长/u);
    assert.match(String(relaxedNotes.error), /content/u);
    context.scenePipelineSettings!.notesMaxCharacters = 3_000;
    const denseStyle = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。\n## 已知事实\n门禁灯会在违规时变红。",
      content: [
        "走廊尽头有动静。不是埋伏。是逃跑。",
        "空气发涩。不是气体。是悬浮颗粒。",
        "地面反光。不是水。是油性液体。",
        "立柱在颤。不是塌方。是预埋装药。",
        "应急门沿着轨道落下，主角侧身挤进最后一道缝隙，鞋底在油膜上拖出半圈亮痕。",
      ].join(""),
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(denseStyle.status, "written");
    assert.equal((denseStyle.styleDeferred as Record<string, unknown>).code, "SCENE_STYLE_DENSE");
    assert.equal(context.chapterSceneDraft?.completed.length, 1);
    // AA repeats are auto-fixed in-tool: the deduped scene enters the draft directly.
    const duplicated = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。",
      content: `${"她沿着走廊走到尽头的门前。".repeat(2)}${Array.from({ length: 10 }, (_, index) =>
        `第${String.fromCharCode(65 + index)}区的警报灯保持沉默。`).join("")}`,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(duplicated.status, "revised");
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
    const inspectedRaw = await call("inspect_chapter_draft", {
      summary: "新建第一章",
      characterChanges: [{
        characterId: evolvingCharacter.id,
        reason: "正文中已经发生的变化",
        changes: [
          {
            op: "upsert_story_state",
            entry: { unanchored: true, label: "违规进入", description: "门禁转红后仍进入训练区" },
          },
          { op: "upsert_relationship", entry: { description: "缺少关系目标，应被隔离" } },
          { op: "add_experience", entry: { label: "越过门禁", description: "在红灯下进入训练区" } },
        ],
      }],
    });
    const inspected = JSON.parse(inspectedRaw) as Record<string, unknown>;
    assert.equal(inspected.status, "proposal_submitted");
    assert.equal(inspected.reviewCompleted, true);
    assert.equal(inspected.proposalSubmitted, true);
    assert.equal(typeof inspected.contentCharacters, "number");
    assert.equal("content" in inspected, false, "isolated review must not append the full chapter to the Agent loop");
    assert.equal((inspected.chapterReview as Record<string, unknown>).verdict, "pass");
    assert.equal((inspected.characterChangeWarnings as string[]).length, 1);
    assert.deepEqual(chapterReviewUsage, [], "single-scene chapters skip the cross-scene model review");
    const proposed = inspected.proposal as Record<string, unknown>;
    assert.equal(proposed.status, "pending");
    const storedProposal = activeStore.proposal(Number(proposed.proposalId));
    assert.equal(storedProposal.characterChanges.length, 1);
    assert.equal(storedProposal.characterChanges[0].changes.length, 2);
    const normalizedState = storedProposal.characterChanges[0].changes.find(change => change.op === "upsert_story_state");
    assert.equal((normalizedState?.entry as Record<string, unknown>).notes, "违规进入：门禁转红后仍进入训练区");
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

test("scene dense gate accepts once with a deferred sentence-level warning", async () => {
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
    assert.equal(first.status, "written");
    assert.equal((first.styleDeferred as Record<string, unknown>).code, "SCENE_STYLE_DENSE");
    assert.equal(context.chapterSceneDraft?.completed.length, 1);
    const inspected = JSON.parse(await call("inspect_chapter_draft", { summary: "新建第一章" })) as Record<string, unknown>;
    assert.equal(inspected.status, "style_revision_required");
    assert.equal(inspected.code, "CHAPTER_DRAFT_STYLE_BLOCKED");
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
      scenePipelineSettings: {
        preferredMinScenes: 1, preferredMaxScenes: 3, maxScenes: 5,
        notesMaxCharacters: 3_000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 2,
      },
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
    })) as { sourceHash: string; occurrences: number; matches: Array<{ startLine: number; endLine: number; context: string }> };
    assert.equal(located.sourceHash.length, 64);
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

    project.writeRaw(path, `${project.read(path)}\n新版本。\n`);
    const stale = JSON.parse(await call("read_document", {
      path, sourceHash: located.sourceHash, block: 1,
    })) as { error?: string };
    assert.match(String(stale.error), /快照已变化/);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("read_document bounds large sections to one snapshot atom", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-bounded-read-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "有界读取");
    store = new WriterStore(project);
    const sessionId = store.createSession("有界读取");
    const path = "lore/world.md";
    project.writeRaw(path, `# 世界观\n\n${Array.from({ length: 120 }, (_, index) => `设定条目${index}：${"细节".repeat(30)}。`).join("\n")}`);
    const result = JSON.parse(await executeTool(
      { id: "bounded", name: "read_document", arguments: JSON.stringify({ path, section: "世界观" }) },
      project, store, sessionId, () => {},
    )) as { sourceHash: string; content: string; truncated: boolean; nextStartLine?: number };
    assert.equal(result.sourceHash.length, 64);
    assert.ok(result.content.length <= 4_000);
    assert.equal(result.truncated, true);
    assert.ok(result.nextStartLine);
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

test("document anchors locate, read and patch one paragraph without a full-document payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-anchor-patch-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "锚点补丁");
    project.writeRaw("lore/world.md", "# 城市\n\n门禁灯由绿变红。\n\n她仍然跨过了门。\n\n远处响起警报。\n");
    store = new WriterStore(project);
    const sessionId = store.createSession("锚点补丁");
    const context: ToolExecutionContext = { permissionMode: "ask", editScope: "point" };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, store!, sessionId, () => {}, undefined, context,
    );
    const located = JSON.parse(await call("locate_document_span", {
      path: "lore/world.md", quote: "她仍然跨过了门。",
    })) as Record<string, unknown>;
    const target = (located.matches as Array<Record<string, unknown>>)[0];
    assert.equal(typeof target.anchorId, "string");
    const read = JSON.parse(await call("read_document_span", {
      path: "lore/world.md", sourceHash: located.sourceHash, anchorId: target.anchorId,
      beforeParagraphs: 1, afterParagraphs: 1,
    })) as Record<string, unknown>;
    assert.match(String(read.content), /门禁灯由绿变红/u);
    assert.ok(String(read.content).length < project.read("lore/world.md").length);
    const otherAnchor = documentSpans(project.read("lore/world.md"), String(located.sourceHash)).at(-1)!;
    const drifted = JSON.parse(await call("read_document_span", {
      path: "lore/world.md", sourceHash: located.sourceHash, anchorId: otherAnchor.anchorId,
    })) as Record<string, unknown>;
    assert.match(String(drifted.error), /目标已锁定/u);
    const targetAnchor = (read.anchors as Array<Record<string, unknown>>).find(anchor => anchor.anchorId === target.anchorId)!;
    const patched = JSON.parse(await call("propose_document_patch", {
      path: "lore/world.md", sourceHash: located.sourceHash, summary: "调整越界动作",
      edits: [{
        anchorId: target.anchorId, spanHash: targetAnchor.spanHash, operation: "replace",
        content: "她在红灯亮起前收住脚，转身贴住墙面。",
      }],
    })) as Record<string, unknown>;
    assert.equal(patched.status, "pending");
    const proposal = store.proposals().find(item => item.id === patched.proposalId)!;
    assert.match(proposal.afterContent, /转身贴住墙面/u);
    assert.doesNotMatch(proposal.afterContent, /她仍然跨过了门/u);
    const blockedInspect = JSON.parse(await call("inspect_document", { path: "lore/world.md" })) as Record<string, unknown>;
    assert.match(String(blockedInspect.error), /局部修改禁止/u);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic locator reranks bounded anchors and whole-document revision stays isolated", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-isolated-revision-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "隔离修订");
    const original = "# 规则\n\n旧称用于北区。\n\n南区也沿用旧称。\n\n结尾仍写旧称。\n";
    project.writeRaw("lore/world.md", original);
    store = new WriterStore(project);
    const sessionId = store.createSession("隔离修订");
    const model = { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "test" };
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      editScope: "document",
      documentLocator: {
        model,
        run: async (_model, input) => ({
          matches: [{ anchorId: input.candidates.at(-1)!.anchorId, confidence: 0.88, reason: "结尾命中" }],
          requestCharacters: 600,
        }),
      },
      documentRevisioner: {
        model,
        run: async (_model, input) => ({ content: input.content.replaceAll("旧称", "新称"), requestCharacters: input.content.length + 200 }),
      },
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, store!, sessionId, () => {}, undefined, context,
    );
    const semantic = JSON.parse(await call("locate_document_span", {
      path: "lore/world.md", query: "最后一次仍未更新名称的位置",
    })) as Record<string, unknown>;
    assert.equal(semantic.mode, "semantic");
    assert.equal((semantic.matches as unknown[]).length, 1);
    const sourceHash = project.hash(project.read("lore/world.md"));
    const revised = JSON.parse(await call("revise_document_isolated", {
      path: "lore/world.md", sourceHash, instruction: "把全文中的旧称统一改成新称", summary: "统一名称",
    })) as Record<string, unknown>;
    assert.equal(revised.status, "pending");
    assert.equal(revised.revisionMode, "isolated_blocks");
    assert.equal("content" in revised, false);
    const proposal = store.proposals().find(item => item.id === revised.proposalId)!;
    assert.doesNotMatch(proposal.afterContent, /旧称/u);
    assert.equal(documentSpans(proposal.afterContent, project.hash(proposal.afterContent)).length, 4);
    assert.equal(store.agentCheckpoint(sessionId)?.stage, "proposal_submitted");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
