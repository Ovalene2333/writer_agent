import { loadSkillById, normalizeTodos } from "../agent_runtime.js";
import { chapterSceneDraftComplete, nextChapterScene } from "../scene_pipeline.js";
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

export function handleManageTodos({ input, store, sessionId, emit, context }: ToolHandlerArgs): string {
  const todos = normalizeTodos(input.todos);
  store.saveSessionTodos(sessionId, todos);
  emit({ type: "todos", todos });
  const completed = todos.filter(item => item.status === "completed").length;
  const active = todos.filter(item => item.status === "in_progress").map(item => item.id);
  // Steer the model off planning-only steps while a scene draft is mid-flight.
  const draft = context.chapterSceneDraft;
  const nextScene = draft && !chapterSceneDraftComplete(draft) ? nextChapterScene(draft) : undefined;
  const draftNudge = draft
    ? nextScene
      ? `章节场景草稿进行中（${draft.completed.length}/${draft.scenes.length}），内置阶段由工具结果自动推进；下一步直接调用 write_chapter_scene（sceneId=${nextScene.id}），要点直接写进 notes 参数，勿再为规划单独消耗步骤。`
      : "章节场景已全部写完；下一步直接调用 inspect_chapter_draft，勿再为勾选清单单独消耗步骤。"
    : "";
  return JSON.stringify({
    todos,
    summary: { total: todos.length, completed, inProgress: active },
    message: [
      active.length ? `任务清单已更新；进行中：${active.join("、")}` : "任务清单已更新",
      draftNudge,
    ].filter(Boolean).join(" "),
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

export function handleReadContextArtifact({ input, store, sessionId }: ToolHandlerArgs): string {
  const artifactId = Number(input.artifactId);
  if (!Number.isInteger(artifactId) || artifactId <= 0) throw new Error("artifactId 必须是正整数");
  const artifact = store.contextArtifactById(sessionId, artifactId);
  if (!artifact) throw new Error("工作记忆不存在或不属于当前会话");
  const offset = Math.max(0, Math.floor(Number(input.offset ?? 0)) || 0);
  const limit = Math.max(500, Math.min(6_000, Math.floor(Number(input.limit ?? 4_000)) || 4_000));
  const content = artifact.content.slice(offset, offset + limit);
  return JSON.stringify({
    status: "artifact_page",
    artifactId,
    kind: artifact.kind,
    path: artifact.path,
    sourceHash: artifact.sourceHash,
    offset,
    nextOffset: offset + content.length,
    totalCharacters: artifact.content.length,
    hasMore: offset + content.length < artifact.content.length,
    content,
    message: "仅在当前页不足以完成任务时读取下一页；禁止从头重复读取。",
  });
}
