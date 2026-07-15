import { createHash } from "node:crypto";
import type { ToolDefinition } from "./types.js";

/**
 * Agent tool definitions (prompt-cache critical).
 *
 * CACHE RULES (see agent.ts PROMPT / PREFIX-CACHE CONTRACT):
 * - Keep names, order, and parameter schemas stable; tools JSON is sent every step.
 * - Descriptions may document conventions (lore/outline/chapters) but must not embed
 *   live project path lists, character ids, or session state.
 * - Prefer free-form string/number parameters over enums that grow with the project.
 * - Do not build a per-mode or per-project tool subset for the main agent unless that
 *   subset is fixed for the whole session — swapping tools mid-session breaks the
 *   tools-side of the provider prefix cache.
 * - After structural changes, update agentToolSchemaHash expectations in tests.
 */

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
      description: "列出 Markdown 文档及 kind（lore/outline/chapter/archive/side/other）",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_document",
      description: "查看行数、标题结构与首尾预览；长文档先调用",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "相对路径" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description: "按节/块/行范围截取；有行号时读最小范围；长文先 inspect",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对路径" },
          block: { type: "number", description: "块号，从 1 起" },
          section: { type: "string", description: "Markdown 标题文本（不含 #）" },
          lastSection: { type: "boolean", description: "读最后一节；续写优先" },
          startLine: { type: "number", description: "起始行，与 endLine 同用" },
          endLine: { type: "number", description: "结束行；最多 200 行/12000 字" },
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
      description: "在项目 Markdown 中搜索概念/设定，返回路径、标题、行号与上下文",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "短查询" },
          scope: {
            type: "string",
            enum: ["all", "lore", "story", "outline", "chapters"],
            description: "范围；story≡lore",
          },
          pathPrefix: { type: "string", description: "目录前缀" },
          mode: { type: "string", enum: ["any", "all", "exact"], description: "匹配模式" },
          contextLines: { type: "number", description: "上下文行 0–12，默认 2" },
          limit: { type: "number", description: "结果数 1–12，默认 8" },
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
      description: "仅当用户明确要求大纲/卷纲/全书章节规划时使用；单章正文禁止调用。未给总章数时只生成轻量方向引导，不展开全书章节表",
      parameters: {
        type: "object",
        properties: {
          premise: { type: "string", description: "前提或核心矛盾" },
          genre: { type: "string", description: "类型气质" },
          audience: { type: "string", description: "读者" },
          targetChapters: { type: "number", description: "章数 3–80" },
          constraints: { type: "array", items: { type: "string" }, description: "硬约束" },
          existingBeats: { type: "array", items: { type: "string" }, description: "须保留节拍" },
          seed: { type: "string", description: "路线种子" },
        },
        required: ["premise"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "audit_prose_style",
      description: "风格审计（说明体/解释回声等）；仅过密 error 拦截提案",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "正文路径" } },
        required: ["path"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_outline_nodes",
      description: "大纲节点目录（id/层级/摘要/状态/正文关联）",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["act", "chapter", "scene"], description: "类型过滤" },
          status: { type: "string", enum: ["idea", "planned", "drafted", "diverged"], description: "状态过滤" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_outline_node",
      description: "读取大纲节点字段与原文；id 用 UUID 或唯一标题，勿用纯章号",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "节点 UUID 或唯一标题" } },
        required: ["id"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_outline_patch",
      description: "对已读大纲节点做 search/replace 提案；search 须在节点内唯一",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "节点 ID" },
          search: { type: "string", description: "唯一原文" },
          replace: { type: "string", description: "替换 Markdown" },
          summary: { type: "string", description: "修改摘要" },
        },
        required: ["id", "search", "replace", "summary"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "validate_outline",
      description: "检查场景缺字段与未回收伏笔",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_outline_with_draft",
      description: "大纲场景与关联正文的基础偏离检查",
      parameters: {
        type: "object", properties: { id: { type: "string", description: "场景节点 ID" } },
        required: ["id"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compile_write_pack",
      description: "写前编译：把大纲/设定/衔接笔记编译为故事内可写材料；写场景提案前必调",
      parameters: {
        type: "object",
        properties: {
          notes: {
            type: "string",
            description: "情节笔记（可用 ## 场景目标/人物当下/事件顺序/已知事实/须自然落地/勿擅自补写/声线提醒）",
          },
          targetPath: { type: "string", description: "目标正文路径（仅脱敏，不注入）" },
          instruction: { type: "string", description: "本轮写作要求摘要（可选）" },
          sceneId: { type: "string", description: "逐场景章节草稿中的场景 id" },
        },
        required: ["notes"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "begin_chapter_draft",
      description: "建立整章场景链与内存草稿；不写项目文件",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "chapters/ 下目标路径" },
          mode: { type: "string", enum: ["create", "replace", "append"] },
          heading: { type: "string", description: "create/replace 时的章节标题（不含 #）" },
          chapterGoal: { type: "string", description: "整章结束后真正改变什么" },
          scenes: {
            type: "array", minItems: 1, maxItems: 8,
            description: "有因果承接的场景链；通常 3—6 场，不为凑数拆场",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "本章内唯一短 id" },
                title: { type: "string", description: "内部场景名，不写入正文" },
                goal: { type: "string", description: "本场要完成的变化" },
                entryState: { type: "array", items: { type: "string" }, description: "入场局面" },
                characterIntent: { type: "array", items: { type: "string" }, description: "人物各自诉求" },
                obstacle: { type: "string", description: "直接阻力" },
                turn: { type: "string", description: "预期落空/代价/关系或目标变化" },
                outcome: { type: "string", description: "本场直接结果" },
                handoff: { type: "string", description: "如何因果交给下一场；末场可空" },
                dividerBefore: { type: "boolean", description: "场前是否需要 --- 硬切" },
                targetCharacters: { type: "number", description: "预计字数 200—8000" },
              },
              required: ["id", "goal", "obstacle", "turn", "outcome"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "mode", "chapterGoal", "scenes"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_chapter_scene",
      description: "写入或重写一场到内存草稿；同 sceneId 须先 compile_write_pack",
      parameters: {
        type: "object",
        properties: {
          sceneId: { type: "string" },
          content: { type: "string", description: "仅本场正文，不含章节一级标题" },
          actualState: {
            type: "object",
            description: "从实际正文归纳的离场状态；不可照抄计划",
            properties: {
              situation: { type: "array", items: { type: "string" } },
              physical: { type: "array", items: { type: "string" } },
              knowledge: { type: "array", items: { type: "string" } },
              relationships: { type: "array", items: { type: "string" } },
              goals: { type: "array", items: { type: "string" } },
              openLoops: { type: "array", items: { type: "string" } },
              usedMotifs: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        },
        required: ["sceneId", "content", "actualState"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_chapter_draft",
      description: "返回组装整章与逐场状态账本；最终提案前必调",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_chapter_draft",
      description: "提交已逐场完成并整章审阅的章节；只在最后一次写场后 inspect 过才可用",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "修改摘要" },
          chapterChange: { type: "string", description: "一句话说明章首到章尾的总变化" },
          reviewNotes: { type: "string", description: "接缝、重复功能与转折多样性审阅结论" },
          characterChanges: {
            type: "array", maxItems: 8,
            items: {
              type: "object",
              properties: {
                characterId: { type: "number" }, reason: { type: "string" },
                changes: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: true } },
              },
              required: ["characterId", "reason", "changes"], additionalProperties: false,
            },
          },
        },
        required: ["summary", "chapterChange", "reviewNotes"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_document",
      description: "提交完整文档新版本（新建或全文重写）；局部改用 patch",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文档路径" },
          content: { type: "string", description: "完整 Markdown" },
          summary: { type: "string", description: "修改摘要" },
          characterChanges: {
            type: "array", maxItems: 8,
            description: "可选：提案获批后才生效的角色演进",
            items: {
              type: "object",
              properties: {
                characterId: { type: "number", description: "角色 ID" },
                reason: { type: "string", description: "正文依据" },
                changes: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: true } },
              },
              required: ["characterId", "reason", "changes"], additionalProperties: false,
            },
          },
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
      description: "精确 search/replace 局部提案；每段 search 须唯一。续写用末段作 search",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文档路径" },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                search: { type: "string", description: "唯一原文" },
                replace: { type: "string", description: "替换文本；空=删除" },
              },
              required: ["search", "replace"],
              additionalProperties: false,
            },
          },
          summary: { type: "string", description: "修改摘要" },
          characterChanges: {
            type: "array", maxItems: 8,
            description: "可选：补丁获批后生效的角色演进",
            items: {
              type: "object",
              properties: {
                characterId: { type: "number" }, reason: { type: "string" },
                changes: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: true } },
              },
              required: ["characterId", "reason", "changes"], additionalProperties: false,
            },
          },
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
      description: "列出可读普通角色卡（含本轮新建；受角色范围限制）",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_character",
      description: "按 ID 读 v3 角色卡；可 sections 分区。locked 能力不可当已用",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "角色 ID" },
          sections: {
            type: "array",
            description: "顶层分区；省略=全卡",
            items: {
              type: "string",
              enum: ["identity", "profile", "psychology", "motivations", "voice", "competencies", "relationships", "storyState", "experiences", "notes"],
            },
          },
          outlineNodeId: { type: "string", description: "场景态/经历用的大纲节点 ID" },
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
      description: "创建/嵌套更新 v3 角色卡；数组按 id upsert。情节小改优先 apply_character_changes。新建须 identity.name",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "更新时必填；新建省略" },
          identity: { type: "object", description: "身份", additionalProperties: true },
          profile: { type: "object", description: "外貌/背景", additionalProperties: true },
          psychology: { type: "object", description: "心理", additionalProperties: true },
          motivations: { type: "array", description: "目标", items: { type: "object", additionalProperties: true } },
          voice: { type: "object", description: "声线", additionalProperties: true },
          competencies: { type: "array", description: "能力", items: { type: "object", additionalProperties: true } },
          relationships: { type: "array", description: "关系", items: { type: "object", additionalProperties: true } },
          storyStates: { type: "array", description: "剧情状态", items: { type: "object", additionalProperties: true } },
          experiences: { type: "array", description: "经历", items: { type: "object", additionalProperties: true } },
          deleteEntryIds: {
            type: "object",
            description: "按分区删条目 ID",
            additionalProperties: true,
          },
          replaceSections: {
            type: "array",
            description: "整节替换的分区名",
            items: { type: "string" },
          },
          notes: { type: "string", description: "备注" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_character_changes",
      description: "已确认事实的角色演进（解锁/经历/心理/目标/关系/场景态）。ops 见系统约定；新建用 save_character",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "角色 ID" },
          reason: { type: "string", description: "已确认事实摘要" },
          sourceRef: {
            type: "object",
            description: "来源 type+ref",
            additionalProperties: true,
          },
          changes: {
            type: "array",
            description: "含 op 的变更列表",
            items: { type: "object", additionalProperties: true },
          },
        },
        required: ["id", "reason", "changes"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_simple_characters",
      description: "列出简易角色卡（与 v3 普通卡分离，常用于扮演）",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_simple_character",
      description: "按 id 读简易角色卡全字段",
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "简易卡 ID" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_simple_character",
      description: "创建/更新简易角色卡（name/identity/relationship/knowledge/scene/goal）",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "更新时填写" },
          name: { type: "string", description: "名称" },
          identity: { type: "string", description: "身份" },
          relationship: { type: "string", description: "关系" },
          knowledge: { type: "string", description: "已知信息" },
          scene: { type: "string", description: "场景" },
          goal: { type: "string", description: "目标" },
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
      description: "查看完整会话归档的计数、通道与 id 范围",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_conversation",
      description: "分页读完整会话归档；长扮演史 from afterId=0 channel=roleplay 直至 hasMore=false",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", enum: ["roleplay", "agent"], description: "通道；省略=全部" },
          afterId: { type: "number", description: "从此 id 之后读；首页 0" },
          limit: { type: "number", description: "每页 1–80，默认 40" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "缺关键事实/目标且无法推断时提问并暂停；可逆创作选择勿滥用。勿与其他工具同轮",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "问题（≤120 字）" },
          options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5, description: "可选选项" },
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
      description: "维护本轮多步 todos；同时至多一项 in_progress",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            maxItems: 30,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "如 t1" },
                content: { type: "string", description: "描述" },
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
      description: "加载项目技能全文（.writer/skills 或 .agents/skills）",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "技能 id 或 name" },
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
