/**
 * Deterministic "AI 味" measurement (rules only, no model calls).
 *
 * Where this sits in the prose stack:
 * - prose_quality  → 说明体句式（破折号、不是…而是、情绪标签），句子级
 * - prose_metrics  → 复读、逐字回收、破折号密度、句长节奏，句级复用
 * - prose_vividness→ 加法层：这一页有没有现场
 * - chapter_review → 模型层：事实、认知边界、跨场景结构
 * - ai_tells (本模块) → 「读起来像不像模型写的」
 *
 * 前四层都答不了最后这个问题：一段完全没有说明体、没有复用、感官充足、
 * 结构无懈可击的正文，仍然可能因为所有人一个语气、章尾自己点破主题、
 * 段落一样长而一眼看出是生成的。本模块测的就是这批特征。
 *
 * 参考的公开观察（AI 检测原理与叙事学研究）里，本项目此前一项都没测：
 * 角色声线同质、叙述者直接点明主题、对白哲学化、三元并列堆叠、
 * 身体情绪计量器、段落长度均齐（burstiness）、四字套话洪水。
 *
 * 本模块 **永不拦截**。输出去三个地方：
 * - sceneAiTellFeedback  → 下一场的负面提示（与 sceneVividnessFeedback 并列）
 * - formatAiTellSummary  → inspect_chapter_draft / 提案结果里的质量画像
 * - stats                → chapter_review 的 proseSignals，供终审模型参考
 *
 * 与既有词表刻意不重叠：
 * - body_emotion_meter 只认「器官 + 生理反应」搭配，窄于 prose_metrics 的
 *   MICRO_ACTION_LEXICON（目光/呼吸/指尖），两者不惩罚同一 token；
 * - philosophical_dialogue 只看引号内，prose_vividness 的 GENERIC_ATMOSPHERE
 *   只看引号外。
 */

export type AiTellCode =
  | "dialogue_homogeneous"
  | "thematic_uplift"
  | "philosophical_dialogue"
  | "tricolon_stacking"
  | "body_emotion_meter"
  | "paragraph_uniform"
  | "idiom_flood"
  /** 单句/单段焊多条事件与概念（AI 网剧旁白腔）。 */
  | "event_packing"
  /** 叙述句长过于均齐（burstiness 低）。 */
  | "sentence_uniform";

export type AiTellIssue = {
  code: AiTellCode;
  message: string;
  examples: string[];
};

export type AiTellStats = {
  characters: number;
  /** 台词条数（引号内片段）。低于 MIN_DIALOGUE_LINES 时声线类指标不参与判定。 */
  dialogueLines: number;
  /** 台词长度 p80−p20：人物说话方式不同时，长度自然拉开。 */
  dialogueLengthSpread: number;
  /** 带口语标记（吧/啊/呢/嘛/省略/改口）的台词占比。 */
  dialogueColloquialRatio: number;
  /** 共享同一个 2 字句首的台词占比：所有人用同样的方式起头。 */
  dialogueOpenerRepeatRatio: number;
  /** 引号内出现主题词（意义/命运/本质…）的台词占比。 */
  philosophicalRatio: number;
  /** 收尾段里由叙述者自己点破主题的段数。 */
  thematicUpliftCount: number;
  /** 三元并列 / 排比框架，每万字。 */
  tricolonPer10k: number;
  /** 器官 + 生理反应搭配，每万字。 */
  bodyMeterPer10k: number;
  paragraphCount: number;
  /** 段落字数 p80−p20：burstiness，AI 检测器的核心判据之一。 */
  paragraphLengthSpread: number;
  /** 四字套话，每万字。 */
  idiomPer10k: number;
  /** 叙述句中「事件堆叠」句占比（顿号/多线索焊句）。 */
  packingRatio: number;
  /** 叙述句长 p80−p20：过低说明整章句长模子一致（低 burstiness）。 */
  sentenceLengthSpread: number;
  /** 0–100，**越高越像 AI**（与 proseVividnessScore 方向相反）。 */
  score: number;
};

