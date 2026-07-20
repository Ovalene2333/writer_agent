import { logModelRequest, logModelResponse } from "./model_debug.js";
import { nonThinkingRequestOptions } from "./model_compat.js";
import { modelFetch } from "./model_fetch.js";
import { parseModelTokenUsage } from "./model_usage.js";
import type { ChapterSceneCard, SceneActualState } from "./scene_pipeline.js";
import type { ModelConfig, ModelTokenUsage } from "./types.js";
import type { WritePack } from "./write_pack.js";

export type IsolatedSceneWriterInput = {
  scene: ChapterSceneCard;
  writePack: WritePack;
  previousTail?: string;
  currentState?: SceneActualState;
  voiceSample?: string;
  strictMaximumCharacters?: number;
};

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

const ISOLATED_WRITER_SYSTEM = `你是中文小说正文作者。你只负责写眼前这一场戏，不参与规划、审查、状态管理或工具调用。
人物依据此刻所知、误判、欲望与代价采取行动；对白用于现场中的索取、隐瞒、试探、拒绝或关系变化，不替读者复述双方共有知识。环境只在被人物注意、利用或妨碍行动时进入正文，不罗列感官。允许停顿、未说出口和读者自行判断，不在动作后补写意义总结。
量化是人物筛选信息并作出选择的方式，不是叙述文体。每场最多保留一个会改变下一步行动的测量簇；其余参数写成可感后果或省略。不要展开技术原理、计算过程或连续状态播报。
背景事实只约束写作，不代表必须在正文中提及。只输出可直接入稿的本场正文，不要标题、说明、清单、JSON 或代码围栏。`;

const STATE_EXTRACTOR_SYSTEM = `你是小说场景状态压缩器。根据 previousState 和 sceneContent，输出正文结束时、下一场仍需要的最小当前状态；nextScene 只用于相关性筛选，不是已经发生的事实。
删除已被新状态覆盖、与下一场无关或可从正文尾部直接看出的旧记录；不要保存计算过程、装饰性读数、技术原理或事件复述。只有会约束后续行动的伤势、位置、所知、关系、目标和未决问题才保留。不得把计划、推测或未发生事项写成事实。
只输出 JSON：situation 最多3项、physical 2项、knowledge 3项、relationships 2项、goals 2项、openLoops 3项、usedMotifs 3项；每项一句短事实。前五类至少一项记录当前有效变化，没有则为空数组。不要说明或 Markdown。`;

export function buildIsolatedSceneWriterMessages(
  input: IsolatedSceneWriterInput,
): Array<{ role: "system" | "user"; content: string }> {
  const sections: string[] = [];
  const voiceSample = input.voiceSample?.trim().slice(-1_200);
  const previousTail = input.previousTail?.trim().slice(-800);
  if (voiceSample) sections.push(`［声线样本］\n${voiceSample}`);
  if (previousTail) sections.push(`［紧接前文］\n${previousTail}`);

  const currentState = formatCurrentState(input.currentState);
  if (currentState) sections.push(`［当前局面］\n${currentState}`);

  const pressure = compactLines([
    input.scene.goal,
    ...input.scene.entryState,
    ...input.scene.characterIntent,
    input.scene.obstacle,
    ...input.writePack.characterState,
    input.writePack.sceneGoal,
    input.writePack.narrativeBrief,
  ]);
  if (pressure.length) sections.push(`［人物与现场压力］\n${bullets(pressure)}`);

  const visibleChange = compactLines([
    input.scene.turn,
    input.scene.outcome,
    ...input.writePack.mustLand,
  ]);
  if (visibleChange.length) {
    sections.push(`［本场可见变化］\n${bullets(visibleChange)}\n这些变化须由行动、反应、证据或后果让读者看见；不要为了交代而让人物直接宣读。`);
  }

  const silentFacts = compactLines(input.writePack.knownFacts);
  if (silentFacts.length) {
    sections.push(`［背景事实·只作约束］\n${bullets(silentFacts)}\n除非人物在现场有说或想的理由，否则不必写进正文。`);
  }

  const actionPossibilities = compactLines(input.writePack.beatOrder).slice(0, 6);
  if (actionPossibilities.length) {
    sections.push(`［可用行动线索］\n${bullets(actionPossibilities)}\n只作为可能性，不必逐项执行或保持清单顺序。`);
  }

  const forbidden = compactLines(input.writePack.doNotInvent);
  if (forbidden.length) sections.push(`［不可擅自确定］\n${bullets(forbidden)}`);

  const target = input.scene.targetCharacters;
  sections.push(target
    ? `目标篇幅 ${Math.ceil(target * 0.85)}—${Math.floor(target * 1.2)} 字，最多 ${Math.floor(target * 1.5)} 字；场景变化完成后自然结束，不用解释、原理展开或回顾来凑字数。`
    : "场景变化完成后自然结束，不用解释或回顾来凑篇幅。");
  if (input.strictMaximumCharacters) {
    sections.push(`上一次生成超长。本次正文不得超过 ${input.strictMaximumCharacters} 字；压缩原理说明、重复读数和不改变选择的过程，不得截断结尾。`);
  }

  return [
    { role: "system", content: ISOLATED_WRITER_SYSTEM },
    { role: "user", content: sections.join("\n\n") },
  ];
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
    temperature: model.temperature ?? 0.85,
    ...(model.topP === undefined ? {} : { top_p: model.topP }),
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

export function isolatedSceneWriterMaxTokens(input: IsolatedSceneWriterInput): number {
  const outputCharacters = input.strictMaximumCharacters
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
    temperature: 0,
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

function bullets(values: string[]): string {
  return values.map(value => `- ${value}`).join("\n");
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
