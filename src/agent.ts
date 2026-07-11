import type { AgentEvent, Character, ModelConfig } from "./types.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { getStyleTemplate } from "./templates.js";
import { documentBlocks, documentSections } from "./document_blocks.js";
import { contrastStyleError } from "./prose_quality.js";
import { logModelRequest, logModelResponse } from "./model_debug.js";

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
      description: "列出作品项目中的所有 Markdown 文档",
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
      description: "按 Markdown 标题节或自然边界块读取文档。可用 section 指定标题、用 lastSection 读取最后一节；没有合适标题时再按 block 读取。先用 inspect_document 查看结构",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "项目内相对路径" },
          block: { type: "number", description: "块编号，1 开始；默认读取第 1 块" },
          section: { type: "string", description: "按 Markdown 标题读取一节；填写 inspect_document 返回的标题文字（不含 #）" },
          lastSection: { type: "boolean", description: "读取文档最后一个 Markdown 标题节；续写时优先使用" },
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
      description: "在作品设定、人物、大纲和章节中全文检索",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
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
      description: "向用户提出一个问题或呈现一组选项，暂停执行并等待用户回复。当需要用户决定方向、选择方案、或澄清信息时，必须先调用此工具再停止；不要在提问的同时调用其他工具，也不要自行替用户做出选择",
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
  const styleBlock = styleTemplate
    ? `\n当前激活的风格模板：${styleTemplate.name}\n${styleTemplate.systemPromptAddition}\n`
    : "";
  return `你是的创意写作 Agent。界面语言为中文，作品语言为 ${config.language}。
${styleBlock}
## 职责：协助构思、续写、改写和检查长篇作品，同时尊重作者的最终决定。

## 绝对禁令：
- 禁止使用先否定再定义、先否定再解释的句式，包括“不是……而是……”“不是……是……”“并非……而是……”“并非……却是……”“与其说……不如说……”“没有……只有……”“不是因为……只是……”。
- 禁止用“——”承接解释、转折、补充定义或作者说明；破折号只可用于自然中断、话语被打断或极少量必要插入。
- 禁止用随手比喻代替直接陈述。比喻必须来自当前视角人物的经验、现场物象或作品既有意象，并改变读者对动作、空间、关系或情绪的理解。
- 禁止在对话中加入不合语境的比喻、金句或完整观点陈述。人物说话优先服从身份、关系、处境、回避和当下目的。

## 正文写作指导：
- 先呈现证据，再决定是否需要判断。人物的性格和情绪优先通过具体动作、选择、代价、停顿、误解及有对象的感官细节显露；避免用“敏感、坚强、冷漠、破碎、释然”等标签包办人物。标签若保留，应属于人物或叙述者的有限看法，并允许后续行为与它矛盾。
- 不替读者翻译刚写出的动作、对白或细节。写出证据后，删除紧随其后的心理结论、潜台词说明和象征解释；只有缺少说明会造成因果断裂或事实误解时才补充。心理活动必须带有角色自身的词汇、偏见和当下目的。
- 段落围绕当前注意力或叙事动作组织。句长、段长和信息密度随场景自然变化，不追求各段等长、论点对称或结构完整，不连续堆叠同构短句、排比句、三项并列或设问句。
- 禁止用“不是A，而是B”“并非A，却是B”“与其说A，不如说B”“没有A，只有B”“不是因为A，只是B”等先否定再解释的对照句代替描写。直接陈述B对应的动作、观察或结果。只有人物确实在纠正误解时才使用；每 3000 字最多一处。
- 比喻必须来自当前人物的经验和现场物象；同一段通常不使用两个比喻。删除只制造气氛、不改变观察结果的空泛修饰。
- 对白允许答非所问、打断、回避和沉默。不同人物在用词、句长、礼貌程度及信息习惯上要可区分；不让人物轮流完整陈述观点或替作者解释设定。
- 避免高频套语和通用反应，如“心中一震”“不由得”“嘴角勾起”“眼神复杂”“空气仿佛凝固”“一股莫名的情绪”。需要表达时，改写为该人物在该场景中独有且可观察的反应。
- 不在段尾反复追加总结、升华、预告或解释性判断。场景结束落在一个已经发生的动作、决定、发现或未解决的具体问题上。
- 降低机器感依靠内容和观察的差异，不靠随机换同义词、强行切碎句子、滥加口语、病句或无关细节。加入的具体信息应来自既有上下文，并服务于人物行动、空间关系、因果或伏笔。
- 不追求每句话都精致或每个方面都交代齐全。保留必要的朴素过渡、信息落差、轻重差别和有意义的不对称；让结构服从真实的叙事重点。
`;
}

