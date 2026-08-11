import {
  findProseConstructionMatches,
  PROSE_CONSTRUCTION_RULES,
  proseConstructionRule,
  proseConstructionRequiresRevision,
  proseConstructionGenerationPrompt,
} from "./prose_construction_rules.js";
import { boundedRepairPacket, type RepairPacket, type RepairPacketIssue } from "./repair_packet.js";

export type ProseStyleSeverity = "error" | "warning" | "info";
export type ProseStyleSubtype =
  | "speech_extension" | "speech_interruption" | "speech_hesitation"
  | "system_or_metadata" | "parenthetical_explanation" | "appositive_definition"
  | "cause_or_judgment" | "ambiguous_dash"
  | "narrator_redefinition" | "abstract_reframing" | "split_redefinition" | "dialogue_correction" | "factual_exclusion"
  | "semantic_echo" | "emotion_label" | "intent_translation" | "thematic_summary" | "causal_gloss"
  | "learned_rule";

export interface ProseStyleIssue {
  id: string;
  kind: "dash" | "contrast" | "explanation" | "learned";
  subtype: ProseStyleSubtype;
  severity: ProseStyleSeverity;
  confidence: number;
  start: number;
  end: number;
  line: number;
  column: number;
  sentence: string;
  evidence: string;
  reason: string;
  suggestions: string[];
  /** Registered syntax candidate; semantic verdict and deterministic family density are independent. */
  constructionRuleId?: string;
  semanticVerdict?: "allow" | "warn" | "block";
  /** Semantic validity and family density are independent; only true quotations/metadata should opt out. */
  countsTowardFamilyBudget?: boolean;
  /** Source policy/skill for explainable review and targeted repair. */
  policyId?: string;
  policyVersion?: number;
  skillId?: string;
}

export interface ContrastStyleReport {
  count: number;
  allowed: number;
  examples: string[];
  dashCount: number;
  dashAllowed: number;
  frameCount: number;
  issues: ProseStyleIssue[];
}

type MatchRange = { start: number; end: number; text: string };
const DASH_UNIT = /(?:[—–―﹘]{1,2}|-{2})/gu;
const LEGACY_CONTRAST_PATTERNS = [
  /(?:仿佛|好像)[^\n。！？!?]{0,36}又(?:仿佛|好像)/gu,
];
/** 仅高教学/解释口吻；日常叙事里「这/那/原来/仿佛」后接破折号很常见，不计入硬说明信号。 */
const EXPLANATION_SIGNALS = /^(?:因为|由于|意味着|也就是|换句话说|其实|显然|说明|证明|正是|即|不过是)/u;
const SOUND_OR_INTERJECTION = /[啊呀哦噢嗯呜哎唉哈嘿嘘喂诶咦嗡轰砰嘎]/u;
const EXPLANATORY_ANAPHORA = /^(?:这|那|这一切|这一幕|这种(?:反应|举动|沉默|态度)|如此|由此)(?:无疑|显然|恰恰)?(?:说明|意味着|表明|证明|代表|显示)/u;
const NARRATOR_REDEFINITION = /^(?:换句话说|也就是说|说到底|归根结底|从本质上说|实质上|本质上|真正(?:重要|关键|可怕|危险|困难|残酷)的(?:是|在于))/u;
const THEMATIC_SUMMARY = /^(?:直到(?:这时|此刻|现在)[，,]?(?:他|她|他们|她们)?才(?:明白|意识到|懂得)|这一刻(?:意味着|标志着)|从(?:这天|这一刻|此刻)起|真正重要的(?:是|从来不是)|归根结底)/u;
const INTENT_TRANSLATION = /^(?:(?:他|她|他们|她们)(?:这么|这样)做(?:并)?(?:不是|只是|是为了)|(?:他|她|他们|她们)真正想(?:说|要|表达)的(?:是|不过是)|这句话真正的意思是)/u;
const EMOTION_LABEL = /^(?:(?:他|她|他们|她们)(?:显然|无疑|其实)?(?:感到|意识到|明白|知道)|(?:愤怒|恐惧|悲伤|绝望|不安|紧张|羞耻|内疚|委屈|嫉妒|慌乱)(?:在|从).{0,12}(?:升起|蔓延|涌出|滋生))/u;
const CAUSAL_GLOSS = /^(?:(?:这|那|之所以如此)(?:只是|正是)?因为|原因(?:其实|恰恰)?(?:是|在于)|之所以.{0,36}(?:是因为|只因))/u;

/**
 * Prompt usage (CACHE — see agent.ts PROMPT / PREFIX-CACHE CONTRACT):
 * - Prefer `proseMannerismConstraintPrompt({ compact: true })` in stable system /
 *   short task lines so the same full block is not pasted into every slot.
 * - Full prompt is for stable style grounding / review once; avoid also dumping it
 *   into dynamicContext, bootstrap, and every taskInstructions branch.
 * - `proseMannerismPreflightLine()` is the one-line cross-reference for workflows.
 */

/**
 * 仅这些子类在“过密”时可能升为 error（会拦截提案）。
 * 普通叙事破折号、同位说明、模糊破折号、事实排除只保留 warning/info。
 */
