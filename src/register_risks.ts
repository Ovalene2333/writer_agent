/**
 * Naturalness layer: keep character-card phrasing from leaking into lived prose.
 *
 * Layer A extracts "do-not-quote" register risks from cards the Agent already
 * read. Layer B scans finished prose for exact hits in dialogue / narration and
 * can block dense leakage with a repair packet. Semantic naturalness still
 * belongs to chapter review; this module only supplies locatable evidence.
 */

import type { Character } from "./types.js";
import { boundedRepairPacket, type RepairPacket } from "./repair_packet.js";
import type { WriterStore } from "./store.js";
import type { ToolExecutionContext } from "./tools/types.js";

export type RegisterRiskScope = "dialogue" | "narration" | "both";
export type RegisterRiskSource =
  | "voice_example"
  | "voice_diction"
  | "voice_habit"
  | "competency_name"
  | "feature_name"
  | "psychology_label";

export type RegisterRisk = {
  term: string;
  characterId: number;
  characterName: string;
  source: RegisterRiskSource;
  scope: RegisterRiskScope;
  /** Short human reason for writers and repair packets. */
  reason: string;
};

export type CardRegisterHit = {
  term: string;
  characterId: number;
  characterName: string;
  source: RegisterRiskSource;
  scope: RegisterRiskScope;
  region: "dialogue" | "narration";
  start: number;
  end: number;
  line: number;
  evidence: string;
  sentence: string;
  reason: string;
};

export type CardRegisterAssessment = {
  hits: CardRegisterHit[];
  dialogueHits: CardRegisterHit[];
  narrationHits: CardRegisterHit[];
  uniqueDialogueTerms: string[];
  status: "pass" | "warn" | "block";
  message?: string;
};

/** Common short words that should never become register risks. */
const STOP_TERMS = new Set([
  "什么", "怎么", "为什么", "因为", "所以", "但是", "然后", "已经", "还是", "不是",
  "可以", "没有", "知道", "觉得", "看到", "听到", "起来", "下去", "过来", "过去",
  "现在", "以前", "以后", "时候", "地方", "东西", "事情", "问题", "情况", "样子",
  "一点", "一下", "一直", "一起", "自己", "我们", "你们", "他们", "她们", "它们",
  "这里", "那里", "这样", "那样", "这个", "那个", "这些", "那些", "如果", "虽然",
  "只是", "就是", "还是", "或者", "而且", "不过", "其实", "当然", "可能", "应该",
  "需要", "开始", "结束", "继续", "回来", "出去", "进来", "离开", "说话", "声音",
  "眼睛", "手里", "身上", "脸上", "心里", "外面", "里面", "旁边", "前面", "后面",
  "先生", "小姐", "大人", "将军", "老师", "同学", "朋友", "父亲", "母亲", "孩子",
]);

const MAX_RISKS_PER_CHARACTER = 24;
const MAX_RISKS_TOTAL = 80;
const MIN_TERM_CHARS = 2;
const MAX_TERM_CHARS = 16;
/** Example quotes this long are high-value leakage signals. */
const EXAMPLE_PHRASE_MIN = 4;

