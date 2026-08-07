/**
 * Product-facing diagnostics for model-backed dependency failures
 * (final review, prose gates, etc.). Pure helpers — no I/O.
 */
import type { ModelConfig, ModelTokenUsage, RequestComponentUsage } from "./types.js";
import type { ModelUsageMeta, ModelUsageReporter } from "./model_usage.js";
import { isToolDependencyTimeout } from "./tool_failure.js";

export type DependencyFailureClass =
  | "timeout"
  | "aborted"
  | "http"
  | "network"
  | "rate_limit"
  | "auth"
  | "empty_response"
  | "invalid_output"
  | "config"
  | "unknown";

export type DependencyAttemptRole = "primary" | "fallback" | "sole";

/** One provider call that did not produce a usable domain verdict. */
export type DependencyAttemptDiagnostic = {
  model: string;
  providerName?: string;
  baseUrl?: string;
  role: DependencyAttemptRole;
  class: DependencyFailureClass;
  message: string;
  httpStatus?: number;
  durationMs?: number;
  recordedUsage: boolean;
  at: string;
};

export type DependencyFailureBundle = {
  stage: "final_review" | "isolated_final_review" | "prose_gate" | "other";
  uniqueModelCount: number;
  attempts: DependencyAttemptDiagnostic[];
  /** Flattened human lines for tool JSON `errors` (compat). */
  errors: string[];
  parseOnly: boolean;
  timedOut: boolean;
  hasIndependentFallback: boolean;
};

export const ZERO_MODEL_USAGE: ModelTokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
};

const PARSE_FAILURE_RE = /没有返回 JSON|无法解析|格式无效|缺少有效|缺少 chapterChange|可定位的 blocker|不是 JSON|invalid json|json_object/iu;
const RATE_LIMIT_RE = /rate limit|too many requests|429|配额|额度|usage limit|quota/iu;
const AUTH_RE = /api key|unauthorized|401|403|forbidden|未配置.*api key|authentication/iu;
const HTTP_RE = /请求失败（(\d{3})）|http\s*(\d{3})|status\s*(\d{3})/iu;
const NETWORK_RE = /fetch failed|econnreset|econnrefused|enotfound|socket|network|tls|cert|dns|und_err/iu;
const EMPTY_RE = /空内容|empty (content|response)|没有返回正文|no content/iu;
const CONFIG_RE = /未配置|无独立回退|仅配置 1 个/iu;

export function classifyDependencyError(error: unknown): DependencyFailureClass {
  if (isToolDependencyTimeout(error)) return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  if (PARSE_FAILURE_RE.test(message)) return "invalid_output";
  if (RATE_LIMIT_RE.test(message) || RATE_LIMIT_RE.test(lower)) return "rate_limit";
  if (AUTH_RE.test(message) || AUTH_RE.test(lower)) return "auth";
  if (EMPTY_RE.test(message)) return "empty_response";
  if (CONFIG_RE.test(message)) return "config";
  const http = extractHttpStatus(message);
  if (http === 429) return "rate_limit";
  if (http === 401 || http === 403) return "auth";
  if (http !== undefined) return "http";
  if (NETWORK_RE.test(lower)) return "network";
  if (/timeout|timed out|超时|未响应/iu.test(message)) return "timeout";
  if (/abort/iu.test(lower)) return "aborted";
  return "unknown";
}

export function extractHttpStatus(message: string): number | undefined {
  const match = message.match(HTTP_RE);
  if (!match) return undefined;
  for (let i = 1; i < match.length; i += 1) {
    const n = Number(match[i]);
    if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
  }
  return undefined;
}

export function isChapterReviewParseFailureMessage(message: string): boolean {
  return PARSE_FAILURE_RE.test(message);
}

export function dependencyAttemptRole(index: number, total: number): DependencyAttemptRole {
  if (total <= 1) return "sole";
  return index === 0 ? "primary" : "fallback";
}

