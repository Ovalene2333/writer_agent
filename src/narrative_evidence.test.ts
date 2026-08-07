import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyCharacter } from "./characters.js";
import {
  buildNarrativeEvidencePacket,
  readNarrativeEvidenceSource,
  recordCharacterEvidenceRead,
} from "./narrative_evidence.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import type { ChapterSceneCard } from "./scene_pipeline.js";
import type { ToolExecutionContext } from "./tools/types.js";

test("narrative evidence blocks a scene until scoped character source sections were read", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-evidence-coverage-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "证据覆盖");
    store = new WriterStore(project);
    const card = store.saveCharacter({
      ...emptyCharacter("闻溪"),
      voice: { ...emptyCharacter().voice, summary: "说话克制" },
      competencies: [{
        id: "trace", name: "追踪", summary: "辨认足迹", level: "熟练", unlocked: true,
        description: "只能辨认二十四小时内的足迹", resources: [], limitations: ["雨后失效"], costs: [],
      }],
    });
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      reviewCharacterIds: [card.id],
      characterEvidenceReads: new Map(),
    };
    const scene: ChapterSceneCard = {
      id: "gate", title: "", goal: "找到入口", entryState: [], characterIntent: [],
      obstacle: "雨水冲掉痕迹", turn: "发现伪造足迹", outcome: "改查排水渠", handoff: "",
      dividerBefore: false, targetCharacters: 800,
      characterScopes: [{ characterId: card.id, competencyIds: ["trace"], dialogue: true }],
    };
    const missing = buildNarrativeEvidencePacket({ project, store, context, path: "chapters/new.md", scene });
    assert.deepEqual(new Set(missing.coverageGaps.map(gap => gap.code)), new Set([
      "character_sections_missing",
      "competency_evidence_missing",
    ]));

    const sectionGap = missing.coverageGaps.find(gap => gap.code === "character_sections_missing");
    assert.ok(sectionGap);
    assert.deepEqual(new Set(sectionGap!.missing), new Set(["voice", "motivations", "storyState"]));
    assert.equal(sectionGap!.missing.includes("relationships"), false);

    recordCharacterEvidenceRead(
      context,
      card.id,
      ["voice", "motivations", "storyState", "competencies"],
      ["trace"],
    );
    const complete = buildNarrativeEvidencePacket({ project, store, context, path: "chapters/new.md", scene });
    assert.deepEqual(complete.coverageGaps, []);
    assert.equal(complete.characters[0]?.sections.voice && typeof complete.characters[0].sections.voice, "object");
    assert.equal(complete.characters[0]?.allowedCompetencyIds[0], "trace");
    assert.deepEqual(complete.characters[0]?.allowedCompetencyUses, [{ competencyId: "trace", mode: "use" }]);
    assert.deepEqual(complete.characters[0]?.constraints.competencies.map(item => item.id), ["trace"]);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dialogue coverage still requires relationships when the card has relation rows", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-evidence-relationships-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "关系必读");
    store = new WriterStore(project);
    const other = store.saveCharacter(emptyCharacter("对方"));
    const card = store.saveCharacter({
      ...emptyCharacter("闻溪"),
      voice: { ...emptyCharacter().voice, summary: "说话克制" },
      relationships: [{
        id: "rel-other",
        characterId: other.id,
        type: "同盟",
        attitude: "信任",
        status: "active",
        description: "并肩行动",
      }],
    });
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      reviewCharacterIds: [card.id],
      characterEvidenceReads: new Map(),
    };
    const scene: ChapterSceneCard = {
      id: "gate", title: "", goal: "交涉", entryState: [], characterIntent: [],
      obstacle: "对方迟疑", turn: "摊牌", outcome: "达成默契", handoff: "",
      dividerBefore: false, targetCharacters: 800,
      characterScopes: [{ characterId: card.id, competencyIds: [], dialogue: true }],
    };
    const missing = buildNarrativeEvidencePacket({ project, store, context, path: "chapters/new.md", scene });
    const sectionGap = missing.coverageGaps.find(gap => gap.code === "character_sections_missing");
    assert.ok(sectionGap?.missing.includes("relationships"));

    recordCharacterEvidenceRead(context, card.id, ["voice", "motivations", "storyState"]);
    const stillMissing = buildNarrativeEvidencePacket({ project, store, context, path: "chapters/new.md", scene });
    assert.deepEqual(
      stillMissing.coverageGaps.find(gap => gap.code === "character_sections_missing")?.missing,
      ["relationships"],
    );

    recordCharacterEvidenceRead(context, card.id, ["relationships"]);
    const complete = buildNarrativeEvidencePacket({ project, store, context, path: "chapters/new.md", scene });
    assert.equal(complete.coverageGaps.some(gap => gap.code === "character_sections_missing"), false);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("narrative evidence does not expose competencies outside the active scene authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-evidence-capability-scope-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "能力边界");
    store = new WriterStore(project);
    const base = emptyCharacter("许乔");
    const card = store.saveCharacter({
      ...base,
      competencies: [
        {
          id: "observe", name: "观察", summary: "辨认旧痕", level: "熟练", unlocked: true,
          description: "能辨认物件上的旧痕", resources: [], limitations: [], costs: [],
        },
        {
          id: "decrypt", name: "解密", summary: "破解密文", level: "入门", unlocked: true,
          description: "能破解简单替换密码", resources: [], limitations: [], costs: [],
        },
      ],
    });
    const context: ToolExecutionContext = {
      permissionMode: "ask",
      reviewCharacterIds: [card.id],
      characterEvidenceReads: new Map(),
    };
    recordCharacterEvidenceRead(context, card.id, ["competencies"], ["observe"]);
    const packet = buildNarrativeEvidencePacket({ project, store, context, path: "chapters/new.md" });
    assert.deepEqual(packet.characters[0]?.allowedCompetencyIds, ["observe"]);
    assert.deepEqual(packet.characters[0]?.constraints.competencies.map(item => item.id), ["observe"]);
    assert.deepEqual(
      (packet.characters[0]?.sections.competencies as { inPlay: Array<{ id: string }> }).inPlay.map(item => item.id),
      ["observe"],
    );
    assert.equal(JSON.stringify(packet.characters[0]).includes("decrypt"), false);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("narrative evidence scopes writing memory to its session and preserves source hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "writer-evidence-source-"));
  let store: WriterStore | undefined;
  try {
    const project = WriterProject.init(root, "证据来源");
    project.writeTextFile("chapters/001.md", "# 前章\n\n密钥藏在北塔钟摆内。\n只有守塔人知道。\n");
    store = new WriterStore(project);
    const sessionId = store.createSession("当前会话");
    const otherSessionId = store.createSession("其他会话");
    const sourceMessageId = store.addMessage(sessionId, "user", "续写前章", "agent");
    store.saveExtractedWritingMemory(sessionId, sourceMessageId, "chapters/001.md", project.readTextFile("chapters/001.md"), 1, [{
      kind: "knowledge",
      content: "守塔人知道密钥的位置",
      characterIds: [],
      importance: 80,
      sourceEvidence: "只有守塔人知道。",
    }]);
    const readSnapshots: NonNullable<ToolExecutionContext["readSnapshots"]> = new Map();
    for (let index = 0; index < 12; index += 1) {
      const path = `lore/decoy-${index}.md`;
      const content = `无关资料 ${index}`;
      project.writeTextFile(path, content);
      readSnapshots.set(path, {
        sourceHash: project.hash(content),
        ranges: [{ startLine: 1, endLine: 1 }],
      });
    }
    const context: ToolExecutionContext = { permissionMode: "ask", readSnapshots };
    const packet = buildNarrativeEvidencePacket({ project, store, context, sessionId, path: "chapters/new.md" });
    const memory = packet.writingMemory.find(item => item.content.includes("守塔人"));
    assert.ok(memory?.source.sourceId);
    assert.equal(memory?.source.sourceHash, project.hash(project.readTextFile("chapters/001.md")));
    const source = packet.sources.find(item => item.id === memory?.source.sourceId);
    assert.equal(source?.sourceHash, project.hash(project.readTextFile("chapters/001.md")));
    assert.equal(packet.sources.some(item => item.kind === "previous_boundary"), true);
    const read = readNarrativeEvidenceSource(project, context, packet, source!.id);
    assert.match(read.content, /只有守塔人知道/u);
    assert.throws(() => readNarrativeEvidenceSource(project, context, packet, "src-not-authorized"), /授权范围/u);
    const isolated = buildNarrativeEvidencePacket({ project, store, context, sessionId: otherSessionId, path: "chapters/new.md" });
    assert.deepEqual(isolated.writingMemory, []);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
