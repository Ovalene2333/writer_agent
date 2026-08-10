/**
 * Chapter-level rhythm / reuse metrics (rules only, no model calls).
 *
 * prose_quality.ts guards "explanatory voice" mannerisms; this module measures the
 * complementary failure modes observed in generated chapters: verbatim self-copy,
 * cross-chapter sentence recycling, dash overload, negation-redefinition frames,
 * flat sentence rhythm, numeric-readout spam and monotone paragraph openings.
 *
 * Usage:
 * - analyzeChapterProseMetrics → every narrative submission through the shared
 *   validation layer. Only exact duplication/recycling errors block directly;
 *   density signals are evidence for semantic chapter review.
 * - findAdjacentDuplicateSentences → write_chapter_scene hard gate (AA-repeat bug).
 * - Metrics remain diagnostic inputs for final review; they are deliberately not
 *   fed back into prose-generation requests or used to select prose candidates.
 */

import { findProseConstructionMatches } from "./prose_construction_rules.js";
import { analyzeProseStyle } from "./prose_quality.js";

export type ChapterMetricSeverity = "error" | "warning";

export type ChapterMetricCode =
  | "adjacent_duplicate"
  | "verbatim_recycle"
  | "echo_dialogue"
  | "dash_density"
  | "contrast_density"
  | "sameness_frame"
  | "rhythm_flat"
  | "numeric_readout"
  | "opening_monotony";

export type ChapterMetricIssue = {
  code: ChapterMetricCode;
  severity: ChapterMetricSeverity;
  message: string;
  examples: string[];
  /** Complete deterministic matches; examples remain bounded for display. */
  occurrences?: string[];
};

export type ChapterRhythmStats = {
  characters: number;
  sentenceCount: number;
  meanSentenceLength: number;
  shortSentenceRatio: number;
  longSentenceRatio: number;
  /** Share of narrative sentences with ≤2 non-space chars (telegraph / 缩词). */
  microSentenceRatio: number;
  dashPer10k: number;
  contrastCount: number;
  contrastPer10k: number;
  samenessCount: number;
  numericPer10k: number;
  fragmentRuns: number;
};

export type ChapterProseMetrics = {
  stats: ChapterRhythmStats;
  issues: ChapterMetricIssue[];
};

/** Dash units per 10k non-space chars ("——" counts once). Reference: hand-written baseline ≈100–130. */
export const DASH_PER_10K_LIMIT = 150;
/** 否定—改判 family frames per 10k chars, dialogue included (skeleton monopoly flattens voices). */
export const CONTRAST_PER_10K_LIMIT = 4;
/** 「和X一样」 frames per 10k chars. */
export const SAMENESS_PER_10K_LIMIT = 12;
/** Numeric readouts (number+unit) per 10k chars. */
export const NUMERIC_PER_10K_LIMIT = 60;
/** Verbatim sentences shared with the prior chapter: more than this becomes a hard error. */
export const RECYCLE_ERROR_LIMIT = 5;
/** Adjacent identical dialogue paragraphs allowed per chapter before warning. */
export const ECHO_DIALOGUE_LIMIT = 1;
/** Narrative sentences ≥30 chars should stay above this ratio (with enough sentences to judge). */
export const LONG_SENTENCE_MIN_RATIO = 0.03;
/** Single 2-char paragraph-opening prefix share (non-dialogue paragraphs) before warning. */
export const OPENING_MONOTONY_RATIO = 0.35;

const DASH_UNIT = /(?:[—–―﹘]{1,2}|-{2})/gu;
const SAMENESS_FRAME = /和[^，。！？；、\n]{1,12}一样/gu;
const NUMERIC_READOUT =
  /(?:\d+(?:\.\d+)?|[零一二三四五六七八九十百千两]+(?:点[零一二三四五六七八九]+)?)\s*(?:秒|分钟|小时|毫米|厘米|米|公里|次|赫兹|分贝|度|克|公斤|吨|伏|瓦|％|%)/gu;
