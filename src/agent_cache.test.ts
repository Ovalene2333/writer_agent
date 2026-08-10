import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProposalRetryState,
  decideProposalFailure,
  isExpectedRhythmPolish,
  proposalIssueTransition,
  type ProposalRevisionCase,
  type ProposalRevisionIssue,
} from "./proposal_retry.js";
/**
 * Cache / prompt-assembly guards. When changing agent prompts, keep the contract
 * documented at the top of agent.ts (PROMPT / PREFIX-CACHE CONTRACT) and extend
 * these tests if you change fixed slot counts or mid-job mutators.
 */
import {
  agentToolNames,
  agentToolSchemaHash,
  agentToolsForTask,
  admitReadAtom,
  automaticChapterReviewEnabled,
  boundToolResultForModel,
  buildRequestComponentUsage,
  buildDynamicTurnMessages,
  buildStableSystemPrefix,
  dynamicContextPrompt,
  buildToolArgumentRepairMessages,
  characterMutationCompletesTask,
  chapterContinuationPrompt,
  captureProposalRevisionDocumentBase,
  proposalRevisionConvergePrompt,
  proposalRevisionBaseChangeReason,
  proposalRevisionDraftCacheKey,
  proposalFailureDraft,
  proposalFailurePauseResult,
  appendTerminalJobReference,
  documentDeliveryCompletionMessage,
  isVisibleAssistantText,
  terminalAssistantText,
  proposalFailureShouldPersistRevisionCase,
  saveProposalRevisionCase,
  chapterDraftNeedsReview,
  chapterReviewAllowsTool,
  chapterReviewCompleted,
  chapterReviewRepairAllowsTool,
  chapterReviewRepairLock,
  chapterReviewRequiredPrompt,
  compactCompletedToolCalls,
  compactRuntimeMessages,
  executionModelForTask,
  executionModelForStep,
  buildMaterialsShelfDigest,
  formatJobMaterialsShelfPrompt,
  hydrateSessionMaterialsShelf,
  isTargetedDocumentSupplement,
  projectCacheUserId,
  registerMaterialsShelfEntry,
  normalizeCharacterTaskMode,
  normalizeDocumentProposalRequired,
  normalizePlannedProseGateCandidate,
  normalizeRewriteEditScope,
  parsePlannerJson,
  parseToolArgumentRepair,
  plannerCompletionOptions,
  priorTurnContentForContext,
  rehydrateRecentToolMessages,
  recentRoleplayHandoffContext,
  requestNeedsProjectFactSearch,
  repairTruncatedToolArguments,
  resolveRecentCharacterIds,
  restoreChapterDraftCheckpoint,
  sceneContinuationPrompt,
  stripStaleReasoningContent,
  taskInstructions,
} from "./agent.js";
import { freezeTurnBlock, mergedTurnContext } from "./turn_replay.js";
import type { AgentTurnMessage } from "./types.js";
import { beginChapterSceneDraft, writeChapterScene } from "./scene_pipeline.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { emptyCharacter } from "./characters.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { buildFactualChapterReviewContext } from "./chapter_review_context.js";
import { buildRecordedUsageEvent, parseModelTokenUsage } from "./model_usage.js";
import { buildChapterReviewMessages, parseChapterReview } from "./chapter_review.js";
import { buildChapterStyleRepairMessages, CHAPTER_STYLE_REPAIR_BATCH_SIZE, parseChapterStyleRepair } from "./chapter_style_repair.js";
import { documentSpans } from "./document_spans.js";
import { parseDocumentLocatorResult } from "./document_locator.js";
import { parseDocumentRevision } from "./document_revision.js";
import { messageContentText } from "./model_compat.js";

test("agent tool schema has stable order and unique names", () => {
  const names = agentToolNames();
  assert.equal(new Set(names).size, names.length);
  for (const name of ["read_file", "write_file", "edit_file", "move_file", "delete_file"]) {
    assert.ok(names.includes(name), `unified file catalog missing ${name}`);
  }
  for (const legacy of ["read_document", "propose_document", "propose_document_patch", "propose_change_set"]) {
    assert.equal(names.includes(legacy), false, `legacy model tool must stay hidden: ${legacy}`);
  }
  // Update when TOOLS descriptions/schemas change intentionally (cache-critical).
  assert.equal(agentToolSchemaHash(), "aed719fbeee6ebff");
});

test("isolated chapter review carries the full draft once and returns bounded structured evidence", () => {
  const content = "# 第一章\n\n## 进入\n\n门禁灯由绿变红。\n\n## 结果\n\n她越过了门。";
  const scenes = [{
    sceneId: "arrival", title: "进入", plannedTurn: "门禁变红", plannedOutcome: "主角违规进入",
    actualState: { situation: ["主角违规进入"] },
  }];
  const proseSignals = {
    stats: { numericTokenDensityPer10k: 112 },
    warnings: [],
    // 规则层测得的 AI 味，只作参考不作判据；它进 user 消息，不进缓存前缀。
    aiTells: { score: 62.5, thematicUpliftCount: 2, idiomPer10k: 44 },
    aiTellWarnings: [{ code: "thematic_uplift", message: "收尾自己点破主题", examples: ["从此以后"] }],
  };
  const messages = buildChapterReviewMessages({
    chapterGoal: "关系改变", content, scenes, context: "稳定项目约束", proseSignals,
  });
  assert.deepEqual(messages.map(message => message.role), ["system", "system", "user"]);
  assert.equal(messages[1].content, "稳定项目约束");
  assert.match(messageContentText(messages[0].content), /客观事实不自动等于角色知识/u);
  assert.match(messageContentText(messages[0].content), /亲历\/目击、被可信来源告知/u);
  assert.match(messageContentText(messages[0].content), /voice_homogenization/u);
  assert.match(messageContentText(messages[0].content), /theme_stated/u);
  assert.match(messageContentText(messages[0].content), /resolution_too_smooth/u);
  assert.match(messageContentText(messages[0].content), /capability_scope/u);
  assert.match(messageContentText(messages[2].content), /门禁灯由绿变红/u);
  assert.deepEqual(JSON.parse(messages[2].content).proseSignals, proseSignals);

  const review = parseChapterReview(JSON.stringify({
    verdict: "revise",
    chapterChange: "主角从服从转为违规",
    reviewNotes: "结果与计划一致，但接缝需要补强。",
    issues: [{
      severity: "blocker", kind: "knowledge_leak", sceneId: "arrival",
      evidence: ["门禁灯由绿变红。"], problem: "角色没有获知门禁规则的路径，却据此判断违规", action: "补入可见线索或删除判断",
    }],
  }), new Set(["arrival"]), content);
  assert.equal(review.verdict, "revise");
  assert.equal(review.issues[0].kind, "knowledge_leak");
  assert.deepEqual(review.issues[0].evidence, ["门禁灯由绿变红。"]);
  // Single legal sceneId + no locatable evidence → demote to pass (avoid fake "服务不可用").
  const demoted = parseChapterReview(JSON.stringify({
    verdict: "revise",
    chapterChange: "主角改变",
    reviewNotes: "存在问题",
    issues: [{
      severity: "blocker", kind: "seam", sceneId: "arrival",
      evidence: ["正文中不存在的句子。"], problem: "问题", action: "修复",
    }],
  }), new Set(["arrival"]), content);
  assert.equal(demoted.verdict, "pass");
  assert.equal(demoted.issues[0]?.severity, "warning");
});

test("chapter review receives full cards alongside source-linked scene capability scopes", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-review-capability-scope-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "终审能力范围");
    store = new WriterStore(project);
    const character = store.saveCharacter({
      ...emptyCharacter("闻溪"),
      competencies: [
        { id: "track", name: "追踪", summary: "识别足迹", level: "", unlocked: true, description: "泥土和鞋印", resources: [], limitations: ["雨水冲淡"], costs: ["耗时"] },
        { id: "climb", name: "攀爬", summary: "借墙上行", level: "", unlocked: true, description: "需可攀附表面", resources: [], limitations: ["湿滑"], costs: ["耗力"] },
      ],
    });
    const draft = beginChapterSceneDraft({
      path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "越过门禁",
      baseContent: "", baseHash: "empty",
      scenes: [{
        id: "arrival", title: "抵达", goal: "穿过门禁", entryState: [], characterIntent: [], obstacle: "锁门",
        turn: "警报", outcome: "进入", handoff: "",
        characterScopes: [{ characterId: character.id, competencyIds: ["track"], dialogue: true }],
      }],
    });
    const context: ToolExecutionContext = {
      permissionMode: "auto",
      chapterSceneDraft: draft,
      reviewCharacterIds: [character.id],
    };
    const packet = JSON.parse(buildFactualChapterReviewContext({ project, store, context, path: draft.path }));
    assert.deepEqual(packet.characters[0].constraints.competencies.map((item: { id: string }) => item.id), ["track", "climb"]);
    assert.deepEqual(packet.sceneCapabilityScopes, [{
      sceneId: "arrival",
      characterScopes: [{
        characterId: character.id,
        competencyUses: [{ competencyId: "track", mode: "use" }],
        competencyIds: ["track"],
        dialogue: true,
      }],
    }]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolated style repair only admits exact issue sentences", () => {
  const issues = [{
    id: "i1", code: "contrast", sentence: "不是寒冷，是风在门缝里找路。",
    before: "她关上窗。", after: "灯影晃了一下。", instruction: "去掉模板化转折",
  }];
  assert.deepEqual(parseChapterStyleRepair(JSON.stringify({ edits: [
    { search: issues[0].sentence, replace: "风从门缝钻进来，贴着她的手背往袖口里走。" },
    { search: "未列出的句子。", replace: "不得应用。" },
  ] }), issues), [{
    search: issues[0].sentence,
    replace: "风从门缝钻进来，贴着她的手背往袖口里走。",
  }]);
});

test("isolated style repair bounds each request batch and style evidence", () => {
  const issues = Array.from({ length: CHAPTER_STYLE_REPAIR_BATCH_SIZE + 3 }, (_, index) => ({
    id: `i${index}`, code: "contrast", sentence: `命中句${index}。`,
    before: "前文", after: "后文", instruction: "局部改写",
  }));
  const messages = buildChapterStyleRepairMessages({
    chapterGoal: "关系改变",
    issues,
    styleEvidence: "例".repeat(2_000),
  });
  const payload = JSON.parse(messages[1].content) as { issues: unknown[]; styleEvidence: string };
  assert.equal(payload.issues.length, CHAPTER_STYLE_REPAIR_BATCH_SIZE);
  assert.equal(payload.styleEvidence.length, 1_000);
});