export const HARD_BLOCK_SUBTYPES = new Set<ProseStyleSubtype>([
  "parenthetical_explanation",
  "cause_or_judgment",
  "abstract_reframing",
  "split_redefinition",
  "factual_exclusion",
  // 默认 info；仅在 escalate 后对白骨架过密时升为 error
  "dialogue_correction",
  "narrator_redefinition",
  "semantic_echo",
  "emotion_label",
  "intent_translation",
  "thematic_summary",
  "causal_gloss",
  "learned_rule",
]);

export function isHardBlockSubtype(subtype: ProseStyleSubtype): boolean {
  return HARD_BLOCK_SUBTYPES.has(subtype);
}

/** Density threshold for escalating high-confidence hard mannerisms to error. */
export function hardMannerismLimit(text: string): number {
  const characters = Math.max(1, text.replace(/\s/g, "").length);
  return Math.max(5, 3 + Math.floor(characters / 2_000));
}

function hardMannerismFamily(subtype: ProseStyleSubtype): "dash" | "contrast" | "explanation" {
  if (subtype === "parenthetical_explanation" || subtype === "cause_or_judgment") return "dash";
  if (subtype === "abstract_reframing" || subtype === "split_redefinition"
    || subtype === "factual_exclusion" || subtype === "narrator_redefinition") return "contrast";
  return "explanation";
}

/**
 * Density is only a candidate signal. Limits deliberately tolerate isolated and
 * occasional repeated forms; semantic adjudication decides whether they are
 * actually explanatory clutter before a proposal is blocked.
 */
function hardMannerismFamilyLimit(text: string, family: "dash" | "contrast" | "explanation"): number {
  const characters = Math.max(1, text.replace(/\s/g, "").length);
  if (family === "contrast") return Math.max(3, 2 + Math.floor(characters / 3_000));
  if (family === "explanation") return Math.max(3, 2 + Math.floor(characters / 2_500));
  return hardMannerismLimit(text);
}

/**
 * Generation-time guidance shared by the main and isolated writing paths.
 */
export function proseMannerismConstraintPrompt(options?: { compact?: boolean }): string {
  const lines = [
    "句式边界（只防止密集退化，不把自然语言改造成统一模板）：",
    proseConstructionGenerationPrompt(),
    "1. 对比、否定、破折号和短句都可自然使用；除上列高辨识度骨架外，只有连续复现并替代新信息时才需改写。",
    "2. 动作、对白或细节已经传达的意义不再换一种说法复述；解释应带来新的事实、因果或认知变化。",
    "3. 句子须保留理解行动所需的施事、对象与关系；上下文足以唯一还原的口语省略、紧张短句和偶发重音应保留。",
    "4. 专名、读数和技术说明按人物当下决策所需进入正文；密集到遮蔽行动与关系时再压缩。",
  ];
  if (options?.compact) return lines.join("\n");
  return `${lines.join("\n")}\n5. 提交前只处理成片重复、关系含混或明显挤压现场的问题；孤立且符合人物语气、节奏或文体的表达不要为通过检查而磨平。`;
}

/** One-line checklist for pre-submit self-check in task workflows. */
export function proseMannerismPreflightLine(): string {
  return "按「风格锚定」的句式边界复核密集复现、重复解释与关系含混；孤立且符合人物和现场的表达保留。";
}

/** Dynamic guidance: keep terse prose from collapsing into note-like predicates. */
export function proseCompressionGuidance(): string {
  return "缩句自然度契约：短句和省略必须来自人物当下的说话压力、动作落点或已明确的近邻关系。不要把本可自然说清的主谓、动作对象、感受来源或比较维度连续压成“名词短语＋一个状态/动作”，也不要把抽象归属或判断硬扣到物件上制造冷淡机锋。上下文能猜出意思不等于表达自然；若连续几句都靠读者补关系，应恢复其中至少一处完整而朴素的承接。";
}

/**
 * Scene-level hard-mannerism gate (rules only, no Flash).
 * Reject a single scene before it enters the chapter draft so density never
 * accumulates to a full-chapter style revise loop.
 */
export function sceneMannerismGateError(text: string): string | undefined {
  const errors = analyzeProseStyle(text).filter(issue =>
    issue.severity === "error" && HARD_BLOCK_SUBTYPES.has(issue.subtype),
  );
  if (!errors.length) return undefined;
  const headline = errors.some(issue => issue.constructionRuleId)
    ? "本场句式家族预算超限，尚未写入草稿"
    : "本场说明式写法过密，尚未写入草稿";
  return formatProseStyleBlockError(errors, headline);
}

/** Rule scan without density escalation (for pre-model packing). */
export function scanProseStyleIssues(text: string): ProseStyleIssue[] {
  return [...scanDashes(text), ...scanRegisteredConstructions(text), ...scanLegacyContrasts(text), ...scanExplanationCandidates(text)]
    .sort((a, b) => a.start - b.start);
}

/**
 * Re-apply density escalation after Flash demotions.
 * Resets prior error→warning on hard subtypes, then promotes when over limit.
 */
