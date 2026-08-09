import type {
  AgentRunDeliverableExecutionV2,
  AgentRunDeliverableV2,
  AgentRunEventV2,
  AgentRunSnapshotV2,
} from "./agent_run_types.js";

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function emptyDeliverableExecution(): AgentRunDeliverableExecutionV2 {
  return {
    usedSteps: 0,
    reviewReserveUsed: 0,
    gateAttempts: {},
  };
}

function deliverableExecution(
  deliverable: AgentRunDeliverableV2,
): AgentRunDeliverableExecutionV2 {
  return {
    ...emptyDeliverableExecution(),
    ...(deliverable.execution ?? {}),
    gateAttempts: { ...(deliverable.execution?.gateAttempts ?? {}) },
  };
}

function initialSnapshot(
  id: string,
  sessionId: string,
  event: Extract<AgentRunEventV2, { type: "run_started" }>,
): AgentRunSnapshotV2 {
  return {
    version: 2,
    id,
    sessionId,
    originalRequest: event.originalRequest,
    sourceMessageId: event.sourceMessageId,
    contract: event.contract,
    ...(event.volume ? { volume: event.volume } : {}),
    deliverables: event.deliverables.map(item => ({
      ...item,
      state: "pending",
      execution: emptyDeliverableExecution(),
    })),
    progress: {
      successfulTools: [],
      failedTools: {},
      reusableEvidence: event.reusableEvidence,
      characterArtifactProduced: false,
      imageArtifactProduced: false,
      proseGateRuleSaved: false,
      workflowStages: [],
      gateAttempts: {},
    },
    status: "running",
    step: 0,
    createdAt: event.at,
    updatedAt: event.at,
  };
}

function updateDeliverable(
  snapshot: AgentRunSnapshotV2,
  requestedId: string | undefined,
  update: (deliverable: AgentRunDeliverableV2) => AgentRunDeliverableV2,
): AgentRunDeliverableV2[] {
  const index = requestedId
    ? snapshot.deliverables.findIndex(item => item.id === requestedId)
    : snapshot.deliverables.findIndex(item => !item.evidence);
  if (index < 0) return snapshot.deliverables;
  return snapshot.deliverables.map((item, itemIndex) => itemIndex === index ? update(item) : item);
}

