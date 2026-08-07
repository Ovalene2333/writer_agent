import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ModelConfig, ModelUsageRole, ProviderCatalogPublic, ProviderId, ProviderModelPublic, ProviderProfilePublic, ProviderPublicConfig, ReasoningEffort, ResponseVerbosity, TokenPricing } from "./types.js";
import { defaultPricing, normalizePricing } from "./pricing.js";
import {
  modelFetch,
  normalizeMaxConcurrent,
  normalizeMaxRpm,
  normalizeProxyUrl,
  syncProviderConcurrencyRegistry,
} from "./model_fetch.js";
import { WriterProject } from "./project.js";

type SavedModel = ProviderModelPublic;
type SavedProfile = {
  id: string;
  name: string;
  provider: ProviderId;
  baseUrl: string;
  proxyUrl?: string;
  apiKey: string;
  /** Max in-flight requests for this provider profile (default 5). */
  maxConcurrent?: number;
  /** Optional requests-per-minute cap. */
  maxRpm?: number;
  models: SavedModel[];
};
type ModelReference = { providerId: string; modelId: string };
type SavedCatalog = { version: 2; activeProviderId: string; activeModelId: string; assignments: Record<ModelUsageRole, ModelReference>; providers: SavedProfile[] };
type LegacyConfig = { provider: ProviderId; baseUrl: string; proxyUrl?: string; model: string; apiKey: string; pricing?: TokenPricing; temperature?: number; topP?: number };

export type ScannedProviderModel = {
  name: string;
  pricing: TokenPricing;
  /** True when pricing.contextWindow was taken from the provider /models payload. */
  contextFromProvider?: boolean;
};
export type ScanProviderModelsInput = {
  profileId?: string;
  provider?: ProviderId;
  baseUrl?: string;
  proxyUrl?: string;
  apiKey?: string;
};

export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

/** Canonical provider catalog filename under `.writer/` (portable; copy this file to migrate). */
export const PROVIDERS_FILENAME = "providers.json";
/** One-shot previous copy written before each persist (same directory as `path` + `.bak`). */
export const PROVIDERS_BACKUP_SUFFIX = ".bak";
/** Legacy single-file config; auto-migrated to `providers.json` on load. */
export const LEGACY_PROVIDER_FILENAME = "provider.json";

export class ProviderManager {
  /** Absolute path of the providers file (override with WRITER_PROVIDERS_FILE). */
  readonly path: string;
  private saved: SavedCatalog;

  constructor(project: WriterProject) {
    this.path = resolveProvidersPath(project);
    this.saved = this.load();
    this.syncConcurrencyRegistry();
  }

