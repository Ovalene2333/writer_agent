import type { AgentEvent, Character, ModelConfig, StepUsage, UsageSummary } from "./types.js";
import { documentKind, resolveOutlineSourcePath, WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { getStyleTemplate } from "./templates.js";
import { documentBlocks, documentSections } from "./document_blocks.js";
import { contrastStyleError } from "./prose_quality.js";
import { OutlineStore } from "./outline.js";
import { logModelRequest, logModelResponse } from "./model_debug.js";
import { isIntensiveWritingMode, styleFingerprint, styleGroundingPrompt } from "./style_grounding.js";
import { calculateUsageCost } from "./pricing.js";

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

type ToolAccumulator = { id: string; name: string; arguments: string };

type WritingTaskMode = "brainstorm" | "outline" | "write_scene" | "rewrite" | "audit" | "general";
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

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_documents",
      description: "列出作品中的 Markdown 文档（含 kind：lore 设定 / outline 大纲 / chapter 正文 / archive 旧稿 / side 支线 / other）",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_document",
      description: "查看文档行数、字符数、标题结构和首尾预览，不读取完整正文。长文档应先调用此工具",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "项目内相对路径" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description: "按 Markdown 标题节、自然边界块或行范围截取文档。搜索结果已有行号时优先读取最小行范围；长文档先用 inspect_document 查看结构",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "项目内相对路径" },
          block: { type: "number", description: "块编号，1 开始；默认读取第 1 块" },
          section: { type: "string", description: "按 Markdown 标题读取一节；填写 inspect_document 返回的标题文字（不含 #）" },
          lastSection: { type: "boolean", description: "读取文档最后一个 Markdown 标题节；续写时优先使用" },
          startLine: { type: "number", description: "起始行，1 开始；必须与 endLine 同时提供" },
          endLine: { type: "number", description: "结束行（包含）；最多读取 200 行和 12000 字符" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_project",
      description: "像代码搜索一样在项目 Markdown 中定位概念或设定，返回路径、所属标题、行号和上下文。需要逐字事实时再用 read_document 截取",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "概念、专有名词或短查询" },
          scope: {
            type: "string",
            enum: ["all", "lore", "story", "outline", "chapters"],
            description: "文档范围：lore=设定（story 为旧别名）、outline=大纲、chapters=正文；世界观/专名优先 lore",
          },
          pathPrefix: { type: "string", description: "可选相对目录前缀，例如 lore、outline、chapters" },
          mode: { type: "string", enum: ["any", "all", "exact"], description: "任一词、全部词或精确短语" },
          contextLines: { type: "number", description: "匹配行前后上下文，0～12，默认 2" },
          limit: { type: "number", description: "结果数，1～12，默认 8" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_outline_nodes",
      description: "读取结构化故事大纲目录，返回稳定节点 ID、层级、摘要、状态和正文关联。规划、续写或检查情节时优先使用",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["act", "chapter", "scene"], description: "可选节点类型过滤" },
          status: { type: "string", enum: ["idea", "planned", "drafted", "diverged"], description: "可选状态过滤" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_outline_node",
      description: "读取大纲节点的结构化字段和 Markdown 原文。优先使用写作引导或 list_outline_nodes 返回的 UUID；也可用精确标题。不要用纯章号数字当 id（系统会尝试解析但可能歧义）",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "大纲节点 UUID，或唯一标题；不要把“5”当作 id" } },
        required: ["id"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_outline_patch",
      description: "针对一个已读取的大纲节点提交局部 Markdown 搜索替换提案。修改仍需作者审批；search 必须在该节点原文内且在整篇大纲中唯一",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "已通过 get_outline_node 读取的节点 ID" },
          search: { type: "string", description: "节点原文中的唯一精确文本" },
          replace: { type: "string", description: "替换后的 Markdown" },
          summary: { type: "string", description: "一句话概括修改目的" },
        },
        required: ["id", "search", "replace", "summary"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "validate_outline",
      description: "检查场景节点是否缺少前因、行动、结果、状态变化、人物或正文关联，并检查未回收伏笔",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_outline_with_draft",
      description: "将一个已关联正文的大纲场景与对应正文做基础偏离检查，返回正文证据和需要人工确认的差异",
      parameters: {
        type: "object", properties: { id: { type: "string", description: "场景节点 ID" } },
        required: ["id"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_document",
      description: "提交文档完整新版本；仅用于新建文档或全文重写，局部修改应使用 propose_document_patch",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "已读取的 Markdown 文档路径" },
          content: { type: "string", description: "修改后的完整 Markdown 内容" },
          summary: { type: "string", description: "一句话概括修改目的" },
        },
        required: ["path", "content", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_document_patch",
      description: "用精确搜索替换提交局部修改提案，避免输出整篇文档。每段 search 必须在原文中唯一出现。续写时读取文档末尾，将唯一尾段作为 search，并把原尾段与新增正文共同作为 replace",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "已读取相关片段的 Markdown 文档路径" },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                search: { type: "string", description: "原文中唯一存在的精确文本" },
                replace: { type: "string", description: "替换后的文本；空字符串表示删除" },
              },
              required: ["search", "replace"],
              additionalProperties: false,
            },
          },
          summary: { type: "string", description: "一句话概括修改目的" },
        },
        required: ["path", "edits", "summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_characters",
      description: "列出作品中的全部角色卡",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_character",
      description: "按 ID 读取角色卡。写作时用 fields 选择必要字段以节省上下文；修改角色卡时省略 fields 读取完整卡片",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "角色 ID；先调用 list_characters 获取" },
          fields: { type: "array", description: "只读取本次任务需要的字段；省略则读取完整角色卡", items: { type: "string", enum: [
            "aliases", "narrativeRole", "identity", "appearance", "personality", "values", "speechStyle", "background",
            "longTermGoal", "currentGoal", "fears", "capabilities", "limitations", "relationships", "notes",
          ] } },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_character",
      description: "创建或更新角色卡（结构化 JSON，存入 characters/ 目录）。修改已有角色时必须传入 id，否则会创建新角色。先 list_characters 获取角色 ID 和名称，再用此工具创建或更新",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "要更新的角色 ID（修改已有角色时必填，新建角色时省略）" },
          name: { type: "string", description: "角色姓名（必填）" },
          narrativeRole: { type: "string", description: "叙事定位，如主角、配角、反派" },
          identity: { type: "string", description: "职业、社会身份或阵营身份" },
          aliases: { type: "array", items: { type: "string" }, description: "别名、称号" },
          appearance: { type: "string", description: "外观服饰：身高体型、面容特征、衣着风格" },
          personality: { type: "string", description: "稳定的性格与行为倾向" },
          values: { type: "string", description: "价值观、原则与底线" },
          speechStyle: { type: "string", description: "措辞、语气、口头习惯和说话节奏" },
          background: { type: "string", description: "背景故事" },
          longTermGoal: { type: "string", description: "长期欲望或最终目标" },
          currentGoal: { type: "string", description: "当前阶段正在争取的具体目标" },
          fears: { type: "string", description: "恐惧、软肋或极力避免的结果" },
          capabilities: { type: "string", description: "技能、知识、能力和可支配资源" },
          limitations: { type: "string", description: "能力边界、缺陷、代价和现实限制" },
          relationships: { type: "array", description: "与已有角色的结构化关系；先用 list_characters 获取 ID", items: { type: "object", properties: {
            characterId: { type: "number" }, type: { type: "string" }, description: { type: "string" }, attitude: { type: "string" },
          }, required: ["characterId", "type", "description", "attitude"], additionalProperties: false } },
          notes: { type: "string", description: "补充说明" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "缺少目标文档、既有事实或会改变结果的关键选择，且无法从当前上下文可靠推断时，向用户提一个简短问题并暂停。情节、对白、描写等可逆创作选择应自行作合理决定，不要过度询问；不要与其他工具同时调用",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "向用户提出的问题（简短，不超过 120 字）" },
          options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5, description: "可选答案列表；如不需要选项则省略" },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
] as const;

