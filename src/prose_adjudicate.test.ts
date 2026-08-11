import test from "node:test";
import assert from "node:assert/strict";
import {
  adjudicateLearnedProseGates,
  applyCachedProseVerdicts,
  applyProseVerdicts,
  deterministicLearnedProseGateIssues,
  learnedGatePassagesForReview,
  materializeProseDiscoveries,
  parseLearnedProseGateFindings,
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
import {
  BUILT_IN_PROSE_GATE_RULES,
  MAX_PROSE_GATE_RULES,
  PROSE_GATE_PROJECT_RULE_CAPACITY,
  proseGateRulesForTarget,
  type ProseGateRule,
} from "./prose_gate_rules.js";
import { buildProseDiagnosis } from "./prose_review.js";
import { MAX_ACTIVE_AUTHOR_POLICIES } from "./author_policies.js";

test("selectAdjudicationCandidates prefers warnings and skips pure speech info", () => {
  const speech = analyzeProseStyle("「你——你怎么来了？」");
  assert.equal(selectAdjudicationCandidates(speech).length, 0);

  const mixed = analyzeProseStyle("他没有回头——因为身后无人。视线停在门缝里——里面有光。");
  const candidates = selectAdjudicationCandidates(mixed);
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.some(item => item.subtype === "cause_or_judgment" || item.subtype === "ambiguous_dash"));
});

test("learned gate accepts exact evidence for quoted-text count feedback", () => {
  const text = "她盯着纸上的“永远等你”——这三个字，半晌没动。";
  const rule: ProseGateRule = {
    id: "quoted-text-count-consistency",
    label: "引号文字数量一致性",
    instruction: "描述引号内文字数量时，核对实际字数。",
    revisionIntent: "修正数量描述。",
    kind: "hard_gate",
    severity: "block",
    enabled: true,
    builtIn: true,
    documentKinds: ["chapter", "side", "writing_example"],
    pathPrefixes: [],
    sourceFeedback: "作者要求复审字数描述",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
  const passages = [{ id: "learned:0", start: 0, end: text.length, text, reason: "作者自定义复审" }];
  const findings = parseLearnedProseGateFindings(JSON.stringify({
    findings: [{
      ruleId: rule.id,
      passageId: "learned:0",
      evidence: text,
      reason: "引号内四个字，却写成三个字",
      suggestion: "改成“这四个字”",
    }],
  }), [rule], passages);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].suggestion, "改成“这四个字”");

  const fabricated = parseLearnedProseGateFindings(JSON.stringify({
    findings: [{ ruleId: rule.id, passageId: "learned:0", evidence: "不存在的原句" }],
  }), [rule], passages);
  assert.deepEqual(fabricated, []);
});

test("quoted-text count gate is deterministic and ignores unquoted cross-paragraph guesses", async () => {
  const rule = BUILT_IN_PROSE_GATE_RULES.find(item => item.id === "quoted-text-count-consistency")!;
  const mismatch = "她盯着纸上的“永远等你”——这三个字，半晌没动。";
  const issues = deterministicLearnedProseGateIssues(mismatch, [rule]);
  assert.equal(issues.length, 1);
  assert.match(issues[0].reason, /引号内为 4 个/u);
  assert.match(issues[0].suggestions[0], /四个字/u);

  assert.deepEqual(
    deterministicLearnedProseGateIssues("她盯着纸上的“永远等你”——这四个字，半晌没动。", [rule]),
    [],
  );
  assert.deepEqual(
    deterministicLearnedProseGateIssues("她把注意撕到最深处那三个字旁边。\n\n活下去。", [rule]),
    [],
  );

  const withoutModel = await adjudicateLearnedProseGates(mismatch, [rule], undefined, { failClosed: true });
  assert.equal(withoutModel.length, 1);
});

