import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { completeProviderCompletion } from "./model_api.js";
import { prefixCacheLogPath, summarizePrefixCacheLog } from "./prefix_cache.js";
import type { WriterProject } from "./project.js";
import type { ModelConfig } from "./types.js";

export const LOG_ANALYSIS_VERSION = 1 as const;

export type LogEvidenceKind =
  | "runtime_overview"
  | "jobs"
  | "agent_runs"
  | "run_trace"
  | "job_trace"
  | "model_usage"
  | "prefix_cache";

export type LogEvidence = {
  id: string;
  kind: LogEvidenceKind;
  title: string;
  source: string;
  capturedAt: string;
  data: unknown;
  bytes: number;
  truncated?: boolean;
};

export type LogEvidenceRequest = {
  kind: "run_trace" | "job_trace" | "prefix_cache" | "model_usage";
  id?: string;
  reason: string;
};

export type LogAnalysisFinding = {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  title: string;
  diagnosis: string;
  evidenceIds: string[];
  confidence: number;
  recommendation?: string;
};

export type LogAnalysisReport = {
  version: typeof LOG_ANALYSIS_VERSION;
  status: "completed" | "inconclusive";
  summary: string;
  findings: LogAnalysisFinding[];
  analyzedAt: string;
  analyzer: { backend: "direct" | "opencode"; model: string; rounds: number };
  diagnostics: string[];
};

export type LogAnalysisTurn = {
  status: "need_evidence" | "complete";
  summary?: string;
  findings?: unknown[];
  requests?: unknown[];
};

export interface LogAnalyzer {
  readonly backend: "direct" | "opencode";
  readonly model: string;
  analyze(input: { prompt: string; evidencePath: string; round: number }): Promise<string>;
}

export type LogAuditOptions = {
  sinceHours?: number;
  limit?: number;
  maxEvidenceBytes?: number;
  maxRounds?: number;
  collectOnly?: boolean;
  jobId?: string;
  runId?: string;
};

export type LogAuditResult = {
  runId: string;
  runDir: string;
  manifestPath: string;
  evidencePath: string;
  reportPath?: string;
  report?: LogAnalysisReport;
  evidence: LogEvidence[];
};

type AuditScope = Required<Pick<LogAuditOptions, "sinceHours" | "limit" | "maxEvidenceBytes" | "maxRounds">>
  & Pick<LogAuditOptions, "jobId" | "runId">;

type Row = Record<string, unknown>;

const SENSITIVE_KEYS = new Set([
  "api_key", "apikey", "apiKey", "authorization", "cookie", "password", "proxy_url",
  "proxyUrl", "secret", "token", "tunnel_token", "tunnelToken",
]);

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ds|key)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]");
}

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(item => redactLogValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(key.toLowerCase())
      ? "[REDACTED]"
      : redactLogValue(item, depth + 1);
  }
  return output;
}

function parseJsonLoose(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); }
  catch { return value; }
}

