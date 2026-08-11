import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeProseStyle,
  contrastStyleError,
  contrastStyleReport,
  newProseStyleIssues,
  proseCompressionGuidance,
  proseMannerismConstraintPrompt,
  proseMannerismPreflightLine,
  proseStyleRepairPacket,
  proseStyleIssuesError,
  scanProseStyleIssues,
  sceneMannerismGateError,
} from "./prose_quality.js";
import {
  PROSE_CONSTRUCTION_RULES,
  proseConstructionAdjudicationPrompt,
  proseConstructionGenerationPrompt,
} from "./prose_construction_rules.js";

test("generation-time constraint prompt targets dense repetition without banning valid syntax", () => {
  const full = proseMannerismConstraintPrompt();
  assert.match(full, /连续复现并替代新信息/u);
  assert.match(full, /先否定后改判/u);
  assert.match(full, /破折号/);
  assert.match(full, /解释应带来新的事实/u);
  const compact = proseMannerismConstraintPrompt({ compact: true });
  assert.match(compact, /句式边界/);
  assert.ok(full.length < 1_100, "constraint prompt must stay short enough for the style slot");
  assert.match(full, /施事、对象与关系/);
  for (const prompt of [full, compact, proseMannerismPreflightLine()]) {
    assert.ok(!prompt.includes("坏例"), "must not carry bad-example demos");
  }
  assert.match(proseMannerismPreflightLine(), /密集复现/);
  assert.match(proseMannerismPreflightLine(), /孤立.*保留/);
});

test("dynamic compression guidance distinguishes natural ellipsis from note-like prose", () => {
  const guidance = proseCompressionGuidance();
  assert.match(guidance, /名词短语＋一个状态\/动作/u);
  assert.match(guidance, /比较维度/u);
  assert.match(guidance, /上下文能猜出意思不等于表达自然/u);
  assert.match(guidance, /完整而朴素的承接/u);
});

test("registered construction rules feed generation and semantic review in stable order", () => {
  const generation = proseConstructionGenerationPrompt();
  const adjudication = proseConstructionAdjudicationPrompt();
  assert.ok(PROSE_CONSTRUCTION_RULES.length >= 1);
  for (const rule of PROSE_CONSTRUCTION_RULES) {
    assert.ok(generation.includes(rule.generationGuidance));
    assert.ok(adjudication.includes(rule.id));
    assert.ok(adjudication.includes(rule.adjudicationGuidance));
  }
});

test("registered construction family budget blocks dense repetition before scene acceptance", () => {
  const clean = "门禁灯从绿变红。她停下脚步，掌心贴上金属门框。";
  assert.equal(sceneMannerismGateError(clean), undefined);

  const dense = [
    "走廊尽头有动静。不是埋伏。是逃跑。",
    "空气发涩。不是气体。是悬浮颗粒。",
    "地面反光。不是水。是油性液体。",
    "立柱在颤。不是塌方。是预埋装药。",
  ].join("");
  const issues = analyzeProseStyle(dense).filter(issue => issue.constructionRuleId === "negation_redefinition");
  assert.equal(issues.length, 4);
  assert.equal(issues.filter(issue => issue.severity === "error").length, 4);
  assert.ok(sceneMannerismGateError(dense));
  assert.ok(proseStyleIssuesError(issues));
});

test("scene gate blocks a single split negation-redefinition with soft repair guidance", () => {
  const blocked = sceneMannerismGateError("母亲的手收紧。不是抱。是扣。随后地板断了。");
  assert.match(blocked ?? "", /节奏、意象和信息落点/u);
});

test("a couple of factual negation frames share the short-scene family budget", () => {
  const blocked = sceneMannerismGateError("走廊里不是风声，是人的脚步。门后不是护士，是一名警卫。");
  assert.match(blocked ?? "", /句式家族/u);
});

test("pure negative enumeration is not mistaken for a positive redefinition", () => {
  const issues = analyzeProseStyle("她的停顿不是烦躁，也不是无聊。");
  assert.equal(issues.some(issue => issue.kind === "contrast"), false);
});

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

test("enumeration dash chains are not treated as parenthetical explanation", () => {
  for (const text of ["头——脚——手", "春——夏——秋——冬", "检查：头——躯干——四肢。"]) {
    const issues = analyzeProseStyle(text).filter(issue => issue.kind === "dash");
    assert.ok(issues.length >= 1, text);
    assert.ok(issues.every(issue => issue.severity === "info"), text);
    assert.ok(issues.every(issue => issue.subtype === "system_or_metadata"), text);
    assert.equal(proseStyleIssuesError(issues), undefined, text);
  }
  // Still classify true parenthetical as warning
  const paren = analyzeProseStyle("这件事——说得不客气些——实在荒唐。");
  assert.equal(paren.find(i => i.kind === "dash")?.subtype, "parenthetical_explanation");
});

