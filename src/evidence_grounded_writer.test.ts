import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildEvidenceGroundedWriterMessages,
  classifyEmptyWriterProse,
  emptyProseRetryPrompt,
  EvidenceGroundedWriterError,
  formatEvidenceWriterAgentMessage,
  mergeProseContinuation,
  parseSceneActualState,
  reportAndWrapEvidenceWriterError,
  requestEvidenceGroundedProse,
} from "./evidence_grounded_writer.js";
import type { ProviderCompletionResult } from "./model_api.js";
import { dialogueNaturalnessGuidance } from "./dialogue_texture.js";
import { assembleChapterSceneDraft, blockChapterSceneReview } from "./scene_pipeline.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { handleCompileWritePack } from "./tools/write_pack.js";
import { handleWriteFile } from "./tools/files.js";
import { handleBeginChapterDraft, handleWriteChapterScene } from "./tools/scene_pipeline.js";
import type { ToolExecutionContext, ToolHandlerArgs } from "./tools/types.js";

const MODEL = { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "writer-test" };

test("writer coverage errors identify the exact character that must be read", async () => {
  const pack = {
    sourceDraft: "", sceneGoal: "对话", beatOrder: [], knownFacts: [], mustLand: [],
    characterState: [], narrationNotes: [], doNotInvent: [], narrativeBrief: "", structured: true,
    strippedMeta: [],
  };
  await assert.rejects(
    () => requestEvidenceGroundedProse(MODEL, {
      path: "chapters/test.md",
      outputKind: "document",
      writePack: pack,
      evidence: {
        version: 1,
        path: "chapters/test.md",
        instructions: "",
        writingMemory: [],
        characters: [],
        sources: [],
        coverageGaps: [{
          code: "character_sections_missing",
          characterId: 5,
          characterName: "温晚",
          missing: ["motivations"],
          action: "先 get_character(view=sections, sections=[\"motivations\"]) 读取对白所需原始分区。",
        }],
        hash: "gap-hash",
      },
      styleEvidence: "稳定文风",
    }, {} as never),
    /角色「温晚」\(id=5\).*get_character\(view=sections/u,
  );
});

test("length-limited writer continuations keep prose and remove a repeated seam", () => {
  const first = "风压把沙粒推过靶沟。林千夏压低枪口，等最后一辆车越过标杆。";
  const next = "林千夏压低枪口，等最后一辆车越过标杆。车尾刚沉进热浪，她便抬手示意全组前移。";
  assert.equal(
    mergeProseContinuation(first, next),
    "风压把沙粒推过靶沟。林千夏压低枪口，等最后一辆车越过标杆。车尾刚沉进热浪，她便抬手示意全组前移。",
  );
});

test("dialogue naturalness guidance stays in the dynamic writer request", () => {
  const pack = {
    sourceDraft: "",
    sceneGoal: "取得线索",
    beatOrder: [],
    knownFacts: [],
    mustLand: [],
    characterState: [],
    narrationNotes: [],
    doNotInvent: [],
    narrativeBrief: "",
    structured: true,
    strippedMeta: [],
  };
  const evidence = {
    version: 1 as const,
    path: "chapters/test.md",
    instructions: "",
    writingMemory: [],
    characters: [],
    sources: [],
    coverageGaps: [],
    hash: "test-hash",
  };
  const messages = buildEvidenceGroundedWriterMessages({
    path: "chapters/test.md",
    outputKind: "document",
    writePack: pack,
    evidence,
    styleEvidence: "稳定文风",
  });
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "system");
  assert.equal(messages[2]?.role, "user");
  assert.match(String(messages[2]?.content), /此刻想得到什么/u);
  assert.match(String(messages[2]?.content), /回避/u);
  assert.match(String(messages[2]?.content), /不要批量补助词/u);
  assert.match(String(messages[2]?.content), /上下文能猜出意思不等于表达自然/u);
  assert.match(String(messages[2]?.content), /比较维度/u);
  assert.doesNotMatch(String(messages[0]?.content), /对白自然度契约/u);
  assert.match(dialogueNaturalnessGuidance(), /保持事实、知识和人物声线不变/u);
  assert.match(dialogueNaturalnessGuidance(), /不能只为显得干脆、冷淡或机灵/u);
});

