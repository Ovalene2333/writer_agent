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
  subtype: "narrator_redefinition" | "abstract_reframing" | "split_redefinition" | "dialogue_correction" | "factual_exclusion";
  severity: "warning" | "info";
  confidence: number;
  reason: string;
  suggestions: string[];
};

export type ProseConstructionRule = {
  id: string;
  label: string;
  familyId: string;
  patterns: readonly RegExp[];
  generationGuidance: string;
  adjudicationGuidance: string;
  /** Narration forms that remain revision-required even when locally defensible. */
  revisionRequiredSubtypes: readonly ProseConstructionClassification["subtype"][];
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
  "保留原句的节奏、意象和信息落点，改用动作、感受、视线变化或结果自然显出真正成立的事实",
  "允许重组命中句及紧邻一句来维持文气；不要压成生硬的说明句，也不要扩大改写范围",
];

export const PROSE_CONSTRUCTION_RULES = [
  {
    id: "negation_redefinition",
    label: "否定—改判对照",
    familyId: "negation_redefinition",
    patterns: [
      /(?:并)?不是[^\n。！？!?]{0,48}(?:(?:而|却|只)是|(?<!不)是)/gu,
      /(?:并)?不是[^\n。！？!?]{1,48}[。！？!?]\s*(?:(?:这|那|他|她|它|其|自己|真正|实际|反而|却|只)\s*)?是[^\n。！？!?]{1,48}(?:[。！？!?]|$)/gu,
      /并非[^\n。！？!?]{0,48}(?:而|却|只)?是/gu,
      /[^\n。！？!?]{1,64}[，,]\s*(?:并)?不是[^\n。！？!?]{1,32}(?:[。！？!?]|$)/gu,
      /[^\n。！？!?]{1,64}的不是[^\n。！？!?，,；;：:]{1,32}[。！？!?](?:[ \t]*\r?\n)+[ \t]*(?:(?:一个|一名|一位|这|那|他|她|它|对方|来人|女人|男人|老人|年轻人)[^\n。！？!?]{1,96}(?:[。！？!?]|$))/gu,
      /与其(?:说)?[^\n。！？!?]{1,48}不如(?:说)?[^\n。！？!?]{1,48}(?:[。！？!?]|$)/gu,
      /不在于[^\n。！？!?]{1,48}而在于[^\n。！？!?]{1,48}(?:[。！？!?]|$)/gu,
      /(?:不能|算不上|谈不上|称不上)[^\n。！？!?]{1,40}(?:只是|不过是|更像)[^\n。！？!?]{1,48}(?:[。！？!?]|$)/gu,
      /^\s*不是[^\n。！？!?，,；;：:]{1,32}[。！？!?](?=\s*(?![“「『"])[^\n。！？!?]{1,80})/gmu,
    ],
    generationGuidance: "叙述不要用先否定后改判（包括「不是……是/而是……」、拆句变体，以及前段否定身份后由下一段人物出场隐式补全“而是”的变体），或在成立事实后补一句否定标签制造力度；语义递进和语义诠释也应让动作、感受、视线变化或结果自然显出。人物对白中的即时纠错可以保留，但仍占句式家族额度。修订时保留原有节奏、意象和信息落点，可重组命中句及紧邻一句，避免压成生硬说明句。",
    adjudicationGuidance: "判断候选是否以否定—改判骨架完成语义递进、重新命名、感受诠释，或把“而是”的替代项藏到下一句、下一段人物出场中。叙述中的 split_redefinition 与 abstract_reframing 必须 block：局部事实成立、比喻自然或确有语境作用都不能作为 allow 理由，因为应改由动作、感受、视线变化或结果承载。真实人物对白中的即时纠错可结合声线 allow；纯引用、代码或元数据标记为不计数。其他必要事实排除从严判断。语义 verdict 与句式家族计数彼此独立。",
    revisionRequiredSubtypes: ["narrator_redefinition", "split_redefinition", "abstract_reframing"],
    reviewAtCount: 2,
    allowedOccurrences: characters => Math.max(1, Math.floor((characters * 4) / 10_000)),
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
      const split = /[。！？!?]\s*(?:(?:这|那|他|她|它|其|自己|真正|实际|反而|却|只)\s*)?是/u.test(context.matchedText)
        || /的不是[^\n。！？!?]{1,32}[。！？!?](?:[ \t]*\r?\n)+/u.test(context.matchedText);
      if (split) {
        return {
          subtype: "split_redefinition",
          severity: "warning",
          confidence: 0.99,
          reason: "叙述者把同一否定—替代框架拆到后句或后段，显式或隐式补全“而是”的落点。",
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
      const pairedReplacement = /不是[^\n。！？!?]{0,48}(?:(?:而|却|只)是|(?<!不)是)/u.test(context.matchedText);
      const standaloneDenial = /^\s*不是[^\n。！？!?，,；;：:]{1,32}[。！？!?]\s*$/u.test(context.matchedText);
      if (pairedReplacement || standaloneDenial) {
        return {
          subtype: "narrator_redefinition",
          severity: "warning",
          confidence: pairedReplacement ? 0.98 : 0.94,
          reason: pairedReplacement
            ? "叙述者先否定一种表述再给出替代定义，事实内容不同不改变其共同的改判功能。"
            : "叙述者把否定独立成句，并由后续叙述完成隐式揭示，属于跨句改判骨架。",
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
  {
    id: "absence_replacement",
    label: "缺失—替代对照",
    familyId: "absence_replacement",
    patterns: [
      /没有[^\n。！？!?]{1,48}(?:只有|而是|只是|不过是|更像)[^\n。！？!?]{1,48}(?:[。！？!?]|$)/gu,
    ],
    generationGuidance: "“没有A，只有/只是/不过是/更像B”属于独立的缺失—替代家族，不与“不是A而是B”混算。叙述若借此解释情绪、意义或姿态，应改由可观察细节自然落地；必要的物件盘点、事实缺失和动作替代可保留。修订时保留节奏与信息落点，避免机械换词。",
    adjudicationGuidance: "判断“没有A，只有/只是/不过是/更像B”是在陈述必要缺失与替代事实，还是借否定预期解释人物情绪、姿态或意义。后者作为 abstract_reframing 必须 block；前者可结合上下文 allow。此家族独立计数，不并入 negation_redefinition。",
    revisionRequiredSubtypes: ["abstract_reframing"],
    reviewAtCount: 2,
    allowedOccurrences: characters => Math.max(1, Math.floor((characters * 4) / 10_000)),
    classify: context => {
      if (context.inQuote) {
        return {
          subtype: "dialogue_correction",
          severity: "info",
          confidence: 0.84,
          reason: "结构位于对白中，交由语义二审判断是人物化表达还是模板化对照。",
          suggestions: [],
        };
      }
      const localPrefix = context.text.slice(context.sentenceStart, context.start + 8);
      if (/(?:这|那|这种|这一切|他的|她的)/u.test(localPrefix) || ABSTRACT_REFRAMING_WORDS.test(context.matchedText)) {
        return {
          subtype: "abstract_reframing",
          severity: "warning",
          confidence: 0.9,
          reason: "叙述者先否定预期感受、姿态或意义，再用后项作解释性替代。",
          suggestions: DIRECT_FACT_SUGGESTIONS,
        };
      }
      return {
        subtype: "factual_exclusion",
        severity: "warning",
        confidence: 0.86,
        reason: "句子陈述缺失与替代事实，交由语义二审判断是否必要。",
        suggestions: DIRECT_FACT_SUGGESTIONS,
      };
    },
  },
] as const satisfies readonly ProseConstructionRule[];

export type ProseConstructionRuleId = typeof PROSE_CONSTRUCTION_RULES[number]["id"];

export function proseConstructionRule(id: string | undefined): ProseConstructionRule | undefined {
  return PROSE_CONSTRUCTION_RULES.find(rule => rule.id === id);
}

export function proseConstructionRequiresRevision(ruleId: string | undefined, subtype: string): boolean {
  const rule = proseConstructionRule(ruleId);
  return Boolean(rule?.revisionRequiredSubtypes.includes(subtype as ProseConstructionClassification["subtype"]));
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

export function negationRedefinitionGenerationGuidance(): string {
  return proseConstructionRule("negation_redefinition")!.generationGuidance;
}

export function proseConstructionAdjudicationPrompt(): string {
  return PROSE_CONSTRUCTION_RULES.map(rule => `- ${rule.id}（${rule.label}）：${rule.adjudicationGuidance}`).join("\n");
}

export function countProseConstructionMatches(text: string, ruleId: ProseConstructionRuleId): number {
  return findProseConstructionMatches(text).filter(match => match.rule.id === ruleId).length;
}
