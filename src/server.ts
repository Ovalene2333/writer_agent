import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import QRCode from "qrcode";
import { runAgent, stripDsmlText } from "./agent.js";
import {
  ABSOLUTE_MAX_SCENES,
  MAX_ISOLATED_WRITER_MAX_RATIO,
  MAX_SCENE_NOTES_CHARACTERS,
  MAX_SCENE_CANDIDATES,
  MIN_ISOLATED_WRITER_MAX_RATIO,
  MIN_SCENE_NOTES_CHARACTERS,
  isPermissionMode,
  listProjectSkills,
  loadAgentSettings,
  loadProjectInstructions,
  persistFinalizedSessionTodos,
  saveAgentSettings,
  type ScenePipelineSettings,
} from "./agent_runtime.js";
import { generateCharacter, maybeAutoTitleSession, suggestActions, summarizeCharacterCompetency, updateCharacterFromConversation, type WritingMode } from "./generation.js";
import { generateRoleplayInterlocutor, recommendRoleplayDirectorActions, runRoleplayChat } from "./roleplay.js";
import { createAgentStepDebugLogger, stepDebugEnabled } from "./model_debug.js";
import { buildRecordedUsageEvent, type ModelUsageReporter } from "./model_usage.js";
import { WriterProject } from "./project.js";
import { ProviderManager } from "./provider_catalog.js";
import { WriterStore } from "./store.js";
import { getStyleTemplate } from "./templates.js";
import type { AgentEvent, PermissionMode, RoleplayInputMode, RoleplayInterlocutor, RoleplayMemoryFact, RoleplayParticipant, RoleplayScene, StyleTemplate } from "./types.js";
import type { CharacterInput } from "./characters.js";

type AgentJobStatus = "running" | "completed" | "failed" | "cancelled";

