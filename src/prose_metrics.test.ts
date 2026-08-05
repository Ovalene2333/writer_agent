import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeChapterProseMetrics,
  chapterMetricsBlockError,
  findAdjacentDuplicateSentences,
  findEchoDialogueParagraphs,
  findRecycledSentences,
  priorChapterNegativeList,
  RECYCLE_ERROR_LIMIT,
  removeAdjacentDuplicateSentences,
  sceneAntiFormulaFeedback,
} from "./prose_metrics.js";

test("findAdjacentDuplicateSentences catches the AA generation bug and ignores rhythmic short repeats", () => {
  const buggy = "她抬起手。能穿透护盾的陶瓷层间隙。能穿透护盾的陶瓷层间隙。她收回手。";
  const found = findAdjacentDuplicateSentences(buggy);
  assert.equal(found.length, 1);
  assert.match(found[0], /陶瓷层间隙/);

  // Intentional rhythm device: short beats stay allowed.
  assert.equal(findAdjacentDuplicateSentences("水滴的声音。一下。一下。一下。").length, 0);
  assert.equal(findAdjacentDuplicateSentences("她推开门，走进院子。院子里没有人。").length, 0);
});

test("removeAdjacentDuplicateSentences drops repeats and leaves everything else byte-identical", () => {
  const fixed = removeAdjacentDuplicateSentences("她沿着走廊走到尽头。她沿着走廊走到尽头。警报没有响。");
  assert.equal(fixed.text, "她沿着走廊走到尽头。警报没有响。");
  assert.deepEqual(fixed.removed, ["她沿着走廊走到尽头。"]);

  // Triple repeats collapse to one.
  assert.equal(
    removeAdjacentDuplicateSentences("能穿透护盾的陶瓷层间隙。能穿透护盾的陶瓷层间隙。能穿透护盾的陶瓷层间隙。").text,
    "能穿透护盾的陶瓷层间隙。",
  );

  // Rhythm device and normal prose stay untouched.
  const rhythm = "水滴的声音。一下。一下。一下。";
  assert.equal(removeAdjacentDuplicateSentences(rhythm).text, rhythm);
  const clean = "她推开门，走进院子。院子里没有人。";
  assert.equal(removeAdjacentDuplicateSentences(clean).text, clean);
});

test("removeAdjacentDuplicateSentences dedupes identical lines in one paragraph but keeps paragraph echoes", () => {
  const lineDup = "警报声贴着墙来回撞。\n警报声贴着墙来回撞。\n她数到第三声。";
  assert.equal(removeAdjacentDuplicateSentences(lineDup).text, "警报声贴着墙来回撞。\n她数到第三声。");

  // Blank-line-separated repeats (intentional echo dialogue) are preserved.
  const echo = "「他们不会回来了。」\n\n「他们不会回来了。」";
  assert.equal(removeAdjacentDuplicateSentences(echo).text, echo);
});

test("findRecycledSentences flags verbatim reuse of full sentences only", () => {
  const prior = "剑格上的状态灯从青到橙到灭。她走向电梯。纳米核心每分钟四十次。";
  const current = "训练结束。剑格上的状态灯从青到橙到灭。她想起昨天的事。她走向电梯。";
  const found = findRecycledSentences(current, prior);
  assert.deepEqual(found, ["剑格上的状态灯从青到橙到灭。"]);
});

test("findEchoDialogueParagraphs counts adjacent identical quoted paragraphs", () => {
  const text = "「到了。」\n\n「到了。」\n\n她跳下车。\n\n「维修舱见。」\n\n「维修舱见。」";
  assert.equal(findEchoDialogueParagraphs(text).length, 2);
});

test("analyzeChapterProseMetrics blocks adjacent duplicates and heavy recycling", () => {
  const prior = Array.from({ length: RECYCLE_ERROR_LIMIT + 2 }, (_, index) =>
    `第${index}号走廊尽头的冷白灯管在轻微地闪烁着。`).join("\n\n");
  const text = `${prior}\n\n她把走廊尽头的灯全部数完了。她把走廊尽头的灯全部数完了。`;
  const metrics = analyzeChapterProseMetrics(text, { priorText: prior });
  const codes = metrics.issues.map(issue => issue.code);
  assert.ok(codes.includes("adjacent_duplicate"));
  assert.ok(codes.includes("verbatim_recycle"));
  const recycle = metrics.issues.find(issue => issue.code === "verbatim_recycle");
  assert.equal(recycle?.severity, "error");
  const blocked = chapterMetricsBlockError(metrics);
  assert.ok(blocked);
  assert.match(blocked, /复读|重合/);
});

