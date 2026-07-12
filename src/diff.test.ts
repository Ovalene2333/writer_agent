import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { documentDiff, renderDiffHtml } from "./diff.js";

describe("documentDiff", () => {
  it("marks pure insertions and deletions", () => {
    assert.deepEqual(documentDiff("", "hello"), [{ type: "add", text: "hello" }]);
    assert.deepEqual(documentDiff("bye", ""), [{ type: "remove", text: "bye" }]);
  });

  it("keeps equal lines and highlights word edits", () => {
    const parts = documentDiff("甲乙丙", "甲丁丙");
    assert.deepEqual(parts, [
      { type: "equal", text: "甲" },
      { type: "remove", text: "乙" },
      { type: "add", text: "丁" },
      { type: "equal", text: "丙" },
    ]);
  });

  it("renders track-changes HTML with strikethrough and insert marks", () => {
    const html = renderDiffHtml([
      { type: "equal", text: "A" },
      { type: "remove", text: "B" },
      { type: "add", text: "C" },
    ]);
    assert.equal(html, 'A<del class="diff-remove">B</del><ins class="diff-add">C</ins>');
  });

  it("escapes HTML in content", () => {
    const html = renderDiffHtml([{ type: "add", text: "<script>" }]);
    assert.equal(html, '<ins class="diff-add">&lt;script&gt;</ins>');
  });
});
