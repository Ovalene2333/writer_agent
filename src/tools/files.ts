import { documentBlocks } from "../document_blocks.js";
import { documentKind } from "../project.js";
import type { ChangeSetFileOperation } from "../types.js";
import { assertWritableMode, optionalPositiveInteger, requireString } from "./helpers.js";
import { captureAcceptedContinuityFacts, gateProseStyle, prepareDeferredCharacterChanges } from "./proposals.js";
import type { ToolHandlerArgs } from "./types.js";

const READ_BLOCK_TARGET_CHARACTERS = 3_000;
const MAX_READ_CHARACTERS = 4_000;

function assertExpectedSourceHash(input: Record<string, unknown>, sourceHash: string): void {
  if (input.sourceHash === undefined) return;
  if (typeof input.sourceHash !== "string" || !input.sourceHash.trim()) {
    throw new Error("sourceHash 必须是 inspect_file 返回的非空字符串");
  }
  if (input.sourceHash.trim() !== sourceHash) {
    throw new Error(`文件快照已变化；期望 ${input.sourceHash.trim()}，当前 ${sourceHash}。请重新 inspect 后按新快照读取`);
  }
}

export function handleListFiles({ input, project }: ToolHandlerArgs): string {
  const prefix = typeof input.pathPrefix === "string"
    ? input.pathPrefix.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
    : "";
  const cursor = typeof input.cursor === "string" ? input.cursor : "";
  const limit = Math.max(1, Math.min(200, optionalPositiveInteger(input.limit, "limit") ?? 100));
  const all = project.listTextFiles()
    .filter(path => !project.isDocumentHidden(path))
    .filter(path => !prefix || path === prefix || path.startsWith(`${prefix}/`))
    .filter(path => !cursor || path.localeCompare(cursor, undefined, { numeric: true }) > 0);
  const files = all.slice(0, limit);
  return JSON.stringify({ files, count: files.length, hasMore: all.length > files.length, nextCursor: all.length > files.length ? files.at(-1) : undefined });
}

export function handleInspectFile({ input, project }: ToolHandlerArgs): string {
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文件已对 Agent 屏蔽");
  const content = project.readTextFile(path);
  const sourceHash = project.hash(content);
  assertExpectedSourceHash(input, sourceHash);
  const lines = content.split(/\r?\n/);
  const blocks = documentBlocks(content, READ_BLOCK_TARGET_CHARACTERS);
  return JSON.stringify({
    path,
    sourceHash,
    lineCount: lines.length,
    characterCount: content.length,
    blockCount: blocks.length,
    blocks: blocks.map(block => ({ block: block.block, startLine: block.startLine, endLine: block.endLine, characters: block.characters })),
    opening: lines.slice(0, 8).join("\n").slice(0, 1_200),
    ending: lines.slice(-8).join("\n").slice(-1_200),
  });
}

export function handleReadFile({ input, project }: ToolHandlerArgs): string {
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文件已对 Agent 屏蔽");
  const content = project.readTextFile(path);
  const sourceHash = project.hash(content);
  assertExpectedSourceHash(input, sourceHash);
  const lines = content.split(/\r?\n/);
  const quote = typeof input.quote === "string" ? input.quote.trim() : "";
  if (quote) {
    const offset = content.indexOf(quote);
    if (offset < 0) return JSON.stringify({ path, quote: quote.slice(0, 120), occurrences: 0, matches: [] });
    const startLine = content.slice(0, offset).split(/\r?\n/).length;
    const endLine = content.slice(0, offset + quote.length).split(/\r?\n/).length;
    const contextStart = Math.max(1, startLine - 2);
    const contextEnd = Math.min(lines.length, endLine + 2);
    return JSON.stringify({ path, sourceHash, quote: quote.slice(0, 120), startLine, endLine,
      contextStartLine: contextStart, contextEndLine: contextEnd,
      content: lines.slice(contextStart - 1, contextEnd).join("\n").slice(0, 3_000) });
  }
  const startLine = optionalPositiveInteger(input.startLine, "startLine");
  const endLine = optionalPositiveInteger(input.endLine, "endLine");
  if ((startLine === undefined) !== (endLine === undefined)) throw new Error("startLine 和 endLine 必须同时提供");
  if (startLine !== undefined && endLine !== undefined) {
    if (startLine > endLine) throw new Error("startLine 不能大于 endLine");
    if (startLine > lines.length) throw new Error(`startLine 超出范围；文件共 ${lines.length} 行`);
    if (endLine - startLine + 1 > 120) throw new Error("单次最多读取 120 行");
    const actualEnd = Math.min(endLine, lines.length);
    const selected = lines.slice(startLine - 1, actualEnd).join("\n");
    if (selected.length > MAX_READ_CHARACTERS) throw new Error(`读取范围超过 ${MAX_READ_CHARACTERS} 字符，请缩小范围`);
    return JSON.stringify({ path, sourceHash, startLine, endLine: actualEnd, lineCount: lines.length, content: selected });
  }
  const blocks = documentBlocks(content, READ_BLOCK_TARGET_CHARACTERS);
  const block = optionalPositiveInteger(input.block, "block") ?? 1;
  if (block > blocks.length) throw new Error(`block 超出范围；文件共 ${blocks.length} 块`);
  const selected = blocks[block - 1];
  const bounded = selected.content.slice(0, MAX_READ_CHARACTERS);
  return JSON.stringify({ path, sourceHash, block, blockCount: blocks.length,
    startLine: selected.startLine,
    endLine: Math.min(selected.endLine, selected.startLine + (bounded.match(/\n/g)?.length ?? 0)),
    truncated: bounded.length < selected.content.length,
    hasPrevious: block > 1, hasNext: block < blocks.length, content: bounded });
}

