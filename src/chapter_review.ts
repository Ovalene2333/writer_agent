import { logModelRequest, logModelResponse } from "./model_debug.js";
import { thinkingRequestOptions } from "./model_compat.js";
import { modelFetch } from "./model_fetch.js";
import { parseModelTokenUsage } from "./model_usage.js";
import type { ModelConfig, ModelTokenUsage } from "./types.js";

export type ChapterReviewScene = {
  sceneId: string;
  title: string;
  plannedTurn: string;
  plannedOutcome: string;
  actualState: unknown;
};

export type ChapterReviewIssue = {
  severity: "blocker" | "warning";
  kind: "seam" | "duplicate_function" | "turn_repetition" | "state_continuity" | "motif_reuse" | "chapter_arc"
    | "telemetry_pileup" | "expository_mechanics" | "semantic_echo";
  sceneId?: string;
  evidence: string[];
  problem: string;
  action: string;
};

export type ChapterReviewResult = {
  verdict: "pass" | "revise";
  chapterChange: string;
  reviewNotes: string;
  issues: ChapterReviewIssue[];
};

export type ChapterReviewInput = {
  chapterGoal: string;
  content: string;
  scenes: ChapterReviewScene[];
  context?: string;
  proseSignals?: unknown;
};

export class ChapterReviewRequestError extends Error {
  constructor(message: string, readonly usage?: ModelTokenUsage, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChapterReviewRequestError";
  }
}

const REVIEW_SYSTEM = `你是中文小说整章终审员。完整阅读全文后，检查跨场景结构与会破坏现场感的语义堆砌：
- 相邻场景是否由前场后果推动，接缝是否断裂或状态矛盾；
- 各场目标、阻力、转折和结果是否承担不同功能，是否只是换地点重复同一过程；
- 人物关系、信息、目标或处境是否逐场发生可辨认变化；
- 是否重复使用同类转折、意象、参数展示、沉默或总结式章尾；
- 全文开头到结尾是否形成清楚且有证据的总变化；
- telemetry_pileup：同一现场连续播报角度、频率、温度、百分比、状态值，读数没有改变人物下一步选择；
- expository_mechanics：动作已经成立后，叙述又展开原理、计算或教程式过程，挤压人物反应与环境后果；
- semantic_echo：相邻句段换一种说法重复同一动作、判断或结论，没有新增事实。
单个准确数字、确实触发选择的测量、角色偶尔使用技术语言均可保留，不得仅因出现术语或数字判错。只有同类堆砌在一个场景内反复出现并明显遮蔽行动、关系或留白时，才把对应场景判 blocker；轻微问题列 warning。句式符号已由独立门禁处理，不做全文润色。evidence 必须逐字引用短句。只输出一个 JSON 对象，不要 Markdown、分析过程或改写后的正文。
字段：verdict(pass|revise)；chapterChange；reviewNotes；issues(最多8项，每项 severity=blocker|warning、kind=seam|duplicate_function|turn_repetition|state_continuity|motif_reuse|chapter_arc|telemetry_pileup|expository_mechanics|semantic_echo、sceneId、evidence最多3条、problem、action)。revise 必须至少有一项带 sceneId 和逐字证据的 blocker。`;

export function buildChapterReviewMessages(input: ChapterReviewInput): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: REVIEW_SYSTEM },
    {
      role: "system",
      // Keep reusable project context ahead of chapter-specific fields so repeated
      // inspections and later chapters can reuse a longer provider cache prefix.
      content: input.context?.trim() || "无额外项目终审上下文。",
    },
    {
      role: "user",
      content: JSON.stringify({
        chapterGoal: input.chapterGoal,
        scenes: input.scenes,
        fullChapter: input.content,
        ...(input.proseSignals ? { proseSignals: input.proseSignals } : {}),
      }),
    },
  ];
}

