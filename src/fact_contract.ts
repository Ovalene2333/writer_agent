/**
 * Fact contract (事实契约) — the closed half of the fact layer.
 *
 * The write pack is a *promise* handed to the Writer: these facts hold, this
 * information must land, this may not be invented, this is what the viewpoint
 * character can perceive and know. Until now nothing ever checked whether the
 * finished prose kept that promise: coverage gaps only measure whether enough
 * evidence was read *before* writing, and final review never saw the pack at
 * all. A promise nobody verifies is a prompt, not a constraint.
 *
 * This module normalizes the pack into addressable commitments and hands them
 * to final review as the baseline it judges against. Verification stays with
 * the review model on purpose — whether a piece of information "landed
 * naturally" is a semantic question, and matching it by pattern would both
 * miss real failures and reject legitimate prose. What is deterministic here
 * is only the contract itself: stable ids, a stable hash, and the guarantee
 * that the reviewer is judging the same commitments the Writer was given.
 *
 * Violations need no special transport: they come back as ordinary review
 * blockers with verbatim evidence, which the existing repair packet turns into
 * a bounded revision delegated to the Writer that owns the facts.
 */

import { createHash } from "node:crypto";
import type { WritePack } from "./write_pack.js";

export type FactCommitmentKind =
  /** Information the prose must deliver; absence is a violation. */
  | "must_land"
  /** Established fact the prose may not contradict. */
  | "known_fact"
  /** Deliberate blank the prose may not fill in. */
  | "do_not_invent"
  /** Perceptual ceiling of the narration. */
  | "viewpoint"
  /** Per-character epistemic boundary. */
  | "knowledge_gate";

export type FactCommitment = {
  id: string;
  kind: FactCommitmentKind;
  claim: string;
  /** Present on knowledge_gate commitments. */
  character?: string;
  /** Review issue kind a violation of this commitment should be reported as. */
  reportAs: "commitment_unmet" | "fact_conflict" | "unsupported_fact" | "knowledge_leak";
};

export type FactContract = {
  version: 1;
  path: string;
  commitments: FactCommitment[];
  hash: string;
};

/** Per-kind caps: a contract the reviewer cannot hold in one pass is not a contract. */
const LIMITS: Record<FactCommitmentKind, number> = {
  must_land: 8,
  known_fact: 12,
  do_not_invent: 8,
  viewpoint: 1,
  knowledge_gate: 6,
};

const REPORT_AS: Record<FactCommitmentKind, FactCommitment["reportAs"]> = {
  must_land: "commitment_unmet",
  known_fact: "fact_conflict",
  do_not_invent: "unsupported_fact",
  viewpoint: "knowledge_leak",
  knowledge_gate: "knowledge_leak",
};

/**
 * Normalize the pack the Writer was given into checkable commitments.
 * Returns undefined when the pack carries no verifiable promise — an empty
 * contract would only tell the reviewer to look for nothing in particular.
 */
export function buildFactContract(path: string, pack: WritePack): FactContract | undefined {
  const commitments: FactCommitment[] = [];
  const push = (kind: FactCommitmentKind, claim: string, character?: string) => {
    const text = claim.trim();
    if (!text) return;
    if (commitments.filter(item => item.kind === kind).length >= LIMITS[kind]) return;
    commitments.push({
      id: `${kind}:${commitments.length + 1}`,
      kind,
      claim: text.slice(0, 400),
      ...(character ? { character } : {}),
      reportAs: REPORT_AS[kind],
    });
  };

  for (const item of pack.mustLand) push("must_land", item);
  for (const item of pack.knownFacts) push("known_fact", item);
  for (const item of pack.doNotInvent) push("do_not_invent", item);
  if (pack.viewpoint) push("viewpoint", pack.viewpoint);
  for (const gate of pack.knowledgeGates ?? []) {
    // Only the negative halves are checkable: "knows" licenses prose rather
    // than constraining it, so a missing mention of it is not a violation.
    const fields = [
      gate.unknown.length ? `不知道：${gate.unknown.join("、")}` : "",
      gate.concealing.length ? `在隐瞒：${gate.concealing.join("、")}` : "",
    ].filter(Boolean);
    if (!fields.length) continue;
    push("knowledge_gate", fields.join("；"), gate.character);
  }

  if (!commitments.length) return undefined;
  const base = { version: 1 as const, path, commitments };
  return { ...base, hash: createHash("sha256").update(JSON.stringify(base)).digest("hex").slice(0, 32) };
}

/**
 * Reviewer-facing view. The instructions matter as much as the data: the
 * reviewer must judge the prose against the contract, not re-litigate whether
 * the contract itself was a good idea, and must not manufacture a violation it
 * cannot quote.
 */
export function factContractForReview(contract: FactContract): {
  instructions: string;
  hash: string;
  commitments: FactCommitment[];
} {
  return {
    instructions: [
      "factContract 是本轮 Writer 被交付的事实承诺，与正文同源，是判定事实类问题的基准。",
      "must_land：正文须让该信息自然落地（可由动作、对白、物件或处境承载，不要求原句复述）；确实没有落地才判 commitment_unmet blocker。",
      "known_fact：正文不得与之冲突；冲突判 fact_conflict。",
      "do_not_invent：正文不得为该空白给出具体答案；补写判 unsupported_fact。",
      "viewpoint / knowledge_gate：叙述不得越过视角人物的感知，「不知道」的内容该人物不得说出、想到或由贴身叙述点破，「在隐瞒」只能以回避或不完整回答呈现；越界判 knowledge_leak。",
      "每条违约都必须给出逐字证据；must_land 类缺失无法引用原文时，引用最该承载它却没有承载的那一处。无法定位就不要报。",
      "契约条目本身不是文风要求，不得因为正文没有逐条复述而判违约。",
    ].join("\n"),
    hash: contract.hash,
    commitments: contract.commitments,
  };
}