function compactStepTrail(raw: unknown): unknown {
  const parsed = parseJsonLoose(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(-30).map((step) => {
    if (!step || typeof step !== "object") return step;
    const item = step as Record<string, unknown>;
    const tools = Array.isArray(item.tools)
      ? item.tools.slice(0, 20).map(tool => typeof tool === "string"
        ? tool
        : tool && typeof tool === "object" ? (tool as Record<string, unknown>).name : undefined).filter(Boolean)
      : [];
    return {
      id: item.id,
      step: item.step,
      status: item.status,
      tools,
      outputChars: typeof item.output === "string" ? item.output.length : 0,
      reasoningChars: typeof item.reasoning === "string" ? item.reasoning.length : 0,
      error: typeof item.error === "string" ? item.error.slice(0, 1_000) : undefined,
    };
  });
}

function projectAgentRunSnapshot(raw: unknown): unknown {
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const item = parsed as Record<string, unknown>;
  const deliverables = Array.isArray(item.deliverables) ? item.deliverables.map((value) => {
    if (!value || typeof value !== "object") return {};
    const deliverable = value as Record<string, unknown>;
    const evidence = deliverable.evidence && typeof deliverable.evidence === "object"
      ? deliverable.evidence as Record<string, unknown> : undefined;
    return {
      id: deliverable.id,
      state: deliverable.state,
      execution: deliverable.execution,
      ...(evidence ? { evidence: {
        toolName: evidence.toolName,
        proposalId: evidence.proposalId,
        changeSetId: evidence.changeSetId,
        path: evidence.path,
        proposalStatus: evidence.proposalStatus,
        recordedAt: evidence.recordedAt,
      } } : {}),
      revisionRequired: Boolean(deliverable.proposalRevision),
    };
  }) : [];
  const diagnostics = Array.isArray(item.diagnostics) ? item.diagnostics.map((value) => {
    if (!value || typeof value !== "object") return {};
    const diagnostic = value as Record<string, unknown>;
    return { code: diagnostic.code, at: diagnostic.at };
  }) : [];
  const activeGate = item.activeGate && typeof item.activeGate === "object"
    ? item.activeGate as Record<string, unknown> : undefined;
  const intentReview = item.intentReview && typeof item.intentReview === "object"
    ? item.intentReview as Record<string, unknown> : undefined;
  return {
    version: item.version,
    id: item.id,
    sourceMessageId: item.sourceMessageId,
    contract: item.contract,
    deliverables,
    progress: item.progress,
    status: item.status,
    phase: item.phase,
    pendingEffect: item.pendingEffect,
    lastContextBoundary: item.lastContextBoundary,
    contextBoundaryCount: item.contextBoundaryCount,
    diagnostics,
    ...(activeGate ? { activeGate: {
      decision: activeGate.decision,
      toolName: activeGate.toolName,
      gate: activeGate.gate,
      deliverableId: activeGate.deliverableId,
      at: activeGate.at,
    } } : {}),
    ...(intentReview ? { intentReview: { status: intentReview.status, checkedAt: intentReview.checkedAt } } : {}),
    step: item.step,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

const PRIVATE_EVENT_KEYS = new Set([
  "content", "label", "originalRequest", "prompt", "question", "remaining", "commitment", "text",
]);

function projectRunEventPayload(raw: unknown, depth = 0): unknown {
  const parsed = depth === 0 ? parseJsonLoose(raw) : raw;
  if (depth > 10) return "[DEPTH_LIMIT]";
  if (Array.isArray(parsed)) return parsed.map(item => projectRunEventPayload(item, depth + 1));
  if (!parsed || typeof parsed !== "object") {
    if (typeof parsed === "string") return redactString(parsed).slice(0, 1_000);
    return parsed;
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (PRIVATE_EVENT_KEYS.has(key)) continue;
    output[key] = projectRunEventPayload(value, depth + 1);
  }
  return output;
}

type ReadOnlyDatabase = { database: DatabaseSync; close: () => void };

function openReadOnlyDatabase(project: WriterProject): ReadOnlyDatabase | undefined {
  const source = resolve(project.privateDir, "writer.db");
  if (!existsSync(source)) return undefined;
  // Active WAL databases on WSL-mounted drives can fail with `disk I/O error`
  // even when opened read-only. Querying a short-lived db+wal+shm snapshot also
  // avoids holding locks against the writer server.
  const snapshotDir = mkdtempSync(resolve(tmpdir(), "writer-log-audit-db-"));
  const snapshot = resolve(snapshotDir, "writer.db");
  try {
    copyFileSync(source, snapshot);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${source}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${snapshot}${suffix}`);
    }
    const database = new DatabaseSync(snapshot, { readOnly: true });
    return {
      database,
      close: () => {
        try { database.close(); } finally { rmSync(snapshotDir, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    rmSync(snapshotDir, { recursive: true, force: true });
    throw error;
  }
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function rows(
  database: DatabaseSync,
  sql: string,
  ...params: Array<string | number | bigint | null | Uint8Array>
): Row[] {
  return database.prepare(sql).all(...params) as Row[];
}

function addEvidence(
  target: LogEvidence[],
  budget: { remaining: number },
  input: Omit<LogEvidence, "id" | "capturedAt" | "bytes">,
): LogEvidence | undefined {
  const safe = redactLogValue(input.data);
  const fullBytes = byteLength(safe);
  if (budget.remaining <= 0) return undefined;
  let data = safe;
  let truncated = input.truncated;
  if (fullBytes > budget.remaining) {
    const text = JSON.stringify(safe);
    data = { truncatedJson: text.slice(0, Math.max(0, budget.remaining - 100)) };
    truncated = true;
  }
  const bytes = byteLength(data);
  budget.remaining -= bytes;
  const evidence: LogEvidence = {
    id: `ev-${String(target.length + 1).padStart(3, "0")}`,
    kind: input.kind,
    title: input.title,
    source: input.source,
    capturedAt: new Date().toISOString(),
    data,
    bytes,
    ...(truncated ? { truncated: true } : {}),
  };
  target.push(evidence);
  return evidence;
}

function cutoffIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString();
}

export function collectLogEvidence(project: WriterProject, options: LogAuditOptions = {}): LogEvidence[] {
  const scope: AuditScope = {
    sinceHours: Math.max(1, Math.min(24 * 30, Math.floor(options.sinceHours ?? 24))),
    limit: Math.max(5, Math.min(500, Math.floor(options.limit ?? 80))),
    maxEvidenceBytes: Math.max(8_000, Math.min(2_000_000, Math.floor(options.maxEvidenceBytes ?? 160_000))),
    maxRounds: Math.max(1, Math.min(6, Math.floor(options.maxRounds ?? 3))),
    ...(options.jobId ? { jobId: options.jobId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
  };
  const evidence: LogEvidence[] = [];
  const budget = { remaining: scope.maxEvidenceBytes };
  const opened = openReadOnlyDatabase(project);
  const database = opened?.database;
  const cutoff = cutoffIso(scope.sinceHours);
  try {
    const presentTables = database
      ? ["background_jobs", "agent_runs", "agent_run_events", "message_step_trails", "model_usage"]
        .filter(name => tableExists(database, name))
      : [];
    addEvidence(evidence, budget, {
      kind: "runtime_overview",
      title: "取证范围与数据源",
      source: database ? resolve(project.privateDir, "writer.db") : project.privateDir,
      data: {
        project: project.root,
        cutoff,
        jobId: scope.jobId,
        runId: scope.runId,
        tables: presentTables,
        prefixCacheLog: existsSync(prefixCacheLogPath(project.root)),
        privacy: "正文、完整对话、供应商凭据未采集；步骤仅保留状态、工具名和字符数",
      },
    });
    if (database && tableExists(database, "background_jobs")) {
      const where = scope.jobId ? "WHERE id=?" : "WHERE updated_at>=?";
      const params = scope.jobId ? [scope.jobId] : [cutoff];
      addEvidence(evidence, budget, {
        kind: "jobs", title: "近期后台 Job", source: "writer.db:background_jobs",
        data: rows(database, `SELECT id,session_id,status,source_message_id,length(terminal_message) AS terminal_chars,created_at,updated_at FROM background_jobs ${where} ORDER BY updated_at DESC LIMIT ?`, ...params, scope.limit),
      });
    }
    if (database && tableExists(database, "agent_runs")) {
      const where = scope.runId ? "WHERE id=?" : "WHERE updated_at>=?";
      const params = scope.runId ? [scope.runId] : [cutoff];
      const data = rows(database, `SELECT id,session_id,status,source_message_id,snapshot_json,created_at,updated_at FROM agent_runs ${where} ORDER BY updated_at DESC LIMIT ?`, ...params, scope.limit)
        .map(row => ({ ...row, snapshot_json: projectAgentRunSnapshot(row.snapshot_json) }));
      addEvidence(evidence, budget, {
        kind: "agent_runs", title: "近期 Agent Run 快照", source: "writer.db:agent_runs", data,
      });
    }
    if (database && tableExists(database, "model_usage")) {
      addEvidence(evidence, budget, {
        kind: "model_usage", title: "模型用量与缓存聚合", source: "writer.db:model_usage",
        data: rows(database, `SELECT call_kind,provider_name,model,count(*) AS calls,sum(prompt_tokens) AS prompt_tokens,sum(completion_tokens) AS completion_tokens,sum(cache_hit_tokens) AS cache_hit_tokens,sum(cache_miss_tokens) AS cache_miss_tokens,sum(cost) AS cost,min(created_at) AS first_at,max(created_at) AS last_at FROM model_usage WHERE created_at>=? GROUP BY call_kind,provider_name,model ORDER BY last_at DESC LIMIT ?`, cutoff, scope.limit),
      });
    }
    if (existsSync(prefixCacheLogPath(project.root)) && budget.remaining > 2_000) {
      addEvidence(evidence, budget, {
        kind: "prefix_cache", title: "Prefix cache 汇总", source: prefixCacheLogPath(project.root),
        data: summarizePrefixCacheLog(prefixCacheLogPath(project.root), { maxBytes: 8_000_000, topDivergences: 8 }),
      });
    }
    if (database && scope.runId) collectRunTrace(database, scope.runId, scope.limit, evidence, budget);
    if (database && scope.jobId) collectJobTrace(database, scope.jobId, scope.limit, evidence, budget);
  } finally {
    opened?.close();
  }
  return evidence;
}

function collectRunTrace(database: DatabaseSync, runId: string, limit: number, evidence: LogEvidence[], budget: { remaining: number }): void {
  if (!tableExists(database, "agent_run_events")) return;
  const data = rows(database, "SELECT sequence,type,payload_json,created_at FROM agent_run_events WHERE run_id=? ORDER BY sequence LIMIT ?", runId, limit)
    .map(row => ({ ...row, payload_json: projectRunEventPayload(row.payload_json) }));
  addEvidence(evidence, budget, {
    kind: "run_trace", title: `Agent Run ${runId} 事件`, source: "writer.db:agent_run_events", data,
  });
}

function collectJobTrace(database: DatabaseSync, jobId: string, limit: number, evidence: LogEvidence[], budget: { remaining: number }): void {
  const data: Record<string, unknown> = { jobId };
  if (tableExists(database, "message_step_trails")) {
    data.steps = rows(database, "SELECT session_id,source_message_id,steps_json,updated_at FROM message_step_trails WHERE job_id=? ORDER BY updated_at DESC LIMIT ?", jobId, limit)
      .map(row => ({ ...row, steps_json: compactStepTrail(row.steps_json) }));
  }
  if (tableExists(database, "model_usage")) {
    data.usage = rows(database, "SELECT call_kind,step,provider_name,model,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,cost,created_at FROM model_usage WHERE job_id=? ORDER BY id LIMIT ?", jobId, limit);
  }
  addEvidence(evidence, budget, {
    kind: "job_trace", title: `Job ${jobId} 步骤与用量`, source: "writer.db:message_step_trails+model_usage", data,
  });
}

function normalizeEvidenceRequest(value: unknown): LogEvidenceRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!["run_trace", "job_trace", "prefix_cache", "model_usage"].includes(String(item.kind))) return undefined;
  const reason = typeof item.reason === "string" ? item.reason.trim().slice(0, 500) : "";
  if (!reason) return undefined;
  const id = typeof item.id === "string" ? item.id.trim().slice(0, 200) : undefined;
  if ((item.kind === "run_trace" || item.kind === "job_trace") && !id) return undefined;
  return { kind: item.kind as LogEvidenceRequest["kind"], ...(id ? { id } : {}), reason };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* continue */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) {
    try { return JSON.parse(fenced); } catch { /* continue */ }
  }
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") starts.push(i);
    else if (char === "}" && starts.length) {
      const start = starts.pop();
      if (starts.length === 0 && start !== undefined) {
        try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { /* keep scanning */ }
      }
    }
  }
  throw new Error("分析器未返回可解析的 JSON 对象");
}

export function parseLogAnalysisTurn(text: string): LogAnalysisTurn {
  const raw = extractJsonObject(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("分析结果必须是 JSON 对象");
  const item = raw as Record<string, unknown>;
  if (item.status !== "need_evidence" && item.status !== "complete") throw new Error("分析结果 status 无效");
  return {
    status: item.status,
    ...(typeof item.summary === "string" ? { summary: item.summary } : {}),
    ...(Array.isArray(item.findings) ? { findings: item.findings } : {}),
    ...(Array.isArray(item.requests) ? { requests: item.requests } : {}),
  };
}

function validateFindings(values: unknown[] | undefined, evidence: LogEvidence[], diagnostics: string[]): LogAnalysisFinding[] {
  const validEvidence = new Set(evidence.map(item => item.id));
  const severities = new Set(["critical", "high", "medium", "low", "info"]);
  const seen = new Set<string>();
  const findings: LogAnalysisFinding[] = [];
  for (const value of values ?? []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim().slice(0, 300) : "";
    const diagnosis = typeof item.diagnosis === "string" ? item.diagnosis.trim().slice(0, 4_000) : "";
    const severity = String(item.severity);
    const evidenceIds = Array.isArray(item.evidenceIds)
      ? [...new Set(item.evidenceIds.filter((id): id is string => typeof id === "string" && validEvidence.has(id)))]
      : [];
    if (!title || !diagnosis || !severities.has(severity) || !evidenceIds.length) {
      diagnostics.push(`拒绝无效 finding：${title || "(untitled)"}`);
      continue;
    }
    const key = `${severity}\u0000${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence)
      ? Math.max(0, Math.min(1, item.confidence)) : 0.5;
    findings.push({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 100) : `finding-${findings.length + 1}`,
      severity: severity as LogAnalysisFinding["severity"],
      category: typeof item.category === "string" && item.category.trim() ? item.category.trim().slice(0, 120) : "runtime",
      title,
      diagnosis,
      evidenceIds,
      confidence,
      ...(typeof item.recommendation === "string" && item.recommendation.trim()
        ? { recommendation: item.recommendation.trim().slice(0, 4_000) } : {}),
    });
  }
  return findings;
}

function analysisPrompt(round: number, evidence: LogEvidence[], diagnostics: string[]): string {
  return `你是 Writer Agent 运行质量审计员。分析附带的版本化证据包，寻找可复现的运行错误、状态矛盾、\n` +
    `工具空转、缓存退化、成本异常与交付不完整。不要猜测未提供的正文或用户意图。\n` +
    `每个结论必须引用 evidence ID。你可以请求补取指定 run/job 的结构化轨迹。当前第 ${round} 轮。\n` +
    `只返回一个 JSON 对象，不要 Markdown。二选一：\n` +
    `{"status":"need_evidence","requests":[{"kind":"run_trace|job_trace|prefix_cache|model_usage","id":"必要时填写","reason":"..."}]}\n` +
    `或 {"status":"complete","summary":"...","findings":[{"id":"...","severity":"critical|high|medium|low|info","category":"...","title":"...","diagnosis":"...","evidenceIds":["ev-001"],"confidence":0.0,"recommendation":"..."}]}。\n` +
    `证据索引：${evidence.map(item => `${item.id}:${item.kind}:${item.title}`).join("；")}。\n` +
    (diagnostics.length ? `此前协议诊断：${diagnostics.slice(-5).join("；")}。` : "");
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function evidenceContainsIdentifier(evidence: LogEvidence[], identifier: string): boolean {
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 10) return false;
    if (Array.isArray(value)) return value.some(item => visit(item, depth + 1));
    if (!value || typeof value !== "object") return false;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "id" || key === "jobId" || key === "runId") && item === identifier) return true;
      if (visit(item, depth + 1)) return true;
    }
    return false;
  };
  return evidence.some(item => visit(item.data, 0));
}

