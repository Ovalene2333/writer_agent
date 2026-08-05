/**
 * Bounded machine-readable repair instructions carried from a gate to the next
 * Agent turn. This stays in dynamic tool/retry data; it is never part of the
 * stable prompt prefix or tool schema.
 */
export const MAX_REPAIR_PACKET_ISSUES = 20;
export const MAX_REPAIR_PACKET_CHARACTERS = 12_000;

export type RepairPacketIssue = {
  id: string;
  kind: string;
  line?: number;
  /** Exact, unique source text suitable for one edit_file replacement. */
  oldText?: string;
  /** A short locator for the targeted read fallback when oldText is absent. */
  evidence?: string;
  suggestion?: string;
  problem?: string;
  action?: string;
  relatedIssueIds?: string[];
  policyId?: string;
  policyVersion?: number;
  skillId?: string;
};

export type RepairPacket = {
  path?: string;
  sourceHash?: string;
  /** Total gate findings before bounded packing. */
  issueCount: number;
  issues: RepairPacketIssue[];
  omittedIssueCount?: number;
};

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : undefined;
}

function boundedIssue(value: unknown): RepairPacketIssue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const id = boundedString(row.id, 160);
  const kind = boundedString(row.kind, 120);
  if (!id || !kind) return undefined;
  const oldText = boundedString(row.oldText, 1_200);
  const evidence = boundedString(row.evidence, 280);
  const suggestion = boundedString(row.suggestion, 320);
  const problem = boundedString(row.problem, 360);
  const action = boundedString(row.action, 360);
  const policyId = boundedString(row.policyId, 80);
  const skillId = boundedString(row.skillId, 80);
  const policyVersion = typeof row.policyVersion === "number" && Number.isInteger(row.policyVersion) && row.policyVersion > 0
    ? row.policyVersion
    : undefined;
  const line = typeof row.line === "number" && Number.isInteger(row.line) && row.line > 0
    ? row.line
    : undefined;
  const relatedIssueIds = Array.isArray(row.relatedIssueIds)
    ? row.relatedIssueIds
      .map(item => boundedString(item, 160))
      .filter((item): item is string => Boolean(item))
      .slice(0, 8)
    : [];
  return {
    id,
    kind,
    ...(line ? { line } : {}),
    ...(oldText ? { oldText } : {}),
    ...(evidence ? { evidence } : {}),
    ...(suggestion ? { suggestion } : {}),
    ...(problem ? { problem } : {}),
    ...(action ? { action } : {}),
    ...(policyId ? { policyId } : {}),
    ...(policyVersion ? { policyVersion } : {}),
    ...(skillId ? { skillId } : {}),
    ...(relatedIssueIds.length ? { relatedIssueIds } : {}),
  };
}

/**
 * Normalize untrusted tool/review payloads and retain only a bounded packet.
 * Packing preserves source order; omitted findings are explicit so they cannot
 * be mistaken for resolved ones.
 */
export function normalizeRepairPacket(value: unknown): RepairPacket | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const rawIssues = Array.isArray(source.issues) ? source.issues : [];
  const candidates = rawIssues
    .map(boundedIssue)
    .filter((issue): issue is RepairPacketIssue => Boolean(issue))
    .slice(0, MAX_REPAIR_PACKET_ISSUES);
  if (!candidates.length) return undefined;

  const issues: RepairPacketIssue[] = [];
  for (const candidate of candidates) {
    const next = [...issues, candidate];
    if (JSON.stringify(next).length > MAX_REPAIR_PACKET_CHARACTERS) break;
    issues.push(candidate);
  }
  if (!issues.length) return undefined;
  const requestedCount = typeof source.issueCount === "number" && Number.isInteger(source.issueCount)
    ? source.issueCount
    : rawIssues.length;
  const issueCount = Math.max(issues.length, Math.min(999, Math.max(0, requestedCount)));
  const explicitOmitted = typeof source.omittedIssueCount === "number" && Number.isInteger(source.omittedIssueCount)
    ? Math.max(0, source.omittedIssueCount)
    : 0;
  const omittedIssueCount = explicitOmitted
    + Math.max(0, rawIssues.length - candidates.length)
    + Math.max(0, candidates.length - issues.length);
  const path = boundedString(source.path, 360);
  const sourceHash = boundedString(source.sourceHash, 160);
  return {
    ...(path ? { path } : {}),
    ...(sourceHash ? { sourceHash } : {}),
    issueCount,
    issues,
    ...(omittedIssueCount ? { omittedIssueCount } : {}),
  };
}

/** Apply the same bounds to locally constructed packets before serializing them. */
export function boundedRepairPacket(packet: RepairPacket): RepairPacket | undefined {
  return normalizeRepairPacket(packet);
}
