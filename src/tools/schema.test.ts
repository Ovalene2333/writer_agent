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

test("scene write schema supports delegated prose while fast mode validates its runtime payload", () => {
  const scene = TOOLS.find(tool => tool.function.name === "write_chapter_scene");
  assert.deepEqual(scene?.function.parameters.required, ["sceneId", "notes"]);
  assert.equal(TOOLS.some(tool => tool.function.name === "write_chapter_scene_notes"), false);
  assert.equal(TOOLS.some(tool => tool.function.name === "write_document_isolated"), false);
});

test("scene guides and character reads expose source-linked capability selection", () => {
  const begin = TOOLS.find(tool => tool.function.name === "begin_chapter_draft");
  const beginProperties = begin?.function.parameters.properties as Record<string, unknown>;
  const scenes = beginProperties.scenes as { items: { properties: Record<string, unknown> } };
  const scopes = scenes.items.properties.characterScopes as { items: { required: string[]; properties: Record<string, unknown> } };
  assert.deepEqual(scopes.items.required, ["characterId", "competencyUses"]);
  assert.ok(Object.hasOwn(scopes.items.properties, "competencyUses"));
  assert.ok(Object.hasOwn(scopes.items.properties, "dialogue"));

  const getCharacter = TOOLS.find(tool => tool.function.name === "get_character");
  const readProperties = getCharacter?.function.parameters.properties as Record<string, unknown>;
  assert.ok(Object.hasOwn(readProperties, "competencyIds"));
});
