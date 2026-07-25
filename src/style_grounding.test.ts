import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dynamicStyleGroundingPrompt, extractProseSample, naturalProseCraftPrompt, sampleProseWindow, stableStyleGroundingPrompt, styleFingerprint, styleGroundingPrompt } from "./style_grounding.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { defaultPricing } from "./pricing.js";
import { getStyleTemplate } from "./templates.js";

describe("styleFingerprint", () => {
  it("reports short rhythm for punchy webnovel-like prose", () => {
    const text = "他抬手。\n\n“滚。”\n\n三人倒飞出去。";
    const fp = styleFingerprint(text, "短句");
    assert.match(fp, /句法节奏=短促/);
    assert.match(fp, /句长均值/);
    assert.match(fp, /单句段/);
    assert.match(fp, /对白起始段/);
    assert.match(fp, /显式要求=短句/);
  });
});

describe("naturalProseCraftPrompt", () => {
  it("turns naturalness into positive, scene-level writing decisions", () => {
    const prompt = naturalProseCraftPrompt();
    assert.match(prompt, /注意顺序/);
    assert.match(prompt, /场景推进/);
    assert.match(prompt, /对白意图/);
    assert.match(prompt, /具体性检查/);
    assert.match(prompt, /节奏与质感/);
    assert.match(prompt, /单句成段是重音/);
    assert.match(prompt, /绵延的长句/);
    assert.match(prompt, /半拍/);
    // Pink-elephant guard: the craft baseline stays positively framed, no bad-example demos.
    assert.ok(!prompt.includes("禁止"));
    assert.ok(!prompt.includes("坏例"));
    assert.ok(!prompt.includes("不是A"));
  });
});

