import test from "node:test";
import assert from "node:assert/strict";
import { analyzeProseStyle, contrastStyleError, contrastStyleReport, newProseStyleIssues } from "./prose_quality.js";

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

test("finds explanatory narrative dashes with locations and reasons", () => {
  const text = "他推开门。\n视线停在门缝里——里面夹着一张纸条。";
  const issue = analyzeProseStyle(text).find(item => item.kind === "dash");
  assert.ok(issue);
  assert.equal(issue.line, 2);
  assert.ok(issue.column > 1);
  assert.equal(issue.severity, "warning");
  assert.ok(issue.reason.length > 0);
  assert.ok(issue.suggestions.length > 0);
});

test("promotes repeated high-confidence mannerisms to errors", () => {
  const text = "他没有回头——因为身后已经无人。她也停住——原来门一直开着。";
  const issues = analyzeProseStyle(text).filter(issue => issue.kind === "dash");
  assert.equal(issues.length, 2);
  assert.ok(issues.every(issue => issue.severity === "error"));
  assert.match(contrastStyleError(text) ?? "", /第1行/);
});

test("allows one occurrence in short text as a warning rather than rejecting it", () => {
  const text = "桌上只剩一样东西——一把钥匙。";
  const report = contrastStyleReport(text);
  assert.equal(report.dashCount, 1);
  assert.equal(contrastStyleError(text), undefined);
});

test("distinguishes dialogue correction from narrator reframing", () => {
  const dialogue = analyzeProseStyle("「不是老周，是他儿子。」");
  assert.ok(dialogue.some(issue => issue.subtype === "dialogue_correction" && issue.severity === "info"));

  const narration = analyzeProseStyle("这不是愤怒，而是一种更深的恐惧。");
  assert.ok(narration.some(issue => issue.subtype === "abstract_reframing" && issue.severity === "warning"));
});

test("does not join cross-sentence contrast fragments", () => {
  assert.equal(contrastStyleReport("他不是坏人。他是个逃兵。").frameCount, 0);
});

test("reports only newly introduced issues for patches", () => {
  const before = "他停住——因为门外有声音。\n她转身离开。";
  const after = "他停住——因为门外有声音。\n她没有追——原来早已知道答案。";
  const added = newProseStyleIssues(before, after).filter(issue => issue.severity !== "info");
  assert.equal(added.length, 1);
  assert.ok(added[0].sentence.includes("她没有追"));
});

test("paired dashes are reported as one parenthetical issue", () => {
  const issues = analyzeProseStyle("这件事——说得不客气些——实在荒唐。");
  assert.equal(issues.filter(issue => issue.kind === "dash").length, 1);
  assert.equal(issues[0].subtype, "parenthetical_explanation");
});
