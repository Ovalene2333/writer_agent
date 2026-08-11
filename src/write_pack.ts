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
  /**
   * Optional viewpoint character for this scene. Absent in legacy packs.
   * Present = narration may not exceed what this character can perceive.
   */
  viewpoint?: string;
  /**
   * Optional per-character epistemic gate (knows / does not know / is concealing).
   * The scene-level, lower-frequency form of the roleplay perception compiler:
   * information asymmetry is what makes an exchange a negotiation rather than a
   * mutual confirmation, which is exactly what compliantActRatio measures.
   */
  knowledgeGates?: KnowledgeGate[];
  /**
   * Optional structured beats parsed out of beatOrder rows. Beat count — not a
   * character count — is the length knob: each beat is one intent, one attempt,
   * one obstacle or mismatched reply.
   */
  beats?: SceneBeat[];
  /** Established facts the prose must obey (diegetic phrasing). */
  knownFacts: string[];
  /** Information that must land naturally in prose. */
  mustLand: string[];
  /** Character motives / tensions at scene start. */
  characterState: string[];
  /** Narration-only reminders; individual dialogue voices stay on character cards. */
  narrationNotes: string[];
  /** Gaps the writer must not invent. */
  doNotInvent: string[];
  /** When section parse fails, full sanitized brief lives here. */
  narrativeBrief: string;
  /** Whether structured sections were recovered from the draft. */
  structured: boolean;
  /** Meta labels stripped during compile (for debug / tests). */
  strippedMeta: string[];
  /** Optional normalized facts; absent in legacy callers and old persisted packs. */
  factAtoms?: FactAtom[];
  /** Optional viewpoint/register guidance; never a forced synonym replacement. */
  realizationBoundaries?: RealizationBoundary[];
  /**
   * Optional card-derived phrasing that must not be quoted into dialogue/narration.
   * Populated at compile/runtime from read characters; never a synonym table.
   */
  registerRisks?: Array<{
    term: string;
    characterName: string;
    source: string;
    scope: string;
    reason: string;
  }>;
};

export type SceneBeat = {
  /** What a character wants to get done right now. */
  intent: string;
  /** The one thing they actually do about it in this beat. */
  attempt: string;
  /** What blocks it, or the reply that lands somewhere other than the intent. */
  obstacle: string;
};

export type KnowledgeGate = {
  character: string;
  /** Established for this character at scene entry. */
  knows: string[];
  /** Not available to them — may not be spoken, thought or narrated close to them. */
  unknown: string[];
  /** Known but withheld; may only surface as evasion, deflection or a partial answer. */
  concealing: string[];
};

export type FactPrecision = "exact" | "normal" | "sensory";

export type FactAtom = {
  id: string;
  claim: string;
  purpose?: string;
  precision: FactPrecision;
};

export type RealizationBoundary = {
  factId: string;
  claim: string;
  purpose?: string;
  precision?: FactPrecision;
  narration?: string;
  dialogue?: string;
  technicalDialogue?: string;
  avoid?: string;
};

export type CompileWritePackOptions = {
  /** Optional target path — used only to strip matching path tokens, never injected. */
  targetPath?: string;
  instruction?: string;
};

type WritePackSectionField = keyof Pick<WritePack, "sceneGoal" | "beatOrder" | "knownFacts" | "mustLand" | "characterState" | "narrationNotes" | "doNotInvent"> | "realizationBoundaries" | "viewpoint" | "knowledgeGates" | "discard";