describe("built-in style templates", () => {
  it("offers modern commercial fiction with readable, substantive pacing", () => {
    const template = getStyleTemplate("modern-commercial");
    assert.equal(template?.name, "现代商业文学");
    assert.match(template?.description ?? "", /好读.*有内容/);
    assert.match(template?.systemPromptAddition ?? "", /指令—执行—确认|指令-执行-确认/);
    assert.match(template?.systemPromptAddition ?? "", /半拍落点|阅读感/);
    assert.ok((template?.exampleContent.length ?? 0) > 300);
  });

  it("every built-in template points at anti-mechanical hygiene", () => {
    for (const template of ["webnovel-power", "literary", "modern-commercial", "light-novel", "mystery", "xianxia"] as const) {
      const body = getStyleTemplate(template)?.systemPromptAddition ?? "";
      assert.match(body, /全局自然叙事|反机械|堆砌/, `template ${template} should reference anti-mechanical rules`);
    }
  });

  it("persists custom templates and keeps built-ins read-only", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-custom-style-"));
    const project = WriterProject.init(root, "自定义模板测试");
    const original = getStyleTemplate("modern-commercial")!;
    try {
      const created = project.saveStyleTemplate({
        id: "quiet-comedy",
        name: "克制喜剧",
        description: "用关系错位和具体反应制造趣味",
        systemPromptAddition: "写作风格指令：笑点必须改变人物关系，不使用段子拼贴。",
        suggestedTemperature: 0.78,
        suggestedTopP: 0.9,
        exampleContent: "他把辞职信推过去。老板看完，问他打印机墨盒在哪里买。",
        exampleNotes: "严肃场面中的现实错位。",
      });
      assert.equal(project.styleTemplate(created.id)?.name, "克制喜剧");
      assert.ok(project.styleTemplates().some(template => template.id === created.id));

      assert.throws(
        () => project.saveStyleTemplate({
          ...original,
          name: "现代商业文学·项目版",
          systemPromptAddition: `${original.systemPromptAddition}\n- 项目覆盖规则：加强群像关系。`,
        }),
        /不可编辑/,
      );
      project.setStyle("modern-commercial");
      assert.equal(project.styleTemplate("modern-commercial")?.name, "现代商业文学");
      assert.doesNotMatch(project.styleTemplate("modern-commercial")?.systemPromptAddition ?? "", /项目覆盖规则/);

      // Stale on-disk overrides with built-in ids must not win over built-ins.
      mkdirSync(project.privateDir, { recursive: true });
      writeFileSync(resolve(project.privateDir, "style-templates.json"), `${JSON.stringify([{
        ...original,
        name: "现代商业文学·脏覆盖",
        systemPromptAddition: "应被忽略的覆盖",
      }, {
        id: "quiet-comedy",
        name: "克制喜剧",
        description: "用关系错位和具体反应制造趣味",
        systemPromptAddition: "写作风格指令：笑点必须改变人物关系，不使用段子拼贴。",
        suggestedTemperature: 0.78,
        suggestedTopP: 0.9,
        exampleContent: "他把辞职信推过去。",
        exampleNotes: "",
      }], null, 2)}\n`, "utf8");

      const reopened = new WriterProject(root);
      assert.equal(reopened.styleTemplate("quiet-comedy")?.name, "克制喜剧");
      assert.equal(reopened.styleTemplate("modern-commercial")?.name, "现代商业文学");
      assert.doesNotMatch(reopened.styleTemplate("modern-commercial")?.systemPromptAddition ?? "", /应被忽略/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe("sampleProseWindow", () => {
  const long = Array.from({ length: 40 }, (_, index) =>
    `第${index}段：夜里的雨敲着铁皮屋顶，敲了很久才停下来，屋檐还在滴水。`).join("\n\n");

  it("returns short exemplars whole and honors the budget on long ones", () => {
    assert.equal(sampleProseWindow("只有一段。", 200), "只有一段。");
    const window = sampleProseWindow(long, 300, () => 0.5);
    assert.ok(window.length <= 300);
    assert.ok(window.includes("铁皮屋顶"));
  });

  it("samples different paragraph-aligned windows for different rolls", () => {
    const head = sampleProseWindow(long, 300, () => 0);
    const tail = sampleProseWindow(long, 300, () => 0.99);
    assert.notEqual(head, tail);
    assert.match(head, /^第0段/);
    assert.doesNotMatch(tail, /^第0段/);
    // Window starts at a paragraph boundary, not mid-sentence.
    assert.match(tail, /^第\d+段：/);
  });
});

describe("style prompt cache boundaries", () => {
  it("keeps project rules stable and places per-turn voice evidence after them", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-style-cache-"));
    const project = WriterProject.init(root, "缓存测试");
    const store = new WriterStore(project);
    try {
      const stableA = stableStyleGroundingPrompt(project, store, { intensive: true });
      const stableB = stableStyleGroundingPrompt(project, store, { intensive: false });
      const options = { intensive: true, preferredSample: "雨落在铁皮屋顶。她收起钥匙，没有回头。" };
      const dynamic = dynamicStyleGroundingPrompt(project, store, options);
      const combined = styleGroundingPrompt(project, store, options);
      // intensive must not change the stable prefix bytes.
      assert.equal(stableA, stableB);
      assert.ok(stableA.includes("自然叙事原则"));
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

  it("does not move target-specific evidence into the stable cache prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-style-prefix-"));
    const project = WriterProject.init(root, "缓存前缀测试");
    const store = new WriterStore(project);
    try {
      const stableForA = stableStyleGroundingPrompt(project, store, { intensive: true });
      const stableForB = stableStyleGroundingPrompt(project, store, { intensive: true });
      const dynamicA = dynamicStyleGroundingPrompt(project, store, {
        intensive: true,
        targetPath: "chapters/a.md",
        preferredSample: "甲推开窗。雨水打湿了袖口。",
      });
      const dynamicB = dynamicStyleGroundingPrompt(project, store, {
        intensive: true,
        targetPath: "chapters/b.md",
        preferredSample: "乙扣上箱子，听见锁舌轻响。",
      });
      assert.equal(stableForA, stableForB);
      assert.notEqual(dynamicA, dynamicB);
      assert.ok(!stableForA.includes("甲推开窗"));
      assert.ok(!stableForB.includes("乙扣上箱子"));
      // 范文 bodies stay out of the stable slot.
      assert.ok(!stableForA.includes("---\n"));
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
