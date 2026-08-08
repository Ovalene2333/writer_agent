import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import QRCode from "qrcode";
import { runAgent, stripDsmlText } from "./agent.js";
import {
  ABSOLUTE_MAX_SCENES,
  MAX_AGENT_STEPS,
  MAX_CHAPTER_TARGET_CHARACTERS,
  MAX_SCENE_NOTES_CHARACTERS,
  MAX_SCENE_CANDIDATES,
  MIN_AGENT_STEPS,
  MIN_CHAPTER_TARGET_CHARACTERS,
  MIN_PROSE_GATE_TIMEOUT_SECONDS,
  MAX_PROSE_GATE_TIMEOUT_SECONDS,
  MIN_SCENE_NOTES_CHARACTERS,
  isAgentStepBudgetMode,
  isProseLengthMode,
  isPermissionMode,
  isReasoningEffort,
  isRoleplayReasoningChoice,
  listProjectSkills,
  loadAgentSettings,
  loadProjectInstructions,
  saveAgentSettings,
  isWritingExecutionMode,
  MIN_ROLEPLAY_RECENT_MESSAGES,
  MAX_ROLEPLAY_RECENT_MESSAGES,
  MIN_ROLEPLAY_OUTPUT_TOKENS,
  MAX_ROLEPLAY_OUTPUT_TOKENS,
  MIN_ROLEPLAY_LENGTH_BLOCKS,
  MAX_ROLEPLAY_LENGTH_BLOCKS,
  ROLEPLAY_LENGTH_LEVEL_KEYS,
  type AgentStepBudgetMode,
  type ProseLengthSettings,
  type ProseGateTimeoutSettings,
  type RoleplayLengthBlockBudgets,
  type RoleplaySettings,
  type ScenePipelineSettings,
  type WritingExecutionMode,
} from "./agent_runtime.js";
import {
  generateCharacter,
  maybeAutoTitleSession,
  suggestActions,
  summarizeCharacterCompetency,
  summarizeCharacterField,
  updateCharacterFromConversation,
  type CharacterSummaryKind,
  type WritingMode,
} from "./generation.js";
import {
  generateRoleplayInterlocutor,
  generateRoleplayScene,
  normalizeRoleplayRerunControls,
  normalizeRoleplayRerunDirections,
  parseRoleplayPerception,
  parseStoredRoleplayPerception,
  generateRoleplayAutoReply,
  recommendRoleplayDirectorActions,
  runRoleplayChat,
  serializeRoleplayPerception,
  storedRoleplayPerceptionForDisplay,
  type RoleplayPerceptionProjection,
} from "./roleplay.js";
import { createAgentStepDebugLogger, stepDebugEnabled } from "./model_debug.js";
import { buildRecordedUsageEvent, type ModelUsageReporter } from "./model_usage.js";
import { documentKind, WriterProject } from "./project.js";
import { ProviderManager } from "./provider_catalog.js";
import {
  providerConcurrencySnapshot,
  providerTransportMetrics,
} from "./model_fetch.js";
import { ProviderError, providerErrorCodeMatrix } from "./provider_error.js";
import { WriterStore } from "./store.js";
import { getStyleTemplate, normalizeStyleTemplate } from "./templates.js";
import type { AgentEvent, Message, MessageStepTrail, ModelUsageRole, PermissionMode, PersistedStreamStep, RoleplayContentRating, RoleplayInputMode, RoleplayInterlocutor, RoleplayMemoryFact, RoleplayParticipant, RoleplayScene, StepUsage, StyleTemplate } from "./types.js";
import type { CharacterInput } from "./characters.js";
import {
  loadProseGateRules,
  removeProseGateRule,
  migrateProjectProseGatesToPolicies,
  setProseGateRuleEnabled,
  upsertProseGateRule,
  type ProseGateRule,
} from "./prose_gate_rules.js";
import { proseStyleIssuesError } from "./prose_quality.js";
import { proseStyleGateIssues } from "./tools/proposals.js";
import { extractWritingMemory } from "./writing_memory.js";
import {
  compileAuthorPolicyDraft,
  loadAuthorPolicies,
  loadAuthorPolicyFeedback,
  recordAuthorPolicyFeedback,
  removeAuthorPolicy,
  setAuthorPolicyStatus,
  upsertAuthorPolicy,
  type AuthorPolicy,
  type AuthorPolicyFeedbackDisposition,
  type AuthorPolicyStatus,
} from "./author_policies.js";
import { createProjectBackup } from "./project_backup.js";

type AgentJobStatus = "running" | "completed" | "waiting" | "failed" | "cancelled";

export type WebConversationMessage = Message & {
  roleplayPerception?: string;
  roleplayPerceptionData?: RoleplayPerceptionProjection;
};

export function conversationMessageForWeb(store: WriterStore, message: Message): WebConversationMessage {
  if (message.channel !== "roleplay" || message.role !== "user") return message;
  if (message.roleplayInputMode === "director") return message;
  const stored = store.roleplayPerception(message.sessionId, message.id);
  const roleplayPerception = stored ? storedRoleplayPerceptionForDisplay(stored).trim() : "";
  const roleplayPerceptionData = stored ? parseStoredRoleplayPerception(stored) : undefined;
  return roleplayPerception
    ? { ...message, roleplayPerception, ...(roleplayPerceptionData ? { roleplayPerceptionData } : {}) }
    : message;
}

function isVisibleConversationMessage(message: Message): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (message.content.trim()) return true;
  return Boolean(message.attachments?.length);
}

function normalizeChatAttachments(
  value: unknown,
): Array<{ name?: string; mimeType: string; dataBase64: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { name?: unknown; mimeType?: unknown; dataBase64?: unknown };
    if (typeof row.mimeType !== "string" || typeof row.dataBase64 !== "string") return [];
    return [{
      ...(typeof row.name === "string" && row.name.trim() ? { name: row.name.trim().slice(0, 120) } : {}),
      mimeType: row.mimeType,
      dataBase64: row.dataBase64,
    }];
  });
}

export type AgentJobInfo = {
  id: string;
  sessionId: string;
  status: AgentJobStatus;
  createdAt: string;
  updatedAt: string;
  projectId?: string;
  kind?: string;
  promptPreview?: string;
  sourceMessageId?: number;
  terminalMessage?: string;
};

export type ProjectSummary = {
  /** Stable workspace-relative ID. `.` represents a project at the workspace root. */
  id: string;
  title: string;
};

function styleTemplateExampleReviewed(store: WriterStore, template: StyleTemplate): boolean {
  const content = template.exampleContent.trim();
  if (!content) return false;
  const example = store.writingExamples().find(item => item.title === `[风格模板] ${template.name}`);
  return Boolean(example?.gatePassed && example.content.trim() === content);
}

type StyleExampleReviewState = {
  contentHash: string;
  status: "reviewing" | "failed";
  error?: string;
};

function styleTemplatesForClient(
  project: WriterProject,
  store: WriterStore,
  reviews?: ReadonlyMap<string, StyleExampleReviewState>,
) {
  return project.styleTemplates().map(template => {
    const builtIn = Boolean(getStyleTemplate(template.id));
    const review = reviews?.get(template.id);
    const currentReview = review?.contentHash === project.hash(template.exampleContent.trim()) ? review : undefined;
    const reviewed = styleTemplateExampleReviewed(store, template);
    return {
      ...template,
      builtIn,
      // Built-ins are never project-customized (overrides are ignored).
      customized: !builtIn,
      readOnly: builtIn,
      exampleReviewed: reviewed,
      exampleReviewStatus: currentReview?.status ?? (reviewed ? "reviewed" : "unreviewed"),
      ...(currentReview?.error ? { exampleReviewError: currentReview.error } : {}),
    };
  });
}

type StoredAgentEvent = AgentEvent & { index: number };
type AgentJob = {
  id: string;
  sessionId: string;
  status: AgentJobStatus;
  createdAt: string;
  updatedAt: string;
  /** Monotonic index assigned to the next emitted event (survives ring-buffer eviction). */
  nextEventIndex: number;
  /** Ring buffer of recent events for SSE replay (bounded). */
  events: StoredAgentEvent[];
  controller: AbortController;
  listeners: Set<(event: StoredAgentEvent) => void>;
  /** The store this job started with. It must never follow a workspace switch. */
  store?: WriterStore;
  projectId?: string;
  kind: string;
  promptPreview: string;
  sourceMessageId?: number;
  terminalMessage?: string;
};

const STEP_TRAIL_TEXT_MAX = 12_000;
const STEP_TRAIL_FLUSH_MS = 1_500;

export function maxJobEventBuffer(): number {
  const raw = process.env.WRITER_MAX_JOB_EVENTS?.trim();
  const parsed = raw ? Number(raw) : 1_500;
  if (!Number.isFinite(parsed)) return 1_500;
  // Floor at 5 so long SSE streams stay bounded while tests can shrink the ring.
  return Math.min(20_000, Math.max(5, Math.round(parsed)));
}

function compactStepTrailText(value: string): string {
  if (value.length <= STEP_TRAIL_TEXT_MAX) return value;
  const tailLength = 2_000;
  const headLength = STEP_TRAIL_TEXT_MAX - tailLength;
  return `${value.slice(0, headLength)}\n\n[内容过长，已截断]\n\n${value.slice(-tailLength)}`;
}

function toStepUsageCall(call: StepUsage, callKind = "unspecified"): NonNullable<StepUsage["callBreakdown"]>[number] {
  return {
    model: call.model,
    providerName: call.providerName,
    callKind,
    promptTokens: call.promptTokens,
    completionTokens: call.completionTokens,
    cacheHitTokens: call.cacheHitTokens,
    cacheMissTokens: call.cacheMissTokens,
    cost: call.cost,
    currency: call.currency,
    ...(call.estimated ? { estimated: true } : {}),
    ...(call.reasoningTokens !== undefined ? { reasoningTokens: call.reasoningTokens } : {}),
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
  };
}

/** Merge nested provider calls into one step usage while keeping a per-call breakdown. */
function mergePersistedStepUsage(
  current: StepUsage | undefined,
  next: StepUsage,
  callKind = "unspecified",
): StepUsage {
  const nextCalls = next.callBreakdown?.length
    ? next.callBreakdown
    : [toStepUsageCall(next, callKind)];
  if (!current) {
    return { ...next, callBreakdown: nextCalls };
  }
  const models = [...new Set(
    [...(current.callBreakdown ?? []).map(call => call.model), ...nextCalls.map(call => call.model), current.model, next.model]
      .filter((value): value is string => Boolean(value) && value !== "多个模型"),
  )];
  const hits = (current.cacheHitTokens ?? 0) + (next.cacheHitTokens ?? 0);
  const misses = (current.cacheMissTokens ?? 0) + (next.cacheMissTokens ?? 0);
  const estimated = Boolean(current.estimated || next.estimated);
  const providerNames = [...new Set(
    [...(current.callBreakdown ?? []).map(call => call.providerName), ...nextCalls.map(call => call.providerName), current.providerName, next.providerName]
      .filter((value): value is string => Boolean(value?.trim())),
  )];
  const hasReasoning = current.reasoningTokens !== undefined || next.reasoningTokens !== undefined;
  const hasDuration = current.durationMs !== undefined || next.durationMs !== undefined;
  return {
    ...(models.length ? { model: models.length === 1 ? models[0] : "多个模型" } : {}),
    ...(providerNames.length
      ? { providerName: providerNames.length === 1 ? providerNames[0] : providerNames.join(",") }
      : {}),
    promptTokens: (current.promptTokens ?? 0) + (next.promptTokens ?? 0),
    completionTokens: (current.completionTokens ?? 0) + (next.completionTokens ?? 0),
    cacheHitTokens: hits,
    cacheMissTokens: misses,
    totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0),
    cost: (current.cost ?? 0) + (next.cost ?? 0),
    currency: current.cost > 0 ? current.currency : next.currency || current.currency,
    ...(estimated ? { estimated: true } : {}),
    ...(!estimated && hits + misses > 0 ? { cacheHitRate: hits / (hits + misses) } : {}),
    ...(hasReasoning
      ? { reasoningTokens: (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) }
      : {}),
    ...(hasDuration
      ? { durationMs: (current.durationMs ?? 0) + (next.durationMs ?? 0) }
      : {}),
    requestComponents: [...(current.requestComponents ?? []), ...(next.requestComponents ?? [])],
    callBreakdown: [...(current.callBreakdown ?? []), ...nextCalls],
  };
}

type JobTrailState = {
  sourceMessageId?: number;
  steps: PersistedStreamStep[];
  lastFlushAt: number;
  dirty: boolean;
};

export function maxProcessAgentJobs(): number {
  const raw = process.env.WRITER_MAX_AGENT_JOBS?.trim();
  const parsed = raw ? Number(raw) : 16;
  if (!Number.isFinite(parsed)) return 16;
  return Math.min(64, Math.max(1, Math.round(parsed)));
}

export type StartAgentJobOptions = {
  store?: WriterStore;
  projectId?: string;
  kind?: string;
  promptPreview?: string;
};

export class BackgroundAgentJobs {
  private jobs = new Map<string, AgentJob>();
  private trails = new Map<string, JobTrailState>();
  private runners = new Map<string, Promise<void>>();
  private readonly maxJobs: number;
  private readonly maxEvents: number;

  constructor(private defaultStore?: WriterStore, maxJobs = maxProcessAgentJobs()) {
    this.maxJobs = maxJobs;
    this.maxEvents = maxJobEventBuffer();
  }

