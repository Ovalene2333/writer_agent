import { documentBlocks } from "../document_blocks.js";
import { isScenePipelineDocument } from "../project.js";
import { buildNarrativeEvidencePacket } from "../narrative_evidence.js";
import { collectRegisterRisksForContext } from "../register_risks.js";
import {
  EvidenceGroundedWriterError,
  reportAndWrapEvidenceWriterError,
  requestEvidenceGroundedProse,
} from "../evidence_grounded_writer.js";
import { reportModelCallUsage } from "../dependency_diagnostics.js";
import { chapterSceneDraftComplete } from "../scene_pipeline.js";
import { styleGroundingPrompt } from "../style_grounding.js";
import type { ChangeSetFileOperation } from "../types.js";
import {
  assertWritableMode,
  assertProseReferenceReadAllowed,
  normalizeTextFilePath,
  optionalPositiveInteger,
  proseReferenceReadAllowed,
  readableTextFile,
  requireString,
} from "./helpers.js";
import {
  handleProposeDocument,
  prepareDeferredCharacterChanges,
} from "./proposals.js";
import { handleProposeChapterDraft } from "./scene_pipeline.js";
import type { ToolHandlerArgs, WorkingTextFile } from "./types.js";

const READ_BLOCK_TARGET_CHARACTERS = 3_000;
const MAX_READ_CHARACTERS = 4_000;
const MISSING_TEXT_FILE_HASH = "__missing__";

function stageWorkingTextFile(
  args: ToolHandlerArgs,
  path: string,
  content: string,
): WorkingTextFile {
  if (content.includes("\0")) throw new Error("纯文本内容不能包含 NUL 字节");
  const normalized = normalizeTextFilePath(path);
  if (!normalized) throw new Error("path 不能为空");
  // Resolve eagerly so traversal, internal paths and symlink targets fail before
  // the body enters the overlay or an approval record.
  args.project.resolveTextFileSafe(normalized);
  if (args.project.isDocumentHidden(normalized)) throw new Error("文件已对 Agent 屏蔽");
  args.context.workingTextFiles ??= new Map();
  const previous = args.context.workingTextFiles.get(normalized);
  const baseExists = previous?.baseExists ?? args.project.textFileExists(normalized);
  const baseSourceHash = previous?.baseSourceHash ?? (baseExists
    ? args.project.hash(args.project.readTextFile(normalized))
    : MISSING_TEXT_FILE_HASH);
  const deliverableId = typeof args.input.deliverableId === "string" && args.input.deliverableId.trim()
    ? args.input.deliverableId.trim()
    : previous?.deliverableId;
  const staged: WorkingTextFile = {
    path: normalized,
    content,
    sourceHash: args.project.hash(content),
    baseExists,
    baseSourceHash,
    ...(deliverableId ? { deliverableId } : {}),
    ...(previous?.revisionCaseId ? { revisionCaseId: previous.revisionCaseId } : {}),
  };
  args.context.workingTextFiles.set(normalized, staged);
  // A successful overlay mutation starts a new readable snapshot. The old lock
  // protected the persisted base and must not make the run reject its own edit.
  args.context.readSnapshots?.delete(normalized);
  // Proposal retry persistence captures this even when edit_file only carried a
  // small exact replacement instead of the complete body.
  args.context.latestProposalDraft = {
    path: normalized,
    ...(deliverableId ? { deliverableId } : {}),
    content,
    sourceHash: staged.sourceHash,
  };
  return staged;
}

function fileMutationSummary(
  input: Record<string, unknown>,
  path: string,
  verb: "write" | "edit" | "move" | "delete",
): string {
  if (typeof input.summary === "string" && input.summary.trim()) return input.summary.trim();
  const label = verb === "write" ? "写入" : verb === "edit" ? "编辑" : verb === "move" ? "移动" : "删除";
  return `${label} ${path}`;
}