const TOOL_NAMES = new Set<string>(TOOLS.map(tool => tool.function.name));

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

文档分区（必须遵守，勿把不同类型内容写进同一路径）：
- lore/：设定与事实源（世界规则、专名、组织、力量体系、地理政治等）。只写可检索事实，不写章节散文。
- outline/：情节计划（卷/章/场景、前因结果、伏笔）。不写可发表正文。
- chapters/：唯一主线正文；续写、改写、导出默认只针对这里。
- side/：支线或间章（非主线导出）；archive/：旧稿与弃用版，默认不要当作现行事实，也不要主动写入。
- characters/：角色卡（结构化工具维护，不是 Markdown 散文）。
旧项目若仍使用 story/，视为 lore/ 的等价目录。

正文底线（所有模式）：
1. 用动作、选择、代价、停顿、对白和具体感官呈现人物，避免紧随其后的情绪、潜台词或象征解释。
2. 禁止解释性破折号与“不是……而是……”类模板对照句（细则见风格锚定自检）。
3. 对白服从人物身份与当下目的；场景落在具体动作、决定、发现或未决问题上。
4. 不编造 lore/角色卡未支撑的关键设定；区分项目事实与合理创作推断。
`;
}

function executionRulesPrompt(): string {
  return `执行规则：
1. 按本轮任务计划决定是否读取项目资料。需要项目事实时先 search_project（世界观/专名 scope=lore，情节计划 scope=outline，已写正文 scope=chapters），再读取最小相关片段；每轮最多搜索两次。区分项目事实与推测。
2. 保持既有人物、世界观、视角和 Markdown 结构。局部修改用补丁；大纲节点用大纲补丁；新建或全文重写才提交完整文档。新建设定→lore/，新建大纲→outline/，新建正文→chapters/；不要把设定写进章节，也不要把正文写进 lore。
3. 写正文、续写、扩写或改写必须提交文档提案，不能用最终回复代替。提案提交后立即停止并等待审批。
4. 只有缺少目标文档、既有事实或会实质改变结果的关键选择，且无法可靠推断时才调用 ask_user。情节、对白和描写等可逆创作选择自行作合理决定。询问后立即停止。
5. 管理角色使用 save_character。修改前读取完整卡片并保留未要求修改的字段；写作时只读取所需角色字段。
6. 资料复用：会话工作记忆、本轮工具结果、带 reused 标记的返回可直接复用，禁止对同一路径/同一参数反复读取，禁止重复 list_outline_nodes。系统「写作线索」只是未验证的候选索引，需要正文或完整人设时仍应用工具取最小片段。大纲节点 id 是 UUID，不是章号。artifact_compacted 只用 digest，不要因此改换参数反复试读。
7. 不泄露内部参数，不使用项目范围外的信息；对话简洁，文档使用适量 Markdown。`;
}

function dynamicContextPrompt(project: WriterProject, store: WriterStore, request: string, task: WritingTask, characterScope?: number[], continuationPath?: string): string {
  const explicitReferences = explicitReferencePaths(project, request);
  const inferredTargets = task.targetPath && !explicitReferences.includes(task.targetPath) ? [task.targetPath] : [];
  const references = [...new Set([...explicitReferences, ...inferredTargets])];
  const creativeContext = structuredCreativeContext(store, task, characterScope);
  const characterScopeInstruction = characterScope === undefined
    ? "角色资料按任务相关性自动筛选。"
    : characterScope.length
      ? `用户仅允许关联角色 ID：${characterScope.join("、")}。不得读取、列出或关联范围外的角色。`
      : "用户明确选择不关联任何已有角色。不得读取或列出其他角色资料。";
  const documentInstruction = task.documentProposalRequired
    ? `本次请求必须产生文档提案后才能结束。不得把正文直接作为最终回复；须基于目标 Markdown 文档提交 propose_document_patch 或 propose_document。若工作记忆或本轮工具结果已含目标文档相关原文且文档未变，可直接提案，不必再次读取。${continuationPath ? `本次是承接上一轮的简短续写，默认目标文档为 ${continuationPath}。` : ""}`
    : "本次请求不强制产生文档提案，按用户意图执行。";
  const contextInstruction: Record<DocumentContextMode, string> = {
    none: "无需读取项目文档。直接使用当前对话完成任务；不要调用 list_documents、search_project、inspect_document 或 read_document。",
    search: `需要核对项目资料。先调用 search_project，查询：${task.searchQuery || request.slice(0, 120)}。仅在检索片段不足时继续 inspect_document/read_document；同一路径只读取一次最小范围。`,
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
  audit: "一致性与质量审校", general: "通用写作协作",
};

async function planWritingTask(
  model: ModelConfig, project: WriterProject, store: WriterStore, request: string, history: ApiMessage[], signal?: AbortSignal,
): Promise<{ task: WritingTask; usage?: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number } }> {
  const documents = project.listDocuments().filter(path => !project.isDocumentHidden(path));
  const characters = store.characters().map(item => ({ id: item.id, name: item.name, aliases: item.aliases, narrativeRole: item.narrativeRole, identity: item.identity }));
  const activeStyleId = project.config().style;
  const activeStyle = activeStyleId ? getStyleTemplate(activeStyleId) : undefined;
  const examples = store.writingExamples()
    .filter(item => !item.title.startsWith("[风格模板]") || item.title === `[风格模板] ${activeStyle?.name}`)
    .map(item => ({ id: item.id, title: item.title, category: item.category, notes: item.notes.slice(0, 160) }));
  const recent = history.slice(-6).map(item => item.role === "user"
    ? { content: item.content?.slice(0, 800) ?? "" }
    : { role: item.role, content: item.content?.slice(0, 800) ?? "" });
  const planningMessages: ApiMessage[] = [{
    role: "system",
    content: `你是写作 Agent 的任务规划器。根据语义而非关键词判断用户真正要做什么。只输出一个 JSON 对象，不输出 Markdown。
