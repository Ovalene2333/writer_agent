import type { MessageChannel } from "../types.js";
import type { ToolHandlerArgs } from "./types.js";

const MAX_PAGE_CHARACTERS = 16_000;

export function handleInspectConversation({ store, sessionId }: ToolHandlerArgs): string {
  return JSON.stringify({
    ...store.conversationStats(sessionId),
    message: "This is the complete conversation archive index. Older messages are not automatically injected. For long-history writing, page through read_conversation from afterId=0.",
  });
}

export function handleReadConversation({ input, store, sessionId }: ToolHandlerArgs): string {
  const channel = input.channel === "agent" || input.channel === "roleplay"
    ? input.channel as MessageChannel
    : undefined;
  const afterId = typeof input.afterId === "number" && Number.isInteger(input.afterId) && input.afterId >= 0
    ? input.afterId
    : 0;
  const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(80, Math.round(input.limit)))
    : 40;
  const candidates = store.conversationMessages(sessionId, { channel, afterId, limit: limit + 1 });
  const included = [] as typeof candidates;
  let characters = 0;
  for (const message of candidates.slice(0, limit)) {
    const addition = message.content.length + 80;
    if (included.length && characters + addition > MAX_PAGE_CHARACTERS) break;
    included.push(message);
    characters += addition;
  }
  const content = included.map(message => {
    const speaker = message.role === "user" ? "user" : "assistant/character";
    const source = message.channel === "roleplay" ? "roleplay" : "agent";
    return `[message#${message.id}][${source}][${speaker}]\n${message.content}`;
  }).join("\n\n");
  const nextAfterId = included.at(-1)?.id ?? afterId;
  const hasMore = candidates.length > included.length;
  return JSON.stringify({
    channel: channel ?? "all",
    afterId,
    nextAfterId,
    messageCount: included.length,
    characters: content.length,
    hasMore,
    content,
    message: hasMore
      ? `More messages remain. Continue read_conversation with afterId=${nextAfterId}.`
      : "The end of the selected channel has been reached.",
  });
}
