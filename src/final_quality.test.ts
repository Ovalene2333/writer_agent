import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProseQualityReport, formatQualityReportLines, gradeLabel } from "./final_quality.js";

/** 三层规则计量全都不满意的一段：套话、排比、器官读数、章尾升华、段落一个模子。 */
const WEAK = [
  "他站在窗前，心脏一沉，喉咙发紧，胸口发凉，血液几乎凝固在原地。",
  "他意味深长地看着雨，五味杂陈、若有所思、百感交集，最终还是一言不发。",
  "这场等待既漫长又沉重，还带着一种难以言喻的压抑，让他不由自主地叹气。",
  "雨不仅没有停，而且越下越大，更把整条街都笼罩在灰白之中，毫不犹豫。",
  "他的后背发凉，手心发麻，胃里一沉，几乎站立不稳，脸上却面无表情。",
  "空气里弥漫着难以名状的、沉重的、无形的压力，他不动声色地闭上眼睛。",
  "时间悄无声息地过去，他心照不宣地明白，有些事情已经无可奈何了。",
  "他恍然大悟，又如释重负，随后是一阵漫不经心的、微不足道的疲惫。",
  "窗玻璃上的水痕显而易见，果不其然，和昨天的如出一辙，令人不知所措。",
  "他欲言又止，最终还是嗤之以鼻，像每一个不置可否的傍晚那样沉默着。",
  "他想起很多往事，那些记忆轻描淡写地涌上来，让他百感交集，难以置信。",
  "直到这时他才真正明白，一切都不一样了，从此以后，那些关于意义与救赎的往事将永远留在记忆里。",
].join("\n\n");

/** 同样长度、同样的雨天，写成一个场景。 */
const STRONG = [
  "老陈把碗推过来，碗沿有个豁口，缺口冲着他。",
  "「你吃吧，我不饿。」",
  "「那你早上也没吃啊，昨天晚上剩的那碗还是我倒的。」小周把筷子横在碗上，没动。窗台上那盆薄荷被风吹得直晃，叶子擦着玻璃，沙沙响了半天。他数了数，一共七片新叶，比上周多了两片。",
  "「……行。」",
  "老陈舀了半勺，又放回去。勺子碰到碗沿，响了一声。",
  "「厂里今天来人了，说是月底就停，机器先拉走，人再说。」他说得很慢，像在念别人的信，「你别跟你妈提。」",
  "「她昨天就知道了。」",
  "「谁说的呀？」",
  "「隔壁王婶。她还问我你们是不是要搬，我说不知道，她就一直站在门口没走，站到我把门关上为止。」小周把筷子拿起来又放下。",
  "外面有辆三轮车碾过水坑，泥点甩到玻璃上。",
  "「先吃吧，汤要凉了。」",
  "老陈没接话。他把碗端起来喝了一口，汤已经凉透了，浮着一层白油，喝下去有股铁锈味。他把碗放回桌上，指头在豁口那儿蹭了两下。",
  "「那盆薄荷你搬走的时候记得带上，别落这儿，落这儿就没人浇了。」",
  "小周应了一声。他把那盆薄荷挪到桌角，土有点干，用手指按了按，指腹上沾了一层灰，在裤子上蹭掉了。",
].join("\n\n");

test("三层规则各自的问题都汇总进同一份报告，并标出来源", () => {
  const report = buildProseQualityReport(WEAK);
  const sources = new Set(report.warnings.map(warning => warning.source));
  assert.ok(sources.has("ai_tells"), `expected ai_tells warnings, got ${[...sources].join(",")}`);
  assert.ok(report.warnings.length >= 2, `expected several warnings, got ${report.warnings.length}`);
  assert.equal(report.grade, "weak");
  assert.ok(report.characters > 400);
});

test("生动度与 AI 味是两个方向相反的分数，不能混用", () => {
  const weak = buildProseQualityReport(WEAK);
  const strong = buildProseQualityReport(STRONG);
  assert.ok(strong.vividness.score > weak.vividness.score, `${strong.vividness.score} vs ${weak.vividness.score}`);
  assert.ok(strong.aiTells.score < weak.aiTells.score, `${strong.aiTells.score} vs ${weak.aiTells.score}`);
  assert.notEqual(strong.grade, "weak");
});

test("报告可以直接渲染成文本，供工具结果与 Agent 使用", () => {
  const report = buildProseQualityReport(WEAK);
  const lines = formatQualityReportLines(report);
  assert.ok(lines[0]?.includes(gradeLabel(report.grade)), lines[0]);
  assert.ok(lines[0]?.includes(`${report.characters} 字`), lines[0]);
  assert.equal(lines.length, 3 + report.warnings.length);
  for (const warning of report.warnings) {
    assert.ok(lines.some(line => line.startsWith(`[${warning.source}/${warning.code}]`)), warning.code);
  }
});

test("确定性质量警告持久化完整命中，展示示例仍保持有界", () => {
  const text = Array.from({ length: 9 }, (_, index) =>
    `第${index}段不是停顿，是她重新确认了门后的脚步声。`).join("\n\n");
  const report = buildProseQualityReport(text);
  const contrast = report.warnings.find(warning => warning.code === "contrast_density");
  assert.ok(contrast);
  assert.ok((contrast?.occurrences?.length ?? 0) > contrast!.examples.length);
  assert.equal(contrast?.occurrences?.length, 9);
});

test("低于统计下限的短文只给分数，不编造问题", () => {
  const report = buildProseQualityReport("他走了。门在身后合上。");
  assert.deepEqual(report.warnings, []);
  assert.ok(["good", "fair", "weak"].includes(report.grade));
});

test("对白结构问题进入统一质量报告并保留 dialogue 来源", () => {
  const clippedDialogue = Array.from({ length: 12 }, () => "「知道。」").join("\n\n");
  const report = buildProseQualityReport(clippedDialogue);
  assert.ok(report.warnings.some(warning => (
    warning.source === "dialogue" && warning.code === "dialogue_exchange_compressed"
  )));
  assert.ok(!report.warnings.some(warning => warning.code === "dialogue_clipped"));
  assert.ok(!report.warnings.some(warning => warning.code === "dialogue_monotone"));
});

test("低口语标记只归入对白参考，不与模式风险来源混用", () => {
  const formal = [
    "请把记录留在桌上。",
    "你可以核对附件，但不得删去签名和日期。",
    "门关闭之后程序将自行推进，任何人都无权临时撤回已经登记的异议。",
    "理由已经写明。",
    "责任需要等损失确认以后再行讨论，目前没有提前分配的依据。",
    "确认并不妨碍选择，只是选择必须留下完整的审议过程。",
    "证人尚未到场。",
    "那份文件首先属于提出异议的人，其次才属于保管档案的部门。",
    "程序能够证明手续发生过，却不能替任何人证明决定本身正确。",
    "我不接受这个结论。",
    "会议记录已经封存，后续更改需要两名在场人员共同签署书面说明。",
    "现阶段只能等待正式答复。",
  ].map(line => `「${line}相关材料已经编号封存，后续处理必须保留完整书面记录。」`).join("\n\n");
  const report = buildProseQualityReport(formal);
  assert.ok(report.warnings.some(warning => (
    warning.source === "dialogue" && warning.code === "dialogue_bookish"
  )));
  assert.ok(!report.warnings.some(warning => (
    warning.source === "ai_tells" && warning.code === "dialogue_bookish"
  )));
});

test("gradeLabel covers every grade", () => {
  assert.equal(gradeLabel("good"), "良好");
  assert.equal(gradeLabel("fair"), "尚可");
  assert.equal(gradeLabel("weak"), "偏弱");
});
