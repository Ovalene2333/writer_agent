import { documentKind, isScenePipelineDocument, orderedChapterPaths, type WriterProject } from "../project.js";
import { compileWritePack, formatWritePackForWriter } from "../write_pack.js";
import {
  assembleChapterSceneDraft,
  beginChapterSceneDraft,
  blockChapterSceneReview,
  chapterDriveSignals,
  chapterSceneDraftComplete,
  chapterSceneLedger,
  nextChapterScene,
  resolveChapterSceneReview,
  reviseChapterDraftStyle,
  reviseChapterSceneGuide,
  sceneCardForTool,
  MAX_SCENE_CHARACTERS,
  writeChapterScene,
  type ChapterDraftMode,
  type ChapterSceneCard,
  type ChapterSceneDraft,
  type ChapterSceneReviewIssue,
} from "../scene_pipeline.js";
import {
  judgeSceneCandidates,
  rewriteSceneCandidate,
  sceneRewriteLengthOk,
} from "../scene_candidates.js";
import { dynamicStyleGroundingPrompt, stableStyleGroundingPrompt } from "../style_grounding.js";
import { buildNarrativeEvidencePacket } from "../narrative_evidence.js";
import {
  EvidenceGroundedWriterError,
  reportAndWrapEvidenceWriterError,
  requestEvidenceGroundedProse,
  requestSceneStateExtraction,
} from "../evidence_grounded_writer.js";
import type { WriterStore } from "../store.js";
import { previewProseStyleGateError } from "../prose_adjudicate.js";
import { dialogueFormatGateError } from "../dialogue_format.js";
import {
  analyzeChapterProseMetrics,
  chapterMetricsBlockError,
  findAdjacentDuplicateSentences,
  removeAdjacentDuplicateSentences,
} from "../prose_metrics.js";
import { analyzeProseVividness, formatVividnessSummary } from "../prose_vividness.js";
import { analyzeDialogueTexture, formatDialogueSummary } from "../dialogue_texture.js";
import { characterName } from "../characters.js";
import { competencyUsePolicy, resolveCompetencyStates } from "../competency_state.js";
import { characterConstraintHash, characterConstraintView } from "../character_constraints.js";
import { OutlineStore } from "../outline.js";
import { analyzeAiTells, formatAiTellSummary } from "../ai_tells.js";
import { assessProseLength, proseLengthOutcome, type ProseLengthAssessment } from "../prose_length.js";
import {
  analyzeProseStyle,
  isHardBlockSubtype,
  proseStyleRepairPacket,
  proseStyleIssuesError,
  sceneMannerismGateError,
  type ProseStyleIssue,
} from "../prose_quality.js";
import {
  buildChapterReviewRevisionContext,
  ChapterReviewRequestError,
  constrainChapterRevisionReview,
  reviewChapterDraft,
  type ChapterReviewIssue,
  type ChapterReviewResult,
} from "../chapter_review.js";
import {
  buildDependencyAttempt,
  buildDependencyFailureBundle,
  dependencyAttemptRole,
  dependencyFailureGuidance,
  dependencyFailureUserSummary,
  reportModelCallUsage,
  type DependencyAttemptDiagnostic,
} from "../dependency_diagnostics.js";
import { proposalIssueTransition, proposalRevisionIssueId } from "../proposal_retry.js";
import { buildFactualChapterReviewContext } from "../chapter_review_context.js";
import {
  CHAPTER_STYLE_REPAIR_BATCH_SIZE,
  ChapterStyleRepairRequestError,
  requestChapterStyleRepair,
  type ChapterStyleEdit,
  type ChapterStyleRepairIssue,
} from "../chapter_style_repair.js";
import type { ToolExecutionContext } from "./types.js";
import { DEFAULT_SCENE_NOTES_CHARACTERS } from "../agent_runtime.js";
import {
  assertWritableMode,
  rejectCompressedPlaceholder,
  requireString,
  resolveDocumentWriteTarget,
  type DocumentWriteMode,
} from "./helpers.js";
import {
  proseStyleGateIssues,
  submitFullDocumentProposal,
  tolerantDeferredCharacterChanges,
} from "./proposals.js";
import {
  assessCardRegisterHits,
  cardRegisterGateError,
  cardRegisterRepairPacket,
  cardRegisterReportForTool,
  collectRegisterRisksForContext,
  proseSignalsFromCardRegister,
  scanCardRegisterHits,
} from "../register_risks.js";
import type { ToolHandlerArgs } from "./types.js";
import { accessibleVolumeNames, agentVisibleDocumentPaths, routeNewChapterPath } from "../volume_policy.js";

function saveDraftCheckpoint(
  args: Pick<ToolHandlerArgs, "store" | "sessionId">,
  stage: import("../types.js").AgentCheckpoint["stage"],
  draft: ChapterSceneDraft,
  extra: {
    unresolved?: string[];
    proposalId?: number;
    reviewRepair?: import("../types.js").AgentCheckpoint["reviewRepair"];
  } = {},
): void {
  args.store.saveAgentCheckpoint(args.sessionId, {
    version: 1,
    stage,
    path: draft.path,
    sourceHash: draft.baseHash,
    draftVersion: draft.version,
    completedScenes: draft.completed.length,
    totalScenes: draft.scenes.length,
    artifactIds: args.store.recentContextArtifacts(args.sessionId, 8).map(item => item.id),
    draft,
    ...extra,
    updatedAt: new Date().toISOString(),
  });
}

export function handleBeginChapterDraft({ input, project, store, sessionId, characterScope, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "begin_chapter_draft");
  if (context.scenePipelineSettings?.enabled === false) {
    throw new Error("场景链当前已关闭；请直接使用 write_file 或 edit_file 完成文档");
  }
  if (context.chapterSceneDraft) throw new Error("已有章节场景草稿正在进行；请完成提案后再开始下一章");
  const path = routeNewChapterPath(project, requireString(input.path, "path"), context.volumeAccess);
  if (!isScenePipelineDocument(path)) throw new Error("逐场景正文草稿只能写入 chapters/ 或 side/");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const requestedMode = requireString(input.mode, "mode") as ChapterDraftMode;
  if (!(["create", "replace", "append"] as string[]).includes(requestedMode)) throw new Error("mode 只能是 create/replace/append");
  const target = resolveDocumentWriteTarget(project, path, requestedMode as DocumentWriteMode);
  const mode = target.mode as ChapterDraftMode;
  const baseContent = target.beforeContent;
  const scenes = Array.isArray(input.scenes) ? input.scenes : [];
  const draft = beginChapterSceneDraft({
    ...(typeof input.deliverableId === "string" && input.deliverableId.trim()
      ? { deliverableId: input.deliverableId.trim() }
      : {}),
    path,
    mode,
    heading: typeof input.heading === "string" ? input.heading : undefined,
    chapterGoal: requireString(input.chapterGoal, "chapterGoal"),
    baseContent,
    baseHash: target.baseHash,
    scenes,
    maxScenes: context.scenePipelineSettings?.maxScenes,
  });
  validateSceneCharacterScopes(draft.scenes, store, project, draft.path, characterScope);
  registerSceneScopeReviewCharacters(draft.scenes, store, context);
  context.chapterSceneDraft = draft;
  activateNextSceneCharacterScopes(context, draft);
  context.writePackCompiled = false;
  context.writePackSceneId = undefined;
  context.lastWritePack = undefined;
  context.lastWritePackData = undefined;
  context.priorProseContext = undefined;
  context.sceneStyleEvidence = undefined;
  saveDraftCheckpoint({ store, sessionId }, "draft_started", draft);
  return JSON.stringify({
    status: "started",
    path,
    mode,
    requestedMode,
    submissionKind: target.versionSubmission ? "new_version" : "new_document",
    chapterGoal: draft.chapterGoal,
    sceneCount: draft.scenes.length,
    scenePolicy: context.scenePipelineSettings,
    nextScene: sceneCardForTool(nextChapterScene(draft)),
    message: "初始 scene guide 与内存草稿已建立。每场后可按 actualState 调整剩余引导；write_chapter_scene 提交故事内 notes、正文和状态。"
      + (target.versionSubmission ? " 目标路径已存在，完成后会作为该文档的新版本提交。" : ""),
  });
}

