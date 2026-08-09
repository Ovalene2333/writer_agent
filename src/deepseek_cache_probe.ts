#!/usr/bin/env node
import { createHash } from "node:crypto";
import process from "node:process";
import {
  agentToolsForTask,
  buildDynamicTurnMessages,
  buildStableSystemPrefix,
  projectCacheUserId,
} from "./agent.js";
import { applyProviderReasoningToChatBody, isDeepSeekModel, samplingRequestOptions, thinkingRequestOptions } from "./model_compat.js";
import { modelFetch, modelRequestOptions } from "./model_fetch.js";
import { parseModelTokenUsage } from "./model_usage.js";
import { WriterProject } from "./project.js";
import { ProviderManager } from "./provider_catalog.js";
import { WriterStore } from "./store.js";
import type { ModelConfig, ModelTokenUsage, ModelUsageRole } from "./types.js";

type ProbeMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | import("./types.js").MessageContentPart[] | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: ProbeToolCall[];
};

type ProbeToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ProbeResult = {
  name: string;
  messages: number;
  fingerprint: string;
  durationMs: number;
  usage: ModelTokenUsage;
  assistant: ProbeMessage;
};

type ProbeOptions = {
  projectPath: string;
  role: ModelUsageRole;
  timeoutMs: number;
  json: boolean;
  allowProjectContent: boolean;
};

const HELP = `DeepSeek 消息前缀缓存探针

用法：
  npm run probe:deepseek-cache -- --project ../jn3 --allow-project-content

选项：
  -p, --project <path>   读取该 Writer 项目的供应商与稳定提示词，默认当前目录
  -r, --role <role>      使用的模型角色，默认 agent
  --timeout <ms>         单次请求超时，默认 180000
  --json                 输出 JSON
  --allow-project-content
                         确认将项目稳定提示词、风格约束和工具 schema 发给所选供应商
  -h, --help             显示帮助

会连续执行 5 次小额真实模型调用；不输出提示词、正文或 API Key。`;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.allowProjectContent) {
    throw new Error("真实探针会把项目稳定提示词、风格约束和工具 schema 发给外部模型；确认后添加 --allow-project-content");
  }
  const project = new WriterProject(options.projectPath);
  if (!project.exists()) throw new Error(`不是 Writer 项目：${options.projectPath}`);
  const store = new WriterStore(project);
  try {
    const model = new ProviderManager(project).modelConfig(options.role);
    if (!isDeepSeekModel(model)) {
      throw new Error(`所选 ${options.role} 模型不是 DeepSeek：${model.providerName ?? model.provider ?? "unknown"} / ${model.model}`);
    }
    if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
      throw new Error("DeepSeek API Key 未配置");
    }

    const tools = agentToolsForTask("general", "ask");
    const seedPrompt = "缓存诊断：只调用 list_documents，不要输出解释；若无法调用工具，只回复 CACHE_SEED。";
    const baseMessages: ProbeMessage[] = [
      ...buildStableSystemPrefix(project, store, "ask", { intensive: false }, "general"),
      ...buildDynamicTurnMessages({
        historyText: "会话历史预览：缓存探针，无历史消息。",
        archiveContext: "会话归档元数据：缓存探针，不读取归档。",
        taskContext: "当前任务：验证真实消息前缀缓存。只执行用户要求的无副作用探针，不修改项目。",
        dynamicStyleContext: "本轮动态声线证据：无。",
        bootstrapContext: "写作线索：本轮无启发式索引。",
        artifactContext: "本轮任务工作记忆：无。",
        selectedContext: "用户选区：无。",
        prompt: seedPrompt,
      }),
    ];
    const common = { model, tools, userId: projectCacheUserId(project.root), timeoutMs: options.timeoutMs };
    const results: ProbeResult[] = [];

    const seed = await requestProbe("seed", baseMessages, common);
    results.push(seed);
    const generatedPrefix = [...baseMessages, seed.assistant, ...syntheticToolResults(seed.assistant)];
    const handoff = "缓存诊断续步：只回复 CACHE_NEXT，不要调用工具。";
    const appendUser = [...generatedPrefix, { role: "user" as const, content: handoff }];
    results.push(await requestProbe("append_user", appendUser, common));
    results.push(await requestProbe("exact_replay", appendUser, common));
    results.push(await requestProbe("append_system", [
      ...generatedPrefix,
      { role: "system", content: handoff },
    ], common));
    results.push(await requestProbe("truncated_user", [
      ...baseMessages,
      { role: "user", content: handoff },
    ], common));

    const report = buildReport(model, tools.length, seed.assistant.tool_calls?.length ?? 0, results);
    process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : formatReport(report));
  } finally {
    store.close();
  }
}

