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
};

const MAX_SCENES = 8;
const MAX_SCENE_CHARACTERS = 12_000;

export function beginChapterSceneDraft(input: BeginChapterSceneDraftInput): ChapterSceneDraft {
  const heading = cleanString(input.heading);
  if (input.mode !== "append" && !heading) throw new Error("新建或全文重写章节时必须提供 heading");
  if (!Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > MAX_SCENES) {
    throw new Error(`场景链须包含 1—${MAX_SCENES} 个场景；通常 3—6 个，但不要为凑数拆场`);
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
  if (/^#\s+/mu.test(trimmed)) throw new Error("场景正文不要包含章节一级标题；标题由章节草稿统一组装");
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
    return `${separator}${completed.content}`;
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
