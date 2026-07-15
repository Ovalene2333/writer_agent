/**
 * Write-pre compile layer (写前编译层).
 *
 * Purpose: turn dirty planning artifacts (drafts, outline jargon, path/chapter
 * labels) into a clean "write pack" for the prose model — story-world facts only.
 *
 * In-repo ancestry:
 * - generation.ts free-form「写作前草案」(this layer sits between draft → writer)
 * - creative_outline.ts CreativeOutlineBrief (grounding + output contract pattern)
 * - style_grounding stable/dynamic split (planner vs evidence, not dump-all)
 * - show-me-the-story: outline consistency → extra_constraints → chapter prompt
 *
 * External pattern: plan-and-write / DOC / Re³ hierarchical outline → expand prose
 * (outline is for control; the expansion step should not re-ingest planner chrome).
 */

export type WritePack = {
  /** Original author-facing draft (kept for UI / revision; not injected raw). */
  sourceDraft: string;
  /** What this scene must accomplish, in story-world language. */
  sceneGoal: string;
  /** Ordered beats / event sequence. */
  beatOrder: string[];
  /** Established facts the prose must obey (diegetic phrasing). */
  knownFacts: string[];
  /** Information that must land naturally in prose. */
  mustLand: string[];
  /** Character motives / tensions at scene start. */
  characterState: string[];
  /** Short voice reminders (no template IDs or checklist chrome). */
  voiceNotes: string[];
  /** Gaps the writer must not invent. */
  doNotInvent: string[];
  /** When section parse fails, full sanitized brief lives here. */
  narrativeBrief: string;
  /** Whether structured sections were recovered from the draft. */
  structured: boolean;
  /** Meta labels stripped during compile (for debug / tests). */
  strippedMeta: string[];
};

export type CompileWritePackOptions = {
  /** Optional target path — used only to strip matching path tokens, never injected. */
  targetPath?: string;
  instruction?: string;
};

const SECTION_MAP: Array<{ keys: RegExp; field: keyof Pick<WritePack, "sceneGoal" | "beatOrder" | "knownFacts" | "mustLand" | "characterState" | "voiceNotes" | "doNotInvent"> }> = [
  { keys: /^(?:场景目标|本次场景目标|场景推进|推进目标|目标与推进|本场目标)$/u, field: "sceneGoal" },
  { keys: /^(?:关键事件|事件顺序|情节顺序|节拍|beats?|行动顺序)$/iu, field: "beatOrder" },
  { keys: /^(?:已知事实|必须保持|既有事实|资料已确认|确认事实|事实约束)$/u, field: "knownFacts" },
  { keys: /^(?:必要信息|须带出|需要自然带出|须自然落地|自然带出|信息落地|必须落地)$/u, field: "mustLand" },
  { keys: /^(?:人物|人物状态|动机|关系张力|人物当下|角色状态)$/u, field: "characterState" },
  { keys: /^(?:声线|声线约束|叙事视角|视角与声线|文风提醒)$/u, field: "voiceNotes" },
  { keys: /^(?:禁止|禁止补充|勿补写|勿擅自补写|空白|不得虚构|明确禁止)$/u, field: "doNotInvent" },
];

/** Document / planner tokens that must never appear as story-world referents. */
const META_REPLACEMENTS: Array<{ pattern: RegExp; replace: string; tag: string }> = [
  { pattern: /比序章里/gu, replace: "比先前", tag: "比序章里" },
  { pattern: /比序章中/gu, replace: "比先前", tag: "比序章中" },
  { pattern: /序章里(?:预估|所说|提到|写过)?的/gu, replace: "当时", tag: "序章里…" },
  { pattern: /序章中(?:预估|所说|提到|写过)?的/gu, replace: "当时", tag: "序章中…" },
  { pattern: /(?:在)?序章(?:结尾|开头|里|中|内)?/gu, replace: "先前", tag: "序章" },
  { pattern: /比第[一二三四五六七八九十百零〇\d]+章里/gu, replace: "比先前", tag: "比第N章里" },
  { pattern: /第[一二三四五六七八九十百零〇\d]+章里(?:预估|所说|提到|写过)?的/gu, replace: "当时", tag: "第N章里…" },
  { pattern: /(?:在)?第[一二三四五六七八九十百零〇\d]+章(?:结尾|开头|里|中|内)(?![^\n。！？]{0,8}(?:标题|编号))/gu, replace: "先前", tag: "第N章" },
  { pattern: /大纲里(?:的|写的|安排的)?/gu, replace: "", tag: "大纲里" },
  { pattern: /大纲中(?:的|写的|安排的)?/gu, replace: "", tag: "大纲中" },
  { pattern: /写作前草案|当前草案|本轮草案/gu, replace: "", tag: "草案" },
  { pattern: /资料已确认|本次合理创作决定/gu, replace: "", tag: "资料标签" },
  { pattern: /风格锚定|声线指纹|提交前自检|句式硬约束/gu, replace: "", tag: "风格元标签" },
  { pattern: /\b(?:lore|outline|chapters|side|archive)\/[^\s，。；、]*/giu, replace: "", tag: "分区路径" },
  { pattern: /`[^`\n]*(?:lore|outline|chapters|side|archive)\/[^`\n]*`/giu, replace: "", tag: "路径代码" },
  { pattern: /(?:chapters|outline|lore)\/[A-Za-z0-9_./\u4e00-\u9fff-]+\.md/gu, replace: "", tag: "md路径" },
];

