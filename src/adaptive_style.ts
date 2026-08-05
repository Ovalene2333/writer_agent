/**
 * One adaptive prose diagnosis shared by generation, grounded revision and the
 * final quality report. The underlying counters only locate suspicious shapes;
 * the messages ask the writer to resolve their semantic cause rather than hit a
 * sentence-length quota.
 */

import {
  analyzeDialogueTexture,
  DIALOGUE_SPREAD_TARGET,
  SHORT_RATIO_LIMIT,
} from "./dialogue_texture.js";
import { analyzeAiTells } from "./ai_tells.js";
import {
  analyzeChapterProseMetrics,
  priorChapterNegativeList,
  sceneAntiFormulaFeedback,
} from "./prose_metrics.js";
import {
  analyzeProseVividness,
  RHYTHM_SPREAD_TARGET,
} from "./prose_vividness.js";

export type AdaptiveStyleCode =
  | "dialogue_exchange_compressed"
  | "narrative_rhythm_uniform"
  | "paragraph_opening_fixed";

export type AdaptiveStyleIssue = {
  code: AdaptiveStyleCode;
  source: "metrics" | "dialogue";
  message: string;
  examples: string[];
  /** Raw warning codes replaced by this semantic diagnosis in the final report. */
  relatedCodes: string[];
  /** Only compound, high-signal issues may trigger the grounded second pass. */
  reviseCurrentDraft: boolean;
  /** Internal candidate comparison only; never exposed as a writing quota. */
  strength: number;
};

export type AdaptiveStyleAnalysis = {
  metrics: ReturnType<typeof analyzeChapterProseMetrics>;
  vividness: ReturnType<typeof analyzeProseVividness>;
  aiTells: ReturnType<typeof analyzeAiTells>;
  dialogue: ReturnType<typeof analyzeDialogueTexture>;
  issues: AdaptiveStyleIssue[];
  revisionScore: number;
};

export type AdaptiveQualityWarning = {
  source: "metrics" | "vividness" | "ai_tells" | "dialogue";
  code: string;
  message: string;
  examples: string[];
};

export function analyzeAdaptiveStyle(
  text: string,
  options?: { priorText?: string },
): AdaptiveStyleAnalysis {
  const metrics = analyzeChapterProseMetrics(
    text,
    options?.priorText ? { priorText: options.priorText } : undefined,
  );
  const vividness = analyzeProseVividness(text);
  const aiTells = analyzeAiTells(text);
  const dialogue = analyzeDialogueTexture(text);
  const issues: AdaptiveStyleIssue[] = [];

  const compressedDialogue = dialogue.stats.lineCount >= 12
    && dialogue.stats.shortRatio >= SHORT_RATIO_LIMIT
    && dialogue.stats.lengthSpread < DIALOGUE_SPREAD_TARGET;
  if (compressedDialogue) {
    const shortPercent = Math.round(dialogue.stats.shortRatio * 100);
    issues.push({
      code: "dialogue_exchange_compressed",
      source: "dialogue",
      message: `对白有 ${shortPercent}% 停在很短的应答，且整章台词只在相近长度内摆动。`
        + "逐轮检查哪些话本应承接上一句，解释因果、争取条件、隐瞒动机或拒绝要求，却被压成了状态播报；把这些信息恢复到人物的谈话行动里。"
        + "短命令、犹豫、沉默和近邻语境足以补全的省略应保留，不要靠语气词或机械拉长制造口语感。",
      examples: dialogue.issues
        .filter(issue => issue.code === "dialogue_clipped")
        .flatMap(issue => issue.examples)
        .slice(0, 4),
      relatedCodes: ["dialogue_clipped", "dialogue_monotone", "dialogue_homogeneous", "dialogue_bookish"],
      reviseCurrentDraft: true,
      strength: roundStrength(
        1
        + Math.max(0, dialogue.stats.shortRatio - SHORT_RATIO_LIMIT)
        + Math.max(0, DIALOGUE_SPREAD_TARGET - dialogue.stats.lengthSpread) / DIALOGUE_SPREAD_TARGET,
      ),
    });
  }

  const uniformNarration = vividness.stats.characters >= 400
    && metrics.stats.sentenceCount >= 20
    && vividness.stats.sentenceLengthSpread < RHYTHM_SPREAD_TARGET
    && vividness.stats.longSentenceRatio < 0.08;
  if (uniformNarration) {
    issues.push({
      code: "narrative_rhythm_uniform",
      source: "metrics",
      message: "叙述反复在相近位置收句，需要展开的观察、动作链或判断也被提前截断。"
        + "逐段找到仍在持续追踪同一对象、同一动作或同一次心理转向的地方，让语法关系自然承接到信息真正落定；压力骤变时的短句继续保留。"
        + "不要额外插入无关长句，也不要为了统计值合并本来属于不同注意力落点的句子。",
      examples: metrics.issues
        .filter(issue => issue.code === "rhythm_flat")
        .flatMap(issue => issue.examples)
        .slice(0, 4),
      relatedCodes: ["rhythm_flat", "rhythm_uniform", "sentence_uniform"],
      reviseCurrentDraft: true,
      strength: roundStrength(
        1
        + Math.max(0, RHYTHM_SPREAD_TARGET - vividness.stats.sentenceLengthSpread) / RHYTHM_SPREAD_TARGET
        + Math.max(0, 0.08 - vividness.stats.longSentenceRatio),
      ),
    });
  }

  const openingIssue = metrics.issues.find(issue => issue.code === "opening_monotony");
  if (openingIssue) {
    issues.push({
      code: "paragraph_opening_fixed",
      source: "metrics",
      message: `${openingIssue.message}不要轮流替换同义主语来做表面变化；让段落从此刻真正进入人物注意力的环境变化、对方动作、对白压力或未完成动作起笔。`,
      examples: openingIssue.examples,
      relatedCodes: ["opening_monotony"],
      reviseCurrentDraft: true,
      strength: 1,
    });
  }

  return {
    metrics,
    vividness,
    aiTells,
    dialogue,
    issues,
    revisionScore: roundStrength(issues.reduce((sum, issue) => sum + issue.strength, 0)),
  };
}

