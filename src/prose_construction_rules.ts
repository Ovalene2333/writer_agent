/**
 * Declarative registry for high-recall sentence-construction candidates.
 *
 * A pattern match is never a semantic verdict. The registry supplies stable
 * generation guidance, candidate syntax, semantic-review criteria and density
 * policy; prose_quality locates candidates and prose_adjudicate decides meaning.
 * Add new constructions by appending a rule so prompt/cache order stays stable.
 */

export type ProseConstructionCandidateContext = {
  text: string;
  matchedText: string;
  start: number;
  end: number;
  sentence: string;
  sentenceStart: number;
  inQuote: boolean;
};

export type ProseConstructionClassification = {
  subtype: "abstract_reframing" | "split_redefinition" | "dialogue_correction" | "factual_exclusion";
  severity: "warning" | "info";
  confidence: number;
  reason: string;
  suggestions: string[];
};

export type ProseConstructionRule = {
  id: string;
  label: string;
  patterns: readonly RegExp[];
  generationGuidance: string;
  adjudicationGuidance: string;
  reviewAtCount: number;
  allowedOccurrences: (nonWhitespaceCharacters: number) => number;
  classify: (context: ProseConstructionCandidateContext) => ProseConstructionClassification;
};

export type ProseConstructionMatch = {
  rule: ProseConstructionRule;
  start: number;
  end: number;
  text: string;
};

const ABSTRACT_REFRAMING_WORDS = /(?:情绪|愤怒|恐惧|悲伤|不安|紧张|沉默|妥协|失败|成功|反抗|勇气|希望|绝望|灵魂|命运|意义|感觉|姿态|态度|选择|真相)/u;
const DIRECT_FACT_SUGGESTIONS = [
  "直接陈述真正成立的事实",
  "若确需纠正误解，让人物通过对白、观察过程或后续反应完成",
];

export const PROSE_CONSTRUCTION_RULES = [
  {
    id: "negation_redefinition",
    label: "否定—改判对照",
    patterns: [
      /(?:并)?不是[^\n。！？!?]{0,48}(?:(?:而|却|只)是|(?<!不)是)/gu,
      /(?:并)?不是[^\n。！？!?]{1,48}[。！？!?]\s*(?:(?:这|那|他|她|它|其|自己|真正|实际|反而|却|只)\s*)?是[^\n。！？!?]{1,48}(?:[。！？!?]|$)/gu,
      /并非[^\n。！？!?]{0,48}(?:而|却|只)?是/gu,
      /[^\n。！？!?]{1,64}[，,]\s*(?:并)?不是[^\n。！？!?]{1,32}(?:[。！？!?]|$)/gu,
    ],
    generationGuidance: "叙述不要反复用先否定后改判，或在成立事实后补一句否定标签来制造力度；优先让动作、感受或事实自行成立。必要的客观排除和人物即时纠错可以保留。",
    adjudicationGuidance: "判断候选是否在重新命名同一事实，或先写成立事实再追加“不是某种情绪/判断”的否定补注；人物即时纠错、必要客观排除及确有语境作用者 allow，轻微模板化者 warn，重复解释者 block。",
    reviewAtCount: 2,
    allowedOccurrences: characters => Math.max(1, Math.floor(characters / 5_000)),
    classify: context => {
      if (context.inQuote) {
        return {
          subtype: "dialogue_correction",
          severity: "info",
          confidence: 0.88,
          reason: "结构位于对白中，优先视为人物纠正事实或反驳误解，交由语义二审确认。",
          suggestions: [],
        };
      }
      const split = /[。！？!?]\s*(?:(?:这|那|他|她|它|其|自己|真正|实际|反而|却|只)\s*)?是/u.test(context.matchedText);
      if (split) {
        return {
          subtype: "split_redefinition",
          severity: "warning",
          confidence: 0.99,
          reason: "叙述者用句号拆开同一否定—肯定框架，需由语义二审判断是否形成重复重定义。",
          suggestions: DIRECT_FACT_SUGGESTIONS,
        };
      }
      const localPrefix = context.text.slice(context.sentenceStart, context.start + 8);
      if (/(?:这|那|这种|这一切|他的|她的)/u.test(localPrefix) || ABSTRACT_REFRAMING_WORDS.test(context.matchedText)) {
        return {
          subtype: "abstract_reframing",
          severity: "warning",
          confidence: 0.9,
          reason: "叙述者先否定表象再定义抽象意义，需由语义二审判断是否只是模板化重述。",
          suggestions: DIRECT_FACT_SUGGESTIONS,
        };
      }
      return {
        subtype: "factual_exclusion",
        severity: "warning",
        confidence: 0.92,
        reason: "叙述者使用否定—肯定框架排除事实，需由语义二审区分必要排除与重复句式。",
        suggestions: DIRECT_FACT_SUGGESTIONS,
      };
    },
  },
] as const satisfies readonly ProseConstructionRule[];

export type ProseConstructionRuleId = typeof PROSE_CONSTRUCTION_RULES[number]["id"];

export function proseConstructionRule(id: string | undefined): ProseConstructionRule | undefined {
  return PROSE_CONSTRUCTION_RULES.find(rule => rule.id === id);
}

export function findProseConstructionMatches(text: string): ProseConstructionMatch[] {
  const matches: ProseConstructionMatch[] = [];
  for (const rule of PROSE_CONSTRUCTION_RULES) {
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (matches.some(item => start < item.end && end > item.start)) continue;
        matches.push({ rule, start, end, text: match[0] });
      }
    }
  }
  return matches.sort((left, right) => left.start - right.start);
}

export function proseConstructionGenerationPrompt(): string {
  return PROSE_CONSTRUCTION_RULES.map(rule => `- ${rule.generationGuidance}`).join("\n");
}

export function proseConstructionAdjudicationPrompt(): string {
  return PROSE_CONSTRUCTION_RULES.map(rule => `- ${rule.id}（${rule.label}）：${rule.adjudicationGuidance}`).join("\n");
}

export function countProseConstructionMatches(text: string, ruleId: ProseConstructionRuleId): number {
  return findProseConstructionMatches(text).filter(match => match.rule.id === ruleId).length;
}
