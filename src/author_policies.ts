import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { logModelRequest, logModelResponse } from "./model_debug.js";
import { samplingRequestOptions } from "./model_compat.js";
import { modelCompletionEndpoint, parseProviderCompletionPayload } from "./model_api.js";
import { modelFetch } from "./model_fetch.js";
import type { DocumentKind, WriterProject } from "./project.js";
import type { ModelConfig } from "./types.js";
import type { ProseGateRule, ProseGateTargetKind } from "./prose_gate_rules.js";

export type AuthorPolicyStatus = "draft" | "trial" | "active" | "paused" | "deprecated";
export type AuthorPolicyEnforcement = "observe" | "advise" | "block";
export type AuthorPolicyFeedbackDisposition = "accepted" | "dismissed" | "edited" | "false_positive";

export interface AuthorPolicyScope {
  documentKinds: ProseGateTargetKind[];
  pathPrefixes: string[];
  characterIds: string[];
  sceneKinds: string[];
}

export interface AuthorPolicy {
  id: string;
  title: string;
  userIntent: string;
  semanticCriterion: string;
  evidenceRequirement: string;
  allowConditions: string[];
  revisionIntent: string;
  dislikedExamples: string[];
  acceptableExamples: string[];
  scope: AuthorPolicyScope;
  enforcement: AuthorPolicyEnforcement;
  status: AuthorPolicyStatus;
  skillId?: string;
  version: number;
  sourceFeedback: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorPolicyFeedback {
  id: string;
  policyId: string;
  policyVersion: number;
  disposition: AuthorPolicyFeedbackDisposition;
  issueId?: string;
  evidence?: string;
  note?: string;
  createdAt: string;
}

export type AuthorPolicyDraft = Omit<AuthorPolicy, "createdAt" | "updatedAt" | "version"> & { version?: number };

const POLICY_STATUSES = new Set<AuthorPolicyStatus>(["draft", "trial", "active", "paused", "deprecated"]);
const POLICY_ENFORCEMENTS = new Set<AuthorPolicyEnforcement>(["observe", "advise", "block"]);
const POLICY_DISPOSITIONS = new Set<AuthorPolicyFeedbackDisposition>(["accepted", "dismissed", "edited", "false_positive"]);
const TARGET_KINDS = new Set<ProseGateTargetKind>([
  "lore", "outline", "chapter", "archive", "side", "other", "writing_example",
]);
const MAX_AUTHOR_POLICIES = 200;
export const MAX_ACTIVE_AUTHOR_POLICIES = 24;

function policiesPath(project: WriterProject): string {
  return resolve(project.privateDir, "author-policies.json");
}

function feedbackPath(project: WriterProject): string {
  return resolve(project.privateDir, "author-policy-feedback.json");
}

function bounded(value: unknown, field: string, maximum: number, required = true): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new Error(`${field} 不能为空`);
  return text.slice(0, maximum);
}

function policyId(value: unknown): string {
  const id = bounded(value, "id", 64).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) throw new Error("政策 ID 只能使用小写字母、数字和单连字符");
  return id;
}

function uniqueStrings(value: unknown, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap(item => typeof item === "string" && item.trim()
    ? [item.trim().slice(0, maximumLength)] : []))].slice(0, maximumItems);
}

function normalizePathPrefixes(value: unknown): string[] {
  return uniqueStrings(value, 12, 300)
    .map(item => item.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, ""))
    .filter(Boolean);
}

function normalizeScope(value: unknown): AuthorPolicyScope {
  const item = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    documentKinds: uniqueStrings(item.documentKinds, TARGET_KINDS.size, 40)
      .filter((kind): kind is ProseGateTargetKind => TARGET_KINDS.has(kind as ProseGateTargetKind)),
    pathPrefixes: normalizePathPrefixes(item.pathPrefixes),
    characterIds: uniqueStrings(item.characterIds, 100, 100),
    sceneKinds: uniqueStrings(item.sceneKinds, 40, 100),
  };
}

