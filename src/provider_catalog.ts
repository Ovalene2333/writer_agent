import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ModelConfig, ModelUsageRole, ProviderCatalogPublic, ProviderId, ProviderModelPublic, ProviderProfilePublic, ProviderPublicConfig, TokenPricing } from "./types.js";
import { defaultPricing, normalizePricing } from "./pricing.js";
import { WriterProject } from "./project.js";

type SavedModel = ProviderModelPublic;
type SavedProfile = { id: string; name: string; provider: ProviderId; baseUrl: string; apiKey: string; models: SavedModel[] };
type ModelReference = { providerId: string; modelId: string };
type SavedCatalog = { version: 2; activeProviderId: string; activeModelId: string; assignments: Record<ModelUsageRole, ModelReference>; providers: SavedProfile[] };
type LegacyConfig = { provider: ProviderId; baseUrl: string; model: string; apiKey: string; pricing?: TokenPricing; temperature?: number; topP?: number };

export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

/** Canonical provider catalog filename under `.writer/` (portable; copy this file to migrate). */
export const PROVIDERS_FILENAME = "providers.json";
/** Legacy single-file config; auto-migrated to `providers.json` on load. */
export const LEGACY_PROVIDER_FILENAME = "provider.json";

export class ProviderManager {
  /** Absolute path of the providers file (override with WRITER_PROVIDERS_FILE). */
  readonly path: string;
  private saved: SavedCatalog;

  constructor(project: WriterProject) {
    this.path = resolveProvidersPath(project);
    this.saved = this.load();
  }

  modelConfig(role: ModelUsageRole = "agent"): ModelConfig {
    const { profile, model } = this.assigned(role); const baseUrl = process.env.WRITER_BASE_URL || profile.baseUrl;
    return { provider: baseUrl.includes("api.deepseek.com") ? "deepseek" : profile.provider, baseUrl, apiKey: process.env.WRITER_API_KEY || profile.apiKey, model: process.env.WRITER_MODEL || model.name, pricing: model.pricing, temperature: model.temperature, topP: model.topP };
  }
  summaryModelConfig(): ModelConfig { return this.modelConfig("summarizer"); }
  publicConfig(): ProviderPublicConfig {
    const { profile, model } = this.active(); const config = this.modelConfig();
    const environmentConfigured = Boolean(process.env.WRITER_API_KEY || process.env.WRITER_BASE_URL || process.env.WRITER_MODEL);
    return { profileId: profile.id, modelId: model.id, provider: config.provider ?? profile.provider, baseUrl: config.baseUrl, model: config.model, apiKeyConfigured: Boolean(config.apiKey), apiKeyHint: maskKey(config.apiKey), source: environmentConfigured ? "environment" : "project", pricing: config.pricing ?? model.pricing, temperature: config.temperature, topP: config.topP };
  }
  catalog(): ProviderCatalogPublic { return { activeProviderId: this.saved.activeProviderId, activeModelId: this.saved.activeModelId, assignments: this.saved.assignments, providers: this.saved.providers.map(profile => this.publicProfile(profile)) }; }

