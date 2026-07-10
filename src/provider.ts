import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelConfig, ProviderId, ProviderPublicConfig, TokenPricing } from "./types.js";
import { WriterProject } from "./project.js";

interface SavedProviderConfig {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
  pricing: TokenPricing;
  temperature?: number;
  topP?: number;
}

export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

const DEFAULT_CONFIG: SavedProviderConfig = {
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  apiKey: "",
  pricing: { cacheHit: 0, cacheMiss: 0, output: 0, currency: "CNY", contextWindow: 128_000 },
};

export class ProviderManager {
  private readonly path: string;
  private saved: SavedProviderConfig;

  constructor(project: WriterProject) {
    this.path = resolve(project.privateDir, "provider.json");
    this.saved = this.load();
  }

  modelConfig(): ModelConfig {
    const baseUrl = process.env.WRITER_BASE_URL || this.saved.baseUrl;
    return {
      provider: baseUrl.includes("api.deepseek.com") ? "deepseek" : this.saved.provider,
      baseUrl,
      apiKey: process.env.WRITER_API_KEY || this.saved.apiKey,
      model: process.env.WRITER_MODEL || this.saved.model,
      pricing: this.saved.pricing,
      temperature: this.saved.temperature,
      topP: this.saved.topP,
    };
  }

  publicConfig(): ProviderPublicConfig {
    const config = this.modelConfig();
    const environmentConfigured = Boolean(
      process.env.WRITER_API_KEY || process.env.WRITER_BASE_URL || process.env.WRITER_MODEL,
    );
    return {
      provider: config.provider ?? "openai-compatible",
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyConfigured: Boolean(config.apiKey),
      apiKeyHint: maskKey(config.apiKey),
      source: environmentConfigured ? "environment" : "project",
      pricing: config.pricing ?? this.saved.pricing,
      temperature: config.temperature,
      topP: config.topP,
    };
  }

  save(input: { provider: ProviderId; baseUrl: string; model: string; apiKey?: string; pricing?: Partial<TokenPricing>; temperature?: number; topP?: number }): ProviderPublicConfig {
    if (input.provider !== "deepseek" && input.provider !== "openai-compatible") {
      throw new Error("不支持的模型供应商");
    }
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const model = input.model.trim();
    if (!model) throw new Error("模型名称不能为空");
    if (input.provider === "deepseek" && !DEEPSEEK_MODELS.includes(model as typeof DEEPSEEK_MODELS[number])) {
      throw new Error("请选择可用的 DeepSeek V4 模型");
    }
    const apiKey = input.apiKey?.trim() || this.saved.apiKey;
    if (!apiKey) throw new Error("API Key 不能为空");
    const defaults = defaultPricing(input.provider, model);
    const pricing = input.pricing ? {
      cacheHit: validRate(input.pricing.cacheHit, defaults.cacheHit),
      cacheMiss: validRate(input.pricing.cacheMiss, defaults.cacheMiss),
      output: validRate(input.pricing.output, defaults.output),
      currency: input.pricing.currency === "USD" ? "USD" as const : "CNY" as const,
      contextWindow: Math.max(1_000, Math.round(validRate(input.pricing.contextWindow, defaults.contextWindow))),
    } : defaults;
    const temperature = typeof input.temperature === "number" && Number.isFinite(input.temperature) && input.temperature >= 0 && input.temperature <= 2
      ? Math.round(input.temperature * 100) / 100 : this.saved.temperature;
    const topP = typeof input.topP === "number" && Number.isFinite(input.topP) && input.topP >= 0 && input.topP <= 1
      ? Math.round(input.topP * 100) / 100 : this.saved.topP;
    this.saved = { provider: input.provider, baseUrl, model, apiKey, pricing, temperature, topP };
    this.persist();
    return this.publicConfig();
  }

  async testConnection(): Promise<{ ok: true; message: string }> {
    const config = this.modelConfig();
    if (!config.apiKey) throw new Error("请先配置 API Key");
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`连接验证失败（${response.status}）：${detail}`);
    }
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const available = payload.data?.some((item) => item.id === config.model);
    return { ok: true, message: available === false ? "API 可用，但当前模型未出现在模型列表中" : "连接成功" };
  }

  private load(): SavedProviderConfig {
    if (!existsSync(this.path)) return { ...DEFAULT_CONFIG };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SavedProviderConfig>;
      if (!parsed.provider || !parsed.baseUrl || !parsed.model || typeof parsed.apiKey !== "string") {
        throw new Error("字段不完整");
      }
      return {
        provider: parsed.provider,
        baseUrl: normalizeBaseUrl(parsed.baseUrl),
        model: parsed.model,
        apiKey: parsed.apiKey,
        pricing: parsed.pricing ?? defaultPricing(parsed.provider, parsed.model),
      };
    } catch (error) {
      throw new Error(`模型供应商配置无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): void {
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.saved, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(temporary, this.path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
      writeFileSync(this.path, `${JSON.stringify(this.saved, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      try { unlinkSync(temporary); } catch { /* Windows 可能短暂锁定临时文件。 */ }
    }
  }
}

function defaultPricing(provider: ProviderId, model: string): TokenPricing {
  if (provider !== "deepseek") return { cacheHit: 0, cacheMiss: 0, output: 0, currency: "CNY", contextWindow: 128_000 };
  return model === "deepseek-v4-pro"
    ? { cacheHit: 0.025, cacheMiss: 3, output: 6, currency: "CNY", contextWindow: 1_000_000 }
    : { cacheHit: 0.02, cacheMiss: 1, output: 2, currency: "CNY", contextWindow: 1_000_000 };
}

function validRate(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeBaseUrl(value: string): string {
  const text = value.trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(text); }
  catch { throw new Error("API 地址格式无效"); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("API 地址必须使用 HTTPS，本地服务除外");
  }
  return text;
}

function maskKey(value: string): string {
  if (!value) return "";
  if (value.length < 9) return "••••••••";
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}
