import { logModelRequest, logModelResponse } from "./model_debug.js";
import { samplingRequestOptions, thinkingRequestOptions } from "./model_compat.js";
import { buildProviderCompletionBody, completeProviderCompletion, contentFromProviderResponseBody, modelCompletionEndpoint, parseProviderCompletionPayload, serializeProviderChatBody } from "./model_api.js";
import { modelFetch } from "./model_fetch.js";
import { parseModelTokenUsage } from "./model_usage.js";
import { documentSpans, type DocumentSpan } from "./document_spans.js";
import {
  proposalRevisionIssueId,
  type ProposalRevisionIssue,
} from "./proposal_retry.js";
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
    | "fact_conflict" | "knowledge_leak" | "unsupported_fact" | "identity_relationship" | "capability_scope"
    | "telemetry_pileup" | "register_leak" | "compressed_prose" | "expository_mechanics" | "semantic_echo" | "generic_prose"
    | "voice_homogenization" | "dialogue_format" | "dialogue_telegraphic"
    | "theme_stated" | "resolution_too_smooth" | "dialogue_frictionless"
    | "drive_flat" | "stakes_absent";
  sceneId?: string;
  evidence: string[];
  /** Exact unique source text an Agent may replace without another broad read. */
  oldText?: string;
  /** Revision-only evidence quoted from the changed before/after text. */
  changeEvidence?: string[];
  problem: string;
  action: string;
  priorIssueId?: string;
  origin?: "unresolved_prior" | "introduced_by_revision" | "pre_existing_unrelated";
};

export type ChapterReviewResult = {
  verdict: "pass" | "revise";
  chapterChange: string;
  reviewNotes: string;
  issues: ChapterReviewIssue[];
  priorBlockerDispositions?: ChapterReviewPriorBlockerDisposition[];
};

export type ChapterReviewPriorBlockerDisposition = {
  priorIssueId: string;
  status: "resolved" | "still_present";
};

export type ChapterReviewInput = {
  chapterGoal: string;
  content: string;
  scenes: ChapterReviewScene[];
  context?: string;
  proseSignals?: unknown;
  revisionReview?: ChapterReviewRevisionContext;
  /** Local enforcement baseline; deliberately omitted from provider messages. */
  revisionBaselineContent?: string;
};

export type ChapterReviewRevisionChange = {
  before: string;
  after: string;
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
};

