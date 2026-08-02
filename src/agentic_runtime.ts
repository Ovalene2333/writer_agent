import type { AgentRunDocumentEvidence, AgentRunState, AgentTodoItem, PermissionMode } from "./types.js";
import { classifyAgentToolOutcome, isSuccessfulDocumentSubmission, proposalIdFromToolResult } from "./agent_runtime.js";
import {
  inferWritingQualityProfile,
  inferWritingWorkflowKind,
  writingWorkflowCompletionGaps,
  writingWorkflowStagesForTool,
  type WritingQualityProfile,
  type WritingWorkflowKind,
  type WritingWorkflowStage,
} from "./writing_workflow.js";

export type AgentTaskOutcome = "answer" | "document" | "character" | "review" | "multiple";
export type AgentEvidenceRequirement = "none" | "project" | "target" | "continuation";
export type AgentMutationRequirement = "none" | "document" | "character" | "mixed";
export type AgentPlanningStrategy = "direct" | "adaptive";
export type AgentCapability = "research" | "documents" | "files" | "outline" | "scenes" | "characters" | "review" | "images";

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
  documentProposalRequired?: boolean;
  /** Runtime writing graph hint; it guides execution without freezing a path. */
  workflow?: WritingWorkflowKind;
  /** Quality gate intensity selected from task shape and runtime settings. */
  qualityProfile?: WritingQualityProfile;
  /** A semantic planner decision that must be persisted before the turn can finish. */
  proseGateRequired?: boolean;
  /** Unordered user-visible document outputs. It constrains completion, never action order. */
  documentDeliverables?: readonly string[];
}

export interface AgentExecutionProgress {
  successfulTools: Set<string>;
  failedTools: Map<string, number>;
  reusableEvidence: boolean;
  documentArtifactProduced: boolean;
  documentArtifactKeys: Set<string>;
  characterArtifactProduced: boolean;
  imageArtifactProduced: boolean;
  proseGateRuleSaved: boolean;
  workflowStages: Set<WritingWorkflowStage>;
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
  "propose_outline_patch", "propose_document", "write_document_isolated", "propose_document_patch", "propose_change_set",
  "revise_document_isolated", "begin_chapter_draft", "write_chapter_scene", "write_chapter_scene_notes",
  "revise_chapter_scene_guide", "revise_chapter_draft_style", "inspect_chapter_draft",
  "propose_chapter_draft",
]);

const CHARACTER_MUTATION_TOOLS = new Set([
  "save_character", "apply_character_changes", "save_simple_character",
]);

const IMAGE_MUTATION_TOOLS = new Set(["generate_image"]);

export function createAgentExecutionProgress(reusableEvidence = false): AgentExecutionProgress {
  return {
    successfulTools: new Set(),
    failedTools: new Map(),
    reusableEvidence,
    documentArtifactProduced: false,
    documentArtifactKeys: new Set(),
    characterArtifactProduced: false,
    imageArtifactProduced: false,
    proseGateRuleSaved: false,
    workflowStages: new Set(),
  };
}

