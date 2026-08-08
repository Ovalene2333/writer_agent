import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_WRITER_INSTRUCTIONS, type WriterProject } from "./project.js";
import type { ReasoningEffort } from "./types.js";
export {
  listProjectSkills,
  loadSkillById,
  readSkillResource,
  routeProjectSkills,
  skillsCatalogPrompt,
  styleSkillBriefPrompt,
} from "./skill_runtime.js";
export type {
  ProjectSkill,
  ProjectSkillResource,
  SkillCapability,
  SkillKind,
  SkillManifest,
  SkillRouteInput,
  SkillRouteResult,
  SkillStatus,
} from "./skill_runtime.js";

/** 权限/执行模式，对齐主流 code agent 的 ask / auto-run / plan。 */
export type PermissionMode = "ask" | "auto" | "plan";
export type WritingExecutionMode = "delegated" | "fast";
/**
 * Agent 单次任务步数策略：
 * - hard：日常默认，单一可配置硬上限，到点即暂停可续跑
 * - experimental：soft 预算 + 停滞收敛 + 安全硬顶（试验用）
 */
export type AgentStepBudgetMode = "hard" | "experimental";

export const ABSOLUTE_MAX_SCENES = 8;
export const MIN_AGENT_STEPS = 8;
export const MAX_AGENT_STEPS = 100;
export const DEFAULT_AGENT_STEPS = 32;
export const MIN_SCENE_NOTES_CHARACTERS = 500;
export const MAX_SCENE_NOTES_CHARACTERS = 8_000;
export const DEFAULT_SCENE_NOTES_CHARACTERS = 3_000;
export const MIN_CHAPTER_TARGET_CHARACTERS = 500;
export const MAX_CHAPTER_TARGET_CHARACTERS = 50_000;
export const DEFAULT_CHAPTER_TARGET_CHARACTERS = 3_000;

export const MIN_PROSE_GATE_TIMEOUT_SECONDS = 10;
export const MAX_PROSE_GATE_TIMEOUT_SECONDS = 900;
export const DEFAULT_PRIMARY_PROSE_GATE_TIMEOUT_SECONDS = 60;
export const DEFAULT_FINAL_PROSE_GATE_TIMEOUT_SECONDS = 180;

export interface ProseGateTimeoutSettings {
  primarySeconds: number;
  finalSeconds: number;
}

/** Live performance reasoning: inherit the assigned roleplay model, or force a level. */
export type RoleplayReasoningChoice = ReasoningEffort | "inherit";

/** Length slider levels used by roleplay presentation budgets (-2 极简 … 2 展开). */
export const ROLEPLAY_LENGTH_LEVEL_KEYS = ["-2", "-1", "0", "1", "2"] as const;
export type RoleplayLengthLevelKey = typeof ROLEPLAY_LENGTH_LEVEL_KEYS[number];

/** Min/max presentation blocks for one length level. */
export type RoleplayLengthBlockBudget = {
  minBlocks: number;
  maxBlocks: number;
};

/** Per-level block budgets keyed as strings for stable JSON. */
export type RoleplayLengthBlockBudgets = Record<RoleplayLengthLevelKey, RoleplayLengthBlockBudget>;

/**
 * Project-level roleplay runtime knobs (not per-turn UI sliders).
 * Model assignment stays in provider roles; these control effort/budget/finalize behavior.
 */
export interface RoleplaySettings {
  /**
   * Reasoning for the streamed character performance.
   * `inherit` keeps the roleplay role's model.reasoningEffort.
   */
  performanceReasoningEffort: RoleplayReasoningChoice;
  /**
   * Reasoning for JSON helpers (perception / quality finalize / memory / scene draft).
   * Defaults to none so classifiers do not burn a medium thinking budget.
   */
  jsonReasoningEffort: ReasoningEffort;
  /** Run structural quality finalize after each performance. */
  qualityFinalizeEnabled: boolean;
  /** Recent full user/assistant messages kept in the roleplay prompt window. */
  recentMessages: number;
  /** Max output tokens for the streamed character reply. */
  replyMaxOutputTokens: number;
  /** Max output tokens for roleplay JSON helper calls. */
  jsonMaxOutputTokens: number;
  /**
   * Presentation block counts for each length slider level.
   * Character-range guidance stays in code defaults; only block counts are author-tunable.
   */
  lengthBlockBudgets: RoleplayLengthBlockBudgets;
}

