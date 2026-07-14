import { createHash } from "node:crypto";
import type { ToolDefinition } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const TOOLS = deepFreeze([
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
      name: "design_creative_outline",
      description: "为新建或重构大纲生成独立的创意规划简报：四条结构差异显著的路线、发散—收敛流程、100分评估表、反俗套约束，以及与结构化大纲一致的章节字段契约（摘要/前因/行动/结果/状态变化等）。outline 模式下对大纲文档的 propose_document/propose_document_patch 前必须先成功调用一次",
      parameters: {
        type: "object",
        properties: {
          premise: { type: "string", description: "故事前提或本次大纲任务的核心矛盾" },
          genre: { type: "string", description: "可选类型与气质" },
          audience: { type: "string", description: "可选目标读者" },
          targetChapters: { type: "number", description: "期望章节数，3—80" },
          constraints: { type: "array", items: { type: "string" }, description: "必须遵守的设定或形式约束" },
          existingBeats: { type: "array", items: { type: "string" }, description: "重构时必须保留的既有节拍" },
          seed: { type: "string", description: "可选路线种子；相同输入与种子得到相同设计镜头" },
        },
        required: ["premise"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "audit_prose_style",
      description: "对指定正文做风格审计：规则先扫说明性破折号、否定重定义、情绪/意图翻译、因果补注和主题总结，再由 Flash 复核候选并主动检查高风险段落中的解释回声。info/warning 不拦截提案；仅过密的高置信说明体（error）会拦截。对白拖音、列举、表格、停顿—揭示默认允许，不要为消符号而全文改写",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "项目内正文 Markdown 路径" } },
        required: ["path"], additionalProperties: false,
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
      description: "列出本次可读取的已有角色卡目录（若用户限制了角色范围则只返回范围内角色；本轮新建的角色也会出现）",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_character",
      description: "按 ID 分区读取 v3 角色卡。省略 sections 时返回完整卡；storyState 可结合 outlineNodeId 解析当前场景状态",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "角色 ID；先调用 list_characters 获取" },
          sections: { type: "array", description: "要读取的顶层分区；省略则读取完整角色卡", items: { type: "string", enum: ["identity", "profile", "psychology", "motivations", "voice", "competencies", "relationships", "storyState", "notes"] } },
          outlineNodeId: { type: "string", description: "读取 storyState 时的目标 outline 节点 ID；省略时不注入演进状态" },
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
      description: "创建或嵌套更新 schema v3 角色卡。省略分区保持原值；提供的数组整体替换；删除条目使用 deleteEntryIds。新建必须提供 identity.name",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "要更新的角色 ID（修改已有角色时必填，新建角色时省略）" },
          identity: { type: "object", description: "姓名、别名、标签、叙事角色和身份摘要", additionalProperties: true },
          profile: { type: "object", description: "外貌、辨识特征、背景摘要和人物小传", additionalProperties: true },
          psychology: { type: "object", description: "性格摘要及 traits/values/fears/conflicts 结构化条目", additionalProperties: true },
          motivations: { type: "array", description: "目标记录（id/category/status/priority/summary/stakes/obstacles/sourceRefs/validFrom/validUntil）", items: { type: "object", additionalProperties: true } },
          voice: { type: "object", description: "声线摘要、语域、措辞与示例对白", additionalProperties: true },
          competencies: { type: "array", description: "能力、资源、限制与代价记录", items: { type: "object", additionalProperties: true } },
          relationships: { type: "array", description: "单向关系记录；characterId 必须指向现有可读角色", items: { type: "object", additionalProperties: true } },
          storyStates: { type: "array", description: "剧情状态；每项必须有 outlineNodeId 或 unanchored=true", items: { type: "object", additionalProperties: true } },
          deleteEntryIds: { type: "object", description: "按 motivations/competencies/relationships/storyStates 显式删除条目 ID", additionalProperties: true },
          notes: { type: "string", description: "补充说明" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_simple_characters",
      description: "List simple character cards. These are stored separately from normal v3 character cards and are commonly used by roleplay participants",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_simple_character",
      description: "Read a complete simple character card by id, including identity, relationship, knowledge, scene, and goal",
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "Simple character id from list_simple_characters" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_simple_character",
      description: "创建或更新简易角色卡。它只包含角色扮演所需的名称、身份、关系、已知信息、场景和目标；创建前应按需检索已有角色卡与项目设定，避免与项目事实冲突。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "更新已有简易角色卡时填写；新建时省略" },
          name: { type: "string", description: "角色名称" },
          identity: { type: "string", description: "身份、职责、阵营与必要背景" },
          relationship: { type: "string", description: "与相关角色的关系" },
          knowledge: { type: "string", description: "当前已知信息与认知边界" },
          scene: { type: "string", description: "当前场景或常用出场环境" },
          goal: { type: "string", description: "当前目标" },
        },
        required: ["name", "identity", "relationship", "knowledge", "scene", "goal"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_conversation",
      description: "Inspect counts, channels, character size, and message id range for the complete current conversation archive",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_conversation",
      description: "Read the complete current conversation archive in chronological pages. For long roleplay-based writing, start with afterId=0 and channel=roleplay, then follow nextAfterId until hasMore=false",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", enum: ["roleplay", "agent"], description: "Omit for all channels; use roleplay for roleplay history" },
          afterId: { type: "number", description: "Only read after this message id; use 0 first and nextAfterId for later pages" },
          limit: { type: "number", description: "Messages per page, 1-80, default 40, also bounded by 16000 characters" },
        },
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
  {
    type: "function",
    function: {
      name: "manage_todos",
      description: "维护本轮多步任务清单（对齐 code agent 的 todo 工具）。复杂请求（≥3 步）开始时写入清单，推进时更新状态；同一时刻最多一项 in_progress。提交最终文档提案前应把相关项标为 completed。简单单步请求不必调用",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            maxItems: 30,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "稳定短 id，如 t1" },
                content: { type: "string", description: "任务描述" },
                status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
              },
              required: ["id", "content", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description: "加载项目技能全文（.writer/skills 或 .agents/skills 下的 SKILL.md）。仅当技能目录中有匹配项且细则对当前任务必要时调用",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "技能 id（目录名）或 name" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
] as const) as unknown as readonly ToolDefinition[];

export const TOOL_NAMES = new Set<string>(TOOLS.map(tool => tool.function.name));

/** Stable schema fingerprint: tool order and definitions are part of the provider KV-cache prefix. */
export function agentToolSchemaHash(): string {
  return createHash("sha256").update(JSON.stringify(TOOLS)).digest("hex").slice(0, 16);
}

export function agentToolNames(): string[] {
  return TOOLS.map(tool => tool.function.name);
}
