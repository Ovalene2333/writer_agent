import type { Character } from "./types.js";
import type { WriterProject } from "./project.js";
import type { WriterStore } from "./store.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { characterConstraintHash, characterConstraintView } from "./character_constraints.js";
import { buildNarrativeEvidencePacket } from "./narrative_evidence.js";
import { OutlineStore } from "./outline.js";

const REVIEW_CONTEXT_CHARACTER_LIMIT = 8;

export function buildFactualChapterReviewContext(options: {
  project: WriterProject;
  store: WriterStore;
  context: ToolExecutionContext;
  sessionId?: string;
  path: string;
  characterScope?: number[];
  baseContext?: string;
}): string {
  const { project, store, context, path } = options;
  // Scene-selected cards are review evidence even when the UI read scope is broader
  // or absent. Preserve both rather than treating permission scope as participation.
  const requestedCharacterIds = [
    ...(context.reviewCharacterIds ?? []),
    ...(options.characterScope ?? []),
  ];
  const characterScope = requestedCharacterIds.length
    ? [...new Set(requestedCharacterIds)]
    : undefined;
  const narrativeEvidence = buildNarrativeEvidencePacket({
    project,
    store,
    context,
    sessionId: options.sessionId,
    path,
    ...(characterScope ? { characterIds: characterScope } : {}),
  });
  const cards = store.characters();
  const outlineNodes = new OutlineStore(project).sync().nodes;
  const targetNodeId = outlineNodes
    .filter(node => node.documentPath === path)
    .sort((a, b) => b.order - a.order)[0]?.id;
  const cardsById = new Map(cards.map(character => [character.id, character]));
  // Writer visibility is least-privilege; final review is deliberately broader
  // so it can recognize an ability or state the scene used without permission.
  const characters = narrativeEvidence.characters
    .map(item => cardsById.get(item.id))
    .filter((character): character is Character => Boolean(character))
    .slice(0, REVIEW_CONTEXT_CHARACTER_LIMIT)
    .map(character => characterReviewView(character, outlineNodes, targetNodeId));
  // Voice evidence is deliberately narrower than factual review scope: a card
  // belongs here only when the writing Agent actually read its voice section for
  // spoken dialogue. This preserves source evidence without dumping every card.
  const dialogueCharacters = [...new Set(context.dialogueEvidenceCharacterIds ?? [])]
    .map(id => cardsById.get(id))
    .filter((character): character is Character => Boolean(character))
    .slice(0, REVIEW_CONTEXT_CHARACTER_LIMIT)
    .map(characterDialogueReviewView);
  const constraintMismatches = narrativeEvidence.characters.flatMap(character => {
    const writerHash = context.writerCharacterConstraintHashes?.get(character.id);
    return writerHash && writerHash !== character.constraintHash
      ? [{ characterId: character.id, writerHash, reviewerHash: character.constraintHash }]
      : [];
  });
  if (constraintMismatches.length) {
    throw new Error(`Writer/Reviewer 角色硬约束不一致：${JSON.stringify(constraintMismatches)}`);
  }

  const sceneCapabilityScopes = context.chapterSceneDraft?.path === path
    ? context.chapterSceneDraft.scenes.map(scene => ({
      sceneId: scene.id,
      characterScopes: scene.characterScopes ?? [],
    }))
    : [];
  const evidencePacket = JSON.stringify({
    instructions: "narrativeEvidence 是 Writer 与终审共享的事实底座。coverageGaps 表示写前证据覆盖不足，不能把它冒充为正文自身的事实错误；只有正文违背已提供证据时才判 fact/knowledge blocker。objective 只是客观成立；character_knowledge 仅 knownBy 可直接知道；rumor 只能作为传闻或信念。conflict/pending 不得自行选边。characters 是仅供终审核验越权的完整硬约束，不扩大 Writer 许可；sceneCapabilityScopes 是逐场能力/对白声线许可，按 competencyUses.mode 判定使用、尝试、觉醒、恢复或失去，没有列出即不许可。dialogueCharacters 仅包含写作时实际读取过 voice 的说话角色。",
    narrativeEvidence,
    characters,
    dialogueCharacters,
    sceneCapabilityScopes,
    writerEvidenceHashes: [...(context.narrativeEvidencePackets?.entries() ?? [])]
      .filter(([key]) => key === path || key.startsWith(`${path}#`))
      .map(([key, packet]) => ({ key, hash: packet.hash })),
  });
  return [options.baseContext?.trim(), evidencePacket].filter(Boolean).join("\n\n");
}

export function characterReviewView(
  character: Character,
  nodes: import("./types.js").OutlineNode[] = [],
  targetNodeId?: string,
) {
  const constraints = characterConstraintView(character, nodes, targetNodeId);
  return {
    id: character.id,
    name: character.identity.name,
    aliases: character.identity.aliases,
    identity: character.identity.summary,
    background: character.profile.backgroundSummary,
    constraints,
    constraintHash: characterConstraintHash(characterConstraintView(character)),
    experiences: character.experiences.slice(-8).map(item => ({
      fact: item.description || item.label,
      validity: { from: item.validFrom, until: item.validUntil },
    })),
  };
}

function characterDialogueReviewView(character: Character) {
  const state = character.storyStates.at(-1);
  return {
    id: character.id,
    name: character.identity.name,
    voice: {
      summary: character.voice.summary,
      register: character.voice.register,
      diction: character.voice.diction.slice(0, 12),
      verbalHabits: character.voice.verbalHabits.slice(0, 12),
      avoidedExpressions: character.voice.avoidedExpressions.slice(0, 12),
      examples: character.voice.examples.slice(0, 3),
    },
    motivations: character.motivations
      .filter(item => item.status === "active" || item.status === "blocked")
      .slice(-6)
      .map(item => ({ summary: item.summary, stakes: item.stakes, obstacles: item.obstacles })),
    relationships: character.relationships.slice(0, 12).map(item => ({
      characterId: item.characterId,
      type: item.type,
      attitude: item.attitude,
      status: item.status,
      description: item.description,
    })),
    storyState: state && {
      location: state.location,
      physical: state.physical,
      emotion: state.emotion,
      intentions: state.intentions,
      temporaryGoals: state.temporaryGoals.map(item => ({ summary: item.summary, stakes: item.stakes, obstacles: item.obstacles })),
      notes: state.notes,
    },
  };
}
