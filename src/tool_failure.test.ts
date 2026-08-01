import assert from "node:assert/strict";
import test from "node:test";
import { isToolDependencyTimeout } from "./tool_failure.js";

test("normalizes provider timeout errors as dependency failures", () => {
  const aborted = new Error("The operation was aborted due to timeout");
  aborted.name = "AbortError";
  assert.equal(isToolDependencyTimeout(aborted), true);
  assert.equal(isToolDependencyTimeout(new Error("request timed out")), true);
  assert.equal(isToolDependencyTimeout(new Error("正文格式无效")), false);
});
