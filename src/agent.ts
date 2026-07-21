import type { AgentEvent, AgentTodoItem, ModelConfig, PermissionMode, RequestComponentUsage, StepUsage } from "./types.js";
import type { ChapterSceneDraft } from "./scene_pipeline.js";
import { documentSpans } from "./document_spans.js";
import { documentKind, isScenePipelineDocument, resolveOutlineSourcePath, WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { OutlineStore } from "./outline.js";
import { logModelRequest, logModelResponse } from "./model_debug.js";
import { proseMannerismPreflightLine } from "./prose_quality.js";
import { dynamicStyleGroundingPrompt, isIntensiveWritingMode, stableStyleGroundingPrompt } from "./style_grounding.js";
import { calculateUsageCost } from "./pricing.js";
import { buildRecordedUsageEvent } from "./model_usage.js";
import { modelFetch } from "./model_fetch.js";
import { isDeepSeekModel, thinkingRequestOptions } from "./model_compat.js";
import {
  DEFAULT_SCENE_NOTES_CHARACTERS,
  formatTodosForPrompt,
  loadAgentSettings,
  permissionModeLabel,
  persistAdvancedTodosAfterProposal,
  persistFinalizedSessionTodos,
  persistScenePipelineTodos,
  projectInstructionsPrompt,
  skillsCatalogPrompt,
  type ScenePipelineSettings,
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
  type ToolCall,
  type ToolExecutionContext,
  type ToolDefinition,
} from "./tools/index.js";

type ApiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ApiToolCall[];
  reasoning_content?: string;
};

type ApiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export { agentToolNames, agentToolSchemaHash, agentToolsForTask } from "./tools/index.js";

/**
 * =============================================================================
 * PROMPT / PREFIX-CACHE CONTRACT (read before editing any agent prompt)
 * =============================================================================
 * Providers (e.g. DeepSeek) bill cache hits far cheaper than misses. Hits require
 * a byte-stable longest common prefix on the request. Follow these rules whenever
 * you add or rewrite prompts, system slots, tools, or message assembly:
 *
 * 1) MESSAGE ORDER — stable first, dynamic last
 *    [buildStableSystemPrefix: 6 fixed system slots]
 *    [buildDynamicTurnMessages: 8 fixed system slots + 1 user]
 *    [assistant / tool turns appended during the job]
 *    Never insert optional system messages *between* stable slots; use the
 *    existing placeholder text when a block is empty so slot indices never shift.
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
 * 3) DYNAMIC TAIL (always miss-priced — keep short)
 *    history preview, archive stats, task/dynamicContext (+ audit REVIEW when needed),
 *    dynamic style evidence (范文/章节样本), bootstrap index, todos, work-memory
 *    catalog, user selection, current user. Prefer digests / ids / paths; full
 *    prose belongs in tool results or read_conversation paging, not auto-injection.
 *
 * 4) APPEND-ONLY WITHIN ONE runAgent JOB
 *    After the first streamCompletion, do not mutate earlier messages (no mid-job
 *    compactRuntimeMessages / rehydrate / stripStaleReasoning / compactCompletedToolCalls).
 *    Compactors are only for rebuilding a transcript outside an active job.
 *    Sole exceptions — boundary truncations (never rewrites, so the surviving
 *    prefix still cache-hits):
 *    a) Chapter boundary: after a successful proposal with further writing steps,
 *       truncate back to the initial stable+dynamic prefix and append one compact
 *       handoff (chapterContinuationPrompt), so the next chapter stops paying the
 *       previous chapter's scene transcript every step.
 *    b) Scene boundary: after each successful write_chapter_scene, truncate back
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
 *
 * 5) TOOLS SCHEMA
 *    src/tools/schema.ts TOOLS is the stable catalog. After the tool-free planner,
 *    select one project-agnostic task profile and freeze it for the entire job.
 *    Profiles preserve catalog order and never contain live paths/ids/state.
 *
 * 6) PLANNER
 *    planWritingTask is a small, tool-free Flash call. It does not pretend to
 *    warm execution: provider measurements show planner/execution diverge before
 *    the tools payload, so attaching 36 tools only adds miss-priced input/output.
 *
 * 7) DEDUPE
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

type WritingTaskMode = "brainstorm" | "outline" | "write_scene" | "rewrite" | "audit" | "character" | "simple_character" | "general";
type DocumentContextMode = "none" | "search" | "target" | "continuation";
type CreativeDepth = "explore" | "shape" | "deliver";
type EditScope = "point" | "section" | "document";
type AgentRoleModels = Partial<Record<"agent" | "inline" | "writer" | "reviewer" | "summarizer", ModelConfig>>;

interface WritingTask {
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
      const key = name === "propose_document" && paramName === "payload" ? "content" : paramName;
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

分区：lore/=设定事实；outline/=情节计划；chapters/=主线正文；side/=支线；archive/=旧稿（非现行事实）；characters/=结构化角色卡。旧 story/ ≡ lore/。

正文底线（正文/续写/改写/终审；构思可大胆但须标明非既有事实）：
1. 用动作、选择、代价、对白与感官呈现；勿在其后追加情绪/象征解释。
2. 动作有结果；因果可拆句；保留对白拖音/中断/迟疑。
3. 对白服从身份与目的；场景落在动作、决定、发现或未决问题上。
4. 不得把未支撑设定冒充既有事实；区分项目事实 / 推断 / 候选。
5. 角色演进须有正文/大纲/用户依据。待批准文本→提案 characterChanges；已确认事实→apply_character_changes。伏笔/传闻/失败尝试不得解锁。新建或大改用 save_character。
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
    ? "3. plan：只检索/构思/塑形；禁止 propose_*（含 propose_change_set）/ save_character / apply_character_changes / save_simple_character。默认短而开放，勿自动扩成完整交付。"
    : mode === "auto"
      ? "3. auto：正文/续写/改写必须提案（自动落盘），禁止用最终回复代替正文。清单若仍有未完成的章节/正文步骤则继续写并再次提案；仅当清单无后续写作项时停止。"
      : "3. 正文/续写/改写必须提案，禁止用最终回复代替。清单若仍有未完成的章节/正文步骤则继续写并再次提案；仅当清单无后续写作项时停止等待审批。";
  return `执行规则：
1. 需项目事实时先 search_project（lore/outline/chapters），再读最小片段；每轮最多搜索 2 次。区分事实与推测。
2. 保持人物/世界观/视角与 Markdown。局部→补丁；大纲节点→大纲补丁；新建或全文重写→完整文档。设定→lore/，大纲→outline/，正文→chapters/。
${modeRule}
4. 完整/长对话或扮演史：注入历史仅为预览。须 inspect_conversation，再 read_conversation 从 afterId=0 分页至 hasMore=false。简易卡用 list/get_simple_characters，与普通卡分离。
5. 仅当缺少目标文档/关键事实且无法推断时 ask_user；可逆创作选择自行决定。询问后立即停止。
6. 情节演进→apply_character_changes；新建/大改→save_character；简易卡→save_simple_character。改已有普通卡必传 id。路人配角可只写正文不建卡。
7. 只复用本轮工作记忆、本轮工具结果与 reused 标记；禁止同路径反复读、禁止重复 list_outline_nodes。写作线索未验证；大纲 id 为 UUID。artifact_compacted 只用 digest。
8. 内置章节场景四阶段由工具结果自动推进，禁止为勾选这些阶段单独调用 manage_todos；仅自定义清单需要更新。同时至多一项 in_progress。
9. 技能目录有匹配且必要时先 load_skill；勿编造技能。
10. resource/ 内纯文本工作区：Markdown 继续用 document 工具；其他 UTF-8 文本用 list/inspect/read/search_files。创建、修改、移动、删除多个文件及其角色演进统一用 propose_change_set，禁止绕过审批直接改文件；路径只能在 resource/ 内。
11. 不泄露内部参数；对话简洁；文档适量 Markdown。
模式：${permissionModeLabel(mode)}`;
}

/**
 * Dynamic-tail task block (miss-priced every turn). Mode workflows + scope only.
 * CACHE: OK to be turn-specific; keep structuredCreativeContext slim (ids/fingerprints,
 * not full example bodies — those belong in dynamicStyleGroundingPrompt when intensive).
 */
