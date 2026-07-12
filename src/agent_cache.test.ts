import assert from "node:assert/strict";
import test from "node:test";
import { agentToolNames, agentToolSchemaHash } from "./agent.js";

test("agent tool schema has stable order and unique names", () => {
  const names = agentToolNames();
  assert.equal(new Set(names).size, names.length);
  assert.equal(agentToolSchemaHash(), "233d8f7e33366cfc");
});