export function analyzeChapterProseMetrics(
  text: string,
  options?: { priorText?: string },
): ChapterProseMetrics {
  const body = stripStructuralLines(text);
  const characters = Math.max(1, body.replace(/\s/g, "").length);
  const per10k = (count: number) => Math.round((count / characters) * 10_000);
  const issues: ChapterMetricIssue[] = [];

  const duplicates = findAdjacentDuplicateSentences(body);
  if (duplicates.length) {
    issues.push({
      code: "adjacent_duplicate",
      severity: "error",
      message: `发现 ${duplicates.length} 处相邻逐字复读句（生成缺陷，零容忍）；用 revise_chapter_draft_style 把「S。S。」替换为单句。`,
      examples: duplicates.slice(0, 5),
      occurrences: duplicates,
    });
  }

  const echoes = findEchoDialogueParagraphs(body);
  if (echoes.length > ECHO_DIALOGUE_LIMIT) {
    issues.push({
      code: "echo_dialogue",
      severity: "warning",
      message: `回声对白（相邻两段完全相同的台词）出现 ${echoes.length} 组，同一装置一章最多 1 次，其余改为不同回应或沉默。`,
      examples: echoes.slice(0, 4),
      occurrences: echoes,
    });
  }

  const recycled = options?.priorText ? findRecycledSentences(body, options.priorText) : [];
  if (recycled.length) {
    const severity: ChapterMetricSeverity = recycled.length > RECYCLE_ERROR_LIMIT ? "error" : "warning";
    issues.push({
      code: "verbatim_recycle",
      severity,
      message: `${recycled.length} 个完整句子与既有正文逐字重合（上限 ${RECYCLE_ERROR_LIMIT}）；除刻意母题召回外须变形重写，不要回收旧章语料。`,
      examples: recycled.slice(0, 8),
      occurrences: recycled,
    });
  }

  const dashCount = countMatches(body, DASH_UNIT);
  const dashPer10k = per10k(dashCount);
  if (dashPer10k > DASH_PER_10K_LIMIT) {
    const dashOccurrences = splitSentences(body).filter(sentence => {
      DASH_UNIT.lastIndex = 0;
      return DASH_UNIT.test(sentence);
    });
    issues.push({
      code: "dash_density",
      severity: "warning",
      message: `破折号 ${dashPer10k}/万字（观察线 ${DASH_PER_10K_LIMIT}）；结合整章语义检查是否反复用破折号承担解释、补注或揭示，必要的对白拖音、中断和偶发重音可以保留。`,
      examples: dashOccurrences.slice(0, 8),
      occurrences: dashOccurrences,
    });
  }

  const contrastMatches = collectContrastFrames(body);
  const contrastPer10k = per10k(contrastMatches.length);
  if (contrastPer10k > CONTRAST_PER_10K_LIMIT) {
    issues.push({
      code: "contrast_density",
      severity: "warning",
      message: `否定—改判句式家族 ${contrastMatches.length} 次（${contrastPer10k}/万字，观察线 ${CONTRAST_PER_10K_LIMIT}/万字，对白与“没有A只有B”等衍生式一并计数）；结合整章语义判断是否已形成重复改判口吻，只保留确有排除、纠错或人物声线功能的实例。`,
      examples: contrastMatches.slice(0, 5),
      occurrences: contrastMatches,
    });
  }

  const samenessMatches = body.match(SAMENESS_FRAME) ?? [];
  const samenessPer10k = per10k(samenessMatches.length);
  if (samenessPer10k > SAMENESS_PER_10K_LIMIT) {
    const samenessOccurrences = dedupe(samenessMatches);
    issues.push({
      code: "sameness_frame",
      severity: "warning",
      message: `「和X一样」认证句 ${samenessMatches.length} 次（${samenessPer10k}/万字，上限 ${SAMENESS_PER_10K_LIMIT}/万字）；不必为每个动作援引先例。`,
      examples: samenessOccurrences.slice(0, 5),
      occurrences: samenessOccurrences,
    });
  }

  const numericCount = countMatches(body, NUMERIC_READOUT);
  const numericPer10k = per10k(numericCount);
  if (numericPer10k > NUMERIC_PER_10K_LIMIT) {
    const numericOccurrences = body.match(NUMERIC_READOUT) ?? [];
    issues.push({
      code: "numeric_readout",
      severity: "warning",
      message: `数值读数 ${numericPer10k}/万字（上限 ${NUMERIC_PER_10K_LIMIT}）；情绪与反应镜头改用比喻、动作或留白承载，同一数据源（心率/角度类）一章最多 3 次。`,
      examples: [],
      occurrences: numericOccurrences,
    });
  }

  const rhythm = narrativeRhythm(body);
  // Catch both classic flat-short chapters and the more common "telegraph"
  // voice: mean length still ~13–15 but short fragments dominate.
  const staccato =
    rhythm.sentenceCount >= 80
    && (
      (rhythm.longSentenceRatio < LONG_SENTENCE_MIN_RATIO && rhythm.meanSentenceLength < 14)
      || (rhythm.shortSentenceRatio >= 0.42 && rhythm.meanSentenceLength < 16)
      || (rhythm.fragmentRuns >= 8 && rhythm.shortSentenceRatio >= 0.35)
      || (rhythm.microSentenceRatio >= 0.08 && rhythm.shortSentenceRatio >= 0.30)
    );
  if (staccato) {
    const examples = collectShortSentenceExamples(body, 8);
    // Shape metrics locate a semantic rhythm risk; they do not prove that a
    // command, interruption or compressed scene is wrong. The Writer/reviewer
    // decides from prose context instead of rewriting toward numeric quotas.
    issues.push({
      code: "rhythm_flat",
      severity: "warning",
      message: formatRhythmFlatMessage(rhythm),
      examples,
    });
  }

  const monotony = openingMonotony(body);
  if (monotony && monotony.ratio > OPENING_MONOTONY_RATIO) {
    issues.push({
      code: "opening_monotony",
      severity: "warning",
      message: `非对白段落有 ${Math.round(monotony.ratio * 100)}% 以「${monotony.prefix}」起笔（上限 ${Math.round(OPENING_MONOTONY_RATIO * 100)}%）；段首在环境、动作、对白、心理之间轮换。`,
      examples: [],
    });
  }

  return {
    stats: {
      characters,
      sentenceCount: rhythm.sentenceCount,
      meanSentenceLength: rhythm.meanSentenceLength,
      shortSentenceRatio: rhythm.shortSentenceRatio,
      longSentenceRatio: rhythm.longSentenceRatio,
      microSentenceRatio: rhythm.microSentenceRatio,
      dashPer10k,
      contrastCount: contrastMatches.length,
      contrastPer10k,
      samenessCount: samenessMatches.length,
      numericPer10k,
      fragmentRuns: rhythm.fragmentRuns,
    },
    issues,
  };
}

