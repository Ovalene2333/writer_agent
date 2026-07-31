#!/usr/bin/env node
/**
 * Agent 前缀缓存探针：用项目真实 agent 模型复现「append-only 高命中 / 章切冷启动 /
 * 长 assistant 后一步偶发全 miss」是否在供应商侧可复现。
 *
 * 默认读 ../jn3 的 providers（Grok 本地反代等），拒绝 Claude 族模型。
 * 不打印提示词正文、工具参数或 API Key。
 *
 * 用法：
 *   npm run probe:agent-cache -- --project ../jn3 --allow-project-content
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  buildDynamicTurnMessages,
  buildStableSystemPrefix,
  projectCacheUserId,
} from "./agent.js";
import { isDeepSeekModel, samplingRequestOptions, thinkingRequestOptions } from "./model_compat.js";
import { modelFetch } from "./model_fetch.js";
import { parseModelTokenUsage } from "./model_usage.js";
import { WriterProject } from "./project.js";
import { ProviderManager } from "./provider_catalog.js";
import { WriterStore } from "./store.js";
import { agentToolsForTask } from "./tools/schema.js";
import type { MessageContent, ModelConfig, ModelTokenUsage, ModelUsageRole } from "./types.js";

type ProbeMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: ProbeToolCall[];
};

type ProbeToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type CaseResult = {
  name: string;
  messages: number;
  fingerprint: string;
  durationMs: number;
  usage: ModelTokenUsage;
  hitRate: number;
  /** Rough local expectation: previous case's prompt tokens when this is pure append. */
  expectedMinHit?: number;
  note?: string;
};

type ProbeOptions = {
  projectPath: string;
  role: ModelUsageRole;
  /** Substring match on model name, e.g. grok-4.5 */
  modelName?: string;
  /** Substring match on provider profile name, e.g. Grok */
  providerName?: string;
  timeoutMs: number;
  json: boolean;
  allowProjectContent: boolean;
  maxTokens: number;
  /** Match agent loop wire format (stream + include_usage). */
  stream: boolean;
};

