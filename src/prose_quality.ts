export type ProseStyleSeverity = "error" | "warning" | "info";
export type ProseStyleSubtype =
  | "speech_extension" | "speech_interruption" | "speech_hesitation"
  | "system_or_metadata" | "parenthetical_explanation" | "appositive_definition"
  | "cause_or_judgment" | "ambiguous_dash"
  | "narrator_redefinition" | "abstract_reframing" | "split_redefinition" | "dialogue_correction" | "factual_exclusion"
  | "semantic_echo" | "emotion_label" | "intent_translation" | "thematic_summary" | "causal_gloss";

export interface ProseStyleIssue {
  id: string;
  kind: "dash" | "contrast" | "explanation";
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
const CONTRAST_PATTERNS = [
  /(?:并)?不是[^\n。！？!?]{0,48}(?:而|却|只)?是/gu,
  /(?:并)?不是[^\n。！？!?]{1,48}[。！？!?]\s*(?:(?:这|那|他|她|它|其|自己|真正|实际|反而|却|只)\s*)?是[^\n。！？!?]{1,48}(?:[。！？!?]|$)/gu,
  /并非[^\n。！？!?]{0,48}(?:而|却|只)?是/gu,
  /与其(?:说)?[^\n。！？!?]{0,48}不如(?:说)?/gu,
  /没有[^\n。！？!?]{0,40}只有/gu,
  /不在于[^\n。！？!?]{0,40}而在于/gu,
  /(?:仿佛|好像)[^\n。！？!?]{0,36}又(?:仿佛|好像)/gu,
];
/** 仅高教学/解释口吻；日常叙事里「这/那/原来/仿佛」后接破折号很常见，不计入硬说明信号。 */
const EXPLANATION_SIGNALS = /^(?:因为|由于|意味着|也就是|换句话说|其实|显然|说明|证明|正是|即|不过是)/u;
const ABSTRACT_WORDS = /(?:情绪|愤怒|恐惧|悲伤|沉默|妥协|失败|成功|反抗|勇气|希望|绝望|灵魂|命运|意义|感觉|姿态|态度|选择|真相)/u;
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
  "narrator_redefinition",
  "semantic_echo",
  "emotion_label",
  "intent_translation",
  "thematic_summary",
  "causal_gloss",
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
  if (subtype === "abstract_reframing" || subtype === "split_redefinition" || subtype === "narrator_redefinition") return "contrast";
  return "explanation";
}

/**
 * A repeated sentence frame becomes noticeable before unrelated mannerisms do.
 * Keep dashes comparatively permissive, but stop two or three abstract
 * negation/redefinition or explanatory-echo frames from hiding under one shared
 * chapter-wide allowance.
 */
function hardMannerismFamilyLimit(text: string, family: "dash" | "contrast" | "explanation"): number {
  const characters = Math.max(1, text.replace(/\s/g, "").length);
  if (family === "contrast") return Math.max(1, Math.floor(characters / 3_000));
  if (family === "explanation") return Math.max(2, 1 + Math.floor(characters / 2_500));
  return hardMannerismLimit(text);
}

/**
 * Generation-time constraints (constraint-first).
 * Inject into system prompts before the model writes, so fewer proposals fail the final gate.
 * Specific negatives + rewrite recipes outperform vague “avoid dashes”.
 * Latest chapter telemetry: hard blocks are dominated by split_redefinition
 * (“不是A。是B。” short-frame stacks) — suppress that pattern at generation time.
 */