export function buildDependencyAttempt(input: {
  model: ModelConfig;
  role: DependencyAttemptRole;
  error: unknown;
  durationMs?: number;
  recordedUsage: boolean;
  failureClass?: DependencyFailureClass;
  httpStatus?: number;
  at?: Date;
}): DependencyAttemptDiagnostic {
  const message = input.error instanceof Error
    ? input.error.message.replace(/\s+/g, " ").trim().slice(0, 400)
    : String(input.error ?? "未知错误").replace(/\s+/g, " ").trim().slice(0, 400);
  const failureClass = input.failureClass
    ?? (input.error && typeof input.error === "object" && "failureClass" in input.error
      && typeof (input.error as { failureClass?: unknown }).failureClass === "string"
      ? (input.error as { failureClass: DependencyFailureClass }).failureClass
      : classifyDependencyError(input.error));
  const httpStatus = input.httpStatus
    ?? (input.error && typeof input.error === "object" && "httpStatus" in input.error
      && typeof (input.error as { httpStatus?: unknown }).httpStatus === "number"
      ? (input.error as { httpStatus: number }).httpStatus
      : extractHttpStatus(message));
  const durationMs = input.durationMs
    ?? (input.error && typeof input.error === "object" && "durationMs" in input.error
      && typeof (input.error as { durationMs?: unknown }).durationMs === "number"
      ? (input.error as { durationMs: number }).durationMs
      : undefined);
  const providerName = input.model.providerName?.trim() || undefined;
  return {
    model: input.model.model,
    ...(providerName ? { providerName } : {}),
    ...(input.model.baseUrl ? { baseUrl: input.model.baseUrl } : {}),
    role: input.role,
    class: failureClass,
    message: message || "未知错误",
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(durationMs !== undefined && Number.isFinite(durationMs)
      ? { durationMs: Math.max(0, Math.round(durationMs)) }
      : {}),
    recordedUsage: input.recordedUsage,
    at: (input.at ?? new Date()).toISOString(),
  };
}

export function buildDependencyFailureBundle(input: {
  stage: DependencyFailureBundle["stage"];
  attempts: DependencyAttemptDiagnostic[];
  uniqueModelCount?: number;
}): DependencyFailureBundle {
  const attempts = input.attempts;
  const uniqueModelCount = input.uniqueModelCount !== undefined
    ? input.uniqueModelCount
    : (new Set(attempts.map(item => `${item.baseUrl ?? ""}|${item.model}`)).size
      || Math.max(1, attempts.length));
  const parseOnly = attempts.length > 0
    && attempts.every(item => item.class === "invalid_output" || isChapterReviewParseFailureMessage(item.message));
  const timedOut = attempts.length > 0 && attempts.every(item => item.class === "timeout" || item.class === "aborted");
  const errors = attempts.map(formatAttemptErrorLine);
  return {
    stage: input.stage,
    uniqueModelCount,
    attempts,
    errors,
    parseOnly,
    timedOut,
    hasIndependentFallback: uniqueModelCount > 1,
  };
}

export function formatAttemptErrorLine(attempt: DependencyAttemptDiagnostic): string {
  const where = [attempt.providerName, attempt.model].filter(Boolean).join(" / ") || attempt.model;
  const role = attempt.role === "sole" ? "唯一模型" : attempt.role === "primary" ? "主模型" : "回退模型";
  const bits = [
    `[${attempt.class}]`,
    `${role} ${where}`,
    attempt.httpStatus !== undefined ? `HTTP ${attempt.httpStatus}` : "",
    attempt.durationMs !== undefined ? `${attempt.durationMs}ms` : "",
    attempt.message,
  ].filter(Boolean);
  return bits.join(" · ").slice(0, 500);
}

export function dependencyFailureUserSummary(bundle: DependencyFailureBundle): string {
  const n = bundle.uniqueModelCount;
  if (bundle.parseOnly) {
    return bundle.stage === "isolated_final_review"
      ? "隔离终审已响应，但输出无法形成带场景和逐字证据的有效结论。"
      : "终审已响应但结论无法解析或缺少可定位证据，未创建提案（非服务故障）。";
  }
  if (n <= 1) {
    if (bundle.timedOut) {
      return "终审模型响应超时（仅配置 1 个唯一模型，无独立回退），未创建提案。";
    }
    const dominant = dominantFailureClass(bundle.attempts);
    if (dominant === "rate_limit") {
      return "终审模型触发限流或额度限制（仅配置 1 个唯一模型，无独立回退），未创建提案。";
    }
    if (dominant === "auth" || dominant === "config") {
      return "终审模型配置或鉴权不可用（仅配置 1 个唯一模型，无独立回退），未创建提案。";
    }
    if (dominant === "network" || dominant === "http") {
      return "终审模型请求失败（仅配置 1 个唯一模型，无独立回退），未创建提案。";
    }
    return "终审模型调用失败（仅配置 1 个唯一模型，无独立回退），未创建提案。";
  }
  if (bundle.timedOut) {
    return "终审模型及回退模型均响应超时，未创建提案。";
  }
  return "终审模型及回退模型均不可用，未创建提案。";
}

export function dependencyFailureGuidance(bundle: DependencyFailureBundle): string {
  if (bundle.parseOnly) {
    return "请按 errors 自检事实/认知边界后做最小修订再提交；不要原样空重试。";
  }
  if (bundle.timedOut) {
    return "可提高终审超时、错峰重试，或配置独立回退模型后续跑。";
  }
  const dominant = dominantFailureClass(bundle.attempts);
  if (dominant === "rate_limit") {
    return "请稍后重试，或降低同供应商并发（写作与扮演勿长时间并行长请求）。";
  }
  if (dominant === "auth" || dominant === "config") {
    return "请检查 API Key、供应商与终审模型配置后重试。";
  }
  return "依赖恢复后可续跑；不得在未完成事实与认知边界审核时绕过终审。";
}

