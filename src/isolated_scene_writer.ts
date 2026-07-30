import { logModelRequest, logModelResponse } from "./model_debug.js";
import { nonThinkingRequestOptions, samplingRequestOptions, type SamplingRequestBody } from "./model_compat.js";
import { modelFetch } from "./model_fetch.js";
import { parseModelTokenUsage } from "./model_usage.js";
import {
  proseCharacterCount,
  proseLengthAdjustmentInstruction,
  proseTargetBounds,
  type ProseLengthAssessment,
} from "./prose_length.js";
import type { ChapterSceneCard, SceneActualState } from "./scene_pipeline.js";
import type { ModelConfig, ModelTokenUsage } from "./types.js";
import type { WritePack } from "./write_pack.js";

export type IsolatedSceneWriterInput = {
  scene: ChapterSceneCard;
  writePack: WritePack;
  previousTail?: string;
  currentState?: SceneActualState;
  /** Imitation target from outside the draft (范文 / 模板范例). */
  voiceSample?: string;
  /** The work's own prior prose — continuity anchor when there is no in-chapter seam. */
  voiceContinuation?: string;
  /** Active style template + craft baseline, prepared by the caller. */
  styleDirectives?: string;
  /** Machine-measured anti-self-imitation and vividness notes for this scene. */
  avoidNotes?: string[];
  maximumCharacters?: number;
  strictMinimumCharacters?: number;
  strictMaximumCharacters?: number;
  lengthAdjustment?: ProseLengthAssessment;
};

export { proseCharacterCount, proseTargetBounds };

export type SceneStateExtractionInput = {
  previousState?: SceneActualState;
  sceneContent: string;
  nextScene?: Pick<ChapterSceneCard, "goal" | "entryState" | "characterIntent" | "obstacle">;
  retryJsonOnly?: boolean;
};

export type IsolatedSceneWriterResult = {
  content: string;
  usage?: ModelTokenUsage;
  requestCharacters: number;
};

export type SceneStateExtractionResult = {
  actualState: SceneActualState;
  usage?: ModelTokenUsage;
  requestCharacters: number;
};

export class IsolatedSceneRequestError extends Error {
  constructor(
    message: string,
    readonly stage: "writer" | "state",
    readonly usage?: ModelTokenUsage,
    readonly requestCharacters = 0,
    readonly failureKind: "http" | "truncated" | "invalid_output" = "invalid_output",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IsolatedSceneRequestError";
  }
}

const ISOLATED_WRITER_SYSTEM = `你是成熟的中文小说作者，只写眼前正在发生的这一场戏。你不参与规划、审查、状态管理或工具调用，也不向读者展示写作材料的结构。

一场戏的生命不在信息量，而在压力如何改变选择。始终贴住视角人物此刻能注意到什么、误会什么、想得到什么、又不愿付出什么；让每个动作既处理眼前问题，也暴露人物。转折应由此前动作招致，意外发生后要让人回看时觉得早有迹象。关键瞬间可以放慢，过门、解释和重复过程应果断压缩。

对白是人物对彼此采取的行动。人物会索取、遮掩、试探、拖延、转移、刺痛或让步，很少把双方已经知道的事实完整说出来。让答非所问、停顿、动作与措辞承担潜台词；不同人物应有不同的注意力、句法和回避方式。

环境不是布景清单。只写那些被人物利用、躲避、误读，或会改变身体感受和下一步动作的细节。情绪不要先命名再证明，而要落在注意力偏移、动作时机、身体失误、过度克制和没有说出口的话里。允许读者比人物早一步或晚一步明白，允许段落在余波尚未解释时结束。

具体事实要以证据和后果出现，不以维护报告、设定讲义或作者总结出现。量化可以是人物决策的工具，却不能成为叙述腔；每场最多保留一个真正改变选择的测量簇，其余参数改写为可感后果或省略。技术原理、计算过程和状态播报只有在当下行动非知道不可时才占用篇幅。

输入中的场景目标、转折和事实有主次，不是待逐项改写的清单。合并能够由同一动作完成的内容，舍弃不影响本场变化的背景，让场景沿一条清楚的欲望与阻力线生长。声线样本只用于学习叙述距离、节奏和措辞，不借用其中的人物、意象或事件。

一拍一事：单句只推进一个主要事件或判断；不要把设定名、编号、关系、原因、后果与情绪焊进同一句（预告片/AI 网剧旁白腔）。叙述写清谁在感知与行动，保留必要人称主语，勿压成简报或操作日志。专名与读数克制出场，其余写成可感后果。句长与段长要有起伏，一段只让读者记住一件新事；勿整章均齐模子。

避免用叙述者先否定、再改判来制造力度，包括「不是……是/而是……」以及拆成「不是……。是……。」的同构短句。直接写真正成立的动作、感受或事实；需要排除误解时，让人物对白、观察过程或后续后果完成。也不要连续用「没有……只有……」「与其说……不如说……」替读者归纳意义。写完后逐段检查并改掉这些叙述框架，对白中符合人物语气的即时纠正不受此限。

只输出可直接入稿的本场正文，不要标题、说明、清单、JSON 或代码围栏。`;

