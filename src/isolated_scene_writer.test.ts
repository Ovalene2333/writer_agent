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
  readerQuestion: "委托方为什么给了旧参数",
  cost: "最后一枚弹药已经打空，退路只剩一条",
  oppositionMove: "目标转动炮塔封住了他们原定的撤退线",
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
  assert.match(messages[1].content, /硬上限 800 字/u);
  assert.doesNotMatch(messages[1].content, /［|^\s*[-•]\s/mu);
  assert.doesNotMatch(messages[1].content, /chapters\//u);
  assert.doesNotMatch(messages[1].content, /write_chapter_scene|actualState|styleFeedback|todo/iu);
  assert.ok(messages.reduce((sum, message) => sum + message.content.length, 0) < 4_000);
});

test("isolated scene writer receives the project's style directives as its own system slot", () => {
  const messages = buildIsolatedSceneWriterMessages({
    scene,
    writePack: pack,
    styleDirectives: "本作品的激活风格模板：悬疑推理\n模板要求：线索先于结论出现。",
  });
  assert.equal(messages.length, 3);
  assert.equal(messages[1].role, "system");
  assert.match(messages[1].content, /悬疑推理/u);
  // The craft prompt must stay byte-identical across projects so it can be reasoned
  // about (and cached) independently of whichever template is active.
  assert.doesNotMatch(messages[0].content, /悬疑推理/u);
});

test("exemplar and continuation are separate slots with different jobs", () => {
  const withSeam = buildIsolatedSceneWriterMessages({
    scene,
    writePack: pack,
    voiceSample: "范文：檐下的水滴砸在铁皮上。",
    voiceContinuation: "本作旧稿：他把灯关了。",
    previousTail: "第一发炮弹撞上装甲，火光一闪就灭了。",
  });
  // Mid-chapter: the in-chapter seam is the continuity anchor, so the project tail
  // drops out — but the outside exemplar always stays.
  assert.match(withSeam[1].content, /范文：檐下的水滴/u);
  assert.match(withSeam[1].content, /火光一闪就灭了/u);
  assert.doesNotMatch(withSeam[1].content, /本作旧稿/u);

  const chapterOpening = buildIsolatedSceneWriterMessages({
    scene,
    writePack: pack,
    voiceSample: "范文：檐下的水滴砸在铁皮上。",
    voiceContinuation: "本作旧稿：他把灯关了。",
  });
  assert.match(chapterOpening[1].content, /范文：檐下的水滴/u);
  assert.match(chapterOpening[1].content, /本作旧稿/u);
});

