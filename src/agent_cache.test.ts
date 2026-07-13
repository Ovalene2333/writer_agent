import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentToolNames,
  agentToolSchemaHash,
  compactRuntimeMessages,
  rehydrateRecentToolMessages,
  stripStaleReasoningContent,
} from "./agent.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";

test("agent tool schema has stable order and unique names", () => {
  const names = agentToolNames();
  assert.equal(new Set(names).size, names.length);
  assert.equal(agentToolSchemaHash(), "52ba93c0d6ed2e67");
});

type Msg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  reasoning_content?: string;
};

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