test("realization boundaries stay in the dynamic writer user message", () => {
  const pack = {
    sourceDraft: "",
    sceneGoal: "表现超频后的不适",
    beatOrder: [],
    knownFacts: ["千夏的神经组织仍在工作"],
    mustLand: [],
    characterState: [],
    narrationNotes: [],
    doNotInvent: [],
    narrativeBrief: "",
    structured: true,
    strippedMeta: [],
    realizationBoundaries: [{
      factId: "fact-1",
      claim: "千夏的神经组织仍在工作",
      precision: "sensory" as const,
      narration: "写成发胀或发灰",
      dialogue: "我还醒着",
      technicalDialogue: "皮层清醒",
      avoid: "旁白反复点名皮层",
    }],
  };
  const evidence = {
    version: 1 as const,
    path: "chapters/test.md",
    instructions: "",
    writingMemory: [],
    characters: [],
    sources: [],
    coverageGaps: [],
    hash: "test-hash",
  };
  const messages = buildEvidenceGroundedWriterMessages({
    path: "chapters/test.md",
    outputKind: "document",
    writePack: pack,
    evidence,
    styleEvidence: "稳定文风",
  });
  assert.doesNotMatch(String(messages[0]?.content), /表达边界执行规则/u);
  assert.match(String(messages[2]?.content), /皮层清醒/u);
  assert.match(String(messages[2]?.content), /不是逐字替换表/u);
});

