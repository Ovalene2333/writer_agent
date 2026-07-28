import type { AgentTurnMessage } from "./types.js";
import type { WriterStore } from "./store.js";

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

export type ReplayCompactor = (messages: AgentTurnMessage[]) => void;

export type ReplayLoadResult = {
  /** Frozen turns to splice in directly after the stable system prefix. */
  messages: AgentTurnMessage[];
  /** True when the chain was compacted and written back on this load. */
  compacted: boolean;
  /** Whole turns dropped from the head because compaction was not enough. */
  droppedTurns: number;
  estimatedTokens: number;
};

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
        if (!message.content?.trim()) continue;
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
 * Over budget → compact the oldest turns in place and write the compacted form
 * back, so the shrink is paid for exactly once and the result becomes the new
 * cacheable prefix. Still over → drop whole turns from the head. Both happen
 * before the job's first request, so contract §4 (append-only *within* a job)
 * is untouched.
 */
export function loadReplayMessages(input: {
  store: ReplayStore;
  sessionId: string;
  budgetTokens: number;
  compact: ReplayCompactor;
}): ReplayLoadResult {
  const blocks = input.store.agentTurnBlocks(input.sessionId);
  if (!blocks.length) return { messages: [], compacted: false, droppedTurns: 0, estimatedTokens: 0 };

  let chain = blocks.map(block => ({ messages: block.messages, estimatedTokens: block.estimatedTokens || approximateMessageTokens(block.messages) }));
  const total = () => chain.reduce((sum, block) => sum + block.estimatedTokens, 0);
  let compacted = false;
  let droppedTurns = 0;

  if (total() > input.budgetTokens) {
    // Compact the chain as one transcript, not block by block: the compactor keeps
    // the most recent tool bodies intact, and that "recent" window has to mean
    // recent *overall*, otherwise every turn would retain its own last two reads.
    const offsets: number[] = [];
    const combined: AgentTurnMessage[] = [];
    for (const block of chain) {
      offsets.push(combined.length);
      for (const message of block.messages) combined.push({ ...message });
    }
    input.compact(combined);
    const rebuilt = chain.map((block, index) => {
      const messages = combined.slice(offsets[index], offsets[index] + block.messages.length);
      return { messages, estimatedTokens: approximateMessageTokens(messages) };
    });
    if (rebuilt.reduce((sum, block) => sum + block.estimatedTokens, 0) < total()) {
      chain = rebuilt;
      compacted = true;
    }
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
    estimatedTokens: total(),
  };
}
