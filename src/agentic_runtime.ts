import type { AgentTodoItem, PermissionMode } from "./types.js";

export type AgentTaskOutcome = "answer" | "document" | "character" | "review" | "multiple";
export type AgentEvidenceRequirement = "none" | "project" | "target" | "continuation";
export type AgentMutationRequirement = "none" | "document" | "character" | "mixed";
export type AgentPlanningStrategy = "direct" | "adaptive";
export type AgentCapability = "research" | "documents" | "files" | "outline" | "scenes" | "characters" | "review";

/**
 * A semantic contract, not a fixed workflow. The executor may revise its plan and
 * combine any visible capabilities, while the harness owns these completion and
 * mutation boundaries.
 */
export interface AgentTaskContract {
  mode: string;
  outcome: AgentTaskOutcome;
  evidence: AgentEvidenceRequirement;
  mutation: AgentMutationRequirement;
  planning: AgentPlanningStrategy;
  capabilities: AgentCapability[];
}

export interface AgentExecutionProgress {
  successfulTools: Set<string>;
  failedTools: Map<string, number>;
  reusableEvidence: boolean;
  documentArtifactProduced: boolean;
  characterArtifactProduced: boolean;
}

const PROJECT_EVIDENCE_TOOLS = new Set([
  "search_project", "read_document", "read_document_span", "get_outline_node",
  "get_character", "get_simple_character", "read_file", "read_conversation",
  "read_context_artifact",
]);

const TARGET_EVIDENCE_TOOLS = new Set([
  "inspect_document", "locate_document_span", "read_document", "read_document_span",
  "inspect_file", "read_file", "get_outline_node", "get_character", "get_simple_character",
  "read_context_artifact",
]);

const CONTINUATION_EVIDENCE_TOOLS = new Set([
  "read_document", "read_document_span", "read_context_artifact", "inspect_chapter_draft",
]);

const DOCUMENT_MUTATION_TOOLS = new Set([
  "propose_outline_patch", "propose_document", "propose_document_patch", "propose_change_set",
  "revise_document_isolated", "begin_chapter_draft", "write_chapter_scene",
  "revise_chapter_scene_guide", "revise_chapter_draft_style", "inspect_chapter_draft",
  "propose_chapter_draft",
]);

const CHARACTER_MUTATION_TOOLS = new Set([
  "save_character", "apply_character_changes", "save_simple_character",
]);

export function createAgentExecutionProgress(reusableEvidence = false): AgentExecutionProgress {
  return {
    successfulTools: new Set(),
    failedTools: new Map(),
    reusableEvidence,
    documentArtifactProduced: false,
    characterArtifactProduced: false,
  };
}

export function resolveAgentPlanningStrategy(
  mutation: AgentMutationRequirement,
  requested: unknown,
  suggestedSteps: number,
): AgentPlanningStrategy {
  if (mutation !== "none") return "adaptive";
  if (requested === "adaptive" || requested === "direct") return requested;
  return suggestedSteps > 1 ? "adaptive" : "direct";
}

export function recordAgentToolResult(
  progress: AgentExecutionProgress,
  toolName: string,
  result: Record<string, unknown> | undefined,
): void {
  const failed = !result || "error" in result || result.status === "error" || result.status === "failed";
  if (failed) {
    progress.failedTools.set(toolName, (progress.failedTools.get(toolName) ?? 0) + 1);
    return;
  }
  progress.successfulTools.add(toolName);
  progress.failedTools.delete(toolName);
  if (["propose_outline_patch", "propose_document", "propose_document_patch", "propose_change_set", "revise_document_isolated", "propose_chapter_draft"].includes(toolName)) {
    progress.documentArtifactProduced = true;
  }
  if (toolName === "inspect_chapter_draft" && result.proposalSubmitted === true) {
    progress.documentArtifactProduced = true;
  }
  if (["save_character", "save_simple_character"].includes(toolName)
    || (toolName === "apply_character_changes" && Array.isArray(result.applied) && result.applied.length > 0)) {
    progress.characterArtifactProduced = true;
  }
}

function hasEvidence(contract: AgentTaskContract, progress: AgentExecutionProgress): boolean {
  if (contract.evidence === "none" || progress.reusableEvidence) return true;
  const required = contract.evidence === "project"
    ? PROJECT_EVIDENCE_TOOLS
    : contract.evidence === "target"
      ? TARGET_EVIDENCE_TOOLS
      : CONTINUATION_EVIDENCE_TOOLS;
  return [...progress.successfulTools].some(name => required.has(name));
}

export function agentCompletionGaps(
  contract: AgentTaskContract,
  progress: AgentExecutionProgress,
  todos: AgentTodoItem[],
): string[] {
  const gaps: string[] = [];
  if (!hasEvidence(contract, progress)) {
    gaps.push(contract.evidence === "project"
      ? "尚未通过项目检索或读取取得事实依据"
      : contract.evidence === "target"
        ? "尚未定位并读取目标资料"
        : "尚未取得可承接的正文末尾或工作记忆");
  }
  if ((contract.mutation === "document" || contract.mutation === "mixed") && !progress.documentArtifactProduced) {
    gaps.push("尚未成功提交文档提案或 change set");
  }
  if ((contract.mutation === "character" || contract.mutation === "mixed") && !progress.characterArtifactProduced) {
    gaps.push("尚未成功保存或更新角色卡");
  }
  if (contract.planning === "adaptive" && todos.length
    && todos.some(todo => todo.status === "pending" || todo.status === "in_progress")) {
    gaps.push("动态任务清单仍有未完成步骤");
  }
  return gaps;
}

export function completionRecoveryPrompt(gaps: string[], progress: AgentExecutionProgress): string {
  const repeatedFailures = [...progress.failedTools]
    .filter(([, count]) => count >= 2)
    .map(([name, count]) => `${name}×${count}`);
  return [
    "运行时完成检查未通过，请继续执行，不要用文字声称已经完成。",
    `缺口：${gaps.join("；") || "未知"}。`,
    repeatedFailures.length
      ? `重复失败：${repeatedFailures.join("、")}。请调用 manage_todos 修订剩余计划并换用可行路径；若确实缺少不可推断的信息，再 ask_user。`
      : "请依据已有工具结果选择下一项最小可验证动作；发现原计划不成立时可调用 manage_todos 更新计划。",
  ].join("\n");
}

/** Tools remain visible in a stable catalog; this policy only guards side effects. */
export function contractAllowsTool(
  contract: AgentTaskContract,
  permissionMode: PermissionMode,
  toolName: string,
): boolean {
  if (permissionMode === "plan" && (DOCUMENT_MUTATION_TOOLS.has(toolName) || CHARACTER_MUTATION_TOOLS.has(toolName))) {
    return false;
  }
  if (DOCUMENT_MUTATION_TOOLS.has(toolName)) {
    return contract.mutation === "document" || contract.mutation === "mixed";
  }
  if (CHARACTER_MUTATION_TOOLS.has(toolName)) {
    // Narrative documents may apply evidence-backed character evolution as part
    // of the same requested artifact, but cannot create unrelated cards.
    if (toolName === "apply_character_changes" && contract.mutation === "document") return true;
    return contract.mutation === "character" || contract.mutation === "mixed";
  }
  return true;
}
