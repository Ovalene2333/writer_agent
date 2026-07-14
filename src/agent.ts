import type { AgentEvent, ModelConfig, PermissionMode, StepUsage, UsageSummary } from "./types.js";
import { documentKind, resolveOutlineSourcePath, WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { getStyleTemplate } from "./templates.js";
import { OutlineStore } from "./outline.js";
import { logModelRequest, logModelResponse } from "./model_debug.js";
import { proseMannerismConstraintPrompt, proseMannerismPreflightLine } from "./prose_quality.js";
import { dynamicStyleGroundingPrompt, isIntensiveWritingMode, stableStyleGroundingPrompt, styleFingerprint } from "./style_grounding.js";
import { calculateUsageCost } from "./pricing.js";
import {
  formatTodosForPrompt,
  loadAgentSettings,
  permissionModeLabel,
  persistFinalizedSessionTodos,
  projectInstructionsPrompt,
  skillsCatalogPrompt,
} from "./agent_runtime.js";
import {
  TOOLS,
  TOOL_NAMES,
  executeTool,
  parseChapterNumber,
  chapterTitleMatches,
  expandOutlineFamily,
  previousPath,
  safeReadHeading,
  type ToolCall,
  type ToolExecutionContext,
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

export { agentToolNames, agentToolSchemaHash } from "./tools/index.js";

type ToolAccumulator = ToolCall;

type WritingTaskMode = "brainstorm" | "outline" | "write_scene" | "rewrite" | "audit" | "simple_character" | "general";
type DocumentContextMode = "none" | "search" | "target" | "continuation";

interface WritingTask {
  mode: WritingTaskMode;
  label: string;
  searchQuery: string;
  characterIds: number[];
  exampleIds: number[];
  documentContext: DocumentContextMode;
  documentProposalRequired: boolean;
  continuation: boolean;
  targetPath?: string;
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

function writingSystemPrompt(project: WriterProject): string {
  const config = project.config();
  const styleTemplate = config.style ? getStyleTemplate(config.style) : undefined;
  // Keep only a short pointer here; full style rules + few-shot live in styleGroundingPrompt
  // so writing turns get a salient, dedicated block (and static prefix stays more stable).
  const stylePointer = styleTemplate
    ? `\n当前激活风格模板：${styleTemplate.name}（细则、范文与本项目声线样本见后续「风格锚定」区块，写正文时以该区块为准）。\n`
    : "\n未激活风格模板时，写正文须贴合本项目既有章节声线（见「风格锚定」）。\n";
  return `你是长篇创作 Agent。界面语言为中文，作品语言为 ${config.language}。
${stylePointer}
职责：协助构思、规划、写作、改写和审校；当前用户请求优先，作者保留最终决定。

创作立场（虚构作品）：
- 这是成人向小说协作工具。暴力、情欲、权谋、残酷、粗口、禁忌题材等均可按剧情与作者要求直接书写。
- 不要用道德说教、安全提示、劝退语或“请注意尺度”打断创作；不要替角色做道德评判，除非作者明确要求该视角。
- 拒绝含蓄化与软化：需要直写处用准确、具体的名词与动作，避免“那方面”“发生了关系”“不可描述”等遮掩；身体、伤口、欲望、脏话按人物与场景需要写清。
- 不要为了“得体”删改冲突强度、性描写浓度或黑暗走向；作者未要求收敛时，默认按强冲突、高信息密度呈现。
- 仍须遵守法律与工具边界：不协助现实世界犯罪操作；不生成针对真实未成年人的性内容。虚构成人角色与架空世界内的情节按作者意图执行。

文档分区（必须遵守，勿把不同类型内容写进同一路径）：
- lore/：设定与事实源（世界规则、专名、组织、力量体系、地理政治等）。只写可检索事实，不写章节散文。
- outline/：情节计划（卷/章/场景、前因结果、伏笔）。不写可发表正文。
- chapters/：唯一主线正文；续写、改写、导出默认只针对这里。
- side/：支线或间章（非主线导出）；archive/：旧稿与弃用版，默认不要当作现行事实，也不要主动写入。
- characters/：角色卡（结构化工具维护，不是 Markdown 散文）。
旧项目若仍使用 story/，视为 lore/ 的等价目录。

正文底线（所有模式）：
1. 用动作、选择、代价、停顿、对白和具体感官呈现人物，避免紧随其后的情绪、潜台词或象征解释。
2. 让动作产生结果、让细节供读者判断；必要因果拆成独立句。保留对白中的拖音、中断、迟疑和真实纠正。
3. 对白服从人物身份与当下目的；场景落在具体动作、决定、发现或未决问题上。
4. 不编造 lore/角色卡未支撑的关键设定；区分项目事实与合理创作推断。
5. ${proseMannerismConstraintPrompt({ compact: true })}
`;
}

function executionRulesPrompt(mode: PermissionMode): string {
  const archiveRule = "When the user asks to use the complete or long conversation/roleplay history, the automatically injected history is only a recent preview. You MUST call inspect_conversation, then page read_conversation from afterId=0 through nextAfterId until hasMore=false for the relevant channel. Never claim the full archive was read from the preview alone. Read simple cards with list_simple_characters/get_simple_character; they are separate from normal cards.";
  const modeRule = mode === "plan"
    ? "3. 当前为 plan 模式：只做检索、分析与计划，禁止调用 propose_document / propose_document_patch / propose_outline_patch / save_character / save_simple_character；用最终回复给出可执行计划与待确认点。"
    : mode === "auto"
      ? "3. 当前为 auto 模式：写正文、续写、扩写或改写必须提交文档提案（会自动写入文件），不能用最终回复代替正文。提案成功后立即停止。"
      : "3. 写正文、续写、扩写或改写必须提交文档提案，不能用最终回复代替。提案提交后立即停止并等待审批。";
  return `执行规则：
1. 按本轮任务计划决定是否读取项目资料。需要项目事实时先 search_project（世界观/专名 scope=lore，情节计划 scope=outline，已写正文 scope=chapters），再读取最小相关片段；每轮最多搜索两次。区分项目事实与推测。
2. 保持既有人物、世界观、视角和 Markdown 结构。局部修改用补丁；大纲节点用大纲补丁；新建或全文重写才提交完整文档。新建设定→lore/，新建大纲→outline/，新建正文→chapters/；不要把设定写进章节，也不要把正文写进 lore。
${modeRule}
${archiveRule}
4. 只有缺少目标文档、既有事实或会实质改变结果的关键选择，且无法可靠推断时才调用 ask_user。情节、对白和描写等可逆创作选择自行作合理决定。询问后立即停止。
5. 普通角色卡使用 save_character；简易角色卡使用 save_simple_character。创建角色卡前，只要请求涉及项目中的既有人物、组织、地点、装备、事件或职责，就必须先用 list_characters/get_character 与 search_project 核对相关资料，不得因用户未显式要求“读取文档”而跳过。修改普通卡必须传 id；新建普通卡省略 id 并提供 identity.name。
6. 路人/一次性配角可直接写入正文，不必建角色卡；仅当该角色会反复出现、需要稳定人设或用户明确要求建卡时，才用 save_character 新建。
7. 资料复用：仅复用「本轮任务相关工作记忆」、本轮工具结果、带 reused 标记的返回；禁止对同一路径/同一参数反复读取，禁止重复 list_outline_nodes。上一轮非承接任务的清单与记忆不会自动带入。系统「写作线索」只是未验证的候选索引，需要正文或完整人设时仍应用工具取最小片段。大纲节点 id 是 UUID，不是章号。artifact_compacted 只用 digest，不要因此改换参数反复试读。
8. 复杂多步请求（≥3 步）用 manage_todos 维护清单并随进度更新；简单单步不必。清单绑定当前对话任务：切换到不同 mode 的新请求会清空旧清单，承接续写则保留。同一时刻最多一项 in_progress。提交最终文档提案前把清单中剩余项标为 completed（提案成功后本轮会立即结束，之后无法再更新清单）。
9. 若系统提示列出了项目技能且细则对当前任务必要，先 load_skill 再执行；不要编造不存在的技能。
10. 不泄露内部参数，不使用项目范围外的信息；对话简洁，文档使用适量 Markdown。
当前执行模式：${permissionModeLabel(mode)}`;
}

function dynamicContextPrompt(project: WriterProject, store: WriterStore, request: string, task: WritingTask, characterScope?: number[], continuationPath?: string): string {
  const explicitReferences = explicitReferencePaths(project, request);
  const inferredTargets = task.targetPath && !explicitReferences.includes(task.targetPath) ? [task.targetPath] : [];
  const references = [...new Set([...explicitReferences, ...inferredTargets])];
  const creativeContext = structuredCreativeContext(store, task, characterScope);
  // Scope only gates reading/listing *existing* cards and relationship targets — not prose NPCs or new cards.
  const characterScopeInstruction = characterScope === undefined
    ? "角色资料按任务相关性自动筛选。list_characters / get_character 可读全部已有普通角色卡；可用 save_character 管理普通卡、save_simple_character 管理简易卡。创建简易角色卡时应先检查同名或相关普通角色卡。"
    : characterScope.length
      ? `本次可读取/列出的已有角色卡 ID：${characterScope.join("、")}。不得 get_character / 在 relationships 中关联范围外的*已有*角色。这不禁止：① 在正文中写无名或一次性配角（无需建卡）；② 用 save_character 省略 id 新建角色卡（新建后该 ID 即可读取）；③ 更新范围内已有角色卡。不要把「范围外」理解成禁止创作新人物。`
      : "本次不加载任何已有角色卡：不得 list_characters / get_character 读取既有资料。仍可在正文中写人物；若用户要求或情节需要稳定人设，可用 save_character 省略 id 新建角色卡。";
  const documentInstruction = task.documentProposalRequired
    ? `本次请求必须产生文档提案后才能结束。不得把正文直接作为最终回复；须基于目标 Markdown 文档提交 propose_document_patch 或 propose_document。若工作记忆或本轮工具结果已含目标文档相关原文且文档未变，可直接提案，不必再次读取。${continuationPath ? `本次是承接上一轮的简短续写，默认目标文档为 ${continuationPath}。` : ""}`
    : "本次请求不强制产生文档提案，按用户意图执行。";
  const contextInstruction: Record<DocumentContextMode, string> = {
    none: "无需读取项目文档。直接使用当前对话完成任务；不要调用 list_documents、search_project、inspect_document 或 read_document。",
    search: task.mode === "simple_character"
      ? `创建简易角色卡必须核对项目资料。先调用 list_characters 检查同名或相关普通角色卡，必要时 get_character；再调用 search_project 检索 lore/ 与 outline/，查询：${task.searchQuery || request.slice(0, 120)}。检索片段不足时继续 inspect_document/read_document 读取最小相关范围。完成核对后调用 save_simple_character。`
      : `需要核对项目资料。先调用 search_project，查询：${task.searchQuery || request.slice(0, 120)}。仅在检索片段不足时继续 inspect_document/read_document；同一路径只读取一次最小范围。`,
    target: `需要目标文档上下文。${references.length ? `候选路径：${references.join("、")}。` : "先定位目标路径。"}工作记忆已有该路径且文档未变时直接复用；否则 inspect_document 一次，再 read_document 一次最小必要块，之后禁止重复读取同一路径。`,
    continuation: `需要承接已有正文。${continuationPath ? `目标路径：${continuationPath}。` : "先从对话和提案记录确定目标路径；无法确定时询问用户。"}工作记忆已有该路径末尾原文且文档未变时直接续写；否则 inspect_document 一次，再用 read_document 的 lastSection=true 读最后一节（无标题时读最后一块），之后禁止重复读取。`,
  };
  return `当前任务：${task.label}

当前用户请求是本轮唯一要执行的指令。历史对话只用于理解指代和既有事实，不得把已经完成的旧修改要求自动并入本轮任务。
只有“当前消息中的 @ 明确引用”部分列出的路径，才能称为“用户指定”或“用户 @ 指定”。规划器推断目标、会话活动文档和历史文档都只能称为系统推断，不得冒充用户选择。

${taskInstructions(task.mode)}

上下文决策：${contextInstruction[task.documentContext]}

角色资料范围：${characterScopeInstruction}

文档写入约束：${documentInstruction}

按本次任务筛选的结构化创作资料（JSON；未出现的资料不代表不存在，需要时使用工具检索）：
${creativeContext}

当前消息中的 @ 明确引用（尚未读取）：
${explicitReferences.length ? explicitReferences.map(path => `- ${path}`).join("\n") : "- 无；不得声称用户指定了任何文档"}

系统根据当前任务推断的候选目标（不是用户 @ 指定）：
${inferredTargets.length ? inferredTargets.map(path => `- ${path}`).join("\n") : "- 无"}`;
}

const TASK_LABELS: Record<WritingTaskMode, string> = {
  brainstorm: "创意构思与候选方案", outline: "动态大纲与情节规划",
  write_scene: "场景或章节写作", rewrite: "定向改写",
  audit: "一致性与质量审校", simple_character: "创建或更新简易角色卡", general: "通用写作协作",
};

async function planWritingTask(
  model: ModelConfig, project: WriterProject, store: WriterStore, request: string, history: ApiMessage[], signal?: AbortSignal,
): Promise<{ task: WritingTask; usage?: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number } }> {
  const documents = project.listDocuments().filter(path => !project.isDocumentHidden(path));
  const characters = store.characters().map(item => ({ id: item.id, name: item.identity.name, aliases: item.identity.aliases, narrativeRole: item.identity.narrativeRole, identity: item.identity.summary }));
  const activeStyleId = project.config().style;
  const activeStyle = activeStyleId ? getStyleTemplate(activeStyleId) : undefined;
  // Slim catalogs: paths / id+name only — full notes/examples hurt planner cache and cost.
  const examples = store.writingExamples()
    .filter(item => !item.title.startsWith("[风格模板]") || item.title === `[风格模板] ${activeStyle?.name}`)
    .map(item => ({ id: item.id, title: item.title, category: item.category }))
    .slice(0, 40);
  const slimCharacters = characters.map(item => ({ id: item.id, name: item.name, aliases: item.aliases }));
  const recent = history.slice(-4).map(item => item.role === "user"
    ? { content: item.content?.slice(0, 200) ?? "" }
    : { role: item.role, content: item.content?.slice(0, 160) ?? "" });
  // Stable planner rules first (cacheable across turns); project catalogs + history in the user message.
  const planningMessages: ApiMessage[] = [{
    role: "system",
    content: `你是写作 Agent 的任务规划器。根据语义而非关键词判断用户真正要做什么。只输出一个 JSON 对象，不输出 Markdown。
字段：mode（brainstorm/outline/write_scene/rewrite/audit/simple_character/general）；documentContext（none/search/target/continuation）；targetPath（当前请求明确或语义上可确定目标文档时，必须从文档目录原样选择一个路径，否则省略）；searchQuery（仅在 documentContext=search 时提供简短查询）；characterIds（确实需要角色资料时最多 4 个，否则空数组）；exampleIds（确实需要范文时最多 2 个，否则空数组）；documentProposalRequired（用户要求创作或者修改场景、正文、大纲时为 true，纯讨论、构思、分析、建议、角色卡操作为 false）；continuation（当前请求是否承接上一轮写作任务）。
决策原则：创建或更新“简易角色/简易角色卡/简略角色卡”必须使用 simple_character，并设 documentContext=search，以便核对已有普通角色卡和 lore/outline 设定；不得因为用户没有明确说“读取文档”而使用 none。当前 user 消息是唯一的当前任务，优先级高于“最近对话”；最近对话只用于解析“继续、按刚才方案、改一下它”等省略和指代，不得把旧任务的修改要求合并到当前明确指令中。只有回答依赖项目中未出现在对话里的事实时才读取文档。泛化写作问题、闲聊、纯构思默认 none；需要跨文档查事实用 search；用户指定单篇文档或要求修改现有内容用 target；承接上一轮正文用 continuation。不要因为这是写作 Agent 就默认读取文档。
路径约定：lore/=设定事实，outline/=情节计划，chapters/=主线正文，side/=支线，archive/=旧稿。为正文写作选 targetPath 时优先 chapters/；为大纲任务优先 outline/；查世界观优先在 lore/ 上 search。
targetPath / characterIds / exampleIds 必须从用户消息中的目录原样选择；目录没有的路径或 id 不要编造。`,
  }, {
    role: "user",
    content: JSON.stringify({
      request,
      documents,
      characters: slimCharacters,
      examples,
      recentHistory: recent,
    }),
  }];
  const result = await streamCompletion(model, planningMessages, signal, () => undefined, () => undefined, false);
  const firstBrace = result.content.indexOf("{");
  const lastBrace = result.content.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error("任务规划器没有返回有效 JSON");
  const parsed = JSON.parse(result.content.slice(firstBrace, lastBrace + 1)) as Partial<WritingTask>;
  const modes: WritingTaskMode[] = ["brainstorm", "outline", "write_scene", "rewrite", "audit", "simple_character", "general"];
  const mode = modes.includes(parsed.mode as WritingTaskMode) ? parsed.mode as WritingTaskMode : "general";
  const contextModes: DocumentContextMode[] = ["none", "search", "target", "continuation"];
  const documentContext = contextModes.includes(parsed.documentContext as DocumentContextMode)
    ? parsed.documentContext as DocumentContextMode
    : "none";
  const validCharacterIds = new Set(characters.map(item => item.id));
  const validExampleIds = new Set(examples.map(item => item.id));
  const validDocumentPaths = new Set(documents);
  const continuation = parsed.continuation === true;
  const documentProposalRequired = parsed.documentProposalRequired === true;
  const normalizedDocumentContext = mode === "simple_character"
    ? "search"
    : continuation
    ? "continuation"
    : documentProposalRequired && documentContext === "none" ? "target" : documentContext;
  return {
    task: {
      mode,
      label: TASK_LABELS[mode],
      searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery.slice(0, 200) : request.slice(0, 200),
      characterIds: Array.isArray(parsed.characterIds) ? parsed.characterIds.filter(id => validCharacterIds.has(id)).slice(0, 4) : [],
      exampleIds: Array.isArray(parsed.exampleIds) ? parsed.exampleIds.filter(id => validExampleIds.has(id)).slice(0, 2) : [],
      documentContext: normalizedDocumentContext,
      documentProposalRequired,
      continuation,
      ...(typeof parsed.targetPath === "string" && validDocumentPaths.has(parsed.targetPath) ? { targetPath: parsed.targetPath } : {}),
    },
    usage: result.usage,
  };
}

function fastRouteWritingTask(project: WriterProject, store: WriterStore, sessionId: string, request: string): WritingTask | undefined {
  const references = explicitReferencePaths(project, request);
  const sessionContext = store.sessionContext(sessionId);
  const trimmed = request.trim();
  const simpleCharacter = isSimpleCharacterCardRequest(request);
  if (simpleCharacter) return {
    mode: "simple_character",
    label: TASK_LABELS.simple_character,
    documentContext: "search",
    searchQuery: request.slice(0, 200),
    characterIds: [], exampleIds: [], documentProposalRequired: false, continuation: false,
  };
  const continuation = /^(继续|接着|续写|往下写)(?:[。！!，,\s]|$)/.test(trimmed)
    || /^(继续|接着).{0,12}(写|写下去|往下)/.test(trimmed);
  const rewrite = /(改写|重写|润色|修改).*(这一段|这段|选区|这一章|整章|全文)/.test(request);
  const audit = /(审阅|检查|校对|找问题|风格审计|audit)/.test(request)
    && (references.length > 0 || Boolean(sessionContext.activeDocument));
  const writeChapter = /(写|撰写|创作|扩写).{0,16}(第\s*[一二三四五六七八九十百千零〇\d]+\s*章|正文|场景)/.test(request)
    || /^(开写|写正文|写一章)/.test(trimmed);
  const stickyPath = sessionContext.activeDocument
    ?? store.proposals().find(item => item.sessionId === sessionId)?.path;
  const targetPath = references[0]
    ?? (continuation || rewrite || writeChapter || audit ? stickyPath : undefined)
    ?? (writeChapter ? inferChapterPath(project, request) : undefined);

  if (continuation && targetPath) {
    return {
      mode: "write_scene", label: TASK_LABELS.write_scene, documentContext: "continuation", targetPath,
      searchQuery: request.slice(0, 200), characterIds: [], exampleIds: [], documentProposalRequired: true, continuation: true,
    };
  }
  if (rewrite && targetPath) {
    return {
      mode: "rewrite", label: TASK_LABELS.rewrite, documentContext: "target", targetPath,
      searchQuery: request.slice(0, 200), characterIds: [], exampleIds: [], documentProposalRequired: true, continuation: false,
    };
  }
  if (audit && targetPath) {
    return {
      mode: "audit", label: TASK_LABELS.audit, documentContext: "target", targetPath,
      searchQuery: request.slice(0, 200), characterIds: [], exampleIds: [], documentProposalRequired: false, continuation: false,
    };
  }
  if (writeChapter && targetPath) {
    return {
      mode: "write_scene", label: TASK_LABELS.write_scene, documentContext: "target", targetPath,
      searchQuery: request.slice(0, 200), characterIds: [], exampleIds: [], documentProposalRequired: true, continuation: false,
    };
  }
  if (references.length === 1) {
    const writing = /(写|续写|扩写|改写|重写|修改|润色|撰写|创作)/.test(request);
    return {
      mode: writing ? "write_scene" : "general",
      label: TASK_LABELS[writing ? "write_scene" : "general"],
      documentContext: "target",
      targetPath: references[0],
      searchQuery: request.slice(0, 200), characterIds: [], exampleIds: [],
      documentProposalRequired: writing, continuation: false,
    };
  }
  return undefined;
}

export function isSimpleCharacterCardRequest(request: string): boolean {
  return /(?:创建|新建|生成|制作|补充|修改|更新).{0,16}(?:简易|简略)(?:角色卡|角色|人物卡)/.test(request)
    || /(?:简易|简略)(?:角色卡|角色|人物卡).{0,16}(?:创建|新建|生成|制作|补充|修改|更新)/.test(request);
}

/** Best-effort map 「第N章」 to an existing chapters/*.md path for fastRoute. */
function inferChapterPath(project: WriterProject, request: string): string | undefined {
  const match = request.match(/第\s*([一二三四五六七八九十百千零〇\d]+)\s*章/);
  if (!match) return undefined;
  const raw = match[1];
  const arabic = /^\d+$/.test(raw) ? raw : chineseNumeralToInt(raw);
  if (!arabic) return undefined;
  const n = Number(arabic);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const candidates = [
    `chapters/第${n}章.md`,
    `chapters/第${String(n).padStart(2, "0")}章.md`,
    `chapters/ch${n}.md`,
    `chapters/ch${String(n).padStart(2, "0")}.md`,
    `chapters/${n}.md`,
  ];
  for (const path of candidates) {
    if (project.documentExists(path) && !project.isDocumentHidden(path)) return path;
  }
  return `chapters/第${n}章.md`;
}

function chineseNumeralToInt(text: string): string | undefined {
  const map: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  if (text === "十") return "10";
  if (text.length === 1 && map[text] !== undefined) return String(map[text]);
  if (text.startsWith("十") && text.length === 2 && map[text[1]] !== undefined) return String(10 + map[text[1]]);
  if (text.endsWith("十") && text.length === 2 && map[text[0]] !== undefined) return String(map[text[0]] * 10);
  if (text.length === 3 && text[1] === "十" && map[text[0]] !== undefined && map[text[2]] !== undefined) {
    return String(map[text[0]] * 10 + map[text[2]]);
  }
  return undefined;
}

function taskInstructions(mode: WritingTaskMode): string {
  if (mode === "simple_character") return `本次工作流：
- 这是简易角色卡任务，不要调用 save_character 创建普通角色卡；最终必须调用 save_simple_character 保存。
- 先调用 list_characters 检查同名或相关普通角色卡；若存在相关角色，用 get_character 读取必要分区。
- 按上下文决策调用 search_project 检索相关 lore/ 与 outline/；结果不足时只读取最小相关片段。用户未明确要求读取资料不等于可以跳过核对。
- 将查到的项目事实压缩为 name、identity、relationship、knowledge、scene、goal 六个字段；不确定的信息留空或明确写“未明确”，不要凭空补关键设定。`;
  if (mode === "brainstorm") return `本次工作流：
- 先明确人物欲望、阻力、失败代价和不可逆后果。
- 给出三个真正不同的候选方向，分别说明核心冲突与后续潜力。
- 不把候选设想写入项目事实，除非作者明确选定。`;
  if (mode === "outline") return `本次工作流：
- 硬约束：本轮对 outline/（或故事大纲文档）的 propose_document / propose_document_patch 在成功调用 design_creative_outline 之前会被系统拒绝。局部节点字段修补用 propose_outline_patch，不受此限。
- 新建大纲或大幅重构时，先调用 design_creative_outline 一次取得创意路线与评估表；基于其 generationPrompt 在内部完成发散、比较、反驳和深化，不要把四份半成品全写入项目。仅做局部字段修补时无需调用。
- 大纲文档在 outline/（旧项目可能是 story/outline.md）。先调用 list_outline_nodes 了解“卷/幕—章—场景”结构；读取或修改具体节点时用 get_outline_node，不要靠全文搜索猜测节点边界。
- 每个场景节点维护前因、行动、结果和状态变化；同时维护人物弧、信息释放、伏笔埋设与回收。
- 修改既有节点使用 propose_outline_patch 提交局部提案；结构完整性检查使用 validate_outline。
- 新建大纲写入 outline/，不要写入 chapters/ 或 lore/。
- 大纲场景字段必须与结构化解析一致（列表“字段：值”）：摘要、前因、行动、结果、状态变化、角色ID、地点、时间、情节线、伏笔、回收、状态、文档、正文章节。创意侧「目标/阻力」写入摘要，「关键选择」写入行动；勿使用未登记字段名。`;
  if (mode === "write_scene") return `本次工作流（内部执行，不输出分析过程）：
1. 先读「风格锚定」：对齐本项目声线样本与模板节奏，再动笔；禁止写成与样本句长/对白密度明显不同的通用腔。
2. 「写作线索」只是候选索引。Step 1 最小核对：情节用 get_outline_node（UUID）；衔接用上一章 read_document(lastSection=true)；人设用 get_character 必要字段；目标文档存在则 inspect 或读一次草稿/末段。
3. 不要通读整本大纲、不要 list_outline_nodes 超过一次、不要对同一路径反复 read。
4. 落笔前在内部明确：场景开场、人物目标、阻力、不可逆结果；正文默认 chapters/；设定说明不进正文。
5. 写作时持续对照风格锚定；对白区分人物；不引入未支撑设定。冲突、情欲、暴力等按剧情直写，不自行降级为含蓄暗示或道德旁白。
6. 提交前自检：是否在动作或细节后重复解释意义、是否段尾升华、是否偏离样本声线、是否无故软化关键描写；人物自然口语不按叙述模板处理。${proseMannerismPreflightLine()}
7. 新建或空文档用 propose_document；已有正文用 propose_document_patch。提交后停止。偶发一处说明句不拦截；过密的说明性破折号与抽象「不是…而是」会被系统拒绝——只改命中句再提，勿全文重写。`;
  if (mode === "rewrite") return `本次工作流（内部执行，不输出分析过程）：
- 先读「风格锚定」与原文声线；改写后的句长、对白密度须仍贴近原文/样本，除非作者明确要求换风格。
- 只改变作者明确要求调整的维度，保持其余事件事实、人物动机和信息顺序不变。
- 风格变化必须落实到叙述距离、句法节奏、对白比例、感官重点和信息释放，而不是同义替换。
- 保留原文有辨识度的不规则表达，不把句子统一润色成工整、完整、均匀的书面语；不要把直白改成含蓄，除非作者要求。
- 优先用具体名词和动词替换泛化情绪、程度副词与装饰性修辞；避免为了“更有文采”新增比喻、总结或升华。
- ${proseMannerismConstraintPrompt({ compact: true })}
- 对照原文检查信息损失与新增事实，优先通过局部补丁提案提交。提交前：${proseMannerismPreflightLine()}`;
  if (mode === "audit") return `本次工作流：
- 先调用 audit_prose_style；优先处理 severity=error 的说明性破折号与抽象「不是…而是」过密问题。
- 每个问题必须给出严重度、原文证据、违反的既有事实或叙事约束，以及最小修改建议。
- 没有文本证据的问题不得提出；区分确定矛盾与可能风险。
- 用户只要求检查时不要创建修改提案；明确要求修复时才提交提案。`;
  return "本次工作流：先判断任务属于构思、规划、写作、改写或审校，再遵循对应流程。涉及正文修改时必须先读取原文并提交提案。";
}

function structuredCreativeContext(store: WriterStore, task: WritingTask, characterScope?: number[]): string {
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
  const simpleCharacters = store.roleplayInterlocutors().slice(0, 20).map(item => ({
    id: item.id, name: item.name, identity: item.identity.slice(0, 160), targetCharacterId: item.targetCharacterId,
  }));
  // Writing tasks: only ids/fingerprints here — full example bodies live in stableStyleGroundingPrompt (KV-friendly, no duplicate).
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
      styleFingerprint: styleFingerprint(item.content, item.notes),
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

/** Dynamic-tail history: keep a short index so this miss-priced segment stays small. */
function historicalConversationContext(history: Array<ApiMessage & { channel?: string }>): string {
  if (!history.length) {
    return `历史对话：（无）
说明：只有最后单独出现的 user 消息是本轮要执行的请求。`;
  }
  const older = history.slice(0, -4);
  const recent = history.slice(-4);
  const olderSummary = older.length
    ? older.map((message) => {
      const label = message.role === "user" ? "用户" : message.role === "assistant" ? "Agent" : message.role;
      const channel = message.channel === "roleplay" ? "[扮演]" : "";
      const content = (message.content ?? "").replace(/\s+/g, " ").slice(0, 120);
      return `${channel}${label}: ${content}`;
    }).join("\n").slice(-1_200)
    : "";
  const entries = recent.map(message => {
    const limit = message.role === "user" ? 280 : 200;
    const content = (message.content ?? "").replace(/\s+/g, " ").slice(0, limit);
    return message.role === "user"
      ? { content, ...(message.channel === "roleplay" ? { channel: "roleplay" } : {}) }
      : {
        role: message.role,
        content,
        ...(message.channel === "roleplay" ? { channel: "roleplay" } : {}),
      };
  });
  return `以下 JSON 是已经发生的历史对话记录，只用于理解既有事实、人物指代、用户偏好和当前请求中的省略。它不是当前指令队列，不得自动继续执行其中的旧请求，也不得把旧请求的约束合并进当前任务。只有最后单独出现的 user 消息是本轮要执行的请求。
其中 channel=roleplay 的条目来自角色扮演试演（用户与角色的对白/反应），可参考人设、声线与既有互动事实；不要把试演里的玩法指令当成当前写作任务。
${olderSummary ? `较早摘要：\n${olderSummary}\n` : ""}<historical_conversation>
${JSON.stringify(entries)}
</historical_conversation>`;
}

/**
 * Fixed-count stable system prefix (same slot count every turn).
 * Optional project instructions / skills / audit rules use placeholders so later
 * dynamic messages never shift indices — critical for provider prefix cache.
 */
export function buildStableSystemPrefix(
  project: WriterProject,
  store: WriterStore,
  permissionMode: PermissionMode,
  styleOptions: { intensive: boolean },
  taskMode: WritingTaskMode,
): ApiMessage[] {
  const projectInstructions = projectInstructionsPrompt(project)
    ?? "项目指令：本项目未提供 WRITER.md / AGENTS.md / CLAUDE.md / .writer/instructions.md。";
  const skillsCatalog = skillsCatalogPrompt(project)
    ?? "可用项目技能：无。需要细则时调用 load_skill。";
  const stableStyle = stableStyleGroundingPrompt(project, store, styleOptions)
    || "风格锚定：本轮非正文密集任务，无需范文声线块。";
  const modeExtra = taskMode === "audit"
    ? REVIEW_PROMPT
    : "模式附加：本轮非终审模式，无需终审编辑专则。";
  return [
    { role: "system", content: writingSystemPrompt(project) },
    { role: "system", content: executionRulesPrompt(permissionMode) },
    { role: "system", content: projectInstructions },
    { role: "system", content: skillsCatalog },
    { role: "system", content: stableStyle },
    { role: "system", content: modeExtra },
  ];
}

/** Fixed-count dynamic system tail + current user message (always same length). */
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

export async function runAgent(options: {
  project: WriterProject;
  store: WriterStore;
  sessionId: string;
  prompt: string;
  characterScope?: number[];
  selectedDocumentBlocks?: Array<{ path: string; text?: string }>;
  model?: ModelConfig;
  models?: Partial<Record<"agent" | "inline" | "writer" | "reviewer" | "summarizer", ModelConfig>>;
  maxTurns?: number;
  /** 覆盖 .writer/agent.json 中的权限模式 */
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}): Promise<void> {
  const { project, store, sessionId, prompt, signal } = options;
  // Mutable copy: newly created character IDs are appended so the same turn can read them.
  const characterScope = options.characterScope === undefined ? undefined : [...options.characterScope];
  const emit = options.onEvent ?? (() => undefined);
  const model = options.models?.agent ?? options.model ?? modelConfigFromEnv();
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未设置 WRITER_API_KEY");
  }
  if (!store.sessionExists(sessionId)) throw new Error("会话不存在");

  const permissionMode = options.permissionMode ?? loadAgentSettings(project).permissionMode;
  emit({ type: "mode", mode: permissionMode });

  // 写作 Agent 可读全部通道；扮演试演会标注 channel=roleplay，供人设/对白参考。
  const history = compactHistory(
    store.messages(sessionId, 40)
      .filter((message) => message.role !== "tool" && message.role !== "system")
      .map((message) => ({ role: message.role, content: message.content, channel: message.channel })),
  );
  const previousTaskState = store.sessionContext(sessionId);
  const fastTask = fastRouteWritingTask(project, store, sessionId, prompt);
  const planned = fastTask ? { task: fastTask } : await planWritingTask(model, project, store, prompt, history, signal);
  const task = planned.task;
  // plan 模式下即使规划器要求提案，也不强制写入，避免与权限冲突
  if (permissionMode === "plan") task.documentProposalRequired = false;
  const executionModel = task.mode === "audit"
    ? options.models?.reviewer ?? model
    : task.mode === "rewrite"
    ? options.models?.inline ?? model
    : task.documentProposalRequired
      ? options.models?.writer ?? model
      : model;
  if ("usage" in planned && planned.usage) {
    emitUsageEvent(emit, store, sessionId, model, planned.usage);
  }
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
  const activeDocument = task.targetPath ?? continuationPath;
  store.saveSessionContext(sessionId, {
    activeDocument,
    currentIntent: `${task.mode}: ${prompt.slice(0, 240)}`,
  });
  const turnTodos = store.sessionTodos(sessionId);
  emit({ type: "todos", todos: turnTodos });
  store.addMessage(sessionId, "user", prompt);
  const archiveContext = `Complete conversation archive metadata (the injected history is only a preview):\n${JSON.stringify(store.conversationStats(sessionId))}`;
  const selectedContext = selectedBlocksContext(project, options.selectedDocumentBlocks);
  const historyText = historicalConversationContext(history);
  const artifactContext = recentArtifactsContext(store, sessionId, project, task);
  const bootstrapContext = writingBootstrapContext(project, store, prompt, task);
  const todosPrompt = turnTodos.length
    ? `当前对话任务清单（绑定本轮任务，非会话全局残留；可用 manage_todos 更新）：\n${formatTodosForPrompt(turnTodos)}`
    : undefined;
  const preferredSample = options.selectedDocumentBlocks
    ?.map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
  const styleOptions = {
    intensive: isIntensiveWritingMode(task.mode) || task.documentProposalRequired,
    targetPath: task.targetPath ?? continuationPath,
    exampleIds: task.exampleIds,
    preferredSample: preferredSample || undefined,
  };
  const dynamicStyleContext = dynamicStyleGroundingPrompt(project, store, styleOptions);
  // Prefer cheap roles for prose snippet second pass (flash-class models).
  const adjudicatorModel = options.models?.inline
    ?? options.models?.summarizer
    ?? options.models?.reviewer
    ?? model;
  const toolContext: ToolExecutionContext = {
    permissionMode,
    requireCreativeOutlineDesign: task.mode === "outline",
    proseAdjudicator: {
      model: adjudicatorModel,
      signal,
    },
  };
  // Fixed slot counts: stable prefix then dynamic tail. Never omit optional slots (use placeholders)
  // so message indices stay aligned for provider prefix / KV cache across turns.
  // Within this job the messages array is append-only — do not compact/rehydrate/strip
  // already-sent messages between tool steps (that would invalidate step-to-step cache hits).
  const messages: ApiMessage[] = [
    ...buildStableSystemPrefix(project, store, permissionMode, styleOptions, task.mode),
    ...buildDynamicTurnMessages({
      historyText,
      archiveContext,
      taskContext: dynamicContextPrompt(project, store, prompt, task, characterScope, continuationPath),
      dynamicStyleContext: dynamicStyleContext || undefined,
      bootstrapContext: bootstrapContext || undefined,
      todosPrompt,
      artifactContext: artifactContext || undefined,
      selectedContext: selectedContext || undefined,
      prompt,
    }),
  ];
  let transcript = "";
  let documentProposalSubmitted = false;
  let waitingForUser = false;
  const toolCallCounts = new Map<string, number>();
  let projectSearchCalls = 0;
  let documentReadCalls = 0;

  try {
    const maxTurns = options.maxTurns ?? 20;
    let turnStart = messages.length;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const step = turn + 1;
      const stepModel = documentProposalSubmitted ? model : executionModel;
      emit({ type: "step_start", step });
      const result = await streamCompletion(stepModel, messages, signal, (text) => {
        transcript += text;
        emit({ type: "text", text, channel: "output" });
      }, (text) => emit({ type: "text", text, channel: "reasoning" }), !documentProposalSubmitted);
      if (result.usage) {
        emitUsageEvent(emit, store, sessionId, stepModel, result.usage, step);
      }
      if (!result.toolCalls.length) {
        emit({ type: "step_done", step });
        const answer = stripDsmlText(transcript, "").trim() || "任务已处理。";
        store.addMessage(sessionId, "assistant", answer);
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
      for (const call of result.toolCalls) {
        emit({ type: "tool", name: call.name });
        let toolResult: string;
        if (call.name === "search_project" && ++projectSearchCalls > 2) {
          toolResult = JSON.stringify({ error: "本轮项目搜索已达到两次上限；请使用已有结果和最小文档截取继续。" });
        } else if (DOCUMENT_READ_TOOLS.has(call.name) && ++documentReadCalls > MAX_DOCUMENT_READS_PER_RUN) {
          toolResult = JSON.stringify({
            error: `本轮文档读取已达 ${MAX_DOCUMENT_READS_PER_RUN} 次上限；请使用写作引导、工作记忆和已有工具结果继续写作或提交提案，不要再次读取。`,
          });
        } else {
          toolResult = await executeToolCached(call, project, store, sessionId, emit, toolCallCounts, characterScope, toolContext);
        }
        if (call.name === "propose_document" || call.name === "propose_document_patch" || call.name === "propose_outline_patch") {
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
      // Close checklist as soon as the turn-ending action happens. manage_todos in the
      // same batch may have left the last item open; always re-finalize after all tools.
      if (documentProposalSubmitted) {
        persistFinalizedSessionTodos(store, sessionId, emit);
        break;
      }
      if (waitingForUser) break;
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
        if (assistantParts.length) store.addMessage(sessionId, "assistant", assistantParts.join("\n\n"));
      } catch { /* 消息保存失败不影响流程 */ }
      if (waitingEvent) emit({ type: "waiting_for_input", sessionId, ...waitingEvent });
      return;
    }
    if (documentProposalSubmitted) {
      try {
        for (let i = turnStart; i < messages.length; i++) {
          const msg = messages[i];
          if (msg.role === "assistant" && msg.content?.trim()) {
            store.addMessage(sessionId, "assistant", msg.content.trim());
          }
        }
      } catch { /* 消息保存失败不影响流程 */ }
      // Proposal ends the turn immediately (no extra manage_todos turn); close the checklist.
      persistFinalizedSessionTodos(store, sessionId, emit);
      emit({ type: "done", sessionId });
      return;
    }
    const debugContext = runtimeDebugContext(messages, {
      task: task.label,
      model: executionModel.model,
      turns: maxTurns,
      transcript,
    });
    store.addSystemMessage(sessionId, debugContext);
    throw new Error("Agent 工具调用次数超过限制；中途上下文已保存到当前会话");
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      if (transcript.trim()) store.addMessage(sessionId, "assistant", `${transcript.trim()}\n\n[生成已中断]`);
      emit({ type: "cancelled", sessionId });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "error", message });
    throw error;
  }
}

const REVIEW_PROMPT = `你现在是小说终审编辑。目标是降低机器生成感，不是把文字改成另一种统一腔调。
先调用 audit_prose_style 获取带行列和语境分类的问题。优先处理 severity=error；warning 仅在明显模板化且影响阅读时改；info 一律保留。
${proseMannerismConstraintPrompt({ compact: true })}
必须保留：对白拖音/中断/迟疑（speech_*）、对话纠正（dialogue_correction）、系统/元数据、叙事停顿—揭示与同位命名（ambiguous_dash / appositive_definition）。见破折号就删是错误策略。
逐段检查并修改：模板化转折和连接词；紧跟动作、对白或细节之后的重复解释回声；说明性破折号与抽象「不是…而是」堆砌；用单一标签包办人物的写法；整齐但空泛的排比；句长段长过度均匀；无意义的总结升华；角色都说同一种完整书面语。
说明类问题优先：让动作产生结果；用可观察细节供读者判断；必要因果拆成独立句。不要为“消说明体”而把有力的停顿、揭示或人物声线抹平。
在忠于原意的前提下让行文更生动：把笼统判断和情绪说明尽量落到可见动作、选择及其代价、身体反应、环境变化、声音、触感或人物独有的观察上。证据已经足够时直接删掉解释，不必逐句改写。让对白带有身份、关系和当下情绪造成的语气差异；按场景张力调整句长、停顿和段落节奏。优先选择准确、有画面的动词和名词，不要靠密集形容词、副词、华丽比喻、感官清单或连续短句制造虚假的生动感。不得为了增加画面而凭空添加事件、道具、设定、心理动机或角色不知道的信息。
不要用随机同义替换、强行拆句、故意病句、滥加口语或无关细节伪装成人类写作。机器感应通过减少句法模板、增加语义与观察角度的差异、保留叙事重点造成的轻重和不对称来消除。
优先保留具体、有个性、略带不规则的表达。允许短句、停顿、省略和留白。不得新增剧情、设定或人物动机，不得改变事实、视角、时序和角色声线。没有问题的句子保持原样，禁止为了显示工作量而改写。
必须针对用户指定的 Markdown 文档提交修改提案。局部问题使用 propose_document_patch；问题遍布全文时才使用 propose_document。提案摘要要具体说明消除了哪些机器化表达。不要只输出审阅意见。`;

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
  return `[Agent 调试上下文：工具调用达到上限]\n${payload}`;
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
    if (!content.includes(text)) throw new Error(`${reference.path} 中的选区已失效，请重新选择`);
    return `文档：${reference.path} · 用户选区\n${text}`;
  });
  return sections.length ? `用户从网页浏览器明确加入了以下文本选区。只把它们作为本轮上下文，不要自行扩展为整篇文档：\n\n${sections.join("\n\n---\n\n")}` : "";
}