export function escalateHardMannerisms(text: string, issues: ProseStyleIssue[]): ProseStyleIssue[] {
  for (const issue of issues) {
    if (issue.constructionRuleId) {
      // A registered narration policy may require revision even when a reviewer
      // finds the local meaning defensible. Local validity is not an escape hatch
      // for a prohibited explanatory skeleton.
      issue.severity = proseConstructionRequiresRevision(issue.constructionRuleId, issue.subtype)
        ? "error"
        : issue.semanticVerdict === "allow"
        ? "info"
        : issue.semanticVerdict === "block"
          ? "error"
          : issue.subtype === "dialogue_correction" ? "info" : "warning";
      continue;
    }
    if (issue.severity === "error"
      && HARD_BLOCK_SUBTYPES.has(issue.subtype)) {
      // dialogue_correction 默认从 info 起步，不在此重置
      if (issue.subtype === "dialogue_correction") continue;
      issue.severity = "warning";
    }
  }
  const limit = hardMannerismLimit(text);
  const candidates = issues.filter(issue =>
    issue.severity === "warning"
    && issue.confidence >= 0.9
    && HARD_BLOCK_SUBTYPES.has(issue.subtype)
    && issue.subtype !== "dialogue_correction"
    && !issue.constructionRuleId
  );
  const crowdedFamilies = new Set<ReturnType<typeof hardMannerismFamily>>();
  for (const family of ["dash", "contrast", "explanation"] as const) {
    const familyCount = candidates.filter(issue => hardMannerismFamily(issue.subtype) === family).length;
    if (familyCount > hardMannerismFamilyLimit(text, family)) crowdedFamilies.add(family);
  }
  if (candidates.length > limit || crowdedFamilies.size) {
    for (const issue of candidates) {
      if (candidates.length > limit || crowdedFamilies.has(hardMannerismFamily(issue.subtype))) {
        issue.severity = "error";
      }
    }
  }
  // Registered constructions have two independent axes. Flash decides whether an
  // occurrence is semantically justified; the deterministic family budget still
  // measures every occurrence unless the adjudicator explicitly marks it as
  // metadata/non-usage. An allowed sentence may remain, but it must not make a
  // chapter-wide repetition pattern disappear from the evidence.
  const characters = Math.max(1, text.replace(/\s/g, "").length);
  const familyRules = new Map(PROSE_CONSTRUCTION_RULES.map(rule => [rule.familyId, rule]));
  for (const [familyId, budgetRule] of familyRules) {
    const familyRuleIds = new Set(PROSE_CONSTRUCTION_RULES.filter(rule => rule.familyId === familyId).map(rule => rule.id));
    const counted = issues.filter(issue =>
      issue.constructionRuleId !== undefined
      && familyRuleIds.has(issue.constructionRuleId as typeof budgetRule.id)
      && issue.countsTowardFamilyBudget !== false,
    );
    const allowed = budgetRule.allowedOccurrences(characters);
    if (counted.length <= allowed) continue;
    const unresolved = counted.filter(issue => issue.semanticVerdict !== "allow");
    const allowedCount = counted.length - unresolved.length;
    const unresolvedBudget = Math.max(0, allowed - allowedCount);
    const keep = new Set(unresolved
      .slice()
      .sort((left, right) => constructionKeepPriority(right) - constructionKeepPriority(left) || left.start - right.start)
      .slice(0, unresolvedBudget)
      .map(issue => issue.id));
    for (const issue of unresolved) {
      if (keep.has(issue.id)) continue;
      // Only unresolved/warned occurrences reach this branch; explicit allows
      // were excluded above, while explicit blocks remain actionable.
      issue.severity = "error";
      issue.confidence = Math.max(issue.confidence, 0.95);
      issue.reason = `${issue.reason}（未放行的句式家族 ${counted.length}/${allowed}，需减少成片重复）`;
      issue.suggestions = ["保留更不可替代的少数实例；本句改为直接事实、动作、感受或人物特有说法", ...issue.suggestions].slice(0, 4);
    }
  }
  return issues;
}

function constructionKeepPriority(issue: ProseStyleIssue): number {
  const semantic = issue.semanticVerdict === "allow" ? 30 : issue.semanticVerdict === "warn" ? 10 : issue.semanticVerdict === "block" ? 0 : 15;
  const contextual = issue.subtype === "dialogue_correction" ? 8 : issue.subtype === "factual_exclusion" ? 4 : 0;
  return semantic + contextual;
}

/** Context-aware scanner for explanatory dashes and formulaic redefinition frames. */
export function analyzeProseStyle(text: string): ProseStyleIssue[] {
  return escalateHardMannerisms(text, scanProseStyleIssues(text));
}

export function contrastStyleReport(text: string): ContrastStyleReport {
  const issues = analyzeProseStyle(text);
  const counted = issues.filter(issue => issue.severity !== "info");
  const dashCount = counted.filter(issue => issue.kind === "dash").length;
  const frameCount = counted.filter(issue => issue.kind === "contrast").length;
  const characters = text.replace(/\s/g, "").length;
  return {
    count: counted.length,
    // 放宽统计额度：更偏“过密才提醒”
    allowed: 3 + Math.floor(characters / 2_000),
    examples: counted.map(issue => issue.evidence).slice(0, 5),
    dashCount,
    dashAllowed: 3 + Math.floor(characters / 2_500),
    frameCount,
    issues,
  };
}