function writingHardConstraintsPrompt(): string {
  return `写作硬约束复查：
输出正文或改写提案前，逐段删除以下内容：
1. “不是……而是……”“不是……是……”“并非……而是……”“并非……却是……”“与其说……不如说……”“没有……只有……”“不是因为……只是……”等先否定再解释句式。
2. 用“——”制造说明关系、定义关系、转折关系或作者旁白解释。
3. 没有来自人物经验、现场物象或既有意象支撑的比喻。
4. 对话中的不合语境比喻、金句、完整论述和替作者解释设定的台词。
若某句承担必要信息，保留信息本身，改为直接动作、观察、对白、停顿、选择或结果。`;
}

function executionRulesPrompt(): string {
  return `执行规则：
1. 先依据本轮任务计划判断是否需要项目上下文。计划为 none 时直接回答，不调用文档工具；计划需要文档时，才使用 search_project 定位或 inspect_document 查看结构，再用 read_document 读取最小必要块。除非文档很短或确需全文重写，不逐块读取整篇文档。
2. 修改已有文档时优先调用 propose_document_patch 提交局部搜索替换；propose_document 只用于新建文档或全文重写。提案不会直接写入，作者可审批或拒绝。
2.1 凡用户要求写正文、续写、继续写、扩写或改写，必须以 propose_document 或 propose_document_patch 提交到目标 Markdown 文档。禁止只在最终回复中粘贴正文来代替文档提案；最终回复只能简要说明已提交的内容。
2.2 用户用"继续""接着写""往下写"等短指令承接上一轮写作时，默认继续上一轮目标文档。先读取目标文档末尾的必要范围，再提交追加或替换提案；无法确定目标文件时应先询问，不得直接输出正文。
3. 保持既有人物、世界观、叙事视角和 Markdown 结构，除非作者明确要求改变。写入正文、大纲或设定时使用常见 Markdown 标记组织结构：用 #/##/### 表示章、节和场景层级，必要时使用 *强调*、列表或分隔线；标题应简短稳定，便于浏览跳转和按节读取。不要为每个自然段添加标题。
4. 信息不足时，必须调用 ask_user 工具提出简短、具体的问题，不擅自补充关键设定。调用 ask_user 后本轮不得再调用其他工具；等待用户回复后再继续执行。但对于写作本身（情节走向、对白、描写等），直接给出具体内容，不要停留在建议层面。
5. 当有多个合理的写作方向时，必须调用 ask_user 工具的 options 参数以简洁编号列出选项（每个选项 ≤ 20 字），等候作者选择，不自己决定方向。调用 ask_user 后本轮停止，等待用户回复后按选定方向继续。
6. 提交文档提案（propose_document 或 propose_document_patch）后本轮立即停止，不继续调用其他工具或自行追加正文。等待用户审批提案后再继续。
7. 不输出工具调用的内部参数，不使用项目范围外的信息。
8. 对话回复默认使用自然、简洁的纯文本。文档创作应使用适量 Markdown 结构标记，但避免滥用标题、粗体、列表和代码块；小说正文不得为每个自然段添加标题或项目符号。
9. 管理角色必须使用 save_character。创建角色卡时只填写用户已提供或可可靠归纳的字段，未知字段允许留空，不得为了填满表格而虚构设定。修改已有角色时先 list_characters 获取 ID，再用 get_character 读取完整卡片，并传入 id 更新；不得清空未要求修改的字段，也不要重复创建角色卡。写作时需要角色资料，也使用 get_character 的 fields 参数只读取当前场景真正需要的字段，例如对白优先读取 speechStyle，动作描写读取 appearance/capabilities/limitations，人物决策读取 personality/values/currentGoal/fears；不要默认读取整张卡片。
10. 工具已经返回过的长内容不会永久保留在上下文中。后续需要精确原文时，重新读取最小必要范围，不要求系统恢复整份旧输出。
11. 历史工具调用中若出现"内容已压缩"的占位文本，它只表示旧正文已从上下文移除；不得把占位文本当作正文、参数名示例或可复用内容。新的 propose_document 必须使用 content 参数提交完整正文；新的 propose_document_patch 必须使用 edits 参数提交真实搜索替换。`;
}

