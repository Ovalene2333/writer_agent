import { createHash } from "node:crypto";
import { characterConstraintHash, characterConstraintView } from "./character_constraints.js";
import {
  CHARACTER_PORTRAYAL_WRITING_RULE,
  characterVoiceWritingPayload,
  competenciesWritingPayload,
} from "./characters.js";
import { resolveCompetencyStates, type SceneCompetencyUse } from "./competency_state.js";
import type { WritingMemoryEntry } from "./writing_memory.js";
import { orderedChapterPaths, type WriterProject } from "./project.js";
import type { ChapterSceneCard, SceneActualState } from "./scene_pipeline.js";
import type { Character } from "./types.js";
import type { WriterStore } from "./store.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { OutlineStore } from "./outline.js";

const MAX_MEMORY_ENTRIES = 24;
const MAX_CHARACTERS = 8;
const MAX_EXCERPT_CHARACTERS = 12_000;
const MAX_READ_SOURCES = 12;
const MAX_SOURCES = MAX_MEMORY_ENTRIES + 3;

export type NarrativeEvidenceGap = {
  code: "character_sections_missing" | "competency_evidence_missing";
  characterId: number;
  characterName: string;
  missing: string[];
  action: string;
};

export type NarrativeEvidenceSource = {
  id: string;
  path: string;
  sourceHash: string;
  kind: "read" | "memory" | "target" | "previous_boundary" | "next_boundary";
  excerpts: Array<{ startLine: number; endLine: number; content: string }>;
};

export type NarrativeCharacterEvidence = {
  id: number;
  name: string;
  aliases: string[];
  identity: string;
  background: string;
  constraintHash: string;
  constraints: ReturnType<typeof characterConstraintView>;
  allowedCompetencyIds: string[];
  allowedCompetencyUses: SceneCompetencyUse[];
  dialogueAllowed: boolean;
  availableSections: string[];
  sections: Record<string, unknown>;
};

export type NarrativeEvidencePacket = {
  version: 1;
  path: string;
  sceneId?: string;
  instructions: string;
  writingMemory: Array<{
    id: number;
    kind: string;
    content: string;
    characterIds: number[];
    status: string;
    source: { sourceId?: string; path: string; sourceHash: string; evidence: string };
  }>;
  characters: NarrativeCharacterEvidence[];
  scene?: {
    goal: string;
    entryState: string[];
    characterIntent: string[];
    obstacle: string;
    turn: string;
    outcome: string;
    currentState?: SceneActualState;
  };
  sources: NarrativeEvidenceSource[];
  coverageGaps: NarrativeEvidenceGap[];
  hash: string;
};

export type CharacterEvidenceRead = {
  sections: Set<string>;
  competencyIds: Set<string>;
};

export function recordCharacterEvidenceRead(
  context: ToolExecutionContext,
  characterId: number,
  sections: readonly string[],
  competencyIds: readonly string[] = [],
): void {
  context.characterEvidenceReads ??= new Map();
  const current = context.characterEvidenceReads.get(characterId) ?? {
    sections: new Set<string>(),
    competencyIds: new Set<string>(),
  };
  for (const section of sections) current.sections.add(section);
  for (const competencyId of competencyIds) current.competencyIds.add(competencyId);
  context.characterEvidenceReads.set(characterId, current);
}

