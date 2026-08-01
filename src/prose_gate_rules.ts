import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DocumentKind, WriterProject } from "./project.js";

export type ProseGateRuleSeverity = "block" | "warn";
export type ProseGateRuleKind = "hard_gate" | "style_preference";
export type ProseGateTargetKind = DocumentKind | "writing_example";

export interface ProseGateRule {
  id: string;
  instruction: string;
  kind: ProseGateRuleKind;
  severity: ProseGateRuleSeverity;
  enabled: boolean;
  /** Empty means every prose target; otherwise the rule only reviews these kinds. */
  documentKinds: ProseGateTargetKind[];
  /** Empty means every path; writing examples have no path and only match empty prefixes. */
  pathPrefixes: string[];
  sourceFeedback: string;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_RULES: readonly ProseGateRule[] = [
  {
    id: "quoted-text-count-consistency",
    instruction: "正文用“这几个字/这N个字/几个字”等方式描述引号内文字数量时，必须按实际书写单位核对数量；数量与引号内文字不一致即违规。不要把标点计入字数。",
    kind: "hard_gate",
    severity: "block",
    enabled: true,
    documentKinds: ["chapter", "side", "writing_example"],
    pathPrefixes: [],
    sourceFeedback: "作者反馈：类似“xxxx”——这三个字的数量描述容易写错，必须复审。",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  },
  {
    id: "telegraphic-object-beats",
    instruction: "复审正文（叙述和对白）的缩句生成味。以下任一情况违规：同一段或相邻段反复把物件/环境名词加一个裸动作或状态切成独立节拍，以机械播报代替人物感知、反应、因果或局面变化；省略动作的施事、受事、对象等必要成分后，无法从紧邻上下文唯一还原；对白把后台字段、状态栏或提纲压成“名词短语＋状态”的汇报腔，词语关系含混，或不能自然承接对方的问题。不要因为句子短、没有宾语或使用汉语零形回指就单独判错；不及物句、偶发重音、紧张高潮，以及人物身份、问答关系与近邻语境足以自然补全的口语省略应放行。连续命中时 evidence 引用能呈现该模式的最短连续原文。",
    kind: "hard_gate",
    severity: "block",
    enabled: true,
    documentKinds: ["chapter", "side", "writing_example"],
    pathPrefixes: [],
    sourceFeedback: "作者反馈：限制“手机又震”“车出隧道”“雨刷继续响”式连续物件短拍，以及无法由近邻语境还原必要成分的缩句。",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  },
];

// The original capacity was one built-in + 19 project rules. Adding another
// built-in must not evict the last rule from an existing full project file.
const MAX_RULES = 21;

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
    instruction: boundedText(item.instruction, "instruction", 500),
    kind,
    severity,
    enabled: item.enabled !== false,
    documentKinds: normalizeTargetKinds(item.documentKinds),
    pathPrefixes: normalizePathPrefixes(item.pathPrefixes),
    sourceFeedback: typeof item.sourceFeedback === "string" ? item.sourceFeedback.trim().slice(0, 500) : "",
    createdAt: typeof item.createdAt === "string" && item.createdAt ? item.createdAt : fallbackCreatedAt ?? now,
    updatedAt: typeof item.updatedAt === "string" && item.updatedAt ? item.updatedAt : now,
  };
}

export function loadProseGateRules(project: WriterProject): ProseGateRule[] {
  const path = rulesPath(project);
  if (!existsSync(path)) return DEFAULT_RULES.map(rule => ({ ...rule }));
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(".writer/prose-gates.json 格式无效"); }
  if (!Array.isArray(parsed)) throw new Error(".writer/prose-gates.json 必须是规则数组");
  const saved = parsed.slice(0, MAX_RULES).map(item => {
    const rule = normalizeRule(item);
    const builtIn = DEFAULT_RULES.find(candidate => candidate.id === rule.id);
    if (builtIn && item && typeof item === "object" && !Array.isArray(item)) {
      const raw = item as Record<string, unknown>;
      if (!("documentKinds" in raw)) rule.documentKinds = [...builtIn.documentKinds];
      if (!("pathPrefixes" in raw)) rule.pathPrefixes = [...builtIn.pathPrefixes];
    }
    return rule;
  });
  const merged = new Map(DEFAULT_RULES.map(rule => [rule.id, { ...rule }]));
  for (const rule of saved) merged.set(rule.id, rule);
  return [...merged.values()].slice(0, MAX_RULES);
}

function saveProseGateRules(project: WriterProject, rules: ProseGateRule[]): void {
  const target = rulesPath(project);
  const temporary = `${target}.writer-tmp-${process.pid}`;
  const content = `${JSON.stringify(rules.slice(0, MAX_RULES), null, 2)}\n`;
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
    "kind" | "severity" | "enabled" | "documentKinds" | "pathPrefixes" | "sourceFeedback">>,
): ProseGateRule {
  const rules = loadProseGateRules(project);
  const id = normalizeId(input.id);
  const existing = rules.find(rule => rule.id === id);
  const now = new Date().toISOString();
  const rule = normalizeRule({
    ...existing,
    ...input,
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }, existing?.createdAt);
  if (existing) rules[rules.indexOf(existing)] = rule;
  else {
    if (rules.length >= MAX_RULES) throw new Error(`复审规则最多 ${MAX_RULES} 条；请先停用或删除旧规则`);
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
