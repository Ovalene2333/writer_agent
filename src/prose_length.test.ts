import test from "node:test";
import assert from "node:assert/strict";

import {
  assessProseLength,
  proseLengthOutcome,
  resolveTurnProseLength,
} from "./prose_length.js";
import type { ProseLengthSettings } from "./agent_runtime.js";

const settings = (patch?: Partial<ProseLengthSettings>): ProseLengthSettings => ({
  chapterTargetCharacters: 3_000,
  mode: "bounded",
  enforceMinimum: false,
  ...patch,
});

test("resolveTurnProseLength reads an explicit number out of the prompt", () => {
  assert.deepEqual(resolveTurnProseLength("这一章写 6000 字", settings()), {
    targetCharacters: 6_000,
    source: "prompt_exact",
    mode: "bounded",
  });
  assert.equal(resolveTurnProseLength("写个 1.5万字 的长章", settings()).targetCharacters, 15_000);
  assert.equal(resolveTurnProseLength("目标 3千字", settings()).targetCharacters, 3_000);
  assert.equal(resolveTurnProseLength("大概 4,500 字", settings()).targetCharacters, 4_500);
});

test("the last explicit number wins, and it is never scaled by a relative word", () => {
  // 用户是在补充修正前面说过的数字，不是要两个目标。
  assert.equal(resolveTurnProseLength("写 3000 字，不对，写 5000 字", settings()).targetCharacters, 5_000);
  // 「再长一点」已经被用户自己的数字取代了，替他乘 1.4 只会让结果不可预测。
  assert.equal(resolveTurnProseLength("写 3000 字，再长一点", settings()).targetCharacters, 3_000);
});

test("relative wording scales the project default, not the previous chapter", () => {
  assert.deepEqual(resolveTurnProseLength("这章写长一点", settings()), {
    targetCharacters: 4_200,
    source: "prompt_relative",
    mode: "bounded",
  });
  assert.equal(resolveTurnProseLength("这章短一点", settings()).targetCharacters, 2_100);
  assert.equal(resolveTurnProseLength("尽量长", settings()).targetCharacters, 5_400);
  assert.equal(resolveTurnProseLength("写得极简一些", settings()).targetCharacters, 1_500);
});

test("no length signal falls back to the project default", () => {
  assert.deepEqual(resolveTurnProseLength("接着写下一章", settings({ chapterTargetCharacters: 2_500 })), {
    targetCharacters: 2_500,
    source: "settings",
    mode: "bounded",
  });
});

test("resolved targets are clamped to the settable band", () => {
  assert.equal(resolveTurnProseLength("写 200 字", settings()).targetCharacters, 500);
  assert.equal(resolveTurnProseLength("写 80万字", settings()).targetCharacters, 50_000);
});

test("prose length outcome blocks over the ceiling but only warns under the target", () => {
  const short = assessProseLength(3_000, "字".repeat(1_000));
  const long = assessProseLength(3_000, "字".repeat(9_000));

  assert.equal(short.status, "too_short");
  assert.equal(long.status, "too_long");

  const shortOutcome = proseLengthOutcome(short, false);
  assert.equal(shortOutcome.blocked, false);
  assert.match(shortOutcome.notice ?? "", /低于目标/u);

  assert.equal(proseLengthOutcome(long, false).blocked, true);
  // 打开 enforceMinimum 就恢复旧的硬拦行为。
  assert.equal(proseLengthOutcome(short, true).blocked, true);
  assert.equal(proseLengthOutcome(long, false, "guidance").blocked, false);
  assert.match(proseLengthOutcome(long, false, "guidance").notice ?? "", /弱引导/u);
});

test("an on-target draft is neither blocked nor annotated", () => {
  const outcome = proseLengthOutcome(assessProseLength(3_000, "字".repeat(2_900)), true);
  assert.equal(outcome.blocked, false);
  assert.equal(outcome.notice, undefined);
});