const SECTION_MAP: Array<{ keys: RegExp; field: WritePackSectionField }> = [
  { keys: /^(?:场景目标|本次场景目标|场景推进|推进目标|目标与推进|本场目标)$/u, field: "sceneGoal" },
  { keys: /^(?:关键事件|事件顺序|情节顺序|节拍|beats?|行动顺序)$/iu, field: "beatOrder" },
  { keys: /^(?:已知事实|必须保持|既有事实|资料已确认|确认事实|事实约束)$/u, field: "knownFacts" },
  { keys: /^(?:必要信息|须带出|需要自然带出|须自然落地|自然带出|信息落地|必须落地)$/u, field: "mustLand" },
  { keys: /^(?:人物|人物状态|动机|关系张力|人物当下|角色状态)$/u, field: "characterState" },
  { keys: /^(?:本场视角|视角人物|视角归属|限知视角)$/u, field: "viewpoint" },
  { keys: /^(?:认知边界|知情边界|信息边界|人物认知|知道与不知道)$/u, field: "knowledgeGates" },
  { keys: /^(?:叙述提醒|叙事视角|视角与叙述|文风提醒)$/u, field: "narrationNotes" },
  { keys: /^(?:表达边界|事实表达|术语表达|语域实现|表达策略)$/u, field: "realizationBoundaries" },
  // An unqualified 声线 section is normally a character card fragment. Discard it
  // rather than letting it contaminate narration or every speaker via the pack.
  { keys: /^(?:声线|声线约束|视角与声线)$/u, field: "discard" },
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
  const narrationNotes = sanitizeList(splitList(take("narrationNotes").join("\n")));
  const doNotInvent = sanitizeList(splitList(take("doNotInvent").join("\n")));
  const viewpoint = sanitize(take("viewpoint").join("\n")).trim();
  const knowledgeGates = parseKnowledgeGates(
    sanitizeList(splitList(take("knowledgeGates").join("\n"))),
  );
  const beats = parseSceneBeats(beatOrder);
  const factAtoms = knownFacts.slice(0, 12).map((claim, index) => ({
    id: `fact-${index + 1}`,
    claim,
    precision: "normal" as const,
  }));
  const realizationBoundaries = parseRealizationBoundaries(
    take("realizationBoundaries").flatMap(body => splitList(body)),
    factAtoms,
    sanitize,
  );
  const compiledFactAtoms = factAtoms.map(fact => {
    const boundary = realizationBoundaries.find(item => item.factId === fact.id);
    return {
      ...fact,
      ...(boundary?.purpose ? { purpose: boundary.purpose } : {}),
      ...(boundary?.precision ? { precision: boundary.precision } : {}),
    };
  });
  const structured = Boolean(
    sceneGoal || beatOrder.length || knownFacts.length || mustLand.length
    || characterState.length || narrationNotes.length || doNotInvent.length
    // Raw section presence, not the parsed result: a section whose rows all fail
    // to parse must still count as structured, or the whole draft falls back to
    // narrativeBrief and leaks its own heading into the writer prompt.
    || take("viewpoint").length || take("knowledgeGates").length
    || take("realizationBoundaries").length
    || [...sections.values()].some(entry => entry.field === "discard"),
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
    ...(viewpoint ? { viewpoint } : {}),
    ...(knowledgeGates.length ? { knowledgeGates } : {}),
    ...(beats.length ? { beats } : {}),
    knownFacts,
    mustLand,
    characterState,
    narrationNotes,
    doNotInvent,
    narrativeBrief,
    structured,
    strippedMeta: [...new Set(strippedMeta)],
    factAtoms: compiledFactAtoms,
    realizationBoundaries,
  };
}

/**
 * Format a write pack for the prose model. No draft chrome, no paths, no "序章".
 */