/** Resolve ID-only scene permissions against the source cards before any prose is written. */
function validateSceneCharacterScopes(
  scenes: ChapterSceneCard[],
  store: WriterStore,
  project: WriterProject,
  path: string,
  characterScope: number[] | undefined,
): void {
  const cards = new Map(store.characters().map(character => [character.id, character]));
  const nodes = new OutlineStore(project).sync().nodes;
  const targetNodeId = nodes
    .filter(node => node.documentPath === path)
    .sort((a, b) => b.order - a.order)[0]?.id;
  const readable = characterScope === undefined ? undefined : new Set(characterScope);
  for (const scene of scenes) {
    for (const scope of scene.characterScopes ?? []) {
      if (readable && !readable.has(scope.characterId)) {
        throw new Error(`场景 ${scene.id} 引用了本次不可读的角色卡：${scope.characterId}`);
      }
      const character = cards.get(scope.characterId);
      if (!character) throw new Error(`场景 ${scene.id} 引用了不存在的角色卡：${scope.characterId}`);
      const competencies = new Map(character.competencies.map(item => [item.id, item]));
      const states = resolveCompetencyStates(character, nodes, targetNodeId);
      const competencyUses = scope.competencyUses
        ?? scope.competencyIds.map(competencyId => ({ competencyId, mode: "use" as const }));
      for (const use of competencyUses) {
        const competency = competencies.get(use.competencyId);
        if (!competency) {
          throw new Error(`场景 ${scene.id} 的角色 ${scope.characterId} 不存在能力：${use.competencyId}`);
        }
        const state = states.get(use.competencyId);
        const policy = competencyUsePolicy(state?.state ?? "unknown", use.mode);
        if (!policy.allowed) {
          throw new Error(`场景 ${scene.id} 的能力授权不成立：${use.competencyId}（入场状态 ${state?.state ?? "unknown"}，模式 ${use.mode}）。${policy.requirement}`);
        }
      }
    }
  }
}

function registerSceneScopeReviewCharacters(
  scenes: ChapterSceneCard[],
  store: WriterStore,
  context: ToolExecutionContext,
): void {
  const cards = new Map(store.characters().map(character => [character.id, character]));
  const reviewCharacterIds = context.reviewCharacterIds ?? (context.reviewCharacterIds = []);
  for (const characterId of new Set(scenes.flatMap(scene => (scene.characterScopes ?? []).map(scope => scope.characterId)))) {
    const character = cards.get(characterId);
    if (!character) continue;
    if (!reviewCharacterIds.includes(characterId)) {
      reviewCharacterIds.push(characterId);
    }
    if (context.writerCharacterConstraintHashes) {
      context.writerCharacterConstraintHashes.set(characterId, characterConstraintHash(characterConstraintView(character)));
    }
  }
}

function activateNextSceneCharacterScopes(context: ToolExecutionContext, draft: ChapterSceneDraft): void {
  const next = nextChapterScene(draft);
  context.activeSceneCharacterScopes = next
    ? { sceneId: next.id, characterScopes: next.characterScopes ?? [] }
    : undefined;
}

/**
 * Reuse-reference prose for recycle metrics and anti-formula hints: the nearest
 * preceding chapter document, plus the draft's own base content in append mode
 * (replace mode may legitimately preserve sentences from its base, so it is excluded).
 */
function priorProseText(project: WriterProject, draft: ChapterSceneDraft, context: ToolExecutionContext): string {
  if (context.priorProseContext?.forPath === draft.path) return context.priorProseContext.text;
  const visibleChapters = new Set(
    agentVisibleDocumentPaths(project, accessibleVolumeNames(context.volumeAccess), [draft.path])
      .filter(path => documentKind(path) === "chapter"),
  );
  const ordered = orderedChapterPaths(project).filter(path => visibleChapters.has(path));
  // Narrative order: the draft's predecessor if registered, else the current last
  // chapter (a new chapter will be appended right after it).
  const registeredIndex = ordered.indexOf(draft.path);
  const previous = registeredIndex > 0
    ? ordered[registeredIndex - 1]
    : ordered.filter(path => path !== draft.path).at(-1);
  const parts: string[] = [];
  if (previous) {
    try {
      parts.push(project.read(previous).slice(-60_000));
    } catch { /* unreadable prior chapter: skip reuse reference */ }
  }
  if (draft.mode === "append" && draft.baseContent.trim()) parts.push(draft.baseContent.slice(-60_000));
  const text = parts.join("\n\n");
  context.priorProseContext = { forPath: draft.path, text };
  return text;
}

export async function handleWriteChapterScene({ input, project, store, sessionId, context }: ToolHandlerArgs): Promise<string> {
  assertWritableMode(context.permissionMode, "write_chapter_scene");
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("尚未开始章节场景草稿；先调用 begin_chapter_draft");
  const sceneId = requireString(input.sceneId, "sceneId");
  const notes = requireString(input.notes, "notes");
  const notesMaxCharacters = context.scenePipelineSettings?.notesMaxCharacters ?? DEFAULT_SCENE_NOTES_CHARACTERS;
  if (notes.length > notesMaxCharacters) {
    throw new Error(`notes 过长（当前上限 ${notesMaxCharacters} 字）；只保留会约束本场正文的材料`);
  }
  const scene = draft.scenes.find(item => item.id === sceneId);
  if (!scene) throw new Error(`sceneId 不在当前 guide 中：${sceneId}`);
  const pack = compileWritePack(notes, { targetPath: draft.path });
  const sceneRegisterRisks = collectRegisterRisksForContext(
    store,
    context,
    (scene.characterScopes ?? []).map(scope => scope.characterId),
  );
  if (sceneRegisterRisks.length) {
    pack.registerRisks = sceneRegisterRisks.map(risk => ({
      term: risk.term,
      characterName: risk.characterName,
      source: risk.source,
      scope: risk.scope,
      reason: risk.reason,
    }));
  }
  const writePack = formatWritePackForWriter(pack);
  if (!writePack.trim()) throw new Error("notes 未能编译为有效的故事内可写材料");
  const sceneIndex = draft.scenes.indexOf(scene);
  const existingScene = sceneIndex < draft.completed.length ? draft.completed[sceneIndex] : undefined;
  const activeReviewCycle = draft.reviewCycle && draft.reviewCycle.status !== "resolved"
    ? draft.reviewCycle
    : undefined;
  let submitted: string;
  let actualState: unknown = input.actualState;
  if (typeof input.content === "string") {
    if (activeReviewCycle && context.evidenceGroundedWriter) {
      throw new Error(
        "当前是终审后的结构修订；请省略 content 与 actualState，让证据型 Writer 依据原证据包、blocker 和原场景完成重写",
      );
    }
    submitted = requireString(input.content, "content");
  } else if (context.evidenceGroundedWriter) {
    const writer = context.evidenceGroundedWriter;
    const previous = sceneIndex > 0 ? draft.completed[sceneIndex - 1] : undefined;
    const evidence = buildNarrativeEvidencePacket({
      project,
      store,
      context,
      sessionId,
      path: draft.path,
      scene,
      ...(previous?.actualState ? { currentState: previous.actualState } : {}),
    });
    context.narrativeEvidencePackets?.set(`${draft.path}#${sceneId}`, evidence);
    const runWriter = writer.run ?? requestEvidenceGroundedProse;
    let generated;
    try {
      generated = await runWriter(writer.model, {
        path: draft.path,
        outputKind: "scene",
        writePack: pack,
        evidence,
        scene,
        ...(previous?.content ? { previousTail: previous.content.slice(-2_000) } : {}),
        ...(existingScene?.content ? { existingText: existingScene.content } : {}),
        styleEvidence: [
          stableStyleGroundingPrompt(project, store),
          chapterStyleEvidence({ project, store, context }, draft),
        ].filter(Boolean).join("\n\n"),
        ...(activeReviewCycle
          ? {
              reviewIssues: activeReviewCycle.unresolvedIssues
                .filter(issue => issue.sceneId === sceneId)
                .map(issue => ({
                  id: issue.id,
                  kind: issue.kind,
                  evidence: issue.evidence,
                  problem: issue.problem,
                  action: issue.action,
                })),
            }
          : {}),
        targetCharacters: scene.targetCharacters,
        lengthMode: context.proseLength?.mode,
        registerRisks: sceneRegisterRisks,
      }, { project, context }, writer.signal);
    } catch (error) {
      if (error instanceof EvidenceGroundedWriterError) {
        throw reportAndWrapEvidenceWriterError(
          error,
          writer.model,
          "evidence_grounded_scene_writer",
          context.modelUsageReporter,
        );
      }
      throw error;
    }
    reportModelCallUsage(context.modelUsageReporter, writer.model, generated.usage, {
      callKind: "evidence_grounded_scene_writer",
    });
    submitted = generated.content;
    const extractState = writer.extractState ?? requestSceneStateExtraction;
    const extracted = await extractState(writer.stateModel, {
      ...(previous?.actualState ? { previousState: previous.actualState } : {}),
      sceneContent: submitted,
      ...(draft.scenes[draft.scenes.indexOf(scene) + 1]
        ? { nextScene: draft.scenes[draft.scenes.indexOf(scene) + 1] }
        : {}),
    }, writer.signal);
    if (extracted.usage) {
      context.modelUsageReporter?.(writer.stateModel, extracted.usage, {
        callKind: "evidence_grounded_scene_state",
      });
    }
    actualState = extracted.actualState;
  } else {
    throw new Error("content 与 actualState 只能在分工模式省略；当前模式需由主 Agent 提交正文和实际离场状态");
  }
  rejectCompressedPlaceholder(submitted, "content");
  const targetCharacters = scene.targetCharacters;
  if (targetCharacters) {
    const assessment = assessProseLength(targetCharacters, submitted);
    // 范围验收模式保留现有门禁；弱引导模式只记录参考，不触发场景重写。
    if (proseLengthOutcome(
      assessment,
      context.proseLength?.enforceMinimum === true,
      context.proseLength?.mode ?? "bounded",
    ).blocked) {
      throw new Error(
        `本场正文 ${assessment.actual} 字，目标 ${targetCharacters} 字，可接受范围 ${assessment.minimum}—${assessment.maximum} 字。保持本场目标、事实和 actualState 一致，按差量${assessment.status === "too_short" ? `补足约 ${assessment.delta} 字` : `删减约 ${assessment.delta} 字`}后重新提交；不得用总结、重复或元说明凑字。`,
      );
    }
  }
  return acceptChapterScene({
    project, store, sessionId, context, draft, sceneId, submitted,
    actualState,
    writePackCharacters: writePack.length,
    toolName: "write_chapter_scene",
    exposeCandidateContent: true,
  });
}