test("delegated write_file realizes a compiled pack through the evidence-grounded writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-grounded-document-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "证据成稿");
    store = new WriterStore(project);
    const sessionId = store.createSession("直接正文");
    let calls = 0;
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      reviewCharacterIds: [],
      characterEvidenceReads: new Map(),
      narrativeEvidencePackets: new Map(),
      proseLength: { targetCharacters: 500, enforceMinimum: false },
      evidenceGroundedWriter: {
        model: MODEL,
        stateModel: MODEL,
        run: async (_model, input) => {
          calls += 1;
          assert.equal(input.outputKind, "document");
          assert.equal(input.evidence.coverageGaps.length, 0);
          assert.match(input.styleEvidence, /句式边界/u);
          return {
            content: "雨停以后，废站台上的积水仍在往轨缝里退。林觉踩过散落的票根，直到值班室那扇半开的门碰上墙，又慢慢弹回来。\n\n他没有立刻进去。门槛内侧沾着新泥，鞋印朝外，说明先前离开的人还可能藏在附近。远处传来金属碰撞声，他关掉手电，沿墙摸向检修通道。",
            requestCharacters: 100,
            evidenceHash: input.evidence.hash,
            evidenceReads: [],
          };
        },
      },
    };
    const baseArgs = { project, store, sessionId, emit: () => undefined, context };
    handleCompileWritePack({
      ...baseArgs,
      input: { notes: "## 场景目标\n林觉发现有人刚离开废站。\n## 勿擅自补写\n不确定对方身份。", targetPath: "chapters/new.md" },
    });
    const result = JSON.parse(await handleWriteFile({ ...baseArgs, input: { path: "chapters/new.md" } })) as Record<string, unknown>;
    assert.equal(calls, 1);
    assert.equal(result.generationMode, "evidence_grounded_writer");
    assert.equal(context.narrativeEvidencePackets?.has("chapters/new.md"), true);
    assert.equal(context.workingTextFiles?.get("chapters/new.md")?.content.startsWith("# new\n"), true);
    assert.match(store.proposals()[0]?.summary ?? "", /废站台/u);
    assert.match(store.proposals()[0]?.summary ?? "", /检修通道/u);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delegated chapter scene omits prose and derives actual state after grounded generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-grounded-scene-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "证据场景");
    store = new WriterStore(project);
    const sessionId = store.createSession("场景正文");
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      scenePipelineSettings: {
        enabled: true, preferredMinScenes: 1, preferredMaxScenes: 2, maxScenes: 3,
        notesMaxCharacters: 3_000, candidateCount: 2,
      },
      proseLength: { targetCharacters: 500, enforceMinimum: false },
      reviewCharacterIds: [],
      characterEvidenceReads: new Map(),
      narrativeEvidencePackets: new Map(),
      evidenceGroundedWriter: {
        model: MODEL,
        stateModel: MODEL,
        run: async (_model, input) => ({
          content: "门禁灯从红色跳成绿色时，林觉没有马上推门。他先看见玻璃里自己的倒影，随后才看清倒影肩后那只抬起的手。\n\n他侧身让开，门板擦着外套撞上墙。来人没有追，只把一枚沾水的旧车票放在门槛上。林觉认出背面的日期，伸手时，对方已经退进没有照明的楼梯间。",
          requestCharacters: 120,
          evidenceHash: input.evidence.hash,
          evidenceReads: [],
        }),
        extractState: async () => ({
          actualState: {
            situation: ["门口出现身份不明的人"], physical: [], knowledge: ["林觉认出旧车票日期"],
            relationships: [], goals: ["追查车票来源"], openLoops: ["来人身份不明"], usedMotifs: ["旧车票"],
          },
          requestCharacters: 80,
        }),
      },
    };
    const baseArgs: Omit<ToolHandlerArgs, "input"> = { project, store, sessionId, emit: () => undefined, context };
    handleBeginChapterDraft({
      ...baseArgs,
      input: {
        path: "chapters/delegated.md", mode: "create", heading: "分工", chapterGoal: "得到追查方向",
        scenes: [{
          id: "door", goal: "取得线索", entryState: [], characterIntent: [], obstacle: "来人不肯露面",
          turn: "留下旧车票", outcome: "林觉决定追查", targetCharacters: 500,
        }],
      },
    });
    const result = JSON.parse(await handleWriteChapterScene({
      ...baseArgs,
      input: { sceneId: "door", notes: "## 场景目标\n林觉从陌生人手中得到旧车票。\n## 勿擅自补写\n不确定陌生人身份。" },
    })) as Record<string, unknown>;
    assert.equal(result.status, "written");
    assert.equal(context.chapterSceneDraft?.completed[0]?.actualState.knowledge[0], "林觉认出旧车票日期");
    assert.equal(context.narrativeEvidencePackets?.has("chapters/delegated.md#door"), true);
    assert.equal((result.candidateSampling as Record<string, unknown>)?.skipped, "evidence_grounded_preserves_fact_packet");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-blocked scene rewrite reuses the target scene baseline and its true previous state", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-grounded-review-repair-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "证据复审");
    store = new WriterStore(project);
    const sessionId = store.createSession("证据复审");
    const first = "雨水顺着门框流到地面，林觉用鞋尖拨开一张湿透的票根，又抬头确认走廊里没有第二个人。他没有追，只把门留了一条缝，等里面的脚步声自己靠近。风从站台灌进来，门轴每隔几秒便轻轻响一下，他始终没有碰门把。";
    const second = "值班员停在门后，没有回答车票从哪里来。他把登记簿压在肘下，只说昨夜没人经过这里，随后伸手去关那条门缝。林觉看见纸页边缘沾着与票根相同的蓝墨水。值班员察觉他的视线，把登记簿翻了个面，另一只手仍抵着门板。";
    const revised = "值班员停在门后，把登记簿压在肘下。他没有说明车票的来处，只反问林觉为什么盯着纸页。门缝收窄以前，林觉看见页角沾着蓝墨水，却还不能据此确认两件东西出自同一人。他退开半步，改问昨夜的巡检时间，等对方自己决定是否翻开登记簿。";
    const writerInputs: Array<{ previousTail?: string; existingText?: string; issueCount: number }> = [];
    let writerCall = 0;
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      scenePipelineSettings: {
        enabled: true, preferredMinScenes: 2, preferredMaxScenes: 2, maxScenes: 3,
        notesMaxCharacters: 3_000, candidateCount: 1,
      },
      proseLength: { targetCharacters: 500, enforceMinimum: false },
      reviewCharacterIds: [],
      characterEvidenceReads: new Map(),
      narrativeEvidencePackets: new Map(),
      evidenceGroundedWriter: {
        model: MODEL,
        stateModel: MODEL,
        run: async (_model, input) => {
          writerInputs.push({
            previousTail: input.previousTail,
            existingText: input.existingText,
            issueCount: input.reviewIssues?.length ?? 0,
          });
          const content = writerCall === 0 ? first : writerCall === 1 ? second : revised;
          writerCall += 1;
          return {
            content,
            requestCharacters: 100,
            evidenceHash: input.evidence.hash,
            evidenceReads: [],
          };
        },
        extractState: async () => ({
          actualState: {
            situation: [`状态-${writerCall}`], physical: [], knowledge: [], relationships: [],
            goals: [], openLoops: [], usedMotifs: [],
          },
          requestCharacters: 20,
        }),
      },
    };
    const baseArgs: Omit<ToolHandlerArgs, "input"> = { project, store, sessionId, emit: () => undefined, context };
    handleBeginChapterDraft({
      ...baseArgs,
      input: {
        path: "chapters/review-repair.md", mode: "create", heading: "复审", chapterGoal: "确认线索边界",
        scenes: [
          { id: "door", goal: "接近值班室", entryState: [], characterIntent: [], obstacle: "门内有人", turn: "留下门缝", outcome: "等到值班员", handoff: "值班员来到门后" },
          { id: "ledger", goal: "判断票根来源", entryState: [], characterIntent: [], obstacle: "值班员回避", turn: "看见蓝墨水", outcome: "只得到待核线索" },
        ],
      },
    });
    await handleWriteChapterScene({
      ...baseArgs,
      input: { sceneId: "door", notes: "## 场景目标\n林觉在门外等待值班员。" },
    });
    await handleWriteChapterScene({
      ...baseArgs,
      input: { sceneId: "ledger", notes: "## 场景目标\n林觉观察登记簿，但不能确认票根来源。" },
    });
    const blockedDraft = context.chapterSceneDraft!;
    const baseline = assembleChapterSceneDraft(blockedDraft);
    context.chapterSceneDraft = blockChapterSceneReview({
      draft: blockedDraft,
      baselineContent: baseline,
      baselineSourceHash: project.hash(baseline),
      issues: [{
        id: "issue:unsupported",
        severity: "blocker",
        kind: "unsupported_fact",
        sceneId: "ledger",
        evidence: ["相同的蓝墨水"],
        problem: "颜色相同不足以确认同一来源",
        action: "保留观察，撤回确认性判断",
      }],
    });

    const result = JSON.parse(await handleWriteChapterScene({
      ...baseArgs,
      input: { sceneId: "ledger", notes: "## 场景目标\n保留蓝墨水观察，但不得确认票根来源。" },
    })) as Record<string, unknown>;
    assert.equal(result.status, "revised");
    assert.match(writerInputs[2].previousTail ?? "", /门留了一条缝/u);
    assert.equal(writerInputs[2].existingText, second);
    assert.equal(writerInputs[2].issueCount, 1);
    assert.equal(context.chapterSceneDraft?.reviewCycle?.status, "repairing");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delegated scene never sends grounded prose through an ungrounded style repairer", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-grounded-repair-boundary-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "修订边界");
    store = new WriterStore(project);
    const sessionId = store.createSession("修订边界");
    let repairCalls = 0;
    const dense = [
      "走廊尽头有动静。不是埋伏。是逃跑。",
      "空气发涩。不是气体。是悬浮颗粒。",
      "地面反光。不是水。是油性液体。",
      "立柱在颤。不是塌方。是预埋装药。",
    ].join("");
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      scenePipelineSettings: {
        enabled: true, preferredMinScenes: 1, preferredMaxScenes: 2, maxScenes: 3,
        notesMaxCharacters: 3_000, candidateCount: 1,
      },
      proseLength: { targetCharacters: 500, enforceMinimum: false },
      reviewCharacterIds: [],
      characterEvidenceReads: new Map(),
      narrativeEvidencePackets: new Map(),
      chapterStyleRepairer: {
        model: MODEL,
        run: async () => {
          repairCalls += 1;
          return { edits: [], requestCharacters: 0 };
        },
      },
      evidenceGroundedWriter: {
        model: MODEL,
        stateModel: MODEL,
        run: async (_model, input) => ({
          content: dense,
          requestCharacters: 100,
          evidenceHash: input.evidence.hash,
          evidenceReads: [],
        }),
        extractState: async () => ({
          actualState: {
            situation: [], physical: [], knowledge: [], relationships: [],
            goals: [], openLoops: [], usedMotifs: [],
          },
          requestCharacters: 20,
        }),
      },
    };
    const baseArgs: Omit<ToolHandlerArgs, "input"> = { project, store, sessionId, emit: () => undefined, context };
    handleBeginChapterDraft({
      ...baseArgs,
      input: {
        path: "chapters/repair.md", mode: "create", heading: "修订", chapterGoal: "进入走廊",
        scenes: [{
          id: "arrival", goal: "进入走廊", entryState: [], characterIntent: [],
          obstacle: "警报", turn: "发现装药", outcome: "停在门前", targetCharacters: 500,
        }],
      },
    });
    const result = JSON.parse(await handleWriteChapterScene({
      ...baseArgs,
      input: { sceneId: "arrival", notes: "## 场景目标\n进入走廊并发现异常。" },
    })) as Record<string, unknown>;
    assert.equal(result.status, "style_revision_required");
    assert.equal(result.code, "SCENE_STYLE_DENSE");
    assert.equal(repairCalls, 0);
    assert.equal(context.chapterSceneDraft?.completed.length, 0);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delegated writer does not receive prior-scene metric feedback", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-grounded-adaptive-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "自适应反馈");
    store = new WriterStore(project);
    const sessionId = store.createSession("自适应反馈");
    const receivedMetricFeedback: boolean[] = [];
    let writerCalls = 0;
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      scenePipelineSettings: {
        enabled: true, preferredMinScenes: 1, preferredMaxScenes: 3, maxScenes: 4,
        notesMaxCharacters: 3_000, candidateCount: 1,
      },
      proseLength: { targetCharacters: 500, enforceMinimum: false },
      reviewCharacterIds: [],
      characterEvidenceReads: new Map(),
      narrativeEvidencePackets: new Map(),
      evidenceGroundedWriter: {
        model: MODEL,
        stateModel: MODEL,
        run: async (_model, input) => {
          receivedMetricFeedback.push("styleFeedback" in input);
          writerCalls += 1;
          return {
            content: writerCalls === 1
              ? Array.from({ length: 16 }, (_, index) => (
                index % 2 ? "「明白。」" : "「知道。」"
              )).join("\n\n")
              : "门外的脚步停住以后，林觉才把压在桌角的记录翻过来。他沿着纸上的折痕看完最后一行，听见对方隔着门问了一句，却没有马上回答。纸页右下角留着一块干涸的水痕，正好压住签名的末笔；他把台灯转近，确认那不是墨迹以后，才将记录重新折好，放进外套内袋。",
            requestCharacters: 100,
            evidenceHash: input.evidence.hash,
            evidenceReads: [],
          };
        },
        extractState: async () => ({
          actualState: {
            situation: ["记录已经完成交接"], physical: [], knowledge: [], relationships: [],
            goals: [], openLoops: [], usedMotifs: [],
          },
          requestCharacters: 20,
        }),
      },
    };
    const baseArgs: Omit<ToolHandlerArgs, "input"> = { project, store, sessionId, emit: () => undefined, context };
    handleBeginChapterDraft({
      ...baseArgs,
      input: {
        path: "chapters/adaptive.md", mode: "create", heading: "自适应", chapterGoal: "完成交接",
        scenes: [
          {
            id: "confirm", goal: "确认记录", entryState: [], characterIntent: [],
            obstacle: "双方只做简短应答", turn: "记录交到林觉手中", outcome: "林觉开始核对",
            handoff: "林觉拿着记录进入下一场核对", targetCharacters: 500,
          },
          {
            id: "read", goal: "核对记录", entryState: [], characterIntent: [],
            obstacle: "门外有人催促", turn: "林觉发现最后一行", outcome: "林觉暂不回应", targetCharacters: 500,
          },
        ],
      },
    });
    const first = JSON.parse(await handleWriteChapterScene({
      ...baseArgs,
      input: { sceneId: "confirm", notes: "## 场景目标\n双方确认记录已经交接。" },
    })) as Record<string, unknown>;
    assert.equal(first.status, "written");
    assert.equal("styleFeedback" in first, false);

    await handleWriteChapterScene({
      ...baseArgs,
      input: { sceneId: "read", notes: "## 场景目标\n林觉核对记录并暂不回应门外的人。" },
    });
    assert.deepEqual(receivedMetricFeedback, [false, false]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scene state parser keeps bounded factual arrays", () => {
  const state = parseSceneActualState(JSON.stringify({
    situation: ["一", "二", "三", "四"], physical: ["轻伤"], knowledge: ["知道门已锁"],
    relationships: [], goals: [], openLoops: [], usedMotifs: [],
  }));
  assert.deepEqual(state.situation, ["一", "二", "三"]);
});

