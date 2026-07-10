import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import QRCode from "qrcode";
import { runAgent, stripDsmlText } from "./agent.js";
import { generateCharacter, suggestActions, updateCharacterFromConversation, type WritingMode } from "./generation.js";
import { WriterProject } from "./project.js";
import { ProviderManager } from "./provider_catalog.js";
import { WriterStore } from "./store.js";
import { getStyleTemplate, listStyleTemplates } from "./templates.js";
import type { AgentEvent } from "./types.js";

type AgentJobStatus = "running" | "completed" | "failed" | "cancelled";
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

class BackgroundAgentJobs {
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
    void run(job.controller.signal, emit).then(() => {
      if (job.status === "running") this.finish(job, "completed");
    }).catch((error) => {
      if (job.status === "running") {
        this.emit(job.id, { type: "error", message: errorMessage(error) });
        this.finish(job, "failed");
      }
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

  subscribe(id: string, listener: (event: StoredAgentEvent) => void): (() => void) | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  private emit(id: string, event: AgentEvent): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const stored = { ...event, index: job.events.length } as StoredAgentEvent;
    job.events.push(stored);
    job.updatedAt = new Date().toISOString();
    if (event.type === "done") this.finish(job, "completed");
    if (event.type === "cancelled") this.finish(job, "cancelled");
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
}): Promise<{ url: string; token: string; close: () => Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4096;
  const token = randomBytes(24).toString("base64url");
  const app = new Hono();
  const agentJobs = new BackgroundAgentJobs();

  app.use("/api/*", async (context, next) => {
    const provided = context.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const expectedBuffer = Buffer.from(token);
    const providedBuffer = Buffer.from(provided);
    if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
      return context.json({ error: "访问令牌无效或已失效" }, 401);
    }
    await next();
  });

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
      messages: options.store.messages(sessionId, 50).map(message => ({
        ...message,
        content: stripDsmlText(message.content, "[工具调用已隐藏]"),
      })),
      proposals: options.store.proposals(),
      characters: options.store.characters(),
      examples: options.store.writingExamples(),
      provider: options.providers.publicConfig(),
      providerCatalog: options.providers.catalog(),
      usage: options.store.usage(sessionId),
      activeJobs: agentJobs.activeJobs(sessionId),
      characterDirectory: "characters/",
      styleTemplates: listStyleTemplates(),
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

