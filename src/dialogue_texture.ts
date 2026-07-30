/**
 * Structural dialogue measurement (rules only, no model calls, never blocking).
 *
 * Why this exists as its own module rather than more fields on prose_vividness:
 * that module rewards dialogue by counting paragraphs that OPEN with a quote,
 * which a chapter of clipped one-liners satisfies at the lowest possible cost —
 * "知道。" / "下来。" / "再一次。" each buy a full paragraph of credit. Meanwhile
 * prose_metrics' rhythm gate strips quoted spans before measuring, so short
 * dialogue is exempt from the 碎句 penalty that keeps narration long. The two
 * together form a net incentive toward telegraphic dialogue. This module
 * measures the shape of the dialogue itself so that incentive has a counterweight.
 *
 * Two tiers, deliberately separated by reliability:
 * - Attribution-free (lineCount / median / spread / longRatio): parsing quoted
 *   spans is unambiguous, so these carry the warnings.
 * - Per-speaker (speakers / voiceDistance): attribution is a heuristic parse of
 *   「X说」-shaped tags and misses pronouns, bare lines and unusual tags. These
 *   are reported to the reviewer as reference numbers ONLY — the judgment of
 *   whether two characters actually sound alike stays with the model
 *   (chapter_review's voice_homogenization), never with a regex.
 *
 * Nothing here matches meaning. Speech-verb tags are syntax, and clause counts /
 * lengths / punctuation are form; no rule claims to know what a line is doing.
 */

export type DialogueTextureCode = "dialogue_clipped" | "dialogue_monotone" | "voice_uniform";

export type DialogueTextureIssue = {
  code: DialogueTextureCode;
  message: string;
  examples: string[];
};

export type SpeakerProfile = {
  speaker: string;
  lines: number;
  medianLength: number;
  /** Mean comma/semicolon-delimited segments per line — how built-up the syntax is. */
  clausesPerLine: number;
  questionRatio: number;
  shortRatio: number;
};

export type DialogueTextureStats = {
  lineCount: number;
  attributedLines: number;
  meanLength: number;
  medianLength: number;
  /** Share of lines at or below SHORT_LINE_CHARS. */
  shortRatio: number;
  /** Share of lines at or above LONG_LINE_CHARS. */
  longRatio: number;
  /** p80 − p20 dialogue line length: how far the register actually travels. */
  lengthSpread: number;
  speakers: SpeakerProfile[];
  /**
   * 0–100 mean pairwise distance between speaker profiles (0 = every speaker
   * measures identically). Reference number for the reviewer, not a verdict.
   */
  voiceDistance: number;
};

export type DialogueTexture = {
  stats: DialogueTextureStats;
  issues: DialogueTextureIssue[];
};

/** At or below this many chars a line is a beat, not an exchange. */
export const SHORT_LINE_CHARS = 6;
/** At or below this many content chars a line only acknowledges: 嗯 / 知道 / 下来. */
export const ACKNOWLEDGEMENT_CHARS = 3;
/** At or above this many chars a line is carrying built-up syntax. */
export const LONG_LINE_CHARS = 30;
/** Median dialogue length for a chapter whose characters argue rather than acknowledge. */
export const DIALOGUE_MEDIAN_TARGET = 10;
/** Long lines below this share means nobody in the chapter ever holds the floor. */
export const DIALOGUE_LONG_RATIO_TARGET = 0.1;
/**
 * Short lines above this share means the chapter is mostly acknowledgement even
 * if a few speeches run long. Calibrated against real chapters: a chapter whose
 * dialogue works sits near 25%, chapters that read as telegraphic sit near 55%,
 * and the long-line share alone does not separate them — one or two speeches can
 * clear DIALOGUE_LONG_RATIO_TARGET while every other line is "知道。"
 */
export const SHORT_RATIO_LIMIT = 0.45;
/** p80 − p20 below this means one register for every speaker in every scene. */
export const DIALOGUE_SPREAD_TARGET = 14;
/** Speaker-profile distance below this is worth a look; not a verdict on its own. */
export const VOICE_DISTANCE_TARGET = 18;
/** Fewer lines than this and the distribution is noise. */
const MIN_DIALOGUE_LINES = 12;
/** A speaker needs this many attributed lines before a profile means anything. */
const MIN_SPEAKER_LINES = 4;

