import { resolveCharacterAt, type CharacterInput, type CharacterSection } from "../characters.js";
import { OutlineStore } from "../outline.js";
import type { ToolHandlerArgs } from "./types.js";
import { assertWritableMode, optionalPositiveInteger } from "./helpers.js";

const SECTIONS = new Set<CharacterSection>(["identity", "profile", "psychology", "motivations", "voice", "competencies", "relationships", "storyState", "notes"]);

export function handleListCharacters({ store, characterScope }: ToolHandlerArgs): string {
  const allowed = characterScope === undefined ? undefined : new Set(characterScope);
  return JSON.stringify(store.characters().filter(c => !allowed || allowed.has(c.id)).map(c => ({
    id: c.id, name: c.identity.name, aliases: c.identity.aliases,
    narrativeRole: c.identity.narrativeRole, summary: c.identity.summary, tags: c.identity.tags,
  })));
}

export function handleGetCharacter({ input, store, project, characterScope }: ToolHandlerArgs): string {
  const id = optionalPositiveInteger(input.id, "id");
  if (!id) throw new Error("缺少有效参数：id");
  if (characterScope !== undefined && !characterScope.includes(id)) throw new Error("该角色不在本次可读范围内");
  const character = store.characters().find(item => item.id === id);
  if (!character) throw new Error("角色不存在");
  const sections = Array.isArray(input.sections) ? [...new Set(input.sections.filter((x): x is CharacterSection => typeof x === "string" && SECTIONS.has(x as CharacterSection)))] : [];
  if (!sections.length) return JSON.stringify(character);
  const selected: Record<string, unknown> = { id: character.id, name: character.identity.name };
  for (const section of sections) {
    if (section === "storyState") {
      const nodes = new OutlineStore(project).sync().nodes;
      selected.storyState = resolveCharacterAt(character, nodes, typeof input.outlineNodeId === "string" ? input.outlineNodeId : undefined);
    } else selected[section] = character[section];
  }
  return JSON.stringify(selected);
}

export function handleSaveCharacter({ input, store, characterScope, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "save_character");
  const id = typeof input.id === "number" && Number.isInteger(input.id) && input.id > 0 ? input.id : undefined;
  const existing = id ? store.characters().find(item => item.id === id) : undefined;
  if (id && !existing) throw new Error("要修改的角色不存在");
  if (id && characterScope !== undefined && !characterScope.includes(id)) throw new Error("不能修改范围外的已有角色卡；新建请省略 id");
  const identity = input.identity && typeof input.identity === "object" && !Array.isArray(input.identity) ? input.identity as CharacterInput["identity"] : undefined;
  if (!existing && !identity?.name?.trim()) throw new Error("新建角色必须提供 identity.name");
  if (Array.isArray(input.relationships)) for (const value of input.relationships) {
    const target = Number(value && typeof value === "object" ? (value as { characterId?: unknown }).characterId : NaN);
    if (characterScope && !characterScope.includes(target)) throw new Error(`关系目标 ${target} 不在本次可读范围内`);
  }
  const character = store.saveCharacter({ ...(input as CharacterInput), id, identity });
  if (!id && characterScope && !characterScope.includes(character.id)) characterScope.push(character.id);
  return JSON.stringify({ id: character.id, name: character.identity.name, message: id ? "角色卡已更新" : "角色卡已新建；本轮可继续读取该 ID", created: !id });
}
