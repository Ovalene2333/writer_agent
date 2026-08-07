import { logModelRequest, logModelResponse } from "./model_debug.js";
import { modelFetch, modelRequestOptions } from "./model_fetch.js";
import { samplingRequestOptions } from "./model_compat.js";
import { buildProviderCompletionBody, contentFromProviderResponseBody, modelCompletionEndpoint, parseProviderCompletionPayload, serializeProviderChatBody } from "./model_api.js";
import type { ModelConfig } from "./types.js";
import { parseModelTokenUsage, type ModelUsageReporter } from "./model_usage.js";

/**
 * Best-of-N scene prose sampling (Re3-style rerank, prompt-level).
 *
 * When ScenePipelineSettings.candidateCount > 1, write_chapter_scene treats the
 * agent-submitted prose as candidate 0, asks the model for fact-preserving
 * rewrites via a dedicated PLAIN-TEXT call (continuation-anchored, no JSON
 * escaping, its own sampling), and keeps the best survivor. Rewrites must pass
 * the same gates as the original; on any model failure the original ships
 * unchanged, so the feature can never block a scene.
 *
 * A reader model chooses the winner by reading — which draft makes a reader want
 * the next page — because the thing best-of-N is meant to buy is exactly the
 * thing no rule can score. Without a reader judgment, the original ships.
 */

const REWRITE_TIMEOUT_MS = 120_000;
const JUDGE_TIMEOUT_MS = 90_000;

export type SceneRewriteRequest = {
  model: ModelConfig;
  signal?: AbortSignal;
  /** Voice evidence blocks (exemplars + continuation anchors), already formatted. */
  styleEvidence: string;
  sceneBrief: string;
  original: string;
  timeoutMs?: number;
  usageReporter?: ModelUsageReporter;
};

export type SceneJudgeRequest = {
  model: ModelConfig;
  signal?: AbortSignal;
  sceneBrief: string;
  /** Candidate 0 is always the original submission. */
  candidates: string[];
  timeoutMs?: number;
  usageReporter?: ModelUsageReporter;
};

export type SceneJudgeResult = { index: number; reason: string };

const JUDGE_SYSTEM = `你是挑剔的中文小说读者，正在比较同一场戏的几个写法。每一稿的事件、信息和结局都相同，你不评判情节对错，只回答哪一稿更值得读下去。

按重要性依次考虑：
- 读完这一场后想不想翻下一页；哪一稿的悬置、余波或代价更让人挂心。
- 人物是否像有自己的目的：他在争取、隐瞒、拖延或让步，而不是配合叙述者完成流程。
- 细节是否此时此地才成立：换掉人名地点后仍能套进多数故事的句子越少越好。
- 情绪是否落在动作、时机和没有说出口的话里，而不是被叙述者命名和解释。
- 节奏是否有起伏，关键处是否慢得下来。

字数更多、辞藻更密、比喻更多都不是优点。若几稿实际难分高下，选 0（原稿）。
只输出一个 JSON 对象：{"choice": 序号, "reason": "不超过60字，指出决定性差别"}。不要 Markdown、不要复述正文。`;

export function buildSceneJudgeMessages(
  request: Pick<SceneJudgeRequest, "sceneBrief" | "candidates">,
): Array<{ role: "system" | "user"; content: string }> {
  const body = request.candidates
    .map((candidate, index) => `［候选 ${index}${index === 0 ? "·原稿" : ""}］\n${candidate}`)
    .join("\n\n———\n\n");
  return [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: `本场要点：${request.sceneBrief}\n\n${body}` },
  ];
}

export function parseSceneJudgeResult(raw: string, candidateCount: number): SceneJudgeResult {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("候选评选没有返回 JSON 对象");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("候选评选结果格式无效");
  const value = parsed as Record<string, unknown>;
  const index = Number(value.choice);
  if (!Number.isInteger(index) || index < 0 || index >= candidateCount) {
    throw new Error(`候选评选返回了无效序号：${String(value.choice)}`);
  }
  return { index, reason: typeof value.reason === "string" ? value.reason.trim().slice(0, 120) : "" };
}

/**
 * One JSON judging call. Throws on any failure; callers fall back to the
 * deterministic rerank so a judge outage can never change what ships.
 */