export const MIN_ROLEPLAY_RECENT_MESSAGES = 4;
export const MAX_ROLEPLAY_RECENT_MESSAGES = 24;
export const DEFAULT_ROLEPLAY_RECENT_MESSAGES = 8;
export const MIN_ROLEPLAY_OUTPUT_TOKENS = 1_000;
export const MAX_ROLEPLAY_OUTPUT_TOKENS = 16_000;
export const DEFAULT_ROLEPLAY_OUTPUT_TOKENS = 8_000;
export const MIN_ROLEPLAY_LENGTH_BLOCKS = 1;
export const MAX_ROLEPLAY_LENGTH_BLOCKS = 8;

/** Built-in defaults aligned with ROLEPLAY_LENGTH_PRESETS in roleplay.ts. */
export const DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS: RoleplayLengthBlockBudgets = {
  "-2": { minBlocks: 1, maxBlocks: 1 },
  "-1": { minBlocks: 2, maxBlocks: 2 },
  "0": { minBlocks: 2, maxBlocks: 3 },
  "1": { minBlocks: 3, maxBlocks: 4 },
  "2": { minBlocks: 4, maxBlocks: 5 },
};

export const ROLEPLAY_LENGTH_LEVEL_LABELS: Record<RoleplayLengthLevelKey, string> = {
  "-2": "极简",
  "-1": "精简",
  "0": "适中",
  "1": "充分",
  "2": "展开",
};

/** 篇幅控制：范围验收保留现有门禁，弱引导只把目标作为参考。 */
export type ProseLengthMode = "bounded" | "guidance";

export interface ProseLengthSettings {
  /**
   * 对话没有指定字数时的默认整章目标。作者在这里定一次「这个项目一章多长」，
   * 之后不必每轮复述数字，也不再由模型按事件密度自行拍板。
   */
  chapterTargetCharacters: number;
  /**
   * 现有范围验收或只作参考的弱引导。缺失时按 bounded 兼容旧项目设置。
   */
  mode: ProseLengthMode;
  /**
   * 范围验收模式下，下限是否硬性拦截。默认关：偏短只提示并记进质量报告，交付照常继续。
   * 打开后恢复旧行为 —— 不达下限就报错要求重写。弱引导模式不执行此项。
   */
  enforceMinimum: boolean;
}

export interface ScenePipelineSettings {
  /** Whether the optional multi-scene chapter draft pipeline may be used. */
  enabled: boolean;
  preferredMinScenes: number;
  preferredMaxScenes: number;
  maxScenes: number;
  /** Maximum Agent-authored scene packet size before compilation. */
  notesMaxCharacters: number;
  /**
   * Optional reader-evaluated scene sampling: 1 = off; 2–3 = per scene, request
   * candidateCount-1 fact-preserving rewrites and keep a reader-judged winner.
   * Without that judgment, the original stays. Adds one plain-text model call per
   * extra candidate per scene, plus one cheap judging call when a rewrite survives.
   *
   * Defaults to 1 so an initial draft is not automatically rewritten by a
   * quality proxy. Enable it deliberately when a second reader pass is wanted.
   */
  candidateCount: number;
}