/** 叙述句中堆叠句占比超过此值即提示（一句话塞多事）。 */
export const PACKING_RATIO_LIMIT = 0.12;
/** 叙述句数达到此数才判句长均齐。 */
export const MIN_NARRATIVE_SENTENCES = 36;
/** 叙述句长 p80−p20 低于此值视为低 burstiness。 */
export const SENTENCE_SPREAD_TARGET = 14;

/** Narrative-only signals are deliberately excluded for reference materials. */
export type AiTellProfile = "narrative" | "reference";

export type AiTells = {
  profile: AiTellProfile;
  stats: AiTellStats;
  issues: AiTellIssue[];
};

/** 台词长度 p80−p20 低于此值，说明每个人都用同样长度的句子说话。 */
export const DIALOGUE_SPREAD_TARGET = 12;
/** 带口语标记的台词占比低于此值，对白读起来像书面陈述而非说话。 */
export const DIALOGUE_COLLOQUIAL_TARGET = 0.25;
/** 同一 2 字句首的台词占比超过此值，所有人用同一种方式起头。 */
export const DIALOGUE_OPENER_REPEAT_LIMIT = 0.3;
/** 带主题词的台词占比超过此值，人物在替作者做主题讨论。 */
export const PHILOSOPHICAL_RATIO_LIMIT = 0.15;
/** 三元并列 / 排比每万字上限。 */
export const TRICOLON_PER_10K_LIMIT = 25;
/** 器官 + 生理反应每万字上限。 */
export const BODY_METER_PER_10K_LIMIT = 12;
/** 段落字数 p80−p20 低于此值，整章一个段落模子。 */
export const PARAGRAPH_SPREAD_TARGET = 40;
/** 四字套话每万字上限。 */
export const IDIOM_PER_10K_LIMIT = 30;

/** 低于此字数统计是噪声，什么都不报。 */
const MIN_MEASURABLE_CHARACTERS = 400;
/** 台词少于此数时不判声线同质（独角戏、纯叙述场景不该被误伤）。 */
const MIN_DIALOGUE_LINES = 8;
/** 段落少于此数时不判段落均齐。 */
const MIN_PARAGRAPHS = 12;

/** 引号内片段：中英文引号都收。 */
const QUOTED_SPAN = /「([^」\n]{1,200})」|『([^』\n]{1,200})』|“([^”\n]{1,200})”/gu;

/** 口语标记：语气词、省略、改口、半句。人写的对白里这些不会消失。 */
const COLLOQUIAL_MARKER = /[吧呢嘛啊呀哦噢嗯诶哎唉嘿喂咦哈]\s*[。？！…，]?$|[吧呢嘛啊呀]/u;
const SPEECH_BREAK = /[…—]{1,3}|\.{3,}|、{2,}/u;

/** 引号内的主题词：人物开始替作者讨论主题，而不是要东西、遮掩或拒绝。 */
const DIALOGUE_THEME_WORD =
  /意义|命运|真相|本质|人性|存在|救赎|自由|代价|信念|正义|宿命|灵魂|活着|我们都|人总是|这个世界|所谓的/u;

/**
 * 收尾升华：位置加权是它区别于 prose_quality 的 THEMATIC_SUMMARY 的关键。
 * 同一句话出现在段中是叙述，出现在章尾就是叙述者替读者盖棺定论。
 */
const CLOSING_THEMATIC_FRAME =
  /直到(?:这时|此刻|现在|那一刻)|从(?:这天|这一刻|此刻|那天|那以后)(?:起|以后|开始)?|这一刻(?:起|意味着|标志着)|再也(?:不会|回不去|没有)|从此(?:以后)?|终于(?:明白|懂得|意识到|知道)|才(?:真正)?(?:明白|懂得|意识到)|一切都(?:不一样|变了|结束|已经)|归根结底|说到底|注定|终究/u;
const CLOSING_ABSTRACT =
  /意义|命运|真相|人生|成长|救赎|宿命|永远|一切|回忆|往事|未来|answer|选择/u;
/** 具体物件锚点（数词+量词）——收尾段里有实物，就不算空转升华。 */
const CONCRETE_ANCHOR =
  /[一二两三四五六七八九十几半整][只个条根张片块台把双件顶盏枚支瓶杯碗盘扇道段截层排列圈团缕丝粒滴串堆摞卷面辆架座棵株头匹尾节袋箱盒枝对副]/u;

