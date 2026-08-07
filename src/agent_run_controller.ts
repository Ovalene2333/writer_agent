import type { WriterStore } from "./store.js";
import {
  agentCompletionGaps,
  alternateMutationArtifactSatisfies,
  type AgentExecutionProgress,
  type AgentTaskContract,
} from "./agentic_runtime.js";
import { interpretAgentToolResult, type InterpretedAgentToolResult } from "./agent_tool_outcome.js";
import { assertAgentRunInvariants } from "./agent_run_invariants.js";
import {
  completedAgentRunDeliverables,
  pendingAgentRunDeliverables,
} from "./agent_run_reducer.js";
import { AgentRunStore } from "./agent_run_store.js";
import type {
  AgentRunDeliverableV2,
  AgentRunContractRecord,
  AgentRunSnapshotV2,
} from "./agent_run_types.js";
import type { AgentRunDocumentEvidence, AgentRunState, AgentTodoItem, PermissionMode } from "./types.js";
import type { WritingWorkflowStage } from "./writing_workflow.js";
import type { ProposalRevisionCase } from "./proposal_retry.js";

function now(): string {
  return new Date().toISOString();
}

function contractRecord(task: AgentTaskContract, permissionMode: PermissionMode): AgentRunContractRecord {
  return {
    evidence: task.evidence,
    mutation: task.mutation,
    capabilities: [...task.capabilities],
    ...(task.workflow ? { workflow: task.workflow } : {}),
    ...(task.proseGateRequired ? { proseGateRequired: true } : {}),
    requiredDocumentState: permissionMode === "auto" ? "applied" : "submitted",
  };
}

function artifactKey(evidence: AgentRunDocumentEvidence): string | undefined {
  if (evidence.proposalId !== undefined) return `proposal:${evidence.proposalId}`;
  if (evidence.changeSetId !== undefined) return `change-set:${evidence.changeSetId}`;
  return undefined;
}

export class AgentRunController {
  private snapshotValue: AgentRunSnapshotV2;

  private constructor(
    private readonly store: WriterStore,
    private readonly runStore: AgentRunStore,
    snapshot: AgentRunSnapshotV2,
  ) {
    this.snapshotValue = snapshot;
  }

  static open(input: {
    store: WriterStore;
    sessionId: string;
    sourceMessageId: number;
    originalRequest: string;
    task: AgentTaskContract;
    permissionMode: PermissionMode;
    reusableEvidence: boolean;
    resumeInterrupted: boolean;
    legacyState?: AgentRunState;
  }): AgentRunController {
    const runStore = new AgentRunStore(input.store);
    const previous = input.resumeInterrupted
      ? runStore.resumableForSession(input.sessionId, input.originalRequest)
      : undefined;
    let snapshot: AgentRunSnapshotV2;
    if (previous && previous.originalRequest === input.originalRequest && previous.status !== "completed") {
      snapshot = runStore.append(previous.id, `resume:${input.sourceMessageId}`, {
        type: "run_resumed",
        at: now(),
        sourceMessageId: input.sourceMessageId,
      });
    } else {
      const documentDeliverableLabels = input.task.documentDeliverables?.length
        ? input.task.documentDeliverables
        : input.task.mutation === "document" || input.task.mutation === "mixed"
          ? ["文件交付"]
          : [];
      snapshot = runStore.start({
        sessionId: input.sessionId,
        sourceMessageId: input.sourceMessageId,
        originalRequest: input.originalRequest,
        contract: contractRecord(input.task, input.permissionMode),
        deliverables: documentDeliverableLabels.map((label, index) => ({
          id: `document-${index + 1}`,
          label,
        })),
        reusableEvidence: input.reusableEvidence,
      });
    }
    const controller = new AgentRunController(input.store, runStore, snapshot);
    if (!previous && input.resumeInterrupted && input.legacyState?.originalRequest === input.originalRequest) {
      for (const item of input.legacyState.documentObligations) {
        if (!item.evidence) continue;
        controller.recordDocumentEvidence(item.evidence, item.id, `legacy:${item.id}`);
      }
    }
    if (input.resumeInterrupted) controller.reconcilePersistedProposals();
    input.store.clearAgentRunState(input.sessionId);
    return controller;
  }

  get snapshot(): AgentRunSnapshotV2 {
    return this.snapshotValue;
  }

  get runId(): string {
    return this.snapshotValue.id;
  }

  get deliverables(): AgentRunSnapshotV2["deliverables"] {
    return this.snapshotValue.deliverables;
  }

  get completedDocumentDeliverables(): number {
    return completedAgentRunDeliverables(this.snapshotValue).length;
  }

  pendingDocumentLabels(): string[] {
    return pendingAgentRunDeliverables(this.snapshotValue).map(item => item.label);
  }

  activeDocumentDeliverable(): AgentRunDeliverableV2 | undefined {
    const pending = pendingAgentRunDeliverables(this.snapshotValue);
    return pending.find(item => Boolean(item.proposalRevision))
      ?? pending.find(item => item.state === "revision_required")
      ?? pending[0];
  }

