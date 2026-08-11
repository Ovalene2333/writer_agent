import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  openCodeRunArgs,
  parseLogAnalysisTurn,
  redactLogValue,
  runLogAudit,
  type LogAnalyzer,
} from "./log_analysis.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";

test("log evidence redaction removes secret fields and bearer values", () => {
  const safe = redactLogValue({
    apiKey: "sk-secret-value-123456789",
    nested: { authorization: "Bearer abc.def.ghi", note: "Bearer abc.def.ghi" },
  });
  const text = JSON.stringify(safe);
  assert.doesNotMatch(text, /secret-value|abc\.def\.ghi/);
  assert.match(text, /REDACTED/);
});

test("analysis protocol accepts fenced JSON and rejects an unknown status", () => {
  const turn = parseLogAnalysisTurn("```json\n{\"status\":\"need_evidence\",\"requests\":[]}\n```");
  assert.equal(turn.status, "need_evidence");
  assert.throws(() => parseLogAnalysisTurn('{"status":"guess"}'), /status/);
});

test("OpenCode adapter uses argument arrays and an isolated working directory", () => {
  const args = openCodeRunArgs({
    model: "deepseek/deepseek-chat",
    evidencePath: "/tmp/audit/evidence.json",
    workingDirectory: "/tmp/audit",
    attach: "http://127.0.0.1:4096",
    prompt: "audit; $(touch nope)",
  });
  assert.deepEqual(args.slice(0, 8), ["run", "--format", "json", "--agent", "plan", "--model", "deepseek/deepseek-chat", "--dir"]);
  assert.equal(args[8], "/tmp/audit");
  assert.equal(args.at(-1), "audit; $(touch nope)");
});

test("log audit persists bounded evidence and rejects unsupported citations", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-log-audit-"));
  try {
    const project = WriterProject.init(root, "Log audit fixture");
    const store = new WriterStore(project);
    store.close();
    const analyzer: LogAnalyzer = {
      backend: "direct",
      model: "cheap-test-model",
      async analyze() {
        return JSON.stringify({
          status: "complete",
          summary: "done",
          findings: [
            { id: "ok", severity: "low", category: "runtime", title: "有证据", diagnosis: "范围已记录", evidenceIds: ["ev-001"], confidence: 0.8 },
            { id: "bad", severity: "high", category: "runtime", title: "无证据", diagnosis: "猜测", evidenceIds: ["ev-999"], confidence: 1 },
          ],
        });
      },
    };
    const result = await runLogAudit({ project, analyzer, options: { maxEvidenceBytes: 20_000 } });
    assert.equal(result.report?.status, "completed");
    assert.ok(result.evidence.reduce((sum, item) => sum + item.bytes, 0) <= 20_000);
    assert.deepEqual(result.report?.findings.map(item => item.id), ["ok"]);
    assert.match(result.report?.diagnostics.join("\n") ?? "", /拒绝无效 finding/);
    const evidence = readFileSync(result.evidencePath, "utf8");
    assert.doesNotMatch(evidence, /apiKey|authorization/);
    assert.doesNotMatch(evidence, /originalRequest|executionPlan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
