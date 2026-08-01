import { documentBlocks, documentSections } from "../document_blocks.js";
import { documentSpanCatalog, documentSpans } from "../document_spans.js";
import { requestDocumentLocator, type DocumentLocatorCandidate } from "../document_locator.js";
import { adjudicateLearnedProseGates, adjudicateProseStyleForAudit, applyCachedProseVerdicts } from "../prose_adjudicate.js";
import { analyzeProseStyle } from "../prose_quality.js";
import { assembleChapterSceneDraft, chapterSceneDraftComplete } from "../scene_pipeline.js";
import { documentKind } from "../project.js";
import { proseGateRulesForTarget } from "../prose_gate_rules.js";
import type { ToolHandlerArgs } from "./types.js";
import { documentMap, optionalPositiveInteger, requireString } from "./helpers.js";

const READ_BLOCK_TARGET_CHARACTERS = 3_000;
const MAX_READ_CHARACTERS = 4_000;

function assertExpectedSourceHash(input: Record<string, unknown>, sourceHash: string): void {
  if (input.sourceHash === undefined) return;
  if (typeof input.sourceHash !== "string" || !input.sourceHash.trim()) {
    throw new Error("sourceHash 必须是 inspect_document 返回的非空字符串");
  }
  if (input.sourceHash.trim() !== sourceHash) {
    throw new Error(`文档快照已变化；期望 ${input.sourceHash.trim()}，当前 ${sourceHash}。请重新 inspect 后按新快照读取`);
  }
}

function newlineCount(value: string): number {
  return value.match(/\n/g)?.length ?? 0;
}

function boundedText(value: string, fromEnd = false): { content: string; truncated: boolean } {
  if (value.length <= MAX_READ_CHARACTERS) return { content: value, truncated: false };
  if (fromEnd) {
    const rawStart = value.length - MAX_READ_CHARACTERS;
    const lineStart = value.indexOf("\n", rawStart);
    const start = lineStart >= 0 && lineStart - rawStart < MAX_READ_CHARACTERS / 2 ? lineStart + 1 : rawStart;
    return { content: value.slice(start), truncated: true };
  }
  const lineEnd = value.lastIndexOf("\n", MAX_READ_CHARACTERS);
  const end = lineEnd >= MAX_READ_CHARACTERS / 2 ? lineEnd : MAX_READ_CHARACTERS;
  return {
    content: value.slice(0, end),
    truncated: true,
  };
}

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
    {
      signal: context.proseAdjudicator?.signal,
      verdictCache,
      usageReporter: context.modelUsageReporter,
      callKind: "prose_audit",
    },
  );
  const issues = flash.issues;
  issues.push(...await adjudicateLearnedProseGates(
    content,
    proseGateRulesForTarget(context.proseGateRules ?? [], { kind: documentKind(path), path }),
    context.proseAdjudicator?.model,
    {
      signal: context.proseAdjudicator?.signal,
      usageReporter: context.modelUsageReporter,
      callKind: "learned_prose_audit",
    },
  ));
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

export function handleInspectDocument({ input, project, context }: ToolHandlerArgs): string {
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  if (context.editScope === "point") {
    throw new Error("局部修改禁止 inspect 整篇；请用 locate_document_span 取得 sourceHash 和目标锚点");
  }
  const content = project.read(path);
  const sourceHash = project.hash(content);
  assertExpectedSourceHash(input, sourceHash);
  const lines = content.split(/\r?\n/);
  const blocks = documentBlocks(content, READ_BLOCK_TARGET_CHARACTERS);
  const spans = documentSpans(content, sourceHash);
  const headings = spans.filter(span => span.kind === "heading").slice(0, 120).map(span => ({
    line: span.startLine, text: span.content, anchorId: span.anchorId, spanHash: span.spanHash,
  }));
  return JSON.stringify({
    path,
    sourceHash,
    lineCount: lines.length,
    characterCount: content.length,
    blockCount: blocks.length,
    spanCount: spans.length,
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
        contextEndLine: contextEnd,
        context: lines.slice(contextStart - 1, contextEnd).join("\n").slice(0, 1_500),
      };
    }),
  });
}

