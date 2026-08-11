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

export type SessionCharacterCandidateStatus = "planned" | "drafted" | "confirmed" | "promoted";

export type SessionCharacterCandidateSource = {
  sourceMessageId?: number;
  sourceProposalId?: number;
  artifactId?: number;
  path?: string;
  sourceHash?: string;
  evidence?: string;
};

/**
 * A provisional narrative entity, deliberately weaker than a project character
 * card. Draft planning may reshape it; only accepted prose can confirm it.
 */
export type SessionCharacterCandidate = {
  name: string;
  aliases: string[];
  status: SessionCharacterCandidateStatus;
  summary: string;
  /** v4 session-scoped entity; legacy proposedCard is retained only for old artifacts. */
  knowledgeEntity?: Record<string, unknown>;
  knowledgePolicies?: Array<Record<string, unknown>>;
  proposedCard?: Record<string, unknown>;
  sources: SessionCharacterCandidateSource[];
  promotedCharacterId?: number;
};

export type SessionCharacterDraftStatus = "editing" | "submitted" | "applied" | "discarded" | "stale";

/** Legacy workspace payload retained only so archived tool replays remain readable. */
export type SessionCharacterDraft = {
  draftId: string;
  revision: number;
  status: SessionCharacterDraftStatus;
  baseCharacterId?: number;
  baseUpdatedAt?: string;
  character: Character;
  summary: string;
  sourceCandidateArtifactId?: number;
  changeSetId?: number;
};

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

export function characterCandidateArtifactKey(name: string): string {
  return `character_candidate:${encodeURIComponent(name.normalize("NFKC").trim().toLocaleLowerCase())}`;
}

export function characterDraftArtifactKey(draftId: string): string {
  return `character_draft:${draftId}`;
}
import type { Character } from "./types.js";