function fulfillRequests(
  project: WriterProject,
  requests: unknown[] | undefined,
  evidence: LogEvidence[],
  remainingBytes: number,
  limit: number,
  diagnostics: string[],
  cutoff: string,
): number {
  const normalized = (requests ?? []).map(normalizeEvidenceRequest).filter((item): item is LogEvidenceRequest => Boolean(item)).slice(0, 4);
  if (!normalized.length) return remainingBytes;
  const budget = { remaining: remainingBytes };
  const opened = openReadOnlyDatabase(project);
  const database = opened?.database;
  try {
    for (const request of normalized) {
      const duplicate = request.id
        ? evidence.some(item => item.kind === request.kind && item.title.includes(request.id!))
        : evidence.filter(item => item.kind === request.kind).length >= 2;
      if (duplicate) { diagnostics.push(`忽略重复证据请求：${request.kind}:${request.id ?? ""}`); continue; }
      if (request.id && !evidenceContainsIdentifier(evidence, request.id)) {
        diagnostics.push(`拒绝未在现有证据出现的标识符：${request.kind}:${request.id}`);
        continue;
      }
      if (request.kind === "run_trace" && request.id && database) collectRunTrace(database, request.id, limit, evidence, budget);
      else if (request.kind === "job_trace" && request.id && database) collectJobTrace(database, request.id, limit, evidence, budget);
      else if (request.kind === "prefix_cache" && existsSync(prefixCacheLogPath(project.root))) {
        addEvidence(evidence, budget, {
          kind: "prefix_cache", title: "补充 Prefix cache 汇总", source: prefixCacheLogPath(project.root),
          data: summarizePrefixCacheLog(prefixCacheLogPath(project.root), { maxBytes: 24_000_000, topDivergences: 20 }),
        });
      } else if (request.kind === "model_usage" && database && tableExists(database, "model_usage")) {
        addEvidence(evidence, budget, {
          kind: "model_usage", title: "补充模型调用明细", source: "writer.db:model_usage",
          data: rows(database, "SELECT job_id,session_id,call_kind,step,provider_name,model,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,cost,created_at FROM model_usage WHERE created_at>=? ORDER BY id DESC LIMIT ?", cutoff, limit),
        });
      } else diagnostics.push(`无法满足证据请求：${request.kind}:${request.id ?? ""}`);
    }
  } finally { opened?.close(); }
  return budget.remaining;
}

