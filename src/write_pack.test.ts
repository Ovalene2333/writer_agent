import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compileWritePack,
  findProseMetaLeaks,
  formatWritePackForWriter,
  sanitizeDiegeticText,
  sanitizeProseMetaLeaks,
  writePackDraftContractPrompt,
} from "./write_pack.js";
import {
  assembleChapterSceneDraft,
  beginChapterSceneDraft,
  blockChapterSceneReview,
  chapterSceneDraftComplete,
  resolveChapterSceneReview,
  reviseChapterDraftStyle,
  reviseChapterSceneGuide,
  writeChapterScene,
} from "./scene_pipeline.js";
import { emptyCharacter } from "./characters.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { executeTool } from "./tools/execute.js";
import { handleBeginChapterDraft } from "./tools/scene_pipeline.js";
import {
  FINAL_PROSE_GATE_TIMEOUT_MS,
  PRIMARY_PROSE_GATE_TIMEOUT_MS,
  proseGateReviewTimeoutMs,
  submitFullDocumentProposal,
} from "./tools/proposals.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { ChapterReviewRequestError } from "./chapter_review.js";
import { proposalRevisionIssueId, proposalRevisionScopeKey } from "./proposal_retry.js";
import { documentSpans } from "./document_spans.js";
import type { AgentEvent } from "./types.js";

test("fail-closed prose gate gives the final reviewer a full-chapter timeout", () => {
  assert.equal(proseGateReviewTimeoutMs(0, 2), PRIMARY_PROSE_GATE_TIMEOUT_MS);
  assert.equal(proseGateReviewTimeoutMs(1, 2), FINAL_PROSE_GATE_TIMEOUT_MS);
  assert.equal(proseGateReviewTimeoutMs(0, 1), FINAL_PROSE_GATE_TIMEOUT_MS);
  assert.ok(FINAL_PROSE_GATE_TIMEOUT_MS > PRIMARY_PROSE_GATE_TIMEOUT_MS);
});

test("sanitizeDiegeticText rewrites 序章 meta into story-world phrasing", () => {
  const { text, stripped } = sanitizeDiegeticText("比序章里预估的还高了零点七。");
  assert.equal(text, "比先前预估的还高了零点七。");
  assert.ok(stripped.some(tag => tag.includes("序章")));
});

test("sanitizeDiegeticText strips path and draft chrome", () => {
  const { text, stripped } = sanitizeDiegeticText(
    "见 chapters/序章.md 与 lore/world.md；写作前草案写明资料已确认。",
    { targetPath: "chapters/第一章.md" },
  );
  assert.doesNotMatch(text, /chapters\/|lore\/|写作前草案|资料已确认/u);
  assert.ok(stripped.length >= 2);
});

test("compileWritePack parses structured draft sections", () => {
  const draft = `## 场景目标
苏醒后听李彦通报指标。

## 人物当下
- 千夏刚恢复意识
- 李彦克制、信息量控得很死

## 事件顺序
1. 通报质量与适应度
2. 千夏对照门缝里那句预估
3. 追问编号

## 已知事实
- 精神适应度预估曾为百分之九十八以上
- 实测百分之九十八点七

## 须自然落地
- 她是第三号

## 勿擅自补写
- 第四号下落

## 叙述提醒
- 短句，少解释
`;
  const pack = compileWritePack(draft, { targetPath: "chapters/第一章.md" });
  assert.equal(pack.structured, true);
  assert.match(pack.sceneGoal, /苏醒/);
  assert.equal(pack.beatOrder.length, 3);
  assert.ok(pack.knownFacts.some(item => item.includes("九十八")));
  assert.ok(pack.mustLand.some(item => item.includes("第三号")));
  assert.ok(pack.doNotInvent.some(item => item.includes("第四号")));
  assert.deepEqual(pack.narrationNotes, ["短句，少解释"]);
  assert.match(formatWritePackForWriter(pack), /【叙述提醒】/u);
});

test("scene viewpoint and knowledge gates compile into hard constraints", () => {
  const pack = compileWritePack(`## 本场视角
千夏。贴着她，只写她能看到和听到的。

## 认知边界
- 千夏 | 知道=自己是第三号 | 不知道=第四号的下落；李彦收到过撤离令 | 在隐瞒=她昨夜私自读了值班记录
- 李彦 | 知道=撤离令已下达 | 不知道=千夏读过值班记录 | 在隐瞒=撤离令的签发人
`);
  assert.equal(pack.structured, true);
  assert.match(pack.viewpoint ?? "", /千夏/u);
  assert.equal(pack.knowledgeGates?.length, 2);
  assert.deepEqual(pack.knowledgeGates?.[0].unknown, ["第四号的下落", "李彦收到过撤离令"]);
  assert.deepEqual(pack.knowledgeGates?.[1].concealing, ["撤离令的签发人"]);
  const formatted = formatWritePackForWriter(pack);
  assert.match(formatted, /【本场视角】/u);
  assert.match(formatted, /【认知边界】[\s\S]*不知道：第四号的下落、李彦收到过撤离令/u);
  assert.match(formatted, /硬约束是【已成立的事实】【须自然落地】【勿擅自补写】【本场视角】【认知边界】/u);
});

test("knowledge gate rows without an epistemic field are dropped", () => {
  const pack = compileWritePack("## 认知边界\n- 千夏 | 备注=只是个名字\n");
  assert.equal(pack.knowledgeGates, undefined);
  const formatted = formatWritePackForWriter(pack);
  // The heading itself must not fall through into 情节提要 as raw draft chrome.
  assert.doesNotMatch(formatted, /千夏|备注/u);
  assert.doesNotMatch(formatted, /【认知边界】\n/u);
});

test("structured beats replace the event list and become the length knob", () => {
  const pack = compileWritePack(`## 事件顺序
- 意图=李彦想在不解释原因的情况下让千夏签字 | 尝试=他把表格推过来只说例行 | 阻碍=千夏没有接笔，反而看向日期栏
- 意图=千夏想确认第四号还在 | 尝试=她问起同批的适应度 | 阻碍=李彦答的是全批平均值
- 意图=李彦想结束这场谈话 | 尝试=他起身去关百叶窗 | 阻碍=窗外正好停着一辆没有编号的车
`);
  assert.equal(pack.beats?.length, 3);
  assert.equal(pack.beats?.[1].obstacle, "李彦答的是全批平均值");
  const formatted = formatWritePackForWriter(pack);
  assert.match(formatted, /【本场节拍】共 3 拍/u);
  assert.match(formatted, /拍数是篇幅旋钮，不是字数/u);
  assert.doesNotMatch(formatted, /【推进顺序】/u);
});

test("unstructured event rows keep the legacy beat order", () => {
  const pack = compileWritePack("## 事件顺序\n1. 通报指标\n2. 追问编号\n");
  assert.equal(pack.beats, undefined);
  assert.equal(pack.beatOrder.length, 2);
  assert.match(formatWritePackForWriter(pack), /【推进顺序】/u);
});