export type ChapterReviewRevisionContext = {
  mode: "bounded_repair";
  previousSourceHash: string;
  priorBlockers: ProposalRevisionIssue[];
  changes: ChapterReviewRevisionChange[];
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
- 核对时间先后、地点与移动、伤势与体力、物品持有/损毁、身份、关系、经历、能力入场 availability、组织规则和世界机制；unlocked 只是旧卡兼容字段，若与 competencyStates 冲突，以解析后的 availability 与状态原因为准；
- 若证据包提供 sceneCapabilityScopes，逐场核对能力与角色声线：只有该场 competencyUses 列出的能力可进入正文。mode=use 才能作为既有能力直接使用；attempt 允许失败、失控或部分表现，不能因未成功而判越权；unlock/regain 允许在本场由不可用转为可用，但正文必须建立触发、来源与状态转变，转变前不能直接解题；lose 允许能力在本场失去，但应有导致失去的事件与后果。合法觉醒、恢复、失败尝试不得判 capability_scope。只有“入场不可用、没有合法模式或转变证据、却直接承担关键因果”才可判 blocker。dialogue=true 只允许读取所属角色的对白声线；完整卡中其他能力不是本场许可；
- 新增的无害且兼容的小细节不必判错；但没有来源、且被用于解题、定罪、转折或重大决定的关键事实，判 unsupported_fact blocker；
- 对每个事实问题说明冲突基准或缺失的获知路径。若文本给出了足够的观察和推理链，不得因为证据包未逐字登记而误判。

问题类型：fact_conflict=与已确立事实直接冲突；knowledge_leak=角色使用了自己不应知道的信息；unsupported_fact=关键事实无来源却承担因果功能；identity_relationship=身份、关系、称谓或立场不一致；capability_scope=能力未获本场许可，或违反其入场状态与 mode 而直接承担关键因果。

随后按本章目标检查结构与表达：
- 场景接续是否存在因果断裂、状态矛盾或换地点重复同一功能；章首到章尾是否形成与 chapterGoal 相符的变化。静场、铺垫章、过渡章和收束章可以只改变认知、关系或选择，不必强造对抗、悬念和损失；
- telemetry_pileup：读数或术语连续出现，却不影响人物判断与行动；register_leak：资料中的规范术语跨越专业报告、普通对白、贴身叙述或人物内心后仍被当作唯一默认指称，使人物不像在自己的处境中说话或感受。单个必要术语、角色确有专业身份、正式状态汇报和首次精确定义都应放行；不得因词频本身报告，必须引用至少两处能证明语域不分的原文，并说明各处为什么应采用不同的信息精度或体验表达；compressed_prose：叙述或对白连续把主谓、动作对象、感受来源、比较维度或句间承接压成“名词短语＋谓词”，或用抽象归属硬扣物件制造短梗，导致句子虽可猜懂却长期像提纲字段。报此项必须引用至少两处相邻或同段原文并指出被压掉的具体关系；单个短句、军令、紧张重音、自然问答和符合人物压力的口语省略应放行；expository_mechanics：已经成立的动作又被教程式解释挤占；semantic_echo：相邻句段重复同一信息；generic_prose：关键场面长期只有泛化判断，缺少可辨认的现场依据；
- voice_homogenization：主要人物的措辞、信息取舍和说话目的长期无法区分。若 evidence packet 有 dialogueCharacters，先对照其 voice、目标、关系与当前状态；判断两人是否因想达成不同事情而选择不同信息、回避角度和谈话策略（追问、换题、还价、拒绝、解释、威胁等）。报此项必须引用至少两名人物各自的逐字台词，并在 problem 说明可互换的原因；口语标记比例、短句或统计接近都不能单独成立。不要以口头禅、固定句长或强行回避作为角色声线模板；
- dialogue_format：说出口的直接对白应使用「……」，对白内嵌引用使用『……』。独立格式门禁会处理可见的混用与错配；只有明显的裸台词逃过该门禁时才报此项，并引用原文。不要把转述、内心或引文误当作直接对白；
- dialogue_telegraphic：只在相邻对白反复压成名词/状态播报、或省掉施事、对象、因果承接后无法由近邻语境自然补全时报告。检查它是否仍像人在当下为某事说话，而非把提纲字段逐项念出；书面、完整的句子不自动自然，短命令、紧张、沉默、改口及上下文充分的口语省略也不自动有错。必须引用连续原文，说明缺失了什么承接；
- theme_stated：本应由行动和后果成立的意义，被成段总结替代；resolution_too_smooth：人物立场或阻力无新依据地改变，抹掉了正文已经建立的矛盾；
- dialogue_frictionless：仅当本章需要谈判、冲突、试探或隐瞒时，检查对白是否回避了应有的利益差异。直接回答、解释、配合、沉默和日常交流本身都有效，不因缺少“交锋动作”判错；
- drive_flat / stakes_absent：结合 chapterGoal 判断本章是否承诺了未定结果或显著代价。若目标本来是休整、交代、确认或收束，不得要求每场都有主动阻力、不可逆代价或新钩子。

分级原则：事实冲突、知识泄漏、关键因果无来源、状态断裂，以及足以使本章目标无法成立的结构问题可以判 blocker。风格、声线、主题直陈、平顺对白、节奏与驱动力问题默认 warning；只有它们贯穿关键场面、明显妨碍理解或违背项目明确风格约定时才可判 blocker。任何统计字段只用于定位候选段落，不能单独成为证据，也不能用阈值替代语义判断。

单个准确数字、必要技术语言、短句、抽象句和直接对白均可保留。句式符号由独立门禁处理，本终审不做全文润色。evidence 必须逐字引用能证明问题的最短连续原文；没有充分证据就不报。若能给出包含 evidence、在全文中唯一且可整体替换的完整句/段，可选填 oldText；不确定唯一性时省略它。只输出一个 JSON 对象，不要 Markdown、分析过程或改写后的正文。
字段：verdict(pass|revise)；chapterChange；reviewNotes；issues(最多8项，每项 severity=blocker|warning、kind=seam|duplicate_function|turn_repetition|state_continuity|motif_reuse|chapter_arc|fact_conflict|knowledge_leak|unsupported_fact|identity_relationship|capability_scope|telemetry_pileup|register_leak|compressed_prose|expository_mechanics|semantic_echo|generic_prose|voice_homogenization|dialogue_format|dialogue_telegraphic|theme_stated|resolution_too_smooth|dialogue_frictionless|drive_flat|stakes_absent、sceneId、evidence最多3条、oldText可选、problem、action)。revise 必须至少有一项带 sceneId 和逐字证据的 blocker。事实类 blocker 的 problem 必须指出冲突的事实基准，或明确缺少哪条获知路径；不得只写“可能不合理”。`;

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
        ...(input.revisionReview ? {
          revisionReview: {
            mode: input.revisionReview.mode,
            previousSourceHash: input.revisionReview.previousSourceHash,
            priorBlockers: input.revisionReview.priorBlockers,
            changes: input.revisionReview.changes,
            blockerPolicy: [
              "只复核 priorBlockers 是否仍存在，以及本轮 changes 直接引入的严重问题。",
              "不得把本轮修改范围外首次发现的既存问题升级为 blocker；此类问题至多 warning。",
              "旧 blocker 仍存在时填写 priorIssueId 并令 origin=unresolved_prior。",
              "本轮修改直接引入的新 blocker 令 origin=introduced_by_revision。",
              "若本轮删除或改变了前文因果、事实前提或获知路径，导致未改正文出现新问题：evidence 仍逐字引用当前 fullChapter 的问题表现，另填 changeEvidence（最多3条）逐字引用 changes.before/after 中直接造成问题的修改。",
              "当 priorBlockers 非空时，必须输出顶层 priorBlockerDispositions：对每个 priorBlockers.id 恰好一项 {priorIssueId,status}，status 只能是 resolved 或 still_present。still_present 必须同时输出同 priorIssueId、同 kind 的 blocker；resolved 不得仍输出对应 blocker。",
            ],
          },
        } : {}),
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

function uniqueSourceText(sourceText: string | undefined, quote: string): boolean {
  if (!sourceText || !quote) return false;
  const first = sourceText.indexOf(quote);
  return first >= 0 && sourceText.indexOf(quote, first + quote.length) < 0;
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
    "fact_conflict", "knowledge_leak", "unsupported_fact", "identity_relationship", "capability_scope",
    "telemetry_pileup", "register_leak", "compressed_prose", "expository_mechanics", "semantic_echo", "generic_prose",
    "voice_homogenization", "dialogue_format", "dialogue_telegraphic",
    "theme_stated", "resolution_too_smooth", "dialogue_frictionless",
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
    const candidateOldText = boundedString(issue.oldText, 1_200);
    const oldText = candidateOldText
      && evidence.some(item => normalizeEvidenceNeedle(candidateOldText).includes(normalizeEvidenceNeedle(item)))
      && uniqueSourceText(sourceText, candidateOldText)
      ? candidateOldText
      : undefined;
    const changeEvidence = Array.isArray(issue.changeEvidence)
      ? issue.changeEvidence.map(item => boundedString(item, 180))
        .filter(Boolean)
        .slice(0, 3)
      : [];
    const priorIssueId = boundedString(issue.priorIssueId, 96);
    const origin = issue.origin === "unresolved_prior"
      || issue.origin === "introduced_by_revision"
      || issue.origin === "pre_existing_unrelated"
      ? issue.origin
      : undefined;
    issues.push({
      severity,
      kind,
      ...(sceneId ? { sceneId } : {}),
      evidence,
      ...(oldText ? { oldText } : {}),
      ...(changeEvidence.length ? { changeEvidence } : {}),
      problem,
      action,
      ...(priorIssueId ? { priorIssueId } : {}),
      ...(origin ? { origin } : {}),
    });
  }
  // Incomplete blockers must not invalidate sibling locatable blockers (old `.some` did that).
  const locatableBlockers = issues.filter(
    issue => issue.severity === "blocker" && issue.sceneId && issue.evidence.length > 0
      && (!["voice_homogenization", "register_leak", "compressed_prose"].includes(issue.kind) || issue.evidence.length >= 2),
  );
  const normalizedIssues = issues.map(issue => {
    if (issue.severity === "blocker" && (!issue.sceneId || !issue.evidence.length
      || (["voice_homogenization", "register_leak", "compressed_prose"].includes(issue.kind) && issue.evidence.length < 2))) {
      return { ...issue, severity: "warning" as const };
    }
    return issue;
  });
  const priorBlockerDispositions = parsePriorBlockerDispositions(value.priorBlockerDispositions);
  if (verdict === "revise" && locatableBlockers.length === 0) {
    // Model claimed revise but substantiated nothing. Direct-doc (single scene) demotes to
    // pass so we do not mis-report "终审服务不可用" and empty-retry the same draft. Multi-scene
    // structural review still requires a locatable target scene.
    if (soleSceneId) {
      return {
        verdict: "pass",
        chapterChange,
        reviewNotes,
        issues: normalizedIssues,
        ...(priorBlockerDispositions ? { priorBlockerDispositions } : {}),
      };
    }
    throw new Error("整章终审要求 revise，但没有提供可定位的 blocker 证据");
  }
  return {
    verdict,
    chapterChange,
    reviewNotes,
    issues: normalizedIssues,
    ...(priorBlockerDispositions ? { priorBlockerDispositions } : {}),
  };
}

function parsePriorBlockerDispositions(
  value: unknown,
): ChapterReviewPriorBlockerDisposition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("修订终审缺少有效 priorBlockerDispositions：顶层字段不是数组");
  }
  const dispositions: ChapterReviewPriorBlockerDisposition[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("修订终审缺少有效 priorBlockerDispositions：存在无效条目");
    }
    const disposition = row as Record<string, unknown>;
    const priorIssueId = boundedString(disposition.priorIssueId, 96);
    const status = disposition.status === "resolved" || disposition.status === "still_present"
      ? disposition.status
      : undefined;
    if (!priorIssueId || !status) {
      throw new Error("修订终审缺少有效 priorBlockerDispositions：条目缺少 priorIssueId 或 status");
    }
    dispositions.push({ priorIssueId, status });
  }
  return dispositions;
}

const MAX_REVISION_CHANGE_EXCERPTS = 24;
const MAX_REVISION_EXCERPT_CHARACTERS = 700;

/**
 * Build a bounded repair packet without sending the previous full chapter a
 * second time. Normal chapters use the existing readable diff; pathological
 * single-line bodies fall back to a linear common-prefix/suffix range.
 */
export function buildChapterReviewRevisionContext(input: {
  previousContent: string;
  content: string;
  previousSourceHash: string;
  priorBlockers: ProposalRevisionIssue[];
}): ChapterReviewRevisionContext {
  const changes = revisionChangesFromDiff(input.previousContent, input.content)
    .slice(0, MAX_REVISION_CHANGE_EXCERPTS);
  return {
    mode: "bounded_repair",
    previousSourceHash: input.previousSourceHash,
    priorBlockers: input.priorBlockers.slice(0, 8),
    changes,
  };
}

/** Enforce the repair-chain scope even if an isolated reviewer drifts. */
export function constrainChapterRevisionReview(
  review: ChapterReviewResult,
  revision: ChapterReviewRevisionContext,
  previousContent: string,
  content = "",
): ChapterReviewResult {
  const priorById = new Map(revision.priorBlockers.map(issue => [issue.id, issue]));
  // The provider packet is intentionally bounded, but local enforcement must cover every
  // changed range. Recompute from the two authoritative bodies instead of trusting excerpts.
  const allChanges = revisionChangesFromDiff(previousContent, content);
  const normalizedPreviousContent = normalizedSourceOffsets(previousContent);
  const normalizedContent = normalizedSourceOffsets(content);
  const issues = review.issues.map(issue => {
    const explicitPrior = issue.priorIssueId ? priorById.get(issue.priorIssueId) : undefined;
    const explicitPriorId = explicitPrior?.kind === issue.kind
      ? explicitPrior.id
      : undefined;
    if (issue.severity !== "blocker") {
      if (!issue.priorIssueId || explicitPriorId) return issue;
      const { priorIssueId: _unmatchedPriorIssueId, ...withoutUnmatchedPriorIssueId } = issue;
      return withoutUnmatchedPriorIssueId;
    }
    const generatedId = proposalRevisionIssueId(issue);
    const sameKindPrior = issue.origin === "unresolved_prior"
      ? revision.priorBlockers.filter(prior => prior.kind === issue.kind)
      : [];
    const matchedPriorId = issue.priorIssueId
      ? explicitPriorId
      : (priorById.has(generatedId) ? generatedId : undefined)
        ?? (sameKindPrior.length === 1 ? sameKindPrior[0].id : undefined);
    const touchesRevision = issue.evidence.some(evidence => evidenceTouchesChanges(
      content,
      normalizedContent,
      evidence,
      allChanges,
      "after",
    ));
    const inferredIntroduction = touchesRevision && issue.evidence.some(evidence =>
      !normalizedContains(previousContent, evidence));
    const validatedChangeEvidence = issue.changeEvidence?.filter(evidence =>
      evidenceTouchesChanges(
        previousContent,
        normalizedPreviousContent,
        evidence,
        allChanges,
        "before",
      ) || evidenceTouchesChanges(
        content,
        normalizedContent,
        evidence,
        allChanges,
        "after",
      )) ?? [];
    const introducedByRevision = (touchesRevision
      && (issue.origin === "introduced_by_revision" || inferredIntroduction))
      || (issue.origin === "introduced_by_revision" && validatedChangeEvidence.length > 0);
    const {
      priorIssueId: _claimedPriorIssueId,
      changeEvidence: _unvalidatedChangeEvidence,
      ...baseIssue
    } = issue;
    const withValidatedChangeEvidence = validatedChangeEvidence.length
      ? { ...baseIssue, changeEvidence: validatedChangeEvidence }
      : baseIssue;
    if (matchedPriorId) {
      return { ...withValidatedChangeEvidence, priorIssueId: matchedPriorId, origin: "unresolved_prior" as const };
    }
    if (introducedByRevision) {
      return { ...withValidatedChangeEvidence, origin: "introduced_by_revision" as const };
    }
    return {
      ...withValidatedChangeEvidence,
      severity: "warning" as const,
      origin: "pre_existing_unrelated" as const,
    };
  });
  validatePriorBlockerDispositions(review.priorBlockerDispositions, revision.priorBlockers, issues);
  return {
    ...review,
    verdict: issues.some(issue => issue.severity === "blocker") ? "revise" : "pass",
    issues,
  };
}

function validatePriorBlockerDispositions(
  dispositions: readonly ChapterReviewPriorBlockerDisposition[] | undefined,
  priorBlockers: readonly ProposalRevisionIssue[],
  issues: readonly ChapterReviewIssue[],
): void {
  const priorById = new Map(priorBlockers.map(issue => [issue.id, issue]));
  const dispositionById = new Map<string, ChapterReviewPriorBlockerDisposition>();
  for (const disposition of dispositions ?? []) {
    if (!priorById.has(disposition.priorIssueId)) {
      throw new Error(
        `修订终审缺少有效 priorBlockerDispositions：包含未知 priorIssueId ${disposition.priorIssueId}`,
      );
    }
    if (dispositionById.has(disposition.priorIssueId)) {
      throw new Error(
        `修订终审缺少有效 priorBlockerDispositions：priorIssueId ${disposition.priorIssueId} 重复`,
      );
    }
    dispositionById.set(disposition.priorIssueId, disposition);
  }
  const missing = priorBlockers.filter(issue => !dispositionById.has(issue.id));
  if (missing.length) {
    throw new Error(
      `修订终审缺少有效 priorBlockerDispositions：未覆盖 ${missing.map(issue => issue.id).join(", ")}`,
    );
  }
  for (const prior of priorBlockers) {
    const disposition = dispositionById.get(prior.id)!;
    const matchingBlocker = issues.some(issue => issue.severity === "blocker"
      && issue.priorIssueId === prior.id
      && issue.kind === prior.kind);
    if (disposition.status === "still_present" && !matchingBlocker) {
      throw new Error(
        `修订终审缺少有效 priorBlockerDispositions：${prior.id} 标为 still_present 但无同 ID、同 kind blocker`,
      );
    }
    if (disposition.status === "resolved" && matchingBlocker) {
      throw new Error(
        `修订终审缺少有效 priorBlockerDispositions：${prior.id} 标为 resolved 但仍有对应 blocker`,
      );
    }
  }
}

function revisionChangesFromDiff(
  before: string,
  after: string,
): ChapterReviewRevisionChange[] {
  if (before === after) return [];
  const beforeSpans = documentSpans(before, "revision-before");
  const afterSpans = documentSpans(after, "revision-after");
  const queues = new Map<string, { values: number[]; cursor: number }>();
  beforeSpans.forEach((span, index) => {
    const key = revisionSpanKey(span);
    const queue = queues.get(key) ?? { values: [], cursor: 0 };
    queue.values.push(index);
    queues.set(key, queue);
  });
  const pairs = afterSpans.flatMap((span, afterIndex) => {
    const queue = queues.get(revisionSpanKey(span));
    if (!queue || queue.cursor >= queue.values.length) return [];
    const beforeIndex = queue.values[queue.cursor++];
    return [{ beforeIndex, afterIndex }];
  });
  const stableAfter = longestIncreasingPairPositions(pairs);
  const stableBefore = new Set(
    pairs.filter(pair => stableAfter.has(pair.afterIndex)).map(pair => pair.beforeIndex),
  );
  const changedBefore = beforeSpans.filter((_span, index) => !stableBefore.has(index));
  const changedAfter = afterSpans.filter((_span, index) => !stableAfter.has(index));
  if (!changedBefore.length && !changedAfter.length) {
    return [fallbackRevisionChange(before, after)];
  }
  const changes: ChapterReviewRevisionChange[] = [];
  const count = Math.max(changedBefore.length, changedAfter.length);
  for (let index = 0; index < count; index += 1) {
    const beforeSpan = changedBefore[index];
    const afterSpan = changedAfter[index];
    const narrowed = narrowRevisionPair(beforeSpan, afterSpan);
    changes.push({
      beforeStart: narrowed.beforeStart,
      beforeEnd: narrowed.beforeEnd,
      afterStart: narrowed.afterStart,
      afterEnd: narrowed.afterEnd,
      before: revisionExcerpt(before, narrowed.beforeStart, narrowed.beforeEnd),
      after: revisionExcerpt(after, narrowed.afterStart, narrowed.afterEnd),
    });
  }
  return changes;
}

function revisionExcerpt(text: string, start: number, end: number): string {
  if (!text) return "";
  const padding = Math.floor(MAX_REVISION_EXCERPT_CHARACTERS / 2);
  let from = Math.max(0, start - padding);
  let to = Math.min(text.length, Math.max(end, start) + padding);
  const left = text.slice(from, start);
  const leftBoundary = Math.max(left.lastIndexOf("\n"), left.lastIndexOf("。"), left.lastIndexOf("！"), left.lastIndexOf("？"));
  if (leftBoundary >= 0) from += leftBoundary + 1;
  const right = text.slice(end, to);
  const candidates = [right.indexOf("\n"), right.indexOf("。"), right.indexOf("！"), right.indexOf("？")]
    .filter(index => index >= 0);
  if (candidates.length) to = end + Math.min(...candidates) + 1;
  if (to - from > MAX_REVISION_EXCERPT_CHARACTERS) {
    const center = Math.max(start, Math.min(end, Math.floor((start + end) / 2)));
    from = Math.max(0, center - padding);
    to = Math.min(text.length, from + MAX_REVISION_EXCERPT_CHARACTERS);
  }
  return text.slice(from, to);
}

function normalizedContains(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeEvidenceNeedle(needle);
  return Boolean(normalizedNeedle) && normalizeEvidenceNeedle(haystack).includes(normalizedNeedle);
}

function revisionSpanKey(span: DocumentSpan): string {
  return `${span.kind}\u0000${span.content}`;
}

function longestIncreasingPairPositions(
  pairs: Array<{ beforeIndex: number; afterIndex: number }>,
): Set<number> {
  if (!pairs.length) return new Set();
  const tails: number[] = [];
  const tailPairIndexes: number[] = [];
  const previous = new Int32Array(pairs.length);
  previous.fill(-1);
  for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
    const value = pairs[pairIndex].beforeIndex;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle] < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    if (low > 0) previous[pairIndex] = tailPairIndexes[low - 1];
    tailPairIndexes[low] = pairIndex;
  }
  const stable = new Set<number>();
  let pairIndex = tailPairIndexes[tails.length - 1] ?? -1;
  while (pairIndex >= 0) {
    stable.add(pairs[pairIndex].afterIndex);
    pairIndex = previous[pairIndex];
  }
  return stable;
}

function narrowRevisionPair(
  beforeSpan: DocumentSpan | undefined,
  afterSpan: DocumentSpan | undefined,
): { beforeStart: number; beforeEnd: number; afterStart: number; afterEnd: number } {
  if (!beforeSpan) {
    const point = afterSpan?.startOffset ?? 0;
    return {
      beforeStart: point,
      beforeEnd: point,
      afterStart: afterSpan?.startOffset ?? 0,
      afterEnd: afterSpan?.endOffset ?? 0,
    };
  }
  if (!afterSpan) {
    return {
      beforeStart: beforeSpan.startOffset,
      beforeEnd: beforeSpan.endOffset,
      afterStart: beforeSpan.startOffset,
      afterEnd: beforeSpan.startOffset,
    };
  }
  let prefix = 0;
  const prefixLimit = Math.min(beforeSpan.content.length, afterSpan.content.length);
  while (prefix < prefixLimit && beforeSpan.content[prefix] === afterSpan.content[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < beforeSpan.content.length - prefix && suffix < afterSpan.content.length - prefix
    && beforeSpan.content[beforeSpan.content.length - 1 - suffix]
      === afterSpan.content[afterSpan.content.length - 1 - suffix]) suffix += 1;
  return {
    beforeStart: beforeSpan.startOffset + prefix,
    beforeEnd: beforeSpan.endOffset - suffix,
    afterStart: afterSpan.startOffset + prefix,
    afterEnd: afterSpan.endOffset - suffix,
  };
}

function fallbackRevisionChange(before: string, after: string): ChapterReviewRevisionChange {
  let prefix = 0;
  const prefixLimit = Math.min(before.length, after.length);
  while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  return {
    beforeStart: prefix,
    beforeEnd,
    afterStart: prefix,
    afterEnd,
    before: revisionExcerpt(before, prefix, beforeEnd),
    after: revisionExcerpt(after, prefix, afterEnd),
  };
}

function evidenceTouchesChanges(
  source: string,
  normalizedSource: ReturnType<typeof normalizedSourceOffsets>,
  evidence: string,
  changes: readonly ChapterReviewRevisionChange[],
  side: "before" | "after",
): boolean {
  if (!evidence) return false;
  const ranges = changes.flatMap(change => {
    const start = side === "before" ? change.beforeStart : change.afterStart;
    const end = side === "before" ? change.beforeEnd : change.afterEnd;
    return end > start ? [{ start, end }] : [];
  });
  if (!ranges.length) return false;
  let offset = source.indexOf(evidence);
  while (offset >= 0) {
    const end = offset + evidence.length;
    if (ranges.some(range => offset < range.end && end > range.start)) return true;
    offset = source.indexOf(evidence, offset + 1);
  }

  const needle = normalizeEvidenceNeedle(evidence);
  if (!needle) return false;
  let normalizedOffset = normalizedSource.text.indexOf(needle);
  while (normalizedOffset >= 0) {
    const normalizedEnd = normalizedOffset + needle.length - 1;
    const rawStart = normalizedSource.starts[normalizedOffset];
    const rawEnd = normalizedSource.ends[normalizedEnd];
    if (ranges.some(range => rawStart < range.end && rawEnd > range.start)) return true;
    normalizedOffset = normalizedSource.text.indexOf(needle, normalizedOffset + 1);
  }
  return false;
}

function normalizedSourceOffsets(source: string): {
  text: string;
  starts: number[];
  ends: number[];
} {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < source.length;) {
    const codePoint = source.codePointAt(offset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const end = offset + character.length;
    let replacement = character;
    if (/\s/u.test(character)) replacement = "";
    else if (/[“”「」『』]/u.test(character)) replacement = "\"";
    else if (/[‘’]/u.test(character)) replacement = "'";
    else if (character === "…") replacement = "...";
    else if (/[—–]/u.test(character)) replacement = "-";
    text += replacement;
    for (let index = 0; index < replacement.length; index += 1) {
      starts.push(offset);
      ends.push(end);
    }
    offset = end;
  }
  return { text, starts, ends };
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
    if (input.revisionReview) {
      review = constrainChapterRevisionReview(
        review,
        input.revisionReview,
        input.revisionBaselineContent ?? "",
        input.content,
      );
    }
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
