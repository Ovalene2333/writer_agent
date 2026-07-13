import assert from "node:assert/strict";
import test from "node:test";
import { createCreativeOutlineBrief, OUTLINE_CHAPTER_FIELDS } from "./creative_outline.js";
import { assertCreativeOutlineDesigned } from "./tools/helpers.js";

test("creative outline brief is distinct and reproducible", () => {
  const input = { premise: "一名法医发现所有死者都记得她的童年", genre: "悬疑", targetChapters: 10, seed: "demo" };
  const first = createCreativeOutlineBrief(input);
  assert.deepEqual(first.routes, createCreativeOutlineBrief(input).routes);
  assert.equal(first.routes.length, 4);
  assert.equal(new Set(first.routes.map(route => route.name)).size, 4);
  assert.equal(first.scorecard.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.match(first.generationPrompt, /因果/);
  assert.match(first.outputContract, /约 10 章/);
});

test("creative outline brief validates and clamps input", () => {
  assert.throws(() => createCreativeOutlineBrief({ premise: "  " }), /不能为空/);
  assert.equal(createCreativeOutlineBrief({ premise: "测试", targetChapters: 999 }).targetChapters, 80);
  assert.equal(createCreativeOutlineBrief({ premise: "测试", targetChapters: 1 }).targetChapters, 3);
});

test("creative outline contract uses OutlineStore field names", () => {
  const brief = createCreativeOutlineBrief({ premise: "测试字段契约", targetChapters: 8, seed: "fields" });
  for (const field of OUTLINE_CHAPTER_FIELDS) {
    assert.match(brief.outputContract, new RegExp(field));
    assert.match(brief.generationPrompt, new RegExp(field));
  }
  assert.match(brief.outputContract, /语义映射/);
  assert.match(brief.outputContract, /禁止使用/);
  assert.equal(brief.scorecard.find(item => item.dimension === "可读性")?.question.includes("前因"), true);
  assert.ok(brief.antiPatterns.some(item => item.includes("未登记字段名")));
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