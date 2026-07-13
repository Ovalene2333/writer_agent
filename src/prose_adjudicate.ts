import { logModelRequest, logModelResponse } from "./model_debug.js";
import {
  escalateHardMannerisms,
  HARD_BLOCK_SUBTYPES,
  hardMannerismLimit,
  type ProseStyleIssue,
} from "./prose_quality.js";
import type { ModelConfig } from "./types.js";

export type ProseVerdict = "allow" | "warn" | "block";

export type ProseAdjudicationItem = {
  id: string;
  kind: ProseStyleIssue["kind"];
  subtype: ProseStyleIssue["subtype"];
  ruleSeverity: ProseStyleIssue["severity"];
  sentence: string;
  evidence: string;
  contextBefore: string;
  contextAfter: string;
  reason: string;
};

export type ProseAdjudicationVerdict = {
  id: string;
  verdict: ProseVerdict;
  reason?: string;
};

export type ProseAdjudicationResult = {
  issues: ProseStyleIssue[];
  adjudicated: number;
  skipped?: string;
  verdicts?: ProseAdjudicationVerdict[];
};

const MAX_ITEMS = 15;
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Pick grey-zone / hard-mannerism candidates for Flash second pass.
 * Skips pure info speech/metadata; includes warnings, errors, and ambiguous dashes.
 */
export function selectAdjudicationCandidates(issues: ProseStyleIssue[]): ProseStyleIssue[] {
  const ranked = issues
    .filter(issue => {
      if (issue.severity === "error") return true;
      if (issue.severity === "warning") return true;
      if (issue.severity === "info" && (issue.subtype === "ambiguous_dash" || issue.subtype === "appositive_definition")) {
        return true;
      }
      return false;
    })
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.confidence - a.confidence);
  return ranked.slice(0, MAX_ITEMS);
}

/** Whether proposal path should spend a Flash call (hard fail or near density limit). */
export function shouldAdjudicateForProposal(text: string, issues: ProseStyleIssue[]): boolean {
  if (issues.some(issue => issue.severity === "error")) return true;
  const limit = hardMannerismLimit(text);
  const hardWarnings = issues.filter(issue =>
    (issue.severity === "warning" || issue.severity === "error")
    && issue.confidence >= 0.9
    && HARD_BLOCK_SUBTYPES.has(issue.subtype),
  ).length;
  return hardWarnings >= Math.max(3, limit - 1);
}

/** Pack sentence ± neighbors for a small-context Flash request. */
export function packProseSnippets(text: string, issues: ProseStyleIssue[]): ProseAdjudicationItem[] {
  return issues.map(issue => {
    const { before, after } = neighborContext(text, issue.start, issue.end);
    return {
      id: issue.id,
      kind: issue.kind,
      subtype: issue.subtype,
      ruleSeverity: issue.severity,
      sentence: issue.sentence.slice(0, 200),
      evidence: issue.evidence.slice(0, 120),
      contextBefore: before,
      contextAfter: after,
      reason: issue.reason.slice(0, 160),
    };
  });
}

/**
 * Apply Flash verdicts then re-escalate density.
 * allow → info; warn → warning (cap conf); block → warning conf 0.95 (hard subtypes eligible for error).
 */
export function applyProseVerdicts(
  text: string,
  issues: ProseStyleIssue[],
  verdicts: ProseAdjudicationVerdict[],
): ProseStyleIssue[] {
  const byId = new Map(verdicts.map(item => [item.id, item]));
  for (const issue of issues) {
    const hit = byId.get(issue.id);
    if (!hit) continue;
    if (hit.verdict === "allow") {
      issue.severity = "info";
      issue.confidence = Math.min(issue.confidence, 0.55);
      if (hit.reason?.trim()) {
        issue.reason = `${issue.reason}（Flash：允许 — ${hit.reason.trim().slice(0, 80)}）`;
      } else {
        issue.reason = `${issue.reason}（Flash：允许）`;
      }
    } else if (hit.verdict === "warn") {
      if (issue.severity === "error") issue.severity = "warning";
      issue.confidence = Math.min(0.88, Math.max(issue.confidence, 0.75));
      if (hit.reason?.trim()) {
        issue.suggestions = [hit.reason.trim().slice(0, 120), ...issue.suggestions].slice(0, 4);
      }
    } else if (hit.verdict === "block") {
      if (issue.severity === "info") issue.severity = "warning";
      issue.confidence = Math.max(issue.confidence, 0.95);
      if (hit.reason?.trim()) {
        issue.suggestions = [hit.reason.trim().slice(0, 120), ...issue.suggestions].slice(0, 4);
        issue.reason = `${issue.reason}（Flash：建议改 — ${hit.reason.trim().slice(0, 80)}）`;
      }
    }
  }
  return escalateHardMannerisms(text, issues);
}

