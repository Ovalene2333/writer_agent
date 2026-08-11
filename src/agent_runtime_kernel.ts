import type { AgentRunToolObservation } from "./agent_run_types.js";
import { runFulfillmentPauseReason, type RunFulfillmentVerdict } from "./run_completion.js";

/** Common result language for every runtime gate. */
export type AgentGateDecision =
  | { kind: "pass" }
  | { kind: "repair"; gate: string; instruction: string }
  | { kind: "retry_dependency"; reason: string }
  | { kind: "ask_user"; question: string }
  | { kind: "pause"; reason: string };

/**
 * A declaration of the next orchestration effect. The kernel never performs the
 * effect itself, which keeps its decisions replayable and independently testable.
 */
export type AgentRuntimeCommand =
  | { kind: "request_fulfillment_review" }
  | { kind: "continue_execution"; source: "invariant" | "fulfillment"; prompt: string }
  | { kind: "complete_run"; reason: string }
  | { kind: "suspend_run"; reason: string; nextAction: "resume" };

export type FulfillmentReviewFact =
  | { kind: "verdict"; verdict: RunFulfillmentVerdict; continuationPrompt?: string; stagnated?: boolean }
  | { kind: "unavailable"; reason: string };

/** Pure terminal decision: invariants first, semantic fulfillment second. */
export function decideAgentRuntimeCommand(input: {
  invariantGaps: readonly string[];
  invariantRecoveryPrompt: string;
  fulfillment?: FulfillmentReviewFact;
}): AgentRuntimeCommand {
  if (input.invariantGaps.length) {
    return {
      kind: "continue_execution",
      source: "invariant",
      prompt: input.invariantRecoveryPrompt,
    };
  }
  if (!input.fulfillment) return { kind: "request_fulfillment_review" };
  if (input.fulfillment.kind === "unavailable") {
    return {
      kind: "suspend_run",
      reason: input.fulfillment.reason,
      nextAction: "resume",
    };
  }
  const verdict = input.fulfillment.verdict;
  if (verdict.satisfied) return { kind: "complete_run", reason: verdict.reason };
  if (input.fulfillment.stagnated) {
    return {
      kind: "suspend_run",
      reason: runFulfillmentPauseReason(verdict),
      nextAction: "resume",
    };
  }
  return {
    kind: "continue_execution",
    source: "fulfillment",
    prompt: input.fulfillment.continuationPrompt
      ?? `继续完成尚未交付的内容：${verdict.nextStep}`,
  };
}

/** Convert tool facts into the same gate protocol used by reviews and dependencies. */
export function gateDecisionForToolObservation(
  observation: AgentRunToolObservation,
  waitingForUser = false,
): AgentGateDecision {
  if (waitingForUser) {
    return { kind: "ask_user", question: observation.message || "需要用户提供信息后继续。" };
  }
  if (observation.outcome === "revision_required") {
    return {
      kind: "repair",
      gate: observation.gate ?? "tool_review",
      instruction: observation.message || "按审查结果做定向修复后重新提交。",
    };
  }
  if (observation.outcome === "interruption") {
    return { kind: "retry_dependency", reason: observation.message || "外部依赖暂时不可用。" };
  }
  if (observation.outcome === "fatal_error") {
    return { kind: "pause", reason: observation.message || "工具执行发生不可恢复错误。" };
  }
  return { kind: "pass" };
}