  modelConfig(role: ModelUsageRole = "agent"): ModelConfig {
    const { profile, model } = this.assigned(role);
    const imageRole = role === "image";
    const baseUrl = (imageRole ? process.env.WRITER_IMAGE_BASE_URL : undefined) || process.env.WRITER_BASE_URL || profile.baseUrl;
    const environmentConfigured = imageRole
      ? Boolean(process.env.WRITER_IMAGE_BASE_URL || process.env.WRITER_IMAGE_API_KEY || process.env.WRITER_IMAGE_MODEL)
      : Boolean(process.env.WRITER_BASE_URL || process.env.WRITER_API_KEY || process.env.WRITER_MODEL);
    return {
      provider: baseUrl.includes("api.deepseek.com") ? "deepseek" : profile.provider,
      providerId: profile.id,
      providerName: environmentConfigured
        ? (baseUrl.includes("api.deepseek.com") ? "DeepSeek" : "环境配置")
        : profile.name,
      baseUrl,
      proxyUrl: (imageRole ? process.env.WRITER_IMAGE_PROXY_URL : undefined) || process.env.WRITER_PROXY_URL || profile.proxyUrl,
      apiKey: (imageRole ? process.env.WRITER_IMAGE_API_KEY : undefined) || process.env.WRITER_API_KEY || profile.apiKey,
      model: (imageRole ? process.env.WRITER_IMAGE_MODEL : process.env.WRITER_MODEL) || model.name,
      maxConcurrent: normalizeMaxConcurrent(profile.maxConcurrent),
      ...(normalizeMaxRpm(profile.maxRpm) !== undefined ? { maxRpm: normalizeMaxRpm(profile.maxRpm) } : {}),
      requestPriority: requestPriorityForRole(role),
      pricing: model.pricing,
      temperature: model.temperature,
      topP: model.topP,
      frequencyPenalty: model.frequencyPenalty,
      presencePenalty: model.presencePenalty,
      reasoningEffort: model.reasoningEffort,
      verbosity: model.verbosity,
      disableSampling: model.disableSampling,
      supportsMultimodal: model.supportsMultimodal,
    };
  }
  imageModelConfig(): ModelConfig { return this.modelConfig("image"); }
  summaryModelConfig(): ModelConfig { return this.modelConfig("summarizer"); }
  publicConfig(): ProviderPublicConfig {
    const { profile, model } = this.active(); const config = this.modelConfig();
    const environmentConfigured = Boolean(process.env.WRITER_API_KEY || process.env.WRITER_BASE_URL || process.env.WRITER_MODEL);
    return {
      profileId: profile.id,
      modelId: model.id,
      provider: config.provider ?? profile.provider,
      baseUrl: config.baseUrl,
      proxyUrl: config.proxyUrl,
      model: config.model,
      apiKeyConfigured: Boolean(config.apiKey),
      apiKeyHint: maskKey(config.apiKey),
      source: environmentConfigured ? "environment" : "project",
      maxConcurrent: normalizeMaxConcurrent(profile.maxConcurrent),
      ...(normalizeMaxRpm(profile.maxRpm) !== undefined ? { maxRpm: normalizeMaxRpm(profile.maxRpm) } : {}),
      pricing: config.pricing ?? model.pricing,
      temperature: config.temperature,
      topP: config.topP,
      frequencyPenalty: config.frequencyPenalty,
      presencePenalty: config.presencePenalty,
      reasoningEffort: config.reasoningEffort,
      verbosity: config.verbosity,
      disableSampling: config.disableSampling,
      supportsMultimodal: config.supportsMultimodal,
    };
  }
  catalog(): ProviderCatalogPublic { return { activeProviderId: this.saved.activeProviderId, activeModelId: this.saved.activeModelId, assignments: this.saved.assignments, providers: this.saved.providers.map(profile => this.publicProfile(profile)) }; }

