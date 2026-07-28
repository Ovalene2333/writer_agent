import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPrefixCacheAtoms,
  RequestPrefixForest,
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
    assert.equal(second.prediction.priorRequests, 1);
    assert.equal(second.prediction.matchedAtoms, 1, "only the stable system prefix should match");
    assert.equal(second.prediction.firstDivergence?.kind, "user");
    forest.finish(second, {
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
