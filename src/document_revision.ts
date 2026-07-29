import { logModelRequest, logModelResponse } from "./model_debug.js";
import { modelFetch } from "./model_fetch.js";
import { parseModelTokenUsage } from "./model_usage.js";
import type { ModelConfig, ModelTokenUsage } from "./types.js";
import { samplingRequestOptions } from "./model_compat.js";

export type DocumentRevisionInput = {
  instruction: string;
  block: number;
  blockCount: number;
  content: string;
  previousTail?: string;
  nextHead?: string;
};

const REVISION_SYSTEM = `你是长文档分块修订器。只修改当前块，严格执行 instruction；保持未要求改变的事实、人物动机、信息顺序、Markdown 标题和接缝。
previousTail/nextHead 只用于衔接，禁止复制进当前块。只输出 JSON：{"content":"修订后的当前块"}，不得输出说明。`;

export function parseDocumentRevision(raw: string, original: string): string {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("分块修订没有返回 JSON 对象");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { content?: unknown };
  if (typeof parsed.content !== "string" || !parsed.content.trim()) throw new Error("分块修订缺少 content");
  const content = parsed.content.trimEnd();
  const minimum = Math.min(80, Math.floor(original.length * 0.35));
  if (content.length < minimum || content.length > Math.max(2_000, original.length * 2.2)) {
    throw new Error("分块修订长度偏离原块过大");
  }
  const originalHeadings = original.split(/\r?\n/).filter(line => /^#{1,6}\s+/.test(line));
  for (const heading of originalHeadings) {
    if (!content.split(/\r?\n/).includes(heading)) throw new Error(`分块修订丢失标题：${heading}`);
  }
  return content;
}

export async function requestDocumentRevision(
  model: ModelConfig,
  input: DocumentRevisionInput,
  signal?: AbortSignal,
): Promise<{ content: string; usage?: ModelTokenUsage; requestCharacters: number }> {
  const messages = [
    { role: "system" as const, content: REVISION_SYSTEM },
    { role: "user" as const, content: JSON.stringify(input) },
  ];
  const requestCharacters = messages.reduce((sum, message) => sum + message.content.length, 0);
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model: model.model,
    messages,
    stream: false,
    ...samplingRequestOptions(model, { temperature: model.temperature ?? 0.5 }),
    max_tokens: Math.min(8_000, Math.max(1_200, Math.ceil(input.content.length * 1.5))),
    response_format: { type: "json_object" },
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
  }, model.proxyUrl);
  const responseBody = await response.text();
  logModelResponse(endpoint, responseBody);
  let payload: { choices?: Array<{ message?: { content?: string | null } }>; usage?: unknown };
  try { payload = JSON.parse(responseBody) as typeof payload; }
  catch { throw new Error("分块修订响应不是 JSON"); }
  const usage = parseModelTokenUsage(payload.usage);
  if (!response.ok) throw new Error(`分块修订请求失败（${response.status}）`);
  return {
    content: parseDocumentRevision(payload.choices?.[0]?.message?.content ?? "", input.content),
    ...(usage ? { usage } : {}),
    requestCharacters,
  };
}
