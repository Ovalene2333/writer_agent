import type {
  Character,
  CharacterCompetency,
  CharacterGoal,
  CharacterRelationship,
  CharacterSourceRef,
  CharacterStoryState,
  CharacterTemporal,
  CharacterTextEntry,
  OutlineNode,
} from "./types.js";

export type CharacterSection =
  | "identity"
  | "profile"
  | "psychology"
  | "motivations"
  | "voice"
  | "competencies"
  | "relationships"
  | "storyState"
  | "experiences"
  | "notes";

/** Array sections that support upsert / deleteEntryIds / replaceSections. */
export type CharacterArraySection =
  | "motivations"
  | "competencies"
  | "relationships"
  | "storyStates"
  | "experiences"
  | "traits"
  | "values"
  | "fears"
  | "conflicts";

export type CharacterReplaceSection =
  | "motivations"
  | "competencies"
  | "relationships"
  | "storyStates"
  | "experiences"
  | "traits"
  | "values"
  | "fears"
  | "conflicts";

export type CharacterInput = Partial<Omit<Character, "schemaVersion" | "id" | "updatedAt" | "psychology">> & {
  id?: number;
  schemaVersion?: 3;
  /** Partial psychology: summary and/or entry arrays; arrays upsert by id. */
  psychology?: Partial<Character["psychology"]>;
  deleteEntryIds?: Partial<Record<CharacterArraySection, string[]>>;
  /** When set, listed sections fully replace instead of upsert-by-id. */
  replaceSections?: CharacterReplaceSection[];
};

export type CharacterChangeOp = {
  op: string;
  [key: string]: unknown;
};

export type ApplyCharacterChangesInput = {
  reason: string;
  sourceRef?: CharacterSourceRef;
  changes: CharacterChangeOp[];
};

export type AppliedCharacterChange = { op: string; detail: string };
export type SkippedCharacterChange = { op: string; reason: string };

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PSYCH_GROUPS = ["traits", "values", "fears", "conflicts"] as const;
type PsychGroup = (typeof PSYCH_GROUPS)[number];
const TOP_ARRAY_SECTIONS = ["motivations", "competencies", "relationships", "storyStates", "experiences"] as const;
type TopArraySection = (typeof TOP_ARRAY_SECTIONS)[number];

const temporalEmpty = (): CharacterTemporal => ({ sourceRefs: [] });

export const emptyCharacter = (name = ""): Omit<Character, "id" | "updatedAt"> => ({
  schemaVersion: 3,
  identity: { name, aliases: [], tags: [], narrativeRole: "", summary: "" },
  profile: { appearanceSummary: "", distinguishingFeatures: [], backgroundSummary: "", biography: "" },
  psychology: { summary: "", traits: [], values: [], fears: [], conflicts: [] },
  motivations: [],
  voice: { summary: "", register: "", diction: [], verbalHabits: [], avoidedExpressions: [], examples: [] },
  competencies: [],
  relationships: [],
  storyStates: [],
  experiences: [],
  notes: "",
});

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const txt = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const strs = (v: unknown): string[] =>
  arr(v).filter((x): x is string => typeof x === "string").map(x => x.trim()).filter(Boolean);

function sourceRef(v: unknown): CharacterSourceRef[] {
  const r = obj(v);
  if (!(["outline", "document", "manual"] as unknown[]).includes(r.type) || !txt(r.ref)) return [];
  return [{ type: r.type as CharacterSourceRef["type"], ref: txt(r.ref), ...(txt(r.note) ? { note: txt(r.note) } : {}) }];
}

function parseSourceRef(v: unknown): CharacterSourceRef | undefined {
  return sourceRef(v)[0];
}

function temporal(r: Record<string, unknown>): CharacterTemporal {
  return {
    sourceRefs: arr(r.sourceRefs).flatMap(sourceRef),
    ...(txt(r.validFrom) ? { validFrom: txt(r.validFrom) } : {}),
    ...(txt(r.validUntil) ? { validUntil: txt(r.validUntil) } : {}),
  };
}

function entry(v: unknown): CharacterTextEntry {
  const r = obj(v);
  return { id: txt(r.id), label: txt(r.label), description: txt(r.description), ...temporal(r) };
}

