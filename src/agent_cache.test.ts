import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  boundToolResultForModel,
  buildRequestComponentUsage,
  buildDynamicTurnMessages,
  buildStableSystemPrefix,
  buildToolArgumentRepairMessages,
  characterMutationCompletesTask,
  chapterContinuationPrompt,
  compactCompletedToolCalls,
  compactRuntimeMessages,
  executionModelForTask,
  executionModelForStep,
  initialTodos,
  normalizeCharacterTaskMode,
  normalizeDocumentProposalRequired,
  parsePlannerJson,
  parseToolArgumentRepair,
  plannerCompletionOptions,
  rehydrateRecentToolMessages,
  requestNeedsProjectFactSearch,
  repairTruncatedToolArguments,
  resolveRecentCharacterIds,
  restoreChapterDraftCheckpoint,
  sceneContinuationPrompt,
  stripStaleReasoningContent,
  taskInstructions,
} from "./agent.js";
import { beginChapterSceneDraft, writeChapterScene } from "./scene_pipeline.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { parseModelTokenUsage } from "./model_usage.js";
import { buildChapterReviewMessages, parseChapterReview } from "./chapter_review.js";
import { buildChapterStyleRepairMessages, CHAPTER_STYLE_REPAIR_BATCH_SIZE, parseChapterStyleRepair } from "./chapter_style_repair.js";
import { documentSpans } from "./document_spans.js";
import { parseDocumentLocatorResult } from "./document_locator.js";
import { parseDocumentRevision } from "./document_revision.js";

test("agent tool schema has stable order and unique names", () => {
  const names = agentToolNames();
  assert.equal(new Set(names).size, names.length);
  // Update when TOOLS descriptions/schemas change intentionally (cache-critical).
  assert.equal(agentToolSchemaHash(), "eb1981f0bfecf5b3");
});

test("isolated chapter review carries the full draft once and returns bounded structured evidence", () => {
  const content = "# 第一章\n\n## 进入\n\n门禁灯由绿变红。\n\n## 结果\n\n她越过了门。";
  const scenes = [{
    sceneId: "arrival", title: "进入", plannedTurn: "门禁变红", plannedOutcome: "主角违规进入",
    actualState: { situation: ["主角违规进入"] },
  }];
  const proseSignals = { stats: { numericTokenDensityPer10k: 112 }, warnings: [] };
  const messages = buildChapterReviewMessages({
    chapterGoal: "关系改变", content, scenes, context: "稳定项目约束", proseSignals,
  });
  assert.deepEqual(messages.map(message => message.role), ["system", "system", "user"]);
  assert.equal(messages[1].content, "稳定项目约束");
  assert.match(messages[2].content, /门禁灯由绿变红/u);
  assert.deepEqual(JSON.parse(messages[2].content).proseSignals, proseSignals);

  const review = parseChapterReview(JSON.stringify({
    verdict: "revise",
    chapterChange: "主角从服从转为违规",
    reviewNotes: "结果与计划一致，但接缝需要补强。",
    issues: [{
      severity: "blocker", kind: "telemetry_pileup", sceneId: "arrival",
      evidence: ["门禁灯由绿变红。"], problem: "读数堆砌遮蔽人物选择", action: "只保留改变行动的读数",
    }],
  }), new Set(["arrival"]), content);
  assert.equal(review.verdict, "revise");
  assert.equal(review.issues[0].kind, "telemetry_pileup");
  assert.deepEqual(review.issues[0].evidence, ["门禁灯由绿变红。"]);
  assert.throws(() => parseChapterReview(JSON.stringify({
    verdict: "revise",
    chapterChange: "主角改变",
    reviewNotes: "存在问题",
    issues: [{
      severity: "blocker", kind: "seam", sceneId: "arrival",
      evidence: ["正文中不存在的句子。"], problem: "问题", action: "修复",
    }],
  }), new Set(["arrival"]), content), /可定位的 blocker/u);
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
      scenes: [{ id: "s1", title: "门禁", goal: "进入", obstacle: "锁门", turn: "警报", outcome: "越界", handoff: "" }],
    });
    store.saveAgentCheckpoint(sessionId, {
      version: 1, stage: "draft_started", path: draft.path, sourceHash: draft.baseHash,
      draftVersion: 0, completedScenes: 0, totalScenes: 1, draft, updatedAt: new Date().toISOString(),
    });
    assert.equal(restoreChapterDraftCheckpoint(store, sessionId, project, draft.path)?.path, draft.path);
    store.saveSessionTodos(sessionId, [{ id: "t1", content: "完成章节", status: "in_progress" }]);
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
  for (const required of ["read_document", "begin_chapter_draft", "write_chapter_scene", "revise_chapter_scene_guide", "inspect_chapter_draft", "propose_chapter_draft"]) {
    assert.ok(writeNames.includes(required), `write profile missing ${required}`);
  }
  assert.equal(writeNames.includes("save_character"), true);
  assert.deepEqual(agentToolsForTask("brainstorm", "ask").map(tool => tool.function.name), writeNames);
  assert.deepEqual(agentToolsForTask("audit", "ask").map(tool => tool.function.name), writeNames);

  const planNames = agentToolsForTask("write_scene", "plan").map(tool => tool.function.name);
  assert.equal(planNames.includes("write_chapter_scene"), false);
  assert.equal(planNames.includes("propose_chapter_draft"), false);
  assert.ok(planNames.includes("read_document"));
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
  assert.match(normal, /禁止再提交文档提案或 change set/);
  assert.match(normal, /必须 get_character/);
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
  const payload = JSON.parse(messages[1].content ?? "{}") as Record<string, unknown>;
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
  });
});