/** 三连短项串：A、B、C。 */
const TRICOLON_ENUM = /[^\s，。！？；：、「」『』“”\n]{1,6}、[^\s，。！？；：、「」『』“”\n]{1,6}、[^\s，。！？；：、「」『』“”\n]{1,6}/gu;
/** 排比框架。 */
const PARALLEL_FRAMES = [
  /既[^，。！？\n]{1,20}[，,]?又[^，。！？\n]{1,20}[，,]?(?:还|也|更)/gu,
  /不仅[^，。！？\n]{1,24}[，,]?(?:而且|还|更|也)/gu,
  /有的[^，。！？\n]{1,16}[，,]有的[^，。！？\n]{1,16}[，,]有的/gu,
  /(?:是|像)[^，。！？\n]{1,16}[，,]也是[^，。！？\n]{1,16}[，,](?:更是|还是)/gu,
];

/**
 * 身体情绪计量器：器官 + 生理反应。刻意只认这组搭配，
 * 不认单独的 目光/呼吸/指尖（那是 prose_metrics 的 MICRO_ACTION_LEXICON 的地盘）。
 */
const BODY_EMOTION_METER =
  /(?:心脏|心口|心头|心里|胸口|喉咙|嗓子|胃里|血液|脊背|后背|太阳穴|头皮|四肢|手心|舌尖)[^，。！？\n]{0,4}(?:一沉|一紧|发紧|一滞|一颤|一寒|一凛|凝固|发凉|发麻|发干|发苦|窜上|涌上|收紧|抽紧|漏跳|猛地一跳|狠狠一跳|沉了下去)/gu;

/** 四字套话：不是错，但成群出现时是最容易辨认的生成腔。 */
const STOCK_IDIOM =
  /不由自主|难以置信|难以名状|难以言喻|五味杂陈|若有所思|意味深长|心中一凛|百感交集|不约而同|不动声色|毫不犹豫|情不自禁|鬼使神差|心照不宣|一言不发|不置可否|无可奈何|悄无声息|不知所措|恍然大悟|如释重负|轻描淡写|漫不经心|微不足道|显而易见|不出所料|果不其然|如出一辙|不置一词|欲言又止|面无表情|嗤之以鼻/gu;

