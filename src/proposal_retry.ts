export const MAX_PROPOSAL_SUBMISSIONS_PER_REVISION_WINDOW = 3;

export type ProposalFailureDecision =
  | { action: "revise"; attempt: number }
  | { action: "pause"; reason: "dependency" | "invalid_request" | "revision_exhausted"; attempt: number };

/**
 * Deterministic proposal retry policy. Prompt wording may guide a repair, but it
 * never decides whether another submission is allowed.
 */
export function decideProposalFailure(
  result: Record<string, unknown>,
  nextAttempt: number,
): ProposalFailureDecision {
  if (result.failureKind === "dependency") {
    return { action: "pause", reason: "dependency", attempt: nextAttempt };
  }
  if (result.code === "INVALID_TOOL_ARGUMENTS_JSON"
    || result.code === "CONTRACT_MUTATION_DENIED") {
    return { action: "pause", reason: "invalid_request", attempt: nextAttempt };
  }
  if (nextAttempt >= MAX_PROPOSAL_SUBMISSIONS_PER_REVISION_WINDOW) {
    return { action: "pause", reason: "revision_exhausted", attempt: nextAttempt };
  }
  return { action: "revise", attempt: nextAttempt };
}