export function formatDependencyDiagnosticsForDisplay(bundle: DependencyFailureBundle, maxAttempts = 4): string[] {
  if (!bundle.attempts.length) return [];
  const lines = [`诊断（${bundle.stage} · ${bundle.uniqueModelCount} 个唯一模型）：`];
  for (const [index, attempt] of bundle.attempts.slice(0, maxAttempts).entries()) {
    lines.push(`${index + 1}. ${formatAttemptErrorLine(attempt)}`);
  }
  if (bundle.attempts.length > maxAttempts) {
    lines.push(`…另有 ${bundle.attempts.length - maxAttempts} 条尝试未展开`);
  }
  return lines;
}

/** Pull a failure bundle out of a tool-result payload (errors + optional diagnostics). */
export function dependencyBundleFromToolResult(
  result: Record<string, unknown>,
  fallbackStage: DependencyFailureBundle["stage"] = "other",
): DependencyFailureBundle | undefined {
  const diagnostics = result.diagnostics;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    const raw = diagnostics as Record<string, unknown>;
    const attempts = Array.isArray(raw.attempts)
      ? raw.attempts.flatMap((item): DependencyAttemptDiagnostic[] => {
          if (!item || typeof item !== "object") return [];
          const row = item as Record<string, unknown>;
          if (typeof row.model !== "string" || typeof row.message !== "string") return [];
          return [{
            model: row.model,
            ...(typeof row.providerName === "string" ? { providerName: row.providerName } : {}),
            ...(typeof row.baseUrl === "string" ? { baseUrl: row.baseUrl } : {}),
            role: row.role === "primary" || row.role === "fallback" || row.role === "sole"
              ? row.role
              : "sole",
            class: typeof row.class === "string" ? row.class as DependencyFailureClass : "unknown",
            message: row.message,
            ...(typeof row.httpStatus === "number" ? { httpStatus: row.httpStatus } : {}),
            ...(typeof row.durationMs === "number" ? { durationMs: row.durationMs } : {}),
            recordedUsage: row.recordedUsage === true,
            at: typeof row.at === "string" ? row.at : new Date(0).toISOString(),
          }];
        })
      : [];
    if (attempts.length) {
      return buildDependencyFailureBundle({
        stage: typeof raw.stage === "string"
          ? raw.stage as DependencyFailureBundle["stage"]
          : fallbackStage,
        attempts,
        uniqueModelCount: typeof raw.uniqueModelCount === "number" ? raw.uniqueModelCount : undefined,
      });
    }
  }
  const errors = Array.isArray(result.errors)
    ? result.errors.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const reviewFailure = result.reviewFailure && typeof result.reviewFailure === "object"
    ? result.reviewFailure as Record<string, unknown>
    : undefined;
  const reviewErrors = Array.isArray(reviewFailure?.errors)
    ? reviewFailure!.errors.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const lines = errors.length ? errors : reviewErrors;
  if (!lines.length) return undefined;
  const attempts = lines.map((message, index) => ({
    model: "unknown",
    role: dependencyAttemptRole(index, lines.length),
    class: classifyDependencyError(new Error(message)),
    message: message.replace(/\s+/g, " ").trim().slice(0, 400),
    recordedUsage: false,
    at: new Date(0).toISOString(),
  }));
  return buildDependencyFailureBundle({ stage: fallbackStage, attempts });
}

export function reportModelCallUsage(
  reporter: ModelUsageReporter | undefined,
  model: ModelConfig,
  usage: ModelTokenUsage | undefined,
  meta: ModelUsageMeta,
): boolean {
  if (!reporter) return false;
  reporter(model, usage ?? ZERO_MODEL_USAGE, {
    ...meta,
    ...(usage?.promptTokens || usage?.completionTokens
      ? {}
      : {
          requestComponents: annotateFailedRequestComponents(meta.requestComponents, meta.callKind),
        }),
  });
  return true;
}

function annotateFailedRequestComponents(
  components: RequestComponentUsage[] | undefined,
  callKind: string,
): RequestComponentUsage[] {
  if (components?.length) {
    return components.map(component => ({ ...component, callKind }));
  }
  return [{
    kind: "other",
    label: "失败的模型请求（无 token 用量）",
    characters: 0,
    estimatedTokens: 0,
    callKind,
  }];
}

function dominantFailureClass(attempts: DependencyAttemptDiagnostic[]): DependencyFailureClass | undefined {
  if (!attempts.length) return undefined;
  const counts = new Map<DependencyFailureClass, number>();
  for (const attempt of attempts) {
    counts.set(attempt.class, (counts.get(attempt.class) ?? 0) + 1);
  }
  let best: DependencyFailureClass | undefined;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}
