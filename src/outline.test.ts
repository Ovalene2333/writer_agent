import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OutlineStore, parseOutline } from "./outline.js";
import { WriterProject } from "./project.js";

const SAMPLE = `# 故事大纲

## 第一章 出发

### 车站告别

- 摘要：千夏在车站与苏远告别。
- 前因：调令已经下达
- 行动：千夏登上列车
- 结果：两人暂时分开
- 状态变化：千夏从犹豫转为接受任务
- 角色ID：1, 2
- 地点：东站
- 情节线：主线、关系线
- 伏笔：损坏的车票
- 状态：已写
- 文档：chapters/chapter-001.md
- 正文章节：车站告别
`;

test("parseOutline extracts scene semantics", () => {
  const nodes = parseOutline(SAMPLE);
  assert.equal(nodes.length, 2);
  const scene = nodes[1];
  assert.equal(scene.type, "scene");
  assert.equal(scene.cause, "调令已经下达");
  assert.equal(scene.stateChange, "千夏从犹豫转为接受任务");
  assert.deepEqual(scene.characterIds, [1, 2]);
  assert.deepEqual(scene.plotlines, ["主线", "关系线"]);
  assert.equal(scene.status, "drafted");
});

test("OutlineStore keeps IDs stable and validates linked draft", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-outline-"));
  try {
    const project = WriterProject.init(root, "测试作品");
    project.writeRaw("outline/outline.md", SAMPLE);
    project.writeRaw("chapters/chapter-001.md", "# 第一章\n\n## 车站告别\n\n调令已经下达。千夏收起损坏的车票，登上列车。她终于接受了任务。\n");
    const outline = new OutlineStore(project);
    const first = outline.sync();
    assert.equal(first.sourcePath, "outline/outline.md");
    const scene = first.nodes.find(node => node.type === "scene");
    assert.ok(scene);
    assert.equal(outline.validate().some(issue => issue.issue.includes("尚无回收")), true);
    assert.equal(outline.compareWithDraft(scene.id).linked, true);

    project.writeRaw("outline/outline.md", SAMPLE.replace("千夏在车站与苏远告别", "千夏在清晨的车站与苏远告别"));
    const second = outline.sync();
    assert.equal(second.nodes.find(node => node.type === "scene")?.id, scene.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
