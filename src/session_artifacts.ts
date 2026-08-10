export type SessionArtifactStatus =
  | "active"
  | "blocked"
  | "resolved"
  | "submitted"
  | "applied"
  | "superseded"
  | "rejected"
  | "stale";

export type SessionArtifactRelation =
  | "derived_from"
  | "supersedes"
  | "supports"
  | "supported_by"
  | "validates"
  | "validated_by"
  | "repairs"
  | "submitted_as"
  | "applied_as";

/**
 * Durable, session-scoped knowledge/work product. The project file remains the
 * source of truth; these records describe what this session read, generated,
 * validated and submitted against an exact source version.
 */
export type SessionArtifact = {
  id: number;
  sessionId: string;
  artifactKey: string;
  kind: string;
  path?: string;
  sourceHash: string;
  content: string;
  digest: string;
  status: SessionArtifactStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
};

export type SaveSessionArtifactInput = {
  artifactKey: string;
  kind: string;
  path?: string;
  sourceHash: string;
  content: string;
  digest: string;
  status?: SessionArtifactStatus;
  metadata?: Record<string, unknown>;
  relations?: Array<{ artifactId: number; relation: SessionArtifactRelation }>;
};

export function documentQualityArtifactKey(
  path: string,
  sourceHash: string,
  report: { version?: number; length?: { target?: number } },
): string {
  return `quality_report:${path}:${sourceHash}:v${report.version ?? 0}:target${report.length?.target ?? 0}`;
}
