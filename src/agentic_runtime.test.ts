import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCompletionGaps,
  completionRecoveryPrompt,
  contractAllowsTool,
  createAgentExecutionProgress,
  recordAgentToolResult,
  resolveAgentPlanningStrategy,
  type AgentTaskContract,
} from "./agentic_runtime.js";

const documentContract: AgentTaskContract = {
  mode: "rewrite",
  outcome: "document",
  evidence: "target",
  mutation: "document",
  planning: "adaptive",
  capabilities: ["research", "documents", "review"],
};

test("completion gates require evidence, artifact and a closed adaptive plan", () => {
  const progress = createAgentExecutionProgress();
  const todos = [{ id: "t1", content: "读取并修改", status: "in_progress" as const }];
  assert.deepEqual(agentCompletionGaps(documentContract, progress, todos), [
    "尚未定位并读取目标资料",
    "尚未成功提交文档提案或 change set",
    "动态任务清单仍有未完成步骤",
  ]);

  recordAgentToolResult(progress, "read_document", { status: "ok" });
  recordAgentToolResult(progress, "propose_document_patch", { status: "proposed" });
  assert.deepEqual(agentCompletionGaps(documentContract, progress, [
    { ...todos[0], status: "completed" },
  ]), []);
});

test("tool observations retain retry pressure and recover on success", () => {
  const progress = createAgentExecutionProgress();
  recordAgentToolResult(progress, "read_document", { error: "stale" });
  recordAgentToolResult(progress, "read_document", { error: "stale" });
  const prompt = completionRecoveryPrompt(["尚未定位并读取目标资料"], progress);
  assert.match(prompt, /read_document×2/);
  assert.match(prompt, /manage_todos/);

  recordAgentToolResult(progress, "read_document", { status: "ok" });
  assert.equal(progress.failedTools.has("read_document"), false);
  assert.equal(progress.successfulTools.has("read_document"), true);
});

test("universal visibility is separated from contract side-effect authorization", () => {
  const answerContract: AgentTaskContract = {
    mode: "brainstorm",
    outcome: "answer",
    evidence: "none",
    mutation: "none",
    planning: "direct",
    capabilities: ["research"],
  };
  assert.equal(contractAllowsTool(answerContract, "ask", "search_project"), true);
  assert.equal(contractAllowsTool(answerContract, "ask", "propose_document"), false);
  assert.equal(contractAllowsTool(documentContract, "ask", "propose_document_patch"), true);
  assert.equal(contractAllowsTool(documentContract, "ask", "apply_character_changes"), true);
  assert.equal(contractAllowsTool(documentContract, "plan", "propose_document_patch"), false);
});

test("reusable grounded context satisfies an evidence obligation", () => {
  const progress = createAgentExecutionProgress(true);
  const contract = { ...documentContract, mutation: "none" as const, planning: "direct" as const };
  assert.deepEqual(agentCompletionGaps(contract, progress, []), []);
});

test("mixed contracts require and authorize both artifact families", () => {
  const contract: AgentTaskContract = {
    ...documentContract,
    outcome: "multiple",
    mutation: "mixed",
  };
  const progress = createAgentExecutionProgress(true);
  recordAgentToolResult(progress, "save_character", { status: "saved" });
  assert.deepEqual(agentCompletionGaps(contract, progress, []), [
    "尚未成功提交文档提案或 change set",
  ]);
  assert.equal(contractAllowsTool(contract, "ask", "save_character"), true);
  assert.equal(contractAllowsTool(contract, "ask", "propose_change_set"), true);
});

test("all mutation contracts normalize to adaptive planning", () => {
  assert.equal(resolveAgentPlanningStrategy("document", "direct", 0), "adaptive");
  assert.equal(resolveAgentPlanningStrategy("character", "direct", 0), "adaptive");
  assert.equal(resolveAgentPlanningStrategy("mixed", "direct", 0), "adaptive");
  assert.equal(resolveAgentPlanningStrategy("none", "direct", 4), "direct");
  assert.equal(resolveAgentPlanningStrategy("none", undefined, 3), "adaptive");
});
