import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorPolicyGateRules,
  loadAuthorPolicies,
  recordAuthorPolicyFeedback,
  setAuthorPolicyStatus,
  upsertAuthorPolicy,
} from "./author_policies.js";
import { WriterProject } from "./project.js";
import {
  loadProseGateRules,
  migrateProjectProseGatesToPolicies,
  upsertProseGateRule,
} from "./prose_gate_rules.js";

function policyInput(id: string) {
  return {
    id,
    title: "对白后解释潜台词",
    userIntent: "不要在对白后重复解释人物真正想表达什么。",
    semanticCriterion: "对白和行动已经表达同一意图时，紧随其后的旁白不得重复翻译该意图。",
    evidenceRequirement: "引用对白、相邻行动和解释句组成的最短连续原文。",
    allowConditions: ["解释增加了此前没有的新事实或改变读者判断时放行。"],
    revisionIntent: "删除重复翻译，保留对白、行动和新增事实。",
    dislikedExamples: [],
    acceptableExamples: [],
    scope: { documentKinds: ["chapter" as const], pathPrefixes: [], characterIds: [], sceneKinds: [] },
    enforcement: "advise" as const,
    status: "trial" as const,
    skillId: "revise-dialogue",
    sourceFeedback: "作者要求长期避免对白后的潜台词解释。",
  };
}

test("author policies compile to explainable trial gates and record dispositions", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-policy-"));
  try {
    const project = WriterProject.init(root, "测试");
    const policy = upsertAuthorPolicy(project, policyInput("dialogue-intent-translation"));
    assert.equal(policy.status, "trial");
    const gate = authorPolicyGateRules(project)[0];
    assert.equal(gate.policyId, policy.id);
    assert.equal(gate.skillId, "revise-dialogue");
    assert.equal(gate.severity, "warn", "trial policies never block delivery");
    assert.match(gate.instruction, /放行条件/u);

    const feedback = recordAuthorPolicyFeedback(project, {
      policyId: policy.id,
      disposition: "false_positive",
      evidence: "示例证据",
    });
    assert.equal(feedback.policyVersion, policy.version);
    assert.equal(setAuthorPolicyStatus(project, policy.id, "active").status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hard policies without release conditions are downgraded", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-policy-"));
  try {
    const project = WriterProject.init(root, "测试");
    const policy = upsertAuthorPolicy(project, {
      ...policyInput("unsafe-hard-policy"),
      allowConditions: [],
      enforcement: "block",
      status: "active",
    });
    assert.equal(policy.enforcement, "advise");
    assert.equal(authorPolicyGateRules(project)[0].severity, "warn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy project gates migrate to trial policies and become disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-policy-"));
  try {
    const project = WriterProject.init(root, "测试");
    upsertProseGateRule(project, {
      id: "dialogue_register",
      label: "对白语域",
      instruction: "人物对白应符合身份和当前关系，正式场景允许书面表达。",
      revisionIntent: "只调整不符合身份的措辞。",
      severity: "warn",
      sourceFeedback: "作者要求长期检查人物声口。",
    });
    const result = migrateProjectProseGatesToPolicies(project);
    assert.deepEqual(result.migratedPolicyIds, ["dialogue-register"]);
    assert.equal(loadAuthorPolicies(project)[0].status, "trial");
    assert.equal(loadProseGateRules(project).find(rule => rule.id === "dialogue_register")?.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
