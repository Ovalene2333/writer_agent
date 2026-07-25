export type ChapterDraftMode = "create" | "replace" | "append";

export type ChapterSceneCard = {
  id: string;
  title: string;
  goal: string;
  entryState: string[];
  characterIntent: string[];
  obstacle: string;
  turn: string;
  outcome: string;
  handoff: string;
  dividerBefore: boolean;
  targetCharacters?: number;
};

export type SceneActualState = {
  situation: string[];
  physical: string[];
  knowledge: string[];
  relationships: string[];
  goals: string[];
  openLoops: string[];
  usedMotifs: string[];
};

export type CompletedChapterScene = {
  sceneId: string;
  content: string;
  actualState: SceneActualState;
};

export type ChapterDraftStyleEdit = {
  search: string;
  replace: string;
};

export type ChapterSceneGuideRevision = {
  draft: ChapterSceneDraft;
  addedSceneIds: string[];
  removedSceneIds: string[];
};

export type ChapterSceneDraft = {
  path: string;
  mode: ChapterDraftMode;
  heading: string;
  chapterGoal: string;
  baseContent: string;
  baseHash: string;
  scenes: ChapterSceneCard[];
  completed: CompletedChapterScene[];
  version: number;
  inspectedVersion?: number;
};

export type BeginChapterSceneDraftInput = {
  path: string;
  mode: ChapterDraftMode;
  heading?: string;
  chapterGoal: string;
  baseContent: string;
  baseHash: string;
  scenes: unknown[];
  maxScenes?: number;
};

const DEFAULT_MAX_SCENES = 5;
export const MAX_SCENE_CHARACTERS = 12_000;

export function beginChapterSceneDraft(input: BeginChapterSceneDraftInput): ChapterSceneDraft {
  const heading = cleanString(input.heading);
  const maxScenes = Number.isInteger(input.maxScenes) ? Math.min(8, Math.max(1, Number(input.maxScenes))) : DEFAULT_MAX_SCENES;
  if (input.mode !== "append" && !heading) throw new Error("新建或全文重写章节时必须提供 heading");
  if (!Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > maxScenes) {
    throw new Error(`场景链须包含 1—${maxScenes} 个场景；不要为凑数拆场`);
  }
  const scenes = input.scenes.map((raw, index) => normalizeSceneCard(raw, index));
  const ids = new Set(scenes.map(scene => scene.id));
  if (ids.size !== scenes.length) throw new Error("场景 id 必须唯一");
  const repeated = repeatedExactSceneFunctions(scenes);
  if (repeated.length) throw new Error(`场景链存在功能完全重复的场景：${repeated.join("、")}`);
  for (let index = 0; index < scenes.length - 1; index += 1) {
    if (!scenes[index].handoff) throw new Error(`scenes[${index}].handoff 不能为空；须说明如何因果交给下一场`);
  }
  return {
    path: input.path,
    mode: input.mode,
    heading,
    chapterGoal: requireText(input.chapterGoal, "chapterGoal"),
    baseContent: input.baseContent,
    baseHash: input.baseHash,
    scenes,
    completed: [],
    version: 0,
  };
}

