import assert from "node:assert/strict";
import test from "node:test";
import { createCreativeOutlineBrief, OUTLINE_CHAPTER_FIELDS } from "./creative_outline.js";
import { assertCreativeOutlineDesigned } from "./tools/helpers.js";

test("creative outline brief grounds claims and keeps the delivered outline compact", () => {
  const input = {
    premise: "一名法医发现所有死者都记得她的童年",
    genre: "悬疑",
    targetChapters: 10,
    constraints: ["凶手不是超自然存在"],
    existingBeats: ["第三章发现旧病历"],
  };
  const brief = createCreativeOutlineBrief(input);
  assert.deepEqual(brief, createCreativeOutlineBrief(input));
  assert.deepEqual(brief.sourceInputs, [
    "故事前提：一名法医发现所有死者都记得她的童年",
    "硬约束：凶手不是超自然存在",
    "既有节拍：第三章发现旧病历",
  ]);
  assert.ok(brief.groundingRules.some(item => item.includes("不要补写")));
  assert.ok(brief.groundingRules.some(item => item.includes("待定")));
  assert.match(brief.outputContract, /约 10 章/);
  assert.match(brief.outputContract, /合计约 50—100 字/);
  assert.match(brief.outputContract, /不展示候选路线、评分、淘汰证据或审计过程/);
  assert.doesNotMatch(brief.generationPrompt, /路线A|路线B|100分|读者、动机审计者/);
});

test("creative outline brief validates, trims and clamps input", () => {
  assert.throws(() => createCreativeOutlineBrief({ premise: "  " }), /不能为空/);
  assert.equal(createCreativeOutlineBrief({ premise: "测试", targetChapters: 999 }).targetChapters, 80);
  assert.equal(createCreativeOutlineBrief({ premise: "测试", targetChapters: 1 }).targetChapters, 3);
  assert.deepEqual(createCreativeOutlineBrief({ premise: "测试", constraints: ["  保留结局  ", ""] }).sourceInputs,
    ["故事前提：测试", "硬约束：保留结局"]);
});

test("creative outline without an explicit chapter count stays a short guide", () => {
  const brief = createCreativeOutlineBrief({ premise: "从第一章开始写一个新故事" });
  assert.equal(brief.targetChapters, undefined);
  assert.match(brief.outputContract, /不要猜测全书规模/);
  assert.match(brief.outputContract, /最多 3 个近期章节卡/);
  assert.doesNotMatch(brief.outputContract, /约 12 章/);
  assert.match(brief.outputContract, /场景链决定/);
});

test("creative outline contract uses OutlineStore field names and makes optional fields optional", () => {
  const brief = createCreativeOutlineBrief({ premise: "测试字段契约", targetChapters: 8 });
  for (const field of OUTLINE_CHAPTER_FIELDS) {
    assert.match(brief.outputContract, new RegExp(field));
    assert.match(brief.generationPrompt, new RegExp(field));
  }
  assert.match(brief.outputContract, /默认只写“摘要、前因、行动、结果、状态变化”五行/);
  assert.match(brief.outputContract, /仅在已有依据或确有管理价值时添加/);
  assert.ok(brief.antiPatterns.some(item => item.includes("机械填满")));
  assert.ok(brief.qualityChecks.some(item => item.includes("前因与结果")));
});

test("assertCreativeOutlineDesigned gates outline paths only when required", () => {
  assert.throws(
    () => assertCreativeOutlineDesigned({ requireCreativeOutlineDesign: true }, "outline/outline.md", "propose_document"),
    /design_creative_outline/,
  );
  assert.doesNotThrow(() =>
    assertCreativeOutlineDesigned({ requireCreativeOutlineDesign: true }, "chapters/ch01.md", "propose_document"));
  assert.doesNotThrow(() =>
    assertCreativeOutlineDesigned({ requireCreativeOutlineDesign: true, creativeOutlineDesigned: true }, "outline/outline.md", "propose_document"));
  assert.doesNotThrow(() =>
    assertCreativeOutlineDesigned({ requireCreativeOutlineDesign: false }, "outline/outline.md", "propose_document"));
  assert.doesNotThrow(() =>
    assertCreativeOutlineDesigned({}, "story/outline.md", "propose_document_patch"));
});