const EMPTY_EVIDENCE = {
  version: 1 as const,
  path: "chapters/empty.md",
  instructions: "",
  writingMemory: [],
  characters: [],
  sources: [],
  coverageGaps: [],
  hash: "empty-hash",
};

const EMPTY_PACK = {
  sourceDraft: "",
  sceneGoal: "取得线索",
  beatOrder: [],
  knownFacts: [],
  mustLand: [],
  characterState: [],
  narrationNotes: [],
  doNotInvent: [],
  narrativeBrief: "",
  structured: true,
  strippedMeta: [],
};

function writerAccess(): { project: WriterProject; context: ToolExecutionContext } {
  const root = mkdtempSync(join(tmpdir(), "writer-empty-prose-"));
  const project = WriterProject.init(root, "空正文");
  return {
    project,
    context: {
      permissionMode: "ask",
      reviewCharacterIds: [],
      characterEvidenceReads: new Map(),
      narrativeEvidencePackets: new Map(),
    },
  };
}

test("empty prose with long reasoning is classified productively", () => {
  assert.equal(classifyEmptyWriterProse({ content: "", reasoningContent: "x".repeat(20) }), "empty_content");
  assert.equal(
    classifyEmptyWriterProse({ content: "  ", reasoningContent: "思考".repeat(50) }),
    "empty_content_with_reasoning",
  );
  assert.match(emptyProseRetryPrompt({
    emptyKind: "empty_content_with_reasoning",
    reasoningCharacters: 200,
    accumulatedCharacters: 0,
  }), /思考内容/);
});

