import { createHash } from "node:crypto";
import type { RepairPacket } from "./repair_packet.js";

/** Compatibility name for the old scalar window; no longer used as a mixed-gate budget. */
export const MAX_PROPOSAL_SUBMISSIONS_PER_REVISION_WINDOW = 3;
export const MAX_REPEATED_SEMANTIC_NO_PROGRESS = 2;
export const MAX_DETERMINISTIC_GATE_ATTEMPTS = 3;
export const MAX_PROPOSAL_SUBMISSIONS_PER_DELIVERABLE = 12;
export const PROPOSAL_REVISION_MISSING_DOCUMENT_HASH = "__missing__";

export type ProposalRetryGate = "style" | "rhythm" | "length" | "semantic_review" | "proposal";

export type ProposalRevisionIssue = {
  id: string;
  severity: string;
  kind: string;
  evidence: string[];
  /** Optional exact, unique source text supplied by the isolated reviewer. */
  oldText?: string;
  problem: string;
  action: string;
  priorIssueId?: string;
  origin?: "unresolved_prior" | "introduced_by_revision" | "pre_existing_unrelated";
};

export type ProposalIssueTransition = {
  previousIssueIds: string[];
  currentIssueIds: string[];
  resolvedIssueIds: string[];
  stillPresentIssueIds: string[];
  newlyIntroducedIssueIds: string[];
};

export type ProposalRetryState = {
  runId: string;
  deliverableId?: string;
  path?: string;
  gateAttempts: Record<ProposalRetryGate, number>;
  semanticNoProgress: number;
  absoluteSubmissions: number;
};

export type ProposalRevisionCase = {
  schemaVersion: 3;
  revisionCaseId: string;
  runId: string;
  deliverableId?: string;
  path?: string;
  /** Project document state when this revision chain was first opened. */
  baseDocumentExists: boolean;
  baseDocumentSourceHash: string;
  /** Latest submitted body, including drafts stopped by deterministic gates. */
  draftArtifactId: number;
  draftSourceHash: string;
  /** Latest body that actually received a semantic verdict. */
  semanticDraftArtifactId?: number;
  semanticDraftSourceHash?: string;
  /** The first-pass rhythm grace was consumed and the hard rhythm gate is still pending. */
  rhythmPolishPending?: true;
  reviewArtifactId: number;
  /** Legacy/display counter. Retry decisions use retryState. */
  attempt: number;
  lastGate: ProposalRetryGate;
  retryState: ProposalRetryState;
  unresolvedIssues: ProposalRevisionIssue[];
  /** Latest deterministic/semantic repair instructions for direct retry or resume. */
  repairPacket?: RepairPacket;
  resolvedIssueIds: string[];
  stillPresentIssueIds: string[];
  newlyIntroducedIssueIds: string[];
  status: "blocked" | "resolved";
  retention: "executable";
};

export type ProposalReviewRevisionContext = {
  runId: string;
  deliverableId?: string;
  path: string;
  previousContent: string;
  previousSourceHash: string;
  unresolvedIssues: ProposalRevisionIssue[];
};

export type ProposalFailureDecision =
  | { action: "revise"; gate: ProposalRetryGate; attempt: number; state: ProposalRetryState }
  | { action: "correct_call"; attempt: number; state: ProposalRetryState }
  | {
      action: "pause";
      reason: "dependency" | "invalid_request" | "revision_exhausted";
      attempt: number;
      state: ProposalRetryState;
      gate?: ProposalRetryGate;
      exhaustion?: "semantic_no_progress" | "gate_attempts" | "absolute_safety";
    };

export function createProposalRetryState(scope: {
  runId: string;
  deliverableId?: string;
  path?: string;
}): ProposalRetryState {
  return {
    runId: scope.runId,
    ...(scope.deliverableId ? { deliverableId: scope.deliverableId } : {}),
    ...(scope.path ? { path: scope.path } : {}),
    gateAttempts: { style: 0, rhythm: 0, length: 0, semantic_review: 0, proposal: 0 },
    semanticNoProgress: 0,
    absoluteSubmissions: 0,
  };
}

export function proposalRevisionScopeKey(input: {
  runId: string;
  deliverableId?: string;
  path?: string;
}): string {
  return JSON.stringify([input.runId, input.deliverableId ?? "", input.path ?? ""]);
}

