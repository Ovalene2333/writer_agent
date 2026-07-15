import { compileWritePack, formatWritePackForWriter } from "../write_pack.js";
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
  if (context.chapterSceneDraft) {
    throw new Error("章节场景无需单独 compile_write_pack；请在 write_chapter_scene 的 notes 中提供故事内笔记，工具会在同一步完成编译");
  } else if (context.requireScenePipeline && (!targetPath || documentKind(targetPath) === "chapter")) {
    throw new Error("完整章节写作须先调用 begin_chapter_draft 建立场景链");
  }
  const pack = compileWritePack(notes, { targetPath, instruction });
  const writePack = formatWritePackForWriter(pack);
  context.writePackCompiled = true;
  context.lastWritePack = writePack;
  context.writePackSceneId = undefined;
  return JSON.stringify({
    status: "compiled",
    writePack,
    message: "已编译本场可写材料。原始 notes 与解析元数据不再重复返回；正文只依据 writePack 与已读正文衔接。",
  });
}
