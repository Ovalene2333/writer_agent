import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCompletionGaps,
  completionRecoveryPrompt,
  contractAllowsTool,
  createAgentRunState,
  createAgentExecutionProgress,
  agentRunPendingDocumentLabels,
  recordAgentRunDocumentEvidence,
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

test("completion gates require evidence and artifact, while todos remain advisory", () => {
  const progress = createAgentExecutionProgress();
  const todos = [{ id: "t1", content: "读取并修改", status: "in_progress" as const }];
  assert.deepEqual(agentCompletionGaps(documentContract, progress, todos), [
    "尚未定位并读取目标资料",
    "尚未成功提交文件变更",
  ]);

  recordAgentToolResult(progress, "read_file", { status: "ok" });
  recordAgentToolResult(progress, "edit_file", { status: "pending", proposalId: 12 });
  assert.deepEqual(agentCompletionGaps(documentContract, progress, [
    { ...todos[0], status: "completed" },
  ]), []);
});

test("tool observations retain retry pressure and recover on success", () => {
  const progress = createAgentExecutionProgress();
  recordAgentToolResult(progress, "read_file", { error: "stale" });
  recordAgentToolResult(progress, "read_file", { error: "stale" });
  const prompt = completionRecoveryPrompt(["尚未定位并读取目标资料"], progress);
  assert.match(prompt, /read_file×2/);
  assert.match(prompt, /manage_todos/);

  recordAgentToolResult(progress, "read_file", { status: "ok" });
  assert.equal(progress.failedTools.has("read_file"), false);
  assert.equal(progress.successfulTools.has("read_file"), true);
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
  assert.equal(contractAllowsTool(answerContract, "ask", "search_files"), true);
  assert.equal(contractAllowsTool(answerContract, "ask", "write_file"), false);
  assert.equal(contractAllowsTool(documentContract, "ask", "edit_file"), true);
  assert.equal(contractAllowsTool(documentContract, "ask", "apply_character_changes"), true);
  assert.equal(contractAllowsTool(documentContract, "plan", "edit_file"), false);
  assert.equal(contractAllowsTool(answerContract, "ask", "generate_image"), false);
  assert.equal(contractAllowsTool({ ...answerContract, capabilities: ["images"] }, "ask", "generate_image"), true);
  assert.equal(contractAllowsTool({ ...answerContract, capabilities: ["images"] }, "plan", "generate_image"), false);
});

test("image capability requires a successful generated attachment", () => {
  const progress = createAgentExecutionProgress();
  const contract: AgentTaskContract = {
    mode: "general",
    outcome: "answer",
    evidence: "none",
    mutation: "none",
    planning: "direct",
    capabilities: ["images"],
  };
  assert.deepEqual(agentCompletionGaps(contract, progress, []), ["尚未成功生成用户要求的图片"]);
  recordAgentToolResult(progress, "generate_image", { status: "generated", attachmentId: "image-1" });
  assert.deepEqual(agentCompletionGaps(contract, progress, []), []);
});

test("reusable grounded context satisfies an evidence obligation", () => {
  const progress = createAgentExecutionProgress(true);
  const contract = { ...documentContract, mutation: "none" as const, planning: "direct" as const };
  assert.deepEqual(agentCompletionGaps(contract, progress, []), []);
});

test("planned author review rules must be persisted before completion", () => {
  const progress = createAgentExecutionProgress();
  const contract: AgentTaskContract = {
    mode: "general",
    outcome: "answer",
    evidence: "none",
    mutation: "none",
    planning: "direct",
    capabilities: ["review"],
    proseGateRequired: true,
  };
  assert.deepEqual(agentCompletionGaps(contract, progress, []), [
    "尚未把 planning 识别出的可复用作者反馈保存为复审规则",
  ]);
  recordAgentToolResult(progress, "manage_prose_gates", { rules: [] });
  assert.equal(progress.proseGateRuleSaved, false);
  recordAgentToolResult(progress, "manage_prose_gates", { status: "saved" });
  assert.deepEqual(agentCompletionGaps(contract, progress, []), []);
});

