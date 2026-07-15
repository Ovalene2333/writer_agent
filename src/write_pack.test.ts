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
  writeChapterScene,
} from "./scene_pipeline.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { executeTool } from "./tools/execute.js";
import type { ToolExecutionContext } from "./tools/types.js";

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
  assert.match(chapter, /门禁灯/u);
  assert.match(chapter, /警报/u);
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
});

test("chapter scene tools require one write pack per scene and submit only after inspection", async () => {
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
    const premature = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival", content: "门禁灯变红。".repeat(20), actualState: actualState("违规进入"),
    })) as Record<string, unknown>;
    assert.match(String(premature.error), /compile_write_pack/);
    await call("compile_write_pack", {
      sceneId: "arrival", targetPath: "chapters/第一章.md", notes: "## 场景目标\n主角违规进入训练区。",
    });
    const written = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival", content: "门禁灯从绿变红。".repeat(20), actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(written.complete, true);
    const beforeInspect = JSON.parse(await call("propose_chapter_draft", {
      summary: "新建第一章", chapterChange: "关系改变", reviewNotes: "已检查",
    })) as Record<string, unknown>;
    assert.match(String(beforeInspect.error), /inspect_chapter_draft/);
    await call("inspect_chapter_draft", {});
    const proposed = JSON.parse(await call("propose_chapter_draft", {
      summary: "新建第一章", chapterChange: "主角从服从转为违规", reviewNotes: "单场章无需接缝；目标与结果一致",
    })) as Record<string, unknown>;
    assert.equal(proposed.status, "pending");
    assert.equal(project.documentExists("chapters/第一章.md"), false);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
