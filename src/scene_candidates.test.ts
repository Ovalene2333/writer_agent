import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSceneJudgeMessages,
  buildSceneRewriteMessages,
  parseSceneJudgeResult,
  sceneRewriteLengthOk,
} from "./scene_candidates.js";

test("sceneRewriteLengthOk bounds rewrites to a comparable size", () => {
  const original = "字".repeat(1000);
  assert.ok(sceneRewriteLengthOk(original, "字".repeat(900)));
  assert.ok(sceneRewriteLengthOk(original, "字".repeat(1250)));
  assert.ok(!sceneRewriteLengthOk(original, "字".repeat(500)));
  assert.ok(!sceneRewriteLengthOk(original, "字".repeat(1600)));
  assert.ok(!sceneRewriteLengthOk("", "字".repeat(100)));
});

test("buildSceneRewriteMessages carries evidence, brief and original with prose-only contract", () => {
  const messages = buildSceneRewriteMessages({
    styleEvidence: "［范文·《测试》］\n雨落在铁皮屋顶。",
    sceneBrief: "目标：进入矿场；阻力：塌方",
    original: "她推开门，矿灯在头顶晃。",
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /铁皮屋顶/);
  assert.match(messages[0].content, /只输出重写后的正文/);
  assert.match(messages[0].content, /保留原稿的每一个事件/);
  assert.match(messages[0].content, /不追求长短句比例/u);
  assert.doesNotMatch(messages[0].content, /两三件只属于它的实物/u);
  assert.match(messages[1].content, /进入矿场/);
  assert.match(messages[1].content, /她推开门/);
});

test("judge selection parses a choice and rejects out-of-range indices", () => {
  const parsed = parseSceneJudgeResult('{"choice": 1, "reason": "第二稿把决定留给了人物"}', 2);
  assert.equal(parsed.index, 1);
  assert.match(parsed.reason, /留给了人物/u);
  assert.throws(() => parseSceneJudgeResult('{"choice": 2}', 2), /无效序号/u);
  assert.throws(() => parseSceneJudgeResult('{"choice": -1}', 2), /无效序号/u);
  assert.throws(() => parseSceneJudgeResult("没有 JSON", 2), /JSON/u);
});

test("judge prompt asks whether the page is worth turning, and defaults to the original", () => {
  const messages = buildSceneJudgeMessages({ sceneBrief: "目标：确认偏差", candidates: ["原稿正文", "重写正文"] });
  assert.match(messages[0].content, /想不想翻下一页/u);
  assert.match(messages[0].content, /像有自己的目的/u);
  assert.match(messages[0].content, /难分高下，选 0/u);
  // Length and ornament are the two things a naive judge rewards; rule them out.
  assert.match(messages[0].content, /字数更多、辞藻更密、比喻更多都不是优点/u);
  assert.match(messages[1].content, /候选 0·原稿/u);
  assert.match(messages[1].content, /重写正文/u);
});
