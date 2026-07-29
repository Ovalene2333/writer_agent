import type { AgentTurnMessage } from "./types.js";
import type { WriterStore } from "./store.js";
import { messageContentText } from "./model_compat.js";

/**
 * Cross-turn context replay (Codex / Claude Code shape).
 *
 * Before this module every turn rebuilt the request from zero: stable system
 * prefix + a freshly rendered dynamic tail + an empty transcript. The previous
 * turn's tool calls and results were thrown away, so a follow-up like「再改一下这段」
 * paid to read the same document again *and* generated brand-new bytes that could
 * never cache-hit.
 *
 * Now each finished turn is frozen byte-verbatim into `agent_turn_blocks` and
 * replayed ahead of the live turn, so the only new bytes in turn N are turn N's
 * own context block. Two rules make this work, both load-bearing:
 *
 *  - REPLAY IS VERBATIM. Never lean-ify a block on the way out; the replayed
 *    bytes must equal the bytes the provider already saw, or the common prefix
 *    ends right there. Shrinking happens once, at the budget boundary, and the
 *    shrunk form is written back so it becomes the new stable prefix.
 *  - NO `system` AFTER assistant/tool. DeepSeek re-renders the whole request
 *    under a different template when history contains a trailing system message
 *    (contract §4, measured twice). That is why `mergedTurnContext` folds the
 *    eight dynamic system slots into one `user` message from turn 2 onward, and
 *    why `freezeTurnBlock` drops system messages defensively.
 */

export type ReplayCompactor = (
  messages: AgentTurnMessage[],
  options?: { keepRecent?: number; force?: boolean },
) => void;

export type ReplayLoadResult = {
  /** Frozen turns to splice in directly after the stable system prefix. */
  messages: AgentTurnMessage[];
  /** True when the chain was compacted and written back on this load. */
  compacted: boolean;
  /** Whole turns dropped from the head because compaction was not enough. */
  droppedTurns: number;
  /** Turns replayed ahead of this turn's live block. */
  replayedTurns: number;
  estimatedTokens: number;
};

/** The newest frozen turn is never compacted: its tool bodies are still the live context. */
const KEEP_WARM_TURNS = 1;

/**
 * Shrink past the high-water mark down to this fraction of it.
 *
 * Without hysteresis the chain settles just under the budget and the very next
 * turn pushes it over again, so *every* turn rewrites bytes the provider has
 * already cached. Overshooting downwards buys many quiet turns per rewrite.
 */
const DEFAULT_LOW_WATER_RATIO = 0.6;

type ReplayStore = Pick<WriterStore, "agentTurnBlocks" | "replaceAgentTurnBlocks">;

/** Same 4-bytes-per-token approximation the request component waterfall uses. */
export function approximateMessageTokens(messages: readonly AgentTurnMessage[]): number {
  let bytes = 0;
  for (const message of messages) bytes += Buffer.byteLength(JSON.stringify(message), "utf8");
  return Math.ceil(bytes / 4);
}

/**
 * Produce the frozen form of the turn that just finished: everything from `from`
 * to the end of the live message array, minus the two things that make a request
 * illegal on replay.
 *
 * Both cleanups are deliberately no-ops on a healthy turn — every tool call has
 * its result and no system message follows the transcript — so the stored bytes
 * equal the bytes the provider already saw. They only fire on an aborted turn,
 * whose tail is malformed anyway. `reasoning_content` is kept verbatim for the
 * same reason: the live loop already replays it between steps of one job, so it
 * is part of the prefix the provider has cached; stripping it here would move
 * the divergence point to the first assistant turn.
 *
 * Leading system messages ARE kept: turn 1 replays as the head of the chain,
 * where its eight dynamic system slots still sit contiguous with the stable
 * prefix and no assistant/tool turn precedes them.
 */
export function freezeTurnBlock(messages: readonly AgentTurnMessage[], from: number): AgentTurnMessage[] {
  const slice = messages.slice(Math.max(0, from)).map(message => ({ ...message }));
  const answered = new Set(slice.flatMap(message => message.role === "tool" && message.tool_call_id ? [message.tool_call_id] : []));
  const kept: AgentTurnMessage[] = [];
  let transcriptStarted = false;
  for (const message of slice) {
    if (message.role === "assistant" || message.role === "tool") transcriptStarted = true;
    // A system message after assistant/tool flips DeepSeek's whole-request
    // rendering and forfeits the cached prefix (contract §4).
    if (message.role === "system") {
      if (transcriptStarted) continue;
      kept.push(message);
      continue;
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) continue;
      kept.push(message);
      continue;
    }
    // A dangling tool_call (no matching result) makes the provider reject the request.
    if (message.role === "assistant" && message.tool_calls) {
      const calls = message.tool_calls.filter(call => answered.has(call.id));
      if (!calls.length) {
        if (!messageContentText(message.content).trim()) continue;
        delete message.tool_calls;
        kept.push(message);
        continue;
      }
      if (calls.length !== message.tool_calls.length) message.tool_calls = calls;
      kept.push(message);
      continue;
    }
    kept.push(message);
  }
  // Orphan tool results (their call was dropped above) would also be rejected.
  const liveCalls = new Set(kept.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
  return kept.filter(message => message.role !== "tool" || liveCalls.has(message.tool_call_id!));
}