test("analyzeChapterProseMetrics blocks dash overload and construction-family density", () => {
  const text = [
    "她看着屏幕——数据在跳——然后停住——像被掐断。",
    "不是伏击。是撤退。",
    "「不是故障。不是延迟。是我取消了指令。」",
    "外面的雨还在下，落在停机坪的边缘，积成一小片反光的水洼。",
  ].join("\n\n");
  const metrics = analyzeChapterProseMetrics(text);
  const codes = metrics.issues.map(issue => issue.code);
  assert.ok(codes.includes("dash_density"));
  assert.ok(codes.includes("contrast_density"));
  assert.ok(metrics.stats.contrastCount >= 2, `dialogue contrast frame must count too, got ${metrics.stats.contrastCount}`);
  const dash = metrics.issues.find(issue => issue.code === "dash_density");
  const contrast = metrics.issues.find(issue => issue.code === "contrast_density");
  assert.equal(dash?.severity, "error");
  assert.ok(dash?.examples.some(example => example.includes("——")));
  assert.equal(contrast?.severity, "error");
  assert.match(chapterMetricsBlockError(metrics) ?? "", /破折号|句式家族/u);
});

test("analyzeChapterProseMetrics reports flat staccato rhythm without numeric hard blocking", () => {
  const text = Array.from({ length: 170 }, (_, index) => `她看灯${index % 7}。`).join("");
  const metrics = analyzeChapterProseMetrics(text);
  const rhythm = metrics.issues.find(issue => issue.code === "rhythm_flat");
  assert.ok(rhythm);
  assert.equal(rhythm?.severity, "warning");
  assert.ok(metrics.stats.meanSentenceLength < 14);
  assert.equal(chapterMetricsBlockError(metrics), undefined);
});

test("analyzeChapterProseMetrics warns on monotone paragraph openings", () => {
  const text = Array.from({ length: 14 }, (_, index) => `千夏走过第${index}道门，检查了门后的通道。`).join("\n\n");
  const metrics = analyzeChapterProseMetrics(text);
  const monotony = metrics.issues.find(issue => issue.code === "opening_monotony");
  assert.ok(monotony);
  assert.match(monotony.message, /千夏/);
});

test("clean varied prose produces no issues", () => {
  const text = [
    "傍晚的风从山谷里上来，带着一点松脂的气味，把晾在绳上的衬衫吹得鼓起来又落下。",
    "老周蹲在灶前添柴。火光映在他脸上，忽明忽暗。",
    "「明天还去吗？」孩子问。",
    "他没有立刻回答，先把一根柴推进去，看着火苗舔上来，才说：「去。答应过你妈的事，总要做完。」",
  ].join("\n\n");
  const metrics = analyzeChapterProseMetrics(text);
  assert.deepEqual(metrics.issues, []);
  assert.equal(chapterMetricsBlockError(metrics), undefined);
});

test("sceneAntiFormulaFeedback reports budgets, banned openings and exhausted motif sentences", () => {
  const scene = [
    "千夏推开舱门。走廊尽头没有人。",
    "千夏看了一眼仪表。脚掌外侧先落地。",
    "千夏收回视线。脚掌外侧先落地。",
    "千夏握住扶手。脚掌外侧先落地。",
  ].join("\n\n");
  const lines = sceneAntiFormulaFeedback({ chapterSoFar: scene });
  assert.ok(lines.length >= 3);
  assert.match(lines[0], /破折号.*否定—改判句式家族.*和X一样/u);
  assert.ok(lines.some(line => line.includes("千夏") && line.includes("段首")));
  assert.ok(lines.some(line => line.includes("脚掌外侧先落地")));
});

test("sceneAntiFormulaFeedback surfaces verbatim overlap with prior prose", () => {
  const prior = "剑格上的状态灯从青到橙到灭。她把手套摘下来放在桌上。";
  const scene = "训练结束了。剑格上的状态灯从青到橙到灭。她转身离开训练区。";
  const lines = sceneAntiFormulaFeedback({ chapterSoFar: scene, priorChapterText: prior });
  assert.ok(lines.some(line => line.includes("逐字重合")));
});

test("priorChapterNegativeList extracts signature sentences and frequent openings", () => {
  const prior = [
    "千夏在六点十五分醒来。纳米核心每分钟四十次。",
    "千夏走进走廊。纳米核心每分钟四十次。",
    "千夏推开门。纳米核心每分钟四十次。",
    "千夏坐下。纳米核心每分钟四十次。",
  ].join("\n\n");
  const lines = priorChapterNegativeList(prior);
  assert.ok(lines.some(line => line.includes("纳米核心每分钟四十次")));
  assert.ok(lines.some(line => line.includes("千夏")));
});