async function requestProbe(
  name: string,
  messages: ProbeMessage[],
  options: { model: ModelConfig; tools: readonly unknown[]; userId: string; timeoutMs: number },
): Promise<ProbeResult> {
  const endpoint = `${options.model.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
  const body = JSON.stringify(applyProviderReasoningToChatBody(options.model, {
    model: options.model.model,
    messages,
    tools: options.tools,
    user_id: options.userId,
    stream: false,
    max_tokens: 96,
    ...thinkingRequestOptions(options.model),
    ...samplingRequestOptions(options.model),
  }));
  const started = Date.now();
  const response = await modelFetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.model.apiKey ? { authorization: `Bearer ${options.model.apiKey}` } : {}),
    },
    body,
    signal: AbortSignal.timeout(options.timeoutMs),
  }, modelRequestOptions(options.model));
  const raw = await response.text();
  if (!response.ok) throw new Error(`${name} 请求失败（${response.status}）：${raw.slice(0, 300)}`);
  const payload = JSON.parse(raw) as {
    choices?: Array<{ message?: Record<string, unknown> }>;
    usage?: unknown;
  };
  const usage = parseModelTokenUsage(payload.usage);
  if (!usage) throw new Error(`${name} 响应没有 usage，无法判断缓存命中`);
  return {
    name,
    messages: messages.length,
    fingerprint: fingerprint(messages, options.tools),
    durationMs: Date.now() - started,
    usage,
    assistant: normalizeAssistant(payload.choices?.[0]?.message),
  };
}

function normalizeAssistant(value: Record<string, unknown> | undefined): ProbeMessage {
  if (!value) throw new Error("模型响应缺少 assistant message");
  const toolCalls = Array.isArray(value.tool_calls)
    ? value.tool_calls.flatMap((raw): ProbeToolCall[] => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const item = raw as Record<string, unknown>;
        const fn = item.function && typeof item.function === "object" && !Array.isArray(item.function)
          ? item.function as Record<string, unknown>
          : undefined;
        if (typeof item.id !== "string" || typeof fn?.name !== "string") return [];
        return [{
          id: item.id,
          type: "function",
          function: {
            name: fn.name,
            arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
          },
        }];
      })
    : [];
  return {
    role: "assistant",
    content: typeof value.content === "string" ? value.content : null,
    ...(typeof value.reasoning_content === "string" && value.reasoning_content
      ? { reasoning_content: value.reasoning_content }
      : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function syntheticToolResults(assistant: ProbeMessage): ProbeMessage[] {
  return (assistant.tool_calls ?? []).map(call => ({
    role: "tool",
    tool_call_id: call.id,
    content: JSON.stringify({ status: "probe", tool: call.function.name, documents: [] }),
  }));
}

function fingerprint(messages: ProbeMessage[], tools: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify({ messages, tools })).digest("hex").slice(0, 16);
}

function buildReport(model: ModelConfig, toolCount: number, generatedToolCalls: number, results: ProbeResult[]) {
  return {
    provider: model.providerName ?? model.provider ?? "DeepSeek",
    model: model.model,
    toolCount,
    generatedToolCalls,
    cases: results.map(({ assistant: _assistant, ...result }) => ({
      ...result,
      cacheHitRate: ratio(result.usage.cacheHitTokens, result.usage.promptTokens),
    })),
    checks: {
      exactReplayHitAtLeastAppend: hit(results, "exact_replay") >= hit(results, "append_user"),
      trailingUserHitAtLeastSystem: hit(results, "append_user") >= hit(results, "append_system"),
      appendOnlyHitAtLeastTruncated: hit(results, "append_user") >= hit(results, "truncated_user"),
    },
  };
}

function formatReport(report: ReturnType<typeof buildReport>): string {
  const lines = [
    `DeepSeek cache probe: ${report.provider} / ${report.model}`,
    `tools=${report.toolCount}, generatedToolCalls=${report.generatedToolCalls}`,
    "",
    "case             messages  prompt  hit    miss   hitRate  duration",
  ];
  for (const item of report.cases) {
    lines.push([
      item.name.padEnd(16),
      String(item.messages).padStart(8),
      String(item.usage.promptTokens).padStart(8),
      String(item.usage.cacheHitTokens).padStart(6),
      String(item.usage.cacheMissTokens).padStart(7),
      `${(item.cacheHitRate * 100).toFixed(1)}%`.padStart(9),
      `${item.durationMs}ms`.padStart(10),
    ].join(" "));
  }
  lines.push("", `checks=${JSON.stringify(report.checks)}`);
  if (!report.generatedToolCalls) {
    lines.push("warning=seed 未生成工具调用；本次仍验证 assistant append，但未覆盖 assistant→tool result 前缀。可重跑确认。 ");
  }
  return `${lines.join("\n")}\n`;
}

function hit(results: ProbeResult[], name: string): number {
  return results.find(item => item.name === name)?.usage.cacheHitTokens ?? 0;
}

function ratio(hitTokens: number, promptTokens: number): number {
  return promptTokens > 0 ? hitTokens / promptTokens : 0;
}

function parseOptions(args: string[]): ProbeOptions {
  let projectPath = ".";
  let role: ModelUsageRole = "agent";
  let timeoutMs = 180_000;
  let json = false;
  let allowProjectContent = false;
  const roles: ModelUsageRole[] = [
    "agent", "image", "flash", "drafter", "inline", "writer", "reviewer", "summarizer",
    "roleplay", "roleplay_perception", "roleplay_quality", "roleplay_memory",
  ];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--allow-project-content") { allowProjectContent = true; continue; }
    if (arg === "-p" || arg === "--project") { projectPath = requireValue(args, ++index, arg); continue; }
    if (arg === "-r" || arg === "--role") {
      const value = requireValue(args, ++index, arg) as ModelUsageRole;
      if (!roles.includes(value)) throw new Error(`role 无效：${value}`);
      role = value;
      continue;
    }
    if (arg === "--timeout") {
      timeoutMs = Number(requireValue(args, ++index, arg));
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("timeout 必须是不小于 1000 的整数");
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return { projectPath, role, timeoutMs, json, allowProjectContent };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} 缺少参数`);
  return value;
}

main().catch(error => {
  process.stderr.write(`缓存探针失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