export function buildNarrativeEvidencePacket(options: {
  project: WriterProject;
  store: WriterStore;
  context: ToolExecutionContext;
  sessionId?: string;
  path: string;
  scene?: ChapterSceneCard;
  currentState?: SceneActualState;
  characterIds?: readonly number[];
}): NarrativeEvidencePacket {
  const { project, store, context, path, scene } = options;
  const outlineNodes = new OutlineStore(project).sync().nodes;
  const targetNodeId = outlineNodes
    .filter(node => node.documentPath === path)
    .sort((a, b) => b.order - a.order)[0]?.id;
  const sceneScopes = new Map((scene?.characterScopes ?? []).map(scope => [scope.characterId, scope]));
  const requestedCharacterIds = [...new Set([
    ...(options.characterIds ?? []),
    ...(context.reviewCharacterIds ?? []),
    ...sceneScopes.keys(),
  ])].slice(0, MAX_CHARACTERS);
  const cards = new Map(store.characters().map(character => [character.id, character]));
  const rawMemory = options.sessionId ? store.writingMemoryPacket(options.sessionId, {
    targetPath: path,
    characterIds: requestedCharacterIds,
    limit: MAX_MEMORY_ENTRIES,
  }) : [];
  const characterIds = requestedCharacterIds;
  const characters = characterIds.flatMap(characterId => {
    const character = cards.get(characterId);
    return character ? [characterEvidence(character, context, sceneScopes.get(characterId), outlineNodes, targetNodeId)] : [];
  });
  const coverageGaps = characters.flatMap(evidence => {
    const card = cards.get(evidence.id);
    return card ? characterCoverageGaps(evidence, card, context) : [];
  });
  const sources = buildEvidenceSources(project, context, path, rawMemory);
  const sourceByPath = new Map(sources.map(source => [source.path, source]));
  const writingMemory = rawMemory.map(entry => ({
    id: entry.id,
    kind: entry.kind,
    content: entry.content,
    characterIds: entry.characterIds,
    status: entry.status,
    source: {
      ...(sourceByPath.get(entry.sourcePath) ? { sourceId: sourceByPath.get(entry.sourcePath)!.id } : {}),
      path: entry.sourcePath,
      sourceHash: entry.sourceHash,
      evidence: entry.sourceEvidence,
    },
  }));
  const packetBase = {
    version: 1 as const,
    path,
    ...(scene ? { sceneId: scene.id } : {}),
    instructions: "writingMemory 只是当前会话从已接受正文提取的近期辅助状态，不是项目事实、角色卡或扩写许可；冲突时以正文、角色卡和大纲为准，不确定时读取 source 原文。角色能力只可按 allowedCompetencyUses 的 mode 与入场状态处理：use 才可直接使用，attempt 可失败，unlock/regain 必须在本场建立状态转变，lose 必须写出失去事件；dialogueAllowed 只授权该角色说出口的对白声线。",
    writingMemory,
    characters,
    ...(scene ? {
      scene: {
        goal: scene.goal,
        entryState: scene.entryState,
        characterIntent: scene.characterIntent,
        obstacle: scene.obstacle,
        turn: scene.turn,
        outcome: scene.outcome,
        ...(options.currentState ? { currentState: options.currentState } : {}),
      },
    } : {}),
    sources,
    coverageGaps,
  };
  return { ...packetBase, hash: hashNarrativeEvidence(packetBase) };
}

export function narrativeEvidenceForPrompt(packet: NarrativeEvidencePacket): Omit<NarrativeEvidencePacket, "sources"> & {
  sources: Array<Omit<NarrativeEvidenceSource, "excerpts"> & { excerptCount: number; previews: string[] }>;
} {
  return {
    ...packet,
    sources: packet.sources.map(source => ({
      id: source.id,
      path: source.path,
      sourceHash: source.sourceHash,
      kind: source.kind,
      excerptCount: source.excerpts.length,
      previews: source.excerpts.map(excerpt => excerpt.content.slice(0, 1_200)),
    })),
  };
}

export function readNarrativeEvidenceSource(
  project: WriterProject,
  context: ToolExecutionContext,
  packet: NarrativeEvidencePacket,
  sourceId: string,
  startLine?: number,
  endLine?: number,
): { sourceId: string; path: string; sourceHash: string; startLine: number; endLine: number; content: string; truncated: boolean } {
  const source = packet.sources.find(item => item.id === sourceId);
  if (!source) throw new Error("证据来源不在本次 Writer 的授权范围内");
  const content = context.workingTextFiles?.get(source.path)?.content
    ?? (project.textFileExists(source.path) ? project.readTextFile(source.path) : "");
  if (!content || project.hash(content) !== source.sourceHash) throw new Error("证据来源已变化，需由主 Agent 重新读取");
  const lines = content.split(/\r?\n/u);
  const fallback = source.excerpts[0];
  const requestedStart = startLine ?? fallback?.startLine ?? 1;
  const requestedEnd = endLine ?? fallback?.endLine ?? Math.min(lines.length, requestedStart + 39);
  if (!Number.isInteger(requestedStart) || !Number.isInteger(requestedEnd) || requestedStart < 1 || requestedEnd < requestedStart) {
    throw new Error("证据行范围无效");
  }
  let actualEnd = Math.min(lines.length, requestedEnd, requestedStart + 119);
  let selected = lines.slice(requestedStart - 1, actualEnd).join("\n");
  while (selected.length > 4_000 && actualEnd > requestedStart) {
    actualEnd -= 1;
    selected = lines.slice(requestedStart - 1, actualEnd).join("\n");
  }
  if (selected.length > 4_000) selected = selected.slice(0, 4_000);
  return {
    sourceId,
    path: source.path,
    sourceHash: source.sourceHash,
    startLine: requestedStart,
    endLine: actualEnd,
    content: selected,
    truncated: actualEnd < Math.min(lines.length, requestedEnd) || selected.length >= 4_000,
  };
}

