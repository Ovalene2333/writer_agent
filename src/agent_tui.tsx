import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { runAgent } from "./agent.js";
import { parseCharacterCommand, parseCommand, parseStyleCommand, referencedDocumentQuery, SLASH_COMMANDS, suggestCommands } from "./commands.js";
import { WriterProject } from "./project.js";
import { ProviderManager } from "./provider_catalog.js";
import { WriterStore } from "./store.js";
import { getStyleTemplate, listStyleTemplates } from "./templates.js";
import type { AgentEvent, Proposal } from "./types.js";

type Suggestion = { value: string; label: string; detail: string; kind: "command" | "document" };

export function WriterAgentTui(props: { project: WriterProject; store: WriterStore; providers: ProviderManager; sessionId: string }) {
  const { exit } = useApp();
  const [sessionId, setSessionId] = useState(props.sessionId);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [connectMode, setConnectMode] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const [history, setHistory] = useState(() => props.store.messages(props.sessionId, 100).filter(item => item.role === "user").map(item => item.content));
  const [historyIndex, setHistoryIndex] = useState(-1);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const runProposalsRef = useRef<number[]>([]);
  const [output, setOutput] = useState<string[]>([
    `已打开《${props.project.config().title}》`,
    "输入 / 查看命令，输入 @ 引用作品文档。",
  ]);
  const pendingProposals = useMemo(() => props.store.proposals("pending"), [output, props.store]);
  const usage = useMemo(() => props.store.usage(sessionId), [output, props.store, sessionId]);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (connectMode || busy || reviewIndex !== null) return [];
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
  }, [busy, connectMode, input, props.project, reviewIndex]);
  useEffect(() => setSelectedSuggestion(0), [input]);

  const append = useCallback((text: string) => setOutput(lines => [...lines, text].slice(-30)), []);
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

  useInput((character, key) => {
    if ((key.escape || (key.ctrl && character === "c")) && busy) return cancel();
    if (key.escape && connectMode) { setConnectMode(false); setInput(""); return; }
    if (key.escape && reviewIndex !== null) { setReviewIndex(null); setOutput([]); return; }
    if (key.ctrl && character === "d" && !busy && reviewIndex === null) return exit();
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

  const handleEvent = useCallback((event: AgentEvent) => {
    if (event.type === "text") {
      setOutput(lines => {
        const copy = [...lines];
        const last = copy.at(-1) ?? "";
        if (last.startsWith("AI：")) copy[copy.length - 1] = last + event.text;
        else copy.push(`AI：${event.text}`);
        return copy.slice(-30);
      });
    } else if (event.type === "tool" && showDetails) append(`工具：${event.name}`);
    else if (event.type === "proposal") append(`提案 #${event.proposal.id}：${event.proposal.path} · ${event.proposal.summary}`);
    else if (event.type === "cancelled") append("当前作业已中断，已完成的提案和输出予以保留。");
    else if (event.type === "usage") append(`用量：${event.usage.totalTokens.toLocaleString()} Token · ${event.usage.currency === "CNY" ? "¥" : "$"}${event.usage.cost.toFixed(6)}`);
  }, [showDetails, append]);

  const executeCommand = useCallback(async (name: string, args: string) => {
    try {
      if (name === "exit") return exit();
      if (name === "help") append(SLASH_COMMANDS.map(item => `${item.usage.padEnd(22)} ${item.description}`).join("\n"));
      else if (name === "screen") setOutput([]);
      else if (name === "stop") busy ? cancel() : append("当前没有正在执行的作业");
      else if (name === "new") {
        const id = props.store.createSession(args || "新会话");
        setSessionId(id); setHistory([]); setOutput([`已创建会话：${id.slice(0, 8)}`]);
      } else if (name === "sessions") {
        append(props.store.listSessions().map(item => `${item.id.slice(0, 8)}  ${item.updatedAt.slice(0, 16).replace("T", " ")}  ${item.title}`).join("\n") || "没有历史会话");
      } else if (name === "resume") {
        const matches = props.store.listSessions().filter(item => item.id.startsWith(args));
        if (!args || matches.length !== 1) throw new Error(matches.length > 1 ? "会话 ID 前缀不唯一" : "找不到指定会话");
        setSessionId(matches[0].id);
        const messages = props.store.messages(matches[0].id, 30);
        setHistory(messages.filter(item => item.role === "user").map(item => item.content));
        setOutput(messages.map(item => `${item.role === "user" ? "你" : "AI"}：${item.content}`).slice(-30));
      } else if (name === "status") {
        const provider = props.providers.publicConfig();
        append(`项目：${props.project.config().title}\n会话：${sessionId}\n模型：${provider.provider}/${provider.model}\n文档：${props.project.listDocuments().length}\n待审批：${pendingProposals.length}`);
      } else if (name === "context") {
        const pricing = props.providers.publicConfig().pricing;
        append(`最近上下文：${usage.lastPromptTokens.toLocaleString()} / ${pricing.contextWindow.toLocaleString()} Token（${(usage.lastPromptTokens / pricing.contextWindow * 100).toFixed(2)}%）\n包含系统规则、角色卡、写作示例、最近消息、检索片段和 @ 引用文档。`);
      } else if (name === "usage") append(`输入 ${usage.promptTokens.toLocaleString()} · 输出 ${usage.completionTokens.toLocaleString()} · 缓存命中 ${usage.cacheHitTokens.toLocaleString()} · 总计 ${usage.totalTokens.toLocaleString()} Token · ${usage.currency === "CNY" ? "¥" : "$"}${usage.cost.toFixed(6)}`);
      else if (name === "character") {
        const command = parseCharacterCommand(args);
        if (command.action === "list") append(props.store.characters().map(item => `${item.id}  ${item.name}  ${item.narrativeRole}`).join("\n") || "characters/ 目录中没有角色卡");
        else if (command.action === "show") {
          const item = props.store.findCharacter(command.values.join(" "));
          if (!item) throw new Error("找不到角色卡");
          append(JSON.stringify(item, null, 2));
        } else if (command.action === "create") {
          const [characterName, role = "", description = ""] = command.values;
          if (!characterName) throw new Error("用法：/character create 姓名 | 定位 | 性格、背景和目标");
          props.store.saveCharacter({ schemaVersion: 2, name: characterName, aliases: [], narrativeRole: role, identity: "", appearance: "", personality: description, values: "", speechStyle: "", background: "", longTermGoal: "", currentGoal: "", fears: "", capabilities: "", limitations: "", relationships: [], notes: "" });
          append(`已创建角色卡：characters/${characterName}.json`);
        } else if (command.action === "delete") {
          const item = props.store.findCharacter(command.values.join(" "));
          if (!item) throw new Error("找不到角色卡");
          props.store.deleteCharacter(item.id); append(`已删除角色卡：${item.name}`);
        } else throw new Error("用法：/character <create|list|show|delete>");
      }
      else if (name === "style") {
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
          props.providers.save({
            provider: props.providers.publicConfig().provider,
            baseUrl: props.providers.publicConfig().baseUrl,
            model: props.providers.publicConfig().model,
            temperature: template.suggestedTemperature,
            topP: template.suggestedTopP,
          });
          append(`已激活风格模板：${template.name}\n已注入写作示例：${template.exampleContent.slice(0, 80)}…\n建议 temperature=${template.suggestedTemperature} topP=${template.suggestedTopP} 已自动应用`);
        } else if (command.action === "off") {
          props.project.setStyle("");
          append("已取消风格模板");
        } else throw new Error("用法：/style <list|set <id>|off>");
      }
      else if (name === "docs") {
        const query = args.toLowerCase();
        append(props.project.listDocuments().filter(path => !query || path.toLowerCase().includes(query)).join("\n") || "没有匹配文档");
      } else if (name === "read") append(args ? `${args}\n${props.project.read(args).slice(0, 8_000)}` : "用法：/read <文档路径>");
      else if (name === "search") {
        if (!args) throw new Error("用法：/search <关键词>");
        const results = props.store.search(args, 10);
        append(results.map(item => `${item.path}：${item.excerpt}`).join("\n") || "没有检索结果");
      } else if (name === "connect") { setConnectMode(true); append("请输入 DeepSeek API Key（内容将被遮蔽，Esc 取消）："); }
      else if (name === "provider") {
        const provider = props.providers.publicConfig();
        append(`供应商：${provider.provider} · 模型：${provider.model} · 密钥：${provider.apiKeyHint || "未配置"}${provider.source === "environment" ? "（环境变量）" : ""}`);
      } else if (name === "models") append("deepseek-v4-flash  快速、低成本\ndeepseek-v4-pro    复杂规划与深度修订\n使用 /model <模型名> 切换");
      else if (name === "model") {
        if (!/^deepseek-v4-(flash|pro)$/.test(args)) throw new Error("可用模型：deepseek-v4-flash、deepseek-v4-pro");
        const provider = props.providers.save({ provider: "deepseek", baseUrl: "https://api.deepseek.com", model: args });
        append(`已切换模型：${provider.model}`);
      } else if (name === "test") {
        setBusy(true); try { append((await props.providers.testConnection()).message); } finally { setBusy(false); }
      } else if (name === "proposals") {
        append(pendingProposals.length ? pendingProposals.map(item => `#${item.id} ${item.path} · ${item.summary}`).join("\n") : "没有待审批提案");
      } else if (name === "accept" || name === "reject") {
        const id = Number(args);
        if (!Number.isInteger(id)) throw new Error(`用法：/${name} <编号>`);
        name === "accept" ? acceptProposal(id) : rejectProposal(id);
      }       else if (name === "undo") append(`已撤销：${props.store.undo(sessionId)}`);
      else if (name === "redo") append(`已重做：${props.store.redo(sessionId)}`);
      else if (name === "export") {
        if (args !== "md" && args !== "txt") throw new Error("用法：/export <md|txt>");
        append(`已导出：${props.project.exportTo(args)}`);
      } else if (name === "details") { setShowDetails(value => !value); append(`工具调用详情已${showDetails ? "隐藏" : "显示"}`); }
      else append(`未知命令：/${name}。输入 / 查看命令索引。`);
    } catch (error) { appendError(error); }
  }, [busy, cancel, exit, append, appendError, acceptProposal, rejectProposal, pendingProposals, usage, props, sessionId, showDetails]);

  const submit = useCallback(async (value: string) => {
    const text = value.trim();
    setInput(""); setHistoryIndex(-1);
    if (!text || busy) return;
    if (reviewIndex !== null) { setReviewIndex(null); return; }
    if (connectMode) {
      try {
        const configured = props.providers.save({ provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", apiKey: text });
        append(`已接入 DeepSeek：${configured.model}`);
      } catch (error) { appendError(error); }
      finally { setConnectMode(false); }
      return;
    }
    const command = parseCommand(text);
    if (command) return executeCommand(command.name, command.args);
    setHistory(items => [...items, text].slice(-200));
    runProposalsRef.current = pendingProposals.map(p => p.id);
    setBusy(true); append(`你：${text}`);
    const controller = new AbortController(); abortRef.current = controller;
    try {
      await runAgent({ project: props.project, store: props.store, sessionId, prompt: text, maxTurns: 20, model: props.providers.modelConfig(), signal: controller.signal, onEvent: handleEvent });
    } catch (error) { appendError(error); }
    finally { abortRef.current = undefined; setBusy(false); enterReview(); }
  }, [busy, reviewIndex, connectMode, pendingProposals, sessionId, props, append, appendError, handleEvent, executeCommand, enterReview]);

  const reviewing = reviewIndex !== null && pendingProposals.length > 0;
  const current = reviewing ? pendingProposals[reviewIndex!] : undefined;
  return <Box flexDirection="column" paddingX={1}>
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold color="cyan">Writer Agent</Text>
      <Text dimColor>会话 {sessionId.slice(0, 8)} · {props.providers.publicConfig().model} · {usage.totalTokens.toLocaleString()} Token · {usage.currency === "CNY" ? "¥" : "$"}{usage.cost.toFixed(4)} · 待审批 {pendingProposals.length}{reviewing ? ` · 审查中 ${reviewIndex! + 1}/${pendingProposals.length}` : ""}</Text>
    </Box>
    <Box flexDirection="column" paddingY={1}>{output.map((line, index) => <Text key={`${index}-${line.slice(0, 12)}`}>{line}</Text>)}</Box>
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
    {suggestions.length > 0 && <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {suggestions.map((item, index) => <Text key={`${item.kind}-${item.value}`} color={index === selectedSuggestion ? "cyan" : undefined} bold={index === selectedSuggestion}>
        {index === selectedSuggestion ? "› " : "  "}{item.label}  <Text dimColor>{item.detail}</Text>
      </Text>)}
      <Text dimColor>↑↓ 选择 · Tab 补全 · Enter 执行</Text>
    </Box>}
    <Box borderStyle="single" borderColor={busy ? "yellow" : reviewing ? "yellow" : "green"} paddingX={1}>
      <Text>{busy ? "生成中（Esc/Ctrl+C 中断）…" : reviewing ? "审查提案中" : connectMode ? "API Key：" : "> "}</Text>
      {!busy && !reviewing && <TextInput value={input} onChange={setInput} onSubmit={submit} mask={connectMode ? "*" : undefined} />}
    </Box>
    <Text dimColor>{reviewing ? "A/R 审批 · ←→ 切换 · Q 退出" : "/ 命令 · @ 文档 · ↑↓ 历史 · Ctrl+D 退出"}</Text>
  </Box>;
}
