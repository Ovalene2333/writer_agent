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
  compactCompletedToolCalls,
  compactRuntimeMessages,
  isSimpleCharacterCardRequest,
  rehydrateRecentToolMessages,
  stripStaleReasoningContent,
} from "./agent.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";

test("agent tool schema has stable order and unique names", () => {
  const names = agentToolNames();
  assert.equal(new Set(names).size, names.length);
  assert.equal(agentToolSchemaHash(), "78cf26987dc78a3e");
});

test("simple character card requests use the dedicated route", () => {
  assert.equal(isSimpleCharacterCardRequest("创建一个简易角色：负责检查和调节展开后武装的李技术员"), true);
  assert.equal(isSimpleCharacterCardRequest("把简略人物卡更新一下"), true);
  assert.equal(isSimpleCharacterCardRequest("解释什么是简易角色卡"), false);
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
    assert.match(a[0].content ?? "", /competencies\[\]\.unlocked 表示随剧情推进变化的当前解锁状态/);
    const audit = buildStableSystemPrefix(project, store, "ask", { intensive: false }, "audit");
    assert.equal(audit.length, 6);
    assert.notEqual(audit[5].content, a[5].content);
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
