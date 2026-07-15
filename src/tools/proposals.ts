import type { AgentEvent, PermissionMode, Proposal, ProposalCharacterChange } from "../types.js";
import { adjudicateProseStyleForProposal } from "../prose_adjudicate.js";
import { newProseStyleIssues, proseStyleIssuesError } from "../prose_quality.js";
import type { WriterStore } from "../store.js";
import type { ToolHandlerArgs } from "./types.js";
import { assertCreativeOutlineDesigned, assertWritableMode, countOccurrences, rejectCompressedPlaceholder, requireString } from "./helpers.js";

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
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  assertCreativeOutlineDesigned(context, path, "propose_document");
  const proposedContent = requireString(input.content, "content");
  rejectCompressedPlaceholder(proposedContent, "content");
  const beforeContent = project.documentExists(path) ? project.read(path) : "";
  await gateProseStyle(beforeContent, proposedContent, context);
  const proposal = store.createProposal(
    sessionId,
    path,
    proposedContent,
    requireString(input.summary, "summary"),
    deferredCharacterChanges(input.characterChanges, characterScope),
  );
  emit({ type: "proposal", proposal });
  return JSON.stringify(maybeAutoAcceptProposal(store, proposal, context.permissionMode, emit));
}

export async function handleProposeDocumentPatch({ input, project, store, sessionId, emit, context, characterScope }: ToolHandlerArgs): Promise<string> {
  assertWritableMode(context.permissionMode, "propose_document_patch");
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  assertCreativeOutlineDesigned(context, path, "propose_document_patch");
  const edits = Array.isArray(input.edits) ? input.edits.slice(0, 20) : [];
  if (!edits.length) throw new Error("局部修改至少需要一条 edit");
  const beforeContent = project.read(path);
  let content = beforeContent;
  for (const [index, rawEdit] of edits.entries()) {
    if (!rawEdit || typeof rawEdit !== "object") throw new Error(`第 ${index + 1} 条 edit 格式无效`);
    const edit = rawEdit as Record<string, unknown>;
    const search = requireString(edit.search, `edits[${index}].search`);
    const replace = typeof edit.replace === "string" ? edit.replace : undefined;
    if (replace === undefined) throw new Error(`缺少有效参数：edits[${index}].replace`);
    rejectCompressedPlaceholder(search, `edits[${index}].search`);
    rejectCompressedPlaceholder(replace, `edits[${index}].replace`);
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
  return JSON.stringify({ edits: edits.length, ...maybeAutoAcceptProposal(store, proposal, context.permissionMode, emit) });
}

export type { Proposal };
