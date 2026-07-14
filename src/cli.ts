#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import QRCode from "qrcode";
import { runAgent } from "./agent.js";
import { isPermissionMode, loadAgentSettings, permissionModeLabel, saveAgentSettings } from "./agent_runtime.js";
import { WriterAgentTui } from "./agent_tui.js";
import { createAgentStepDebugLogger, stepDebugEnabled } from "./model_debug.js";
import { WriterProject } from "./project.js";
import { ProviderManager } from "./provider_catalog.js";
import { startWriterServer } from "./server.js";
import { WriterStore } from "./store.js";
import type { PermissionMode } from "./types.js";

const program = new Command();
program
  .name("writer")
  .description("面向长篇创作的终端写作 Agent")
  .version("0.1.0");

program.command("init")
  .description("初始化写作项目")
  .argument("[directory]", "项目目录", ".")
  .option("--title <title>", "作品名称")
  .action((directory: string, options: { title?: string }) => {
    const target = resolve(directory);
    if (existsSync(resolve(target, "writer.yaml"))) throw new Error("目标目录已经是写作项目");
    const project = WriterProject.init(target, options.title);
    const store = new WriterStore(project);
    store.close();
    process.stdout.write(`已初始化《${project.config().title}》：${project.root}\n`);
  });

program.command("run")
  .description("执行一次写作生成并退出")
  .argument("<prompt>", "写作指令")
  .option("-p, --project <directory>", "项目目录", ".")
  .option("-s, --session <id>", "继续指定会话")
  .option("-c, --continue", "继续最近一次会话")
  .option("--mode <mode>", "权限模式：ask | auto | plan")
  .option("--json", "逐行输出 JSON 事件")
  .option("--debug", "调试：终端打印 step 内容 + 模型请求/响应体")
  .option("--debug-steps", "仅打印 Agent step（reasoning / tools / output）到终端")
  .action(async (prompt: string, options: { project: string; session?: string; continue?: boolean; mode?: string; json?: boolean; debug?: boolean; debugSteps?: boolean }) => {
    if (options.debug) process.env.WRITER_DEBUG = "1";
    if (options.debugSteps) process.env.WRITER_DEBUG_STEPS = "1";
    const { project, store, providers } = openProject(options.project);
    try {
      const permissionMode = resolvePermissionMode(project, options.mode);
      const sessionId = resolveSession(store, options.session, Boolean(options.continue));
      const stepDebug = createAgentStepDebugLogger({ sessionId, label: "run" });
      if (stepDebugEnabled()) {
        process.stderr.write(`[WRITER STEP] ▸ run start session=${sessionId.slice(0, 8)} mode=${permissionMode}\n[WRITER STEP] prompt: ${prompt.trim().slice(0, 500)}\n`);
      }
      try {
        await runAgent({
          project, store, sessionId, prompt, permissionMode,
          models: {
            agent: providers.modelConfig("agent"), writer: providers.modelConfig("writer"),
            inline: providers.modelConfig("inline"), reviewer: providers.modelConfig("reviewer"),
            summarizer: providers.summaryModelConfig(),
          },
          onEvent: (event) => {
            stepDebug.onEvent(event);
            if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`);
            else if (event.type === "text") process.stdout.write(event.text);
            else if (event.type === "proposal") {
              const status = event.proposal.status === "accepted" ? "已写入" : "待审批";
              process.stdout.write(`\n[${status}提案 #${event.proposal.id}：${event.proposal.path}]\n`);
            } else if (event.type === "todos") {
              process.stdout.write(`\n[任务 ${event.todos.filter(t => t.status === "completed").length}/${event.todos.length}]\n`);
            } else if (event.type === "error") process.stderr.write(`\n错误：${event.message}\n`);
          },
        });
      } finally {
        stepDebug.flush();
      }
      if (!options.json) process.stdout.write("\n");
    } finally { store.close(); }
  });