export function handleReviseChapterSceneGuide({ input, project, store, sessionId, characterScope, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "revise_chapter_scene_guide");
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("当前没有章节场景草稿");
  const remainingScenes = input.remainingScenes;
  const result = reviseChapterSceneGuide(
    draft,
    remainingScenes,
    context.scenePipelineSettings?.maxScenes,
  );
  validateSceneCharacterScopes(
    result.draft.scenes.slice(result.draft.completed.length),
    store,
    project,
    result.draft.path,
    characterScope,
  );
  registerSceneScopeReviewCharacters(result.draft.scenes, store, context);
  context.chapterSceneDraft = result.draft;
  activateNextSceneCharacterScopes(context, result.draft);
  context.writePackCompiled = false;
  context.writePackSceneId = undefined;
  context.lastWritePack = undefined;
  context.lastWritePackData = undefined;
  saveDraftCheckpoint({ store, sessionId }, "guide_revised", result.draft);
  const next = nextChapterScene(result.draft);
  return JSON.stringify({
    status: "guide_revised",
    completedScenes: result.draft.completed.length,
    totalScenes: result.draft.scenes.length,
    addedSceneIds: result.addedSceneIds,
    removedSceneIds: result.removedSceneIds,
    nextScene: sceneCardForTool(next),
    complete: chapterSceneDraftComplete(result.draft),
    message: next
      ? "剩余 scene guide 已更新；根据当前 actualState 决定是否写下一场，guide 是导航而非必须照抄的提纲。"
      : "剩余 scene guide 已清空；正文以当前实际结果收束，可以调用 inspect_chapter_draft 终审。",
  });
}

async function acceptChapterScene(args: {
  project: WriterProject;
  store: WriterStore;
  sessionId: string;
  context: ToolExecutionContext;
  draft: ChapterSceneDraft;
  sceneId: string;
  submitted: string;
  actualState: unknown;
  writePackCharacters: number;
  toolName: "write_chapter_scene";
  exposeCandidateContent?: boolean;
}): Promise<string> {
  const { project, store, sessionId, context, draft, sceneId } = args;
  // AA-repeat generation bug ("S。S。") — objective defect with a mechanical fix:
  // dedupe in-tool instead of spending a full round-trip on regeneration.
  const dedup = removeAdjacentDuplicateSentences(args.submitted);
  let content = dedup.text;
  const residualDuplicates = findAdjacentDuplicateSentences(content);
  if (residualDuplicates.length) {
    // Duplicates spanning a line boundary that the remover can't safely fix — rare fallback bounce.
    return JSON.stringify({
      status: "style_revision_required",
      code: "SCENE_DUPLICATE_SENTENCE",
      error: `本场存在相邻逐字复读句：${residualDuplicates.slice(0, 3).map(item => `「${item}」`).join("、")}`,
      sceneId,
      complete: false,
      message: `本场未入库；保留 notes，用同一 sceneId 重新调用 ${args.toolName}。`,
    });
  }
  const sceneStyleRepair = await autoRepairSparseSceneStyle({
    project,
    store,
    context,
    draft,
    content,
  });
  content = sceneStyleRepair.content;
  const styleError = sceneMannerismGateError(content);
  if (styleError) {
    return JSON.stringify({
      status: "style_revision_required",
      code: "SCENE_STYLE_DENSE",
      error: styleError,
      sceneId,
      complete: false,
      styleIssueCount: sceneStyleRepair.initialBlockers,
      localRepairAttempts: sceneStyleRepair.attempts,
      ...(sceneStyleRepair.errors.length ? { localRepairErrors: sceneStyleRepair.errors } : {}),
      message: context.evidenceGroundedWriter
        ? `本场未写入草稿；保留 notes，用同一 sceneId 重新调用 ${args.toolName}。运行时会沿用取证上下文重新构建事实包，不会调用缺少该事实包的修订模型。`
        : sceneStyleRepair.dense
          ? `本场有 ${sceneStyleRepair.initialBlockers} 个硬门禁句，超过局部修订单批上限，未写入草稿。尽量只重写这些句子；若无法保持上下文连贯，再用同一 sceneId 重写本场，保留场景事实、因果和人物选择。`
          : "本场的逐句修订未能通过复检，尚未写入草稿。先只改仍命中的句子；确实无法局部消除时，才用同一 sceneId 重写本场，保留场景事实、因果和人物选择。",
    });
  }
  const sceneRisks = collectRegisterRisksForContext(
    store,
    context,
    (draft.scenes.find(item => item.id === sceneId)?.characterScopes ?? []).map(scope => scope.characterId),
  );
  const sceneRegister = assessCardRegisterHits(scanCardRegisterHits(content, sceneRisks));
  if (sceneRegister.status === "block") {
    const registerError = cardRegisterGateError(sceneRegister);
    return JSON.stringify({
      status: "style_revision_required",
      code: "SCENE_CARD_REGISTER_BLOCKED",
      error: registerError,
      repairPacket: cardRegisterRepairPacket(content, sceneRegister, {
        path: draft.path,
        sourceHash: project.hash(content),
      }),
      cardRegister: cardRegisterReportForTool(sceneRegister),
      sceneId,
      complete: false,
      message: `本场未写入草稿：人设措辞进入对白/叙述过密。按 repairPacket 精确改写命中句（对白可用 revise-dialogue），保留事实与 actualState 意图后用同一 sceneId 重交。`,
    });
  }
  // Experimental best-of-N prose sampling: the submitted scene is candidate 0;
  // fact-preserving rewrites compete on the deterministic prose score. Any
  // rewrite failure silently keeps the original — this never blocks a scene.
  const { content: selectedContent, candidateReport } = await sampleSceneCandidates(
    { project, store, context },
    draft,
    sceneId,
    content,
  );
  const result = writeChapterScene(draft, sceneId, selectedContent, args.actualState);
  context.chapterSceneDraft = result.draft;
  activateNextSceneCharacterScopes(context, result.draft);
  saveDraftCheckpoint({ store, sessionId }, "scene_written", result.draft);
  // A write pack belongs to exactly one scene. The next/revised scene must recompile.
  context.writePackCompiled = false;
  context.writePackSceneId = undefined;
  context.lastWritePack = undefined;
  context.lastWritePackData = undefined;
  const next = nextChapterScene(result.draft);
  return JSON.stringify({
    status: result.revised ? "revised" : "written",
    sceneId,
    completedScenes: result.draft.completed.length,
    totalScenes: result.draft.scenes.length,
    invalidatedSceneIds: result.invalidatedSceneIds,
    writePackCharacters: args.writePackCharacters,
    actualState: result.draft.completed.at(-1)?.actualState,
    nextScene: sceneCardForTool(next),
    ...(sceneRegister.status === "warn" ? { cardRegister: cardRegisterReportForTool(sceneRegister) } : {}),
    ...(result.draft.reviewCycle && result.draft.reviewCycle.status !== "resolved"
      ? {
          reviewCycle: {
            status: result.draft.reviewCycle.status,
            repairAttempts: result.draft.reviewCycle.repairAttempts,
            unresolvedIssueIds: result.draft.reviewCycle.unresolvedIssues.map(issue => issue.id),
          },
        }
      : {}),
    ...(candidateReport ? { candidateSampling: candidateReport } : {}),
    ...(dedup.removed.length || sceneStyleRepair.edits.length
      ? {
        autoFixes: {
          ...(dedup.removed.length ? { duplicateSentencesRemoved: dedup.removed.slice(0, 5) } : {}),
          ...(sceneStyleRepair.edits.length
            ? {
              sceneStyleEdits: sceneStyleRepair.edits,
              sceneStyleRepairAttempts: sceneStyleRepair.attempts,
            }
            : {}),
        },
      }
      : {}),
    // When a rewrite wins, the model's own submission is NOT what entered the
    // draft — return the stored text so later inspect/revise work on real bytes.
    ...(args.exposeCandidateContent && candidateReport?.chosen === "rewrite" ? { content: selectedContent } : {}),
    complete: chapterSceneDraftComplete(result.draft),
    message: [
      next
        ? `当前 guide 的下一场为 ${next.id}；先根据本场 actualState 判断是继续该方向，还是 revise_chapter_scene_guide 调整剩余引导。`
        : "当前没有未写 scene guide；章节目标已抵达则 inspect_chapter_draft，否则先补充下一场引导。",
      dedup.removed.length
        ? "autoFixes 中的相邻复读句已在入稿时各删至一句；本场后续精确替换以入稿文本为准。"
        : "",
      sceneStyleRepair.edits.length
        ? "autoFixes 中的门禁句已逐句替换并通过复检；本场事实与状态保留，后续精确替换以列出的 replace 文本为准。"
        : "",
      candidateReport?.chosen === "rewrite"
        ? "候选采样选中了重写稿并已写入草稿（见 content 字段）；本场后续审阅与精确替换一律以该文本为准，不要引用你提交的原稿字句。"
        : "",
    ].filter(Boolean).join(" "),
  });
}

