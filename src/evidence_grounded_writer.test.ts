import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSceneActualState } from "./evidence_grounded_writer.js";
import { assembleChapterSceneDraft, blockChapterSceneReview } from "./scene_pipeline.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { handleCompileWritePack } from "./tools/write_pack.js";
import { handleWriteFile } from "./tools/files.js";
import { handleBeginChapterDraft, handleWriteChapterScene } from "./tools/scene_pipeline.js";
import type { ToolExecutionContext, ToolHandlerArgs } from "./tools/types.js";

const MODEL = { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "writer-test" };

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

test("delegated writer receives the same adaptive feedback returned at the scene boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-grounded-adaptive-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "自适应反馈");
    store = new WriterStore(project);
    const sessionId = store.createSession("自适应反馈");
    const receivedFeedback: string[][] = [];
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
          receivedFeedback.push(input.styleFeedback ?? []);
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
    assert.match(JSON.stringify(first.styleFeedback), /对白有.*很短的应答/u);

    await handleWriteChapterScene({
      ...baseArgs,
      input: { sceneId: "read", notes: "## 场景目标\n林觉核对记录并暂不回应门外的人。" },
    });
    assert.equal(receivedFeedback.length, 2);
    assert.match(receivedFeedback[1].join("\n"), /对白有.*很短的应答/u);
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