export function formatWritePackForWriter(pack: WritePack): string {
  const lines: string[] = [
    "本场写作材料（这是事实边界与创作简报，不是逐项展开的作文提纲。硬约束是【已成立的事实】【须自然落地】【勿擅自补写】【本场视角】【认知边界】；其余栏目用于找准人物行动和场景方向，可合并承载，不必逐条复述或各占一段。正文只用故事世界内的时间、动作、对白或物件指称先前情节。）",
  ];

  if (pack.viewpoint) {
    lines.push(
      `【本场视角】\n${pack.viewpoint}\n（硬约束：叙述只写该人物此刻能看到、听到、感觉到和据此判断到的内容。其他人物的想法、动机和未说出口的盘算只能通过对方的动作、语气、停顿和说了什么来呈现，不得由叙述直接说明。）`,
    );
  }
  if (pack.knowledgeGates?.length) {
    lines.push(
      `【认知边界】\n${pack.knowledgeGates.map(formatKnowledgeGate).join("\n")}\n`
      + "（硬约束：「不知道」的内容，该人物不得说出、想到，贴着他的叙述也不得点破；他只能猜错、问偏或绕开。"
      + "「在隐瞒」的内容只能以回避、转移话题、给出不完整答案或答非所问呈现，不得由叙述交代他为什么隐瞒。"
      + "本场的谈话压力就来自这些差额——不要让双方在同一信息水平上互相确认。）",
    );
  }
  if (pack.sceneGoal) lines.push(`【本场方向】\n${pack.sceneGoal}`);
  if (pack.characterState.length) lines.push(`【人物当下】\n${bullets(pack.characterState)}`);
  if (pack.beats?.length) {
    lines.push(
      `【本场节拍】共 ${pack.beats.length} 拍。每拍写成：某个人物此刻想达成的事 → 他为此做出的一次尝试 → 一次阻碍或落在别处的回应。\n`
      + pack.beats.map((beat, index) =>
        `${index + 1}. 意图：${beat.intent}／尝试：${beat.attempt}／阻碍：${beat.obstacle}`).join("\n")
      + "\n（拍数是篇幅旋钮，不是字数。不要把两拍并成一句带过，也不要把一拍拆成多轮重复确认；每一拍都要让局面、理解或关系出现可见的变化，再进入下一拍。这些字段是本拍要发生的事，不是要写进正文的说法。）",
    );
  } else if (pack.beatOrder.length) {
    lines.push(`【推进顺序】\n${numbered(pack.beatOrder)}\n（保持因果先后，但可写成连续动作，不为每项补解释或独立段落。）`);
  }
  if (pack.knownFacts.length) lines.push(`【已成立的事实】\n${bullets(pack.knownFacts)}`);
  if (pack.mustLand.length) lines.push(`【须自然落地】\n${bullets(pack.mustLand)}`);
  if (pack.doNotInvent.length) lines.push(`【勿擅自补写】\n${bullets(pack.doNotInvent)}`);
  if (pack.narrationNotes.length) lines.push(`【叙述提醒】\n${bullets(pack.narrationNotes)}`);
  if (pack.narrativeBrief && (!pack.structured || pack.narrativeBrief.length > 40)) {
    lines.push(`【情节提要】\n${pack.narrativeBrief}`);
  }
  if (pack.realizationBoundaries?.length) {
    lines.push(
      `【事实表达边界】\n${pack.realizationBoundaries.map(formatRealizationBoundary).join("\n")}\n（以上是语域和信息精度提示，不是固定替换表；以当前视角、人物知识和行动需要决定最终说法。）`,
    );
  }
  if (pack.registerRisks?.length) {
    lines.push(
      `【慎用措辞·不得直出】\n下列词句来自本轮角色知识线索，不是正文默认词表；普通对白与贴身叙述须换成本场自然说法，正式汇报或对方追问术语时除外。\n${
        pack.registerRisks.slice(0, 24).map(risk =>
          `- ${risk.term}（${risk.characterName}/${risk.source}/${risk.scope}）：${risk.reason}`
        ).join("\n")
      }`,
    );
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
## 本场视角
## 认知边界
## 人物当下
## 事件顺序
## 已知事实
## 须自然落地
## 勿擅自补写
## 叙述提醒
## 表达边界

约束：
- 全部用故事世界内说法写事实与回忆；禁止出现「序章/第N章/大纲/草案/lore/outline/chapters」等文档或流程标签。
- 指称先前情节时写清故事内锚点（如「门缝里那句预估」「入院当晚」），不要写「比序章里…」。
- 「本场视角」写一名视角人物，一句话说明叙述贴他多近。本场叙述不得越过他的感知；他没看到、没听到的事不能进叙述。
- 「认知边界」为本场视角人物和他的主要对手方各写一行：角色 | 知道=… | 不知道=… | 在隐瞒=…（同栏多项用「；」分隔，确无内容留空）。只写本场会被触碰到的信息，这三栏决定了这场戏还有什么可谈；双方都知道的事不构成场景。
- 「事件顺序」按节拍写，每场 3—5 拍，每行使用：意图=… | 尝试=… | 阻碍=…。意图是某个人物此刻想达成的事，尝试是他为此做的一次行动或一句话，阻碍是挡住它的东西或落在别处的回应。一拍只放一个意图，不要把整场压成一拍，也不要用重复确认凑拍。
- 「已知事实」只列已核实内容；不确定标「待定」并放入「勿擅自补写」。
- 「叙述提醒」只写叙述距离、视角、段落密度等全局叙事选择。不得写某个角色的说话方式、口头禅、句长或对白示例；角色对白必须回到该角色的 writing 用途投影读取。
- 「表达边界」只在设定术语容易污染普通叙述或对白时填写。每行使用：事实 | 用途=… | 精度=exact/normal/sensory | 叙述=… | 对白=… | 技术对白=… | 避免=…。它是语域和信息精度提示，不是固定同义词替换；未填写的栏目留空。
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
    narrationNotes: [],
    doNotInvent: [],
    narrativeBrief: brief,
    structured: false,
    strippedMeta: [],
    factAtoms: [],
    realizationBoundaries: [],
  };
}

