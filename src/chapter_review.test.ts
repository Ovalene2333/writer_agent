import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChapterReviewMessages,
  buildChapterReviewRevisionContext,
  constrainChapterRevisionReview,
  parseChapterReview,
  type ChapterReviewResult,
} from "./chapter_review.js";
import { proposalRevisionIssueId, type ProposalRevisionIssue } from "./proposal_retry.js";

const SCENES = new Set(["s1"]);
const SOURCE = "「我们必须面对这个真相。」他说。她也这样说话。最后他终于明白了一切。";

function review(
  issues: unknown[],
  verdict: "pass" | "revise" = "revise",
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    verdict,
    chapterChange: "他交出了钥匙",
    reviewNotes: "对白无法区分说话人，章尾由叙述者点破主题",
    issues,
    ...extra,
  });
}

test("终审接受三类新增的生成腔判断", () => {
  const parsed = parseChapterReview(review([
    {
      severity: "blocker", kind: "voice_homogenization", sceneId: "s1",
      evidence: ["「我们必须面对这个真相。」"],
      problem: "两个人物的台词可以互换", action: "给她一套自己的说话方式",
    },
    {
      severity: "warning", kind: "theme_stated", sceneId: "s1",
      evidence: ["最后他终于明白了一切。"],
      problem: "叙述者替读者做了判断", action: "改成一个具体动作收尾",
    },
    {
      severity: "warning", kind: "resolution_too_smooth", sceneId: "s1",
      evidence: [],
      problem: "冲突靠互相理解化解，没有人付出代价", action: "让某一方失去一件不可撤销的东西",
    },
  ]), SCENES, SOURCE);
  assert.deepEqual(parsed.issues.map(issue => issue.kind), [
    "voice_homogenization", "theme_stated", "resolution_too_smooth",
  ]);
  assert.equal(parsed.verdict, "revise");
});

test("新 kind 不放宽 blocker 的证据要求", () => {
  // Multi-scene：无正文命中证据仍不可作 revise blocker。
  assert.throws(() => parseChapterReview(review([
    {
      severity: "blocker", kind: "theme_stated", sceneId: "s1",
      evidence: ["这句正文里根本没有"],
      problem: "章尾点破主题", action: "删掉总结",
    },
  ]), new Set(["s1", "s2"]), SOURCE), /可定位的 blocker 证据/);

  // 直接文档终审只有 document 一个合法 sceneId：缺 sceneId / 证据对不上时降为 pass，
  // 避免被误报成「终审服务不可用」后空重试同一稿。
  const direct = parseChapterReview(review([
    {
      severity: "blocker", kind: "theme_stated",
      evidence: ["这句正文里根本没有"],
      problem: "章尾点破主题", action: "删掉总结",
    },
  ]), new Set(["document"]), SOURCE);
  assert.equal(direct.verdict, "pass");
  assert.equal(direct.issues[0]?.severity, "warning");
});

test("直接文档终审可回填 document sceneId，并容忍引号空白差异", () => {
  const source = "「我们必须面对这个真相。」他说。";
  const parsed = parseChapterReview(JSON.stringify({
    verdict: "revise",
    chapterChange: "对白区分说话人",
    reviewNotes: "缺 sceneId 时也应能定位整章",
    issues: [{
      severity: "blocker",
      kind: "voice_homogenization",
      evidence: ['"我们必须面对这个真相。"'],
      problem: "台词可互换",
      action: "改说话方式",
    }],
  }), new Set(["document"]), source);
  assert.equal(parsed.verdict, "revise");
  assert.equal(parsed.issues[0]?.sceneId, "document");
  assert.equal(parsed.issues[0]?.severity, "blocker");
  assert.ok((parsed.issues[0]?.evidence.length ?? 0) > 0);
});

test("终审只保留全文中唯一的可直接替换 oldText", () => {
  const source = "她从录音里听见答案。门禁灯随即熄灭。";
  const parsed = parseChapterReview(review([{
    severity: "blocker", kind: "knowledge_leak", sceneId: "s1",
    evidence: ["她从录音里听见答案。"],
    oldText: "她从录音里听见答案。",
    problem: "录音尚未出现，角色没有获知路径",
    action: "改成当下可见的迹象或补足录音来源",
  }]), SCENES, source);
  assert.equal(parsed.issues[0]?.oldText, "她从录音里听见答案。");

  const duplicate = "她从录音里听见答案。她从录音里听见答案。";
  const ambiguous = parseChapterReview(review([{
    severity: "blocker", kind: "knowledge_leak", sceneId: "s1",
    evidence: ["她从录音里听见答案。"],
    oldText: "她从录音里听见答案。",
    problem: "录音尚未出现，角色没有获知路径",
    action: "改成当下可见的迹象或补足录音来源",
  }]), SCENES, duplicate);
  assert.equal(ambiguous.issues[0]?.oldText, undefined);
});

