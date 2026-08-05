import { logModelRequest, logModelResponse } from "./model_debug.js";
import { modelFetch } from "./model_fetch.js";
import { samplingRequestOptions } from "./model_compat.js";
import { modelCompletionEndpoint, parseProviderCompletionPayload } from "./model_api.js";
import { parseModelTokenUsage, type ModelUsageReporter } from "./model_usage.js";
import type { ModelConfig } from "./types.js";

export const WRITING_MEMORY_KINDS = [
  "character_state",
  "relationship",
  "knowledge",
  "open_thread",
  "dialogue_voice",
  "portrayal",
] as const;

export type WritingMemoryKind = typeof WRITING_MEMORY_KINDS[number];
export type WritingMemoryStatus = "active" | "stale";

export type WritingMemoryEntry = {
  id: number;
  sessionId: string;
  sourceMessageId: number;
  sourceProposalId?: number;
  kind: WritingMemoryKind;
  content: string;
  characterIds: number[];
  importance: number;
  status: WritingMemoryStatus;
  sourcePath: string;
  sourceHash: string;
  sourceEvidence: string;
  sourceAnchorId: string;
  createdAt: string;
  updatedAt: string;
};

export type WritingMemoryCandidate = Pick<
  WritingMemoryEntry,
  "kind" | "content" | "characterIds" | "importance" | "sourceEvidence"
>;

const WRITING_MEMORY_EXTRACTOR_SYSTEM = `你维护单次写作会话的临时写作记忆。只从“本次已经接受的正文变化”提取后续续写近期可能需要的中间态，只输出 JSON 数组，不要 markdown。

这些条目不是项目设定或永久事实，不得扩写、推断或总结全文。只记录正文已经明确呈现且短期续写有用的内容：
- character_state：人物此刻的身体、情绪、意图或处境；
- relationship：本次实际表现出的关系变化；
- knowledge：正文明确建立的角色知情状态；
- open_thread：正文明确留下、尚未闭合的行动或问题；
- dialogue_voice：角色在本段对白中实际采用的表达策略或语域；
- portrayal：本段实际呈现的动作、沉默、回避或互动方式。

不要提取世界观百科、长期设定、修辞评价、主题分析、写作建议或普通动作流水账。不要把人物猜测当成客观结论。dialogue_voice/portrayal 只能描述这段证据里的实际表现，不能写成永久性格规则。

每项字段：kind；content（独立、简短、无文档术语）；characterIds（只能使用输入角色目录中的 ID，不确定则空数组）；importance（0-100）；sourceEvidence（当前正文中的一段连续原文，必须逐字存在，不得拼接或改写）。最多 18 项。`;

function jsonArray(text: string): unknown[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseWritingMemoryCandidates(
  text: string,
  currentContent: string,
  allowedCharacterIds: readonly number[],
): WritingMemoryCandidate[] {
  const allowed = new Set(allowedCharacterIds);
  const candidates: WritingMemoryCandidate[] = [];
  for (const raw of jsonArray(text).slice(0, 18)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const kind = typeof item.kind === "string" && WRITING_MEMORY_KINDS.includes(item.kind as WritingMemoryKind)
      ? item.kind as WritingMemoryKind
      : undefined;
    const content = typeof item.content === "string" ? item.content.trim().replace(/\s+/gu, " ").slice(0, 360) : "";
    const sourceEvidence = typeof item.sourceEvidence === "string" ? item.sourceEvidence.trim().slice(0, 600) : "";
    if (!kind || !content || sourceEvidence.length < 2 || !currentContent.includes(sourceEvidence)) continue;
    const characterIds = Array.isArray(item.characterIds)
      ? [...new Set(item.characterIds.map(Number).filter(id => Number.isInteger(id) && id > 0 && allowed.has(id)))].slice(0, 8)
      : [];
    candidates.push({
      kind,
      content,
      characterIds,
      importance: Math.max(0, Math.min(100, Math.round(Number(item.importance ?? 50)) || 0)),
      sourceEvidence,
    });
  }
  return candidates;
}

/** Bounded accepted diff: memory indexing cost follows the accepted change. */
export function acceptedWritingMemoryWindow(before: string, after: string, limit = 12_000): string {
  if (!after || before === after) return "";
  let prefix = 0;
  const prefixLimit = Math.min(before.length, after.length);
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  const suffixLimit = Math.min(before.length - prefix, after.length - prefix);
  while (suffix < suffixLimit
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const context = 600;
  const start = Math.max(0, prefix - context);
  const end = Math.min(after.length, after.length - suffix + context);
  const changed = after.slice(start, end);
  if (changed.length <= limit) return changed;
  const half = Math.floor((limit - 80) / 2);
  return `${changed.slice(0, half)}\n…[变化片段中部过长，已省略]…\n${changed.slice(-half)}`;
}

export async function extractWritingMemory(options: {
  model: ModelConfig;
  path: string;
  beforeContent: string;
  afterContent: string;
  characters: Array<{ id: number; name: string; aliases: string[] }>;
  signal?: AbortSignal;
  usageReporter?: ModelUsageReporter;
}): Promise<WritingMemoryCandidate[]> {
  const changed = acceptedWritingMemoryWindow(options.beforeContent, options.afterContent);
  if (!changed.trim()) return [];
  if (!options.model.apiKey
    && !options.model.baseUrl.includes("localhost")
    && !options.model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未配置可用的写作记忆提取模型");
  }
  const endpoint = modelCompletionEndpoint(options.model);
  const messages = [
    { role: "system" as const, content: WRITING_MEMORY_EXTRACTOR_SYSTEM },
    { role: "user" as const, content: JSON.stringify({
      path: options.path,
      acceptedChange: changed,
      characters: options.characters.slice(0, 80),
    }) },
  ];
  const body = JSON.stringify({
    model: options.model.model,
    messages,
    stream: false,
    ...samplingRequestOptions(options.model, { temperature: 0 }),
  });
  logModelRequest(endpoint, body);
  const timeout = AbortSignal.timeout(15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await modelFetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(options.model.apiKey ? { authorization: `Bearer ${options.model.apiKey}` } : {}),
    },
    body,
  }, options.model.proxyUrl);
  const responseBody = await response.text();
  logModelResponse(endpoint, responseBody);
  if (!response.ok) throw new Error(`写作记忆提取失败（${response.status}）：${responseBody.slice(0, 240)}`);
  const payload = JSON.parse(responseBody) as { usage?: unknown };
  const usage = parseModelTokenUsage(payload.usage);
  if (usage) options.usageReporter?.(options.model, usage, { callKind: "writing_memory_extraction" });
  return parseWritingMemoryCandidates(
    parseProviderCompletionPayload(payload).content,
    options.afterContent,
    options.characters.map(item => item.id),
  );
}
