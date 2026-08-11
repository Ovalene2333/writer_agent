import { compileWritePack, formatWritePackForWriter } from "../write_pack.js";
import { collectRegisterRisksForContext } from "../register_risks.js";
import type { ToolHandlerArgs } from "./types.js";
import { requireString } from "./helpers.js";

/**
 * Compile planner notes / outline digests into a diegetic write pack.
 * Optional adapter for turning dense planning notes into diegetic writing material.
 */
export function handleCompileWritePack({ input, context, store, sessionId, project }: ToolHandlerArgs): string {
  const notes = requireString(input.notes, "notes");
  if (notes.length > 4_000) throw new Error("notes 过长（上限 4000 字）；只写场景目标、关键事实与事件顺序的要点清单，不要写成长文");
  const targetPath = typeof input.targetPath === "string" ? input.targetPath.trim() : undefined;
  const instruction = typeof input.instruction === "string" ? input.instruction.trim() : undefined;
  if (context.chapterSceneDraft) {
    throw new Error("章节场景无需单独 compile_write_pack；请在当前模式对应的场景写入工具 notes 中提供故事内笔记，工具会在同一步完成编译");
  }
  const pack = compileWritePack(notes, { targetPath, instruction });
  const registerRisks = collectRegisterRisksForContext(store, context);
  if (registerRisks.length) {
    pack.registerRisks = registerRisks.map(risk => ({
      term: risk.term,
      characterName: risk.characterName,
      source: risk.source,
      scope: risk.scope,
      reason: risk.reason,
    }));
  }
  const writePack = formatWritePackForWriter(pack);
  context.writePackCompiled = true;
  context.lastWritePack = writePack;
  context.lastWritePackData = pack;
  const packHash = project.hash(JSON.stringify(pack));
  const artifact = store.saveSessionArtifact(sessionId, {
    artifactKey: `write_pack:${targetPath ?? "unbound"}:${packHash}`,
    kind: "write_pack",
    ...(targetPath ? { path: targetPath } : {}),
    sourceHash: packHash,
    content: JSON.stringify(pack),
    digest: `${targetPath ?? "待绑定正文"} 写作包：${pack.sceneGoal.slice(0, 160)}`,
    status: "active",
    metadata: { targetPath, instruction, factAtomCount: pack.factAtoms?.length ?? 0 },
  });
  context.lastWritePackArtifactId = artifact.id;
  context.writePackSceneId = undefined;
  return JSON.stringify({
    status: "compiled",
    artifactId: artifact.id,
    writePack,
    factAtomCount: pack.factAtoms?.length ?? 0,
    realizationBoundaryCount: pack.realizationBoundaries?.length ?? 0,
    registerRiskCount: registerRisks.length,
    message: "已编译本场场景材料。writePack 不替代角色知识；能力、状态、关系与对白声线仍须依据本轮 get_character_context(writing) 的用途投影。表达政策只约束呈现，不改变事实。",
  });
}
