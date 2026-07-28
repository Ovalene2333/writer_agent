import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChapterReview } from "./chapter_review.js";

const SCENES = new Set(["s1"]);
const SOURCE = "「我们必须面对这个真相。」他说。她也这样说话。最后他终于明白了一切。";

function review(issues: unknown[], verdict: "pass" | "revise" = "revise"): string {
  return JSON.stringify({
    verdict,
    chapterChange: "他交出了钥匙",
    reviewNotes: "对白无法区分说话人，章尾由叙述者点破主题",
    issues,
  });
}

test("终审接受三类新增的生成腔判断", () => {
  const parsed = parseChapterReview(review([
    {
      severity: "blocker", kind: "voice_homogenization", sceneId: "s1",
      evidence: ["「我们必须面对这个真相。」"],
      problem: "两个人物的台词可以互换", action: "给她一套自己的说话方式",
    },
    {
      severity: "warning", kind: "theme_stated", sceneId: "s1",
      evidence: ["最后他终于明白了一切。"],
      problem: "叙述者替读者做了判断", action: "改成一个具体动作收尾",
    },
    {
      severity: "warning", kind: "resolution_too_smooth", sceneId: "s1",
      evidence: [],
      problem: "冲突靠互相理解化解，没有人付出代价", action: "让某一方失去一件不可撤销的东西",
    },
  ]), SCENES, SOURCE);
  assert.deepEqual(parsed.issues.map(issue => issue.kind), [
    "voice_homogenization", "theme_stated", "resolution_too_smooth",
  ]);
  assert.equal(parsed.verdict, "revise");
});

test("新 kind 不放宽 blocker 的证据要求", () => {
  assert.throws(() => parseChapterReview(review([
    {
      severity: "blocker", kind: "theme_stated", sceneId: "s1",
      evidence: ["这句正文里根本没有"],
      problem: "章尾点破主题", action: "删掉总结",
    },
  ]), SCENES, SOURCE), /可定位的 blocker 证据/);
});

test("未知 kind 仍然被丢弃", () => {
  const parsed = parseChapterReview(review([
    { severity: "warning", kind: "ai_smell", sceneId: "s1", evidence: [], problem: "像 AI", action: "改" },
  ], "pass"), SCENES, SOURCE);
  assert.deepEqual(parsed.issues, []);
});
