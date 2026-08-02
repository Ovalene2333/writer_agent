export const MAX_PROPOSAL_SUBMISSIONS_PER_REVISION_WINDOW = 3;

export type ProposalFailureDecision =
  | { action: "revise"; attempt: number }
  | { action: "correct_call"; attempt: number }
  | { action: "pause"; reason: "dependency" | "invalid_request" | "revision_exhausted"; attempt: number };

/**
 * The direct-document rhythm grace is an expected draft -> polish transition,
 * not a failed semantic review. It must not consume the bounded failure window.
 */
export function isExpectedRhythmPolish(result: Record<string, unknown>): boolean {
  return result.rhythmRevisionRequired === true || result.code === "RHYTHM_POLISH_REQUIRED";
}

/**
 * Deterministic proposal retry policy. Prompt wording may guide a repair, but it
 * never decides whether another submission is allowed.
 */
export function decideProposalFailure(
  result: Record<string, unknown>,
  currentAttempt: number,
): ProposalFailureDecision {
  if (result.failureKind === "dependency") {
    return { action: "pause", reason: "dependency", attempt: currentAttempt };
  }
  if (result.code === "CONTRACT_MUTATION_DENIED") {
    return { action: "pause", reason: "invalid_request", attempt: currentAttempt };
  }
  // Tool selection, arguments and recoverable project-state errors are not
  // prose review verdicts. Let the Agent correct the call without spending the
  // bounded semantic revision window.
  if ("error" in result && result.failureKind !== "semantic_revision") {
    return { action: "correct_call", attempt: currentAttempt };
  }
  const nextAttempt = currentAttempt + 1;
  if (nextAttempt >= MAX_PROPOSAL_SUBMISSIONS_PER_REVISION_WINDOW) {
    return { action: "pause", reason: "revision_exhausted", attempt: nextAttempt };
  }
  return { action: "revise", attempt: nextAttempt };
}
