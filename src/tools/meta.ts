import { loadSkillById, readSkillResource } from "../agent_runtime.js";
import type { ToolHandlerArgs } from "./types.js";
import { assertProseReferenceReadAllowed, proseReferenceReadAllowed, requireString } from "./helpers.js";
import {
  loadProseGateRules,
  removeProseGateRule,
  setProseGateRuleEnabled,
  upsertProseGateRule,
} from "../prose_gate_rules.js";
import type { ProseGateTargetKind } from "../prose_gate_rules.js";
import {
  loadAuthorPolicies,
  loadAuthorPolicyFeedback,
  recordAuthorPolicyFeedback,
  removeAuthorPolicy,
  setAuthorPolicyStatus,
  upsertAuthorPolicy,
  type AuthorPolicyEnforcement,
  type AuthorPolicyFeedbackDisposition,
  type AuthorPolicyStatus,
} from "../author_policies.js";

export function handleManageAuthorPolicies({ input, project, context }: ToolHandlerArgs): string {
  const operation = requireString(input.operation, "operation");
  if (operation === "list") {
    return JSON.stringify({ policies: loadAuthorPolicies(project), feedback: loadAuthorPolicyFeedback(project) });
  }
  if (context.permissionMode === "plan") throw new Error("plan 模式不能修改作者政策");
  if (operation === "upsert") {
    const requestedStatus = requireString(input.status, "status") as AuthorPolicyStatus;
    if (!["draft", "trial", "active", "paused", "deprecated"].includes(requestedStatus)) {
      throw new Error("status 必须是 draft/trial/active/paused/deprecated");
    }
    const policy = upsertAuthorPolicy(project, {
      id: requireString(input.id, "id"),
      title: requireString(input.title, "title"),
      userIntent: requireString(input.userIntent, "userIntent"),
      semanticCriterion: requireString(input.semanticCriterion, "semanticCriterion"),
      evidenceRequirement: requireString(input.evidenceRequirement, "evidenceRequirement"),
      allowConditions: Array.isArray(input.allowConditions) ? input.allowConditions as string[] : [],
      revisionIntent: requireString(input.revisionIntent, "revisionIntent"),
      dislikedExamples: Array.isArray(input.dislikedExamples) ? input.dislikedExamples as string[] : [],
      acceptableExamples: Array.isArray(input.acceptableExamples) ? input.acceptableExamples as string[] : [],
      scope: (() => {
        const scope = input.scope && typeof input.scope === "object"
          ? input.scope as Record<string, unknown> : {};
        return {
          documentKinds: Array.isArray(scope.documentKinds) ? scope.documentKinds as ProseGateTargetKind[] : [],
          pathPrefixes: Array.isArray(scope.pathPrefixes) ? scope.pathPrefixes as string[] : [],
          characterIds: Array.isArray(scope.characterIds) ? scope.characterIds as string[] : [],
          sceneKinds: Array.isArray(scope.sceneKinds) ? scope.sceneKinds as string[] : [],
        };
      })(),
      enforcement: (input.enforcement === "block" || input.enforcement === "advise" ? input.enforcement : "observe") as AuthorPolicyEnforcement,
      status: requestedStatus,
      ...(typeof input.skillId === "string" ? { skillId: input.skillId } : {}),
      sourceFeedback: typeof input.sourceFeedback === "string" ? input.sourceFeedback : "",
    });
    context.proseGateRules = loadProseGateRules(project);
    return JSON.stringify({ status: "saved", policy, message: policy.status === "draft"
      ? "作者要求已保存为草案；确认边界和例外后再进入试运行。"
      : "作者政策已保存；正文出口将按当前状态进行语义复审。" });
  }
  if (operation === "set_status") {
    const status = requireString(input.status, "status") as AuthorPolicyStatus;
    const policy = setAuthorPolicyStatus(project, requireString(input.id, "id"), status);
    context.proseGateRules = loadProseGateRules(project);
    return JSON.stringify({ status: "updated", policy });
  }
  if (operation === "remove") {
    const id = requireString(input.id, "id");
    const removed = removeAuthorPolicy(project, id);
    context.proseGateRules = loadProseGateRules(project);
    return JSON.stringify({ status: removed ? "removed" : "not_found", id });
  }
  if (operation === "feedback") {
    const feedback = recordAuthorPolicyFeedback(project, {
      policyId: requireString(input.id, "id"),
      disposition: requireString(input.disposition, "disposition") as AuthorPolicyFeedbackDisposition,
      ...(typeof input.issueId === "string" ? { issueId: input.issueId } : {}),
      ...(typeof input.evidence === "string" ? { evidence: input.evidence } : {}),
      ...(typeof input.note === "string" ? { note: input.note } : {}),
    });
    return JSON.stringify({ status: "recorded", feedback });
  }
  throw new Error("operation 仅支持 list、upsert、set_status、remove、feedback");
}

export function handleManageProseGates({ input, project, context }: ToolHandlerArgs): string {
  const operation = requireString(input.operation, "operation");
  if (operation === "list") {
    return JSON.stringify({ rules: loadProseGateRules(project) });
  }
  if (context.permissionMode === "plan") throw new Error("plan 模式不能修改项目复审规则");
  if (operation === "upsert") {
    const rule = upsertProseGateRule(project, {
      id: requireString(input.id, "id"),
      instruction: requireString(input.instruction, "instruction"),
      severity: input.severity === "warn" ? "warn" : "block",
      enabled: input.enabled !== false,
      documentKinds: Array.isArray(input.documentKinds) ? input.documentKinds as ProseGateTargetKind[] : undefined,
      pathPrefixes: Array.isArray(input.pathPrefixes) ? input.pathPrefixes as string[] : undefined,
      sourceFeedback: typeof input.sourceFeedback === "string" ? input.sourceFeedback : "",
    });
    context.proseGateRules = loadProseGateRules(project);
    return JSON.stringify({ status: "saved", rule, message: "作者反馈已沉淀为项目复审规则；后续正文出口会进行语义复审。" });
  }
  if (operation === "remove") {
    const id = requireString(input.id, "id");
    const removed = removeProseGateRule(project, id);
    context.proseGateRules = loadProseGateRules(project);
    return JSON.stringify({ status: removed ? "removed" : "not_found", id });
  }
  if (operation === "enable" || operation === "disable") {
    const rule = setProseGateRuleEnabled(project, requireString(input.id, "id"), operation === "enable");
    context.proseGateRules = loadProseGateRules(project);
    return JSON.stringify({ status: operation === "enable" ? "enabled" : "disabled", rule });
  }
  throw new Error("operation 仅支持 list、upsert、enable、disable、remove");
}