export function handleSearchFiles({ input, project }: ToolHandlerArgs): string {
  const query = requireString(input.query, "query");
  const prefix = typeof input.pathPrefix === "string"
    ? input.pathPrefix.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
    : "";
  const limit = Math.max(1, Math.min(20, optionalPositiveInteger(input.limit, "limit") ?? 8));
  const needle = query.toLocaleLowerCase();
  const matches: Array<{ path: string; line: number; excerpt: string }> = [];
  for (const path of project.listTextFiles()) {
    if (matches.length >= limit) break;
    if (project.isDocumentHidden(path) || (prefix && path !== prefix && !path.startsWith(`${prefix}/`))) continue;
    const content = project.readTextFile(path);
    const offset = content.toLocaleLowerCase().indexOf(needle);
    if (offset < 0) continue;
    const line = content.slice(0, offset).split(/\r?\n/).length;
    const lines = content.split(/\r?\n/);
    matches.push({ path, line, excerpt: lines.slice(Math.max(0, line - 2), Math.min(lines.length, line + 1)).join("\n").slice(0, 1_500) });
  }
  return JSON.stringify({ query, matches });
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
  const preparedCharacterChanges = prepareDeferredCharacterChanges(input.characterChanges, context, characterScope);
  if (!files.length && !preparedCharacterChanges.changes.length) {
    if (preparedCharacterChanges.skipped) throw new Error("角色演进已关闭；不能创建仅含角色演进的 change set");
    throw new Error("change set 至少需要 files 或 characterChanges");
  }
  for (const file of files) {
    if ((file.operation === "write" || file.operation === "patch") && documentKind(file.path) === "chapter") {
      const before = project.textFileExists(file.path) ? project.readTextFile(file.path) : "";
      let after = file.content ?? before;
      for (const edit of file.edits ?? []) after = after.replace(edit.search, edit.replace);
      await gateProseStyle(before, after, context);
    }
  }
  const changeSet = store.createChangeSet(
    sessionId,
    requireString(input.summary, "summary"),
    files,
    preparedCharacterChanges.changes,
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
    const indexed: Array<{ continuityFacts: number; continuityFactWarning?: string }> = [];
    for (const file of accepted.files) {
      if (file.operation === "delete" || file.operation === "move") continue;
      indexed.push(await captureAcceptedContinuityFacts(store, {
        id: 0,
        path: file.path,
        beforeContent: file.beforeContent,
        afterContent: file.afterContent,
      }, context));
    }
    return JSON.stringify({ changeSetId: accepted.id, status: accepted.status, files: accepted.files.length, autoAccepted: true,
      continuityFacts: indexed.reduce((sum, item) => sum + item.continuityFacts, 0),
      continuityFactWarnings: indexed.flatMap(item => item.continuityFactWarning ? [item.continuityFactWarning] : []),
      ...(preparedCharacterChanges.skipped ? { characterEvolutionSkipped: true } : {}) });
  } catch (error) {
    return JSON.stringify({ changeSetId: changeSet.id, status: "pending",
      message: `自动接受失败，change set 仍待审批：${error instanceof Error ? error.message : String(error)}` });
  }
}
