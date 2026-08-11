import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WriterProject } from "../project.js";
import { WriterStore } from "../store.js";
import { executeTool } from "./execute.js";

const REFERENCE_TEXT = [
  "# 世界规则",
  "",
  "委员会持有航线与应急代码的最终解释权。",
  "每次跃迁都要在港口登记，未登记的船只不得进入内环。",
].join("\n");

test("AI 风格审计覆盖 lore 下的任意 UTF-8 文本，并使用资料画像", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-audit-text-"));
  try {
    const project = WriterProject.init(root, "审计测试");
    const store = new WriterStore(project);
    const sessionId = store.createSession("审计资料");
    project.writeTextFile("lore/world.txt", REFERENCE_TEXT);

    const raw = await executeTool(
      { id: "audit", name: "audit_prose_style", arguments: JSON.stringify({ path: "lore/world.txt" }) },
      project,
      store,
      sessionId,
      () => {},
    );
    const result = JSON.parse(raw) as Record<string, unknown>;
    const aiTells = result.aiTells as Record<string, unknown>;
    const issues = aiTells.issues as Array<Record<string, unknown>>;

    assert.equal(result.path, "lore/world.txt");
    assert.equal(result.source, "document");
    assert.equal(result.kind, "lore");
    assert.equal(result.workingCopy, false);
    assert.equal(aiTells.profile, "reference");
    assert.equal(typeof aiTells.score, "number");
    assert.ok(Array.isArray(issues));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("正文质量报告按精确哈希生成一次并跨 Store 持久化复用", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-quality-tool-"));
  try {
    const project = WriterProject.init(root, "质量报告工具");
    const path = "chapters/第一章.md";
    const content = Array.from({ length: 9 }, (_, index) =>
      `第${index}段不是犹豫，是她听见门后有人换了站姿。`).join("\n\n");
    project.writeRaw(path, content);
    const sourceHash = project.hash(content);
    let store = new WriterStore(project);
    const sessionId = store.createSession("quality-tool");

    const firstRaw = await executeTool(
      { id: "quality-1", name: "get_document_quality_report", arguments: JSON.stringify({ path, sourceHash }) },
      project,
      store,
      sessionId,
      () => {},
    );
    const first = JSON.parse(firstRaw) as Record<string, unknown>;
    const firstReport = first.report as { version?: number; warnings: Array<{ code: string; examples: string[]; occurrences?: string[] }> };
    const contrast = firstReport.warnings.find(warning => warning.code === "contrast_density");
    assert.equal(first.cached, false);
    assert.equal(firstReport.version, 3);
    assert.equal(contrast?.occurrences?.length, 9);
    assert.ok((contrast?.occurrences?.length ?? 0) > (contrast?.examples.length ?? 0));
    const createdAt = first.createdAt;
    store.close();

    store = new WriterStore(project);
    const secondRaw = await executeTool(
      { id: "quality-2", name: "get_document_quality_report", arguments: JSON.stringify({ path, sourceHash }) },
      project,
      store,
      sessionId,
      () => {},
    );
    const second = JSON.parse(secondRaw) as Record<string, unknown>;
    assert.equal(second.cached, true);
    assert.equal(second.createdAt, createdAt);
    assert.deepEqual(second.report, first.report);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("会话产物与文件检索共享卷访问边界", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-artifact-volume-access-"));
  try {
    const project = WriterProject.init(root, "产物卷权限");
    const store = new WriterStore(project);
    const sessionId = store.createSession("artifact-volume-access");
    const lockedPath = "chapters/锁定卷/01.md";
    project.writeTextFile(lockedPath, "# 第一章\n\n只存在于锁定卷的暗号。");
    const locked = store.saveSessionArtifact(sessionId, {
      artifactKey: "locked-draft",
      kind: "proposal_revision_draft",
      path: lockedPath,
      sourceHash: "locked-hash",
      content: "锁定卷完整正文",
      digest: "锁定卷摘要",
    });
    store.saveSessionArtifact(sessionId, {
      artifactKey: "open-lore",
      kind: "read_file",
      path: "lore/world.md",
      sourceHash: "open-hash",
      content: "可读设定",
      digest: "可读摘要",
    });
    const context = { permissionMode: "ask" as const, volumeAccess: { allowedVolumes: [] } };

    const catalog = JSON.parse(await executeTool(
      { id: "artifact-search", name: "search_session_artifacts", arguments: "{}" },
      project, store, sessionId, () => {}, undefined, context,
    )) as { count: number; accessFiltered?: number; message?: string };
    assert.equal(catalog.count, 1);
    assert.equal(catalog.accessFiltered, 1);
    assert.match(catalog.message ?? "", /未解锁/u);

    const read = JSON.parse(await executeTool(
      { id: "artifact-read", name: "read_context_artifact", arguments: JSON.stringify({ artifactId: locked.id }) },
      project, store, sessionId, () => {}, undefined, context,
    )) as { error?: string };
    assert.match(read.error ?? "", /未解锁该卷/u);

    const search = JSON.parse(await executeTool(
      { id: "file-search", name: "search_files", arguments: JSON.stringify({ query: "暗号" }) },
      project, store, sessionId, () => {}, undefined, context,
    )) as { matches: unknown[]; accessFiltered?: number; message?: string };
    assert.deepEqual(search.matches, []);
    assert.equal(search.accessFiltered, 1);
    assert.match(search.message ?? "", /未参与检索/u);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