type SceneCandidateReport = {
  requested: number;
  generated: number;
  eligible: number;
  chosen: "original" | "rewrite";
  skipped?: string;
};

/**
 * Best-of-N prose sampling for one scene (candidateCount > 1). The submitted
 * prose is candidate 0; rewrites must pass the same generation gates before
 * competing. Only a reader judgment may replace it. All failures fall back to
 * the original — this stage may improve a scene, never reject one.
 *
 * Winner selection is a judge model reading for "which draft earns the next
 * page". Rule metrics deliberately have no vote in this choice.
 */
async function sampleSceneCandidates(
  args: { project: WriterProject; store: WriterStore; context: ToolExecutionContext },
  draft: ChapterSceneDraft,
  sceneId: string,
  original: string,
): Promise<{ content: string; candidateReport?: SceneCandidateReport }> {
  const requested = args.context.scenePipelineSettings?.candidateCount ?? 1;
  if (args.context.evidenceGroundedWriter) {
    return {
      content: original,
      ...(requested > 1 ? {
        candidateReport: {
          requested, generated: 0, eligible: 0,
          chosen: "original" as const, skipped: "evidence_grounded_preserves_fact_packet",
        },
      } : {}),
    };
  }
  const sampler = args.context.sceneCandidates;
  if (requested <= 1) return { content: original };
  if (!sampler) {
    return {
      content: original,
      candidateReport: { requested, generated: 0, eligible: 0, chosen: "original", skipped: "no_model" },
    };
  }
  if (!sampler.judgeModel) {
    return {
      content: original,
      candidateReport: {
        requested,
        generated: 0,
        eligible: 0,
        chosen: "original",
        skipped: "no_reader_judge",
      },
    };
  }

  const sceneIndex = draft.scenes.findIndex(scene => scene.id === sceneId);
  const sceneCard = draft.scenes[sceneIndex];
  const previousTail = draft.completed
    .slice(0, Math.max(0, sceneIndex))
    .map(scene => scene.content)
    .join("\n\n")
    .slice(-1_200);
  const styleEvidence = [
    chapterStyleEvidence(args, draft),
    previousTail ? `［本章前一场结尾——重写稿要与之衔接并保持同一支笔的手感］\n${previousTail}` : "",
  ].filter(Boolean).join("\n\n");

  const settled = await Promise.allSettled(Array.from({ length: requested - 1 }, () =>
    rewriteSceneCandidate({
      model: sampler.model,
      signal: sampler.signal,
      styleEvidence,
      sceneBrief: sceneCardBrief(sceneCard),
      original,
      usageReporter: args.context.modelUsageReporter,
    })));
  const generated = settled.filter(item => item.status === "fulfilled").length;
  const eligibleRewrites = settled
    .flatMap(item => (item.status === "fulfilled" ? [item.value] : []))
    .filter(rewrite =>
      rewrite.trim().length >= 80
      && rewrite.length <= MAX_SCENE_CHARACTERS
      && !/^#\s+/mu.test(rewrite)
      && sceneRewriteLengthOk(original, rewrite)
      && !sceneMannerismGateError(rewrite)
      && !findAdjacentDuplicateSentences(rewrite).length,
    );
  const candidates = [original, ...eligibleRewrites];
  if (!eligibleRewrites.length) {
    return {
      content: original,
      candidateReport: {
        requested,
        generated,
        eligible: 0,
        chosen: "original",
        skipped: generated < requested - 1 ? "rewrite_error" : "no_eligible_rewrite",
      },
    };
  }
  try {
    const judged = await judgeSceneCandidates({
      model: sampler.judgeModel,
      signal: sampler.signal,
      sceneBrief: sceneCardBrief(sceneCard),
      candidates,
      usageReporter: args.context.modelUsageReporter,
    });
    return {
      content: candidates[judged.index],
      candidateReport: {
        requested,
        generated,
        eligible: eligibleRewrites.length,
        chosen: judged.index === 0 ? "original" : "rewrite",
        ...(generated < requested - 1 ? { skipped: "rewrite_error" } : {}),
      },
    };
  } catch {
    return {
      content: original,
      candidateReport: {
        requested,
        generated,
        eligible: eligibleRewrites.length,
        chosen: "original",
        skipped: "judge_error",
      },
    };
  }
}

/**
 * One exemplar window per chapter draft, shared by every scene's rewrite calls:
 * repeat scenes stop paying a fresh style-grounding build, and all candidates of
 * one chapter compete against the same voice evidence. Reset per chapter.
 */
function chapterStyleEvidence(
  args: { project: WriterProject; store: WriterStore; context: ToolExecutionContext },
  draft: ChapterSceneDraft,
): string {
  const cached = args.context.sceneStyleEvidence;
  if (cached?.forPath === draft.path) return cached.text;
  const text = dynamicStyleGroundingPrompt(args.project, args.store, {
    intensive: true,
    targetPath: draft.path,
    projectSampleRole: "continuity",
    allowedProjectChapterPaths: agentVisibleDocumentPaths(
      args.project,
      accessibleVolumeNames(args.context.volumeAccess),
      [draft.path],
    ).filter(path => documentKind(path) === "chapter"),
  });
  args.context.sceneStyleEvidence = { forPath: draft.path, text };
  return text;
}

function sceneCardBrief(scene: ChapterSceneCard | undefined): string {
  if (!scene) return "（场景卡缺失，按原稿事实重写）";
  return `目标：${scene.goal}；阻力：${scene.obstacle}；转折：${scene.turn}；结果：${scene.outcome}`;
}

export function handleReviseChapterDraftStyle({ input, project, store, sessionId, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "revise_chapter_draft_style");
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("当前没有章节场景草稿");
  const result = reviseChapterDraftStyle(draft, input.edits);
  context.chapterSceneDraft = result.draft;
  saveDraftCheckpoint({ store, sessionId }, "style_repaired", result.draft);
  // Sync re-gate (rules + cached Flash verdicts, no model call): tell the model in
  // THIS step whether the gate would still block, so it never spends an extra
  // inspect round just to find out.
  const beforeContent = project.documentExists(result.draft.path) ? project.read(result.draft.path) : "";
  const recheckError = previewProseStyleGateError(
    beforeContent,
    assembleChapterSceneDraft(result.draft),
    context.proseVerdictCache,
  );
  const dialogueFormatError = dialogueFormatGateError(assembleChapterSceneDraft(result.draft));
  const recheckErrors = [dialogueFormatError, recheckError].filter((error): error is string => Boolean(error));
  return JSON.stringify({
    status: "style_revised",
    editedSceneIds: result.editedSceneIds,
    preservedSceneIds: result.preservedSceneIds,
    completedScenes: result.draft.completed.length,
    totalScenes: result.draft.scenes.length,
    invalidatedSceneIds: [],
    complete: true,
    styleRecheck: recheckErrors.length ? "blocked" : "passed",
    ...(recheckErrors.length ? { styleBlockers: recheckErrors.join("\n") } : {}),
    message: recheckErrors.length
      ? "局部替换已应用，但复检仍有硬拦截；不要调用 inspect_chapter_draft，直接再用一次 revise_chapter_draft_style 把 styleBlockers 中列出的全部命中句一次修完。"
      : "局部风格替换已应用且复检通过；故事状态与后续场景均保留。请 inspect_chapter_draft 完成终审。",
  });
}

function styleRepairIssues(content: string, blockers: ProseStyleIssue[]): ChapterStyleRepairIssue[] {
  return blockers.slice(0, 20).map(issue => ({
    id: issue.id,
    code: issue.subtype,
    sentence: issue.sentence,
    before: content.slice(Math.max(0, issue.start - 100), issue.start).trim(),
    after: content.slice(issue.end, Math.min(content.length, issue.end + 100)).trim(),
    instruction: [issue.reason, ...issue.suggestions.slice(0, 2)].filter(Boolean).join("；"),
    ...(issue.policyId ? { policyId: issue.policyId } : {}),
    ...(issue.policyVersion ? { policyVersion: issue.policyVersion } : {}),
    ...(issue.skillId ? { skillId: issue.skillId } : {}),
  }));
}

const SPARSE_SCENE_STYLE_REPAIR_LIMIT = CHAPTER_STYLE_REPAIR_BATCH_SIZE;
const SPARSE_SCENE_STYLE_REPAIR_MAX_REQUESTS = 2;

function sceneStyleBlockers(content: string): ProseStyleIssue[] {
  return analyzeProseStyle(content).filter(issue =>
    issue.severity === "error" && isHardBlockSubtype(issue.subtype),
  );
}