export function proposalIssueTransition(
  previous: ReadonlyArray<Pick<ProposalRevisionIssue, "id">>,
  current: ReadonlyArray<Pick<ProposalRevisionIssue, "id">>,
): ProposalIssueTransition {
  const previousIssueIds = [...new Set(previous.map(issue => issue.id))];
  const currentIssueIds = [...new Set(current.map(issue => issue.id))];
  const previousIds = new Set(previousIssueIds);
  const currentIds = new Set(currentIssueIds);
  return {
    previousIssueIds,
    currentIssueIds,
    resolvedIssueIds: previousIssueIds.filter(id => !currentIds.has(id)),
    stillPresentIssueIds: currentIssueIds.filter(id => previousIds.has(id)),
    newlyIntroducedIssueIds: currentIssueIds.filter(id => !previousIds.has(id)),
  };
}

export function proposalRevisionIssueId(input: {
  kind: string;
  evidence: readonly string[];
  problem: string;
}): string {
  const identity = JSON.stringify([
    input.kind,
    input.evidence.length
      ? input.evidence.map(item => item.replace(/\s+/g, " ").trim())
      : input.problem.replace(/\s+/g, " ").trim(),
  ]);
  return `issue:${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

/**
 * The direct-document rhythm grace is an expected draft -> polish transition,
 * not a failed semantic review. It must not consume any failure budget.
 */
export function isExpectedRhythmPolish(result: Record<string, unknown>): boolean {
  return result.rhythmRevisionRequired === true || result.code === "RHYTHM_POLISH_REQUIRED";
}

export type ProposalFailureClassification =
  | { kind: "dependency" }
  | { kind: "invalid_request" }
  | { kind: "invalid_output" }
  | { kind: "call_error" }
  | { kind: "gate"; gate: ProposalRetryGate };

export function classifyProposalFailure(result: Record<string, unknown>): ProposalFailureClassification {
  const code = typeof result.code === "string" ? result.code.toUpperCase() : "";
  if (result.failureKind === "dependency") return { kind: "dependency" };
  if (code === "CONTRACT_MUTATION_DENIED"
    || code === "PROPOSAL_REVISION_BASE_CHANGED"
    || code === "PROPOSAL_DOCUMENT_BASE_CHANGED") {
    return { kind: "invalid_request" };
  }
  if (result.failureKind === "invalid_output" || result.failureKind === "validation") {
    return { kind: "invalid_output" };
  }
  if ("error" in result && result.failureKind !== "semantic_revision") return { kind: "call_error" };
  if (result.status === "final_review_revision_required" || code === "DIRECT_CHAPTER_REVIEW_BLOCKED") {
    return { kind: "gate", gate: "semantic_review" };
  }
  if (code.includes("STYLE") || code.includes("CARD_REGISTER") || code.includes("DIALOGUE_FORMAT")) {
    return { kind: "gate", gate: "style" };
  }
  if (code.includes("RHYTHM")) return { kind: "gate", gate: "rhythm" };
  if (code.includes("LENGTH")) return { kind: "gate", gate: "length" };
  return { kind: "gate", gate: "proposal" };
}

export function proposalFailureGate(result: Record<string, unknown>): ProposalRetryGate | undefined {
  const classified = classifyProposalFailure(result);
  return classified.kind === "gate" ? classified.gate : undefined;
}

function copyState(current: ProposalRetryState): ProposalRetryState {
  return {
    ...current,
    gateAttempts: {
      style: current.gateAttempts.style ?? 0,
      rhythm: current.gateAttempts.rhythm ?? 0,
      length: current.gateAttempts.length ?? 0,
      semantic_review: current.gateAttempts.semantic_review ?? 0,
      proposal: current.gateAttempts.proposal ?? 0,
    },
    semanticNoProgress: current.semanticNoProgress ?? 0,
    absoluteSubmissions: current.absoluteSubmissions ?? 0,
  };
}

/** Reset only deterministic gates that this submission necessarily passed. */
export function proposalRetryStateAtGate(
  current: ProposalRetryState,
  reachedGate: ProposalRetryGate,
): ProposalRetryState {
  const next = copyState(current);
  const passed = reachedGate === "style"
    ? ["length"] as const
    : reachedGate === "rhythm"
      ? ["length", "style"] as const
      : reachedGate === "semantic_review" || reachedGate === "proposal"
        ? ["length", "style", "rhythm"] as const
        : [] as const;
  for (const gate of passed) next.gateAttempts[gate] = 0;
  return next;
}

function resultReachedSemanticReview(result: Record<string, unknown>): boolean {
  const code = typeof result.code === "string" ? result.code.toUpperCase() : "";
  return result.status === "final_review_revision_required"
    || result.status === "final_review_unavailable"
    || code.startsWith("DIRECT_CHAPTER_REVIEW_");
}

/**
 * Runtime retry policy. Deterministic gates have independent counters. Semantic
 * review is bounded only when the same blocker survives without any prior
 * blocker being resolved; an absolute per-deliverable rail remains as a final
 * guard against oscillation across otherwise progressing states.
 */
export function decideProposalFailure(
  result: Record<string, unknown>,
  current: ProposalRetryState,
  transition?: ProposalIssueTransition,
): ProposalFailureDecision {
  const classified = classifyProposalFailure(result);
  const unchanged = resultReachedSemanticReview(result)
    ? proposalRetryStateAtGate(current, "semantic_review")
    : copyState(current);
  const currentSemanticAttempt = unchanged.gateAttempts.semantic_review;
  if (classified.kind === "dependency") {
    return { action: "pause", reason: "dependency", attempt: currentSemanticAttempt, state: unchanged };
  }
  if (classified.kind === "invalid_request") {
    return { action: "pause", reason: "invalid_request", attempt: currentSemanticAttempt, state: unchanged };
  }
  // Provider output, argument, validation and project-state failures are not
  // prose verdicts. Preserve the draft and retry/correct without charging a gate.
  if (classified.kind === "call_error") {
    return { action: "correct_call", attempt: currentSemanticAttempt, state: unchanged };
  }
  if (classified.kind === "invalid_output") {
    const next = copyState(unchanged);
    next.absoluteSubmissions += 1;
    if (next.absoluteSubmissions >= MAX_PROPOSAL_SUBMISSIONS_PER_DELIVERABLE) {
      return {
        action: "pause", reason: "revision_exhausted", attempt: currentSemanticAttempt, state: next,
        exhaustion: "absolute_safety",
      };
    }
    return { action: "correct_call", attempt: currentSemanticAttempt, state: next };
  }

  const gate = classified.gate;
  const next = proposalRetryStateAtGate(current, gate);
  next.gateAttempts[gate] += 1;
  next.absoluteSubmissions += 1;
  // Deterministic style/rhythm/length gates can legitimately expose a new
  // blocker after the previous one was repaired. Count a consecutive failure
  // streak only when the issue set makes no progress; otherwise restart the
  // streak at this submission and rely on the absolute rail for oscillation.
  if (gate !== "semantic_review" && transition) {
    const progressed = transition.resolvedIssueIds.length > 0
      || transition.previousIssueIds.length === 0
      || transition.currentIssueIds.length < transition.previousIssueIds.length;
    if (progressed) next.gateAttempts[gate] = 1;
  }
  if (gate === "semantic_review") {
    const hadPriorBlockers = Boolean(transition?.previousIssueIds.length);
    const resolvedPriorBlocker = Boolean(transition?.resolvedIssueIds.length);
    const retainedPriorBlocker = Boolean(transition?.stillPresentIssueIds.length);
    next.semanticNoProgress = hadPriorBlockers && retainedPriorBlocker && !resolvedPriorBlocker
      ? current.semanticNoProgress + 1
      : 0;
  }

  const attempt = next.gateAttempts[gate];
  if (next.absoluteSubmissions >= MAX_PROPOSAL_SUBMISSIONS_PER_DELIVERABLE) {
    return {
      action: "pause", reason: "revision_exhausted", gate, attempt, state: next,
      exhaustion: "absolute_safety",
    };
  }
  if (gate === "semantic_review" && next.semanticNoProgress >= MAX_REPEATED_SEMANTIC_NO_PROGRESS) {
    return {
      action: "pause", reason: "revision_exhausted", gate, attempt, state: next,
      exhaustion: "semantic_no_progress",
    };
  }
  if (gate !== "semantic_review" && next.gateAttempts[gate] >= MAX_DETERMINISTIC_GATE_ATTEMPTS) {
    return {
      action: "pause", reason: "revision_exhausted", gate, attempt, state: next,
      exhaustion: "gate_attempts",
    };
  }
  return { action: "revise", gate, attempt, state: next };
}
