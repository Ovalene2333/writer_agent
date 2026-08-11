import { randomUUID } from "node:crypto";
import type {
  Character,
  CharacterCompetency,
  CharacterFeature,
  CharacterGoal,
  CharacterRelationship,
  CharacterStoryState,
  CharacterTextEntry,
  CharacterVoice,
} from "./types.js";

export const CHARACTER_KNOWLEDGE_SCHEMA_VERSION = 4 as const;

export type CharacterKnowledgeLifecycle = "candidate" | "active" | "archived";
export type CharacterKnowledgeScope = "project" | "session";
export type CharacterKnowledgeStatus = "provisional" | "confirmed" | "superseded" | "retracted";
export type CharacterKnowledgeRecordType =
  | "appearance_fact"
  | "background_fact"
  | "biography_fact"
  | "feature"
  | "capability"
  | "relationship"
  | "voice_principle"
  | "psychological_model"
  | "goal"
  | "story_state"
  | "event"
  | "note";

export type CharacterKnowledgeEvidence = {
  kind: "author" | "document" | "outline" | "session" | "inference";
  source?: string;
  sourceHash?: string;
  quote?: string;
};

export type CharacterKnowledgeRecord = {
  id: string;
  type: CharacterKnowledgeRecordType;
  status: CharacterKnowledgeStatus;
  summary: string;
  payload: Record<string, unknown>;
  evidence: CharacterKnowledgeEvidence[];
  validFrom?: string;
  validUntil?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CharacterKnowledgeEntity = {
  schemaVersion: typeof CHARACTER_KNOWLEDGE_SCHEMA_VERSION;
  id: number;
  key: string;
  scope: CharacterKnowledgeScope;
  lifecycle: CharacterKnowledgeLifecycle;
  revision: number;
  name: string;
  aliases: string[];
  tags: string[];
  narrativeRole: string;
  summary: string;
  records: CharacterKnowledgeRecord[];
  createdAt: string;
  updatedAt: string;
};

export type CharacterPresentationPolicy = {
  id: string;
  characterId: number;
  status: "active" | "paused";
  appliesTo: Array<"author" | "writing" | "roleplay" | "review">;
  instruction: string;
  avoid: string[];
  allow: string[];
  preferredGuidance: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CharacterKnowledgeBundle = {
  entity: CharacterKnowledgeEntity;
  events: CharacterKnowledgeRecord[];
  policies: CharacterPresentationPolicy[];
};

export type CharacterContextPurpose = "catalog" | "author" | "writing" | "roleplay" | "review" | "history";

export type CharacterKnowledgeChange =
  | { op: "set_identity"; name?: unknown; aliases?: unknown; tags?: unknown; narrativeRole?: unknown; summary?: unknown }
  | { op: "set_lifecycle"; lifecycle?: unknown }
  | { op: "upsert_record"; record?: unknown }
  | { op: "supersede_record"; recordId?: unknown; reason?: unknown }
  | { op: "retract_record"; recordId?: unknown; reason?: unknown };

export type CharacterKnowledgeMutationResult = {
  bundle: CharacterKnowledgeBundle;
  changedRecordIds: string[];
  warnings: string[];
};

const RECORD_TYPES = new Set<CharacterKnowledgeRecordType>([
  "appearance_fact", "background_fact", "biography_fact", "feature", "capability", "relationship",
  "voice_principle", "psychological_model", "goal", "story_state", "event", "note",
]);
const RECORD_STATUSES = new Set<CharacterKnowledgeStatus>(["provisional", "confirmed", "superseded", "retracted"]);
const ACTIVE_STATUSES = new Set<CharacterKnowledgeStatus>(["provisional", "confirmed"]);

const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const textValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const stringValues = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean))]
  : [];
const intValue = (value: unknown, fallback = 0): number => Number.isInteger(Number(value)) ? Number(value) : fallback;

function normalizeEvidence(value: unknown): CharacterKnowledgeEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap(item => {
    const raw = objectValue(item);
    const kind = raw.kind;
    if (kind !== "author" && kind !== "document" && kind !== "outline" && kind !== "session" && kind !== "inference") return [];
    return [{
      kind,
      ...(textValue(raw.source) ? { source: textValue(raw.source) } : {}),
      ...(textValue(raw.sourceHash) ? { sourceHash: textValue(raw.sourceHash) } : {}),
      ...(textValue(raw.quote) ? { quote: textValue(raw.quote).slice(0, 1_000) } : {}),
    }];
  });
}