export function parseChapterReview(
  raw: string,
  allowedSceneIds: ReadonlySet<string>,
  sourceText?: string,
): ChapterReviewResult {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("整章终审没有返回 JSON 对象");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("整章终审返回的 JSON 无法解析");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("整章终审结果格式无效");
  const value = parsed as Record<string, unknown>;
  const verdict = value.verdict === "pass" ? "pass" : value.verdict === "revise" ? "revise" : undefined;
  if (!verdict) throw new Error("整章终审缺少有效 verdict");
  const chapterChange = boundedString(value.chapterChange, 240);
  const reviewNotes = boundedString(value.reviewNotes, 1_000);
  if (!chapterChange || !reviewNotes) throw new Error("整章终审缺少 chapterChange 或 reviewNotes");

  const kinds = new Set<ChapterReviewIssue["kind"]>([
    "seam", "duplicate_function", "turn_repetition", "state_continuity", "motif_reuse", "chapter_arc",
    "telemetry_pileup", "expository_mechanics", "semantic_echo",
  ]);
  const rows = Array.isArray(value.issues) ? value.issues.slice(0, 8) : [];
  const issues: ChapterReviewIssue[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const issue = row as Record<string, unknown>;
    const severity = issue.severity === "blocker" ? "blocker" : issue.severity === "warning" ? "warning" : undefined;
    const kind = typeof issue.kind === "string" && kinds.has(issue.kind as ChapterReviewIssue["kind"])
      ? issue.kind as ChapterReviewIssue["kind"]
      : undefined;
    const problem = boundedString(issue.problem, 240);
    const action = boundedString(issue.action, 240);
    if (!severity || !kind || !problem || !action) continue;
    const sceneId = typeof issue.sceneId === "string" && allowedSceneIds.has(issue.sceneId)
      ? issue.sceneId
      : undefined;
    const evidence = Array.isArray(issue.evidence)
      ? issue.evidence.map(item => boundedString(item, 180))
        .filter(item => Boolean(item) && (!sourceText || sourceText.includes(item)))
        .slice(0, 3)
      : [];
    issues.push({ severity, kind, ...(sceneId ? { sceneId } : {}), evidence, problem, action });
  }
  const blockers = issues.filter(issue => issue.severity === "blocker");
  if (verdict === "revise" && (!blockers.length || blockers.some(issue => !issue.sceneId || !issue.evidence.length))) {
    throw new Error("整章终审要求 revise，但没有提供可定位的 blocker 证据");
  }
  return { verdict, chapterChange, reviewNotes, issues };
}

export async function reviewChapterDraft(
  model: ModelConfig,
  input: ChapterReviewInput,
  signal?: AbortSignal,
): Promise<{ review: ChapterReviewResult; usage?: ModelTokenUsage }> {
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未配置整章终审模型 API Key");
  }
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model: model.model,
    messages: buildChapterReviewMessages(input),
    stream: false,
    temperature: 0,
    response_format: { type: "json_object" },
    ...thinkingRequestOptions(model),
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
  let payload: {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: unknown;
  };
  try {
    payload = JSON.parse(responseBody) as typeof payload;
  } catch (error) {
    throw new ChapterReviewRequestError(
      `整章终审返回的响应不是 JSON（${response.status}）`,
      undefined,
      { cause: error },
    );
  }
  const usage = parseModelTokenUsage(payload.usage);
  if (!response.ok) {
    throw new ChapterReviewRequestError(
      `整章终审请求失败（${response.status}）：${responseBody.slice(0, 240)}`,
      usage,
    );
  }
  const content = payload.choices?.[0]?.message?.content ?? "";
  let review: ChapterReviewResult;
  try {
    review = parseChapterReview(content, new Set(input.scenes.map(scene => scene.sceneId)), input.content);
  } catch (error) {
    throw new ChapterReviewRequestError(
      error instanceof Error ? error.message : String(error),
      usage,
      { cause: error },
    );
  }
  return { review, ...(usage ? { usage } : {}) };
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
