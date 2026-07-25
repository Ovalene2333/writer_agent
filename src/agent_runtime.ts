import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import type { WriterProject } from "./project.js";

/** 权限/执行模式，对齐主流 code agent 的 ask / auto-run / plan。 */
export type PermissionMode = "ask" | "auto" | "plan";

export const ABSOLUTE_MAX_SCENES = 8;
export const MIN_SCENE_NOTES_CHARACTERS = 500;
export const MAX_SCENE_NOTES_CHARACTERS = 8_000;
export const DEFAULT_SCENE_NOTES_CHARACTERS = 3_000;
export const MIN_ISOLATED_WRITER_MAX_RATIO = 1.2;
export const MAX_ISOLATED_WRITER_MAX_RATIO = 3;
export const DEFAULT_ISOLATED_WRITER_MAX_RATIO = 2;

export interface ScenePipelineSettings {
  preferredMinScenes: number;
  preferredMaxScenes: number;
  maxScenes: number;
  /** Maximum Agent-authored scene packet size before compilation. */
  notesMaxCharacters: number;
  /** Hard prose ceiling relative to each scene's targetCharacters. */
  isolatedWriterMaxRatio: number;
  /** Experimental prose-only model call with a separate state extraction pass. */
  isolatedWriter: boolean;
  /**
   * Experimental best-of-N scene prose sampling: 1 = off (default);
   * 2–3 = per scene, request candidateCount-1 fact-preserving rewrites and keep
   * the highest-scoring candidate. Adds one plain-text model call per extra
   * candidate per scene.
   */
  candidateCount: number;
}

export interface AgentRuntimeSettings {
  permissionMode: PermissionMode;
  /** Allow narrative tasks to append character experiences and story state. */
  characterEvolutionEnabled: boolean;
  scenePipeline: ScenePipelineSettings;
}

export interface AgentTodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface ProjectSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  body: string;
}

export type ScenePipelineMilestone = "draft_started" | "draft_reopened" | "draft_complete";

const DEFAULT_SCENE_PIPELINE_TODOS = [
  "核对本篇必要事实与衔接",
  "建立初始场景引导",
  "按成稿结果推进正文",
  "全文审阅并提交提案",
] as const;

const PREVIOUS_SCENE_PIPELINE_TODOS = [
  "核对本篇必要事实与衔接",
  "建立本篇场景链",
  "逐场写作并传递状态",
  "全文审阅并提交提案",
] as const;

const OLDER_SCENE_PIPELINE_TODOS = [
  "核对本章必要事实与衔接",
  "建立本章场景链",
  "逐场写作并传递状态",
  "整章审阅并提交提案",
] as const;

const LEGACY_SCENE_PIPELINE_TODOS = [
  "核对大纲、人设与衔接",
  "建立章节场景链",
  "逐场编译、写作并传递状态",
  "整章审阅并提交提案",
] as const;

const SCENE_PIPELINE_TODO_SIGNATURES = [
  DEFAULT_SCENE_PIPELINE_TODOS,
  PREVIOUS_SCENE_PIPELINE_TODOS,
  OLDER_SCENE_PIPELINE_TODOS,
  LEGACY_SCENE_PIPELINE_TODOS,
] as const;

const DEFAULT_SETTINGS: AgentRuntimeSettings = {
  permissionMode: "ask",
  characterEvolutionEnabled: true,
  scenePipeline: {
    preferredMinScenes: 3,
    preferredMaxScenes: 5,
    maxScenes: 5,
    notesMaxCharacters: DEFAULT_SCENE_NOTES_CHARACTERS,
    isolatedWriterMaxRatio: DEFAULT_ISOLATED_WRITER_MAX_RATIO,
    isolatedWriter: false,
    candidateCount: 1,
  },
};

export const MAX_SCENE_CANDIDATES = 3;

const PERMISSION_MODES = new Set<PermissionMode>(["ask", "auto", "plan"]);

export function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.has(value as PermissionMode);
}

export function settingsPath(project: WriterProject): string {
  return resolve(project.privateDir, "agent.json");
}