function normalizePayload(type: CharacterKnowledgeRecordType, value: unknown): Record<string, unknown> {
  const raw = objectValue(value);
  if (type === "psychological_model") {
    return {
      choiceLogic: textValue(raw.choiceLogic ?? raw.core),
      dominantValue: textValue(raw.dominantValue),
      centralTension: textValue(raw.centralTension),
      pressureStrategy: textValue(raw.pressureStrategy ?? raw.pressureResponse),
      relationshipPattern: textValue(raw.relationshipPattern),
    };
  }
  if (type === "goal") {
    const horizon = raw.horizon === "short" || raw.horizon === "long" ? raw.horizon : "mid";
    const status = raw.status === "blocked" || raw.status === "achieved" || raw.status === "abandoned" ? raw.status : "active";
    return {
      horizon,
      status,
      priority: Math.max(0, Math.min(100, intValue(raw.priority, 50))),
      objective: textValue(raw.objective ?? raw.summary),
      stakes: textValue(raw.stakes),
      obstacles: stringValues(raw.obstacles).slice(0, 12),
    };
  }
  if (type === "feature") {
    return { name: textValue(raw.name), description: textValue(raw.description), details: textValue(raw.details) };
  }
  if (type === "capability") {
    const state = raw.state === "latent" || raw.state === "blocked" || raw.state === "lost" || raw.state === "unknown"
      ? raw.state : "available";
    return {
      name: textValue(raw.name), level: textValue(raw.level), description: textValue(raw.description),
      state, stateReason: textValue(raw.stateReason), resources: stringValues(raw.resources).slice(0, 20),
      limitations: stringValues(raw.limitations).slice(0, 20), costs: stringValues(raw.costs).slice(0, 20),
    };
  }
  if (type === "relationship") {
    const status = raw.status === "ended" || raw.status === "strained" || raw.status === "unknown" ? raw.status : "active";
    return {
      characterId: Math.max(0, intValue(raw.characterId)), type: textValue(raw.type), attitude: textValue(raw.attitude),
      status, description: textValue(raw.description),
    };
  }
  if (type === "voice_principle") {
    const voice = objectValue(raw.voice ?? raw);
    const modes = Array.isArray(voice.modes) ? voice.modes.slice(0, 16).map(item => {
      const mode = objectValue(item);
      return {
        id: textValue(mode.id) || `mode:${randomUUID()}`,
        context: textValue(mode.context), intent: textValue(mode.intent),
        informationStrategy: textValue(mode.informationStrategy), interactionStrategy: textValue(mode.interactionStrategy),
        register: textValue(mode.register),
      };
    }) : [];
    return {
      summary: textValue(voice.summary), register: textValue(voice.register),
      diction: stringValues(voice.diction).slice(0, 20), verbalHabits: stringValues(voice.verbalHabits).slice(0, 20),
      avoidedExpressions: stringValues(voice.avoidedExpressions).slice(0, 30), examples: stringValues(voice.examples).slice(0, 20),
      interactionPrinciples: stringValues(voice.interactionPrinciples).slice(0, 20), modes,
    };
  }
  if (type === "story_state") {
    return {
      outlineNodeId: textValue(raw.outlineNodeId), unanchored: raw.unanchored === true,
      location: textValue(raw.location), physical: textValue(raw.physical), emotion: textValue(raw.emotion),
      knowledge: Array.isArray(raw.knowledge) ? raw.knowledge.slice(0, 30) : [],
      beliefs: Array.isArray(raw.beliefs) ? raw.beliefs.slice(0, 30) : [],
      intentions: stringValues(raw.intentions).slice(0, 20), temporaryGoals: Array.isArray(raw.temporaryGoals) ? raw.temporaryGoals.slice(0, 12) : [],
      competencyStates: Array.isArray(raw.competencyStates) ? raw.competencyStates.slice(0, 30) : [], notes: textValue(raw.notes),
    };
  }
  if (type === "event") {
    return {
      label: textValue(raw.label), description: textValue(raw.description), outlineNodeId: textValue(raw.outlineNodeId),
      occurredAt: textValue(raw.occurredAt), consequences: stringValues(raw.consequences).slice(0, 20),
    };
  }
  return { text: textValue(raw.text ?? raw.description ?? raw.content), label: textValue(raw.label) };
}

export function normalizeCharacterKnowledgeRecord(value: unknown, fallbackType?: CharacterKnowledgeRecordType): CharacterKnowledgeRecord {
  const raw = objectValue(value);
  const type = RECORD_TYPES.has(raw.type as CharacterKnowledgeRecordType)
    ? raw.type as CharacterKnowledgeRecordType
    : fallbackType;
  if (!type) throw new Error("知识记录缺少有效 type");
  const now = new Date().toISOString();
  const status = RECORD_STATUSES.has(raw.status as CharacterKnowledgeStatus)
    ? raw.status as CharacterKnowledgeStatus : "confirmed";
  const payload = normalizePayload(type, raw.payload ?? raw);
  if (JSON.stringify(payload).length > 6_000) throw new Error(`${type} 单条记录超过 6000 字符，请拆成更小的原子记录`);
  const summary = textValue(raw.summary) || recordSummary(type, payload);
  if (!summary) throw new Error(`${type} 记录缺少可识别内容`);
  return {
    id: textValue(raw.id) || `${type}:${randomUUID()}`,
    type,
    status,
    summary: summary.slice(0, 500),
    payload,
    evidence: normalizeEvidence(raw.evidence),
    ...(textValue(raw.validFrom) ? { validFrom: textValue(raw.validFrom) } : {}),
    ...(textValue(raw.validUntil) ? { validUntil: textValue(raw.validUntil) } : {}),
    revision: Math.max(1, intValue(raw.revision, 1)),
    createdAt: textValue(raw.createdAt) || now,
    updatedAt: textValue(raw.updatedAt) || now,
  };
}

