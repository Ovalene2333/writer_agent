export type CommandCategory = "会话" | "创作" | "上下文" | "模型" | "修改" | "界面";

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  category: CommandCategory;
  aliases?: string[];
  shortcut?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", usage: "/help", description: "显示全部命令与快捷键", category: "界面", shortcut: "?" },
  { name: "new", usage: "/new [名称]", description: "创建并切换到新会话", category: "会话", aliases: ["clear"] },
  { name: "sessions", usage: "/sessions", description: "列出可恢复的历史会话", category: "会话", aliases: ["continue"] },
  { name: "resume", usage: "/resume <会话ID>", description: "恢复指定会话，可使用 ID 前缀", category: "会话" },
  { name: "status", usage: "/status", description: "显示项目、会话、模型和待审批状态", category: "会话" },
  { name: "context", usage: "/context", description: "显示当前上下文组成", category: "上下文" },
  { name: "usage", usage: "/usage", description: "显示会话 Token 用量与费用", category: "上下文" },
  { name: "character", usage: "/character <create|list|show|delete>", description: "创建和管理目录中的角色卡", category: "创作" },
  { name: "style", usage: "/style [list|set <id>|off]", description: "列出或切换写作风格模板", category: "创作" },
  { name: "docs", usage: "/docs [关键词]", description: "索引作品中的全部文档", category: "上下文" },
  { name: "read", usage: "/read <文档路径>", description: "直接读取一份作品文档", category: "上下文" },
  { name: "search", usage: "/search <关键词>", description: "全文检索 lore 设定、outline 大纲和 chapters 正文", category: "上下文" },
  { name: "connect", usage: "/connect", description: "接入 DeepSeek API", category: "模型" },
  { name: "provider", usage: "/provider", description: "显示当前模型供应商", category: "模型" },
  { name: "models", usage: "/models", description: "列出并切换可用模型", category: "模型" },
  { name: "model", usage: "/model <模型名>", description: "切换当前模型", category: "模型", shortcut: "Alt+P" },
  { name: "test", usage: "/test", description: "测试模型 API 连接", category: "模型" },
  { name: "proposals", usage: "/proposals", description: "列出待审批修改", category: "修改" },
  { name: "accept", usage: "/accept <编号>", description: "接受一项修改提案", category: "修改" },
  { name: "reject", usage: "/reject <编号>", description: "拒绝一项修改提案", category: "修改" },
  { name: "undo", usage: "/undo", description: "撤销最近一次文档修改", category: "修改" },
  { name: "redo", usage: "/redo", description: "重做最近一次撤销", category: "修改" },
  { name: "export", usage: "/export <md|txt>", description: "导出完整作品到项目目录", category: "修改" },
  { name: "details", usage: "/details", description: "显示或隐藏 Agent 工具调用", category: "界面" },
  { name: "screen", usage: "/screen", description: "清空当前终端显示", category: "界面" },
  { name: "stop", usage: "/stop", description: "中断当前 Agent 作业", category: "界面", shortcut: "Esc / Ctrl+C" },
  { name: "exit", usage: "/exit", description: "退出终端界面", category: "界面", aliases: ["quit", "q"], shortcut: "Ctrl+D" },
];

export function suggestCommands(input: string, limit = 8): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const query = input.slice(1).split(/\s/, 1)[0].toLowerCase();
  return SLASH_COMMANDS.filter((command) => {
    const names = [command.name, ...(command.aliases ?? [])];
    return !query || names.some((name) => name.includes(query));
  }).slice(0, limit);
}

export function parseCommand(input: string): { name: string; args: string } | undefined {
  const match = input.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  const requested = match[1].toLowerCase();
  const command = SLASH_COMMANDS.find((item) => item.name === requested || item.aliases?.includes(requested));
  return command ? { name: command.name, args: match[2]?.trim() ?? "" } : { name: requested, args: match[2]?.trim() ?? "" };
}

export function referencedDocumentQuery(input: string): string | undefined {
  const match = input.match(/(?:^|\s)@([^\s]*)$/);
  return match?.[1];
}

export function parseCharacterCommand(args: string): { action: string; values: string[] } {
  const [action = "list", ...rest] = args.trim().split(/\s+/);
  const tail = rest.join(" ");
  return { action: action.toLowerCase(), values: tail.split("|").map(value => value.trim()).filter(Boolean) };
}

export function parseStyleCommand(args: string): { action: string; styleId: string } {
  const [action = "list", id = ""] = args.trim().split(/\s+/);
  return { action: action.toLowerCase(), styleId: id };
}
