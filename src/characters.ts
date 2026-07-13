import type { Character, CharacterCompetency, CharacterGoal, CharacterRelationship, CharacterSourceRef, CharacterStoryState, CharacterTemporal, CharacterTextEntry, OutlineNode } from "./types.js";

export type CharacterSection = "identity" | "profile" | "psychology" | "motivations" | "voice" | "competencies" | "relationships" | "storyState" | "notes";
export type CharacterArraySection = "motivations" | "competencies" | "relationships" | "storyStates";
export type CharacterInput = Partial<Omit<Character, "schemaVersion" | "id" | "updatedAt">> & { id?: number; schemaVersion?: 3; deleteEntryIds?: Partial<Record<CharacterArraySection, string[]>> };
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const temporalEmpty = (): CharacterTemporal => ({ sourceRefs: [] });
export const emptyCharacter = (name = ""): Omit<Character, "id" | "updatedAt"> => ({
  schemaVersion: 3, identity: { name, aliases: [], tags: [], narrativeRole: "", summary: "" },
  profile: { appearanceSummary: "", distinguishingFeatures: [], backgroundSummary: "", biography: "" },
  psychology: { summary: "", traits: [], values: [], fears: [], conflicts: [] }, motivations: [],
  voice: { summary: "", register: "", diction: [], verbalHabits: [], avoidedExpressions: [], examples: [] },
  competencies: [], relationships: [], storyStates: [], notes: "",
});

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const txt = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string").map(x => x.trim()).filter(Boolean);
function sourceRef(v: unknown): CharacterSourceRef[] { const r = obj(v); if (!(["outline", "document", "manual"] as unknown[]).includes(r.type) || !txt(r.ref)) return []; return [{ type: r.type as CharacterSourceRef["type"], ref: txt(r.ref), ...(txt(r.note) ? { note: txt(r.note) } : {}) }]; }
function temporal(r: Record<string, unknown>): CharacterTemporal { return { sourceRefs: arr(r.sourceRefs).flatMap(sourceRef), ...(txt(r.validFrom) ? { validFrom: txt(r.validFrom) } : {}), ...(txt(r.validUntil) ? { validUntil: txt(r.validUntil) } : {}) }; }
function entry(v: unknown): CharacterTextEntry { const r = obj(v); return { id: txt(r.id), label: txt(r.label), description: txt(r.description), ...temporal(r) }; }
function goal(v: unknown): CharacterGoal { const r = obj(v), statuses = ["active", "achieved", "abandoned", "blocked", "unknown"]; return { id: txt(r.id), category: r.category === "current" ? "current" : "longTerm", status: statuses.includes(String(r.status)) ? r.status as CharacterGoal["status"] : "unknown", priority: Number.isFinite(Number(r.priority)) ? Math.max(0, Math.min(100, Number(r.priority))) : 0, summary: txt(r.summary), stakes: txt(r.stakes), obstacles: strs(r.obstacles), ...temporal(r) }; }
function competency(v: unknown): CharacterCompetency { const r = obj(v); return { id: txt(r.id), name: txt(r.name), level: txt(r.level), description: txt(r.description), resources: strs(r.resources), limitations: strs(r.limitations), costs: strs(r.costs), ...temporal(r) }; }
function relationship(v: unknown): CharacterRelationship { const r = obj(v), statuses = ["active", "ended", "strained", "unknown"]; return { id: txt(r.id), characterId: Number(r.characterId), type: txt(r.type), attitude: txt(r.attitude), status: statuses.includes(String(r.status)) ? r.status as CharacterRelationship["status"] : "unknown", description: txt(r.description), ...temporal(r) }; }
function state(v: unknown): CharacterStoryState { const r = obj(v), node = txt(r.outlineNodeId); return { id: txt(r.id), ...(node ? { outlineNodeId: node } : {}), ...(r.unanchored === true ? { unanchored: true } : {}), location: txt(r.location), physical: txt(r.physical), emotion: txt(r.emotion), knowledge: arr(r.knowledge).map(entry), beliefs: arr(r.beliefs).map(entry), intentions: strs(r.intentions), temporaryGoals: arr(r.temporaryGoals).map(goal), notes: txt(r.notes), ...temporal(r) }; }

