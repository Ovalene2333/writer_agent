import type { Character } from "../types.js";
import type { ToolHandlerArgs } from "./types.js";
import { assertWritableMode, optionalPositiveInteger, requireString } from "./helpers.js";

export function handleListCharacters({ store, characterScope }: ToolHandlerArgs): string {
  const allowedIds = characterScope === undefined ? undefined : new Set(characterScope);
  return JSON.stringify(store.characters().filter(c => !allowedIds || allowedIds.has(c.id)).map((c) => ({
    id: c.id, name: c.name, narrativeRole: c.narrativeRole, identity: c.identity, aliases: c.aliases,
    appearance: c.appearance.slice(0, 80),
    relationships: c.relationships,
  })));
}

export function handleGetCharacter({ input, store, characterScope }: ToolHandlerArgs): string {
  const id = optionalPositiveInteger(input.id, "id");
  if (!id) throw new Error("缺少有效参数：id");
  if (characterScope !== undefined && !characterScope.includes(id)) {
    throw new Error("该角色不在本次可读范围内（范围只限制读取已有卡；若需新人设请用 save_character 省略 id 新建）");
  }
  const character = store.characters().find(item => item.id === id);
  if (!character) throw new Error("角色不存在");
  const allowedFields = new Set([
    "aliases", "narrativeRole", "identity", "appearance", "personality", "values", "speechStyle", "background",
    "longTermGoal", "currentGoal", "fears", "capabilities", "limitations", "relationships", "notes",
  ]);
  const requestedFields = Array.isArray(input.fields)
    ? [...new Set(input.fields.filter((field): field is string => typeof field === "string" && allowedFields.has(field)))]
    : [];
  if (!requestedFields.length) return JSON.stringify(character);
  const selected: Record<string, unknown> = { id: character.id, name: character.name };
  const values = character as unknown as Record<string, unknown>;
  for (const field of requestedFields) selected[field] = values[field];
  return JSON.stringify(selected);
}

export function handleSaveCharacter({ input, store, characterScope, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "save_character");
  const characterId = typeof input.id === "number" && Number.isInteger(input.id) && input.id > 0 ? input.id : undefined;
  const existing = characterId ? store.characters().find(item => item.id === characterId) : undefined;
  if (characterId && !existing) throw new Error("要修改的角色不存在");
  if (characterId && characterScope !== undefined && !characterScope.includes(characterId)) {
    throw new Error("不能修改范围外的已有角色卡；新建请省略 id");
  }
  const value = (field: keyof Character, fallback = "") =>
    typeof input[field] === "string" ? input[field] as string : existing && typeof existing[field] === "string" ? existing[field] as string : fallback;
  const character = store.saveCharacter({
    id: characterId,
    name: requireString(input.name, "name"),
    aliases: Array.isArray(input.aliases) ? input.aliases.filter((v): v is string => typeof v === "string") : existing?.aliases ?? [],
    schemaVersion: 2,
    narrativeRole: value("narrativeRole"), identity: value("identity"), appearance: value("appearance"),
    personality: value("personality"), values: value("values"), speechStyle: value("speechStyle"),
    background: value("background"), longTermGoal: value("longTermGoal"), currentGoal: value("currentGoal"), fears: value("fears"),
    relationships: Array.isArray(input.relationships) ? input.relationships.flatMap(value => {
      if (!value || typeof value !== "object") return [];
      const relation = value as Record<string, unknown>;
      const relatedId = Number(relation.characterId);
      if (!Number.isInteger(relatedId) || (characterScope && !characterScope.includes(relatedId))) return [];
      return [{ characterId: relatedId, type: String(relation.type ?? ""), description: String(relation.description ?? ""), attitude: String(relation.attitude ?? "") }];
    }) : existing?.relationships ?? [],
    capabilities: value("capabilities"), limitations: value("limitations"), notes: value("notes"),
  });
  if (!characterId && characterScope && !characterScope.includes(character.id)) {
    characterScope.push(character.id);
  }
  return JSON.stringify({
    id: character.id,
    name: character.name,
    message: characterId ? "角色卡已更新" : "角色卡已新建；本轮可继续 get_character 读取该 ID",
    created: !characterId,
  });
}