export function extractRegisterRisksFromCharacter(character: Character): RegisterRisk[] {
  const name = character.identity.name.trim() || `角色${character.id}`;
  const protectedNames = new Set(
    [character.identity.name, ...character.identity.aliases]
      .map(item => item.trim())
      .filter(Boolean),
  );
  const risks: RegisterRisk[] = [];
  const seen = new Set<string>();

  const push = (
    raw: string,
    source: RegisterRiskSource,
    scope: RegisterRiskScope,
    reason: string,
  ) => {
    for (const term of candidateTerms(raw)) {
      if (!isUsableRiskTerm(term, protectedNames)) continue;
      const key = `${term}\0${scope}\0${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      risks.push({
        term,
        characterId: character.id,
        characterName: name,
        source,
        scope,
        reason,
      });
      if (risks.length >= MAX_RISKS_PER_CHARACTER) return;
    }
  };

  for (const example of character.voice.examples.slice(0, 12)) {
    // Example lines are author-only; any near-copy into lived prose is a leak.
    push(example, "voice_example", "both", "角色卡对白示例措辞，正文不得近邻照抄");
    for (const phrase of extractExamplePhrases(example)) {
      push(phrase, "voice_example", "both", "角色卡示例原句片段，保留意图即可，勿原样写入");
    }
  }
  for (const item of character.voice.diction.slice(0, 16)) {
    push(item, "voice_diction", "dialogue", "声线 diction 是倾向信号，不是对白默认词表");
  }
  for (const item of character.voice.verbalHabits.slice(0, 12)) {
    push(item, "voice_habit", "dialogue", "口头习惯只在本场确有触发时使用，禁止当签名复读");
  }
  for (const item of character.competencies.slice(0, 20)) {
    push(item.name, "competency_name", "both", "能力学名是事实精度；普通对白与贴身叙述应转成人物可感说法");
  }
  for (const item of character.features.slice(0, 12)) {
    push(item.name, "feature_name", "narration", "特征名是设定标签；叙述应落到可观察动作或后果");
  }
  for (const group of [
    character.psychology.traits,
    character.psychology.values,
    character.psychology.fears,
    character.psychology.conflicts,
  ]) {
    for (const item of group.slice(0, 8)) {
      push(item.label, "psychology_label", "both", "心理标签不得直接念成对白或旁白判断");
    }
  }

  return risks.slice(0, MAX_RISKS_PER_CHARACTER);
}

export function mergeRegisterRisks(risks: readonly RegisterRisk[]): RegisterRisk[] {
  const seen = new Set<string>();
  const merged: RegisterRisk[] = [];
  for (const risk of risks) {
    const key = `${risk.term}\0${risk.scope}\0${risk.characterId}\0${risk.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(risk);
    if (merged.length >= MAX_RISKS_TOTAL) break;
  }
  // Longer terms first so scanning prefers specific phrases over short fragments.
  return merged.sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term, "zh"));
}

export function collectRegisterRisksFromStore(
  store: WriterStore,
  characterIds: readonly number[],
): RegisterRisk[] {
  const cards = new Map(store.characters().map(character => [character.id, character]));
  const risks: RegisterRisk[] = [];
  for (const id of [...new Set(characterIds)].slice(0, 12)) {
    const character = cards.get(id);
    if (!character) continue;
    risks.push(...extractRegisterRisksFromCharacter(character));
  }
  return mergeRegisterRisks(risks);
}

/**
 * Prefer characters already touched this turn (dialogue / evidence reads), then
 * explicit review roster, then pack-related ids.
 */
export function collectRegisterRisksForContext(
  store: WriterStore,
  context: ToolExecutionContext,
  extraCharacterIds: readonly number[] = [],
): RegisterRisk[] {
  if (context.registerRisks?.length) {
    const extra = collectRegisterRisksFromStore(store, extraCharacterIds);
    return mergeRegisterRisks([...context.registerRisks, ...extra]);
  }
  const ids = [
    ...(context.dialogueEvidenceCharacterIds ?? []),
    ...[...(context.characterEvidenceReads?.keys() ?? [])],
    ...(context.reviewCharacterIds ?? []),
    ...extraCharacterIds,
  ];
  return collectRegisterRisksFromStore(store, ids);
}

export function rememberRegisterRisks(
  context: ToolExecutionContext,
  risks: readonly RegisterRisk[],
): void {
  if (!risks.length) return;
  context.registerRisks = mergeRegisterRisks([...(context.registerRisks ?? []), ...risks]);
}