program.command("chat")
  .alias("tui")
  .description("启动交互式终端 Agent（仿 code agent REPL）")
  .option("-p, --project <directory>", "项目目录", ".")
  .option("-s, --session <id>", "继续指定会话")
  .option("-c, --continue", "继续最近一次会话")
  .option("--mode <mode>", "权限模式：ask | auto | plan")
  .option("--debug", "调试：打印模型请求/响应体")
  .option("--debug-steps", "仅打印 Agent step 到终端")
  .action(async (options: { project: string; session?: string; continue?: boolean; mode?: string; debug?: boolean; debugSteps?: boolean }) => {
    if (options.debug) process.env.WRITER_DEBUG = "1";
    if (options.debugSteps) process.env.WRITER_DEBUG_STEPS = "1";
    const { project, store, providers } = openProject(options.project);
    const permissionMode = resolvePermissionMode(project, options.mode, true);
    const sessionId = resolveSession(store, options.session, options.continue !== false && !options.session);
    process.stdout.write(`Writer Agent TUI · ${project.config().title} · ${permissionModeLabel(permissionMode)}\n`);
    const instance = render(React.createElement(WriterAgentTui, {
      project, store, providers, sessionId, permissionMode,
    }));
    try {
      await instance.waitUntilExit();
    } finally {
      store.close();
    }
  });

