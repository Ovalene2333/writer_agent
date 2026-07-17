import test from "node:test";
import assert from "node:assert/strict";
import { buildSceneRewriteMessages, pickBestSceneCandidate, sceneRewriteLengthOk } from "./scene_candidates.js";
import { sceneProseScore } from "./prose_metrics.js";

const MANNERED = [
  "走廊。冷白灯。电梯。按钮。等待。",
  "她停下。心率——四十二次。然后是四十四次。然后是四十八次。",
  "不是紧张。是准备。她看了一眼门。不是在看门。是在听。",
  "手套是黑的——纳米纤维混编——比训练服紧。和每天一样。和半年前一样。和睡着时一样。",
  "灯闪了一下。一下。一下。她数着。三十七分贝。零点三秒。百分之四十。",
].join("\n\n");

const VARIED = [
  "傍晚的风从山谷里上来，带着一点松脂的气味，把晾在绳上的衬衫吹得鼓起来又落下，像有人在很远的地方缓慢地挥手。",
  "老周蹲在灶前添柴，火光映在他脸上，忽明忽暗。",
  "「明天还去吗？」孩子问。",
  "他没有立刻回答，先把一根柴推进去，看着火苗舔上来，才说：「去。答应过你妈的事，总要做完。」",
  "夜里下了点雨，屋檐滴水的声音断断续续，到天亮才停。",
].join("\n\n");

test("sceneProseScore ranks varied prose above mannered staccato prose", () => {
  const mannered = sceneProseScore(MANNERED);
  const varied = sceneProseScore(VARIED);
  assert.ok(varied > mannered, `expected varied (${varied}) > mannered (${mannered})`);
});

test("pickBestSceneCandidate keeps the original on ties and picks strictly better rewrites", () => {
  const same = pickBestSceneCandidate([VARIED, VARIED]);
  assert.equal(same.index, 0, "identical scores must keep the original");
  const improved = pickBestSceneCandidate([MANNERED, VARIED]);
  assert.equal(improved.index, 1);
  assert.equal(improved.scores.length, 2);
});

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
  assert.match(messages[1].content, /进入矿场/);
  assert.match(messages[1].content, /她推开门/);
});
