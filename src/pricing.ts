import type { TokenPricing } from "./types.js";

/** DeepSeek 峰谷计费：北京时间每日 09:00–12:00、14:00–18:00 为高峰，价格为平时 2 倍。 */
export const DEEPSEEK_PEAK_TIMEZONE = "Asia/Shanghai";
export const DEEPSEEK_PEAK_WINDOWS = [
  { start: "09:00", end: "12:00" },
  { start: "14:00", end: "18:00" },
] as const;
export const DEEPSEEK_PEAK_MULTIPLIER = 2;

export type TokenRates = { cacheHit: number; cacheMiss: number; output: number };

export function defaultPricing(provider: "deepseek" | "openai-compatible", model: string): TokenPricing {
  if (provider !== "deepseek") {
    return { cacheHit: 0, cacheMiss: 0, output: 0, currency: "CNY", contextWindow: 128_000 };
  }
  const offPeak = model === "deepseek-v4-pro"
    ? { cacheHit: 0.025, cacheMiss: 3, output: 6 }
    : { cacheHit: 0.02, cacheMiss: 1, output: 2 };
  return {
    ...offPeak,
    currency: "CNY",
    contextWindow: 1_000_000,
    peakBilling: {
      timezone: DEEPSEEK_PEAK_TIMEZONE,
      windows: DEEPSEEK_PEAK_WINDOWS.map((window) => ({ ...window })),
      cacheHit: offPeak.cacheHit * DEEPSEEK_PEAK_MULTIPLIER,
      cacheMiss: offPeak.cacheMiss * DEEPSEEK_PEAK_MULTIPLIER,
      output: offPeak.output * DEEPSEEK_PEAK_MULTIPLIER,
    },
  };
}

/** 解析并补全计费配置；DeepSeek 缺省峰谷规则时自动补上官方默认。 */
export function normalizePricing(
  provider: "deepseek" | "openai-compatible",
  model: string,
  input?: Partial<TokenPricing>,
  existing?: TokenPricing,
): TokenPricing {
  const defaults = defaultPricing(provider, model);
  const cacheHit = rate(input?.cacheHit ?? existing?.cacheHit, defaults.cacheHit);
  const cacheMiss = rate(input?.cacheMiss ?? existing?.cacheMiss, defaults.cacheMiss);
  const output = rate(input?.output ?? existing?.output, defaults.output);
  const currency = (input?.currency ?? existing?.currency) === "USD" ? "USD" as const : "CNY" as const;
  const contextWindow = Math.max(
    1_000,
    Math.round(rate(input?.contextWindow ?? existing?.contextWindow, defaults.contextWindow)),
  );
  // 显式传入 peakBilling 时尊重配置；DeepSeek 未显式指定则始终同步为官方峰谷（平时×2）
  let peakBilling: TokenPricing["peakBilling"];
  if (input?.peakBilling) {
    peakBilling = {
      timezone: input.peakBilling.timezone?.trim() || DEEPSEEK_PEAK_TIMEZONE,
      windows: normalizeWindows(input.peakBilling.windows)
        ?? defaults.peakBilling?.windows
        ?? DEEPSEEK_PEAK_WINDOWS.map((window) => ({ ...window })),
      cacheHit: rate(input.peakBilling.cacheHit, cacheHit * DEEPSEEK_PEAK_MULTIPLIER),
      cacheMiss: rate(input.peakBilling.cacheMiss, cacheMiss * DEEPSEEK_PEAK_MULTIPLIER),
      output: rate(input.peakBilling.output, output * DEEPSEEK_PEAK_MULTIPLIER),
    };
  } else if (provider === "deepseek") {
    peakBilling = {
      timezone: DEEPSEEK_PEAK_TIMEZONE,
      windows: DEEPSEEK_PEAK_WINDOWS.map((window) => ({ ...window })),
      cacheHit: cacheHit * DEEPSEEK_PEAK_MULTIPLIER,
      cacheMiss: cacheMiss * DEEPSEEK_PEAK_MULTIPLIER,
      output: output * DEEPSEEK_PEAK_MULTIPLIER,
    };
  } else if (existing?.peakBilling) {
    peakBilling = {
      timezone: existing.peakBilling.timezone?.trim() || DEEPSEEK_PEAK_TIMEZONE,
      windows: normalizeWindows(existing.peakBilling.windows)
        ?? DEEPSEEK_PEAK_WINDOWS.map((window) => ({ ...window })),
      cacheHit: rate(existing.peakBilling.cacheHit, cacheHit * DEEPSEEK_PEAK_MULTIPLIER),
      cacheMiss: rate(existing.peakBilling.cacheMiss, cacheMiss * DEEPSEEK_PEAK_MULTIPLIER),
      output: rate(existing.peakBilling.output, output * DEEPSEEK_PEAK_MULTIPLIER),
    };
  }
  return { cacheHit, cacheMiss, output, currency, contextWindow, peakBilling };
}

export function resolveRates(pricing: TokenPricing, at: Date = new Date()): TokenRates & { isPeak: boolean } {
  const offPeak = { cacheHit: pricing.cacheHit, cacheMiss: pricing.cacheMiss, output: pricing.output };
  const peak = pricing.peakBilling;
  if (!peak?.windows?.length) return { ...offPeak, isPeak: false };
  const isPeak = isInPeakWindow(at, peak.timezone || DEEPSEEK_PEAK_TIMEZONE, peak.windows);
  if (!isPeak) return { ...offPeak, isPeak: false };
  return {
    cacheHit: peak.cacheHit,
    cacheMiss: peak.cacheMiss,
    output: peak.output,
    isPeak: true,
  };
}

export function calculateUsageCost(
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number },
  pricing: TokenPricing,
  at: Date = new Date(),
): number {
  const miss = usage.cacheMissTokens || Math.max(0, usage.promptTokens - usage.cacheHitTokens);
  const rates = resolveRates(pricing, at);
  return (usage.cacheHitTokens * rates.cacheHit + miss * rates.cacheMiss + usage.completionTokens * rates.output) / 1_000_000;
}

export function isInPeakWindow(
  at: Date,
  timezone: string,
  windows: Array<{ start: string; end: string }>,
): boolean {
  const minutes = localMinutesOfDay(at, timezone);
  return windows.some((window) => {
    const start = parseClock(window.start);
    const end = parseClock(window.end);
    if (start == null || end == null) return false;
    if (start === end) return false;
    // half-open [start, end); support windows that wrap midnight
    if (start < end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end;
  });
}

function localMinutesOfDay(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  let hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  if (hour === 24) hour = 0;
  return hour * 60 + minute;
}

function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function normalizeWindows(
  windows: Array<{ start: string; end: string }> | undefined,
): Array<{ start: string; end: string }> | undefined {
  if (!Array.isArray(windows) || windows.length === 0) return undefined;
  const normalized = windows
    .map((window) => ({ start: String(window.start ?? "").trim(), end: String(window.end ?? "").trim() }))
    .filter((window) => parseClock(window.start) != null && parseClock(window.end) != null);
  return normalized.length ? normalized : undefined;
}

function rate(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
