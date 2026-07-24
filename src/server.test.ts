import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ProviderManager } from "./provider_catalog.js";
import { WriterProject } from "./project.js";
import { BackgroundAgentJobs, conversationMessageForWeb, resolveWebRoot, startWriterServer } from "./server.js";
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

test("web roleplay messages expose the parsed perception without internal turn hints", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-web-perception-"));
  try {
    const project = WriterProject.init(root, "web perception");
    const store = new WriterStore(project);
    const sessionId = store.createSession("roleplay");
    const messageId = store.addMessage(sessionId, "user", "我在心里判断，然后说你好。", "roleplay");
    store.saveRoleplayPerception(
      sessionId,
      messageId,
      JSON.stringify({
        version: 1,
        speech: ["你好。"],
        observableActions: [],
        perceivedEffects: [],
        privateOmitted: true,
        ambiguousOmitted: false,
      }),
    );
    const message = store.messages(sessionId, 1, { channel: "roleplay" })[0];

    const webMessage = conversationMessageForWeb(store, message);
    assert.match(webMessage.roleplayPerception ?? "", /话语：\n- 你好。/);
    assert.deepEqual(webMessage.roleplayPerceptionData?.speech, ["你好。"]);
    assert.deepEqual(webMessage.roleplayPerceptionData?.knowableFacts, []);
    assert.deepEqual(webMessage.roleplayPerceptionData?.unknowableFacts, []);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent jobs run concurrently across sessions and serialize each session", async () => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstPaused = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondPaused = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const jobs = new BackgroundAgentJobs();

  const first = jobs.start("session-1", async (_signal, emit) => {
    await firstPaused;
    emit({ type: "done", sessionId: "session-1" });
  });
  const second = jobs.start("session-2", async (_signal, emit) => {
    await secondPaused;
    emit({ type: "done", sessionId: "session-2" });
  });

  assert.deepEqual(jobs.activeJobs().map(job => job.sessionId).sort(), ["session-1", "session-2"]);
  assert.equal(jobs.activeJob("session-1")?.id, first.id);
  assert.equal(jobs.activeJob("session-2")?.id, second.id);
  assert.throws(
    () => jobs.start("session-1", async () => undefined),
    /SESSION_JOB_ALREADY_RUNNING/,
  );

  releaseFirst();
  await waitForImmediate();
  assert.equal(jobs.activeJob("session-1"), undefined);
  assert.equal(jobs.activeJob("session-2")?.id, second.id);

  releaseSecond();
  await waitForImmediate();
  assert.equal(jobs.activeJobs().length, 0);
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
      const healthPayload = await allowed.json() as { ok: boolean; ts: number; publicOrigin?: string | null };
      assert.equal(healthPayload.ok, true);
      assert.equal(typeof healthPayload.ts, "number");
      assert.equal("publicOrigin" in healthPayload, false);
      protectedServer.setPublicOrigin(null);
      const connectingHealth = await fetch(`http://127.0.0.1:${protectedPort}/api/health`, {
        headers: { authorization: `Bearer ${protectedServer.token}` },
      });
      const connectingPayload = await connectingHealth.json() as { publicOrigin: string | null };
      assert.equal(connectingPayload.publicOrigin, null);
      protectedServer.setPublicOrigin("https://current.trycloudflare.com");
      const tunnelHealth = await fetch(`http://127.0.0.1:${protectedPort}/api/health`, {
        headers: { authorization: `Bearer ${protectedServer.token}` },
      });
      const tunnelPayload = await tunnelHealth.json() as { publicOrigin: string | null };
      assert.equal(tunnelPayload.publicOrigin, "https://current.trycloudflare.com");
      assert.throws(() => protectedServer.setPublicOrigin("https://example.com"), /Cloudflare 公网地址无效/);
      protectedServer.setPublicOrigin(null);
      const disconnectedHealth = await fetch(`http://127.0.0.1:${protectedPort}/api/health`, {
        headers: { authorization: `Bearer ${protectedServer.token}` },
      });
      const disconnectedPayload = await disconnectedHealth.json() as { publicOrigin: string | null };
      assert.equal(disconnectedPayload.publicOrigin, null);
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
