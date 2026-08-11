import {
  CHARACTER_PORTRAYAL_WRITING_RULE,
  CHARACTER_VOICE_WRITING_RULE,
  characterSummaryCard,
  characterWorkspaceView,
  characterVoiceWritingPayload,
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
import { extractRegisterRisksFromCharacter, rememberRegisterRisks } from "../register_risks.js";
import {
  applyCharacterKnowledgeChanges,
  characterFromKnowledgeBundle,
  characterKnowledgeProjection,
  createCharacterKnowledgeEntity,
  isCharacterContextPurpose,
  normalizeCharacterKnowledgeEntity,
  normalizeCharacterPresentationPolicy,
  parseCharacterRecordTypes,
  upsertCharacterPresentationPolicy,
  type CharacterKnowledgeBundle,
  type CharacterKnowledgeChange,
  type CharacterKnowledgeRecordType,
  type CharacterPresentationPolicy,
} from "../character_knowledge.js";
import type { SessionCharacterCandidate } from "../session_artifacts.js";
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

const RECORD_TYPE_SECTIONS: Record<CharacterKnowledgeRecordType, CharacterSection> = {
  appearance_fact: "profile",
  background_fact: "profile",
  biography_fact: "profile",
  feature: "features",
  capability: "competencies",
  relationship: "relationships",
  voice_principle: "voice",
  psychological_model: "psychology",
  goal: "motivations",
  story_state: "storyState",
  event: "experiences",
  note: "notes",
};

function candidateFromArtifact(args: ToolHandlerArgs, artifactId: number): {
  artifact: NonNullable<ReturnType<ToolHandlerArgs["store"]["sessionArtifactById"]>>;
  candidate: SessionCharacterCandidate;
  bundle?: CharacterKnowledgeBundle;
} {
  const artifact = args.store.sessionArtifactById(args.sessionId, artifactId);
  if (!artifact || artifact.kind !== "character_candidate") throw new Error("Session 人物候选不存在");
  let candidate: SessionCharacterCandidate;
  try { candidate = JSON.parse(artifact.content) as SessionCharacterCandidate; }
  catch { throw new Error("Session 人物候选已损坏"); }
  let bundle: CharacterKnowledgeBundle | undefined;
  if (candidate.knowledgeEntity) {
    bundle = {
      entity: normalizeCharacterKnowledgeEntity(candidate.knowledgeEntity),
      events: [],
      policies: (candidate.knowledgePolicies ?? []).map(normalizeCharacterPresentationPolicy),
    };
  }
  return { artifact, candidate, bundle };
}

function parseCharacterRef(input: Record<string, unknown>): { kind: "project"; id: number } | { kind: "session"; artifactId: number } | undefined {
  const id = optionalPositiveInteger(input.id, "id");
  if (id) return { kind: "project", id };
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  let match = /^project:(\d+)$/u.exec(ref);
  if (match) return { kind: "project", id: Number(match[1]) };
  match = /^session:(\d+)$/u.exec(ref);
  if (match) return { kind: "session", artifactId: Number(match[1]) };
  return undefined;
}

function assertProjectCharacterScope(id: number, characterScope: number[] | undefined): void {
  if (characterScope !== undefined && !characterScope.includes(id)) throw new Error("该角色不在本次可读范围内");
}

export function handleSearchCharacters(args: ToolHandlerArgs): string {
  const { input, store, sessionId, characterScope } = args;
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length > 500) throw new Error("角色搜索 query 最多 500 字符");
  const mode = input.mode === "regex" ? "regex" : "literal";
  const limit = Math.max(1, Math.min(50, Math.floor(Number(input.limit ?? 20)) || 20));
  const allowed = characterScope === undefined ? undefined : new Set(characterScope);
  const projectMatches = store.searchCharacterKnowledge(query, {
    mode,
    caseSensitive: input.caseSensitive === true,
    limit: 50,
  }).filter(item => !allowed || allowed.has(Number(item.id)));
  const knownNames = new Set(projectMatches.flatMap(item => [String(item.name ?? ""), ...(Array.isArray(item.aliases) ? item.aliases.map(String) : [])])
    .map(value => value.toLocaleLowerCase()).filter(Boolean));
  const candidateMatches = store.findSessionArtifacts(sessionId, { kinds: ["character_candidate"], statuses: ["active"], limit: 100 })
    .flatMap(artifact => {
      try {
        const candidate = JSON.parse(artifact.content) as SessionCharacterCandidate;
        if (candidate.status === "promoted" || knownNames.has(candidate.name.toLocaleLowerCase())) return [];
        const haystack = [candidate.name, ...candidate.aliases, candidate.summary].join("\n");
        let matches = !query;
        if (query && mode === "regex") {
          let expression: RegExp;
          try { expression = new RegExp(query, input.caseSensitive === true ? "u" : "iu"); }
          catch (error) { throw new Error(`无效正则表达式：${error instanceof Error ? error.message : String(error)}`); }
          matches = expression.test(haystack);
        } else if (query) {
          matches = (input.caseSensitive === true ? haystack : haystack.toLocaleLowerCase())
            .includes(input.caseSensitive === true ? query : query.toLocaleLowerCase());
        }
        return matches ? [{
          ref: `session:${artifact.id}`,
          scope: "session",
          lifecycle: candidate.status,
          name: candidate.name,
          aliases: candidate.aliases,
          summary: candidate.summary,
          revision: candidate.knowledgeEntity && typeof candidate.knowledgeEntity.revision === "number"
            ? candidate.knowledgeEntity.revision : 1,
          updatedAt: artifact.updatedAt,
        }] : [];
      } catch { return []; }
    });
  return JSON.stringify({
    status: "character_catalog",
    results: [...projectMatches, ...candidateMatches].slice(0, limit),
    count: Math.min(limit, projectMatches.length + candidateMatches.length),
    message: "ref 是后续读取/修改的稳定定位；按目的调用 get_character_context，不要请求整卡。",
  });
}

