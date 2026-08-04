import type { AgentEvent, MessageAttachment, ModelConfig, PermissionMode } from "../types.js";
import type { WriterProject } from "../project.js";
import type { WriterStore } from "../store.js";
import type { ChapterSceneDraft, SceneActualState, SceneCharacterScope } from "../scene_pipeline.js";
import type { ScenePipelineSettings } from "../agent_runtime.js";
import type { ProseVerdictCache } from "../prose_adjudicate.js";
import type { ModelUsageReporter } from "../model_usage.js";
import type { ChapterReviewInput, ChapterReviewResult } from "../chapter_review.js";
import type { ProposalReviewRevisionContext } from "../proposal_retry.js";
import type { ChapterStyleRepairIssue, ChapterStyleEdit } from "../chapter_style_repair.js";
import type { DocumentLocatorCandidate, DocumentLocatorMatch } from "../document_locator.js";
import type { DocumentRevisionInput } from "../document_revision.js";
import type { ProseGateRule } from "../prose_gate_rules.js";
import type { ContinuityFact, ContinuityFactCandidate } from "../continuity_facts.js";
import type { CharacterConstraintView } from "../character_constraints.js";

/** Compact cross-chapter handoff captured when a chapter draft is proposed. */
export type CompletedChapterHandoff = {
  path: string;
  sceneCount: number;
  finalActualState?: SceneActualState;
};

/**
 * One setting/character body already paid for in this job.
 * After `fullBodyServed`, identical hash reads return a short shelf hit instead of
 * re-injecting the full tool payload (avoids post-boundary cold starts).
 */
export type MaterialsShelfEntry = {
  key: string;
  path?: string;
  characterId?: number;
  sourceHash: string;
  kind: string;
  digest: string;
  bodyChars: number;
  fullBodyServed: boolean;
  /** Semantic coverage survives compaction; the full body remains recoverable by artifact. */
  coveredSections?: string[];
  coveredFields?: string[];
  exactEvidenceRanges?: Array<{ startLine: number; endLine: number }>;
  artifactIds?: number[];
  /** Executable state: never replace this with the descriptive digest. */
  hardConstraints?: CharacterConstraintView;
  retention?: "executable" | "coverage" | "recoverable";
};

/**
 * Run-scoped overlay for a text file. Agent reads and edits this body while the
 * persisted project version remains unchanged until proposal approval.
 */