test("document spans are snapshot-scoped and locator outputs stay within candidates", () => {
  const content = "# 第一章\n\n门禁灯由绿变红。\n\n她没有停下。";
  const first = documentSpans(content, "hash-a");
  const second = documentSpans(content, "hash-b");
  assert.equal(first.length, 3);
  assert.notEqual(first[1].anchorId, second[1].anchorId);
  assert.deepEqual(first[1].headingPath, ["第一章"]);
  const candidates = first.map(span => ({
    anchorId: span.anchorId, headingPath: span.headingPath, startLine: span.startLine, endLine: span.endLine, preview: span.content,
  }));
  assert.deepEqual(parseDocumentLocatorResult(JSON.stringify({ matches: [
    { anchorId: first[2].anchorId, confidence: 0.9, reason: "首次越界" },
    { anchorId: "invented", confidence: 1, reason: "不存在" },
  ] }), candidates), [{ anchorId: first[2].anchorId, confidence: 0.9, reason: "首次越界" }]);
  assert.equal(parseDocumentRevision(JSON.stringify({ content: content.replace("没有", "仍未") }), content).includes("仍未"), true);
});

test("request waterfall and oversized tool paging stay bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-context-budget-"));
  try {
    const project = WriterProject.init(root, "上下文预算");
    const store = new WriterStore(project);
    const sessionId = store.createSession("上下文预算");
    const tools = agentToolsForTask("write_scene", "ask");
    const components = buildRequestComponentUsage([
      { role: "system", content: "stable" },
      { role: "user", content: "dynamic" },
      { role: "tool", tool_call_id: "t1", content: "result" },
    ], tools, 1, 2);
    assert.ok(components.some(component => component.kind === "tool_schema"));
    assert.ok(components.some(component => component.kind === "stable_system"));
    assert.ok(components.some(component => component.kind === "tool_result"));

    const full = JSON.stringify({ status: "written", complete: true, content: "正文".repeat(20_000) });
    const bounded = JSON.parse(boundToolResultForModel(
      { id: "t1", name: "read_document", arguments: "{}" }, full, project, store, sessionId,
    )) as Record<string, unknown>;
    assert.equal(bounded.status, "tool_result_truncated");
    assert.equal(bounded.complete, true, "control milestones must survive truncation");
    const artifact = store.contextArtifactById(sessionId, Number(bounded.artifactId));
    assert.equal(artifact?.content, full);
    assert.ok(String(bounded.preview).length < full.length);
    const visibleWrite = JSON.parse(boundToolResultForModel(
      { id: "t2", name: "write_file", arguments: "{}" },
      JSON.stringify({ proposalId: 42, deliverableId: "document-1", status: "pending", path: "lore/a.md" }),
      project,
      store,
      sessionId,
    )) as Record<string, unknown>;
    assert.equal(visibleWrite.status, "pending");
    assert.equal(visibleWrite.path, "lore/a.md");
    assert.equal("proposalId" in visibleWrite, false);
    assert.equal("deliverableId" in visibleWrite, false);
    assert.match(String(visibleWrite.message), /等待用户审批/u);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validated checkpoints restore drafts and clear with task state", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-checkpoint-"));
  try {
    const project = WriterProject.init(root, "断点");
    const store = new WriterStore(project);
    const sessionId = store.createSession("断点");
    const draft = beginChapterSceneDraft({
      path: "chapters/第1章.md", mode: "create", heading: "第1章", chapterGoal: "越界",
      baseContent: "", baseHash: project.hash(""),
      scenes: [{
        id: "s1", title: "门禁", goal: "进入", obstacle: "锁门", turn: "警报", outcome: "越界",
        readerQuestion: "警报会把谁带来", cost: "门禁记录已留下", handoff: "",
      }],
    });
    store.saveAgentCheckpoint(sessionId, {
      version: 1, stage: "draft_started", path: draft.path, sourceHash: draft.baseHash,
      draftVersion: 0, completedScenes: 0, totalScenes: 1, draft, updatedAt: new Date().toISOString(),
    });
    assert.equal(restoreChapterDraftCheckpoint(store, sessionId, project, draft.path)?.path, draft.path);
    store.clearSessionTaskState(sessionId);
    assert.equal(store.agentCheckpoint(sessionId), undefined);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task modes share one frozen universal capability catalog", () => {
  const catalog = agentToolNames();
  const write = agentToolsForTask("write_scene", "ask");
  const writeNames = write.map(tool => tool.function.name);
  assert.ok(Object.isFrozen(write));
  assert.deepEqual(writeNames, catalog);
  for (const required of ["read_file", "write_file", "edit_file", "move_file", "delete_file", "begin_chapter_draft", "write_chapter_scene", "revise_chapter_scene_guide", "inspect_chapter_draft"]) {
    assert.ok(writeNames.includes(required), `write profile missing ${required}`);
  }
  assert.equal(writeNames.includes("save_character"), true);
  assert.deepEqual(agentToolsForTask("brainstorm", "ask").map(tool => tool.function.name), writeNames);
  assert.deepEqual(agentToolsForTask("audit", "ask").map(tool => tool.function.name), writeNames);

  const planNames = agentToolsForTask("write_scene", "plan").map(tool => tool.function.name);
  assert.equal(planNames.includes("write_chapter_scene"), false);
  assert.equal(catalog.some(name => name.startsWith("propose_")), false);
  assert.equal(planNames.includes("write_file"), false);
  assert.equal(planNames.includes("edit_file"), false);
  assert.ok(planNames.includes("read_file"));
});

test("plan workflows stay read-only and use bounded creative pacing", () => {
  const outline = taskInstructions("outline", "explore", "plan", false);
  assert.match(outline, /200—400 字/);
  assert.match(outline, /不强制调用 design_creative_outline/);
  assert.doesNotMatch(outline, /提交.*提案/);

  const character = taskInstructions("simple_character", "shape", "plan", false);
  assert.match(character, /不得调用任何保存工具/);
  assert.doesNotMatch(character, /最终必须调用 save_simple_character/);

  const audit = taskInstructions("audit", "shape", "plan", false);
  assert.match(audit, /不提交修改提案/);
});

test("generic character card requests cannot be downgraded to simple cards", () => {
  assert.equal(normalizeCharacterTaskMode("更新孟秋岚的角色卡", "simple_character"), "character");
  assert.equal(normalizeCharacterTaskMode("创建一个简易角色卡", "character"), "simple_character");
  assert.equal(normalizeCharacterTaskMode("创建一个简易角色卡", "simple_character"), "simple_character");
  assert.equal(normalizeDocumentProposalRequired("character", true), false);
  assert.equal(normalizeDocumentProposalRequired("simple_character", true), false);
  assert.equal(normalizeDocumentProposalRequired("write_scene", true), true);
  assert.equal(characterMutationCompletesTask("character", "auto"), true);
  assert.equal(characterMutationCompletesTask("simple_character", "ask"), true);
  assert.equal(characterMutationCompletesTask("write_scene", "auto"), false);
  assert.equal(characterMutationCompletesTask("rewrite", "ask"), false);
  assert.equal(characterMutationCompletesTask("character", "plan"), false);

  const normal = taskInstructions("character", "deliver", "ask", false);
  assert.match(normal, /检查同名卡/);
  assert.match(normal, /角色保存成功即完成本任务/);
  assert.match(normal, /禁止再写入无关文件/);
  assert.match(normal, /直接 get_character/);
  assert.match(normal, /不要调用 save_simple_character/);
  assert.match(normal, /结构化错误/);
});

test("character tool JSON recovery is conservative and keeps repair requests isolated", () => {
  assert.deepEqual(JSON.parse(repairTruncatedToolArguments(
    '{"id":4,"identity":{"name":"日和"}',
  ) ?? "null"), { id: 4, identity: { name: "日和" } });
  assert.deepEqual(JSON.parse(repairTruncatedToolArguments(
    '{"id":4,"identity":{"name":"日和"},',
  ) ?? "null"), { id: 4, identity: { name: "日和" } });
  assert.equal(repairTruncatedToolArguments('{"id":4,"identity":{"name":"日'), undefined);
  assert.equal(repairTruncatedToolArguments('[1,2]'), undefined);
  assert.deepEqual(JSON.parse(parseToolArgumentRepair(
    '```json\n{"id":4,"identity":{"name":"日和"}}\n```',
  ) ?? "null"), { id: 4, identity: { name: "日和" } });

  const messages = buildToolArgumentRepairMessages({
    toolName: "save_character",
    rawArguments: '{"id":4,"identity":{"name":"日',
    parameterSchema: { type: "object" },
  });
  assert.deepEqual(messages.map(message => message.role), ["system", "user"]);
  const payload = JSON.parse(messageContentText(messages[1].content) || "{}") as Record<string, unknown>;
  assert.equal(payload.rawArguments, '{"id":4,"identity":{"name":"日');
});

test("short character follow-ups resolve the latest exact catalog mention", () => {
  const catalog = [
    { id: 3, name: "ARC-03「烁刃」", aliases: ["烁刃"] },
    { id: 4, name: "ARC-04「锻星」", aliases: ["锻星", "千钧"] },
  ];
  assert.deepEqual(resolveRecentCharacterIds(catalog, [
    "日系一点",
    "已有 ARC-04「锻星」（id=4），现在读取必要分区。",
    "烁刃也在场。",
  ]), [4]);
  assert.deepEqual(resolveRecentCharacterIds(catalog, ["名字再短一点", "没有出现角色名"]), []);
});

test("planner JSON parser accepts one object and rejects surrounding prose", () => {
  assert.deepEqual(parsePlannerJson('{"mode":"general","todoPlan":[]}'), {
    mode: "general",
    todoPlan: [],
  });
  assert.deepEqual(parsePlannerJson('```json\n{"mode":"write_scene"}\n```'), {
    mode: "write_scene",
  });
  assert.equal(parsePlannerJson('分析如下：{"mode":"general"}'), undefined);
  assert.equal(parsePlannerJson('{"mode":'), undefined);
  assert.equal(parsePlannerJson('[]'), undefined);
});

test("planner uses deterministic sampling, JSON mode and DeepSeek Thinking", () => {
  assert.deepEqual(plannerCompletionOptions({ provider: "deepseek", baseUrl: "https://proxy.example/v1" }), {
    temperature: 0,
    topP: 1,
    responseFormat: { type: "json_object" },
    thinking: { type: "enabled" },
  });
  assert.deepEqual(plannerCompletionOptions({ provider: "openai-compatible", baseUrl: "https://api.openai.com/v1" }), {
    temperature: 0,
    topP: 1,
    thinking: { type: "enabled" },
  });
});

test("planner prose gate candidates require an independently executable semantic rule", () => {
  assert.deepEqual(normalizePlannedProseGateCandidate({
    id: "technical-telemetry-density",
    instruction: "正文不要连续堆叠精确技术参数；只有数值直接影响人物判断、风险或行动时才保留。",
    severity: "warn",
    sourceFeedback: "作者要求避免频繁细写元件温度升降数值。",
  }), {
    id: "technical-telemetry-density",
    title: "technical-telemetry-density",
    userIntent: "作者要求避免频繁细写元件温度升降数值。",
    semanticCriterion: "正文不要连续堆叠精确技术参数；只有数值直接影响人物判断、风险或行动时才保留。",
    evidenceRequirement: "引用能够独立证明该模式的最短连续原文；涉及密度或问答关系时必须包含相邻上下文。",
    allowConditions: [],
    revisionIntent: "只修正命中问题，保留事实、人物目的、线索顺序和有效表达。",
    enforcement: "advise",
    status: "trial",
    sourceFeedback: "作者要求避免频繁细写元件温度升降数值。",
  });
  assert.equal(normalizePlannedProseGateCandidate({
    id: "中文-id",
    instruction: "少写一点。",
    sourceFeedback: "不喜欢。",
  }), undefined);
  assert.equal(normalizePlannedProseGateCandidate({
    id: "vague-feedback",
    instruction: "",
    sourceFeedback: "不喜欢。",
  }), undefined);
});

