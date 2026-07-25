/**
 * Chapter-level rhythm / reuse metrics (rules only, no model calls).
 *
 * prose_quality.ts guards "explanatory voice" mannerisms; this module measures the
 * complementary failure modes observed in generated chapters: verbatim self-copy,
 * cross-chapter sentence recycling, dash overload, negation-redefinition frames,
 * flat sentence rhythm, numeric-readout spam and monotone paragraph openings.
 *
 * Usage:
 * - analyzeChapterProseMetrics → inspect_chapter_draft (errors block, warnings ship
 *   as an actionable checklist).
 * - findAdjacentDuplicateSentences → write_chapter_scene hard gate (AA-repeat bug).
 * - sceneAntiFormulaFeedback / priorChapterNegativeList → zero-cost anti-self-imitation
 *   hints injected into scene-pipeline tool results (mirrors roleplay anti-formula slot).
 */

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
};

export type ChapterRhythmStats = {
  characters: number;
  sentenceCount: number;
  meanSentenceLength: number;
  shortSentenceRatio: number;
  longSentenceRatio: number;
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
/** 「不是A…是B」-family frames per 10k chars, dialogue included (skeleton monopoly flattens voices). */
export const CONTRAST_PER_10K_LIMIT = 8;
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
const CONTRAST_FRAMES = [
  /(?:并)?不是[^。！？!?\n]{0,24}(?:而是|——\s*是|—\s*是)/gu,
  /(?:并)?不是[^。！？!?\n]{0,24}[。！？!?]\s*(?:也?不是[^。！？!?\n]{0,24}[。！？!?]\s*)*是[^。！？!?\n]{0,32}/gu,
  /并非[^。！？!?\n]{0,24}(?:而是|——\s*是)/gu,
] as const;
/** Common micro-action / filler tokens that read templated when hammered (superset of roleplay GESTURE_RE). */
const MICRO_ACTION_LEXICON =
  /目光|眼神|视线|呼吸|嘴角|指尖|手指|攥紧|收紧|握拳|沉默|顿了|停顿|停了一下|抬眼|低头|偏头|皱眉|眯眼|肩膀|微微|轻轻|很轻|很细|然后/gu;

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
    });
  }

  const echoes = findEchoDialogueParagraphs(body);
  if (echoes.length > ECHO_DIALOGUE_LIMIT) {
    issues.push({
      code: "echo_dialogue",
      severity: "warning",
      message: `回声对白（相邻两段完全相同的台词）出现 ${echoes.length} 组，同一装置一章最多 1 次，其余改为不同回应或沉默。`,
      examples: echoes.slice(0, 4),
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
    });
  }

  const dashCount = countMatches(body, DASH_UNIT);
  const dashPer10k = per10k(dashCount);
  if (dashPer10k > DASH_PER_10K_LIMIT) {
    issues.push({
      code: "dash_density",
      severity: "warning",
      message: `破折号 ${dashPer10k}/万字（上限 ${DASH_PER_10K_LIMIT}）；它正在替代逗号、冒号和因果从句，把补注改写为完整句或直接删除。`,
      examples: [],
    });
  }

  const contrastMatches = collectContrastFrames(body);
  const contrastPer10k = per10k(contrastMatches.length);
  if (contrastPer10k > CONTRAST_PER_10K_LIMIT) {
    issues.push({
      code: "contrast_density",
      severity: "warning",
      message: `「不是A…是B」骨架 ${contrastMatches.length} 次（${contrastPer10k}/万字，上限 ${CONTRAST_PER_10K_LIMIT}/万字，对白一并计数）；叙述与多个人物共用同一骨架会抹平声口，改为直接陈述或各自的说话方式。`,
      examples: contrastMatches.slice(0, 5),
    });
  }

  const samenessMatches = body.match(SAMENESS_FRAME) ?? [];
  const samenessPer10k = per10k(samenessMatches.length);
  if (samenessPer10k > SAMENESS_PER_10K_LIMIT) {
    issues.push({
      code: "sameness_frame",
      severity: "warning",
      message: `「和X一样」认证句 ${samenessMatches.length} 次（${samenessPer10k}/万字，上限 ${SAMENESS_PER_10K_LIMIT}/万字）；不必为每个动作援引先例。`,
      examples: dedupe(samenessMatches).slice(0, 5),
    });
  }

  const numericCount = countMatches(body, NUMERIC_READOUT);
  const numericPer10k = per10k(numericCount);
  if (numericPer10k > NUMERIC_PER_10K_LIMIT) {
    issues.push({
      code: "numeric_readout",
      severity: "warning",
      message: `数值读数 ${numericPer10k}/万字（上限 ${NUMERIC_PER_10K_LIMIT}）；情绪与反应镜头改用比喻、动作或留白承载，同一数据源（心率/角度类）一章最多 3 次。`,
      examples: [],
    });
  }

  const rhythm = narrativeRhythm(body);
  if (
    rhythm.sentenceCount >= 150
    && rhythm.longSentenceRatio < LONG_SENTENCE_MIN_RATIO
    && rhythm.meanSentenceLength < 14
  ) {
    issues.push({
      code: "rhythm_flat",
      severity: "warning",
      message: `叙述句均长 ${rhythm.meanSentenceLength} 字、≥30 字长句仅 ${Math.round(rhythm.longSentenceRatio * 100)}%、≤6 字碎句 ${Math.round(rhythm.shortSentenceRatio * 100)}%、4 连发碎句串 ${rhythm.fragmentRuns} 处：全篇单一短促节拍。静场/情感段每 300 字至少给一个 35 字以上的绵延句换挡。`,
      examples: [],
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

/** Blocking message for metric errors only (warnings ship separately as checklist). */
export function chapterMetricsBlockError(metrics: ChapterProseMetrics): string | undefined {
  const errors = metrics.issues.filter(issue => issue.severity === "error");
  if (!errors.length) return undefined;
  const parts = errors.map(issue => {
    const examples = issue.examples.length ? `：${issue.examples.map(item => `「${clip(item, 40)}」`).join("、")}` : "";
    return `${issue.message}${examples}`;
  });
  return `章级复用计量硬拦截（${errors.length} 类）：${parts.join("；")}`;
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
    if (!/^[「『“]/u.test(current)) continue;
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
    found.push(sentence.trim().replace(/^[」』”’]+/u, ""));
  }
  return found;
}

/**
 * Anti-self-imitation feedback for the NEXT scene, computed from what the chapter
 * has accumulated so far. Pure string statistics — no model call, no state.
 */
export function sceneAntiFormulaFeedback(options: {
  chapterSoFar: string;
  priorChapterText?: string;
}): string[] {
  const body = stripStructuralLines(options.chapterSoFar);
  const characters = Math.max(1, body.replace(/\s/g, "").length);
  const per10k = (count: number) => Math.round((count / characters) * 10_000);
  const lines: string[] = [];

  const dashPer10k = per10k(countMatches(body, DASH_UNIT));
  const contrastCount = collectContrastFrames(body).length;
  const samenessCount = (body.match(SAMENESS_FRAME) ?? []).length;
  const numericPer10k = per10k(countMatches(body, NUMERIC_READOUT));
  const contrastBudget = Math.max(1, Math.round((CONTRAST_PER_10K_LIMIT * characters) / 10_000));
  lines.push(
    `本章至今：破折号 ${dashPer10k}/万字（上限 ${DASH_PER_10K_LIMIT}）；「不是A…是B」骨架 ${contrastCount} 次（全章额度约 ${contrastBudget}）；「和X一样」${samenessCount} 次；数值读数 ${numericPer10k}/万字（上限 ${NUMERIC_PER_10K_LIMIT}）。已超或将超的项在下一场必须压降。`,
  );

  const openings = repeatedParagraphOpenings(body, 3);
  if (openings.length) {
    lines.push(`下一场禁用段首起笔（本章已用 ≥3 次）：${openings.map(item => `「${item.prefix}」×${item.count}`).join("、")}。`);
  }

  const motifs = repeatedShortSentences(body, 3);
  if (motifs.length) {
    lines.push(`已用尽的母题句（下一场勿再逐字复用，需召回时变形）：${motifs.slice(0, 5).map(item => `「${item.sentence}」×${item.count}`).join("、")}。`);
  }

  const lexicon = overusedLexiconWords(body, 4);
  if (lexicon.length) {
    lines.push(`高频微动作/填充词，下一场尽量避开：${lexicon.slice(0, 8).map(item => `${item.word}×${item.count}`).join("、")}。`);
  }

  if (options.priorChapterText) {
    const recycled = findRecycledSentences(body, options.priorChapterText);
    if (recycled.length) {
      lines.push(`已与既有正文逐字重合 ${recycled.length} 句（如「${clip(recycled[0], 24)}」）；超过 ${RECYCLE_ERROR_LIMIT} 句将在终审硬拦，下一场禁止再回收旧章语料。`);
    }
  }

  return lines;
}

/**
 * Deterministic prose score for best-of-N scene candidate reranking (higher is
 * better, ~100 for clean prose). Purely rule-based so ranking is reproducible
 * and free; penalizes exactly the failure modes the chapter metrics measure,
 * with a small reward for long-sentence presence (rhythm shifting).
 */
export function sceneProseScore(text: string): number {
  const body = stripStructuralLines(text);
  const characters = Math.max(1, body.replace(/\s/g, "").length);
  const per10k = (count: number) => (count / characters) * 10_000;
  let score = 100;
  score -= Math.max(0, per10k(countMatches(body, DASH_UNIT)) - DASH_PER_10K_LIMIT) * 0.2;
  score -= Math.max(0, per10k(collectContrastFrames(body).length) - CONTRAST_PER_10K_LIMIT) * 2;
  score -= Math.max(0, per10k((body.match(SAMENESS_FRAME) ?? []).length) - SAMENESS_PER_10K_LIMIT) * 1.5;
  score -= Math.max(0, per10k(countMatches(body, NUMERIC_READOUT)) - NUMERIC_PER_10K_LIMIT) * 0.3;
  const rhythm = narrativeRhythm(body);
  score -= per10k(rhythm.fragmentRuns) * 1.2;
  if (rhythm.sentenceCount >= 20) {
    score -= Math.max(0, rhythm.shortSentenceRatio - 0.45) * 100;
    score += Math.min(0.08, rhythm.longSentenceRatio) * 150;
  }
  score -= findAdjacentDuplicateSentences(body).length * 40;
  score -= repeatedShortSentences(body, 3).length * 5;
  score -= analyzeProseStyle(body).filter(issue => issue.severity === "error").length * 25;
  return Math.round(score * 10) / 10;
}

/** Negative list from the previous chapter, injected once at begin_chapter_draft. */
export function priorChapterNegativeList(priorText: string): string[] {
  const body = stripStructuralLines(priorText);
  const lines: string[] = [];
  const signature = repeatedShortSentences(body, 2).slice(0, 6);
  if (signature.length) {
    lines.push(`上一章高频签名句（本章除刻意母题召回外避免逐字复用，召回需变形且最多 1 次）：${signature.map(item => `「${item.sentence}」×${item.count}`).join("、")}。`);
  }
  const openings = repeatedParagraphOpenings(body, 4).slice(0, 5);
  if (openings.length) {
    lines.push(`上一章高频段首：${openings.map(item => `「${item.prefix}」`).join("、")}；本章换用不同的开场形态。`);
  }
  const lexicon = overusedLexiconWords(body, 6).slice(0, 6);
  if (lexicon.length) {
    lines.push(`上一章高频微动作词：${lexicon.map(item => `${item.word}×${item.count}`).join("、")}；本章降低其密度或换具体动作。`);
  }
  return lines;
}

function repeatedParagraphOpenings(text: string, minCount: number): Array<{ prefix: string; count: number }> {
  const counts = new Map<string, number>();
  for (const paragraph of paragraphs(text)) {
    const trimmed = paragraph.trim();
    if (!trimmed || /^[「『“]/u.test(trimmed)) continue;
    const prefix = [...trimmed.replace(/\s/g, "")].slice(0, 2).join("");
    if (prefix.length < 2) continue;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([prefix, count]) => ({ prefix, count }));
}

function repeatedShortSentences(text: string, minCount: number): Array<{ sentence: string; count: number }> {
  const counts = new Map<string, { sentence: string; count: number }>();
  for (const sentence of splitSentences(text)) {
    const normalized = normalizeSentence(sentence);
    if (normalized.length < 4 || normalized.length > 20) continue;
    const entry = counts.get(normalized);
    if (entry) entry.count += 1;
    else counts.set(normalized, { sentence: sentence.trim(), count: 1 });
  }
  return [...counts.values()]
    .filter(entry => entry.count >= minCount)
    .sort((a, b) => b.count - a.count);
}

function overusedLexiconWords(text: string, minCount: number): Array<{ word: string; count: number }> {
  const counts = new Map<string, number>();
  MICRO_ACTION_LEXICON.lastIndex = 0;
  for (const match of text.matchAll(MICRO_ACTION_LEXICON)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => ({ word, count }));
}

function narrativeRhythm(text: string): {
  sentenceCount: number;
  meanSentenceLength: number;
  shortSentenceRatio: number;
  longSentenceRatio: number;
  fragmentRuns: number;
} {
  const narrative = text.replace(/「[^」\n]*」|『[^』\n]*』|“[^”\n]*”/gu, "");
  const lengths = splitSentences(narrative).map(sentence => normalizeSentence(sentence).length).filter(length => length > 0);
  const total = lengths.length;
  if (!total) return { sentenceCount: 0, meanSentenceLength: 0, shortSentenceRatio: 0, longSentenceRatio: 0, fragmentRuns: 0 };
  const mean = Math.round((lengths.reduce((sum, length) => sum + length, 0) / total) * 10) / 10;
  const short = lengths.filter(length => length <= 6).length;
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
    fragmentRuns,
  };
}

function openingMonotony(text: string): { prefix: string; ratio: number } | undefined {
  const counts = new Map<string, number>();
  let narrativeParagraphs = 0;
  for (const paragraph of paragraphs(text)) {
    const trimmed = paragraph.trim();
    if (!trimmed || /^[「『“]/u.test(trimmed)) continue;
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
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  for (const pattern of CONTRAST_FRAMES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (!ranges.some(range => start < range.end && end > range.start)) {
        ranges.push({ start, end, text: match[0] });
      }
    }
  }
  return ranges.sort((a, b) => a.start - b.start).map(range => clip(range.text.trim(), 48));
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