test("有可定位 blocker 时，不完整 sibling 不拖垮整次 revise", () => {
  const parsed = parseChapterReview(review([
    {
      severity: "blocker", kind: "voice_homogenization", sceneId: "s1",
      evidence: ["「我们必须面对这个真相。」"],
      problem: "对白不可分", action: "区分声口",
    },
    {
      severity: "blocker", kind: "theme_stated", sceneId: "s1",
      evidence: ["这句正文里根本没有"],
      problem: "无证据主题句", action: "忽略或补证据",
    },
  ]), SCENES, SOURCE);
  assert.equal(parsed.verdict, "revise");
  assert.equal(parsed.issues[0]?.severity, "blocker");
  assert.equal(parsed.issues[1]?.severity, "warning");
});

test("未知 kind 仍然被丢弃", () => {
  const parsed = parseChapterReview(review([
    { severity: "warning", kind: "ai_smell", sceneId: "s1", evidence: [], problem: "像 AI", action: "改" },
  ], "pass"), SCENES, SOURCE);
  assert.deepEqual(parsed.issues, []);
});

test("修订复审只允许旧 blocker 和修改直接引入的问题继续拦截", () => {
  const previousContent = "# 第一章\n\n她在听觉编码建立前听见了回答。\n\n远处的门一直是红色。";
  const content = "# 第一章\n\n听觉编码亮起后，她听见了回答，却凭空认出了陌生人的代号。\n\n远处的门一直是红色。";
  const priorBase = {
    severity: "blocker",
    kind: "knowledge_leak",
    evidence: ["她在听觉编码建立前听见了回答。"],
    problem: "听觉编码尚未建立，角色没有获得对白的路径",
    action: "把听见对白移到听觉编码恢复之后",
  };
  const prior: ProposalRevisionIssue = {
    ...priorBase,
    id: proposalRevisionIssueId(priorBase),
  };
  const otherKindPrior: ProposalRevisionIssue = {
    id: "issue:door-color",
    severity: "blocker",
    kind: "fact_conflict",
    evidence: ["远处的门一直是红色。"],
    problem: "旧设定称门是蓝色",
    action: "改回蓝色",
  };
  const revision = buildChapterReviewRevisionContext({
    previousContent,
    content,
    previousSourceHash: "previous-hash",
    priorBlockers: [prior, otherKindPrior],
  });

  const unrelated: ChapterReviewResult = {
    verdict: "revise",
    chapterChange: "听觉恢复",
    reviewNotes: "发现远处门色问题",
    issues: [{
      severity: "blocker",
      kind: "fact_conflict",
      sceneId: "document",
      evidence: ["远处的门一直是红色。"],
      problem: "旧设定称门是蓝色",
      action: "改回蓝色",
    }],
    priorBlockerDispositions: [
      { priorIssueId: prior.id, status: "resolved" },
      { priorIssueId: otherKindPrior.id, status: "resolved" },
    ],
  };
  const scopedUnrelated = constrainChapterRevisionReview(unrelated, revision, previousContent, content);
  assert.equal(scopedUnrelated.verdict, "pass");
  assert.equal(scopedUnrelated.issues[0]?.severity, "warning");
  assert.equal(scopedUnrelated.issues[0]?.origin, "pre_existing_unrelated");

  const introduced: ChapterReviewResult = {
    verdict: "revise",
    chapterChange: "听觉恢复",
    reviewNotes: "修订引入新认知越界",
    issues: [{
      severity: "blocker",
      kind: "knowledge_leak",
      sceneId: "document",
      evidence: ["她听见了回答，却凭空认出了陌生人的代号。"],
      problem: "正文没有角色获知陌生人代号的路径",
      action: "删除代号或补入可感知来源",
      origin: "introduced_by_revision",
    }],
    priorBlockerDispositions: [
      { priorIssueId: prior.id, status: "resolved" },
      { priorIssueId: otherKindPrior.id, status: "resolved" },
    ],
  };
  const scopedIntroduced = constrainChapterRevisionReview(introduced, revision, previousContent, content);
  assert.equal(scopedIntroduced.verdict, "revise");
  assert.equal(scopedIntroduced.issues[0]?.severity, "blocker");

  const unresolved: ChapterReviewResult = {
    verdict: "revise",
    chapterChange: "听觉恢复",
    reviewNotes: "旧问题仍在",
    issues: [{
      severity: "blocker",
      kind: "knowledge_leak",
      sceneId: "document",
      evidence: ["听觉编码亮起后，她听见了回答，却凭空认出了陌生人的代号。"],
      problem: "听觉恢复时序仍不明确",
      action: "明确编码完成后再呈现对白",
      priorIssueId: prior.id,
      origin: "unresolved_prior",
    }],
    priorBlockerDispositions: [
      { priorIssueId: prior.id, status: "still_present" },
      { priorIssueId: otherKindPrior.id, status: "resolved" },
    ],
  };
  const scopedPrior = constrainChapterRevisionReview(unresolved, revision, previousContent, content);
  assert.equal(scopedPrior.verdict, "revise");
  assert.equal(scopedPrior.issues[0]?.priorIssueId, prior.id);

  const wrongKindPriorId: ChapterReviewResult = {
    verdict: "revise",
    chapterChange: "听觉恢复",
    reviewNotes: "错误关联旧 blocker",
    issues: [{
      severity: "blocker",
      kind: "knowledge_leak",
      sceneId: "document",
      evidence: ["远处的门一直是红色。"],
      problem: "角色不应知道门的颜色",
      action: "补充观察路径",
      priorIssueId: otherKindPrior.id,
      origin: "unresolved_prior",
    }],
    priorBlockerDispositions: [
      { priorIssueId: prior.id, status: "resolved" },
      { priorIssueId: otherKindPrior.id, status: "resolved" },
    ],
  };
  const scopedWrongKind = constrainChapterRevisionReview(
    wrongKindPriorId,
    revision,
    previousContent,
    content,
  );
  assert.equal(scopedWrongKind.verdict, "pass");
  assert.equal(scopedWrongKind.issues[0]?.severity, "warning");
  assert.equal(scopedWrongKind.issues[0]?.priorIssueId, undefined);

  assert.throws(() => constrainChapterRevisionReview({
    ...unresolved,
    priorBlockerDispositions: [
      { priorIssueId: prior.id, status: "resolved" },
      { priorIssueId: otherKindPrior.id, status: "resolved" },
    ],
  }, revision, previousContent, content), /缺少有效/);
});