test("immediately previous reply preserves named options for follow-up references", () => {
  const prior = [
    "前置分析。",
    "**A. 第一次杀人**",
    "A线的具体内容。",
    "**B. 方晓的极限**",
    "B线的具体内容。",
    "**C. 父亲的另一面**",
    "C线的具体内容。",
  ].join("\n\n");
  const admitted = priorTurnContentForContext(prior);
  assert.equal(admitted, prior);
  assert.match(admitted, /A\. 第一次杀人/);
  assert.match(admitted, /C\. 父亲的另一面/);
});

test("exceptionally long previous replies mark middle omission instead of posing as complete", () => {
  const prior = `HEAD-${"甲".repeat(15_000)}-${"乙".repeat(15_000)}-TAIL`;
  const admitted = priorTurnContentForContext(prior);
  assert.match(admitted, /^HEAD-/);
  assert.match(admitted, /上一条消息中段已省略/);
  assert.match(admitted, /原文 30011 字/);
  assert.match(admitted, /-TAIL$/);
  assert.ok(admitted.length < prior.length);
});

test("main orchestration always stays on Agent across task modes", () => {
  const model = (name: string) => ({
    provider: "openai-compatible" as const,
    baseUrl: "https://api.example.com/v1",
    apiKey: "test",
    model: name,
  });
  const agent = model("agent");
  const writer = model("writer");
  const inline = model("inline");
  const reviewer = model("reviewer");
  const models = { agent, writer, inline, reviewer };
  const writing = { mode: "write_scene" as const, documentProposalRequired: true };

  assert.equal(executionModelForTask(writing, models, agent), agent);
  assert.equal(executionModelForTask({ mode: "outline", documentProposalRequired: true }, models, agent), agent);
  assert.equal(executionModelForTask({ mode: "rewrite", documentProposalRequired: true }, models, agent), agent);
  assert.equal(executionModelForTask({ mode: "audit", documentProposalRequired: false }, models, agent), agent);
});

test("project cache user id is opaque and stable within a project", () => {
  const first = projectCacheUserId("/projects/novel-a");
  assert.equal(first, projectCacheUserId("/projects/novel-a"));
  assert.notEqual(first, projectCacheUserId("/projects/novel-b"));
  assert.match(first, /^writer-project-[a-f0-9]{32}$/);
  assert.doesNotMatch(first, /novel-a/);
});

test("fast writing mode keeps every step on Agent, including pending prose scenes", () => {
  const model = (name: string) => ({ baseUrl: "https://api.example.com/v1", apiKey: "test", model: name });
  const agent = model("agent");
  const writer = model("writer");
  const pending = { scenes: [{ id: "one" }], completed: [] } as unknown as Pick<import("./scene_pipeline.js").ChapterSceneDraft, "scenes" | "completed">;
  const complete = { scenes: [{ id: "one" }], completed: [{ sceneId: "one" }] } as unknown as Pick<import("./scene_pipeline.js").ChapterSceneDraft, "scenes" | "completed">;

  assert.equal(executionModelForStep("write_scene", agent, writer, false), agent);
  assert.equal(executionModelForStep("write_scene", agent, writer, false, pending), agent);
  assert.equal(executionModelForStep("write_scene", agent, writer, false, complete), agent);
  assert.equal(executionModelForStep("write_scene", agent, writer, true, pending), agent);
  assert.equal(executionModelForStep("write_scene", agent, writer, true, complete), agent);
  assert.equal(executionModelForStep("write_scene", agent, writer, true), agent);
  assert.equal(executionModelForStep("write_scene", agent, undefined, true), agent);
  assert.equal(executionModelForStep("outline", agent, writer, true, pending), agent);
});