export interface AgentRuntimeSettings {
  permissionMode: PermissionMode;
  /** Selects auxiliary model routing; scene prose always remains in the main Agent flow. */
  writingMode: WritingExecutionMode;
  /** Allow narrative tasks to append character experiences and story state. */
  characterEvolutionEnabled: boolean;
  /**
   * 终审与候选评判跟随正文模型（默认开）。
   *
   * 判「这章像不像人写的」用的是语感，不是清单：一个比正文便宜的模型评自己写不出来的
   * 文字，只会把标准降到它自己的水平，新增的 voice_homogenization / theme_stated /
   * resolution_too_smooth 尤其吃这一点。关闭后回到「审阅校对」角色配置的模型。
   */
  reviewFollowsProseModel: boolean;
  /**
   * 单次 runAgent 任务的步数策略。日常用 hard；experimental 保留 soft/停滞收敛试验。
   */
  stepBudgetMode: AgentStepBudgetMode;
  /**
   * hard 模式下的单一硬上限（也是 experimental 的参考尺度之一）。
   * 到上限后暂停并保留续跑，不抛错。
   */
  maxAgentSteps: number;
  scenePipeline: ScenePipelineSettings;
  /** 作者的篇幅偏好：默认目标字数与下限执行强度。 */
  proseLength: ProseLengthSettings;
  proseGateTimeouts: ProseGateTimeoutSettings;
  /** 角色扮演试演：推理档位、终审与输出预算。 */
  roleplay: RoleplaySettings;
}

export interface AgentTodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
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
  writingMode: "fast",
  characterEvolutionEnabled: true,
  reviewFollowsProseModel: true,
  stepBudgetMode: "hard",
  maxAgentSteps: DEFAULT_AGENT_STEPS,
  scenePipeline: {
    enabled: false,
    preferredMinScenes: 3,
    preferredMaxScenes: 5,
    maxScenes: 5,
    notesMaxCharacters: DEFAULT_SCENE_NOTES_CHARACTERS,
    candidateCount: 1,
  },
  proseLength: {
    chapterTargetCharacters: DEFAULT_CHAPTER_TARGET_CHARACTERS,
    mode: "bounded",
    enforceMinimum: false,
  },
  proseGateTimeouts: {
    primarySeconds: DEFAULT_PRIMARY_PROSE_GATE_TIMEOUT_SECONDS,
    finalSeconds: DEFAULT_FINAL_PROSE_GATE_TIMEOUT_SECONDS,
  },
  roleplay: {
    performanceReasoningEffort: "inherit",
    jsonReasoningEffort: "none",
    qualityFinalizeEnabled: true,
    recentMessages: DEFAULT_ROLEPLAY_RECENT_MESSAGES,
    replyMaxOutputTokens: DEFAULT_ROLEPLAY_OUTPUT_TOKENS,
    jsonMaxOutputTokens: DEFAULT_ROLEPLAY_OUTPUT_TOKENS,
    lengthBlockBudgets: { ...DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS },
  },
};

export const MAX_SCENE_CANDIDATES = 3;

const PERMISSION_MODES = new Set<PermissionMode>(["ask", "auto", "plan"]);
const WRITING_EXECUTION_MODES = new Set<WritingExecutionMode>(["delegated", "fast"]);
const STEP_BUDGET_MODES = new Set<AgentStepBudgetMode>(["hard", "experimental"]);
const PROSE_LENGTH_MODES = new Set<ProseLengthMode>(["bounded", "guidance"]);
const REASONING_EFFORTS = new Set<ReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh"]);
const ROLEPLAY_REASONING_CHOICES = new Set<RoleplayReasoningChoice>([
  "inherit", "none", "minimal", "low", "medium", "high", "xhigh",
]);

export function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.has(value as PermissionMode);
}

export function isWritingExecutionMode(value: string): value is WritingExecutionMode {
  return WRITING_EXECUTION_MODES.has(value as WritingExecutionMode);
}

export function isAgentStepBudgetMode(value: string): value is AgentStepBudgetMode {
  return STEP_BUDGET_MODES.has(value as AgentStepBudgetMode);
}

