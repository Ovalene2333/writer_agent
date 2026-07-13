import type { StepUsage } from "./types.js";

/** One agent step trail, aligned with the Web StreamStep shape. */
export type UiStep = {
  id: number;
  status: "running" | "completed" | "failed";
  tools: string[];
  reasoning: string;
  output: string;
  usage?: StepUsage;
};

export function formatStepHeader(step: UiStep): string {
  const tools = step.tools.length ? step.tools.join(", ") : "（无工具）";
  const status =
    step.status === "running" ? "运行中"
      : step.status === "failed" ? "失败"
        : "完成";
  const usage = step.usage ? ` · ${formatStepUsageShort(step.usage)}` : "";
  return `── Step ${step.id} ${status} · ${tools}${usage} ──`;
}

export function formatStepUsageShort(usage: StepUsage): string {
  const currency = usage.currency === "CNY" ? "¥" : "$";
  const est = usage.estimated ? "~" : "";
  return `${est}${usage.totalTokens.toLocaleString()} tok · ${currency}${usage.cost.toFixed(4)}`;
}

export function formatStepUsageDetail(usage: StepUsage): string {
  const currency = usage.currency === "CNY" ? "¥" : "$";
  const hit = usage.cacheHitRate !== undefined
    ? ` · 缓存命中 ${(usage.cacheHitRate * 100).toFixed(1)}%`
    : "";
  return `本步 token${usage.estimated ? "（估算）" : ""}：输入 ${usage.promptTokens.toLocaleString()} · 输出 ${usage.completionTokens.toLocaleString()} · 缓存 ${usage.cacheHitTokens.toLocaleString()}${hit} · ${currency}${usage.cost.toFixed(6)}`;
}

/** Compact running-step line for the TUI status bar. */
export function formatActiveStepHint(steps: UiStep[]): string {
  const active = [...steps].reverse().find((item) => item.status === "running");
  if (!active) return "";
  const tools = active.tools.length ? ` · ${active.tools[active.tools.length - 1]}` : "";
  return ` · Step ${active.id}${tools}`;
}

export function truncateForDisplay(text: string, max = 2_400): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，共 ${text.length.toLocaleString()} 字）`;
}