function goal(v: unknown): CharacterGoal {
  const r = obj(v);
  const statuses = ["active", "achieved", "abandoned", "blocked", "unknown"];
  return {
    id: txt(r.id),
    category: r.category === "current" ? "current" : "longTerm",
    status: statuses.includes(String(r.status)) ? r.status as CharacterGoal["status"] : "unknown",
    priority: Number.isFinite(Number(r.priority)) ? Math.max(0, Math.min(100, Number(r.priority))) : 0,
    summary: txt(r.summary),
    stakes: txt(r.stakes),
    obstacles: strs(r.obstacles),
    ...temporal(r),
  };
}

function competency(v: unknown): CharacterCompetency {
  const r = obj(v);
  return {
    id: txt(r.id),
    name: txt(r.name),
    summary: txt(r.summary),
    level: txt(r.level),
    unlocked: r.unlocked === true,
    description: txt(r.description),
    resources: strs(r.resources),
    limitations: strs(r.limitations),
    costs: strs(r.costs),
    ...temporal(r),
  };
}

export type CharacterCompetencyPromptView =
  | CharacterCompetency
  | { id: string; name: string; summary: string; unlocked: false };

/**
 * Planning/tool view: locked skills keep only their stable id and public name/summary (no mechanism dump).
 * Still exposes unlocked=false so apply_character_changes / scene planning can see status.
 */
export function competencyPromptView(item: CharacterCompetency): CharacterCompetencyPromptView {
  return item.unlocked ? item : { id: item.id, name: item.name, summary: item.summary, unlocked: false };
}

/** One-line rule attached to any character payload that may reach a prose model. */
export const COMPETENCY_WRITING_RULE =
  "能力写法：仅 inPlay 可在正文用动作/后果兑现；notInPlay 本场不得使用，且禁止写成卡面/系统腔（「未解锁」「还锁着」「档案上…锁着」「不是A不是B——还锁着」点名否定列举）。角色尚不知的武装专名不要提前点名。";

/**
 * Writing-facing competency split: never feed unlocked:false flags into prose context.
 * Locked entries are planning constraints only — not inventory HUD lines for the narrator.
 */
export function competenciesWritingPayload(competencies: CharacterCompetency[]) {
  const inPlay = competencies.filter(item => item.unlocked).map(item => ({
    id: item.id,
    name: item.name,
    summary: item.summary,
    level: item.level,
    description: item.description,
    resources: item.resources,
    limitations: item.limitations,
    costs: item.costs,
  }));
  const notInPlay = competencies.filter(item => !item.unlocked).map(item => ({
    name: item.name,
    summary: item.summary,
  }));
  return {
    inPlay,
    notInPlay,
    rule: COMPETENCY_WRITING_RULE,
  };
}

export function characterPromptCard(character: Character) {
  return {
    ...character,
    competencies: character.competencies.map(competencyPromptView),
    competencyWritingRule: COMPETENCY_WRITING_RULE,
  };
}

function relationship(v: unknown): CharacterRelationship {
  const r = obj(v);
  const statuses = ["active", "ended", "strained", "unknown"];
  return {
    id: txt(r.id),
    characterId: Number(r.characterId),
    type: txt(r.type),
    attitude: txt(r.attitude),
    status: statuses.includes(String(r.status)) ? r.status as CharacterRelationship["status"] : "unknown",
    description: txt(r.description),
    ...temporal(r),
  };
}

function state(v: unknown): CharacterStoryState {
  const r = obj(v);
  const node = txt(r.outlineNodeId);
  return {
    id: txt(r.id),
    ...(node ? { outlineNodeId: node } : {}),
    ...(r.unanchored === true ? { unanchored: true } : {}),
    location: txt(r.location),
    physical: txt(r.physical),
    emotion: txt(r.emotion),
    knowledge: arr(r.knowledge).map(entry),
    beliefs: arr(r.beliefs).map(entry),
    intentions: strs(r.intentions),
    temporaryGoals: arr(r.temporaryGoals).map(goal),
    notes: txt(r.notes),
    ...temporal(r),
  };
}

