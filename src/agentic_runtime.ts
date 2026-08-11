import type { AgentRunDocumentEvidence, AgentRunState, PermissionMode } from "./types.js";
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
/** Controls which existing narrative text may be used as a prose reference. */
export type ProseReferenceMode = "project" | "continuity" | "independent";
export type AgentCapability = "research" | "documents" | "files" | "outline" | "scenes" | "characters" | "review" | "images";

/**
 * A semantic contract, not a fixed workflow. The executor may revise its plan and
 * combine any visible capabilities, while the harness owns completion checks.
 * Precompiled mutation is a write-intent hint: non-none authorizes both document and
 * character side effects so tool facts can redirect delivery.
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
  /** Narrative-reference policy selected by the task compiler. */
  proseReferenceMode?: ProseReferenceMode;
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
  "read_file", "search_files", "get_outline_node",
  "search_characters", "get_character_context", "get_character", "get_simple_character", "read_conversation",
  "read_context_artifact", "search_session_artifacts",
]);

const TARGET_EVIDENCE_TOOLS = new Set([
  "read_file", "search_files", "get_outline_node", "get_character_context", "get_character", "get_simple_character",
  "read_context_artifact", "search_session_artifacts",
]);

const CONTINUATION_EVIDENCE_TOOLS = new Set([
  "read_file", "read_context_artifact", "search_session_artifacts", "inspect_chapter_draft",
]);

const DOCUMENT_MUTATION_TOOLS = new Set([
  "write_file", "edit_file", "move_file", "delete_file",
  "propose_outline_patch", "propose_document", "propose_document_patch", "propose_change_set",
  "revise_document_isolated", "begin_chapter_draft", "write_chapter_scene",
  "revise_chapter_scene_guide", "revise_chapter_draft_style", "inspect_chapter_draft",
  "propose_chapter_draft",
]);

const CHARACTER_MUTATION_TOOLS = new Set([
  "change_character_knowledge", "revise_character_expression",
  "open_character_draft", "update_character_draft", "submit_character_draft",
  "save_character", "apply_character_changes", "save_simple_character",
]);

const IMAGE_MUTATION_TOOLS = new Set(["generate_image"]);

/** The ledger opens an entry when one of these actually runs, never before. */
export function isDocumentMutationTool(toolName: string): boolean {
  return DOCUMENT_MUTATION_TOOLS.has(toolName);
}

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
  if (["change_character_knowledge", "revise_character_expression", "submit_character_draft", "save_character", "save_simple_character"].includes(toolName)
    || (toolName === "apply_character_changes" && Array.isArray(result.applied) && result.applied.length > 0)) {
    progress.characterArtifactProduced = true;
  }
  if (toolName === "generate_image" && result.status === "generated") progress.imageArtifactProduced = true;
  if ((toolName === "manage_author_policies" || toolName === "manage_prose_gates") && result.status === "saved") {
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

/**
 * Completion checks are invariants, never predictions.
 *
 * What was removed here, and why: the compiler used to freeze「本轮会产出几份文档 /
 * 会不会改角色卡 / 会不会出图」at t=0, before any evidence existed, and that guess
 * decided when the run was allowed to end. Guessing low ended a five-chapter request
 * after one chapter; guessing high forced an artifact onto a turn that only needed an
 * answer. Whether the user's request was actually fulfilled is a semantic judgment
 * about the finished work — it belongs to the terminal review in `run_completion.ts`,
 * not to a counter seeded before the first tool call.
 *
 * What stays: things checkable at any moment with a locatable failure — an evidence
 * floor before delivery, a persisted author policy the planner explicitly detected,
 * and the internal stage integrity of a writing path the agent itself chose.
 */
export function agentCompletionGaps(
  contract: AgentTaskContract,
  progress: AgentExecutionProgress,
): string[] {
  const gaps: string[] = [];
  // Evidence floor only bites once something was actually delivered: an unanswered
  // question needs no reading, a document written from nothing does.
  if (progress.documentArtifactKeys.size > 0 && !hasEvidence(contract, progress)) {
    gaps.push(contract.evidence === "project"
      ? "尚未通过项目检索或读取取得事实依据"
      : contract.evidence === "target"
        ? "尚未定位并读取目标资料"
        : "尚未取得可承接的正文末尾或工作记忆");
  }
  if (contract.proseGateRequired && !progress.proseGateRuleSaved) {
    gaps.push("尚未把 planning 识别出的可复用作者反馈保存为复审规则");
  }
  gaps.push(...writingWorkflowCompletionGaps(contract, progress.workflowStages));
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
      ? `重复失败：${repeatedFailures.join("、")}。换用可行路径，不要重复同一动作；若确实缺少不可推断的信息，再 ask_user。`
      : "请依据已有工具结果选择下一项最小可验证动作。",
  ].join("\n");
}

/**
 * Write permission comes from the user, not from a guess about the user.
 *
 * `plan` is a mode the author selected, so it freezes every side effect. Everything
 * else is the agent's call: the compiler's `mutation` / `capabilities` hints were
 * produced in two seconds with no evidence, and using them as a hard gate meant a
 * misread intent ("为啥就写了一章" classified as a pure question) permanently blocked
 * the write that would have answered it. A wrong hint should cost one wasted step,
 * never the run.
 */
export function contractAllowsTool(
  _contract: AgentTaskContract,
  permissionMode: PermissionMode,
  toolName: string,
): boolean {
  return !(permissionMode === "plan"
    && (DOCUMENT_MUTATION_TOOLS.has(toolName)
      || CHARACTER_MUTATION_TOOLS.has(toolName)
      || IMAGE_MUTATION_TOOLS.has(toolName)));
}