test("provider usage parsing and tagged persistence include hidden model calls", () => {
  assert.deepEqual(parseModelTokenUsage({
    prompt_tokens: 120,
    completion_tokens: 30,
    cache_creation_input_tokens: 12,
    prompt_tokens_details: { cached_tokens: 80 },
  }), {
    promptTokens: 120,
    completionTokens: 30,
    cacheHitTokens: 80,
    cacheMissTokens: 40,
    cacheWriteTokens: 12,
  });
  assert.deepEqual(parseModelTokenUsage({
    prompt_tokens: 50,
    completion_tokens: 8000,
    completion_tokens_details: { reasoning_tokens: 7800 },
    prompt_tokens_details: { cached_tokens: 10 },
  }), {
    promptTokens: 50,
    completionTokens: 8000,
    cacheHitTokens: 10,
    cacheMissTokens: 40,
    reasoningTokens: 7800,
  });

  const root = mkdtempSync(join(tmpdir(), "writer-usage-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "用量");
    store = new WriterStore(project);
    const sessionId = store.createSession("用量");
    const event = buildRecordedUsageEvent(store, sessionId, {
      provider: "openai-compatible", providerName: "本地供应商", baseUrl: "http://localhost", apiKey: "", model: "flash-model",
    }, {
      promptTokens: 12, completionTokens: 3, cacheHitTokens: 8, cacheMissTokens: 4,
    }, { callKind: "planner", step: 0 });
    assert.equal(event.type, "usage");
    if (event.type === "usage") {
      assert.equal(event.call?.model, "flash-model");
      assert.equal(event.call?.providerName, "本地供应商");
    }
    store.recordUsage(sessionId, "flash", {
      promptTokens: 120, completionTokens: 30, cacheHitTokens: 80, cacheMissTokens: 40,
    }, { cacheHit: 0.1, cacheMiss: 1, output: 2, currency: "CNY", contextWindow: 1000 }, new Date("2026-01-01T00:00:00Z"), {
      jobId: "job-1", callKind: "prose_gate", step: 3,
      requestComponents: [{ kind: "other", label: "局部审查", characters: 400, estimatedTokens: 100 }],
    });
    const row = store.database.prepare("SELECT job_id,call_kind,step,request_components_json FROM model_usage WHERE session_id=? AND call_kind='prose_gate'").get(sessionId) as Record<string, unknown>;
    assert.equal(row.job_id, "job-1");
    assert.equal(row.call_kind, "prose_gate");
    assert.equal(row.step, 3);
    assert.equal((JSON.parse(String(row.request_components_json)) as unknown[]).length, 1);
    assert.equal(store.usage(sessionId).lastPromptTokens, 0, "internal calls must not replace the main context meter");
    store.recordUsage(sessionId, "pro", {
      promptTokens: 500, completionTokens: 20, cacheHitTokens: 400, cacheMissTokens: 100,
    }, { cacheHit: 0.1, cacheMiss: 1, output: 2, currency: "CNY", contextWindow: 1000 }, new Date("2026-01-01T00:00:01Z"), {
      jobId: "job-1", callKind: "agent_step", step: 3,
    });
    store.recordUsage(sessionId, "flash", {
      promptTokens: 40, completionTokens: 10, cacheHitTokens: 0, cacheMissTokens: 40,
    }, { cacheHit: 0.1, cacheMiss: 1, output: 2, currency: "CNY", contextWindow: 1000 }, new Date("2026-01-01T00:00:02Z"), {
      jobId: "job-1", callKind: "auto_title",
    });
    const summary = store.usage(sessionId);
    assert.equal(summary.lastPromptTokens, 500);
    assert.equal(summary.callBreakdown.find(call => call.model === "flash")?.promptTokens, 160);
    assert.equal(summary.callBreakdown.find(call => call.model === "pro")?.completionTokens, 20);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit workflow separates review-only from repair", () => {
  assert.match(taskInstructions("audit", "shape", "ask", false), /不写文件/);
  assert.match(taskInstructions("audit", "shape", "ask", true), /edit_file.*最小修改/);
});

test("rewrite scope requires concrete evidence before locking to one point", () => {
  assert.equal(normalizeRewriteEditScope(
    "见父亲的片段改一下，关系不要那么僵，更多交流未来规划",
    "point",
    0,
  ), "section");
  assert.equal(normalizeRewriteEditScope("把“他没有回答。”改得自然些", "section", 0), "point");
  assert.equal(normalizeRewriteEditScope("调整当前浏览器选区", "section", 24), "point");
  assert.equal(normalizeRewriteEditScope("全文统一调整父子关系", "point", 0), "document");
});

test("lore entity discussion upgrades to project fact search", () => {
  const catalog = {
    documents: ["lore/超国家实体.md", "lore/军工复合体.md", "chapters/第1章.md"],
    characterNames: ["林雪"],
  };
  assert.equal(
    requestNeedsProjectFactSearch(
      "有人想除掉三大超国家实体里的白鸦，因为会影响军工复合体的利益。我们讨论一下这个点。",
      catalog,
    ),
    true,
  );
  assert.equal(
    requestNeedsProjectFactSearch("白鸦组织的立场是什么？", {
      documents: ["lore/白鸦.md"],
      characterNames: [],
    }),
    true,
  );
  assert.equal(
    requestNeedsProjectFactSearch("怎么写更自然的对白节奏？", catalog),
    false,
  );
});

test("chapter workflow lets the Agent choose a delivery path", () => {
  const instructions = taskInstructions("write_scene", "deliver", "ask", true);
  assert.match(instructions, /自主决定/);
  assert.match(instructions, /完整成稿用 write_file/);
  assert.match(instructions, /局部用 edit_file/);
  assert.match(instructions, /compile_write_pack/);
  assert.match(instructions, /begin_chapter_draft/);
  assert.match(instructions, /write_chapter_scene/);
  assert.match(instructions, /只有长篇连续状态/);
  assert.match(instructions, /不要为了展示流程/);
  assert.match(taskInstructions("write_scene", "deliver", "ask", true, 4_200), /4200 字/);
  assert.match(instructions, /inspect_chapter_draft/);
  assert.match(instructions, /actualState/);
  assert.match(instructions, /characterScopes/);
  assert.match(instructions, /未列入的能力不得在正文使用或点名/);
  assert.match(instructions, /大纲不是前置条件/);
  assert.match(instructions, /设定中的规范术语是事实来源/);
  assert.match(instructions, /表达与句式规则是边界/);
  assert.match(instructions, /孤立且符合人物或文体的表达保留/u);
  assert.match(instructions, /## 表达边界/);
  assert.match(instructions, /不为普通名词制造同义词配额/);
  assert.match(instructions, /问题密集/);
  assert.match(instructions, /重写受影响场景乃至全文/);
  assert.doesNotMatch(instructions, /不能跳过逐场景/);
  const fast = taskInstructions("write_scene", "deliver", "ask", true, 3_000, true);
  assert.match(fast, /快速模式/);
  assert.match(fast, /不要为了展示流程而建立场景链/);
  const withoutScenePipeline = taskInstructions("write_scene", "deliver", "ask", true, 3_000, true, false);
  assert.match(withoutScenePipeline, /场景链已关闭/);
  assert.match(withoutScenePipeline, /禁止调用章节场景链工具/);
  assert.doesNotMatch(withoutScenePipeline, /write_chapter_scene 提交/);
});

test("chapter continuation handoff carries delivery, tail, and final scene state", () => {
  const tail = "走廊尽头的灯灭了。".repeat(200);
  const prompt = chapterContinuationPrompt({
    nextStep: "第1章已落地，继续撰写第2章。",
    proposal: { path: "chapters/第1章.md", summary: "主角违规进入训练区", afterContent: tail },
    handoff: {
      path: "chapters/第1章.md",
      sceneCount: 3,
      finalActualState: {
        situation: ["警报已触发"], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
      },
    },
    materialsShelf: [
      { path: "lore/world.md", digest: "世界规则摘要", fullBodyServed: true },
      { characterId: 3, digest: "林千夏", fullBodyServed: true },
    ],
  });
  assert.match(prompt, /禁止重复提交同一章/);
  assert.match(prompt, /chapters\/第1章\.md/);
  assert.match(prompt, /警报已触发/);
  assert.match(prompt, /重新选择 write_file/);
  assert.match(prompt, /撰写第2章/);
  assert.match(prompt, /材料架已收录/);
  assert.match(prompt, /lore\/world\.md/);
  assert.match(prompt, /禁止对上述路径\/角色无目标整篇重读|禁止对上述路径\/角色再/);
  // Tail excerpt is bounded so the handoff stays cheap on every remaining step.
  const afterTail = prompt.split("上一章结尾")[1] ?? "";
  const tailOnly = afterTail.split("上一章末场")[0] ?? afterTail;
  assert.ok(tailOnly.length < 1_200, `tail block too long: ${tailOnly.length}`);

  const minimal = chapterContinuationPrompt({ nextStep: "继续下一份正文。" });
  // The only source of「还要写什么」is the terminal gate's instruction, carried verbatim.
  assert.match(minimal, /继续下一份正文。/);
  assert.doesNotMatch(minimal, /已交付：/);
  assert.match(minimal, /材料架仍空/);
});

test("proposal revision converge prompt carries the scoped blocker packet", () => {
  const first = proposalRevisionConvergePrompt({
    status: "final_review_revision_required",
    code: "DIRECT_CHAPTER_REVIEW_BLOCKED",
    path: "chapters/a.md",
    message: "修英文残留",
  }, 1);
  assert.match(first, /当前门禁第 1 次/);
  assert.match(first, /最小修订/);
  assert.doesNotMatch(first, /最后一轮/);
  const withStructuredBlocker = proposalRevisionConvergePrompt({
    status: "final_review_revision_required",
    code: "DIRECT_CHAPTER_REVIEW_BLOCKED",
    path: "chapters/a.md",
    message: "终审未通过",
  }, 1, {
    schemaVersion: 3,
    revisionCaseId: "revision:test",
    runId: "run-test",
    deliverableId: "document-1",
    path: "chapters/a.md",
    baseDocumentExists: false,
    baseDocumentSourceHash: "__missing__",
    draftArtifactId: 10,
    draftSourceHash: "draft-hash",
    reviewArtifactId: 11,
    attempt: 1,
    lastGate: "semantic_review",
    retryState: {
      runId: "run-test",
      deliverableId: "document-1",
      path: "chapters/a.md",
      gateAttempts: { style: 0, rhythm: 0, length: 0, semantic_review: 1, proposal: 0 },
      semanticNoProgress: 0,
      absoluteSubmissions: 1,
    },
    unresolvedIssues: [{
      id: "issue:ability",
      severity: "blocker",
      kind: "fact_conflict",
      evidence: ["她把循环交给脊柱超算"],
      problem: "超算核心尚未解锁",
      action: "改用已解锁纳米核心",
    }],
    resolvedIssueIds: [],
    stillPresentIssueIds: [],
    newlyIntroducedIssueIds: ["issue:ability"],
    status: "blocked",
    retention: "executable",
  });
  assert.match(withStructuredBlocker, /issue:ability/);
  assert.match(withStructuredBlocker, /脊柱超算/);
  assert.match(withStructuredBlocker, /已解锁纳米核心/);
  assert.match(withStructuredBlocker, /read_file/);
  assert.match(withStructuredBlocker, /edit_file/);
  assert.doesNotMatch(withStructuredBlocker, /artifactId/);
  const directPacket = proposalRevisionConvergePrompt({
    status: "revision_required",
    code: "PROSE_STYLE_REVISION_REQUIRED",
    path: "chapters/a.md",
    repairPacket: {
      path: "chapters/a.md",
      sourceHash: "working-hash",
      issueCount: 2,
      issues: [
        {
          id: "style:early",
          kind: "contrast:split_redefinition",
          line: 12,
          oldText: "这不是训练。是处决。",
          evidence: "这不是训练。是处决。",
          suggestion: "直接写出训练场的实际用途",
        },
        {
          id: "style:late",
          kind: "contrast:split_redefinition",
          line: 263,
          oldText: "这不是撤退。是蓄力。",
          evidence: "这不是撤退。是蓄力。",
          suggestion: "改成可观察行动",
        },
      ],
    },
  }, 1);
  assert.match(directPacket, /立即用一次 edit_file/);
  assert.match(directPacket, /style:late/);
  assert.match(directPacket, /不要先 read_file/);
  assert.doesNotMatch(directPacket, /下一步用 read_file/);
  const last = proposalRevisionConvergePrompt({
    status: "error",
    message: "句式门禁",
  }, 2);
  assert.match(last, /最后一轮/);
  assert.match(last, /ask_user/);
});

test("proposal retry policy counts only same semantic blockers as no progress", () => {
  assert.equal(isExpectedRhythmPolish({
    code: "RHYTHM_POLISH_REQUIRED",
    rhythmRevisionRequired: true,
  }), true);
  assert.equal(isExpectedRhythmPolish({
    code: "DIRECT_CHAPTER_REVIEW_BLOCKED",
  }), false);

  const initial = createProposalRetryState({
    runId: "run-1", deliverableId: "document-1", path: "chapters/a.md",
  });
  const dependency = decideProposalFailure({
    code: "PROSE_GATE_UNAVAILABLE",
    failureKind: "dependency",
    retryable: true,
  }, initial);
  assert.equal(dependency.action, "pause");
  assert.equal(dependency.action === "pause" ? dependency.reason : "", "dependency");
  assert.equal(dependency.state.absoluteSubmissions, 0);

  const style = decideProposalFailure({
    code: "PROSE_STYLE_REVISION_REQUIRED",
    failureKind: "semantic_revision",
    error: "句式门禁",
  }, initial);
  assert.equal(style.action, "revise");
  assert.equal(style.action === "revise" ? style.gate : "", "style");
  assert.equal(style.state.gateAttempts.style, 1);
  assert.equal(style.state.semanticNoProgress, 0);
  const styleTwice = decideProposalFailure({
    code: "PROSE_STYLE_REVISION_REQUIRED",
    failureKind: "semantic_revision",
    error: "句式门禁",
  }, style.state);
  assert.equal(styleTwice.state.gateAttempts.style, 2);
  assert.equal(styleTwice.action, "pause", "style auto-retry stops at MAX_DETERMINISTIC_GATE_ATTEMPTS");
  assert.equal(styleTwice.action === "pause" ? styleTwice.exhaustion : "", "gate_attempts");

  // After a style pause, reaching semantic review on a later path still clears deterministic streaks.
  const issueA = { id: "issue:a" };
  const firstSemantic = decideProposalFailure({
    code: "DIRECT_CHAPTER_REVIEW_BLOCKED",
    status: "final_review_revision_required",
  }, styleTwice.state, proposalIssueTransition([], [issueA]));
  assert.equal(firstSemantic.action, "revise");
  assert.equal(firstSemantic.state.semanticNoProgress, 0);
  assert.equal(firstSemantic.state.gateAttempts.style, 0, "reaching semantic review proves style passed");

  const issueB = { id: "issue:b" };
  const movingBlocker = decideProposalFailure({
    code: "DIRECT_CHAPTER_REVIEW_BLOCKED",
    status: "final_review_revision_required",
  }, firstSemantic.state, proposalIssueTransition([issueA], [issueB]));
  assert.equal(movingBlocker.action, "revise");
  assert.equal(movingBlocker.state.semanticNoProgress, 0);
  assert.equal(movingBlocker.state.gateAttempts.style, 0, "passed deterministic gates stay reset");

  const laterStyle = decideProposalFailure({
    code: "PROSE_STYLE_REVISION_REQUIRED",
    failureKind: "semantic_revision",
    error: "语义修订引入了新的句式问题",
  }, firstSemantic.state);
  assert.equal(laterStyle.action, "revise");
  assert.equal(laterStyle.state.gateAttempts.style, 1, "a later style regression starts a new streak");

  const sameOnce = decideProposalFailure({
    code: "DIRECT_CHAPTER_REVIEW_BLOCKED",
    status: "final_review_revision_required",
  }, firstSemantic.state, proposalIssueTransition([issueA], [issueA]));
  assert.equal(sameOnce.action, "revise");
  assert.equal(sameOnce.state.semanticNoProgress, 1);
  const sameTwice = decideProposalFailure({
    code: "DIRECT_CHAPTER_REVIEW_BLOCKED",
    status: "final_review_revision_required",
  }, sameOnce.state, proposalIssueTransition([issueA], [issueA]));
  assert.equal(sameTwice.action, "pause");
  assert.equal(sameTwice.action === "pause" ? sameTwice.exhaustion : "", "semantic_no_progress");

  const invalidCall = decideProposalFailure({
    code: "INVALID_TOOL_ARGUMENTS_JSON",
    error: "工具参数不是有效 JSON",
  }, firstSemantic.state);
  assert.equal(invalidCall.action, "correct_call");
  assert.equal(invalidCall.state.semanticNoProgress, 0);
  assert.equal(invalidCall.state.absoluteSubmissions, firstSemantic.state.absoluteSubmissions);

  const invalidReview = decideProposalFailure({
    code: "DIRECT_CHAPTER_REVIEW_INVALID",
    failureKind: "invalid_output",
    message: "JSON 无法解析",
  }, firstSemantic.state);
  assert.equal(invalidReview.action, "correct_call");
  assert.equal(invalidReview.state.semanticNoProgress, 0);
  assert.equal(invalidReview.state.gateAttempts.semantic_review, 1);

  const driftedBase = decideProposalFailure({
    status: "recoverable_state_error",
    code: "PROPOSAL_REVISION_BASE_CHANGED",
    failureKind: "invalid_request",
    retryable: false,
    error: "目标文档已变化",
  }, firstSemantic.state);
  assert.equal(driftedBase.action, "pause");
  assert.equal(driftedBase.action === "pause" ? driftedBase.reason : "", "invalid_request");
  assert.deepEqual(driftedBase.state, firstSemantic.state, "base drift must consume no retry budget");
});

test("correct_call keeps the newest scoped draft without replacing semantic baseline", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-proposal-correct-call-"));
  const project = WriterProject.init(root, "correct-call");
  const store = new WriterStore(project);
  try {
    const sessionId = store.createSession("correct-call");
    const path = "chapters/retry.md";
    const deliverableId = "document-1";
    const baseContent = "# 原稿\n\n落盘版本。";
    project.writeRaw(path, baseContent);
    const documentBase = captureProposalRevisionDocumentBase(project, path);
    const retryState = createProposalRetryState({ runId: "run-correct", deliverableId, path });
    const issue: ProposalRevisionIssue = {
      id: "issue:knowledge",
      severity: "blocker",
      kind: "knowledge_leak",
      evidence: ["她已经知道答案。"],
      oldText: "她已经知道答案。",
      problem: "正文没有给出获知路径",
      action: "补足获知路径",
    };
    const rejectedContent = "# 原稿\n\n她已经知道答案。";
    const rejectedHash = project.hash(rejectedContent);
    const rejectedArtifactId = store.saveContextArtifact(sessionId, {
      cacheKey: "test:correct-call:rejected",
      kind: "proposal_revision_draft",
      path,
      sourceHash: rejectedHash,
      content: rejectedContent,
      digest: "初次驳回稿",
    });
    const first = saveProposalRevisionCase(
      { artifactId: rejectedArtifactId, path, deliverableId, sourceHash: rejectedHash },
      "semantic_review",
      retryState,
      1,
      [issue],
      proposalIssueTransition([], [issue]),
      documentBase,
      store,
      sessionId,
      undefined,
      { semanticVerdict: true },
    );

    const correctedContent = "# 原稿\n\n她从录音里听见答案。";
    const correctedHash = project.hash(correctedContent);
    const correctedArtifactId = store.saveContextArtifact(sessionId, {
      cacheKey: "test:correct-call:latest",
      kind: "proposal_revision_draft",
      path,
      sourceHash: correctedHash,
      content: correctedContent,
      digest: "参数错误前的最新修订稿",
    });
    const latest = saveProposalRevisionCase(
      { artifactId: correctedArtifactId, path, deliverableId, sourceHash: correctedHash },
      first.revisionCase.lastGate,
      first.revisionCase.retryState,
      first.revisionCase.attempt,
      undefined,
      undefined,
      undefined,
      store,
      sessionId,
      first.revisionCase,
      { semanticVerdict: false },
    );

    assert.equal(latest.revisionCase.draftArtifactId, correctedArtifactId);
    assert.equal(latest.revisionCase.semanticDraftArtifactId, rejectedArtifactId);
    assert.deepEqual(latest.revisionCase.unresolvedIssues, [issue]);
    assert.equal(first.revisionCase.repairPacket?.sourceHash, rejectedHash);
    assert.equal(first.revisionCase.repairPacket?.issues[0]?.oldText, issue.oldText);
    assert.equal(latest.revisionCase.repairPacket, undefined, "stale direct anchors must not survive a changed draft");
    assert.deepEqual(latest.revisionCase.retryState, first.revisionCase.retryState);
    assert.equal(latest.revisionCase.attempt, first.revisionCase.attempt);
    assert.deepEqual({
      exists: latest.revisionCase.baseDocumentExists,
      hash: latest.revisionCase.baseDocumentSourceHash,
    }, { exists: true, hash: project.hash(baseContent) });
    assert.equal(proposalFailureShouldPersistRevisionCase({
      hasScopedDraft: true,
      action: "correct_call",
      retryStateChanged: false,
      hasPreviousCase: true,
    }), true);
    assert.equal(proposalFailureDraft({
      action: "correct_call",
      caseDraft: latest,
      previousCase: first.revisionCase,
    })?.artifactId, correctedArtifactId);

    const wrongPathDraft = { artifactId: 999, path: "chapters/other.md", deliverableId, sourceHash: correctedHash };
    assert.equal(proposalFailureShouldPersistRevisionCase({
      hasScopedDraft: false,
      action: "correct_call",
      retryStateChanged: false,
      hasPreviousCase: true,
    }), false);
    assert.equal(proposalFailureDraft({
      action: "correct_call",
      savedDraft: wrongPathDraft,
      previousCase: latest.revisionCase,
    })?.artifactId, correctedArtifactId, "wrong-path calls must keep the active case draft");
    assert.notEqual(
      proposalRevisionDraftCacheKey({ runId: "run-correct", deliverableId, path, sourceHash: correctedHash }),
      proposalRevisionDraftCacheKey({
        runId: "run-correct", deliverableId, path: "chapters/other.md", sourceHash: correctedHash,
      }),
      "same-content drafts on different paths must not share an artifact cache key",
    );

    assert.equal(proposalRevisionBaseChangeReason(project, latest.revisionCase), undefined);
    project.writeRaw(path, "# 外部新版本\n\n另一任务已修改。\n");
    assert.match(proposalRevisionBaseChangeReason(project, latest.revisionCase) ?? "", /已被其他操作修改/u);
    project.removeDocument(path);
    assert.match(proposalRevisionBaseChangeReason(project, latest.revisionCase) ?? "", /已被删除/u);

    const missingPath = "chapters/new.md";
    const missingBase = captureProposalRevisionDocumentBase(project, missingPath);
    const missingCase: ProposalRevisionCase = {
      ...latest.revisionCase,
      path: missingPath,
      baseDocumentExists: missingBase.baseDocumentExists,
      baseDocumentSourceHash: missingBase.baseDocumentSourceHash,
      retryState: { ...latest.revisionCase.retryState, path: missingPath },
    };
    assert.equal(proposalRevisionBaseChangeReason(project, missingCase), undefined);
    project.writeRaw(missingPath, "# 被另一任务创建\n");
    assert.match(proposalRevisionBaseChangeReason(project, missingCase) ?? "", /已被其他操作创建/u);

    const legacy = { ...latest.revisionCase } as unknown as Record<string, unknown>;
    legacy.schemaVersion = 2;
    delete legacy.baseDocumentExists;
    delete legacy.baseDocumentSourceHash;
    assert.match(
      proposalRevisionBaseChangeReason(project, legacy as unknown as ProposalRevisionCase) ?? "",
      /旧版运行时/u,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposal pause display includes exact blocker evidence, problem and action", () => {
  const retryState = createProposalRetryState({
    runId: "run-pause", deliverableId: "document-1", path: "chapters/a.md",
  });
  const revisionCase = {
    schemaVersion: 3 as const,
    revisionCaseId: "revision:pause",
    runId: "run-pause",
    deliverableId: "document-1",
    path: "chapters/a.md",
    baseDocumentExists: false,
    baseDocumentSourceHash: "__missing__",
    draftArtifactId: 1102,
    draftSourceHash: "draft-hash",
    semanticDraftArtifactId: 1102,
    semanticDraftSourceHash: "draft-hash",
    reviewArtifactId: 1103,
    attempt: 3,
    lastGate: "semantic_review" as const,
    retryState,
    unresolvedIssues: [{
      id: "issue:hearing",
      severity: "blocker",
      kind: "knowledge_leak",
      evidence: ["她先听见了回答。"],
      problem: "听觉编码尚未建立，角色没有获得对白的路径",
      action: "把听见对白移到听觉编码恢复之后",
    }],
    resolvedIssueIds: [],
    stillPresentIssueIds: ["issue:hearing"],
    newlyIntroducedIssueIds: [],
    status: "blocked" as const,
    retention: "executable" as const,
  };
  const paused = proposalFailurePauseResult(
    { message: "终审未通过" },
    "revision_exhausted",
    { artifactId: 1102, path: "chapters/a.md", sourceHash: "draft-hash", revisionCase },
    { exhaustion: "semantic_no_progress", gate: "semantic_review" },
  );
  assert.match(String(paused.displayMessage), /她先听见了回答/u);
  assert.match(String(paused.displayMessage), /听觉编码尚未建立/u);
  assert.match(String(paused.displayMessage), /移到听觉编码恢复之后/u);
  assert.match(String(paused.displayMessage), /工作副本/u);
  assert.equal(paused.workingCopy, true);
  assert.equal("artifactId" in paused, false);
});

test("terminal text stays free of job ids (metadata lives in the job menu)", () => {
  assert.equal(appendTerminalJobReference("审核依赖暂时不可用。", "job-abc123"), "审核依赖暂时不可用。");
  assert.equal(appendTerminalJobReference("内容", undefined), "内容");
});

test("document delivery completion summary covers multi-path and placeholder filtering", () => {
  assert.equal(
    documentDeliveryCompletionMessage([
      { label: "第1章", evidence: { path: "chapters/a.md" } },
      { label: "第2章", evidence: { path: "chapters/b.md" } },
    ]),
    "已交付 2 份文档：\n- chapters/a.md\n- chapters/b.md",
  );
  assert.equal(
    documentDeliveryCompletionMessage([], "chapters/only.md"),
    "已交付 chapters/only.md。",
  );
  assert.equal(isVisibleAssistantText("[工具调用已隐藏]"), false);
  assert.equal(isVisibleAssistantText("已交付 chapters/a.md。"), true);
  assert.equal(terminalAssistantText({
    role: "assistant",
    content: "现在委托 Writer 落盘第六章。",
    tool_calls: [{
      id: "call-write",
      type: "function",
      function: { name: "write_file", arguments: "{}" },
    }],
  }), undefined);
  assert.equal(terminalAssistantText({
    role: "assistant",
    content: "六章正文已经全部交付。",
  }), "六章正文已经全部交付。");
});

test("proposal pause reports when no independent review fallback exists", () => {
  const paused = proposalFailurePauseResult({
    error: "语义正文门控暂时不可用（仅配置 1 个唯一审核模型，无独立回退）：句式二审连续两次返回空内容",
  }, "dependency");
  assert.match(String(paused.displayMessage), /仅配置了一个唯一模型/u);
  assert.doesNotMatch(String(paused.displayMessage), /审核模型及回退模型均不可用/u);
});

test("proposal pause surfaces structured final-review diagnostics", () => {
  const paused = proposalFailurePauseResult({
    status: "final_review_unavailable",
    code: "DIRECT_CHAPTER_REVIEW_UNAVAILABLE",
    failureKind: "dependency",
    message: "终审模型调用失败（仅配置 1 个唯一模型，无独立回退），未创建提案。依赖恢复后可续跑；不得在未完成事实与认知边界审核时绕过终审。",
    errors: ["[timeout] 唯一模型 OpenCode Go / deepseek-v4-flash · 300012ms · 整章终审请求超时（300012ms）"],
    diagnostics: {
      stage: "final_review",
      uniqueModelCount: 1,
      parseOnly: false,
      timedOut: true,
      hasIndependentFallback: false,
      errors: ["[timeout] 唯一模型 OpenCode Go / deepseek-v4-flash · 300012ms · 整章终审请求超时（300012ms）"],
      attempts: [{
        model: "deepseek-v4-flash",
        providerName: "OpenCode Go",
        role: "sole",
        class: "timeout",
        message: "整章终审请求超时（300012ms）",
        durationMs: 300_012,
        recordedUsage: true,
        at: "2026-08-07T13:49:28.000Z",
      }],
    },
  }, "dependency", { artifactId: 1, path: "chapters/02-满载.md", sourceHash: "abc" });
  const text = String(paused.displayMessage);
  assert.match(text, /响应超时/u);
  assert.match(text, /唯一模型/u);
  assert.match(text, /deepseek-v4-flash/u);
  assert.match(text, /300012ms/u);
  assert.match(text, /chapters\/02-满载\.md/u);
  assert.doesNotMatch(text, /审核模型及回退模型均不可用/u);
});

test("proposal pause falls back to errors[] when diagnostics missing", () => {
  const paused = proposalFailurePauseResult({
    status: "final_review_unavailable",
    failureKind: "dependency",
    message: "终审模型及回退模型均不可用，未创建提案。",
    errors: ["整章终审请求失败（502）：bad gateway", "fallback also failed"],
  }, "dependency");
  const text = String(paused.displayMessage);
  assert.match(text, /诊断/u);
  assert.match(text, /502/u);
  assert.match(text, /fallback also failed/u);
});

test("scene continuation handoff carries seam tail, states and next card without full prose", () => {
  let draft = beginChapterSceneDraft({
    path: "chapters/第1章.md", mode: "create", heading: "第1章", chapterGoal: "关系反转",
    baseContent: "", baseHash: "empty",
    scenes: [
      {
        id: "s1", title: "抵达", goal: "进入基地", obstacle: "门禁", turn: "冻结令", outcome: "违规进入",
        readerQuestion: "谁下了冻结令", cost: "违规记录已留下", handoff: "触发警报",
      },
      {
        id: "s2", title: "警报", goal: "处置违规", obstacle: "实弹防卫", turn: "教官担责", outcome: "秘密共担",
        readerQuestion: "教官担下的责任要怎么偿还", handoff: "",
      },
    ],
  });
  const sceneBody = `独属于开场的第一句钥匙句。${"她沿着通道往里走，门禁灯逐个变红。".repeat(80)}警报在头顶炸开。`;
  draft = writeChapterScene(draft, "s1", sceneBody, {
    situation: ["警报已触发"], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
  }).draft;
  const prompt = sceneContinuationPrompt(draft, {});
  assert.match(prompt, /已完成 1\/2 场/);
  assert.match(prompt, /警报在头顶炸开/);
  assert.match(prompt, /警报已触发/);
  assert.match(prompt, /"id":"s2"/);
  assert.match(prompt, /sceneId=s2/);
  assert.match(prompt, /revise_chapter_scene_guide/);
  assert.doesNotMatch(prompt, /styleFeedback|stylePriorNotes|禁用段首起笔/u);
  assert.match(prompt, /不要输出计划说明/);
  // Only the bounded tail of the finished scene survives — never its full prose.
  assert.doesNotMatch(prompt, /钥匙句/);
  const tailBlock = (prompt.split("上一场结尾")[1] ?? "").split("各场实际离场状态")[0];
  assert.ok(tailBlock.length > 0 && tailBlock.length < 1_000, `tail block out of bounds: ${tailBlock.length}`);

  draft = writeChapterScene(draft, "s2", "教官在警报声里签下自己的名字。".repeat(10), {
    situation: ["违规被共同隐瞒"], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
  }).draft;
  const complete = sceneContinuationPrompt(draft, {});
  assert.match(complete, /当前没有未写 scene guide/);
  assert.match(complete, /inspect_chapter_draft/);
  const reviewLock = chapterReviewRequiredPrompt(draft);
  assert.match(reviewLock, /已完成（2\/2）/);
  assert.match(reviewLock, /唯一下一步：立即调用 inspect_chapter_draft/);
  assert.match(reviewLock, /运行时已自动推进章节阶段/);
  assert.match(reviewLock, /禁止重写、续写或重新建立 scene guide/);
  assert.equal(chapterReviewAllowsTool("inspect_chapter_draft"), true);
  assert.equal(chapterReviewAllowsTool("read_file"), false);
  assert.equal(chapterReviewAllowsTool("write_chapter_scene"), false);
  const reviewRetry = chapterReviewRequiredPrompt(draft, {
    rejectedTools: ["write_chapter_scene", "read_file", "write_chapter_scene"],
    attempt: 2,
  });
  assert.match(reviewRetry, /第 2 次/);
  assert.match(reviewRetry, /write_chapter_scene、read_file/);
  assert.match(reviewRetry, /这些调用未执行，草稿没有变化/);
  assert.equal(chapterDraftNeedsReview(draft, "scene_written"), true);
  assert.equal(chapterDraftNeedsReview(draft, "review_blocked"), false);
  draft.inspectedVersion = draft.version;
  assert.equal(chapterDraftNeedsReview(draft, "scene_written"), false);
});

test("actionable chapter review results release the inspect-only terminal lock", () => {
  assert.equal(chapterReviewCompleted({
    status: "style_revision_required",
    error: "六个句子需要精确替换",
  }), true);
  assert.equal(chapterReviewCompleted({ status: "structural_revision_required" }), true);
  assert.equal(chapterReviewCompleted({ status: "inspection_required" }), false);
  assert.equal(chapterReviewCompleted({ status: "final_review_unavailable" }), false);
  assert.equal(chapterReviewCompleted({ status: "proposal_failed", error: "提案暂时失败" }), true);
  assert.equal(chapterReviewCompleted({ status: "proposal_submitted" }), true);
  assert.equal(chapterReviewCompleted({ error: "缺少有效参数：summary" }), false);
  assert.equal(chapterReviewCompleted({ status: "error", error: "工具执行失败" }), false);
});

test("automatic chapter review preserves character evolution and scopes rejected repairs", () => {
  assert.equal(automaticChapterReviewEnabled(false), true);
  assert.equal(automaticChapterReviewEnabled(true), false);
  assert.equal(automaticChapterReviewEnabled(undefined), false);

  const style = chapterReviewRepairLock({ status: "style_revision_required" });
  assert.deepEqual(style, { mode: "style" });
  assert.equal(chapterReviewRepairAllowsTool(style!, "revise_chapter_draft_style"), true);
  assert.equal(chapterReviewRepairAllowsTool(style!, "write_chapter_scene", JSON.stringify({ sceneId: "s1" })), false);
  assert.equal(chapterReviewRepairAllowsTool(style!, "propose_chapter_draft"), false);
  assert.equal(chapterReviewRepairAllowsTool(style!, "read_document", JSON.stringify({ path: "chapters/one.md" })), true);

  const structural = chapterReviewRepairLock({
    status: "structural_revision_required",
    targetScenes: [{ sceneId: "s2" }, { sceneId: "s2" }, { sceneId: "s4" }],
  });
  assert.deepEqual(structural, { mode: "structural", targetSceneIds: ["s2", "s4"] });
  assert.equal(chapterReviewRepairAllowsTool(structural!, "write_chapter_scene", JSON.stringify({ sceneId: "s2" })), true);
  assert.equal(chapterReviewRepairAllowsTool(structural!, "write_chapter_scene", JSON.stringify({ sceneId: "s4" })), true);
  assert.equal(chapterReviewRepairAllowsTool(structural!, "write_chapter_scene", JSON.stringify({ sceneId: "s3" })), false);
  assert.equal(chapterReviewRepairAllowsTool(structural!, "revise_chapter_scene_guide"), false);
  assert.equal(chapterReviewRepairAllowsTool(structural!, "write_chapter_scene", "{"), false);
});

type Msg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  reasoning_content?: string;
};

test("stable system prefix uses fixed slots and is byte-stable across empty optional files", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-prefix-"));
  try {
    const project = WriterProject.init(root, "前缀");
    const store = new WriterStore(project);
    const a = buildStableSystemPrefix(project, store, "ask", { intensive: false }, "general");
    const b = buildStableSystemPrefix(project, store, "ask", { intensive: false }, "general");
    assert.equal(a.length, 6);
    assert.ok(a.every(message => message.role === "system"));
    assert.deepEqual(a.map(m => m.content), b.map(m => m.content));
    // Placeholders/catalogs keep slot count when optional project files are absent.
    assert.match(messageContentText(a[2].content), /项目指令/);
    assert.match(messageContentText(a[3].content), /项目技能/);
    assert.match(messageContentText(a[3].content), /chapter-planning/);
    assert.doesNotMatch(messageContentText(a[3].content), /提交前验收/);
    assert.match(messageContentText(a[0].content), /apply_character_changes/);
    assert.match(messageContentText(a[0].content), /角色卡声线只约束所属角色说出口的对白/);
    // Slot 4/5 must not flip with intensive or audit — those go in the dynamic tail.
    const intensive = buildStableSystemPrefix(project, store, "ask", { intensive: true }, "write_scene");
    const audit = buildStableSystemPrefix(project, store, "ask", { intensive: false }, "audit");
    assert.equal(audit.length, 6);
    assert.equal(a[4].content, intensive[4].content);
    assert.equal(a[5].content, audit[5].content);
    assert.equal(a[5].content, intensive[5].content);
    assert.match(messageContentText(a[4].content), /风格锚定/);
    assert.match(messageContentText(a[5].content), /当前任务/);
    assert.doesNotMatch(messageContentText(a[5].content), /终审专则/);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the turn's prose-length target lives in the dynamic tail, never in the stable prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-length-"));
  try {
    const project = WriterProject.init(root, "篇幅");
    const store = new WriterStore(project);
    const task = {
      mode: "write_scene" as const,
      label: "写一章",
      searchQuery: "",
      characterIds: [],
      exampleIds: [],
      documentContext: "target" as const,
      proseReferenceMode: "project" as const,
      creativeDepth: "deliver" as const,
      editScope: "document" as const,
      documentProposalRequired: true,
      continuation: false,
      todoPlan: [],
      documentDeliverables: ["chapters/01.md"],
      outcome: "document" as const,
      evidence: "none" as const,
      mutation: "document" as const,
      planning: "adaptive" as const,
      capabilities: ["documents" as const],
      workflow: "chapter_delivery" as const,
      qualityProfile: "standard" as const,
    };
    const scenePipeline = {
      enabled: false, preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5,
      notesMaxCharacters: 3_000, candidateCount: 1,
    };
    const withTarget = dynamicContextPrompt(
      project, store, "写一章", task, "ask", scenePipeline, "fast", false,
      undefined, undefined, undefined, false,
      { targetCharacters: 4_200, source: "prompt_relative", mode: "bounded" },
    );
    assert.match(withTarget, /单章篇幅目标：本轮涉及的每一章都分别约 4200 字/u);
    assert.match(withTarget, /不是本轮所有章节合计；不得因本轮要写多章而均分/u);
    assert.match(withTarget, /用户本轮要求相对项目默认调整/u);

    const guidanceTarget = dynamicContextPrompt(
      project, store, "写一章", task, "ask", scenePipeline, "fast", false,
      undefined, undefined, undefined, false,
      { targetCharacters: 4_200, source: "settings", mode: "guidance" },
    );
    assert.match(guidanceTarget, /弱引导只表示运行时不为差额强制返工/u);
    assert.match(guidanceTarget, /章节已经自然完整时不要事后用总结、复述或无效支线机械凑字/u);

    // 这个数字每轮都可能变，只能待在 miss-priced 的动态块里。
    const stable = buildStableSystemPrefix(project, store, "ask", { intensive: false }, "write_scene");
    assert.equal(stable.length, 6);
    assert.ok(stable.every(message => !/单章篇幅目标/u.test(messageContentText(message.content))));

    // 没有解析出目标时不占位，免得给动态块加一行常量字节。
    const withoutTarget = dynamicContextPrompt(
      project, store, "写一章", task, "ask", scenePipeline, "fast", false,
    );
    assert.doesNotMatch(withoutTarget, /单章篇幅目标：/u);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("character read scope does not inject every visible card into writing context", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-character-scope-"));
  try {
    const project = WriterProject.init(root, "角色范围");
    const store = new WriterStore(project);
    const participant = store.saveCharacter({
      ...emptyCharacter("参演者"),
      identity: { ...emptyCharacter("参演者").identity, summary: "本场的行动者" },
    });
    const readableOnly = store.saveCharacter({
      ...emptyCharacter("仅可读取者"),
      identity: { ...emptyCharacter("仅可读取者").identity, summary: "不在本场" },
    });
    const task = {
      mode: "write_scene" as const,
      label: "写一章",
      searchQuery: "",
      characterIds: [participant.id],
      exampleIds: [],
      documentContext: "target" as const,
      proseReferenceMode: "project" as const,
      creativeDepth: "deliver" as const,
      editScope: "document" as const,
      documentProposalRequired: true,
      continuation: false,
      todoPlan: [],
      documentDeliverables: ["chapters/01.md"],
      outcome: "document" as const,
      evidence: "none" as const,
      mutation: "document" as const,
      planning: "adaptive" as const,
      capabilities: ["documents" as const],
      workflow: "chapter_delivery" as const,
      qualityProfile: "standard" as const,
    };
    const scenePipeline = {
      enabled: false, preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5,
      notesMaxCharacters: 3_000, candidateCount: 1,
    };
    const prompt = dynamicContextPrompt(
      project, store, "写参演者的场景", task, "ask", scenePipeline, "fast", false,
      [participant.id, readableOnly.id],
    );
    assert.match(prompt, /参演者/u);
    assert.doesNotMatch(prompt, /仅可读取者|不在本场/u);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dynamic turn messages always expose the same slot count", () => {
  const full = buildDynamicTurnMessages({
    historyText: "历史",
    archiveContext: "归档",
    taskContext: "任务",
    dynamicStyleContext: "声线",
    bootstrapContext: "线索",
    reservedSlot: "（保留槽位）",
    artifactContext: "记忆",
    selectedContext: "选区",
    prompt: "写一章",
  });
  const empty = buildDynamicTurnMessages({
    historyText: "历史对话：（无）",
    archiveContext: "归档",
    taskContext: "任务",
    prompt: "闲聊",
  });
  assert.equal(full.length, 9);
  assert.equal(empty.length, 9);
  assert.equal(full.at(-1)?.role, "user");
  assert.equal(messageContentText(empty.at(-1)?.content), "闲聊");
  assert.match(messageContentText(empty[3].content), /动态声线/);
  assert.match(messageContentText(empty[6].content), /工作记忆/);
});

test("cache waterfall fingerprints stable messages and tools but not dynamic content", () => {
  const tools = agentToolsForTask("general", "ask");
  const components = buildRequestComponentUsage([
    { role: "system", content: "稳定" },
    { role: "system", content: "动态" },
    { role: "user", content: "请求" },
  ], tools, 1, 3);
  assert.equal(components.find(item => item.kind === "tool_schema")?.fingerprint?.length, 12);
  assert.equal(components.find(item => item.kind === "stable_system")?.fingerprint?.length, 12);
  assert.equal(components.find(item => item.kind === "dynamic_system")?.fingerprint, undefined);
  assert.equal(components.find(item => item.kind === "user")?.fingerprint, undefined);
});

test("recent roleplay handoff preserves exact turns and director boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-roleplay-handoff-"));
  try {
    const project = WriterProject.init(root, "试演转正文");
    const store = new WriterStore(project);
    const sessionId = store.createSession("转换");
    store.addMessage(sessionId, "user", "先讨论大纲", "agent");
    store.addMessage(sessionId, "user", "把地点改到雨夜站台，怀表已经摔碎。", "roleplay", undefined, "director");
    store.addMessage(sessionId, "assistant", "她捡起两截表链，没有把表盘复原。", "roleplay");

    const handoff = recentRoleplayHandoffContext(store, sessionId);
    assert.match(handoff, /\[导演指令\]/);
    assert.match(handoff, /怀表已经摔碎/);
    assert.match(handoff, /没有把表盘复原/);
    assert.doesNotMatch(handoff, /先讨论大纲/);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read atoms lock one source snapshot, reuse exact coverage and allow wider context", () => {
  const context: ToolExecutionContext = {
    permissionMode: "ask",
    readSnapshots: new Map(),
    readCharactersUsed: 0,
  };
  const first = JSON.stringify({
    path: "lore/world.md", sourceHash: "h1", startLine: 10, endLine: 20, content: "设定".repeat(200),
  });
  assert.equal(admitReadAtom("read_document", "lore/world.md", "h1", first, context), first);
  assert.equal(context.readCharactersUsed, 400);

  const duplicate = JSON.parse(admitReadAtom("read_document", "lore/world.md", "h1", first, context)) as Record<string, unknown>;
  assert.equal(duplicate.status, "read_atom_reused");
  assert.equal("content" in duplicate, false);

  const overlapPayload = JSON.stringify({
    path: "lore/world.md", sourceHash: "h1", startLine: 18, endLine: 25, content: "重叠",
  });
  assert.equal(admitReadAtom("read_document", "lore/world.md", "h1", overlapPayload, context), overlapPayload);

  const changed = JSON.parse(admitReadAtom("read_document", "lore/world.md", "h2", JSON.stringify({
    path: "lore/world.md", sourceHash: "h2", startLine: 30, endLine: 32, content: "新版本",
  }), context)) as Record<string, unknown>;
  assert.match(String(changed.error), /锁定快照|禁止混读/);
});

test("materials shelf freezes digests and format stays path-stable", () => {
  const context: ToolExecutionContext = {
    permissionMode: "ask",
    materialsShelf: new Map(),
  };
  registerMaterialsShelfEntry(context, {
    path: "lore/b.md",
    sourceHash: "hb",
    kind: "read_document",
    digest: "设定乙",
    bodyChars: 100,
    fullBodyServed: true,
    coveredSections: ["能力边界"],
    exactEvidenceRanges: [{ startLine: 10, endLine: 20 }],
  });
  registerMaterialsShelfEntry(context, {
    path: "lore/a.md",
    sourceHash: "ha",
    kind: "read_document",
    digest: "设定甲",
    bodyChars: 200,
    fullBodyServed: true,
  });
  // Second register upgrades digest but keeps fullBodyServed.
  registerMaterialsShelfEntry(context, {
    path: "lore/a.md",
    sourceHash: "ha",
    kind: "read_document",
    digest: "设定甲更新摘要",
    bodyChars: 50,
    fullBodyServed: false,
  });
  assert.equal(context.materialsShelf?.get("lore/a.md")?.fullBodyServed, true);
  const prompt = formatJobMaterialsShelfPrompt(context);
  assert.match(prompt, /材料架/);
  assert.match(prompt, /会话材料架|跨任务/);
  assert.match(prompt, /lore\/a\.md/);
  assert.match(prompt, /lore\/b\.md/);
  assert.match(prompt, /定点补读|block/);
  assert.match(prompt, /coveredSections/);
  assert.match(prompt, /exactEvidenceRanges/);
  // Sorted by path: a before b.
  assert.ok(prompt.indexOf("lore/a.md") < prompt.indexOf("lore/b.md"));
});

test("materials shelf digest keeps lore headings and targeted supplement detection", () => {
  const body = [
    "# 银翼计划改造规程",
    "",
    "项目概述段落" + "字".repeat(80),
    "",
    "## Phase 0 回收",
    "回收编组优先抵达现场。",
    "",
    "## Phase I 置换",
    "纳米仿生置换在隔离舱完成。",
    "",
    "## Phase II 校准",
    "力量分级与感官阈值。",
    "",
    "## Phase III 武装",
    "首次武装展开。",
  ].join("\n");
  const digest = buildMaterialsShelfDigest("lore/银翼计划改造规程.md", body);
  assert.match(digest, /Phase 0/);
  assert.match(digest, /Phase I/);
  assert.match(digest, /Phase III|武装/);
  assert.ok(digest.length > 200);
  assert.equal(isTargetedDocumentSupplement("read_document", {}), false);
  assert.equal(isTargetedDocumentSupplement("read_document", { block: 2 }), true);
  assert.equal(isTargetedDocumentSupplement("read_document", { startLine: 10, endLine: 40 }), true);
  assert.equal(isTargetedDocumentSupplement("read_document", { quote: "回收编组" }), true);
  assert.equal(isTargetedDocumentSupplement("inspect_document", {}), true);
  assert.equal(isTargetedDocumentSupplement("locate_document_span", { path: "lore/x.md" }), true);
});

test("session materials shelf persists and drops stale sourceHash", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-shelf-"));
  try {
    const project = WriterProject.init(root, "材料架会话");
    const rel = "lore/world.md";
    writeFileSync(join(project.resourceDir, "lore", "world.md"), "设定甲 v1", "utf8");
    const store = new WriterStore(project);
    const sessionId = store.createSession("shelf-session");
    const hash1 = project.hash(project.read(rel));
    store.saveSessionMaterialsShelf(sessionId, [{
      key: rel,
      path: rel,
      sourceHash: hash1,
      kind: "read_document",
      digest: "设定甲摘要",
      bodyChars: 10,
      fullBodyServed: true,
    }]);
    const loaded = hydrateSessionMaterialsShelf(store, sessionId, project);
    assert.equal(loaded.size, 1);
    assert.equal(loaded.get(rel)?.digest, "设定甲摘要");

    // Mutate file → hydrate drops stale entry
    writeFileSync(join(project.resourceDir, "lore", "world.md"), "设定甲 v2 变更", "utf8");
    const after = hydrateSessionMaterialsShelf(store, sessionId, project);
    assert.equal(after.size, 0);
    assert.equal(store.sessionMaterialsShelf(sessionId).length, 0);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compactRuntimeMessages digests older heavy tool bodies and keeps recent full", () => {
  const heavy = JSON.stringify({
    path: "chapters/第1章.md",
    content: "甲".repeat(2_000),
    artifactId: 1,
  });
  const messages: Msg[] = [
    { role: "user", content: "写" },
    { role: "assistant", content: null, tool_call_id: undefined },
    { role: "tool", content: heavy, tool_call_id: "t1" },
    { role: "tool", content: heavy, tool_call_id: "t2" },
    { role: "tool", content: heavy, tool_call_id: "t3" },
    { role: "tool", content: heavy, tool_call_id: "t4" },
    { role: "tool", content: heavy, tool_call_id: "t5" },
  ];
  // Force enough tool volume: 5 tools × ~2k content field
  compactRuntimeMessages(messages as never);
  const toolBodies = messages.filter(m => m.role === "tool").map(m => m.content ?? "");
  assert.ok(toolBodies.some(body => body.includes("artifact_compacted")), "older tools should compact");
  const last = toolBodies.at(-1) ?? "";
  const secondLast = toolBodies.at(-2) ?? "";
  // keepRecent=2 remain full (not compacted status)
  assert.equal(JSON.parse(last).status, undefined);
  assert.equal(JSON.parse(secondLast).status, undefined);
});

test("compactRuntimeMessages with keepRecent 0 digests every heavy body and keeps pairing", () => {
  const heavy = JSON.stringify({ path: "chapters/第1章.md", content: "甲".repeat(2_000), artifactId: 1 });
  const messages: Msg[] = [
    { role: "user", content: "写" },
    { role: "assistant", content: null, tool_calls: [
      { id: "t1", type: "function", function: { name: "read_document", arguments: "{}" } },
      { id: "t2", type: "function", function: { name: "read_document", arguments: "{}" } },
    ] } as Msg,
    { role: "tool", content: heavy, tool_call_id: "t1" },
    { role: "tool", content: heavy, tool_call_id: "t2" },
  ];
  // `force` because two tool bodies sit under the default "is this even worth it"
  // threshold; a cold replay block is compacted regardless of how heavy it is.
  compactRuntimeMessages(messages as never, { keepRecent: 0, force: true });
  const toolBodies = messages.filter(m => m.role === "tool").map(m => m.content ?? "");
  assert.equal(toolBodies.length, 2);
  // slice(0, -0) would have been an empty list — keepRecent 0 must mean "all of them".
  for (const body of toolBodies) assert.match(body, /artifact_compacted/);
  const calls = new Set(messages.flatMap(m => (m as { tool_calls?: Array<{ id: string }> }).tool_calls?.map(call => call.id) ?? []));
  for (const message of messages) {
    if (message.role === "tool") assert.ok(calls.has(message.tool_call_id!), `orphan tool result ${message.tool_call_id}`);
  }
});

test("rehydrateRecentToolMessages only restores the last N digests", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-cache-"));
  try {
    const project = WriterProject.init(root, "缓存");
    const store = new WriterStore(project);
    const sessionId = store.createSession("s");
    const full = JSON.stringify({ path: "chapters/a.md", content: "完整正文内容".repeat(20) });
    const art = store.saveContextArtifact(sessionId, {
      cacheKey: "k", kind: "read_document", path: "chapters/a.md",
      sourceHash: "h", content: full, digest: "digest",
    });
    const digest = JSON.stringify({
      status: "artifact_compacted",
      artifactId: art,
      path: "chapters/a.md",
      digest: "摘要",
      message: "compressed",
    });
    const messages: Msg[] = [
      { role: "tool", content: digest, tool_call_id: "a" },
      { role: "tool", content: digest, tool_call_id: "b" },
      { role: "tool", content: digest, tool_call_id: "c" },
    ];
    rehydrateRecentToolMessages(messages as never, store, sessionId, 1);
    assert.ok(messages[0].content?.includes("artifact_compacted"), "older stays digest");
    assert.ok(messages[1].content?.includes("artifact_compacted"), "older stays digest");
    assert.ok(messages[2].content?.includes("完整正文内容"), "latest rehydrated");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stripStaleReasoningContent keeps only the latest reasoning block", () => {
  const messages: Msg[] = [
    { role: "assistant", content: "a", reasoning_content: "think1" },
    { role: "tool", content: "{}", tool_call_id: "t" },
    { role: "assistant", content: "b", reasoning_content: "think2" },
  ];
  stripStaleReasoningContent(messages as never);
  assert.equal(messages[0].reasoning_content, undefined);
  assert.equal(messages[2].reasoning_content, "think2");
});

test("compactCompletedToolCalls keeps only the latest write_file payload", () => {
  const messages: Msg[] = [
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "1", type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "旧正文很长".repeat(20) }) },
      }],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "2", type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: "a.md", content: "新正文" }) },
      }],
    },
  ];
  compactCompletedToolCalls(messages as never);
  const first = JSON.parse(messages[0].tool_calls![0].function.arguments) as { content: string };
  const second = JSON.parse(messages[1].tool_calls![0].function.arguments) as { content: string };
  assert.match(messageContentText(first.content), /已压缩/);
  assert.equal(second.content, "新正文");
});