export function normalizeV3Character(value: unknown): Character {
  const r = obj(value);
  const i = obj(r.identity);
  const p = obj(r.profile);
  const y = obj(r.psychology);
  const v = obj(r.voice);
  return {
    schemaVersion: 3,
    id: Number(r.id),
    identity: {
      name: txt(i.name),
      aliases: strs(i.aliases).slice(0, 20),
      tags: strs(i.tags),
      narrativeRole: txt(i.narrativeRole),
      summary: txt(i.summary),
    },
    profile: {
      appearanceSummary: txt(p.appearanceSummary),
      distinguishingFeatures: strs(p.distinguishingFeatures),
      backgroundSummary: txt(p.backgroundSummary),
      biography: txt(p.biography),
    },
    psychology: {
      summary: txt(y.summary),
      traits: arr(y.traits).map(entry),
      values: arr(y.values).map(entry),
      fears: arr(y.fears).map(entry),
      conflicts: arr(y.conflicts).map(entry),
    },
    motivations: arr(r.motivations).map(goal),
    voice: {
      summary: txt(v.summary),
      register: txt(v.register),
      diction: strs(v.diction),
      verbalHabits: strs(v.verbalHabits),
      avoidedExpressions: strs(v.avoidedExpressions),
      examples: strs(v.examples),
    },
    competencies: arr(r.competencies).map(competency),
    relationships: arr(r.relationships).map(relationship),
    storyStates: arr(r.storyStates).map(state),
    experiences: arr(r.experiences).map(entry),
    notes: txt(r.notes),
    updatedAt: txt(r.updatedAt),
    ...(r.extensions && typeof r.extensions === "object" && !Array.isArray(r.extensions)
      ? { extensions: r.extensions as Record<string, unknown> }
      : {}),
  };
}

export function migrateV2Character(value: unknown): Character {
  const r = obj(value);
  const id = Number(r.id);
  const name = txt(r.name);
  const base = emptyCharacter(name);
  const relationships = arr(r.relationships).flatMap((v): CharacterRelationship[] => {
    const x = obj(v);
    const target = Number(x.characterId);
    return Number.isInteger(target) && target !== id
      ? [{
        id: `rel-${id}-${target}`,
        characterId: target,
        type: txt(x.type),
        attitude: txt(x.attitude),
        status: "active",
        description: txt(x.description),
        ...temporalEmpty(),
      }]
      : [];
  });
  const motivations: CharacterGoal[] = [];
  if (txt(r.longTermGoal)) {
    motivations.push({
      id: `goal-${id}-long-term`,
      category: "longTerm",
      status: "active",
      priority: 50,
      summary: txt(r.longTermGoal),
      stakes: "",
      obstacles: [],
      ...temporalEmpty(),
    });
  }
  if (txt(r.currentGoal)) {
    motivations.push({
      id: `goal-${id}-current`,
      category: "current",
      status: "active",
      priority: 50,
      summary: txt(r.currentGoal),
      stakes: "",
      obstacles: [],
      ...temporalEmpty(),
    });
  }
  return {
    ...base,
    id,
    identity: {
      name,
      aliases: strs(r.aliases),
      tags: [],
      narrativeRole: txt(r.narrativeRole ?? r.role),
      summary: txt(r.identity),
    },
    profile: {
      appearanceSummary: txt(r.appearance),
      distinguishingFeatures: [],
      backgroundSummary: txt(r.background),
      biography: "",
    },
    psychology: {
      summary: txt(r.personality ?? r.traits),
      traits: [],
      values: txt(r.values)
        ? [{ id: `value-${id}-legacy`, label: "旧版价值观", description: txt(r.values), ...temporalEmpty() }]
        : [],
      fears: txt(r.fears)
        ? [{ id: `fear-${id}-legacy`, label: "旧版恐惧", description: txt(r.fears), ...temporalEmpty() }]
        : [],
      conflicts: [],
    },
    motivations,
    voice: {
      summary: txt(r.speechStyle),
      register: "",
      diction: [],
      verbalHabits: [],
      avoidedExpressions: [],
      examples: [],
    },
    competencies: (txt(r.capabilities) || txt(r.abilities) || txt(r.limitations))
      ? [{
        id: `competency-${id}-legacy`,
        name: "旧版能力概述",
        summary: "",
        level: "",
        unlocked: false,
        description: txt(r.capabilities ?? r.abilities),
        resources: [],
        limitations: txt(r.limitations) ? [txt(r.limitations)] : [],
        costs: [],
        ...temporalEmpty(),
      }]
      : [],
    relationships,
    storyStates: [],
    experiences: [],
    notes: txt(r.notes),
    updatedAt: txt(r.updatedAt),
  };
}

export function characterName(c: Character): string {
  return c.identity.name;
}

/** Merge patch items into base by id (append unknown ids). Patch items replace the whole entry when id matches. */
export function upsertById<T extends { id: string }>(base: T[], patch: T[]): T[] {
  if (!patch.length) return [...base];
  const next = [...base];
  for (const item of patch) {
    if (!item.id) continue;
    const index = next.findIndex(x => x.id === item.id);
    if (index >= 0) next[index] = item;
    else next.push(item);
  }
  return next;
}

