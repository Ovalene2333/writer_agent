/** Model-agnostic divergent/convergent planner for readable story outlines. */
export interface CreativeOutlineInput {
  premise: string; genre?: string; audience?: string; targetChapters?: number;
  constraints?: string[]; existingBeats?: string[]; seed?: string;
}
export interface CreativeRoute { id: string; name: string; structuralLens: string; pressureLens: string; revealLens: string; }
export interface CreativeOutlineBrief {
  premise: string; targetChapters: number; routes: CreativeRoute[]; workflow: string[];
  scorecard: Array<{ dimension: string; weight: number; question: string }>;
  antiPatterns: string[]; outputContract: string; generationPrompt: string;
}
const STRUCTURES = [
  ["错误胜利", "前段让主角如愿，但成功本身制造更难撤销的后果；中点揭示胜利的真实价格。"],
  ["双重因果链", "外部事件链与关系链交替推进，并在高潮处证明两条链由同一个选择触发。"],
  ["倒计时回声", "从不可逆后果附近切入，让后续节点逐步改变读者对起因的理解。"],
  ["目标蜕变", "显性目标保持具体，但每次受阻都迫使主角重新定义真正想保住什么。"],
  ["不对称群像", "人物掌握互不重合的信息与筹码；同一事件对至少两人产生反向变化。"],
  ["承诺—兑现", "开篇建立具体叙事承诺，中段意外升级，结尾兑现主题而非机械兑现猜测。"],
] as const;
const PRESSURES = [
  ["资源递减", "每次解题都消耗之后更需要的资源，障碍不可无成本重置。"],
  ["道德两难", "关键选择保护一项价值并伤害另一项同样真实的价值。"],
  ["关系债务", "帮助、隐瞒与背叛形成债务；回收发生在最不方便偿还的时候。"],
  ["身份暴露", "行动越有效，主角越难维持公开身份、秘密身份或自我叙述。"],
  ["制度反作用", "阻力来自自洽规则；个体越按常规求解，规则越放大代价。"],
  ["时间错位", "人物对截止时刻或事件顺序的理解不同，误差必须产生行动后果。"],
] as const;
const REVEALS = [
  ["意义翻转", "新信息不否定旧事实，而是改变旧事实的意义与人物责任。"],
  ["主动共谋", "被视为受害者或旁观者的人曾主动促成局面，但动机仍可理解。"],
  ["答案先于问题", "前段放置自然的异常，后段读者才知道它回答了什么问题。"],
  ["代价转移", "看似免费的方案把代价转移给未被注意的人、地点或未来。"],
  ["目标同源", "对手与主角目标源于同一种恐惧或承诺，差异落在手段和边界。"],
  ["缺席的行动", "关键转折来自某人没有做什么；缺席必须提前具备可观察的期待。"],
] as const;
const SCORECARD = [
  { dimension: "因果推进", weight: 24, question: "去掉任一关键节点，后续是否会实质改变？" },
  { dimension: "人物压力", weight: 20, question: "进展是否迫使人物暴露价值排序并留下不可逆代价？" },
  { dimension: "新颖与惊奇", weight: 18, question: "转折是否超出题材默认答案，同时回看时有铺垫？" },
  { dimension: "张力曲线", weight: 16, question: "压力、希望、信息与亲密度是否有变化？" },
  { dimension: "可读性", weight: 12, question: "每章能否用前因—行动—结果—状态变化简述，且摘要点明目标与阻力？" },
  { dimension: "主题回响", weight: 10, question: "结局是否用人物代价回答核心价值冲突？" },
];
const ANTI_PATTERNS = [
  "候选只替换职业、地点或反派身份，事件骨架仍相同",
  "用失忆、梦境、天选血统或突然证据替代已铺垫的因果",
  "连续三章只有调查、解释或准备，没有选择造成的状态变化",
  "转折仅对读者保密，却不改变人物接下来的行动",
  "冲突强度单调上升，缺少喘息、假胜利、亲密或信息落差",
  "摘要充满抽象评价词，却说不清谁想做什么、受谁阻止、失去什么",
  "使用目标/阻力/关键选择/POV/张力等未登记字段名，导致结构化大纲无法解析",
];
/** Fields OutlineStore.parseOutline recognizes (list lines: "字段：值"). */
export const OUTLINE_CHAPTER_FIELDS = [
  "摘要", "前因", "行动", "结果", "状态变化", "角色ID", "地点", "时间", "情节线", "伏笔", "回收", "状态", "文档", "正文章节",
] as const;
export function createCreativeOutlineBrief(input: CreativeOutlineInput): CreativeOutlineBrief {
  const premise = input.premise.trim();
  if (!premise) throw new Error("premise 不能为空");
  const targetChapters = clamp(input.targetChapters ?? 12, 3, 80);
  const seed = `${input.seed ?? ""}|${premise}|${input.genre ?? ""}`;
  const structures = pick(STRUCTURES, `${seed}:s`), pressures = pick(PRESSURES, `${seed}:p`), reveals = pick(REVEALS, `${seed}:r`);
  const routes = structures.map(([sn, structuralLens], i): CreativeRoute => {
    const [pn, pressureLens] = pressures[i], [rn, revealLens] = reveals[i];
    return { id: String.fromCharCode(65 + i), name: `${sn} × ${pn} × ${rn}`, structuralLens, pressureLens, revealLens };
  });
  const workflow = [
    "分别完成四条路线；路线至少在欲望、因果机制或结局代价之一根本不同。",
    "从各路线提取不可替代的优点，组合两个混合候选。",
    "按评分表逐项给证据和分数；没有证据不得超过该项权重一半。",
    "以读者、动机审计者、题材编辑三种视角各反驳一次并修订。",
    "先写阶段级因果链再拆章节；章节必须以前章结果为条件。",
    "删除可互换、无状态变化或只解释设定的章节。",
    "落盘章节只用结构化大纲字段名（摘要/前因/行动/结果/状态变化等），勿自造字段。",
  ];
  const fieldList = OUTLINE_CHAPTER_FIELDS.join("、");
  const outputContract = `最终展示选定方案及淘汰证据、3—5阶段因果链、约 ${targetChapters} 章的大纲、因果审计和评分。落盘或提案时每章用 Markdown 标题（如「第N章 标题」）+ 列表行「字段：值」，字段名必须可被结构化大纲解析，仅允许：${fieldList}。语义映射：摘要=一句话含目标、阻力与主冲突；前因=承接上章结果并说明目标此刻为何成立；行动=阻力下的关键选择与执行（含 POV 视角信息时可写在行动或摘要）；结果与状态变化必填；伏笔/回收分写；状态用 idea 或 planned。信息释放与张力(1—5)写入摘要或行动句内，禁止使用「目标」「阻力」「关键选择」「POV」「张力」等未登记字段名。单章列表合计约 80—160 字，不写正文式渲染。`;
  const base = { premise, targetChapters, routes, workflow, scorecard: SCORECARD, antiPatterns: ANTI_PATTERNS, outputContract };
  return { ...base, generationPrompt: renderPrompt(input, base) };
}
function renderPrompt(input: CreativeOutlineInput, brief: Omit<CreativeOutlineBrief, "generationPrompt">): string {
  const context = [`故事前提：${brief.premise}`, input.genre && `类型：${input.genre}`, input.audience && `读者：${input.audience}`,
    input.constraints?.length && `硬约束：${input.constraints.join("；")}`, input.existingBeats?.length && `既有节拍：${input.existingBeats.join("；")}`].filter(Boolean).join("\n");
  const routes = brief.routes.map(r => `路线${r.id}【${r.name}】结构：${r.structuralLens} 压力：${r.pressureLens} 揭示：${r.revealLens}`).join("\n");
  const score = brief.scorecard.map(s => `${s.dimension}${s.weight}分：${s.question}`).join("\n");
  return `你是故事架构师。通过发散、比较和修订得到新颖且可读的大纲。\n${context}\n\n${routes}\n\n依次执行：\n${brief.workflow.join("\n")}\n\n评分：\n${score}\n\n规避：\n${brief.antiPatterns.join("\n")}\n\n${brief.outputContract}`;
}
function pick<T>(items: readonly T[], seed: string): T[] {
  return items.map((item, i) => ({ item, n: hash(`${seed}:${i}`) })).sort((a, b) => a.n - b.n).slice(0, 4).map(x => x.item);
}
function hash(value: string): number {
  let n = 2166136261; for (let i = 0; i < value.length; i += 1) { n ^= value.charCodeAt(i); n = Math.imul(n, 16777619); } return n >>> 0;
}
function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : min;
}
