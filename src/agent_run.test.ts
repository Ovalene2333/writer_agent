import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRunController } from "./agent_run_controller.js";
import { computeAgentHardTurnBudget, isRecoverableProviderTermination, proposalRevisionBaseChangeReason } from "./agent.js";
import { agentRunInvariantViolations } from "./agent_run_invariants.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import type { AgentTaskContract } from "./agentic_runtime.js";
import { executeTool } from "./tools/execute.js";
import { createProposalRetryState, type ProposalRevisionCase } from "./proposal_retry.js";

const twoDocumentTask: AgentTaskContract = {
  mode: "write_scene",
  outcome: "document",
  evidence: "none",
  mutation: "document",
  planning: "adaptive",
  capabilities: ["documents", "scenes", "review"],
  workflow: "free",
  qualityProfile: "fast",
  documentDeliverables: ["第一章", "第二章"],
};

test("provider stream termination is resumable but explicit abort remains cancellation", () => {
  assert.equal(isRecoverableProviderTermination(new Error("terminated")), true);
  assert.equal(isRecoverableProviderTermination(new Error("socket hang up")), true);
  assert.equal(isRecoverableProviderTermination(new Error("ECONNRESET")), true);
  const abort = new Error("terminated");
  abort.name = "AbortError";
  assert.equal(isRecoverableProviderTermination(abort), false);
  assert.equal(isRecoverableProviderTermination(new Error("模型请求失败（400）：invalid request")), false);
});

function fixture(name: string): { root: string; project: WriterProject; store: WriterStore; sessionId: string } {
  const root = mkdtempSync(join(tmpdir(), `writer-agent-run-v2-${name}-`));
  const project = WriterProject.init(root, name);
  const store = new WriterStore(project);
  return { root, project, store, sessionId: store.createSession(name) };
}

function revisionCase(runId: string, deliverableId: string, path: string): ProposalRevisionCase {
  return {
    schemaVersion: 3,
    revisionCaseId: `revision:${runId}:${deliverableId}`,
    runId,
    deliverableId,
    path,
    baseDocumentExists: false,
    baseDocumentSourceHash: "__missing__",
    draftArtifactId: 101,
    draftSourceHash: "draft-hash",
    semanticDraftArtifactId: 101,
    semanticDraftSourceHash: "draft-hash",
    reviewArtifactId: 102,
    attempt: 1,
    lastGate: "semantic_review",
    retryState: createProposalRetryState({ runId, deliverableId, path }),
    unresolvedIssues: [{
      id: "issue:a",
      severity: "blocker",
      kind: "knowledge_leak",
      evidence: ["她听见了回答。"],
      problem: "听觉编码尚未建立",
      action: "调整事件顺序",
    }],
    resolvedIssueIds: [],
    stillPresentIssueIds: [],
    newlyIntroducedIssueIds: ["issue:a"],
    status: "blocked",
    retention: "executable",
  };
}