export function isProseLengthMode(value: string): value is ProseLengthMode {
  return PROSE_LENGTH_MODES.has(value as ProseLengthMode);
}

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORTS.has(value as ReasoningEffort);
}

export function isRoleplayReasoningChoice(value: string): value is RoleplayReasoningChoice {
  return ROLEPLAY_REASONING_CHOICES.has(value as RoleplayReasoningChoice);
}

export function normalizeMaxAgentSteps(value: unknown, fallback = DEFAULT_AGENT_STEPS): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.round(Math.min(MAX_AGENT_STEPS, Math.max(MIN_AGENT_STEPS, raw)));
}

export function settingsPath(project: WriterProject): string {
  return resolve(project.privateDir, "agent.json");
}

export function normalizeScenePipelineSettings(value?: Partial<ScenePipelineSettings>): ScenePipelineSettings {
  const enabled = value?.enabled === true;
  const integer = (candidate: unknown, fallback: number) => Number.isInteger(candidate)
    ? Math.min(ABSOLUTE_MAX_SCENES, Math.max(1, Number(candidate)))
    : fallback;
  const maxScenes = integer(value?.maxScenes, DEFAULT_SETTINGS.scenePipeline.maxScenes);
  const preferredMaxScenes = Math.min(maxScenes, integer(value?.preferredMaxScenes, DEFAULT_SETTINGS.scenePipeline.preferredMaxScenes));
  const preferredMinScenes = Math.min(preferredMaxScenes, integer(value?.preferredMinScenes, DEFAULT_SETTINGS.scenePipeline.preferredMinScenes));
  const candidateCount = Number.isInteger(value?.candidateCount)
    ? Math.min(MAX_SCENE_CANDIDATES, Math.max(1, Number(value?.candidateCount)))
    : DEFAULT_SETTINGS.scenePipeline.candidateCount;
  const notesMaxCharacters = Number.isInteger(value?.notesMaxCharacters)
    ? Math.min(MAX_SCENE_NOTES_CHARACTERS, Math.max(MIN_SCENE_NOTES_CHARACTERS, Number(value?.notesMaxCharacters)))
    : DEFAULT_SETTINGS.scenePipeline.notesMaxCharacters;
  return {
    enabled,
    preferredMinScenes, preferredMaxScenes, maxScenes,
    notesMaxCharacters, candidateCount,
  };
}