export function scanCardRegisterHits(
  text: string,
  risks: readonly RegisterRisk[],
): CardRegisterHit[] {
  if (!text || !risks.length) return [];
  const regions = splitDialogueAndNarration(text);
  const hits: CardRegisterHit[] = [];
  const occupied = new Set<string>();

  for (const risk of risks) {
    const term = risk.term;
    if (!term) continue;
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(term, from);
      if (index < 0) break;
      const end = index + term.length;
      from = end;
      // Skip matches that are clearly part of a longer CJK compound already claimed.
      const occKey = `${index}:${end}`;
      if (occupied.has(occKey)) continue;
      const region = regionAt(regions, index, end);
      if (!region) continue;
      if (risk.scope === "dialogue" && region.kind !== "dialogue") continue;
      if (risk.scope === "narration" && region.kind !== "narration") continue;
      // Formal report allowance: 报告/回报/确认 + term in same short clause → skip dialogue.
      if (region.kind === "dialogue" && looksLikeTechnicalReport(text, index, end)) continue;
      occupied.add(occKey);
      const sentence = sentenceAround(text, index, end);
      hits.push({
        term,
        characterId: risk.characterId,
        characterName: risk.characterName,
        source: risk.source,
        scope: risk.scope,
        region: region.kind,
        start: index,
        end,
        line: lineNumberAt(text, index),
        evidence: term,
        sentence,
        reason: risk.reason,
      });
      if (hits.length >= 40) return hits;
    }
  }
  return hits;
}

export function assessCardRegisterHits(hits: readonly CardRegisterHit[]): CardRegisterAssessment {
  const dialogueHits = hits.filter(hit => hit.region === "dialogue");
  const narrationHits = hits.filter(hit => hit.region === "narration");
  const uniqueDialogueTerms = [...new Set(dialogueHits.map(hit => hit.term))];
  const exampleDialogueHits = dialogueHits.filter(hit => hit.source === "voice_example");
  const competencyDialogueHits = dialogueHits.filter(hit => hit.source === "competency_name");

  let status: CardRegisterAssessment["status"] = "pass";
  let message: string | undefined;
  if (!hits.length) {
    return { hits: [], dialogueHits, narrationHits, uniqueDialogueTerms, status };
  }

  const block =
    uniqueDialogueTerms.length >= 2
    || dialogueHits.length >= 3
    || exampleDialogueHits.length >= 1 && exampleDialogueHits.some(hit => hit.term.length >= EXAMPLE_PHRASE_MIN)
    || competencyDialogueHits.length >= 2
    || (dialogueHits.length >= 1 && narrationHits.filter(hit => hit.source === "competency_name" || hit.source === "psychology_label").length >= 2);

  if (block) {
    status = "block";
    message = [
      "人设/设定措辞过密地进入对白或贴身叙述，尚未通过自然度门禁。",
      `对白命中 ${dialogueHits.length} 处（${uniqueDialogueTerms.slice(0, 6).join("、") || "—"}），叙述命中 ${narrationHits.length} 处。`,
      "保留事实与人物意图，把卡面术语/示例改写成当前人物会说、会感到的话；正式汇报与对方追问术语时除外。",
      "优先对 hit 的 sentence 做精确替换；对白密集时可用 revise-dialogue skill。",
    ].join("");
  } else {
    status = "warn";
    message = `检测到人设措辞进入正文 ${hits.length} 处（对白 ${dialogueHits.length}，叙述 ${narrationHits.length}）；请结合语境改写，勿把角色卡字段当默认用词。`;
  }

  return { hits: [...hits], dialogueHits, narrationHits, uniqueDialogueTerms, status, message };
}

export function cardRegisterGateError(assessment: CardRegisterAssessment): string | undefined {
  if (assessment.status !== "block" || !assessment.message) return undefined;
  const samples = assessment.dialogueHits.slice(0, 5).map(hit =>
    `L${hit.line}「${hit.term}」←${hit.characterName}/${hit.source}`);
  return `${assessment.message}${samples.length ? ` 例：${samples.join("；")}` : ""}`;
}

