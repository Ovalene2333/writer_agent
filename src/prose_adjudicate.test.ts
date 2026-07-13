import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProseVerdicts,
  packProseSnippets,
  selectAdjudicationCandidates,
  shouldAdjudicateForProposal,
} from "./prose_adjudicate.js";
import { analyzeProseStyle, proseStyleIssuesError } from "./prose_quality.js";

test("selectAdjudicationCandidates prefers warnings and skips pure speech info", () => {
  const speech = analyzeProseStyle("「你——你怎么来了？」");
  assert.equal(selectAdjudicationCandidates(speech).length, 0);

  const mixed = analyzeProseStyle("他没有回头——因为身后无人。视线停在门缝里——里面有光。");
  const candidates = selectAdjudicationCandidates(mixed);
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.some(item => item.subtype === "cause_or_judgment" || item.subtype === "ambiguous_dash"));
});

test("packProseSnippets includes neighbor context", () => {
  const text = "他推开门。视线停在门缝里——里面夹着一张纸条。没有声音。";
  const issues = analyzeProseStyle(text).filter(item => item.kind === "dash");
  const packed = packProseSnippets(text, issues);
  assert.equal(packed.length, issues.length);
  assert.ok(packed[0].contextBefore.includes("推开门") || packed[0].sentence.includes("门缝"));
});

test("applyProseVerdicts allow demotes hard-fail density", () => {
  const lines = [
    "他停住——因为身后无人。",
    "她转身——因为门开了。",
    "雨下了——因为云压得很低。",
    "灯灭了——因为线路老化。",
    "他沉默——因为无话可说。",
    "她离开——因为不想再争。",
  ].join("");
  const issues = analyzeProseStyle(lines);
  assert.ok(proseStyleIssuesError(issues));

  const hard = issues.filter(item => item.severity === "error");
  const verdicts = hard.map(item => ({ id: item.id, verdict: "allow" as const, reason: "误报" }));
  const next = applyProseVerdicts(lines, issues, verdicts);
  assert.equal(proseStyleIssuesError(next), undefined);
  assert.ok(next.every(item => item.severity !== "error"));
});

test("shouldAdjudicateForProposal when dense hard mannerisms exist", () => {
  const light = analyzeProseStyle("他停住——因为身后无人。");
  assert.equal(shouldAdjudicateForProposal("他停住——因为身后无人。", light), false);

  const dense = [
    "他停住——因为身后无人。",
    "她转身——因为门开了。",
    "雨下了——因为云压得很低。",
    "灯灭了——因为线路老化。",
    "他沉默——因为无话可说。",
    "她离开——因为不想再争。",
  ].join("");
  const denseIssues = analyzeProseStyle(dense);
  assert.equal(shouldAdjudicateForProposal(dense, denseIssues), true);
});