async function submitWorkingTextFile(
  args: ToolHandlerArgs,
  staged: WorkingTextFile,
  verb: "write" | "edit",
): Promise<string> {
  const summary = fileMutationSummary(args.input, staged.path, verb);
  const internalInput = {
    path: staged.path,
    content: staged.content,
    summary,
    ...(staged.deliverableId ? { deliverableId: staged.deliverableId } : {}),
    ...(isScenePipelineDocument(staged.path) && args.context.proseLength
      ? { targetCharacters: args.context.proseLength.targetCharacters }
      : {}),
  };
  const previousMutationTool = args.context.fileMutationTool;
  args.context.fileMutationTool = verb === "write" ? "write_file" : "edit_file";
  let raw: string;
  try {
    raw = staged.path.toLowerCase().endsWith(".md")
      ? await handleProposeDocument({ ...args, input: internalInput })
      : await handleProposeChangeSet({
          ...args,
          input: {
            summary,
            ...(staged.deliverableId ? { deliverableId: staged.deliverableId } : {}),
            files: [{ operation: "write", path: staged.path, content: staged.content }],
          },
        });
  } finally {
    args.context.fileMutationTool = previousMutationTool;
  }
  const normalizedDraft = args.context.latestProposalDraft;
  if (normalizedDraft?.path === staged.path && normalizedDraft.sourceHash !== staged.sourceHash) {
    staged.content = normalizedDraft.content;
    staged.sourceHash = normalizedDraft.sourceHash;
    args.context.workingTextFiles?.set(staged.path, staged);
  }
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    parsed = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : { error: "文件工具返回了不可验证结果" };
  } catch {
    parsed = { error: "文件工具返回了不可验证结果" };
  }
  const submitted = (typeof parsed.proposalId === "number" && parsed.proposalId > 0)
    || (typeof parsed.changeSetId === "number" && parsed.changeSetId > 0);
  const deliveryReady = submitted
    && parsed.rhythmRevisionRequired !== true
    && parsed.code !== "RHYTHM_POLISH_REQUIRED";
  if (deliveryReady && parsed.status === "accepted") {
    args.context.workingTextFiles?.delete(staged.path);
  }
  return JSON.stringify({
    ...parsed,
    path: staged.path,
    ...(staged.deliverableId ? { deliverableId: staged.deliverableId } : {}),
    workingCopy: !deliveryReady || parsed.status !== "accepted",
    workingSourceHash: staged.sourceHash,
  });
}

function assertExpectedSourceHash(input: Record<string, unknown>, sourceHash: string): void {
  if (input.sourceHash === undefined) return;
  if (typeof input.sourceHash !== "string" || !input.sourceHash.trim()) {
    throw new Error("sourceHash 必须是 read_file 返回的非空字符串");
  }
  if (input.sourceHash.trim() !== sourceHash) {
    throw new Error(`文件快照已变化；期望 ${input.sourceHash.trim()}，当前 ${sourceHash}。请重新 read_file 后按新快照操作`);
  }
}

export function handleListFiles(args: ToolHandlerArgs): string {
  const { input, project, context } = args;
  const prefix = typeof input.pathPrefix === "string"
    ? input.pathPrefix.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
    : "";
  const cursor = typeof input.cursor === "string" ? input.cursor : "";
  const limit = Math.max(1, Math.min(200, optionalPositiveInteger(input.limit, "limit") ?? 100));
  const all = [...new Set([
    ...project.listTextFiles(),
    ...(context.workingTextFiles?.keys() ?? []),
  ])]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .filter(path => !project.isDocumentHidden(path))
    .filter(path => proseReferenceReadAllowed(context, path))
    .filter(path => !prefix || path === prefix || path.startsWith(`${prefix}/`))
    .filter(path => !cursor || path.localeCompare(cursor, undefined, { numeric: true }) > 0);
  const files = all.slice(0, limit);
  return JSON.stringify({ files, count: files.length, hasMore: all.length > files.length, nextCursor: all.length > files.length ? files.at(-1) : undefined });
}

