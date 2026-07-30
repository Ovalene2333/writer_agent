/**
 * Additive prose-vividness measurement (rules only, no model calls).
 *
 * The rest of the prose stack is subtractive: prose_quality guards explanatory
 * mannerisms, prose_metrics measures reuse / rhythm defects, chapter_review
 * catches structural pileup. All four answer "does this read like AI?" — none
 * answers "is there a scene here at all?", so clean-but-flat prose passes every
 * gate with a perfect score.
 *
 * This module measures the positive side: does the page carry dialogue, more
 * than one sensory channel, objects that only exist in this room, and a rhythm
 * that shifts? It NEVER blocks. Output feeds three places:
 * - sceneVividnessFeedback → next-scene guidance in the scene-pipeline result
 * - proseVividnessScore    → additive term in sceneProseScore (best-of-N rerank)
 * - chapter-level stats    → inspect_chapter_draft checklist + chapter_review signals
 *
 * Deliberately orthogonal to prose_metrics' MICRO_ACTION_LEXICON: that list
 * penalizes body-tic filler (目光/呼吸/指尖), this one rewards perception of the
 * world (光线/声响/铁锈味). A scene can and should drop the former while raising
 * the latter — the two never reward the same token.
 */

import { substantiveDialogueParagraphRatio } from "./dialogue_texture.js";

export type ProseVividnessCode =
  | "dialogue_starved"
  | "sensory_flat"
  | "generic_atmosphere"
  | "stage_bare"
  | "rhythm_uniform";

export type ProseVividnessIssue = {
  code: ProseVividnessCode;
  message: string;
  examples: string[];
};

export type ProseVividnessStats = {
  characters: number;
  /** Share of paragraphs opening with a quote mark. */
  dialogueRatio: number;
  /**
   * Same share, counting only dialogue long enough to be an exchange. The score
   * uses THIS one: a chapter of clipped one-liners inflates dialogueRatio at
   * almost no cost, which made the dialogue term reward the exact telegraphic
   * shape dialogue_texture warns about. See src/dialogue_texture.ts.
   */
  substantiveDialogueRatio: number;
  /** How many of the 5 sensory channels appear at all (0–5). */
  sensoryChannels: number;
  sensoryPer10k: number;
  /** Counter-phrase anchors (一盏灯 / 两截电线) — objects that pin a scene to one place. */
  concretePer10k: number;
  /** Generic atmosphere tags (气氛/仿佛/某种/一切) — the "fits any story" vocabulary. */
  abstractPer10k: number;
  /** p80 − p20 narrative sentence length: how far the rhythm actually travels. */
  sentenceLengthSpread: number;
  longSentenceRatio: number;
  score: number;
};

export type ProseVividness = {
  stats: ProseVividnessStats;
  issues: ProseVividnessIssue[];
};

/** Dialogue paragraphs below this share read as narrated summary rather than a scene. */
export const DIALOGUE_RATIO_TARGET = 0.18;
/** Sensory tokens per 10k chars for a scene that is actually being perceived. */
export const SENSORY_PER_10K_TARGET = 40;
/** Counter-phrase object anchors per 10k chars. */
export const CONCRETE_PER_10K_TARGET = 25;
/** Generic atmosphere tags above this per 10k chars start replacing real detail. */
export const ABSTRACT_PER_10K_LIMIT = 25;
/** p80 − p20 sentence length below this means one gear for the whole scene. */
export const RHYTHM_SPREAD_TARGET = 18;
/** Below this many chars the statistics are noise; report nothing. */
const MIN_MEASURABLE_CHARACTERS = 400;

/**
 * Five perception channels. Multi-character tokens on purpose: single chars like
 * 色/响/重 collide with 角色/影响/重新 and would inflate every count.
 */
const SENSORY_CHANNELS: ReadonlyArray<{ channel: string; pattern: RegExp }> = [
  {
    channel: "视",
    pattern: /光线|光亮|亮起|昏暗|阴影|影子|反光|刺眼|明晃|闪烁|发白|通红|漆黑|灰白|泛黄|轮廓|眯|逆光|暗处/gu,
  },
  {
    channel: "听",
    pattern: /声音|声响|响起|作响|响动|脚步声|回声|嗡|轰|吱|哗|滴答|噼|寂静|听见|听到|喊|低语|嘶/gu,
  },
  {
    channel: "触",
    pattern: /冰凉|发凉|滚烫|发烫|灼|粗糙|光滑|黏|潮湿|干裂|刺痛|发麻|沉重|颤|哆嗦|冻|扎手|温热/gu,
  },
  {
    channel: "嗅味",
    pattern: /气味|味道|腥|发臭|发霉|清香|酸涩|苦涩|烟味|铁锈|血腥|汗味|土腥|焦糊/gu,
  },
  {
    channel: "空间",
    pattern: /倾斜|颠簸|摇晃|坠|悬|拥挤|狭窄|远处|头顶|脚下|身后|墙角|地面|尽头|门缝|台阶/gu,
  },
];

