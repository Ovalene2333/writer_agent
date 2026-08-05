import assert from "node:assert/strict";
import test from "node:test";
import { emptyCharacter, normalizeV3Character } from "./characters.js";
import { competencyUsePolicy, resolveCompetencyStates } from "./competency_state.js";
import type { OutlineNode } from "./types.js";

test("capability lifecycle distinguishes use, awakening, failed attempts, sealing, recovery, and overreach", () => {
  assert.equal(competencyUsePolicy("available", "use").allowed, true, "normal use");
  assert.equal(competencyUsePolicy("latent", "unlock").allowed, true, "first awakening");
  assert.equal(competencyUsePolicy("latent", "attempt").allowed, true, "failed attempt may be written");
  assert.equal(competencyUsePolicy("blocked", "use").allowed, false, "temporarily sealed ability cannot be used directly");
  assert.equal(competencyUsePolicy("blocked", "regain").allowed, true, "sealed ability may recover in-scene");
  assert.equal(competencyUsePolicy("lost", "use").allowed, false, "genuine overreach remains blocked");
  assert.equal(competencyUsePolicy("unknown", "unlock").allowed, true, "unknown legacy state may be established with evidence");
});

test("legacy false resolves to unknown while story state is authoritative", () => {
  const character = normalizeV3Character({
    ...emptyCharacter("闻溪"),
    id: 1,
    updatedAt: "",
    competencies: [{
      id: "sight", name: "灵视", summary: "看见异常", level: "", unlocked: false,
      description: "视野边缘出现轮廓", resources: [], limitations: [], costs: [],
    }],
  });
  assert.equal(resolveCompetencyStates(character).get("sight")?.state, "unknown");

  const migrated = normalizeV3Character({
    ...character,
    storyStates: [{
      id: "current", unanchored: true, location: "", physical: "", emotion: "",
      knowledge: [], beliefs: [], intentions: [], temporaryGoals: [], notes: "",
      competencyStates: [{
        id: "sight-state", competencyId: "sight", state: "latent",
        reason: "她只能偶尔看见轮廓，尚未完成稳定触发",
      }],
    }],
  });
  assert.equal(resolveCompetencyStates(migrated).get("sight")?.state, "latent");
  assert.equal(resolveCompetencyStates(migrated).get("sight")?.source, "story");
});

test("outline-targeted resolution does not leak a later unlock into an earlier scene", () => {
  const base = emptyCharacter("闻溪");
  const character = normalizeV3Character({
    ...base,
    id: 1,
    updatedAt: "",
    competencies: [{
      id: "sight", name: "灵视", summary: "看见异常", level: "", unlocked: true,
      description: "看清灵体", resources: [], limitations: [], costs: [],
    }],
    storyStates: [
      {
        id: "early-state", outlineNodeId: "early", location: "", physical: "", emotion: "",
        knowledge: [], beliefs: [], intentions: [], temporaryGoals: [], notes: "",
        competencyStates: [{ id: "early-sight", competencyId: "sight", state: "latent", reason: "只能看见模糊轮廓" }],
      },
      {
        id: "late-state", outlineNodeId: "late", location: "", physical: "", emotion: "",
        knowledge: [], beliefs: [], intentions: [], temporaryGoals: [], notes: "",
        competencyStates: [{ id: "late-sight", competencyId: "sight", state: "available", reason: "完成觉醒并稳定辨认" }],
      },
    ],
  });
  const nodes = [
    { id: "early", order: 1 },
    { id: "late", order: 2 },
  ] as OutlineNode[];
  assert.equal(resolveCompetencyStates(character, nodes, "early").get("sight")?.state, "latent");
  assert.equal(resolveCompetencyStates(character, nodes, "late").get("sight")?.state, "available");
});
