import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { parseWritingMemoryCandidates } from "./writing_memory.js";

test("writing memory parser requires verbatim evidence and known character ids", () => {
  const content = "闻溪低声说：『先别惊动他们。』";
  const parsed = parseWritingMemoryCandidates(JSON.stringify([
    {
      kind: "dialogue_voice",
      content: "闻溪在有旁听者时采用压低音量的短句",
      characterIds: [3, 99],
      importance: 70,
      sourceEvidence: "『先别惊动他们。』",
    },
    {
      kind: "knowledge",
      content: "不存在的证据不得进入记忆",
      characterIds: [3],
      sourceEvidence: "正文里没有这一句",
    },
  ]), content, [3]);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0]?.characterIds, [3]);
});

test("writing memory is session-scoped, follows source text, and rewinds with its message", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-session-memory-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "会话记忆");
    const path = "chapters/001.md";
    const beforeContent = "# 第一章\n\n";
    const content = "# 第一章\n\n闻溪说：『先别惊动他们。』\n";
    project.writeTextFile(path, beforeContent);
    store = new WriterStore(project);
    const sessionId = store.createSession("写作");
    const otherSessionId = store.createSession("隔离");
    const sourceMessageId = store.addMessage(sessionId, "user", "写第一章", "agent");
    const proposal = store.createProposal(
      sessionId, path, content, "续写第一章", [], undefined, sourceMessageId,
    );
    store.acceptProposal(proposal.id);
    store.saveExtractedWritingMemory(sessionId, sourceMessageId, path, content, 1, [{
      kind: "dialogue_voice",
      content: "闻溪用短句压低事态",
      characterIds: [],
      importance: 70,
      sourceEvidence: "『先别惊动他们。』",
    }]);

    assert.equal(store.writingMemory(sessionId).length, 1);
    assert.equal(store.writingMemory(otherSessionId).length, 0);

    store.refreshWritingMemoryForDocument(path, "# 第一章\n\n对白已删除。\n");
    assert.equal(store.writingMemory(sessionId)[0]?.status, "stale");
    store.refreshWritingMemoryForDocument(path, content);
    assert.equal(store.writingMemory(sessionId)[0]?.status, "active");

    store.rewindFromMessage(sessionId, sourceMessageId);
    assert.equal(project.readTextFile(path), beforeContent);
    assert.equal(store.writingMemory(sessionId).length, 0);
    assert.deepEqual(store.saveExtractedWritingMemory(sessionId, sourceMessageId, path, content, proposal.id, [{
      kind: "dialogue_voice",
      content: "迟到的提取结果不得回流",
      characterIds: [],
      importance: 70,
      sourceEvidence: "『先别惊动他们。』",
    }]), []);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
