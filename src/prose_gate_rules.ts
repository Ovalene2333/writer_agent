import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DocumentKind, WriterProject } from "./project.js";

export type ProseGateRuleSeverity = "block" | "warn";
export type ProseGateRuleKind = "hard_gate" | "style_preference";
export type ProseGateTargetKind = DocumentKind | "writing_example";

export interface ProseGateRule {
  id: string;
  /** User-facing name; IDs remain stable machine keys. */
  label: string;
  instruction: string;
  /** Goal for a local repair, not replacement prose. */
  revisionIntent: string;
  kind: ProseGateRuleKind;
  severity: ProseGateRuleSeverity;
  enabled: boolean;
  builtIn: boolean;
  /** Empty means every prose target; otherwise the rule only reviews these kinds. */
  documentKinds: ProseGateTargetKind[];
  /** Empty means every path; writing examples have no path and only match empty prefixes. */
  pathPrefixes: string[];
  sourceFeedback: string;
  createdAt: string;
  updatedAt: string;
}

export const BUILT_IN_PROSE_GATE_RULES: readonly ProseGateRule[] = [
  {
    id: "quoted-text-count-consistency",
    label: "引号文字数量一致性",
    instruction: "正文用“这几个字/这N个字/几个字”等方式描述引号内文字数量时，必须按实际书写单位核对数量；数量与引号内文字不一致即违规。不要把标点计入字数。",
    revisionIntent: "只修正数量描述，使其与引号内实际书写单位一致，不改动引文内容和无关正文。",
    kind: "hard_gate",
    severity: "block",
    enabled: true,
    builtIn: true,
    documentKinds: ["chapter", "side", "writing_example"],
    pathPrefixes: [],
    sourceFeedback: "作者反馈：类似“xxxx”——这三个字的数量描述容易写错，必须复审。",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  },
  {
    id: "telegraphic-object-beats",
    label: "电报式物件短拍",
    instruction: "复审正文（叙述和对白）的缩句生成味。以下任一情况违规：同一段或相邻段反复把物件/环境名词加一个裸动作或状态切成独立节拍，以机械播报代替人物感知、反应、因果或局面变化；省略动作的施事、受事、对象等必要成分后，无法从紧邻上下文唯一还原；对白把后台字段、状态栏或提纲压成“名词短语＋状态”的汇报腔，词语关系含混，或不能自然承接对方的问题。不要因为句子短、没有宾语或使用汉语零形回指就单独判错；不及物句、偶发重音、紧张高潮，以及人物身份、问答关系与近邻语境足以自然补全的口语省略应放行。连续命中时 evidence 引用能呈现该模式的最短连续原文。",
    revisionIntent: "恢复可理解的人物感知、动作关系或因果承接；合并机械短拍，但保留紧张处重音和自然口语省略。",
    kind: "hard_gate",
    severity: "block",
    enabled: true,
    builtIn: true,
    documentKinds: ["chapter", "side", "writing_example"],
    pathPrefixes: [],
    sourceFeedback: "作者反馈：限制“手机又震”“车出隧道”“雨刷继续响”式连续物件短拍，以及无法由近邻语境还原必要成分的缩句。",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  },
  {
    id: "characterization-proof-stacking",
    label: "人物特质堆叠证明",
    instruction: "逐段复审人物塑造是否在相邻一至三句中，连续用多个高光成绩或机敏动作、群体围观认可、无具体身份和目的的旁人点题对白，反复证明同一个人物特质。只有后续项没有引入新的阻力、后果、关系行动或必要事实，而主要在为同一标签加码时才违规。每项行动确实改变不同条件、人物互动有独立目的、作品明确需要简短概述或蒙太奇时应放行。命中时 evidence 引用能呈现“行动证明→外部背书→点题定性”的最短连续二至四句，不得只摘一个普通句式。",
    revisionIntent: "保留一处最能改变现场的具体选择及其后果；删除重复的高光罗列、群体背书或点题定性，必要设定应落到有身份和目的的人物互动。",
    kind: "hard_gate",
    severity: "block",
    enabled: true,
    builtIn: true,
    documentKinds: ["chapter", "side", "writing_example"],
    pathPrefixes: [],
    sourceFeedback: "作者反馈：连续用能力展示、群体认可和路人点题对白为同一人物标签盖章，会形成履历式、宣传文案式生成感。",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  },
  {
    id: "manufactured-precision-staccato",
    label: "精确信息断拍重音",
    instruction: "复审相邻句是否用极短句强行断拍，再紧接次数、时间、签字、名单或其他高确定性细节，把普通信息包装成冷峻、悬疑、权威或影视化揭示。包括语法完整的短喝止后立刻抛出精确指控，以及名词短语后另起一句追加精度标签；不能因单句语法完整就自动放行。只有这组断拍主要在摆姿态或制造重音，没有体现人物特有声线、现场反应、信息阻力或行动变化时才违规。不得仅因句子短、出现数字或省略成分判错；自然问答、紧急指令、确实影响判断与行动的精确信息及偶发重音应放行。evidence 引用能证明该节拍的最短完整相邻句组。",
    revisionIntent: "保留必要事实和精度，恢复自然的对白、动作或叙述承接；只调整命中句组，不删除无关事实或全文改写。",
    kind: "style_preference",
    severity: "warn",
    enabled: true,
    builtIn: true,
    documentKinds: ["chapter", "side", "writing_example"],
    pathPrefixes: [],
    sourceFeedback: "作者反馈：“别装。你昨晚把行李单改了三遍。”与“一份他签过字的护航名单。精确到分钟。”这类短句断拍加精确信息重锤的表达生成感过重。",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  },
];

