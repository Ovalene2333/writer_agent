import {
  characterPromptCard,
  competencyPromptView,
  normalizeCharacterChangeOp,
  resolveCharacterAt,
  type ApplyCharacterChangesInput,
  type CharacterInput,
  type CharacterSection,
} from "../characters.js";
import type { CharacterSourceRef } from "../types.js";
import { OutlineStore } from "../outline.js";
import type { ToolHandlerArgs } from "./types.js";
import { assertWritableMode, optionalPositiveInteger, requireString } from "./helpers.js";

const SECTIONS = new Set<CharacterSection>([
  "identity",
  "profile",
  "psychology",
  "motivations",
  "voice",
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
    aliases: c.identity.aliases,
    narrativeRole: c.identity.narrativeRole,
    summary: c.identity.summary,
    tags: c.identity.tags,
  })));
}

export function handleGetCharacter({ input, store, project, characterScope }: ToolHandlerArgs): string {
  const id = optionalPositiveInteger(input.id, "id");
  if (!id) throw new Error("缺少有效参数：id");
  if (characterScope !== undefined && !characterScope.includes(id)) throw new Error("该角色不在本次可读范围内");
  const character = store.characters().find(item => item.id === id);
  if (!character) throw new Error("角色不存在");
  const sections = Array.isArray(input.sections)
    ? [...new Set(input.sections.filter((x): x is CharacterSection => typeof x === "string" && SECTIONS.has(x as CharacterSection)))]
    : [];
  if (!sections.length) return JSON.stringify(characterPromptCard(character));
  const outlineNodeId = typeof input.outlineNodeId === "string" ? input.outlineNodeId : undefined;
  const needsScene = sections.includes("storyState")
    || (Boolean(outlineNodeId) && (sections.includes("experiences") || sections.includes("psychology")));
  const scene = needsScene
    ? resolveCharacterAt(character, new OutlineStore(project).sync().nodes, outlineNodeId)
    : undefined;
  const selected: Record<string, unknown> = { id: character.id, name: character.identity.name };
  for (const section of sections) {
    if (section === "storyState") {
      selected.storyState = scene ?? resolveCharacterAt(character, new OutlineStore(project).sync().nodes, outlineNodeId);
    } else if (section === "competencies") {
      selected.competencies = character.competencies.map(competencyPromptView);
    } else if (section === "experiences") {
      selected.experiences = scene && outlineNodeId ? scene.experiences : character.experiences;
    } else if (section === "psychology") {
      selected.psychology = scene && outlineNodeId ? scene.psychology : character.psychology;
    } else {
      selected[section] = character[section];
    }
  }
  return JSON.stringify(selected);
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

export function handleSaveCharacter({ input, store, characterScope, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "save_character");
  const id = typeof input.id === "number" && Number.isInteger(input.id) && input.id > 0 ? input.id : undefined;
  const existing = id ? store.characters().find(item => item.id === id) : undefined;
  if (id && !existing) throw new Error("要修改的角色不存在");
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
  const character = store.saveCharacter({ ...(input as CharacterInput), id, identity });
  if (!id && characterScope && !characterScope.includes(character.id)) characterScope.push(character.id);
  return JSON.stringify({
    id: character.id,
    name: character.identity.name,
    message: id ? "角色卡已更新" : "角色卡已新建；本轮可继续读取该 ID",
    created: !id,
  });
}

function parseSourceRef(value: unknown): CharacterSourceRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const type = r.type;
  const ref = typeof r.ref === "string" ? r.ref.trim() : "";
  if (!(type === "outline" || type === "document" || type === "manual") || !ref) return undefined;
  const note = typeof r.note === "string" ? r.note.trim() : "";
  return { type, ref, ...(note ? { note } : {}) };
}

export function handleApplyCharacterChanges({ input, store, characterScope, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "apply_character_changes");
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

  const sourceRef = parseSourceRef(input.sourceRef);
  const payload: ApplyCharacterChangesInput = {
    reason,
    ...(sourceRef ? { sourceRef } : {}),
    changes: changes
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map(item => ({ op: String((item as { op?: unknown }).op ?? ""), ...item })),
  };
  const result = store.applyCharacterChanges(id, payload);
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