export function normalizeProseLengthSettings(value?: Partial<ProseLengthSettings>): ProseLengthSettings {
  const raw = Number(value?.chapterTargetCharacters);
  return {
    chapterTargetCharacters: Number.isFinite(raw) && raw > 0
      ? Math.round(Math.min(MAX_CHAPTER_TARGET_CHARACTERS, Math.max(MIN_CHAPTER_TARGET_CHARACTERS, raw)))
      : DEFAULT_SETTINGS.proseLength.chapterTargetCharacters,
    mode: typeof value?.mode === "string" && isProseLengthMode(value.mode)
      ? value.mode
      : DEFAULT_SETTINGS.proseLength.mode,
    enforceMinimum: value?.enforceMinimum === true,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.round(Math.min(max, Math.max(min, raw)));
}

export function normalizeRoleplayLengthBlockBudget(
  value: unknown,
  fallback: RoleplayLengthBlockBudget,
): RoleplayLengthBlockBudget {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const minBlocks = clampInt(
    raw.minBlocks,
    MIN_ROLEPLAY_LENGTH_BLOCKS,
    MAX_ROLEPLAY_LENGTH_BLOCKS,
    fallback.minBlocks,
  );
  const maxBlocks = Math.max(
    minBlocks,
    clampInt(
      raw.maxBlocks,
      MIN_ROLEPLAY_LENGTH_BLOCKS,
      MAX_ROLEPLAY_LENGTH_BLOCKS,
      Math.max(minBlocks, fallback.maxBlocks),
    ),
  );
  return { minBlocks, maxBlocks };
}

export function normalizeRoleplayLengthBlockBudgets(
  value?: Partial<RoleplayLengthBlockBudgets> | null,
): RoleplayLengthBlockBudgets {
  const defaults = DEFAULT_ROLEPLAY_LENGTH_BLOCK_BUDGETS;
  const raw = value && typeof value === "object" ? value : {};
  return {
    "-2": normalizeRoleplayLengthBlockBudget(raw["-2"], defaults["-2"]),
    "-1": normalizeRoleplayLengthBlockBudget(raw["-1"], defaults["-1"]),
    "0": normalizeRoleplayLengthBlockBudget(raw["0"], defaults["0"]),
    "1": normalizeRoleplayLengthBlockBudget(raw["1"], defaults["1"]),
    "2": normalizeRoleplayLengthBlockBudget(raw["2"], defaults["2"]),
  };
}

export function normalizeRoleplaySettings(value?: Partial<RoleplaySettings>): RoleplaySettings {
  const defaults = DEFAULT_SETTINGS.roleplay;
  return {
    performanceReasoningEffort: typeof value?.performanceReasoningEffort === "string"
      && isRoleplayReasoningChoice(value.performanceReasoningEffort)
      ? value.performanceReasoningEffort
      : defaults.performanceReasoningEffort,
    jsonReasoningEffort: typeof value?.jsonReasoningEffort === "string"
      && isReasoningEffort(value.jsonReasoningEffort)
      ? value.jsonReasoningEffort
      : defaults.jsonReasoningEffort,
    qualityFinalizeEnabled: value?.qualityFinalizeEnabled !== false,
    recentMessages: clampInt(
      value?.recentMessages,
      MIN_ROLEPLAY_RECENT_MESSAGES,
      MAX_ROLEPLAY_RECENT_MESSAGES,
      defaults.recentMessages,
    ),
    replyMaxOutputTokens: clampInt(
      value?.replyMaxOutputTokens,
      MIN_ROLEPLAY_OUTPUT_TOKENS,
      MAX_ROLEPLAY_OUTPUT_TOKENS,
      defaults.replyMaxOutputTokens,
    ),
    jsonMaxOutputTokens: clampInt(
      value?.jsonMaxOutputTokens,
      MIN_ROLEPLAY_OUTPUT_TOKENS,
      MAX_ROLEPLAY_OUTPUT_TOKENS,
      defaults.jsonMaxOutputTokens,
    ),
    lengthBlockBudgets: normalizeRoleplayLengthBlockBudgets(
      value?.lengthBlockBudgets ?? defaults.lengthBlockBudgets,
    ),
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
      writingMode: typeof raw.writingMode === "string" && isWritingExecutionMode(raw.writingMode)
        ? raw.writingMode
        : DEFAULT_SETTINGS.writingMode,
      characterEvolutionEnabled: raw.characterEvolutionEnabled !== false,
      reviewFollowsProseModel: raw.reviewFollowsProseModel !== false,
      stepBudgetMode: typeof raw.stepBudgetMode === "string" && isAgentStepBudgetMode(raw.stepBudgetMode)
        ? raw.stepBudgetMode
        : DEFAULT_SETTINGS.stepBudgetMode,
      maxAgentSteps: normalizeMaxAgentSteps(raw.maxAgentSteps, DEFAULT_SETTINGS.maxAgentSteps),
      scenePipeline: normalizeScenePipelineSettings(raw.scenePipeline),
      proseLength: normalizeProseLengthSettings(raw.proseLength),
      proseGateTimeouts: normalizeProseGateTimeoutSettings(raw.proseGateTimeouts),
      roleplay: normalizeRoleplaySettings(raw.roleplay),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, roleplay: { ...DEFAULT_SETTINGS.roleplay } };
  }
}

