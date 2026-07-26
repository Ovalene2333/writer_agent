import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  advanceScenePipelineTodos,
  advanceTodosAfterProposal,
  completeCharacterTaskTodos,
  formatTodosForPrompt,
  listProjectSkills,
  loadSkillById,
  loadAgentSettings,
  loadProjectInstructions,
  normalizeTodos,
  persistAdvancedTodosAfterProposal,
  persistCompletedCharacterTaskTodos,
  reconcileManagedTodos,
  saveAgentSettings,
} from "./agent_runtime.js";
import { emptyCharacter } from "./characters.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { handleApplyCharacterChanges, handleSaveCharacter } from "./tools/characters.js";
import type { ToolHandlerArgs } from "./tools/types.js";
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

test("scene pipeline milestones advance the built-in chapter todos without model bookkeeping", () => {
  const initial: AgentTodoItem[] = [
    { id: "t1", content: "核对本篇必要事实与衔接", status: "in_progress" },
    { id: "t2", content: "建立初始场景引导", status: "pending" },
    { id: "t3", content: "按成稿结果推进正文", status: "pending" },
    { id: "t4", content: "全文审阅并提交提案", status: "pending" },
  ];
  const started = advanceScenePipelineTodos(initial, "draft_started");
  assert.equal(started.changed, true);
  assert.deepEqual(started.todos.map(item => item.status), ["completed", "completed", "in_progress", "pending"]);
  const complete = advanceScenePipelineTodos(started.todos, "draft_complete");
  assert.deepEqual(complete.todos.map(item => item.status), ["completed", "completed", "completed", "in_progress"]);
  const reopened = advanceScenePipelineTodos(complete.todos, "draft_reopened");
  assert.deepEqual(reopened.todos.map(item => item.status), ["completed", "completed", "in_progress", "pending"]);
});

test("scene pipeline milestones do not infer phases from custom todo wording", () => {
  const custom: AgentTodoItem[] = [
    { id: "x1", content: "看看资料", status: "in_progress" },
    { id: "x2", content: "写正文", status: "pending" },
  ];
  const result = advanceScenePipelineTodos(custom, "draft_started");
  assert.equal(result.changed, false);
  assert.equal(result.todos, custom);
});

test("manage_todos cannot manually complete the built-in scene pipeline", () => {
  const current: AgentTodoItem[] = [
    { id: "t1", content: "核对本篇必要事实与衔接", status: "in_progress" },
    { id: "t2", content: "建立初始场景引导", status: "pending" },
    { id: "t3", content: "按成稿结果推进正文", status: "pending" },
    { id: "t4", content: "全文审阅并提交提案", status: "pending" },
  ];
  const requested = current.map(item => ({ ...item, status: "completed" as const }));
  const result = reconcileManagedTodos(current, requested);
  assert.equal(result.scenePipelineProtected, true);
  assert.equal(result.todos, current);

  const custom = [{ id: "x1", content: "自定义步骤", status: "completed" as const }];
  assert.deepEqual(reconcileManagedTodos([], custom), {
    todos: custom,
    scenePipelineProtected: false,
  });
});

test("scene pipeline milestones migrate the legacy chapter todo labels", () => {
  const legacy: AgentTodoItem[] = [
    { id: "t1", content: "核对大纲、人设与衔接", status: "completed" },
    { id: "t2", content: "建立章节场景链", status: "in_progress" },
    { id: "t3", content: "逐场编译、写作并传递状态", status: "pending" },
    { id: "t4", content: "整章审阅并提交提案", status: "pending" },
  ];
  const result = advanceScenePipelineTodos(legacy, "draft_started");
  assert.equal(result.changed, true);
  assert.deepEqual(result.todos.map(item => item.status), ["completed", "completed", "in_progress", "pending"]);
});

test("completeCharacterTaskTodos completes a saved character task and keeps cancelled", () => {
  const { todos, changed } = completeCharacterTaskTodos([
    { id: "t1", content: "读取角色卡", status: "completed" },
    { id: "t2", content: "更新角色卡", status: "in_progress" },
    { id: "t3", content: "核对保存结果", status: "pending" },
    { id: "t4", content: "无需处理", status: "cancelled" },
  ]);
  assert.equal(changed, true);
  assert.equal(todos.find(item => item.id === "t1")?.status, "completed");
  assert.equal(todos.find(item => item.id === "t2")?.status, "completed");
  assert.equal(todos.find(item => item.id === "t3")?.status, "completed");
  assert.equal(todos.find(item => item.id === "t4")?.status, "cancelled");
  assert.equal(completeCharacterTaskTodos(todos).changed, false);
});

