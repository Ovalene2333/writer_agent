import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adaptiveQualityWarnings,
  analyzeAdaptiveStyle,
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
});
