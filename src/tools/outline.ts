import { createCreativeOutlineBrief } from "../creative_outline.js";
import { OutlineStore } from "../outline.js";
import type { ToolHandlerArgs } from "./types.js";
import { assertWritableMode, countOccurrences, rejectCompressedPlaceholder, requireString } from "./helpers.js";
import { resolveOutlineNodePayload } from "./outline_resolve.js";
import { maybeAutoAcceptProposal } from "./proposals.js";

export function handleListOutlineNodes({ input, project }: ToolHandlerArgs): string {
  const outline = new OutlineStore(project).sync();
  const type = typeof input.type === "string" ? input.type : undefined;
  const status = typeof input.status === "string" ? input.status : undefined;
  return JSON.stringify({ sourcePath: outline.sourcePath, updatedAt: outline.updatedAt, nodes: outline.nodes
    .filter(node => !type || node.type === type)
    .filter(node => !status || node.status === status)
    .map(({ startLine, endLine, level, ...node }) => ({ ...node, lines: [startLine, endLine], level })) });
}

export function handleGetOutlineNode({ input, project }: ToolHandlerArgs): string {
  const outline = new OutlineStore(project);
  return JSON.stringify(resolveOutlineNodePayload(outline, requireString(input.id, "id")));
}

export function handleDesignCreativeOutline({ input, context }: ToolHandlerArgs): string {
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, 20)
    : [];
  const brief = createCreativeOutlineBrief({
    premise: requireString(input.premise, "premise"),
    ...(typeof input.genre === "string" ? { genre: input.genre } : {}),
    ...(typeof input.audience === "string" ? { audience: input.audience } : {}),
    ...(typeof input.targetChapters === "number" ? { targetChapters: input.targetChapters } : {}),
    constraints: strings(input.constraints), existingBeats: strings(input.existingBeats),
    ...(typeof input.seed === "string" ? { seed: input.seed } : {}),
  });
  context.creativeOutlineDesigned = true;
  return JSON.stringify(brief);
}

export function handleValidateOutline({ project }: ToolHandlerArgs): string {
  return JSON.stringify({ issues: new OutlineStore(project).validate() });
}

export function handleCompareOutlineWithDraft({ input, project }: ToolHandlerArgs): string {
  return JSON.stringify(new OutlineStore(project).compareWithDraft(requireString(input.id, "id")));
}

export function handleProposeOutlinePatch({ input, project, store, sessionId, emit, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "propose_outline_patch");
  const outline = new OutlineStore(project);
  const id = requireString(input.id, "id");
  const nodeSection = outline.section(id);
  const search = requireString(input.search, "search");
  const replace = typeof input.replace === "string" ? input.replace : undefined;
  if (replace === undefined) throw new Error("缺少有效参数：replace");
  rejectCompressedPlaceholder(search, "search"); rejectCompressedPlaceholder(replace, "replace");
  if (!nodeSection.includes(search)) throw new Error("search 不在指定大纲节点中；请重新读取节点原文");
  const content = project.read(outline.sourcePath);
  const occurrences = countOccurrences(content, search);
  if (occurrences !== 1) throw new Error(`search 在大纲中出现 ${occurrences} 次，必须唯一`);
  const proposal = store.createProposal(sessionId, outline.sourcePath, content.replace(search, replace), requireString(input.summary, "summary"));
  emit({ type: "proposal", proposal });
  return JSON.stringify({ nodeId: id, ...maybeAutoAcceptProposal(store, proposal, context.permissionMode, emit) });
}
