import { documentKind, type WriterProject } from "../project.js";
import { compileWritePack, formatWritePackForWriter } from "../write_pack.js";
import {
  assembleChapterSceneDraft,
  beginChapterSceneDraft,
  chapterSceneDraftComplete,
  chapterSceneLedger,
  nextChapterScene,
  reviseChapterDraftStyle,
  sceneCardForTool,
  writeChapterScene,
  type ChapterDraftMode,
  type ChapterSceneDraft,
} from "../scene_pipeline.js";
import { previewProseStyleGateError } from "../prose_adjudicate.js";
import {
  analyzeChapterProseMetrics,
  chapterMetricsBlockError,
  findAdjacentDuplicateSentences,
  priorChapterNegativeList,
  sceneAntiFormulaFeedback,
} from "../prose_metrics.js";
import { sceneMannerismGateError } from "../prose_quality.js";
import type { ToolExecutionContext } from "./types.js";
import { assertWritableMode, rejectCompressedPlaceholder, requireString } from "./helpers.js";
import { gateProseStyle, submitFullDocumentProposal } from "./proposals.js";
import type { ToolHandlerArgs } from "./types.js";

export function handleBeginChapterDraft({ input, project, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "begin_chapter_draft");
  if (context.chapterSceneDraft) throw new Error("已有章节场景草稿正在进行；请完成提案后再开始下一章");
  const path = requireString(input.path, "path");
  if (documentKind(path) !== "chapter") throw new Error("逐场景章节草稿只能写入 chapters/");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const mode = requireString(input.mode, "mode") as ChapterDraftMode;
  if (!(["create", "replace", "append"] as string[]).includes(mode)) throw new Error("mode 只能是 create/replace/append");
  const exists = project.documentExists(path);
  if (mode === "create" && exists) throw new Error("create 模式目标已存在；全文重写用 replace，续写用 append");
  if (mode !== "create" && !exists) throw new Error(`${mode} 模式目标文档不存在`);
  const baseContent = exists ? project.read(path) : "";
  const draft = beginChapterSceneDraft({
    path,
    mode,
    heading: typeof input.heading === "string" ? input.heading : undefined,
    chapterGoal: requireString(input.chapterGoal, "chapterGoal"),
    baseContent,
    baseHash: project.hash(baseContent),
    scenes: Array.isArray(input.scenes) ? input.scenes : [],
    maxScenes: context.scenePipelineSettings?.maxScenes,
  });
  context.chapterSceneDraft = draft;
  context.writePackCompiled = false;
  context.writePackSceneId = undefined;
  context.lastWritePack = undefined;
  context.priorProseContext = undefined;
  const priorText = priorProseText(project, draft, context);
  const stylePriorNotes = priorText ? priorChapterNegativeList(priorText) : [];
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
  const chapters = project.listDocuments()
    .filter(path => !project.isDocumentHidden(path) && documentKind(path) === "chapter" && path !== draft.path)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const previous = chapters.filter(path => path.localeCompare(draft.path, undefined, { numeric: true }) < 0).at(-1);
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

export function handleWriteChapterScene({ input, project, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "write_chapter_scene");
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("尚未开始章节场景草稿；先调用 begin_chapter_draft");
  const sceneId = requireString(input.sceneId, "sceneId");
  const notes = requireString(input.notes, "notes");
  if (notes.length > 4_000) throw new Error("notes 过长（上限 4000 字）；只写本场目标、关键事实与事件顺序的要点清单，不要写成长文");
  const writePack = formatWritePackForWriter(compileWritePack(notes, { targetPath: draft.path }));
  if (!writePack.trim()) throw new Error("notes 未能编译为有效的故事内可写材料");
  const content = requireString(input.content, "content");
  rejectCompressedPlaceholder(content, "content");
  // Generation-side density gate: block before draft so chapter-end style revises stay rare.
  const sceneStyleError = sceneMannerismGateError(content);
  if (sceneStyleError) {
    return JSON.stringify({
      status: "style_revision_required",
      code: "SCENE_STYLE_DENSE",
      error: sceneStyleError,
      sceneId,
      complete: false,
      message: "本场正文尚未写入草稿。请按 error 改掉成串「不是A。是B。」/说明性夹注后，用同一 sceneId 重新调用 write_chapter_scene（可保留 notes，只改正文句式）。不要先写完全章再统一 revise。",
    });
  }
  // AA-repeat generation bug ("S。S。") — objective defect, catch before it enters the draft.
  const duplicateSentences = findAdjacentDuplicateSentences(content);
  if (duplicateSentences.length) {
    return JSON.stringify({
      status: "style_revision_required",
      code: "SCENE_DUPLICATE_SENTENCE",
      error: `本场存在相邻逐字复读句：${duplicateSentences.slice(0, 3).map(item => `「${item}」`).join("、")}`,
      sceneId,
      complete: false,
      message: "删去每处复读中的重复句后，用同一 sceneId 重新调用 write_chapter_scene（notes 可保留）。",
    });
  }
  const result = writeChapterScene(draft, sceneId, content, input.actualState);
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
    complete: chapterSceneDraftComplete(result.draft),
    message: next
      ? `下一场为 ${next.id}；根据本场 actualState 更新人物与局面，在下一次 write_chapter_scene 中提交新的 notes。${styleFeedback.length ? "styleFeedback 是对已写正文的机器统计，写下一场时遵守其中的禁用与压降要求。" : ""}`
      : "全部场景已写完；调用 inspect_chapter_draft 做整章接缝、重复功能与总变化审阅。",
  });
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
  draft.inspectedVersion = draft.version;
  const styleWarnings = metrics.issues.map(issue => ({
    code: issue.code,
    message: issue.message,
    examples: issue.examples.slice(0, 5),
  }));
  return JSON.stringify({
    status: "inspection_required",
    path: draft.path,
    chapterGoal: draft.chapterGoal,
    contentCharacters: content.length,
    sceneCount: draft.completed.length,
    proseStyle: "passed",
    proseMetrics: metrics.stats,
    ...(styleWarnings.length ? { styleWarnings } : {}),
    ledger: chapterSceneLedger(draft),
    reviewChecklist: [
      "相邻场景是否因果承接，而非只按时间并列",
      "各场转折与结果是否承担不同功能",
      "人物关系、信息、目标或处境是否逐场发生变化",
      "是否重复使用相同意象、参数展示、沉默或总结式章尾",
      "章节开头到结尾能否用一句话说明总变化",
    ],
    message: "请依据本轮历史中各次 write_chapter_scene 的正文通读整章；正文已保存在内存草稿中，不在此重复返回。发现问题时直接为目标 sceneId 重新调用 write_chapter_scene（同时提供新 notes）；确认无误后再 propose_chapter_draft。"
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
