import {
  characterSummaryCard,
  competenciesWritingPayload,
  normalizeCharacterChangeOp,
  resolveCharacterAt,
  type ApplyCharacterChangesInput,
  type CharacterInput,
  type CharacterSection,
} from "../characters.js";
import { OutlineStore } from "../outline.js";
import {
  competencyUsePolicy,
  resolveCompetencyStates,
  type SceneCompetencyUse,
} from "../competency_state.js";
import { recordCharacterEvidenceRead } from "../narrative_evidence.js";
import type { ToolHandlerArgs } from "./types.js";
import { assertWritableMode, optionalPositiveInteger, requireString } from "./helpers.js";

const SECTIONS = new Set<CharacterSection>([
  "identity",
  "profile",
  "psychology",
  "motivations",
  "voice",
  "features",
  "competencies",
  "relationships",
  "storyState",
  "experiences",
  "notes",
]);

export function handleListCharacters({ store, characterScope }: ToolHandlerArgs): string {
  const allowed = characterScope === undefined ? undefined : new Set(characterScope);
  return JSON.stringify(store.characters().filter(c => !allowed || allowed.has(c.id)).map(c => ({
    id: c.id,
    name: c.identity.name,
    updatedAt: c.updatedAt,
    aliases: c.identity.aliases,
    narrativeRole: c.identity.narrativeRole,
    summary: c.identity.summary,
    tags: c.identity.tags,
    sections: {
      identity: true,
      profile: Boolean(c.profile.appearance || c.profile.appearanceSummary || c.profile.background || c.profile.backgroundSummary || c.profile.biography),
      psychology: c.psychology.traits.length + c.psychology.values.length + c.psychology.fears.length + c.psychology.conflicts.length,
      motivations: c.motivations.length,
      voice: Boolean(c.voice.summary || c.voice.register || c.voice.diction.length || c.voice.verbalHabits.length || c.voice.examples.length),
      features: c.features.length,
      competencies: c.competencies.length,
      relationships: c.relationships.length,
      storyStates: c.storyStates.length,
      experiences: c.experiences.length,
      notes: Boolean(c.notes),
    },
  })));
}