/** Quoted spans. Nested/unclosed quotes are skipped rather than guessed at. */
const QUOTE_SPAN = /「([^」\n]{1,400})」|『([^』\n]{1,400})』|“([^”\n]{1,400})”/gu;

/**
 * Speech tags, used for attribution only, and only when no cast roster was
 * supplied. This is a syntactic tag parse: the 2–4 char run of CJK before a
 * speech verb is taken as the speaker. It is noisy on real prose — 「她终于说」
 * yields 终于 — so the guards below drop leading function words and known
 * adverbs, and callers that can supply the project's actual character names
 * should do so. Pronouns are never resolved: 他/她 identifies a speaker to the
 * reader but not to this parser, and guessing would silently merge two
 * characters into one profile, which is worse than attributing fewer lines.
 */
const SPEECH_TAG = /([一-鿿]{2,4})(?:说|问|道|答|喊|叫|开口|低声|沉声|补充|回答|反问|打断|念|接)/gu;
const LEADING_PARTICLE = /^[对向朝跟和与替为被把让从在也都又还就才那这他她它]+/u;
const TRAILING_PARTICLE = /(?:忽然|终于|其实|随即|立刻|又|也|还|就|才|再|想)+$/u;
const NON_NAME_TAG = /^(?:他们|她们|有人|众人|对方|两人|一个|那个|这个|所有|大家|无人|没人|随后|接着|忽然|然后|于是|最后|同时|终于|似乎|仿佛|其实|仍然|依然|只是|立刻|正在|知道|听见|听到|重新|忽而|随即|马上|果然|居然|竟然|已经|还想|再次)$/u;

export function analyzeDialogueTexture(text: string, knownSpeakers: readonly string[] = []): DialogueTexture {
  const lines = extractDialogueLines(text, knownSpeakers.filter(name => name.length >= 2));
  const lengths = lines.map(line => line.content.length).sort((a, b) => a - b);
  const stats = buildStats(lines, lengths);

  const issues: DialogueTextureIssue[] = [];
  if (stats.lineCount < MIN_DIALOGUE_LINES) return { stats, issues };

  if (stats.medianLength <= SHORT_LINE_CHARS
    && (stats.shortRatio >= SHORT_RATIO_LIMIT || stats.longRatio < DIALOGUE_LONG_RATIO_TARGET)) {
    issues.push({
      code: "dialogue_clipped",
      message: `对白中位数 ${stats.medianLength} 字、≤${SHORT_LINE_CHARS} 字占 ${pct(stats.shortRatio)}%、≥${LONG_LINE_CHARS} 字仅 ${pct(stats.longRatio)}%（参考中位数 ${DIALOGUE_MEDIAN_TARGET} 字、长台词 ${pct(DIALOGUE_LONG_RATIO_TARGET)}%）；全章没有人真正把话说开，只在确认和应答。让至少一次交锋里有人说长——辩解、还价、绕开问题、讲一件对方没问的事；对白短是重音，通篇短就只剩电报。`,
      examples: shortestSamples(lines, 4),
    });
  }
  if (stats.lengthSpread < DIALOGUE_SPREAD_TARGET) {
    issues.push({
      code: "dialogue_monotone",
      message: `对白句长起伏仅 ${stats.lengthSpread} 字（p80−p20，参考 ${DIALOGUE_SPREAD_TARGET}）；不论谁在说、说的是什么，长度都在同一档。让句长跟着处境走：被逼问的人话变碎，占上风的人话变长，说不出口的人半句就停。`,
      examples: [],
    });
  }
  const profiled = stats.speakers.filter(profile => profile.lines >= MIN_SPEAKER_LINES);
  if (profiled.length >= 2 && stats.voiceDistance < VOICE_DISTANCE_TARGET) {
    issues.push({
      code: "voice_uniform",
      message: `${profiled.map(p => `${p.speaker}(${p.lines}句/中位${p.medianLength}字/每句${p.clausesPerLine}节)`).join("、")} 的对白在长度、分句数与句式统计上几乎重合（差异度 ${stats.voiceDistance}，参考 ${VOICE_DISTANCE_TARGET}）；这只是形式统计，是否真的换人也说得通请自行核对——把提示语遮住通读一遍。若确实互换无碍，给每人一个别人不会用的说话方式：回避的角度、爱用的句式、说不利索的地方。`,
      examples: [],
    });
  }
  return { stats, issues };
}