/**
 * Counter phrases (数词 + 量词) are the cheapest reliable signal for "an object
 * that exists in this room": 一盏灯, 两截电线, 半张纸.
 */
const CONCRETE_ANCHOR =
  /[一二两三四五六七八九十几半整][只个条根张片块台把双件顶盏枚支瓶杯碗盘扇道段截层排列圈团缕丝粒滴串堆摞卷面辆架座棵株头匹尾节袋箱盒枝对副]/gu;

/**
 * The "swap the names and it still fits any story" vocabulary — the failure mode
 * naturalProseCraftPrompt's 具体性检查 names but no gate has ever measured.
 */
const GENERIC_ATMOSPHERE =
  /仿佛|似乎|好像|某种|某个|某处|无形|莫名|说不清|难以言喻|气氛|氛围|空气|一切|时间仿佛|命运|意义|真相|存在感|不知为何|隐隐|说不出的|无法形容/gu;

export function analyzeProseVividness(text: string): ProseVividness {
  const body = stripStructuralLines(text);
  const characters = Math.max(1, body.replace(/\s/g, "").length);
  const per10k = (count: number) => Math.round((count / characters) * 10_000);

  const channelHits = SENSORY_CHANNELS.map(entry => ({
    channel: entry.channel,
    count: countMatches(body, entry.pattern),
  }));
  const sensoryChannels = channelHits.filter(entry => entry.count > 0).length;
  const sensoryPer10k = per10k(channelHits.reduce((sum, entry) => sum + entry.count, 0));
  const concretePer10k = per10k(countMatches(body, CONCRETE_ANCHOR));
  const abstractMatches = body.match(GENERIC_ATMOSPHERE) ?? [];
  const abstractPer10k = per10k(abstractMatches.length);
  const rhythm = narrativeRhythm(body);
  const dialogueRatio = dialogueParagraphRatio(body);
  const substantiveDialogueRatio = substantiveDialogueParagraphRatio(body);

  const stats: ProseVividnessStats = {
    characters,
    dialogueRatio,
    substantiveDialogueRatio,
    sensoryChannels,
    sensoryPer10k,
    concretePer10k,
    abstractPer10k,
    sentenceLengthSpread: rhythm.spread,
    longSentenceRatio: rhythm.longRatio,
    score: 0,
  };
  stats.score = compositeScore(stats);

  const issues: ProseVividnessIssue[] = [];
  if (characters < MIN_MEASURABLE_CHARACTERS) return { stats, issues };

  if (substantiveDialogueRatio < DIALOGUE_RATIO_TARGET / 2) {
    issues.push({
      code: "dialogue_starved",
      message: `成句对白起始段仅 ${Math.round(substantiveDialogueRatio * 100)}%（含短应答共 ${Math.round(dialogueRatio * 100)}%，参考 ${Math.round(DIALOGUE_RATIO_TARGET * 100)}%）；正文正在被转述而不是被演出，或对白被压成一串确认与应答。让至少一次交锋发生在人物之间——索取、遮掩、试探或拒绝，而不是由叙述者报告他们谈了什么。独角戏场景可忽略此项。`,
      examples: [],
    });
  }
  if (sensoryChannels <= 2) {
    const missing = channelHits.filter(entry => !entry.count).map(entry => entry.channel);
    issues.push({
      code: "sensory_flat",
      message: `只有 ${sensoryChannels}/5 个感官通道出场（缺：${missing.join("、")}）；现场只被看见，没有被听见、摸到或闻到。补一处会改变人物下一步动作的知觉，不要补形容词。`,
      examples: [],
    });
  }
  if (abstractPer10k > ABSTRACT_PER_10K_LIMIT && abstractPer10k > concretePer10k) {
    issues.push({
      code: "generic_atmosphere",
      message: `泛化氛围词 ${abstractPer10k}/万字，已超过具体物件锚点 ${concretePer10k}/万字；「气氛/仿佛/某种/一切」这类词换掉人名地点仍能套进多数故事。改写成此时此地才成立的物件、动作或后果。`,
      examples: dedupe(abstractMatches).slice(0, 6),
    });
  }
  if (concretePer10k < CONCRETE_PER_10K_TARGET / 2) {
    issues.push({
      code: "stage_bare",
      message: `具体物件锚点 ${concretePer10k}/万字（参考 ${CONCRETE_PER_10K_TARGET}）；场地上没有人物可以拿起、躲开或弄坏的东西。给这一场两三件只属于它的实物，并让其中一件参与动作。`,
      examples: [],
    });
  }
  if (rhythm.sentenceCount >= 20 && rhythm.spread < RHYTHM_SPREAD_TARGET) {
    issues.push({
      code: "rhythm_uniform",
      message: `叙述句长起伏仅 ${rhythm.spread} 字（p80−p20，参考 ${RHYTHM_SPREAD_TARGET}）；全场一个挡位。静场与情感段给一个 35 字以上的绵延句，紧张处才收短。`,
      examples: [],
    });
  }
  return { stats, issues };
}

