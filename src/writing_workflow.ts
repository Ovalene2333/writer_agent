export type WritingWorkflowKind = "free" | "scene_graph" | "chapter_delivery";
export type WritingQualityProfile = "fast" | "standard" | "strict";
export type WritingWorkflowStage =
  | "gather_context"
  | "shape_scene_chain"
  | "draft_unit"
  | "inspect_unit"
  | "repair_targeted"
  | "inspect_chapter"
  | "submit_artifact";

export interface WritingWorkflowTaskLike {
  mode: string;
  outcome: string;
  mutation: string;
  planning: string;
  capabilities: string[];
  documentProposalRequired?: boolean;
  editScope?: string;
  workflow?: WritingWorkflowKind;
  qualityProfile?: WritingQualityProfile;
}

export function inferWritingWorkflowKind(task: WritingWorkflowTaskLike): WritingWorkflowKind {
  if (task.mutation !== "document" && task.mutation !== "mixed") return "free";
  if (!task.documentProposalRequired) return "free";
  if (task.mode === "write_scene" && task.editScope === "document") return "chapter_delivery";
  if (task.capabilities.includes("scenes")) return "scene_graph";
  return "free";
}

export function inferWritingQualityProfile(task: WritingWorkflowTaskLike): WritingQualityProfile {
  if (task.mode === "audit") return "strict";
  if (task.documentProposalRequired && task.editScope === "document") return "standard";
  return "fast";
}

export function writingWorkflowPrompt(kind: WritingWorkflowKind, quality: WritingQualityProfile): string {
  const qualityText: Record<WritingQualityProfile, string> = {
    fast: "快速：可直接成稿或局部提案；只做必要证据读取和出口复审。",
    standard: "标准：完整正文须先取得承接/目标依据，成稿后做必要审阅或语义复审，再提交。",
    strict: "严格：审阅优先证据和可定位问题；修复只处理明确问题，不扩大改写范围。",
  };
  if (kind === "free") {
    return `阶段图：free。${qualityText[quality]}Agent 可按工具结果自主选路；完成条件仍由任务契约和提案/保存结果判定。`;
  }
  if (kind === "scene_graph") {
    return `阶段图：scene_graph。参考阶段 gather_context → shape_scene_chain → draft_unit → inspect_unit → submit_artifact。${qualityText[quality]}场景链只在能降低连续性风险时使用；可根据工具结果跳过或回退。`;
  }
  return `阶段图：chapter_delivery。参考阶段 gather_context → shape_scene_chain → draft_unit → inspect_chapter → repair_targeted → submit_artifact。${qualityText[quality]}若已进入章节场景链，必须让运行时终审完成后再提交；未写场景引导可随实际结果修订。`;
}

export function writingWorkflowStagesForTool(
  toolName: string,
  result: Record<string, unknown> | undefined,
): WritingWorkflowStage[] {
  if (!result || "error" in result || result.status === "error" || result.status === "failed") return [];
  const stages: WritingWorkflowStage[] = [];
  if ([
    "search_project", "read_document", "read_document_span", "get_outline_node", "get_character",
    "get_simple_character", "read_file", "read_conversation", "read_context_artifact", "inspect_document",
    "inspect_file", "list_outline_nodes", "validate_outline", "compare_outline_with_draft",
  ].includes(toolName)) {
    stages.push("gather_context");
  }
  if (toolName === "begin_chapter_draft" || toolName === "revise_chapter_scene_guide") {
    stages.push("shape_scene_chain");
  }
  if ([
    "write_chapter_scene", "write_chapter_scene_notes", "write_document_isolated",
    "revise_document_isolated", "propose_document", "propose_document_patch", "propose_change_set",
  ].includes(toolName)) {
    stages.push("draft_unit");
  }
  if (toolName === "audit_prose_style") stages.push("inspect_unit");
  if (toolName === "inspect_chapter_draft") {
    stages.push("inspect_unit", "inspect_chapter");
  }
  if (toolName === "revise_chapter_draft_style" || result.status === "style_revised" || result.status === "revised") {
    stages.push("repair_targeted");
  }
  if ([
    "propose_outline_patch", "propose_document", "write_document_isolated", "propose_document_patch",
    "propose_change_set", "revise_document_isolated", "propose_chapter_draft",
  ].includes(toolName) || (toolName === "inspect_chapter_draft" && result.proposalSubmitted === true)) {
    stages.push("submit_artifact");
  }
  return [...new Set(stages)];
}

export function writingWorkflowCompletionGaps(
  task: WritingWorkflowTaskLike,
  stages: ReadonlySet<WritingWorkflowStage>,
): string[] {
  if (task.mutation !== "document" && task.mutation !== "mixed") return [];
  if (!task.documentProposalRequired) return [];
  const kind = task.workflow ?? inferWritingWorkflowKind(task);
  if (kind === "free") return [];
  const gaps: string[] = [];
  if (kind === "chapter_delivery" && stages.has("shape_scene_chain") && !stages.has("inspect_chapter")) {
    gaps.push("章节场景链已启动但尚未完成整章终审");
  }
  return gaps;
}
