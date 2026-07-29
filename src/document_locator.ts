import { logModelRequest, logModelResponse } from "./model_debug.js";
import { modelFetch } from "./model_fetch.js";
import { parseModelTokenUsage } from "./model_usage.js";
import type { ModelConfig, ModelTokenUsage } from "./types.js";
import { samplingRequestOptions } from "./model_compat.js";

export type DocumentLocatorCandidate = {
  anchorId: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  preview: string;
};

export type DocumentLocatorMatch = {
  anchorId: string;
  confidence: number;
  reason: string;
};

const LOCATOR_SYSTEM = `你是长文档片段定位器。依据用户意图，从候选段落中选出最可能需要读取或修改的最多三个锚点。
只输出 JSON：{"matches":[{"anchorId":"...","confidence":0.0,"reason":"..."}]}。
不得创造候选中不存在的 anchorId；证据不足时 matches 可为空。`;

export function parseDocumentLocatorResult(raw: string, candidates: DocumentLocatorCandidate[]): DocumentLocatorMatch[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("文档定位器没有返回 JSON 对象");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { matches?: unknown };
  if (!Array.isArray(parsed.matches)) throw new Error("文档定位器缺少 matches");
  const allowed = new Set(candidates.map(candidate => candidate.anchorId));
  const seen = new Set<string>();
  return parsed.matches.slice(0, 3).flatMap(rawMatch => {
    if (!rawMatch || typeof rawMatch !== "object" || Array.isArray(rawMatch)) return [];
    const match = rawMatch as Record<string, unknown>;
    const anchorId = typeof match.anchorId === "string" ? match.anchorId : "";
    if (!allowed.has(anchorId) || seen.has(anchorId)) return [];
    seen.add(anchorId);
    const confidence = Math.max(0, Math.min(1, Number(match.confidence) || 0));
    const reason = typeof match.reason === "string" ? match.reason.trim().slice(0, 240) : "";
    return [{ anchorId, confidence, reason }];
  });
}

export async function requestDocumentLocator(
  model: ModelConfig,
  input: { intent: string; candidates: DocumentLocatorCandidate[] },
  signal?: AbortSignal,
): Promise<{ matches: DocumentLocatorMatch[]; usage?: ModelTokenUsage; requestCharacters: number }> {
  const messages = [
    { role: "system" as const, content: LOCATOR_SYSTEM },
    { role: "user" as const, content: JSON.stringify({ intent: input.intent, candidates: input.candidates.slice(0, 36) }) },
  ];
  const requestCharacters = messages.reduce((sum, message) => sum + message.content.length, 0);
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model: model.model,
    messages,
    stream: false,
    ...samplingRequestOptions(model, { temperature: 0 }),
    max_tokens: 700,
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
  catch { throw new Error("文档定位器响应不是 JSON"); }
  const usage = parseModelTokenUsage(payload.usage);
  if (!response.ok) throw new Error(`文档定位器请求失败（${response.status}）`);
  return {
    matches: parseDocumentLocatorResult(payload.choices?.[0]?.message?.content ?? "", input.candidates),
    ...(usage ? { usage } : {}),
    requestCharacters,
  };
}