test("draft contract asks for a viewpoint, knowledge gates and beat rows", () => {
  const prompt = writePackDraftContractPrompt();
  assert.match(prompt, /## 本场视角/u);
  assert.match(prompt, /## 认知边界/u);
  assert.match(prompt, /知道=… \| 不知道=… \| 在隐瞒=…/u);
  assert.match(prompt, /每场 3—5 拍/u);
  assert.match(prompt, /意图=… \| 尝试=… \| 阻碍=…/u);
});

test("compileWritePack separates fact precision from contextual realization", () => {
  const pack = compileWritePack(`## 已知事实
- 千夏的神经组织仍在工作
- 皮层完整度为百分之九十八点三

## 表达边界
- 千夏的神经组织仍在工作 | 用途=表现超频后的不适 | 精度=sensory | 叙述=写成发胀、发灰或困意 | 对白=我还醒着 | 技术对白=皮层清醒 | 避免=旁白反复点名皮层
`);
  assert.equal(pack.factAtoms?.length, 2);
  assert.equal(pack.factAtoms?.[0]?.precision, "sensory");
  assert.equal(pack.factAtoms?.[1]?.precision, "normal");
  assert.equal(pack.realizationBoundaries?.length, 1);
  assert.equal(pack.realizationBoundaries?.[0]?.precision, "sensory");
  assert.match(formatWritePackForWriter(pack), /普通对白倾向：我还醒着/u);
  assert.match(formatWritePackForWriter(pack), /不是固定替换表/u);
});

test("malformed realization boundary falls back without changing legacy facts", () => {
  const pack = compileWritePack(`## 已知事实
- 她仍然清醒

## 表达边界
- 这不是结构化表达边界
`);
  assert.deepEqual(pack.knownFacts, ["她仍然清醒"]);
  assert.equal(pack.realizationBoundaries?.length, 0);
  assert.doesNotMatch(formatWritePackForWriter(pack), /这不是结构化表达边界/u);
});

test("generic voice headings never enter the global write pack", () => {
  const pack = compileWritePack("## 声线\n- 闻溪面对追问会用短句回避。\n");
  assert.deepEqual(pack.narrationNotes, []);
  assert.doesNotMatch(formatWritePackForWriter(pack), /闻溪|追问|短句/u);
  assert.equal("voiceNotes" in pack, false);
});

test("compileWritePack rewrites 序章 inside known facts", () => {
  const draft = `## 已知事实
比序章里预估的还高了零点七。
`;
  const pack = compileWritePack(draft);
  assert.ok(pack.knownFacts.every(item => !item.includes("序章")));
  assert.ok(pack.knownFacts.some(item => item.includes("比先前")));
  assert.ok(pack.strippedMeta.length > 0);
});

test("formatWritePackForWriter does not expose draft chrome or paths", () => {
  const pack = compileWritePack(`## 场景目标
醒来听指标。

## 已知事实
比序章里预估的还高了零点七。
`);
  const formatted = formatWritePackForWriter(pack);
  assert.match(formatted, /本场写作材料/);
  assert.match(formatted, /【本场方向】/);
  assert.match(formatted, /不是逐项展开的作文提纲/);
  assert.doesNotMatch(formatted, /比序章|写作前草案|chapters\//u);
  assert.doesNotMatch(formatted, /【已成立的事实】[\s\S]*序章/u);
  assert.match(formatted, /比先前/);
});

test("unstructured draft falls back to sanitized narrativeBrief", () => {
  const pack = compileWritePack("自由文本：比序章里预估的还高了零点七。不要写成清单。");
  assert.equal(pack.structured, false);
  assert.match(pack.narrativeBrief, /比先前/);
  assert.doesNotMatch(pack.narrativeBrief, /序章/u);
});

test("writePackDraftContractPrompt forbids chapter labels", () => {
  const prompt = writePackDraftContractPrompt();
  assert.match(prompt, /场景目标/);
  assert.match(prompt, /禁止出现/);
  assert.match(prompt, /序章/);
  assert.match(prompt, /角色对白必须回到该角色的原始角色卡读取/);
  assert.match(prompt, /不得写某个角色的说话方式、口头禅、句长或对白示例/);
});

test("sanitizeProseMetaLeaks preserves chapter titles but fixes referential leaks", () => {
  const body = "# 序章\n\n比序章里预估的还高了零点七。\n";
  const { text, stripped } = sanitizeProseMetaLeaks(body);
  assert.match(text, /^# 序章/u);
  assert.match(text, /比先前预估的还高了零点七/u);
  assert.doesNotMatch(text, /比序章/u);
  assert.ok(stripped.length > 0);
  assert.deepEqual(findProseMetaLeaks(text), []);
});

test("findProseMetaLeaks flags residual document referents", () => {
  assert.ok(findProseMetaLeaks("他想起大纲里的安排。").includes("大纲指称"));
  assert.ok(findProseMetaLeaks("见 chapters/foo.md").includes("分区路径"));
});

test("findProseMetaLeaks flags character-card unlock inventory diction", () => {
  const line = "不是「霜烬」，不是「鸣雷」——档案上的专属武装还锁着。";
  const hits = findProseMetaLeaks(line);
  assert.ok(hits.some(tag => tag.includes("档案") || tag.includes("双否定") || tag.includes("卡面") || tag.includes("未解锁") || tag.includes("锁")));
  assert.ok(findProseMetaLeaks(line).length >= 1);
});

const sceneChain = [
  {
    id: "arrival",
    title: "迟到",
    goal: "让主角进入封闭训练区",
    entryState: ["主角相信这只是常规训练"],
    characterIntent: ["主角想尽快证明自己", "教官想观察她是否服从"],
    obstacle: "通行证被临时冻结",
    turn: "冻结命令来自主角父亲",
    outcome: "主角绕过教官独自进入",
    readerQuestion: "父亲为什么要把她挡在训练区外",
    cost: "主角失去了合法进入的资格，记录已经留下",
    oppositionMove: "教官提前调走了她的通行权限",
    handoff: "违规进入触发警报，把双方送入同一场处置",
  },
  {
    id: "alarm",
    title: "警报",
    goal: "迫使主角在任务与同伴之间选择",
    entryState: ["主角已经违规", "教官必须决定是否上报"],
    characterIntent: ["主角想继续训练", "教官想控制损失"],
    obstacle: "训练靶被警报切换成实弹防卫",
    turn: "教官为保护主角主动承担违规责任",
    outcome: "训练取消，但两人的关系由审视变成秘密共担",
    readerQuestion: "教官替她担下的责任要用什么偿还",
    cost: "教官的记录上多了一次不可撤销的违规担保",
    oppositionMove: "防卫系统切换实弹，把选择时间压到最短",
    handoff: "",
    dividerBefore: true,
  },
];

function actualState(label: string) {
  return {
    situation: [label], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
  };
}

test("chapter scene pipeline assembles causal scenes without writing partial documents", () => {
  let draft = beginChapterSceneDraft({
    path: "chapters/第一章.md",
    mode: "create",
    heading: "第一章",
    chapterGoal: "主角与教官从互相审视变成共同隐瞒一次违规",
    baseContent: "",
    baseHash: "empty",
    scenes: sceneChain,
  });
  assert.equal(draft.completed.length, 0);
  draft = writeChapterScene(draft, "arrival", "门禁灯从绿变红。".repeat(20), actualState("主角违规进入训练区")).draft;
  assert.equal(chapterSceneDraftComplete(draft), false);
  draft = writeChapterScene(draft, "alarm", "警报在合金墙间响起。".repeat(20), actualState("教官替主角承担违规责任")).draft;
  assert.equal(chapterSceneDraftComplete(draft), true);
  const chapter = assembleChapterSceneDraft(draft);
  assert.match(chapter, /^# 第一章/u);
  assert.match(chapter, /\n\n---\n\n/u);
  assert.match(chapter, /\n## 迟到\n\n门禁灯/u);
  assert.match(chapter, /---\n\n## 警报\n\n/u);
  assert.match(chapter, /门禁灯/u);
  assert.match(chapter, /警报/u);
  assert.throws(
    () => writeChapterScene(draft, "arrival", `## 自带标题\n\n${"门禁灯从绿变红。".repeat(20)}`, actualState("重写")),
    /markdown 标题/u,
  );
});

test("side prose treats scene count and target length as guidance", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-side-scene-pipeline-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "支线场景链");
    store = new WriterStore(project);
    const sessionId = store.createSession("展开支线片段");
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      scenePipelineSettings: {
        enabled: true,
        preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5,
        notesMaxCharacters: 3_000, candidateCount: 1,
      },
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, store!, sessionId, () => {}, undefined, context,
    );
    const makeScene = (index: number) => ({
      id: `side-${index}`,
      title: `支线场景 ${index}`,
      goal: `推动支线变化 ${index}`,
      obstacle: `形成直接阻力 ${index}`,
      turn: `产生局面转折 ${index}`,
      outcome: `留下实际结果 ${index}`,
      readerQuestion: `留下未答问题 ${index}`,
      cost: `付出不可撤销的代价 ${index}`,
      oppositionMove: `阻力方主动出手 ${index}`,
      handoff: index === 3 ? "" : `结果迫使人物进入场景 ${index + 1}`,
      targetCharacters: 2_000,
    });

    const begun = JSON.parse(await call("begin_chapter_draft", {
      path: "side/arc-08.md", mode: "create", heading: "ARC-08", chapterGoal: "城邦覆灭",
      scenes: [{ ...makeScene(1), targetCharacters: undefined }],
    })) as Record<string, unknown>;
    assert.equal(begun.status, "started");
    assert.equal(begun.sceneCount, 1);
    const written = writeChapterScene(
      context.chapterSceneDraft!, "side-1", "她向城门走去。".repeat(30), actualState("她抵达城门"),
    );
    assert.equal(written.draft.completed.length, 1);

    const direct = JSON.parse(await call("propose_document", {
      path: "side/arc-08.md",
      content: "她走到城门下，守卫从阴影里抬起长枪。风卷着灰烬越过墙头，她没有停，只把通行牌放在掌心。",
      targetCharacters: 500,
      summary: "直接交付支线片段",
    })) as Record<string, unknown>;
    assert.equal(direct.status, "pending", JSON.stringify(direct));
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct chapter proposal preserves reviewer knowledge blockers before creating a proposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-direct-review-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "事实终审");
    store = new WriterStore(project);
    const sessionId = store.createSession("直接整章");
    let shouldBlock = true;
    let reviewCalls = 0;
    let sawRevisionReview = false;
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      runId: "run-direct-review",
      proposalReviewRevisions: new Map(),
      readSnapshots: new Map(),
      chapterReviewer: {
        model: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "reviewer-test" },
        context: "项目终审约束",
        run: async (_model, input) => {
          reviewCalls += 1;
          sawRevisionReview ||= Boolean(input.revisionReview);
          assert.match(input.context ?? "", /项目终审约束/u);
          return {
            review: shouldBlock ? {
              verdict: "revise" as const,
              chapterChange: "来客试图进入北塔",
              reviewNotes: "来客越过了认知边界",
              issues: [{
                severity: "blocker" as const,
                kind: "knowledge_leak" as const,
                sceneId: "document",
                evidence: ["来客径直说密钥藏在钟摆里。"],
                problem: "该事实仅守塔人知晓，正文没有来客获知它的路径",
                action: "补入获知路径或删除准确断言",
              }],
            } : {
              verdict: "pass" as const,
              chapterChange: "来客从试探转为撤退",
              reviewNotes: "事实与认知路径一致",
              issues: [],
              ...(input.revisionReview ? {
                priorBlockerDispositions: input.revisionReview.priorBlockers.map(item => ({
                  priorIssueId: item.id,
                  status: "resolved" as const,
                })),
              } : {}),
            },
          };
        },
      },
    };
    const args = {
      input: {}, project, store, sessionId, emit: (_event: AgentEvent) => {}, context,
    };
    const content = "# 第一章\n\n来客径直说密钥藏在钟摆里。";
    const blocked = JSON.parse(await submitFullDocumentProposal(
      args, "chapters/第一章.md", content, "来客试探北塔", undefined, true,
    )) as Record<string, unknown>;
    assert.equal(blocked.code, "DIRECT_CHAPTER_REVIEW_BLOCKED");
    assert.equal(store.proposals().length, 0);

    const blockedReview = blocked.chapterReview as { issues: Array<Record<string, unknown>> };
    const blocker = blockedReview.issues[0];
    const issue = {
      id: proposalRevisionIssueId({
        kind: String(blocker.kind),
        evidence: blocker.evidence as string[],
        problem: String(blocker.problem),
      }),
      severity: "blocker",
      kind: String(blocker.kind),
      evidence: blocker.evidence as string[],
      problem: String(blocker.problem),
      action: String(blocker.action),
    };
    context.proposalReviewRevisions!.set(proposalRevisionScopeKey({
      runId: context.runId!, path: "chapters/第一章.md",
    }), {
      runId: context.runId!,
      path: "chapters/第一章.md",
      previousContent: content,
      previousSourceHash: project.hash(content),
      unresolvedIssues: [issue],
    });
    const unchanged = JSON.parse(await submitFullDocumentProposal(
      args, "chapters/第一章.md", content, "来客试探北塔", undefined, true,
    )) as Record<string, unknown>;
    assert.equal(unchanged.code, "DIRECT_CHAPTER_REVIEW_BLOCKED");
    assert.equal(reviewCalls, 1, "identical rejected body must reuse the prior blockers");

    shouldBlock = false;
    const revisedContent = "# 第一章\n\n来客只问钟摆是否需要检修。";
    const passed = JSON.parse(await submitFullDocumentProposal(
      args, "chapters/第一章.md", revisedContent, "来客试探北塔", undefined, true,
    )) as Record<string, unknown>;
    assert.equal(passed.status, "pending");
    assert.equal(store.proposals().length, 1);
    assert.equal(reviewCalls, 2);
    assert.equal(sawRevisionReview, true);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct chapter proposal rejects a document modified while final review is running", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-review-base-race-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "终审基线竞态");
    store = new WriterStore(project);
    const sessionId = store.createSession("终审基线竞态");
    const path = "chapters/chapter-001.md";
    const externallyModified = "# 第一章\n\n另一任务在终审期间写入的正文。";
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      chapterReviewer: {
        model: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "reviewer-test" },
        run: async () => {
          project.writeRaw(path, externallyModified);
          return {
            review: {
              verdict: "pass" as const,
              chapterChange: "完成正文",
              reviewNotes: "通过",
              issues: [],
            },
          };
        },
      },
    };
    const result = JSON.parse(await submitFullDocumentProposal(
      {
        input: {}, project, store, sessionId,
        emit: (_event: AgentEvent) => {}, context,
      },
      path,
      "# 第一章\n\n来客在雨里推开门，向昏暗的走廊深处走去。",
      "来客进入走廊",
      undefined,
      true,
    )) as Record<string, unknown>;

    assert.deepEqual(result, {
      status: "recoverable_state_error",
      code: "PROPOSAL_DOCUMENT_BASE_CHANGED",
      failureKind: "invalid_request",
      retryable: false,
      path,
      error: "终审期间目标文档已变化，未创建提案。请重新读取当前文档并基于最新版本处理。",
    });
    assert.equal(store.proposals().length, 0);
    assert.equal(project.read(path), externallyModified);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct proposal repairs sparse hard style blockers before creating the proposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-proposal-style-repair-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "提案局部句式修订");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("提案局部句式修订");
    let repairCalls = 0;
    const replacements = new Map([
      ["这不是训练。是处决。", "训练场已经成了处决台。"],
      ["那不是撤退。是蓄力。", "撤退把队伍带到下一道防线。"],
      ["这不是失败。是延期。", "失败被记进延期表。"],
      ["那不是命令。是诱导。", "命令在扩音器里绕成诱导。"],
      ["这不是回应。是噪声。", "回应被噪声吞没。"],
      ["那不是终点。是入口。", "终点后面露出新的入口。"],
    ]);
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      editScope: "document",
      chapterStyleRepairer: {
        model: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "repair-test" },
        run: async (_model, input) => {
          repairCalls += 1;
          assert.equal(input.issues.length, 6);
          return {
            edits: input.issues.map(issue => ({
              search: issue.sentence,
              replace: replacements.get(issue.sentence) ?? issue.sentence,
            })),
            requestCharacters: 500,
          };
        },
      },
    };
    const content = [
      "# 样章",
      "",
      "这不是训练。是处决。",
      "那不是撤退。是蓄力。",
      "这不是失败。是延期。",
      "那不是命令。是诱导。",
      "这不是回应。是噪声。",
      "那不是终点。是入口。",
    ].join("\n");

    const result = JSON.parse(await submitFullDocumentProposal(
      {
        input: {}, project, store: activeStore, sessionId,
        emit: (_event: AgentEvent) => {}, context,
      },
      "lore/style.md",
      content,
      "验证提案前局部句式修订",
      undefined,
    )) as Record<string, unknown>;

    assert.equal(result.status, "pending");
    assert.equal(repairCalls, 1);
    assert.deepEqual(result.styleAutoRepaired, {
      attempts: 1,
      edits: 6,
      initialBlockers: 6,
    });
    const proposal = activeStore.proposal(Number(result.proposalId));
    assert.doesNotMatch(proposal.afterContent, /这不是训练|那不是撤退|这不是失败|那不是命令|这不是回应|那不是终点/u);
    assert.match(proposal.afterContent, /训练场已经成了处决台/u);
    assert.match(proposal.afterContent, /终点后面露出新的入口/u);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rhythm risk goes through semantic review instead of a numeric repair gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-rhythm-review-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "节奏分阶段终审");
    store = new WriterStore(project);
    const sessionId = store.createSession("节奏分阶段终审");
    let reviewCalls = 0;
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      rhythmGracePaths: new Set(),
      chapterReviewer: {
        model: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "reviewer-test" },
        run: async () => {
          reviewCalls += 1;
          return {
            review: {
              verdict: "pass" as const,
              chapterChange: "完成短句草稿",
              reviewNotes: "通过",
              issues: [],
            },
          };
        },
      },
    };
    const args = {
      input: {}, project, store, sessionId, emit: (_event: AgentEvent) => {}, context,
    };
    const shortDraft = `# 第一章\n\n${"雨停了。风又起。灯还亮。门没开。\n\n".repeat(80)}`;
    const result = JSON.parse(await submitFullDocumentProposal(
      args, "chapters/第一章.md", shortDraft, "短句节奏草稿", undefined,
    )) as Record<string, unknown>;

    assert.equal(result.status, "pending");
    assert.equal(result.code, undefined);
    assert.equal(reviewCalls, 1);
    assert.equal(store.proposals().length, 1);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Agent can reshape the unwritten scene guide without changing completed prose", () => {
  let draft = beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变",
    baseContent: "", baseHash: "empty", scenes: [sceneChain[0]], maxScenes: 5,
  });
  draft = writeChapterScene(
    draft, "arrival", "门禁灯从绿变红。".repeat(20), actualState("主角进入训练区"),
  ).draft;
  const completedBefore = draft.completed[0];

  const expanded = reviseChapterSceneGuide(draft, [{
    ...sceneChain[1], id: "argument", title: "争执", goal: "两人公开冲突",
    readerQuestion: "教官会不会把这件事上报", handoff: "冲突引来教官",
  }, {
    ...sceneChain[1], id: "choice", title: "选择", goal: "主角作出选择", turn: "教官拒绝代为决定", outcome: "主角承担后果",
    readerQuestion: "她承担后果之后还剩哪条路",
  }], 5);
  assert.equal(expanded.draft.completed[0], completedBefore);
  assert.deepEqual(expanded.addedSceneIds, ["argument", "choice"]);
  assert.deepEqual(expanded.removedSceneIds, []);
  assert.equal(expanded.draft.scenes[1].id, "argument");
  assert.equal(chapterSceneDraftComplete(expanded.draft), false);

  const finished = reviseChapterSceneGuide(expanded.draft, [], 5);
  assert.deepEqual(finished.removedSceneIds, ["argument", "choice"]);
  assert.equal(chapterSceneDraftComplete(finished.draft), true);

  const reopened = reviseChapterSceneGuide(finished.draft, [{
    ...sceneChain[1], id: "aftermath", title: "余波", goal: "让选择产生即时后果",
  }], 5);
  assert.equal(reopened.draft.scenes.at(-1)?.id, "aftermath");
  assert.equal(chapterSceneDraftComplete(reopened.draft), false);
});