export function handleInspectFile(args: ToolHandlerArgs): string {
  const { input } = args;
  const path = requireString(input.path, "path");
  assertProseReferenceReadAllowed(args.context, path);
  const snapshot = readableTextFile(args, path);
  const { content, sourceHash } = snapshot;
  assertExpectedSourceHash(input, sourceHash);
  const lines = content.split(/\r?\n/);
  const blocks = documentBlocks(content, READ_BLOCK_TARGET_CHARACTERS);
  return JSON.stringify({
    path: snapshot.path,
    sourceHash,
    workingCopy: snapshot.workingCopy,
    lineCount: lines.length,
    characterCount: content.length,
    blockCount: blocks.length,
    blocks: blocks.map(block => ({ block: block.block, startLine: block.startLine, endLine: block.endLine, characters: block.characters })),
    opening: lines.slice(0, 8).join("\n").slice(0, 1_200),
    ending: lines.slice(-8).join("\n").slice(-1_200),
  });
}

export function handleReadFile(args: ToolHandlerArgs): string {
  const { input } = args;
  const path = requireString(input.path, "path");
  assertProseReferenceReadAllowed(args.context, path);
  const snapshot = readableTextFile(args, path);
  const { content, sourceHash } = snapshot;
  assertExpectedSourceHash(input, sourceHash);
  const lines = content.split(/\r?\n/);
  const quote = typeof input.quote === "string" ? input.quote.trim() : "";
  if (quote) {
    const offset = content.indexOf(quote);
    if (offset < 0) return JSON.stringify({ path: snapshot.path, sourceHash, workingCopy: snapshot.workingCopy,
      quote: quote.slice(0, 120), occurrences: 0, matches: [] });
    const startLine = content.slice(0, offset).split(/\r?\n/).length;
    const endLine = content.slice(0, offset + quote.length).split(/\r?\n/).length;
    const contextStart = Math.max(1, startLine - 2);
    const contextEnd = Math.min(lines.length, endLine + 2);
    return JSON.stringify({ path: snapshot.path, sourceHash, workingCopy: snapshot.workingCopy,
      quote: quote.slice(0, 120), startLine, endLine,
      contextStartLine: contextStart, contextEndLine: contextEnd,
      content: lines.slice(contextStart - 1, contextEnd).join("\n").slice(0, 3_000) });
  }
  const startLine = optionalPositiveInteger(input.startLine, "startLine");
  const endLine = optionalPositiveInteger(input.endLine, "endLine");
  if ((startLine === undefined) !== (endLine === undefined)) throw new Error("startLine 和 endLine 必须同时提供");
  if (startLine !== undefined && endLine !== undefined) {
    if (startLine > endLine) throw new Error("startLine 不能大于 endLine");
    if (startLine > lines.length) throw new Error(`startLine 超出范围；文件共 ${lines.length} 行`);
    const requestedEndLine = endLine;
    let actualEnd = Math.min(endLine, lines.length, startLine + 119);
    let selected = lines.slice(startLine - 1, actualEnd).join("\n");
    while (selected.length > MAX_READ_CHARACTERS && actualEnd > startLine) {
      actualEnd -= 1;
      selected = lines.slice(startLine - 1, actualEnd).join("\n");
    }
    let characterTruncated = false;
    if (selected.length > MAX_READ_CHARACTERS) {
      selected = selected.slice(0, MAX_READ_CHARACTERS);
      actualEnd = startLine + (selected.match(/\n/g)?.length ?? 0);
      characterTruncated = true;
    }
    const truncated = actualEnd < Math.min(requestedEndLine, lines.length) || characterTruncated;
    return JSON.stringify({ path: snapshot.path, sourceHash, workingCopy: snapshot.workingCopy,
      startLine, endLine: actualEnd, requestedEndLine, lineCount: lines.length, content: selected,
      truncated,
      ...(truncated && actualEnd < lines.length ? { nextStartLine: actualEnd + 1 } : {}),
      message: truncated
        ? `读取范围已自动裁剪为最多 120 行 / ${MAX_READ_CHARACTERS} 字符；需要后续内容请从 nextStartLine 继续。`
        : "读取完成" });
  }
  const blocks = documentBlocks(content, READ_BLOCK_TARGET_CHARACTERS);
  const block = optionalPositiveInteger(input.block, "block") ?? 1;
  if (block > blocks.length) throw new Error(`block 超出范围；文件共 ${blocks.length} 块`);
  const selected = blocks[block - 1];
  const bounded = selected.content.slice(0, MAX_READ_CHARACTERS);
  return JSON.stringify({ path: snapshot.path, sourceHash, workingCopy: snapshot.workingCopy,
    block, blockCount: blocks.length,
    startLine: selected.startLine,
    endLine: Math.min(selected.endLine, selected.startLine + (bounded.match(/\n/g)?.length ?? 0)),
    truncated: bounded.length < selected.content.length,
    hasPrevious: block > 1, hasNext: block < blocks.length, content: bounded });
}

