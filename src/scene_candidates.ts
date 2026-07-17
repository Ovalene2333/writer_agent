import { logModelRequest, logModelResponse } from "./model_debug.js";
import { modelFetch } from "./model_fetch.js";
import { sceneProseScore } from "./prose_metrics.js";
import type { ModelConfig } from "./types.js";

/**
 * Experimental best-of-N scene prose sampling (Re3-style rerank, prompt-level).
 *
 * When ScenePipelineSettings.candidateCount > 1, write_chapter_scene treats the
 * agent-submitted prose as candidate 0, asks the model for fact-preserving
 * rewrites via a dedicated PLAIN-TEXT call (continuation-anchored, no JSON
 * escaping, its own sampling), and keeps the highest-scoring survivor. Rewrites
 * must pass the same gates as the original; on any model failure the original
 * ships unchanged, so the feature can never block a scene.
 */

const REWRITE_TIMEOUT_MS = 120_000;

/**
 * Skip best-of-N sampling when the submitted scene already scores clean
 * (sceneProseScore ≈100 for clean prose). A rewrite must strictly beat the
 * original to win, and above this bar wins are noise — every skip saves
 * (candidateCount−1) full-scene generations.
 */
export const SCENE_CANDIDATE_SKIP_SCORE = 99;

export type SceneRewriteRequest = {
  model: ModelConfig;
  signal?: AbortSignal;
  /** Voice evidence blocks (exemplars + continuation anchors), already formatted. */
  styleEvidence: string;
  sceneBrief: string;
  original: string;
  timeoutMs?: number;
};

/** Deterministic rerank: original first; a rewrite must strictly beat it to win. */
export function pickBestSceneCandidate(candidates: string[]): { index: number; scores: number[] } {
  const scores = candidates.map(candidate => sceneProseScore(candidate));
  let index = 0;
  for (let i = 1; i < scores.length; i += 1) {
    if (scores[i] > scores[index]) index = i;
  }
  return { index, scores };
}

/** Length guard: a rewrite that balloons or collapses is not a comparable candidate. */
export function sceneRewriteLengthOk(original: string, rewrite: string): boolean {
  const base = original.replace(/\s/g, "").length;
  const next = rewrite.replace(/\s/g, "").length;
  if (base === 0) return false;
  return next >= base * 0.7 && next <= base * 1.3;
}

export function buildSceneRewriteMessages(request: Pick<SceneRewriteRequest, "styleEvidence" | "sceneBrief" | "original">): Array<{ role: "system" | "user"; content: string }> {
  const system = `你是中文小说家，正在重写自己刚写完的一场戏，让文字更有质感。

${request.styleEvidence}

重写要求：
- 完整保留原稿的每一个事件、信息揭示、动作次序、离场状态与对白意图；对白措辞可微调，含义与说话人不变。
- 篇幅与原稿相当。
- 长短句交替，段落有呼吸；静场与情感段落给出绵延的长句；补充说明并入叙述或写成独立句。
- 感官与数据转译为人物可感的后果或准确的比喻。
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
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model: model.model,
    messages: buildSceneRewriteMessages(request),
    stream: false,
    // Prose-only call: warmer sampling + mild de-echo are safe here (no tool JSON).
    temperature: Math.min(1.2, (model.temperature ?? 0.9) + 0.1),
    ...(model.topP === undefined ? {} : { top_p: model.topP }),
    frequency_penalty: 0.2,
    presence_penalty: 0.2,
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
  }, model.proxyUrl);
  const responseBody = await response.text();
  logModelResponse(endpoint, responseBody);
  if (!response.ok) throw new Error(`场景重写请求失败（${response.status}）：${responseBody.slice(0, 240)}`);
  const payload = JSON.parse(responseBody) as { choices?: Array<{ message?: { content?: string | null } }> };
  const content = (payload.choices?.[0]?.message?.content ?? "").trim()
    .replace(/^```(?:markdown)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!content) throw new Error("场景重写无内容");
  return content;
}