function characterEvidence(
  character: Character,
  context: ToolExecutionContext,
  scope?: { competencyIds: string[]; competencyUses?: SceneCompetencyUse[]; dialogue?: boolean },
  outlineNodes: import("./types.js").OutlineNode[] = [],
  targetNodeId?: string,
): NarrativeCharacterEvidence {
  const read = context.characterEvidenceReads?.get(character.id);
  const availableSections = [...(read?.sections ?? [])].sort();
  const sectionSet = new Set(availableSections);
  const allowedCompetencyIds = scope?.competencyIds ?? [...(read?.competencyIds ?? [])];
  const allowedCompetencyUses = scope?.competencyUses
    ?? allowedCompetencyIds.map(competencyId => ({ competencyId, mode: "use" as const }));
  const dialogueAllowed = scope ? scope.dialogue === true : sectionSet.has("voice");
  const sections: Record<string, unknown> = {};
  if (sectionSet.has("profile")) sections.profile = character.profile;
  if (sectionSet.has("psychology")) sections.psychology = character.psychology;
  if (sectionSet.has("motivations")) sections.motivations = character.motivations;
  if (sectionSet.has("voice") && dialogueAllowed) {
    sections.voice = characterVoiceWritingPayload(character.voice);
    sections.portrayalRule = CHARACTER_PORTRAYAL_WRITING_RULE;
  }
  if (sectionSet.has("features")) sections.features = character.features;
  if (sectionSet.has("competencies")) {
    sections.competencies = competenciesWritingPayload(
      character.competencies,
      allowedCompetencyIds,
      resolveCompetencyStates(character, outlineNodes, targetNodeId),
      allowedCompetencyUses,
    );
  }
  if (sectionSet.has("relationships")) sections.relationships = character.relationships;
  if (sectionSet.has("storyState")) sections.storyState = character.storyStates.at(-1);
  if (sectionSet.has("experiences")) sections.experiences = character.experiences.slice(-8);
  if (sectionSet.has("notes")) sections.notes = character.notes;
  const sourceConstraints = characterConstraintView(character, outlineNodes, targetNodeId);
  const sourceCardHash = characterConstraintHash(characterConstraintView(character));
  // The hash follows the complete source card so final review can detect drift,
  // while the Writer only sees competencies explicitly authorized for this scene.
  const constraints = {
    ...sourceConstraints,
    competencies: sourceConstraints.competencies.filter(item => allowedCompetencyIds.includes(item.id)),
  };
  return {
    id: character.id,
    name: character.identity.name,
    aliases: character.identity.aliases,
    identity: character.identity.summary,
    background: character.profile.backgroundSummary,
    constraintHash: sourceCardHash,
    constraints,
    allowedCompetencyIds,
    allowedCompetencyUses,
    dialogueAllowed,
    availableSections,
    sections,
  };
}

/** Dialogue writing requires these card sections when the role may speak. */
export function requiredDialogueEvidenceSections(character: Character): string[] {
  // Empty relationship lists carry no dialogue constraints; do not force a no-op read.
  return character.relationships.length > 0
    ? ["voice", "motivations", "relationships", "storyState"]
    : ["voice", "motivations", "storyState"];
}

function characterCoverageGaps(
  evidence: NarrativeCharacterEvidence,
  card: Character,
  context: ToolExecutionContext,
): NarrativeEvidenceGap[] {
  const gaps: NarrativeEvidenceGap[] = [];
  const read = context.characterEvidenceReads?.get(evidence.id);
  const readCompetencies = read?.competencyIds ?? new Set<string>();
  const missingCompetencies = evidence.allowedCompetencyIds.filter(id => !readCompetencies.has(id));
  if (missingCompetencies.length) {
    gaps.push({
      code: "competency_evidence_missing",
      characterId: evidence.id,
      characterName: evidence.name,
      missing: missingCompetencies,
      action: `先 get_character(view=sections, sections=[\"competencies\"], competencyIds=${JSON.stringify(missingCompetencies)}) 读取能力原文。`,
    });
  }
  if (evidence.dialogueAllowed) {
    const required = requiredDialogueEvidenceSections(card);
    const missing = required.filter(section => !evidence.availableSections.includes(section));
    if (missing.length) {
      gaps.push({
        code: "character_sections_missing",
        characterId: evidence.id,
        characterName: evidence.name,
        missing,
        action: `先 get_character(view=sections, sections=${JSON.stringify(missing)}) 读取对白所需原始分区。`,
      });
    }
  }
  return gaps;
}