program.command("web")
  .alias("serve")
  .description("启动常驻 Web 写作工作台")
  .option("-p, --project <directory>", "项目目录", ".")
  .option("--lan", "允许局域网设备访问")
  .option("--host <host>", "监听地址")
  .option("--port <port>", "监听端口", "4096")
  .option("--share", "创建临时公网访问地址（需要已安装 cloudflared；默认同时开局域网，扫一次码可自动切换）")
  .option("--no-open", "不自动打开 PC 浏览器")
  .option("--debug", "调试：终端打印 step 内容 + 模型请求/响应体")
  .option("--debug-steps", "仅打印 Agent step（reasoning / tools / output）到终端，不含模型原文")
  .action(async (options: { project: string; lan?: boolean; host?: string; port: string; share?: boolean; open: boolean; debug?: boolean; debugSteps?: boolean }) => {
    if (options.debug) process.env.WRITER_DEBUG = "1";
    if (options.debugSteps) process.env.WRITER_DEBUG_STEPS = "1";
    if (stepDebugEnabled()) {
      process.stderr.write("[WRITER STEP] step debug enabled — Agent 每步 reasoning/tools/output 会打印到本终端\n");
    }
    const { project, store, providers } = openProject(options.project);
    // --share 默认绑定 0.0.0.0，便于手机扫码后在局域网/公网间自动切换
    const host = options.host || (options.lan || options.share ? "0.0.0.0" : "127.0.0.1");
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1 至 65535 的整数");
    const server = await startWriterServer({
      project, store, providers, host, port,
      announce: !options.share,
    });
    const tunnel = options.share ? startShareTunnel(port, server.token, server.origin) : undefined;
    if (options.open) openBrowser(server.url);
    const stop = async () => {
      tunnel?.kill();
      await server.close();
      store.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise(() => undefined);
  });

program.command("export")
  .description("按章节顺序导出作品")
  .option("-p, --project <directory>", "项目目录", ".")
  .option("-f, --format <format>", "导出格式：md 或 txt", "md")
  .option("-o, --output <file>", "输出文件；省略时写到标准输出")
  .action((options: { project: string; format: string; output?: string }) => {
    if (options.format !== "md" && options.format !== "txt") throw new Error("导出格式仅支持 md 或 txt");
    const project = new WriterProject(options.project);
    if (!project.exists()) throw new Error("当前目录不是写作项目，请先执行 writer init");
    const content = project.export(options.format);
    if (options.output) writeFileSync(resolve(options.output), content, "utf8");
    else process.stdout.write(content);
  });

const session = program.command("session").description("管理写作会话");
session.command("list")
  .option("-p, --project <directory>", "项目目录", ".")
  .action((options: { project: string }) => {
    const { store } = openProject(options.project);
    try {
      for (const item of store.listSessions()) process.stdout.write(`${item.id}\t${item.updatedAt}\t${item.title}\n`);
    } finally { store.close(); }
  });

program
  .argument("[project]", "写作项目目录", ".")
  .action(async (projectPath: string) => {
    const { project, store, providers } = openProject(projectPath);
    const server = await startWriterServer({ project, store, providers });
    openBrowser(server.url);
    const stop = async () => { await server.close(); store.close(); process.exit(0); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    await new Promise(() => undefined);
  });

program.parseAsync().catch((error) => {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

function openProject(path: string): { project: WriterProject; store: WriterStore; providers: ProviderManager } {
  const project = new WriterProject(path);
  if (!project.exists()) throw new Error("当前目录不是写作项目，请先执行 writer init");
  return { project, store: new WriterStore(project), providers: new ProviderManager(project) };
}

function resolveSession(store: WriterStore, requested: string | undefined, useLatest: boolean): string {
  if (requested) {
    const exact = store.sessionExists(requested) ? requested : undefined;
    if (exact) return exact;
    const matches = store.listSessions().filter(item => item.id.startsWith(requested));
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) throw new Error(`会话 ID 前缀不唯一：${requested}`);
    throw new Error(`会话不存在：${requested}`);
  }
  if (useLatest) return store.latestSession() ?? store.createSession();
  return store.createSession();
}

function resolvePermissionMode(project: WriterProject, requested: string | undefined, persist = false): PermissionMode {
  if (!requested) return loadAgentSettings(project).permissionMode;
  if (!isPermissionMode(requested)) throw new Error("权限模式仅支持 ask、auto、plan");
  if (persist) saveAgentSettings(project, { permissionMode: requested });
  return requested;
}

function openBrowser(url: string): void {
  try {
    const command = process.platform === "win32" ? "cmd"
      : process.platform === "darwin" ? "open"
        : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => process.stderr.write(`无法自动打开浏览器，请手动访问：${url}\n`));
    child.unref();
  } catch {
    process.stderr.write(`无法自动打开浏览器，请手动访问：${url}\n`);
  }
}

function startShareTunnel(port: number, token: string, lanOrigin: string): ChildProcessWithoutNullStreams {
  process.stdout.write("正在创建公网临时访问地址（cloudflared）...\n");
  process.stdout.write(`本机/局域网源：${lanOrigin}\n`);
  const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
    windowsHide: true,
    stdio: "pipe",
    env: {
      ...process.env,
      TUNNEL_TRANSPORT_PROTOCOL: process.env.WRITER_TUNNEL_PROTOCOL || "http2",
    },
  });
  let printed = false;
  let publicOrigin = "";
  let outputBuffer = "";
  let readinessTimer: NodeJS.Timeout | undefined;
  const printAccess = () => {
    if (printed || !publicOrigin) return;
    printed = true;
    if (readinessTimer) clearTimeout(readinessTimer);
    // 二维码走局域网入口：页在 HTTP 上，才能在局域网/Cloudflare 间自动切 API（HTTPS 页无法探测 HTTP 局域网）。
    const dualEntry = `${lanOrigin}/#token=${encodeURIComponent(token)}&public=${encodeURIComponent(publicOrigin)}`;
    const publicOnly = `${publicOrigin}/#token=${encodeURIComponent(token)}&lan=${encodeURIComponent(lanOrigin)}`;
    process.stdout.write("\n手机扫码（推荐，一次即可；在家走局域网，出门自动切 Cloudflare）：\n");
    process.stdout.write(`${dualEntry}\n`);
    void QRCode.toString(dualEntry, { type: "terminal", small: true })
      .then(qr => {
        process.stdout.write(qr);
        process.stdout.write(`仅公网备用（不在家 Wi‑Fi 时打开）：\n${publicOnly}\n`);
        process.stdout.write("注意：公网地址会暴露写作工作台。只给可信设备；结束进程后隧道关闭。下次启动需重新扫码。\n");
      })
      .catch(() => process.stdout.write("二维码生成失败，请直接复制上方地址。\n"));
  };
  const handleOutput = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    outputBuffer = `${outputBuffer}${text}`.slice(-16_000);
    const match = outputBuffer.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !publicOrigin) {
      publicOrigin = match[0];
      process.stdout.write("公网地址已分配，正在等待隧道连接就绪...\n");
      readinessTimer = setTimeout(() => {
        if (!printed) process.stderr.write("公网隧道尚未连接到 Cloudflare；暂不显示二维码，以免访问时出现 Error 1033。请检查下方 cloudflared 错误或网络防火墙。\n");
      }, 15_000);
    }
    if (/Registered tunnel connection/i.test(outputBuffer)) printAccess();
    if (/\bERR\b|failed to connect|Unable to establish connection/i.test(text)) process.stderr.write(text);
  };
  tunnel.stdout.on("data", handleOutput);
  tunnel.stderr.on("data", handleOutput);
  tunnel.once("error", (error) => {
    process.stderr.write(`无法启动 cloudflared：${error.message}\n`);
    process.stderr.write("请先安装 Cloudflare Tunnel 客户端，或改用 `writer web --lan` 只在局域网访问。\n");
  });
  tunnel.once("exit", (code) => {
    if (readinessTimer) clearTimeout(readinessTimer);
    if (!printed) process.stderr.write(`cloudflared 隧道未成功连接或已提前退出（代码 ${code ?? "未知"}）。请确认 cloudflared 已更新、网络可访问 Cloudflare，且 ~/.cloudflared/config.yaml 未干扰 Quick Tunnel。\n`);
  });
  return tunnel;
}