export function handleSearchFiles(args: ToolHandlerArgs): string {
  const { input, project, context } = args;
  const query = requireString(input.query, "query");
  const prefix = typeof input.pathPrefix === "string"
    ? input.pathPrefix.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
    : "";
  const limit = Math.max(1, Math.min(20, optionalPositiveInteger(input.limit, "limit") ?? 8));
  const needle = query.toLocaleLowerCase();
  const matches: Array<{ path: string; line: number; excerpt: string }> = [];
  const paths = [...new Set([
    ...project.listTextFiles(),
    ...(context.workingTextFiles?.keys() ?? []),
  ])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const path of paths) {
    if (matches.length >= limit) break;
    if (project.isDocumentHidden(path) || !proseReferenceReadAllowed(context, path)
      || (prefix && path !== prefix && !path.startsWith(`${prefix}/`))) continue;
    const content = context.workingTextFiles?.get(path)?.content ?? project.readTextFile(path);
    const offset = content.toLocaleLowerCase().indexOf(needle);
    if (offset < 0) continue;
    const line = content.slice(0, offset).split(/\r?\n/).length;
    const lines = content.split(/\r?\n/);
    matches.push({ path, line, excerpt: lines.slice(Math.max(0, line - 2), Math.min(lines.length, line + 1)).join("\n").slice(0, 1_500) });
  }
  return JSON.stringify({ query, matches });
}

export async function handleWriteFile(args: ToolHandlerArgs): Promise<string> {
  assertWritableMode(args.context.permissionMode, "write_file");
  const path = requireString(args.input.path, "path");
  const existing = args.context.workingTextFiles?.get(normalizeTextFilePath(path));
  const chapterDraft = args.context.chapterSceneDraft;
  const inspectedChapterDraft = !existing
    && typeof args.input.content !== "string"
    && chapterDraft
    && normalizeTextFilePath(chapterDraft.path) === normalizeTextFilePath(path)
    && chapterSceneDraftComplete(chapterDraft)
    && chapterDraft.inspectedVersion === chapterDraft.version;
  if (inspectedChapterDraft) {
    const summary = fileMutationSummary(args.input, normalizeTextFilePath(path), "write");
    return handleProposeChapterDraft({
      ...args,
      input: {
        ...args.input,
        summary,
        chapterChange: "主 Agent 已按终审清单确认章节目标变化成立",
        reviewNotes: "主 Agent 已通读 inspect_chapter_draft 返回的当前工作副本并确认可以提交",
      },
    });
  }
  if (typeof args.input.content !== "string" && !existing
    && args.context.evidenceGroundedWriter && isScenePipelineDocument(path)) {
    return handleEvidenceGroundedWriteFile(args, path);
  }
  if (typeof args.input.content !== "string" && !existing) {
    throw new Error("新建或完整替换文件时 content 必须是字符串；只有已有工作副本或已终审场景草稿才能省略 content 重新验证");
  }
  const staged = stageWorkingTextFile(args, path, typeof args.input.content === "string"
    ? args.input.content
    : existing!.content);
  return submitWorkingTextFile(args, staged, "write");
}

