import { createHash } from "node:crypto";
import type { Character } from "./types.js";

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
  }>;
};

export function characterConstraintView(character: Character): CharacterConstraintView {
  return {
    id: character.id,
    name: character.identity.name,
    competencies: character.competencies.slice(0, 16).map(item => ({
      id: item.id,
      name: item.name,
      summary: item.summary,
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
    storyStates: character.storyStates.slice(-4).map(state => ({
      anchor: state.outlineNodeId ?? (state.unanchored ? "unanchored" : ""),
      validity: { from: state.validFrom, until: state.validUntil },
      location: state.location,
      physical: state.physical,
      knowledge: state.knowledge.map(item => item.description || item.label),
      beliefs: state.beliefs.map(item => item.description || item.label),
    })),
  };
}

export function characterConstraintHash(view: CharacterConstraintView): string {
  return createHash("sha256").update(JSON.stringify(view)).digest("hex");
}