export function handleGetCharacterContext(args: ToolHandlerArgs): string {
  const { input, store, characterScope } = args;
  const ref = parseCharacterRef(input);
  if (!ref) throw new Error("缺少有效 ref 或 id");
  const purpose = input.purpose ?? "catalog";
  if (!isCharacterContextPurpose(purpose)) throw new Error("purpose 无效");
  const recordTypes = parseCharacterRecordTypes(input.recordTypes);
  const cursor = Math.max(0, Math.floor(Number(input.cursor ?? 0)) || 0);
  const limit = Math.max(1, Math.min(20, Math.floor(Number(input.limit ?? 10)) || 10));
  if (ref.kind === "session") {
    const candidate = candidateFromArtifact(args, ref.artifactId);
    if (!candidate.bundle) {
      return JSON.stringify({
        purpose,
        ref: `session:${ref.artifactId}`,
        scope: "session",
        lifecycle: candidate.candidate.status,
        name: candidate.candidate.name,
        aliases: candidate.candidate.aliases,
        summary: candidate.candidate.summary,
        legacy: true,
        message: "这是旧 Session 候选摘要；需要修改时 change_character_knowledge 会把它转换为 v4 候选实体。",
      });
    }
    return JSON.stringify({
      ...characterKnowledgeProjection(candidate.bundle, purpose, { recordTypes, cursor, limit }),
      ref: `session:${ref.artifactId}`,
      scope: "session",
    });
  }
  assertProjectCharacterScope(ref.id, characterScope);
  if (purpose !== "writing") {
    return JSON.stringify(store.characterKnowledgeContext(ref.id, purpose, { recordTypes, cursor, limit }));
  }
  const policyProjection = store.characterKnowledgeContext(ref.id, "writing", { recordTypes: [], cursor: 0, limit: 1 });
  if (!recordTypes?.length) {
    const safe = JSON.parse(handleGetCharacter({ ...args, input: { id: ref.id, view: "summary" } })) as Record<string, unknown>;
    return JSON.stringify({ purpose: "writing", ref: `project:${ref.id}`, revision: policyProjection.revision, context: safe, policies: policyProjection.policies });
  }
  const sections = [...new Set(recordTypes.map(type => RECORD_TYPE_SECTIONS[type]))];
  const safeInput: Record<string, unknown> = {
    id: ref.id,
    view: "sections",
    sections,
    ...(typeof input.outlineNodeId === "string" ? { outlineNodeId: input.outlineNodeId } : {}),
    ...(Array.isArray(input.competencyIds) ? { competencyIds: input.competencyIds } : {}),
  };
  const safe = JSON.parse(handleGetCharacter({ ...args, input: safeInput })) as Record<string, unknown>;
  return JSON.stringify({
    purpose: "writing",
    ref: `project:${ref.id}`,
    revision: policyProjection.revision,
    context: safe,
    policies: policyProjection.policies,
    message: "context 是本次写作用途投影；未返回的记录不是本场可用事实或能力许可。",
  });
}

