import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRunController } from "./agent_run_controller.js";
import { agentRunInvariantViolations } from "./agent_run_invariants.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import type { AgentTaskContract } from "./agentic_runtime.js";
import { executeTool } from "./tools/execute.js";

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

function fixture(name: string): { root: string; project: WriterProject; store: WriterStore; sessionId: string } {
  const root = mkdtempSync(join(tmpdir(), `writer-agent-run-v2-${name}-`));
  const project = WriterProject.init(root, name);
  const store = new WriterStore(project);
  return { root, project, store, sessionId: store.createSession(name) };
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
    controller.recordDocumentEvidence({
      toolName: "propose_document",
      proposalId: 11,
      path: "chapters/01.md",
      recordedAt: "2026-08-02T00:00:00.000Z",
    }, "document-1", "test:first", "pending");
    assert.deepEqual(controller.pendingDocumentLabels(), ["第二章"]);
    assert.equal(controller.complete(twoDocumentTask, []).length, 1);
    controller.recordDocumentEvidence({
      toolName: "propose_document",
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
    assert.equal(controller.snapshot.deliverables[0]?.state, "revision_required");
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