function applyExactSceneStyleEdits(
  content: string,
  blockers: ProseStyleIssue[],
  edits: ChapterStyleEdit[],
): { content: string; edits: ChapterStyleEdit[] } {
  const allowed = new Set(blockers.map(issue => issue.sentence));
  const replacements: Array<ChapterStyleEdit & { start: number; end: number }> = [];
  const seen = new Set<string>();
  for (const edit of edits.slice(0, SPARSE_SCENE_STYLE_REPAIR_LIMIT)) {
    const search = edit.search.trim();
    const replace = edit.replace.trim();
    if (!allowed.has(search) || seen.has(search) || !replace || replace === search) continue;
    if (replace.length > Math.max(500, search.length * 3) || /^#{1,6}\s/mu.test(replace)) continue;
    const start = content.indexOf(search);
    if (start < 0 || content.indexOf(search, start + search.length) >= 0) continue;
    seen.add(search);
    replacements.push({ search, replace, start, end: start + search.length });
  }
  replacements.sort((a, b) => b.start - a.start);
  let revised = content;
  let previousStart = content.length;
  const applied: ChapterStyleEdit[] = [];
  for (const edit of replacements) {
    if (edit.end > previousStart) continue;
    revised = `${revised.slice(0, edit.start)}${edit.replace}${revised.slice(edit.end)}`;
    previousStart = edit.start;
    applied.push({ search: edit.search, replace: edit.replace });
  }
  return { content: revised, edits: applied.reverse() };
}

async function autoRepairSparseSceneStyle(args: {
  project: WriterProject;
  store: WriterStore;
  context: ToolExecutionContext;
  draft: ChapterSceneDraft;
  content: string;
}): Promise<{
  content: string;
  initialBlockers: number;
  attempts: number;
  edits: ChapterStyleEdit[];
  errors: string[];
  dense: boolean;
}> {
  let content = args.content;
  let blockers = sceneStyleBlockers(content);
  const initialBlockers = blockers.length;
  const repairer = args.context.evidenceGroundedWriter ? undefined : args.context.chapterStyleRepairer;
  if (!blockers.length || !repairer) {
    return {
      content,
      initialBlockers,
      attempts: 0,
      edits: [],
      errors: [],
      dense: blockers.length > SPARSE_SCENE_STYLE_REPAIR_LIMIT,
    };
  }
  if (blockers.length > SPARSE_SCENE_STYLE_REPAIR_LIMIT) {
    return {
      content,
      initialBlockers,
      attempts: 0,
      edits: [],
      errors: [],
      dense: true,
    };
  }

  const runRepair = repairer.run ?? requestChapterStyleRepair;
  const models = [repairer.model, repairer.fallbackModel]
    .filter((model): model is NonNullable<typeof model> => Boolean(model))
    .filter((model, index, all) => all.findIndex(candidate =>
      candidate.baseUrl === model.baseUrl && candidate.model === model.model
    ) === index);
  const styleEvidence = chapterStyleEvidence(args, args.draft);
  const appliedEdits: ChapterStyleEdit[] = [];
  const errors: string[] = [];
  let attempts = 0;
  while (
    blockers.length
    && blockers.length <= SPARSE_SCENE_STYLE_REPAIR_LIMIT
    && attempts < SPARSE_SCENE_STYLE_REPAIR_MAX_REQUESTS
    && models.length
  ) {
    const model = models[Math.min(attempts, models.length - 1)];
    attempts += 1;
    try {
      const repaired = await runRepair(model, {
        issues: styleRepairIssues(content, blockers),
        chapterGoal: args.draft.chapterGoal,
        styleEvidence,
      }, repairer.signal);
      if (repaired.usage) {
        args.context.modelUsageReporter?.(model, repaired.usage, {
          callKind: "scene_style_repair",
          requestComponents: isolatedRequestComponent(
            "隔离单场逐句修订请求",
            repaired.requestCharacters,
            "scene_style_repair",
          ),
        });
      }
      const applied = applyExactSceneStyleEdits(content, blockers, repaired.edits);
      if (!applied.edits.length) {
        errors.push("局部风格修订没有提供可安全应用的唯一精确替换");
        continue;
      }
      content = applied.content;
      appliedEdits.push(...applied.edits);
      blockers = sceneStyleBlockers(content);
    } catch (error) {
      if (error instanceof ChapterStyleRepairRequestError && error.usage) {
        args.context.modelUsageReporter?.(model, error.usage, {
          callKind: "scene_style_repair_failed",
          requestComponents: isolatedRequestComponent(
            "失败的隔离单场逐句修订请求",
            error.requestCharacters,
            "scene_style_repair_failed",
          ),
        });
      }
      errors.push(error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240));
    }
  }
  return {
    content,
    initialBlockers,
    attempts,
    edits: appliedEdits,
    errors,
    dense: blockers.length > SPARSE_SCENE_STYLE_REPAIR_LIMIT,
  };
}

function isolatedRequestComponent(label: string, characters: number, callKind: string) {
  return [{
    kind: "other" as const,
    label,
    characters,
    estimatedTokens: Math.ceil(characters * 0.75),
    callKind,
  }];
}

async function autoRepairChapterStyle(args: ToolHandlerArgs, beforeContent: string): Promise<{
  passed: boolean;
  attempts: number;
  blockers: ProseStyleIssue[];
  errors: string[];
  policyObservations: Array<{
    issueId: string;
    policyId: string;
    policyVersion?: number;
    skillId?: string;
    evidence: string;
    reason: string;
    suggestion?: string;
  }>;
}> {
  const { project, store, context } = args;
  const maxRequests = 4;
  let attempts = 0;
  const errors: string[] = [];
  for (;;) {
    const draft = context.chapterSceneDraft;
    if (!draft) return { passed: false, attempts, blockers: [], errors: ["章节草稿已丢失"], policyObservations: [] };
    const content = assembleChapterSceneDraft(draft);
    const issues = await proseStyleGateIssues(beforeContent, content, context, {
      targetPath: draft.path,
      targetKind: documentKind(draft.path),
    });
    const blockers = issues.filter(issue => issue.severity === "error");
    if (!blockers.length) return {
      passed: true,
      attempts,
      blockers: [],
      errors,
      policyObservations: issues.flatMap(issue => issue.policyId ? [{
        issueId: issue.id,
        policyId: issue.policyId,
        ...(issue.policyVersion ? { policyVersion: issue.policyVersion } : {}),
        ...(issue.skillId ? { skillId: issue.skillId } : {}),
        evidence: issue.evidence,
        reason: issue.reason,
        ...(issue.suggestions[0] ? { suggestion: issue.suggestions[0] } : {}),
      }] : []),
    };
    if (blockers.some(issue => issue.policyId)
      || context.evidenceGroundedWriter || !context.chapterStyleRepairer || attempts >= maxRequests) {
      return { passed: false, attempts, blockers, errors, policyObservations: [] };
    }
    const repairer = context.chapterStyleRepairer;
    const runRepair = repairer.run ?? requestChapterStyleRepair;
    const models = [repairer.model, repairer.fallbackModel]
      .filter((model): model is NonNullable<typeof model> => Boolean(model))
      .filter((model, index, all) => all.findIndex(candidate => candidate.baseUrl === model.baseUrl && candidate.model === model.model) === index);
    let applied = false;
    const styleEvidence = chapterStyleEvidence({ project, store, context }, draft);
    modelLoop: for (const repairModel of models) {
      let batchSize = CHAPTER_STYLE_REPAIR_BATCH_SIZE;
      for (let modelAttempt = 0; modelAttempt < 2 && attempts < maxRequests; modelAttempt += 1) {
        attempts += 1;
        try {
          const repaired = await runRepair(repairModel, {
            issues: styleRepairIssues(content, blockers.slice(0, batchSize)),
            chapterGoal: draft.chapterGoal,
            styleEvidence,
          }, repairer.signal);
          if (repaired.usage) {
            context.modelUsageReporter?.(repairModel, repaired.usage, {
              callKind: "chapter_style_repair",
              requestComponents: isolatedRequestComponent("隔离风格修订请求", repaired.requestCharacters, "chapter_style_repair"),
            });
          }
          const revised = reviseChapterDraftStyle(draft, repaired.edits);
          context.chapterSceneDraft = revised.draft;
          saveDraftCheckpoint(args, "style_repaired", revised.draft);
          applied = true;
          break modelLoop;
        } catch (error) {
          if (error instanceof ChapterStyleRepairRequestError && error.usage) {
            context.modelUsageReporter?.(repairModel, error.usage, {
              callKind: "chapter_style_repair_failed",
              requestComponents: isolatedRequestComponent("失败的隔离风格修订请求", error.requestCharacters, "chapter_style_repair_failed"),
            });
          }
          errors.push(error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240));
          const deterministicOutputFailure = error instanceof ChapterStyleRepairRequestError
            && (error.failureKind === "truncated" || error.failureKind === "invalid_output");
          if (deterministicOutputFailure && modelAttempt === 0 && batchSize > 4) {
            // A shorter Flash retry is cheaper and more likely to return complete
            // JSON than replaying the same oversized request on the Pro fallback.
            batchSize = 4;
            continue;
          }
          if (deterministicOutputFailure) break;
          break;
        }
      }
    }
    if (!applied) return { passed: false, attempts, blockers, errors, policyObservations: [] };
  }
}