export function handleReadDocument({ input, project, context }: ToolHandlerArgs): string {
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const content = project.read(path);
  const sourceHash = project.hash(content);
  assertExpectedSourceHash(input, sourceHash);
  if (context.editScope === "point" && context.editTargetLocked?.path === path
    && !(typeof input.quote === "string" && input.quote.trim())) {
    throw new Error("局部修改目标已锁定；禁止继续按块/节/行读取，请直接对已读锚点提交 patch");
  }
  if (typeof input.quote === "string" && input.quote.trim()) {
    const located = JSON.parse(readDocumentByQuote(path, content, input.quote)) as Record<string, unknown>;
    const spans = documentSpans(content, sourceHash);
    const matches = Array.isArray(located.matches) ? located.matches.map(rawMatch => {
      const match = rawMatch as Record<string, unknown>;
      const startLine = Number(match.startLine);
      const endLine = Number(match.endLine);
      const covered = spans.filter(span => span.endLine >= startLine && span.startLine <= endLine);
      return {
        ...match,
        anchorIds: covered.map(span => span.anchorId),
        ...(covered[0] ? { startAnchorId: covered[0].anchorId, startSpanHash: covered[0].spanHash } : {}),
        ...(covered.at(-1) ? { endAnchorId: covered.at(-1)!.anchorId, endSpanHash: covered.at(-1)!.spanHash } : {}),
      };
    }) : [];
    if (matches.length) {
      const first = matches[0] as Record<string, unknown>;
      const anchorIds = Array.isArray(first.anchorIds)
        ? first.anchorIds.filter((value): value is string => typeof value === "string")
        : [first.startAnchorId, first.endAnchorId].filter((value): value is string => typeof value === "string");
      context.editTargetLocked = { path, sourceHash, anchorIds: [...new Set(anchorIds)] };
    }
    return JSON.stringify({ ...located, matches, sourceHash });
  }
  const requestedStart = optionalPositiveInteger(input.startLine, "startLine");
  const requestedEnd = optionalPositiveInteger(input.endLine, "endLine");
  if ((requestedStart === undefined) !== (requestedEnd === undefined)) throw new Error("startLine 和 endLine 必须同时提供");
  if (requestedStart !== undefined && requestedEnd !== undefined) {
    const lines = content.split(/\r?\n/);
    if (requestedStart > requestedEnd) throw new Error("startLine 不能大于 endLine");
    if (requestedStart > lines.length) throw new Error(`startLine 超出范围；文档共 ${lines.length} 行`);
    if (requestedEnd - requestedStart + 1 > 120) throw new Error("单次最多读取 120 行");
    const actualEnd = Math.min(requestedEnd, lines.length);
    const selected = lines.slice(requestedStart - 1, actualEnd).join("\n");
    if (selected.length > MAX_READ_CHARACTERS) throw new Error(`行范围超过 ${MAX_READ_CHARACTERS} 字符，请缩小读取范围`);
    return JSON.stringify({ path, sourceHash, startLine: requestedStart, endLine: actualEnd, lineCount: lines.length,
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
    const fromEnd = input.lastSection === true;
    const bounded = boundedText(selected.content, fromEnd);
    const returnedStartLine = fromEnd && bounded.truncated
      ? Math.max(selected.startLine, selected.endLine - newlineCount(bounded.content))
      : selected.startLine;
    const returnedEndLine = fromEnd
      ? selected.endLine
      : Math.min(selected.endLine, selected.startLine + newlineCount(bounded.content));
    return JSON.stringify({
      path,
      sourceHash,
      section: selected.section,
      sectionCount: sections.length,
      heading: selected.heading,
      level: selected.level,
      sectionStartLine: selected.startLine,
      sectionEndLine: selected.endLine,
      startLine: returnedStartLine,
      endLine: returnedEndLine,
      characters: bounded.content.length,
      truncated: bounded.truncated,
      ...(bounded.truncated && fromEnd ? { previousEndLine: Math.max(selected.startLine, returnedStartLine - 1) } : {}),
      ...(bounded.truncated && !fromEnd ? { nextStartLine: Math.min(selected.endLine, returnedEndLine + 1) } : {}),
      hasPrevious: selected.section > 1,
      hasNext: selected.section < sections.length,
      content: bounded.content,
    });
  }
  const blocks = documentBlocks(content, READ_BLOCK_TARGET_CHARACTERS);
  const requestedBlock = optionalPositiveInteger(input.block, "block") ?? 1;
  if (requestedBlock > blocks.length) throw new Error(`block 超出范围；文档共 ${blocks.length} 块`);
  const selected = blocks[requestedBlock - 1];
  const bounded = boundedText(selected.content);
  return JSON.stringify({
    path,
    sourceHash,
    block: selected.block,
    blockCount: blocks.length,
    startLine: selected.startLine,
    endLine: Math.min(selected.endLine, selected.startLine + newlineCount(bounded.content)),
    characters: bounded.content.length,
    truncated: bounded.truncated,
    hasPrevious: selected.block > 1,
    hasNext: selected.block < blocks.length,
    content: bounded.content,
  });
}

function locatorCandidates(content: string, sourceHash: string, query: string): DocumentLocatorCandidate[] {
  const spans = documentSpans(content, sourceHash).filter(span => span.kind === "paragraph");
  const terms = query.toLocaleLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu)?.slice(0, 10) ?? [];
  const ranked = spans.map(span => {
    const lower = span.content.toLocaleLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? Math.max(1, term.length) : 0), 0);
    return { span, score };
  }).sort((a, b) => b.score - a.score || a.span.index - b.span.index);
  const selected = ranked.filter(item => item.score > 0).slice(0, 16).map(item => item.span);
  const selectedIds = new Set(selected.map(span => span.anchorId));
  const remaining = spans.filter(span => !selectedIds.has(span.anchorId));
  const slots = Math.max(0, 36 - selected.length);
  for (let index = 0; index < slots && index < remaining.length; index += 1) {
    const sampled = remaining[Math.min(remaining.length - 1, Math.floor(index * remaining.length / Math.max(1, slots)))];
    if (!selectedIds.has(sampled.anchorId)) {
      selectedIds.add(sampled.anchorId);
      selected.push(sampled);
    }
  }
  return selected.map(span => ({
    anchorId: span.anchorId,
    headingPath: span.headingPath,
    startLine: span.startLine,
    endLine: span.endLine,
    preview: span.content.replace(/\s+/g, " ").slice(0, 600),
  }));
}

