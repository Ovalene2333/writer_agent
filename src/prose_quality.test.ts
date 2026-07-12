import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeProseStyle,
  contrastStyleError,
  contrastStyleReport,
  newProseStyleIssues,
  proseStyleIssuesError,
} from "./prose_quality.js";

test("classifies speech extension, interruption and hesitation without warnings", () => {
  const samples = [
    ["「不——要过来！」", "speech_extension"],
    ["「我——我不知道。」", "speech_hesitation"],
    ["「班长他牺——」小马哭了。", "speech_interruption"],
    ["“呜——”火车开动了。", "speech_interruption"],
  ] as const;
  for (const [text, subtype] of samples) {
    const issues = analyzeProseStyle(text);
    assert.ok(issues.some(issue => issue.subtype === subtype), text);
    assert.equal(issues.some(issue => issue.severity !== "info"), false, text);
    assert.equal(contrastStyleError(text), undefined, text);
  }
});

test("classifies metadata and system sound without warnings", () => {
  for (const text of ["【叮——系统已激活】", "——《远方》", "## 第一章——归来", "2024--2026"]) {
    const issues = analyzeProseStyle(text);
    assert.equal(issues.some(issue => issue.severity !== "info"), false, text);
  }
});

test("narrative pause-reveal dashes are allowed and do not block proposals", () => {
  const text = "他推开门。\n视线停在门缝里——里面夹着一张纸条。";
  const issue = analyzeProseStyle(text).find(item => item.kind === "dash");
  assert.ok(issue);
  assert.equal(issue.severity, "info");
  assert.equal(contrastStyleError(text), undefined);
  assert.equal(proseStyleIssuesError(analyzeProseStyle(text)), undefined);
});

test("a few explanatory dashes stay warnings and do not hard-fail", () => {
  const text = "他没有回头——因为身后已经无人。她也停住——因为门一直开着。";
  const issues = analyzeProseStyle(text).filter(issue => issue.kind === "dash");
  assert.equal(issues.length, 2);
  assert.ok(issues.every(issue => issue.severity === "warning"));
  assert.equal(contrastStyleError(text), undefined);
  assert.equal(proseStyleIssuesError(issues), undefined);
});

test("allows one occurrence in short text as a non-blocking advisory", () => {
  const text = "桌上只剩一样东西——一把钥匙。";
  const report = contrastStyleReport(text);
  // 同位/命名类破折号计为 info，不再计入 dashCount
  assert.ok(report.dashCount <= 1);
  assert.equal(contrastStyleError(text), undefined);
});

test("distinguishes dialogue correction from narrator abstract reframing", () => {
  const dialogue = analyzeProseStyle("「不是老周，是他儿子。」");
  assert.ok(dialogue.some(issue => issue.subtype === "dialogue_correction" && issue.severity === "info"));

  const narrationText = "这不是愤怒，而是一种更深的恐惧。";
  const narration = analyzeProseStyle(narrationText);
  assert.ok(narration.some(issue => issue.subtype === "abstract_reframing" && issue.severity === "warning"));
  assert.equal(contrastStyleError(narrationText), undefined);
});

test("does not join cross-sentence contrast fragments", () => {
  assert.equal(contrastStyleReport("他不是坏人。他是个逃兵。").frameCount, 0);
});

test("reports only newly introduced issues for patches", () => {
  const before = "他停住——因为门外有声音。\n她转身离开。";
  const after = "他停住——因为门外有声音。\n她没有追——因为早已知道答案。";
  const added = newProseStyleIssues(before, after).filter(issue => issue.severity !== "info");
  assert.equal(added.length, 1);
  assert.ok(added[0].sentence.includes("她没有追"));
  // 单处新增说明式破折号不拦截提案
  assert.equal(proseStyleIssuesError(added), undefined);
});

test("paired dashes are reported as one parenthetical issue without hard fail", () => {
  const issues = analyzeProseStyle("这件事——说得不客气些——实在荒唐。");
  assert.equal(issues.filter(issue => issue.kind === "dash").length, 1);
  assert.equal(issues[0].subtype, "parenthetical_explanation");
  assert.equal(issues[0].severity, "warning");
  assert.equal(proseStyleIssuesError(issues), undefined);
});

test("dense hard mannerisms still escalate to error", () => {
  // 6 处高置信 cause_or_judgment（> limit 5 for short text）
  const lines = [
    "他停住——因为身后无人。",
    "她转身——因为门开了。",
    "雨下了——因为云压得很低。",
    "灯灭了——因为线路老化。",
    "他沉默——因为无话可说。",
    "她离开——因为不想再争。",
  ].join("");
  const errors = analyzeProseStyle(lines).filter(issue => issue.severity === "error");
  assert.ok(errors.length >= 6, `expected hard errors, got ${errors.length}`);
  assert.ok(contrastStyleError(lines));
});

test("typical chapter snippet with mixed dashes does not block", () => {
  const chapter = `
夜色压在巷口。王二推开门——门轴吱了一声。
「你——你怎么来了？」女孩往后退半步。
桌上只剩一把钥匙——黄铜的，边缘磨亮。
这不是愤怒，而是一种更深的恐惧。他仍没有解释，只把钥匙推过去。
她没有接——因为手指还在发抖。
`;
  assert.equal(contrastStyleError(chapter), undefined);
  assert.equal(proseStyleIssuesError(newProseStyleIssues("", chapter)), undefined);
});
