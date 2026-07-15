import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ActiveRoleplayState, AgentTodoItem, Character, DocumentVersionDetail, DocumentVersionMeta, Message, MessageChannel, Proposal, ProposalCharacterChange,
  RoleplayInterlocutor, RoleplayParticipant, RoleplaySessionMemory, RoleplayWorkingState, SavedRoleplayInterlocutor, StyleTemplate, TokenPricing, UsageSummary, WritingExample,
} from "./types.js";
import { blockAtOffset, documentBlocks } from "./document_blocks.js";
import {
  applyCharacterChanges as applyCharacterChangesCore,
  applyCharacterInput,
  characterName,
  emptyCharacter,
  migrateV2Character,
  normalizeV3Character,
  validateCharacters,
  type AppliedCharacterChange,
  type ApplyCharacterChangesInput,
  type CharacterInput,
  type SkippedCharacterChange,
} from "./characters.js";
import { OutlineStore } from "./outline.js";
import { calculateUsageCost } from "./pricing.js";
import { WriterProject } from "./project.js";

type Row = Record<string, unknown>;
type ProposalCharacterRevision = { characterId: number; before: Character; after: Character };

function parseProposalCharacterChanges(value: unknown): ProposalCharacterChange[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ProposalCharacterChange => Boolean(
      item && typeof item === "object" && !Array.isArray(item)
      && Number.isInteger((item as { characterId?: unknown }).characterId)
      && typeof (item as { reason?: unknown }).reason === "string"
      && Array.isArray((item as { changes?: unknown }).changes),
    ));
  } catch {
    return [];
  }
}

function parseProposalCharacterRevisions(value: unknown): ProposalCharacterRevision[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as ProposalCharacterRevision[] : [];
  } catch {
    return [];
  }
}

export class WriterStore {
  readonly database: DatabaseSync;

  constructor(readonly project: WriterProject) {
    mkdirSync(project.privateDir, { recursive: true });
    this.database = new DatabaseSync(resolve(project.privateDir, "writer.db"));
    try {
      this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      this.migrate();
      this.migrateCharacterCardsToJsonl();
      this.reindex();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        auto_title_done INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        version_index INTEGER NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, group_id, version_index)
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        summary TEXT NOT NULL,
        before_content TEXT NOT NULL,
        after_content TEXT NOT NULL,
        base_hash TEXT NOT NULL,
        character_changes_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id INTEGER,
        path TEXT NOT NULL,
        before_content TEXT NOT NULL,
        after_content TEXT NOT NULL,
        after_hash TEXT NOT NULL,
        created_file INTEGER NOT NULL DEFAULT 0,
        character_revisions_json TEXT NOT NULL DEFAULT '[]',
        undone INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS writing_examples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roleplay_interlocutors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_character_id INTEGER,
        name TEXT NOT NULL,
        identity TEXT NOT NULL DEFAULT '',
        relationship TEXT NOT NULL DEFAULT '',
        knowledge TEXT NOT NULL DEFAULT '',
        scene TEXT NOT NULL DEFAULT '',
        goal TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_roleplays (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        character_id INTEGER NOT NULL,
        interlocutor_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roleplay_memory (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        performer_key TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        summarized_through_id INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL DEFAULT '{}',
        turn_count INTEGER NOT NULL DEFAULT 0,
        same_beat_turns INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
        cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'CNY',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS writing_drafts (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        instruction TEXT NOT NULL,
        path TEXT,
        selection TEXT,
        draft TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS context_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        cache_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        source_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        UNIQUE(session_id, cache_key)
      );
      CREATE TABLE IF NOT EXISTS session_context (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        active_document TEXT,
        current_intent TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS character_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        before_file TEXT,
        after_file TEXT NOT NULL,
        before_content TEXT,
        after_content TEXT NOT NULL,
        undone INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS document_index USING fts5(path UNINDEXED, content);
    `);
    const revisionColumns = this.database.prepare("PRAGMA table_info(revisions)").all() as Row[];
    if (!revisionColumns.some(column => column.name === "created_file")) {
      this.database.exec("ALTER TABLE revisions ADD COLUMN created_file INTEGER NOT NULL DEFAULT 0");
    }
    if (!revisionColumns.some(column => column.name === "character_revisions_json")) {
      this.database.exec("ALTER TABLE revisions ADD COLUMN character_revisions_json TEXT NOT NULL DEFAULT '[]'");
    }
    const proposalColumns = this.database.prepare("PRAGMA table_info(proposals)").all() as Row[];
    if (!proposalColumns.some(column => column.name === "character_changes_json")) {
      this.database.exec("ALTER TABLE proposals ADD COLUMN character_changes_json TEXT NOT NULL DEFAULT '[]'");
    }
    const sessionColumns = this.database.prepare("PRAGMA table_info(sessions)").all() as Row[];
    if (!sessionColumns.some(column => column.name === "auto_title_done")) {
      this.database.exec("ALTER TABLE sessions ADD COLUMN auto_title_done INTEGER NOT NULL DEFAULT 0");
    }
    const contextColumns = this.database.prepare("PRAGMA table_info(session_context)").all() as Row[];
    if (!contextColumns.some(column => column.name === "todos_json")) {
      this.database.exec("ALTER TABLE session_context ADD COLUMN todos_json TEXT NOT NULL DEFAULT '[]'");
    }
    const messageColumns = this.database.prepare("PRAGMA table_info(messages)").all() as Row[];
    if (!messageColumns.some(column => column.name === "channel")) {
      this.database.exec("ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'agent'");
    }
    if (!messageColumns.some(column => column.name === "variant_group_id")) {
      this.database.exec("ALTER TABLE messages ADD COLUMN variant_group_id TEXT");
    }
    const variantColumns = this.database.prepare("PRAGMA table_info(message_variants)").all() as Row[];
    if (!variantColumns.some(column => column.name === "prompt")) {
      this.database.exec("ALTER TABLE message_variants ADD COLUMN prompt TEXT NOT NULL DEFAULT ''");
    }
  }

  contextArtifact(sessionId: string, cacheKey: string): { id: number; kind: string; path?: string; sourceHash: string; content: string; digest: string } | undefined {
    const row = this.database.prepare("SELECT id,kind,path,source_hash,content,digest FROM context_artifacts WHERE session_id=? AND cache_key=?")
      .get(sessionId, cacheKey) as Row | undefined;
    if (!row) return undefined;
    this.database.prepare("UPDATE context_artifacts SET last_used_at=? WHERE id=?").run(new Date().toISOString(), Number(row.id));
    return { id: Number(row.id), kind: String(row.kind), sourceHash: String(row.source_hash), content: String(row.content), digest: String(row.digest),
      ...(typeof row.path === "string" ? { path: row.path } : {}) };
  }

  contextArtifactById(sessionId: string, id: number): { id: number; kind: string; path?: string; sourceHash: string; content: string; digest: string } | undefined {
    const row = this.database.prepare("SELECT id,kind,path,source_hash,content,digest FROM context_artifacts WHERE session_id=? AND id=?")
      .get(sessionId, id) as Row | undefined;
    if (!row) return undefined;
    return { id: Number(row.id), kind: String(row.kind), sourceHash: String(row.source_hash), content: String(row.content), digest: String(row.digest),
      ...(typeof row.path === "string" ? { path: row.path } : {}) };
  }

  saveContextArtifact(sessionId: string, value: { cacheKey: string; kind: string; path?: string; sourceHash: string; content: string; digest: string }): number {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO context_artifacts(session_id,cache_key,kind,path,source_hash,content,digest,created_at,last_used_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,cache_key) DO UPDATE SET kind=excluded.kind,path=excluded.path,source_hash=excluded.source_hash,
      content=excluded.content,digest=excluded.digest,last_used_at=excluded.last_used_at`)
      .run(sessionId, value.cacheKey, value.kind, value.path ?? null, value.sourceHash, value.content, value.digest, now, now);
    const row = this.database.prepare("SELECT id FROM context_artifacts WHERE session_id=? AND cache_key=?").get(sessionId, value.cacheKey) as Row;
    return Number(row.id);
  }

  recentContextArtifacts(sessionId: string, limit = 6): Array<{ id: number; kind: string; path?: string; sourceHash: string; digest: string }> {
    return this.database.prepare("SELECT id,kind,path,source_hash,digest FROM context_artifacts WHERE session_id=? ORDER BY last_used_at DESC LIMIT ?")
      .all(sessionId, limit).map(raw => {
        const row = raw as Row;
        return { id: Number(row.id), kind: String(row.kind), sourceHash: String(row.source_hash), digest: String(row.digest),
          ...(typeof row.path === "string" ? { path: row.path } : {}) };
      });
  }

  sessionContext(sessionId: string): { activeDocument?: string; currentIntent: string } {
    const row = this.database.prepare("SELECT active_document,current_intent FROM session_context WHERE session_id=?").get(sessionId) as Row | undefined;
    return { currentIntent: typeof row?.current_intent === "string" ? row.current_intent : "",
      ...(typeof row?.active_document === "string" ? { activeDocument: row.active_document } : {}) };
  }

  /**
   * Persist this dialogue turn's task binding. activeDocument is always replaced
   * (null clears); never inherits a previous turn's document via COALESCE.
   * todos_json is left untouched here — use saveSessionTodos / clearSessionTaskState.
   */
  saveSessionContext(sessionId: string, value: { activeDocument?: string; currentIntent: string }): void {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO session_context(session_id,active_document,current_intent,todos_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET active_document=excluded.active_document,
      current_intent=excluded.current_intent,updated_at=excluded.updated_at`)
      .run(sessionId, value.activeDocument ?? null, value.currentIntent, "[]", now);
  }

  /** Drop sticky task residue (todos / intent / active doc / tool memory) when dialogue is rewound or a new non-continuation turn starts. */
  clearSessionTaskState(sessionId: string): void {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO session_context(session_id,active_document,current_intent,todos_json,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET active_document=NULL, current_intent='', todos_json='[]', updated_at=excluded.updated_at`)
      .run(sessionId, null, "", "[]", now);
    this.database.prepare("DELETE FROM context_artifacts WHERE session_id=?").run(sessionId);
  }

  sessionTodos(sessionId: string): AgentTodoItem[] {
    const row = this.database.prepare("SELECT todos_json FROM session_context WHERE session_id=?").get(sessionId) as Row | undefined;
    if (!row || typeof row.todos_json !== "string" || !row.todos_json.trim()) return [];
    try {
      const parsed = JSON.parse(row.todos_json) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const todo = item as Record<string, unknown>;
        if (typeof todo.id !== "string" || typeof todo.content !== "string") return [];
        const status = todo.status === "in_progress" || todo.status === "completed" || todo.status === "cancelled"
          ? todo.status
          : "pending";
        return [{ id: todo.id, content: todo.content, status }];
      });
    } catch {
      return [];
    }
  }