export function saveAgentSettings(
  project: WriterProject,
  patch: {
    permissionMode?: PermissionMode;
    writingMode?: WritingExecutionMode;
    characterEvolutionEnabled?: boolean;
    reviewFollowsProseModel?: boolean;
    stepBudgetMode?: AgentStepBudgetMode;
    maxAgentSteps?: number;
    scenePipeline?: Partial<ScenePipelineSettings>;
    proseLength?: Partial<ProseLengthSettings>;
    proseGateTimeouts?: Partial<ProseGateTimeoutSettings>;
    roleplay?: Partial<Omit<RoleplaySettings, "lengthBlockBudgets">> & {
      lengthBlockBudgets?: Partial<RoleplayLengthBlockBudgets>;
    };
  },
): AgentRuntimeSettings {
  const current = loadAgentSettings(project);
  const next: AgentRuntimeSettings = {
    permissionMode: patch.permissionMode && isPermissionMode(patch.permissionMode)
      ? patch.permissionMode
      : current.permissionMode,
    writingMode: patch.writingMode && isWritingExecutionMode(patch.writingMode)
      ? patch.writingMode
      : current.writingMode,
    characterEvolutionEnabled: typeof patch.characterEvolutionEnabled === "boolean"
      ? patch.characterEvolutionEnabled
      : current.characterEvolutionEnabled,
    reviewFollowsProseModel: typeof patch.reviewFollowsProseModel === "boolean"
      ? patch.reviewFollowsProseModel
      : current.reviewFollowsProseModel,
    stepBudgetMode: patch.stepBudgetMode && isAgentStepBudgetMode(patch.stepBudgetMode)
      ? patch.stepBudgetMode
      : current.stepBudgetMode,
    maxAgentSteps: patch.maxAgentSteps !== undefined
      ? normalizeMaxAgentSteps(patch.maxAgentSteps, current.maxAgentSteps)
      : current.maxAgentSteps,
    scenePipeline: patch.scenePipeline
      ? normalizeScenePipelineSettings({ ...current.scenePipeline, ...patch.scenePipeline })
      : current.scenePipeline,
    proseLength: patch.proseLength
      ? normalizeProseLengthSettings({ ...current.proseLength, ...patch.proseLength })
      : current.proseLength,
    proseGateTimeouts: patch.proseGateTimeouts
      ? normalizeProseGateTimeoutSettings({ ...current.proseGateTimeouts, ...patch.proseGateTimeouts })
      : current.proseGateTimeouts,
    roleplay: patch.roleplay
      ? normalizeRoleplaySettings({
          ...current.roleplay,
          ...patch.roleplay,
          lengthBlockBudgets: {
            ...current.roleplay.lengthBlockBudgets,
            ...(patch.roleplay.lengthBlockBudgets ?? {}),
          },
        })
      : current.roleplay,
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
  const untouchedScaffold = DEFAULT_WRITER_INSTRUCTIONS.trim();
  for (const relative of INSTRUCTION_CANDIDATES) {
    const absolute = resolve(project.root, relative);
    if (!existsSync(absolute)) continue;
    try {
      if (!statSync(absolute).isFile()) continue;
      const content = readFileSync(absolute, "utf8").trim();
      if (!content) continue;
      // A newly initialized project contains editing hints, not author intent.
      // Do not let those placeholders occupy a stable prompt slot as if they were rules.
      if (relative === "WRITER.md" && content === untouchedScaffold) continue;
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
  return /撰写|写第|续写|创作|起草|初稿|改写|重写|补写|第\s*\d+\s*章|第\s*[一二三四五六七八九十两零〇]+\s*章|场景正文|章节正文|第\s*\d+\s*节/.test(text);
}

/**
 * True when a tool result actually created (and possibly auto-accepted) a document
 * proposal / change set — not merely "no error key".
 *
 * Final-review blocks and style-gate throws used to be misread as success because
 * review returns `{ status, code, path }` without `error` or `proposalId`, which
 * falsely advanced chapter boundaries and closed multi-chapter todos.
 */
export function isSuccessfulDocumentSubmission(
  toolName: string,
  result: Record<string, unknown>,
): boolean {
  if ("error" in result) return false;
  const status = typeof result.status === "string" ? result.status : "";
  if (
    status === "final_review_revision_required"
    || status === "final_review_unavailable"
    || status === "proposal_failed"
    || status === "waiting"
  ) {
    return false;
  }
  const code = typeof result.code === "string" ? result.code : "";
  // RHYTHM_POLISH_REQUIRED 仍带 proposalId（首轮情节草稿），由上层单独识别，不算最终交付成功。
  if (code && /BLOCKED|UNAVAILABLE|REQUIRED|REJECTED|FAILED/i.test(code) && code !== "RHYTHM_POLISH_REQUIRED") {
    return false;
  }

  if (typeof result.proposalId === "number" && result.proposalId > 0) return true;
  if (typeof result.changeSetId === "number" && result.changeSetId > 0) return true;

  const nested = result.proposal;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nestedId = (nested as Record<string, unknown>).proposalId;
    if (typeof nestedId === "number" && nestedId > 0) return true;
  }

  // inspect_chapter_draft that already submitted a proposal inside the same call
  if (toolName === "inspect_chapter_draft" && result.proposalSubmitted === true) {
    return true;
  }
  return false;
}

export function normalizeProseGateTimeoutSettings(value?: Partial<ProseGateTimeoutSettings>): ProseGateTimeoutSettings {
  const seconds = (candidate: unknown, fallback: number) => {
    const raw = Number(candidate);
    return Number.isFinite(raw) && raw > 0
      ? Math.round(Math.min(MAX_PROSE_GATE_TIMEOUT_SECONDS, Math.max(MIN_PROSE_GATE_TIMEOUT_SECONDS, raw)))
      : fallback;
  };
  const primarySeconds = seconds(value?.primarySeconds, DEFAULT_SETTINGS.proseGateTimeouts.primarySeconds);
  const finalSeconds = Math.max(primarySeconds, seconds(value?.finalSeconds, DEFAULT_SETTINGS.proseGateTimeouts.finalSeconds));
  return { primarySeconds, finalSeconds };
}

export type AgentToolOutcome =
  | { kind: "success" }
  | { kind: "retryable_error"; message: string }
  | { kind: "interruption"; message: string }
  | { kind: "fatal_error"; message: string };

const DOCUMENT_SUBMISSION_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "move_file",
  "delete_file",
  "propose_document",
  "propose_document_patch",
  "revise_document_isolated",
  "propose_chapter_draft",
  "propose_outline_patch",
  "propose_change_set",
  "inspect_chapter_draft",
]);