/**
 * Narrower rules for finished prose: fix referential leaks without rewriting
 * legitimate chapter titles like「# 序章」or「# 第一章」.
 */
const PROSE_META_LEAKS: Array<{ pattern: RegExp; replace: string; tag: string }> = [
  { pattern: /比序章里/gu, replace: "比先前", tag: "比序章里" },
  { pattern: /比序章中/gu, replace: "比先前", tag: "比序章中" },
  { pattern: /序章里(?:预估|所说|提到|写过)?的/gu, replace: "当时", tag: "序章里…" },
  { pattern: /序章中(?:预估|所说|提到|写过)?的/gu, replace: "当时", tag: "序章中…" },
  { pattern: /(?:在)?序章(?:结尾|开头)(?:处|时)?/gu, replace: "先前", tag: "序章边界" },
  { pattern: /比第[一二三四五六七八九十百零〇\d]+章里/gu, replace: "比先前", tag: "比第N章里" },
  { pattern: /第[一二三四五六七八九十百零〇\d]+章里(?:预估|所说|提到|写过)?的/gu, replace: "当时", tag: "第N章里…" },
  { pattern: /大纲里(?:的|写的|安排的)?/gu, replace: "", tag: "大纲里" },
  { pattern: /大纲中(?:的|写的|安排的)?/gu, replace: "", tag: "大纲中" },
  { pattern: /写作前草案|当前草案|本轮草案|资料已确认|本次合理创作决定/gu, replace: "", tag: "流程标签" },
  { pattern: /风格锚定|声线指纹|提交前自检/gu, replace: "", tag: "风格元标签" },
  { pattern: /(?:chapters|outline|lore|side|archive)\/[A-Za-z0-9_./\u4e00-\u9fff-]+\.md/gu, replace: "", tag: "md路径" },
  { pattern: /\b(?:lore|outline|chapters|side|archive)\/[^\s，。；、`*]*/giu, replace: "", tag: "分区路径" },
];

/**
 * Character-card / RPG inventory diction — do not auto-rewrite (needs human rewrite);
 * used by findProseMetaLeaks to block proposals.
 */
const PROSE_CARD_LEAK_CHECKS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /档案上[的]?[^。！？\n]{0,32}(?:还锁着|锁着|锁定|未解锁)/u, tag: "档案锁定腔" },
  { pattern: /(?:专属武装|武装组件|能力|技能|武装)[^。！？\n]{0,16}(?:还锁着|未解锁|锁定中)/u, tag: "卡面解锁腔" },
  { pattern: /未解锁/u, tag: "未解锁" },
  { pattern: /不是[「『"「][^」』"」\n]{1,24}[」』"」][，,、]?\s*不是[「『"「][^」』"」\n]{1,24}[」』"」][———–-]{1,2}/u, tag: "双否定点名破折号" },
];

/**
 * Strip planner / document meta so prose models only see story-world language.
 * Deterministic; no model call. Aggressive — for drafts/notes, not finished chapter titles.
 */
export function sanitizeDiegeticText(text: string, options?: { targetPath?: string }): { text: string; stripped: string[] } {
  return applyMetaRules(text, META_REPLACEMENTS, options?.targetPath);
}

/**
 * Sanitize finished chapter prose for meta-reference leaks only.
 * Preserves markdown titles like「# 序章」.
 */
export function sanitizeProseMetaLeaks(text: string, options?: { targetPath?: string }): { text: string; stripped: string[] } {
  return applyMetaRules(text, PROSE_META_LEAKS, options?.targetPath);
}

/** Residual high-confidence leaks that should block a proposal even after sanitize. */
export function findProseMetaLeaks(text: string): string[] {
  const hits: string[] = [];
  const checks: Array<{ pattern: RegExp; tag: string }> = [
    { pattern: /比序章|序章里|序章中/u, tag: "序章指称" },
    { pattern: /比第[一二三四五六七八九十百零〇\d]+章里|第[一二三四五六七八九十百零〇\d]+章里/u, tag: "章节指称" },
    { pattern: /大纲里|大纲中/u, tag: "大纲指称" },
    { pattern: /写作前草案|资料已确认/u, tag: "流程标签" },
    { pattern: /(?:chapters|outline|lore|side|archive)\//iu, tag: "分区路径" },
    ...PROSE_CARD_LEAK_CHECKS,
  ];
  for (const check of checks) {
    if (check.pattern.test(text)) hits.push(check.tag);
    check.pattern.lastIndex = 0;
  }
  return hits;
}

function applyMetaRules(
  text: string,
  rules: Array<{ pattern: RegExp; replace: string; tag: string }>,
  targetPath?: string,
): { text: string; stripped: string[] } {
  let out = text;
  const stripped: string[] = [];
  if (targetPath?.trim()) {
    const path = targetPath.trim();
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "gu");
    if (re.test(out)) {
      stripped.push(path);
      out = out.replace(re, "");
    }
  }
  for (const rule of rules) {
    if (rule.pattern.test(out)) {
      stripped.push(rule.tag);
      out = out.replace(rule.pattern, rule.replace);
    }
    rule.pattern.lastIndex = 0;
  }
  out = out
    .replace(/[（(]\s*[）)]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[，,]{2,}/gu, "，");
  // Do not trim full documents — preserve leading heading newlines for patches.
  return { text: out, stripped: [...new Set(stripped)] };
}

/**
 * Compile an author-facing draft into a write pack for the prose model.
 * Prefer structured sections when present; always sanitize meta labels.
 */
export function compileWritePack(draft: string, options: CompileWritePackOptions = {}): WritePack {
  const sourceDraft = draft.trim();
  if (!sourceDraft) {
    return emptyPack("", options.instruction);
  }

  const sections = parseDraftSections(sourceDraft);
  const strippedMeta: string[] = [];
  const sanitize = (value: string) => {
    const result = sanitizeDiegeticText(value, { targetPath: options.targetPath });
    strippedMeta.push(...result.stripped);
    return result.text;
  };
  const sanitizeList = (values: string[]) => values.map(sanitize).map(item => item.trim()).filter(Boolean);

  const take = (field: Parameters<typeof collectField>[1]) => collectField(sections, field);
  const sceneGoal = sanitize(take("sceneGoal").join("\n"));
  const beatOrder = sanitizeList(splitList(take("beatOrder").join("\n")));
  const knownFacts = sanitizeList(splitList(take("knownFacts").join("\n")));
  const mustLand = sanitizeList(splitList(take("mustLand").join("\n")));
  const characterState = sanitizeList(splitList(take("characterState").join("\n")));
  const voiceNotes = sanitizeList(splitList(take("voiceNotes").join("\n")));
  const doNotInvent = sanitizeList(splitList(take("doNotInvent").join("\n")));
  const structured = Boolean(
    sceneGoal || beatOrder.length || knownFacts.length || mustLand.length
    || characterState.length || voiceNotes.length || doNotInvent.length,
  );

  // Unmapped sections / preamble become narrative brief.
  // If no known sections, treat the whole draft as the brief.
  const otherBodies = structured
    ? [...sections.entries()]
      .filter(([key, entry]) => entry.field === "other" || key === "_preamble")
      .map(([, entry]) => entry.body)
    : [sourceDraft];
  const narrativeBrief = sanitize(otherBodies.filter(Boolean).join("\n\n"));

  return {
    sourceDraft,
    sceneGoal,
    beatOrder,
    knownFacts,
    mustLand,
    characterState,
    voiceNotes,
    doNotInvent,
    narrativeBrief,
    structured,
    strippedMeta: [...new Set(strippedMeta)],
  };
}

/**
 * Format a write pack for the prose model. No draft chrome, no paths, no "序章".
 */
export function formatWritePackForWriter(pack: WritePack): string {
  const lines: string[] = [
    "本场写作材料（仅故事世界内信息。禁止在正文用文档标题、路径、大纲或流程字样指称先前情节；改用故事内时间、对白或物件回忆。）",
  ];

  if (pack.sceneGoal) lines.push(`【本场要完成】\n${pack.sceneGoal}`);
  if (pack.characterState.length) lines.push(`【人物当下】\n${bullets(pack.characterState)}`);
  if (pack.beatOrder.length) lines.push(`【事件顺序】\n${numbered(pack.beatOrder)}`);
  if (pack.knownFacts.length) lines.push(`【已成立的事实】\n${bullets(pack.knownFacts)}`);
  if (pack.mustLand.length) lines.push(`【须自然落地】\n${bullets(pack.mustLand)}`);
  if (pack.doNotInvent.length) lines.push(`【勿擅自补写】\n${bullets(pack.doNotInvent)}`);
  if (pack.voiceNotes.length) lines.push(`【声线提醒】\n${bullets(pack.voiceNotes)}`);
  if (pack.narrativeBrief && (!pack.structured || pack.narrativeBrief.length > 40)) {
    lines.push(`【情节提要】\n${pack.narrativeBrief}`);
  }

  if (lines.length === 1) {
    lines.push("（可写材料为空；仅依据文档上下文与写作要求创作。）");
  }
  return lines.join("\n\n");
}

/** Draft-model output contract: sections the compile layer knows how to parse. */
export function writePackDraftContractPrompt(): string {
  return `最终输出「写作草案」（供作者审阅，确认后再编译给正文模型）。使用以下小标题（缺段可省略，不要写小说正文）：
## 场景目标
## 人物当下
## 事件顺序
## 已知事实
## 须自然落地
## 勿擅自补写
## 声线提醒

约束：
- 全部用故事世界内说法写事实与回忆；禁止出现「序章/第N章/大纲/草案/lore/outline/chapters」等文档或流程标签。
- 指称先前情节时写清故事内锚点（如「门缝里那句预估」「入院当晚」），不要写「比序章里…」。
- 「已知事实」只列已核实内容；不确定标「待定」并放入「勿擅自补写」。
- 「声线提醒」只写句长/对白密度/视角等可执行点，不写风格模板 ID 或自检口号。
- 区分确定事实与本次创作决定时，用正文可读的措辞，不要写「资料已确认」等内部标签。`;
}

function emptyPack(sourceDraft: string, instruction?: string): WritePack {
  const brief = instruction?.trim() ? sanitizeDiegeticText(instruction).text : "";
  return {
    sourceDraft,
    sceneGoal: "",
    beatOrder: [],
    knownFacts: [],
    mustLand: [],
    characterState: [],
    voiceNotes: [],
    doNotInvent: [],
    narrativeBrief: brief,
    structured: false,
    strippedMeta: [],
  };
}

function parseDraftSections(draft: string): Map<string, { field: string; body: string }> {
  const lines = draft.replace(/\r\n/g, "\n").split("\n");
  const map = new Map<string, { field: string; body: string }>();
  let currentKey = "_preamble";
  let currentField = "other";
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (!body && currentKey === "_preamble") {
      buffer = [];
      return;
    }
    if (body) map.set(currentKey, { field: currentField, body });
    buffer = [];
  };

  for (const line of lines) {
    const heading = matchHeading(line);
    if (heading) {
      flush();
      currentKey = heading.raw;
      currentField = heading.field;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return map;
}

function matchHeading(line: string): { raw: string; field: string } | undefined {
  const trimmed = line.trim();
  // ## 标题 / **标题** / 标题：
  const md = trimmed.match(/^#{1,3}\s+(.+?)\s*$/u);
  const bold = trimmed.match(/^\*\*(.+?)\*\*\s*[:：]?\s*$/u);
  const plain = trimmed.match(/^([^\n]{1,24})[:：]\s*$/u);
  const raw = (md?.[1] ?? bold?.[1] ?? plain?.[1] ?? "").trim().replace(/[：:]\s*$/u, "");
  if (!raw) return undefined;
  // Avoid treating long prose lines as headings.
  if (!md && !bold && plain && /[。！？；]/.test(raw)) return undefined;
  for (const entry of SECTION_MAP) {
    if (entry.keys.test(raw)) return { raw, field: entry.field };
  }
  if (md || bold) return { raw, field: "other" };
  return undefined;
}

function collectField(
  sections: Map<string, { field: string; body: string }>,
  field: string,
): string[] {
  return [...sections.values()].filter(entry => entry.field === field).map(entry => entry.body);
}

function splitList(text: string): string[] {
  if (!text.trim()) return [];
  return text
    .split(/\n+/)
    .map(line => line.replace(/^\s*(?:[-*]|\d+[.)、]|[（(]?\d+[）)])\s*/u, "").trim())
    .filter(Boolean);
}

function bullets(items: string[]): string {
  return items.map(item => `- ${item}`).join("\n");
}

function numbered(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}
