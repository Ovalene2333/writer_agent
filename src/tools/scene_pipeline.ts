import { documentKind, isScenePipelineDocument, orderedChapterPaths, type WriterProject } from "../project.js";
import { compileWritePack, formatWritePackForWriter } from "../write_pack.js";
import {
  assembleChapterSceneDraft,
  beginChapterSceneDraft,
  chapterSceneDraftComplete,
  chapterSceneLedger,
  nextChapterScene,
  reviseChapterDraftStyle,
  sceneCardForTool,
  MAX_SCENE_CHARACTERS,
  writeChapterScene,
  type ChapterDraftMode,
  type ChapterSceneCard,
  type ChapterSceneDraft,
} from "../scene_pipeline.js";
import { pickBestSceneCandidate, rewriteSceneCandidate, sceneRewriteLengthOk, SCENE_CANDIDATE_SKIP_SCORE } from "../scene_candidates.js";
import {
  IsolatedSceneRequestError,
  requestIsolatedScene,
  requestSceneStateExtraction,
} from "../isolated_scene_writer.js";
import { dynamicStyleGroundingPrompt, isolatedWriterVoiceSample } from "../style_grounding.js";
import type { WriterStore } from "../store.js";
import { previewProseStyleGateError } from "../prose_adjudicate.js";
import {
  analyzeChapterProseMetrics,
  chapterMetricsBlockError,
  findAdjacentDuplicateSentences,
  priorChapterNegativeList,
  removeAdjacentDuplicateSentences,
  sceneAntiFormulaFeedback,
  sceneProseScore,
} from "../prose_metrics.js";
import { proseStyleIssuesError, sceneMannerismGateError, type ProseStyleIssue } from "../prose_quality.js";
import { ChapterReviewRequestError, reviewChapterDraft, type ChapterReviewResult } from "../chapter_review.js";
import {
  CHAPTER_STYLE_REPAIR_BATCH_SIZE,
  ChapterStyleRepairRequestError,
  requestChapterStyleRepair,
  type ChapterStyleRepairIssue,
} from "../chapter_style_repair.js";
import type { ToolExecutionContext } from "./types.js";
import {
  DEFAULT_ISOLATED_WRITER_MAX_RATIO,
  DEFAULT_SCENE_NOTES_CHARACTERS,
} from "../agent_runtime.js";
import { assertWritableMode, rejectCompressedPlaceholder, requireString } from "./helpers.js";
import {
  proseStyleGateIssues,
  submitFullDocumentProposal,
  tolerantDeferredCharacterChanges,
} from "./proposals.js";
import type { ToolHandlerArgs } from "./types.js";

