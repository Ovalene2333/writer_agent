export interface ContrastStyleReport {
  count: number;
  allowed: number;
  examples: string[];
  dashCount: number;
  dashAllowed: number;
  frameCount: number;
}

/**
 * Formulaic “不是……而是……” style redefinition frames.
 * Patterns stop at sentence punctuation so cross-sentence “不是。是” is not counted.
 */
const CONTRAST_PATTERNS = [
  /(?:并)?不是[^\n。！？!?]{0,48}(?:而|却|只)?是/gu,
  /并非[^\n。！？!?]{0,48}(?:而|却|只)?是/gu,
  /与其(?:说)?[^\n。！？!?]{0,48}不如(?:说)?/gu,
  /没有[^\n。！？!?]{0,40}只有/gu,
  /不在于[^\n。！？!?]{0,40}而在于/gu,
  /(?:仿佛|好像)[^\n。！？!?]{0,36}又(?:仿佛|好像)/gu,
];

/** Chinese / ASCII em-dash units used as parenthetical asides. */
const DASH_UNIT = /(?:[—–―－]{1,2}|-{2})/g;

type MatchRange = { start: number; end: number; text: string };

function collectPatternMatches(text: string, patterns: RegExp[]): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const snippet = match[0];
      const start = match.index ?? 0;
      const end = start + snippet.length;
      if (ranges.some((range) => start < range.end && end > range.start)) continue;
      ranges.push({ start, end, text: snippet });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

/**
 * Mid-sentence em-dashes that append explanation, gloss, or elaboration.
 * Allowed exceptions:
 * - dialogue cut-off before a closing quote: 「我不是——」
 * - line-trailing dramatic pause with no same-line continuation: 而且——
 * - system / UI brackets: 【叮——万界最强系统已激活】
 */
function collectExplanatoryDashMatches(text: string): MatchRange[] {
  const ranges: MatchRange[] = [];
  DASH_UNIT.lastIndex = 0;
  for (const match of text.matchAll(DASH_UNIT)) {
    const start = match.index ?? 0;
    const dash = match[0];
    const afterStart = start + dash.length;
    const after = text.slice(afterStart);
    const before = text.slice(0, start);

    // Dialogue / quote cut-off: dash then closing quote.
    if (/^\s*[」』"'”’]/.test(after)) continue;

    // Trailing pause: nothing substantive on the same line after the dash.
    const sameLineRest = after.match(/^[^\n]*/)?.[0] ?? "";
    if (!/[^\s。！？!?…]/.test(sameLineRest)) continue;

    // System / UI text inside fullwidth brackets.
    if (/【[^】\n]{0,12}$/.test(before) && /^[^】\n]{0,60}】/.test(after)) continue;

    // Need at least a short gloss after the dash (skip lone punctuation).
    const afterClause = (after.match(/^[^\n。！？!?]{1,36}/)?.[0] ?? "").trim();
    if (afterClause.length < 1) continue;

    const beforeClause = (before.match(/[^\n。！？!?]{0,20}$/)?.[0] ?? "").trim();
    const snippet = `${beforeClause}${dash}${afterClause}`.slice(0, 48);
    const end = afterStart + Math.min(afterClause.length, 36);
    if (ranges.some((range) => start < range.end && end > range.start)) continue;
    ranges.push({ start, end, text: snippet });
  }
  return ranges;
}

function mergeRanges(a: MatchRange[], b: MatchRange[]): MatchRange[] {
  const all = [...a, ...b].sort((x, y) => x.start - y.start);
  const merged: MatchRange[] = [];
  for (const item of all) {
    if (merged.some((range) => item.start < range.end && item.end > range.start)) continue;
    merged.push(item);
  }
  return merged;
}

/** Detect formulaic contrast frames and explanatory mid-sentence em-dashes. */
export function contrastStyleReport(text: string): ContrastStyleReport {
  const frames = collectPatternMatches(text, CONTRAST_PATTERNS);
  const dashes = collectExplanatoryDashMatches(text);
  const merged = mergeRanges(frames, dashes);
  const characters = text.replace(/\s/g, "").length;
  // Contrast frames: ~1 / 4000 chars. Mid-sentence dash asides: nearly zero (~1 / 8000).
  const frameAllowed = Math.floor(characters / 4_000);
  const dashAllowed = Math.floor(characters / 8_000);
  const allowed = frameAllowed + dashAllowed;
  return {
    count: merged.length,
    allowed,
    examples: [...new Set(merged.map((item) => item.text))].slice(0, 5),
    dashCount: dashes.length,
    dashAllowed,
    frameCount: frames.length,
  };
}

export function contrastStyleError(text: string): string | undefined {
  const report = contrastStyleReport(text);
  const frameOk = report.frameCount <= Math.floor(text.replace(/\s/g, "").length / 4_000);
  const dashOk = report.dashCount <= report.dashAllowed;
  if (frameOk && dashOk) return undefined;

  const parts: string[] = [];
  if (!dashOk) {
    parts.push(
      `解释性破折号 ${report.dashCount} 处（最多 ${report.dashAllowed} 处）`,
    );
  }
  if (!frameOk) {
    const frameAllowed = Math.floor(text.replace(/\s/g, "").length / 4_000);
    parts.push(`对照句框架 ${report.frameCount} 处（最多 ${frameAllowed} 处）`);
  }
  return `正文中说明性写法过密（${parts.join("；")}）。命中示例：${report.examples.join("；")}。` +
    `请重写命中句：叙述里不要用“画面/动作——补充说明”的破折号结构，改为句号拆句或直接写可观察细节；` +
    `对白被打断可用“话没说完——」”。同时避免“不是……而是……”“不是……是……”等先否定再定义的框架。`;
}