test("markdown table dashes are metadata and never hard-fail", () => {
  const table = `
| 部位 | 说明 |
| --- | --- |
| 头 | 盔 |
| 手——脚 | 成对 |
| :--- | ---: |
`;
  const issues = analyzeProseStyle(table).filter(issue => issue.kind === "dash");
  assert.ok(issues.length >= 1);
  assert.ok(issues.every(issue => issue.severity === "info"));
  assert.ok(issues.every(issue => issue.subtype === "system_or_metadata"));
  assert.equal(contrastStyleError(table), undefined);
  assert.equal(proseStyleIssuesError(issues), undefined);
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
  assert.ok(narration.some(issue => issue.subtype === "abstract_reframing" && issue.severity === "error"));
  assert.ok(contrastStyleError(narrationText));
});

test("job regression separates narrator recasts from a necessary factual exclusion", () => {
  const text = [
    "\"什么情况。\"她低声说，不是对LANTERN说的。",
    "装甲舱顶部落下两发压制，不是杀伤，是震。",
    "一个热源，速度很快，不是步兵的速度。",
    "不是她让它动的。",
    "武器站已经转了。不是慢慢转，是一下子甩过去的。",
  ].join("\n\n");
  const issues = scanProseStyleIssues(text)
    .filter(issue => issue.constructionRuleId === "negation_redefinition");
  assert.deepEqual(issues.map(issue => issue.subtype), [
    "factual_exclusion",
    "narrator_redefinition",
    "factual_exclusion",
    "narrator_redefinition",
    "narrator_redefinition",
  ]);
  const escalated = analyzeProseStyle(text);
  assert.equal(escalated.filter(issue => issue.subtype === "narrator_redefinition" && issue.severity === "error").length, 3);
});

test("repeated abstract contrast frames exceed a shared deterministic budget", () => {
  const text = [
    "这不是愤怒，而是一种更深的恐惧。",
    "那不是退让，只是另一种形式的反抗。",
    "这不是沉默，而是尚未作出的决定。",
    "那不是失败，而是另一条路的开始。",
  ].join("\n");
  const contrastIssues = analyzeProseStyle(text).filter(issue => issue.subtype === "abstract_reframing");
  assert.equal(contrastIssues.length, 4);
  assert.equal(contrastIssues.filter(issue => issue.severity === "error").length, 4);
  assert.ok(contrastIssues.every(issue => issue.constructionRuleId === "negation_redefinition"));
  assert.ok(contrastStyleError(text));
});

test("a single abstract contrast requires revision", () => {
  const text = "这不是愤怒，而是一种更深的恐惧。";
  const issue = analyzeProseStyle(text).find(item => item.subtype === "abstract_reframing");
  assert.equal(issue?.severity, "error");
  assert.ok(contrastStyleError(text));
});

test("blocks a split not-A-is-B narration with a soft revision target", () => {
  const text = "她不是被叫醒。是自己醒的。";
  const issue = analyzeProseStyle(text).find(item => item.subtype === "split_redefinition");
  assert.ok(issue);
  assert.equal(issue.severity, "error");
  assert.equal(issue.sentence, text);
  assert.ok(proseStyleIssuesError([issue]));
  assert.match(issue.suggestions[0] ?? "", /节奏、意象和信息落点/u);
});

test("detects postposed denial after an already established fact", () => {
  const text = "导能光从肩甲一路流到枪口，暖意贴着她夸张的胸廓亮体缓缓扩散——那是纳容缓冲在预热，不是紧张。";
  const issue = analyzeProseStyle(text).find(item => item.constructionRuleId === "negation_redefinition");
  assert.ok(issue);
  assert.equal(issue.subtype, "abstract_reframing");
  assert.equal(issue.severity, "error");
  assert.match(issue.evidence, /不是紧张/u);
  assert.ok(proseStyleIssuesError([issue]));
});

