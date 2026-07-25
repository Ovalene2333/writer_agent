import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateUsageCost,
  defaultPricing,
  isInPeakWindow,
  normalizePricing,
  resolveRates,
} from "./pricing.js";

const SHANGHAI = "Asia/Shanghai";
const WINDOWS = [
  { start: "09:00", end: "12:00" },
  { start: "14:00", end: "18:00" },
];

/** Build a Date that is the given wall-clock time in Asia/Shanghai. */
function shanghaiTime(year: number, month: number, day: number, hour: number, minute = 0): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour - 8, minute, 0);
  // Refine via formatter in case of DST edge cases (CST has no DST, so one pass is enough)
  return new Date(utcGuess);
}

test("default DeepSeek pricing includes official peak-valley rates", () => {
  const flash = defaultPricing("deepseek", "deepseek-v4-flash");
  assert.equal(flash.cacheMiss, 1);
  assert.equal(flash.output, 2);
  assert.equal(flash.cacheHit, 0.02);
  assert.ok(flash.peakBilling);
  assert.equal(flash.peakBilling!.cacheMiss, 2);
  assert.equal(flash.peakBilling!.output, 4);
  assert.equal(flash.peakBilling!.cacheHit, 0.04);
  assert.equal(flash.peakBilling!.timezone, SHANGHAI);

  const pro = defaultPricing("deepseek", "deepseek-v4-pro");
  assert.equal(pro.cacheMiss, 3);
  assert.equal(pro.output, 6);
  assert.equal(pro.peakBilling!.cacheMiss, 6);
  assert.equal(pro.peakBilling!.output, 12);
});

test("isInPeakWindow matches DeepSeek Beijing peak hours", () => {
  // 10:30 Beijing = peak
  assert.equal(isInPeakWindow(shanghaiTime(2026, 7, 12, 10, 30), SHANGHAI, WINDOWS), true);
  // 09:00 inclusive
  assert.equal(isInPeakWindow(shanghaiTime(2026, 7, 12, 9, 0), SHANGHAI, WINDOWS), true);
  // 12:00 exclusive
  assert.equal(isInPeakWindow(shanghaiTime(2026, 7, 12, 12, 0), SHANGHAI, WINDOWS), false);
  // 15:00 peak
  assert.equal(isInPeakWindow(shanghaiTime(2026, 7, 12, 15, 0), SHANGHAI, WINDOWS), true);
  // 18:00 exclusive
  assert.equal(isInPeakWindow(shanghaiTime(2026, 7, 12, 18, 0), SHANGHAI, WINDOWS), false);
  // 20:00 off-peak
  assert.equal(isInPeakWindow(shanghaiTime(2026, 7, 12, 20, 0), SHANGHAI, WINDOWS), false);
  // 08:59 off-peak
  assert.equal(isInPeakWindow(shanghaiTime(2026, 7, 12, 8, 59), SHANGHAI, WINDOWS), false);
});

test("resolveRates doubles cost during peak", () => {
  const pricing = defaultPricing("deepseek", "deepseek-v4-flash");
  const peak = resolveRates(pricing, shanghaiTime(2026, 7, 12, 10, 0));
  const off = resolveRates(pricing, shanghaiTime(2026, 7, 12, 21, 0));
  assert.equal(peak.isPeak, true);
  assert.equal(peak.cacheMiss, 2);
  assert.equal(peak.output, 4);
  assert.equal(off.isPeak, false);
  assert.equal(off.cacheMiss, 1);
  assert.equal(off.output, 2);
});

test("calculateUsageCost uses peak rates at peak time", () => {
  const pricing = defaultPricing("deepseek", "deepseek-v4-flash");
  const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, cacheHitTokens: 0, cacheMissTokens: 1_000_000 };
  const peakCost = calculateUsageCost(usage, pricing, shanghaiTime(2026, 7, 12, 10, 0));
  const offCost = calculateUsageCost(usage, pricing, shanghaiTime(2026, 7, 12, 21, 0));
  // off: 1*1 + 1*2 = 3; peak: 1*2 + 1*4 = 6
  assert.equal(offCost, 3);
  assert.equal(peakCost, 6);
});

test("unmetered pricing records no usage cost", () => {
  const pricing = { ...defaultPricing("deepseek", "deepseek-v4-flash"), billingMode: "unmetered" as const };
  const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, cacheHitTokens: 0, cacheMissTokens: 1_000_000 };
  assert.equal(calculateUsageCost(usage, pricing, shanghaiTime(2026, 7, 12, 10, 0)), 0);
});

test("normalizePricing backfills peak billing for DeepSeek", () => {
  const normalized = normalizePricing("deepseek", "deepseek-v4-pro", undefined, {
    cacheHit: 0.025,
    cacheMiss: 3,
    output: 6,
    currency: "CNY",
    contextWindow: 1_000_000,
  });
  assert.ok(normalized.peakBilling);
  assert.equal(normalized.peakBilling!.cacheMiss, 6);
  assert.deepEqual(normalized.peakBilling!.windows, WINDOWS);
});

test("normalizePricing persists and can switch billing modes", () => {
  const unmetered = normalizePricing("openai-compatible", "subscription-model", {
    billingMode: "unmetered",
  });
  assert.equal(unmetered.billingMode, "unmetered");
  const metered = normalizePricing("openai-compatible", "subscription-model", {
    billingMode: "metered",
  }, unmetered);
  assert.equal(metered.billingMode, "metered");
});