export function normalizeCharacterKnowledgeEntity(value: unknown): CharacterKnowledgeEntity {
  const raw = objectValue(value);
  if (raw.schemaVersion !== CHARACTER_KNOWLEDGE_SCHEMA_VERSION) throw new Error("角色知识实体必须是 schemaVersion=4");
  const id = intValue(raw.id);
  const name = textValue(raw.name);
  if (id <= 0) throw new Error("角色知识实体缺少有效 id");
  if (!name) throw new Error("角色知识实体缺少 name");
  if (name.length > 120) throw new Error("角色名称最多 120 字符");
  const records = Array.isArray(raw.records) ? raw.records.map(item => normalizeCharacterKnowledgeRecord(item)) : [];
  validateKnowledgeRecords(records);
  const now = new Date().toISOString();
  return {
    schemaVersion: CHARACTER_KNOWLEDGE_SCHEMA_VERSION,
    id,
    key: textValue(raw.key) || `char_${randomUUID()}`,
    scope: raw.scope === "session" ? "session" : "project",
    lifecycle: raw.lifecycle === "candidate" || raw.lifecycle === "archived" ? raw.lifecycle : "active",
    revision: Math.max(1, intValue(raw.revision, 1)),
    name,
    aliases: stringValues(raw.aliases).filter(alias => alias !== name),
    tags: stringValues(raw.tags),
    narrativeRole: textValue(raw.narrativeRole),
    summary: textValue(raw.summary),
    records: records.filter(record => record.type !== "event"),
    createdAt: textValue(raw.createdAt) || now,
    updatedAt: textValue(raw.updatedAt) || now,
  };
}

export function normalizeCharacterPresentationPolicy(value: unknown): CharacterPresentationPolicy {
  const raw = objectValue(value);
  const now = new Date().toISOString();
  const appliesTo = Array.isArray(raw.appliesTo)
    ? raw.appliesTo.filter((item): item is CharacterPresentationPolicy["appliesTo"][number] =>
      item === "author" || item === "writing" || item === "roleplay" || item === "review")
    : [];
  const instruction = textValue(raw.instruction);
  if (!instruction) throw new Error("表达政策缺少 instruction");
  return {
    id: textValue(raw.id) || `expression:${randomUUID()}`,
    characterId: Math.max(0, intValue(raw.characterId)),
    status: raw.status === "paused" ? "paused" : "active",
    appliesTo: appliesTo.length ? [...new Set(appliesTo)] : ["writing", "roleplay", "review"],
    instruction: instruction.slice(0, 500),
    avoid: stringValues(raw.avoid).slice(0, 30),
    allow: stringValues(raw.allow).slice(0, 30),
    preferredGuidance: textValue(raw.preferredGuidance).slice(0, 500),
    revision: Math.max(1, intValue(raw.revision, 1)),
    createdAt: textValue(raw.createdAt) || now,
    updatedAt: textValue(raw.updatedAt) || now,
  };
}

export function createCharacterKnowledgeEntity(input: {
  id: number;
  name: string;
  aliases?: string[];
  tags?: string[];
  narrativeRole?: string;
  summary?: string;
  scope?: CharacterKnowledgeScope;
  lifecycle?: CharacterKnowledgeLifecycle;
}): CharacterKnowledgeEntity {
  const now = new Date().toISOString();
  return normalizeCharacterKnowledgeEntity({
    schemaVersion: CHARACTER_KNOWLEDGE_SCHEMA_VERSION,
    id: input.id,
    key: `char_${randomUUID()}`,
    scope: input.scope ?? "project",
    lifecycle: input.lifecycle ?? (input.scope === "session" ? "candidate" : "active"),
    revision: 1,
    name: input.name,
    aliases: input.aliases ?? [],
    tags: input.tags ?? [],
    narrativeRole: input.narrativeRole ?? "",
    summary: input.summary ?? "",
    records: [],
    createdAt: now,
    updatedAt: now,
  });
}

function validateKnowledgeRecords(records: CharacterKnowledgeRecord[]): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`知识记录 ID 重复：${record.id}`);
    ids.add(record.id);
  }
  const activePsychology = records.filter(record => record.type === "psychological_model" && ACTIVE_STATUSES.has(record.status));
  if (activePsychology.length > 1) throw new Error("一个角色只能有一个 active psychological_model");
}

function recordSummary(type: CharacterKnowledgeRecordType, payload: Record<string, unknown>): string {
  if (type === "psychological_model") return textValue(payload.choiceLogic) || textValue(payload.centralTension);
  if (type === "goal") return textValue(payload.objective);
  if (type === "feature" || type === "capability") return textValue(payload.name) || textValue(payload.description);
  if (type === "relationship") return textValue(payload.description) || textValue(payload.type);
  if (type === "voice_principle") return textValue(payload.summary) || textValue(payload.register);
  if (type === "story_state") return [payload.location, payload.physical, payload.emotion].map(textValue).filter(Boolean).join("；");
  if (type === "event") return textValue(payload.label) || textValue(payload.description);
  return textValue(payload.text) || textValue(payload.label);
}