function parseKnowledgeChanges(value: unknown): CharacterKnowledgeChange[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error("changes 须为 1—20 条知识操作");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`changes[${index}] 必须是对象`);
    const change = item as Record<string, unknown>;
    if (change.op !== "set_identity" && change.op !== "set_lifecycle" && change.op !== "upsert_record"
      && change.op !== "supersede_record" && change.op !== "retract_record") {
      throw new Error(`changes[${index}].op 无效`);
    }
    return change as CharacterKnowledgeChange;
  });
}

function candidateKnowledgeIds(args: ToolHandlerArgs): number[] {
  return args.store.findSessionArtifacts(args.sessionId, { kinds: ["character_candidate"], statuses: ["active"], limit: 200 })
    .flatMap(artifact => {
      try {
        const candidate = JSON.parse(artifact.content) as SessionCharacterCandidate;
        return candidate.knowledgeEntity && Number.isInteger(Number(candidate.knowledgeEntity.id))
          ? [Number(candidate.knowledgeEntity.id)] : [];
      } catch { return []; }
    });
}

export function handleChangeCharacterKnowledge(args: ToolHandlerArgs): string {
  const { input, store, sessionId, emit, characterScope, context } = args;
  assertWritableMode(context.permissionMode, "change_character_knowledge");
  const ref = parseCharacterRef(input);
  const changes = parseKnowledgeChanges(input.changes);
  const summary = requireString(input.summary, "summary").slice(0, 500);
  const projectIds = new Set(store.characterKnowledgeBundles().map(bundle => bundle.entity.id));
  const readableProjectIds = characterScope === undefined ? projectIds : new Set(characterScope.filter(id => projectIds.has(id)));
  const knownIds = new Set([...readableProjectIds, ...candidateKnowledgeIds(args)]);

  if ((context.characterPersistenceIntent ?? "full") !== "full") {
    if (ref?.kind === "project") throw new Error("当前正文任务不能修改项目级角色知识；请保留为 Session 候选或由用户明确要求角色资产修改");
    const existing = ref?.kind === "session" ? candidateFromArtifact(args, ref.artifactId) : undefined;
    const name = typeof input.name === "string" ? input.name.trim() : existing?.candidate.name ?? "";
    if (!name) throw new Error("新建 Session 人物候选必须提供 name");
    const id = existing?.bundle?.entity.id ?? Math.max(store.nextCharacterKnowledgeId() - 1, ...candidateKnowledgeIds(args), 0) + 1;
    const base: CharacterKnowledgeBundle = existing?.bundle ?? {
      entity: createCharacterKnowledgeEntity({ id, name, scope: "session", lifecycle: "candidate", summary }),
      events: [],
      policies: [],
    };
    const expectedRevision = Number(input.expectedRevision);
    if (existing?.bundle && (!Number.isInteger(expectedRevision) || expectedRevision !== base.entity.revision)) {
      throw new Error(`候选实体已变化；当前 revision=${base.entity.revision}`);
    }
    knownIds.add(id);
    const result = applyCharacterKnowledgeChanges(base, changes, knownIds);
    const artifact = store.saveSessionCharacterCandidate(sessionId, {
      name: result.bundle.entity.name,
      aliases: result.bundle.entity.aliases,
      status: result.bundle.entity.lifecycle === "active" ? "confirmed" : "planned",
      summary: result.bundle.entity.summary || summary,
      knowledgeEntity: result.bundle.entity as unknown as Record<string, unknown>,
      knowledgePolicies: result.bundle.policies as unknown as Array<Record<string, unknown>>,
      source: {
        ...(context.sourceMessageId ? { sourceMessageId: context.sourceMessageId } : {}),
        ...(context.lastWritePackArtifactId ? { artifactId: context.lastWritePackArtifactId } : {}),
      },
    });
    if (existing && existing.artifact.id !== artifact.id) {
      store.updateSessionArtifactStatus(sessionId, existing.artifact.id, "superseded");
    }
    return JSON.stringify({
      status: "saved",
      scope: "session",
      ref: `session:${artifact.id}`,
      revision: result.bundle.entity.revision,
      name: result.bundle.entity.name,
      changedRecordIds: result.changedRecordIds,
      warnings: result.warnings,
      message: "人物知识已保存到本 Session 资料库；未写入项目角色库。",
    });
  }

  let before: CharacterKnowledgeBundle | undefined;
  let operation: "create" | "replace";
  let candidateArtifactId: number | undefined;
  if (ref?.kind === "project") {
    assertProjectCharacterScope(ref.id, characterScope);
    before = store.characterKnowledgeBundle(ref.id);
    if (!before) throw new Error("要修改的角色不存在");
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== before.entity.revision) {
      throw new Error(`角色知识已变化；当前 revision=${before.entity.revision}，请重新读取用途投影`);
    }
    operation = "replace";
  } else if (ref?.kind === "session") {
    const candidate = candidateFromArtifact(args, ref.artifactId);
    candidateArtifactId = ref.artifactId;
    const projectId = store.nextCharacterKnowledgeId();
    before = candidate.bundle ? {
      ...candidate.bundle,
      entity: { ...candidate.bundle.entity, id: projectId, scope: "project", lifecycle: "active" },
      policies: candidate.bundle.policies.map(policy => ({ ...policy, characterId: projectId })),
    } : {
      entity: createCharacterKnowledgeEntity({ id: projectId, name: candidate.candidate.name, aliases: candidate.candidate.aliases, summary: candidate.candidate.summary }),
      events: [], policies: [],
    };
    operation = "create";
  } else {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new Error("新建项目角色必须提供 name");
    before = { entity: createCharacterKnowledgeEntity({ id: store.nextCharacterKnowledgeId(), name, summary }), events: [], policies: [] };
    operation = "create";
  }
  const projectKnownIds = new Set(readableProjectIds);
  projectKnownIds.add(before.entity.id);
  const result = applyCharacterKnowledgeChanges(before, changes, projectKnownIds);
  const afterCharacter = characterFromKnowledgeBundle(result.bundle);
  const changeSet = store.createChangeSet(sessionId, summary, [], [{
    operation,
    characterId: afterCharacter.id,
    reason: summary,
    changes: [],
    after: afterCharacter,
    ...(operation === "replace" ? { expectedUpdatedAt: characterFromKnowledgeBundle(before).updatedAt } : {}),
  }], context.sourceMessageId);
  emit({ type: "change_set", changeSet });
  if (context.permissionMode !== "auto") {
    return JSON.stringify({
      status: "pending", scope: "project", ref: `project:${afterCharacter.id}`, revision: result.bundle.entity.revision,
      changeSetId: changeSet.id, name: result.bundle.entity.name, changedRecordIds: result.changedRecordIds,
      warnings: result.warnings, message: "角色知识事务已进入待审批队列；项目知识库尚未修改。",
    });
  }
  const accepted = store.acceptChangeSet(changeSet.id);
  emit({ type: "change_set", changeSet: accepted });
  if (characterScope && !characterScope.includes(afterCharacter.id)) characterScope.push(afterCharacter.id);
  if (candidateArtifactId) {
    const promoted = store.saveSessionCharacterCandidate(sessionId, {
      name: result.bundle.entity.name, aliases: result.bundle.entity.aliases, status: "promoted",
      summary: result.bundle.entity.summary || summary, promotedCharacterId: afterCharacter.id,
    });
    if (promoted.id !== candidateArtifactId) store.updateSessionArtifactStatus(sessionId, candidateArtifactId, "superseded");
  }
  return JSON.stringify({
    status: "accepted", scope: "project", ref: `project:${afterCharacter.id}`, revision: result.bundle.entity.revision,
    changeSetId: accepted.id, name: result.bundle.entity.name, changedRecordIds: result.changedRecordIds,
    warnings: result.warnings, autoAccepted: true, message: "角色知识事务已原子应用。",
  });
}

