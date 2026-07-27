import type { AgentEvent, PermissionMode, Proposal, ProposalCharacterChange } from "../types.js";
import {
  applyCharacterChanges,
  characterChangeOpsHint,
  isCharacterChangeOp,
  normalizeCharacterChangeOp,
  validateCharacters,
} from "../characters.js";
import { adjudicateLearnedProseGates, adjudicateProseStyleForProposal } from "../prose_adjudicate.js";
import { newProseStyleIssues, proseStyleIssuesError } from "../prose_quality.js";
import { compileWritePack, findProseMetaLeaks, sanitizeProseMetaLeaks } from "../write_pack.js";
import { documentSpans } from "../document_spans.js";
import { documentBlocks } from "../document_blocks.js";
import { requestDocumentRevision } from "../document_revision.js";
import { IsolatedSceneRequestError, requestIsolatedScene } from "../isolated_scene_writer.js";
import { isolatedWriterStyleDirectives, isolatedWriterVoiceEvidence } from "../style_grounding.js";
import { documentKind, isScenePipelineDocument } from "../project.js";
import {
  DEFAULT_ISOLATED_WRITER_MAX_RATIO,
  DEFAULT_SCENE_NOTES_CHARACTERS,
} from "../agent_runtime.js";
import type { WriterStore } from "../store.js";
import type { ToolExecutionContext, ToolHandlerArgs } from "./types.js";
import {
  assertCreativeOutlineDesigned,
  assertWritableMode,
  countOccurrences,
  rejectCompressedPlaceholder,
  requireString,
  resolveDocumentWriteTarget,
  type DocumentWriteMode,
} from "./helpers.js";

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

export function deferredCharacterChanges(value: unknown, characterScope?: number[]): ProposalCharacterChange[] {
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
      const rawOp = typeof (change as Record<string, unknown>).op === "string"
        ? String((change as Record<string, unknown>).op).trim()
        : "";
      if (!rawOp) throw new Error(`characterChanges[${index}].changes[${changeIndex}].op 不能为空`);
      // Reject unknown ops at propose time — deferring them means they silently
      // fail (skip) when the user later accepts the proposal.
      if (!isCharacterChangeOp(rawOp)) {
        throw new Error(`characterChanges[${index}].changes[${changeIndex}].op 无效：${rawOp}。${characterChangeOpsHint()}`);
      }
      return { ...(change as Record<string, unknown>), op: normalizeCharacterChangeOp(rawOp) };
    });
    return { characterId, reason, changes };
  });
}

export function prepareDeferredCharacterChanges(
  value: unknown,
  context: Pick<ToolExecutionContext, "characterEvolutionEnabled">,
  characterScope?: number[],
): { changes: ProposalCharacterChange[]; skipped: boolean } {
  const requested = value !== undefined && (!Array.isArray(value) || value.length > 0);
  if (context.characterEvolutionEnabled === false) {
    return { changes: [], skipped: requested };
  }
  return { changes: deferredCharacterChanges(value, characterScope), skipped: false };
}

