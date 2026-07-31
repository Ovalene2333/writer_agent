import type { MessageAttachment, MessageContent, MessageContentPart, ModelConfig } from "./types.js";

export const MULTIMODAL_MAX_ATTACHMENTS = 4;
export const MULTIMODAL_MAX_BYTES = 4 * 1024 * 1024;
export const MULTIMODAL_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const WRITER_ATTACHMENT_SCHEME = "writer-attachment://";

export function isDeepSeekModel(model: Pick<ModelConfig, "provider" | "baseUrl">): boolean {
  if (model.provider === "deepseek") return true;
  try {
    return new URL(model.baseUrl).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return model.baseUrl.toLowerCase().includes("api.deepseek.com");
  }
}

/** True when this model is configured (or obviously known) to accept image parts. */
export function modelSupportsMultimodal(
  model: Pick<ModelConfig, "supportsMultimodal" | "model" | "provider">,
): boolean {
  if (model.supportsMultimodal === true) return true;
  if (model.supportsMultimodal === false) return false;
  // Unconfigured: never auto-enable for DeepSeek (text-only today); other providers stay opt-in.
  return false;
}

export function isSupportedImageMime(mimeType: string): boolean {
  return MULTIMODAL_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

export function normalizeImageMime(mimeType: string): string {
  const value = mimeType.trim().toLowerCase();
  return value === "image/jpg" ? "image/jpeg" : value;
}

export function extensionForImageMime(mimeType: string): string {
  switch (normalizeImageMime(mimeType)) {
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return "jpg";
  }
}

export function messageContentText(content: MessageContent | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => {
    if (!part || typeof part !== "object") return [];
    if (part.type === "text" && typeof part.text === "string") return [part.text];
    if (part.type === "image_url") {
      const url = part.image_url?.url ?? "";
      const ref = parseWriterAttachmentRef(url);
      return [ref ? `[附图:${ref.id}]` : "[附图]"];
    }
    return [];
  }).join("\n");
}

export function messageContentCharCount(content: MessageContent | undefined): number {
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => {
    if (!part || typeof part !== "object") return sum;
    if (part.type === "text") return sum + (part.text?.length ?? 0);
    if (part.type === "image_url") return sum + Math.min(8_000, part.image_url?.url?.length ?? 0);
    return sum;
  }, 0);
}

export function writerAttachmentRef(sessionId: string, attachmentId: string): string {
  return `${WRITER_ATTACHMENT_SCHEME}${sessionId}/${attachmentId}`;
}

export function parseWriterAttachmentRef(url: string): { sessionId: string; id: string } | undefined {
  if (!url.startsWith(WRITER_ATTACHMENT_SCHEME)) return undefined;
  const rest = url.slice(WRITER_ATTACHMENT_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  const sessionId = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (!sessionId || !id || id.includes("/")) return undefined;
  return { sessionId, id };
}

export function attachmentDataUrl(mimeType: string, bytes: Buffer | Uint8Array): string {
  const mime = normalizeImageMime(mimeType);
  const base64 = Buffer.from(bytes).toString("base64");
  return `data:${mime};base64,${base64}`;
}

/** Build OpenAI-style user content with stable writer-attachment:// image refs. */
export function buildMultimodalUserContent(
  text: string,
  attachments: Array<Pick<MessageAttachment, "id" | "name">>,
  sessionId: string,
): MessageContent {
  const trimmed = text.trim();
  if (!attachments.length) return text;
  const parts: MessageContentPart[] = [];
  const labels = attachments.map(item => item.name || item.id).join("、");
  const body = trimmed
    ? `${trimmed}\n\n[用户附图：${labels}]`
    : `[用户附图：${labels}]`;
  parts.push({ type: "text", text: body });
  for (const item of attachments) {
    parts.push({
      type: "image_url",
      image_url: { url: writerAttachmentRef(sessionId, item.id), detail: "auto" },
    });
  }
  return parts;
}

/**
 * Expand writer-attachment:// refs (or pass through data/https URLs) for the provider wire format.
 * When the model is not multimodal, image parts become a short text note.
 */
export function prepareMessagesForProvider<T extends { content?: MessageContent }>(
  messages: T[],
  options: {
    supportsMultimodal: boolean;
    resolveAttachment?: (sessionId: string, id: string) => { mimeType: string; bytes: Buffer } | undefined;
  },
): T[] {
  return messages.map(message => {
    const content = message.content;
    if (content == null || typeof content === "string") return message;
    if (!Array.isArray(content)) return message;
    if (!options.supportsMultimodal) {
      const text = messageContentText(content);
      return { ...message, content: text || "[用户发送了图片，但当前模型未开启多模态]" };
    }
    const parts: MessageContentPart[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type !== "image_url" || !part.image_url?.url) continue;
      const url = part.image_url.url;
      if (url.startsWith("data:") || /^https?:\/\//i.test(url)) {
        parts.push({ type: "image_url", image_url: { url, detail: part.image_url.detail ?? "auto" } });
        continue;
      }
      const ref = parseWriterAttachmentRef(url);
      if (!ref || !options.resolveAttachment) {
        parts.push({ type: "text", text: `[附图不可用:${url.slice(0, 48)}]` });
        continue;
      }
      const resolved = options.resolveAttachment(ref.sessionId, ref.id);
      if (!resolved) {
        parts.push({ type: "text", text: `[附图缺失:${ref.id}]` });
        continue;
      }
      parts.push({
        type: "image_url",
        image_url: {
          url: attachmentDataUrl(resolved.mimeType, resolved.bytes),
          detail: part.image_url.detail ?? "auto",
        },
      });
    }
    if (!parts.length) return { ...message, content: messageContentText(content) || "" };
    if (parts.length === 1 && parts[0].type === "text") return { ...message, content: parts[0].text };
    return { ...message, content: parts };
  });
}

