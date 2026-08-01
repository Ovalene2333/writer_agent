import { createHash } from "node:crypto";
import type { ProseStyleIssue } from "./prose_quality.js";

export type ProseDiagnosticIssue = {
  issueId: string;
  ruleId: string;
  severity: ProseStyleIssue["severity"];
  verdict: "allow" | "warn" | "block";
  evidence: string;
  location: { line: number; column: number; start: number; end: number };
  explanation: string;
  revisionIntent: string;
};

export type ProseDiagnosis = {
  reviewId: string;
  sourceHash: string;
  status: "clean" | "review" | "needs_revision";
  guidance: string;
  actionableIssues: ProseDiagnosticIssue[];
};

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function issueRuleId(issue: ProseStyleIssue): string {
  if (issue.constructionRuleId) return issue.constructionRuleId;
  if (issue.kind === "learned") {
    const match = /^learned:([^:]+):/u.exec(issue.id);
    if (match?.[1]) return match[1];
  }
  return issue.subtype;
}

function issueVerdict(issue: ProseStyleIssue): ProseDiagnosticIssue["verdict"] {
  if (issue.semanticVerdict) return issue.semanticVerdict;
  if (issue.severity === "error") return "block";
  if (issue.severity === "warning") return "warn";
  return "allow";
}

function fallbackRevisionIntent(issue: ProseStyleIssue): string {
  if (issue.kind === "contrast") return "保留真正成立的事实或动作，删除不增加信息的对照补注；必要纠错保持人物口吻。";
  if (issue.kind === "dash") return "只移除重复说明，将必要因果写成独立事实；正常停顿、拖音和短同位保留。";
  if (issue.kind === "explanation") return "判断该句是否增加新事实；没有则删除，有则只保留会改变理解或行动的部分。";
  return "按项目复审规则做局部修正，不改动无关正文。";
}

/**
 * Agent-facing diagnostic view over the raw gate issues. Raw issues remain
 * available for compatibility; this view supplies stable snapshot-scoped IDs
 * and revision intent without asking the review model to rewrite prose.
 */
export function buildProseDiagnosis(sourceHash: string, issues: ProseStyleIssue[]): ProseDiagnosis {
  const actionableIssues = issues
    .filter(issue => issue.severity !== "info" || issue.semanticVerdict === "block")
    .map(issue => {
      const ruleId = issueRuleId(issue);
      const verdict = issueVerdict(issue);
      return {
        issueId: `prose:${shortHash(`${sourceHash}|${ruleId}|${issue.start}|${issue.evidence}`)}`,
        ruleId,
        severity: issue.severity,
        verdict,
        evidence: issue.evidence,
        location: { line: issue.line, column: issue.column, start: issue.start, end: issue.end },
        explanation: issue.reason,
        revisionIntent: issue.suggestions[0]?.trim() || fallbackRevisionIntent(issue),
      };
    })
    .sort((left, right) => {
      const verdictRank = (value: ProseDiagnosticIssue["verdict"]) => value === "block" ? 2 : value === "warn" ? 1 : 0;
      return verdictRank(right.verdict) - verdictRank(left.verdict)
        || left.location.start - right.location.start;
    })
    .slice(0, 30);
  const status = actionableIssues.some(issue => issue.verdict === "block")
    ? "needs_revision" as const
    : actionableIssues.length
      ? "review" as const
      : "clean" as const;
  const reviewId = `review:${shortHash(`${sourceHash}|${actionableIssues.map(issue => issue.issueId).join("|")}`)}`;
  return {
    reviewId,
    sourceHash,
    status,
    guidance: "优先局部修正 verdict=block；warn 只在结合上下文仍明显模板化时修改；不要改写 allow 或未列出的正文。修改后的提案会由同一审核引擎自动复检。",
    actionableIssues,
  };
}