  saveProfile(input: {
    id?: string;
    name: string;
    provider: ProviderId;
    baseUrl: string;
    proxyUrl?: string;
    apiKey?: string;
    maxConcurrent?: number;
    /** Pass null to clear a previously saved RPM cap. */
    maxRpm?: number | null;
    models: Array<{
      id?: string;
      name: string;
      pricing?: Partial<TokenPricing>;
      temperature?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
      reasoningEffort?: ReasoningEffort;
      verbosity?: ResponseVerbosity;
      disableSampling?: boolean;
      supportsMultimodal?: boolean;
    }>;
  }): ProviderCatalogPublic {
    if (!input.models?.length) throw new Error("每个供应商至少需要一个模型");
    const existing = input.id ? this.saved.providers.find(item => item.id === input.id) : undefined;
    const maxConcurrent = input.maxConcurrent !== undefined
      ? normalizeMaxConcurrent(input.maxConcurrent)
      : existing?.maxConcurrent !== undefined
        ? normalizeMaxConcurrent(existing.maxConcurrent)
        : undefined;
    const maxRpm = Object.prototype.hasOwnProperty.call(input, "maxRpm")
      ? normalizeMaxRpm(input.maxRpm)
      : existing?.maxRpm !== undefined
        ? normalizeMaxRpm(existing.maxRpm)
        : undefined;
    const profile: SavedProfile = {
      id: existing?.id ?? randomUUID(),
      name: input.name.trim() || providerLabel(input.provider),
      provider: validateProvider(input.provider),
      baseUrl: normalizeBaseUrl(input.baseUrl),
      proxyUrl: normalizeProxyUrl(input.proxyUrl),
      apiKey: input.apiKey?.trim() || existing?.apiKey || "",
      ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
      ...(maxRpm !== undefined ? { maxRpm } : {}),
      models: [],
    };
    if (!profile.apiKey) throw new Error("API Key 不能为空");
    profile.models = input.models.map(item => normalizeModel(item, profile.provider, existing?.models.find(model => model.id === item.id)));
    const index = this.saved.providers.findIndex(item => item.id === profile.id);
    if (index >= 0) this.saved.providers[index] = profile; else this.saved.providers.push(profile);
    if (!this.saved.providers.some(item => item.id === this.saved.activeProviderId)) { this.saved.activeProviderId = profile.id; this.saved.activeModelId = profile.models[0].id; }
    if (this.saved.activeProviderId === profile.id && !profile.models.some(item => item.id === this.saved.activeModelId)) this.saved.activeModelId = profile.models[0].id;
    for (const role of modelRoles()) { const ref = this.saved.assignments[role]; if (ref.providerId === profile.id && !profile.models.some(item => item.id === ref.modelId)) this.saved.assignments[role] = { providerId: profile.id, modelId: profile.models[0].id }; }
    this.persist();
    return this.catalog();
  }
  select(profileId: string, modelId: string): ProviderPublicConfig { const profile = this.saved.providers.find(item => item.id === profileId); if (!profile?.models.some(item => item.id === modelId)) throw new Error("供应商或模型不存在"); this.saved.activeProviderId = profileId; this.saved.activeModelId = modelId; this.persist(); return this.publicConfig(); }
  assign(role: ModelUsageRole, providerId: string, modelId: string): ProviderCatalogPublic { if (!modelRoles().includes(role)) throw new Error("模型用途无效"); const profile = this.saved.providers.find(item => item.id === providerId); if (!profile?.models.some(item => item.id === modelId)) throw new Error("供应商或模型不存在"); this.saved.assignments[role] = { providerId, modelId }; if (role === "agent") { this.saved.activeProviderId = providerId; this.saved.activeModelId = modelId; } this.persist(); return this.catalog(); }
  deleteProfile(id: string): ProviderCatalogPublic {
    if (this.saved.providers.length <= 1) throw new Error("至少保留一个供应商");
    this.saved.providers = this.saved.providers.filter(item => item.id !== id);
    const fallback = { providerId: this.saved.providers[0].id, modelId: this.saved.providers[0].models[0].id };
    if (this.saved.activeProviderId === id) {
      this.saved.activeProviderId = fallback.providerId;
      this.saved.activeModelId = fallback.modelId;
    }
    for (const role of modelRoles()) {
      if (this.saved.assignments[role].providerId === id) this.saved.assignments[role] = fallback;
    }
    this.persist();
    return this.catalog();
  }
  /**
   * Legacy single-model update (style temperature, TUI /model, PUT /api/provider).
   * Only patches the active model — sibling models on the same provider are preserved.
   */
  save(input: { provider: ProviderId; baseUrl: string; model: string; apiKey?: string; pricing?: Partial<TokenPricing>; temperature?: number; topP?: number }): ProviderPublicConfig {
    const { profile, model: activeModel } = this.active();
    const models = profile.models.map((model) => {
      if (model.id !== activeModel.id) {
        return {
          id: model.id,
          name: model.name,
          pricing: model.pricing,
          temperature: model.temperature,
          topP: model.topP,
          frequencyPenalty: model.frequencyPenalty,
          presencePenalty: model.presencePenalty,
          reasoningEffort: model.reasoningEffort,
          verbosity: model.verbosity,
          disableSampling: model.disableSampling,
          supportsMultimodal: model.supportsMultimodal,
        };
      }
      return {
        id: model.id,
        name: input.model,
        pricing: input.pricing ?? model.pricing,
        temperature: input.temperature !== undefined ? input.temperature : model.temperature,
        topP: input.topP !== undefined ? input.topP : model.topP,
        frequencyPenalty: model.frequencyPenalty,
        presencePenalty: model.presencePenalty,
        reasoningEffort: model.reasoningEffort,
        verbosity: model.verbosity,
        disableSampling: model.disableSampling,
        supportsMultimodal: model.supportsMultimodal,
      };
    });
    this.saveProfile({
      id: profile.id,
      name: profile.name,
      provider: input.provider,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      maxConcurrent: profile.maxConcurrent,
      maxRpm: profile.maxRpm,
      models,
    });
    return this.publicConfig();
  }

