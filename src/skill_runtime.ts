import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import type { DocumentKind, WriterProject } from "./project.js";

export type SkillKind = "workflow" | "voice" | "review" | "knowledge";
export type SkillStatus = "draft" | "trial" | "active" | "paused" | "deprecated";
export type SkillCapability = "plan" | "write" | "review" | "revise" | "audit";

export interface SkillManifest {
  schemaVersion: 1;
  version: number;
  kind: SkillKind;
  status: SkillStatus;
  capabilities: SkillCapability[];
  documentKinds: DocumentKind[];
  characterIds: string[];
  policyIds: string[];
  priority: number;
}

export interface ProjectSkillResource {
  path: string;
  kind: "reference" | "script" | "asset" | "other";
  characters: number;
  sourceHash: string;
}

export interface ProjectSkill {
  id: string;
  /** Standard Agent Skills name. Legacy skills fall back to their directory id. */
  name: string;
  description: string;
  path: string;
  body: string;
  manifest: SkillManifest;
  resources: ProjectSkillResource[];
  validationErrors: string[];
  source: "project" | "agents" | "builtin";
  root: string;
}

export interface SkillRouteInput {
  capability: SkillCapability;
  documentKind?: DocumentKind;
  characterIds?: string[];
  policyIds?: string[];
  explicitSkillIds?: string[];
}

export interface SkillRouteResult {
  required: ProjectSkill[];
  candidates: ProjectSkill[];
  excluded: Array<{ id: string; reason: string }>;
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const BUILTIN_SKILLS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const MANIFEST_KINDS = new Set<SkillKind>(["workflow", "voice", "review", "knowledge"]);
const MANIFEST_STATUSES = new Set<SkillStatus>(["draft", "trial", "active", "paused", "deprecated"]);
const MANIFEST_CAPABILITIES = new Set<SkillCapability>(["plan", "write", "review", "revise", "audit"]);
const DOCUMENT_KINDS = new Set<DocumentKind>(["chapter", "side", "lore", "outline", "archive", "other"]);

function defaultManifest(): SkillManifest {
  return {
    schemaVersion: 1,
    version: 1,
    kind: "workflow",
    status: "active",
    capabilities: ["plan", "write", "review", "revise", "audit"],
    documentKinds: [],
    characterIds: [],
    policyIds: [],
    priority: 50,
  };
}

function uniqueStrings(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap(item => typeof item === "string" && item.trim() ? [item.trim()] : []))]
    .slice(0, maximum);
}

function parseManifest(root: string, errors: string[]): SkillManifest {
  const path = join(root, "skill.json");
  if (!existsSync(path)) return defaultManifest();
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch {
    errors.push("skill.json 不是有效 JSON");
    return defaultManifest();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("skill.json 必须是对象");
    return defaultManifest();
  }
  const item = value as Record<string, unknown>;
  const base = defaultManifest();
  const kind = typeof item.kind === "string" && MANIFEST_KINDS.has(item.kind as SkillKind)
    ? item.kind as SkillKind : base.kind;
  const status = typeof item.status === "string" && MANIFEST_STATUSES.has(item.status as SkillStatus)
    ? item.status as SkillStatus : base.status;
  const capabilities = uniqueStrings(item.capabilities, 8)
    .filter((entry): entry is SkillCapability => MANIFEST_CAPABILITIES.has(entry as SkillCapability));
  const documentKinds = uniqueStrings(item.documentKinds, 12)
    .filter((entry): entry is DocumentKind => DOCUMENT_KINDS.has(entry as DocumentKind));
  const version = Number.isInteger(item.version) && Number(item.version) > 0
    ? Math.min(999_999, Number(item.version)) : base.version;
  const priority = Number.isFinite(Number(item.priority))
    ? Math.max(0, Math.min(100, Math.round(Number(item.priority)))) : base.priority;
  if (item.schemaVersion !== undefined && item.schemaVersion !== 1) errors.push("skill.json schemaVersion 仅支持 1");
  if (item.kind !== undefined && kind === base.kind && item.kind !== base.kind) errors.push("skill.json kind 无效");
  if (item.status !== undefined && status === base.status && item.status !== base.status) errors.push("skill.json status 无效");
  return {
    schemaVersion: 1,
    version,
    kind,
    status,
    capabilities: capabilities.length ? capabilities : base.capabilities,
    documentKinds,
    characterIds: uniqueStrings(item.characterIds, 100),
    policyIds: uniqueStrings(item.policyIds, 100),
    priority,
  };
}