test("derivative negation-redefinition forms share the registered family", () => {
  const text = [
    "屏幕上没有女儿的脸，只有数字、波形、温控曲线。",
    "远端没有手指，没有脚趾，只有一阵沿着神经爬升的麻意。",
    "这算不上撤退，只是把阵地让给下一班人。",
  ].join("\n");
  const issues = analyzeProseStyle(text).filter(issue => issue.constructionRuleId === "negation_redefinition");
  assert.equal(issues.length, 3);
  assert.equal(issues.filter(issue => issue.severity === "error").length, 2);
  assert.ok(issues.every(issue => issue.countsTowardFamilyBudget === true));
});

test("unrelated local patches do not inherit a pre-existing family-budget failure", () => {
  const before = "不是掉线。是往上跳。\n不是慢慢降，是断崖。\n不是下降，是横住。";
  const after = `${before}\n窗外的雨停了。`;
  assert.equal(newProseStyleIssues(before, after).some(issue => issue.severity === "error"), false);

  const increased = `${after}\n没有回声，只有泵机稳定的低鸣。`;
  assert.ok(newProseStyleIssues(after, increased).some(issue =>
    issue.constructionRuleId === "negation_redefinition" && issue.severity === "error"));
});

test("blocks a single factual split contrast because the narration skeleton needs revision", () => {
  const text = "他不是坏人。他是个逃兵。";
  const issue = analyzeProseStyle(text).find(item => item.subtype === "split_redefinition");
  assert.equal(issue?.severity, "error");
  assert.ok(contrastStyleError(text));
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

test("style repair packet keeps every unique late blocker executable", () => {
  const lines = [
    "他停住——因为身后无人。",
    "她转身——因为门开了。",
    "雨下了——因为云压得很低。",
    "灯灭了——因为线路老化。",
    "他沉默——因为无话可说。",
    "她离开——因为不想再争。",
  ].join("\n");
  const packet = proseStyleRepairPacket(lines, analyzeProseStyle(lines), {
    path: "chapters/第一章.md",
    sourceHash: "working-hash",
  });
  assert.equal(packet?.issueCount, 6);
  assert.equal(packet?.issues.length, 6);
  assert.equal(packet?.omittedIssueCount, undefined);
  assert.equal(packet?.path, "chapters/第一章.md");
  assert.equal(packet?.sourceHash, "working-hash");
  const late = packet?.issues.find(issue => issue.oldText?.includes("她离开"));
  assert.ok(late, "the final gate issue must remain in the direct repair packet");
  for (const issue of packet?.issues ?? []) {
    assert.ok(issue.oldText, `missing oldText for ${issue.id}`);
    assert.equal(lines.indexOf(issue.oldText!), lines.lastIndexOf(issue.oldText!));
  }
});

test("typical chapter snippet still blocks a semantic reinterpretation despite otherwise valid dashes", () => {
  const chapter = `
夜色压在巷口。王二推开门——门轴吱了一声。
「你——你怎么来了？」女孩往后退半步。
桌上只剩一把钥匙——黄铜的，边缘磨亮。
这不是愤怒，而是一种更深的恐惧。他仍没有解释，只把钥匙推过去。
她没有接——因为手指还在发抖。
`;
  assert.match(contrastStyleError(chapter) ?? "", /一种更深的恐惧/u);
  assert.match(proseStyleIssuesError(newProseStyleIssues("", chapter)) ?? "", /一种更深的恐惧/u);
});

test("classifies adjacent explanatory labels as semantic echo candidates", () => {
  const text = "她把门链挂上，隔着门问他还有什么事。这说明她根本不想让他进来。";
  const issues = analyzeProseStyle(text).filter(issue => issue.kind === "explanation");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].subtype, "semantic_echo");
  assert.equal(issues[0].severity, "warning");
  assert.equal(proseStyleIssuesError(issues), undefined);
});

test("recognizes explanation categories without treating them as immediate hard failures", () => {
  const samples = [
    ["真正重要的是他终于做出了选择。", "narrator_redefinition"],
    ["直到此刻他才明白，回去已经太晚。", "thematic_summary"],
    ["他真正想说的是，他不会再回来。", "intent_translation"],
    ["他显然感到恐惧。", "emotion_label"],
    ["原因在于门锁昨夜已经换过。", "causal_gloss"],
  ] as const;
  for (const [text, subtype] of samples) {
    const issue = analyzeProseStyle(text).find(item => item.kind === "explanation");
    assert.equal(issue?.subtype, subtype, text);
    assert.notEqual(issue?.severity, "error", text);
  }
});

test("does not scan dialogue explanation as narrator voice", () => {
  const issues = analyzeProseStyle("「这说明你根本没看信。」她说。");
  assert.equal(issues.some(issue => issue.kind === "explanation"), false);
});