async function handleEvidenceGroundedWriteFile(args: ToolHandlerArgs, path: string): Promise<string> {
  const pack = args.context.lastWritePackData;
  if (!pack || !args.context.writePackCompiled) {
    throw new Error("EVIDENCE_WRITER_PACK_REQUIRED：先 compile_write_pack 提交场景目标、人物当下、已知事实、事件方向与不可补写项，再调用 write_file(path) 并省略 content");
  }
  const writer = args.context.evidenceGroundedWriter!;
  const evidence = buildNarrativeEvidencePacket({
    project: args.project,
    store: args.store,
    context: args.context,
    sessionId: args.sessionId,
    path,
  });
  args.context.narrativeEvidencePackets?.set(path, evidence);
  const existingText = args.project.textFileExists(path) ? args.project.readTextFile(path) : "";
  const run = writer.run ?? requestEvidenceGroundedProse;
  const registerRisks = collectRegisterRisksForContext(args.store, args.context);
  if (registerRisks.length && !pack.registerRisks?.length) {
    pack.registerRisks = registerRisks.map(risk => ({
      term: risk.term,
      characterName: risk.characterName,
      source: risk.source,
      scope: risk.scope,
      reason: risk.reason,
    }));
  }
  let generated;
  try {
    generated = await run(writer.model, {
      path,
      outputKind: "document",
      writePack: pack,
      evidence,
      ...(existingText ? { existingText } : {}),
      styleEvidence: styleGroundingPrompt(args.project, args.store, {
        intensive: true,
        targetPath: path,
        excludeProjectVoice: Boolean(existingText),
        projectSampleRole: "continuity",
      }),
      targetCharacters: args.context.proseLength?.targetCharacters,
      lengthMode: args.context.proseLength?.mode,
      registerRisks,
    }, { project: args.project, context: args.context }, writer.signal);
  } catch (error) {
    // Keep writePack compiled so the Agent can omit content and retry the same pack.
    if (error instanceof EvidenceGroundedWriterError) {
      throw reportAndWrapEvidenceWriterError(
        error,
        writer.model,
        "evidence_grounded_document_writer",
        args.context.modelUsageReporter,
      );
    }
    throw error;
  }
  reportModelCallUsage(args.context.modelUsageReporter, writer.model, generated.usage, {
    callKind: "evidence_grounded_document_writer",
  });
  const content = ensureDocumentHeading(path, existingText, generated.content);
  args.context.writePackCompiled = false;
  args.context.lastWritePack = undefined;
  args.context.lastWritePackData = undefined;
  const staged = stageWorkingTextFile(args, path, content);
  const result = await submitWorkingTextFile(args, staged, "write");
  const parsed = JSON.parse(result) as Record<string, unknown>;
  return JSON.stringify({
    ...parsed,
    generationMode: "evidence_grounded_writer",
    evidenceHash: generated.evidenceHash,
    evidenceReads: generated.evidenceReads.length,
    ...(generated.emptyAutoRetryUsed ? { emptyAutoRetryUsed: true } : {}),
  });
}