字段：mode（brainstorm/outline/write_scene/rewrite/audit/general）；documentContext（none/search/target/continuation）；targetPath（当前请求明确或语义上可确定目标文档时，必须从文档目录原样选择一个路径，否则省略）；searchQuery（仅在 documentContext=search 时提供简短查询）；characterIds（确实需要角色资料时最多 4 个，否则空数组）；exampleIds（确实需要范文时最多 2 个，否则空数组）；documentProposalRequired（用户要求创作或者修改场景、正文、大纲时为 true，纯讨论、构思、分析、建议、角色卡操作为 false）；continuation（当前请求是否承接上一轮写作任务）。
决策原则：当前 user 消息是唯一的当前任务，优先级高于“最近对话”；最近对话只用于解析“继续、按刚才方案、改一下它”等省略和指代，不得把旧任务的修改要求合并到当前明确指令中。只有回答依赖项目中未出现在对话里的事实时才读取文档。泛化写作问题、闲聊、纯构思默认 none；需要跨文档查事实用 search；用户指定单篇文档或要求修改现有内容用 target；承接上一轮正文用 continuation。不要因为这是写作 Agent 就默认读取文档。
路径约定：lore/=设定事实，outline/=情节计划，chapters/=主线正文，side/=支线，archive/=旧稿。为正文写作选 targetPath 时优先 chapters/；为大纲任务优先 outline/；查世界观优先在 lore/ 上 search。
文档目录（只有路径，尚未读取正文）：${JSON.stringify(documents)}
角色目录：${JSON.stringify(characters)}
范文目录：${JSON.stringify(examples)}
历史对话数据：${JSON.stringify(recent)}`,
  }, { role: "user", content: request }];
  const result = await streamCompletion(model, planningMessages, signal, () => undefined, () => undefined, false);
  const firstBrace = result.content.indexOf("{");
  const lastBrace = result.content.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error("任务规划器没有返回有效 JSON");
  const parsed = JSON.parse(result.content.slice(firstBrace, lastBrace + 1)) as Partial<WritingTask>;
  const modes: WritingTaskMode[] = ["brainstorm", "outline", "write_scene", "rewrite", "audit", "general"];
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
  const normalizedDocumentContext = continuation
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
  const continuation = /^(继续|接着|续写|往下写)(?:[。！!，,\s]|$)/.test(request.trim());
  const rewrite = /(改写|重写|润色|修改).*(这一段|这段|选区)/.test(request);
  const audit = /(审阅|检查|校对|找问题)/.test(request) && references.length > 0;
  const targetPath = references[0] ?? (continuation ? sessionContext.activeDocument ?? store.proposals().find(item => item.sessionId === sessionId)?.path : undefined);
  if (continuation && targetPath) return { mode: "write_scene", label: TASK_LABELS.write_scene, documentContext: "continuation", targetPath,
    searchQuery: request.slice(0, 200), characterIds: [], exampleIds: [], documentProposalRequired: true, continuation: true };
  if (rewrite && targetPath) return { mode: "rewrite", label: TASK_LABELS.rewrite, documentContext: "target", targetPath,
    searchQuery: request.slice(0, 200), characterIds: [], exampleIds: [], documentProposalRequired: true, continuation: false };
  if (audit) return { mode: "audit", label: TASK_LABELS.audit, documentContext: "target", targetPath,
    searchQuery: request.slice(0, 200), characterIds: [], exampleIds: [], documentProposalRequired: false, continuation: false };
  if (references.length === 1) {
    const writing = /(写|续写|扩写|改写|重写|修改|润色)/.test(request);
    return { mode: writing ? "write_scene" : "general", label: TASK_LABELS[writing ? "write_scene" : "general"], documentContext: "target",
      targetPath, searchQuery: request.slice(0, 200), characterIds: [], exampleIds: [], documentProposalRequired: writing, continuation: false };
  }
  return undefined;
}

function taskInstructions(mode: WritingTaskMode): string {
  if (mode === "brainstorm") return `本次工作流：
- 先明确人物欲望、阻力、失败代价和不可逆后果。
- 给出三个真正不同的候选方向，分别说明核心冲突与后续潜力。
- 不把候选设想写入项目事实，除非作者明确选定。`;
  if (mode === "outline") return `本次工作流：
- 大纲文档在 outline/（旧项目可能是 story/outline.md）。先调用 list_outline_nodes 了解“卷/幕—章—场景”结构；读取或修改具体节点时用 get_outline_node，不要靠全文搜索猜测节点边界。
- 每个场景节点维护前因、行动、结果和状态变化；同时维护人物弧、信息释放、伏笔埋设与回收。
- 修改既有节点使用 propose_outline_patch 提交局部提案；结构完整性检查使用 validate_outline。
- 新建大纲写入 outline/，不要写入 chapters/ 或 lore/。
- 大纲场景推荐字段格式：摘要、前因、行动、结果、状态变化、角色ID、地点、时间、情节线、伏笔、回收、状态、文档、正文章节。字段写成 Markdown 列表“字段：值”。`;
  if (mode === "write_scene") return `本次工作流（内部执行，不输出分析过程）：
1. 先读「风格锚定」：对齐本项目声线样本与模板节奏，再动笔；禁止写成与样本句长/对白密度明显不同的通用腔。
2. 「写作线索」只是候选索引。Step 1 最小核对：情节用 get_outline_node（UUID）；衔接用上一章 read_document(lastSection=true)；人设用 get_character 必要字段；目标文档存在则 inspect 或读一次草稿/末段。
3. 不要通读整本大纲、不要 list_outline_nodes 超过一次、不要对同一路径反复 read。
4. 落笔前在内部明确：场景开场、人物目标、阻力、不可逆结果；正文默认 chapters/；设定说明不进正文。
5. 写作时持续对照风格锚定的指纹与范文；对白区分人物；不引入未支撑设定。
6. 提交前自检：解释性“——”、“不是……而是……”、段尾升华、与样本声线漂移。
7. 新建或空文档用 propose_document；已有正文用 propose_document_patch。提交后停止。`;
  if (mode === "rewrite") return `本次工作流（内部执行，不输出分析过程）：
- 先读「风格锚定」与原文声线；改写后的句长、对白密度须仍贴近原文/样本，除非作者明确要求换风格。
- 只改变作者明确要求调整的维度，保持其余事件事实、人物动机和信息顺序不变。
- 风格变化必须落实到叙述距离、句法节奏、对白比例、感官重点和信息释放，而不是同义替换。
- 保留原文有辨识度的不规则表达，不把句子统一润色成工整、完整、均匀的书面语。
- 优先用具体名词和动词替换泛化情绪、程度副词与装饰性修辞；避免为了“更有文采”新增比喻、总结或升华。
- 对照原文检查信息损失与新增事实，优先通过局部补丁提案提交。`;
  if (mode === "audit") return `本次工作流：