/** Compact one-line summary for tool results and reviewer signals. */
export function formatDialogueSummary(stats: DialogueTextureStats): string {
  if (!stats.lineCount) return "对白 0 句";
  const voices = stats.speakers.length
    ? `；可归属说话人 ${stats.speakers.map(p => `${p.speaker}×${p.lines}`).join("/")}；声线差异度 ${stats.voiceDistance}`
    : "";
  return `对白 ${stats.lineCount} 句；均长 ${stats.meanLength} 字/中位 ${stats.medianLength} 字；`
    + `≤${SHORT_LINE_CHARS} 字 ${pct(stats.shortRatio)}%；≥${LONG_LINE_CHARS} 字 ${pct(stats.longRatio)}%；`
    + `句长起伏 ${stats.lengthSpread} 字${voices}`;
}

/**
 * Positive-direction guidance for the NEXT scene. Same contract as
 * sceneVividnessFeedback: measured from what the chapter has accumulated,
 * advisory only, silent when the chapter has too little dialogue to measure.
 */
export function sceneDialogueFeedback(chapterSoFar: string): string[] {
  const { stats, issues } = analyzeDialogueTexture(chapterSoFar);
  if (!issues.length) return [];
  return [
    `本章至今的对白计量（参考项，不构成拦截）：${formatDialogueSummary(stats)}`,
    ...issues.map(issue => issue.message),
  ];
}

/**
 * Share of paragraphs opening with a dialogue line that says something, rather
 * than merely acknowledging. prose_vividness scores against this instead of raw
 * dialogue-paragraph count so a wall of "知道。" cannot buy the dialogue term.
 *
 * The bar is ACKNOWLEDGEMENT_CHARS, not SHORT_LINE_CHARS: a five-character
 * question is terse dialogue but still an exchange, and disqualifying it would
 * penalise clipped-but-working scenes. What this excludes is the register that
 * carries no content at all — 嗯 / 知道 / 下来. Whether a chapter is uniformly
 * clipped is a different question, answered by dialogue_clipped above.
 */
export function substantiveDialogueParagraphRatio(text: string): number {
  const items = text.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
  if (!items.length) return 0;
  const substantive = items.filter(item => {
    const match = /^[「『“]([^」』”\n]*)/u.exec(item);
    if (!match) return false;
    return match[1].replace(/[\s，,。！？!?…、；;：:]/gu, "").length > ACKNOWLEDGEMENT_CHARS;
  }).length;
  return Math.round((substantive / items.length) * 1_000) / 1_000;
}

type DialogueLine = { content: string; speaker?: string };

function extractDialogueLines(text: string, roster: readonly string[]): DialogueLine[] {
  const body = text.replace(/\r\n?/g, "\n");
  const lines: DialogueLine[] = [];
  for (const paragraph of body.split(/\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^---+$/.test(trimmed) || /^\|.*\|$/.test(trimmed)) continue;
    QUOTE_SPAN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = QUOTE_SPAN.exec(trimmed)) !== null) {
      const raw = match[1] ?? match[2] ?? match[3] ?? "";
      const content = raw.replace(/\s/g, "");
      if (!content) continue;
      const before = trimmed.slice(Math.max(0, match.index - 14), match.index);
      const after = trimmed.slice(match.index + match[0].length, match.index + match[0].length + 14);
      lines.push({
        content,
        speaker: roster.length
          ? rosterSpeaker(after, roster, "first") ?? rosterSpeaker(before, roster, "last")
          : attributeSpeaker(after) ?? attributeSpeaker(before),
      });
    }
  }
  return lines;
}

/**
 * Roster attribution: whichever known name sits closest to the quote wins.
 * "first" for the fragment after the quote, "last" for the fragment before it —
 * both mean "nearest the speech", which is where the speaker tag lives.
 */
