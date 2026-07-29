import { logModelRequest, logModelResponse } from "./model_debug.js";
import { modelFetch } from "./model_fetch.js";
import { samplingRequestOptions } from "./model_compat.js";
import { parseModelTokenUsage, type ModelUsageReporter } from "./model_usage.js";
import type { ModelConfig } from "./types.js";

export const CONTINUITY_FACT_KINDS = [
  "milieu", "character", "location", "event", "object", "relationship", "organization", "other",
] as const;
export type ContinuityFactKind = typeof CONTINUITY_FACT_KINDS[number];

export const CONTINUITY_FACT_SCOPE_KINDS = [
  "global", "era", "arc", "chapter", "location", "character",
] as const;
export type ContinuityFactScopeKind = typeof CONTINUITY_FACT_SCOPE_KINDS[number];

export const CONTINUITY_FACT_EPISTEMIC_KINDS = [
  "objective", "character_knowledge", "rumor",
] as const;
export type ContinuityFactEpistemicKind = typeof CONTINUITY_FACT_EPISTEMIC_KINDS[number];

export type ContinuityFactStatus = "active" | "conflict" | "pending" | "stale" | "retracted";

export type ContinuityFact = {
  id: number;
  statement: string;
  kind: ContinuityFactKind;
  scopeKind: ContinuityFactScopeKind;
  scopeValue: string;
  validFrom: string;
  validUntil: string;
  epistemic: ContinuityFactEpistemicKind;
  knownBy: string[];
  importance: number;
  status: ContinuityFactStatus;
  sourcePath: string;
  sourceHash: string;
  sourceEvidence: string;
  sourceAnchorId: string;
  sourceProposalId?: number;
  conflictsWith: number[];
  supersedes: number[];
  createdAt: string;
  updatedAt: string;
};

export type ContinuityFactCandidate = Pick<
  ContinuityFact,
  "statement" | "kind" | "scopeKind" | "scopeValue" | "validFrom" | "validUntil"
  | "epistemic" | "knownBy" | "importance" | "sourceEvidence" | "conflictsWith" | "supersedes"
>;

const FACT_EXTRACTOR_SYSTEM = `你是长篇小说的连续性事实提取器。只从“本次已经接受的文本变化”中提取以后写作仍可能需要遵守或检索的事实。

不要提取修辞、气氛、情绪描写、普通动作流水账、写作技巧或只对当前句子有意义的信息。milieu 用于年代生活方式、社会惯例、技术条件等长期环境约束，不是文风。人物误解、传闻和客观事实必须区分。

每条事实必须提供 sourceEvidence：它必须是当前文档中的一段连续原文，不得改写或拼接。无法找到原文证据就不要输出。已有事实只用于发现冲突或替代，不代表本次文本已经再次证明它们。

只输出 JSON 数组，最多 24 项。字段：
statement（独立、简短、无文档术语）；
kind（milieu/character/location/event/object/relationship/organization/other）；
scopeKind（global/era/arc/chapter/location/character）；
scopeValue（可为空）；
validFrom、validUntil（不确定时为空）；
epistemic（objective/character_knowledge/rumor）；
knownBy（角色名数组，客观公共事实可为空）；
importance（0-100）；
sourceEvidence；
conflictsWith（与已有事实冲突的数字 ID 数组）；
supersedes（明确取代的数字 ID 数组）。

未来计划、提纲意图、作者说明、未发生事项不得当作已成立事实。`;

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

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === "string" && allowed.includes(value) ? value as T[number] : fallback;
}

function compactStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string")
    .map(item => item.trim()).filter(Boolean))].slice(0, limit);
}

export function parseContinuityFactCandidates(text: string, currentContent: string): ContinuityFactCandidate[] {
  const candidates: ContinuityFactCandidate[] = [];
  for (const raw of jsonArray(text).slice(0, 24)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const statement = typeof item.statement === "string" ? item.statement.trim().slice(0, 280) : "";
    const sourceEvidence = typeof item.sourceEvidence === "string" ? item.sourceEvidence.trim().slice(0, 500) : "";
    if (!statement || sourceEvidence.length < 2 || !currentContent.includes(sourceEvidence)) continue;
    const numberList = (value: unknown) => Array.isArray(value)
      ? [...new Set(value.map(Number).filter(number => Number.isInteger(number) && number > 0))].slice(0, 12)
      : [];
    candidates.push({
      statement,
      kind: enumValue(item.kind, CONTINUITY_FACT_KINDS, "other"),
      scopeKind: enumValue(item.scopeKind, CONTINUITY_FACT_SCOPE_KINDS, "chapter"),
      scopeValue: typeof item.scopeValue === "string" ? item.scopeValue.trim().slice(0, 160) : "",
      validFrom: typeof item.validFrom === "string" ? item.validFrom.trim().slice(0, 120) : "",
      validUntil: typeof item.validUntil === "string" ? item.validUntil.trim().slice(0, 120) : "",
      epistemic: enumValue(item.epistemic, CONTINUITY_FACT_EPISTEMIC_KINDS, "objective"),
      knownBy: compactStrings(item.knownBy, 20),
      importance: Math.max(0, Math.min(100, Math.round(Number(item.importance ?? 50)) || 0)),
      sourceEvidence,
      conflictsWith: numberList(item.conflictsWith),
      supersedes: numberList(item.supersedes),
    });
  }
  return candidates;
}

/** A bounded diff window: extraction cost follows the accepted change, not book length. */
export function acceptedChangeWindow(before: string, after: string, limit = 12_000): string {
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

export async function extractContinuityFacts(options: {
  model: ModelConfig;
  path: string;
  beforeContent: string;
  afterContent: string;
  existingFacts: Array<Pick<ContinuityFact, "id" | "statement" | "kind" | "scopeKind" | "scopeValue" | "epistemic" | "status">>;
  signal?: AbortSignal;
  usageReporter?: ModelUsageReporter;
}): Promise<ContinuityFactCandidate[]> {
  const changed = acceptedChangeWindow(options.beforeContent, options.afterContent);
  if (!changed.trim()) return [];
  if (!options.model.apiKey
    && !options.model.baseUrl.includes("localhost")
    && !options.model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未配置可用的事实提取模型");
  }
  const endpoint = `${options.model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const messages = [
    { role: "system" as const, content: FACT_EXTRACTOR_SYSTEM },
    { role: "user" as const, content: JSON.stringify({
      path: options.path,
      acceptedChange: changed,
      existingFacts: options.existingFacts.slice(0, 80),
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
  if (!response.ok) throw new Error(`连续性事实提取失败（${response.status}）：${responseBody.slice(0, 240)}`);
  const payload = JSON.parse(responseBody) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: unknown;
  };
  const usage = parseModelTokenUsage(payload.usage);
  if (usage) options.usageReporter?.(options.model, usage, { callKind: "continuity_fact_extraction" });
  return parseContinuityFactCandidates(payload.choices?.[0]?.message?.content ?? "", options.afterContent);
}