export function normalizeScenePipelineSettings(value?: Partial<ScenePipelineSettings>): ScenePipelineSettings {
  const integer = (candidate: unknown, fallback: number) => Number.isInteger(candidate)
    ? Math.min(ABSOLUTE_MAX_SCENES, Math.max(1, Number(candidate)))
    : fallback;
  const maxScenes = integer(value?.maxScenes, DEFAULT_SETTINGS.scenePipeline.maxScenes);
  const preferredMaxScenes = Math.min(maxScenes, integer(value?.preferredMaxScenes, DEFAULT_SETTINGS.scenePipeline.preferredMaxScenes));
  const preferredMinScenes = Math.min(preferredMaxScenes, integer(value?.preferredMinScenes, DEFAULT_SETTINGS.scenePipeline.preferredMinScenes));
  const candidateCount = Number.isInteger(value?.candidateCount)
    ? Math.min(MAX_SCENE_CANDIDATES, Math.max(1, Number(value?.candidateCount)))
    : DEFAULT_SETTINGS.scenePipeline.candidateCount;
  const isolatedWriter = value?.isolatedWriter === true;
  const notesMaxCharacters = Number.isInteger(value?.notesMaxCharacters)
    ? Math.min(MAX_SCENE_NOTES_CHARACTERS, Math.max(MIN_SCENE_NOTES_CHARACTERS, Number(value?.notesMaxCharacters)))
    : DEFAULT_SETTINGS.scenePipeline.notesMaxCharacters;
  const rawWriterRatio = Number(value?.isolatedWriterMaxRatio);
  const isolatedWriterMaxRatio = Number.isFinite(rawWriterRatio)
    ? Math.round(Math.min(MAX_ISOLATED_WRITER_MAX_RATIO, Math.max(MIN_ISOLATED_WRITER_MAX_RATIO, rawWriterRatio)) * 10) / 10
    : DEFAULT_SETTINGS.scenePipeline.isolatedWriterMaxRatio;
  return {
    preferredMinScenes, preferredMaxScenes, maxScenes,
    notesMaxCharacters, isolatedWriterMaxRatio, isolatedWriter, candidateCount,
  };
}