test("turn one keeps today's 9-slot shape; later turns fold into a single user block", () => {
  const turnParts = {
    taskContext: "当前任务：改稿",
    dynamicStyleContext: "声线",
    bootstrapContext: "线索",
    reservedSlot: "（保留槽位）",
    artifactContext: "记忆",
    selectedContext: "选区",
    prompt: "把这段改短",
  };
  const stable = [1, 2, 3, 4, 5, 6].map(index => ({ role: "system" as const, content: `稳定 ${index}` }));

  // Turn 1: no replay, so the 8 system slots are still legal (nothing precedes them).
  const first = [...stable, ...buildDynamicTurnMessages({ historyText: "历史", archiveContext: "归档", ...turnParts })];
  assert.equal(first.length, 15);
  assert.equal(first.filter(message => message.role === "system").length, 14);

  // Turn 2: the same bodies, one user message, appended after the frozen transcript.
  const frozen = freezeTurnBlock([...first, { role: "assistant", content: "已改" }], stable.length);
  const second = [...stable, ...frozen, mergedTurnContext(turnParts)];
  assert.equal(second.at(-1)?.role, "user");
  for (const body of ["当前任务：改稿", "声线", "线索", "（保留槽位）", "记忆", "选区", "把这段改短"]) {
    assert.match(messageContentText(second.at(-1)?.content), new RegExp(body));
  }
});