export function analyzeAiTells(text: string, options?: { profile?: AiTellProfile }): AiTells {
  const profile = options?.profile ?? "narrative";
  const body = stripStructuralLines(text);
  const characters = Math.max(1, body.replace(/\s/g, "").length);
  const per10k = (count: number) => Math.round((count / characters) * 10_000);

  const dialogue = dialogueProfile(body);
  const closing = closingUplift(body);
  const packing = packingProfile(body);
  const tricolonMatches = collectAll(body, TRICOLON_ENUM, ...PARALLEL_FRAMES);
  const bodyMeterMatches = collectAll(body, BODY_EMOTION_METER);
  const idiomMatches = collectAll(body, STOCK_IDIOM);
  const paragraphLengths = paragraphs(body).map(item => item.replace(/\s/g, "").length);

  const stats: AiTellStats = {
    characters,
    dialogueLines: dialogue.lines.length,
    dialogueLengthSpread: dialogue.spread,
    dialogueColloquialRatio: dialogue.colloquialRatio,
    dialogueOpenerRepeatRatio: dialogue.openerRepeatRatio,
    philosophicalRatio: dialogue.philosophicalRatio,
    thematicUpliftCount: closing.hits.length,
    tricolonPer10k: per10k(tricolonMatches.length),
    bodyMeterPer10k: per10k(bodyMeterMatches.length),
    paragraphCount: paragraphLengths.length,
    paragraphLengthSpread: spread(paragraphLengths),
    idiomPer10k: per10k(idiomMatches.length),
    packingRatio: packing.ratio,
    sentenceLengthSpread: packing.sentenceSpread,
    score: 0,
  };
  stats.score = compositeScore(stats, profile);

  const issues: AiTellIssue[] = [];
  if (characters < MIN_MEASURABLE_CHARACTERS) return { profile, stats, issues };

  if (profile === "narrative" && stats.dialogueLines >= MIN_DIALOGUE_LINES && dialogueHomogeneity(stats) > 0) {
    const reasons = [
      stats.dialogueLengthSpread < DIALOGUE_SPREAD_TARGET
        ? `台词长度起伏仅 ${stats.dialogueLengthSpread} 字（参考 ${DIALOGUE_SPREAD_TARGET}）`
        : "",
      stats.dialogueColloquialRatio < DIALOGUE_COLLOQUIAL_TARGET
        ? `带口语标记的台词仅 ${Math.round(stats.dialogueColloquialRatio * 100)}%（参考 ${Math.round(DIALOGUE_COLLOQUIAL_TARGET * 100)}%）`
        : "",
      stats.dialogueOpenerRepeatRatio > DIALOGUE_OPENER_REPEAT_LIMIT
        ? `${Math.round(stats.dialogueOpenerRepeatRatio * 100)}% 的台词共用同一个起头`
        : "",
    ].filter(Boolean);
    issues.push({
      code: "dialogue_homogeneous",
      message: `角色声线同质：${reasons.join("；")}。把名字遮住后台词还能互换，就说明人物没有各自的说话方式。`
        + "给至少两个人物各自的句长、口头禅、回避方式与用词层级——不要靠加语气词，靠改他们各自想达成什么。",
      examples: dialogue.lines.slice(0, 4),
    });
  }
  if (profile === "narrative" && closing.hits.length) {
    issues.push({
      code: "thematic_uplift",
      message: `收尾有 ${closing.hits.length} 处由叙述者自己点破主题。这是最容易辨认的生成腔：`
        + "把「他终于明白／从此以后／一切都不一样了」这类总结删掉，改成一个具体的动作、物件或后果收尾，让意义由读者完成。",
      examples: closing.hits.map(item => clip(item, 60)),
    });
  }
  if (profile === "narrative" && stats.dialogueLines >= MIN_DIALOGUE_LINES && stats.philosophicalRatio > PHILOSOPHICAL_RATIO_LIMIT) {
    issues.push({
      code: "philosophical_dialogue",
      message: `${Math.round(stats.philosophicalRatio * 100)}% 的台词在谈意义、命运、本质这类抽象命题`
        + `（参考上限 ${Math.round(PHILOSOPHICAL_RATIO_LIMIT * 100)}%）。人物说话是为了拿到东西、遮掩或拒绝，`
        + "不是为了替作者阐述主题。把这些台词改成具体的索取、条件或威胁。",
      examples: dialogue.philosophicalExamples.slice(0, 4),
    });
  }
  if (stats.tricolonPer10k > TRICOLON_PER_10K_LIMIT) {
    issues.push({
      code: "tricolon_stacking",
      message: `三元并列/排比 ${stats.tricolonPer10k}/万字（参考 ${TRICOLON_PER_10K_LIMIT}）。`
        + "「A、B、C」和「既…又…还」成群出现时节奏会变得机械。留最有信息量的一项，其余删掉或拆到不同段落。",
      examples: dedupe(tricolonMatches).slice(0, 5),
    });
  }
  if (profile === "narrative" && stats.bodyMeterPer10k > BODY_METER_PER_10K_LIMIT) {
    issues.push({
      code: "body_emotion_meter",
      message: `身体情绪计量器 ${stats.bodyMeterPer10k}/万字（参考 ${BODY_METER_PER_10K_LIMIT}）。`
        + "「心脏一沉／喉咙发紧／血液凝固」是用器官读数代替反应。改成人物此刻做了什么、看错了什么、说漏了什么。",
      examples: dedupe(bodyMeterMatches).slice(0, 5),
    });
  }
  if (profile === "narrative" && stats.paragraphCount >= MIN_PARAGRAPHS && stats.paragraphLengthSpread < PARAGRAPH_SPREAD_TARGET) {
    issues.push({
      code: "paragraph_uniform",
      message: `段落长度起伏仅 ${stats.paragraphLengthSpread} 字（p80−p20，参考 ${PARAGRAPH_SPREAD_TARGET}）；`
        + "整章段落边界较整齐。复核段落是否都在相似位置收束；只在注意力、动作或发现真正落定处调整。",
      examples: [],
    });
  }
  if (stats.idiomPer10k > IDIOM_PER_10K_LIMIT) {
    issues.push({
      code: "idiom_flood",
      message: `四字套话 ${stats.idiomPer10k}/万字（参考 ${IDIOM_PER_10K_LIMIT}）。`
        + "「不由自主／五味杂陈／若有所思」单个都没错，成群出现就是现成短语在替具体描写占位。"
        + "挑一半换成此时此地才成立的动作或细节。",
      examples: dedupe(idiomMatches).slice(0, 6),
    });
  }
  if (packing.sentenceCount >= 20 && stats.packingRatio > PACKING_RATIO_LIMIT) {
    issues.push({
      code: "event_packing",
      message: `约 ${Math.round(stats.packingRatio * 100)}% 的叙述句在一句话里焊多条事件/概念`
        + `（参考上限 ${Math.round(PACKING_RATIO_LIMIT * 100)}%）。复核语法关系是否清楚、信息是否按人物注意顺序进入；`
        + "完整长句若持续增加事实且容易理解，应当保留。",
      examples: packing.examples.slice(0, 5),
    });
  }
  if (profile === "narrative" && packing.sentenceCount >= MIN_NARRATIVE_SENTENCES
    && stats.sentenceLengthSpread < SENTENCE_SPREAD_TARGET) {
    issues.push({
      code: "sentence_uniform",
      message: `叙述句长起伏仅 ${stats.sentenceLengthSpread} 字（p80−p20，参考 ${SENTENCE_SPREAD_TARGET}）。`
        + "复核句子是否总按同一节拍结束；只有现场注意力确实需要展开或收紧时才调整句法。",
      examples: [],
    });
  }
  return { profile, stats, issues };
}