function recentArtifactsContext(store: WriterStore, sessionId: string, project: WriterProject, task: WritingTask): string {
  const state = store.sessionContext(sessionId);
  let artifacts = store.recentContextArtifacts(sessionId, 8);
  // New dialogue turn (not continuation): never inject whole-session residue — only the current target path, if any.
  if (!task.continuation) {
    const focusPath = task.targetPath ?? state.activeDocument;
    if (!focusPath) return "";
    artifacts = artifacts.filter(item => item.path === focusPath);
    if (!artifacts.length) return "";
  }
  if (!artifacts.length && !state.activeDocument && !state.currentIntent) return "";
  const activePath = task.continuation ? state.activeDocument : (task.targetPath ?? state.activeDocument);
  const activeHash = activePath && project.documentExists(activePath)
    ? project.hash(project.read(activePath))
    : undefined;
  // Prefer catalog + digests in the miss-priced dynamic tail. Only restore one body on
  // continuation (tail of the active doc) so the model can keep writing without a re-read.
  const restored: Array<Record<string, unknown>> = [];
  if (task.continuation) {
    for (const artifact of artifacts) {
      if (artifact.kind !== "read_document" && artifact.kind !== "inspect_document") continue;
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
    .filter(item => item.kind === "read_document" || item.kind === "inspect_document"
      || item.kind === "get_outline_node" || item.kind === "list_outline_nodes")
    .map(({ id, kind, path, sourceHash, digest }) => ({
      id, kind, path, sourceHash,
      digest: digest.replace(/\s+/g, " ").slice(0, 240),
    }));
  if (!catalog.length && !restored.length) return "";
  const scopeNote = task.continuation
    ? "承接上一轮：catalog 列出已读资料（文档未变时禁止重复 inspect/read/list_outline_nodes）；restoredReads 至多含一段末尾正文可直接续写"
    : "仅当前目标文档相关索引（非会话级残留）；正文未注入时请按需 read 最小片段，或对相同 path+sourceHash 使用已有工具结果";
  return `本轮任务工作记忆（${scopeNote}）：\n${JSON.stringify({
    state: { activeDocument: state.activeDocument, currentIntent: state.currentIntent.slice(0, 160) },
    artifacts: catalog,
    restoredReads: restored,
  })}`;
}

/**
 * Conservative write hints: index only (ids/paths), no full prose or character cards.
 * Step 1 tool reads remain the source of truth for actual content.
 */
function writingBootstrapContext(project: WriterProject, store: WriterStore, prompt: string, task: WritingTask): string {
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
- 需要情节细节：用 outlineNodes[].id 调用 get_outline_node（id 为 UUID，不是章号）。
- 需要衔接：对 previousChapterCandidates 中的路径 read_document(lastSection=true) 一次。
- 需要人设：对 characterIndex 中的 id 调用 get_character（可带 sections；场景状态需传 outlineNodeId）。
- 目标文档：对 targetDocumentCandidates 中的路径 inspect 或按需读取；路径不存在时按项目惯例新建，勿盲目使用未列出的路径。
- 禁止：重复 list_outline_nodes、通读整本大纲、对同一路径反复 read。
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

const CACHEABLE_TOOLS = new Set(["list_documents", "inspect_document", "read_document", "search_project", "audit_prose_style", "list_outline_nodes", "get_outline_node", "validate_outline", "compare_outline_with_draft"]);
const DOCUMENT_READ_TOOLS = new Set(["inspect_document", "read_document"]);
const MAX_READS_PER_PATH_PER_RUN = 3;
const MAX_DOCUMENT_READS_PER_RUN = 5;
/** Structural / catalog tools must stay intact so the model does not re-list after compaction. */
const NEVER_COMPACT_KEYS = new Set(["nodes", "matches", "issues"]);

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
  if (!CACHEABLE_TOOLS.has(call.name)) return executeTool(call, project, store, sessionId, emit, characterScope, context);
  let input: Record<string, unknown>;
  try { input = JSON.parse(call.arguments || "{}") as Record<string, unknown>; }
  catch { return executeTool(call, project, store, sessionId, emit, characterScope, context); }
  const normalized = Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) =>
    [key, typeof value === "string" ? value.trim() : value]));
  const path = typeof normalized.path === "string" ? normalized.path : undefined;
  const outlinePath = call.name.includes("outline") ? resolveOutlineSourcePath(project) : undefined;
  const sourcePath = path ?? (outlinePath && project.documentExists(outlinePath) ? outlinePath : undefined);
  const sourceHash = sourcePath && project.documentExists(sourcePath)
    ? project.hash(project.read(sourcePath))
    : project.hash(JSON.stringify(project.listDocuments()));

  // Throttle thrashing the same document with slightly different ranges.
  if (DOCUMENT_READ_TOOLS.has(call.name) && sourcePath) {
    const pathKey = `path-read:${sourcePath}:${sourceHash}`;
    const pathCount = (counts.get(pathKey) ?? 0) + 1;
    counts.set(pathKey, pathCount);
    if (pathCount > MAX_READS_PER_PATH_PER_RUN) {
      const recent = store.recentContextArtifacts(sessionId, 8)
        .filter(item => item.path === sourcePath && item.sourceHash === sourceHash)
        .map(item => ({ id: item.id, kind: item.kind, digest: item.digest }));
      return JSON.stringify({
        error: `本轮已对 ${sourcePath} 读取 ${MAX_READS_PER_PATH_PER_RUN} 次且文档未变；请使用已有工具结果或工作记忆继续，不要再次读取。`,
        path: sourcePath,
        sourceHash,
        availableArtifacts: recent,
      });
    }
  }

  // list_outline_nodes / list_documents: hard-stop after first success this run
  if (call.name === "list_outline_nodes" || call.name === "list_documents") {
    const listKey = `list-once:${call.name}:${sourceHash}`;
    const listCount = (counts.get(listKey) ?? 0) + 1;
    counts.set(listKey, listCount);
    if (listCount > 1) {
      const cachedList = store.recentContextArtifacts(sessionId, 12).find(item => item.kind === call.name && item.sourceHash === sourceHash);
      if (cachedList) {
        const full = store.contextArtifactById(sessionId, cachedList.id);
        if (full) {
          return withReuseMarker(full.content, `${call.name} 本轮已调用过；以下从工作记忆恢复，禁止再次列出。`, cachedList.id);
        }
      }
      return JSON.stringify({ error: `${call.name} 本轮已调用过；请使用已有结果中的 id/path，不要再次列出。` });
    }
  }

  const cacheKey = `${call.name}:${JSON.stringify(normalized)}:${sourceHash}`;
  const count = (counts.get(cacheKey) ?? 0) + 1;
  counts.set(cacheKey, count);
  const cached = store.contextArtifact(sessionId, cacheKey);
  if (count > 3) {
    return JSON.stringify({
      error: "相同工具调用已重复三次，结果没有变化；请使用现有工作记忆继续，不要再次调用。",
      path: cached?.path ?? sourcePath,
      digest: cached?.digest,
    });
  }
  if (cached) {
    return withReuseMarker(cached.content,
      count === 1
        ? "工作记忆中已有相同且未变化的工具结果；以下为完整内容，请直接使用，勿再次读取。"
        : "相同读取已执行过且文档未变；以下从工作记忆恢复完整结果，请直接使用，禁止再次调用。",
      cached.id);
  }
  const result = await executeTool(call, project, store, sessionId, emit, characterScope, context);
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

