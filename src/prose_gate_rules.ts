import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WriterProject } from "./project.js";

export type ProseGateRuleSeverity = "block" | "warn";

export interface ProseGateRule {
  id: string;
  instruction: string;
  severity: ProseGateRuleSeverity;
  enabled: boolean;
  sourceFeedback: string;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_RULES: readonly ProseGateRule[] = [{
  id: "quoted-text-count-consistency",
  instruction: "正文用“这几个字/这N个字/几个字”等方式描述引号内文字数量时，必须按实际书写单位核对数量；数量与引号内文字不一致即违规。不要把标点计入字数。",
  severity: "block",
  enabled: true,
  sourceFeedback: "作者反馈：类似“xxxx”——这三个字的数量描述容易写错，必须复审。",
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
}];

const MAX_RULES = 20;

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

function normalizeRule(value: unknown, fallbackCreatedAt?: string): ProseGateRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("规则必须是对象");
  const item = value as Record<string, unknown>;
  const now = new Date().toISOString();
  return {
    id: normalizeId(item.id),
    instruction: boundedText(item.instruction, "instruction", 500),
    severity: item.severity === "warn" ? "warn" : "block",
    enabled: item.enabled !== false,
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
  return parsed.slice(0, MAX_RULES).map(item => normalizeRule(item));
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
  input: Pick<ProseGateRule, "id" | "instruction"> & Partial<Pick<ProseGateRule, "severity" | "enabled" | "sourceFeedback">>,
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
