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
 * - Attribution-free (lineCount / median / spread / longRatio / constructions /
 *   acts): parsing quoted spans is unambiguous, so these carry the warnings.
 * - Per-speaker (speakers / voiceDistance): attribution is a heuristic parse of
 *   「X说」-shaped tags and misses pronouns, bare lines and unusual tags. These
 *   are reported to the reviewer as reference numbers ONLY — the judgment of
 *   whether two characters actually sound alike stays with the model
 *   (chapter_review's voice_homogenization), never with a regex.
 *
 * Three feature families, in increasing order of how much they claim to know:
 * - form (lengths, clause counts, punctuation) — no interpretation at all;
 * - construction (parallel clauses sharing a leading token) — syntax, matched
 *   structurally rather than by vocabulary, so it survives any subject matter;
 * - act (what a line is doing: acknowledging, pledging, ordering, refusing) —
 *   a lexicon, and therefore the one place here that reads meaning. It is
 *   coarse by design and reported as a distribution, never as a verdict on a
 *   single line, because any one line can be misfiled without the shape of the
 *   whole chapter changing.
 */

export type DialogueTextureCode =
  | "dialogue_clipped"
  | "dialogue_monotone"
  | "voice_uniform"
  | "construction_shared"
  | "act_compliant"
  | "dialogue_question_hook"
  | "dialogue_echo";

export type DialogueTextureIssue = {
  code: DialogueTextureCode;
  message: string;
  examples: string[];
};

/** What a line is doing. Coarse on purpose; see the act-lexicon note above. */
export type DialogueAct = "应答" | "承诺" | "命令" | "提问" | "拒绝" | "陈述";

export type SpeakerProfile = {
  speaker: string;
  lines: number;
  medianLength: number;
  /** Mean comma/semicolon-delimited segments per line — how built-up the syntax is. */
  clausesPerLine: number;
  questionRatio: number;
  shortRatio: number;
  /** Share of this speaker's lines built as parallel clauses (要…，要…，要…). */
  parallelRatio: number;
  /** Act distribution, highest first, as "承诺 46%" strings. */
  acts: string[];
};

/** A parallel construction that recurs across the chapter's dialogue. */
export type SharedConstruction = {
  /** The repeated clause-leading token, pronoun-stripped: 要 / 再 / 给你 . */
  head: string;
  /** Whichever occurrences could be attributed; may be empty or partial. */
  speakers: string[];
  lines: number;
  examples: string[];
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
  /** Share of all dialogue lines built as parallel clauses. */
  parallelRatio: number;
  /** Parallel constructions that more than one speaker reaches for. */
  sharedConstructions: SharedConstruction[];
  /** Chapter-wide act distribution, highest first, as "承诺 46%" strings. */
  acts: string[];
  /** Combined 应答 + 承诺 share: how much of the dialogue only accepts or pledges. */
  compliantActRatio: number;
};

export type DialogueTexture = {
  stats: DialogueTextureStats;
  issues: DialogueTextureIssue[];
};

/**
 * Three bans carried over from the roleplay path's performance rules, where they
 * are what keeps an exchange from collapsing into mutual confirmation. Kept as a
 * module constant so both writing paths embed byte-identical text in their stable
 * system slots rather than drifting apart.
 */
export const DIALOGUE_HARD_BANS = "对白硬禁令（三条，无例外）："
  + "一、不把问句当续聊钩子。人物在眼前目标、关系或信息缺口确有需要时才提问；不得为确认理解、索取态度、把选择推给对方、镜像对方原话或维持对话而连发问题。没有必要追问时，用陈述、动作或留白收住。"
  + "二、不复述对方原句。不得引用、改写或概括对方刚说过的话，也不得先汇报自己听懂了什么再回应；直接从这句话给自己造成的处境往下接。"
  + "三、不解释情绪与动机。不写「她感到愤怒」「他意识到这意味着…」「这句话的意思是…」这类由叙述代为命名、翻译或总结的句子；情绪只经由动作、语速、停顿、看向哪里和说了什么呈现，让读者自己得出结论。";

/** Dynamic craft contract shared by direct writing and evidence-grounded scenes. */
export function dialogueNaturalnessGuidance(): string {
  return "对白自然度契约（按本场语义选择，不是配额）：每个说话人先明确此刻想得到什么、知道什么、在回避什么，以及对上一句施加了什么压力；对白要承接或有意错开上一轮的信息。优先用答非所问、追问、让步、反问、改口、停顿、半句和省略表达关系变化，必要时才使用吧/啊/呢等语气词。省略要像人物在现场自然省掉双方已知成分，不能只为显得干脆、冷淡或机灵而把正常句子压成连续的“名词短语＋谓词”；动作对象、感受来源或比较维度不明时应恢复至少一处完整承接，上下文能猜出意思不等于表达自然。不要批量补助词、随机换同义词、把所有人改成碎句，保留克制、正式或紧张场景中没有助词的自然说法。修订时只改有证据的对白及其最小邻近上下文，保持事实、知识和人物声线不变。\n"
    + DIALOGUE_HARD_BANS;
}

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

/** The same parallel construction recurring this often reads as the author's hand. */
export const SHARED_CONSTRUCTION_MIN_LINES = 2;
/**
 * 应答 + 承诺 above this share means the dialogue mostly accepts and pledges.
 * Calibrated on three chapters of one work: 7% / 9% / 24%, the last being the
 * one whose dialogue reads as everyone agreeing with everyone.
 */
export const COMPLIANT_ACT_LIMIT = 0.18;

/**
 * Echo detection: a reply that reuses a run of the previous line verbatim.
 *
 * Three guards together, because a short repeat is a legitimate move — 「他没来
 * 过？」 thrown back in disbelief is dialogue doing work, while a long reply built
 * around the other speaker's own wording is the model restating before answering.
 * So the run must be substantial (MIN chars), must dominate the shorter line
 * (COVERAGE), and the echoing line must itself be long enough that it is not the
 * short incredulous repeat. Only adjacent lines are compared; a callback three
 * exchanges later is deliberate.
 */
const ECHO_MIN_RUN_CHARS = 4;
const ECHO_MIN_COVERAGE = 0.4;
const ECHO_MIN_LINE_CHARS = 8;
/** Under this many hits it is a choice, not a habit. */
const ECHO_REPORT_MIN = 2;
/** Consecutive question pairs at or above this count read as a stalling hook. */
const QUESTION_HOOK_REPORT_MIN = 3;

/**
 * Act lexicon. Ordered by priority — the first category a line matches wins,
 * so 提问 outranks everything (a question stays a question however it is
 * phrased) and 陈述 is the fallthrough. Patterns anchor where the act actually
 * shows: acknowledgements are whole lines, commands and refusals open a line,
 * pledges are a first-person subject bound to a commitment verb anywhere in it.
 *
 * This is deliberately shallow. It cannot tell a sincere pledge from a sarcastic
 * one, and it is not asked to: what it measures is whether every character in a
 * chapter is doing the SAME thing with their mouth, which survives a good deal
 * of per-line error.
 */
const DIALOGUE_ACTS: ReadonlyArray<{ act: DialogueAct; pattern: RegExp }> = [
  { act: "提问", pattern: /[？?]/u },
  {
    act: "应答",
    pattern: /^(?:嗯+|哦+|啊+|唉+|好|好的|好吧|行|行了|是|是的|对|对了|知道|我知道|明白|我明白|懂了|清楚|听清楚了|听到了|听见了|收到|收到了|记下了|记住了|我记得|记得|记着|记吧|可以|没问题|当然|算了|随你|无所谓)$/u,
  },
  { act: "拒绝", pattern: /^(?:不|没有|没|不行|不用|不必|不可能|办不到|做不到|我不|我没)/u },
  {
    act: "命令",
    pattern: /^(?:别|不许|不准|不要|给我|快|停|住手|站住|过来|回去|放下|松手|闭嘴|听我的|跟我来|下来|上来|走|说)(?:[。！!]|$|[^？?]*[。！!]$)/u,
  },
  {
    act: "承诺",
    pattern: /(?:我(?:们)?(?:会|要|去|来|上|干|做|签|认|扛|接|给|带|查|打|守|等|试|配合|答应|保证|负责|处理|搞定|记着|盯着)|交给我|包在我|算我|由我|我自己)/u,
  },
];

/**
 * Clause-leading tokens that carry no construction identity — a line opening
 * with 的/了 is not a parallel structure, it is a fragment.
 */
const PRONOUN_PREFIX = /^[你我他她它咱您]们?/u;

/** Quoted spans. Nested/unclosed quotes are skipped rather than guessed at. */
const QUOTE_SPAN = /「([^」\n]{1,400})」|『([^』\n]{1,400})』|“([^”\n]{1,400})”|"([^"\n]{1,400})"/gu;

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
      message: `电报体候选：对白中位数 ${stats.medianLength} 字、≤${SHORT_LINE_CHARS} 字占 ${pct(stats.shortRatio)}%、≥${LONG_LINE_CHARS} 字仅 ${pct(stats.longRatio)}%（参考中位数 ${DIALOGUE_MEDIAN_TARGET} 字、长台词 ${pct(DIALOGUE_LONG_RATIO_TARGET)}%）。检查连续短句是否省掉了施事、对象或与上句的承接，以至于读者无法从近邻语境补全；短命令、紧张、沉默和上下文足够的口语省略应保留。若确有问题，让一次交锋落到人物正在争取、隐瞒或拒绝的具体信息，而不是单纯把句子拉长。`,
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
  for (const shared of stats.sharedConstructions) {
    const who = shared.speakers.length >= 2
      ? `${shared.speakers.join("、")} 都在用`
      : shared.speakers.length === 1
        ? `包括 ${shared.speakers[0]} 在内，本章反复出现`
        : "本章反复用到";
    issues.push({
      code: "construction_shared",
      message: `${who}同一个并列句式（以「${shared.head}」起头的分句连发，共 ${shared.lines} 句）；换个人说仍然成立，说明这是作者的手，不是人物的嘴。把这个句式留给最该用它的那一个人，其余人改用自己的说法——有人绕圈子，有人只说半句，有人根本不接这个话头。`,
      examples: shared.examples,
    });
  }
  if (stats.compliantActRatio > COMPLIANT_ACT_LIMIT) {
    issues.push({
      code: "act_compliant",
      message: `全章对白有 ${pct(stats.compliantActRatio)}% 是应答或承诺（分布：${stats.acts.join("、")}，参考上限 ${pct(COMPLIANT_ACT_LIMIT)}%）；人物大多在接受和表态，很少在争取自己的东西。让对白承担别的动作：有人索取，有人隐瞒，有人挑衅，有人答非所问，有人说了一件对方没问的事——尤其别让"我会/我去/我签/我认"这类表忠心的句子替代真正的谈判。`,
      examples: [],
    });
  }
  const exchange = analyzeExchangeMoves(lines);
  if (exchange.echoes.length >= ECHO_REPORT_MIN) {
    issues.push({
      code: "dialogue_echo",
      message: `本章有 ${exchange.echoes.length} 处对白在回应前先复述了对方刚说过的话（原句成段照搬或换词转述）。`
        + "人物不会向刚说完话的人重复他的话；他直接从这句话给自己造成的处境往下接——追问缺口、绕开、讨价还价或干脆不接。"
        + "把复述那半句删掉，看剩下的部分是否还成立；若删掉后无话可说，说明这一轮本身没有推进，应改成对方真正抗拒或索取的内容。",
      examples: exchange.echoes.slice(0, 4),
    });
  }
  if (exchange.questionHooks.length >= QUESTION_HOOK_REPORT_MIN) {
    issues.push({
      code: "dialogue_question_hook",
      message: `本章有 ${exchange.questionHooks.length} 处问句被用作续聊钩子（问句紧接问句，或用问句复述对方原话）。`
        + "提问只在人物确有信息缺口、且这个缺口挡住他眼前目标时才成立；用来确认理解、索取态度、把选择推给对方或单纯维持对话的问句应当删掉。"
        + "改成陈述、动作或留白：不追问时人物做点别的，让对方在沉默里自己补上。",
      examples: exchange.questionHooks.slice(0, 4),
    });
  }
  const profiled = stats.speakers.filter(profile => profile.lines >= MIN_SPEAKER_LINES);
  if (profiled.length >= 2 && stats.voiceDistance < VOICE_DISTANCE_TARGET) {
    issues.push({
      code: "voice_uniform",
      message: `${profiled.map(p => `${p.speaker}(${p.lines}句/中位${p.medianLength}字/每句${p.clausesPerLine}节)`).join("、")} 的对白在长度、分句数与句式统计上几乎重合（差异度 ${stats.voiceDistance}，参考 ${VOICE_DISTANCE_TARGET}）；这只是形式统计。把提示语遮住后，若人物确实可互换，回到各自目标、掌握与隐瞒的信息、以及提问/讨价还价/拒绝/解释的策略，不要用口头禅或固定句长制造差异。`,
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
  const shared = stats.sharedConstructions.length
    ? `；复现句式 ${stats.sharedConstructions.map(item => `${item.head}(${item.speakers.length ? `${item.speakers.join("+")}, ` : ""}${item.lines}句)`).join("/")}`
    : "";
  return `对白 ${stats.lineCount} 句；均长 ${stats.meanLength} 字/中位 ${stats.medianLength} 字；`
    + `≤${SHORT_LINE_CHARS} 字 ${pct(stats.shortRatio)}%；≥${LONG_LINE_CHARS} 字 ${pct(stats.longRatio)}%；`
    + `句长起伏 ${stats.lengthSpread} 字；并列句式 ${pct(stats.parallelRatio)}%；言语动作 ${stats.acts.join("/")}${voices}${shared}`;
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
    const match = /^[「『“"]([^」』”"\n]*)/u.exec(item);
    if (!match) return false;
    return match[1].replace(/[\s，,。！？!?…、；;：:]/gu, "").length > ACKNOWLEDGEMENT_CHARS;
  }).length;
  return Math.round((substantive / items.length) * 1_000) / 1_000;
}