function removeByIds<T extends { id: string }>(values: T[], ids?: string[]): T[] {
  if (!ids?.length) return values;
  const drop = new Set(ids);
  return values.filter(value => !drop.has(value.id));
}

function isPsychGroup(value: unknown): value is PsychGroup {
  return typeof value === "string" && (PSYCH_GROUPS as readonly string[]).includes(value);
}

function isTopArraySection(value: unknown): value is TopArraySection {
  return typeof value === "string" && (TOP_ARRAY_SECTIONS as readonly string[]).includes(value);
}

function isReplaceSection(value: unknown): value is CharacterReplaceSection {
  return typeof value === "string" && (
    (TOP_ARRAY_SECTIONS as readonly string[]).includes(value)
    || (PSYCH_GROUPS as readonly string[]).includes(value)
  );
}

function mergeArraySection<T extends { id: string }>(
  base: T[],
  patch: T[] | undefined,
  deletedIds: string[] | undefined,
  replace: boolean,
  normalizeItem: (v: unknown) => T,
  idPrefix: string,
): T[] {
  const afterDelete = removeByIds(base, deletedIds);
  if (patch === undefined) return afterDelete;
  const normalized = patch.map(value => {
    const item = normalizeItem(value);
    return VALID_ID.test(item.id) ? item : { ...item, id: generatedEntryId(idPrefix) };
  });
  return replace ? normalized : upsertById(afterDelete, normalized);
}

/**
 * Apply nested character input onto an existing (or empty) base card.
 * Array sections upsert-by-id unless listed in replaceSections; deletions use deleteEntryIds.
 */
export function applyCharacterInput(base: Character, input: CharacterInput): Character {
  const deleted = input.deleteEntryIds ?? {};
  const replace = new Set((input.replaceSections ?? []).filter(isReplaceSection));

  const psychInput = input.psychology;
  const psychology = {
    summary: psychInput?.summary !== undefined ? txt(psychInput.summary) : base.psychology.summary,
    traits: mergeArraySection(
      base.psychology.traits,
      psychInput?.traits,
      deleted.traits,
      replace.has("traits"),
      entry,
      "trait",
    ),
    values: mergeArraySection(
      base.psychology.values,
      psychInput?.values,
      deleted.values,
      replace.has("values"),
      entry,
      "value",
    ),
    fears: mergeArraySection(
      base.psychology.fears,
      psychInput?.fears,
      deleted.fears,
      replace.has("fears"),
      entry,
      "fear",
    ),
    conflicts: mergeArraySection(
      base.psychology.conflicts,
      psychInput?.conflicts,
      deleted.conflicts,
      replace.has("conflicts"),
      entry,
      "conflict",
    ),
  };

  return normalizeV3Character({
    ...base,
    ...input,
    id: base.id,
    schemaVersion: 3,
    updatedAt: new Date().toISOString(),
    identity: { ...base.identity, ...input.identity },
    profile: { ...base.profile, ...input.profile },
    psychology,
    voice: { ...base.voice, ...input.voice },
    motivations: mergeArraySection(
      base.motivations,
      input.motivations,
      deleted.motivations,
      replace.has("motivations"),
      goal,
      "goal",
    ),
    competencies: mergeArraySection(
      base.competencies,
      input.competencies,
      deleted.competencies,
      replace.has("competencies"),
      competency,
      "competency",
    ),
    relationships: mergeArraySection(
      base.relationships,
      input.relationships,
      deleted.relationships,
      replace.has("relationships"),
      relationship,
      "relationship",
    ),
    storyStates: mergeArraySection(
      base.storyStates,
      input.storyStates,
      deleted.storyStates,
      replace.has("storyStates"),
      state,
      "state",
    ),
    experiences: mergeArraySection(
      base.experiences,
      input.experiences,
      deleted.experiences,
      replace.has("experiences"),
      entry,
      "experience",
    ),
    notes: input.notes !== undefined ? txt(input.notes) : base.notes,
    extensions: input.extensions !== undefined ? input.extensions : base.extensions,
  });
}

function withOptionalSourceRef<T extends CharacterTemporal>(
  item: T,
  ref: CharacterSourceRef | undefined,
): T {
  if (!ref) return item;
  const exists = item.sourceRefs.some(x => x.type === ref.type && x.ref === ref.ref);
  if (exists) return item;
  return { ...item, sourceRefs: [...item.sourceRefs, ref] };
}

