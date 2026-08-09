import type { AgentEvent, ModelConfig, PermissionMode, Proposal, ProposalCharacterChange } from "../types.js";
import {
  applyCharacterChanges,
  characterChangeOpsHint,
  isCharacterChangeOp,
  normalizeCharacterChangeOp,
  validateCharacters,
} from "../characters.js";
import { adjudicateLearnedProseGates, adjudicateProseStyleForProposal } from "../prose_adjudicate.js";
import {
  isHardBlockSubtype,
  newProseStyleIssues,
  proseStyleRepairPacket,
  proseStyleIssuesError,
  type ProseStyleIssue,
} from "../prose_quality.js";
import { findProseMetaLeaks, sanitizeProseMetaLeaks } from "../write_pack.js";
import { documentSpans } from "../document_spans.js";
import { documentBlocks } from "../document_blocks.js";
import { requestDocumentRevision } from "../document_revision.js";
import {
  ChapterStyleRepairRequestError,
  requestChapterStyleRepair,
  type ChapterStyleEdit,
  type ChapterStyleRepairIssue,
} from "../chapter_style_repair.js";
import { assessProseLength, proseLengthOutcome, type ProseLengthAssessment } from "../prose_length.js";
import { MAX_CHAPTER_TARGET_CHARACTERS, MIN_CHAPTER_TARGET_CHARACTERS } from "../agent_runtime.js";
import { documentKind, isScenePipelineDocument } from "../project.js";
import { buildProseQualityReport, formatQualityReportLines } from "../final_quality.js";
import {
  buildChapterReviewRevisionContext,
  ChapterReviewRequestError,
  constrainChapterRevisionReview,
  reviewChapterDraft,
  type ChapterReviewResult,
} from "../chapter_review.js";
import {
  proposalRevisionIssueId,
  proposalRevisionScopeKey,
  type ProposalRevisionIssue,
} from "../proposal_retry.js";
import { boundedRepairPacket, type RepairPacket } from "../repair_packet.js";
import { ToolDependencyError, ToolRevisionRequiredError } from "../tool_failure.js";
import {
  buildDependencyAttempt,
  buildDependencyFailureBundle,
  dependencyAttemptRole,
  dependencyFailureGuidance,
  dependencyFailureUserSummary,
  reportModelCallUsage,
  type DependencyAttemptDiagnostic,
} from "../dependency_diagnostics.js";
import { buildFactualChapterReviewContext } from "../chapter_review_context.js";
import { runSurfaceGates, type SurfaceGateFinding } from "../surface_gates.js";
import { ProposalDocumentBaseChangedError, type WriterStore } from "../store.js";
import { proseGateRulesForTarget, type ProseGateTargetKind } from "../prose_gate_rules.js";
import {
  assessCardRegisterHits,
  cardRegisterReportForTool,
  collectRegisterRisksForContext,
  proseSignalsFromCardRegister,
  scanCardRegisterHits,
  type CardRegisterAssessment,
} from "../register_risks.js";
import type { ToolExecutionContext, ToolHandlerArgs } from "./types.js";
import {
  assertCreativeOutlineDesigned,
  assertWritableMode,
  countOccurrences,
  rejectCompressedPlaceholder,
  requireString,
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

export async function captureAcceptedWritingMemory(
  store: WriterStore,
  proposal: Pick<Proposal, "id" | "sessionId" | "sourceMessageId" | "path" | "beforeContent" | "afterContent">,
  context: ToolExecutionContext,
): Promise<{ writingMemory: number; writingMemoryWarning?: string }> {
  const kind = documentKind(proposal.path);
  if (!context.writingMemoryExtractor || !proposal.sourceMessageId || !["chapter", "side"].includes(kind)) {
    return { writingMemory: 0 };
  }
  try {
    const characters = store.characters().map(character => ({
      id: character.id,
      name: character.identity.name,
      aliases: character.identity.aliases,
    }));
    const candidates = context.writingMemoryExtractor.run
      ? await context.writingMemoryExtractor.run({
          path: proposal.path,
          beforeContent: proposal.beforeContent,
          afterContent: proposal.afterContent,
          characters,
        })
      : [];
    const saved = store.saveExtractedWritingMemory(
      proposal.sessionId,
      proposal.sourceMessageId,
      proposal.path,
      proposal.afterContent,
      proposal.id,
      candidates,
    );
    return { writingMemory: saved.length };
  } catch (error) {
    return {
      writingMemory: 0,
      writingMemoryWarning: `正文已接受，但会话写作记忆更新失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function maybeAutoAcceptProposal(
  store: WriterStore,
  proposal: { id: number; status: string },
  permissionMode: PermissionMode,
  emit: (event: AgentEvent) => void,
  context: ToolExecutionContext,
): Promise<{ proposalId: number; status: string; message: string; autoAccepted?: boolean; writingMemory?: number; writingMemoryWarning?: string }> {
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
    const memory = await captureAcceptedWritingMemory(store, accepted, context);
    return {
      proposalId: accepted.id,
      status: accepted.status,
      autoAccepted: true,
      message: "auto 模式：提案已自动写入文件",
      ...memory,
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
  targetPath?: string,
  sourceHash?: string,
): Promise<void> {
  const issues = await proseStyleGateIssues(beforeContent, afterContent, context, {
    reviewWholeText: context.editScope === "document",
    failClosed: true,
    targetPath,
    targetKind: targetPath ? documentKind(targetPath) : "other",
  });
  const styleError = proseStyleIssuesError(issues);
  if (styleError) {
    throw new ToolRevisionRequiredError("PROSE_STYLE_REVISION_REQUIRED", styleError, {
      repairPacket: proseStyleRepairPacket(afterContent, issues, { path: targetPath, sourceHash }),
    });
  }
}

const PROPOSAL_STYLE_AUTO_REPAIR_LIMIT = 8;
const PROPOSAL_STYLE_AUTO_REPAIR_MAX_ATTEMPTS = 2;

function proposalStyleHardErrors(issues: readonly ProseStyleIssue[]): ProseStyleIssue[] {
  return issues.filter(issue => issue.severity === "error" && isHardBlockSubtype(issue.subtype));
}

function proposalStyleRepairIssues(issues: readonly ProseStyleIssue[]): ChapterStyleRepairIssue[] {
  return issues.slice(0, PROPOSAL_STYLE_AUTO_REPAIR_LIMIT).map(issue => ({
    id: issue.id,
    code: `${issue.kind}:${issue.subtype}`,
    sentence: issue.sentence,
    before: issue.evidence,
    after: issue.suggestions[0] ?? "",
    instruction: issue.suggestions[0] ?? issue.reason,
  }));
}

function applyExactProposalStyleEdits(
  content: string,
  blockers: readonly ProseStyleIssue[],
  edits: readonly ChapterStyleEdit[],
): { content: string; edits: ChapterStyleEdit[] } {
  const allowed = new Set(blockers.map(issue => issue.sentence.trim()).filter(Boolean));
  const replacements: Array<ChapterStyleEdit & { start: number; end: number }> = [];
  const seen = new Set<string>();
  for (const edit of edits.slice(0, PROPOSAL_STYLE_AUTO_REPAIR_LIMIT)) {
    const search = edit.search.trim();
    const replace = edit.replace.trim();
    if (!allowed.has(search) || seen.has(search) || !replace || replace === search) continue;
    if (replace.length > Math.max(500, search.length * 3) || /^#{1,6}\s/mu.test(replace)) continue;
    const start = content.indexOf(search);
    if (start < 0 || content.indexOf(search, start + search.length) >= 0) continue;
    seen.add(search);
    replacements.push({ search, replace, start, end: start + search.length });
  }
  replacements.sort((a, b) => b.start - a.start);
  let revised = content;
  let previousStart = content.length;
  const applied: ChapterStyleEdit[] = [];
  for (const edit of replacements) {
    if (edit.end > previousStart) continue;
    revised = `${revised.slice(0, edit.start)}${edit.replace}${revised.slice(edit.end)}`;
    previousStart = edit.start;
    applied.push({ search: edit.search, replace: edit.replace });
  }
  return { content: revised, edits: applied.reverse() };
}

async function gateProseStyleWithSparseAutoRepair(
  beforeContent: string,
  content: string,
  context: ToolHandlerArgs["context"],
  project: { hash(content: string): string },
  path: string,
  summary: string,
  recordDraft?: (content: string, sourceHash: string) => void,
): Promise<{
  content: string;
  sourceHash: string;
  stripped: string[];
  autoRepair?: { attempts: number; edits: number; initialBlockers: number };
  policyObservations?: Array<{
    issueId: string;
    policyId: string;
    policyVersion?: number;
    skillId?: string;
    evidence: string;
    reason: string;
    suggestion?: string;
  }>;
  /**
   * Set when the gate rejected the body. Returned instead of thrown so the other
   * deterministic gates can still run and the Agent gets one merged repair list
   * rather than one round trip per gate.
   */
  failure?: { code: string; message: string; repairPacket?: RepairPacket };
}> {
  let current = content;
  const stripped: string[] = [];
  // Delegated prose must not pass through a second model that lacks the Writer's
  // evidence packet. Keep the gate, but return its exact repair packet to the
  // evidence-owning Agent instead of silently changing facts during cleanup.
  const repairer = context.evidenceGroundedWriter ? undefined : context.chapterStyleRepairer;
  const errors: string[] = [];
  let appliedEdits = 0;
  let initialBlockers = 0;
  for (let attempt = 0; attempt <= PROPOSAL_STYLE_AUTO_REPAIR_MAX_ATTEMPTS; attempt += 1) {
    const sourceHash = project.hash(current);
    const issues = await proseStyleGateIssues(beforeContent, current, context, {
      reviewWholeText: context.editScope === "document",
      failClosed: true,
      targetPath: path,
      targetKind: documentKind(path),
    });
    const styleError = proseStyleIssuesError(issues);
    if (!styleError) {
      const policyObservations = issues.flatMap(issue => issue.policyId ? [{
        issueId: issue.id,
        policyId: issue.policyId,
        ...(issue.policyVersion ? { policyVersion: issue.policyVersion } : {}),
        ...(issue.skillId ? { skillId: issue.skillId } : {}),
        evidence: issue.evidence,
        reason: issue.reason,
        ...(issue.suggestions[0] ? { suggestion: issue.suggestions[0] } : {}),
      }] : []);
      return {
        content: current,
        sourceHash,
        stripped,
        ...(policyObservations.length ? { policyObservations } : {}),
        ...(attempt > 0 ? {
          autoRepair: {
            attempts: attempt,
            edits: appliedEdits,
            initialBlockers,
          },
        } : {}),
      };
    }
    const blockers = proposalStyleHardErrors(issues);
    if (attempt === 0) initialBlockers = blockers.length;
    const repairable = blockers.length > 0
      && blockers.length <= PROPOSAL_STYLE_AUTO_REPAIR_LIMIT
      && blockers.every(issue => issue.sentence.trim()
        && current.indexOf(issue.sentence.trim()) >= 0
        && current.indexOf(issue.sentence.trim(), current.indexOf(issue.sentence.trim()) + issue.sentence.trim().length) < 0);
    if (!repairer || !repairable || attempt >= PROPOSAL_STYLE_AUTO_REPAIR_MAX_ATTEMPTS) {
      const packet = proseStyleRepairPacket(current, issues, { path, sourceHash });
      const suffix = errors.length ? `；自动局部修订未完成：${errors.slice(-2).join("；")}` : "";
      return {
        content: current,
        sourceHash,
        stripped,
        failure: {
          code: "PROSE_STYLE_REVISION_REQUIRED",
          message: `${styleError}${suffix}`,
          ...(packet ? { repairPacket: packet } : {}),
        },
      };
    }
    const runRepair = repairer.run ?? requestChapterStyleRepair;
    const models = [repairer.model, repairer.fallbackModel]
      .filter((model): model is NonNullable<typeof model> => Boolean(model))
      .filter((model, index, all) => all.findIndex(candidate =>
        candidate.baseUrl === model.baseUrl && candidate.model === model.model) === index);
    let applied = false;
    for (const model of models) {
      try {
        const repaired = await runRepair(model, {
          issues: proposalStyleRepairIssues(blockers),
          chapterGoal: summary,
        }, repairer.signal);
        if (repaired.usage) context.modelUsageReporter?.(model, repaired.usage, {
          callKind: "proposal_style_repair",
          requestComponents: [{
            kind: "other",
            label: "提案稀疏句式自动修订",
            characters: repaired.requestCharacters,
            estimatedTokens: Math.ceil(repaired.requestCharacters * 0.75),
            callKind: "proposal_style_repair",
          }],
        });
        const exact = applyExactProposalStyleEdits(current, blockers, repaired.edits);
        if (!exact.edits.length) {
          errors.push("局部修订没有提供可安全应用的唯一精确替换");
          continue;
        }
        const cleaned = gateProseMetaLeaks(exact.content, path);
        current = cleaned.content;
        stripped.push(...cleaned.stripped);
        appliedEdits += exact.edits.length;
        recordDraft?.(current, project.hash(current));
        applied = true;
        break;
      } catch (error) {
        if (error instanceof ChapterStyleRepairRequestError && error.usage) {
          context.modelUsageReporter?.(model, error.usage, {
            callKind: "proposal_style_repair_failed",
            requestComponents: [{
              kind: "other",
              label: "失败的提案稀疏句式自动修订",
              characters: error.requestCharacters,
              estimatedTokens: Math.ceil(error.requestCharacters * 0.75),
              callKind: "proposal_style_repair_failed",
            }],
          });
        }
        errors.push(error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240));
      }
    }
    if (!applied) {
      const sourceHashAfterFailure = project.hash(current);
      const packet = proseStyleRepairPacket(current, issues, { path, sourceHash: sourceHashAfterFailure });
      return {
        content: current,
        sourceHash: sourceHashAfterFailure,
        stripped,
        failure: {
          code: "PROSE_STYLE_REVISION_REQUIRED",
          message: `${styleError}；自动局部修订未完成：${errors.slice(-2).join("；")}`,
          ...(packet ? { repairPacket: packet } : {}),
        },
      };
    }
  }
  const finalSourceHash = project.hash(current);
  const finalPacket = proseStyleRepairPacket(
    current,
    newProseStyleIssues(beforeContent, current),
    { path, sourceHash: finalSourceHash },
  );
  return {
    content: current,
    sourceHash: finalSourceHash,
    stripped,
    failure: {
      code: "PROSE_STYLE_REVISION_REQUIRED",
      message: "句式自动修订达到运行时上限后仍未通过",
      ...(finalPacket ? { repairPacket: finalPacket } : {}),
    },
  };
}

function directReviewRepairPacket(
  path: string,
  sourceHash: string,
  issues: readonly Pick<ProposalRevisionIssue, "id" | "kind" | "evidence" | "oldText" | "problem" | "action">[],
): RepairPacket | undefined {
  if (!issues.length) return undefined;
  return boundedRepairPacket({
    path,
    sourceHash,
    issueCount: issues.length,
    issues: issues.map(issue => ({
      id: issue.id,
      kind: issue.kind,
      ...(issue.oldText ? { oldText: issue.oldText } : {}),
      ...(issue.evidence[0] ? { evidence: issue.evidence[0] } : {}),
      problem: issue.problem,
      action: issue.action,
    })),
  });
}

type SurfaceGateFailure = SurfaceGateFinding;

/**
 * Deterministic surface gates all classify to the same retry gate, so reporting
 * them one at a time only bought extra round trips. Merge every finding into one
 * packet and keep the first failing gate's code so retry accounting is unchanged.
 */
function mergedSurfaceGateError(
  failures: readonly SurfaceGateFailure[],
  path: string,
  sourceHash: string,
): ToolRevisionRequiredError {
  const primary = failures[0]!;
  const issues = failures.flatMap(failure => failure.repairPacket?.issues ?? []);
  const packet = issues.length
    ? boundedRepairPacket({
        path,
        sourceHash,
        issueCount: Math.max(
          issues.length,
          failures.reduce((sum, failure) => sum + (failure.repairPacket?.issueCount ?? 0), 0),
        ),
        issues,
        ...(failures.some(failure => failure.repairPacket?.omittedIssueCount)
          ? {
              omittedIssueCount: failures.reduce(
                (sum, failure) => sum + (failure.repairPacket?.omittedIssueCount ?? 0),
                0,
              ),
            }
          : {}),
      })
    : undefined;
  const message = failures.length > 1
    ? `本次提交有 ${failures.length} 类确定性门禁未通过，已一并列出，请在同一稿里全部处理：\n${
        failures.map(failure => `【${failure.code}】${failure.message}`).join("\n")}`
    : primary.message;
  return new ToolRevisionRequiredError(
    primary.code,
    message,
    packet ? { repairPacket: packet } : undefined,
  );
}

function chapterReviewRepairPacket(
  path: string,
  sourceHash: string,
  review: ChapterReviewResult,
): RepairPacket | undefined {
  const blockers = review.issues
    .filter(issue => issue.severity === "blocker")
    .map(issue => ({
      id: issue.priorIssueId ?? proposalRevisionIssueId({
        kind: issue.kind,
        evidence: issue.evidence,
        problem: issue.problem,
      }),
      kind: issue.kind,
      evidence: issue.evidence,
      ...(issue.oldText ? { oldText: issue.oldText } : {}),
      problem: issue.problem,
      action: issue.action,
    }));
  return directReviewRepairPacket(path, sourceHash, blockers);
}

export const PRIMARY_PROSE_GATE_TIMEOUT_MS = 60_000;
export const FINAL_PROSE_GATE_TIMEOUT_MS = 180_000;

/**
 * A fast primary keeps ordinary gates responsive, while the last/only model gets
 * enough time for full-chapter semantic review. jn3's healthy reviewer regularly
 * needs more than 60 seconds, so applying the primary timeout to the fallback
 * incorrectly turned normal latency into a dependency outage.
 */
export function proseGateReviewTimeoutMs(
  modelIndex: number,
  modelCount: number,
  configured?: { primary: number; final: number },
): number {
  return modelCount > 1 && modelIndex < modelCount - 1
    ? configured?.primary ?? PRIMARY_PROSE_GATE_TIMEOUT_MS
    : configured?.final ?? FINAL_PROSE_GATE_TIMEOUT_MS;
}

export async function proseStyleGateIssues(
  beforeContent: string,
  afterContent: string,
  context: Pick<ToolHandlerArgs["context"],
    "proseAdjudicator" | "proseVerdictCache" | "proseGateRules" | "modelUsageReporter">,
  options?: {
    reviewWholeText?: boolean;
    failClosed?: boolean;
    targetPath?: string;
    targetKind?: ProseGateTargetKind;
  },
) {
  let issues = newProseStyleIssues(beforeContent, afterContent);
  if (context.proseAdjudicator) {
    const applicableRules = proseGateRulesForTarget(context.proseGateRules ?? [], {
      kind: options?.targetKind ?? "other",
      ...(options?.targetPath ? { path: options.targetPath } : {}),
    });
    const adjudicatorModels = [
      context.proseAdjudicator.model,
      context.proseAdjudicator.fallbackModel,
    ].filter((model, index, all): model is ModelConfig => Boolean(model)
      && all.findIndex(candidate => candidate?.baseUrl === model?.baseUrl
        && candidate?.model === model?.model) === index);
    // Verdicts persist across gate rounds so repeat inspects stay deterministic
    // and only genuinely new sentences spend another Flash call.
    context.proseVerdictCache ??= new Map();
    for (const adjudicatorModel of adjudicatorModels) {
      const flash = await adjudicateProseStyleForProposal(
        afterContent,
        issues,
        adjudicatorModel,
        {
          signal: context.proseAdjudicator.signal,
          verdictCache: context.proseVerdictCache,
          usageReporter: context.modelUsageReporter,
          callKind: "prose_gate",
        },
      );
      issues = flash.issues;
      if (!flash.skipped?.startsWith("model_error:")) break;
    }
    let learnedIssues: Awaited<ReturnType<typeof adjudicateLearnedProseGates>> | undefined;
    let learnedFailure: unknown;
    for (const [modelIndex, adjudicatorModel] of adjudicatorModels.entries()) {
      try {
        learnedIssues = await adjudicateLearnedProseGates(
          afterContent,
          applicableRules,
          adjudicatorModel,
          {
            signal: context.proseAdjudicator.signal,
            usageReporter: context.modelUsageReporter,
            callKind: "learned_prose_gate",
            ...(options?.failClosed
              ? {
                  timeoutMs: proseGateReviewTimeoutMs(
                    modelIndex,
                    adjudicatorModels.length,
                    context.proseAdjudicator.reviewTimeoutsMs,
                  ),
                }
              : {}),
            ...(options?.reviewWholeText ? {} : { beforeText: beforeContent }),
            failClosed: options?.failClosed === true,
          },
        );
        break;
      } catch (error) {
        learnedFailure = error;
      }
    }
    if (learnedIssues) {
      issues.push(...learnedIssues);
    } else if (learnedFailure) {
      const sole = adjudicatorModels[0];
      const diagnostics = sole
        ? buildDependencyFailureBundle({
            stage: "prose_gate",
            uniqueModelCount: adjudicatorModels.length,
            attempts: [buildDependencyAttempt({
              model: sole,
              role: adjudicatorModels.length <= 1 ? "sole" : "primary",
              error: learnedFailure,
              recordedUsage: false,
            })],
          })
        : undefined;
      if (adjudicatorModels.length === 1) {
        const detail = learnedFailure instanceof Error ? learnedFailure.message : String(learnedFailure);
        throw new ToolDependencyError(
          "PROSE_GATE_UNAVAILABLE",
          `语义正文门控暂时不可用（仅配置 1 个唯一审核模型，无独立回退）：${detail}`,
          { cause: learnedFailure, ...(diagnostics ? { diagnostics } : {}) },
        );
      }
      if (diagnostics) {
        throw new ToolDependencyError(
          "PROSE_GATE_UNAVAILABLE",
          `语义正文门控暂时不可用：${diagnostics.errors.join(" | ")}`,
          { cause: learnedFailure, diagnostics },
        );
      }
      throw learnedFailure;
    }
  }
  return issues;
}

export async function handleProposeDocument({ input, project, store, sessionId, emit, context, characterScope }: ToolHandlerArgs): Promise<string> {
  assertWritableMode(context.permissionMode, "propose_document");
  const path = requireString(input.path, "path");
  const content = requireString(input.content, "content");
  // 调用方没给数字时用本轮篇幅目标兜底，而不是把交付卡在「必须先报个数」上。
  const rawTargetCharacters = input.targetCharacters
    ?? (isScenePipelineDocument(path) ? context.proseLength?.targetCharacters : undefined);
  if (isScenePipelineDocument(path) && rawTargetCharacters === undefined) {
    throw new Error("章节/支线完整正文必须传 targetCharacters；先确定全文目标字数再提交");
  }
  let lengthNotice: string | undefined;
  if (rawTargetCharacters !== undefined) {
    const targetCharacters = Number(rawTargetCharacters);
    if (!Number.isInteger(targetCharacters)
      || targetCharacters < MIN_CHAPTER_TARGET_CHARACTERS
      || targetCharacters > MAX_CHAPTER_TARGET_CHARACTERS) {
      throw new Error(`targetCharacters 须为 ${MIN_CHAPTER_TARGET_CHARACTERS}—${MAX_CHAPTER_TARGET_CHARACTERS} 的整数`);
    }
    const lines = content.trim().split(/\r?\n/u);
    const body = lines[0]?.startsWith("# ") ? lines.slice(1).join("\n").trim() : content.trim();
    const outcome = proseLengthOutcome(
      assessProseLength(targetCharacters, body),
      context.proseLength?.enforceMinimum === true,
      context.proseLength?.mode ?? "bounded",
    );
    if (outcome.blocked) throw new ToolRevisionRequiredError("PROSE_LENGTH_REVISION_REQUIRED", outcome.message);
    lengthNotice = outcome.notice;
  }
  return submitFullDocumentProposal(
    { input, project, store, sessionId, emit, context, characterScope },
    path,
    content,
    requireString(input.summary, "summary"),
    input.characterChanges,
    false,
    false,
    lengthNotice,
  );
}

export async function submitFullDocumentProposal(
  args: ToolHandlerArgs,
  path: string,
  proposedContent: string,
  summary: string,
  characterChanges: unknown,
  proseStyleApproved = false,
  semanticReviewApproved = false,
  /** 偏短但不阻断时给作者/Agent 看的一句话；随提案结果一起回给 Agent。 */
  lengthNotice?: string,
): Promise<string> {
  const { project, store, sessionId, emit, context, characterScope } = args;
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  assertCreativeOutlineDesigned(context, path, context.fileMutationTool ?? "propose_document");
  rejectCompressedPlaceholder(proposedContent, "content");
  const meta = gateProseMetaLeaks(proposedContent, path);
  const strippedMeta = [...meta.stripped];
  let proposedBody = meta.content;
  let draftSourceHash = project.hash(proposedBody);
  const deliverableId = typeof args.input.deliverableId === "string" && args.input.deliverableId.trim()
    ? args.input.deliverableId.trim()
    : undefined;
  const recordLatestProposalDraft = (content: string, sourceHash: string) => {
    context.latestProposalDraft = {
      path,
      ...(deliverableId ? { deliverableId } : {}),
      content,
      sourceHash,
    };
  };
  recordLatestProposalDraft(proposedBody, draftSourceHash);
  let styleAutoRepair: { attempts: number; edits: number; initialBlockers: number } | undefined;
  let policyObservations: Awaited<ReturnType<typeof gateProseStyleWithSparseAutoRepair>>["policyObservations"];
  const expectedDocumentBase = context.proposalExpectedDocumentBase?.path === path
    && context.proposalExpectedDocumentBase.deliverableId === deliverableId
    ? context.proposalExpectedDocumentBase
    : undefined;
  const baseChangedResult = () => JSON.stringify({
    status: "recoverable_state_error",
    code: expectedDocumentBase?.revisionCaseId
      ? "PROPOSAL_REVISION_BASE_CHANGED"
      : "PROPOSAL_DOCUMENT_BASE_CHANGED",
    failureKind: "invalid_request",
    retryable: false,
    path,
    error: expectedDocumentBase?.revisionCaseId
      ? "活动修订期间目标文档已变化，旧修订稿不能自动覆盖当前文档。请由用户确认后重新基于当前文档开始修订。"
      : "终审期间目标文档已变化，未创建提案。请重新读取当前文档并基于最新版本处理。",
  });
  const existed = project.documentExists(path);
  let beforeContent: string;
  try {
    beforeContent = existed ? project.read(path) : "";
  } catch (error) {
    if (expectedDocumentBase) return baseChangedResult();
    throw error;
  }
  const liveBaseHash = existed ? project.hash(beforeContent) : "__missing__";
  if (expectedDocumentBase
    && (expectedDocumentBase.exists !== existed || expectedDocumentBase.sourceHash !== liveBaseHash)) {
    return baseChangedResult();
  }
  const expectedBaseHash = expectedDocumentBase?.sourceHash ?? liveBaseHash;
  if (semanticReviewApproved && context.activeProposalRevisionPaths?.has(path)) {
    return JSON.stringify({
      status: "recoverable_state_error",
      code: "ACTIVE_REVISION_REQUIRES_FULL_DRAFT",
      failureKind: "invalid_request",
      retryable: true,
      path,
      error: "该路径有活动工作副本；不能复用其他流程的旧终审结论。请用 read_file 查看当前草稿，并用 edit_file 做最小修改。",
      nextAllowedActions: ["read_file", "edit_file", "write_file"],
    });
  }
  // Every deterministic gate runs before anything is reported: one submission
  // should cost one repair round, not one round per gate.
  const surfaceFailures: SurfaceGateFailure[] = [];
  if (!proseStyleApproved) {
    const styleGate = await gateProseStyleWithSparseAutoRepair(
      beforeContent,
      proposedBody,
      context,
      project,
      path,
      summary,
      recordLatestProposalDraft,
    );
    proposedBody = styleGate.content;
    draftSourceHash = styleGate.sourceHash;
    strippedMeta.push(...styleGate.stripped);
    styleAutoRepair = styleGate.autoRepair;
    policyObservations = styleGate.policyObservations;
    recordLatestProposalDraft(proposedBody, draftSourceHash);
    if (styleGate.failure) surfaceFailures.push(styleGate.failure);
  }
  const narrative = isScenePipelineDocument(path);
  const cardRegisterAssessment = narrative
    ? assessCardRegisterHits(scanCardRegisterHits(proposedBody, collectRegisterRisksForContext(store, context)))
    : undefined;
  const surfaceGateResult = runSurfaceGates({
    path,
    content: proposedBody,
    sourceHash: draftSourceHash,
    ...(cardRegisterAssessment ? { cardRegister: cardRegisterAssessment } : {}),
  }, { narrative });
  surfaceFailures.push(...surfaceGateResult.blocking);
  if (surfaceFailures.length) {
    throw mergedSurfaceGateError(surfaceFailures, path, draftSourceHash);
  }
  if (!semanticReviewApproved && isScenePipelineDocument(path) && context.chapterReviewer) {
    const blocked = await reviewDirectNarrativeProposal(
      args,
      path,
      proposedBody,
      summary,
      cardRegisterAssessment,
    );
    if (blocked) return blocked;
  }
  const preparedCharacterChanges = prepareDeferredCharacterChanges(characterChanges, context, characterScope);
  // Single funnel for every narrative proposal (场景管线与直接文档两条路都走这里), so the
  // author sees the same quality picture in the review dock no matter how it was written.
  // Advisory: the report never blocks — everything that blocks已在上面 gate 掉了。
  const qualityReport = isScenePipelineDocument(path)
    ? buildProseQualityReport(proposedBody, context.proseLength
      ? { lengthTarget: context.proseLength.targetCharacters }
      : undefined)
    : undefined;
  let proposal: Proposal;
  try {
    proposal = store.createProposal(
      sessionId,
      path,
      proposedBody,
      summary,
      preparedCharacterChanges.changes,
      qualityReport,
      context.sourceMessageId,
      true,
      expectedBaseHash,
    );
  } catch (error) {
    if (!(error instanceof ProposalDocumentBaseChangedError)) throw error;
    return baseChangedResult();
  }
  emit({ type: "proposal", proposal });
  const accept = await maybeAutoAcceptProposal(store, proposal, context.permissionMode, emit, context);
  return JSON.stringify({
    ...accept,
    submissionKind: existed ? "new_version" : "new_document",
    ...(lengthNotice ? { lengthNotice } : {}),
    ...(qualityReport ? { qualityReport: formatQualityReportLines(qualityReport) } : {}),
    ...(cardRegisterAssessment && cardRegisterAssessment.status === "warn"
      ? { cardRegister: cardRegisterReportForTool(cardRegisterAssessment) }
      : {}),
    ...(policyObservations?.length ? { policyObservations } : {}),
    // Demoted surface rules: reported once, never a round trip.
    ...(surfaceGateResult.notes.length
      ? { surfaceNotes: surfaceGateResult.notes.map(note => `${note.code}：${note.message}`) }
      : {}),
    ...(existed ? { versionBaseHash: project.hash(beforeContent) } : {}),
    ...(preparedCharacterChanges.skipped ? { characterEvolutionSkipped: true } : {}),
    ...(styleAutoRepair ? { styleAutoRepaired: styleAutoRepair } : {}),
    ...(strippedMeta.length ? { metaSanitized: [...new Set(strippedMeta)] } : {}),
  });
}

async function reviewDirectNarrativeProposal(
  args: ToolHandlerArgs,
  path: string,
  content: string,
  summary: string,
  cardRegisterAssessment?: CardRegisterAssessment,
): Promise<string | undefined> {
  const reviewer = args.context.chapterReviewer!;
  const runReview = reviewer.run ?? reviewChapterDraft;
  const deliverableId = typeof args.input.deliverableId === "string" && args.input.deliverableId.trim()
    ? args.input.deliverableId.trim()
    : undefined;
  const revisionContext = args.context.runId
    ? args.context.proposalReviewRevisions?.get(proposalRevisionScopeKey({
        runId: args.context.runId,
        ...(deliverableId ? { deliverableId } : {}),
        path,
      }))
    : undefined;
  const contentSourceHash = args.project.hash(content);
  if (revisionContext && revisionContext.previousSourceHash === contentSourceHash) {
    const repairPacket = directReviewRepairPacket(
      path,
      contentSourceHash,
      revisionContext.unresolvedIssues,
    );
    return JSON.stringify({
      status: "final_review_revision_required",
      code: "DIRECT_CHAPTER_REVIEW_BLOCKED",
      path,
      proposalCreated: false,
      chapterReview: {
        verdict: "revise",
        chapterChange: "正文与上一轮语义驳回稿相同",
        reviewNotes: "未检测到可闭合既有 blocker 的正文变化；复用上一轮终审结论。",
        issues: revisionContext.unresolvedIssues,
      },
      ...(repairPacket ? { repairPacket } : {}),
      message: "正文与上一轮语义驳回稿相同，未重复调用终审。请按既有 blocker 做最小修订后再提交。",
    });
  }
  const revisionReview = revisionContext
    ? buildChapterReviewRevisionContext({
        previousContent: revisionContext.previousContent,
        content,
        previousSourceHash: revisionContext.previousSourceHash,
        priorBlockers: revisionContext.unresolvedIssues,
      })
    : undefined;
  const models = [reviewer.model, reviewer.fallbackModel]
    .filter((model): model is NonNullable<typeof model> => Boolean(model))
    .filter((model, index, all) => all.findIndex(candidate =>
      candidate.baseUrl === model.baseUrl && candidate.model === model.model) === index);
  const reviewContext = buildFactualChapterReviewContext({
    project: args.project,
    store: args.store,
    context: args.context,
    path,
    characterScope: args.characterScope,
    baseContext: reviewer.context,
  });
  const comparisonMaterials = directReviewComparisonMaterials(args, path);
  const requestCharacters = content.length + reviewContext.length + summary.length
    + comparisonMaterials.reduce((sum, item) => sum + item.path.length + item.content.length, 0)
    + (revisionReview ? JSON.stringify(revisionReview).length : 0) + 1_200;
  const failedRequestComponents = [{
    kind: "other" as const,
    label: "失败的直接整章终审请求",
    characters: requestCharacters,
    estimatedTokens: Math.ceil(requestCharacters * 0.75),
    callKind: "direct_chapter_review_failed",
  }];
  if (!models.length) {
    const bundle = buildDependencyFailureBundle({
      stage: "final_review",
      uniqueModelCount: 0,
      attempts: [buildDependencyAttempt({
        model: {
          provider: "openai-compatible",
          baseUrl: "",
          model: "(unset)",
          apiKey: "",
        },
        role: "sole",
        error: new Error("未配置终审模型"),
        recordedUsage: false,
        failureClass: "config",
      })],
    });
    return JSON.stringify(finalReviewUnavailablePayload(path, bundle));
  }
  const attempts: DependencyAttemptDiagnostic[] = [];
  for (const [modelIndex, model] of models.entries()) {
    try {
      const reviewed = await runReview(model, {
        chapterGoal: summary,
        content,
        context: reviewContext,
        ...(comparisonMaterials.length ? { comparisonMaterials } : {}),
        ...(revisionReview ? {
          revisionReview,
          revisionBaselineContent: revisionContext!.previousContent,
        } : {}),
        ...(cardRegisterAssessment
          ? { proseSignals: proseSignalsFromCardRegister(cardRegisterAssessment) }
          : {}),
        scenes: [{
          sceneId: "document",
          title: path,
          plannedTurn: summary,
          plannedOutcome: summary,
          actualState: null,
        }],
      }, reviewer.signal);
      if (reviewed.usage) {
        reportModelCallUsage(args.context.modelUsageReporter, model, reviewed.usage, {
          callKind: "direct_chapter_review",
          requestComponents: [{
            kind: "other",
            label: "直接整章终审请求",
            characters: requestCharacters,
            estimatedTokens: Math.ceil(requestCharacters * 0.75),
            callKind: "direct_chapter_review",
          }],
        });
      }
      const constrainedReview = revisionReview
        ? constrainChapterRevisionReview(
            reviewed.review,
            revisionReview,
            revisionContext!.previousContent,
            content,
          )
        : reviewed.review;
      if (constrainedReview.verdict === "pass") return undefined;
      const repairPacket = chapterReviewRepairPacket(path, contentSourceHash, constrainedReview);
      return JSON.stringify({
        status: "final_review_revision_required",
        code: "DIRECT_CHAPTER_REVIEW_BLOCKED",
        path,
        // Keep explicit so callers never treat this as a created proposal.
        proposalCreated: false,
        chapterReview: constrainedReview,
        ...(repairPacket ? { repairPacket } : {}),
        message: "终审发现有正文证据的事实、认知边界或结构问题，未创建提案。按 blocker 的 action 做最小修订后重新提交；不要删除无关事实或全文改写。",
      });
    } catch (error) {
      const usage = error instanceof ChapterReviewRequestError ? error.usage : undefined;
      const durationMs = error instanceof ChapterReviewRequestError ? error.durationMs : undefined;
      const recordedUsage = reportModelCallUsage(
        args.context.modelUsageReporter,
        model,
        usage,
        {
          callKind: "direct_chapter_review_failed",
          requestComponents: failedRequestComponents,
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      );
      attempts.push(buildDependencyAttempt({
        model,
        role: dependencyAttemptRole(modelIndex, models.length),
        error,
        recordedUsage,
        ...(error instanceof ChapterReviewRequestError
          ? {
              failureClass: error.failureClass,
              httpStatus: error.httpStatus,
              durationMs: error.durationMs,
            }
          : {}),
      }));
    }
  }
  // Parse/schema failures (e.g. revise without locatable evidence) are not outages; jn3
  // sessions were empty-retrying the same draft under a misleading "服务暂时不可用" line.
  const bundle = buildDependencyFailureBundle({
    stage: "final_review",
    attempts,
    uniqueModelCount: models.length,
  });
  return JSON.stringify(finalReviewUnavailablePayload(path, bundle));
}

function finalReviewUnavailablePayload(
  path: string,
  bundle: ReturnType<typeof buildDependencyFailureBundle>,
): Record<string, unknown> {
  const summary = dependencyFailureUserSummary(bundle);
  const guidance = dependencyFailureGuidance(bundle);
  return {
    status: "final_review_unavailable",
    code: bundle.parseOnly ? "DIRECT_CHAPTER_REVIEW_INVALID" : "DIRECT_CHAPTER_REVIEW_UNAVAILABLE",
    failureKind: bundle.parseOnly ? "invalid_output" : "dependency",
    retryable: !bundle.parseOnly,
    path,
    proposalCreated: false,
    errors: bundle.errors,
    diagnostics: bundle,
    message: `${summary}${guidance ? ` ${guidance}` : ""}`.trim(),
  };
}

function directReviewComparisonMaterials(
  args: Pick<ToolHandlerArgs, "project">,
  path: string,
): Array<{ path: string; content: string; role: "template_check" }> {
  const kind = documentKind(path);
  if (kind !== "chapter" && kind !== "side") return [];
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const siblings = args.project.listDocuments()
    .filter(candidate => candidate !== path && !args.project.isDocumentHidden(candidate))
    .filter(candidate => candidate.startsWith(directory) && !candidate.slice(directory.length).includes("/"))
    .filter(candidate => documentKind(candidate) === kind)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const orderedWithTarget = [...siblings, path]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const targetIndex = orderedWithTarget.indexOf(path);
  const candidates = targetIndex > 0
    ? orderedWithTarget.slice(Math.max(0, targetIndex - 3), targetIndex)
    : siblings.slice(-3);
  return candidates.flatMap(candidate => {
    try {
      const content = args.project.read(candidate).trim().slice(0, 1_600);
      return content ? [{ path: candidate, content, role: "template_check" as const }] : [];
    } catch {
      return [];
    }
  });
}

export async function handleProposeDocumentPatch({ input, project, store, sessionId, emit, context, characterScope }: ToolHandlerArgs): Promise<string> {
  assertWritableMode(context.permissionMode, "propose_document_patch");
  const path = requireString(input.path, "path");
  if (context.activeProposalRevisionPaths?.has(path)) {
    return JSON.stringify({
      status: "recoverable_state_error",
      code: "ACTIVE_REVISION_REQUIRES_FULL_DRAFT",
      failureKind: "invalid_request",
      retryable: true,
      path,
      error: "该路径有活动工作副本；旧 patch 只能修改落盘版本。请改用 read_file/edit_file 处理当前草稿。",
      nextAllowedActions: ["read_file", "edit_file", "write_file"],
    });
  }
  const edits = Array.isArray(input.edits) ? input.edits.slice(0, 20) : [];
  if (!edits.length) throw new Error("局部修改至少需要一条 edit");
  if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
  if (!project.documentExists(path)) {
    return JSON.stringify({
      status: "recoverable_state_error",
      code: "TARGET_DOCUMENT_MISSING",
      failureKind: "invalid_request",
      retryable: true,
      path,
      error: `${path} 尚不存在，不能使用旧 patch；请用 write_file 新建，或继续 edit_file 修改工作副本`,
      nextAllowedActions: ["write_file", "edit_file"],
    });
  }
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
  const deliverableId = typeof input.deliverableId === "string" && input.deliverableId.trim()
    ? input.deliverableId.trim()
    : undefined;
  const draftSourceHash = project.hash(content);
  context.latestProposalDraft = {
    path,
    ...(deliverableId ? { deliverableId } : {}),
    content,
    sourceHash: draftSourceHash,
  };
  await gateProseStyle(beforeContent, content, context, path, draftSourceHash);
  const preparedCharacterChanges = prepareDeferredCharacterChanges(input.characterChanges, context, characterScope);
  const proposal = store.createProposal(
    sessionId, path, content, requireString(input.summary, "summary"),
    preparedCharacterChanges.changes,
    undefined,
    context.sourceMessageId,
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