export function normalizeV3Character(value: unknown): Character {
  const r = obj(value), i = obj(r.identity), p = obj(r.profile), y = obj(r.psychology), v = obj(r.voice);
  return { schemaVersion: 3, id: Number(r.id),
    identity: { name: txt(i.name), aliases: strs(i.aliases).slice(0, 20), tags: strs(i.tags), narrativeRole: txt(i.narrativeRole), summary: txt(i.summary) },
    profile: { appearanceSummary: txt(p.appearanceSummary), distinguishingFeatures: strs(p.distinguishingFeatures), backgroundSummary: txt(p.backgroundSummary), biography: txt(p.biography) },
    psychology: { summary: txt(y.summary), traits: arr(y.traits).map(entry), values: arr(y.values).map(entry), fears: arr(y.fears).map(entry), conflicts: arr(y.conflicts).map(entry) },
    motivations: arr(r.motivations).map(goal), voice: { summary: txt(v.summary), register: txt(v.register), diction: strs(v.diction), verbalHabits: strs(v.verbalHabits), avoidedExpressions: strs(v.avoidedExpressions), examples: strs(v.examples) },
    competencies: arr(r.competencies).map(competency), relationships: arr(r.relationships).map(relationship), storyStates: arr(r.storyStates).map(state), notes: txt(r.notes), updatedAt: txt(r.updatedAt),
    ...(r.extensions && typeof r.extensions === "object" && !Array.isArray(r.extensions) ? { extensions: r.extensions as Record<string, unknown> } : {}) };
}

export function migrateV2Character(value: unknown): Character {
  const r = obj(value), id = Number(r.id), name = txt(r.name), base = emptyCharacter(name);
  const relationships = arr(r.relationships).flatMap((v): CharacterRelationship[] => { const x = obj(v), target = Number(x.characterId); return Number.isInteger(target) && target !== id ? [{ id: `rel-${id}-${target}`, characterId: target, type: txt(x.type), attitude: txt(x.attitude), status: "active", description: txt(x.description), ...temporalEmpty() }] : []; });
  const motivations: CharacterGoal[] = [];
  if (txt(r.longTermGoal)) motivations.push({ id: `goal-${id}-long-term`, category: "longTerm", status: "active", priority: 50, summary: txt(r.longTermGoal), stakes: "", obstacles: [], ...temporalEmpty() });
  if (txt(r.currentGoal)) motivations.push({ id: `goal-${id}-current`, category: "current", status: "active", priority: 50, summary: txt(r.currentGoal), stakes: "", obstacles: [], ...temporalEmpty() });
  return { ...base, id, identity: { name, aliases: strs(r.aliases), tags: [], narrativeRole: txt(r.narrativeRole ?? r.role), summary: txt(r.identity) }, profile: { appearanceSummary: txt(r.appearance), distinguishingFeatures: [], backgroundSummary: txt(r.background), biography: "" }, psychology: { summary: txt(r.personality ?? r.traits), traits: [], values: txt(r.values) ? [{ id: `value-${id}-legacy`, label: "旧版价值观", description: txt(r.values), ...temporalEmpty() }] : [], fears: txt(r.fears) ? [{ id: `fear-${id}-legacy`, label: "旧版恐惧", description: txt(r.fears), ...temporalEmpty() }] : [], conflicts: [] }, motivations, voice: { summary: txt(r.speechStyle), register: "", diction: [], verbalHabits: [], avoidedExpressions: [], examples: [] }, competencies: (txt(r.capabilities) || txt(r.abilities) || txt(r.limitations)) ? [{ id: `competency-${id}-legacy`, name: "旧版能力概述", level: "", description: txt(r.capabilities ?? r.abilities), resources: [], limitations: txt(r.limitations) ? [txt(r.limitations)] : [], costs: [], ...temporalEmpty() }] : [], relationships, storyStates: [], notes: txt(r.notes), updatedAt: txt(r.updatedAt) };
}