export function tolerantDeferredCharacterChanges(
  value: unknown,
  store: WriterStore,
  characterScope?: number[],
): { changes: ProposalCharacterChange[]; warnings: string[] } {
  if (value === undefined) return { changes: [], warnings: [] };
  if (!Array.isArray(value)) return { changes: [], warnings: ["characterChanges 不是数组，已忽略角色演进"] };

  let workingCharacters = store.characters();
  const accepted = new Map<number, ProposalCharacterChange>();
  const warnings: string[] = [];
  for (const [rowIndex, raw] of value.slice(0, 8).entries()) {
    let parsed: ProposalCharacterChange;
    try {
      parsed = deferredCharacterChanges([raw], characterScope)[0];
    } catch (error) {
      warnings.push(`characterChanges[${rowIndex}]：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    let current = workingCharacters.find(character => character.id === parsed.characterId);
    if (!current) {
      warnings.push(`characterChanges[${rowIndex}]：角色 ${parsed.characterId} 不存在`);
      continue;
    }
    const validOps: ProposalCharacterChange["changes"] = [];
    for (const [changeIndex, change] of parsed.changes.entries()) {
      const normalized = normalizeProposalCharacterChange(change);
      const result = applyCharacterChanges(current, {
        reason: parsed.reason,
        changes: [normalized],
      });
      if (!result.applied.length || result.skipped.length) {
        warnings.push(
          `characterChanges[${rowIndex}].changes[${changeIndex}]：${result.skipped[0]?.reason ?? "未应用"}`,
        );
        continue;
      }
      const candidateCharacters = workingCharacters.map(character =>
        character.id === current!.id ? result.character : character
      );
      try {
        validateCharacters(candidateCharacters);
      } catch (error) {
        warnings.push(
          `characterChanges[${rowIndex}].changes[${changeIndex}]：${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      current = result.character;
      workingCharacters = candidateCharacters;
      validOps.push(normalized);
    }
    if (!validOps.length) continue;
    const existing = accepted.get(parsed.characterId);
    accepted.set(parsed.characterId, existing
      ? {
          ...existing,
          reason: `${existing.reason}；${parsed.reason}`.slice(0, 400),
          changes: [...existing.changes, ...validOps].slice(0, 12),
        }
      : { ...parsed, changes: validOps });
  }
  return { changes: [...accepted.values()], warnings: warnings.slice(0, 12) };
}

function normalizeProposalCharacterChange(
  change: ProposalCharacterChange["changes"][number],
): ProposalCharacterChange["changes"][number] {
  if (normalizeCharacterChangeOp(String(change.op ?? "")) !== "upsert_story_state") return change;
  const source = change.entry && typeof change.entry === "object" && !Array.isArray(change.entry)
    ? change.entry as Record<string, unknown>
    : change;
  const hasStateContent = [source.location, source.physical, source.emotion, source.notes]
    .some(value => typeof value === "string" && value.trim())
    || [source.knowledge, source.beliefs, source.intentions, source.temporaryGoals]
      .some(value => Array.isArray(value) && value.length > 0);
  if (hasStateContent) return change;
  const notes = [source.label, source.description]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map(value => value.trim())
    .join("：");
  if (!notes) return change;
  return { ...change, entry: { ...source, notes } };
}

export async function captureAcceptedContinuityFacts(
  store: WriterStore,
  proposal: Pick<Proposal, "id" | "path" | "beforeContent" | "afterContent">,
  context: ToolExecutionContext,
): Promise<{ continuityFacts: number; continuityFactWarning?: string }> {
  const kind = documentKind(proposal.path);
  if (!context.continuityExtractor || !["lore", "chapter", "side"].includes(kind)) {
    return { continuityFacts: 0 };
  }
  try {
    const existingFacts = store.continuityFacts({ statuses: ["active", "conflict", "pending"], limit: 300 });
    const candidates = context.continuityExtractor.run
      ? await context.continuityExtractor.run({
          path: proposal.path,
          beforeContent: proposal.beforeContent,
          afterContent: proposal.afterContent,
          existingFacts,
        })
      : [];
    const saved = store.saveExtractedContinuityFacts(
      proposal.path,
      proposal.afterContent,
      proposal.id,
      candidates,
    );
    return { continuityFacts: saved.length };
  } catch (error) {
    return {
      continuityFacts: 0,
      continuityFactWarning: `正文已接受，但事实索引更新失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function maybeAutoAcceptProposal(
  store: WriterStore,
  proposal: { id: number; status: string },
  permissionMode: PermissionMode,
  emit: (event: AgentEvent) => void,
  context: ToolExecutionContext,
): Promise<{ proposalId: number; status: string; message: string; autoAccepted?: boolean; continuityFacts?: number; continuityFactWarning?: string }> {
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
    const continuity = await captureAcceptedContinuityFacts(store, accepted, context);
    return {
      proposalId: accepted.id,
      status: accepted.status,
      autoAccepted: true,
      message: "auto 模式：提案已自动写入文件",
      ...continuity,
    };
  } catch (error) {
    return {
      proposalId: proposal.id,
      status: "pending",
      message: `自动接受失败：${error instanceof Error ? error.message : String(error)}；提案仍待审批`,
    };
  }
}

export async function gateProseStyle(
  beforeContent: string,
  afterContent: string,
  context: ToolHandlerArgs["context"],
): Promise<void> {
  const issues = await proseStyleGateIssues(beforeContent, afterContent, context);
  const styleError = proseStyleIssuesError(issues);
  if (styleError) throw new Error(styleError);
}

export async function proseStyleGateIssues(
  beforeContent: string,
  afterContent: string,
  context: ToolHandlerArgs["context"],
) {
  let issues = newProseStyleIssues(beforeContent, afterContent);
  if (context.proseAdjudicator) {
    // Verdicts persist across gate rounds so repeat inspects stay deterministic
    // and only genuinely new sentences spend another Flash call.
    context.proseVerdictCache ??= new Map();
    const flash = await adjudicateProseStyleForProposal(
      afterContent,
      issues,
      context.proseAdjudicator.model,
      {
        signal: context.proseAdjudicator.signal,
        verdictCache: context.proseVerdictCache,
        usageReporter: context.modelUsageReporter,
        callKind: "prose_gate",
      },
    );
    issues = flash.issues;
    issues.push(...await adjudicateLearnedProseGates(
      afterContent,
      context.proseGateRules ?? [],
      context.proseAdjudicator.model,
      {
        signal: context.proseAdjudicator.signal,
        usageReporter: context.modelUsageReporter,
        callKind: "learned_prose_gate",
        beforeText: beforeContent,
      },
    ));
  }
  return issues;
}

export async function handleProposeDocument({ input, project, store, sessionId, emit, context, characterScope }: ToolHandlerArgs): Promise<string> {
  assertWritableMode(context.permissionMode, "propose_document");
  const path = requireString(input.path, "path");
  return submitFullDocumentProposal(
    { input, project, store, sessionId, emit, context, characterScope },
    path,
    requireString(input.content, "content"),
    requireString(input.summary, "summary"),
    input.characterChanges,
  );
}

/**
 * Direct prose path for a short, single-change document. The parent Agent chooses
 * the material and delivery topology; the configured Writer only realizes prose.
 */
export async function handleWriteDocumentIsolated(args: ToolHandlerArgs): Promise<string> {
  const { input, project, store, context } = args;
  assertWritableMode(context.permissionMode, "write_document_isolated");
  if (!context.scenePipelineSettings?.isolatedWriter || !context.isolatedSceneWriter) {
    throw new Error("当前未开启隔离 Writer；可直接 propose_document，或开启后重试");
  }
  if (context.chapterSceneDraft) {
    throw new Error("已有章节场景草稿正在进行；请完成当前草稿，避免直接成稿覆盖已写场景");
  }
  const path = requireString(input.path, "path");
  if (!isScenePipelineDocument(path)) throw new Error("直接隔离正文只能写入 chapters/ 或 side/");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const requestedMode = requireString(input.mode, "mode");
  if (!(["create", "replace", "append"] as string[]).includes(requestedMode)) {
    throw new Error("mode 只能是 create/replace/append");
  }
  const target = resolveDocumentWriteTarget(project, path, requestedMode as DocumentWriteMode);
  const mode = target.mode;
  const beforeContent = target.beforeContent;
  if (requestedMode !== "create") {
    const sourceHash = target.baseHash;
    if (typeof input.sourceHash !== "string" || input.sourceHash !== sourceHash) {
      throw new Error("replace/append 必须携带 inspect_document 返回的当前 sourceHash");
    }
  }

  const notes = requireString(input.notes, "notes");
  const notesMaxCharacters = context.scenePipelineSettings.notesMaxCharacters
    ?? DEFAULT_SCENE_NOTES_CHARACTERS;
  if (notes.length > notesMaxCharacters) {
    throw new Error(`notes 过长（当前上限 ${notesMaxCharacters} 字）；只保留会约束正文的故事内材料`);
  }
  const targetCharacters = Number(input.targetCharacters);
  if (!Number.isInteger(targetCharacters) || targetCharacters < 500 || targetCharacters > 5_000) {
    throw new Error("targetCharacters 须为 500—5000 的整数；更长或包含多次关键转折时使用场景链");
  }
  const heading = mode === "append"
    ? ""
    : requireString(input.heading, "heading").replace(/^#+\s*/u, "").trim();
  if (mode !== "append" && !heading) throw new Error("create/replace 必须提供正文标题");

  const writePack = compileWritePack(notes, {
    targetPath: path,
    instruction: requireString(input.goal, "goal"),
  });
  const stringList = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
      .map(item => item.trim()).filter(Boolean).slice(0, 8)
    : [];
  const scene = {
    id: "direct-document",
    title: heading || "续写",
    goal: requireString(input.goal, "goal"),
    entryState: stringList(input.entryState),
    characterIntent: stringList(input.characterIntent),
    obstacle: requireString(input.obstacle, "obstacle"),
    turn: requireString(input.turn, "turn"),
    outcome: requireString(input.outcome, "outcome"),
    handoff: "",
    dividerBefore: false,
    targetCharacters,
  };
  const evidence = isolatedWriterVoiceEvidence(project, store, path);
  const writer = context.isolatedSceneWriter;
  const runner = writer.run ?? requestIsolatedScene;
  const maximumCharacters = Math.floor(targetCharacters * (
    context.scenePipelineSettings.isolatedWriterMaxRatio ?? DEFAULT_ISOLATED_WRITER_MAX_RATIO
  ));
  const writerInput = {
    scene,
    writePack,
    ...(mode === "append" ? { previousTail: beforeContent.slice(-800) } : {}),
    voiceSample: evidence.exemplar,
    voiceContinuation: evidence.continuation,
    styleDirectives: isolatedWriterStyleDirectives(project),
    maximumCharacters,
  };
  const runWriter = async (strictMaximumCharacters?: number) => {
    const callKind = strictMaximumCharacters
      ? "isolated_document_writer_length_retry"
      : "isolated_document_writer";
    try {
      const generated = await runner(writer.model, {
        ...writerInput,
        ...(strictMaximumCharacters ? { strictMaximumCharacters } : {}),
      }, writer.signal);
      if (generated.usage) {
        context.modelUsageReporter?.(writer.model, generated.usage, {
          callKind,
          requestComponents: [{
            kind: "other",
            label: "直接隔离正文",
            characters: generated.requestCharacters,
            estimatedTokens: Math.ceil(generated.requestCharacters * 0.75),
            callKind,
          }],
        });
      }
      return generated;
    } catch (error) {
      if (error instanceof IsolatedSceneRequestError && error.usage) {
        context.modelUsageReporter?.(writer.model, error.usage, {
          callKind: `${callKind}_failed`,
        });
      }
      throw error;
    }
  };

  let generated;
  try {
    generated = await runWriter();
  } catch (error) {
    if (!(error instanceof IsolatedSceneRequestError)
      || error.stage !== "writer"
      || error.failureKind !== "truncated") throw error;
    generated = await runWriter(maximumCharacters);
  }
  if (generated.content.trim().length > maximumCharacters) {
    generated = await runWriter(maximumCharacters);
  }
  if (generated.content.trim().length > maximumCharacters) {
    throw new Error(`隔离 Writer 连续两次超出正文上限 ${maximumCharacters} 字；请缩小本次事件范围或改用场景链`);
  }
  rejectCompressedPlaceholder(generated.content, "隔离 Writer 正文");
  const generatedBody = generated.content.trim();
  if (!target.existed) {
    if (project.documentExists(path)) throw new Error("Writer 生成期间目标文档已被创建；请重新判断 create/replace");
  } else if (!project.documentExists(path)
    || project.hash(project.read(path)) !== target.baseHash) {
    throw new Error("Writer 生成期间目标文档已变化；未创建提案，请重新读取后再试");
  }
  const proposedContent = mode === "append"
    ? `${beforeContent.trimEnd()}\n\n${generatedBody}`
    : `# ${heading}\n\n${generatedBody}`;
  const submitted = await submitFullDocumentProposal(
    args,
    path,
    proposedContent,
    requireString(input.summary, "summary"),
    input.characterChanges,
  );
  const parsed = JSON.parse(submitted) as Record<string, unknown>;
  return JSON.stringify({
    ...parsed,
    generationMode: "isolated_document",
    requestedMode: target.requestedMode,
    effectiveMode: target.mode,
    submissionKind: target.versionSubmission ? "new_version" : "new_document",
    generatedCharacters: generatedBody.length,
    targetCharacters,
  });
}

export async function submitFullDocumentProposal(
  { project, store, sessionId, emit, context, characterScope }: ToolHandlerArgs,
  path: string,
  proposedContent: string,
  summary: string,
  characterChanges: unknown,
  proseStyleApproved = false,
): Promise<string> {
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  assertCreativeOutlineDesigned(context, path, "propose_document");
  rejectCompressedPlaceholder(proposedContent, "content");
  const existed = project.documentExists(path);
  const beforeContent = existed ? project.read(path) : "";
  const meta = gateProseMetaLeaks(proposedContent, path);
  if (!proseStyleApproved) await gateProseStyle(beforeContent, meta.content, context);
  const preparedCharacterChanges = prepareDeferredCharacterChanges(characterChanges, context, characterScope);
  const proposal = store.createProposal(
    sessionId,
    path,
    meta.content,
    summary,
    preparedCharacterChanges.changes,
  );
  emit({ type: "proposal", proposal });
  return JSON.stringify({
    ...await maybeAutoAcceptProposal(store, proposal, context.permissionMode, emit, context),
    submissionKind: existed ? "new_version" : "new_document",
    ...(existed ? { versionBaseHash: project.hash(beforeContent) } : {}),
    ...(preparedCharacterChanges.skipped ? { characterEvolutionSkipped: true } : {}),
    ...(meta.stripped.length ? { metaSanitized: meta.stripped } : {}),
  });
}

export async function handleProposeDocumentPatch({ input, project, store, sessionId, emit, context, characterScope }: ToolHandlerArgs): Promise<string> {
  assertWritableMode(context.permissionMode, "propose_document_patch");
  const path = requireString(input.path, "path");
  const edits = Array.isArray(input.edits) ? input.edits.slice(0, 20) : [];
  if (!edits.length) throw new Error("局部修改至少需要一条 edit");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  assertCreativeOutlineDesigned(context, path, "propose_document_patch");
  const beforeContent = project.read(path);
  const sourceHash = project.hash(beforeContent);
  if (input.sourceHash !== undefined && input.sourceHash !== sourceHash) {
    throw new Error(`文档快照已变化；期望 ${String(input.sourceHash)}，当前 ${sourceHash}。请重新定位锚点`);
  }
  let content = beforeContent;
  const strippedMeta: string[] = [];
  const anchorSpans = documentSpans(beforeContent, sourceHash);
  const anchorOperations: Array<{ start: number; end: number; replacement: string; index: number }> = [];
  const anchorEditCount = edits.filter(edit => edit && typeof edit === "object" && typeof (edit as Record<string, unknown>).anchorId === "string").length;
  if (anchorEditCount > 0 && anchorEditCount !== edits.length) throw new Error("同一 patch 不能混用锚点 edit 与 legacy search/replace");
  const pointLock = context.editScope === "point" ? context.editTargetLocked : undefined;
  if (pointLock) {
    if (pointLock.path !== path || pointLock.sourceHash !== sourceHash) {
      throw new Error("局部修改目标已锁定到另一文档快照；请重新开始定位");
    }
    if (anchorEditCount !== edits.length) {
      throw new Error("局部修改目标锁定后必须使用 anchorId+spanHash，禁止退回全文 search/replace");
    }
  }
  for (const [index, rawEdit] of edits.entries()) {
    if (!rawEdit || typeof rawEdit !== "object") throw new Error(`第 ${index + 1} 条 edit 格式无效`);
    const edit = rawEdit as Record<string, unknown>;
    const anchorId = typeof edit.anchorId === "string" ? edit.anchorId.trim() : "";
    if (anchorId) {
      if (typeof input.sourceHash !== "string" || !input.sourceHash.trim()) {
        throw new Error("锚点 patch 必须携带 locate/read 返回的 sourceHash");
      }
      const span = anchorSpans.find(item => item.anchorId === anchorId);
      if (!span) throw new Error(`第 ${index + 1} 条 anchorId 已过期或不存在；请重新 locate`);
      if (pointLock && !pointLock.anchorIds.includes(anchorId)) {
        throw new Error(`第 ${index + 1} 条 anchorId 超出已锁定的局部修改范围`);
      }
      if (typeof edit.spanHash !== "string" || edit.spanHash !== span.spanHash) {
        throw new Error(`第 ${index + 1} 条 spanHash 不匹配；目标段落已变化，请重新读取`);
      }
      const operation = typeof edit.operation === "string" ? edit.operation : "replace";
      if (!(["replace", "delete", "insert_before", "insert_after"] as string[]).includes(operation)) {
        throw new Error(`第 ${index + 1} 条 operation 无效`);
      }
      let replacement = operation === "delete" ? ""
        : typeof edit.content === "string" ? edit.content
        : typeof edit.replace === "string" ? edit.replace : undefined;
      if (replacement === undefined) throw new Error(`缺少有效参数：edits[${index}].content`);
      rejectCompressedPlaceholder(replacement, `edits[${index}].content`);
      if (replacement) {
        const cleaned = gateProseMetaLeaks(replacement, path);
        replacement = cleaned.content;
        strippedMeta.push(...cleaned.stripped);
      }
      if (operation === "insert_before") replacement = `${replacement}\n\n`;
      if (operation === "insert_after") replacement = `\n\n${replacement}`;
      anchorOperations.push({
        start: operation === "insert_after" ? span.endOffset : span.startOffset,
        end: operation === "insert_before" || operation === "insert_after" ? (operation === "insert_after" ? span.endOffset : span.startOffset) : span.endOffset,
        replacement,
        index,
      });
      continue;
    }
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
  if (anchorOperations.length) {
    const ordered = [...anchorOperations].sort((a, b) => b.start - a.start || b.end - a.end);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index - 1].start < ordered[index].end) throw new Error("锚点修改范围重叠；请合并为一条 edit");
    }
    for (const operation of ordered) {
      content = `${content.slice(0, operation.start)}${operation.replacement}${content.slice(operation.end)}`;
    }
  }
  await gateProseStyle(beforeContent, content, context);
  const preparedCharacterChanges = prepareDeferredCharacterChanges(input.characterChanges, context, characterScope);
  const proposal = store.createProposal(
    sessionId, path, content, requireString(input.summary, "summary"),
    preparedCharacterChanges.changes,
  );
  emit({ type: "proposal", proposal });
  const uniqueStripped = [...new Set(strippedMeta)];
  return JSON.stringify({
    edits: edits.length,
    ...await maybeAutoAcceptProposal(store, proposal, context.permissionMode, emit, context),
    ...(preparedCharacterChanges.skipped ? { characterEvolutionSkipped: true } : {}),
    ...(uniqueStripped.length ? { metaSanitized: uniqueStripped } : {}),
  });
}

/** Whole-document rewrite without appending the original body to the parent Agent loop. */
export async function handleReviseDocumentIsolated(args: ToolHandlerArgs): Promise<string> {
  const { input, project, context } = args;
  assertWritableMode(context.permissionMode, "revise_document_isolated");
  if (context.editScope !== "document") throw new Error("仅通篇修改可使用 revise_document_isolated；局部/分节修改请使用锚点 patch");
  if (!context.documentRevisioner) throw new Error("隔离文档修订器未配置");
  const path = requireString(input.path, "path");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  const beforeContent = project.read(path);
  const sourceHash = project.hash(beforeContent);
  if (typeof input.sourceHash !== "string" || input.sourceHash !== sourceHash) {
    throw new Error("通篇修改必须携带 inspect_document 返回的当前 sourceHash");
  }
  if (beforeContent.length > 120_000) throw new Error("文档超过12万字符；请按章节或标题拆分后分别修订");
  const instruction = requireString(input.instruction, "instruction").slice(0, 2_000);
  const instructionHash = project.hash(instruction);
  const blocks = documentBlocks(beforeContent, 5_000);
  if (blocks.length > 32) throw new Error("文档分块超过32块；请缩小通篇修改范围");
  const revisioner = context.documentRevisioner;
  const models = [revisioner.model, revisioner.fallbackModel]
    .filter((model): model is NonNullable<typeof model> => Boolean(model))
    .filter((model, index, all) => all.findIndex(candidate => candidate.baseUrl === model.baseUrl && candidate.model === model.model) === index);
  const checkpoint = args.store.agentCheckpoint(args.sessionId);
  const savedDraft = checkpoint?.stage === "document_revision_started" && checkpoint.path === path
    && checkpoint.sourceHash === sourceHash && checkpoint.draft && typeof checkpoint.draft === "object"
    ? checkpoint.draft as Record<string, unknown>
    : undefined;
  const savedReplacements = savedDraft?.kind === "document_revision" && savedDraft.instructionHash === instructionHash
    && Array.isArray(savedDraft.replacements)
    ? savedDraft.replacements.flatMap(raw => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const value = raw as Record<string, unknown>;
        return typeof value.start === "number" && typeof value.end === "number" && typeof value.content === "string"
          ? [{ start: value.start, end: value.end, content: value.content }] : [];
      })
    : [];
  const replacements: Array<{ start: number; end: number; content: string }> = savedReplacements.slice(0, blocks.length);
  for (const block of blocks.slice(replacements.length)) {
    let revised: string | undefined;
    const errors: string[] = [];
    for (const model of models) {
      try {
        const result = await (revisioner.run ?? requestDocumentRevision)(model, {
          instruction,
          block: block.block,
          blockCount: blocks.length,
          content: block.content,
          ...(block.block > 1 ? { previousTail: blocks[block.block - 2].content.slice(-500) } : {}),
          ...(block.block < blocks.length ? { nextHead: blocks[block.block].content.slice(0, 500) } : {}),
        }, revisioner.signal);
        revised = result.content;
        if (result.usage) context.modelUsageReporter?.(model, result.usage, {
          callKind: "document_revision",
          requestComponents: [{ kind: "other", label: `隔离文档修订 ${block.block}/${blocks.length}`,
            characters: result.requestCharacters, estimatedTokens: Math.ceil(result.requestCharacters * 0.75), callKind: "document_revision" }],
        });
        break;
      } catch (error) {
        errors.push(error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240));
      }
    }
    if (revised === undefined) {
      return JSON.stringify({
        status: "revision_failed", error: `第 ${block.block}/${blocks.length} 块隔离修订失败`, errors,
        completedBlocks: replacements.length, message: "未创建提案；原文未修改。可缩小范围或重试。",
      });
    }
    replacements.push({ start: block.startOffset, end: block.endOffset, content: revised });
    args.store.saveAgentCheckpoint(args.sessionId, {
      version: 1,
      stage: "document_revision_started",
      path,
      sourceHash,
      completedScenes: replacements.length,
      totalScenes: blocks.length,
      draft: { kind: "document_revision", instructionHash, replacements },
      updatedAt: new Date().toISOString(),
    });
  }
  let afterContent = beforeContent;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    afterContent = `${afterContent.slice(0, replacement.start)}${replacement.content}${afterContent.slice(replacement.end)}`;
  }
  const result = await submitFullDocumentProposal(
    args,
    path,
    afterContent,
    requireString(input.summary, "summary"),
    input.characterChanges,
  );
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (!("error" in parsed)) args.store.saveAgentCheckpoint(args.sessionId, {
      version: 1, stage: "proposal_submitted", path, sourceHash,
      proposalId: typeof parsed.proposalId === "number" ? parsed.proposalId : undefined,
      updatedAt: new Date().toISOString(),
    });
    return JSON.stringify({
      ...parsed,
      revisionMode: "isolated_blocks",
      revisedBlocks: replacements.length,
      originalCharacters: beforeContent.length,
      revisedCharacters: afterContent.length,
    });
  } catch { return result; }
}

export type { Proposal };