export function handleGetCharacter({ input, store, project, characterScope, context }: ToolHandlerArgs): string {
  const id = optionalPositiveInteger(input.id, "id");
  if (!id) throw new Error("缺少有效参数：id");
  if (characterScope !== undefined && !characterScope.includes(id)) throw new Error("该角色不在本次可读范围内");
  const character = store.characters().find(item => item.id === id);
  if (!character) throw new Error("角色不存在");
  const sections = Array.isArray(input.sections)
    ? [...new Set(input.sections.filter((x): x is CharacterSection => typeof x === "string" && SECTIONS.has(x as CharacterSection)))]
    : [];
  const explicitView = typeof input.view === "string" ? input.view : undefined;
  if (explicitView && !["summary", "sections", "edit"].includes(explicitView)) {
    throw new Error("view 必须是 summary、sections 或 edit");
  }
  const view = explicitView ?? (sections.length ? "sections" : "summary");
  const requestedCompetencyIds = parseCompetencyIds(input.competencyIds);
  const outlineNodeId = typeof input.outlineNodeId === "string" ? input.outlineNodeId : undefined;
  const outlineNodes = new OutlineStore(project).sync().nodes;
  const activePath = context.chapterSceneDraft?.path;
  const effectiveOutlineNodeId = outlineNodeId ?? (activePath
    ? outlineNodes.filter(node => node.documentPath === activePath).sort((a, b) => b.order - a.order)[0]?.id
    : undefined);
  if (requestedCompetencyIds && !sections.includes("competencies")) {
    throw new Error("competencyIds 只能与 competencies 分区一起读取");
  }
  if (view === "summary") {
    if (sections.length || requestedCompetencyIds) throw new Error("summary 视图不能指定 sections 或 competencyIds");
    return JSON.stringify(characterSummaryCard(character, outlineNodes, effectiveOutlineNodeId));
  }
  if (view === "edit" && !sections.length) return JSON.stringify(character);
  if (!sections.length) throw new Error("sections 视图必须指定至少一个分区");
  const needsScene = sections.includes("storyState")
    || (Boolean(outlineNodeId) && (sections.includes("experiences") || sections.includes("psychology")));
  const scene = needsScene
    ? resolveCharacterAt(character, outlineNodes, effectiveOutlineNodeId)
    : undefined;
  const selected: Record<string, unknown> = {
    id: character.id,
    name: character.identity.name,
    updatedAt: character.updatedAt,
  };
  let resolvedCompetencyIds: string[] = [];
  for (const section of sections) {
    if (section === "storyState") {
      selected.storyState = scene ?? resolveCharacterAt(character, outlineNodes, effectiveOutlineNodeId);
    } else if (section === "competencies") {
      if (view === "edit") {
        assertKnownCompetencyIds(character.competencies, requestedCompetencyIds);
        selected.competencies = requestedCompetencyIds
          ? character.competencies.filter(item => requestedCompetencyIds.includes(item.id))
          : character.competencies;
      } else {
        const selectedUses = resolvedWritingCompetencyUses(character, requestedCompetencyIds, context);
        const selectedIds = selectedUses.map(use => use.competencyId);
        const states = resolveCompetencyStates(character, outlineNodes, effectiveOutlineNodeId);
        assertUsableCompetencyUses(character.competencies, states, selectedUses);
        resolvedCompetencyIds = selectedIds;
        selected.competencies = competenciesWritingPayload(character.competencies, selectedIds, states, selectedUses);
      }
    } else if (section === "voice" && view !== "edit") {
      assertSceneDialogueScope(character.id, context);
      const dialogueEvidenceCharacterIds = context.dialogueEvidenceCharacterIds
        ?? (context.dialogueEvidenceCharacterIds = []);
      if (!dialogueEvidenceCharacterIds.includes(character.id)) dialogueEvidenceCharacterIds.push(character.id);
      selected.voice = character.voice;
      selected.voiceScope = {
        characterId: character.id,
        name: character.identity.name,
        appliesTo: "spoken_dialogue_only",
        rule: "仅约束该角色说出口的对白；不要迁移到叙述、动作描写或其他角色的对白。",
      };
    } else if (section === "experiences") {
      selected.experiences = scene && outlineNodeId ? scene.experiences : character.experiences;
    } else if (section === "psychology") {
      selected.psychology = scene && outlineNodeId ? scene.psychology : character.psychology;
    } else {
      selected[section] = character[section];
    }
  }
  if (view === "sections") {
    recordCharacterEvidenceRead(context, character.id, sections, resolvedCompetencyIds);
  }
  return JSON.stringify(selected);
}

function parseCompetencyIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw new Error("competencyIds 须为 1—12 个能力 ID");
  }
  const ids = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.trim().length > 128) {
      throw new Error(`competencyIds[${index}] 无效`);
    }
    return item.trim();
  });
  if (new Set(ids).size !== ids.length) throw new Error("competencyIds 不能重复");
  return ids;
}

function assertKnownCompetencyIds(
  competencies: Array<{ id: string }>,
  ids: readonly string[] | undefined,
): void {
  if (!ids) return;
  const known = new Set(competencies.map(item => item.id));
  const missing = ids.filter(id => !known.has(id));
  if (missing.length) throw new Error(`角色卡不存在能力：${missing.join("、")}`);
}

function assertUsableCompetencyUses(
  competencies: Array<{ id: string; unlocked: boolean }>,
  states: ReturnType<typeof resolveCompetencyStates>,
  uses: readonly SceneCompetencyUse[],
): void {
  const ids = uses.map(use => use.competencyId);
  assertKnownCompetencyIds(competencies, ids);
  for (const use of uses) {
    const state = states.get(use.competencyId);
    const policy = competencyUsePolicy(state?.state ?? "unknown", use.mode);
    if (!policy.allowed) {
      throw new Error(`能力授权不成立：${use.competencyId}（入场状态 ${state?.state ?? "unknown"}，模式 ${use.mode}）。${policy.requirement}`);
    }
  }
}

