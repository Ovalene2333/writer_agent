import type { WriterProject } from "../project.js";
import type { OutlineStore } from "../outline.js";

export function parseChapterNumber(text: string): number | undefined {
  if (!text) return undefined;
  const arabic = /第\s*(\d{1,3})\s*章|chapter[-_\s]*0*(\d{1,3})|chapters\/[^/\s]*?0*(\d{1,3})/i.exec(text);
  if (arabic) {
    const value = Number(arabic[1] || arabic[2] || arabic[3]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  const cn = /第\s*([零〇一二三四五六七八九十百千两]{1,6})\s*章/.exec(text);
  if (!cn) return undefined;
  const value = chineseNumeralToInt(cn[1]);
  return value > 0 ? value : undefined;
}

export function chineseNumeralToInt(raw: string): number {
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (raw === "十") return 10;
  if (raw.length === 1) return digits[raw] ?? -1;
  let total = 0;
  let current = 0;
  for (const char of raw) {
    if (char === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (char === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else if (char in digits) {
      current = digits[char];
    }
  }
  return total + current;
}

export function chapterTitleMatches(title: string, chapterNum: number): boolean {
  if (!title) return false;
  const cn = intToChineseNumeral(chapterNum);
  const patterns = [
    new RegExp(`第\\s*0*${chapterNum}\\s*章`),
    new RegExp(`第\\s*${cn}\\s*章`),
    new RegExp(`chapter[-_\\s]*0*${chapterNum}\\b`, "i"),
    new RegExp(`(^|[^0-9])0*${chapterNum}([^0-9]|$)`),
  ];
  return patterns.some(pattern => pattern.test(title));
}

export function intToChineseNumeral(value: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (value <= 0) return String(value);
  if (value < 10) return digits[value];
  if (value === 10) return "十";
  if (value < 20) return `十${digits[value % 10]}`;
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ""}`;
  }
  return String(value);
}

export function expandOutlineFamily<T extends { id: string; parentId?: string }>(all: T[], matched: T[]): T[] {
  const ids = new Set(matched.map(node => node.id));
  for (const node of matched) {
    if (node.parentId) ids.add(node.parentId);
  }
  for (const node of all) {
    if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
  }
  return all.filter(node => ids.has(node.id));
}

export function previousPath(paths: string[], current: string): string | undefined {
  const index = paths.indexOf(current);
  return index > 0 ? paths[index - 1] : undefined;
}

export function safeReadHeading(project: WriterProject, path: string): string {
  try {
    const first = project.read(path).split(/\r?\n/, 5).find(line => /^#{1,6}\s+/.test(line));
    return first ? first.replace(/^#{1,6}\s+/, "").trim() : path;
  } catch {
    return path;
  }
}

/** Resolve outline node by UUID, or by title / chapter label when the model passes "5" / "第五章". */
export function resolveOutlineNodePayload(outline: OutlineStore, idOrTitle: string): Record<string, unknown> {
  const snapshot = outline.sync();
  const exact = snapshot.nodes.find(node => node.id === idOrTitle);
  if (exact) {
    return { node: exact, markdown: outline.section(exact.id) };
  }

  const chapterNum = parseChapterNumber(idOrTitle) ?? (/^\d{1,3}$/.test(idOrTitle) ? Number(idOrTitle) : undefined);
  const byTitle = snapshot.nodes.filter(node =>
    node.title === idOrTitle
    || node.title.includes(idOrTitle)
    || (chapterNum !== undefined && chapterTitleMatches(node.title, chapterNum)),
  );
  if (byTitle.length === 1) {
    const node = byTitle[0];
    return {
      node,
      markdown: outline.section(node.id),
      resolvedFrom: idOrTitle,
      message: `已将“${idOrTitle}”解析为节点 ${node.id}（${node.title}）。请后续使用该 UUID，不要用章号当 id。`,
    };
  }
  if (byTitle.length > 1) {
    return {
      error: `“${idOrTitle}”匹配到多个大纲节点；请改用下列唯一 id 调用 get_outline_node。`,
      candidates: byTitle.slice(0, 12).map(node => ({ id: node.id, type: node.type, title: node.title })),
    };
  }

  const catalog = snapshot.nodes.slice(0, 40).map(node => ({ id: node.id, type: node.type, title: node.title }));
  return {
    error: `大纲节点不存在：${idOrTitle}。节点 id 不是章号；请从下列目录或写作引导中的 outlineNodes 选择 id，不要重新 list_outline_nodes（若本轮已列过）。`,
    availableNodes: catalog,
  };
}