function knowledgeFactFingerprint(bundle: CharacterKnowledgeBundle): string {
  return JSON.stringify({
    identity: {
      name: bundle.entity.name, aliases: bundle.entity.aliases, tags: bundle.entity.tags,
      narrativeRole: bundle.entity.narrativeRole, summary: bundle.entity.summary, lifecycle: bundle.entity.lifecycle,
    },
    records: bundle.entity.records,
    events: bundle.events,
  });
}

export function handleReviseCharacterExpression(args: ToolHandlerArgs): string {
  const { input, store, sessionId, emit, characterScope, context } = args;
  assertWritableMode(context.permissionMode, "revise_character_expression");
  const ref = parseCharacterRef(input);
  if (!ref) throw new Error("缺少有效 ref 或 id");
  const instruction = requireString(input.instruction, "instruction");
  const appliesTo = Array.isArray(input.appliesTo)
    ? input.appliesTo.filter((item): item is CharacterPresentationPolicy["appliesTo"][number] =>
      item === "author" || item === "writing" || item === "roleplay" || item === "review")
    : undefined;
  const policyInput: Partial<CharacterPresentationPolicy> & { instruction: string } = {
    ...(typeof input.policyId === "string" && input.policyId.trim() ? { id: input.policyId.trim() } : {}),
    instruction,
    ...(appliesTo ? { appliesTo } : {}),
    avoid: Array.isArray(input.avoid) ? input.avoid.filter((item): item is string => typeof item === "string") : [],
    allow: Array.isArray(input.allow) ? input.allow.filter((item): item is string => typeof item === "string") : [],
    preferredGuidance: typeof input.preferredGuidance === "string" ? input.preferredGuidance : "",
    status: input.status === "paused" ? "paused" as const : "active" as const,
  };
  if (ref.kind === "session") {
    const candidate = candidateFromArtifact(args, ref.artifactId);
    if (!candidate.bundle) throw new Error("旧候选需先用 change_character_knowledge 转换为 v4 实体");
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision !== candidate.bundle.entity.revision) {
      throw new Error(`候选实体已变化；当前 revision=${candidate.bundle.entity.revision}`);
    }
    const beforeFacts = knowledgeFactFingerprint(candidate.bundle);
    const revised = upsertCharacterPresentationPolicy(candidate.bundle, policyInput);
    if (knowledgeFactFingerprint(revised.bundle) !== beforeFacts) throw new Error("表达修订触碰了人物事实，事务已拒绝");
    const artifact = store.saveSessionCharacterCandidate(sessionId, {
      name: revised.bundle.entity.name, aliases: revised.bundle.entity.aliases,
      status: candidate.candidate.status, summary: candidate.candidate.summary,
      knowledgeEntity: revised.bundle.entity as unknown as Record<string, unknown>,
      knowledgePolicies: revised.bundle.policies as unknown as Array<Record<string, unknown>>,
    });
    return JSON.stringify({
      status: "saved", scope: "session", ref: `session:${artifact.id}`, revision: revised.bundle.entity.revision,
      policyId: revised.policy.id, factHashPreserved: true, message: "表达政策已更新；人物事实未改变。",
    });
  }
  assertProjectCharacterScope(ref.id, characterScope);
  assertCharacterWorkspaceIntent(context);
  const before = store.characterKnowledgeBundle(ref.id);
  if (!before) throw new Error("角色不存在");
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== before.entity.revision) {
    throw new Error(`角色知识已变化；当前 revision=${before.entity.revision}`);
  }
  const beforeFacts = knowledgeFactFingerprint(before);
  const revised = upsertCharacterPresentationPolicy(before, policyInput);
  if (knowledgeFactFingerprint(revised.bundle) !== beforeFacts) throw new Error("表达修订触碰了人物事实，事务已拒绝");
  const summary = typeof input.summary === "string" && input.summary.trim() ? input.summary.trim() : `调整「${before.entity.name}」的表达政策`;
  const after = characterFromKnowledgeBundle(revised.bundle);
  const changeSet = store.createChangeSet(sessionId, summary, [], [{
    operation: "replace", characterId: ref.id, reason: summary, changes: [], after,
    expectedUpdatedAt: characterFromKnowledgeBundle(before).updatedAt,
  }], context.sourceMessageId);
  emit({ type: "change_set", changeSet });
  if (context.permissionMode !== "auto") {
    return JSON.stringify({
      status: "pending", scope: "project", ref: `project:${ref.id}`, revision: revised.bundle.entity.revision,
      policyId: revised.policy.id, changeSetId: changeSet.id, factHashPreserved: true,
      message: "表达政策已进入待审批队列；项目知识库尚未修改。",
    });
  }
  const accepted = store.acceptChangeSet(changeSet.id);
  emit({ type: "change_set", changeSet: accepted });
  return JSON.stringify({
    status: "accepted", scope: "project", ref: `project:${ref.id}`, revision: revised.bundle.entity.revision,
    policyId: revised.policy.id, changeSetId: accepted.id, factHashPreserved: true, autoAccepted: true,
    message: "表达政策已原子应用；人物事实未改变。",
  });
}

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