  /** 通过 GET /models 探测可达性，不调用 chat/completions，不消耗 token。 */
  async testConnection(profileId = this.saved.activeProviderId, modelId = this.saved.activeModelId): Promise<{ ok: true; message: string; modelListed?: boolean }> {
    const profile = this.saved.providers.find(item => item.id === profileId);
    const model = profile?.models.find(item => item.id === modelId);
    if (!profile || !model) throw new Error("供应商或模型不存在");
    if (!profile.apiKey) throw new Error("请先配置 API Key");
    const base = profile.baseUrl.replace(/\/+$/, "");
    const response = await modelFetch(`${base}/models`, {
      headers: { authorization: `Bearer ${profile.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    }, {
      proxyUrl: profile.proxyUrl,
      concurrencyKey: profile.id,
      maxConcurrent: profile.maxConcurrent,
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

  /** 读取 OpenAI 兼容供应商的模型目录，不保存或修改当前配置。 */
  async scanModels(input: ScanProviderModelsInput = {}): Promise<{ models: ScannedProviderModel[] }> {
    const profile = input.profileId
      ? this.saved.providers.find(item => item.id === input.profileId)
      : undefined;
    if (input.profileId && !profile) throw new Error("供应商不存在");

    const provider = validateProvider(input.provider ?? profile?.provider ?? "openai-compatible");
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? profile?.baseUrl ?? "");
    const proxyUrl = input.proxyUrl !== undefined
      ? normalizeProxyUrl(input.proxyUrl)
      : profile?.proxyUrl;
    const apiKey = input.apiKey?.trim() || profile?.apiKey || "";
    if (!apiKey) throw new Error("请先配置 API Key");

    const response = await modelFetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    }, {
      proxyUrl,
      concurrencyKey: profile?.id,
      maxConcurrent: profile?.maxConcurrent,
    });
    if (!response.ok) {
      throw new Error(`扫描模型失败（${response.status}）：${(await response.text()).slice(0, 300)}`);
    }
    const entries = parseProviderModelEntries(await response.json());
    if (!entries.length) throw new Error("供应商未返回可用的模型列表");
    return {
      models: entries.map(entry => {
        const pricing = defaultPricing(provider, entry.name);
        if (!entry.contextWindow) return { name: entry.name, pricing };
        return {
          name: entry.name,
          pricing: { ...pricing, contextWindow: entry.contextWindow },
          contextFromProvider: true,
        };
      }),
    };
  }

  private active() { const profile = this.saved.providers.find(item => item.id === this.saved.activeProviderId) ?? this.saved.providers[0]; const model = profile.models.find(item => item.id === this.saved.activeModelId) ?? profile.models[0]; return { profile, model }; }
  private assigned(role: ModelUsageRole) { const ref = this.saved.assignments[role]; const profile = this.saved.providers.find(item => item.id === ref?.providerId) ?? this.active().profile; const model = profile.models.find(item => item.id === ref?.modelId) ?? profile.models[0]; return { profile, model }; }
  private publicProfile(profile: SavedProfile): ProviderProfilePublic {
    return {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      proxyUrl: profile.proxyUrl,
      apiKeyConfigured: Boolean(profile.apiKey),
      apiKeyHint: maskKey(profile.apiKey),
      maxConcurrent: normalizeMaxConcurrent(profile.maxConcurrent),
      ...(normalizeMaxRpm(profile.maxRpm) !== undefined ? { maxRpm: normalizeMaxRpm(profile.maxRpm) } : {}),
      models: profile.models,
    };
  }
  private syncConcurrencyRegistry(): void {
    syncProviderConcurrencyRegistry(this.saved.providers.map(profile => ({
      id: profile.id,
      baseUrl: profile.baseUrl,
      maxConcurrent: profile.maxConcurrent,
      maxRpm: profile.maxRpm,
    })));
  }
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
    // Best-effort previous snapshot for recovery after accidental overwrites.
    if (existsSync(this.path)) {
      try {
        copyFileSync(this.path, `${this.path}${PROVIDERS_BACKUP_SUFFIX}`);
      } catch {
        /* ignore backup failures — never block config writes */
      }
    }
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
    this.syncConcurrencyRegistry();
  }
}

export type ParsedProviderModelEntry = {
  name: string;
  /** Present only when the provider advertised a usable context window. */
  contextWindow?: number;
};

/** 解析常见的 OpenAI 兼容模型目录响应，并稳定去重、排序（仅 id）。 */
export function parseProviderModelIds(payload: unknown): string[] {
  return parseProviderModelEntries(payload).map(entry => entry.name);
}

/**
 * 解析模型目录；尽力读取上下文窗口等扩展字段。
 * 官方 OpenAI 通常只有 id；OpenRouter / vLLM / 部分中转会带 context_length 等。
 */
export function parseProviderModelEntries(payload: unknown): ParsedProviderModelEntry[] {
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined;
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];
  const parsed: ParsedProviderModelEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry === "string") {
      const name = entry.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      parsed.push({ name });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row.id === "string" && row.id.trim()
      ? row.id.trim()
      : typeof row.name === "string" && row.name.trim()
        ? row.name.trim()
        : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const contextWindow = extractProviderContextWindow(row);
    parsed.push(contextWindow ? { name, contextWindow } : { name });
  }
  return parsed.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

/**
 * Best-effort context window from heterogeneous OpenAI-compatible /models payloads.
 * Prefer explicit context fields; avoid small max_tokens that are often max-output only.
 */
export function extractProviderContextWindow(entry: Record<string, unknown>): number | undefined {
  const candidates: unknown[] = [
    entry.context_window,
    entry.context_length,
    entry.contextLength,
    entry.context,
    entry.max_context_length,
    entry.max_context,
    entry.max_model_len,
    entry.max_model_length,
    entry.max_input_tokens,
    entry.max_input_length,
    entry.max_seq_len,
    entry.n_ctx,
    entry.max_position_embeddings,
  ];

  const nestedObjects = [entry.meta, entry.limits, entry.architecture, entry.model_info, entry.capabilities]
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)));
  for (const nested of nestedObjects) {
    candidates.push(
      nested.context_window,
      nested.context_length,
      nested.contextLength,
      nested.context,
      nested.max_context_length,
      nested.max_context,
      nested.max_model_len,
      nested.max_input_tokens,
      nested.n_ctx,
    );
  }

  for (const value of candidates) {
    const window = normalizeContextWindowValue(value);
    if (window) return window;
  }

  // max_tokens is ambiguous (often output cap). Only accept when clearly a full context size.
  const maxTokens = normalizeContextWindowValue(entry.max_tokens ?? entry.max_token);
  if (maxTokens && maxTokens >= 8_192) return maxTokens;
  return undefined;
}

function normalizeContextWindowValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    return rounded >= 1_000 && rounded <= 16_000_000 ? rounded : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return undefined;
    const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
    if (!match) {
      const asNumber = Number(trimmed.replace(/[,_\s]/g, ""));
      return normalizeContextWindowValue(asNumber);
    }
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return undefined;
    const unit = match[2]?.toLowerCase();
    const multiplier = unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : unit === "b" ? 1_000_000_000 : 1;
    return normalizeContextWindowValue(base * multiplier);
  }
  return undefined;
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
    const agentFallback = parsed.assignments.agent ?? fallback;
    const flashFallback = parsed.assignments.summarizer ?? parsed.assignments.inline ?? fallback;
    parsed.assignments.image ??= fallback;
    parsed.assignments.roleplay ??= agentFallback;
    parsed.assignments.flash ??= flashFallback;
    // Dedicated roleplay slots preserve the exact pre-split routing on migration.
    parsed.assignments.roleplay_perception ??= parsed.assignments.roleplay;
    parsed.assignments.roleplay_quality ??= parsed.assignments.flash;
    parsed.assignments.roleplay_memory ??= parsed.assignments.summarizer ?? fallback;
    for (const role of modelRoles()) parsed.assignments[role] ??= fallback;
    for (const profile of parsed.providers) {
      profile.proxyUrl = normalizeProxyUrl(profile.proxyUrl);
      if (profile.maxConcurrent !== undefined) {
        profile.maxConcurrent = normalizeMaxConcurrent(profile.maxConcurrent);
      }
      if (profile.maxRpm !== undefined) {
        const rpm = normalizeMaxRpm(profile.maxRpm);
        if (rpm !== undefined) profile.maxRpm = rpm;
        else delete profile.maxRpm;
      }
      for (const model of profile.models) {
        model.pricing = normalizePricing(profile.provider, model.name, undefined, model.pricing);
        model.temperature = optional(model.temperature, 0, 2);
        model.topP = optional(model.topP, 0, 1);
        model.frequencyPenalty = optional(model.frequencyPenalty, -2, 2);
        model.presencePenalty = optional(model.presencePenalty, -2, 2);
        model.reasoningEffort = supportsOpenAiAdvancedParams(profile.provider)
          ? reasoningEffort(model.reasoningEffort)
          : undefined;
        model.verbosity = supportsOpenAiAdvancedParams(profile.provider)
          ? responseVerbosity(model.verbosity)
          : undefined;
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
      image: fallback,
      roleplay: fallback,
      roleplay_perception: fallback,
      roleplay_quality: fallback,
      roleplay_memory: fallback,
      flash: fallback,
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
      proxyUrl: normalizeProxyUrl(legacy.proxyUrl),
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

/** Seed catalog when no providers.json exists: OpenAI + DeepSeek with official defaults. */
function defaultCatalog(): SavedCatalog {
  const openAiId = randomUUID();
  const openAiModelId = randomUUID();
  const openAiImageModelId = randomUUID();
  const deepseekId = randomUUID();
  const deepseekFlashId = randomUUID();
  const deepseekProId = randomUUID();
  const fallback = { providerId: openAiId, modelId: openAiModelId };
  const image = { providerId: openAiId, modelId: openAiImageModelId };
  const flash = { providerId: deepseekId, modelId: deepseekFlashId };
  return {
    version: 2,
    activeProviderId: openAiId,
    activeModelId: openAiModelId,
    assignments: {
      agent: fallback,
      image,
      roleplay: fallback,
      roleplay_perception: fallback,
      roleplay_quality: flash,
      roleplay_memory: fallback,
      flash,
      drafter: fallback,
      inline: fallback,
      writer: fallback,
      reviewer: fallback,
      summarizer: fallback,
    },
    providers: [
      {
        id: openAiId,
        name: "OpenAI",
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        models: [
          {
            id: openAiModelId,
            name: "gpt-4.1-mini",
            pricing: defaultPricing("openai-compatible", "gpt-4.1-mini"),
          },
          {
            id: openAiImageModelId,
            name: "gpt-image-2",
            pricing: defaultPricing("openai-compatible", "gpt-image-2"),
          },
        ],
      },
      {
        id: deepseekId,
        name: "DeepSeek",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKey: "",
        models: [
          {
            id: deepseekFlashId,
            name: "deepseek-v4-flash",
            pricing: defaultPricing("deepseek", "deepseek-v4-flash"),
          },
          {
            id: deepseekProId,
            name: "deepseek-v4-pro",
            pricing: defaultPricing("deepseek", "deepseek-v4-pro"),
          },
        ],
      },
    ],
  };
}
function modelRoles(): ModelUsageRole[] {
  return [
    "agent", "image", "flash", "drafter", "inline", "writer", "reviewer", "summarizer",
    "roleplay", "roleplay_perception", "roleplay_quality", "roleplay_memory",
  ];
}

/** Short / latency-sensitive roles jump ahead of long agent streams in the provider queue. */
function requestPriorityForRole(role: ModelUsageRole): "high" | "normal" | "low" {
  if (
    role === "flash"
    || role === "inline"
    || role === "summarizer"
    || role === "roleplay_perception"
    || role === "roleplay_memory"
  ) {
    return "high";
  }
  if (role === "image") return "low";
  return "normal";
}
function normalizeModel(input: { id?: string; name: string; pricing?: Partial<TokenPricing>; temperature?: number; topP?: number; frequencyPenalty?: number; presencePenalty?: number; reasoningEffort?: ReasoningEffort; verbosity?: ResponseVerbosity; disableSampling?: boolean; supportsMultimodal?: boolean }, provider: ProviderId, existing?: SavedModel): SavedModel {
  const name = input.name.trim();
  if (!name) throw new Error("模型名称不能为空");
  const pricing = normalizePricing(provider, name, input.pricing, existing?.pricing);
  const supportsMultimodal = input.supportsMultimodal === true
    ? true
    : input.supportsMultimodal === false
      ? false
      : existing?.supportsMultimodal;
  return {
    id: existing?.id ?? input.id ?? randomUUID(),
    name,
    pricing,
    temperature: optional(input.temperature, 0, 2),
    topP: optional(input.topP, 0, 1),
    frequencyPenalty: optional(input.frequencyPenalty, -2, 2),
    presencePenalty: optional(input.presencePenalty, -2, 2),
    reasoningEffort: supportsOpenAiAdvancedParams(provider) ? reasoningEffort(input.reasoningEffort) : undefined,
    verbosity: supportsOpenAiAdvancedParams(provider) ? responseVerbosity(input.verbosity) : undefined,
    ...(input.disableSampling ? { disableSampling: true } : {}),
    ...(supportsMultimodal === true ? { supportsMultimodal: true } : {}),
  };
}
function supportsOpenAiAdvancedParams(provider: ProviderId): boolean {
  return provider === "openai-compatible" || provider === "openai-responses";
}
function validateProvider(value: ProviderId) {
  if (value !== "deepseek" && value !== "openai-compatible" && value !== "openai-responses") {
    throw new Error("不支持的模型供应商");
  }
  return value;
}
function providerLabel(value: ProviderId) {
  if (value === "deepseek") return "DeepSeek";
  if (value === "openai-responses") return "OpenAI Responses";
  return "OpenAI 兼容";
}
function optional(value: number | undefined, min: number, max: number) { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? Math.round(value * 100) / 100 : undefined; }
function reasoningEffort(value: unknown): ReasoningEffort | undefined { return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined; }
function responseVerbosity(value: unknown): ResponseVerbosity | undefined { return value === "low" || value === "medium" || value === "high" ? value : undefined; }
function normalizeBaseUrl(value: string) { const text = value.trim().replace(/\/+$/, ""); let url: URL; try { url = new URL(text); } catch { throw new Error("API 地址格式无效"); } const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"; if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("API 地址必须使用 HTTPS，本地服务除外"); return text; }
function maskKey(value: string) { return !value ? "" : value.length < 9 ? "••••••••" : `${value.slice(0, 3)}••••${value.slice(-4)}`; }