test("advanceTodosAfterProposal keeps multi-chapter pending open and continues", () => {
  const { todos, shouldContinue, changed } = advanceTodosAfterProposal([
    { id: "t1", content: "阅读大纲和世界观设定", status: "completed" },
    { id: "t2", content: "撰写第1章初稿", status: "in_progress" },
    { id: "t3", content: "撰写第2章初稿", status: "pending" },
    { id: "t4", content: "撰写第3章初稿", status: "pending" },
  ]);
  assert.equal(changed, true);
  assert.equal(shouldContinue, true);
  assert.equal(todos.find(item => item.id === "t2")?.status, "completed");
  assert.equal(todos.find(item => item.id === "t3")?.status, "in_progress");
  assert.equal(todos.find(item => item.id === "t4")?.status, "pending");
});

test("advanceTodosAfterProposal closes single-scene soft checklist and stops", () => {
  const { todos, shouldContinue } = advanceTodosAfterProposal([
    { id: "t1", content: "核对大纲、人设与衔接", status: "completed" },
    { id: "t2", content: "完成正文并自检", status: "in_progress" },
    { id: "t3", content: "提交文档提案", status: "pending" },
  ]);
  assert.equal(shouldContinue, false);
  assert.equal(todos.every(item => item.status === "completed"), true);
});

