import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
/**
 * The context graph is the durable answer to "what did this request assemble,
 * and why". These guards cover the two ways it can lie: by handing the prompt
 * two competing versions of one chapter, and by silently shrinking its own
 * counters when the node window is bounded.
 */
import {
  buildContextGraphView,
  buildProjectTrunk,
  buildProjectTrunkDelta,
  chapterHandoffKey,
  formatActiveHandoffsForPrompt,
  PROJECT_TRUNK_EMPTY,
  type ContextEdge,
  type ContextNode,
} from "./context_graph.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";

function withStore(name: string, body: (store: WriterStore, sessionId: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), `writer-${name}-`));
  try {
    const project = WriterProject.init(root, "上下文图");
    const store = new WriterStore(project);
    const sessionId = store.createSession("图会话");
    try { body(store, sessionId); } finally { store.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function handoffNode(index: number, path: string, extra: Record<string, unknown> = {}): ContextNode {
  const at = `2026-07-2${index}T00:00:00.000Z`;
  return {
    id: `hand_${index}`,
    sessionId: "s",
    kind: "handoff",
    status: "active",
    label: `章交接 · ${path}`,
    payload: {
      kind: "chapter",
      path,
      summary: `第 ${index} 章摘要`.repeat(8),
      tail: `结尾${index}`.repeat(60),
      finalActualState: { 场景: `地点${index}` },
      ...extra,
    },
    createdAt: at,
    updatedAt: at,
  };
}

test("chapterHandoffKey normalizes a path so a rewrite matches its predecessor", () => {
  assert.equal(chapterHandoffKey({ path: "chapters/第1章.md" }), "path:chapters/第1章.md");
  assert.equal(chapterHandoffKey({ path: "./Chapters\\第1章.md" }), "path:chapters/第1章.md");
  // No path to key on — fall back to delivery order rather than pretending to match.
  assert.equal(chapterHandoffKey({ index: 3 }), "index:3");
  assert.equal(chapterHandoffKey({}), "");
});

test("the handoff prompt block details only the newest chapter", () => {
  const block = formatActiveHandoffsForPrompt([1, 2, 3].map(i => handoffNode(i, `ch/${i}.md`)));
  // Only the seam immediately behind the cursor needs tail + scene state; pasting
  // three of them gave the model competing continuations for ~1.3k tokens a turn.
  assert.equal((block.match(/结尾衔接/g) ?? []).length, 1);
  assert.equal((block.match(/末场状态/g) ?? []).length, 1);
  assert.match(block, /结尾3/);
  assert.doesNotMatch(block, /结尾2/);
  // Older chapters stay *known to exist* at a path, so the model reads them on demand.
  assert.match(block, /已交付 ch\/1\.md/);
  assert.match(block, /已交付 ch\/2\.md/);
});

test("the handoff block drops the oldest entries to fit its budget and says so", () => {
  const handoffs = [1, 2, 3, 4, 5].map(i => handoffNode(i, `ch/${i}.md`));
  const block = formatActiveHandoffsForPrompt(handoffs, { budgetChars: 500 });
  assert.ok(block.length < 900, `block should stay near budget, got ${block.length}`);
  assert.match(block, /更早交付共 \d+ 章/);
  // The detailed tier is never sacrificed — losing the seam is what breaks continuity.
  assert.match(block, /结尾5/);
  assert.doesNotMatch(block, /已交付 ch\/1\.md/);
});

test("no active handoffs yields the stable empty-state line", () => {
  assert.match(formatActiveHandoffsForPrompt([]), /无活跃章交接/);
  const archived = { ...handoffNode(1, "ch/1.md"), status: "archived" as const };
  assert.match(formatActiveHandoffsForPrompt([archived]), /无活跃章交接/);
});

test("re-delivering a chapter archives the earlier handoff behind a supersedes edge", () => {
  withStore("ctx-supersede", (store, sessionId) => {
    const key = chapterHandoffKey({ path: "chapters/第1章.md" });
    const first = store.createContextNode({
      sessionId, kind: "handoff", label: "章交接 · 第1章 v1",
      payload: { kind: "chapter", path: "chapters/第1章.md", chapterKey: key },
    });
    const other = store.createContextNode({
      sessionId, kind: "handoff", label: "章交接 · 第2章",
      payload: { kind: "chapter", path: "chapters/第2章.md", chapterKey: chapterHandoffKey({ path: "chapters/第2章.md" }) },
    });
    const second = store.createContextNode({
      sessionId, kind: "handoff", label: "章交接 · 第1章 v2",
      payload: { kind: "chapter", path: "chapters/第1章.md", chapterKey: key },
    });

    assert.equal(store.supersedeContextHandoffs(sessionId, key, second.id), 1);

    const active = store.activeContextHandoffs(sessionId).map(node => node.id);
    assert.deepEqual(active.sort(), [other.id, second.id].sort(), "only the rewrite and the untouched chapter stay active");
    const edges = store.contextEdges(sessionId).filter(edge => edge.kind === "supersedes");
    assert.deepEqual(edges.map(edge => [edge.fromId, edge.toId]), [[second.id, first.id]]);

    // Idempotent: a second call has nothing left to retire.
    assert.equal(store.supersedeContextHandoffs(sessionId, key, second.id), 0);
  });
});

test("a bounded graph view keeps active handoffs, full stats and no dangling edges", () => {
  const nodes: ContextNode[] = Array.from({ length: 40 }, (_, index) => ({
    id: `n${index}`,
    sessionId: "s",
    kind: index === 0 ? "handoff" : "message",
    status: index === 1 ? "archived" : "active",
    label: `节点 ${index}`,
    payload: {},
    createdAt: `2026-07-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    updatedAt: `2026-07-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  const edges: ContextEdge[] = [
    // n0 is the oldest node but an active handoff, so it survives the window.
    { id: "e1", sessionId: "s", fromId: "n39", toId: "n0", kind: "supersedes", createdAt: "2026-07-01T01:00:00.000Z" },
    // n1 falls outside the window — this edge must not render as an arrow into nothing.
    { id: "e2", sessionId: "s", fromId: "n39", toId: "n1", kind: "uses", createdAt: "2026-07-01T01:00:00.000Z" },
  ];

  const view = buildContextGraphView("s", nodes, edges, { limit: 10 });
  assert.equal(view.truncated, true);
  assert.equal(view.nodes.length, 11, "10 recent nodes plus the retained handoff");
  assert.ok(view.nodes.some(node => node.id === "n0"), "an active handoff is the real source of the L2 block");
  assert.deepEqual(view.edges.map(edge => edge.id), ["e1"]);
  // Counters describe the session, not the window.
  assert.equal(view.stats.totalNodes, 40);
  assert.equal(view.stats.activeNodes, 39);
  assert.equal(view.stats.archivedNodes, 1);
  assert.equal(view.stats.edgeCount, 2);
  assert.equal(view.stats.trunkCount, 0);

  const whole = buildContextGraphView("s", nodes, edges, { limit: 500 });
  assert.equal(whole.truncated, false);
  assert.equal(whole.nodes.length, 40);
  assert.equal(whole.edges.length, 2);
});

test("buildProjectTrunk is hash-stable for the same materials and empty when bare", () => {
  const empty = buildProjectTrunk({ characters: [], lorePaths: [] });
  assert.equal(empty.empty, true);
  assert.equal(empty.content, PROJECT_TRUNK_EMPTY);

  const input = {
    title: "测试",
    characters: [
      { id: 2, name: "乙", narrativeRole: "配角", summary: "短" },
      { id: 1, name: "甲", aliases: ["A"], narrativeRole: "主角", summary: "长摘要".repeat(20) },
    ],
    outline: {
      sourcePath: "outline/outline.md",
      nodes: [
        { id: "n1", type: "chapter", title: "第一章", summary: "开场" },
        { id: "n2", type: "scene", title: "雨夜", summary: "冲突" },
      ],
    },
    lorePaths: ["lore/world.md", "lore/world.md", "chapters/skip.md"],
  };
  const a = buildProjectTrunk(input);
  const b = buildProjectTrunk({
    ...input,
    characters: [...input.characters].reverse(),
    lorePaths: [...input.lorePaths].reverse(),
  });
  assert.equal(a.empty, false);
  assert.equal(a.hash, b.hash);
  assert.equal(a.content, b.content);
  assert.match(a.content, /项目树干/);
  assert.match(a.content, /"id":1/);
  assert.equal(a.characterCount, 2);
  assert.equal(a.outlineNodeCount, 2);

  const changed = buildProjectTrunk({
    ...input,
    characters: [...input.characters, { id: 3, name: "丙", narrativeRole: "访客" }],
  });
  const delta = buildProjectTrunkDelta(a, changed);
  assert.deepEqual(delta?.changedSections, ["characters"]);
  assert.match(delta?.content ?? "", /"characters"/);
  assert.doesNotMatch(delta?.content ?? "", /"outlineNodes":\[/);
});