function compactHistory(messages: Array<{ role: string; content: string; channel?: string }>): Array<ApiMessage & { channel?: string }> {
  // Slimmer window: dynamic-tail history is miss-priced every turn.
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
 * Use only when *rebuilding* a transcript for a new user turn — never mid-job between
 * tool steps, or step-to-step prompt-cache prefixes will miss.
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
 * Older digests stay compact so multi-step prompts stop growing with full chapter text.
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
      message.content = withReuseMarker(full.content, "已从工作记忆恢复最近工具结果；禁止再次读取同一内容。", artifactId);
    } catch { /* ignore non-JSON tool payloads */ }
  }
}

/** Drop reasoning_content on older assistant turns to cut re-sent output-side bulk. */
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
 * Strip older propose_* payloads when rebuilding a multi-proposal transcript outside
 * an active job. Not used mid-job (append-only) so prefix cache stays intact.
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
): void {
  const estimated = usage.estimated === true;
  const call = toStepUsage(usage, model.pricing);
  let sessionUsage: UsageSummary = store.usage(sessionId);
  // Only bill/store provider-reported usage; estimates stay UI-only.
  if (model.pricing && !estimated) {
    sessionUsage = store.recordUsage(sessionId, model.model, usage, model.pricing);
  }
  emit({
    type: "usage",
    usage: sessionUsage,
    call,
    ...(step !== undefined ? { step } : {}),
  });
}

async function streamCompletion(
  model: ModelConfig,
  messages: ApiMessage[],
  signal: AbortSignal | undefined,
  onText: (text: string) => void,
  onReasoning: (text: string) => void,
  toolsEnabled = true,
): Promise<{ content: string; reasoningContent: string; toolCalls: ToolAccumulator[]; usage?: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number } }> {
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const requestBody = JSON.stringify({
    model: model.model, messages, ...(toolsEnabled ? { tools: TOOLS } : {}), stream: true,
    stream_options: { include_usage: true },
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(model.topP !== undefined ? { top_p: model.topP } : {}),
  });
  logModelRequest(endpoint, requestBody);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body: requestBody,
    signal,
  });
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
      const delta = chunk.choices?.[0]?.delta;
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