export function proseMannerismConstraintPrompt(options?: { compact?: boolean }): string {
  if (options?.compact) {
    return [
      "句式硬约束（生成时遵守，减少返工；终审会机器拦截过密说明体）：",
      "1. 叙述禁止把「不是A。是B。」「不是A——是B」当节奏模板连写；一整场最多偶发 1 次，优先直接写成立事实（坏例：不是埋伏。是逃跑。→ 好例：这是逃跑路线。/ 他们在撤）。",
      "2. 叙述少用破折号做「画面——解释 / 因果补注 / 成对夹注」；优先句号拆句，或把说明改成可观察动作/细节。",
      "3. 动作、对白或细节已经传达情绪/意图时，不再追加「这说明…」「他显然感到…」「真正重要的是…」等解释回声。",
      "4. 允许：对白拖音/中断/迟疑；人物口语纠正（「不是老周，是他儿子」）；并列列举；Markdown 表格；偶发停顿—揭示与短同位。",
      "5. 禁止堆砌：同一段落/相邻句反复否定—肯定、因果补注、情绪标签或主题总结。",
    ].join("\n");
  }
  return `句式与符号约束（生成阶段强制遵守；终审会机器抽查过密说明体）

【最高频硬拦：拆句重定义「不是A。是B。」】
- 叙述禁止用句号/破折号把同一否定—肯定框架拆成两截当顿挫节奏：不是埋伏。是逃跑。 / 不是检查伤势。是放在那里。 / 能听见…——不是呼吸。是散热。
- 密度：单场正文最多偶发 1 次；一章内不得成串出现。需要纠正误解时，改写为直接事实或交给人物对白。
- 改写配方：删掉「不是…」前半，只保留真正成立的后半；或并成一句客观陈述（「这是逃跑」「手掌贴在那里」）。

【破折号 —— / --】
- 默认策略：叙述中优先不用破折号做补充说明。写成「动作。结果。」或「细节供读者判断」，不要「动作——因为/也就是/意味着…」。
- 禁止高频：成对夹注（A——插入说明——B）、句中「画面——解释」。
- 允许保留：对白内拖音/中断/迟疑（「你——你说什么」）；标题/列表/数值区间；Markdown 表格分隔；并列列举（头——脚——手）；偶发停顿后揭示或短同位（桌上只剩钥匙——一把黄铜的）。
- 改写配方：删破折号后半句的解释，只留可观察结果；因果不可省则拆成下一句独立句。

【其它「不是…是…」类模板】
- 叙述少用：不是A而是B / 并非…而是 / 与其说…不如 / 没有…只有 / 不在于…而在于（尤其「这/那不是情绪，而是意义」式抽象重定义）。
- 允许：对白里纠正事实；客观事实排除写清即可，勿叠抽象标签。
- 改写配方：直接陈述真正成立的事实；若需纠正误解，改由人物行动或对白完成。

【解释回声】
- 动作、对白或细节已经足以传达情绪、意图、关系或主题时，不再追加「这说明…」「他显然感到…」「真正重要的是…」「直到此刻才明白…」。
- 必要的新因果、转场和时间概述可以直接写清；不要为了“展示”把所有信息改成身体反应。
- 改写配方：删去没有新信息的解释句；若含新事实，只保留事实、行动条件或后果。

【目标】
一次写对，避免提案被退回后整段重写。提交前快速扫：是否出现成串「不是A。是B。」、说明性破折号、解释回声。`;
}

/** One-line checklist for pre-submit self-check in task workflows. */
export function proseMannerismPreflightLine(): string {
  return "句式自检：有无成串「不是A。是B。」拆句重定义、说明性破折号/夹注，以及动作/对白后重复翻译情绪意图的解释回声；有则先改再提交。对白拖音、口语纠正和必要新事实可保留。";
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
  return formatProseStyleBlockError(errors, "本场说明式写法过密，尚未写入草稿");
}

/** Rule scan without density escalation (for pre-model packing). */
export function scanProseStyleIssues(text: string): ProseStyleIssue[] {
  return [...scanDashes(text), ...scanContrasts(text), ...scanExplanationCandidates(text)]
    .sort((a, b) => a.start - b.start);
}

/**
 * Re-apply density escalation after Flash demotions.
 * Resets prior error→warning on hard subtypes, then promotes when over limit.
 */
