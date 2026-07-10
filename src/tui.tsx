import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import { runAgent } from "./agent.js";
import { WriterProject } from "./project.js";
import { ProviderManager } from "./provider_catalog.js";
import { WriterStore } from "./store.js";
import type { AgentEvent } from "./types.js";

export function WriterTui(props: { project: WriterProject; store: WriterStore; providers: ProviderManager; sessionId: string }) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [connectMode, setConnectMode] = useState(false);
  const [output, setOutput] = useState<string[]>([
    `已打开《${props.project.config().title}》`,
    "输入写作要求；/help 查看命令。",
  ]);
  const pendingCount = useMemo(() => props.store.proposals("pending").length, [output, props.store]);

  const append = (text: string) => setOutput((lines) => [...lines, text].slice(-24));
  const handleEvent = (event: AgentEvent) => {
    if (event.type === "text") {
      setOutput((lines) => {
        const copy = [...lines];
        const last = copy.at(-1) ?? "";
        if (last.startsWith("AI：")) copy[copy.length - 1] = last + event.text;
        else copy.push(`AI：${event.text}`);
        return copy.slice(-24);
      });
    } else if (event.type === "tool") append(`工具：${event.name}`);
    else if (event.type === "proposal") append(`提案 #${event.proposal.id}：${event.proposal.path} · ${event.proposal.summary}`);
  };

  const submit = async (value: string) => {
    const command = value.trim();
    setInput("");
    if (!command || busy) return;
    if (connectMode) {
      try {
        const configured = props.providers.save({
          provider: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          apiKey: command,
        });
        append(`已接入 DeepSeek：${configured.model}`);
      } catch (error) {
        append(`错误：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setConnectMode(false);
      }
      return;
    }
    if (command === "/quit" || command === "/exit") return exit();
    if (command === "/help") {
      append("命令：/connect、/provider、/model 模型名、/test、/proposals、/accept 编号、/reject 编号、/undo、/quit");
      return;
    }
    if (command === "/connect") {
      setConnectMode(true);
      append("请输入 DeepSeek API Key（输入内容将被遮蔽）：");
      return;
    }
    if (command === "/provider") {
      const provider = props.providers.publicConfig();
      append(`供应商：${provider.provider} · 模型：${provider.model} · 密钥：${provider.apiKeyHint || "未配置"}${provider.source === "environment" ? "（环境变量）" : ""}`);
      return;
    }
    const modelCommand = command.match(/^\/model\s+(deepseek-v4-(?:flash|pro))$/);
    if (modelCommand) {
      try {
        const current = props.providers.publicConfig();
        const provider = props.providers.save({
          provider: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: modelCommand[1],
        });
        append(`已切换模型：${provider.model}${current.source === "environment" ? "；环境变量仍具有更高优先级" : ""}`);
      } catch (error) { append(`错误：${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    if (command === "/test") {
      setBusy(true);
      try { append((await props.providers.testConnection()).message); }
      catch (error) { append(`错误：${error instanceof Error ? error.message : String(error)}`); }
      finally { setBusy(false); }
      return;
    }
    if (command === "/proposals") {
      const items = props.store.proposals("pending");
      append(items.length ? items.map((item) => `#${item.id} ${item.path} · ${item.summary}`).join("\n") : "没有待审批提案");
      return;
    }
    const decision = command.match(/^\/(accept|reject)\s+(\d+)$/);
    if (decision) {
      try {
        const item = decision[1] === "accept"
          ? props.store.acceptProposal(Number(decision[2]))
          : props.store.rejectProposal(Number(decision[2]));
        append(`提案 #${item.id} 已${item.status === "accepted" ? "接受" : "拒绝"}`);
      } catch (error) {
        append(`错误：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (command === "/undo") {
      try { append(`已撤销：${props.store.undo()}`); }
      catch (error) { append(`错误：${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    setBusy(true);
    append(`你：${command}`);
    try {
      await runAgent({ ...props, prompt: command, model: props.providers.modelConfig(), onEvent: handleEvent });
    } catch (error) {
      append(`错误：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">Writer Agent</Text>
        <Text dimColor>会话 {props.sessionId.slice(0, 8)} · {props.providers.publicConfig().model} · 待审批 {pendingCount}</Text>
      </Box>
      <Box flexDirection="column" paddingY={1}>
        {output.map((line, index) => <Text key={`${index}-${line.slice(0, 12)}`}>{line}</Text>)}
      </Box>
      <Box borderStyle="single" borderColor={busy ? "yellow" : "green"} paddingX={1}>
        <Text>{busy ? "生成中… " : connectMode ? "API Key：" : "> "}</Text>
        {!busy && <TextInput value={input} onChange={setInput} onSubmit={submit} mask={connectMode ? "*" : undefined} />}
      </Box>
    </Box>
  );
}