function parseSkillMarkdown(raw: string, directoryId: string): {
  name: string;
  description: string;
  body: string;
  errors: string[];
} {
  const errors: string[] = [];
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) {
    const legacyDescription = trimmed.split(/\r?\n/u)
      .find(line => line.trim() && !line.startsWith("#"))?.trim().slice(0, 1024) ?? "";
    errors.push("缺少 YAML frontmatter；当前按旧格式兼容读取");
    return { name: directoryId, description: legacyDescription, body: trimmed, errors };
  }
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) {
    errors.push("YAML frontmatter 没有结束标记");
    return { name: directoryId, description: "", body: trimmed, errors };
  }
  const frontmatter = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).trim();
  const document = parseDocument(frontmatter, { uniqueKeys: true });
  if (document.errors.length) errors.push(...document.errors.map(error => `YAML：${error.message.slice(0, 180)}`));
  const value = document.toJS() as unknown;
  const fields = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const declaredName = typeof fields.name === "string" ? fields.name.trim() : "";
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!declaredName) errors.push("frontmatter 缺少 name");
  if (declaredName && !SKILL_NAME.test(declaredName)) errors.push("name 必须是小写字母、数字和单连字符");
  if (declaredName && declaredName !== directoryId) errors.push(`name 必须与目录名一致（${directoryId}）`);
  if (!description) errors.push("frontmatter 缺少 description");
  if (description.length > 1024) errors.push("description 不能超过 1024 字符");
  if (!body) errors.push("SKILL.md 正文不能为空");
  return {
    name: declaredName && SKILL_NAME.test(declaredName) ? declaredName : directoryId,
    description: description.slice(0, 1024),
    body,
    errors,
  };
}

function resourceKind(path: string): ProjectSkillResource["kind"] {
  const top = path.split("/")[0];
  if (top === "references") return "reference";
  if (top === "scripts") return "script";
  if (top === "assets") return "asset";
  return "other";
}