test("有 priorBlockers 的修订复审必须逐项输出 disposition", () => {
  const previousContent = "# 第一章\n\n她知道门后的代号。";
  const content = "# 第一章\n\n她不再声称知道门后的代号。";
  const prior: ProposalRevisionIssue = {
    id: "issue:knowledge-path",
    severity: "blocker",
    kind: "knowledge_leak",
    evidence: ["她知道门后的代号。"],
    problem: "角色没有获知代号的路径",
    action: "删除断言或补充来源",
  };
  const revision = buildChapterReviewRevisionContext({
    previousContent,
    content,
    previousSourceHash: "knowledge-before",
    priorBlockers: [prior],
  });
  const missing = parseChapterReview(review([], "pass"), SCENES, content);
  assert.throws(
    () => constrainChapterRevisionReview(missing, revision, previousContent, content),
    /缺少有效/,
  );

  const resolved = parseChapterReview(review([], "pass", {
    priorBlockerDispositions: [{ priorIssueId: prior.id, status: "resolved" }],
  }), SCENES, content);
  assert.deepEqual(resolved.priorBlockerDispositions, [
    { priorIssueId: prior.id, status: "resolved" },
  ]);
  assert.equal(
    constrainChapterRevisionReview(resolved, revision, previousContent, content).verdict,
    "pass",
  );

  const unsupportedStillPresent: ChapterReviewResult = {
    ...resolved,
    priorBlockerDispositions: [{ priorIssueId: prior.id, status: "still_present" }],
  };
  assert.throws(
    () => constrainChapterRevisionReview(unsupportedStillPresent, revision, previousContent, content),
    /缺少有效/,
  );
  assert.throws(() => constrainChapterRevisionReview({
    ...resolved,
    priorBlockerDispositions: [{ priorIssueId: "issue:unknown", status: "resolved" }],
  }, revision, previousContent, content), /缺少有效/);
  assert.throws(() => constrainChapterRevisionReview({
    ...resolved,
    priorBlockerDispositions: [
      { priorIssueId: prior.id, status: "resolved" },
      { priorIssueId: prior.id, status: "resolved" },
    ],
  }, revision, previousContent, content), /缺少有效/);
});