export function cardRegisterRepairPacket(
  text: string,
  assessment: CardRegisterAssessment,
  source?: { path?: string; sourceHash?: string },
): RepairPacket | undefined {
  if (assessment.status !== "block") return undefined;
  const issues = assessment.hits.slice(0, 20).map((hit, index) => {
    const oldText = uniqueSpan(text, hit.sentence) ? hit.sentence : undefined;
    return {
      id: `card_register:${hit.characterId}:${hit.term}:${index}`,
      kind: "card_register_hit",
      line: hit.line,
      ...(oldText ? { oldText } : {}),
      evidence: hit.evidence,
      suggestion: hit.region === "dialogue"
        ? "改成该角色此刻会说出口的自然说法，保留事实意图"
        : "改成可感知的动作/感觉/后果，勿直呼设定标签",
      problem: hit.reason,
      action: `替换命中「${hit.term}」的最小连续句，不改事件与信息序`,
      skillId: hit.region === "dialogue" ? "revise-dialogue" : "revise-generated-prose",
    };
  });
  return boundedRepairPacket({
    ...(source?.path ? { path: source.path } : {}),
    ...(source?.sourceHash ? { sourceHash: source.sourceHash } : {}),
    issueCount: assessment.hits.length,
    issues,
  });
}

export function formatRegisterRisksForWriter(risks: readonly RegisterRisk[]): string {
  if (!risks.length) return "";
  const lines = risks.slice(0, 24).map(risk =>
    `- ${risk.term}（${risk.characterName}/${risk.source}/${risk.scope}）：${risk.reason}`);
  return [
    "【慎用措辞·不得直出】",
    "下列词句来自本轮已读角色卡。它们是事实或声线线索，不是正文默认词表；普通对白与贴身叙述须换成本场自然说法，正式汇报或对方追问术语时除外。",
    ...lines,
  ].join("\n");
}

export function cardRegisterReportForTool(assessment: CardRegisterAssessment): Record<string, unknown> | undefined {
  if (!assessment.hits.length) return undefined;
  return {
    status: assessment.status,
    dialogueHits: assessment.dialogueHits.length,
    narrationHits: assessment.narrationHits.length,
    uniqueDialogueTerms: assessment.uniqueDialogueTerms.slice(0, 12),
    samples: assessment.hits.slice(0, 8).map(hit => ({
      term: hit.term,
      region: hit.region,
      line: hit.line,
      characterName: hit.characterName,
      source: hit.source,
      evidence: hit.sentence.slice(0, 120),
    })),
    ...(assessment.message ? { message: assessment.message } : {}),
  };
}

export function proseSignalsFromCardRegister(assessment: CardRegisterAssessment): Record<string, unknown> | undefined {
  if (!assessment.hits.length) return undefined;
  return {
    cardRegister: {
      status: assessment.status,
      dialogueHits: assessment.dialogueHits.length,
      narrationHits: assessment.narrationHits.length,
      terms: assessment.uniqueDialogueTerms.slice(0, 12),
      samples: assessment.hits.slice(0, 6).map(hit => ({
        term: hit.term,
        region: hit.region,
        evidence: hit.sentence.slice(0, 100),
        source: hit.source,
      })),
      guidance: "cardRegister 只定位候选泄漏；判 blocker 仍需引用 fullChapter 原文并说明语域不当。",
    },
  };
}