function dynamicContextPrompt(project: WriterProject, store: WriterStore, request: string, task: WritingTask, permissionMode: PermissionMode, scenePipeline: ScenePipelineSettings, characterScope?: number[], continuationPath?: string, simpleCharacterScope?: number[]): string {
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
  const chapterSceneDelivery = task.mode === "write_scene"
    && (!task.targetPath || isScenePipelineDocument(task.targetPath));
  const documentInstruction = task.documentProposalRequired
    ? chapterSceneDelivery
      ? `必须用逐场景正文草稿完成并 propose_chapter_draft；章节与 side/ 支线片段都禁止直接 propose_document/patch 或用最终回复代替正文。${continuationPath ? `承接续写默认目标：${continuationPath}。` : ""}`
      : `必须提交文档提案或 change set 后结束；禁止用最终回复代替文件交付。单文档优先 patch；多文件/移动/删除/角色联动用 propose_change_set。工作记忆已有目标原文且未变时可直接提案。${continuationPath ? `承接续写默认目标：${continuationPath}。` : ""}`
    : "不强制文档提案；文件管理任务按需使用 propose_change_set，按用户意图执行。";
  const editScopeInstruction: Record<EditScope, string> = {
    point: "局部修改：有原句/选区就优先 locate/read 锚点；根据修改所需事实按需补读上下文，并用 sourceHash+anchorId+spanHash 提交 patch。",
    section: "分节修改：按标题或语义 locate，读取目标锚点范围与必要接缝；只 patch 命中范围，不读取无关章节。",
    document: "通篇修改：inspect 一次取得 sourceHash 后调用 revise_document_isolated；主 Agent 不逐块读取全文，也不自行拼接完整 content。",
  };
  const contextInstruction: Record<DocumentContextMode, string> = {
    // Soft none: pure craft may skip tools, but never invent lore when the user names project entities.
    none: "默认不读文档。泛化技巧/闲聊可直接答；若用户点名项目专名、组织、势力、世界观实体，且历史未给出可核对事实，先 search_project（优先 scope=lore），再按结果读取必要资料。禁止把推测写成既有设定。",
    search: task.mode === "simple_character"
      ? `建简易卡：先 list_characters 查同名，必要时 get_character；search_project(lore/outline) 查询：${task.searchQuery || request.slice(0, 120)}；不足再 inspect/read 最小片段；最后 save_simple_character。`
      : task.mode === "character"
        ? `处理普通角色卡：先 list_characters 查同名；已有同名卡必须 get_character 后携带原 id 更新，禁止另建简易卡或同名普通卡。按需 search_project(lore/outline)：${task.searchQuery || request.slice(0, 120)}；只读最小必要资料。`
      : `先 search_project（设定/组织/专名优先 scope=lore）：${task.searchQuery || request.slice(0, 120)}。不足再 inspect/read；同路径只读一次最小范围。不得用推测冒充项目事实。`,
    target: `需目标文档。${references.length ? `候选：${references.join("、")}。` : "先定位路径。"}记忆已有且未变则复用；否则 inspect 一次 + read 一次，禁止重复读。`,
    continuation: `承接正文。${continuationPath ? `目标：${continuationPath}。` : "从对话/提案确定路径。"}记忆有末尾且未变则续写；否则 inspect 一次 + read(lastSection=true)。`,
  };
  const reviewBlock = task.mode === "audit" ? `\n\n${REVIEW_PROMPT}` : "";
  return `当前任务：${task.label}
本轮只执行最后一条 user 请求；历史仅用于指代与既有事实。仅下方「@ 明确引用」可称用户指定；规划器/会话推断不得冒充用户选择。

${taskInstructions(
    task.mode,
    task.creativeDepth,
    permissionMode,
    task.documentProposalRequired,
    scenePipeline.isolatedWriter,
    scenePipeline.notesMaxCharacters,
  )}${reviewBlock}

上下文：${contextInstruction[task.documentContext]}
角色范围：${characterScopeInstruction}
简易卡范围：${simpleCharacterScopeInstruction}
写入：${documentInstruction}
修改范围：${editScopeInstruction[task.editScope]}
场景链参数：推荐 ${scenePipeline.preferredMinScenes}—${scenePipeline.preferredMaxScenes} 场；允许最多 ${scenePipeline.maxScenes} 场。按情节需要取值，不为达到推荐数拆场。正文生成：${scenePipeline.isolatedWriter ? "隔离 Writer 实验已启用" : "标准 Agent 内生成"}。

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
): Promise<{
  arguments?: string;
  usage?: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; estimated?: boolean };
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
  task: Pick<WritingTask, "mode" | "documentProposalRequired">,
  models: AgentRoleModels,
  fallback: ModelConfig,
): ModelConfig {
  if (task.mode === "audit") return models.reviewer ?? fallback;
  if (task.mode === "rewrite") return models.inline ?? fallback;
  // Scene isolation changes how prose is produced, never which model orchestrates tools.
  return fallback;
}

export function executionModelForStep(
  taskMode: WritingTaskMode,
  agentModel: ModelConfig,
  writerModel: ModelConfig | undefined,
  isolatedWriter: boolean,
  draft?: Pick<ChapterSceneDraft, "scenes" | "completed">,
): ModelConfig {
  if (taskMode === "write_scene" && !isolatedWriter && draft
    && draft.completed.length < draft.scenes.length) {
    return writerModel ?? agentModel;
  }
  return agentModel;
}

function isChapterSceneWriteTool(name: string): boolean {
  return name === "write_chapter_scene";
}

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
 * Task planner: a compact tool-free call, normally assigned to Flash.
 * CACHE: Keep stable rules in the first message and project/request data in the
 * final user message. Execution has a different prefix and is not warmed here.
 */
async function planWritingTask(
  model: ModelConfig, project: WriterProject, store: WriterStore, request: string, history: ApiMessage[], signal?: AbortSignal,
  characterScope?: number[],
  selectionCharacters = 0,
  onUsage?: (usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; estimated?: boolean }, retry: boolean) => void,
): Promise<{ task: WritingTask }> {
  const allDocuments = project.listDocuments().filter(path => !project.isDocumentHidden(path));
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
    .filter(item => !item.title.startsWith("[风格模板]") || item.title === `[风格模板] ${activeStyle?.name}`)
    .map(item => ({ id: item.id, title: item.title, category: item.category }))
    .slice(0, 24);
  const recent = history.slice(-3).map(item => item.role === "user"
    ? { content: item.content?.slice(0, 160) ?? "" }
    : { role: item.role, content: item.content?.slice(0, 120) ?? "" });
  const planningMessages: ApiMessage[] = [{
    role: "system",
    // CACHE: stable planner rules only — no documents/characters/history here.
    content: `写作任务规划器。不得调用工具；只输出一个 JSON，无 Markdown。
JSON 总长度不超过 1200 字符；字符串保持简短，todoPlan 每项不超过 40 字。
字段：mode(brainstorm|outline|write_scene|rewrite|audit|character|simple_character|general)；creativeDepth(explore|shape|deliver)；editScope(point|section|document)；documentContext(none|search|target|continuation)；targetPath(从目录原样选或省略)；searchQuery(search 时短查询，优先专名)；characterIds(最多4，否则[])；exampleIds(最多2，否则[])；documentProposalRequired(创作/修改正文或大纲为 true；纯讨论/分析/角色卡操作为 false)；continuation；todoPlan(2—5 步或[])。
creativeDepth=对话交付深度：explore 开放；shape 少量方向；deliver 用户明确要求完整成品。写文件完整度由 documentProposalRequired 决定。
documentContext 判定（关键，勿默认 none）：
- none：仅泛化写作技巧、闲聊、纯灵感且不依赖项目既有专名/组织/势力/世界观事实；或所需事实已完整出现在 recentHistory。
- search：用户讨论、分析、推演项目内设定/组织/实体/专名/关系/军政势力，或答案正确性依赖 lore/outline 中未在对话里写清的事实（即使 mode=brainstorm/general 也要用 search）。searchQuery 填核心专名。
- target：用户指定或语义可确定单篇文档要读/改。
- continuation：承接上一轮正文续写。
纯文本文件管理：用户要求创建、修改、移动、删除 resource/ 内文件或多文件原子变更时，mode=general、documentProposalRequired=true；非 Markdown 文件不必出现在 documents 目录，执行阶段先用 list_files 定位，再用 propose_change_set。
原则：按语义与产物判断。用户说“角色卡”时默认普通角色卡→character+search；只有明确说“简易角色卡/简易角色/简易卡”才用 simple_character+search。更新已有角色时 characterIds 必须包含目录中的目标 ID，禁止因资料为空而另建同名卡。当前 user 唯一任务；历史只解指代。指定单篇→target；承接正文→continuation。多阶段才填 todoPlan。不要因为“只是讨论”就 none——讨论项目设定仍须 search。
用户要求创作/设计一个具体人物，并主要描述其身份、外貌、性格、能力或关系时，即使没有说“角色卡”，也使用 character；只有明确要求“一段/片段/场景/章节/正文”来表现该人物时才使用 write_scene。
正文与大纲必须严格区分：用户要求“写/创建/生成/续写第N章、某一章、一个场景或正文”时，一律优先 mode=write_scene，documentProposalRequired=true；即使项目没有大纲，也不得改判为 outline。提到“第一章”不等于要求规划后续章节。
用户引用具体正文句段并指出问题或要求修改（不合理/OOC/改掉这句/换个说法等）时，一律 mode=rewrite，documentProposalRequired=true，documentContext=target；不得判为 audit（audit 只用于“审阅/检查/评价”而不动笔），也不得因目标是章节而改判 write_scene。
editScope 仅描述既有文档修改范围：明确原句/网页选区/一小处→point；一个小节或若干相邻段→section；明确通篇/全文/整体统一调整且每部分都需处理→document。不要把“深度修改某一处”误判为document。
只有用户明确要求“大纲、卷纲、全书规划、章节表、后续各章安排”时才用 mode=outline。单章正文任务的 todoPlan 只能覆盖该章，禁止自行加入创建全书大纲、规划其他章节或一次写多章。
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
  let result = await streamCompletion(model, planningMessages, signal, () => undefined, () => undefined, plannerRequestOptions);
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
    const retry = await streamCompletion(model, repairMessages, signal, () => undefined, () => undefined, plannerRequestOptions);
    if (retry.usage) onUsage?.(retry.usage, true);
    parsed = parsePlannerJson(retry.content);
    if (!parsed) {
      throw new Error(`任务规划器连续两次没有返回有效 JSON（首次 finish=${result.finishReason ?? "unknown"}、${result.content.length} 字符；重试 finish=${retry.finishReason ?? "unknown"}、${retry.content.length} 字符）`);
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
  // Character cards are persisted by save_character/save_simple_character, not document proposals.
  // Treat contradictory planner JSON as invalid instead of forcing a second, unrelated artifact.
  const documentProposalRequired = normalizeDocumentProposalRequired(mode, parsed.documentProposalRequired === true);
  const depths: CreativeDepth[] = ["explore", "shape", "deliver"];
  const creativeDepth = depths.includes(parsed.creativeDepth as CreativeDepth)
    ? parsed.creativeDepth as CreativeDepth
    : documentProposalRequired ? "shape" : "explore";
  const editScopes: EditScope[] = ["point", "section", "document"];
  const inferredEditScope: EditScope = selectionCharacters > 0
    ? "point"
    : /(?:通篇|全文|整篇|整体统一|从头到尾)/u.test(request)
      ? "document"
      : /[“「『"]|(?:这句|这一句|这段话|一小处|错别字|改个词)/u.test(request)
        ? "point"
        : "section";
  const editScope: EditScope = mode === "rewrite"
    ? selectionCharacters > 0
      ? "point"
      : editScopes.includes(parsed.editScope as EditScope) ? parsed.editScope as EditScope : inferredEditScope
    : "section";
  let normalizedDocumentContext: DocumentContextMode = mode === "simple_character" || mode === "character"
    ? "search"
    : continuation
    ? "continuation"
    : documentProposalRequired && documentContext === "none" ? "target" : documentContext;
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
      [request, ...(continuation ? [...recent].reverse().map(item => item.content) : [])],
    );
  return {
    task: {
      mode,
      label: TASK_LABELS[mode],
      searchQuery,
      characterIds: selectedCharacterIds,
      exampleIds: Array.isArray(parsed.exampleIds) ? parsed.exampleIds.filter(id => validExampleIds.has(id)).slice(0, 2) : [],
      documentContext: normalizedDocumentContext,
      creativeDepth,
      editScope,
      documentProposalRequired,
      continuation,
      todoPlan: requestedTodoPlan.length ? requestedTodoPlan : defaultTodoPlan(mode, documentProposalRequired),
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
  if (mode === "write_scene") return ["核对本篇必要事实与衔接", "建立初始场景引导", "按成稿结果推进正文", "全文审阅并提交提案"];
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
  isolatedWriter = false,
  notesMaxCharacters = DEFAULT_SCENE_NOTES_CHARACTERS,
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
- 这是普通角色卡任务。先 list_characters 检查同名卡；若已存在，必须 get_character 读取必要分区，并用其 id 调用 save_character 或 apply_character_changes 更新。
- 不要调用 save_simple_character；不得因现有卡内容为空、简略或不完整而新建同名角色。
- 新建或大改用 save_character；有依据的情节演进优先 apply_character_changes。只填写用户提供或项目材料支持的内容，未知处留空。
- 更新已有卡时保留原 id，优先只提交实际修改的分区；需要核对关联信息时可以继续读取相关分区或项目资料。数组条目沿用已有 ASCII id，新增条目提供唯一 ASCII id。
- 新角色应提交完整的核心设定；若工具返回结构化错误，按错误修正后继续重试，保存成功后再结束。`;
  if (mode === "simple_character") return `本次工作流：
- 这是简易角色卡任务，不要调用 save_character 创建普通角色卡；最终调用 save_simple_character 保存。
- 先调用 list_characters 检查同名或相关普通角色卡；若存在相关角色，用 get_character 读取必要分区。
- 按上下文决策检索相关 lore/ 与 outline/，只读取最小必要片段。
- 将项目事实压缩为 name、identity、relationship、knowledge、scene、goal 六个字段；不确定处留空或标为“未明确”。可按需继续检查同名角色和项目资料，工具报错时修正后继续保存。`;
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
- 修改既有节点用 propose_outline_patch；新建或大幅重构写入 outline/，不得写入 chapters/ 或 lore/。
- 落盘字段仅使用：摘要、前因、行动、结果、状态变化、角色ID、地点、时间、情节线、伏笔、回收、状态、文档、正文章节。`;
  if (mode === "write_scene") return `工作流（内部执行，不输出分析过程）：
1. 对齐「风格锚定」+ 动态声线证据；禁止通用腔。
2. 大纲不是章节写作的前置条件。只有系统已给出与本章精确匹配的 outlineNode ID，或用户明确指定某个大纲节点时，才 get_outline_node 一次；没有对应大纲就直接依据用户要求、必要设定和衔接写作，禁止创建/扩写大纲来“补准备”。衔接上一章优先 inspect_document 看 ending，或 read 末 1 节/末约 800–1500 字；禁止通读上一章全文。出场且可能转折的角色可 get_character。unlocked=false 的能力不可用，也不得写成卡面播报。
3. 单个正文任务只交付用户指定的章节或支线片段：禁止 design_creative_outline、禁止 propose 任何 outline、禁止规划或创建其他章节；禁止通读整本大纲、list_outline_nodes>1、同路径反复 read。
4. 目标为 chapters/ 的完整章节或 side/ 的支线片段时，先用 1—3 句话确定“全文从什么局面走到什么局面”，随后调用 begin_chapter_draft 建立初始 scene guide。guide 只提供下一步方向，不是预先锁死的正文提纲；支线片段初始引导遵守当前推荐场数，每场 targetCharacters 不低于 2000，不为凑数拆场。
5. ${isolatedWriter
    ? `每次 write_chapter_scene 只处理当前一场：根据真实上一场结尾、actualState 与当前创作判断，提交不超过 ${notesMaxCharacters} 字的故事内 notes；不要生成 content 或 actualState，工具会用隔离 Writer 写正文并从成稿提取状态。`
    : `每次 write_chapter_scene 只处理当前一场：根据真实上一场结尾、actualState 与当前创作判断提交要点式故事内 notes（上限 ${notesMaxCharacters} 字）、正文与 actualState。正文不要包含 markdown 标题；actualState 必须从实际正文归纳，不得照抄 guide。`}每场完成后先判断实际结果：若原引导仍自然就继续；若人物选择、因果或节奏已经偏移，用 revise_chapter_scene_guide 一次性替换全部未写引导；若章节目标已自然抵达，将 remainingScenes 置空后进入终审。不要为了显示“Agent 感”频繁改计划，也不要为了服从旧 guide 扭曲成稿。改变既有事件、事实或离场状态时才重写前场；禁止为句式问题重写整场，纯句式修订用 revise_chapter_draft_style。相邻逐字复读由工具自动删重；styleDeferred 留到全文门禁精确修订。${isolatedWriter ? "隔离模式不把风格统计写进下一场 notes。" : "stylePriorNotes/styleFeedback 只用于抑制正文自我复读。"}
6. 笔记、writePack 与正文禁止写章节名指称、路径、大纲/草案/工具 JSON/分区名；回忆用故事内锚点。对白区分人物；冲突/情欲/暴力按剧情直写。每场提交前：${proseMannerismPreflightLine()}
7. 当 Agent 根据实际正文判断章节已经完成，确保没有未写 scene guide（必要时先 revise_chapter_scene_guide 清空），再调用 inspect_chapter_draft，并在同一调用提交 proposal summary 与已确认的 characterChanges。工具会对组装全文执行风格门禁、必要的隔离局部修复与结构终审；通过后直接创建提案。若返回 blocker，只修正有证据的问题，禁止为查看门禁结果反复 inspect。
8. 完整章节与 side/ 支线片段由 inspect_chapter_draft 终审通过后一次性提交；propose_chapter_draft 仅用于隔离终审回退或提案参数失败后的兼容重试。禁止 propose_document/patch 绕过场景链（例外：仅修正已有正文的少量句段、总替换 ≤1500 字时，可直接 propose_document_patch）。清单仍有后续正文时继续下一项并重新 begin。仅正文兑现的能力可进 characterChanges；已确认事实才 apply_character_changes。`;
  if (mode === "rewrite") return `工作流（内部执行）：
- 定位用户引用的原句：locate_document_span/read_document 传 path+quote；模糊描述用 locate_document_span(query) 隔离语义定位，再按需读取锚点及关联上下文。
- 对齐风格锚定与原文声线；只改作者要求的维度，其余事实/动机/信息序不变。
- 若改动依赖大纲/设定核对：先读最小片段，将约束整理后 compile_write_pack，再据 writePack 改写。
- 风格变化落到叙述距离、句长、对白比、感官与信息释放，勿同义替换或无故含蓄化。
- 正文禁止文档元指称（序章里/第N章里/大纲里/路径）。point/section 用 sourceHash+anchorId+spanHash 提交最小 patch；只有 editScope=document 才 inspect 一次后调用 revise_document_isolated，禁止主 Agent 通读和拼接全文。人设变化进提案 characterChanges。提交前：${proseMannerismPreflightLine()}`;
  if (mode === "audit") return `工作流：
- 先 audit_prose_style；优先 severity=error。
- 每条问题含严重度、原文证据、违反约束、最小改法；无证据不提。
- ${documentProposalRequired ? "要求修复：用 read_document 的 quote 参数定位证据句，只改有证据处，用 propose_document_patch 最小提案。" : "只检查：不提案，只输出审阅结论。"}`;
  return documentProposalRequired
    ? "文件交付任务：先用 document 或 file 工具读取最小必要原文；多文件、移动、删除或角色联动必须用 propose_change_set 统一提交，禁止直接改盘。"
    : "先判断构思/规划/写作/改写/审校再执行。改正文须先读原文并提案；待批准变化→characterChanges；已确认→apply_character_changes。";
}

function structuredCreativeContext(store: WriterStore, task: WritingTask, characterScope?: number[], simpleCharacterScope?: number[]): string {
  const rankedCharacters = store.characters().map((item) => ({
    item, score: task.characterIds.includes(item.id) ? 1 : 0,
  })).sort((a, b) => b.score - a.score || a.item.identity.name.localeCompare(b.item.identity.name, "zh-CN"));
  const scopedIds = characterScope === undefined ? undefined : new Set(characterScope);
  const selectedCharacters = scopedIds
    ? rankedCharacters.filter(entry => scopedIds.has(entry.item.id))
    : rankedCharacters.filter((entry) => entry.score > 0).slice(0, 4);
  const characters = selectedCharacters.map(({ item }) => ({
    id: item.id, name: item.identity.name, aliases: item.identity.aliases, narrativeRole: item.identity.narrativeRole, identity: item.identity.summary,
  }));
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
  const rankedExamples = store.writingExamples().map((item) => {
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
  const available = new Set(project.listDocuments().filter(path => !project.isDocumentHidden(path)));
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
      const content = (message.content ?? "").replace(/\s+/g, " ").slice(0, 80);
      return `${channel}${label}: ${content}`;
    }).join("\n").slice(-800)
    : "";
  const entries = recent.map(message => {
    const limit = message.role === "user" ? 200 : 140;
    const content = (message.content ?? "").replace(/\s+/g, " ").slice(0, limit);
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

/** Prefer chapters/outline/lore and request-mentioned paths; cap planner user payload. */
function prioritizeDocumentCatalog(documents: string[], request: string, limit: number): string[] {
  if (documents.length <= limit) return documents;
  const mentioned = new Set(
    [...request.matchAll(/(?:^|[\s@])((?:lore|outline|chapters|side|archive|story)\/[^\s，。；、]+)/g)]
      .map(match => match[1].replace(/[，。；：,.!?！？]+$/, "")),
  );
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
  proposal?: { path: string; summary: string; afterContent: string };
  handoff?: CompletedChapterHandoff;
  isolatedWriter?: boolean;
}): string {
  const lines: string[] = [
    "上一份文档提案已成功提交，禁止重复提交同一章；为控制上下文，此前章节的场景写作过程已从本轮对话移除。",
  ];
  if (parts.proposal) {
    lines.push(`已交付：${parts.proposal.path} — ${parts.proposal.summary.replace(/\s+/g, " ").slice(0, 200)}`);
    const tail = parts.proposal.afterContent.trimEnd().slice(-800).trimStart();
    if (tail) lines.push(`上一章结尾（仅供衔接语气与局面，禁止重复叙述）：\n…${tail}`);
  }
  if (parts.handoff?.finalActualState) {
    lines.push(`上一章末场 actualState（人物与局面现状，续写以此为准）：${JSON.stringify(parts.handoff.finalActualState)}`);
  }
  lines.push(
    `任务清单仍有未完成的写作步骤，请立即继续下一项：完整章节先 begin_chapter_draft 建立初始 scene guide，再依据每场实际结果自主推进或调整未写引导，整章 inspect 后一次性提案；缺少事实时先做最小读取补齐，不要重读已交付章节全文。`,
    parts.todosText,
  );
  return lines.join("\n");
}

/**
 * Scene-boundary handoff (contract §4b). After each successful write_chapter_scene
 * the loop truncates back to the post-begin context base and appends this single
 * message, so later scenes stop paying earlier scenes' full prose on every step.
 * It must therefore carry everything the next scene needs: the seam tail, each
 * scene's actual exit state, the next scene card and the anti-formula feedback.
 */
export function sceneContinuationPrompt(
  draft: ChapterSceneDraft,
  extras: { styleFeedback?: string[]; stylePriorNotes?: string[]; isolatedWriter?: boolean },
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
    lines.push(`styleFeedback（对已写正文的机器统计，写下一场必须遵守）：${extras.styleFeedback.join("；")}`);
  }
  if (next) {
    const submission = extras.isolatedWriter
      ? "在同一调用中只提交要点式 notes；隔离 Writer 会生成正文并独立提取 actualState"
      : "在同一调用中提交要点式 notes、正文与 actualState";
    lines.push(
      `当前 scene guide 的下一场：${JSON.stringify(next)}`,
      ...(remaining.length ? [`当前其后引导：${JSON.stringify(remaining)}`] : []),
      `先以真实结尾和 actualState 判断 guide 是否仍成立：成立则调用 write_chapter_scene（sceneId=${next.id}），${submission}；不成立则调用 revise_chapter_scene_guide 替换全部未写引导；章节目标已经抵达则清空 remainingScenes 后终审。不要输出计划说明或更新任务清单。`,
    );
  } else {
    lines.push("当前没有未写 scene guide。若章节目标已由实际正文完成，调用 inspect_chapter_draft 并同时提供提案 summary 与已确认的 characterChanges；若仍缺少必要变化，先 revise_chapter_scene_guide 增加下一场引导。");
  }
  return lines.join("\n");
}

export async function runAgent(options: {
  project: WriterProject;
  store: WriterStore;
  sessionId: string;
  prompt: string;
  variantGroupId?: string;
  /** Server-side job id used to correlate every provider call in model_usage. */
  jobId?: string;
  characterScope?: number[];
  simpleCharacterScope?: number[];
  selectedDocumentBlocks?: Array<{ path: string; text?: string }>;
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
  const { project, store, sessionId, prompt, signal } = options;
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
  const scenePipelineSettings = options.scenePipelineSettings ?? runtimeSettings.scenePipeline;
  emit({ type: "mode", mode: permissionMode });

  // 写作 Agent 可读全部通道；扮演试演会标注 channel=roleplay，供人设/对白参考。
  // 24 条足够规划器 + 历史预览；更早内容靠 inspect/read_conversation。
  const history = compactHistory(
    store.messages(sessionId, 24)
      .filter((message) => message.role !== "tool" && message.role !== "system")
      .map((message) => ({ role: message.role, content: message.content, channel: message.channel })),
  );
  const previousTaskState = store.sessionContext(sessionId);
  // Planning is classification/routing, not prose generation. Prefer the cheap
  // summarizer/Flash assignment and keep the request tool-free.
  const plannerModel = options.models?.summarizer ?? options.models?.inline ?? model;
  const planned = await planWritingTask(
    plannerModel, project, store, prompt, history, signal, characterScope,
    options.selectedDocumentBlocks?.reduce((sum, block) => sum + (block.text?.length ?? 0), 0) ?? 0,
    (usage, retry) => emitUsageEvent(
      emit, store, sessionId, plannerModel, usage, undefined,
      retry ? "planner_retry" : "planner", options.jobId,
    ),
  );
  const task = planned.task;
  // plan 模式下即使规划器要求提案，也不强制写入，避免与权限冲突
  if (permissionMode === "plan") task.documentProposalRequired = false;
  const executionModel = executionModelForTask(
    task,
    options.models ?? {},
    model,
  );
  // Build execution prefix and tool profile once, then reuse both byte-for-byte
  // for every step in this job. Profiles are stable and project-agnostic.
  const stableSystemPrefix = buildStableSystemPrefix(
    project, store, permissionMode, { intensive: false }, "general",
  );
  const executionTools = agentToolsForTask(task.mode, permissionMode);
  const executionToolNames = new Set(executionTools.map(tool => tool.function.name));
  // Task state binds to the current dialogue, not the session shell.
  // - continuation: reuse prior active doc / todos / tool memory
  // - same mode without continuation: keep todos (multi-turn ask_user etc.), but never sticky-inherit a doc via COALESCE
  // - mode change without continuation: drop prior task residue entirely
  const previousMode = previousTaskState.currentIntent.split(":")[0]?.trim() ?? "";
  const continuationPath = task.continuation
    ? task.targetPath ?? previousTaskState.activeDocument ?? store.proposals().find(proposal => proposal.sessionId === sessionId)?.path
    : undefined;
  if (!task.continuation && previousMode !== task.mode) {
    store.clearSessionTaskState(sessionId);
  }
  // A fresh request in the same mode may keep its todo list, but must never
  // inherit an unfinished server-side draft unless the planner marked it as a continuation.
  if (!task.continuation) store.clearAgentCheckpoint(sessionId);
  const activeDocument = task.targetPath ?? continuationPath;
  store.saveSessionContext(sessionId, {
    activeDocument,
    currentIntent: `${task.mode}: ${prompt.slice(0, 240)}`,
  });
  let turnTodos = store.sessionTodos(sessionId);
  if (!turnTodos.length && task.todoPlan.length) {
    turnTodos = initialTodos(task.todoPlan);
    store.saveSessionTodos(sessionId, turnTodos);
  }
  emit({ type: "todos", todos: turnTodos });
  store.addMessage(sessionId, "user", prompt, "agent", options.variantGroupId);
  const archiveContext = `会话归档元数据（注入历史仅为预览；完整史用 inspect/read_conversation）：${JSON.stringify(store.conversationStats(sessionId))}`;
  const selectedContext = selectedBlocksContext(project, options.selectedDocumentBlocks);
  const historyText = historicalConversationContext(history);
  const artifactContext = recentArtifactsContext(store, sessionId, project, task);
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
  };
  // In isolated-writer mode the Agent only prepares a compact scene packet; raw
  // voice evidence belongs exclusively to the prose-only call.
  const dynamicStyleContext = scenePipelineSettings.isolatedWriter && task.mode === "write_scene"
    ? ""
    : dynamicStyleGroundingPrompt(project, store, styleOptions);
  // Prefer cheap roles for prose snippet second pass (flash-class models).
  const adjudicatorModel = options.models?.inline
    ?? options.models?.summarizer
    ?? options.models?.reviewer
    ?? model;
  const chapterReviewContext = [
    projectInstructionsPrompt(project),
    structuredCreativeContext(store, task, characterScope, simpleCharacterScope),
  ].filter((value): value is string => Boolean(value?.trim())).join("\n\n");
  const restoredChapterDraft = task.mode === "write_scene" && task.continuation
    ? restoreChapterDraftCheckpoint(store, sessionId, project, task.targetPath ?? continuationPath)
    : undefined;
  const selectedEditLock = task.editScope === "point"
    ? selectedBlockEditLock(project, options.selectedDocumentBlocks)
    : undefined;
  let currentUsageStep: number | undefined;
  const toolContext: ToolExecutionContext = {
    permissionMode,
    editScope: task.editScope,
    ...(selectedEditLock ? { editTargetLocked: selectedEditLock } : {}),
    modelUsageReporter: (callModel, callUsage, meta) => {
      emit(buildRecordedUsageEvent(store, sessionId, callModel, callUsage, {
        ...meta,
        ...(meta.step === undefined && currentUsageStep !== undefined ? { step: currentUsageStep } : {}),
        ...(meta.jobId || !options.jobId ? {} : { jobId: options.jobId }),
      }));
    },
    readSnapshots: new Map(),
    readCharactersUsed: 0,
    simpleCharacterScope,
    requireCreativeOutlineDesign: task.mode === "outline" && task.documentProposalRequired,
    // write_scene delivery must compile diegetic materials before proposing prose.
    requireWritePack: permissionMode !== "plan" && task.mode === "write_scene" && task.documentProposalRequired,
    requireScenePipeline: permissionMode !== "plan" && task.mode === "write_scene" && task.documentProposalRequired,
    ...(restoredChapterDraft ? { chapterSceneDraft: restoredChapterDraft } : {}),
    scenePipelineSettings,
    proseAdjudicator: {
      model: adjudicatorModel,
      signal,
    },
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
      model: options.models?.writer ?? executionModel,
      ...((options.models?.writer ?? executionModel) !== executionModel
        ? { fallbackModel: executionModel }
        : {}),
      signal,
    },
    // Prefer the configured cheap reviewer for the isolated full-chapter read;
    // retain the writing model as a quality/compatibility fallback.
    chapterReviewer: {
      model: options.models?.reviewer ?? executionModel,
      ...(options.models?.reviewer && options.models.reviewer !== executionModel
        ? { fallbackModel: executionModel }
        : {}),
      signal,
      context: chapterReviewContext,
    },
    ...(scenePipelineSettings.isolatedWriter
      ? {
          isolatedSceneWriter: {
            model: options.models?.writer ?? executionModel,
            stateModel: options.models?.inline
              ?? options.models?.summarizer
              ?? options.models?.reviewer
              ?? model,
            signal,
          },
        }
      : {}),
    // Best-of-N scene sampling (experimental, off by default): rewrites use the
    // main writing model in a dedicated plain-text call, not the cheap adjudicator.
    ...(scenePipelineSettings && scenePipelineSettings.candidateCount > 1
      ? { sceneCandidates: { model, signal } }
      : {}),
  };
  // Assemble per PROMPT / PREFIX-CACHE CONTRACT (top of this file):
  // stable 6 + dynamic 9, then append-only tool loop. See buildStableSystemPrefix /
  // buildDynamicTurnMessages for slot maps when adding new prompt material.
  const messages: ApiMessage[] = [
    ...stableSystemPrefix,
    ...buildDynamicTurnMessages({
      historyText,
      archiveContext,
      taskContext: dynamicContextPrompt(project, store, prompt, task, permissionMode, scenePipelineSettings, characterScope, continuationPath, simpleCharacterScope),
      dynamicStyleContext: dynamicStyleContext || undefined,
      bootstrapContext: bootstrapContext || undefined,
      todosPrompt,
      artifactContext: artifactContext || undefined,
      selectedContext: selectedContext || undefined,
      prompt,
    }),
  ];
  // Multi-chapter boundary resets truncate back to exactly this prefix (see contract §4).
  const initialMessageCount = messages.length;
  // Scene-boundary resets truncate back here (§4b): advanced past prep reads when
  // begin_chapter_draft succeeds, so chapter facts survive while scene prose does not.
  let contextBase = initialMessageCount;
  let transcript = "";
  let documentProposalSubmitted = false;
  let characterMutationSubmitted = false;
  let characterMutationName = "";
  let lastCharacterMutationDiagnostic = "";
  let waitingForUser = false;
  const toolCallCounts = new Map<string, number>();
  const isCharacterTask = task.mode === "character" || task.mode === "simple_character";
  const requiresCharacterMutation = isCharacterTask && permissionMode !== "plan";

  try {
    // Multi-chapter plans need more steps (read + draft + reject/retry per chapter).
    const plannedSteps = Math.max(turnTodos.length, task.todoPlan.length);
    const turnLimit = options.maxTurns ?? Math.max(20, plannedSteps * 8);
    let turnStart = messages.length;
    // CACHE: append-only for the whole job — never rewrite prior message bodies
    // between steps (compact/rehydrate/strip would break step-to-step prefix hits).
    for (let turn = 0; turn < turnLimit; turn += 1) {
      const step = turn + 1;
      currentUsageStep = step;
      emit({ type: "step_start", step });
      const stepModel = executionModelForStep(
        task.mode,
        executionModel,
        options.models?.writer,
        scenePipelineSettings.isolatedWriter,
        toolContext.chapterSceneDraft,
      );
      const stepThinkingOptions = thinkingRequestOptions(stepModel);
      const requestComponents = buildRequestComponentUsage(messages, executionTools, 6, initialMessageCount);
      const result = await streamCompletion(stepModel, messages, signal, (text) => {
        transcript += text;
        emit({ type: "text", text, channel: "output" });
      }, (text) => emit({ type: "text", text, channel: "reasoning" }), {
        tools: executionTools,
        ...stepThinkingOptions,
      });
      const ensureThinkingTranscriptCanContinue = () => {
        if (isDeepSeekModel(stepModel) && "thinking" in stepThinkingOptions
          && stepThinkingOptions.thinking.type === "enabled"
          && !result.reasoningContent.trim()) {
          throw new Error(`DeepSeek Thinking 未返回 reasoning_content；当前结果已保留，但不能继续拼接下一次请求，请重试本任务${lastCharacterMutationDiagnostic ? `。本步工具诊断：${lastCharacterMutationDiagnostic}` : ""}`);
        }
      };
      if (result.usage) {
        emitUsageEvent(emit, store, sessionId, stepModel, result.usage, step, "agent_step", options.jobId, requestComponents);
      }
      if (!result.toolCalls.length) {
        emit({ type: "step_done", step });
        if (requiresCharacterMutation) {
          messages.push({
            role: "assistant",
            content: stripDsmlText(result.content || "", "[本步未调用保存工具]"),
            ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
          });
          messages.push({
            role: "user",
            content: task.mode === "simple_character"
              ? "本任务尚未保存简易角色卡。请根据已有资料调用 save_simple_character；如果还缺资料，可以继续读取后再保存。"
              : "本任务尚未保存普通角色卡。请继续完成必要读取，并调用 save_character 或 apply_character_changes；若工具返回错误，按结构化错误修正。",
          });
          ensureThinkingTranscriptCanContinue();
          continue;
        }
        if (task.documentProposalRequired) {
          messages.push({
            role: "assistant",
            content: stripDsmlText(result.content || "", "[本步未调用工具]"),
            ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
          });
          messages.push({
            // CACHE: user role — a mid-job system message flips DeepSeek's
            // whole-request rendering and forfeits the cached prefix (§4).
            role: "user",
            content: "当前任务要求实际提交文档提案，但尚未成功创建提案。请依据已有工具结果继续；若工具返回结构化错误，修正参数或补充必要读取后重试。",
          });
          ensureThinkingTranscriptCanContinue();
          continue;
        }
        const answer = stripDsmlText(transcript, "").trim() || "任务已处理。";
        store.addMessage(sessionId, "assistant", answer, "agent", options.variantGroupId);
        persistFinalizedSessionTodos(store, sessionId, emit);
        emit({ type: "done", sessionId });
        return;
      }

      turnStart = messages.length;
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
      let beginChapterSucceeded = false;
      let sceneWrittenFeedback: string[] | undefined;
      let chapterReviewInStep = false;
      let characterMutationFailedThisStep = false;
      for (const call of result.toolCalls) {
        let effectiveCall = call;
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
        let toolResult: string;
        if (!executionToolNames.has(call.name)) {
          toolResult = JSON.stringify({ error: `工具 ${call.name} 不在当前 ${task.mode} 任务的固定允许集中；请使用已提供的工具继续` });
        } else {
          toolResult = await executeToolCached(effectiveCall, project, store, sessionId, emit, toolCallCounts, characterScope, toolContext);
        }
        toolResult = boundToolResultForModel(effectiveCall, toolResult, project, store, sessionId);
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
          }
          if (!("error" in parsed) && call.name === "revise_chapter_scene_guide" && parsed.status === "guide_revised") {
            persistScenePipelineTodos(store, sessionId, parsed.complete === true ? "draft_complete" : "draft_reopened", emit);
          }
          if (!("error" in parsed) && isChapterSceneWriteTool(call.name)
            && (parsed.status === "written" || parsed.status === "revised")) {
            sceneWrittenFeedback = Array.isArray(parsed.styleFeedback)
              ? (parsed.styleFeedback as unknown[]).filter((item): item is string => typeof item === "string")
              : [];
          }
          if (!("error" in parsed) && call.name === "inspect_chapter_draft" && parsed.proposalSubmitted === true) {
            documentProposalSubmitted = true;
          }
        } catch { /* 非 JSON 工具结果不参与结构化里程碑推进。 */ }
        if (call.name === "inspect_chapter_draft" || call.name === "revise_chapter_draft_style" || call.name === "propose_chapter_draft") {
          // Same-step write→inspect/revise/propose: the review payload must survive,
          // so the scene-boundary reset below is skipped for this step.
          chapterReviewInStep = true;
        }
        if (call.name === "propose_document" || call.name === "propose_document_patch" || call.name === "revise_document_isolated" || call.name === "propose_chapter_draft" || call.name === "propose_outline_patch" || call.name === "propose_change_set") {
          try {
            const parsed = JSON.parse(toolResult) as Record<string, unknown>;
            if (!("error" in parsed)) documentProposalSubmitted = true;
          } catch { /* 无效工具结果不能视为已提交。 */ }
        }
        if (call.name === "ask_user") {
          try {
            const parsed = JSON.parse(toolResult) as Record<string, unknown>;
            if (parsed.status === "waiting") waitingForUser = true;
          } catch { /* 无效工具结果不能视为等待。 */ }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: toolResult });
      }
      emit({ type: "step_done", step });
      if (characterMutationSubmitted) {
        const answer = stripDsmlText(transcript, "").trim()
          || `${characterMutationName ? `“${characterMutationName}”` : "角色"}角色卡已保存。`;
        store.addMessage(sessionId, "assistant", answer, "agent", options.variantGroupId);
        persistFinalizedSessionTodos(store, sessionId, emit);
        emit({ type: "done", sessionId });
        return;
      }
      if (requiresCharacterMutation && characterMutationFailedThisStep) {
        messages.push({
          role: "user",
          content: `上一次角色卡保存失败。请根据结构化错误修正参数后继续；必要时可以重新读取相关角色或项目资料。错误：${lastCharacterMutationDiagnostic}`,
        });
      }
      // §4b anchor: keep prep reads + the scene chain lock inside the cached base.
      if (beginChapterSucceeded) contextBase = messages.length;
      if (sceneWrittenFeedback && toolContext.chapterSceneDraft && !chapterReviewInStep
        && !documentProposalSubmitted && !waitingForUser) {
        // Scene-boundary context reset: drop the finished scene's full prose (the
        // model's own tool arguments) from the request. The compact handoff below
        // carries seam tail + exit states; the prefix up to contextBase still
        // cache-hits. Skipped when begin+write landed in one step (contextBase
        // then already contains this scene — nothing older to drop).
        if (!beginChapterSucceeded) {
          messages.length = contextBase;
          messages.push({
            // CACHE: user role — a mid-job system message flips DeepSeek's
            // whole-request rendering and forfeits the cached prefix (§4).
            role: "user",
            content: sceneContinuationPrompt(toolContext.chapterSceneDraft, {
              styleFeedback: sceneWrittenFeedback,
              stylePriorNotes: toolContext.chapterStylePriorNotes,
              isolatedWriter: scenePipelineSettings.isolatedWriter,
            }),
          });
          turnStart = messages.length;
        }
        ensureThinkingTranscriptCanContinue();
        continue;
      }
      if (documentProposalSubmitted) {
        // Advance checklist: keep multi-chapter pending items open and continue the job.
        const advanced = persistAdvancedTodosAfterProposal(store, sessionId, emit);
        if (advanced.shouldContinue && !waitingForUser) {
          // Per-chapter context reset: drop the finished chapter's tool transcript
          // and restart from the byte-stable initial prefix (still a cache hit), so
          // the next chapter stops paying the previous chapter's prose on every step.
          const latestProposal = store.proposals().find(item => item.sessionId === sessionId);
          const handoff = toolContext.completedChapterHandoff;
          toolContext.completedChapterHandoff = undefined;
          messages.length = initialMessageCount;
          messages.push({
            // CACHE: user role — a mid-job system message flips DeepSeek's
            // whole-request rendering and forfeits the cached prefix (§4).
            role: "user",
            content: chapterContinuationPrompt({
              todosText: formatTodosForPrompt(advanced.todos),
              isolatedWriter: scenePipelineSettings.isolatedWriter,
              ...(latestProposal
                ? { proposal: { path: latestProposal.path, summary: latestProposal.summary, afterContent: latestProposal.afterContent } }
                : {}),
              ...(handoff ? { handoff } : {}),
            }),
          });
          turnStart = messages.length;
          // Next chapter's scene resets truncate to here until its begin succeeds.
          contextBase = messages.length;
          // Allow fresh reads/searches for the next chapter within the same job;
          // store-cached artifacts still short-circuit identical repeat reads.
          toolCallCounts.clear();
          toolContext.readSnapshots?.clear();
          toolContext.readCharactersUsed = 0;
          documentProposalSubmitted = false;
          // Each scene needs its own diegetic pack — do not reuse the previous chapter's.
          toolContext.writePackCompiled = false;
          toolContext.lastWritePack = undefined;
          toolContext.writePackSceneId = undefined;
          toolContext.chapterSceneDraft = undefined;
          // Per-chapter scene-gate state: voice evidence and prior notes.
          toolContext.sceneStyleEvidence = undefined;
          toolContext.isolatedSceneVoiceSample = undefined;
          toolContext.isolatedPendingScene = undefined;
          toolContext.chapterStylePriorNotes = undefined;
          // Style verdicts are per-chapter sentences; stale entries only waste lookups.
          toolContext.proseVerdictCache = undefined;
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
          if (msg.role === "assistant" && msg.content?.trim()) {
            assistantParts.push(msg.content.trim());
          }
        }
        for (let i = turnStart; i < messages.length; i++) {
          const msg = messages[i];
          if (msg.role !== "tool" || !msg.content) continue;
          try {
            const result = JSON.parse(msg.content) as Record<string, unknown>;
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
        if (assistantParts.length) store.addMessage(sessionId, "assistant", assistantParts.join("\n\n"), "agent", options.variantGroupId);
      } catch { /* 消息保存失败不影响流程 */ }
      if (waitingEvent) emit({ type: "waiting_for_input", sessionId, ...waitingEvent });
      return;
    }
    if (documentProposalSubmitted) {
      try {
        for (let i = turnStart; i < messages.length; i++) {
          const msg = messages[i];
          if (msg.role === "assistant" && msg.content?.trim()) {
            store.addMessage(sessionId, "assistant", msg.content.trim(), "agent", options.variantGroupId);
          }
        }
      } catch { /* 消息保存失败不影响流程 */ }
      // Last proposal with no further writing steps — checklist already advanced.
      emit({ type: "done", sessionId });
      return;
    }
    const debugContext = runtimeDebugContext(messages, {
      task: task.label,
      model: executionModel.model,
      turns: turnLimit,
      transcript,
    });
    store.addSystemMessage(sessionId, debugContext);
    throw new Error("Agent 模型执行轮次达到上限；中途上下文已保存到当前会话");
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      if (transcript.trim()) store.addMessage(sessionId, "assistant", `${transcript.trim()}\n\n[生成已中断]`, "agent", options.variantGroupId);
      emit({ type: "cancelled", sessionId });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      store.addSystemMessage(sessionId, "Agent 任务异常结束：" + message);
    } catch { /* 错误持久化失败不遮蔽原始错误。 */ }
    emit({ type: "error", message });
    throw error;
  }
}

/**
 * Audit-only policy (injected into dynamic task block — not stable slot 5).
 * CACHE: Keeping this out of the stable prefix lets write↔audit turns share slots 0–5.
 */
const REVIEW_PROMPT = `终审专则：降低机器生成感，不是换成另一种统一腔调。
先 audit_prose_style；优先 error；warning 仅明显模板化时改；info 保留。
保留：对白拖音/中断/迟疑、对话纠正、停顿—揭示、短同位。见破折号就删是错。
查：模板转折、动作后解释回声、说明性破折号与抽象「不是…而是」、标签化人物、空泛排比、过匀句段、段尾升华、全员书面语。
改法：动作有结果；细节供判断；因果拆句；笼统判断落到可见动作/感官；勿堆修辞伪装生动；勿新增事实。
无问题句保持原样。只审阅→有证据结论不提案；要求修复→最小 patch。`;

function runtimeDebugContext(
  messages: ApiMessage[],
  metadata: { task: string; model: string; turns: number; transcript: string },
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
    partialOutput: metadata.transcript,
    messages: entries,
  }, null, 2);
  return `[Agent 调试上下文：模型执行轮次达到上限]\n${payload}`;
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
        : "选区较长；使用 startAnchorId/endAnchorId 调用 read_document_span，禁止按块通读。",
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
function recentArtifactsContext(store: WriterStore, sessionId: string, project: WriterProject, task: WritingTask): string {
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
        artifactIds: savedCheckpoint.artifactIds?.slice(0, 8),
      }
    : undefined;
  let artifacts = store.recentContextArtifacts(sessionId, 8);
  // New dialogue turn (not continuation): never inject whole-session residue — only the current target path, if any.
  if (!task.continuation) {
    const focusPath = task.targetPath ?? state.activeDocument;
    if (!focusPath && !checkpoint) return "";
    artifacts = artifacts.filter(item => item.path === focusPath);
    if (!artifacts.length && !checkpoint) return "";
  }
  if (!artifacts.length && !state.activeDocument && !state.currentIntent && !checkpoint) return "";
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
      || item.kind === "get_outline_node" || item.kind === "list_outline_nodes")
    .map(({ id, kind, path, sourceHash, digest }) => ({
      id, kind, path, sourceHash,
      digest: digest.replace(/\s+/g, " ").slice(0, 240),
    }));
  if (!catalog.length && !restored.length && !checkpoint) return "";
  const scopeNote = task.continuation
    ? "承接上一轮：catalog 列出已读资料（文档未变时禁止重复 inspect/read/list_outline_nodes）；restoredReads 至多含一段末尾正文可直接续写"
    : "仅当前目标文档相关索引（非会话级残留）；正文未注入时请按需 read 最小片段，或对相同 path+sourceHash 使用已有工具结果";
  return `本轮任务工作记忆（${scopeNote}）：\n${JSON.stringify({
    state: { activeDocument: state.activeDocument, currentIntent: state.currentIntent.slice(0, 160) },
    ...(checkpoint ? { checkpoint } : {}),
    artifacts: catalog,
    restoredReads: restored,
  })}`;
}