export function escalateHardMannerisms(text: string, issues: ProseStyleIssue[]): ProseStyleIssue[] {
  for (const issue of issues) {
    if (issue.severity === "error" && HARD_BLOCK_SUBTYPES.has(issue.subtype)) {
      issue.severity = "warning";
    }
  }
  const limit = hardMannerismLimit(text);
  const candidates = issues.filter(issue =>
    issue.severity === "warning"
    && issue.confidence >= 0.9
    && HARD_BLOCK_SUBTYPES.has(issue.subtype),
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
  return issues;
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
  const remaining = new Map<string, number>();
  for (const issue of analyzeProseStyle(before)) {
    const key = issueFingerprint(issue);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return analyzeProseStyle(after).filter(issue => {
    const key = issueFingerprint(issue);
    const count = remaining.get(key) ?? 0;
    if (count > 0) { remaining.set(key, count - 1); return false; }
    return true;
  });
}

/**
 * 提案硬拦截：只拦“新增且被升级为 error”的硬说明问题。
 * 普通 warning（含多数破折号）不拦截提交。
 */
export function proseStyleIssuesError(issues: ProseStyleIssue[]): string | undefined {
  const errors = issues.filter(issue =>
    (issue.severity === "error" && HARD_BLOCK_SUBTYPES.has(issue.subtype))
    || (issue.subtype === "split_redefinition" && issue.severity === "warning" && issue.confidence >= 0.95),
  );
  if (!errors.length) return undefined;
  return formatProseStyleBlockError(errors, "本次修改新增过密的高置信度说明式写法");
}

/** Actionable block message so one local rewrite can pass re-submit. */
function formatProseStyleBlockError(errors: ProseStyleIssue[], headline: string): string {
  const located = errors.slice(0, 20).map(issue => {
    const tip = issue.suggestions[0] ?? rewriteTipForSubtype(issue.subtype);
    return `第${issue.line}行「${issue.evidence}」→ ${tip}`;
  });
  return `${headline}（${errors.length}处硬拦截）：${located.join("；")}。` +
    "只改命中句，勿全文重写。保留：对白拖音/中断/迟疑、口语纠正、偶发停顿—揭示与短同位。配方：删「——因为/也就是」类补注；抽象「不是…而是」改成直接事实或人物行动。";
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
      return "去掉「不是A而是B」模板，直接写成立事实或落到行动/对白";
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

function scanContrasts(text: string): ProseStyleIssue[] {
  const issues: ProseStyleIssue[] = [];
  for (const match of collectMatches(text, ...CONTRAST_PATTERNS)) {
    const inQuote = quoteDepthAt(text, match.start) > 0;
    const bounds = sentenceBounds(text, match.start);
    const sentence = text.slice(bounds.start, bounds.end);
    if (inQuote) {
      issues.push(makeIssue(text, match, "contrast", "dialogue_correction", "info", 0.88,
        "结构位于对白中，优先视为人物纠正事实或反驳误解。", []));
      continue;
    }
    const split = /[。！？!?]\s*(?:(?:这|那|他|她|它|其|自己|真正|实际|反而|却|只)\s*)?是/u.test(match.text);
    if (split) {
      issues.push(makeIssue(text, match, "contrast", "split_redefinition", "warning", 0.92,
        "叙述者用句号拆开同一否定—肯定框架，容易形成刻意顿挫和机器化重定义；需结合语境区分必要事实澄清。",
        ["直接写真正成立的动作或事实", "若确需纠正误解，让人物通过对白或后续反应完成"]));
      continue;
    }
    const abstract = /(?:这|那|这种|这一切|他的|她的)/u.test(sentence.slice(0, Math.max(0, match.start - bounds.start + 8)))
      || ABSTRACT_WORDS.test(match.text);
    if (abstract) {
      // 抽象重定义：warning；置信 0.9 可入硬池，但需过密
      issues.push(makeIssue(text, match, "contrast", "abstract_reframing", "warning", 0.9,
        "叙述者先否定表象再定义抽象意义；偶发可用，过密时再改。",
        ["直接陈述真正成立的事实", "若确有误解需要纠正，把纠正落到人物行动或对白中"]));
    } else {
      // 事实排除（不是 A 而是 B）在叙事中极常见，仅 info
      issues.push(makeIssue(text, match, "contrast", "factual_exclusion", "info", 0.65,
        "否定—肯定结构更像事实排除或转折，默认允许。", []));
    }
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
  severity: ProseStyleSeverity, confidence: number, reason: string, suggestions: string[]): ProseStyleIssue {
  const bounds = sentenceBounds(text, range.start);
  const endBounds = sentenceBounds(text, Math.max(range.start, range.end - 1));
  const sentence = text.slice(bounds.start, Math.max(bounds.end, endBounds.end)).trim();
  const { line, column } = lineColumn(text, range.start);
  const evidence = sentence.length <= 90 ? sentence : `${sentence.slice(0, 87)}…`;
  return {
    id: `${kind}:${subtype}:${range.start}`, kind, subtype, severity, confidence,
    start: range.start, end: range.end, line, column, sentence, evidence, reason, suggestions,
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
