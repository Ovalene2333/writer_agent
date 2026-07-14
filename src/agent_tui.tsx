import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { runAgent } from "./agent.js";
import {
  formatTodosForPrompt,
  isPermissionMode,
  listProjectSkills,
  loadAgentSettings,
  loadProjectInstructions,
  permissionModeLabel,
  saveAgentSettings,
} from "./agent_runtime.js";
import { parseCharacterCommand, parseCommand, parseStyleCommand, referencedDocumentQuery, SLASH_COMMANDS, suggestCommands } from "./commands.js";
import { emptyCharacter } from "./characters.js";
import { WriterProject } from "./project.js";
import { ProviderManager } from "./provider_catalog.js";
import { runRoleplayChat, type RoleplayTarget } from "./roleplay.js";
import { WriterStore } from "./store.js";
import { getStyleTemplate, listStyleTemplates } from "./templates.js";
import {
  CONNECT_PRESETS,
  filterModelChoices,
  formatProviderCatalog,
  formatRoleAssignments,
  listModelChoices,
  MODEL_ROLES,
  resolveModelChoice,
  type ConnectPreset,
  type ModelChoice,
} from "./tui_models.js";
import {
  formatActiveStepHint,
  formatStepHeader,
  formatStepUsageDetail,
  truncateForDisplay,
  type UiStep,
} from "./tui_steps.js";
import type { AgentEvent, AgentTodoItem, ModelUsageRole, PermissionMode, ProviderId } from "./types.js";

type Suggestion = { value: string; label: string; detail: string; kind: "command" | "document" };

type Overlay =
  | { kind: "models"; index: number }
  | { kind: "roles"; index: number }
  | { kind: "role-models"; role: Exclude<ModelUsageRole, "drafter">; index: number }
  | { kind: "connect"; index: number }
  | { kind: "connect-url"; preset: ConnectPreset }
  | { kind: "connect-key"; name: string; provider: ProviderId; baseUrl: string; models: string[] }
  | { kind: "connect-model"; name: string; provider: ProviderId; baseUrl: string; apiKey: string };

const OUTPUT_LIMIT = 80;