/** Split a pipe row into normalized `key=value` pairs plus a leading bare label. */
function parsePipeRow(raw: string): { label: string; values: Map<string, string> } {
  const values = new Map<string, string>();
  let label = "";
  for (const piece of raw.split("|").map(item => item.trim()).filter(Boolean)) {
    const separator = piece.indexOf("=");
    if (separator < 0) {
      if (!label) label = piece;
      continue;
    }
    const key = piece.slice(0, separator).trim().toLocaleLowerCase();
    const value = piece.slice(separator + 1).trim();
    if (value) values.set(key, value);
  }
  return { label, values };
}

/** 知道／不知道／在隐瞒 are lists inside one cell; authors separate them freely. */
function splitGateItems(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[；;、,，]+/u)
    .map(item => item.trim().replace(/^无$|^没有$/u, ""))
    .filter(Boolean)
    .slice(0, 6);
}

/**
 * Rows shaped `角色 | 知道=… | 不知道=… | 在隐瞒=…`. A row with a name but no
 * epistemic field is dropped rather than rendered as an empty gate — a gate that
 * says nothing would still read to the writer as a hard constraint.
 */
function parseKnowledgeGates(rows: string[]): KnowledgeGate[] {
  const gates: KnowledgeGate[] = [];
  for (const raw of rows.slice(0, 6)) {
    const { label, values } = parsePipeRow(raw);
    const character = (values.get("角色") ?? values.get("人物") ?? label).trim();
    if (!character) continue;
    const knows = splitGateItems(values.get("知道"));
    const unknown = splitGateItems(values.get("不知道") ?? values.get("未知"));
    const concealing = splitGateItems(values.get("在隐瞒") ?? values.get("隐瞒"));
    if (!knows.length && !unknown.length && !concealing.length) continue;
    gates.push({ character: character.slice(0, 40), knows, unknown, concealing });
  }
  return gates;
}

/**
 * Rows shaped `意图=… | 尝试=… | 阻碍=…`. Unstructured event-order rows stay in
 * beatOrder untouched, so an older draft model degrades to the previous behavior
 * instead of losing its event sequence.
 */
