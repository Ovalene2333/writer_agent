import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { OutlineNode, OutlineNodeStatus, OutlineNodeType, OutlineSnapshot } from "./types.js";
import { WriterProject } from "./project.js";

const DEFAULT_OUTLINE_PATH = "story/outline.md";

type ParsedNode = Omit<OutlineNode, "id" | "parentId"> & { parentIndex?: number };

export class OutlineStore {
  readonly project: WriterProject;
  readonly sourcePath: string;
  readonly snapshotPath: string;

  constructor(project: WriterProject, sourcePath = DEFAULT_OUTLINE_PATH) {
    this.project = project;
    this.sourcePath = sourcePath;
    this.snapshotPath = resolve(project.privateDir, "outline.json");
  }

  sync(): OutlineSnapshot {
    const content = this.project.documentExists(this.sourcePath) ? this.project.read(this.sourcePath) : "";
    const sourceHash = this.project.hash(content);
    const saved = this.load();
    if (saved?.sourceHash === sourceHash) return saved;
    const parsed = parseOutline(content);
    const ids = reconcileIds(parsed, saved?.nodes ?? []);
    const nodes = parsed.map((node, index): OutlineNode => {
      const { parentIndex, ...value } = node;
      return { ...value, id: ids[index], ...(parentIndex === undefined ? {} : { parentId: ids[parentIndex] }) };
    });
    const snapshot: OutlineSnapshot = {
      schemaVersion: 1,
      sourcePath: this.sourcePath,
      sourceHash,
      updatedAt: new Date().toISOString(),
      nodes,
    };
    this.save(snapshot);
    return snapshot;
  }

  node(id: string): OutlineNode {
    const node = this.sync().nodes.find(item => item.id === id);
    if (!node) throw new Error("大纲节点不存在；请重新调用 list_outline_nodes 获取最新 ID");
    return node;
  }

  section(id: string): string {
    const node = this.node(id);
    const lines = this.project.read(this.sourcePath).split(/\r?\n/);
    return lines.slice(node.startLine - 1, node.endLine).join("\n");
  }

  validate(): Array<{ severity: "warning" | "info"; nodeId: string; title: string; issue: string }> {
    const nodes = this.sync().nodes;
    const results: Array<{ severity: "warning" | "info"; nodeId: string; title: string; issue: string }> = [];
    for (const node of nodes) {
      if (node.type !== "scene") continue;
      const missing = [
        ["前因", node.cause], ["行动", node.action], ["结果", node.outcome], ["状态变化", node.stateChange],
      ].filter(([, value]) => !value).map(([label]) => label);
      if (missing.length) results.push({ severity: "warning", nodeId: node.id, title: node.title, issue: `缺少${missing.join("、")}` });
      if (!node.characterIds.length && !field(node.summary, "人物")) {
        results.push({ severity: "info", nodeId: node.id, title: node.title, issue: "未标记出场人物" });
      }
      if (!node.documentPath) results.push({ severity: "info", nodeId: node.id, title: node.title, issue: "尚未关联正文文档" });
    }
    const setups = new Map<string, OutlineNode>();
    const paid = new Set(nodes.flatMap(node => node.payoffs.map(normalizeToken)));
    for (const node of nodes) for (const setup of node.setups) setups.set(normalizeToken(setup), node);
    for (const [key, node] of setups) if (key && !paid.has(key)) {
      results.push({ severity: "warning", nodeId: node.id, title: node.title, issue: `伏笔“${node.setups.find(item => normalizeToken(item) === key)}”尚无回收节点` });
    }
    return results;
  }

  compareWithDraft(id: string): { node: OutlineNode; linked: boolean; evidence?: string; differences: string[] } {
    const node = this.node(id);
    if (!node.documentPath) return { node, linked: false, differences: ["节点未设置“文档”字段，无法核对正文"] };
    if (!this.project.documentExists(node.documentPath)) return { node, linked: false, differences: [`关联文档不存在：${node.documentPath}`] };
    const content = this.project.read(node.documentPath);
    const evidence = node.documentHeading ? markdownSection(content, node.documentHeading) : content;
    if (!evidence) return { node, linked: true, differences: [`正文中未找到标题：${node.documentHeading}`] };
    const differences: string[] = [];
    for (const [label, planned] of [["结果", node.outcome], ["状态变化", node.stateChange]] as const) {
      if (planned && overlapScore(planned, evidence) < 0.18) differences.push(`${label}与正文缺少明显文本重合，建议人工确认是否偏离：${planned}`);
    }
    if (!differences.length) differences.push("未发现明显偏离；这是词面核对结果，不能替代语义审阅");
    return { node, linked: true, evidence: evidence.slice(0, 2_000), differences };
  }

  private load(): OutlineSnapshot | undefined {
    if (!existsSync(this.snapshotPath)) return undefined;
    try {
      const value = JSON.parse(readFileSync(this.snapshotPath, "utf8")) as OutlineSnapshot;
      return value?.schemaVersion === 1 && Array.isArray(value.nodes) ? value : undefined;
    } catch { return undefined; }
  }