test("scene orchestration always stays on Agent regardless of Writer isolation", () => {
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
  assert.equal(executionModelForTask({ mode: "rewrite", documentProposalRequired: true }, models, agent), inline);
  assert.equal(executionModelForTask({ mode: "audit", documentProposalRequired: false }, models, agent), reviewer);
});

test("standard scene steps use Writer only while prose scenes remain pending", () => {
  const model = (name: string) => ({ baseUrl: "https://api.example.com/v1", apiKey: "test", model: name });
  const agent = model("agent");
  const writer = model("writer");
  const pending = { scenes: [{ id: "one" }], completed: [] } as unknown as Pick<import("./scene_pipeline.js").ChapterSceneDraft, "scenes" | "completed">;
  const complete = { scenes: [{ id: "one" }], completed: [{ sceneId: "one" }] } as unknown as Pick<import("./scene_pipeline.js").ChapterSceneDraft, "scenes" | "completed">;

  assert.equal(executionModelForStep("write_scene", agent, writer, false), agent);
  assert.equal(executionModelForStep("write_scene", agent, writer, false, pending), writer);
  assert.equal(executionModelForStep("write_scene", agent, writer, false, complete), agent);
  assert.equal(executionModelForStep("write_scene", agent, writer, true, pending), agent);
  assert.equal(executionModelForStep("outline", agent, writer, false, pending), agent);
});