function normalizeRiskTerm(raw: string): string {
  return raw
    .replace(/\s+/gu, "")
    .replace(/^[「『“"'+]+|[」』”"'。！？；：、，]+$/gu, "")
    .trim();
}

function candidateTerms(raw: string): string[] {
  const text = normalizeRiskTerm(raw);
  if (!text) return [];
  const out = new Set<string>();
  // Prefer the whole field when it is already a short distinctive phrase.
  if (text.length >= MIN_TERM_CHARS && text.length <= MAX_TERM_CHARS) out.add(text);
  // Quoted fragments are high-value leakage candidates.
  for (const match of raw.matchAll(/[「『“"]([^」』”"]{2,16})[」』”"]/gu)) {
    const fragment = normalizeRiskTerm(match[1]);
    if (fragment.length >= MIN_TERM_CHARS && fragment.length <= MAX_TERM_CHARS) out.add(fragment);
  }
  // Longer descriptions: only keep mid-length CJK runs (3–8), never explode into
  // every 2-char bigram (that floods common words and false-blocks natural prose).
  if (text.length > MAX_TERM_CHARS) {
    for (const match of text.matchAll(/[\u4e00-\u9fff]{3,8}/gu)) {
      out.add(match[0]);
    }
  }
  return [...out];
}

function extractExamplePhrases(example: string): string[] {
  const cleaned = normalizeRiskTerm(example.replace(/[「」『』“”"]/gu, ""));
  if (cleaned.length < EXAMPLE_PHRASE_MIN) return [];
  if (cleaned.length <= MAX_TERM_CHARS) return [cleaned];
  // Prefer sentence-like chunks over the entire monologue.
  return cleaned
    .split(/[。！？；\n]/u)
    .map(part => normalizeRiskTerm(part))
    .filter(part => part.length >= EXAMPLE_PHRASE_MIN && part.length <= MAX_TERM_CHARS)
    .slice(0, 4);
}

function isUsableRiskTerm(term: string, protectedNames: ReadonlySet<string>): boolean {
  if (term.length < MIN_TERM_CHARS || term.length > MAX_TERM_CHARS) return false;
  if (STOP_TERMS.has(term)) return false;
  if (protectedNames.has(term)) return false;
  for (const name of protectedNames) {
    if (name && (name.includes(term) || term.includes(name)) && Math.abs(name.length - term.length) <= 1) {
      return false;
    }
  }
  // Pure digits / punctuation.
  if (!/[\u4e00-\u9fffA-Za-z]/u.test(term)) return false;
  // Very generic two-char verbs/nouns still leak through stop list; require some specificity:
  // allow 2-char only if not all common ending particles patterns.
  if (term.length === 2 && /[了着过的地得]$/u.test(term)) return false;
  return true;
}

type TextRegion = { kind: "dialogue" | "narration"; start: number; end: number };

function splitDialogueAndNarration(text: string): TextRegion[] {
  const regions: TextRegion[] = [];
  let cursor = 0;
  const re = /「([^」]*)」/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > cursor) regions.push({ kind: "narration", start: cursor, end: start });
    // Inner content only — quote marks themselves are not scored.
    regions.push({ kind: "dialogue", start: start + 1, end: end - 1 });
    cursor = end;
  }
  if (cursor < text.length) regions.push({ kind: "narration", start: cursor, end: text.length });
  return regions;
}

function regionAt(regions: readonly TextRegion[], start: number, end: number): TextRegion | undefined {
  return regions.find(region => start >= region.start && end <= region.end);
}

function looksLikeTechnicalReport(text: string, start: number, end: number): boolean {
  const windowStart = Math.max(0, start - 12);
  const window = text.slice(windowStart, Math.min(text.length, end + 8));
  return /(?:报告|汇报|回报|确认|读取|校准|对表|权限|编号|状态为)/u.test(window);
}

function sentenceAround(text: string, start: number, end: number): string {
  const left = Math.max(0, text.lastIndexOf("\n", start - 1) + 1, (() => {
    const marks = ["。", "！", "？", "；"];
    let best = 0;
    for (const mark of marks) {
      const index = text.lastIndexOf(mark, start - 1);
      if (index + 1 > best) best = index + 1;
    }
    return best;
  })());
  let right = text.length;
  for (const mark of ["。", "！", "？", "\n"]) {
    const index = text.indexOf(mark, end);
    if (index >= 0 && index + (mark === "\n" ? 0 : 1) < right) {
      right = index + (mark === "\n" ? 0 : 1);
    }
  }
  const sentence = text.slice(left, right).trim();
  return sentence.slice(0, 240) || text.slice(start, end);
}

function lineNumberAt(text: string, offset: number): number {
  return text.slice(0, offset).split(/\n/u).length;
}

function uniqueSpan(text: string, span: string): boolean {
  if (!span.trim()) return false;
  const first = text.indexOf(span);
  if (first < 0) return false;
  return text.indexOf(span, first + span.length) < 0;
}
