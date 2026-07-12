import { loadSkillById, normalizeTodos } from "../agent_runtime.js";
import type { ToolHandlerArgs } from "./types.js";
import { requireString } from "./helpers.js";

export function handleAskUser({ input }: ToolHandlerArgs): string {
  const question = requireString(input.question, "question").slice(0, 300);
  const rawOptions = Array.isArray(input.options)
    ? input.options.filter((v): v is string => typeof v === "string").slice(0, 5)
    : [];
  const options = rawOptions.length >= 2 ? rawOptions : undefined;
  const message = options
    ? `${question}\n\n${options.map((opt, i) => `选项 ${i + 1}：${opt}`).join("\n")}`
    : question;
  return JSON.stringify({ status: "waiting", message: "问题已提交，等待用户回复", displayMessage: message, question, options: options ?? undefined });
}

export function handleManageTodos({ input, store, sessionId, emit }: ToolHandlerArgs): string {
  const todos = normalizeTodos(input.todos);
  store.saveSessionTodos(sessionId, todos);
  emit({ type: "todos", todos });
  const completed = todos.filter(item => item.status === "completed").length;
  const active = todos.filter(item => item.status === "in_progress").map(item => item.id);
  return JSON.stringify({
    todos,
    summary: { total: todos.length, completed, inProgress: active },
    message: active.length ? `任务清单已更新；进行中：${active.join("、")}` : "任务清单已更新",
  });
}

export function handleLoadSkill({ input, project }: ToolHandlerArgs): string {
  const skill = loadSkillById(project, requireString(input.id, "id"));
  if (!skill) throw new Error("未找到该技能；请核对系统提示中的技能目录");
  return JSON.stringify({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    content: skill.body,
  });
}