function parseSceneBeats(rows: string[]): SceneBeat[] {
  const beats: SceneBeat[] = [];
  for (const raw of rows.slice(0, 8)) {
    const { values } = parsePipeRow(raw);
    const intent = values.get("意图") ?? values.get("intent") ?? "";
    const attempt = values.get("尝试") ?? values.get("attempt") ?? "";
    const obstacle = values.get("阻碍") ?? values.get("错位") ?? values.get("obstacle") ?? "";
    if (!intent || !attempt || !obstacle) continue;
    beats.push({ intent, attempt, obstacle });
  }
  return beats;
}

function parseRealizationBoundaries(
  rows: string[],
  facts: FactAtom[],
  sanitize: (value: string) => string,
): RealizationBoundary[] {
  const boundaries: RealizationBoundary[] = [];
  for (const raw of rows.slice(0, 12)) {
    const pieces = raw.split("|").map(item => item.trim()).filter(Boolean);
    if (!pieces.length) continue;
    const values = new Map<string, string>();
    let claim = "";
    for (const piece of pieces) {
      const separator = piece.indexOf("=");
      if (separator < 0) {
        if (!claim) claim = sanitize(piece).trim();
        continue;
      }
      const key = piece.slice(0, separator).trim().toLocaleLowerCase();
      const value = sanitize(piece.slice(separator + 1)).trim();
      if (value) values.set(key, value);
    }
    claim = values.get("事实") ?? values.get("fact") ?? claim;
    if (!claim) continue;
    const hasGuidance = [
      "用途", "purpose", "精度", "precision", "叙述", "narration", "对白", "dialogue",
      "技术对白", "technical", "technicaldialogue", "避免", "avoid",
    ].some(key => values.has(key));
    if (!hasGuidance) continue;
    const matched = facts.find(fact => fact.claim === claim)
      ?? facts.find(fact => fact.claim.includes(claim) || claim.includes(fact.claim));
    const factId = matched?.id ?? `boundary-${boundaries.length + 1}`;
    const precision = normalizeFactPrecision(values.get("精度") ?? values.get("precision"));
    boundaries.push({
      factId,
      claim,
      ...(values.get("用途") || values.get("purpose") ? { purpose: values.get("用途") ?? values.get("purpose") } : {}),
      ...(precision ? { precision } : {}),
      ...(values.get("叙述") || values.get("narration") ? { narration: values.get("叙述") ?? values.get("narration") } : {}),
      ...(values.get("对白") || values.get("dialogue") ? { dialogue: values.get("对白") ?? values.get("dialogue") } : {}),
      ...(values.get("技术对白") || values.get("technical") || values.get("technicaldialogue")
        ? { technicalDialogue: values.get("技术对白") ?? values.get("technical") ?? values.get("technicaldialogue") } : {}),
      ...(values.get("避免") || values.get("avoid") ? { avoid: values.get("避免") ?? values.get("avoid") } : {}),
    });
  }
  return boundaries;
}

function normalizeFactPrecision(value: string | undefined): FactPrecision | undefined {
  if (value === "exact" || value === "normal" || value === "sensory") return value;
  return undefined;
}

function formatKnowledgeGate(gate: KnowledgeGate): string {
  const fields = [
    gate.knows.length ? `知道：${gate.knows.join("、")}` : "",
    gate.unknown.length ? `不知道：${gate.unknown.join("、")}` : "",
    gate.concealing.length ? `在隐瞒：${gate.concealing.join("、")}` : "",
  ].filter(Boolean);
  return `- ${gate.character}｜${fields.join("；")}`;
}

function formatRealizationBoundary(boundary: RealizationBoundary): string {
  const fields = [
    `事实：${boundary.claim}`,
    boundary.purpose ? `用途：${boundary.purpose}` : "",
    boundary.precision ? `精度：${boundary.precision}` : "",
    boundary.narration ? `叙述倾向：${boundary.narration}` : "",
    boundary.dialogue ? `普通对白倾向：${boundary.dialogue}` : "",
    boundary.technicalDialogue ? `专业对白可用：${boundary.technicalDialogue}` : "",
    boundary.avoid ? `避免：${boundary.avoid}` : "",
  ].filter(Boolean);
  return `- ${fields.join("；")}`;
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