export function characterName(c: Character): string { return c.identity.name; }
export function validateCharacters(characters: Character[], outlineIds?: Set<string>): void {
  const ids = new Set(characters.map(c => c.id)), errors: string[] = [];
  characters.forEach((c, index) => validateOne(c, index, ids, outlineIds, errors));
  if (ids.size !== characters.length) errors.push("characters: 角色 ID 重复");
  if (errors.length) throw new Error(`角色卡校验失败：\n${errors.join("\n")}`);
}
function validateOne(c: Character, index: number, ids: Set<number>, outlineIds: Set<string> | undefined, errors: string[]): void {
  const root = `characters[${index}]`; if (!Number.isInteger(c.id) || c.id <= 0) errors.push(`${root}.id: 必须是正整数`); if (!c.identity.name) errors.push(`${root}.identity.name: 不能为空`);
  const groups: Array<[string, Array<{ id: string }>]> = [["traits", c.psychology.traits], ["values", c.psychology.values], ["fears", c.psychology.fears], ["conflicts", c.psychology.conflicts], ["motivations", c.motivations], ["competencies", c.competencies], ["relationships", c.relationships], ["storyStates", c.storyStates]], seen = new Set<string>();
  groups.forEach(([section, values]) => values.forEach((x, i) => { if (!VALID_ID.test(x.id)) errors.push(`${root}.${section}[${i}].id: 非法或为空`); else if (seen.has(x.id)) errors.push(`${root}.${section}[${i}].id: 重复条目 ID ${x.id}`); else seen.add(x.id); }));
  [...c.psychology.traits, ...c.psychology.values, ...c.psychology.fears, ...c.psychology.conflicts].forEach((x, i) => { if (!x.label && !x.description) errors.push(`${root}.psychology.entries[${i}]: 记录没有内容`); });
  c.motivations.forEach((x, i) => { if (!x.summary) errors.push(`${root}.motivations[${i}].summary: 不能为空`); }); c.competencies.forEach((x, i) => { if (!x.name && !x.description) errors.push(`${root}.competencies[${i}]: 记录没有内容`); });
  const relationTargets = new Set<number>();
  c.relationships.forEach((x, i) => { if (!ids.has(x.characterId)) errors.push(`${root}.relationships[${i}].characterId: 目标角色不存在`); if (x.characterId === c.id) errors.push(`${root}.relationships[${i}].characterId: 不能指向自己`); if (relationTargets.has(x.characterId)) errors.push(`${root}.relationships[${i}].characterId: 重复关系目标`); relationTargets.add(x.characterId); if (!x.type && !x.attitude && !x.description) errors.push(`${root}.relationships[${i}]: 记录没有内容`); });
  const temporalRecords: CharacterTemporal[] = [...c.motivations, ...c.competencies, ...c.relationships, ...c.storyStates];
  temporalRecords.forEach((x, i) => { if (x.validFrom && outlineIds && !outlineIds.has(x.validFrom)) errors.push(`${root}.temporal[${i}].validFrom: 节点不存在`); if (x.validUntil && outlineIds && !outlineIds.has(x.validUntil)) errors.push(`${root}.temporal[${i}].validUntil: 节点不存在`); });
  c.storyStates.forEach((x, i) => { if (!x.outlineNodeId && !x.unanchored) errors.push(`${root}.storyStates[${i}]: 必须选择 outline 节点或标记 unanchored`); if (x.outlineNodeId && outlineIds && !outlineIds.has(x.outlineNodeId)) errors.push(`${root}.storyStates[${i}].outlineNodeId: 节点不存在`); if (![x.location, x.physical, x.emotion, x.notes].some(Boolean) && !x.knowledge.length && !x.beliefs.length && !x.intentions.length && !x.temporaryGoals.length) errors.push(`${root}.storyStates[${i}]: 记录没有内容`); });
}

export function resolveCharacterAt(character: Character, nodes: OutlineNode[], targetNodeId?: string) {
  const order = new Map(nodes.map(n => [n.id, n.order])), target = targetNodeId ? order.get(targetNodeId) : undefined;
  const valid = (x: CharacterTemporal) => target !== undefined && !!(x.validFrom || x.validUntil) && (x.validFrom === undefined || (order.get(x.validFrom) ?? Infinity) <= target) && (x.validUntil === undefined || (order.get(x.validUntil) ?? -Infinity) >= target);
  const states = target === undefined ? [] : character.storyStates.filter(x => x.outlineNodeId && (order.get(x.outlineNodeId) ?? Infinity) <= target).sort((a, b) => (order.get(b.outlineNodeId!) ?? -1) - (order.get(a.outlineNodeId!) ?? -1));
  return { targetNodeId, goals: character.motivations.filter(valid), relationships: character.relationships.filter(valid), storyState: states[0] };
}
export function characterPromptViews(character: Character, nodes: OutlineNode[] = [], targetNodeId?: string) { return { stable: { id: character.id, identity: character.identity, profile: character.profile, psychology: character.psychology, competencies: character.competencies, notes: character.notes }, dialogue: { name: character.identity.name, voice: character.voice }, scene: resolveCharacterAt(character, nodes, targetNodeId) }; }
