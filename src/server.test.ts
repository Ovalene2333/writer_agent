import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ProviderManager } from "./provider_catalog.js";
import { WriterProject } from "./project.js";
import {
  BackgroundAgentJobs,
  conversationMessageForWeb,
  resolveWebRoot,
  scheduleAcceptedContinuityIndexing,
  startWriterServer,
} from "./server.js";
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

test("agent job synthesizes an error terminal event when runner returns silently", async () => {
  const jobs = new BackgroundAgentJobs();
  const job = jobs.start("session-silent", async () => undefined);
  await waitForImmediate();
  const snapshot = jobs.snapshotAndSubscribe(job.id, () => undefined);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.events.at(-1)?.type, "error");
  assert.match(String((snapshot.events.at(-1) as { message?: string }).message), /未产生终态事件/);
});

test("web server switches only among projects in its workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "writer-workspace-"));
  const firstRoot = join(workspace, "first-novel");
  const secondRoot = join(workspace, "second-novel");
  const firstProject = WriterProject.init(firstRoot, "第一部");
  WriterProject.init(secondRoot, "第二部");
  firstProject.writeRaw("chapters/first-only.md", "# 只属于第一部\n");
  const store = new WriterStore(firstProject);
  store.reindex();
  store.createSession("第一部会话");
  const providers = new ProviderManager(firstProject);
  const server = await startWriterServer({
    project: firstProject,
    store,
    providers,
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 0,
    requireToken: false,
    announce: false,
  });
  const port = new URL(server.origin).port;
  try {
    const projectsResponse = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(projectsResponse.status, 200);
    const projects = await projectsResponse.json() as {
      currentProjectId: string;
      projects: Array<{ id: string; title: string }>;
    };
    assert.equal(projects.currentProjectId, "first-novel");
    assert.deepEqual(projects.projects.map(project => project.id), ["first-novel", "second-novel"]);

    const firstState = await fetch(`http://127.0.0.1:${port}/api/state`);
    const firstPayload = await firstState.json() as {
      project: { id: string };
      documents: string[];
      sessions: Array<{ title: string }>;
    };
    assert.equal(firstPayload.project.id, "first-novel");
    assert.ok(firstPayload.documents.includes("chapters/first-only.md"));
    assert.ok(firstPayload.sessions.some(session => session.title === "第一部会话"));

    const switchResponse = await fetch(`http://127.0.0.1:${port}/api/projects/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "second-novel" }),
    });
    assert.equal(switchResponse.status, 200);
    const secondState = await fetch(`http://127.0.0.1:${port}/api/state`);
    const secondPayload = await secondState.json() as {
      project: { id: string };
      documents: string[];
      sessions: Array<{ title: string }>;
    };
    assert.equal(secondPayload.project.id, "second-novel");
    assert.equal(secondPayload.documents.includes("chapters/first-only.md"), false);
    assert.equal(secondPayload.sessions.some(session => session.title === "第一部会话"), false);

    for (const projectId of ["../outside", secondRoot]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects/switch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      assert.equal(response.status, 400);
    }
  } finally {
    await server.close();
    store.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("accepted continuity indexing starts after the approval response turn", async () => {
  let started = false;
  scheduleAcceptedContinuityIndexing(async () => { started = true; });
  assert.equal(started, false);
  await waitForImmediate();
  assert.equal(started, true);
});

test("interrupted agent resume can use either assistant marker or step anchor user", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-agent-resume-"));
  try {
    const project = WriterProject.init(root, "resume");
    const store = new WriterStore(project);
    const sessionId = store.createSession("resume");
    const userId = store.addMessage(sessionId, "user", "写第一章", "agent");
    const assistantId = store.addMessage(sessionId, "assistant", "已经完成几步\n\n[生成已中断]", "agent");
    assert.deepEqual(store.interruptedAgentResumePrompt(sessionId, userId), {
      fromId: userId,
      prompt: "写第一章",
    });
    assert.deepEqual(store.interruptedAgentResumePrompt(sessionId, assistantId), {
      fromId: userId,
      prompt: "写第一章",
    });
    const doneId = store.addMessage(sessionId, "assistant", "已完成", "agent");
    assert.throws(() => store.interruptedAgentResumePrompt(sessionId, doneId), /只能续跑/);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("web director messages hide the internal OOC wrapper", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-server-director-message-"));
  try {
    const project = WriterProject.init(root, "Director message");
    const store = new WriterStore(project);
    const sessionId = store.createSession("roleplay");
    const messageId = store.addMessage(sessionId, "user", "推进到第二天。", "roleplay", undefined, "director");
    store.saveRoleplayPerception(sessionId, messageId, "［OOC 导演指示——推进到第二天。］");
    const message = store.messages(sessionId, 1, { channel: "roleplay" })[0];

    const webMessage = conversationMessageForWeb(store, message);
    assert.equal(webMessage.roleplayInputMode, "director");
    assert.equal(webMessage.roleplayPerception, undefined);
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
      protectedServer.setPublicOrigin("https://ovalene.dpdns.org");
      const namedHealth = await fetch(`http://127.0.0.1:${protectedPort}/api/health`, {
        headers: { authorization: `Bearer ${protectedServer.token}` },
      });
      const namedPayload = await namedHealth.json() as { publicOrigin: string | null };
      assert.equal(namedPayload.publicOrigin, "https://ovalene.dpdns.org");
      assert.throws(() => protectedServer.setPublicOrigin("http://insecure.example"), /Cloudflare 公网地址无效/);
      assert.throws(() => protectedServer.setPublicOrigin("https://localhost"), /Cloudflare 公网地址无效/);
      protectedServer.setPublicOrigin(null);
      const disconnectedHealth = await fetch(`http://127.0.0.1:${protectedPort}/api/health`, {
        headers: { authorization: `Bearer ${protectedServer.token}` },
      });
      const disconnectedPayload = await disconnectedHealth.json() as { publicOrigin: string | null };
      assert.equal(disconnectedPayload.publicOrigin, null);
      const shareResponse = await fetch(`http://127.0.0.1:${protectedPort}/api/share/readonly`, {
        method: "POST",
        headers: { authorization: `Bearer ${protectedServer.token}` },
      });
      assert.equal(shareResponse.status, 200);
      const share = await shareResponse.json() as { token: string; accessMode: string };
      assert.ok(share.token.length >= 24);
      assert.equal(share.accessMode, "readonly");
      const readonlyState = await fetch(`http://127.0.0.1:${protectedPort}/api/state`, {
        headers: { authorization: `Bearer ${share.token}` },
      });
      assert.equal(readonlyState.status, 200);
      assert.equal((await readonlyState.json() as { accessMode: string }).accessMode, "readonly");
      const readonlyWrite = await fetch(`http://127.0.0.1:${protectedPort}/api/agent-settings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${share.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ permissionMode: "auto" }),
      });
      assert.equal(readonlyWrite.status, 403);
      assert.match(await readonlyWrite.text(), /只读模式/);
      const rotatedResponse = await fetch(`http://127.0.0.1:${protectedPort}/api/share/readonly`, {
        method: "POST",
        headers: { authorization: `Bearer ${protectedServer.token}` },
      });
      const rotated = await rotatedResponse.json() as { token: string };
      assert.notEqual(rotated.token, share.token);
      const expiredReadonly = await fetch(`http://127.0.0.1:${protectedPort}/api/health`, {
        headers: { authorization: `Bearer ${share.token}` },
      });
      assert.equal(expiredReadonly.status, 401);
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
      const createdRuleResponse = await fetch(`http://127.0.0.1:${openPort}/api/prose-gates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "dialogue-register",
          instruction: "人物对白必须符合各自身份和语域。",
          severity: "warn",
          enabled: true,
          sourceFeedback: "作者要求长期检查人物声口。",
        }),
      });
      assert.equal(createdRuleResponse.status, 200);
      const createdRules = await createdRuleResponse.json() as { rules: Array<{ id: string; severity: string }> };
      assert.equal(createdRules.rules.find(rule => rule.id === "dialogue-register")?.severity, "warn");
      const disabledRuleResponse = await fetch(
        `http://127.0.0.1:${openPort}/api/prose-gates/dialogue-register/enabled`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      assert.equal(disabledRuleResponse.status, 200);
      const disabledRules = await disabledRuleResponse.json() as { rules: Array<{ id: string; enabled: boolean }> };
      assert.equal(disabledRules.rules.find(rule => rule.id === "dialogue-register")?.enabled, false);
      const removedRuleResponse = await fetch(
        `http://127.0.0.1:${openPort}/api/prose-gates/dialogue-register`,
        { method: "DELETE" },
      );
      assert.equal(removedRuleResponse.status, 200);
      assert.equal((await removedRuleResponse.json() as { removed: boolean }).removed, true);
      // 篇幅设置是作者调的旋钮，越界值必须在服务端就挡住，别等到写作时才发现目标不合理。
      const badLength = await fetch(`http://127.0.0.1:${openPort}/api/agent-settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proseLength: { chapterTargetCharacters: 120 } }),
      });
      assert.equal(badLength.status, 400);
      assert.match(await badLength.text(), /chapterTargetCharacters/);
      const badEnforce = await fetch(`http://127.0.0.1:${openPort}/api/agent-settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proseLength: { enforceMinimum: "yes" } }),
      });
      assert.equal(badEnforce.status, 400);
      const savedLength = await fetch(`http://127.0.0.1:${openPort}/api/agent-settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proseLength: { chapterTargetCharacters: 4_200, enforceMinimum: true } }),
      });
      assert.equal(savedLength.status, 200);
      assert.deepEqual(
        (await savedLength.json() as { proseLength: unknown }).proseLength,
        { chapterTargetCharacters: 4_200, enforceMinimum: true },
      );
      const reloadedLength = await fetch(`http://127.0.0.1:${openPort}/api/agent-settings`);
      assert.deepEqual(
        (await reloadedLength.json() as { proseLength: unknown }).proseLength,
        { chapterTargetCharacters: 4_200, enforceMinimum: true },
      );
      const unsafeShare = await fetch(`http://127.0.0.1:${openPort}/api/share/readonly`, { method: "POST" });
      assert.equal(unsafeShare.status, 400);
    } finally {
      await openServer.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
