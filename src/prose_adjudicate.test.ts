import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCachedProseVerdicts,
  applyProseVerdicts,
  materializeProseDiscoveries,
  parseProseAdjudication,
  packProseSnippets,
  previewProseStyleGateError,
  proseVerdictCacheKey,
  selectAdjudicationCandidates,
  selectDiscoveryPassages,
  shouldAdjudicateForProposal,
  type ProseVerdictCache,
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

test("split not-A-is-B narration is deterministic and cannot be adjudicated away", () => {
  const text = "她不是被叫醒。是自己醒的。";
  const issues = analyzeProseStyle(text);
  const split = issues.find(item => item.subtype === "split_redefinition");
  assert.ok(split);
  assert.equal(shouldAdjudicateForProposal(text, issues), true);
  assert.equal(selectAdjudicationCandidates(issues).some(item => item.id === split.id), false);

  const blocked = applyProseVerdicts(text, issues, [{ id: split.id, verdict: "block", reason: "刻意拆句重定义" }]);
  assert.ok(proseStyleIssuesError(blocked));

  const fresh = analyzeProseStyle(text);
  const freshSplit = fresh.find(item => item.subtype === "split_redefinition");
  assert.ok(freshSplit);
  const allowed = applyProseVerdicts(text, fresh, [{ id: freshSplit.id, verdict: "allow", reason: "必要事实排除" }]);
  assert.ok(proseStyleIssuesError(allowed));

  const cache: ProseVerdictCache = new Map([
    [proseVerdictCacheKey(freshSplit), { verdict: "allow", reason: "旧缓存误放行" }],
  ]);
  assert.ok(proseStyleIssuesError(applyCachedProseVerdicts(text, analyzeProseStyle(text), cache)));
});

test("cached verdicts replay across gate rounds and keep re-gates deterministic", () => {
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

  // Round 1: Flash allowed every hard candidate — persist those verdicts.
  const cache: ProseVerdictCache = new Map();
  for (const issue of issues.filter(item => item.severity === "error")) {
    cache.set(proseVerdictCacheKey(issue), { verdict: "allow", reason: "误报" });
  }

  // Round 2: same sentences re-analyzed from scratch must stay allowed without Flash.
  const replayed = applyCachedProseVerdicts(lines, analyzeProseStyle(lines), cache);
  assert.equal(proseStyleIssuesError(replayed), undefined);
  assert.ok(replayed.every(item => item.severity !== "error"));

  // Empty/absent cache is a no-op.
  const untouched = applyCachedProseVerdicts(lines, analyzeProseStyle(lines), undefined);
  assert.ok(proseStyleIssuesError(untouched));
});

test("previewProseStyleGateError re-gates without a model call", () => {
  const dense = [
    "他停住——因为身后无人。",
    "她转身——因为门开了。",
    "雨下了——因为云压得很低。",
    "灯灭了——因为线路老化。",
    "他沉默——因为无话可说。",
    "她离开——因为不想再争。",
  ].join("");
  const blocked = previewProseStyleGateError("", dense);
  assert.ok(blocked && blocked.includes("硬拦截"));

  // Cached allows lift the block, matching what the async gate would decide.
  const cache: ProseVerdictCache = new Map();
  for (const issue of analyzeProseStyle(dense).filter(item => item.severity === "error")) {
    cache.set(proseVerdictCacheKey(issue), { verdict: "allow" });
  }
  assert.equal(previewProseStyleGateError("", dense, cache), undefined);

  // Pre-existing mannerisms in the old document are not re-blocked.
  assert.equal(previewProseStyleGateError(dense, dense), undefined);
  assert.equal(previewProseStyleGateError("", "他推开门。屋里没人。"), undefined);
});

test("selectDiscoveryPassages finds unruled explanatory paragraph windows", () => {
  const text = "她把门链挂上，隔着门问他还有什么事。她根本不想让他进来。\n\n街灯亮了。";
  assert.equal(analyzeProseStyle(text).some(issue => issue.kind === "explanation"), false);
  const passages = selectDiscoveryPassages(text);
  assert.equal(passages.length, 1);
  assert.ok(passages[0].text.includes("根本不想"));
});

test("materializeProseDiscoveries anchors exact sentences and deduplicates", () => {
  const text = "她把门链挂上。她根本不想让他进来。";
  const passages = selectDiscoveryPassages(text);
  const discoveries = [{
    passageId: passages[0].id,
    sentence: "她根本不想让他进来。",
    subtype: "semantic_echo" as const,
    verdict: "block" as const,
    reason: "重复翻译门链动作",
  }];
  const created = materializeProseDiscoveries(text, [], passages, discoveries);
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, "explanation");
  assert.equal(created[0].confidence, 0.95);
  assert.equal(materializeProseDiscoveries(text, created, passages, discoveries).length, 0);
});

test("parseProseAdjudication accepts verdict and active discovery object", () => {
  const passage = {
    id: "passage:0", start: 0, end: 20,
    text: "她挂上门链。她根本不想让他进来。", reason: "test",
  };
  const parsed = parseProseAdjudication(JSON.stringify({
    verdicts: [{ id: "contrast:0", verdict: "allow", reason: "事实纠正" }],
    discoveries: [{
      passageId: passage.id,
      sentence: "她根本不想让他进来。",
      subtype: "semantic_echo",
      verdict: "block",
      reason: "重复解释动作",
    }],
  }), new Set(["contrast:0"]), new Map([[passage.id, passage]]));
  assert.equal(parsed.verdicts.length, 1);
  assert.equal(parsed.discoveries.length, 1);
  assert.equal(parsed.discoveries[0].subtype, "semantic_echo");
});

test("selectDiscoveryPassages combines a following explanation line with its evidence", () => {
  const text = "她挂上门链。\n她显然不想让他进来。";
  const passages = selectDiscoveryPassages(text);
  assert.equal(passages.length, 1);
  assert.ok(passages[0].text.includes("挂上门链"));
  assert.ok(passages[0].text.includes("显然不想"));
});