test("provider usage parsing and tagged persistence include hidden model calls", () => {
  assert.deepEqual(parseModelTokenUsage({
    prompt_tokens: 120,
    completion_tokens: 30,
    prompt_tokens_details: { cached_tokens: 80 },
  }), {
    promptTokens: 120,
    completionTokens: 30,
    cacheHitTokens: 80,
    cacheMissTokens: 40,
  });

  const root = mkdtempSync(join(tmpdir(), "writer-usage-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "用量");
    store = new WriterStore(project);
    const sessionId = store.createSession("用量");
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
    assert.equal(store.usage(sessionId).lastPromptTokens, 500);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit workflow separates review-only from repair", () => {
  assert.match(taskInstructions("audit", "shape", "ask", false), /不提案/);
  assert.match(taskInstructions("audit", "shape", "ask", true), /最小提案/);
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

test("prebuilt todo plans start with one active step", () => {
  assert.deepEqual(initialTodos(["核对资料", "完成写作", "提交提案"]), [
    { id: "t1", content: "核对资料", status: "in_progress" },
    { id: "t2", content: "完成写作", status: "pending" },
    { id: "t3", content: "提交提案", status: "pending" },
  ]);
});

test("chapter workflow uses the model-driven scene tool chain", () => {
  const instructions = taskInstructions("write_scene", "deliver", "ask", true);
  assert.match(instructions, /begin_chapter_draft/);
  assert.match(instructions, /write_chapter_scene/);
  assert.match(instructions, /revise_chapter_scene_guide/);
  assert.match(instructions, /revise_chapter_draft_style/);
  assert.match(instructions, /每次 write_chapter_scene 只处理当前一场/);
  assert.match(instructions, /styleDeferred/);
  assert.match(instructions, /禁止为句式问题重写整场/);
  assert.match(instructions, /禁止通读上一章全文/);
  const isolated = taskInstructions("write_scene", "deliver", "ask", true, true);
  assert.match(isolated, /每次 write_chapter_scene 只处理当前一场/);
  assert.match(isolated, /不要生成 content 或 actualState/);
  assert.match(isolated, /隔离模式不把风格统计写进下一场 notes/);
  assert.match(taskInstructions("write_scene", "deliver", "ask", true, true, 4_200), /4200 字/);
  assert.match(instructions, /inspect_chapter_draft/);
  assert.match(instructions, /propose_chapter_draft/);
  assert.match(instructions, /直接创建提案/);
  assert.match(instructions, /actualState/);
  assert.match(instructions, /禁止 propose_document\/patch/);
  assert.match(instructions, /大纲不是章节写作的前置条件/);
  assert.match(instructions, /禁止 design_creative_outline/);
  assert.match(instructions, /guide 只提供下一步方向/);
  assert.match(instructions, /side\/ 的支线片段/u);
});

test("chapter continuation handoff carries delivery, tail, and final scene state", () => {
  const tail = "走廊尽头的灯灭了。".repeat(200);
  const prompt = chapterContinuationPrompt({
    todosText: "- [x] t1: 撰写第1章 (completed)\n- [>] t2: 撰写第2章 (in_progress)",
    proposal: { path: "chapters/第1章.md", summary: "主角违规进入训练区", afterContent: tail },
    handoff: {
      path: "chapters/第1章.md",
      sceneCount: 3,
      finalActualState: {
        situation: ["警报已触发"], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
      },
    },
  });
  assert.match(prompt, /禁止重复提交同一章/);
  assert.match(prompt, /chapters\/第1章\.md/);
  assert.match(prompt, /警报已触发/);
  assert.match(prompt, /begin_chapter_draft/);
  assert.match(prompt, /撰写第2章/);
  // Tail excerpt is bounded so the handoff stays cheap on every remaining step.
  const tailBlock = prompt.split("上一章结尾")[1] ?? "";
  assert.ok(tailBlock.length < 1_200, `tail block too long: ${tailBlock.length}`);

  const minimal = chapterContinuationPrompt({ todosText: "（空）" });
  assert.match(minimal, /任务清单仍有未完成的写作步骤/);
  assert.doesNotMatch(minimal, /已交付：/);
});

test("scene continuation handoff carries seam tail, states and next card without full prose", () => {
  let draft = beginChapterSceneDraft({
    path: "chapters/第1章.md", mode: "create", heading: "第1章", chapterGoal: "关系反转",
    baseContent: "", baseHash: "empty",
    scenes: [
      { id: "s1", title: "抵达", goal: "进入基地", obstacle: "门禁", turn: "冻结令", outcome: "违规进入", handoff: "触发警报" },
      { id: "s2", title: "警报", goal: "处置违规", obstacle: "实弹防卫", turn: "教官担责", outcome: "秘密共担", handoff: "" },
    ],
  });
  const sceneBody = `独属于开场的第一句钥匙句。${"她沿着通道往里走，门禁灯逐个变红。".repeat(80)}警报在头顶炸开。`;
  draft = writeChapterScene(draft, "s1", sceneBody, {
    situation: ["警报已触发"], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
  }).draft;
  const prompt = sceneContinuationPrompt(draft, {
    styleFeedback: ["下一场禁用段首起笔：「她沿」×30"],
    stylePriorNotes: ["上一章高频微动作词：目光×8"],
  });
  assert.match(prompt, /已完成 1\/2 场/);
  assert.match(prompt, /警报在头顶炸开/);
  assert.match(prompt, /警报已触发/);
  assert.match(prompt, /"id":"s2"/);
  assert.match(prompt, /sceneId=s2/);
  assert.match(prompt, /revise_chapter_scene_guide/);
  assert.match(prompt, /禁用段首起笔/);
  assert.match(prompt, /目光×8/);
  assert.match(prompt, /不要输出计划说明/);
  // Only the bounded tail of the finished scene survives — never its full prose.
  assert.doesNotMatch(prompt, /钥匙句/);
  const tailBlock = (prompt.split("上一场结尾")[1] ?? "").split("各场实际离场状态")[0];
  assert.ok(tailBlock.length > 0 && tailBlock.length < 1_000, `tail block out of bounds: ${tailBlock.length}`);
  const isolatedPrompt = sceneContinuationPrompt(draft, { isolatedWriter: true });
  assert.match(isolatedPrompt, /调用 write_chapter_scene/);
  assert.match(isolatedPrompt, /只提交要点式 notes/);
  assert.doesNotMatch(isolatedPrompt, /提交要点式 notes、正文与 actualState/);

  draft = writeChapterScene(draft, "s2", "教官在警报声里签下自己的名字。".repeat(10), {
    situation: ["违规被共同隐瞒"], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
  }).draft;
  const complete = sceneContinuationPrompt(draft, {});
  assert.match(complete, /当前没有未写 scene guide/);
  assert.match(complete, /inspect_chapter_draft/);
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
    // Placeholders keep slot count when project has no instructions/skills.
    assert.match(a[2].content ?? "", /项目指令/);
    assert.match(a[3].content ?? "", /项目技能/);
    assert.match(a[0].content ?? "", /characterChanges/);
    // Slot 4/5 must not flip with intensive or audit — those go in the dynamic tail.
    const intensive = buildStableSystemPrefix(project, store, "ask", { intensive: true }, "write_scene");
    const audit = buildStableSystemPrefix(project, store, "ask", { intensive: false }, "audit");
    assert.equal(audit.length, 6);
    assert.equal(a[4].content, intensive[4].content);
    assert.equal(a[5].content, audit[5].content);
    assert.equal(a[5].content, intensive[5].content);
    assert.match(a[4].content ?? "", /风格锚定/);
    assert.match(a[5].content ?? "", /当前任务/);
    assert.doesNotMatch(a[5].content ?? "", /终审专则/);
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
    todosPrompt: "清单",
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
  assert.equal(empty.at(-1)?.content, "闲聊");
  assert.match(empty[3].content ?? "", /动态声线/);
  assert.match(empty[6].content ?? "", /工作记忆/);
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

test("compactCompletedToolCalls keeps only the latest propose payload", () => {
  const messages: Msg[] = [
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "1", type: "function",
        function: { name: "propose_document", arguments: JSON.stringify({ path: "a.md", summary: "old", content: "旧正文很长".repeat(20) }) },
      }],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "2", type: "function",
        function: { name: "propose_document", arguments: JSON.stringify({ path: "a.md", summary: "new", content: "新正文" }) },
      }],
    },
  ];
  compactCompletedToolCalls(messages as never);
  const first = JSON.parse(messages[0].tool_calls![0].function.arguments) as { content: string };
  const second = JSON.parse(messages[1].tool_calls![0].function.arguments) as { content: string };
  assert.match(first.content, /已压缩/);
  assert.equal(second.content, "新正文");
});