function normalizePolicy(value: unknown, existing?: AuthorPolicy): AuthorPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("作者政策必须是对象");
  const item = value as Record<string, unknown>;
  const now = new Date().toISOString();
  const status = typeof item.status === "string" && POLICY_STATUSES.has(item.status as AuthorPolicyStatus)
    ? item.status as AuthorPolicyStatus : existing?.status ?? "draft";
  let enforcement = typeof item.enforcement === "string" && POLICY_ENFORCEMENTS.has(item.enforcement as AuthorPolicyEnforcement)
    ? item.enforcement as AuthorPolicyEnforcement : existing?.enforcement ?? "observe";
  const allowConditions = uniqueStrings(item.allowConditions, 20, 300);
  const evidenceRequirement = bounded(item.evidenceRequirement, "evidenceRequirement", 600);
  // A hard gate without explicit release conditions is unsafe. Keep the policy,
  // but downgrade enforcement until the author supplies the missing boundary.
  if (enforcement === "block" && !allowConditions.length) enforcement = "advise";
  return {
    id: policyId(item.id),
    title: bounded(item.title, "title", 100),
    userIntent: bounded(item.userIntent, "userIntent", 1_000),
    semanticCriterion: bounded(item.semanticCriterion, "semanticCriterion", 1_200),
    evidenceRequirement,
    allowConditions,
    revisionIntent: bounded(item.revisionIntent, "revisionIntent", 600),
    dislikedExamples: uniqueStrings(item.dislikedExamples, 20, 1_000),
    acceptableExamples: uniqueStrings(item.acceptableExamples, 20, 1_000),
    scope: normalizeScope(item.scope),
    enforcement,
    status,
    ...(typeof item.skillId === "string" && item.skillId.trim()
      ? { skillId: item.skillId.trim().slice(0, 64) } : existing?.skillId ? { skillId: existing.skillId } : {}),
    version: existing ? existing.version + 1 : Number.isInteger(item.version) && Number(item.version) > 0 ? Number(item.version) : 1,
    sourceFeedback: bounded(item.sourceFeedback, "sourceFeedback", 1_000, false),
    createdAt: existing?.createdAt ?? (typeof item.createdAt === "string" ? item.createdAt : now),
    updatedAt: now,
  };
}

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.writer-tmp-${process.pid}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(temporary, content, "utf8");
  try { renameSync(temporary, path); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
    writeFileSync(path, content, "utf8");
    try { unlinkSync(temporary); } catch { /* Later writes replace stale temporary files. */ }
  }
}

export function loadAuthorPolicies(project: WriterProject): AuthorPolicy[] {
  const path = policiesPath(project);
  if (!existsSync(path)) return [];
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(".writer/author-policies.json 格式无效"); }
  if (!Array.isArray(value)) throw new Error(".writer/author-policies.json 必须是数组");
  return value.slice(0, MAX_AUTHOR_POLICIES).flatMap(item => {
    try { return [normalizePolicyForLoad(item)]; }
    catch { return []; }
  });
}

function normalizePolicyForLoad(value: unknown): AuthorPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("作者政策必须是对象");
  const item = value as Record<string, unknown>;
  const now = new Date().toISOString();
  const enforcement = typeof item.enforcement === "string" && POLICY_ENFORCEMENTS.has(item.enforcement as AuthorPolicyEnforcement)
    ? item.enforcement as AuthorPolicyEnforcement : "observe";
  const status = typeof item.status === "string" && POLICY_STATUSES.has(item.status as AuthorPolicyStatus)
    ? item.status as AuthorPolicyStatus : "draft";
  return {
    id: policyId(item.id),
    title: bounded(item.title, "title", 100),
    userIntent: bounded(item.userIntent, "userIntent", 1_000),
    semanticCriterion: bounded(item.semanticCriterion, "semanticCriterion", 1_200),
    evidenceRequirement: bounded(item.evidenceRequirement, "evidenceRequirement", 600),
    allowConditions: uniqueStrings(item.allowConditions, 20, 300),
    revisionIntent: bounded(item.revisionIntent, "revisionIntent", 600),
    dislikedExamples: uniqueStrings(item.dislikedExamples, 20, 1_000),
    acceptableExamples: uniqueStrings(item.acceptableExamples, 20, 1_000),
    scope: normalizeScope(item.scope),
    enforcement: enforcement === "block" && !uniqueStrings(item.allowConditions, 20, 300).length ? "advise" : enforcement,
    status,
    ...(typeof item.skillId === "string" && item.skillId.trim() ? { skillId: item.skillId.trim().slice(0, 64) } : {}),
    version: Number.isInteger(item.version) && Number(item.version) > 0 ? Number(item.version) : 1,
    sourceFeedback: bounded(item.sourceFeedback, "sourceFeedback", 1_000, false),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
  };
}

export function upsertAuthorPolicy(project: WriterProject, input: AuthorPolicyDraft | AuthorPolicy): AuthorPolicy {
  const policies = loadAuthorPolicies(project);
  const id = policyId(input.id);
  const existing = policies.find(policy => policy.id === id);
  if (!existing && policies.length >= MAX_AUTHOR_POLICIES) throw new Error(`作者政策最多 ${MAX_AUTHOR_POLICIES} 条`);
  const next = normalizePolicy(input, existing);
  if (next.status === "active" || next.status === "trial") {
    const activeCount = policies.filter(policy => policy.id !== id
      && (policy.status === "active" || policy.status === "trial")).length;
    if (activeCount >= MAX_ACTIVE_AUTHOR_POLICIES) {
      throw new Error(`同时生效和试运行的作者政策最多 ${MAX_ACTIVE_AUTHOR_POLICIES} 条；请暂停不相关政策`);
    }
  }
  if (existing) policies[policies.indexOf(existing)] = next;
  else policies.push(next);
  atomicWrite(policiesPath(project), policies);
  return next;
}