test("revising an earlier scene invalidates dependent later scenes", () => {
  let draft = beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变",
    baseContent: "", baseHash: "empty", scenes: sceneChain,
  });
  draft = writeChapterScene(draft, "arrival", "旧版本场景。".repeat(20), actualState("旧变化")).draft;
  draft = writeChapterScene(draft, "alarm", "后续场景。".repeat(20), actualState("后续变化")).draft;
  const revised = writeChapterScene(draft, "arrival", "新版本场景。".repeat(20), actualState("新变化"));
  assert.deepEqual(revised.invalidatedSceneIds, ["alarm"]);
  assert.equal(revised.draft.completed.length, 1);
  assert.equal(revised.draft.inspectedVersion, undefined);
});

test("semantic review cycle locks repair scope and tracks the repaired draft version", () => {
  let draft = beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变",
    baseContent: "", baseHash: "empty", scenes: sceneChain,
  });
  draft = writeChapterScene(draft, "arrival", "旧版本场景。".repeat(20), actualState("旧变化")).draft;
  draft = writeChapterScene(draft, "alarm", "后续场景。".repeat(20), actualState("后续变化")).draft;
  const baseline = assembleChapterSceneDraft(draft);
  draft = blockChapterSceneReview({
    draft,
    baselineContent: baseline,
    baselineSourceHash: "reviewed-v2",
    issues: [{
      id: "issue:knowledge",
      severity: "blocker",
      kind: "knowledge_leak",
      sceneId: "arrival",
      evidence: ["旧版本场景"],
      problem: "人物没有获知路径",
      action: "删除无来源断言",
    }],
  });

  assert.throws(
    () => writeChapterScene(draft, "alarm", "绕过目标场景。".repeat(20), actualState("绕过")),
    /目标场景.*arrival/u,
  );
  const repaired = writeChapterScene(
    draft,
    "arrival",
    "修订后的场景。".repeat(20),
    actualState("修订变化"),
  );
  assert.equal(repaired.draft.reviewCycle?.status, "repairing");
  assert.equal(repaired.draft.reviewCycle?.repairAttempts, 1);
  assert.deepEqual(repaired.invalidatedSceneIds, ["alarm"]);
  assert.equal(repaired.draft.reviewCycle?.baselineContent, baseline);

  const resolved = resolveChapterSceneReview(repaired.draft, ["issue:knowledge"]);
  assert.equal(resolved.reviewCycle?.status, "resolved");
  assert.deepEqual(resolved.reviewCycle?.unresolvedIssues, []);
  assert.deepEqual(resolved.reviewCycle?.resolvedIssueIds, ["issue:knowledge"]);
});