export function handleGetCharacter({ input, store, project, sessionId, characterScope, context }: ToolHandlerArgs): string {
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
      selected.voice = characterVoiceWritingPayload(character.voice);
      selected.writingMemory = store.writingMemoryPacket(sessionId, {
        targetPath: activePath,
        characterIds: [character.id],
        limit: 8,
      }).map(entry => ({
        kind: entry.kind,
        content: entry.content,
        evidence: entry.sourceEvidence,
        sourcePath: entry.sourcePath,
        rule: "当前会话的近期辅助状态；不得覆盖角色卡或正文，禁止照抄对白措辞。",
      }));
      selected.voiceScope = {
        characterId: character.id,
        name: character.identity.name,
        appliesTo: "spoken_dialogue_only",
        rule: `仅约束该角色说出口的对白；不要迁移到叙述、动作描写或其他角色的对白。${CHARACTER_VOICE_WRITING_RULE}`,
      };
      selected.portrayalRule = CHARACTER_PORTRAYAL_WRITING_RULE;
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
  // Accumulate do-not-quote phrasing for later write-pack / naturalness gates.
  if (sections.some(section =>
    section === "voice" || section === "competencies" || section === "psychology" || section === "features"
  )) {
    rememberRegisterRisks(context, extractRegisterRisksFromCharacter(character));
    const riskCount = (context.registerRisks ?? []).filter(risk => risk.characterId === character.id).length;
    if (riskCount > 0) {
      selected.registerRiskNotice = {
        characterId: character.id,
        riskCount,
        rule: "本角色卡的示例句、能力学名与心理标签不得直接写入对白或贴身叙述；保留事实，换成本场自然说法。正式汇报除外。",
      };
    }
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

function assertCharacterWorkspaceIntent(context: ToolHandlerArgs["context"]): void {
  if ((context.characterPersistenceIntent ?? "full") !== "full") {
    throw new Error("当前任务没有创建或编辑项目角色资产的权限；正文中新人物应保留为会话候选");
  }
}

export function handleOpenCharacterDraft({ input, store, sessionId, characterScope, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "open_character_draft");
  assertCharacterWorkspaceIntent(context);
  const id = optionalPositiveInteger(input.id, "id");
  if (id && characterScope !== undefined && !characterScope.includes(id)) {
    throw new Error("不能打开范围外的已有角色；新建角色请省略 id 并提供 name");
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const draft = store.openSessionCharacterDraft(sessionId, {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(typeof input.summary === "string" ? { summary: input.summary } : {}),
  });
  return JSON.stringify({
    status: "editing",
    draftId: draft.draftId,
    revision: draft.revision,
    created: !draft.baseCharacterId,
    character: characterWorkspaceView(draft.character),
    message: "角色工作副本已打开；后续只提交需要变化的紧凑字段。",
  });
}

export function handleUpdateCharacterDraft({ input, store, sessionId, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "update_character_draft");
  assertCharacterWorkspaceIntent(context);
  const draftId = requireString(input.draftId, "draftId");
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("revision 必须是工作副本返回的正整数");
  const hasPatch = input.patch && typeof input.patch === "object" && !Array.isArray(input.patch);
  const rawChanges = Array.isArray(input.changes) ? input.changes : [];
  if (!hasPatch && !rawChanges.length) throw new Error("至少提供 patch 或 changes 之一");
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "角色工作副本编辑";
  const draft = store.updateSessionCharacterDraft(sessionId, draftId, revision, {
    ...(hasPatch ? { patch: input.patch } : {}),
    ...(rawChanges.length ? {
      changes: {
        reason,
        changes: rawChanges
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
          .map(item => ({ op: String(item.op ?? ""), ...item })),
      },
    } : {}),
    ...(typeof input.summary === "string" ? { summary: input.summary } : {}),
  });
  return JSON.stringify({
    status: "editing",
    draftId: draft.draftId,
    revision: draft.revision,
    character: characterWorkspaceView(draft.character),
    message: "角色工作副本已保存；无须重新提交整张角色卡。",
  });
}

export function handleSubmitCharacterDraft({ input, store, sessionId, emit, characterScope, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "submit_character_draft");
  assertCharacterWorkspaceIntent(context);
  const draftId = requireString(input.draftId, "draftId");
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("revision 必须是工作副本返回的正整数");
  const draft = store.sessionCharacterDraft(sessionId, draftId);
  if (draft.status !== "editing") {
    if (draft.status === "stale" || draft.status === "discarded") {
      throw new Error("角色工作副本已经失效；请重新打开角色以取得最新项目状态");
    }
    return JSON.stringify({
      status: draft.status === "applied" ? "accepted" : "pending",
      draftId,
      revision: draft.revision,
      ...(draft.changeSetId ? { changeSetId: draft.changeSetId } : {}),
      message: draft.status === "applied" ? "角色变更已经应用" : "角色变更已经提交，正在等待审批",
    });
  }
  if (draft.revision !== revision) throw new Error(`角色工作副本已更新；当前 revision=${draft.revision}，请提交最新版本`);
  const character = draft.character;
  const reason = typeof input.summary === "string" && input.summary.trim()
    ? input.summary.trim()
    : draft.summary;
  const operation = draft.baseCharacterId ? "replace" as const : "create" as const;
  const changeSet = store.createChangeSet(sessionId, reason, [], [{
    operation,
    characterId: character.id,
    reason,
    changes: [],
    after: character,
    ...(draft.baseUpdatedAt ? { expectedUpdatedAt: draft.baseUpdatedAt } : {}),
  }], context.sourceMessageId);
  store.markSessionCharacterDraft(sessionId, draftId, "submitted", changeSet.id);
  emit({ type: "change_set", changeSet });
  if (context.permissionMode !== "auto") {
    return JSON.stringify({
      status: "pending",
      draftId,
      revision,
      changeSetId: changeSet.id,
      characterId: character.id,
      name: character.identity.name,
      message: "角色变更已进入待审批队列；项目角色库尚未修改。",
    });
  }
  const accepted = store.acceptChangeSet(changeSet.id);
  emit({ type: "change_set", changeSet: accepted });
  if (characterScope && !characterScope.includes(character.id)) characterScope.push(character.id);
  return JSON.stringify({
    status: "accepted",
    draftId,
    revision,
    changeSetId: accepted.id,
    characterId: character.id,
    name: character.identity.name,
    autoAccepted: true,
    message: "角色工作副本已原子提交到项目角色库。",
  });
}

export function handleSaveCharacter({ input, store, sessionId, characterScope, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "save_character");
  const id = typeof input.id === "number" && Number.isInteger(input.id) && input.id > 0 ? input.id : undefined;
  const existing = id ? store.characters().find(item => item.id === id) : undefined;
  if (id && !existing) throw new Error("要修改的角色不存在");
  const identity = input.identity && typeof input.identity === "object" && !Array.isArray(input.identity)
    ? input.identity as CharacterInput["identity"]
    : undefined;
  if (!existing && !identity?.name?.trim()) throw new Error("新建角色必须提供 identity.name");
  if ((context.characterPersistenceIntent ?? "full") !== "full") {
    if (id) {
      throw new Error("当前任务未请求修改项目级角色卡；正文已确认的角色状态请使用 apply_character_changes，候选构思保留在会话资料中");
    }
    const name = identity!.name.trim();
    const artifact = store.saveSessionCharacterCandidate(sessionId, {
      name,
      aliases: Array.isArray(identity?.aliases)
        ? identity.aliases.filter((value): value is string => typeof value === "string")
        : [],
      status: "planned",
      summary: [identity?.narrativeRole, identity?.summary]
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .join("；") || "正文规划中产生的暂定配角",
      proposedCard: input,
      source: {
        ...(context.sourceMessageId ? { sourceMessageId: context.sourceMessageId } : {}),
        ...(context.lastWritePackArtifactId ? { artifactId: context.lastWritePackArtifactId } : {}),
      },
    });
    return JSON.stringify({
      status: "candidate_saved",
      storedAs: "session_character_candidate",
      artifactId: artifact.id,
      name,
      created: true,
      message: "当前正文任务未请求建立项目级角色卡；已将人物构思保存为会话候选，可继续写作。",
    });
  }
  const expectedUpdatedAt = typeof input.expectedUpdatedAt === "string" ? input.expectedUpdatedAt.trim() : "";
  if (id && !expectedUpdatedAt) throw new Error("更新已有角色卡必须提供 expectedUpdatedAt");
  if (existing && expectedUpdatedAt !== existing.updatedAt) {
    throw new Error("角色卡已被其他操作更新；请重新读取后再修改");
  }
  if (id && characterScope !== undefined && !characterScope.includes(id)) {
    throw new Error("不能修改范围外的已有角色卡；新建请省略 id");
  }
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

export function handleSaveSimpleCharacter({ input, store, sessionId, context }: ToolHandlerArgs): string {
  assertWritableMode(context.permissionMode, "save_simple_character");
  const id = optionalPositiveInteger(input.id, "id");
  if ((context.characterPersistenceIntent ?? "simple") !== "simple") {
    if (id || context.characterPersistenceIntent === "full") {
      throw new Error("当前任务未请求创建或更新简易角色卡；不要用简易卡替代普通角色卡或正文人物候选");
    }
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new Error("人物候选缺少名称");
    const summary = [input.identity, input.relationship, input.goal]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .join("；");
    const artifact = store.saveSessionCharacterCandidate(sessionId, {
      name,
      status: "planned",
      summary: summary || "正文规划中产生的暂定配角",
      proposedCard: input,
      source: {
        ...(context.sourceMessageId ? { sourceMessageId: context.sourceMessageId } : {}),
        ...(context.lastWritePackArtifactId ? { artifactId: context.lastWritePackArtifactId } : {}),
      },
    });
    return JSON.stringify({
      status: "candidate_saved",
      storedAs: "session_character_candidate",
      artifactId: artifact.id,
      name,
      created: true,
      message: "当前正文任务未请求建立简易角色卡；已保存为会话人物候选。",
    });
  }
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