export async function handleLocateDocumentSpan({ input, project, context }: ToolHandlerArgs): Promise<string> {
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const content = project.read(path);
  const sourceHash = project.hash(content);
  assertExpectedSourceHash(input, sourceHash);
  const spans = documentSpans(content, sourceHash);
  const locked = context.editScope === "point" ? context.editTargetLocked : undefined;
  if (locked) {
    return JSON.stringify({
      status: "target_locked",
      path: locked.path,
      sourceHash: locked.sourceHash,
      anchorIds: locked.anchorIds,
      anchors: locked.path === path && locked.sourceHash === sourceHash
        ? spans.filter(span => locked.anchorIds.includes(span.anchorId)).map(span => documentSpanCatalog(span, 260))
        : [],
      nextAction: "propose_document_patch",
      message: "局部目标已经完整定位并读取；不要再次 search、locate、read 或改用整篇修订，下一步直接调用 propose_document_patch。",
    });
  }
  const quote = typeof input.quote === "string" ? input.quote.trim() : "";
  const heading = typeof input.heading === "string" ? input.heading.trim().replace(/^#{1,6}\s+/, "") : "";
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!quote && !heading && !query) throw new Error("quote、heading、query 至少提供一个");
  if (quote) {
    const offset = content.indexOf(quote);
    if (offset < 0) return JSON.stringify({ path, sourceHash, mode: "quote", matches: [], message: "未找到精确引用；请缩短引用或改用 query 语义定位" });
    const end = offset + quote.length;
    const matched = spans.filter(span => span.endOffset > offset && span.startOffset < end).slice(0, 8);
    return JSON.stringify({ path, sourceHash, mode: "quote", matches: matched.map(span => ({
      ...documentSpanCatalog(span, 260), confidence: 1,
    })) });
  }
  if (heading) {
    const matched = spans.filter(span => span.kind === "heading" && span.headingPath.at(-1) === heading);
    return JSON.stringify({ path, sourceHash, mode: "heading", matches: matched.slice(0, 8).map(span => ({
      ...documentSpanCatalog(span, 260), confidence: matched.length === 1 ? 1 : 0.7,
    })) });
  }
  if (!context.documentLocator) throw new Error("语义片段定位器未配置；请使用 quote/heading，或先 search_project 获取原文引用");
  const candidates = locatorCandidates(content, sourceHash, query);
  const run = context.documentLocator.run ?? requestDocumentLocator;
  const located = await run(context.documentLocator.model, { intent: query, candidates }, context.documentLocator.signal);
  if (located.usage) context.modelUsageReporter?.(context.documentLocator.model, located.usage, {
    callKind: "document_locator",
    requestComponents: [{ kind: "other", label: "隔离文档锚点定位", characters: located.requestCharacters,
      estimatedTokens: Math.ceil(located.requestCharacters * 0.75), callKind: "document_locator" }],
  });
  const byId = new Map(spans.map(span => [span.anchorId, span]));
  return JSON.stringify({
    path, sourceHash, mode: "semantic", candidateCount: candidates.length,
    matches: located.matches.flatMap(match => {
      const span = byId.get(match.anchorId);
      return span ? [{ ...documentSpanCatalog(span, 260), confidence: match.confidence, reason: match.reason }] : [];
    }),
    message: "选择最匹配的 anchorId 调用 read_document_span；不要据 preview 直接改写。",
  });
}