test("self-contained document creation only requires a delivered artifact", () => {
  const progress = createAgentExecutionProgress();
  const contract: AgentTaskContract = {
    mode: "write_scene",
    outcome: "document",
    evidence: "none",
    mutation: "document",
    planning: "adaptive",
    capabilities: ["documents", "scenes"],
  };
  assert.deepEqual(agentCompletionGaps(contract, progress, []), [
    "尚未成功提交文件变更",
  ]);
  recordAgentToolResult(progress, "write_file", { status: "pending", proposalId: 9 });
  assert.deepEqual(agentCompletionGaps(contract, progress, []), []);
});

test("multi-document completion uses concrete proposal evidence, not a combined todo", () => {
  const progress = createAgentExecutionProgress();
  const contract: AgentTaskContract = {
    mode: "write_scene",
    outcome: "document",
    evidence: "none",
    mutation: "document",
    planning: "adaptive",
    capabilities: ["documents", "scenes"],
    documentDeliverables: ["第一章", "第二章"],
  };
  const combinedTodo = [{ id: "t1", content: "创作并写入前两章", status: "completed" as const }];
  recordAgentToolResult(progress, "write_file", { status: "accepted", proposalId: 21 });
  assert.deepEqual(agentCompletionGaps(contract, progress, combinedTodo), [
    "文件交付尚未完成：要求 2 份，已有 1 份可验证提交",
  ]);
  recordAgentToolResult(progress, "write_file", { status: "accepted", proposalId: 22 });
  assert.deepEqual(agentCompletionGaps(contract, progress, combinedTodo), []);
});

test("blocked proposal results cannot become document evidence", () => {
  const progress = createAgentExecutionProgress();
  recordAgentToolResult(progress, "write_file", {
    status: "final_review_revision_required",
    code: "DIRECT_CHAPTER_REVIEW_BLOCKED",
  });
  assert.equal(progress.documentArtifactProduced, false);
  assert.equal(progress.documentArtifactKeys.size, 0);
  assert.equal(progress.failedTools.get("write_file"), 1);
});

test("durable run state resumes unfinished unordered obligations", () => {
  let state = createAgentRunState("写两章", ["第一章", "第二章"]);
  state = recordAgentRunDocumentEvidence(state, {
    toolName: "write_file",
    proposalId: 31,
    path: "chapters/01.md",
    recordedAt: "2026-08-02T00:00:00.000Z",
  });
  state = { ...state, terminalState: "interrupted" };
  const resumed = createAgentRunState("写两章", ["第一章", "第二章"], state);
  assert.deepEqual(agentRunPendingDocumentLabels(resumed), ["第二章"]);
});

test("chapter workflow stage gaps require review after a scene chain starts", () => {
  const progress = createAgentExecutionProgress(true);
  const contract: AgentTaskContract = {
    mode: "write_scene",
    outcome: "document",
    evidence: "none",
    mutation: "document",
    planning: "adaptive",
    capabilities: ["documents", "scenes", "review"],
    documentProposalRequired: true,
    workflow: "chapter_delivery",
    qualityProfile: "standard",
  };
  recordAgentToolResult(progress, "begin_chapter_draft", { status: "started" });
  recordAgentToolResult(progress, "write_chapter_scene", { status: "written", complete: true });
  recordAgentToolResult(progress, "write_file", { status: "pending", proposalId: 41 });
  assert.deepEqual(agentCompletionGaps(contract, progress, []), [
    "章节场景链已启动但尚未完成整章终审",
  ]);
  recordAgentToolResult(progress, "inspect_chapter_draft", {
    status: "review_passed",
    proposalSubmitted: true,
    proposal: { proposalId: 41 },
  });
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
    "尚未成功提交文件变更",
  ]);
  assert.equal(contractAllowsTool(contract, "ask", "save_character"), true);
  assert.equal(contractAllowsTool(contract, "ask", "write_file"), true);
});

test("all mutation contracts normalize to adaptive planning", () => {
  assert.equal(resolveAgentPlanningStrategy("document", "direct", 0), "adaptive");
  assert.equal(resolveAgentPlanningStrategy("character", "direct", 0), "adaptive");
  assert.equal(resolveAgentPlanningStrategy("mixed", "direct", 0), "adaptive");
  assert.equal(resolveAgentPlanningStrategy("none", "direct", 4), "direct");
  assert.equal(resolveAgentPlanningStrategy("none", undefined, 3), "adaptive");
});