/**
 * Character names for dialogue attribution. Store access can throw on a project
 * with no character files yet; an empty roster just falls back to the heuristic.
 */
function rosterNames(store: ToolHandlerArgs["store"]): string[] {
  try {
    return store.characters().map(characterName).filter(name => name.length >= 2);
  } catch {
    return [];
  }
}

function chapterSceneReviewIssues(issues: readonly ChapterReviewIssue[]): ChapterSceneReviewIssue[] {
  return issues.flatMap(issue => {
    if (issue.severity !== "blocker" || !issue.sceneId || !issue.evidence.length) return [];
    return [{
      id: issue.origin === "unresolved_prior" && issue.priorIssueId
        ? issue.priorIssueId
        : proposalRevisionIssueId(issue),
      severity: issue.severity,
      kind: issue.kind,
      sceneId: issue.sceneId,
      evidence: issue.evidence,
      ...(issue.oldText ? { oldText: issue.oldText } : {}),
      problem: issue.problem,
      action: issue.action,
      ...(issue.priorIssueId ? { priorIssueId: issue.priorIssueId } : {}),
      ...(issue.origin ? { origin: issue.origin } : {}),
    }];
  });
}

function targetScenesForReview(draft: ChapterSceneDraft, targetIds: ReadonlySet<string>) {
  return draft.completed.flatMap((completed, index) => {
    if (!targetIds.has(completed.sceneId)) return [];
    return [{
      sceneId: completed.sceneId,
      card: draft.scenes[index],
      content: completed.content,
      actualState: completed.actualState,
      ...(index > 0 ? { previousTail: draft.completed[index - 1].content.slice(-600) } : {}),
      ...(index + 1 < draft.completed.length ? { nextHead: draft.completed[index + 1].content.slice(0, 600) } : {}),
    }];
  });
}

async function submitPassedChapterReview(
  args: ToolHandlerArgs,
  values: {
    draft: ChapterSceneDraft;
    proposalSummary: string;
    contentCharacters: number;
    metrics: ReturnType<typeof analyzeChapterProseMetrics>;
    styleWarnings: Array<{ code: string; message: string; examples: string[] }>;
    vividness: ReturnType<typeof analyzeProseVividness>;
    vividnessWarnings: Array<{ code: string; message: string; examples: string[] }>;
    aiTells: ReturnType<typeof analyzeAiTells>;
    aiTellWarnings: Array<{ code: string; message: string; examples: string[] }>;
    ledger: ReturnType<typeof chapterSceneLedger>;
    chapterReview: ChapterReviewResult;
    policyObservations: Array<{
      issueId: string;
      policyId: string;
      policyVersion?: number;
      skillId?: string;
      evidence: string;
      reason: string;
      suggestion?: string;
    }>;
  },
): Promise<string> {
  const { input } = args;
  const {
    draft, proposalSummary, contentCharacters, metrics, styleWarnings,
    vividness, vividnessWarnings, aiTells, aiTellWarnings, ledger, chapterReview, policyObservations,
  } = values;
  draft.inspectedVersion = draft.version;
  saveDraftCheckpoint(args, "review_passed", draft);
  const characterEvolutionSkipped = args.context.characterEvolutionEnabled === false
    && input.characterChanges !== undefined
    && (!Array.isArray(input.characterChanges) || input.characterChanges.length > 0);
  const preparedCharacterChanges = args.context.characterEvolutionEnabled === false
    ? { changes: [], warnings: characterEvolutionSkipped ? ["角色演进已关闭，已忽略本次 characterChanges"] : [] }
    : tolerantDeferredCharacterChanges(input.characterChanges, args.store, args.characterScope);
  let proposalResult: string;
  try {
    proposalResult = await submitChapterDraftProposal(args, {
      summary: proposalSummary,
      chapterChange: chapterReview.chapterChange,
      reviewNotes: chapterReview.reviewNotes,
      characterChanges: preparedCharacterChanges.changes,
    });
  } catch (error) {
    return JSON.stringify({
      status: "proposal_failed",
      reviewCompleted: true,
      chapterReview,
      error: error instanceof Error ? error.message : String(error),
      message: "终审已通过，但文件提交创建失败；工作副本仍保留，请再次调用 inspect_chapter_draft 由运行时重试。",
    });
  }
  const proposal = JSON.parse(proposalResult) as Record<string, unknown>;
  if ("error" in proposal) {
    return JSON.stringify({
      status: "proposal_failed",
      reviewCompleted: true,
      chapterReview,
      error: proposal.error,
      message: "终审已通过，但文件提交创建失败；工作副本仍保留，请再次调用 inspect_chapter_draft 由运行时重试。",
    });
  }
  return JSON.stringify({
    status: "proposal_submitted",
    reviewCompleted: true,
    proposalSubmitted: true,
    proposal,
    path: draft.path,
    chapterGoal: draft.chapterGoal,
    contentCharacters,
    sceneCount: draft.completed.length,
    proseStyle: "passed",
    proseMetrics: metrics.stats,
    ...(styleWarnings.length ? { styleWarnings } : {}),
    proseVividness: { summary: formatVividnessSummary(vividness.stats), stats: vividness.stats },
    ...(vividnessWarnings.length ? { vividnessWarnings } : {}),
    proseAiTells: { summary: formatAiTellSummary(aiTells.stats), stats: aiTells.stats },
    ...(aiTellWarnings.length ? { aiTellWarnings } : {}),
    ledger,
    chapterReview,
    ...(policyObservations.length ? { policyObservations } : {}),
    ...(preparedCharacterChanges.warnings.length
      ? { characterChangeWarnings: preparedCharacterChanges.warnings }
      : {}),
    ...(characterEvolutionSkipped ? { characterEvolutionSkipped: true } : {}),
    message: "整章终审已完成且文件变更已提交。",
  });
}

