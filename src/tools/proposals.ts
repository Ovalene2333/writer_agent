import type { AgentEvent, PermissionMode, Proposal, ProposalCharacterChange } from "../types.js";
import { documentKind } from "../project.js";
import { adjudicateProseStyleForProposal } from "../prose_adjudicate.js";
import { newProseStyleIssues, proseStyleIssuesError } from "../prose_quality.js";
import { findProseMetaLeaks, sanitizeProseMetaLeaks } from "../write_pack.js";
import type { WriterStore } from "../store.js";
import type { ToolHandlerArgs } from "./types.js";
import { assertCreativeOutlineDesigned, assertWritableMode, countOccurrences, rejectCompressedPlaceholder, requireString } from "./helpers.js";

function assertWritePackReady(context: ToolHandlerArgs["context"], toolName: string): void {
  if (!context.requireWritePack) return;
  if (context.writePackCompiled) return;
  throw new Error(
    `${toolName} 前须先调用 compile_write_pack：把大纲/设定/衔接笔记编译为故事内「可写材料」，再据此提交正文。禁止跳过编译直接提案。`,
  );
}

function assertDirectChapterWriteAllowed(context: ToolHandlerArgs["context"], path: string, toolName: string): void {
  if (!context.requireScenePipeline || documentKind(path) !== "chapter") return;
  throw new Error(
    `${toolName} 不能跳过逐场景章节流水线：先 begin_chapter_draft，逐场 write_chapter_scene（内含 notes 编译），` +
    "再 inspect_chapter_draft 与 propose_chapter_draft。",
  );
}

/** Auto-fix referential meta leaks; block if residual high-confidence leaks remain. */
function gateProseMetaLeaks(content: string, path: string): { content: string; stripped: string[] } {
  const cleaned = sanitizeProseMetaLeaks(content, { targetPath: path });
  const residual = findProseMetaLeaks(cleaned.text);
  if (residual.length) {
    throw new Error(
      `正文含非叙事元信息污染（${residual.join("、")}）。请改写后重提：勿用章节/路径/大纲指称；勿把角色卡写成「未解锁/还锁着/档案锁定」或「不是A不是B——还锁着」点名列举；本场不能用的能力直接不写，或只写可感限制。`,
    );
  }
  return { content: cleaned.text, stripped: cleaned.stripped };
}

function deferredCharacterChanges(value: unknown, characterScope?: number[]): ProposalCharacterChange[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("characterChanges 必须是数组");
  const seen = new Set<number>();
  return value.slice(0, 8).map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`characterChanges[${index}] 格式无效`);
    const item = raw as Record<string, unknown>;
    const characterId = Number(item.characterId);
    if (!Number.isInteger(characterId) || characterId <= 0) throw new Error(`characterChanges[${index}].characterId 无效`);
    if (seen.has(characterId)) throw new Error(`角色 ${characterId} 在 characterChanges 中重复；请合并为一项`);
    if (characterScope !== undefined && !characterScope.includes(characterId)) throw new Error(`角色 ${characterId} 不在本次可读范围内`);
    seen.add(characterId);
    const reason = requireString(item.reason, `characterChanges[${index}].reason`).slice(0, 400);
    if (!Array.isArray(item.changes) || !item.changes.length) throw new Error(`characterChanges[${index}].changes 不能为空`);
    const changes = item.changes.slice(0, 12).map((change, changeIndex) => {
      if (!change || typeof change !== "object" || Array.isArray(change)) {
        throw new Error(`characterChanges[${index}].changes[${changeIndex}] 格式无效`);
      }
      const op = typeof (change as Record<string, unknown>).op === "string"
        ? String((change as Record<string, unknown>).op).trim()
        : "";
      if (!op) throw new Error(`characterChanges[${index}].changes[${changeIndex}].op 不能为空`);
      return { ...(change as Record<string, unknown>), op };
    });
    return { characterId, reason, changes };
  });
}

export function maybeAutoAcceptProposal(
  store: WriterStore,
  proposal: { id: number; status: string },
  permissionMode: PermissionMode,
  emit: (event: AgentEvent) => void,
): { proposalId: number; status: string; message: string; autoAccepted?: boolean } {
  if (permissionMode !== "auto" || proposal.status !== "pending") {
    return {
      proposalId: proposal.id,
      status: proposal.status,
      message: permissionMode === "plan" ? "plan 模式不应产生提案" : "已等待用户审批",
    };
  }
  try {
    const accepted = store.acceptProposal(proposal.id);
    emit({ type: "proposal", proposal: accepted });
    return {
      proposalId: accepted.id,
      status: accepted.status,
      autoAccepted: true,
      message: "auto 模式：提案已自动写入文件",
    };
  } catch (error) {
    return {
      proposalId: proposal.id,
      status: "pending",
      message: `自动接受失败：${error instanceof Error ? error.message : String(error)}；提案仍待审批`,
    };
  }
}