test("empty prose auto-retries once then succeeds", async () => {
  const access = writerAccess();
  let calls = 0;
  const complete = async (): Promise<ProviderCompletionResult> => {
    calls += 1;
    if (calls === 1) {
      return {
        content: "",
        reasoningContent: "我先梳理证据与人物关系，再决定如何写开场。".repeat(8),
        toolCalls: [],
        finishReason: "stop",
        durationMs: 1200,
        usage: {
          promptTokens: 100, completionTokens: 50, cacheHitTokens: 10, cacheMissTokens: 90, reasoningTokens: 40,
        },
      };
    }
    return {
      content: "雨停以后，废站台上的积水仍在往轨缝里退。林觉踩过散落的票根，沿墙摸向检修通道。",
      reasoningContent: "",
      toolCalls: [],
      finishReason: "stop",
      durationMs: 800,
      usage: {
        promptTokens: 120, completionTokens: 40, cacheHitTokens: 20, cacheMissTokens: 100,
      },
    };
  };
  try {
    const result = await requestEvidenceGroundedProse(
      MODEL,
      {
        path: "chapters/empty.md",
        outputKind: "document",
        writePack: EMPTY_PACK,
        evidence: EMPTY_EVIDENCE,
        styleEvidence: "稳定文风",
      },
      access,
      undefined,
      { complete },
    );
    assert.equal(calls, 2);
    assert.equal(result.emptyAutoRetryUsed, true);
    assert.match(result.content, /废站台/);
    assert.equal(result.usage?.promptTokens, 220);
    assert.equal(result.usage?.reasoningTokens, 40);
  } finally {
    rmSync(access.project.root, { recursive: true, force: true });
  }
});