type DialogueLine = { content: string; speaker?: string; head?: string };

function extractDialogueLines(text: string, roster: readonly string[]): DialogueLine[] {
  const body = text.replace(/\r\n?/g, "\n");
  const lines: DialogueLine[] = [];
  for (const paragraph of body.split(/\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^---+$/.test(trimmed) || /^\|.*\|$/.test(trimmed)) continue;
    QUOTE_SPAN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = QUOTE_SPAN.exec(trimmed)) !== null) {
      const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
      const content = raw.replace(/\s/g, "");
      if (!content) continue;
      const before = trimmed.slice(Math.max(0, match.index - 14), match.index);
      const after = trimmed.slice(match.index + match[0].length, match.index + match[0].length + 14);
      lines.push({
        content,
        head: parallelHead(content),
        speaker: roster.length
          ? rosterSpeaker(after, roster, "first") ?? rosterSpeaker(before, roster, "last")
          : attributeSpeaker(after) ?? attributeSpeaker(before),
      });
    }
  }
  return lines;
}

/** A speech verb must follow the name within this many chars to count as a tag. */
const SPEECH_VERB_WINDOW = 6;
const SPEECH_VERB = /^[的也又还就才却便随即忽然终于低沉轻小声音]*(?:说|问|道|答|喊|叫|开口|低声|沉声|补充|回答|反问|打断|念|接)/u;