export async function handleInspectChapterDraft(args: ToolHandlerArgs): Promise<string> {
  const { input, project, context } = args;
  assertWritableMode(context.permissionMode, "inspect_chapter_draft");
  const proposalSummary = requireString(input.summary, "summary");
  let draft = context.chapterSceneDraft;
  if (!draft) throw new Error("当前没有章节场景草稿");
  if (!chapterSceneDraftComplete(draft)) {
    throw new Error(`场景尚未写完（${draft.completed.length}/${draft.scenes.length}）`);
  }
  let content = assembleChapterSceneDraft(draft);
  if (context.chapterDraftPreviewed?.path !== draft.path) {
    context.chapterDraftPreviewed = { path: draft.path };
    args.emit({
      type: "text",
      channel: "output",
      text: `\n\n草稿预览（终审仍在继续）：${draft.path}\n\n${content}\n\n`,
    });
  }
  if (draft.reviewCycle?.status === "blocked" && draft.reviewCycle.baselineVersion === draft.version) {
    const targetIds = new Set(draft.reviewCycle.targetSceneIds);
    return JSON.stringify({
      status: "structural_revision_required",
      code: "CHAPTER_REVIEW_BLOCKED",
      path: draft.path,
      contentCharacters: content.length,
      sceneCount: draft.completed.length,
      chapterReview: {
        verdict: "revise",
        chapterChange: "正文与上一轮被阻断的草稿相同",
        reviewNotes: "未检测到可闭合既有 blocker 的场景修订；复用上一轮终审结论。",
        issues: draft.reviewCycle.unresolvedIssues,
      },
      targetScenes: targetScenesForReview(draft, targetIds),
      reviewCycle: {
        status: draft.reviewCycle.status,
        repairAttempts: draft.reviewCycle.repairAttempts,
        unresolvedIssueIds: draft.reviewCycle.unresolvedIssues.map(issue => issue.id),
      },
      message: "草稿版本未变化，未重复调用终审。选择 targetScenes 中的目标场景，以同一 sceneId 调用 write_chapter_scene 并省略 content/actualState；运行时将复用证据型 Writer。",
    });
  }
  const beforeContent = project.documentExists(draft.path) ? project.read(draft.path) : "";
  let dialogueFormatError = dialogueFormatGateError(content);
  if (dialogueFormatError) {
    saveDraftCheckpoint(args, "review_blocked", draft, {
      unresolved: [dialogueFormatError],
      reviewRepair: { mode: "style" },
    });
    return JSON.stringify({
      status: "style_revision_required",
      code: "DIALOGUE_FORMAT_BLOCKED",
      error: dialogueFormatError,
      path: draft.path,
      complete: true,
      invalidatedSceneIds: [],
      message: `只用 revise_chapter_draft_style 精确修复 error 中不成对或开闭错配的引号；「……」、“……”、"……" 与『……』均可，不强制改成某种样式。不要重写场景或为格式问题调用终审。`,
    });
  }
  const styleRepair = await autoRepairChapterStyle(args, beforeContent);
  draft = context.chapterSceneDraft ?? draft;
  content = assembleChapterSceneDraft(draft);
  dialogueFormatError = dialogueFormatGateError(content);
  if (dialogueFormatError) {
    saveDraftCheckpoint(args, "review_blocked", draft, {
      unresolved: [dialogueFormatError],
      reviewRepair: { mode: "style" },
    });
    return JSON.stringify({
      status: "style_revision_required",
      code: "DIALOGUE_FORMAT_BLOCKED",
      error: dialogueFormatError,
      path: draft.path,
      complete: true,
      invalidatedSceneIds: [],
      message: "风格修订后出现了不成对或开闭错配的对白引号；只用 revise_chapter_draft_style 精确修复匹配关系，不强制改成某种引号样式，不要重写场景。",
    });
  }
  if (!styleRepair.passed) {
    saveDraftCheckpoint(args, "review_blocked", draft, {
      unresolved: styleRepair.blockers.map(issue => `${issue.subtype}:${issue.sentence}`).slice(0, 20),
      reviewRepair: { mode: "style" },
    });
    return JSON.stringify({
      status: "style_revision_required",
      code: "CHAPTER_DRAFT_STYLE_BLOCKED",
      error: proseStyleIssuesError(styleRepair.blockers) ?? "局部风格修订未通过",
      repairPacket: proseStyleRepairPacket(content, styleRepair.blockers, {
        path: draft.path,
        sourceHash: project.hash(content),
      }),
      autoRepairAttempts: styleRepair.attempts,
      ...(styleRepair.errors.length ? { autoRepairErrors: styleRepair.errors } : {}),
      path: draft.path,
      complete: true,
      invalidatedSceneIds: [],
      message: styleRepair.blockers.some(issue => issue.policyId)
        ? "作者政策命中已进入 repairPacket。先加载其中指定的 skillId，核对政策证据与放行条件，再由 Agent 对目标句做有限修订并重新 inspect；不得让隔离修订器自行扩大政策含义。"
        : "把 error 中列出的全部命中句在一次 revise_chapter_draft_style 调用中修完（最多 20 条替换），只替换命中句、不重写场景；修订结果自带复检（styleRecheck），复检 passed 后再重新 inspect，不要为查看结果单独 inspect。",
    });
  }
  // Rhythm / reuse metrics on the newly written scenes only (base content excluded):
  // AA repeats and heavy verbatim recycling block; the rest ships as a checklist.
  const scenesText = draft.completed.map(scene => scene.content).join("\n\n");
  const metrics = analyzeChapterProseMetrics(scenesText, {
    priorText: priorProseText(project, draft, context) || undefined,
  });
  const metricsError = chapterMetricsBlockError(metrics);
  if (metricsError) {
    saveDraftCheckpoint(args, "review_blocked", draft, {
      unresolved: metrics.issues.filter(issue => issue.severity === "error").flatMap(issue => issue.examples).slice(0, 20),
      reviewRepair: { mode: "style" },
    });
    return JSON.stringify({
      status: "style_revision_required",
      code: "CHAPTER_METRICS_BLOCKED",
      error: metricsError,
      metricIssues: metrics.issues.filter(issue => issue.severity === "error"),
      path: draft.path,
      complete: true,
      invalidatedSceneIds: [],
      message: metrics.issues.some(issue => issue.code === "rhythm_flat")
        ? "节奏/碎句：结合场景语义复核连续碎句是否真正承担命令、停顿或动作落点；只合并失去自然承接的观察与因果，不按均长或长句比例改稿。"
        : "复读句与逐字回收句用一次 revise_chapter_draft_style 精确替换修完（复读：把「S。S。」替换为单句；回收：只改写命中句，不重写场景），然后重新 inspect 确认计量通过。",
    });
  }
  const styleWarnings = metrics.issues.map(issue => ({
    code: issue.code,
    message: issue.message,
    examples: issue.examples.slice(0, 5),
  }));
  const chapterCharacterIds = draft.scenes.flatMap(scene =>
    (scene.characterScopes ?? []).map(scope => scope.characterId),
  );
  const chapterRegisterRisks = collectRegisterRisksForContext(args.store, context, chapterCharacterIds);
  const chapterRegister = assessCardRegisterHits(scanCardRegisterHits(content, chapterRegisterRisks));
  if (chapterRegister.status === "block") {
    saveDraftCheckpoint(args, "review_blocked", draft, {
      unresolved: chapterRegister.hits.map(hit => hit.sentence).slice(0, 20),
      reviewRepair: { mode: "style" },
    });
    return JSON.stringify({
      status: "style_revision_required",
      code: "CHAPTER_CARD_REGISTER_BLOCKED",
      error: cardRegisterGateError(chapterRegister),
      repairPacket: cardRegisterRepairPacket(content, chapterRegister, {
        path: draft.path,
        sourceHash: project.hash(content),
      }),
      cardRegister: cardRegisterReportForTool(chapterRegister),
      path: draft.path,
      complete: true,
      invalidatedSceneIds: [],
      message: "人设措辞进入对白/叙述过密。按 repairPacket 对命中句精确替换（对白可用 revise-dialogue），保留事实后重新 inspect；不要为措辞问题整章重写。",
    });
  }
  // Additive layer: never blocks, only tells the reviewer and the agent where the
  // chapter is correct but has no picture in it.
  const vividness = analyzeProseVividness(scenesText);
  const vividnessWarnings = vividness.issues.map(issue => ({
    code: issue.code,
    message: issue.message,
    examples: issue.examples.slice(0, 5),
  }));
  // Same contract as vividness: measured, reported, never blocking. The only way
  // an AI-tell turns into a revise loop is the reviewer model judging it a blocker
  // (voice_homogenization / theme_stated / resolution_too_smooth).
  const aiTells = analyzeAiTells(scenesText);
  const aiTellWarnings = aiTells.issues.map(issue => ({
    code: issue.code,
    message: issue.message,
    examples: issue.examples.slice(0, 5),
  }));
  const ledger = chapterSceneLedger(draft);
  // Structural drive numbers: no gate of their own, they only tell the reviewer
  // where to look for drive_flat / stakes_absent.
  const drive = chapterDriveSignals(draft);
  // Dialogue shape. Only the attribution-free numbers carry warnings; the
  // per-speaker profiles ride along as reference for voice_homogenization.
  // Real cast names make speaker attribution reliable; the heuristic tag parse is
  // only a fallback for callers that have no roster (e.g. per-scene feedback).
  const dialogue = analyzeDialogueTexture(scenesText, rosterNames(args.store));
  const dialogueWarnings = dialogue.issues.map(issue => ({
    code: issue.code,
    message: issue.message,
    examples: issue.examples.slice(0, 5),
  }));
  let reviewDiagnostics: ReturnType<typeof buildDependencyFailureBundle> | undefined;
  if (context.chapterReviewer) {
    const reviewer = context.chapterReviewer;
    const runReview = reviewer.run ?? reviewChapterDraft;
    const reviewModels = [reviewer.model, reviewer.fallbackModel]
      .filter((model): model is NonNullable<typeof model> => Boolean(model))
      .filter((model, index, models) => models.findIndex(candidate =>
        candidate.baseUrl === model.baseUrl && candidate.model === model.model
      ) === index);
    const attempts: DependencyAttemptDiagnostic[] = [];
    const reviewContext = buildFactualChapterReviewContext({
      project,
      store: args.store,
      context,
      sessionId: args.sessionId,
      path: draft.path,
      characterScope: args.characterScope,
      baseContext: reviewer.context,
    });
    const priorReviewCycle = draft.reviewCycle?.status === "repairing" ? draft.reviewCycle : undefined;
    const revisionReview = priorReviewCycle
      ? buildChapterReviewRevisionContext({
          previousContent: priorReviewCycle.baselineContent,
          content,
          previousSourceHash: priorReviewCycle.baselineSourceHash,
          priorBlockers: priorReviewCycle.unresolvedIssues,
        })
      : undefined;
    const reviewRequestCharacters = content.length + JSON.stringify(ledger).length
      + draft.chapterGoal.length + reviewContext.length
      + (revisionReview ? JSON.stringify(revisionReview).length : 0) + 1_200;
    const failedComponents = isolatedRequestComponent(
      "失败的隔离整章终审请求",
      reviewRequestCharacters,
      "chapter_review_failed",
    );
    for (const [modelIndex, reviewModel] of reviewModels.entries()) {
      try {
        const reviewed = await runReview(reviewModel, {
          chapterGoal: draft.chapterGoal,
          content,
          scenes: ledger,
          context: reviewContext,
          ...(revisionReview ? {
            revisionReview,
            revisionBaselineContent: priorReviewCycle!.baselineContent,
          } : {}),
          proseSignals: {
            stats: metrics.stats,
            warnings: styleWarnings,
            vividness: vividness.stats,
            vividnessWarnings,
            aiTells: aiTells.stats,
            aiTellWarnings,
            drive,
            dialogue: dialogue.stats,
            dialogueWarnings,
            ...(proseSignalsFromCardRegister(chapterRegister) ?? {}),
          },
        }, reviewer.signal);
        if (reviewed.usage) {
          reportModelCallUsage(context.modelUsageReporter, reviewModel, reviewed.usage, {
            callKind: "chapter_review",
            requestComponents: isolatedRequestComponent("隔离整章终审请求", reviewRequestCharacters, "chapter_review"),
          });
        }
        const chapterReview = revisionReview
          ? constrainChapterRevisionReview(
              reviewed.review,
              revisionReview,
              priorReviewCycle!.baselineContent,
              content,
            )
          : reviewed.review;
        if (chapterReview.verdict === "revise") {
          const cycleIssues = chapterSceneReviewIssues(chapterReview.issues);
          const transition = proposalIssueTransition(
            priorReviewCycle?.unresolvedIssues ?? [],
            cycleIssues,
          );
          draft = blockChapterSceneReview({
            draft,
            baselineContent: content,
            baselineSourceHash: project.hash(content),
            issues: cycleIssues,
            resolvedIssueIds: transition.resolvedIssueIds,
            stillPresentIssueIds: transition.stillPresentIssueIds,
            newlyIntroducedIssueIds: transition.newlyIntroducedIssueIds,
          });
          context.chapterSceneDraft = draft;
          const targetIds = new Set(draft.reviewCycle!.targetSceneIds);
          saveDraftCheckpoint(args, "review_blocked", draft, {
            unresolved: cycleIssues.map(issue => issue.problem),
            reviewRepair: { mode: "structural", targetSceneIds: [...targetIds] },
          });
          const targetScenes = targetScenesForReview(draft, targetIds);
          return JSON.stringify({
            status: "structural_revision_required",
            code: "CHAPTER_REVIEW_BLOCKED",
            path: draft.path,
            contentCharacters: content.length,
            sceneCount: draft.completed.length,
            proseStyle: "passed",
            proseMetrics: metrics.stats,
            ...(styleWarnings.length ? { styleWarnings } : {}),
            proseVividness: formatVividnessSummary(vividness.stats),
            ...(vividnessWarnings.length ? { vividnessWarnings } : {}),
            proseAiTells: formatAiTellSummary(aiTells.stats),
            ...(aiTellWarnings.length ? { aiTellWarnings } : {}),
            proseDrive: drive,
            proseDialogue: formatDialogueSummary(dialogue.stats),
            ...(dialogueWarnings.length ? { dialogueWarnings } : {}),
            ledger,
            chapterReview,
            ...(styleRepair.policyObservations.length ? { policyObservations: styleRepair.policyObservations } : {}),
            targetScenes,
            reviewCycle: {
              status: draft.reviewCycle!.status,
              repairAttempts: draft.reviewCycle!.repairAttempts,
              resolvedIssueIds: draft.reviewCycle!.resolvedIssueIds,
              stillPresentIssueIds: draft.reviewCycle!.stillPresentIssueIds,
              newlyIntroducedIssueIds: draft.reviewCycle!.newlyIntroducedIssueIds,
            },
            message: "终审发现有证据的结构/连续性问题。由 Agent 选择 targetScenes 中要先处理的场景，并以同一 sceneId 调用 write_chapter_scene，省略 content/actualState；运行时会把原场景、blocker 与原证据包交给证据型 Writer。新 actualState 会使依赖它的后续场景失效并要求续写。",
          });
        }
        if (priorReviewCycle) {
          draft = resolveChapterSceneReview(
            draft,
            priorReviewCycle.unresolvedIssues.map(issue => issue.id),
          );
          context.chapterSceneDraft = draft;
        }
        return submitPassedChapterReview(args, {
          draft,
          proposalSummary,
          contentCharacters: content.length,
          metrics,
          styleWarnings,
          vividness,
          vividnessWarnings,
          aiTells,
          aiTellWarnings,
          ledger,
          chapterReview,
          policyObservations: styleRepair.policyObservations,
        });
      } catch (error) {
        const usage = error instanceof ChapterReviewRequestError ? error.usage : undefined;
        const durationMs = error instanceof ChapterReviewRequestError ? error.durationMs : undefined;
        const recordedUsage = reportModelCallUsage(
          context.modelUsageReporter,
          reviewModel,
          usage,
          {
            callKind: "chapter_review_failed",
            requestComponents: failedComponents,
            ...(durationMs !== undefined ? { durationMs } : {}),
          },
        );
        attempts.push(buildDependencyAttempt({
          model: reviewModel,
          role: dependencyAttemptRole(modelIndex, reviewModels.length),
          error,
          recordedUsage,
          ...(error instanceof ChapterReviewRequestError
            ? {
                failureClass: error.failureClass,
                httpStatus: error.httpStatus,
                durationMs: error.durationMs,
              }
            : {}),
        }));
      }
    }
    reviewDiagnostics = buildDependencyFailureBundle({
      stage: "isolated_final_review",
      attempts: attempts.length
        ? attempts
        : [buildDependencyAttempt({
            model: {
              provider: "openai-compatible",
              baseUrl: "",
              model: "(unset)",
              apiKey: "",
            },
            role: "sole",
            error: new Error(reviewModels.length ? "终审未返回结论" : "未配置隔离终审模型"),
            recordedUsage: false,
            failureClass: "config",
          })],
      uniqueModelCount: Math.max(1, reviewModels.length),
    });
  }
  const bundle = reviewDiagnostics ?? buildDependencyFailureBundle({
    stage: "isolated_final_review",
    uniqueModelCount: 0,
    attempts: [buildDependencyAttempt({
      model: {
        provider: "openai-compatible",
        baseUrl: "",
        model: "(unset)",
        apiKey: "",
      },
      role: "sole",
      error: new Error("未配置隔离终审模型"),
      recordedUsage: false,
      failureClass: "config",
    })],
  });
  const summary = dependencyFailureUserSummary(bundle).replace(/^终审/, "隔离终审");
  const guidance = dependencyFailureGuidance(bundle);
  return JSON.stringify({
    status: "final_review_unavailable",
    code: bundle.parseOnly ? "CHAPTER_REVIEW_INVALID" : "CHAPTER_REVIEW_UNAVAILABLE",
    failureKind: bundle.parseOnly ? "invalid_output" : "dependency",
    retryable: !bundle.parseOnly,
    reviewCompleted: false,
    proposalCreated: false,
    errors: bundle.errors,
    diagnostics: bundle,
    reviewFailure: { attempts: bundle.attempts.length, errors: bundle.errors },
    path: draft.path,
    chapterGoal: draft.chapterGoal,
    contentCharacters: content.length,
    sceneCount: draft.completed.length,
    ...(styleRepair.policyObservations.length ? { policyObservations: styleRepair.policyObservations } : {}),
    message: bundle.parseOnly
      ? `${summary} 草稿与审阅事务已保留，未标记通过；可重试终审，不要改写正文来猜测审核意见。`
      : `${summary} 草稿与审阅事务已保留，未标记通过；${guidance} 不能由主 Agent 自审后绕过终审。`,
  });
}