export type WorkingTextFile = {
  path: string;
  content: string;
  sourceHash: string;
  baseExists: boolean;
  baseSourceHash: string;
  deliverableId?: string;
  revisionCaseId?: string;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ToolExecutionContext = {
  permissionMode: PermissionMode;
  /** AgentRun owning workflow-scoped proposal state. */
  runId?: string;
  /** Dedicated Images API model and generated assets owned by this Agent turn. */
  imageGenerator?: { model: ModelConfig; signal?: AbortSignal; retryDelaysMs?: readonly number[] };
  generatedAttachments?: MessageAttachment[];
  /** Whether narrative tasks may append experiences and story state to character cards. */
  characterEvolutionEnabled?: boolean;
  /** User message that owns mutations made by this Agent job. */
  sourceMessageId?: number;
  /** Planner-classified rewrite scope; point edits enforce a narrow read lock. */
  editScope?: "point" | "section" | "document";
  /** Set after an exact quote/anchor read so point edits cannot drift into bulk reads. */
  editTargetLocked?: { path: string; sourceHash: string; anchorIds: string[] };
  /** Records provider usage from model calls made inside tool handlers. */
  modelUsageReporter?: ModelUsageReporter;
  /**
   * Per-job read transaction: the first inspect/read locks a path to one source
   * hash, and successful body reads register non-overlapping line atoms.
   */
  readSnapshots?: Map<string, {
    sourceHash: string;
    ranges: Array<{ startLine: number; endLine: number; artifactId?: number }>;
  }>;
  /** Total body characters admitted from document/file read tools this job. */
  readCharactersUsed?: number;
  /**
   * Job-level materials shelf: setting/character reads that survive chapter
   * boundaries so multi-chapter jobs do not cold-start re-read the same lore.
   * Key is a normalized path or `character:<id>`.
   */
  materialsShelf?: Map<string, MaterialsShelfEntry>;
  /** Optional UI-selected scope for compact/simple character cards. */
  simpleCharacterScope?: number[];
  /** Planner/UI-selected characters whose factual state should be supplied to final review. */
  reviewCharacterIds?: number[];
  /** Hashes of the exact constraint packets supplied to the writing context. */
  writerCharacterConstraintHashes?: Map<number, string>;
  /**
   * When true (outline mode), write_file / edit_file targeting
   * outline paths require a successful design_creative_outline earlier in this run.
   * Local edit_file is never gated by creative-outline design.
   */
  requireCreativeOutlineDesign?: boolean;
  /** Set true after design_creative_outline succeeds this run. */
  creativeOutlineDesigned?: boolean;
  /** Set true after compile_write_pack succeeds this run. */
  writePackCompiled?: boolean;
  /** Last compiled write pack text (for debugging / optional agent reuse). */
  lastWritePack?: string;
  /** Scene id bound to the latest write pack while assembling a chapter. */
  writePackSceneId?: string;
  /** Current project scene-chain guidance and enforced per-document limit. */
  scenePipelineSettings?: ScenePipelineSettings;
  /**
   * 本轮整章篇幅目标与下限执行强度。工具在调用方没给 targetCharacters 时用它兜底，
   * 并据 enforceMinimum 决定偏短是拦截还是只提示。
   */
  proseLength?: { targetCharacters: number; enforceMinimum: boolean };
  /** In-run narrative draft; never writes a partial document to the project. */
  chapterSceneDraft?: ChapterSceneDraft;
  /**
   * Card material authorized for the next scene only. The guide stores IDs;
   * get_character resolves them against the current source card on demand.
   */
  activeSceneCharacterScopes?: { sceneId: string; characterScopes: SceneCharacterScope[] };
  /**
   * Cached reuse-reference prose for the current chapter draft (previous chapter
   * body, plus base content in append mode). Feeds the verbatim-recycle metric and
   * scene anti-formula hints without re-reading files on every scene write.
   */
  priorProseContext?: { forPath: string; text: string };
  /**
   * Set when a reviewed chapter draft is submitted (before clearing the draft) so the
   * agent loop can reset per-chapter context while keeping continuity facts.
   */
  completedChapterHandoff?: CompletedChapterHandoff;
  /**
   * Cheap model (flash/summarizer/inline) for rule→snippet prose second pass.
   * When omitted, style checks stay rules-only.
   */
  proseAdjudicator?: {
    model: ModelConfig;
    /** Distinct provider/model used only after the primary adjudicator fails. */
    fallbackModel?: ModelConfig;
    signal?: AbortSignal;
  };
  /**
   * Paths that already used the first-draft rhythm grace (plot/scene first).
   * Second submit of the same path must pass the hard rhythm gate.
   */
  rhythmGracePaths?: Set<string>;
  /** Best-effort delta extractor run only after a lore/chapter proposal is accepted. */
  continuityExtractor?: {
    model: ModelConfig;
    signal?: AbortSignal;
    run?: (input: {
      path: string;
      beforeContent: string;
      afterContent: string;
      existingFacts: ContinuityFact[];
    }) => Promise<ContinuityFactCandidate[]>;
  };
  /** Project-persisted semantic review rules learned from explicit author feedback. */
  proseGateRules?: ProseGateRule[];
  /**
   * Full-chapter structural review runs in an isolated, tool-free call so the
   * assembled prose is not appended to every later Agent step. Production uses
   * the writing model; `run` allows deterministic handler tests.
   */
  chapterReviewer?: {
    model: ModelConfig;
    /** Retried only when the primary isolated review fails. */
    fallbackModel?: ModelConfig;
    signal?: AbortSignal;
    context?: string;
    run?: (
      model: ModelConfig,
      input: ChapterReviewInput,
      signal?: AbortSignal,
    ) => Promise<{ review: ChapterReviewResult; usage?: import("../types.js").ModelTokenUsage }>;
  };
  /** Semantic repair baselines, keyed by run + deliverable + path. */
  proposalReviewRevisions?: Map<string, ProposalReviewRevisionContext>;
  /** Paths whose latest blocked full draft is not the persisted project version. */
  activeProposalRevisionPaths?: Set<string>;
  /** Current run's file overlay; read_file resolves this before persisted files. */
  workingTextFiles?: Map<string, WorkingTextFile>;
  /** Public file mutation currently being routed through legacy proposal internals. */
  fileMutationTool?: "write_file" | "edit_file";
  /** Pre-call document base; proposal creation rechecks it after asynchronous review. */
  proposalExpectedDocumentBase?: {
    path: string;
    deliverableId?: string;
    exists: boolean;
    sourceHash: string;
    revisionCaseId?: string;
  };
  /** Exact normalized body most recently submitted. */
  latestProposalDraft?: {
    path: string;
    deliverableId?: string;
    content: string;
    sourceHash: string;
  };
  /** Isolated sentence-level repair; full chapter prose never enters the parent loop. */
  chapterStyleRepairer?: {
    model: ModelConfig;
    fallbackModel?: ModelConfig;
    signal?: AbortSignal;
    run?: (
      model: ModelConfig,
      input: { issues: ChapterStyleRepairIssue[]; chapterGoal: string; styleEvidence?: string },
      signal?: AbortSignal,
    ) => Promise<{ edits: ChapterStyleEdit[]; usage?: import("../types.js").ModelTokenUsage; requestCharacters: number }>;
  };
  /** Cheap isolated semantic reranker for prose anchors. */
  documentLocator?: {
    model: ModelConfig;
    signal?: AbortSignal;
    run?: (
      model: ModelConfig,
      input: { intent: string; candidates: DocumentLocatorCandidate[] },
      signal?: AbortSignal,
    ) => Promise<{ matches: DocumentLocatorMatch[]; usage?: import("../types.js").ModelTokenUsage; requestCharacters: number }>;
  };
  /** Isolated block rewriter used when a request truly targets the whole document. */
  documentRevisioner?: {
    model: ModelConfig;
    fallbackModel?: ModelConfig;
    signal?: AbortSignal;
    run?: (
      model: ModelConfig,
      input: DocumentRevisionInput,
      signal?: AbortSignal,
    ) => Promise<{ content: string; usage?: import("../types.js").ModelTokenUsage; requestCharacters: number }>;
  };
  /**
   * Experimental best-of-N scene prose sampling (scenePipeline.candidateCount > 1):
   * model used for fact-preserving plain-text rewrites of each submitted scene.
   * Absent = feature off; rewrite failures always fall back to the original prose.
   */
  sceneCandidates?: {
    model: ModelConfig;
    /**
     * Reader-side selector: picks the winning candidate by judgment rather than by
     * rule score. Absent = deterministic rerank only.
     */
    judgeModel?: ModelConfig;
    signal?: AbortSignal;
  };
  /**
   * Chapter-cached voice evidence for candidate rewrites: one exemplar window is
   * sampled per draft and shared by every scene's rewrite calls. Reset per chapter.
   */
  sceneStyleEvidence?: { forPath: string; text: string };
  /**
   * stylePriorNotes returned by begin_chapter_draft, stashed so the agent loop can
   * re-inject them into each scene-boundary handoff after the begin exchange has
   * been truncated out of the request. Reset per chapter.
   */
  chapterStylePriorNotes?: string[];
  /**
   * Cross-round Flash verdict memory for the style gate (sentence+subtype → verdict).
   * Keeps repeat inspects stable/cheap and powers the sync re-gate inside
   * revise_chapter_draft_style. Reset at chapter boundaries.
   */
  proseVerdictCache?: ProseVerdictCache;
  /** Full read-only chapter preview already streamed before the first inspection. */
  chapterDraftPreviewed?: { path: string };
};

export type ToolHandlerArgs = {
  input: Record<string, unknown>;
  project: WriterProject;
  store: WriterStore;
  sessionId: string;
  emit: (event: AgentEvent) => void;
  characterScope?: number[];
  context: ToolExecutionContext;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};