/**
 * 0–100 additive vividness score. Unlike sceneProseScore's penalty ledger this
 * starts near zero and is earned, so flat-but-clean prose cannot top out.
 */
export function proseVividnessScore(text: string): number {
  return analyzeProseVividness(text).stats.score;
}

function compositeScore(stats: ProseVividnessStats): number {
  // Substantive share on purpose: raw dialogueRatio is cheap to inflate with
  // one-word acknowledgements, which would pay for the very shape we warn about.
  const dialogue = Math.min(18, (stats.substantiveDialogueRatio / DIALOGUE_RATIO_TARGET) * 18);
  const channels = (stats.sensoryChannels / SENSORY_CHANNELS.length) * 20;
  const sensory = Math.min(16, (stats.sensoryPer10k / SENSORY_PER_10K_TARGET) * 16);
  const concrete = Math.min(20, (stats.concretePer10k / CONCRETE_PER_10K_TARGET) * 20);
  const rhythm = Math.min(16, (stats.sentenceLengthSpread / RHYTHM_SPREAD_TARGET) * 16);
  const abstractPenalty = Math.min(20, Math.max(0, stats.abstractPer10k - ABSTRACT_PER_10K_LIMIT) * 0.6);
  const total = 10 + dialogue + channels + sensory + concrete + rhythm - abstractPenalty;
  return Math.round(Math.max(0, Math.min(100, total)) * 10) / 10;
}

/**
 * Positive-direction guidance for the NEXT scene, computed from what the chapter
 * has accumulated so far. Counterpart to prose_metrics' sceneAntiFormulaFeedback:
 * that one says what to stop doing, this one says what is missing.
 */
export function sceneVividnessFeedback(chapterSoFar: string): string[] {
  const { stats, issues } = analyzeProseVividness(chapterSoFar);
  if (stats.characters < MIN_MEASURABLE_CHARACTERS) return [];
  const lines = issues.map(issue => issue.message);
  if (!lines.length) return [];
  return [
    `本章至今的现场感计量（生动度 ${stats.score}/100，加分项，不构成拦截）：`,
    ...lines,
  ];
}

/** Compact one-line summary for tool results and reviewer signals. */
export function formatVividnessSummary(stats: ProseVividnessStats): string {
  return `生动度 ${stats.score}/100；对白段 ${Math.round(stats.dialogueRatio * 100)}%（成句 ${Math.round(stats.substantiveDialogueRatio * 100)}%）；`
    + `感官通道 ${stats.sensoryChannels}/5（${stats.sensoryPer10k}/万字）；`
    + `具体物件 ${stats.concretePer10k}/万字；泛化氛围词 ${stats.abstractPer10k}/万字；`
    + `句长起伏 ${stats.sentenceLengthSpread} 字`;
}

function dialogueParagraphRatio(text: string): number {
  const items = paragraphs(text);
  if (!items.length) return 0;
  const quoted = items.filter(item => /^[「『“"']/u.test(item)).length;
  return Math.round((quoted / items.length) * 1_000) / 1_000;
}

function narrativeRhythm(text: string): {
  sentenceCount: number;
  spread: number;
  longRatio: number;
} {
  const narrative = text.replace(/「[^」\n]*」|『[^』\n]*』|“[^”\n]*”/gu, "");
  const lengths = splitSentences(narrative)
    .map(sentence => normalizeSentence(sentence).length)
    .filter(length => length > 0)
    .sort((a, b) => a - b);
  if (!lengths.length) return { sentenceCount: 0, spread: 0, longRatio: 0 };
  const at = (ratio: number) => lengths[Math.min(lengths.length - 1, Math.floor((lengths.length - 1) * ratio))];
  return {
    sentenceCount: lengths.length,
    spread: Math.max(0, at(0.8) - at(0.2)),
    longRatio: lengths.filter(length => length >= 30).length / lengths.length,
  };
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

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?…])|\n/u)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeSentence(value: string): string {
  return value.replace(/[\s。！？!?…，,、；;：:「」『』“”‘’]/gu, "");
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) count += 1;
  return count;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