/** Audit path: always try Flash on grey-zone candidates when model is configured. */
export async function adjudicateProseStyleForAudit(
  text: string,
  issues: ProseStyleIssue[],
  model: ModelConfig | undefined,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<ProseAdjudicationResult> {
  if (!model) return { issues, adjudicated: 0, skipped: "no_model" };
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    return { issues, adjudicated: 0, skipped: "no_model" };
  }
  const candidates = selectAdjudicationCandidates(issues);
  if (!candidates.length) return { issues, adjudicated: 0, skipped: "no_candidates" };
  const packed = packProseSnippets(text, candidates);
  try {
    const verdicts = await requestProseVerdicts(model, packed, options?.signal, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (!verdicts.length) return { issues, adjudicated: 0, skipped: "empty_verdicts" };
    return {
      issues: applyProseVerdicts(text, issues, verdicts),
      adjudicated: verdicts.length,
      verdicts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { issues, adjudicated: 0, skipped: `model_error:${message.slice(0, 120)}` };
  }
}

/** Proposal path: Flash only when rules would hard-fail or density is near the limit. */
export async function adjudicateProseStyleForProposal(
  text: string,
  issues: ProseStyleIssue[],
  model: ModelConfig | undefined,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<ProseAdjudicationResult> {
  if (!model) return { issues, adjudicated: 0, skipped: "no_model" };
  if (!shouldAdjudicateForProposal(text, issues)) {
    return { issues, adjudicated: 0, skipped: "below_threshold" };
  }
  return adjudicateProseStyleForAudit(text, issues, model, options);
}

function severityRank(severity: ProseStyleIssue["severity"]): number {
  if (severity === "error") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function neighborContext(text: string, start: number, end: number): { before: string; after: string } {
  const beforeSlice = text.slice(Math.max(0, start - 120), start);
  const afterSlice = text.slice(end, Math.min(text.length, end + 120));
  const beforeParts = beforeSlice.split(/(?<=[。！？!?\n])/u).filter(Boolean);
  const afterParts = afterSlice.split(/(?<=[。！？!?\n])/u).filter(Boolean);
  const before = beforeParts.slice(-2).join("").trim().slice(-160);
  const after = afterParts.slice(0, 2).join("").trim().slice(0, 160);
  return { before, after };
}

async function requestProseVerdicts(
  model: ModelConfig,
  items: ProseAdjudicationItem[],
  outerSignal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProseAdjudicationVerdict[]> {
  const system = `你是中文小说句式二审器。只根据规则初筛片段判定是否为有害「说明体」，不要改写全文。
对每条给出 verdict：
- allow：应放行（对白拖音/中断、停顿—揭示、短同位、列举、表格/元数据、口语纠正、客观事实排除等）
- warn：略模板化但不必拦截
- block：说明性破折号（画面——解释/——因为）、抽象「不是A而是B」重定义等，建议局部改写
只输出 JSON 数组，元素形如 {"id":"...","verdict":"allow|warn|block","reason":"不超过40字"}。不要 Markdown 围栏。`;

  const user = `请判定以下 ${items.length} 条候选：\n${JSON.stringify(items, null, 0)}`;
  const content = await completeJsonChat(model, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], outerSignal, timeoutMs);

  return parseVerdicts(content, new Set(items.map(item => item.id)));
}

function parseVerdicts(raw: string, allowedIds: Set<string>): ProseAdjudicationVerdict[] {
  const text = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: ProseAdjudicationVerdict[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id || !allowedIds.has(id)) continue;
    const verdictRaw = typeof item.verdict === "string" ? item.verdict.trim().toLowerCase() : "";
    const verdict: ProseVerdict | undefined =
      verdictRaw === "allow" || verdictRaw === "warn" || verdictRaw === "block"
        ? verdictRaw
        : verdictRaw === "ok" || verdictRaw === "pass"
          ? "allow"
          : verdictRaw === "reject" || verdictRaw === "error"
            ? "block"
            : undefined;
    if (!verdict) continue;
    const reason = typeof item.reason === "string" ? item.reason.trim().slice(0, 80) : undefined;
    out.push({ id, verdict, ...(reason ? { reason } : {}) });
  }
  return out;
}

async function completeJsonChat(
  model: ModelConfig,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  outerSignal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未配置 API Key");
  }
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model: model.model,
    messages,
    stream: false,
    temperature: 0,
    ...(model.topP === undefined ? {} : { top_p: model.topP }),
  });
  logModelRequest(endpoint, body);

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body,
  });
  const responseBody = await response.text();
  logModelResponse(endpoint, responseBody);
  if (!response.ok) throw new Error(`句式二审请求失败（${response.status}）：${responseBody.slice(0, 240)}`);
  const payload = JSON.parse(responseBody) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error("句式二审无内容");
  return content;
}