test("prose-only chapter draft edits preserve later scenes and state", () => {
  let draft = beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变",
    baseContent: "", baseHash: "empty", scenes: sceneChain,
  });
  draft = writeChapterScene(
    draft,
    "arrival",
    `${"门禁灯从绿变红。".repeat(20)}\n\n她不是害怕。是在计算距离。`,
    actualState("主角违规进入训练区"),
  ).draft;
  draft = writeChapterScene(
    draft,
    "alarm",
    "警报在合金墙间响起。".repeat(20),
    actualState("教官替主角承担违规责任"),
  ).draft;
  const statesBefore = draft.completed.map(scene => scene.actualState);
  const revised = reviseChapterDraftStyle(draft, [{
    search: "她不是害怕。是在计算距离。",
    replace: "她盯着门框，默算两步距离。",
  }]);
  assert.deepEqual(revised.editedSceneIds, ["arrival"]);
  assert.deepEqual(revised.preservedSceneIds, ["alarm"]);
  assert.equal(revised.draft.completed.length, 2);
  assert.deepEqual(revised.draft.completed.map(scene => scene.actualState), statesBefore);
  assert.match(revised.draft.completed[0].content, /默算两步距离/u);
  assert.match(revised.draft.completed[1].content, /警报/u);
  assert.equal(revised.draft.inspectedVersion, undefined);
});

