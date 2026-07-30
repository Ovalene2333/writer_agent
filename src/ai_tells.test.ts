import assert from "node:assert/strict";
import { test } from "node:test";
import { aiTellScore, analyzeAiTells, sceneAiTellFeedback } from "./ai_tells.js";
import { newProseStyleIssues } from "./prose_quality.js";
import { analyzeChapterProseMetrics } from "./prose_metrics.js";

/**
 * The blind spot this module exists for: prose that every earlier gate passes —
 * no dash overload, no verbatim reuse, plenty of sensory detail — but where every
 * character talks the same, the narrator states the theme at the close, and every
 * paragraph comes out of the same mould.
 */
const AI_ISH = [
  "他站在窗前看着外面的雨，心脏一沉，喉咙发紧，胸口发凉，血液几乎凝固在原地。",
  "「我们必须面对这个真相，因为这是我们无法逃避的命运。」他不由自主地开口。",
  "她意味深长地看着他，五味杂陈、若有所思、百感交集，最终还是一言不发。",
  "「我们都知道，人性的本质从来不会因为一句承诺而改变。」她轻描淡写地说。",
  "这场谈话既漫长又沉重，还带着一种难以言喻的压抑，让所有人都不知所措。",
  "「我们所谓的自由，不过是另一种形式的代价罢了。」他毫不犹豫地反驳。",
  "窗外的雨不仅没有停，而且越下越大，更把整条街都笼罩在灰白之中。",
  "「我们的选择决定了我们的存在，这就是活着的意义所在。」她不动声色地补充。",
  "他的太阳穴突突地跳，后背发凉，手心发麻，胃里一沉，几乎站立不稳。",
  "「我们不能否认，正义与救赎之间从来没有清晰的界限。」他若有所思地说。",
  "他们不约而同地沉默了，空气里弥漫着难以名状的、沉重的、无形的压力。",
  "「我们终究要为自己的信念付出代价，这是无可奈何的事情。」她心照不宣地笑。",
  "「我们都在寻找答案，可是这个世界并不打算给出答案。」他嗤之以鼻地回应。",
  "「我们的命运早已被写好，剩下的只是如何走完这段路。」她面无表情地说。",
  "直到这时他才真正明白，一切都不一样了，从此以后，那些关于意义与救赎的往事将永远留在记忆里。",
].join("\n\n");

/** Same length, same subject matter, written the way a person writes it. */
const HUMAN_ISH = [
  "老陈把碗推过来，碗沿有个豁口。",
  "「你吃吧，我不饿。」",
  "「那你早上也没吃啊，还说自己不饿，昨天晚上剩的那碗也是我倒的。」小周把筷子横在碗上，没动。窗台上那盆薄荷被风吹得直晃，叶子擦着玻璃，沙沙响了半天。他数了数，一共七片新叶，比上周多了两片。",
  "「……行。」",
  "老陈舀了半勺，又放回去。",
  "「厂里今天来人了，说是月底就停，机器先拉走，人再说。」他说得很慢，像在念别人的信，「你别跟你妈提。」",
  "「她昨天就知道了。」",
  "「谁说的呀？」",
  "「隔壁王婶。她还问我你们是不是要搬，我说不知道，她就一直站在门口没走，站到我把门关上为止。」小周把筷子拿起来又放下。",
  "外面有辆三轮车碾过水坑。",
  "「先吃吧。」",
  "老陈没接话，他把碗端起来，喝了一口汤，汤已经凉透了，浮着一层白油。他把碗放下的时候，勺子碰到碗沿，发出一声很轻的响。",
  "「那盆薄荷你搬走的时候记得带上，别落这儿，落这儿就没人浇了。」",
  "小周应了一声。他把那盆薄荷挪到桌角，土有点干，他用手指按了按，指腹上沾了一层灰，他在裤子上蹭掉了。",
].join("\n\n");

test("the AI-ish page scores far higher than the human-ish one", () => {
  const ai = aiTellScore(AI_ISH);
  const human = aiTellScore(HUMAN_ISH);
  assert.ok(ai > human + 30, `expected a wide gap, got ai=${ai} human=${human}`);
});

test("每一类生成腔都单独报出来，而不是混成一个总分", () => {
  const codes = analyzeAiTells(AI_ISH).issues.map(issue => issue.code);
  for (const expected of [
    "dialogue_homogeneous",
    "thematic_uplift",
    "philosophical_dialogue",
    "tricolon_stacking",
    "body_emotion_meter",
    "paragraph_uniform",
    "idiom_flood",
  ]) {
    assert.ok(codes.includes(expected as never), `expected ${expected}, got ${codes.join(",")}`);
  }
});

test("human-written dialogue raises nothing", () => {
  const codes = analyzeAiTells(HUMAN_ISH).issues.map(issue => issue.code);
  assert.deepEqual(codes, []);
});

test("这一层测的东西，前面的规则层一个都发现不了", () => {
  // 既有的减分层对这段完全无话可说 —— 这正是本模块存在的理由。
  assert.deepEqual(newProseStyleIssues("", AI_ISH).map(issue => issue.subtype), []);
  assert.deepEqual(analyzeChapterProseMetrics(AI_ISH).issues.map(issue => issue.code), []);
  assert.ok(aiTellScore(AI_ISH) > 40);
});

test("short passages report nothing (statistics are noise below the floor)", () => {
  assert.deepEqual(analyzeAiTells("他走了。").issues, []);
  assert.deepEqual(sceneAiTellFeedback("他走了。"), []);
});

test("scene feedback withholds closing uplift — 章还没写完，收尾还不存在", () => {
  const feedback = sceneAiTellFeedback(AI_ISH).join("\n");
  assert.ok(feedback.includes("AI 味计量"), feedback);
  assert.ok(!feedback.includes("收尾有"), "写作途中不该因为章尾升华提示");
});

test("事件堆叠句被单独计量（AI 网剧旁白腔）", () => {
  const packed = Array.from({ length: 24 }, (_, i) =>
    `他在第${i + 1}号舱看见编组、协议、等级与融合度同时亮起，并且目标身份、伤势、回收优先级以及父亲的指令一边涌进耳机一边压在胸口。`,
  ).join("\n\n");
  const result = analyzeAiTells(packed);
  assert.ok(result.stats.packingRatio > 0.12, `packingRatio=${result.stats.packingRatio}`);
  assert.ok(
    result.issues.some(issue => issue.code === "event_packing"),
    `codes=${result.issues.map(i => i.code).join(",")} packing=${result.stats.packingRatio}`,
  );
});
