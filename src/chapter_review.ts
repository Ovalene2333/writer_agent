import { logModelRequest, logModelResponse } from "./model_debug.js";
import { samplingRequestOptions, thinkingRequestOptions } from "./model_compat.js";
import { buildProviderCompletionBody, completeProviderCompletion, contentFromProviderResponseBody, modelCompletionEndpoint, parseProviderCompletionPayload, serializeProviderChatBody } from "./model_api.js";
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
    | "fact_conflict" | "knowledge_leak" | "unsupported_fact" | "identity_relationship"
    | "telemetry_pileup" | "expository_mechanics" | "semantic_echo" | "generic_prose"
    | "voice_homogenization" | "theme_stated" | "resolution_too_smooth" | "dialogue_frictionless"
    | "drive_flat" | "stakes_absent";
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

const REVIEW_SYSTEM = `你是中文小说整章终审员。先查会让章节失效的事实与因果问题，再给结构和表达建议。不要把个人审美、统计信号或类型惯例升级成硬性公式。

先建立“谁在何时知道什么”的信息账本，再逐句检查对白、内心、叙述判断和行动依据：
- 客观事实不自动等于角色知识。角色只有在亲历/目击、被可信来源告知、从正文可见证据合理推断，或该事实已明确属于公共知识时，才能说出、想到或据此行动；
- 合理推断必须在本章或证据包中找到可感知线索。不得把作者、叙述者、其他视角人物或后续章节掌握的信息偷渡给当前角色；
- rumor 与 beliefs 只能按传闻、怀疑或信念呈现，不能无新证据升级成已确认事实；conflict/pending 事实不能擅自选边；
- 核对时间先后、地点与移动、伤势与体力、物品持有/损毁、身份、关系、经历、能力及 unlocked 状态、组织规则和世界机制；
- 新增的无害且兼容的小细节不必判错；但没有来源、且被用于解题、定罪、转折或重大决定的关键事实，判 unsupported_fact blocker；
- 对每个事实问题说明冲突基准或缺失的获知路径。若文本给出了足够的观察和推理链，不得因为证据包未逐字登记而误判。

问题类型：fact_conflict=与已确立事实直接冲突；knowledge_leak=角色使用了自己不应知道的信息；unsupported_fact=关键事实无来源却承担因果功能；identity_relationship=身份、关系、称谓或立场不一致。

随后按本章目标检查结构与表达：
- 场景接续是否存在因果断裂、状态矛盾或换地点重复同一功能；章首到章尾是否形成与 chapterGoal 相符的变化。静场、铺垫章、过渡章和收束章可以只改变认知、关系或选择，不必强造对抗、悬念和损失；
- telemetry_pileup：读数或术语连续出现，却不影响人物判断与行动；expository_mechanics：已经成立的动作又被教程式解释挤占；semantic_echo：相邻句段重复同一信息；generic_prose：关键场面长期只有泛化判断，缺少可辨认的现场依据；
- voice_homogenization：主要人物的措辞、信息取舍和说话目的长期无法区分。不要以口头禅、固定句长或强行回避作为角色声线模板；
- theme_stated：本应由行动和后果成立的意义，被成段总结替代；resolution_too_smooth：人物立场或阻力无新依据地改变，抹掉了正文已经建立的矛盾；
- dialogue_frictionless：仅当本章需要谈判、冲突、试探或隐瞒时，检查对白是否回避了应有的利益差异。直接回答、解释、配合、沉默和日常交流本身都有效，不因缺少“交锋动作”判错；
- drive_flat / stakes_absent：结合 chapterGoal 判断本章是否承诺了未定结果或显著代价。若目标本来是休整、交代、确认或收束，不得要求每场都有主动阻力、不可逆代价或新钩子。

分级原则：事实冲突、知识泄漏、关键因果无来源、状态断裂，以及足以使本章目标无法成立的结构问题可以判 blocker。风格、声线、主题直陈、平顺对白、节奏与驱动力问题默认 warning；只有它们贯穿关键场面、明显妨碍理解或违背项目明确风格约定时才可判 blocker。任何统计字段只用于定位候选段落，不能单独成为证据，也不能用阈值替代语义判断。

单个准确数字、必要技术语言、短句、抽象句和直接对白均可保留。句式符号由独立门禁处理，本终审不做全文润色。evidence 必须逐字引用能证明问题的最短连续原文；没有充分证据就不报。只输出一个 JSON 对象，不要 Markdown、分析过程或改写后的正文。
字段：verdict(pass|revise)；chapterChange；reviewNotes；issues(最多8项，每项 severity=blocker|warning、kind=seam|duplicate_function|turn_repetition|state_continuity|motif_reuse|chapter_arc|fact_conflict|knowledge_leak|unsupported_fact|identity_relationship|telemetry_pileup|expository_mechanics|semantic_echo|generic_prose|voice_homogenization|theme_stated|resolution_too_smooth|dialogue_frictionless|drive_flat|stakes_absent、sceneId、evidence最多3条、problem、action)。revise 必须至少有一项带 sceneId 和逐字证据的 blocker。事实类 blocker 的 problem 必须指出冲突的事实基准，或明确缺少哪条获知路径；不得只写“可能不合理”。`;

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