/** DeepSeek Thinking supports tools but rejects the OpenAI tool_choice field. */
export function modelSupportsToolChoice(model: Pick<ModelConfig, "provider" | "baseUrl">): boolean {
  return !isDeepSeekModel(model);
}

/** Make DeepSeek's default explicit so a multi-step tool job cannot drift modes. */
export function thinkingRequestOptions(
  model: Pick<ModelConfig, "provider" | "baseUrl">,
): { thinking: { type: "enabled" } } | Record<string, never> {
  return isDeepSeekModel(model) ? { thinking: { type: "enabled" } } : {};
}

export type SamplingRequest = {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
};

export type SamplingRequestBody = {
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  reasoning_effort?: ModelConfig["reasoningEffort"];
  verbosity?: ModelConfig["verbosity"];
};

/**
 * Single choke point for configurable sampling and OpenAI request fields.
 *
 * Call sites must not spell `temperature:` into a request body directly. Most of
 * them used to hardcode a literal (`temperature: 0` for extraction and judging,
 * `?? 0.9` for prose), which meant clearing temperature in provider settings
 * changed almost nothing: the model config was consulted in 3 places out of 13,
 * and every other call still sent a value the provider had deprecated.
 *
 * Passing `disableSampling` drops the sampling group rather than just temperature;
 * configured reasoning effort and verbosity remain independent.
 * Models that reject `temperature` reject `top_p` and the penalties too, and an
 * omitted parameter simply falls back to the provider default — omitting can
 * never fail a request, so the safe superset costs nothing.
 */
export function samplingRequestOptions(
  model: Partial<Pick<ModelConfig, "provider" | "baseUrl" | "temperature" | "topP" | "frequencyPenalty" | "presencePenalty" | "reasoningEffort" | "verbosity" | "disableSampling">>,
  requested: SamplingRequest = {},
): SamplingRequestBody {
  // DeepSeek uses its own thinking controls; Chat Completions + Responses both accept effort/verbosity.
  const openAiOptions = model.provider === "deepseek" || (model.baseUrl && isDeepSeekModel(model as Pick<ModelConfig, "provider" | "baseUrl">))
    ? {}
    : {
        ...(model.reasoningEffort === undefined ? {} : { reasoning_effort: model.reasoningEffort }),
        ...(model.verbosity === undefined ? {} : { verbosity: model.verbosity }),
      };
  if (model.disableSampling) return openAiOptions;
  const temperature = requested.temperature ?? model.temperature;
  const topP = requested.topP ?? model.topP;
  const frequencyPenalty = requested.frequencyPenalty ?? model.frequencyPenalty;
  const presencePenalty = requested.presencePenalty ?? model.presencePenalty;
  return {
    ...openAiOptions,
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
    ...(frequencyPenalty === undefined ? {} : { frequency_penalty: frequencyPenalty }),
    ...(presencePenalty === undefined ? {} : { presence_penalty: presencePenalty }),
  };
}

/** Keep deterministic extraction calls from spending their output budget on reasoning. */
export function nonThinkingRequestOptions(
  model: Pick<ModelConfig, "provider" | "baseUrl">,
): { thinking: { type: "disabled" } } | Record<string, never> {
  return isDeepSeekModel(model) ? { thinking: { type: "disabled" } } : {};
}