const STATE_EXTRACTOR_SYSTEM = `你是小说场景状态压缩器。根据 previousState 和 sceneContent，输出正文结束时、下一场仍需要的最小当前状态；nextScene 只用于相关性筛选，不是已经发生的事实。
删除已被新状态覆盖、与下一场无关或可从正文尾部直接看出的旧记录；不要保存计算过程、装饰性读数、技术原理或事件复述。只有会约束后续行动的伤势、位置、所知、关系、目标和未决问题才保留。不得把计划、推测或未发生事项写成事实。
只输出 JSON：situation 最多3项、physical 2项、knowledge 3项、relationships 2项、goals 2项、openLoops 3项、usedMotifs 3项；每项一句短事实。前五类至少一项记录当前有效变化，没有则为空数组。不要说明或 Markdown。`;

export function buildIsolatedSceneWriterMessages(
  input: IsolatedSceneWriterInput,
): Array<{ role: "system" | "user"; content: string }> {
  const sections: string[] = [
    "请把下面的材料化成一场正在发生的小说，而不是一份被扩写的提纲。人物当下和局面变化决定场景，背景事实只在需要时约束它。",
  ];
  const voiceSample = input.voiceSample?.trim().slice(-1_200);
  const previousTail = input.previousTail?.trim().slice(-800);
  const voiceContinuation = input.voiceContinuation?.trim().slice(-1_200);
  if (voiceSample) {
    sections.push(`先听准这段文字的呼吸、叙述距离和用词习惯；只学写法，不沿用其中的内容：\n\n${voiceSample}`);
  }
  if (previousTail) {
    sections.push(`故事刚刚停在这里。不要复述，接住它留下的动作、语气和未完成的压力：\n\n${previousTail}`);
  } else if (voiceContinuation) {
    // Chapter opening: no in-chapter seam yet, so the work's own tail carries continuity.
    // Once a seam exists it is the better anchor and this slot drops out.
    sections.push(`这部作品此前的正文停在这里。新的一场要像同一支笔写下去，但不要延用它的句式清单或意象：\n\n${voiceContinuation}`);
  }

  const currentState = formatCurrentState(input.currentState);
  if (currentState) {
    sections.push(`进入这一场时，仍然有效的局面是：${currentState.replace(/\n/gu, "；")}。`);
  }

  const characterPressure = compactLines([
    ...input.scene.entryState,
    ...input.scene.characterIntent,
    ...input.writePack.characterState,
  ]);
  const sceneGoal = compactLines([input.scene.goal, input.writePack.sceneGoal]);
  sections.push(
    `这场戏要处理的是${naturalClause(sceneGoal)}。真正挡在人物面前的是${naturalClause([input.scene.obstacle])}。`
    + (characterPressure.length ? `人物带进现场的压力包括${naturalClause(characterPressure)}。` : ""),
  );
  if (input.writePack.narrativeBrief.trim()) {
    sections.push(`还有一层必要语境：${input.writePack.narrativeBrief.trim()}。它只帮助理解现场，不要求逐句兑现。`);
  }

  sections.push(
    `局面应在过程中被“${input.scene.turn}”推偏，最后落到“${input.scene.outcome}”。`
    + "让读者从行动、反应、证据和后果中亲眼看见这次变化，不让人物替材料作总结。",
  );
  const mustLand = compactLines(input.writePack.mustLand);
  if (mustLand.length) {
    sections.push(`正文还需要自然留下这些可被读者察觉的事实：${naturalClause(mustLand)}。尽量让一个动作同时承担事实、关系和后果。`);
  }

  const silentFacts = compactLines(input.writePack.knownFacts);
  if (silentFacts.length) {
    sections.push(`以下事情已经成立：${naturalClause(silentFacts)}。它们是边界，不是台词任务；现场没有理由提起时就让它们保持沉默。`);
  }

  const actionPossibilities = compactLines(input.writePack.beatOrder).slice(0, 6);
  if (actionPossibilities.length) {
    sections.push(`动作可能沿着${naturalClause(actionPossibilities)}发展。这只是几条可能的路径，可以合并、改序或舍弃；因果与人物选择比材料顺序重要。`);
  }

  const forbidden = compactLines(input.writePack.doNotInvent);
  if (forbidden.length) {
    sections.push(`有些空白现在必须保留：${naturalClause(forbidden)}。不要替后文提前作答。`);
  }
  const voiceNotes = compactLines(input.writePack.voiceNotes);
  if (voiceNotes.length) {
    sections.push(`叙述时还请记住：${naturalClause(voiceNotes)}。这些提醒服从现场，不要把它们写成可见技巧。`);
  }
  // Measured from the prose already written in this chapter and the previous one.
  // The standard scene path has always received these; the isolated path — the one
  // most exposed to self-imitation, since it re-reads its own output every scene —
  // used to get nothing.
  const avoidNotes = compactLines(input.avoidNotes ?? []);
  if (avoidNotes.length) {
    sections.push(`已写正文的机器统计给出这些要求，写这一场时遵守：\n${avoidNotes.map(note => `- ${note}`).join("\n")}`);
  }

  const target = input.scene.targetCharacters;
  const maximumCharacters = input.strictMaximumCharacters
    ?? input.maximumCharacters
    ?? (target ? Math.floor(target * 2) : undefined);
  // 只给目标和硬上限，绝不报下限：模型会把它看到的最小合法值当成目标，
  // 一路写到那里就收尾，于是下限反而成了实际篇幅（还常常压不住地掉到线下）。
  sections.push(target
    ? `目标篇幅是 ${target} 字${maximumCharacters ? `，硬上限 ${maximumCharacters} 字` : ""}。写足这次变化需要的动作、阻力、后果与余波，宁可略超目标也不要提前收尾；过门、解释和重复过程应压缩，不得用总结、回顾或同义反复凑字。`
    : "变化完成、余波抵达时就结束，不用解释或回顾来填满篇幅。");
  if (input.lengthAdjustment && input.lengthAdjustment.status !== "ok") {
    sections.push(proseLengthAdjustmentInstruction(input.lengthAdjustment));
  }
  if (input.strictMinimumCharacters) {
    sections.push(`这一次正文不得少于 ${input.strictMinimumCharacters} 字。`);
  }
  if (input.strictMaximumCharacters) {
    sections.push(`这一次正文不得超过 ${input.strictMaximumCharacters} 字。`);
  }

  const styleDirectives = input.styleDirectives?.trim();
  return [
    { role: "system", content: ISOLATED_WRITER_SYSTEM },
    // Project-level constraints as a separate system message so the craft prompt
    // above stays byte-identical across every scene and project.
    ...(styleDirectives ? [{ role: "system" as const, content: styleDirectives }] : []),
    { role: "user", content: sections.join("\n\n") },
  ];
}

