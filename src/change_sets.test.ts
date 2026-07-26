import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyCharacter } from "./characters.js";
import { OutlineStore } from "./outline.js";
import { orderedChapterPaths, WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { handleInspectFile, handleListFiles, handleReadFile } from "./tools/files.js";
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
