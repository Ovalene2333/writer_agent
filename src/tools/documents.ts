import { documentBlocks, documentSections } from "../document_blocks.js";
import { adjudicateProseStyleForAudit, applyCachedProseVerdicts } from "../prose_adjudicate.js";
import { analyzeProseStyle } from "../prose_quality.js";
import { assembleChapterSceneDraft, chapterSceneDraftComplete } from "../scene_pipeline.js";
import type { ToolHandlerArgs } from "./types.js";
import { documentMap, optionalPositiveInteger, requireString } from "./helpers.js";

export function handleListDocuments({ project }: ToolHandlerArgs): string {
  return JSON.stringify(documentMap(project));
}

export async function handleAuditProseStyle({ input, project, context }: ToolHandlerArgs): Promise<string> {
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const activeDraft = context.chapterSceneDraft?.path === path && chapterSceneDraftComplete(context.chapterSceneDraft)
    ? context.chapterSceneDraft
    : undefined;
  const content = activeDraft ? assembleChapterSceneDraft(activeDraft) : project.read(path);
  // Draft audits share the gate's verdict cache so audit → inspect never disagree
  // on the same sentence and repeated audits skip already-adjudicated candidates.
  const verdictCache = activeDraft ? (context.proseVerdictCache ??= new Map()) : undefined;
  const rules = applyCachedProseVerdicts(content, analyzeProseStyle(content), verdictCache);
  const flash = await adjudicateProseStyleForAudit(
    content,
    rules,
    context.proseAdjudicator?.model,
    { signal: context.proseAdjudicator?.signal, verdictCache },
  );
  const issues = flash.issues;
  return JSON.stringify({
    path,
    source: activeDraft ? "chapter_draft" : "document",
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

/** Longest quote sub-segment worth retrying when the exact quote misses (ellipsis/typo tolerance). */
function longestQuoteFragment(quote: string): string | undefined {
  const fragments = quote.split(/[\r\n]+|…{1,2}|\.{3,}/).map(part => part.trim()).filter(part => part.length >= 8);
  if (!fragments.length) return undefined;
  return fragments.reduce((longest, part) => part.length > longest.length ? part : longest, "");
}

function locateQuoteMatches(content: string, needle: string): Array<{ startLine: number; endLine: number }> {
  const matches: Array<{ startLine: number; endLine: number }> = [];
  let offset = 0;
  while (matches.length < 4) {
    const index = content.indexOf(needle, offset);
    if (index < 0) break;
    const startLine = content.slice(0, index).split(/\r?\n/).length;
    const endLine = content.slice(0, index + needle.length).split(/\r?\n/).length;
    matches.push({ startLine, endLine });
    offset = index + needle.length;
  }
  return matches;
}

/** One-call locator for user-quoted prose: exact substring → line range + nearby context. */
function readDocumentByQuote(path: string, content: string, quote: string): string {
  const lines = content.split(/\r?\n/);
  const trimmed = quote.trim();
  let needle = trimmed;
  let matches = locateQuoteMatches(content, needle);
  let approximate = false;
  if (!matches.length) {
    const fragment = longestQuoteFragment(trimmed);
    if (fragment && fragment !== trimmed) {
      needle = fragment;
      matches = locateQuoteMatches(content, fragment);
      approximate = matches.length > 0;
    }
  }
  if (!matches.length) {
    return JSON.stringify({
      path, quote: trimmed.slice(0, 80), occurrences: 0, matches: [],
      hint: "未找到该原文；请缩短引用片段（避免省略号拼接与转写差异）后重试，或改用 search_project",
    });
  }
  const contextRadius = 2;
  return JSON.stringify({
    path,
    quote: trimmed.slice(0, 80),
    ...(approximate ? { matchedFragment: needle.slice(0, 80) } : {}),
    lineCount: lines.length,
    occurrences: matches.length > 3 ? "3+" : matches.length,
    matches: matches.slice(0, 3).map(match => {
      const contextStart = Math.max(1, match.startLine - contextRadius);
      const contextEnd = Math.min(lines.length, match.endLine + contextRadius);
      return {
        startLine: match.startLine,
        endLine: match.endLine,
        contextStartLine: contextStart,
        context: lines.slice(contextStart - 1, contextEnd).join("\n").slice(0, 1_500),
      };
    }),
  });
}

export function handleReadDocument({ input, project }: ToolHandlerArgs): string {
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const content = project.read(path);
  if (typeof input.quote === "string" && input.quote.trim()) {
    return readDocumentByQuote(path, content, input.quote);
  }
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
