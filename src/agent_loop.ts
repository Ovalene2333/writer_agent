import type { WriterStore } from "./store.js";
import { AgentRunController } from "./agent_run_controller.js";
import type { AgentExecutionProgress, AgentTaskContract } from "./agentic_runtime.js";
import type { InterpretedAgentToolResult } from "./agent_tool_outcome.js";
import type { AgentRunState, PermissionMode } from "./types.js";
import type { ProposalRevisionCase } from "./proposal_retry.js";
import type {
  AgentRunExecutionPlanV2,
  AgentRunIntentReviewV2,
  AgentRunPendingEffect,
  AgentRunPhase,
  AgentRunContextBoundary,
  AgentRunGateState,
} from "./agent_run_types.js";

/**
 * Thin host loop facade. Model transcript/cache code stays outside; all durable
 * workflow decisions cross this boundary and are appended to AgentRun v2.
 */
export class AgentLoopRuntime {
  private constructor(
    private readonly store: WriterStore,
    private readonly task: AgentTaskContract,
    private readonly controller: AgentRunController,
  ) {}

  static open(input: {
    store: WriterStore;
    sessionId: string;
    sourceMessageId: number;
    originalRequest: string;
    task: AgentTaskContract;
    volume?: { name: string; autoCreated: boolean };
    permissionMode: PermissionMode;
    reusableEvidence: boolean;
    resumeInterrupted: boolean;
    legacyState?: AgentRunState;
  }): AgentLoopRuntime {
    return new AgentLoopRuntime(
      input.store,
      input.task,
      AgentRunController.open(input),
    );
  }

  get snapshot() {
    return this.controller.snapshot;
  }

  get deliverables() {
    return this.controller.deliverables;
  }

  get completedDocumentDeliverables(): number {
    return this.controller.completedDocumentDeliverables;
  }

  pendingDocumentLabels(): string[] {
    return this.controller.pendingDocumentLabels();
  }

  stalledDeliverableLabels(): string[] {
    return this.controller.stalledDeliverableLabels();
  }

  recordIntentReview(
    review: Omit<AgentRunIntentReviewV2, "checkedAt">,
    eventKey: string,
  ): void {
    this.controller.recordIntentReview(review, eventKey);
  }

  recordExecutionPlan(
    plan: Omit<AgentRunExecutionPlanV2, "updatedAt">,
    eventKey: string,
  ): void {
    this.controller.recordExecutionPlan(plan, eventKey);
  }

  activeDocumentDeliverable() {
    return this.controller.activeDocumentDeliverable();
  }

  ensureDocumentDeliverable(label?: string): string {
    return this.controller.ensureDocumentDeliverable(label);
  }

  proposalDeliverableId(requestedId?: string): string | undefined {
    return this.controller.proposalDeliverableId(requestedId);
  }

  proposalRevision(deliverableId: string | undefined): ProposalRevisionCase | undefined {
    return this.controller.proposalRevision(deliverableId);
  }

  setProposalRevision(deliverableId: string, revision: ProposalRevisionCase, eventKey: string): void {
    this.controller.setProposalRevision(deliverableId, revision, eventKey);
  }

  clearProposalRevision(deliverableId: string, eventKey: string): void {
    this.controller.clearProposalRevision(deliverableId, eventKey);
  }

  recordStep(step: number, deliverableId?: string): void {
    this.controller.recordStep(step, deliverableId);
  }

  recordPhase(
    phase: AgentRunPhase,
    eventKey: string,
    pendingEffect?: AgentRunPendingEffect,
  ): void {
    this.controller.recordPhase(phase, eventKey, pendingEffect);
  }

  recordContextBoundary(boundary: AgentRunContextBoundary, eventKey: string): void {
    this.controller.recordContextBoundary(boundary, eventKey);
  }

  recordDiagnostic(code: string, message: string, eventKey: string): void {
    this.controller.recordDiagnostic(code, message, eventKey);
  }

  recordRuntimeGate(input: {
    decision: AgentRunGateState["decision"];
    source: string;
    reason: string;
    gate?: string;
    deliverableId?: string;
  }, eventKey: string): void {
    this.controller.recordRuntimeGate(input, eventKey);
  }

  clearRuntimeGate(source: string, eventKey: string): void {
    this.controller.clearRuntimeGate(source, eventKey);
  }

  useDeliverableReviewReserve(
    deliverableId: string,
    step: number,
    reason: "terminal_review" | "proposal_revision",
    eventKey: string,
  ): void {
    this.controller.useDeliverableReviewReserve(deliverableId, step, reason, eventKey);
  }

  observeTool(
    toolName: string,
    rawResult: string,
    eventKey: string,
    deliverableId?: string,
  ): InterpretedAgentToolResult {
    return this.controller.observeTool(toolName, rawResult, eventKey, deliverableId);
  }

  executionProgress(): AgentExecutionProgress {
    return this.controller.executionProgress();
  }

  completionGaps(): string[] {
    return this.controller.completionGaps(this.task);
  }

  terminate(
    state: "interrupted" | "completed" | "failed" | "cancelled",
    reason?: string,
  ): void {
    if (state === "completed") {
      const gaps = this.controller.complete(this.task, reason ?? "契约不变量已满足");
      if (gaps.length) throw new Error(`AgentRun 完成检查未通过：${gaps.join("；")}`);
      return;
    }
    if (state === "interrupted") {
      this.controller.suspend(reason ?? "运行已暂停", "resume");
      return;
    }
    if (state === "cancelled") {
      this.controller.cancel(reason ?? "用户取消或请求中止");
      return;
    }
    this.controller.fail(reason ?? "运行异常结束");
  }
}