test("scene pipeline rejects empty state change and repeated scene functions", () => {
  const draft = beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变",
    baseContent: "", baseHash: "empty", scenes: sceneChain,
  });
  assert.throws(() => writeChapterScene(draft, "arrival", "只有动作。".repeat(20), {
    situation: [], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
  }), /实际局面变化/);
  assert.throws(() => beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "变化",
    baseContent: "", baseHash: "empty", scenes: [sceneChain[0], {
      ...sceneChain[1], goal: sceneChain[0].goal, turn: sceneChain[0].turn, outcome: sceneChain[0].outcome,
    }],
  }), /完全重复/);
  assert.throws(() => beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "变化",
    baseContent: "", baseHash: "empty",
    scenes: Array.from({ length: 6 }, (_, index) => ({
      ...sceneChain[0],
      id: `scene-${index + 1}`,
      goal: `目标 ${index + 1}`,
      turn: `转折 ${index + 1}`,
      outcome: `结果 ${index + 1}`,
      handoff: index === 5 ? "" : `交给场景 ${index + 2}`,
    })),
  }), /1—5/);

  const expanded = beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "变化",
    baseContent: "", baseHash: "empty", maxScenes: 7,
    scenes: Array.from({ length: 6 }, (_, index) => ({
      ...sceneChain[0],
      id: `expanded-${index + 1}`,
      goal: `扩展目标 ${index + 1}`,
      turn: `扩展转折 ${index + 1}`,
      outcome: `扩展结果 ${index + 1}`,
      readerQuestion: `扩展未答问题 ${index + 1}`,
      handoff: index === 5 ? "" : `交给扩展场景 ${index + 2}`,
    })),
  });
  assert.equal(expanded.scenes.length, 6);
});

test("scene guides retain source-linked capability scopes and reject ambiguous entries", () => {
  const scoped = beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "变化",
    baseContent: "", baseHash: "empty",
    scenes: [{
      ...sceneChain[0],
      characterScopes: [{ characterId: 7, competencyIds: ["track"], dialogue: true }],
    }],
  });
  assert.deepEqual(scoped.scenes[0].characterScopes, [{
    characterId: 7,
    competencyUses: [{ competencyId: "track", mode: "use" }],
    competencyIds: ["track"],
    dialogue: true,
  }]);
  assert.throws(() => beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "变化",
    baseContent: "", baseHash: "empty",
    scenes: [{
      ...sceneChain[0],
      characterScopes: [
        { characterId: 7, competencyIds: ["track"] },
        { characterId: 7, competencyIds: ["climb"] },
      ],
    }],
  }), /不能重复角色/u);
  assert.throws(() => beginChapterSceneDraft({
    path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "变化",
    baseContent: "", baseHash: "empty",
    scenes: [{
      ...sceneChain[0],
      characterScopes: [{ characterId: 7, competencyIds: [] }],
    }],
  }), /至少选择/u);
});