- 每个问题必须给出严重度、原文证据、违反的既有事实或叙事约束，以及最小修改建议。
- 没有文本证据的问题不得提出；区分确定矛盾与可能风险。
- 用户只要求检查时不要创建修改提案；明确要求修复时才提交提案。`;
  return "本次工作流：先判断任务属于构思、规划、写作、改写或审校，再遵循对应流程。涉及正文修改时必须先读取原文并提交提案。";
}

function structuredCreativeContext(store: WriterStore, task: WritingTask, characterScope?: number[]): string {
  const rankedCharacters = store.characters().map((item) => ({
    item, score: task.characterIds.includes(item.id) ? 1 : 0,
  })).sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "zh-CN"));
  const scopedIds = characterScope === undefined ? undefined : new Set(characterScope);
  const selectedCharacters = scopedIds
    ? rankedCharacters.filter(entry => scopedIds.has(entry.item.id))
    : rankedCharacters.filter((entry) => entry.score > 0).slice(0, 4);
  const characters = selectedCharacters.map(({ item }) => ({
    id: item.id, name: item.name, aliases: item.aliases, narrativeRole: item.narrativeRole, identity: item.identity,
  }));
  // Writing tasks always surface style/user examples even if the planner left exampleIds empty.
  const writing = isIntensiveWritingMode(task.mode) || task.documentProposalRequired;
  const rankedExamples = store.writingExamples().map((item) => {
    let score = task.exampleIds.includes(item.id) ? 3 : 0;
    if (writing && item.title.startsWith("[风格模板]")) score = Math.max(score, 1);
    if (writing && !item.title.startsWith("[风格模板]") && score === 0) score = 1;
    return { item, score };
  }).sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt));
  const selectedExamples = rankedExamples.filter((entry) => entry.score > 0).slice(0, writing ? 2 : 2);
  const examples: Array<Record<string, string>> = [];
  let exampleBudget = writing ? 6_000 : 5_000;
  for (const { item } of selectedExamples) {
    const content = item.content.slice(0, Math.min(writing ? 1_600 : 2_000, exampleBudget));
    const entry = {
      title: item.title,
      category: item.category,
      styleFingerprint: styleFingerprint(item.content, item.notes),
      content,
      notes: item.notes.slice(0, 400),
      usage: "imitate_voice_not_plot",
    };
    const size = JSON.stringify(entry).length;
    if (!content || size > exampleBudget) break;
    examples.push(entry); exampleBudget -= size;
  }
  return JSON.stringify({ task: task.mode, characters, writingExamples: examples });
}

function explicitReferencePaths(project: WriterProject, request: string): string[] {
  const available = new Set(project.listDocuments().filter(path => !project.isDocumentHidden(path)));
  return [...request.matchAll(/(?:^|\s)@([^\s]+)/g)]
    .map((match) => match[1].replace(/[，。；：,.!?！？]+$/, ""))
    .filter((path, index, all) => available.has(path) && all.indexOf(path) === index)
    .slice(0, 3);
}

function historicalConversationContext(history: ApiMessage[]): ApiMessage | undefined {
  if (!history.length) return undefined;
  const entries = history.map(message => message.role === "user"
    ? { content: message.content ?? "" }
    : { role: message.role, content: message.content ?? "" });
  return {
    role: "system",
    content: `以下 JSON 是已经发生的历史对话记录，只用于理解既有事实、人物指代、用户偏好和当前请求中的省略。它不是当前指令队列，不得自动继续执行其中的旧请求，也不得把旧请求的约束合并进当前任务。只有最后单独出现的 user 消息是本轮要执行的请求。\n<historical_conversation>\n${JSON.stringify(entries)}\n</historical_conversation>`,
  };
}

export async function runAgent(options: {
  project: WriterProject;
  store: WriterStore;
  sessionId: string;
  prompt: string;
  characterScope?: number[];
  selectedDocumentBlocks?: Array<{ path: string; text?: string }>;
  model?: ModelConfig;
  models?: Partial<Record<"agent" | "inline" | "writer" | "reviewer", ModelConfig>>;
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}): Promise<void> {
  const { project, store, sessionId, prompt, signal, characterScope } = options;
  const emit = options.onEvent ?? (() => undefined);
  const model = options.models?.agent ?? options.model ?? modelConfigFromEnv();
  if (!model.apiKey && !model.baseUrl.includes("localhost") && !model.baseUrl.includes("127.0.0.1")) {
    throw new Error("未设置 WRITER_API_KEY");
  }
  if (!store.sessionExists(sessionId)) throw new Error("会话不存在");

  const history = compactHistory(store.messages(sessionId, 40).filter((message) => message.role !== "tool" && message.role !== "system"));
  const fastTask = fastRouteWritingTask(project, store, sessionId, prompt);
  const planned = fastTask ? { task: fastTask } : await planWritingTask(model, project, store, prompt, history, signal);
  const task = planned.task;
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
  const continuationPath = task.continuation
    ? task.targetPath ?? store.proposals().find(proposal => proposal.sessionId === sessionId)?.path
    : undefined;
  store.saveSessionContext(sessionId, { activeDocument: task.targetPath ?? continuationPath, currentIntent: `${task.mode}: ${prompt.slice(0, 240)}` });
  store.addMessage(sessionId, "user", prompt);
  const selectedContext = selectedBlocksContext(project, options.selectedDocumentBlocks);
  const historicalContext = historicalConversationContext(history);
  const artifactContext = recentArtifactsContext(store, sessionId, project);
  const bootstrapContext = writingBootstrapContext(project, store, prompt, task);
  const preferredSample = options.selectedDocumentBlocks
    ?.map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
  const styleContext = styleGroundingPrompt(project, store, {
    intensive: isIntensiveWritingMode(task.mode) || task.documentProposalRequired,
    targetPath: task.targetPath ?? continuationPath,
    exampleIds: task.exampleIds,
    preferredSample: preferredSample || undefined,
  });
  const messages: ApiMessage[] = [
    { role: "system", content: writingSystemPrompt(project) },
    { role: "system", content: executionRulesPrompt() },
    ...(task.mode === "audit" ? [{ role: "system" as const, content: REVIEW_PROMPT }] : []),
    ...(historicalContext ? [historicalContext] : []),
    { role: "system", content: dynamicContextPrompt(project, store, prompt, task, characterScope, continuationPath) },
    ...(styleContext ? [{ role: "system" as const, content: styleContext }] : []),
    ...(bootstrapContext ? [{ role: "system" as const, content: bootstrapContext }] : []),
    ...(artifactContext ? [{ role: "system" as const, content: artifactContext }] : []),
    ...(selectedContext ? [{ role: "system" as const, content: selectedContext }] : []),
    { role: "user", content: prompt },
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
      compactRuntimeMessages(messages);
      rehydrateCompactedToolMessages(messages, store, sessionId);
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
          toolResult = executeToolCached(call, project, store, sessionId, emit, toolCallCounts, characterScope);
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
      if (documentProposalSubmitted || waitingForUser) break;
      compactCompletedToolCalls(messages);
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
逐段检查并修改：模板化转折和连接词；紧跟动作、对白或细节之后的解释回声；用单一标签包办人物的写法；整齐但空泛的排比和三项并列；句长、段长和句式过度均匀；无意义的总结、升华与强调；角色都说同一种完整而正确的话。
重点扫描并删除说明类框架：① 句中解释性破折号——凡“前半句画面/动作——后半句补充、定义、原因、心理或评判”一律拆开或改写。坏例：“视线落在门缝里——夹着一张纸条。”“改过——日期是昨天。”好例：“视线落在门缝里。里面夹着一张纸条。”“用红笔改过，日期是昨天。”仅保留对白打断“——」”、行末拖腔、系统框拖长音。② “不是……而是/是……”“并非……”“没有……只有……”“与其说……不如说……”“仿佛……又仿佛……”等对照框架，除非人物当面反驳误解。不要换成另一套说明腔，也不要只改后半句而保留“——/不是”骨架。
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

function recentArtifactsContext(store: WriterStore, sessionId: string, project: WriterProject): string {
  const artifacts = store.recentContextArtifacts(sessionId, 8);
  const state = store.sessionContext(sessionId);
  if (!artifacts.length && !state.activeDocument && !state.currentIntent) return "";
  const activePath = state.activeDocument;
  const activeHash = activePath && project.documentExists(activePath)
    ? project.hash(project.read(activePath))
    : undefined;
  const restored: Array<Record<string, unknown>> = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== "read_document" && artifact.kind !== "inspect_document" && artifact.kind !== "get_outline_node" && artifact.kind !== "list_outline_nodes") continue;
    if (artifact.path && activePath && artifact.path !== activePath && artifact.kind.startsWith("read")) continue;
    if (activeHash && artifact.sourceHash !== activeHash && artifact.kind !== "list_outline_nodes" && artifact.kind !== "get_outline_node") continue;
    const full = store.contextArtifactById(sessionId, artifact.id);
    if (!full) continue;
    try {
      const parsed = JSON.parse(full.content) as Record<string, unknown>;
      if (typeof parsed.error === "string") continue;
      const content = typeof parsed.content === "string" ? parsed.content
        : typeof parsed.markdown === "string" ? parsed.markdown : undefined;
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
        ...(content ? { content: content.length > 8_000 ? `${content.slice(0, 8_000)}\n…[已截断，全文在 artifact#${artifact.id}]` : content } : {
          opening: parsed.opening,
          ending: parsed.ending,
          headings: parsed.headings,
          lineCount: parsed.lineCount,
          blockCount: parsed.blockCount,
          nodes: Array.isArray(parsed.nodes) ? (parsed.nodes as unknown[]).slice(0, 40) : undefined,
          node: parsed.node,
        }),
      });
      if (restored.length >= 3) break;
    } catch { /* 非 JSON 工作记忆条目跳过 */ }
  }
  const catalog = artifacts.map(({ id, kind, path, sourceHash, digest }) => ({ id, kind, path, sourceHash, digest }));
  return `会话状态与工作记忆（下列资料本会话已读过且文档未变；请直接复用，禁止对相同路径/范围再次 inspect_document、read_document 或重复 list_outline_nodes）：\n${JSON.stringify({ state, artifacts: catalog, restoredReads: restored })}`;
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
    .map(item => ({ id: item.id, name: item.name, narrativeRole: item.narrativeRole }));

  if (!outlineNodes?.length && !targetCandidates.length && !prevCandidates.length && !characterIndex.length) {
    return "";
  }

  return `写作线索（系统启发式索引，未经验证，不是已读正文）：
- 需要情节细节：用 outlineNodes[].id 调用 get_outline_node（id 为 UUID，不是章号）。
- 需要衔接：对 previousChapterCandidates 中的路径 read_document(lastSection=true) 一次。
- 需要人设：对 characterIndex 中的 id 调用 get_character（可带 fields）。
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

function parseChapterNumber(text: string): number | undefined {
  if (!text) return undefined;
  const arabic = /第\s*(\d{1,3})\s*章|chapter[-_\s]*0*(\d{1,3})|chapters\/[^/\s]*?0*(\d{1,3})/i.exec(text);
  if (arabic) {
    const value = Number(arabic[1] || arabic[2] || arabic[3]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  const cn = /第\s*([零〇一二三四五六七八九十百千两]{1,6})\s*章/.exec(text);
  if (!cn) return undefined;
  const value = chineseNumeralToInt(cn[1]);
  return value > 0 ? value : undefined;
}

function chineseNumeralToInt(raw: string): number {
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (raw === "十") return 10;
  if (raw.length === 1) return digits[raw] ?? -1;
  // Simple 1–99: 十五 / 二十 / 二十三
  let total = 0;
  let current = 0;
  for (const char of raw) {
    if (char === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (char === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else if (char in digits) {
      current = digits[char];
    }
  }
  return total + current;
}

function chapterTitleMatches(title: string, chapterNum: number): boolean {
  if (!title) return false;
  const cn = intToChineseNumeral(chapterNum);
  const patterns = [
    new RegExp(`第\\s*0*${chapterNum}\\s*章`),
    new RegExp(`第\\s*${cn}\\s*章`),
    new RegExp(`chapter[-_\\s]*0*${chapterNum}\\b`, "i"),
    new RegExp(`(^|[^0-9])0*${chapterNum}([^0-9]|$)`),
  ];
  return patterns.some(pattern => pattern.test(title));
}

function intToChineseNumeral(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (value <= 0) return String(value);
  if (value < 10) return digits[value];
  if (value === 10) return "十";
  if (value < 20) return `十${digits[value % 10]}`;
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ""}`;
  }
  return String(value);
}

