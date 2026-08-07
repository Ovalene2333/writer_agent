import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ActiveRoleplayState, AgentEvaluationCaseResult, AgentEvaluationRun, AgentEvaluationStatus, AgentTodoItem, AgentTurnBlock, AgentTurnMessage, ChangeSet, ChangeSetFileChange, ChangeSetFileOperation, ChapterSummary, Character, DocumentVersionDetail, DocumentVersionMeta, Message, MessageAttachment, MessageAttachmentInput, MessageChannel, MessageContent, MessageContentPart, Proposal, ProposalCharacterChange, ProseQualityReport,
  RoleplayContentRating, RoleplayInputMode, RoleplayInterlocutor, RoleplayMemoryFact, RoleplayMemoryFactKind, RoleplayMemoryFactStatus, RoleplayParticipant, RoleplayScene,
  RoleplaySessionMemory, RoleplayWorkingState, SavedRoleplayInterlocutor, StyleTemplate, TokenPricing, UsageSummary, WritingExample,
  MessageStepTrail, PersistedStreamStep,
} from "./types.js";
import {
  extensionForImageMime,
  isSupportedImageMime,
  MULTIMODAL_MAX_ATTACHMENTS,
  MULTIMODAL_MAX_BYTES,
  normalizeImageMime,
} from "./model_compat.js";
import { blockAtOffset, documentBlocks } from "./document_blocks.js";
import { documentSpans } from "./document_spans.js";
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
import { comparePathNames } from "./path_sort.js";
import { calculateUsageCost } from "./pricing.js";
import { normalizeResourcePath, WriterProject } from "./project.js";
import {
  WRITING_MEMORY_KINDS,
  type WritingMemoryCandidate,
  type WritingMemoryEntry,
  type WritingMemoryKind,
} from "./writing_memory.js";
import type {
  ContextEdge, ContextEdgeKind, ContextNode, ContextNodeKind, ContextNodeStatus,
} from "./context_graph.js";
import {
  buildContextGraphView, newContextEdgeId, newContextNodeId, type ContextGraphView,
} from "./context_graph.js";

type Row = Record<string, unknown>;
type ProposalCharacterRevision = { characterId: number; before: Character; after: Character };

export class ProposalDocumentBaseChangedError extends Error {
  readonly code = "PROPOSAL_DOCUMENT_BASE_CHANGED";

  constructor(readonly path: string) {
    super(`终审期间目标文档已变化：${path}`);
    this.name = "ProposalDocumentBaseChangedError";
  }
}

export interface RoleplayBranchSummary {
  id: string;
  groupId: string;
  fromMessageId: number;
  label: string;
  preview: string;
  messageCount: number;
  createdAt: string;
}

type RoleplayBranchPayload = {
  messages: Array<{
    id: number;
    role: Message["role"];
    content: string;
    createdAt: string;
    channel: MessageChannel;
    variantGroupId?: string;
    roleplayPerception?: string;
    roleplayModelInput?: string;
    roleplayInputMode?: RoleplayInputMode;
  }>;
  memory?: RoleplaySessionMemory;
  memorySnapshots: Array<{ throughMessageId: number; contextKey: string; memoryJson: string; createdAt: string }>;
  facts: Array<Record<string, unknown>>;
};

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

/**
 * Advisory data only — a proposal written before the column existed, or one whose
 * report shape has since changed, simply shows no quality card in the review dock.
 * Never throw here: a bad blob must not make the proposal unreadable.
 */
/**
 * Cache optimisation only — a block written by an older build, or one whose blob
 * got truncated, simply drops out of the replay chain and that turn is paid for
 * again. Never throw: a bad blob must not make the session unrunnable.
 */
function parseAgentTurnMessages(value: unknown): AgentTurnMessage[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return undefined;
    const messages: AgentTurnMessage[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") return undefined;
      const message = item as Partial<AgentTurnMessage>;
      if (message.role !== "system" && message.role !== "user" && message.role !== "assistant" && message.role !== "tool") return undefined;
      const content = normalizeTurnContent(message.content);
      if (content === undefined) return undefined;
      messages.push({
        role: message.role,
        content,
        ...(typeof message.tool_call_id === "string" ? { tool_call_id: message.tool_call_id } : {}),
        ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
        ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}),
      });
    }
    return messages;
  } catch {
    return undefined;
  }
}

function normalizeTurnContent(value: unknown): MessageContent | undefined {
  if (value === null || typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: MessageContentPart[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const part = item as Partial<MessageContentPart>;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url" && part.image_url && typeof part.image_url === "object") {
      const url = (part.image_url as { url?: unknown }).url;
      if (typeof url !== "string" || !url) return undefined;
      const detail = (part.image_url as { detail?: unknown }).detail;
      parts.push({
        type: "image_url",
        image_url: {
          url,
          ...(detail === "auto" || detail === "low" || detail === "high" ? { detail } : {}),
        },
      });
      continue;
    }
    return undefined;
  }
  return parts;
}