  saveSessionTodos(sessionId: string, todos: AgentTodoItem[]): void {
    const now = new Date().toISOString();
    const json = JSON.stringify(todos);
    const existing = this.database.prepare("SELECT 1 AS ok FROM session_context WHERE session_id=?").get(sessionId) as Row | undefined;
    if (existing) {
      this.database.prepare("UPDATE session_context SET todos_json=?, updated_at=? WHERE session_id=?")
        .run(json, now, sessionId);
      return;
    }
    this.database.prepare(`INSERT INTO session_context(session_id,active_document,current_intent,todos_json,updated_at) VALUES(?,?,?,?,?)`)
      .run(sessionId, null, "", json, now);
  }

  writingDraft(sessionId: string): { mode: string; instruction: string; path?: string; selection?: string; draft: string } | undefined {
    const row = this.database.prepare("SELECT mode,instruction,path,selection,draft FROM writing_drafts WHERE session_id=?").get(sessionId) as Row | undefined;
    if (!row) return undefined;
    return {
      mode: String(row.mode), instruction: String(row.instruction), draft: String(row.draft),
      ...(typeof row.path === "string" ? { path: row.path } : {}),
      ...(typeof row.selection === "string" ? { selection: row.selection } : {}),
    };
  }

  saveWritingDraft(sessionId: string, value: { mode: string; instruction: string; path?: string; selection?: string; draft: string }): void {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO writing_drafts(session_id,mode,instruction,path,selection,draft,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode,instruction=excluded.instruction,path=excluded.path,selection=excluded.selection,draft=excluded.draft,updated_at=excluded.updated_at`)
      .run(sessionId, value.mode, value.instruction, value.path ?? null, value.selection ?? null, value.draft, now, now);
  }

  clearWritingDraft(sessionId: string): void {
    this.database.prepare("DELETE FROM writing_drafts WHERE session_id=?").run(sessionId);
  }

  characters(): Character[] {
    const characters = this.project.readCharacterCardsJsonl().split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        const parsed = JSON.parse(line) as unknown;
        return [this.normalizeCharacter(parsed)];
      } catch (error) { throw new Error(`characters/characters.jsonl:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    });
    validateCharacters(characters, this.outlineNodeIds());
    return characters.sort((a, b) => characterName(a).localeCompare(characterName(b), "zh-CN"));
  }

  saveCharacter(input: CharacterInput): Character {
    const characters = this.characters();
    const existing = input.id ? characters.find(item => item.id === input.id) : undefined;
    if (input.id && !existing) throw new Error("要修改的角色不存在");
    const id = existing?.id ?? Math.max(0, ...characters.map(item => item.id)) + 1;
    const base: Character = existing ?? { ...emptyCharacter(input.identity?.name ?? ""), id, updatedAt: "" };
    const character = applyCharacterInput(base, { ...input, id });
    const next = [...characters.filter(item => item.id !== id), character];
    validateCharacters(next, this.outlineNodeIds());
    this.writeCharacters(next);
    return character;
  }

  /**
   * Apply semantic character evolution ops (unlock, personality, experiences, …)
   * then persist through the normal validation path.
   */
  applyCharacterChanges(
    id: number,
    input: ApplyCharacterChangesInput,
  ): { character: Character; applied: AppliedCharacterChange[]; skipped: SkippedCharacterChange[] } {
    const characters = this.characters();
    const existing = characters.find(item => item.id === id);
    if (!existing) throw new Error("要修改的角色不存在");
    const result = applyCharacterChangesCore(existing, input);
    const next = [...characters.filter(item => item.id !== id), result.character];
    validateCharacters(next, this.outlineNodeIds());
    this.writeCharacters(next);
    return result;
  }

  saveCharacterWithRevision(
    sessionId: string,
    messageId: number,
    input: CharacterInput,
  ): Character {
    const before = input.id ? this.characters().find(item => item.id === input.id) : undefined;
    const beforeContent = before ? JSON.stringify(before) : null;
    const character = this.saveCharacter(input);
    const afterContent = JSON.stringify(character);
    this.database.prepare(`INSERT INTO character_revisions(
      session_id,message_id,character_id,before_file,after_file,before_content,after_content,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      sessionId, messageId, character.id, before ? "characters.jsonl" : null, "characters.jsonl",
      beforeContent, afterContent, new Date().toISOString(),
    );
    return character;
  }

  deleteCharacter(id: number): void {
    const characters = this.characters();
    if (!characters.some(item => item.id === id)) throw new Error("角色不存在");
    this.writeCharacters(characters.filter(item => item.id !== id).map(character => ({
      ...character,
      relationships: character.relationships.filter(item => item.characterId !== id),
    })));
  }

  roleplayInterlocutors(): SavedRoleplayInterlocutor[] {
    return this.database.prepare("SELECT * FROM roleplay_interlocutors ORDER BY updated_at DESC, id DESC").all()
      .map(raw => this.roleplayInterlocutorFromRow(raw as Row));
  }

  saveRoleplayInterlocutor(input: RoleplayInterlocutor & { id?: number; targetCharacterId?: number }): SavedRoleplayInterlocutor {
    const value: RoleplayInterlocutor = {
      name: roleplayField(input.name, "名称", 120, true),
      identity: roleplayField(input.identity, "身份"),
      relationship: roleplayField(input.relationship, "关系"),
      knowledge: roleplayField(input.knowledge, "已知信息"),
      scene: roleplayField(input.scene, "场景"),
      goal: roleplayField(input.goal, "目标"),
    };
    if (input.targetCharacterId !== undefined && (!Number.isInteger(input.targetCharacterId) || input.targetCharacterId < 1)) {
      throw new Error("关联的试演角色 ID 无效");
    }
    const targetCharacterId = input.targetCharacterId;
    if (targetCharacterId && !this.characters().some(item => item.id === targetCharacterId)) throw new Error("关联的试演角色不存在");
    const now = new Date().toISOString();
    if (input.id !== undefined && (!Number.isInteger(input.id) || input.id < 1)) throw new Error("试演身份 ID 无效");
    let id = input.id;
    if (id) {
      const result = this.database.prepare(`UPDATE roleplay_interlocutors SET
        target_character_id=?,name=?,identity=?,relationship=?,knowledge=?,scene=?,goal=?,updated_at=? WHERE id=?`)
        .run(targetCharacterId ?? null, value.name, value.identity, value.relationship, value.knowledge, value.scene, value.goal, now, id);
      if (!result.changes) throw new Error("试演身份不存在");
    } else {
      id = Number(this.database.prepare(`INSERT INTO roleplay_interlocutors(
        target_character_id,name,identity,relationship,knowledge,scene,goal,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        targetCharacterId ?? null, value.name, value.identity, value.relationship, value.knowledge, value.scene, value.goal, now, now,
      ).lastInsertRowid);
    }
    const row = this.database.prepare("SELECT * FROM roleplay_interlocutors WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("试演身份保存失败");
    return this.roleplayInterlocutorFromRow(row);
  }

  deleteRoleplayInterlocutor(id: number): void {
    if (!this.database.prepare("DELETE FROM roleplay_interlocutors WHERE id=?").run(id).changes) {
      throw new Error("试演身份不存在");
    }
  }

  activeRoleplay(sessionId: string): ActiveRoleplayState | undefined {
    const row = this.database.prepare("SELECT character_id,interlocutor_json FROM active_roleplays WHERE session_id=?")
      .get(sessionId) as Row | undefined;
    if (!row) return undefined;
    const characterId = Number(row.character_id);
    let parsed: unknown;
    try { parsed = JSON.parse(String(row.interlocutor_json)); }
    catch {
      this.clearActiveRoleplay(sessionId);
      return undefined;
    }
    const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    if (raw.performer && raw.identity) {
      const performer = this.resolveRoleplayParticipant(raw.performer);
      const identity = this.resolveRoleplayParticipant(raw.identity);
      if (!performer || !identity) {
        this.clearActiveRoleplay(sessionId);
        return undefined;
      }
      return { performer, identity };
    }
    // Compatibility with the previous shape: normal performer + interlocutor JSON.
    const character = this.characters().find(item => item.id === characterId);
    if (!character) {
      this.clearActiveRoleplay(sessionId);
      return undefined;
    }
    const base = normalizeStoredInterlocutor(parsed);
    const savedId = Number(raw.id);
    const saved = Number.isInteger(savedId) && savedId > 0
      ? this.roleplayInterlocutors().find(item => item.id === savedId)
      : undefined;
    return {
      performer: normalRoleplayParticipant(character),
      identity: saved ? simpleRoleplayParticipant(saved) : { kind: "generated", name: base.name, card: base },
    };
  }

  saveActiveRoleplay(
    sessionId: string,
    performerInput: number | RoleplayParticipant,
    identityInput: RoleplayParticipant | RoleplayInterlocutor | SavedRoleplayInterlocutor,
  ): ActiveRoleplayState {
    if (!this.sessionExists(sessionId)) throw new Error("会话不存在");
    const performer = typeof performerInput === "number"
      ? this.characters().find(item => item.id === performerInput)
      : undefined;
    const normalizedPerformer = typeof performerInput === "number"
      ? (performer ? normalRoleplayParticipant(performer) : undefined)
      : this.resolveRoleplayParticipant(performerInput);
    if (!normalizedPerformer || normalizedPerformer.kind === "generated") throw new Error("扮演者角色卡不存在");
    let identity: RoleplayParticipant | undefined;
    if ("kind" in identityInput) identity = this.resolveRoleplayParticipant(identityInput);
    else if ("id" in identityInput) {
      const saved = this.roleplayInterlocutors().find(item => item.id === identityInput.id);
      if (saved) identity = simpleRoleplayParticipant(saved);
    } else {
      const base = normalizeStoredInterlocutor(identityInput);
      identity = { kind: "generated", name: base.name, card: base };
    }
    if (!identity) throw new Error("当前身份角色卡不存在");
    const active = { performer: normalizedPerformer, identity };
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO active_roleplays(session_id,character_id,interlocutor_json,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      character_id=excluded.character_id,interlocutor_json=excluded.interlocutor_json,updated_at=excluded.updated_at`)
      .run(sessionId, normalizedPerformer.kind === "normal" ? (normalizedPerformer.id ?? 0) : 0, JSON.stringify(active), now);
    return active;
  }

  private resolveRoleplayParticipant(value: unknown): RoleplayParticipant | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const id = Number(raw.id);
    if (raw.kind === "normal" && Number.isInteger(id)) {
      const character = this.characters().find(item => item.id === id);
      return character ? normalRoleplayParticipant(character) : undefined;
    }
    if (raw.kind === "simple" && Number.isInteger(id)) {
      const card = this.roleplayInterlocutors().find(item => item.id === id);
      return card ? simpleRoleplayParticipant(card) : undefined;
    }
    if (raw.kind === "generated") {
      const card = normalizeStoredInterlocutor(raw.card);
      return { kind: "generated", name: card.name, card };
    }
    return undefined;
  }

  clearActiveRoleplay(sessionId: string): void {
    this.database.prepare("DELETE FROM active_roleplays WHERE session_id=?").run(sessionId);
    this.clearRoleplayMemory(sessionId);
  }

  roleplayMemory(sessionId: string): RoleplaySessionMemory | undefined {
    const row = this.database.prepare(
      "SELECT performer_key,summary,summarized_through_id,state_json,turn_count,same_beat_turns,updated_at FROM roleplay_memory WHERE session_id=?",
    ).get(sessionId) as Row | undefined;
    if (!row) return undefined;
    return {
      performerKey: String(row.performer_key ?? ""),
      summary: String(row.summary ?? ""),
      summarizedThroughId: Number(row.summarized_through_id) || 0,
      state: normalizeRoleplayWorkingState(row.state_json),
      turnCount: Number(row.turn_count) || 0,
      sameBeatTurns: Number(row.same_beat_turns) || 0,
      updatedAt: String(row.updated_at ?? ""),
    };
  }

  saveRoleplayMemory(sessionId: string, memory: RoleplaySessionMemory): RoleplaySessionMemory {
    if (!this.sessionExists(sessionId)) throw new Error("会话不存在");
    const now = new Date().toISOString();
    const state = normalizeRoleplayWorkingState(memory.state);
    const saved: RoleplaySessionMemory = {
      performerKey: memory.performerKey.trim(),
      summary: memory.summary.trim().slice(0, 4_000),
      summarizedThroughId: Math.max(0, Math.round(memory.summarizedThroughId) || 0),
      state,
      turnCount: Math.max(0, Math.round(memory.turnCount) || 0),
      sameBeatTurns: Math.max(0, Math.round(memory.sameBeatTurns) || 0),
      updatedAt: now,
    };
    this.database.prepare(`INSERT INTO roleplay_memory(
      session_id,performer_key,summary,summarized_through_id,state_json,turn_count,same_beat_turns,updated_at
    ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      performer_key=excluded.performer_key, summary=excluded.summary,
      summarized_through_id=excluded.summarized_through_id, state_json=excluded.state_json,
      turn_count=excluded.turn_count, same_beat_turns=excluded.same_beat_turns, updated_at=excluded.updated_at`)
      .run(
        sessionId,
        saved.performerKey,
        saved.summary,
        saved.summarizedThroughId,
        JSON.stringify(saved.state),
        saved.turnCount,
        saved.sameBeatTurns,
        now,
      );
    return saved;
  }

  clearRoleplayMemory(sessionId: string): void {
    this.database.prepare("DELETE FROM roleplay_memory WHERE session_id=?").run(sessionId);
  }

  writingExamples(): WritingExample[] {
    return this.database.prepare("SELECT * FROM writing_examples ORDER BY updated_at DESC, id DESC").all()
      .map(row => this.exampleFromRow(row as Row));
  }

  saveWritingExample(input: Omit<WritingExample, "id" | "updatedAt"> & { id?: number }): WritingExample {
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title || !content) throw new Error("示例标题和正文不能为空");
    const values = [title, input.category.trim(), content, input.notes.trim(), new Date().toISOString()];
    let id = input.id;
    if (id) {
      const result = this.database.prepare("UPDATE writing_examples SET title=?, category=?, content=?, notes=?, updated_at=? WHERE id=?").run(...values, id);
      if (!result.changes) throw new Error("写作示例不存在");
    } else {
      id = Number(this.database.prepare("INSERT INTO writing_examples(title,category,content,notes,updated_at) VALUES(?,?,?,?,?)").run(...values).lastInsertRowid);
    }
    return this.writingExample(id);
  }

  deleteWritingExample(id: number): void {
    if (!this.database.prepare("DELETE FROM writing_examples WHERE id=?").run(id).changes) throw new Error("写作示例不存在");
  }

  seedStyleExample(template: StyleTemplate): void {
    const existing = this.writingExamples().find((item) => item.title === `[风格模板] ${template.name}`);
    if (existing) {
      this.database.prepare("UPDATE writing_examples SET category=?, content=?, notes=?, updated_at=? WHERE id=?")
        .run(template.name, template.exampleContent, template.exampleNotes, new Date().toISOString(), existing.id);
    } else {
      this.database.prepare("INSERT INTO writing_examples(title,category,content,notes,updated_at) VALUES(?,?,?,?,?)")
        .run(`[风格模板] ${template.name}`, template.name, template.exampleContent, template.exampleNotes, new Date().toISOString());
    }
  }

  findCharacter(query: string): Character | undefined {
    const normalized = query.trim().toLowerCase();
    return this.characters().find(item => String(item.id) === normalized || item.identity.name.toLowerCase() === normalized || item.identity.aliases.some(alias => alias.toLowerCase() === normalized));
  }

  private writeCharacters(characters: Character[]): void {
    const content = [...characters].sort((a, b) => a.id - b.id).map(character => JSON.stringify(character)).join("\n");
    this.project.writeCharacterCardsJsonl(content ? `${content}\n` : "");
  }

  private migrateCharacterCardsToJsonl(): void {
    const jsonl = this.project.readCharacterCardsJsonl();
    if (jsonl.trim()) {
      const lines = jsonl.split(/\r?\n/).filter(line => line.trim());
      const raw = lines.map((line, index) => { try { return JSON.parse(line) as unknown; } catch (error) { throw new Error(`characters/characters.jsonl:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); } });
      const needsMigration = raw.some(value => (value as { schemaVersion?: unknown }).schemaVersion !== 3);
      const characters = raw.map(value => this.normalizeCharacter(value));
      validateCharacters(characters, this.outlineNodeIds());
      if (needsMigration) { this.project.backupV2CharacterCards(jsonl); this.writeCharacters(characters); }
      return;
    }
    const files = this.project.listCharacterCardFiles();
    if (!files.length) return;
    const characters = files.map(file => { try { return this.normalizeCharacter(JSON.parse(this.project.readCharacterCard(file))); } catch (error) { throw new Error(`characters/${file}: ${error instanceof Error ? error.message : String(error)}`); } });
    if (!characters.length) return;
    validateCharacters(characters, this.outlineNodeIds());
    this.writeCharacters(characters);
    for (const file of files) this.project.removeCharacterCard(file);
  }

  private normalizeCharacter(input: unknown): Character {
    if ((input as { schemaVersion?: unknown })?.schemaVersion !== 3) return migrateV2Character(input);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("角色卡根节点必须是对象");
    const raw = input as Record<string, unknown>;
    for (const section of ["identity", "profile", "psychology", "voice"] as const) {
      if (!raw[section] || typeof raw[section] !== "object" || Array.isArray(raw[section])) throw new Error(`${section}: 缺少必需对象分区`);
    }
    for (const section of ["motivations", "competencies", "relationships", "storyStates"] as const) {
      if (!Array.isArray(raw[section])) throw new Error(`${section}: 缺少必需数组分区`);
    }
    if (typeof raw.notes !== "string") throw new Error("notes: 必须是字符串");
    if (typeof raw.updatedAt !== "string") throw new Error("updatedAt: 必须是字符串");
    return normalizeV3Character(input);
  }

  private outlineNodeIds(): Set<string> | undefined {
    try { return new Set(new OutlineStore(this.project).sync().nodes.map(node => node.id)); }
    catch { return undefined; }
  }

  private writingExample(id: number): WritingExample {
    const row = this.database.prepare("SELECT * FROM writing_examples WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("写作示例不存在");
    return this.exampleFromRow(row);
  }

  private exampleFromRow(row: Row): WritingExample {
    return {
      id: row.id as number, title: row.title as string, category: row.category as string,
      content: row.content as string, notes: row.notes as string, updatedAt: row.updated_at as string,
    };
  }

  private roleplayInterlocutorFromRow(row: Row): SavedRoleplayInterlocutor {
    return {
      id: Number(row.id),
      ...(Number.isInteger(Number(row.target_character_id)) && Number(row.target_character_id) > 0
        ? { targetCharacterId: Number(row.target_character_id) } : {}),
      name: String(row.name),
      identity: String(row.identity),
      relationship: String(row.relationship),
      knowledge: String(row.knowledge),
      scene: String(row.scene),
      goal: String(row.goal),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  createSession(title = "新会话"): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare("INSERT INTO sessions(id,title,created_at,updated_at,auto_title_done) VALUES(?,?,?,?,0)")
      .run(id, title, now, now);
    return id;
  }

  latestSession(): string | undefined {
    const row = this.database.prepare("SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1").get() as Row | undefined;
    return row?.id as string | undefined;
  }

  sessionExists(id: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 AS ok FROM sessions WHERE id=?").get(id));
  }

  getSession(id: string): { id: string; title: string; updatedAt: string; autoTitleDone: boolean } | undefined {
    const row = this.database.prepare("SELECT id,title,updated_at,auto_title_done FROM sessions WHERE id=?")
      .get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      title: row.title as string,
      updatedAt: row.updated_at as string,
      autoTitleDone: Number(row.auto_title_done ?? 0) === 1,
    };
  }

  listSessions(): Array<{ id: string; title: string; updatedAt: string; autoTitleDone: boolean }> {
    return this.database.prepare("SELECT id,title,updated_at,auto_title_done FROM sessions ORDER BY updated_at DESC").all()
      .map((row) => {
        const item = row as Row;
        return {
          id: item.id as string,
          title: item.title as string,
          updatedAt: item.updated_at as string,
          autoTitleDone: Number(item.auto_title_done ?? 0) === 1,
        };
      });
  }

  /** Rename session. Manual renames lock auto-title so it never overwrites user titles. */
  renameSession(id: string, title: string, options?: { fromAutoTitle?: boolean }): void {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("会话标题不能为空");
    const now = new Date().toISOString();
    const result = options?.fromAutoTitle
      ? this.database.prepare("UPDATE sessions SET title=?, updated_at=?, auto_title_done=1 WHERE id=?")
        .run(trimmed, now, id)
      : this.database.prepare("UPDATE sessions SET title=?, updated_at=?, auto_title_done=1 WHERE id=?")
        .run(trimmed, now, id);
    if (!result.changes) throw new Error("会话不存在");
  }

  markAutoTitleDone(id: string): void {
    this.database.prepare("UPDATE sessions SET auto_title_done=1 WHERE id=?").run(id);
  }

  deleteSession(id: string): void {
    const sessions = this.listSessions();
    if (sessions.length <= 1) throw new Error("不能删除唯一的会话");
    this.database.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }

  /** Batch-delete sessions; always keep at least one. Returns remaining session id (prefer keepId if still present). */
  deleteSessions(ids: string[], keepId?: string): { deleted: string[]; remainingSessionId: string } {
    const unique = [...new Set(ids.filter((id) => this.sessionExists(id)))];
    if (unique.length === 0) throw new Error("没有可删除的会话");
    const all = this.listSessions();
    if (all.length - unique.length < 1) {
      throw new Error("至少保留一个会话，请取消勾选部分会话后再删除");
    }
    const deleteSet = new Set(unique);
    for (const id of unique) {
      this.database.prepare("DELETE FROM sessions WHERE id=?").run(id);
    }
    const remaining = this.listSessions();
    const remainingSessionId = (keepId && remaining.some((s) => s.id === keepId))
      ? keepId
      : remaining[0]?.id;
    if (!remainingSessionId) throw new Error("删除后没有可用会话");
    return { deleted: unique, remainingSessionId };
  }

  addMessage(sessionId: string, role: Message["role"], content: string, channel: MessageChannel = "agent", variantGroupId?: string): number {
    const now = new Date().toISOString();
    const normalized = channel === "roleplay" ? "roleplay" : "agent";
    const result = this.database.prepare("INSERT INTO messages(session_id,role,content,created_at,channel,variant_group_id) VALUES(?,?,?,?,?,?)")
      .run(sessionId, role, content, now, normalized, variantGroupId ?? null);
    this.database.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(now, sessionId);
    return Number(result.lastInsertRowid);
  }

  messages(sessionId: string, limit = 30, options?: { channel?: MessageChannel }): Message[] {
    const channel = options?.channel;
    const rows = channel
      ? this.database.prepare(`
          SELECT * FROM (SELECT id,session_id,role,content,created_at,channel,variant_group_id FROM messages
          WHERE session_id=? AND channel=? ORDER BY id DESC LIMIT ?) ORDER BY id ASC
        `).all(sessionId, channel, limit)
      : this.database.prepare(`
          SELECT * FROM (SELECT id,session_id,role,content,created_at,channel,variant_group_id FROM messages
          WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id ASC
        `).all(sessionId, limit);
    return rows.map((row) => this.messageFromRow(row as Row));
  }

  /** Lightweight archive metadata for conversations that exceed the model context window. */
  conversationStats(sessionId: string): {
    total: number; agent: number; roleplay: number; characters: number;
    firstMessageId?: number; lastMessageId?: number;
  } {
    const row = this.database.prepare(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN channel='agent' THEN 1 ELSE 0 END),0) AS agent,
      COALESCE(SUM(CASE WHEN channel='roleplay' THEN 1 ELSE 0 END),0) AS roleplay,
      COALESCE(SUM(LENGTH(content)),0) AS characters,
      MIN(id) AS first_id, MAX(id) AS last_id
      FROM messages WHERE session_id=? AND role IN ('user','assistant')`).get(sessionId) as Row;
    return {
      total: Number(row.total), agent: Number(row.agent), roleplay: Number(row.roleplay),
      characters: Number(row.characters),
      ...(row.first_id === null ? {} : { firstMessageId: Number(row.first_id) }),
      ...(row.last_id === null ? {} : { lastMessageId: Number(row.last_id) }),
    };
  }

  /** Read an archive page in chronological order. `afterId=0` starts at the beginning. */
  conversationMessages(
    sessionId: string,
    options: { channel?: MessageChannel; afterId?: number; limit?: number } = {},
  ): Message[] {
    const afterId = Number.isInteger(options.afterId) && (options.afterId ?? 0) > 0 ? options.afterId! : 0;
    const limit = Math.max(1, Math.min(100, Math.round(options.limit ?? 40)));
    const rows = options.channel
      ? this.database.prepare(`SELECT id,session_id,role,content,created_at,channel,variant_group_id FROM messages
          WHERE session_id=? AND channel=? AND role IN ('user','assistant') AND id>?
          ORDER BY id ASC LIMIT ?`).all(sessionId, options.channel, afterId, limit)
      : this.database.prepare(`SELECT id,session_id,role,content,created_at,channel,variant_group_id FROM messages
          WHERE session_id=? AND role IN ('user','assistant') AND id>?
          ORDER BY id ASC LIMIT ?`).all(sessionId, afterId, limit);
    return rows.map((row) => this.messageFromRow(row as Row));
  }

  /** Read the page immediately before `beforeId`; omit it to get the newest page. */
  conversationMessagesBefore(sessionId: string, beforeId?: number, limit = 50): Message[] {
    const normalizedLimit = Math.max(1, Math.min(100, Math.round(limit)));
    const rows = beforeId !== undefined && Number.isInteger(beforeId) && beforeId > 0
      ? this.database.prepare(`SELECT * FROM (SELECT id,session_id,role,content,created_at,channel,variant_group_id FROM messages
          WHERE session_id=? AND role IN ('user','assistant') AND id<? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`)
          .all(sessionId, beforeId, normalizedLimit)
      : this.database.prepare(`SELECT * FROM (SELECT id,session_id,role,content,created_at,channel,variant_group_id FROM messages
          WHERE session_id=? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?) ORDER BY id ASC`)
          .all(sessionId, normalizedLimit);
    return rows.map((row) => this.messageFromRow(row as Row));
  }

  recordUsage(sessionId: string, model: string, usage: {
    promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number;
  }, pricing: TokenPricing, at: Date = new Date()): UsageSummary {
    const miss = usage.cacheMissTokens || Math.max(0, usage.promptTokens - usage.cacheHitTokens);
    const cost = calculateUsageCost({ ...usage, cacheMissTokens: miss }, pricing, at);
    this.database.prepare(`INSERT INTO model_usage(session_id,model,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,cost,currency,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(sessionId, model, usage.promptTokens, usage.completionTokens, usage.cacheHitTokens, miss, cost, pricing.currency, at.toISOString());
    return this.usage(sessionId);
  }

  usage(sessionId: string): UsageSummary {
    const row = this.database.prepare(`SELECT
      COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens,
      COALESCE(SUM(cache_hit_tokens),0) cache_hit_tokens, COALESCE(SUM(cache_miss_tokens),0) cache_miss_tokens,
      COALESCE(SUM(cost),0) cost, COALESCE(MAX(currency),'CNY') currency,
      COALESCE((SELECT prompt_tokens FROM model_usage WHERE session_id=? ORDER BY id DESC LIMIT 1),0) last_prompt_tokens
      FROM model_usage WHERE session_id=?`).get(sessionId, sessionId) as Row;
    const promptTokens = Number(row.prompt_tokens);
    const completionTokens = Number(row.completion_tokens);
    const cacheHitTokens = Number(row.cache_hit_tokens);
    const cacheMissTokens = Number(row.cache_miss_tokens);
    const measuredInput = cacheHitTokens + cacheMissTokens;
    return {
      promptTokens, completionTokens, cacheHitTokens,
      cacheMissTokens, totalTokens: promptTokens + completionTokens,
      cost: Number(row.cost), currency: String(row.currency), lastPromptTokens: Number(row.last_prompt_tokens),
      cacheHitRate: measuredInput > 0 ? cacheHitTokens / measuredInput : 0,
    };
  }

  private messageFromRow(row: Row): Message {
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      role: row.role as Message["role"],
      content: row.content as string,
      createdAt: row.created_at as string,
      channel: row.channel === "roleplay" ? "roleplay" : "agent",
      ...(typeof row.variant_group_id === "string" ? { variantGroupId: row.variant_group_id } : {}),
    };
  }

  withMessageVariantInfo(messages: Message[]): Message[] {
    const counts = new Map<string, { user: number; assistant: number }>();
    for (const message of messages) {
      if ((message.role !== "user" && message.role !== "assistant") || !message.variantGroupId) continue;
      if (!counts.has(message.variantGroupId)) {
        const archived = this.database.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT CASE WHEN prompt<>'' THEN prompt END) AS prompts FROM message_variants WHERE session_id=? AND group_id=?")
          .get(message.sessionId, message.variantGroupId) as Row;
        const currentUser = this.database.prepare("SELECT content FROM messages WHERE session_id=? AND variant_group_id=? AND role='user' ORDER BY id DESC LIMIT 1")
          .get(message.sessionId, message.variantGroupId) as Row | undefined;
        const promptAlreadyArchived = currentUser
          ? this.database.prepare("SELECT 1 AS ok FROM message_variants WHERE session_id=? AND group_id=? AND prompt=? LIMIT 1")
            .get(message.sessionId, message.variantGroupId, String(currentUser.content)) as Row | undefined
          : undefined;
        counts.set(message.variantGroupId, {
          assistant: Number(archived.total) + 1,
          user: Number(archived.prompts) + (currentUser && !promptAlreadyArchived ? 1 : 0),
        });
      }
    }
    return messages.map(message => message.variantGroupId && (message.role === "user" || message.role === "assistant")
      ? { ...message, variantCount: counts.get(message.variantGroupId)?.[message.role] ?? 1 }
      : message);
  }

  createProposal(sessionId: string, path: string, content: string, summary: string, characterChanges: ProposalCharacterChange[] = []): Proposal {
    const exists = this.project.documentExists(path);
    const before = exists ? this.project.read(path) : "";
    this.evolveCharactersForProposal(path, summary, characterChanges);
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO proposals(session_id,path,summary,before_content,after_content,base_hash,character_changes_json,status,created_at)
      VALUES(?,?,?,?,?,?,?,'pending',?)
    `).run(sessionId, path, summary, before, content, exists ? this.project.hash(before) : "__missing__", JSON.stringify(characterChanges), now);
    return this.proposal(Number(result.lastInsertRowid));
  }

  private evolveCharactersForProposal(
    path: string,
    summary: string,
    changes: ProposalCharacterChange[],
  ): { characters: Character[]; revisions: ProposalCharacterRevision[] } {
    let characters = this.characters();
    const revisions: ProposalCharacterRevision[] = [];
    for (const change of changes) {
      const before = characters.find(item => item.id === change.characterId);
      if (!before) throw new Error(`延迟角色演进失败：角色 ${change.characterId} 不存在`);
      const result = applyCharacterChangesCore(before, {
        reason: change.reason,
        sourceRef: { type: "document", ref: path, note: summary },
        changes: change.changes,
      });
      if (result.skipped.length) {
        throw new Error(`延迟角色演进包含无效操作：${result.skipped.map(item => `${item.op}: ${item.reason}`).join("；")}`);
      }
      characters = [...characters.filter(item => item.id !== before.id), result.character];
      revisions.push({ characterId: before.id, before, after: result.character });
    }
    validateCharacters(characters, this.outlineNodeIds());
    return { characters, revisions };
  }

  proposal(id: number): Proposal {
    const row = this.database.prepare("SELECT * FROM proposals WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error(`修改提案不存在：${id}`);
    return this.proposalFromRow(row);
  }

  proposals(status?: Proposal["status"]): Proposal[] {
    const rows = status
      ? this.database.prepare("SELECT * FROM proposals WHERE status=? ORDER BY id DESC").all(status)
      : this.database.prepare("SELECT * FROM proposals ORDER BY id DESC LIMIT 100").all();
    return rows.map((row) => this.proposalFromRow(row as Row));
  }

  private proposalFromRow(row: Row): Proposal {
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      path: row.path as string,
      summary: row.summary as string,
      beforeContent: row.before_content as string,
      afterContent: row.after_content as string,
      baseHash: row.base_hash as string,
      status: row.status as Proposal["status"],
      createdAt: row.created_at as string,
      characterChanges: parseProposalCharacterChanges(row.character_changes_json),
    };
  }

  acceptProposal(id: number): Proposal {
    const proposal = this.proposal(id);
    if (proposal.status !== "pending") throw new Error("该提案已处理");
    const intendedCreate = proposal.baseHash === "__missing__";
    const exists = this.project.documentExists(proposal.path);
    const current = exists ? this.project.read(proposal.path) : "";
    // File present with content → always treat as update so history chains
    // (e.g. keep-changes re-run rewriting 第一章.md after the first draft stayed).
    const createdFile = intendedCreate && !exists;
    const unchanged = intendedCreate
      ? !exists
      : exists && this.project.hash(current) === proposal.baseHash;
    if (!unchanged) {
      this.database.prepare("UPDATE proposals SET status='stale' WHERE id=?").run(id);
      throw new Error("文档已被修改，提案已过期，未覆盖当前内容");
    }
    const evolved = this.evolveCharactersForProposal(proposal.path, proposal.summary, proposal.characterChanges);
    this.project.writeRaw(proposal.path, proposal.afterContent);
    this.project.registerChapter(proposal.path);
    if (evolved.revisions.length) this.writeCharacters(evolved.characters);
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO revisions(proposal_id,path,before_content,after_content,after_hash,created_file,character_revisions_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(
      id, proposal.path, current, proposal.afterContent, this.project.hash(proposal.afterContent), createdFile ? 1 : 0,
      JSON.stringify(evolved.revisions), now,
    );
    this.database.prepare("UPDATE proposals SET status='accepted' WHERE id=?").run(id);
    this.reindex();
    return this.proposal(id);
  }

  rejectProposal(id: number): Proposal {
    const proposal = this.proposal(id);
    if (proposal.status !== "pending") throw new Error("该提案已处理");
    this.database.prepare("UPDATE proposals SET status='rejected' WHERE id=?").run(id);
    return this.proposal(id);
  }

  undo(sessionId?: string): string {
    const row = this.database.prepare("SELECT * FROM revisions WHERE undone=0 ORDER BY id DESC LIMIT 1").get() as Row | undefined;
    if (!row) throw new Error("没有可撤销的修改");
    const path = row.path as string;
    const current = this.project.read(path);
    if (this.project.hash(current) !== row.after_hash) throw new Error("文档已在修改后发生变化，无法安全撤销");
    const characterRevisions = parseProposalCharacterRevisions(row.character_revisions_json);
    let restoredCharacters = this.characters();
    for (const revision of characterRevisions) {
      const expected = this.normalizeCharacter(revision.after);
      const currentCharacter = restoredCharacters.find(item => item.id === revision.characterId);
      if (!currentCharacter || JSON.stringify(currentCharacter) !== JSON.stringify(expected)) {
        throw new Error(`角色卡 ${revision.characterId} 已在提案通过后发生变化，无法安全撤销`);
      }
      const before = this.normalizeCharacter(revision.before);
      restoredCharacters = [...restoredCharacters.filter(item => item.id !== revision.characterId), before];
    }
    if (characterRevisions.length) validateCharacters(restoredCharacters, this.outlineNodeIds());
    if (row.created_file === 1) this.project.removeDocument(path);
    else this.project.writeRaw(path, row.before_content as string);
    if (characterRevisions.length) this.writeCharacters(restoredCharacters);
    this.database.prepare("UPDATE revisions SET undone=1 WHERE id=?").run(row.id as number);
    this.reindex();
    if (sessionId) this.addSystemMessage(sessionId, `已撤销文档修改：${path}`);
    return path;
  }

  redo(sessionId?: string): string {
    const row = this.database.prepare("SELECT * FROM revisions WHERE undone=1 ORDER BY id DESC LIMIT 1").get() as Row | undefined;
    if (!row) throw new Error("没有可重做的修改");
    const path = row.path as string;
    const createdFile = row.created_file === 1;
    const exists = this.project.documentExists(path);
    if (createdFile ? exists : !exists || this.project.hash(this.project.read(path)) !== this.project.hash(row.before_content as string)) {
      throw new Error("文档已发生变化，无法安全重做");
    }
    const characterRevisions = parseProposalCharacterRevisions(row.character_revisions_json);
    let restoredCharacters = this.characters();
    for (const revision of characterRevisions) {
      const expected = this.normalizeCharacter(revision.before);
      const currentCharacter = restoredCharacters.find(item => item.id === revision.characterId);
      if (!currentCharacter || JSON.stringify(currentCharacter) !== JSON.stringify(expected)) {
        throw new Error(`角色卡 ${revision.characterId} 已在撤销后发生变化，无法安全重做`);
      }
      const after = this.normalizeCharacter(revision.after);
      restoredCharacters = [...restoredCharacters.filter(item => item.id !== revision.characterId), after];
    }
    if (characterRevisions.length) validateCharacters(restoredCharacters, this.outlineNodeIds());
    this.project.writeRaw(path, row.after_content as string);
    this.project.registerChapter(path);
    if (characterRevisions.length) this.writeCharacters(restoredCharacters);
    this.database.prepare("UPDATE revisions SET undone=0 WHERE id=?").run(row.id as number);
    this.reindex();
    if (sessionId) this.addSystemMessage(sessionId, `已重做文档修改：${path}`);
    return path;
  }

  rewindFromMessage(
    sessionId: string,
    targetId: number,
    options?: { keepChanges?: boolean },
  ): { fromId: number; prompt: string; keepChanges: boolean } {
    if (!this.sessionExists(sessionId)) throw new Error("会话不存在");
    const target = this.database.prepare("SELECT id FROM messages WHERE id=? AND session_id=?").get(targetId, sessionId) as Row | undefined;
    if (!target) throw new Error("消息不存在");
    const userRow = this.database.prepare(
      "SELECT id, content, created_at, channel FROM messages WHERE session_id=? AND role='user' AND id<=? ORDER BY id DESC LIMIT 1",
    ).get(sessionId, targetId) as Row | undefined;
    if (!userRow) throw new Error("该位置之前没有可重新编辑的用户指令");
    const fromId = userRow.id as number;
    const fromTime = userRow.created_at as string;
    const keepChanges = Boolean(options?.keepChanges);
    const undonePaths: string[] = [];
    const undoneCharacters: string[] = [];
    if (!keepChanges) {
      const proposalsToUndo = (this.database.prepare(
        "SELECT id, status FROM proposals WHERE session_id=? AND created_at>=? AND status='accepted' ORDER BY id DESC",
      ).all(sessionId, fromTime) as Row[]);
      for (const row of proposalsToUndo) {
        const revRow = this.database.prepare(
          "SELECT * FROM revisions WHERE proposal_id=? AND undone=0 ORDER BY id DESC LIMIT 1",
        ).get(row.id as number) as Row | undefined;
        if (!revRow) continue;
        const path = revRow.path as string;
        const current = this.project.documentExists(path) ? this.project.read(path) : "";
        if (this.project.hash(current) !== revRow.after_hash) continue;
        if (revRow.created_file === 1) this.project.removeDocument(path);
        else this.project.writeRaw(path, revRow.before_content as string);
        this.database.prepare("UPDATE revisions SET undone=1 WHERE id=?").run(revRow.id as number);
        undonePaths.push(path);
      }
      const characterRows = this.database.prepare(
        "SELECT * FROM character_revisions WHERE session_id=? AND message_id>=? AND undone=0 ORDER BY id DESC",
      ).all(sessionId, fromId) as Row[];
      for (const row of characterRows) {
        let after: Character;
        try { after = this.normalizeCharacter(JSON.parse(row.after_content as string) as Character); }
        catch { continue; }
        const characters = this.characters();
        const current = characters.find(item => item.id === after.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(after)) continue;
        let restored = characters.filter(item => item.id !== after.id);
        if (typeof row.before_content === "string") {
          try { restored.push(this.normalizeCharacter(JSON.parse(row.before_content) as Character)); }
          catch { continue; }
        }
        this.writeCharacters(restored);
        this.database.prepare("UPDATE character_revisions SET undone=1 WHERE id=?").run(row.id as number);
        undoneCharacters.push(after.identity.name);
      }
    }
    this.database.prepare("DELETE FROM messages WHERE session_id=? AND id>=?").run(sessionId, fromId);
    this.database.prepare("DELETE FROM proposals WHERE session_id=? AND created_at>=? AND status!='accepted' AND id NOT IN (SELECT proposal_id FROM revisions WHERE proposal_id IS NOT NULL)").run(sessionId, fromTime);
    // Task/todos/tool memory are dialogue-turn state; rewind must not leave them attached to the session shell.
    this.clearSessionTaskState(sessionId);
    if (userRow.channel === "roleplay") this.clearRoleplayMemory(sessionId);
    let summary: string;
    if (keepChanges) {
      summary = `已撤销用户指令 #${fromId} 及其后续对话；已接受的文档与角色卡修改已按选择保留。`;
    } else {
      const changes = [
        undonePaths.length ? `文档：${undonePaths.join("、")}` : "",
        undoneCharacters.length ? `角色卡：${undoneCharacters.join("、")}` : "",
      ].filter(Boolean).join("；");
      summary = changes
        ? `已撤销用户指令 #${fromId} 及其后续上下文，回退 ${changes}。`
        : `已撤销用户指令 #${fromId} 及其后续上下文，无关联修改。`;
    }
    this.addSystemMessage(sessionId, summary);
    this.reindex();
    return { fromId, prompt: String(userRow.content), keepChanges };
  }

  prepareMessageRerun(
    sessionId: string,
    targetId: number,
    options?: { keepChanges?: boolean },
  ): {
    fromId: number; prompt: string; channel: MessageChannel; variantGroupId: string; keepChanges: boolean;
  } {
    if (!this.sessionExists(sessionId)) throw new Error("会话不存在");
    const target = this.database.prepare("SELECT id FROM messages WHERE id=? AND session_id=?").get(targetId, sessionId) as Row | undefined;
    if (!target) throw new Error("消息不存在");
    const user = this.database.prepare(`SELECT id,content,channel,variant_group_id FROM messages
      WHERE session_id=? AND role='user' AND id<=? ORDER BY id DESC LIMIT 1`).get(sessionId, targetId) as Row | undefined;
    if (!user) throw new Error("该位置之前没有可重新运行的用户指令");
    const fromId = Number(user.id);
    const groupId = typeof user.variant_group_id === "string" ? user.variant_group_id : randomUUID();
    const assistant = this.database.prepare(`SELECT id,content FROM messages
      WHERE session_id=? AND role='assistant' AND id>? AND id<(SELECT COALESCE(MIN(id),9223372036854775807) FROM messages WHERE session_id=? AND role='user' AND id>?)
      ORDER BY id DESC LIMIT 1`).get(sessionId, fromId, sessionId, fromId) as Row | undefined;
    this.database.prepare("UPDATE messages SET variant_group_id=? WHERE session_id=? AND id>=? AND id<=?")
      .run(groupId, sessionId, fromId, assistant ? Number(assistant.id) : fromId);
    if (assistant) {
      const duplicate = this.database.prepare("SELECT id FROM message_variants WHERE session_id=? AND group_id=? AND prompt=? AND content=? LIMIT 1")
        .get(sessionId, groupId, String(user.content), String(assistant.content)) as Row | undefined;
      if (!duplicate) {
        const max = this.database.prepare("SELECT COALESCE(MAX(version_index),0) AS value FROM message_variants WHERE session_id=? AND group_id=?")
          .get(sessionId, groupId) as Row;
        this.database.prepare("INSERT INTO message_variants(session_id,group_id,version_index,prompt,content,created_at) VALUES(?,?,?,?,?,?)")
          .run(sessionId, groupId, Number(max.value) + 1, String(user.content), String(assistant.content), new Date().toISOString());
      }
    }
    const channel: MessageChannel = user.channel === "roleplay" ? "roleplay" : "agent";
    const prompt = String(user.content);
    const rewound = this.rewindFromMessage(sessionId, fromId, options);
    return {
      fromId: rewound.fromId,
      prompt,
      channel,
      variantGroupId: groupId,
      keepChanges: rewound.keepChanges,
    };
  }

  messageVersions(sessionId: string, messageId: number): {
    current: number;
    versions: Array<{ key: string; content: string; createdAt: string }>;
  } {
    const message = this.database.prepare(`SELECT id,role,content,created_at,variant_group_id FROM messages
      WHERE session_id=? AND id=? AND role IN ('user','assistant')`).get(sessionId, messageId) as Row | undefined;
    if (!message) throw new Error("消息不存在");
    const groupId = typeof message.variant_group_id === "string" ? message.variant_group_id : undefined;
    if (!groupId) return { current: 0, versions: [{ key: `current:${messageId}`, content: String(message.content), createdAt: String(message.created_at) }] };
    const archived = this.database.prepare(`SELECT id,prompt,content,created_at FROM message_variants
      WHERE session_id=? AND group_id=? ORDER BY version_index ASC`).all(sessionId, groupId) as Row[];
    if (message.role === "user") {
      const seen = new Set<string>();
      const versions = archived.flatMap(row => {
        const content = String(row.prompt);
        if (!content || seen.has(content)) return [];
        seen.add(content);
        return [{ key: `archive:${row.id}`, content, createdAt: String(row.created_at) }];
      });
      const live = String(message.content);
      const current = versions.findIndex(version => version.content === live);
      if (current >= 0) return { current, versions };
      versions.push({ key: `current:${messageId}`, content: live, createdAt: String(message.created_at) });
      return { current: versions.length - 1, versions };
    }
    const versions = archived.map(row => ({ key: `archive:${row.id}`, content: String(row.content), createdAt: String(row.created_at) }));
    versions.push({ key: `current:${messageId}`, content: String(message.content), createdAt: String(message.created_at) });
    return { current: versions.length - 1, versions };
  }

  addSystemMessage(sessionId: string, content: string): void {
    const now = new Date().toISOString();
    this.database.prepare("INSERT INTO messages(session_id,role,content,created_at,channel) VALUES(?,'system',?,?,'agent')")
      .run(sessionId, content, now);
    this.database.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(now, sessionId);
  }

  updateDocument(path: string, content: string, baseHash: string): void {
    const current = this.project.read(path);
    if (this.project.hash(current) !== baseHash) throw new Error("文档已在其他位置修改，请刷新后重试");
    this.project.writeRaw(path, content);
    this.database.prepare(`
      INSERT INTO revisions(proposal_id,path,before_content,after_content,after_hash,created_at)
      VALUES(NULL,?,?,?,?,?)
    `).run(path, current, content, this.project.hash(content), new Date().toISOString());
    this.reindex();
  }

  /**
   * Browse-only version list for a document.
   * Includes rolled-back (undone) snapshots so re-runs / keep-changes rewrites
   * do not make earlier drafts unreadable. Agent tools never call this.
   */
  documentVersions(path: string): DocumentVersionMeta[] {
    if (!path) throw new Error("缺少文档路径");
    const live = this.project.documentExists(path) ? this.project.read(path) : "";
    const liveHash = live ? this.project.hash(live) : "";
    const rows = this.database.prepare(`
      SELECT r.id, r.path, r.after_hash, r.created_file, r.created_at, r.undone,
             p.summary AS proposal_summary
      FROM revisions r
      LEFT JOIN proposals p ON p.id = r.proposal_id
      WHERE r.path = ?
      ORDER BY r.id DESC
      LIMIT 200
    `).all(path) as Row[];
    return rows.map((row) => {
      const undone = Number(row.undone) === 1;
      const baseSummary = typeof row.proposal_summary === "string" && row.proposal_summary.trim()
        ? String(row.proposal_summary)
        : Number(row.created_file) === 1 ? "新建文档" : "手动编辑";
      return {
        id: Number(row.id),
        path: String(row.path),
        createdAt: String(row.created_at),
        summary: undone ? `已回退 · ${baseSummary}` : baseSummary,
        isCurrent: !undone && liveHash !== "" && String(row.after_hash) === liveHash,
        createdFile: Number(row.created_file) === 1,
        undone,
      };
    });
  }

  /** Full before/after snapshot for a single revision (browse-only; includes rolled-back). */
  documentVersion(path: string, revisionId: number): DocumentVersionDetail {
    if (!path) throw new Error("缺少文档路径");
    if (!Number.isInteger(revisionId) || revisionId <= 0) throw new Error("版本编号无效");
    const row = this.database.prepare(`
      SELECT r.id, r.path, r.before_content, r.after_content, r.after_hash,
             r.created_file, r.created_at, r.undone, p.summary AS proposal_summary
      FROM revisions r
      LEFT JOIN proposals p ON p.id = r.proposal_id
      WHERE r.id = ? AND r.path = ?
    `).get(revisionId, path) as Row | undefined;
    if (!row) throw new Error("版本不存在");
    const live = this.project.documentExists(path) ? this.project.read(path) : "";
    const liveHash = live ? this.project.hash(live) : "";
    const undone = Number(row.undone) === 1;
    const baseSummary = typeof row.proposal_summary === "string" && row.proposal_summary.trim()
      ? String(row.proposal_summary)
      : Number(row.created_file) === 1 ? "新建文档" : "手动编辑";
    return {
      id: Number(row.id),
      path: String(row.path),
      createdAt: String(row.created_at),
      summary: undone ? `已回退 · ${baseSummary}` : baseSummary,
      isCurrent: !undone && liveHash !== "" && String(row.after_hash) === liveHash,
      createdFile: Number(row.created_file) === 1,
      undone,
      beforeContent: String(row.before_content ?? ""),
      afterContent: String(row.after_content ?? ""),
    };
  }

  renameDocument(fromPath: string, toPath: string): void {
    this.project.renameDocument(fromPath, toPath);
    this.database.prepare("UPDATE proposals SET path=? WHERE path=?").run(toPath, fromPath);
    this.database.prepare("UPDATE revisions SET path=? WHERE path=?").run(toPath, fromPath);
    this.reindex();
  }

  renameFolder(fromPath: string, toPath: string): void {
    const fromPrefix = `${fromPath.replace(/\/+$/u, "")}/`;
    const toPrefix = `${toPath.replace(/\/+$/u, "")}/`;
    this.project.renameFolder(fromPath, toPath);
    const rewrite = (path: string) => path.startsWith(fromPrefix) ? `${toPrefix}${path.slice(fromPrefix.length)}` : path;
    const proposalRows = this.database.prepare("SELECT id,path FROM proposals WHERE path LIKE ?").all(`${fromPrefix}%`) as Array<{ id: number; path: string }>;
    const revisionRows = this.database.prepare("SELECT id,path FROM revisions WHERE path LIKE ?").all(`${fromPrefix}%`) as Array<{ id: number; path: string }>;
    const updateProposal = this.database.prepare("UPDATE proposals SET path=? WHERE id=?");
    const updateRevision = this.database.prepare("UPDATE revisions SET path=? WHERE id=?");
    for (const row of proposalRows) updateProposal.run(rewrite(row.path), row.id);
    for (const row of revisionRows) updateRevision.run(rewrite(row.path), row.id);
    this.reindex();
  }

  removeFolder(path: string): void {
    this.project.removeFolder(path);
    this.reindex();
  }

  reindex(): void {
    this.database.exec("DELETE FROM document_index");
    const insert = this.database.prepare("INSERT INTO document_index(path,content) VALUES(?,?)");
    for (const path of this.project.listDocuments()) insert.run(path, this.project.read(path));
  }

  search(query: string, limit = 6, options: {
    pathPrefix?: string; scope?: "all" | "lore" | "story" | "outline" | "chapters";
    mode?: "any" | "all" | "exact"; contextLines?: number;
  } = {}): Array<{ path: string; excerpt: string; block?: number; heading?: string; startLine?: number; endLine?: number }> {
    const normalizedQuery = query.trim().toLowerCase();
    const terms = normalizedQuery.match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu)?.slice(0, 8) ?? [];
    if (!terms.length) return [];
    const mode = options.mode ?? "any";
    const expressionTerms = mode === "exact" ? [normalizedQuery] : terms;
    const expression = expressionTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(mode === "all" ? " AND " : " OR ");
    const results = new Map<string, { path: string; excerpt: string }>();
    const matchesPath = (path: string) => {
      const prefix = options.pathPrefix?.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
      if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) return false;
      if (options.scope === "lore" || options.scope === "story") {
        // lore/ is canonical; story/ kept for older projects
        if (!(path.startsWith("lore/") || path.startsWith("story/"))) return false;
      }
      if (options.scope === "outline") {
        if (!(path.startsWith("outline/") || /(?:^|\/)(?:outline|大纲)[^/]*\.md$/i.test(path))) return false;
      }
      if (options.scope === "chapters" && !path.startsWith("chapters/")) return false;
      return true;
    };
    try {
      const rows = this.database.prepare(`
        SELECT path, snippet(document_index, 1, '【', '】', '…', 24) AS excerpt
        FROM document_index WHERE document_index MATCH ? ORDER BY rank LIMIT ?
      `).all(expression, limit);
      for (const row of rows) {
        const item = row as Row;
        if (matchesPath(item.path as string)) results.set(item.path as string, { path: item.path as string, excerpt: item.excerpt as string });
      }
    } catch { /* 中文连续文本可能无法被默认分词器解析，继续使用正文回退检索。 */ }

    if (results.size < limit) {
      const fragments = searchFragments(terms);
      const fallbackRows = this.database.prepare("SELECT path, content FROM document_index").all()
        .map((row) => {
          const item = row as Row;
          const content = item.content as string;
          const lower = content.toLowerCase();
          let score = 0;
          let position = -1;
          for (const fragment of fragments) {
            const index = lower.indexOf(fragment);
            if (index < 0) continue;
            if (position < 0 || fragment.length > 2) position = index;
            score += fragment.length >= 4 ? 6 : 1;
          }
          return { path: item.path as string, content, score, position };
        })
        .filter((item) => item.score > 0 && !results.has(item.path) && matchesPath(item.path))
        .filter((item) => mode !== "exact" || item.content.toLowerCase().includes(normalizedQuery))
        .filter((item) => mode !== "all" || terms.every(term => item.content.toLowerCase().includes(term)))
        .sort((a, b) => b.score - a.score || a.position - b.position)
        .slice(0, limit - results.size);
      for (const item of fallbackRows) {
        const start = Math.max(0, item.position - 80);
        const end = Math.min(item.content.length, item.position + 220);
        const excerpt = `${start > 0 ? "…" : ""}${item.content.slice(start, end).replace(/\s+/g, " ")}${end < item.content.length ? "…" : ""}`;
        results.set(item.path, { path: item.path, excerpt });
      }
    }
    return [...results.values()].slice(0, limit).map((item) => {
      const content = this.project.read(item.path);
      const lower = content.toLowerCase();
      const positions = searchFragments(terms).map((term) => lower.indexOf(term)).filter((index) => index >= 0);
      if (!positions.length) return item;
      const position = mode === "exact" ? lower.indexOf(normalizedQuery) : Math.min(...positions);
      const matchLine = content.slice(0, position).split(/\r?\n/).length;
      const lines = content.split(/\r?\n/);
      const contextLines = Math.max(0, Math.min(12, Math.round(options.contextLines ?? 2)));
      const startLine = Math.max(1, matchLine - contextLines);
      const endLine = Math.min(lines.length, matchLine + contextLines);
      const excerpt = lines.slice(startLine - 1, endLine).join("\n");
      const heading = headingAtLine(lines, matchLine);
      return { path: item.path, excerpt, block: blockAtOffset(documentBlocks(content), content, position),
        ...(heading ? { heading } : {}), startLine, endLine };
    });
  }
}

