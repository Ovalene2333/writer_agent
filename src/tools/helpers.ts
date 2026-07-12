import { documentKind, type WriterProject } from "../project.js";

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少有效参数：${name}`);
  return value;
}

export function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
  return value;
}

export function rejectCompressedPlaceholder(value: string, name: string): void {
  if (value.includes("[内容已压缩")) {
    throw new Error(`${name} 是历史压缩占位文本，不是正文内容；请重新读取必要原文并提交真实内容`);
  }
}

export function countOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - search.length) {
    const index = content.indexOf(search, offset);
    if (index < 0) break;
    count += 1;
    offset = index + search.length;
  }
  return count;
}

export function documentMap(project: WriterProject): Array<{ path: string; kind: string; lines: number; characters: number; headings: string[] }> {
  const result: Array<{ path: string; kind: string; lines: number; characters: number; headings: string[] }> = [];
  let budget = 6_000;
  for (const path of project.listDocuments().filter(path => !project.isDocumentHidden(path)).slice(0, 100)) {
    const content = project.read(path);
    const entry = {
      path,
      kind: documentKind(path),
      lines: content.split(/\r?\n/).length,
      characters: content.length,
      headings: content.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line)).slice(0, 6),
    };
    const size = JSON.stringify(entry).length;
    if (size > budget) break;
    result.push(entry);
    budget -= size;
  }
  return result;
}

export function assertWritableMode(permissionMode: string, toolName: string): void {
  if (permissionMode === "plan") {
    throw new Error(`plan 模式禁止 ${toolName}；请先用最终回复给出计划，或让用户切换到 ask/auto 模式后再写入`);
  }
}
