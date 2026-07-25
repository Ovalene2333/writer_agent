import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIsolatedSceneWriterMessages,
  buildSceneStateExtractionMessages,
  IsolatedSceneRequestError,
  isolatedSceneWriterMaxTokens,
  isolatedSceneWriterSamplingOptions,
  parseSceneActualState,
} from "./isolated_scene_writer.js";
import { nonThinkingRequestOptions } from "./model_compat.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { executeTool } from "./tools/index.js";
import type { ToolExecutionContext } from "./tools/types.js";
import type { WritePack } from "./write_pack.js";

const scene = {
  id: "armor",
  title: "误差",
  goal: "确认情报存在偏差",
  entryState: ["两人被困在火力覆盖下"],
  characterIntent: ["林岚想确认撤退路线", "周策不愿承认自己信错了委托书"],
  obstacle: "装甲比预期更厚，第二发弹药只剩一枚",
  turn: "林岚发现偏差来自委托方使用了旧参数",
  outcome: "两人放弃正面击穿，改为诱导目标转向",
  handoff: "目标转向后暴露侧面入口",
  dividerBefore: false,
  targetCharacters: 400,
};

const pack: WritePack = {
  sourceDraft: "",
  sceneGoal: "让两人改变战术",
  beatOrder: ["第一发命中但没有击穿", "林岚检查回传曲线"],
  knownFacts: ["双方都读过委托书上的装甲参数"],
  mustLand: ["装甲实际厚度比旧参数高三成"],
  characterState: ["林岚仍在怀疑自己的计算"],
  voiceNotes: ["对白简短，动作留白"],
  doNotInvent: ["不要确定委托方是否故意造假"],
  narrativeBrief: "",
  structured: true,
  strippedMeta: [],
};

const state = (situation: string) => ({
  situation: [situation], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
});