function headingAtLine(lines: string[], line: number): string | undefined {
  for (let index = Math.min(line - 1, lines.length - 1); index >= 0; index -= 1) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(lines[index]);
    if (match) return match[1].replace(/\s+#+\s*$/, "").trim();
  }
  return undefined;
}

function searchFragments(terms: string[]): string[] {
  const fragments = new Set<string>();
  for (const term of terms) {
    fragments.add(term);
    if (/^[\p{Script=Han}]+$/u.test(term) && term.length > 4) {
      for (let index = 0; index <= term.length - 2; index += 1) fragments.add(term.slice(index, index + 2));
    }
  }
  return [...fragments].slice(0, 40);
}

function roleplayField(value: unknown, label: string, max = 2_000, required = false): string {
  if (typeof value !== "string") throw new Error(`试演身份的${label}必须是字符串`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`试演身份的${label}不能为空`);
  if (normalized.length > max) throw new Error(`试演身份的${label}过长`);
  return normalized;
}

function normalizeStoredInterlocutor(input: unknown): RoleplayInterlocutor {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("当前试演人设格式无效");
  const value = input as Record<string, unknown>;
  return {
    name: roleplayField(value.name, "名称", 120, true),
    identity: roleplayField(value.identity, "身份"),
    relationship: roleplayField(value.relationship, "关系"),
    knowledge: roleplayField(value.knowledge, "已知信息"),
    scene: roleplayField(value.scene, "场景"),
    goal: roleplayField(value.goal, "目标"),
  };
}

