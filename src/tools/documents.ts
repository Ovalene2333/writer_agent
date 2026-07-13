import { documentBlocks, documentSections } from "../document_blocks.js";
import { adjudicateProseStyleForAudit } from "../prose_adjudicate.js";
import { analyzeProseStyle } from "../prose_quality.js";
import type { ToolHandlerArgs } from "./types.js";
import { documentMap, optionalPositiveInteger, requireString } from "./helpers.js";

export function handleListDocuments({ project }: ToolHandlerArgs): string {
  return JSON.stringify(documentMap(project));
}

export async function handleAuditProseStyle({ input, project, context }: ToolHandlerArgs): Promise<string> {
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const content = project.read(path);
  const rules = analyzeProseStyle(content);
  const flash = await adjudicateProseStyleForAudit(
    content,
    rules,
    context.proseAdjudicator?.model,
    { signal: context.proseAdjudicator?.signal },
  );
  const issues = flash.issues;
  return JSON.stringify({
    path,
    sourceHash: project.hash(content),
    summary: {
      errors: issues.filter(issue => issue.severity === "error").length,
      warnings: issues.filter(issue => issue.severity === "warning").length,
      allowedSpeechOrMetadata: issues.filter(issue => issue.severity === "info").length,
      flashAdjudicated: flash.adjudicated,
      flashSkipped: flash.skipped,
    },
    issues,
  });
}

export function handleInspectDocument({ input, project }: ToolHandlerArgs): string {
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const content = project.read(path);
  const lines = content.split(/\r?\n/);
  const blocks = documentBlocks(content);
  const headings = lines.flatMap((line, index) => /^#{1,6}\s+/.test(line) ? [{ line: index + 1, text: line }] : []).slice(0, 120);
  return JSON.stringify({
    path,
    lineCount: lines.length,
    characterCount: content.length,
    blockCount: blocks.length,
    blocks: blocks.map(block => ({ block: block.block, startLine: block.startLine, endLine: block.endLine, characters: block.characters })),
    headings,
    opening: lines.slice(0, 8).join("\n").slice(0, 1_200),
    ending: lines.slice(-8).join("\n").slice(-1_200),
  });
}

export function handleReadDocument({ input, project }: ToolHandlerArgs): string {
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const content = project.read(path);
  const requestedStart = optionalPositiveInteger(input.startLine, "startLine");
  const requestedEnd = optionalPositiveInteger(input.endLine, "endLine");
  if ((requestedStart === undefined) !== (requestedEnd === undefined)) throw new Error("startLine 和 endLine 必须同时提供");
  if (requestedStart !== undefined && requestedEnd !== undefined) {
    const lines = content.split(/\r?\n/);
    if (requestedStart > requestedEnd) throw new Error("startLine 不能大于 endLine");
    if (requestedStart > lines.length) throw new Error(`startLine 超出范围；文档共 ${lines.length} 行`);
    if (requestedEnd - requestedStart + 1 > 200) throw new Error("单次最多读取 200 行");
    const actualEnd = Math.min(requestedEnd, lines.length);
    const selected = lines.slice(requestedStart - 1, actualEnd).join("\n");
    if (selected.length > 12_000) throw new Error("行范围超过 12000 字符，请缩小读取范围");
    return JSON.stringify({ path, startLine: requestedStart, endLine: actualEnd, lineCount: lines.length,
      characters: selected.length, content: selected });
  }
  const sections = documentSections(content);
  const requestedSection = typeof input.section === "string" ? input.section.trim().replace(/^#{1,6}\s+/, "") : "";
  if (requestedSection || input.lastSection === true) {
    if (!sections.length) throw new Error("文档没有 Markdown 标题，无法按节读取；请改用 block");
    const matches = requestedSection
      ? sections.filter(item => item.heading === requestedSection)
      : [sections[sections.length - 1]];
    if (!matches.length) throw new Error(`未找到标题“${requestedSection}”；请先用 inspect_document 查看标题结构`);
    if (matches.length > 1) throw new Error(`标题“${requestedSection}”出现多次，请改用唯一标题或 block 读取`);
    const selected = matches[0];
    return JSON.stringify({
      path,
      section: selected.section,
      sectionCount: sections.length,
      heading: selected.heading,
      level: selected.level,
      startLine: selected.startLine,
      endLine: selected.endLine,
      characters: selected.characters,
      hasPrevious: selected.section > 1,
      hasNext: selected.section < sections.length,
      content: selected.content,
    });
  }
  const blocks = documentBlocks(content);
  const requestedBlock = optionalPositiveInteger(input.block, "block") ?? 1;
  if (requestedBlock > blocks.length) throw new Error(`block 超出范围；文档共 ${blocks.length} 块`);
  const selected = blocks[requestedBlock - 1];
  return JSON.stringify({
    path,
    block: selected.block,
    blockCount: blocks.length,
    startLine: selected.startLine,
    endLine: selected.endLine,
    characters: selected.characters,
    hasPrevious: selected.block > 1,
    hasNext: selected.block < blocks.length,
    content: selected.content,
  });
}

export function handleSearchProject({ input, project, store }: ToolHandlerArgs): string {
  const allowedScopes = new Set(["all", "lore", "story", "outline", "chapters"]);
  const allowedModes = new Set(["any", "all", "exact"]);
  const scope = typeof input.scope === "string" && allowedScopes.has(input.scope)
    ? input.scope as "all" | "lore" | "story" | "outline" | "chapters"
    : "all";
  const mode = typeof input.mode === "string" && allowedModes.has(input.mode) ? input.mode as "any" | "all" | "exact" : "any";
  const limit = Math.max(1, Math.min(12, optionalPositiveInteger(input.limit, "limit") ?? 8));
  const contextLines = typeof input.contextLines === "number" && Number.isFinite(input.contextLines)
    ? Math.max(0, Math.min(12, Math.round(input.contextLines))) : 2;
  const pathPrefix = typeof input.pathPrefix === "string" ? input.pathPrefix : undefined;
  return JSON.stringify({ query: requireString(input.query, "query"), scope, mode,
    matches: store.search(requireString(input.query, "query"), limit, { scope, mode, contextLines, pathPrefix })
      .filter(item => !project.isDocumentHidden(item.path)) });
}