function styleTemplatesForClient(project: WriterProject) {
  return project.styleTemplates().map(template => {
    const builtIn = Boolean(getStyleTemplate(template.id));
    return {
      ...template,
      builtIn,
      // Built-ins are never project-customized (overrides are ignored).
      customized: !builtIn,
      readOnly: builtIn,
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
  events: StoredAgentEvent[];
  controller: AbortController;
  listeners: Set<(event: StoredAgentEvent) => void>;
};

export class BackgroundAgentJobs {
  private jobs = new Map<string, AgentJob>();

  start(sessionId: string, run: (signal: AbortSignal, emit: (event: AgentEvent) => void) => Promise<void>): AgentJob {
    const job: AgentJob = {
      id: randomBytes(12).toString("base64url"),
      sessionId,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      controller: new AbortController(),
      listeners: new Set(),
    };
    this.jobs.set(job.id, job);
    const emit = (event: AgentEvent) => this.emit(job.id, event);
    // Defer so callers can finish `const job = start(...)` before the runner touches `job`.
    queueMicrotask(() => {
      void run(job.controller.signal, emit).then(() => {
        if (job.status === "running") this.finish(job, "completed");
      }).catch((error) => {
        if (job.status === "running") {
          this.emit(job.id, { type: "error", message: errorMessage(error) });
          this.finish(job, "failed");
        }
      });
    });
    return job;
  }

  activeJobs(sessionId: string): Array<{ id: string; sessionId: string; status: AgentJobStatus; createdAt: string; updatedAt: string }> {
    return [...this.jobs.values()]
      .filter(job => job.sessionId === sessionId && job.status === "running")
      .map(({ id, sessionId, status, createdAt, updatedAt }) => ({ id, sessionId, status, createdAt, updatedAt }));
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
    const stored = { ...event, index: job.events.length } as StoredAgentEvent;
    job.events.push(stored);
    job.updatedAt = new Date().toISOString();
    if (event.type === "done") this.finish(job, "completed");
    if (event.type === "cancelled") this.finish(job, "cancelled");
    if (event.type === "waiting_for_input") this.finish(job, "completed");
    if (event.type === "error") this.finish(job, "failed");
    for (const listener of job.listeners) listener(stored);
  }

  private finish(job: AgentJob, status: Exclude<AgentJobStatus, "running">): void {
    job.status = status;
    job.updatedAt = new Date().toISOString();
  }
}

export async function startWriterServer(options: {
  project: WriterProject;
  store: WriterStore;
  providers: ProviderManager;
  host?: string;
  port?: number;
  /** Disable API bearer-token checks only when explicitly requested by the CLI. */
  requireToken?: boolean;
  /** 是否在终端打印访问地址 / 二维码，默认 true。`--share` 时由 CLI 统一打印双端点二维码。 */
  announce?: boolean;
}): Promise<{ url: string; origin: string; localOrigin: string; token: string; close: () => Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4096;
  const requireToken = options.requireToken !== false;
  const token = requireToken ? randomBytes(24).toString("base64url") : "";
  const localBypassToken = randomBytes(24).toString("base64url");
  const app = new Hono();
  const agentJobs = new BackgroundAgentJobs();

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
    const provided = context.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const localBypass = context.req.header("x-writer-local-access") ?? "";
    if (!tokensEqual(provided, token) && !tokensEqual(localBypass, localBypassToken)) {
      return context.json({ error: "访问令牌无效或已失效" }, 401);
    }
    await next();
  });

  app.get("/api/health", (context) => context.json({ ok: true, ts: Date.now() }));

  app.get("/api/state", (context) => {
    const requested = context.req.query("session");
    const sessionId = requested && options.store.sessionExists(requested)
      ? requested
      : options.store.latestSession() ?? options.store.createSession();
    return context.json({
      config: options.project.config(),
      documents: options.project.listDocuments(),
      documentFolders: options.project.listDocumentFolders(),
      hiddenDocuments: options.project.hiddenDocuments(),
      hiddenFolders: options.project.hiddenFolders(),
      sessions: options.store.listSessions(),
      sessionId,
      messages: options.store.withMessageVariantInfo(options.store.conversationMessagesBefore(sessionId, undefined, 50)
        .filter(message => (message.role === "user" || message.role === "assistant") && message.content.trim())
        .map(message => ({
          ...message,
          content: stripDsmlText(message.content, "[工具调用已隐藏]"),
        }))),
      messagesHasMore: (() => {
        const visible = options.store.conversationMessagesBefore(sessionId, undefined, 50)
          .filter(message => (message.role === "user" || message.role === "assistant") && message.content.trim());
        const firstId = visible[0]?.id;
        const firstArchiveId = options.store.conversationStats(sessionId).firstMessageId;
        return firstId !== undefined && firstArchiveId !== undefined && firstId > firstArchiveId;
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
      projectInstructions: loadProjectInstructions(options.project)?.path ?? null,
      skills: listProjectSkills(options.project).map(skill => ({
        id: skill.id, name: skill.name, description: skill.description,
      })),
      activeJobs: agentJobs.activeJobs(sessionId),
      characterDirectory: "characters/",
      styleTemplates: styleTemplatesForClient(options.project),
    });
  });

  app.get("/api/document", (context) => {
    try {
      const path = context.req.query("path") ?? "";
      const content = options.project.read(path);
      return context.json({ path, content, hash: options.project.hash(content) });
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
      const body = await context.req.json<{ fromPath: string; toPath: string }>();
      options.store.renameDocument(body.fromPath, body.toPath);
      return context.json({ ok: true, path: body.toPath, hiddenDocuments: options.project.hiddenDocuments() });
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
      const body = await context.req.json<{ fromPath: string; toPath: string }>();
      options.store.renameFolder(body.fromPath, body.toPath);
      return context.json({
        ok: true,
        path: body.toPath,
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
      options.project.registerChapter(path);
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
        .filter(message => message.content.trim())
        .map(message => ({ ...message, content: stripDsmlText(message.content, "[tool call hidden]") })));
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
      options.store.deleteSession(context.req.param("id"));
      return context.json({ ok: true });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/sessions/batch-delete", async (context) => {
    try {
      const body = await context.req.json<{ ids?: string[]; keepSessionId?: string }>();
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
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
    return context.json({ templates: styleTemplatesForClient(options.project), active: activeTemplate ?? null });
  });

  app.post("/api/style/templates", async (context) => {
    try {
      const body = await context.req.json<Partial<StyleTemplate>>();
      const template = options.project.saveStyleTemplate(body);
      let sampling: ReturnType<ProviderManager["applySamplingDefaults"]> | null = null;
      if (options.project.config().style === template.id) {
        options.store.seedStyleExample(template);
        sampling = options.providers.applySamplingDefaults(
          template.suggestedTemperature,
          template.suggestedTopP,
        );
      }
      return context.json({
        template,
        templates: styleTemplatesForClient(options.project),
        sampling,
        provider: options.providers.publicConfig(),
        catalog: options.providers.catalog(),
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
        options.store.seedStyleExample(template);
        // Always write suggested sampling onto role-assigned models (no API key required).
        const sampling = options.providers.applySamplingDefaults(
          template.suggestedTemperature,
          template.suggestedTopP,
        );
        return context.json({
          active: template,
          sampling,
          provider: sampling.provider,
          catalog: sampling.catalog,
        });
      } else {
        options.project.setStyle("");
        return context.json({ active: null, sampling: null });
      }
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/examples", async (context) => {
    try {
      const body = await context.req.json<{ id?: number; title: string; category?: string; content: string; notes?: string }>();
      if (body.title?.length > 160) throw new Error("示例标题过长");
      if (body.content?.length > 50_000) throw new Error("单个写作示例不能超过 50000 字符");
      return context.json({ example: options.store.saveWritingExample({
        id: body.id, title: body.title ?? "", category: body.category ?? "",
        content: body.content ?? "", notes: body.notes ?? "",
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
    try { const body = await context.req.json<{ role: "agent" | "roleplay" | "flash" | "drafter" | "inline" | "writer" | "reviewer" | "summarizer"; providerId: string; modelId: string }>(); return context.json({ catalog: options.providers.assign(body.role, body.providerId, body.modelId), provider: options.providers.publicConfig() }); }
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
      scenePipeline: settings.scenePipeline,
      instructionsPath: instructions?.path ?? null,
      skills: listProjectSkills(options.project).map(skill => ({
        id: skill.id, name: skill.name, description: skill.description, path: skill.path,
      })),
    });
  });

  app.post("/api/agent-settings", async (context) => {
    try {
      const body = await context.req.json<{ permissionMode?: string; scenePipeline?: Partial<ScenePipelineSettings> }>();
      if (body.permissionMode !== undefined && !isPermissionMode(body.permissionMode)) {
        return context.json({ error: "permissionMode 仅支持 ask、auto、plan" }, 400);
      }
      if (body.scenePipeline !== undefined) {
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
        if (body.scenePipeline.isolatedWriter !== undefined && typeof body.scenePipeline.isolatedWriter !== "boolean") {
          return context.json({ error: "isolatedWriter 必须是布尔值" }, 400);
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
        const writerMaxRatio = body.scenePipeline.isolatedWriterMaxRatio;
        if (writerMaxRatio !== undefined && (
          !Number.isFinite(writerMaxRatio)
          || Number(writerMaxRatio) < MIN_ISOLATED_WRITER_MAX_RATIO
          || Number(writerMaxRatio) > MAX_ISOLATED_WRITER_MAX_RATIO
        )) {
          return context.json({
            error: `isolatedWriterMaxRatio 须在 ${MIN_ISOLATED_WRITER_MAX_RATIO}—${MAX_ISOLATED_WRITER_MAX_RATIO} 之间`,
          }, 400);
        }
      }
      const settings = saveAgentSettings(options.project, {
        ...(body.permissionMode ? { permissionMode: body.permissionMode as PermissionMode } : {}),
        ...(body.scenePipeline ? { scenePipeline: body.scenePipeline as ScenePipelineSettings } : {}),
      });
      return context.json({
        permissionMode: settings.permissionMode,
        scenePipeline: settings.scenePipeline,
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
      const body = await context.req.json<{ sessionId?: string; performer?: RoleplayParticipant; identity?: RoleplayParticipant; characterId?: number; interlocutor?: RoleplayInterlocutor; sceneId?: number }>();
      if (!body.sessionId) throw new Error("缺少会话 ID");
      const performer = body.performer ?? body.characterId;
      const identity = body.identity ?? body.interlocutor;
      if (!performer) throw new Error("缺少扮演者角色卡");
      if (!identity) throw new Error("缺少当前身份角色卡");
      return context.json(options.store.saveActiveRoleplay(body.sessionId, performer, identity, body.sceneId));
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/roleplay/state/:sessionId", (context) => {
    try {
      const sessionId = context.req.param("sessionId");
      if (!options.store.sessionExists(sessionId)) throw new Error("会话不存在");
      options.store.clearActiveRoleplay(sessionId);
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
        model: options.providers.modelConfig("flash"),
      });
      return context.json({ suggestions });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/chat", async (context) => {
    const body = await context.req.json<{ sessionId: string; prompt: string; mode?: WritingMode | "character" | "roleplay"; permissionMode?: string; performer?: RoleplayParticipant; identity?: RoleplayParticipant; characterId?: number; interlocutor?: RoleplayInterlocutor; scene?: RoleplayScene; inputMode?: RoleplayInputMode; opening?: boolean; contextDocumentPaths?: string[]; characterScope?: number[]; simpleCharacterScope?: number[]; variantGroupId?: string; documentSelections?: Array<{ path: string; text: string }> }>();
    // Roleplay openings are model-initiated and legitimately carry no prompt.
    if (!body.prompt?.trim() && !(body.mode === "roleplay" && body.opening)) return context.json({ error: "写作指令不能为空" }, 400);
    const characterScope = Array.isArray(body.characterScope)
      ? [...new Set(body.characterScope.map(Number).filter(Number.isInteger))]
      : undefined;
    const simpleCharacterScope = Array.isArray(body.simpleCharacterScope)
      ? [...new Set(body.simpleCharacterScope.map(Number).filter(Number.isInteger))]
      : undefined;
    const variantGroupId = typeof body.variantGroupId === "string" && body.variantGroupId.length <= 100
      ? body.variantGroupId
      : undefined;
    const runtimeSettings = loadAgentSettings(options.project);
    const permissionMode = body.permissionMode && isPermissionMode(body.permissionMode)
      ? body.permissionMode
      : runtimeSettings.permissionMode;
    const jobLabel = body.mode === "character" ? "character" : body.mode === "roleplay" ? "roleplay" : "agent";
    const job = agentJobs.start(body.sessionId, async (signal, emit) => {
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
        // Defer terminal success events until auto-title finishes so /api/state refresh sees the new title.
        const deferred: AgentEvent[] = [];
        const onEvent = (event: AgentEvent) => {
          stepDebug.onEvent(event);
          if (event.type === "done" || event.type === "waiting_for_input") {
            deferred.push(event);
            return;
          }
          emit(event);
        };
        if (body.mode === "character") {
          await updateCharacterFromConversation({
            model: options.providers.modelConfig("agent"), summaryModel: options.providers.summaryModelConfig(), store: options.store,
            sessionId: body.sessionId, instruction: body.prompt,
            characterId: Number.isInteger(body.characterId) ? body.characterId : undefined,
            jobId: job.id,
            allowedDocumentPaths: characterContextDocumentPaths(options.project, body.contextDocumentPaths),
            signal, onEvent,
          });
        } else if (body.mode === "roleplay") {
          if (!body.performer && !Number.isInteger(body.characterId)) throw new Error("角色扮演需要指定扮演者");
          await runRoleplayChat({
            project: options.project,
            store: options.store,
            sessionId: body.sessionId,
            performer: body.performer,
            characterId: body.characterId,
            identity: body.identity,
            interlocutor: body.interlocutor,
            scene: body.scene?.id ? options.store.roleplayScenes().find(item => item.id === body.scene!.id) : undefined,
            prompt: body.prompt,
            jobId: job.id,
            inputMode: body.inputMode === "director" ? "director" : "dialogue",
            opening: body.opening === true,
            variantGroupId,
            model: options.providers.modelConfig("roleplay"),
            summarizer: options.providers.summaryModelConfig(),
            signal,
            onEvent,
          });
        } else {
          await runAgent({
            project: options.project,
            store: options.store,
            sessionId: body.sessionId,
            jobId: job.id,
            prompt: body.prompt,
            variantGroupId,
            selectedDocumentBlocks: body.documentSelections,
            characterScope,
            simpleCharacterScope,
            permissionMode,
            scenePipelineSettings: runtimeSettings.scenePipeline,
            models: {
              agent: options.providers.modelConfig("agent"), writer: options.providers.modelConfig("writer"),
              inline: options.providers.modelConfig("inline"), reviewer: options.providers.modelConfig("reviewer"),
              summarizer: options.providers.summaryModelConfig(),
            },
            signal,
            onEvent,
          });
        }
        // Auto-title once after a successful turn (never overwrites custom titles; only runs once).
        if (!signal.aborted && deferred.length > 0) {
          try {
            await maybeAutoTitleSession({
              store: options.store,
              model: options.providers.summaryModelConfig(),
              sessionId: body.sessionId,
              signal,
              usageReporter: (callModel, callUsage, meta) => {
                emit(buildRecordedUsageEvent(options.store, body.sessionId, callModel, callUsage, {
                  ...meta,
                  jobId: job.id,
                }));
              },
            });
          } catch { /* title is best-effort */ }
        }
        // Safety net: only close a dangling in_progress item. Never auto-complete
        // pending multi-chapter writing steps (those must stay open until written).
        if (!signal.aborted && deferred.some(event => event.type === "done")) {
          persistFinalizedSessionTodos(options.store, body.sessionId, emit, "dangling_in_progress");
        }
        for (const event of deferred) {
          stepDebug.onEvent(event);
          emit(event);
        }
      } catch (error) {
        const message = errorMessage(error);
        stepDebug.onEvent({ type: "error", message });
        emit({ type: "error", message });
      } finally {
        stepDebug.flush();
      }
    });
    return context.json({ jobId: job.id });
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

  app.post("/api/proposals/:id/:action", (context) => {
    try {
      const id = Number(context.req.param("id"));
      const action = context.req.param("action");
      if (!Number.isInteger(id) || !["accept", "reject"].includes(action)) throw new Error("审批参数无效");
      const proposal = action === "accept" ? options.store.acceptProposal(id) : options.store.rejectProposal(id);
      return context.json({ proposal });
    } catch (error) {
      return context.json({ error: errorMessage(error) }, 409);
    }
  });

  app.post("/api/change-sets/:id/:action", (context) => {
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

  app.get("/health", (context) => context.json({ ok: true }));
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
    close: async () => {
      await Promise.all([closeServer(server), ...(localServer ? [closeServer(localServer)] : [])]);
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

function usageReporterForSession(store: WriterStore, sessionId?: string): ModelUsageReporter | undefined {
  if (!sessionId || !store.sessionExists(sessionId)) return undefined;
  return (model, usage, meta) => {
    buildRecordedUsageEvent(store, sessionId, model, usage, meta);
  };
}
