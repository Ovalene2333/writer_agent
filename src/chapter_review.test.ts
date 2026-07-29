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
  // Multi-scene：无正文命中证据仍不可作 revise blocker。
  assert.throws(() => parseChapterReview(review([
    {
      severity: "blocker", kind: "theme_stated", sceneId: "s1",
      evidence: ["这句正文里根本没有"],
      problem: "章尾点破主题", action: "删掉总结",
    },
  ]), new Set(["s1", "s2"]), SOURCE), /可定位的 blocker 证据/);

  // 直接文档终审只有 document 一个合法 sceneId：缺 sceneId / 证据对不上时降为 pass，
  // 避免被误报成「终审服务不可用」后空重试同一稿。
  const direct = parseChapterReview(review([
    {
      severity: "blocker", kind: "theme_stated",
      evidence: ["这句正文里根本没有"],
      problem: "章尾点破主题", action: "删掉总结",
    },
  ]), new Set(["document"]), SOURCE);
  assert.equal(direct.verdict, "pass");
  assert.equal(direct.issues[0]?.severity, "warning");
});

test("直接文档终审可回填 document sceneId，并容忍引号空白差异", () => {
  const source = "「我们必须面对这个真相。」他说。";
  const parsed = parseChapterReview(JSON.stringify({
    verdict: "revise",
    chapterChange: "对白区分说话人",
    reviewNotes: "缺 sceneId 时也应能定位整章",
    issues: [{
      severity: "blocker",
      kind: "voice_homogenization",
      evidence: ['"我们必须面对这个真相。"'],
      problem: "台词可互换",
      action: "改说话方式",
    }],
  }), new Set(["document"]), source);
  assert.equal(parsed.verdict, "revise");
  assert.equal(parsed.issues[0]?.sceneId, "document");
  assert.equal(parsed.issues[0]?.severity, "blocker");
  assert.ok((parsed.issues[0]?.evidence.length ?? 0) > 0);
});

test("有可定位 blocker 时，不完整 sibling 不拖垮整次 revise", () => {
  const parsed = parseChapterReview(review([
    {
      severity: "blocker", kind: "voice_homogenization", sceneId: "s1",
      evidence: ["「我们必须面对这个真相。」"],
      problem: "对白不可分", action: "区分声口",
    },
    {
      severity: "blocker", kind: "theme_stated", sceneId: "s1",
      evidence: ["这句正文里根本没有"],
      problem: "无证据主题句", action: "忽略或补证据",
    },
  ]), SCENES, SOURCE);
  assert.equal(parsed.verdict, "revise");
  assert.equal(parsed.issues[0]?.severity, "blocker");
  assert.equal(parsed.issues[1]?.severity, "warning");
});

test("未知 kind 仍然被丢弃", () => {
  const parsed = parseChapterReview(review([
    { severity: "warning", kind: "ai_smell", sceneId: "s1", evidence: [], problem: "像 AI", action: "改" },
  ], "pass"), SCENES, SOURCE);
  assert.deepEqual(parsed.issues, []);
});