  proposalDeliverableId(requestedId?: string): string | undefined {
    if (requestedId) {
      return this.snapshotValue.deliverables.some(item => item.id === requestedId)
        ? requestedId
        : undefined;
    }
    return this.snapshotValue.deliverables.find(item => !item.evidence)?.id;
  }

  proposalRevision(deliverableId: string | undefined): ProposalRevisionCase | undefined {
    if (!deliverableId) return undefined;
    return this.snapshotValue.deliverables.find(item => item.id === deliverableId)?.proposalRevision;
  }

  setProposalRevision(
    deliverableId: string,
    revision: ProposalRevisionCase,
    eventKey: string,
  ): void {
    if (revision.runId !== this.runId || revision.deliverableId !== deliverableId
      || revision.retryState.runId !== revision.runId
      || revision.retryState.deliverableId !== revision.deliverableId
      || revision.retryState.path !== revision.path) {
      throw new Error("提案修订状态与当前 AgentRun 交付项不匹配");
    }
    const pathOwner = revision.path
      ? this.snapshotValue.deliverables.find(item => item.id !== deliverableId
        && item.proposalRevision?.status === "blocked"
        && item.proposalRevision.path === revision.path)
      : undefined;
    if (pathOwner) {
      throw new Error(`提案修订路径 ${revision.path} 已绑定交付项 ${pathOwner.id}`);
    }
    this.append(eventKey, {
      type: "proposal_revision_set",
      at: now(),
      deliverableId,
      revision,
    });
  }

  clearProposalRevision(deliverableId: string, eventKey: string): void {
    if (!this.proposalRevision(deliverableId)) return;
    this.append(eventKey, { type: "proposal_revision_cleared", at: now(), deliverableId });
  }

  recordStep(step: number, deliverableId = this.activeDocumentDeliverable()?.id): void {
    this.append(`step:${this.snapshotValue.sourceMessageId}:${step}`, {
      type: "step_started",
      at: now(),
      step,
      ...(deliverableId ? { deliverableId } : {}),
    });
  }

  useDeliverableReviewReserve(
    deliverableId: string,
    step: number,
    reason: "terminal_review" | "proposal_revision",
    eventKey: string,
  ): void {
    this.append(eventKey, {
      type: "deliverable_review_reserve_used",
      at: now(),
      deliverableId,
      step,
      reason,
    });
  }

  observeTool(
    toolName: string,
    rawResult: string,
    eventKey: string,
    deliverableId?: string,
  ): InterpretedAgentToolResult {
    const interpreted = interpretAgentToolResult(toolName, rawResult);
    this.append(`${eventKey}:outcome`, {
      type: "tool_observed",
      at: now(),
      observation: interpreted.observation,
    });
    if (interpreted.observation.outcome === "revision_required" && interpreted.observation.gate) {
      this.append(`${eventKey}:gate:${interpreted.observation.gate}`, {
        type: "gate_blocked",
        at: now(),
        gate: interpreted.observation.gate,
        ...(interpreted.observation.message ? { message: interpreted.observation.message } : {}),
        ...(deliverableId ? { deliverableId } : {}),
      });
    }
    if (interpreted.document) {
      const proposal = interpreted.document.proposalId !== undefined
        ? (() => {
            try { return this.store.proposal(interpreted.document!.proposalId!); } catch { return undefined; }
          })()
        : undefined;
      if (!proposal || proposal.deliveryReady) {
        this.recordDocumentEvidence({
          toolName,
          ...(interpreted.document.proposalId !== undefined ? { proposalId: interpreted.document.proposalId } : {}),
          ...(interpreted.document.changeSetId !== undefined ? { changeSetId: interpreted.document.changeSetId } : {}),
          ...(interpreted.document.path ? { path: interpreted.document.path } : proposal?.path ? { path: proposal.path } : {}),
          recordedAt: now(),
        }, deliverableId ?? interpreted.document.deliverableId, `${eventKey}:deliverable`, interpreted.document.proposalStatus ?? proposal?.status);
      }
    }
    return interpreted;
  }

  recordDocumentEvidence(
    evidence: AgentRunDocumentEvidence,
    deliverableId: string | undefined,
    eventKey: string,
    status?: string,
  ): void {
    const key = artifactKey(evidence);
    if (!key) return;
    let resolvedDeliverableId = deliverableId;
    if (!resolvedDeliverableId && this.snapshotValue.deliverables.length) {
      resolvedDeliverableId = this.snapshotValue.deliverables.find(item => {
        if (item.evidence) return false;
        if (!item.proposalRevision) return true;
        return Boolean(evidence.path && item.proposalRevision.path === evidence.path);
      })?.id;
      if (!resolvedDeliverableId) return;
    }
    const target = resolvedDeliverableId
      ? this.snapshotValue.deliverables.find(item => item.id === resolvedDeliverableId)
      : undefined;
    if (target?.proposalRevision
      && (!evidence.path || target.proposalRevision.path !== evidence.path)) return;
    const proposalStatus = status === "accepted" ? "accepted" as const : "pending" as const;
    this.append(eventKey, {
      type: "deliverable_recorded",
      at: now(),
      ...(resolvedDeliverableId ? { deliverableId: resolvedDeliverableId } : {}),
      evidence: { ...evidence, artifactKey: key, proposalStatus },
    });
  }