function naturalClause(values: string[]): string {
  const clean = compactLines(values).map(value => `“${value}”`);
  if (!clean.length) return "眼前尚未解决的事";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]}和${clean[1]}`;
  return `${clean.slice(0, -1).join("、")}以及${clean.at(-1)}`;
}

export function buildSceneStateExtractionMessages(
  input: SceneStateExtractionInput,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: STATE_EXTRACTOR_SYSTEM },
    {
      role: "user",
      content: JSON.stringify({
        previousState: input.previousState ?? emptyState(),
        sceneContent: input.sceneContent,
        ...(input.nextScene ? { nextScene: input.nextScene } : {}),
        ...(input.retryJsonOnly ? { outputReminder: "只返回完整 JSON 对象，不输出分析过程。" } : {}),
      }),
    },
  ];
}

export async function requestIsolatedScene(
  model: ModelConfig,
  input: IsolatedSceneWriterInput,
  signal?: AbortSignal,
): Promise<IsolatedSceneWriterResult> {
  const messages = buildIsolatedSceneWriterMessages(input);
  const requestCharacters = messageCharacters(messages);
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model: model.model,
    messages,
    stream: false,
    ...isolatedSceneWriterSamplingOptions(model),
    max_tokens: isolatedSceneWriterMaxTokens(input),
  });
  logModelRequest(endpoint, body);
  const response = await modelFetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body,
  }, model.proxyUrl);
  const responseBody = await response.text();
  logModelResponse(endpoint, responseBody);
  let payload: { choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>; usage?: unknown };
  try {
    payload = JSON.parse(responseBody) as typeof payload;
  } catch (error) {
    throw new IsolatedSceneRequestError(
      "隔离正文 Writer 返回的响应不是 JSON", "writer", undefined, requestCharacters, "invalid_output", { cause: error },
    );
  }
  const usage = parseModelTokenUsage(payload.usage);
  if (!response.ok) {
    throw new IsolatedSceneRequestError(
      `隔离正文 Writer 请求失败（${response.status}）：${responseBody.slice(0, 240)}`,
      "writer", usage, requestCharacters, "http",
    );
  }
  if (payload.choices?.[0]?.finish_reason === "length") {
    throw new IsolatedSceneRequestError(
      "隔离正文 Writer 输出达到长度上限", "writer", usage, requestCharacters, "truncated",
    );
  }
  const content = cleanPlainProse(payload.choices?.[0]?.message?.content ?? "");
  if (!content) {
    throw new IsolatedSceneRequestError(
      "隔离正文 Writer 没有返回正文", "writer", usage, requestCharacters, "invalid_output",
    );
  }
  return { content, ...(usage ? { usage } : {}), requestCharacters };
}

export function isolatedSceneWriterSamplingOptions(
  model: Pick<ModelConfig, "temperature" | "topP" | "disableSampling">,
): SamplingRequestBody {
  return samplingRequestOptions(model);
}

export function isolatedSceneWriterMaxTokens(input: IsolatedSceneWriterInput): number {
  const outputCharacters = input.strictMaximumCharacters
    ?? input.maximumCharacters
    ?? input.scene.targetCharacters
    ?? 2_500;
  return Math.min(12_000, Math.max(2_400, Math.ceil(outputCharacters * 22 / 10)));
}

export async function requestSceneStateExtraction(
  model: ModelConfig,
  input: SceneStateExtractionInput,
  signal?: AbortSignal,
): Promise<SceneStateExtractionResult> {
  const messages = buildSceneStateExtractionMessages(input);
  const requestCharacters = messageCharacters(messages);
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model: model.model,
    messages,
    stream: false,
    ...samplingRequestOptions(model, { temperature: 0 }),
    max_tokens: input.retryJsonOnly ? 2_400 : 1_800,
    response_format: { type: "json_object" },
    ...nonThinkingRequestOptions(model),
  });
  logModelRequest(endpoint, body);
  const response = await modelFetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body,
  }, model.proxyUrl);
  const responseBody = await response.text();
  logModelResponse(endpoint, responseBody);
  let payload: { choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>; usage?: unknown };
  try {
    payload = JSON.parse(responseBody) as typeof payload;
  } catch (error) {
    throw new IsolatedSceneRequestError(
      "场景状态提取响应不是 JSON", "state", undefined, requestCharacters, "invalid_output", { cause: error },
    );
  }
  const usage = parseModelTokenUsage(payload.usage);
  if (!response.ok) {
    throw new IsolatedSceneRequestError(
      `场景状态提取请求失败（${response.status}）：${responseBody.slice(0, 240)}`,
      "state", usage, requestCharacters, "http",
    );
  }
  if (payload.choices?.[0]?.finish_reason === "length") {
    throw new IsolatedSceneRequestError(
      "场景状态提取输出达到长度上限", "state", usage, requestCharacters, "truncated",
    );
  }
  try {
    const actualState = parseSceneActualState(payload.choices?.[0]?.message?.content ?? "");
    return { actualState, ...(usage ? { usage } : {}), requestCharacters };
  } catch (error) {
    throw new IsolatedSceneRequestError(
      error instanceof Error ? error.message : String(error),
      "state", usage, requestCharacters, "invalid_output", { cause: error },
    );
  }
}

export function parseSceneActualState(raw: string): SceneActualState {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("场景状态提取没有返回 JSON 对象");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("场景状态提取格式无效");
  const value = parsed as Record<string, unknown>;
  return {
    situation: stateList(value.situation, 3),
    physical: stateList(value.physical, 2),
    knowledge: stateList(value.knowledge, 3),
    relationships: stateList(value.relationships, 2),
    goals: stateList(value.goals, 2),
    openLoops: stateList(value.openLoops, 3),
    usedMotifs: stateList(value.usedMotifs, 3),
  };
}

function formatCurrentState(state?: SceneActualState): string {
  if (!state) return "";
  const rows = [
    ["局面", state.situation],
    ["身体", state.physical],
    ["所知", state.knowledge],
    ["关系", state.relationships],
    ["目标", state.goals],
    ["未决", state.openLoops],
  ] as const;
  return rows.filter(([, values]) => values.length)
    .map(([label, values]) => `${label}：${values.join("；")}`)
    .join("\n");
}

function compactLines(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function cleanPlainProse(raw: string): string {
  return raw.trim()
    .replace(/^```(?:markdown|md)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
}

function stateList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string")
    .map(item => item.trim().slice(0, 160)).filter(Boolean))].slice(0, limit);
}

function emptyState(): SceneActualState {
  return {
    situation: [], physical: [], knowledge: [], relationships: [], goals: [], openLoops: [], usedMotifs: [],
  };
}

function messageCharacters(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}
