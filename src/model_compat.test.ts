import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  applyProviderReasoningToChatBody,
  nonThinkingRequestOptions,
  providerReasoningWire,
  samplingRequestOptions,
  thinkingRequestOptions,
} from "./model_compat.js";

test("sampling options fall back to the model config, then to omission", () => {
  assert.deepEqual(samplingRequestOptions({ temperature: 0.7, topP: 0.9 }), { temperature: 0.7, top_p: 0.9 });
  assert.deepEqual(samplingRequestOptions({}), {});
  // An explicit per-call value wins over the configured one.
  assert.deepEqual(samplingRequestOptions({ temperature: 0.7 }, { temperature: 0 }), { temperature: 0 });
});

test("disableSampling drops the whole group, not just temperature", () => {
  const disabled = { temperature: 0.7, topP: 0.9, disableSampling: true };
  assert.deepEqual(samplingRequestOptions(disabled), {});
  assert.deepEqual(
    samplingRequestOptions(disabled, { temperature: 0, topP: 1, frequencyPenalty: 0.3, presencePenalty: 0.15 }),
    {},
    "a hardcoded per-call temperature must not survive the switch",
  );
});

test("penalties only ride along when explicitly requested", () => {
  assert.deepEqual(
    samplingRequestOptions({}, { temperature: 1, frequencyPenalty: 0.2, presencePenalty: 0.2 }),
    { temperature: 1, frequency_penalty: 0.2, presence_penalty: 0.2 },
  );
});

test("configured OpenAI request parameters share the request choke point", () => {
  assert.deepEqual(
    samplingRequestOptions({
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      frequencyPenalty: 0.4,
      presencePenalty: -0.2,
      reasoningEffort: "high",
      verbosity: "low",
    }),
    { frequency_penalty: 0.4, presence_penalty: -0.2, reasoning_effort: "high", verbosity: "low" },
  );
  assert.deepEqual(
    samplingRequestOptions({
      provider: "openai-compatible",
      reasoningEffort: "medium",
      verbosity: "high",
      temperature: 0.7,
      disableSampling: true,
    }),
    { reasoning_effort: "medium", verbosity: "high" },
  );
});

test("deepseek provider sampling omits OpenAI reasoning_effort/verbosity", () => {
  assert.deepEqual(
    samplingRequestOptions({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      reasoningEffort: "high",
      verbosity: "low",
    }),
    {},
  );
  // Same protocol when deepseek provider points at a proxy — still thinking-only wire.
  assert.deepEqual(
    samplingRequestOptions({
      provider: "deepseek",
      baseUrl: "https://proxy.example/v1",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    }),
    {},
  );
});

test("provider reasoning wire branches only on ProviderId protocol", () => {
  assert.deepEqual(
    providerReasoningWire(
      { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", reasoningEffort: "medium" },
      { thinking: "disabled" },
    ),
    { thinking: { type: "disabled" } },
  );
  assert.deepEqual(
    providerReasoningWire(
      { provider: "deepseek", baseUrl: "https://proxy.example/v1", model: "deepseek-v4-flash", reasoningEffort: "high" },
      { thinking: "enabled" },
    ),
    { thinking: { type: "enabled" } },
  );
  // openai-compatible is one protocol regardless of model id (including deepseek weights).
  assert.deepEqual(
    providerReasoningWire(
      {
        provider: "openai-compatible",
        baseUrl: "https://opencode.example/v1",
        model: "deepseek-v4-flash",
        reasoningEffort: "medium",
      },
      { thinking: "disabled" },
    ),
    { reasoning_effort: "none" },
  );
  assert.deepEqual(
    providerReasoningWire(
      {
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        reasoningEffort: "medium",
        verbosity: "low",
      },
      { thinking: "disabled" },
    ),
    { reasoning_effort: "none", verbosity: "low" },
  );
  assert.deepEqual(
    providerReasoningWire(
      {
        provider: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5",
        reasoningEffort: "medium",
        verbosity: "low",
      },
      {},
    ),
    { reasoning_effort: "medium", verbosity: "low" },
  );
  // Call-site helpers are logical intent only.
  assert.deepEqual(thinkingRequestOptions({ provider: "openai-compatible" }), {
    thinking: { type: "enabled" },
  });
  assert.deepEqual(nonThinkingRequestOptions({ provider: "openai-compatible" }), {
    thinking: { type: "disabled" },
  });
});

test("applyProviderReasoningToChatBody rewrites mixed pre-spread fields", () => {
  const body = applyProviderReasoningToChatBody(
    {
      provider: "openai-compatible",
      baseUrl: "https://opencode.example/v1",
      model: "deepseek-v4-flash",
      reasoningEffort: "medium",
    },
    {
      model: "deepseek-v4-flash",
      messages: [],
      thinking: { type: "disabled" },
      reasoning_effort: "medium",
      temperature: 0.2,
    },
  );
  assert.deepEqual(body, {
    model: "deepseek-v4-flash",
    messages: [],
    temperature: 0.2,
    reasoning_effort: "none",
  });
});

/**
 * The bug behind disableSampling was never a missing flag — it was 13 request
 * bodies each spelling `temperature:` inline, so a provider-level setting could
 * only ever reach the three that consulted the model config. This guard keeps the
 * choke point the only way onto the wire; config plumbing and the helper's own
 * inputs are untouched because it only reads inside JSON.stringify bodies.
 */
test("no request body spells a sampling parameter directly", () => {
  const wireKey = /(?:^|[^_\w.])(?:temperature|top_p|frequency_penalty|presence_penalty|reasoning_effort|verbosity)\s*:/;
  const offenders: string[] = [];
  for (const path of sourceFiles("src")) {
    if (path.endsWith("model_compat.ts")) continue;
    const source = readFileSync(path, "utf8");
    if (!source.includes("modelFetch")) continue;
    for (const body of requestBodies(source)) {
      // What the helper is ASKED for is fine — only what bypasses it is a defect.
      for (const line of withoutHelperCalls(body.text).split("\n")) {
        if (!wireKey.test(line)) continue;
        offenders.push(`${path} (body at offset ${body.offset}): ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `route these through samplingRequestOptions:\n${offenders.join("\n")}`);
});

/** Blank out every `samplingRequestOptions( … )` call, braces and all. */
function withoutHelperCalls(text: string): string {
  const marker = "samplingRequestOptions(";
  let output = text;
  for (let at = output.indexOf(marker); at >= 0; at = output.indexOf(marker, at)) {
    const start = at + marker.length - 1;
    let depth = 0;
    let end = output.length;
    for (let index = start; index < output.length; index += 1) {
      if (output[index] === "(") depth += 1;
      else if (output[index] === ")") {
        depth -= 1;
        if (depth === 0) { end = index + 1; break; }
      }
    }
    // Preserve newlines so reported line content stays meaningful for real hits.
    output = output.slice(0, at) + output.slice(at, end).replace(/[^\n]/g, " ") + output.slice(end);
    at = end;
  }
  return output;
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map(entry => join(entry.parentPath ?? root, entry.name));
}

/** Balanced-brace extraction of every `JSON.stringify({ … })` object literal. */
function requestBodies(source: string): Array<{ offset: number; text: string }> {
  const bodies: Array<{ offset: number; text: string }> = [];
  const marker = "JSON.stringify({";
  for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
    const start = at + marker.length - 1;
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          bodies.push({ offset: at, text: source.slice(start, index + 1) });
          break;
        }
      }
    }
  }
  return bodies;
}