  executionProgress(): AgentExecutionProgress {
    const progress = this.snapshotValue.progress;
    const documentArtifactKeys = new Set(
      this.snapshotValue.deliverables.flatMap(item => item.evidence?.artifactKey ? [item.evidence.artifactKey] : []),
    );
    return {
      successfulTools: new Set(progress.successfulTools),
      failedTools: new Map(Object.entries(progress.failedTools)),
      reusableEvidence: progress.reusableEvidence,
      documentArtifactProduced: documentArtifactKeys.size > 0,
      documentArtifactKeys,
      characterArtifactProduced: progress.characterArtifactProduced,
      imageArtifactProduced: progress.imageArtifactProduced,
      proseGateRuleSaved: progress.proseGateRuleSaved,
      workflowStages: new Set(progress.workflowStages as WritingWorkflowStage[]),
    };
  }

  completionGaps(task: AgentTaskContract, todos: AgentTodoItem[]): string[] {
    const progress = this.executionProgress();
    const gaps = agentCompletionGaps(task, progress, todos);
    const pending = pendingAgentRunDeliverables(this.snapshotValue);
    // When a document-hint task is actually completed via character mutation (or the
    // reverse), do not re-open pending document deliverables that the compiler pre-seeded.
    if (
      pending.length
      && !alternateMutationArtifactSatisfies(task, progress)
      && !gaps.some(gap => gap.includes("文件交付") || gap.includes("文档交付") || gap.includes("文档提案"))
    ) {
      gaps.push(`文档交付尚未达到所需状态：${pending.map(item => item.label).join("、")}`);
    }
    return gaps;
  }

  complete(task: AgentTaskContract, todos: AgentTodoItem[]): string[] {
    const gaps = this.completionGaps(task, todos);
    if (gaps.length) return gaps;
    this.append("terminal:completed", { type: "run_completed", at: now() });
    assertAgentRunInvariants(this.snapshotValue);
    return [];
  }

  suspend(reason: string, nextAction = "resume"): void {
    this.append(`terminal:suspended:${this.snapshotValue.sourceMessageId}:${this.snapshotValue.step}:${reason}`, {
      type: "run_suspended",
      at: now(),
      reason,
      nextAction,
    });
  }

  cancel(reason: string): void {
    this.append(`terminal:cancelled:${this.snapshotValue.sourceMessageId}`, { type: "run_cancelled", at: now(), reason });
  }

  fail(reason: string): void {
    this.append(`terminal:failed:${this.snapshotValue.sourceMessageId}`, { type: "run_failed", at: now(), reason });
  }

  private reconcilePersistedProposals(): void {
    const sourceMessageIds = new Set(this.runStore.events(this.runId).flatMap(item => (
      item.event.type === "run_started" || item.event.type === "run_resumed"
        ? [item.event.sourceMessageId]
        : []
    )));
    const candidates = this.store.proposalsForSession(this.snapshotValue.sessionId)
      .filter(item => item.sourceMessageId !== undefined && sourceMessageIds.has(item.sourceMessageId))
      .filter(item => item.deliveryReady && (item.status === "pending" || item.status === "accepted"))
      .sort((left, right) => left.id - right.id);
    for (const candidate of candidates) {
      const proposal = this.snapshotValue.contract.requiredDocumentState === "applied" && candidate.status === "pending"
        ? (() => {
            try { return this.store.acceptProposal(candidate.id); } catch { return candidate; }
          })()
        : candidate;
      this.recordDocumentEvidence({
        toolName: "reconcile_proposal",
        proposalId: proposal.id,
        path: proposal.path,
        recordedAt: now(),
      }, undefined, `reconcile:proposal:${proposal.id}`, proposal.status);
    }
    for (const candidate of this.store.changeSetsForSession(this.snapshotValue.sessionId)
      .filter(item => item.sourceMessageId !== undefined && sourceMessageIds.has(item.sourceMessageId))
      .filter(item => item.status === "pending" || item.status === "accepted")) {
      const changeSet = this.snapshotValue.contract.requiredDocumentState === "applied" && candidate.status === "pending"
        ? (() => {
            try { return this.store.acceptChangeSet(candidate.id); } catch { return candidate; }
          })()
        : candidate;
      this.recordDocumentEvidence({
        toolName: "reconcile_change_set",
        changeSetId: changeSet.id,
        recordedAt: now(),
      }, undefined, `reconcile:change-set:${changeSet.id}`, changeSet.status);
    }
  }

  private append(eventKey: string, event: Parameters<AgentRunStore["append"]>[2]): void {
    this.snapshotValue = this.runStore.append(this.runId, eventKey, event);
  }
}
