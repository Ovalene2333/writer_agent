import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelSupportsToolChoice, nonThinkingRequestOptions, samplingRequestOptions, thinkingRequestOptions } from "./model_compat.js";
import { defaultPricing } from "./pricing.js";
import {
  extractProviderContextWindow,
  parseProviderModelEntries,
  parseProviderModelIds,
  PROVIDERS_BACKUP_SUFFIX,
  ProviderManager,
} from "./provider_catalog.js";
import { WriterProject } from "./project.js";

test("DeepSeek Thinking omits unsupported tool_choice", () => {
  assert.equal(modelSupportsToolChoice({ provider: "deepseek", baseUrl: "https://proxy.example/v1" }), false);
  assert.equal(modelSupportsToolChoice({ baseUrl: "https://api.deepseek.com" }), false);
  assert.equal(modelSupportsToolChoice({ provider: "openai-compatible", baseUrl: "https://api.openai.com/v1" }), true);
});

test("DeepSeek requests explicit Thinking", () => {
  assert.deepEqual(thinkingRequestOptions({ provider: "deepseek", baseUrl: "https://proxy.example/v1" }), {
    thinking: { type: "enabled" },
  });
});

test("DeepSeek continuation can explicitly disable Thinking after a missing reasoning payload", () => {
  const model = { provider: "deepseek" as const, baseUrl: "https://api.deepseek.com" };
  assert.deepEqual(nonThinkingRequestOptions(model), { thinking: { type: "disabled" } });
});

test("provider model directory parser accepts compatible shapes and deduplicates ids", () => {
  assert.deepEqual(parseProviderModelIds({
    data: [{ id: "model-z" }, { id: " model-a " }, { id: "model-z" }, { object: "model" }, null],
  }), ["model-a", "model-z"]);
  assert.deepEqual(parseProviderModelIds({ models: ["beta", { id: "alpha" }, ""] }), ["alpha", "beta"]);
  assert.deepEqual(parseProviderModelIds({ data: "invalid" }), []);
});

test("provider model entries pick up heterogeneous context window fields", () => {
  assert.equal(extractProviderContextWindow({ id: "x", context_length: 131_072 }), 131_072);
  assert.equal(extractProviderContextWindow({ id: "x", max_model_len: 8192 }), 8192);
  assert.equal(extractProviderContextWindow({ id: "x", meta: { context_window: "128k" } }), 128_000);
  assert.equal(extractProviderContextWindow({ id: "x", max_tokens: 4096 }), undefined);
  assert.equal(extractProviderContextWindow({ id: "x", max_tokens: 32768 }), 32768);
  assert.deepEqual(parseProviderModelEntries({
    data: [
      { id: "openrouter/a", context_length: 200_000 },
      { id: "vllm-b", max_model_len: 16_384 },
      { id: "plain-c" },
      { id: "openrouter/a", context_length: 1 },
    ],
  }), [
    { name: "openrouter/a", contextWindow: 200_000 },
    { name: "plain-c" },
    { name: "vllm-b", contextWindow: 16_384 },
  ]);
});