export function setAuthorPolicyStatus(project: WriterProject, idValue: string, status: AuthorPolicyStatus): AuthorPolicy {
  if (!POLICY_STATUSES.has(status)) throw new Error("作者政策状态无效");
  const policy = loadAuthorPolicies(project).find(item => item.id === policyId(idValue));
  if (!policy) throw new Error("作者政策不存在");
  return upsertAuthorPolicy(project, { ...policy, status });
}

export function removeAuthorPolicy(project: WriterProject, idValue: string): boolean {
  const id = policyId(idValue);
  const policies = loadAuthorPolicies(project);
  const next = policies.filter(policy => policy.id !== id);
  if (next.length === policies.length) return false;
  atomicWrite(policiesPath(project), next);
  return true;
}

export function recordAuthorPolicyFeedback(
  project: WriterProject,
  input: Omit<AuthorPolicyFeedback, "id" | "createdAt" | "policyVersion"> & { policyVersion?: number },
): AuthorPolicyFeedback {
  if (!POLICY_DISPOSITIONS.has(input.disposition)) throw new Error("反馈处置类型无效");
  const policy = loadAuthorPolicies(project).find(item => item.id === policyId(input.policyId));
  if (!policy) throw new Error("作者政策不存在");
  const path = feedbackPath(project);
  let rows: AuthorPolicyFeedback[] = [];
  if (existsSync(path)) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(value)) rows = value as AuthorPolicyFeedback[];
    } catch { throw new Error(".writer/author-policy-feedback.json 格式无效"); }
  }
  const createdAt = new Date().toISOString();
  const feedback: AuthorPolicyFeedback = {
    id: `feedback-${createHash("sha256").update(`${policy.id}:${createdAt}:${rows.length}`).digest("hex").slice(0, 12)}`,
    policyId: policy.id,
    policyVersion: input.policyVersion ?? policy.version,
    disposition: input.disposition,
    ...(input.issueId?.trim() ? { issueId: input.issueId.trim().slice(0, 160) } : {}),
    ...(input.evidence?.trim() ? { evidence: input.evidence.trim().slice(0, 1_000) } : {}),
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, 1_000) } : {}),
    createdAt,
  };
  rows.push(feedback);
  atomicWrite(path, rows.slice(-2_000));
  return feedback;
}

export function loadAuthorPolicyFeedback(project: WriterProject, policyIdValue?: string): AuthorPolicyFeedback[] {
  const path = feedbackPath(project);
  if (!existsSync(path)) return [];
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { return []; }
  if (!Array.isArray(value)) return [];
  const id = policyIdValue ? policyId(policyIdValue) : undefined;
  return (value as AuthorPolicyFeedback[]).filter(row => !id || row.policyId === id).slice(-500);
}

export function authorPolicyGateRules(project: WriterProject): ProseGateRule[] {
  return loadAuthorPolicies(project)
    .filter(policy => policy.status === "trial" || policy.status === "active")
    .slice(0, MAX_ACTIVE_AUTHOR_POLICIES)
    .map(policy => ({
      id: `policy-${policy.id}`,
      label: policy.title,
      instruction: [
        policy.semanticCriterion,
        `证据要求：${policy.evidenceRequirement}`,
        policy.allowConditions.length ? `放行条件：${policy.allowConditions.join("；")}` : "",
        policy.status === "trial" ? "当前为试运行：只记录确定命中，不得阻断交付。" : "",
      ].filter(Boolean).join("\n").slice(0, 2_400),
      revisionIntent: policy.revisionIntent,
      kind: policy.enforcement === "block" && policy.status === "active" ? "hard_gate" : "style_preference",
      severity: policy.enforcement === "block" && policy.status === "active" ? "block" : "warn",
      enabled: true,
      builtIn: false,
      documentKinds: policy.scope.documentKinds,
      pathPrefixes: policy.scope.pathPrefixes,
      sourceFeedback: policy.sourceFeedback,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
      policyId: policy.id,
      policyVersion: policy.version,
      ...(policy.skillId ? { skillId: policy.skillId } : {}),
      enforcement: policy.enforcement,
      policyStatus: policy.status as "trial" | "active",
    }));
}

