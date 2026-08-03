import assert from "node:assert/strict";
import test from "node:test";
import { TOOLS, agentToolNames, agentToolSchemaHash } from "./schema.js";
import { registeredToolNames } from "./execute.js";

test("every tool schema has a registered handler", () => {
  const schema = new Set(agentToolNames());
  const handlers = new Set(registeredToolNames());
  assert.equal(schema.size, handlers.size);
  for (const name of schema) {
    assert.ok(handlers.has(name), `missing handler: ${name}`);
  }
  assert.equal(agentToolSchemaHash().length, 16);
  for (const tool of TOOLS) {
    const properties = tool.function.parameters.properties as Record<string, unknown> | undefined;
    assert.equal(Object.hasOwn(properties ?? {}, "deliverableId"), false, `${tool.function.name} exposes internal deliverableId`);
  }
});

test("scene write tools expose mode-specific required payloads", () => {
  const standard = TOOLS.find(tool => tool.function.name === "write_chapter_scene");
  const isolated = TOOLS.find(tool => tool.function.name === "write_chapter_scene_notes");
  const isolatedProperties = isolated?.function.parameters.properties as Record<string, unknown> | undefined;
  assert.deepEqual(standard?.function.parameters.required, ["sceneId", "notes", "content", "actualState"]);
  assert.deepEqual(isolated?.function.parameters.required, ["sceneId", "notes"]);
  assert.equal(Object.hasOwn(isolatedProperties ?? {}, "content"), false);
  assert.equal(Object.hasOwn(isolatedProperties ?? {}, "actualState"), false);
});