export async function handleProposeChapterDraft(args: ToolHandlerArgs): Promise<string> {
  const { input } = args;
  return submitChapterDraftProposal(args, {
    summary: requireString(input.summary, "summary"),
    chapterChange: requireString(input.chapterChange, "chapterChange"),
    reviewNotes: requireString(input.reviewNotes, "reviewNotes"),
    characterChanges: input.characterChanges,
  });
}

async function submitChapterDraftProposal(
  args: ToolHandlerArgs,
  values: { summary: string; chapterChange: string; reviewNotes: string; characterChanges?: unknown },
): Promise<string> {
  const { project, context } = args;
  if (!values.chapterChange.trim() || !values.reviewNotes.trim()) throw new Error("终审结论不能为空");
  assertWritableMode(context.permissionMode, "propose_chapter_draft");
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("当前没有章节场景草稿");
  if (!chapterSceneDraftComplete(draft)) throw new Error("场景链尚未完成，不能提交整章");
  if (draft.inspectedVersion !== draft.version) throw new Error("整章草稿在最后修改后尚未 inspect_chapter_draft");
  const exists = project.documentExists(draft.path);
  if (draft.mode === "create" && exists) throw new Error("目标文档在场景写作期间已被创建，请重新开始并选择 replace/append");
  if (draft.mode !== "create") {
    if (!exists) throw new Error("目标文档在场景写作期间被删除，请重新开始");
    const current = project.read(draft.path);
    if (project.hash(current) !== draft.baseHash) throw new Error("目标文档在场景写作期间发生变化，请重新读取并开始场景草稿");
  }
  const result = await submitFullDocumentProposal(
    args,
    draft.path,
    assembleChapterSceneDraft(draft),
    values.summary,
    values.characterChanges,
    true,
    true,
  );
  let returnedResult = result;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (draft.deliverableId) {
      parsed.deliverableId = draft.deliverableId;
      returnedResult = JSON.stringify(parsed);
    }
    if (!("error" in parsed)) {
      const proposalId = typeof parsed.proposalId === "number" ? parsed.proposalId : undefined;
      saveDraftCheckpoint(args, "proposal_submitted", draft, { proposalId });
      context.completedChapterHandoff = {
        path: draft.path,
        sceneCount: draft.completed.length,
        finalActualState: draft.completed.at(-1)?.actualState,
      };
      context.chapterSceneDraft = undefined;
    }
  } catch { /* submitFullDocumentProposal always returns JSON; preserve draft on unexpected output. */ }
  return returnedResult;
}