/** 0–100，越高越像 AI。与 proseVividnessScore 方向相反，取值时注意别弄反。 */
export function aiTellScore(text: string): number {
  return analyzeAiTells(text).stats.score;
}

/** 单行摘要，供工具结果与 reviewer signals。 */
export function formatAiTellSummary(stats: AiTellStats, profile: AiTellProfile = "narrative"): string {
  if (profile === "reference") {
    return `资料表达风险 ${stats.score}/100（仅作定位参考）；三元并列 ${stats.tricolonPer10k}/万字；`
      + `套话 ${stats.idiomPer10k}/万字；事件堆叠句 ${Math.round(stats.packingRatio * 100)}%。`
      + "资料文档不以人物声线、段落均齐或叙事收尾作为判据。";
  }
  return `表达模式风险 ${stats.score}/100（仅作定位参考）；台词 ${stats.dialogueLines} 条、长度起伏 ${stats.dialogueLengthSpread} 字、`
    + `口语标记 ${Math.round(stats.dialogueColloquialRatio * 100)}%、主题化 ${Math.round(stats.philosophicalRatio * 100)}%；`
    + `收尾升华 ${stats.thematicUpliftCount} 处；三元并列 ${stats.tricolonPer10k}/万字；`
    + `身体读数 ${stats.bodyMeterPer10k}/万字；套话 ${stats.idiomPer10k}/万字；`
    + `事件堆叠句 ${Math.round(stats.packingRatio * 100)}%；句长起伏 ${stats.sentenceLengthSpread} 字；段长起伏 ${stats.paragraphLengthSpread} 字`;
}

/**
 * 下一场的负面提示，与 prose_metrics 的 sceneAntiFormulaFeedback、
 * prose_vividness 的 sceneVividnessFeedback 并列进 avoidNotes。
 * 收尾升华只在整章收口时才有意义，写作途中不提示。
 */
export function sceneAiTellFeedback(chapterSoFar: string): string[] {
  const { stats, issues } = analyzeAiTells(chapterSoFar);
  if (stats.characters < MIN_MEASURABLE_CHARACTERS) return [];
  const lines = issues.filter(issue => issue.code !== "thematic_uplift").map(issue => issue.message);
  if (!lines.length) return [];
  return [`本章至今的 AI 味计量（${stats.score}/100，越低越好；只提示不拦截）：`, ...lines];
}