function parseMessageAttachments(value: unknown): MessageAttachment[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): MessageAttachment[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as Partial<MessageAttachment>;
      if (typeof row.id !== "string" || typeof row.mimeType !== "string" || typeof row.storagePath !== "string") return [];
      const rawGeneration = row.imageGeneration;
      const imageGeneration = rawGeneration && typeof rawGeneration === "object"
        && typeof rawGeneration.finalPrompt === "string" && rawGeneration.finalPrompt.trim()
        ? {
            finalPrompt: rawGeneration.finalPrompt,
            ...(typeof rawGeneration.revisedPrompt === "string" && rawGeneration.revisedPrompt.trim()
              ? { revisedPrompt: rawGeneration.revisedPrompt }
              : {}),
            ...(Array.isArray(rawGeneration.referenceAttachmentIds)
              ? {
                  referenceAttachmentIds: [...new Set(rawGeneration.referenceAttachmentIds
                    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
                    .map(id => id.trim()))].slice(0, 4),
                }
              : {}),
          }
        : undefined;
      return [{
        id: row.id,
        name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : row.id,
        mimeType: row.mimeType,
        size: Number(row.size) || 0,
        storagePath: row.storagePath,
        ...(imageGeneration ? { imageGeneration } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function parseProposalQualityReport(value: unknown): ProseQualityReport | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const report = parsed as Partial<ProseQualityReport>;
    if (typeof report.grade !== "string" || !report.vividness || !report.aiTells) return undefined;
    return {
      characters: Number(report.characters) || 0,
      vividness: report.vividness,
      aiTells: report.aiTells,
      grade: report.grade as ProseQualityReport["grade"],
      ...(report.length && typeof report.length === "object" ? { length: report.length } : {}),
      warnings: Array.isArray(report.warnings) ? report.warnings : [],
    };
  } catch {
    return undefined;
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
  private closed = false;

  constructor(readonly project: WriterProject) {
    mkdirSync(project.privateDir, { recursive: true });
    this.database = new DatabaseSync(resolve(project.privateDir, "writer.db"));
    try {
      // busy_timeout: multi-process readers/writers wait instead of failing immediately.
      this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      this.migrate();
      this.migrateCharacterCardsToJsonl();
      this.migrateSimpleCharacterCardsToJsonl();
      this.reindex();
      // Close trails left "running" by a crashed process (in-memory jobs are gone).
      this.finalizeOrphanedStepTrails("进程异常退出：未完成的任务已标记失败，可从原指令续跑。");
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
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
      CREATE TABLE IF NOT EXISTS roleplay_branches (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        base_message_id INTEGER NOT NULL,
        from_message_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS roleplay_branches_group ON roleplay_branches(session_id,group_id,created_at);
      CREATE TABLE IF NOT EXISTS proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_message_id INTEGER,
        delivery_ready INTEGER NOT NULL DEFAULT 1,
        path TEXT NOT NULL,
        summary TEXT NOT NULL,
        before_content TEXT NOT NULL,
        after_content TEXT NOT NULL,
        base_hash TEXT NOT NULL,
        character_changes_json TEXT NOT NULL DEFAULT '[]',
        quality_report_json TEXT NOT NULL DEFAULT '',
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
        quality_report_json TEXT NOT NULL DEFAULT '',
        undone INTEGER NOT NULL DEFAULT 0,
        label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS revisions_path_after_hash ON revisions(path, after_hash, id DESC);
      CREATE TABLE IF NOT EXISTS change_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_message_id INTEGER,
        summary TEXT NOT NULL,
        character_changes_json TEXT NOT NULL DEFAULT '[]',
        character_revisions_json TEXT NOT NULL DEFAULT '[]',
        before_config TEXT NOT NULL DEFAULT '',
        after_config TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        undone INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS change_set_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        change_set_id INTEGER NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        path TEXT NOT NULL,
        target_path TEXT,
        before_content TEXT NOT NULL,
        after_content TEXT NOT NULL,
        base_hash TEXT NOT NULL,
        target_base_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS writing_examples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        gate_hash TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS roleplay_scenes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        setting TEXT NOT NULL DEFAULT '',
        premise TEXT NOT NULL DEFAULT '',
        tone TEXT NOT NULL DEFAULT '',
        timeline_anchor TEXT NOT NULL DEFAULT '',
        performer_goal TEXT NOT NULL DEFAULT '',
        identity_goal TEXT NOT NULL DEFAULT '',
        stakes_json TEXT NOT NULL DEFAULT '[]',
        opening_variants_json TEXT NOT NULL DEFAULT '[]',
        end_conditions_json TEXT NOT NULL DEFAULT '[]',
        lore_bindings_json TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roleplay_memory_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        context_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source_message_id INTEGER,
        known_by_json TEXT NOT NULL DEFAULT '["public"]',
        importance INTEGER NOT NULL DEFAULT 50,
        status TEXT NOT NULL DEFAULT 'active',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS roleplay_memory_facts_context ON roleplay_memory_facts(session_id,context_key,status,pinned);
      CREATE TABLE IF NOT EXISTS roleplay_memory_snapshots (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        through_message_id INTEGER NOT NULL,
        context_key TEXT NOT NULL,
        memory_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id,through_message_id)
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
        created_at TEXT NOT NULL,
        job_id TEXT,
        call_kind TEXT NOT NULL DEFAULT 'unspecified',
        step INTEGER,
        request_components_json TEXT NOT NULL DEFAULT '[]'
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
      CREATE TABLE IF NOT EXISTS writing_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_message_id INTEGER NOT NULL,
        source_proposal_id INTEGER,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        character_ids_json TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL DEFAULT 50,
        status TEXT NOT NULL DEFAULT 'active',
        source_path TEXT NOT NULL DEFAULT '',
        source_hash TEXT NOT NULL DEFAULT '',
        source_evidence TEXT NOT NULL DEFAULT '',
        source_anchor_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id,source_message_id,kind,content,source_path,source_evidence)
      );
      CREATE INDEX IF NOT EXISTS writing_memory_session
        ON writing_memory(session_id,status,importance,updated_at);
      CREATE INDEX IF NOT EXISTS writing_memory_source
        ON writing_memory(source_path,source_hash,status);
      CREATE TABLE IF NOT EXISTS session_context (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        active_document TEXT,
        current_intent TEXT NOT NULL DEFAULT '',
        agent_checkpoint_json TEXT NOT NULL DEFAULT '{}',
        agent_run_state_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_turn_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL,
        messages_json TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, turn_index)
      );
      CREATE INDEX IF NOT EXISTS agent_turn_blocks_session ON agent_turn_blocks(session_id, turn_index);
      CREATE TABLE IF NOT EXISTS agent_replay_commits (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES agent_replay_commits(id),
        source_message_id INTEGER,
        project_snapshot_hash TEXT NOT NULL DEFAULT '',
        project_update_included INTEGER NOT NULL DEFAULT 0,
        messages_json TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposal_applications (
        proposal_id INTEGER PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        before_content TEXT NOT NULL,
        after_hash TEXT NOT NULL,
        created_file INTEGER NOT NULL,
        character_revisions_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS change_set_applications (
        change_set_id INTEGER PRIMARY KEY REFERENCES change_sets(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        character_revisions_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_replay_commits_session
        ON agent_replay_commits(session_id, created_at);
      CREATE TABLE IF NOT EXISTS agent_replay_heads (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        head_commit_id TEXT REFERENCES agent_replay_commits(id),
        generation INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_replay_trunks (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        snapshot_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_step_trails (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_message_id INTEGER NOT NULL,
        job_id TEXT,
        steps_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, source_message_id)
      );
      CREATE INDEX IF NOT EXISTS message_step_trails_session
        ON message_step_trails(session_id, source_message_id);
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_message_id INTEGER NOT NULL,
        original_request TEXT NOT NULL,
        status TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_runs_session
        ON agent_runs(session_id, created_at);
      CREATE TABLE IF NOT EXISTS agent_run_events (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_key TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence),
        UNIQUE(run_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS agent_run_events_type
        ON agent_run_events(run_id, type, sequence);
      CREATE TABLE IF NOT EXISTS context_nodes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        label TEXT NOT NULL DEFAULT '',
        source_message_id INTEGER,
        job_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS context_nodes_session
        ON context_nodes(session_id, status, kind, created_at);
      CREATE INDEX IF NOT EXISTS context_nodes_message
        ON context_nodes(session_id, source_message_id);
      CREATE TABLE IF NOT EXISTS context_edges (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS context_edges_session
        ON context_edges(session_id, kind);
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
      CREATE TABLE IF NOT EXISTS agent_evaluation_runs (
        id TEXT PRIMARY KEY,
        provider_source TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_evaluation_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES agent_evaluation_runs(id) ON DELETE CASCADE,
        case_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        expected_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        events_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, case_id)
      );
      CREATE INDEX IF NOT EXISTS agent_evaluation_cases_run ON agent_evaluation_cases(run_id, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS document_index USING fts5(path UNINDEXED, content);
    `);
    const revisionColumns = this.database.prepare("PRAGMA table_info(revisions)").all() as Row[];
    // Legacy project-wide facts are intentionally discarded. Writing memory is
    // session-scoped and may only be rebuilt from accepted text in that session.
    this.database.exec("DROP TABLE IF EXISTS continuity_facts");
    if (!revisionColumns.some(column => column.name === "created_file")) {
      this.database.exec("ALTER TABLE revisions ADD COLUMN created_file INTEGER NOT NULL DEFAULT 0");
    }
    if (!revisionColumns.some(column => column.name === "character_revisions_json")) {
      this.database.exec("ALTER TABLE revisions ADD COLUMN character_revisions_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!revisionColumns.some(column => column.name === "quality_report_json")) {
      this.database.exec("ALTER TABLE revisions ADD COLUMN quality_report_json TEXT NOT NULL DEFAULT ''");
    }
    if (!revisionColumns.some(column => column.name === "label")) {
      this.database.exec("ALTER TABLE revisions ADD COLUMN label TEXT NOT NULL DEFAULT ''");
    }
    const changeSetColumns = this.database.prepare("PRAGMA table_info(change_sets)").all() as Row[];
    if (!changeSetColumns.some(column => column.name === "before_config")) {
      this.database.exec("ALTER TABLE change_sets ADD COLUMN before_config TEXT NOT NULL DEFAULT ''");
    }
    if (!changeSetColumns.some(column => column.name === "after_config")) {
      this.database.exec("ALTER TABLE change_sets ADD COLUMN after_config TEXT NOT NULL DEFAULT ''");
    }
    if (!changeSetColumns.some(column => column.name === "source_message_id")) {
      this.database.exec("ALTER TABLE change_sets ADD COLUMN source_message_id INTEGER");
    }
    const proposalColumns = this.database.prepare("PRAGMA table_info(proposals)").all() as Row[];
    if (!proposalColumns.some(column => column.name === "character_changes_json")) {
      this.database.exec("ALTER TABLE proposals ADD COLUMN character_changes_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!proposalColumns.some(column => column.name === "quality_report_json")) {
      this.database.exec("ALTER TABLE proposals ADD COLUMN quality_report_json TEXT NOT NULL DEFAULT ''");
    }
    if (!proposalColumns.some(column => column.name === "source_message_id")) {
      this.database.exec("ALTER TABLE proposals ADD COLUMN source_message_id INTEGER");
    }
    if (!proposalColumns.some(column => column.name === "delivery_ready")) {
      this.database.exec("ALTER TABLE proposals ADD COLUMN delivery_ready INTEGER NOT NULL DEFAULT 1");
    }
    const writingExampleColumns = this.database.prepare("PRAGMA table_info(writing_examples)").all() as Row[];
    if (!writingExampleColumns.some(column => column.name === "gate_hash")) {
      this.database.exec("ALTER TABLE writing_examples ADD COLUMN gate_hash TEXT NOT NULL DEFAULT ''");
    }
    const sessionColumns = this.database.prepare("PRAGMA table_info(sessions)").all() as Row[];
    if (!sessionColumns.some(column => column.name === "auto_title_done")) {
      this.database.exec("ALTER TABLE sessions ADD COLUMN auto_title_done INTEGER NOT NULL DEFAULT 0");
    }
    const contextColumns = this.database.prepare("PRAGMA table_info(session_context)").all() as Row[];
    if (!contextColumns.some(column => column.name === "todos_json")) {
      this.database.exec("ALTER TABLE session_context ADD COLUMN todos_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!contextColumns.some(column => column.name === "agent_checkpoint_json")) {
      this.database.exec("ALTER TABLE session_context ADD COLUMN agent_checkpoint_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!contextColumns.some(column => column.name === "agent_run_state_json")) {
      this.database.exec("ALTER TABLE session_context ADD COLUMN agent_run_state_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!contextColumns.some(column => column.name === "materials_shelf_json")) {
      this.database.exec("ALTER TABLE session_context ADD COLUMN materials_shelf_json TEXT NOT NULL DEFAULT '[]'");
    }
    const messageColumns = this.database.prepare("PRAGMA table_info(messages)").all() as Row[];
    if (!messageColumns.some(column => column.name === "channel")) {
      this.database.exec("ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'agent'");
    }
    if (!messageColumns.some(column => column.name === "variant_group_id")) {
      this.database.exec("ALTER TABLE messages ADD COLUMN variant_group_id TEXT");
    }
    if (!messageColumns.some(column => column.name === "roleplay_perception")) {
      this.database.exec("ALTER TABLE messages ADD COLUMN roleplay_perception TEXT");
    }
    if (!messageColumns.some(column => column.name === "roleplay_model_input")) {
      this.database.exec("ALTER TABLE messages ADD COLUMN roleplay_model_input TEXT");
    }
    if (!messageColumns.some(column => column.name === "roleplay_input_mode")) {
      this.database.exec("ALTER TABLE messages ADD COLUMN roleplay_input_mode TEXT");
    }
    if (!messageColumns.some(column => column.name === "attachments_json")) {
      this.database.exec("ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'");
    }
    this.database.exec(`UPDATE messages
      SET roleplay_input_mode=CASE
        WHEN roleplay_perception LIKE '［OOC 导演指示%' THEN 'director'
        ELSE 'dialogue'
      END
      WHERE channel='roleplay' AND role='user'
        AND roleplay_input_mode IS NULL`);
    const variantColumns = this.database.prepare("PRAGMA table_info(message_variants)").all() as Row[];
    if (!variantColumns.some(column => column.name === "prompt")) {
      this.database.exec("ALTER TABLE message_variants ADD COLUMN prompt TEXT NOT NULL DEFAULT ''");
    }
    const usageColumns = this.database.prepare("PRAGMA table_info(model_usage)").all() as Row[];
    if (!usageColumns.some(column => column.name === "job_id")) {
      this.database.exec("ALTER TABLE model_usage ADD COLUMN job_id TEXT");
    }
    if (!usageColumns.some(column => column.name === "call_kind")) {
      this.database.exec("ALTER TABLE model_usage ADD COLUMN call_kind TEXT NOT NULL DEFAULT 'unspecified'");
    }
    if (!usageColumns.some(column => column.name === "step")) {
      this.database.exec("ALTER TABLE model_usage ADD COLUMN step INTEGER");
    }
    if (!usageColumns.some(column => column.name === "request_components_json")) {
      this.database.exec("ALTER TABLE model_usage ADD COLUMN request_components_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!usageColumns.some(column => column.name === "provider_name")) {
      this.database.exec("ALTER TABLE model_usage ADD COLUMN provider_name TEXT NOT NULL DEFAULT ''");
    }
    const replayCommitColumns = this.database.prepare("PRAGMA table_info(agent_replay_commits)").all() as Row[];
    if (!replayCommitColumns.some(column => column.name === "project_update_included")) {
      this.database.exec("ALTER TABLE agent_replay_commits ADD COLUMN project_update_included INTEGER NOT NULL DEFAULT 0");
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

  writingMemory(sessionId: string, options: {
    statuses?: Array<"active" | "stale">;
    sourcePath?: string;
    limit?: number;
  } = {}): WritingMemoryEntry[] {
    const statuses = options.statuses?.filter(status => status === "active" || status === "stale");
    const where = ["session_id=?"];
    const values: Array<string | number> = [sessionId];
    if (statuses?.length) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      values.push(...statuses);
    }
    if (options.sourcePath) {
      where.push("source_path=?");
      values.push(options.sourcePath);
    }
    const limit = Math.max(1, Math.min(1_000, Math.round(options.limit ?? 300)));
    values.push(limit);
    return (this.database.prepare(`SELECT * FROM writing_memory
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
        importance DESC,updated_at DESC,id DESC LIMIT ?`).all(...values) as Row[])
      .map(row => writingMemoryFromRow(row));
  }

  refreshWritingMemoryForDocument(path: string, content: string): void {
    const hash = this.project.hash(content);
    const rows = this.database.prepare("SELECT id,source_evidence FROM writing_memory WHERE source_path=?").all(path) as Row[];
    const now = new Date().toISOString();
    const update = this.database.prepare(`UPDATE writing_memory
      SET source_hash=?,source_anchor_id=?,status=?,updated_at=? WHERE id=?`);
    for (const row of rows) {
      const evidence = String(row.source_evidence ?? "");
      const survives = Boolean(evidence && content.includes(evidence));
      update.run(hash, survives ? writingMemoryEvidenceAnchor(content, hash, evidence) : "", survives ? "active" : "stale", now, Number(row.id));
    }
  }

  moveWritingMemorySource(fromPath: string, toPath: string, content: string): void {
    const now = new Date().toISOString();
    const hash = this.project.hash(content);
    const rows = this.database.prepare("SELECT id,source_evidence FROM writing_memory WHERE source_path=?").all(fromPath) as Row[];
    const update = this.database.prepare(`UPDATE writing_memory
      SET source_path=?,source_hash=?,source_anchor_id=?,updated_at=? WHERE id=?`);
    for (const row of rows) {
      update.run(toPath, hash, writingMemoryEvidenceAnchor(content, hash, String(row.source_evidence ?? "")), now, Number(row.id));
    }
  }

  saveExtractedWritingMemory(
    sessionId: string,
    sourceMessageId: number,
    path: string,
    content: string,
    proposalId: number,
    candidates: WritingMemoryCandidate[],
  ): WritingMemoryEntry[] {
    const sourceMessageExists = Number.isInteger(sourceMessageId) && sourceMessageId > 0
      && Boolean(this.database.prepare("SELECT 1 AS ok FROM messages WHERE session_id=? AND id=?").get(sessionId, sourceMessageId));
    if (!this.sessionExists(sessionId) || !sourceMessageExists
      || this.project.isDocumentHidden(path)) return [];
    const saved: WritingMemoryEntry[] = [];
    const hash = this.project.hash(content);
    const now = new Date().toISOString();
    const insert = this.database.prepare(`INSERT INTO writing_memory(
      session_id,source_message_id,source_proposal_id,kind,content,character_ids_json,importance,status,
      source_path,source_hash,source_evidence,source_anchor_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,'active',?,?,?,?,?,?)
    ON CONFLICT(session_id,source_message_id,kind,content,source_path,source_evidence) DO UPDATE SET
      source_hash=excluded.source_hash,source_anchor_id=excluded.source_anchor_id,status='active',updated_at=excluded.updated_at`);
    for (const candidate of candidates.slice(0, 18)) {
      if (!candidate.sourceEvidence || !content.includes(candidate.sourceEvidence)) continue;
      insert.run(
        sessionId, sourceMessageId, proposalId > 0 ? proposalId : null, candidate.kind,
        candidate.content, JSON.stringify(candidate.characterIds), candidate.importance,
        path, hash, candidate.sourceEvidence,
        writingMemoryEvidenceAnchor(content, hash, candidate.sourceEvidence), now, now,
      );
    }
    return this.writingMemory(sessionId, { statuses: ["active"], sourcePath: path, limit: 200 })
      .filter(item => item.sourceMessageId === sourceMessageId);
  }

  writingMemoryPacket(sessionId: string, options: {
    targetPath?: string;
    characterIds?: number[];
    limit?: number;
  } = {}): WritingMemoryEntry[] {
    const entries = this.writingMemory(sessionId, { statuses: ["active"], limit: 1_000 })
      .filter(item => !item.sourcePath || !this.project.isDocumentHidden(item.sourcePath));
    const characterIds = new Set(options.characterIds ?? []);
    const targetPath = options.targetPath ?? "";
    return entries.map(entry => {
      let score = entry.importance;
      if (targetPath && entry.sourcePath === targetPath) score += 70;
      if (entry.characterIds.some(id => characterIds.has(id))) score += 90;
      if (entry.kind === "open_thread" || entry.kind === "character_state") score += 20;
      return { entry, score };
    }).sort((a, b) => b.score - a.score || b.entry.id - a.entry.id)
      .slice(0, Math.max(1, Math.min(40, options.limit ?? 24)))
      .map(item => item.entry);
  }

  deleteWritingMemoryFromMessage(sessionId: string, fromMessageId: number): void {
    this.database.prepare("DELETE FROM writing_memory WHERE session_id=? AND source_message_id>=?")
      .run(sessionId, fromMessageId);
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

  /**
   * Drop sticky task residue when the dialogue is rewound or a new task starts.
   * Immutable context artifacts are session-level read-through cache entries, not
   * task workflow state. Preserve them across ordinary task switches; rewinds and
   * reruns keep the default full clear so removed dialogue cannot leak its reads.
   */
  clearSessionTaskState(
    sessionId: string,
    options: { preserveContextArtifacts?: boolean; preserveMaterialsShelf?: boolean } = {},
  ): void {
    const now = new Date().toISOString();
    const preserveMaterialsShelf = options.preserveMaterialsShelf ?? options.preserveContextArtifacts ?? false;
    const materialsShelf = preserveMaterialsShelf ? this.sessionMaterialsShelf(sessionId) : [];
    this.database.prepare(`INSERT INTO session_context(
        session_id,active_document,current_intent,todos_json,agent_checkpoint_json,agent_run_state_json,materials_shelf_json,updated_at
      ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
        active_document=NULL,current_intent='',todos_json='[]',agent_checkpoint_json='{}',agent_run_state_json='{}',
        materials_shelf_json=excluded.materials_shelf_json,updated_at=excluded.updated_at`)
      .run(sessionId, null, "", "[]", "{}", "{}", JSON.stringify(materialsShelf), now);
    if (!options.preserveContextArtifacts) {
      this.database.prepare("DELETE FROM context_artifacts WHERE session_id=?").run(sessionId);
    }
  }

  /**
   * After process restart, any step trail still marked `running` cannot resume its
   * in-memory job. Mark those steps failed so the UI does not show a zombie run.
   */
  finalizeOrphanedStepTrails(_reason = "任务已中断"): number {
    const rows = this.database.prepare(
      `SELECT session_id,source_message_id,steps_json FROM message_step_trails`,
    ).all() as Array<{ session_id: string; source_message_id: number; steps_json: string }>;
    let updated = 0;
    const now = new Date().toISOString();
    for (const row of rows) {
      try {
        const steps = JSON.parse(String(row.steps_json ?? "[]")) as unknown;
        if (!Array.isArray(steps) || !steps.length) continue;
        let dirty = false;
        const next = steps.map((item) => {
          if (!item || typeof item !== "object") return item;
          const step = item as Record<string, unknown>;
          if (step.status !== "running") return item;
          dirty = true;
          return { ...step, status: "failed" };
        });
        if (!dirty) continue;
        this.database.prepare(
          `UPDATE message_step_trails SET steps_json=?, updated_at=? WHERE session_id=? AND source_message_id=?`,
        ).run(JSON.stringify(next), now, row.session_id, row.source_message_id);
        updated += 1;
      } catch {
        /* skip corrupt trail rows */
      }
    }
    return updated;
  }

  upsertMessageStepTrail(
    sessionId: string,
    sourceMessageId: number,
    steps: PersistedStreamStep[],
    options?: { jobId?: string },
  ): void {
    if (!this.sessionExists(sessionId)) return;
    if (!Number.isInteger(sourceMessageId) || sourceMessageId < 1) return;
    if (!Array.isArray(steps) || !steps.length) return;
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO message_step_trails(session_id,source_message_id,job_id,steps_json,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(session_id,source_message_id) DO UPDATE SET
        job_id=excluded.job_id,
        steps_json=excluded.steps_json,
        updated_at=excluded.updated_at`)
      .run(sessionId, sourceMessageId, options?.jobId ?? null, JSON.stringify(steps), now);
  }

  messageStepTrails(sessionId: string, sourceMessageIds?: number[]): MessageStepTrail[] {
    if (!this.sessionExists(sessionId)) return [];
    const rows = sourceMessageIds?.length
      ? (() => {
          const ids = [...new Set(sourceMessageIds.filter(id => Number.isInteger(id) && id > 0))];
          if (!ids.length) return [] as Row[];
          const placeholders = ids.map(() => "?").join(",");
          return this.database.prepare(
            `SELECT source_message_id,job_id,steps_json,updated_at FROM message_step_trails
              WHERE session_id=? AND source_message_id IN (${placeholders})
              ORDER BY source_message_id ASC`,
          ).all(sessionId, ...ids) as Row[];
        })()
      : this.database.prepare(
          `SELECT source_message_id,job_id,steps_json,updated_at FROM message_step_trails
            WHERE session_id=? ORDER BY source_message_id DESC LIMIT 50`,
        ).all(sessionId) as Row[];
    return rows.flatMap(row => {
      try {
        const steps = JSON.parse(String(row.steps_json ?? "[]")) as unknown;
        if (!Array.isArray(steps) || !steps.length) return [];
        const normalized = steps.flatMap((item): PersistedStreamStep[] => {
          if (!item || typeof item !== "object") return [];
          const step = item as Record<string, unknown>;
          const id = Number(step.id);
          if (!Number.isFinite(id)) return [];
          const status = step.status === "running" || step.status === "failed" ? step.status : "completed";
          return [{
            id,
            output: typeof step.output === "string" ? step.output : "",
            reasoning: typeof step.reasoning === "string" ? step.reasoning : "",
            tools: Array.isArray(step.tools) ? step.tools.filter((name): name is string => typeof name === "string") : [],
            status,
            ...(step.usage && typeof step.usage === "object" ? { usage: step.usage as PersistedStreamStep["usage"] } : {}),
          }];
        });
        if (!normalized.length) return [];
        const jobId = typeof row.job_id === "string" && row.job_id ? row.job_id : undefined;
        const withBreakdown = jobId
          ? this.attachStepCallBreakdownFromUsage(normalized, jobId)
          : normalized;
        return [{
          sourceMessageId: Number(row.source_message_id),
          ...(jobId ? { jobId } : {}),
          steps: withBreakdown,
          updatedAt: String(row.updated_at ?? ""),
        }];
      } catch {
        return [];
      }
    });
  }

  /**
   * Historical trails often only stored the step-level aggregate (model=多个模型).
   * Rebuild per-call rows from model_usage so the UI can attribute low hit rates.
   */
  private attachStepCallBreakdownFromUsage(
    steps: PersistedStreamStep[],
    jobId: string,
  ): PersistedStreamStep[] {
    if (!steps.some(step => step.usage && !(step.usage.callBreakdown?.length))) return steps;
    type UsageRow = {
      step: number | null;
      call_kind: string;
      model: string;
      provider_name: string;
      prompt_tokens: number;
      completion_tokens: number;
      cache_hit_tokens: number;
      cache_miss_tokens: number;
      cost: number;
      currency: string;
    };
    let rows: UsageRow[] = [];
    try {
      rows = this.database.prepare(
        `SELECT step, call_kind, model, provider_name,
                prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens,
                cost, currency
           FROM model_usage
          WHERE job_id=? AND step IS NOT NULL
          ORDER BY id ASC`,
      ).all(jobId) as UsageRow[];
    } catch {
      return steps;
    }
    if (!rows.length) return steps;
    const byStep = new Map<number, NonNullable<PersistedStreamStep["usage"]>["callBreakdown"]>();
    for (const row of rows) {
      const stepId = Number(row.step);
      if (!Number.isFinite(stepId)) continue;
      const call = {
        model: String(row.model ?? ""),
        providerName: String(row.provider_name ?? "").trim() || undefined,
        callKind: String(row.call_kind || "unspecified"),
        promptTokens: Number(row.prompt_tokens) || 0,
        completionTokens: Number(row.completion_tokens) || 0,
        cacheHitTokens: Number(row.cache_hit_tokens) || 0,
        cacheMissTokens: Number(row.cache_miss_tokens) || 0,
        cost: Number(row.cost) || 0,
        currency: String(row.currency || "CNY"),
      };
      const list = byStep.get(stepId) ?? [];
      list.push(call);
      byStep.set(stepId, list);
    }
    return steps.map(step => {
      if (!step.usage || step.usage.callBreakdown?.length) return step;
      const breakdown = byStep.get(step.id);
      if (!breakdown?.length) return step;
      return { ...step, usage: { ...step.usage, callBreakdown: breakdown } };
    });
  }

  deleteMessageStepTrailsFrom(sessionId: string, fromMessageId: number): void {
    if (!this.sessionExists(sessionId)) return;
    if (!Number.isInteger(fromMessageId) || fromMessageId < 1) return;
    this.database.prepare(
      "DELETE FROM message_step_trails WHERE session_id=? AND source_message_id>=?",
    ).run(sessionId, fromMessageId);
  }

  createContextNode(input: {
    sessionId: string;
    kind: ContextNodeKind;
    label: string;
    status?: ContextNodeStatus;
    sourceMessageId?: number;
    jobId?: string;
    payload?: Record<string, unknown>;
    id?: string;
  }): ContextNode {
    const now = new Date().toISOString();
    const node: ContextNode = {
      id: input.id ?? newContextNodeId(input.kind === "epoch" ? "epoch" : input.kind === "handoff" ? "hand" : "ctx"),
      sessionId: input.sessionId,
      kind: input.kind,
      status: input.status ?? "active",
      label: input.label,
      ...(input.sourceMessageId != null ? { sourceMessageId: input.sourceMessageId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      payload: input.payload ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.database.prepare(`INSERT INTO context_nodes(
      id,session_id,kind,status,label,source_message_id,job_id,payload_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      node.id, node.sessionId, node.kind, node.status, node.label,
      node.sourceMessageId ?? null, node.jobId ?? null, JSON.stringify(node.payload),
      node.createdAt, node.updatedAt,
    );
    return node;
  }

  addContextEdge(input: {
    sessionId: string;
    fromId: string;
    toId: string;
    kind: ContextEdgeKind;
  }): ContextEdge {
    const edge: ContextEdge = {
      id: newContextEdgeId(),
      sessionId: input.sessionId,
      fromId: input.fromId,
      toId: input.toId,
      kind: input.kind,
      createdAt: new Date().toISOString(),
    };
    this.database.prepare(
      "INSERT INTO context_edges(id,session_id,from_id,to_id,kind,created_at) VALUES(?,?,?,?,?,?)",
    ).run(edge.id, edge.sessionId, edge.fromId, edge.toId, edge.kind, edge.createdAt);
    return edge;
  }

  updateContextNode(sessionId: string, id: string, patch: {
    status?: ContextNodeStatus;
    label?: string;
    payload?: Record<string, unknown>;
  }): void {
    const row = this.database.prepare("SELECT * FROM context_nodes WHERE session_id=? AND id=?")
      .get(sessionId, id) as Row | undefined;
    if (!row) return;
    const status = patch.status ?? String(row.status);
    const label = patch.label ?? String(row.label ?? "");
    const payload = patch.payload ?? JSON.parse(String(row.payload_json || "{}"));
    const updatedAt = new Date().toISOString();
    this.database.prepare(
      "UPDATE context_nodes SET status=?, label=?, payload_json=?, updated_at=? WHERE session_id=? AND id=?",
    ).run(status, label, JSON.stringify(payload), updatedAt, sessionId, id);
  }

  contextNodes(sessionId: string, options?: { status?: ContextNodeStatus; kind?: ContextNodeKind }): ContextNode[] {
    if (!this.sessionExists(sessionId)) return [];
    let sql = "SELECT * FROM context_nodes WHERE session_id=?";
    const args: Array<string | number | null> = [sessionId];
    if (options?.status) {
      sql += " AND status=?";
      args.push(options.status);
    }
    if (options?.kind) {
      sql += " AND kind=?";
      args.push(options.kind);
    }
    sql += " ORDER BY created_at ASC";
    return (this.database.prepare(sql).all(...args) as Row[]).map(row => this.contextNodeFromRow(row));
  }

  contextEdges(sessionId: string): ContextEdge[] {
    if (!this.sessionExists(sessionId)) return [];
    return (this.database.prepare(
      "SELECT * FROM context_edges WHERE session_id=? ORDER BY created_at ASC",
    ).all(sessionId) as Row[]).map(row => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      fromId: String(row.from_id),
      toId: String(row.to_id),
      kind: row.kind as ContextEdgeKind,
      createdAt: String(row.created_at),
    }));
  }

  contextGraph(sessionId: string, options?: { limit?: number }): ContextGraphView {
    return buildContextGraphView(sessionId, this.contextNodes(sessionId), this.contextEdges(sessionId), options);
  }

  activeContextHandoffs(sessionId: string): ContextNode[] {
    return this.contextNodes(sessionId, { status: "active", kind: "handoff" });
  }

  /** Active project trunk node (shared outline/character materials), if any. */
  activeContextTrunk(sessionId: string): ContextNode | undefined {
    return this.contextNodes(sessionId, { status: "active", kind: "project_note" })
      .find(node => (node.payload as { kind?: unknown }).kind === "trunk");
  }

  /**
   * Upsert the session trunk graph node when materials hash changes.
   * Same hash reuses the existing node so assemble edges stay stable.
   */
  ensureContextTrunk(sessionId: string, input: {
    hash: string;
    label: string;
    payload: Record<string, unknown>;
  }): ContextNode {
    const existing = this.activeContextTrunk(sessionId);
    if (existing) {
      const prevHash = (existing.payload as { hash?: unknown }).hash;
      if (prevHash === input.hash) {
        // Refresh payload metrics without changing identity/bytes linkage.
        this.updateContextNode(sessionId, existing.id, {
          label: input.label,
          payload: { ...existing.payload, ...input.payload, kind: "trunk", hash: input.hash },
        });
        return { ...existing, label: input.label, payload: { ...existing.payload, ...input.payload, kind: "trunk", hash: input.hash } };
      }
      this.updateContextNode(sessionId, existing.id, { status: "archived" });
    }
    const node = this.createContextNode({
      sessionId,
      kind: "project_note",
      label: input.label,
      payload: { ...input.payload, kind: "trunk", hash: input.hash },
    });
    if (existing) {
      this.addContextEdge({ sessionId, fromId: node.id, toId: existing.id, kind: "supersedes" });
    }
    return node;
  }

  /**
   * Retire earlier handoffs for the same chapter once it is delivered again.
   *
   * Without this a rewrite leaves two active handoffs for one chapter, and the
   * L2 prompt block hands the model both the stale and the fresh seam tail.
   * The archived node stays in the graph behind a `supersedes` edge, so the UI
   * can still show that this chapter was written more than once.
   */
  supersedeContextHandoffs(sessionId: string, chapterKey: string, newNodeId: string): number {
    if (!chapterKey || !this.sessionExists(sessionId)) return 0;
    const stale = this.activeContextHandoffs(sessionId).filter((node) => {
      if (node.id === newNodeId) return false;
      const key = (node.payload as { chapterKey?: unknown }).chapterKey;
      return typeof key === "string" && key === chapterKey;
    });
    for (const node of stale) {
      this.updateContextNode(sessionId, node.id, { status: "archived" });
      this.addContextEdge({ sessionId, fromId: newNodeId, toId: node.id, kind: "supersedes" });
    }
    return stale.length;
  }

  /**
   * Archive graph nodes tied to rewound messages (edit / re-run).
   * Keeps history for debugging but removes them from active assemble.
   */
  archiveContextGraphFrom(sessionId: string, fromMessageId: number): void {
    if (!this.sessionExists(sessionId)) return;
    if (!Number.isInteger(fromMessageId) || fromMessageId < 1) return;
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE context_nodes SET status='archived', updated_at=?
      WHERE session_id=? AND source_message_id IS NOT NULL AND source_message_id>=? AND status='active'`)
      .run(now, sessionId, fromMessageId);
    // Also archive epochs/handoffs that only hang off archived messages via job id later if needed.
  }

  private contextNodeFromRow(row: Row): ContextNode {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(String(row.payload_json || "{}")) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      kind: row.kind as ContextNodeKind,
      status: row.status === "archived" ? "archived" : "active",
      label: String(row.label ?? ""),
      ...(row.source_message_id != null ? { sourceMessageId: Number(row.source_message_id) } : {}),
      ...(typeof row.job_id === "string" && row.job_id ? { jobId: String(row.job_id) } : {}),
      payload,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
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

  /**
   * Session-level materials shelf (lore/character digests). Survives jobs in the
   * same session; call sites invalidate by sourceHash against current files.
   */
  sessionMaterialsShelf(sessionId: string): import("./tools/types.js").MaterialsShelfEntry[] {
    if (!this.sessionExists(sessionId)) return [];
    const row = this.database.prepare("SELECT materials_shelf_json FROM session_context WHERE session_id=?")
      .get(sessionId) as Row | undefined;
    if (typeof row?.materials_shelf_json !== "string" || !row.materials_shelf_json.trim()) return [];
    try {
      const parsed = JSON.parse(row.materials_shelf_json) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const rowItem = item as Record<string, unknown>;
        if (typeof rowItem.key !== "string" || !rowItem.key.trim()) return [];
        if (typeof rowItem.sourceHash !== "string" || typeof rowItem.kind !== "string") return [];
        if (typeof rowItem.digest !== "string") return [];
        return [{
          key: rowItem.key,
          ...(typeof rowItem.path === "string" ? { path: rowItem.path } : {}),
          ...(typeof rowItem.characterId === "number" && Number.isInteger(rowItem.characterId)
            ? { characterId: rowItem.characterId }
            : {}),
          sourceHash: rowItem.sourceHash,
          kind: rowItem.kind,
          digest: rowItem.digest,
          bodyChars: typeof rowItem.bodyChars === "number" ? rowItem.bodyChars : 0,
          fullBodyServed: rowItem.fullBodyServed === true,
          ...(Array.isArray(rowItem.coveredSections)
            ? { coveredSections: rowItem.coveredSections.filter((value): value is string => typeof value === "string") }
            : {}),
          ...(Array.isArray(rowItem.coveredFields)
            ? { coveredFields: rowItem.coveredFields.filter((value): value is string => typeof value === "string") }
            : {}),
          ...(Array.isArray(rowItem.exactEvidenceRanges)
            ? { exactEvidenceRanges: rowItem.exactEvidenceRanges.flatMap(value => {
                if (!value || typeof value !== "object" || Array.isArray(value)) return [];
                const range = value as Record<string, unknown>;
                return typeof range.startLine === "number" && typeof range.endLine === "number"
                  ? [{ startLine: range.startLine, endLine: range.endLine }]
                  : [];
              }) }
            : {}),
          ...(Array.isArray(rowItem.artifactIds)
            ? { artifactIds: rowItem.artifactIds.filter((value): value is number => typeof value === "number" && Number.isInteger(value)) }
            : {}),
          ...(rowItem.hardConstraints && typeof rowItem.hardConstraints === "object" && !Array.isArray(rowItem.hardConstraints)
            ? { hardConstraints: rowItem.hardConstraints as import("./character_constraints.js").CharacterConstraintView }
            : {}),
          ...(rowItem.retention === "executable" || rowItem.retention === "coverage" || rowItem.retention === "recoverable"
            ? { retention: rowItem.retention }
            : {}),
        }];
      });
    } catch {
      return [];
    }
  }

  saveSessionMaterialsShelf(
    sessionId: string,
    entries: readonly import("./tools/types.js").MaterialsShelfEntry[],
  ): void {
    if (!this.sessionExists(sessionId)) return;
    const now = new Date().toISOString();
    const json = JSON.stringify(entries.map(item => ({
      key: item.key,
      ...(item.path ? { path: item.path } : {}),
      ...(item.characterId != null ? { characterId: item.characterId } : {}),
      sourceHash: item.sourceHash,
      kind: item.kind,
      digest: item.digest,
      bodyChars: item.bodyChars,
      fullBodyServed: item.fullBodyServed,
      ...(item.coveredSections?.length ? { coveredSections: item.coveredSections } : {}),
      ...(item.coveredFields?.length ? { coveredFields: item.coveredFields } : {}),
      ...(item.exactEvidenceRanges?.length ? { exactEvidenceRanges: item.exactEvidenceRanges } : {}),
      ...(item.artifactIds?.length ? { artifactIds: item.artifactIds } : {}),
      ...(item.hardConstraints ? { hardConstraints: item.hardConstraints } : {}),
      ...(item.retention ? { retention: item.retention } : {}),
    })));
    const existing = this.database.prepare("SELECT 1 AS ok FROM session_context WHERE session_id=?").get(sessionId) as Row | undefined;
    if (existing) {
      this.database.prepare("UPDATE session_context SET materials_shelf_json=?, updated_at=? WHERE session_id=?")
        .run(json, now, sessionId);
      return;
    }
    this.database.prepare(
      `INSERT INTO session_context(session_id,active_document,current_intent,todos_json,materials_shelf_json,updated_at)
       VALUES(?,?,?,?,?,?)`,
    ).run(sessionId, null, "", "[]", json, now);
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

  importCharacterCards(input: { characters?: unknown[]; simpleCharacters?: unknown[] }): {
    characters: Character[];
    simpleCharacters: SavedRoleplayInterlocutor[];
  } {
    const rawCharacters = input.characters ?? [];
    const rawSimpleCharacters = input.simpleCharacters ?? [];
    if (!Array.isArray(rawCharacters) || !Array.isArray(rawSimpleCharacters)) throw new Error("角色卡导入内容必须是数组");
    if (rawCharacters.length > 200 || rawSimpleCharacters.length > 200) throw new Error("单次最多导入各 200 张角色卡");
    if (!rawCharacters.length && !rawSimpleCharacters.length) throw new Error("导入文件中没有角色卡");

    const existingCharacters = this.characters();
    const existingSimpleCharacters = this.roleplayInterlocutors();
    const normalizedCharacters = rawCharacters.map((value, index) => {
      try { return this.normalizeCharacter(value); }
      catch (error) { throw new Error(`普通角色卡 #${index + 1}：${error instanceof Error ? error.message : String(error)}`); }
    });
    const sourceCharacterIds = new Set<number>();
    for (const character of normalizedCharacters) {
      if (sourceCharacterIds.has(character.id)) throw new Error(`导入包中的普通角色 ID ${character.id} 重复`);
      sourceCharacterIds.add(character.id);
    }

    let nextCharacterId = Math.max(0, ...existingCharacters.map(character => character.id)) + 1;
    const characterIdMap = new Map(normalizedCharacters.map(character => [character.id, nextCharacterId++]));
    const importedAt = new Date().toISOString();
    const importedCharacters = normalizedCharacters.map(character => ({
      ...character,
      id: characterIdMap.get(character.id)!,
      relationships: character.relationships.map(relationship => ({
        ...relationship,
        characterId: characterIdMap.get(relationship.characterId) ?? relationship.characterId,
      })),
      updatedAt: importedAt,
    }));
    const nextCharacters = [...existingCharacters, ...importedCharacters];
    validateCharacters(nextCharacters, this.outlineNodeIds());

    const normalizedSimpleCharacters = rawSimpleCharacters.map((value, index) => {
      try { return normalizeSavedSimpleCharacter(value); }
      catch (error) { throw new Error(`简易角色卡 #${index + 1}：${error instanceof Error ? error.message : String(error)}`); }
    });
    const sourceSimpleIds = new Set<number>();
    for (const card of normalizedSimpleCharacters) {
      if (sourceSimpleIds.has(card.id)) throw new Error(`导入包中的简易角色 ID ${card.id} 重复`);
      sourceSimpleIds.add(card.id);
    }
    let nextSimpleId = Math.max(0, ...existingSimpleCharacters.map(card => card.id)) + 1;
    const importedSimpleCharacters = normalizedSimpleCharacters.map(card => ({
      ...card,
      id: nextSimpleId++,
      ...(card.targetCharacterId
        ? { targetCharacterId: characterIdMap.get(card.targetCharacterId) ?? card.targetCharacterId }
        : {}),
      createdAt: importedAt,
      updatedAt: importedAt,
    }));
    const knownCharacterIds = new Set(nextCharacters.map(character => character.id));
    for (const card of importedSimpleCharacters) {
      if (card.targetCharacterId && !knownCharacterIds.has(card.targetCharacterId)) {
        throw new Error(`简易角色卡“${card.name}”关联的普通角色不存在`);
      }
    }

    this.writeCharacters(nextCharacters);
    this.writeSimpleCharacters([...existingSimpleCharacters, ...importedSimpleCharacters]);
    return { characters: importedCharacters, simpleCharacters: importedSimpleCharacters };
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

  applyCharacterChangesWithRevision(
    sessionId: string,
    messageId: number,
    id: number,
    input: ApplyCharacterChangesInput,
  ): { character: Character; applied: AppliedCharacterChange[]; skipped: SkippedCharacterChange[] } {
    const before = this.characters().find(item => item.id === id);
    if (!before) throw new Error("要修改的角色不存在");
    const result = this.applyCharacterChanges(id, input);
    this.database.prepare(`INSERT INTO character_revisions(
      session_id,message_id,character_id,before_file,after_file,before_content,after_content,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      sessionId, messageId, id, "characters.jsonl", "characters.jsonl",
      JSON.stringify(before), JSON.stringify(result.character), new Date().toISOString(),
    );
    return result;
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
    const cards = this.project.readSimpleCharacterCardsJsonl().split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      try { return [normalizeSavedSimpleCharacter(JSON.parse(line) as unknown)]; }
      catch (error) {
        throw new Error(`characters/simple-characters.jsonl:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    const ids = new Set<number>();
    for (const card of cards) {
      if (ids.has(card.id)) throw new Error(`characters/simple-characters.jsonl: 简易角色 ID ${card.id} 重复`);
      ids.add(card.id);
    }
    return cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
  }

  agentCheckpoint(sessionId: string): import("./types.js").AgentCheckpoint | undefined {
    const row = this.database.prepare("SELECT agent_checkpoint_json FROM session_context WHERE session_id=?").get(sessionId) as Row | undefined;
    if (typeof row?.agent_checkpoint_json !== "string" || !row.agent_checkpoint_json.trim() || row.agent_checkpoint_json === "{}") return undefined;
    try {
      const value = JSON.parse(row.agent_checkpoint_json) as import("./types.js").AgentCheckpoint;
      return value?.version === 1 ? value : undefined;
    } catch { return undefined; }
  }

  saveAgentCheckpoint(sessionId: string, checkpoint: import("./types.js").AgentCheckpoint): void {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO session_context(session_id,active_document,current_intent,todos_json,agent_checkpoint_json,updated_at)
      VALUES(?,NULL,'','[]',?,?) ON CONFLICT(session_id) DO UPDATE SET agent_checkpoint_json=excluded.agent_checkpoint_json,updated_at=excluded.updated_at`)
      .run(sessionId, JSON.stringify(checkpoint), now);
  }

  clearAgentCheckpoint(sessionId: string): void {
    this.database.prepare("UPDATE session_context SET agent_checkpoint_json='{}',updated_at=? WHERE session_id=?")
      .run(new Date().toISOString(), sessionId);
  }

  /**
   * Lazily import the old mutable rows into an immutable replay ledger. Existing
   * projects keep their warm chain; all new writes only append commits and move a
   * per-session head pointer. The legacy table is retained only as migration input.
   */
  private ensureAgentReplayLedger(sessionId: string): void {
    if (this.database.prepare("SELECT 1 AS ok FROM agent_replay_heads WHERE session_id=?").get(sessionId)) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 AS ok FROM agent_replay_heads WHERE session_id=?").get(sessionId)) {
        const legacy = this.database.prepare(`SELECT messages_json,estimated_tokens,created_at
          FROM agent_turn_blocks WHERE session_id=? ORDER BY turn_index`).all(sessionId) as Row[];
        let parentId: string | null = null;
        const insert = this.database.prepare(`INSERT INTO agent_replay_commits(
          id,session_id,parent_id,source_message_id,project_snapshot_hash,project_update_included,messages_json,estimated_tokens,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`);
        for (const row of legacy) {
          if (!parseAgentTurnMessages(row.messages_json)) break;
          const id = randomUUID();
          insert.run(id, sessionId, parentId, null, "", 0, String(row.messages_json), Number(row.estimated_tokens) || 0,
            String(row.created_at ?? new Date().toISOString()));
          parentId = id;
        }
        this.database.prepare(`INSERT INTO agent_replay_heads(session_id,head_commit_id,generation,updated_at)
          VALUES(?,?,0,?)`).run(sessionId, parentId, new Date().toISOString());
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  agentRunState(sessionId: string): import("./types.js").AgentRunState | undefined {
    const row = this.database.prepare("SELECT agent_run_state_json FROM session_context WHERE session_id=?").get(sessionId) as Row | undefined;
    if (typeof row?.agent_run_state_json !== "string" || !row.agent_run_state_json.trim() || row.agent_run_state_json === "{}") return undefined;
    try {
      const value = JSON.parse(row.agent_run_state_json) as import("./types.js").AgentRunState;
      return value?.version === 1 && Array.isArray(value.documentObligations) ? value : undefined;
    } catch { return undefined; }
  }

  saveAgentRunState(sessionId: string, state: import("./types.js").AgentRunState): void {
    const now = new Date().toISOString();
    const next = { ...state, updatedAt: now };
    this.database.prepare(`INSERT INTO session_context(
        session_id,active_document,current_intent,todos_json,agent_run_state_json,updated_at
      ) VALUES(?,NULL,'','[]',?,?) ON CONFLICT(session_id) DO UPDATE SET
        agent_run_state_json=excluded.agent_run_state_json,updated_at=excluded.updated_at`)
      .run(sessionId, JSON.stringify(next), now);
  }

  clearAgentRunState(sessionId: string): void {
    this.database.prepare("UPDATE session_context SET agent_run_state_json='{}',updated_at=? WHERE session_id=?")
      .run(new Date().toISOString(), sessionId);
  }

  /** Active immutable commit chain, oldest first. Invalid payload truncates the visible suffix. */
  agentTurnBlocks(sessionId: string): AgentTurnBlock[] {
    this.ensureAgentReplayLedger(sessionId);
    const rows = this.database.prepare(`WITH RECURSIVE chain(
        id,parent_id,source_message_id,project_snapshot_hash,project_update_included,messages_json,estimated_tokens,created_at,depth
      ) AS (
        SELECT c.id,c.parent_id,c.source_message_id,c.project_snapshot_hash,c.project_update_included,c.messages_json,c.estimated_tokens,c.created_at,0
        FROM agent_replay_heads h JOIN agent_replay_commits c ON c.id=h.head_commit_id
        WHERE h.session_id=?
        UNION ALL
        SELECT p.id,p.parent_id,p.source_message_id,p.project_snapshot_hash,p.project_update_included,p.messages_json,p.estimated_tokens,p.created_at,chain.depth+1
        FROM agent_replay_commits p JOIN chain ON p.id=chain.parent_id
        WHERE p.session_id=?
      ) SELECT * FROM chain ORDER BY depth DESC`).all(sessionId, sessionId) as Row[];
    const blocks: AgentTurnBlock[] = [];
    for (const [turnIndex, row] of rows.entries()) {
      const messages = parseAgentTurnMessages(row.messages_json);
      if (!messages) break;
      const sourceMessageId = Number(row.source_message_id);
      const projectSnapshotHash = String(row.project_snapshot_hash ?? "");
      blocks.push({
        commitId: String(row.id),
        turnIndex,
        ...(Number.isInteger(sourceMessageId) && sourceMessageId > 0 ? { sourceMessageId } : {}),
        ...(projectSnapshotHash ? { projectSnapshotHash } : {}),
        ...(Number(row.project_update_included) === 1 ? { projectUpdateIncluded: true } : {}),
        messages,
        estimatedTokens: Number(row.estimated_tokens) || 0,
        createdAt: String(row.created_at ?? ""),
      });
    }
    return blocks;
  }

  agentReplayTrunk(sessionId: string): { hash: string; content: string; estimatedTokens: number } | undefined {
    const row = this.database.prepare(`SELECT snapshot_hash,content,estimated_tokens
      FROM agent_replay_trunks WHERE session_id=?`).get(sessionId) as Row | undefined;
    if (!row || typeof row.snapshot_hash !== "string" || typeof row.content !== "string") return undefined;
    return { hash: row.snapshot_hash, content: row.content, estimatedTokens: Number(row.estimated_tokens) || 0 };
  }

  pinAgentReplayTrunk(sessionId: string, trunk: { hash: string; content: string; estimatedTokens: number }): void {
    this.database.prepare(`INSERT INTO agent_replay_trunks(session_id,snapshot_hash,content,estimated_tokens,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET snapshot_hash=excluded.snapshot_hash,
      content=excluded.content,estimated_tokens=excluded.estimated_tokens,updated_at=excluded.updated_at`)
      .run(sessionId, trunk.hash, trunk.content, trunk.estimatedTokens, new Date().toISOString());
  }

  appendAgentTurnBlock(sessionId: string, block: {
    turnIndex: number;
    sourceMessageId?: number;
    projectSnapshotHash?: string;
    projectUpdateIncluded?: boolean;
    messages: AgentTurnMessage[];
    estimatedTokens: number;
  }): void {
    if (!block.messages.length) return;
    this.ensureAgentReplayLedger(sessionId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const head = this.database.prepare("SELECT head_commit_id FROM agent_replay_heads WHERE session_id=?")
        .get(sessionId) as Row | undefined;
      const id = randomUUID();
      const sourceMessageId = Number(block.sourceMessageId);
      this.database.prepare(`INSERT INTO agent_replay_commits(
        id,session_id,parent_id,source_message_id,project_snapshot_hash,project_update_included,messages_json,estimated_tokens,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        id,
        sessionId,
        typeof head?.head_commit_id === "string" ? head.head_commit_id : null,
        Number.isInteger(sourceMessageId) && sourceMessageId > 0 ? sourceMessageId : null,
        block.projectSnapshotHash ?? "",
        block.projectUpdateIncluded ? 1 : 0,
        JSON.stringify(block.messages),
        block.estimatedTokens,
        new Date().toISOString(),
      );
      this.database.prepare("UPDATE agent_replay_heads SET head_commit_id=?,updated_at=? WHERE session_id=?")
        .run(id, new Date().toISOString(), sessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  /** Atomically publish a compacted chain. Old commits remain available as an archived branch. */
  replaceAgentTurnBlocks(sessionId: string, blocks: Array<{
    sourceMessageId?: number;
    projectSnapshotHash?: string;
    projectUpdateIncluded?: boolean;
    messages: AgentTurnMessage[];
    estimatedTokens: number;
  }>): void {
    this.ensureAgentReplayLedger(sessionId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let parentId: string | null = null;
      const insert = this.database.prepare(`INSERT INTO agent_replay_commits(
        id,session_id,parent_id,source_message_id,project_snapshot_hash,project_update_included,messages_json,estimated_tokens,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`);
      for (const block of blocks) {
        if (!block.messages.length) continue;
        const id = randomUUID();
        const sourceMessageId = Number(block.sourceMessageId);
        insert.run(
          id, sessionId, parentId,
          Number.isInteger(sourceMessageId) && sourceMessageId > 0 ? sourceMessageId : null,
          block.projectSnapshotHash ?? "", block.projectUpdateIncluded ? 1 : 0,
          JSON.stringify(block.messages), block.estimatedTokens, new Date().toISOString(),
        );
        parentId = id;
      }
      this.database.prepare(`UPDATE agent_replay_heads
        SET head_commit_id=?,generation=generation+1,updated_at=? WHERE session_id=?`)
        .run(parentId, new Date().toISOString(), sessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  /** Move the active pointer to the newest ancestor strictly before targetId. */
  truncateAgentTurnBlocksFromMessage(sessionId: string, targetId: number): void {
    const blocks = this.agentTurnBlocks(sessionId);
    // Legacy commits have no source ownership. A cold restart is safer than replaying
    // one removed instruction; subsequent branches retain precise ancestry.
    const keep = blocks.some(block => block.sourceMessageId === undefined)
      ? undefined
      : [...blocks].reverse().find(block => (block.sourceMessageId ?? 0) < targetId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`UPDATE agent_replay_heads
        SET head_commit_id=?,generation=generation+1,updated_at=? WHERE session_id=?`)
        .run(keep?.commitId ?? null, new Date().toISOString(), sessionId);
      if (!keep) this.database.prepare("DELETE FROM agent_replay_trunks WHERE session_id=?").run(sessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  clearAgentTurnBlocks(sessionId: string): void {
    this.ensureAgentReplayLedger(sessionId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`UPDATE agent_replay_heads
        SET head_commit_id=NULL,generation=generation+1,updated_at=? WHERE session_id=?`)
        .run(new Date().toISOString(), sessionId);
      this.database.prepare("DELETE FROM agent_replay_trunks WHERE session_id=?").run(sessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  nextAgentTurnIndex(sessionId: string): number {
    return this.agentTurnBlocks(sessionId).length;
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
    const cards = this.roleplayInterlocutors();
    const now = new Date().toISOString();
    if (input.id !== undefined && (!Number.isInteger(input.id) || input.id < 1)) throw new Error("试演身份 ID 无效");
    const existing = input.id ? cards.find(card => card.id === input.id) : undefined;
    if (input.id && !existing) throw new Error("试演身份不存在");
    const id = existing?.id ?? Math.max(0, ...cards.map(card => card.id)) + 1;
    const saved: SavedRoleplayInterlocutor = {
      id,
      ...(targetCharacterId ? { targetCharacterId } : {}),
      ...value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.writeSimpleCharacters([...cards.filter(card => card.id !== id), saved]);
    return saved;
  }

  deleteRoleplayInterlocutor(id: number): void {
    const cards = this.roleplayInterlocutors();
    if (!cards.some(card => card.id === id)) throw new Error("试演身份不存在");
    this.writeSimpleCharacters(cards.filter(card => card.id !== id));
  }

  roleplayScenes(): RoleplayScene[] {
    return this.database.prepare("SELECT * FROM roleplay_scenes ORDER BY updated_at DESC,id DESC").all()
      .map(row => roleplaySceneFromRow(row as Row));
  }

  saveRoleplayScene(input: Partial<RoleplayScene> & { name: string }): RoleplayScene {
    const name = roleplayField(input.name, "场景名称", 120, true);
    const field = (value: unknown, label: string, max = 2_000) => roleplayField(value ?? "", label, max);
    const loreBindings = normalizeStringArray(input.loreBindings, 30, 300)
      .filter(path => (path.startsWith("lore/") || path.startsWith("story/"))
        && this.project.documentExists(path) && !this.project.isDocumentHidden(path));
    const values = {
      name,
      setting: field(input.setting, "场景地点"),
      premise: field(input.premise, "场景前提"),
      tone: field(input.tone, "场景基调", 400),
      timelineAnchor: field(input.timelineAnchor, "时间锚点", 400),
      performerGoal: field(input.performerGoal, "扮演者目标", 800),
      identityGoal: field(input.identityGoal, "当前身份目标", 800),
      stakes: normalizeStringArray(input.stakes, 12, 300),
      openingVariants: normalizeStringArray(input.openingVariants, 12, 1_000),
      endConditions: normalizeStringArray(input.endConditions, 12, 300),
      loreBindings,
    };
    const now = new Date().toISOString();
    let id = Number(input.id);
    if (Number.isInteger(id) && id > 0) {
      const result = this.database.prepare(`UPDATE roleplay_scenes SET
        name=?,setting=?,premise=?,tone=?,timeline_anchor=?,performer_goal=?,identity_goal=?,stakes_json=?,
        opening_variants_json=?,end_conditions_json=?,lore_bindings_json=?,revision=revision+1,updated_at=? WHERE id=?`)
        .run(values.name, values.setting, values.premise, values.tone, values.timelineAnchor, values.performerGoal,
          values.identityGoal, JSON.stringify(values.stakes), JSON.stringify(values.openingVariants),
          JSON.stringify(values.endConditions), JSON.stringify(values.loreBindings), now, id);
      if (!result.changes) throw new Error("角色扮演场景不存在");
    } else {
      id = Number(this.database.prepare(`INSERT INTO roleplay_scenes(
        name,setting,premise,tone,timeline_anchor,performer_goal,identity_goal,stakes_json,opening_variants_json,
        end_conditions_json,lore_bindings_json,revision,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        values.name, values.setting, values.premise, values.tone, values.timelineAnchor, values.performerGoal,
        values.identityGoal, JSON.stringify(values.stakes), JSON.stringify(values.openingVariants),
        JSON.stringify(values.endConditions), JSON.stringify(values.loreBindings), 1, now, now,
      ).lastInsertRowid);
    }
    const row = this.database.prepare("SELECT * FROM roleplay_scenes WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("角色扮演场景保存失败");
    return roleplaySceneFromRow(row);
  }

  deleteRoleplayScene(id: number): void {
    if (!this.database.prepare("DELETE FROM roleplay_scenes WHERE id=?").run(id).changes) throw new Error("角色扮演场景不存在");
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
      const scenes = this.roleplayScenes();
      const storedSceneIds = Array.isArray(raw.sceneIds)
        ? [...new Set(raw.sceneIds.map(Number).filter(id => Number.isInteger(id) && id > 0))]
        : [];
      const legacySceneId = Number(raw.sceneId);
      const sceneIds = Array.isArray(raw.sceneIds)
        ? storedSceneIds
        : Number.isInteger(legacySceneId) && legacySceneId > 0 ? [legacySceneId] : [];
      const sceneSequence = sceneIds.flatMap(id => {
        const scene = scenes.find(item => item.id === id);
        return scene ? [scene] : [];
      });
      const storedSceneIndex = Number(raw.sceneIndex);
      const sceneIndex = sceneSequence.length
        ? Math.min(Math.max(Number.isInteger(storedSceneIndex) ? storedSceneIndex : 0, 0), sceneSequence.length - 1)
        : 0;
      const scene = sceneSequence[sceneIndex];
      const contentRating: RoleplayContentRating = raw.contentRating === "sfw" || raw.contentRating === "nsfw"
        ? raw.contentRating
        : "default";
      return { performer, identity, ...(scene ? { scene } : {}), sceneSequence, sceneIndex, contentRating };
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
      sceneSequence: [],
      sceneIndex: 0,
      contentRating: "default",
    };
  }

  saveActiveRoleplay(
    sessionId: string,
    performerInput: number | RoleplayParticipant,
    identityInput: RoleplayParticipant | RoleplayInterlocutor | SavedRoleplayInterlocutor,
    sceneInput?: number | RoleplayScene,
    contentRatingInput?: RoleplayContentRating,
    sceneSequenceInput?: number[],
    sceneIndexInput?: number,
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
    const scenes = this.roleplayScenes();
    const sceneId = typeof sceneInput === "number" ? sceneInput : sceneInput?.id;
    const legacyScene = Number.isInteger(sceneId) ? scenes.find(item => item.id === sceneId) : undefined;
    if (sceneId !== undefined && !legacyScene) throw new Error("角色扮演场景不存在");
    const requestedSceneIds = sceneSequenceInput === undefined
      ? (legacyScene ? [legacyScene.id] : [])
      : [...new Set(sceneSequenceInput.map(Number).filter(id => Number.isInteger(id) && id > 0))];
    const sceneSequence = requestedSceneIds.map(id => {
      const scene = scenes.find(item => item.id === id);
      if (!scene) throw new Error("角色扮演场景不存在");
      return scene;
    });
    const requestedSceneIndex = Number(sceneIndexInput);
    const sceneIndex = sceneSequence.length
      ? Math.min(Math.max(Number.isInteger(requestedSceneIndex) ? requestedSceneIndex : 0, 0), sceneSequence.length - 1)
      : 0;
    const scene = sceneSequence[sceneIndex];
    const contentRating: RoleplayContentRating = contentRatingInput === "sfw" || contentRatingInput === "nsfw"
      ? contentRatingInput
      : "default";
    const active: ActiveRoleplayState = {
      performer: normalizedPerformer, identity, ...(scene ? { scene } : {}), sceneSequence, sceneIndex, contentRating,
    };
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO active_roleplays(session_id,character_id,interlocutor_json,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      character_id=excluded.character_id,interlocutor_json=excluded.interlocutor_json,updated_at=excluded.updated_at`)
      .run(sessionId, normalizedPerformer.kind === "normal" ? (normalizedPerformer.id ?? 0) : 0,
        JSON.stringify({
          performer: active.performer,
          identity: active.identity,
          ...(scene ? { sceneId: scene.id } : {}),
          sceneIds: sceneSequence.map(item => item.id),
          sceneIndex,
          contentRating,
        }), now);
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

  clearActiveRoleplay(sessionId: string, options?: { preserveMemory?: boolean }): void {
    this.database.prepare("DELETE FROM active_roleplays WHERE session_id=?").run(sessionId);
    if (!options?.preserveMemory) this.clearRoleplayMemory(sessionId);
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
    this.database.prepare("DELETE FROM roleplay_memory_snapshots WHERE session_id=?").run(sessionId);
  }

  roleplayMemoryFacts(sessionId: string, contextKey?: string): RoleplayMemoryFact[] {
    const rows = contextKey
      ? this.database.prepare("SELECT * FROM roleplay_memory_facts WHERE session_id=? AND context_key=? ORDER BY pinned DESC,importance DESC,id DESC").all(sessionId, contextKey)
      : this.database.prepare("SELECT * FROM roleplay_memory_facts WHERE session_id=? ORDER BY pinned DESC,importance DESC,id DESC").all(sessionId);
    return rows.map(row => roleplayMemoryFactFromRow(row as Row));
  }

  saveRoleplayMemoryFact(sessionId: string, contextKey: string, input: Partial<RoleplayMemoryFact> & { content: string }): RoleplayMemoryFact {
    if (!this.sessionExists(sessionId)) throw new Error("会话不存在");
    const content = roleplayField(input.content, "记忆事实", 1_000, true);
    const kind = normalizeFactKind(input.kind);
    const status = normalizeFactStatus(input.status);
    const knownBy = normalizeKnownBy(input.knownBy);
    const importance = Math.max(0, Math.min(100, Math.round(Number(input.importance ?? 50)) || 0));
    const sourceMessageId = Number(input.sourceMessageId);
    const source = Number.isInteger(sourceMessageId) && sourceMessageId > 0 ? sourceMessageId : undefined;
    const now = new Date().toISOString();
    let id = Number(input.id);
    if (Number.isInteger(id) && id > 0) {
      const result = this.database.prepare(`UPDATE roleplay_memory_facts SET
        kind=?,content=?,known_by_json=?,importance=?,status=?,pinned=?,updated_at=? WHERE id=? AND session_id=?`)
        .run(kind, content, JSON.stringify(knownBy), importance, status, input.pinned ? 1 : 0, now, id, sessionId);
      if (!result.changes) throw new Error("角色扮演记忆不存在");
    } else {
      id = Number(this.database.prepare(`INSERT INTO roleplay_memory_facts(
        session_id,context_key,kind,content,source_message_id,known_by_json,importance,status,pinned,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        sessionId, contextKey.trim(), kind, content, source ?? null, JSON.stringify(knownBy), importance, status,
        input.pinned ? 1 : 0, now, now,
      ).lastInsertRowid);
    }
    const row = this.database.prepare("SELECT * FROM roleplay_memory_facts WHERE id=? AND session_id=?").get(id, sessionId) as Row | undefined;
    if (!row) throw new Error("角色扮演记忆保存失败");
    return roleplayMemoryFactFromRow(row);
  }

  upsertExtractedRoleplayFacts(
    sessionId: string,
    contextKey: string,
    facts: Array<Partial<RoleplayMemoryFact> & { content: string }>,
  ): RoleplayMemoryFact[] {
    const saved: RoleplayMemoryFact[] = [];
    for (const fact of facts.slice(0, 12)) {
      const content = fact.content.trim();
      if (!content) continue;
      const existing = this.database.prepare(`SELECT * FROM roleplay_memory_facts
        WHERE session_id=? AND context_key=? AND content=? AND status!='retracted' ORDER BY id DESC LIMIT 1`)
        .get(sessionId, contextKey, content) as Row | undefined;
      if (existing) {
        saved.push(roleplayMemoryFactFromRow(existing));
        continue;
      }
      saved.push(this.saveRoleplayMemoryFact(sessionId, contextKey, fact));
    }
    return saved;
  }

  deleteRoleplayMemoryFact(sessionId: string, id: number): void {
    if (!this.database.prepare("DELETE FROM roleplay_memory_facts WHERE session_id=? AND id=?").run(sessionId, id).changes) {
      throw new Error("角色扮演记忆不存在");
    }
  }

  saveRoleplayMemorySnapshot(sessionId: string, throughMessageId: number, memory: RoleplaySessionMemory): void {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO roleplay_memory_snapshots(session_id,through_message_id,context_key,memory_json,created_at)
      VALUES(?,?,?,?,?) ON CONFLICT(session_id,through_message_id) DO UPDATE SET
      context_key=excluded.context_key,memory_json=excluded.memory_json,created_at=excluded.created_at`)
      .run(sessionId, throughMessageId, memory.performerKey, JSON.stringify(memory), now);
  }

  restoreRoleplayMemoryBefore(sessionId: string, fromMessageId: number): void {
    const row = this.database.prepare(`SELECT memory_json FROM roleplay_memory_snapshots
      WHERE session_id=? AND through_message_id<? ORDER BY through_message_id DESC LIMIT 1`).get(sessionId, fromMessageId) as Row | undefined;
    if (row) {
      try { this.saveRoleplayMemory(sessionId, JSON.parse(String(row.memory_json)) as RoleplaySessionMemory); }
      catch { this.database.prepare("DELETE FROM roleplay_memory WHERE session_id=?").run(sessionId); }
    } else {
      this.database.prepare("DELETE FROM roleplay_memory WHERE session_id=?").run(sessionId);
    }
    this.database.prepare("DELETE FROM roleplay_memory_snapshots WHERE session_id=? AND through_message_id>=?").run(sessionId, fromMessageId);
    this.database.prepare("DELETE FROM roleplay_memory_facts WHERE session_id=? AND source_message_id>=? AND pinned=0").run(sessionId, fromMessageId);
  }

  writingExamples(): WritingExample[] {
    return this.database.prepare("SELECT * FROM writing_examples ORDER BY updated_at DESC, id DESC").all()
      .map(row => this.exampleFromRow(row as Row));
  }

  saveWritingExample(
    input: Omit<WritingExample, "id" | "updatedAt" | "gatePassed"> & { id?: number; gatePassed?: boolean },
  ): WritingExample {
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title || !content) throw new Error("示例标题和正文不能为空");
    const gateHash = input.gatePassed === true ? this.project.hash(content) : "";
    const values = [title, input.category.trim(), content, input.notes.trim(), gateHash, new Date().toISOString()];
    let id = input.id;
    if (id) {
      const result = this.database.prepare("UPDATE writing_examples SET title=?, category=?, content=?, notes=?, gate_hash=?, updated_at=? WHERE id=?").run(...values, id);
      if (!result.changes) throw new Error("写作示例不存在");
    } else {
      id = Number(this.database.prepare("INSERT INTO writing_examples(title,category,content,notes,gate_hash,updated_at) VALUES(?,?,?,?,?,?)").run(...values).lastInsertRowid);
    }
    return this.writingExample(id);
  }

  deleteWritingExample(id: number): void {
    if (!this.database.prepare("DELETE FROM writing_examples WHERE id=?").run(id).changes) throw new Error("写作示例不存在");
  }

  seedStyleExample(template: StyleTemplate, gatePassed = false, previousName?: string): void {
    const titles = new Set([
      `[风格模板] ${template.name}`,
      ...(previousName && previousName !== template.name ? [`[风格模板] ${previousName}`] : []),
    ]);
    const existing = this.writingExamples().find((item) => titles.has(item.title));
    if (!template.exampleContent.trim()) {
      if (existing) this.database.prepare("DELETE FROM writing_examples WHERE id=?").run(existing.id);
      return;
    }
    const gateHash = gatePassed ? this.project.hash(template.exampleContent.trim()) : "";
    if (existing) {
      this.database.prepare("UPDATE writing_examples SET category=?, content=?, notes=?, gate_hash=?, updated_at=? WHERE id=?")
        .run(template.name, template.exampleContent, template.exampleNotes, gateHash, new Date().toISOString(), existing.id);
    } else {
      this.database.prepare("INSERT INTO writing_examples(title,category,content,notes,gate_hash,updated_at) VALUES(?,?,?,?,?,?)")
        .run(`[风格模板] ${template.name}`, template.name, template.exampleContent, template.exampleNotes, gateHash, new Date().toISOString());
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

  private writeSimpleCharacters(cards: SavedRoleplayInterlocutor[]): void {
    const content = [...cards].sort((a, b) => a.id - b.id).map(card => JSON.stringify(card)).join("\n");
    this.project.writeSimpleCharacterCardsJsonl(content ? `${content}\n` : "");
  }

  private migrateSimpleCharacterCardsToJsonl(): void {
    const fileCards = this.roleplayInterlocutors();
    const legacyCards = this.database.prepare("SELECT * FROM roleplay_interlocutors ORDER BY id").all()
      .map(raw => this.roleplayInterlocutorFromRow(raw as Row));
    if (!legacyCards.length) return;

    const merged = new Map(fileCards.map(card => [card.id, card]));
    for (const legacy of legacyCards) {
      const current = merged.get(legacy.id);
      if (!current || legacy.updatedAt > current.updatedAt) merged.set(legacy.id, legacy);
    }
    this.writeSimpleCharacters([...merged.values()]);
    this.database.exec("DELETE FROM roleplay_interlocutors");
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
    const content = row.content as string;
    return {
      id: row.id as number, title: row.title as string, category: row.category as string,
      content, notes: row.notes as string,
      gatePassed: Boolean(row.gate_hash) && row.gate_hash === this.project.hash(content),
      updatedAt: row.updated_at as string,
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

  /** Batch-delete sessions; selecting every session replaces them with one new empty session. */
  deleteSessions(ids: string[], keepId?: string): { deleted: string[]; remainingSessionId: string; createdNewSession: boolean } {
    const unique = [...new Set(ids.filter((id) => this.sessionExists(id)))];
    if (unique.length === 0) throw new Error("没有可删除的会话");
    const all = this.listSessions();
    const deleteSet = new Set(unique);
    const deletesEverySession = all.every(session => deleteSet.has(session.id));
    // Create the replacement first, so the store never temporarily has zero sessions
    // and a partial deletion failure still leaves a usable destination.
    const replacementSessionId = deletesEverySession ? this.createSession() : undefined;
    for (const id of unique) {
      this.database.prepare("DELETE FROM sessions WHERE id=?").run(id);
    }
    const remaining = this.listSessions();
    const remainingSessionId = (keepId && remaining.some((s) => s.id === keepId))
      ? keepId
      : replacementSessionId ?? remaining[0]?.id;
    if (!remainingSessionId) throw new Error("删除后没有可用会话");
    return { deleted: unique, remainingSessionId, createdNewSession: Boolean(replacementSessionId) };
  }

  addMessage(
    sessionId: string,
    role: Message["role"],
    content: string,
    channel: MessageChannel = "agent",
    variantGroupId?: string,
    roleplayInputMode?: RoleplayInputMode,
    attachments?: MessageAttachment[],
  ): number {
    const now = new Date().toISOString();
    const normalized = channel === "roleplay" ? "roleplay" : "agent";
    const normalizedInputMode = normalized === "roleplay" && role === "user"
      && (roleplayInputMode === "director" || roleplayInputMode === "dialogue")
      ? roleplayInputMode
      : null;
    const attachmentsJson = attachments?.length ? JSON.stringify(attachments) : "[]";
    const result = this.database.prepare("INSERT INTO messages(session_id,role,content,created_at,channel,variant_group_id,roleplay_input_mode,attachments_json) VALUES(?,?,?,?,?,?,?,?)")
      .run(sessionId, role, content, now, normalized, variantGroupId ?? null, normalizedInputMode, attachmentsJson);
    this.database.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(now, sessionId);
    return Number(result.lastInsertRowid);
  }

  /**
   * Persist inbound base64 images under `.writer/attachments/<session>/`.
   * Validates mime, size and count; returns metadata ready for message + model content.
   */
  saveMessageAttachments(sessionId: string, inputs: MessageAttachmentInput[]): MessageAttachment[] {
    if (!inputs.length) return [];
    if (inputs.length > MULTIMODAL_MAX_ATTACHMENTS) {
      throw new Error(`单次最多附带 ${MULTIMODAL_MAX_ATTACHMENTS} 张图片`);
    }
    const attachments: MessageAttachment[] = [];
    for (const input of inputs) {
      const mimeType = normalizeImageMime(input.mimeType || "");
      if (!isSupportedImageMime(mimeType)) {
        throw new Error(`不支持的图片类型：${input.mimeType || "unknown"}（允许 jpeg/png/gif/webp）`);
      }
      const raw = input.dataBase64?.replace(/\s+/g, "") ?? "";
      if (!raw) throw new Error("图片数据为空");
      let bytes: Buffer;
      try {
        bytes = Buffer.from(raw, "base64");
      } catch {
        throw new Error("图片 base64 无效");
      }
      if (!bytes.length) throw new Error("图片数据为空");
      if (bytes.length > MULTIMODAL_MAX_BYTES) {
        throw new Error(`单张图片不能超过 ${Math.round(MULTIMODAL_MAX_BYTES / 1024 / 1024)}MB`);
      }
      const id = randomUUID();
      const ext = extensionForImageMime(mimeType);
      const storagePath = `attachments/${sessionId}/${id}.${ext}`;
      const absolute = resolve(this.project.privateDir, storagePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, bytes);
      const name = (input.name?.trim() || `image.${ext}`).slice(0, 120);
      attachments.push({ id, name, mimeType, size: bytes.length, storagePath });
    }
    return attachments;
  }

  /** Persist one trusted model output using the same private attachment layout as uploads. */
  saveGeneratedImageAttachment(
    sessionId: string,
    input: { name?: string; mimeType: string; bytes: Buffer; imageGeneration?: MessageAttachment["imageGeneration"] },
  ): MessageAttachment {
    const mimeType = normalizeImageMime(input.mimeType || "");
    if (!isSupportedImageMime(mimeType)) throw new Error(`生图模型返回了不支持的图片类型：${input.mimeType || "unknown"}`);
    if (!input.bytes.length) throw new Error("生图模型返回了空图片");
    const maxGeneratedBytes = 20 * 1024 * 1024;
    if (input.bytes.length > maxGeneratedBytes) throw new Error("生成图片超过 20MB，已拒绝保存");
    const id = randomUUID();
    const ext = extensionForImageMime(mimeType);
    const storagePath = `attachments/${sessionId}/${id}.${ext}`;
    const absolute = resolve(this.project.privateDir, storagePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, input.bytes);
    const name = (input.name?.trim() || `generated-image.${ext}`).slice(0, 120);
    return {
      id,
      name,
      mimeType,
      size: input.bytes.length,
      storagePath,
      ...(input.imageGeneration ? { imageGeneration: input.imageGeneration } : {}),
    };
  }

  resolveAttachmentBytes(sessionId: string, attachmentId: string): { mimeType: string; bytes: Buffer } | undefined {
    const row = this.database.prepare(
      `SELECT attachments_json FROM messages WHERE session_id=? AND attachments_json LIKE ? ORDER BY id DESC LIMIT 20`,
    ).all(sessionId, `%${attachmentId}%`) as Row[];
    for (const item of row) {
      const list = parseMessageAttachments(item.attachments_json);
      const match = list.find(entry => entry.id === attachmentId);
      if (!match) continue;
      const absolute = resolve(this.project.privateDir, match.storagePath);
      if (!existsSync(absolute)) return undefined;
      try {
        return { mimeType: match.mimeType, bytes: readFileSync(absolute) };
      } catch {
        return undefined;
      }
    }
    // Fallback: scan session attachment directory by id prefix (message may not be committed yet).
    const dir = resolve(this.project.privateDir, "attachments", sessionId);
    if (!existsSync(dir)) return undefined;
    try {
      const file = readdirSync(dir).find(name => name.startsWith(`${attachmentId}.`));
      if (!file) return undefined;
      const absolute = resolve(dir, file);
      const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
      const mimeType = ext === "png" ? "image/png"
        : ext === "gif" ? "image/gif"
          : ext === "webp" ? "image/webp"
            : "image/jpeg";
      return { mimeType, bytes: readFileSync(absolute) };
    } catch {
      return undefined;
    }
  }

  readAttachmentFile(storagePath: string): { mimeType: string; bytes: Buffer } | undefined {
    if (!storagePath.startsWith("attachments/") || storagePath.includes("..")) return undefined;
    const absolute = resolve(this.project.privateDir, storagePath);
    if (!existsSync(absolute)) return undefined;
    const ext = absolute.slice(absolute.lastIndexOf(".") + 1).toLowerCase();
    const mimeType = ext === "png" ? "image/png"
      : ext === "gif" ? "image/gif"
        : ext === "webp" ? "image/webp"
          : "image/jpeg";
    try {
      return { mimeType, bytes: readFileSync(absolute) };
    } catch {
      return undefined;
    }
  }

  /** Persist the model-safe projection of a raw roleplay user turn. */
  saveRoleplayPerception(sessionId: string, messageId: number, content: string): void {
    const result = this.database.prepare(`UPDATE messages SET roleplay_perception=?
      WHERE session_id=? AND id=? AND channel='roleplay' AND role='user'`)
      .run(content.trim().slice(0, 8_000), sessionId, messageId);
    if (!result.changes) throw new Error("角色扮演消息不存在");
  }

  roleplayPerception(sessionId: string, messageId: number): string | undefined {
    const row = this.database.prepare(`SELECT roleplay_perception FROM messages
      WHERE session_id=? AND id=? AND channel='roleplay' AND role='user'`)
      .get(sessionId, messageId) as Row | undefined;
    return typeof row?.roleplay_perception === "string" && row.roleplay_perception.trim()
      ? row.roleplay_perception
      : undefined;
  }

  /** Persist the exact user message sent to the roleplay model for prefix-cache replay. */
  saveRoleplayModelInput(sessionId: string, messageId: number, content: string): void {
    const result = this.database.prepare(`UPDATE messages SET roleplay_model_input=?
      WHERE session_id=? AND id=? AND channel='roleplay' AND role='user'`)
      .run(content, sessionId, messageId);
    if (!result.changes) throw new Error("角色扮演消息不存在");
  }

  roleplayModelInput(sessionId: string, messageId: number): string | undefined {
    const row = this.database.prepare(`SELECT roleplay_model_input FROM messages
      WHERE session_id=? AND id=? AND channel='roleplay' AND role='user'`)
      .get(sessionId, messageId) as Row | undefined;
    return typeof row?.roleplay_model_input === "string" && row.roleplay_model_input
      ? row.roleplay_model_input
      : undefined;
  }

  roleplayModelInputs(sessionId: string, messageIds: number[]): Map<number, string> {
    const ids = [...new Set(messageIds.filter(id => Number.isInteger(id) && id > 0))];
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.database.prepare(`SELECT id,roleplay_model_input FROM messages
      WHERE session_id=? AND channel='roleplay' AND role='user' AND id IN (${placeholders})`)
      .all(sessionId, ...ids) as Row[];
    return new Map(rows.flatMap(row =>
      typeof row.roleplay_model_input === "string" && row.roleplay_model_input
        ? [[Number(row.id), row.roleplay_model_input] as const]
        : [],
    ));
  }

  messages(sessionId: string, limit = 30, options?: { channel?: MessageChannel }): Message[] {
    const channel = options?.channel;
    const rows = channel
      ? this.database.prepare(`
          SELECT * FROM (SELECT id,session_id,role,content,created_at,channel,variant_group_id,roleplay_input_mode,attachments_json FROM messages
          WHERE session_id=? AND channel=? ORDER BY id DESC LIMIT ?) ORDER BY id ASC
        `).all(sessionId, channel, limit)
      : this.database.prepare(`
          SELECT * FROM (SELECT id,session_id,role,content,created_at,channel,variant_group_id,roleplay_input_mode,attachments_json FROM messages
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
      ? this.database.prepare(`SELECT id,session_id,role,content,created_at,channel,variant_group_id,roleplay_input_mode,attachments_json FROM messages
          WHERE session_id=? AND channel=? AND role IN ('user','assistant') AND id>?
          ORDER BY id ASC LIMIT ?`).all(sessionId, options.channel, afterId, limit)
      : this.database.prepare(`SELECT id,session_id,role,content,created_at,channel,variant_group_id,roleplay_input_mode,attachments_json FROM messages
          WHERE session_id=? AND role IN ('user','assistant') AND id>?
          ORDER BY id ASC LIMIT ?`).all(sessionId, afterId, limit);
    return rows.map((row) => this.messageFromRow(row as Row));
  }

  /** Read the page immediately before `beforeId`; omit it to get the newest page. */
  conversationMessagesBefore(sessionId: string, beforeId?: number, limit = 50): Message[] {
    const normalizedLimit = Math.max(1, Math.min(100, Math.round(limit)));
    const rows = beforeId !== undefined && Number.isInteger(beforeId) && beforeId > 0
      ? this.database.prepare(`SELECT * FROM (SELECT id,session_id,role,content,created_at,channel,variant_group_id,roleplay_input_mode,attachments_json FROM messages
          WHERE session_id=? AND role IN ('user','assistant') AND id<? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`)
          .all(sessionId, beforeId, normalizedLimit)
      : this.database.prepare(`SELECT * FROM (SELECT id,session_id,role,content,created_at,channel,variant_group_id,roleplay_input_mode,attachments_json FROM messages
          WHERE session_id=? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?) ORDER BY id ASC`)
          .all(sessionId, normalizedLimit);
    return rows.map((row) => this.messageFromRow(row as Row));
  }

  createAgentEvaluationRun(providerSource: string, model: string): AgentEvaluationRun {
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE agent_evaluation_runs
      SET status='error',summary_json=?,completed_at=? WHERE status='running'`)
      .run(JSON.stringify({ error: "evaluation process interrupted before completion" }), now);
    const run: AgentEvaluationRun = {
      id: randomUUID(),
      providerSource,
      model,
      status: "running",
      summary: {},
      createdAt: now,
    };
    this.database.prepare(`INSERT INTO agent_evaluation_runs(id,provider_source,model,status,summary_json,created_at)
      VALUES(?,?,?,?,?,?)`).run(run.id, run.providerSource, run.model, run.status, "{}", run.createdAt);
    return run;
  }

  recordAgentEvaluationCase(input: {
    runId: string;
    caseId: string;
    sessionId: string;
    prompt: string;
    status: Exclude<AgentEvaluationStatus, "running">;
    expected: Record<string, unknown>;
    result: Record<string, unknown>;
    events: import("./types.js").AgentEvent[];
  }): AgentEvaluationCaseResult {
    const createdAt = new Date().toISOString();
    const row = this.database.prepare(`INSERT INTO agent_evaluation_cases(run_id,case_id,session_id,prompt,status,expected_json,result_json,events_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?) RETURNING id`).get(
      input.runId, input.caseId, input.sessionId, input.prompt, input.status,
      JSON.stringify(input.expected), JSON.stringify(input.result), JSON.stringify(input.events), createdAt,
    ) as Row;
    return { id: Number(row.id), ...input, createdAt };
  }

  finishAgentEvaluationRun(
    id: string,
    status: Exclude<AgentEvaluationStatus, "running">,
    summary: Record<string, unknown>,
  ): AgentEvaluationRun {
    const completedAt = new Date().toISOString();
    this.database.prepare("UPDATE agent_evaluation_runs SET status=?,summary_json=?,completed_at=? WHERE id=?")
      .run(status, JSON.stringify(summary), completedAt, id);
    const run = this.agentEvaluationRun(id);
    if (!run) throw new Error("Agent evaluation run 不存在");
    return run;
  }

  agentEvaluationRun(id: string): AgentEvaluationRun | undefined {
    const row = this.database.prepare("SELECT * FROM agent_evaluation_runs WHERE id=?").get(id) as Row | undefined;
    if (!row) return undefined;
    const cases = this.database.prepare("SELECT * FROM agent_evaluation_cases WHERE run_id=? ORDER BY id")
      .all(id).map(value => this.agentEvaluationCaseFromRow(value as Row));
    return this.agentEvaluationRunFromRow(row, cases);
  }

  listAgentEvaluationRuns(limit = 20): AgentEvaluationRun[] {
    const bounded = Math.max(1, Math.min(100, Math.round(limit)));
    return this.database.prepare("SELECT * FROM agent_evaluation_runs ORDER BY created_at DESC LIMIT ?")
      .all(bounded).map(value => this.agentEvaluationRunFromRow(value as Row));
  }

  recordUsage(sessionId: string, model: string, usage: {
    promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number;
  }, pricing: TokenPricing, at: Date = new Date(), meta: { jobId?: string; callKind?: string; step?: number; providerName?: string; requestComponents?: import("./types.js").RequestComponentUsage[] } = {}): UsageSummary {
    const miss = usage.cacheMissTokens || Math.max(0, usage.promptTokens - usage.cacheHitTokens);
    const cost = calculateUsageCost({ ...usage, cacheMissTokens: miss }, pricing, at);
    this.database.prepare(`INSERT INTO model_usage(session_id,model,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,cost,currency,created_at,job_id,call_kind,step,request_components_json,provider_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sessionId, model, usage.promptTokens, usage.completionTokens, usage.cacheHitTokens, miss, cost, pricing.currency, at.toISOString(), meta.jobId ?? null, meta.callKind ?? "unspecified", meta.step ?? null, JSON.stringify(meta.requestComponents ?? []), meta.providerName?.trim() ?? "");
    return this.usage(sessionId);
  }

  usage(sessionId: string): UsageSummary {
    const row = this.database.prepare(`SELECT
      COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens,
      COALESCE(SUM(cache_hit_tokens),0) cache_hit_tokens, COALESCE(SUM(cache_miss_tokens),0) cache_miss_tokens,
      COALESCE(SUM(cost),0) cost, COALESCE(MAX(currency),'CNY') currency,
      COALESCE((SELECT prompt_tokens FROM model_usage WHERE session_id=?
        AND call_kind IN ('unspecified','agent_step','roleplay_reply','writing_generation','draft_generation','character_generation','character_tool_loop')
        ORDER BY id DESC LIMIT 1),0) last_prompt_tokens
      FROM model_usage WHERE session_id=?`).get(sessionId, sessionId) as Row;
    const promptTokens = Number(row.prompt_tokens);
    const completionTokens = Number(row.completion_tokens);
    const cacheHitTokens = Number(row.cache_hit_tokens);
    const cacheMissTokens = Number(row.cache_miss_tokens);
    const measuredInput = cacheHitTokens + cacheMissTokens;
    const callBreakdown = (this.database.prepare(`SELECT
      provider_name, model, COUNT(*) call_count,
      COALESCE(SUM(prompt_tokens),0) prompt_tokens,
      COALESCE(SUM(completion_tokens),0) completion_tokens,
      COALESCE(SUM(cache_hit_tokens),0) cache_hit_tokens,
      COALESCE(SUM(cache_miss_tokens),0) cache_miss_tokens,
      COALESCE(SUM(cost),0) cost, COALESCE(MAX(currency),'CNY') currency,
      MAX(id) recent_id
      FROM model_usage WHERE session_id=?
      GROUP BY provider_name,model,currency ORDER BY recent_id DESC`).all(sessionId) as Row[]).map(item => ({
        providerName: String(item.provider_name || "未记录"),
        model: String(item.model),
        callCount: Number(item.call_count),
        promptTokens: Number(item.prompt_tokens),
        completionTokens: Number(item.completion_tokens),
        cacheHitTokens: Number(item.cache_hit_tokens),
        cacheMissTokens: Number(item.cache_miss_tokens),
        cost: Number(item.cost),
        currency: String(item.currency),
      }));
    return {
      promptTokens, completionTokens, cacheHitTokens,
      cacheMissTokens, totalTokens: promptTokens + completionTokens,
      cost: Number(row.cost), currency: String(row.currency), lastPromptTokens: Number(row.last_prompt_tokens),
      cacheHitRate: measuredInput > 0 ? cacheHitTokens / measuredInput : 0,
      callBreakdown,
    };
  }

  private agentEvaluationRunFromRow(row: Row, cases?: AgentEvaluationCaseResult[]): AgentEvaluationRun {
    let summary: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(row.summary_json ?? "{}")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) summary = parsed as Record<string, unknown>;
    } catch { /* malformed historical summaries degrade to an empty object */ }
    return {
      id: String(row.id),
      providerSource: String(row.provider_source),
      model: String(row.model),
      status: row.status as AgentEvaluationStatus,
      summary,
      createdAt: String(row.created_at),
      ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
      ...(cases ? { cases } : {}),
    };
  }

  private agentEvaluationCaseFromRow(row: Row): AgentEvaluationCaseResult {
    const parseObject = (value: unknown): Record<string, unknown> => {
      try {
        const parsed = JSON.parse(String(value ?? "{}")) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      } catch { return {}; }
    };
    let events: import("./types.js").AgentEvent[] = [];
    try {
      const parsed = JSON.parse(String(row.events_json ?? "[]")) as unknown;
      if (Array.isArray(parsed)) events = parsed as import("./types.js").AgentEvent[];
    } catch { /* malformed historical event payloads degrade to [] */ }
    return {
      id: Number(row.id),
      runId: String(row.run_id),
      caseId: String(row.case_id),
      sessionId: String(row.session_id),
      prompt: String(row.prompt),
      status: row.status as AgentEvaluationCaseResult["status"],
      expected: parseObject(row.expected_json),
      result: parseObject(row.result_json),
      events,
      createdAt: String(row.created_at),
    };
  }

  private messageFromRow(row: Row): Message {
    const attachments = parseMessageAttachments(row.attachments_json);
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      role: row.role as Message["role"],
      content: row.content as string,
      createdAt: row.created_at as string,
      channel: row.channel === "roleplay" ? "roleplay" : "agent",
      ...(row.roleplay_input_mode === "director" || row.roleplay_input_mode === "dialogue"
        ? { roleplayInputMode: row.roleplay_input_mode }
        : {}),
      ...(typeof row.variant_group_id === "string" ? { variantGroupId: row.variant_group_id } : {}),
      ...(attachments.length ? { attachments } : {}),
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

  createChangeSet(
    sessionId: string,
    summary: string,
    fileInputs: Array<{
      operation: ChangeSetFileOperation;
      path: string;
      targetPath?: string;
      content?: string;
      edits?: Array<{ search: string; replace: string }>;
    }>,
    characterChanges: ProposalCharacterChange[] = [],
    sourceMessageId?: number,
  ): ChangeSet {
    if (!fileInputs.length && !characterChanges.length) throw new Error("change set 至少需要一个文件或角色变化");
    if (fileInputs.length > 20) throw new Error("单个 change set 最多包含 20 个文件操作");
    const touched = new Set<string>();
    const files = fileInputs.map((input, index) => {
      const operation = input.operation;
      if (!["write", "patch", "move", "delete"].includes(operation)) {
        throw new Error(`第 ${index + 1} 个文件操作无效`);
      }
      const path = canonicalTextPath(input.path);
      this.project.resolveTextFileSafe(path);
      if (this.project.isDocumentHidden(path)) throw new Error(`文件已对 Agent 屏蔽：${path}`);
      const exists = this.project.textFileExists(path);
      const beforeContent = exists ? this.project.readTextFile(path) : "";
      const baseHash = exists ? this.project.hash(beforeContent) : "__missing__";
      const targetPath = operation === "move" ? canonicalTextPath(input.targetPath ?? "") : undefined;
      if (targetPath) {
        this.project.resolveTextFileSafe(targetPath);
        if (this.project.isDocumentHidden(targetPath)) throw new Error(`目标文件已对 Agent 屏蔽：${targetPath}`);
      }
      for (const candidate of [path, targetPath].filter((item): item is string => Boolean(item))) {
        if (touched.has(candidate)) throw new Error(`同一 change set 不能重复触碰路径：${candidate}`);
        touched.add(candidate);
      }

      if ((operation === "patch" || operation === "move" || operation === "delete") && !exists) {
        throw new Error(`${operation} 的源文件不存在：${path}`);
      }
      if (operation === "move" && targetPath && this.project.textFileExists(targetPath)) {
        throw new Error(`移动目标已存在：${targetPath}`);
      }
      let afterContent = beforeContent;
      if (operation === "write") {
        if (typeof input.content !== "string") throw new Error(`write 缺少 content：${path}`);
        afterContent = input.content;
      } else if (operation === "patch") {
        const edits = input.edits ?? [];
        if (!edits.length || edits.length > 20) throw new Error(`patch 需要 1 至 20 条 edits：${path}`);
        for (const [editIndex, edit] of edits.entries()) {
          if (!edit.search || typeof edit.replace !== "string") throw new Error(`patch edit ${editIndex + 1} 无效：${path}`);
          const occurrences = textOccurrences(afterContent, edit.search);
          if (occurrences !== 1) throw new Error(`patch edit ${editIndex + 1} 的 search 出现 ${occurrences} 次，必须唯一：${path}`);
          afterContent = afterContent.replace(edit.search, edit.replace);
        }
      }
      if (afterContent.includes("\0")) throw new Error(`纯文本内容不能包含 NUL 字节：${path}`);
      return {
        operation, path, targetPath, beforeContent, afterContent, baseHash,
        ...(targetPath ? { targetBaseHash: "__missing__" } : {}),
      };
    });
    this.evolveCharactersForProposal(characterChanges);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        INSERT INTO change_sets(session_id,source_message_id,summary,character_changes_json,before_config,status,created_at)
        VALUES(?,?,?,?,?,'pending',?)
      `).run(sessionId, sourceMessageId ?? null, summary, JSON.stringify(characterChanges), this.project.readRaw("writer.yaml"), now);
      const changeSetId = Number(result.lastInsertRowid);
      const insert = this.database.prepare(`
        INSERT INTO change_set_files(change_set_id,operation,path,target_path,before_content,after_content,base_hash,target_base_hash)
        VALUES(?,?,?,?,?,?,?,?)
      `);
      for (const file of files) insert.run(
        changeSetId, file.operation, file.path, file.targetPath ?? null, file.beforeContent,
        file.afterContent, file.baseHash, file.targetBaseHash ?? null,
      );
      this.database.exec("COMMIT");
      return this.changeSet(changeSetId);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  changeSet(id: number): ChangeSet {
    const row = this.database.prepare("SELECT * FROM change_sets WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error(`change set 不存在：${id}`);
    return this.changeSetFromRow(row);
  }

  changeSets(limit = 100): ChangeSet[] {
    return this.database.prepare("SELECT * FROM change_sets ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(200, limit)))
      .map(row => this.changeSetFromRow(row as Row));
  }

  changeSetsForSession(sessionId: string): ChangeSet[] {
    return (this.database.prepare("SELECT * FROM change_sets WHERE session_id=? ORDER BY id").all(sessionId) as Row[])
      .map(row => this.changeSetFromRow(row));
  }

  private changeSetFromRow(row: Row): ChangeSet {
    const files = this.database.prepare("SELECT * FROM change_set_files WHERE change_set_id=? ORDER BY id").all(Number(row.id))
      .map(raw => {
        const file = raw as Row;
        return {
          id: Number(file.id),
          operation: String(file.operation) as ChangeSetFileOperation,
          path: String(file.path),
          ...(typeof file.target_path === "string" ? { targetPath: file.target_path } : {}),
          beforeContent: String(file.before_content),
          afterContent: String(file.after_content),
          baseHash: String(file.base_hash),
          ...(typeof file.target_base_hash === "string" ? { targetBaseHash: file.target_base_hash } : {}),
        } satisfies ChangeSetFileChange;
      });
    return {
      id: Number(row.id), sessionId: String(row.session_id),
      ...(typeof row.source_message_id === "number" ? { sourceMessageId: row.source_message_id } : {}),
      summary: String(row.summary),
      status: String(row.status) as ChangeSet["status"], undone: Number(row.undone) === 1,
      createdAt: String(row.created_at), files,
      characterChanges: parseProposalCharacterChanges(row.character_changes_json),
    };
  }

  acceptChangeSet(id: number): ChangeSet {
    const changeSet = this.changeSet(id);
    if (changeSet.status === "accepted") return changeSet;
    if (changeSet.status !== "pending") throw new Error("该 change set 已处理");
    let application = this.database.prepare("SELECT * FROM change_set_applications WHERE change_set_id=?").get(id) as Row | undefined;
    if (!application) {
      try { this.assertChangeSetForwardState(changeSet); }
      catch (error) {
        this.database.prepare("UPDATE change_sets SET status='stale' WHERE id=?").run(id);
        throw error;
      }
      const evolved = this.evolveCharactersForProposal(changeSet.characterChanges);
      const preparedAt = new Date().toISOString();
      this.database.prepare(`INSERT INTO change_set_applications(
        change_set_id,status,character_revisions_json,created_at,updated_at
      ) VALUES(?,'prepared',?,?,?)`).run(id, JSON.stringify(evolved.revisions), preparedAt, preparedAt);
      application = this.database.prepare("SELECT * FROM change_set_applications WHERE change_set_id=?").get(id) as Row;
    }
    let filesAlreadyApplied = false;
    try {
      this.assertChangeSetForwardState(changeSet);
    } catch {
      try {
        this.assertChangeSetAppliedState(changeSet);
        filesAlreadyApplied = true;
      } catch (error) {
        this.database.prepare("UPDATE change_sets SET status='stale' WHERE id=?").run(id);
        throw error;
      }
    }
    const characterRevisions = parseProposalCharacterRevisions(application.character_revisions_json);
    const snapshots = this.captureManagedFiles(changeSet.files);
    const originalCharacters = this.characters();
    const originalConfig = this.project.readRaw("writer.yaml");
    const outlineSnapshot = this.captureOutlineSnapshot();
    try {
      if (!filesAlreadyApplied) this.applyChangeSetFiles(changeSet.files);
      {
        let characters = this.characters();
        for (const revision of characterRevisions) {
          const current = characters.find(item => item.id === revision.characterId);
          const before = this.normalizeCharacter(revision.before);
          const after = this.normalizeCharacter(revision.after);
          if (!current || (JSON.stringify(current) !== JSON.stringify(before)
            && JSON.stringify(current) !== JSON.stringify(after))) {
            throw new Error(`角色卡 ${revision.characterId} 已在 change set 应用过程中发生冲突`);
          }
          characters = [...characters.filter(item => item.id !== revision.characterId), after];
        }
        validateCharacters(characters, this.outlineNodeIds());
        if (characterRevisions.length) this.writeCharacters(characters);
      }
      this.database.exec("BEGIN IMMEDIATE");
      this.database.prepare("UPDATE change_sets SET status='accepted',undone=0,character_revisions_json=?,after_config=? WHERE id=?")
        .run(String(application.character_revisions_json ?? "[]"), this.project.readRaw("writer.yaml"), id);
      this.database.prepare("UPDATE change_set_applications SET status='committed',updated_at=? WHERE change_set_id=?")
        .run(new Date().toISOString(), id);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      this.restoreManagedFiles(snapshots);
      this.project.writeRaw("writer.yaml", originalConfig);
      this.restoreOutlineSnapshot(outlineSnapshot);
      if (characterRevisions.length) this.writeCharacters(originalCharacters);
      throw error;
    }
    this.refreshWritingMemoryForChangeSet(changeSet.files, true);
    this.reindex();
    return this.changeSet(id);
  }

  undoChangeSet(id: number): ChangeSet {
    const changeSet = this.changeSet(id);
    if (changeSet.status !== "accepted" || changeSet.undone) throw new Error("该 change set 当前不可回滚");
    this.assertChangeSetAppliedState(changeSet);
    const row = this.database.prepare("SELECT character_revisions_json,before_config FROM change_sets WHERE id=?").get(id) as Row;
    const characterRevisions = parseProposalCharacterRevisions(row.character_revisions_json);
    const restoredCharacters = this.reverseCharacterRevisions(characterRevisions, "after");
    const snapshots = this.captureManagedFiles(changeSet.files);
    const originalCharacters = this.characters();
    const originalConfig = this.project.readRaw("writer.yaml");
    const outlineSnapshot = this.captureOutlineSnapshot();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.restoreChangeSetFiles(changeSet.files);
      this.project.writeRaw("writer.yaml", String(row.before_config));
      validateCharacters(restoredCharacters, this.outlineNodeIds());
      if (characterRevisions.length) this.writeCharacters(restoredCharacters);
      this.database.prepare("UPDATE change_sets SET undone=1 WHERE id=?").run(id);
      this.refreshWritingMemoryForChangeSet(changeSet.files, false);
      this.reindex();
      this.database.exec("COMMIT");
      return this.changeSet(id);
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      this.restoreManagedFiles(snapshots);
      this.project.writeRaw("writer.yaml", originalConfig);
      this.restoreOutlineSnapshot(outlineSnapshot);
      if (characterRevisions.length) this.writeCharacters(originalCharacters);
      throw error;
    }
  }

  redoChangeSet(id: number): ChangeSet {
    const changeSet = this.changeSet(id);
    if (changeSet.status !== "accepted" || !changeSet.undone) throw new Error("该 change set 当前不可重做");
    this.assertChangeSetForwardState(changeSet);
    const row = this.database.prepare("SELECT character_revisions_json,after_config FROM change_sets WHERE id=?").get(id) as Row;
    const characterRevisions = parseProposalCharacterRevisions(row.character_revisions_json);
    const restoredCharacters = this.reverseCharacterRevisions(characterRevisions, "before");
    const snapshots = this.captureManagedFiles(changeSet.files);
    const originalCharacters = this.characters();
    const originalConfig = this.project.readRaw("writer.yaml");
    const outlineSnapshot = this.captureOutlineSnapshot();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.applyChangeSetFiles(changeSet.files);
      this.project.writeRaw("writer.yaml", String(row.after_config));
      validateCharacters(restoredCharacters, this.outlineNodeIds());
      if (characterRevisions.length) this.writeCharacters(restoredCharacters);
      this.database.prepare("UPDATE change_sets SET undone=0 WHERE id=?").run(id);
      this.refreshWritingMemoryForChangeSet(changeSet.files, true);
      this.reindex();
      this.database.exec("COMMIT");
      return this.changeSet(id);
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      this.restoreManagedFiles(snapshots);
      this.project.writeRaw("writer.yaml", originalConfig);
      this.restoreOutlineSnapshot(outlineSnapshot);
      if (characterRevisions.length) this.writeCharacters(originalCharacters);
      throw error;
    }
  }

  rejectChangeSet(id: number): ChangeSet {
    const changeSet = this.changeSet(id);
    if (changeSet.status !== "pending") throw new Error("该 change set 已处理");
    this.database.prepare("UPDATE change_sets SET status='rejected' WHERE id=?").run(id);
    return this.changeSet(id);
  }

  private assertChangeSetForwardState(changeSet: ChangeSet): void {
    for (const file of changeSet.files) {
      const exists = this.project.textFileExists(file.path);
      const hash = exists ? this.project.hash(this.project.readTextFile(file.path)) : "__missing__";
      if (hash !== file.baseHash) throw new Error(`文件已变化，change set 已过期：${file.path}`);
      if (file.targetPath && this.project.textFileExists(file.targetPath)) throw new Error(`移动目标已出现，change set 已过期：${file.targetPath}`);
    }
  }

  private assertChangeSetAppliedState(changeSet: ChangeSet): void {
    for (const file of changeSet.files) {
      if (file.operation === "delete") {
        if (this.project.textFileExists(file.path)) throw new Error(`已删除文件重新出现，无法安全回滚：${file.path}`);
      } else if (file.operation === "move") {
        if (this.project.textFileExists(file.path) || !file.targetPath || !this.project.textFileExists(file.targetPath)
          || this.project.hash(this.project.readTextFile(file.targetPath)) !== this.project.hash(file.afterContent)) {
          throw new Error(`移动结果已变化，无法安全回滚：${file.path}`);
        }
      } else if (!this.project.textFileExists(file.path)
        || this.project.hash(this.project.readTextFile(file.path)) !== this.project.hash(file.afterContent)) {
        throw new Error(`文件已在审批后变化，无法安全回滚：${file.path}`);
      }
    }
  }

  private reverseCharacterRevisions(revisions: ProposalCharacterRevision[], expectedSide: "before" | "after"): Character[] {
    let characters = this.characters();
    for (const revision of revisions) {
      const expected = this.normalizeCharacter(revision[expectedSide]);
      const current = characters.find(item => item.id === revision.characterId);
      if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new Error(`角色卡 ${revision.characterId} 已变化，无法安全${expectedSide === "after" ? "回滚" : "重做"}`);
      }
      const replacement = this.normalizeCharacter(revision[expectedSide === "after" ? "before" : "after"]);
      characters = [...characters.filter(item => item.id !== revision.characterId), replacement];
    }
    return characters;
  }

  private captureManagedFiles(files: ChangeSetFileChange[]): Map<string, string | undefined> {
    const snapshots = new Map<string, string | undefined>();
    for (const path of files.flatMap(file => [file.path, file.targetPath].filter((item): item is string => Boolean(item)))) {
      if (!snapshots.has(path)) snapshots.set(path, this.project.textFileExists(path) ? this.project.readTextFile(path) : undefined);
    }
    return snapshots;
  }

  private restoreManagedFiles(snapshots: Map<string, string | undefined>): void {
    for (const path of snapshots.keys()) if (this.project.textFileExists(path)) this.removeManagedTextFile(path);
    for (const [path, content] of snapshots) if (content !== undefined) this.writeManagedTextFile(path, content);
  }

  private captureOutlineSnapshot(): string | undefined {
    const path = resolve(this.project.privateDir, "outline.json");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  private restoreOutlineSnapshot(content: string | undefined): void {
    const path = resolve(this.project.privateDir, "outline.json");
    if (content === undefined) {
      if (existsSync(path)) unlinkSync(path);
    } else writeFileSync(path, content, "utf8");
  }

  private applyChangeSetFiles(files: ChangeSetFileChange[]): void {
    for (const file of files) {
      if (file.operation === "delete") this.removeManagedTextFile(file.path);
      else if (file.operation === "move" && file.targetPath) {
        this.removeManagedTextFile(file.path);
        this.writeManagedTextFile(file.targetPath, file.afterContent);
      } else this.writeManagedTextFile(file.path, file.afterContent);
    }
  }

  private refreshWritingMemoryForChangeSet(files: ChangeSetFileChange[], applied: boolean): void {
    for (const file of files) {
      if (file.operation === "move" && file.targetPath) {
        if (applied) this.moveWritingMemorySource(file.path, file.targetPath, file.afterContent);
        else this.moveWritingMemorySource(file.targetPath, file.path, file.beforeContent);
        continue;
      }
      this.refreshWritingMemoryForDocument(
        file.path,
        applied ? file.operation === "delete" ? "" : file.afterContent : file.beforeContent,
      );
    }
  }

  private restoreChangeSetFiles(files: ChangeSetFileChange[]): void {
    for (const file of [...files].reverse()) {
      if (file.operation === "move" && file.targetPath && this.project.textFileExists(file.targetPath)) {
        this.removeManagedTextFile(file.targetPath);
      }
      if (file.baseHash === "__missing__") {
        if (this.project.textFileExists(file.path)) this.removeManagedTextFile(file.path);
      } else this.writeManagedTextFile(file.path, file.beforeContent);
    }
  }

    private writeManagedTextFile(path: string, content: string): void {
      if (path.toLowerCase().endsWith(".md")) {
        this.project.writeRaw(path, content);
      } else this.project.writeTextFile(path, content);
  }

  private removeManagedTextFile(path: string): void {
    if (path.toLowerCase().endsWith(".md")) this.project.removeDocument(path);
    else this.project.removeTextFile(path);
  }

  createProposal(
    sessionId: string,
    path: string,
    content: string,
    summary: string,
    characterChanges: ProposalCharacterChange[] = [],
    qualityReport?: ProseQualityReport,
    sourceMessageId?: number,
    deliveryReady = true,
    expectedBaseHash?: string,
  ): Proposal {
    const exists = this.project.documentExists(path);
    let before: string;
    try {
      before = exists ? this.project.read(path) : "";
    } catch (error) {
      if (expectedBaseHash !== undefined) throw new ProposalDocumentBaseChangedError(path);
      throw error;
    }
    const baseHash = exists ? this.project.hash(before) : "__missing__";
    if (expectedBaseHash !== undefined && baseHash !== expectedBaseHash) {
      throw new ProposalDocumentBaseChangedError(path);
    }
    this.evolveCharactersForProposal(characterChanges);
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      INSERT INTO proposals(session_id,source_message_id,delivery_ready,path,summary,before_content,after_content,base_hash,character_changes_json,quality_report_json,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)
    `).run(sessionId, sourceMessageId ?? null, deliveryReady ? 1 : 0, path, summary, before, content, baseHash, JSON.stringify(characterChanges), qualityReport ? JSON.stringify(qualityReport) : "", now);
    return this.proposal(Number(result.lastInsertRowid));
  }

  private evolveCharactersForProposal(
    changes: ProposalCharacterChange[],
  ): { characters: Character[]; revisions: ProposalCharacterRevision[] } {
    let characters = this.characters();
    const revisions: ProposalCharacterRevision[] = [];
    for (const change of changes) {
      const before = characters.find(item => item.id === change.characterId);
      if (!before) throw new Error(`延迟角色演进失败：角色 ${change.characterId} 不存在`);
      const result = applyCharacterChangesCore(before, {
        reason: change.reason,
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

  proposalsForSession(sessionId: string): Proposal[] {
    const rows = this.database.prepare("SELECT * FROM proposals WHERE session_id=? ORDER BY id").all(sessionId) as Row[];
    return rows.map(row => this.proposalFromRow(row));
  }

  private proposalFromRow(row: Row): Proposal {
    const qualityReport = parseProposalQualityReport(row.quality_report_json);
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      ...(typeof row.source_message_id === "number" ? { sourceMessageId: row.source_message_id } : {}),
      deliveryReady: Number(row.delivery_ready) !== 0,
      path: row.path as string,
      summary: row.summary as string,
      beforeContent: row.before_content as string,
      afterContent: row.after_content as string,
      baseHash: row.base_hash as string,
      status: row.status as Proposal["status"],
      createdAt: row.created_at as string,
      characterChanges: parseProposalCharacterChanges(row.character_changes_json),
      ...(qualityReport ? { qualityReport } : {}),
    };
  }

  acceptProposal(id: number): Proposal {
    const proposal = this.proposal(id);
    if (!proposal.deliveryReady) {
      throw new Error("该提案仍是门禁修订中的中间草稿，尚未达到可交付状态，不能接受");
    }
    if (proposal.status === "accepted") return proposal;
    if (proposal.status !== "pending") throw new Error("该提案已处理");
    const expectedAfterHash = this.project.hash(proposal.afterContent);
    let application = this.database.prepare("SELECT * FROM proposal_applications WHERE proposal_id=?").get(id) as Row | undefined;
    if (!application) {
      const intendedCreate = proposal.baseHash === "__missing__";
      const exists = this.project.documentExists(proposal.path);
      const current = exists ? this.project.read(proposal.path) : "";
      const unchanged = intendedCreate
        ? !exists
        : exists && this.project.hash(current) === proposal.baseHash;
      if (!unchanged) {
        this.database.prepare("UPDATE proposals SET status='stale' WHERE id=?").run(id);
        throw new Error("文档已被修改，提案已过期，未覆盖当前内容");
      }
      const evolved = this.evolveCharactersForProposal(proposal.characterChanges);
      const preparedAt = new Date().toISOString();
      this.database.prepare(`INSERT INTO proposal_applications(
        proposal_id,status,before_content,after_hash,created_file,character_revisions_json,created_at,updated_at
      ) VALUES(?,'prepared',?,?,?,?,?,?)`).run(
        id, current, expectedAfterHash, intendedCreate ? 1 : 0,
        JSON.stringify(evolved.revisions), preparedAt, preparedAt,
      );
      application = this.database.prepare("SELECT * FROM proposal_applications WHERE proposal_id=?").get(id) as Row;
    }

    const exists = this.project.documentExists(proposal.path);
    const current = exists ? this.project.read(proposal.path) : "";
    const currentHash = exists ? this.project.hash(current) : "__missing__";
    const beforeContent = String(application.before_content ?? "");
    const beforeHash = proposal.baseHash === "__missing__" ? "__missing__" : this.project.hash(beforeContent);
    if (currentHash !== expectedAfterHash && currentHash !== beforeHash) {
      this.database.prepare("UPDATE proposals SET status='stale' WHERE id=?").run(id);
      throw new Error("文档已在提案应用过程中发生冲突，未覆盖当前内容");
    }
    if (currentHash !== expectedAfterHash) this.project.writeRaw(proposal.path, proposal.afterContent);

    const characterRevisions = parseProposalCharacterRevisions(application.character_revisions_json);
    if (characterRevisions.length) {
      let characters = this.characters();
      for (const revision of characterRevisions) {
        const currentCharacter = characters.find(item => item.id === revision.characterId);
        const before = this.normalizeCharacter(revision.before);
        const after = this.normalizeCharacter(revision.after);
        if (!currentCharacter || (JSON.stringify(currentCharacter) !== JSON.stringify(before)
          && JSON.stringify(currentCharacter) !== JSON.stringify(after))) {
          throw new Error(`角色卡 ${revision.characterId} 已在提案应用过程中发生冲突`);
        }
        characters = [...characters.filter(item => item.id !== revision.characterId), after];
      }
      validateCharacters(characters, this.outlineNodeIds());
      this.writeCharacters(characters);
    }

    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existingRevision = this.database.prepare("SELECT 1 AS ok FROM revisions WHERE proposal_id=?").get(id);
      if (!existingRevision) {
        this.database.prepare(`
          INSERT INTO revisions(proposal_id,path,before_content,after_content,after_hash,created_file,character_revisions_json,quality_report_json,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)
        `).run(
          id, proposal.path, beforeContent, proposal.afterContent, expectedAfterHash, Number(application.created_file) ? 1 : 0,
          String(application.character_revisions_json ?? "[]"), proposal.qualityReport ? JSON.stringify(proposal.qualityReport) : "", now,
        );
      }
      this.database.prepare("UPDATE proposals SET status='accepted' WHERE id=?").run(id);
      this.database.prepare("UPDATE proposal_applications SET status='committed',updated_at=? WHERE proposal_id=?").run(now, id);
      this.database.exec("COMMIT");
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
    this.refreshWritingMemoryForDocument(proposal.path, proposal.afterContent);
    this.reindex();
    return this.proposal(id);
  }

  rejectProposal(id: number): Proposal {
    const proposal = this.proposal(id);
    if (proposal.status === "rejected") return proposal;
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
    this.refreshWritingMemoryForDocument(path, row.created_file === 1 ? "" : String(row.before_content));
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
    if (characterRevisions.length) this.writeCharacters(restoredCharacters);
    this.database.prepare("UPDATE revisions SET undone=0 WHERE id=?").run(row.id as number);
    this.refreshWritingMemoryForDocument(path, String(row.after_content));
    this.reindex();
    if (sessionId) this.addSystemMessage(sessionId, `已重做文档修改：${path}`);
    return path;
  }

  private rewindProposalRevision(row: Row): { path: string; characterNames: string[] } {
    const path = String(row.path);
    const current = this.project.documentExists(path) ? this.project.read(path) : "";
    if (this.project.hash(current) !== String(row.after_hash)) {
      throw new Error(`文档已在提案通过后发生变化，无法安全回退：${path}`);
    }
    const revisions = parseProposalCharacterRevisions(row.character_revisions_json);
    const restoredCharacters = this.reverseCharacterRevisions(revisions, "after");
    if (Number(row.created_file) === 1) this.project.removeDocument(path);
    else this.project.writeRaw(path, String(row.before_content));
    if (revisions.length) this.writeCharacters(restoredCharacters);
    this.database.prepare("UPDATE revisions SET undone=1 WHERE id=?").run(Number(row.id));
    this.refreshWritingMemoryForDocument(path, Number(row.created_file) === 1 ? "" : String(row.before_content));
    return {
      path,
      characterNames: revisions.map(revision => this.normalizeCharacter(revision.after).identity.name),
    };
  }

  private rewindCharacterRevision(row: Row): string {
    const after = this.normalizeCharacter(JSON.parse(String(row.after_content)) as Character);
    const characters = this.characters();
    const current = characters.find(item => item.id === after.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(after)) {
      throw new Error(`角色卡 ${after.id} 已在修改后发生变化，无法安全回退`);
    }
    const restored = characters.filter(item => item.id !== after.id);
    if (typeof row.before_content === "string") {
      restored.push(this.normalizeCharacter(JSON.parse(row.before_content) as Character));
    }
    this.writeCharacters(restored);
    this.database.prepare("UPDATE character_revisions SET undone=1 WHERE id=?").run(Number(row.id));
    return after.identity.name;
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
      const actions: Array<{ kind: "change_set" | "proposal" | "character"; createdAt: string; row: Row }> = [
        ...(this.database.prepare(
          "SELECT * FROM change_sets WHERE session_id=? AND created_at>=? AND status='accepted' AND undone=0",
        ).all(sessionId, fromTime) as Row[]).map(row => ({ kind: "change_set" as const, createdAt: String(row.created_at), row })),
        ...(this.database.prepare(`
          SELECT r.* FROM revisions r
          JOIN proposals p ON p.id=r.proposal_id
          WHERE p.session_id=? AND p.created_at>=? AND p.status='accepted' AND r.undone=0
        `).all(sessionId, fromTime) as Row[]).map(row => ({ kind: "proposal" as const, createdAt: String(row.created_at), row })),
        ...(this.database.prepare(
          "SELECT * FROM character_revisions WHERE session_id=? AND message_id>=? AND undone=0",
        ).all(sessionId, fromId) as Row[]).map(row => ({ kind: "character" as const, createdAt: String(row.created_at), row })),
      ].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || Number(right.row.id) - Number(left.row.id));
      for (const action of actions) {
        if (action.kind === "change_set") {
          const revisions = parseProposalCharacterRevisions(action.row.character_revisions_json);
          const changeSet = this.undoChangeSet(Number(action.row.id));
          undonePaths.push(...changeSet.files.map(file => file.targetPath ?? file.path));
          undoneCharacters.push(...revisions.map(revision => this.normalizeCharacter(revision.after).identity.name));
        } else if (action.kind === "proposal") {
          const undone = this.rewindProposalRevision(action.row);
          undonePaths.push(undone.path);
          undoneCharacters.push(...undone.characterNames);
        } else {
          undoneCharacters.push(this.rewindCharacterRevision(action.row));
        }
      }
    }
    // Fork the immutable replay ledger before removing dialogue rows. Commits on
    // the abandoned branch stay archived, but can no longer enter live requests.
    this.truncateAgentTurnBlocksFromMessage(sessionId, fromId);
    this.database.prepare("DELETE FROM messages WHERE session_id=? AND id>=?").run(sessionId, fromId);
    this.database.prepare("DELETE FROM proposals WHERE session_id=? AND created_at>=? AND status!='accepted' AND id NOT IN (SELECT proposal_id FROM revisions WHERE proposal_id IS NOT NULL)").run(sessionId, fromTime);
    this.deleteMessageStepTrailsFrom(sessionId, fromId);
    this.archiveContextGraphFrom(sessionId, fromId);
    if (!keepChanges) this.deleteWritingMemoryFromMessage(sessionId, fromId);
    // Task/todos/tool memory are dialogue-turn state; rewind must not leave them attached to the session shell.
    this.clearSessionTaskState(sessionId);
    if (userRow.channel === "roleplay") this.restoreRoleplayMemoryBefore(sessionId, fromId);
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
    inputMode?: RoleplayInputMode;
    modelInitiatedRoleplay?: "opening" | "continuation";
  } {
    if (!this.sessionExists(sessionId)) throw new Error("会话不存在");
    const target = this.database.prepare(`SELECT id,role,content,created_at,channel,variant_group_id
      FROM messages WHERE id=? AND session_id=?`).get(targetId, sessionId) as Row | undefined;
    if (!target) throw new Error("消息不存在");
    if (target.role === "assistant" && target.channel === "roleplay") {
      const precedingRoleplayUser = this.database.prepare(`SELECT id FROM messages
        WHERE session_id=? AND role='user' AND channel='roleplay' AND id<=? ORDER BY id DESC LIMIT 1`)
        .get(sessionId, targetId) as Row | undefined;
      if (!precedingRoleplayUser) {
        const fromId = Number(target.id);
        const groupId = typeof target.variant_group_id === "string" ? target.variant_group_id : randomUUID();
        this.database.prepare("UPDATE messages SET variant_group_id=? WHERE session_id=? AND id=?")
          .run(groupId, sessionId, fromId);
        const duplicate = this.database.prepare(`SELECT id FROM message_variants
          WHERE session_id=? AND group_id=? AND prompt='' AND content=? LIMIT 1`)
          .get(sessionId, groupId, String(target.content)) as Row | undefined;
        if (!duplicate) {
          const max = this.database.prepare("SELECT COALESCE(MAX(version_index),0) AS value FROM message_variants WHERE session_id=? AND group_id=?")
            .get(sessionId, groupId) as Row;
          this.database.prepare("INSERT INTO message_variants(session_id,group_id,version_index,prompt,content,created_at) VALUES(?,?,?,?,?,?)")
            .run(sessionId, groupId, Number(max.value) + 1, "", String(target.content), new Date().toISOString());
        }
        this.truncateAgentTurnBlocksFromMessage(sessionId, fromId);
        this.database.prepare("DELETE FROM messages WHERE session_id=? AND id>=?").run(sessionId, fromId);
        this.clearSessionTaskState(sessionId);
        this.restoreRoleplayMemoryBefore(sessionId, fromId);
        this.deleteMessageStepTrailsFrom(sessionId, fromId);
        this.archiveContextGraphFrom(sessionId, fromId);
        this.addSystemMessage(sessionId, `已撤销角色主动开场 #${fromId} 及其后续对话，准备重新演出。`);
        this.reindex();
        return {
          fromId,
          prompt: "",
          channel: "roleplay",
          variantGroupId: groupId,
          keepChanges: Boolean(options?.keepChanges),
          modelInitiatedRoleplay: "opening",
        };
      }
    }
    const user = this.database.prepare(`SELECT id,content,channel,variant_group_id,roleplay_input_mode,roleplay_perception FROM messages
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
    const inputMode: RoleplayInputMode | undefined = channel === "roleplay"
      ? user.roleplay_input_mode === "director"
        || (typeof user.roleplay_perception === "string" && user.roleplay_perception.startsWith("［OOC 导演指示"))
        ? "director"
        : "dialogue"
      : undefined;
    if (channel === "roleplay") this.archiveRoleplayBranch(sessionId, fromId, groupId);
    const rewound = this.rewindFromMessage(sessionId, fromId, options);
    return {
      fromId: rewound.fromId,
      prompt,
      channel,
      variantGroupId: groupId,
      keepChanges: rewound.keepChanges,
      ...(inputMode ? { inputMode } : {}),
      ...(channel === "roleplay" && prompt === "<续演>"
        ? { modelInitiatedRoleplay: "continuation" as const }
      : {}),
    };
  }

  interruptedAgentResumePrompt(sessionId: string, targetId: number): { prompt: string; fromId: number } {
    if (!this.sessionExists(sessionId)) throw new Error("会话不存在");
    const target = this.database.prepare(`SELECT id,role,content,channel FROM messages WHERE id=? AND session_id=?`)
      .get(targetId, sessionId) as Row | undefined;
    if (!target) throw new Error("消息不存在");
    if (target.channel !== "agent") throw new Error("只能续跑 Agent 消息");
    if (target.role === "user") {
      const prompt = String(target.content).trim();
      if (!prompt) throw new Error("原始用户指令为空，无法续跑");
      return { fromId: Number(target.id), prompt };
    }
    if (target.role !== "assistant" || !String(target.content).includes("[生成已中断]")) {
      throw new Error("只能续跑已中断的 Agent 回复或对应用户指令");
    }
    const user = this.database.prepare(`SELECT id,content FROM messages
      WHERE session_id=? AND role='user' AND channel='agent' AND id<? ORDER BY id DESC LIMIT 1`)
      .get(sessionId, targetId) as Row | undefined;
    if (!user || !String(user.content).trim()) throw new Error("未找到可续跑的原始用户指令");
    return { fromId: Number(user.id), prompt: String(user.content) };
  }

  archiveRoleplayBranch(sessionId: string, fromMessageId: number, groupId: string): RoleplayBranchSummary | undefined {
    const user = this.database.prepare(`SELECT id,content FROM messages
      WHERE session_id=? AND id=? AND role='user' AND channel='roleplay'`).get(sessionId, fromMessageId) as Row | undefined;
    if (!user) return undefined;
    const existingBase = this.database.prepare(`SELECT MIN(base_message_id) AS value FROM roleplay_branches
      WHERE session_id=? AND group_id=?`).get(sessionId, groupId) as Row;
    const immediateBase = this.database.prepare("SELECT COALESCE(MAX(id),0) AS value FROM messages WHERE session_id=? AND id<?")
      .get(sessionId, fromMessageId) as Row;
    const baseMessageId = existingBase.value === null || existingBase.value === undefined
      ? Number(immediateBase.value) || 0
      : Number(existingBase.value) || 0;
    const rows = this.database.prepare(`SELECT id,role,content,created_at,channel,variant_group_id,roleplay_perception,roleplay_model_input,roleplay_input_mode
      FROM messages WHERE session_id=? AND id>? ORDER BY id`).all(sessionId, baseMessageId) as Row[];
    const dialogueRows = rows.filter(row => row.role === "user" || row.role === "assistant");
    if (dialogueRows.some(row => row.channel !== "roleplay")) return undefined;
    const messages: RoleplayBranchPayload["messages"] = rows.map(row => ({
      id: Number(row.id),
      role: row.role as Message["role"],
      content: String(row.content),
      createdAt: String(row.created_at),
      channel: row.channel === "roleplay" ? "roleplay" : "agent",
      ...(typeof row.variant_group_id === "string" ? { variantGroupId: row.variant_group_id } : {}),
      ...(typeof row.roleplay_perception === "string" ? { roleplayPerception: row.roleplay_perception } : {}),
      ...(typeof row.roleplay_model_input === "string" ? { roleplayModelInput: row.roleplay_model_input } : {}),
      ...(row.roleplay_input_mode === "director" || row.roleplay_input_mode === "dialogue"
        ? { roleplayInputMode: row.roleplay_input_mode }
        : {}),
    }));
    if (!messages.length) return undefined;
    const memorySnapshots = (this.database.prepare(`SELECT through_message_id,context_key,memory_json,created_at
      FROM roleplay_memory_snapshots WHERE session_id=? AND through_message_id>? ORDER BY through_message_id`)
      .all(sessionId, baseMessageId) as Row[]).map(row => ({
        throughMessageId: Number(row.through_message_id),
        contextKey: String(row.context_key),
        memoryJson: String(row.memory_json),
        createdAt: String(row.created_at),
      }));
    const facts = this.database.prepare(`SELECT * FROM roleplay_memory_facts
      WHERE session_id=? AND source_message_id>? AND pinned=0 ORDER BY id`).all(sessionId, baseMessageId) as Row[];
    const payload: RoleplayBranchPayload = {
      messages,
      memory: this.roleplayMemory(sessionId),
      memorySnapshots,
      facts,
    };
    const payloadJson = JSON.stringify(payload);
    const duplicate = this.database.prepare(`SELECT id FROM roleplay_branches
      WHERE session_id=? AND group_id=? AND payload_json=? LIMIT 1`).get(sessionId, groupId, payloadJson) as Row | undefined;
    if (duplicate) return this.roleplayBranches(sessionId, groupId).find(item => item.id === duplicate.id);
    const assistant = [...dialogueRows].reverse().find(row => row.role === "assistant");
    const id = randomUUID();
    const now = new Date().toISOString();
    const label = String(user.content).replace(/\s+/g, " ").trim().slice(0, 48) || "角色扮演分支";
    const preview = assistant ? String(assistant.content).replace(/\s+/g, " ").trim().slice(0, 100) : "尚无角色回复";
    this.database.prepare(`INSERT INTO roleplay_branches(
      id,session_id,group_id,base_message_id,from_message_id,label,preview,message_count,payload_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id, sessionId, groupId, baseMessageId, fromMessageId, label, preview, dialogueRows.length, payloadJson, now,
    );
    return { id, groupId, fromMessageId, label, preview, messageCount: dialogueRows.length, createdAt: now };
  }

  roleplayBranches(sessionId: string, groupId?: string): RoleplayBranchSummary[] {
    const rows = groupId
      ? this.database.prepare(`SELECT id,group_id,from_message_id,label,preview,message_count,created_at
          FROM roleplay_branches WHERE session_id=? AND group_id=? ORDER BY created_at DESC`).all(sessionId, groupId)
      : this.database.prepare(`SELECT id,group_id,from_message_id,label,preview,message_count,created_at
          FROM roleplay_branches WHERE session_id=? ORDER BY created_at DESC LIMIT 100`).all(sessionId);
    return (rows as Row[]).map(row => ({
      id: String(row.id),
      groupId: String(row.group_id),
      fromMessageId: Number(row.from_message_id),
      label: String(row.label),
      preview: String(row.preview),
      messageCount: Number(row.message_count),
      createdAt: String(row.created_at),
    }));
  }

  activateRoleplayBranch(sessionId: string, branchId: string): { groupId: string; fromMessageId: number } {
    const branch = this.database.prepare("SELECT * FROM roleplay_branches WHERE id=? AND session_id=?")
      .get(branchId, sessionId) as Row | undefined;
    if (!branch) throw new Error("角色扮演分支不存在");
    let payload: RoleplayBranchPayload;
    try { payload = JSON.parse(String(branch.payload_json)) as RoleplayBranchPayload; }
    catch { throw new Error("角色扮演分支数据已损坏"); }
    if (!Array.isArray(payload.messages) || !payload.messages.length) throw new Error("角色扮演分支为空");
    const groupId = String(branch.group_id);
    const liveUser = this.database.prepare(`SELECT id FROM messages
      WHERE session_id=? AND variant_group_id=? AND role='user' AND channel='roleplay' ORDER BY id LIMIT 1`)
      .get(sessionId, groupId) as Row | undefined;
    if (liveUser) this.archiveRoleplayBranch(sessionId, Number(liveUser.id), groupId);
    const baseMessageId = Number(branch.base_message_id) || 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM messages WHERE session_id=? AND id>?").run(sessionId, baseMessageId);
      this.database.prepare("DELETE FROM message_step_trails WHERE session_id=? AND source_message_id>?").run(sessionId, baseMessageId);
      this.database.prepare("DELETE FROM roleplay_memory_snapshots WHERE session_id=? AND through_message_id>?")
        .run(sessionId, baseMessageId);
      this.database.prepare("DELETE FROM roleplay_memory_facts WHERE session_id=? AND source_message_id>? AND pinned=0")
        .run(sessionId, baseMessageId);
      const insertMessage = this.database.prepare(`INSERT INTO messages(
        id,session_id,role,content,created_at,channel,variant_group_id,roleplay_perception,roleplay_model_input,roleplay_input_mode
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const message of payload.messages) insertMessage.run(
        message.id, sessionId, message.role, message.content, message.createdAt, message.channel,
        message.variantGroupId ?? null, message.roleplayPerception ?? null, message.roleplayModelInput ?? null,
        message.roleplayInputMode === "director" || message.roleplayInputMode === "dialogue"
          ? message.roleplayInputMode
          : message.channel === "roleplay" && message.role === "user"
            && message.roleplayPerception?.startsWith("［OOC 导演指示")
            ? "director"
            : message.channel === "roleplay" && message.role === "user" ? "dialogue" : null,
      );
      if (payload.memory) this.saveRoleplayMemory(sessionId, payload.memory);
      else this.database.prepare("DELETE FROM roleplay_memory WHERE session_id=?").run(sessionId);
      const insertSnapshot = this.database.prepare(`INSERT INTO roleplay_memory_snapshots(
        session_id,through_message_id,context_key,memory_json,created_at
      ) VALUES(?,?,?,?,?)`);
      for (const snapshot of payload.memorySnapshots ?? []) insertSnapshot.run(
        sessionId, snapshot.throughMessageId, snapshot.contextKey, snapshot.memoryJson, snapshot.createdAt,
      );
      const insertFact = this.database.prepare(`INSERT INTO roleplay_memory_facts(
        id,session_id,context_key,kind,content,source_message_id,known_by_json,importance,status,pinned,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const fact of payload.facts ?? []) insertFact.run(
        Number(fact.id), sessionId, String(fact.context_key), String(fact.kind), String(fact.content),
        fact.source_message_id === null || fact.source_message_id === undefined ? null : Number(fact.source_message_id),
        String(fact.known_by_json), Number(fact.importance), String(fact.status), Number(fact.pinned),
        String(fact.created_at), String(fact.updated_at),
      );
      this.database.prepare("DELETE FROM roleplay_branches WHERE id=? AND session_id=?").run(branchId, sessionId);
      this.database.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(new Date().toISOString(), sessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.reindex();
    return { groupId, fromMessageId: Number(branch.from_message_id) };
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
      INSERT INTO revisions(proposal_id,path,before_content,after_content,after_hash,label,created_at)
      VALUES(NULL,?,?,?,?,?,?)
    `).run(path, current, content, this.project.hash(content), "手动编辑", new Date().toISOString());
    this.reindex();
  }

  chapterSummaries(): ChapterSummary[] {
    const revisionRows = this.database.prepare(`
      SELECT path, COUNT(*) AS version_count, MAX(created_at) AS updated_at
      FROM revisions WHERE path LIKE 'chapters/%' GROUP BY path
    `).all() as Row[];
    const revisions = new Map(revisionRows.map(row => [String(row.path), {
      count: Number(row.version_count),
      updatedAt: String(row.updated_at ?? ""),
    }]));
    return this.project.listDocuments()
      .filter(path => path.startsWith("chapters/"))
      .map((path) => {
        const content = this.project.read(path);
        const title = content.match(/^\s*#\s+(.+)$/mu)?.[1]?.trim()
          || path.split("/").pop()!.replace(/\.md$/iu, "");
        const relative = path.slice("chapters/".length);
        const slash = relative.lastIndexOf("/");
        const revision = revisions.get(path);
        return {
          path,
          title,
          volume: slash >= 0 ? relative.slice(0, slash) : "",
          wordCount: content.replace(/\s+/gu, "").length,
          versionCount: revision?.count ?? 0,
          updatedAt: revision?.updatedAt ?? "",
        };
      })
      .sort((a, b) => comparePathNames(a.path, b.path) || comparePathNames(a.title, b.title));
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
      SELECT r.id, r.path, r.after_hash, r.created_file, r.created_at, r.undone, r.label,
             r.quality_report_json, p.summary AS proposal_summary
      FROM revisions r
      LEFT JOIN proposals p ON p.id = r.proposal_id
      WHERE r.path = ?
      ORDER BY r.id DESC
      LIMIT 200
    `).all(path) as Row[];
    return rows.map((row) => {
      const undone = Number(row.undone) === 1;
      const baseSummary = typeof row.label === "string" && row.label.trim()
        ? String(row.label)
        : typeof row.proposal_summary === "string" && row.proposal_summary.trim()
          ? String(row.proposal_summary)
          : Number(row.created_file) === 1 ? "新建文档" : "手动编辑";
      const qualityReport = parseProposalQualityReport(row.quality_report_json);
      return {
        id: Number(row.id),
        path: String(row.path),
        createdAt: String(row.created_at),
        summary: undone ? `已回退 · ${baseSummary}` : baseSummary,
        isCurrent: !undone && liveHash !== "" && String(row.after_hash) === liveHash,
        createdFile: Number(row.created_file) === 1,
        undone,
        ...(qualityReport ? { qualityReport } : {}),
      };
    });
  }

  /** Full before/after snapshot for a single revision (browse-only; includes rolled-back). */
  documentVersion(path: string, revisionId: number): DocumentVersionDetail {
    if (!path) throw new Error("缺少文档路径");
    if (!Number.isInteger(revisionId) || revisionId <= 0) throw new Error("版本编号无效");
    const row = this.database.prepare(`
      SELECT r.id, r.path, r.before_content, r.after_content, r.after_hash,
             r.created_file, r.created_at, r.undone, r.label, r.quality_report_json, p.summary AS proposal_summary
      FROM revisions r
      LEFT JOIN proposals p ON p.id = r.proposal_id
      WHERE r.id = ? AND r.path = ?
    `).get(revisionId, path) as Row | undefined;
    if (!row) throw new Error("版本不存在");
    const live = this.project.documentExists(path) ? this.project.read(path) : "";
    const liveHash = live ? this.project.hash(live) : "";
    const undone = Number(row.undone) === 1;
    const baseSummary = typeof row.label === "string" && row.label.trim()
      ? String(row.label)
      : typeof row.proposal_summary === "string" && row.proposal_summary.trim()
        ? String(row.proposal_summary)
        : Number(row.created_file) === 1 ? "新建文档" : "手动编辑";
    const qualityReport = parseProposalQualityReport(row.quality_report_json);
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
      ...(qualityReport ? { qualityReport } : {}),
    };
  }

  /** Terminal report for the exact body currently open in the reader. */
  documentQualityReport(path: string, afterHash: string): ProseQualityReport | undefined {
    if (!path || !afterHash) return undefined;
    const row = this.database.prepare(`
      SELECT quality_report_json
      FROM revisions
      WHERE path=? AND after_hash=? AND quality_report_json<>''
      ORDER BY id DESC
      LIMIT 1
    `).get(path, afterHash) as Row | undefined;
    return row ? parseProposalQualityReport(row.quality_report_json) : undefined;
  }

  restoreDocumentVersion(path: string, revisionId: number, baseHash: string): DocumentVersionMeta {
    if (!this.project.documentExists(path)) throw new Error("当前文档不存在，无法恢复历史版本");
    const current = this.project.read(path);
    if (this.project.hash(current) !== baseHash) throw new Error("文档已在其他位置修改，请刷新后重试");
    const target = this.documentVersion(path, revisionId);
    if (current === target.afterContent) throw new Error("当前内容已经是该版本");
    const now = new Date().toISOString();
    this.project.writeRaw(path, target.afterContent);
    const result = this.database.prepare(`
      INSERT INTO revisions(proposal_id,path,before_content,after_content,after_hash,label,created_at)
      VALUES(NULL,?,?,?,?,?,?)
    `).run(path, current, target.afterContent, this.project.hash(target.afterContent), `恢复版本 #${revisionId}`, now);
    this.refreshWritingMemoryForDocument(path, target.afterContent);
    this.reindex();
    return this.documentVersions(path).find(version => version.id === Number(result.lastInsertRowid))!;
  }

  renameDocument(fromPath: string, toPath: string, options?: { uniqueIfExists?: boolean }): string {
    const finalPath = this.project.renameDocument(fromPath, toPath, options);
    this.database.prepare("UPDATE proposals SET path=? WHERE path=?").run(finalPath, fromPath);
    this.database.prepare("UPDATE revisions SET path=? WHERE path=?").run(finalPath, fromPath);
    if (this.project.isDocumentHidden(finalPath)) {
      // Moving into archive/屏蔽：废弃该来源事实，避免旧稿继续注入 Agent。
      this.refreshWritingMemoryForDocument(fromPath, "");
      this.refreshWritingMemoryForDocument(finalPath, "");
    } else {
      this.moveWritingMemorySource(fromPath, finalPath, this.project.read(finalPath));
    }
    this.reindex();
    return finalPath;
  }

  renameFolder(fromPath: string, toPath: string, options?: { uniqueIfExists?: boolean }): string {
    const fromPrefix = `${fromPath.replace(/\/+$/u, "")}/`;
    const finalPath = this.project.renameFolder(fromPath, toPath, options);
    const toPrefix = `${finalPath.replace(/\/+$/u, "")}/`;
    const rewrite = (path: string) => path.startsWith(fromPrefix) ? `${toPrefix}${path.slice(fromPrefix.length)}` : path;
    const proposalRows = this.database.prepare("SELECT id,path FROM proposals WHERE path LIKE ?").all(`${fromPrefix}%`) as Array<{ id: number; path: string }>;
    const revisionRows = this.database.prepare("SELECT id,path FROM revisions WHERE path LIKE ?").all(`${fromPrefix}%`) as Array<{ id: number; path: string }>;
    const updateProposal = this.database.prepare("UPDATE proposals SET path=? WHERE id=?");
    const updateRevision = this.database.prepare("UPDATE revisions SET path=? WHERE id=?");
    for (const row of proposalRows) updateProposal.run(rewrite(row.path), row.id);
    for (const row of revisionRows) updateRevision.run(rewrite(row.path), row.id);
    const memoryRows = this.database.prepare("SELECT DISTINCT source_path FROM writing_memory WHERE source_path LIKE ?")
      .all(`${fromPrefix}%`) as Row[];
    for (const row of memoryRows) {
      const from = String(row.source_path);
      const to = rewrite(from);
      if (this.project.isDocumentHidden(to) || this.project.isDocumentHidden(from)) {
        this.refreshWritingMemoryForDocument(from, "");
        this.refreshWritingMemoryForDocument(to, "");
      } else if (this.project.textFileExists(to)) {
        this.moveWritingMemorySource(from, to, this.project.readTextFile(to));
      }
    }
    this.reindex();
    return finalPath;
  }

  removeFolder(path: string): void {
    const prefix = `${path.replace(/\/+$/u, "")}/`;
    this.project.removeFolder(path);
    const rows = this.database.prepare("SELECT DISTINCT source_path FROM writing_memory WHERE source_path LIKE ?")
      .all(`${prefix}%`) as Row[];
    for (const row of rows) this.refreshWritingMemoryForDocument(String(row.source_path), "");
    this.reindex();
  }

  reindex(): void {
    this.database.exec("DELETE FROM document_index");
    const insert = this.database.prepare("INSERT INTO document_index(path,content) VALUES(?,?)");
    for (const path of this.project.listDocuments()) {
      // Archive / agent-hidden paths must not enter FTS — search filters are a second line only.
      if (this.project.isDocumentHidden(path)) continue;
      insert.run(path, this.project.read(path));
    }
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

function canonicalTextPath(path: string): string {
  return normalizeResourcePath(path);
}

function writingMemoryEvidenceAnchor(content: string, sourceHash: string, evidence: string): string {
  const offset = evidence ? content.indexOf(evidence) : -1;
  if (offset < 0) return "";
  return documentSpans(content, sourceHash)
    .find(span => span.startOffset <= offset && span.endOffset > offset)?.anchorId ?? "";
}

function writingMemoryEnum<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === "string" && allowed.includes(value) ? value as T[number] : fallback;
}

function writingMemoryFromRow(row: Row): WritingMemoryEntry {
  const parseCharacterIds = (value: unknown): number[] => {
    if (typeof value !== "string") return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? [...new Set(parsed.map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, 8)
        : [];
    } catch {
      return [];
    }
  };
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    sourceMessageId: Number(row.source_message_id),
    ...(Number.isInteger(Number(row.source_proposal_id)) && Number(row.source_proposal_id) > 0
      ? { sourceProposalId: Number(row.source_proposal_id) }
      : {}),
    kind: writingMemoryEnum(row.kind, WRITING_MEMORY_KINDS, "portrayal") as WritingMemoryKind,
    content: String(row.content),
    characterIds: parseCharacterIds(row.character_ids_json),
    importance: Number(row.importance),
    status: row.status === "stale" ? "stale" : "active",
    sourcePath: String(row.source_path ?? ""),
    sourceHash: String(row.source_hash ?? ""),
    sourceEvidence: String(row.source_evidence ?? ""),
    sourceAnchorId: String(row.source_anchor_id ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function textOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (search && offset <= content.length - search.length) {
    const index = content.indexOf(search, offset);
    if (index < 0) break;
    count += 1;
    offset = index + search.length;
  }
  return count;
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

function normalizeSavedSimpleCharacter(input: unknown): SavedRoleplayInterlocutor {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("简易角色卡根节点必须是对象");
  const raw = input as Record<string, unknown>;
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id < 1) throw new Error("简易角色 ID 无效");
  const targetCharacterId = raw.targetCharacterId === undefined ? undefined : Number(raw.targetCharacterId);
  if (targetCharacterId !== undefined && (!Number.isInteger(targetCharacterId) || targetCharacterId < 1)) {
    throw new Error("关联的试演角色 ID 无效");
  }
  return {
    id,
    ...(targetCharacterId ? { targetCharacterId } : {}),
    name: roleplayField(raw.name, "名称", 120, true),
    identity: roleplayField(raw.identity, "身份"),
    relationship: roleplayField(raw.relationship, "关系"),
    knowledge: roleplayField(raw.knowledge, "已知信息"),
    scene: roleplayField(raw.scene, "场景"),
    goal: roleplayField(raw.goal, "目标"),
    createdAt: roleplayField(raw.createdAt, "创建时间", 100, true),
    updatedAt: roleplayField(raw.updatedAt, "更新时间", 100, true),
  };
}

function normalizeStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string")
    .map(item => item.trim().slice(0, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function jsonStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try { return normalizeStringArray(JSON.parse(value) as unknown, 100, 2_000); }
  catch { return []; }
}

function roleplaySceneFromRow(row: Row): RoleplayScene {
  return {
    id: Number(row.id),
    name: String(row.name),
    setting: String(row.setting ?? ""),
    premise: String(row.premise ?? ""),
    tone: String(row.tone ?? ""),
    timelineAnchor: String(row.timeline_anchor ?? ""),
    performerGoal: String(row.performer_goal ?? ""),
    identityGoal: String(row.identity_goal ?? ""),
    stakes: jsonStringArray(row.stakes_json),
    openingVariants: jsonStringArray(row.opening_variants_json),
    endConditions: jsonStringArray(row.end_conditions_json),
    loreBindings: jsonStringArray(row.lore_bindings_json),
    revision: Math.max(1, Number(row.revision) || 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizeFactKind(value: unknown): RoleplayMemoryFactKind {
  return value === "promise" || value === "relationship" || value === "secret" || value === "preference" ? value : "event";
}

function normalizeFactStatus(value: unknown): RoleplayMemoryFactStatus {
  return value === "superseded" || value === "retracted" ? value : "active";
}

function normalizeKnownBy(value: unknown): Array<"public" | "performer" | "identity"> {
  const accepted = normalizeStringArray(value, 3, 20)
    .filter((item): item is "public" | "performer" | "identity" => item === "public" || item === "performer" || item === "identity");
  return accepted.length ? accepted : ["public"];
}

function roleplayMemoryFactFromRow(row: Row): RoleplayMemoryFact {
  const source = Number(row.source_message_id);
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    contextKey: String(row.context_key),
    kind: normalizeFactKind(row.kind),
    content: String(row.content),
    ...(Number.isInteger(source) && source > 0 ? { sourceMessageId: source } : {}),
    knownBy: normalizeKnownBy(jsonStringArray(row.known_by_json)),
    importance: Math.max(0, Math.min(100, Number(row.importance) || 0)),
    status: normalizeFactStatus(row.status),
    pinned: Number(row.pinned) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
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