export async function runLogAudit(input: {
  project: WriterProject;
  analyzer?: LogAnalyzer;
  options?: LogAuditOptions;
}): Promise<LogAuditResult> {
  const options = input.options ?? {};
  const scope: AuditScope = {
    sinceHours: Math.max(1, Math.min(24 * 30, Math.floor(options.sinceHours ?? 24))),
    limit: Math.max(5, Math.min(500, Math.floor(options.limit ?? 80))),
    maxEvidenceBytes: Math.max(8_000, Math.min(2_000_000, Math.floor(options.maxEvidenceBytes ?? 160_000))),
    maxRounds: Math.max(1, Math.min(6, Math.floor(options.maxRounds ?? 3))),
    ...(options.jobId ? { jobId: options.jobId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
  };
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const runDir = resolve(input.project.privateDir, "analysis", "log-audit", runId);
  const manifestPath = resolve(runDir, "manifest.json");
  const evidencePath = resolve(runDir, "evidence.json");
  const reportPath = resolve(runDir, "report.json");
  mkdirSync(runDir, { recursive: true });
  const evidence = collectLogEvidence(input.project, scope);
  writeJsonAtomic(evidencePath, { version: LOG_ANALYSIS_VERSION, evidence });
  const manifest: Record<string, unknown> = {
    version: LOG_ANALYSIS_VERSION, runId, status: options.collectOnly ? "collected" : "analyzing",
    project: input.project.root, scope, backend: input.analyzer?.backend, model: input.analyzer?.model,
    createdAt: new Date().toISOString(), evidencePath,
  };
  writeJsonAtomic(manifestPath, manifest);
  if (options.collectOnly) return { runId, runDir, manifestPath, evidencePath, evidence };
  if (!input.analyzer) throw new Error("执行日志分析需要 analyzer；仅取证请使用 collectOnly");

  const diagnostics: string[] = [];
  let remainingBytes = Math.max(0, scope.maxEvidenceBytes - evidence.reduce((sum, item) => sum + item.bytes, 0));
  let finalTurn: LogAnalysisTurn | undefined;
  let rounds = 0;
  try {
    for (let round = 1; round <= scope.maxRounds; round += 1) {
      rounds = round;
      writeJsonAtomic(evidencePath, { version: LOG_ANALYSIS_VERSION, evidence });
      const raw = await input.analyzer.analyze({ prompt: analysisPrompt(round, evidence, diagnostics), evidencePath, round });
      let turn: LogAnalysisTurn;
      try { turn = parseLogAnalysisTurn(raw); }
      catch (error) {
        diagnostics.push(error instanceof Error ? error.message : String(error));
        if (round === scope.maxRounds) break;
        continue;
      }
      if (turn.status === "complete") { finalTurn = turn; break; }
      const before = evidence.length;
      remainingBytes = fulfillRequests(input.project, turn.requests, evidence, remainingBytes, scope.limit, diagnostics, cutoffIso(scope.sinceHours));
      if (evidence.length === before) {
        diagnostics.push("分析器请求的证据均无效、重复或超出预算");
        if (round === scope.maxRounds) break;
      }
    }
    const findings = validateFindings(finalTurn?.findings, evidence, diagnostics);
    const report: LogAnalysisReport = {
      version: LOG_ANALYSIS_VERSION,
      status: finalTurn ? "completed" : "inconclusive",
      summary: finalTurn?.summary?.trim().slice(0, 4_000) || "分析器未在轮次预算内形成有效结论。",
      findings,
      analyzedAt: new Date().toISOString(),
      analyzer: { backend: input.analyzer.backend, model: input.analyzer.model, rounds },
      diagnostics,
    };
    writeJsonAtomic(evidencePath, { version: LOG_ANALYSIS_VERSION, evidence });
    writeJsonAtomic(reportPath, report);
    writeJsonAtomic(manifestPath, { ...manifest, status: report.status, completedAt: new Date().toISOString(), reportPath, rounds });
    return { runId, runDir, manifestPath, evidencePath, reportPath, report, evidence };
  } catch (error) {
    writeJsonAtomic(manifestPath, {
      ...manifest, status: "error", failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error), rounds,
    });
    throw error;
  }
}

export function createDirectLogAnalyzer(model: ModelConfig): LogAnalyzer {
  return {
    backend: "direct",
    model: model.model,
    async analyze({ prompt, evidencePath }) {
      const evidence = readFileSync(evidencePath, "utf8");
      const result = await completeProviderCompletion({
        model,
        messages: [
          { role: "system", content: "你是只读运行审计 Agent。严格遵循用户给出的 JSON 协议，不输出 Markdown。" },
          { role: "user", content: `${prompt}\n\n证据包：\n${evidence}` },
        ],
        responseFormat: { type: "json_object" },
        maxTokens: 4_000,
        temperature: 0.1,
      });
      return result.content;
    },
  };
}

export type OpenCodeAnalyzerOptions = {
  bin?: string;
  model: string;
  attach?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export function openCodeRunArgs(input: {
  model: string;
  evidencePath: string;
  workingDirectory: string;
  prompt: string;
  attach?: string;
}): string[] {
  return [
    "run", "--format", "json", "--agent", "plan", "--model", input.model,
    "--dir", input.workingDirectory, "--file", input.evidencePath,
    ...(input.attach ? ["--attach", input.attach] : []),
    input.prompt,
  ];
}

function textFromOpenCodeOutput(output: string): string {
  const parts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const part = event.part && typeof event.part === "object" ? event.part as Record<string, unknown> : undefined;
      if (typeof part?.text === "string") parts.push(part.text);
      else if (typeof event.text === "string") parts.push(event.text);
      else if (typeof event.content === "string") parts.push(event.content);
    } catch { /* raw diagnostic lines are not model output */ }
  }
  return parts.length ? parts.join("") : output;
}