test("AgentRun v2 binds independent deliverables and completes only after both", () => {
  const { root, store, sessionId } = fixture("two-documents");
  try {
    const controller = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 1,
      originalRequest: "写两章",
      task: twoDocumentTask,
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    controller.recordStep(1);
    controller.recordStep(2);
    assert.equal(controller.snapshot.deliverables[0]?.execution.usedSteps, 2);
    controller.recordDocumentEvidence({
      toolName: "write_file",
      proposalId: 11,
      path: "chapters/01.md",
      recordedAt: "2026-08-02T00:00:00.000Z",
    }, "document-1", "test:first", "pending");
    assert.deepEqual(controller.pendingDocumentLabels(), ["第二章"]);
    controller.recordStep(3);
    assert.equal(controller.snapshot.deliverables[1]?.execution.usedSteps, 1);
    assert.equal(controller.complete(twoDocumentTask, []).length, 1);
    controller.recordDocumentEvidence({
      toolName: "write_file",
      proposalId: 12,
      path: "chapters/02.md",
      recordedAt: "2026-08-02T00:00:01.000Z",
    }, "document-2", "test:second", "pending");
    assert.deepEqual(controller.complete(twoDocumentTask, []), []);
    assert.equal(controller.snapshot.status, "completed");
    assert.deepEqual(agentRunInvariantViolations(controller.snapshot), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("AgentRun v2 creates a default deliverable for single document mutations", () => {
  const { root, store, sessionId } = fixture("default-document-deliverable");
  try {
    const controller = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 4,
      originalRequest: "写一份设定",
      task: { ...twoDocumentTask, documentDeliverables: [] },
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    assert.deepEqual(controller.pendingDocumentLabels(), ["文件交付"]);
    controller.recordStep(1);
    assert.equal(controller.snapshot.deliverables[0]?.execution.startedAtStep, 1);
    assert.equal(controller.snapshot.deliverables[0]?.execution.usedSteps, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-document hard budget is derived per deliverable", () => {
  assert.equal(computeAgentHardTurnBudget({
    baseHardCap: 32,
    documentDeliverables: 3,
    documentProposalRequired: true,
    maxTurnsOverride: false,
  }), 96);
  assert.equal(computeAgentHardTurnBudget({
    baseHardCap: 5,
    documentDeliverables: 3,
    documentProposalRequired: true,
    maxTurnsOverride: true,
  }), 5);
});

test("expected rhythm polish is a gate transition, not a generic tool failure", () => {
  const { root, store, sessionId } = fixture("rhythm");
  try {
    const controller = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 2,
      originalRequest: "写一章",
      task: { ...twoDocumentTask, documentDeliverables: ["第一章"] },
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    controller.observeTool("propose_document", JSON.stringify({
      status: "pending",
      proposalId: 20,
      rhythmRevisionRequired: true,
      code: "RHYTHM_POLISH_REQUIRED",
    }), "test:rhythm", "document-1");
    assert.equal(controller.snapshot.progress.failedTools.propose_document, undefined);
    assert.equal(controller.snapshot.progress.gateAttempts.rhythm, 1);
    assert.equal(controller.snapshot.deliverables[0]?.execution.gateAttempts.rhythm, 1);
    assert.equal(controller.snapshot.deliverables[0]?.state, "revision_required");

    controller.observeTool("propose_document", JSON.stringify({
      status: "revision_required",
      code: "RHYTHM_REVISION_REQUIRED",
      failureKind: "semantic_revision",
      error: "节奏硬门仍未通过",
    }), "test:rhythm:hard", "document-1");
    assert.equal(controller.snapshot.progress.failedTools.propose_document, 1);
    assert.equal(controller.snapshot.progress.gateAttempts.rhythm, 2);
    assert.equal(controller.snapshot.deliverables[0]?.execution.gateAttempts.rhythm, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-delivery-ready proposal cannot be accepted or written to disk", () => {
  const { root, project, store, sessionId } = fixture("intermediate-proposal");
  try {
    const path = "chapters/节奏待修订.md";
    const proposal = store.createProposal(
      sessionId,
      path,
      "# 节奏待修订\n\n这仍是需要继续润色的中间稿。",
      "首轮节奏草稿",
      [],
      undefined,
      20,
      false,
    );

    assert.equal(proposal.deliveryReady, false);
    assert.throws(() => store.acceptProposal(proposal.id), /中间草稿|不可交付|不能接受/);
    assert.equal(store.proposal(proposal.id).status, "pending");
    assert.equal(project.documentExists(path), false);
    const applications = store.database.prepare(
      "SELECT COUNT(*) AS count FROM proposal_applications WHERE proposal_id=?",
    ).get(proposal.id) as { count: number };
    assert.equal(Number(applications.count), 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposal invocation errors do not consume semantic gate attempts", async () => {
  const { root, project, store, sessionId } = fixture("proposal-call-error");
  try {
    const controller = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 21,
      originalRequest: "写一章",
      task: { ...twoDocumentTask, documentDeliverables: ["第一章"] },
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    const rawResult = await executeTool({
      id: "missing-patch",
      name: "propose_document_patch",
      arguments: JSON.stringify({
        path: "chapters/尚未创建.md",
        edits: [{ search: "旧句", replace: "新句" }],
        summary: "修订",
      }),
    }, project, store, sessionId, () => undefined, undefined, { permissionMode: "ask" });
    const parsed = JSON.parse(rawResult) as Record<string, unknown>;
    assert.equal(parsed.code, "TARGET_DOCUMENT_MISSING");
    assert.equal(parsed.failureKind, "invalid_request");

    const interpreted = controller.observeTool(
      "propose_document_patch",
      rawResult,
      "test:missing-patch",
      "document-1",
    );
    assert.equal(interpreted.observation.outcome, "retryable_error");
    assert.equal(interpreted.observation.gate, undefined);
    assert.deepEqual(controller.snapshot.progress.gateAttempts, {});
    assert.equal(controller.snapshot.progress.failedTools.propose_document_patch, 1);
    assert.equal(controller.snapshot.deliverables[0]?.state, "pending");

    controller.observeTool("propose_document", JSON.stringify({
      status: "final_review_unavailable",
      code: "DIRECT_CHAPTER_REVIEW_INVALID",
      failureKind: "invalid_output",
      message: "终审 JSON 无法解析",
    }), "test:invalid-review", "document-1");
    assert.deepEqual(controller.snapshot.progress.gateAttempts, {});
    assert.equal(controller.snapshot.deliverables[0]?.state, "pending");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposal revision state belongs to one run and only explicit resume restores it", () => {
  const { root, store, sessionId } = fixture("revision-scope");
  try {
    const task = { ...twoDocumentTask, documentDeliverables: ["第一章"] };
    const first = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 61,
      originalRequest: "写第一章",
      task,
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    const activeCase = revisionCase(first.runId, "document-1", "chapters/第一章.md");
    assert.throws(() => first.setProposalRevision("document-1", {
      ...activeCase,
      retryState: { ...activeCase.retryState, path: "chapters/第二章.md" },
    }, "test:revision:invalid-nested-scope"), /不匹配/);
    first.setProposalRevision("document-1", activeCase, "test:revision:set");
    first.suspend("等待续跑", "resume");

    const fresh = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 62,
      originalRequest: "写第一章",
      task,
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    assert.notEqual(fresh.runId, first.runId);
    assert.equal(fresh.proposalRevision("document-1"), undefined);

    const resumed = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 63,
      originalRequest: "写第一章",
      task,
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: true,
    });
    assert.equal(resumed.runId, first.runId);
    assert.equal(resumed.proposalRevision("document-1")?.revisionCaseId, activeCase.revisionCaseId);
    assert.equal(resumed.proposalRevision("document-1")?.draftArtifactId, 101);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resuming an older revision run detects a newer task's accepted document", () => {
  const { root, project, store, sessionId } = fixture("revision-resume-base-drift");
  try {
    const task = { ...twoDocumentTask, documentDeliverables: ["第一章"] };
    const path = "chapters/第一章.md";
    const original = "# 第一章\n\n旧运行开始修订时的落盘正文。\n";
    project.writeRaw(path, original);
    const first = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 71,
      originalRequest: "修订第一章",
      task,
      permissionMode: "auto",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    const activeCase: ProposalRevisionCase = {
      ...revisionCase(first.runId, "document-1", path),
      baseDocumentExists: true,
      baseDocumentSourceHash: project.hash(original),
    };
    first.setProposalRevision("document-1", activeCase, "test:revision-drift:set");
    first.suspend("等待旧修订续跑", "resume");

    const newer = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 72,
      originalRequest: "独立重写第一章",
      task,
      permissionMode: "auto",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    const proposal = store.createProposal(
      sessionId,
      path,
      "# 第一章\n\n较新任务已经落盘。\n",
      "独立重写",
      [],
      undefined,
      72,
    );
    store.acceptProposal(proposal.id);
    newer.recordDocumentEvidence({
      toolName: "propose_document",
      proposalId: proposal.id,
      path,
      recordedAt: "2026-08-02T00:00:00.000Z",
    }, "document-1", "test:newer:proposal", "accepted");
    assert.deepEqual(newer.complete(task, []), []);

    const resumed = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 73,
      originalRequest: "修订第一章",
      task,
      permissionMode: "auto",
      reusableEvidence: false,
      resumeInterrupted: true,
    });
    const restored = resumed.proposalRevision("document-1");
    assert.equal(resumed.runId, first.runId);
    assert.equal(restored?.baseDocumentSourceHash, project.hash(original));
    assert.match(proposalRevisionBaseChangeReason(project, restored!) ?? "", /已被其他操作修改/u);
    assert.equal(restored?.retryState.absoluteSubmissions, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit resume restores a zero-budget pending rhythm polish case", () => {
  const { root, store, sessionId } = fixture("rhythm-revision-resume");
  try {
    const task = { ...twoDocumentTask, documentDeliverables: ["第一章"] };
    const first = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 64,
      originalRequest: "写第一章并完成节奏润色",
      task,
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    const activeCase: ProposalRevisionCase = {
      ...revisionCase(first.runId, "document-1", "chapters/第一章.md"),
      attempt: 0,
      lastGate: "rhythm",
      rhythmPolishPending: true,
      semanticDraftArtifactId: undefined,
      semanticDraftSourceHash: undefined,
      unresolvedIssues: [],
      newlyIntroducedIssueIds: [],
    };
    first.setProposalRevision("document-1", activeCase, "test:rhythm-revision:set");
    first.suspend("节奏润色中断", "resume");

    const resumed = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 65,
      originalRequest: "写第一章并完成节奏润色",
      task,
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: true,
    });
    const restored = resumed.proposalRevision("document-1");
    assert.equal(restored?.rhythmPolishPending, true);
    assert.equal(restored?.retryState.gateAttempts.rhythm, 0);
    assert.equal(restored?.retryState.absoluteSubmissions, 0);
    assert.equal(restored?.draftArtifactId, 101);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence from another path cannot clear an active revision deliverable", () => {
  const { root, store, sessionId } = fixture("revision-evidence-scope");
  try {
    const controller = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 66,
      originalRequest: "写两章",
      task: twoDocumentTask,
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    const activeCase = revisionCase(controller.runId, "document-1", "chapters/第一章.md");
    controller.setProposalRevision("document-1", activeCase, "test:revision-evidence:set");
    assert.throws(() => controller.setProposalRevision(
      "document-2",
      revisionCase(controller.runId, "document-2", "chapters/第一章.md"),
      "test:revision-evidence:duplicate-path",
    ), /已绑定交付项 document-1/u);
    controller.recordDocumentEvidence({
      toolName: "inspect_chapter_draft",
      proposalId: 201,
      path: "chapters/第二章.md",
      recordedAt: "2026-08-02T00:00:00.000Z",
    }, undefined, "test:revision-evidence:other", "pending");

    assert.equal(controller.proposalRevision("document-1")?.revisionCaseId, activeCase.revisionCaseId);
    assert.equal(controller.snapshot.deliverables[0]?.evidence, undefined);
    assert.equal(controller.snapshot.deliverables[1]?.evidence?.path, "chapters/第二章.md");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit prose rejection remains a semantic gate event", () => {
  const { root, store, sessionId } = fixture("proposal-semantic-gate");
  try {
    const controller = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 22,
      originalRequest: "写一章",
      task: { ...twoDocumentTask, documentDeliverables: ["第一章"] },
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    controller.observeTool("propose_document", JSON.stringify({
      status: "revision_required",
      code: "PROSE_STYLE_REVISION_REQUIRED",
      failureKind: "semantic_revision",
      error: "句式门禁未通过",
      retryable: true,
    }), "test:style-gate", "document-1");
    assert.equal(controller.snapshot.progress.gateAttempts.style, 1);
    assert.equal(controller.snapshot.deliverables[0]?.state, "revision_required");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume reconciles an accepted proposal when the process missed its workflow event", () => {
  const { root, store, sessionId } = fixture("reconcile");
  try {
    const task = { ...twoDocumentTask, documentDeliverables: ["第一章"] };
    const first = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 31,
      originalRequest: "写一章",
      task,
      permissionMode: "auto",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    const proposal = store.createProposal(
      sessionId,
      "chapters/第一章.md",
      "# 第一章\n\n正文。",
      "完成第一章",
      [],
      undefined,
      31,
      true,
    );
    store.acceptProposal(proposal.id);
    first.suspend("模拟进程在工具完成后退出", "resume");

    const resumed = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 32,
      originalRequest: "写一章",
      task,
      permissionMode: "auto",
      reusableEvidence: false,
      resumeInterrupted: true,
    });
    assert.equal(resumed.completedDocumentDeliverables, 1);
    assert.equal(resumed.snapshot.deliverables[0]?.evidence?.proposalId, proposal.id);
    assert.deepEqual(resumed.complete(task, []), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposal application resumes after the file write but before database commit", () => {
  const { root, project, store, sessionId } = fixture("proposal-application");
  try {
    const proposal = store.createProposal(
      sessionId,
      "chapters/断点.md",
      "# 断点\n\n恢复后的正文。",
      "断点恢复",
      [],
      undefined,
      41,
      true,
    );
    const at = "2026-08-02T00:00:00.000Z";
    store.database.prepare(`INSERT INTO proposal_applications(
      proposal_id,status,before_content,after_hash,created_file,character_revisions_json,created_at,updated_at
    ) VALUES(?,'prepared','',?,1,'[]',?,?)`).run(
      proposal.id,
      project.hash(proposal.afterContent),
      at,
      at,
    );
    project.writeRaw(proposal.path, proposal.afterContent);

    const accepted = store.acceptProposal(proposal.id);
    assert.equal(accepted.status, "accepted");
    const revisions = store.database.prepare("SELECT COUNT(*) AS count FROM revisions WHERE proposal_id=?")
      .get(proposal.id) as { count: number };
    assert.equal(Number(revisions.count), 1);
    assert.equal(project.read(proposal.path), proposal.afterContent);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume selects the matching suspended run even after a newer task", () => {
  const { root, store, sessionId } = fixture("resume-matching");
  try {
    const task = { ...twoDocumentTask, documentDeliverables: ["第一章"] };
    const suspended = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 51,
      originalRequest: "继续第一章",
      task,
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    suspended.suspend("等待续跑", "resume");
    const suspendedRunId = suspended.runId;

    const answerTask: AgentTaskContract = {
      mode: "general",
      outcome: "answer",
      evidence: "none",
      mutation: "none",
      planning: "direct",
      capabilities: [],
      documentDeliverables: [],
    };
    const newer = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 52,
      originalRequest: "解释一个概念",
      task: answerTask,
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    assert.deepEqual(newer.complete(answerTask, []), []);

    const resumed = AgentRunController.open({
      store,
      sessionId,
      sourceMessageId: 53,
      originalRequest: "继续第一章",
      task,
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: true,
    });
    assert.equal(resumed.runId, suspendedRunId);
    assert.equal(resumed.snapshot.status, "running");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