export function contrastStyleError(text: string): string | undefined {
  const errors = analyzeProseStyle(text).filter(issue => issue.severity === "error");
  if (!errors.length) return undefined;
  return formatProseStyleBlockError(errors, "正文中说明式写法过密");
}

/** Return only issues introduced by `after`, using a multiset so duplicate mannerisms are detected. */
export function newProseStyleIssues(before: string, after: string): ProseStyleIssue[] {
  const beforeIssues = analyzeProseStyle(before);
  const afterIssues = analyzeProseStyle(after);
  const remaining = new Map<string, number>();
  for (const issue of beforeIssues) {
    const key = issueFingerprint(issue);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const familyIncreased = new Set<string>();
  const familyOverBudget = new Set<string>();
  for (const familyId of new Set(PROSE_CONSTRUCTION_RULES.map(rule => rule.familyId))) {
    const familyRules = PROSE_CONSTRUCTION_RULES.filter(rule => rule.familyId === familyId);
    const ruleIds = new Set(familyRules.map(rule => rule.id));
    const beforeCount = beforeIssues.filter(issue => issue.constructionRuleId !== undefined
      && ruleIds.has(issue.constructionRuleId as typeof familyRules[number]["id"])
      && issue.countsTowardFamilyBudget !== false).length;
    const afterCount = afterIssues.filter(issue => issue.constructionRuleId !== undefined
      && ruleIds.has(issue.constructionRuleId as typeof familyRules[number]["id"])
      && issue.countsTowardFamilyBudget !== false).length;
    if (afterCount > beforeCount) familyIncreased.add(familyId);
    const characters = Math.max(1, after.replace(/\s/gu, "").length);
    if (afterCount > familyRules[0].allowedOccurrences(characters)) familyOverBudget.add(familyId);
  }
  return afterIssues.filter(issue => {
    const key = issueFingerprint(issue);
    const count = remaining.get(key) ?? 0;
    if (count > 0) { remaining.set(key, count - 1); return false; }
    return true;
  }).map(issue => {
    const rule = proseConstructionRule(issue.constructionRuleId);
    if (rule && issue.severity === "error" && !familyIncreased.has(rule.familyId)) {
      issue.severity = issue.subtype === "dialogue_correction" ? "info" : "warning";
    } else if (rule && familyIncreased.has(rule.familyId) && familyOverBudget.has(rule.familyId)) {
      issue.severity = "error";
      issue.confidence = Math.max(issue.confidence, 0.95);
    }
    return issue;
  });
}

/**
 * 提案硬拦截：只拦“新增且被升级为 error”的硬说明问题。
 * 普通 warning（含多数破折号、作者风格偏好 learned_rule）不拦截提交。
 * 风格偏好改为交付后可选修订，避免把自动修订预算烧在句式偏好上。
 */
export function proseStyleIssuesError(issues: ProseStyleIssue[]): string | undefined {
  const errors = hardProseStyleErrors(issues);
  if (!errors.length) return undefined;
  const headline = errors.some(issue => issue.subtype === "learned_rule")
    ? "本次修改违反作者沉淀的复审规则"
    : errors.some(issue => issue.constructionRuleId)
      ? "本次修改新增超出预算的句式家族用法"
    : "本次修改新增过密的高置信度说明式写法";
  return formatProseStyleBlockError(errors, headline);
}

/**
 * Delivery hard errors only.
 * `learned_rule` is advisory unless it is a factual red-line with severity=error
 * (currently only quoted-text-count-consistency can be error-level).
 */
function hardProseStyleErrors(issues: readonly ProseStyleIssue[]): ProseStyleIssue[] {
  return issues.filter(issue => {
    if (issue.severity !== "error" || !HARD_BLOCK_SUBTYPES.has(issue.subtype)) return false;
    // Aesthetic learned preferences must never block first delivery.
    if (issue.subtype === "learned_rule" && issue.policyId && issue.policyId !== "quoted-text-count-consistency") {
      return false;
    }
    if (issue.subtype === "learned_rule" && !issue.policyId) {
      // Built-in style preferences projected as learned without policyId: never block.
      const redLine = /quoted-text-count-consistency/u.test(issue.id) || /quoted-text-count/u.test(issue.reason);
      return redLine;
    }
    return true;
  });
}

/** Non-blocking style / author-preference hits for optional post-delivery repair. */
export function proseStyleAdvisoryIssues(issues: readonly ProseStyleIssue[]): ProseStyleIssue[] {
  return issues.filter(issue => {
    if (issue.severity === "error" && hardProseStyleErrors([issue]).length) return false;
    return issue.severity === "warning" || issue.severity === "error" || issue.subtype === "learned_rule";
  }).slice(0, 40);
}

/**
 * Preserve exact repair targets beside the human-readable gate error. A sentence
 * is only offered as oldText when it is unique in the working copy, so the Agent
 * can batch edit_file calls without first paging through the full document.
 */
export function proseStyleRepairPacket(
  text: string,
  issues: readonly ProseStyleIssue[],
  source?: { path?: string; sourceHash?: string },
): RepairPacket | undefined {
  const errors = hardProseStyleErrors(issues);
  if (!errors.length) return undefined;
  const grouped = new Map<string, RepairPacketIssue>();
  for (const issue of errors) {
    const oldText = uniqueRepairOldText(text, issue);
    const key = oldText ? `text:${oldText}` : `issue:${issue.id}`;
    const existing = grouped.get(key);
    if (existing) {
      const relatedIssueIds = [...new Set([existing.id, ...(existing.relatedIssueIds ?? []), issue.id])];
      existing.relatedIssueIds = relatedIssueIds;
      if (!existing.suggestion && issue.suggestions[0]) existing.suggestion = issue.suggestions[0];
      continue;
    }
    grouped.set(key, {
      id: issue.id,
      kind: `${issue.kind}:${issue.subtype}`,
      line: issue.line,
      ...(oldText ? { oldText } : {}),
      ...(issue.evidence ? { evidence: issue.evidence } : {}),
      suggestion: issue.suggestions[0] ?? rewriteTipForSubtype(issue.subtype),
      problem: issue.reason,
      ...(issue.policyId ? { policyId: issue.policyId } : {}),
      ...(issue.policyVersion ? { policyVersion: issue.policyVersion } : {}),
      ...(issue.skillId ? { skillId: issue.skillId } : {}),
    });
  }
  return boundedRepairPacket({
    ...(source?.path ? { path: source.path } : {}),
    ...(source?.sourceHash ? { sourceHash: source.sourceHash } : {}),
    issueCount: errors.length,
    issues: [...grouped.values()],
  });
}

function uniqueRepairOldText(text: string, issue: ProseStyleIssue): string | undefined {
  const sentence = issue.sentence.trim();
  if (sentence && sentence.length <= 1_200 && occurrencesOf(text, sentence) === 1) return sentence;
  const lineStart = text.lastIndexOf("\n", Math.max(0, issue.start - 1)) + 1;
  const lineEnd = text.indexOf("\n", issue.end);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim();
  return line && line.length <= 1_200 && occurrencesOf(text, line) === 1 ? line : undefined;
}

function occurrencesOf(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = text.indexOf(needle);
  while (offset >= 0) {
    count += 1;
    if (count > 1) return count;
    offset = text.indexOf(needle, offset + needle.length);
  }
  return count;
}

/** Actionable block message so one local rewrite can pass re-submit. */
function formatProseStyleBlockError(errors: ProseStyleIssue[], headline: string): string {
  const located = errors.slice(0, 20).map(issue => {
    const tip = issue.suggestions[0] ?? rewriteTipForSubtype(issue.subtype);
    return `第${issue.line}行「${issue.evidence}」→ ${tip}`;
  });
  const learnedOnly = errors.every(issue => issue.subtype === "learned_rule");
  return `${headline}（${errors.length}处硬拦截）：${located.join("；")}。` +
    (learnedOnly
      ? "只按规则精确修正命中句，勿全文重写。"
      : "只改命中句，勿全文重写。保留：对白拖音/中断/迟疑、口语纠正、偶发停顿—揭示与短同位。配方：删「——因为/也就是」类补注；抽象「不是…而是」改成直接事实或人物行动。");
}

function rewriteTipForSubtype(subtype: ProseStyleSubtype): string {
  switch (subtype) {
    case "parenthetical_explanation":
      return "去掉成对夹注，改成一句完整叙述或拆成两句";
    case "cause_or_judgment":
      return "删破折号后的因果/定义，只留结果；因果拆下一句";
    case "abstract_reframing":
    case "split_redefinition":
    case "narrator_redefinition":
      return "保留节奏、意象和信息落点，重组命中句及紧邻一句，让动作、感受、视线变化或结果自然显出成立事实";
    case "semantic_echo":
      return "若前文证据已经充分，删除重复解释；否则只保留新增事实";
    case "emotion_label":
      return "避免在动作之后重复命名情绪，保留会改变后续行动的部分";
    case "intent_translation":
      return "不要替对白或动作翻译意图，让后续选择呈现人物目的";
    case "thematic_summary":
      return "删去即时总结，让意义由场景后果或后续回收形成";
    case "causal_gloss":
      return "必要因果写成新事实；若只是复述前文则删除";
    case "learned_rule":
      return "按作者沉淀的项目复审规则做最小修正";
    default:
      return "改成可观察动作或独立句，去掉说明体";
  }
}

function scanDashes(text: string): ProseStyleIssue[] {
  const issues: ProseStyleIssue[] = [];
  const matches = collectMatches(text, DASH_UNIT);
  const consumed = new Set<number>();
  for (let i = 0; i < matches.length; i += 1) {
    if (consumed.has(i)) continue;
    const match = matches[i];
    const bounds = sentenceBounds(text, match.start);
    const next = matches[i + 1];
    const lineText = text.slice(text.lastIndexOf("\n", match.start - 1) + 1, lineEnd(text, match.start));
    const insideQuote = quoteDepthAt(text, match.start) > 0;
    const after = text.slice(match.end, bounds.end).trim();

    // Markdown tables and structural lines: never treat as explanatory prose dashes.
    if (
      isMetadataLine(lineText)
      || isMarkdownTableLine(lineText)
      || insideFullwidthBracket(text, match.start)
      || isNumericRange(text, match)
    ) {
      issues.push(makeIssue(text, match, "dash", "system_or_metadata", "info", 0.99,
        "标题、列表、表格、系统提示或数值连接中的符号，不属于说明体。", []));
      continue;
    }

    // 列举链：头——脚——手 / 春——夏——秋——冬（短项并列，不是夹注说明）
    const enumRun = enumerationDashRun(text, matches, i, bounds);
    if (enumRun) {
      for (let k = i; k <= enumRun.lastIndex; k += 1) consumed.add(k);
      issues.push(makeIssue(text, {
        start: matches[i].start,
        end: matches[enumRun.lastIndex].end,
        text: text.slice(matches[i].start, matches[enumRun.lastIndex].end),
      }, "dash", "system_or_metadata", "info", 0.97,
        "并列列举用破折号连接短项，不属于说明体。", []));
      continue;
    }

    if (insideQuote) {
      const prevChar = previousHan(text, match.start);
      const nextChar = nextHan(text, match.end);
      const closesSoon = /^[\s。！？!?…]*[」』”’"']/u.test(text.slice(match.end));
      if (prevChar && nextChar && prevChar === nextChar) {
        issues.push(makeIssue(text, match, "dash", "speech_hesitation", "info", 0.98,
          "破折号位于对白内部并连接重复音节，表示迟疑或结巴。", []));
      } else if ((prevChar && SOUND_OR_INTERJECTION.test(prevChar)) || closesSoon) {
        issues.push(makeIssue(text, match, "dash", closesSoon ? "speech_interruption" : "speech_extension", "info", 0.94,
          "破折号位于对白内部，表示声音延长或话语中断。", []));
      } else if (EXPLANATION_SIGNALS.test(after)) {
        // 对白内解释：仅 warning，置信度不入硬拦截池（0.78 < 0.9）
        issues.push(makeIssue(text, match, "dash", "cause_or_judgment", "warning", 0.78,
          "虽在对白中，后半句仍以解释信号重新说明前半句。", commonSuggestions()));
      } else {
        issues.push(makeIssue(text, match, "dash", "speech_extension", "info", 0.72,
          "破折号处于对白内部，优先视为拖音、停顿或语气变化。", []));
      }
      continue;
    }

    if (next && next.start < bounds.end) {
      consumed.add(i + 1);
      // 成对夹注：保留 warning，置信 0.9 可入硬池，但需过密才 error
      issues.push(makeIssue(text, { start: match.start, end: next.end, text: text.slice(match.start, next.end) },
        "dash", "parenthetical_explanation", "warning", 0.9,
        "成对破折号包围插入说明；偶发可用，过密时再考虑拆句。", commonSuggestions()));
      continue;
    }

    if (EXPLANATION_SIGNALS.test(after)) {
      issues.push(makeIssue(text, match, "dash", "cause_or_judgment", "warning", 0.9,
        "后半句以因果/定义信号补充前半句；单次常见于叙事，过密时再改。", commonSuggestions()));
      continue;
    }

    // 停顿—揭示、同位、短接续：正常文学手法，不进硬拦截池
    if (after.length > 0 && after.length <= 24 && /[是为叫称]|(?:一种|一个|一名)/u.test(after)) {
      issues.push(makeIssue(text, match, "dash", "appositive_definition", "info", 0.7,
        "短接续更像同位或命名，属常见叙事手法，不拦截。", []));
      continue;
    }

    issues.push(makeIssue(text, match, "dash", "ambiguous_dash", "info", 0.55,
      "叙述中的破折号（停顿、转折或揭示）默认允许；仅在 audit 时供人工复核。", []));
  }
  return issues;
}

function scanRegisteredConstructions(text: string): ProseStyleIssue[] {
  const issues: ProseStyleIssue[] = [];
  for (const match of findProseConstructionMatches(text)) {
    const bounds = sentenceBounds(text, match.start);
    const endBounds = sentenceBounds(text, Math.max(match.start, match.end - 1));
    const sentence = text.slice(bounds.start, Math.max(bounds.end, endBounds.end)).trim();
    const semanticPivot = match.text.search(/(?:不是|并非|没有|与其|不在于|不能|算不上|谈不上|称不上)/u);
    const classification = match.rule.classify({
      text,
      matchedText: match.text,
      start: match.start,
      end: match.end,
      sentence,
      sentenceStart: bounds.start,
      // Broad patterns may start at a closing quote before the actual negation
      // (e.g. `"台词。"她说，不是对同伴说的`). Test quote state at
      // the construction pivot, not at the evidence-window start.
      inQuote: quoteDepthAt(text, match.start + Math.max(0, semanticPivot)) > 0,
    });
    issues.push(makeIssue(
      text,
      match,
      "contrast",
      classification.subtype,
      classification.severity,
      classification.confidence,
      classification.reason,
      classification.suggestions,
      match.rule.id,
    ));
    issues.at(-1)!.countsTowardFamilyBudget = true;
  }
  return issues;
}

/** Older broad contrast candidates remain advisory until migrated into a semantic rule. */
function scanLegacyContrasts(text: string): ProseStyleIssue[] {
  const issues: ProseStyleIssue[] = [];
  for (const match of collectMatches(text, ...LEGACY_CONTRAST_PATTERNS)) {
    const inQuote = quoteDepthAt(text, match.start) > 0;
    if (inQuote) {
      issues.push(makeIssue(text, match, "contrast", "dialogue_correction", "info", 0.88,
        "结构位于对白中，优先视为人物纠正事实或反驳误解。", []));
      continue;
    }
    issues.push(makeIssue(text, match, "contrast", "factual_exclusion", "warning", 0.88,
      "对照结构可能用于归纳意义；单次只作候选，密集时再结合上下文复核。",
      ["若没有增加信息，直接陈述真正成立的事实"]));
  }
  return issues;
}

/**
 * High-recall candidates for explanatory voice beyond punctuation/templates.
 * These remain sub-threshold warnings until a context pass confirms redundancy.
 */
function scanExplanationCandidates(text: string): ProseStyleIssue[] {
  const issues: ProseStyleIssue[] = [];
  const sentences = sentenceRanges(text);
  for (let index = 0; index < sentences.length; index += 1) {
    const current = sentences[index];
    const rawBody = current.text.trim();
    const body = rawBody.replace(/^[“「『"']+/u, "");
    if (!body || /^[“「『"']/u.test(rawBody) || quoteDepthAt(text, current.start) > 0 || isMetadataLine(body)) continue;
    const category = explanationCategory(body);
    if (!category) continue;

    const previous = sentences[index - 1];
    const adjacent = previous && sameParagraph(text, previous.end, current.start);
    const echoLike = adjacent && (
      EXPLANATORY_ANAPHORA.test(body)
      || INTENT_TRANSLATION.test(body)
      || EMOTION_LABEL.test(body)
      || CAUSAL_GLOSS.test(body)
    );
    const subtype: ProseStyleSubtype = echoLike ? "semantic_echo" : category;
    const confidence = echoLike ? 0.88 : 0.78;
    const reason = echoLike
      ? "当前句紧跟前句并显式命名其情绪、意图、因果或意义，可能只是重复读者已经能推断的信息。"
      : explanationReason(category);
    issues.push(makeIssue(text, current, "explanation", subtype, "warning", confidence, reason, [
      "先判断该句是否增加新事实；没有则删除",
      "必要信息保留为事实、行动条件或后果，不要只给抽象结论",
    ]));
  }
  return issues;
}

function explanationCategory(sentence: string): ProseStyleSubtype | undefined {
  if (EXPLANATORY_ANAPHORA.test(sentence) || NARRATOR_REDEFINITION.test(sentence)) return "narrator_redefinition";
  if (THEMATIC_SUMMARY.test(sentence)) return "thematic_summary";
  if (INTENT_TRANSLATION.test(sentence)) return "intent_translation";
  if (EMOTION_LABEL.test(sentence)) return "emotion_label";
  if (CAUSAL_GLOSS.test(sentence)) return "causal_gloss";
  return undefined;
}

function explanationReason(subtype: ProseStyleSubtype): string {
  switch (subtype) {
    case "narrator_redefinition": return "叙述者显式重述刚发生之事的意义，需结合上下文判断是否增加信息。";
    case "thematic_summary": return "句子即时总结场景主题或成长意义，可能提前替读者完成判断。";
    case "intent_translation": return "句子直接翻译人物动作或对白的真实意图，可能形成解释回声。";
    case "emotion_label": return "句子显式命名人物情绪或认知，需检查前文是否已经充分呈现。";
    case "causal_gloss": return "句子追加因果说明，需区分必要新事实与重复补注。";
    default: return "句子带有显式解释信号，需结合上下文复核。";
  }
}

function makeIssue(text: string, range: MatchRange, kind: ProseStyleIssue["kind"], subtype: ProseStyleSubtype,
  severity: ProseStyleSeverity, confidence: number, reason: string, suggestions: string[], constructionRuleId?: string): ProseStyleIssue {
  const bounds = sentenceBounds(text, range.start);
  const endBounds = sentenceBounds(text, Math.max(range.start, range.end - 1));
  const sentence = text.slice(bounds.start, Math.max(bounds.end, endBounds.end)).trim();
  const { line, column } = lineColumn(text, range.start);
  const evidence = sentence.length <= 90 ? sentence : `${sentence.slice(0, 87)}…`;
  return {
    id: `${kind}:${subtype}:${range.start}`, kind, subtype, severity, confidence,
    start: range.start, end: range.end, line, column, sentence, evidence, reason, suggestions,
    ...(constructionRuleId ? { constructionRuleId } : {}),
  };
}

function sentenceRanges(text: string): MatchRange[] {
  const ranges: MatchRange[] = [];
  const pattern = /[^。！？!?\n]+[。！？!?]?/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const leading = raw.search(/\S/u);
    if (leading < 0) continue;
    const start = (match.index ?? 0) + leading;
    const value = raw.slice(leading).trimEnd();
    ranges.push({ start, end: start + value.length, text: value });
  }
  return ranges;
}

function sameParagraph(text: string, leftEnd: number, rightStart: number): boolean {
  return !/\n\s*\n/u.test(text.slice(leftEnd, rightStart));
}

function collectMatches(text: string, ...patterns: RegExp[]): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0, end = start + match[0].length;
      if (!ranges.some(range => start < range.end && end > range.start)) ranges.push({ start, end, text: match[0] });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function sentenceBounds(text: string, index: number): { start: number; end: number } {
  const before = text.slice(0, index);
  const boundary = Math.max(before.lastIndexOf("。"), before.lastIndexOf("！"), before.lastIndexOf("？"), before.lastIndexOf("\n"));
  const rest = text.slice(index);
  const match = /[。！？!?\n]/u.exec(rest);
  return { start: boundary + 1, end: match ? index + match.index + 1 : text.length };
}
function lineEnd(text: string, index: number): number { const end = text.indexOf("\n", index); return end < 0 ? text.length : end; }
function lineColumn(text: string, index: number): { line: number; column: number } {
  const prefix = text.slice(0, index), last = prefix.lastIndexOf("\n");
  return { line: prefix.split("\n").length, column: index - last };
}
function quoteDepthAt(text: string, index: number): number {
  const stack: string[] = [];
  const pairs: Record<string, string> = { "「": "」", "『": "』", "“": "”", "‘": "’" };
  for (let i = 0; i < index; i += 1) {
    const char = text[i];
    if (pairs[char]) stack.push(pairs[char]);
    else if (stack.at(-1) === char) stack.pop();
    else if (char === '"') stack.at(-1) === '"' ? stack.pop() : stack.push('"');
  }
  return stack.length;
}
function insideFullwidthBracket(text: string, index: number): boolean {
  const start = text.lastIndexOf("【", index), end = text.lastIndexOf("】", index);
  return start > end && text.indexOf("】", index) >= 0;
}
function isMetadataLine(line: string): boolean { return /^\s*(?:#{1,6}\s|[-*+]\s|---+\s*$|——\s*\S+\s*$)/u.test(line); }

/** GFM/Markdown table rows and alignment separators (often full of --- / ——). */
function isMarkdownTableLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Classic pipe table row: | a | b |  or leading/trailing pipe variants
  if (/^\|.*\|$/.test(t)) return true;
  // Alignment / separator: |---|:---| or ---|--- without requiring outer pipes
  if (/^:?-{2,}:?(\s*\|\s*:?-{2,}:?)+$/.test(t)) return true;
  if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(t)) return true;
  // At least two cell dividers (a | b | c) — common loose tables without outer pipes
  const pipes = t.match(/\|/g);
  if (pipes && pipes.length >= 2 && !/^「|^『|^"|^'/.test(t)) return true;
  return false;
}

/**
 * Parallel short-item dash lists: 头——脚——手 / 春——夏——秋——冬.
 * Requires ≥2 dash connectors and every segment short (avoids 这件事——说得不客气些——实在).
 */
function enumerationDashRun(
  text: string,
  matches: MatchRange[],
  start: number,
  bounds: { start: number; end: number },
): { lastIndex: number } | undefined {
  // Gather consecutive dash matches inside this sentence starting at `start`.
  let last = start;
  while (last + 1 < matches.length && matches[last + 1].start < bounds.end) last += 1;
  const runCount = last - start + 1;
  if (runCount < 2) return undefined;

  const parts: string[] = [];
  // Left of first dash within the sentence (trim leading clause punctuation)
  let left = text.slice(bounds.start, matches[start].start).trim();
  left = left.replace(/^.*[，,、；;：:\s]/u, "").trim();
  parts.push(left);
  for (let k = start; k <= last; k += 1) {
    const segEnd = k < last ? matches[k + 1].start : bounds.end;
    let seg = text.slice(matches[k].end, segEnd).trim();
    seg = seg.replace(/[。！？!?…]+$/u, "").trim();
    // Rightmost segment: drop trailing clause after short token if any long tail
    if (k === last) seg = seg.replace(/[，,、；;].*$/u, "").trim();
    parts.push(seg);
  }
  // ≥3 short parallel tokens (2 dashes) or more
  if (parts.length < 3) return undefined;
  if (!parts.every(isShortEnumToken)) return undefined;
  return { lastIndex: last };
}

function isShortEnumToken(segment: string): boolean {
  const t = segment.trim();
  if (!t) return false;
  // Use code-point length so CJK counts as 1 each
  const len = [...t].length;
  if (len > 4) return false;
  if (EXPLANATION_SIGNALS.test(t)) return false;
  // Parenthetical middles often have 得/地/的 + verb-ish; allow pure nouns/names only
  if (/[因为由于意味着也就是或者说]/.test(t)) return false;
  // Keep tokens noun/number-like; reject clause fragments
  if (!/^[\p{Script=Han}A-Za-z0-9·、/／]+$/u.test(t)) return false;
  return true;
}

function isNumericRange(text: string, range: MatchRange): boolean { return /\d/u.test(text[range.start - 1] ?? "") && /\d/u.test(text[range.end] ?? ""); }
function previousHan(text: string, index: number): string { return text.slice(0, index).match(/[\p{Script=Han}A-Za-z]$/u)?.[0] ?? ""; }
function nextHan(text: string, index: number): string { return text.slice(index).match(/^[\s，、]*(?:([\p{Script=Han}A-Za-z]))/u)?.[1] ?? ""; }
function commonSuggestions(): string[] { return ["删除重复说明，只保留可观察结果", "用动作或感官细节承载信息", "因果不可省略时拆成两个独立句"]; }
function issueFingerprint(issue: ProseStyleIssue): string {
  return `${issue.kind}:${issue.subtype}:${issue.sentence.replace(/\s+/g, "").slice(0, 120)}`;
}