let generatedEntrySequence = 0;

function generatedEntryId(prefix: string): string {
  generatedEntrySequence = (generatedEntrySequence + 1) % 0x100000;
  return `${prefix}-${Date.now().toString(36)}-${generatedEntrySequence.toString(36)}`;
}

function ensureEntryId(raw: Record<string, unknown>, prefix: string): string {
  const id = txt(raw.id);
  if (VALID_ID.test(id)) return id;
  return generatedEntryId(prefix);
}

export const CHARACTER_CHANGE_OPS = [
  "set_unlocked",
  "upsert_competency",
  "set_psychology_summary",
  "upsert_psychology_entry",
  "delete_psychology_entry",
  "add_experience",
  "upsert_experience",
  "delete_experience",
  "upsert_motivation",
  "upsert_relationship",
  "upsert_story_state",
  "delete_entry",
] as const;

const CHANGE_OP_UPSERT_TARGETS: Record<string, string> = {
  competency: "upsert_competency",
  psychology_entry: "upsert_psychology_entry",
  experience: "add_experience",
  experiences: "add_experience",
  motivation: "upsert_motivation",
  goal: "upsert_motivation",
  relationship: "upsert_relationship",
  relation: "upsert_relationship",
  story_state: "upsert_story_state",
  state: "upsert_story_state",
};

/** Models routinely guess op names (add_/append_/update_*); accept the synonyms instead of skipping the change. */
export function normalizeCharacterChangeOp(op: string): string {
  const trimmed = op.trim();
  if ((CHARACTER_CHANGE_OPS as readonly string[]).includes(trimmed)) return trimmed;
  const upsertLike = /^(?:add|append|update|create|insert|upsert)_(.+)$/.exec(trimmed);
  if (upsertLike && CHANGE_OP_UPSERT_TARGETS[upsertLike[1]]) return CHANGE_OP_UPSERT_TARGETS[upsertLike[1]];
  const deleteLike = /^(?:remove|delete)_(.+)$/.exec(trimmed);
  if (deleteLike) {
    if (deleteLike[1] === "experience" || deleteLike[1] === "experiences") return "delete_experience";
    if (deleteLike[1] === "psychology_entry") return "delete_psychology_entry";
    if (deleteLike[1] === "entry") return "delete_entry";
  }
  return trimmed;
}

export function isCharacterChangeOp(op: string): boolean {
  return (CHARACTER_CHANGE_OPS as readonly string[]).includes(normalizeCharacterChangeOp(op));
}

export function characterChangeOpsHint(): string {
  return "可用 op：set_unlocked{competencyId,unlocked} / upsert_competency{entry} / set_psychology_summary{summary} / "
    + "upsert_psychology_entry{group,entry} / delete_psychology_entry{group,entryId} / add_experience{entry} / "
    + "delete_experience{entryId} / upsert_motivation{entry} / upsert_relationship{entry.characterId} / "
    + "upsert_story_state{entry} / delete_entry{section,entryId}";
}

/**
 * Apply semantic evolution ops onto a character. Unknown ops are skipped (not fatal).
 * Does not persist; caller should pass result through saveCharacter validation.
 */