/** Built-ins grow independently without reducing the long-standing project-rule capacity. */
export const PROSE_GATE_PROJECT_RULE_CAPACITY = 19;
export const MAX_PROSE_GATE_RULES = PROSE_GATE_PROJECT_RULE_CAPACITY + BUILT_IN_PROSE_GATE_RULES.length;

function rulesPath(project: WriterProject): string {
  return resolve(project.privateDir, "prose-gates.json");
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 不能为空`);
  return value.trim().slice(0, max);
}

function normalizeId(value: unknown): string {
  const id = boundedText(value, "id", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(id)) throw new Error("id 只能使用小写字母、数字、_、-");
  return id;
}

const TARGET_KINDS = new Set<ProseGateTargetKind>([
  "lore", "outline", "chapter", "archive", "side", "other", "writing_example",
]);

function normalizeTargetKinds(value: unknown): ProseGateTargetKind[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is ProseGateTargetKind =>
    typeof item === "string" && TARGET_KINDS.has(item as ProseGateTargetKind)))].slice(0, TARGET_KINDS.size);
}

function normalizePathPrefixes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(Boolean))].slice(0, 12);
}

function normalizeRule(value: unknown, fallbackCreatedAt?: string): ProseGateRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("规则必须是对象");
  const item = value as Record<string, unknown>;
  const now = new Date().toISOString();
  const severity: ProseGateRuleSeverity = item.severity === "warn" ? "warn" : "block";
  const kind: ProseGateRuleKind = item.kind === "style_preference"
    ? "style_preference"
    : item.kind === "hard_gate"
      ? "hard_gate"
      : severity === "warn" ? "style_preference" : "hard_gate";
  return {
    id: normalizeId(item.id),
    label: typeof item.label === "string" && item.label.trim()
      ? item.label.trim().slice(0, 60)
      : normalizeId(item.id),
    instruction: boundedText(item.instruction, "instruction", 500),
    revisionIntent: typeof item.revisionIntent === "string"
      ? item.revisionIntent.trim().slice(0, 240)
      : "",
    kind,
    severity,
    enabled: item.enabled !== false,
    builtIn: false,
    documentKinds: normalizeTargetKinds(item.documentKinds),
    pathPrefixes: normalizePathPrefixes(item.pathPrefixes),
    sourceFeedback: typeof item.sourceFeedback === "string" ? item.sourceFeedback.trim().slice(0, 500) : "",
    createdAt: typeof item.createdAt === "string" && item.createdAt ? item.createdAt : fallbackCreatedAt ?? now,
    updatedAt: typeof item.updatedAt === "string" && item.updatedAt ? item.updatedAt : now,
  };
}

export function loadProseGateRules(project: WriterProject): ProseGateRule[] {
  const path = rulesPath(project);
  if (!existsSync(path)) return BUILT_IN_PROSE_GATE_RULES.map(rule => ({ ...rule }));
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(".writer/prose-gates.json 格式无效"); }
  if (!Array.isArray(parsed)) throw new Error(".writer/prose-gates.json 必须是规则数组");
  const saved = parsed.slice(0, MAX_PROSE_GATE_RULES).map(item => {
    const rule = normalizeRule(item);
    const builtIn = BUILT_IN_PROSE_GATE_RULES.find(candidate => candidate.id === rule.id);
    if (builtIn && item && typeof item === "object" && !Array.isArray(item)) {
      const raw = item as Record<string, unknown>;
      rule.builtIn = true;
      if (!("label" in raw)) rule.label = builtIn.label;
      if (!("revisionIntent" in raw)) rule.revisionIntent = builtIn.revisionIntent;
      if (!("documentKinds" in raw)) rule.documentKinds = [...builtIn.documentKinds];
      if (!("pathPrefixes" in raw)) rule.pathPrefixes = [...builtIn.pathPrefixes];
    }
    return rule;
  });
  const merged = new Map(BUILT_IN_PROSE_GATE_RULES.map(rule => [rule.id, { ...rule }]));
  for (const rule of saved) merged.set(rule.id, rule);
  return [...merged.values()].slice(0, MAX_PROSE_GATE_RULES);
}

function saveProseGateRules(project: WriterProject, rules: ProseGateRule[]): void {
  const target = rulesPath(project);
  const temporary = `${target}.writer-tmp-${process.pid}`;
  const content = `${JSON.stringify(rules.slice(0, MAX_PROSE_GATE_RULES), null, 2)}\n`;
  writeFileSync(temporary, content, "utf8");
  try { renameSync(temporary, target); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
    writeFileSync(target, content, "utf8");
    try { unlinkSync(temporary); } catch { /* 后续保存会覆盖临时文件。 */ }
  }
}

export function upsertProseGateRule(
  project: WriterProject,
  input: Pick<ProseGateRule, "id" | "instruction"> & Partial<Pick<ProseGateRule,
    "label" | "revisionIntent" | "kind" | "severity" | "enabled" | "documentKinds" | "pathPrefixes" | "sourceFeedback">>,
): ProseGateRule {
  const rules = loadProseGateRules(project);
  const id = normalizeId(input.id);
  const existing = rules.find(rule => rule.id === id);
  const now = new Date().toISOString();
  const supplied = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const rule = normalizeRule({
    ...existing,
    ...supplied,
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }, existing?.createdAt);
  if (BUILT_IN_PROSE_GATE_RULES.some(item => item.id === id)) rule.builtIn = true;
  if (existing) rules[rules.indexOf(existing)] = rule;
  else {
    if (rules.length >= MAX_PROSE_GATE_RULES) throw new Error(`复审规则最多 ${MAX_PROSE_GATE_RULES} 条（含 ${BUILT_IN_PROSE_GATE_RULES.length} 条内置规则）；请先停用或删除旧规则`);
    rules.push(rule);
  }
  saveProseGateRules(project, rules);
  return rule;
}

export function proseGateRulesForTarget(
  rules: ProseGateRule[],
  target: { kind: ProseGateTargetKind; path?: string },
): ProseGateRule[] {
  const normalizedPath = target.path?.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return rules.filter(rule => {
    if (!rule.enabled) return false;
    if (rule.documentKinds.length && !rule.documentKinds.includes(target.kind)) return false;
    if (!rule.pathPrefixes.length) return true;
    if (!normalizedPath) return false;
    return rule.pathPrefixes.some(prefix => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`));
  });
}

export function removeProseGateRule(project: WriterProject, idValue: unknown): boolean {
  const id = normalizeId(idValue);
  const rules = loadProseGateRules(project);
  const next = rules.filter(rule => rule.id !== id);
  if (next.length === rules.length) return false;
  saveProseGateRules(project, next);
  return true;
}

export function setProseGateRuleEnabled(project: WriterProject, idValue: unknown, enabled: boolean): ProseGateRule {
  const id = normalizeId(idValue);
  const rules = loadProseGateRules(project);
  const rule = rules.find(item => item.id === id);
  if (!rule) throw new Error(`复审规则不存在：${id}`);
  rule.enabled = enabled;
  rule.updatedAt = new Date().toISOString();
  saveProseGateRules(project, rules);
  return rule;
}
