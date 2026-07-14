import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROVIDERS_BACKUP_SUFFIX, ProviderManager } from "./provider_catalog.js";
import { WriterProject } from "./project.js";

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

test("legacy v2 catalog without roleplay assignment inherits agent model", () => {
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
    writeFileSync(providers.path, JSON.stringify(raw), "utf8");

    const migrated = new ProviderManager(project);
    assert.deepEqual(migrated.catalog().assignments.roleplay, migrated.catalog().assignments.agent);
    assert.equal(migrated.modelConfig("roleplay").model, "agent-model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