/** Restore only a validated, unfinished write-scene checkpoint. */
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

  const characterIndex = store.characters()
    .filter(item => task.characterIds.includes(item.id) || outlineCharacterIds.includes(item.id))
    .slice(0, 8)
    .map(item => ({ id: item.id, name: item.identity.name, narrativeRole: item.identity.narrativeRole }));

  if (!outlineNodes?.length && !targetCandidates.length && !prevCandidates.length && !characterIndex.length) {
    return "";
  }

  return `写作线索（系统启发式索引，未经验证，不是已读正文）：
- outlineNodes 有与本章精确匹配项时，才可用其 id 调用 get_outline_node 一次（id 为 UUID，不是章号）；为空时直接建立初始 scene guide，禁止为了写正文创建大纲。
- 需要衔接：对 previousChapterCandidates 中的路径 read_document(lastSection=true) 一次。
- 需要人设：对 characterIndex 中的 id 调用 get_character（可带 sections；场景状态需传 outlineNodeId）。
- 目标文档：对 targetDocumentCandidates 中的路径 inspect 或按需读取；路径不存在时按项目惯例新建，勿盲目使用未列出的路径。
- 写正文前：${task.mode === "write_scene" && (!task.targetPath || isScenePipelineDocument(task.targetPath)) ? `先 begin_chapter_draft 建立可调整的初始 scene guide；每场根据实际结尾与 latest actualState 决定继续、调整剩余引导或收束，write_chapter_scene 中${scenePipeline.isolatedWriter ? "只提交 notes（隔离 Writer 生成正文与状态）" : "提交 notes、正文与 actualState"}；全文 inspect 后一次性提案。` : "将上述材料整理为故事内笔记并 compile_write_pack；提案只依据返回的 writePack。"}
- 禁止：重复 list_outline_nodes、通读整本大纲、对同一路径反复 read。
- scene guide 与 outline 都只是当前章节的方向提示；实际正文、人物选择和 actualState 优先，不得扩展成其他章节任务。
${JSON.stringify({
    requestedChapter: chapterNum,
    confidence: outlineNodes?.length || targetCandidates.length ? "matched" : "low",
    outlineSource,
    outlineNodes,
    targetDocumentCandidates: targetCandidates,
    previousChapterCandidates: prevCandidates,
    characterIndex,
  })}`;
}