/** One model-visible outcome vocabulary shared by progress, retry and completion. */
export function classifyAgentToolOutcome(
  toolName: string,
  result: Record<string, unknown> | undefined,
): AgentToolOutcome {
  if (!result) return { kind: "fatal_error", message: "工具没有返回可验证结果" };
  const message = typeof result.error === "string"
    ? result.error
    : typeof result.message === "string"
      ? result.message
      : typeof result.status === "string" ? result.status : "工具调用失败";
  if (result.status === "waiting" || result.failureKind === "dependency") {
    return { kind: "interruption", message };
  }
  if (DOCUMENT_SUBMISSION_TOOL_NAMES.has(toolName)) {
    if (result.rhythmRevisionRequired === true || result.code === "RHYTHM_POLISH_REQUIRED") {
      return { kind: "retryable_error", message };
    }
    if (isSuccessfulDocumentSubmission(toolName, result)) return { kind: "success" };
    if (result.code === "CONTRACT_MUTATION_DENIED") return { kind: "fatal_error", message };
    return { kind: "retryable_error", message };
  }
  if ("error" in result || result.status === "error" || result.status === "failed") {
    return result.retryable === false
      ? { kind: "fatal_error", message }
      : { kind: "retryable_error", message };
  }
  return { kind: "success" };
}

