import type { AgentRunDocumentEvidence } from "./types.js";
import type { ProposalRevisionCase } from "./proposal_retry.js";

export type AgentRunStatus = "running" | "suspended" | "completed" | "failed" | "cancelled";

export type AgentRunDeliverableState = "pending" | "revision_required" | "submitted" | "applied";

export interface AgentRunDeliverableExecutionV2 {
  startedAtStep?: number;
  lastStep?: number;
  usedSteps: number;
  reviewReserveUsed: number;
  gateAttempts: Record<string, number>;
}

export interface AgentRunDeliverableV2 {
  id: string;
  label: string;
  state: AgentRunDeliverableState;
  execution: AgentRunDeliverableExecutionV2;
  evidence?: AgentRunDocumentEvidence & {
    artifactKey: string;
    proposalStatus?: "pending" | "accepted";
  };
  proposalRevision?: ProposalRevisionCase;
}

export interface AgentRunContractRecord {
  evidence: "none" | "project" | "target" | "continuation";
  mutation: "none" | "document" | "character" | "mixed";
  capabilities: string[];
  workflow?: string;
  proseGateRequired?: boolean;
  requiredDocumentState: "submitted" | "applied";
}

export interface AgentRunProgressV2 {
  successfulTools: string[];
  failedTools: Record<string, number>;
  reusableEvidence: boolean;
  characterArtifactProduced: boolean;
  imageArtifactProduced: boolean;
  proseGateRuleSaved: boolean;
  workflowStages: string[];
  gateAttempts: Record<string, number>;
}

export interface AgentRunIntentReviewV2 {
  status: "satisfied" | "unsatisfied" | "unavailable";
  checkedAt: string;
  reason?: string;
  missing?: string;
  nextStep?: string;
}

export interface AgentRunExecutionPlanV2 {
  /** Bounded semantic commitment adopted by the Agent, not raw reasoning text. */
  commitment: string;
  /** Current unfinished portion of that commitment. Local nextStep advice cannot replace it. */
  remaining: string;
  updatedAt: string;
}

export interface AgentRunSnapshotV2 {
  version: 2;
  id: string;
  sessionId: string;
  originalRequest: string;
  sourceMessageId: number;
  contract: AgentRunContractRecord;
  /** Run-scoped chapter destination; retained unchanged across interrupted resumes. */
  volume?: { name: string; autoCreated: boolean };
  deliverables: AgentRunDeliverableV2[];
  progress: AgentRunProgressV2;
  /** Latest review against the immutable originalRequest. Cleared when execution resumes. */
  intentReview?: AgentRunIntentReviewV2;
  /** Durable global plan inferred from explicit Agent commitments and delivery evidence. */
  executionPlan?: AgentRunExecutionPlanV2;
  status: AgentRunStatus;
  step: number;
  terminalReason?: string;
  nextAction?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunToolObservation {
  toolName: string;
  outcome: "success" | "retryable_error" | "interruption" | "fatal_error" | "revision_required";
  message?: string;
  successful: boolean;
  reusableEvidence?: boolean;
  characterArtifactProduced?: boolean;
  imageArtifactProduced?: boolean;
  proseGateRuleSaved?: boolean;
  workflowStages?: string[];
  gate?: string;
}

export type AgentRunEventV2 =
  | {
      type: "run_started";
      at: string;
      sourceMessageId: number;
      originalRequest: string;
      contract: AgentRunContractRecord;
      volume?: { name: string; autoCreated: boolean };
      deliverables: Array<{ id: string; label: string }>;
      reusableEvidence: boolean;
    }
  | { type: "run_resumed"; at: string; sourceMessageId: number }
  /**
   * A document delivery opened on demand. The ledger is never pre-seeded from a
   * planner guess: an entry exists because the agent actually started delivering
   * a document, so `pending` means「开账未落地」rather than「预测数量差额」.
   */
  | { type: "deliverable_opened"; at: string; id: string; label: string }
  | { type: "step_started"; at: string; step: number; deliverableId?: string }
  | { type: "tool_observed"; at: string; observation: AgentRunToolObservation }
  | {
      type: "deliverable_recorded";
      at: string;
      deliverableId?: string;
      evidence: AgentRunDeliverableV2["evidence"];
    }
  | { type: "gate_blocked"; at: string; gate: string; message?: string; deliverableId?: string }
  | { type: "gate_cleared"; at: string; gate: string; deliverableId?: string }
  | {
      type: "deliverable_review_reserve_used";
      at: string;
      deliverableId: string;
      step: number;
      reason: "terminal_review" | "proposal_revision";
    }
  | { type: "proposal_revision_set"; at: string; deliverableId: string; revision: ProposalRevisionCase }
  | { type: "proposal_revision_cleared"; at: string; deliverableId: string }
  | { type: "intent_reviewed"; at: string; review: AgentRunIntentReviewV2 }
  | { type: "execution_plan_updated"; at: string; plan: AgentRunExecutionPlanV2 }
  | { type: "run_suspended"; at: string; reason: string; nextAction: string }
  /** `reason` names which terminal gate fired, so a finished run is explainable. */
  | { type: "run_completed"; at: string; reason?: string }
  | { type: "run_failed"; at: string; reason: string }
  | { type: "run_cancelled"; at: string; reason: string };

export interface PersistedAgentRunEventV2 {
  runId: string;
  sequence: number;
  eventKey: string;
  event: AgentRunEventV2;
}