export function emptyRoleplayWorkingState(): RoleplayWorkingState {
  return {
    scene: "",
    proximity: "",
    mood: "",
    openThreads: [],
    promises: [],
    revealed: [],
    relationshipDelta: "",
    beat: "",
    timeInScene: "",
  };
}

function normalizeRoleplayWorkingState(input: unknown): RoleplayWorkingState {
  let raw: Record<string, unknown> = {};
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    } catch { /* keep empty */ }
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    raw = input as Record<string, unknown>;
  }
  const str = (key: keyof RoleplayWorkingState, max = 400) =>
    typeof raw[key] === "string" ? raw[key].trim().slice(0, max) : "";
  const list = (key: "openThreads" | "promises" | "revealed") =>
    Array.isArray(raw[key])
      ? raw[key].filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, 12)
      : [];
  return {
    scene: str("scene"),
    proximity: str("proximity", 200),
    mood: str("mood", 200),
    openThreads: list("openThreads"),
    promises: list("promises"),
    revealed: list("revealed"),
    relationshipDelta: str("relationshipDelta"),
    beat: str("beat", 80),
    timeInScene: str("timeInScene", 120),
  };
}

function simpleRoleplayParticipant(value: SavedRoleplayInterlocutor): RoleplayParticipant {
  const card = normalizeStoredInterlocutor(value);
  return { kind: "simple", id: value.id, name: card.name, card };
}

function normalRoleplayParticipant(character: Character): RoleplayParticipant {
  return {
    kind: "normal",
    id: character.id,
    name: character.identity.name,
    card: {
      name: character.identity.name,
      identity: character.identity.summary || character.identity.narrativeRole,
      relationship: "",
      knowledge: "",
      scene: "",
      goal: character.motivations.find(item => item.status === "active")?.summary ?? "",
    },
  };
}