const HELP = `Agent 前缀缓存探针（复现 jn3 Step6/8/12 类现象）

用法：
  npm run probe:agent-cache -- --project ../jn3 --allow-project-content

选项：
  -p, --project <path>   Writer 项目（读 providers + 稳定前缀），默认 ../jn3
  -r, --role <role>      模型角色，默认 agent（可被 --model 覆盖）
  --model <name>         按模型名子串选择（如 grok-4.5、deepseek-v4-flash）
  --provider <name>      按供应商名子串过滤（如 Grok、DeepSeek）
  --timeout <ms>         单次请求超时，默认 180000
  --max-tokens <n>       生成上限，默认 64（省费用）
  --stream               与 Agent 一致：stream + include_usage（更贴近线上）
  --json                 输出 JSON
  --allow-project-content
                         确认发送项目稳定提示词 / 工具 schema
  -h, --help             帮助

场景：
  cold_seed              冷启动
  append_1 / append_2    工具结果后连续 append（应高命中）
  long_tail              追加大段 assistant+tool 后再请求（对齐 Step6）
  long_tail_replay       与 long_tail 完全相同请求
  chapter_cut            截断到稳定+动态前缀 + 两段交接 user（对齐 Step8）
  chapter_cut_append     章切后再 append
  chapter_cut_replay     与 chapter_cut_append 相同

拒绝模型名含 claude 的配置。不输出提示词与 Key。`;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.allowProjectContent) {
    throw new Error("会把项目稳定提示词与工具 schema 发给供应商；确认后加 --allow-project-content");
  }
  const project = new WriterProject(options.projectPath);
  if (!project.exists()) throw new Error(`不是 Writer 项目：${options.projectPath}`);
  let store: WriterStore;
  try {
    store = new WriterStore(project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/disk I\/O|SQLITE|database/i.test(message)) {
      throw new Error(
        `${message}\n提示：jn3 的 writer.db 可能被占用。可复制 providers 到临时目录：\n`
        + `  mkdir -p /tmp/jn3-probe/.writer && cp ../jn3/writer.yaml /tmp/jn3-probe/ && `
        + `cp ../jn3/.writer/providers.json /tmp/jn3-probe/.writer/ && `
        + `npm run probe:agent-cache -- --project /tmp/jn3-probe --allow-project-content --model grok-4.5`,
      );
    }
    throw error;
  }
  try {
    const model = resolveProbeModel(project, options);
    assertNotClaude(model);
    if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
      throw new Error("API Key 未配置且不是本地 endpoint");
    }

    const tools = agentToolsForTask("general", "ask");
    const seedPrompt = "缓存诊断：只调用 list_documents，不要解释；无法调用工具时只回复 CACHE_SEED。";
    const baseMessages: ProbeMessage[] = [
      ...buildStableSystemPrefix(project, store, "ask", { intensive: false }, "general"),
      ...buildDynamicTurnMessages({
        historyText: "会话历史预览：agent 缓存探针，无历史。",
        archiveContext: "会话归档元数据：探针。",
        taskContext: "当前任务：验证前缀缓存。只做无副作用探针，不修改项目。",
        dynamicStyleContext: "本轮动态声线证据：无。",
        bootstrapContext: "写作线索：无。",
        todosPrompt: "当前对话任务清单：（空）",
        artifactContext: "本轮任务工作记忆：无。",
        selectedContext: "用户选区：无。",
        prompt: seedPrompt,
      }),
    ];
    const common = {
      model,
      tools,
      userId: isDeepSeekModel(model) ? projectCacheUserId(project.root) : undefined,
      timeoutMs: options.timeoutMs,
      maxTokens: options.maxTokens,
      stream: options.stream,
    };

    const cases: CaseResult[] = [];
    const seed = await requestProbe("cold_seed", baseMessages, common);
    cases.push(toCase("cold_seed", baseMessages, tools, seed, { note: "冷启动，低命中正常" }));

    const afterSeed = [
      ...baseMessages,
      seed.assistant,
      ...syntheticToolResults(seed.assistant, "seed"),
    ];
    const nextUser1 = "缓存诊断续步1：只回复 CACHE_A，不要调用工具。";
    const append1Msgs = [...afterSeed, { role: "user" as const, content: nextUser1 }];
    const append1 = await requestProbe("append_1", append1Msgs, common);
    cases.push(toCase("append_1", append1Msgs, tools, append1, {
      expectedMinHit: Math.floor(seed.usage.promptTokens * 0.5),
      note: "应吃到 seed 前缀",
    }));

    const afterAppend1 = [...append1Msgs, append1.assistant];
    const nextUser2 = "缓存诊断续步2：只回复 CACHE_B，不要调用工具。";
    const append2Msgs = [...afterAppend1, { role: "user" as const, content: nextUser2 }];
    const append2 = await requestProbe("append_2", append2Msgs, common);
    cases.push(toCase("append_2", append2Msgs, tools, append2, {
      expectedMinHit: Math.floor(append1.usage.promptTokens * 0.7),
      note: "纯 append，应对齐 jn3 Step9–11 高命中",
    }));

    // Long tail: simulate bulky propose_document assistant + tool body (Step 6 pattern).
    const longCallId = "probe_long_propose";
    const longAssistant: ProbeMessage = {
      role: "assistant",
      content: "[工具调用已隐藏]",
      tool_calls: [{
        id: longCallId,
        type: "function",
        function: {
          name: "propose_document",
          arguments: JSON.stringify({
            path: "chapters/probe-ch1.md",
            summary: "probe",
            content: "甲".repeat(6_000),
          }),
        },
      }],
    };
    const longTool: ProbeMessage = {
      role: "tool",
      tool_call_id: longCallId,
      content: JSON.stringify({
        status: "rejected",
        code: "PROSE_GATE",
        issues: Array.from({ length: 12 }, (_, i) => ({ id: i, detail: `探针问题${i}:${"乙".repeat(80)}` })),
      }),
    };
    const longMsgs = [
      ...afterAppend1,
      longAssistant,
      longTool,
      { role: "user" as const, content: "缓存诊断长尾后：只回复 CACHE_LONG，不要调用工具。" },
    ];
    const longTail = await requestProbe("long_tail", longMsgs, common);
    cases.push(toCase("long_tail", longMsgs, tools, longTail, {
      expectedMinHit: Math.floor(append1.usage.promptTokens * 0.7),
      note: "对齐 Step6：前缀应仍命中，仅尾部 miss",
    }));

    const longReplay = await requestProbe("long_tail_replay", longMsgs, common);
    cases.push(toCase("long_tail_replay", longMsgs, tools, longReplay, {
      expectedMinHit: Math.floor(longTail.usage.promptTokens * 0.85),
      note: "完全相同请求，命中应 ≥ long_tail",
    }));

    // Chapter cut: drop tool history, keep base + two handoff users (Step 8).
    const handoff1 = [
      "【章节交接·探针】上一章已交付。",
      "章末衔接：".padEnd(40, "丙") ,
      "状态摘要：".padEnd(40, "丁"),
      "已写状态与待续要点：".padEnd(80, "戊"),
    ].join("\n");
    const handoff2 = "下一章最小目标：从交接缝续写；优先复用材料架，勿无故重读。只回复 CACHE_CUT。";
    const cutMsgs: ProbeMessage[] = [
      ...baseMessages,
      { role: "user", content: handoff1 },
      { role: "user", content: handoff2 },
    ];
    const chapterCut = await requestProbe("chapter_cut", cutMsgs, common);
    cases.push(toCase("chapter_cut", cutMsgs, tools, chapterCut, {
      expectedMinHit: Math.floor(seed.usage.promptTokens * 0.6),
      note: "对齐 Step8：应至少命中稳定+动态前缀；全 miss 为异常",
    }));

    const cutAppendMsgs = [
      ...cutMsgs,
      chapterCut.assistant,
      { role: "user" as const, content: "章切后续步：只回复 CACHE_CUT2，不要调用工具。" },
    ];
    const cutAppend = await requestProbe("chapter_cut_append", cutAppendMsgs, common);
    cases.push(toCase("chapter_cut_append", cutAppendMsgs, tools, cutAppend, {
      expectedMinHit: Math.floor(chapterCut.usage.promptTokens * 0.7),
      note: "对齐 Step9：章切后下一步应恢复高命中",
    }));

    const cutReplay = await requestProbe("chapter_cut_replay", cutAppendMsgs, common);
    cases.push(toCase("chapter_cut_replay", cutAppendMsgs, tools, cutReplay, {
      expectedMinHit: Math.floor(cutAppend.usage.promptTokens * 0.85),
      note: "相同请求复放",
    }));

    const report = {
      provider: model.providerName ?? model.provider ?? "unknown",
      model: model.model,
      baseUrl: redactUrl(model.baseUrl),
      role: options.role,
      toolCount: tools.length,
      seedToolCalls: seed.assistant.tool_calls?.length ?? 0,
      cases: cases.map(({ fingerprint: _fp, ...rest }) => rest),
      verdicts: buildVerdicts(cases),
    };
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  } finally {
    store.close();
  }
}

