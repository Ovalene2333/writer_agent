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
import { dynamicStyleGroundingPrompt } from "../style_grounding.js";
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
import { sceneMannerismGateError } from "../prose_quality.js";
import { ChapterReviewRequestError, reviewChapterDraft } from "../chapter_review.js";
import type { ToolExecutionContext } from "./types.js";
import { assertWritableMode, rejectCompressedPlaceholder, requireString } from "./helpers.js";
import { gateProseStyle, submitFullDocumentProposal } from "./proposals.js";
import type { ToolHandlerArgs } from "./types.js";

export function handleBeginChapterDraft({ input, project, context }: ToolHandlerArgs): string {
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
  const priorText = priorProseText(project, draft, context);
  const stylePriorNotes = priorText ? priorChapterNegativeList(priorText) : [];
  // Stashed for scene-boundary handoffs: the begin exchange leaves the request
  // after the first scene reset, but these notes must keep applying to every scene.
  context.chapterStylePriorNotes = stylePriorNotes;
  return JSON.stringify({
    status: "started",
    path,
    mode,
    chapterGoal: draft.chapterGoal,
    sceneCount: draft.scenes.length,
    scenePolicy: context.scenePipelineSettings,
    nextScene: sceneCardForTool(nextChapterScene(draft)),
    ...(stylePriorNotes.length ? { stylePriorNotes } : {}),
    message: "场景链已锁定并保存在内存草稿中。按顺序为每场调用一次 write_chapter_scene，同时提交故事内 notes、正文和 actualState。"
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

export async function handleWriteChapterScene({ input, project, store, context }: ToolHandlerArgs): Promise<string> {
  assertWritableMode(context.permissionMode, "write_chapter_scene");
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("尚未开始章节场景草稿；先调用 begin_chapter_draft");
  const sceneId = requireString(input.sceneId, "sceneId");
  const notes = requireString(input.notes, "notes");
  if (notes.length > 1_500) throw new Error("notes 过长（上限 1500 字）；只写本场目标、关键事实与事件顺序的要点清单，不要写成长文");
  const writePack = formatWritePackForWriter(compileWritePack(notes, { targetPath: draft.path }));
  if (!writePack.trim()) throw new Error("notes 未能编译为有效的故事内可写材料");
  const submitted = requireString(input.content, "content");
  rejectCompressedPlaceholder(submitted, "content");
  // AA-repeat generation bug ("S。S。") — objective defect with a mechanical fix:
  // dedupe in-tool instead of spending a full round-trip on regeneration.
  const dedup = removeAdjacentDuplicateSentences(submitted);
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
      message: "删去每处复读中的重复句后，用同一 sceneId 重新调用 write_chapter_scene（notes 可保留）。",
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
  const result = writeChapterScene(draft, sceneId, selectedContent, input.actualState);
  context.chapterSceneDraft = result.draft;
  // A write pack belongs to exactly one scene. The next/revised scene must recompile.
  context.writePackCompiled = false;
  context.writePackSceneId = undefined;
  context.lastWritePack = undefined;
  const next = nextChapterScene(result.draft);
  // Anti-self-imitation hints for the NEXT scene: measured from prose already in the
  // draft (not model self-report), zero extra model calls — scene-chain counterpart
  // of the roleplay anti-formula slot.
  const styleFeedback = next
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
    writePackCharacters: writePack.length,
    actualState: result.draft.completed.at(-1)?.actualState,
    nextScene: sceneCardForTool(next),
    ...(styleFeedback.length ? { styleFeedback } : {}),
    ...(candidateReport ? { candidateSampling: candidateReport } : {}),
    ...(dedup.removed.length ? { autoFixes: { duplicateSentencesRemoved: dedup.removed.slice(0, 5) } } : {}),
    ...(deferredStyleError ? { styleDeferred: { code: "SCENE_STYLE_DENSE", error: deferredStyleError } } : {}),
    // When a rewrite wins, the model's own submission is NOT what entered the
    // draft — return the stored text so later inspect/revise work on real bytes.
    ...(candidateReport?.chosen === "rewrite" ? { content: selectedContent } : {}),
    complete: chapterSceneDraftComplete(result.draft),
    message: [
      next
        ? `下一场为 ${next.id}；根据本场 actualState 更新人物与局面，在下一次 write_chapter_scene 中提交新的 notes。${styleFeedback.length ? "styleFeedback 是对已写正文的机器统计，写下一场时遵守其中的禁用与压降要求。" : ""}`
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

function sceneCardBrief(scene: ChapterSceneCard | undefined): string {
  if (!scene) return "（场景卡缺失，按原稿事实重写）";
  return `目标：${scene.goal}；阻力：${scene.obstacle}；转折：${scene.turn}；结果：${scene.outcome}`;
}

export function handleReviseChapterDraftStyle({ input, project, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "revise_chapter_draft_style");
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("当前没有章节场景草稿");
  const result = reviseChapterDraftStyle(draft, input.edits);
  context.chapterSceneDraft = result.draft;
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

export async function handleInspectChapterDraft({ project, context }: ToolHandlerArgs): Promise<string> {
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("当前没有章节场景草稿");
  if (!chapterSceneDraftComplete(draft)) {
    throw new Error(`场景尚未写完（${draft.completed.length}/${draft.scenes.length}）`);
  }
  const content = assembleChapterSceneDraft(draft);
  const beforeContent = project.documentExists(draft.path) ? project.read(draft.path) : "";
  try {
    await gateProseStyle(beforeContent, content, context);
  } catch (error) {
    return JSON.stringify({
      status: "style_revision_required",
      code: "CHAPTER_DRAFT_STYLE_BLOCKED",
      error: error instanceof Error ? error.message : String(error),
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
    for (const reviewModel of reviewModels) {
      try {
        const reviewed = await runReview(reviewModel, {
          chapterGoal: draft.chapterGoal,
          content,
          scenes: ledger,
          context: reviewer.context,
        }, reviewer.signal);
        if (reviewed.usage) {
          context.modelUsageReporter?.(reviewModel, reviewed.usage, { callKind: "chapter_review" });
        }
        if (reviewed.review.verdict === "revise") {
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
        draft.inspectedVersion = draft.version;
        return JSON.stringify({
          status: "inspection_required",
          reviewCompleted: true,
          path: draft.path,
          chapterGoal: draft.chapterGoal,
          contentCharacters: content.length,
          sceneCount: draft.completed.length,
          proseStyle: "passed",
          proseMetrics: metrics.stats,
          ...(styleWarnings.length ? { styleWarnings } : {}),
          ledger,
          chapterReview: reviewed.review,
          message: "整章终审已完成且通过。下一回复禁止输出或复述审阅正文；第一个动作直接调用 propose_chapter_draft，把 chapterReview.chapterChange 和 reviewNotes 原样写入对应参数。",
        });
      } catch (error) {
        if (error instanceof ChapterReviewRequestError && error.usage) {
          context.modelUsageReporter?.(reviewModel, error.usage, { callKind: "chapter_review_failed" });
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
  const { input, project, context } = args;
  assertWritableMode(context.permissionMode, "propose_chapter_draft");
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("当前没有章节场景草稿");
  if (!chapterSceneDraftComplete(draft)) throw new Error("场景链尚未完成，不能提交整章");
  if (draft.inspectedVersion !== draft.version) throw new Error("整章草稿在最后修改后尚未 inspect_chapter_draft");
  requireString(input.chapterChange, "chapterChange");
  requireString(input.reviewNotes, "reviewNotes");
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
    requireString(input.summary, "summary"),
    input.characterChanges,
    true,
    true,
  );
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (!("error" in parsed)) {
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
