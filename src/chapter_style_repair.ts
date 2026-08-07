import { logModelRequest, logModelResponse } from "./model_debug.js";
import { samplingRequestOptions, thinkingRequestOptions } from "./model_compat.js";
import { buildProviderCompletionBody, contentFromProviderResponseBody, modelCompletionEndpoint, parseProviderCompletionPayload, serializeProviderChatBody } from "./model_api.js";
import { modelFetch, modelRequestOptions } from "./model_fetch.js";
import { parseModelTokenUsage } from "./model_usage.js";
import { proseRealizationContract } from "./prose_realization.js";
import type { ModelConfig, ModelTokenUsage } from "./types.js";

export type ChapterStyleRepairIssue = {
  id: string;
  code: string;
  sentence: string;
  before: string;
  after: string;
  instruction: string;
  policyId?: string;
  policyVersion?: number;
  skillId?: string;
};

export type ChapterStyleEdit = { search: string; replace: string };

export class ChapterStyleRepairRequestError extends Error {
  constructor(
    message: string,
    readonly usage?: ModelTokenUsage,
    readonly requestCharacters = 0,
    readonly failureKind: "http" | "truncated" | "invalid_output" = "invalid_output",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChapterStyleRepairRequestError";
  }
}

const STYLE_REPAIR_SYSTEM = `你是中文小说局部句式修订器。只修复输入列出的硬拦截句，不改事件、事实、人物状态、场景顺序或未列出的正文。
只输出 JSON：{"edits":[{"search":"原句","replace":"替换句"}]}。
search 必须逐字取自 issue.sentence；每个 issue 至多一条 edit；replace 必须是可直接替换的完整正文，不得包含 Markdown 标题、解释、占位符或元信息。
${proseRealizationContract()}`;

export const CHAPTER_STYLE_REPAIR_BATCH_SIZE = 8;

export function buildChapterStyleRepairMessages(input: {
  issues: ChapterStyleRepairIssue[];
  chapterGoal: string;
  styleEvidence?: string;
}): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: STYLE_REPAIR_SYSTEM },
    {
      role: "user",
      content: JSON.stringify({
        chapterGoal: input.chapterGoal,
        issues: input.issues.slice(0, CHAPTER_STYLE_REPAIR_BATCH_SIZE),
        ...(input.styleEvidence?.trim() ? { styleEvidence: input.styleEvidence.slice(0, 1_000) } : {}),
      }),
    },
  ];
}

export function parseChapterStyleRepair(raw: string, issues: ChapterStyleRepairIssue[]): ChapterStyleEdit[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("局部风格修订没有返回 JSON 对象");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { edits?: unknown };
  if (!Array.isArray(parsed.edits)) throw new Error("局部风格修订缺少 edits");
  const allowed = new Set(issues.map(issue => issue.sentence));
  const seen = new Set<string>();
  const edits: ChapterStyleEdit[] = [];
  for (const row of parsed.edits.slice(0, 20)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const value = row as Record<string, unknown>;
    const search = typeof value.search === "string" ? value.search.trim() : "";
    const replace = typeof value.replace === "string" ? value.replace.trim() : "";
    if (!allowed.has(search) || seen.has(search) || !replace || replace === search) continue;
    if (replace.length > Math.max(500, search.length * 3)) continue;
    if (/^#{1,6}\s/mu.test(replace)) continue;
    seen.add(search);
    edits.push({ search, replace });
  }
  if (!edits.length) throw new Error("局部风格修订没有提供可应用的精确替换");
  return edits;
}

export async function requestChapterStyleRepair(
  model: ModelConfig,
  input: { issues: ChapterStyleRepairIssue[]; chapterGoal: string; styleEvidence?: string },
  signal?: AbortSignal,
): Promise<{ edits: ChapterStyleEdit[]; usage?: ModelTokenUsage; requestCharacters: number }> {
  const batch = input.issues.slice(0, CHAPTER_STYLE_REPAIR_BATCH_SIZE);
  const messages = buildChapterStyleRepairMessages({ ...input, issues: batch });
  const { endpoint, body } = serializeProviderChatBody(model, {
    model: model.model,
    messages,
    stream: false,
    ...samplingRequestOptions(model, { temperature: 0.2 }),
    response_format: { type: "json_object" },
    ...thinkingRequestOptions(model),
  });
  logModelRequest(endpoint, body);
  const response = await modelFetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body,
  }, modelRequestOptions(model));
  const responseBody = await response.text();
  logModelResponse(endpoint, responseBody);
  const requestCharacters = messages.reduce((sum, message) => sum + message.content.length, 0);
  let payload: { choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>; usage?: unknown };
  try {
    payload = JSON.parse(responseBody) as typeof payload;
  } catch (error) {
    throw new ChapterStyleRepairRequestError("局部风格修订响应不是 JSON", undefined, requestCharacters, "invalid_output", { cause: error });
  }
  const usage = parseModelTokenUsage(payload.usage);
  if (!response.ok) {
    throw new ChapterStyleRepairRequestError(`局部风格修订请求失败（${response.status}）`, usage, requestCharacters, "http");
  }
  if (parseProviderCompletionPayload(payload).finishReason === "length") {
    throw new ChapterStyleRepairRequestError("局部风格修订输出达到长度上限", usage, requestCharacters, "truncated");
  }
  try {
    const edits = parseChapterStyleRepair(parseProviderCompletionPayload(payload).content, batch);
    return { edits, ...(usage ? { usage } : {}), requestCharacters };
  } catch (error) {
    throw new ChapterStyleRepairRequestError(
      error instanceof Error ? error.message : String(error),
      usage,
      requestCharacters,
      "invalid_output",
      { cause: error },
    );
  }
}