test("empty prose failure stores diagnostics and reports usage", async () => {
  const access = writerAccess();
  let calls = 0;
  const complete = async (): Promise<ProviderCompletionResult> => {
    calls += 1;
    return {
      content: "",
      reasoningContent: "仅有思考没有正文。".repeat(20),
      toolCalls: [],
      finishReason: "stop",
      durationMs: 500,
      usage: {
        promptTokens: 80, completionTokens: 60, cacheHitTokens: 0, cacheMissTokens: 80, reasoningTokens: 55,
      },
    };
  };
  const reported: Array<{ callKind: string; usage: { promptTokens: number }; preview?: string }> = [];
  try {
    await assert.rejects(
      () => requestEvidenceGroundedProse(
        MODEL,
        {
          path: "chapters/empty.md",
          outputKind: "document",
          writePack: EMPTY_PACK,
          evidence: EMPTY_EVIDENCE,
          styleEvidence: "稳定文风",
        },
        access,
        undefined,
        { complete },
      ),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceGroundedWriterError);
        assert.equal(error.diagnostics.code, "EMPTY_PROSE");
        assert.equal(error.diagnostics.emptyKind, "empty_content_with_reasoning");
        assert.equal(error.diagnostics.emptyAutoRetryUsed, true);
        assert.equal(error.diagnostics.providerCalls, 2);
        assert.equal(error.diagnostics.durationMs, 1000);
        assert.equal(error.usage?.promptTokens, 160);
        const agentMessage = formatEvidenceWriterAgentMessage(error);
        assert.match(agentMessage, /writePack 仍有效/);
        assert.match(agentMessage, /禁止改由主 Agent 全文手写/);
        const wrapped = reportAndWrapEvidenceWriterError(
          error,
          { ...MODEL, providerName: "test-provider" },
          "evidence_grounded_document_writer",
          (model, usage, meta) => {
            reported.push({
              callKind: meta.callKind,
              usage: { promptTokens: usage.promptTokens },
              preview: meta.requestComponents?.[0]?.preview,
            });
            void model;
          },
        );
        assert.equal(wrapped.code, "EVIDENCE_WRITER_EMPTY_PROSE");
        assert.equal(wrapped.failureKind, "dependency");
        assert.equal(wrapped.diagnostics?.attempts[0]?.class, "empty_response");
        assert.equal(wrapped.diagnostics?.attempts[0]?.recordedUsage, true);
        return true;
      },
    );
    assert.equal(calls, 2);
    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.callKind, "evidence_grounded_document_writer");
    assert.equal(reported[0]?.usage.promptTokens, 160);
    assert.match(String(reported[0]?.preview), /empty_content_with_reasoning/);
  } finally {
    rmSync(access.project.root, { recursive: true, force: true });
  }
});