/** Strip whitespace / quote variants so model evidence can still match source text. */
function normalizeEvidenceNeedle(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[“”「」『』]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .replace(/[—–]/g, "-");
}

function evidenceInSource(sourceText: string | undefined, quote: string): boolean {
  if (!sourceText) return true;
  if (sourceText.includes(quote)) return true;
  const needle = normalizeEvidenceNeedle(quote);
  return needle.length > 0 && normalizeEvidenceNeedle(sourceText).includes(needle);
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
    "fact_conflict", "knowledge_leak", "unsupported_fact", "identity_relationship",
    "telemetry_pileup", "expository_mechanics", "semantic_echo", "generic_prose",
    "voice_homogenization", "theme_stated", "resolution_too_smooth", "dialogue_frictionless",
    "drive_flat", "stakes_absent",
  ]);
  // Direct-document reviews only allow sceneId "document". Models often omit it or invent
  // ids; with a single legal target, attach that id so a valid revise is not discarded.
  const soleSceneId = allowedSceneIds.size === 1 ? [...allowedSceneIds][0] : undefined;
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
    let sceneId = typeof issue.sceneId === "string" && allowedSceneIds.has(issue.sceneId)
      ? issue.sceneId
      : undefined;
    if (!sceneId && soleSceneId) sceneId = soleSceneId;
    const evidence = Array.isArray(issue.evidence)
      ? issue.evidence.map(item => boundedString(item, 180))
        .filter(item => Boolean(item) && evidenceInSource(sourceText, item))
        .slice(0, 3)
      : [];
    issues.push({ severity, kind, ...(sceneId ? { sceneId } : {}), evidence, problem, action });
  }
  // Incomplete blockers must not invalidate sibling locatable blockers (old `.some` did that).
  const locatableBlockers = issues.filter(
    issue => issue.severity === "blocker" && issue.sceneId && issue.evidence.length > 0,
  );
  const normalizedIssues = issues.map(issue => {
    if (issue.severity === "blocker" && (!issue.sceneId || !issue.evidence.length)) {
      return { ...issue, severity: "warning" as const };
    }
    return issue;
  });
  if (verdict === "revise" && locatableBlockers.length === 0) {
    // Model claimed revise but substantiated nothing. Direct-doc (single scene) demotes to
    // pass so we do not mis-report "终审服务不可用" and empty-retry the same draft. Multi-scene
    // structural review still requires a locatable target scene.
    if (soleSceneId) {
      return { verdict: "pass", chapterChange, reviewNotes, issues: normalizedIssues };
    }
    throw new Error("整章终审要求 revise，但没有提供可定位的 blocker 证据");
  }
  return { verdict, chapterChange, reviewNotes, issues: normalizedIssues };
}

export async function reviewChapterDraft(
  model: ModelConfig,
  input: ChapterReviewInput,
  signal?: AbortSignal,
): Promise<{ review: ChapterReviewResult; usage?: ModelTokenUsage }> {
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未配置整章终审模型 API Key");
  }
  const { endpoint, body } = serializeProviderChatBody(model, {
    model: model.model,
    messages: buildChapterReviewMessages(input),
    stream: false,
    ...samplingRequestOptions(model, { temperature: 0 }),
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
  const content = parseProviderCompletionPayload(payload).content;
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
