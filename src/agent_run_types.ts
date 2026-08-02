import type { AgentRunDocumentEvidence } from "./types.js";

export type AgentRunStatus = "running" | "suspended" | "completed" | "failed" | "cancelled";

export type AgentRunDeliverableState = "pending" | "revision_required" | "submitted" | "applied";

export interface AgentRunDeliverableV2 {
  id: string;
  label: string;
  state: AgentRunDeliverableState;
  evidence?: AgentRunDocumentEvidence & {
    artifactKey: string;
    proposalStatus?: "pending" | "accepted";
  };
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

export interface AgentRunSnapshotV2 {
  version: 2;
  id: string;
  sessionId: string;
  originalRequest: string;
  sourceMessageId: number;
  contract: AgentRunContractRecord;
  deliverables: AgentRunDeliverableV2[];
  progress: AgentRunProgressV2;
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
      deliverables: Array<{ id: string; label: string }>;
      reusableEvidence: boolean;
    }
  | { type: "run_resumed"; at: string; sourceMessageId: number }
  | { type: "step_started"; at: string; step: number }
  | { type: "tool_observed"; at: string; observation: AgentRunToolObservation }
  | {
      type: "deliverable_recorded";
      at: string;
      deliverableId?: string;
      evidence: AgentRunDeliverableV2["evidence"];
    }
  | { type: "gate_blocked"; at: string; gate: string; message?: string; deliverableId?: string }
  | { type: "gate_cleared"; at: string; gate: string; deliverableId?: string }
  | { type: "run_suspended"; at: string; reason: string; nextAction: string }
  | { type: "run_completed"; at: string }
  | { type: "run_failed"; at: string; reason: string }
  | { type: "run_cancelled"; at: string; reason: string };

export interface PersistedAgentRunEventV2 {
  runId: string;
  sequence: number;
  eventKey: string;
  event: AgentRunEventV2;
}