export function createOpenCodeLogAnalyzer(options: OpenCodeAnalyzerOptions): LogAnalyzer {
  const timeoutMs = Math.max(5_000, Math.min(30 * 60_000, options.timeoutMs ?? 5 * 60_000));
  const maxOutputBytes = Math.max(8_000, Math.min(10_000_000, options.maxOutputBytes ?? 2_000_000));
  return {
    backend: "opencode",
    model: options.model,
    analyze({ prompt, evidencePath }) {
      return new Promise<string>((accept, reject) => {
        const args = openCodeRunArgs({
          model: options.model, evidencePath, workingDirectory: resolve(evidencePath, ".."), prompt,
          ...(options.attach ? { attach: options.attach } : {}),
        });
        const child = spawn(options.bin?.trim() || "opencode", args, {
          cwd: resolve(evidencePath, ".."), shell: false, windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        const finish = (error?: Error, result?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else accept(result ?? "");
        };
        const append = (target: Buffer[], chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxOutputBytes) {
            child.kill("SIGTERM");
            finish(new Error(`OpenCode 输出超过 ${maxOutputBytes} bytes`));
            return;
          }
          target.push(chunk);
        };
        child.stdout.on("data", chunk => append(stdout, Buffer.from(chunk)));
        child.stderr.on("data", chunk => append(stderr, Buffer.from(chunk)));
        child.on("error", error => finish(new Error(`无法启动 OpenCode：${error.message}`)));
        child.on("close", (code) => {
          const out = Buffer.concat(stdout).toString("utf8");
          const err = Buffer.concat(stderr).toString("utf8");
          if (code !== 0) finish(new Error(`OpenCode 退出码 ${code}：${err.slice(-2_000)}`));
          else finish(undefined, textFromOpenCodeOutput(out));
        });
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish(new Error(`OpenCode 分析超时（${timeoutMs}ms）`));
        }, timeoutMs);
      });
    },
  };
}
