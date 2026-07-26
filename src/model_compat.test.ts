import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { samplingRequestOptions } from "./model_compat.js";

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

/**
 * The bug behind disableSampling was never a missing flag — it was 13 request
 * bodies each spelling `temperature:` inline, so a provider-level setting could
 * only ever reach the three that consulted the model config. This guard keeps the
 * choke point the only way onto the wire; config plumbing and the helper's own
 * inputs are untouched because it only reads inside JSON.stringify bodies.
 */
test("no request body spells a sampling parameter directly", () => {
  const wireKey = /(?:^|[^_\w.])(?:temperature|top_p|frequency_penalty|presence_penalty)\s*:/;
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