function ensureDocumentHeading(path: string, existingText: string, generated: string): string {
  const body = generated.trim();
  if (/^#{1,6}\s+/u.test(body)) return `${body}\n`;
  const existingHeading = /^#\s+(.+)$/mu.exec(existingText)?.[1]?.trim();
  const pathHeading = path.split("/").at(-1)?.replace(/\.[^.]+$/u, "").trim();
  const heading = existingHeading || pathHeading || "正文";
  return `# ${heading}\n\n${body}\n`;
}

export async function handleEditFile(args: ToolHandlerArgs): Promise<string> {
  assertWritableMode(args.context.permissionMode, "edit_file");
  const path = requireString(args.input.path, "path");
  const snapshot = readableTextFile(args, path);
  assertExpectedSourceHash(args.input, snapshot.sourceHash);
  if (!Array.isArray(args.input.edits) || !args.input.edits.length) {
    throw new Error("edits 至少需要一个精确文本编辑");
  }
  if (args.input.edits.length > 20) throw new Error("单次 edit_file 最多包含 20 个编辑");
  let content = snapshot.content;
  for (const [index, raw] of args.input.edits.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`edits[${index}] 格式无效`);
    const edit = raw as Record<string, unknown>;
    const operation = typeof edit.operation === "string" ? edit.operation : "replace";
    if (!["replace", "delete", "insert_before", "insert_after"].includes(operation)) {
      throw new Error(`edits[${index}].operation 无效`);
    }
    const oldText = requireString(edit.oldText, `edits[${index}].oldText`);
    const offset = content.indexOf(oldText);
    if (offset < 0) throw new Error(`edits[${index}].oldText 在当前工作副本中不存在`);
    if (offset !== content.lastIndexOf(oldText)) {
      throw new Error(`edits[${index}].oldText 在当前工作副本中不唯一；请提供更长的上下文`);
    }
    const replacement = operation === "delete"
      ? ""
      : typeof edit.content === "string"
        ? edit.content
        : (() => { throw new Error(`edits[${index}].content 必须是字符串`); })();
    const next = operation === "insert_before"
      ? `${replacement}${oldText}`
      : operation === "insert_after"
        ? `${oldText}${replacement}`
        : replacement;
    content = `${content.slice(0, offset)}${next}${content.slice(offset + oldText.length)}`;
  }
  const staged = stageWorkingTextFile(args, snapshot.path, content);
  return submitWorkingTextFile(args, staged, "edit");
}

export async function handleMoveFile(args: ToolHandlerArgs): Promise<string> {
  assertWritableMode(args.context.permissionMode, "move_file");
  const path = normalizeTextFilePath(requireString(args.input.path, "path"));
  const targetPath = normalizeTextFilePath(requireString(args.input.targetPath, "targetPath"));
  const snapshot = readableTextFile(args, path);
  assertExpectedSourceHash(args.input, snapshot.sourceHash);
  args.project.resolveTextFileSafe(targetPath);
  if (args.project.isDocumentHidden(targetPath)) throw new Error("目标文件已对 Agent 屏蔽");
  const raw = await handleProposeChangeSet({
    ...args,
    input: {
      summary: fileMutationSummary(args.input, path, "move"),
      ...(typeof args.input.deliverableId === "string" ? { deliverableId: args.input.deliverableId } : {}),
      files: [{ operation: "move", path, targetPath }],
    },
  });
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, path, targetPath });
}

export async function handleDeleteFile(args: ToolHandlerArgs): Promise<string> {
  assertWritableMode(args.context.permissionMode, "delete_file");
  const path = normalizeTextFilePath(requireString(args.input.path, "path"));
  const snapshot = readableTextFile(args, path);
  assertExpectedSourceHash(args.input, snapshot.sourceHash);
  const raw = await handleProposeChangeSet({
    ...args,
    input: {
      summary: fileMutationSummary(args.input, path, "delete"),
      ...(typeof args.input.deliverableId === "string" ? { deliverableId: args.input.deliverableId } : {}),
      files: [{ operation: "delete", path }],
    },
  });
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, path });
}

