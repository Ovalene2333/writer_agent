import type { Character } from "./types.js";
import type { WriterProject } from "./project.js";
import type { WriterStore } from "./store.js";
import type { ToolExecutionContext } from "./tools/types.js";

const REVIEW_CONTEXT_CHARACTER_LIMIT = 8;
const REVIEW_CONTEXT_EXCERPT_LIMIT = 5_000;

export function buildFactualChapterReviewContext(options: {
  project: WriterProject;
  store: WriterStore;
  context: ToolExecutionContext;
  path: string;
  characterScope?: number[];
  baseContext?: string;
}): string {
  const { project, store, context, path } = options;
  const characterScope = options.characterScope?.length
    ? options.characterScope
    : context.reviewCharacterIds?.length ? context.reviewCharacterIds : undefined;
  const facts = store.continuityFactPacket({
    targetPath: path,
    characterIds: characterScope,
    limit: 24,
  }).map(fact => ({
    id: fact.id,
    statement: fact.statement,
    kind: fact.kind,
    scope: [fact.scopeKind, fact.scopeValue].filter(Boolean).join(":"),
    epistemic: fact.epistemic,
    knownBy: fact.knownBy,
    validity: { from: fact.validFrom, until: fact.validUntil },
    status: fact.status,
    source: { path: fact.sourcePath, evidence: fact.sourceEvidence },
    conflictsWith: fact.conflictsWith,
  }));
  const factCharacterNames = new Set(facts.flatMap(fact => fact.knownBy));
  const scopedIds = characterScope === undefined ? undefined : new Set(characterScope);
  const characters = store.characters()
    .filter(character => scopedIds
      ? scopedIds.has(character.id)
      : factCharacterNames.has(character.identity.name)
        || character.identity.aliases.some(alias => factCharacterNames.has(alias)))
    .slice(0, REVIEW_CONTEXT_CHARACTER_LIMIT)
    .map(characterReviewView);

  const excerpts: Array<{ path: string; startLine: number; endLine: number; content: string }> = [];
  let excerptCharacters = 0;
  for (const [sourcePath, snapshot] of context.readSnapshots ?? []) {
    if (excerpts.length >= 8 || excerptCharacters >= REVIEW_CONTEXT_EXCERPT_LIMIT) break;
    if (!project.textFileExists(sourcePath)) continue;
    const source = project.readTextFile(sourcePath);
    if (project.hash(source) !== snapshot.sourceHash) continue;
    const lines = source.split(/\r?\n/u);
    for (const range of snapshot.ranges) {
      if (excerpts.length >= 8 || excerptCharacters >= REVIEW_CONTEXT_EXCERPT_LIMIT) break;
      const remaining = REVIEW_CONTEXT_EXCERPT_LIMIT - excerptCharacters;
      const content = lines.slice(Math.max(0, range.startLine - 1), range.endLine).join("\n").slice(0, remaining);
      if (!content.trim()) continue;
      excerpts.push({ path: sourcePath, startLine: range.startLine, endLine: range.endLine, content });
      excerptCharacters += content.length;
    }
  }

  const evidencePacket = JSON.stringify({
    instructions: "以下是终审可用的事实证据，不代表每项都是角色所知。objective 只是客观成立；character_knowledge 仅 knownBy 可直接知道；rumor 只能作为传闻或信念。conflict/pending 不得自行选边。",
    continuityFacts: facts,
    characters,
    readExcerpts: excerpts,
  });
  return [options.baseContext?.trim(), evidencePacket].filter(Boolean).join("\n\n");
}

function characterReviewView(character: Character) {
  const relationships = character.relationships.slice(0, 12).map(item => ({
    characterId: item.characterId,
    type: item.type,
    attitude: item.attitude,
    status: item.status,
    description: item.description,
    validity: { from: item.validFrom, until: item.validUntil },
  }));
  return {
    id: character.id,
    name: character.identity.name,
    aliases: character.identity.aliases,
    identity: character.identity.summary,
    background: character.profile.backgroundSummary,
    relationships,
    competencies: character.competencies.slice(0, 12).map(item => ({
      name: item.name,
      unlocked: item.unlocked,
      summary: item.summary,
      limitations: item.limitations,
      costs: item.costs,
      validity: { from: item.validFrom, until: item.validUntil },
    })),
    storyStates: character.storyStates.slice(-4).map(state => ({
      anchor: state.outlineNodeId ?? (state.unanchored ? "unanchored" : ""),
      validity: { from: state.validFrom, until: state.validUntil },
      location: state.location,
      physical: state.physical,
      knowledge: state.knowledge.map(item => item.description || item.label),
      beliefs: state.beliefs.map(item => item.description || item.label),
      intentions: state.intentions,
      notes: state.notes,
    })),
    experiences: character.experiences.slice(-8).map(item => ({
      fact: item.description || item.label,
      validity: { from: item.validFrom, until: item.validUntil },
    })),
  };
}