/** Blocking message for exact deterministic errors only. Style density is advisory. */
export function chapterMetricsBlockError(metrics: ChapterProseMetrics): string | undefined {
  const errors = metrics.issues.filter(issue => issue.severity === "error");
  if (!errors.length) return undefined;
  const parts = errors.map(issue => {
    const examples = issue.examples.length ? `：${issue.examples.map(item => `「${clip(item, 40)}」`).join("、")}` : "";
    return `${issue.message}${examples}`;
  });
  return `章级确定性计量硬拦截（${parts.length} 类）：${parts.join("；")}`;
}

function formatRhythmFlatMessage(rhythm: {
  meanSentenceLength: number;
  longSentenceRatio: number;
  shortSentenceRatio: number;
  fragmentRuns: number;
  microSentenceRatio: number;
}): string {
  return `叙述句均长 ${rhythm.meanSentenceLength} 字、≥30 字长句仅 ${Math.round(rhythm.longSentenceRatio * 100)}%、≤6 字碎句 ${Math.round(rhythm.shortSentenceRatio * 100)}%、≤2 字电报句 ${Math.round(rhythm.microSentenceRatio * 100)}%、4 连发碎句串 ${rhythm.fragmentRuns} 处：全篇短促/缩词节拍。`;
}

function collectShortSentenceExamples(text: string, limit: number): string[] {
  const narrative = text.replace(/「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|"[^"\n]*"/gu, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentences(narrative)) {
    const trimmed = sentence.trim().replace(/^[」』”’"]+/u, "");
    const length = normalizeSentence(trimmed).length;
    if (length <= 0 || length > 6) continue;
    const key = normalizeSentence(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed.length <= 28 ? trimmed : `${trimmed.slice(0, 25)}…`);
    if (out.length >= limit) break;
  }
  return out;
}

/** Adjacent verbatim sentence repeats within one paragraph (the "S。S。" generation bug). */
export function findAdjacentDuplicateSentences(text: string): string[] {
  const found: string[] = [];
  for (const paragraph of paragraphs(text)) {
    const sentences = splitSentences(paragraph);
    for (let index = 0; index + 1 < sentences.length; index += 1) {
      const current = normalizeSentence(sentences[index]);
      if (current.length < 6) continue;
      if (current === normalizeSentence(sentences[index + 1])) found.push(sentences[index].trim());
    }
  }
  return dedupe(found);
}

/**
 * Mechanical auto-fix for the "S。S。" generation bug: drop adjacent verbatim
 * sentence repeats within a line, plus consecutive identical lines inside one
 * paragraph (blank-line-separated repeats — e.g. intentional dialogue echo — are
 * preserved). All other bytes pass through unchanged, so precise replacements
 * targeting untouched sentences still match.
 */
export function removeAdjacentDuplicateSentences(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  for (const line of lines) {
    const parts = line.split(/(?<=[。！？!?…])/u);
    const kept: string[] = [];
    for (const part of parts) {
      const normalized = normalizeSentence(part);
      const previous = kept.length ? normalizeSentence(kept[kept.length - 1]) : undefined;
      if (previous !== undefined && normalized.length >= 6 && normalized === previous) {
        removed.push(part.trim());
        continue;
      }
      kept.push(part);
    }
    const rebuilt = kept.join("");
    const previousLine = output.length ? output[output.length - 1] : undefined;
    if (
      previousLine !== undefined
      && previousLine.trim().length > 0
      && normalizeSentence(rebuilt).length >= 6
      && normalizeSentence(rebuilt) === normalizeSentence(previousLine)
    ) {
      removed.push(rebuilt.trim());
      continue;
    }
    output.push(rebuilt);
  }
  return { text: output.join("\n"), removed: dedupe(removed) };
}

/** Adjacent paragraphs that are the same quoted line (echo-dialogue device). */
export function findEchoDialogueParagraphs(text: string): string[] {
  const items = paragraphs(text);
  const found: string[] = [];
  for (let index = 0; index + 1 < items.length; index += 1) {
    const current = items[index].trim();
    if (!/^[「『“"]/u.test(current)) continue;
    if (normalizeSentence(current) === normalizeSentence(items[index + 1])) found.push(current);
  }
  return found;
}

/** Full sentences (≥8 chars, headings excluded) appearing verbatim in prior prose. */
export function findRecycledSentences(text: string, priorText: string): string[] {
  const prior = new Set(
    splitSentences(stripStructuralLines(priorText))
      .map(normalizeSentence)
      .filter(sentence => sentence.length >= 8),
  );
  if (!prior.size) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentences(text)) {
    const normalized = normalizeSentence(sentence);
    if (normalized.length < 8 || seen.has(normalized) || !prior.has(normalized)) continue;
    seen.add(normalized);
    found.push(sentence.trim().replace(/^[」』”’"]+/u, ""));
  }
  return found;
}

function narrativeRhythm(text: string): {
  sentenceCount: number;
  meanSentenceLength: number;
  shortSentenceRatio: number;
  longSentenceRatio: number;
  microSentenceRatio: number;
  fragmentRuns: number;
} {
  const narrative = text.replace(/「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|"[^"\n]*"/gu, "");
  const lengths = splitSentences(narrative).map(sentence => normalizeSentence(sentence).length).filter(length => length > 0);
  const total = lengths.length;
  if (!total) {
    return {
      sentenceCount: 0,
      meanSentenceLength: 0,
      shortSentenceRatio: 0,
      longSentenceRatio: 0,
      microSentenceRatio: 0,
      fragmentRuns: 0,
    };
  }
  const mean = Math.round((lengths.reduce((sum, length) => sum + length, 0) / total) * 10) / 10;
  const short = lengths.filter(length => length <= 6).length;
  const micro = lengths.filter(length => length <= 2).length;
  const long = lengths.filter(length => length >= 30).length;
  let fragmentRuns = 0;
  let run = 0;
  for (const length of lengths) {
    if (length <= 6) {
      run += 1;
    } else {
      if (run >= 4) fragmentRuns += 1;
      run = 0;
    }
  }
  if (run >= 4) fragmentRuns += 1;
  return {
    sentenceCount: total,
    meanSentenceLength: mean,
    shortSentenceRatio: short / total,
    longSentenceRatio: long / total,
    microSentenceRatio: micro / total,
    fragmentRuns,
  };
}

function openingMonotony(text: string): { prefix: string; ratio: number } | undefined {
  const counts = new Map<string, number>();
  let narrativeParagraphs = 0;
  for (const paragraph of paragraphs(text)) {
    const trimmed = paragraph.trim();
    if (!trimmed || /^[「『“"]/u.test(trimmed)) continue;
    narrativeParagraphs += 1;
    const prefix = [...trimmed.replace(/\s/g, "")].slice(0, 2).join("");
    if (prefix.length < 2) continue;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  if (narrativeParagraphs < 12) return undefined;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return undefined;
  return { prefix: top[0], ratio: top[1] / narrativeParagraphs };
}

function collectContrastFrames(text: string): string[] {
  return findProseConstructionMatches(text)
    .filter(match => match.rule.familyId === "negation_redefinition")
    .map(match => clip(match.text.trim(), 48));
}

function stripStructuralLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter(line => {
      const trimmed = line.trim();
      if (/^#{1,6}\s/.test(trimmed)) return false;
      if (/^---+\s*$/.test(trimmed)) return false;
      if (/^\|.*\|$/.test(trimmed)) return false;
      return true;
    })
    .join("\n");
}

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?…])|\n/u)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeSentence(value: string): string {
  return value.replace(/[\s。！？!?…，,、；;：:「」『』“”‘’]/gu, "");
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) count += 1;
  return count;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function clip(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("")}…`;
}