function resolvedWritingCompetencyUses(
  character: { id: number },
  requestedIds: string[] | undefined,
  context: ToolHandlerArgs["context"],
): SceneCompetencyUse[] {
  const active = context.activeSceneCharacterScopes;
  if (!active) {
    if (!requestedIds) {
      throw new Error("正文读取 competencies 必须明确提供 competencyIds；先用 summary 的 capabilityIndex 选择，再按需读取详情");
    }
    return requestedIds.map(competencyId => ({ competencyId, mode: "use" }));
  }
  const scope = active.characterScopes.find(item => item.characterId === character.id);
  if (!scope || !scope.competencyIds.length) {
    throw new Error(`角色 ${character.id} 未获当前场景 ${active.sceneId} 的能力使用许可`);
  }
  const scopeUses = scope.competencyUses
    ?? scope.competencyIds.map(competencyId => ({ competencyId, mode: "use" as const }));
  const selectedIds = requestedIds ?? scopeUses.map(use => use.competencyId);
  const allowed = new Set(scope.competencyIds);
  const outsideScope = selectedIds.filter(id => !allowed.has(id));
  if (outsideScope.length) {
    throw new Error(`能力不在当前场景 ${active.sceneId} 的许可范围：${outsideScope.join("、")}`);
  }
  const selected = new Set(selectedIds);
  return scopeUses.filter(use => selected.has(use.competencyId));
}

function assertSceneDialogueScope(characterId: number, context: ToolHandlerArgs["context"]): void {
  const active = context.activeSceneCharacterScopes;
  if (!active) return;
  if (!active.characterScopes.some(item => item.characterId === characterId && item.dialogue)) {
    throw new Error(`角色 ${characterId} 未获当前场景 ${active.sceneId} 的对白声线许可`);
  }
}

export function handleListSimpleCharacters({ store, context }: ToolHandlerArgs): string {
  const allowed = context.simpleCharacterScope === undefined ? undefined : new Set(context.simpleCharacterScope);
  return JSON.stringify(store.roleplayInterlocutors().filter(card => !allowed || allowed.has(card.id)).map(card => ({
    id: card.id,
    name: card.name,
    identity: card.identity,
    targetCharacterId: card.targetCharacterId,
    updatedAt: card.updatedAt,
  })));
}

export function handleGetSimpleCharacter({ input, store, context }: ToolHandlerArgs): string {
  const id = optionalPositiveInteger(input.id, "id");
  if (!id) throw new Error("Missing valid simple character id");
  if (context.simpleCharacterScope !== undefined && !context.simpleCharacterScope.includes(id)) {
    throw new Error("该简易角色不在本次可读范围内");
  }
  const card = store.roleplayInterlocutors().find(item => item.id === id);
  if (!card) throw new Error("Simple character card not found");
  return JSON.stringify(card);
}

export function handleSaveCharacter({ input, store, sessionId, characterScope, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "save_character");
  const id = typeof input.id === "number" && Number.isInteger(input.id) && input.id > 0 ? input.id : undefined;
  const existing = id ? store.characters().find(item => item.id === id) : undefined;
  if (id && !existing) throw new Error("要修改的角色不存在");
  const expectedUpdatedAt = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt.trim() : "";
  if (id && !expectedUpdatedAt) throw new Error("更新已有角色卡必须提供 expectedUpdatedAt");
  if (existing && expectedUpdatedAt !== existing.updatedAt) {
    throw new Error("角色卡已被其他操作更新；请重新读取后再修改");
  }
  if (id && characterScope !== undefined && !characterScope.includes(id)) {
    throw new Error("不能修改范围外的已有角色卡；新建请省略 id");
  }
  const identity = input.identity && typeof input.identity === "object" && !Array.isArray(input.identity)
    ? input.identity as CharacterInput["identity"]
    : undefined;
  if (!existing && !identity?.name?.trim()) throw new Error("新建角色必须提供 identity.name");
  if (Array.isArray(input.relationships)) {
    for (const value of input.relationships) {
      const target = Number(value && typeof value === "object" ? (value as { characterId?: unknown }).characterId : NaN);
      if (characterScope && !characterScope.includes(target)) {
        throw new Error(`关系目标 ${target} 不在本次可读范围内`);
      }
    }
  }
  const character = context.sourceMessageId
    ? store.saveCharacterWithRevision(sessionId, context.sourceMessageId, { ...(input as CharacterInput), id, identity })
    : store.saveCharacter({ ...(input as CharacterInput), id, identity });
  if (!id && characterScope && !characterScope.includes(character.id)) characterScope.push(character.id);
  return JSON.stringify({
    id: character.id,
    name: character.identity.name,
    updatedAt: character.updatedAt,
    message: id ? "角色卡已更新" : "角色卡已新建；本轮可继续读取该 ID",
    created: !id,
  });
}