function dynamicContextPrompt(project: WriterProject, store: WriterStore, request: string, task: WritingTask, characterScope?: number[], continuationPath?: string): string {
  const references = [...new Set([...(task.targetPath ? [task.targetPath] : []), ...explicitReferencePaths(project, request)])];
  const creativeContext = structuredCreativeContext(store, task, characterScope);
  const characterScopeInstruction = characterScope === undefined
    ? "角色资料按任务相关性自动筛选。"
    : characterScope.length
      ? `用户仅允许关联角色 ID：${characterScope.join("、")}。不得读取、列出或关联范围外的角色。`
      : "用户明确选择不关联任何已有角色。不得读取或列出其他角色资料。";
  const documentInstruction = task.documentProposalRequired
    ? `本次请求必须产生文档提案后才能结束。不得把正文直接作为最终回复；必须先定位并读取目标 Markdown 文档，再调用 propose_document_patch 或 propose_document。${continuationPath ? `本次是承接上一轮的简短续写，默认目标文档为 ${continuationPath}。` : ""}`
    : "本次请求不强制产生文档提案，按用户意图执行。";
  const contextInstruction: Record<DocumentContextMode, string> = {
    none: "无需读取项目文档。直接使用当前对话完成任务；不要调用 list_documents、search_project、inspect_document 或 read_document。",
    search: `需要核对项目资料。先调用 search_project，查询：${task.searchQuery || request.slice(0, 120)}。仅在检索片段不足时继续 inspect_document/read_document。`,
    target: `需要读取用户指定或可明确推断的目标文档。${references.length ? `候选路径：${references.join("、")}。` : "先定位目标路径。"}先 inspect_document，再按任务读取最小必要块。`,
    continuation: `需要承接已有正文。${continuationPath ? `目标路径：${continuationPath}。` : "先从对话和提案记录确定目标路径；无法确定时询问用户。"}先 inspect_document 查看标题结构，再用 read_document 的 lastSection=true 读取最后一节；文档没有 Markdown 标题时才读取最后一个自然块。仅补读维持连续性所需的片段。`,
  };
  return `当前任务：${task.label}

当前用户请求是本轮唯一要执行的指令。历史对话只用于理解指代和既有事实，不得把已经完成的旧修改要求自动并入本轮任务。

${taskInstructions(task.mode)}

上下文决策：${contextInstruction[task.documentContext]}

角色资料范围：${characterScopeInstruction}

文档写入约束：${documentInstruction}

按本次任务筛选的结构化创作资料（JSON；未出现的资料不代表不存在，需要时使用工具检索）：
${creativeContext}

用户使用 @ 指定的路径（尚未读取）：
${references.length ? references.map(path => `- ${path}`).join("\n") : "- 无"}`;
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

function taskInstructions(mode: WritingTaskMode): string {
  if (mode === "brainstorm") return `本次工作流：
- 先明确人物欲望、阻力、失败代价和不可逆后果。
- 给出三个真正不同的候选方向，分别说明核心冲突与后续潜力。
- 不把候选设想写入项目事实，除非作者明确选定。`;
  if (mode === "outline") return `本次工作流：
- 使用“卷/幕—章—场景”的动态分层大纲，每个节点都要有前因、行动、结果和状态变化。
- 同时维护人物弧、信息释放、伏笔埋设与回收，不使用只有事件名称的空洞大纲。
- 修改既有大纲前先读取相关行段，优先通过局部补丁提案提交。`;
  if (mode === "write_scene") return `本次工作流（内部执行，不输出分析过程）：
1. 确定场景开场状态、人物目标、阻力、信息变化和不可逆结果。
2. 根据人物已知信息和动机推演至少三个下一步行动，选择因果最强且不过度套路化的一项。
3. 写作正文；每个场景必须造成事实、关系、情绪或目标中的至少一项变化。
4. 检查事实、时间、地点、人物知情范围、叙事视角和风格漂移。
5. 删除替读者解释情绪或主题的句子，检查套语、同构句、泛化比喻、角色同声和段尾总结；只在有具体文本证据时修改。
6. 已有文档优先通过 propose_document_patch 提交。`;
  if (mode === "rewrite") return `本次工作流（内部执行，不输出分析过程）：
- 只改变作者明确要求调整的维度，保持其余事件事实、人物动机和信息顺序不变。
- 风格变化必须落实到叙述距离、句法节奏、对白比例、感官重点和信息释放。
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
  const rankedExamples = store.writingExamples().map((item) => ({
    item, score: task.exampleIds.includes(item.id) ? 1 : 0,
  })).sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt));
  const selectedExamples = rankedExamples.filter((entry) => entry.score > 0).slice(0, 2);
  const examples: Array<Record<string, string>> = [];
  let exampleBudget = 5_000;
  for (const { item } of selectedExamples) {
    const content = item.content.slice(0, Math.min(2_000, exampleBudget));
    const entry = {
      title: item.title,
      category: item.category,
      styleFingerprint: styleFingerprint(item.content, item.notes),
      content,
      notes: item.notes.slice(0, 400),
    };
    const size = JSON.stringify(entry).length;
    if (!content || size > exampleBudget) break;
    examples.push(entry); exampleBudget -= size;
  }
  return JSON.stringify({ task: task.mode, characters, writingExamples: examples });
}

function styleFingerprint(content: string, notes: string): string {
  const paragraphs = content.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const sentences = content.split(/[。！？!?]+/).map((item) => item.trim()).filter(Boolean);
  const averageSentenceLength = sentences.length
    ? Math.round(sentences.reduce((sum, item) => sum + item.length, 0) / sentences.length)
    : 0;
  const dialogueParagraphs = paragraphs.filter((item) => /^[“「『\"']/.test(item)).length;
  const dialogueRatio = paragraphs.length ? Math.round(dialogueParagraphs / paragraphs.length * 100) : 0;
  const rhythm = averageSentenceLength <= 16 ? "短促" : averageSentenceLength >= 32 ? "绵长" : "长短适中";
  return `句法节奏=${rhythm}；平均句长≈${averageSentenceLength}字；对白段落≈${dialogueRatio}%${notes.trim() ? `；显式要求=${notes.trim().slice(0, 300)}` : ""}`;
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
  const planned = await planWritingTask(model, project, store, prompt, history, signal);
  const task = planned.task;
  const executionModel = task.mode === "audit"
    ? options.models?.reviewer ?? model
    : task.mode === "rewrite"
    ? options.models?.inline ?? model
    : task.documentProposalRequired
      ? options.models?.writer ?? model
      : model;
  if (planned.usage && model.pricing) {
    emit({ type: "usage", usage: store.recordUsage(sessionId, model.model, planned.usage, model.pricing) });
  }
  const continuationPath = task.continuation
    ? task.targetPath ?? store.proposals().find(proposal => proposal.sessionId === sessionId)?.path
    : undefined;
  store.addMessage(sessionId, "user", prompt);
  const selectedContext = selectedBlocksContext(project, options.selectedDocumentBlocks);
  const historicalContext = historicalConversationContext(history);
  const messages: ApiMessage[] = [
    { role: "system", content: writingSystemPrompt(project) },
    { role: "system", content: executionRulesPrompt() },
    ...(historicalContext ? [historicalContext] : []),
    { role: "system", content: dynamicContextPrompt(project, store, prompt, task, characterScope, continuationPath) },
    ...(selectedContext ? [{ role: "system" as const, content: selectedContext }] : []),
    ...(task.mode === "audit" ? [{ role: "system" as const, content: REVIEW_PROMPT }] : []),
    { role: "system", content: writingHardConstraintsPrompt() },
    { role: "user", content: prompt },
  ];
  let transcript = "";
  let documentProposalSubmitted = false;
  let waitingForUser = false;

  try {
    const maxTurns = options.maxTurns ?? 20;
    let turnStart = messages.length;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      compactRuntimeMessages(messages);
      const step = turn + 1;
      const stepModel = documentProposalSubmitted ? model : executionModel;
      emit({ type: "step_start", step });
      const result = await streamCompletion(stepModel, messages, signal, (text) => {
        transcript += text;
        emit({ type: "text", text, channel: "output" });
      }, (text) => emit({ type: "text", text, channel: "reasoning" }), !documentProposalSubmitted);
      if (result.usage && stepModel.pricing) {
        emit({ type: "usage", usage: store.recordUsage(sessionId, stepModel.model, result.usage, stepModel.pricing) });
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
        const toolResult = executeTool(call, project, store, sessionId, emit, characterScope);
        if (call.name === "propose_document" || call.name === "propose_document_patch") {
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
重点扫描“不是……而是……”“并非……而是……”“没有……只有……”“与其说……不如说……”“仿佛……又仿佛……”等先否定再定义、刻意制造对照的僵硬句式。这类句式除非确实承载人物的主动辨析或关键逻辑，否则应删除解释框架，改为直接陈述、具体动作、感官细节、对白、停顿或留白。不要逐词替换成另一套对照句式，也不要保留“不是”后仅改写“而是”的内容。
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
    content: (() => {
      const content = stripDsmlText(message.content, "[工具调用已隐藏]");
      return content.length > 4_000
        ? `${content.slice(0, 2_400)}\n[中间内容已压缩；相关正文请从项目文档重新读取]\n${content.slice(-1_200)}`
        : content;
    })(),
  })));
  return result;
}

function compactRuntimeMessages(messages: ApiMessage[]): void {
  const toolIndexes = messages.flatMap((message, index) => message.role === "tool" ? [index] : []);
  for (const index of toolIndexes.slice(0, -3)) {
    const message = messages[index];
    if (message.content && message.content.length > 300) {
      message.content = JSON.stringify({ status: "工具结果已压缩，需要时请重新读取最小必要范围" });
    }
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
      return JSON.stringify(store.search(requireString(input.query, "query"), 8).filter(item => !project.isDocumentHidden(item.path)));
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

function documentMap(project: WriterProject): Array<{ path: string; lines: number; characters: number; headings: string[] }> {
  const result: Array<{ path: string; lines: number; characters: number; headings: string[] }> = [];
  let budget = 6_000;
  for (const path of project.listDocuments().filter(path => !project.isDocumentHidden(path)).slice(0, 100)) {
    const content = project.read(path);
    const entry = {
      path,
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
  const completed = {
    content: textual.content,
    reasoningContent,
    toolCalls: toolCalls.length ? toolCalls : textual.toolCalls,
    usage,
  };
  logModelResponse(endpoint, JSON.stringify(completed, null, 2));
  return completed;
}