/**
 * Roster attribution: whichever known name sits closest to the quote wins —
 * but only if a speech verb follows it. Proximity alone credits merely-mentioned
 * characters: 「…看着钟北和那块还亮着黄字的平板，“你们要校准，我配合。”」 would
 * otherwise put 林千夏's line in 钟北's mouth. Unattributed is the right answer
 * there; every consumer of this treats a missing speaker as unknown, not as absent.
 */
function rosterSpeaker(fragment: string, roster: readonly string[], pick: "first" | "last"): string | undefined {
  let best: { name: string; index: number } | undefined;
  for (const name of roster) {
    const index = pick === "first" ? fragment.indexOf(name) : fragment.lastIndexOf(name);
    if (index < 0) continue;
    const trailing = fragment.slice(index + name.length, index + name.length + SPEECH_VERB_WINDOW);
    if (!SPEECH_VERB.test(trailing)) continue;
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

/**
 * Adjacent-pair moves that a whole-text regex sweep structurally cannot express:
 * both bans are about what line N does to line N−1, so they need the ordered
 * array rather than a pattern over the chapter.
 *
 * A pair is only examined when the two lines could plausibly be different
 * speakers — when attribution is available and both lines belong to the same
 * speaker, a repeated run is one character circling their own point, which is
 * voice rather than echo.
 */
function analyzeExchangeMoves(lines: DialogueLine[]): { echoes: string[]; questionHooks: string[] } {
  const echoes: string[] = [];
  const questionHooks: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (previous.speaker && current.speaker && previous.speaker === current.speaker) continue;
    const isQuestion = /[？?]/u.test(current.content);
    if (isQuestion && /[？?]/u.test(previous.content)) {
      questionHooks.push(`${previous.content.slice(0, 24)} → ${current.content.slice(0, 24)}`);
      continue;
    }
    if (current.content.length < ECHO_MIN_LINE_CHARS) continue;
    const run = longestCommonRun(comparable(previous.content), comparable(current.content));
    const shorter = Math.min(previous.content.length, current.content.length);
    if (run.length < ECHO_MIN_RUN_CHARS || !shorter || run.length / shorter < ECHO_MIN_COVERAGE) continue;
    const sample = `${previous.content.slice(0, 24)} → ${current.content.slice(0, 24)}（重复「${run}」）`;
    if (isQuestion) questionHooks.push(sample);
    else echoes.push(sample);
  }
  return { echoes, questionHooks };
}

/** Punctuation carries no wording, and long lines are capped to bound the DP. */
function comparable(content: string): string {
  return content.replace(/[\s，,。！!？?…、；;：:—–\-“”"「」『』（）()]/gu, "").slice(0, 120);
}

function longestCommonRun(a: string, b: string): string {
  if (!a || !b) return "";
  let best = 0;
  let end = 0;
  let previousRow = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      row[j] = previousRow[j - 1] + 1;
      if (row[j] > best) {
        best = row[j];
        end = i;
      }
    }
    previousRow = row;
  }
  return a.slice(end - best, end);
}

function buildStats(lines: DialogueLine[], lengths: number[]): DialogueTextureStats {
  if (!lines.length) {
    return {
      lineCount: 0, attributedLines: 0, meanLength: 0, medianLength: 0,
      shortRatio: 0, longRatio: 0, lengthSpread: 0, speakers: [], voiceDistance: 0,
      parallelRatio: 0, sharedConstructions: [], acts: [], compliantActRatio: 0,
    };
  }
  const chapterActs = actDistribution(lines.map(line => line.content));
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
    parallelRatio: ratio3(lines.filter(line => line.head).length / lines.length),
    sharedConstructions: sharedConstructions(lines),
    acts: chapterActs.labels,
    compliantActRatio: chapterActs.compliantRatio,
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
      const acts = actDistribution(contents);
      return {
        speaker,
        lines: contents.length,
        medianLength: sorted[Math.floor((sorted.length - 1) / 2)],
        clausesPerLine: round1(
          contents.reduce((sum, content) => sum + content.split(/[，,；;、]/u).filter(Boolean).length, 0) / contents.length,
        ),
        questionRatio: ratio3(contents.filter(content => /[？?]/u.test(content)).length / contents.length),
        shortRatio: ratio3(contents.filter(content => content.length <= SHORT_LINE_CHARS).length / contents.length),
        parallelRatio: ratio3(contents.filter(content => parallelHead(content)).length / contents.length),
        acts: acts.labels.slice(0, 3),
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

/**
 * The parallel construction that makes three different characters sound like one
 * hand: two or more clauses in a line opening with the same token —
 * 「协议是先坐，再站，再走」、「要校准，我配合。要训练，我去」、「你要查，我给你扛外线。你要打，我给你找配额」.
 *
 * Matched on structure, not vocabulary: the shared token is whatever it happens
 * to be, so this fires on constructions no lexicon anticipated. Leading pronouns
 * are stripped so 「你要查…你要打」 and 「要校准…要训练」 register as the same
 * construction, which is precisely the resemblance a reader hears.
 */
function parallelHead(content: string): string | undefined {
  const clauses = content
    .split(/[，,、；;。！!？?…—]+/u)
    .map(clause => clause.trim())
    .filter(clause => clause.length >= 2);
  if (clauses.length < 2) return undefined;
  const counts = new Map<string, number>();
  for (const clause of clauses) {
    const stripped = clause.replace(PRONOUN_PREFIX, "");
    // The raw head is skipped when the clause opens with a pronoun: 「你要查…你要打」
    // is a 要-construction, and counting 你 as well would tie with — and often beat —
    // the token that actually carries the parallelism.
    const heads = stripped === clause
      ? [clause.slice(0, 1), stripped.slice(0, 2)]
      : [stripped.slice(0, 1), stripped.slice(0, 2)];
    for (const head of heads) {
      if (head.length && /[一-鿿]/u.test(head[0])) counts.set(head, (counts.get(head) ?? 0) + 1);
    }
  }
  // Longest head among those repeated most: 你要×3 is more telling than 你×3.
  let best: { head: string; count: number } | undefined;
  for (const [head, count] of counts) {
    if (count < 2) continue;
    if (!best || count > best.count || (count === best.count && head.length > best.head.length)) {
      best = { head, count };
    }
  }
  return best?.head;
}

function classifyAct(content: string): DialogueAct {
  // Anchored patterns must see the bare line: "我知道。" has to reach ^我知道$.
  const bare = content.replace(/^[「『“"]+|[」』”"]+$/gu, "").replace(/[。！!…、，,]+$/u, "");
  for (const entry of DIALOGUE_ACTS) {
    if (entry.pattern.test(bare)) return entry.act;
  }
  return "陈述";
}

/**
 * The measure that discriminates is NOT the largest bucket. 陈述 is the
 * fallthrough, so it holds 60–77% of every chapter ever measured and a
 * "dominant act" test fires on all of them equally — it reports the classifier's
 * shape, not the chapter's. What separates a stiff chapter from a working one is
 * the compliant share: 应答 + 承诺, the lines that accept and the lines that
 * pledge. Measured across three real chapters that share a cast and an author:
 * 7% / 9% / 24%. The 24% chapter is the one that reads as everyone agreeing.
 */
function actDistribution(contents: string[]): { labels: string[]; compliantRatio: number } {
  if (!contents.length) return { labels: [], compliantRatio: 0 };
  const counts = new Map<DialogueAct, number>();
  for (const content of contents) {
    const act = classifyAct(content);
    counts.set(act, (counts.get(act) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const compliant = (counts.get("应答") ?? 0) + (counts.get("承诺") ?? 0);
  return {
    labels: ranked.map(([act, count]) => `${act} ${pct(count / contents.length)}%`),
    compliantRatio: ratio3(compliant / contents.length),
  };
}

/**
 * Deliberately attribution-free. The signal here is that the same parallel
 * construction recurs across the chapter — that is a fact about the writing hand,
 * and it holds whether or not we can tell who spoke. Gating it on attribution
 * killed it outright in practice: the lines that carry an authorial tic are
 * routinely tagged 「他说」 or sit in a paragraph where the name that appears is
 * only mentioned, not speaking. Speaker names are attached when they happen to
 * be known, and the message downgrades when they are not.
 *
 * Lines confidently attributed to the SAME single speaker are excluded — one
 * character reaching twice for their own construction is a voice, not a tic.
 */
function sharedConstructions(lines: DialogueLine[]): SharedConstruction[] {
  type Entry = { speakers: Set<string>; lines: number; attributed: number; examples: string[] };
  const byHead = new Map<string, Entry>();
  for (const line of lines) {
    const head = line.head;
    if (!head) continue;
    const entry: Entry = byHead.get(head) ?? { speakers: new Set<string>(), lines: 0, attributed: 0, examples: [] };
    if (line.speaker) {
      entry.speakers.add(line.speaker);
      entry.attributed += 1;
    }
    entry.lines += 1;
    if (entry.examples.length < 3) entry.examples.push(line.content.slice(0, 40));
    byHead.set(head, entry);
  }
  return [...byHead.entries()]
    .filter(([, entry]) => entry.lines >= SHARED_CONSTRUCTION_MIN_LINES)
    // Every occurrence traced to one speaker: their own habit, not a shared one.
    .filter(([, entry]) => !(entry.speakers.size === 1 && entry.attributed === entry.lines))
    .map(([head, entry]) => ({
      head,
      speakers: [...entry.speakers],
      lines: entry.lines,
      examples: entry.examples,
    }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 4);
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
