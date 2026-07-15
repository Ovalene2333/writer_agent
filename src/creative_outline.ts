/** Model-agnostic brief for grounded, progressively disclosed story outlines. */
export interface CreativeOutlineInput {
  premise: string; genre?: string; audience?: string; targetChapters?: number;
  constraints?: string[]; existingBeats?: string[]; seed?: string;
}

export interface CreativeOutlineBrief {
  premise: string;
  targetChapters?: number;
  sourceInputs: string[];
  groundingRules: string[];
  workflow: string[];
  qualityChecks: string[];
  antiPatterns: string[];
  outputContract: string;
  generationPrompt: string;
}

/** Fields OutlineStore.parseOutline recognizes (list lines: "字段：值"). */
export const OUTLINE_CHAPTER_FIELDS = [
  "摘要", "前因", "行动", "结果", "状态变化", "角色ID", "地点", "时间", "情节线", "伏笔", "回收", "状态", "文档", "正文章节",
] as const;

const GROUNDING_RULES = [
  "只把用户输入、已读取的项目内容和既有节拍当作确定事实；不要补写未提供的人名、身世、规则、动机或历史。",
  "创作出来的事件是候选方案，不反向证明项目中存在相应设定；连接事实所需的信息若无依据，明确写成“待定”。",
  "每个节点只引入推动当前因果链所必需的新信息；能用现有事实完成时，不新增组织、道具、能力或幕后关系。",
  "遇到会显著改变故事方向的缺口，最多列出 3 个待定决策，不擅自用复杂设定填满。",
];

const QUALITY_CHECKS = [
  "相邻节点是否存在明确的前因与结果，而不是仅按时间并列。",
  "每章是否至少改变局势、关系、信息或人物选择中的一项。",
  "删除任一新增设定后情节是否仍成立；若成立，就删除该设定。",
  "摘要是否能让作者快速看懂谁采取了什么行动、造成什么结果。",
];

const ANTI_PATTERNS = [
  "为了制造转折，临时加入失忆、梦境、天选血统、突然证据或未铺垫的幕后人物",
  "把模型推测写成项目事实，或替角色断言未被材料支持的秘密动机",
  "连续节点只有调查、解释或准备，没有行动造成的状态变化",
  "同一信息在摘要、前因、行动和结果中换句话重复",
  "每章机械填满地点、时间、伏笔、回收等可选字段",
  "展示候选路线、评分表、反驳过程或长篇创作分析，挤占大纲正文",
  "使用目标/阻力/关键选择/POV/张力等未登记字段名，导致结构化大纲无法解析",
];

export function createCreativeOutlineBrief(input: CreativeOutlineInput): CreativeOutlineBrief {
  const premise = input.premise.trim();
  if (!premise) throw new Error("premise 不能为空");
  const targetChapters = input.targetChapters === undefined ? undefined : clamp(input.targetChapters, 3, 80);
  const constraints = cleanList(input.constraints);
  const existingBeats = cleanList(input.existingBeats);
  const sourceInputs = [
    `故事前提：${premise}`,
    ...constraints.map(item => `硬约束：${item}`),
    ...existingBeats.map(item => `既有节拍：${item}`),
  ];
  const workflow = [
    "先整理不超过 6 条确定依据与不超过 3 条待定决策；不得把待定项悄悄补成事实。",
    "先用一句话确定主因果线，再拆成 3—5 个阶段；阶段成立后才拆章节。",
    "章节只保留前因、行动、结果和状态变化；摘要负责快速定位，其他字段确有信息时再写。",
    "内部执行依据核对与删减，只输出最终大纲；若关键缺口使方案无法成立，才在开头简短列为待定。",
  ];
  const fieldList = OUTLINE_CHAPTER_FIELDS.join("、");
  const chapterScope = targetChapters === undefined
    ? "用户没有指定总章数：不要猜测全书规模，不要生成完整章节表。只写一句话主线、3 个阶段方向，并给出最多 3 个近期章节卡作为可随写作调整的引导。"
    : `用户明确要求约 ${targetChapters} 章：可按该范围给出章节卡。`;
  const outputContract = `输出轻量、可调整的情节引导，不展示候选路线、评分、淘汰证据或审计过程。${chapterScope} 存在关键缺口时加“待定”列表（最多 3 条），没有则省略。章节卡使用 Markdown 标题（如「第N章 标题」），默认只写“摘要、前因、行动、结果、状态变化”五行，每行一句，合计约 50—100 字；角色ID、地点、时间、情节线、伏笔、回收、状态、文档、正文章节仅在已有依据或确有管理价值时添加，不得机械填满。字段仅允许：${fieldList}。摘要写核心冲突；前因承接上一节点；行动写关键选择与执行；结果写直接后果；状态变化只写本章后真正改变的局势、关系、信息或立场。大纲只提供方向，具体节奏与转折由写作时的场景链决定；新增内容均视为待作者确认的方案，不冒充项目既有事实。`;
  const base = {
    premise,
    ...(targetChapters === undefined ? {} : { targetChapters }),
    sourceInputs,
    groundingRules: GROUNDING_RULES,
    workflow,
    qualityChecks: QUALITY_CHECKS,
    antiPatterns: ANTI_PATTERNS,
    outputContract,
  };
  return { ...base, generationPrompt: renderPrompt(input, base) };
}

function renderPrompt(input: CreativeOutlineInput, brief: Omit<CreativeOutlineBrief, "generationPrompt">): string {
  const context = [
    ...brief.sourceInputs,
    input.genre?.trim() && `类型气质：${input.genre.trim()}`,
    input.audience?.trim() && `目标读者：${input.audience.trim()}`,
  ].filter((item): item is string => Boolean(item)).join("\n");
  return `你是故事架构师。任务是产出可靠、轻量、作者一眼能读懂的大纲。\n\n本轮来源输入（仍须区分用户事实、项目事实与创作候选）：\n${context}\n\n事实边界：\n${brief.groundingRules.map(item => `- ${item}`).join("\n")}\n\n内部步骤：\n${brief.workflow.map(item => `- ${item}`).join("\n")}\n\n提交前只在内部核对：\n${brief.qualityChecks.map(item => `- ${item}`).join("\n")}\n\n规避：\n${brief.antiPatterns.map(item => `- ${item}`).join("\n")}\n\n${brief.outputContract}`;
}

function cleanList(value: string[] | undefined): string[] {
  return (value ?? []).map(item => item.trim()).filter(Boolean).slice(0, 20);
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : min;
}
