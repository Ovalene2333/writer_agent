import assert from "node:assert/strict";
import test from "node:test";
import { createCreativeOutlineBrief } from "./creative_outline.js";

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
