import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgentSettings, saveAgentSettings } from "./agent_runtime.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { handleListFiles, handleReadFile, handleSearchFiles } from "./tools/files.js";
import type { ToolHandlerArgs } from "./tools/types.js";
import {
  accessibleVolumeNames,
  agentVisibleDocumentPaths,
  assertVolumePathAllowed,
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
    assert.deepEqual(new Set(agentVisibleDocumentPaths(project)), new Set(["chapters/free.md", "lore/world.md"]));
    assert.deepEqual(
      new Set(agentVisibleDocumentPaths(project, ["第二卷"])),
      new Set(["chapters/free.md", "chapters/第二卷/02.md", "lore/world.md"]),
    );
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
    assert.equal(routeNewChapterPath(project, "chapters/existing.md", policy), "chapters/existing.md");
    assert.throws(
      () => routeNewChapterPath(project, "chapters/远行/03.md", policy),
      /未解锁该卷/,
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
      assert.deepEqual(listed.files, ["chapters/free.md"]);
      assert.deepEqual(listed.volumes, [{ name: "Locked", unlocked: false }]);
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

test("automatic volume creation defaults on and can be disabled independently", () => {
  withProject(project => {
    assert.equal(loadAgentSettings(project).autoVolume.enabled, true);
    assert.equal(saveAgentSettings(project, { autoVolume: { enabled: false } }).autoVolume.enabled, false);
    assert.equal(loadAgentSettings(project).autoVolume.enabled, false);
  });
});
