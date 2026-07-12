import test from "node:test";
import assert from "node:assert/strict";
import { contrastStyleError, contrastStyleReport } from "./prose_quality.js";

test("detects classic 不是……而是…… constructions", () => {
  const report = contrastStyleReport("这不是失败，而是另一种成功。");
  assert.equal(report.frameCount, 1);
  assert.ok(report.examples.some((item) => item.includes("不是") && item.includes("而是")));
});

test("detects lighter 不是……是…… evasions", () => {
  const samples = [
    "这不是失败，是另一种成功。",
    "不是我不想帮你，是我帮不了。",
    "他并非生气，是失望。",
    "这并不是愤怒，是恐惧。",
  ];
  for (const sample of samples) {
    const report = contrastStyleReport(sample);
    assert.equal(report.frameCount, 1, `should detect: ${sample}`);
  }
});

test("detects general mid-sentence explanatory em-dashes", () => {
  const samples = [
    "他的视线落在门缝里——夹着一张对折的纸条。",
    "黄叶从枝头脱落的时候，好像犹豫了一下——在空中顿了顿，才往下坠。",
    "母亲很少说话，只是不停地做事——扫地、洗衣、做饭。",
    "那张试卷用红笔改过——日期是昨天。",
    "他丹田中的灵气只有薄薄一层——炼气三层，外门倒数第一。",
    "他停住——不是害怕，是在等。",
    "那声音——更像是叹息。",
  ];
  for (const sample of samples) {
    const report = contrastStyleReport(sample);
    assert.ok(report.dashCount >= 1, `should detect dash: ${sample}`);
    assert.ok(contrastStyleError(sample), `should reject: ${sample}`);
  }
});

test("allows dialogue cut-off and line-trailing dramatic pause", () => {
  const okSamples = [
    "「我不是——」她把话咽了回去。",
    "\"第三——\"\n她打断了他。",
    "周老师已经退休三年了。而且——\n他推开虚掩的门。",
    "【叮——万界最强系统已激活】",
  ];
  for (const sample of okSamples) {
    const report = contrastStyleReport(sample);
    assert.equal(report.dashCount, 0, `should allow: ${sample}`);
    assert.equal(contrastStyleError(sample), undefined, `should not reject: ${sample}`);
  }
});

test("does not double-count ——不是……是…… as separate frame and dash", () => {
  const report = contrastStyleReport("他笑了——不是嘲讽，是释然。");
  // One structural dash aside; frame may overlap and merge out of total examples.
  assert.equal(report.dashCount, 1);
  assert.ok(report.count >= 1);
  assert.ok(report.count <= 2);
});

test("does not count cross-sentence 不是。是 as a single contrast frame", () => {
  const report = contrastStyleReport("他不是坏人。他是个逃兵。");
  assert.equal(report.frameCount, 0);
});

test("short text allows zero formulaic contrasts and dashes", () => {
  const text = "这不是妥协，是策略。他转身离开。";
  const report = contrastStyleReport(text);
  assert.equal(report.dashAllowed, 0);
  assert.ok(contrastStyleError(text));
});

test("density limit rejects repeated dash asides", () => {
  const dense = [
    "他看着门缝——里面有光。",
    "纸张还新——不像塞了很久。",
    "灯还亮着——桌上摊着试卷。",
  ].join("");
  const report = contrastStyleReport(dense);
  assert.ok(report.dashCount >= 3);
  assert.ok(report.dashCount > report.dashAllowed);
  assert.ok(contrastStyleError(dense));
});

test("density limit rejects repeated contrast frames", () => {
  const dense = Array(4).fill("这不是妥协，而是策略。他转身离开。").join("");
  const report = contrastStyleReport(dense);
  assert.ok(report.frameCount >= 4);
  assert.ok(contrastStyleError(dense));
});