export function handleApplyCharacterChanges({ input, store, sessionId, characterScope, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "apply_character_changes");
  if (context.characterEvolutionEnabled === false) {
    throw new Error("角色演进已关闭；本轮不能自动添加角色经历或故事状态。显式角色卡编辑仍可使用 save_character");
  }
  const id = optionalPositiveInteger(input.id, "id");
  if (!id) throw new Error("缺少有效参数：id（仅可更新已有角色）");
  if (characterScope !== undefined && !characterScope.includes(id)) {
    throw new Error("不能修改范围外的已有角色卡");
  }
  const reason = requireString(input.reason, "reason");
  const changes = Array.isArray(input.changes) ? input.changes : [];
  if (!changes.length) throw new Error("缺少 changes：至少提供一条结构化变更");
  for (const raw of changes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const op = raw as Record<string, unknown>;
    if (typeof op.op === "string" && normalizeCharacterChangeOp(op.op) === "upsert_relationship") {
      const entry = op.entry && typeof op.entry === "object" && !Array.isArray(op.entry)
        ? op.entry as Record<string, unknown>
        : op;
      const target = Number(entry.characterId);
      if (characterScope && Number.isInteger(target) && !characterScope.includes(target)) {
        throw new Error(`关系目标 ${target} 不在本次可读范围内`);
      }
    }
  }

  const payload: ApplyCharacterChangesInput = {
    reason,
    changes: changes
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map(item => ({ op: String((item as { op?: unknown }).op ?? ""), ...item })),
  };
  const result = context.sourceMessageId
    ? store.applyCharacterChangesWithRevision(sessionId, context.sourceMessageId, id, payload)
    : store.applyCharacterChanges(id, payload);
  return JSON.stringify({
    id: result.character.id,
    name: result.character.identity.name,
    reason,
    applied: result.applied,
    skipped: result.skipped,
    message: result.applied.length
      ? `角色卡已演进：${result.applied.length} 项生效${result.skipped.length ? `，${result.skipped.length} 项跳过` : ""}`
      : `未应用任何变更${result.skipped.length ? `（${result.skipped.length} 项跳过）` : ""}`,
  });
}

export function handleSaveSimpleCharacter({ input, store, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "save_simple_character");
  const id = optionalPositiveInteger(input.id, "id");
  if (id && context.simpleCharacterScope !== undefined && !context.simpleCharacterScope.includes(id)) {
    throw new Error("不能修改范围外的已有简易角色卡；新建请省略 id");
  }
  const saved = store.saveRoleplayInterlocutor({
    ...(id ? { id } : {}),
    name: typeof input.name === "string" ? input.name : "",
    identity: typeof input.identity === "string" ? input.identity : "",
    relationship: typeof input.relationship === "string" ? input.relationship : "",
    knowledge: typeof input.knowledge === "string" ? input.knowledge : "",
    scene: typeof input.scene === "string" ? input.scene : "",
    goal: typeof input.goal === "string" ? input.goal : "",
  });
  if (!id && context.simpleCharacterScope && !context.simpleCharacterScope.includes(saved.id)) {
    context.simpleCharacterScope.push(saved.id);
  }
  return JSON.stringify({
    id: saved.id,
    name: saved.name,
    kind: "simple",
    message: id ? "简易角色卡已更新" : "简易角色卡已创建",
    created: !id,
  });
}