export async function handleProposeChangeSet({ input, project, store, sessionId, emit, context, characterScope }: ToolHandlerArgs): Promise<string> {
  assertWritableMode(context.permissionMode, "propose_change_set");
  const rawFiles = Array.isArray(input.files) ? input.files.slice(0, 20) : [];
  const files = rawFiles.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`files[${index}] 格式无效`);
    const item = raw as Record<string, unknown>;
    const operation = String(item.operation ?? "") as ChangeSetFileOperation;
    const path = requireString(item.path, `files[${index}].path`);
    const edits = Array.isArray(item.edits) ? item.edits.map((edit, editIndex) => {
      if (!edit || typeof edit !== "object" || Array.isArray(edit)) throw new Error(`files[${index}].edits[${editIndex}] 格式无效`);
      const value = edit as Record<string, unknown>;
      return { search: requireString(value.search, `files[${index}].edits[${editIndex}].search`),
        replace: typeof value.replace === "string" ? value.replace : (() => { throw new Error(`files[${index}].edits[${editIndex}].replace 无效`); })() };
    }) : undefined;
    return {
      operation, path,
      ...(typeof item.targetPath === "string" ? { targetPath: item.targetPath } : {}),
      ...(typeof item.content === "string" ? { content: item.content } : {}),
      ...(edits ? { edits } : {}),
    };
  });
  const activeRevisionFile = files.find(file => context.activeProposalRevisionPaths?.has(file.path)
    || (file.targetPath && context.activeProposalRevisionPaths?.has(file.targetPath)));
  if (activeRevisionFile) {
    return JSON.stringify({
      status: "recoverable_state_error",
      code: "ACTIVE_REVISION_REQUIRES_FULL_DRAFT",
      failureKind: "invalid_request",
      retryable: true,
      path: activeRevisionFile.path,
      error: "批量变更不能修改有活动工作副本的路径；请用 read_file 查看并用 edit_file 做最小修改。",
      nextAllowedActions: ["read_file", "edit_file", "write_file"],
    });
  }
  const narrativeWrite = files.find(file => (
    (file.operation === "write" || file.operation === "patch")
      && isScenePipelineDocument(file.path)
  ) || (
    file.operation === "move"
      && file.targetPath !== undefined
      && isScenePipelineDocument(file.targetPath)
      && !isScenePipelineDocument(file.path)
  ));
  if (narrativeWrite) {
    return JSON.stringify({
      status: "recoverable_state_error",
      code: "NARRATIVE_CHANGE_SET_REQUIRES_DOCUMENT_PROPOSAL",
      failureKind: "invalid_request",
      retryable: true,
      path: narrativeWrite.targetPath ?? narrativeWrite.path,
      error: "章节正文必须通过统一文件入口执行样式、节奏与终审，不能放入普通批量变更。请改用 write_file/edit_file。",
      nextAllowedActions: ["write_file", "edit_file"],
    });
  }
  const preparedCharacterChanges = prepareDeferredCharacterChanges(input.characterChanges, context, characterScope);
  if (!files.length && !preparedCharacterChanges.changes.length) {
    if (preparedCharacterChanges.skipped) throw new Error("角色演进已关闭；不能创建仅含角色演进的 change set");
    throw new Error("change set 至少需要 files 或 characterChanges");
  }
  const changeSet = store.createChangeSet(
    sessionId,
    requireString(input.summary, "summary"),
    files,
    preparedCharacterChanges.changes,
    context.sourceMessageId,
  );
  emit({ type: "change_set", changeSet });
  if (context.permissionMode !== "auto") {
    return JSON.stringify({ changeSetId: changeSet.id, status: changeSet.status, files: changeSet.files.length,
      ...(preparedCharacterChanges.skipped ? { characterEvolutionSkipped: true } : {}),
      message: "change set 已等待用户统一审批" });
  }
  try {
    const accepted = store.acceptChangeSet(changeSet.id);
    emit({ type: "change_set", changeSet: accepted });
    return JSON.stringify({ changeSetId: accepted.id, status: accepted.status, files: accepted.files.length, autoAccepted: true,
      ...(preparedCharacterChanges.skipped ? { characterEvolutionSkipped: true } : {}) });
  } catch (error) {
    return JSON.stringify({ changeSetId: changeSet.id, status: "pending",
      message: `自动接受失败，change set 仍待审批：${error instanceof Error ? error.message : String(error)}` });
  }
}
