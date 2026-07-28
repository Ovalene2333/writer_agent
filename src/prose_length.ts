export const PROSE_TARGET_MIN_RATIO = 0.75;
export const PROSE_TARGET_MAX_RATIO = 1.35;

export type ProseLengthBounds = {
  minimum: number;
  maximum: number;
};

export type ProseLengthAssessment = ProseLengthBounds & {
  target: number;
  actual: number;
  status: "ok" | "too_short" | "too_long";
  delta: number;
};

export function proseCharacterCount(content: string): number {
  return content.replace(/\s+/gu, "").length;
}

export function proseTargetBounds(targetCharacters: number): ProseLengthBounds {
  return {
    minimum: Math.ceil(targetCharacters * PROSE_TARGET_MIN_RATIO),
    maximum: Math.floor(targetCharacters * PROSE_TARGET_MAX_RATIO),
  };
}

export function assessProseLength(targetCharacters: number, content: string): ProseLengthAssessment {
  const bounds = proseTargetBounds(targetCharacters);
  const actual = proseCharacterCount(content);
  if (actual < bounds.minimum) {
    return { target: targetCharacters, actual, ...bounds, status: "too_short", delta: bounds.minimum - actual };
  }
  if (actual > bounds.maximum) {
    return { target: targetCharacters, actual, ...bounds, status: "too_long", delta: actual - bounds.maximum };
  }
  return { target: targetCharacters, actual, ...bounds, status: "ok", delta: 0 };
}

export function proseLengthAdjustmentInstruction(assessment: ProseLengthAssessment): string {
  if (assessment.status === "too_short") {
    return `上一次正文 ${assessment.actual} 字，低于可接受下限 ${assessment.minimum} 字，至少补足约 ${assessment.delta} 字，目标靠近 ${assessment.target} 字。保留已经成立的事件链，优先扩展人物为达成目标采取的具体行动、阻力造成的可见后果、转折前后的反应和结尾余波；不要新增无依据支线，不用解释、总结、同义反复或回顾凑字。`;
  }
  if (assessment.status === "too_long") {
    return `上一次正文 ${assessment.actual} 字，高于可接受上限 ${assessment.maximum} 字，至少删减约 ${assessment.delta} 字，目标靠近 ${assessment.target} 字。保留关键动作、事实和结尾余波，优先压缩原理说明、重复读数、过门动作和不改变选择的过程；不要把完整场景改成梗概。`;
  }
  return `上一次正文 ${assessment.actual} 字，已在可接受范围 ${assessment.minimum}—${assessment.maximum} 字内；不需要为字数重写。`;
}