/**
 * Dynamic feedback for the next scene. It is recomputed from stored prose, so
 * the main Agent and the delegated Writer receive the same diagnosis.
 */
export function chapterAdaptiveStyleFeedback(options: {
  chapterSoFar: string;
  priorChapterText?: string;
  priorNotes?: string[];
}): string[] {
  const priorNotes = options.priorNotes?.length
    ? options.priorNotes
    : options.priorChapterText
      ? priorChapterNegativeList(options.priorChapterText)
      : [];
  if (!options.chapterSoFar.trim()) return dedupe(priorNotes);

  const analysis = analyzeAdaptiveStyle(
    options.chapterSoFar,
    options.priorChapterText ? { priorText: options.priorChapterText } : undefined,
  );
  const related = new Set(analysis.issues.flatMap(issue => issue.relatedCodes));
  const semanticFeedback = [
    ...analysis.issues.map(issue => issue.message),
    ...analysis.vividness.issues
      .filter(issue => !related.has(issue.code))
      .map(issue => issue.message),
    ...analysis.dialogue.issues
      .filter(issue => !related.has(issue.code))
      .map(issue => issue.message),
    ...analysis.aiTells.issues
      .filter(issue => issue.code !== "thematic_uplift" && !related.has(issue.code))
      .map(issue => issue.message),
  ];
  const antiFormula = sceneAntiFormulaFeedback({
    chapterSoFar: options.chapterSoFar,
    priorChapterText: options.priorChapterText,
  });
  const lines = dedupe([...priorNotes, ...antiFormula, ...semanticFeedback]);
  return lines.length
    ? [
      "既有正文的自适应文风反馈（结构统计只负责定位；按上下文处理真实问题，不为数值或配额改写）：",
      ...lines,
    ]
    : [];
}

/** Instructions that justify one evidence-preserving rewrite of the current draft. */
export function groundedAdaptiveRevisionInstructions(text: string): string[] {
  return analyzeAdaptiveStyle(text).issues
    .filter(issue => issue.reviseCurrentDraft)
    .map(issue => issue.message);
}

/**
 * Final report warnings with same-cause signals collapsed. Low colloquial-marker
 * counts are presented as dialogue evidence, never as an AI-score contradiction.
 */
export function adaptiveQualityWarnings(analysis: AdaptiveStyleAnalysis): AdaptiveQualityWarning[] {
  const related = new Set(analysis.issues.flatMap(issue => issue.relatedCodes));
  return [
    ...analysis.issues.map(issue => ({
      source: issue.source,
      code: issue.code,
      message: issue.message,
      examples: issue.examples,
    })),
    ...analysis.metrics.issues
      .filter(issue => !related.has(issue.code))
      .map(issue => ({
        source: "metrics" as const,
        code: issue.code,
        message: issue.message,
        examples: issue.examples.slice(0, 5),
      })),
    ...analysis.vividness.issues
      .filter(issue => !related.has(issue.code))
      .map(issue => ({
        source: "vividness" as const,
        code: issue.code,
        message: issue.message,
        examples: issue.examples.slice(0, 5),
      })),
    ...analysis.aiTells.issues
      .filter(issue => !related.has(issue.code))
      .map(issue => ({
        source: issue.code === "dialogue_bookish" || issue.code === "dialogue_homogeneous"
          ? "dialogue" as const
          : issue.code === "sentence_uniform"
            ? "metrics" as const
            : "ai_tells" as const,
        code: issue.code,
        message: issue.message,
        examples: issue.examples.slice(0, 5),
      })),
    ...analysis.dialogue.issues
      .filter(issue => !related.has(issue.code))
      .map(issue => ({
        source: "dialogue" as const,
        code: issue.code,
        message: issue.message,
        examples: issue.examples.slice(0, 5),
      })),
  ];
}

export function adaptiveRevisionImproved(before: AdaptiveStyleAnalysis, after: AdaptiveStyleAnalysis): boolean {
  if (!before.issues.some(issue => issue.reviseCurrentDraft)) return false;
  return after.revisionScore + 0.05 < before.revisionScore;
}

function roundStrength(value: number): number {
  return Math.round(value * 100) / 100;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
