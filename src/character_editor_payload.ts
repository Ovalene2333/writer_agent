import type { CharacterInput, CharacterReplaceSection } from "./characters.js";

export const CHARACTER_EDITOR_REPLACE_SECTIONS: CharacterReplaceSection[] = [
  "motivations",
  "features",
  "competencies",
  "relationships",
  "storyStates",
  "experiences",
  "traits",
  "values",
  "fears",
  "conflicts",
];

/** The web editor submits a complete card, so its array values replace saved arrays. */
export function characterEditorSaveInput(draft: CharacterInput): CharacterInput {
  return {
    ...draft,
    replaceSections: [...CHARACTER_EDITOR_REPLACE_SECTIONS],
  };
}