function buildEvidenceSources(
  project: WriterProject,
  context: ToolExecutionContext,
  targetPath: string,
  memory: readonly WritingMemoryEntry[],
): NarrativeEvidenceSource[] {
  const sources = new Map<string, NarrativeEvidenceSource>();
  const add = (
    path: string,
    kind: NarrativeEvidenceSource["kind"],
    ranges: Array<{ startLine: number; endLine: number; content: string }>,
    sourceHash?: string,
  ) => {
    if (!path || project.isDocumentHidden(path)) return;
    const content = context.workingTextFiles?.get(path)?.content
      ?? (project.textFileExists(path) ? project.readTextFile(path) : "");
    if (!content) return;
    const hash = project.hash(content);
    if (sourceHash && sourceHash !== hash) return;
    if (!sources.has(path) && sources.size >= MAX_SOURCES) return;
    const current = sources.get(path) ?? {
      id: sourceId(path, hash), path, sourceHash: hash, kind, excerpts: [],
    };
    for (const range of ranges) {
      if (!range.content.trim()) continue;
      if (current.excerpts.some(item => item.startLine === range.startLine && item.endLine === range.endLine)) continue;
      current.excerpts.push(range);
    }
    sources.set(path, current);
  };

  // Narrative boundaries and session memory evidence are admitted before
  // them before opportunistic reads so a large research pass cannot evict them.
  addNarrativeBoundaries(project, context, targetPath, add);
  for (const entry of memory) {
    if (!entry.sourcePath || !entry.sourceEvidence) continue;
    const content = project.textFileExists(entry.sourcePath) ? project.readTextFile(entry.sourcePath) : "";
    if (!content) continue;
    const offset = content.indexOf(entry.sourceEvidence);
    if (offset < 0) continue;
    const startLine = content.slice(0, offset).split(/\r?\n/u).length;
    const endLine = content.slice(0, offset + entry.sourceEvidence.length).split(/\r?\n/u).length;
    add(entry.sourcePath, "memory", [{ startLine, endLine, content: entry.sourceEvidence }], entry.sourceHash || undefined);
  }

  let excerptCharacters = 0;
  let readSources = 0;
  for (const [path, snapshot] of context.readSnapshots ?? []) {
    if (readSources >= MAX_READ_SOURCES || excerptCharacters >= MAX_EXCERPT_CHARACTERS) break;
    const content = context.workingTextFiles?.get(path)?.content
      ?? (project.textFileExists(path) ? project.readTextFile(path) : "");
    if (!content || project.hash(content) !== snapshot.sourceHash) continue;
    const lines = content.split(/\r?\n/u);
    const ranges = snapshot.ranges.flatMap(range => {
      if (excerptCharacters >= MAX_EXCERPT_CHARACTERS) return [];
      const remaining = MAX_EXCERPT_CHARACTERS - excerptCharacters;
      const excerpt = lines.slice(Math.max(0, range.startLine - 1), range.endLine).join("\n").slice(0, remaining);
      excerptCharacters += excerpt.length;
      return excerpt.trim() ? [{ startLine: range.startLine, endLine: range.endLine, content: excerpt }] : [];
    });
    if (!ranges.length) continue;
    add(path, "read", ranges, snapshot.sourceHash);
    readSources += 1;
  }

  return [...sources.values()];
}

function addNarrativeBoundaries(
  project: WriterProject,
  context: ToolExecutionContext,
  targetPath: string,
  add: (path: string, kind: NarrativeEvidenceSource["kind"], ranges: Array<{ startLine: number; endLine: number; content: string }>, sourceHash?: string) => void,
): void {
  const targetContent = context.workingTextFiles?.get(targetPath)?.content
    ?? (project.textFileExists(targetPath) ? project.readTextFile(targetPath) : "");
  if (targetContent) add(targetPath, "target", tailRange(targetContent, 4_000));
  const chapters = orderedChapterPaths(project);
  const index = chapters.indexOf(targetPath);
  const previous = index > 0 ? chapters[index - 1] : (!targetContent ? chapters.at(-1) : undefined);
  const next = index >= 0 && index + 1 < chapters.length ? chapters[index + 1] : undefined;
  if (previous && previous !== targetPath) add(previous, "previous_boundary", tailRange(project.readTextFile(previous), 4_000));
  if (next && next !== targetPath) add(next, "next_boundary", headRange(project.readTextFile(next), 2_000));
}

function tailRange(content: string, maxCharacters: number) {
  const lines = content.split(/\r?\n/u);
  let start = lines.length - 1;
  let text = lines[start] ?? "";
  while (start > 0 && text.length < maxCharacters) {
    start -= 1;
    text = `${lines[start]}\n${text}`;
  }
  return [{ startLine: start + 1, endLine: lines.length, content: text.slice(-maxCharacters) }];
}

function headRange(content: string, maxCharacters: number) {
  const selected = content.slice(0, maxCharacters);
  return [{ startLine: 1, endLine: selected.split(/\r?\n/u).length, content: selected }];
}

function sourceId(path: string, sourceHash: string): string {
  return `src-${createHash("sha256").update(`${path}\0${sourceHash}`).digest("hex").slice(0, 12)}`;
}

function hashNarrativeEvidence(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