export function writeChapterScene(
  draft: ChapterSceneDraft,
  sceneId: string,
  content: string,
  actualStateValue: unknown,
): { draft: ChapterSceneDraft; invalidatedSceneIds: string[]; revised: boolean } {
  const index = draft.scenes.findIndex(scene => scene.id === sceneId);
  if (index < 0) throw new Error(`场景不存在：${sceneId}`);
  if (index > draft.completed.length) {
    throw new Error(`必须按场景链顺序写作；下一场应为 ${draft.scenes[draft.completed.length]?.id ?? "（已完成）"}`);
  }
  const trimmed = content.trim();
  if (trimmed.length < 80) throw new Error("场景正文过短；如果本场确实不产生局面变化，应合并而不是保留空壳场景");
  if (trimmed.length > MAX_SCENE_CHARACTERS) throw new Error(`单场正文超过 ${MAX_SCENE_CHARACTERS} 字，请收紧场景边界`);
  if (/^#{1,6}\s/mu.test(trimmed)) throw new Error("场景正文不要包含任何 markdown 标题；章节标题与每场的 ## 场景小标题（取场景卡 title）都由组装自动生成");
  const actualState = normalizeActualState(actualStateValue);
  if (!hasMaterialStateChange(actualState)) {
    throw new Error("actualState 至少记录一项实际局面变化（situation/physical/knowledge/relationships/goals）");
  }

  const revised = index < draft.completed.length;
  const invalidatedSceneIds = revised ? draft.completed.slice(index + 1).map(scene => scene.sceneId) : [];
  const completed = draft.completed.slice(0, index);
  completed.push({ sceneId, content: trimmed, actualState });
  return {
    draft: {
      ...draft,
      completed,
      version: draft.version + 1,
      inspectedVersion: undefined,
    },
    invalidatedSceneIds,
    revised,
  };
}

/**
 * Replace only the unwritten scene guide. Completed prose remains the source of
 * truth; the Agent may reshape what comes next as actual scene outcomes emerge.
 */
export function reviseChapterSceneGuide(
  draft: ChapterSceneDraft,
  remainingScenesValue: unknown,
  maxScenes = DEFAULT_MAX_SCENES,
): ChapterSceneGuideRevision {
  if (!Array.isArray(remainingScenesValue)) throw new Error("remainingScenes 必须是数组");
  const limit = Number.isInteger(maxScenes) ? Math.min(8, Math.max(1, maxScenes)) : DEFAULT_MAX_SCENES;
  const completedCount = draft.completed.length;
  if (completedCount + remainingScenesValue.length < 1) throw new Error("正文尚未写入，场景引导不能为空");
  if (completedCount + remainingScenesValue.length > limit) {
    throw new Error(`已完成场景与剩余引导合计不能超过 ${limit} 场`);
  }

  const completedCards = draft.scenes.slice(0, completedCount);
  const previousPending = draft.scenes.slice(completedCount);
  const remaining = remainingScenesValue.map((raw, index) => normalizeSceneCard(raw, completedCount + index));
  const scenes = [...completedCards, ...remaining];
  const ids = new Set(scenes.map(scene => scene.id));
  if (ids.size !== scenes.length) throw new Error("已完成场景与剩余引导的 id 必须唯一");
  const repeated = repeatedExactSceneFunctions(scenes);
  if (repeated.length) throw new Error(`场景引导存在功能完全重复的场景：${repeated.join("、")}`);
  for (let index = 0; index < remaining.length - 1; index += 1) {
    if (!remaining[index].handoff) throw new Error(`remainingScenes[${index}].handoff 不能为空；须说明如何因果交给下一场`);
  }

  const previousIds = new Set(previousPending.map(scene => scene.id));
  const nextIds = new Set(remaining.map(scene => scene.id));
  return {
    draft: {
      ...draft,
      scenes,
      version: draft.version + 1,
      inspectedVersion: undefined,
    },
    addedSceneIds: remaining.filter(scene => !previousIds.has(scene.id)).map(scene => scene.id),
    removedSceneIds: previousPending.filter(scene => !nextIds.has(scene.id)).map(scene => scene.id),
  };
}

/**
 * Apply exact, prose-only edits without changing scene state or invalidating the
 * causal scene chain. Each search must identify exactly one existing passage.
 */
export function reviseChapterDraftStyle(
  draft: ChapterSceneDraft,
  editsValue: unknown,
): { draft: ChapterSceneDraft; editedSceneIds: string[]; preservedSceneIds: string[] } {
  if (!chapterSceneDraftComplete(draft)) throw new Error("场景链尚未完成，不能进行整章风格修订");
  if (!Array.isArray(editsValue) || editsValue.length < 1 || editsValue.length > 20) {
    throw new Error("风格修订须包含 1–20 条精确替换");
  }

  let completed = draft.completed.map(scene => ({ ...scene }));
  const editedSceneIds = new Set<string>();
  for (const [editIndex, raw] of editsValue.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`edits[${editIndex}] 格式无效`);
    }
    const edit = raw as Record<string, unknown>;
    const search = typeof edit.search === "string" ? edit.search : "";
    const replace = typeof edit.replace === "string" ? edit.replace : undefined;
    if (!search) throw new Error(`edits[${editIndex}].search 不能为空`);
    if (replace === undefined) throw new Error(`edits[${editIndex}].replace 必须是字符串`);
    if (search.length > 2_000 || replace.length > 2_000) {
      throw new Error(`edits[${editIndex}] 过长；风格修订只允许局部替换`);
    }

    const matches = completed.flatMap((scene, sceneIndex) =>
      occurrenceOffsets(scene.content, search).map(offset => ({ sceneIndex, offset })),
    );
    if (matches.length !== 1) {
      throw new Error(`edits[${editIndex}].search 在草稿中出现 ${matches.length} 次，必须唯一`);
    }
    const { sceneIndex, offset } = matches[0];
    const scene = completed[sceneIndex];
    const content = scene.content.slice(0, offset) + replace + scene.content.slice(offset + search.length);
    if (content.trim().length < 80) throw new Error(`edits[${editIndex}] 会使场景正文过短`);
    if (/^#{1,6}\s/mu.test(content)) throw new Error(`edits[${editIndex}] 不得向场景正文加入 markdown 标题（小标题由组装自动生成）`);
    completed[sceneIndex] = { ...scene, content };
    editedSceneIds.add(scene.sceneId);
  }

  return {
    draft: {
      ...draft,
      completed,
      version: draft.version + 1,
      inspectedVersion: undefined,
    },
    editedSceneIds: [...editedSceneIds],
    preservedSceneIds: completed.filter(scene => !editedSceneIds.has(scene.sceneId)).map(scene => scene.sceneId),
  };
}

export function nextChapterScene(draft: ChapterSceneDraft): ChapterSceneCard | undefined {
  return draft.scenes[draft.completed.length];
}

