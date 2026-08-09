import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
/**
 * Cross-turn replay guards. The whole mechanism rests on two properties:
 * replayed bytes equal sent bytes, and no `system` message ever follows an
 * assistant/tool turn. Both are asserted here and in agent_cache.test.ts.
 */
import { approximateMessageTokens, freezeTurnBlock, loadReplayMessages, mergedTurnContext } from "./turn_replay.js";
import { compactRuntimeMessages } from "./agent.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import type { AgentTurnMessage } from "./types.js";
import { messageContentText } from "./model_compat.js";

function withStore(name: string, body: (store: WriterStore, sessionId: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), `writer-${name}-`));
  try {
    const project = WriterProject.init(root, "复放");
    const store = new WriterStore(project);
    const sessionId = store.createSession("复放会话");
    try { body(store, sessionId); } finally { store.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("freezing a healthy turn is byte-identical to what was sent", () => {
  const messages: AgentTurnMessage[] = [
    { role: "system", content: "稳定前缀" },
    { role: "system", content: "动态 0" },
    { role: "user", content: "写第一章" },
    { role: "assistant", content: "读一下大纲", reasoning_content: "先看结构", tool_calls: [{ id: "c1", type: "function", function: { name: "read_document", arguments: "{}" } }] },
    { role: "tool", content: "{\"content\":\"大纲\"}", tool_call_id: "c1" },
    { role: "assistant", content: "已写完" },
  ];
  const frozen = freezeTurnBlock(messages, 1);
  // Verbatim: a rewritten body would move the divergence point to this very message.
  assert.deepEqual(frozen, messages.slice(1));
  // reasoning_content survives — the live loop already replays it between steps.
  assert.equal(frozen[2].reasoning_content, "先看结构");
});

test("freezing keeps leading system slots but drops any after the transcript starts", () => {
  const frozen = freezeTurnBlock([
    { role: "system", content: "动态 0" },
    { role: "system", content: "动态 1" },
    { role: "user", content: "请求" },
    { role: "assistant", content: "答" },
    { role: "system", content: "越界的 system" },
    { role: "user", content: "阶段交接" },
  ], 0);
  assert.deepEqual(frozen.map(message => message.role), ["system", "system", "user", "assistant", "user"]);
  assert.ok(!frozen.some(message => message.content === "越界的 system"));
});

test("aborted turns lose dangling tool calls and orphan results", () => {
  const frozen = freezeTurnBlock([
    { role: "user", content: "请求" },
    { role: "assistant", content: "并行读两个", tool_calls: [
      { id: "c1", type: "function", function: { name: "read_document", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "search_documents", arguments: "{}" } },
    ] },
    { role: "tool", content: "{\"content\":\"一\"}", tool_call_id: "c1" },
    // c2 never returned — the abort cut here.
    { role: "assistant", content: "", tool_calls: [{ id: "c3", type: "function", function: { name: "read_document", arguments: "{}" } }] },
    { role: "tool", content: "孤儿结果", tool_call_id: "c9" },
  ], 0);
  const calls = frozen.flatMap(message => message.tool_calls?.map(call => call.id) ?? []);
  assert.deepEqual(calls, ["c1"]);
  const results = frozen.filter(message => message.role === "tool").map(message => message.tool_call_id);
  assert.deepEqual(results, ["c1"]);
  // The empty tool-call-only assistant turn carries nothing usable.
  assert.equal(frozen.filter(message => message.role === "assistant").length, 1);
});

test("merged turn context is one user message without per-turn counters", () => {
  const merged = mergedTurnContext({
    taskContext: "当前任务：改稿",
    dynamicStyleContext: "声线证据",
    prompt: "把这段改短",
  });
  // Role is load-bearing: a system message here forfeits the whole cached prefix.
  assert.equal(merged.role, "user");
  assert.match(messageContentText(merged.content), /当前任务：改稿/);
  assert.match(messageContentText(merged.content), /声线证据/);
  assert.match(messageContentText(merged.content), /把这段改短/);
  assert.match(messageContentText(merged.content), /本轮任务工作记忆：无。/);
  // conversationStats / history preview are gone — they changed every turn and
  // pinned the divergence point at the very front of the tail.
  assert.doesNotMatch(messageContentText(merged.content), /历史对话/);
  assert.doesNotMatch(messageContentText(merged.content), /归档/);
});

test("replay returns frozen turns in order and stays empty for a fresh session", () => {
  withStore("replay-order", (store, sessionId) => {
    const load = () => loadReplayMessages({ store, sessionId, budgetTokens: 100_000, compact: compactRuntimeMessages });
    assert.deepEqual(load().messages, []);

    const first: AgentTurnMessage[] = [{ role: "user", content: "第一轮" }, { role: "assistant", content: "好" }];
    const second: AgentTurnMessage[] = [{ role: "user", content: "第二轮" }, { role: "assistant", content: "行" }];
    store.appendAgentTurnBlock(sessionId, { turnIndex: 0, messages: first, estimatedTokens: approximateMessageTokens(first) });
    store.appendAgentTurnBlock(sessionId, { turnIndex: 1, messages: second, estimatedTokens: approximateMessageTokens(second) });

    const replay = load();
    assert.deepEqual(replay.messages, [...first, ...second]);
    assert.equal(replay.compacted, false);
    assert.equal(replay.droppedTurns, 0);
  });
});

test("over-budget replay compacts the oldest turn and writes the shrunk form back", () => {
  withStore("replay-budget", (store, sessionId) => {
    const heavy = (marker: string): AgentTurnMessage[] => [
      { role: "user", content: `请求 ${marker}` },
      { role: "assistant", content: "读", tool_calls: [{ id: `${marker}1`, type: "function", function: { name: "read_document", arguments: "{}" } }] },
      { role: "tool", content: JSON.stringify({ path: `ch/${marker}.md`, content: "正文".repeat(6_000) }), tool_call_id: `${marker}1` },
      { role: "assistant", content: "读", tool_calls: [{ id: `${marker}2`, type: "function", function: { name: "read_document", arguments: "{}" } }] },
      { role: "tool", content: JSON.stringify({ path: `ch/${marker}b.md`, content: "正文".repeat(6_000) }), tool_call_id: `${marker}2` },
      { role: "assistant", content: `完成 ${marker}` },
    ];
    for (const [index, marker] of ["a", "b"].entries()) {
      const messages = heavy(marker);
      store.appendAgentTurnBlock(sessionId, { turnIndex: index, messages, estimatedTokens: approximateMessageTokens(messages) });
    }
    const before = store.agentTurnBlocks(sessionId);
    const budget = Math.floor(before.reduce((sum, block) => sum + block.estimatedTokens, 0) * 0.75);

    const replay = loadReplayMessages({ store, sessionId, budgetTokens: budget, compact: compactRuntimeMessages });
    assert.equal(replay.compacted, true);
    assert.ok(replay.estimatedTokens < before[0].estimatedTokens + before[1].estimatedTokens);

    // Written back, so the shrink is paid for once and becomes the new stable prefix.
    const after = store.agentTurnBlocks(sessionId);
    assert.equal(after.length, 2);
    assert.ok(after[0].estimatedTokens < before[0].estimatedTokens, "oldest turn must have shrunk on disk");
    assert.equal(after[1].estimatedTokens, before[1].estimatedTokens, "newest turn stays verbatim");
    assert.match(messageContentText(after[0].messages[2].content), /artifact_compacted/);

    // Compaction must not break tool_call/tool_result pairing.
    const calls = new Set(after.flatMap(block => block.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? [])));
    for (const block of after) {
      for (const message of block.messages) {
        if (message.role === "tool") assert.ok(calls.has(message.tool_call_id!), `orphan tool result ${message.tool_call_id}`);
      }
    }
  });
});

/** Two heavy tool bodies per turn — enough that compaction visibly shrinks the block. */
function heavyTurn(marker: string): AgentTurnMessage[] {
  return [
    { role: "user", content: `请求 ${marker}` },
    { role: "assistant", content: "读", tool_calls: [{ id: `${marker}1`, type: "function", function: { name: "read_document", arguments: "{}" } }] },
    { role: "tool", content: JSON.stringify({ path: `ch/${marker}.md`, content: "正文".repeat(6_000) }), tool_call_id: `${marker}1` },
    { role: "assistant", content: "读", tool_calls: [{ id: `${marker}2`, type: "function", function: { name: "read_document", arguments: "{}" } }] },
    { role: "tool", content: JSON.stringify({ path: `ch/${marker}b.md`, content: "正文".repeat(6_000) }), tool_call_id: `${marker}2` },
    { role: "assistant", content: `完成 ${marker}` },
  ];
}

function appendTurn(store: WriterStore, sessionId: string, index: number, messages: AgentTurnMessage[]): void {
  store.appendAgentTurnBlock(sessionId, { turnIndex: index, messages, estimatedTokens: approximateMessageTokens(messages) });
}

test("compacting a cold block is idempotent — a second pass produces the same bytes", () => {
  withStore("replay-idempotent", (store, sessionId) => {
    appendTurn(store, sessionId, 0, heavyTurn("a"));
    appendTurn(store, sessionId, 1, heavyTurn("b"));
    const budget = Math.floor(store.agentTurnBlocks(sessionId).reduce((sum, block) => sum + block.estimatedTokens, 0) * 0.75);

    loadReplayMessages({ store, sessionId, budgetTokens: budget, compact: compactRuntimeMessages });
    const first = JSON.stringify(store.agentTurnBlocks(sessionId).map(block => block.messages));

    // Same budget, same chain: the load must be a no-op, not another rewrite.
    const second = loadReplayMessages({ store, sessionId, budgetTokens: budget, compact: compactRuntimeMessages });
    assert.equal(second.compacted, false, "an already-compacted chain must not be rewritten");
    assert.equal(JSON.stringify(store.agentTurnBlocks(sessionId).map(block => block.messages)), first);
  });
});

test("appending a turn does not rewrite blocks that were already compacted", () => {
  withStore("replay-stable-prefix", (store, sessionId) => {
    appendTurn(store, sessionId, 0, heavyTurn("a"));
    appendTurn(store, sessionId, 1, heavyTurn("b"));
    const perTurn = approximateMessageTokens(heavyTurn("a"));
    // Tight enough that every load is over budget and wants to shrink something.
    const budget = Math.floor(perTurn * 1.5);

    loadReplayMessages({ store, sessionId, budgetTokens: budget, compact: compactRuntimeMessages });
    const afterTwo = store.agentTurnBlocks(sessionId).map(block => JSON.stringify(block.messages));

    appendTurn(store, sessionId, store.nextAgentTurnIndex(sessionId), heavyTurn("c"));
    loadReplayMessages({ store, sessionId, budgetTokens: budget, compact: compactRuntimeMessages });
    const afterThree = store.agentTurnBlocks(sessionId).map(block => JSON.stringify(block.messages));

    // This is the regression lock for the sliding-window bug: turn a's bytes are
    // already in the provider's cache, so re-digesting them here would move the
    // divergence point back to the head of the chain on every single turn.
    assert.equal(afterThree[0], afterTwo[0], "an already-compacted block must stay byte-identical");
  });
});

test("compaction overshoots to the low-water mark so later turns fit untouched", () => {
  withStore("replay-hysteresis", (store, sessionId) => {
    for (const [index, marker] of ["a", "b", "c"].entries()) appendTurn(store, sessionId, index, heavyTurn(marker));
    const total = store.agentTurnBlocks(sessionId).reduce((sum, block) => sum + block.estimatedTokens, 0);
    const budget = Math.floor(total * 0.9);

    const replay = loadReplayMessages({ store, sessionId, budgetTokens: budget, compact: compactRuntimeMessages });
    assert.equal(replay.compacted, true);
    assert.equal(replay.droppedTurns, 0, "compaction alone should have been enough");
    assert.ok(
      replay.estimatedTokens <= budget * 0.6,
      `expected shrink past the low-water mark, got ${replay.estimatedTokens} vs ${budget * 0.6}`,
    );
    // The newest turn's tool bodies are still the live context — never digested.
    const blocks = store.agentTurnBlocks(sessionId);
    assert.equal(blocks[2].estimatedTokens, approximateMessageTokens(heavyTurn("c")));
    assert.doesNotMatch(messageContentText(blocks[2].messages[2].content), /artifact_compacted/);
  });
});

test("a single turn larger than the whole budget is dropped rather than half-replayed", () => {
  withStore("replay-drop", (store, sessionId) => {
    const messages: AgentTurnMessage[] = [
      { role: "user", content: "巨大的一轮" },
      { role: "assistant", content: "回应".repeat(20_000) },
    ];
    store.appendAgentTurnBlock(sessionId, { turnIndex: 0, messages, estimatedTokens: approximateMessageTokens(messages) });
    const replay = loadReplayMessages({ store, sessionId, budgetTokens: 100, compact: compactRuntimeMessages });
    assert.deepEqual(replay.messages, []);
    assert.equal(replay.droppedTurns, 1);
    assert.deepEqual(store.agentTurnBlocks(sessionId), []);
  });
});

test("a corrupted block truncates the chain instead of throwing", () => {
  withStore("replay-corrupt", (store, sessionId) => {
    const good: AgentTurnMessage[] = [{ role: "user", content: "第一轮" }];
    store.appendAgentTurnBlock(sessionId, { turnIndex: 0, messages: good, estimatedTokens: 4 });
    store.appendAgentTurnBlock(sessionId, { turnIndex: 1, messages: [{ role: "user", content: "第二轮" }], estimatedTokens: 4 });
    // Simulate a truncated blob written by an older build.
    (store as unknown as { database: { prepare(sql: string): { run(...args: unknown[]): void } } })
      .database.prepare(`UPDATE agent_replay_commits SET messages_json='[{"role":'
        WHERE id=(SELECT head_commit_id FROM agent_replay_heads WHERE session_id=?)`)
      .run(sessionId);
    assert.deepEqual(store.agentTurnBlocks(sessionId).map(block => block.messages), [good]);
  });
});

test("rewind forks the replay ledger at the owning user message", () => {
  withStore("replay-fork", (store, sessionId) => {
    const firstMessageId = store.addMessage(sessionId, "user", "第一轮", "agent");
    appendTurn(store, sessionId, 0, [{ role: "user", content: "第一轮" }]);
    const secondMessageId = store.addMessage(sessionId, "user", "第二轮", "agent");
    store.appendAgentTurnBlock(sessionId, {
      turnIndex: 1,
      sourceMessageId: secondMessageId,
      messages: [{ role: "user", content: "第二轮" }],
      estimatedTokens: 4,
    });
    // Give the first legacy-shaped test block precise ownership before exercising the fork.
    const database = (store as unknown as { database: { prepare(sql: string): { run(...args: unknown[]): void } } }).database;
    database.prepare(`UPDATE agent_replay_commits SET source_message_id=?
      WHERE session_id=? AND parent_id IS NULL`).run(firstMessageId, sessionId);

    store.rewindFromMessage(sessionId, secondMessageId, { keepChanges: true });
    assert.deepEqual(store.agentTurnBlocks(sessionId).map(block => block.messages), [[{ role: "user", content: "第一轮" }]]);
  });
});

test("replaceAgentTurnBlocks renumbers the chain and nextAgentTurnIndex follows", () => {
  withStore("replay-replace", (store, sessionId) => {
    for (const index of [0, 1, 2]) {
      store.appendAgentTurnBlock(sessionId, { turnIndex: index, messages: [{ role: "user", content: `轮 ${index}` }], estimatedTokens: 4 });
    }
    assert.equal(store.nextAgentTurnIndex(sessionId), 3);
    store.replaceAgentTurnBlocks(sessionId, [{ messages: [{ role: "user", content: "轮 2" }], estimatedTokens: 4 }]);
    const blocks = store.agentTurnBlocks(sessionId);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].turnIndex, 0);
    assert.equal(store.nextAgentTurnIndex(sessionId), 1);
    store.clearAgentTurnBlocks(sessionId);
    assert.equal(store.nextAgentTurnIndex(sessionId), 0);
  });
});