test("no system message ever follows an assistant or tool turn across three turns", () => {
  const stable = [1, 2, 3, 4, 5, 6].map(index => ({ role: "system" as const, content: `稳定 ${index}` }));
  const parts = (turn: number) => ({ taskContext: `任务 ${turn}`, prompt: `请求 ${turn}` });

  let chain: AgentTurnMessage[] = [];
  let request: AgentTurnMessage[] = [];
  for (const turn of [1, 2, 3]) {
    request = [
      ...stable,
      ...chain,
      ...(chain.length
        ? [mergedTurnContext(parts(turn))]
        : buildDynamicTurnMessages({ historyText: "历史", archiveContext: "归档", ...parts(turn) })),
    ];
    const live = [
      ...request,
      { role: "assistant" as const, content: "读", tool_calls: [{ id: `t${turn}`, type: "function" as const, function: { name: "read_document", arguments: "{}" } }] },
      { role: "tool" as const, content: "{}", tool_call_id: `t${turn}` },
      { role: "assistant" as const, content: `完成 ${turn}` },
    ];
    chain = freezeTurnBlock(live, stable.length);
  }

  // DeepSeek re-renders the whole request under a different template when a system
  // message trails assistant/tool history — measured twice (contract §4).
  let transcriptStarted = false;
  request.forEach((message, index) => {
    if (message.role === "assistant" || message.role === "tool") transcriptStarted = true;
    assert.ok(!(transcriptStarted && message.role === "system"), `system message at index ${index} follows the transcript`);
  });
  // Replay must be a real prefix of what was sent, not a rebuilt approximation.
  assert.deepEqual(request.slice(0, 6), stable);
  assert.equal(request.at(-1)?.role, "user");
  assert.match(messageContentText(request.at(-1)?.content), /任务 3/);
});

