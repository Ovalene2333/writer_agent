import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateAgentEvents } from "./agent_eval.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import type { AgentEvent } from "./types.js";

test("agent evaluation checks contracts, tool groups, artifacts and terminals", () => {
  const events: AgentEvent[] = [
    { type: "task_contract", contract: {
      mode: "rewrite", outcome: "document", evidence: "target", mutation: "document",
      planning: "adaptive", capabilities: ["documents", "review"],
    } },
    { type: "step_start", step: 1 },
    { type: "tool", name: "read_file" },
    { type: "tool", name: "edit_file" },
    { type: "proposal", proposal: { id: 1 } as never },
    { type: "done", sessionId: "s1" },
  ];
  const result = evaluateAgentEvents(events, {
    contract: { outcome: "document", evidence: "target", mutation: "document" },
    requiredAnyToolGroups: [["read_file", "search_files"], ["edit_file"]],
    artifact: "document",
    terminal: "done",
    maxSteps: 2,
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});
test("agent evaluation runs and cases persist in the project database", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-eval-"));
  try {
    const project = WriterProject.init(root, "评测持久化");
    const store = new WriterStore(project);
    const sessionId = store.createSession("case");
    const run = store.createAgentEvaluationRun("/provider/project", "test-model");
    store.recordAgentEvaluationCase({
      runId: run.id,
      caseId: "case-1",
      sessionId,
      prompt: "测试",
      status: "passed",
      expected: { terminal: "done" },
      result: { terminal: "done" },
      events: [{ type: "done", sessionId }],
    });
    store.finishAgentEvaluationRun(run.id, "passed", { total: 1, passed: 1, failed: 0 });
    const restored = store.agentEvaluationRun(run.id);
    assert.equal(restored?.status, "passed");
    assert.equal(restored?.cases?.[0].caseId, "case-1");
    assert.deepEqual(restored?.cases?.[0].events, [{ type: "done", sessionId }]);
    assert.equal(store.listAgentEvaluationRuns()[0].id, run.id);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
