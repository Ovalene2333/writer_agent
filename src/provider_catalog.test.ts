import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelSupportsToolChoice, thinkingRequestOptions } from "./model_compat.js";
import { defaultPricing } from "./pricing.js";
import { parseProviderModelIds, PROVIDERS_BACKUP_SUFFIX, ProviderManager } from "./provider_catalog.js";
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

test("provider model directory parser accepts compatible shapes and deduplicates ids", () => {
  assert.deepEqual(parseProviderModelIds({
    data: [{ id: "model-z" }, { id: " model-a " }, { id: "model-z" }, { object: "model" }, null],
  }), ["model-a", "model-z"]);
  assert.deepEqual(parseProviderModelIds({ models: ["beta", { id: "alpha" }, ""] }), ["alpha", "beta"]);
  assert.deepEqual(parseProviderModelIds({ data: "invalid" }), []);
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
      return new Response(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }), {
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
    assert.deepEqual(providers.catalog(), before);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("applySamplingDefaults writes temp/topP to all role-assigned models without api key", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-provider-sampling-"));
  try {
    const project = WriterProject.init(root, "采样覆盖");
    const providers = new ProviderManager(project);
    // Default catalog has empty api keys — sampling must still work.
    const before = providers.catalog();
    assert.equal(before.providers[0].apiKeyConfigured, false);

    const agentModel = before.providers[0].models[0];
    providers.assign("writer", before.providers[0].id, agentModel.id);
    if (before.providers[1]?.models[0]) {
      providers.assign("reviewer", before.providers[1].id, before.providers[1].models[0].id);
    }

    const result = providers.applySamplingDefaults(0.78, 0.9);
    assert.equal(result.temperature, 0.78);
    assert.equal(result.topP, 0.9);
    assert.ok(result.updatedModels >= 1);
    assert.equal(providers.publicConfig().temperature, 0.78);
    assert.equal(providers.publicConfig().topP, 0.9);
    assert.equal(providers.modelConfig("writer").temperature, 0.78);
    assert.equal(providers.modelConfig("writer").topP, 0.9);
    if (before.providers[1]?.models[0]) {
      assert.equal(providers.modelConfig("reviewer").temperature, 0.78);
      assert.equal(providers.modelConfig("reviewer").topP, 0.9);
    }
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
    assert.deepEqual(openAi!.models.map((m) => m.name), ["gpt-4.1-mini"]);
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

test("legacy v2 catalog fills roleplay and flash assignments", () => {
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
    delete raw.assignments.flash;
    writeFileSync(providers.path, JSON.stringify(raw), "utf8");

    const migrated = new ProviderManager(project);
    assert.deepEqual(migrated.catalog().assignments.roleplay, migrated.catalog().assignments.agent);
    assert.equal(migrated.modelConfig("roleplay").model, "agent-model");
    assert.deepEqual(migrated.catalog().assignments.flash, migrated.catalog().assignments.summarizer);
    assert.equal(migrated.modelConfig("flash").model, migrated.modelConfig("summarizer").model);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