export function reduceAgentRunEvent(
  current: AgentRunSnapshotV2 | undefined,
  event: AgentRunEventV2,
  identity?: { id: string; sessionId: string },
): AgentRunSnapshotV2 {
  if (!current) {
    if (event.type !== "run_started" || !identity) throw new Error("AgentRun 首个事件必须是 run_started");
    return initialSnapshot(identity.id, identity.sessionId, event);
  }
  if (event.type === "run_started") throw new Error("AgentRun 不能重复开始");

  let next: AgentRunSnapshotV2 = { ...current, updatedAt: event.at };
  switch (event.type) {
    case "run_resumed":
      return {
        ...next,
        sourceMessageId: event.sourceMessageId,
        status: "running",
        intentReview: undefined,
        terminalReason: undefined,
        nextAction: undefined,
      };
    case "deliverable_opened":
      return current.deliverables.some(item => item.id === event.id)
        ? next
        : {
            ...next,
            deliverables: [
              ...current.deliverables,
              {
                id: event.id,
                label: event.label,
                state: "pending",
                execution: emptyDeliverableExecution(),
              },
            ],
          };
    case "step_started":
      return {
        ...next,
        intentReview: undefined,
        step: Math.max(current.step, event.step),
        ...(event.deliverableId
          ? {
              deliverables: updateDeliverable(current, event.deliverableId, item => {
                const execution = deliverableExecution(item);
                return {
                  ...item,
                  execution: {
                    ...execution,
                    startedAtStep: execution.startedAtStep ?? event.step,
                    lastStep: event.step,
                    usedSteps: execution.usedSteps + 1,
                  },
                };
              }),
            }
          : {}),
      };
    case "tool_observed": {
      const observation = event.observation;
      const failedTools = { ...current.progress.failedTools };
      let successfulTools = current.progress.successfulTools;
      if (observation.successful) {
        successfulTools = unique([...successfulTools, observation.toolName]);
        delete failedTools[observation.toolName];
      } else {
        failedTools[observation.toolName] = (failedTools[observation.toolName] ?? 0) + 1;
      }
      return {
        ...next,
        progress: {
          ...current.progress,
          successfulTools,
          failedTools,
          reusableEvidence: current.progress.reusableEvidence || observation.reusableEvidence === true,
          characterArtifactProduced: current.progress.characterArtifactProduced || observation.characterArtifactProduced === true,
          imageArtifactProduced: current.progress.imageArtifactProduced || observation.imageArtifactProduced === true,
          proseGateRuleSaved: current.progress.proseGateRuleSaved || observation.proseGateRuleSaved === true,
          workflowStages: unique([...current.progress.workflowStages, ...(observation.workflowStages ?? [])]),
          gateAttempts: current.progress.gateAttempts,
        },
      };
    }
    case "deliverable_recorded": {
      const evidence = event.evidence;
      if (!evidence) return next;
      if (current.deliverables.some(item => item.evidence?.artifactKey === evidence.artifactKey)) return next;
      return {
        ...next,
        deliverables: updateDeliverable(current, event.deliverableId, item => ({
          ...item,
          state: evidence.proposalStatus === "accepted" ? "applied" : "submitted",
          evidence,
          proposalRevision: undefined,
        })),
      };
    }
    case "gate_blocked": {
      const gateAttempts = { ...current.progress.gateAttempts };
      gateAttempts[event.gate] = (gateAttempts[event.gate] ?? 0) + 1;
      return {
        ...next,
        progress: { ...current.progress, gateAttempts },
        deliverables: updateDeliverable(current, event.deliverableId, item => {
          const execution = deliverableExecution(item);
          const deliverableGateAttempts = { ...execution.gateAttempts };
          deliverableGateAttempts[event.gate] = (deliverableGateAttempts[event.gate] ?? 0) + 1;
          return {
            ...item,
            state: "revision_required",
            execution: { ...execution, gateAttempts: deliverableGateAttempts },
          };
        }),
      };
    }
    case "gate_cleared":
      return {
        ...next,
        deliverables: updateDeliverable(current, event.deliverableId, item => (
          item.state === "revision_required" ? { ...item, state: "pending" } : item
        )),
      };
    case "deliverable_review_reserve_used":
      return {
        ...next,
        deliverables: updateDeliverable(current, event.deliverableId, item => {
          const execution = deliverableExecution(item);
          return {
            ...item,
            execution: {
              ...execution,
              lastStep: event.step,
              reviewReserveUsed: execution.reviewReserveUsed + 1,
            },
          };
        }),
      };
    case "proposal_revision_set":
      return {
        ...next,
        deliverables: updateDeliverable(current, event.deliverableId, item => ({
          ...item,
          state: "revision_required",
          proposalRevision: event.revision,
        })),
      };
    case "proposal_revision_cleared":
      return {
        ...next,
        deliverables: updateDeliverable(current, event.deliverableId, item => ({
          ...item,
          proposalRevision: undefined,
          state: item.state === "revision_required" ? "pending" : item.state,
        })),
      };
    case "intent_reviewed":
      return { ...next, intentReview: event.review };
    case "execution_plan_updated":
      return { ...next, executionPlan: event.plan };
    case "run_suspended":
      return { ...next, status: "suspended", terminalReason: event.reason, nextAction: event.nextAction };
    case "run_completed":
      return { ...next, status: "completed", terminalReason: event.reason, nextAction: undefined };
    case "run_failed":
      return { ...next, status: "failed", terminalReason: event.reason, nextAction: undefined };
    case "run_cancelled":
      return { ...next, status: "cancelled", terminalReason: event.reason, nextAction: "resume" };
  }
}

export function completedAgentRunDeliverables(snapshot: AgentRunSnapshotV2): AgentRunDeliverableV2[] {
  return snapshot.deliverables.filter(item => (
    snapshot.contract.requiredDocumentState === "applied"
      ? item.state === "applied"
      : item.state === "submitted" || item.state === "applied"
  ));
}

export function pendingAgentRunDeliverables(snapshot: AgentRunSnapshotV2): AgentRunDeliverableV2[] {
  const completed = new Set(completedAgentRunDeliverables(snapshot).map(item => item.id));
  return snapshot.deliverables.filter(item => !completed.has(item.id));
}
