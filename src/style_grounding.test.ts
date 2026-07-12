import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dynamicStyleGroundingPrompt, extractProseSample, stableStyleGroundingPrompt, styleFingerprint, styleGroundingPrompt } from "./style_grounding.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { defaultPricing } from "./pricing.js";

describe("styleFingerprint", () => {
  it("reports short rhythm for punchy webnovel-like prose", () => {
    const text = "他抬手。\n\n“滚。”\n\n三人倒飞出去。";
    const fp = styleFingerprint(text, "短句");
    assert.match(fp, /句法节奏=短促/);
    assert.match(fp, /显式要求=短句/);
  });
});

describe("extractProseSample", () => {
  it("drops markdown headings and prefers the ending window", () => {
    const text = `# 第一章

开头的铺垫写得很长。${"啊".repeat(40)}

## 第二节

结尾的对白很重要。
“你还要走吗？”
她没有回答。`;
    const sample = extractProseSample(text, 120);
    assert.ok(!sample.includes("# 第一章"));
    assert.ok(sample.includes("你还要走吗") || sample.includes("她没有回答"));
  });
});

describe("style prompt cache boundaries", () => {
  it("keeps project rules stable and places per-turn voice evidence after them", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-style-cache-"));
    const project = WriterProject.init(root, "缓存测试");
    const store = new WriterStore(project);
    try {
      const stableA = stableStyleGroundingPrompt(project, store, { intensive: true });
      const stableB = stableStyleGroundingPrompt(project, store, { intensive: true });
      const options = { intensive: true, preferredSample: "雨落在铁皮屋顶。她收起钥匙，没有回头。" };
      const dynamic = dynamicStyleGroundingPrompt(project, store, options);
      const combined = styleGroundingPrompt(project, store, options);
      assert.equal(stableA, stableB);
      assert.ok(dynamic.includes("雨落在铁皮屋顶"));
      assert.ok(combined.indexOf(stableA) < combined.indexOf(dynamic));
      const sessionId = store.createSession();
      const usage = store.recordUsage(sessionId, "cache-test", {
        promptTokens: 100, completionTokens: 10, cacheHitTokens: 40, cacheMissTokens: 60,
      }, defaultPricing("deepseek", "deepseek-v4-flash"));
      assert.equal(usage.cacheHitRate, 0.4);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
