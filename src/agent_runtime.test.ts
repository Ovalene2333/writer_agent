import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatTodosForPrompt,
  listProjectSkills,
  loadAgentSettings,
  loadProjectInstructions,
  normalizeTodos,
  saveAgentSettings,
} from "./agent_runtime.js";
import { WriterProject } from "./project.js";

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
