import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgentSettings, saveAgentSettings } from "./agent_runtime.js";
import {
  chapterNamingAgentPrompt,
  DEFAULT_CHAPTER_NAMING,
  resolveChapterNaming,
  suggestNextChapter,
} from "./chapter_naming.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { handleListFiles, handleReadFile, handleSearchFiles } from "./tools/files.js";
import type { ToolHandlerArgs } from "./tools/types.js";
import {
  accessibleVolumeNames,
  agentVisibleDocumentPaths,
  assertVolumePathAllowed,
  chapterPathsInVolume,
  chapterVolume,
  chapterVolumeNames,
  routeNewChapterPath,
  uniqueVolumeName,
} from "./volume_policy.js";

function withProject(run: (project: WriterProject) => void): void {
  const root = mkdtempSync(join(tmpdir(), "writer-volume-policy-"));
  try {
    run(WriterProject.init(root, "volume policy"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("volume catalog exposes names while locked chapter bodies stay hidden", () => {
  withProject(project => {
    project.writeTextFile("chapters/free.md", "# Free\n");
    project.writeTextFile("chapters/第一卷/01.md", "# One\n");
    project.writeTextFile("chapters/第二卷/02.md", "# Two\n");
    project.writeTextFile("lore/world.md", "# World\n");

    assert.equal(chapterVolume("chapters/第一卷/01.md"), "第一卷");
    assert.equal(chapterVolume("chapters/free.md"), undefined);
    assert.deepEqual(new Set(chapterVolumeNames(project)), new Set(["第一卷", "第二卷"]));
    const locked = agentVisibleDocumentPaths(project);
    assert.ok(locked.includes("chapters/free.md"));
    assert.ok(locked.includes("lore/world.md"));
    assert.equal(locked.includes("chapters/第一卷/01.md"), false);
    assert.equal(locked.includes("chapters/第二卷/02.md"), false);
    const secondUnlocked = agentVisibleDocumentPaths(project, ["第二卷"]);
    assert.ok(secondUnlocked.includes("chapters/free.md"));
    assert.ok(secondUnlocked.includes("chapters/第二卷/02.md"));
    assert.equal(secondUnlocked.includes("chapters/第一卷/01.md"), false);
    assert.deepEqual(
      accessibleVolumeNames({ allowedVolumes: [], activeVolume: "第一卷", autoCreated: true }),
      ["第一卷"],
    );
    assert.throws(
      () => assertVolumePathAllowed({ allowedVolumes: [] }, "chapters/第一卷/01.md"),
      /未解锁该卷/,
    );
  });
});

test("one run routes every new ungrouped chapter into its active volume", () => {
  withProject(project => {
    project.writeTextFile("chapters/existing.md", "# Existing\n");
    project.writeTextFile("chapters/远行/00.md", "# Existing volume\n");
    const activeVolume = uniqueVolumeName(project, "远行");
    const policy = { allowedVolumes: [], activeVolume, autoCreated: true };

    assert.equal(activeVolume, "远行-2");
    assert.equal(routeNewChapterPath(project, "chapters/01.md", policy), "chapters/远行-2/01.md");
    assert.equal(routeNewChapterPath(project, "chapters/02.md", policy), "chapters/远行-2/02.md");
    assert.equal(routeNewChapterPath(project, "chapters/existing.md", policy), "chapters/远行-2/existing.md");
    assert.throws(
      () => routeNewChapterPath(project, "chapters/远行/03.md", policy),
      /未解锁该卷/,
    );
  });
});

test("chapter ordinals are local to the destination volume", () => {
  withProject(project => {
    for (let index = 1; index <= 6; index += 1) {
      project.writeTextFile(`chapters/旧卷/chapter-${String(index).padStart(2, "0")}.md`, `# 第${index}章\n`);
    }
    project.writeTextFile("chapters/目标卷/chapter-01.md", "# 第一章\n");
    project.writeTextFile("chapters/目标卷/chapter-02.md", "# 第二章\n");
    project.writeTextFile("chapters/chapter-01.md", "# 未分卷第一章\n");

    const naming = resolveChapterNaming(DEFAULT_CHAPTER_NAMING, project, { chapterPaths: [] });
    assert.equal(suggestNextChapter(naming, project, {
      chapterPaths: chapterPathsInVolume(project, "新卷"),
    }).index, 1);
    assert.equal(suggestNextChapter(naming, project, {
      chapterPaths: chapterPathsInVolume(project, "目标卷"),
    }).index, 3);
    assert.equal(suggestNextChapter(naming, project, {
      chapterPaths: chapterPathsInVolume(project),
    }).index, 2);
    assert.match(
      chapterNamingAgentPrompt(naming, project, chapterPathsInVolume(project, "新卷")),
      /下一可用：path=chapters\/chapter-01\.md · title=# 第一章/,
    );
  });
});

test("file tools expose volume names without leaking locked chapter paths or text", () => {
  withProject(project => {
    project.writeTextFile("chapters/free.md", "public marker\n");
    project.writeTextFile("chapters/Locked/secret.md", "private marker\n");
    const store = new WriterStore(project);
    try {
      const sessionId = store.createSession("volume tools");
      const args = (input: Record<string, unknown>, allowedVolumes: string[] = []): ToolHandlerArgs => ({
        input,
        project,
        store,
        sessionId,
        emit: () => undefined,
        context: { permissionMode: "ask", volumeAccess: { allowedVolumes } },
      });
      const listed = JSON.parse(handleListFiles(args({ limit: 100 }))) as {
        files: string[];
        volumes: Array<{ name: string; unlocked: boolean }>;
      };
      assert.ok(listed.files.includes("chapters/free.md"));
      assert.equal(listed.files.includes("chapters/Locked/secret.md"), false);
      assert.deepEqual(listed.volumes, [{ name: "Locked", path: "chapters/Locked/", unlocked: false }]);
      assert.throws(() => handleReadFile(args({ path: "chapters/Locked/secret.md" })), /未解锁该卷/);
      assert.deepEqual(
        JSON.parse(handleSearchFiles(args({ query: "marker" }))).matches.map((item: { path: string }) => item.path),
        ["chapters/free.md"],
      );
      assert.equal(
        JSON.parse(handleReadFile(args({ path: "chapters/Locked/secret.md" }, ["Locked"]))).content.trim(),
        "private marker",
      );
    } finally {
      store.close();
    }
  });
});

test("search_files supports bounded grep-style literal and regex matching", () => {
  withProject(project => {
    project.writeTextFile("lore/a.md", "Alpha 第12章\nbeta 第3章 alpha\n");
    project.writeTextFile("outline/b.md", "第九幕\nALPHA\n");
    const store = new WriterStore(project);
    try {
      const sessionId = store.createSession("regex search");
      const args = (input: Record<string, unknown>): ToolHandlerArgs => ({
        input, project, store, sessionId, emit: () => undefined,
        context: { permissionMode: "ask" },
      });
      const literal = JSON.parse(handleSearchFiles(args({ query: "alpha", limit: 2 }))) as {
        mode: string; caseSensitive: boolean; matchCount: number; truncated: boolean;
        matches: Array<{ path: string; line: number; column: number; matchedText: string; matchesInLine: number }>;
      };
      assert.equal(literal.mode, "literal");
      assert.equal(literal.caseSensitive, false);
      assert.equal(literal.matchCount, 2);
      assert.equal(literal.truncated, true);
      assert.deepEqual(literal.matches.map(item => [item.path, item.line, item.column]), [
        ["lore/a.md", 1, 1],
        ["lore/a.md", 2, 10],
      ]);

      const regex = JSON.parse(handleSearchFiles(args({
        query: "第(?:\\d+章|[一二三四五六七八九十]+幕)",
        mode: "regex",
        caseSensitive: true,
        contextLines: 0,
        limit: 10,
      }))) as { matches: Array<{ path: string; line: number; matchedText: string; contextStartLine: number; contextEndLine: number }> };
      assert.deepEqual(regex.matches.map(item => [item.path, item.line, item.matchedText]), [
        ["lore/a.md", 1, "第12章"],
        ["lore/a.md", 2, "第3章"],
        ["outline/b.md", 1, "第九幕"],
      ]);
      assert.ok(regex.matches.every(item => item.contextStartLine === item.contextEndLine));
      assert.throws(
        () => handleSearchFiles(args({ query: "([", mode: "regex" })),
        /正则表达式无效/u,
      );
      const zeroWidth = JSON.parse(handleSearchFiles(args({
        query: "^|$", mode: "regex", pathPrefix: "lore/a.md", limit: 10,
      }))) as { matchCount: number };
      assert.equal(zeroWidth.matchCount, 3, "zero-width global matches advance and return one result per line");
    } finally {
      store.close();
    }
  });
});

test("automatic volume creation defaults on and can be disabled independently", () => {
  withProject(project => {
    assert.equal(loadAgentSettings(project).autoVolume.enabled, true);
    assert.equal(saveAgentSettings(project, { autoVolume: { enabled: false } }).autoVolume.enabled, false);
    assert.equal(loadAgentSettings(project).autoVolume.enabled, false);
  });
});
