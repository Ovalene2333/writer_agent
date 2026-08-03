import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyCharacter } from "./characters.js";
import { OutlineStore } from "./outline.js";
import { orderedChapterPaths, WriterProject } from "./project.js";
import { beginChapterSceneDraft, writeChapterScene } from "./scene_pipeline.js";
import { WriterStore } from "./store.js";
import {
  handleDeleteFile,
  handleEditFile,
  handleInspectFile,
  handleListFiles,
  handleMoveFile,
  handleProposeChangeSet,
  handleReadFile,
  handleWriteFile,
} from "./tools/files.js";
import type { ToolHandlerArgs } from "./tools/types.js";

test("text workspace stays inside resource and reads non-Markdown files", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-text-workspace-"));
  try {
    const project = WriterProject.init(root, "text workspace");
    const store = new WriterStore(project);
    const sessionId = store.createSession("files");
    project.writeTextFile("notes/research.txt", "alpha\nbeta\ngamma\n");
    project.writeTextFile("data/settings.json", "{\"enabled\":true}\n");
    project.writeTextFile("notes/custom.writerdata", "custom text\n");
    mkdirSync(join(root, "resource", "assets"), { recursive: true });
    writeFileSync(join(root, "resource", "assets", "fake.txt"), Buffer.from([0, 255, 1, 2]));
    const args = (input: Record<string, unknown>): ToolHandlerArgs => ({
      input, project, store, sessionId, emit: () => undefined, context: { permissionMode: "ask" },
    });
    const listed = JSON.parse(handleListFiles(args({ limit: 100 }))) as { files: string[] };
    assert.ok(listed.files.includes("notes/research.txt"));
    assert.ok(listed.files.includes("data/settings.json"));
    assert.ok(listed.files.includes("notes/custom.writerdata"));
    assert.equal(listed.files.includes("assets/fake.txt"), false);
    const inspected = JSON.parse(handleInspectFile(args({ path: "data/settings.json" }))) as { sourceHash: string; lineCount: number };
    assert.equal(inspected.sourceHash.length, 64);
    assert.equal(inspected.lineCount, 2);
    const read = JSON.parse(handleReadFile(args({ path: "notes/research.txt", sourceHash: project.hash(project.readTextFile("notes/research.txt")), startLine: 2, endLine: 3 }))) as { content: string };
    assert.equal(read.content, "beta\ngamma");
    project.writeTextFile("notes/long.txt", Array.from({ length: 180 }, (_, index) => `line ${index + 1}`).join("\n"));
    const longRead = JSON.parse(handleReadFile(args({ path: "notes/long.txt", startLine: 1, endLine: 180 }))) as {
      content: string;
      endLine: number;
      requestedEndLine: number;
      truncated: boolean;
      nextStartLine: number;
    };
    assert.equal(longRead.endLine, 120);
    assert.equal(longRead.requestedEndLine, 180);
    assert.equal(longRead.truncated, true);
    assert.equal(longRead.nextStartLine, 121);
    assert.match(longRead.content, /line 120/);
    assert.doesNotMatch(longRead.content, /line 121/);
    assert.throws(() => handleReadFile(args({ path: "notes/research.txt", sourceHash: "stale", block: 1 })), /快照已变化/);
    assert.throws(() => project.readTextFile("../outside.txt"), /resource|相对路径|范围外/);
    assert.throws(() => project.readTextFile("assets/fake.txt"), /纯文本|UTF-8/);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change set applies and rolls back files plus character evolution as one unit", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-change-set-"));
  try {
    const project = WriterProject.init(root, "change set");
    const store = new WriterStore(project);
    const sessionId = store.createSession("atomic");
    project.writeTextFile("notes/plan.txt", "old plan\n");
    project.writeTextFile("data/source.json", "{\"version\":1}\n");
    project.writeTextFile("notes/remove.txt", "remove me\n");
    const character = store.saveCharacter(emptyCharacter("Lin"));

    const changeSet = store.createChangeSet(sessionId, "update project state", [
      { operation: "patch", path: "notes/plan.txt", edits: [{ search: "old plan", replace: "new plan" }] },
      { operation: "move", path: "data/source.json", targetPath: "data/archive/source.json" },
      { operation: "delete", path: "notes/remove.txt" },
      { operation: "write", path: "lore/new-fact.md", content: "# New fact\n\nConfirmed.\n" },
    ], [{
      characterId: character.id,
      reason: "The grouped files confirm the event",
      changes: [{ op: "append_experience", label: "Confirmed event", description: "Recorded with the change set" }],
    }]);

    const accepted = store.acceptChangeSet(changeSet.id);
    assert.equal(accepted.status, "accepted");
    assert.equal(project.readTextFile("notes/plan.txt"), "new plan\n");
    assert.equal(project.textFileExists("data/source.json"), false);
    assert.equal(project.readTextFile("data/archive/source.json"), "{\"version\":1}\n");
    assert.equal(project.textFileExists("notes/remove.txt"), false);
    assert.match(project.read("lore/new-fact.md"), /Confirmed/);
    assert.equal(store.characters().find(item => item.id === character.id)?.experiences.length, 1);

    const undone = store.undoChangeSet(changeSet.id);
    assert.equal(undone.undone, true);
    assert.equal(project.readTextFile("notes/plan.txt"), "old plan\n");
    assert.equal(project.readTextFile("data/source.json"), "{\"version\":1}\n");
    assert.equal(project.textFileExists("data/archive/source.json"), false);
    assert.equal(project.readTextFile("notes/remove.txt"), "remove me\n");
    assert.equal(project.textFileExists("lore/new-fact.md"), false);
    assert.equal(store.characters().find(item => item.id === character.id)?.experiences.length, 0);

    const redone = store.redoChangeSet(changeSet.id);
    assert.equal(redone.undone, false);
    assert.equal(project.readTextFile("notes/plan.txt"), "new plan\n");
    assert.equal(store.characters().find(item => item.id === character.id)?.experiences.length, 1);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale file prevents every change in the set", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-change-set-stale-"));
  try {
    const project = WriterProject.init(root, "stale set");
    const store = new WriterStore(project);
    const sessionId = store.createSession("stale");
    project.writeTextFile("notes/a.txt", "A0");
    project.writeTextFile("notes/b.txt", "B0");
    const changeSet = store.createChangeSet(sessionId, "two updates", [
      { operation: "write", path: "notes/a.txt", content: "A1" },
      { operation: "write", path: "notes/b.txt", content: "B1" },
    ]);
    project.writeTextFile("notes/b.txt", "external edit");
    assert.throws(() => store.acceptChangeSet(changeSet.id), /过期|已变化/);
    assert.equal(project.readTextFile("notes/a.txt"), "A0");
    assert.equal(project.readTextFile("notes/b.txt"), "external edit");
    assert.equal(store.changeSet(changeSet.id).status, "stale");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("combined validation uses the proposed outline and restores outline metadata on failure", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-change-set-outline-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "outline validation");
    const outlineContent = `# Story\n\n## Chapter\n\n### Scene\n\n- 摘要：A linked scene\n- 前因：A\n- 行动：B\n- 结果：C\n- 状态变化：D\n`;
    project.writeRaw("outline/outline.md", outlineContent);
    const activeStore = new WriterStore(project);
    store = activeStore;
    const sessionId = activeStore.createSession("outline-validation");
    const sceneId = new OutlineStore(project).sync().nodes.at(-1)!.id;
    activeStore.saveCharacter({
      ...emptyCharacter("Lin"),
      storyStates: [{
        id: "state-scene", outlineNodeId: sceneId, location: "Station", physical: "", emotion: "",
        knowledge: [], beliefs: [], intentions: [], temporaryGoals: [], notes: "",
      }],
    });
    const changeSet = activeStore.createChangeSet(sessionId, "remove referenced outline", [
      { operation: "write", path: "outline/outline.md", content: "# Empty outline\n" },
    ]);
    assert.throws(() => activeStore.acceptChangeSet(changeSet.id), /大纲|节点|outline/i);
    assert.equal(project.read("outline/outline.md"), outlineContent);
    assert.ok(new OutlineStore(project).sync().nodes.some(node => node.id === sceneId));
    assert.equal(activeStore.changeSet(changeSet.id).status, "pending");
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("chapter file operations use filesystem paths without rewriting writer.yaml", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-change-set-config-"));
  try {
    const project = WriterProject.init(root, "config rollback");
    assert.doesNotMatch(project.readRaw("writer.yaml"), /^chapters:/mu);
    assert.equal(project.config().title, "config rollback");
    project.writeRaw("writer.yaml", "title: config rollback\nlanguage: zh-CN\nchapters:\n  - 老版本/序章.md\n");
    project.writeRaw("chapters/chapter-002.md", "# Two\n");
    const beforeConfig = project.readRaw("writer.yaml");
    assert.match(project.export("md"), /# Two/);
    assert.doesNotMatch(project.export("md"), /老版本/);
    const store = new WriterStore(project);
    const sessionId = store.createSession("config");
    const changeSet = store.createChangeSet(sessionId, "reorganize chapters", [
      { operation: "delete", path: "chapters/chapter-001.md" },
      { operation: "move", path: "chapters/chapter-002.md", targetPath: "chapters/renamed.md" },
    ]);
    store.acceptChangeSet(changeSet.id);
    assert.equal(project.readRaw("writer.yaml"), beforeConfig);
    assert.deepEqual(orderedChapterPaths(project), ["chapters/renamed.md"]);
    store.undoChangeSet(changeSet.id);
    assert.equal(project.readRaw("writer.yaml"), beforeConfig);
    assert.deepEqual(orderedChapterPaths(project), ["chapters/chapter-001.md", "chapters/chapter-002.md"]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unified file tools edit a visible working copy and route all text through approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-unified-files-"));
  try {
    const project = WriterProject.init(root, "unified file tools");
    const store = new WriterStore(project);
    const sessionId = store.createSession("unified");
    project.writeRaw("lore/rule.md", "# 规则\n\n旧规则。\n");
    const context: ToolHandlerArgs["context"] = {
      permissionMode: "ask",
      workingTextFiles: new Map(),
      readSnapshots: new Map(),
    };
    const args = (input: Record<string, unknown>): ToolHandlerArgs => ({
      input, project, store, sessionId, emit: () => undefined, context,
    });

    const edited = JSON.parse(await handleEditFile(args({
      path: "lore/rule.md",
      edits: [{ operation: "replace", oldText: "旧规则。", content: "新规则。" }],
    }))) as Record<string, unknown>;
    assert.equal(edited.status, "pending");
    assert.equal(typeof edited.proposalId, "number");
    assert.match(project.read("lore/rule.md"), /旧规则/u, "ask mode must not overwrite the persisted file");
    const working = JSON.parse(handleReadFile(args({ path: "lore/rule.md" }))) as Record<string, unknown>;
    assert.equal(working.workingCopy, true);
    assert.match(String(working.content), /新规则/u);

    const revalidated = JSON.parse(await handleWriteFile(args({ path: "lore/rule.md" }))) as Record<string, unknown>;
    assert.equal(typeof revalidated.proposalId, "number", "an existing working copy can be revalidated without retransmitting it");

    const autoContext: ToolHandlerArgs["context"] = { permissionMode: "auto", workingTextFiles: new Map() };
    const autoArgs = (input: Record<string, unknown>): ToolHandlerArgs => ({
      input, project, store, sessionId, emit: () => undefined, context: autoContext,
    });
    const written = JSON.parse(await handleWriteFile(autoArgs({
      path: "notes/research.txt",
      content: "alpha\nbeta\n",
    }))) as Record<string, unknown>;
    assert.equal(written.status, "accepted");
    assert.equal(project.readTextFile("notes/research.txt"), "alpha\nbeta\n");

    const moved = JSON.parse(await handleMoveFile(autoArgs({
      path: "notes/research.txt",
      targetPath: "notes/archive/research.txt",
    }))) as Record<string, unknown>;
    assert.equal(moved.status, "accepted");
    assert.equal(project.textFileExists("notes/research.txt"), false);
    assert.equal(project.readTextFile("notes/archive/research.txt"), "alpha\nbeta\n");

    const deleted = JSON.parse(await handleDeleteFile(autoArgs({
      path: "notes/archive/research.txt",
    }))) as Record<string, unknown>;
    assert.equal(deleted.status, "accepted");
    assert.equal(project.textFileExists("notes/archive/research.txt"), false);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write_file submits an inspected scene draft without exposing a proposal-only tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-scene-file-submit-"));
  try {
    const project = WriterProject.init(root, "scene file submit");
    const store = new WriterStore(project);
    const sessionId = store.createSession("scene file submit");
    const started = beginChapterSceneDraft({
      path: "chapters/第二章.md",
      mode: "create",
      heading: "第二章",
      chapterGoal: "越过门禁",
      baseContent: "",
      baseHash: project.hash(""),
      scenes: [{
        id: "gate",
        title: "门禁",
        goal: "进入训练区",
        entryState: [],
        characterIntent: [],
        obstacle: "门禁转红",
        turn: "仍然进入",
        outcome: "留下违规记录",
        handoff: "",
        dividerBefore: false,
      }],
    });
    const written = writeChapterScene(
      started,
      "gate",
      "门禁灯从绿转红，她没有退回走廊，而是贴着即将闭合的门缝侧身挤了进去。鞋底擦过金属轨道，警报声随即追进训练区，她回头看见自己的编号已经留在屏幕上，值班室的方向也亮起一盏白灯。",
      {
        situation: ["已违规进入训练区"],
        physical: [],
        knowledge: ["知道门禁记录了自己的编号"],
        relationships: [],
        goals: [],
        openLoops: ["警报会引来谁"],
        usedMotifs: ["红灯"],
      },
    ).draft;
    const context: ToolHandlerArgs["context"] = {
      permissionMode: "ask",
      chapterSceneDraft: { ...written, inspectedVersion: written.version },
    };
    const submitted = JSON.parse(await handleWriteFile({
      input: { path: "chapters/第二章.md" },
      project,
      store,
      sessionId,
      emit: () => undefined,
      context,
    })) as Record<string, unknown>;
    assert.equal(submitted.status, "pending");
    assert.equal(typeof submitted.proposalId, "number");
    assert.equal(context.chapterSceneDraft, undefined);
    assert.equal(project.documentExists("chapters/第二章.md"), false);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change set cannot bypass the full narrative proposal review path", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-change-set-narrative-"));
  try {
    const project = WriterProject.init(root, "narrative change set guard");
    const store = new WriterStore(project);
    const sessionId = store.createSession("guard");
    const result = JSON.parse(await handleProposeChangeSet({
      input: {
        summary: "写第一章",
        files: [{ operation: "write", path: "chapters/第一章.md", content: "# 第一章\n\n正文。" }],
      },
      project,
      store,
      sessionId,
      emit: () => undefined,
      context: { permissionMode: "ask" },
    })) as Record<string, unknown>;
    assert.equal(result.code, "NARRATIVE_CHANGE_SET_REQUIRES_DOCUMENT_PROPOSAL");
    assert.deepEqual(result.nextAllowedActions, ["write_file", "edit_file"]);
    assert.equal(project.documentExists("chapters/第一章.md"), false);

    const sideResult = JSON.parse(await handleProposeChangeSet({
      input: {
        summary: "写支线",
        files: [{ operation: "write", path: "side/支线.md", content: "# 支线\n\n正文。" }],
      },
      project,
      store,
      sessionId,
      emit: () => undefined,
      context: { permissionMode: "ask" },
    })) as Record<string, unknown>;
    assert.equal(sideResult.code, "NARRATIVE_CHANGE_SET_REQUIRES_DOCUMENT_PROPOSAL");
    assert.equal(project.documentExists("side/支线.md"), false);

    const movedIntoChapter = JSON.parse(await handleProposeChangeSet({
      input: {
        summary: "把未审核草稿移入章节目录",
        files: [{ operation: "move", path: "lore/world.md", targetPath: "chapters/导入稿.md" }],
      },
      project,
      store,
      sessionId,
      emit: () => undefined,
      context: { permissionMode: "ask" },
    })) as Record<string, unknown>;
    assert.equal(movedIntoChapter.code, "NARRATIVE_CHANGE_SET_REQUIRES_DOCUMENT_PROPOSAL");
    assert.equal(movedIntoChapter.path, "chapters/导入稿.md");
    assert.equal(project.documentExists("lore/world.md"), true);
    assert.equal(project.documentExists("chapters/导入稿.md"), false);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change set application resumes after files were written before database commit", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-change-set-resume-"));
  try {
    const project = WriterProject.init(root, "change set resume");
    const store = new WriterStore(project);
    const sessionId = store.createSession("resume");
    const changeSet = store.createChangeSet(sessionId, "write recovery note", [
      { operation: "write", path: "notes/recovery.txt", content: "applied before crash\n" },
    ]);
    const at = "2026-08-02T00:00:00.000Z";
    store.database.prepare(`INSERT INTO change_set_applications(
      change_set_id,status,character_revisions_json,created_at,updated_at
    ) VALUES(?,'prepared','[]',?,?)`).run(changeSet.id, at, at);
    project.writeTextFile("notes/recovery.txt", "applied before crash\n");

    const accepted = store.acceptChangeSet(changeSet.id);
    assert.equal(accepted.status, "accepted");
    assert.equal(project.readTextFile("notes/recovery.txt"), "applied before crash\n");
    const application = store.database.prepare("SELECT status FROM change_set_applications WHERE change_set_id=?")
      .get(changeSet.id) as { status: string };
    assert.equal(application.status, "committed");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