export function handleAskUser({ input }: ToolHandlerArgs): string {
  const question = requireString(input.question, "question").slice(0, 300);
  const rawOptions = Array.isArray(input.options)
    ? input.options.filter((v): v is string => typeof v === "string").slice(0, 5)
    : [];
  const options = rawOptions.length >= 2 ? rawOptions : undefined;
  const message = options
    ? `${question}\n\n${options.map((opt, i) => `选项 ${i + 1}：${opt}`).join("\n")}`
    : question;
  return JSON.stringify({ status: "waiting", message: "问题已提交，等待用户回复", displayMessage: message, question, options: options ?? undefined });
}

export function handleLoadSkill({ input, project }: ToolHandlerArgs): string {
  const skill = loadSkillById(project, requireString(input.id, "id"));
  if (!skill) throw new Error("未找到该技能；请核对系统提示中的技能目录");
  return JSON.stringify({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    manifest: skill.manifest,
    resources: skill.resources,
    validationErrors: skill.validationErrors,
    content: skill.body,
  });
}

export function handleReadSkillResource({ input, project }: ToolHandlerArgs): string {
  const result = readSkillResource(
    project,
    requireString(input.skillId, "skillId"),
    requireString(input.path, "path"),
    Number(input.offset ?? 0),
    Number(input.limit ?? 4_000),
  );
  return JSON.stringify({
    status: "skill_resource_page",
    ...result,
    message: "仅在当前页不足以执行 Skill 时继续读取下一页；不要重复读取已有页。",
  });
}

export function handleSearchSessionArtifacts({ input, store, sessionId, context }: ToolHandlerArgs): string {
  const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : undefined;
  const path = typeof input.path === "string" && input.path.trim() ? input.path.trim() : undefined;
  const status = typeof input.status === "string" && input.status.trim() ? input.status.trim() : undefined;
  const query = typeof input.query === "string" ? input.query.trim().toLocaleLowerCase() : "";
  const limit = Math.max(1, Math.min(50, Math.floor(Number(input.limit ?? 20)) || 20));
  const allowedStatuses = new Set([
    "active", "blocked", "resolved", "submitted", "applied", "superseded", "rejected", "stale",
  ]);
  if (status && !allowedStatuses.has(status)) throw new Error("未知 artifact 状态");
  let accessFiltered = 0;
  const artifacts = store.findSessionArtifacts(sessionId, {
    ...(kind ? { kinds: [kind] } : {}),
    ...(path ? { path } : {}),
    ...(status ? { statuses: [status as never] } : {}),
    limit: query ? 100 : limit,
  }).filter(item => {
    if (item.path && !proseReferenceReadAllowed(context, item.path)) {
      accessFiltered += 1;
      return false;
    }
    return true;
  }).filter(item => !query || [item.kind, item.path, item.digest, JSON.stringify(item.metadata)]
    .filter(Boolean).join(" ").toLocaleLowerCase().includes(query))
    .slice(0, limit)
    .map(item => ({
      artifactId: item.id,
      kind: item.kind,
      status: item.status,
      path: item.path,
      sourceHash: item.sourceHash,
      digest: item.digest,
      metadata: item.metadata,
      updatedAt: item.updatedAt,
    }));
  return JSON.stringify({
    status: "artifact_catalog",
    artifacts,
    count: artifacts.length,
    ...(accessFiltered ? {
      accessFiltered,
      message: "另有会话产物因本轮未解锁的正文或卷访问边界不可见；如确需使用，请由用户解锁对应范围。",
    } : {}),
  });
}

export function handleReadContextArtifact({ input, store, sessionId, context }: ToolHandlerArgs): string {
  const artifactId = Number(input.artifactId);
  if (!Number.isInteger(artifactId) || artifactId <= 0) throw new Error("artifactId 必须是正整数");
  const artifact = store.sessionArtifactById(sessionId, artifactId);
  if (!artifact) throw new Error("工作记忆不存在或不属于当前会话");
  if (artifact.path) assertProseReferenceReadAllowed(context, artifact.path);
  const offset = Math.max(0, Math.floor(Number(input.offset ?? 0)) || 0);
  const limit = Math.max(500, Math.min(6_000, Math.floor(Number(input.limit ?? 4_000)) || 4_000));
  const content = artifact.content.slice(offset, offset + limit);
  return JSON.stringify({
    status: "artifact_page",
    artifactId,
    kind: artifact.kind,
    artifactStatus: artifact.status,
    path: artifact.path,
    sourceHash: artifact.sourceHash,
    metadata: artifact.metadata,
    relations: store.sessionArtifactRelations(sessionId, artifact.id),
    offset,
    nextOffset: offset + content.length,
    totalCharacters: artifact.content.length,
    hasMore: offset + content.length < artifact.content.length,
    content,
    message: "仅在当前页不足以完成任务时读取下一页；禁止从头重复读取。",
  });
}