  app.post("/api/characters", async (context) => {
    try {
      const body = await context.req.json<{
        id?: number; name: string; aliases?: string[]; role?: string; appearance?: string;
        traits?: string; background?: string; goals?: string; relationships?: string; relatedCharacterIds?: number[]; abilities?: string; notes?: string;
      }>();
      if (body.name?.length > 120) throw new Error("角色名称过长");
      return context.json({ character: options.store.saveCharacter({
        id: body.id, name: body.name ?? "", aliases: Array.isArray(body.aliases) ? body.aliases : [],
        role: body.role ?? "", appearance: body.appearance ?? "",
        traits: body.traits ?? "", background: body.background ?? "",
        goals: body.goals ?? "", relationships: body.relationships ?? "",
        relatedCharacterIds: Array.isArray(body.relatedCharacterIds) ? body.relatedCharacterIds : [],
        abilities: body.abilities ?? "", notes: body.notes ?? "",
      }) });
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
    const activeTemplate = activeStyleId ? getStyleTemplate(activeStyleId) : undefined;
    return context.json({ templates: listStyleTemplates(), active: activeTemplate ?? null });
  });

  app.put("/api/style", async (context) => {
    try {
      const body: { styleId?: string } = await context.req.json<{ styleId?: string }>().catch(() => ({}));
      const styleId = (body.styleId ?? "").trim();
      if (styleId) {
        const template = getStyleTemplate(styleId);
        if (!template) throw new Error(`未知的风格模板：${styleId}`);
        options.project.setStyle(styleId);
        options.store.seedStyleExample(template);
        options.providers.save({
          provider: options.providers.publicConfig().provider,
          baseUrl: options.providers.publicConfig().baseUrl,
          model: options.providers.publicConfig().model,
          temperature: template.suggestedTemperature,
          topP: template.suggestedTopP,
        });
        return context.json({ active: template });
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
    try { const body = await context.req.json<{ role: "agent" | "drafter" | "inline" | "writer" | "reviewer" | "summarizer"; providerId: string; modelId: string }>(); return context.json({ catalog: options.providers.assign(body.role, body.providerId, body.modelId), provider: options.providers.publicConfig() }); }
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
        pricing?: { cacheHit?: number; cacheMiss?: number; output?: number; currency?: "CNY" | "USD"; contextWindow?: number };
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

  app.post("/api/chat", async (context) => {
    const body = await context.req.json<{ sessionId: string; prompt: string; mode?: WritingMode | "character"; path?: string; characterId?: number; contextDocumentPaths?: string[]; characterScope?: number[]; documentSelections?: Array<{ path: string; text: string }> }>();
    if (!body.prompt?.trim()) return context.json({ error: "写作指令不能为空" }, 400);
    const characterScope = Array.isArray(body.characterScope)
      ? [...new Set(body.characterScope.map(Number).filter(Number.isInteger))]
      : undefined;
    const job = agentJobs.start(body.sessionId, async (signal, emit) => {
      try {
        const onEvent = async (event: AgentEvent) => emit(event);
        if (body.mode === "character") {
          await updateCharacterFromConversation({
            model: options.providers.modelConfig("agent"), summaryModel: options.providers.summaryModelConfig(), store: options.store,
            sessionId: body.sessionId, instruction: body.prompt,
            characterId: Number.isInteger(body.characterId) ? body.characterId : undefined,
            allowedDocumentPaths: characterContextDocumentPaths(options.project, body.contextDocumentPaths),
            signal, onEvent,
          });
          return;
        }
        await runAgent({
          project: options.project,
          store: options.store,
          sessionId: body.sessionId,
          prompt: body.prompt,
          requestedMode: body.mode ?? (body.documentSelections?.length ? "rewrite" : body.path ? "continue" : "write"),
          targetPath: body.path,
          selectedDocumentBlocks: body.documentSelections,
          characterScope,
          purpose: body.mode === "polish" ? "review" : body.mode === "rewrite" ? "inline" : "agent",
          models: {
            agent: options.providers.modelConfig("agent"), writer: options.providers.modelConfig("writer"),
            inline: options.providers.modelConfig("inline"), reviewer: options.providers.modelConfig("reviewer"),
          },
          signal,
          onEvent,
        });
      } catch (error) {
        emit({ type: "error", message: errorMessage(error) });
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
      for (const event of job.events) await write(event);
      if (job.status !== "running") return;
      await new Promise<void>((resolve) => {
        const unsubscribe = agentJobs.subscribe(job.id, (event) => {
          void write(event);
          if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
            unsubscribe?.();
            resolve();
          }
        });
        context.req.raw.signal.addEventListener("abort", () => {
          closed = true;
          unsubscribe?.();
          resolve();
        }, { once: true });
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
        characters: options.store.characters().map(item => ({ id: item.id, name: item.name, aliases: item.aliases })),
        signal: context.req.raw.signal,
      });
      return context.json({ suggestions });
    } catch (error) { return context.json({ error: errorMessage(error) }, 400); }
  });

  app.post("/api/characters/generate", async (context) => {
    try {
      const body = await context.req.json<{ description: string; existing?: Record<string, unknown> }>();
      const character = await generateCharacter({
        model: options.providers.modelConfig("agent"), description: body.description ?? "",
        existing: body.existing, signal: context.req.raw.signal,
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
      if (!sessionId || !Number.isInteger(targetId) || targetId < 0) throw new Error("参数无效");
      return context.json(options.store.rewindFromMessage(sessionId, targetId));
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

  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "web");
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("/*", serveStatic({ path: resolve(webRoot, "index.html") }));

  const server = serve({ fetch: app.fetch, hostname: host, port });
  await new Promise<void>((resolveReady, rejectReady) => {
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
  const address = host === "0.0.0.0" ? findLanAddress() : host;
  const url = `http://${address}:${port}/#token=${token}`;
  if (host === "0.0.0.0") {
    process.stdout.write(`\n手机访问：${url}\n`);
    process.stdout.write(await QRCode.toString(url, { type: "terminal", small: true }));
  } else {
    process.stdout.write(`Writer Web：${url}\n`);
  }
  return {
    url,
    token,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
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
  return error instanceof Error ? error.message : String(error);
}