  private save(snapshot: OutlineSnapshot): void {
    mkdirSync(dirname(this.snapshotPath), { recursive: true });
    const temp = `${this.snapshotPath}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    renameSync(temp, this.snapshotPath);
  }
}

export function parseOutline(content: string): ParsedNode[] {
  const lines = content.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    return match ? [{ level: match[1].length, title: match[2].trim(), line: index + 1 }] : [];
  });
  const usable = headings.filter((heading, index) => !(index === 0 && heading.level === 1 && /大纲|outline/i.test(heading.title)));
  const result: ParsedNode[] = [];
  const stack: Array<{ level: number; index: number }> = [];
  for (let index = 0; index < usable.length; index += 1) {
    const heading = usable[index];
    const nextLine = usable[index + 1]?.line ?? lines.length + 1;
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
    const parentIndex = stack.at(-1)?.index;
    const body = lines.slice(heading.line, nextLine - 1).join("\n").trim();
    const node: ParsedNode = {
      type: inferType(heading.title, heading.level), title: heading.title, summary: summary(body),
      cause: field(body, "前因"), action: field(body, "行动"), outcome: field(body, "结果"),
      stateChange: field(body, "状态变化"), povCharacterId: positiveInteger(field(body, "POV角色ID")),
      characterIds: integerList(field(body, "角色ID")), location: field(body, "地点"), time: field(body, "时间"),
      plotlines: listField(body, "情节线"), setups: listField(body, "伏笔"), payoffs: listField(body, "回收"),
      status: status(field(body, "状态")), documentPath: field(body, "文档") || undefined,
      documentHeading: field(body, "正文章节") || undefined, level: heading.level, order: result.length,
      startLine: heading.line, endLine: nextLine - 1, ...(parentIndex === undefined ? {} : { parentIndex }),
    };
    result.push(node);
    stack.push({ level: heading.level, index: result.length - 1 });
  }
  return result;
}

function reconcileIds(nodes: ParsedNode[], old: OutlineNode[]): string[] {
  const unused = new Set(old.map(node => node.id));
  return nodes.map((node, index) => {
    const exact = old.find(item => unused.has(item.id) && item.title === node.title && item.type === node.type);
    const positional = old.find(item => unused.has(item.id) && item.order === index && item.type === node.type);
    const matched = exact ?? positional;
    if (matched) { unused.delete(matched.id); return matched.id; }
    return randomUUID();
  });
}

function inferType(title: string, level: number): OutlineNodeType {
  if (/^(第[一二三四五六七八九十百千万\d]+)?[卷幕部篇]/.test(title) || level <= 1) return "act";
  if (/^(第[一二三四五六七八九十百千万\d]+)?章/.test(title) || level === 2) return "chapter";
  return "scene";
}

function field(body: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^(?:[-*]\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[：:]\\s*(.+)$`, "mi").exec(body);
  return match?.[1].trim() ?? "";
}

function summary(body: string): string {
  const explicit = field(body, "摘要");
  if (explicit) return explicit;
  return body.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^[-*]\s*(?:\*\*)?[^：:]+[：:]/.test(line)).join(" ").slice(0, 500);
}

function listField(body: string, name: string): string[] {
  return field(body, name).split(/[，,、;；|]/).map(value => value.trim()).filter(Boolean);
}
function integerList(value: string): number[] { return value.split(/\D+/).map(Number).filter(item => Number.isInteger(item) && item > 0); }
function positiveInteger(value: string): number | undefined { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : undefined; }
function status(value: string): OutlineNodeStatus {
  if (/偏离|diverged/i.test(value)) return "diverged";
  if (/已写|正文|drafted/i.test(value)) return "drafted";
  if (/计划|planned/i.test(value)) return "planned";
  return "idea";
}
function normalizeToken(value: string): string { return value.toLowerCase().replace(/[\s，。！？、,.!?;；：:]/g, ""); }

function markdownSection(content: string, heading: string): string {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(line => /^#{1,6}\s+/.test(line) && line.replace(/^#{1,6}\s+/, "").trim() === heading.trim());
  if (start < 0) return "";
  const level = /^(#{1,6})/.exec(lines[start])?.[1].length ?? 6;
  const endOffset = lines.slice(start + 1).findIndex(line => {
    const match = /^(#{1,6})\s+/.exec(line); return Boolean(match && match[1].length <= level);
  });
  return lines.slice(start, endOffset < 0 ? undefined : start + 1 + endOffset).join("\n");
}

function overlapScore(planned: string, actual: string): number {
  const tokens = [...new Set(planned.replace(/\s/g, "").match(/[\p{Script=Han}]{2}|[a-z\d]{3,}/giu) ?? [])];
  if (!tokens.length) return 1;
  return tokens.filter(token => actual.toLowerCase().includes(token.toLowerCase())).length / tokens.length;
}