function expandOutlineFamily<T extends { id: string; parentId?: string }>(all: T[], matched: T[]): T[] {
  const ids = new Set(matched.map(node => node.id));
  for (const node of matched) {
    if (node.parentId) ids.add(node.parentId);
  }
  for (const node of all) {
    if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
  }
  return all.filter(node => ids.has(node.id));
}

function previousPath(paths: string[], current: string): string | undefined {
  const index = paths.indexOf(current);
  return index > 0 ? paths[index - 1] : undefined;
}

function safeReadHeading(project: WriterProject, path: string): string {
  try {
    const first = project.read(path).split(/\r?\n/, 5).find(line => /^#{1,6}\s+/.test(line));
    return first ? first.replace(/^#{1,6}\s+/, "").trim() : path;
  } catch {
    return path;
  }
}

/** Resolve outline node by UUID, or by title / chapter label when the model passes "5" / "第五章". */
function resolveOutlineNodePayload(outline: OutlineStore, idOrTitle: string): Record<string, unknown> {
  const snapshot = outline.sync();
  const exact = snapshot.nodes.find(node => node.id === idOrTitle);
  if (exact) {
    return { node: exact, markdown: outline.section(exact.id) };
  }

  const chapterNum = parseChapterNumber(idOrTitle) ?? (/^\d{1,3}$/.test(idOrTitle) ? Number(idOrTitle) : undefined);
  const byTitle = snapshot.nodes.filter(node =>
    node.title === idOrTitle
    || node.title.includes(idOrTitle)
    || (chapterNum !== undefined && chapterTitleMatches(node.title, chapterNum)),
  );
  if (byTitle.length === 1) {
    const node = byTitle[0];
    return {
      node,
      markdown: outline.section(node.id),
      resolvedFrom: idOrTitle,
      message: `已将“${idOrTitle}”解析为节点 ${node.id}（${node.title}）。请后续使用该 UUID，不要用章号当 id。`,
    };
  }
  if (byTitle.length > 1) {
    return {
      error: `“${idOrTitle}”匹配到多个大纲节点；请改用下列唯一 id 调用 get_outline_node。`,
      candidates: byTitle.slice(0, 12).map(node => ({ id: node.id, type: node.type, title: node.title })),
    };
  }

  const catalog = snapshot.nodes.slice(0, 40).map(node => ({ id: node.id, type: node.type, title: node.title }));
  return {
    error: `大纲节点不存在：${idOrTitle}。节点 id 不是章号；请从下列目录或写作引导中的 outlineNodes 选择 id，不要重新 list_outline_nodes（若本轮已列过）。`,
    availableNodes: catalog,
  };
}

const CACHEABLE_TOOLS = new Set(["list_documents", "inspect_document", "read_document", "search_project", "list_outline_nodes", "get_outline_node", "validate_outline", "compare_outline_with_draft"]);
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

function executeToolCached(
  call: ToolAccumulator, project: WriterProject, store: WriterStore, sessionId: string,
  emit: (event: AgentEvent) => void, counts: Map<string, number>, characterScope?: number[],
): string {
  if (!CACHEABLE_TOOLS.has(call.name)) return executeTool(call, project, store, sessionId, emit, characterScope);
  let input: Record<string, unknown>;
  try { input = JSON.parse(call.arguments || "{}") as Record<string, unknown>; }
  catch { return executeTool(call, project, store, sessionId, emit, characterScope); }
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
  const result = executeTool(call, project, store, sessionId, emit, characterScope);
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

function compactHistory(messages: Array<{ role: string; content: string }>): ApiMessage[] {
  const recent = messages.slice(-8);
  const older = messages.slice(0, -8);
  const result: ApiMessage[] = [];
  if (older.length) {
    let summary = older.map((message) => {
      const label = message.role === "user" ? "用户" : "Agent";
      const content = stripDsmlText(message.content, "[工具调用已隐藏]");
      return `${label}: ${content.replace(/\s+/g, " ").slice(0, 360)}`;
    }).join("\n");
    if (summary.length > 4_000) summary = `[更早内容已省略]\n${summary.slice(-4_000)}`;
    result.push({ role: "system", content: `较早会话压缩摘要：\n${summary}` });
  }
  result.push(...recent.map((message) => ({
    role: message.role as "user" | "assistant",
    content: stripDsmlText(message.content, "[工具调用已隐藏]"),
  })));
  return result;
}

function compactRuntimeMessages(messages: ApiMessage[]): void {
  const toolIndexes = messages.flatMap((message, index) => message.role === "tool" ? [index] : []);
  const totalChars = toolIndexes.reduce((sum, index) => sum + (messages[index].content?.length ?? 0), 0);
  // Avoid early compaction: the log "结果被压缩了 → 再读一遍" is worse than a larger prompt.
  if (toolIndexes.length <= 10 && totalChars <= 60_000) return;

  const keepRecent = 8;
  for (const index of toolIndexes.slice(0, -keepRecent)) {
    const message = messages[index];
    if (!message.content || message.content.length <= 800) continue;
    try {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
      if (parsed.status === "artifact_compacted") continue;
      // Never compact catalogs / search hit lists — losing IDs forces re-list thrashing.
      if ([...NEVER_COMPACT_KEYS].some(key => key in parsed)) continue;
      if (parsed.reused === true && message.content.length < 12_000) continue;

      const content = typeof parsed.content === "string" ? parsed.content
        : typeof parsed.markdown === "string" ? parsed.markdown : undefined;
      // Only compact heavy document bodies; keep metadata tools intact.
      if (!content || content.length < 1_200) continue;

      const digestLimit = 2_000;
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
        message: "正文已压缩为 digest；请直接基于 digest 与写作引导继续。禁止因压缩再次 read_document / list_outline_nodes。",
      });
    } catch {
      if (message.content.length > 4_000) {
        message.content = JSON.stringify({ status: "artifact_compacted", message: "工具结果已压缩；请继续任务，不要重复调用同一工具。" });
      }
    }
  }
}

/** Restore compacted tool bodies from session artifacts so the model never needs to re-read. */
function rehydrateCompactedToolMessages(messages: ApiMessage[], store: WriterStore, sessionId: string): void {
  for (const message of messages) {
    if (message.role !== "tool" || !message.content) continue;
    try {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
      if (parsed.status !== "artifact_compacted") continue;
      const artifactId = typeof parsed.artifactId === "number" ? parsed.artifactId : undefined;
      if (artifactId === undefined) continue;
      const full = store.contextArtifactById(sessionId, artifactId);
      if (!full?.content) continue;
      message.content = withReuseMarker(full.content, "已从工作记忆自动恢复完整工具结果；禁止再次读取同一内容。", artifactId);
    } catch { /* ignore non-JSON tool payloads */ }
  }
}

function compactCompletedToolCalls(messages: ApiMessage[]): void {
  let latestProposalMessage = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.tool_calls?.some(call => call.function.name.startsWith("propose_document"))) {
      latestProposalMessage = index;
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    // The newest failed proposal is the model's repair context for the next turn.
    // Successful proposals exit before this compactor runs.
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

function executeTool(
  call: ToolAccumulator,
  project: WriterProject,
  store: WriterStore,
  sessionId: string,
  emit: (event: AgentEvent) => void,
  characterScope?: number[],
): string {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: "工具参数不是有效 JSON" });
  }
  try {
    if (call.name === "list_documents") return JSON.stringify(documentMap(project));
    if (call.name === "inspect_document") {
      const path = requireString(input.path, "path");
      if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
      const content = project.read(path);
      const lines = content.split(/\r?\n/);
      const blocks = documentBlocks(content);
      const headings = lines.flatMap((line, index) => /^#{1,6}\s+/.test(line) ? [{ line: index + 1, text: line }] : []).slice(0, 120);
      return JSON.stringify({
        path,
        lineCount: lines.length,
        characterCount: content.length,
        blockCount: blocks.length,
        blocks: blocks.map(block => ({ block: block.block, startLine: block.startLine, endLine: block.endLine, characters: block.characters })),
        headings,
        opening: lines.slice(0, 8).join("\n").slice(0, 1_200),
        ending: lines.slice(-8).join("\n").slice(-1_200),
      });
    }
    if (call.name === "read_document") {
      const path = requireString(input.path, "path");
      if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
      const content = project.read(path);
      const requestedStart = optionalPositiveInteger(input.startLine, "startLine");
      const requestedEnd = optionalPositiveInteger(input.endLine, "endLine");
      if ((requestedStart === undefined) !== (requestedEnd === undefined)) throw new Error("startLine 和 endLine 必须同时提供");
      if (requestedStart !== undefined && requestedEnd !== undefined) {
        const lines = content.split(/\r?\n/);
        if (requestedStart > requestedEnd) throw new Error("startLine 不能大于 endLine");
        if (requestedStart > lines.length) throw new Error(`startLine 超出范围；文档共 ${lines.length} 行`);
        if (requestedEnd - requestedStart + 1 > 200) throw new Error("单次最多读取 200 行");
        const actualEnd = Math.min(requestedEnd, lines.length);
        const selected = lines.slice(requestedStart - 1, actualEnd).join("\n");
        if (selected.length > 12_000) throw new Error("行范围超过 12000 字符，请缩小读取范围");
        return JSON.stringify({ path, startLine: requestedStart, endLine: actualEnd, lineCount: lines.length,
          characters: selected.length, content: selected });
      }
      const sections = documentSections(content);
      const requestedSection = typeof input.section === "string" ? input.section.trim().replace(/^#{1,6}\s+/, "") : "";
      if (requestedSection || input.lastSection === true) {
        if (!sections.length) throw new Error("文档没有 Markdown 标题，无法按节读取；请改用 block");
        const matches = requestedSection
          ? sections.filter(item => item.heading === requestedSection)
          : [sections[sections.length - 1]];
        if (!matches.length) throw new Error(`未找到标题“${requestedSection}”；请先用 inspect_document 查看标题结构`);
        if (matches.length > 1) throw new Error(`标题“${requestedSection}”出现多次，请改用唯一标题或 block 读取`);
        const selected = matches[0];
        return JSON.stringify({
          path,
          section: selected.section,
          sectionCount: sections.length,
          heading: selected.heading,
          level: selected.level,
          startLine: selected.startLine,
          endLine: selected.endLine,
          characters: selected.characters,
          hasPrevious: selected.section > 1,
          hasNext: selected.section < sections.length,
          content: selected.content,
        });
      }
      const blocks = documentBlocks(content);
      const requestedBlock = optionalPositiveInteger(input.block, "block") ?? 1;
      if (requestedBlock > blocks.length) throw new Error(`block 超出范围；文档共 ${blocks.length} 块`);
      const selected = blocks[requestedBlock - 1];
      return JSON.stringify({
        path,
        block: selected.block,
        blockCount: blocks.length,
        startLine: selected.startLine,
        endLine: selected.endLine,
        characters: selected.characters,
        hasPrevious: selected.block > 1,
        hasNext: selected.block < blocks.length,
        content: selected.content,
      });
    }
    if (call.name === "search_project") {
      const allowedScopes = new Set(["all", "lore", "story", "outline", "chapters"]);
      const allowedModes = new Set(["any", "all", "exact"]);
      const scope = typeof input.scope === "string" && allowedScopes.has(input.scope)
        ? input.scope as "all" | "lore" | "story" | "outline" | "chapters"
        : "all";
      const mode = typeof input.mode === "string" && allowedModes.has(input.mode) ? input.mode as "any" | "all" | "exact" : "any";
      const limit = Math.max(1, Math.min(12, optionalPositiveInteger(input.limit, "limit") ?? 8));
      const contextLines = typeof input.contextLines === "number" && Number.isFinite(input.contextLines)
        ? Math.max(0, Math.min(12, Math.round(input.contextLines))) : 2;
      const pathPrefix = typeof input.pathPrefix === "string" ? input.pathPrefix : undefined;
      return JSON.stringify({ query: requireString(input.query, "query"), scope, mode,
        matches: store.search(requireString(input.query, "query"), limit, { scope, mode, contextLines, pathPrefix })
          .filter(item => !project.isDocumentHidden(item.path)) });
    }
    if (call.name === "list_outline_nodes") {
      const outline = new OutlineStore(project).sync();
      const type = typeof input.type === "string" ? input.type : undefined;
      const status = typeof input.status === "string" ? input.status : undefined;
      return JSON.stringify({ sourcePath: outline.sourcePath, updatedAt: outline.updatedAt, nodes: outline.nodes
        .filter(node => !type || node.type === type)
        .filter(node => !status || node.status === status)
        .map(({ startLine, endLine, level, ...node }) => ({ ...node, lines: [startLine, endLine], level })) });
    }
    if (call.name === "get_outline_node") {
      const outline = new OutlineStore(project);
      const id = requireString(input.id, "id");
      return JSON.stringify(resolveOutlineNodePayload(outline, id));
    }
    if (call.name === "validate_outline") return JSON.stringify({ issues: new OutlineStore(project).validate() });
    if (call.name === "compare_outline_with_draft") {
      return JSON.stringify(new OutlineStore(project).compareWithDraft(requireString(input.id, "id")));
    }
    if (call.name === "propose_outline_patch") {
      const outline = new OutlineStore(project);
      const id = requireString(input.id, "id");
      const nodeSection = outline.section(id);
      const search = requireString(input.search, "search");
      const replace = typeof input.replace === "string" ? input.replace : undefined;
      if (replace === undefined) throw new Error("缺少有效参数：replace");
      rejectCompressedPlaceholder(search, "search"); rejectCompressedPlaceholder(replace, "replace");
      if (!nodeSection.includes(search)) throw new Error("search 不在指定大纲节点中；请重新读取节点原文");
      const content = project.read(outline.sourcePath);
      const occurrences = countOccurrences(content, search);
      if (occurrences !== 1) throw new Error(`search 在大纲中出现 ${occurrences} 次，必须唯一`);
      const proposal = store.createProposal(sessionId, outline.sourcePath, content.replace(search, replace), requireString(input.summary, "summary"));
      emit({ type: "proposal", proposal });
      return JSON.stringify({ proposalId: proposal.id, status: proposal.status, nodeId: id, message: "大纲局部修改已等待用户审批" });
    }
    if (call.name === "propose_document") {
      if (project.isDocumentHidden(requireString(input.path, "path"))) throw new Error("文档已对 Agent 屏蔽");
      const proposedContent = requireString(input.content, "content");
      rejectCompressedPlaceholder(proposedContent, "content");
      const styleError = contrastStyleError(proposedContent);
      if (styleError) throw new Error(styleError);
      const proposal = store.createProposal(
        sessionId,
        requireString(input.path, "path"),
        proposedContent,
        requireString(input.summary, "summary"),
      );
      emit({ type: "proposal", proposal });
      return JSON.stringify({ proposalId: proposal.id, status: proposal.status, message: "已等待用户审批" });
    }
    if (call.name === "propose_document_patch") {
      const path = requireString(input.path, "path");
      if (project.isDocumentHidden(path)) throw new Error("文档已对 Agent 屏蔽");
      const edits = Array.isArray(input.edits) ? input.edits.slice(0, 20) : [];
      if (!edits.length) throw new Error("局部修改至少需要一条 edit");
      const replacementText = edits.map(rawEdit => rawEdit && typeof rawEdit === "object" && typeof (rawEdit as Record<string, unknown>).replace === "string"
        ? (rawEdit as Record<string, unknown>).replace as string
        : "").join("\n");
      const styleError = contrastStyleError(replacementText);
      if (styleError) throw new Error(styleError);
      let content = project.read(path);
      for (const [index, rawEdit] of edits.entries()) {
        if (!rawEdit || typeof rawEdit !== "object") throw new Error(`第 ${index + 1} 条 edit 格式无效`);
        const edit = rawEdit as Record<string, unknown>;
        const search = requireString(edit.search, `edits[${index}].search`);
        const replace = typeof edit.replace === "string" ? edit.replace : undefined;
        if (replace === undefined) throw new Error(`缺少有效参数：edits[${index}].replace`);
        rejectCompressedPlaceholder(search, `edits[${index}].search`);
        rejectCompressedPlaceholder(replace, `edits[${index}].replace`);
        const occurrences = countOccurrences(content, search);
        if (occurrences !== 1) throw new Error(`第 ${index + 1} 条 search 在原文中出现 ${occurrences} 次，必须唯一`);
        content = content.replace(search, replace);
      }
      const proposal = store.createProposal(sessionId, path, content, requireString(input.summary, "summary"));
      emit({ type: "proposal", proposal });
      return JSON.stringify({ proposalId: proposal.id, status: proposal.status, edits: edits.length, message: "局部修改已等待用户审批" });
    }
    if (call.name === "list_characters") {
      const allowedIds = characterScope === undefined ? undefined : new Set(characterScope);
      return JSON.stringify(store.characters().filter(c => !allowedIds || allowedIds.has(c.id)).map((c) => ({
        id: c.id, name: c.name, narrativeRole: c.narrativeRole, identity: c.identity, aliases: c.aliases,
        appearance: c.appearance.slice(0, 80),
        relationships: c.relationships,
      })));
    }
    if (call.name === "get_character") {
      const id = optionalPositiveInteger(input.id, "id");
      if (!id) throw new Error("缺少有效参数：id");
      if (characterScope !== undefined && !characterScope.includes(id)) throw new Error("该角色不在用户允许的角色范围内");
      const character = store.characters().find(item => item.id === id);
      if (!character) throw new Error("角色不存在");
      const allowedFields = new Set([
        "aliases", "narrativeRole", "identity", "appearance", "personality", "values", "speechStyle", "background",
        "longTermGoal", "currentGoal", "fears", "capabilities", "limitations", "relationships", "notes",
      ]);
      const requestedFields = Array.isArray(input.fields)
        ? [...new Set(input.fields.filter((field): field is string => typeof field === "string" && allowedFields.has(field)))]
        : [];
      if (!requestedFields.length) return JSON.stringify(character);
      const selected: Record<string, unknown> = { id: character.id, name: character.name };
      const values = character as unknown as Record<string, unknown>;
      for (const field of requestedFields) selected[field] = values[field];
      return JSON.stringify(selected);
    }
    if (call.name === "save_character") {
      const characterId = typeof input.id === "number" && Number.isInteger(input.id) && input.id > 0 ? input.id : undefined;
      const existing = characterId ? store.characters().find(item => item.id === characterId) : undefined;
      if (characterId && !existing) throw new Error("要修改的角色不存在");
      const value = (field: keyof Character, fallback = "") =>
        typeof input[field] === "string" ? input[field] as string : existing && typeof existing[field] === "string" ? existing[field] as string : fallback;
      const character = store.saveCharacter({
        id: characterId,
        name: requireString(input.name, "name"),
        aliases: Array.isArray(input.aliases) ? input.aliases.filter((v): v is string => typeof v === "string") : existing?.aliases ?? [],
        schemaVersion: 2,
        narrativeRole: value("narrativeRole"), identity: value("identity"), appearance: value("appearance"),
        personality: value("personality"), values: value("values"), speechStyle: value("speechStyle"),
        background: value("background"), longTermGoal: value("longTermGoal"), currentGoal: value("currentGoal"), fears: value("fears"),
        relationships: Array.isArray(input.relationships) ? input.relationships.flatMap(value => {
          if (!value || typeof value !== "object") return [];
          const relation = value as Record<string, unknown>;
          const characterId = Number(relation.characterId);
          if (!Number.isInteger(characterId) || (characterScope && !characterScope.includes(characterId))) return [];
          return [{ characterId, type: String(relation.type ?? ""), description: String(relation.description ?? ""), attitude: String(relation.attitude ?? "") }];
        }) : existing?.relationships ?? [],
        capabilities: value("capabilities"), limitations: value("limitations"), notes: value("notes"),
      });
      return JSON.stringify({ id: character.id, name: character.name, message: "角色卡已保存" });
    }
    if (call.name === "ask_user") {
      const question = requireString(input.question, "question").slice(0, 300);
      const rawOptions = Array.isArray(input.options)
        ? input.options.filter((v): v is string => typeof v === "string").slice(0, 5)
        : [];
      const options = rawOptions.length >= 2 ? rawOptions : undefined;
      const message = options
        ? `${question}\n\n${options.map((opt, i) => `选项 ${i + 1}：${opt}`).join("\n")}`
        : question;
      return JSON.stringify({ status: "waiting", message: "问题已提交，等待用户回复", displayMessage: message, question, options: options ?? undefined });
    }
    return JSON.stringify({ error: `未知工具：${call.name}` });
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少有效参数：${name}`);
  return value;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
  return value;
}

function rejectCompressedPlaceholder(value: string, name: string): void {
  if (value.includes("[内容已压缩")) {
    throw new Error(`${name} 是历史压缩占位文本，不是正文内容；请重新读取必要原文并提交真实内容`);
  }
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - search.length) {
    const index = content.indexOf(search, offset);
    if (index < 0) break;
    count += 1;
    offset = index + search.length;
  }
  return count;
}

function documentMap(project: WriterProject): Array<{ path: string; kind: string; lines: number; characters: number; headings: string[] }> {
  const result: Array<{ path: string; kind: string; lines: number; characters: number; headings: string[] }> = [];
  let budget = 6_000;
  for (const path of project.listDocuments().filter(path => !project.isDocumentHidden(path)).slice(0, 100)) {
    const content = project.read(path);
    const entry = {
      path,
      kind: documentKind(path),
      lines: content.split(/\r?\n/).length,
      characters: content.length,
      headings: content.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line)).slice(0, 6),
    };
    const size = JSON.stringify(entry).length;
    if (size > budget) break;
    result.push(entry);
    budget -= size;
  }
  return result;
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
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens,
    totalTokens: usage.promptTokens + usage.completionTokens,
    cost: pricing && !usage.estimated ? calculateUsageCost(normalized, pricing, at) : 0,
    currency: pricing?.currency ?? "CNY",
    ...(usage.estimated ? { estimated: true } : {}),
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