const CACHEABLE_TOOLS = new Set(["list_documents", "inspect_document", "locate_document_span", "read_document", "read_document_span", "search_project", "list_files", "inspect_file", "read_file", "search_files", "audit_prose_style", "list_outline_nodes", "get_outline_node", "validate_outline", "compare_outline_with_draft"]);
const DOCUMENT_READ_TOOLS = new Set(["inspect_document", "locate_document_span", "read_document", "read_document_span", "inspect_file", "read_file"]);
const DOCUMENT_BODY_READ_TOOLS = new Set(["read_document", "read_document_span", "read_file"]);
const READ_ATOM_CACHE_VERSION = "v2";
/** Structural / catalog tools must stay intact so the model does not re-list after compaction. */
const NEVER_COMPACT_KEYS = new Set(["nodes", "matches", "issues"]);

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
      if (input.path === context.chapterSceneDraft.path) {
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
  const sourceHash = sourcePath && project.textFileExists(sourcePath)
    ? project.hash(project.readTextFile(sourcePath))
    : call.name.endsWith("_files")
      ? project.hash(JSON.stringify(project.listTextFiles().map(file => [file, project.hash(project.readTextFile(file))])))
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
  }

  // Version read artifacts so older cached payload shapes are not mixed in.
  const cacheVersion = DOCUMENT_READ_TOOLS.has(call.name) ? `:${READ_ATOM_CACHE_VERSION}` : "";
  const cacheKey = `${call.name}${cacheVersion}:${JSON.stringify(normalized)}:${sourceHash}`;
  const count = (counts.get(cacheKey) ?? 0) + 1;
  counts.set(cacheKey, count);
  const cached = store.contextArtifact(sessionId, cacheKey);
  if (cached) {
    if (DOCUMENT_READ_TOOLS.has(call.name) && count > 1) {
      return JSON.stringify({
        status: "read_atom_reused",
        artifactId: cached.id,
        path: cached.path ?? sourcePath,
        sourceHash: cached.sourceHash,
        digest: cached.digest,
        message: "相同读取已存在于本轮上下文，正文不再重复返回。",
      });
    }
    const restored = withReuseMarker(cached.content,
      count === 1
        ? "工作记忆中已有相同且未变化的工具结果；以下为完整内容，请直接使用，勿再次读取。"
        : "相同读取已执行过且文档未变；以下从工作记忆恢复完整结果，请直接使用，禁止再次调用。",
      cached.id);
    return sourcePath ? admitReadAtom(call.name, sourcePath, sourceHash, restored, context) : restored;
  }
  const result = await executeTool(call, project, store, sessionId, emit, characterScope, context);
  const admitted = sourcePath ? admitReadAtom(call.name, sourcePath, sourceHash, result, context) : result;
  if (admitted !== result) return admitted;
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
  return attachArtifactId(result, artifactId);
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
 */
