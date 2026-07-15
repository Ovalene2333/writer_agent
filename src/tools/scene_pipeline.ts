import { documentKind } from "../project.js";
import {
  assembleChapterSceneDraft,
  beginChapterSceneDraft,
  chapterSceneDraftComplete,
  chapterSceneLedger,
  nextChapterScene,
  sceneCardForTool,
  writeChapterScene,
  type ChapterDraftMode,
} from "../scene_pipeline.js";
import { assertWritableMode, rejectCompressedPlaceholder, requireString } from "./helpers.js";
import { submitFullDocumentProposal } from "./proposals.js";
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
  });
  context.chapterSceneDraft = draft;
  context.writePackCompiled = false;
  context.writePackSceneId = undefined;
  context.lastWritePack = undefined;
  return JSON.stringify({
    status: "started",
    path,
    mode,
    chapterGoal: draft.chapterGoal,
    sceneCount: draft.scenes.length,
    scenes: draft.scenes,
    nextScene: sceneCardForTool(nextChapterScene(draft)),
    message: "场景链已锁定。按顺序为每场 compile_write_pack(sceneId) 后调用 write_chapter_scene；每场正文须产生实际状态变化。",
  });
}

export function handleWriteChapterScene({ input, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "write_chapter_scene");
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("尚未开始章节场景草稿；先调用 begin_chapter_draft");
  const sceneId = requireString(input.sceneId, "sceneId");
  if (!context.writePackCompiled || context.writePackSceneId !== sceneId) {
    throw new Error(`写 ${sceneId} 前须先为同一 sceneId 调用 compile_write_pack`);
  }
  const content = requireString(input.content, "content");
  rejectCompressedPlaceholder(content, "content");
  const result = writeChapterScene(draft, sceneId, content, input.actualState);
  context.chapterSceneDraft = result.draft;
  // A write pack belongs to exactly one scene. The next/revised scene must recompile.
  context.writePackCompiled = false;
  context.writePackSceneId = undefined;
  context.lastWritePack = undefined;
  const next = nextChapterScene(result.draft);
  return JSON.stringify({
    status: result.revised ? "revised" : "written",
    sceneId,
    completedScenes: result.draft.completed.length,
    totalScenes: result.draft.scenes.length,
    invalidatedSceneIds: result.invalidatedSceneIds,
    actualState: result.draft.completed.at(-1)?.actualState,
    nextScene: sceneCardForTool(next),
    complete: chapterSceneDraftComplete(result.draft),
    message: next
      ? `下一场为 ${next.id}；根据本场 actualState 更新人物与局面后，重新 compile_write_pack。`
      : "全部场景已写完；调用 inspect_chapter_draft 做整章接缝、重复功能与总变化审阅。",
  });
}

export function handleInspectChapterDraft({ context }: ToolHandlerArgs): string {
  const draft = context.chapterSceneDraft;
  if (!draft) throw new Error("当前没有章节场景草稿");
  if (!chapterSceneDraftComplete(draft)) {
    throw new Error(`场景尚未写完（${draft.completed.length}/${draft.scenes.length}）`);
  }
  const content = assembleChapterSceneDraft(draft);
  draft.inspectedVersion = draft.version;
  return JSON.stringify({
    status: "inspection_required",
    path: draft.path,
    chapterGoal: draft.chapterGoal,
    content,
    ledger: chapterSceneLedger(draft),
    reviewChecklist: [
      "相邻场景是否因果承接，而非只按时间并列",
      "各场转折与结果是否承担不同功能",
      "人物关系、信息、目标或处境是否逐场发生变化",
      "是否重复使用相同意象、参数展示、沉默或总结式章尾",
      "章节开头到结尾能否用一句话说明总变化",
    ],
    message: "先通读整章。发现问题时为目标 sceneId 重新 compile_write_pack 并 write_chapter_scene；修改会使后续场景失效。确认无误后再 propose_chapter_draft。",
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
  );
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (!("error" in parsed)) context.chapterSceneDraft = undefined;
  } catch { /* submitFullDocumentProposal always returns JSON; preserve draft on unexpected output. */ }
  return result;
}
