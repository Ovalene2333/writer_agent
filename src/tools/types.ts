import type { AgentEvent, ModelConfig, PermissionMode } from "../types.js";
import type { WriterProject } from "../project.js";
import type { WriterStore } from "../store.js";
import type { ChapterSceneDraft, SceneActualState } from "../scene_pipeline.js";
import type { ScenePipelineSettings } from "../agent_runtime.js";
import type { ProseVerdictCache } from "../prose_adjudicate.js";

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
  /**
   * When true (write_scene delivery), propose_document / patch require a prior
   * compile_write_pack in this run so prose is grounded on diegetic materials only.
   */
  requireWritePack?: boolean;
  /** Set true after compile_write_pack succeeds this run. */
  writePackCompiled?: boolean;
  /** Last compiled write pack text (for debugging / optional agent reuse). */
  lastWritePack?: string;
  /** Scene id bound to the latest write pack while assembling a chapter. */
  writePackSceneId?: string;
  /** Full-chapter delivery uses the scene pipeline instead of a one-shot proposal. */
  requireScenePipeline?: boolean;
  /** Current project scene-chain guidance and enforced per-chapter limit. */
  scenePipelineSettings?: ScenePipelineSettings;
  /** In-run chapter draft; never writes a partial chapter to the project. */
  chapterSceneDraft?: ChapterSceneDraft;
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
   * Cross-round Flash verdict memory for the style gate (sentence+subtype → verdict).
   * Keeps repeat inspects stable/cheap and powers the sync re-gate inside
   * revise_chapter_draft_style. Reset at chapter boundaries.
   */
  proseVerdictCache?: ProseVerdictCache;
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