  /** Default store used when start() does not pass an explicit store. */
  setStore(store: WriterStore): void {
    this.defaultStore = store;
  }

  /** Process-level occupancy for health/metrics. */
  occupancy(): { active: number; max: number; totalTracked: number; maxEvents: number } {
    const active = [...this.jobs.values()].filter(job => job.status === "running").length;
    return { active, max: this.maxJobs, totalTracked: this.jobs.size, maxEvents: this.maxEvents };
  }

  start(
    sessionId: string,
    run: (signal: AbortSignal, emit: (event: AgentEvent) => void) => Promise<void>,
    options: StartAgentJobOptions = {},
  ): AgentJob {
    if (this.activeJob(sessionId)) {
      throw new ProviderError(
        "SESSION_JOB_ALREADY_RUNNING",
        "当前会话已有进行中的任务",
        { retryable: false },
      );
    }
    const activeCount = [...this.jobs.values()].filter(job => job.status === "running").length;
    if (activeCount >= this.maxJobs) {
      throw new ProviderError(
        "PROCESS_JOB_LIMIT",
        `进程级任务并发已满（${activeCount}/${this.maxJobs}），请等待其他任务结束或提高 WRITER_MAX_AGENT_JOBS`,
        { retryable: true },
      );
    }
    const store = options.store ?? this.defaultStore;
    const createdAt = new Date().toISOString();
    const job: AgentJob = {
      id: randomBytes(12).toString("base64url"),
      sessionId,
      status: "running",
      createdAt,
      updatedAt: createdAt,
      nextEventIndex: 0,
      events: [],
      controller: new AbortController(),
      listeners: new Set(),
      store,
      projectId: options.projectId,
      kind: options.kind ?? "agent",
      promptPreview: (options.promptPreview ?? "").slice(0, 500),
    };
    this.jobs.set(job.id, job);
    this.trails.set(job.id, { steps: [], lastFlushAt: 0, dirty: false });
    this.persistJob(job);
    const emit = (event: AgentEvent) => this.emit(job.id, event);
    // Defer so callers can finish `const job = start(...)` before the runner touches `job`.
    const runner = new Promise<void>((settle) => {
      queueMicrotask(() => {
        void run(job.controller.signal, emit).then(() => {
        if (job.status === "running") {
          // A runner that returns without a terminal event violated the Agent
          // protocol. Emit a real terminal event so SSE subscribers and persisted
          // step trails cannot be stranded in `running`.
          this.emit(job.id, {
            type: "error",
            message: "Agent 运行函数未产生终态事件，任务已安全终止，可从原指令续跑。",
          });
        }
        }).catch((error) => {
        if (job.status === "running") {
          const message = errorMessage(error);
          this.emit(job.id, {
            type: "error",
            message,
            ...(error instanceof ProviderError
              ? { code: error.code, retryable: error.retryable, action: error.action }
              : {}),
          });
          this.finish(job, "failed", message);
        }
        }).finally(settle);
      });
    });
    this.runners.set(job.id, runner);
    void runner.finally(() => this.runners.delete(job.id));
    return job;
  }

  activeJobs(sessionId?: string, projectId?: string): AgentJobInfo[] {
    return [...this.jobs.values()]
      .filter(job => job.status === "running"
        && (sessionId === undefined || job.sessionId === sessionId)
        && (projectId === undefined || job.projectId === projectId))
      .map(jobInfo);
  }

  activeJob(sessionId: string): AgentJobInfo | undefined {
    const job = [...this.jobs.values()].find(item => item.sessionId === sessionId && item.status === "running");
    return job ? jobInfo(job) : undefined;
  }

  /** Whether any in-memory runner still holds this store (blocks closing it). */
  hasRunningJobsForStore(store: WriterStore): boolean {
    return [...this.jobs.values()].some(job => job.status === "running" && job.store === store);
  }

  get(id: string): AgentJob | undefined {
    return this.jobs.get(id);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.controller.abort();
    return true;
  }

  /** Stop all current jobs before process shutdown. */
  async cancelAllAndWait(): Promise<void> {
    const active = [...this.jobs.values()].filter(job => job.status === "running");
    for (const job of active) job.controller.abort();
    await Promise.all(active.map(job => this.runners.get(job.id)).filter((runner): runner is Promise<void> => Boolean(runner)));
  }

  /** Drop finished in-memory jobs for a store that is about to close. Running jobs must be gone first. */
  dropJobsForStore(store: WriterStore): void {
    for (const [id, job] of this.jobs) {
      if (job.store !== store) continue;
      if (job.status === "running") continue;
      this.jobs.delete(id);
      this.trails.delete(id);
    }
  }

  /** Discard all in-memory job history (process shutdown). */
  clear(): void {
    this.jobs.clear();
    this.trails.clear();
  }

  snapshotAndSubscribe(id: string, listener: (event: StoredAgentEvent) => void): {
    events: StoredAgentEvent[];
    status: AgentJobStatus;
    unsubscribe: () => void;
  } | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const events = job.events.slice();
    const status = job.status;
    if (status !== "running") {
      return { events, status, unsubscribe: () => undefined };
    }
    job.listeners.add(listener);
    return {
      events,
      status,
      unsubscribe: () => job.listeners.delete(listener),
    };
  }

  private emit(id: string, event: AgentEvent): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const stored = { ...event, index: job.nextEventIndex } as StoredAgentEvent;
    job.nextEventIndex += 1;
    job.events.push(stored);
    while (job.events.length > this.maxEvents) job.events.shift();
    job.updatedAt = new Date().toISOString();
    if (event.type === "source_message" && typeof event.messageId === "number" && Number.isFinite(event.messageId)) {
      job.sourceMessageId = event.messageId;
      try {
        job.store?.patchBackgroundJob(job.id, { sourceMessageId: event.messageId });
      } catch { /* best-effort ledger */ }
    }
    this.applyTrailEvent(job, event);
    if (event.type === "done") this.finish(job, "completed");
    else if (event.type === "cancelled") this.finish(job, "cancelled");
    // Waiting for a user decision is a terminal SSE state, but it is not a
    // successful completion. Keep that distinction in the persisted Job
    // ledger so partial delivery and resumable revisions are visible.
    else if (event.type === "waiting_for_input") this.finish(job, "waiting");
    else if (event.type === "error") {
      const message = typeof (event as { message?: string }).message === "string"
        ? (event as { message: string }).message
        : "";
      this.finish(job, "failed", message);
    }
    for (const listener of job.listeners) listener(stored);
  }

  private persistJob(job: AgentJob): void {
    if (!job.store) return;
    try {
      job.store.upsertBackgroundJob({
        id: job.id,
        sessionId: job.sessionId,
        status: job.status,
        kind: job.kind,
        promptPreview: job.promptPreview,
        sourceMessageId: job.sourceMessageId,
        terminalMessage: job.terminalMessage,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    } catch {
      /* ledger is best-effort relative to the live runner */
    }
  }

  private applyTrailEvent(job: AgentJob, event: AgentEvent): void {
    const trail = this.trails.get(job.id);
    if (!trail) return;
    let forceFlush = false;
    if (event.type === "source_message" && typeof event.messageId === "number" && Number.isFinite(event.messageId)) {
      trail.sourceMessageId = event.messageId;
      trail.dirty = true;
      forceFlush = true;
    } else if (event.type === "step_start") {
      const id = event.step ?? trail.steps.length + 1;
      if (!trail.steps.some(step => step.id === id)) {
        trail.steps.push({ id, output: "", reasoning: "", tools: [], status: "running" });
        trail.dirty = true;
        forceFlush = true;
      }
    } else if (event.type === "text" && event.text) {
      const idx = activeTrailStepIndex(trail.steps);
      if (idx >= 0) {
        const key = event.channel === "reasoning" ? "reasoning" : "output";
        trail.steps[idx] = {
          ...trail.steps[idx],
          [key]: compactStepTrailText(trail.steps[idx][key] + event.text),
        };
        trail.dirty = true;
      }
    } else if (event.type === "tool" && event.name) {
      const idx = activeTrailStepIndex(trail.steps);
      if (idx >= 0) {
        trail.steps[idx] = {
          ...trail.steps[idx],
          tools: [...trail.steps[idx].tools, event.name],
        };
        trail.dirty = true;
      }
    } else if (event.type === "usage" && event.call) {
      const targetId = event.step;
      const callKind = typeof event.callKind === "string" && event.callKind.trim()
        ? event.callKind.trim()
        : "unspecified";
      let idx = targetId != null
        ? trail.steps.findIndex(step => step.id === targetId)
        : activeTrailStepIndex(trail.steps);
      if (idx < 0 && targetId != null) {
        trail.steps.push({
          id: targetId,
          output: "",
          reasoning: "",
          tools: [],
          status: "completed",
          usage: mergePersistedStepUsage(undefined, event.call, callKind),
        });
        trail.steps.sort((left, right) => left.id - right.id);
        trail.dirty = true;
      } else if (idx >= 0) {
        trail.steps[idx] = {
          ...trail.steps[idx],
          usage: mergePersistedStepUsage(trail.steps[idx].usage, event.call, callKind),
        };
        trail.dirty = true;
      }
    } else if (event.type === "step_done") {
      trail.steps = trail.steps.map(step => (
        step.id === event.step
          ? { ...step, status: "completed", output: compactStepTrailText(step.output), reasoning: compactStepTrailText(step.reasoning) }
          : step
      ));
      trail.dirty = true;
      forceFlush = true;
    } else if (event.type === "error") {
      trail.steps = trail.steps.map(step => (
        step.status === "running" ? { ...step, status: "failed" } : step
      ));
      trail.dirty = true;
      forceFlush = true;
    } else if (
      event.type === "done"
      || event.type === "cancelled"
      || event.type === "waiting_for_input"
    ) {
      trail.steps = trail.steps.map(step => (
        step.status === "running"
          ? { ...step, status: event.type === "cancelled" ? "failed" : "completed" }
          : step
      ));
      trail.dirty = true;
      forceFlush = true;
    }
    if (trail.dirty) this.flushTrail(job, forceFlush);
  }

  private flushTrail(job: AgentJob, force: boolean): void {
    const trail = this.trails.get(job.id);
    if (!trail?.dirty || !trail.sourceMessageId || !trail.steps.length || !job.store) return;
    const now = Date.now();
    if (!force && now - trail.lastFlushAt < STEP_TRAIL_FLUSH_MS) return;
    const steps = trail.steps.map(step => ({
      ...step,
      output: compactStepTrailText(step.output),
      reasoning: compactStepTrailText(step.reasoning),
    }));
    try {
      job.store.upsertMessageStepTrail(job.sessionId, trail.sourceMessageId, steps, { jobId: job.id });
      trail.lastFlushAt = now;
      trail.dirty = false;
    } catch {
      // Persistence is best-effort; live SSE remains authoritative while the job runs.
    }
  }

  private finish(job: AgentJob, status: Exclude<AgentJobStatus, "running">, terminalMessage = ""): void {
    if (job.status !== "running") return;
    job.status = status;
    job.updatedAt = new Date().toISOString();
    if (terminalMessage) job.terminalMessage = terminalMessage;
    this.flushTrail(job, true);
    this.trails.delete(job.id);
    if (job.store) {
      try {
        job.store.finishBackgroundJob(job.id, status, job.terminalMessage ?? terminalMessage);
      } catch { /* best-effort ledger */ }
    }
  }
}

function activeTrailStepIndex(steps: PersistedStreamStep[]): number {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].status === "running") return i;
  }
  return -1;
}

function jobInfo(job: AgentJob): AgentJobInfo {
  return {
    id: job.id,
    sessionId: job.sessionId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.projectId ? { projectId: job.projectId } : {}),
    kind: job.kind,
    ...(job.promptPreview ? { promptPreview: job.promptPreview } : {}),
    ...(job.sourceMessageId !== undefined ? { sourceMessageId: job.sourceMessageId } : {}),
    ...(job.terminalMessage ? { terminalMessage: job.terminalMessage } : {}),
  };
}

type ProjectHandle = {
  id: string;
  project: WriterProject;
  store: WriterStore;
  providers: ProviderManager;
};

type ProjectWorkspace = {
  realRoot: string;
};

function isInsideDirectory(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function workspaceProjectId(workspace: ProjectWorkspace, projectRoot: string): string {
  const realProjectRoot = realpathSync(projectRoot);
  if (!isInsideDirectory(workspace.realRoot, realProjectRoot)) {
    throw new Error("当前项目不在指定工作区内");
  }
  const path = relative(workspace.realRoot, realProjectRoot);
  if (path && path.includes(sep)) throw new Error("工作区仅支持切换根目录和直接子目录中的项目");
  return path || ".";
}

function isWorkspaceProjectId(value: string): boolean {
  if (value === ".") return true;
  return Boolean(value)
    && !value.includes("\0")
    && !value.includes("/")
    && !value.includes("\\")
    && value !== "."
    && value !== "..";
}

function resolveWorkspaceProject(workspace: ProjectWorkspace, id: string): WriterProject {
  if (!isWorkspaceProjectId(id)) throw new Error("项目标识无效");
  const candidate = id === "." ? workspace.realRoot : resolve(workspace.realRoot, id);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(candidate);
  } catch {
    throw new Error("项目不存在");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("项目目录无效");
  }
  const realProjectRoot = realpathSync(candidate);
  if (!isInsideDirectory(workspace.realRoot, realProjectRoot)) {
    throw new Error("项目目录超出工作区边界");
  }
  const relativePath = relative(workspace.realRoot, realProjectRoot);
  if (relativePath && relativePath.includes(sep)) {
    throw new Error("工作区仅支持切换根目录和直接子目录中的项目");
  }
  const marker = resolve(realProjectRoot, "writer.yaml");
  try {
    if (!statSync(marker).isFile() || !isInsideDirectory(realProjectRoot, realpathSync(marker))) {
      throw new Error("不是 Writer 项目");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "不是 Writer 项目") throw error;
    throw new Error("不是 Writer 项目");
  }
  return new WriterProject(realProjectRoot);
}

