/**
 * Surface gate registry (表面层门禁登记表).
 *
 * Surface gates are the cheap, deterministic half of the framework: quote
 * shape, card-register diction, document/planner labels leaking into prose.
 * They have hard criteria, need no model call, and their findings are always
 * locatable — which is exactly why they may block.
 *
 * They were previously three hard-coded branches inside the proposal path, so
 * adding, removing or demoting one meant editing control flow and re-reasoning
 * about ordering and retry accounting. Declaring them here instead makes the
 * inventory itself a first-class object: what blocks, what only warns, and
 * which documents each rule applies to, all readable in one place.
 *
 * Two rules keep this layer from drifting into the craft layer:
 * - A gate belongs here only if it is deterministic AND its findings can be
 *   quoted verbatim. Anything requiring a judgement about whether prose is
 *   *good* belongs to final review, not here.
 * - `severity: "note"` is a real option. A rule worth surfacing but not worth
 *   a round trip should be demoted rather than deleted or left blocking.
 */

import { auditDialogueFormat, dialogueFormatGateError } from "./dialogue_format.js";
import { cardRegisterGateError, cardRegisterRepairPacket, type CardRegisterAssessment } from "./register_risks.js";
import { boundedRepairPacket, type RepairPacket } from "./repair_packet.js";

/** Which documents a gate judges. `narrative` = chapter/side prose only. */
export type SurfaceGateScope = "any" | "narrative";

export type SurfaceGateFinding = {
  code: string;
  message: string;
  repairPacket?: RepairPacket;
};

export type SurfaceGateInput = {
  path: string;
  content: string;
  sourceHash: string;
  /** Precomputed so the caller can reuse it for review signals and reporting. */
  cardRegister?: CardRegisterAssessment;
};

export type SurfaceGate = {
  id: string;
  scope: SurfaceGateScope;
  /** `block` rejects the submission; `note` is reported without a round trip. */
  severity: "block" | "note";
  /** One line, for the rule inventory. */
  describe: string;
  run: (input: SurfaceGateInput) => SurfaceGateFinding | undefined;
};

export const SURFACE_GATES: readonly SurfaceGate[] = [
  {
    id: "dialogue_format",
    scope: "narrative",
    severity: "block",
    describe: "对白引号、说话人标注与段落归属的格式规范",
    run: ({ content, path, sourceHash }) => {
      const message = dialogueFormatGateError(content);
      if (!message) return undefined;
      const issues = auditDialogueFormat(content).filter(issue => issue.blocksProposal);
      const repairPacket = boundedRepairPacket({
        path,
        sourceHash,
        issueCount: issues.length,
        issues: issues.map((issue, index) => ({
          id: `dialogue_format:${issue.code}:${issue.line}:${issue.column}:${index}`,
          kind: issue.code,
          line: issue.line,
          evidence: issue.evidence,
          problem: issue.message,
          action: issue.suggestion,
        })),
      });
      return {
        code: "DIALOGUE_FORMAT_REVISION_REQUIRED",
        message,
        ...(repairPacket ? { repairPacket } : {}),
      };
    },
  },
  {
    id: "card_register",
    scope: "narrative",
    severity: "block",
    describe: "角色卡措辞被直接搬进对白或贴身叙述",
    run: ({ content: _content, path, sourceHash, cardRegister }) => {
      if (!cardRegister) return undefined;
      const message = cardRegisterGateError(cardRegister);
      if (!message) return undefined;
      const repairPacket = cardRegisterRepairPacket(_content, cardRegister, { path, sourceHash });
      return {
        code: "CARD_REGISTER_REVISION_REQUIRED",
        message,
        ...(repairPacket ? { repairPacket } : {}),
      };
    },
  },
];

/** Run every gate whose scope admits this document. Order is registry order. */
export function runSurfaceGates(
  input: SurfaceGateInput,
  options: { narrative: boolean },
): { blocking: SurfaceGateFinding[]; notes: SurfaceGateFinding[] } {
  const blocking: SurfaceGateFinding[] = [];
  const notes: SurfaceGateFinding[] = [];
  for (const gate of SURFACE_GATES) {
    if (gate.scope === "narrative" && !options.narrative) continue;
    const finding = gate.run(input);
    if (!finding) continue;
    (gate.severity === "block" ? blocking : notes).push(finding);
  }
  return { blocking, notes };
}