export function WriterAgentTui(props: {
  project: WriterProject;
  store: WriterStore;
  providers: ProviderManager;
  sessionId: string;
  permissionMode?: PermissionMode;
}) {
  const { exit } = useApp();
  const [sessionId, setSessionId] = useState(props.sessionId);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => props.permissionMode ?? loadAgentSettings(props.project).permissionMode,
  );
  const [todos, setTodos] = useState<AgentTodoItem[]>(() => props.store.sessionTodos(props.sessionId));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const [showThinking, setShowThinking] = useState(true);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [steps, setSteps] = useState<UiStep[]>([]);
  const [modelTick, setModelTick] = useState(0);
  const [roleplay, setRoleplay] = useState<RoleplayTarget | null>(null);
  const [history, setHistory] = useState(() => props.store.messages(props.sessionId, 100).filter(item => item.role === "user").map(item => item.content));
  const [historyIndex, setHistoryIndex] = useState(-1);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const runProposalsRef = useRef<number[]>([]);
  const stepsRef = useRef<UiStep[]>([]);
  const instructions = loadProjectInstructions(props.project);
  const [output, setOutput] = useState<string[]>([
    `已打开《${props.project.config().title}》`,
    `模式：${permissionModeLabel(permissionMode)} · 输入 / 查看命令，@ 引用文档。`,
    instructions ? `已加载项目指令：${instructions.path}` : "未找到 WRITER.md / AGENTS.md（可选）",
    "模型：/models 选择 · /connect 添加供应商 · /roles 分工 · /thinking 思考过程",
    "测试：/roleplay <角色> 进入角色扮演试演 · /roleplay off 退出",
  ]);

  const pendingProposals = useMemo(() => props.store.proposals("pending"), [output, props.store]);
  const usage = useMemo(() => props.store.usage(sessionId), [output, props.store, sessionId]);
  const publicConfig = useMemo(() => props.providers.publicConfig(), [modelTick, props.providers, output]);
  const modelChoices = useMemo(() => listModelChoices(props.providers), [modelTick, props.providers, overlay]);
  const filteredModels = useMemo(
    () => filterModelChoices(modelChoices, overlay?.kind === "models" || overlay?.kind === "role-models" ? input : ""),
    [modelChoices, overlay, input],
  );
  const suggestions = useMemo<Suggestion[]>(() => {
    if (overlay || busy || reviewIndex !== null) return [];
    const documentQuery = referencedDocumentQuery(input);
    if (documentQuery !== undefined) {
      const query = documentQuery.toLowerCase();
      return props.project.listDocuments().filter(path => !query || path.toLowerCase().includes(query)).slice(0, 8)
        .map(path => ({ value: path, label: `@${path}`, detail: "添加文档上下文", kind: "document" as const }));
    }
    return suggestCommands(input).map(command => ({
      value: command.name, label: command.usage,
      detail: `${command.category} · ${command.description}${command.shortcut ? ` · ${command.shortcut}` : ""}`,
      kind: "command" as const,
    }));
  }, [busy, overlay, input, props.project, reviewIndex]);

  useEffect(() => setSelectedSuggestion(0), [input]);
  useEffect(() => { stepsRef.current = steps; }, [steps]);

  const refreshModels = useCallback(() => setModelTick(value => value + 1), []);
  const append = useCallback((text: string) => setOutput(lines => [...lines, text].slice(-OUTPUT_LIMIT)), []);
  const appendError = useCallback((error: unknown) => append(`错误：${error instanceof Error ? error.message : String(error)}`), [append]);
  const cancel = useCallback(() => {
    if (!busy) return;
    abortRef.current?.abort();
    append("正在中断当前作业…");
  }, [busy, append]);

  const applySuggestion = useCallback((suggestion?: Suggestion) => {
    if (!suggestion) return;
    if (suggestion.kind === "document") setInput(value => value.replace(/@[^\s]*$/, `@${suggestion.value} `));
    else {
      const command = SLASH_COMMANDS.find(item => item.name === suggestion.value)!;
      setInput(command.usage.includes("<") || command.usage.includes("[") ? `/${command.name} ` : `/${command.name}`);
    }
  }, []);

  const acceptProposal = useCallback((id: number) => {
    try {
      const item = props.store.acceptProposal(id);
      append(`✓ 已接受提案 #${item.id}：${item.path}`);
    } catch (error) { appendError(error); }
  }, [props.store, append, appendError]);
  const rejectProposal = useCallback((id: number) => {
    try {
      const item = props.store.rejectProposal(id);
      append(`✗ 已拒绝提案 #${item.id}`);
    } catch (error) { appendError(error); }
  }, [props.store, append, appendError]);

  const enterReview = useCallback(() => {
    const ids = pendingProposals.map(p => p.id);
    if (!ids.length) return;
    const newIds = ids.filter(id => !runProposalsRef.current.includes(id));
    runProposalsRef.current = ids;
    setReviewIndex(newIds.length ? ids.indexOf(newIds[0]) : 0);
  }, [pendingProposals]);

  const openModels = useCallback((prefill = "") => {
    setOverlay({ kind: "models", index: 0 });
    setInput(prefill);
  }, []);

  const selectModel = useCallback((choice: ModelChoice) => {
    try {
      const config = props.providers.select(choice.providerId, choice.modelId);
      refreshModels();
      setOverlay(null);
      setInput("");
      append(`已切换模型：${choice.providerName} / ${config.model}`);
    } catch (error) { appendError(error); }
  }, [props.providers, refreshModels, append, appendError]);

  const assignRoleModel = useCallback((role: Exclude<ModelUsageRole, "drafter">, choice: ModelChoice) => {
    try {
      props.providers.assign(role, choice.providerId, choice.modelId);
      refreshModels();
      setOverlay(null);
      setInput("");
      const roleName = MODEL_ROLES.find(item => item.id === role)?.name ?? role;
      append(`已分配 ${roleName} → ${choice.providerName} / ${choice.modelName}`);
    } catch (error) { appendError(error); }
  }, [props.providers, refreshModels, append, appendError]);

  const finishConnect = useCallback((draft: {
    name: string;
    provider: ProviderId;
    baseUrl: string;
    apiKey: string;
    models: string[];
  }) => {
    try {
      const models = draft.models.length ? draft.models : ["default-model"];
      const catalog = props.providers.saveProfile({
        name: draft.name,
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
        models: models.map(name => ({ name })),
      });
      const profile = catalog.providers.find(item => item.name === draft.name) ?? catalog.providers.at(-1)!;
      const first = profile.models[0];
      props.providers.select(profile.id, first.id);
      refreshModels();
      setOverlay(null);
      setInput("");
      append(`已接入 ${profile.name} / ${first.name}（共 ${profile.models.length} 个模型）\n可用 /models 切换，/roles 分配写作分工。`);
    } catch (error) { appendError(error); }
  }, [props.providers, refreshModels, append, appendError]);

  const patchStreamingLine = useCallback((prefix: string, text: string) => {
    setOutput(lines => {
      const copy = [...lines];
      const last = copy.at(-1) ?? "";
      if (last.startsWith(prefix)) copy[copy.length - 1] = last + text;
      else copy.push(`${prefix}${text}`);
      return copy.slice(-OUTPUT_LIMIT);
    });
  }, []);

  const handleEvent = useCallback((event: AgentEvent) => {
    if (event.type === "step_start") {
      setSteps(current => {
        if (current.some(item => item.id === event.step)) return current;
        return [...current, { id: event.step, status: "running", tools: [], reasoning: "", output: "" }];
      });
      if (showDetails) append(`── Step ${event.step} ──`);
      return;
    }
    if (event.type === "text") {
      const channel = event.channel === "reasoning" ? "reasoning" : "output";
      setSteps(current => {
        const idx = current.findIndex(item => item.status === "running");
        if (idx < 0) return current;
        return current.map((item, i) => i === idx ? { ...item, [channel]: item[channel] + event.text } : item);
      });
      if (channel === "reasoning") {
        if (showThinking) patchStreamingLine("思考：", event.text);
      } else {
        patchStreamingLine("AI：", event.text);
      }
      return;
    }
    if (event.type === "tool") {
      setSteps(current => {
        const idx = current.findIndex(item => item.status === "running");
        if (idx < 0) return current;
        return current.map((item, i) => i === idx ? { ...item, tools: [...item.tools, event.name] } : item);
      });
      if (showDetails) append(`  ⚙ ${event.name}`);
      return;
    }
    if (event.type === "usage") {
      if (event.call) {
        const call = event.call;
        setSteps(current => {
          const idx = event.step != null
            ? current.findIndex(item => item.id === event.step)
            : current.findIndex(item => item.status === "running");
          if (idx < 0) return current;
          return current.map((item, i) => i === idx ? { ...item, usage: call } : item);
        });
        if (showDetails) append(`  ${formatStepUsageDetail(call)}`);
      }
      // Session totals refresh via store.usage on next output change
      return;
    }
    if (event.type === "step_done") {
      setSteps(current => {
        const next = current.map(item => item.id === event.step ? { ...item, status: "completed" as const } : item);
        if (showDetails) {
          const done = next.find(item => item.id === event.step);
          if (done) append(formatStepHeader(done));
        }
        return next;
      });
      return;
    }
    if (event.type === "error") {
      setSteps(current => current.map(item => item.status === "running" ? { ...item, status: "failed" as const } : item));
      append(`错误：${event.message}`);
      return;
    }
    if (event.type === "proposal") {
      const mark = event.proposal.status === "accepted" ? "✓ 已写入" : "待审批";
      append(`${mark}提案 #${event.proposal.id}：${event.proposal.path} · ${event.proposal.summary}`);
      return;
    }
    if (event.type === "todos") {
      setTodos(event.todos);
      if (showDetails) append(`任务清单：\n${formatTodosForPrompt(event.todos)}`);
      return;
    }
    if (event.type === "mode") {
      setPermissionMode(event.mode);
      return;
    }
    if (event.type === "waiting_for_input") {
      append(`需要补充信息：${event.question}${event.options?.length ? `\n选项：${event.options.join(" | ")}` : ""}`);
      return;
    }
    if (event.type === "cancelled") {
      setSteps(current => current.map(item => item.status === "running" ? { ...item, status: "failed" as const } : item));
      append("当前作业已中断，已完成的提案和输出予以保留。");
      return;
    }
    if (event.type === "done") {
      // Final session usage line
      const summary = props.store.usage(sessionId);
      append(`用量：${summary.totalTokens.toLocaleString()} Token · ${summary.currency === "CNY" ? "¥" : "$"}${summary.cost.toFixed(6)}`);
    }
  }, [showDetails, showThinking, append, patchStreamingLine, props.store, sessionId]);

  const executeCommand = useCallback(async (name: string, args: string) => {
    try {
      if (name === "exit") return exit();
      if (name === "help") append(SLASH_COMMANDS.map(item => `${item.usage.padEnd(26)} ${item.description}`).join("\n"));
      else if (name === "screen") setOutput([]);
      else if (name === "stop") busy ? cancel() : append("当前没有正在执行的作业");
      else if (name === "new") {
        const id = props.store.createSession(args || "新会话");
        setSessionId(id); setHistory([]); setTodos([]); setSteps([]); setRoleplay(null); setOutput([`已创建会话：${id.slice(0, 8)}`]);
      } else if (name === "sessions") {
        append(props.store.listSessions().map(item => `${item.id.slice(0, 8)}  ${item.updatedAt.slice(0, 16).replace("T", " ")}  ${item.title}`).join("\n") || "没有历史会话");
      } else if (name === "resume") {
        const matches = props.store.listSessions().filter(item => item.id.startsWith(args));
        if (!args || matches.length !== 1) throw new Error(matches.length > 1 ? "会话 ID 前缀不唯一" : "找不到指定会话");
        setSessionId(matches[0].id);
        setTodos(props.store.sessionTodos(matches[0].id));
        setSteps([]);
        setRoleplay(null);
        const messages = props.store.messages(matches[0].id, 30);
        setHistory(messages.filter(item => item.role === "user").map(item => item.content));
        setOutput(messages.map(item => `${item.role === "user" ? "你" : "AI"}：${item.content}`).slice(-OUTPUT_LIMIT));
      } else if (name === "status") {
        const todoSummary = todos.length
          ? `${todos.filter(t => t.status === "completed").length}/${todos.length} 完成`
          : "无";
        const roleplayLine = roleplay ? `扮演：${roleplay.name}（#${roleplay.characterId}）` : "扮演：关闭";
        append(`项目：${props.project.config().title}\n会话：${sessionId}\n模式：${permissionModeLabel(permissionMode)}\n${roleplayLine}\n模型：${publicConfig.provider}/${publicConfig.model}\n文档：${props.project.listDocuments().length}\n待审批：${pendingProposals.length}\n任务：${todoSummary}\n指令：${instructions?.path ?? "无"}`);
      } else if (name === "roleplay") {
        const query = args.trim();
        if (!query || /^(off|exit|quit|end|退出|结束|关闭)$/i.test(query)) {
          if (!roleplay) append("当前未在角色扮演中。用法：/roleplay <角色名或ID>");
          else {
            setRoleplay(null);
            append(`已退出角色扮演（${roleplay.name}）。`);
          }
        } else {
          const item = props.store.findCharacter(query);
          if (!item) throw new Error(`找不到角色卡：${query}。可用 /character list 查看`);
          setRoleplay({ characterId: item.id, name: item.identity.name });
          append(`【测试】已进入角色扮演：${item.identity.name}（#${item.id}）\n直接说话即可试演人设；/roleplay off 退出。纯对话，不会改文档。`);
        }
      } else if (name === "mode") {
        if (!args) {
          append(`当前模式：${permissionModeLabel(permissionMode)}\n可选：ask（审批）· auto（自动写入）· plan（只读规划）`);
        } else if (!isPermissionMode(args)) {
          throw new Error("用法：/mode [ask|auto|plan]");
        } else {
          const next = saveAgentSettings(props.project, { permissionMode: args });
          setPermissionMode(next.permissionMode);
          append(`已切换模式：${permissionModeLabel(next.permissionMode)}`);
        }
      } else if (name === "plan") {
        const next = saveAgentSettings(props.project, { permissionMode: "plan" });
        setPermissionMode(next.permissionMode);
        append(`已进入 plan 模式：${permissionModeLabel(next.permissionMode)}`);
      } else if (name === "todos") {
        const current = props.store.sessionTodos(sessionId);
        setTodos(current);
        append(current.length ? formatTodosForPrompt(current) : "当前会话没有任务清单");
      } else if (name === "skills") {
        const skills = listProjectSkills(props.project);
        append(skills.length
          ? skills.map(item => `${item.id.padEnd(16)} ${item.name}${item.description ? ` · ${item.description}` : ""}`).join("\n")
          : "未找到技能。可在 .writer/skills/<id>/SKILL.md 或 .agents/skills/<id>/SKILL.md 添加");
      } else if (name === "context") {
        const pricing = props.providers.publicConfig().pricing;
        append(`最近上下文：${usage.lastPromptTokens.toLocaleString()} / ${pricing.contextWindow.toLocaleString()} Token（${(usage.lastPromptTokens / pricing.contextWindow * 100).toFixed(2)}%）\n包含系统规则、角色卡、写作示例、最近消息、检索片段和 @ 引用文档。`);
      } else if (name === "usage") {
        append(`输入 ${usage.promptTokens.toLocaleString()} · 输出 ${usage.completionTokens.toLocaleString()} · 缓存命中 ${usage.cacheHitTokens.toLocaleString()} · 真实命中率 ${(usage.cacheHitRate * 100).toFixed(1)}% · 总计 ${usage.totalTokens.toLocaleString()} Token · ${usage.currency === "CNY" ? "¥" : "$"}${usage.cost.toFixed(6)}`);
        const recent = stepsRef.current.slice(-5);
        if (recent.length) {
          append(recent.map(step => formatStepHeader(step)).join("\n"));
        }
      } else if (name === "character") {
        const command = parseCharacterCommand(args);
        if (command.action === "list") append(props.store.characters().map(item => `${item.id}  ${item.identity.name}  ${item.identity.narrativeRole}`).join("\n") || "characters/ 目录中没有角色卡");
        else if (command.action === "show") {
          const item = props.store.findCharacter(command.values.join(" "));
          if (!item) throw new Error("找不到角色卡");
          append(JSON.stringify(item, null, 2));
        } else if (command.action === "create") {
          const [characterName, role = "", description = ""] = command.values;
          if (!characterName) throw new Error("用法：/character create 姓名 | 定位 | 性格、背景和目标");
          const draft = emptyCharacter(characterName);
          props.store.saveCharacter({ ...draft, identity: { ...draft.identity, narrativeRole: role }, psychology: { ...draft.psychology, summary: description } });
          append(`已创建角色卡：characters/${characterName}.json`);
        } else if (command.action === "delete") {
          const item = props.store.findCharacter(command.values.join(" "));
          if (!item) throw new Error("找不到角色卡");
          props.store.deleteCharacter(item.id); append(`已删除角色卡：${item.identity.name}`);
        } else throw new Error("用法：/character <create|list|show|delete>");
      } else if (name === "style") {
        const command = parseStyleCommand(args);
        if (command.action === "list") {
          const active = props.project.config().style || "";
          append(listStyleTemplates().map(item => `${active === item.id ? "* " : "  "}${item.id.padEnd(18)} ${item.name} · ${item.description}`).join("\n") || "没有可用风格模板");
        } else if (command.action === "set") {
          if (!command.styleId) throw new Error("用法：/style set <模板ID>");
          const template = getStyleTemplate(command.styleId);
          if (!template) throw new Error(`未知风格模板：${command.styleId}`);
          props.project.setStyle(command.styleId);
          props.store.seedStyleExample(template);
          const current = props.providers.publicConfig();
          props.providers.save({
            provider: current.provider,
            baseUrl: current.baseUrl,
            model: current.model,
            temperature: template.suggestedTemperature,
            topP: template.suggestedTopP,
          });
          refreshModels();
          append(`已激活风格模板：${template.name}\n已注入写作示例：${template.exampleContent.slice(0, 80)}…\n建议 temperature=${template.suggestedTemperature} topP=${template.suggestedTopP} 已自动应用`);
        } else if (command.action === "off") {
          props.project.setStyle("");
          append("已取消风格模板");
        } else throw new Error("用法：/style <list|set <id>|off>");
      } else if (name === "docs") {
        const query = args.toLowerCase();
        append(props.project.listDocuments().filter(path => !query || path.toLowerCase().includes(query)).join("\n") || "没有匹配文档");
      } else if (name === "read") append(args ? `${args}\n${truncateForDisplay(props.project.read(args), 8_000)}` : "用法：/read <文档路径>");
      else if (name === "search") {
        if (!args) throw new Error("用法：/search <关键词>");
        const results = props.store.search(args, 10);
        append(results.map(item => `${item.path}：${item.excerpt}`).join("\n") || "没有检索结果");
      } else if (name === "connect") {
        setOverlay({ kind: "connect", index: 0 });
        setInput("");
      } else if (name === "provider") {
        append(formatProviderCatalog(props.providers));
      } else if (name === "models") {
        if (!args.trim()) {
          openModels();
          return;
        }
        const choice = resolveModelChoice(props.providers, args);
        if (choice) {
          selectModel(choice);
          return;
        }
        const matches = filterModelChoices(listModelChoices(props.providers), args);
        if (!matches.length) throw new Error(`找不到模型：${args}。用 /models 打开选择器，或 /connect 添加供应商。`);
        if (matches.length === 1) {
          selectModel(matches[0]);
          return;
        }
        openModels(args);
      } else if (name === "roles") {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (!parts.length) {
          append(formatRoleAssignments(props.providers));
          setOverlay({ kind: "roles", index: 0 });
          setInput("");
          return;
        }
        const roleId = parts[0].toLowerCase() as Exclude<ModelUsageRole, "drafter">;
        if (!MODEL_ROLES.some(item => item.id === roleId)) {
          throw new Error(`用法：/roles [agent|roleplay|inline|writer|reviewer|summarizer] [模型]\n${formatRoleAssignments(props.providers)}`);
        }
        if (parts.length === 1) {
          setOverlay({ kind: "role-models", role: roleId, index: 0 });
          setInput("");
          return;
        }
        const choice = resolveModelChoice(props.providers, parts.slice(1).join(" "));
        if (!choice) throw new Error(`找不到模型：${parts.slice(1).join(" ")}`);
        assignRoleModel(roleId, choice);
      } else if (name === "test") {
        setBusy(true);
        try {
          if (!args.trim()) {
            append((await props.providers.testConnection()).message);
          } else {
            const choice = resolveModelChoice(props.providers, args);
            if (!choice) throw new Error(`找不到模型：${args}`);
            append((await props.providers.testConnection(choice.providerId, choice.modelId)).message);
          }
        } finally { setBusy(false); }
      } else if (name === "proposals") {
        append(pendingProposals.length ? pendingProposals.map(item => `#${item.id} ${item.path} · ${item.summary}`).join("\n") : "没有待审批提案");
      } else if (name === "accept" || name === "reject") {
        const id = Number(args);
        if (!Number.isInteger(id)) throw new Error(`用法：/${name} <编号>`);
        name === "accept" ? acceptProposal(id) : rejectProposal(id);
      } else if (name === "undo") append(`已撤销：${props.store.undo(sessionId)}`);
      else if (name === "redo") append(`已重做：${props.store.redo(sessionId)}`);
      else if (name === "export") {
        if (args !== "md" && args !== "txt") throw new Error("用法：/export <md|txt>");
        append(`已导出：${props.project.exportTo(args)}`);
      } else if (name === "details") {
        setShowDetails(value => !value);
        append(`Agent step / 工具详情已${showDetails ? "隐藏" : "显示"}`);
      } else if (name === "thinking") {
        setShowThinking(value => !value);
        append(`模型 reasoning 已${showThinking ? "隐藏" : "显示"}`);
      } else append(`未知命令：/${name}。输入 / 查看命令索引。`);
    } catch (error) { appendError(error); }
  }, [
    busy, cancel, exit, append, appendError, acceptProposal, rejectProposal, pendingProposals, usage, props,
    sessionId, showDetails, showThinking, permissionMode, roleplay, todos, instructions, publicConfig, openModels, selectModel, assignRoleModel, refreshModels,
  ]);

  const handleOverlaySubmit = useCallback((raw: string) => {
    if (!overlay) return;
    const text = raw.trim();

    if (overlay.kind === "models") {
      const list = filterModelChoices(listModelChoices(props.providers), text);
      const choice = list[overlay.index] ?? list[0];
      if (!choice) { appendError("没有可切换的模型。先用 /connect 添加供应商。"); return; }
      selectModel(choice);
      return;
    }

    if (overlay.kind === "role-models") {
      const list = filterModelChoices(listModelChoices(props.providers), text);
      const choice = list[overlay.index] ?? list[0];
      if (!choice) { appendError("没有可用模型。"); return; }
      assignRoleModel(overlay.role, choice);
      return;
    }

    if (overlay.kind === "roles") {
      const role = MODEL_ROLES[overlay.index] ?? MODEL_ROLES[0];
      setOverlay({ kind: "role-models", role: role.id, index: 0 });
      setInput("");
      return;
    }

    if (overlay.kind === "connect") {
      const preset = CONNECT_PRESETS[overlay.index] ?? CONNECT_PRESETS[0];
      if (preset.customUrl) {
        setOverlay({ kind: "connect-url", preset });
        setInput("https://");
        return;
      }
      setOverlay({
        kind: "connect-key",
        name: preset.name,
        provider: preset.provider,
        baseUrl: preset.baseUrl,
        models: preset.models,
      });
      setInput("");
      return;
    }

    if (overlay.kind === "connect-url") {
      if (!text) { appendError("请输入 API Base URL"); return; }
      setOverlay({
        kind: "connect-key",
        name: "Custom",
        provider: overlay.preset.provider,
        baseUrl: text,
        models: [],
      });
      setInput("");
      return;
    }

    if (overlay.kind === "connect-key") {
      if (!text) { appendError("API Key 不能为空"); return; }
      if (!overlay.models.length) {
        setOverlay({
          kind: "connect-model",
          name: overlay.name,
          provider: overlay.provider,
          baseUrl: overlay.baseUrl,
          apiKey: text,
        });
        setInput("");
        return;
      }
      finishConnect({
        name: overlay.name,
        provider: overlay.provider,
        baseUrl: overlay.baseUrl,
        apiKey: text,
        models: overlay.models,
      });
      return;
    }

    if (overlay.kind === "connect-model") {
      if (!text) { appendError("请输入至少一个模型名称"); return; }
      const models = text.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean);
      let displayName = overlay.name;
      if (displayName === "Custom") {
        try { displayName = new URL(overlay.baseUrl).hostname || "Custom"; }
        catch { displayName = "Custom"; }
      }
      finishConnect({
        name: displayName,
        provider: overlay.provider,
        baseUrl: overlay.baseUrl,
        apiKey: overlay.apiKey,
        models,
      });
    }
  }, [overlay, props.providers, selectModel, assignRoleModel, finishConnect, appendError]);

  useInput((character, key) => {
    if ((key.escape || (key.ctrl && character === "c")) && busy) return cancel();
    if (key.ctrl && character === "p" && !busy && reviewIndex === null && !overlay) {
      openModels();
      return;
    }
    if (key.escape && overlay) {
      setOverlay(null);
      setInput("");
      return;
    }
    if (key.escape && reviewIndex !== null) { setReviewIndex(null); return; }
    if (key.ctrl && character === "d" && !busy && reviewIndex === null && !overlay) return exit();

    if (overlay?.kind === "models" || overlay?.kind === "role-models" || overlay?.kind === "roles" || overlay?.kind === "connect") {
      const max =
        overlay.kind === "models" || overlay.kind === "role-models"
          ? Math.max(filterModelChoices(listModelChoices(props.providers), input).length - 1, 0)
          : overlay.kind === "roles"
            ? MODEL_ROLES.length - 1
            : CONNECT_PRESETS.length - 1;
      if (key.upArrow) {
        setOverlay(current => current && "index" in current ? { ...current, index: (current.index - 1 + max + 1) % (max + 1) } as Overlay : current);
        return;
      }
      if (key.downArrow) {
        setOverlay(current => current && "index" in current ? { ...current, index: (current.index + 1) % (max + 1) } as Overlay : current);
        return;
      }
      return;
    }

    if (reviewIndex !== null) {
      if (character === "a") { acceptProposal(pendingProposals[reviewIndex].id); return; }
      if (character === "r") { rejectProposal(pendingProposals[reviewIndex].id); return; }
      if (character === "q" || key.escape) { setReviewIndex(null); return; }
      if (key.leftArrow || (key.upArrow && !key.ctrl)) setReviewIndex(i => i !== null ? (i - 1 + pendingProposals.length) % pendingProposals.length : 0);
      if (key.rightArrow || key.downArrow) setReviewIndex(i => i !== null ? (i + 1) % pendingProposals.length : 0);
      return;
    }
    if (key.escape && !busy) { setInput(""); setHistoryIndex(-1); return; }
    if (key.tab && suggestions.length) return applySuggestion(suggestions[selectedSuggestion]);
    if ((key.upArrow || key.downArrow) && suggestions.length) {
      setSelectedSuggestion(index => key.upArrow ? (index - 1 + suggestions.length) % suggestions.length : (index + 1) % suggestions.length);
      return;
    }
    if (key.upArrow && !suggestions.length && history.length) {
      const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next); setInput(history[next]); return;
    }
    if (key.downArrow && !suggestions.length && historyIndex >= 0) {
      const next = historyIndex + 1;
      if (next >= history.length) { setHistoryIndex(-1); setInput(""); }
      else { setHistoryIndex(next); setInput(history[next]); }
    }
  });

  // Keep list selection in range when filter shrinks
  useEffect(() => {
    if (!overlay || (overlay.kind !== "models" && overlay.kind !== "role-models")) return;
    const max = Math.max(filteredModels.length - 1, 0);
    if (overlay.index > max) setOverlay({ ...overlay, index: max });
  }, [filteredModels.length, overlay]);

  const submit = useCallback(async (value: string) => {
    if (overlay) {
      handleOverlaySubmit(value);
      return;
    }
    const text = value.trim();
    setInput(""); setHistoryIndex(-1);
    if (!text || busy) return;
    if (reviewIndex !== null) { setReviewIndex(null); return; }
    const command = parseCommand(text);
    if (command) return executeCommand(command.name, command.args);
    setHistory(items => [...items, text].slice(-200));
    runProposalsRef.current = pendingProposals.map(p => p.id);
    setSteps([]);
    setBusy(true); append(`你：${text}`);
    const controller = new AbortController(); abortRef.current = controller;
    try {
      if (roleplay) {
        await runRoleplayChat({
          project: props.project,
          store: props.store,
          sessionId,
          characterId: roleplay.characterId,
          prompt: text,
          model: props.providers.modelConfig("roleplay"),
          signal: controller.signal,
          onEvent: handleEvent,
        });
      } else {
        await runAgent({
          project: props.project,
          store: props.store,
          sessionId,
          prompt: text,
          maxTurns: 20,
          permissionMode,
          models: {
            agent: props.providers.modelConfig("agent"),
            writer: props.providers.modelConfig("writer"),
            inline: props.providers.modelConfig("inline"),
            reviewer: props.providers.modelConfig("reviewer"),
            summarizer: props.providers.summaryModelConfig(),
          },
          signal: controller.signal,
          onEvent: handleEvent,
        });
      }
    } catch (error) { appendError(error); }
    finally {
      abortRef.current = undefined;
      setBusy(false);
      // Force usage refresh in header
      setOutput(lines => [...lines]);
      if (!roleplay && permissionMode === "ask") enterReview();
    }
  }, [
    overlay, handleOverlaySubmit, busy, reviewIndex, pendingProposals, sessionId, props, append, appendError,
    handleEvent, executeCommand, enterReview, permissionMode, roleplay,
  ]);

  const reviewing = reviewIndex !== null && pendingProposals.length > 0;
  const current = reviewing ? pendingProposals[reviewIndex!] : undefined;
  const todoHint = todos.length
    ? ` · 任务 ${todos.filter(t => t.status === "completed").length}/${todos.length}`
    : "";
  const stepHint = formatActiveStepHint(steps);
  const keyMask = overlay?.kind === "connect-key" ? "*" : undefined;
  const promptLabel = (() => {
    if (busy) return "生成中（Esc/Ctrl+C 中断）…";
    if (reviewing) return "审查提案中";
    if (overlay?.kind === "models") return "筛选模型：";
    if (overlay?.kind === "role-models") return "筛选模型：";
    if (overlay?.kind === "roles") return "选择分工（Enter）：";
    if (overlay?.kind === "connect") return "选择供应商（Enter）：";
    if (overlay?.kind === "connect-url") return "Base URL：";
    if (overlay?.kind === "connect-key") return "API Key：";
    if (overlay?.kind === "connect-model") return "模型名（逗号分隔）：";
    if (roleplay) return `[RP ${roleplay.name}] `;
    return "> ";
  })();

  return <Box flexDirection="column" paddingX={1}>
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold color="cyan">Writer Agent</Text>
      <Text dimColor>
        会话 {sessionId.slice(0, 8)} · {permissionMode} · {publicConfig.model}
        {" · "}{usage.totalTokens.toLocaleString()} Token · {usage.currency === "CNY" ? "¥" : "$"}{usage.cost.toFixed(4)}
        {" · "}待审批 {pendingProposals.length}{todoHint}{stepHint}
        {reviewing ? ` · 审查中 ${reviewIndex! + 1}/${pendingProposals.length}` : ""}
        {roleplay ? ` · RP ${roleplay.name}` : ""}
      </Text>
      <Text dimColor>
        details {showDetails ? "on" : "off"} · thinking {showThinking ? "on" : "off"}
        {publicConfig.apiKeyConfigured ? "" : " · ⚠ 未配置 API Key（/connect）"}
        {roleplay ? " · 角色扮演试演中（/roleplay off 退出）" : ""}
      </Text>
    </Box>

    <Box flexDirection="column" paddingY={1}>
      {output.map((line, index) => {
        const dim = line.startsWith("思考：") || line.startsWith("  ⚙") || line.startsWith("── Step") || line.startsWith("  本步");
        const color = line.startsWith("思考：") ? "gray" as const
          : line.startsWith("  ⚙") ? "magenta" as const
            : line.startsWith("错误：") ? "red" as const
              : undefined;
        return <Text key={`${index}-${line.slice(0, 24)}`} dimColor={dim && !color} color={color}>{line}</Text>;
      })}
    </Box>

    {reviewing && current && <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">提案 #{current.id}：{current.path}</Text>
      <Text>{current.summary}</Text>
      <Box marginTop={1}>
        <Text>变更：</Text>
        <Text color="red" strikethrough>{current.beforeContent.slice(0, 200).replace(/\n/g, " ")}</Text>
      </Box>
      <Box><Text color="green">{current.afterContent.slice(0, 200).replace(/\n/g, " ")}</Text></Box>
      <Box marginTop={1}>
        <Text backgroundColor="green" color="black"> A 接受 </Text>
        <Text> </Text>
        <Text backgroundColor="red" color="white"> R 拒绝 </Text>
        <Text> </Text>
        <Text dimColor>←→ 切换 · Q 退出审查</Text>
      </Box>
    </Box>}

    {(overlay?.kind === "models" || overlay?.kind === "role-models") && <PickerPanel
      title={overlay.kind === "models" ? "选择模型" : `为 ${MODEL_ROLES.find(r => r.id === overlay.role)?.name ?? overlay.role} 选择模型`}
      items={filteredModels.map(item => ({
        key: `${item.providerId}:${item.modelId}`,
        label: `${item.active ? "* " : "  "}${item.label}`,
        detail: `${item.contextWindow.toLocaleString()} ctx${item.apiKeyConfigured ? "" : " · 无密钥"}`,
      }))}
      index={overlay.index}
      empty="没有匹配模型。Esc 取消，或 /connect 添加供应商。"
      footer="↑↓ 选择 · 输入筛选 · Enter 确认 · Esc 取消"
    />}

    {overlay?.kind === "roles" && <PickerPanel
      title="写作流程分工"
      items={MODEL_ROLES.map(role => {
        const catalog = props.providers.catalog();
        const ref = catalog.assignments[role.id];
        const profile = catalog.providers.find(item => item.id === ref.providerId);
        const model = profile?.models.find(item => item.id === ref.modelId);
        return {
          key: role.id,
          label: role.name,
          detail: profile && model ? `${profile.name} / ${model.name}` : "未配置",
        };
      })}
      index={overlay.index}
      empty="无"
      footer="↑↓ 选择 · Enter 分配模型 · Esc 取消"
    />}

    {overlay?.kind === "connect" && <PickerPanel
      title="添加供应商（OpenCode 风格）"
      items={CONNECT_PRESETS.map(item => ({
        key: item.id,
        label: item.name,
        detail: item.detail,
      }))}
      index={overlay.index}
      empty="无"
      footer="↑↓ 选择 · Enter 继续 · Esc 取消"
    />}

    {suggestions.length > 0 && <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {suggestions.map((item, index) => <Text key={`${item.kind}-${item.value}`} color={index === selectedSuggestion ? "cyan" : undefined} bold={index === selectedSuggestion}>
        {index === selectedSuggestion ? "› " : "  "}{item.label}  <Text dimColor>{item.detail}</Text>
      </Text>)}
      <Text dimColor>↑↓ 选择 · Tab 补全 · Enter 执行</Text>
    </Box>}

    <Box borderStyle="single" borderColor={busy ? "yellow" : reviewing || overlay ? "yellow" : "green"} paddingX={1}>
      <Text>{promptLabel}</Text>
      {!busy && !reviewing && (
        <TextInput value={input} onChange={setInput} onSubmit={submit} mask={keyMask} />
      )}
    </Box>
    <Text dimColor>
      {reviewing
        ? "A/R 审批 · ←→ 切换 · Q 退出"
        : overlay
          ? "Esc 取消当前面板"
          : "/ 命令 · /models · Ctrl+P 模型 · @ 文档 · ↑↓ 历史 · Ctrl+D 退出"}
    </Text>
  </Box>;
}

function PickerPanel(props: {
  title: string;
  items: Array<{ key: string; label: string; detail: string }>;
  index: number;
  empty: string;
  footer: string;
}) {
  const windowSize = 10;
  const start = Math.max(0, Math.min(props.index - windowSize + 3, Math.max(0, props.items.length - windowSize)));
  const visible = props.items.slice(start, start + windowSize);
  return <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
    <Text bold color="cyan">{props.title}</Text>
    {!props.items.length && <Text dimColor>{props.empty}</Text>}
    {visible.map((item, offset) => {
      const index = start + offset;
      const selected = index === props.index;
      return <Text key={item.key} color={selected ? "cyan" : undefined} bold={selected}>
        {selected ? "› " : "  "}{item.label}  <Text dimColor>{item.detail}</Text>
      </Text>;
    })}
    <Text dimColor>{props.footer}</Text>
  </Box>;
}