export function compactRuntimeMessages(messages: ApiMessage[]): void {
  const toolIndexes = messages.flatMap((message, index) => message.role === "tool" ? [index] : []);
  const totalChars = toolIndexes.reduce((sum, index) => sum + (messages[index].content?.length ?? 0), 0);
  // Earlier compact once digests stay in the transcript (no full rehydrate of all tools).
  if (toolIndexes.length <= 4 && totalChars <= 20_000) return;

  const keepRecent = 2;
  for (const index of toolIndexes.slice(0, -keepRecent)) {
    const message = messages[index];
    if (!message.content || message.content.length <= 800) continue;
    try {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
      if (parsed.status === "artifact_compacted") continue;
      // Never compact catalogs / search hit lists — losing IDs forces re-list thrashing.
      if ([...NEVER_COMPACT_KEYS].some(key => key in parsed)) continue;
      if (parsed.reused === true && message.content.length < 8_000) continue;

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
        message: "正文已压缩为 digest；请直接基于 digest、本轮任务工作记忆与写作引导继续。禁止因压缩再次 read_document / list_outline_nodes。",
      });
    } catch {
      if (message.content.length > 2_500) {
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
    if (!message?.content) continue;
    try {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
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
 * Strip older propose_* payloads when rebuilding a multi-proposal transcript.
 * CACHE: Not used mid-job (append-only) so prefix cache stays intact.
 */
export function compactCompletedToolCalls(messages: ApiMessage[]): void {
  let latestProposalMessage = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.tool_calls?.some(call => call.function.name.startsWith("propose_document"))) {
      latestProposalMessage = index;
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    // Keep the newest proposal intact as repair context; strip older ones.
    if (index === latestProposalMessage) continue;
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (!call.function.name.startsWith("propose_document")) continue;
      try {
        const input = JSON.parse(call.function.arguments) as Record<string, unknown>;
        if (call.function.name === "propose_document") {
          call.function.arguments = JSON.stringify({
            path: input.path,
            summary: input.summary,
            content: "[内容已压缩：旧正文已提交并从历史工具参数中移除。新提交时必须重新生成完整正文，不得复制此占位文本。]",
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
  const call = toStepUsage(usage, model.pricing);
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

/** Preflight-only context waterfall; provider usage remains the billing source of truth. */
export function buildRequestComponentUsage(
  messages: ApiMessage[],
  tools: readonly ToolDefinition[],
  stableMessageCount: number,
  initialMessageCount: number,
): RequestComponentUsage[] {
  const components: RequestComponentUsage[] = [];
  const append = (kind: RequestComponentUsage["kind"], label: string, text: string) => {
    if (!text) return;
    components.push({ kind, label, characters: text.length, estimatedTokens: approximateRequestTokens(text) });
  };
  if (tools.length) append("tool_schema", `工具 schema（${tools.length}）`, JSON.stringify(tools));
  messages.forEach((message, index) => {
    const serialized = JSON.stringify({
      role: message.role,
      content: message.content,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    });
    if (index < stableMessageCount) append("stable_system", `稳定 system ${index + 1}`, serialized);
    else if (index < initialMessageCount && message.role === "user") append("user", "当前用户请求", serialized);
    else if (index < initialMessageCount) append("dynamic_system", `动态尾部 ${index - stableMessageCount + 1}`, serialized);
    else if (message.role === "tool") append("tool_result", `工具结果 ${message.tool_call_id ?? index}`, serialized);
    else if (message.role === "assistant") append("assistant", `Agent 历史 ${index - initialMessageCount + 1}`, serialized);
    else if (message.role === "user") append("user", `用户/阶段交接 ${index - initialMessageCount + 1}`, serialized);
    else append("other", `其他消息 ${index + 1}`, serialized);
  });
  return components;
}

/**
 * Low-level chat completion. CACHE: execution receives one frozen, order-stable
 * task profile for the whole job. Never derive tools from project paths/ids or
 * replace the profile between steps.
 */
async function streamCompletion(
  model: ModelConfig,
  messages: ApiMessage[],
  signal: AbortSignal | undefined,
  onText: (text: string) => void,
  onReasoning: (text: string) => void,
  options: {
    tools?: readonly ToolDefinition[];
    maxCompletionTokens?: number;
    thinking?: { type: "enabled" | "disabled" };
    temperature?: number;
    topP?: number;
    responseFormat?: { type: "json_object" };
  } = {},
): Promise<{ content: string; reasoningContent: string; toolCalls: ToolAccumulator[]; finishReason?: string; usage?: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number; estimated?: boolean } }> {
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const requestBody = JSON.stringify({
    // The selected profile is frozen and project-agnostic for this job.
    model: model.model,
    messages,
    ...(options.tools?.length ? { tools: options.tools } : {}),
    stream: true,
    stream_options: { include_usage: true },
    ...(options.maxCompletionTokens ? { max_tokens: options.maxCompletionTokens } : {}),
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(options.topP !== undefined
      ? { top_p: options.topP }
      : model.topP !== undefined ? { top_p: model.topP } : {}),
  });
  logModelRequest(endpoint, requestBody);
  const response = await modelFetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body: requestBody,
    signal,
  }, model.proxyUrl);
  if (!response.ok) {
    const responseBody = await response.text();
    logModelResponse(endpoint, responseBody);
    const detail = responseBody.slice(0, 600);
    throw new Error(`模型请求失败（${response.status}）：${detail}`);
  }
  if (!response.body) throw new Error("模型响应没有可读取的数据流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, ToolAccumulator>();
  const visibleText = createVisibleTextFilter(onText);
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  let finishReason: string | undefined;
  let usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number } | undefined;

  const consume = (block: string) => {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.usage) usage = {
        promptTokens: Number(chunk.usage.prompt_tokens ?? 0),
        completionTokens: Number(chunk.usage.completion_tokens ?? 0),
        cacheHitTokens: Number(
          chunk.usage.prompt_cache_hit_tokens
          ?? chunk.usage.prompt_tokens_details?.cached_tokens
          ?? chunk.usage.input_tokens_details?.cached_tokens
          ?? 0,
        ),
        cacheMissTokens: Number(
          chunk.usage.prompt_cache_miss_tokens
          ?? Math.max(0, Number(chunk.usage.prompt_tokens ?? 0) - Number(
            chunk.usage.prompt_tokens_details?.cached_tokens
            ?? chunk.usage.input_tokens_details?.cached_tokens
            ?? chunk.usage.prompt_cache_hit_tokens
            ?? 0,
          )),
        ),
      };
      const choice = chunk.choices?.[0];
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string") {
        content += delta.content;
        visibleText.push(delta.content);
      }
      if (typeof delta.reasoning_content === "string") {
        reasoningContent += delta.reasoning_content;
        onReasoning(delta.reasoning_content);
      }
      for (const tool of delta.tool_calls ?? []) {
        const index = Number(tool.index ?? 0);
        const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (tool.id) current.id += tool.id;
        if (tool.function?.name) current.name += tool.function.name;
        if (tool.function?.arguments) current.arguments += tool.function.arguments;
        calls.set(index, current);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) consume(block);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  visibleText.flush();
  const textual = extractDsmlToolCalls(content);
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  const resolvedToolCalls = toolCalls.length ? toolCalls : textual.toolCalls;
  // Some providers omit stream usage; fall back so the UI can still show per-step tokens.
  const resolvedUsage = usage && (usage.promptTokens > 0 || usage.completionTokens > 0)
    ? usage
    : { ...estimateCompletionUsage(messages, textual.content, reasoningContent, resolvedToolCalls), estimated: true as const };
  const completed = {
    content: textual.content,
    reasoningContent,
    toolCalls: resolvedToolCalls,
    ...(finishReason ? { finishReason } : {}),
    usage: resolvedUsage,
  };
  logModelResponse(endpoint, JSON.stringify(completed, null, 2));
  return completed;
}

/** Rough token estimate when the provider does not return usage in the stream. */
function estimateCompletionUsage(
  messages: ApiMessage[],
  content: string,
  reasoningContent: string,
  toolCalls: ToolAccumulator[],
): { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number } {
  const promptChars = messages.reduce((sum, message) => {
    const body = message.content ?? "";
    const tools = message.tool_calls
      ? message.tool_calls.map((call) => `${call.function.name}:${call.function.arguments}`).join("\n")
      : "";
    return sum + body.length + tools.length + 16;
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
