import assert from "node:assert/strict";
import test from "node:test";
import { agentToolNames, agentToolSchemaHash } from "./schema.js";
import { registeredToolNames } from "./execute.js";

test("every tool schema has a registered handler", () => {
  const schema = new Set(agentToolNames());
  const handlers = new Set(registeredToolNames());
  assert.equal(schema.size, handlers.size);
  for (const name of schema) {
    assert.ok(handlers.has(name), `missing handler: ${name}`);
  }
  assert.equal(agentToolSchemaHash().length, 16);
});
