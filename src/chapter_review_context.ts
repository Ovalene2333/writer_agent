import type { Character } from "./types.js";
import type { WriterProject } from "./project.js";
import type { WriterStore } from "./store.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { characterConstraintHash, characterConstraintView } from "./character_constraints.js";

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
  const constraintMismatches = characters.flatMap(character => {
    const writerHash = context.writerCharacterConstraintHashes?.get(character.id);
    return writerHash && writerHash !== character.constraintHash
      ? [{ characterId: character.id, writerHash, reviewerHash: character.constraintHash }]
      : [];
  });
  if (constraintMismatches.length) {
    throw new Error(`Writer/Reviewer 角色硬约束不一致：${JSON.stringify(constraintMismatches)}`);
  }

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

export function characterReviewView(character: Character) {
  const constraints = characterConstraintView(character);
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
    constraints,
    constraintHash: characterConstraintHash(constraints),
    relationships,
    intentions: character.storyStates.slice(-4).flatMap(state => state.intentions),
    experiences: character.experiences.slice(-8).map(item => ({
      fact: item.description || item.label,
      validity: { from: item.validFrom, until: item.validUntil },
    })),
  };
}