export { inferWritingQualityProfile, inferWritingWorkflowKind };

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
  const outcome = classifyAgentToolOutcome(toolName, result);
  if (outcome.kind !== "success") {
    progress.failedTools.set(toolName, (progress.failedTools.get(toolName) ?? 0) + 1);
    return;
  }
  if (!result) return;
  progress.successfulTools.add(toolName);
  progress.failedTools.delete(toolName);
  if (result && isSuccessfulDocumentSubmission(toolName, result)) {
    const proposalId = proposalIdFromToolResult(result);
    const changeSetId = typeof result.changeSetId === "number" && result.changeSetId > 0 ? result.changeSetId : undefined;
    const fallback = typeof result.path === "string" && result.path
      ? `${toolName}:path:${result.path}:${typeof result.sourceHash === "string" ? result.sourceHash : ""}`
      : undefined;
    const key = proposalId !== undefined
      ? `proposal:${proposalId}`
      : changeSetId !== undefined ? `change-set:${changeSetId}` : fallback;
    if (key) progress.documentArtifactKeys.add(key);
    progress.documentArtifactProduced = true;
  }
  if (["save_character", "save_simple_character"].includes(toolName)
    || (toolName === "apply_character_changes" && Array.isArray(result.applied) && result.applied.length > 0)) {
    progress.characterArtifactProduced = true;
  }
  if (toolName === "generate_image" && result.status === "generated") progress.imageArtifactProduced = true;
  if (toolName === "manage_prose_gates" && result.status === "saved") {
    progress.proseGateRuleSaved = true;
  }
  for (const stage of writingWorkflowStagesForTool(toolName, result)) {
    progress.workflowStages.add(stage);
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
  _todos: AgentTodoItem[],
): string[] {
  const gaps: string[] = [];
  if (!hasEvidence(contract, progress)) {
    gaps.push(contract.evidence === "project"
      ? "尚未通过项目检索或读取取得事实依据"
      : contract.evidence === "target"
        ? "尚未定位并读取目标资料"
        : "尚未取得可承接的正文末尾或工作记忆");
  }
  if (contract.mutation === "document" || contract.mutation === "mixed") {
    const required = Math.max(1, contract.documentDeliverables?.length ?? 0);
    const completed = progress.documentArtifactKeys.size;
    if (completed < required) {
      gaps.push(required === 1
        ? "尚未成功提交文档提案或 change set"
        : `文档交付尚未完成：要求 ${required} 份，已有 ${completed} 份可验证提案`);
    }
  }
  if ((contract.mutation === "character" || contract.mutation === "mixed") && !progress.characterArtifactProduced) {
    gaps.push("尚未成功保存或更新角色卡");
  }
  if (contract.capabilities.includes("images") && !progress.imageArtifactProduced) {
    gaps.push("尚未成功生成用户要求的图片");
  }
  if (contract.proseGateRequired && !progress.proseGateRuleSaved) {
    gaps.push("尚未把 planning 识别出的可复用作者反馈保存为复审规则");
  }
  gaps.push(...writingWorkflowCompletionGaps(contract, progress.workflowStages));
  return gaps;
}

export function createAgentRunState(
  originalRequest: string,
  documentDeliverables: readonly string[],
  previous?: AgentRunState,
): AgentRunState {
  const resumable = previous?.version === 1
    && previous.originalRequest === originalRequest
    && previous.terminalState !== "completed";
  return {
    version: 1,
    originalRequest,
    documentObligations: resumable
      ? previous.documentObligations.map(item => ({ ...item, ...(item.evidence ? { evidence: { ...item.evidence } } : {}) }))
      : documentDeliverables.map((label, index) => ({ id: `document-${index + 1}`, label })),
    terminalState: "running",
    updatedAt: new Date().toISOString(),
  };
}

export function recordAgentRunDocumentEvidence(
  state: AgentRunState,
  evidence: AgentRunDocumentEvidence,
): AgentRunState {
  const evidenceKey = evidence.proposalId !== undefined
    ? `proposal:${evidence.proposalId}`
    : evidence.changeSetId !== undefined ? `change-set:${evidence.changeSetId}` : undefined;
  if (evidenceKey && state.documentObligations.some(item => {
    const current = item.evidence;
    return current && (current.proposalId !== undefined
      ? `proposal:${current.proposalId}`
      : current.changeSetId !== undefined ? `change-set:${current.changeSetId}` : undefined) === evidenceKey;
  })) return state;
  const index = state.documentObligations.findIndex(item => !item.evidence);
  if (index < 0) return state;
  return {
    ...state,
    documentObligations: state.documentObligations.map((item, itemIndex) => (
      itemIndex === index ? { ...item, evidence: { ...evidence } } : item
    )),
    updatedAt: new Date().toISOString(),
  };
}

export function agentRunPendingDocumentLabels(state: AgentRunState): string[] {
  return state.documentObligations.filter(item => !item.evidence).map(item => item.label);
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
  if (permissionMode === "plan" && (DOCUMENT_MUTATION_TOOLS.has(toolName) || CHARACTER_MUTATION_TOOLS.has(toolName) || IMAGE_MUTATION_TOOLS.has(toolName))) {
    return false;
  }
  if (IMAGE_MUTATION_TOOLS.has(toolName)) return contract.capabilities.includes("images");
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