function compositeScore(stats: AiTellStats, profile: AiTellProfile): number {
  if (profile === "reference") {
    const tricolon = Math.min(14, over(stats.tricolonPer10k, TRICOLON_PER_10K_LIMIT) * 0.35);
    const idiom = Math.min(10, over(stats.idiomPer10k, IDIOM_PER_10K_LIMIT) * 0.25);
    const packing = Math.min(16, over(stats.packingRatio, PACKING_RATIO_LIMIT) * 80);
    return Math.round(Math.max(0, Math.min(100, tricolon + idiom + packing)) * 10) / 10;
  }
  const dialogue = stats.dialogueLines >= MIN_DIALOGUE_LINES ? dialogueHomogeneity(stats) * 20 : 0;
  const uplift = Math.min(18, stats.thematicUpliftCount * 9);
  const philosophical = stats.dialogueLines >= MIN_DIALOGUE_LINES
    ? Math.min(12, over(stats.philosophicalRatio, PHILOSOPHICAL_RATIO_LIMIT) * 40)
    : 0;
  const tricolon = Math.min(14, over(stats.tricolonPer10k, TRICOLON_PER_10K_LIMIT) * 0.35);
  const bodyMeter = Math.min(14, over(stats.bodyMeterPer10k, BODY_METER_PER_10K_LIMIT) * 0.7);
  const paragraph = stats.paragraphCount >= MIN_PARAGRAPHS
    ? Math.min(12, below(stats.paragraphLengthSpread, PARAGRAPH_SPREAD_TARGET) * 12)
    : 0;
  const idiom = Math.min(10, over(stats.idiomPer10k, IDIOM_PER_10K_LIMIT) * 0.25);
  // 事件堆叠与低 burstiness：直接对应「一句话十个概念」与均齐句长。
  const packing = Math.min(16, over(stats.packingRatio, PACKING_RATIO_LIMIT) * 80);
  const sentenceFlat = Math.min(12, below(stats.sentenceLengthSpread, SENTENCE_SPREAD_TARGET) * 12);
  const total = dialogue + uplift + philosophical + tricolon + bodyMeter + paragraph + idiom
    + packing + sentenceFlat;
  return Math.round(Math.max(0, Math.min(100, total)) * 10) / 10;
}

/**
 * Detect “one sentence, many events/concepts” packing and sentence-length burstiness.
 * Heuristics: heavy顿号 lists, multi-clue welders (同时/并且/一边…), or long sentences
 * with many parallel short chunks — common in AI-drama synopsis prose.
 */
function packingProfile(text: string): {
  ratio: number;
  sentenceCount: number;
  sentenceSpread: number;
  examples: string[];
} {
  const narrative = text
    .replace(/「[^」\n]*」|『[^』\n]*』|“[^”\n]*”/gu, " ")
    .replace(/\r\n?/g, "\n");
  const sentences = narrative
    .split(/(?<=[。！？!?…])\s*/u)
    .map(item => item.trim())
    .filter(item => item.length >= 4 && !item.startsWith("#"));
  if (!sentences.length) {
    return { ratio: 0, sentenceCount: 0, sentenceSpread: 0, examples: [] };
  }
  const lengths: number[] = [];
  const packed: string[] = [];
  const weld = /同时|与此同时|不仅|并且|以及|一边[^。]{0,24}一边|不仅[^。]{0,24}(?:还|而且)|先是[^。]{0,20}然后|接着又/u;
  for (const sentence of sentences) {
    const compact = sentence.replace(/\s/g, "");
    lengths.push(compact.length);
    const pauses = (compact.match(/[、，,；;]/gu) ?? []).length;
    const isPacked = (pauses >= 4 && compact.length >= 28)
      || (pauses >= 3 && weld.test(sentence) && compact.length >= 22)
      || (weld.test(sentence) && pauses >= 2 && compact.length >= 36)
      || (compact.length >= 48 && pauses >= 5);
    if (isPacked) packed.push(sentence.length <= 72 ? sentence : `${sentence.slice(0, 69)}…`);
  }
  return {
    ratio: ratio(packed.length, sentences.length),
    sentenceCount: sentences.length,
    sentenceSpread: spread(lengths),
    examples: packed.slice(0, 6),
  };
}

