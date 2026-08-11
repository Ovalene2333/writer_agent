import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveredDocumentEvidence,
  fallbackDocumentMutationSummary,
} from "./delivery_evidence.js";

test("document mutation summaries and fulfillment evidence carry bounded body facts", () => {
  const content = "# 第三章 康复\n\n林千夏扶着训练架走完第一圈。\n\n她在正式训练通知上签下自己的名字。";
  const summary = fallbackDocumentMutationSummary("edit", "chapters/chapter-03.md", content);
  assert.match(summary, /第三章 康复/u);
  assert.match(summary, /训练架/u);
  assert.match(summary, /正式训练通知/u);

  const delivered = deliveredDocumentEvidence({
    path: "chapters/chapter-03.md",
    summary: "完成康复并确认进入正式训练",
    content,
    status: "accepted",
  });
  assert.match(delivered, /已接受/u);
  assert.match(delivered, /正文证据/u);
  assert.match(delivered, /正式训练通知/u);
});
