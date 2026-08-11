export type ChapterRepairGuard =
  | { mode: "style" }
  | { mode: "structural"; targetSceneIds: string[] };

export type AgentToolGuardResult = {
  blockedResult?: string;
  chapterReviewRejected: boolean;
};

/**
 * Deterministic runtime authorization. Semantic task hints never deny writes;
 * only user-selected permission, revision scope and active review locks do.
 */
export function guardAgentToolCall(input: {
  toolName: string;
  argumentsText: string;
  proposalScopeError?: {
    code?: string;
    error: string;
    retryable: boolean;
    nextAllowedActions?: string[];
  };
  chapterReviewRequired: boolean;
  chapterRepair?: ChapterRepairGuard;
  chapterRepairAllows: (repair: ChapterRepairGuard, toolName: string, argumentsText: string) => boolean;
  chapterReviewAllows: (toolName: string) => boolean;
  visible: boolean;
  permissionAllows: boolean;
  contract: { outcome: string; mutation: string };
}): AgentToolGuardResult {
  if (input.proposalScopeError) {
    return {
      chapterReviewRejected: false,
      blockedResult: JSON.stringify({
        status: "recoverable_state_error",
        code: input.proposalScopeError.code,
        failureKind: "invalid_request",
        retryable: input.proposalScopeError.retryable,
        error: input.proposalScopeError.error,
        ...(input.proposalScopeError.nextAllowedActions
          ? { nextAllowedActions: input.proposalScopeError.nextAllowedActions }
          : {}),
      }),
    };
  }
  if (input.chapterReviewRequired && !input.chapterReviewAllows(input.toolName)) {
    return {
      chapterReviewRejected: true,
      blockedResult: JSON.stringify({
        error: "章节场景链已经完成，当前阶段只允许 inspect_chapter_draft；任务清单已由运行时推进。",
        code: "CHAPTER_REVIEW_REQUIRED",
        nextAllowedActions: ["inspect_chapter_draft"],
      }),
    };
  }
  if (input.chapterRepair
    && !input.chapterRepairAllows(input.chapterRepair, input.toolName, input.argumentsText)) {
    return {
      chapterReviewRejected: false,
      blockedResult: JSON.stringify({
        error: input.chapterRepair.mode === "style"
          ? "终审只要求精确句式修订，禁止重写场景或重建 scene guide。"
          : "终审只允许重写 blocker 明确定位的 targetScenes。",
        code: input.chapterRepair.mode === "style"
          ? "CHAPTER_STYLE_REPAIR_ONLY"
          : "CHAPTER_STRUCTURAL_TARGET_ONLY",
        nextAllowedActions: input.chapterRepair.mode === "style"
          ? ["revise_chapter_draft_style"]
          : ["write_chapter_scene"],
        ...(input.chapterRepair.mode === "structural"
          ? { targetSceneIds: input.chapterRepair.targetSceneIds }
          : {}),
      }),
    };
  }
  if (!input.visible) {
    return {
      chapterReviewRejected: false,
      blockedResult: JSON.stringify({ error: `工具 ${input.toolName} 不在当前权限模式的稳定能力集中` }),
    };
  }
  if (!input.permissionAllows) {
    return {
      chapterReviewRejected: false,
      blockedResult: JSON.stringify({
        error: `任务契约不允许执行 ${input.toolName}`,
        code: "CONTRACT_MUTATION_DENIED",
        contract: input.contract,
        nextAllowedActions: ["ask_user"],
      }),
    };
  }
  return { chapterReviewRejected: false };
}
