/**
 * Natural path / file-name ordering for writing projects.
 *
 * Plain localeCompare puts 第二章 / 第三章 / 第一章 in pinyin (or code-point)
 * order, not reading order. This comparator understands Arabic digit runs and
 * common Chinese numerals so chapter titles sort as 一 → 二 → … → 十 → 十一.
 */

const CN_DIGIT: Readonly<Record<string, number>> = {
  "零": 0,
  "〇": 0,
  "一": 1,
  "壹": 1,
  "二": 2,
  "贰": 2,
  "兩": 2,
  "两": 2,
  "三": 3,
  "叁": 3,
  "四": 4,
  "肆": 4,
  "五": 5,
  "伍": 5,
  "六": 6,
  "陆": 6,
  "七": 7,
  "柒": 7,
  "八": 8,
  "捌": 8,
  "九": 9,
  "玖": 9,
};

const CN_UNIT: Readonly<Record<string, number>> = {
  "十": 10,
  "拾": 10,
  "百": 100,
  "佰": 100,
  "千": 1000,
  "仟": 1000,
  "万": 10_000,
  "萬": 10_000,
};

const SEGMENT_RE = /(\d+)|([零〇一二两三兩叁四五六七八九壹贰肆伍陆柒捌玖十拾百佰千仟万萬]+)/gu;

type PathSegment =
  | { kind: "num"; value: number; raw: string }
  | { kind: "text"; value: string };

/** Parse a Chinese numeral phrase (一 / 十二 / 二十 / 一百零一 …). */
export function parseChineseNumeral(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  let total = 0;
  let current = 0;
  let sawDigit = false;
  let sawUnit = false;

  for (const ch of s) {
    if (Object.prototype.hasOwnProperty.call(CN_DIGIT, ch)) {
      current = CN_DIGIT[ch]!;
      sawDigit = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(CN_UNIT, ch)) {
      const unit = CN_UNIT[ch]!;
      sawUnit = true;
      // 「十」leading → 10; 「十二」→ 12
      if (current === 0 && unit === 10) current = 1;
      if (unit >= 10_000) {
        total = (total + current) * unit;
        current = 0;
      } else {
        total += current * unit;
        current = 0;
      }
      continue;
    }
    return null;
  }

  total += current;
  if (!sawDigit && !sawUnit) return null;
  return total;
}

function tokenizePathName(input: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let last = 0;
  for (const match of input.matchAll(SEGMENT_RE)) {
    const index = match.index ?? 0;
    if (index > last) {
      segments.push({ kind: "text", value: input.slice(last, index) });
    }
    const raw = match[0];
    if (match[1] != null) {
      const value = Number(raw);
      segments.push(Number.isFinite(value)
        ? { kind: "num", value, raw }
        : { kind: "text", value: raw });
    } else {
      const value = parseChineseNumeral(raw);
      segments.push(value != null
        ? { kind: "num", value, raw }
        : { kind: "text", value: raw });
    }
    last = index + raw.length;
  }
  if (last < input.length) {
    segments.push({ kind: "text", value: input.slice(last) });
  }
  if (!segments.length) segments.push({ kind: "text", value: input });
  return segments;
}

/**
 * Compare two path segments or bare file names for display / listDocuments order.
 * Directory separators are compared as text so full paths sort folder-wise first.
 */
export function comparePathNames(a: string, b: string, locales: string | string[] = "zh-CN"): number {
  if (a === b) return 0;
  const left = tokenizePathName(a);
  const right = tokenizePathName(b);
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const la = left[i];
    const rb = right[i];
    if (!la) return -1;
    if (!rb) return 1;
    if (la.kind === "num" && rb.kind === "num") {
      if (la.value !== rb.value) return la.value - rb.value;
      // Equal numeric value: shorter raw form first (2 before 02), then stable text.
      if (la.raw !== rb.raw) {
        if (la.raw.length !== rb.raw.length) return la.raw.length - rb.raw.length;
        const rawCmp = la.raw.localeCompare(rb.raw, locales, { numeric: true, sensitivity: "base" });
        if (rawCmp !== 0) return rawCmp;
      }
      continue;
    }
    if (la.kind === "num" && rb.kind === "text") {
      // Prefer numeric chapter tokens before leftover text at the same slot only when
      // both sides share the same preceding segments — fall back to string compare
      // of the original slice for mixed "2" vs "二" already handled as both num.
      const cmp = String(la.value).localeCompare(rb.value, locales, { numeric: true, sensitivity: "base" });
      if (cmp !== 0) return cmp;
      continue;
    }
    if (la.kind === "text" && rb.kind === "num") {
      const cmp = la.value.localeCompare(String(rb.value), locales, { numeric: true, sensitivity: "base" });
      if (cmp !== 0) return cmp;
      continue;
    }
    if (la.kind === "text" && rb.kind === "text") {
      const cmp = la.value.localeCompare(rb.value, locales, { numeric: true, sensitivity: "base" });
      if (cmp !== 0) return cmp;
    }
  }
  return a.localeCompare(b, locales, { numeric: true, sensitivity: "base" });
}

export function sortPathNames<T extends string>(paths: readonly T[], locales?: string | string[]): T[] {
  return [...paths].sort((a, b) => comparePathNames(a, b, locales));
}