test("persistCompletedCharacterTaskTodos closes todos after a character save", () => {
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
    const todos = persistCompletedCharacterTaskTodos(store, sessionId, event => {
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

test("persistAdvancedTodosAfterProposal leaves later chapters open", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-multi-"));
  try {
    const project = WriterProject.init(root, "多章");
    const store = new WriterStore(project);
    const sessionId = store.createSession("todos-multi");
    store.saveSessionTodos(sessionId, [
      { id: "t1", content: "阅读大纲和世界观设定", status: "completed" },
      { id: "t2", content: "撰写第1章初稿", status: "in_progress" },
      { id: "t3", content: "撰写第2章初稿", status: "pending" },
      { id: "t4", content: "撰写第3章初稿", status: "pending" },
    ]);
    const { todos, shouldContinue } = persistAdvancedTodosAfterProposal(store, sessionId);
    assert.equal(shouldContinue, true);
    assert.equal(todos.find(item => item.id === "t2")?.status, "completed");
    assert.equal(todos.find(item => item.id === "t3")?.status, "in_progress");
    assert.equal(store.sessionTodos(sessionId).find(item => item.id === "t4")?.status, "pending");
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

test("agent settings round-trip permission, writing mode, and scene pipeline", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-"));
  try {
    const project = WriterProject.init(root, "测试");
    assert.deepEqual(loadAgentSettings(project), {
      permissionMode: "ask",
      writingMode: "delegated",
      characterEvolutionEnabled: true,
      scenePipeline: {
        preferredMinScenes: 3, preferredMaxScenes: 5, maxScenes: 5,
        notesMaxCharacters: 3_000, isolatedWriterMaxRatio: 2, isolatedWriter: false, candidateCount: 2,
      },
    });
    saveAgentSettings(project, {
      permissionMode: "plan",
      writingMode: "fast",
      characterEvolutionEnabled: false,
      scenePipeline: {
        preferredMinScenes: 2, preferredMaxScenes: 4, maxScenes: 6,
        notesMaxCharacters: 4_200, isolatedWriterMaxRatio: 2.4,
      },
    });
    assert.deepEqual(loadAgentSettings(project), {
      permissionMode: "plan",
      writingMode: "fast",
      characterEvolutionEnabled: false,
      scenePipeline: {
        preferredMinScenes: 2, preferredMaxScenes: 4, maxScenes: 6,
        notesMaxCharacters: 4_200, isolatedWriterMaxRatio: 2.4, isolatedWriter: false, candidateCount: 2,
      },
    });
    // Best-of-N switch: persisted, clamped to 1—3 (2 by default).
    saveAgentSettings(project, { scenePipeline: { candidateCount: 9 } });
    assert.equal(loadAgentSettings(project).scenePipeline.candidateCount, 3);
    saveAgentSettings(project, { scenePipeline: { candidateCount: 1 } });
    assert.equal(loadAgentSettings(project).scenePipeline.candidateCount, 1);
    assert.equal(loadAgentSettings(project).scenePipeline.maxScenes, 6, "candidate patch must not reset scene counts");
    assert.equal(loadAgentSettings(project).scenePipeline.notesMaxCharacters, 4_200);
    assert.equal(loadAgentSettings(project).scenePipeline.isolatedWriterMaxRatio, 2.4);
    saveAgentSettings(project, { scenePipeline: { isolatedWriter: true } });
    assert.equal(loadAgentSettings(project).scenePipeline.isolatedWriter, true);
    assert.equal(loadAgentSettings(project).writingMode, "fast", "scene patch must preserve writing mode");
    assert.equal(loadAgentSettings(project).characterEvolutionEnabled, false, "scene patch must preserve evolution toggle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProjectSkills merges built-in skills with project overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-"));
  try {
    const project = WriterProject.init(root, "测试");
    const builtIn = loadSkillById(project, "chapter-planning");
    assert.equal(builtIn?.path, "builtin/chapter-planning/SKILL.md");
    assert.match(builtIn?.description ?? "", /完整章节/);
    assert.match(builtIn?.body ?? "", /不得把任何工具或固定顺序当成前置条件/);
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
    assert.equal(skills.length, 2);
    assert.equal(skills.find(skill => skill.id === "scene-open")?.name, "场景开场");

    const overrideDir = join(project.privateDir, "skills", "chapter-planning");
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, "SKILL.md"), "---\nname: 项目章节规划\ndescription: 项目自定义章节方法\n---\n\n# 自定义\n", "utf8");
    const overridden = loadSkillById(project, "chapter-planning");
    assert.equal(overridden?.name, "项目章节规划");
    assert.equal(overridden?.path, ".writer/skills/chapter-planning/SKILL.md");
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
    store.saveAgentCheckpoint(sessionId, {
      version: 1, stage: "task_started", updatedAt: new Date().toISOString(),
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
    assert.equal(store.agentCheckpoint(sessionId), undefined);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary task switches preserve immutable context artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-artifacts-"));
  try {
    const project = WriterProject.init(root, "跨任务读取缓存");
    const store = new WriterStore(project);
    const sessionId = store.createSession("cache");
    store.saveSessionContext(sessionId, { activeDocument: "lore/world.md", currentIntent: "write_scene/document/document: 写正文" });
    store.saveSessionTodos(sessionId, [{ id: "t1", content: "写正文", status: "in_progress" }]);
    store.saveContextArtifact(sessionId, {
      cacheKey: "read:v2:lore/world.md:h1",
      kind: "read_document",
      path: "lore/world.md",
      sourceHash: "h1",
      content: "{}",
      digest: "世界观摘要",
    });

    store.clearSessionTaskState(sessionId, { preserveContextArtifacts: true });

    assert.equal(store.sessionContext(sessionId).currentIntent, "");
    assert.equal(store.sessionTodos(sessionId).length, 0);
    assert.equal(store.recentContextArtifacts(sessionId, 8).length, 1);
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

test("message rerun archives answers and exposes navigable versions", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-message-versions-"));
  try {
    const project = WriterProject.init(root, "测试");
    const store = new WriterStore(project);
    const sessionId = store.createSession("versions");
    const userId = store.addMessage(sessionId, "user", "写一个开场");
    const assistantId = store.addMessage(sessionId, "assistant", "版本一");
    store.addMessage(sessionId, "user", "继续");
    store.addMessage(sessionId, "assistant", "后续内容");

    const rerun = store.prepareMessageRerun(sessionId, assistantId);
    assert.equal(rerun.fromId, userId);
    assert.equal(rerun.prompt, "写一个开场");
    assert.equal(rerun.channel, "agent");
    assert.equal(rerun.keepChanges, false);
    assert.ok(rerun.variantGroupId);

    const secondUserId = store.addMessage(sessionId, "user", rerun.prompt, "agent", rerun.variantGroupId);
    const secondId = store.addMessage(sessionId, "assistant", "版本二", "agent", rerun.variantGroupId);
    const messagesAfterRerun = store.withMessageVariantInfo(store.messages(sessionId, 20));
    const current = messagesAfterRerun
      .find(message => message.id === secondId);
    assert.equal(current?.variantCount, 2);
    assert.equal(messagesAfterRerun.find(message => message.id === secondUserId)?.variantCount, 1);
    const versions = store.messageVersions(sessionId, secondId);
    assert.equal(versions.current, 1);
    assert.deepEqual(versions.versions.map(version => version.content), ["版本一", "版本二"]);

    const rerunAgain = store.prepareMessageRerun(sessionId, secondId);
    const editedUserId = store.addMessage(sessionId, "user", "换个开场", "agent", rerunAgain.variantGroupId);
    const thirdId = store.addMessage(sessionId, "assistant", "版本三", "agent", rerunAgain.variantGroupId);
    assert.deepEqual(
      store.messageVersions(sessionId, thirdId).versions.map(version => version.content),
      ["版本一", "版本二", "版本三"],
    );
    const editedMessages = store.withMessageVariantInfo(store.messages(sessionId, 20));
    assert.equal(editedMessages.find(message => message.id === editedUserId)?.variantCount, 2);
    assert.deepEqual(
      store.messageVersions(sessionId, editedUserId).versions.map(version => version.content),
      ["写一个开场", "换个开场"],
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("message rerun can keep accepted document changes", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-message-keep-changes-"));
  try {
    const project = WriterProject.init(root, "保留更改");
    const store = new WriterStore(project);
    const sessionId = store.createSession("keep-changes");
    const userId = store.addMessage(sessionId, "user", "写第一章");
    store.addMessage(sessionId, "assistant", "已提交提案");
    const proposal = store.createProposal(sessionId, "chapters/第1章.md", "# 第一章\n\n正文内容。", "写第一章");
    store.acceptProposal(proposal.id);
    assert.equal(project.documentExists("chapters/第1章.md"), true);
    assert.match(project.read("chapters/第1章.md"), /正文内容/);

    const keep = store.prepareMessageRerun(sessionId, userId, { keepChanges: true });
    assert.equal(keep.keepChanges, true);
    assert.equal(project.documentExists("chapters/第1章.md"), true);
    assert.match(project.read("chapters/第1章.md"), /正文内容/);
    assert.equal(store.messages(sessionId, 50).some(item => item.role === "user" && item.content === "写第一章"), false);

    // A fresh run that rolls back should still undo accepted files.
    const userAgain = store.addMessage(sessionId, "user", "写第一章");
    store.addMessage(sessionId, "assistant", "再跑一次");
    const proposal2 = store.createProposal(sessionId, "chapters/第2章.md", "# 第二章\n\n另一章。", "写第二章");
    store.acceptProposal(proposal2.id);
    store.prepareMessageRerun(sessionId, userAgain, { keepChanges: false });
    assert.equal(project.documentExists("chapters/第2章.md"), false);
    // Chapter 1 was kept earlier and not part of this second rewind scope after new messages only undid ch2.
    assert.equal(project.documentExists("chapters/第1章.md"), true);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("character evolution tool is blocked when the setting is disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-character-toggle-"));
  try {
    const project = WriterProject.init(root, "角色演进开关");
    const store = new WriterStore(project);
    const sessionId = store.createSession("character-toggle");
    const character = store.saveCharacter(emptyCharacter("甲"));
    const args: ToolHandlerArgs = {
      input: {
        id: character.id,
        reason: "调试写作",
        changes: [{ op: "append_experience", label: "不应写入", description: "开关关闭" }],
      },
      project,
      store,
      sessionId,
      emit: () => undefined,
      characterScope: [character.id],
      context: { permissionMode: "ask", characterEvolutionEnabled: false },
    };
    assert.throws(() => handleApplyCharacterChanges(args), /角色演进已关闭/);
    assert.equal(store.characters().find(item => item.id === character.id)?.experiences.length, 0);
    const saved = JSON.parse(handleSaveCharacter({
      ...args,
      input: { identity: { name: "乙" } },
      characterScope: undefined,
    })) as Record<string, unknown>;
    assert.equal(saved.created, true, "explicit character-card editing remains available");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("message rerun rolls back Agent character tool revisions", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-character-rerun-"));
  try {
    const project = WriterProject.init(root, "角色工具回退");
    const store = new WriterStore(project);
    const sessionId = store.createSession("character-rerun");
    const character = store.saveCharacter(emptyCharacter("甲"));
    const userId = store.addMessage(sessionId, "user", "给甲补充经历");
    const args: ToolHandlerArgs = {
      input: {
        id: character.id,
        reason: "用户确认",
        changes: [{ op: "append_experience", label: "测试经历", description: "用于验证回退" }],
      },
      project,
      store,
      sessionId,
      emit: () => undefined,
      characterScope: [character.id],
      context: { permissionMode: "ask", sourceMessageId: userId },
    };
    handleApplyCharacterChanges(args);
    store.addMessage(sessionId, "assistant", "已更新角色卡");
    assert.equal(store.characters().find(item => item.id === character.id)?.experiences.length, 1);

    store.prepareMessageRerun(sessionId, userId, { keepChanges: false });
    assert.equal(store.characters().find(item => item.id === character.id)?.experiences.length, 0);
    const revision = store.database.prepare("SELECT undone FROM character_revisions WHERE session_id=?").get(sessionId) as { undone: number };
    assert.equal(revision.undone, 1);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("message rerun rolls back accepted character-only change sets", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-character-change-set-rerun-"));
  try {
    const project = WriterProject.init(root, "角色 change set 回退");
    const store = new WriterStore(project);
    const sessionId = store.createSession("character-change-set-rerun");
    const character = store.saveCharacter(emptyCharacter("乙"));
    const userId = store.addMessage(sessionId, "user", "修改乙的角色卡");
    const changeSet = store.createChangeSet(sessionId, "角色卡修改", [], [{
      characterId: character.id,
      reason: "用户确认",
      changes: [{ op: "append_experience", label: "测试经历", description: "用于验证 change set 回退" }],
    }]);
    store.acceptChangeSet(changeSet.id);
    store.addMessage(sessionId, "assistant", "已提交并接受修改");
    assert.equal(store.characters().find(item => item.id === character.id)?.experiences.length, 1);

    store.prepareMessageRerun(sessionId, userId, { keepChanges: false });
    assert.equal(store.characters().find(item => item.id === character.id)?.experiences.length, 0);
    assert.equal(store.changeSet(changeSet.id).undone, true);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keep-changes re-run that rewrites a chapter chains document history", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-keep-history-"));
  try {
    const project = WriterProject.init(root, "版本链");
    const store = new WriterStore(project);
    const sessionId = store.createSession("history-chain");
    const userId = store.addMessage(sessionId, "user", "写第一章");
    store.addMessage(sessionId, "assistant", "第一稿");
    const first = store.createProposal(sessionId, "chapters/第一章.md", "# 第一章\n\n旧稿内容。", "第一稿");
    store.acceptProposal(first.id);
    assert.match(project.read("chapters/第一章.md"), /旧稿内容/);

    store.prepareMessageRerun(sessionId, userId, { keepChanges: true });
    assert.equal(project.documentExists("chapters/第一章.md"), true);

    const user2 = store.addMessage(sessionId, "user", "写第一章");
    store.addMessage(sessionId, "assistant", "第二稿");
    const second = store.createProposal(sessionId, "chapters/第一章.md", "# 第一章\n\n新稿内容。", "第二稿");
    // Existing file → proposal must not look like a brand-new create for history.
    assert.notEqual(second.baseHash, "__missing__");
    store.acceptProposal(second.id);
    assert.match(project.read("chapters/第一章.md"), /新稿内容/);

    const versions = store.documentVersions("chapters/第一章.md");
    assert.ok(versions.length >= 2, "keep-changes rewrite must keep both revisions");
    assert.equal(versions.filter(item => !item.undone).length, 2);
    assert.ok(versions.some(item => item.isCurrent));
    const detailNew = store.documentVersion("chapters/第一章.md", versions.find(item => item.isCurrent)!.id);
    assert.match(detailNew.afterContent, /新稿内容/);
    assert.match(detailNew.beforeContent, /旧稿内容/);
    const older = versions.find(item => !item.isCurrent && !item.undone)!;
    const detailOld = store.documentVersion("chapters/第一章.md", older.id);
    assert.match(detailOld.afterContent, /旧稿内容/);
    void user2;
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rolled-back chapter versions remain browsable in document history", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-undone-history-"));
  try {
    const project = WriterProject.init(root, "回退可浏览");
    const store = new WriterStore(project);
    const sessionId = store.createSession("undone-browse");
    const userId = store.addMessage(sessionId, "user", "写第一章");
    store.addMessage(sessionId, "assistant", "稿");
    const first = store.createProposal(sessionId, "chapters/第一章.md", "# 第一章\n\n会被回退的稿。", "初稿");
    store.acceptProposal(first.id);

    store.prepareMessageRerun(sessionId, userId, { keepChanges: false });
    assert.equal(project.documentExists("chapters/第一章.md"), false);

    store.addMessage(sessionId, "user", "写第一章");
    store.addMessage(sessionId, "assistant", "新稿");
    const second = store.createProposal(sessionId, "chapters/第一章.md", "# 第一章\n\n重写稿。", "重写");
    store.acceptProposal(second.id);

    const versions = store.documentVersions("chapters/第一章.md");
    assert.ok(versions.some(item => item.undone && /会被回退的稿|已回退/.test(item.summary) || item.undone));
    const undone = versions.find(item => item.undone)!;
    const detail = store.documentVersion("chapters/第一章.md", undone.id);
    assert.match(detail.afterContent, /会被回退的稿/);
    assert.equal(detail.undone, true);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
