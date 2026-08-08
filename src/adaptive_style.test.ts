import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adaptiveQualityWarnings,
  analyzeAdaptiveStyle,
} from "./adaptive_style.js";
import { analyzeDialogueTexture, dialogueNaturalnessGuidance } from "./dialogue_texture.js";

/**
 * Padding so the analyzer clears MIN_DIALOGUE_LINES without shaping the result.
 * Deliberately non-repeating: adjacent near-duplicate lines are themselves an
 * echo, so a templated filler would seed the very signal under test.
 */
const FILLER = [
  "「西侧仓库的配额单我下午送过去。」",
  "「先把冷链那批点清楚，别再压在月底。」",
  "「三号泵还在等件，工期得往后挪两天。」",
  "「挪之前跟调度打声招呼，别让他们空等。」",
  "「南门的门禁昨天换了新卡，旧的都作废了。」",
  "「那我这张也得重新办一遍。」",
  "「表在值班室，填完压在玻璃板下面就行。」",
  "「今晚谁盯夜班。」",
  "「原本排的老周，他家里临时有事，换成我了。」",
  "「食堂那边说十点以后就没热的了。」",
  "「带了面包，不用管我。」",
  "「东区的灯还是一闪一闪，报修单交上去半个月了。」",
].join("\n\n");

const CLIPPED_DIALOGUE = Array.from({ length: 16 }, (_, index) => (
  index % 4 === 0 ? "「知道。」" : index % 4 === 1 ? "「明白。」" : index % 4 === 2 ? "「下来。」" : "「可以。」"
)).join("\n\n");

test("restating the previous line before replying is reported as an echo", () => {
  const echoed = [
    "「值班记录昨晚被人调阅过两次，两次都在换班前后。」",
    "「值班记录昨晚被人调阅过两次——所以你是在说有人趁换班动了它。」",
    "「撤离令的签发人一栏是空的，谁也没有补。」",
    "「撤离令的签发人一栏是空的，那这份命令根本没人认账。」",
    FILLER,
  ].join("\n\n");
  const echo = analyzeDialogueTexture(echoed).issues.find(issue => issue.code === "dialogue_echo");
  assert.ok(echo, "adjacent restatement must surface as dialogue_echo");
  assert.ok(echo!.examples.length >= 1);

  // A short line thrown back in disbelief is a move, not a restatement.
  const disbelief = [
    "「他没来过。」", "「他没来过？」", "「记录上没有他。」", "「记录上没有他？」", FILLER,
  ].join("\n\n");
  assert.ok(!analyzeDialogueTexture(disbelief).issues.some(issue => issue.code === "dialogue_echo"));
});

test("questions answered by questions are reported as continuation hooks", () => {
  const hooks = [
    "「你昨晚去哪了？」", "「你为什么问这个？」",
    "「那份名单还在你手上吗？」", "「你觉得它应该在谁手上？」",
    "「你打算怎么交代？」", "「你希望我怎么交代？」",
    FILLER,
  ].join("\n\n");
  const hook = analyzeDialogueTexture(hooks).issues.find(issue => issue.code === "dialogue_question_hook");
  assert.ok(hook, "consecutive question pairs must surface as dialogue_question_hook");
  assert.ok(!analyzeDialogueTexture(FILLER).issues.some(issue => issue.code === "dialogue_question_hook"));
});

test("dialogue contract carries the three hard bans", () => {
  const guidance = dialogueNaturalnessGuidance();
  assert.match(guidance, /不把问句当续聊钩子/u);
  assert.match(guidance, /不复述对方原句/u);
  assert.match(guidance, /不解释情绪与动机/u);
});

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