test("isolated scene writer receives the anti-self-imitation notes the standard path always had", () => {
  const messages = buildIsolatedSceneWriterMessages({
    scene,
    writePack: pack,
    avoidNotes: ["上一章高频段首：「他的」；本章换用不同的开场形态。", "感官通道只有 2/5 出场。"],
  });
  assert.match(messages[1].content, /上一章高频段首/u);
  assert.match(messages[1].content, /感官通道只有 2\/5/u);
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
        enabled: true,
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
          assert.equal(input.strictMinimumCharacters, 300);
          assert.equal(input.strictMaximumCharacters, 540);
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
    const wrongMode = JSON.parse(await call("write_chapter_scene", {
      sceneId: "armor",
      notes: "## 场景目标\n改变战术",
      content: "这段正文不应被隔离模式接收。",
      actualState: state("不应写入"),
    })) as Record<string, unknown>;
    assert.match(String(wrongMode.error), /隔离 Writer 模式请调用 write_chapter_scene_notes/u);
    const failed = JSON.parse(await call("write_chapter_scene_notes", {
      sceneId: "armor",
      notes: "## 已知事实\n双方都读过委托书上的装甲参数\n## 须自然落地\n装甲实际厚度比旧参数高三成",
    })) as Record<string, unknown>;
    assert.match(String(failed.error), /正文已暂存/u);
    const result = JSON.parse(await call("write_chapter_scene_notes", {
      sceneId: "armor",
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

test("direct isolated document keeps prose generation outside the Agent transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-isolated-document-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "直接隔离正文");
    store = new WriterStore(project);
    const sessionId = store.createSession("直接正文");
    const usageKinds: string[] = [];
    const prose = [
      "雨沿着候机楼的玻璃往下淌。林岚把登机牌压在桌沿，等父亲把那杯没有动过的咖啡推回来。",
      "「到了那边先住学校安排的宿舍。」他说，「月底我把剩下的材料寄过去。」",
      "她把杯子接住，问的却是下一次复查。两个人对着日历算了几分钟，广播第三次催促登机时，纸上已经多了两个日期。",
      "父亲把那张写满时间的便签折了两折，塞进她护照夹最外层，又像怕动作太郑重似的补了一句只是顺手。林岚没有拆穿他，只把咖啡重新推回去，说飞机落地后会先发消息。",
      "检票口前的队伍慢慢缩短。她拖着箱子往前走了几步，听见父亲在身后叫她名字。那一声并不响，却让她回头看见他举起手机，屏幕上已经存好下一次复查和视频通话的提醒。",
      "她隔着人群点头。广播盖过了后半句话，但父亲的口型很清楚，是让她别省药，也别省电话。林岚把登机牌夹进书里，第一次没有急着说自己都知道。",
    ].join("\n\n");
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      characterEvolutionEnabled: false,
      scenePipelineSettings: {
        enabled: true,
        preferredMinScenes: 1, preferredMaxScenes: 3, maxScenes: 5,
        notesMaxCharacters: 3_000, isolatedWriterMaxRatio: 2, isolatedWriter: true, candidateCount: 1,
      },
      modelUsageReporter: (_model, _usage, meta) => usageKinds.push(meta.callKind),
      isolatedSceneWriter: {
        model: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "writer-test" },
        stateModel: { baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "state-test" },
        run: async (_model, input) => {
          assert.equal(input.scene.id, "direct-document");
          assert.equal(input.scene.targetCharacters, 500);
          assert.match(input.writePack.narrativeBrief, /机场/u);
          return {
            content: prose,
            usage: { promptTokens: 240, completionTokens: 160, cacheHitTokens: 0, cacheMissTokens: 240 },
            requestCharacters: 1_000,
          };
        },
      },
    };
    const result = JSON.parse(await executeTool({
      id: "direct",
      name: "write_document_isolated",
      arguments: JSON.stringify({
        path: "chapters/序章.md",
        mode: "create",
        heading: "序章",
        goal: "父女完成对未来安排的确认",
        obstacle: "登机时间逼近，两人都不习惯直接表达关心",
        turn: "讨论从住宿转到复查与下次见面",
        outcome: "两人留下明确日期后分别",
        notes: "机场候机区。父女关系不僵，重点是交换情况并规划未来。",
        targetCharacters: 500,
        summary: "新增序章",
      }),
    }, project, store, sessionId, () => {}, undefined, context)) as Record<string, unknown>;
    assert.equal(result.generationMode, "isolated_document");
    assert.equal(result.generatedCharacters, prose.length);
    assert.equal("content" in result, false);
    assert.deepEqual(usageKinds, ["isolated_document_writer"]);
    assert.equal(store.proposals()[0].afterContent, `# 序章\n\n${prose}`);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first writer pass sees the target and the ceiling but never a floor number", () => {
  // 模型会把它看到的最小合法值当成目标；报下限等于把下限变成实际篇幅。
  const messages = buildIsolatedSceneWriterMessages({ scene, writePack: pack });
  assert.match(messages[1].content, /目标篇幅是 400 字/u);
  assert.match(messages[1].content, /硬上限 800 字/u);
  assert.doesNotMatch(messages[1].content, /可接受范围/u);
  assert.doesNotMatch(messages[1].content, /不得少于/u);
  assert.doesNotMatch(messages[1].content, /300 字/u);
});

test("the retry pass is the only place a hard floor appears", () => {
  const messages = buildIsolatedSceneWriterMessages({
    scene,
    writePack: pack,
    strictMinimumCharacters: 360,
  });
  assert.match(messages[1].content, /不得少于 360 字/u);
});
