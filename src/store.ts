import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Character, Message, Proposal, StyleTemplate, TokenPricing, UsageSummary, WritingExample } from "./types.js";
import { blockAtOffset, documentBlocks } from "./document_blocks.js";
import { WriterProject } from "./project.js";

type Row = Record<string, unknown>;

export class WriterStore {
  readonly database: DatabaseSync;

  constructor(readonly project: WriterProject) {
    mkdirSync(project.privateDir, { recursive: true });
    this.database = new DatabaseSync(resolve(project.privateDir, "writer.db"));
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.migrate();
    this.migrateCharacterCardsToJsonl();
    this.reindex();
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
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        summary TEXT NOT NULL,
        before_content TEXT NOT NULL,
        after_content TEXT NOT NULL,
        base_hash TEXT NOT NULL,
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
  }

  contextArtifact(sessionId: string, cacheKey: string): { id: number; kind: string; path?: string; sourceHash: string; content: string; digest: string } | undefined {
    const row = this.database.prepare("SELECT id,kind,path,source_hash,content,digest FROM context_artifacts WHERE session_id=? AND cache_key=?")
      .get(sessionId, cacheKey) as Row | undefined;
    if (!row) return undefined;
    this.database.prepare("UPDATE context_artifacts SET last_used_at=? WHERE id=?").run(new Date().toISOString(), Number(row.id));
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

  saveSessionContext(sessionId: string, value: { activeDocument?: string; currentIntent: string }): void {
    this.database.prepare(`INSERT INTO session_context(session_id,active_document,current_intent,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET active_document=COALESCE(excluded.active_document,session_context.active_document),
      current_intent=excluded.current_intent,updated_at=excluded.updated_at`)
      .run(sessionId, value.activeDocument ?? null, value.currentIntent, new Date().toISOString());
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
    return this.project.readCharacterCardsJsonl().split(/\r?\n/).flatMap(line => {
      if (!line.trim()) return [];
      try {
        const parsed = JSON.parse(line) as Character;
        return [this.normalizeCharacter(parsed)];
      } catch { return []; }
    }).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  saveCharacter(input: Omit<Character, "id" | "updatedAt"> & { id?: number }): Character {
    const name = input.name.trim();
    if (!name) throw new Error("角色名称不能为空");
    const characters = this.characters();
    const existing = input.id ? characters.find(item => item.id === input.id) : undefined;
    const id = existing?.id ?? Math.max(0, ...characters.map(item => item.id)) + 1;
    const availableIds = new Set(characters.map(item => item.id));
    const relationships = input.relationships.filter((item, index, all) =>
      Number.isInteger(item.characterId) && item.characterId !== id && availableIds.has(item.characterId)
      && all.findIndex(candidate => candidate.characterId === item.characterId) === index,
    ).map(item => ({
      characterId: item.characterId,
      type: item.type.trim(),
      description: item.description.trim(),
      attitude: item.attitude.trim(),
    }));
    const character: Character = {
      schemaVersion: 2,
      id, name, aliases: input.aliases.map(value => value.trim()).filter(Boolean).slice(0, 20),
      narrativeRole: input.narrativeRole.trim(), identity: input.identity.trim(), appearance: input.appearance.trim(),
      personality: input.personality.trim(), values: input.values.trim(), speechStyle: input.speechStyle.trim(),
      background: input.background.trim(), longTermGoal: input.longTermGoal.trim(), currentGoal: input.currentGoal.trim(),
      fears: input.fears.trim(), capabilities: input.capabilities.trim(), limitations: input.limitations.trim(), relationships,
      notes: input.notes.trim(),
      updatedAt: new Date().toISOString(),
    };
    this.writeCharacters([...characters.filter(item => item.id !== id), character]);
    return character;
  }

  saveCharacterWithRevision(
    sessionId: string,
    messageId: number,
    input: Omit<Character, "id" | "updatedAt"> & { id?: number },
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
    return this.characters().find(item => String(item.id) === normalized || item.name.toLowerCase() === normalized || item.aliases.some(alias => alias.toLowerCase() === normalized));
  }

  private writeCharacters(characters: Character[]): void {
    const content = [...characters].sort((a, b) => a.id - b.id).map(character => JSON.stringify(character)).join("\n");
    this.project.writeCharacterCardsJsonl(content ? `${content}\n` : "");
  }

  private migrateCharacterCardsToJsonl(): void {
    const jsonl = this.project.readCharacterCardsJsonl();
    if (jsonl.trim()) {
      const lines = jsonl.split(/\r?\n/).filter(line => line.trim());
      const characters: Character[] = [];
      for (const line of lines) {
        try { characters.push(this.normalizeCharacter(JSON.parse(line) as Character)); }
        catch { return; }
      }
      this.writeCharacters(characters);
      return;
    }
    const files = this.project.listCharacterCardFiles();
    if (!files.length) return;
    const characters = files.flatMap(file => {
      try { return [this.normalizeCharacter(JSON.parse(this.project.readCharacterCard(file)) as Character)]; }
      catch { return []; }
    });
    if (!characters.length) return;
    this.writeCharacters(characters);
    for (const file of files) this.project.removeCharacterCard(file);
  }

  private normalizeCharacter(input: Character): Character {
    const legacy = input as unknown as Record<string, unknown>;
    if (!Number.isInteger(input.id) || !String(input.name ?? "").trim()) throw new Error("角色卡格式无效");
    const legacyRelatedIds = Array.isArray(legacy.relatedCharacterIds) ? legacy.relatedCharacterIds.map(Number) : [];
    const relationships = Array.isArray(input.relationships)
      ? input.relationships.flatMap(item => item && typeof item === "object" && Number.isInteger(Number(item.characterId))
        ? [{ characterId: Number(item.characterId), type: String(item.type ?? ""), description: String(item.description ?? ""), attitude: String(item.attitude ?? "") }]
        : [])
      : legacyRelatedIds.filter(Number.isInteger).map(characterId => ({
        characterId,
        type: "",
        description: typeof legacy.relationships === "string" ? legacy.relationships : "",
        attitude: "",
      }));
    return {
      schemaVersion: 2,
      id: input.id, name: String(input.name), aliases: Array.isArray(input.aliases) ? input.aliases.map(String) : [],
      narrativeRole: String(input.narrativeRole ?? legacy.role ?? ""), identity: String(input.identity ?? ""),
      appearance: String(input.appearance ?? ""), personality: String(input.personality ?? legacy.traits ?? ""),
      values: String(input.values ?? ""), speechStyle: String(input.speechStyle ?? ""), background: String(input.background ?? ""),
      longTermGoal: String(input.longTermGoal ?? legacy.goals ?? ""), currentGoal: String(input.currentGoal ?? ""),
      fears: String(input.fears ?? ""), capabilities: String(input.capabilities ?? legacy.abilities ?? ""),
      limitations: String(input.limitations ?? ""),
      relationships: relationships.filter(item => item.characterId !== input.id),
      notes: [String(input.notes ?? ""), !legacyRelatedIds.length && typeof legacy.relationships === "string" && legacy.relationships.trim()
        ? `[旧版关系说明] ${legacy.relationships.trim()}` : ""].filter(Boolean).join("\n"),
      updatedAt: String(input.updatedAt ?? ""),
    };
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

  createSession(title = "新会话"): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare("INSERT INTO sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)")
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

  listSessions(): Array<{ id: string; title: string; updatedAt: string }> {
    return this.database.prepare("SELECT id,title,updated_at FROM sessions ORDER BY updated_at DESC").all()
      .map((row) => {
        const item = row as Row;
        return { id: item.id as string, title: item.title as string, updatedAt: item.updated_at as string };
      });
  }

  renameSession(id: string, title: string): void {
    const result = this.database.prepare("UPDATE sessions SET title=?, updated_at=? WHERE id=?").run(title, new Date().toISOString(), id);
    if (!result.changes) throw new Error("会话不存在");
  }

  deleteSession(id: string): void {
    const sessions = this.listSessions();
    if (sessions.length <= 1) throw new Error("不能删除唯一的会话");
    this.database.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }

  addMessage(sessionId: string, role: Message["role"], content: string): number {
    const now = new Date().toISOString();
    const result = this.database.prepare("INSERT INTO messages(session_id,role,content,created_at) VALUES(?,?,?,?)")
      .run(sessionId, role, content, now);
    this.database.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(now, sessionId);
    return Number(result.lastInsertRowid);
  }

  messages(sessionId: string, limit = 30): Message[] {
    const rows = this.database.prepare(`
      SELECT * FROM (SELECT id,session_id,role,content,created_at FROM messages
      WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id ASC
    `).all(sessionId, limit);
    return rows.map((row) => this.messageFromRow(row as Row));
  }

  recordUsage(sessionId: string, model: string, usage: {
    promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number;
  }, pricing: TokenPricing): UsageSummary {
    const miss = usage.cacheMissTokens || Math.max(0, usage.promptTokens - usage.cacheHitTokens);
    const cost = (usage.cacheHitTokens * pricing.cacheHit + miss * pricing.cacheMiss + usage.completionTokens * pricing.output) / 1_000_000;
    this.database.prepare(`INSERT INTO model_usage(session_id,model,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,cost,currency,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(sessionId, model, usage.promptTokens, usage.completionTokens, usage.cacheHitTokens, miss, cost, pricing.currency, new Date().toISOString());
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
    return {
      promptTokens, completionTokens, cacheHitTokens: Number(row.cache_hit_tokens),
      cacheMissTokens: Number(row.cache_miss_tokens), totalTokens: promptTokens + completionTokens,
      cost: Number(row.cost), currency: String(row.currency), lastPromptTokens: Number(row.last_prompt_tokens),
    };
  }

  private messageFromRow(row: Row): Message {
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      role: row.role as Message["role"],
      content: row.content as string,
      createdAt: row.created_at as string,
    };
  }

  createProposal(sessionId: string, path: string, content: string, summary: string): Proposal {
    const exists = this.project.documentExists(path);
    const before = exists ? this.project.read(path) : "";
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO proposals(session_id,path,summary,before_content,after_content,base_hash,status,created_at)
      VALUES(?,?,?,?,?,?,'pending',?)
    `).run(sessionId, path, summary, before, content, exists ? this.project.hash(before) : "__missing__", now);
    return this.proposal(Number(result.lastInsertRowid));
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
    };
  }

  acceptProposal(id: number): Proposal {
    const proposal = this.proposal(id);
    if (proposal.status !== "pending") throw new Error("该提案已处理");
    const createdFile = proposal.baseHash === "__missing__";
    const exists = this.project.documentExists(proposal.path);
    const current = exists ? this.project.read(proposal.path) : "";
    const unchanged = createdFile ? !exists : exists && this.project.hash(current) === proposal.baseHash;
    if (!unchanged) {
      this.database.prepare("UPDATE proposals SET status='stale' WHERE id=?").run(id);
      throw new Error("文档已被修改，提案已过期，未覆盖当前内容");
    }
    this.project.writeRaw(proposal.path, proposal.afterContent);
    this.project.registerChapter(proposal.path);
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO revisions(proposal_id,path,before_content,after_content,after_hash,created_file,created_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(id, proposal.path, current, proposal.afterContent, this.project.hash(proposal.afterContent), createdFile ? 1 : 0, now);
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
    if (row.created_file === 1) this.project.removeDocument(path);
    else this.project.writeRaw(path, row.before_content as string);
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
    this.project.writeRaw(path, row.after_content as string);
    this.project.registerChapter(path);
    this.database.prepare("UPDATE revisions SET undone=0 WHERE id=?").run(row.id as number);
    this.reindex();
    if (sessionId) this.addSystemMessage(sessionId, `已重做文档修改：${path}`);
    return path;
  }

  rewindFromMessage(sessionId: string, targetId: number): { fromId: number; prompt: string } {
    if (!this.sessionExists(sessionId)) throw new Error("会话不存在");
    const target = this.database.prepare("SELECT id FROM messages WHERE id=? AND session_id=?").get(targetId, sessionId) as Row | undefined;
    if (!target) throw new Error("消息不存在");
    const userRow = this.database.prepare(
      "SELECT id, content, created_at FROM messages WHERE session_id=? AND role='user' AND id<=? ORDER BY id DESC LIMIT 1",
    ).get(sessionId, targetId) as Row | undefined;
    if (!userRow) throw new Error("该位置之前没有可重新编辑的用户指令");
    const fromId = userRow.id as number;
    const fromTime = userRow.created_at as string;
    const proposalsToUndo = (this.database.prepare(
      "SELECT id, status FROM proposals WHERE session_id=? AND created_at>=? AND status='accepted' ORDER BY id DESC",
    ).all(sessionId, fromTime) as Row[]);
    const undonePaths: string[] = [];
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
    const undoneCharacters: string[] = [];
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
      undoneCharacters.push(after.name);
    }
    this.database.prepare("DELETE FROM messages WHERE session_id=? AND id>=?").run(sessionId, fromId);
    this.database.prepare("DELETE FROM proposals WHERE session_id=? AND created_at>=? AND status!='accepted' AND id NOT IN (SELECT proposal_id FROM revisions WHERE proposal_id IS NOT NULL)").run(sessionId, fromTime);
    const changes = [
      undonePaths.length ? `文档：${undonePaths.join("、")}` : "",
      undoneCharacters.length ? `角色卡：${undoneCharacters.join("、")}` : "",
    ].filter(Boolean).join("；");
    const summary = changes
      ? `已撤销用户指令 #${fromId} 及其后续上下文，回退 ${changes}。`
      : `已撤销用户指令 #${fromId} 及其后续上下文，无关联修改。`;
    this.addSystemMessage(sessionId, summary);
    this.reindex();
    return { fromId, prompt: String(userRow.content) };
  }

  addSystemMessage(sessionId: string, content: string): void {
    const now = new Date().toISOString();
    this.database.prepare("INSERT INTO messages(session_id,role,content,created_at) VALUES(?,'system',?,?)")
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
