import { createHash } from "node:crypto";
import type { Character, OutlineNode } from "./types.js";
import { competencyCapabilityIndex } from "./characters.js";
import { resolveCompetencyStates } from "./competency_state.js";

/**
 * Writing and final review must reason from the same compact, non-compressible
 * character constraints. Descriptive card prose may be recovered separately;
 * these fields decide whether an action or piece of knowledge is possible.
 */
export type CharacterConstraintView = {
  id: number;
  name: string;
  competencies: Array<{
    id: string;
    name: string;
    summary: string;
    availability: string;
    stateReason: string;
    stateEvidence?: string;
    /** Legacy compatibility signal; availability is authoritative. */
    unlocked: boolean;
    limitations: string[];
    costs: string[];
    validity: { from?: string; until?: string };
  }>;
  relationships: Array<{
    characterId: number;
    type: string;
    status: string;
    validity: { from?: string; until?: string };
  }>;
  storyStates: Array<{
    anchor: string;
    validity: { from?: string; until?: string };
    location: string;
    physical: string;
    knowledge: string[];
    beliefs: string[];
    competencyStates: Array<{ competencyId: string; state: string; reason: string; evidence?: string }>;
  }>;
};

/**
 * The writing Agent sees only a compact discovery index. Full mechanisms and
 * boundaries are recovered through a targeted card read after a scene scope has
 * selected the capability; factual review always receives the full view above.
 */
export type CharacterWritingConstraintView = Omit<CharacterConstraintView, "competencies"> & {
  capabilityIndex: Array<{ id: string; name: string; summary: string }>;
};

export function characterConstraintView(
  character: Character,
  nodes: OutlineNode[] = [],
  targetNodeId?: string,
): CharacterConstraintView {
  const competencyStates = resolveCompetencyStates(character, nodes, targetNodeId);
  const order = new Map(nodes.map(node => [node.id, node.order]));
  const target = targetNodeId ? order.get(targetNodeId) : undefined;
  const storyStates = target === undefined
    ? character.storyStates
    : character.storyStates.filter(state => Boolean(state.outlineNodeId)
      && (order.get(state.outlineNodeId!) ?? Infinity) <= target);
  return {
    id: character.id,
    name: character.identity.name,
    competencies: character.competencies.slice(0, 16).map(item => ({
      id: item.id,
      name: item.name,
      summary: item.summary,
      availability: competencyStates.get(item.id)?.state ?? "unknown",
      stateReason: competencyStates.get(item.id)?.reason ?? "没有能力状态记录",
      ...(competencyStates.get(item.id)?.evidence ? { stateEvidence: competencyStates.get(item.id)!.evidence } : {}),
      unlocked: item.unlocked,
      limitations: item.limitations,
      costs: item.costs,
      validity: { from: item.validFrom, until: item.validUntil },
    })),
    relationships: character.relationships.slice(0, 16).map(item => ({
      characterId: item.characterId,
      type: item.type,
      status: item.status,
      validity: { from: item.validFrom, until: item.validUntil },
    })),
    storyStates: storyStates.slice(-4).map(state => ({
      anchor: state.outlineNodeId ?? (state.unanchored ? "unanchored" : ""),
      validity: { from: state.validFrom, until: state.validUntil },
      location: state.location,
      physical: state.physical,
      knowledge: state.knowledge.map(item => item.description || item.label),
      beliefs: state.beliefs.map(item => item.description || item.label),
      competencyStates: (state.competencyStates ?? []).map(item => ({
        competencyId: item.competencyId,
        state: item.state,
        reason: item.reason,
        ...(item.evidence ? { evidence: item.evidence } : {}),
      })),
    })),
  };
}

export function characterWritingConstraintView(
  character: Character,
  nodes: OutlineNode[] = [],
  targetNodeId?: string,
): CharacterWritingConstraintView {
  const constraints = characterConstraintView(character, nodes, targetNodeId);
  return {
    id: constraints.id,
    name: constraints.name,
    capabilityIndex: competencyCapabilityIndex(character, nodes, targetNodeId),
    relationships: constraints.relationships,
    storyStates: constraints.storyStates,
  };
}

export function characterConstraintHash(view: CharacterConstraintView): string {
  return createHash("sha256").update(JSON.stringify(view)).digest("hex");
}
