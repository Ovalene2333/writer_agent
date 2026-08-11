import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  openCodeRunArgs,
  logAuditFindingsTriggerFailure,
  parseLogAnalysisTurn,
  redactLogValue,
  runLogAudit,
  textFromOpenCodeOutput,
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

test("severity gate never fails for none and respects the selected threshold", () => {
  const findings = [{ severity: "high" as const }, { severity: "low" as const }];
  assert.equal(logAuditFindingsTriggerFailure(findings, "none"), false);
  assert.equal(logAuditFindingsTriggerFailure(findings, "critical"), false);
  assert.equal(logAuditFindingsTriggerFailure(findings, "high"), true);
  assert.equal(logAuditFindingsTriggerFailure(findings, "medium"), true);
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
  assert.ok(args.includes("--file=/tmp/audit/evidence.json"));
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "audit; $(touch nope)");
  const defaults = openCodeRunArgs({
    evidencePath: "/tmp/audit/evidence.json",
    workingDirectory: "/tmp/audit",
    prompt: "audit",
  });
  assert.equal(defaults.includes("--model"), false);
});

test("OpenCode JSON output keeps final text and excludes reasoning or synthetic file echoes", () => {
  const output = [
    JSON.stringify({ type: "reasoning", part: { type: "reasoning", text: '{"status":"wrong"}' } }),
    JSON.stringify({ type: "text", part: { type: "text", synthetic: true, text: "file contents" } }),
    JSON.stringify({ type: "text", part: { type: "text", text: '{"status":"complete","findings":[]}' } }),
  ].join("\n");
  assert.equal(textFromOpenCodeOutput(output), '{"status":"complete","findings":[]}');
  assert.equal(textFromOpenCodeOutput(JSON.stringify({ type: "step_finish", status: "completed" })), "");
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
      async analyze(input) {
        assert.match(input.prompt, /本次唯一首要问题：为什么没有输出/);
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
    const result = await runLogAudit({
      project, analyzer, options: { maxEvidenceBytes: 20_000, question: "为什么没有输出？" },
    });
    assert.equal(result.report?.status, "completed");
    assert.ok(result.evidence.reduce((sum, item) => sum + item.bytes, 0) <= 20_000);
    assert.deepEqual(result.report?.findings.map(item => item.id), ["ok"]);
    assert.match(result.report?.diagnostics.join("\n") ?? "", /拒绝无效 finding/);
    const evidence = readFileSync(result.evidencePath, "utf8");
    const snapshot = readFileSync(result.snapshotPath, "utf8");
    assert.doesNotMatch(evidence, /apiKey|authorization/);
    assert.doesNotMatch(evidence, /originalRequest|executionPlan/);
    assert.match(snapshot, /^WRITER_LOG_SNAPSHOT_V1\n/);
    assert.match(snapshot, /question: 为什么没有输出？/);
    assert.match(snapshot, /\[LOW\] 有证据/);
    assert.ok(snapshot.length < 12_001);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