/** Best-effort proposal id from a successful document tool payload. */
export function proposalIdFromToolResult(result: Record<string, unknown>): number | undefined {
  if (typeof result.proposalId === "number" && result.proposalId > 0) return result.proposalId;
  const nested = result.proposal;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nestedId = (nested as Record<string, unknown>).proposalId;
    if (typeof nestedId === "number" && nestedId > 0) return nestedId;
  }
  return undefined;
}

/**
 * Writing deliverables may only be completed by a real proposal advance
 * (`persistAdvancedTodosAfterProposal`), not by optimistic manage_todos ticks.
 * Cancel / reopen / rewrite content remain allowed.
 */
export function protectDocumentWritingTodos(
  current: AgentTodoItem[],
  requested: AgentTodoItem[],
): AgentTodoItem[] {
  if (!current.length) return requested;
  const byId = new Map(current.map(item => [item.id, item]));
  return requested.map((item) => {
    const prev = byId.get(item.id);
    if (!prev) return item;
    if (item.status !== "completed" || prev.status === "completed" || prev.status === "cancelled") {
      return item;
    }
    // Match either the previous or requested label — models often rephrase while completing.
    if (isFurtherWritingTodo(prev.content) || isFurtherWritingTodo(item.content)) {
      return { ...item, status: prev.status };
    }
    return item;
  });
}

/**
 * After a document proposal succeeds: close the active step and any soft trailing
 * "submit proposal" checkboxes. If further writing steps remain, promote the next
 * one and signal the agent loop to continue instead of finalizing the whole plan.
 */
export function advanceTodosAfterProposal(
  todos: AgentTodoItem[],
  allowFurtherDocumentDelivery = true,
  remainingDeliverables: readonly string[] = [],
): {
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
  const furtherPending = allowFurtherDocumentDelivery
    ? next.filter(item => item.status === "pending" && isFurtherWritingTodo(item.content))
    : [];
  if (furtherPending.length) {
    // Only one in_progress at a time.
    for (const item of next) {
      if (item.status === "in_progress") item.status = "pending";
    }
    furtherPending[0].status = "in_progress";
    changed = true;
    return { todos: next, changed, shouldContinue: true };
  }
  if (allowFurtherDocumentDelivery && remainingDeliverables.length) {
    const usedIds = new Set(next.map(item => item.id));
    let suffix = next.length + 1;
    while (usedIds.has(`runtime-document-${suffix}`)) suffix += 1;
    next.push({
      id: `runtime-document-${suffix}`,
      content: `继续交付：${remainingDeliverables[0]}`,
      status: "in_progress",
    });
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
): { todos: AgentTodoItem[]; scenePipelineProtected: boolean; writingTodosProtected?: boolean } {
  const hasScenePipeline = SCENE_PIPELINE_TODO_SIGNATURES.some(contents =>
    current.length === contents.length
      && contents.every(content => current.some(item => item.content === content)),
  );
  if (hasScenePipeline) {
    return { todos: current, scenePipelineProtected: true };
  }
  const protectedTodos = protectDocumentWritingTodos(current, requested);
  const writingTodosProtected = protectedTodos.some((item, index) => item.status !== requested[index]?.status);
  return {
    todos: protectedTodos,
    scenePipelineProtected: false,
    ...(writingTodosProtected ? { writingTodosProtected: true } : {}),
  };
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
  allowFurtherDocumentDelivery = true,
  remainingDeliverables: readonly string[] = [],
): { todos: AgentTodoItem[]; shouldContinue: boolean } {
  const current = store.sessionTodos(sessionId);
  if (!current.length) return { todos: current, shouldContinue: false };
  const { todos, changed, shouldContinue } = advanceTodosAfterProposal(
    current,
    allowFurtherDocumentDelivery,
    remainingDeliverables,
  );
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
