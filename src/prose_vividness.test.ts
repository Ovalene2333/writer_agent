import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeProseVividness,
  proseVividnessScore,
} from "./prose_vividness.js";

/**
 * The failure this whole module exists for: prose with no mannerism, no dash
 * overload and no reuse — which every existing gate passes — but no scene in it.
 */
const FLAT = [
  "会议持续了很久。气氛显得有些紧张，仿佛所有人都在等待某种结果。",
  "他觉得这件事的意义重大，某种程度上关系到一切。时间似乎过得很慢。",
  "最终决定被宣布了。他离开的时候心情复杂，说不清是失望还是解脱。",
  "回去的路上，他想起了很多往事。那些记忆莫名地涌上来，难以言喻。",
  "他知道，从此以后一切都不一样了。空气里有一种说不出的沉闷。",
].join("\n\n");

const VIVID = [
  "会议室的灯管有一根接触不良，每隔几秒暗一下，把桌面上的水杯照得忽明忽暗。",
  "老陈把两页纸推过来，指甲在边角上刮出一道印子。纸很凉，边缘干裂，带着复印机的焦糊气味。",
  "「你签，还是我签。」他说。",
  "「你已经替我签过一次了。」",
  "外面走廊传来脚步声，由远及近，又在门口停住，隔着门缝能看见一小截鞋尖。",
  "他把笔捏在手里没有动，看着那根灯管又暗下去，等它亮起来的时候，才发现自己已经把纸翻了过去，"
  + "背面是一张旧的排班表，上面还留着三个月前用红笔划掉的名字，笔画很重，把纸都划穿了一个小口。",
].join("\n\n");

test("vividness separates flat-but-clean prose from a real scene", () => {
  const flat = proseVividnessScore(FLAT);
  const vivid = proseVividnessScore(VIVID);
  assert.ok(vivid > flat + 20, `expected a wide gap, got flat=${flat} vivid=${vivid}`);
});

test("flat prose reports generic atmosphere and a bare stage", () => {
  const { issues } = analyzeProseVividness(FLAT.repeat(3));
  const codes = issues.map(issue => issue.code);
  assert.ok(codes.includes("generic_atmosphere"), `expected generic_atmosphere, got ${codes.join(",")}`);
  assert.ok(codes.includes("dialogue_starved"), `expected dialogue_starved, got ${codes.join(",")}`);
});

test("a real scene raises no vividness issues", () => {
  const { issues } = analyzeProseVividness(VIVID.repeat(3));
  assert.deepEqual(issues.map(issue => issue.code), []);
});

test("short passages report nothing (statistics are noise below the floor)", () => {
  assert.deepEqual(analyzeProseVividness("他走了。").issues, []);
});
