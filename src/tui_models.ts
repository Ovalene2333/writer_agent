import type { ModelUsageRole, ProviderId } from "./types.js";
import type { ProviderManager } from "./provider_catalog.js";

/** OpenCode-style connect presets: pick a provider, then enter a key. */
export type ConnectPreset = {
  id: string;
  name: string;
  detail: string;
  provider: ProviderId;
  baseUrl: string;
  /** Default models seeded into the catalog when connecting. */
  models: string[];
  /** When true, TUI asks for a custom base URL before the key. */
  customUrl?: boolean;
};

export const CONNECT_PRESETS: ConnectPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    detail: "api.deepseek.com · flash / pro",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    id: "openai",
    name: "OpenAI",
    detail: "api.openai.com · GPT 系列",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4.1-mini", "gpt-4.1", "o4-mini"],
  },
  {
    id: "custom",
    name: "OpenAI 兼容（自定义）",
    detail: "任意兼容 /v1 的网关或本地服务",
    provider: "openai-compatible",
    baseUrl: "",
    models: [],
    customUrl: true,
  },
];

export const MODEL_ROLES: Array<{ id: Exclude<ModelUsageRole, "drafter">; name: string; detail: string }> = [
  { id: "agent", name: "Agent 调度", detail: "理解请求、规划任务与调用工具" },
  { id: "roleplay", name: "角色扮演", detail: "角色试演、对话者设定与沉浸式对白" },
  { id: "inline", name: "行内生成", detail: "短文本补全与局部快速修改" },
  { id: "writer", name: "正文写作", detail: "续写、重写与长篇内容生成" },
  { id: "reviewer", name: "审阅校对", detail: "质量检查、润色与修改建议" },
  { id: "summarizer", name: "上下文摘要", detail: "压缩历史内容以控制上下文长度" },
];

export type ModelChoice = {
  providerId: string;
  modelId: string;
  providerName: string;
  modelName: string;
  label: string;
  active: boolean;
  apiKeyConfigured: boolean;
  contextWindow: number;
};

export function listModelChoices(providers: ProviderManager): ModelChoice[] {
  const catalog = providers.catalog();
  return catalog.providers.flatMap((profile) =>
    profile.models.map((model) => {
      const active = catalog.activeProviderId === profile.id && catalog.activeModelId === model.id;
      return {
        providerId: profile.id,
        modelId: model.id,
        providerName: profile.name,
        modelName: model.name,
        label: `${profile.name} / ${model.name}`,
        active,
        apiKeyConfigured: profile.apiKeyConfigured,
        contextWindow: model.pricing.contextWindow,
      };
    }),
  );
}

export function filterModelChoices(choices: ModelChoice[], query: string): ModelChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return choices;
  return choices.filter((item) =>
    item.label.toLowerCase().includes(q)
    || item.modelName.toLowerCase().includes(q)
    || item.providerName.toLowerCase().includes(q),
  );
}

/** Resolve `/model <name>` or `provider/model` against the catalog. */
export function resolveModelChoice(providers: ProviderManager, query: string): ModelChoice | undefined {
  const choices = listModelChoices(providers);
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const exact = choices.find((item) =>
    item.label.toLowerCase() === q
    || item.modelName.toLowerCase() === q
    || `${item.providerName}/${item.modelName}`.toLowerCase() === q
    || `${item.providerId}/${item.modelId}`.toLowerCase() === q,
  );
  if (exact) return exact;
  const slash = q.includes("/") ? q.split("/", 2) : null;
  if (slash) {
    const [left, right] = slash;
    const bySlash = choices.find((item) =>
      (item.providerName.toLowerCase() === left || item.providerId.toLowerCase().startsWith(left))
      && (item.modelName.toLowerCase() === right || item.modelId.toLowerCase().startsWith(right)),
    );
    if (bySlash) return bySlash;
  }
  const partial = choices.filter((item) =>
    item.modelName.toLowerCase().includes(q)
    || item.label.toLowerCase().includes(q),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

export function formatRoleAssignments(providers: ProviderManager): string {
  const catalog = providers.catalog();
  return MODEL_ROLES.map((role) => {
    const ref = catalog.assignments[role.id];
    const profile = catalog.providers.find((item) => item.id === ref.providerId);
    const model = profile?.models.find((item) => item.id === ref.modelId);
    const label = profile && model ? `${profile.name} / ${model.name}` : "（未配置）";
    return `${role.name.padEnd(10)} ${label}\n  ${role.detail}`;
  }).join("\n");
}

export function formatProviderCatalog(providers: ProviderManager): string {
  const catalog = providers.catalog();
  const active = providers.publicConfig();
  const lines = [
    `当前：${active.provider}/${active.model} · 密钥 ${active.apiKeyHint || "未配置"}${active.source === "environment" ? "（环境变量优先）" : ""}`,
    "",
  ];
  for (const profile of catalog.providers) {
    const mark = profile.id === catalog.activeProviderId ? "*" : " ";
    lines.push(`${mark} ${profile.name}  (${profile.provider})  ${profile.apiKeyConfigured ? profile.apiKeyHint : "未配置密钥"}`);
    lines.push(`    ${profile.baseUrl}`);
    for (const model of profile.models) {
      const modelMark = profile.id === catalog.activeProviderId && model.id === catalog.activeModelId ? "→" : " ";
      lines.push(`   ${modelMark} ${model.name}  ·  ${model.pricing.contextWindow.toLocaleString()} ctx`);
    }
  }
  lines.push("", "提示：/models 交互切换 · /connect 添加供应商 · /roles 分工");
  return lines.join("\n");
}
