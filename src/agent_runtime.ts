import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { WriterProject } from "./project.js";

/** 权限/执行模式，对齐主流 code agent 的 ask / auto-run / plan。 */
export type PermissionMode = "ask" | "auto" | "plan";

export interface AgentRuntimeSettings {
  permissionMode: PermissionMode;
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

const DEFAULT_SETTINGS: AgentRuntimeSettings = {
  permissionMode: "ask",
};

const PERMISSION_MODES = new Set<PermissionMode>(["ask", "auto", "plan"]);

export function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.has(value as PermissionMode);
}

export function settingsPath(project: WriterProject): string {
  return resolve(project.privateDir, "agent.json");
}

export function loadAgentSettings(project: WriterProject): AgentRuntimeSettings {
  const path = settingsPath(project);
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentRuntimeSettings>;
    const mode = typeof raw.permissionMode === "string" && isPermissionMode(raw.permissionMode)
      ? raw.permissionMode
      : DEFAULT_SETTINGS.permissionMode;
    return { permissionMode: mode };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveAgentSettings(project: WriterProject, patch: Partial<AgentRuntimeSettings>): AgentRuntimeSettings {
  const current = loadAgentSettings(project);
  const next: AgentRuntimeSettings = {
    permissionMode: patch.permissionMode && isPermissionMode(patch.permissionMode)
      ? patch.permissionMode
      : current.permissionMode,
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

function skillRoots(project: WriterProject): string[] {
  return [
    resolve(project.root, ".writer", "skills"),
    resolve(project.root, ".agents", "skills"),
  ];
}

/** 扫描项目技能目录（仿 code agent skills）。 */
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
 * When a turn ends successfully (final reply or document proposal submitted),
 * mark remaining open todos completed so the UI does not stay stuck at e.g. 1/3
 * after "Agent job completed". Cancelled items are left alone.
 * Proposal success intentionally stops the agent before another manage_todos call.
 */
export function finalizeOpenTodos(todos: AgentTodoItem[]): { todos: AgentTodoItem[]; changed: boolean } {
  let changed = false;
  const next = todos.map(item => {
    // Treat anything not already completed/cancelled as open (covers bad model statuses).
    if (item.status !== "completed" && item.status !== "cancelled") {
      changed = true;
      return { ...item, status: "completed" as const };
    }
    return item;
  });
  return { todos: next, changed };
}

/** Persist finalized session todos and optionally emit a stream event. */
export function persistFinalizedSessionTodos(
  store: {
    sessionTodos(sessionId: string): AgentTodoItem[];
    saveSessionTodos(sessionId: string, todos: AgentTodoItem[]): void;
  },
  sessionId: string,
  emit?: (event: { type: "todos"; todos: AgentTodoItem[] }) => void,
): AgentTodoItem[] {
  const current = store.sessionTodos(sessionId);
  if (!current.length) return current;
  const { todos, changed } = finalizeOpenTodos(current);
  if (!changed) return current;
  store.saveSessionTodos(sessionId, todos);
  emit?.({ type: "todos", todos });
  return todos;
}

export function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "auto") return "auto（提案自动写入）";
  if (mode === "plan") return "plan（只读规划，禁止提交写入提案）";
  return "ask（提案需作者审批）";
}