test("scanModels uses a saved key, returns default pricing, and does not mutate the catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "writer-provider-scan-"));
  const originalFetch = globalThis.fetch;
  try {
    const project = WriterProject.init(root, "扫描供应商模型");
    const providers = new ProviderManager(project);
    const catalog = providers.saveProfile({
      name: "兼容供应商",
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-scan-test",
      models: [{ name: "configured-model" }],
    });
    const profile = catalog.providers.find(item => item.name === "兼容供应商")!;
    let requestedUrl = "";
    let authorization = "";
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({
        data: [
          { id: "model-b", context_length: 200_000 },
          { id: "model-a" },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const before = providers.catalog();
    const result = await providers.scanModels({ profileId: profile.id });

    assert.equal(requestedUrl, "https://api.example.com/v1/models");
    assert.equal(authorization, "Bearer sk-scan-test");
    assert.deepEqual(result.models.map(model => model.name), ["model-a", "model-b"]);
    assert.deepEqual(result.models[0].pricing, defaultPricing("openai-compatible", "model-a"));
    assert.equal(result.models[0].contextFromProvider, undefined);
    assert.equal(result.models[1].contextFromProvider, true);
    assert.equal(result.models[1].pricing.contextWindow, 200_000);
    assert.deepEqual(providers.catalog(), before);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("disableSampling survives save/reload and reaches every role's ModelConfig", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-provider-nosampling-"));
  try {
    const project = WriterProject.init(root, "禁用采样");
    const providers = new ProviderManager(project);
    const seeded = providers.catalog().providers[0];
    providers.saveProfile({
      id: seeded.id,
      name: seeded.name,
      provider: seeded.provider,
      baseUrl: seeded.baseUrl,
      apiKey: "test-key",
      models: [{ id: seeded.models[0].id, name: seeded.models[0].name, temperature: 0.8, disableSampling: true }],
    });
    const saved = providers.catalog().providers[0].models[0];
    providers.assign("writer", seeded.id, saved.id);
    assert.equal(saved.disableSampling, true);
    assert.equal(providers.modelConfig("writer").disableSampling, true);
    assert.equal(samplingRequestOptions(providers.modelConfig("writer"), { temperature: 0 }).temperature, undefined);

    // Reload from disk: the flag is persisted, not just in memory.
    assert.equal(new ProviderManager(project).modelConfig("writer").disableSampling, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI advanced request parameters survive save/reload and reach ModelConfig", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-provider-advanced-"));
  try {
    const project = WriterProject.init(root, "高级参数");
    const providers = new ProviderManager(project);
    const seeded = providers.catalog().providers[0];
    providers.saveProfile({
      id: seeded.id,
      name: seeded.name,
      provider: "openai-compatible",
      baseUrl: seeded.baseUrl,
      apiKey: "test-key",
      models: [{
        id: seeded.models[0].id,
        name: seeded.models[0].name,
        temperature: 0.7,
        topP: 0.9,
        frequencyPenalty: 0.4,
        presencePenalty: -0.2,
        reasoningEffort: "high",
        verbosity: "low",
      }],
    });
    const reloaded = new ProviderManager(project).modelConfig("agent");
    assert.equal(reloaded.frequencyPenalty, 0.4);
    assert.equal(reloaded.presencePenalty, -0.2);
    assert.equal(reloaded.reasoningEffort, "high");
    assert.equal(reloaded.verbosity, "low");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default catalog seeds OpenAI and DeepSeek with latest defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-provider-default-"));
  try {
    const project = WriterProject.init(root, "默认供应商");
    const providers = new ProviderManager(project);
    const catalog = providers.catalog();

    assert.equal(catalog.providers.length, 2);
    const openAi = catalog.providers.find((item) => item.name === "OpenAI");
    const deepseek = catalog.providers.find((item) => item.name === "DeepSeek");
    assert.ok(openAi);
    assert.ok(deepseek);

    assert.equal(openAi!.provider, "openai-compatible");
    assert.equal(openAi!.baseUrl, "https://api.openai.com/v1");
    assert.deepEqual(openAi!.models.map((m) => m.name), ["gpt-4.1-mini", "gpt-image-2"]);
    assert.equal(catalog.activeProviderId, openAi!.id);
    assert.equal(catalog.activeModelId, openAi!.models[0].id);

    assert.equal(deepseek!.provider, "deepseek");
    assert.equal(deepseek!.baseUrl, "https://api.deepseek.com");
    assert.deepEqual(
      deepseek!.models.map((m) => m.name).sort(),
      ["deepseek-v4-flash", "deepseek-v4-pro"],
    );
    const flash = deepseek!.models.find((m) => m.name === "deepseek-v4-flash")!;
    const pro = deepseek!.models.find((m) => m.name === "deepseek-v4-pro")!;
    assert.deepEqual(flash.pricing, defaultPricing("deepseek", "deepseek-v4-flash"));
    assert.deepEqual(pro.pricing, defaultPricing("deepseek", "deepseek-v4-pro"));
    assert.equal(providers.modelConfig("agent").model, "gpt-4.1-mini");
    assert.equal(providers.imageModelConfig().model, "gpt-image-2");
    assert.equal(providers.modelConfig("flash").model, "deepseek-v4-flash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("save() updates active model only and keeps sibling models", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-provider-save-"));
  try {
    const project = WriterProject.init(root, "模型保留");
    const providers = new ProviderManager(project);

    const catalog = providers.saveProfile({
      name: "云雾API",
      provider: "openai-compatible",
      baseUrl: "https://yunwu.ai/v1",
      apiKey: "sk-test-key-for-unit",
      models: [
        { name: "model-a", temperature: 0.5, topP: 0.8 },
        { name: "model-b", temperature: 0.6, topP: 0.9 },
        { name: "model-c", temperature: 0.7 },
      ],
    });

    const profile = catalog.providers.find((item) => item.name === "云雾API");
    assert.ok(profile);
    assert.equal(profile!.models.length, 3);
    const active = profile!.models.find((item) => item.name === "model-a")!;
    const roleplay = profile!.models.find((item) => item.name === "model-b")!;
    providers.select(profile!.id, active.id);
    providers.assign("agent", profile!.id, active.id);
    providers.assign("roleplay", profile!.id, roleplay.id);
    assert.equal(providers.modelConfig("agent").model, "model-a");
    assert.equal(providers.modelConfig("roleplay").model, "model-b");

    // Style-template path: only temperature/topP for the active model.
    providers.save({
      provider: "openai-compatible",
      baseUrl: "https://yunwu.ai/v1",
      model: "model-a",
      temperature: 0.85,
      topP: 0.95,
    });

    const after = providers.catalog().providers.find((item) => item.id === profile!.id)!;
    assert.equal(after.models.length, 3, "sibling models must not be wiped by save()");
    assert.deepEqual(
      after.models.map((item) => item.name).sort(),
      ["model-a", "model-b", "model-c"],
    );
    const updated = after.models.find((item) => item.name === "model-a")!;
    assert.equal(updated.temperature, 0.85);
    assert.equal(updated.topP, 0.95);
    const sibling = after.models.find((item) => item.name === "model-b")!;
    assert.equal(sibling.temperature, 0.6);
    assert.equal(sibling.topP, 0.9);
    assert.equal(providers.modelConfig("roleplay").model, "model-b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persist writes providers.json.bak before overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-provider-bak-"));
  try {
    const project = WriterProject.init(root, "备份");
    const providers = new ProviderManager(project);
    providers.saveProfile({
      name: "A",
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-aaaaaaaa",
      models: [{ name: "first" }],
    });
    const firstRaw = readFileSync(providers.path, "utf8");

    providers.saveProfile({
      id: providers.catalog().providers[0].id,
      name: "A",
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-aaaaaaaa",
      models: [{ name: "first" }, { name: "second" }],
    });

    const bak = `${providers.path}${PROVIDERS_BACKUP_SUFFIX}`;
    assert.ok(existsSync(bak), "backup file should exist");
    assert.equal(readFileSync(bak, "utf8"), firstRaw);
    assert.ok(providers.catalog().providers[0].models.some((item) => item.name === "second"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy v2 catalog fills writing roles and splits roleplay submodels compatibly", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-provider-roleplay-migration-"));
  try {
    const project = WriterProject.init(root, "角色扮演模型迁移");
    const providers = new ProviderManager(project);
    const catalog = providers.saveProfile({
      name: "独立模型",
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-roleplay-test",
      models: [{ name: "agent-model" }, { name: "roleplay-model" }],
    });
    const profile = catalog.providers.find(item => item.name === "独立模型")!;
    providers.assign("agent", profile.id, profile.models[0].id);

    const raw = JSON.parse(readFileSync(providers.path, "utf8")) as { assignments: Record<string, unknown> };
    delete raw.assignments.roleplay;
    delete raw.assignments.image;
    delete raw.assignments.flash;
    delete raw.assignments.roleplay_perception;
    delete raw.assignments.roleplay_quality;
    delete raw.assignments.roleplay_memory;
    writeFileSync(providers.path, JSON.stringify(raw), "utf8");

    const migrated = new ProviderManager(project);
    assert.deepEqual(migrated.catalog().assignments.roleplay, migrated.catalog().assignments.agent);
    assert.deepEqual(migrated.catalog().assignments.image, migrated.catalog().assignments.agent);
    assert.equal(migrated.modelConfig("roleplay").model, "agent-model");
    assert.deepEqual(migrated.catalog().assignments.flash, migrated.catalog().assignments.summarizer);
    assert.equal(migrated.modelConfig("flash").model, migrated.modelConfig("summarizer").model);
    assert.deepEqual(migrated.catalog().assignments.roleplay_perception, migrated.catalog().assignments.roleplay);
    assert.deepEqual(migrated.catalog().assignments.roleplay_quality, migrated.catalog().assignments.flash);
    assert.deepEqual(migrated.catalog().assignments.roleplay_memory, migrated.catalog().assignments.summarizer);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
