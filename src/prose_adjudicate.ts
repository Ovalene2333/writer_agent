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

export type ProseDiscoveryPassage = {
  id: string;
  start: number;
  end: number;
  text: string;
  reason: string;
};

export type ProseAdjudicationDiscovery = {
  passageId: string;
  sentence: string;
  subtype: "semantic_echo" | "emotion_label" | "intent_translation" | "thematic_summary" | "causal_gloss" | "narrator_redefinition";
  verdict: "warn" | "block";
  reason?: string;
};

export type ProseAdjudicationResult = {
  issues: ProseStyleIssue[];
  adjudicated: number;
  skipped?: string;
  verdicts?: ProseAdjudicationVerdict[];
  discoveries?: ProseAdjudicationDiscovery[];
};

const MAX_ITEMS = 15;
const MAX_DISCOVERY_PASSAGES = 8;
const DEFAULT_TIMEOUT_MS = 12_000;
const DISCOVERY_SIGNAL = /(?:这(?:说明|意味着|表明)|显然|无疑|根本|其实|当然|换句话说|也就是说|说到底|归根结底|真正(?:重要|关键|可怕)的|感到|意识到|明白|害怕|恐惧|愤怒|悲伤|绝望|在乎|信任|拒绝|意味着|标志着|是因为)/gu;

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
 * Select paragraph/line windows for open-ended discovery, including passages that
 * were not matched by a deterministic rule. This is audit context, not a verdict.
 */
