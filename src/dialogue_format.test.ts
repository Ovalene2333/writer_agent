import assert from "node:assert/strict";
import { test } from "node:test";
import { auditDialogueFormat, dialogueFormatGateError } from "./dialogue_format.js";

test("canonical direct and nested dialogue delimiters pass", () => {
  assert.deepEqual(auditDialogueFormat("「他留下『去北站』的纸条。」她说。"), []);
});

test("curly and ASCII quotes are reported, and block when a speech tag makes them dialogue", () => {
  const curly = auditDialogueFormat("“别走。”他说。");
  assert.equal(curly.length, 1);
  assert.equal(curly[0].code, "nonstandard_quote");
  assert.equal(curly[0].blocksProposal, true);

  const ascii = auditDialogueFormat('"别走。"他说。');
  assert.equal(ascii.length, 1);
  assert.equal(ascii[0].code, "nonstandard_quote");
  assert.equal(ascii[0].blocksProposal, true);

  const written = auditDialogueFormat("她盯着纸上的“永远等你”三个字。 ");
  assert.equal(written[0].blocksProposal, false);
  assert.equal(dialogueFormatGateError("她盯着纸上的“永远等你”三个字。"), undefined);
});

test("unmatched and misnested delimiters return a repairable blocking error", () => {
  const issues = auditDialogueFormat("「他说『先走。」");
  assert.ok(issues.some(issue => issue.code === "misnested_quote"));
  assert.ok(issues.some(issue => issue.code === "unmatched_quote"));
  assert.match(dialogueFormatGateError("「没闭合。") ?? "", /对白引号格式拦截/u);
});