test("本地修订约束覆盖动态包截断后的全部变更范围", () => {
  const previousParagraphs = Array.from({ length: 26 }, (_value, index) =>
    `第${index + 1}处，她按既定步骤核对记录。`);
  const revisedParagraphs = previousParagraphs.map((paragraph, index) =>
    index === 25
      ? "第26处，她凭空认出了从未见过的代号。"
      : `${paragraph}本轮已调整。`);
  const previousContent = `# 第一章\n\n${previousParagraphs.join("\n\n")}`;
  const content = `# 第一章\n\n${revisedParagraphs.join("\n\n")}`;
  const revision = buildChapterReviewRevisionContext({
    previousContent,
    content,
    previousSourceHash: "many-changes-before",
    priorBlockers: [],
  });
  assert.equal(revision.changes.length, 24);

  const constrained = constrainChapterRevisionReview({
    verdict: "revise",
    chapterChange: "多处最小修订",
    reviewNotes: "第 26 处引入认知越界",
    issues: [{
      severity: "blocker",
      kind: "knowledge_leak",
      sceneId: "document",
      evidence: ["她凭空认出了从未见过的代号。"],
      problem: "角色没有获得代号的路径",
      action: "删除代号或补充可感知来源",
      origin: "introduced_by_revision",
    }],
  }, revision, previousContent, content);

  assert.equal(constrained.verdict, "revise");
  assert.equal(constrained.issues[0]?.severity, "blocker");
  assert.equal(constrained.issues[0]?.origin, "introduced_by_revision");
});

test("删除获知前提时以经完整 diff 验证的 changeEvidence 支撑新 blocker", () => {
  const deletedPremise = "她从值班记录中读到了陌生人的代号。";
  const visibleLeak = "她看见来人，立刻准确喊出了那个代号。";
  const unchangedAside = "窗外仍在下雨。";
  const previousContent = `# 第一章\n\n${deletedPremise}\n\n${visibleLeak}\n\n${unchangedAside}`;
  const content = `# 第一章\n\n${visibleLeak}\n\n${unchangedAside}`;
  const revision = buildChapterReviewRevisionContext({
    previousContent,
    content,
    previousSourceHash: "premise-present",
    priorBlockers: [],
  });
  const parsed = parseChapterReview(review([{
    severity: "blocker",
    kind: "knowledge_leak",
    sceneId: "s1",
    evidence: [visibleLeak],
    changeEvidence: [deletedPremise],
    problem: "修订删除了角色获知代号的唯一路径",
    action: "恢复获知路径或删除角色对代号的使用",
    origin: "introduced_by_revision",
  }]), SCENES, content);
  const constrained = constrainChapterRevisionReview(parsed, revision, previousContent, content);
  assert.equal(constrained.verdict, "revise");
  assert.equal(constrained.issues[0]?.severity, "blocker");
  assert.deepEqual(constrained.issues[0]?.changeEvidence, [deletedPremise]);

  const invalidEvidence = constrainChapterRevisionReview({
    ...parsed,
    issues: parsed.issues.map(issue => ({ ...issue, changeEvidence: [unchangedAside] })),
  }, revision, previousContent, content);
  assert.equal(invalidEvidence.verdict, "pass");
  assert.equal(invalidEvidence.issues[0]?.severity, "warning");
  assert.equal(invalidEvidence.issues[0]?.changeEvidence, undefined);
});

test("修订复审保持 system 前缀不变并只在 user JSON 增加动态包", () => {
  const previousContent = "# 第一章\n\n旧句。";
  const content = "# 第一章\n\n新句。";
  const prior: ProposalRevisionIssue = {
    id: "issue:old",
    severity: "blocker",
    kind: "seam",
    evidence: ["旧句。"],
    problem: "接续断裂",
    action: "补足因果",
  };
  const common = {
    chapterGoal: "补足接续",
    content,
    context: "稳定项目约束",
    scenes: [{ sceneId: "document", title: "第一章", plannedTurn: "变化", plannedOutcome: "成立", actualState: null }],
  };
  const first = buildChapterReviewMessages(common);
  const retry = buildChapterReviewMessages({
    ...common,
    revisionReview: buildChapterReviewRevisionContext({
      previousContent,
      content,
      previousSourceHash: "old-hash",
      priorBlockers: [prior],
    }),
    revisionBaselineContent: previousContent,
  });
  assert.equal(retry[0].content, first[0].content);
  assert.equal(retry[1].content, first[1].content);
  const payload = JSON.parse(retry[2].content) as Record<string, unknown>;
  assert.ok(payload.revisionReview);
  assert.equal("revisionBaselineContent" in payload, false);
  assert.match(retry[2].content, /changeEvidence/);
  assert.match(retry[2].content, /priorBlockerDispositions/);
});