function listResources(root: string): ProjectSkillResource[] {
  const resources: ProjectSkillResource[] = [];
  for (const directory of ["references", "scripts", "assets"]) {
    const absolute = join(root, directory);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = join(absolute, entry.name);
      if (lstatSync(file).isSymbolicLink()) continue;
      const content = readFileSync(file);
      resources.push({
        path: `${directory}/${entry.name}`,
        kind: resourceKind(directory),
        characters: content.toString("utf8").length,
        sourceHash: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  return resources.sort((left, right) => left.path.localeCompare(right.path));
}

function skillRoots(project: WriterProject): Array<{ root: string; source: ProjectSkill["source"] }> {
  return [
    { root: resolve(project.root, ".writer", "skills"), source: "project" },
    { root: resolve(project.root, ".agents", "skills"), source: "agents" },
    { root: BUILTIN_SKILLS_ROOT, source: "builtin" },
  ];
}

/** Scan standard skill folders; project folders override .agents and built-ins by id. */
export function listProjectSkills(project: WriterProject): ProjectSkill[] {
  const skills: ProjectSkill[] = [];
  const seen = new Set<string>();
  for (const location of skillRoots(project)) {
    if (!existsSync(location.root)) continue;
    let entries: string[];
    try { entries = readdirSync(location.root); }
    catch { continue; }
    for (const entry of entries) {
      const directory = join(location.root, entry);
      const standardFile = join(directory, "SKILL.md");
      const flatFile = entry.toLowerCase().endsWith(".md") ? join(location.root, entry) : "";
      const file = existsSync(standardFile) ? standardFile : flatFile && existsSync(flatFile) ? flatFile : "";
      if (!file) continue;
      const id = existsSync(standardFile) ? entry : basename(entry, extname(entry));
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const errors: string[] = [];
        if (!existsSync(standardFile)) errors.push("扁平 Skill 已弃用；请迁移为 <id>/SKILL.md");
        if (!SKILL_NAME.test(id)) errors.push("Skill 目录名不符合 Agent Skills 规范");
        const parsed = parseSkillMarkdown(readFileSync(file, "utf8"), id);
        errors.push(...parsed.errors);
        const root = existsSync(standardFile) ? directory : dirname(file);
        const path = file.startsWith(project.root)
          ? relative(project.root, file).replace(/\\/gu, "/")
          : `builtin/${relative(BUILTIN_SKILLS_ROOT, file).replace(/\\/gu, "/")}`;
        skills.push({
          id,
          name: parsed.name,
          description: parsed.description,
          path,
          body: parsed.body.slice(0, 40_000),
          manifest: parseManifest(root, errors),
          resources: existsSync(standardFile) ? listResources(root) : [],
          validationErrors: errors,
          source: location.source,
          root,
        });
      } catch {
        continue;
      }
    }
  }
  return skills.sort((left, right) => left.id.localeCompare(right.id));
}

export function loadSkillById(project: WriterProject, id: string): ProjectSkill | undefined {
  const normalized = id.trim();
  return listProjectSkills(project).find(skill => skill.id === normalized || skill.name === normalized);
}

export function skillsCatalogPrompt(project: WriterProject): string | undefined {
  const skills = listProjectSkills(project)
    .filter(skill => skill.manifest.status === "active" || skill.manifest.status === "trial")
    .sort((left, right) => right.manifest.priority - left.manifest.priority || left.id.localeCompare(right.id));
  if (!skills.length) return undefined;
  const lines = skills.map(skill => {
    const state = skill.manifest.status === "trial" ? "试运行" : "可用";
    const caps = skill.manifest.capabilities.join("/");
    const when = skill.manifest.kind === "workflow"
      ? "流程"
      : skill.manifest.kind === "review" || skill.manifest.kind === "voice"
        ? "写前/精修"
        : skill.manifest.kind;
    const policies = skill.manifest.policyIds.length
      ? `；政策 ${skill.manifest.policyIds.slice(0, 4).join(",")}`
      : "";
    return `- ${skill.id} [${state}|${when}|${caps}${policies}]：${skill.description}`;
  });
  return [
    "可用项目技能（描述匹配任务、交付后可选精修、或修订问题给出 skillId 时，调用 load_skill；资源用 read_skill_resource 分页读取）：",
    "选用原则：先交付正文；风格偏好用 write/revise 类 skill 软约束，勿把 warn 当硬门禁反复改稿。",
    ...lines,
  ].join("\n");
}

/** Deterministic scope stage. The Agent performs the semantic choice among candidates. */
export function routeProjectSkills(project: WriterProject, input: SkillRouteInput): SkillRouteResult {
  const explicit = new Set(input.explicitSkillIds ?? []);
  const policyIds = new Set(input.policyIds ?? []);
  const characterIds = new Set(input.characterIds ?? []);
  const required: ProjectSkill[] = [];
  const candidates: ProjectSkill[] = [];
  const excluded: Array<{ id: string; reason: string }> = [];
  for (const skill of listProjectSkills(project)) {
    if (skill.manifest.status === "paused" || skill.manifest.status === "deprecated" || skill.manifest.status === "draft") {
      excluded.push({ id: skill.id, reason: `status=${skill.manifest.status}` });
      continue;
    }
    if (!skill.manifest.capabilities.includes(input.capability)) {
      excluded.push({ id: skill.id, reason: `不支持 ${input.capability}` });
      continue;
    }
    if (input.documentKind && skill.manifest.documentKinds.length
      && !skill.manifest.documentKinds.includes(input.documentKind)) {
      excluded.push({ id: skill.id, reason: `不适用于 ${input.documentKind}` });
      continue;
    }
    if (skill.manifest.characterIds.length
      && !skill.manifest.characterIds.some(id => characterIds.has(id))) {
      excluded.push({ id: skill.id, reason: "角色作用域不匹配" });
      continue;
    }
    const forced = explicit.has(skill.id)
      || skill.manifest.policyIds.some(id => policyIds.has(id));
    // Write/revise soft-preference skills surface as candidates, never auto-required
    // solely by policy link, unless the Agent explicitly asked for that skillId.
    // This keeps delivery-first: policy hits suggest skills; they don't mandate a workflow.
    if (forced && !explicit.has(skill.id) && (input.capability === "write" || input.capability === "revise")
      && skill.manifest.kind !== "workflow") {
      candidates.push(skill);
      continue;
    }
    (forced ? required : candidates).push(skill);
  }
  const byPriority = (left: ProjectSkill, right: ProjectSkill) => right.manifest.priority - left.manifest.priority
    || left.id.localeCompare(right.id);
  return { required: required.sort(byPriority), candidates: candidates.sort(byPriority), excluded };
}

/** Compact pre-write brief from active style-preference skills (soft constraints). */
export function styleSkillBriefPrompt(project: WriterProject, input?: {
  documentKind?: DocumentKind;
  policyIds?: string[];
}): string | undefined {
  const routed = routeProjectSkills(project, {
    capability: "write",
    ...(input?.documentKind ? { documentKind: input.documentKind } : {}),
    ...(input?.policyIds?.length ? { policyIds: input.policyIds } : {}),
  });
  const picks = [...routed.required, ...routed.candidates]
    .filter(skill => skill.manifest.kind === "review" || skill.manifest.kind === "voice"
      || skill.manifest.policyIds.length > 0
      || skill.id === "prefer-natural-beats"
      || skill.id === "chapter-delivery")
    .slice(0, 4);
  if (!picks.length) return undefined;
  const lines = picks.map(skill => {
    const bodyLines = skill.body.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    const firstPositive = bodyLines.find(line =>
      (/^[-*]\s+/u.test(line) || /^\d+\.\s+/u.test(line))
      && !/不要|禁止|勿/u.test(line));
    const tip = (firstPositive?.replace(/^[-*]\s+|^\d+\.\s+/u, "") || skill.description).slice(0, 160);
    return `- ${skill.id}：${tip}`;
  });
  return [
    "写前风格 skill 摘要（软约束，不阻断交付；需要细则时 load_skill）：",
    ...lines,
  ].join("\n");
}

function safeResourcePath(skill: ProjectSkill, resourcePath: string): string {
  const normalized = resourcePath.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("Skill 资源路径无效");
  }
  const allowed = skill.resources.find(resource => resource.path === normalized);
  if (!allowed) throw new Error("资源不存在或不在 Skill 可读资源清单中");
  const target = resolve(skill.root, normalized);
  const rootReal = realpathSync(skill.root);
  const targetReal = realpathSync(target);
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${sep}`)) throw new Error("Skill 资源越界");
  if (lstatSync(target).isSymbolicLink() || !statSync(targetReal).isFile()) throw new Error("Skill 资源类型不受支持");
  return targetReal;
}

export function readSkillResource(
  project: WriterProject,
  skillId: string,
  resourcePath: string,
  offset = 0,
  limit = 4_000,
): {
  skillId: string;
  path: string;
  sourceHash: string;
  offset: number;
  nextOffset: number;
  totalCharacters: number;
  hasMore: boolean;
  content: string;
} {
  const skill = loadSkillById(project, skillId);
  if (!skill) throw new Error("未找到该技能");
  const resource = skill.resources.find(item => item.path === resourcePath.trim().replace(/\\/gu, "/").replace(/^\.\//u, ""));
  if (!resource) throw new Error("未找到该 Skill 资源");
  if (resource.kind === "asset") throw new Error("二进制资产不能作为文本上下文读取");
  const file = safeResourcePath(skill, resource.path);
  const content = readFileSync(file, "utf8");
  const start = Math.max(0, Math.floor(offset) || 0);
  const pageSize = Math.max(500, Math.min(6_000, Math.floor(limit) || 4_000));
  const page = content.slice(start, start + pageSize);
  return {
    skillId: skill.id,
    path: resource.path,
    sourceHash: resource.sourceHash,
    offset: start,
    nextOffset: start + page.length,
    totalCharacters: content.length,
    hasMore: start + page.length < content.length,
    content: page,
  };
}