export function loadAgentSettings(project: WriterProject): AgentRuntimeSettings {
  const path = settingsPath(project);
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentRuntimeSettings>;
    const mode = typeof raw.permissionMode === "string" && isPermissionMode(raw.permissionMode)
      ? raw.permissionMode
      : DEFAULT_SETTINGS.permissionMode;
    return {
      permissionMode: mode,
      characterEvolutionEnabled: raw.characterEvolutionEnabled !== false,
      scenePipeline: normalizeScenePipelineSettings(raw.scenePipeline),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveAgentSettings(
  project: WriterProject,
  patch: { permissionMode?: PermissionMode; characterEvolutionEnabled?: boolean; scenePipeline?: Partial<ScenePipelineSettings> },
): AgentRuntimeSettings {
  const current = loadAgentSettings(project);
  const next: AgentRuntimeSettings = {
    permissionMode: patch.permissionMode && isPermissionMode(patch.permissionMode)
      ? patch.permissionMode
      : current.permissionMode,
    characterEvolutionEnabled: typeof patch.characterEvolutionEnabled === "boolean"
      ? patch.characterEvolutionEnabled
      : current.characterEvolutionEnabled,
    scenePipeline: patch.scenePipeline
      ? normalizeScenePipelineSettings({ ...current.scenePipeline, ...patch.scenePipeline })
      : current.scenePipeline,
  };
  mkdirSync(project.privateDir, { recursive: true });
  writeFileSync(settingsPath(project), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** 项目级指令文件（仿 Claude Code AGENTS.md / Cursor rules）。 */
const INSTRUCTION_CANDIDATES = [
  "WRITER.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".writer/instructions.md",
  ".writer/WRITER.md",
];

export function loadProjectInstructions(project: WriterProject): { path: string; content: string } | undefined {
  for (const relative of INSTRUCTION_CANDIDATES) {
    const absolute = resolve(project.root, relative);
    if (!existsSync(absolute)) continue;
    try {
      if (!statSync(absolute).isFile()) continue;
      const content = readFileSync(absolute, "utf8").trim();
      if (!content) continue;
      return { path: relative.replace(/\\/g, "/"), content: content.slice(0, 24_000) };
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Injected into agent stable-prefix slot 2 (or a fixed empty placeholder if absent).
 * CACHE: File content is project-stable; avoid baking turn-specific task text into
 * WRITER.md that must change every chapter. Cap is intentional for cost control.
 */
export function projectInstructionsPrompt(project: WriterProject): string | undefined {
  const loaded = loadProjectInstructions(project);
  if (!loaded) return undefined;
  return `项目指令（${loaded.path}，作者/仓库约定，优先级高于默认习惯、低于用户当前消息）：
${loaded.content}`;
}

function parseSkillMarkdown(raw: string, fallbackName: string): { name: string; description: string; body: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    if (end > 0) {
      const front = trimmed.slice(3, end).trim();
      const body = trimmed.slice(end + 4).trim();
      const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallbackName;
      const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim()
        || body.split(/\r?\n/).find(line => line.trim() && !line.startsWith("#"))?.trim().slice(0, 200)
        || "";
      return { name, description, body: body || trimmed };
    }
  }
  const title = trimmed.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallbackName;
  const description = trimmed.split(/\r?\n/).find(line => line.trim() && !line.startsWith("#"))?.trim().slice(0, 200) || "";
  return { name: title, description, body: trimmed };
}

const BUILTIN_SKILLS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");

function skillRoots(project: WriterProject): string[] {
  return [
    resolve(project.root, ".writer", "skills"),
    resolve(project.root, ".agents", "skills"),
    BUILTIN_SKILLS_ROOT,
  ];
}

/** 扫描项目技能目录，并以项目同名技能覆盖内置技能。 */
export function listProjectSkills(project: WriterProject): ProjectSkill[] {
  const skills: ProjectSkill[] = [];
  const seen = new Set<string>();
  for (const root of skillRoots(project)) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillFile = join(root, entry, "SKILL.md");
      const flatFile = entry.toLowerCase().endsWith(".md") ? join(root, entry) : "";
      const file = existsSync(skillFile) ? skillFile : flatFile && existsSync(flatFile) ? flatFile : "";
      if (!file) continue;
      try {
        const raw = readFileSync(file, "utf8");
        const id = existsSync(skillFile) ? entry : basename(entry, ".md");
        if (seen.has(id)) continue;
        seen.add(id);
        const parsed = parseSkillMarkdown(raw, id);
        const relative = file.startsWith(project.root)
          ? file.slice(project.root.length + 1).replace(/\\/g, "/")
          : file.startsWith(BUILTIN_SKILLS_ROOT)
            ? `builtin/${file.slice(BUILTIN_SKILLS_ROOT.length + 1).replace(/\\/g, "/")}`
          : file;
        skills.push({
          id,
          name: parsed.name,
          description: parsed.description,
          path: relative,
          body: parsed.body.slice(0, 32_000),
        });
      } catch {
        continue;
      }
    }
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Injected into agent stable-prefix slot 3 (catalog only).
 * CACHE: id + name + short description — never the full SKILL.md body (load_skill
 * pulls details on demand so the stable prefix stays small and stable).
 */
export function skillsCatalogPrompt(project: WriterProject): string | undefined {
  const skills = listProjectSkills(project);
  if (!skills.length) return undefined;
  const lines = skills.map(skill => `- ${skill.id}：${skill.name}${skill.description ? ` — ${skill.description}` : ""}`);
  return `可用项目技能（需要细则时调用 load_skill）：
${lines.join("\n")}`;
}

export function loadSkillById(project: WriterProject, id: string): ProjectSkill | undefined {
  const normalized = id.trim();
  return listProjectSkills(project).find(skill => skill.id === normalized || skill.name === normalized);
}

export function normalizeTodos(input: unknown): AgentTodoItem[] {
  if (!Array.isArray(input)) throw new Error("todos 必须是数组");
  if (input.length > 30) throw new Error("todos 最多 30 项");
  const todos: AgentTodoItem[] = [];
  const statuses = new Set(["pending", "in_progress", "completed", "cancelled"]);
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    if (!raw || typeof raw !== "object") throw new Error(`todos[${index}] 格式无效`);
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 64) : `t${index + 1}`;
    if (seen.has(id)) throw new Error(`todos id 重复：${id}`);
    seen.add(id);
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) throw new Error(`todos[${index}].content 不能为空`);
    const status = typeof item.status === "string" && statuses.has(item.status)
      ? item.status as AgentTodoItem["status"]
      : "pending";
    todos.push({ id, content: content.slice(0, 400), status });
  }
  const inProgress = todos.filter(item => item.status === "in_progress");
  if (inProgress.length > 1) {
    // 只保留第一项 in_progress，其余降为 pending（与主流 code agent 一致）
    for (let i = 1; i < inProgress.length; i += 1) inProgress[i].status = "pending";
  }
  return todos;
}

/**
 * Advance the built-in four-stage narrative workflow from structured tool results.
 * This is deliberately exact-match based: custom/model-authored plans remain under
 * manage_todos control and are never guessed from keywords.
 */
export function advanceScenePipelineTodos(
  todos: AgentTodoItem[],
  milestone: ScenePipelineMilestone,
): { todos: AgentTodoItem[]; changed: boolean } {
  const signature = SCENE_PIPELINE_TODO_SIGNATURES
    .map(contents => contents.map(content => todos.findIndex(item => item.content === content)))
    .find(indexes => indexes.every(index => index >= 0));
  if (!signature) return { todos, changed: false };
  const indexes = signature;
  if (milestone === "draft_reopened") {
    let changed = false;
    const next = todos.map(item => ({ ...item }));
    for (let phase = 0; phase < 2; phase += 1) {
      const item = next[indexes[phase]];
      if (item.status !== "completed" && item.status !== "cancelled") {
        item.status = "completed";
        changed = true;
      }
    }
    const writing = next[indexes[2]];
    if (writing.status !== "cancelled" && writing.status !== "in_progress") {
      writing.status = "in_progress";
      changed = true;
    }
    const review = next[indexes[3]];
    if (review.status !== "cancelled" && review.status !== "pending") {
      review.status = "pending";
      changed = true;
    }
    return { todos: next, changed };
  }
  const completedThrough = milestone === "draft_started" ? 1 : 2;
  const activeIndex = indexes[completedThrough + 1];
  let changed = false;
  const next = todos.map(item => ({ ...item }));
  for (let phase = 0; phase <= completedThrough; phase += 1) {
    const item = next[indexes[phase]];
    if (item.status !== "completed" && item.status !== "cancelled") {
      item.status = "completed";
      changed = true;
    }
  }
  for (const item of next) {
    if (item.status === "in_progress" && item !== next[activeIndex]) {
      item.status = "pending";
      changed = true;
    }
  }
  const active = next[activeIndex];
  if (active.status !== "in_progress" && active.status !== "completed" && active.status !== "cancelled") {
    active.status = "in_progress";
    changed = true;
  }
  return { todos: next, changed };
}

export function persistScenePipelineTodos(
  store: {
    sessionTodos(sessionId: string): AgentTodoItem[];
    saveSessionTodos(sessionId: string, todos: AgentTodoItem[]): void;
  },
  sessionId: string,
  milestone: ScenePipelineMilestone,
  emit?: (event: { type: "todos"; todos: AgentTodoItem[] }) => void,
): AgentTodoItem[] {
  const result = advanceScenePipelineTodos(store.sessionTodos(sessionId), milestone);
  if (result.changed) {
    store.saveSessionTodos(sessionId, result.todos);
    emit?.({ type: "todos", todos: result.todos });
  }
  return result.todos;
}

export function formatTodosForPrompt(todos: AgentTodoItem[]): string {
  if (!todos.length) return "（空）";
  return todos.map(item => {
    const mark = item.status === "completed" ? "x"
      : item.status === "in_progress" ? ">"
        : item.status === "cancelled" ? "-"
          : " ";
    return `- [${mark}] ${item.id}: ${item.content} (${item.status})`;
  }).join("\n");
}

/**
 * Soft checklist items that are usually "forgot to tick after proposal" rather than
 * independent deliverables (e.g. 提交文档提案 / 自检).
 */
export function isSoftChecklistTodo(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  if (isFurtherWritingTodo(text)) return false;
  // Do not treat primary writing steps as soft just because they mention 自检.
  if (/(?:完成正文|核对大纲|读取|检索|阅读)/.test(text) && !/(?:提交|提案)/.test(text)) return false;
  return /提交|提案|收尾|确认完成|结束任务/.test(text)
    || /^(?:自检|检查|收尾)$/.test(text);
}

/**
 * Remaining multi-deliverable writing steps (e.g. 撰写第2章初稿). These must stay open
 * after an earlier chapter's proposal succeeds.
 */
export function isFurtherWritingTodo(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  // Require multi-deliverable signals (章号/初稿/续写…). Avoid matching the default
  // single-scene step "完成正文并自检", which would false-continue after one proposal.
  return /撰写|写第|续写|创作|起草|初稿|改写|重写|第\s*\d+\s*章|第\s*[一二三四五六七八九十两零〇]+\s*章|场景正文|章节正文|第\s*\d+\s*节/.test(text);
}

/**
 * After a document proposal succeeds: close the active step and any soft trailing
 * "submit proposal" checkboxes. If further writing steps remain, promote the next
 * one and signal the agent loop to continue instead of finalizing the whole plan.
 */
export function advanceTodosAfterProposal(todos: AgentTodoItem[]): {
  todos: AgentTodoItem[];
  changed: boolean;
  shouldContinue: boolean;
} {
  if (!todos.length) return { todos, changed: false, shouldContinue: false };
  let changed = false;
  const next = todos.map(item => {
    if (item.status === "in_progress") {
      changed = true;
      return { ...item, status: "completed" as const };
    }
    return { ...item };
  });
  // Close soft "submit/check" leftovers that models often leave pending after propose_*.
  for (const item of next) {
    if (item.status === "pending" && isSoftChecklistTodo(item.content)) {
      item.status = "completed";
      changed = true;
    }
  }
  const furtherPending = next.filter(item => item.status === "pending" && isFurtherWritingTodo(item.content));
  if (furtherPending.length) {
    // Only one in_progress at a time.
    for (const item of next) {
      if (item.status === "in_progress") item.status = "pending";
    }
    furtherPending[0].status = "in_progress";
    changed = true;
    return { todos: next, changed, shouldContinue: true };
  }
  // No further writing deliverables: close any other dangling open items for a clean UI.
  for (const item of next) {
    if (item.status !== "completed" && item.status !== "cancelled") {
      item.status = "completed";
      changed = true;
    }
  }
  return { todos: next, changed, shouldContinue: false };
}

/** A successful character mutation is the terminal deliverable for character-only tasks. */
export function completeCharacterTaskTodos(todos: AgentTodoItem[]): { todos: AgentTodoItem[]; changed: boolean } {
  let changed = false;
  const next = todos.map(item => {
    if (item.status !== "completed" && item.status !== "cancelled") {
      changed = true;
      return { ...item, status: "completed" as const };
    }
    return item;
  });
  return { todos: next, changed };
}

/** Built-in scene progress is owned by structured scene tool milestones, not manage_todos. */
export function reconcileManagedTodos(
  current: AgentTodoItem[],
  requested: AgentTodoItem[],
): { todos: AgentTodoItem[]; scenePipelineProtected: boolean } {
  const hasScenePipeline = SCENE_PIPELINE_TODO_SIGNATURES.some(contents =>
    current.length === contents.length
      && contents.every(content => current.some(item => item.content === content)),
  );
  return hasScenePipeline
    ? { todos: current, scenePipelineProtected: true }
    : { todos: requested, scenePipelineProtected: false };
}

/** Persist completion after the character-only task's save tool succeeds. */
export function persistCompletedCharacterTaskTodos(
  store: {
    sessionTodos(sessionId: string): AgentTodoItem[];
    saveSessionTodos(sessionId: string, todos: AgentTodoItem[]): void;
  },
  sessionId: string,
  emit?: (event: { type: "todos"; todos: AgentTodoItem[] }) => void,
): AgentTodoItem[] {
  const current = store.sessionTodos(sessionId);
  if (!current.length) return current;
  const result = completeCharacterTaskTodos(current);
  if (!result.changed) return current;
  store.saveSessionTodos(sessionId, result.todos);
  emit?.({ type: "todos", todos: result.todos });
  return result.todos;
}

/** Persist proposal advance and report whether the agent should keep writing. */
export function persistAdvancedTodosAfterProposal(
  store: {
    sessionTodos(sessionId: string): AgentTodoItem[];
    saveSessionTodos(sessionId: string, todos: AgentTodoItem[]): void;
  },
  sessionId: string,
  emit?: (event: { type: "todos"; todos: AgentTodoItem[] }) => void,
): { todos: AgentTodoItem[]; shouldContinue: boolean } {
  const current = store.sessionTodos(sessionId);
  if (!current.length) return { todos: current, shouldContinue: false };
  const { todos, changed, shouldContinue } = advanceTodosAfterProposal(current);
  if (changed) {
    store.saveSessionTodos(sessionId, todos);
    emit?.({ type: "todos", todos });
  }
  return { todos, shouldContinue };
}

export function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "auto") return "auto（提案自动写入）";
  if (mode === "plan") return "plan（只读规划，禁止提交写入提案）";
  return "ask（提案需作者审批）";
}