function toCase(
  name: string,
  messages: ProbeMessage[],
  tools: readonly unknown[],
  result: { durationMs: number; usage: ModelTokenUsage; assistant: ProbeMessage },
  extra: { expectedMinHit?: number; note?: string } = {},
): CaseResult {
  return {
    name,
    messages: messages.length,
    fingerprint: fingerprint(messages, tools),
    durationMs: result.durationMs,
    usage: result.usage,
    hitRate: ratio(result.usage.cacheHitTokens, result.usage.promptTokens),
    ...extra,
  };
}

async function requestProbe(
  name: string,
  messages: ProbeMessage[],
  options: {
    model: ModelConfig;
    tools: readonly unknown[];
    userId?: string;
    timeoutMs: number;
    maxTokens: number;
    stream: boolean;
  },
): Promise<{ durationMs: number; usage: ModelTokenUsage; assistant: ProbeMessage }> {
  const endpoint = `${options.model.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
  const body = JSON.stringify({
    model: options.model.model,
    messages,
    tools: options.tools,
    ...(options.userId ? { user_id: options.userId } : {}),
    stream: options.stream,
    ...(options.stream ? { stream_options: { include_usage: true } } : {}),
    max_tokens: options.maxTokens,
    ...thinkingRequestOptions(options.model),
    ...samplingRequestOptions(options.model),
  });
  const started = Date.now();
  const response = await modelFetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.model.apiKey ? { authorization: `Bearer ${options.model.apiKey}` } : {}),
    },
    body,
    signal: AbortSignal.timeout(options.timeoutMs),
  }, options.model.proxyUrl);
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`${name} 失败（${response.status}）：${raw.slice(0, 280)}`);
  }
  if (options.stream) {
    const streamed = await consumeChatStream(response, name);
    return { durationMs: Date.now() - started, usage: streamed.usage, assistant: streamed.assistant };
  }
  const raw = await response.text();
  const payload = JSON.parse(raw) as {
    choices?: Array<{ message?: Record<string, unknown> }>;
    usage?: unknown;
  };
  const usage = parseModelTokenUsage(payload.usage);
  if (!usage) throw new Error(`${name} 无 usage，无法判断缓存`);
  return {
    durationMs: Date.now() - started,
    usage,
    assistant: normalizeAssistant(payload.choices?.[0]?.message),
  };
}

async function consumeChatStream(
  response: Response,
  name: string,
): Promise<{ usage: ModelTokenUsage; assistant: ProbeMessage }> {
  if (!response.body) throw new Error(`${name} 无响应体`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  const toolCalls = new Map<number, ProbeToolCall>();
  let usage: ModelTokenUsage | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const chunks = buffer.split(/\r?\n/);
    buffer = done ? "" : (chunks.pop() ?? "");
    for (const line of chunks) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event: {
        choices?: Array<{
          delta?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: unknown;
      };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        continue;
      }
      const delta = event.choices?.[0]?.delta;
      if (typeof delta?.content === "string") content += delta.content;
      if (typeof delta?.reasoning_content === "string") reasoning += delta.reasoning_content;
      for (const call of delta?.tool_calls ?? []) {
        const index = typeof call.index === "number" ? call.index : 0;
        const current = toolCalls.get(index) ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (typeof call.id === "string" && call.id) current.id = call.id;
        if (typeof call.function?.name === "string" && call.function.name) {
          current.function.name += call.function.name;
        }
        if (typeof call.function?.arguments === "string") {
          current.function.arguments += call.function.arguments;
        }
        toolCalls.set(index, current);
      }
      const parsedUsage = parseModelTokenUsage(event.usage);
      if (parsedUsage) usage = parsedUsage;
    }
    if (done) break;
  }
  if (!usage) throw new Error(`${name} 流式响应无 usage（需 stream_options.include_usage）`);
  const calls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => call)
    .filter(call => call.id && call.function.name);
  return {
    usage,
    assistant: {
      role: "assistant",
      content: content || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
    },
  };
}

function normalizeAssistant(value: Record<string, unknown> | undefined): ProbeMessage {
  if (!value) throw new Error("缺少 assistant message");
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

function syntheticToolResults(assistant: ProbeMessage, tag: string): ProbeMessage[] {
  return (assistant.tool_calls ?? []).map(call => ({
    role: "tool" as const,
    tool_call_id: call.id,
    content: JSON.stringify({ status: "probe", tag, tool: call.function.name, documents: [] }),
  }));
}

function fingerprint(messages: ProbeMessage[], tools: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify({ messages, tools })).digest("hex").slice(0, 16);
}

function buildVerdicts(cases: CaseResult[]): Record<string, { pass: boolean; detail: string }> {
  const by = (name: string) => cases.find(item => item.name === name);
  const cold = by("cold_seed");
  const a1 = by("append_1");
  const a2 = by("append_2");
  const long = by("long_tail");
  const longR = by("long_tail_replay");
  const cut = by("chapter_cut");
  const cutA = by("chapter_cut_append");
  const cutR = by("chapter_cut_replay");

  const nearZero = (usage?: ModelTokenUsage) =>
    !!usage && usage.promptTokens >= 8_000 && usage.cacheHitTokens <= 256;

  return {
    appendRecoversAfterCold: {
      // Cold may already be warm if the provider reused a prior probe/session prefix.
      pass: !!a1 && !!cold && (
        a1.usage.cacheHitTokens > cold.usage.cacheHitTokens
        || a1.hitRate >= 0.5
        || cold.hitRate >= 0.5
      ),
      detail: `append_1 hit ${a1?.usage.cacheHitTokens ?? 0} (rate ${((a1?.hitRate ?? 0) * 100).toFixed(1)}%) vs cold ${cold?.usage.cacheHitTokens ?? 0}`,
    },
    append2StaysHot: {
      pass: !!a2 && a2.hitRate >= 0.5,
      detail: `append_2 hitRate=${((a2?.hitRate ?? 0) * 100).toFixed(1)}% hit=${a2?.usage.cacheHitTokens ?? 0}`,
    },
    longTailNotFullMiss: {
      pass: !!long && !nearZero(long.usage),
      detail: nearZero(long?.usage)
        ? `异常全 miss：prompt=${long!.usage.promptTokens} hit=${long!.usage.cacheHitTokens}（对齐 Step6）`
        : `long_tail hit=${long?.usage.cacheHitTokens ?? 0} / ${long?.usage.promptTokens ?? 0}`,
    },
    longTailReplayAtLeastPrior: {
      pass: !!long && !!longR && longR.usage.cacheHitTokens >= long.usage.cacheHitTokens,
      detail: `replay ${longR?.usage.cacheHitTokens ?? 0} vs long ${long?.usage.cacheHitTokens ?? 0}`,
    },
    chapterCutKeepsStablePrefix: {
      pass: !!cut && !nearZero(cut.usage),
      detail: nearZero(cut?.usage)
        ? `异常：章切后稳定前缀也几乎未命中 prompt=${cut!.usage.promptTokens} hit=${cut!.usage.cacheHitTokens}（对齐 Step8）`
        : `chapter_cut hit=${cut?.usage.cacheHitTokens ?? 0} / ${cut?.usage.promptTokens ?? 0}`,
    },
    chapterCutAppendRecovers: {
      pass: !!cutA && cutA.hitRate >= 0.5,
      detail: `chapter_cut_append hitRate=${((cutA?.hitRate ?? 0) * 100).toFixed(1)}%`,
    },
    chapterCutReplayStable: {
      pass: !!cutA && !!cutR && cutR.usage.cacheHitTokens >= Math.floor((cutA.usage.cacheHitTokens || 1) * 0.8),
      detail: `replay ${cutR?.usage.cacheHitTokens ?? 0} vs append ${cutA?.usage.cacheHitTokens ?? 0}`,
    },
  };
}

function formatReport(report: {
  provider: string;
  model: string;
  baseUrl: string;
  role: string;
  toolCount: number;
  seedToolCalls: number;
  cases: Array<Omit<CaseResult, "fingerprint">>;
  verdicts: Record<string, { pass: boolean; detail: string }>;
}): string {
  const lines = [
    `Agent cache probe: ${report.provider} / ${report.model}`,
    `endpoint=${report.baseUrl} role=${report.role} tools=${report.toolCount} seedToolCalls=${report.seedToolCalls}`,
    "",
    "case                 msgs   prompt    hit   miss  hitRate   dur  note",
  ];
  for (const item of report.cases) {
    const flag = item.expectedMinHit !== undefined && item.usage.cacheHitTokens < item.expectedMinHit
      ? "!"
      : " ";
    lines.push([
      flag + item.name.padEnd(18),
      String(item.messages).padStart(5),
      String(item.usage.promptTokens).padStart(8),
      String(item.usage.cacheHitTokens).padStart(6),
      String(item.usage.cacheMissTokens).padStart(6),
      `${(item.hitRate * 100).toFixed(1)}%`.padStart(8),
      `${item.durationMs}ms`.padStart(7),
      item.note ?? "",
    ].join(" "));
  }
  lines.push("", "verdicts:");
  for (const [name, verdict] of Object.entries(report.verdicts)) {
    lines.push(`  ${verdict.pass ? "PASS" : "FAIL"}  ${name}: ${verdict.detail}`);
  }
  const failed = Object.values(report.verdicts).filter(item => !item.pass).length;
  lines.push("", failed ? `summary: ${failed} 项未通过（见 FAIL，可对照 jn3 Step6/8/12）` : "summary: 全部通过");
  return `${lines.join("\n")}\n`;
}

function resolveProbeModel(project: WriterProject, options: ProbeOptions): ModelConfig {
  const manager = new ProviderManager(project);
  if (!options.modelName && !options.providerName) {
    return manager.modelConfig(options.role);
  }
  // Read raw providers (with keys) without assign/persist side effects.
  const saved = JSON.parse(
    readFileSync(join(project.privateDir, "providers.json"), "utf8"),
  ) as {
    providers: Array<{
      id: string;
      name: string;
      provider: ModelConfig["provider"];
      baseUrl: string;
      proxyUrl?: string;
      apiKey?: string;
      models: Array<{
        id: string;
        name: string;
        pricing?: ModelConfig["pricing"];
        temperature?: number;
        topP?: number;
        frequencyPenalty?: number;
        presencePenalty?: number;
        reasoningEffort?: ModelConfig["reasoningEffort"];
        verbosity?: ModelConfig["verbosity"];
        disableSampling?: boolean;
        supportsMultimodal?: boolean;
      }>;
    }>;
  };
  const modelNeedle = options.modelName?.toLowerCase();
  const providerNeedle = options.providerName?.toLowerCase();
  const hits: Array<{ profile: (typeof saved.providers)[number]; model: (typeof saved.providers)[number]["models"][number] }> = [];
  for (const profile of saved.providers) {
    if (providerNeedle && !profile.name.toLowerCase().includes(providerNeedle)) continue;
    for (const model of profile.models) {
      if (modelNeedle && !model.name.toLowerCase().includes(modelNeedle)) continue;
      hits.push({ profile, model });
    }
  }
  if (!hits.length) {
    const available = saved.providers.flatMap(p => p.models.map(m => `${p.name}/${m.name}`)).join(", ");
    throw new Error(
      `未找到匹配模型（provider=${options.providerName ?? "*"} model=${options.modelName ?? "*"}）。可用：${available}`,
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `匹配到多个模型，请收窄 --provider/--model：${hits.map(h => `${h.profile.name}/${h.model.name}`).join(", ")}`,
    );
  }
  const { profile, model } = hits[0];
  const baseUrl = process.env.WRITER_BASE_URL || profile.baseUrl;
  return {
    provider: baseUrl.includes("api.deepseek.com") ? "deepseek" : profile.provider,
    providerName: profile.name,
    baseUrl,
    proxyUrl: process.env.WRITER_PROXY_URL || profile.proxyUrl,
    apiKey: process.env.WRITER_API_KEY || profile.apiKey || "",
    model: process.env.WRITER_MODEL || model.name,
    pricing: model.pricing,
    temperature: model.temperature,
    topP: model.topP,
    frequencyPenalty: model.frequencyPenalty,
    presencePenalty: model.presencePenalty,
    reasoningEffort: model.reasoningEffort,
    verbosity: model.verbosity,
    disableSampling: model.disableSampling,
    supportsMultimodal: model.supportsMultimodal,
  };
}

function assertNotClaude(model: ModelConfig): void {
  const blob = `${model.model} ${model.providerName ?? ""} ${model.baseUrl}`.toLowerCase();
  if (blob.includes("claude")) {
    throw new Error(`拒绝使用 Claude 族模型（当前 ${model.providerName ?? "?"} / ${model.model}）。请把 agent 指到 Grok/DeepSeek 等后重试。`);
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/u, "") || ""}`;
  } catch {
    return url.replace(/\/\/[^/]+@/u, "//***@");
  }
}