test("cache waterfall reports replayed turns separately from the live dynamic tail", () => {
  const tools = agentToolsForTask("general", "ask");
  const components = buildRequestComponentUsage([
    { role: "system", content: "稳定" },
    { role: "user", content: "上一轮请求" },
    { role: "assistant", content: "上一轮回答" },
    { role: "user", content: "本轮请求" },
  ], tools, 1, 4, 3);
  assert.equal(components.filter(item => item.kind === "replayed_turn").length, 2);
  assert.equal(components.filter(item => item.kind === "user").length, 1);
  assert.equal(components.find(item => item.kind === "user")?.label, "当前用户请求");
  assert.equal(components.find(item => item.kind === "dynamic_system"), undefined);
});

test("session artifact repository keeps a pre-proposal revision independent of delivery state", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-session-artifacts-"));
  const project = WriterProject.init(root, "session-artifacts");
  let store = new WriterStore(project);
  try {
    const sessionId = store.createSession("session-artifacts");
    const path = "chapters/draft.md";
    const packContent = JSON.stringify({ sceneGoal: "抵达城门", knownFacts: ["城门关闭"] });
    const packHash = project.hash(packContent);
    const pack = store.saveSessionArtifact(sessionId, {
      artifactKey: `write_pack:${path}:${packHash}`,
      kind: "write_pack",
      path,
      sourceHash: packHash,
      content: packContent,
      digest: "城门场景写作包",
    });
    const body = "# 第一章\n\n她抵达关闭的城门。";
    const bodyHash = project.hash(body);
    const draft = store.saveSessionArtifact(sessionId, {
      artifactKey: `draft:${bodyHash}`,
      kind: "proposal_revision_draft",
      path,
      sourceHash: bodyHash,
      content: body,
      digest: "门禁前草稿",
    });
    const retryState = createProposalRetryState({ runId: "run-pre-proposal", path });
    const revision = saveProposalRevisionCase(
      { artifactId: draft.id, path, sourceHash: bodyHash },
      "style",
      { ...retryState, gateAttempts: { ...retryState.gateAttempts, style: 1 }, absoluteSubmissions: 1 },
      1,
      [],
      undefined,
      captureProposalRevisionDocumentBase(project, path),
      store,
      sessionId,
      undefined,
      {
        writePackArtifactId: pack.id,
        repairPacket: {
          path,
          sourceHash: bodyHash,
          issueCount: 1,
          issues: [{ id: "style:1", kind: "style", oldText: "她抵达关闭的城门。", action: "按人物感受改写" }],
        },
      },
    );
    assert.equal(revision.revisionCase.deliverableId, undefined);
    assert.equal(revision.revisionCase.writePackArtifactId, pack.id);
    assert.deepEqual(
      new Set(store.sessionArtifactRelations(sessionId, revision.revisionCase.reviewArtifactId)
        .filter(item => item.direction === "outgoing")
        .map(item => item.relation)),
      new Set(["repairs", "supported_by"]),
    );
    assert.equal(store.findSessionArtifacts(sessionId, {
      kinds: ["proposal_revision_case"], statuses: ["blocked"], path,
    }).length, 1);

    const proposal = store.createProposal(sessionId, path, body, "提交待审正文");
    const proposalArtifact = store.sessionArtifact(sessionId, `proposal:${proposal.id}`);
    assert.equal(proposal.status, "pending");
    assert.equal(proposalArtifact?.status, "submitted", "proposal mode must not become applied evidence");

    store.close();
    store = new WriterStore(project);
    const restored = store.findSessionArtifacts(sessionId, {
      kinds: ["proposal_revision_case"], statuses: ["blocked"], path,
    });
    assert.equal(restored.length, 1);
    const restoredCase = JSON.parse(restored[0]!.content) as ProposalRevisionCase;
    assert.equal(restoredCase.draftSourceHash, bodyHash);
    assert.equal(restoredCase.writePackArtifactId, pack.id);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