test("project prose gates honor document kind and path scopes", () => {
  const base: ProseGateRule = {
    id: "chapter-voice",
    label: "第一卷声线",
    instruction: "只复审第一卷正文。",
    revisionIntent: "保持第一卷声线。",
    kind: "style_preference",
    severity: "warn",
    enabled: true,
    builtIn: false,
    documentKinds: ["chapter"],
    pathPrefixes: ["chapters/第一卷"],
    sourceFeedback: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  assert.deepEqual(
    proseGateRulesForTarget([base], { kind: "chapter", path: "chapters/第一卷/第一章.md" }).map(rule => rule.id),
    [base.id],
  );
  assert.deepEqual(proseGateRulesForTarget([base], { kind: "chapter", path: "chapters/第二卷/第一章.md" }), []);
  assert.deepEqual(proseGateRulesForTarget([base], { kind: "writing_example" }), []);
});

test("built-in semantic rules keep a fixed project-rule capacity and repair metadata", () => {
  assert.equal(MAX_PROSE_GATE_RULES, PROSE_GATE_PROJECT_RULE_CAPACITY + BUILT_IN_PROSE_GATE_RULES.length + MAX_ACTIVE_AUTHOR_POLICIES);
  assert.equal(PROSE_GATE_PROJECT_RULE_CAPACITY, 19);
  assert.deepEqual(BUILT_IN_PROSE_GATE_RULES.map(rule => rule.id), [
    "quoted-text-count-consistency",
    "telegraphic-object-beats",
    "characterization-proof-stacking",
    "manufactured-precision-staccato",
  ]);
  for (const rule of BUILT_IN_PROSE_GATE_RULES) {
    assert.ok(rule.label.length > 0);
    assert.ok(rule.instruction.length > 0);
    assert.ok(rule.revisionIntent.length > 0);
    assert.equal(rule.builtIn, true);
  }
  const characterization = BUILT_IN_PROSE_GATE_RULES.find(rule => rule.id === "characterization-proof-stacking");
  assert.match(characterization?.instruction ?? "", /行动证明.*外部背书.*点题定性/u);
  assert.match(characterization?.revisionIntent ?? "", /具体选择.*后果/u);

  const telegraphic = BUILT_IN_PROSE_GATE_RULES.find(rule => rule.id === "telegraphic-object-beats");
  assert.match(telegraphic?.instruction ?? "", /上下文猜出关系.*仍像提纲字段/u);
  assert.match(telegraphic?.instruction ?? "", /抽象归属.*具体物件.*短梗/u);
  assert.match(telegraphic?.instruction ?? "", /不能只摘一个短句/u);
  assert.match(telegraphic?.revisionIntent ?? "", /比较维度.*至少展开一处/u);

  const precisionStaccato = BUILT_IN_PROSE_GATE_RULES.find(rule => rule.id === "manufactured-precision-staccato");
  assert.equal(precisionStaccato?.kind, "style_preference");
  assert.equal(precisionStaccato?.severity, "warn");
  assert.match(precisionStaccato?.instruction ?? "", /极短句.*高确定性细节/u);
  assert.match(precisionStaccato?.instruction ?? "", /语法完整.*不能.*自动放行/u);
  assert.match(precisionStaccato?.instruction ?? "", /自然问答.*紧急指令.*精确信息.*偶发重音.*放行/u);
  assert.match(precisionStaccato?.instruction ?? "", /完整相邻句组/u);
  assert.match(precisionStaccato?.revisionIntent ?? "", /保留必要事实和精度.*只调整命中句组/u);
});

test("manufactured precision staccato review keeps complete adjacent evidence", () => {
  const text = [
    "别装。你昨晚把行李单改了三遍。",
    "一份他签过字的护航名单。精确到分钟。",
  ].join("\n\n");
  const passages = learnedGatePassagesForReview(text);
  assert.deepEqual(passages.map(passage => passage.text), [
    "别装。你昨晚把行李单改了三遍。",
    "一份他签过字的护航名单。精确到分钟。",
  ]);
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

test("split not-A-is-B narration cannot be exempted by a permissive semantic verdict", () => {
  const text = "她不是被叫醒。是自己醒的。";
  const issues = analyzeProseStyle(text);
  const split = issues.find(item => item.subtype === "split_redefinition");
  assert.ok(split);
  assert.equal(shouldAdjudicateForProposal(text, issues), true);
  assert.equal(selectAdjudicationCandidates(issues).some(item => item.id === split.id), true);

  const blocked = applyProseVerdicts(text, issues, [{ id: split.id, verdict: "block", reason: "刻意拆句重定义" }]);
  assert.equal(blocked.find(item => item.id === split.id)?.severity, "error");

  const fresh = analyzeProseStyle(text);
  const freshSplit = fresh.find(item => item.subtype === "split_redefinition");
  assert.ok(freshSplit);
  const allowed = applyProseVerdicts(text, fresh, [{ id: freshSplit.id, verdict: "allow", reason: "必要事实排除" }]);
  assert.ok(proseStyleIssuesError(allowed));
  assert.equal(allowed.find(item => item.id === freshSplit.id)?.semanticVerdict, "block");
  assert.match(allowed.find(item => item.id === freshSplit.id)?.suggestions[0] ?? "", /节奏、意象和信息落点/u);

  const cache: ProseVerdictCache = new Map([
    [proseVerdictCacheKey(freshSplit), { verdict: "allow", reason: "旧缓存误放行" }],
  ]);
  assert.ok(proseStyleIssuesError(applyCachedProseVerdicts(text, analyzeProseStyle(text), cache)), "旧 allow 缓存不能绕过新规则");
});

test("semantic progression and interpretation contrasts are blocked with non-mechanical repair guidance", () => {
  const text = [
    "发射单元偏了。不是对着人。是对着谷口前三十米的碎石坡。",
    "那感觉像把手从冰水里抽出来——不是疼，是脑子里突然少了很多东西。",
  ].join("\n");
  const issues = analyzeProseStyle(text);
  const registered = issues.filter(item => item.constructionRuleId === "negation_redefinition");
  assert.deepEqual(registered.map(item => item.subtype), ["split_redefinition", "abstract_reframing"]);
  assert.ok(registered.every(item => item.severity === "error"));

  const reviewed = applyProseVerdicts(text, issues, registered.map(item => ({
    id: item.id,
    verdict: "allow" as const,
    reason: "局部事实成立且比喻自然",
  })));
  const reviewedRegistered = reviewed.filter(item => item.constructionRuleId === "negation_redefinition");
  assert.ok(reviewedRegistered.every(item => item.semanticVerdict === "block"));
  assert.ok(reviewedRegistered.every(item => item.suggestions.some(suggestion => /不要压成说明句/u.test(suggestion))));
});

test("semantic allow and deterministic construction-family budget stay independent", () => {
  const text = "走廊里不是风声，是人的脚步。门后不是护士，是一名警卫。";
  const issues = analyzeProseStyle(text);
  const candidates = issues.filter(item => item.constructionRuleId === "negation_redefinition");
  assert.equal(candidates.length, 2);
  assert.equal(shouldAdjudicateForProposal(text, issues), true);
  assert.ok(packProseSnippets(text, candidates).every(item => item.constructionRuleId === "negation_redefinition"));
  assert.ok(proseStyleIssuesError(issues), "family density must execute even before semantic review");

  const blocked = applyProseVerdicts(text, issues, candidates.map(item => ({
    id: item.id,
    verdict: "block" as const,
    reason: "重复使用固定对照骨架",
  })));
  assert.ok(proseStyleIssuesError(blocked));

  const fresh = analyzeProseStyle(text);
  const freshCandidates = fresh.filter(item => item.constructionRuleId === "negation_redefinition");
  const mixed = applyProseVerdicts(text, fresh, [
    { id: freshCandidates[0].id, verdict: "allow", reason: "必要客观排除" },
    { id: freshCandidates[1].id, verdict: "block", reason: "模板化重述" },
  ]);
  assert.ok(proseStyleIssuesError(mixed), "the explicit semantic block remains actionable");

  const allAllowed = analyzeProseStyle(text);
  const allowedCandidates = allAllowed.filter(item => item.constructionRuleId === "negation_redefinition");
  const allowedOnly = applyProseVerdicts(text, allAllowed, allowedCandidates.map(item => ({
    id: item.id,
    verdict: "allow" as const,
    reason: "必要客观排除",
  })));
  assert.equal(proseStyleIssuesError(allowedOnly), undefined, "semantic allow must not be overturned by density");
});

test("prose diagnosis gives Agent stable evidence and revision intent", () => {
  const sourceHash = "source-v1";
  const text = "暖意沿着肩甲扩散，那是缓冲层在预热，不是紧张。门后不是护士，是一名警卫。";
  const issues = analyzeProseStyle(text);
  const candidate = issues.find(item => item.constructionRuleId === "negation_redefinition");
  assert.ok(candidate);
  const reviewed = applyProseVerdicts(text, issues, [{
    id: candidate.id,
    verdict: "block",
    reason: "事实成立后追加否定情绪标签",
  }]);
  const diagnosis = buildProseDiagnosis(sourceHash, reviewed, text);
  assert.equal(diagnosis.status, "needs_revision");
  assert.equal(diagnosis.sourceHash, sourceHash);
  assert.equal(diagnosis.actionableIssues[0].ruleId, "negation_redefinition");
  assert.equal(diagnosis.actionableIssues[0].verdict, "block");
  assert.match(diagnosis.actionableIssues[0].evidence, /不是紧张/u);
  assert.ok(diagnosis.actionableIssues[0].revisionIntent.length > 0);
  assert.equal(diagnosis.familyBudgets[0].excess, 1);
  assert.equal(diagnosis.familyBudgets[0].reviseIssueIds.length, 1);
  assert.equal(buildProseDiagnosis(sourceHash, reviewed, text).reviewId, diagnosis.reviewId);
});

test("forward and postposed denial variants share one semantic density rule", () => {
  const text = "走廊里不是风声，是人的脚步。暖意沿着肩甲扩散，那是缓冲层在预热，不是紧张。";
  const issues = analyzeProseStyle(text);
  const candidates = issues.filter(item => item.constructionRuleId === "negation_redefinition");
  assert.equal(candidates.length, 2);
  assert.equal(shouldAdjudicateForProposal(text, issues), true);
  const blocked = applyProseVerdicts(text, issues, candidates.map(item => ({
    id: item.id,
    verdict: "block" as const,
    reason: "同一否定改判骨架的正反变体重复",
  })));
  assert.ok(proseStyleIssuesError(blocked));
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
    verdicts: [{ id: "contrast:0", verdict: "allow", countsTowardFamilyBudget: true, reason: "事实纠正" }],
    discoveries: [{
      passageId: passage.id,
      sentence: "她根本不想让他进来。",
      subtype: "semantic_echo",
      verdict: "block",
      reason: "重复解释动作",
    }],
  }), new Set(["contrast:0"]), new Map([[passage.id, passage]]));
  assert.equal(parsed.verdicts.length, 1);
  assert.equal(parsed.verdicts[0].countsTowardFamilyBudget, true);
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

test("learned prose review narrows local edits to changed passages and neighbors", () => {
  const before = ["第一段保持不变。", "第二段原文。", "第三段保持不变。", "第四段也保持不变。"].join("\n\n");
  const after = ["第一段保持不变。", "第二段已经修改。", "第三段保持不变。", "第四段也保持不变。"].join("\n\n");
  const passages = learnedGatePassagesForReview(after, before);
  assert.equal(passages.length, 3);
  assert.ok(passages.some(item => item.text.includes("第二段已经修改")));
  assert.ok(passages.some(item => item.text.includes("第一段保持不变")));
  assert.ok(passages.some(item => item.text.includes("第三段保持不变")));
  assert.ok(passages.every(item => !item.text.includes("第四段也保持不变")));
  assert.deepEqual(learnedGatePassagesForReview(before, before), []);
});
