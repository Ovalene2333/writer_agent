import {
  classifyAgentToolOutcome,
  isSuccessfulDocumentSubmission,
  proposalIdFromToolResult,
} from "./agent_runtime.js";
import { writingWorkflowStagesForTool } from "./writing_workflow.js";
import type { AgentRunToolObservation } from "./agent_run_types.js";

const PROJECT_EVIDENCE_TOOLS = new Set([
  "search_project", "read_document", "read_document_span", "get_outline_node",
  "get_character", "get_simple_character", "read_file", "read_conversation", "read_context_artifact",
]);

export interface InterpretedAgentToolResult {
  parsed?: Record<string, unknown>;
  observation: AgentRunToolObservation;
  document?: {
    deliverableId?: string;
    proposalId?: number;
    changeSetId?: number;
    path?: string;
    artifactKey: string;
    proposalStatus?: "pending" | "accepted";
  };
  waiting: boolean;
}

function resultMessage(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return "工具没有返回可验证 JSON";
  if (typeof result.error === "string") return result.error;
  if (typeof result.message === "string") return result.message;
  return typeof result.status === "string" ? result.status : undefined;
}

function gateName(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return undefined;
  const code = typeof result.code === "string" ? result.code : "";
  if (result.rhythmRevisionRequired === true || code === "RHYTHM_POLISH_REQUIRED") return "rhythm";
  if (code.includes("REVIEW") || result.status === "final_review_revision_required") return "semantic_review";
  if (code.includes("STYLE")) return "style";
  if (result.failureKind === "semantic_revision") return "proposal";
  return undefined;
}

export function interpretAgentToolResult(
  toolName: string,
  rawResult: string,
): InterpretedAgentToolResult {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(rawResult) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { /* classified as fatal below */ }
  const classified = classifyAgentToolOutcome(toolName, parsed);
  // Only explicit review/gate outcomes consume a semantic revision attempt.
  // A proposal tool may also fail because its arguments or target state are
  // invalid; those remain ordinary retryable tool errors.
  const gate = gateName(parsed);
  const revisionRequired = Boolean(gate && classified.kind === "retryable_error");
  const expectedRhythmTransition = gate === "rhythm";
  const successful = classified.kind === "success" || expectedRhythmTransition;
  const observation: AgentRunToolObservation = {
    toolName,
    outcome: revisionRequired ? "revision_required" : classified.kind,
    successful,
    ...(resultMessage(parsed) ? { message: resultMessage(parsed) } : {}),
    ...(PROJECT_EVIDENCE_TOOLS.has(toolName) && successful ? { reusableEvidence: true } : {}),
    ...(["save_character", "save_simple_character"].includes(toolName)
      || (toolName === "apply_character_changes" && Array.isArray(parsed?.applied) && parsed.applied.length)
      ? { characterArtifactProduced: successful }
      : {}),
    ...(toolName === "generate_image" && parsed?.status === "generated" ? { imageArtifactProduced: true } : {}),
    ...(toolName === "manage_prose_gates" && parsed?.status === "saved" ? { proseGateRuleSaved: true } : {}),
    ...(parsed ? { workflowStages: [...writingWorkflowStagesForTool(toolName, parsed)] } : {}),
    ...(gate ? { gate } : {}),
  };
  let document: InterpretedAgentToolResult["document"];
  if (parsed && isSuccessfulDocumentSubmission(toolName, parsed) && !revisionRequired) {
    const proposalId = proposalIdFromToolResult(parsed);
    const changeSetId = typeof parsed.changeSetId === "number" && parsed.changeSetId > 0 ? parsed.changeSetId : undefined;
    const path = typeof parsed.path === "string" ? parsed.path : undefined;
    const artifactKey = proposalId !== undefined
      ? `proposal:${proposalId}`
      : changeSetId !== undefined
        ? `change-set:${changeSetId}`
        : `${toolName}:path:${path ?? "unknown"}`;
    const status = typeof parsed.status === "string" ? parsed.status : undefined;
    document = {
      ...(typeof parsed.deliverableId === "string" && parsed.deliverableId.trim()
        ? { deliverableId: parsed.deliverableId.trim() }
        : {}),
      ...(proposalId !== undefined ? { proposalId } : {}),
      ...(changeSetId !== undefined ? { changeSetId } : {}),
      ...(path ? { path } : {}),
      artifactKey,
      ...(status === "accepted" || status === "pending" ? { proposalStatus: status } : {}),
    };
  }
  return {
    parsed,
    observation,
    ...(document ? { document } : {}),
    waiting: parsed?.status === "waiting",
  };
}