export function applyCharacterChanges(
  base: Character,
  input: ApplyCharacterChangesInput,
): { character: Character; applied: AppliedCharacterChange[]; skipped: SkippedCharacterChange[] } {
  const reason = txt(input.reason);
  if (!reason) throw new Error("apply_character_changes 需要 reason（已确认的剧情事实摘要）");
  const changes = Array.isArray(input.changes) ? input.changes : [];
  if (!changes.length) throw new Error("apply_character_changes 需要至少一条 changes");

  const defaultRef = parseSourceRef(input.sourceRef);
  let current = normalizeV3Character(base);
  const applied: AppliedCharacterChange[] = [];
  const skipped: SkippedCharacterChange[] = [];

  const skip = (op: string, message: string) => {
    skipped.push({ op, reason: message });
  };

  for (const raw of changes) {
    const rawOp = txt(raw.op);
    if (!rawOp) {
      skip("unknown", `缺少 op；${characterChangeOpsHint()}`);
      continue;
    }
    const op = normalizeCharacterChangeOp(rawOp);

    try {
      switch (op) {
        case "set_unlocked": {
          const competencyId = txt(raw.competencyId ?? raw.id);
          if (!competencyId) {
            skip(op, "缺少 competencyId");
            break;
          }
          const unlocked = raw.unlocked === true;
          const index = current.competencies.findIndex(x => x.id === competencyId);
          if (index < 0) {
            skip(op, `能力不存在：${competencyId}`);
            break;
          }
          const next = [...current.competencies];
          next[index] = withOptionalSourceRef({ ...next[index], unlocked }, defaultRef);
          current = { ...current, competencies: next };
          applied.push({ op, detail: `${competencyId} → unlocked=${unlocked}` });
          break;
        }
        case "upsert_competency": {
          const entryRaw = obj(raw.entry ?? raw);
          const id = ensureEntryId(entryRaw, "competency");
          const item = withOptionalSourceRef(competency({ ...entryRaw, id }), defaultRef);
          if (!item.name && !item.description) {
            skip(op, "能力缺少 name/description");
            break;
          }
          current = { ...current, competencies: upsertById(current.competencies, [item]) };
          applied.push({ op, detail: item.id });
          break;
        }
        case "set_psychology_summary": {
          const summary = txt(raw.summary ?? raw.value);
          current = {
            ...current,
            psychology: { ...current.psychology, summary },
          };
          applied.push({ op, detail: summary.slice(0, 80) || "(清空)" });
          break;
        }
        case "upsert_psychology_entry": {
          const group = raw.group;
          if (!isPsychGroup(group)) {
            skip(op, "group 必须是 traits/values/fears/conflicts");
            break;
          }
          const entryRaw = obj(raw.entry ?? raw);
          const id = ensureEntryId(entryRaw, group);
          const item = withOptionalSourceRef(entry({ ...entryRaw, id }), defaultRef);
          if (!item.label && !item.description) {
            skip(op, "心理条目缺少 label/description");
            break;
          }
          current = {
            ...current,
            psychology: {
              ...current.psychology,
              [group]: upsertById(current.psychology[group], [item]),
            },
          };
          applied.push({ op, detail: `${group}:${item.id}` });
          break;
        }
        case "delete_psychology_entry": {
          const group = raw.group;
          const entryId = txt(raw.entryId ?? raw.id);
          if (!isPsychGroup(group) || !entryId) {
            skip(op, "需要 group 与 entryId");
            break;
          }
          current = {
            ...current,
            psychology: {
              ...current.psychology,
              [group]: current.psychology[group].filter(x => x.id !== entryId),
            },
          };
          applied.push({ op, detail: `${group}:${entryId}` });
          break;
        }
        case "add_experience":
        case "upsert_experience": {
          const entryRaw = obj(raw.entry ?? raw);
          const id = ensureEntryId(entryRaw, "exp");
          const item = withOptionalSourceRef(entry({ ...entryRaw, id }), defaultRef);
          if (!item.label && !item.description) {
            skip(op, "经历缺少 label/description");
            break;
          }
          current = { ...current, experiences: upsertById(current.experiences, [item]) };
          applied.push({ op, detail: item.id });
          break;
        }
        case "delete_experience": {
          const entryId = txt(raw.entryId ?? raw.id);
          if (!entryId) {
            skip(op, "缺少 entryId");
            break;
          }
          current = { ...current, experiences: current.experiences.filter(x => x.id !== entryId) };
          applied.push({ op, detail: entryId });
          break;
        }
        case "upsert_motivation": {
          const entryRaw = obj(raw.entry ?? raw);
          const id = ensureEntryId(entryRaw, "goal");
          const item = withOptionalSourceRef(goal({ ...entryRaw, id }), defaultRef);
          if (!item.summary) {
            skip(op, "目标缺少 summary");
            break;
          }
          current = { ...current, motivations: upsertById(current.motivations, [item]) };
          applied.push({ op, detail: item.id });
          break;
        }
        case "upsert_relationship": {
          const entryRaw = obj(raw.entry ?? raw);
          const id = ensureEntryId(entryRaw, "rel");
          const item = withOptionalSourceRef(relationship({ ...entryRaw, id }), defaultRef);
          if (!Number.isInteger(item.characterId) || item.characterId <= 0) {
            skip(op, "关系缺少有效 characterId");
            break;
          }
          current = { ...current, relationships: upsertById(current.relationships, [item]) };
          applied.push({ op, detail: item.id });
          break;
        }
        case "upsert_story_state": {
          const entryRaw = obj(raw.entry ?? raw);
          const id = ensureEntryId(entryRaw, "state");
          const item = withOptionalSourceRef(state({ ...entryRaw, id }), defaultRef);
          if (!item.outlineNodeId && !item.unanchored) {
            skip(op, "storyState 需要 outlineNodeId 或 unanchored=true");
            break;
          }
          current = { ...current, storyStates: upsertById(current.storyStates, [item]) };
          applied.push({ op, detail: item.id });
          break;
        }
        case "delete_entry": {
          const section = raw.section;
          const entryId = txt(raw.entryId ?? raw.id);
          if (!entryId) {
            skip(op, "缺少 entryId");
            break;
          }
          if (isPsychGroup(section)) {
            current = {
              ...current,
              psychology: {
                ...current.psychology,
                [section]: current.psychology[section].filter(x => x.id !== entryId),
              },
            };
            applied.push({ op, detail: `${section}:${entryId}` });
            break;
          }
          if (!isTopArraySection(section)) {
            skip(op, "section 无效");
            break;
          }
          current = {
            ...current,
            [section]: (current[section] as Array<{ id: string }>).filter(x => x.id !== entryId),
          };
          applied.push({ op, detail: `${section}:${entryId}` });
          break;
        }
        default:
          skip(rawOp, `未知 op：${rawOp}；${characterChangeOpsHint()}`);
      }
    } catch (error) {
      skip(op, error instanceof Error ? error.message : String(error));
    }
  }

  // Stamp a manual source ref on notes trail only via applied list; card notes left untouched.
  current = normalizeV3Character({
    ...current,
    updatedAt: new Date().toISOString(),
  });

  return { character: current, applied, skipped };
}