function activeRecords(bundle: CharacterKnowledgeBundle, type?: CharacterKnowledgeRecordType): CharacterKnowledgeRecord[] {
  return [...bundle.entity.records, ...bundle.events]
    .filter(record => ACTIVE_STATUSES.has(record.status) && (!type || record.type === type));
}

function legacyTextEntry(record: CharacterKnowledgeRecord): CharacterTextEntry {
  return {
    id: record.id,
    label: textValue(record.payload.label) || record.summary,
    description: textValue(record.payload.description ?? record.payload.text) || record.summary,
    ...(record.validFrom ? { validFrom: record.validFrom } : {}),
    ...(record.validUntil ? { validUntil: record.validUntil } : {}),
  };
}

function emptyVoice(): CharacterVoice {
  return {
    summary: "", register: "", diction: [], verbalHabits: [], avoidedExpressions: [], examples: [],
    interactionPrinciples: [], modes: [],
  };
}

export function characterFromKnowledgeBundle(bundleInput: CharacterKnowledgeBundle): Character {
  const bundle: CharacterKnowledgeBundle = {
    entity: normalizeCharacterKnowledgeEntity(bundleInput.entity),
    events: bundleInput.events.map(record => normalizeCharacterKnowledgeRecord(record, "event")),
    policies: bundleInput.policies.map(normalizeCharacterPresentationPolicy),
  };
  const { entity } = bundle;
  const records = activeRecords(bundle);
  const texts = (type: CharacterKnowledgeRecordType) => records.filter(record => record.type === type)
    .map(record => textValue(record.payload.text) || record.summary).filter(Boolean);
  const psychologyRecord = records.find(record => record.type === "psychological_model");
  const psychology = psychologyRecord?.payload ?? {};
  const goals: CharacterGoal[] = records.filter(record => record.type === "goal").map(record => {
    const payload = record.payload;
    const goalStatus = payload.status === "blocked" || payload.status === "achieved" || payload.status === "abandoned"
      ? payload.status : "active";
    return {
      id: record.id,
      category: payload.horizon === "long" ? "longTerm" : "current",
      status: goalStatus,
      priority: Math.max(0, Math.min(100, intValue(payload.priority, 50))),
      summary: textValue(payload.objective) || record.summary,
      stakes: textValue(payload.stakes),
      obstacles: stringValues(payload.obstacles),
      ...(record.validFrom ? { validFrom: record.validFrom } : {}),
      ...(record.validUntil ? { validUntil: record.validUntil } : {}),
    };
  });
  const voiceRecord = records.find(record => record.type === "voice_principle");
  const voiceRaw = voiceRecord?.payload ?? {};
  const voice: CharacterVoice = voiceRecord ? {
    summary: textValue(voiceRaw.summary), register: textValue(voiceRaw.register),
    diction: stringValues(voiceRaw.diction), verbalHabits: stringValues(voiceRaw.verbalHabits),
    avoidedExpressions: [...new Set([...stringValues(voiceRaw.avoidedExpressions), ...bundle.policies.flatMap(policy => policy.status === "active" ? policy.avoid : [])])],
    examples: stringValues(voiceRaw.examples), interactionPrinciples: stringValues(voiceRaw.interactionPrinciples),
    modes: Array.isArray(voiceRaw.modes) ? voiceRaw.modes as CharacterVoice["modes"] : [],
  } : emptyVoice();
  const features: CharacterFeature[] = records.filter(record => record.type === "feature").map(record => ({
    id: record.id, name: textValue(record.payload.name) || record.summary,
    summary: record.summary, description: textValue(record.payload.description ?? record.payload.details) || record.summary,
  }));
  const competencies: CharacterCompetency[] = records.filter(record => record.type === "capability").map(record => ({
    id: record.id, name: textValue(record.payload.name) || record.summary, summary: record.summary,
    level: textValue(record.payload.level), unlocked: record.payload.state === "available",
    description: textValue(record.payload.description), resources: stringValues(record.payload.resources),
    limitations: stringValues(record.payload.limitations), costs: stringValues(record.payload.costs),
    ...(record.validFrom ? { validFrom: record.validFrom } : {}), ...(record.validUntil ? { validUntil: record.validUntil } : {}),
  }));
  const relationships: CharacterRelationship[] = records.filter(record => record.type === "relationship").map(record => ({
    id: record.id, characterId: intValue(record.payload.characterId), type: textValue(record.payload.type),
    attitude: textValue(record.payload.attitude),
    status: record.payload.status === "ended" || record.payload.status === "strained" || record.payload.status === "unknown"
      ? record.payload.status : "active",
    description: textValue(record.payload.description) || record.summary,
    ...(record.validFrom ? { validFrom: record.validFrom } : {}), ...(record.validUntil ? { validUntil: record.validUntil } : {}),
  }));
  const storyStates: CharacterStoryState[] = records.filter(record => record.type === "story_state").map(record => ({
    id: record.id,
    ...(textValue(record.payload.outlineNodeId) ? { outlineNodeId: textValue(record.payload.outlineNodeId) } : {}),
    ...(record.payload.unanchored === true ? { unanchored: true } : {}),
    location: textValue(record.payload.location), physical: textValue(record.payload.physical), emotion: textValue(record.payload.emotion),
    knowledge: Array.isArray(record.payload.knowledge) ? record.payload.knowledge as CharacterTextEntry[] : [],
    beliefs: Array.isArray(record.payload.beliefs) ? record.payload.beliefs as CharacterTextEntry[] : [],
    intentions: stringValues(record.payload.intentions), temporaryGoals: Array.isArray(record.payload.temporaryGoals) ? record.payload.temporaryGoals as CharacterGoal[] : [],
    ...(Array.isArray(record.payload.competencyStates) ? { competencyStates: record.payload.competencyStates as CharacterStoryState["competencyStates"] } : {}),
    notes: textValue(record.payload.notes),
    ...(record.validFrom ? { validFrom: record.validFrom } : {}), ...(record.validUntil ? { validUntil: record.validUntil } : {}),
  }));
  const appearance = texts("appearance_fact");
  const background = texts("background_fact");
  const biography = texts("biography_fact");
  const noteTexts = texts("note");
  return {
    schemaVersion: 3,
    id: entity.id,
    identity: { name: entity.name, aliases: entity.aliases, tags: entity.tags, narrativeRole: entity.narrativeRole, summary: entity.summary },
    profile: {
      appearance: appearance.join("\n"), appearanceSummary: appearance.slice(0, 6).join("\n"),
      background: background.join("\n"), backgroundSummary: background.slice(0, 6).join("\n"), biography: biography.join("\n"),
    },
    psychology: {
      summary: textValue(psychology.choiceLogic) || psychologyRecord?.summary || "",
      traits: textValue(psychology.relationshipPattern) ? [{ id: `${psychologyRecord!.id}:relationship`, label: "关系模式", description: textValue(psychology.relationshipPattern) }] : [],
      values: textValue(psychology.dominantValue) ? [{ id: `${psychologyRecord!.id}:value`, label: "首要价值", description: textValue(psychology.dominantValue) }] : [],
      fears: [],
      conflicts: textValue(psychology.centralTension) || textValue(psychology.pressureStrategy) ? [{
        id: `${psychologyRecord!.id}:tension`, label: "核心矛盾与受压策略",
        description: [textValue(psychology.centralTension), textValue(psychology.pressureStrategy)].filter(Boolean).join("；"),
      }] : [],
    },
    motivations: goals,
    voice,
    features,
    competencies,
    relationships,
    storyStates,
    experiences: activeRecords(bundle, "event").map(legacyTextEntry),
    notes: noteTexts.join("\n"),
    updatedAt: entity.updatedAt,
    extensions: { characterKnowledgeV4: bundle },
  };
}

