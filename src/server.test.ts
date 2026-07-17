import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ProviderManager } from "./provider_catalog.js";
import { WriterProject } from "./project.js";
import { BackgroundAgentJobs, resolveWebRoot, startWriterServer } from "./server.js";
import { WriterStore } from "./store.js";

test("web assets always resolve to Vite's build output", () => {
  const repositoryRoot = resolve("C:/workspace/writer-agent");
  const expected = join(repositoryRoot, "dist", "web");
  assert.equal(resolveWebRoot(pathToFileURL(join(repositoryRoot, "src", "server.ts")).href), expected);
  assert.equal(resolveWebRoot(pathToFileURL(join(repositoryRoot, "dist", "server.js")).href), expected);
});

test("agent event snapshot keeps events emitted during replay", async () => {
  let releaseAgent!: () => void;
  const agentPaused = new Promise<void>((resolve) => {
    releaseAgent = resolve;
  });
  const jobs = new BackgroundAgentJobs();
  const job = jobs.start("session-1", async (_signal, emit) => {
    emit({ type: "step_start", step: 1 });
    await agentPaused;
    emit({ type: "text", text: "continued output", channel: "output" });
    emit({ type: "done", sessionId: "session-1" });
  });

  await waitForImmediate();
  const liveEvents: Array<{ index: number; type: string }> = [];
  const subscription = jobs.snapshotAndSubscribe(job.id, (event) => {
    liveEvents.push({ index: event.index, type: event.type });
  });
  assert.ok(subscription);
  assert.deepEqual(subscription.events.map((event) => [event.index, event.type]), [[0, "step_start"]]);

  releaseAgent();
  await waitForImmediate();
  subscription.unsubscribe();

  assert.deepEqual(liveEvents.map((event) => [event.index, event.type]), [
    [1, "text"],
    [2, "done"],
  ]);
});

test("--no-token server mode disables public API authentication only when explicit", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-server-token-"));
  const project = WriterProject.init(root, "token test");
  const store = new WriterStore(project);
  const providers = new ProviderManager(project);
  try {
    const protectedServer = await startWriterServer({ project, store, providers, host: "0.0.0.0", port: 0, announce: false });
    const protectedPort = new URL(protectedServer.origin).port;
    try {
      const denied = await fetch(`http://127.0.0.1:${protectedPort}/api/health`);
      assert.equal(denied.status, 401);
      const allowed = await fetch(`http://127.0.0.1:${protectedPort}/api/health`, {
        headers: { authorization: `Bearer ${protectedServer.token}` },
      });
      assert.equal(allowed.status, 200);
      assert.ok(protectedServer.token.length >= 24);
    } finally {
      await protectedServer.close();
    }

    const openServer = await startWriterServer({ project, store, providers, host: "0.0.0.0", port: 0, requireToken: false, announce: false });
    const openPort = new URL(openServer.origin).port;
    try {
      assert.equal(openServer.token, "");
      const allowed = await fetch(`http://127.0.0.1:${openPort}/api/health`);
      assert.equal(allowed.status, 200);
    } finally {
      await openServer.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