  saveProfile(input: { id?: string; name: string; provider: ProviderId; baseUrl: string; apiKey?: string; models: Array<{ id?: string; name: string; pricing?: Partial<TokenPricing>; temperature?: number; topP?: number }> }): ProviderCatalogPublic {
    if (!input.models?.length) throw new Error("每个供应商至少需要一个模型");
    const existing = input.id ? this.saved.providers.find(item => item.id === input.id) : undefined;
    const profile: SavedProfile = { id: existing?.id ?? randomUUID(), name: input.name.trim() || providerLabel(input.provider), provider: validateProvider(input.provider), baseUrl: normalizeBaseUrl(input.baseUrl), apiKey: input.apiKey?.trim() || existing?.apiKey || "", models: [] };
    if (!profile.apiKey) throw new Error("API Key 不能为空");
    profile.models = input.models.map(item => normalizeModel(item, profile.provider, existing?.models.find(model => model.id === item.id)));
    const index = this.saved.providers.findIndex(item => item.id === profile.id);
    if (index >= 0) this.saved.providers[index] = profile; else this.saved.providers.push(profile);
    if (!this.saved.providers.some(item => item.id === this.saved.activeProviderId)) { this.saved.activeProviderId = profile.id; this.saved.activeModelId = profile.models[0].id; }
    if (this.saved.activeProviderId === profile.id && !profile.models.some(item => item.id === this.saved.activeModelId)) this.saved.activeModelId = profile.models[0].id;
    for (const role of modelRoles()) { const ref = this.saved.assignments[role]; if (ref.providerId === profile.id && !profile.models.some(item => item.id === ref.modelId)) this.saved.assignments[role] = { providerId: profile.id, modelId: profile.models[0].id }; }
    this.persist(); return this.catalog();
  }
  select(profileId: string, modelId: string): ProviderPublicConfig { const profile = this.saved.providers.find(item => item.id === profileId); if (!profile?.models.some(item => item.id === modelId)) throw new Error("供应商或模型不存在"); this.saved.activeProviderId = profileId; this.saved.activeModelId = modelId; this.persist(); return this.publicConfig(); }
  assign(role: ModelUsageRole, providerId: string, modelId: string): ProviderCatalogPublic { if (!modelRoles().includes(role)) throw new Error("模型用途无效"); const profile = this.saved.providers.find(item => item.id === providerId); if (!profile?.models.some(item => item.id === modelId)) throw new Error("供应商或模型不存在"); this.saved.assignments[role] = { providerId, modelId }; if (role === "agent") { this.saved.activeProviderId = providerId; this.saved.activeModelId = modelId; } this.persist(); return this.catalog(); }
  deleteProfile(id: string): ProviderCatalogPublic { if (this.saved.providers.length <= 1) throw new Error("至少保留一个供应商"); this.saved.providers = this.saved.providers.filter(item => item.id !== id); const fallback = { providerId: this.saved.providers[0].id, modelId: this.saved.providers[0].models[0].id }; if (this.saved.activeProviderId === id) { this.saved.activeProviderId = fallback.providerId; this.saved.activeModelId = fallback.modelId; } for (const role of modelRoles()) if (this.saved.assignments[role].providerId === id) this.saved.assignments[role] = fallback; this.persist(); return this.catalog(); }
  save(input: { provider: ProviderId; baseUrl: string; model: string; apiKey?: string; pricing?: Partial<TokenPricing>; temperature?: number; topP?: number }): ProviderPublicConfig { const active = this.active(); this.saveProfile({ id: active.profile.id, name: active.profile.name, provider: input.provider, baseUrl: input.baseUrl, apiKey: input.apiKey, models: [{ id: active.model.id, name: input.model, pricing: input.pricing, temperature: input.temperature, topP: input.topP }] }); return this.publicConfig(); }
  /** 通过 GET /models 探测可达性，不调用 chat/completions，不消耗 token。 */
  async testConnection(profileId = this.saved.activeProviderId, modelId = this.saved.activeModelId): Promise<{ ok: true; message: string; modelListed?: boolean }> {
    const profile = this.saved.providers.find(item => item.id === profileId);
    const model = profile?.models.find(item => item.id === modelId);
    if (!profile || !model) throw new Error("供应商或模型不存在");
    if (!profile.apiKey) throw new Error("请先配置 API Key");
    const base = profile.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${profile.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`${profile.name} / ${model.name} 不可达（${response.status}）：${(await response.text()).slice(0, 300)}`);
    }
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const listed = Array.isArray(payload.data)
      ? payload.data.some(item => item.id === model.name)
      : undefined;
    if (listed === false) {
      return {
        ok: true,
        modelListed: false,
        message: `${profile.name} / ${model.name}：API 可达，但模型未出现在列表中（仅探测 /models，不消耗 token）`,
      };
    }
    return {
      ok: true,
      modelListed: listed,
      message: `${profile.name} / ${model.name}：连接成功（仅探测 /models，不消耗 token）`,
    };
  }

  private active() { const profile = this.saved.providers.find(item => item.id === this.saved.activeProviderId) ?? this.saved.providers[0]; const model = profile.models.find(item => item.id === this.saved.activeModelId) ?? profile.models[0]; return { profile, model }; }
  private assigned(role: ModelUsageRole) { const ref = this.saved.assignments[role]; const profile = this.saved.providers.find(item => item.id === ref?.providerId) ?? this.active().profile; const model = profile.models.find(item => item.id === ref?.modelId) ?? profile.models[0]; return { profile, model }; }
  private publicProfile(profile: SavedProfile): ProviderProfilePublic { return { id: profile.id, name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, apiKeyConfigured: Boolean(profile.apiKey), apiKeyHint: maskKey(profile.apiKey), models: profile.models }; }
  private load(): SavedCatalog {
    const sourcePath = existsSync(this.path)
      ? this.path
      : this.legacyPath() && existsSync(this.legacyPath()!)
        ? this.legacyPath()!
        : null;
    if (!sourcePath) return defaultCatalog();
    try {
      const catalog = parseCatalog(readFileSync(sourcePath, "utf8"));
      // Migrate legacy `.writer/provider.json` → `providers.json` (or custom path)
      if (sourcePath !== this.path) {
        this.saved = catalog;
        this.persist();
      }
      return catalog;
    } catch (error) {
      throw new Error(`模型供应商配置无效（${sourcePath}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private legacyPath(): string | undefined {
    // Only auto-discover legacy file when using the default project-local path
    if (process.env.WRITER_PROVIDERS_FILE?.trim()) return undefined;
    return resolve(dirname(this.path), LEGACY_PROVIDER_FILENAME);
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}`;
    const text = `${JSON.stringify(this.saved, null, 2)}\n`;
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(temporary, this.path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
      writeFileSync(this.path, text, { encoding: "utf8", mode: 0o600 });
      try { unlinkSync(temporary); } catch { /* Windows 可能短暂锁定临时文件。 */ }
    }
  }
}

function resolveProvidersPath(project: WriterProject): string {
  const override = process.env.WRITER_PROVIDERS_FILE?.trim();
  if (override) {
    // Absolute path stays absolute; relative paths resolve against project root for portability
    return isAbsolute(override) ? override : resolve(project.root, override);
  }
  return resolve(project.privateDir, PROVIDERS_FILENAME);
}

function parseCatalog(raw: string): SavedCatalog {
  const parsed = JSON.parse(raw) as SavedCatalog | LegacyConfig;
  if ("version" in parsed && parsed.version === 2 && parsed.providers?.length) {
    const fallback = { providerId: parsed.activeProviderId, modelId: parsed.activeModelId };
    parsed.assignments = parsed.assignments ?? {} as SavedCatalog["assignments"];
    for (const role of modelRoles()) parsed.assignments[role] ??= fallback;
    for (const profile of parsed.providers) {
      for (const model of profile.models) {
        model.pricing = normalizePricing(profile.provider, model.name, undefined, model.pricing);
      }
    }
    return parsed;
  }
  const legacy = parsed as LegacyConfig;
  if (!legacy.provider || !legacy.baseUrl || !legacy.model || typeof legacy.apiKey !== "string") {
    throw new Error("字段不完整");
  }
  const profileId = randomUUID();
  const modelId = randomUUID();
  const fallback = { providerId: profileId, modelId };
  return {
    version: 2,
    activeProviderId: profileId,
    activeModelId: modelId,
    assignments: {
      agent: fallback,
      drafter: fallback,
      inline: fallback,
      writer: fallback,
      reviewer: fallback,
      summarizer: fallback,
    },
    providers: [{
      id: profileId,
      name: providerLabel(legacy.provider),
      provider: legacy.provider,
      baseUrl: normalizeBaseUrl(legacy.baseUrl),
      apiKey: legacy.apiKey,
      models: [{
        id: modelId,
        name: legacy.model,
        pricing: normalizePricing(legacy.provider, legacy.model, undefined, legacy.pricing),
        temperature: legacy.temperature,
        topP: legacy.topP,
      }],
    }],
  };
}

function defaultCatalog(): SavedCatalog { const profileId = randomUUID(), modelId = randomUUID(), fallback = { providerId: profileId, modelId }; return { version: 2, activeProviderId: profileId, activeModelId: modelId, assignments: { agent: fallback, drafter: fallback, inline: fallback, writer: fallback, reviewer: fallback, summarizer: fallback }, providers: [{ id: profileId, name: "OpenAI", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "", models: [{ id: modelId, name: "gpt-4.1-mini", pricing: defaultPricing("openai-compatible", "gpt-4.1-mini") }] }] }; }
function modelRoles(): ModelUsageRole[] { return ["agent", "drafter", "inline", "writer", "reviewer", "summarizer"]; }
function normalizeModel(input: { id?: string; name: string; pricing?: Partial<TokenPricing>; temperature?: number; topP?: number }, provider: ProviderId, existing?: SavedModel): SavedModel {
  const name = input.name.trim();
  if (!name) throw new Error("模型名称不能为空");
  const pricing = normalizePricing(provider, name, input.pricing, existing?.pricing);
  return {
    id: existing?.id ?? input.id ?? randomUUID(),
    name,
    pricing,
    temperature: optional(input.temperature, 0, 2),
    topP: optional(input.topP, 0, 1),
  };
}
function validateProvider(value: ProviderId) { if (value !== "deepseek" && value !== "openai-compatible") throw new Error("不支持的模型供应商"); return value; }
function providerLabel(value: ProviderId) { return value === "deepseek" ? "DeepSeek" : "OpenAI 兼容"; }
function optional(value: number | undefined, min: number, max: number) { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? Math.round(value * 100) / 100 : undefined; }
function normalizeBaseUrl(value: string) { const text = value.trim().replace(/\/+$/, ""); let url: URL; try { url = new URL(text); } catch { throw new Error("API 地址格式无效"); } const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"; if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("API 地址必须使用 HTTPS，本地服务除外"); return text; }
function maskKey(value: string) { return !value ? "" : value.length < 9 ? "••••••••" : `${value.slice(0, 3)}••••${value.slice(-4)}`; }