function legacyRecord(
  type: CharacterKnowledgeRecordType,
  id: string,
  summary: string,
  payload: Record<string, unknown>,
  previous: Map<string, CharacterKnowledgeRecord>,
  now: string,
): CharacterKnowledgeRecord {
  const old = previous.get(id);
  const normalizedPayload = normalizePayload(type, payload);
  const unchanged = old && JSON.stringify(old.payload) === JSON.stringify(normalizedPayload) && old.summary === summary;
  return {
    id, type, status: old?.status === "provisional" ? "provisional" : "confirmed", summary,
    payload: normalizedPayload, evidence: old?.evidence ?? [],
    revision: unchanged ? old.revision : (old?.revision ?? 0) + 1,
    createdAt: old?.createdAt ?? now, updatedAt: unchanged ? old.updatedAt : now,
  };
}

export function knowledgeBundleFromCharacter(character: Character, existing?: CharacterKnowledgeBundle): CharacterKnowledgeBundle {
  const embedded = objectValue(character.extensions?.characterKnowledgeV4);
  let base = existing;
  if (!base && embedded.entity) {
    try {
      base = {
        entity: normalizeCharacterKnowledgeEntity(embedded.entity),
        events: Array.isArray(embedded.events) ? embedded.events.map(item => normalizeCharacterKnowledgeRecord(item, "event")) : [],
        policies: Array.isArray(embedded.policies) ? embedded.policies.map(normalizeCharacterPresentationPolicy) : [],
      };
    } catch { /* reconstruct from the compatibility projection below */ }
  }
  if (base) {
    const projected = characterFromKnowledgeBundle(base);
    const publicShape = ({ extensions: _extensions, ...value }: Character) => value;
    if (JSON.stringify(publicShape(projected)) === JSON.stringify(publicShape(character))) {
      return base;
    }
  }
  const now = character.updatedAt || new Date().toISOString();
  const priorRecords = new Map([...(base?.entity.records ?? []), ...(base?.events ?? [])].map(record => [record.id, record]));
  const records: CharacterKnowledgeRecord[] = [];
  const addText = (type: CharacterKnowledgeRecordType, id: string, value: string, label = "") => {
    const text = value.trim();
    if (text) records.push(legacyRecord(type, id, text.split(/\r?\n/, 1)[0].slice(0, 500), { text, label }, priorRecords, now));
  };
  addText("appearance_fact", "profile:appearance", character.profile.appearance || character.profile.appearanceSummary);
  addText("background_fact", "profile:background", character.profile.background || character.profile.backgroundSummary);
  addText("biography_fact", "profile:biography", character.profile.biography);
  const psychCore = character.psychology.summary.trim();
  const dominantValue = character.psychology.values.map(item => item.description || item.label).filter(Boolean).join("；");
  const centralTension = [...character.psychology.conflicts, ...character.psychology.fears]
    .map(item => item.description || item.label).filter(Boolean).join("；");
  const relationshipPattern = character.psychology.traits.map(item => item.description || item.label).filter(Boolean).join("；");
  if (psychCore || dominantValue || centralTension || relationshipPattern) {
    records.push(legacyRecord("psychological_model", "psychology:active", psychCore || centralTension || dominantValue, {
      choiceLogic: psychCore, dominantValue, centralTension, pressureStrategy: "", relationshipPattern,
    }, priorRecords, now));
  }
  if (character.voice.summary || character.voice.register || character.voice.interactionPrinciples.length || character.voice.modes.length
    || character.voice.diction.length || character.voice.verbalHabits.length || character.voice.avoidedExpressions.length) {
    records.push(legacyRecord("voice_principle", "voice:active", character.voice.summary || character.voice.register || "对白与互动原则", character.voice as unknown as Record<string, unknown>, priorRecords, now));
  }
  for (const item of character.motivations) records.push(legacyRecord("goal", item.id || `goal:${randomUUID()}`, item.summary, {
    horizon: item.category === "longTerm" ? "long" : "mid", status: item.status, priority: item.priority,
    objective: item.summary, stakes: item.stakes, obstacles: item.obstacles,
  }, priorRecords, now));
  for (const item of character.features) records.push(legacyRecord("feature", item.id || `feature:${randomUUID()}`, item.summary || item.name, item as unknown as Record<string, unknown>, priorRecords, now));
  for (const item of character.competencies) records.push(legacyRecord("capability", item.id || `capability:${randomUUID()}`, item.summary || item.name, {
    ...item, state: item.unlocked ? "available" : "unknown",
  }, priorRecords, now));
  for (const item of character.relationships) records.push(legacyRecord("relationship", item.id || `relationship:${randomUUID()}`, item.description || item.type, item as unknown as Record<string, unknown>, priorRecords, now));
  for (const item of character.storyStates) records.push(legacyRecord("story_state", item.id || `state:${randomUUID()}`, [item.location, item.physical, item.emotion].filter(Boolean).join("；") || item.notes || "剧情状态", item as unknown as Record<string, unknown>, priorRecords, now));
  addText("note", "notes:main", character.notes);
  const events = character.experiences.map(item => legacyRecord("event", item.id || `event:${randomUUID()}`, item.label || item.description, {
    label: item.label, description: item.description,
  }, priorRecords, now));
  const createdAt = base?.entity.createdAt ?? now;
  const entity: CharacterKnowledgeEntity = normalizeCharacterKnowledgeEntity({
    schemaVersion: CHARACTER_KNOWLEDGE_SCHEMA_VERSION,
    id: character.id,
    key: base?.entity.key ?? `char_${randomUUID()}`,
    scope: "project",
    lifecycle: base?.entity.lifecycle ?? "active",
    revision: Math.max(1, base?.entity.revision ?? 0) + (base ? 1 : 0),
    name: character.identity.name,
    aliases: character.identity.aliases,
    tags: character.identity.tags,
    narrativeRole: character.identity.narrativeRole,
    summary: character.identity.summary,
    records,
    createdAt,
    updatedAt: now,
  });
  return { entity, events, policies: base?.policies ?? [] };
}

