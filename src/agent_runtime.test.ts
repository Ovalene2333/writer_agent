import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  finalizeOpenTodos,
  formatTodosForPrompt,
  listProjectSkills,
  loadAgentSettings,
  loadProjectInstructions,
  normalizeTodos,
  persistFinalizedSessionTodos,
  saveAgentSettings,
} from "./agent_runtime.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import type { AgentTodoItem } from "./types.js";

test("normalizeTodos enforces single in_progress", () => {
  const todos = normalizeTodos([
    { id: "t1", content: "A", status: "in_progress" },
    { id: "t2", content: "B", status: "in_progress" },
    { id: "t3", content: "C", status: "pending" },
  ]);
  assert.equal(todos.filter(item => item.status === "in_progress").length, 1);
  assert.equal(todos[0].status, "in_progress");
  assert.equal(todos[1].status, "pending");
  assert.match(formatTodosForPrompt(todos), /t1/);
});

test("finalizeOpenTodos completes pending and in_progress, keeps cancelled", () => {
  const { todos, changed } = finalizeOpenTodos([
    { id: "t1", content: "done", status: "completed" },
    { id: "t2", content: "writing", status: "in_progress" },
    { id: "t3", content: "propose", status: "pending" },
    { id: "t4", content: "skip", status: "cancelled" },
  ]);
  assert.equal(changed, true);
  assert.equal(todos.find(item => item.id === "t1")?.status, "completed");
  assert.equal(todos.find(item => item.id === "t2")?.status, "completed");
  assert.equal(todos.find(item => item.id === "t3")?.status, "completed");
  assert.equal(todos.find(item => item.id === "t4")?.status, "cancelled");
  assert.equal(finalizeOpenTodos(todos).changed, false);
});

test("persistFinalizedSessionTodos closes last open item after proposal-like turn", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-"));
  try {
    const project = WriterProject.init(root, "测试");
    const store = new WriterStore(project);
    const sessionId = store.createSession("todos-finalize");
    store.saveSessionTodos(sessionId, [
      { id: "t1", content: "规划", status: "completed" },
      { id: "t2", content: "撰写正文", status: "completed" },
      { id: "t3", content: "提交文档提案", status: "pending" },
    ]);
    const emitted: AgentTodoItem[][] = [];
    const todos = persistFinalizedSessionTodos(store, sessionId, event => {
      emitted.push(event.todos);
    });
    assert.equal(todos.every(item => item.status === "completed"), true);
    assert.equal(store.sessionTodos(sessionId).at(-1)?.status, "completed");
    assert.equal(emitted.at(-1)?.at(-1)?.status, "completed");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project instructions prefer WRITER.md", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-"));
  try {
    const project = WriterProject.init(root, "测试");
    writeFileSync(join(root, "WRITER.md"), "# 指令\n\n禁止第一人称。\n", "utf8");
    const loaded = loadProjectInstructions(project);
    assert.equal(loaded?.path, "WRITER.md");
    assert.match(loaded?.content ?? "", /禁止第一人称/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent settings round-trip permission mode", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-"));
  try {
    const project = WriterProject.init(root, "测试");
    assert.equal(loadAgentSettings(project).permissionMode, "ask");
    saveAgentSettings(project, { permissionMode: "plan" });
    assert.equal(loadAgentSettings(project).permissionMode, "plan");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProjectSkills reads .writer/skills", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-"));
  try {
    const project = WriterProject.init(root, "测试");
    const skillDir = join(project.privateDir, "skills", "scene-open");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---
name: 场景开场
description: 用动作切入
---

# 场景开场

先写具体动作。
`, "utf8");
    const skills = listProjectSkills(project);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].id, "scene-open");
    assert.equal(skills[0].name, "场景开场");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session task state does not sticky-inherit activeDocument across turns", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-"));
  try {
    const project = WriterProject.init(root, "测试");
    const store = new WriterStore(project);
    const sessionId = store.createSession("task-bind");
    store.saveSessionContext(sessionId, { activeDocument: "outline/outline.md", currentIntent: "outline: 写大纲" });
    store.saveSessionTodos(sessionId, [{ id: "t1", content: "发散路线", status: "in_progress" }]);
    store.saveContextArtifact(sessionId, {
      cacheKey: "k1", kind: "list_outline_nodes", path: "outline/outline.md",
      sourceHash: "h1", content: "{}", digest: "d1",
    });

    // New turn without a target must clear the previous document binding (no COALESCE stickiness).
    store.saveSessionContext(sessionId, { currentIntent: "general: 闲聊" });
    const after = store.sessionContext(sessionId);
    assert.equal(after.activeDocument, undefined);
    assert.equal(after.currentIntent, "general: 闲聊");
    // todos are managed separately until clearSessionTaskState
    assert.equal(store.sessionTodos(sessionId).length, 1);

    store.clearSessionTaskState(sessionId);
    assert.equal(store.sessionContext(sessionId).currentIntent, "");
    assert.equal(store.sessionTodos(sessionId).length, 0);
    assert.equal(store.recentContextArtifacts(sessionId, 8).length, 0);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rewind clears dialogue-bound task residue", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-"));
  try {
    const project = WriterProject.init(root, "测试");
    const store = new WriterStore(project);
    const sessionId = store.createSession("rewind-task");
    store.addMessage(sessionId, "user", "写大纲");
    const userId = store.messages(sessionId, 10)[0].id;
    store.addMessage(sessionId, "assistant", "好的");
    store.saveSessionContext(sessionId, { activeDocument: "outline/outline.md", currentIntent: "outline: 写大纲" });
    store.saveSessionTodos(sessionId, [{ id: "t1", content: "完成大纲", status: "pending" }]);
    store.saveContextArtifact(sessionId, {
      cacheKey: "k2", kind: "read_document", path: "outline/outline.md",
      sourceHash: "h2", content: "{}", digest: "d2",
    });

    store.rewindFromMessage(sessionId, userId);
    assert.equal(store.sessionTodos(sessionId).length, 0);
    assert.equal(store.sessionContext(sessionId).activeDocument, undefined);
    assert.equal(store.recentContextArtifacts(sessionId, 8).length, 0);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
