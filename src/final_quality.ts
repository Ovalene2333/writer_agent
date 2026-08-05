/**
 * Final writing-quality report: one object composed from the deterministic
 * prose layers, computed once at proposal time.
 *
 * Why a separate module: `scene_pipeline.ts` (章节场景管线) and `proposals.ts`
 * (直接文档提案) both need the same picture, and it has to be persisted with the
 * proposal so the author sees it in the review dock before pressing Accept.
 * Building it in one place keeps the two paths from drifting.
 *
 * Advisory only. Nothing here blocks: metric *errors* still block earlier, inside
 * `chapterMetricsBlockError`; by the time a proposal exists they are already gone,
 * so what lands here is the residual checklist plus two scores.
 */

import { formatAiTellSummary } from "./ai_tells.js";
import { adaptiveQualityWarnings, analyzeAdaptiveStyle } from "./adaptive_style.js";
import { formatVividnessSummary } from "./prose_vividness.js";
import { assessProseLength } from "./prose_length.js";
import type { ProseQualityReport } from "./types.js";

/** 生动度低于此分记一次扣分（现场感不足）。 */
export const VIVIDNESS_GOOD_SCORE = 55;
/** AI 味高于此分记一次扣分。 */
export const AI_TELL_ALERT_SCORE = 40;

export function buildProseQualityReport(
  text: string,
  options?: { priorText?: string; lengthTarget?: number },
): ProseQualityReport {
  const adaptive = analyzeAdaptiveStyle(
    text,
    options?.priorText ? { priorText: options.priorText } : undefined,
  );
  const { vividness, aiTells } = adaptive;
  const warnings: ProseQualityReport["warnings"] = adaptiveQualityWarnings(adaptive);

  const rhythmHeavy = warnings.some(warning =>
    warning.code === "rhythm_flat"
      || warning.code === "rhythm_uniform"
      || warning.code === "narrative_rhythm_uniform",
  );
  return {
    characters: vividness.stats.characters,
    vividness: { score: vividness.stats.score, summary: formatVividnessSummary(vividness.stats) },
    aiTells: { score: aiTells.stats.score, summary: formatAiTellSummary(aiTells.stats) },
    grade: gradeOf(vividness.stats.score, aiTells.stats.score, warnings.length, rhythmHeavy),
    ...(options?.lengthTarget ? { length: lengthOf(options.lengthTarget, text) } : {}),
    warnings,
  };
}

/**
 * Three buckets, deliberately coarse: the author needs "这章可以发 / 还行 / 得再过一遍",
 * not a false-precision number. Both scores plus the warning count have to agree
 * before anything is called weak.
 *
 * Mono-staccato rhythm is a frequent AI-looking failure that still scores high on
 * vividness/objects; weight it so "尚可" is not the default for telegraph prose.
 */
function gradeOf(
  vividness: number,
  aiTells: number,
  warningCount: number,
  rhythmHeavy = false,
): ProseQualityReport["grade"] {
  const demerits = (vividness < VIVIDNESS_GOOD_SCORE ? 1 : 0)
    + (aiTells > AI_TELL_ALERT_SCORE ? 1 : 0)
    + (warningCount >= 4 ? 1 : 0)
    + (rhythmHeavy ? 1 : 0);
  if (demerits >= 2) return "weak";
  if (demerits === 1 || warningCount >= 2) return "fair";
  return "good";
}

/** Text rendering for tool results and the agent-facing fallback path. */
/** 篇幅是报告项，不是判决项：只描述目标与实际的关系，交付与否已在工具端定了。 */
function lengthOf(target: number, text: string): NonNullable<ProseQualityReport["length"]> {
  const assessment = assessProseLength(target, text);
  return { target, actual: assessment.actual, status: assessment.status };
}

export function formatQualityReportLines(report: ProseQualityReport): string[] {
  return [
    `最终写作质量：${gradeLabel(report.grade)}（${report.characters} 字）`,
    ...(report.length
      ? [`篇幅 ${report.length.actual} / 目标 ${report.length.target} 字${
        report.length.status === "too_short" ? "（偏短）" : report.length.status === "too_long" ? "（偏长）" : ""
      }`]
      : []),
    report.vividness.summary,
    report.aiTells.summary,
    ...report.warnings.map(warning => `[${warning.source}/${warning.code}] ${warning.message}`),
  ];
}

export function gradeLabel(grade: ProseQualityReport["grade"]): string {
  if (grade === "good") return "良好";
  return grade === "fair" ? "尚可" : "偏弱";
}