export function applyCharacterKnowledgeChanges(
  bundleInput: CharacterKnowledgeBundle,
  changes: readonly CharacterKnowledgeChange[],
  knownCharacterIds: ReadonlySet<number>,
): CharacterKnowledgeMutationResult {
  let entity = normalizeCharacterKnowledgeEntity(bundleInput.entity);
  let records = entity.records.map(record => ({ ...record }));
  let events = bundleInput.events.map(record => normalizeCharacterKnowledgeRecord(record, "event"));
  const policies = bundleInput.policies.map(normalizeCharacterPresentationPolicy);
  const changedRecordIds: string[] = [];
  const warnings: string[] = [];
  const now = new Date().toISOString();
  let headerChanged = false;
  for (const change of changes) {
    if (change.op === "set_identity") {
      const name = change.name === undefined ? entity.name : textValue(change.name);
      if (!name) throw new Error("set_identity 不能清空角色名称");
      entity = {
        ...entity,
        name,
        ...(change.aliases !== undefined ? { aliases: stringValues(change.aliases).filter(alias => alias !== name) } : {}),
        ...(change.tags !== undefined ? { tags: stringValues(change.tags) } : {}),
        ...(change.narrativeRole !== undefined ? { narrativeRole: textValue(change.narrativeRole) } : {}),
        ...(change.summary !== undefined ? { summary: textValue(change.summary) } : {}),
      };
      headerChanged = true;
      continue;
    }
    if (change.op === "set_lifecycle") {
      if (change.lifecycle !== "candidate" && change.lifecycle !== "active" && change.lifecycle !== "archived") {
        throw new Error("set_lifecycle.lifecycle 无效");
      }
      entity = { ...entity, lifecycle: change.lifecycle };
      headerChanged = true;
      continue;
    }
    if (change.op === "upsert_record") {
      const incoming = normalizeCharacterKnowledgeRecord(change.record);
      if (incoming.type === "relationship") {
        const target = intValue(incoming.payload.characterId);
        if (target <= 0 || target === entity.id || !knownCharacterIds.has(target)) throw new Error(`关系目标不存在或非法：${target}`);
      }
      if (incoming.type === "psychological_model" && ACTIVE_STATUSES.has(incoming.status)) {
        records = records.map(record => record.type === "psychological_model" && record.id !== incoming.id && ACTIVE_STATUSES.has(record.status)
          ? { ...record, status: "superseded", revision: record.revision + 1, updatedAt: now }
          : record);
      }
      // Build the mutation target after enforcing the single-active-psychology
      // invariant. Otherwise targetList would still point at the pre-supersede
      // array and a later assignment would accidentally restore the old model.
      const targetList = incoming.type === "event" ? events : records;
      const existingIndex = targetList.findIndex(record => record.id === incoming.id);
      const existing = existingIndex >= 0 ? targetList[existingIndex] : undefined;
      const next = {
        ...incoming,
        revision: existing ? existing.revision + 1 : 1,
        createdAt: existing?.createdAt ?? incoming.createdAt,
        updatedAt: now,
      };
      if (existingIndex >= 0) targetList[existingIndex] = next;
      else targetList.push(next);
      if (incoming.type === "event") events = [...targetList];
      else records = [...targetList];
      changedRecordIds.push(next.id);
      continue;
    }
    const recordId = textValue(change.recordId);
    if (!recordId) throw new Error(`${change.op} 缺少 recordId`);
    const status: CharacterKnowledgeStatus = change.op === "retract_record" ? "retracted" : "superseded";
    let found = false;
    const transition = (record: CharacterKnowledgeRecord) => {
      if (record.id !== recordId) return record;
      found = true;
      return { ...record, status, revision: record.revision + 1, updatedAt: now };
    };
    records = records.map(transition);
    events = events.map(transition);
    if (!found) throw new Error(`知识记录不存在：${recordId}`);
    changedRecordIds.push(recordId);
  }
  validateKnowledgeRecords(records);
  const activeGoals = records.filter(record => record.type === "goal" && ACTIVE_STATUSES.has(record.status) && record.payload.status !== "achieved" && record.payload.status !== "abandoned");
  if (activeGoals.length > 3) warnings.push(`当前有 ${activeGoals.length} 个活跃目标；writing 投影只取优先级最高的 3 个，其余保留在 author/history 视图。`);
  if (records.filter(record => record.type === "psychological_model").length > 1) {
    warnings.push("旧心理模型已保留为 superseded 历史；默认写作只使用唯一 active 模型。");
  }
  if (!changes.length) throw new Error("至少提供一条 changes");
  entity = {
    ...entity,
    records,
    revision: entity.revision + 1,
    updatedAt: now,
  };
  if (!headerChanged && !changedRecordIds.length) throw new Error("没有可应用的知识变化");
  return { bundle: { entity, events, policies }, changedRecordIds: [...new Set(changedRecordIds)], warnings };
}

