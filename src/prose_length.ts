import {
  MAX_CHAPTER_TARGET_CHARACTERS,
  MIN_CHAPTER_TARGET_CHARACTERS,
  type ProseLengthSettings,
} from "./agent_runtime.js";

export const PROSE_TARGET_MIN_RATIO = 0.75;
export const PROSE_TARGET_MAX_RATIO = 1.35;

/** 供提示词与工具 schema 复用，避免文案里的验收带宽再次与代码漂移。 */
export const PROSE_TARGET_BAND_TEXT =
  `${Math.round(PROSE_TARGET_MIN_RATIO * 100)}%—${Math.round(PROSE_TARGET_MAX_RATIO * 100)}%`;

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
    // 只报目标，不报下限：一旦模型看见下限数字，它就把下限当成目标写到那里为止。
    return `上一次正文 ${assessment.actual} 字，比目标 ${assessment.target} 字少了约 ${assessment.target - assessment.actual} 字，这一次要写到目标附近。保留已经成立的事件链，优先扩展人物为达成目标采取的具体行动、阻力造成的可见后果、转折前后的反应和结尾余波；不要新增无依据支线，不用解释、总结、同义反复或回顾凑字。`;
  }
  if (assessment.status === "too_long") {
    return `上一次正文 ${assessment.actual} 字，高于可接受上限 ${assessment.maximum} 字，至少删减约 ${assessment.delta} 字，目标靠近 ${assessment.target} 字。保留关键动作、事实和结尾余波，优先压缩原理说明、重复读数、过门动作和不改变选择的过程；不要把完整场景改成梗概。`;
  }
  return `上一次正文 ${assessment.actual} 字，已在可接受范围 ${assessment.minimum}—${assessment.maximum} 字内；不需要为字数重写。`;
}

export type TurnProseLength = {
  targetCharacters: number;
  source: "prompt_exact" | "prompt_relative" | "settings";
};

/** 「长一点」这类相对说法的倍率，强到弱排列 —— 先匹配到的先生效。 */
const RELATIVE_LENGTH_RULES: Array<{ pattern: RegExp; ratio: number }> = [
  { pattern: /长很多|长得多|尽量长|越长越好|大幅(?:加长|扩写|扩充)/u, ratio: 1.8 },
  { pattern: /很短|极简|尽量短|短很多|大幅(?:压缩|删减|精简)/u, ratio: 0.5 },
  { pattern: /长一点|长一些|再长|更长|写长|加长|拉长|详细一点|详细一些|更详细|扩写|丰富一些/u, ratio: 1.4 },
  { pattern: /短一点|短一些|再短|更短|写短|精简|简短|压缩|删减/u, ratio: 0.7 },
];

const EXPLICIT_LENGTH_PATTERN = /(\d[\d,]*(?:\.\d+)?)\s*(万|千)?\s*字/gu;

/**
 * 本轮篇幅目标：作者说了算，说不出数字也算。
 *
 * 优先级是「明确数字 > 相对说法 > 项目默认」。明确数字直接采信，不再叠加相对倍率 ——
 * 「写 3000 字，再长一点」里用户已经给了数字，替他乘 1.4 只会让结果不可预测。
 * 相对说法的基准永远是项目默认档，所以同一句话在同一项目里每次都解析成同一个数字，
 * 不需要记住上一轮写了多长。
 */
export function resolveTurnProseLength(prompt: string, settings: ProseLengthSettings): TurnProseLength {
  const fallback = clampChapterTarget(settings.chapterTargetCharacters);
  const text = prompt ?? "";

  let explicit: number | undefined;
  for (const match of text.matchAll(EXPLICIT_LENGTH_PATTERN)) {
    const value = Number(match[1].replace(/,/gu, ""));
    if (!Number.isFinite(value) || value <= 0) continue;
    const scale = match[2] === "万" ? 10_000 : match[2] === "千" ? 1_000 : 1;
    // 最后一个匹配胜出：用户往往是在补充修正前面说过的数字。
    explicit = value * scale;
  }
  if (explicit !== undefined) return { targetCharacters: clampChapterTarget(explicit), source: "prompt_exact" };

  for (const rule of RELATIVE_LENGTH_RULES) {
    if (rule.pattern.test(text)) {
      return { targetCharacters: clampChapterTarget(fallback * rule.ratio), source: "prompt_relative" };
    }
  }
  return { targetCharacters: fallback, source: "settings" };
}

function clampChapterTarget(value: number): number {
  const rounded = Math.round(value / 100) * 100;
  return Math.min(MAX_CHAPTER_TARGET_CHARACTERS, Math.max(MIN_CHAPTER_TARGET_CHARACTERS, rounded));
}

export type ProseLengthOutcome = {
  /** true = 拒收并要求重写。 */
  blocked: boolean;
  /** 不阻断时给作者和 Agent 看的一句话；达标时为 undefined。 */
  notice?: string;
  message: string;
};

/**
 * 篇幅判定的唯一出口。三条写作路径（直接提案、标准场景、隔离 Writer）都走这里，
 * 免得各自写一套。
 *
 * 非对称是有意的：**超上限硬拦，不足只提示**。偏长会挤掉后文预算、也常常是模型在灌水，
 * 拦下来是对的；偏短则往往是这一场本来就没那么多事发生，为了凑数重写一遍既贵又会
 * 招来总结句和同义反复 —— 交给作者看着办，比让工具卡住交付好。
 */
export function proseLengthOutcome(
  assessment: ProseLengthAssessment,
  enforceMinimum: boolean,
): ProseLengthOutcome {
  if (assessment.status === "too_long") {
    return {
      blocked: true,
      message: `正文 ${assessment.actual} 字，目标 ${assessment.target} 字，超出可接受上限 ${assessment.maximum} 字。保持既定事实、因果和结局，优先删减不改变选择的说明、重复过程和过门后重新提交；不得把完整场景改成梗概。`,
    };
  }
  if (assessment.status === "too_short") {
    if (enforceMinimum) {
      return {
        blocked: true,
        message: `正文 ${assessment.actual} 字，目标 ${assessment.target} 字，低于可接受下限 ${assessment.minimum} 字。保持既定事实、因果和结局，补足行动、阻力、后果、反应和余波后重新提交；不得靠总结、重复或元说明凑字。`,
      };
    }
    const notice = `篇幅 ${assessment.actual} 字，低于目标 ${assessment.target} 字约 ${assessment.target - assessment.actual} 字；已按现有内容交付，需要更长可以直接说。`;
    return { blocked: false, notice, message: notice };
  }
  return { blocked: false, message: `篇幅 ${assessment.actual} 字，目标 ${assessment.target} 字。` };
}