export async function judgeSceneCandidates(request: SceneJudgeRequest): Promise<SceneJudgeResult> {
  const { model } = request;
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未配置 API Key");
  }
  const { endpoint, body } = serializeProviderChatBody(model, {
    model: model.model,
    messages: buildSceneJudgeMessages(request),
    stream: false,
    ...samplingRequestOptions(model, { temperature: 0 }),
    response_format: { type: "json_object" },
  });
  logModelRequest(endpoint, body);
  const timeout = AbortSignal.timeout(request.timeoutMs ?? JUDGE_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const response = await modelFetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body,
  }, modelRequestOptions(model));
  const responseBody = await response.text();
  logModelResponse(endpoint, responseBody);
  if (!response.ok) throw new Error(`候选评选请求失败（${response.status}）：${responseBody.slice(0, 240)}`);
  const payload = JSON.parse(responseBody) as { choices?: Array<{ message?: { content?: string | null } }>; usage?: unknown };
  const usage = parseModelTokenUsage(payload.usage);
  if (usage) request.usageReporter?.(model, usage, { callKind: "scene_candidate_judge" });
  return parseSceneJudgeResult(parseProviderCompletionPayload(payload).content, request.candidates.length);
}

/** Length guard: a rewrite that balloons or collapses is not a comparable candidate. */
export function sceneRewriteLengthOk(original: string, rewrite: string): boolean {
  const base = original.replace(/\s/g, "").length;
  const next = rewrite.replace(/\s/g, "").length;
  if (base === 0) return false;
  return next >= base * 0.7 && next <= base * 1.3;
}

export function buildSceneRewriteMessages(request: Pick<SceneRewriteRequest, "styleEvidence" | "sceneBrief" | "original">): Array<{ role: "system" | "user"; content: string }> {
const system = `你是中文小说家，正在判断自己刚写完的一场戏是否需要更自然、更有阅读牵引力的表达。如果原稿已经成立，保留它的好句和节奏；只有确有僵硬、字段化或失去现场感的地方才重写。

${request.styleEvidence}

重写边界：
- 完整保留原稿的每一个事件、信息揭示、动作次序、离场状态与对白意图；对白措辞可微调，含义与说话人不变。
- 篇幅与原稿相当。
- 句子和段落跟随人物注意、行动压力与信息落点自然变化，不追求长短句比例、感官数量、物件数量或对白占比。
- 只有能改变人物感知、选择或局面的细节才补入；不要为了“更有画面”制造感官、比喻、道具或口语词。
- 对白保留人物各自的目的、知识和回避；情绪优先落在动作、时机与没说出口的话里，不替读者总结。
- 句式边界只处理成片复现、重复解释和关系含混；孤立且符合人物、现场或文体的表达保留。
- 只输出重写后的正文：不要标题、说明、围栏或任何正文以外的字。`;
  const user = `本场要点：${request.sceneBrief}

原稿：
${request.original}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** One plain-text rewrite call. Throws on failure; callers treat failures as "skip candidate". */
export async function rewriteSceneCandidate(request: SceneRewriteRequest): Promise<string> {
  const { model } = request;
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未配置 API Key");
  }
  const { endpoint, body } = serializeProviderChatBody(model, {
    model: model.model,
    messages: buildSceneRewriteMessages(request),
    stream: false,
    // Prose-only call: warmer sampling + mild de-echo are safe here (no tool JSON).
    ...samplingRequestOptions(model, {
      temperature: Math.min(1.2, (model.temperature ?? 0.9) + 0.1),
      frequencyPenalty: 0.2,
      presencePenalty: 0.2,
    }),
  });
  logModelRequest(endpoint, body);
  const timeout = AbortSignal.timeout(request.timeoutMs ?? REWRITE_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const response = await modelFetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body,
  }, modelRequestOptions(model));
  const responseBody = await response.text();
  logModelResponse(endpoint, responseBody);
  if (!response.ok) throw new Error(`场景重写请求失败（${response.status}）：${responseBody.slice(0, 240)}`);
  const payload = JSON.parse(responseBody) as { choices?: Array<{ message?: { content?: string | null } }>; usage?: unknown };
  const usage = parseModelTokenUsage(payload.usage);
  if (usage) request.usageReporter?.(model, usage, { callKind: "scene_candidate_rewrite" });
  const content = (parseProviderCompletionPayload(payload).content).trim()
    .replace(/^```(?:markdown)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!content) throw new Error("场景重写无内容");
  return content;
}
