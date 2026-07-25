import type { AgentEvent, ModelConfig, PermissionMode } from "../types.js";
import type { WriterProject } from "../project.js";
import type { WriterStore } from "../store.js";
import type { ChapterSceneDraft, SceneActualState } from "../scene_pipeline.js";
import type { ScenePipelineSettings } from "../agent_runtime.js";
import type { ProseVerdictCache } from "../prose_adjudicate.js";
import type { ModelUsageReporter } from "../model_usage.js";
import type { IsolatedWriterVoiceEvidence } from "../style_grounding.js";
import type { ChapterReviewInput, ChapterReviewResult } from "../chapter_review.js";
import type { ChapterStyleRepairIssue, ChapterStyleEdit } from "../chapter_style_repair.js";
import type { DocumentLocatorCandidate, DocumentLocatorMatch } from "../document_locator.js";
import type { DocumentRevisionInput } from "../document_revision.js";
import type {
  IsolatedSceneWriterInput,
  IsolatedSceneWriterResult,
  SceneStateExtractionInput,
  SceneStateExtractionResult,
} from "../isolated_scene_writer.js";

/** Compact cross-chapter handoff captured when a chapter draft is proposed. */
export type CompletedChapterHandoff = {
  path: string;
  sceneCount: number;
  finalActualState?: SceneActualState;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ToolExecutionContext = {
  permissionMode: PermissionMode;
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
  /** Optional UI-selected scope for compact/simple character cards. */
  simpleCharacterScope?: number[];
  /**
   * When true (outline mode), propose_document / propose_document_patch targeting
   * outline paths require a successful design_creative_outline earlier in this run.
   * Local propose_outline_patch is never gated.
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
  /** In-run narrative draft; never writes a partial document to the project. */
  chapterSceneDraft?: ChapterSceneDraft;
  /**
   * Cached reuse-reference prose for the current chapter draft (previous chapter
   * body, plus base content in append mode). Feeds the verbatim-recycle metric and
   * scene anti-formula hints without re-reading files on every scene write.
   */
  priorProseContext?: { forPath: string; text: string };
  /**
   * Set by propose_chapter_draft on success (before clearing the draft) so the
   * agent loop can reset per-chapter context while keeping continuity facts.
   */
  completedChapterHandoff?: CompletedChapterHandoff;
  /**
   * Cheap model (flash/summarizer/inline) for rule→snippet prose second pass.
   * When omitted, style checks stay rules-only.
   */
  proseAdjudicator?: {
    model: ModelConfig;
    signal?: AbortSignal;
  };
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
  /** Opt-in prose-only scene generation followed by a separate state extraction call. */
  isolatedSceneWriter?: {
    model: ModelConfig;
    stateModel: ModelConfig;
    signal?: AbortSignal;
    run?: (
      model: ModelConfig,
      input: IsolatedSceneWriterInput,
      signal?: AbortSignal,
    ) => Promise<IsolatedSceneWriterResult>;
    extractState?: (
      model: ModelConfig,
      input: SceneStateExtractionInput,
      signal?: AbortSignal,
    ) => Promise<SceneStateExtractionResult>;
  };
  /** Exemplar + continuation voice slots cached for the isolated writer during the chapter. */
  isolatedSceneVoiceSample?: { forPath: string; evidence: IsolatedWriterVoiceEvidence };
  /** Template + craft baseline for the isolated writer; project-scoped, built once. */
  isolatedSceneStyleDirectives?: string;
  /** Complete prose retained when only isolated state extraction failed. */
  isolatedPendingScene?: {
    forPath: string;
    sceneId: string;
    content: string;
    writerInputCharacters: number;
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