export function handleReadDocumentSpan({ input, project, context }: ToolHandlerArgs): string {
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const content = project.read(path);
  const sourceHash = project.hash(content);
  assertExpectedSourceHash(input, sourceHash);
  const spans = documentSpans(content, sourceHash);
  const startId = requireString(input.anchorId ?? input.startAnchorId, "anchorId");
  const endId = typeof input.endAnchorId === "string" && input.endAnchorId.trim() ? input.endAnchorId.trim() : startId;
  const startIndex = spans.findIndex(span => span.anchorId === startId);
  const endIndex = spans.findIndex(span => span.anchorId === endId);
  if (startIndex < 0 || endIndex < startIndex) throw new Error("锚点不存在、已过期或结束锚点早于开始锚点；请重新 locate");
  const before = Math.max(0, Math.min(3, Number(input.beforeParagraphs) || 0));
  const after = Math.max(0, Math.min(3, Number(input.afterParagraphs) || 0));
  const from = Math.max(0, startIndex - before);
  const to = Math.min(spans.length - 1, endIndex + after);
  const selected = spans.slice(from, to + 1);
  const body = content.slice(selected[0].startOffset, selected.at(-1)!.endOffset);
  const maxCharacters = Math.max(500, Math.min(4_000, Number(input.maxCharacters) || 1_800));
  if (body.length > maxCharacters) throw new Error(`锚点范围为 ${body.length} 字符，超过 ${maxCharacters}；减少邻段或拆分读取`);
  const target = spans.slice(startIndex, endIndex + 1);
  const locked = context.editScope === "point" ? context.editTargetLocked : undefined;
  if (locked && (locked.path !== path || locked.sourceHash !== sourceHash
    || target.some(span => !locked.anchorIds.includes(span.anchorId)))) {
    throw new Error("局部修改目标已锁定；只能读取用户选区或首次命中的目标锚点");
  }
  context.editTargetLocked = { path, sourceHash, anchorIds: target.map(span => span.anchorId) };
  return JSON.stringify({
    path, sourceHash,
    startAnchorId: target[0].anchorId,
    endAnchorId: target.at(-1)!.anchorId,
    startLine: selected[0].startLine,
    endLine: selected.at(-1)!.endLine,
    characters: body.length,
    anchors: selected.map(span => documentSpanCatalog(span, 80)),
    content: body,
    nextAction: context.editScope === "point" ? "propose_document_patch" : undefined,
    message: context.editScope === "point"
      ? "目标正文已经完整读取。下一步直接调用 propose_document_patch；不要继续 search、locate、read、整篇修订或维护 todos。"
      : "写入时使用目标 anchorId+spanHash；行号只用于展示。",
  });
}