export function validateCharacters(characters: Character[], outlineIds?: Set<string>): void {
  const ids = new Set(characters.map(c => c.id));
  const errors: string[] = [];
  characters.forEach((c, index) => validateOne(c, index, ids, outlineIds, errors));
  if (ids.size !== characters.length) errors.push("characters: 角色 ID 重复");
  if (errors.length) throw new Error(`角色卡校验失败：\n${errors.join("\n")}`);
}

function validateOne(
  c: Character,
  index: number,
  ids: Set<number>,
  outlineIds: Set<string> | undefined,
  errors: string[],
): void {
  const root = `characters[${index}]`;
  if (!Number.isInteger(c.id) || c.id <= 0) errors.push(`${root}.id: 必须是正整数`);
  if (!c.identity.name) errors.push(`${root}.identity.name: 不能为空`);
  const groups: Array<[string, Array<{ id: string }>]> = [
    ["traits", c.psychology.traits],
    ["values", c.psychology.values],
    ["fears", c.psychology.fears],
    ["conflicts", c.psychology.conflicts],
    ["motivations", c.motivations],
    ["competencies", c.competencies],
    ["relationships", c.relationships],
    ["storyStates", c.storyStates],
    ["experiences", c.experiences],
  ];
  const seen = new Set<string>();
  groups.forEach(([section, values]) => values.forEach((x, i) => {
    if (!VALID_ID.test(x.id)) errors.push(`${root}.${section}[${i}].id: 非法或为空`);
    else if (seen.has(x.id)) errors.push(`${root}.${section}[${i}].id: 重复条目 ID ${x.id}`);
    else seen.add(x.id);
  }));
  [...c.psychology.traits, ...c.psychology.values, ...c.psychology.fears, ...c.psychology.conflicts]
    .forEach((x, i) => {
      if (!x.label && !x.description) errors.push(`${root}.psychology.entries[${i}]: 记录没有内容`);
    });
  c.experiences.forEach((x, i) => {
    if (!x.label && !x.description) errors.push(`${root}.experiences[${i}]: 记录没有内容`);
  });
  c.motivations.forEach((x, i) => {
    if (!x.summary) errors.push(`${root}.motivations[${i}].summary: 不能为空`);
  });
  c.competencies.forEach((x, i) => {
    if (!x.name && !x.description) errors.push(`${root}.competencies[${i}]: 记录没有内容`);
  });
  const relationTargets = new Set<number>();
  c.relationships.forEach((x, i) => {
    if (!ids.has(x.characterId)) errors.push(`${root}.relationships[${i}].characterId: 目标角色不存在`);
    if (x.characterId === c.id) errors.push(`${root}.relationships[${i}].characterId: 不能指向自己`);
    if (relationTargets.has(x.characterId)) errors.push(`${root}.relationships[${i}].characterId: 重复关系目标`);
    relationTargets.add(x.characterId);
    if (!x.type && !x.attitude && !x.description) errors.push(`${root}.relationships[${i}]: 记录没有内容`);
  });
  const temporalRecords: CharacterTemporal[] = [
    ...c.motivations,
    ...c.competencies,
    ...c.relationships,
    ...c.storyStates,
    ...c.experiences,
    ...c.psychology.traits,
    ...c.psychology.values,
    ...c.psychology.fears,
    ...c.psychology.conflicts,
  ];
  temporalRecords.forEach((x, i) => {
    if (x.validFrom && outlineIds && !outlineIds.has(x.validFrom)) {
      errors.push(`${root}.temporal[${i}].validFrom: 节点不存在`);
    }
    if (x.validUntil && outlineIds && !outlineIds.has(x.validUntil)) {
      errors.push(`${root}.temporal[${i}].validUntil: 节点不存在`);
    }
  });
  c.storyStates.forEach((x, i) => {
    if (!x.outlineNodeId && !x.unanchored) {
      errors.push(`${root}.storyStates[${i}]: 必须选择 outline 节点或标记 unanchored`);
    }
    if (x.outlineNodeId && outlineIds && !outlineIds.has(x.outlineNodeId)) {
      errors.push(`${root}.storyStates[${i}].outlineNodeId: 节点不存在`);
    }
    if (
      ![x.location, x.physical, x.emotion, x.notes].some(Boolean)
      && !x.knowledge.length
      && !x.beliefs.length
      && !x.intentions.length
      && !x.temporaryGoals.length
    ) {
      errors.push(`${root}.storyStates[${i}]: 记录没有内容`);
    }
  });
}