/** 0–1：三项声线信号里命中了多少（长度均齐、无口语、同一起头）。 */
function dialogueHomogeneity(stats: AiTellStats): number {
  const flat = below(stats.dialogueLengthSpread, DIALOGUE_SPREAD_TARGET);
  const bookish = below(stats.dialogueColloquialRatio, DIALOGUE_COLLOQUIAL_TARGET);
  const sameOpener = Math.min(1, over(stats.dialogueOpenerRepeatRatio, DIALOGUE_OPENER_REPEAT_LIMIT) * 2);
  return Math.round(((flat + bookish + sameOpener) / 3) * 100) / 100;
}

function over(value: number, limit: number): number {
  return Math.max(0, value - limit);
}
function below(value: number, target: number): number {
  return Math.max(0, Math.min(1, (target - value) / target));
}

function dialogueProfile(text: string): {
  lines: string[];
  spread: number;
  colloquialRatio: number;
  openerRepeatRatio: number;
  philosophicalRatio: number;
  philosophicalExamples: string[];
} {
  const lines: string[] = [];
  QUOTED_SPAN.lastIndex = 0;
  for (const match of text.matchAll(QUOTED_SPAN)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (value.length >= 2) lines.push(value);
  }
  if (!lines.length) {
    return {
      lines, spread: 0, colloquialRatio: 0, openerRepeatRatio: 0,
      philosophicalRatio: 0, philosophicalExamples: [],
    };
  }
  const lengths = lines.map(line => line.replace(/\s/g, "").length);
  const colloquial = lines.filter(line => COLLOQUIAL_MARKER.test(line) || SPEECH_BREAK.test(line)).length;
  const openers = new Map<string, number>();
  for (const line of lines) {
    const opener = line.replace(/^[\s，。！？…—]+/u, "").slice(0, 2);
    if (opener.length < 2) continue;
    openers.set(opener, (openers.get(opener) ?? 0) + 1);
  }
  const topOpener = Math.max(0, ...openers.values());
  const philosophical = lines.filter(line => DIALOGUE_THEME_WORD.test(line));
  return {
    lines,
    spread: spread(lengths),
    colloquialRatio: ratio(colloquial, lines.length),
    openerRepeatRatio: ratio(topOpener, lines.length),
    philosophicalRatio: ratio(philosophical.length, lines.length),
    philosophicalExamples: philosophical.map(line => clip(line, 50)),
  };
}

/**
 * 收尾升华：只看最后两段。同一句话出现在段中是叙述，出现在收尾就是
 * 叙述者替读者盖棺定论——位置才是判据。
 */
function closingUplift(text: string): { hits: string[] } {
  const items = paragraphs(text);
  const closing = items.slice(-2);
  const hits: string[] = [];
  for (const paragraph of closing) {
    if (paragraph.replace(/\s/g, "").length < 12) continue;
    if (/[「『“]/u.test(paragraph)) continue;
    if (CONCRETE_ANCHOR.test(paragraph)) continue;
    const framed = CLOSING_THEMATIC_FRAME.test(paragraph);
    const abstract = CLOSING_ABSTRACT.test(paragraph);
    if (framed || abstract) hits.push(paragraph.trim());
  }
  return { hits };
}

function collectAll(text: string, ...patterns: RegExp[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) found.push(match[0]);
  }
  return found;
}

function stripStructuralLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter(line => {
      const trimmed = line.trim();
      if (/^#{1,6}\s/.test(trimmed)) return false;
      if (/^---+\s*$/.test(trimmed)) return false;
      if (/^\|.*\|$/.test(trimmed)) return false;
      return true;
    })
    .join("\n");
}

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
}

/** p80 − p20：比标准差更抗离群值，与 prose_vividness 的节奏口径一致。 */
function spread(values: number[]): number {
  const sorted = values.filter(value => value > 0).sort((a, b) => a - b);
  if (sorted.length < 3) return 0;
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
  return Math.max(0, at(0.8) - at(0.2));
}

function ratio(count: number, total: number): number {
  return total ? Math.round((count / total) * 1_000) / 1_000 : 0;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