export function handleSearchProject({ input, project, store, context }: ToolHandlerArgs): string {
  const allowedScopes = new Set(["all", "lore", "story", "outline", "chapters"]);
  const allowedModes = new Set(["any", "all", "exact"]);
  const scope = typeof input.scope === "string" && allowedScopes.has(input.scope)
    ? input.scope as "all" | "lore" | "story" | "outline" | "chapters"
    : "all";
  const locked = context.editScope === "point" ? context.editTargetLocked : undefined;
  if (locked && scope === "chapters") {
    return JSON.stringify({
      status: "target_locked",
      path: locked.path,
      sourceHash: locked.sourceHash,
      anchorIds: locked.anchorIds,
      nextAction: "propose_document_patch",
      message: "章节中的局部目标已经完整定位并读取；不要继续搜索正文，下一步直接调用 propose_document_patch。",
    });
  }
  const mode = typeof input.mode === "string" && allowedModes.has(input.mode) ? input.mode as "any" | "all" | "exact" : "any";
  const limit = Math.max(1, Math.min(12, optionalPositiveInteger(input.limit, "limit") ?? 8));
  const contextLines = typeof input.contextLines === "number" && Number.isFinite(input.contextLines)
    ? Math.max(0, Math.min(12, Math.round(input.contextLines))) : 2;
  const pathPrefix = typeof input.pathPrefix === "string" ? input.pathPrefix : undefined;
  const query = requireString(input.query, "query");
  const facts = store.searchContinuityFacts(query, Math.min(8, limit)).map(fact => ({
    id: fact.id,
    statement: fact.statement,
    kind: fact.kind,
    scope: [fact.scopeKind, fact.scopeValue].filter(Boolean).join(":"),
    epistemic: fact.epistemic,
    knownBy: fact.knownBy,
    status: fact.status,
    sourcePath: fact.sourcePath,
  }));
  const found = store.search(query, limit, { scope, mode, contextLines, pathPrefix })
    .filter(item => !project.isDocumentHidden(item.path));
  // Search is a locator, not a bulk reader. Keep the complete result atom under
  // a fixed excerpt budget even when the caller asks for many wide contexts.
  let excerptBudget = 6_000;
  const matches: typeof found = [];
  for (const item of found) {
    if (excerptBudget <= 0) break;
    const excerpt = item.excerpt.slice(0, Math.min(1_500, excerptBudget));
    matches.push({ ...item, excerpt });
    excerptBudget -= excerpt.length;
  }
  return JSON.stringify({
    query,
    scope,
    mode,
    facts,
    matches,
    truncated: matches.length < found.length || matches.some((item, index) => item.excerpt.length < found[index].excerpt.length),
  });
}