test("delegated write_file keeps writePack after empty writer failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-grounded-retry-pack-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "保留 pack");
    store = new WriterStore(project);
    const sessionId = store.createSession("空正文重试");
    let calls = 0;
    const reported: string[] = [];
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      reviewCharacterIds: [],
      characterEvidenceReads: new Map(),
      narrativeEvidencePackets: new Map(),
      proseLength: { targetCharacters: 500, enforceMinimum: false },
      modelUsageReporter: (_model, _usage, meta) => {
        reported.push(meta.callKind);
      },
      evidenceGroundedWriter: {
        model: MODEL,
        stateModel: MODEL,
        run: async () => {
          calls += 1;
          throw new EvidenceGroundedWriterError("证据型 Writer 没有返回正文", {
            code: "EMPTY_PROSE",
            usage: {
              promptTokens: 50, completionTokens: 10, cacheHitTokens: 0, cacheMissTokens: 50,
            },
            diagnostics: {
              path: "chapters/retry.md",
              outputKind: "document",
              code: "EMPTY_PROSE",
              contentCharacters: 0,
              reasoningCharacters: 200,
              finishReason: "stop",
              toolCallCount: 0,
              durationMs: 900,
              providerCalls: 2,
              emptyKind: "empty_content_with_reasoning",
              emptyAutoRetryUsed: true,
              evidenceTurns: 0,
              continuationTurns: 0,
            },
          });
        },
      },
    };
    const baseArgs = { project, store, sessionId, emit: () => undefined, context };
    handleCompileWritePack({
      ...baseArgs,
      input: { notes: "## 场景目标\n林觉发现有人刚离开废站。\n## 勿擅自补写\n不确定对方身份。", targetPath: "chapters/retry.md" },
    });
    assert.equal(context.writePackCompiled, true);
    await assert.rejects(
      () => handleWriteFile({ ...baseArgs, input: { path: "chapters/retry.md" } }),
      (error: unknown) => {
        assert.ok(error && typeof error === "object");
        const err = error as { code?: string; failureKind?: string; retryable?: boolean; message?: string };
        assert.equal(err.code, "EVIDENCE_WRITER_EMPTY_PROSE");
        assert.equal(err.failureKind, "dependency");
        assert.equal(err.retryable, true);
        assert.match(String(err.message), /writePack 仍有效/);
        assert.match(String(err.message), /禁止改由主 Agent 全文手写/);
        return true;
      },
    );
    assert.equal(calls, 1);
    // Pack must remain for a second omit-content attempt.
    assert.equal(context.writePackCompiled, true);
    assert.ok(context.lastWritePackData);
    assert.deepEqual(reported, ["evidence_grounded_document_writer"]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
