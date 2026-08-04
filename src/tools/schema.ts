import { createHash } from "node:crypto";
import {
  MAX_CHAPTER_TARGET_CHARACTERS,
  MIN_CHAPTER_TARGET_CHARACTERS,
} from "../agent_runtime.js";
import { PROSE_TARGET_BAND_TEXT } from "../prose_length.js";
import type { ToolDefinition } from "./types.js";

/**
 * Agent tool definitions (prompt-cache critical).
 *
 * CACHE RULES (see agent.ts PROMPT / PREFIX-CACHE CONTRACT):
 * - Keep names, order, and parameter schemas stable; tools JSON is sent every step.
 * - Descriptions may document conventions (lore/outline/chapters) but must not embed
 *   live project path lists, character ids, or session state.
 * - Prefer free-form string/number parameters over enums that grow with the project.
 * - Every non-plan task receives the same order-preserving catalog. Semantic
 *   task contracts authorize side effects at runtime; never remove recovery
 *   capabilities because of a fallible mode label or live project state.
 * - After structural changes, update agentToolSchemaHash expectations in tests.
 */

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const TOOL_DEFINITIONS = deepFreeze([
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
      description: "查看行数、3k 字符块、标题、首尾预览与 sourceHash；长文档先调用",
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
      name: "locate_document_span",
      description: "用精确引用、标题或隔离语义定位器返回段落锚点；模糊修改先定位再按锚点读",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目标文档路径" },
          sourceHash: { type: "string", description: "可选快照哈希" },
          quote: { type: "string", description: "精确原文；优先" },
          heading: { type: "string", description: "Markdown 标题文本" },
          query: { type: "string", description: "无法给出原文时的语义定位意图" },
        },
        required: ["path"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description: "按节/3k 字符块/行范围读取一个有界快照；单次正文最多 4k 字符。长文先 inspect，后续传 sourceHash 防止混读版本",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对路径" },
          sourceHash: { type: "string", description: "可选；inspect 返回的快照哈希，文档变化时拒绝读取" },
          quote: { type: "string", description: "原文引用片段；返回行号与上下文，勿再通读或反复 search" },
          block: { type: "number", description: "块号，从 1 起" },
          section: { type: "string", description: "Markdown 标题文本（不含 #）" },
          lastSection: { type: "boolean", description: "读最后一节；续写优先" },
          startLine: { type: "number", description: "起始行，与 endLine 同用" },
          endLine: { type: "number", description: "结束行；最多 120 行/4000 字符" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document_span",
      description: "按快照锚点读取目标段及最多三个邻段；默认上限1800字符，写入使用anchorId+spanHash",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目标文档路径" },
          sourceHash: { type: "string", description: "locate/inspect 返回的快照哈希" },
          anchorId: { type: "string", description: "单一目标锚点" },
          startAnchorId: { type: "string", description: "范围起点；与 anchorId 二选一" },
          endAnchorId: { type: "string", description: "范围终点" },
          beforeParagraphs: { type: "number", description: "前置邻段 0–3" },
          afterParagraphs: { type: "number", description: "后置邻段 0–3" },
          maxCharacters: { type: "number", description: "返回上限 500–4000，默认1800" },
        },
        required: ["path", "sourceHash"], additionalProperties: false,
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
      name: "list_files",
      description: "分页列出 resource/ 内可访问的 UTF-8 纯文本文件；不限于 Markdown",
      parameters: {
        type: "object",
        properties: {
          pathPrefix: { type: "string", description: "可选目录前缀" },
          cursor: { type: "string", description: "上一页 nextCursor" },
          limit: { type: "number", description: "每页 1-200，默认 100" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_file",
      description: "查看 resource/ 内纯文本文件的行数、3k 字符块、首尾预览与 sourceHash",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "resource/ 内相对路径" } },
        required: ["path"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取 resource/ 内 UTF-8 文本；优先返回本轮工作副本，支持引用、3k 字符块或行范围，单次最多 4k 字符",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "resource/ 内相对路径" },
          sourceHash: { type: "string", description: "可选；上次 read_file 返回的快照哈希，文件变化时拒绝读取" },
          quote: { type: "string", description: "精确原文定位" },
          block: { type: "number", description: "块号，从 1 起" },
          startLine: { type: "number", description: "起始行，与 endLine 同用" },
          endLine: { type: "number", description: "结束行，最多 120 行/4000 字符" },
        },
        required: ["path"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "在 resource/ 的所有可见 UTF-8 文本中检索原文，返回路径、行号和上下文",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要查找的原文" },
          pathPrefix: { type: "string", description: "可选目录前缀" },
          limit: { type: "number", description: "结果数 1-20，默认 8" },
        },
        required: ["query"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "新建或完整替换 resource/ 内 UTF-8 文本工作副本；已有工作副本或已终审场景草稿时可省略 content 重新验证",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "resource/ 内相对路径" },
          content: { type: "string", description: "完整文件内容" },
        },
        required: ["path"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "精确编辑 resource/ 内当前工作副本；驳回稿无需重传全文，oldText 必须唯一",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "resource/ 内相对路径" },
          sourceHash: { type: "string", description: "可选；read_file 返回的当前工作副本哈希" },
          edits: {
            type: "array", minItems: 1, maxItems: 20,
            items: {
              type: "object",
              properties: {
                operation: {
                  type: "string",
                  enum: ["replace", "delete", "insert_before", "insert_after"],
                  description: "默认 replace",
                },
                oldText: { type: "string", description: "当前工作副本中的唯一原文" },
                content: { type: "string", description: "新文本；delete 可省略" },
              },
              required: ["oldText"], additionalProperties: false,
            },
          },
        },
        required: ["path", "edits"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description: "移动 resource/ 内文本文件；变更经 CAS 与审批，不能把未审核文本移入正文目录",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "源文件相对路径" },
          targetPath: { type: "string", description: "目标相对路径" },
          sourceHash: { type: "string", description: "可选；read_file 返回的源文件哈希" },
        },
        required: ["path", "targetPath"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "删除 resource/ 内文本文件；变更经 CAS 与审批",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件相对路径" },
          sourceHash: { type: "string", description: "可选；read_file 返回的文件哈希" },
        },
        required: ["path"], additionalProperties: false,
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
      description: "审计任意可见 UTF-8 文本的 AI 生成腔；正文另含说明体/解释回声诊断，资料文档按资料画像避免误报",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "resource/ 内相对路径" } },
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
          deliverableId: { type: "string", description: "多文档任务的交付项 ID；单文档可省略" },
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
      description: "非章节正文写前编译：把大纲/设定/衔接笔记编译为故事内可写材料",
      parameters: {
        type: "object",
        properties: {
          notes: {
            type: "string",
            description: "要点式情节笔记（上限 4000 字；可用 ## 场景目标/人物当下/事件顺序/已知事实/须自然落地/勿擅自补写/声线提醒）",
          },
          targetPath: { type: "string", description: "目标正文路径（仅脱敏，不注入）" },
          instruction: { type: "string", description: "本轮写作要求摘要（可选）" },
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
      description: "为章节或支线片段建立可调整的初始 scene guide 与内存草稿；不写项目文件",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "chapters/ 或 side/ 下目标路径" },
          mode: { type: "string", enum: ["create", "replace", "append"] },
          heading: { type: "string", description: "create/replace 时的正文标题（不含 #）" },
          chapterGoal: { type: "string", description: "全文结束后真正改变什么" },
          scenes: {
            type: "array", minItems: 1, maxItems: 8,
            description: "初始场景引导；写作中可按实际结果调整，不是必须逐项照抄的提纲",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "本文内唯一短 id" },
                title: { type: "string", description: "内部场景名，不写入正文" },
                goal: { type: "string", description: "本场要完成的变化" },
                entryState: { type: "array", items: { type: "string" }, description: "入场局面" },
                characterIntent: { type: "array", items: { type: "string" }, description: "人物各自诉求" },
                obstacle: { type: "string", description: "直接阻力" },
                turn: { type: "string", description: "预期落空/代价/关系或目标变化" },
                outcome: { type: "string", description: "本场直接结果" },
                readerQuestion: { type: "string", description: "若本场需要悬问，写读者继续关心什么；允许本场回答并转化" },
                cost: { type: "string", description: "若本场确有代价，写谁失去了什么；不为填字段制造损失" },
                oppositionMove: { type: "string", description: "若存在主动阻力，写其行动；静场或内在变化可省略" },
                handoff: { type: "string", description: "如何因果交给下一场；末场可空" },
                dividerBefore: { type: "boolean", description: "场前是否需要 --- 硬切" },
                targetCharacters: { type: "number", description: `本场目标正文 200—8000 字；工具按 ${PROSE_TARGET_BAND_TEXT} 验收` },
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
      name: "write_document_isolated",
      description: "用隔离 Writer 一次生成并提议短篇单场正文；长篇或多次关键转折改用场景链",
      parameters: {
        type: "object",
        properties: {
          deliverableId: { type: "string", description: "多文档任务的交付项 ID；单文档可省略" },
          path: { type: "string", description: "chapters/ 或 side/ 下目标路径" },
          mode: { type: "string", enum: ["create", "replace", "append"] },
          sourceHash: { type: "string", description: "replace/append 时必传当前文档哈希" },
          heading: { type: "string", description: "create/replace 时的正文标题（不含 #）" },
          goal: { type: "string", description: "全文结束后真正改变什么" },
          entryState: { type: "array", items: { type: "string" }, description: "入场局面" },
          characterIntent: { type: "array", items: { type: "string" }, description: "人物各自诉求" },
          obstacle: { type: "string", description: "直接阻力" },
          turn: { type: "string", description: "预期落空、代价或关系变化" },
          outcome: { type: "string", description: "正文收束时的直接结果" },
          notes: { type: "string", description: "故事内材料；长度上限由场景链设置决定" },
          targetCharacters: { type: "number", description: `目标正文 500—5000 字；工具按 ${PROSE_TARGET_BAND_TEXT} 验收并在偏差时重试` },
          summary: { type: "string", description: "提案摘要" },
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
        required: ["path", "mode", "goal", "obstacle", "turn", "outcome", "notes", "targetCharacters", "summary"],
        additionalProperties: false,
      },
    },
  },
  // Scene writing has two payload contracts. Keep both tools in this fixed
  // catalog: switching schemas by runtime mode would destroy provider prefix
  // cache reuse, while a shared weak schema lets standard calls omit required data.
  {
    type: "function",
    function: {
      name: "write_chapter_scene",
      description: "标准/Fast 场景写入：提交故事内 notes、本场正文和实际离场状态",
      parameters: {
        type: "object",
        properties: {
          sceneId: { type: "string" },
          notes: {
            type: "string",
            description: "故事内场景笔记；长度上限由场景链设置决定。只保留本场人物当下、事件、事实边界与不可擅自确定项",
          },
          content: { type: "string", description: `仅本场正文，不含任何 markdown 标题；guide 有 targetCharacters 时按 ${PROSE_TARGET_BAND_TEXT} 验收` },
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
        required: ["sceneId", "notes", "content", "actualState"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_chapter_scene_notes",
      description: "隔离 Writer 场景写入：只提交故事内 notes，由工具生成正文并提取实际离场状态",
      parameters: {
        type: "object",
        properties: {
          sceneId: { type: "string" },
          notes: {
            type: "string",
            description: "故事内场景笔记；长度上限由场景链设置决定。只保留本场人物当下、事件、事实边界与不可擅自确定项",
          },
        },
        required: ["sceneId", "notes"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "revise_chapter_scene_guide",
      description: "根据已写正文与 actualState 替换所有未写场景引导；可增删、合并、改序或清空后终审",
      parameters: {
        type: "object",
        properties: {
          remainingScenes: {
            type: "array", minItems: 0, maxItems: 8,
            description: "新的剩余场景引导；不含已完成场景，空数组表示当前正文已经收束",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "本文内唯一短 id，不得与已完成场景重复" },
                title: { type: "string", description: "内部场景名，不写入正文" },
                goal: { type: "string", description: "当前判断下本场要完成的变化" },
                entryState: { type: "array", items: { type: "string" }, description: "从 actualState 出发的入场局面" },
                characterIntent: { type: "array", items: { type: "string" }, description: "人物各自诉求" },
                obstacle: { type: "string", description: "直接阻力" },
                turn: { type: "string", description: "可能的落空、代价或变化方向，不要求正文照抄" },
                outcome: { type: "string", description: "预期结果；实际正文可以合理偏离" },
                readerQuestion: { type: "string", description: "若剩余场景需要悬问，写读者继续关心什么" },
                cost: { type: "string", description: "若剩余场景确有代价，写谁失去了什么" },
                oppositionMove: { type: "string", description: "若存在主动阻力，写其行动" },
                handoff: { type: "string", description: "可能如何交给下一场；末场可空" },
                dividerBefore: { type: "boolean", description: "场前是否需要 --- 硬切" },
                targetCharacters: { type: "number", description: `本场目标正文 200—8000 字；工具按 ${PROSE_TARGET_BAND_TEXT} 验收` },
              },
              required: ["id", "goal", "obstacle", "turn", "outcome"],
              additionalProperties: false,
            },
          },
          reason: { type: "string", description: "根据已写结果调整引导的简短原因" },
        },
        required: ["remainingScenes"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "revise_chapter_draft_style",
      description: "对已完成的内存正文草稿做精确局部风格替换；保留离场状态和所有后续场景，风格门禁退回时优先使用",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array", minItems: 1, maxItems: 20,
            description: "只替换风格门禁明确命中的句段；每个 search 在全文草稿中必须唯一",
            items: {
              type: "object",
              properties: {
                search: { type: "string", description: "草稿中唯一存在的原句或短段" },
                replace: { type: "string", description: "不改变事实、行动结果和人物状态的替换文本；可为空以删除冗余句" },
              },
              required: ["search", "replace"],
              additionalProperties: false,
            },
          },
        },
        required: ["edits"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_chapter_draft",
      description: "检查内存全文并在终审通过时直接创建提案；结构/风格未通过则返回精确修订目标",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "终审通过后用于提案的修改摘要" },
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
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_chapter_draft",
      description: "兼容性重试：仅当 inspect_chapter_draft 已通过终审但自动建提案失败时提交；正常流程无需调用",
      parameters: {
        type: "object",
        properties: {
          deliverableId: { type: "string", description: "多文档任务的交付项 ID；单文档可省略" },
          summary: { type: "string", description: "修改摘要" },
          chapterChange: { type: "string", description: "一句话说明全文开头到结尾的总变化" },
          reviewNotes: { type: "string", description: "接缝、重复功能与转折多样性审阅结论" },
          characterChanges: {
            type: "array", maxItems: 8,
            items: {
              type: "object",
              properties: {
                characterId: { type: "number" }, reason: { type: "string" },
                changes: { type: "array", description: "op 同 apply_character_changes", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: true } },
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
          deliverableId: { type: "string", description: "多文档任务的交付项 ID；单文档可省略" },
          path: { type: "string", description: "文档路径" },
          content: { type: "string", description: "完整 Markdown" },
          targetCharacters: { type: "number", description: `正文目标字数 ${MIN_CHAPTER_TARGET_CHARACTERS}—${MAX_CHAPTER_TARGET_CHARACTERS}；章节/支线正文须传，用本轮篇幅目标，按 ${PROSE_TARGET_BAND_TEXT} 验收（不计首行标题）：超上限拒收，不足下限只提示` },
          summary: { type: "string", description: "修改摘要" },
          characterChanges: {
            type: "array", maxItems: 8,
            description: "可选：提案获批后才生效的角色演进",
            items: {
              type: "object",
              properties: {
                characterId: { type: "number", description: "角色 ID" },
                reason: { type: "string", description: "正文依据" },
                changes: { type: "array", description: "op 同 apply_character_changes", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: true } },
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
      description: "局部提案；优先使用sourceHash+anchorId+spanHash，兼容唯一search/replace",
      parameters: {
        type: "object",
        properties: {
          deliverableId: { type: "string", description: "多文档任务的交付项 ID；单文档可省略" },
          path: { type: "string", description: "文档路径" },
          sourceHash: { type: "string", description: "锚点 patch 必填；文档变化时拒绝" },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                search: { type: "string", description: "兼容模式：唯一原文" },
                replace: { type: "string", description: "兼容模式替换文本；空=删除" },
                anchorId: { type: "string", description: "推荐：read_document_span 返回的目标锚点" },
                spanHash: { type: "string", description: "推荐：目标段内容哈希" },
                operation: { type: "string", enum: ["replace", "delete", "insert_before", "insert_after"], description: "锚点操作，默认replace" },
                content: { type: "string", description: "锚点模式的新文本；delete可省略" },
              },
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
                changes: { type: "array", description: "op 同 apply_character_changes", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: true } },
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
      name: "revise_document_isolated",
      description: "仅通篇修改：服务端逐块隔离改写并组装完整提案，原文不进入主Agent循环",
      parameters: {
        type: "object",
        properties: {
          deliverableId: { type: "string", description: "多文档任务的交付项 ID；单文档可省略" },
          path: { type: "string", description: "目标文档路径" },
          sourceHash: { type: "string", description: "inspect_document 返回的快照哈希" },
          instruction: { type: "string", description: "适用于全文的明确修改要求" },
          summary: { type: "string", description: "提案摘要" },
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
        required: ["path", "sourceHash", "instruction", "summary"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_change_set",
      description: "统一提议多个纯文本文件的写入/精确补丁/移动/删除及角色演进；整体审批、校验、应用和回滚",
      parameters: {
        type: "object",
        properties: {
          deliverableId: { type: "string", description: "多文档任务的交付项 ID；单文档可省略" },
          summary: { type: "string", description: "整组变更摘要" },
          files: {
            type: "array", maxItems: 20,
            items: {
              type: "object",
              properties: {
                operation: { type: "string", enum: ["write", "patch", "move", "delete"] },
                path: { type: "string", description: "resource/ 内源路径；write 可新建" },
                targetPath: { type: "string", description: "move 的目标路径" },
                content: { type: "string", description: "write 的完整 UTF-8 文本，可为空" },
                edits: {
                  type: "array", minItems: 1, maxItems: 20,
                  items: {
                    type: "object",
                    properties: { search: { type: "string" }, replace: { type: "string" } },
                    required: ["search", "replace"], additionalProperties: false,
                  },
                },
              },
              required: ["operation", "path"], additionalProperties: false,
            },
          },
          characterChanges: {
            type: "array", maxItems: 8,
            description: "整组审批成功后一起生效的角色演进；格式同 propose_document",
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
        required: ["summary"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_characters",
      description: "列出可读普通角色卡及分区计数/更新时间（含本轮新建；受角色范围限制）",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_character",
      description: "按 ID 分层读 v3 角色卡：写作先 summary，不足用 sections；编辑直接 edit，可用 sections 限定编辑分区",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "角色 ID" },
          view: {
            type: "string",
            enum: ["summary", "sections", "edit"],
            description: "summary=必要摘要；sections=写作安全的指定分区；edit=完整可编辑字段，可配 sections 限定范围。省略时有 sections 则为 sections，否则 summary",
          },
          sections: {
            type: "array",
            description: "view=sections 时必填；view=edit 时可选，指定则只读这些编辑分区",
            items: {
              type: "string",
              enum: ["identity", "profile", "psychology", "motivations", "voice", "features", "competencies", "relationships", "storyState", "experiences", "notes"],
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
          expectedUpdatedAt: { type: "string", description: "更新已有卡必填；来自最近一次 get_character，防止覆盖并发修改" },
          identity: { type: "object", description: "身份", additionalProperties: true },
          profile: { type: "object", description: "外形/背景；appearance/background 为详情，两个 Summary 为逐行要点摘要（每行一项）", additionalProperties: true },
          psychology: { type: "object", description: "心理", additionalProperties: true },
          motivations: { type: "array", description: "目标", items: { type: "object", additionalProperties: true } },
          voice: { type: "object", description: "声线", additionalProperties: true },
          features: { type: "array", description: "特性（不属于能力的稳定细节）", items: { type: "object", additionalProperties: true } },
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
      description: "已确认事实的角色演进（解锁/经历/心理/目标/关系/场景态）；新建用 save_character",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "角色 ID" },
          reason: { type: "string", description: "已确认事实摘要" },
          changes: {
            type: "array",
            description: "变更列表。op 及参数：set_unlocked{competencyId,unlocked} / upsert_competency{entry} / set_psychology_summary{summary} / upsert_psychology_entry{group:traits|values|fears|conflicts,entry:{label,description}} / delete_psychology_entry{group,entryId} / add_experience{entry:{label,description}} / delete_experience{entryId} / upsert_motivation{entry:{summary,category,status}} / upsert_relationship{entry:{characterId,type,attitude,description}} / upsert_story_state{entry:{outlineNodeId或unanchored:true,location|physical|emotion|notes|knowledge|beliefs|intentions|temporaryGoals}} / delete_entry{section,entryId}。entry 带 id=更新，省略=新增",
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
      name: "read_context_artifact",
      description: "分页读取被 token 预算裁剪的完整工具结果；仅凭 artifactId 读取必要页",
      parameters: {
        type: "object",
        properties: {
          artifactId: { type: "number", description: "工具结果返回的 artifactId" },
          offset: { type: "number", description: "字符偏移，首页为 0" },
          limit: { type: "number", description: "每页 500–6000 字符，默认 4000" },
        },
        required: ["artifactId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_prose_gates",
      description: "管理项目级语义复审规则；作者明确要求以后持续检查/避免某类问题时 upsert，单次改稿偏好不要沉淀",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["list", "upsert", "enable", "disable", "remove"] },
          id: { type: "string", description: "稳定英文短 ID；list 时省略" },
          instruction: { type: "string", description: "可独立执行的语义核验标准；upsert 必填" },
          severity: { type: "string", enum: ["block", "warn"], description: "确定错误用 block，偏好风险用 warn" },
          enabled: { type: "boolean", description: "upsert 后是否启用，默认 true" },
          documentKinds: { type: "array", items: { type: "string", enum: ["chapter", "side", "lore", "outline", "archive", "other", "writing_example"] }, description: "适用文档类型；空或省略表示全部" },
          pathPrefixes: { type: "array", items: { type: "string" }, maxItems: 12, description: "适用资源路径前缀；空或省略表示全部" },
          sourceFeedback: { type: "string", description: "触发沉淀的作者反馈摘要，不粘贴长对话" },
        },
        required: ["operation"],
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
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "调用独立生图模型生成一张图片并附到本轮回复；仅在用户明确要求图片产物时调用。必须独占一步，勿与其他工具同批调用",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "完整、可独立执行的视觉提示词" },
          referenceAttachmentIds: { type: "array", items: { type: "string" }, maxItems: 4, description: "可选，同一会话可用图片参考中的附件 ID；传入后按改图接口上传原图" },
          name: { type: "string", description: "可选文件名，如 chapter-cover.png" },
          size: { type: "string", enum: ["auto", "1024x1024", "1536x1024", "1024x1536"] },
          quality: { type: "string", enum: ["auto", "low", "medium", "high"] },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
] as const) as unknown as readonly ToolDefinition[];

// Historical handlers remain executable for replay/resume compatibility, but
// new model requests receive one coherent resource-file interface.
const LEGACY_MODEL_FILE_TOOLS = new Set([
  "list_documents",
  "inspect_document",
  "locate_document_span",
  "read_document",
  "read_document_span",
  "search_project",
  "inspect_file",
  "propose_outline_patch",
  "propose_document",
  "write_document_isolated",
  "propose_document_patch",
  "revise_document_isolated",
  "propose_change_set",
  "propose_chapter_draft",
]);

export const TOOLS = deepFreeze(
  TOOL_DEFINITIONS.filter(tool => !LEGACY_MODEL_FILE_TOOLS.has(tool.function.name)),
) as readonly ToolDefinition[];

export const TOOL_NAMES = new Set<string>(TOOLS.map(tool => tool.function.name));

const WRITE_TOOLS = new Set([
  "write_file", "edit_file", "move_file", "delete_file",
  "begin_chapter_draft", "write_chapter_scene", "write_chapter_scene_notes", "revise_chapter_scene_guide", "revise_chapter_draft_style", "inspect_chapter_draft", "propose_chapter_draft",
  "save_character", "apply_character_changes", "save_simple_character",
  "manage_prose_gates",
  "generate_image",
]);

/**
 * Stable universal capability surface. `mode` is retained for API compatibility
 * but no longer removes recovery paths after a fallible semantic classification.
 * Side effects are authorized by the runtime task contract before execution.
 */
export function agentToolsForTask(_mode: string, permissionMode: "ask" | "auto" | "plan"): readonly ToolDefinition[] {
  return Object.freeze(TOOLS.filter(tool => permissionMode !== "plan" || !WRITE_TOOLS.has(tool.function.name)));
}

/** Stable schema fingerprint: tool order and definitions are part of the provider KV-cache prefix. */
export function agentToolSchemaHash(): string {
  return createHash("sha256").update(JSON.stringify(TOOLS)).digest("hex").slice(0, 16);
}

export function agentToolNames(): string[] {
  return TOOLS.map(tool => tool.function.name);
}
