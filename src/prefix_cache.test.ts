import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPrefixCacheAtoms,
  RequestPrefixForest,
  summarizePrefixCacheLog,
  type PrefixCacheRequestInput,
} from "./prefix_cache.js";

function request(projectRoot: string, userContent: string): PrefixCacheRequestInput {
  return {
    projectRoot,
    endpoint: "https://provider.example/chat/completions",
    model: "writer-model",
    providerName: "test",
    userId: "session-cache-namespace",
    sessionId: "session-1",
    jobId: "job-1",
    callKind: "agent_step",
    step: 1,
    stableMessageCount: 1,
    initialMessageCount: 2,
    tools: [{
      type: "function",
      function: { name: "read_document", parameters: { type: "object" } },
    }],
    messages: [
      { role: "system", content: "stable-prefix" },
      { role: "user", content: userContent },
    ],
    requestProfile: { thinking: "enabled" },
  };
}

test("request prefix forest finds the exact atom prefix without logging prompt bodies", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-prefix-cache-"));
  const logPath = join(root, "prefix-cache.jsonl");
  try {
    const forest = new RequestPrefixForest(logPath);
    const first = forest.begin(request(root, "private-user-request"));
    assert.equal(first.prediction.priorRequests, 0);
    assert.equal(first.prediction.matchedAtoms, 0);

    const second = forest.begin(request(root, "different-private-request"));
    assert.equal(second.prediction.priorRequests, 0, "an unfinished request must not predict provider warmth");
    assert.equal(second.prediction.matchedAtoms, 0);
    forest.finish(first, {
      promptTokens: 120,
      completionTokens: 20,
      cacheHitTokens: 0,
      cacheMissTokens: 120,
    });
    const confirmed = forest.begin(request(root, "different-private-request"));
    assert.equal(confirmed.prediction.priorRequests, 1);
    assert.equal(confirmed.prediction.matchedAtoms, 1, "only the stable system prefix should match");
    assert.equal(confirmed.prediction.firstDivergence?.kind, "user");
    forest.finish(confirmed, {
      promptTokens: 120,
      completionTokens: 20,
      cacheHitTokens: 80,
      cacheMissTokens: 40,
    });

    const log = readFileSync(logPath, "utf8");
    assert.doesNotMatch(log, /private-user-request|different-private-request|stable-prefix/);
    assert.match(log, /"event":"request_start"/);
    assert.match(log, /"event":"request_finish"/);

    const restored = new RequestPrefixForest(logPath);
    const third = restored.begin(request(root, "different-private-request"));
    assert.equal(third.prediction.fullRequestKnown, true);
    assert.equal(third.prediction.matchedAtoms, third.prediction.totalAtoms);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefix atoms expose document cache metadata but omit document text", () => {
  const body = "document-body-must-not-be-logged";
  const atoms = buildPrefixCacheAtoms({
    stableMessageCount: 0,
    initialMessageCount: 0,
    messages: [{
      role: "tool",
      tool_call_id: "read-1",
      content: JSON.stringify({
        path: "lore/world.md",
        sourceHash: "source-hash",
        artifactId: 7,
        startLine: 3,
        endLine: 8,
        content: body,
      }),
    }],
  });
  assert.equal(atoms[0].document?.path, "lore/world.md");
  assert.equal(atoms[0].document?.sourceHash, "source-hash");
  assert.equal(atoms[0].document?.bodyCharacters, body.length);
  assert.doesNotMatch(JSON.stringify(atoms), new RegExp(body));
});

test("prefix atoms place tools after initial messages and before appended turns", () => {
  const atoms = buildPrefixCacheAtoms({
    stableMessageCount: 1,
    initialMessageCount: 2,
    messages: [
      { role: "system", content: "stable" },
      { role: "user", content: "request" },
      { role: "assistant", content: "working" },
    ],
    tools: [{ type: "function", function: { name: "read_document" } }],
  });
  assert.deepEqual(atoms.map(atom => atom.kind), [
    "stable_system",
    "user",
    "tool_schema",
    "assistant",
  ]);
});

test("replayed turns are classified apart from this turn's dynamic tail", () => {
  const atoms = buildPrefixCacheAtoms({
    stableMessageCount: 1,
    replayedMessageCount: 4,
    initialMessageCount: 5,
    messages: [
      { role: "system", content: "stable" },
      // Frozen turn 1: bytes the provider has already seen.
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "读", tool_calls: [{ id: "c1", type: "function", function: { name: "read_document", arguments: "{}" } }] },
      { role: "tool", content: "{}", tool_call_id: "c1" },
      // This turn's own context block — the only new bytes.
      { role: "user", content: "第二轮" },
      { role: "assistant", content: "working" },
    ],
  });
  assert.deepEqual(atoms.map(atom => atom.kind), [
    "stable_system",
    "replayed_turn",
    "replayed_turn",
    "replayed_turn",
    "user",
    "assistant",
  ]);
});

test("omitting replayedMessageCount keeps the pre-replay classification", () => {
  const atoms = buildPrefixCacheAtoms({
    stableMessageCount: 1,
    initialMessageCount: 3,
    messages: [
      { role: "system", content: "stable" },
      { role: "system", content: "dynamic" },
      { role: "user", content: "request" },
    ],
  });
  assert.deepEqual(atoms.map(atom => atom.kind), ["stable_system", "dynamic_system", "user"]);
});

test("cache log summary joins prediction with provider usage and ranks divergences", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-cache-summary-"));
  const logPath = join(root, "prefix-cache.jsonl");
  try {
    const forest = new RequestPrefixForest(logPath);
    for (const [index, content] of ["请求一", "请求二", "请求三"].entries()) {
      const observation = forest.begin(request(root, content));
      forest.finish(observation, {
        promptTokens: 1_000,
        completionTokens: 50,
        cacheHitTokens: index === 0 ? 0 : 900,
        cacheMissTokens: index === 0 ? 1_000 : 100,
      });
    }
    // A different call kind must not be folded into agent_step's numbers.
    const other = forest.begin({ ...request(root, "编译"), callKind: "task_contract" });
    forest.finish(other, { promptTokens: 100, completionTokens: 10, cacheHitTokens: 0, cacheMissTokens: 100 });

    const summary = summarizePrefixCacheLog(logPath);
    assert.equal(summary.totalRequests, 4);
    assert.deepEqual(summary.callKinds.map(kind => kind.callKind), ["agent_step", "task_contract"]);

    const step = summary.callKinds[0];
    assert.equal(step.requests, 3);
    assert.equal(step.measuredRequests, 3);
    assert.equal(step.promptTokens, 3_000);
    assert.equal(step.cacheHitTokens, 1_800);
    assert.equal(step.actualHitRate, 0.6);
    assert.ok((step.predictedHitRate ?? 0) > 0, "the stable system prefix should predict some hit");
    // The cold first request diverges at the stable prefix itself; the two warm
    // ones diverge at the user message — which is exactly the slot we want named.
    const cold = step.topDivergences.find(item => item.kind === "stable_system");
    const warm = step.topDivergences.find(item => item.kind === "user");
    assert.equal(cold?.requests, 1);
    assert.equal(warm?.requests, 2);
    assert.ok((warm?.missedTokens ?? 0) > 0);
    assert.ok((step.componentTokens.stable_system ?? 0) > 0);

    const filtered = summarizePrefixCacheLog(logPath, { callKind: "task_contract" });
    assert.equal(filtered.totalRequests, 1);
    assert.deepEqual(filtered.callKinds.map(kind => kind.callKind), ["task_contract"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
