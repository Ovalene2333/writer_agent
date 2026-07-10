import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelConfig, ModelUsageRole, ProviderCatalogPublic, ProviderId, ProviderModelPublic, ProviderProfilePublic, ProviderPublicConfig, TokenPricing } from "./types.js";
import { WriterProject } from "./project.js";

type SavedModel = ProviderModelPublic;
type SavedProfile = { id: string; name: string; provider: ProviderId; baseUrl: string; apiKey: string; models: SavedModel[] };
type ModelReference = { providerId: string; modelId: string };
type SavedCatalog = { version: 2; activeProviderId: string; activeModelId: string; assignments: Record<ModelUsageRole, ModelReference>; providers: SavedProfile[] };
type LegacyConfig = { provider: ProviderId; baseUrl: string; model: string; apiKey: string; pricing?: TokenPricing; temperature?: number; topP?: number };

export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

export class ProviderManager {
  private readonly path: string;
  private saved: SavedCatalog;
  constructor(project: WriterProject) { this.path = resolve(project.privateDir, "provider.json"); this.saved = this.load(); }

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
  async testConnection(profileId = this.saved.activeProviderId, modelId = this.saved.activeModelId): Promise<{ ok: true; message: string }> { const profile = this.saved.providers.find(item => item.id === profileId); const model = profile?.models.find(item => item.id === modelId); if (!profile || !model) throw new Error("供应商或模型不存在"); if (!profile.apiKey) throw new Error("请先配置 API Key"); const response = await fetch(`${profile.baseUrl.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${profile.apiKey}` }, signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error(`连接验证失败（${response.status}）：${(await response.text()).slice(0, 300)}`); const payload = await response.json() as { data?: Array<{ id?: string }> }; return { ok: true, message: payload.data?.some(item => item.id === model.name) === false ? "API 可用，但当前模型未出现在模型列表中" : "连接成功" }; }

  private active() { const profile = this.saved.providers.find(item => item.id === this.saved.activeProviderId) ?? this.saved.providers[0]; const model = profile.models.find(item => item.id === this.saved.activeModelId) ?? profile.models[0]; return { profile, model }; }
  private assigned(role: ModelUsageRole) { const ref = this.saved.assignments[role]; const profile = this.saved.providers.find(item => item.id === ref?.providerId) ?? this.active().profile; const model = profile.models.find(item => item.id === ref?.modelId) ?? profile.models[0]; return { profile, model }; }
  private publicProfile(profile: SavedProfile): ProviderProfilePublic { return { id: profile.id, name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, apiKeyConfigured: Boolean(profile.apiKey), apiKeyHint: maskKey(profile.apiKey), models: profile.models }; }
  private load(): SavedCatalog { if (!existsSync(this.path)) return defaultCatalog(); try { const parsed = JSON.parse(readFileSync(this.path, "utf8")) as SavedCatalog | LegacyConfig; if ("version" in parsed && parsed.version === 2 && parsed.providers?.length) { const fallback = { providerId: parsed.activeProviderId, modelId: parsed.activeModelId }; parsed.assignments = parsed.assignments ?? {} as SavedCatalog["assignments"]; for (const role of modelRoles()) parsed.assignments[role] ??= fallback; return parsed; } const legacy = parsed as LegacyConfig; if (!legacy.provider || !legacy.baseUrl || !legacy.model || typeof legacy.apiKey !== "string") throw new Error("字段不完整"); const profileId = randomUUID(), modelId = randomUUID(), fallback = { providerId: profileId, modelId }; return { version: 2, activeProviderId: profileId, activeModelId: modelId, assignments: { agent: fallback, drafter: fallback, inline: fallback, writer: fallback, reviewer: fallback, summarizer: fallback }, providers: [{ id: profileId, name: providerLabel(legacy.provider), provider: legacy.provider, baseUrl: normalizeBaseUrl(legacy.baseUrl), apiKey: legacy.apiKey, models: [{ id: modelId, name: legacy.model, pricing: legacy.pricing ?? defaultPricing(legacy.provider, legacy.model), temperature: legacy.temperature, topP: legacy.topP }] }] }; } catch (error) { throw new Error(`模型供应商配置无效：${error instanceof Error ? error.message : String(error)}`); } }
  private persist() { const temporary = `${this.path}.tmp-${process.pid}`, text = `${JSON.stringify(this.saved, null, 2)}\n`; writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 }); try { renameSync(temporary, this.path); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error; writeFileSync(this.path, text, { encoding: "utf8", mode: 0o600 }); try { unlinkSync(temporary); } catch {} } }
}

function defaultCatalog(): SavedCatalog { const profileId = randomUUID(), modelId = randomUUID(), fallback = { providerId: profileId, modelId }; return { version: 2, activeProviderId: profileId, activeModelId: modelId, assignments: { agent: fallback, drafter: fallback, inline: fallback, writer: fallback, reviewer: fallback, summarizer: fallback }, providers: [{ id: profileId, name: "OpenAI", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "", models: [{ id: modelId, name: "gpt-4.1-mini", pricing: defaultPricing("openai-compatible", "gpt-4.1-mini") }] }] }; }
function modelRoles(): ModelUsageRole[] { return ["agent", "drafter", "inline", "writer", "reviewer", "summarizer"]; }
function normalizeModel(input: { id?: string; name: string; pricing?: Partial<TokenPricing>; temperature?: number; topP?: number }, provider: ProviderId, existing?: SavedModel): SavedModel { const name = input.name.trim(); if (!name) throw new Error("模型名称不能为空"); const defaults = defaultPricing(provider, name), p = input.pricing; const pricing = p ? { cacheHit: rate(p.cacheHit, defaults.cacheHit), cacheMiss: rate(p.cacheMiss, defaults.cacheMiss), output: rate(p.output, defaults.output), currency: p.currency === "USD" ? "USD" as const : "CNY" as const, contextWindow: Math.max(1_000, Math.round(rate(p.contextWindow, defaults.contextWindow))) } : existing?.pricing ?? defaults; return { id: existing?.id ?? input.id ?? randomUUID(), name, pricing, temperature: optional(input.temperature, 0, 2), topP: optional(input.topP, 0, 1) }; }
function validateProvider(value: ProviderId) { if (value !== "deepseek" && value !== "openai-compatible") throw new Error("不支持的模型供应商"); return value; }
function providerLabel(value: ProviderId) { return value === "deepseek" ? "DeepSeek" : "OpenAI 兼容"; }
function defaultPricing(provider: ProviderId, model: string): TokenPricing { if (provider !== "deepseek") return { cacheHit: 0, cacheMiss: 0, output: 0, currency: "CNY", contextWindow: 128_000 }; return model === "deepseek-v4-pro" ? { cacheHit: .025, cacheMiss: 3, output: 6, currency: "CNY", contextWindow: 1_000_000 } : { cacheHit: .02, cacheMiss: 1, output: 2, currency: "CNY", contextWindow: 1_000_000 }; }
function rate(value: number | undefined, fallback: number) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback; }
function optional(value: number | undefined, min: number, max: number) { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? Math.round(value * 100) / 100 : undefined; }
function normalizeBaseUrl(value: string) { const text = value.trim().replace(/\/+$/, ""); let url: URL; try { url = new URL(text); } catch { throw new Error("API 地址格式无效"); } const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"; if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("API 地址必须使用 HTTPS，本地服务除外"); return text; }
function maskKey(value: string) { return !value ? "" : value.length < 9 ? "••••••••" : `${value.slice(0, 3)}••••${value.slice(-4)}`; }
