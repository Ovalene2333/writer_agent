import type { AgentLoopRuntime } from "./agent_loop.js";
import type { AgentRunContextBoundary, AgentRunPhase } from "./agent_run_types.js";

/**
 * Durable effect lifecycle for the imperative host. This is the migration seam:
 * `runAgent` may still execute legacy branches, but every external effect crosses
 * one journal and therefore has a replayable phase/pending-effect boundary.
 */
export class AgentEffectJournal {
  constructor(
    private readonly loop: AgentLoopRuntime,
    private readonly sourceMessageId: number,
  ) {}

  ready(label = "ready"): void {
    this.loop.recordPhase("ready", this.key(label));
  }

  beginModel(step: number): void {
    this.loop.recordPhase("awaiting_model", this.key(`step:${step}:model`), {
      kind: "model",
      effectId: `agent-step:${this.sourceMessageId}:${step}`,
      step,
    });
  }

  finishModel(step: number, hasTools: boolean): void {
    this.loop.recordPhase(
      hasTools ? "executing_tools" : "ready",
      this.key(`step:${step}:model-result`),
      hasTools
        ? { kind: "tools", effectId: `tool-batch:${this.sourceMessageId}:${step}`, step }
        : undefined,
    );
  }

  finishTools(step: number, phase: Extract<AgentRunPhase, "ready" | "repairing" | "awaiting_user">): void {
    this.loop.recordPhase(phase, this.key(`step:${step}:tools-complete`));
  }

  beginFulfillmentReview(effectId: string): void {
    this.loop.recordPhase("reviewing", `${effectId}:phase`, {
      kind: "fulfillment_review",
      effectId,
    });
  }

  finishFulfillmentReview(effectId: string, phase: Extract<AgentRunPhase, "ready" | "awaiting_user">, label: string): void {
    this.loop.recordPhase(phase, `${effectId}:phase:${label}`);
  }

  contextBoundary(boundary: AgentRunContextBoundary, sequence: number): void {
    this.loop.recordContextBoundary(
      boundary,
      this.key(`context-boundary:${sequence}:${boundary.kind}`),
    );
  }

  private key(suffix: string): string {
    return `runtime:${this.sourceMessageId}:${suffix}`;
  }
}

export type ObservedToolEffectResult = {
  /** Complete result consumed by reducers/gates before any model-facing bound. */
  controlResult: string;
  modelResult: string;
  parsedModelResult?: Record<string, unknown>;
};

/** Execute → durably observe complete facts → bound for the model, in that order. */
export async function executeObservedToolEffect(input: {
  execute: () => Promise<string> | string;
  observe: (controlResult: string) => void;
  bound: (controlResult: string) => string;
}): Promise<ObservedToolEffectResult> {
  const controlResult = await input.execute();
  input.observe(controlResult);
  const modelResult = input.bound(controlResult);
  let parsedModelResult: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(modelResult) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsedModelResult = parsed as Record<string, unknown>;
    }
  } catch { /* malformed tool output remains an observed, unverifiable fact */ }
  return {
    controlResult,
    modelResult,
    ...(parsedModelResult ? { parsedModelResult } : {}),
  };
}
