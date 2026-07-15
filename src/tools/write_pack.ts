import { compileWritePack, formatWritePackForWriter } from "../write_pack.js";
import { nextChapterScene } from "../scene_pipeline.js";
import { documentKind } from "../project.js";
import type { ToolHandlerArgs } from "./types.js";
import { requireString } from "./helpers.js";

/**
 * Compile planner notes / outline digests into a diegetic write pack.
 * Agent write_scene must call this before propose_document(_patch).
 */
export function handleCompileWritePack({ input, context }: ToolHandlerArgs): string {
  const notes = requireString(input.notes, "notes");
  if (notes.length > 24_000) throw new Error("notes 过长（上限 24000 字）；请压缩为场景目标、事实与事件顺序");
  const targetPath = typeof input.targetPath === "string" ? input.targetPath.trim() : undefined;
  const instruction = typeof input.instruction === "string" ? input.instruction.trim() : undefined;
  const sceneId = typeof input.sceneId === "string" ? input.sceneId.trim() : undefined;
  if (context.chapterSceneDraft) {
    if (!sceneId) throw new Error("逐场景写作时 compile_write_pack 必须提供 sceneId");
    const planned = context.chapterSceneDraft.scenes.find(scene => scene.id === sceneId);
    if (!planned) throw new Error(`场景不存在：${sceneId}`);
    const next = nextChapterScene(context.chapterSceneDraft);
    const revising = context.chapterSceneDraft.completed.some(scene => scene.sceneId === sceneId);
    if (!revising && next?.id !== sceneId) throw new Error(`下一场应为 ${next?.id ?? "（场景链已完成）"}`);
  } else if (context.requireScenePipeline && (!targetPath || documentKind(targetPath) === "chapter")) {
    throw new Error("完整章节写作须先调用 begin_chapter_draft 建立场景链");
  }
  const pack = compileWritePack(notes, { targetPath, instruction });
  const writePack = formatWritePackForWriter(pack);
  context.writePackCompiled = true;
  context.lastWritePack = writePack;
  context.writePackSceneId = sceneId;
  return JSON.stringify({
    status: "compiled",
    structured: pack.structured,
    strippedMeta: pack.strippedMeta,
    writePack,
    message: "已编译本场可写材料。正文只依据 writePack 与已读正文衔接；禁止把章节名、路径、大纲/草案标签写进正文。",
  });
}
