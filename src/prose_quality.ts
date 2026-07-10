export interface ContrastStyleReport {
  count: number;
  allowed: number;
  examples: string[];
}

const CONTRAST_PATTERNS = [
  /不是[^\n。！？!?]{0,60}而是/gu,
  /并非[^\n。！？!?]{0,60}(?:而是|却是)/gu,
  /与其说[^\n。！？!?]{0,60}不如说/gu,
  /没有[^\n。！？!?]{0,60}只有/gu,
  /不是[^\n。！？!?]{0,60}只是/gu,
  /不在于[^\n。！？!?]{0,60}而在于/gu,
];

/** Detect repeated explanatory contrast constructions associated with formulaic prose. */
export function contrastStyleReport(text: string): ContrastStyleReport {
  const matches = CONTRAST_PATTERNS.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[0]));
  const characters = text.replace(/\s/g, "").length;
  return {
    count: matches.length,
    allowed: Math.max(1, Math.floor(characters / 3_000)),
    examples: [...new Set(matches)].slice(0, 4),
  };
}

export function contrastStyleError(text: string): string | undefined {
  const report = contrastStyleReport(text);
  if (report.count <= report.allowed) return undefined;
  return `正文中解释性对照句过密（${report.count} 处，当前篇幅最多 ${report.allowed} 处）：${report.examples.join("；")}。请局部重写命中句，直接陈述动作、观察或结果；人物确实在反驳误解时才保留此结构。`;
}
