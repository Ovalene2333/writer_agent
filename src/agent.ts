import type {
  AgentEvent,
  AgentTodoItem,
  MessageAttachment,
  MessageAttachmentInput,
  MessageContent,
  ModelConfig,
  PermissionMode,
  RequestComponentUsage,
  StepUsage,
} from "./types.js";
import { createHash } from "node:crypto";
import {
  chapterSceneDraftComplete,
  nextChapterScene,
  type ChapterSceneDraft,
  type ChapterSceneReviewCycle,
} from "./scene_pipeline.js";
import { documentSpans } from "./document_spans.js";
import { documentKind, resolveOutlineSourcePath, WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { OutlineStore } from "./outline.js";
import { logModelRequest, logModelResponse } from "./model_debug.js";
import { proseCompressionGuidance, proseMannerismPreflightLine } from "./prose_quality.js";
import { PROSE_TARGET_BAND_TEXT, resolveTurnProseLength, type TurnProseLength } from "./prose_length.js";
import { dynamicStyleGroundingPrompt, isIntensiveWritingMode, stableStyleGroundingPrompt } from "./style_grounding.js";
import { calculateUsageCost } from "./pricing.js";
import { buildRecordedUsageEvent } from "./model_usage.js";
import { modelFetch } from "./model_fetch.js";
import { loadProseGateRules } from "./prose_gate_rules.js";
import { authorPoliciesForTarget, loadAuthorPolicies } from "./author_policies.js";
import { extractWritingMemory } from "./writing_memory.js";
import { characterConstraintHash, characterConstraintView, characterWritingConstraintView } from "./character_constraints.js";
import { beginPrefixCacheObservation, finishPrefixCacheObservation } from "./prefix_cache.js";
import {
  buildMultimodalUserContent,
  isDeepSeekModel,
  messageContentCharCount,
  messageContentText,
  modelSupportsMultimodal,
  nonThinkingRequestOptions,
  prepareMessagesForProvider,
  samplingRequestOptions,
  thinkingRequestOptions,
} from "./model_compat.js";
import {
  modelCompletionEndpoint,
  streamProviderCompletion,
  usesResponsesApi,
  type ProviderWireMessage,
} from "./model_api.js";
import {
  completionRecoveryPrompt,
  contractAllowsTool,
  createAgentExecutionProgress,
  inferWritingQualityProfile,
  inferWritingWorkflowKind,
  resolveAgentPlanningStrategy,
  type AgentCapability,
  type AgentEvidenceRequirement,
  type AgentMutationRequirement,
  type AgentPlanningStrategy,
  type AgentTaskContract,
  type AgentTaskOutcome,
} from "./agentic_runtime.js";
import { AgentLoopRuntime } from "./agent_loop.js";
import { writingWorkflowPrompt } from "./writing_workflow.js";
import {
  createProposalRetryState,
  decideProposalFailure,
  isExpectedRhythmPolish,
  PROPOSAL_REVISION_MISSING_DOCUMENT_HASH,
  proposalFailureGate,
  proposalIssueTransition,
  proposalRetryStateAtGate,
  proposalRevisionIssueId,
  proposalRevisionScopeKey,
  type ProposalIssueTransition,
  type ProposalRetryGate,
  type ProposalRetryState,
  type ProposalRevisionCase,
  type ProposalRevisionIssue,
} from "./proposal_retry.js";
import { boundedRepairPacket, normalizeRepairPacket, type RepairPacket } from "./repair_packet.js";
import { approximateMessageTokens, freezeTurnBlock, loadReplayMessages, mergedTurnContext } from "./turn_replay.js";
import {
  buildProjectTrunk,
  chapterHandoffKey,
  chapterHandoffLabel,
  formatActiveHandoffsForPrompt,
  type AssembleSlicePayload,
  type ChapterHandoffPayload,
  type EpochCacheStats,
  type ProjectTrunkPayload,
} from "./context_graph.js";
import {
  DEFAULT_SCENE_NOTES_CHARACTERS,
  formatTodosForPrompt,
  loadAgentSettings,
  permissionModeLabel,
  isSuccessfulDocumentSubmission,
  persistAdvancedTodosAfterProposal,
  persistCompletedCharacterTaskTodos,
  persistScenePipelineTodos,
  projectInstructionsPrompt,
  proposalIdFromToolResult,
  skillsCatalogPrompt,
  type ScenePipelineSettings,
  type WritingExecutionMode,
} from "./agent_runtime.js";
import {
  TOOL_NAMES,
  agentToolsForTask,
  executeTool,
  parseChapterNumber,
  chapterTitleMatches,
  expandOutlineFamily,
  previousPath,
  safeReadHeading,
  type CompletedChapterHandoff,
  type MaterialsShelfEntry,
  type ToolCall,
  type ToolExecutionContext,
  type ToolDefinition,
} from "./tools/index.js";

type ApiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  tool_call_id?: string;
  tool_calls?: ApiToolCall[];
  reasoning_content?: string;
};

type ApiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type SubmittedProposalRef = {
  id: number;
  path: string;
  summary: string;
  afterContent: string;
};

export { agentToolNames, agentToolSchemaHash, agentToolsForTask } from "./tools/index.js";
export type { ProposalRevisionCase, ProposalRevisionIssue } from "./proposal_retry.js";

/**
 * =============================================================================
 * PROMPT / PREFIX-CACHE CONTRACT (read before editing any agent prompt)
 * =============================================================================
 * Providers (e.g. DeepSeek) bill cache hits far cheaper than misses. Hits require
 * a byte-stable longest common prefix on the request. Follow these rules whenever
 * you add or rewrite prompts, system slots, tools, or message assembly:
 *
 * 1) MESSAGE ORDER — stable first, project trunk, replayed history, this turn last
 *    [tools schema]
 *    [buildStableSystemPrefix: 6 fixed system slots]
 *    [project trunk: 1 system — outline skeleton + character index + lore paths]
 *    [frozen turns 1..N-1, replayed byte-verbatim from immutable replay commits]
 *    [this turn's dynamic block]
 *      turn 1 : buildDynamicTurnMessages — 8 fixed system slots + 1 user
 *      turn 2+: mergedTurnContext — ONE user message (see rule 4b)
 *    [assistant / tool turns appended during the job]
 *    Never insert optional system messages *between* stable slots; use the
 *    existing placeholder text when a block is empty so slot indices never shift.
 *    Trunk is pinned for one replay epoch (not frozen into turn blocks). Material
 *    edits append one authoritative update in the dynamic tail; the pinned bytes
 *    and replay before that update keep hitting. A semantic clear rolls the trunk.
 *    Each finished turn is frozen (freezeTurnBlock) and replayed on the next turn,
 *    so the only new bytes in turn N are turn N's own block. Replay is VERBATIM —
 *    never lean-ify a block on the way out, or the common prefix ends right there.
 *    Boundaries reported to the observers: stableMessageCount(6) ≤ trunkEnd ≤
 *    replayedMessageCount ≤ initialMessageCount.
 *
 * 2) STABLE PREFIX (cross-turn cache)
 *    writingSystemPrompt, executionRulesPrompt, project instructions, skills
 *    catalog, stableStyleGroundingPrompt, fixed mode-extra placeholder.
 *    Prefer timeless project rules here. Avoid per-request paths, chapter text,
 *    timestamps, todos, “当前任务”, audit REVIEW text, or intensive-only gates.
 *    Slot 4/5 must not flip between brainstorm / write / audit — put mode-specific
 *    and sample bodies in the dynamic tail. Frequent copy edits to stable text
 *    invalidate everyone's cache — batch them.
 *
 * 3) THIS TURN'S DYNAMIC BLOCK (the only miss-priced bytes — keep short)
 *    task/dynamicContext (+ audit REVIEW when needed), dynamic style evidence
 *    (范文/章节样本), bootstrap index, todos, work-memory catalog, user selection,
 *    current user request. Prefer digests / ids / paths; full prose belongs in
 *    tool results or read_conversation paging, not auto-injection.
 *    From turn 2 the history preview and conversationStats (total / characters /
 *    lastMessageId) are deliberately DROPPED: the real transcript is now in the
 *    request, and those counters change every single turn — sitting at the front
 *    of the tail they pinned the divergence point at slot 0 and made every stable
 *    slot behind them unreachable. Do not reintroduce a per-turn counter here.
 *    dynamicContextPrompt states that earlier「当前任务」blocks are historical, so
 *    replayed instructions cannot be mistaken for live ones.
 *
 * 4) APPEND-ONLY WITHIN ONE runAgent JOB
 *    After the first streamCompletion, do not mutate earlier messages (no mid-job
 *    compactRuntimeMessages / rehydrate / stripStaleReasoning / compactCompletedToolCalls).
 *    Compactors are only for rebuilding a transcript outside an active job.
 *    Cross-turn this extends to the immutable frozen chain: loadReplayMessages may compact
 *    or drop whole turns, but only *before* the job's first request, and it writes
 *    and atomically publish a new head so the shrink is paid for exactly once and
 *    then becomes the new cacheable prefix. Old commits remain an archived branch.
 *    Never rewrite replayed bytes on the fly. Edit/rerun moves the head to the
 *    owning source_message ancestor before deleting dialogue rows.
 *    Sole exceptions — boundary truncations (never rewrites, so the surviving
 *    prefix still cache-hits):
 *    a) Chapter boundary: after a successful proposal with further writing steps,
 *       truncate back to the initial stable+dynamic prefix and append one compact
 *       handoff (chapterContinuationPrompt), so the next chapter stops paying the
 *       previous chapter's scene transcript every step.
 *    b) Scene boundary: after each successful scene-write tool, truncate back
 *       to the post-begin context base (prep reads + initial scene guide survive) and
 *       append one compact handoff (sceneContinuationPrompt), so later scenes stop
 *       paying earlier scenes' full prose; inspect_chapter_draft reviews the
 *       assembled chapter in an isolated call and returns a compact report.
 *    Mid-job injections (both handoffs and the no-tool retry) MUST use role
 *    "user", never "system": DeepSeek re-renders any request whose history has
 *    a system message after assistant/tool turns under a different template —
 *    measured 2026-07-17 (v4-pro): trailing-system request hit 0 cached tokens
 *    against an identical warmed prefix; the same bytes as trailing-user hit
 *    the full prefix. A system handoff therefore pays a full-context cache
 *    miss at every scene boundary.
 *    Rechecked 2026-07-27 (v4-flash, full 44-tool schema): append + trailing-user
 *    hit 11,520/11,643 prompt tokens; trailing-system hit 0/11,642. Truncating to
 *    the cached scene base + trailing-user still hit 11,520/11,549, so keep the
 *    current user-role handoffs and boundary truncation. A 123-token new tail did
 *    not extend the reported hit on exact replay; do not assume tiny suffixes are
 *    immediately cacheable without accounting for provider cache-block granularity.
 *
 * 5) NO `system` MESSAGE MAY FOLLOW ASSISTANT/TOOL HISTORY — EVER
 *    The measurements in rule 4 are not a scene-boundary detail; they constrain
 *    the whole layout. Consequences, all of them hard requirements:
 *    a) From turn 2 the dynamic block MUST be a single role "user" message
 *       (mergedTurnContext), because frozen turns now precede it. The eight
 *       system slots keep their exact text and order — only the container
 *       changes. Turn 1 keeps today's 8-system + 1-user shape verbatim, since
 *       nothing precedes it. agent_cache.test.ts locks both shapes.
 *    b) freezeTurnBlock drops any system message that appears after the
 *       transcript starts, and drops dangling tool_calls / orphan tool results
 *       (a provider 400 otherwise). On a healthy turn both are no-ops, which is
 *       what keeps replay byte-verbatim.
 *    c) reasoning_content is KEPT in frozen blocks: the live loop already
 *       replays it between steps, so it is part of the prefix the provider has
 *       cached — stripping it would move the divergence to the first assistant
 *       turn.
 *
 * 6) TOOLS SCHEMA
 *    src/tools/schema.ts TOOLS is the stable universal capability catalog. Keep
 *    it byte-identical throughout a job and across task modes. The semantic task
 *    contract authorizes side effects at execution time; a fallible mode label
 *    must never make recovery/read capabilities disappear.
 *
 * 7) TASK CONTRACT COMPILER
 *    compileWritingTaskContract is a small, tool-free Flash call. It declares the
 *    outcome, evidence and mutation obligations but does not prescribe a frozen
 *    execution path. The main Agent owns and revises the live plan from tool facts.
 *
 * 8) DEDUPE
 *    Prefer one compact rule + cross-reference over pasting the same mannerism /
 *    craft checklist into system + style + task workflow + review.
 *
 * Roleplay (src/roleplay.ts) is a separate path with its own fixed 4-slot system
 * prefix (stable cards | summary | memory card | anti-formula) + short recent
 * window; long archives still use inspect_conversation + read_conversation on
 * the agent path, not a fat auto-history.
 * =============================================================================
 */

type ToolAccumulator = ToolCall;

type PrefixCacheRequestContext = {
  projectRoot: string;
  sessionId: string;
  jobId?: string;
  callKind: string;
  step?: number;
  stableMessageCount: number;
  initialMessageCount: number;
  replayedMessageCount?: number;
  replayHeadCommitId?: string;
  projectSnapshotHash?: string;
};

type WritingTaskMode = "brainstorm" | "outline" | "write_scene" | "rewrite" | "audit" | "character" | "simple_character" | "general";
type DocumentContextMode = "none" | "search" | "target" | "continuation";
type CreativeDepth = "explore" | "shape" | "deliver";
export type EditScope = "point" | "section" | "document";
type AgentRoleModels = Partial<Record<"agent" | "image" | "inline" | "writer" | "reviewer" | "summarizer", ModelConfig>>;

export interface PlannedProseGateCandidate {
  id: string;
  title: string;
  userIntent: string;
  semanticCriterion: string;
  evidenceRequirement: string;
  allowConditions: string[];
  revisionIntent: string;
  enforcement: "observe" | "advise" | "block";
  status: "draft" | "trial";
  skillId?: string;
  sourceFeedback: string;
}

interface WritingTask extends AgentTaskContract {
  mode: WritingTaskMode;
  label: string;
  searchQuery: string;
  characterIds: number[];
  exampleIds: number[];
  documentContext: DocumentContextMode;
  creativeDepth: CreativeDepth;
  editScope: EditScope;
  documentProposalRequired: boolean;
  continuation: boolean;
  todoPlan: string[];
  /** Independent document outputs requested by the user; scenes/checks inside one document are not deliverables. */
  documentDeliverables: string[];
  proseGateCandidate?: PlannedProseGateCandidate;
  targetPath?: string;
}

/** Parse the planner's single JSON object without accepting surrounding prose. */
export function parsePlannerJson(content: string): Partial<WritingTask> | undefined {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Partial<WritingTask>
      : undefined;
  } catch {
    return undefined;
  }
}

function dsmlMarkerIndex(text: string): number {
  const patterns = [
    /<\s*[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]/i,
    /[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]\s*tool_calls/i,
    /[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]\s*invoke\s+name=/i,
  ];
  const matches = patterns
    .map(pattern => text.search(pattern))
    .filter(index => index >= 0);
  return matches.length ? Math.min(...matches) : -1;
}

export function stripDsmlText(text: string, fallback = ""): string {
  const marker = dsmlMarkerIndex(text);
  if (marker < 0) return text;
  return text.slice(0, marker).trim() || fallback;
}

function createVisibleTextFilter(onText: (text: string) => void): { push: (text: string) => void; flush: () => void } {
  let buffer = "";
  let hidden = false;
  const holdBack = 96;
  return {
    push(text: string) {
      if (!text || hidden) return;
      buffer += text;
      const marker = dsmlMarkerIndex(buffer);
      if (marker >= 0) {
        const visible = buffer.slice(0, marker);
        if (visible) onText(visible);
        buffer = "";
        hidden = true;
        return;
      }
      if (buffer.length > holdBack) {
        const visible = buffer.slice(0, -holdBack);
        buffer = buffer.slice(-holdBack);
        onText(visible);
      }
    },
    flush() {
      if (!hidden && buffer) onText(buffer);
      buffer = "";
    },
  };
}

function parseDsmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g;
  for (const match of source.matchAll(pattern)) attributes[match[1]] = match[2];
  return attributes;
}

function decodeDsmlValue(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractDsmlToolCalls(content: string): { content: string; toolCalls: ToolAccumulator[] } {
  const marker = dsmlMarkerIndex(content);
  if (marker < 0) return { content, toolCalls: [] };

  const dsml = content.slice(marker);
  const invokePattern = /<\s*[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]\s*invoke\b([^>]*)>/gi;
  const paramPattern = /<\s*[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]\s*parameter\b([^>]*)>([\s\S]*?)<\s*\/\s*[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]\s*parameter\s*>/gi;
  const invokes = [...dsml.matchAll(invokePattern)];
  const toolCalls: ToolAccumulator[] = [];

  for (let index = 0; index < invokes.length; index += 1) {
    const invoke = invokes[index];
    const attrs = parseDsmlAttributes(invoke[1] ?? "");
    const name = attrs.name;
    if (!name || !TOOL_NAMES.has(name)) continue;
    const start = (invoke.index ?? 0) + invoke[0].length;
    const end = index + 1 < invokes.length ? invokes[index + 1].index ?? dsml.length : dsml.length;
    const body = dsml.slice(start, end);
    const input: Record<string, unknown> = {};
    for (const param of body.matchAll(paramPattern)) {
      const paramAttrs = parseDsmlAttributes(param[1] ?? "");
      const paramName = paramAttrs.name;
      if (!paramName) continue;
      const key = name === "write_file" && paramName === "payload" ? "content" : paramName;
      input[key] = decodeDsmlValue(param[2] ?? "");
    }
    toolCalls.push({
      id: `dsml_${Date.now()}_${index}`,
      name,
      arguments: JSON.stringify(input),
    });
  }

  return { content: content.slice(0, marker), toolCalls };
}

export function modelConfigFromEnv(): ModelConfig {
  return {
    baseUrl: process.env.WRITER_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.WRITER_API_KEY || "",
    model: process.env.WRITER_MODEL || "gpt-4.1-mini",
  };
}

/**
 * Stable-prefix slot 0. Project/language-level identity and hard rules only.
 * CACHE: Keep text stable; put turn-specific instructions in dynamicContextPrompt /
 * taskInstructions, not here. Style details → style_grounding (stable vs dynamic split).
 */
function writingSystemPrompt(project: WriterProject): string {
  const config = project.config();
  const styleTemplate = config.style ? project.styleTemplate(config.style) : undefined;
  // Short pointer only; craft/mannerism + samples live in style slots (stable/dynamic).
  const stylePointer = styleTemplate
    ? `激活风格：${styleTemplate.name}（细则与样本见「风格锚定」/动态声线证据）。`
    : "未激活风格模板时，正文贴合本项目既有章节声线（见「风格锚定」）。";
  return `你是长篇创作 Agent。界面中文，作品语言 ${config.language}。${stylePointer}
职责：构思、规划、写作、改写、审校；当前用户请求优先，作者保留最终决定。

创作立场：成人向虚构可直接写暴力/情欲/权谋/残酷/粗口；勿道德说教或自行软化；直写用具体名词与动作。法律边界：不协助现实犯罪；不生成针对真实未成年人的性内容。

分区：lore/=设定事实；outline/=情节计划；chapters/=主线正文；side/=支线；archive/=旧稿（仅人工浏览，Agent 不可搜索/读取，不作现行事实）；characters/=结构化角色卡。旧 story/ ≡ lore/。

正文底线（正文/续写/改写/终审；构思可大胆但须标明非既有事实）：
1. 用动作、选择、代价、对白与感官呈现；勿在其后追加情绪/象征解释。
2. 动作有结果；因果可拆句；保留对白拖音/中断/迟疑。
3. 对白服从身份与目的；角色卡声线只约束所属角色说出口的对白，叙述和其他角色各自服从项目文风与自身角色卡；场景落在动作、决定、发现或未决问题上。
4. 不得把未支撑设定冒充既有事实；区分项目事实 / 推断 / 候选。
5. 角色演进须有正文/大纲/用户依据。正文落盘后的确认事实→apply_character_changes；伏笔/传闻/失败尝试不得解锁。新建或大改用 save_character。
6. 句式硬约束与声线自检见「风格锚定」（勿在此重复粘贴）。
`;
}

/**
 * Stable-prefix slot 1. Tool/workflow policy by permission mode.
 * CACHE: Only permissionMode should change this string within a session; do not
 * embed the current user request, paths, or chapter excerpts.
 */
function executionRulesPrompt(mode: PermissionMode): string {
  const modeRule = mode === "plan"
    ? "3. plan：只检索/构思/塑形；禁止 write_file / edit_file / move_file / delete_file / save_character / apply_character_changes / save_simple_character。默认短而开放，勿自动扩成完整交付。"
    : mode === "auto"
      ? "3. auto：正文/续写/改写必须用 write_file/edit_file 交付（通过门禁后自动落盘），禁止用最终回复代替正文。清单若仍有未完成的章节/正文步骤则继续写；仅当清单无后续写作项时停止。"
      : "3. 正文/续写/改写必须用 write_file/edit_file 交付，禁止用最终回复代替。清单若仍有未完成的章节/正文步骤则继续写；仅当清单无后续写作项时停止等待审批。";
  return `执行规则：
1. 需项目事实时先 search_files，再用 read_file 读最小片段；每轮最多搜索 2 次。区分事实与推测。
2. 保持人物/世界观/视角与文件格式。局部修改→edit_file；新建或全文重写→write_file。设定→lore/，大纲→outline/，正文→chapters/。
${modeRule}
4. 完整/长对话或扮演史：注入历史仅为预览。须 inspect_conversation，再 read_conversation 从 afterId=0 分页至 hasMore=false。简易卡用 list/get_simple_characters，与普通卡分离。
5. 仅当缺少目标文档/关键事实且无法推断时 ask_user；可逆创作选择自行决定。询问后立即停止。
6. 普通角色卡按任务分层读取：写作/构思先 get_character(view=summary)，capabilityIndex 的 availability 只用于选择能力与场景模式；正文要处理能力时必须在场景 competencyUses 声明 use/attempt/unlock/regain/lose，再用 get_character(view=sections, sections=["competencies"], competencyIds=[...]) 读取机制、限制与本场状态指令。明确编辑直接用 view=edit+sections 读取目标编辑分区，跨分区重做才用不带 sections 的 view=edit，禁止编辑任务先做无意义摘要读取。save_character 更新已有卡必须传最近读取所得 expectedUpdatedAt。已确认的能力状态演进用 apply_character_changes.set_competency_state；新建/大改→save_character；简易卡→save_simple_character。路人配角可只写正文不建卡。
7. read_file 默认读取本轮最新工作副本；只复用本轮工作记忆、本轮工具结果与 reused 标记，禁止同路径反复读、禁止重复 list_outline_nodes。写作线索未验证；大纲 id 为 UUID。artifact_compacted 只用 digest。
8. 内置章节场景四阶段由工具结果自动推进，禁止为勾选这些阶段单独调用 manage_todos；仅自定义清单需要更新。同时至多一项 in_progress。
9. 技能描述与当前任务明确匹配，或修订问题给出 skillId 时，必须先 load_skill；只在正文不足时用 read_skill_resource 读取声明资源。勿编造技能。Skill 只增强判断，不自动构成固定工具流程，也不代替门禁。
10. resource/ 内所有可见 UTF-8 文本统一使用 list_files / search_files / read_file / write_file / edit_file / move_file / delete_file。写入先进入本轮工作副本；正文自动走质量门禁，其他变更走普通审批。禁止访问 resource/ 外、archive/、屏蔽路径、二进制文件或符号链接。
11. 作者明确把某类正文问题概括为今后持续检查/避免的要求时，用 manage_author_policies upsert 沉淀。新偏好默认 trial，含糊反馈只存 draft；没有明确放行条件不得 block。只改当前一句或一次性选择不要学习。旧 manage_prose_gates 仅兼容已有规则。
12. 不泄露内部参数；对话简洁；文档适量 Markdown。
13. generate_image 必须独占一步：同一步不得与其他工具并行调用；先完成检索/清单等准备，下一步再单独生图。用户要求修改、延续或参考既有图片时，必须从动态「可用图片参考」选 attachment ID 填入 referenceAttachmentIds；不可只靠文字复述原图。
模式：${permissionModeLabel(mode)}`;
}

/**
 * Dynamic-tail task block (miss-priced every turn). Mode workflows + scope only.
 * CACHE: OK to be turn-specific; keep structuredCreativeContext slim (ids/fingerprints,
 * not full example bodies — those belong in dynamicStyleGroundingPrompt when intensive).
 */
export function dynamicContextPrompt(
  project: WriterProject,
  store: WriterStore,
  request: string,
  task: WritingTask,
  permissionMode: PermissionMode,
  scenePipeline: ScenePipelineSettings,
  writingMode: WritingExecutionMode,
  characterEvolutionEnabled: boolean,
  characterScope?: number[],
  continuationPath?: string,
  simpleCharacterScope?: number[],
  resumeInterrupted?: boolean,
  proseLength?: TurnProseLength,
  runDeliverables?: ReadonlyArray<{ id: string; label: string }>,
): string {
  const explicitReferences = explicitReferencePaths(project, request);
  const inferredTargets = task.targetPath && !explicitReferences.includes(task.targetPath) ? [task.targetPath] : [];
  const references = [...new Set([...explicitReferences, ...inferredTargets])];
  const creativeContext = structuredCreativeContext(store, task, characterScope, simpleCharacterScope);
  // Scope only gates reading/listing *existing* cards and relationship targets — not prose NPCs or new cards.
  const characterScopeInstruction = characterScope === undefined
    ? "角色按相关性筛选。list/get_character 可读已有普通卡；演进→apply_character_changes；新建/大改→save_character；简易卡→save_simple_character。"
    : characterScope.length
      ? `可读已有角色 ID：${characterScope.join("、")}。不得读取/关联范围外已有角色；仍可写路人配角或 save_character 新建。`
      : "不加载已有角色卡；仍可写人物或 save_character 新建。";
  const simpleCharacterScopeInstruction = simpleCharacterScope === undefined
    ? "简易卡不限；可按需 list/get_simple_characters。"
    : simpleCharacterScope.length
      ? `可读简易卡 ID：${simpleCharacterScope.join("、")}。`
      : "不加载已有简易卡；仍可新建。";
  const characterEvolutionInstruction = characterEvolutionEnabled
    ? "开启。正文落盘后可按现有规则调用 apply_character_changes。"
    : "关闭。不得调用 apply_character_changes；显式新建或编辑角色卡仍可使用 save_character。";
  const documentInstruction = task.documentProposalRequired
    ? `必须成功调用 write_file、edit_file、move_file 或 delete_file 完成请求后结束，禁止用最终回复代替文件交付。完整新建/替换用 write_file，局部修改和驳回修订用 edit_file；运行时自动绑定交付项、篇幅目标、审查与审批。工作副本已有目标原文且未变时直接继续。${runDeliverables && runDeliverables.length > 1 ? `本轮独立交付项：${JSON.stringify(runDeliverables)}。按目标路径依次交付，交付项 ID 由运行时绑定。` : ""}${continuationPath ? `承接续写默认目标：${continuationPath}。` : ""}`
    : "不强制文件写入；需要修改 resource/ 文本时按用户意图使用 write_file/edit_file。";
  const proseGateInstruction = task.proseGateCandidate
    ? permissionMode === "plan"
      ? `planning 已识别出可复用的作者复审候选；plan 只读模式不得保存。向作者说明拟沉淀规则，不要声称已经生效。候选：${JSON.stringify(task.proseGateCandidate)}`
      : `planning 已确认当前反馈是可复用的作者政策候选。结束前必须调用 manage_author_policies(operation=upsert) 原样保存下列结构化候选，并补 scope={documentKinds:["chapter","side"],pathPrefixes:[],characterIds:[],sceneKinds:[]}；当前文档修改不能替代政策沉淀：${JSON.stringify(task.proseGateCandidate)}`
    : "planning 未识别到需要沉淀的作者复审候选；不要把一次性改稿偏好自动保存。";
  const policyTargetKind = task.targetPath ? documentKind(task.targetPath)
    : task.mode === "write_scene" || task.mode === "rewrite" || task.mode === "audit" ? "chapter" : "other";
  const activePolicies = authorPoliciesForTarget(loadAuthorPolicies(project), {
    kind: policyTargetKind,
    ...(task.targetPath ? { path: task.targetPath } : {}),
    characterIds: task.characterIds.map(String),
  }).slice(0, 8);
  const activePolicyContext = activePolicies.length
    ? activePolicies.map(policy => ({
        id: policy.id,
        version: policy.version,
        status: policy.status,
        enforcement: policy.enforcement,
        intent: policy.userIntent.slice(0, 240),
        ...(policy.skillId ? { skillId: policy.skillId } : {}),
      }))
    : [];
  const editScopeInstruction: Record<EditScope, string> = {
    point: "局部修改：用 read_file 的 quote 或行范围读取原句与必要上下文，再用 edit_file 对唯一 oldText 做最小修改。",
    section: "分节修改：用 search_files/read_file 定位目标范围与必要接缝，再用 edit_file 只修改命中范围，不读取无关章节。",
    document: task.mode === "rewrite"
      ? "通篇修改：读取完成任务所需的原文后用 write_file 提交完整工作副本；若局部修改已足够，优先用 edit_file。"
      : scenePipeline.enabled
        ? "完整交付：根据篇幅、连续性风险和现有材料，自主选择直接成稿或场景草稿链；不要为了遵循流程而拆场。"
        : "完整交付：场景链已关闭，直接成稿并用 write_file 交付；不要调用章节场景链工具。",
  };
  const contextInstruction: Record<DocumentContextMode, string> = {
    // Soft none: pure craft may skip tools, but never invent lore when the user names project entities.
    none: "默认不读文件。泛化技巧/闲聊可直接答；若用户点名项目专名、组织、势力、世界观实体，且历史未给出可核对事实，先 search_files（优先 lore/），再按结果读取必要资料。禁止把推测写成既有设定。",
    search: task.mode === "simple_character"
      ? `建简易卡：先 list_characters 查同名，必要时 get_character；search_files 查询 lore/outline：${task.searchQuery || request.slice(0, 120)}；不足再 read_file 最小片段；最后 save_simple_character。`
      : task.mode === "character"
        ? `处理普通角色卡：先 list_characters 查同名并查看分区目录；已有同名卡若修改范围明确，直接 get_character(view=edit, sections=[待修改分区])，跨分区重做才用不带 sections 的 view=edit，禁止先读 summary；保存时携带原 id 与读取所得 expectedUpdatedAt。禁止另建简易卡或同名普通卡。按需 search_files 查询 lore/outline：${task.searchQuery || request.slice(0, 120)}；只读最小必要资料。`
      : `先 search_files（设定/组织/专名优先 lore/）：${task.searchQuery || request.slice(0, 120)}。不足再 read_file；同路径只读一次最小范围。不得用推测冒充项目事实。`,
    target: `需目标文件。${references.length ? `候选：${references.join("、")}。` : "先定位路径。"}工作记忆已有且未变则复用；否则 read_file 一次最小范围，禁止重复读。`,
    continuation: `承接正文。${continuationPath ? `目标：${continuationPath}。` : "从对话/文件结果确定路径。"}记忆有末尾且未变则续写；否则 read_file 读取末尾必要范围。`,
  };
  const reviewBlock = task.mode === "audit" ? `\n\n${REVIEW_PROMPT}` : "";
  // 作者定的篇幅，不是模型按事件密度自己拍的。来源写出来，作者一看就知道这个数字
  // 是他这句话带来的还是项目默认档。
  const proseLengthLine = proseLength && (task.documentProposalRequired || task.mode === "write_scene" || task.mode === "rewrite")
    ? proseLength.mode === "guidance"
      ? `\n单章篇幅参考：本轮涉及的每一章约 ${proseLength.targetCharacters} 字（${
          proseLength.source === "prompt_exact"
            ? "用户本轮指定"
            : proseLength.source === "prompt_relative"
              ? "用户本轮要求相对项目默认调整"
              : "项目默认篇幅档"
        }）。这是弱引导参考，不是本轮所有章节合计；保持场景自然完整，不因偏离目标而缩句、扩句或发起重写。场景链仍按实际故事选择每场目标。`
      : `\n单章篇幅目标：本轮涉及的每一章都分别约 ${proseLength.targetCharacters} 字（${
          proseLength.source === "prompt_exact"
            ? "用户本轮指定"
            : proseLength.source === "prompt_relative"
              ? "用户本轮要求相对项目默认调整"
              : "项目默认篇幅档"
        }）。这是每章目标，不是本轮所有章节合计；不得因本轮要写多章而均分。write_file/edit_file 会由运行时自动绑定该章目标；场景链各场之和只对齐当前这一章。用户明确为不同章节分别指定数字时，以各章指定值为准。`
    : "";
  const resumeLine = resumeInterrupted
    ? "续跑：本轮用于接续上一次中断的 Agent 任务。优先复用当前任务清单、checkpoint、工作记忆、已写草稿和已读证据；从未完成的最小下一步继续，避免重复已成功的工具动作。"
    : "";
  return `当前任务：${task.label}
任务契约：${JSON.stringify({ outcome: task.outcome, evidence: task.evidence, mutation: task.mutation, planning: task.planning, capabilities: task.capabilities, workflow: task.workflow, qualityProfile: task.qualityProfile, deliverables: runDeliverables })}
mode 只决定表达与领域工作流，不限制可见工具。根据工具事实自主选择下一步；planning=adaptive 时在发现新情况、路径失败或范围变化后用 manage_todos 修订剩余计划。
${writingWorkflowPrompt(task.workflow ?? "free", task.qualityProfile ?? "fast")}
${resumeLine}
本轮只执行最后一条 user 请求；历史仅用于指代与既有事实。仅下方「@ 明确引用」可称用户指定；契约编译器/会话推断不得冒充用户选择。
上文中出现过的历次「当前任务」区块均为历史记录，其指令、清单与终审要求都已失效；只有本区块之后的要求现在生效。
作者复审：${proseGateInstruction}
当前适用作者政策：${activePolicyContext.length ? JSON.stringify(activePolicyContext) : "无"}。写作前遵循；有 skillId 时先 load_skill。完整核验标准由正文出口独立执行，摘要不得被扩张为新的绝对规则。

${taskInstructions(
    task.mode,
    task.creativeDepth,
    permissionMode,
    task.documentProposalRequired,
    scenePipeline.notesMaxCharacters,
    writingMode === "fast",
    scenePipeline.enabled,
  )}${reviewBlock}

上下文：${contextInstruction[task.documentContext]}
角色范围：${characterScopeInstruction}
简易卡范围：${simpleCharacterScopeInstruction}
角色演进：${characterEvolutionInstruction}
写入：${documentInstruction}
修改范围：${editScopeInstruction[task.editScope]}${proseLengthLine}
写作模式：${writingMode === "fast" ? "快速模式；由当前 Agent 完成检索、编排与直接交付。" : "分工模式；主 Agent 负责检索与编排，证据型 Writer 只依据共享事实包实现正文。"}
场景草稿链：${scenePipeline.enabled ? `已开启；只有分场能实际降低连续性或长篇修订风险时才使用。推荐 ${scenePipeline.preferredMinScenes}—${scenePipeline.preferredMaxScenes} 场、最多 ${scenePipeline.maxScenes} 场，不为达到推荐数拆场；${writingMode === "fast" ? "正文与实际状态均由主 Agent 提交" : "主 Agent 提交 notes，证据型 Writer 生成正文并由运行时提取实际状态"}。` : "已关闭；禁止调用 begin_chapter_draft、write_chapter_scene、revise_chapter_scene_guide 或 inspect_chapter_draft，直接使用普通文件交付路径。"}

结构化资料（JSON；缺失≠不存在，需时用工具）：
${creativeContext}

@ 明确引用：${explicitReferences.length ? explicitReferences.map(path => path).join("、") : "无"}
系统推断候选：${inferredTargets.length ? inferredTargets.map(path => path).join("、") : "无"}`;
}

const TASK_LABELS: Record<WritingTaskMode, string> = {
  brainstorm: "创意构思与候选方案", outline: "动态大纲与情节规划",
  write_scene: "场景或章节写作", rewrite: "定向改写",
  audit: "一致性与质量审校", character: "创建或更新普通角色卡",
  simple_character: "创建或更新简易角色卡", general: "通用写作协作",
};

/**
 * Conservatively close a JSON object only when the stream ended between values.
 * Never invents or closes an unterminated string, so truncated prose cannot be
 * silently persisted as if it were complete.
 */
export function repairTruncatedToolArguments(argumentsText: string): string | undefined {
  let candidate = argumentsText.trim();
  if (!candidate.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? candidate : undefined;
  } catch { /* try structural tail closure below */ }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const character of candidate) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.pop() !== expected) return undefined;
    }
  }
  if (inString || escaped || !stack.length) return undefined;
  candidate = candidate.replace(/,\s*$/u, "");
  candidate += [...stack].reverse().map(open => open === "{" ? "}" : "]").join("");
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function buildToolArgumentRepairMessages(input: {
  toolName: string;
  rawArguments: string;
  parameterSchema: Record<string, unknown>;
}): ApiMessage[] {
  return [{
    role: "system",
    content: `你是工具参数 JSON 修复器。只输出一个可解析 JSON 对象，不得输出 Markdown 或解释。
保留原参数中已经完整表达的事实，不新增设定，不改写文案。删除未完成的末尾字段，修复引号、逗号、括号与转义。
严格遵守 parameterSchema，删除 schema 外字段。save_character 更新已有角色时必须保留 id。`,
  }, {
    role: "user",
    content: JSON.stringify({
      toolName: input.toolName,
      parameterSchema: input.parameterSchema,
      rawArguments: input.rawArguments.slice(0, 24_000),
    }),
  }];
}

export function parseToolArgumentRepair(content: string): string | undefined {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1]?.trim();
  return repairTruncatedToolArguments(fenced ?? trimmed);
}

async function repairToolArgumentsWithModel(
  model: ModelConfig,
  call: ToolCall,
  definition: ToolDefinition,
  signal?: AbortSignal,
  prefixCache?: PrefixCacheRequestContext,
): Promise<{
  arguments?: string;
  usage?: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; cacheWriteTokens?: number; estimated?: boolean };
}> {
  const messages = buildToolArgumentRepairMessages({
    toolName: call.name,
    rawArguments: call.arguments,
    parameterSchema: definition.function.parameters,
  });
  const result = await streamCompletion(model, messages, signal, () => undefined, () => undefined, {
    temperature: 0,
    topP: 1,
    ...(isDeepSeekModel(model) ? { responseFormat: { type: "json_object" as const } } : {}),
    ...thinkingRequestOptions(model),
    ...(prefixCache ? { prefixCache } : {}),
  });
  const repaired = parseToolArgumentRepair(result.content);
  return {
    ...(repaired ? { arguments: repaired } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

function isCharacterMutationTool(name: string): boolean {
  return name === "save_character" || name === "save_simple_character" || name === "apply_character_changes";
}

export function executionModelForTask(
  _task: Pick<WritingTask, "mode" | "documentProposalRequired">,
  _models: AgentRoleModels,
  fallback: ModelConfig,
): ModelConfig {
  // Keep the tool-orchestrating Agent on one model across task modes. Auxiliary
  // planner/writer/reviewer calls still use their assigned role models.
  return fallback;
}

export function normalizePlannedProseGateCandidate(value: unknown): PlannedProseGateCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim().toLowerCase() : "";
  const semanticCriterion = typeof item.semanticCriterion === "string"
    ? item.semanticCriterion.trim().slice(0, 1_200)
    : typeof item.instruction === "string" ? item.instruction.trim().slice(0, 1_200) : "";
  const sourceFeedback = typeof item.sourceFeedback === "string" ? item.sourceFeedback.trim().slice(0, 500) : "";
  const allowConditions = Array.isArray(item.allowConditions)
    ? item.allowConditions.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
      .map(entry => entry.trim().slice(0, 300)).slice(0, 20)
    : [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || !semanticCriterion || !sourceFeedback) return undefined;
  let enforcement = item.enforcement === "block" ? "block" as const
    : item.enforcement === "observe" ? "observe" as const
      : item.severity === "block" ? "block" as const : "advise" as const;
  if (enforcement === "block" && !allowConditions.length) enforcement = "advise";
  return {
    id,
    title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 100) : id,
    userIntent: typeof item.userIntent === "string" && item.userIntent.trim()
      ? item.userIntent.trim().slice(0, 1_000) : sourceFeedback,
    semanticCriterion,
    evidenceRequirement: typeof item.evidenceRequirement === "string" && item.evidenceRequirement.trim()
      ? item.evidenceRequirement.trim().slice(0, 600)
      : "引用能够独立证明该模式的最短连续原文；涉及密度或问答关系时必须包含相邻上下文。",
    allowConditions,
    revisionIntent: typeof item.revisionIntent === "string" && item.revisionIntent.trim()
      ? item.revisionIntent.trim().slice(0, 600)
      : "只修正命中问题，保留事实、人物目的、线索顺序和有效表达。",
    enforcement,
    status: item.status === "draft" ? "draft" : "trial",
    ...(typeof item.skillId === "string" && item.skillId.trim() ? { skillId: item.skillId.trim().slice(0, 64) } : {}),
    sourceFeedback,
  };
}

export function projectCacheUserId(projectRoot: string): string {
  const digest = createHash("sha256")
    .update(`writer-project-cache-v1\0${projectRoot}`)
    .digest("hex")
    .slice(0, 32);
  return `writer-project-${digest}`;
}

/**
 * Keep the semantic planner authoritative while preventing an unsupported
 * point scope from locking a multi-paragraph rewrite to its first anchor.
 */
export function normalizeRewriteEditScope(
  request: string,
  planned: EditScope | undefined,
  selectionCharacters: number,
): EditScope {
  if (selectionCharacters > 0) return "point";

  const asksForWholeDocument = /(?:通篇|全文|整篇|从头到尾|整体统一)/u.test(request);
  if (asksForWholeDocument) return "document";

  const hasQuotedText = /[“「『"]\s*[^”」』"\r\n]{1,500}[”」』"]/u.test(request);
  const namesExactPoint = /(?:这|那|此)(?:一)?句|这个词|这个字|一小处|错别字|改个词/u.test(request);
  const hasExactPointEvidence = hasQuotedText || namesExactPoint;
  if (hasExactPointEvidence) return "point";

  // A point classification without a selection or quoted/atomic target is not
  // executable safely. Fall back to the smallest context-bearing scope.
  if (planned === "point" || planned === undefined) return "section";
  return planned;
}

export function executionModelForStep(
  _taskMode: WritingTaskMode,
  agentModel: ModelConfig,
  _writerModel: ModelConfig | undefined,
  _fastWritingMode: boolean,
  _draft?: Pick<ChapterSceneDraft, "scenes" | "completed">,
): ModelConfig {
  // Fast mode is the legacy single-Agent path: the main Agent writes both direct
  // proposals and scene-chain prose. It never selects the Writer model.
  return agentModel;
}

function isChapterSceneWriteTool(name: string): boolean {
  return name === "write_chapter_scene";
}

const CHAPTER_SCENE_CONTINUATION_TOOLS = new Set([
  "write_chapter_scene",
  "revise_chapter_scene_guide",
  "revise_chapter_draft_style",
  "inspect_chapter_draft",
  "propose_chapter_draft",
]);

function characterMutationDiagnostic(result: Record<string, unknown>): string {
  const diagnostic = {
    ...(typeof result.code === "string" ? { code: result.code } : {}),
    ...(typeof result.error === "string" ? { error: result.error } : {}),
    ...(typeof result.message === "string" ? { message: result.message } : {}),
    ...(Array.isArray(result.skipped) ? { skipped: result.skipped.slice(0, 4) } : {}),
  };
  const text = JSON.stringify(diagnostic);
  return (text === "{}" ? JSON.stringify(result) : text).slice(0, 1_200);
}

/** Planner uses deterministic sampling while retaining the configured Thinking mode. */
export function plannerCompletionOptions(model: Pick<ModelConfig, "provider" | "baseUrl">): {
  temperature: number;
  topP: number;
  thinking?: { type: "enabled" };
  responseFormat?: { type: "json_object" };
} {
  return {
    temperature: 0,
    topP: 1,
    ...(isDeepSeekModel(model) ? { responseFormat: { type: "json_object" as const } } : {}),
    ...thinkingRequestOptions(model),
  };
}

export function normalizeCharacterTaskMode(request: string, plannedMode: WritingTaskMode): WritingTaskMode {
  const explicitlySimple = ["简易角色卡", "简易角色", "简易卡"].some(term => request.includes(term));
  if (plannedMode === "simple_character" && !explicitlySimple) return "character";
  if (plannedMode === "character" && explicitlySimple) return "simple_character";
  return plannedMode;
}

export function normalizeDocumentProposalRequired(mode: WritingTaskMode, requested: boolean): boolean {
  return mode === "character" || mode === "simple_character" ? false : requested;
}

export function characterMutationCompletesTask(mode: WritingTaskMode, permissionMode: PermissionMode): boolean {
  return permissionMode !== "plan" && (mode === "character" || mode === "simple_character");
}

/** Proposal continuation is authorized only by independent outputs declared in the task contract. */
export function documentDeliveryRemaining(
  documentDeliverables: readonly string[],
  completedDocumentDeliverables: number,
): boolean {
  return completedDocumentDeliverables < documentDeliverables.length;
}

/** Exact catalog resolution for short follow-ups; no semantic keyword guessing. */
export function resolveRecentCharacterIds(
  catalog: Array<{ id: number; name: string; aliases?: string[] }>,
  textsNewestFirst: string[],
): number[] {
  for (const text of textsNewestFirst) {
    const hits = catalog.filter(character =>
      [character.name, ...(character.aliases ?? [])]
        .map(value => value.trim())
        .filter(value => value.length >= 2)
        .some(value => text.includes(value)),
    );
    if (hits.length) return [...new Set(hits.map(character => character.id))].slice(0, 4);
  }
  return [];
}

/**
 * Task-contract compiler: a compact tool-free call, normally assigned to Flash.
 * CACHE: Keep stable rules in the first message and project/request data in the
 * final user message. It declares obligations and capability hints, never a
 * frozen execution path. Execution has a different prefix and is not warmed here.
 */
async function compileWritingTaskContract(
  model: ModelConfig, project: WriterProject, store: WriterStore, request: string, history: ApiMessage[], signal?: AbortSignal,
  characterScope?: number[],
  selectionCharacters = 0,
  onUsage?: (usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; cacheWriteTokens?: number; estimated?: boolean }, retry: boolean) => void,
  prefixCache?: Omit<PrefixCacheRequestContext, "callKind" | "stableMessageCount" | "initialMessageCount">,
): Promise<{ task: WritingTask }> {
  const allDocuments = project.listTextFiles().filter(path => !project.isDocumentHidden(path));
  // Cap catalog size — planner only needs path identity, not the whole monorepo dump.
  const documents = prioritizeDocumentCatalog(allDocuments, request, 80);
  const allowedCharacters = characterScope === undefined ? undefined : new Set(characterScope);
  const characters = store.characters()
    .filter(item => !allowedCharacters || allowedCharacters.has(item.id))
    .map(item => ({ id: item.id, name: item.identity.name, aliases: item.identity.aliases }));
  const activeStyleId = project.config().style;
  const activeStyle = activeStyleId ? project.styleTemplate(activeStyleId) : undefined;
  // Slim catalogs: paths / id+name only — full notes/examples inflate the miss-priced user payload.
  const examples = store.writingExamples()
    .filter(item => item.gatePassed)
    .filter(item => !item.title.startsWith("[风格模板]") || item.title === `[风格模板] ${activeStyle?.name}`)
    .map(item => ({ id: item.id, title: item.title, category: item.category }))
    .slice(0, 24);
  const recentSource = history.slice(-3);
  const recent = recentSource.map((item, index) => {
    const text = messageContentText(item.content);
    return {
      role: item.role,
      content: index === recentSource.length - 1
        ? priorTurnContentForContext(text)
        : text.slice(0, item.role === "user" ? 160 : 120),
    };
  });
  const planningMessages: ApiMessage[] = [{
    role: "system",
    // CACHE: stable planner rules only — no documents/characters/history here.
    content: `写作任务契约编译器。不得调用工具；只输出一个 JSON，无 Markdown。
JSON 总长度不超过 1600 字符；字符串保持简短，todoPlan 每项不超过 40 字。
字段：mode(brainstorm|outline|write_scene|rewrite|audit|character|simple_character|general，仅为表达风格标签)；outcome(answer|document|character|review|multiple)；evidence(none|project|target|continuation)；mutation(none|document|character|mixed)；planning(direct|adaptive)；capabilities(research|documents|files|outline|scenes|characters|review|images 的数组)；creativeDepth(explore|shape|deliver)；editScope(point|section|document)；documentContext(none|search|target|continuation)；targetPath(从目录原样选或省略)；searchQuery(search 时短查询，优先专名)；characterIds(最多4，否则[])；exampleIds(最多2，否则[])；continuation；documentDeliverables(用户明确要求的独立文档产物短标签数组，最多5项，无则[])；todoPlan(仅复杂任务给2—5个初始步骤，否则[])；proseGateCandidate(符合下述条件时输出作者政策草案，否则省略)。
契约语义：outcome 描述最终交付；evidence 描述结束前必须取得的环境事实；mutation 描述必须成功产生的写入；planning=adaptive 表示执行 Agent 应根据工具结果维护和修订计划。capabilities 可多选，禁止因 mode 单选而漏掉必要能力。
正文/大纲/文件的创建或修改必须 outcome=document、mutation=document；角色卡创建或修改必须 outcome=character、mutation=character；同一请求明确要求两类产物则 outcome=multiple、mutation=mixed；纯讨论/问答 mutation=none；只审阅不修改则 outcome=review、mutation=none，明确要求边审边修才用 document。
creativeDepth=对话交付深度：explore 开放；shape 少量方向；deliver 用户明确要求完整成品。是否必须写入只由 mutation 决定。
documentContext 判定（关键，勿默认 none）：
- none：仅泛化写作技巧、闲聊、纯灵感且不依赖项目既有专名/组织/势力/世界观事实；或所需事实已完整出现在 recentHistory。
- search：用户讨论、分析、推演项目内设定/组织/实体/专名/关系/军政势力，或答案正确性依赖 lore/outline 中未在对话里写清的事实（即使 mode=brainstorm/general 也要用 search）。searchQuery 填核心专名。
- target：用户指定或语义可确定单篇文档要读/改。
- continuation：承接上一轮正文续写。
纯文本文件管理：用户要求创建、修改、移动、删除 resource/ 内文件时，mode=general、outcome=document、mutation=document、planning=adaptive、capabilities 含 files；执行阶段统一使用 list_files/read_file/write_file/edit_file/move_file/delete_file。
图片产物：用户明确要求生成封面、插图、概念图或视觉参考时 capabilities 必须含 images；单独生图用 outcome=answer、mutation=none，若还要求文档/角色写入则保留相应 outcome 与 mutation。只讨论画面或撰写生图提示词时不要加入 images。
原则：按语义与产物判断。用户说“角色卡”时默认普通角色卡→character+search；只有明确说“简易角色卡/简易角色/简易卡”才用 simple_character+search。更新已有角色时 characterIds 必须包含目录中的目标 ID，禁止因资料为空而另建同名卡。当前 user 唯一任务；历史只解指代。指定单篇→target；承接正文→continuation。多阶段才填 todoPlan。不要因为“只是讨论”就 none——讨论项目设定仍须 search。
连续对话中，若 recentHistory 已明确当前操作对象是角色卡，当前 user 用“修复/调整/删除/改成”等省略说法继续修改该对象，仍用 character、outcome=character、mutation=character；除非当前 user 明确改为正文、大纲或 resource/ 文档任务。不得仅因动作是“修改”就判为 rewrite；rewrite 的交付对象必须是文档正文。
用户要求创作/设计一个具体人物，并主要描述其身份、外貌、性格、能力或关系时，即使没有说“角色卡”，也使用 character，outcome=character、mutation=character；只有明确要求“一段/片段/场景/章节/正文”来表现该人物时才使用 write_scene。
正文与大纲必须严格区分：用户要求“写/创建/生成/续写第N章、某一章、一个场景或正文”时，一律优先 mode=write_scene，outcome=document、mutation=document、planning=adaptive；即使项目没有大纲，也不得改判为 outline。提到“第一章”不等于要求规划后续章节。
用户引用具体正文句段并指出问题或要求修改（不合理/OOC/改掉这句/换个说法等）时，一律 mode=rewrite，outcome=document、mutation=document、evidence=target、documentContext=target；不得判为 audit（audit 只用于“审阅/检查/评价”而不动笔），也不得因目标是章节而改判 write_scene。
editScope 仅描述既有文档修改范围：明确原句/网页选区/一小处→point；一个小节或若干相邻段→section；明确通篇/全文/整体统一调整且每部分都需处理→document。不要把“深度修改某一处”误判为document。
只有用户明确要求“大纲、卷纲、全书规划、章节表、后续各章安排”时才用 mode=outline。单章正文任务的 todoPlan 只能覆盖该章，禁止自行加入创建全书大纲、规划其他章节或一次写多章。
documentDeliverables 只列最终会分别形成文档提案的独立产物：写一章时即使含多个场景、人物段落、检查步骤也只能列1项；明确一次写三章才列3项。讨论、角色卡或无文档写入时填[]。不得把 todoPlan 的内部步骤复制成多个交付项。
作者复审候选按语义判断，不依赖“以后/始终/每次”等字面词。当前 user 若概括了一类可在后续正文重复出现的问题，并给出可复用的避免标准或典型例子，就输出 proseGateCandidate；即使同一请求还要求修改当前文档也要输出。只针对当前一句/当前段/本章的一次性取舍、单纯说“不好/重写”、没有可执行标准的含糊抱怨，不输出。
proseGateCandidate 格式：{"id":"稳定英文数字连字符ID","title":"短标题","userIntent":"作者意图","semanticCriterion":"可独立执行的语义核验标准，不能只靠关键词或固定句长","evidenceRequirement":"命中所需的最短连续原文","allowConditions":["合理例外"],"revisionIntent":"局部修订目标与必须保留项","enforcement":"observe|advise|block","status":"draft|trial","skillId":"可选修订技能","sourceFeedback":"当前反馈摘要"}。新风格偏好默认 trial+advise；标准边界仍含糊时 draft+observe；只有事实性确定错误或作者绝对禁令才可 block，且 block 必须有 allowConditions。
路径：lore/=设定 outline/=大纲 chapters/=正文。targetPath/characterIds/exampleIds 必须来自目录，禁止编造。`,
  }, {
    role: "user",
    content: JSON.stringify({
      request,
      documents,
      documentCatalogTruncated: allDocuments.length > documents.length,
      characters,
      examples,
      selectionCharacters,
      recentHistory: recent,
    }),
  }];
  const plannerRequestOptions = plannerCompletionOptions(model);
  let result = await streamCompletion(model, planningMessages, signal, () => undefined, () => undefined, {
    ...plannerRequestOptions,
    ...(prefixCache ? {
      prefixCache: {
        ...prefixCache,
        callKind: "planner",
        stableMessageCount: 1,
        initialMessageCount: planningMessages.length,
      },
    } : {}),
  });
  if (result.usage) onUsage?.(result.usage, false);
  let parsed = parsePlannerJson(result.content);
  if (!parsed) {
    const repairMessages: ApiMessage[] = [
      ...planningMessages,
      {
        role: "assistant",
        content: result.content.trim().slice(0, 1_200) || "{}",
        ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
      },
      {
        role: "user",
        content: "上一个输出不是可解析的单一 JSON 对象。只修复格式并重新输出完整 JSON；不得解释、不得使用 Markdown。",
      },
    ];
    const retry = await streamCompletion(model, repairMessages, signal, () => undefined, () => undefined, {
      ...plannerRequestOptions,
      ...(prefixCache ? {
        prefixCache: {
          ...prefixCache,
          callKind: "planner_retry",
          stableMessageCount: 1,
          initialMessageCount: planningMessages.length,
        },
      } : {}),
    });
    if (retry.usage) onUsage?.(retry.usage, true);
    parsed = parsePlannerJson(retry.content);
    if (!parsed) {
      throw new Error(`任务契约编译器连续两次没有返回有效 JSON（首次 finish=${result.finishReason ?? "unknown"}、${result.content.length} 字符；重试 finish=${retry.finishReason ?? "unknown"}、${retry.content.length} 字符）`);
    }
    result = retry;
  }
  const modes: WritingTaskMode[] = ["brainstorm", "outline", "write_scene", "rewrite", "audit", "character", "simple_character", "general"];
  const plannedMode = modes.includes(parsed.mode as WritingTaskMode) ? parsed.mode as WritingTaskMode : "general";
  const mode = normalizeCharacterTaskMode(request, plannedMode);
  const contextModes: DocumentContextMode[] = ["none", "search", "target", "continuation"];
  const documentContext = contextModes.includes(parsed.documentContext as DocumentContextMode)
    ? parsed.documentContext as DocumentContextMode
    : "none";
  const validCharacterIds = new Set(characters.map(item => item.id));
  const validExampleIds = new Set(examples.map(item => item.id));
  const validDocumentPaths = new Set(documents);
  const continuation = parsed.continuation === true;
  const mutations: AgentMutationRequirement[] = ["none", "document", "character", "mixed"];
  let mutation = mutations.includes(parsed.mutation as AgentMutationRequirement)
    ? parsed.mutation as AgentMutationRequirement
    : parsed.documentProposalRequired === true ? "document" : "none";
  if ((mode === "character" || mode === "simple_character") && mutation !== "mixed") mutation = "character";
  if ((mode === "write_scene" || mode === "rewrite") && mutation !== "mixed") mutation = "document";
  const documentProposalRequired = mutation === "mixed"
    ? true
    : normalizeDocumentProposalRequired(mode, mutation === "document");
  if (!documentProposalRequired && mutation === "document") mutation = "none";
  const outcomes: AgentTaskOutcome[] = ["answer", "document", "character", "review", "multiple"];
  let outcome = outcomes.includes(parsed.outcome as AgentTaskOutcome)
    ? parsed.outcome as AgentTaskOutcome
    : mutation === "document" ? "document"
      : mutation === "character" ? "character"
        : mode === "audit" ? "review" : "answer";
  if (mutation === "document") outcome = "document";
  if (mutation === "character") outcome = "character";
  if (mutation === "mixed") outcome = "multiple";
  const depths: CreativeDepth[] = ["explore", "shape", "deliver"];
  const creativeDepth = depths.includes(parsed.creativeDepth as CreativeDepth)
    ? parsed.creativeDepth as CreativeDepth
    : documentProposalRequired ? "shape" : "explore";
  const editScopes: EditScope[] = ["point", "section", "document"];
  const plannedEditScope = editScopes.includes(parsed.editScope as EditScope)
    ? parsed.editScope as EditScope
    : undefined;
  const editScope: EditScope = mode === "rewrite"
    ? normalizeRewriteEditScope(request, plannedEditScope, selectionCharacters)
    : mode === "write_scene" ? "document" : "section";
  let normalizedDocumentContext: DocumentContextMode = mode === "simple_character" || mode === "character"
    ? "search"
    : continuation
    ? "continuation"
    : documentContext;
  // Safety net: LLM often marks lore discussion as none; upgrade when request hits project entities.
  if (normalizedDocumentContext === "none") {
    const historyBlob = recent.map(item => item.content).join("\n");
    if (requestNeedsProjectFactSearch(request, {
      documents,
      characterNames: characters.flatMap(item => [item.name, ...(item.aliases ?? [])]),
      historyText: historyBlob,
    })) {
      normalizedDocumentContext = "search";
    }
  }
  const requestedTodoPlan = Array.isArray(parsed.todoPlan)
    ? parsed.todoPlan.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map(item => item.trim().slice(0, 120)).slice(0, 5)
    : [];
  const documentDeliverables = Array.isArray(parsed.documentDeliverables)
    ? parsed.documentDeliverables
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map(item => item.trim().slice(0, 80))
      .filter((item, index, all) => all.indexOf(item) === index)
      .slice(0, 5)
    : [];
  const proseGateCandidate = normalizePlannedProseGateCandidate(parsed.proseGateCandidate);
  const evidenceValues: AgentEvidenceRequirement[] = ["none", "project", "target", "continuation"];
  let evidence = evidenceValues.includes(parsed.evidence as AgentEvidenceRequirement)
    ? parsed.evidence as AgentEvidenceRequirement
    : normalizedDocumentContext === "search" ? "project"
      : normalizedDocumentContext === "target" ? "target"
        : normalizedDocumentContext === "continuation" ? "continuation" : "none";
  if (mode === "character" || mode === "simple_character") evidence = "project";
  if ((mutation === "document" || mutation === "mixed") && evidence === "none"
    && (mode === "rewrite" || mode === "audit")) {
    evidence = "target";
  }
  const capabilityValues: AgentCapability[] = ["research", "documents", "files", "outline", "scenes", "characters", "review", "images"];
  const requestedCapabilities = Array.isArray(parsed.capabilities)
    ? parsed.capabilities.filter((item): item is AgentCapability => capabilityValues.includes(item as AgentCapability))
    : [];
  const baselineCapabilities: Record<WritingTaskMode, AgentCapability[]> = {
    brainstorm: ["research", "documents", "characters"],
    outline: ["research", "documents", "outline", "characters"],
    write_scene: ["research", "documents", "outline", "scenes", "characters", "review"],
    rewrite: ["research", "documents", "files", "characters", "review"],
    audit: ["research", "documents", "outline", "review"],
    character: ["research", "documents", "outline", "characters"],
    simple_character: ["research", "documents", "characters"],
    general: ["research", "documents", "files", "characters"],
  };
  const capabilities = [...new Set([...baselineCapabilities[mode], ...requestedCapabilities])];
  const planning = resolveAgentPlanningStrategy(mutation, parsed.planning, requestedTodoPlan.length);
  const searchQuery = typeof parsed.searchQuery === "string" && parsed.searchQuery.trim()
    ? parsed.searchQuery.slice(0, 200)
    : extractSearchQueryHint(request, documents, characters) || request.slice(0, 200);
  const plannedCharacterIds = Array.isArray(parsed.characterIds)
    ? parsed.characterIds.filter(id => validCharacterIds.has(id)).slice(0, 4)
    : [];
  const selectedCharacterIds = plannedCharacterIds.length || mode !== "character"
    ? plannedCharacterIds
    : resolveRecentCharacterIds(
      characters,
      [request, ...(continuation ? [...recent].reverse().map(item => messageContentText(item.content)) : [])],
    );
  return {
    task: {
      mode,
      label: TASK_LABELS[mode],
      outcome,
      evidence,
      mutation,
      planning,
      capabilities,
      searchQuery,
      characterIds: selectedCharacterIds,
      exampleIds: Array.isArray(parsed.exampleIds) ? parsed.exampleIds.filter(id => validExampleIds.has(id)).slice(0, 2) : [],
      documentContext: normalizedDocumentContext,
      creativeDepth,
      editScope,
      documentProposalRequired,
      continuation,
      todoPlan: requestedTodoPlan.length ? requestedTodoPlan : defaultTodoPlan(mode, documentProposalRequired),
      documentDeliverables: documentProposalRequired
        ? (documentDeliverables.length ? documentDeliverables : ["当前文档"])
        : [],
      workflow: inferWritingWorkflowKind({
        mode,
        outcome,
        mutation,
        planning,
        capabilities,
        documentProposalRequired,
        editScope,
      }),
      qualityProfile: inferWritingQualityProfile({
        mode,
        outcome,
        mutation,
        planning,
        capabilities,
        documentProposalRequired,
        editScope,
      }),
      proseGateRequired: Boolean(proseGateCandidate),
      ...(proseGateCandidate ? { proseGateCandidate } : {}),
      ...(typeof parsed.targetPath === "string" && validDocumentPaths.has(parsed.targetPath) ? { targetPath: parsed.targetPath } : {}),
    },
  };
}

/**
 * Upgrade none→search when the user is clearly talking about in-world entities.
 * Exported for unit tests.
 */
export function requestNeedsProjectFactSearch(
  request: string,
  catalog: { documents: string[]; characterNames: string[]; historyText?: string },
): boolean {
  const text = request.trim();
  if (!text) return false;
  // Pure craft questions stay none.
  if (/^(?:怎么写|如何写|写作技巧|文笔|润色建议|怎么改句子)/.test(text) && !/(?:设定|组织|势力|世界观|角色卡)/.test(text)) {
    return false;
  }
  const tokens = extractProjectNameTokens(text);
  const nameHaystack = [
    ...catalog.documents.map(path => path.replace(/\\/g, "/")),
    ...catalog.characterNames,
  ].join("\n");
  if (tokens.some(token => nameHaystack.includes(token))) return true;
  // Setting-discussion with proper-looking terms: search even if catalog path titles miss the name.
  if (/(?:组织|势力|实体|设定|世界观|除掉|利益|军工|复合体|超国家|联邦|帝国|同盟|教团)/.test(text)
    && /[\u4e00-\u9fff]{2,}/.test(text)) {
    return true;
  }
  return false;
}

function extractProjectNameTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/[「『《“"]([^」』》”"]{2,16})[」』》”"]/g)) {
    tokens.add(match[1].trim());
  }
  const stop = new Set([
    "有人", "因为", "所以", "如果", "这个", "那个", "什么", "怎么", "讨论", "提出", "关于",
    "可以", "不是", "一个", "我们", "他们", "自己", "已经", "还是", "或者", "以及", "影响",
    "利益", "除掉", "用户", "提出", "让我", "确认", "系统", "当前", "任务", "直接", "完成",
  ]);
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,8}/g)) {
    const token = match[0];
    if (stop.has(token)) continue;
    tokens.add(token);
  }
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_\-]{2,24}/g)) {
    tokens.add(match[0]);
  }
  return [...tokens];
}

function extractSearchQueryHint(
  request: string,
  documents: string[],
  characters: Array<{ name: string; aliases?: string[] }>,
): string {
  const tokens = extractProjectNameTokens(request);
  const haystack = [
    ...documents.map(path => path.replace(/\\/g, "/")),
    ...characters.flatMap(item => [item.name, ...(item.aliases ?? [])]),
  ].join("\n");
  const catalogHits = tokens.filter(token => haystack.includes(token));
  const preferred = (catalogHits.length ? catalogHits : tokens)
    .sort((a, b) => b.length - a.length)
    .slice(0, 4);
  return preferred.join(" ").slice(0, 80);
}

function defaultTodoPlan(mode: WritingTaskMode, documentProposalRequired: boolean): string[] {
  if (mode === "write_scene") return [];
  if (mode === "rewrite") return ["读取目标原文与约束", "完成定向改写并核对信息", "提交最小修改提案"];
  if (mode === "outline" && documentProposalRequired) return ["核对现有结构与约束", "形成并检查大纲方案", "提交大纲提案"];
  if (mode === "audit" && documentProposalRequired) return ["审计原文并定位证据", "完成最小修复", "提交修改提案"];
  if (mode === "general" && documentProposalRequired) return ["定位相关纯文本文件", "准备并校验 change set", "提交统一审批"];
  if (mode === "character") return ["核对已有普通角色卡与设定", "更新或保存普通角色卡"];
  if (mode === "simple_character") return ["核对已有角色与设定", "整理并保存简易角色卡"];
  return [];
}

export function initialTodos(todoPlan: string[]): AgentTodoItem[] {
  return todoPlan.map((content, index) => ({
    id: `t${index + 1}`,
    content,
    status: index === 0 ? "in_progress" : "pending",
  }));
}

/**
 * Per-mode workflow text inside the dynamic task block (not the stable prefix).
 * CACHE: Safe to be mode-specific. Prefer references to style/system rules over
 * re-pasting long mannerism/craft checklists already in the stable prefix.
 */
function creativePacing(depth: CreativeDepth): string {
  if (depth === "explore") return "保持开放讨论：先抓一个最值得追问的矛盾、画面或关系温差，再给 2—3 个短促火花。默认约 200—400 字；不做表格、评分、完整大纲或总结性汇报，最多留下一个真正能推进选择的问题。";
  if (depth === "shape") return "把灵感塑形成 2—3 个确实不同的方向，每个只写核心画面、关键选择和会改变什么，并点出最重要的取舍。默认约 400—700 字；不要补齐章节表、评分表或全套审计。";
  return "用户明确要求完整展示：按其指定范围给出可直接使用的完整成果；内部比较和自检只呈现会帮助作者决策的结论，不展示冗长过程。";
}

export function taskInstructions(
  mode: WritingTaskMode,
  creativeDepth: CreativeDepth,
  permissionMode: PermissionMode,
  documentProposalRequired: boolean,
  notesMaxCharacters = DEFAULT_SCENE_NOTES_CHARACTERS,
  fastWritingMode = false,
  scenePipelineEnabled = true,
): string {
  const pacing = creativePacing(creativeDepth);
  if (permissionMode === "plan") {
    if (mode === "character") return `本次工作流（plan 只读）：
- 这是普通角色卡任务；先核对同名普通卡与最小必要资料，不得调用任何保存工具。
- 已有同名卡时保留其 id，说明拟更新的分区；不得改建简易卡或创建同名重复卡。
- ${pacing}`;
    if (mode === "simple_character") return `本次工作流（plan 只读）：
- 读取最小必要资料，整理一份候选简易角色卡；不得调用任何保存工具。
- 保留 name、identity、relationship、knowledge、scene、goal 六个字段，不确定处留白或标为“未明确”。
- ${pacing}`;
    if (mode === "audit") return `本次工作流（plan 只读）：
- 只审阅并给出有证据的少量关键问题，不提交修改提案。
- 区分确定问题、可能风险和个人偏好；优先说明最小改法。
- ${pacing}`;
    if (mode === "write_scene" || mode === "rewrite") return `本次工作流（plan 创作讨论）：
- 不写成可发表正文，也不提交文档提案；围绕开场画面、人物当下欲望、阻力、选择及其余波碰撞思路。
- 可以大胆提出候选，但不要把它们冒充已确认设定；不要加载正文风格自检来把讨论变成交付报告。
- ${pacing}`;
    if (mode === "outline") return `本次工作流（plan 大纲构思）：
- 以发现故事可能性为主，不写入大纲，不强制调用 design_creative_outline，不自动展开章节表。
- 只有上下文决策确实要求核对现有大纲时才读取节点；从零构思或泛化讨论不要为了“完整”读取项目。
- 优先寻找具体画面、人物选择、关系反转和意外后果；保留未定空间。
- ${pacing}`;
    return `本次工作流（plan 只读）：${pacing} 不提交文档或角色资料变更。`;
  }

  if (mode === "character") return `本次工作流：
- 这是普通角色卡任务。先 list_characters 检查同名卡及分区目录；若已存在，修改范围明确时直接 get_character(view=edit, sections=[...])，跨多个未知分区的全面重做才用不带 sections 的 view=edit；不要先读 summary。
- 不要调用 save_simple_character；不得因现有卡内容为空、简略或不完整而新建同名角色。
- 新建或大改用 save_character；有依据的情节演进优先 apply_character_changes。只填写用户提供或项目材料支持的内容，未知处留空。
- 更新已有卡时保留原 id，传入最近读取返回的 expectedUpdatedAt，优先只提交实际修改的分区；需要核对关联信息时可以继续读取相关分区或项目资料。数组条目沿用已有 ASCII id，新增条目提供唯一 ASCII id。
- 新角色应提交完整的核心设定；若工具返回结构化错误，按错误修正后继续重试。角色保存成功即完成本任务，禁止再写入无关文件。`;
  if (mode === "simple_character") return `本次工作流：
- 这是简易角色卡任务，不要调用 save_character 创建普通角色卡；最终调用 save_simple_character 保存。
- 先调用 list_characters 检查同名或相关普通角色卡；若存在相关角色，先用 get_character(id) 读取必要字段摘要，再按需用 sections 选读其他字段。
- 按上下文决策检索相关 lore/ 与 outline/，只读取最小必要片段。
- 将项目事实压缩为 name、identity、relationship、knowledge、scene、goal 六个字段；不确定处留空或标为“未明确”。可按需继续检查同名角色和项目资料，工具报错时修正后继续保存。角色保存成功即完成本任务，禁止再写入无关文件。`;
  if (mode === "brainstorm") return `本次工作流：
- ${pacing}
- 候选应具体到画面、人物选择或关系变化，不必把每个火花都补成完整因果链。
- 不把候选设想写入项目事实，除非作者明确选定。`;
  if (mode === "outline" && !documentProposalRequired) return `本次工作流（大纲讨论）：
- ${pacing}
- 只有上下文决策要求核对既有项目时才读取大纲节点；不要自动调用 design_creative_outline 或展开结构化章节表。
- 区分既有事实与候选方向，不把讨论结果自动写入项目。`;
  if (mode === "outline") return `本次工作流（大纲交付）：
- 大纲是轻量导航，不是正文写作的前置审批。只有用户明确要求大纲/卷纲/全书章节规划时才执行本工作流；不得把“写第N章”扩成全书大纲。
- 对 outline/ 的完整新建或大幅重构，先调用 design_creative_outline；局部节点修补无需调用。
- 修改或承接既有大纲时再 list_outline_nodes，并用 get_outline_node 读取最小目标节点；新建大纲不要为了形式完整读取空目录。
- 先区分已核实依据、创作候选与待定缺口，再用一句主线和阶段因果链收束；内部核对后只写精简成品。
- 每个场景维护前因、行动、结果、状态变化，以及必要的人物弧、信息释放和伏笔回收。
- 修改既有节点用 edit_file；新建或大幅重构用 write_file 写入 outline/，不得写入 chapters/ 或 lore/。
- 落盘字段仅使用：摘要、前因、行动、结果、状态变化、角色ID、地点、时间、情节线、伏笔、回收、状态、文档、正文章节。`;
  if (mode === "write_scene") return `正文创作原则（内部执行，不输出分析过程）：
- 主 Agent 对成品负责，自主决定先读什么、是否构思、是否分场、何时修订；不要为了展示流程而调用工具或创建清单。
- 对齐「风格锚定」与动态声线证据。大纲不是前置条件；只有存在精确匹配的 outlineNode ID 或用户明确指定时才读取一次，不得为写单章创建或扩写大纲。需要衔接时只读上一章末尾的最小范围；若目标之后已有成稿，只读下一章开头的最小范围作为离场边界，不提前代演下一章；需要人物约束时读取相关角色分区。
- 角色卡原始分区是人物事实的唯一依据：能力、知识、关系、身体状态与对白声线不得压缩进 write pack 后替代原卡。确实要写某角色的对白时，按需读取该角色 voice、motivations、relationships、storyState；涉及价值、恐惧或内在冲突才读取 psychology，只读会开口的角色。对白声线遵守「正文底线」的角色归属规则。
- ${fastWritingMode ? "快速模式下优先走最短的单 Agent 路径，由你提交正文。" : "分工模式下你负责检索、角色原卡取证与编排；正文交给证据型 Writer。直接完整成稿先 compile_write_pack，再调用 write_file(path) 并省略 content；资料不足时工具会返回必须补读的原始分区。局部 edit_file 仍由你完成。"}${scenePipelineEnabled ? "能够整体把握时可直接成稿，不要为了展示流程而建立场景链。" : "场景链已关闭，直接成稿。"}
- 根据任务选择最小有效路径：新建或完整成稿用 write_file，修改既有局部用 edit_file；约束复杂时可先 compile_write_pack；${scenePipelineEnabled ? "只有长篇连续状态、跨场修订或逐场反馈确有价值时，才 begin_chapter_draft 并使用场景草稿链。" : "场景链已关闭，禁止调用章节场景链工具。"}运行时自动处理篇幅、审查与审批，只使用当前公开文件工具。
- 单章篇幅按动态块中的「篇幅控制模式」处理，不擅自改变已成立事实，也不把目标当作多章总额均分。范围验收模式按目标的 ${PROSE_TARGET_BAND_TEXT} 处理：超出上限会被拒收，不足下限是否拦截由设置决定；弱引导模式只把目标作为参考，不因偏离目标重写。无论哪种模式，都禁止用总结、同义复述、额外支线或元说明凑字。
- 目标路径已经存在时保持原路径，系统会把工作副本记录为该文件的新版本；不要为避开同名另起副本或改写章节路径。局部修改用 edit_file，完整替换用 write_file。
${scenePipelineEnabled ? `- 若选择场景链，guide 只是可改导航。每场 characterScopes 是本场角色卡使用合同：只保存角色 ID、可兑现的能力 ID 与 dialogue 权限；能力详情、限制与代价仍须按需读原卡。未列入的能力不得在正文使用或点名；要增加能力/声线许可，先 revise_chapter_scene_guide 修改尚未写场。dialogue=true 时，写前须读取该角色 voice、motivations、relationships、storyState，且声线只约束该角色说出口的对白。${fastWritingMode ? `write_chapter_scene 提交不超过 ${notesMaxCharacters} 字的故事内 notes、正文与从成稿归纳的 actualState。` : `write_chapter_scene 只提交 sceneId 与不超过 ${notesMaxCharacters} 字的故事内 notes，省略 content/actualState，由证据型 Writer 和状态提取器完成。`}readerQuestion、cost 与 oppositionMove 是可修订的场景假设，不是每场必须套用的剧情公式；按章节目标填写真正适用的项，并依据成稿调整未写引导。门禁反馈是诊断证据：少量孤立问题通常适合精确修订；若问题密集，或节奏、叙述距离与结构彼此牵连，可以重写受影响场景乃至全文。完整后 inspect_chapter_draft。` : ""}
- 对白服从人物目的、知识与关系。直说、回避、解释、沉默或打断都可以；人物差异来自他们关注和不愿承认的内容，不要为了制造“摩擦”给每场套同一组停顿与答非所问。
- ${proseCompressionGuidance()}
- 设定中的规范术语是事实来源，不是正文默认措辞。若同一概念会同时进入专业汇报、普通对白和贴身叙述，在 compile_write_pack 或场景 notes 中增加「## 表达边界」，按“事实 | 用途=… | 精度=exact/normal/sensory | 叙述=… | 对白=… | 技术对白=… | 避免=…”说明语域；只在确有污染风险时填写，不为普通名词制造同义词配额。
- 章节动力服从本章目标。冲突章应让阻力真正回应人物行动；静场、过渡章与收束章也可以用理解、关系或条件的变化完成。代价、悬问与不可逆损失只在因果需要时出现，不作为每章配额。
- 不论选择哪条路径，正文都不得出现路径、大纲、草案、工具 JSON、角色卡分区等元指称。提交前：${proseMannerismPreflightLine()}
- 只交付用户本轮明确要求的正文范围；用户指定多章时逐章提交并沿用已读材料，未要求的章节不得自行扩展。遇到真实事实缺口才 ask_user；可逆的创作选择由你判断。`;
  if (mode === "rewrite") return `工作流（内部执行）：
- 定位用户引用的原句：先 search_files，或用 read_file(path+quote) 读取原句及必要上下文。
- 用户要求修复句式、文风、解释腔或生成感时，修改前先 audit_prose_style；按 diagnosis.actionableIssues 的 evidence 定位，优先 verdict=block，并复核 aiTells.issues 的示例与建议；资料文档只处理资料画像中的问题。revisionIntent 只规定修改目标、不当作替换句。一般修改不为展示流程调用审计。
- 对齐风格锚定与原文声线；只改作者要求的维度，其余事实/动机/信息序不变。
- 若改动依赖大纲/设定核对：先读最小片段，将约束整理后 compile_write_pack，再据 writePack 改写。
- 风格变化落到叙述距离、句长、对白比、感官与信息释放，勿同义替换或无故含蓄化。
- 正文禁止文档元指称（序章里/第N章里/大纲里/路径）。point/section 用 edit_file 对唯一 oldText 做最小修改；editScope=document 才用 write_file 完整替换。提交前：${proseMannerismPreflightLine()}`;
  if (mode === "audit") return `工作流：
- 先 audit_prose_style；按 diagnosis.actionableIssues 处理，优先 verdict=block；再审阅 aiTells.issues。warn 只在结合上下文仍明显模板化时改；资料文档以资料画像为准，不套用人物声线或叙事收尾标准。
- 每条问题含严重度、原文证据、违反约束、最小改法；无证据不提。
- ${documentProposalRequired ? "要求修复：用 read_file 的 quote 参数定位证据句，只改有证据处，用 edit_file 做最小修改。" : "只检查：不写文件，只输出审阅结论。"}`;
  return documentProposalRequired
    ? "文件交付任务：先用 read_file 读取最小必要原文；新建/完整替换用 write_file，局部修改用 edit_file。"
    : "先判断构思/规划/写作/改写/审校再执行。改正文须先读原文，再用 write_file/edit_file 交付；已确认角色变化→apply_character_changes。";
}

function scopedCharacterConstraintPackets(store: WriterStore, task: WritingTask, characterScope?: number[]) {
  const rankedCharacters = store.characters().map((item) => ({
    item, score: task.characterIds.includes(item.id) ? 1 : 0,
  })).sort((a, b) => b.score - a.score || a.item.identity.name.localeCompare(b.item.identity.name, "zh-CN"));
  const scopedIds = characterScope === undefined ? undefined : new Set(characterScope);
  // characterScope is a read permission boundary from the UI, not a claim that
  // every visible card participates in this scene. Only task-selected cards are
  // injected; other cards stay available through targeted get_character calls.
  const selectedCharacters = rankedCharacters
    .filter(entry => entry.score > 0 && (!scopedIds || scopedIds.has(entry.item.id)))
    .slice(0, 4);
  return selectedCharacters.map(({ item }) => {
    const constraints = characterConstraintView(item);
    return {
      item,
      constraints,
      writingConstraints: characterWritingConstraintView(item),
      constraintHash: characterConstraintHash(constraints),
    };
  });
}

function structuredCreativeContext(store: WriterStore, task: WritingTask, characterScope?: number[], simpleCharacterScope?: number[]): string {
  const characters = scopedCharacterConstraintPackets(store, task, characterScope).map(({ item, writingConstraints, constraintHash }) => {
    return {
      id: item.id,
      name: item.identity.name,
      aliases: item.identity.aliases,
      narrativeRole: item.identity.narrativeRole,
      identity: item.identity.summary,
      writingConstraints,
      constraintHash,
    };
  });
  // Simple cards are rarely needed outside simple_character / scoped roleplay — avoid dumping 20 cards every turn.
  const simpleScopedIds = simpleCharacterScope === undefined ? undefined : new Set(simpleCharacterScope);
  const includeSimple = task.mode === "simple_character" || simpleCharacterScope !== undefined;
  const simpleCharacters = includeSimple
    ? store.roleplayInterlocutors()
      .filter(item => !simpleScopedIds || simpleScopedIds.has(item.id))
      .slice(0, 6).map(item => ({
        id: item.id, name: item.name, identity: item.identity.slice(0, 100), targetCharacterId: item.targetCharacterId,
      }))
    : [];
  // Writing tasks: only ids/fingerprints here — full example bodies live in dynamic style evidence.
  const writing = isIntensiveWritingMode(task.mode) || task.documentProposalRequired;
  const rankedExamples = store.writingExamples().filter(item => item.gatePassed).map((item) => {
    let score = task.exampleIds.includes(item.id) ? 3 : 0;
    if (writing && item.title.startsWith("[风格模板]")) score = Math.max(score, 1);
    if (writing && !item.title.startsWith("[风格模板]") && score === 0) score = 1;
    return { item, score };
  }).sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt));
  const selectedExamples = rankedExamples.filter((entry) => entry.score > 0).slice(0, 2);
  const examples: Array<Record<string, string | number>> = [];
  let exampleBudget = writing ? 1_200 : 5_000;
  for (const { item } of selectedExamples) {
    const entry: Record<string, string | number> = {
      id: item.id,
      title: item.title,
      category: item.category,
      usage: "imitate_voice_not_plot",
    };
    if (writing) {
      entry.notes = item.notes.slice(0, 80);
      // Bodies are in style anchoring; do not re-inject full prose here.
    } else {
      entry.content = item.content.slice(0, Math.min(2_000, exampleBudget));
      entry.notes = item.notes.slice(0, 400);
    }
    const size = JSON.stringify(entry).length;
    if (size > exampleBudget) break;
    examples.push(entry);
    exampleBudget -= size;
  }
  return JSON.stringify({ task: task.mode, characters, simpleCharacters, writingExamples: examples });
}

function explicitReferencePaths(project: WriterProject, request: string): string[] {
  const available = new Set(project.listTextFiles().filter(path => !project.isDocumentHidden(path)));
  return [...request.matchAll(/(?:^|\s)@([^\s]+)/g)]
    .map((match) => match[1].replace(/[，。；：,.!?！？]+$/, ""))
    .filter((path, index, all) => available.has(path) && all.indexOf(path) === index)
    .slice(0, 3);
}

/**
 * Dynamic-tail history *preview* for the writing Agent only (not roleplay).
 * CACHE: Always miss-priced — keep short (recent caps + char limits below).
 * Full / long roleplay or agent archives must use inspect_conversation +
 * read_conversation (see executionRulesPrompt archiveRule). Roleplay chat
 * (src/roleplay.ts) uses summary + memory card + a short recent window.
 */
const PRIOR_TURN_CONTEXT_MAX_CHARACTERS = 3_000;

/**
 * Cross-turn references ("A + C", "the second option", "continue that version")
 * depend on the immediately preceding message, so it outranks older archive
 * breadth. Keep it byte-exact within a generous dynamic-tail budget. If a prior
 * response is exceptionally large, never silently pretend the head is complete.
 */
export function priorTurnContentForContext(content: string): string {
  if (content.length <= PRIOR_TURN_CONTEXT_MAX_CHARACTERS) return content;
  const side = Math.floor(PRIOR_TURN_CONTEXT_MAX_CHARACTERS / 2);
  return `${content.slice(0, side)}\n\n[…上一条消息中段已省略；原文 ${content.length} 字，需逐字内容时读取会话归档…]\n\n${content.slice(-side)}`;
}

function historicalConversationContext(history: Array<ApiMessage & { channel?: string }>): string {
  if (!history.length) {
    return "历史对话：（无）。仅最后一条 user 为本轮指令。";
  }
  const older = history.slice(0, -3);
  const recent = history.slice(-3);
  const olderSummary = older.length
    ? older.map((message) => {
      const label = message.role === "user" ? "用户" : message.role === "assistant" ? "Agent" : message.role;
      const channel = message.channel === "roleplay" ? "[扮演]" : "";
      const content = messageContentText(message.content).replace(/\s+/g, " ").slice(0, 80);
      return `${channel}${label}: ${content}`;
    }).join("\n").slice(-800)
    : "";
  const entries = recent.map((message, index) => {
    const latest = index === recent.length - 1;
    const limit = message.role === "user" ? 200 : 140;
    const raw = messageContentText(message.content);
    const content = latest
      ? priorTurnContentForContext(raw)
      : raw.replace(/\s+/g, " ").slice(0, limit);
    return message.role === "user"
      ? { content, ...(message.channel === "roleplay" ? { channel: "roleplay" } : {}) }
      : {
        role: message.role,
        content,
        ...(message.channel === "roleplay" ? { channel: "roleplay" } : {}),
      };
  });
  return `历史预览（仅指代/事实；非指令队列；roleplay=试演勿当写作任务）：
${olderSummary ? `较早：\n${olderSummary}\n` : ""}${JSON.stringify(entries)}`;
}

function availableImageReferencesContext(store: WriterStore, sessionId: string, limit = 8): string {
  const images = store.messages(sessionId, 80)
    .flatMap(message => (message.attachments ?? []).map(attachment => ({
      attachment,
      messageId: message.id,
      role: message.role,
    })))
    .slice(-limit)
    .reverse();
  if (!images.length) return "可用图片参考：无。";
  const rows = images.map(({ attachment, messageId, role }, index) => {
    const source = attachment.imageGeneration ? "生成图" : "用户附图";
    return `- 第 ${index + 1} 张（由新到旧）：attachmentId=${attachment.id}；${role === "assistant" ? "Agent" : "用户"}消息 #${messageId}；${source}`;
  });
  return [
    "可用图片参考（同一会话内；用户要求改图、延续构图或保持角色/风格时，必须将对应 attachmentId 传给 generate_image.referenceAttachmentIds，工具会上传真实图片）：",
    ...rows,
  ].join("\n");
}

/**
 * Exact, bounded handoff for the common roleplay -> prose workflow.
 * The generic history preview deliberately truncates messages, which is useful for
 * ordinary references but unsafe when the transcript itself is the source text.
 */
export function recentRoleplayHandoffContext(
  store: WriterStore,
  sessionId: string,
  maxCharacters = 16_000,
): string {
  const archive = store.messages(sessionId, 120)
    .filter(message => message.role === "user" || message.role === "assistant");
  if (archive.at(-1)?.channel !== "roleplay") return "";

  let start = archive.length - 1;
  while (start > 0 && archive[start - 1].channel === "roleplay") start -= 1;
  const block = archive.slice(start);
  const included: typeof block = [];
  let characters = 0;
  for (let index = block.length - 1; index >= 0; index -= 1) {
    const message = block[index];
    const addition = message.content.length + 96;
    if (included.length && characters + addition > maxCharacters) break;
    included.unshift(message);
    characters += addition;
  }

  const stats = store.conversationStats(sessionId);
  const omitted = included.length < block.length
    || (start === 0 && stats.roleplay > block.length);
  const memory = store.roleplayMemory(sessionId);
  const facts = memory
    ? store.roleplayMemoryFacts(sessionId, memory.performerKey)
      .filter(fact => fact.status === "active")
      .slice(0, 16)
      .map(fact => ({
        id: fact.id,
        kind: fact.kind,
        content: fact.content,
        sourceMessageId: fact.sourceMessageId,
        knownBy: fact.knownBy,
      }))
    : [];
  const transcript = included.map(message => {
    const speaker = message.role === "user" ? "玩家" : "角色";
    const mode = message.role === "user" && message.roleplayInputMode === "director"
      ? "][导演指令"
      : "";
    return `[message#${message.id}][${speaker}${mode}]\n${message.content}`;
  }).join("\n\n");

  return `最近角色扮演事实交接（仅在本轮请求引用该试演时使用）：
- 下列逐条原文及顺序是改写小说片段的事实来源；允许改变叙述形式，不得替换、颠倒或补造事件、动作结果、对白含义与人物认知。
- [导演指令] 是场景事实/调度，不是角色说出的台词。
${omitted ? "- 这里只含最新一段的后部；若任务要求转换完整试演，必须用 inspect_conversation/read_conversation 读取 roleplay 通道至末尾。\n" : ""}滚动场景状态：${memory ? JSON.stringify({ summary: memory.summary, state: memory.state }) : "（退出前未留下滚动状态）"}
已确认记忆事实：${facts.length ? JSON.stringify(facts) : "（无）"}
逐条原文：
${transcript}`;
}

/** Prefer chapters/outline/lore and request-mentioned paths; cap planner user payload. */
function prioritizeDocumentCatalog(documents: string[], request: string, limit: number): string[] {
  if (documents.length <= limit) return documents;
  const mentioned = new Set(documents.filter(path => request.includes(path)));
  const rank = (path: string): number => {
    if (mentioned.has(path)) return 0;
    if (path.startsWith("chapters/")) return 1;
    if (path.startsWith("outline/")) return 2;
    if (path.startsWith("lore/") || path.startsWith("story/")) return 3;
    if (path.startsWith("side/")) return 4;
    return 5;
  };
  return [...documents].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true })).slice(0, limit);
}

/**
 * Fixed-count stable system prefix (exactly 6 system messages every turn).
 *
 * Slot map (do not reorder, do not splice optional messages between slots):
 *   0 writingSystemPrompt
 *   1 executionRulesPrompt(permissionMode)
 *   2 project instructions OR fixed empty placeholder
 *   3 skills catalog OR fixed empty placeholder
 *   4 stableStyleGroundingPrompt (project-stable; independent of intensive/mode)
 *   5 fixed mode-extra placeholder (audit REVIEW lives in dynamic task block)
 *
 * CACHE: When adding a new *stable* rule, put it inside an existing slot (or
 * extend this function with a new trailing stable slot and always fill it).
 * Never `...(cond ? [msg] : [])` here — that shifts later messages and kills prefix hits.
 * Never branch slot 4/5 on taskMode or intensive — those belong in the dynamic tail.
 */
export function buildStableSystemPrefix(
  project: WriterProject,
  store: WriterStore,
  permissionMode: PermissionMode,
  styleOptions: { intensive: boolean },
  _taskMode: WritingTaskMode,
): ApiMessage[] {
  const projectInstructions = projectInstructionsPrompt(project)
    ?? "项目指令：本项目未提供 WRITER.md / AGENTS.md / CLAUDE.md / .writer/instructions.md。";
  const skillsCatalog = skillsCatalogPrompt(project)
    ?? "可用项目技能：无。需要细则时调用 load_skill。";
  // Always the same project-stable block (no intensive gate) so mode switches keep prefix hits.
  const stableStyle = stableStyleGroundingPrompt(project, store, styleOptions);
  return [
    { role: "system", content: writingSystemPrompt(project) },
    { role: "system", content: executionRulesPrompt(permissionMode) },
    { role: "system", content: projectInstructions },
    { role: "system", content: skillsCatalog },
    { role: "system", content: stableStyle },
    { role: "system", content: "模式附加：任务专则与终审要求见「当前任务」动态区块。" },
  ];
}

/**
 * Fixed-count dynamic tail (exactly 8 system + 1 user every turn).
 *
 * Slot map (miss-priced — keep each body small when editing):
 *   0 history preview
 *   1 archive metadata
 *   2 task / dynamicContext
 *   3 dynamic style evidence OR placeholder
 *   4 bootstrap index OR placeholder
 *   5 todos OR placeholder
 *   6 work-memory catalog OR placeholder
 *   7 user selection OR placeholder
 *   8 user: current request
 *
 * CACHE: Place new turn-specific prompts in an existing slot or add a slot with
 * a permanent placeholder; do not omit slots. Prefer digests over full chapter text.
 */
export function buildDynamicTurnMessages(parts: {
  historyText: string;
  archiveContext: string;
  taskContext: string;
  dynamicStyleContext?: string;
  bootstrapContext?: string;
  todosPrompt?: string;
  artifactContext?: string;
  selectedContext?: string;
  prompt: string;
}): ApiMessage[] {
  return [
    { role: "system", content: parts.historyText },
    { role: "system", content: parts.archiveContext },
    { role: "system", content: parts.taskContext },
    { role: "system", content: parts.dynamicStyleContext || "本轮动态声线证据：无。" },
    { role: "system", content: parts.bootstrapContext || "写作线索：本轮无启发式索引。" },
    { role: "system", content: parts.todosPrompt || "当前对话任务清单：（空）" },
    { role: "system", content: parts.artifactContext || "本轮任务工作记忆：无。" },
    { role: "system", content: parts.selectedContext || "用户选区：无。" },
    { role: "user", content: parts.prompt },
  ];
}


/**
 * Cross-chapter continuation block appended after the per-chapter context reset
 * (contract §4 exception). The previous chapter's tool transcript is gone from the
 * request, so this single message must carry every continuity fact the next chapter
 * needs: what was already delivered, how the last chapter ends, and the final scene
 * state. Keep it compact — it is re-sent on every remaining step of the job.
 */
export function chapterContinuationPrompt(parts: {
  todosText: string;
  remainingDeliverables?: readonly string[];
  proposal?: { path: string; summary: string; afterContent: string };
  handoff?: CompletedChapterHandoff;
  /** Paths/characters already on the session materials shelf — do not re-read. */
  materialsShelf?: ReadonlyArray<{
    path?: string;
    characterId?: number;
    digest?: string;
    fullBodyServed?: boolean;
  }>;
}): string {
  const lines: string[] = [
    "上一份文件变更已成功提交，禁止重复提交同一章；为控制上下文，此前章节的场景写作过程已从本轮对话移除。",
  ];
  if (parts.proposal) {
    lines.push(`已交付：${parts.proposal.path} — ${parts.proposal.summary.replace(/\s+/g, " ").slice(0, 200)}`);
    const tail = parts.proposal.afterContent.trimEnd().slice(-800).trimStart();
    if (tail) lines.push(`上一章结尾（仅供衔接语气与局面，禁止重复叙述）：\n…${tail}`);
  }
  if (parts.handoff?.finalActualState) {
    lines.push(`上一章末场 actualState（人物与局面现状，续写以此为准）：${JSON.stringify(parts.handoff.finalActualState)}`);
  }
  const shelf = parts.materialsShelf ?? [];
  if (shelf.length) {
    const labels = shelf
      .map((item) => {
        if (item.path) return item.path;
        if (item.characterId != null) return `character:${item.characterId}`;
        return undefined;
      })
      .filter((item): item is string => Boolean(item))
      .slice(0, 16);
    lines.push(
      `本会话材料架已收录 ${shelf.length} 项已读材料${labels.length ? `（${labels.join("、")}）` : ""}。`
      + "禁止对上述路径/角色无目标整篇重读或反复 search_files；下一章直接依据材料架 digest、章末衔接与任务清单成稿。"
      + "digest 未覆盖时：用 read_file 的 block / startLine+endLine / quote 定点补读；sourceHash 已变才允许重新拉全文。",
    );
  } else {
    lines.push("材料架仍空：仅对写作必需的事实做最小读取；不要重读已交付章节全文。");
  }
  lines.push(
    parts.remainingDeliverables?.length
      ? `完成约束仍缺：${parts.remainingDeliverables.join("、")}。立即选择其中一项继续交付；任务清单仅供规划，不代表交付已经完成。`
      : "完成约束已经满足；仅在确有必要时处理剩余计划。",
    "根据下一份正文的篇幅、连续性风险和现有材料重新选择 write_file、局部 edit_file、write pack 或场景草稿链；不要沿用上一章的流程作为默认，也不要为「再确认设定」重复开局检索。",
    parts.todosText,
  );
  return lines.join("\n");
}

function persistChapterHandoff(
  store: WriterStore,
  input: {
    sessionId: string;
    sourceMessageId: number;
    jobId?: string;
    contextEpochId?: string;
    proposal?: SubmittedProposalRef;
    handoff?: CompletedChapterHandoff;
    index: number;
  },
): { nodeId: string; superseded: number } {
  const chapterKey = chapterHandoffKey({
    path: input.proposal?.path,
    index: input.index,
  });
  const payload: ChapterHandoffPayload = {
    kind: "chapter",
    ...(chapterKey ? { chapterKey } : {}),
    ...(input.proposal ? {
      path: input.proposal.path,
      summary: input.proposal.summary,
      tail: input.proposal.afterContent.trimEnd().slice(-800),
    } : {}),
    ...(input.handoff?.finalActualState != null
      ? { finalActualState: input.handoff.finalActualState }
      : {}),
  };
  const node = store.createContextNode({
    sessionId: input.sessionId,
    kind: "handoff",
    label: chapterHandoffLabel({
      path: input.proposal?.path,
      summary: input.proposal?.summary,
      index: input.index,
    }),
    sourceMessageId: input.sourceMessageId,
    jobId: input.jobId,
    payload: payload as unknown as Record<string, unknown>,
  });
  if (input.contextEpochId) {
    store.addContextEdge({
      sessionId: input.sessionId,
      fromId: input.contextEpochId,
      toId: node.id,
      kind: "produces",
    });
  }
  return {
    nodeId: node.id,
    superseded: store.supersedeContextHandoffs(input.sessionId, chapterKey, node.id),
  };
}

function completedJobHandoffPrompt(
  proposal: SubmittedProposalRef,
  handoff?: CompletedChapterHandoff,
): string {
  const lines = [
    "本 job 已完成交付；完整提案参数、门禁重试与工具过程已卸下，后续任务以持久化章节和本交接为准。",
    `已交付：${proposal.path} — ${proposal.summary.replace(/\s+/g, " ").slice(0, 240)}`,
  ];
  const tail = proposal.afterContent.trimEnd().slice(-800).trimStart();
  if (tail) lines.push(`章末衔接：\n…${tail}`);
  if (handoff?.finalActualState != null) {
    lines.push(`末场状态：${JSON.stringify(handoff.finalActualState)}`);
  }
  lines.push("需要全文时只读取已交付文档的必要片段；禁止依赖或复原本 job 的旧提案重试链。");
  return lines.join("\n");
}

export function proposalRevisionDraftCacheKey(input: {
  runId?: string;
  deliverableId?: string;
  path?: string;
  sourceHash: string;
}): string {
  const pathScope = createHash("sha256")
    .update(input.path ?? "")
    .digest("hex")
    .slice(0, 16);
  return `proposal_revision_draft:${input.runId ?? "legacy"}:${input.deliverableId ?? "document"}:${pathScope}:${input.sourceHash}`;
}

function saveProposalRevisionDraft(
  call: ToolAccumulator,
  project: WriterProject,
  store: WriterStore,
  sessionId: string,
  context?: ToolExecutionContext,
): { artifactId: number; path?: string; deliverableId?: string; sourceHash: string } | undefined {
  try {
    const input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    const inputPath = typeof input.path === "string" ? input.path : undefined;
    const inputDeliverableId = typeof input.deliverableId === "string" && input.deliverableId.trim()
      ? input.deliverableId.trim()
      : undefined;
    const captured = context?.latestProposalDraft;
    const useCaptured = Boolean(captured
      && (!inputPath || captured.path === inputPath)
      && (!inputDeliverableId || captured.deliverableId === inputDeliverableId));
    const content = useCaptured ? captured!.content : typeof input.content === "string" ? input.content : "";
    if (!content.trim()) return undefined;
    const path = useCaptured ? captured!.path : inputPath;
    const deliverableId = useCaptured ? captured!.deliverableId : inputDeliverableId;
    const sourceHash = useCaptured ? captured!.sourceHash : project.hash(content);
    const artifactId = store.saveContextArtifact(sessionId, {
      cacheKey: proposalRevisionDraftCacheKey({
        runId: context?.runId,
        deliverableId,
        path,
        sourceHash,
      }),
      kind: "proposal_revision_draft",
      path,
      sourceHash,
      content,
      digest: `${path ?? "当前文档"} 待修订稿 ${content.length} 字符`,
    });
    return { artifactId, path, ...(deliverableId ? { deliverableId } : {}), sourceHash };
  } catch {
    return undefined;
  } finally {
    if (context) context.latestProposalDraft = undefined;
  }
}

export type ProposalRevisionDraftRef = {
  artifactId: number;
  path?: string;
  deliverableId?: string;
  sourceHash: string;
  revisionCase?: ProposalRevisionCase;
};

type ProposalRevisionDocumentBase = {
  baseDocumentExists: boolean;
  baseDocumentSourceHash: string;
};

export function captureProposalRevisionDocumentBase(
  project: WriterProject,
  path?: string,
): ProposalRevisionDocumentBase {
  if (!path || !project.textFileExists(path)) {
    return {
      baseDocumentExists: false,
      baseDocumentSourceHash: PROPOSAL_REVISION_MISSING_DOCUMENT_HASH,
    };
  }
  return {
    baseDocumentExists: true,
    baseDocumentSourceHash: project.hash(project.readTextFile(path)),
  };
}

/**
 * Active revision cases are optimistic transactions over the document that was
 * on disk when the chain opened. Legacy cases have no trustworthy base and must
 * be resumed manually against the current document instead of being rebased.
 */
export function proposalRevisionBaseChangeReason(
  project: WriterProject,
  revisionCase: ProposalRevisionCase,
): string | undefined {
  const legacy = revisionCase as Partial<ProposalRevisionCase> & { schemaVersion?: unknown };
  if (legacy.schemaVersion !== 3
    || typeof legacy.baseDocumentExists !== "boolean"
    || typeof legacy.baseDocumentSourceHash !== "string") {
    return "活动修订案例来自旧版运行时，缺少可验证的目标文档基线";
  }
  if (!revisionCase.path) return "活动修订案例缺少目标文档路径，无法核对落盘基线";
  try {
    const currentExists = project.textFileExists(revisionCase.path);
    if (currentExists !== revisionCase.baseDocumentExists) {
      return revisionCase.baseDocumentExists
        ? `目标 ${revisionCase.path} 在修订期间已被删除`
        : `目标 ${revisionCase.path} 在修订期间已被其他操作创建`;
    }
    if (!currentExists) {
      return revisionCase.baseDocumentSourceHash === PROPOSAL_REVISION_MISSING_DOCUMENT_HASH
        ? undefined
        : "活动修订案例的缺失文档基线无效";
    }
    const currentSourceHash = project.hash(project.readTextFile(revisionCase.path));
    if (currentSourceHash !== revisionCase.baseDocumentSourceHash) {
      return `目标 ${revisionCase.path} 在修订期间已被其他操作修改`;
    }
    return undefined;
  } catch {
    return `无法核对目标 ${revisionCase.path} 的当前落盘状态`;
  }
}

function proposalRevisionIssues(
  result: Record<string, unknown>,
  previous: readonly ProposalRevisionIssue[] = [],
): ProposalRevisionIssue[] {
  const review = result.chapterReview;
  const rawIssues = review && typeof review === "object" && !Array.isArray(review)
    && Array.isArray((review as Record<string, unknown>).issues)
    ? (review as Record<string, unknown>).issues as unknown[]
    : [];
  const issues = rawIssues.flatMap(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const value = raw as Record<string, unknown>;
    if (value.severity !== "blocker") return [];
    const evidence = Array.isArray(value.evidence)
      ? value.evidence.filter((item): item is string => typeof item === "string").slice(0, 3)
      : [];
    const problem = typeof value.problem === "string" ? value.problem.trim() : "";
    const action = typeof value.action === "string" ? value.action.trim() : "";
    if (!problem && !action && !evidence.length) return [];
    const kind = typeof value.kind === "string" ? value.kind : "review";
    const priorIssueId = typeof value.priorIssueId === "string"
      && previous.some(issue => issue.id === value.priorIssueId && issue.kind === kind)
      ? value.priorIssueId
      : undefined;
    const origin: ProposalRevisionIssue["origin"] = value.origin === "unresolved_prior"
      || value.origin === "introduced_by_revision"
      || value.origin === "pre_existing_unrelated"
      ? value.origin
      : undefined;
    const oldText = typeof value.oldText === "string" && value.oldText.trim()
      ? value.oldText.trim().slice(0, 1_200)
      : undefined;
    return [{
      id: priorIssueId ?? proposalRevisionIssueId({ kind, evidence, problem }),
      severity: "blocker",
      kind,
      evidence,
      ...(oldText ? { oldText } : {}),
      problem,
      action,
      ...(priorIssueId ? { priorIssueId } : {}),
      ...(origin ? { origin } : {}),
    }];
  });
  return issues.slice(0, 8);
}

function semanticRepairPacket(
  draft: { path?: string; sourceHash: string },
  issues: readonly ProposalRevisionIssue[] | undefined,
): RepairPacket | undefined {
  if (!issues?.length) return undefined;
  return boundedRepairPacket({
    ...(draft.path ? { path: draft.path } : {}),
    sourceHash: draft.sourceHash,
    issueCount: issues.length,
    issues: issues.map(issue => ({
      id: issue.id,
      kind: issue.kind,
      ...(issue.oldText ? { oldText: issue.oldText } : {}),
      ...(issue.evidence[0] ? { evidence: issue.evidence[0] } : {}),
      problem: issue.problem,
      action: issue.action,
    })),
  });
}

function repairPacketForDraft(
  packet: RepairPacket | undefined,
  draft: { path?: string; sourceHash: string },
): RepairPacket | undefined {
  if (!packet || (packet.sourceHash && packet.sourceHash !== draft.sourceHash)) return undefined;
  return boundedRepairPacket({
    ...packet,
    ...(draft.path ? { path: draft.path } : {}),
    sourceHash: draft.sourceHash,
  });
}

export function saveProposalRevisionCase(
  draft: { artifactId: number; path?: string; deliverableId?: string; sourceHash: string },
  gate: ProposalRetryGate,
  retryState: ProposalRetryState,
  attempt: number,
  semanticIssues: ProposalRevisionIssue[] | undefined,
  transition: ProposalIssueTransition | undefined,
  documentBase: ProposalRevisionDocumentBase | undefined,
  store: WriterStore,
  sessionId: string,
  previous?: ProposalRevisionCase,
  options?: { rhythmPolishPending?: boolean; semanticVerdict?: boolean; repairPacket?: RepairPacket },
): ProposalRevisionDraftRef & { revisionCase: ProposalRevisionCase } {
  if (retryState.deliverableId !== draft.deliverableId || retryState.path !== draft.path) {
    throw new Error("提案修订稿与重试状态作用域不匹配");
  }
  if (previous && (previous.runId !== retryState.runId
    || previous.deliverableId !== retryState.deliverableId
    || previous.path !== draft.path)) {
    throw new Error("提案修订稿与活动案例作用域不匹配");
  }
  const previousBase = previous as (Partial<ProposalRevisionCase> & { schemaVersion?: unknown }) | undefined;
  if (previous && (previousBase?.schemaVersion !== 3
    || typeof previousBase.baseDocumentExists !== "boolean"
    || typeof previousBase.baseDocumentSourceHash !== "string")) {
    throw new Error("活动提案修订案例缺少可验证的目标文档基线");
  }
  const effectiveDocumentBase = previous
    ? {
        baseDocumentExists: previous.baseDocumentExists,
        baseDocumentSourceHash: previous.baseDocumentSourceHash,
      }
    : documentBase;
  if (!effectiveDocumentBase) {
    throw new Error("首次创建提案修订案例前未捕获目标文档基线");
  }
  const semanticVerdict = options?.semanticVerdict === true;
  const unresolvedIssues = semanticVerdict
    ? semanticIssues ?? []
    : previous?.unresolvedIssues ?? [];
  const repairPacket = repairPacketForDraft(
    options?.repairPacket ? normalizeRepairPacket(options.repairPacket) : undefined,
    draft,
  ) ?? (semanticVerdict ? semanticRepairPacket(draft, unresolvedIssues) : undefined)
    ?? repairPacketForDraft(previous?.repairPacket, draft);
  const revisionCaseId = previous?.revisionCaseId
    ?? `revision:${createHash("sha256").update(JSON.stringify([
      retryState.runId,
      retryState.deliverableId ?? "",
      draft.path ?? "document",
      effectiveDocumentBase.baseDocumentExists,
      effectiveDocumentBase.baseDocumentSourceHash,
      draft.sourceHash,
    ])).digest("hex").slice(0, 16)}`;
  const base = {
    schemaVersion: 3 as const,
    revisionCaseId,
    runId: retryState.runId,
    ...(retryState.deliverableId ? { deliverableId: retryState.deliverableId } : {}),
    path: draft.path,
    ...effectiveDocumentBase,
    draftArtifactId: draft.artifactId,
    draftSourceHash: draft.sourceHash,
    ...(semanticVerdict
      ? { semanticDraftArtifactId: draft.artifactId, semanticDraftSourceHash: draft.sourceHash }
      : previous?.semanticDraftArtifactId && previous.semanticDraftSourceHash
        ? {
            semanticDraftArtifactId: previous.semanticDraftArtifactId,
            semanticDraftSourceHash: previous.semanticDraftSourceHash,
          }
        : {}),
    ...(options?.rhythmPolishPending ? { rhythmPolishPending: true as const } : {}),
    attempt,
    lastGate: gate,
    retryState,
    unresolvedIssues,
    ...(repairPacket ? { repairPacket } : {}),
    resolvedIssueIds: semanticVerdict ? transition?.resolvedIssueIds ?? [] : previous?.resolvedIssueIds ?? [],
    stillPresentIssueIds: semanticVerdict ? transition?.stillPresentIssueIds ?? [] : previous?.stillPresentIssueIds ?? [],
    newlyIntroducedIssueIds: semanticVerdict
      ? transition?.newlyIntroducedIssueIds ?? []
      : previous?.newlyIntroducedIssueIds ?? [],
    status: "blocked" as const,
    retention: "executable" as const,
  };
  const sourceHash = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  const reviewArtifactId = store.saveContextArtifact(sessionId, {
    cacheKey: `proposal_revision_case:${retryState.runId}:${retryState.deliverableId ?? "document"}:${revisionCaseId}:${retryState.absoluteSubmissions}:${sourceHash}`,
    kind: "proposal_revision_case",
    path: draft.path,
    sourceHash,
    content: JSON.stringify(base),
    digest: `${draft.path ?? "当前文档"} ${gate} 第${attempt}轮：${unresolvedIssues.length}项未解决 blocker`,
  });
  const revisionCase: ProposalRevisionCase = { ...base, reviewArtifactId };
  const revisionCaseSourceHash = createHash("sha256").update(JSON.stringify(revisionCase)).digest("hex");
  store.saveContextArtifact(sessionId, {
    cacheKey: `proposal_revision_case:${retryState.runId}:${retryState.deliverableId ?? "document"}:${revisionCaseId}:${retryState.absoluteSubmissions}:${sourceHash}`,
    kind: "proposal_revision_case",
    path: draft.path,
    sourceHash: revisionCaseSourceHash,
    content: JSON.stringify(revisionCase),
    digest: `${draft.path ?? "当前文档"} ${gate} 第${attempt}轮：${unresolvedIssues.length}项未解决 blocker`,
  });
  return { ...draft, revisionCase };
}

function closeProposalRevisionCase(
  current: ProposalRevisionCase,
  store: WriterStore,
  sessionId: string,
): void {
  const closed: ProposalRevisionCase = {
    ...current,
    reviewArtifactId: current.reviewArtifactId,
    unresolvedIssues: [],
    resolvedIssueIds: [...new Set([...current.resolvedIssueIds, ...current.unresolvedIssues.map(issue => issue.id)])],
    stillPresentIssueIds: [],
    newlyIntroducedIssueIds: [],
    status: "resolved",
  };
  delete closed.rhythmPolishPending;
  delete closed.repairPacket;
  const sourceHash = createHash("sha256").update(JSON.stringify(closed)).digest("hex");
  store.saveContextArtifact(sessionId, {
    cacheKey: `proposal_revision_case:${current.runId}:${current.deliverableId ?? "document"}:${current.revisionCaseId}:resolved:${sourceHash}`,
    kind: "proposal_revision_case",
    path: current.path,
    sourceHash,
    content: JSON.stringify(closed),
    digest: `${current.path ?? "当前文档"} 修订案例已解决`,
  });
}

function syncProposalReviewRevisionContext(
  context: ToolExecutionContext,
  revisionCase: ProposalRevisionCase | undefined,
  store: WriterStore,
  sessionId: string,
): void {
  if (!revisionCase?.path) return;
  context.proposalReviewRevisions ??= new Map();
  context.activeProposalRevisionPaths ??= new Set();
  context.workingTextFiles ??= new Map();
  if (revisionCase.status === "blocked") {
    const draftArtifact = store.contextArtifactById(sessionId, revisionCase.draftArtifactId);
    if (draftArtifact && draftArtifact.sourceHash === revisionCase.draftSourceHash) {
      context.workingTextFiles.set(revisionCase.path, {
        path: revisionCase.path,
        content: draftArtifact.content,
        sourceHash: revisionCase.draftSourceHash,
        baseExists: revisionCase.baseDocumentExists,
        baseSourceHash: revisionCase.baseDocumentSourceHash,
        ...(revisionCase.deliverableId ? { deliverableId: revisionCase.deliverableId } : {}),
        revisionCaseId: revisionCase.revisionCaseId,
      });
    }
  } else {
    context.workingTextFiles.delete(revisionCase.path);
  }
  if (revisionCase.status === "blocked" && revisionCase.rhythmPolishPending) {
    context.rhythmGracePaths ??= new Set();
    context.rhythmGracePaths.add(revisionCase.path);
  }
  const key = proposalRevisionScopeKey(revisionCase.retryState);
  if (revisionCase.status === "blocked") context.activeProposalRevisionPaths.add(revisionCase.path);
  else context.activeProposalRevisionPaths.delete(revisionCase.path);
  if (revisionCase.status !== "blocked" || !revisionCase.semanticDraftArtifactId
    || !revisionCase.semanticDraftSourceHash || !revisionCase.unresolvedIssues.length) {
    context.proposalReviewRevisions.delete(key);
    return;
  }
  const artifact = store.contextArtifactById(sessionId, revisionCase.semanticDraftArtifactId);
  if (!artifact || artifact.sourceHash !== revisionCase.semanticDraftSourceHash) {
    context.proposalReviewRevisions.delete(key);
    return;
  }
  context.proposalReviewRevisions.set(key, {
    runId: revisionCase.runId,
    ...(revisionCase.deliverableId ? { deliverableId: revisionCase.deliverableId } : {}),
    path: revisionCase.path,
    previousContent: artifact.content,
    previousSourceHash: revisionCase.semanticDraftSourceHash,
    unresolvedIssues: revisionCase.unresolvedIssues,
  });
}

function clearProposalReviewRevisionContext(
  context: ToolExecutionContext,
  revisionCase: ProposalRevisionCase | undefined,
): void {
  if (!revisionCase) return;
  context.proposalReviewRevisions?.delete(proposalRevisionScopeKey(revisionCase.retryState));
  if (revisionCase.path) {
    context.activeProposalRevisionPaths?.delete(revisionCase.path);
    context.rhythmGracePaths?.delete(revisionCase.path);
    context.workingTextFiles?.delete(revisionCase.path);
  }
}

const PROPOSAL_SUBMISSION_TOOLS = new Set([
  "write_file",
  "edit_file",
  "move_file",
  "delete_file",
  "propose_document",
  "propose_document_patch",
  "revise_document_isolated",
  "propose_chapter_draft",
  "propose_outline_patch",
  "propose_change_set",
]);

const ACTIVE_REVISION_FILE_TOOLS = new Set(["write_file", "edit_file", "propose_document"]);

function deliverableIdFromToolCall(call: ToolCall): string | undefined {
  if (!PROPOSAL_SUBMISSION_TOOLS.has(call.name)
    && call.name !== "inspect_chapter_draft"
    && call.name !== "begin_chapter_draft") return undefined;
  try {
    const input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    return typeof input.deliverableId === "string" && input.deliverableId.trim()
      ? input.deliverableId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function proposalRevisionBoundaryPrompt(
  prompt: string,
  draft?: ProposalRevisionDraftRef,
): string {
  if (!draft) return prompt;
  return [
    prompt,
    `最新版待修订正文已保留为当前工作副本${draft.path ? `（${draft.path}）` : ""}。`,
    draft.revisionCase
      ? "修订状态已由运行时持久化；未解决 blocker 必须逐项闭合。"
      : "",
    `修订包含 oldText 时，直接用一次 edit_file 批量修改当前工作副本；仅对缺 oldText、`
      + `或替换返回不存在/不唯一的条目，才用 read_file(${JSON.stringify({ path: draft.path })}) 定点核对。`
      + "禁止重读设定、改动落盘旧版或从头另写。",
  ].join("\n");
}

function proposalRevisionTargetConstraint(
  project: WriterProject,
  draft?: ProposalRevisionDraftRef,
): string {
  if (!draft?.path || project.textFileExists(draft.path)) return "";
  return `目标 ${draft.path} 尚未落盘；继续用 edit_file 修改当前工作副本，或用 write_file 完整替换。`;
}

function proposalDraftRefFromCase(revisionCase?: ProposalRevisionCase): ProposalRevisionDraftRef | undefined {
  if (!revisionCase) return undefined;
  return {
    artifactId: revisionCase.draftArtifactId,
    path: revisionCase.path,
    deliverableId: revisionCase.deliverableId,
    sourceHash: revisionCase.draftSourceHash,
    revisionCase,
  };
}

function proposalDraftMatchesRetryScope(
  draft: { path?: string; deliverableId?: string },
  retryState: ProposalRetryState,
  previous?: ProposalRevisionCase,
): boolean {
  if (draft.path !== retryState.path) return false;
  if (draft.deliverableId !== retryState.deliverableId) return false;
  if (previous && (previous.runId !== retryState.runId
    || previous.deliverableId !== retryState.deliverableId
    || previous.path !== draft.path)) return false;
  return true;
}

export function proposalFailureShouldPersistRevisionCase(input: {
  hasScopedDraft: boolean;
  action: "revise" | "correct_call" | "pause";
  pauseReason?: "dependency" | "invalid_request" | "revision_exhausted";
  retryStateChanged: boolean;
  hasPreviousCase: boolean;
}): boolean {
  if (!input.hasScopedDraft) return false;
  return input.action === "revise"
    || (input.action === "correct_call" && input.hasPreviousCase)
    || input.retryStateChanged
    || (input.action === "pause"
      && (input.pauseReason === "revision_exhausted" || input.pauseReason === "dependency"));
}

export function proposalFailureDraft(input: {
  action: "revise" | "correct_call" | "pause";
  caseDraft?: ProposalRevisionDraftRef;
  savedDraft?: Omit<ProposalRevisionDraftRef, "revisionCase">;
  previousCase?: ProposalRevisionCase;
}): ProposalRevisionDraftRef | undefined {
  if (input.caseDraft) return input.caseDraft;
  if (input.action === "correct_call" && input.previousCase) {
    return proposalDraftRefFromCase(input.previousCase);
  }
  if (input.savedDraft) {
    return {
      ...input.savedDraft,
      ...(input.previousCase ? { revisionCase: input.previousCase } : {}),
    };
  }
  return proposalDraftRefFromCase(input.previousCase);
}

function proposalCallCorrectionPrompt(
  result: Record<string, unknown>,
  draft?: ProposalRevisionDraftRef,
): string {
  const code = typeof result.code === "string" ? result.code : "PROPOSAL_CALL_INVALID";
  const message = typeof result.error === "string"
    ? result.error
    : typeof result.message === "string" ? result.message : "文件工具调用与当前项目状态不匹配。";
  const nextAllowedActions = Array.isArray(result.nextAllowedActions)
    ? result.nextAllowedActions.filter((item): item is string => typeof item === "string")
    : [];
  const invalidReviewOutput = result.failureKind === "invalid_output";
  return [
    invalidReviewOutput
      ? `终审输出无效（${code}）；这不是正文审核驳回，不消耗语义修订次数。`
      : `文件工具调用未执行（${code}）；这不是正文审核驳回，不消耗修订次数。`,
    `原因：${message.replace(/\s+/g, " ").slice(0, 500)}`,
    nextAllowedActions.length ? `允许的下一步：${nextAllowedActions.join("、")}。` : "",
    invalidReviewOutput
      ? `保持当前正文不变，用 write_file(${JSON.stringify({ path: draft?.path })}) 重新验证当前工作副本；不要把终审格式错误当作正文问题来改稿。`
      : code === "ACTIVE_REVISION_REQUIRES_FULL_DRAFT"
        ? "用 read_file 读取当前工作副本，只改 blocker 后用 edit_file 提交；不得修改已落盘旧版绕过复审。"
      : code === "TARGET_DOCUMENT_MISSING"
      ? "目标文件尚未落盘；继续编辑当前工作副本，或用 write_file 完整替换。"
      : "修正工具名或参数后重新调用；不要为了修正调用而改写正文或重读项目材料。",
    draft ? `继续使用 ${draft.path ?? "当前文件"} 的工作副本，不要丢弃当前修订成果。` : "",
  ].filter(Boolean).join("\n");
}

export function proposalFailurePauseResult(
  result: Record<string, unknown>,
  reason: "dependency" | "invalid_request" | "revision_exhausted",
  draft?: ProposalRevisionDraftRef,
  detail?: {
    exhaustion?: "semantic_no_progress" | "gate_attempts" | "absolute_safety";
    gate?: ProposalRetryGate;
  },
): Record<string, unknown> {
  const dependency = reason === "dependency";
  const exhausted = reason === "revision_exhausted";
  const dependencyTimedOut = dependency && [result.error, result.message]
    .some(value => typeof value === "string" && /timeout|timed out|超时|未响应/iu.test(value));
  const summary = dependency
    ? dependencyTimedOut
      ? "提案审核依赖在允许时限内没有返回结果。"
      : "提案依赖的审核模型及回退模型均不可用。"
    : exhausted
      ? detail?.exhaustion === "semantic_no_progress"
        ? "同一语义 blocker 已连续两轮没有修订进展，自动提交已暂停。"
        : detail?.exhaustion === "gate_attempts"
          ? `${detail.gate ?? "确定性"} 门禁已连续三次未通过，自动提交已暂停。`
          : "当前交付项已触发防止无限循环的绝对安全上限。"
      : "提案请求本身无效，继续原样重试不会成功。";
  const blockerDetails = draft?.revisionCase?.unresolvedIssues.slice(0, 4).flatMap((issue, index) => [
    `Blocker ${index + 1} [${issue.kind}/${issue.id}]`,
    `evidence: ${issue.evidence.length ? issue.evidence.join(" | ") : "（无逐字证据）"}`,
    `problem: ${issue.problem}`,
    `action: ${issue.action}`,
  ]) ?? [];
  return {
    ...result,
    status: "waiting",
    displayMessage: [
      summary,
      typeof result.error === "string" ? result.error : typeof result.message === "string" ? result.message : "",
      ...blockerDetails,
      draft
        ? `当前正文已持久化为 ${draft.path ?? "目标文件"} 的工作副本，未丢失。`
        : "当前正文仍保留在本轮工作记忆中。",
      dependency
        ? "本次已停止自动提交；审核依赖恢复后可续跑。"
        : "本次已停止自动提交，请检查驳回信息或给出新的处理指令。",
    ].filter(Boolean).join("\n"),
    question: dependency
      ? dependencyTimedOut
        ? "文件审核本次响应超时；工作副本已保留，可续跑。"
        : "文件审核依赖暂时不可用；恢复后可续跑。"
      : "文件自动修订已停止，请检查驳回信息后决定是否续跑。",
    options: ["续跑"],
    ...(draft ? {
      path: draft.path,
      workingCopy: true,
      workingSourceHash: draft.sourceHash,
      ...(draft.revisionCase ? {
        unresolvedIssues: draft.revisionCase.unresolvedIssues,
      } : {}),
    } : {}),
  };
}

function toolResultRequestsPause(result: Record<string, unknown> | undefined): boolean {
  return result?.status === "waiting" || result?.failureKind === "dependency";
}

function genericDependencyPauseResult(toolName: string, result: Record<string, unknown>): Record<string, unknown> {
  if (result.status === "waiting") return result;
  const message = typeof result.error === "string"
    ? result.error
    : typeof result.message === "string"
      ? result.message
      : "外部工具依赖暂时不可用。";
  const summary = toolName === "generate_image"
    ? "生图服务暂时不可用，已停止自动重试。"
    : "工具依赖暂时不可用，已暂停 AgentRun。";
  return {
    ...result,
    status: "waiting",
    displayMessage: [summary, message, "依赖恢复后可续跑。"].filter(Boolean).join("\n"),
    question: toolName === "generate_image"
      ? "生图服务暂时不可用；恢复后可续跑。"
      : "外部依赖暂时不可用；恢复后可续跑。",
    options: ["续跑"],
  };
}

/**
 * UI step partitioning: generate_image never shares a step chip with other tools.
 * Preserves tool_call order so provider tool-result alignment stays valid.
 */
function groupToolCallsForImageSteps<T extends { name: string }>(calls: readonly T[]): T[][] {
  if (!calls.length) return [];
  const groups: T[][] = [];
  let current: T[] = [];
  let currentIsImage: boolean | undefined;
  for (const call of calls) {
    const isImage = call.name === "generate_image";
    if (currentIsImage === undefined || isImage === currentIsImage) {
      current.push(call);
      currentIsImage = isImage;
      continue;
    }
    groups.push(current);
    current = [call];
    currentIsImage = isImage;
  }
  if (current.length) groups.push(current);
  return groups;
}

function repairPacketForConvergePrompt(
  result: Record<string, unknown>,
  revisionCase?: ProposalRevisionCase,
): RepairPacket | undefined {
  const fromResult = normalizeRepairPacket(result.repairPacket);
  if (fromResult && (!revisionCase?.draftSourceHash
    || !fromResult.sourceHash || fromResult.sourceHash === revisionCase.draftSourceHash)) return fromResult;
  if (!revisionCase) return undefined;
  const draft = { path: revisionCase.path, sourceHash: revisionCase.draftSourceHash };
  return repairPacketForDraft(revisionCase.repairPacket, draft)
    ?? semanticRepairPacket(draft, revisionCase.unresolvedIssues);
}

function repairPacketInstructions(
  packet: RepairPacket | undefined,
  revisionCase?: ProposalRevisionCase,
): string {
  if (!packet) {
    return revisionCase
      ? "下一步用 read_file 对当前工作副本的 blocker evidence 定点定位，只做最小修订，再用 edit_file 提交；禁止重读已读材料或全文重写。"
      : "下一步必须用 edit_file 对驳回点做最小修订；禁止为同一章重新检索已读材料，禁止全文重写。";
  }
  const anchored = packet.issues.filter(issue => Boolean(issue.oldText));
  const unanchored = packet.issues.length - anchored.length;
  const sourceMatches = !revisionCase?.draftSourceHash || !packet.sourceHash
    || packet.sourceHash === revisionCase.draftSourceHash;
  if (anchored.length && sourceMatches) {
    return [
      `立即用一次 edit_file 批量处理修订包内 ${anchored.length} 条带 oldText 的最小替换；使用包内 path/sourceHash，逐条改写后保留原有情节与事实。`,
      unanchored
        ? `其余 ${unanchored} 条缺少唯一 oldText：仅对它们用 read_file({path, quote:evidence}) 定点读取后补改。`
        : "不要先 read_file、search_files 或重读设定；只有 edit_file 报 oldText 不存在、不唯一或快照变化时才定点读取。",
      packet.omittedIssueCount
        ? `本包还有 ${packet.omittedIssueCount} 条因安全上限未展开；先完成当前批次并重新提交，门禁会返回剩余条目。`
        : "",
    ].filter(Boolean).join("\n");
  }
  return "修订包没有可安全直替的 oldText，逐条用 read_file({path, quote:evidence}) 定点读取后再 edit_file；禁止整篇重读、重检索设定或全文重写。";
}

/** After a file submission is blocked by gate/review: force a minimal working-copy repair. */
export function proposalRevisionConvergePrompt(
  result: Record<string, unknown>,
  attempt: number,
  revisionCase?: ProposalRevisionCase,
): string {
  const status = typeof result.status === "string" ? result.status : "rejected";
  const code = typeof result.code === "string" ? result.code : "";
  const rawMessage = typeof result.message === "string"
    ? result.message
    : typeof result.error === "string"
      ? result.error
      : typeof result.rhythmGate === "string"
        ? result.rhythmGate
        : "";
  // Legacy rhythm notices may contain useful locators, but never turn their
  // numeric thresholds into prose instructions.
  const messageCap = /节奏硬拦截|碎句|缩词|均长|电报|RHYTHM_POLISH/.test(rawMessage + code) ? 900 : 360;
  const message = rawMessage.replace(/\s+/g, " ").slice(0, messageCap);
  const path = typeof result.path === "string" ? result.path : "";
  const hardLimit = revisionCase
    ? revisionCase.lastGate !== "semantic_review"
      && revisionCase.retryState.gateAttempts[revisionCase.lastGate] >= 2
    : attempt >= 2;
  const rhythmBlock = /节奏硬拦截|碎句|缩词|连发碎句|电报句|RHYTHM_POLISH/.test(rawMessage + code);
  const firstRoundPolish = result.rhythmRevisionRequired === true || code === "RHYTHM_POLISH_REQUIRED";
  const repairPacket = repairPacketForConvergePrompt(result, revisionCase);
  const blockerPacket = repairPacket
    ? `可执行修订包（ID/oldText/evidence/problem/action）：${JSON.stringify(repairPacket)}`
    : "";
  if (firstRoundPolish) {
    return [
      `收到旧式节奏提示（${path || "当前文档"}）；它只定位需要通读的段落，不构成数字验收线。`,
      message ? `定位信号：${message}` : "",
      blockerPacket,
      "结合人物处境和句间因果判断是否需要修改；只处理语义上失去承接的碎句，不补配额长句。完成必要的局部修改后用 edit_file 提交当前工作副本。",
    ].filter(Boolean).join("\n");
  }
  return [
    `文档提案未创建（${status}${code ? `/${code}` : ""}，${revisionCase?.lastGate ?? "当前门禁"}第 ${attempt} 次${path ? `，路径 ${path}` : ""}）。`,
    message ? `原因：${message}` : "",
    blockerPacket,
    rhythmBlock
      ? (hardLimit
        ? "旧式节奏提示已重复出现：只在正文语义确实断裂处合并观察、动作与因果；不要为均长、长句比例或碎句比例改稿。若没有可证明的问题，保留正文并标明该兼容门禁无法继续执行。"
        : "节奏信号只用于定位。通读命中段，保留承担命令、停顿和动作落点的短句，只合并语义上被机械切碎的内容；不要补配额长句或扩大改写。")
      : hardLimit
        ? "本窗口最后一轮：只按驳回项/blocker 做最小修订后重新提交一次；禁止重读已读设定、禁止扩大改写、禁止另起大纲。若仍无法满足，manage_todos 标明阻塞并继续下一可交付项，或 ask_user。"
        : repairPacketInstructions(repairPacket, revisionCase),
  ].filter(Boolean).join("\n");
}

/**
 * Scene-boundary handoff (contract §4b). After each successful scene-write call
 * the loop truncates back to the post-begin context base and appends this single
 * message, so later scenes stop paying earlier scenes' full prose on every step.
 * It must therefore carry everything the next scene needs: the seam tail, each
 * scene's actual exit state, the next scene card and the anti-formula feedback.
 */
export function sceneContinuationPrompt(
  draft: ChapterSceneDraft,
  extras: { styleFeedback?: string[]; stylePriorNotes?: string[]; evidenceGroundedWriter?: boolean },
): string {
  const completedCount = draft.completed.length;
  const next = draft.scenes[completedCount];
  const last = draft.completed.at(-1);
  const tail = last ? last.content.trimEnd().slice(-800).trimStart() : "";
  const states = draft.completed.map((scene, index) => ({
    sceneId: scene.sceneId,
    title: draft.scenes[index]?.title,
    actualState: scene.actualState,
  }));
  const remaining = draft.scenes.slice(completedCount + 1)
    .map(scene => ({ id: scene.id, title: scene.title, goal: scene.goal }));
  const lines: string[] = [
    `章节场景写作进行中（已完成 ${completedCount}/${draft.scenes.length} 场）。为控制上下文，此前各场完整正文已从本轮对话移除，只保存在内存草稿中；整章 inspect_chapter_draft 会在隔离调用中阅读全文并返回结构化终审报告，勿因此重写已完成场景。`,
    `章节：${draft.path}（${draft.mode}）· 章节目标：${draft.chapterGoal}`,
  ];
  if (tail) lines.push(`上一场结尾（仅供衔接语气与局面，禁止重复叙述）：\n…${tail}`);
  if (states.length) lines.push(`各场实际离场状态（事实与衔接以此为准）：${JSON.stringify(states)}`);
  if (extras.stylePriorNotes?.length) {
    lines.push(`stylePriorNotes（既有正文高频表达负面清单，每场都要遵守）：${extras.stylePriorNotes.join("；")}`);
  }
  if (extras.styleFeedback?.length) {
    lines.push(`styleFeedback（对已写正文的结构定位；写下一场先复核语义成因，不为统计值凑句式或口语词）：${extras.styleFeedback.join("；")}`);
  }
  if (next) {
    const sceneWriteTool = "write_chapter_scene";
    const submission = extras.evidenceGroundedWriter
      ? "只提交要点式 notes，省略 content 与 actualState；证据型 Writer 会读取共享事实包并生成正文"
      : "在同一调用中提交要点式 notes、正文与 actualState";
    lines.push(
      `当前 scene guide 的下一场：${JSON.stringify(next)}`,
      ...(remaining.length ? [`当前其后引导：${JSON.stringify(remaining)}`] : []),
      "characterScopes 是本场唯一的角色卡能力/对白声线许可：先按 competencyUses 的能力 ID 读取原卡 competencies，并遵守 mode 与返回的入场状态指令；use 才可直接使用，attempt 可失败或部分生效，unlock/regain 必须在正文建立触发与状态转变，lose 必须写出失去事件。确实要写 dialogue=true 角色的对白时，按需一并读取 voice、motivations、relationships、storyState，涉及价值/恐惧/内在冲突才读取 psychology，且只读会开口的角色。voice 仅用于所属角色的引号内对白。缺少许可不得推断更宽范围；需要扩大范围先修订未写 guide。",
      `先以真实结尾和 actualState 判断 guide 是否仍成立：成立则调用 ${sceneWriteTool}（sceneId=${next.id}），${submission}；不成立则调用 revise_chapter_scene_guide 替换全部未写引导；章节目标已经抵达则清空 remainingScenes 后终审。不要输出计划说明或更新任务清单。`,
    );
  } else {
    lines.push("当前没有未写 scene guide。若章节目标已由实际正文完成，调用 inspect_chapter_draft 并同时提供提案 summary 与已确认的 characterChanges；若仍缺少必要变化，先 revise_chapter_scene_guide 增加下一场引导。");
  }
  return lines.join("\n");
}

/**
 * Runtime-owned terminal transition for a completed scene chain. This is appended
 * outside the stable prefix, after the finished scene payload has been discarded.
 * It deliberately leaves summary/characterChanges to the Agent, but not the choice
 * of whether to review: a complete, uninspected draft has exactly one next action.
 */
export function chapterReviewRequiredPrompt(
  draft: ChapterSceneDraft,
  retry?: { rejectedTools: string[]; attempt: number },
): string {
  const lines = [
    `章节场景链已完成（${draft.completed.length}/${draft.scenes.length}）：${draft.path}。正文保存在内存草稿中，禁止重写、续写或重新建立 scene guide。`,
    "运行时已自动推进章节阶段与任务清单，不要调用 manage_todos。",
    "唯一下一步：立即调用 inspect_chapter_draft。summary 用一句话概括本章实际完成的变化；characterChanges 只提交正文已经兑现且确认需要写入角色卡的变化，没有则省略。不要输出计划说明，也不要调用其他工具。",
  ];
  if (retry?.rejectedTools.length) {
    lines.push(
      `上一尝试已被运行时拒绝（第 ${retry.attempt} 次）：${[...new Set(retry.rejectedTools)].join("、")}。这些调用未执行，草稿没有变化；不要重复生成其参数，直接调用 inspect_chapter_draft。`,
    );
  }
  return lines.join("\n");
}

export function chapterReviewAllowsTool(toolName: string): boolean {
  return toolName === "inspect_chapter_draft";
}

const COMPLETED_CHAPTER_REVIEW_STATUSES = new Set([
  "proposal_submitted",
  "proposal_failed",
  "style_revision_required",
  "structural_revision_required",
]);

/**
 * An inspect call may validly return an actionable `error` field (for example,
 * exact style blockers). Classify by the handler's closed status contract rather
 * than by the presence of `error`; malformed arguments and execution failures do
 * not carry one of these statuses and therefore keep the terminal review lock.
 */
export function chapterReviewCompleted(result: Record<string, unknown>): boolean {
  return typeof result.status === "string" && COMPLETED_CHAPTER_REVIEW_STATUSES.has(result.status);
}

export type ChapterReviewRepairLock =
  | { mode: "style" }
  | { mode: "structural"; targetSceneIds: string[] };

const CHAPTER_DRAFT_MUTATION_TOOLS = new Set([
  "write_file",
  "edit_file",
  "move_file",
  "delete_file",
  "begin_chapter_draft",
  "write_chapter_scene",
  "revise_chapter_scene_guide",
  "revise_chapter_draft_style",
  "inspect_chapter_draft",
  "propose_chapter_draft",
  "propose_document",
  "propose_document_patch",
  "revise_document_isolated",
]);

export function chapterReviewRepairLock(result: Record<string, unknown>): ChapterReviewRepairLock | undefined {
  if (result.status === "style_revision_required") return { mode: "style" };
  if (result.status !== "structural_revision_required" || !Array.isArray(result.targetScenes)) return undefined;
  const targetSceneIds = result.targetScenes.flatMap(scene => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) return [];
    const sceneId = (scene as Record<string, unknown>).sceneId;
    return typeof sceneId === "string" && sceneId.trim() ? [sceneId.trim()] : [];
  });
  return targetSceneIds.length ? { mode: "structural", targetSceneIds: [...new Set(targetSceneIds)] } : undefined;
}

export function chapterReviewRepairAllowsTool(
  lock: ChapterReviewRepairLock,
  toolName: string,
  argumentsText = "{}",
): boolean {
  if (!CHAPTER_DRAFT_MUTATION_TOOLS.has(toolName)) return true;
  if (lock.mode === "style") return toolName === "revise_chapter_draft_style";
  if (toolName !== "write_chapter_scene") return false;
  try {
    const input = JSON.parse(argumentsText) as Record<string, unknown>;
    return typeof input.sceneId === "string" && lock.targetSceneIds.includes(input.sceneId.trim());
  } catch {
    return false;
  }
}

export function automaticChapterReviewEnabled(characterEvolutionEnabled: boolean | undefined): boolean {
  // Otherwise the terminal Agent turn is still needed to author grounded characterChanges.
  return characterEvolutionEnabled === false;
}

function automaticChapterReviewSummary(draft: ChapterSceneDraft): string {
  return `完成“${draft.chapterGoal}”的整章写作与终审`;
}

export function chapterDraftNeedsReview(
  draft: ChapterSceneDraft | undefined,
  checkpointStage?: string,
): boolean {
  return Boolean(
    draft
      && chapterSceneDraftComplete(draft)
      && draft.inspectedVersion !== draft.version
      && checkpointStage !== "review_blocked",
  );
}

export async function runAgent(options: {
  project: WriterProject;
  store: WriterStore;
  sessionId: string;
  prompt: string;
  /** Optional user image attachments for multimodal-capable models. */
  attachments?: MessageAttachmentInput[];
  variantGroupId?: string;
  /** Server-side job id used to correlate every provider call in model_usage. */
  jobId?: string;
  characterScope?: number[];
  simpleCharacterScope?: number[];
  selectedDocumentBlocks?: Array<{ path: string; text?: string }>;
  resumeInterrupted?: boolean;
  model?: ModelConfig;
  models?: AgentRoleModels;
  maxTurns?: number;
  /** 覆盖 .writer/agent.json 中的权限模式 */
  permissionMode?: PermissionMode;
  /** 覆盖项目场景链设置；服务端通常传入本次任务启动时的快照。 */
  scenePipelineSettings?: ScenePipelineSettings;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}): Promise<void> {
  const { project, store, sessionId, signal } = options;
  // Empty text is allowed only when the turn carries images; give the planner a stable default.
  const prompt = (options.prompt ?? "").trim()
    || (options.attachments?.length ? "请结合附图完成写作任务。" : "");
  // Mutable copy: newly created character IDs are appended so the same turn can read them.
  const characterScope = options.characterScope === undefined ? undefined : [...options.characterScope];
  const simpleCharacterScope = options.simpleCharacterScope === undefined ? undefined : [...options.simpleCharacterScope];
  const emit = options.onEvent ?? (() => undefined);
  const model = options.models?.agent ?? options.model ?? modelConfigFromEnv();
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未设置 WRITER_API_KEY");
  }
  if (!store.sessionExists(sessionId)) throw new Error("会话不存在");

  const runtimeSettings = loadAgentSettings(project);
  const permissionMode = options.permissionMode ?? runtimeSettings.permissionMode;
  const configuredScenePipelineSettings = options.scenePipelineSettings ?? runtimeSettings.scenePipeline;
  const fastWritingMode = runtimeSettings.writingMode === "fast";
  // Fast mode keeps candidate sampling off and the main loop on Agent for every step.
  const scenePipelineSettings: ScenePipelineSettings = fastWritingMode
    ? { ...configuredScenePipelineSettings, candidateCount: 1 }
    : configuredScenePipelineSettings;
  // 本轮篇幅目标：项目默认档 + 用户这句话的覆盖。纯字符串解析，不额外调模型。
  const turnProseLength = resolveTurnProseLength(prompt, runtimeSettings.proseLength);
  emit({ type: "mode", mode: permissionMode });

  // 写作 Agent 可读全部通道；扮演试演会标注 channel=roleplay，供人设/对白参考。
  // 24 条足够契约编译器 + 历史预览；更早内容靠 inspect/read_conversation。
  const history = compactHistory(
    store.messages(sessionId, 24)
      .filter((message) => message.role !== "tool" && message.role !== "system")
      .map((message) => ({ role: message.role, content: message.content, channel: message.channel })),
  );
  const previousTaskState = store.sessionContext(sessionId);
  const previousRunState = store.agentRunState(sessionId);
  // Contract compilation declares outcome/evidence/mutation obligations, but
  // never freezes the execution path. Prefer Flash and keep the call tool-free.
  const plannerModel = options.models?.summarizer ?? options.models?.inline ?? model;
  const planned = await compileWritingTaskContract(
    plannerModel, project, store, prompt, history, signal, characterScope,
    options.selectedDocumentBlocks?.reduce((sum, block) => sum + (block.text?.length ?? 0), 0) ?? 0,
    (usage, retry) => emitUsageEvent(
      emit, store, sessionId, plannerModel, usage, 0,
      retry ? "planner_retry" : "planner", options.jobId,
    ),
    {
      projectRoot: project.root,
      sessionId,
      ...(options.jobId ? { jobId: options.jobId } : {}),
      step: 0,
    },
  );
  const task = planned.task;
  if (options.resumeInterrupted) task.continuation = true;
  // Permission policy is orthogonal to semantic mode and always wins.
  if (permissionMode === "plan") {
    task.documentProposalRequired = false;
    task.mutation = "none";
    task.proseGateRequired = false;
    task.workflow = "free";
    task.qualityProfile = "fast";
    task.capabilities = task.capabilities.filter(capability => capability !== "images");
  }
  emit({
    type: "task_contract",
    contract: {
      mode: task.mode,
      outcome: task.outcome,
      evidence: task.evidence,
      mutation: task.mutation,
      planning: task.planning,
      capabilities: task.capabilities,
      workflow: task.workflow,
      qualityProfile: task.qualityProfile,
    },
  });
  const executionModel = executionModelForTask(
    task,
    options.models ?? {},
    model,
  );
  // Build the prefix and universal capability surface once, then reuse both
  // byte-for-byte for every step. The contract guards side effects at runtime.
  const stableSystemPrefix = buildStableSystemPrefix(
    project, store, permissionMode, { intensive: false }, "general",
  );
  const executionTools = agentToolsForTask(task.mode, permissionMode);
  const executionToolNames = new Set(executionTools.map(tool => tool.function.name));
  // Task state binds to the current dialogue, not the session shell.
  // - continuation: reuse prior active doc / todos / tool memory
  // - same mode without continuation: keep todos (multi-turn ask_user etc.), but never sticky-inherit a doc via COALESCE
  // - mode change without continuation: drop prior task residue entirely
  const taskIdentity = `${task.mode}/${task.outcome}/${task.mutation}`;
  const previousIdentity = previousTaskState.currentIntent.split(":")[0]?.trim() ?? "";
  const continuationPath = task.continuation
    ? task.targetPath ?? previousTaskState.activeDocument ?? store.proposals().find(proposal => proposal.sessionId === sessionId)?.path
    : undefined;
  if (!task.continuation && previousIdentity !== taskIdentity) {
    // A mode/outcome switch invalidates workflow state, not immutable reads.
    // Exact arguments + sourceHash still guard every artifact cache lookup.
    store.clearSessionTaskState(sessionId, { preserveContextArtifacts: true, preserveMaterialsShelf: true });
  }
  // A fresh request in the same mode may keep its todo list, but must never
  // inherit an unfinished server-side draft unless the planner marked it as a continuation.
  if (!task.continuation) store.clearAgentCheckpoint(sessionId);
  const activeDocument = task.targetPath ?? continuationPath;
  store.saveSessionContext(sessionId, {
    activeDocument,
    currentIntent: `${taskIdentity}: ${prompt.slice(0, 240)}`,
  });
  let turnTodos = store.sessionTodos(sessionId);
  if (!turnTodos.length && task.todoPlan.length) {
    turnTodos = initialTodos(task.todoPlan);
    store.saveSessionTodos(sessionId, turnTodos);
  }
  emit({ type: "todos", todos: turnTodos });
  // Capture before the current agent request is persisted, while the contiguous
  // roleplay block is still the newest conversation segment.
  const roleplayHandoffContext = recentRoleplayHandoffContext(store, sessionId);
  const turnAttachments: MessageAttachment[] = options.attachments?.length
    ? store.saveMessageAttachments(sessionId, options.attachments)
    : [];
  const sourceMessageId = store.addMessage(
    sessionId,
    "user",
    prompt,
    "agent",
    options.variantGroupId,
    undefined,
    turnAttachments.length ? turnAttachments : undefined,
  );
  emit({ type: "source_message", messageId: sourceMessageId, channel: "agent" });
  const agentLoop = AgentLoopRuntime.open({
    store,
    sessionId,
    sourceMessageId,
    originalRequest: prompt,
    task,
    permissionMode,
    reusableEvidence: Boolean(
      options.selectedDocumentBlocks?.some(block => Boolean(block.text?.trim()) && block.text!.trim().length <= 800)
        || task.continuation,
    ),
    resumeInterrupted: options.resumeInterrupted === true,
    legacyState: previousRunState,
  });
  const persistRunTerminal = (
    terminalState: "interrupted" | "completed" | "failed" | "cancelled",
    terminalReason?: string,
  ) => {
    agentLoop.terminate(terminalState, terminalReason);
  };
  // Context graph: message + epoch. Process (L3) lives only inside this epoch;
  // active handoffs (L2) are linked as uses for assemble/debug.
  let contextEpochId: string | undefined;
  try {
    const messageNode = store.createContextNode({
      sessionId,
      kind: "message",
      label: `用户 · ${prompt.replace(/\s+/g, " ").slice(0, 72)}`,
      sourceMessageId,
      payload: { role: "user", preview: prompt.slice(0, 240) },
    });
    const epochNode = store.createContextNode({
      sessionId,
      kind: "epoch",
      label: `任务 · ${task.label.replace(/\s+/g, " ").slice(0, 80)}`,
      sourceMessageId,
      jobId: options.jobId,
      payload: {
        mode: task.mode,
        outcome: task.outcome,
        workflow: task.workflow,
        promptPreview: prompt.slice(0, 240),
      },
    });
    contextEpochId = epochNode.id;
    store.addContextEdge({ sessionId, fromId: epochNode.id, toId: messageNode.id, kind: "caused_by" });
    // Cross-msg cache chain: this turn's request replays earlier freezes (L1) after L0+trunk.
    const priorEpochs = store.contextNodes(sessionId, { kind: "epoch" })
      .filter(node => node.id !== epochNode.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (b.sourceMessageId ?? 0) - (a.sourceMessageId ?? 0));
    const priorEpoch = priorEpochs[0];
    if (priorEpoch) {
      store.addContextEdge({ sessionId, fromId: epochNode.id, toId: priorEpoch.id, kind: "replays" });
    }
    for (const handoff of store.activeContextHandoffs(sessionId)) {
      store.addContextEdge({ sessionId, fromId: epochNode.id, toId: handoff.id, kind: "uses" });
    }
  } catch { /* graph is diagnostic; never fail the writing job */ }
  const archiveContext = `会话归档元数据（注入历史仅为预览；完整史用 inspect/read_conversation）：${JSON.stringify(store.conversationStats(sessionId))}`;
  const selectedContext = selectedBlocksContext(project, options.selectedDocumentBlocks);
  const historyText = historicalConversationContext(history);
  const artifactContext = [
    recentArtifactsContext(
      store,
      sessionId,
      project,
      task,
      agentLoop.snapshot.deliverables.flatMap(item => item.proposalRevision ? [item.proposalRevision] : []),
    ),
    roleplayHandoffContext,
    availableImageReferencesContext(store, sessionId),
  ].filter(Boolean).join("\n\n");
  const bootstrapContext = writingBootstrapContext(project, store, prompt, task, scenePipelineSettings);
  const todosPrompt = turnTodos.length
    ? `当前对话任务清单（绑定本轮任务，非会话全局残留；可用 manage_todos 更新）：\n${formatTodosForPrompt(turnTodos)}`
    : undefined;
  const preferredSample = task.mode === "rewrite" ? undefined : options.selectedDocumentBlocks
    ?.map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
  const styleOptions = {
    intensive: permissionMode !== "plan" && task.editScope !== "point"
      && (isIntensiveWritingMode(task.mode) || task.documentProposalRequired),
    targetPath: task.targetPath ?? continuationPath,
    exampleIds: task.exampleIds,
    preferredSample: preferredSample || undefined,
    excludeProjectVoice: task.mode === "rewrite",
  };
  // Direct drafting remains available even when the optional scene chain is
  // configured for isolated writing, so the parent Agent always needs voice evidence.
  const dynamicStyleContext = dynamicStyleGroundingPrompt(project, store, styleOptions);
  // Prefer cheap roles for prose snippet second pass (flash-class models).
  const adjudicatorModel = options.models?.inline
    ?? options.models?.summarizer
    ?? options.models?.reviewer
    ?? model;
  const adjudicatorFallbackModel = [
    options.models?.summarizer,
    options.models?.reviewer,
    model,
  ].find(candidate => candidate
    && (candidate.baseUrl !== adjudicatorModel.baseUrl || candidate.model !== adjudicatorModel.model));
  // 终审与候选评判默认跟正文走同一个模型：判「这章像不像人写的」靠的是语感，
  // 一个比正文便宜的模型评自己写不出来的文字，只会把标准降到它自己的水平。
  // 「审阅校对」角色仍在，作为显式覆盖 —— 关掉 reviewFollowsProseModel 即回到它。
  const proseModel = options.models?.writer ?? executionModel;
  const reviewModel = runtimeSettings.reviewFollowsProseModel
    ? proseModel
    : options.models?.reviewer ?? executionModel;
  const chapterReviewContext = [
    projectInstructionsPrompt(project),
    structuredCreativeContext(store, task, characterScope, simpleCharacterScope),
  ].filter((value): value is string => Boolean(value?.trim())).join("\n\n");
  const restoredChapterDraft = scenePipelineSettings.enabled && task.mode === "write_scene" && task.continuation
    ? restoreChapterDraftCheckpoint(store, sessionId, project, task.targetPath ?? continuationPath)
    : undefined;
  const selectedEditLock = task.editScope === "point"
    ? selectedBlockEditLock(project, options.selectedDocumentBlocks)
    : undefined;
  let currentUsageStep: number | undefined;
  const reportToolUsage: NonNullable<ToolExecutionContext["modelUsageReporter"]> = (callModel, callUsage, meta) => {
    emit(buildRecordedUsageEvent(store, sessionId, callModel, callUsage, {
      ...meta,
      ...(meta.step === undefined && currentUsageStep !== undefined ? { step: currentUsageStep } : {}),
      ...(meta.jobId || !options.jobId ? {} : { jobId: options.jobId }),
    }));
  };
  const toolContext: ToolExecutionContext = {
    permissionMode,
    runId: agentLoop.snapshot.id,
    proposalReviewRevisions: new Map(),
    activeProposalRevisionPaths: new Set(),
    workingTextFiles: new Map(),
    ...(options.models?.image ? { imageGenerator: { model: options.models.image, signal } } : {}),
    sourceMessageId,
    editScope: task.editScope,
    ...(selectedEditLock ? { editTargetLocked: selectedEditLock } : {}),
    modelUsageReporter: reportToolUsage,
    readSnapshots: new Map(),
    readCharactersUsed: 0,
    // Session-level shelf: digests survive jobs; stale sourceHash dropped on load.
    materialsShelf: hydrateSessionMaterialsShelf(store, sessionId, project),
    simpleCharacterScope,
    reviewCharacterIds: [...new Set(task.characterIds)],
    writerCharacterConstraintHashes: new Map(
      scopedCharacterConstraintPackets(store, task, characterScope)
        .map(({ item, constraintHash }) => [item.id, constraintHash]),
    ),
    characterEvidenceReads: new Map(),
    narrativeEvidencePackets: new Map(),
    characterEvolutionEnabled: runtimeSettings.characterEvolutionEnabled,
    requireCreativeOutlineDesign: task.mode === "outline" && task.documentProposalRequired,
    ...(restoredChapterDraft ? { chapterSceneDraft: restoredChapterDraft } : {}),
    ...(restoredChapterDraft && nextChapterScene(restoredChapterDraft)
      ? {
          activeSceneCharacterScopes: {
            sceneId: nextChapterScene(restoredChapterDraft)!.id,
            characterScopes: nextChapterScene(restoredChapterDraft)!.characterScopes ?? [],
          },
        }
      : {}),
    scenePipelineSettings,
    proseLength: {
      targetCharacters: turnProseLength.targetCharacters,
      mode: turnProseLength.mode,
      enforceMinimum: runtimeSettings.proseLength.enforceMinimum,
    },
    proseAdjudicator: {
      model: adjudicatorModel,
      ...(adjudicatorFallbackModel ? { fallbackModel: adjudicatorFallbackModel } : {}),
      signal,
      reviewTimeoutsMs: {
        primary: runtimeSettings.proseGateTimeouts.primarySeconds * 1_000,
        final: runtimeSettings.proseGateTimeouts.finalSeconds * 1_000,
      },
    },
    writingMemoryExtractor: {
      model: options.models?.summarizer ?? options.models?.inline ?? adjudicatorModel,
      signal,
      run: async (input) => extractWritingMemory({
        model: options.models?.summarizer ?? options.models?.inline ?? adjudicatorModel,
        ...input,
        signal,
        usageReporter: reportToolUsage,
      }),
    },
    proseGateRules: loadProseGateRules(project),
    chapterStyleRepairer: {
      model: options.models?.inline ?? executionModel,
      ...((options.models?.inline ?? executionModel) !== executionModel
        ? { fallbackModel: executionModel }
        : {}),
      signal,
    },
    documentLocator: {
      model: options.models?.inline ?? plannerModel,
      signal,
    },
    documentRevisioner: {
      model: fastWritingMode ? model : options.models?.writer ?? executionModel,
      ...(!fastWritingMode && (options.models?.writer ?? executionModel) !== executionModel
        ? { fallbackModel: executionModel }
        : {}),
      signal,
    },
    chapterReviewer: {
      model: reviewModel,
      ...(reviewModel !== executionModel ? { fallbackModel: executionModel } : {}),
      signal,
      context: chapterReviewContext,
    },
    ...(!fastWritingMode && permissionMode !== "plan" ? {
      evidenceGroundedWriter: {
        model: options.models?.writer ?? executionModel,
        stateModel: options.models?.inline
          ?? options.models?.summarizer
          ?? options.models?.reviewer
          ?? executionModel,
        signal,
      },
    } : {}),
    // Best-of-N scene sampling: rewrites use the main writing model in a dedicated
    // plain-text call, not the cheap adjudicator. The winner is picked by the
    // reviewer model reading both drafts — a rule score cannot rank "worth reading",
    // which is the only reason to generate a second candidate at all.
    ...(scenePipelineSettings && scenePipelineSettings.candidateCount > 1
      ? {
          sceneCandidates: {
            model,
            judgeModel: reviewModel,
            signal,
          },
        }
      : {}),
  };
  for (const deliverable of agentLoop.snapshot.deliverables) {
    syncProposalReviewRevisionContext(toolContext, deliverable.proposalRevision, store, sessionId);
  }
  const persistAssistantMessage = (content: string): number => {
    const attachments = toolContext.generatedAttachments?.splice(0);
    return store.addMessage(
      sessionId,
      "assistant",
      content,
      "agent",
      options.variantGroupId,
      undefined,
      attachments?.length ? attachments : undefined,
    );
  };
  // Assemble per PROMPT / PREFIX-CACHE CONTRACT (top of this file):
  // stable 6 + project trunk + replayed frozen turns + this turn's context block,
  // then append-only tool loop. See buildStableSystemPrefix / buildDynamicTurnMessages /
  // mergedTurnContext for slot maps when adding new prompt material.
  const replayBudgetTokens = Math.max(8_000, Math.floor((executionModel.pricing?.contextWindow ?? 128_000) / 2));
  const replay = loadReplayMessages({
    store,
    sessionId,
    budgetTokens: replayBudgetTokens,
    compact: compactRuntimeMessages,
    // The shelf is session state assembled once below. Older builds froze a copy
    // into every turn, so normalize legacy blocks before the first request too.
    normalize: stripFrozenMaterialsShelfMessages,
  });
  const currentProjectTrunk = buildSessionProjectTrunk(project, store);
  // Keep the epoch's trunk byte-stable in front of replay. Project edits made by
  // an earlier turn are supplied as a dynamic authoritative update, so they no
  // longer invalidate every cached replay byte behind this system message.
  const pinnedProjectTrunk = replay.messages.length ? store.agentReplayTrunk(sessionId) : undefined;
  const projectTrunk = pinnedProjectTrunk
    ? { ...currentProjectTrunk, ...pinnedProjectTrunk }
    : currentProjectTrunk;
  if (!pinnedProjectTrunk) store.pinAgentReplayTrunk(sessionId, currentProjectTrunk);
  const activeReplayBlocks = store.agentTurnBlocks(sessionId);
  const replayHead = activeReplayBlocks.at(-1);
  const activeReplayHasCurrentUpdate = activeReplayBlocks.some(block =>
    block.projectUpdateIncluded && block.projectSnapshotHash === currentProjectTrunk.hash);
  const projectTrunkUpdate = currentProjectTrunk.hash !== projectTrunk.hash && !activeReplayHasCurrentUpdate
    ? [
        "项目索引更新（权威，覆盖前缀中的历史项目索引）：",
        `baseline=${projectTrunk.hash} current=${currentProjectTrunk.hash}`,
        currentProjectTrunk.content,
      ].join("\n")
    : "";
  const replayHeadCommitId = replayHead?.commitId;
  const trunkMessage: ApiMessage = { role: "system", content: projectTrunk.content };
  let trunkNodeId: string | undefined;
  try {
    const trunkPayload: ProjectTrunkPayload = {
      kind: "trunk",
      hash: projectTrunk.hash,
      characterCount: projectTrunk.characterCount,
      outlineNodeCount: projectTrunk.outlineNodeCount,
      lorePathCount: projectTrunk.lorePathCount,
      estimatedTokens: projectTrunk.estimatedTokens,
    };
    const trunkNode = store.ensureContextTrunk(sessionId, {
      hash: projectTrunk.hash,
      label: projectTrunk.empty
        ? "索引 · 空"
        : `索引 · 角色${projectTrunk.characterCount} · 大纲${projectTrunk.outlineNodeCount}`,
      payload: trunkPayload as unknown as Record<string, unknown>,
    });
    trunkNodeId = trunkNode.id;
  } catch { /* graph is diagnostic */ }
  const managedHandoffContext = formatActiveHandoffsForPrompt(store.activeContextHandoffs(sessionId));
  const turnContextParts = {
    taskContext: `${dynamicContextPrompt(
      project,
      store,
      prompt,
      task,
      permissionMode,
      scenePipelineSettings,
      runtimeSettings.writingMode,
      runtimeSettings.characterEvolutionEnabled,
      characterScope,
      continuationPath,
      simpleCharacterScope,
      options.resumeInterrupted === true,
      turnProseLength,
      agentLoop.deliverables.map(({ id, label }) => ({ id, label })),
    )}

${managedHandoffContext}${projectTrunkUpdate ? `\n\n${projectTrunkUpdate}` : ""}`,
    dynamicStyleContext: dynamicStyleContext || undefined,
    bootstrapContext: bootstrapContext || undefined,
    todosPrompt,
    artifactContext: artifactContext || undefined,
    selectedContext: selectedContext || undefined,
    prompt,
  };
  const messages: ApiMessage[] = [
    ...stableSystemPrefix,
    trunkMessage,
    ...replay.messages,
    // First turn of a session keeps today's exact 8-system + 1-user shape (nothing
    // but stable+trunk precedes it, so system slots are still legal). From turn 2
    // the same bodies in the same order must fold into one `user` message — see
    // mergedTurnContext (no system after assistant/tool in replay).
    ...(replay.messages.length
      ? [mergedTurnContext(turnContextParts)]
      : buildDynamicTurnMessages({ historyText, archiveContext, ...turnContextParts })),
  ];
  // Attach images only on this turn's final user message (stable prefix stays text).
  if (turnAttachments.length) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role !== "user") continue;
      const text = messageContentText(messages[index].content);
      messages[index] = {
        ...messages[index],
        content: buildMultimodalUserContent(text, turnAttachments, sessionId),
      };
      break;
    }
  }
  // Everything before this turn's own context block: frozen bytes the provider has
  // already seen (plus the session trunk, which is rebuilt identically by hash).
  const trunkEnd = stableSystemPrefix.length + 1;
  const replayedMessageCount = trunkEnd + replay.messages.length;
  // Open-turn prefix before session materials shelf (chapter cuts rebuild shelf after this).
  const initialMessageCount = messages.length;
  // Session shelf from prior jobs: inject now so step 1 is not a cold start.
  const openShelfPrompt = formatJobMaterialsShelfPrompt(toolContext);
  if (openShelfPrompt) {
    messages.push({ role: "user", content: openShelfPrompt });
  }
  // Chapter boundaries truncate here: open-turn prefix + materials shelf (if any).
  let materialsBase = messages.length;
  const openShelfCount = toolContext.materialsShelf?.size ?? 0;
  try {
    const activeHandoffs = store.activeContextHandoffs(sessionId);
    const slicePayload: AssembleSlicePayload = {
      step: 0,
      layers: [
        { id: "L0", layer: "L0", label: "写作规则与工具定义", estimatedTokens: approximateMessageTokens(stableSystemPrefix) },
        {
          id: "trunk",
          layer: "L0",
          label: "项目索引（大纲 / 角色 / 设定路径）",
          estimatedTokens: projectTrunk.estimatedTokens,
          ...(trunkNodeId ? { nodeIds: [trunkNodeId] } : {}),
        },
        { id: "L1", layer: "L1", label: "历史续写", estimatedTokens: approximateMessageTokens(replay.messages) },
        {
          id: "shelf",
          layer: "L0",
          label: openShelfCount ? `已读材料 ${openShelfCount} 项` : "已读材料 · 空",
          estimatedTokens: openShelfPrompt
            ? Math.ceil(Buffer.byteLength(openShelfPrompt, "utf8") / 4)
            : 0,
        },
        {
          id: "L2",
          layer: "L2",
          label: "当前任务与章节衔接",
          nodeIds: activeHandoffs.map(node => node.id),
          estimatedTokens: Math.ceil(Buffer.byteLength(managedHandoffContext, "utf8") / 4),
        },
        { id: "L3", layer: "L3", label: "本轮过程（切换章节后卸下）", estimatedTokens: 0 },
      ],
      replay: {
        turns: replay.replayedTurns,
        estimatedTokens: replay.estimatedTokens,
        compacted: replay.compacted,
        droppedTurns: replay.droppedTurns,
        budgetTokens: replayBudgetTokens,
      },
      trunk: { hash: projectTrunk.hash, estimatedTokens: projectTrunk.estimatedTokens },
      transition: {
        kind: "open_turn",
        afterTokens: approximateMessageTokens(messages),
        afterMessageCount: messages.length,
        kept: [
          { id: "L0", label: "写作规则与工具定义", detail: "跨任务稳定的产品规则" },
          { id: "trunk", label: "项目索引", detail: projectTrunk.empty ? "暂无索引" : `角色 ${projectTrunk.characterCount} · 大纲 ${projectTrunk.outlineNodeCount} · 设定 ${projectTrunk.lorePathCount}` },
          {
            id: "L1",
            label: "历史续写",
            detail: replay.replayedTurns
              ? `${replay.replayedTurns} 轮 · 约 ${replay.estimatedTokens.toLocaleString()}`
              : "本会话首轮，无历史续写",
          },
          {
            id: "shelf",
            label: openShelfCount
              ? `已读材料 ${openShelfCount} 项（本会话保留）`
              : "已读材料为空",
            detail: openShelfCount
              ? "本会话已读设定的摘要；文件未改则不再整篇重读"
              : "本会话尚未完整读过设定；读后会写入已读材料",
          },
          { id: "L2", label: "当前任务与章节衔接", detail: "焦点任务与已交付章节摘要" },
        ],
        dropped: [],
        reReadHint: openShelfCount
          ? "已收录摘要的路径不必再整篇读取；未收录或文件变更时再补读。"
          : "项目索引只有路径与骨架，不是全文；设定需读取一次后才会进入已读材料。",
      },
      materialsShelfCount: openShelfCount,
      note: "本轮开场",
    };
    const slice = store.createContextNode({
      sessionId,
      kind: "assemble_slice",
      label: "装载 · 本轮开场",
      sourceMessageId,
      jobId: options.jobId,
      payload: slicePayload as unknown as Record<string, unknown>,
    });
    if (contextEpochId) {
      store.addContextEdge({ sessionId, fromId: slice.id, toId: contextEpochId, kind: "includes" });
      for (const handoff of activeHandoffs) {
        store.addContextEdge({ sessionId, fromId: slice.id, toId: handoff.id, kind: "uses" });
      }
      if (trunkNodeId) {
        store.addContextEdge({ sessionId, fromId: slice.id, toId: trunkNodeId, kind: "uses" });
      }
    }
  } catch { /* ignore graph errors */ }
  // Scene-boundary resets truncate back here (§4b): advanced past prep reads when
  // begin_chapter_draft succeeds, so chapter facts survive while scene prose does not.
  let contextBase = materialsBase;
  const restoredCheckpoint = restoredChapterDraft ? store.agentCheckpoint(sessionId) : undefined;
  let chapterReviewRequired = chapterDraftNeedsReview(restoredChapterDraft, restoredCheckpoint?.stage);
  let chapterReviewRejectedAttempts = 0;
  const restoredRepair = restoredCheckpoint?.reviewRepair;
  let chapterReviewRepair: ChapterReviewRepairLock | undefined = restoredRepair?.mode === "style"
    ? { mode: "style" }
    : restoredRepair?.mode === "structural" && restoredRepair.targetSceneIds?.length
      ? { mode: "structural", targetSceneIds: [...new Set(restoredRepair.targetSceneIds)] }
      : undefined;
  if (chapterReviewRequired && restoredChapterDraft) {
    messages.push({ role: "user", content: chapterReviewRequiredPrompt(restoredChapterDraft) });
  }
  let transcript = "";
  let documentProposalSubmitted = false;
  // Executable proposal revision state belongs to AgentRun deliverables. Session
  // artifacts retain bodies/reviews, but never decide whether a fresh run may retry.
  /** Cached prefix immediately before the first full-body proposal in a retry chain. */
  let proposalRetryBase: number | undefined;
  /** Proposal that actually succeeded this step (never "latest in store" alone). */
  let submittedProposalRef: SubmittedProposalRef | undefined;
  let completedDocumentDeliverables = agentLoop.completedDocumentDeliverables;
  let characterMutationSubmitted = false;
  let characterMutationName = "";
  let lastCharacterMutationDiagnostic = "";
  let waitingForUser = false;
  const toolCallCounts = new Map<string, number>();
  const requiresCharacterMutation = permissionMode !== "plan"
    && (task.mutation === "character" || task.mutation === "mixed");
  let executionProgress = agentLoop.executionProgress();
  const replannedFailures = new Set<string>();
  let thinkingContinuationDisabled = false;
  // Measured prefix-cache usage for this turn, summed over its agent_step calls.
  // Written onto the epoch node at freeze so the context graph can answer
  // "what did this turn actually cost, and how much of it was already cached".
  const turnCache = { promptTokens: 0, cacheHitTokens: 0, steps: 0 };
  /**
   * Freeze this turn (its context block + tool transcript) so the next turn in the
   * same session replays it instead of rebuilding from zero. Called on the normal
   * and cancelled exits only — an exception leaves a half-written tail that must
   * not become someone's cached prefix. Never called mid-job: contract §4.
   */
  const freezeCurrentTurn = () => {
    try {
      persistSessionMaterialsShelf(store, sessionId, toolContext);
      // Session materials are assembled once at the next open turn; freezing them
      // into every turn duplicates the same digest table across the replay chain.
      const block = stripFrozenMaterialsShelfMessages(
        freezeTurnBlock(messages, replayedMessageCount),
      );
      if (!block.length) return;
      store.appendAgentTurnBlock(sessionId, {
        turnIndex: store.nextAgentTurnIndex(sessionId),
        sourceMessageId,
        projectSnapshotHash: currentProjectTrunk.hash,
        projectUpdateIncluded: Boolean(projectTrunkUpdate),
        messages: block,
        estimatedTokens: approximateMessageTokens(block),
      });
      if (contextEpochId) {
        store.updateContextNode(sessionId, contextEpochId, {
          payload: {
            mode: task.mode,
            outcome: task.outcome,
            workflow: task.workflow,
            promptPreview: prompt.slice(0, 240),
            frozen: true,
            frozenTokens: approximateMessageTokens(block),
            ...(turnCache.steps
              ? {
                  cache: {
                    promptTokens: turnCache.promptTokens,
                    cacheHitTokens: turnCache.cacheHitTokens,
                    steps: turnCache.steps,
                    ...(turnCache.promptTokens > 0
                      ? { hitRate: turnCache.cacheHitTokens / turnCache.promptTokens }
                      : {}),
                  } satisfies EpochCacheStats,
                }
              : {}),
          },
        });
      }
    } catch { /* 缓存优化失败不影响本轮结果。 */ }
  };

  try {
    // Step budget:
    // - hard (default): single configurable hard cap; no soft/stall converge.
    // - experimental: soft budget + stall converge + absolute safety rail.
    // Exhaustion never throws — freezes the turn and leaves「续跑」via [生成已中断].
    // options.maxTurns (tests) always forces a single hard limit.
    const stepBudgetMode = options.maxTurns !== undefined
      ? "hard" as const
      : runtimeSettings.stepBudgetMode;
    // maxAgentSteps is the per-deliverable ceiling. A multi-document request gets
    // one slice per independent output; tests may still force a single hard cap
    // with options.maxTurns.
    const perDeliverableHardCap = Math.max(1, options.maxTurns ?? runtimeSettings.maxAgentSteps);
    const hardCap = computeAgentHardTurnBudget({
      baseHardCap: perDeliverableHardCap,
      documentDeliverables: task.documentDeliverables.length,
      documentProposalRequired: task.documentProposalRequired,
      maxTurnsOverride: options.maxTurns !== undefined,
    });
    // A completed draft must not fail merely because scene retries consumed the
    // ordinary budget. These turns exist only while the terminal review lock is
    // active; unfinished scene chains receive no extra capacity.
    const terminalReviewTurnLimit = 2;
    let terminalReviewTurns = 0;
    let turnStart = messages.length;
    let stallStreak = 0;
    let lastProgressFingerprint = "";
    let convergeMode: AgentBudgetPauseReason | undefined;
    let convergeTurnsLeft = 0;
    let pauseForUserResume: {
      reason: AgentBudgetPauseReason;
      softBudget: number;
      hardCap: number;
      usedSteps: number;
    } | undefined;
    let requestTraceId: string | undefined;
    const requestTraceSteps: NonNullable<AssembleSlicePayload["requestSteps"]> = [];
    /** UI step ids may advance mid-turn when generate_image is split into its own chip. */
    let nextUiStep = 1;
    // CACHE: append-only for the whole job — never rewrite prior message bodies
    // between steps (compact/rehydrate/strip would break step-to-step prefix hits).
    for (let turn = 0; ; turn += 1) {
      const liveTodos = store.sessionTodos(sessionId);
      const softBudget = stepBudgetMode === "hard"
        ? hardCap
        : Math.min(hardCap, computeSoftTurnBudget({
          todos: liveTodos,
          todoPlanLength: task.todoPlan.length,
          documentDeliverables: task.documentDeliverables.length,
          completedDocumentDeliverables,
          documentProposalRequired: task.documentProposalRequired,
          mutation: task.mutation,
          scenePipelineEnabled: scenePipelineSettings.enabled && task.editScope === "document",
          chapterSceneDraft: toolContext.chapterSceneDraft,
        }));
      const progressFp = agentStepProgressFingerprint(liveTodos, executionProgress, {
        documentProposalSubmitted,
        characterMutationSubmitted,
        chapterReviewRequired,
        chapterSceneVersion: toolContext.chapterSceneDraft?.version,
        chapterScenesCompleted: toolContext.chapterSceneDraft?.completed.length,
        completedDocumentDeliverables,
      });
      if (turn > 0) {
        if (progressFp === lastProgressFingerprint) stallStreak += 1;
        else stallStreak = 0;
      }
      lastProgressFingerprint = progressFp;

      const activeDeliverable = agentLoop.activeDocumentDeliverable();
      const reserveUsed = activeDeliverable?.execution?.reviewReserveUsed ?? 0;
      const terminalReviewGrace = chapterReviewRequired
        && (activeDeliverable
          ? reserveUsed < AGENT_REVIEW_RESERVE_TURNS_PER_DELIVERABLE
          : terminalReviewTurns < terminalReviewTurnLimit);
      const proposalRevisionGrace = Boolean(activeDeliverable?.proposalRevision)
        && reserveUsed < AGENT_REVIEW_RESERVE_TURNS_PER_DELIVERABLE;
      const reviewGrace = terminalReviewGrace || proposalRevisionGrace;
      if (turn >= hardCap) {
        if (!reviewGrace) {
          pauseForUserResume = {
            reason: "hard_cap",
            softBudget,
            hardCap,
            usedSteps: turn,
          };
          break;
        }
        if (activeDeliverable) {
          agentLoop.useDeliverableReviewReserve(
            activeDeliverable.id,
            turn + 1,
            terminalReviewGrace ? "terminal_review" : "proposal_revision",
            `deliverable-review-reserve:${sourceMessageId}:${turn + 1}:${activeDeliverable.id}`,
          );
        } else {
          terminalReviewTurns += 1;
        }
      }
      if (convergeMode && convergeTurnsLeft <= 0 && !reviewGrace) {
        pauseForUserResume = {
          reason: convergeMode,
          softBudget,
          hardCap,
          usedSteps: turn,
        };
        break;
      }
      // Soft/stall converge only in experimental mode.
      if (stepBudgetMode === "experimental") {
        if (!convergeMode && !reviewGrace && stallStreak >= AGENT_STALL_WINDOW) {
          convergeMode = "stall";
          convergeTurnsLeft = AGENT_CONVERGE_TURNS;
          messages.push({
            role: "user",
            content: agentBudgetConvergePrompt("stall", {
              step: turn + 1,
              softBudget,
              hardCap,
              openTodos: liveTodos.filter(todo => todo.status === "pending" || todo.status === "in_progress").length,
            }),
          });
          stallStreak = 0;
        } else if (!convergeMode && !reviewGrace && turn >= softBudget) {
          convergeMode = "soft_budget";
          convergeTurnsLeft = AGENT_CONVERGE_TURNS;
          messages.push({
            role: "user",
            content: agentBudgetConvergePrompt("soft_budget", {
              step: turn + 1,
              softBudget,
              hardCap,
              openTodos: liveTodos.filter(todo => todo.status === "pending" || todo.status === "in_progress").length,
            }),
          });
        }
      }
      if (convergeMode) convergeTurnsLeft -= 1;

      let step = nextUiStep;
      nextUiStep += 1;
      currentUsageStep = step;
      agentLoop.recordStep(step, activeDeliverable?.id);
      emit({ type: "step_start", step });
      const stepModel = executionModelForStep(
        task.mode,
        executionModel,
        options.models?.writer,
        fastWritingMode && permissionMode !== "plan" && task.documentProposalRequired,
        toolContext.chapterSceneDraft,
      );
      const stepThinkingOptions = chapterReviewRequired
        ? nonThinkingRequestOptions(stepModel)
        : thinkingContinuationDisabled
        ? nonThinkingRequestOptions(stepModel)
        : thinkingRequestOptions(stepModel);
      const requestComponents = buildRequestComponentUsage(
        messages,
        executionTools,
        6,
        initialMessageCount,
        replayedMessageCount,
        1,
      );
      const requestEstimatedTokens = requestComponents.reduce(
        (sum, component) => sum + component.estimatedTokens,
        0,
      );
      const requestLayers = (["L0", "L1", "L2", "L3"] as const).flatMap((layer) => {
        const estimatedTokens = requestComponents
          .filter((component) => component.layer === layer)
          .reduce((sum, component) => sum + component.estimatedTokens, 0);
        if (estimatedTokens <= 0) return [];
        return [{
          id: `request-${step}-${layer}`,
          layer,
          label: CONTEXT_GRAPH_LAYER_LABEL_FOR_REQUEST[layer],
          estimatedTokens,
        }];
      });
      const previousRequestTokens = requestTraceSteps.at(-1)?.estimatedTokens ?? 0;
      const requestStepSnapshot: NonNullable<AssembleSlicePayload["requestSteps"]>[number] = {
        step,
        estimatedTokens: requestEstimatedTokens,
        changeTokens: requestEstimatedTokens - previousRequestTokens,
        requestComponents,
      };
      requestTraceSteps.push(requestStepSnapshot);
      const requestTraceFirstStep = requestTraceSteps[0]!.step;
      const requestTraceLabel = requestTraceSteps.length === 1
        ? `Step ${step} 上下文增长`
        : `Step ${requestTraceFirstStep}–${step} 上下文增长`;
      const requestTracePayload = (): AssembleSlicePayload => ({
        step,
        layers: requestLayers,
        requestSteps: requestTraceSteps,
        note: requestTraceLabel,
      });
      try {
        if (requestTraceId) {
          store.updateContextNode(sessionId, requestTraceId, {
            label: `装载 · ${requestTraceLabel}`,
            payload: requestTracePayload() as unknown as Record<string, unknown>,
          });
        } else {
          const requestTrace = store.createContextNode({
            sessionId,
            kind: "assemble_slice",
            label: `装载 · ${requestTraceLabel}`,
            sourceMessageId,
            jobId: options.jobId,
            payload: requestTracePayload() as unknown as Record<string, unknown>,
          });
          requestTraceId = requestTrace.id;
          if (contextEpochId) {
            store.addContextEdge({
              sessionId,
              fromId: requestTrace.id,
              toId: contextEpochId,
              kind: "includes",
            });
          }
        }
      } catch { /* graph diagnostics must not block the provider request */ }
      const result = await streamCompletion(stepModel, messages, signal, (text) => {
        transcript += text;
        emit({ type: "text", text, channel: "output" });
      }, (text) => emit({ type: "text", text, channel: "reasoning" }), {
        tools: executionTools,
        resolveAttachment: (attachmentSessionId, attachmentId) =>
          store.resolveAttachmentBytes(attachmentSessionId, attachmentId),
        // DeepSeek isolates KV cache by user_id. Use an opaque project identity so
        // stable prefixes survive new sessions without crossing project boundaries.
        ...(isDeepSeekModel(stepModel) || usesResponsesApi(stepModel)
          ? { userId: projectCacheUserId(project.root) }
          : {}),
        prefixCache: {
          projectRoot: project.root,
          sessionId,
          ...(options.jobId ? { jobId: options.jobId } : {}),
          callKind: "agent_step",
          step,
          stableMessageCount: 6,
          initialMessageCount,
          replayedMessageCount,
          ...(replayHeadCommitId ? { replayHeadCommitId } : {}),
          projectSnapshotHash: currentProjectTrunk.hash,
        },
        ...stepThinkingOptions,
      });
      if (requestTraceId && result.usage) {
        Object.assign(requestStepSnapshot, {
          providerPromptTokens: result.usage.promptTokens,
          cacheHitTokens: result.usage.cacheHitTokens,
          cacheMissTokens: result.usage.cacheMissTokens,
          ...(result.usage.estimated ? { estimatedUsage: true } : {}),
        });
        try {
          store.updateContextNode(sessionId, requestTraceId, {
            payload: requestTracePayload() as unknown as Record<string, unknown>,
          });
        } catch { /* graph diagnostics must not affect the Agent loop */ }
      }
      const ensureThinkingTranscriptCanContinue = () => {
        if (isDeepSeekModel(stepModel) && "thinking" in stepThinkingOptions
          && stepThinkingOptions.thinking.type === "enabled"
          && !result.reasoningContent.trim()) {
          thinkingContinuationDisabled = true;
          emit({
            type: "text",
            channel: "reasoning",
            text: "\n[DeepSeek 未返回 reasoning_content；已保留本步结果，后续步骤切换为非 Thinking 模式。]\n",
          });
        }
      };
      if (result.usage) {
        emitUsageEvent(emit, store, sessionId, stepModel, result.usage, step, "agent_step", options.jobId, requestComponents);
        // Estimated usage is a fallback shape with cacheHitTokens 0 — counting it
        // would drag the reported hit rate toward zero for reasons unrelated to
        // the prompt layout.
        if (!result.usage.estimated) {
          turnCache.promptTokens += result.usage.promptTokens;
          turnCache.cacheHitTokens += result.usage.cacheHitTokens;
          turnCache.steps += 1;
        }
      }
      if (!result.toolCalls.length) {
        emit({ type: "step_done", step });
        if (chapterReviewRequired && toolContext.chapterSceneDraft) {
          messages.push({
            role: "assistant",
            content: stripDsmlText(result.content || "", "[本步未调用终审工具]"),
            ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
          });
          messages.push({
            role: "user",
            content: chapterReviewRequiredPrompt(toolContext.chapterSceneDraft),
          });
          ensureThinkingTranscriptCanContinue();
          continue;
        }
        const gaps = agentLoop.completionGaps(store.sessionTodos(sessionId));
        if (gaps.length) {
          messages.push({
            role: "assistant",
            content: stripDsmlText(result.content || "", "[本步未调用工具]"),
            ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
          });
          messages.push({
            // CACHE: user role — a mid-job system message flips DeepSeek's
            // whole-request rendering and forfeits the cached prefix (§4).
            role: "user",
            content: completionRecoveryPrompt(gaps, executionProgress),
          });
          ensureThinkingTranscriptCanContinue();
          continue;
        }
        const answer = stripDsmlText(transcript, "").trim() || "任务已处理。";
        persistAssistantMessage(answer);
        // This step's reply was never pushed into `messages` (the loop returns here),
        // so close the transcript before freezing — otherwise the next turn replays a
        // tool result with no answer after it.
        messages.push({ role: "assistant", content: answer });
        freezeCurrentTurn();
        persistRunTerminal("completed");
        emit({ type: "done", sessionId });
        return;
      }

      turnStart = messages.length;
      if (proposalRetryBase === undefined
        && result.toolCalls.some(call => PROPOSAL_SUBMISSION_TOOLS.has(call.name))) {
        proposalRetryBase = messages.length;
      }
      messages.push({
        role: "assistant",
        content: stripDsmlText(result.content || "", "[工具调用已隐藏]"),
        ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
        tool_calls: result.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      waitingForUser = false;
      documentProposalSubmitted = false;
      submittedProposalRef = undefined;
      let beginChapterSucceeded = false;
      let sceneWrittenFeedback: string[] | undefined;
      let chapterReviewInStep = false;
      let characterMutationFailedThisStep = false;
      const chapterReviewRejectedTools: string[] = [];
      /** Injected after all tool results of this step (never between tool rows). */
      let pendingProposalRevisionPrompt: string | undefined;
      let pendingProposalRevisionDraft: ProposalRevisionDraftRef | undefined;
      const toolCallGroups = groupToolCallsForImageSteps(result.toolCalls);
      for (let groupIndex = 0; groupIndex < toolCallGroups.length; groupIndex += 1) {
        if (groupIndex > 0) {
          // Close the prep/other-tools chip, then open a dedicated generate_image step.
          emit({ type: "step_done", step });
          step = nextUiStep;
          nextUiStep += 1;
          currentUsageStep = step;
          agentLoop.recordStep(step, activeDeliverable?.id);
          emit({ type: "step_start", step });
        }
        for (const call of toolCallGroups[groupIndex] ?? []) {
        let effectiveCall = call;
        if (waitingForUser) {
          emit({ type: "tool", name: call.name });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              status: "skipped",
              code: "AGENT_RUN_WAITING",
              message: "本步较早的工具调用已暂停 AgentRun；为防止暂停后继续写入，本调用未执行。",
            }),
          });
          continue;
        }
        emit({ type: "tool", name: call.name });
        if (executionToolNames.has(call.name) && isCharacterMutationTool(call.name)) {
          // A provider length stop may omit whole trailing fields even when braces
          // happen to be closable; let the isolated repairer decide what is safe.
          const locallyRepaired = result.finishReason === "length"
            ? undefined
            : repairTruncatedToolArguments(effectiveCall.arguments);
          if (locallyRepaired) {
            effectiveCall = { ...effectiveCall, arguments: locallyRepaired };
          } else {
            const definition = executionTools.find(tool => tool.function.name === call.name);
            if (definition) {
              try {
                const repaired = await repairToolArgumentsWithModel(
                  plannerModel, effectiveCall, definition, signal,
                  {
                    projectRoot: project.root,
                    sessionId,
                    ...(options.jobId ? { jobId: options.jobId } : {}),
                    callKind: "tool_argument_repair",
                    step,
                    stableMessageCount: 1,
                    initialMessageCount: 2,
                  },
                );
                if (repaired.usage) {
                  emitUsageEvent(
                    emit, store, sessionId, plannerModel, repaired.usage, step,
                    "tool_argument_repair", options.jobId,
                    [{
                      kind: "other",
                      label: `${call.name} 参数修复`,
                      characters: effectiveCall.arguments.length,
                      estimatedTokens: approximateRequestTokens(effectiveCall.arguments),
                    }],
                  );
                }
                if (repaired.arguments) {
                  effectiveCall = { ...effectiveCall, arguments: repaired.arguments };
                } else {
                }
              } catch {
              }
            }
          }
        }
        let deliverableId = deliverableIdFromToolCall(effectiveCall);
        if (!deliverableId && CHAPTER_SCENE_CONTINUATION_TOOLS.has(call.name)) {
          deliverableId = toolContext.chapterSceneDraft?.deliverableId;
        }
        let proposalScopeError: string | undefined;
        let proposalScopeCode = "PROPOSAL_REVISION_SCOPE_MISMATCH";
        let proposalScopeRetryable = true;
        let proposalScopeNextAllowedActions: string[] | undefined;
        let proposalDocumentBaseBeforeCall: ProposalRevisionDocumentBase | undefined;
        let proposalRevisionBeforeCall: ProposalRevisionCase | undefined;
        if (call.name === "begin_chapter_draft") {
          const requestedDeliverableId = deliverableId;
          const canonicalDeliverableId = agentLoop.proposalDeliverableId(requestedDeliverableId);
          if (requestedDeliverableId && !canonicalDeliverableId) {
            proposalScopeError = `交付项 ${requestedDeliverableId} 不属于当前 AgentRun`;
          } else if (canonicalDeliverableId) {
            const activeRevision = agentLoop.proposalRevision(canonicalDeliverableId);
            if (activeRevision) {
              proposalScopeCode = "ACTIVE_REVISION_REQUIRES_FULL_DRAFT";
              proposalScopeError = `交付项 ${canonicalDeliverableId} 有活动完整草稿修订链；不能另建场景草稿绕过复审`;
            } else {
              deliverableId = canonicalDeliverableId;
              try {
                const input = JSON.parse(effectiveCall.arguments || "{}") as Record<string, unknown>;
                effectiveCall = {
                  ...effectiveCall,
                  arguments: JSON.stringify({ ...input, deliverableId: canonicalDeliverableId }),
                };
              } catch { /* Invalid JSON is handled by executeTool. */ }
            }
          }
        } else if (CHAPTER_SCENE_CONTINUATION_TOOLS.has(call.name) && toolContext.chapterSceneDraft) {
          const draftDeliverableId = toolContext.chapterSceneDraft.deliverableId;
          if (deliverableId && draftDeliverableId && deliverableId !== draftDeliverableId) {
            proposalScopeError = `场景草稿绑定交付项 ${draftDeliverableId}，不能改绑为 ${deliverableId}`;
          } else if (!draftDeliverableId
            && agentLoop.snapshot.deliverables.some(item => Boolean(item.proposalRevision))) {
            proposalScopeCode = "ACTIVE_REVISION_REQUIRES_FULL_DRAFT";
            proposalScopeError = "当前场景草稿没有可验证的交付项作用域，不能覆盖活动完整草稿修订链";
          } else if (draftDeliverableId) {
            const canonicalDeliverableId = agentLoop.proposalDeliverableId(draftDeliverableId);
            if (!canonicalDeliverableId) {
              proposalScopeError = `场景草稿交付项 ${draftDeliverableId} 不属于当前 AgentRun`;
            } else {
              deliverableId = canonicalDeliverableId;
              if (agentLoop.proposalRevision(canonicalDeliverableId)) {
                proposalScopeCode = "ACTIVE_REVISION_REQUIRES_FULL_DRAFT";
                proposalScopeError = `交付项 ${canonicalDeliverableId} 有活动完整草稿修订链；不能通过场景草稿链绕过复审`;
              }
            }
          }
        }
        if (!proposalScopeError && PROPOSAL_SUBMISSION_TOOLS.has(call.name)) {
          toolContext.latestProposalDraft = undefined;
          toolContext.proposalExpectedDocumentBase = undefined;
          const requestedDeliverableId = deliverableId;
          const canonicalDeliverableId = agentLoop.proposalDeliverableId(requestedDeliverableId);
          if (requestedDeliverableId && !canonicalDeliverableId) {
            proposalScopeError = `交付项 ${requestedDeliverableId} 不属于当前 AgentRun`;
          } else if (canonicalDeliverableId) {
            deliverableId = canonicalDeliverableId;
            proposalRevisionBeforeCall = agentLoop.proposalRevision(canonicalDeliverableId);
            try {
              const input = JSON.parse(effectiveCall.arguments || "{}") as Record<string, unknown>;
              const path = typeof input.path === "string" ? input.path : undefined;
              const activeRevision = proposalRevisionBeforeCall;
              const pathOwner = path
                ? agentLoop.snapshot.deliverables.find(item => item.id !== canonicalDeliverableId
                  && item.proposalRevision?.status === "blocked"
                  && item.proposalRevision.path === path)
                : undefined;
              if (pathOwner) {
                proposalScopeCode = "PROPOSAL_REVISION_PATH_OWNED";
                proposalScopeError = `路径 ${path} 已绑定交付项 ${pathOwner.id} 的活动修订链，不能由 ${canonicalDeliverableId} 重复提交`;
              } else if (activeRevision && !ACTIVE_REVISION_FILE_TOOLS.has(call.name)) {
                proposalScopeCode = "ACTIVE_REVISION_REQUIRES_FULL_DRAFT";
                proposalScopeError = `交付项 ${canonicalDeliverableId} 有活动工作副本；只能用 read_file 查看并用 edit_file/write_file 修订`;
                proposalScopeNextAllowedActions = ["read_file", "edit_file", "write_file"];
              } else if (activeRevision?.path && path && activeRevision.path !== path) {
                proposalScopeError = `交付项 ${canonicalDeliverableId} 的活动修订链绑定 ${activeRevision.path}，不能切换为 ${path}`;
              } else if (activeRevision && path && activeRevision.path === path) {
                const baseChangeReason = proposalRevisionBaseChangeReason(project, activeRevision);
                if (baseChangeReason) {
                  proposalScopeCode = "PROPOSAL_REVISION_BASE_CHANGED";
                  proposalScopeRetryable = false;
                  proposalScopeNextAllowedActions = ["ask_user"];
                  proposalScopeError = `${baseChangeReason}；旧修订稿不能自动覆盖当前文档。请由用户确认后重新基于当前文档开始修订`;
                } else {
                  toolContext.proposalExpectedDocumentBase = {
                    path,
                    deliverableId: canonicalDeliverableId,
                    exists: activeRevision.baseDocumentExists,
                    sourceHash: activeRevision.baseDocumentSourceHash,
                    revisionCaseId: activeRevision.revisionCaseId,
                  };
                  effectiveCall = {
                    ...effectiveCall,
                    arguments: JSON.stringify({ ...input, deliverableId: canonicalDeliverableId }),
                  };
                }
              } else {
                if (!activeRevision && path) {
                  proposalDocumentBaseBeforeCall = captureProposalRevisionDocumentBase(project, path);
                  toolContext.proposalExpectedDocumentBase = {
                    path,
                    deliverableId: canonicalDeliverableId,
                    exists: proposalDocumentBaseBeforeCall.baseDocumentExists,
                    sourceHash: proposalDocumentBaseBeforeCall.baseDocumentSourceHash,
                  };
                }
                effectiveCall = {
                  ...effectiveCall,
                  arguments: JSON.stringify({ ...input, deliverableId: canonicalDeliverableId }),
                };
              }
            } catch {
              // Invalid JSON is handled by executeTool and never consumes a gate.
            }
          }
        }
        let toolResult: string;
        if (proposalScopeError) {
          toolResult = JSON.stringify({
            status: "recoverable_state_error",
            code: proposalScopeCode,
            failureKind: "invalid_request",
            retryable: proposalScopeRetryable,
            error: proposalScopeError,
            ...(proposalScopeNextAllowedActions
              ? { nextAllowedActions: proposalScopeNextAllowedActions }
              : {}),
          });
        } else if (chapterReviewRequired && !chapterReviewAllowsTool(call.name)) {
          chapterReviewRejectedTools.push(call.name);
          toolResult = JSON.stringify({
            error: "章节场景链已经完成，当前阶段只允许 inspect_chapter_draft；任务清单已由运行时推进。",
            code: "CHAPTER_REVIEW_REQUIRED",
            nextAllowedActions: ["inspect_chapter_draft"],
          });
        } else if (chapterReviewRepair && !chapterReviewRepairAllowsTool(chapterReviewRepair, call.name, effectiveCall.arguments)) {
          toolResult = JSON.stringify({
            error: chapterReviewRepair.mode === "style"
              ? "终审只要求精确句式修订，禁止重写场景或重建 scene guide。"
              : "终审只允许重写 blocker 明确定位的 targetScenes。",
            code: chapterReviewRepair.mode === "style"
              ? "CHAPTER_STYLE_REPAIR_ONLY"
              : "CHAPTER_STRUCTURAL_TARGET_ONLY",
            nextAllowedActions: chapterReviewRepair.mode === "style"
              ? ["revise_chapter_draft_style"]
              : ["write_chapter_scene"],
            ...(chapterReviewRepair.mode === "structural"
              ? { targetSceneIds: chapterReviewRepair.targetSceneIds }
              : {}),
          });
        } else if (!executionToolNames.has(call.name)) {
          toolResult = JSON.stringify({ error: `工具 ${call.name} 不在当前权限模式的稳定能力集中` });
        } else if (!contractAllowsTool(task, permissionMode, call.name)) {
          toolResult = JSON.stringify({
            error: `任务契约不允许执行 ${call.name}`,
            code: "CONTRACT_MUTATION_DENIED",
            contract: { outcome: task.outcome, mutation: task.mutation },
            nextAllowedActions: ["manage_todos", "ask_user"],
          });
        } else {
          toolResult = await executeToolCached(effectiveCall, project, store, sessionId, emit, toolCallCounts, characterScope, toolContext);
        }
        // Workflow state consumes the complete result before model-facing bounding.
        const workflowControlResult = toolResult;
        agentLoop.observeTool(call.name, workflowControlResult, `tool:${sourceMessageId}:${step}:${call.id}`, deliverableId);
        executionProgress = agentLoop.executionProgress();
        // Proposal control flow must read the complete structured review before a
        // large tool result is archived/previewed; otherwise nested issues vanish.
        const proposalControlResult = PROPOSAL_SUBMISSION_TOOLS.has(call.name) ? workflowControlResult : undefined;
        toolResult = boundToolResultForModel(effectiveCall, toolResult, project, store, sessionId);
        let structuredToolResult: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(toolResult) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            structuredToolResult = parsed as Record<string, unknown>;
          }
        } catch { /* 非 JSON 工具结果仍会作为失败/不可验证观察记录。 */ }
        try {
          const parsed = JSON.parse(toolResult) as Record<string, unknown>;
          if (call.name === "save_character" || call.name === "save_simple_character" || call.name === "apply_character_changes") {
            const appliedCharacterChange = call.name !== "apply_character_changes"
              || (Array.isArray(parsed.applied) && parsed.applied.length > 0);
            if (!("error" in parsed) && appliedCharacterChange) {
              characterMutationSubmitted = true;
              characterMutationName = typeof parsed.name === "string" ? parsed.name : "";
            } else {
              characterMutationFailedThisStep = true;
              lastCharacterMutationDiagnostic = characterMutationDiagnostic(parsed);
            }
          }
          if (!("error" in parsed) && call.name === "begin_chapter_draft" && parsed.status === "started") {
            persistScenePipelineTodos(store, sessionId, "draft_started", emit);
            beginChapterSucceeded = true;
          }
          if (!("error" in parsed) && isChapterSceneWriteTool(call.name) && parsed.complete === true) {
            persistScenePipelineTodos(store, sessionId, "draft_complete", emit);
            chapterReviewRequired = true;
          }
          if (!("error" in parsed) && call.name === "revise_chapter_scene_guide" && parsed.status === "guide_revised") {
            persistScenePipelineTodos(store, sessionId, parsed.complete === true ? "draft_complete" : "draft_reopened", emit);
            chapterReviewRequired = parsed.complete === true;
          }
          if (!("error" in parsed) && isChapterSceneWriteTool(call.name)
            && (parsed.status === "written" || parsed.status === "revised")) {
            if (chapterReviewRepair?.mode === "structural") chapterReviewRepair = undefined;
            sceneWrittenFeedback = Array.isArray(parsed.styleFeedback)
              ? (parsed.styleFeedback as unknown[]).filter((item): item is string => typeof item === "string")
              : [];
          }
          if (!("error" in parsed) && call.name === "revise_chapter_draft_style"
            && parsed.status === "style_revised" && parsed.styleRecheck === "passed") {
            chapterReviewRepair = undefined;
            chapterReviewRequired = true;
          }
          if (call.name === "inspect_chapter_draft" && chapterReviewCompleted(parsed)) {
            // Every declared inspect outcome means the terminal action ran. Keep
            // its tool result in the transcript and release the inspect-only lock
            // so the Agent can submit, precisely repair, or use fallback review.
            if (isSuccessfulDocumentSubmission(call.name, parsed)) {
              documentProposalSubmitted = true;
              const proposalId = proposalIdFromToolResult(parsed);
              if (proposalId !== undefined) {
                try {
                  const proposal = store.proposal(proposalId);
                  if (proposal.sessionId === sessionId) {
                    submittedProposalRef = {
                      id: proposal.id,
                      path: proposal.path,
                      summary: proposal.summary,
                      afterContent: proposal.afterContent,
                    };
                  }
                } catch { /* proposal row may be missing in edge cases */ }
              }
            } else {
              documentProposalSubmitted = false;
            }
            chapterReviewRequired = false;
            chapterReviewRepair = chapterReviewRepairLock(parsed);
          }
        } catch { /* 非 JSON 工具结果不参与结构化里程碑推进。 */ }
        if (call.name === "inspect_chapter_draft" || call.name === "revise_chapter_draft_style" || call.name === "propose_chapter_draft") {
          // Same-step write→inspect/revise/propose: the review payload must survive,
          // so the scene-boundary reset below is skipped for this step.
          chapterReviewInStep = true;
        }
        // Only count tools that actually created a proposal / change set. Final-review
        // blocks return structured JSON without `error` but also without proposalId —
        // treating them as success used to fire false chapter boundaries (jn3 林千夏).
        if (PROPOSAL_SUBMISSION_TOOLS.has(call.name)) {
          try {
            const parsed = JSON.parse(proposalControlResult ?? toolResult) as Record<string, unknown>;
            if (isSuccessfulDocumentSubmission(call.name, parsed)) {
              const needsRhythmPolish = isExpectedRhythmPolish(parsed);
              if (needsRhythmPolish) {
                // 首轮情节场面已落提案，但不算交付完成：强制一次句式抛光。
                // This expected transition consumes no retry budget. It still owns
                // a scoped case so an interrupted run can recover the exact draft.
                const savedDraft = saveProposalRevisionDraft(
                  effectiveCall, project, store, sessionId, toolContext,
                );
                let draft: ProposalRevisionDraftRef | undefined;
                if (savedDraft && deliverableId) {
                  const retryState = proposalRetryStateAtGate(
                    proposalRevisionBeforeCall?.retryState
                    ?? createProposalRetryState({
                      runId: agentLoop.snapshot.id,
                      deliverableId,
                      ...(savedDraft.path ? { path: savedDraft.path } : {}),
                    }),
                    "rhythm",
                  );
                  const caseDraft = saveProposalRevisionCase(
                    savedDraft,
                    "rhythm",
                    retryState,
                    retryState.gateAttempts.rhythm,
                    undefined,
                    undefined,
                    proposalDocumentBaseBeforeCall,
                    store,
                    sessionId,
                    proposalRevisionBeforeCall,
                    { rhythmPolishPending: true },
                  );
                  draft = caseDraft;
                  agentLoop.setProposalRevision(
                    deliverableId,
                    caseDraft.revisionCase,
                    `proposal-revision-rhythm:${sourceMessageId}:${step}:${call.id}`,
                  );
                  syncProposalReviewRevisionContext(toolContext, caseDraft.revisionCase, store, sessionId);
                } else {
                  draft = savedDraft
                    ? { ...savedDraft, ...(proposalRevisionBeforeCall ? { revisionCase: proposalRevisionBeforeCall } : {}) }
                    : proposalDraftRefFromCase(proposalRevisionBeforeCall);
                }
                documentProposalSubmitted = false;
                pendingProposalRevisionPrompt = [
                  proposalRevisionConvergePrompt(parsed, 1),
                  proposalRevisionTargetConstraint(project, draft),
                ].filter(Boolean).join("\n");
                pendingProposalRevisionDraft = draft;
              } else {
                documentProposalSubmitted = true;
                toolContext.latestProposalDraft = undefined;
                if (proposalRevisionBeforeCall) {
                  closeProposalRevisionCase(proposalRevisionBeforeCall, store, sessionId);
                  clearProposalReviewRevisionContext(toolContext, proposalRevisionBeforeCall);
                  if (deliverableId) {
                    agentLoop.clearProposalRevision(
                      deliverableId,
                      `proposal-revision-cleared:${sourceMessageId}:${step}:${call.id}`,
                    );
                  }
                }
                const proposalId = proposalIdFromToolResult(parsed);
                proposalRetryBase = undefined;
              }
              const proposalId = proposalIdFromToolResult(parsed);
              if (proposalId !== undefined) {
                try {
                  const proposal = store.proposal(proposalId);
                  if (proposal.sessionId === sessionId) {
                    submittedProposalRef = {
                      id: proposal.id,
                      path: proposal.path,
                      summary: proposal.summary,
                      afterContent: proposal.afterContent,
                    };
                  }
                } catch { /* ignore missing proposal row */ }
              }
            } else if (!("error" in parsed) || typeof parsed.error === "string") {
              const savedDraft = saveProposalRevisionDraft(
                effectiveCall, project, store, sessionId, toolContext,
              );
              const scopePath = savedDraft?.path ?? proposalRevisionBeforeCall?.path
                ?? (typeof parsed.path === "string" ? parsed.path : undefined);
              const currentRetryState = proposalRevisionBeforeCall?.retryState
                ?? createProposalRetryState({
                  runId: agentLoop.snapshot.id,
                  ...(deliverableId ? { deliverableId } : {}),
                  ...(scopePath ? { path: scopePath } : {}),
                });
              const gate = proposalFailureGate(parsed);
              const reviewResult = parsed;
              const repairPacket = normalizeRepairPacket(reviewResult.repairPacket);
              const semanticIssues = gate === "semantic_review"
                ? proposalRevisionIssues(reviewResult, proposalRevisionBeforeCall?.unresolvedIssues)
                : undefined;
              const issueTransition = gate === "semantic_review"
                ? proposalIssueTransition(proposalRevisionBeforeCall?.unresolvedIssues ?? [], semanticIssues ?? [])
                : undefined;
              const decision = decideProposalFailure(parsed, currentRetryState, issueTransition);
              const retryStateChanged = decision.state.absoluteSubmissions !== currentRetryState.absoluteSubmissions
                || decision.state.semanticNoProgress !== currentRetryState.semanticNoProgress
                || Object.keys(decision.state.gateAttempts).some(key => {
                  const retryGate = key as ProposalRetryGate;
                  return decision.state.gateAttempts[retryGate] !== currentRetryState.gateAttempts[retryGate];
                });
              const scopedSavedDraft = savedDraft
                && proposalDraftMatchesRetryScope(savedDraft, decision.state, proposalRevisionBeforeCall)
                ? savedDraft
                : undefined;
              const shouldPersistCase = proposalFailureShouldPersistRevisionCase({
                hasScopedDraft: Boolean(scopedSavedDraft),
                action: decision.action,
                pauseReason: "reason" in decision ? decision.reason : undefined,
                retryStateChanged,
                hasPreviousCase: Boolean(proposalRevisionBeforeCall),
              });
              const decisionGate = "gate" in decision ? decision.gate : undefined;
              const caseGate = decisionGate ?? gate ?? proposalRevisionBeforeCall?.lastGate ?? "proposal";
              const caseAttempt = !decisionGate && !gate && proposalRevisionBeforeCall
                ? proposalRevisionBeforeCall.attempt
                : decision.attempt;
              const caseDraft = scopedSavedDraft && shouldPersistCase
                ? saveProposalRevisionCase(
                    scopedSavedDraft,
                    caseGate,
                    decision.state,
                    caseAttempt,
                    semanticIssues,
                    issueTransition,
                    proposalDocumentBaseBeforeCall,
                    store,
                    sessionId,
                    proposalRevisionBeforeCall,
                    { rhythmPolishPending: Boolean(
                      scopePath && toolContext.rhythmGracePaths?.has(scopePath),
                    ), semanticVerdict: gate === "semantic_review", ...(repairPacket ? { repairPacket } : {}) },
                  )
                : undefined;
              if (caseDraft?.revisionCase && deliverableId) {
                agentLoop.setProposalRevision(
                  deliverableId,
                  caseDraft.revisionCase,
                  `proposal-revision:${sourceMessageId}:${step}:${call.id}:${caseDraft.revisionCase.retryState.absoluteSubmissions}`,
                );
                syncProposalReviewRevisionContext(toolContext, caseDraft.revisionCase, store, sessionId);
              }
              const draft = proposalFailureDraft({
                action: decision.action,
                caseDraft,
                savedDraft,
                previousCase: proposalRevisionBeforeCall,
              });
              if (decision.action === "correct_call") {
                pendingProposalRevisionPrompt = proposalCallCorrectionPrompt(parsed, draft);
                pendingProposalRevisionDraft = draft;
              } else if (decision.action === "pause" && decision.reason !== "revision_exhausted") {
                waitingForUser = true;
                toolResult = JSON.stringify(proposalFailurePauseResult(parsed, decision.reason, draft));
              } else {
                if (decision.action === "pause") {
                  waitingForUser = true;
                  toolResult = JSON.stringify(proposalFailurePauseResult(parsed, decision.reason, draft, {
                    exhaustion: decision.exhaustion,
                    gate: decision.gate,
                  }));
                } else {
                  pendingProposalRevisionPrompt = [
                    proposalRevisionConvergePrompt(
                      reviewResult,
                      decision.attempt,
                      draft?.revisionCase,
                    ),
                    proposalRevisionTargetConstraint(project, draft),
                  ].filter(Boolean).join("\n");
                  pendingProposalRevisionDraft = draft;
                }
              }
            }
          } catch { /* 无效工具结果不能视为已提交。 */ }
        }
        if (call.name === "ask_user") {
          try {
            const parsed = JSON.parse(toolResult) as Record<string, unknown>;
            if (parsed.status === "waiting") waitingForUser = true;
          } catch { /* 无效工具结果不能视为等待。 */ }
        }
        if (!waitingForUser) {
          try {
            const parsed = JSON.parse(toolResult) as Record<string, unknown>;
            if (toolResultRequestsPause(parsed)) {
              waitingForUser = true;
              toolResult = JSON.stringify(genericDependencyPauseResult(call.name, parsed));
            }
          } catch { /* 非 JSON 工具结果不能触发运行时暂停。 */ }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: toolResult });
      }
      } // toolCallGroups
      if (pendingProposalRevisionPrompt && !documentProposalSubmitted && !waitingForUser) {
        // Proposal retry boundary: keep the cached preparation prefix, unload all
        // complete draft arguments and gate tool rows, then point at the newest
        // draft artifact. This is truncation, not an in-place prefix rewrite.
        if (pendingProposalRevisionDraft && proposalRetryBase !== undefined) {
          messages.length = proposalRetryBase;
        }
        messages.push({
          role: "user",
          content: proposalRevisionBoundaryPrompt(
            pendingProposalRevisionPrompt,
            pendingProposalRevisionDraft,
          ),
        });
        turnStart = messages.length;
      }
      // Persist session shelf after any reads this step so the next user turn can reload.
      persistSessionMaterialsShelf(store, sessionId, toolContext);
      let automaticReviewHandoff: string | undefined;
      if (chapterReviewRequired && toolContext.chapterSceneDraft
        && automaticChapterReviewEnabled(toolContext.characterEvolutionEnabled)
        && !documentProposalSubmitted && !waitingForUser) {
        const automaticReviewCall: ToolAccumulator = {
          id: `runtime_chapter_review_${step}_${toolContext.chapterSceneDraft.version}`,
          name: "inspect_chapter_draft",
          arguments: JSON.stringify({ summary: automaticChapterReviewSummary(toolContext.chapterSceneDraft) }),
        };
        emit({ type: "tool", name: automaticReviewCall.name });
        let automaticReviewResult = await executeToolCached(
          automaticReviewCall, project, store, sessionId, emit, toolCallCounts, characterScope, toolContext,
        );
        const automaticReviewControlResult = automaticReviewResult;
        agentLoop.observeTool(
          automaticReviewCall.name,
          automaticReviewControlResult,
          `tool:${sourceMessageId}:${step}:${automaticReviewCall.id}`,
        );
        executionProgress = agentLoop.executionProgress();
        automaticReviewResult = boundToolResultForModel(
          automaticReviewCall, automaticReviewResult, project, store, sessionId,
        );
        let parsedAutomaticReview: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(automaticReviewResult) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parsedAutomaticReview = parsed as Record<string, unknown>;
          }
        } catch { /* malformed automatic review keeps the ordinary terminal lock */ }
        if (parsedAutomaticReview && chapterReviewCompleted(parsedAutomaticReview)) {
          if (isSuccessfulDocumentSubmission("inspect_chapter_draft", parsedAutomaticReview)) {
            documentProposalSubmitted = true;
            const proposalId = proposalIdFromToolResult(parsedAutomaticReview);
            if (proposalId !== undefined) {
              try {
                const proposal = store.proposal(proposalId);
                if (proposal.sessionId === sessionId) {
                  submittedProposalRef = {
                    id: proposal.id,
                    path: proposal.path,
                    summary: proposal.summary,
                    afterContent: proposal.afterContent,
                  };
                }
              } catch { /* ignore */ }
            }
          } else {
            documentProposalSubmitted = false;
          }
          chapterReviewRequired = false;
          chapterReviewRepair = chapterReviewRepairLock(parsedAutomaticReview);
          chapterReviewInStep = true;
          if (!documentProposalSubmitted) automaticReviewHandoff = automaticReviewResult;
        }
      }
      emit({ type: "step_done", step });
      if (automaticReviewHandoff) {
        messages.length = contextBase;
        messages.push({
          role: "user",
          content: `运行时自动终审已完成。严格按结构化结果执行修复或兼容性提交，不要复述报告，也不要扩大修改范围。\n${automaticReviewHandoff}`,
        });
        turnStart = messages.length;
        ensureThinkingTranscriptCanContinue();
        continue;
      }
      if (characterMutationSubmitted && task.mutation === "character") {
        persistCompletedCharacterTaskTodos(store, sessionId, emit);
        const gaps = agentLoop.completionGaps(store.sessionTodos(sessionId));
        if (!gaps.length) {
          const answer = stripDsmlText(transcript, "").trim()
            || `${characterMutationName ? `“${characterMutationName}”` : "角色"}角色卡已保存。`;
          persistAssistantMessage(answer);
          persistRunTerminal("completed");
          emit({ type: "done", sessionId });
          return;
        }
        messages.push({ role: "user", content: completionRecoveryPrompt(gaps, executionProgress) });
      }
      if (requiresCharacterMutation && characterMutationFailedThisStep) {
        messages.push({
          role: "user",
          content: `上一次角色卡保存失败。请根据结构化错误修正参数后继续；必要时可以重新读取相关角色或项目资料。错误：${lastCharacterMutationDiagnostic}`,
        });
      }
      const newlyRepeatedFailures = [...executionProgress.failedTools]
        .filter(([name, count]) => count >= 2 && !replannedFailures.has(name))
        .map(([name]) => name);
      if (newlyRepeatedFailures.length) {
        newlyRepeatedFailures.forEach(name => replannedFailures.add(name));
        messages.push({
          role: "user",
          content: `执行路径出现重复失败（${newlyRepeatedFailures.join("、")}）。先根据结构化错误调用 manage_todos 修订剩余计划，再换用不同工具或更小范围；只有缺少不可推断的用户决策时才 ask_user。`,
        });
      }
      // §4b anchor: keep prep reads + the scene chain lock inside the cached base.
      if (beginChapterSucceeded) contextBase = messages.length;
      if (chapterReviewRequired && toolContext.chapterSceneDraft
        && !documentProposalSubmitted && !waitingForUser) {
        // Deterministic scene→review transition. Drop the final scene's full tool
        // arguments and any rejected planning-only calls, then expose one compact
        // terminal action. This also handles restored 5/5 checkpoints.
        messages.length = contextBase;
        if (chapterReviewRejectedTools.length) chapterReviewRejectedAttempts += 1;
        messages.push({
          role: "user",
          content: chapterReviewRequiredPrompt(
            toolContext.chapterSceneDraft,
            chapterReviewRejectedTools.length
              ? { rejectedTools: chapterReviewRejectedTools, attempt: chapterReviewRejectedAttempts }
              : undefined,
          ),
        });
        turnStart = messages.length;
        ensureThinkingTranscriptCanContinue();
        continue;
      }
      if (sceneWrittenFeedback && toolContext.chapterSceneDraft && !chapterReviewInStep
        && !documentProposalSubmitted && !waitingForUser) {
        // Scene-boundary context reset: drop the finished scene's full prose (the
        // model's own tool arguments) from the request. The compact handoff below
        // carries seam tail + exit states; the prefix up to contextBase still
        // cache-hits. Skipped when begin+write landed in one step (contextBase
        // then already contains this scene — nothing older to drop).
        if (!beginChapterSucceeded) {
          const beforeTokens = approximateMessageTokens(messages);
          const beforeMessageCount = messages.length;
          messages.length = contextBase;
          messages.push({
            // CACHE: user role — a mid-job system message flips DeepSeek's
            // whole-request rendering and forfeits the cached prefix (§4).
            role: "user",
            content: sceneContinuationPrompt(toolContext.chapterSceneDraft, {
              styleFeedback: sceneWrittenFeedback,
              // Unified feedback already carries the prior-chapter negative list.
              // Keep the legacy field only as a fallback for older tool results.
              stylePriorNotes: sceneWrittenFeedback.length ? undefined : toolContext.chapterStylePriorNotes,
              evidenceGroundedWriter: Boolean(toolContext.evidenceGroundedWriter),
            }),
          });
          const afterTokens = approximateMessageTokens(messages);
          try {
            const draft = toolContext.chapterSceneDraft;
            store.createContextNode({
              sessionId,
              kind: "assemble_slice",
              label: `装载 · 场次切换 · ${draft?.path ?? "scene"}`,
              sourceMessageId,
              jobId: options.jobId,
              payload: {
                step,
                layers: [
                  { id: "L0", layer: "L0", label: "保留 · 章内基础（含开场准备）", estimatedTokens: approximateMessageTokens(messages.slice(0, contextBase)) },
                  { id: "L2", layer: "L2", label: "新增 · 场次衔接", estimatedTokens: Math.max(0, afterTokens - approximateMessageTokens(messages.slice(0, contextBase))) },
                  { id: "L3", layer: "L3", label: "卸下 · 上一场过程正文", estimatedTokens: 0 },
                ],
                transition: {
                  kind: "scene_boundary",
                  atStep: step,
                  beforeTokens,
                  afterTokens,
                  beforeMessageCount,
                  afterMessageCount: messages.length,
                  path: draft?.path,
                  kept: [
                    { id: "base", label: "章内基础上下文", detail: "开场准备与初始场次指引" },
                    { id: "handoff", label: "场次衔接", detail: "上一段约 800 字尾 + 各场已写状态 + 下一场指引" },
                  ],
                  dropped: [
                    { id: "L3", label: "上一场过程正文", detail: `约 ${Math.max(0, beforeTokens - afterTokens).toLocaleString()} 的笔记、正文与重试过程` },
                  ],
                  reReadHint: "已完成场的全文保留在草稿中供终审；主对话不再挂全文，因此不会为「再看上一场」自动重注入。",
                },
                note: "场次切换",
              } as unknown as Record<string, unknown>,
            });
          } catch { /* ignore graph errors */ }
          turnStart = messages.length;
        }
        ensureThinkingTranscriptCanContinue();
        continue;
      }
      if (documentProposalSubmitted) {
        // The controller already persisted concrete proposal evidence while
        // interpreting the tool result. Everything below derives from its snapshot.
        completedDocumentDeliverables = agentLoop.completedDocumentDeliverables;
        const remainingDocumentDeliverables = agentLoop.pendingDocumentLabels();
        const hasIndependentDocumentRemaining = remainingDocumentDeliverables.length > 0;
        const advanced = persistAdvancedTodosAfterProposal(
          store,
          sessionId,
          emit,
          hasIndependentDocumentRemaining,
          remainingDocumentDeliverables,
        );
        if (hasIndependentDocumentRemaining && !waitingForUser) {
          // Per-chapter context reset: drop the finished chapter's tool transcript
          // and restart from the byte-stable initial prefix (still a cache hit), so
          // the next chapter stops paying the previous chapter's prose on every step.
          // Prefer the proposal that succeeded *this step* — store.latest can be a
          // previous chapter when the current propose failed review but was mis-counted.
          const latestProposal = submittedProposalRef
            ?? (() => {
              try {
                return store.proposals().find(item => item.sessionId === sessionId);
              } catch { return undefined; }
            })();
          const handoff = toolContext.completedChapterHandoff;
          toolContext.completedChapterHandoff = undefined;
          // Measure *before* the cut so the graph can show step N → N+1 inheritance.
          const beforeTokens = approximateMessageTokens(messages);
          const beforeMessageCount = messages.length;
          // Rebuild kept base: open-turn prefix + latest session materials shelf.
          // Drops previous chapter process and prior handoff only.
          messages.length = initialMessageCount;
          const shelfPrompt = formatJobMaterialsShelfPrompt(toolContext);
          if (shelfPrompt) messages.push({ role: "user", content: shelfPrompt });
          materialsBase = messages.length;
          persistSessionMaterialsShelf(store, sessionId, toolContext);
          const shelfEntries = [...(toolContext.materialsShelf?.values() ?? [])];
          messages.push({
            // CACHE: user role — a mid-job system message flips DeepSeek's
            // whole-request rendering and forfeits the cached prefix (§4).
            role: "user",
            content: chapterContinuationPrompt({
              todosText: formatTodosForPrompt(advanced.todos),
              remainingDeliverables: remainingDocumentDeliverables,
              ...(latestProposal
                ? { proposal: { path: latestProposal.path, summary: latestProposal.summary, afterContent: latestProposal.afterContent } }
                : {}),
              ...(handoff ? { handoff } : {}),
              ...(shelfEntries.length
                ? {
                    materialsShelf: shelfEntries.map(item => ({
                      ...(item.path ? { path: item.path } : {}),
                      ...(item.characterId != null ? { characterId: item.characterId } : {}),
                      ...(item.digest ? { digest: item.digest } : {}),
                      fullBodyServed: item.fullBodyServed,
                    })),
                  }
                : {}),
            }),
          });
          const afterTokens = approximateMessageTokens(messages);
          const afterMessageCount = messages.length;
          const shelfCount = toolContext.materialsShelf?.size ?? 0;
          try {
            const recordedHandoff = persistChapterHandoff(store, {
              sessionId,
              sourceMessageId,
              jobId: options.jobId,
              contextEpochId,
              proposal: latestProposal,
              handoff,
              index: completedDocumentDeliverables,
            });
            const keptPrefixTokens = approximateMessageTokens(messages.slice(0, materialsBase));
            const handoffTokens = Math.max(0, afterTokens - keptPrefixTokens);
            const droppedTokens = Math.max(0, beforeTokens - afterTokens + handoffTokens);
            store.createContextNode({
              sessionId,
              kind: "assemble_slice",
              label: `装载 · 章节切换 · ${latestProposal?.path ?? completedDocumentDeliverables}`,
              sourceMessageId,
              jobId: options.jobId,
              payload: {
                step,
                layers: [
                  { id: "L0", layer: "L0", label: "保留 · 规则、索引与开场任务", estimatedTokens: approximateMessageTokens(messages.slice(0, initialMessageCount)) },
                  {
                    id: "shelf",
                    layer: "L0",
                    label: shelfCount ? `保留 · 已读材料 ${shelfCount} 项` : "已读材料 · 空",
                    estimatedTokens: Math.max(0, keptPrefixTokens - approximateMessageTokens(messages.slice(0, initialMessageCount))),
                  },
                  {
                    id: "L2",
                    layer: "L2",
                    label: "新增 · 章节衔接",
                    nodeIds: [recordedHandoff.nodeId],
                    estimatedTokens: handoffTokens,
                  },
                  { id: "L3", layer: "L3", label: "卸下 · 上一章过程痕迹", estimatedTokens: 0 },
                ],
                transition: {
                  kind: "chapter_boundary",
                  atStep: step,
                  beforeTokens,
                  afterTokens,
                  beforeMessageCount,
                  afterMessageCount,
                  path: latestProposal?.path,
                  kept: [
                    { id: "L0", label: "写作规则与项目索引", detail: "跨章可复用，后续步骤可命中缓存" },
                    { id: "turn", label: "本轮开场任务", detail: "任务说明、待办与选区等开场内容" },
                    {
                      id: "shelf",
                      label: shelfCount
                        ? `已读材料 ${shelfCount} 项（本会话保留，已读路径不再灌全文）`
                        : "已读材料为空",
                      detail: "本会话已读设定摘要；文件未改则直接复用",
                    },
                    {
                      id: "L2",
                      label: "章节衔接（约 800 字章尾 + 摘要 + 已写状态）",
                      detail: latestProposal?.path
                        ? `已交付 ${latestProposal.path}`
                        : "上一章交付衔接",
                    },
                  ],
                  dropped: [
                    {
                      id: "L3",
                      label: "上一章完整过程痕迹",
                      detail: `约 ${droppedTokens.toLocaleString()}：提案正文、失败重试与中间工具结果（设定摘要已进已读材料）`,
                    },
                  ],
                  reReadHint: shelfCount
                    ? "本会话已读材料含设定/角色摘要。同一路径且文件未改会直接复用；仅未收录或文件变更时再读。"
                    : "已读材料仍空：下一章可能补读。读过后会写入本会话，后续任务可复用。",
                },
                ...(recordedHandoff.superseded
                  ? { supersededHandoffs: recordedHandoff.superseded }
                  : {}),
                ...(submittedProposalRef ? { proposalId: submittedProposalRef.id } : {}),
                materialsShelfCount: shelfCount,
                note: "章节切换",
              } as unknown as Record<string, unknown>,
            });
          } catch { /* ignore graph errors */ }
          const completedChapterPath = latestProposal?.path;
          if (requestTraceId) {
            const firstTraceStep = requestTraceSteps[0]?.step ?? step;
            const stepRange = firstTraceStep === step ? `Step ${step}` : `Step ${firstTraceStep}–${step}`;
            const chapterTraceNote = completedChapterPath
              ? `${completedChapterPath} · ${stepRange}`
              : `章节段 · ${stepRange}`;
            try {
              store.updateContextNode(sessionId, requestTraceId, {
                label: `装载 · ${chapterTraceNote}`,
                payload: {
                  ...requestTracePayload(),
                  note: chapterTraceNote,
                  ...(completedChapterPath ? { chapterPath: completedChapterPath } : {}),
                } as unknown as Record<string, unknown>,
              });
            } catch { /* graph diagnostics must not affect chapter continuation */ }
          }
          // The next provider request belongs to a new chapter segment. Its first
          // bar starts from the post-boundary baseline instead of continuing this one.
          requestTraceId = undefined;
          requestTraceSteps.length = 0;
          turnStart = messages.length;
          // Next chapter's scene resets truncate to here until its begin succeeds.
          contextBase = messages.length;
          // Keep readSnapshots + materialsShelf across chapters (same job). Clearing
          // them forced post-boundary cold re-reads of the same lore.
          // Still reset write-tool thrash counters; read cache keys are re-derived.
          toolCallCounts.clear();
          documentProposalSubmitted = false;
          submittedProposalRef = undefined;
          proposalRetryBase = undefined;
          // Each scene needs its own diegetic pack — do not reuse the previous chapter's.
          toolContext.writePackCompiled = false;
          toolContext.lastWritePack = undefined;
          toolContext.lastWritePackData = undefined;
          toolContext.writePackSceneId = undefined;
          toolContext.chapterSceneDraft = undefined;
          toolContext.activeSceneCharacterScopes = undefined;
          // Per-chapter scene-gate state.
          toolContext.sceneStyleEvidence = undefined;
          toolContext.chapterStylePriorNotes = undefined;
          // Style verdicts are per-chapter sentences; stale entries only waste lookups.
          toolContext.proseVerdictCache = undefined;
          ensureThinkingTranscriptCanContinue();
          continue;
        }
        const gaps = agentLoop.completionGaps(advanced.todos);
        if (gaps.length && !waitingForUser) {
          documentProposalSubmitted = false;
          submittedProposalRef = undefined;
          messages.push({ role: "user", content: completionRecoveryPrompt(gaps, executionProgress) });
          ensureThinkingTranscriptCanContinue();
          continue;
        }
        break;
      }
      if (waitingForUser) break;
      ensureThinkingTranscriptCanContinue();
      // Append-only: do not mutate prior tool_calls / tool bodies mid-job (preserves prefix cache).
    }
    if (waitingForUser) {
      let waitingEvent: { question: string; options?: string[] } | undefined;
      try {
        const assistantParts: string[] = [];
        for (let i = turnStart; i < messages.length; i++) {
          const msg = messages[i];
          if (msg.role === "assistant") {
            const text = messageContentText(msg.content).trim();
            if (text) assistantParts.push(text);
          }
        }
        for (let i = turnStart; i < messages.length; i++) {
          const msg = messages[i];
          if (msg.role !== "tool") continue;
          const toolBody = messageContentText(msg.content);
          if (!toolBody) continue;
          try {
            const result = JSON.parse(toolBody) as Record<string, unknown>;
            if (result.status === "waiting" && typeof result.displayMessage === "string" && result.displayMessage.trim()) {
              assistantParts.push(result.displayMessage.trim());
              if (typeof result.question === "string") {
                waitingEvent = {
                  question: result.question,
                  ...(Array.isArray(result.options) ? { options: result.options.filter((item): item is string => typeof item === "string") } : {}),
                };
              }
            }
          } catch { /* 非 ask_user 工具结果无需保存为对话。 */ }
        }
        if (assistantParts.length) persistAssistantMessage(assistantParts.join("\n\n"));
        else if (toolContext.generatedAttachments?.length) persistAssistantMessage("图片已生成，Agent 正在等待你的输入。");
      } catch { /* 消息保存失败不影响流程 */ }
      const terminalWaitingEvent = waitingEvent ?? {
        question: "Agent 已暂停并保留当前状态，可续跑继续。",
        options: ["续跑"],
      };
      persistRunTerminal("interrupted", terminalWaitingEvent.question);
      emit({ type: "waiting_for_input", sessionId, ...terminalWaitingEvent });
      // The answer arrives as the next turn — replaying this one is exactly what
      // makes「接着刚才那个问题」cheap instead of a full rebuild.
      freezeCurrentTurn();
      return;
    }
    if (documentProposalSubmitted) {
      try {
        for (let i = turnStart; i < messages.length; i++) {
          const msg = messages[i];
          if (msg.role === "assistant") {
            const text = messageContentText(msg.content).trim();
            if (text) persistAssistantMessage(text);
          }
        }
        if (toolContext.generatedAttachments?.length) persistAssistantMessage("图片已生成。");
      } catch { /* 消息保存失败不影响流程 */ }
      // Last proposal with no further writing steps: persist the same compact
      // continuity handoff as an in-job chapter boundary, then replace the raw
      // cross-job tool chain with one compact terminal block.
      let terminalHandoffPersisted = false;
      const terminalHandoff = toolContext.completedChapterHandoff;
      if (submittedProposalRef) {
        try {
          persistChapterHandoff(store, {
            sessionId,
            sourceMessageId,
            jobId: options.jobId,
            contextEpochId,
            proposal: submittedProposalRef,
            handoff: terminalHandoff,
            index: completedDocumentDeliverables,
          });
          terminalHandoffPersisted = true;
        } catch { /* keep the raw replay chain if the durable handoff failed */ }
      }
      if (terminalHandoffPersisted && submittedProposalRef) {
        messages.length = initialMessageCount;
        messages.push({
          role: "user",
          content: completedJobHandoffPrompt(submittedProposalRef, terminalHandoff),
        });
        messages.push({
          role: "assistant",
          content: `已交付 ${submittedProposalRef.path}。`,
        });
        store.clearAgentTurnBlocks(sessionId);
      }
      freezeCurrentTurn();
      persistRunTerminal("completed");
      emit({ type: "done", sessionId });
      return;
    }
    // Tools finished with a satisfied contract but no pure-text final step.
    const endTodos = store.sessionTodos(sessionId);
    const endGaps = agentLoop.completionGaps(endTodos);
    if (!pauseForUserResume && !endGaps.length) {
      const answer = stripDsmlText(transcript, "").trim() || "任务已处理。";
      persistAssistantMessage(answer);
      messages.push({ role: "assistant", content: answer });
      freezeCurrentTurn();
      persistRunTerminal("completed");
      emit({ type: "done", sessionId });
      return;
    }
    // Soft/stall/hard budget (or incomplete fallthrough): never throw — leave 续跑.
    const pause = pauseForUserResume ?? {
      reason: "hard_cap" as const,
      softBudget: options.maxTurns ?? hardCap,
      hardCap,
      usedSteps: Math.max(0, (currentUsageStep ?? 1) - 1),
    };
    const openTodoLines = endTodos
      .filter(todo => todo.status === "pending" || todo.status === "in_progress")
      .map(todo => `- [${todo.status}] ${todo.content}`)
      .slice(0, 8);
    const reasonLabel = pause.reason === "stall"
      ? "进度停滞（连续多步任务清单/交付状态未变化）"
      : pause.reason === "soft_budget"
        ? "本轮 soft 步数预算已用尽"
        : "已达安全步数上限";
    const pauseBody = [
      stripDsmlText(transcript, "").trim(),
      `已暂停：${reasonLabel}。`,
      `已执行 ${pause.usedSteps} 步（soft ${pause.softBudget} / 安全上限 ${pause.hardCap}）。`,
      openTodoLines.length ? `未完成清单：\n${openTodoLines.join("\n")}` : "当前无未完成清单项。",
      endGaps.length ? `仍缺：${endGaps.join("；")}。` : "",
      "中途上下文、任务清单与工作记忆已保留。请点击本条或上一条用户指令上的「续跑」继续，也可发送新指令。",
      "[生成已中断]",
    ].filter(Boolean).join("\n\n");
    try {
      persistAssistantMessage(pauseBody);
      store.addSystemMessage(sessionId, runtimeDebugContext(messages, {
        task: task.label,
        model: executionModel.model,
        turns: pause.usedSteps,
        transcript,
        pauseReason: pause.reason,
      }));
    } catch { /* 持久化失败不阻断可续跑结束 */ }
    freezeCurrentTurn();
    persistRunTerminal("interrupted", reasonLabel);
    emit({
      type: "waiting_for_input",
      sessionId,
      question: `${reasonLabel}（${pause.usedSteps} 步）。可点击「续跑」从中断处继续。`,
      options: ["续跑"],
    });
    return;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      if (transcript.trim() || toolContext.generatedAttachments?.length) {
        persistAssistantMessage(`${stripDsmlText(transcript, "").trim() || "图片已生成。"}\n\n[生成已中断]`);
      }
      // Resuming after a cancel should not re-pay the work already done; freezeTurnBlock
      // drops the dangling tool_calls the abort left behind.
      freezeCurrentTurn();
      persistRunTerminal("cancelled", "用户取消或请求中止");
      emit({ type: "cancelled", sessionId });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (toolContext.generatedAttachments?.length) {
      try { persistAssistantMessage("图片已生成，但后续任务异常中断。"); } catch { /* retain original error */ }
    }
    try {
      store.addSystemMessage(sessionId, "Agent 任务异常结束：" + message);
    } catch { /* 错误持久化失败不遮蔽原始错误。 */ }
    persistRunTerminal("failed", message);
    emit({ type: "error", message });
    throw error;
  }
}

/**
 * Audit-only policy (injected into dynamic task block — not stable slot 5).
 * CACHE: Keeping this out of the stable prefix lets write↔audit turns share slots 0–5.
 */
const REVIEW_PROMPT = `终审专则：降低机器生成感，不是换成另一种统一腔调。
先 audit_prose_style；使用 diagnosis.actionableIssues，优先 verdict=block，并检查 aiTells.issues；warn 仅明显模板化时改；allow 与未列出目标文件保留。资料文档只采用资料画像的通用表达信号，不套用人物声线或叙事收尾标准。
保留：对白拖音/中断/迟疑、对话纠正、停顿—揭示、短同位。见破折号就删是错。
查：模板转折、动作后解释回声、说明性破折号与抽象「不是…而是」、标签化人物、空泛排比、过匀句段、段尾升华、全员书面语。
改法：动作有结果；细节供判断；因果拆句；笼统判断落到可见动作/感官；勿堆修辞伪装生动；勿新增事实。
无问题句保持原样。只审阅→有证据结论不提案；要求修复→最小 patch。`;

/**
 * Absolute safety rail for experimental step budget (soft + stall).
 * Daily hard mode uses agent.json `maxAgentSteps` instead.
 */
export const AGENT_HARD_TURN_CAP = 100;
/** Consecutive steps with an unchanged progress fingerprint before stall converge. */
export const AGENT_STALL_WINDOW = 4;
/** Extra steps after soft/stall to force a minimal deliverable or ask_user. */
export const AGENT_CONVERGE_TURNS = 2;
/** Extra turns beyond the run hard cap reserved for a scoped final-review repair. */
export const AGENT_REVIEW_RESERVE_TURNS_PER_DELIVERABLE = 2;

export type AgentBudgetPauseReason = "soft_budget" | "stall" | "hard_cap";

export function computeAgentHardTurnBudget(input: {
  baseHardCap: number;
  documentDeliverables: number;
  documentProposalRequired: boolean;
  maxTurnsOverride: boolean;
}): number {
  if (input.maxTurnsOverride) return input.baseHardCap;
  const deliverableSlots = Math.max(
    1,
    input.documentDeliverables,
    input.documentProposalRequired ? 1 : 0,
  );
  return input.baseHardCap * deliverableSlots;
}

/**
 * Dynamic soft step budget from remaining work (todos, deliverables, scene chain).
 * Not a hard wall: exhaustion enters a short converge window, then soft-pauses for 续跑.
 */
export function computeSoftTurnBudget(input: {
  todos: AgentTodoItem[];
  todoPlanLength: number;
  documentDeliverables: number;
  completedDocumentDeliverables: number;
  documentProposalRequired: boolean;
  mutation: AgentMutationRequirement;
  scenePipelineEnabled: boolean;
  chapterSceneDraft?: { scenes: readonly unknown[]; completed: readonly unknown[] } | null;
}): number {
  const openTodos = input.todos.filter(
    todo => todo.status === "pending" || todo.status === "in_progress",
  ).length;
  const totalTodos = Math.max(input.todos.length, input.todoPlanLength, openTodos, 1);
  const deliverableSlots = Math.max(
    input.documentDeliverables,
    input.documentProposalRequired ? 1 : 0,
  );
  const pendingDeliverables = Math.max(0, deliverableSlots - input.completedDocumentDeliverables);
  let budget = 12;
  budget += Math.max(openTodos, 1) * 6;
  budget += Math.max(0, totalTodos - openTodos) * 2;
  budget += pendingDeliverables * 8;
  if (input.mutation === "document" || input.mutation === "mixed") budget += 10;
  if (input.mutation === "character" || input.mutation === "mixed") budget += 4;
  if (input.scenePipelineEnabled) budget += 12;
  if (input.chapterSceneDraft) {
    const remainingScenes = Math.max(
      0,
      input.chapterSceneDraft.scenes.length - input.chapterSceneDraft.completed.length,
    );
    budget += 6 + remainingScenes * 4;
  }
  return Math.min(80, Math.max(16, budget));
}

/** Structural progress only — not tool-name thrash or free-text heuristics. */
export function agentStepProgressFingerprint(
  todos: AgentTodoItem[],
  progress: ReturnType<typeof createAgentExecutionProgress>,
  flags: {
    documentProposalSubmitted: boolean;
    characterMutationSubmitted: boolean;
    chapterReviewRequired: boolean;
    chapterSceneVersion?: number;
    chapterScenesCompleted?: number;
    completedDocumentDeliverables: number;
  },
): string {
  const todoSig = todos.map(todo => `${todo.id}:${todo.status}`).join(",");
  const stages = [...progress.workflowStages].sort().join("|");
  return [
    todoSig,
    progress.documentArtifactProduced ? "d1" : "d0",
    progress.characterArtifactProduced ? "c1" : "c0",
    progress.proseGateRuleSaved ? "g1" : "g0",
    stages,
    flags.documentProposalSubmitted ? "p1" : "p0",
    flags.characterMutationSubmitted ? "m1" : "m0",
    flags.chapterReviewRequired ? "r1" : "r0",
    `sv${flags.chapterSceneVersion ?? 0}`,
    `sc${flags.chapterScenesCompleted ?? 0}`,
    `dd${flags.completedDocumentDeliverables}`,
  ].join(";");
}

function agentBudgetConvergePrompt(
  reason: Exclude<AgentBudgetPauseReason, "hard_cap">,
  meta: { step: number; softBudget: number; hardCap: number; openTodos: number },
): string {
  const head = reason === "stall"
    ? `运行时检测到进度停滞（连续 ${AGENT_STALL_WINDOW} 步任务清单/交付状态未变化，当前第 ${meta.step} 步）。`
    : `本任务 soft 步数预算将尽（第 ${meta.step} 步，soft ${meta.softBudget} / 安全上限 ${meta.hardCap}）。`;
  return [
    head,
    `请在 ${AGENT_CONVERGE_TURNS} 步内收敛：完成当前可验证交付、提交提案、或 ask_user 澄清不可推断的决策；不要扩大范围或重复无效读取。`,
    meta.openTodos > 0 ? `仍有 ${meta.openTodos} 项未完成清单。` : "无未完成清单项时请直接给出可交付结果。",
    "若本窗口内仍无法完成，运行时会暂停并保留上下文，作者可点「续跑」继续。",
  ].join("");
}

function runtimeDebugContext(
  messages: ApiMessage[],
  metadata: {
    task: string;
    model: string;
    turns: number;
    transcript: string;
    pauseReason?: AgentBudgetPauseReason;
  },
): string {
  const entries = messages.map((message, index) => {
    const content = message.content ?? "";
    const toolCalls = message.tool_calls?.map(call => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    }));
    return { index: index + 1, role: message.role, toolCallId: message.tool_call_id, content, toolCalls };
  });
  const payload = JSON.stringify({
    capturedAt: new Date().toISOString(),
    task: metadata.task,
    model: metadata.model,
    turns: metadata.turns,
    pauseReason: metadata.pauseReason ?? "hard_cap",
    partialOutput: metadata.transcript,
    messages: entries,
  }, null, 2);
  return `[Agent 调试上下文：步数预算暂停，可续跑]\n${payload}`;
}

function selectedBlocksContext(project: WriterProject, references?: Array<{ path: string; text?: string }>): string {
  if (!references?.length) return "";
  const unique = references.filter((reference, index, all) =>
    typeof reference.path === "string"
    && typeof reference.text === "string"
    && reference.text.trim().length > 0
    && all.findIndex(item => item.path === reference.path && item.text === reference.text) === index,
  ).slice(0, 3);
  const sections = unique.map(reference => {
    const content = project.read(reference.path);
    const text = reference.text!.trim();
    const start = content.indexOf(text);
    if (start < 0) throw new Error(`${reference.path} 中的选区已失效，请重新选择`);
    const sourceHash = project.hash(content);
    const spans = documentSpans(content, sourceHash).filter(span => span.endOffset > start && span.startOffset < start + text.length);
    const preview = text.length <= 800 ? text : `${text.slice(0, 360)}\n…[选区正文按锚点读取]…\n${text.slice(-360)}`;
    return JSON.stringify({
      path: reference.path,
      sourceHash,
      selectionCharacters: text.length,
      startAnchorId: spans[0]?.anchorId,
      endAnchorId: spans.at(-1)?.anchorId,
      anchors: spans.slice(0, 12).map(span => ({ anchorId: span.anchorId, spanHash: span.spanHash, startLine: span.startLine, endLine: span.endLine })),
      preview,
      message: text.length <= 800
        ? "选区已完整提供；直接用锚点 patch，禁止通读文档。"
        : "选区较长；使用 read_file 的行范围读取选区及必要接缝，禁止按块通读无关内容。",
    });
  });
  return sections.length ? `用户从网页浏览器明确加入了以下文本选区锚点。只处理这些范围，不要扩展为整篇文档：\n${sections.join("\n")}` : "";
}

function selectedBlockEditLock(
  project: WriterProject,
  references?: Array<{ path: string; text?: string }>,
): { path: string; sourceHash: string; anchorIds: string[] } | undefined {
  const reference = references?.find(item => typeof item.path === "string" && typeof item.text === "string" && item.text.trim());
  if (!reference?.text) return undefined;
  const content = project.read(reference.path);
  const text = reference.text.trim();
  const start = content.indexOf(text);
  if (start < 0) return undefined;
  const sourceHash = project.hash(content);
  const anchorIds = documentSpans(content, sourceHash)
    .filter(span => span.endOffset > start && span.startOffset < start + text.length)
    .map(span => span.anchorId);
  return anchorIds.length ? { path: reference.path, sourceHash, anchorIds } : undefined;
}

/**
 * Dynamic-tail work memory. CACHE: miss-priced — default to catalog + digests;
 * restore at most one body on continuation. Do not re-inject multi-chapter prose here.
 */
function recentArtifactsContext(
  store: WriterStore,
  sessionId: string,
  project: WriterProject,
  task: WritingTask,
  activeRevisionCases: readonly ProposalRevisionCase[] = [],
): string {
  const state = store.sessionContext(sessionId);
  const restorableDraft = task.continuation
    ? restoreChapterDraftCheckpoint(store, sessionId, project, task.targetPath ?? state.activeDocument)
    : undefined;
  const savedCheckpoint = restorableDraft ? store.agentCheckpoint(sessionId) : undefined;
  const checkpoint = savedCheckpoint && savedCheckpoint.stage !== "proposal_submitted"
    ? {
        version: savedCheckpoint.version,
        stage: savedCheckpoint.stage,
        path: savedCheckpoint.path,
        sourceHash: savedCheckpoint.sourceHash,
        draftVersion: savedCheckpoint.draftVersion,
        completedScenes: savedCheckpoint.completedScenes,
        totalScenes: savedCheckpoint.totalScenes,
        unresolved: savedCheckpoint.unresolved?.slice(0, 12),
        reviewRepair: savedCheckpoint.reviewRepair,
        artifactIds: savedCheckpoint.artifactIds?.slice(0, 8),
      }
    : undefined;
  const writingMemory = store.writingMemoryPacket(sessionId, {
    targetPath: task.targetPath ?? state.activeDocument,
    characterIds: task.characterIds,
    limit: 20,
  }).map(entry => ({
    id: entry.id,
    kind: entry.kind,
    content: entry.content,
    ...(entry.characterIds.length ? { characterIds: entry.characterIds } : {}),
    source: entry.sourcePath,
    evidence: entry.sourceEvidence.slice(0, 240),
  }));
  const activeRevisionArtifactIds = new Set(activeRevisionCases.flatMap(item => [
    item.draftArtifactId,
    item.reviewArtifactId,
    ...(item.semanticDraftArtifactId ? [item.semanticDraftArtifactId] : []),
  ]));
  const recentArtifacts = store.recentContextArtifacts(sessionId, 12);
  const referencedArtifacts = [...activeRevisionArtifactIds].flatMap(id => {
    if (recentArtifacts.some(item => item.id === id)) return [];
    const artifact = store.contextArtifactById(sessionId, id);
    return artifact ? [{
      id: artifact.id,
      kind: artifact.kind,
      path: artifact.path,
      sourceHash: artifact.sourceHash,
      digest: artifact.digest,
    }] : [];
  });
  let artifacts = [...recentArtifacts, ...referencedArtifacts]
    .filter((artifact) => {
      // Generated work-memory artifacts own their content hash and need not have
      // an on-disk document yet. Source-backed reads still validate against disk.
      if (artifact.kind === "proposal_revision_draft" || artifact.kind === "proposal_revision_case") {
        return activeRevisionArtifactIds.has(artifact.id);
      }
      if (!artifact.path) return true;
      if (project.isDocumentHidden(artifact.path)) return false;
      if (!project.textFileExists(artifact.path)) return false;
      return project.hash(project.readTextFile(artifact.path)) === artifact.sourceHash;
    });
  // A fresh task may reuse verified read digests from the same session. Keep a
  // declared target focused; targetless tasks (for example character synthesis)
  // receive the small validated catalog so they do not blindly reread all lore.
  if (!task.continuation) {
    const focusPath = task.targetPath ?? state.activeDocument;
    if (focusPath) artifacts = artifacts.filter(item => item.path === focusPath);
    if (!artifacts.length && !checkpoint && !writingMemory.length) return "";
  }
  if (!artifacts.length && !state.activeDocument && !state.currentIntent && !checkpoint && !writingMemory.length) return "";
  const activePath = task.continuation ? state.activeDocument : (task.targetPath ?? state.activeDocument);
  const activeHash = activePath && project.textFileExists(activePath)
    ? project.hash(project.readTextFile(activePath))
    : undefined;
  // Prefer catalog + digests in the miss-priced dynamic tail. Only restore one body on
  // continuation (tail of the active doc) so the model can keep writing without a re-read.
  const restored: Array<Record<string, unknown>> = [];
  if (task.continuation) {
    for (const artifact of artifacts) {
      if (artifact.kind !== "read_document" && artifact.kind !== "read_document_span" && artifact.kind !== "inspect_document"
        && artifact.kind !== "read_file" && artifact.kind !== "inspect_file") continue;
      if (artifact.path && activePath && artifact.path !== activePath) continue;
      if (activeHash && artifact.sourceHash !== activeHash) continue;
      const full = store.contextArtifactById(sessionId, artifact.id);
      if (!full) continue;
      try {
        const parsed = JSON.parse(full.content) as Record<string, unknown>;
        if (typeof parsed.error === "string") continue;
        const content = typeof parsed.content === "string" ? parsed.content
          : typeof parsed.markdown === "string" ? parsed.markdown : undefined;
        const bodyLimit = 2_000;
        restored.push({
          artifactId: artifact.id,
          kind: artifact.kind,
          path: artifact.path,
          sourceHash: artifact.sourceHash,
          section: parsed.section,
          heading: parsed.heading,
          block: parsed.block,
          startLine: parsed.startLine,
          endLine: parsed.endLine,
          ...(content
            ? { content: content.length > bodyLimit ? `${content.slice(-bodyLimit)}\n…[末尾截取，全文在 artifact#${artifact.id}]` : content }
            : {
              opening: typeof parsed.opening === "string" ? String(parsed.opening).slice(0, 400) : parsed.opening,
              ending: typeof parsed.ending === "string" ? String(parsed.ending).slice(0, 800) : parsed.ending,
              headings: Array.isArray(parsed.headings) ? (parsed.headings as unknown[]).slice(0, 20) : parsed.headings,
              lineCount: parsed.lineCount,
              blockCount: parsed.blockCount,
            }),
        });
        break;
      } catch { /* 非 JSON 工作记忆条目跳过 */ }
    }
  }
  const catalog = artifacts
    .filter(item => item.kind === "read_document" || item.kind === "read_document_span" || item.kind === "locate_document_span" || item.kind === "inspect_document"
      || item.kind === "read_file" || item.kind === "inspect_file"
      || item.kind === "get_outline_node" || item.kind === "list_outline_nodes"
      || item.kind === "proposal_revision_draft" || item.kind === "proposal_revision_case")
    .map(({ id, kind, path, sourceHash, digest }) => ({
      id, kind, path, sourceHash,
      digest: digest.replace(/\s+/g, " ").slice(0, 240),
    }));
  const revisionCases = activeRevisionCases
    .filter(item => item.status === "blocked")
    .slice(0, 2)
    .map(item => ({ artifactId: item.reviewArtifactId, ...item }));
  if (!catalog.length && !restored.length && !checkpoint && !writingMemory.length && !revisionCases.length) return "";
  const scopeNote = task.continuation
    ? "承接上一轮：catalog 列出已读资料（文档未变时禁止重复 inspect/read/list_outline_nodes）；restoredReads 至多含一段末尾正文可直接续写"
    : "同会话已验证且未变化的读取索引；有目标路径时仅列目标。先按 digest 判断是否足够，正文不足再按需读取；相同 path+参数+sourceHash 会直接复用已有工具结果";
  return `本轮任务工作记忆（${scopeNote}）。writingMemory 仅是当前会话从已接受正文提取的近期辅助状态，不是项目事实或角色卡；与正文、角色卡、大纲冲突时立即忽略，措辞或事实不确定时回读原文：\n${JSON.stringify({
    state: { activeDocument: state.activeDocument, currentIntent: state.currentIntent.slice(0, 160) },
    ...(checkpoint ? { checkpoint } : {}),
    writingMemory,
    revisionCases,
    artifacts: catalog,
    restoredReads: restored,
  })}`;
}

/** Restore only a validated, unfinished write-scene checkpoint. */
function validRestoredReviewCycle(
  value: unknown,
  draft: Partial<ChapterSceneDraft>,
  project: WriterProject,
): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cycle = value as Partial<ChapterSceneReviewCycle>;
  if (cycle.schemaVersion !== 1
    || (cycle.status !== "blocked" && cycle.status !== "repairing" && cycle.status !== "resolved")
    || typeof cycle.baselineVersion !== "number" || cycle.baselineVersion > (draft.version ?? -1)
    || typeof cycle.baselineContent !== "string" || cycle.baselineContent.length > 200_000
    || typeof cycle.baselineSourceHash !== "string"
    || project.hash(cycle.baselineContent) !== cycle.baselineSourceHash
    || !Array.isArray(cycle.unresolvedIssues) || cycle.unresolvedIssues.length > 8
    || !Array.isArray(cycle.targetSceneIds) || !Array.isArray(cycle.resolvedIssueIds)
    || !Array.isArray(cycle.stillPresentIssueIds) || !Array.isArray(cycle.newlyIntroducedIssueIds)
    || typeof cycle.repairAttempts !== "number" || cycle.repairAttempts < 0) return false;
  const sceneIds = new Set((draft.scenes ?? []).flatMap(scene =>
    scene && typeof scene === "object" && "id" in scene && typeof scene.id === "string" ? [scene.id] : [],
  ));
  if (cycle.targetSceneIds.some(id => typeof id !== "string" || !sceneIds.has(id))) return false;
  return cycle.unresolvedIssues.every(issue =>
    Boolean(issue) && typeof issue === "object"
    && typeof issue.id === "string" && typeof issue.kind === "string"
    && typeof issue.sceneId === "string" && sceneIds.has(issue.sceneId)
    && Array.isArray(issue.evidence) && issue.evidence.length <= 3
    && issue.evidence.every(item => typeof item === "string")
    && typeof issue.problem === "string" && typeof issue.action === "string",
  );
}

export function restoreChapterDraftCheckpoint(
  store: WriterStore,
  sessionId: string,
  project: WriterProject,
  targetPath?: string,
): ChapterSceneDraft | undefined {
  const checkpoint = store.agentCheckpoint(sessionId);
  if (!checkpoint || checkpoint.stage === "proposal_submitted" || !checkpoint.draft
    || typeof checkpoint.draft !== "object" || Array.isArray(checkpoint.draft)) return undefined;
  const draft = checkpoint.draft as Partial<ChapterSceneDraft>;
  if (typeof draft.path !== "string" || (targetPath && draft.path !== targetPath)
    || typeof draft.baseHash !== "string" || checkpoint.sourceHash !== draft.baseHash
    || !Array.isArray(draft.scenes) || !Array.isArray(draft.completed)
    || typeof draft.version !== "number" || typeof draft.chapterGoal !== "string"
    || typeof draft.baseContent !== "string" || typeof draft.heading !== "string"
    || !validRestoredReviewCycle(draft.reviewCycle, draft, project)
    || (draft.mode !== "create" && draft.mode !== "replace" && draft.mode !== "append")) return undefined;
  const exists = project.documentExists(draft.path);
  if ((draft.mode === "create" && exists) || (draft.mode !== "create" && !exists)) return undefined;
  const current = exists ? project.read(draft.path) : "";
  if (project.hash(current) !== draft.baseHash) return undefined;
  return draft as ChapterSceneDraft;
}

/**
 * Dynamic-tail write index only (ids/paths/short summaries).
 * CACHE: miss-priced — never dump full outline prose or character cards here;
 * Step 1 tool reads remain the source of truth for actual content.
 */
function writingBootstrapContext(
  project: WriterProject,
  store: WriterStore,
  prompt: string,
  task: WritingTask,
  scenePipeline: ScenePipelineSettings,
): string {
  if (task.mode !== "write_scene" && task.mode !== "rewrite" && !task.continuation) return "";
  const chapterNum = parseChapterNumber(prompt) ?? parseChapterNumber(task.targetPath ?? "");

  let outlineSource: string | undefined;
  let outlineNodes: Array<Record<string, unknown>> | undefined;
  let outlineCharacterIds: number[] = [];
  let outlineDocPaths: string[] = [];
  try {
    const outline = new OutlineStore(project).sync();
    outlineSource = outline.sourcePath;
    const nodes = outline.nodes;
    // Only inject when chapter number matches; never dump the whole outline as "already read".
    if (chapterNum !== undefined) {
      const matched = nodes.filter(node => chapterTitleMatches(node.title, chapterNum));
      if (matched.length > 0 && matched.length <= 12) {
        const selected = expandOutlineFamily(nodes, matched).slice(0, 16);
        outlineCharacterIds = [...new Set(selected.flatMap(node => node.characterIds))];
        outlineDocPaths = [...new Set(selected.map(node => node.documentPath).filter((path): path is string => Boolean(path)))];
        outlineNodes = selected.map(node => ({
          id: node.id,
          type: node.type,
          title: node.title,
          summary: node.summary.slice(0, 120),
          status: node.status,
          documentPath: node.documentPath,
          characterIds: node.characterIds,
        }));
      }
    }
  } catch {
    outlineNodes = undefined;
  }

  const chapterDocs = project.listDocuments()
    .filter(path => !project.isDocumentHidden(path) && documentKind(path) === "chapter")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  // Only paths that actually exist — never invent chapters/第N章.md.
  const targetCandidates = [
    ...(task.targetPath && project.documentExists(task.targetPath) ? [task.targetPath] : []),
    ...(chapterNum !== undefined
      ? chapterDocs.filter(path =>
        chapterTitleMatches(path, chapterNum) || chapterTitleMatches(safeReadHeading(project, path), chapterNum))
      : []),
    ...outlineDocPaths.filter(path => project.documentExists(path) && !project.isDocumentHidden(path)),
  ].filter((path, index, all) => all.indexOf(path) === index).slice(0, 3);

  const prevCandidates = chapterNum !== undefined && chapterNum > 1
    ? chapterDocs.filter(path =>
      chapterTitleMatches(path, chapterNum - 1) || chapterTitleMatches(safeReadHeading(project, path), chapterNum - 1)).slice(0, 2)
    : targetCandidates[0]
      ? [previousPath(chapterDocs, targetCandidates[0])].filter((path): path is string => Boolean(path))
      : [];

  const targetIndex = targetCandidates[0] ? chapterDocs.indexOf(targetCandidates[0]) : -1;
  const nextCandidates = chapterNum !== undefined
    ? chapterDocs.filter(path =>
      chapterTitleMatches(path, chapterNum + 1) || chapterTitleMatches(safeReadHeading(project, path), chapterNum + 1)).slice(0, 2)
    : targetIndex >= 0 && targetIndex + 1 < chapterDocs.length
      ? [chapterDocs[targetIndex + 1]]
      : [];

  const characterIndex = store.characters()
    .filter(item => task.characterIds.includes(item.id) || outlineCharacterIds.includes(item.id))
    .slice(0, 8)
    .map(item => ({ id: item.id, name: item.identity.name, narrativeRole: item.identity.narrativeRole }));

  if (!outlineNodes?.length && !targetCandidates.length && !prevCandidates.length && !nextCandidates.length && !characterIndex.length) {
    return "";
  }

  return `写作线索（系统启发式索引，未经验证，不是已读正文）：
- outlineNodes 有与本章精确匹配项时，才可用其 id 调用 get_outline_node 一次（id 为 UUID，不是章号）；为空时直接写作，禁止为了写正文创建大纲。
- 需要衔接：对 previousChapterCandidates 中的路径用 read_file 读取末尾必要范围一次。
- 目标之后已有成稿时：对 nextChapterCandidates 中的路径 read_file(startLine=1,endLine=40) 一次，只把其开场事实当作本章离场边界，不把后章事件提前写入本章。
- 需要人设：先对 characterIndex 中的 id 调用 get_character 获取必要字段摘要；摘要不足时再带 sections 选读，场景状态需传 outlineNodeId。
- 目标文档：对 targetDocumentCandidates 中的路径 inspect 或按需读取；路径不存在时按项目惯例新建，勿盲目使用未列出的路径。
- 交付路径由 Agent 根据作品需要决定：完整成稿用 write_file、局部修改用 edit_file、约束复杂时可先 compile_write_pack，${scenePipeline.enabled ? "或在长篇连续状态确有收益时使用场景草稿链" : "场景链当前关闭"}。
- 禁止：重复 list_outline_nodes、通读整本大纲、对同一路径反复 read。
- outline、write pack 与 scene guide 都只是可选工作材料；实际正文和人物选择优先，不得扩展成其他章节任务。
${JSON.stringify({
    requestedChapter: chapterNum,
    confidence: outlineNodes?.length || targetCandidates.length ? "matched" : "low",
    outlineSource,
    outlineNodes,
    targetDocumentCandidates: targetCandidates,
    previousChapterCandidates: prevCandidates,
    nextChapterCandidates: nextCandidates,
    characterIndex,
  })}`;
}

const CACHEABLE_TOOLS = new Set(["list_documents", "inspect_document", "locate_document_span", "read_document", "read_document_span", "search_project", "list_files", "inspect_file", "read_file", "search_files", "audit_prose_style", "list_outline_nodes", "get_outline_node", "validate_outline", "compare_outline_with_draft", "get_character", "list_characters"]);
const DOCUMENT_READ_TOOLS = new Set(["inspect_document", "locate_document_span", "read_document", "read_document_span", "inspect_file", "read_file"]);
const DOCUMENT_BODY_READ_TOOLS = new Set(["read_document", "read_document_span", "read_file"]);
const READ_ATOM_CACHE_VERSION = "v2";
/** Structural / catalog tools must stay intact so the model does not re-list after compaction. */
const NEVER_COMPACT_KEYS = new Set(["nodes", "matches", "issues"]);
/** Max digest chars for short / character cards. */
const MATERIALS_SHELF_DIGEST_CHARS = 360;
/** Longer lore/outline digests keep section headings so later chapters need fewer re-searches. */
const MATERIALS_SHELF_DIGEST_CHARS_SETTING = 1_200;
/** Cap shelf entries so the cross-chapter kept block stays cheap. */
const MATERIALS_SHELF_MAX_ENTRIES = 24;
const MATERIALS_SHELF_PROMPT_PREFIX = "【会话材料架 · 跨任务保留】";

function stripFrozenMaterialsShelfMessages(messages: ApiMessage[]): ApiMessage[] {
  return messages.filter(message =>
    message.role !== "user"
    || !messageContentText(message.content).startsWith(MATERIALS_SHELF_PROMPT_PREFIX));
}

function materialsShelfKeyForPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function materialsShelfKeyForCharacter(id: number): string {
  return `character:${id}`;
}

/** Prefer lore/outline/character materials for the cross-chapter shelf; skip delivered chapter drafts. */
function shouldShelfPath(path: string): boolean {
  const kind = documentKind(path);
  return kind === "lore" || kind === "outline" || kind === "other";
}

/** Core setting paths that must be fully served before search thrashing is blocked. */
function isCoreSettingPath(path: string): boolean {
  const kind = documentKind(path);
  return kind === "lore" || kind === "outline";
}

/**
 * Build a materials-shelf digest. Long lore/outline docs use heading + first-line samples
 * so Phase / section facts remain findable without re-search thrashing.
 */
export function buildMaterialsShelfDigest(path: string | undefined, body: string, toolName = "read"): string {
  if (!body.trim()) return `${toolName}${path ? ` ${path}` : ""}`.trim();
  const kind = path ? documentKind(path) : "other";
  const max = kind === "lore" || kind === "outline"
    ? MATERIALS_SHELF_DIGEST_CHARS_SETTING
    : MATERIALS_SHELF_DIGEST_CHARS;
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  if (kind !== "lore" && kind !== "outline") return `${flat.slice(0, max - 1)}…`;

  const lines = body.split(/\r?\n/);
  const parts: string[] = [flat.slice(0, 200)];
  for (let i = 0; i < lines.length; i += 1) {
    const heading = lines[i].trim();
    if (!/^#{1,4}\s+\S/.test(heading)) continue;
    let next = "";
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith("#")) continue;
      next = candidate.replace(/\s+/g, " ").slice(0, 96);
      break;
    }
    parts.push(next ? `${heading}｜${next}` : heading);
  }
  const joined = parts.join(" ¶ ");
  return joined.length <= max ? joined : `${joined.slice(0, max - 1)}…`;
}

/**
 * After fullBodyServed, only block aimless whole-doc re-reads.
 * Targeted block / line / quote / span / inspect remain allowed to fill digest gaps.
 */
export function isTargetedDocumentSupplement(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (toolName === "inspect_document" || toolName === "inspect_file") return true;
  if (toolName === "locate_document_span" || toolName === "read_document_span") return true;
  if (toolName === "read_document" || toolName === "read_file") {
    if (typeof input.quote === "string" && input.quote.trim()) return true;
    if (optionalPositiveIntegerLike(input.block) !== undefined) return true;
    const start = optionalPositiveIntegerLike(input.startLine);
    const end = optionalPositiveIntegerLike(input.endLine);
    if (start !== undefined && end !== undefined) return true;
  }
  return false;
}

function optionalPositiveIntegerLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n > 0 ? n : undefined;
  }
  return undefined;
}

export function registerMaterialsShelfEntry(
  context: ToolExecutionContext,
  entry: Omit<MaterialsShelfEntry, "key"> & { key?: string },
): MaterialsShelfEntry {
  context.materialsShelf ??= new Map();
  const key = entry.key
    ?? (entry.characterId != null
      ? materialsShelfKeyForCharacter(entry.characterId)
      : materialsShelfKeyForPath(entry.path ?? entry.kind));
  const prev = context.materialsShelf.get(key);
  const digestCap = entry.path && isCoreSettingPath(entry.path)
    ? MATERIALS_SHELF_DIGEST_CHARS_SETTING
    : MATERIALS_SHELF_DIGEST_CHARS;
  // Prefer the longer digest when re-registering the same path (e.g. first open was short,
  // later block-read produced a heading map).
  const incomingDigest = entry.digest.replace(/\s+/g, " ").trim().slice(0, digestCap);
  const prevDigest = (prev?.digest ?? "").trim();
  const digest = incomingDigest.length >= prevDigest.length ? incomingDigest : prevDigest.slice(0, digestCap);
  const coveredSections = [...new Set([...(prev?.coveredSections ?? []), ...(entry.coveredSections ?? [])])].slice(0, 48);
  const coveredFields = [...new Set([...(prev?.coveredFields ?? []), ...(entry.coveredFields ?? [])])].slice(0, 48);
  const exactEvidenceRanges = [...(prev?.exactEvidenceRanges ?? []), ...(entry.exactEvidenceRanges ?? [])]
    .filter((range, index, all) => all.findIndex(item => item.startLine === range.startLine && item.endLine === range.endLine) === index)
    .slice(0, 48);
  const artifactIds = [...new Set([...(prev?.artifactIds ?? []), ...(entry.artifactIds ?? [])])].slice(-12);
  const next: MaterialsShelfEntry = {
    key,
    path: entry.path ?? prev?.path,
    characterId: entry.characterId ?? prev?.characterId,
    sourceHash: entry.sourceHash,
    kind: entry.kind,
    digest,
    bodyChars: Math.max(entry.bodyChars, prev?.bodyChars ?? 0),
    fullBodyServed: Boolean(entry.fullBodyServed || prev?.fullBodyServed),
    ...(coveredSections.length ? { coveredSections } : {}),
    ...(coveredFields.length ? { coveredFields } : {}),
    ...(exactEvidenceRanges.length ? { exactEvidenceRanges } : {}),
    ...(artifactIds.length ? { artifactIds } : {}),
    ...(entry.hardConstraints ?? prev?.hardConstraints
      ? { hardConstraints: entry.hardConstraints ?? prev?.hardConstraints }
      : {}),
    retention: entry.hardConstraints || prev?.hardConstraints ? "executable" : entry.retention ?? prev?.retention ?? "coverage",
  };
  // Bound recoverable/coverage entries only. Executable constraints are selected
  // by semantic importance and must never disappear merely because they are old.
  if (!context.materialsShelf.has(key) && context.materialsShelf.size >= MATERIALS_SHELF_MAX_ENTRIES) {
    const drop = [...context.materialsShelf.values()].find(item =>
      !item.hardConstraints && item.retention !== "executable" && !item.fullBodyServed)
      ?? [...context.materialsShelf.values()].find(item =>
        !item.hardConstraints && item.retention !== "executable");
    if (drop) context.materialsShelf.delete(drop.key);
    else if (!next.hardConstraints && next.retention !== "executable") return next;
  }
  context.materialsShelf.set(key, next);
  return next;
}

/**
 * Compact prompt block for the session materials shelf.
 * Injected at open turn when non-empty, and re-frozen at each chapter boundary.
 */
export function formatJobMaterialsShelfPrompt(context: ToolExecutionContext): string {
  const entries = [...(context.materialsShelf?.values() ?? [])]
    .sort((a, b) => (a.path ?? a.key).localeCompare(b.path ?? b.key, undefined, { numeric: true }));
  if (!entries.length) return "";
  const payload = entries.map(item => ({
    key: item.key,
    ...(item.path ? { path: item.path } : {}),
    ...(item.characterId != null ? { characterId: item.characterId } : {}),
    kind: item.kind,
    sourceHash: item.sourceHash.slice(0, 12),
    bodyChars: item.bodyChars,
    fullBodyServed: item.fullBodyServed,
    retention: item.retention ?? (item.hardConstraints ? "executable" : "coverage"),
    ...(item.coveredSections?.length ? { coveredSections: item.coveredSections } : {}),
    ...(item.coveredFields?.length ? { coveredFields: item.coveredFields } : {}),
    ...(item.exactEvidenceRanges?.length ? { exactEvidenceRanges: item.exactEvidenceRanges } : {}),
    ...(item.artifactIds?.length ? { artifactIds: item.artifactIds } : {}),
    ...(item.hardConstraints ? { constraintHash: characterConstraintHash(item.hardConstraints) } : {}),
    digest: item.digest,
  }));
  return [
    `${MATERIALS_SHELF_PROMPT_PREFIX}以下设定/角色已在本会话读过（sourceHash 未变则禁止无目标整篇重读或反复 search）。`,
    "digest 只用于定位，不能代替角色原始资料或事实依据。角色需要具体能力、限制、身体、知识或声线时，调用 get_character 以原始分区精确恢复。",
    "coveredSections/coveredFields 只记录曾经读取过的范围；角色卡允许按需恢复相同且未变化的原始分区，不得只凭摘要续写。",
    "文档缺口用 read_file 的 block、startLine/endLine 或 quote 定点补读；禁止用 search_files 当分页阅读。",
    "材料架不是过程 transcript：各 job 的工具链会丢弃，但已验证设定 digests 仍在此处。",
    JSON.stringify({ materials: payload, count: payload.length, scope: "session" }),
  ].join("\n");
}

/**
 * Load session shelf and drop entries whose on-disk (or character) identity no longer matches.
 */
export function hydrateSessionMaterialsShelf(
  store: WriterStore,
  sessionId: string,
  project: WriterProject,
): Map<string, MaterialsShelfEntry> {
  const map = new Map<string, MaterialsShelfEntry>();
  let dirty = false;
  const characterHashes = new Map(store.characters().map(item => [
    item.id,
    project.hash(JSON.stringify(item)),
  ]));
  for (const entry of store.sessionMaterialsShelf(sessionId)) {
    if (entry.characterId != null) {
      if (characterHashes.get(entry.characterId) !== entry.sourceHash) {
        dirty = true;
        continue;
      }
      map.set(entry.key, entry);
      continue;
    }
    if (!entry.path) {
      dirty = true;
      continue;
    }
    const path = entry.path;
    try {
      if (!project.textFileExists(path) && !project.documentExists(path)) {
        dirty = true;
        continue;
      }
      const currentHash = project.textFileExists(path)
        ? project.hash(project.readTextFile(path))
        : project.hash(project.read(path));
      if (currentHash !== entry.sourceHash) {
        dirty = true;
        continue;
      }
      map.set(entry.key, entry);
    } catch {
      dirty = true;
    }
  }
  if (dirty) store.saveSessionMaterialsShelf(sessionId, [...map.values()]);
  return map;
}

export function persistSessionMaterialsShelf(
  store: WriterStore,
  sessionId: string,
  context: ToolExecutionContext,
): void {
  // Always write the in-memory map (hydrated at job start, mutated by reads).
  // Empty map is valid only when hydrate already emptied stale entries.
  if (!context.materialsShelf) return;
  store.saveSessionMaterialsShelf(sessionId, [...context.materialsShelf.values()]);
}

function materialsShelfHitPayload(entry: MaterialsShelfEntry, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    status: "materials_shelf_hit",
    key: entry.key,
    ...(entry.path ? { path: entry.path } : {}),
    ...(entry.characterId != null ? { characterId: entry.characterId } : {}),
    sourceHash: entry.sourceHash,
    kind: entry.kind,
    digest: entry.digest,
    bodyChars: entry.bodyChars,
    retention: entry.retention ?? (entry.hardConstraints ? "executable" : "coverage"),
    ...(entry.coveredSections?.length ? { coveredSections: entry.coveredSections } : {}),
    ...(entry.coveredFields?.length ? { coveredFields: entry.coveredFields } : {}),
    ...(entry.exactEvidenceRanges?.length ? { exactEvidenceRanges: entry.exactEvidenceRanges } : {}),
    ...(entry.artifactIds?.length ? { artifactIds: entry.artifactIds } : {}),
    ...(entry.hardConstraints ? { hardConstraints: entry.hardConstraints } : {}),
    message: entry.characterId != null
      ? "角色卡材料架只保存索引，摘要不能代替原始分区。请用 get_character 精确恢复所需字段。"
      : "该材料已在会话材料架中（全文已提供过）。禁止无参数整篇重读与反复 search；请直接依据 digest 续写。"
        + "hardConstraints 仍是权威执行态；若请求字段或段落未在 coverage 中，请定点补读。",
    nextAction: "inspect_or_targeted_read",
    ...extra,
  });
}

function readResultRanges(parsed: Record<string, unknown>): Array<{ startLine: number; endLine: number }> {
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  const add = (start: unknown, end: unknown) => {
    if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end)) return;
    if (start < 1 || end < start) return;
    ranges.push({ startLine: start, endLine: end });
  };
  add(parsed.contextStartLine ?? parsed.startLine, parsed.contextEndLine ?? parsed.endLine);
  if (Array.isArray(parsed.matches)) {
    for (const match of parsed.matches) {
      if (!match || typeof match !== "object" || Array.isArray(match)) continue;
      const value = match as Record<string, unknown>;
      add(value.contextStartLine ?? value.startLine, value.contextEndLine ?? value.endLine);
    }
  }
  return ranges;
}

function readResultBodyCharacters(parsed: Record<string, unknown>): number {
  let total = typeof parsed.content === "string" ? parsed.content.length : 0;
  if (Array.isArray(parsed.matches)) {
    for (const match of parsed.matches) {
      if (!match || typeof match !== "object" || Array.isArray(match)) continue;
      const context = (match as Record<string, unknown>).context;
      if (typeof context === "string") total += context.length;
    }
  }
  return total;
}

/**
 * Admit one immutable read atom into the active job. A path cannot silently
 * switch source hashes, and body ranges cannot overlap text already in context.
 */
export function admitReadAtom(
  toolName: string,
  path: string,
  expectedSourceHash: string,
  result: string,
  context: ToolExecutionContext,
): string {
  if (!DOCUMENT_READ_TOOLS.has(toolName)) return result;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(result) as Record<string, unknown>; }
  catch { return result; }
  if (typeof parsed.error === "string") return result;
  const resultHash = typeof parsed.sourceHash === "string" ? parsed.sourceHash : expectedSourceHash;
  if (resultHash !== expectedSourceHash) {
    return JSON.stringify({
      error: `${path} 在读取过程中发生变化；本次结果已丢弃，避免混合两个版本。请重新开始该文档的读取。`,
      path,
      expectedSourceHash,
      actualSourceHash: resultHash,
    });
  }
  context.readSnapshots ??= new Map();
  const existing = context.readSnapshots.get(path);
  if (existing && existing.sourceHash !== resultHash) {
    return JSON.stringify({
      error: `${path} 已锁定快照 ${existing.sourceHash}，当前版本为 ${resultHash}；本轮禁止混读，请在下一任务重新读取。`,
      path,
      sourceHash: resultHash,
      lockedSourceHash: existing.sourceHash,
    });
  }
  const snapshot = existing ?? { sourceHash: resultHash, ranges: [] };
  context.readSnapshots.set(path, snapshot);
  if (!DOCUMENT_BODY_READ_TOOLS.has(toolName)) return result;

  const ranges = readResultRanges(parsed);
  const covered = ranges.length > 0 && ranges.every(range => snapshot.ranges.some(previous =>
    range.startLine >= previous.startLine && range.endLine <= previous.endLine));
  if (covered) {
    return JSON.stringify({
      status: "read_atom_reused",
      path,
      sourceHash: resultHash,
      ranges,
      message: "该行范围已存在于本轮上下文，正文不再重复返回；请直接使用已有读取结果。",
    });
  }
  const characters = readResultBodyCharacters(parsed);
  const used = context.readCharactersUsed ?? 0;
  context.readCharactersUsed = used + characters;
  snapshot.ranges.push(...ranges);
  return result;
}

function withReuseMarker(content: string, message: string, artifactId?: number): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.error === "string") return content;
    return JSON.stringify({ ...parsed, reused: true, ...(artifactId !== undefined ? { artifactId } : {}), message });
  } catch {
    return content;
  }
}

function attachArtifactId(content: string, artifactId: number): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.error === "string") return content;
    return JSON.stringify({ ...parsed, artifactId });
  } catch {
    return content;
  }
}

async function executeToolCached(
  call: ToolAccumulator, project: WriterProject, store: WriterStore, sessionId: string,
  emit: (event: AgentEvent) => void, counts: Map<string, number>, characterScope?: number[],
  context: ToolExecutionContext = { permissionMode: "ask" },
): Promise<string> {
  if (call.name === "audit_prose_style" && context.chapterSceneDraft) {
    try {
      const input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      const auditPath = typeof input.path === "string"
        ? input.path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/").replace(/^resource(?:\/|$)/, "")
        : "";
      if (auditPath === context.chapterSceneDraft.path) {
        return executeTool(call, project, store, sessionId, emit, characterScope, context);
      }
    } catch { /* executeTool returns the structured invalid-JSON diagnostic. */ }
  }
  if (!CACHEABLE_TOOLS.has(call.name)) return executeTool(call, project, store, sessionId, emit, characterScope, context);
  let input: Record<string, unknown>;
  try { input = JSON.parse(call.arguments || "{}") as Record<string, unknown>; }
  catch { return executeTool(call, project, store, sessionId, emit, characterScope, context); }
  const normalized = Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) =>
    [key, typeof value === "string" ? value.trim() : value]));
  const path = typeof normalized.path === "string" ? normalized.path : undefined;
  const outlinePath = call.name.includes("outline") ? resolveOutlineSourcePath(project) : undefined;
  const sourcePath = path ?? (outlinePath && project.documentExists(outlinePath) ? outlinePath : undefined);
  const workingSourcePath = sourcePath
    ? sourcePath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/^resource(?:\/|$)/, "")
    : undefined;
  const workingFile = workingSourcePath ? context.workingTextFiles?.get(workingSourcePath) : undefined;
  const characterId = call.name === "get_character" ? optionalPositiveIntegerLike(normalized.id) : undefined;
  const character = characterId ? store.characters().find(item => item.id === characterId) : undefined;
  const sourceHash = character
    ? project.hash(JSON.stringify(character))
    : workingFile
      ? workingFile.sourceHash
    : sourcePath && project.textFileExists(sourcePath)
    ? project.hash(project.readTextFile(sourcePath))
    : call.name === "search_project"
      ? project.hash(JSON.stringify({
          documents: project.listDocuments().map(documentPath =>
            [documentPath, project.hash(project.read(documentPath))]),
          writingMemory: store.writingMemory(sessionId, { limit: 1_000 }).map(entry =>
            [entry.id, entry.status, entry.updatedAt]),
        }))
    : call.name.endsWith("_files")
      ? project.hash(JSON.stringify([...new Set([
          ...project.listTextFiles(),
          ...(context.workingTextFiles?.keys() ?? []),
        ])].sort().map(file => [
          file,
          context.workingTextFiles?.get(file)?.sourceHash ?? project.hash(project.readTextFile(file)),
        ])))
      : project.hash(JSON.stringify(project.listDocuments()));

  if (DOCUMENT_READ_TOOLS.has(call.name) && sourcePath) {
    const locked = context.readSnapshots?.get(sourcePath);
    if (locked && locked.sourceHash !== sourceHash) {
      return JSON.stringify({
        error: `${sourcePath} 已锁定快照 ${locked.sourceHash}，当前版本为 ${sourceHash}；本轮禁止混读，请在下一任务重新读取。`,
        path: sourcePath,
        sourceHash,
        lockedSourceHash: locked.sourceHash,
      });
    }
    // Same lore/path already paid full body once → block aimless whole-doc re-read only.
    // Targeted block/line/quote/span/inspect still allowed when digests omit a section.
    if (shouldShelfPath(sourcePath)) {
      const shelfKey = materialsShelfKeyForPath(sourcePath);
      const shelf = context.materialsShelf?.get(shelfKey);
      if (shelf && shelf.sourceHash === sourceHash && shelf.fullBodyServed
        && !isTargetedDocumentSupplement(call.name, normalized)) {
        return materialsShelfHitPayload(shelf, { tool: call.name });
      }
    }
  }

  // search_project: once every lore/outline file has been fully served this job,
  // block thrashing re-scans (ignore loose other/ roots that never get shelved).
  if (call.name === "search_project") {
    const loreDocs = project.listDocuments()
      .filter(path => !project.isDocumentHidden(path) && isCoreSettingPath(path));
    if (loreDocs.length > 0) {
      const served = new Set(
        [...(context.materialsShelf?.values() ?? [])]
          .filter(item => item.path && item.fullBodyServed && isCoreSettingPath(item.path))
          .map(item => materialsShelfKeyForPath(item.path!)),
      );
      const allServed = loreDocs.every(path => served.has(materialsShelfKeyForPath(path)));
      if (allServed) {
        return JSON.stringify({
          status: "materials_shelf_search_redirect",
          message: "本 job 材料架已收录项目全部 lore/outline 正文。禁止再 search_files 当分页阅读；"
            + "请依据 digests 写作，缺段时对具体 path 用 read_file 的 block/行号定点补读。",
          shelfPaths: loreDocs.slice(0, 20),
          shelfCount: loreDocs.length,
          nextAction: "inspect_or_targeted_read",
        });
      }
    }
  }

  // Version read artifacts so older cached payload shapes are not mixed in.
  const cacheVersion = DOCUMENT_READ_TOOLS.has(call.name)
    ? `:${READ_ATOM_CACHE_VERSION}`
    // Character views changed from a lossy card dump to scoped original fields.
    // Do not revive pre-change artifacts into an active writing turn.
    : call.name === "get_character" ? ":character-view-v2" : "";
  const cacheKey = `${call.name}${cacheVersion}:${JSON.stringify(normalized)}:${sourceHash}`;
  const count = (counts.get(cacheKey) ?? 0) + 1;
  counts.set(cacheKey, count);
  const cached = store.contextArtifact(sessionId, cacheKey);
  if (cached) {
    if (DOCUMENT_READ_TOOLS.has(call.name) && count > 1) {
      if (sourcePath && shouldShelfPath(sourcePath)) {
        registerMaterialsShelfEntry(context, {
          path: sourcePath,
          sourceHash: cached.sourceHash ?? sourceHash,
          kind: call.name,
          digest: cached.digest,
          bodyChars: 0,
          fullBodyServed: true,
        });
      }
      return JSON.stringify({
        status: "read_atom_reused",
        artifactId: cached.id,
        path: cached.path ?? sourcePath,
        sourceHash: cached.sourceHash,
        digest: cached.digest,
        message: "相同读取已存在于本轮上下文，正文不再重复返回。",
      });
    }
    // First restore after a chapter-boundary count clear: do not re-pour aimless full
    // lore if the shelf already served that path; targeted supplements still restore.
    if (DOCUMENT_BODY_READ_TOOLS.has(call.name) && sourcePath && shouldShelfPath(sourcePath)) {
      const shelf = context.materialsShelf?.get(materialsShelfKeyForPath(sourcePath));
      if (shelf?.fullBodyServed && shelf.sourceHash === sourceHash
        && !isTargetedDocumentSupplement(call.name, normalized)) {
        return materialsShelfHitPayload(shelf, { artifactId: cached.id, tool: call.name });
      }
    }
    const restored = withReuseMarker(cached.content,
      count === 1
        ? "工作记忆中已有相同且未变化的工具结果；以下为完整内容，请直接使用，勿再次读取。"
        : "相同读取已执行过且文档未变；以下从工作记忆恢复完整结果，请直接使用，禁止再次调用。",
      cached.id);
    const admitted = sourcePath ? admitReadAtom(call.name, sourcePath, sourceHash, restored, context) : restored;
    rememberMaterialsFromToolResult(call.name, admitted, sourcePath, sourceHash, context, store);
    return admitted;
  }
  const result = await executeTool(call, project, store, sessionId, emit, characterScope, context);
  const admitted = sourcePath ? admitReadAtom(call.name, sourcePath, sourceHash, result, context) : result;
  if (admitted !== result) {
    rememberMaterialsFromToolResult(call.name, admitted, sourcePath, sourceHash, context, store);
    return admitted;
  }
  let digest = `${call.name} 已完成`;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (typeof parsed.error === "string") return result;
    const location = [parsed.path, parsed.heading ?? parsed.section ?? parsed.block].filter(value => value !== undefined).join(" · ");
    const excerpt = typeof parsed.content === "string" ? parsed.content.replace(/\s+/g, " ").slice(0, 240)
      : typeof parsed.markdown === "string" ? parsed.markdown.replace(/\s+/g, " ").slice(0, 240)
      : typeof parsed.excerpt === "string" ? parsed.excerpt.replace(/\s+/g, " ").slice(0, 240)
      : Array.isArray(parsed.nodes) ? `节点${parsed.nodes.length}个` : "";
    digest = [call.name, location, excerpt].filter(Boolean).join("：");
  } catch { digest = `${call.name} 返回了非 JSON 结果`; }
  const artifactId = store.saveContextArtifact(sessionId, { cacheKey, kind: call.name, path: sourcePath, sourceHash, content: result, digest });
  const attached = attachArtifactId(result, artifactId);
  rememberMaterialsFromToolResult(call.name, attached, sourcePath, sourceHash, context, store);
  return attached;
}

/** Record setting/character payloads onto the job materials shelf after a successful read. */
function rememberMaterialsFromToolResult(
  toolName: string,
  result: string,
  sourcePath: string | undefined,
  sourceHash: string,
  context: ToolExecutionContext,
  store: WriterStore,
): void {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (typeof parsed.error === "string") return;
    if (parsed.status === "materials_shelf_hit" || parsed.status === "read_atom_reused") return;

    if (toolName === "get_character") {
      const id = typeof parsed.id === "number" ? parsed.id : Number(parsed.id);
      if (!Number.isInteger(id) || id <= 0) return;
      const name = typeof parsed.name === "string" ? parsed.name
        : typeof (parsed.identity as { name?: unknown } | undefined)?.name === "string"
          ? String((parsed.identity as { name: string }).name)
          : `角色#${id}`;
      const summary = typeof parsed.summary === "string" ? parsed.summary
        : typeof (parsed.identity as { summary?: unknown } | undefined)?.summary === "string"
          ? String((parsed.identity as { summary: string }).summary)
          : "";
      const character = store.characters().find(item => item.id === id);
      const hardConstraints = character ? characterConstraintView(character) : undefined;
      if (context.reviewCharacterIds && !context.reviewCharacterIds.includes(id)) {
        context.reviewCharacterIds.push(id);
      }
      if (context.writerCharacterConstraintHashes && hardConstraints) {
        context.writerCharacterConstraintHashes.set(id, characterConstraintHash(hardConstraints));
      }
      const coveredFields = Object.keys(parsed).filter(key => !["artifactId", "reused", "message"].includes(key));
      const artifactId = typeof parsed.artifactId === "number" ? parsed.artifactId : undefined;
      registerMaterialsShelfEntry(context, {
        key: materialsShelfKeyForCharacter(id),
        characterId: id,
        sourceHash,
        kind: toolName,
        digest: `${name} ${summary}`.replace(/\s+/g, " ").slice(0, MATERIALS_SHELF_DIGEST_CHARS),
        bodyChars: result.length,
        fullBodyServed: true,
        coveredFields,
        ...(artifactId !== undefined ? { artifactIds: [artifactId] } : {}),
        ...(hardConstraints ? { hardConstraints } : {}),
        retention: hardConstraints ? "executable" : "coverage",
      });
      return;
    }

    if (!sourcePath || !shouldShelfPath(sourcePath)) return;
    if (!DOCUMENT_READ_TOOLS.has(toolName) && toolName !== "get_outline_node") return;
    const body = typeof parsed.content === "string" ? parsed.content
      : typeof parsed.markdown === "string" ? parsed.markdown
        : typeof parsed.excerpt === "string" ? parsed.excerpt
          : "";
    // inspect returns opening/ending/headings — fold into digest without marking full body.
    const inspectBits = toolName === "inspect_document" || toolName === "inspect_file"
      ? [
          typeof parsed.opening === "string" ? parsed.opening : "",
          Array.isArray(parsed.headings)
            ? parsed.headings.slice(0, 40).map((item) => {
              if (!item || typeof item !== "object") return "";
              const row = item as Record<string, unknown>;
              return typeof row.text === "string" ? row.text : "";
            }).filter(Boolean).join(" ")
            : "",
          typeof parsed.ending === "string" ? parsed.ending : "",
        ].filter(Boolean).join("\n")
      : "";
    const digestSource = body || inspectBits;
    const isBody = DOCUMENT_BODY_READ_TOOLS.has(toolName) && body.length > 0;
    const exactEvidenceRanges = readResultRanges(parsed);
    const coveredSections = [parsed.heading, parsed.section, parsed.block]
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .map(String);
    const artifactId = typeof parsed.artifactId === "number" ? parsed.artifactId : undefined;
    // Whole-doc first body (no range params) marks fullBodyServed; block reads alone do not
    // if shelf was empty — but once any substantial body is served we keep the flag.
    const digest = digestSource
      ? buildMaterialsShelfDigest(sourcePath, digestSource, toolName)
      : `${toolName} ${sourcePath}`;
    registerMaterialsShelfEntry(context, {
      path: sourcePath,
      sourceHash: typeof parsed.sourceHash === "string" ? parsed.sourceHash : sourceHash,
      kind: toolName,
      digest,
      bodyChars: body.length || (typeof parsed.characterCount === "number" ? parsed.characterCount : 0),
      // Only body reads mark fullBodyServed — inspect alone still allows one full read.
      fullBodyServed: isBody,
      coveredSections,
      exactEvidenceRanges,
      ...(artifactId !== undefined ? { artifactIds: [artifactId] } : {}),
      retention: "coverage",
    });
  } catch { /* ignore non-JSON */ }
}

/** Windowing for agent history preview only (roleplay uses its own limit). CACHE: keep small. */
function compactHistory(messages: Array<{ role: string; content: string; channel?: string }>): Array<ApiMessage & { channel?: string }> {
  // Dynamic-tail history is miss-priced every turn — prefer short windows.
  const recent = messages.slice(-6);
  const older = messages.slice(0, -6);
  const result: Array<ApiMessage & { channel?: string }> = [];
  if (older.length) {
    let summary = older.map((message) => {
      const label = message.role === "user" ? "用户" : "Agent";
      const channel = message.channel === "roleplay" ? "[扮演]" : "";
      const content = stripDsmlText(message.content, "[工具调用已隐藏]");
      return `${channel}${label}: ${content.replace(/\s+/g, " ").slice(0, 160)}`;
    }).join("\n");
    if (summary.length > 1_600) summary = `[更早内容已省略]\n${summary.slice(-1_600)}`;
    result.push({ role: "system", content: `较早会话压缩摘要：\n${summary}` });
  }
  result.push(...recent.map((message) => ({
    role: message.role as "user" | "assistant",
    content: stripDsmlText(message.content, "[工具调用已隐藏]"),
    ...(message.channel === "roleplay" ? { channel: "roleplay" } : {}),
  })));
  return result;
}

/**
 * Compact heavy tool bodies into digests (artifactId preserved).
 *
 * CACHE / APPEND-ONLY: Use only when *rebuilding* a transcript outside an active
 * runAgent job (e.g. tests or future cross-turn rebuild). Never call between
 * multi-step tool turns in the same job — mutating earlier messages invalidates
 * the provider prefix cache for all subsequent steps.
 *
 * `keepRecent: 0` + `force` is the replay path (src/turn_replay.ts): a frozen turn
 * that has gone cold is compacted as a *whole*, with no sliding "keep the last two"
 * window. That makes the operation idempotent on a fixed message array — every
 * heavy body is already a digest on the second pass — which is what lets an
 * already-shrunk block stay byte-identical on every later turn.
 */
export function compactRuntimeMessages(
  messages: ApiMessage[],
  options: { keepRecent?: number; force?: boolean } = {},
): void {
  const keepRecent = Math.max(0, options.keepRecent ?? 2);
  const toolIndexes = messages.flatMap((message, index) => message.role === "tool" ? [index] : []);
  const totalChars = toolIndexes.reduce((sum, index) => sum + messageContentCharCount(messages[index].content), 0);
  // Earlier compact once digests stay in the transcript (no full rehydrate of all tools).
  if (!options.force && toolIndexes.length <= 4 && totalChars <= 20_000) return;

  // slice(0, -0) is slice(0, 0) — an empty list. keepRecent 0 must mean "all of them".
  for (const index of keepRecent > 0 ? toolIndexes.slice(0, -keepRecent) : toolIndexes) {
    const message = messages[index];
    const toolBody = messageContentText(message.content);
    if (!toolBody || toolBody.length <= 800) continue;
    try {
      const parsed = JSON.parse(toolBody) as Record<string, unknown>;
      if (parsed.status === "artifact_compacted") continue;
      // Never compact catalogs / search hit lists — losing IDs forces re-list thrashing.
      if ([...NEVER_COMPACT_KEYS].some(key => key in parsed)) continue;
      if (parsed.reused === true && toolBody.length < 8_000) continue;

      const content = typeof parsed.content === "string" ? parsed.content
        : typeof parsed.markdown === "string" ? parsed.markdown : undefined;
      // Only compact heavy document bodies; keep metadata tools intact.
      if (!content || content.length < 800) continue;

      const digestLimit = 1_200;
      message.content = JSON.stringify({
        status: "artifact_compacted",
        artifactId: parsed.artifactId,
        path: parsed.path,
        section: parsed.section,
        heading: parsed.heading,
        block: parsed.block,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        sourceHash: parsed.sourceHash,
        digest: content.replace(/\s+/g, " ").slice(0, digestLimit),
        message: "正文已压缩为 digest；请直接基于 digest、本轮任务工作记忆与写作引导继续。禁止因压缩再次 read_file / list_outline_nodes。",
      });
    } catch {
      if (toolBody.length > 2_500) {
        message.content = JSON.stringify({ status: "artifact_compacted", message: "工具结果已压缩；请继续任务，不要重复调用同一工具。" });
      }
    }
  }
}

/**
 * Restore only the most recent compacted tool bodies (default 2).
 * CACHE: Same append-only rule as compactRuntimeMessages — do not rehydrate in the
 * live multi-step loop (it rewrites message bytes and breaks prefix continuity).
 */
export function rehydrateRecentToolMessages(
  messages: ApiMessage[],
  store: WriterStore,
  sessionId: string,
  keepRecent = 2,
): void {
  const toolIndexes = messages.flatMap((message, index) => message.role === "tool" ? [index] : []);
  const restore = new Set(toolIndexes.slice(-Math.max(0, keepRecent)));
  for (const index of restore) {
    const message = messages[index];
    const toolBody = messageContentText(message?.content);
    if (!toolBody) continue;
    try {
      const parsed = JSON.parse(toolBody) as Record<string, unknown>;
      if (parsed.status !== "artifact_compacted") continue;
      const artifactId = typeof parsed.artifactId === "number" ? parsed.artifactId : undefined;
      if (artifactId === undefined) continue;
      const full = store.contextArtifactById(sessionId, artifactId);
      if (!full?.content) continue;
      message.content = withReuseMarker(full.content, "已从工作记忆恢复最近工具结果；如信息仍不足，可继续读取必要范围。", artifactId);
    } catch { /* ignore non-JSON tool payloads */ }
  }
}

/**
 * Drop reasoning_content on older assistant turns.
 * CACHE: Mutates history — only safe outside the live multi-step job loop.
 */
export function stripStaleReasoningContent(messages: ApiMessage[]): void {
  let lastWithReasoning = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role === "assistant" && messages[index].reasoning_content) lastWithReasoning = index;
  }
  for (let index = 0; index < messages.length; index += 1) {
    if (index !== lastWithReasoning && messages[index].reasoning_content) {
      delete messages[index].reasoning_content;
    }
  }
}

/**
 * Strip older full-body file payloads when rebuilding a multi-delivery transcript.
 * CACHE: Not used mid-job (append-only) so prefix cache stays intact.
 */
export function compactCompletedToolCalls(messages: ApiMessage[]): void {
  let latestProposalMessage = -1;
  const carriesDocumentBody = (name: string) => name === "write_file"
    || name === "edit_file"
    || name.startsWith("propose_document");
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.tool_calls?.some(call => carriesDocumentBody(call.function.name))) {
      latestProposalMessage = index;
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    // Keep the newest proposal intact as repair context; strip older ones.
    if (index === latestProposalMessage) continue;
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (!carriesDocumentBody(call.function.name)) continue;
      try {
        const input = JSON.parse(call.function.arguments) as Record<string, unknown>;
        if (call.function.name === "write_file" || call.function.name === "propose_document") {
          call.function.arguments = JSON.stringify({
            path: input.path,
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            content: "[内容已压缩：旧工作副本已提交并从历史工具参数中移除。]",
          });
        } else if (call.function.name === "edit_file") {
          call.function.arguments = JSON.stringify({
            path: input.path,
            edits: [{
              operation: "replace",
              oldText: "[旧编辑原文已压缩]",
              content: "[旧编辑内容已压缩]",
            }],
          });
        } else {
          call.function.arguments = JSON.stringify({
            path: input.path,
            summary: input.summary,
            edits: [{
              search: "[内容已压缩：旧 search 已从历史工具参数中移除。新提交时必须重新读取原文并提供真实 search。]",
              replace: "[内容已压缩：旧 replace 已提交并从历史工具参数中移除。新提交时必须提供真实替换内容。]",
            }],
          });
        }
      } catch { call.function.arguments = "{}"; }
    }
  }
}

function toStepUsage(
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    estimated?: boolean;
  },
  pricing?: ModelConfig["pricing"],
  at: Date = new Date(),
): StepUsage {
  const cacheMissTokens = usage.cacheMissTokens || Math.max(0, usage.promptTokens - usage.cacheHitTokens);
  const normalized = { ...usage, cacheMissTokens };
  const measuredInput = usage.cacheHitTokens + cacheMissTokens;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens,
    totalTokens: usage.promptTokens + usage.completionTokens,
    cost: pricing && !usage.estimated ? calculateUsageCost(normalized, pricing, at) : 0,
    currency: pricing?.currency ?? "CNY",
    ...(usage.estimated ? { estimated: true } : {}),
    ...(!usage.estimated && measuredInput > 0 ? { cacheHitRate: usage.cacheHitTokens / measuredInput } : {}),
  };
}

function emitUsageEvent(
  emit: (event: AgentEvent) => void,
  store: WriterStore,
  sessionId: string,
  model: ModelConfig,
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    estimated?: boolean;
  },
  step?: number,
  callKind = "agent_step",
  jobId?: string,
  requestComponents?: RequestComponentUsage[],
): void {
  const estimated = usage.estimated === true;
  const call = {
    ...toStepUsage(usage, model.pricing),
    model: model.model,
    providerName: model.providerName?.trim()
      || (model.provider === "deepseek" ? "DeepSeek" : "API"),
  };
  if (!estimated) {
    emit(buildRecordedUsageEvent(store, sessionId, model, usage, {
      callKind,
      ...(step === undefined ? {} : { step }),
      ...(jobId ? { jobId } : {}),
      ...(requestComponents?.length ? { requestComponents } : {}),
    }));
    return;
  }
  emit({
    type: "usage",
    usage: store.usage(sessionId),
    call: requestComponents?.length ? { ...call, requestComponents } : call,
    ...(step !== undefined ? { step } : {}),
    callKind,
    ...(jobId ? { jobId } : {}),
  });
}

const MODEL_TOOL_RESULT_TOKEN_BUDGET = 6_000;
const MODEL_FILE_MUTATION_TOOLS = new Set(["write_file", "edit_file", "move_file", "delete_file"]);

function modelVisibleFileMutationResult(call: ToolAccumulator, result: string): string {
  if (!MODEL_FILE_MUTATION_TOOLS.has(call.name)) return result;
  try {
    const parsed = JSON.parse(result) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    const {
      proposalId: _proposalId,
      changeSetId: _changeSetId,
      deliverableId: _deliverableId,
      ...visible
    } = parsed as Record<string, unknown>;
    const status = typeof visible.status === "string" ? visible.status : "";
    const message = status === "accepted"
      ? "文件变更已写入。"
      : status === "pending"
        ? "文件变更已提交，等待用户审批。"
        : typeof visible.message === "string"
          ? visible.message
          : undefined;
    return JSON.stringify({ ...visible, ...(message ? { message } : {}) });
  } catch {
    return result;
  }
}

/**
 * Bound a tool result before it is appended to the live transcript. The full
 * payload remains in session-scoped work memory and can be paged explicitly.
 * This never rewrites an earlier message, so the append-only cache contract holds.
 */
export function boundToolResultForModel(
  call: ToolAccumulator,
  result: string,
  project: WriterProject,
  store: WriterStore,
  sessionId: string,
): string {
  result = modelVisibleFileMutationResult(call, result);
  const estimatedTokens = approximateRequestTokens(result);
  if (estimatedTokens <= MODEL_TOOL_RESULT_TOKEN_BUDGET) return result;
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(result) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { /* plain text is still archived and previewed */ }

  const existingArtifactId = typeof parsed?.artifactId === "number" ? parsed.artifactId : undefined;
  const sourceHash = typeof parsed?.sourceHash === "string" ? parsed.sourceHash : project.hash(result);
  const artifactId = existingArtifactId ?? store.saveContextArtifact(sessionId, {
    cacheKey: `oversize-tool:${call.name}:${project.hash(result)}`,
    kind: call.name,
    ...(typeof parsed?.path === "string" ? { path: parsed.path } : {}),
    sourceHash,
    content: result,
    digest: `${call.name} 大型结果：${result.replace(/\s+/g, " ").slice(0, 240)}`,
  });
  const metadata: Record<string, unknown> = {};
  if (parsed) {
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "content" || key === "markdown" || key === "beforeContent" || key === "afterContent") continue;
      if (typeof value === "string" && value.length <= 800) metadata[key] = value;
      else if (typeof value === "number" || typeof value === "boolean" || value === null) metadata[key] = value;
      else if (Array.isArray(value) && JSON.stringify(value).length <= 1_600) metadata[key] = value;
    }
  }
  const head = result.slice(0, 5_000);
  const tail = result.length > 6_500 ? result.slice(-1_500) : "";
  const controlFields = parsed ? {
    ...(typeof parsed.complete === "boolean" ? { complete: parsed.complete } : {}),
    ...(typeof parsed.proposalSubmitted === "boolean" ? { proposalSubmitted: parsed.proposalSubmitted } : {}),
    ...(typeof parsed.reviewCompleted === "boolean" ? { reviewCompleted: parsed.reviewCompleted } : {}),
    ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
    ...(typeof parsed.error === "string" ? { error: parsed.error.slice(0, 800) } : {}),
    ...(typeof parsed.status === "string" ? { originalStatus: parsed.status } : {}),
  } : {};
  return JSON.stringify({
    status: "tool_result_truncated",
    ...controlFields,
    tool: call.name,
    artifactId,
    originalCharacters: result.length,
    estimatedOriginalTokens: estimatedTokens,
    metadata,
    preview: tail ? `${head}\n…[中间内容已省略，可按 artifactId 分页读取]…\n${tail}` : head,
    message: "完整工具结果已保存到工作记忆。preview 与 metadata 不足时，可用 read_context_artifact 分页读取，或继续执行必要工具。",
  });
}

function approximateRequestTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function requestComponentFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

const CONTEXT_GRAPH_LAYER_LABEL_FOR_REQUEST = {
  L0: "规则、schema 与项目索引",
  L1: "历史续写",
  L2: "当前任务与动态上下文",
  L3: "本轮 Agent 与工具过程",
} as const;

function requestToolResultLabel(
  toolCallId: string | undefined,
  index: number,
  toolCalls: Map<string, { name: string; arguments: string }>,
): string {
  const call = toolCallId ? toolCalls.get(toolCallId) : undefined;
  if (!call) return `工具结果 ${toolCallId ?? index}`;
  let source = "";
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    const value = args.path ?? args.documentPath ?? args.sourcePath;
    if (typeof value === "string" && value.trim()) source = value.trim().slice(0, 160);
    else if (typeof args.characterId === "number" || typeof args.characterId === "string") {
      source = `角色 #${String(args.characterId)}`;
    } else if (typeof args.id === "number" || typeof args.id === "string") {
      source = `#${String(args.id)}`;
    }
  } catch { /* malformed tool arguments still retain the tool name */ }
  return `工具结果 · ${call.name}${source ? ` · ${source}` : ""}`;
}

function requestComponentPreview(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 240);
}

function requestToolResultPreview(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const candidate = parsed.content
      ?? parsed.markdown
      ?? parsed.preview
      ?? parsed.digest
      ?? parsed.summary
      ?? parsed.message;
    if (typeof candidate === "string") return requestComponentPreview(candidate);
  } catch { /* plain-text tool results are previewed directly */ }
  return requestComponentPreview(content);
}

/** Preflight-only context waterfall; provider usage remains the billing source of truth. */
export function buildRequestComponentUsage(
  messages: ApiMessage[],
  tools: readonly ToolDefinition[],
  stableMessageCount: number,
  initialMessageCount: number,
  /** End of the replayed frozen turns; defaults to "no replay" for isolated calls. */
  replayedMessageCount = stableMessageCount,
  /** Project trunk messages immediately after the stable prefix (0 or 1). */
  trunkMessageCount = 0,
): RequestComponentUsage[] {
  const components: RequestComponentUsage[] = [];
  const trunkEnd = stableMessageCount + Math.max(0, trunkMessageCount);
  const toolCalls = new Map<string, { name: string; arguments: string }>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      toolCalls.set(call.id, {
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  const append = (
    kind: RequestComponentUsage["kind"],
    layer: NonNullable<RequestComponentUsage["layer"]>,
    label: string,
    text: string,
    fingerprint = false,
    preview = "",
  ) => {
    if (!text) return;
    components.push({
      kind,
      layer,
      label,
      characters: text.length,
      estimatedTokens: approximateRequestTokens(text),
      ...(preview ? { preview: requestComponentPreview(preview) } : {}),
      ...(fingerprint ? { fingerprint: requestComponentFingerprint(text) } : {}),
    });
  };
  if (tools.length) {
    append(
      "tool_schema",
      "L0",
      `工具 schema（${tools.length}）`,
      JSON.stringify(tools),
      true,
      tools.map(tool => tool.function.name).join(" · "),
    );
  }
  messages.forEach((message, index) => {
    const serialized = JSON.stringify({
      role: message.role,
      content: message.content,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    });
    const contentPreview = messageContentText(message.content);
    if (index < stableMessageCount) append("stable_system", "L0", `稳定 system ${index + 1}`, serialized, true, contentPreview);
    else if (index < trunkEnd) append("stable_system", "L0", "项目树干", serialized, true, contentPreview);
    else if (index < replayedMessageCount) append("replayed_turn", "L1", `复放历史 ${index - trunkEnd + 1}`, serialized, false, contentPreview);
    else if (index < initialMessageCount && message.role === "user") append("user", "L2", "当前用户请求", serialized, false, contentPreview);
    else if (index < initialMessageCount) append("dynamic_system", "L2", `动态尾部 ${index - replayedMessageCount + 1}`, serialized, false, contentPreview);
    else if (message.role === "tool") {
      append(
        "tool_result",
        "L3",
        requestToolResultLabel(message.tool_call_id, index, toolCalls),
        serialized,
        false,
        requestToolResultPreview(contentPreview),
      );
    } else if (message.role === "assistant") append("assistant", "L3", `Agent 历史 ${index - initialMessageCount + 1}`, serialized, false, contentPreview);
    else if (message.role === "user") append("user", "L3", `用户/阶段交接 ${index - initialMessageCount + 1}`, serialized, false, contentPreview);
    else append("other", "L3", `其他消息 ${index + 1}`, serialized, false, contentPreview);
  });
  return components;
}

/** Session-shared trunk from current project materials (hash-stable until they change). */
export function buildSessionProjectTrunk(project: WriterProject, store: WriterStore) {
  let outline: { sourcePath: string; nodes: Array<{
    id: string;
    type: string;
    title: string;
    summary?: string;
    documentPath?: string;
    depth?: number;
  }> } | undefined;
  try {
    const snapshot = new OutlineStore(project).sync();
    // Prefer structural spine: chapters/arcs first, then scenes — cap inside buildProjectTrunk.
    const ranked = snapshot.nodes
      .map((node, index) => {
        const rank = node.type === "act" || node.type === "chapter" ? 0
          : node.type === "scene" ? 1
            : 2;
        return { node, index, rank };
      })
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, 48)
      .map(({ node }) => ({
        id: node.id,
        type: node.type,
        title: node.title,
        summary: node.summary,
        ...(node.documentPath ? { documentPath: node.documentPath } : {}),
      }));
    if (ranked.length) outline = { sourcePath: snapshot.sourcePath, nodes: ranked };
  } catch {
    outline = undefined;
  }

  const characters = store.characters().map(item => ({
    id: item.id,
    name: item.identity.name,
    aliases: item.identity.aliases,
    narrativeRole: item.identity.narrativeRole,
    summary: item.identity.summary,
  }));

  const lorePaths = project.listDocuments()
    .filter(path => !project.isDocumentHidden(path))
    .filter(path => {
      const kind = documentKind(path);
      return kind === "lore" || kind === "outline";
    })
    .slice(0, 40);

  let title: string | undefined;
  try { title = project.config().title; } catch { title = undefined; }
  return buildProjectTrunk({
    title,
    characters,
    outline,
    lorePaths,
  });
}

/**
 * Low-level chat completion. CACHE: execution receives one frozen, order-stable
 * universal catalog for the whole job. Never derive tools from project paths/ids
 * or replace the catalog between steps.
 */
type CompletionRequestOptions = {
  tools?: readonly ToolDefinition[];
  userId?: string;
  maxCompletionTokens?: number;
  thinking?: { type: "enabled" | "disabled" };
  temperature?: number;
  topP?: number;
  responseFormat?: { type: "json_object" };
  /** Resolve writer-attachment:// refs when serializing multimodal content. */
  resolveAttachment?: (sessionId: string, id: string) => { mimeType: string; bytes: Buffer } | undefined;
  /** Observation-only metadata. Never serialized into the provider request. */
  prefixCache?: PrefixCacheRequestContext;
};

async function streamCompletion(
  model: ModelConfig,
  messages: ApiMessage[],
  signal: AbortSignal | undefined,
  onText: (text: string) => void,
  onReasoning: (text: string) => void,
  options: CompletionRequestOptions = {},
): Promise<{ content: string; reasoningContent: string; toolCalls: ToolAccumulator[]; finishReason?: string; usage?: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; cacheWriteTokens?: number; estimated?: boolean } }> {
  const endpoint = modelCompletionEndpoint(model);
  // Expand attachment refs / strip images for text-only models only at the wire boundary.
  // Live + archived message arrays keep stable writer-attachment:// refs (cache-friendly size).
  const wireMessages = prepareMessagesForProvider(messages, {
    supportsMultimodal: modelSupportsMultimodal(model),
    resolveAttachment: options.resolveAttachment,
  });
  const prefixObservation = options.prefixCache
    ? beginPrefixCacheObservation({
        projectRoot: options.prefixCache.projectRoot,
        endpoint,
        model: model.model,
        ...(model.providerName ? { providerName: model.providerName } : {}),
        ...(options.userId ? { userId: options.userId } : {}),
        sessionId: options.prefixCache.sessionId,
        ...(options.prefixCache.jobId ? { jobId: options.prefixCache.jobId } : {}),
        callKind: options.prefixCache.callKind,
        ...(options.prefixCache.step !== undefined ? { step: options.prefixCache.step } : {}),
        messages,
        tools: options.tools,
        stableMessageCount: options.prefixCache.stableMessageCount,
        initialMessageCount: options.prefixCache.initialMessageCount,
        ...(options.prefixCache.replayedMessageCount !== undefined
          ? { replayedMessageCount: options.prefixCache.replayedMessageCount }
          : {}),
        ...(options.prefixCache.replayHeadCommitId ? { replayHeadCommitId: options.prefixCache.replayHeadCommitId } : {}),
        ...(options.prefixCache.projectSnapshotHash ? { projectSnapshotHash: options.prefixCache.projectSnapshotHash } : {}),
        requestProfile: {
          thinking: options.thinking?.type,
          responseFormat: options.responseFormat?.type,
          sampling: samplingRequestOptions(model, { temperature: options.temperature, topP: options.topP }),
          api: usesResponsesApi(model) ? "responses" : "chat.completions",
        },
      })
    : undefined;
  const visibleText = createVisibleTextFilter(onText);
  try {
    const streamed = await streamProviderCompletion({
      model,
      messages: wireMessages as ProviderWireMessage[],
      tools: options.tools,
      userId: options.userId,
      maxTokens: options.maxCompletionTokens,
      thinking: options.thinking,
      responseFormat: options.responseFormat,
      temperature: options.temperature,
      topP: options.topP,
    }, {
      signal,
      onText: (text) => visibleText.push(text),
      onReasoning,
    });
    visibleText.flush();
    const textual = extractDsmlToolCalls(streamed.content);
    const resolvedToolCalls = streamed.toolCalls.length ? streamed.toolCalls : textual.toolCalls;
    const resolvedUsage = streamed.usage && (streamed.usage.promptTokens > 0 || streamed.usage.completionTokens > 0)
      ? streamed.usage
      : { ...estimateCompletionUsage(messages, textual.content, streamed.reasoningContent, resolvedToolCalls), estimated: true as const };
    const completed = {
      content: textual.content,
      reasoningContent: streamed.reasoningContent,
      toolCalls: resolvedToolCalls,
      ...(streamed.finishReason ? { finishReason: streamed.finishReason } : {}),
      usage: resolvedUsage,
    };
    finishPrefixCacheObservation(prefixObservation, {
      promptTokens: resolvedUsage.promptTokens,
      completionTokens: resolvedUsage.completionTokens,
      cacheHitTokens: resolvedUsage.cacheHitTokens,
      cacheMissTokens: resolvedUsage.cacheMissTokens,
      ...("cacheWriteTokens" in resolvedUsage && resolvedUsage.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: resolvedUsage.cacheWriteTokens }
        : {}),
      ...("estimated" in resolvedUsage && resolvedUsage.estimated ? { estimated: true } : {}),
      ...(streamed.finishReason ? { finishReason: streamed.finishReason } : {}),
    });
    return completed;
  } catch (error) {
    finishPrefixCacheObservation(prefixObservation, {
      error: error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600),
    });
    throw error;
  }
}

/** Rough token estimate when the provider does not return usage in the stream. */
function estimateCompletionUsage(
  messages: ApiMessage[],
  content: string,
  reasoningContent: string,
  toolCalls: ToolAccumulator[],
): { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number } {
  const promptChars = messages.reduce((sum, message) => {
    const body = messageContentCharCount(message.content);
    const tools = message.tool_calls
      ? message.tool_calls.map((call) => `${call.function.name}:${call.function.arguments}`).join("\n")
      : "";
    return sum + body + tools.length + 16;
  }, 0);
  const completionChars = content.length + reasoningContent.length
    + toolCalls.reduce((sum, call) => sum + call.name.length + call.arguments.length + 24, 0);
  const promptTokens = estimateTokenCount(promptChars);
  const completionTokens = estimateTokenCount(completionChars);
  return {
    promptTokens,
    completionTokens,
    cacheHitTokens: 0,
    cacheMissTokens: promptTokens,
  };
}

function estimateTokenCount(charCount: number): number {
  // Mixed CJK/Latin heuristic used only as UI fallback when billing usage is absent.
  return Math.max(1, Math.ceil(charCount / 2.2));
}
