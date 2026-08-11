/** Semantic context cuts understood by the runtime, independent of wire messages. */
export type AgentContextBoundaryKind =
  | "proposal_revision"
  | "chapter_review"
  | "scene"
  | "chapter"
  | "completed_job";

export type AgentContextProjection<T> = {
  kind: AgentContextBoundaryKind;
  messages: T[];
  beforeMessageCount: number;
  afterMessageCount: number;
  droppedMessageCount: number;
};

export type AgentOpenTurnProjection<T> = {
  messages: T[];
  stableMessageCount: number;
  trunkEnd: number;
  replayedMessageCount: number;
  initialMessageCount: number;
};

/** Stable prefix → pinned trunk → replay → current dynamic tail. */
export function projectAgentOpenTurn<T>(input: {
  stablePrefix: readonly T[];
  trunk: T;
  replay: readonly T[];
  currentTurn: readonly T[];
}): AgentOpenTurnProjection<T> {
  const trunkEnd = input.stablePrefix.length + 1;
  const replayedMessageCount = trunkEnd + input.replay.length;
  const messages = [
    ...input.stablePrefix,
    input.trunk,
    ...input.replay,
    ...input.currentTurn,
  ];
  return {
    messages,
    stableMessageCount: input.stablePrefix.length,
    trunkEnd,
    replayedMessageCount,
    initialMessageCount: messages.length,
  };
}

/**
 * Pure boundary projection. Business branches declare what semantic base survives;
 * this function owns the actual transcript cut and can later project from events.
 */
export function projectAgentContextBoundary<T>(
  current: readonly T[],
  input: {
    kind: AgentContextBoundaryKind;
    keepCount: number;
    append?: readonly T[];
  },
): AgentContextProjection<T> {
  if (!Number.isInteger(input.keepCount) || input.keepCount < 0 || input.keepCount > current.length) {
    throw new Error(`Agent context boundary 越界：keep=${input.keepCount}, current=${current.length}`);
  }
  const messages = [
    ...current.slice(0, input.keepCount),
    ...(input.append ?? []),
  ];
  return {
    kind: input.kind,
    messages,
    beforeMessageCount: current.length,
    afterMessageCount: messages.length,
    droppedMessageCount: current.length - input.keepCount,
  };
}
