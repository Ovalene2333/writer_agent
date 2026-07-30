import { logModelRequest, logModelResponse } from "./model_debug.js";
import { samplingRequestOptions, thinkingRequestOptions } from "./model_compat.js";
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

const REVIEW_SYSTEM = `你是中文小说整章终审员。事实正确性与人物认知边界是最高优先级；其次检查跨场景结构与会破坏现场感的语义堆砌。

先建立“谁在何时知道什么”的信息账本，再逐句检查对白、内心、叙述判断和行动依据：
- 客观事实不自动等于角色知识。角色只有在亲历/目击、被可信来源告知、从正文可见证据合理推断，或该事实已明确属于公共知识时，才能说出、想到或据此行动；
- 合理推断必须在本章或证据包中找到可感知线索。不得把作者、叙述者、其他视角人物或后续章节掌握的信息偷渡给当前角色；
- rumor 与 beliefs 只能按传闻、怀疑或信念呈现，不能无新证据升级成已确认事实；conflict/pending 事实不能擅自选边；
- 核对时间先后、地点与移动、伤势与体力、物品持有/损毁、身份、关系、经历、能力及 unlocked 状态、组织规则和世界机制；
- 新增的无害且兼容的小细节不必判错；但没有来源、且被用于解题、定罪、转折或重大决定的关键事实，判 unsupported_fact blocker；
- 对每个事实问题说明冲突基准或缺失的获知路径。若文本给出了足够的观察和推理链，不得因为证据包未逐字登记而误判。

问题类型：fact_conflict=与已确立事实直接冲突；knowledge_leak=角色使用了自己不应知道的信息；unsupported_fact=关键事实无来源却承担因果功能；identity_relationship=身份、关系、称谓或立场不一致。

随后检查：
- 相邻场景是否由前场后果推动，接缝是否断裂或状态矛盾；
- 各场目标、阻力、转折和结果是否承担不同功能，是否只是换地点重复同一过程；
- 人物关系、信息、目标或处境是否逐场发生可辨认变化；
- 张力是否围绕人物在乎且结果未定的事情累积，每轮应对是否收紧选择、提高代价或触发有效反制，而非只罗列事件；
- 是否重复使用同类转折、意象、参数展示、沉默或总结式章尾；
- 章首是否尽快立住承接压力与当前问题，章尾是否给出阶段性结果及其后果，而非在本章结果发生前突然截断；
- 全文开头到结尾是否形成清楚且有证据的总变化，并留下由结果自然产生的新约束、代价或选择；
- telemetry_pileup：同一现场连续播报角度、频率、温度、百分比、状态值，读数没有改变人物下一步选择；
- expository_mechanics：动作已经成立后，叙述又展开原理、计算或教程式过程，挤压人物反应与环境后果；
- semantic_echo：相邻句段换一种说法重复同一动作、判断或结论，没有新增事实。
- generic_prose：句子换掉人名、地点后仍能原样放进多数别的故事——用「气氛/仿佛/某种/一切」这类泛化标签代替此时此地才成立的物件、动作或后果；现场只被叙述者报告，没有被人物看见、听见、摸到。这是唯一一类"写得没错但没有画面"的问题，其余检查都发现不了它，请主动找。

接着检查三类"生成腔"。它们不违反任何事实、结构或句式规则，前面的检查全都发现不了，必须单独找：
- voice_homogenization：把说话人的名字和提示语遮住后，台词还能在人物之间互换——所有人用同样的句长、同样的书面程度、同样的方式起头和收束，没有各自的回避方式、口头禅或说话目的。只要有两个人物在同一场里说话且无法区分，就至少记 warning。
- theme_stated：叙述者或人物把本章的主题、教训或人物成长直接说出口，替读者完成判断。章尾与场尾尤其要查：「他终于明白……」「从此以后……」「一切都不一样了」「这一刻他懂得了……」，以及人物在对白里总结自己的转变。让意义由后果承担，而不是由句子宣告。
- resolution_too_smooth：冲突靠互相理解或坦白化解，代价被抹平；阻力恰好在需要时让路；反对者在没有新证据或新压力的情况下改变立场；每个细节都恰好服务主线，没有任何东西是白费的。判定看的是"有没有人付出了不可撤销的代价"，不是"结局是否圆满"——刻意的圆满结局本身不判错。

以上三类的判定尺度与前面一致：零星命中列 warning；只有当整章都成立（例如章尾整段都在宣告主题、核心冲突完全无代价地消解）才判 blocker。voice_homogenization 的 blocker 门槛比其余两类低一档：不必"全章无一处可区分"，只要本章戏份最重的两人、或三个以上有名有姓的人物通篇共用同一套句长与句式，就判 blocker——个别台词碰巧可区分不足以豁免。proseSignals.aiTells 是规则层测得的参考数字（AI 味分越高越可疑），只用来提示往哪里看，不能作为判据；判 blocker 仍须逐字引用正文证据。

与 voice_homogenization 相邻但不同的一类是 dialogue_frictionless：对白全程没有摩擦——每个问题都在下一句被正面回答，没有人回避、误解、拖延、说到一半停住，也没有人说一段对方没问的话；台词只负责传递信息，不负责争夺、试探、掩饰或伤人。两者的区别：那一类查"谁在说分不出来"，这一类查"说了等于没交锋"；可以同时成立，也可以各自单独成立。尺度：局部平顺列 warning；只有整章对白无一处摩擦才判 blocker，并逐字引用连续两三轮直给的问答作为证据。proseSignals.dialogue 是形式统计参考：medianLength/shortRatio/longRatio=对白长度分布（通篇 ≤6 字通常意味着只剩确认与应答）、lengthSpread=句长起伏、speakers[]=按「X说」提示语归属到的说话人及各自的长度与分句统计、voiceDistance=说话人之间的形式差异度（越低越像同一只手写的）、言语动作=应答／承诺／命令／提问／拒绝／陈述的分布（应答＋承诺合计偏高意味着人物大多在接受和表态，很少在争取；陈述是兜底类，占比高不说明问题）、复现句式=同一个并列句式在全章反复出现的次数（往往是作者的手癖，与谁在说无关）。归属靠姓名加提示语动词解析，会漏掉代词与无提示语的台词，attributedLines 偏低不代表对白少。这些数字只提示往哪看，不能作为判据。对白本就该比叙述短，短本身不是问题；问题是全章只有短。

最后检查两类"没有驱动力"。它们不违反事实、结构、句式或生成腔中的任何一条，前面全部检查都会放行，必须单独找；本项是判断"读者是否愿意继续读"的唯一环节：
- drive_flat：整章没有人在争取一件他在乎、而且可能失败的事。典型形态是每场都只是"去了—问了—得知—推进"：人物始终握有主动，阻力只被动存在而从不出手，场与场之间只增加信息量。判定不看事件多少，看每一场结束时有没有一件悬而未决且读者在意的事，以及下一场是否因此更值得读。
- stakes_absent：变化确实发生了，但没有人为此付出不可撤销的代价——损失都能补回，选择都留着退路，判断错误不产生后果。与 resolution_too_smooth 的区别：那一类查"代价被抹平"，这一类查"代价从头到尾就不存在"。
这两类的尺度：单场平淡但整章仍有累积，列 warning；只有整章都成立（全章无人可能失败，或全章无任何不可撤销代价）才判 blocker，并必须逐字引用体现该状态的正文——阻力恰好让路、损失被补回、章尾回到出发点之类的句子。proseSignals.drive 是结构层参考数字：knowledgeOnlyStreak=连续多少场只改变了信息、scenesWithoutCost=场景卡未登记代价的场、passiveOppositionScenes=阻力方未主动出手的场、openLoopsNeverDischarged=悬念只增不减。只用来提示往哪看；数字高不等于有问题，数字低也不排除问题。不得把作者刻意的静场、铺垫章或收束章仅因平缓就判 blocker；判据是有无人在乎的未定结果，不是节奏快慢。

单个准确数字、确实触发选择的测量、角色偶尔使用技术语言均可保留，不得仅因出现术语或数字判错。只有同类堆砌在一个场景内反复出现并明显遮蔽行动、关系或留白时，才把对应场景判 blocker；轻微问题列 warning。generic_prose 仅在整场都停留在泛化叙述、读者无法看见任何具体现场时才判 blocker；零星抽象句列 warning。句式符号已由独立门禁处理，不做全文润色。evidence 必须逐字引用短句。只输出一个 JSON 对象，不要 Markdown、分析过程或改写后的正文。
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
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
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
