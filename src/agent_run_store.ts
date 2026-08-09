import { randomUUID } from "node:crypto";
import type { WriterStore } from "./store.js";
import { assertAgentRunInvariants } from "./agent_run_invariants.js";
import { reduceAgentRunEvent } from "./agent_run_reducer.js";
import type {
  AgentRunEventV2,
  AgentRunSnapshotV2,
  PersistedAgentRunEventV2,
} from "./agent_run_types.js";

type Row = Record<string, unknown>;

function parseSnapshot(value: unknown): AgentRunSnapshotV2 | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as AgentRunSnapshotV2;
    return parsed?.version === 2 && typeof parsed.id === "string" && Array.isArray(parsed.deliverables)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export class AgentRunStore {
  constructor(private readonly store: WriterStore) {}

  start(input: {
    sessionId: string;
    sourceMessageId: number;
    originalRequest: string;
    contract: Extract<AgentRunEventV2, { type: "run_started" }>["contract"];
    volume?: { name: string; autoCreated: boolean };
    deliverables: Array<{ id: string; label: string }>;
    reusableEvidence: boolean;
  }): AgentRunSnapshotV2 {
    const id = randomUUID();
    const at = new Date().toISOString();
    const event: Extract<AgentRunEventV2, { type: "run_started" }> = {
      type: "run_started",
      at,
      sourceMessageId: input.sourceMessageId,
      originalRequest: input.originalRequest,
      contract: input.contract,
      ...(input.volume ? { volume: input.volume } : {}),
      deliverables: input.deliverables,
      reusableEvidence: input.reusableEvidence,
    };
    const snapshot = reduceAgentRunEvent(undefined, event, { id, sessionId: input.sessionId });
    assertAgentRunInvariants(snapshot);
    const database = this.store.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`INSERT INTO agent_runs(
        id,session_id,source_message_id,original_request,status,snapshot_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        id, input.sessionId, input.sourceMessageId, input.originalRequest,
        snapshot.status, JSON.stringify(snapshot), at, at,
      );
      database.prepare(`INSERT INTO agent_run_events(run_id,sequence,event_key,type,payload_json,created_at)
        VALUES(?,1,?,?,?,?)`).run(id, "run_started", event.type, JSON.stringify(event), at);
      database.exec("COMMIT");
      return snapshot;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  snapshot(runId: string): AgentRunSnapshotV2 | undefined {
    const row = this.store.database.prepare("SELECT snapshot_json FROM agent_runs WHERE id=?").get(runId) as Row | undefined;
    return parseSnapshot(row?.snapshot_json);
  }

  latestForSession(sessionId: string): AgentRunSnapshotV2 | undefined {
    const row = this.store.database.prepare(`SELECT snapshot_json FROM agent_runs
      WHERE session_id=? ORDER BY created_at DESC LIMIT 1`).get(sessionId) as Row | undefined;
    return parseSnapshot(row?.snapshot_json);
  }

  resumableForSession(sessionId: string, originalRequest: string): AgentRunSnapshotV2 | undefined {
    const row = this.store.database.prepare(`SELECT snapshot_json FROM agent_runs
      WHERE session_id=? AND original_request=? AND status IN ('suspended','cancelled','failed')
      ORDER BY updated_at DESC LIMIT 1`).get(sessionId, originalRequest) as Row | undefined;
    return parseSnapshot(row?.snapshot_json);
  }

  append(runId: string, eventKey: string, event: AgentRunEventV2): AgentRunSnapshotV2 {
    const database = this.store.database;
    database.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = database.prepare(`SELECT 1 AS ok FROM agent_run_events
        WHERE run_id=? AND event_key=?`).get(runId, eventKey) as Row | undefined;
      const row = database.prepare("SELECT snapshot_json FROM agent_runs WHERE id=?").get(runId) as Row | undefined;
      const current = parseSnapshot(row?.snapshot_json);
      if (!current) throw new Error(`AgentRun 不存在：${runId}`);
      if (duplicate) {
        database.exec("COMMIT");
        return current;
      }
      const sequenceRow = database.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence
        FROM agent_run_events WHERE run_id=?`).get(runId) as Row;
      const sequence = Number(sequenceRow.sequence);
      const next = reduceAgentRunEvent(current, event);
      assertAgentRunInvariants(next);
      database.prepare(`INSERT INTO agent_run_events(run_id,sequence,event_key,type,payload_json,created_at)
        VALUES(?,?,?,?,?,?)`).run(runId, sequence, eventKey, event.type, JSON.stringify(event), event.at);
      database.prepare(`UPDATE agent_runs SET source_message_id=?,status=?,snapshot_json=?,updated_at=? WHERE id=?`).run(
        next.sourceMessageId, next.status, JSON.stringify(next), next.updatedAt, runId,
      );
      database.exec("COMMIT");
      return next;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  events(runId: string): PersistedAgentRunEventV2[] {
    const rows = this.store.database.prepare(`SELECT sequence,event_key,payload_json
      FROM agent_run_events WHERE run_id=? ORDER BY sequence`).all(runId) as Row[];
    return rows.flatMap(row => {
      try {
        return [{
          runId,
          sequence: Number(row.sequence),
          eventKey: String(row.event_key),
          event: JSON.parse(String(row.payload_json)) as AgentRunEventV2,
        }];
      } catch {
        return [];
      }
    });
  }
}
