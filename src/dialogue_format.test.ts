import assert from "node:assert/strict";
import { test } from "node:test";
import { auditDialogueFormat, dialogueFormatGateError } from "./dialogue_format.js";

test("canonical direct and nested dialogue delimiters pass", () => {
  assert.deepEqual(auditDialogueFormat("「他留下『去北站』的纸条。」她说。"), []);
});

test("curly and ASCII dialogue quotes are accepted", () => {
  assert.deepEqual(auditDialogueFormat("“别走。”他说。"), []);
  assert.deepEqual(auditDialogueFormat('"别走。"他说。'), []);
  assert.deepEqual(auditDialogueFormat("她盯着纸上的“永远等你”三个字。"), []);
  assert.equal(dialogueFormatGateError("“别走。”他说。"), undefined);
  assert.equal(dialogueFormatGateError('"别走。"他说。'), undefined);
});

test("unmatched and misnested delimiters return a repairable blocking error", () => {
  const issues = auditDialogueFormat("「他说『先走。」");
  assert.ok(issues.some(issue => issue.code === "misnested_quote"));
  assert.ok(issues.some(issue => issue.code === "unmatched_quote"));
  assert.match(dialogueFormatGateError("「没闭合。") ?? "", /对白引号格式拦截/u);
  assert.match(dialogueFormatGateError("「没闭合。") ?? "", /不强制统一样式/u);
});