export function selectDiscoveryPassages(text: string): ProseDiscoveryPassage[] {
  const lines = lineRanges(text).filter(item => item.text.trim() && !/^\s*(?:#{1,6}\s|[-*+]\s|\|)/u.test(item.text));
  const ranked = lines.flatMap((line, index) => {
    const matches = line.text.match(DISCOVERY_SIGNAL)?.length ?? 0;
    const sentences = line.text.split(/[。！？!?]+/u).filter(part => part.trim()).length;
    const previous = lines[index - 1];
    const canIncludePrevious = previous && line.start - previous.end <= 2 && previous.text.length + line.text.length <= 500;
    const score = matches + (matches > 0 && (sentences >= 2 || canIncludePrevious) ? 1 : 0);
    if (score < 2) return [];
    const start = canIncludePrevious ? previous.start : line.start;
    return [{
      id: `passage:${line.start}`,
      start,
      end: line.end,
      text: text.slice(start, line.end).trim().slice(0, 500),
      reason: `解释/评价信号 ${matches} 处，句子 ${sentences} 个`,
      score,
    }];
  });
  return ranked
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, MAX_DISCOVERY_PASSAGES)
    .map(({ score: _score, ...passage }) => passage);
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
  options?: { signal?: AbortSignal; timeoutMs?: number; discover?: boolean },
): Promise<ProseAdjudicationResult> {
  if (!model) return { issues, adjudicated: 0, skipped: "no_model" };
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    return { issues, adjudicated: 0, skipped: "no_model" };
  }
  const candidates = selectAdjudicationCandidates(issues);
  const passages = options?.discover === false ? [] : selectDiscoveryPassages(text);
  if (!candidates.length && !passages.length) return { issues, adjudicated: 0, skipped: "no_candidates" };
  const packed = packProseSnippets(text, candidates);
  try {
    const decision = await requestProseAdjudication(
      model,
      packed,
      passages,
      options?.signal,
      options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (!decision.verdicts.length && !decision.discoveries.length) {
      return { issues, adjudicated: 0, skipped: "empty_verdicts" };
    }
    const next = applyProseVerdicts(text, issues, decision.verdicts);
    next.push(...materializeProseDiscoveries(text, next, passages, decision.discoveries));
    return {
      issues: escalateHardMannerisms(text, next).sort((a, b) => a.start - b.start),
      adjudicated: decision.verdicts.length + decision.discoveries.length,
      verdicts: decision.verdicts,
      discoveries: decision.discoveries,
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
  // Proposal issues have already been diffed against the old document. Open-ended
  // discovery over the whole `after` text could re-introduce old issues and violate
  // the new-only gate, so active discovery remains an audit-only capability.
  return adjudicateProseStyleForAudit(text, issues, model, { ...options, discover: false });
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

export function materializeProseDiscoveries(
  text: string,
  existing: ProseStyleIssue[],
  passages: ProseDiscoveryPassage[],
  discoveries: ProseAdjudicationDiscovery[],
): ProseStyleIssue[] {
  const passageMap = new Map(passages.map(item => [item.id, item]));
  const fingerprints = new Set(existing.map(item => normalizeSentence(item.sentence)));
  const created: ProseStyleIssue[] = [];
  for (const discovery of discoveries) {
    const passage = passageMap.get(discovery.passageId);
    if (!passage) continue;
    const start = text.indexOf(discovery.sentence, passage.start);
    if (start < passage.start || start + discovery.sentence.length > passage.end) continue;
    const fingerprint = normalizeSentence(discovery.sentence);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    const prefix = text.slice(0, start);
    const lastLine = prefix.lastIndexOf("\n");
    const sentence = discovery.sentence.trim();
    created.push({
      id: `explanation:${discovery.subtype}:${start}`,
      kind: "explanation",
      subtype: discovery.subtype,
      severity: "warning",
      confidence: discovery.verdict === "block" ? 0.95 : 0.84,
      start,
      end: start + discovery.sentence.length,
      line: prefix.split("\n").length,
      column: start - lastLine,
      sentence,
      evidence: sentence.length <= 90 ? sentence : `${sentence.slice(0, 87)}…`,
      reason: `Flash 主动发现：${discovery.reason?.trim() || "可能重复解释前文已经呈现的信息"}`,
      suggestions: ["若没有增加新事实，删除该解释句", "若含必要信息，只保留新增事实或后果"],
    });
  }
  return created;
}

function normalizeSentence(value: string): string {
  return value.replace(/\s+/gu, "").slice(0, 160);
}

function lineRanges(text: string): Array<{ start: number; end: number; text: string }> {
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  for (const line of text.split("\n")) {
    const end = start + line.length;
    ranges.push({ start, end, text: line });
    start = end + 1;
  }
  return ranges;
}

async function requestProseAdjudication(
  model: ModelConfig,
  items: ProseAdjudicationItem[],
  passages: ProseDiscoveryPassage[],
  outerSignal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ verdicts: ProseAdjudicationVerdict[]; discoveries: ProseAdjudicationDiscovery[] }> {
  const system = `你是中文小说解释腔二审器。既要复核规则候选，也要在高风险段落中主动发现规则漏掉的解释回声，不要改写全文。
对 candidates 中每条给出 verdict：
- allow：应放行（对白拖音/中断、停顿—揭示、短同位、列举、表格/元数据、口语纠正、客观事实排除等）
- warn：略模板化但不必拦截
- block：明确的重复解释，建议局部改写
对 passages 主动检查：若后一完整句没有增加新事实，只给前文动作/对白贴情绪、意图、因果或主题标签，写入 discoveries。必要概述、转场、新因果事实、人物特色评论应放行。sentence 必须逐字复制段落中的一个完整句子；不要把整段当 sentence。
只输出 JSON 对象：{"verdicts":[{"id":"...","verdict":"allow|warn|block","reason":"不超过40字"}],"discoveries":[{"passageId":"...","sentence":"逐字原句","subtype":"semantic_echo|emotion_label|intent_translation|thematic_summary|causal_gloss|narrator_redefinition","verdict":"warn|block","reason":"不超过40字"}]}。不要 Markdown 围栏。`;

  const user = JSON.stringify({ candidates: items, passages }, null, 0);
  const content = await completeJsonChat(model, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], outerSignal, timeoutMs);

  return parseProseAdjudication(
    content,
    new Set(items.map(item => item.id)),
    new Map(passages.map(item => [item.id, item])),
  );
}

export function parseProseAdjudication(
  raw: string,
  allowedIds: Set<string>,
  passages: Map<string, ProseDiscoveryPassage>,
): { verdicts: ProseAdjudicationVerdict[]; discoveries: ProseAdjudicationDiscovery[] } {
  const text = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return { verdicts: [], discoveries: [] };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return { verdicts: [], discoveries: [] };
    }
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).verdicts)
      ? (parsed as Record<string, unknown>).verdicts as unknown[]
      : [];
  const out: ProseAdjudicationVerdict[] = [];
  for (const row of rows) {
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
  const discoveryRows = !Array.isArray(parsed) && parsed && typeof parsed === "object"
    && Array.isArray((parsed as Record<string, unknown>).discoveries)
    ? (parsed as Record<string, unknown>).discoveries as unknown[]
    : [];
  const discoveries: ProseAdjudicationDiscovery[] = [];
  const allowedSubtypes = new Set<ProseAdjudicationDiscovery["subtype"]>([
    "semantic_echo", "emotion_label", "intent_translation", "thematic_summary", "causal_gloss", "narrator_redefinition",
  ]);
  for (const row of discoveryRows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const passageId = typeof item.passageId === "string" ? item.passageId : "";
    const passage = passages.get(passageId);
    const sentence = typeof item.sentence === "string" ? item.sentence.trim() : "";
    const subtype = typeof item.subtype === "string" ? item.subtype as ProseAdjudicationDiscovery["subtype"] : undefined;
    const verdict = item.verdict === "block" ? "block" : item.verdict === "warn" ? "warn" : undefined;
    if (!passage || !sentence || !passage.text.includes(sentence) || !subtype || !allowedSubtypes.has(subtype) || !verdict) continue;
    const reason = typeof item.reason === "string" ? item.reason.trim().slice(0, 80) : undefined;
    discoveries.push({ passageId, sentence, subtype, verdict, ...(reason ? { reason } : {}) });
  }
  return { verdicts: out, discoveries };
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
