import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRunController } from "./agent_run_controller.js";
import type { AgentTaskContract } from "./agentic_runtime.js";
import { WriterProject } from "./project.js";
import {
  advanceRunFulfillmentStagnation,
  parseRunFulfillmentVerdict,
  runFulfillmentEvidenceFingerprint,
  runFulfillmentMessages,
} from "./run_completion.js";
import {
  chapterContinuationPrompt,
  isNarrativeDocumentDelivery,
  semanticDocumentContextMessages,
  taskInstructions,
} from "./agent.js";
import { WriterStore } from "./store.js";

const adaptiveTask: AgentTaskContract = {
  mode: "general",
  outcome: "multiple",
  evidence: "none",
  mutation: "mixed",
  planning: "adaptive",
  capabilities: ["documents", "characters", "review"],
};

test("completion requires a persisted review of the immutable original intent", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-intent-review-"));
  const project = WriterProject.init(root, "意图验收");
  const store = new WriterStore(project);
  try {
    const originalRequest = "写五章，并按需要创建配角";
    const controller = AgentRunController.open({
      store,
      sessionId: store.createSession("intent-review"),
      sourceMessageId: 1,
      originalRequest,
      task: adaptiveTask,
      permissionMode: "auto",
      reusableEvidence: false,
      resumeInterrupted: false,
    });

    controller.observeTool("save_simple_character", JSON.stringify({
      status: "created",
      name: "向导",
    }), "test:character");
    assert.equal(controller.snapshot.originalRequest, originalRequest);
    assert.equal(controller.snapshot.progress.characterArtifactProduced, true);
    assert.equal(controller.snapshot.deliverables.length, 0);
    assert.deepEqual(controller.complete(adaptiveTask, "角色卡已保存"), ["尚未通过原始用户意图验收"]);

    controller.recordIntentReview({
      status: "unsatisfied",
      missing: "五章正文尚未交付",
      nextStep: "继续撰写并提交第一章",
    }, "test:intent:unsatisfied");
    assert.deepEqual(controller.complete(adaptiveTask, "角色卡已保存"), ["尚未通过原始用户意图验收"]);

    controller.recordIntentReview({
      status: "satisfied",
      reason: "用户要求的正文与配角均已交付",
    }, "test:intent:satisfied");
    assert.deepEqual(controller.complete(adaptiveTask, "全部交付"), []);
    assert.equal(controller.snapshot.status, "completed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resuming execution invalidates an earlier satisfied intent review", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-intent-resume-"));
  const project = WriterProject.init(root, "意图续跑");
  const store = new WriterStore(project);
  try {
    const controller = AgentRunController.open({
      store,
      sessionId: store.createSession("intent-resume"),
      sourceMessageId: 2,
      originalRequest: "整理现有材料后给出结论",
      task: adaptiveTask,
      permissionMode: "ask",
      reusableEvidence: false,
      resumeInterrupted: false,
    });
    controller.recordIntentReview({ status: "satisfied", reason: "结论完整" }, "test:intent:first");
    controller.recordExecutionPlan({
      commitment: "全书按六章交付",
      remaining: "第一章至第六章",
    }, "test:plan:first");
    assert.equal(controller.snapshot.intentReview?.status, "satisfied");
    controller.recordStep(1);
    assert.equal(controller.snapshot.intentReview, undefined);
    assert.equal(controller.snapshot.executionPlan?.commitment, "全书按六章交付");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fulfillment review receives the locked request and execution permission", () => {
  const messages = runFulfillmentMessages({
    originalRequest: "至少写五章",
    finalText: "已完成资料准备。",
    delivered: [],
    stalled: [],
    otherArtifacts: ["角色卡已保存"],
    permissionMode: "auto",
    executionPlan: { commitment: "全书按六章交付", remaining: "尚余六章" },
  });
  const payload = JSON.parse(messages[1].content) as Record<string, unknown>;
  assert.equal(payload.request, "至少写五章");
  assert.equal(payload.permissionMode, "auto");
  assert.deepEqual(payload.deliveredDocuments, []);
  assert.deepEqual(payload.otherArtifacts, ["角色卡已保存"]);
  assert.deepEqual(payload.existingExecutionPlan, { commitment: "全书按六章交付", remaining: "尚余六章" });

  assert.equal(parseRunFulfillmentVerdict("not-json"), undefined);
  assert.deepEqual(parseRunFulfillmentVerdict(JSON.stringify({
    satisfied: false,
    missing: "五章正文尚未交付",
    nextStep: "先写第一章",
    planCommitment: "全书按六章交付",
    remainingPlan: "继续交付第一章至第六章",
  })), {
    satisfied: false,
    missing: "五章正文尚未交付",
    nextStep: "先写第一章",
    planCommitment: "全书按六章交付",
    remainingPlan: "继续交付第一章至第六章",
  });
});

test("fulfillment convergence counts stagnation, not productive document delivery", () => {
  const snapshot = (delivered: string[]) => ({
    originalRequest: "写六章",
    finalText: "继续执行。",
    delivered,
    stalled: [],
    otherArtifacts: [],
    permissionMode: "auto" as const,
  });
  let state = { fingerprint: "", stagnantReviews: 0 };
  for (const delivered of [
    ["chapters/01.md"],
    ["chapters/01.md", "chapters/02.md"],
    ["chapters/01.md", "chapters/02.md", "chapters/03.md"],
  ]) {
    state = advanceRunFulfillmentStagnation(
      state,
      runFulfillmentEvidenceFingerprint(snapshot(delivered)),
    );
    assert.equal(state.stagnantReviews, 0);
  }
  const unchanged = runFulfillmentEvidenceFingerprint(snapshot([
    "chapters/01.md", "chapters/02.md", "chapters/03.md",
  ]));
  let verdict = advanceRunFulfillmentStagnation(state, unchanged);
  assert.equal(verdict.shouldPause, false);
  verdict = advanceRunFulfillmentStagnation(verdict, unchanged);
  assert.equal(verdict.shouldPause, false);
  verdict = advanceRunFulfillmentStagnation(verdict, unchanged);
  assert.equal(verdict.shouldPause, true);
});

test("clean semantic documents keep stable order and exclude tool envelopes", () => {
  const messages = semanticDocumentContextMessages([
    {
      path: "lore/world.md",
      sourceHash: "lore-hash",
      body: "世界设定正文",
      digest: "世界设定摘要",
      source: "read",
    },
    {
      path: "chapters/01.md",
      sourceHash: "chapter-hash",
      body: "第一章正文",
      digest: "第一章摘要",
      source: "generated",
    },
  ], 10_000);
  assert.equal(messages.length, 2);
  assert.match(String(messages[0].content), /lore\/world\.md[\s\S]*世界设定正文/);
  assert.match(String(messages[1].content), /chapters\/01\.md[\s\S]*第一章正文/);
  assert.doesNotMatch(messages.map(item => String(item.content)).join("\n"), /tool_call|reasoning_content/);
});

test("global execution plan outranks a local chapter next step", () => {
  const prompt = chapterContinuationPrompt({
    nextStep: "下一步先写第二章。",
    executionPlan: { commitment: "全书按六章交付", remaining: "还需第二章至第六章" },
    deliveredPaths: ["chapters/01.md"],
    proseLength: { targetCharacters: 6_000, source: "settings", mode: "guidance" },
    delegatedWriting: true,
  });
  assert.match(prompt, /全书按六章交付/);
  assert.match(prompt, /还需第二章至第六章/);
  assert.match(prompt, /不得缩减、改写或替代全局承诺/);
  assert.match(prompt, /下一章篇幅参考：约 6000 字/);
  assert.match(prompt, /不允许写前忽略目标或在目标一半处提前收束/);
  assert.match(prompt, /上一章 write pack 已失效/);
  assert.match(prompt, /重新 compile_write_pack/);
  assert.match(prompt, /write_file\(path\) 并省略 content/);
  assert.equal(isNarrativeDocumentDelivery("chapters/01.md"), true);
  assert.equal(isNarrativeDocumentDelivery("side/番外.md"), true);
  assert.equal(isNarrativeDocumentDelivery("lore/雪线行动.md"), false);
  assert.equal(isNarrativeDocumentDelivery("outline/六章规划.md"), false);
});

test("delegated chapter instructions require a fresh write pack and treat guidance as a drafting target", () => {
  const delegated = taskInstructions("write_scene", "deliver", "auto", true, 3_000, false, false);
  assert.match(delegated, /每个新章节都是独立交付单元/);
  assert.match(delegated, /上一章的 write pack 已失效/);
  assert.match(delegated, /不得直接在 write_file 中提交整章 content/);
  assert.match(delegated, /弱引导仍是写前目标/);
  assert.match(delegated, /不授权在目标一半处提前结束/);

  const fast = taskInstructions("write_scene", "deliver", "auto", true, 3_000, true, false);
  assert.doesNotMatch(fast, /每个新章节都是独立交付单元/);
});