async function gateProseStyle(
  beforeContent: string,
  afterContent: string,
  context: ToolHandlerArgs["context"],
): Promise<void> {
  let issues = newProseStyleIssues(beforeContent, afterContent);
  if (context.proseAdjudicator) {
    const flash = await adjudicateProseStyleForProposal(
      afterContent,
      issues,
      context.proseAdjudicator.model,
      { signal: context.proseAdjudicator.signal },
    );
    issues = flash.issues;
  }
  const styleError = proseStyleIssuesError(issues);
  if (styleError) throw new Error(styleError);
}

export async function handleProposeDocument({ input, project, store, sessionId, emit, context, characterScope }: ToolHandlerArgs): Promise<string> {
  assertWritableMode(context.permissionMode, "propose_document");
  const path = requireString(input.path, "path");
  assertDirectChapterWriteAllowed(context, path, "propose_document");
  return submitFullDocumentProposal(
    { input, project, store, sessionId, emit, context, characterScope },
    path,
    requireString(input.content, "content"),
    requireString(input.summary, "summary"),
    input.characterChanges,
  );
}

export async function submitFullDocumentProposal(
  { project, store, sessionId, emit, context, characterScope }: ToolHandlerArgs,
  path: string,
  proposedContent: string,
  summary: string,
  characterChanges: unknown,
  scenePipelineAssembled = false,
): Promise<string> {
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  assertCreativeOutlineDesigned(context, path, "propose_document");
  if (!scenePipelineAssembled) assertWritePackReady(context, "propose_document");
  rejectCompressedPlaceholder(proposedContent, "content");
  const beforeContent = project.documentExists(path) ? project.read(path) : "";
  const meta = gateProseMetaLeaks(proposedContent, path);
  await gateProseStyle(beforeContent, meta.content, context);
  const proposal = store.createProposal(
    sessionId,
    path,
    meta.content,
    summary,
    deferredCharacterChanges(characterChanges, characterScope),
  );
  emit({ type: "proposal", proposal });
  return JSON.stringify({
    ...maybeAutoAcceptProposal(store, proposal, context.permissionMode, emit),
    ...(meta.stripped.length ? { metaSanitized: meta.stripped } : {}),
  });
}

export async function handleProposeDocumentPatch({ input, project, store, sessionId, emit, context, characterScope }: ToolHandlerArgs): Promise<string> {
  assertWritableMode(context.permissionMode, "propose_document_patch");
  const path = requireString(input.path, "path");
  assertDirectChapterWriteAllowed(context, path, "propose_document_patch");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  assertCreativeOutlineDesigned(context, path, "propose_document_patch");
  assertWritePackReady(context, "propose_document_patch");
  const edits = Array.isArray(input.edits) ? input.edits.slice(0, 20) : [];
  if (!edits.length) throw new Error("局部修改至少需要一条 edit");
  const beforeContent = project.read(path);
  let content = beforeContent;
  const strippedMeta: string[] = [];
  for (const [index, rawEdit] of edits.entries()) {
    if (!rawEdit || typeof rawEdit !== "object") throw new Error(`第 ${index + 1} 条 edit 格式无效`);
    const edit = rawEdit as Record<string, unknown>;
    const search = requireString(edit.search, `edits[${index}].search`);
    let replace = typeof edit.replace === "string" ? edit.replace : undefined;
    if (replace === undefined) throw new Error(`缺少有效参数：edits[${index}].replace`);
    rejectCompressedPlaceholder(search, `edits[${index}].search`);
    rejectCompressedPlaceholder(replace, `edits[${index}].replace`);
    // Only gate newly written text — do not re-scan pre-existing body for legacy leaks.
    const cleaned = gateProseMetaLeaks(replace, path);
    replace = cleaned.content;
    strippedMeta.push(...cleaned.stripped);
    const occurrences = countOccurrences(content, search);
    if (occurrences !== 1) throw new Error(`第 ${index + 1} 条 search 在原文中出现 ${occurrences} 次，必须唯一`);
    content = content.replace(search, replace);
  }
  await gateProseStyle(beforeContent, content, context);
  const proposal = store.createProposal(
    sessionId, path, content, requireString(input.summary, "summary"),
    deferredCharacterChanges(input.characterChanges, characterScope),
  );
  emit({ type: "proposal", proposal });
  const uniqueStripped = [...new Set(strippedMeta)];
  return JSON.stringify({
    edits: edits.length,
    ...maybeAutoAcceptProposal(store, proposal, context.permissionMode, emit),
    ...(uniqueStripped.length ? { metaSanitized: uniqueStripped } : {}),
  });
}

export type { Proposal };
