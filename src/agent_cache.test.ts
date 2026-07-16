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
  buildDynamicTurnMessages,
  buildStableSystemPrefix,
  chapterContinuationPrompt,
  compactCompletedToolCalls,
  compactRuntimeMessages,
  initialTodos,
  rehydrateRecentToolMessages,
  requestNeedsProjectFactSearch,
  stripStaleReasoningContent,
  taskInstructions,
} from "./agent.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";

test("agent tool schema has stable order and unique names", () => {
  const names = agentToolNames();
  assert.equal(new Set(names).size, names.length);
  // Update when TOOLS descriptions/schemas change intentionally (cache-critical).
  assert.equal(agentToolSchemaHash(), "3fa5b56cd20705c2");
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
  assert.match(instructions, /revise_chapter_draft_style/);
  assert.match(instructions, /每场只调用一次 write_chapter_scene/);
  assert.match(instructions, /工具内部完成 notes 编译/);
  assert.match(instructions, /inspect_chapter_draft/);
  assert.match(instructions, /propose_chapter_draft/);
  assert.match(instructions, /actualState/);
  assert.match(instructions, /禁止直接 propose_document/);
  assert.match(instructions, /大纲不是章节写作的前置条件/);
  assert.match(instructions, /禁止 design_creative_outline/);
  assert.match(instructions, /重心放在因果场景链/);
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