export function upsertCharacterPresentationPolicy(
  bundleInput: CharacterKnowledgeBundle,
  input: Partial<CharacterPresentationPolicy> & { instruction: string },
): { bundle: CharacterKnowledgeBundle; policy: CharacterPresentationPolicy } {
  const bundle: CharacterKnowledgeBundle = {
    entity: normalizeCharacterKnowledgeEntity(bundleInput.entity),
    events: bundleInput.events.map(record => normalizeCharacterKnowledgeRecord(record, "event")),
    policies: bundleInput.policies.map(normalizeCharacterPresentationPolicy),
  };
  const now = new Date().toISOString();
  const existing = input.id ? bundle.policies.find(policy => policy.id === input.id) : undefined;
  if (input.id && !existing) throw new Error(`表达政策不存在：${input.id}`);
  const policy = normalizeCharacterPresentationPolicy({
    ...existing,
    ...input,
    id: existing?.id ?? input.id,
    characterId: bundle.entity.id,
    revision: existing ? existing.revision + 1 : 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  const policies = [...bundle.policies.filter(item => item.id !== policy.id), policy];
  return {
    bundle: {
      ...bundle,
      entity: { ...bundle.entity, revision: bundle.entity.revision + 1, updatedAt: now },
      policies,
    },
    policy,
  };
}

function projectionRecords(bundle: CharacterKnowledgeBundle, purpose: CharacterContextPurpose): CharacterKnowledgeRecord[] {
  const all = [...bundle.entity.records, ...bundle.events];
  if (purpose === "history") {
    return all.filter(record => record.type === "event"
      || (record.type === "goal" && (record.payload.status === "achieved" || record.payload.status === "abandoned"))
      || record.status === "superseded");
  }
  if (purpose === "author") return all.filter(record => record.status !== "retracted");
  const active = all.filter(record => ACTIVE_STATUSES.has(record.status));
  if (purpose === "writing" || purpose === "roleplay") {
    const goals = active.filter(record => record.type === "goal" && record.payload.status !== "achieved" && record.payload.status !== "abandoned")
      .sort((left, right) => intValue(right.payload.priority) - intValue(left.payload.priority)).slice(0, 3);
    const latestState = active.filter(record => record.type === "story_state")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 1);
    return active.filter(record => record.type !== "goal" && record.type !== "story_state" && record.type !== "event")
      .concat(goals, latestState);
  }
  if (purpose === "review") return active;
  return [];
}

export function characterKnowledgeProjection(
  bundle: CharacterKnowledgeBundle,
  purpose: CharacterContextPurpose,
  options: { recordTypes?: CharacterKnowledgeRecordType[]; cursor?: number; limit?: number } = {},
): Record<string, unknown> {
  const entity = bundle.entity;
  const activePolicies = bundle.policies.filter(policy => policy.status === "active" && policy.appliesTo.includes(
    purpose === "catalog" || purpose === "history" ? "author" : purpose,
  ));
  const header = {
    ref: `project:${entity.id}`,
    id: entity.id,
    key: entity.key,
    revision: entity.revision,
    lifecycle: entity.lifecycle,
    name: entity.name,
    aliases: entity.aliases,
    tags: entity.tags,
    narrativeRole: entity.narrativeRole,
    summary: entity.summary,
    updatedAt: entity.updatedAt,
  };
  if (purpose === "catalog") {
    const counts: Record<string, number> = {};
    for (const record of [...entity.records, ...bundle.events]) {
      if (record.status === "retracted") continue;
      counts[record.type] = (counts[record.type] ?? 0) + 1;
    }
    return { purpose, ...header, recordCounts: counts, policyCount: activePolicies.length };
  }
  const selectedTypes = options.recordTypes?.length ? new Set(options.recordTypes) : undefined;
  const records = projectionRecords(bundle, purpose).filter(record => !selectedTypes || selectedTypes.has(record.type));
  const cursor = Math.max(0, options.cursor ?? 0);
  const limit = Math.max(1, Math.min(20, options.limit ?? 10));
  const page = records.slice(cursor, cursor + limit).map(record => ({
    id: record.id, type: record.type, status: record.status, summary: record.summary,
    payload: (purpose === "writing" || purpose === "roleplay") && record.type === "voice_principle"
      ? Object.fromEntries(Object.entries(record.payload).filter(([key]) => key !== "examples"))
      : record.payload,
    ...(record.validFrom ? { validFrom: record.validFrom } : {}), ...(record.validUntil ? { validUntil: record.validUntil } : {}),
    evidenceCount: record.evidence.length, revision: record.revision,
    ...((purpose === "author" || purpose === "review" || purpose === "history") && record.evidence.length
      ? { evidence: record.evidence.slice(0, 4).map(item => ({ ...item, ...(item.quote ? { quote: item.quote.slice(0, 300) } : {}) })) }
      : {}),
  }));
  return {
    purpose,
    ...header,
    records: page,
    policies: activePolicies.map(policy => ({
      id: policy.id, instruction: policy.instruction, avoid: policy.avoid, allow: policy.allow,
      preferredGuidance: policy.preferredGuidance,
    })),
    page: { cursor, nextCursor: cursor + page.length < records.length ? cursor + page.length : null, total: records.length },
  };
}

export function characterKnowledgeSearchText(bundle: CharacterKnowledgeBundle): string {
  return [
    bundle.entity.name, ...bundle.entity.aliases, ...bundle.entity.tags, bundle.entity.narrativeRole, bundle.entity.summary,
    ...bundle.entity.records.filter(record => record.status !== "retracted").flatMap(record => [record.type, record.summary]),
    ...bundle.events.filter(record => record.status !== "retracted").map(record => record.summary),
  ].join("\n");
}

export function parseCharacterRecordTypes(value: unknown): CharacterKnowledgeRecordType[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("recordTypes 必须是数组");
  const types = [...new Set(value.filter((item): item is CharacterKnowledgeRecordType => RECORD_TYPES.has(item as CharacterKnowledgeRecordType)))];
  if (types.length !== value.length) throw new Error("recordTypes 包含未知类型");
  return types;
}

export function isCharacterContextPurpose(value: unknown): value is CharacterContextPurpose {
  return value === "catalog" || value === "author" || value === "writing" || value === "roleplay" || value === "review" || value === "history";
}