const POLICY_COMPILER_SYSTEM = `你是小说作者政策编译器。把作者的自然语言反馈整理成一项可确认、可试运行的写作政策，不直接修改正文。

区分长期偏好与一次性修改。若反馈无法形成可复用标准，仍生成 draft，但在 semanticCriterion 明确说明需要作者补充的边界。不得用关键词、正则或固定句长代替语义标准。

必须给出：作者意图、可独立执行的语义核验标准、命中时必须引用的证据、至少一条放行条件、局部修订目标。事实与连续性错误可建议 block；审美、句式、对白自然度默认 advise；含糊反馈默认 observe。status 永远输出 draft。

只输出 JSON 对象：id（小写英文数字连字符）、title、userIntent、semanticCriterion、evidenceRequirement、allowConditions、revisionIntent、dislikedExamples、acceptableExamples、enforcement(observe|advise|block)、status(draft)、skillId（可为空）。不要 Markdown。`;

function jsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("政策编译模型没有返回 JSON 对象");
  const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("政策编译结果无效");
  return value as Record<string, unknown>;
}

export async function compileAuthorPolicyDraft(options: {
  model: ModelConfig;
  feedback: string;
  scope?: Partial<AuthorPolicyScope>;
  existingPolicies?: Array<Pick<AuthorPolicy, "id" | "title" | "userIntent">>;
  signal?: AbortSignal;
}): Promise<AuthorPolicyDraft> {
  const feedback = bounded(options.feedback, "feedback", 4_000);
  if (!options.model.apiKey && !options.model.baseUrl.includes("localhost") && !options.model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未配置可用的作者政策编译模型");
  }
  const endpoint = modelCompletionEndpoint(options.model);
  const messages = [
    { role: "system" as const, content: POLICY_COMPILER_SYSTEM },
    { role: "user" as const, content: JSON.stringify({
      feedback,
      requestedScope: options.scope ?? {},
      existingPolicies: options.existingPolicies?.slice(0, 50) ?? [],
    }) },
  ];
  const body = JSON.stringify({
    model: options.model.model,
    messages,
    stream: false,
    ...samplingRequestOptions(options.model, { temperature: 0 }),
  });
  logModelRequest(endpoint, body);
  const timeout = AbortSignal.timeout(20_000);
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
  if (!response.ok) throw new Error(`作者政策编译失败（${response.status}）：${responseBody.slice(0, 240)}`);
  const parsedPayload = JSON.parse(responseBody) as Parameters<typeof parseProviderCompletionPayload>[0];
  const candidate = jsonObject(parseProviderCompletionPayload(parsedPayload).content);
  const generatedId = typeof candidate.id === "string"
    ? candidate.id.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64)
    : "";
  const fallbackId = `author-policy-${createHash("sha256").update(feedback).digest("hex").slice(0, 10)}`;
  const draft = {
    ...candidate,
    id: generatedId && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(generatedId) ? generatedId : fallbackId,
    sourceFeedback: feedback,
    status: "draft",
    scope: normalizeScope(options.scope),
  };
  const normalized = normalizePolicy(draft);
  return {
    id: normalized.id,
    title: normalized.title,
    userIntent: normalized.userIntent,
    semanticCriterion: normalized.semanticCriterion,
    evidenceRequirement: normalized.evidenceRequirement,
    allowConditions: normalized.allowConditions,
    revisionIntent: normalized.revisionIntent,
    dislikedExamples: normalized.dislikedExamples,
    acceptableExamples: normalized.acceptableExamples,
    scope: normalized.scope,
    enforcement: normalized.enforcement,
    status: "draft",
    ...(normalized.skillId ? { skillId: normalized.skillId } : {}),
    sourceFeedback: normalized.sourceFeedback,
  };
}

export function authorPoliciesForTarget(
  policies: AuthorPolicy[],
  target: { kind: DocumentKind | "writing_example"; path?: string; characterIds?: string[]; sceneKinds?: string[] },
): AuthorPolicy[] {
  const path = target.path?.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  const characters = new Set(target.characterIds ?? []);
  const scenes = new Set(target.sceneKinds ?? []);
  return policies.filter(policy => {
    if (policy.status !== "trial" && policy.status !== "active") return false;
    if (policy.scope.documentKinds.length && !policy.scope.documentKinds.includes(target.kind)) return false;
    if (policy.scope.pathPrefixes.length && (!path || !policy.scope.pathPrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`)))) return false;
    if (policy.scope.characterIds.length && !policy.scope.characterIds.some(id => characters.has(id))) return false;
    if (policy.scope.sceneKinds.length && !policy.scope.sceneKinds.some(kind => scenes.has(kind))) return false;
    return true;
  });
}
