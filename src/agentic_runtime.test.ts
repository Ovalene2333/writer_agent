import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCompletionGaps,
  completionRecoveryPrompt,
  contractAllowsTool,
  createAgentExecutionProgress,
  isDocumentMutationTool,
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

test("the evidence floor only bites once something was actually delivered", () => {
  const progress = createAgentExecutionProgress();
  // Nothing delivered yet: there is no invariant to violate, so nothing blocks.
  assert.deepEqual(agentCompletionGaps(documentContract, progress), []);

  recordAgentToolResult(progress, "edit_file", { status: "pending", proposalId: 12 });
  assert.deepEqual(agentCompletionGaps(documentContract, progress), ["尚未定位并读取目标资料"]);

  recordAgentToolResult(progress, "read_file", { status: "ok" });
  assert.deepEqual(agentCompletionGaps(documentContract, progress), []);
});

test("a predicted mutation intent no longer decides completion", () => {
  // “本轮会改文件/会存角色卡/会出图” is a guess made before the first tool call.
  // It may shape the prompt; it must not hold the run open or force an artifact.
  const progress = createAgentExecutionProgress(true);
  assert.deepEqual(agentCompletionGaps(documentContract, progress), []);
  assert.deepEqual(agentCompletionGaps({ ...documentContract, mutation: "character" }, progress), []);
  assert.deepEqual(agentCompletionGaps({
    ...documentContract,
    outcome: "answer",
    mutation: "none",
    capabilities: ["images"],
  }, progress), []);
});

test("tool observations retain retry pressure and recover on success", () => {
  const progress = createAgentExecutionProgress();
  recordAgentToolResult(progress, "read_file", { error: "stale" });
  recordAgentToolResult(progress, "read_file", { error: "stale" });
  const prompt = completionRecoveryPrompt(["尚未定位并读取目标资料"], progress);
  assert.match(prompt, /read_file×2/);

  recordAgentToolResult(progress, "read_file", { status: "ok" });
  assert.equal(progress.failedTools.has("read_file"), false);
  assert.equal(progress.successfulTools.has("read_file"), true);
});

test("only plan mode withholds side effects; the contract never does", () => {
  const answerContract: AgentTaskContract = {
    mode: "brainstorm",
    outcome: "answer",
    evidence: "none",
    mutation: "none",
    planning: "direct",
    capabilities: ["research"],
  };
  // A mis-classified “这只是个问题” request used to deny write_file and kill the run.
  assert.equal(contractAllowsTool(answerContract, "ask", "write_file"), true);
  assert.equal(contractAllowsTool(answerContract, "ask", "save_character"), true);
  assert.equal(contractAllowsTool(answerContract, "ask", "generate_image"), true);
  assert.equal(contractAllowsTool(answerContract, "ask", "search_files"), true);
  assert.equal(contractAllowsTool(documentContract, "plan", "edit_file"), false);
  assert.equal(contractAllowsTool(documentContract, "plan", "save_character"), false);
  assert.equal(contractAllowsTool(documentContract, "plan", "generate_image"), false);
  assert.equal(contractAllowsTool(documentContract, "plan", "read_file"), true);
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
  assert.deepEqual(agentCompletionGaps(contract, progress), [
    "尚未把 planning 识别出的可复用作者反馈保存为复审规则",
  ]);
  recordAgentToolResult(progress, "manage_prose_gates", { rules: [] });
  assert.equal(progress.proseGateRuleSaved, false);
  recordAgentToolResult(progress, "manage_prose_gates", { status: "saved" });
  assert.deepEqual(agentCompletionGaps(contract, progress), []);
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
  assert.deepEqual(agentCompletionGaps(contract, progress), [
    "章节场景链已启动但尚未完成整章终审",
  ]);
  recordAgentToolResult(progress, "inspect_chapter_draft", {
    status: "review_passed",
    proposalSubmitted: true,
    proposal: { proposalId: 41 },
  });
  assert.deepEqual(agentCompletionGaps(contract, progress), []);
});

test("the ledger opens on document tools, not on reads or character saves", () => {
  assert.equal(isDocumentMutationTool("write_file"), true);
  assert.equal(isDocumentMutationTool("propose_chapter_draft"), true);
  assert.equal(isDocumentMutationTool("read_file"), false);
  assert.equal(isDocumentMutationTool("save_character"), false);
});

test("all mutation contracts normalize to adaptive planning", () => {
  assert.equal(resolveAgentPlanningStrategy("document", "direct", 0), "adaptive");
  assert.equal(resolveAgentPlanningStrategy("character", "direct", 0), "adaptive");
  assert.equal(resolveAgentPlanningStrategy("mixed", "direct", 0), "adaptive");
  assert.equal(resolveAgentPlanningStrategy("none", "direct", 4), "direct");
  assert.equal(resolveAgentPlanningStrategy("none", undefined, 3), "adaptive");
});