function projectSummary(workspace: ProjectWorkspace, project: WriterProject): ProjectSummary {
  return { id: workspaceProjectId(workspace, project.root), title: project.config().title };
}

function listWorkspaceProjects(workspace: ProjectWorkspace): ProjectSummary[] {
  const ids = [".", ...readdirSync(workspace.realRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN"))];
  return ids.flatMap((id) => {
    try {
      return [projectSummary(workspace, resolveWorkspaceProject(workspace, id))];
    } catch {
      return [];
    }
  });
}

export async function startWriterServer(options: {
  project: WriterProject;
  store: WriterStore;
  providers: ProviderManager;
  /** Workspace root containing the current project and its sibling projects. */
  workspaceRoot?: string;
  host?: string;
  port?: number;
  /** Disable API bearer-token checks only when explicitly requested by the CLI. */
  requireToken?: boolean;
  /** 是否在终端打印访问地址 / 二维码，默认 true。`--share` 时由 CLI 统一打印双端点二维码。 */
  announce?: boolean;
}): Promise<{
  url: string;
  origin: string;
  localOrigin: string;
  token: string;
  setPublicOrigin: (origin: string | null) => void;
  close: () => Promise<void>;
}> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4096;
  const requireToken = options.requireToken !== false;
  const workspaceRoot = resolve(options.workspaceRoot ?? dirname(options.project.root));
  let workspace: ProjectWorkspace;
  try {
    workspace = { realRoot: realpathSync(workspaceRoot) };
    if (!statSync(workspace.realRoot).isDirectory()) throw new Error("工作区不是目录");
    // Validate the initially opened project against the same boundary as every switch.
    resolveWorkspaceProject(workspace, workspaceProjectId(workspace, options.project.root));
  } catch (error) {
    throw new Error(`工作区无效：${errorMessage(error)}`);
  }
  let activeProject = projectSummary(workspace, options.project);
  let projectEpoch = 0;
  let switchingProject = false;
  let inFlightWorkspaceRequests = 0;
  const workspaceRequestWaiters = new Set<() => void>();
  const token = requireToken ? randomBytes(24).toString("base64url") : "";
  const localBypassToken = randomBytes(24).toString("base64url");
  let readonlyToken = "";
  const app = new Hono();
  const agentJobs = new BackgroundAgentJobs(options.store);
  // Open project handles stay alive while their jobs run across workspace switches.
  const projectHandles = new Map<string, ProjectHandle>();
  projectHandles.set(activeProject.id, {
    id: activeProject.id,
    project: options.project,
    store: options.store,
    providers: options.providers,
  });
  // Process restart cannot resume in-memory runners; ledger + trails are finalized in WriterStore ctor.
  try {
    options.store.finalizeOrphanedStepTrails("进程重启：未完成的任务已标记失败，可从原指令续跑。");
    options.store.finalizeOrphanedBackgroundJobs("进程重启：未完成的任务已标记失败，可从原指令续跑。");
    options.store.finalizeOrphanedAgentRuns("进程重启：运行状态已挂起，可从原指令续跑。");
  } catch {
    /* best-effort recovery */
  }
  const startedAt = Date.now();
  const styleExampleReviews = new Map<string, StyleExampleReviewState>();
  let publicOrigin: string | null | undefined;

  const releaseIdleProjectHandles = () => {
    for (const [id, handle] of projectHandles) {
      if (id === activeProject.id) continue;
      if (agentJobs.hasRunningJobsForStore(handle.store)) continue;
      agentJobs.dropJobsForStore(handle.store);
      try { handle.store.close(); } catch { /* ignore */ }
      projectHandles.delete(id);
    }
  };

  const scheduleStyleExampleReview = (template: StyleTemplate) => {
    // Reviews run asynchronously. Capture the resource set so a delayed review
    // cannot seed or report against whichever project happens to be active later.
    const project = options.project;
    const store = options.store;
    const providers = options.providers;
    const scheduledEpoch = projectEpoch;
    const contentHash = project.hash(template.exampleContent.trim());
    const running = styleExampleReviews.get(template.id);
    if (running?.status === "reviewing" && running.contentHash === contentHash) return;
    store.seedStyleExample(template, false);
    styleExampleReviews.set(template.id, { contentHash, status: "reviewing" });
    setImmediate(() => {
      void assertWritingExamplePassesGates(
        template.exampleContent,
        project,
        providers,
      ).then(() => {
        if (projectEpoch !== scheduledEpoch || options.project !== project) return;
        const current = project.styleTemplate(template.id);
        if (!current || project.hash(current.exampleContent.trim()) !== contentHash) return;
        store.seedStyleExample(current, true);
        styleExampleReviews.delete(template.id);
      }).catch((cause) => {
        if (projectEpoch !== scheduledEpoch || options.project !== project) return;
        const current = project.styleTemplate(template.id);
        if (!current || project.hash(current.exampleContent.trim()) !== contentHash) return;
        styleExampleReviews.set(template.id, {
          contentHash,
          status: "failed",
          error: errorMessage(cause),
        });
      });
    });
  };

  // CORS：手机页在局域网 HTTP 打开时，离开家后 API 会跨域打到 Cloudflare HTTPS。
  app.use("/api/*", async (context, next) => {
    const origin = context.req.header("origin");
    if (origin) {
      context.header("Access-Control-Allow-Origin", origin);
      context.header("Access-Control-Allow-Credentials", "true");
      context.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      context.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      context.header("Vary", "Origin");
    }
    if (context.req.method === "OPTIONS") return context.body(null, 204);
    await next();
  });

  app.use("/api/*", async (context, next) => {
    if (!requireToken) {
      await next();
      return;
    }
    // img/src 无法带 Authorization；附件 GET 允许 ?token=（仅 query，不写入 body）。
    const provided = context.req.header("authorization")?.replace(/^Bearer\s+/i, "")
      || context.req.query("token")
      || "";
    const localBypass = context.req.header("x-writer-local-access") ?? "";
    const ownerAccess = tokensEqual(provided, token) || tokensEqual(localBypass, localBypassToken);
    const readonlyAccess = Boolean(readonlyToken) && tokensEqual(provided, readonlyToken);
    if (!ownerAccess && !readonlyAccess) {
      return context.json({ error: "访问令牌无效或已失效" }, 401);
    }
    if (readonlyAccess && context.req.method !== "GET") {
      return context.json({ error: "此分享链接为只读模式，不能执行写入操作" }, 403);
    }
    await next();
  });

  const requestAccessMode = (authorization: string | undefined): "owner" | "readonly" => {
    const provided = authorization?.replace(/^Bearer\s+/i, "") ?? "";
    return readonlyToken && tokensEqual(provided, readonlyToken) ? "readonly" : "owner";
  };

  const switchProject = async (projectId: string): Promise<ProjectSummary> => {
    if (switchingProject) throw new Error("正在切换项目，请稍后再试");
    const nextProject = resolveWorkspaceProject(workspace, projectId);
    const nextSummary = projectSummary(workspace, nextProject);
    if (nextSummary.id === activeProject.id) return activeProject;
    switchingProject = true;
    try {
      if (inFlightWorkspaceRequests > 0) {
        await new Promise<void>((resolveIdle) => workspaceRequestWaiters.add(resolveIdle));
      }
      // Keep sibling projects open while their jobs still run; only swap the active handle.
      let nextHandle = projectHandles.get(nextSummary.id);
      if (!nextHandle) {
        const nextStore = new WriterStore(nextProject);
        const nextProviders = new ProviderManager(nextProject);
        nextHandle = {
          id: nextSummary.id,
          project: nextProject,
          store: nextStore,
          providers: nextProviders,
        };
        projectHandles.set(nextSummary.id, nextHandle);
      }
      options.project = nextHandle.project;
      options.store = nextHandle.store;
      options.providers = nextHandle.providers;
      agentJobs.setStore(nextHandle.store);
      styleExampleReviews.clear();
      readonlyToken = "";
      activeProject = nextSummary;
      projectEpoch += 1;
      releaseIdleProjectHandles();
      return activeProject;
    } finally {
      switchingProject = false;
    }
  };

  // A workspace switch is a resource transaction. Refuse requests that arrive
  // during its cancellation/close window instead of letting them target a stale DB.
  app.use("/api/*", async (context, next) => {
    const path = context.req.path;
    const switchRequest = path === "/api/projects/switch";
    const jobEventStream = /^\/api\/chat\/jobs\/[^/]+\/events$/.test(path);
    if (switchingProject && !switchRequest) {
      return context.json({ error: "正在切换项目，请稍后再试" }, 409);
    }
    // SSE only observes a job and may intentionally remain open. It never owns
    // project resources, so it must not delay the resource transaction.
    if (switchRequest || jobEventStream) {
      await next();
      return;
    }
    inFlightWorkspaceRequests += 1;
    try {
      await next();
    } finally {
      inFlightWorkspaceRequests -= 1;
      if (inFlightWorkspaceRequests === 0) {
        for (const resolveIdle of workspaceRequestWaiters) resolveIdle();
        workspaceRequestWaiters.clear();
      }
    }
  });

  app.get("/api/health", (context) => {
    let dbOk = true;
    let dbError: string | undefined;
    try {
      options.store.database.prepare("SELECT 1").get();
    } catch (error) {
      dbOk = false;
      dbError = errorMessage(error);
    }
    const jobs = agentJobs.occupancy();
    const transport = providerTransportMetrics();
    return context.json({
      ok: dbOk,
      ts: Date.now(),
      uptimeMs: Date.now() - startedAt,
      ...(publicOrigin !== undefined ? { publicOrigin } : {}),
      project: {
        root: options.project.root,
        title: options.project.config().title,
      },
      database: {
        ok: dbOk,
        ...(dbError ? { error: dbError } : {}),
      },
      jobs,
      provider: {
        gates: providerConcurrencySnapshot(),
        metrics: transport,
      },
    });
  });

  app.get("/api/metrics", (context) => {
    const jobs = agentJobs.occupancy();
    return context.json({
      ts: Date.now(),
      uptimeMs: Date.now() - startedAt,
      jobs,
      activeJobs: agentJobs.activeJobs(undefined, activeProject.id),
      openProjects: [...projectHandles.keys()],
      provider: {
        gates: providerConcurrencySnapshot(),
        metrics: providerTransportMetrics(),
      },
      errorCodes: providerErrorCodeMatrix(),
    });
  });

  app.post("/api/share/readonly", (context) => {
    if (!requireToken) {
      return context.json({ error: "当前服务未启用访问令牌，无法创建安全的只读分享链接" }, 400);
    }
    // Rotation is intentional: at most one read-only bearer link is valid.
    readonlyToken = randomBytes(24).toString("base64url");
    return context.json({ token: readonlyToken, accessMode: "readonly" as const });
  });

  app.delete("/api/share/readonly", (context) => {
    readonlyToken = "";
    return context.json({ ok: true });
  });

  app.get("/api/projects", (context) => context.json({
    currentProjectId: activeProject.id,
    projects: listWorkspaceProjects(workspace),
  }));

  app.post("/api/projects/switch", async (context) => {
    try {
      const body = await context.req.json<{ projectId?: unknown }>();
      if (typeof body.projectId !== "string") throw new Error("项目标识无效");
      const project = await switchProject(body.projectId);
      return context.json({ project, projectEpoch });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/state", (context) => {
    const accessMode = requestAccessMode(context.req.header("authorization"));
    const requested = context.req.query("session");
    const sessionId = requested && options.store.sessionExists(requested)
      ? requested
      : options.store.latestSession() ?? options.store.createSession();
    return context.json({
      accessMode,
      project: activeProject,
      projectEpoch,
      config: options.project.config(),
      documents: options.project.listDocuments(),
      documentFolders: options.project.listDocumentFolders(),
      hiddenDocuments: options.project.hiddenDocuments(),
      hiddenFolders: options.project.hiddenFolders(),
      sessions: options.store.listSessions(),
      sessionId,
      messages: options.store.withMessageVariantInfo(options.store.conversationMessagesBefore(sessionId, undefined, 50)
        .filter(isVisibleConversationMessage)
        .map(message => ({
          ...conversationMessageForWeb(options.store, message),
          content: stripDsmlText(message.content, "[工具调用已隐藏]"),
        }))),
      messagesHasMore: (() => {
        const visible = options.store.conversationMessagesBefore(sessionId, undefined, 50)
          .filter(isVisibleConversationMessage);
        const firstId = visible[0]?.id;
        const firstArchiveId = options.store.conversationStats(sessionId).firstMessageId;
        return firstId !== undefined && firstArchiveId !== undefined && firstId > firstArchiveId;
      })(),
      stepTrails: (() => {
        const visible = options.store.conversationMessagesBefore(sessionId, undefined, 50)
          .filter(isVisibleConversationMessage);
        const messageIds = visible.map(message => message.id);
        return options.store.messageStepTrails(sessionId, messageIds);
      })(),
      proposals: options.store.proposals(),
      changeSets: options.store.changeSets(),
      characters: options.store.characters(),
      roleplayInterlocutors: options.store.roleplayInterlocutors(),
      roleplayScenes: options.store.roleplayScenes(),
      activeRoleplay: options.store.activeRoleplay(sessionId) ?? null,
      roleplayMemory: options.store.roleplayMemory(sessionId) ?? null,
      roleplayMemoryFacts: options.store.roleplayMemoryFacts(sessionId),
      examples: options.store.writingExamples(),
      provider: options.providers.publicConfig(),
      providerCatalog: options.providers.catalog(),
      usage: options.store.usage(sessionId),
      todos: options.store.sessionTodos(sessionId),
      agentSettings: loadAgentSettings(options.project),
      proseGateRules: loadProseGateRules(options.project),
      authorPolicies: loadAuthorPolicies(options.project),
      authorPolicyFeedback: loadAuthorPolicyFeedback(options.project),
      writingMemory: options.store.writingMemory(sessionId, { limit: 200 }),
      projectInstructions: loadProjectInstructions(options.project)?.path ?? null,
      skills: listProjectSkills(options.project).map(skill => ({
        id: skill.id, name: skill.name, description: skill.description,
        manifest: skill.manifest,
        resources: skill.resources,
        validationErrors: skill.validationErrors,
      })),
      activeJobs: agentJobs.activeJobs(undefined, activeProject.id),
      characterDirectory: "characters/",
      styleTemplates: styleTemplatesForClient(options.project, options.store, styleExampleReviews),
    });
  });

  app.get("/api/document", (context) => {
    try {
      const path = context.req.query("path") ?? "";
      const content = options.project.read(path);
      const hash = options.project.hash(content);
      const qualityReport = options.store.documentQualityReport(path, hash);
      return context.json({ path, content, hash, ...(qualityReport ? { qualityReport } : {}) });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  // Browse-only version history (Web UI). Agent tools only read the live file.
  app.get("/api/document/versions", (context) => {
    try {
      const path = context.req.query("path") ?? "";
      return context.json({ path, versions: options.store.documentVersions(path) });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/chapters", (context) => {
    try {
      return context.json({ chapters: options.store.chapterSummaries() });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/document/version", (context) => {
    try {
      const path = context.req.query("path") ?? "";
      const id = Number(context.req.query("id"));
      if (!Number.isInteger(id) || id <= 0) throw new Error("版本编号无效");
      return context.json({ version: options.store.documentVersion(path, id) });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/document/version/restore", async (context) => {
    try {
      const body = await context.req.json<{ path: string; id: number; baseHash: string }>();
      const version = options.store.restoreDocumentVersion(body.path ?? "", Number(body.id), body.baseHash ?? "");
      return context.json({ version, hash: options.project.hash(options.project.read(body.path)) });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 409);
    }
  });

  app.get("/api/search", (context) => {
    const query = context.req.query("q") ?? "";
    return context.json({ results: query ? options.store.search(query, 12).filter(item => !options.project.isDocumentHidden(item.path)) : [] });
  });

  app.put("/api/document", async (context) => {
    try {
      const body = await context.req.json<{ path: string; content: string; baseHash: string }>();
      options.store.updateDocument(body.path, body.content, body.baseHash);
      return context.json({ ok: true, hash: options.project.hash(body.content) });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 409);
    }
  });

  app.delete("/api/document", async (context) => {
    try {
      const path = context.req.query("path") ?? "";
      if (!path) throw new Error("缺少文档路径");
      options.project.removeDocument(path);
      options.store.reindex();
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.put("/api/document/rename", async (context) => {
    try {
      const body = await context.req.json<{ fromPath: string; toPath: string; uniqueIfExists?: boolean }>();
      const path = options.store.renameDocument(body.fromPath, body.toPath, {
        uniqueIfExists: body.uniqueIfExists === true,
      });
      return context.json({
        ok: true,
        path,
        renamedDueToConflict: path !== body.toPath,
        hiddenDocuments: options.project.hiddenDocuments(),
      });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.put("/api/document/visibility", async (context) => {
    try {
      const body = await context.req.json<{ path: string; hidden: boolean }>();
      return context.json({ hiddenDocuments: options.project.setDocumentHidden(body.path, Boolean(body.hidden)) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.put("/api/folder/visibility", async (context) => {
    try {
      const body = await context.req.json<{ path: string; hidden: boolean }>();
      return context.json({ hiddenFolders: options.project.setFolderHidden(body.path, Boolean(body.hidden)) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/folder", async (context) => {
    try {
      const body = await context.req.json<{ path: string }>();
      const path = options.project.createFolder(body.path ?? "");
      return context.json({ ok: true, path });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.put("/api/folder/rename", async (context) => {
    try {
      const body = await context.req.json<{ fromPath: string; toPath: string; uniqueIfExists?: boolean }>();
      const path = options.store.renameFolder(body.fromPath, body.toPath, {
        uniqueIfExists: body.uniqueIfExists === true,
      });
      return context.json({
        ok: true,
        path,
        renamedDueToConflict: path !== body.toPath,
        documentFolders: options.project.listDocumentFolders(),
        hiddenDocuments: options.project.hiddenDocuments(),
        hiddenFolders: options.project.hiddenFolders(),
      });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.delete("/api/folder", async (context) => {
    try {
      const path = context.req.query("path") ?? "";
      if (!path) throw new Error("缺少文件夹路径");
      options.store.removeFolder(path);
      return context.json({
        ok: true,
        documentFolders: options.project.listDocumentFolders(),
        hiddenDocuments: options.project.hiddenDocuments(),
        hiddenFolders: options.project.hiddenFolders(),
      });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/document", async (context) => {
    try {
      const body = await context.req.json<{ path: string; content?: string }>();
      const path = (body.path ?? "").trim();
      if (!path) throw new Error("文档路径不能为空");
      if (!path.endsWith(".md")) throw new Error("文档路径必须以 .md 结尾");
      if (options.project.documentExists(path)) throw new Error("文档已存在");
      const content = body.content?.trim() || "# 新文档\n\n";
      options.project.writeRaw(path, content);
      options.store.reindex();
      return context.json({ ok: true, path, hash: options.project.hash(content) });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/session", async (context) => {
    const body: { title?: string } = await context.req.json<{ title?: string }>().catch(() => ({}));
    return context.json({ sessionId: options.store.createSession(body.title || "写作会话") });
  });

  app.get("/api/session/:id/attachments/:attachmentId", (context) => {
    try {
      const sessionId = context.req.param("id");
      const attachmentId = context.req.param("attachmentId");
      if (!options.store.sessionExists(sessionId)) throw new Error("Session not found");
      const resolved = options.store.resolveAttachmentBytes(sessionId, attachmentId);
      if (!resolved) return context.json({ error: "Attachment not found" }, 404);
      return new Response(new Uint8Array(resolved.bytes), {
        status: 200,
        headers: {
          "content-type": resolved.mimeType,
          "cache-control": "private, max-age=3600",
        },
      });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/session/:id/messages", (context) => {
    try {
      const sessionId = context.req.param("id");
      if (!options.store.sessionExists(sessionId)) throw new Error("Session not found");
      const rawBefore = context.req.query("before");
      const beforeId = rawBefore ? Number(rawBefore) : undefined;
      if (rawBefore && (!Number.isInteger(beforeId) || beforeId! < 1)) throw new Error("Invalid before cursor");
      const rawLimit = Number(context.req.query("limit") || 50);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.round(rawLimit))) : 50;
      const messages = options.store.withMessageVariantInfo(options.store.conversationMessagesBefore(sessionId, beforeId, limit)
        .filter(isVisibleConversationMessage)
        .map(message => ({
          ...conversationMessageForWeb(options.store, message),
          content: stripDsmlText(message.content, "[工具调用已隐藏]"),
        })));
      const firstArchiveId = options.store.conversationStats(sessionId).firstMessageId;
      const hasMore = Boolean(messages.length && firstArchiveId !== undefined && messages[0].id > firstArchiveId);
      return context.json({ messages, hasMore });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.put("/api/session/:id", async (context) => {
    try {
      const body: { title?: string } = await context.req.json<{ title?: string }>().catch(() => ({}));
      const title = body.title?.trim();
      if (!title) throw new Error("会话标题不能为空");
      options.store.renameSession(context.req.param("id"), title);
      return context.json({ ok: true });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.delete("/api/session/:id", async (context) => {
    try {
      const sessionId = context.req.param("id");
      if (agentJobs.activeJob(sessionId)) {
        return context.json({ error: "Cannot delete a session while its Agent job is running" }, 409);
      }
      options.store.deleteSession(sessionId);
      return context.json({ ok: true });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/sessions/batch-delete", async (context) => {
    try {
      const body = await context.req.json<{ ids?: string[]; keepSessionId?: string }>();
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
      if (ids.some(id => agentJobs.activeJob(id))) {
        return context.json({ error: "Cannot delete sessions while their Agent jobs are running" }, 409);
      }
      const result = options.store.deleteSessions(ids, body.keepSessionId);
      return context.json({ ok: true, ...result });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/characters", async (context) => {
    try {
      const body = await context.req.json<CharacterInput>();
      if (body.identity?.name && body.identity.name.length > 120) throw new Error("角色名称过长");
      return context.json({ character: options.store.saveCharacter(body) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/characters/import", async (context) => {
    try {
      const body = await context.req.json<{
        format?: unknown;
        version?: unknown;
        characters?: unknown;
        simpleCharacters?: unknown;
      }>();
      if (body.format !== "writer-agent-character-cards" || body.version !== 1) {
        throw new Error("不支持的角色卡文件格式或版本");
      }
      const result = options.store.importCharacterCards({
        characters: Array.isArray(body.characters) ? body.characters : [],
        simpleCharacters: Array.isArray(body.simpleCharacters) ? body.simpleCharacters : [],
      });
      return context.json({
        imported: {
          characters: result.characters.length,
          simpleCharacters: result.simpleCharacters.length,
        },
      });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/characters/competencies/summarize", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string; competency?: {
        name?: string; level?: string; description?: string;
        resources?: string[]; limitations?: string[]; costs?: string[];
      } }>();
      if (!body.competency || typeof body.competency !== "object") throw new Error("缺少能力内容");
      const summary = await summarizeCharacterCompetency({
        model: options.providers.summaryModelConfig(),
        competency: body.competency,
        signal: context.req.raw.signal,
        usageReporter: usageReporterForSession(options.store, body.sessionId),
      });
      return context.json({ summary });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/characters/summarize", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string; kind?: CharacterSummaryKind; source?: unknown }>();
      if (!body.kind) throw new Error("缺少摘要类型");
      const summary = await summarizeCharacterField({
        model: options.providers.summaryModelConfig(),
        kind: body.kind,
        source: body.source,
        signal: context.req.raw.signal,
        usageReporter: usageReporterForSession(options.store, body.sessionId),
      });
      return context.json({ summary });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.delete("/api/characters/:id", (context) => {
    try {
      const id = Number(context.req.param("id"));
      if (!Number.isInteger(id)) throw new Error("角色 ID 无效");
      options.store.deleteCharacter(id);
      return context.json({ ok: true });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.get("/api/style", (context) => {
    const activeStyleId = options.project.config().style || "";
    const activeTemplate = activeStyleId ? options.project.styleTemplate(activeStyleId) : undefined;
    return context.json({ templates: styleTemplatesForClient(options.project, options.store, styleExampleReviews), active: activeTemplate ?? null });
  });

  app.get("/api/prose-gates", (context) => {
    try {
      return context.json({ rules: loadProseGateRules(options.project) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.get("/api/author-policies", (context) => {
    try {
      return context.json({
        policies: loadAuthorPolicies(options.project),
        feedback: loadAuthorPolicyFeedback(options.project),
      });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/author-policies/compile", async (context) => {
    try {
      const body = await context.req.json<{ feedback?: unknown; scope?: unknown }>();
      if (typeof body.feedback !== "string" || !body.feedback.trim()) throw new Error("请先描述希望长期避免或保留的写作效果");
      const policy = await compileAuthorPolicyDraft({
        model: options.providers.modelConfig("inline"),
        feedback: body.feedback,
        scope: body.scope && typeof body.scope === "object" ? body.scope as Partial<AuthorPolicy["scope"]> : undefined,
        existingPolicies: loadAuthorPolicies(options.project).map(item => ({
          id: item.id, title: item.title, userIntent: item.userIntent,
        })),
      });
      return context.json({ policy });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/author-policies", async (context) => {
    try {
      const body = await context.req.json<AuthorPolicy>();
      const policy = upsertAuthorPolicy(options.project, body);
      return context.json({ policy, policies: loadAuthorPolicies(options.project), proseGateRules: loadProseGateRules(options.project) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/author-policies/migrate-legacy", (context) => {
    try {
      const migration = migrateProjectProseGatesToPolicies(options.project);
      return context.json({
        ...migration,
        policies: loadAuthorPolicies(options.project),
        proseGateRules: loadProseGateRules(options.project),
      });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.put("/api/author-policies/:id/status", async (context) => {
    try {
      const body = await context.req.json<{ status?: AuthorPolicyStatus }>();
      if (!body.status) throw new Error("status 不能为空");
      const policy = setAuthorPolicyStatus(options.project, context.req.param("id"), body.status);
      return context.json({ policy, policies: loadAuthorPolicies(options.project), proseGateRules: loadProseGateRules(options.project) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/author-policies/:id/feedback", async (context) => {
    try {
      const body = await context.req.json<{
        disposition?: AuthorPolicyFeedbackDisposition;
        issueId?: string;
        evidence?: string;
        note?: string;
      }>();
      if (!body.disposition) throw new Error("disposition 不能为空");
      const feedback = recordAuthorPolicyFeedback(options.project, {
        policyId: context.req.param("id"),
        disposition: body.disposition,
        issueId: body.issueId,
        evidence: body.evidence,
        note: body.note,
      });
      return context.json({ feedback, feedbackItems: loadAuthorPolicyFeedback(options.project) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.delete("/api/author-policies/:id", (context) => {
    try {
      const id = context.req.param("id");
      const removed = removeAuthorPolicy(options.project, id);
      return context.json({ removed, id, policies: loadAuthorPolicies(options.project), proseGateRules: loadProseGateRules(options.project) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/prose-gates", async (context) => {
    try {
      const body = await context.req.json<Partial<ProseGateRule>>();
      const rule = upsertProseGateRule(options.project, {
        id: typeof body.id === "string" ? body.id : "",
        label: typeof body.label === "string" ? body.label : undefined,
        instruction: typeof body.instruction === "string" ? body.instruction : "",
        revisionIntent: typeof body.revisionIntent === "string" ? body.revisionIntent : undefined,
        kind: body.kind === "style_preference" ? "style_preference" : body.kind === "hard_gate" ? "hard_gate" : undefined,
        severity: body.severity === "warn" ? "warn" : "block",
        enabled: body.enabled !== false,
        documentKinds: Array.isArray(body.documentKinds) ? body.documentKinds : undefined,
        pathPrefixes: Array.isArray(body.pathPrefixes) ? body.pathPrefixes : undefined,
        sourceFeedback: typeof body.sourceFeedback === "string" ? body.sourceFeedback : "",
      });
      return context.json({ rule, rules: loadProseGateRules(options.project) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.put("/api/prose-gates/:id/enabled", async (context) => {
    try {
      const body = await context.req.json<{ enabled?: boolean }>();
      if (typeof body.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
      const rule = setProseGateRuleEnabled(options.project, context.req.param("id"), body.enabled);
      return context.json({ rule, rules: loadProseGateRules(options.project) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.delete("/api/prose-gates/:id", (context) => {
    try {
      const id = context.req.param("id");
      const removed = removeProseGateRule(options.project, id);
      return context.json({ removed, id, rules: loadProseGateRules(options.project) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/style/templates", async (context) => {
    try {
      const body = await context.req.json<Partial<StyleTemplate>>();
      const candidate = normalizeStyleTemplate(body);
      const previous = options.project.styleTemplate(candidate.id);
      const exampleChanged = candidate.exampleContent.trim() !== (previous?.exampleContent.trim() ?? "");
      const requiresReview = Boolean(candidate.exampleContent.trim() && (!previous || exampleChanged));
      const template = options.project.saveStyleTemplate(candidate);
      const reviewed = !requiresReview && Boolean(previous && styleTemplateExampleReviewed(options.store, previous));
      options.store.seedStyleExample(template, reviewed, previous?.name);
      if (requiresReview) scheduleStyleExampleReview(template);
      else if (exampleChanged) styleExampleReviews.delete(template.id);
      return context.json({
        template,
        templates: styleTemplatesForClient(options.project, options.store, styleExampleReviews),
        provider: options.providers.publicConfig(),
        catalog: options.providers.catalog(),
      });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/style/templates/:id/review-example", async (context) => {
    try {
      const id = context.req.param("id").trim();
      const template = getStyleTemplate(id);
      if (!template) throw new Error("仅支持手动审核内置模板的默认范文");
      if (!template.exampleContent.trim()) throw new Error("该模板没有默认范文");
      if (!styleTemplateExampleReviewed(options.store, template)) {
        scheduleStyleExampleReview(template);
      }
      return context.json({
        template,
        templates: styleTemplatesForClient(options.project, options.store, styleExampleReviews),
      });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.put("/api/style", async (context) => {
    try {
      const body: { styleId?: string } = await context.req.json<{ styleId?: string }>().catch(() => ({}));
      const styleId = (body.styleId ?? "").trim();
      if (styleId) {
        const template = options.project.styleTemplate(styleId);
        if (!template) throw new Error(`未知的风格模板：${styleId}`);
        options.project.setStyle(styleId);
        if (template.exampleContent.trim()) {
          options.store.seedStyleExample(template, styleTemplateExampleReviewed(options.store, template));
        }
        return context.json({
          active: template,
          provider: options.providers.publicConfig(),
          catalog: options.providers.catalog(),
        });
      } else {
        options.project.setStyle("");
        return context.json({ active: null });
      }
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/examples", async (context) => {
    try {
      const body = await context.req.json<{ id?: number; title: string; category?: string; content: string; notes?: string }>();
      if (body.title?.length > 160) throw new Error("示例标题过长");
      if (body.content?.length > 50_000) throw new Error("单个写作示例不能超过 50000 字符");
      await assertWritingExamplePassesGates(
        body.content ?? "",
        options.project,
        options.providers,
      );
      return context.json({ example: options.store.saveWritingExample({
        id: body.id, title: body.title ?? "", category: body.category ?? "",
        content: body.content ?? "", notes: body.notes ?? "", gatePassed: true,
      }) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.delete("/api/examples/:id", (context) => {
    try {
      const id = Number(context.req.param("id"));
      if (!Number.isInteger(id)) throw new Error("示例 ID 无效");
      options.store.deleteWritingExample(id);
      return context.json({ ok: true });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.get("/api/provider", (context) => context.json({ provider: options.providers.publicConfig() }));

  app.put("/api/providers", async (context) => {
    try { const catalog = options.providers.saveProfile(await context.req.json()); return context.json({ catalog, provider: options.providers.publicConfig() }); }
    catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/providers/select", async (context) => {
    try { const body = await context.req.json<{ providerId: string; modelId: string }>(); return context.json({ provider: options.providers.select(body.providerId, body.modelId), catalog: options.providers.catalog() }); }
    catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/providers/assign", async (context) => {
    try { const body = await context.req.json<{ role: ModelUsageRole; providerId: string; modelId: string }>(); return context.json({ catalog: options.providers.assign(body.role, body.providerId, body.modelId), provider: options.providers.publicConfig() }); }
    catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.delete("/api/providers/:id", (context) => {
    try { return context.json({ catalog: options.providers.deleteProfile(context.req.param("id")) }); }
    catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.put("/api/provider", async (context) => {
    try {
      const body = await context.req.json<{
        provider: "deepseek" | "openai-compatible";
        baseUrl: string;
        model: string;
        apiKey?: string;
        pricing?: Partial<import("./types.js").TokenPricing>;
      }>();
      return context.json({ provider: options.providers.save(body) });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/provider/test", async (context) => {
    try { const body: { providerId?: string; modelId?: string } = await context.req.json<{ providerId?: string; modelId?: string }>().catch(() => ({})); return context.json(await options.providers.testConnection(body.providerId, body.modelId)); }
    catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/providers/scan", async (context) => {
    try { return context.json(await options.providers.scanModels(await context.req.json())); }
    catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.get("/api/agent-settings", (context) => {
    const settings = loadAgentSettings(options.project);
    const instructions = loadProjectInstructions(options.project);
    return context.json({
      permissionMode: settings.permissionMode,
      writingMode: settings.writingMode,
      characterEvolutionEnabled: settings.characterEvolutionEnabled,
      reviewFollowsProseModel: settings.reviewFollowsProseModel,
      stepBudgetMode: settings.stepBudgetMode,
      maxAgentSteps: settings.maxAgentSteps,
      scenePipeline: settings.scenePipeline,
      proseLength: settings.proseLength,
      proseGateTimeouts: settings.proseGateTimeouts,
      roleplay: settings.roleplay,
      instructionsPath: instructions?.path ?? null,
      skills: listProjectSkills(options.project).map(skill => ({
        id: skill.id, name: skill.name, description: skill.description, path: skill.path,
        manifest: skill.manifest,
        resources: skill.resources,
        validationErrors: skill.validationErrors,
      })),
    });
  });

  app.post("/api/agent-settings", async (context) => {
    try {
      const body = await context.req.json<{
        permissionMode?: string;
        writingMode?: string;
        characterEvolutionEnabled?: boolean;
        reviewFollowsProseModel?: boolean;
        stepBudgetMode?: string;
        maxAgentSteps?: number;
        scenePipeline?: Partial<ScenePipelineSettings>;
        proseLength?: Partial<ProseLengthSettings>;
        proseGateTimeouts?: Partial<ProseGateTimeoutSettings>;
        roleplay?: Partial<Omit<RoleplaySettings, "lengthBlockBudgets">> & {
          lengthBlockBudgets?: Partial<RoleplayLengthBlockBudgets>;
        };
      }>();
      if (body.permissionMode !== undefined && !isPermissionMode(body.permissionMode)) {
        return context.json({ error: "permissionMode 仅支持 ask、auto、plan" }, 400);
      }
      if (body.characterEvolutionEnabled !== undefined && typeof body.characterEvolutionEnabled !== "boolean") {
        return context.json({ error: "characterEvolutionEnabled 必须是布尔值" }, 400);
      }
      if (body.reviewFollowsProseModel !== undefined && typeof body.reviewFollowsProseModel !== "boolean") {
        return context.json({ error: "reviewFollowsProseModel 必须是布尔值" }, 400);
      }
      if (body.writingMode !== undefined && !isWritingExecutionMode(body.writingMode)) {
        return context.json({ error: "writingMode 仅支持 delegated、fast" }, 400);
      }
      if (body.stepBudgetMode !== undefined && !isAgentStepBudgetMode(body.stepBudgetMode)) {
        return context.json({ error: "stepBudgetMode 仅支持 hard、experimental" }, 400);
      }
      if (body.maxAgentSteps !== undefined && (
        !Number.isInteger(body.maxAgentSteps)
        || Number(body.maxAgentSteps) < MIN_AGENT_STEPS
        || Number(body.maxAgentSteps) > MAX_AGENT_STEPS
      )) {
        return context.json({
          error: `maxAgentSteps 须为 ${MIN_AGENT_STEPS}—${MAX_AGENT_STEPS} 的整数`,
        }, 400);
      }
      if (body.scenePipeline !== undefined) {
        if (body.scenePipeline.enabled !== undefined && typeof body.scenePipeline.enabled !== "boolean") {
          return context.json({ error: "scenePipeline.enabled 必须是布尔值" }, 400);
        }
        const values = [
          body.scenePipeline.preferredMinScenes,
          body.scenePipeline.preferredMaxScenes,
          body.scenePipeline.maxScenes,
        ].filter(value => value !== undefined);
        if (values.some(value => !Number.isInteger(value) || Number(value) < 1 || Number(value) > ABSOLUTE_MAX_SCENES)) {
          return context.json({ error: `场景链参数须为 1—${ABSOLUTE_MAX_SCENES} 的整数` }, 400);
        }
        const candidateCount = body.scenePipeline.candidateCount;
        if (candidateCount !== undefined && (!Number.isInteger(candidateCount) || Number(candidateCount) < 1 || Number(candidateCount) > MAX_SCENE_CANDIDATES)) {
          return context.json({ error: `candidateCount 须为 1—${MAX_SCENE_CANDIDATES} 的整数（1 = 关闭候选采样）` }, 400);
        }
        const notesMaxCharacters = body.scenePipeline.notesMaxCharacters;
        if (notesMaxCharacters !== undefined && (
          !Number.isInteger(notesMaxCharacters)
          || Number(notesMaxCharacters) < MIN_SCENE_NOTES_CHARACTERS
          || Number(notesMaxCharacters) > MAX_SCENE_NOTES_CHARACTERS
        )) {
          return context.json({
            error: `notesMaxCharacters 须为 ${MIN_SCENE_NOTES_CHARACTERS}—${MAX_SCENE_NOTES_CHARACTERS} 的整数`,
          }, 400);
        }
      }
      if (body.proseLength !== undefined) {
        const target = body.proseLength.chapterTargetCharacters;
        if (target !== undefined && (
          !Number.isInteger(target)
          || Number(target) < MIN_CHAPTER_TARGET_CHARACTERS
          || Number(target) > MAX_CHAPTER_TARGET_CHARACTERS
        )) {
          return context.json({
            error: `chapterTargetCharacters 须为 ${MIN_CHAPTER_TARGET_CHARACTERS}—${MAX_CHAPTER_TARGET_CHARACTERS} 的整数`,
          }, 400);
        }
        if (body.proseLength.enforceMinimum !== undefined && typeof body.proseLength.enforceMinimum !== "boolean") {
          return context.json({ error: "enforceMinimum 必须是布尔值" }, 400);
        }
        if (body.proseLength.mode !== undefined && (
          typeof body.proseLength.mode !== "string" || !isProseLengthMode(body.proseLength.mode)
        )) {
          return context.json({ error: "mode 仅支持 bounded、guidance" }, 400);
        }
      }
      if (body.proseGateTimeouts !== undefined) {
        const values = [body.proseGateTimeouts.primarySeconds, body.proseGateTimeouts.finalSeconds]
          .filter(value => value !== undefined);
        if (values.some(value => !Number.isInteger(value) || Number(value) < MIN_PROSE_GATE_TIMEOUT_SECONDS || Number(value) > MAX_PROSE_GATE_TIMEOUT_SECONDS)) {
          return context.json({ error: `proseGateTimeouts 须为 ${MIN_PROSE_GATE_TIMEOUT_SECONDS}—${MAX_PROSE_GATE_TIMEOUT_SECONDS} 秒的整数` }, 400);
        }
        if (body.proseGateTimeouts.primarySeconds !== undefined && body.proseGateTimeouts.finalSeconds !== undefined
          && body.proseGateTimeouts.finalSeconds < body.proseGateTimeouts.primarySeconds) {
          return context.json({ error: "最终审核超时不能小于首选审核超时" }, 400);
        }
      }
      if (body.roleplay !== undefined) {
        if (body.roleplay.performanceReasoningEffort !== undefined
          && (typeof body.roleplay.performanceReasoningEffort !== "string"
            || !isRoleplayReasoningChoice(body.roleplay.performanceReasoningEffort))) {
          return context.json({ error: "performanceReasoningEffort 须为 inherit 或 none/minimal/low/medium/high/xhigh" }, 400);
        }
        if (body.roleplay.jsonReasoningEffort !== undefined
          && (typeof body.roleplay.jsonReasoningEffort !== "string"
            || !isReasoningEffort(body.roleplay.jsonReasoningEffort))) {
          return context.json({ error: "jsonReasoningEffort 须为 none/minimal/low/medium/high/xhigh" }, 400);
        }
        if (body.roleplay.qualityFinalizeEnabled !== undefined
          && typeof body.roleplay.qualityFinalizeEnabled !== "boolean") {
          return context.json({ error: "qualityFinalizeEnabled 必须是布尔值" }, 400);
        }
        if (body.roleplay.recentMessages !== undefined && (
          !Number.isInteger(body.roleplay.recentMessages)
          || Number(body.roleplay.recentMessages) < MIN_ROLEPLAY_RECENT_MESSAGES
          || Number(body.roleplay.recentMessages) > MAX_ROLEPLAY_RECENT_MESSAGES
        )) {
          return context.json({
            error: `recentMessages 须为 ${MIN_ROLEPLAY_RECENT_MESSAGES}—${MAX_ROLEPLAY_RECENT_MESSAGES} 的整数`,
          }, 400);
        }
        for (const key of ["replyMaxOutputTokens", "jsonMaxOutputTokens"] as const) {
          const value = body.roleplay[key];
          if (value !== undefined && (
            !Number.isInteger(value)
            || Number(value) < MIN_ROLEPLAY_OUTPUT_TOKENS
            || Number(value) > MAX_ROLEPLAY_OUTPUT_TOKENS
          )) {
            return context.json({
              error: `${key} 须为 ${MIN_ROLEPLAY_OUTPUT_TOKENS}—${MAX_ROLEPLAY_OUTPUT_TOKENS} 的整数`,
            }, 400);
          }
        }
        if (body.roleplay.lengthBlockBudgets !== undefined) {
          if (!body.roleplay.lengthBlockBudgets || typeof body.roleplay.lengthBlockBudgets !== "object"
            || Array.isArray(body.roleplay.lengthBlockBudgets)) {
            return context.json({ error: "lengthBlockBudgets 须为对象" }, 400);
          }
          const budgets = body.roleplay.lengthBlockBudgets as Partial<RoleplayLengthBlockBudgets>;
          for (const level of ROLEPLAY_LENGTH_LEVEL_KEYS) {
            const entry = budgets[level];
            if (entry === undefined) continue;
            if (!entry || typeof entry !== "object") {
              return context.json({ error: `lengthBlockBudgets[${level}] 无效` }, 400);
            }
            for (const field of ["minBlocks", "maxBlocks"] as const) {
              const n = entry[field];
              if (n !== undefined && (
                !Number.isInteger(n)
                || Number(n) < MIN_ROLEPLAY_LENGTH_BLOCKS
                || Number(n) > MAX_ROLEPLAY_LENGTH_BLOCKS
              )) {
                return context.json({
                  error: `lengthBlockBudgets[${level}].${field} 须为 ${MIN_ROLEPLAY_LENGTH_BLOCKS}—${MAX_ROLEPLAY_LENGTH_BLOCKS} 的整数`,
                }, 400);
              }
            }
            if (entry.minBlocks !== undefined && entry.maxBlocks !== undefined
              && entry.maxBlocks < entry.minBlocks) {
              return context.json({
                error: `lengthBlockBudgets[${level}] 的 maxBlocks 不能小于 minBlocks`,
              }, 400);
            }
          }
        }
      }
      const settings = saveAgentSettings(options.project, {
        ...(body.permissionMode ? { permissionMode: body.permissionMode as PermissionMode } : {}),
        ...(body.writingMode ? { writingMode: body.writingMode as WritingExecutionMode } : {}),
        ...(typeof body.characterEvolutionEnabled === "boolean" ? { characterEvolutionEnabled: body.characterEvolutionEnabled } : {}),
        ...(typeof body.reviewFollowsProseModel === "boolean" ? { reviewFollowsProseModel: body.reviewFollowsProseModel } : {}),
        ...(body.stepBudgetMode ? { stepBudgetMode: body.stepBudgetMode as AgentStepBudgetMode } : {}),
        ...(body.maxAgentSteps !== undefined ? { maxAgentSteps: body.maxAgentSteps } : {}),
        ...(body.scenePipeline ? { scenePipeline: body.scenePipeline as ScenePipelineSettings } : {}),
        ...(body.proseLength ? { proseLength: body.proseLength } : {}),
        ...(body.proseGateTimeouts ? { proseGateTimeouts: body.proseGateTimeouts } : {}),
        ...(body.roleplay ? { roleplay: body.roleplay } : {}),
      });
      return context.json({
        permissionMode: settings.permissionMode,
        writingMode: settings.writingMode,
        characterEvolutionEnabled: settings.characterEvolutionEnabled,
        reviewFollowsProseModel: settings.reviewFollowsProseModel,
        stepBudgetMode: settings.stepBudgetMode,
        maxAgentSteps: settings.maxAgentSteps,
        scenePipeline: settings.scenePipeline,
        proseLength: settings.proseLength,
        proseGateTimeouts: settings.proseGateTimeouts,
        roleplay: settings.roleplay,
      });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/roleplay/interlocutor", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string; performer?: RoleplayParticipant; characterId?: number; request?: string }>();
      if (!body.performer && !Number.isInteger(body.characterId)) return context.json({ error: "角色扮演需要指定扮演者" }, 400);
      const interlocutor = await generateRoleplayInterlocutor({
        project: options.project,
        store: options.store,
        performer: body.performer,
        characterId: body.characterId,
        request: body.request ?? "",
        model: options.providers.modelConfig("roleplay"),
        usageReporter: usageReporterForSession(options.store, body.sessionId),
      });
      return context.json(interlocutor);
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/roleplay/interlocutors", async (context) => {
    try {
      const body = await context.req.json<RoleplayInterlocutor & { id?: number; targetCharacterId?: number }>();
      return context.json(options.store.saveRoleplayInterlocutor(body));
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/roleplay/interlocutors/:id", (context) => {
    try {
      const id = Number(context.req.param("id"));
      if (!Number.isInteger(id)) throw new Error("试演身份 ID 无效");
      options.store.deleteRoleplayInterlocutor(id);
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.put("/api/roleplay/scenes", async (context) => {
    try {
      const body = await context.req.json<Partial<RoleplayScene> & { name: string }>();
      return context.json(options.store.saveRoleplayScene(body));
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/roleplay/scenes/generate", async (context) => {
    try {
      const body = await context.req.json<{
        sessionId?: string;
        request?: string;
        performer?: RoleplayParticipant;
        identity?: RoleplayParticipant;
        currentScene?: RoleplayScene;
      }>();
      const active = body.sessionId ? options.store.activeRoleplay(body.sessionId) : undefined;
      const scene = await generateRoleplayScene({
        request: body.request ?? "",
        performer: body.performer ?? active?.performer,
        identity: body.identity ?? active?.identity,
        currentScene: body.currentScene ?? active?.scene,
        model: options.providers.modelConfig("roleplay"),
        usageReporter: usageReporterForSession(options.store, body.sessionId),
      });
      return context.json(scene);
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/roleplay/scenes/:id", (context) => {
    try {
      const id = Number(context.req.param("id"));
      if (!Number.isInteger(id)) throw new Error("场景 ID 无效");
      options.store.deleteRoleplayScene(id);
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.put("/api/roleplay/memory/facts", async (context) => {
    try {
      const body = await context.req.json<Partial<RoleplayMemoryFact> & { sessionId?: string; contextKey?: string; content: string }>();
      if (!body.sessionId || !options.store.sessionExists(body.sessionId)) throw new Error("会话不存在");
      const contextKey = body.contextKey?.trim() || options.store.roleplayMemory(body.sessionId)?.performerKey;
      if (!contextKey) throw new Error("当前没有可关联的角色扮演上下文");
      return context.json(options.store.saveRoleplayMemoryFact(body.sessionId, contextKey, body));
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/roleplay/memory/facts/:id", async (context) => {
    try {
      const sessionId = context.req.query("session") ?? "";
      const id = Number(context.req.param("id"));
      if (!sessionId || !Number.isInteger(id)) throw new Error("记忆参数无效");
      options.store.deleteRoleplayMemoryFact(sessionId, id);
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.put("/api/roleplay/state", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string; performer?: RoleplayParticipant; identity?: RoleplayParticipant; characterId?: number; interlocutor?: RoleplayInterlocutor; sceneId?: number; sceneIds?: number[]; sceneIndex?: number; contentRating?: RoleplayContentRating }>();
      if (!body.sessionId) throw new Error("缺少会话 ID");
      const performer = body.performer ?? body.characterId;
      const identity = body.identity ?? body.interlocutor;
      if (!performer) throw new Error("缺少扮演者角色卡");
      if (!identity) throw new Error("缺少当前身份角色卡");
      return context.json(options.store.saveActiveRoleplay(
        body.sessionId, performer, identity, body.sceneId, body.contentRating, body.sceneIds, body.sceneIndex,
      ));
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/roleplay/state/:sessionId", (context) => {
    try {
      const sessionId = context.req.param("sessionId");
      if (!options.store.sessionExists(sessionId)) throw new Error("会话不存在");
      // Exiting the UI mode must not discard the just-finished scene state: the
      // writing Agent uses it to turn the roleplay transcript into faithful prose.
      options.store.clearActiveRoleplay(sessionId, { preserveMemory: true });
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/roleplay/director-suggestions", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string }>();
      if (!body.sessionId || !options.store.sessionExists(body.sessionId)) throw new Error("会话不存在");
      const active = options.store.activeRoleplay(body.sessionId);
      if (!active) throw new Error("请先进入角色扮演");
      const suggestions = await recommendRoleplayDirectorActions({
        store: options.store,
        sessionId: body.sessionId,
        performer: active.performer,
        identity: active.identity,
        scene: active.scene,
        model: options.providers.modelConfig("roleplay"),
      });
      return context.json({ suggestions });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/roleplay/auto-reply", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string }>();
      if (!body.sessionId || !options.store.sessionExists(body.sessionId)) throw new Error("会话不存在");
      if (agentJobs.activeJob(body.sessionId)) throw new Error("当前会话仍有任务运行");
      const active = options.store.activeRoleplay(body.sessionId);
      if (!active) throw new Error("请先进入角色扮演");
      const reply = await generateRoleplayAutoReply({
        store: options.store,
        sessionId: body.sessionId,
        performer: active.performer,
        identity: active.identity,
        scene: active.scene,
        model: options.providers.modelConfig("roleplay"),
      });
      return context.json({ reply });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/chat", async (context) => {
    const body = await context.req.json<{ sessionId: string; prompt: string; mode?: WritingMode | "character" | "roleplay"; permissionMode?: string; performer?: RoleplayParticipant; identity?: RoleplayParticipant; characterId?: number; interlocutor?: RoleplayInterlocutor; scene?: RoleplayScene; inputMode?: RoleplayInputMode; opening?: boolean; performerAutoReply?: boolean; contextDocumentPaths?: string[]; characterScope?: number[]; simpleCharacterScope?: number[]; variantGroupId?: string; rerunDirections?: unknown; rerunControls?: unknown; perceptionOverride?: unknown; documentSelections?: Array<{ path: string; text: string }>; resumeInterrupted?: boolean; attachments?: Array<{ name?: string; mimeType: string; dataBase64: string }> }>();
    // A job keeps this exact resource set for its whole lifetime. Workspace
    // switching waits for these jobs before closing their store.
    const project = options.project;
    const store = options.store;
    const providers = options.providers;
    if (!body.sessionId || !store.sessionExists(body.sessionId)) {
      return context.json({ error: "Session not found" }, 404);
    }
    if (agentJobs.activeJob(body.sessionId)) {
      return context.json({
        error: "当前会话已有进行中的任务",
        code: "SESSION_JOB_ALREADY_RUNNING",
        retryable: false,
      }, 409);
    }
    const occupancy = agentJobs.occupancy();
    if (occupancy.active >= occupancy.max) {
      return context.json({
        error: `进程级任务并发已满（${occupancy.active}/${occupancy.max}）`,
        code: "PROCESS_JOB_LIMIT",
        retryable: true,
        action: "wait_and_retry",
      }, 429);
    }
    const chatAttachments = normalizeChatAttachments(body.attachments);
    // Model-initiated roleplay turns legitimately carry no player prompt.
    // Agent turns may be image-only when attachments are present.
    if (!body.prompt?.trim() && !chatAttachments.length && !(body.mode === "roleplay" && (body.opening || body.performerAutoReply))) {
      return context.json({ error: "写作指令不能为空" }, 400);
    }
    if (chatAttachments.length && (body.mode === "character" || body.mode === "roleplay")) {
      return context.json({ error: "目前仅写作 Agent 支持附图" }, 400);
    }
    const characterScope = Array.isArray(body.characterScope)
      ? [...new Set(body.characterScope.map(Number).filter(Number.isInteger))]
      : undefined;
    const simpleCharacterScope = Array.isArray(body.simpleCharacterScope)
      ? [...new Set(body.simpleCharacterScope.map(Number).filter(Number.isInteger))]
      : undefined;
    const variantGroupId = typeof body.variantGroupId === "string" && body.variantGroupId.length <= 100
      ? body.variantGroupId
      : undefined;
    const runtimeSettings = loadAgentSettings(project);
    const permissionMode = body.permissionMode && isPermissionMode(body.permissionMode)
      ? body.permissionMode
      : runtimeSettings.permissionMode;
    const jobLabel = body.mode === "character" ? "character" : body.mode === "roleplay" ? "roleplay" : "agent";
    let job: ReturnType<BackgroundAgentJobs["start"]>;
    try {
      job = agentJobs.start(body.sessionId, async (signal, emit) => {
      const stepDebug = createAgentStepDebugLogger({
        sessionId: body.sessionId,
        jobId: job.id,
        label: jobLabel,
      });
      if (stepDebugEnabled()) {
        process.stderr.write(
          `\n[WRITER STEP] ▸ job start session=${body.sessionId.slice(0, 8)} job=${job.id.slice(0, 8)} mode=${jobLabel}\n` +
          `[WRITER STEP] prompt: ${body.prompt.trim().slice(0, 500)}${body.prompt.trim().length > 500 ? "…" : ""}\n`,
        );
      }
      try {
        // Writing/character turns defer terminal success until auto-title finishes so
        // /api/state refresh sees the new title. Roleplay releases its deferred final
        // output before the cosmetic title call below.
        // Roleplay currently emits its reply as one complete output event (not token chunks),
        // followed by best-effort memory bookkeeping. Keep that final output beside `done`
        // so the composer cannot remain on Stop after the entire visible reply has arrived.
        const deferred: AgentEvent[] = [];
        const onEvent = (event: AgentEvent) => {
          stepDebug.onEvent(event);
          const finalRoleplayOutput = body.mode === "roleplay"
            && event.type === "text"
            && event.channel === "output";
          if (finalRoleplayOutput || event.type === "done" || event.type === "waiting_for_input") {
            deferred.push(event);
            return;
          }
          emit(event);
        };
        if (body.mode === "character") {
          await updateCharacterFromConversation({
            model: providers.modelConfig("agent"), summaryModel: providers.summaryModelConfig(), store,
            sessionId: body.sessionId, instruction: body.prompt,
            characterId: Number.isInteger(body.characterId) ? body.characterId : undefined,
            jobId: job.id,
            allowedDocumentPaths: characterContextDocumentPaths(project, body.contextDocumentPaths),
            signal, onEvent,
          });
        } else if (body.mode === "roleplay") {
          if (!body.performer && !Number.isInteger(body.characterId)) throw new Error("角色扮演需要指定扮演者");
          await runRoleplayChat({
            project,
            store,
            sessionId: body.sessionId,
            performer: body.performer,
            characterId: body.characterId,
            identity: body.identity,
            interlocutor: body.interlocutor,
            scene: body.scene?.id ? store.roleplayScenes().find(item => item.id === body.scene!.id) : undefined,
            prompt: body.prompt,
            jobId: job.id,
            inputMode: body.inputMode === "director" ? "director" : "dialogue",
            opening: body.opening === true,
            performerAutoReply: body.performerAutoReply === true,
            variantGroupId,
            rerunDirections: normalizeRoleplayRerunDirections(body.rerunDirections),
            rerunControls: normalizeRoleplayRerunControls(body.rerunControls),
            ...(body.perceptionOverride
              ? { perceptionOverride: parseRoleplayPerception(JSON.stringify(body.perceptionOverride)) }
              : {}),
            model: providers.modelConfig("roleplay"),
            perceptionModel: providers.modelConfig("roleplay_perception"),
            qualityModel: providers.modelConfig("roleplay_quality"),
            summarizer: providers.modelConfig("roleplay_memory"),
            signal,
            onEvent,
          });
        } else {
          await runAgent({
            project,
            store,
            sessionId: body.sessionId,
            jobId: job.id,
            prompt: body.prompt,
            ...(chatAttachments.length ? { attachments: chatAttachments } : {}),
            variantGroupId,
            selectedDocumentBlocks: body.documentSelections,
            resumeInterrupted: body.resumeInterrupted === true,
            characterScope,
            simpleCharacterScope,
            permissionMode,
            scenePipelineSettings: runtimeSettings.scenePipeline,
            models: {
              agent: providers.modelConfig("agent"), image: providers.imageModelConfig(), writer: providers.modelConfig("writer"),
              inline: providers.modelConfig("inline"), reviewer: providers.modelConfig("reviewer"),
              summarizer: providers.summaryModelConfig(),
            },
            signal,
            onEvent,
          });
        }
        const completedTurn = deferred.length > 0;
        // Roleplay title generation is cosmetic and must not keep the composer in
        // Stop after the reply and its bounded memory bookkeeping are complete.
        if (body.mode === "roleplay") {
          for (const event of deferred.splice(0)) {
            stepDebug.onEvent(event);
            emit(event);
          }
        }
        // Auto-title once after a successful turn (never overwrites custom titles; only runs once).
        if (!signal.aborted && completedTurn) {
          try {
            const titleSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
            await maybeAutoTitleSession({
              store,
              model: providers.summaryModelConfig(),
              sessionId: body.sessionId,
              signal: titleSignal,
              usageReporter: (callModel, callUsage, meta) => {
                emit(buildRecordedUsageEvent(store, body.sessionId, callModel, callUsage, {
                  ...meta,
                  jobId: job.id,
                }));
              },
            });
          } catch { /* title is best-effort */ }
        }
        for (const event of deferred) {
          stepDebug.onEvent(event);
          emit(event);
        }
      } catch (error) {
        const message = errorMessage(error);
        stepDebug.onEvent({ type: "error", message });
        emit({
          type: "error",
          message,
          ...(error instanceof ProviderError
            ? { code: error.code, retryable: error.retryable, action: error.action }
            : {}),
        });
      } finally {
        stepDebug.flush();
      }
    }, {
      store,
      projectId: activeProject.id,
      kind: jobLabel,
      promptPreview: (body.prompt ?? "").trim().slice(0, 500),
    });
    } catch (error) {
      if (error instanceof ProviderError) {
        const status = error.code === "SESSION_JOB_ALREADY_RUNNING"
          ? 409
          : error.code === "PROCESS_JOB_LIMIT"
            ? 429
            : 400;
        return context.json({
          error: error.message,
          code: error.code,
          retryable: error.retryable,
          action: error.action,
        }, status);
      }
      return context.json({ error: errorMessage(error) }, 400);
    }
    return context.json({ jobId: job.id, job: jobInfo(job) });
  });

  app.get("/api/chat/jobs", (context) => {
    const sessionId = context.req.query("session") || undefined;
    const activeJobs = agentJobs.activeJobs(sessionId, activeProject.id);
    // Durable ledger: failed/interrupted jobs from the last process for one-click resume UX.
    let recentJobs: ReturnType<WriterStore["listBackgroundJobs"]> = [];
    try {
      recentJobs = options.store.listBackgroundJobs({
        sessionId,
        statuses: ["failed", "cancelled", "completed"],
        limit: 30,
      });
    } catch { /* ignore */ }
    return context.json({ activeJobs, recentJobs });
  });

  app.post("/api/backup", async (context) => {
    try {
      const body = await context.req.json().catch(() => ({})) as { outputDir?: unknown };
      const outputDir = typeof body.outputDir === "string" && body.outputDir.trim()
        ? body.outputDir.trim()
        : undefined;
      const result = await createProjectBackup(options.project.root, {
        ...(outputDir ? { outputDir } : {}),
        title: options.project.config().title,
      });
      return context.json({
        path: result.path,
        fileCount: result.manifest.fileCount,
        totalBytes: result.manifest.totalBytes,
        createdAt: result.manifest.createdAt,
        sha256: result.manifest.sha256,
      });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/chat/jobs/:id/events", (context) => {
    const job = agentJobs.get(context.req.param("id"));
    if (!job) return context.json({ error: "Agent job not found" }, 404);
    return streamSSE(context, async (stream) => {
      let closed = false;
      const write = async (event: StoredAgentEvent) => {
        if (closed) return;
        await stream.writeSSE({ data: JSON.stringify(event), event: event.type });
      };
      let writeChain = Promise.resolve();
      let finished = false;
      let resolveFinished: () => void = () => undefined;
      let unsubscribe: () => void = () => undefined;
      const finishAfterQueuedWrites = () => {
        if (finished) return;
        finished = true;
        void writeChain.then(resolveFinished, resolveFinished);
      };
      const enqueue = (event: StoredAgentEvent) => {
        // Writes are serialized so replayed and live events stay in index order.
        writeChain = writeChain.then(() => write(event)).catch(() => {
          closed = true;
        });
        if (event.type === "done" || event.type === "cancelled" || event.type === "error" || event.type === "waiting_for_input") {
          unsubscribe();
          finishAfterQueuedWrites();
        }
      };

      // Snapshot and listener registration happen synchronously. An event emitted while
      // the snapshot is being written is queued behind it instead of falling through a gap.
      const subscription = agentJobs.snapshotAndSubscribe(job.id, enqueue);
      if (!subscription) return;
      unsubscribe = subscription.unsubscribe;
      for (const event of subscription.events) enqueue(event);
      if (subscription.status !== "running") {
        await writeChain;
        return;
      }

      await new Promise<void>((resolve) => {
        resolveFinished = resolve;
        const abort = () => {
          closed = true;
          unsubscribe();
          finishAfterQueuedWrites();
        };
        if (context.req.raw.signal.aborted) abort();
        else context.req.raw.signal.addEventListener("abort", abort, { once: true });
      });
    });
  });

  app.post("/api/chat/jobs/:id/cancel", (context) => {
    return context.json({ ok: agentJobs.cancel(context.req.param("id")) });
  });

  app.post("/api/route", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string; prompt: string; activePath?: string; hasSelection?: boolean }>();
      const conversation = body.sessionId && options.store.sessionExists(body.sessionId)
        ? options.store.messages(body.sessionId, 12)
          .filter((item): item is typeof item & { role: "user" | "assistant" } => item.role === "user" || item.role === "assistant")
          .map(item => ({ role: item.role, content: item.content }))
        : [];
      const suggestions = await suggestActions({
        model: options.providers.modelConfig("agent"), request: body.prompt ?? "",
        conversation,
        documents: options.project.listDocuments().filter(path => !options.project.isDocumentHidden(path)),
        activePath: body.activePath && !options.project.isDocumentHidden(body.activePath) ? body.activePath : undefined,
        hasSelection: Boolean(body.hasSelection),
        characters: options.store.characters().map(item => ({ id: item.id, name: item.identity.name, aliases: item.identity.aliases })),
        signal: context.req.raw.signal,
        usageReporter: usageReporterForSession(options.store, body.sessionId),
      });
      return context.json({ suggestions });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/characters/generate", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string; description: string; existing?: Record<string, unknown> }>();
      const character = await generateCharacter({
        model: options.providers.modelConfig("agent"), description: body.description ?? "",
        existing: body.existing, signal: context.req.raw.signal,
        usageReporter: usageReporterForSession(options.store, body.sessionId),
      });
      return context.json({ character });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/proposals/:id/:action", async (context) => {
    try {
      const id = Number(context.req.param("id"));
      const action = context.req.param("action");
      if (!Number.isInteger(id) || !["accept", "reject"].includes(action)) throw new Error("审批参数无效");
      const proposal = action === "accept" ? options.store.acceptProposal(id) : options.store.rejectProposal(id);
      const shouldIndexMemory = action === "accept" && Boolean(proposal.sourceMessageId)
        && ["chapter", "side"].includes(documentKind(proposal.path));
      if (shouldIndexMemory) {
        scheduleAcceptedWritingMemoryIndexing(() => indexAcceptedWritingMemory({
            project: options.project,
            store: options.store,
            providers: options.providers,
            path: proposal.path,
            beforeContent: proposal.beforeContent,
            afterContent: proposal.afterContent,
            sourceProposalId: proposal.id,
            sessionId: proposal.sessionId,
            sourceMessageId: proposal.sourceMessageId!,
        }));
      }
      return context.json({ proposal, writingMemory: 0, writingMemoryPending: shouldIndexMemory });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 409);
    }
  });

  app.post("/api/change-sets/:id/:action", async (context) => {
    try {
      const id = Number(context.req.param("id"));
      const action = context.req.param("action");
      if (!Number.isInteger(id) || !["accept", "reject", "undo", "redo"].includes(action)) throw new Error("change set 审批参数无效");
      const changeSet = action === "accept" ? options.store.acceptChangeSet(id)
        : action === "reject" ? options.store.rejectChangeSet(id)
          : action === "undo" ? options.store.undoChangeSet(id)
            : options.store.redoChangeSet(id);
      return context.json({ changeSet });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 409);
    }
  });

  app.post("/api/undo", (context) => {
    try {
      const sessionId = context.req.query("session") || undefined;
      return context.json({ path: options.store.undo(sessionId) });
    }
    catch (error) { return context.json({ error: errorMessage(error) }, 409); }
  });

  app.post("/api/redo", (context) => {
    try {
      const sessionId = context.req.query("session") || undefined;
      return context.json({ path: options.store.redo(sessionId) });
    }
    catch (error) { return context.json({ error: errorMessage(error) }, 409); }
  });

  app.post("/api/message", async (context) => {
    try {
      const body = await context.req.json<{ sessionId: string; role: "user" | "assistant"; content: string }>();
      if (!body.sessionId || !body.content?.trim()) throw new Error("参数无效");
      if (body.role !== "user" && body.role !== "assistant") throw new Error("消息角色无效");
      options.store.addMessage(body.sessionId, body.role, body.content.trim());
      return context.json({ ok: true });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.delete("/api/messages", (context) => {
    try {
      const sessionId = context.req.query("session") ?? "";
      const targetId = Number(context.req.query("target"));
      const keepChanges = context.req.query("keepChanges") === "1" || context.req.query("keepChanges") === "true";
      if (!sessionId || !Number.isInteger(targetId) || targetId < 0) throw new Error("参数无效");
      return context.json(options.store.rewindFromMessage(sessionId, targetId, { keepChanges }));
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/messages/:id/rerun", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string; keepChanges?: boolean }>();
      const sessionId = body.sessionId ?? "";
      const targetId = Number(context.req.param("id"));
      if (!sessionId || !Number.isInteger(targetId) || targetId < 1) throw new Error("参数无效");
      return context.json(options.store.prepareMessageRerun(sessionId, targetId, {
        keepChanges: Boolean(body.keepChanges),
      }));
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/messages/:id/resume", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string }>();
      const sessionId = body.sessionId ?? "";
      const targetId = Number(context.req.param("id"));
      if (!sessionId || !Number.isInteger(targetId) || targetId < 1) throw new Error("参数无效");
      return context.json(options.store.interruptedAgentResumePrompt(sessionId, targetId));
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.put("/api/roleplay/messages/:id/perception", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string; perception?: unknown }>();
      const sessionId = body.sessionId ?? "";
      const messageId = Number(context.req.param("id"));
      if (!sessionId || !Number.isInteger(messageId) || messageId < 1) throw new Error("参数无效");
      const perception = parseRoleplayPerception(JSON.stringify(body.perception));
      options.store.saveRoleplayPerception(sessionId, messageId, serializeRoleplayPerception(perception));
      return context.json({
        perception,
        display: storedRoleplayPerceptionForDisplay(serializeRoleplayPerception(perception)),
      });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.get("/api/roleplay/branches", (context) => {
    try {
      const sessionId = context.req.query("session") ?? "";
      const groupId = context.req.query("group")?.trim() || undefined;
      if (!sessionId) throw new Error("参数无效");
      return context.json({ branches: options.store.roleplayBranches(sessionId, groupId) });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/roleplay/branches/:id/activate", async (context) => {
    try {
      const body = await context.req.json<{ sessionId?: string }>();
      const sessionId = body.sessionId ?? "";
      if (!sessionId) throw new Error("参数无效");
      if (agentJobs.activeJob(sessionId)) return context.json({ error: "角色演出运行期间不能切换分支" }, 409);
      return context.json(options.store.activateRoleplayBranch(sessionId, context.req.param("id")));
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.get("/api/session/:id/context-graph", (context) => {
    try {
      const sessionId = context.req.param("id");
      if (!sessionId || !options.store.sessionExists(sessionId)) throw new Error("会话不存在");
      const requested = Number(context.req.query("limit"));
      const limit = Number.isFinite(requested) && requested > 0 ? Math.min(2000, Math.max(1, Math.floor(requested))) : undefined;
      return context.json(options.store.contextGraph(sessionId, limit ? { limit } : undefined));
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

    app.get("/api/messages/:id/versions", (context) => {
    try {
      const sessionId = context.req.query("session") ?? "";
      const messageId = Number(context.req.param("id"));
      if (!sessionId || !Number.isInteger(messageId) || messageId < 1) throw new Error("参数无效");
      const bundle = options.store.messageVersions(sessionId, messageId);
      return context.json({
        ...bundle,
        versions: bundle.versions.map(version => ({
          ...version,
          content: stripDsmlText(version.content, "[工具调用已隐藏]"),
        })),
      });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.get("/api/export", (context) => {
    const format = context.req.query("format");
    if (format !== "md" && format !== "txt") return context.json({ error: "导出格式仅支持 md 或 txt" }, 400);
    return context.body(options.project.export(format), 200, {
      "content-type": format === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="export.${format}"`,
    });
  });

  app.get("/health", (context) => context.json({
    ok: true,
    ts: Date.now(),
    uptimeMs: Date.now() - startedAt,
    jobs: agentJobs.occupancy(),
  }));
  app.get("/manifest.webmanifest", (context) => context.json({
    name: "Writer Agent",
    short_name: "Writer",
    start_url: "/",
    display: "standalone",
    background_color: "#f3efe7",
    theme_color: "#25352d",
    icons: [],
  }));
  app.get("/sw.js", (context) => context.text(`
    const CACHE='writer-shell-v1';
    self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/']))));
    self.addEventListener('fetch',e=>{if(e.request.method==='GET'&&!e.request.url.includes('/api/'))e.respondWith(fetch(e.request).catch(()=>caches.match(e.request))) });
  `, 200, { "content-type": "application/javascript" }));

  const webRoot = resolveWebRoot(import.meta.url);
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("/*", serveStatic({ path: resolve(webRoot, "index.html") }));

  const localFetch = (request: Request) => {
    const headers = new Headers(request.headers);
    headers.set("x-writer-local-access", localBypassToken);
    return app.fetch(new Request(request, { headers }));
  };
  const primaryIsLocal = host === "127.0.0.1";
  const server = serve({ fetch: primaryIsLocal ? localFetch : app.fetch, hostname: host, port });
  await waitForListening(server);

  let localServer: ServerType | undefined;
  try {
    if (!primaryIsLocal) {
      const startedLocalServer = serve({ fetch: localFetch, hostname: "127.0.0.1", port: 0 });
      await waitForListening(startedLocalServer);
      localServer = startedLocalServer;
    }
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  const address = host === "0.0.0.0" ? findLanAddress() : host;
  const boundPort = (server.address() as AddressInfo).port;
  const origin = `http://${address}:${boundPort}`;
  const protectedUrl = requireToken ? `${origin}/#token=${token}` : origin;
  const localPort = localServer ? (localServer.address() as AddressInfo).port : boundPort;
  const localOrigin = `http://127.0.0.1:${localPort}`;
  const url = localOrigin;
  process.stdout.write(requireToken
    ? `Writer Web（本机免令牌）：${localOrigin}\n`
    : `Writer Web（未启用令牌）：${localOrigin}\n`);
  if (options.announce !== false) {
    if (host === "0.0.0.0") {
      process.stdout.write(`\n手机访问：${protectedUrl}\n`);
      process.stdout.write(await QRCode.toString(protectedUrl, { type: "terminal", small: true }));
    } else if (!primaryIsLocal) {
      process.stdout.write(`Writer Web：${protectedUrl}\n`);
    }
  }
  return {
    url,
    origin,
    localOrigin,
    token,
    setPublicOrigin(nextOrigin) {
      if (nextOrigin === null) {
        publicOrigin = null;
        return;
      }
      // Quick Tunnel (*.trycloudflare.com) and Named Tunnel fixed hostnames.
      try {
        const parsed = new URL(nextOrigin);
        const host = parsed.hostname.toLowerCase();
        if (parsed.protocol !== "https:"
          || !host
          || host === "localhost"
          || host === "127.0.0.1"
          || host === "[::1]") {
          throw new Error("invalid");
        }
        publicOrigin = parsed.origin;
      } catch {
        throw new Error("Cloudflare 公网地址无效");
      }
    },
    close: async () => {
      await agentJobs.cancelAllAndWait();
      agentJobs.clear();
      try {
        await Promise.all([closeServer(server), ...(localServer ? [closeServer(localServer)] : [])]);
      } finally {
        for (const handle of projectHandles.values()) {
          try { handle.store.close(); } catch { /* ignore */ }
        }
        projectHandles.clear();
      }
    },
  };
}

export function resolveWebRoot(moduleUrl: string): string {
  // Both `tsx src/cli.ts` and `node dist/cli.js` must publish Vite's compiled
  // assets. Serving src/web exposes main.tsx directly and fails on fresh origins.
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "dist", "web");
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function waitForListening(server: ServerType): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    if (server.listening) return resolveReady();
    const onListening = () => {
      server.off("error", onError);
      resolveReady();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectReady(new Error(`Web 服务启动失败：${error.message}`));
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
}

function findLanAddress(): string {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, group]) =>
    (group ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => ({ name, address: address.address })),
  );
  if (candidates.length === 0) return "127.0.0.1";

  const virtualAdapter = /(?:vethernet|wsl|hyper-v|docker|vmware|virtualbox|vbox|tailscale|zerotier|vpn|tunnel|tap|loopback)/i;
  const physicalAdapter = /(?:wi-?fi|wireless|wlan|ethernet|eth\d|en\d|enp\w*|ens\w*)/i;
  const privateAddress = (address: string) =>
    /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(address);

  candidates.sort((left, right) => {
    const score = (candidate: { name: string; address: string }) =>
      (virtualAdapter.test(candidate.name) ? -100 : 0)
      + (physicalAdapter.test(candidate.name) ? 20 : 0)
      + (privateAddress(candidate.address) ? 10 : 0);
    return score(right) - score(left);
  });
  return candidates[0].address;
}

function characterContextDocumentPaths(project: WriterProject, paths?: string[]): string[] {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths)].filter(path => typeof path === "string" && project.documentExists(path) && !project.isDocumentHidden(path)).slice(0, 5);
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause === undefined) return error.message;
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const code = typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code?: unknown }).code ?? "")
    : "";
  const detail = code && !causeMessage.includes(code) ? `${code}: ${causeMessage}` : causeMessage;
  return detail && !error.message.includes(detail) ? `${error.message}（${detail}）` : error.message;
}

async function assertWritingExamplePassesGates(
  content: string,
  project: WriterProject,
  providers: ProviderManager,
): Promise<void> {
  const prose = content.trim();
  if (!prose) throw new Error("范文正文不能为空");
  const issues = await proseStyleGateIssues("", prose, {
    proseAdjudicator: { model: providers.modelConfig("inline") },
    proseGateRules: loadProseGateRules(project),
  }, {
    reviewWholeText: true,
    failClosed: true,
    targetKind: "writing_example",
  });
  const blocked = proseStyleIssuesError(issues);
  if (blocked) throw new Error(`范文未通过正文门控：${blocked}`);
}

function usageReporterForSession(store: WriterStore, sessionId?: string): ModelUsageReporter | undefined {
  if (!sessionId || !store.sessionExists(sessionId)) return undefined;
  return (model, usage, meta) => {
    buildRecordedUsageEvent(store, sessionId, model, usage, meta);
  };
}

/** Keep manual approval latency independent from the best-effort model indexer. */
export function scheduleAcceptedWritingMemoryIndexing(run: () => Promise<unknown>): void {
  setImmediate(() => {
    void run().catch(() => undefined);
  });
}

async function indexAcceptedWritingMemory(options: {
  project: WriterProject;
  store: WriterStore;
  providers: ProviderManager;
  path: string;
  beforeContent: string;
  afterContent: string;
  sourceProposalId: number;
  sessionId: string;
  sourceMessageId: number;
  signal?: AbortSignal;
}): Promise<{ writingMemory: number; writingMemoryWarning?: string }> {
  if (!["chapter", "side"].includes(documentKind(options.path))) return { writingMemory: 0 };
  try {
    const candidates = await extractWritingMemory({
      model: options.providers.summaryModelConfig(),
      path: options.path,
      beforeContent: options.beforeContent,
      afterContent: options.afterContent,
      characters: options.store.characters().map(character => ({
        id: character.id,
        name: character.identity.name,
        aliases: character.identity.aliases,
      })),
      signal: options.signal,
      usageReporter: usageReporterForSession(options.store, options.sessionId),
    });
    if (!options.project.documentExists(options.path)
      || options.project.hash(options.project.read(options.path)) !== options.project.hash(options.afterContent)) {
      return { writingMemory: 0 };
    }
    const saved = options.store.saveExtractedWritingMemory(
      options.sessionId,
      options.sourceMessageId,
      options.path,
      options.afterContent,
      options.sourceProposalId,
      candidates,
    );
    return { writingMemory: saved.length };
  } catch (error) {
    return {
      writingMemory: 0,
      writingMemoryWarning: `内容已接受，但会话写作记忆更新失败：${errorMessage(error)}`,
    };
  }
}
