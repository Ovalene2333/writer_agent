export type ProseStyleSeverity = "error" | "warning" | "info";
export type ProseStyleSubtype =
  | "speech_extension" | "speech_interruption" | "speech_hesitation"
  | "system_or_metadata" | "parenthetical_explanation" | "appositive_definition"
  | "cause_or_judgment" | "ambiguous_dash"
  | "narrator_redefinition" | "abstract_reframing" | "dialogue_correction" | "factual_exclusion";

export interface ProseStyleIssue {
  id: string;
  kind: "dash" | "contrast";
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

/**
 * 仅这些子类在“过密”时可能升为 error（会拦截提案）。
 * 普通叙事破折号、同位说明、模糊破折号、事实排除只保留 warning/info。
 */
const HARD_BLOCK_SUBTYPES = new Set<ProseStyleSubtype>([
  "parenthetical_explanation",
  "cause_or_judgment",
  "abstract_reframing",
  "narrator_redefinition",
]);

/** Context-aware scanner for explanatory dashes and formulaic redefinition frames. */
export function analyzeProseStyle(text: string): ProseStyleIssue[] {
  const raw = [...scanDashes(text), ...scanContrasts(text)].sort((a, b) => a.start - b.start);
  const characters = Math.max(1, text.replace(/\s/g, "").length);
  // 高置信 + 硬说明子类 才进入升 error 池；阈值按正文长度放宽。
  const candidates = raw.filter(issue =>
    issue.severity === "warning"
    && issue.confidence >= 0.9
    && HARD_BLOCK_SUBTYPES.has(issue.subtype),
  );
  // 约每 2000 字允许 3 处硬说明习惯；至少 5 处才整体升级，避免短章两处破折号就卡死。
  const limit = Math.max(5, 3 + Math.floor(characters / 2_000));
  if (candidates.length > limit) {
    for (const issue of candidates) issue.severity = "error";
  }
  return raw;
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
  const located = errors.slice(0, 5).map(issue =>
    `第${issue.line}行${issue.column}列「${issue.evidence}」：${issue.reason}`,
  );
  return `正文中说明式写法过密（${errors.length}处硬拦截）：${located.join("；")}。` +
    "请只改命中句：保留事实和人物声线，优先让动作产生结果、用细节供读者判断，必要因果拆成独立句；对白中的延长、中断和真实纠正可以保留。叙事性破折号（停顿、揭示、同位）可保留。";
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
    issue.severity === "error" && HARD_BLOCK_SUBTYPES.has(issue.subtype),
  );
  if (!errors.length) return undefined;
  return `本次修改新增 ${errors.length} 处过密的高置信度说明式写法：` + errors.slice(0, 5)
    .map(issue => `第${issue.line}行「${issue.evidence}」`).join("；") +
    "。请局部改写命中句；普通叙事破折号与对白拖音不会拦截提交。";
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

    if (isMetadataLine(lineText) || insideFullwidthBracket(text, match.start) || isNumericRange(text, match)) {
      issues.push(makeIssue(text, match, "dash", "system_or_metadata", "info", 0.99,
        "标题、列表、系统提示或数值连接中的符号，不属于说明体。", []));
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

function makeIssue(text: string, range: MatchRange, kind: "dash" | "contrast", subtype: ProseStyleSubtype,
  severity: ProseStyleSeverity, confidence: number, reason: string, suggestions: string[]): ProseStyleIssue {
  const bounds = sentenceBounds(text, range.start);
  const sentence = text.slice(bounds.start, bounds.end).trim();
  const { line, column } = lineColumn(text, range.start);
  const evidence = sentence.length <= 90 ? sentence : `${sentence.slice(0, 87)}…`;
  return {
    id: `${kind}:${subtype}:${range.start}`, kind, subtype, severity, confidence,
    start: range.start, end: range.end, line, column, sentence, evidence, reason, suggestions,
  };
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
function isNumericRange(text: string, range: MatchRange): boolean { return /\d/u.test(text[range.start - 1] ?? "") && /\d/u.test(text[range.end] ?? ""); }
function previousHan(text: string, index: number): string { return text.slice(0, index).match(/[\p{Script=Han}A-Za-z]$/u)?.[0] ?? ""; }
function nextHan(text: string, index: number): string { return text.slice(index).match(/^[\s，、]*(?:([\p{Script=Han}A-Za-z]))/u)?.[1] ?? ""; }
function commonSuggestions(): string[] { return ["删除重复说明，只保留可观察结果", "用动作或感官细节承载信息", "因果不可省略时拆成两个独立句"]; }
function issueFingerprint(issue: ProseStyleIssue): string {
  return `${issue.kind}:${issue.subtype}:${issue.sentence.replace(/\s+/g, "").slice(0, 120)}`;
}
