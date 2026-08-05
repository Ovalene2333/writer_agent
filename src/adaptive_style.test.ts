import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adaptiveQualityWarnings,
  analyzeAdaptiveStyle,
  chapterAdaptiveStyleFeedback,
  groundedAdaptiveRevisionInstructions,
} from "./adaptive_style.js";

const CLIPPED_DIALOGUE = Array.from({ length: 16 }, (_, index) => (
  index % 4 === 0 ? "「知道。」" : index % 4 === 1 ? "「明白。」" : index % 4 === 2 ? "「下来。」" : "「可以。」"
)).join("\n\n");

test("compound dialogue shape becomes one semantic adaptive issue", () => {
  const analysis = analyzeAdaptiveStyle(CLIPPED_DIALOGUE);
  assert.ok(analysis.issues.some(issue => issue.code === "dialogue_exchange_compressed"));
  const warnings = adaptiveQualityWarnings(analysis);
  assert.equal(warnings.filter(warning => [
    "dialogue_exchange_compressed",
    "dialogue_clipped",
    "dialogue_monotone",
    "dialogue_homogeneous",
    "dialogue_bookish",
  ].includes(warning.code)).length, 1);
  assert.match(groundedAdaptiveRevisionInstructions(CLIPPED_DIALOGUE).join("\n"), /承接上一句|争取条件/u);
});

test("uniform narration asks for semantic continuation instead of a long-sentence quota", () => {
  const narration = Array.from({ length: 28 }, (_, index) => (
    `${index % 2 ? "门外" : "走廊"}的冷气贴着金属墙缓慢移动，他听见远处的锁舌又响了一次。`
  )).join("\n\n");
  const instructions = groundedAdaptiveRevisionInstructions(narration).join("\n");
  assert.match(instructions, /同一对象|动作链|心理转向/u);
  assert.doesNotMatch(instructions, /35\s*字|长句.{0,4}\d+%|至少.{0,4}\d/u);
});

test("chapter feedback carries prior negative evidence even before scene one", () => {
  const prior = Array.from({ length: 6 }, () => "她沿着走廊停在门前。 ").join("\n\n");
  const feedback = chapterAdaptiveStyleFeedback({ chapterSoFar: "", priorChapterText: prior });
  assert.match(feedback.join("\n"), /上一章高频/u);
});

