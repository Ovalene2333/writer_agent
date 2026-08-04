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