export function chapterSceneDraftComplete(draft: ChapterSceneDraft): boolean {
  return draft.completed.length === draft.scenes.length;
}

export function assembleChapterSceneDraft(draft: ChapterSceneDraft): string {
  const sceneBodies = draft.completed.map((completed, index) => {
    const hasEarlierBody = index > 0 || (draft.mode === "append" && Boolean(draft.baseContent.trim()));
    const separator = hasEarlierBody && draft.scenes[index].dividerBefore ? "---\n\n" : "";
    // Scene-card title as a deterministic "## " anchor: structures the chapter for
    // block-level reads/patches without asking the model to author headings.
    const heading = `## ${draft.scenes[index].title}\n\n`;
    return `${separator}${heading}${completed.content}`;
  }).join("\n\n");
  if (draft.mode === "append") {
    return [draft.baseContent.trimEnd(), sceneBodies].filter(Boolean).join("\n\n");
  }
  return [`# ${draft.heading}`, sceneBodies].filter(Boolean).join("\n\n");
}

export function chapterSceneLedger(draft: ChapterSceneDraft): Array<{
  sceneId: string;
  title: string;
  plannedTurn: string;
  plannedOutcome: string;
  actualState: SceneActualState;
}> {
  return draft.completed.map((completed, index) => ({
    sceneId: completed.sceneId,
    title: draft.scenes[index].title,
    plannedTurn: draft.scenes[index].turn,
    plannedOutcome: draft.scenes[index].outcome,
    actualState: completed.actualState,
  }));
}

export function sceneCardForTool(scene: ChapterSceneCard | undefined): ChapterSceneCard | null {
  return scene ?? null;
}

function normalizeSceneCard(raw: unknown, index: number): ChapterSceneCard {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`scenes[${index}] 格式无效`);
  const value = raw as Record<string, unknown>;
  const target = value.targetCharacters;
  const targetCharacters = target === undefined ? undefined : Number(target);
  if (targetCharacters !== undefined && (!Number.isInteger(targetCharacters) || targetCharacters < 200 || targetCharacters > 8_000)) {
    throw new Error(`scenes[${index}].targetCharacters 须为 200—8000 的整数`);
  }
  return {
    id: requireText(value.id, `scenes[${index}].id`).slice(0, 64),
    title: cleanString(value.title).slice(0, 80) || `场景 ${index + 1}`,
    goal: requireText(value.goal, `scenes[${index}].goal`),
    entryState: stringList(value.entryState, `scenes[${index}].entryState`),
    characterIntent: stringList(value.characterIntent, `scenes[${index}].characterIntent`),
    obstacle: requireText(value.obstacle, `scenes[${index}].obstacle`),
    turn: requireText(value.turn, `scenes[${index}].turn`),
    outcome: requireText(value.outcome, `scenes[${index}].outcome`),
    handoff: cleanString(value.handoff),
    dividerBefore: value.dividerBefore === true,
    ...(targetCharacters === undefined ? {} : { targetCharacters }),
  };
}

function normalizeActualState(raw: unknown): SceneActualState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("actualState 格式无效");
  const value = raw as Record<string, unknown>;
  return {
    situation: stringList(value.situation, "actualState.situation"),
    physical: stringList(value.physical, "actualState.physical"),
    knowledge: stringList(value.knowledge, "actualState.knowledge"),
    relationships: stringList(value.relationships, "actualState.relationships"),
    goals: stringList(value.goals, "actualState.goals"),
    openLoops: stringList(value.openLoops, "actualState.openLoops"),
    usedMotifs: stringList(value.usedMotifs, "actualState.usedMotifs"),
  };
}

function hasMaterialStateChange(state: SceneActualState): boolean {
  return state.situation.length + state.physical.length + state.knowledge.length
    + state.relationships.length + state.goals.length > 0;
}

function repeatedExactSceneFunctions(scenes: ChapterSceneCard[]): string[] {
  const seen = new Map<string, string>();
  const repeated: string[] = [];
  for (const scene of scenes) {
    const signature = [scene.goal, scene.turn, scene.outcome].map(value => value.trim()).join("\n");
    const prior = seen.get(signature);
    if (prior) repeated.push(`${prior}/${scene.id}`);
    else seen.set(signature, scene.id);
  }
  return repeated;
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} 必须是字符串数组`);
  return value.slice(0, 20).map((item, index) => requireText(item, `${name}[${index}]`)).filter(Boolean);
}

function requireText(value: unknown, name: string): string {
  const text = cleanString(value);
  if (!text) throw new Error(`缺少有效参数：${name}`);
  return text;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function occurrenceOffsets(content: string, search: string): number[] {
  const offsets: number[] = [];
  let from = 0;
  while (from <= content.length - search.length) {
    const index = content.indexOf(search, from);
    if (index < 0) break;
    offsets.push(index);
    from = index + Math.max(1, search.length);
  }
  return offsets;
}