/**
 * Temporal validity for scene resolution.
 * Entries without validFrom/validUntil are always visible (stable baseline).
 * Entries with temporal bounds are visible only when target is in range.
 */
function temporalVisible(
  x: CharacterTemporal,
  order: Map<string, number>,
  target: number | undefined,
): boolean {
  if (!(x.validFrom || x.validUntil)) return true;
  if (target === undefined) return true;
  if (x.validFrom !== undefined && (order.get(x.validFrom) ?? Infinity) > target) return false;
  if (x.validUntil !== undefined && (order.get(x.validUntil) ?? -Infinity) < target) return false;
  return true;
}

export function resolveCharacterAt(character: Character, nodes: OutlineNode[], targetNodeId?: string) {
  const order = new Map(nodes.map(n => [n.id, n.order]));
  const target = targetNodeId ? order.get(targetNodeId) : undefined;
  // Goals/relationships with temporal bounds: only when bounds set AND in range (legacy strict filter).
  const validBounded = (x: CharacterTemporal) =>
    target !== undefined
    && !!(x.validFrom || x.validUntil)
    && (x.validFrom === undefined || (order.get(x.validFrom) ?? Infinity) <= target)
    && (x.validUntil === undefined || (order.get(x.validUntil) ?? -Infinity) >= target);
  const states = target === undefined
    ? []
    : character.storyStates
      .filter(x => x.outlineNodeId && (order.get(x.outlineNodeId) ?? Infinity) <= target)
      .sort((a, b) => (order.get(b.outlineNodeId!) ?? -1) - (order.get(a.outlineNodeId!) ?? -1));
  const experiences = character.experiences.filter(x => temporalVisible(x, order, target));
  const psychology = {
    summary: character.psychology.summary,
    traits: character.psychology.traits.filter(x => temporalVisible(x, order, target)),
    values: character.psychology.values.filter(x => temporalVisible(x, order, target)),
    fears: character.psychology.fears.filter(x => temporalVisible(x, order, target)),
    conflicts: character.psychology.conflicts.filter(x => temporalVisible(x, order, target)),
  };
  return {
    targetNodeId,
    goals: character.motivations.filter(validBounded),
    relationships: character.relationships.filter(validBounded),
    storyState: states[0],
    experiences,
    psychology,
  };
}

export function characterPromptViews(character: Character, nodes: OutlineNode[] = [], targetNodeId?: string) {
  const scene = resolveCharacterAt(character, nodes, targetNodeId);
  const experiences = targetNodeId
    ? scene.experiences
    : character.experiences.slice(-3);
  return {
    stable: {
      id: character.id,
      identity: character.identity,
      profile: character.profile,
      psychology: targetNodeId ? scene.psychology : character.psychology,
      // Prose-bound: no unlocked:false flags (those become「还锁着」inventory diction).
      competencies: competenciesWritingPayload(character.competencies),
      experiences,
      notes: character.notes,
    },
    dialogue: { name: character.identity.name, voice: character.voice },
    scene,
  };
}