test("isolated scene writer receives only the current prose packet", () => {
  const messages = buildIsolatedSceneWriterMessages({
    scene,
    writePack: pack,
    voiceSample: "雨水顺着炮管往下淌。",
    previousTail: "第一发炮弹撞上装甲，火光一闪就灭了。",
    currentState: state("炮位已经暴露"),
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.match(messages[0].content, /只写眼前正在发生的这一场戏/u);
  assert.match(messages[0].content, /压力如何改变选择/u);
  assert.match(messages[0].content, /对白是人物对彼此采取的行动/u);
  assert.match(messages[0].content, /环境不是布景清单/u);
  assert.match(messages[0].content, /不是待逐项改写的清单/u);
  assert.match(messages[1].content, /以下事情已经成立/u);
  assert.match(messages[1].content, /双方都读过委托书/u);
  assert.match(messages[1].content, /不是台词任务/u);
  assert.match(messages[1].content, /可以合并、改序或舍弃/u);
  assert.match(messages[1].content, /对白简短，动作留白/u);
  assert.match(messages[1].content, /绝不要超过 800 字/u);
  assert.doesNotMatch(messages[1].content, /［|^\s*[-•]\s/mu);
  assert.doesNotMatch(messages[1].content, /chapters\//u);
  assert.doesNotMatch(messages[1].content, /write_chapter_scene|actualState|styleFeedback|todo/iu);
  assert.ok(messages.reduce((sum, message) => sum + message.content.length, 0) < 4_000);
});

test("isolated scene writer explicitly suppresses narrator negation-redefinition frames", () => {
  const messages = buildIsolatedSceneWriterMessages({
    scene,
    writePack: pack,
  });
  assert.match(messages[0].content, /先否定、再改判/);
  assert.match(messages[0].content, /不是……。是……。/);
  assert.match(messages[0].content, /对白中符合人物语气的即时纠正不受此限/);
});

test("scene state extraction receives only bounded next-scene relevance fields", () => {
  const messages = buildSceneStateExtractionMessages({
    previousState: state("炮位已经暴露"),
    sceneContent: "林岚收起瞄具，示意周策把目标引向坡道。",
    nextScene: { goal: "从侧面攻击", entryState: [], characterIntent: [], obstacle: "目标仍在转向" },
  });
  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /炮位已经暴露/u);
  assert.match(messages[1].content, /引向坡道/u);
  assert.match(messages[1].content, /从侧面攻击/u);
  assert.doesNotMatch(messages[1].content, /turn|outcome/u);

  const parsed = parseSceneActualState(JSON.stringify({
    situation: ["目标开始转向坡道"],
    physical: [], knowledge: ["林岚确认正面无法击穿"], relationships: [],
    goals: ["攻击暴露的侧面"], openLoops: [], usedMotifs: ["雨水"],
  }));
  assert.deepEqual(parsed.situation, ["目标开始转向坡道"]);
  assert.deepEqual(parsed.usedMotifs, ["雨水"]);
  const capped = parseSceneActualState(JSON.stringify({
    situation: ["1", "2", "3", "4"], physical: ["1", "2", "3"],
    knowledge: ["1", "2", "3", "4"], relationships: ["1", "2", "3"],
    goals: ["1", "2", "3"], openLoops: ["1", "2", "3", "4"], usedMotifs: ["1", "2", "3", "4"],
  }));
  assert.deepEqual(Object.values(capped).map(values => values.length), [3, 2, 3, 2, 2, 3, 3]);
});

test("isolated requests reserve output room and disable thinking for state extraction", () => {
  assert.equal(isolatedSceneWriterMaxTokens({ scene, writePack: pack }), 2_400);
  assert.equal(isolatedSceneWriterMaxTokens({ scene, writePack: pack, maximumCharacters: 3_000 }), 6_600);
  assert.equal(isolatedSceneWriterMaxTokens({ scene, writePack: pack, strictMaximumCharacters: 3_000 }), 6_600);
  assert.deepEqual(isolatedSceneWriterSamplingOptions({}), {});
  assert.deepEqual(isolatedSceneWriterSamplingOptions({ temperature: 0.85, topP: 0.9 }), {
    temperature: 0.85,
    top_p: 0.9,
  });
  assert.deepEqual(nonThinkingRequestOptions({
    provider: "deepseek", baseUrl: "https://api.deepseek.com/v1",
  }), { thinking: { type: "disabled" } });
  assert.deepEqual(nonThinkingRequestOptions({
    provider: "openai-compatible", baseUrl: "https://api.openai.com/v1",
  }), {});
});

test("isolated scene tool writes prose and extracts state in separate calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-isolated-scene-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "隔离正文实验");
    store = new WriterStore(project);
    const sessionId = store.createSession("隔离正文");
    const calls: string[] = [];
    const usageKinds: string[] = [];
    let stateAttempts = 0;
    const content = [
      "第一发炮弹撞上去，只在装甲上留下了一圈发白的擦痕。",
      "林岚盯着回传曲线看了两秒。\n\n「三成？」\n\n周策没回头，只把最后一枚弹匣推回去：「你还信委托书？」",
      "她关掉瞄具，抬手指向坡道。周策会意，发动机随即压低了声音。目标没有立刻追来，炮塔先在雨里转了半圈，像是在寻找刚才那发炮弹留下的热迹。",
      "周策把车身往掩体外送了半米，履带碾碎路边的排水槽。林岚没有催他，只看着坡道上那块松动的护栏；等炮塔终于咬住他们，才用两根手指向右一划。",
      "车猛地倒进低地。第二发炮弹擦过顶盖，砸断护栏，碎石和积水一同泼上观察窗。目标为了追踪他们继续转向，原本藏在裙甲后的检修口露了出来。",
      "「现在呢？」周策问。\n\n林岚重新扣下瞄具。那枚弹匣在他手边轻轻碰了一声。\n\n「现在可以信我。」",
    ].join("\n\n");
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      scenePipelineSettings: {
        preferredMinScenes: 1, preferredMaxScenes: 3, maxScenes: 5,
        notesMaxCharacters: 3_000, isolatedWriterMaxRatio: 2, isolatedWriter: true, candidateCount: 1,
      },
      modelUsageReporter: (_model, _usage, meta) => usageKinds.push(meta.callKind),
      isolatedSceneWriter: {
        model: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "writer-test" },
        stateModel: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "state-test" },
        run: async (_model, input) => {
          calls.push("writer");
          assert.equal(input.scene.id, "armor");
          assert.deepEqual(input.writePack.knownFacts, ["双方都读过委托书上的装甲参数"]);
          assert.equal(input.currentState, undefined);
          if (!input.strictMaximumCharacters) {
            throw new IsolatedSceneRequestError(
              "隔离正文 Writer 输出达到长度上限",
              "writer",
              { promptTokens: 300, completionTokens: 300, cacheHitTokens: 0, cacheMissTokens: 300 },
              1_100,
              "truncated",
            );
          }
          assert.equal(input.maximumCharacters, 800);
          assert.equal(input.strictMaximumCharacters, 800);
          return {
            content,
            usage: { promptTokens: 300, completionTokens: 200, cacheHitTokens: 0, cacheMissTokens: 300 },
            requestCharacters: 1_100,
          };
        },
        extractState: async (_model, input) => {
          calls.push("state");
          assert.equal(input.sceneContent, content);
          assert.equal(input.previousState, undefined);
          assert.equal(input.nextScene, undefined);
          stateAttempts += 1;
          if (stateAttempts <= 2) {
            assert.equal(input.retryJsonOnly, stateAttempts === 1 ? undefined : true);
            throw new IsolatedSceneRequestError(
              "场景状态提取没有返回 JSON 对象",
              "state",
              { promptTokens: 180, completionTokens: 900, cacheHitTokens: 0, cacheMissTokens: 180 },
              900,
              "invalid_output",
            );
          }
          assert.equal(input.retryJsonOnly, undefined);
          return {
            actualState: state("两人改为诱导目标转向"),
            usage: { promptTokens: 180, completionTokens: 60, cacheHitTokens: 0, cacheMissTokens: 180 },
            requestCharacters: 900,
          };
        },
      },
    };
    const call = (name: string, input: Record<string, unknown>) => executeTool(
      { id: name, name, arguments: JSON.stringify(input) }, project, store!, sessionId, () => {}, undefined, context,
    );
    await call("begin_chapter_draft", {
      path: "chapters/第一章.md", mode: "create", heading: "第一章", chapterGoal: "改变战术", scenes: [scene],
    });
    const failed = JSON.parse(await call("write_chapter_scene", {
      notes: "## 已知事实\n双方都读过委托书上的装甲参数\n## 须自然落地\n装甲实际厚度比旧参数高三成",
    })) as Record<string, unknown>;
    assert.match(String(failed.error), /正文已暂存/u);
    const result = JSON.parse(await call("write_chapter_scene", {
      notes: "状态提取重试；正文已经生成，不要重新生成。",
    })) as Record<string, unknown>;
    assert.deepEqual(calls, ["writer", "writer", "state", "state", "state"]);
    assert.deepEqual(usageKinds, [
      "isolated_scene_writer_failed",
      "isolated_scene_writer_length_retry",
      "isolated_scene_state_failed",
      "isolated_scene_state_retry_failed",
      "isolated_scene_state",
    ]);
    assert.equal(result.status, "written", JSON.stringify(result));
    assert.equal(result.complete, true);
    assert.equal("content" in result, false, "generated prose must stay outside the Agent tool transcript");
    assert.deepEqual(result.generation, {
      mode: "isolated", writerInputCharacters: 1_100, stateInputCharacters: 900,
    });
    assert.equal(context.chapterSceneDraft?.completed[0].content, content);
    assert.deepEqual(context.chapterSceneDraft?.completed[0].actualState.situation, ["两人改为诱导目标转向"]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