function saveDraftCheckpoint(
  args: Pick<ToolHandlerArgs, "store" | "sessionId">,
  stage: import("../types.js").AgentCheckpoint["stage"],
  draft: ChapterSceneDraft,
  extra: { unresolved?: string[]; proposalId?: number } = {},
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

export function handleBeginChapterDraft({ input, project, store, sessionId, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "begin_chapter_draft");
  if (context.chapterSceneDraft) throw new Error("已有章节场景草稿正在进行；请完成提案后再开始下一章");
  const path = requireString(input.path, "path");
  if (!isScenePipelineDocument(path)) throw new Error("逐场景正文草稿只能写入 chapters/ 或 side/");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const mode = requireString(input.mode, "mode") as ChapterDraftMode;
  if (!(["create", "replace", "append"] as string[]).includes(mode)) throw new Error("mode 只能是 create/replace/append");
  const exists = project.documentExists(path);
  if (mode === "create" && exists) throw new Error("create 模式目标已存在；全文重写用 replace，续写用 append");
  if (mode !== "create" && !exists) throw new Error(`${mode} 模式目标文档不存在`);
  const baseContent = exists ? project.read(path) : "";
  const scenes = Array.isArray(input.scenes) ? input.scenes : [];
  if (documentKind(path) === "side") {
    const settings = context.scenePipelineSettings;
    const maxScenes = settings?.maxScenes ?? 5;
    const minimumScenes = Math.min(maxScenes, Math.max(2, settings?.preferredMinScenes ?? 3));
    if (scenes.length < minimumScenes) {
      throw new Error(`side/ 支线片段至少需要 ${minimumScenes} 个因果承接场景；请按场景链设置充分展开，而不是压缩成单场`);
    }
    for (const [index, scene] of scenes.entries()) {
      const target = scene && typeof scene === "object" && !Array.isArray(scene)
        ? Number((scene as Record<string, unknown>).targetCharacters)
        : NaN;
      if (!Number.isInteger(target) || target < 2_000) {
        throw new Error(`side/ 支线片段 scenes[${index}].targetCharacters 必须至少为 2000，以避免场景过短`);
      }
    }
  }
  const draft = beginChapterSceneDraft({
    path,
    mode,
    heading: typeof input.heading === "string" ? input.heading : undefined,
    chapterGoal: requireString(input.chapterGoal, "chapterGoal"),
    baseContent,
    baseHash: project.hash(baseContent),
    scenes,
    maxScenes: context.scenePipelineSettings?.maxScenes,
  });
  context.chapterSceneDraft = draft;
  context.writePackCompiled = false;
  context.writePackSceneId = undefined;
  context.lastWritePack = undefined;
  context.priorProseContext = undefined;
  context.sceneStyleEvidence = undefined;
  context.isolatedSceneVoiceSample = undefined;
  context.isolatedPendingScene = undefined;
  const priorText = priorProseText(project, draft, context);
  const stylePriorNotes = context.scenePipelineSettings?.isolatedWriter
    ? []
    : priorText ? priorChapterNegativeList(priorText) : [];
  // Stashed for scene-boundary handoffs: the begin exchange leaves the request
  // after the first scene reset, but these notes must keep applying to every scene.
  context.chapterStylePriorNotes = stylePriorNotes;
  saveDraftCheckpoint({ store, sessionId }, "draft_started", draft);
  return JSON.stringify({
    status: "started",
    path,
    mode,
    chapterGoal: draft.chapterGoal,
    sceneCount: draft.scenes.length,
    scenePolicy: context.scenePipelineSettings,
    nextScene: sceneCardForTool(nextChapterScene(draft)),
    ...(stylePriorNotes.length ? { stylePriorNotes } : {}),
    message: (context.scenePipelineSettings?.isolatedWriter
      ? "场景链已锁定并保存在内存草稿中。按顺序为每场调用一次 write_chapter_scene，只提交故事内 notes；正文与 actualState 由隔离调用生成。"
      : "场景链已锁定并保存在内存草稿中。按顺序为每场调用一次 write_chapter_scene，同时提交故事内 notes、正文和 actualState。")
      + (stylePriorNotes.length ? " stylePriorNotes 是从既有正文统计出的高频表达负面清单，写每一场时遵守。" : ""),
  });
}

/**
 * Reuse-reference prose for recycle metrics and anti-formula hints: the nearest
 * preceding chapter document, plus the draft's own base content in append mode
 * (replace mode may legitimately preserve sentences from its base, so it is excluded).
 */
function priorProseText(project: WriterProject, draft: ChapterSceneDraft, context: ToolExecutionContext): string {
  if (context.priorProseContext?.forPath === draft.path) return context.priorProseContext.text;
  const ordered = orderedChapterPaths(project);
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
  if (context.scenePipelineSettings?.isolatedWriter) {
    return handleWriteChapterSceneIsolated({ input, project, store, sessionId, context, emit: () => undefined });
  }
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("尚未开始章节场景草稿；先调用 begin_chapter_draft");
  const sceneId = requireString(input.sceneId, "sceneId");
  const notes = requireString(input.notes, "notes");
  const notesMaxCharacters = context.scenePipelineSettings?.notesMaxCharacters ?? DEFAULT_SCENE_NOTES_CHARACTERS;
  if (notes.length > notesMaxCharacters) {
    throw new Error(`notes 过长（当前上限 ${notesMaxCharacters} 字）；只保留会约束本场正文的材料`);
  }
  const writePack = formatWritePackForWriter(compileWritePack(notes, { targetPath: draft.path }));
  if (!writePack.trim()) throw new Error("notes 未能编译为有效的故事内可写材料");
  const submitted = requireString(input.content, "content");
  rejectCompressedPlaceholder(submitted, "content");
  return acceptChapterScene({
    project, store, sessionId, context, draft, sceneId, submitted,
    actualState: input.actualState,
    writePackCharacters: writePack.length,
    toolName: "write_chapter_scene",
    exposeCandidateContent: true,
  });
}

async function handleWriteChapterSceneIsolated({ input, project, store, sessionId, context }: ToolHandlerArgs): Promise<string> {
  if (!context.scenePipelineSettings?.isolatedWriter || !context.isolatedSceneWriter) {
    throw new Error("隔离正文实验缺少 Writer 配置");
  }
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("尚未开始章节场景草稿；先调用 begin_chapter_draft");
  const submittedSceneId = typeof input.sceneId === "string" ? input.sceneId.trim() : "";
  const sceneId = submittedSceneId || draft.scenes[draft.completed.length]?.id;
  if (!sceneId) throw new Error("sceneId 缺失，且当前没有待写场景");
  const sceneIndex = draft.scenes.findIndex(scene => scene.id === sceneId);
  if (sceneIndex < 0) throw new Error(`场景不存在：${sceneId}`);
  if (sceneIndex > draft.completed.length) {
    throw new Error(`必须按场景链顺序写作；下一场应为 ${draft.scenes[draft.completed.length]?.id ?? "（已完成）"}`);
  }
  const notes = requireString(input.notes, "notes");
  const notesMaxCharacters = context.scenePipelineSettings.notesMaxCharacters ?? DEFAULT_SCENE_NOTES_CHARACTERS;
  if (notes.length > notesMaxCharacters) {
    throw new Error(`notes 过长（当前上限 ${notesMaxCharacters} 字）；只保留会约束本场正文的材料`);
  }
  const compiled = compileWritePack(notes, { targetPath: draft.path });
  const formatted = formatWritePackForWriter(compiled);
  if (!formatted.trim()) throw new Error("notes 未能编译为有效的故事内可写材料");

  const previous = sceneIndex > 0 ? draft.completed[sceneIndex - 1] : undefined;
  const runner = context.isolatedSceneWriter.run ?? requestIsolatedScene;
  const targetCharacters = draft.scenes[sceneIndex].targetCharacters;
  const writerMaxRatio = context.scenePipelineSettings.isolatedWriterMaxRatio ?? DEFAULT_ISOLATED_WRITER_MAX_RATIO;
  const maximumCharacters = targetCharacters ? Math.floor(targetCharacters * writerMaxRatio) : undefined;
  const writerInput = {
    scene: draft.scenes[sceneIndex],
    writePack: compiled,
    previousTail: previous?.content.slice(-800),
    currentState: previous?.actualState,
    voiceSample: chapterIsolatedVoiceSample({ project, store, context }, draft),
    maximumCharacters,
  };
  const runWriter = async (strictMaximumCharacters?: number) => {
    const callKind = strictMaximumCharacters ? "isolated_scene_writer_length_retry" : "isolated_scene_writer";
    try {
      const generated = await runner(context.isolatedSceneWriter!.model, {
        ...writerInput,
        ...(strictMaximumCharacters ? { strictMaximumCharacters } : {}),
      }, context.isolatedSceneWriter!.signal);
      if (generated.usage) {
        context.modelUsageReporter?.(context.isolatedSceneWriter!.model, generated.usage, { callKind });
      }
      return generated;
    } catch (error) {
      if (error instanceof IsolatedSceneRequestError && error.usage) {
        context.modelUsageReporter?.(context.isolatedSceneWriter!.model, error.usage, {
          callKind: `${callKind}_failed`,
        });
      }
      throw error;
    }
  };
  const pending = context.isolatedPendingScene?.forPath === draft.path
    && context.isolatedPendingScene.sceneId === sceneId
    ? context.isolatedPendingScene
    : undefined;
  let generated = pending
    ? { content: pending.content, requestCharacters: pending.writerInputCharacters }
    : undefined;
  let retriedForLength = false;
  if (!generated) {
    try {
      generated = await runWriter();
    } catch (error) {
      if (!(error instanceof IsolatedSceneRequestError)
        || error.stage !== "writer"
        || error.failureKind !== "truncated"
        || !maximumCharacters) throw error;
      generated = await runWriter(maximumCharacters);
      retriedForLength = true;
    }
  }
  if (!retriedForLength && maximumCharacters && generated.content.trim().length > maximumCharacters) {
    generated = await runWriter(maximumCharacters);
  }
  if (maximumCharacters && generated.content.trim().length > maximumCharacters) {
    throw new Error(`隔离正文 Writer 连续两次超出本场上限 ${maximumCharacters} 字；请收紧 notes 中的事件范围后重试`);
  }
  rejectCompressedPlaceholder(generated.content, "隔离正文 Writer content");
  context.isolatedPendingScene = {
    forPath: draft.path,
    sceneId,
    content: generated.content,
    writerInputCharacters: generated.requestCharacters,
  };

  const extractor = context.isolatedSceneWriter.extractState ?? requestSceneStateExtraction;
  const stateInput = {
    previousState: previous?.actualState,
    sceneContent: generated.content,
    nextScene: draft.scenes[sceneIndex + 1],
  };
  const runExtractor = async (retryJsonOnly = false) => {
    const callKind = retryJsonOnly ? "isolated_scene_state_retry" : "isolated_scene_state";
    try {
      const extracted = await extractor(context.isolatedSceneWriter!.stateModel, {
        ...stateInput,
        ...(retryJsonOnly ? { retryJsonOnly: true } : {}),
      }, context.isolatedSceneWriter!.signal);
      if (extracted.usage) {
        context.modelUsageReporter?.(context.isolatedSceneWriter!.stateModel, extracted.usage, { callKind });
      }
      return extracted;
    } catch (error) {
      if (error instanceof IsolatedSceneRequestError && error.usage) {
        context.modelUsageReporter?.(context.isolatedSceneWriter!.stateModel, error.usage, {
          callKind: `${callKind}_failed`,
        });
      }
      throw error;
    }
  };
  let extracted;
  try {
    extracted = await runExtractor();
  } catch (error) {
    if (!(error instanceof IsolatedSceneRequestError)
      || error.stage !== "state"
      || (error.failureKind !== "truncated" && error.failureKind !== "invalid_output")) throw error;
    try {
      extracted = await runExtractor(true);
    } catch (retryError) {
      const message = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`正文已暂存，仅场景状态提取连续失败；用同一场景再次调用即可只重试状态提取：${message}`, {
        cause: retryError,
      });
    }
  }

  const accepted = await acceptChapterScene({
    project, store, sessionId, context, draft, sceneId,
    submitted: generated.content,
    actualState: extracted.actualState,
    writePackCharacters: formatted.length,
    toolName: "write_chapter_scene",
    generation: {
      mode: "isolated",
      writerInputCharacters: generated.requestCharacters,
      stateInputCharacters: extracted.requestCharacters,
    },
  });
  context.isolatedPendingScene = undefined;
  return accepted;
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
  generation?: { mode: "isolated"; writerInputCharacters: number; stateInputCharacters: number };
}): Promise<string> {
  const { project, store, sessionId, context, draft, sceneId } = args;
  // AA-repeat generation bug ("S。S。") — objective defect with a mechanical fix:
  // dedupe in-tool instead of spending a full round-trip on regeneration.
  const dedup = removeAdjacentDuplicateSentences(args.submitted);
  const content = dedup.text;
  const residualDuplicates = findAdjacentDuplicateSentences(content);
  if (residualDuplicates.length) {
    // Duplicates spanning a line boundary that the remover can't safely fix — rare fallback bounce.
    return JSON.stringify({
      status: "style_revision_required",
      code: "SCENE_DUPLICATE_SENTENCE",
      error: `本场存在相邻逐字复读句：${residualDuplicates.slice(0, 3).map(item => `「${item}」`).join("、")}`,
      sceneId,
      complete: false,
      message: "本场未入库；保留 notes，用同一 sceneId 重新调用 write_chapter_scene。",
    });
  }
  // Never spend another full-scene generation on sentence-level density. Keep
  // the accepted scene and defer exact offending sentences to the mandatory
  // chapter inspection/revise gate. Structural and length failures still reject.
  const deferredStyleError = sceneMannerismGateError(content);
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
  saveDraftCheckpoint({ store, sessionId }, "scene_written", result.draft);
  // A write pack belongs to exactly one scene. The next/revised scene must recompile.
  context.writePackCompiled = false;
  context.writePackSceneId = undefined;
  context.lastWritePack = undefined;
  const next = nextChapterScene(result.draft);
  // Anti-self-imitation hints for the NEXT scene: measured from prose already in the
  // draft (not model self-report), zero extra model calls — scene-chain counterpart
  // of the roleplay anti-formula slot.
  const styleFeedback = next && !context.scenePipelineSettings?.isolatedWriter
    ? sceneAntiFormulaFeedback({
      chapterSoFar: result.draft.completed.map(scene => scene.content).join("\n\n"),
      priorChapterText: priorProseText(project, result.draft, context) || undefined,
    })
    : [];
  return JSON.stringify({
    status: result.revised ? "revised" : "written",
    sceneId,
    completedScenes: result.draft.completed.length,
    totalScenes: result.draft.scenes.length,
    invalidatedSceneIds: result.invalidatedSceneIds,
    writePackCharacters: args.writePackCharacters,
    ...(args.generation ? { generation: args.generation } : {}),
    actualState: result.draft.completed.at(-1)?.actualState,
    nextScene: sceneCardForTool(next),
    ...(styleFeedback.length ? { styleFeedback } : {}),
    ...(candidateReport ? { candidateSampling: candidateReport } : {}),
    ...(dedup.removed.length ? { autoFixes: { duplicateSentencesRemoved: dedup.removed.slice(0, 5) } } : {}),
    ...(deferredStyleError ? { styleDeferred: { code: "SCENE_STYLE_DENSE", error: deferredStyleError } } : {}),
    // When a rewrite wins, the model's own submission is NOT what entered the
    // draft — return the stored text so later inspect/revise work on real bytes.
    ...(args.exposeCandidateContent && candidateReport?.chosen === "rewrite" ? { content: selectedContent } : {}),
    complete: chapterSceneDraftComplete(result.draft),
    message: [
      next
        ? `下一场为 ${next.id}；根据本场 actualState 更新人物与局面，在下一次 ${args.toolName} 中提交新的 notes。${styleFeedback.length ? "styleFeedback 是对已写正文的机器统计，写下一场时遵守其中的禁用与压降要求。" : ""}`
        : "全部场景已写完；调用 inspect_chapter_draft 做整章接缝、重复功能与总变化审阅。",
      dedup.removed.length
        ? "autoFixes 中的相邻复读句已在入稿时各删至一句；本场后续精确替换以入稿文本为准。"
        : "",
      deferredStyleError
        ? "本场带 styleDeferred 入稿：不要重写本场；整章 inspect 会硬拦截，届时把命中句用 revise_chapter_draft_style 精确替换修完并复检。"
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
  scores: number[];
  chosen: "original" | "rewrite";
  skipped?: string;
};

/**
 * Best-of-N prose sampling for one scene (candidateCount > 1). The submitted
 * prose is candidate 0 and wins ties; rewrites must pass the same generation
 * gates before competing on the deterministic prose score. All failures fall
 * back to the original — this stage may improve a scene, never reject one.
 */
async function sampleSceneCandidates(
  args: { project: WriterProject; store: WriterStore; context: ToolExecutionContext },
  draft: ChapterSceneDraft,
  sceneId: string,
  original: string,
): Promise<{ content: string; candidateReport?: SceneCandidateReport }> {
  const requested = args.context.scenePipelineSettings?.candidateCount ?? 1;
  const sampler = args.context.sceneCandidates;
  if (requested <= 1) return { content: original };
  if (!sampler) return { content: original, candidateReport: { requested, generated: 0, eligible: 0, scores: [], chosen: "original", skipped: "no_model" } };
  // Conditional trigger: a rewrite must strictly beat the original, so sampling a
  // clean scene is (candidateCount−1) full-scene generations spent on noise.
  const originalScore = sceneProseScore(original);
  if (originalScore >= SCENE_CANDIDATE_SKIP_SCORE) {
    return {
      content: original,
      candidateReport: { requested, generated: 0, eligible: 0, scores: [originalScore], chosen: "original", skipped: "original_clean" },
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
  const { index, scores } = pickBestSceneCandidate(candidates);
  return {
    content: candidates[index],
    candidateReport: {
      requested,
      generated,
      eligible: eligibleRewrites.length,
      scores,
      chosen: index === 0 ? "original" : "rewrite",
      ...(generated < requested - 1 ? { skipped: "rewrite_error" } : {}),
    },
  };
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
  const text = dynamicStyleGroundingPrompt(args.project, args.store, { intensive: true, targetPath: draft.path });
  args.context.sceneStyleEvidence = { forPath: draft.path, text };
  return text;
}

function chapterIsolatedVoiceSample(
  args: { project: WriterProject; store: WriterStore; context: ToolExecutionContext },
  draft: ChapterSceneDraft,
): string {
  const cached = args.context.isolatedSceneVoiceSample;
  if (cached?.forPath === draft.path) return cached.text;
  const text = isolatedWriterVoiceSample(args.project, args.store, draft.path);
  args.context.isolatedSceneVoiceSample = { forPath: draft.path, text };
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
  return JSON.stringify({
    status: "style_revised",
    editedSceneIds: result.editedSceneIds,
    preservedSceneIds: result.preservedSceneIds,
    completedScenes: result.draft.completed.length,
    totalScenes: result.draft.scenes.length,
    invalidatedSceneIds: [],
    complete: true,
    styleRecheck: recheckError ? "blocked" : "passed",
    ...(recheckError ? { styleBlockers: recheckError } : {}),
    message: recheckError
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
  }));
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
}> {
  const { project, store, context } = args;
  const maxRequests = 4;
  let attempts = 0;
  const errors: string[] = [];
  for (;;) {
    const draft = context.chapterSceneDraft;
    if (!draft) return { passed: false, attempts, blockers: [], errors: ["章节草稿已丢失"] };
    const content = assembleChapterSceneDraft(draft);
    const issues = await proseStyleGateIssues(beforeContent, content, context);
    const blockers = issues.filter(issue => issue.severity === "error");
    if (!blockers.length) return { passed: true, attempts, blockers: [], errors };
    if (!context.chapterStyleRepairer || attempts >= maxRequests) return { passed: false, attempts, blockers, errors };
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
    if (!applied) return { passed: false, attempts, blockers, errors };
  }
}

async function submitPassedChapterReview(
  args: ToolHandlerArgs,
  values: {
    draft: ChapterSceneDraft;
    proposalSummary: string;
    contentCharacters: number;
    metrics: ReturnType<typeof analyzeChapterProseMetrics>;
    styleWarnings: Array<{ code: string; message: string; examples: string[] }>;
    ledger: ReturnType<typeof chapterSceneLedger>;
    chapterReview: ChapterReviewResult;
  },
): Promise<string> {
  const { input } = args;
  const { draft, proposalSummary, contentCharacters, metrics, styleWarnings, ledger, chapterReview } = values;
  draft.inspectedVersion = draft.version;
  saveDraftCheckpoint(args, "review_passed", draft);
  const preparedCharacterChanges = tolerantDeferredCharacterChanges(
    input.characterChanges,
    args.store,
    args.characterScope,
  );
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
      message: "终审已通过，但提案创建失败；修正参数后使用 propose_chapter_draft 重试，勿重新 inspect。",
    });
  }
  const proposal = JSON.parse(proposalResult) as Record<string, unknown>;
  if ("error" in proposal) {
    return JSON.stringify({
      status: "proposal_failed",
      reviewCompleted: true,
      chapterReview,
      error: proposal.error,
      message: "终审已通过，但提案创建失败；修正参数后使用 propose_chapter_draft 重试，勿重新 inspect。",
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
    ledger,
    chapterReview,
    ...(preparedCharacterChanges.warnings.length
      ? { characterChangeWarnings: preparedCharacterChanges.warnings }
      : {}),
    message: "整章终审已完成且提案已创建；不要再调用 propose_chapter_draft。",
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
  const beforeContent = project.documentExists(draft.path) ? project.read(draft.path) : "";
  const styleRepair = await autoRepairChapterStyle(args, beforeContent);
  draft = context.chapterSceneDraft ?? draft;
  content = assembleChapterSceneDraft(draft);
  if (!styleRepair.passed) {
    saveDraftCheckpoint(args, "review_blocked", draft, {
      unresolved: styleRepair.blockers.map(issue => `${issue.subtype}:${issue.sentence}`).slice(0, 20),
    });
    return JSON.stringify({
      status: "style_revision_required",
      code: "CHAPTER_DRAFT_STYLE_BLOCKED",
      error: proseStyleIssuesError(styleRepair.blockers) ?? "局部风格修订未通过",
      autoRepairAttempts: styleRepair.attempts,
      ...(styleRepair.errors.length ? { autoRepairErrors: styleRepair.errors } : {}),
      path: draft.path,
      complete: true,
      invalidatedSceneIds: [],
      message: "把 error 中列出的全部命中句在一次 revise_chapter_draft_style 调用中修完（最多 20 条替换），只替换命中句、不重写场景；修订结果自带复检（styleRecheck），复检 passed 后再重新 inspect，不要为查看结果单独 inspect。",
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
    });
    return JSON.stringify({
      status: "style_revision_required",
      code: "CHAPTER_METRICS_BLOCKED",
      error: metricsError,
      path: draft.path,
      complete: true,
      invalidatedSceneIds: [],
      message: "复读句与逐字回收句用一次 revise_chapter_draft_style 精确替换修完（复读：把「S。S。」替换为单句；回收：只改写命中句，不重写场景），然后重新 inspect 确认计量通过。",
    });
  }
  const styleWarnings = metrics.issues.map(issue => ({
    code: issue.code,
    message: issue.message,
    examples: issue.examples.slice(0, 5),
  }));
  const ledger = chapterSceneLedger(draft);
  if (draft.completed.length === 1 && !styleWarnings.length) {
    const scene = draft.scenes[0];
    return submitPassedChapterReview(args, {
      draft,
      proposalSummary,
      contentCharacters: content.length,
      metrics,
      styleWarnings,
      ledger,
      chapterReview: {
        verdict: "pass",
        chapterChange: `本章完成“${draft.chapterGoal}”：${scene.outcome}`,
        reviewNotes: "单场景章节无跨场景接缝或功能重复；句式门禁、复用计量与场景结果检查均已通过。",
        issues: [],
      },
    });
  }
  let reviewFailure: { attempts: number; errors: string[] } | undefined;
  if (context.chapterReviewer) {
    const reviewer = context.chapterReviewer;
    const runReview = reviewer.run ?? reviewChapterDraft;
    const reviewModels = [reviewer.model, reviewer.fallbackModel]
      .filter((model): model is NonNullable<typeof model> => Boolean(model))
      .filter((model, index, models) => models.findIndex(candidate =>
        candidate.baseUrl === model.baseUrl && candidate.model === model.model
      ) === index);
    const reviewErrors: string[] = [];
    const reviewRequestCharacters = content.length + JSON.stringify(ledger).length
      + draft.chapterGoal.length + (reviewer.context?.length ?? 0) + 1_200;
    for (const reviewModel of reviewModels) {
      try {
        const reviewed = await runReview(reviewModel, {
          chapterGoal: draft.chapterGoal,
          content,
          scenes: ledger,
          context: reviewer.context,
          proseSignals: {
            stats: metrics.stats,
            warnings: styleWarnings,
          },
        }, reviewer.signal);
        if (reviewed.usage) {
          context.modelUsageReporter?.(reviewModel, reviewed.usage, {
            callKind: "chapter_review",
            requestComponents: isolatedRequestComponent("隔离整章终审请求", reviewRequestCharacters, "chapter_review"),
          });
        }
        if (reviewed.review.verdict === "revise") {
          saveDraftCheckpoint(args, "review_blocked", draft, {
            unresolved: reviewed.review.issues.filter(issue => issue.severity === "blocker").map(issue => issue.problem),
          });
          const targetIds = new Set(reviewed.review.issues
            .filter(issue => issue.severity === "blocker" && issue.sceneId)
            .map(issue => issue.sceneId!));
          const targetScenes = draft.completed.flatMap((completed, index) => {
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
          return JSON.stringify({
            status: "structural_revision_required",
            code: "CHAPTER_REVIEW_BLOCKED",
            path: draft.path,
            contentCharacters: content.length,
            sceneCount: draft.completed.length,
            proseStyle: "passed",
            proseMetrics: metrics.stats,
            ...(styleWarnings.length ? { styleWarnings } : {}),
            ledger,
            chapterReview: reviewed.review,
            targetScenes,
            message: "终审发现有证据的结构/连续性问题。只重写 targetScenes 中 blocker 对应场景；保留无关事实与声线，并以新 actualState 为准续写被失效的后续场景。禁止复述审阅报告或全文重写。",
          });
        }
        return submitPassedChapterReview(args, {
          draft,
          proposalSummary,
          contentCharacters: content.length,
          metrics,
          styleWarnings,
          ledger,
          chapterReview: reviewed.review,
        });
      } catch (error) {
        if (error instanceof ChapterReviewRequestError && error.usage) {
          context.modelUsageReporter?.(reviewModel, error.usage, {
            callKind: "chapter_review_failed",
            requestComponents: isolatedRequestComponent("失败的隔离整章终审请求", reviewRequestCharacters, "chapter_review_failed"),
          });
        }
        reviewErrors.push(error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
      }
    }
    reviewFailure = { attempts: reviewModels.length, errors: reviewErrors };
  }
  draft.inspectedVersion = draft.version;
  return JSON.stringify({
    status: "inspection_required",
    reviewCompleted: false,
    reviewMode: "agent_fallback",
    ...(reviewFailure ? { reviewFailure } : {}),
    path: draft.path,
    chapterGoal: draft.chapterGoal,
    contentCharacters: content.length,
    sceneCount: draft.completed.length,
    proseStyle: "passed",
    proseMetrics: metrics.stats,
    ...(styleWarnings.length ? { styleWarnings } : {}),
    ledger,
    // Only the compatibility fallback appends the full chapter to the Agent loop.
    content,
    reviewChecklist: [
      "相邻场景是否因果承接，而非只按时间并列",
      "各场转折与结果是否承担不同功能",
      "人物关系、信息、目标或处境是否逐场发生变化",
      "是否重复使用相同意象、参数展示、沉默或总结式章尾",
      "章节开头到结尾能否用一句话说明总变化",
    ],
    message: "隔离终审不可用，已回退到主 Agent 通读：content 为组装后的整章正文。通读后禁止先输出审阅说明；发现结构问题就直接重写目标 sceneId，确认无误则直接调用 propose_chapter_draft，并把结论写入 reviewNotes/chapterChange 参数。"
      + "若有 styleWarnings，挑影响最大的 1—3 条用一次 revise_chapter_draft_style 局部压降（非强制，不要为凑指标全文重写）。",
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
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
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
  return result;
}