/**
 * The turn-2-onward replacement for `buildDynamicTurnMessages`: identical block
 * bodies in identical order, folded into a single `user` message.
 *
 * Two of today's nine slots are deliberately absent. The history preview is
 * redundant once the real transcript is in the request, and `conversationStats`
 * (total / characters / lastMessageId) changes on every single turn — as the
 * first block of the tail it pinned the divergence point at slot 0 and made every
 * genuinely stable slot behind it unreachable.
 */
export function mergedTurnContext(parts: {
  taskContext: string;
  dynamicStyleContext?: string;
  bootstrapContext?: string;
  todosPrompt?: string;
  artifactContext?: string;
  selectedContext?: string;
  prompt: string;
}): AgentTurnMessage {
  const blocks = [
    parts.taskContext,
    parts.dynamicStyleContext || "本轮动态声线证据：无。",
    parts.bootstrapContext || "写作线索：本轮无启发式索引。",
    parts.todosPrompt || "当前对话任务清单：（空）",
    parts.artifactContext || "本轮任务工作记忆：无。",
    parts.selectedContext || "用户选区：无。",
    `本轮用户请求：\n${parts.prompt}`,
  ];
  return { role: "user", content: blocks.join("\n\n———\n\n") };
}

/**
 * Read the frozen chain, keeping it inside `budgetTokens`.
 *
 * Over the high-water mark → compact cold turns **one block at a time** and write
 * the result back; still over → drop whole turns from the head. Both happen before
 * the job's first request, so contract §4 (append-only *within* a job) is untouched.
 *
 * Two properties make the rewrite worth paying for, and both are load-bearing:
 *
 *  - PER-BLOCK, NOT WHOLE-CHAIN. Compacting the concatenated chain with the
 *    compactor's default sliding "keep the last two tool bodies" window means the
 *    window moves forward every time a turn is appended, so last turn's still-full
 *    bodies get digested on this turn — rewriting bytes the provider already
 *    cached, every single turn, forever. Compacting each cold block in isolation
 *    with `keepRecent: 0` is idempotent: a block that has been shrunk once yields
 *    byte-identical output on every later load, so the prefix in front of the
 *    newest rewrite keeps hitting.
 *  - HYSTERESIS. Compact down to `lowWaterRatio × budget`, not to just-under-budget,
 *    so the next few turns fit without touching the chain at all. Dropping stops at
 *    the budget itself — a discarded turn is gone for good, so it gets no overshoot.
 */
export function loadReplayMessages(input: {
  store: ReplayStore;
  sessionId: string;
  budgetTokens: number;
  compact: ReplayCompactor;
  /** Shrink down to this fraction of the budget once the budget is exceeded. */
  lowWaterRatio?: number;
}): ReplayLoadResult {
  const blocks = input.store.agentTurnBlocks(input.sessionId);
  if (!blocks.length) {
    return { messages: [], compacted: false, droppedTurns: 0, replayedTurns: 0, estimatedTokens: 0 };
  }

  let chain = blocks.map(block => ({ messages: block.messages, estimatedTokens: block.estimatedTokens || approximateMessageTokens(block.messages) }));
  const total = () => chain.reduce((sum, block) => sum + block.estimatedTokens, 0);
  let compacted = false;
  let droppedTurns = 0;

  if (total() > input.budgetTokens) {
    const ratio = Math.min(1, Math.max(0.1, input.lowWaterRatio ?? DEFAULT_LOW_WATER_RATIO));
    const lowWater = Math.floor(input.budgetTokens * ratio);

    // Oldest first: the coldest bytes are the cheapest to lose and the least
    // likely to be re-read. Stop as soon as the low-water mark is reached so
    // recent turns keep their full tool bodies.
    for (let index = 0; index < chain.length - KEEP_WARM_TURNS && total() > lowWater; index += 1) {
      const block = chain[index];
      const candidate = block.messages.map(message => ({ ...message }));
      input.compact(candidate, { keepRecent: 0, force: true });
      const estimatedTokens = approximateMessageTokens(candidate);
      if (estimatedTokens >= block.estimatedTokens) continue; // Already compact — leave the bytes alone.
      chain[index] = { messages: candidate, estimatedTokens };
      compacted = true;
    }

    // Dropping targets the high-water mark, not the low one: losing a turn costs
    // continuity the model cannot get back, whereas compaction only costs detail.
    // Overshoot where it is cheap, do the minimum where it is not.
    while (chain.length > 1 && total() > input.budgetTokens) {
      chain = chain.slice(1);
      droppedTurns += 1;
    }
    // A single turn larger than the whole budget: replaying it would crowd out the
    // live turn, so start clean rather than half-replay a broken prefix.
    if (chain.length === 1 && total() > input.budgetTokens) {
      chain = [];
      droppedTurns += 1;
    }
    if (compacted || droppedTurns) input.store.replaceAgentTurnBlocks(input.sessionId, chain);
  }

  return {
    messages: chain.flatMap(block => block.messages),
    compacted,
    droppedTurns,
    replayedTurns: chain.length,
    estimatedTokens: total(),
  };
}
