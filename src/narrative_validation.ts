import { analyzeAdaptiveStyle, adaptiveQualityWarnings, type AdaptiveStyleAnalysis } from "./adaptive_style.js";
import { buildProseQualityReportFromAnalysis, PROSE_QUALITY_REPORT_VERSION } from "./final_quality.js";
import { chapterMetricsBlockError, type ChapterMetricIssue } from "./prose_metrics.js";
import { boundedRepairPacket, type RepairPacket } from "./repair_packet.js";
import type { WriterStore } from "./store.js";
import type { DocumentQualityReportSnapshot, ProseQualityReport } from "./types.js";

export const NARRATIVE_VALIDATION_VERSION = 1;

export type NarrativeValidationReceipt = {
  sourceHash: string;
  validatorVersion: number;
  styleReviewed: boolean;
  semanticReviewed: boolean;
};

export type NarrativeValidationSnapshot = {
  path: string;
  sourceHash: string;
  report: ProseQualityReport;
  reportSnapshot: DocumentQualityReportSnapshot;
  adaptive: AdaptiveStyleAnalysis;
  metricBlockError?: string;
  metricRepairPacket?: RepairPacket;
};

export function narrativeValidationReceipt(
  sourceHash: string,
  options: { styleReviewed: boolean; semanticReviewed: boolean },
): NarrativeValidationReceipt {
  return {
    sourceHash,
    validatorVersion: NARRATIVE_VALIDATION_VERSION,
    ...options,
  };
}

export function validationReceiptMatches(
  receipt: NarrativeValidationReceipt | undefined,
  sourceHash: string,
): boolean {
  return Boolean(receipt
    && receipt.validatorVersion === NARRATIVE_VALIDATION_VERSION
    && receipt.sourceHash === sourceHash);
}

export function buildNarrativeValidationSnapshot(input: {
  store: WriterStore;
  path: string;
  content: string;
  sourceHash: string;
  targetCharacters?: number;
  priorText?: string;
  origin: DocumentQualityReportSnapshot["origin"];
}): NarrativeValidationSnapshot {
  const adaptive = analyzeAdaptiveStyle(
    input.content,
    input.priorText ? { priorText: input.priorText } : undefined,
  );
  const cached = input.store.documentQualityReportSnapshot(input.path, input.sourceHash);
  const reusable = cached?.report.version === PROSE_QUALITY_REPORT_VERSION
    && (!input.targetCharacters || cached.report.length?.target === input.targetCharacters);
  const reportSnapshot = reusable
    ? cached
    : input.store.saveDocumentQualityReport(
      input.path,
      input.sourceHash,
      buildProseQualityReportFromAnalysis(
        input.content,
        adaptive,
        input.targetCharacters ? { lengthTarget: input.targetCharacters } : undefined,
      ),
      input.origin,
    );
  const metricBlockError = chapterMetricsBlockError(adaptive.metrics);
  const blockingIssues = adaptive.metrics.issues.filter(issue => issue.severity === "error");
  return {
    path: input.path,
    sourceHash: input.sourceHash,
    report: reportSnapshot.report,
    reportSnapshot,
    adaptive,
    ...(metricBlockError ? { metricBlockError } : {}),
    ...(blockingIssues.length
      ? { metricRepairPacket: metricRepairPacket(input.path, input.sourceHash, input.content, blockingIssues) }
      : {}),
  };
}

export function proseSignalsFromNarrativeValidation(snapshot: NarrativeValidationSnapshot): Record<string, unknown> {
  const warnings = adaptiveQualityWarnings(snapshot.adaptive);
  return {
    validationVersion: NARRATIVE_VALIDATION_VERSION,
    sourceHash: snapshot.sourceHash,
    stats: snapshot.adaptive.metrics.stats,
    warnings: warnings.map(warning => ({
      code: warning.code,
      message: warning.message,
      examples: warning.examples.slice(0, 5),
    })),
    vividness: snapshot.adaptive.vividness.stats,
    aiTells: snapshot.adaptive.aiTells.stats,
    dialogue: snapshot.adaptive.dialogue.stats,
  };
}

function metricRepairPacket(
  path: string,
  sourceHash: string,
  content: string,
  issues: ChapterMetricIssue[],
): RepairPacket | undefined {
  const rows = issues.flatMap(issue => (issue.occurrences?.length ? issue.occurrences : issue.examples)
    .map((evidence, index) => ({
      id: `metric:${issue.code}:${index}`,
      kind: issue.code,
      ...(content.indexOf(evidence) >= 0 && content.indexOf(evidence) === content.lastIndexOf(evidence)
        ? { oldText: evidence }
        : { evidence }),
      problem: issue.message,
      action: issue.code === "adjacent_duplicate"
        ? "删除相邻复读中的一份，保留原有事实与语气"
        : "只改写命中句，保留其事实、人物意图和场景结果",
    })));
  return boundedRepairPacket({ path, sourceHash, issueCount: rows.length, issues: rows });
}