function ratio(hitTokens: number, promptTokens: number): number {
  return promptTokens > 0 ? hitTokens / promptTokens : 0;
}

function parseOptions(args: string[]): ProbeOptions {
  let projectPath = "../jn3";
  let role: ModelUsageRole = "agent";
  let modelName: string | undefined;
  let providerName: string | undefined;
  let timeoutMs = 180_000;
  let json = false;
  let allowProjectContent = false;
  let maxTokens = 64;
  let stream = false;
  const roles: ModelUsageRole[] = [
    "agent", "flash", "drafter", "inline", "writer", "reviewer", "summarizer",
    "roleplay", "roleplay_perception", "roleplay_quality", "roleplay_memory",
  ];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--stream") { stream = true; continue; }
    if (arg === "--allow-project-content") { allowProjectContent = true; continue; }
    if (arg === "-p" || arg === "--project") { projectPath = requireValue(args, ++index, arg); continue; }
    if (arg === "-r" || arg === "--role") {
      const value = requireValue(args, ++index, arg) as ModelUsageRole;
      if (!roles.includes(value)) throw new Error(`role 无效：${value}`);
      role = value;
      continue;
    }
    if (arg === "--model") { modelName = requireValue(args, ++index, arg); continue; }
    if (arg === "--provider") { providerName = requireValue(args, ++index, arg); continue; }
    if (arg === "--timeout") {
      timeoutMs = Number(requireValue(args, ++index, arg));
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("timeout 无效");
      continue;
    }
    if (arg === "--max-tokens") {
      maxTokens = Number(requireValue(args, ++index, arg));
      if (!Number.isInteger(maxTokens) || maxTokens < 16) throw new Error("max-tokens 无效");
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return { projectPath, role, modelName, providerName, timeoutMs, json, allowProjectContent, maxTokens, stream };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} 缺少参数`);
  return value;
}

main().catch(error => {
  process.stderr.write(`探针失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