test("scene guide requires a lifecycle mode for unavailable abilities and still rejects inaccessible cards", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-scene-capability-scope-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "能力范围");
    store = new WriterStore(project);
    const activeStore = store;
    const character = activeStore.saveCharacter({
      ...emptyCharacter("学员"),
      competencies: [{
        id: "sealed", name: "封存协议", summary: "尚不能使用", level: "", unlocked: false,
        description: "", resources: [], limitations: ["未解锁"], costs: [],
      }],
    });
    const input = {
      path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "变化",
      scenes: [{
        ...sceneChain[0],
        characterScopes: [{ characterId: character.id, competencyIds: ["sealed"] }],
      }],
    };
    assert.throws(() => handleBeginChapterDraft({
      input, project, store: activeStore, sessionId: activeStore.createSession("能力场景"), emit: () => undefined,
      characterScope: [character.id], context: { permissionMode: "auto" },
    }), /入场状态 unknown.*模式 use/u);
    const awakening = handleBeginChapterDraft({
      input: {
        ...input,
        scenes: [{
          ...input.scenes[0],
          characterScopes: [{
            characterId: character.id,
            competencyUses: [{ competencyId: "sealed", mode: "unlock" }],
          }],
        }],
      },
      project, store: activeStore, sessionId: activeStore.createSession("能力觉醒场景"), emit: () => undefined,
      characterScope: [character.id], context: { permissionMode: "auto" },
    });
    assert.match(awakening, /"status":"started"/u);
    assert.throws(() => handleBeginChapterDraft({
      input: {
        ...input,
        scenes: [{ ...input.scenes[0], characterScopes: [{ characterId: character.id + 1, competencyIds: ["sealed"] }] }],
      },
      project, store: activeStore, sessionId: activeStore.createSession("越界场景"), emit: () => undefined,
      characterScope: [character.id], context: { permissionMode: "auto" },
    }), /不可读/u);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("chapter scene tool compiles notes inline and submits only after inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-scene-pipeline-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "场景流水线");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("逐场写作");
    const evolvingCharacter = activeStore.saveCharacter(emptyCharacter("学员"));
    const chapterReviewUsage: Array<{ model: string; callKind: string }> = [];
    const emitted: AgentEvent[] = [];
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      scenePipelineSettings: {
        enabled: true,
        preferredMinScenes: 1, preferredMaxScenes: 3, maxScenes: 5,
        notesMaxCharacters: 3_000, candidateCount: 1,
      },
      modelUsageReporter: (model, _usage, meta) => {
        chapterReviewUsage.push({ model: model.model, callKind: meta.callKind });
      },
      chapterReviewer: {
        model: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "reviewer-test" },
        fallbackModel: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "writer-test" },
        run: async (model, input) => {
          assert.match(input.content, /^# 第一章/u);
          assert.match(input.content, /门禁灯/u);
          if (model.model === "reviewer-test") {
            throw new ChapterReviewRequestError(
              "终审 JSON 无法解析",
              { promptTokens: 700, completionTokens: 80, cacheHitTokens: 0, cacheMissTokens: 700 },
            );
          }
          return {
            review: {
              verdict: "pass" as const,
              chapterChange: "主角从服从转为违规",
              reviewNotes: "单场章无需接缝；目标与结果一致",
              issues: [],
            },
            usage: { promptTokens: 800, completionTokens: 120, cacheHitTokens: 0, cacheMissTokens: 800 },
          };
        },
      },
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, event => emitted.push(event), undefined, context,
    );
    const begun = JSON.parse(await call("begin_chapter_draft", {
      path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变", scenes: [sceneChain[0]],
    })) as Record<string, unknown>;
    assert.equal(begun.status, "started");
    assert.equal(begun.sceneCount, 1);
    assert.equal("scenes" in begun, false, "begin result must not echo the full scene chain");
    // The scene chain itself names the next step, so no planning tool sits between
    // begin_chapter_draft and the first scene.
    assert.match(String(begun.message), /write_chapter_scene/);
    const missingNotes = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival", content: "门禁灯变红。".repeat(20), actualState: actualState("违规进入"),
    })) as Record<string, unknown>;
    assert.match(String(missingNotes.error), /notes/);
    const oversizedNotes = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 事件顺序\n主角进入训练区。".repeat(400),
      content: "门禁灯变红。".repeat(20),
      actualState: actualState("违规进入"),
    })) as Record<string, unknown>;
    assert.match(String(oversizedNotes.error), /3000/);
    context.scenePipelineSettings!.notesMaxCharacters = 4_000;
    const relaxedNotes = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: `## 场景目标\n${"主角继续向前。".repeat(450)}`,
    })) as Record<string, unknown>;
    assert.doesNotMatch(String(relaxedNotes.error), /notes 过长/u);
    assert.match(String(relaxedNotes.error), /content/u);
    context.scenePipelineSettings!.notesMaxCharacters = 3_000;
    const denseStyle = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。\n## 已知事实\n门禁灯会在违规时变红。",
      content: [
        "走廊尽头有动静。不是埋伏。是逃跑。",
        "空气发涩。不是气体。是悬浮颗粒。",
        "地面反光。不是水。是油性液体。",
        "立柱在颤。不是塌方。是预埋装药。",
        "应急门沿着轨道落下，主角侧身挤进最后一道缝隙，鞋底在油膜上拖出半圈亮痕。",
      ].join(""),
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(denseStyle.status, "style_revision_required");
    assert.equal(denseStyle.code, "SCENE_STYLE_DENSE");
    assert.equal(context.chapterSceneDraft?.completed.length, 0);
    // AA repeats are auto-fixed in-tool: the deduped scene enters the draft directly.
    const duplicated = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。",
      content: `${"她沿着走廊走到尽头的门前。".repeat(2)}${Array.from({ length: 10 }, (_, index) =>
        `第${String.fromCharCode(65 + index)}区的警报灯保持沉默。`).join("")}`,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(duplicated.status, "written");
    const autoFixes = duplicated.autoFixes as { duplicateSentencesRemoved: string[] };
    assert.deepEqual(autoFixes.duplicateSentencesRemoved, ["她沿着走廊走到尽头的门前。"]);
    assert.equal(context.chapterSceneDraft?.completed.length, 1);
    assert.ok(!context.chapterSceneDraft?.completed[0].content.includes("她沿着走廊走到尽头的门前。她沿着走廊走到尽头的门前。"));
    // Same sceneId again = structural revision replacing the auto-fixed draft above.
    const sceneContent = `${Array.from({ length: 20 }, (_, index) =>
      `门禁灯第${String.fromCharCode(65 + index)}区从绿变红。`).join("")}\n\n她停下脚步。`;
    const written = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。\n## 已知事实\n门禁灯会在违规时变红。",
      content: sceneContent,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(written.complete, true);
    assert.equal(typeof written.writePackCharacters, "number");
    const auditedDraft = JSON.parse(await call("audit_prose_style", {
      path: "chapters/第一章.md",
    })) as Record<string, unknown>;
    assert.equal(auditedDraft.source, "chapter_draft");
    const draftHashBeforeRevision = auditedDraft.sourceHash;
    const styleRevised = JSON.parse(await call("revise_chapter_draft_style", {
      edits: [{ search: "她停下脚步。", replace: "她在红灯前停步。" }],
    })) as Record<string, unknown>;
    assert.equal(styleRevised.status, "style_revised");
    assert.deepEqual(styleRevised.invalidatedSceneIds, []);
    assert.equal(styleRevised.completedScenes, 1);
    // Inline re-gate: clean prose reports passed so the model skips a probe inspect.
    assert.equal(styleRevised.styleRecheck, "passed");
    assert.equal("styleBlockers" in styleRevised, false);
    const auditedRevisedDraft = JSON.parse(await call("audit_prose_style", {
      path: "chapters/第一章.md",
    })) as Record<string, unknown>;
    assert.equal(auditedRevisedDraft.source, "chapter_draft");
    assert.notEqual(auditedRevisedDraft.sourceHash, draftHashBeforeRevision);
    assert.equal("reused" in auditedRevisedDraft, false);
    const beforeInspect = JSON.parse(await call("propose_chapter_draft", {
      summary: "新建第一章", chapterChange: "关系改变", reviewNotes: "已检查",
    })) as Record<string, unknown>;
    assert.match(String(beforeInspect.error), /inspect_chapter_draft/);
    const inspectedRaw = await call("inspect_chapter_draft", {
      summary: "新建第一章",
      characterChanges: [{
        characterId: evolvingCharacter.id,
        reason: "正文中已经发生的变化",
        changes: [
          {
            op: "upsert_story_state",
            entry: { unanchored: true, label: "违规进入", description: "门禁转红后仍进入训练区" },
          },
          { op: "upsert_relationship", entry: { description: "缺少关系目标，应被隔离" } },
          { op: "add_experience", entry: { label: "越过门禁", description: "在红灯下进入训练区" } },
        ],
      }],
    });
    const inspected = JSON.parse(inspectedRaw) as Record<string, unknown>;
    const previews = emitted.filter(event => event.type === "text" && event.text.includes("草稿预览"));
    assert.equal(previews.length, 1);
    assert.match(previews[0].type === "text" ? previews[0].text : "", /# 第一章/u);
    assert.equal(inspected.status, "proposal_submitted");
    assert.equal(inspected.reviewCompleted, true);
    assert.equal(inspected.proposalSubmitted, true);
    assert.equal(typeof inspected.contentCharacters, "number");
    assert.equal("content" in inspected, false, "isolated review must not append the full chapter to the Agent loop");
    assert.equal((inspected.chapterReview as Record<string, unknown>).verdict, "pass");
    assert.equal((inspected.characterChangeWarnings as string[]).length, 1);
    assert.deepEqual(chapterReviewUsage.map(item => item.callKind), ["chapter_review_failed", "chapter_review"]);
    const proposed = inspected.proposal as Record<string, unknown>;
    assert.equal(proposed.status, "pending");
    const storedProposal = activeStore.proposal(Number(proposed.proposalId));
    assert.equal(storedProposal.characterChanges.length, 1);
    assert.equal(storedProposal.characterChanges[0].changes.length, 2);
    const normalizedState = storedProposal.characterChanges[0].changes.find(change => change.op === "upsert_story_state");
    assert.equal((normalizedState?.entry as Record<string, unknown>).notes, "违规进入：门禁转红后仍进入训练区");
    assert.equal(project.documentExists("chapters/第一章.md"), false);
    assert.equal(context.chapterSceneDraft, undefined);
    assert.equal(context.completedChapterHandoff?.path, "chapters/第一章.md");
    assert.equal(context.completedChapterHandoff?.sceneCount, 1);
    assert.deepEqual(context.completedChapterHandoff?.finalActualState?.situation, ["主角违规进入训练区"]);

    const malformed = JSON.parse(await executeTool(
      { id: "bad-json", name: "inspect_chapter_draft", arguments: "{" },
      project, activeStore, sessionId, () => {}, undefined, context,
    )) as Record<string, unknown>;
    assert.equal(malformed.code, "INVALID_TOOL_ARGUMENTS_JSON");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scene dense gate rejects prose before it enters the chapter draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-scene-dense-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "密度回弹");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("密度回弹");
    const context: ToolExecutionContext = {
      permissionMode: "ask",
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {}, undefined, context,
    );
    await call("begin_chapter_draft", {
      path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变", scenes: [sceneChain[0]],
    });
    const dense = [
      "走廊尽头有动静。不是埋伏。是逃跑。",
      "空气发涩。不是气体。是悬浮颗粒。",
      "地面反光。不是水。是油性液体。",
      "立柱在颤。不是塌方。是预埋装药。",
      "警报灯亮着。不是故障。是提醒。",
      "脚步声停了。不是犹豫。是等待。",
    ].join("");
    const first = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。",
      content: dense,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(first.status, "style_revision_required");
    assert.equal(first.code, "SCENE_STYLE_DENSE");
    assert.equal(context.chapterSceneDraft?.completed.length, 0);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabled scene pipeline rejects a new chapter draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-scene-disabled-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "关闭场景链");
    store = new WriterStore(project);
    const sessionId = store.createSession("关闭场景链");
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      scenePipelineSettings: {
        enabled: false,
        preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5,
        notesMaxCharacters: 3_000, candidateCount: 1,
      },
    };
    const result = JSON.parse(await executeTool(
      {
        id: "begin-disabled",
        name: "begin_chapter_draft",
        arguments: JSON.stringify({
          path: "chapters/第一章.md",
          mode: "create",
          chapterGoal: "关系改变",
          scenes: [sceneChain[0]],
        }),
      },
      project,
      store,
      sessionId,
      () => {},
      undefined,
      context,
    )) as Record<string, unknown>;
    assert.match(String(result.error), /场景链当前已关闭/);
    assert.equal(context.chapterSceneDraft, undefined);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scene gate applies sparse sentence repairs before asking for a rewrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-scene-local-repair-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "逐句修订");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("逐句修订");
    let repairCalls = 0;
    const replacements = new Map([
      ["不是埋伏。是逃跑。", "走廊尽头传来逃跑的脚步声。"],
      ["不是气体。是悬浮颗粒。", "悬浮颗粒让空气发涩。"],
      ["不是水。是油性液体。", "油性液体在地面反光。"],
      ["不是塌方。是预埋装药。", "预埋装药震得立柱发颤。"],
    ]);
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      chapterStyleRepairer: {
        model: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "repair-test" },
        run: async (_model, input) => {
          repairCalls += 1;
          return {
            edits: input.issues.map((issue, index) => ({
              search: issue.sentence,
              replace: replacements.get(issue.sentence) ?? `门禁句已按原事实改为直接陈述${index + 1}。`,
            })),
            requestCharacters: 300,
          };
        },
      },
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {}, undefined, context,
    );
    await call("begin_chapter_draft", {
      path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变", scenes: [sceneChain[0]],
    });
    const sparse = [
      "走廊尽头有动静。不是埋伏。是逃跑。",
      "空气发涩。不是气体。是悬浮颗粒。",
      "地面反光。不是水。是油性液体。",
      "立柱在颤。不是塌方。是预埋装药。",
      "应急门沿着轨道落下，主角侧身挤进最后一道缝隙，鞋底在油膜上拖出半圈亮痕。",
    ].join("");
    const written = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。",
      content: sparse,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(written.status, "written");
    assert.equal(repairCalls, 1);
    const autoFixes = written.autoFixes as {
      sceneStyleEdits: Array<{ search: string; replace: string }>;
      sceneStyleRepairAttempts: number;
    };
    assert.ok(autoFixes.sceneStyleEdits.length > 0);
    assert.equal(autoFixes.sceneStyleRepairAttempts, 1);
    const repairedContent = context.chapterSceneDraft?.completed[0].content ?? "";
    assert.equal((repairedContent.match(/不是/gu) ?? []).length, 1, "家族预算内可保留一个不可替代实例");
    assert.match(repairedContent, /悬浮颗粒让空气发涩/u);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scene gate skips local repair when blockers exceed one repair batch", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-scene-rewrite-fallback-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "密集重写回退");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("密集重写回退");
    let repairCalls = 0;
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      chapterStyleRepairer: {
        model: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "repair-test" },
        run: async () => {
          repairCalls += 1;
          return { edits: [], requestCharacters: 0 };
        },
      },
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {}, undefined, context,
    );
    await call("begin_chapter_draft", {
      path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变", scenes: [sceneChain[0]],
    });
    const dense = Array.from({ length: 10 }, (_, index) =>
      `第${index + 1}道门在响。不是故障。是有人触发了警报。`
    ).join("");
    const rejected = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。",
      content: dense,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(rejected.status, "style_revision_required");
    assert.equal(rejected.code, "SCENE_STYLE_DENSE");
    assert.equal(repairCalls, 0);
    assert.ok(Number(rejected.styleIssueCount) > 8);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scene candidate sampling keeps the original without a reader judge", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-scene-skip-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "候选跳过");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("候选跳过");
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      scenePipelineSettings: {
        enabled: true,
        preferredMinScenes: 1, preferredMaxScenes: 3, maxScenes: 5,
        notesMaxCharacters: 3_000, candidateCount: 2,
      },
      // No reader judge means no rewrite request may be sent to this endpoint.
      sceneCandidates: { model: { baseUrl: "http://127.0.0.1:1", apiKey: "k", model: "test" } },
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {}, undefined, context,
    );
    await call("begin_chapter_draft", {
      path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "关系改变", scenes: [sceneChain[0]],
    });
    const clean = [
      "傍晚的风从山谷里上来，带着一点松脂的气味，把晾在绳上的衬衫吹得鼓起来又落下。",
      "老周蹲在灶前添柴，火光映在他脸上，忽明忽暗。",
      "「明天还去吗？」孩子问。",
      "他没有立刻回答，先把一根柴推进去，看着火苗舔上来，才说：「去。」",
      "夜里下了点雨，屋檐滴水的声音断断续续，到天亮才停。",
    ].join("\n\n");
    const written = JSON.parse(await call("write_chapter_scene", {
      sceneId: "arrival",
      notes: "## 场景目标\n主角违规进入训练区。",
      content: clean,
      actualState: actualState("主角违规进入训练区"),
    })) as Record<string, unknown>;
    assert.equal(written.status, "written");
    const sampling = written.candidateSampling as Record<string, unknown>;
    assert.equal(sampling.skipped, "no_reader_judge");
    assert.equal(sampling.chosen, "original");
    assert.equal(sampling.generated, 0);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("read_document quote locates quoted prose in one call", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-quote-locate-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "定位");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("定位");
    const path = "chapters/第一章.md";
    project.writeRaw(path, ["# 第一章", "", "走廊尽头的灯亮了。", "她停在门口。", "老人的体重数字出现在她脑子里。", "她收回手。", ""].join("\n"));
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {},
    );
    const located = JSON.parse(await call("read_document", {
      path, quote: "老人的体重数字出现在她脑子里。",
    })) as { sourceHash: string; occurrences: number; matches: Array<{ startLine: number; endLine: number; context: string }> };
    assert.equal(located.sourceHash.length, 64);
    assert.equal(located.occurrences, 1);
    assert.equal(located.matches[0].startLine, 5);
    assert.equal(located.matches[0].endLine, 5);
    assert.match(located.matches[0].context, /她停在门口/);
    assert.match(located.matches[0].context, /她收回手/);
    // Ellipsis-joined quotes fall back to the longest fragment instead of failing.
    const approx = JSON.parse(await call("read_document", {
      path, quote: "走廊尽头的灯亮了。……她收回手。",
    })) as { occurrences: number; matchedFragment?: string; matches: Array<{ startLine: number }> };
    assert.equal(approx.occurrences, 1);
    assert.equal(approx.matchedFragment, "走廊尽头的灯亮了。");
    assert.equal(approx.matches[0].startLine, 3);
    const missing = JSON.parse(await call("read_document", {
      path, quote: "文中不存在的一句话",
    })) as { occurrences: number; hint?: string };
    assert.equal(missing.occurrences, 0);
    assert.match(String(missing.hint), /缩短|search_project/);

    project.writeRaw(path, `${project.read(path)}\n新版本。\n`);
    const stale = JSON.parse(await call("read_document", {
      path, sourceHash: located.sourceHash, block: 1,
    })) as { error?: string };
    assert.match(String(stale.error), /快照已变化/);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("read_document bounds large sections to one snapshot atom", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-bounded-read-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "有界读取");
    store = new WriterStore(project);
    const sessionId = store.createSession("有界读取");
    const path = "lore/world.md";
    project.writeRaw(path, `# 世界观\n\n${Array.from({ length: 120 }, (_, index) => `设定条目${index}：${"细节".repeat(30)}。`).join("\n")}`);
    const result = JSON.parse(await executeTool(
      { id: "bounded", name: "read_document", arguments: JSON.stringify({ path, section: "世界观" }) },
      project, store, sessionId, () => {},
    )) as { sourceHash: string; content: string; truncated: boolean; nextStartLine?: number };
    assert.equal(result.sourceHash.length, 64);
    assert.ok(result.content.length <= 4_000);
    assert.equal(result.truncated, true);
    assert.ok(result.nextStartLine);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("chapter patch can submit without workflow prerequisites", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-light-patch-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "小修");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("小修");
    const path = "chapters/第一章.md";
    project.writeRaw(path, "# 第一章\n\n她伸出手。老人的体重数字出现在她脑子里。她收回手。\n");
    const context: ToolExecutionContext = {
      permissionMode: "ask",
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {}, undefined, context,
    );
    // The Agent chooses the patch because it matches the requested scope, not to bypass a workflow gate.
    const light = JSON.parse(await call("propose_document_patch", {
      path,
      edits: [{ search: "老人的体重数字出现在她脑子里。", replace: "她凭手上传来的分量估出老人很轻。" }],
      summary: "修正OOC描写",
    })) as Record<string, unknown>;
    assert.equal(light.status, "pending");
    assert.equal(light.edits, 1);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposal characterChanges validate ops at propose time and accept synonyms", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-proposal-charops-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "演进校验");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("演进校验");
    const card = activeStore.saveCharacter(emptyCharacter("甲"));
    const path = "chapters/第一章.md";
    project.writeRaw(path, "# 第一章\n\n她伸出手。她收回手。\n");
    const context: ToolExecutionContext = { permissionMode: "ask" };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, activeStore, sessionId, () => {}, undefined, context,
    );
    // Unknown op fails at propose time with the valid-op hint, not silently at accept time.
    const bad = JSON.parse(await call("propose_document_patch", {
      path,
      edits: [{ search: "她收回手。", replace: "她缓缓收回手。" }],
      summary: "小修",
      characterChanges: [{ characterId: card.id, reason: "确认经历", changes: [{ op: "add", label: "x" }] }],
    })) as Record<string, unknown>;
    assert.match(String(bad.error), /op 无效/);
    assert.match(String(bad.error), /可用 op/);
    // Common synonyms (append_/add_/update_*) are normalized and go through.
    const ok = JSON.parse(await call("propose_document_patch", {
      path,
      edits: [{ search: "她收回手。", replace: "她缓缓收回手。" }],
      summary: "小修",
      characterChanges: [{ characterId: card.id, reason: "确认经历", changes: [{ op: "append_experience", label: "初次外勤", description: "桥上协同" }] }],
    })) as Record<string, unknown>;
    assert.equal(ok.status, "pending");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabled character evolution strips proposal character changes without blocking prose", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-proposal-character-toggle-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "演进关闭");
    store = new WriterStore(project);
    const activeStore = store;
    const sessionId = activeStore.createSession("演进关闭");
    const card = activeStore.saveCharacter(emptyCharacter("甲"));
    const path = "chapters/第一章.md";
    project.writeRaw(path, "# 第一章\n\n她伸出手。她收回手。\n");
    const context: ToolExecutionContext = { permissionMode: "ask", characterEvolutionEnabled: false };
    const result = JSON.parse(await executeTool(
      { id: "toggle", name: "propose_document_patch", arguments: JSON.stringify({
        path,
        edits: [{ search: "她收回手。", replace: "她缓缓收回手。" }],
        summary: "小修",
        characterChanges: [{ characterId: card.id, reason: "误附带", changes: [
          { op: "append_experience", label: "不应写入", description: "开关关闭" },
        ] }],
      }) },
      project, activeStore, sessionId, () => {}, undefined, context,
    )) as Record<string, unknown>;
    assert.equal(result.status, "pending");
    assert.equal(result.characterEvolutionSkipped, true);
    const proposal = activeStore.proposal(Number(result.proposalId));
    assert.deepEqual(proposal.characterChanges, []);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document anchors locate, read and patch one paragraph without a full-document payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-anchor-patch-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "锚点补丁");
    project.writeRaw("lore/world.md", "# 城市\n\n门禁灯由绿变红。\n\n她仍然跨过了门。\n\n远处响起警报。\n");
    store = new WriterStore(project);
    const sessionId = store.createSession("锚点补丁");
    const context: ToolExecutionContext = { permissionMode: "ask", editScope: "point" };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, store!, sessionId, () => {}, undefined, context,
    );
    const located = JSON.parse(await call("locate_document_span", {
      path: "lore/world.md", quote: "她仍然跨过了门。",
    })) as Record<string, unknown>;
    const target = (located.matches as Array<Record<string, unknown>>)[0];
    assert.equal(typeof target.anchorId, "string");
    const read = JSON.parse(await call("read_document_span", {
      path: "lore/world.md", sourceHash: located.sourceHash, anchorId: target.anchorId,
      beforeParagraphs: 1, afterParagraphs: 1,
    })) as Record<string, unknown>;
    assert.match(String(read.content), /门禁灯由绿变红/u);
    assert.ok(String(read.content).length < project.read("lore/world.md").length);
    assert.equal(read.nextAction, "propose_document_patch");
    let locatorCalls = 0;
    context.documentLocator = {
      model: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "test" },
      run: async () => {
        locatorCalls += 1;
        return { matches: [], requestCharacters: 0 };
      },
    };
    const relocalized = JSON.parse(await call("locate_document_span", {
      path: "lore/world.md", query: "远处警报的位置",
    })) as Record<string, unknown>;
    assert.equal(relocalized.status, "target_locked");
    assert.equal(relocalized.nextAction, "propose_document_patch");
    assert.equal(locatorCalls, 0);
    const chapterSearch = JSON.parse(await call("search_project", {
      query: "警报", scope: "chapters",
    })) as Record<string, unknown>;
    assert.equal(chapterSearch.status, "target_locked");
    assert.equal(chapterSearch.nextAction, "propose_document_patch");
    const loreSearch = JSON.parse(await call("search_project", {
      query: "门禁灯", scope: "lore",
    })) as Record<string, unknown>;
    assert.equal(loreSearch.status, undefined);
    assert.equal(loreSearch.scope, "lore");
    const otherAnchor = documentSpans(project.read("lore/world.md"), String(located.sourceHash)).at(-1)!;
    const drifted = JSON.parse(await call("read_document_span", {
      path: "lore/world.md", sourceHash: located.sourceHash, anchorId: otherAnchor.anchorId,
    })) as Record<string, unknown>;
    assert.match(String(drifted.error), /目标已锁定/u);
    const targetAnchor = (read.anchors as Array<Record<string, unknown>>).find(anchor => anchor.anchorId === target.anchorId)!;
    const patched = JSON.parse(await call("propose_document_patch", {
      path: "lore/world.md", sourceHash: located.sourceHash, summary: "调整越界动作",
      edits: [{
        anchorId: target.anchorId, spanHash: targetAnchor.spanHash, operation: "replace",
        content: "她在红灯亮起前收住脚，转身贴住墙面。",
      }],
    })) as Record<string, unknown>;
    assert.equal(patched.status, "pending");
    const proposal = store.proposals().find(item => item.id === patched.proposalId)!;
    assert.match(proposal.afterContent, /转身贴住墙面/u);
    assert.doesNotMatch(proposal.afterContent, /她仍然跨过了门/u);
    const blockedInspect = JSON.parse(await call("inspect_document", { path: "lore/world.md" })) as Record<string, unknown>;
    assert.match(String(blockedInspect.error), /局部修改禁止/u);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic locator reranks bounded anchors and whole-document revision stays isolated", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-isolated-revision-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "隔离修订");
    const original = "# 规则\n\n旧称用于北区。\n\n南区也沿用旧称。\n\n结尾仍写旧称。\n";
    project.writeRaw("lore/world.md", original);
    store = new WriterStore(project);
    const sessionId = store.createSession("隔离修订");
    const model = { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "test" };
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      editScope: "document",
      documentLocator: {
        model,
        run: async (_model, input) => ({
          matches: [{ anchorId: input.candidates.at(-1)!.anchorId, confidence: 0.88, reason: "结尾命中" }],
          requestCharacters: 600,
        }),
      },
      documentRevisioner: {
        model,
        run: async (_model, input) => ({ content: input.content.replaceAll("旧称", "新称"), requestCharacters: input.content.length + 200 }),
      },
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, store!, sessionId, () => {}, undefined, context,
    );
    const semantic = JSON.parse(await call("locate_document_span", {
      path: "lore/world.md", query: "最后一次仍未更新名称的位置",
    })) as Record<string, unknown>;
    assert.equal(semantic.mode, "semantic");
    assert.equal((semantic.matches as unknown[]).length, 1);
    const sourceHash = project.hash(project.read("lore/world.md"));
    const revised = JSON.parse(await call("revise_document_isolated", {
      path: "lore/world.md", sourceHash, instruction: "把全文中的旧称统一改成新称", summary: "统一名称",
    })) as Record<string, unknown>;
    assert.equal(revised.status, "pending");
    assert.equal(revised.revisionMode, "isolated_blocks");
    assert.equal("content" in revised, false);
    const proposal = store.proposals().find(item => item.id === revised.proposalId)!;
    assert.doesNotMatch(proposal.afterContent, /旧称/u);
    assert.equal(documentSpans(proposal.afterContent, project.hash(proposal.afterContent)).length, 4);
    assert.equal(store.agentCheckpoint(sessionId)?.stage, "proposal_submitted");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