function rosterSpeaker(fragment: string, roster: readonly string[], pick: "first" | "last"): string | undefined {
  let best: { name: string; index: number } | undefined;
  for (const name of roster) {
    const index = pick === "first" ? fragment.indexOf(name) : fragment.lastIndexOf(name);
    if (index < 0) continue;
    if (!best || (pick === "first" ? index < best.index : index > best.index)) best = { name, index };
  }
  return best?.name;
}

/** Last speech tag in the fragment wins — "他对女技师说" should name 女技师, not 对女技师. */
function attributeSpeaker(fragment: string): string | undefined {
  SPEECH_TAG.lastIndex = 0;
  let found: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = SPEECH_TAG.exec(fragment)) !== null) {
    const candidate = match[1].replace(LEADING_PARTICLE, "").replace(TRAILING_PARTICLE, "");
    if (candidate.length >= 2 && !NON_NAME_TAG.test(candidate)) found = candidate;
  }
  return found;
}

function buildStats(lines: DialogueLine[], lengths: number[]): DialogueTextureStats {
  if (!lines.length) {
    return {
      lineCount: 0, attributedLines: 0, meanLength: 0, medianLength: 0,
      shortRatio: 0, longRatio: 0, lengthSpread: 0, speakers: [], voiceDistance: 0,
    };
  }
  const at = (ratio: number) => lengths[Math.min(lengths.length - 1, Math.floor((lengths.length - 1) * ratio))];
  const speakers = speakerProfiles(lines);
  return {
    lineCount: lines.length,
    attributedLines: lines.filter(line => line.speaker).length,
    meanLength: round1(lengths.reduce((sum, value) => sum + value, 0) / lengths.length),
    medianLength: at(0.5),
    shortRatio: ratio3(lengths.filter(value => value <= SHORT_LINE_CHARS).length / lengths.length),
    longRatio: ratio3(lengths.filter(value => value >= LONG_LINE_CHARS).length / lengths.length),
    lengthSpread: Math.max(0, at(0.8) - at(0.2)),
    speakers,
    voiceDistance: meanPairwiseDistance(speakers.filter(profile => profile.lines >= MIN_SPEAKER_LINES)),
  };
}

function speakerProfiles(lines: DialogueLine[]): SpeakerProfile[] {
  const grouped = new Map<string, string[]>();
  for (const line of lines) {
    if (!line.speaker) continue;
    const bucket = grouped.get(line.speaker) ?? [];
    bucket.push(line.content);
    grouped.set(line.speaker, bucket);
  }
  return [...grouped.entries()]
    .map(([speaker, contents]) => {
      const sorted = contents.map(content => content.length).sort((a, b) => a - b);
      return {
        speaker,
        lines: contents.length,
        medianLength: sorted[Math.floor((sorted.length - 1) / 2)],
        clausesPerLine: round1(
          contents.reduce((sum, content) => sum + content.split(/[，,；;、]/u).filter(Boolean).length, 0) / contents.length,
        ),
        questionRatio: ratio3(contents.filter(content => /[？?]/u.test(content)).length / contents.length),
        shortRatio: ratio3(contents.filter(content => content.length <= SHORT_LINE_CHARS).length / contents.length),
      };
    })
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 8);
}

/**
 * Euclidean distance over normalized form features, averaged over every speaker
 * pair. Feature scales are chosen so one full "gear" of difference in any single
 * dimension lands near 1 — a 40-char median gap, 4 clauses, or an all-or-nothing
 * split in questions / clipped lines.
 */
function meanPairwiseDistance(profiles: SpeakerProfile[]): number {
  if (profiles.length < 2) return 0;
  const vector = (profile: SpeakerProfile) => [
    Math.min(1, profile.medianLength / 40),
    Math.min(1, profile.clausesPerLine / 4),
    profile.questionRatio,
    profile.shortRatio,
  ];
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < profiles.length; i += 1) {
    for (let j = i + 1; j < profiles.length; j += 1) {
      const a = vector(profiles[i]);
      const b = vector(profiles[j]);
      total += Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
      pairs += 1;
    }
  }
  return Math.round((total / pairs) * 100);
}

function shortestSamples(lines: DialogueLine[], limit: number): string[] {
  return [...new Set(lines.filter(line => line.content.length <= SHORT_LINE_CHARS).map(line => line.content))]
    .slice(0, limit);
}

function pct(value: number): number {
  return Math.round(value * 100);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function ratio3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
