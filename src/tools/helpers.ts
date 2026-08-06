import { documentKind, type WriterProject } from "../project.js";
import type { ToolExecutionContext } from "./types.js";

export type DocumentWriteMode = "create" | "replace" | "append";

/** Canonical resource-relative form shared by text-file tools and audits. */
export function normalizeTextFilePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/").replace(/^resource(?:\/|$)/, "");
}

export function isNarrativeReferencePath(path: string): boolean {
  const kind = documentKind(normalizeTextFilePath(path));
  return kind === "chapter" || kind === "side";
}

/**
 * Existing narrative prose is a separate evidence class from lore and cards.
 * Independent tasks cannot read it; continuity tasks receive a bounded path
 * allowlist. Current run working copies remain readable for review and repair.
 */
export function proseReferenceReadAllowed(
  context: ToolExecutionContext,
  path: string,
): boolean {
  const normalized = normalizeTextFilePath(path);
  if (!isNarrativeReferencePath(normalized)) return true;
  if (context.workingTextFiles?.has(normalized)) return true;
  const policy = context.proseReferencePolicy;
  if (!policy || policy.mode === "project") return true;
  if (policy.mode === "independent") return false;
  return (policy.allowedNarrativePaths ?? [])
    .map(normalizeTextFilePath)
    .includes(normalized);
}

export function assertProseReferenceReadAllowed(
  context: ToolExecutionContext,
  path: string,
): void {
  if (proseReferenceReadAllowed(context, path)) return;
  const mode = context.proseReferencePolicy?.mode ?? "project";
  throw new Error(mode === "independent"
    ? "独立创作模式禁止读取既有 chapter/side 正文；可读取 lore、outline、角色卡和本轮生成的工作副本"
    : "连续性模式只允许读取目标正文或紧邻前文；请改读 lore/outline，或使用本轮允许的连续性路径");
}

/**
 * Read the same visible snapshot as the unified file tools.
 * An audit must see a run's staged copy, otherwise it can bless stale text that
 * will not be submitted.
 */
export function readableTextFile(
  args: Pick<{ project: WriterProject; context: ToolExecutionContext }, "project" | "context">,
  path: string,
): { path: string; content: string; sourceHash: string; workingCopy: boolean } {
  const normalized = normalizeTextFilePath(path);
  if (!normalized) throw new Error("path 不能为空");
  assertProseReferenceReadAllowed(args.context, normalized);
  if (args.project.isDocumentHidden(normalized)) throw new Error("文件已对 Agent 屏蔽");
  const working = args.context.workingTextFiles?.get(normalized);
  if (working) {
    return {
      path: normalized,
      content: working.content,
      sourceHash: working.sourceHash,
      workingCopy: true,
    };
  }
  const content = args.project.readTextFile(normalized);
  return {
    path: normalized,
    content,
    sourceHash: args.project.hash(content),
    workingCopy: false,
  };
}

/** Existing targets are revisions, not filename collisions. */
export function resolveDocumentWriteTarget(
  project: WriterProject,
  path: string,
  requestedMode: DocumentWriteMode,
): {
  requestedMode: DocumentWriteMode;
  mode: DocumentWriteMode;
  existed: boolean;
  beforeContent: string;
  baseHash: string;
  versionSubmission: boolean;
} {
  const existed = project.documentExists(path);
  if (requestedMode !== "create" && !existed) throw new Error(`${requestedMode} 模式目标文档不存在`);
  const beforeContent = existed ? project.read(path) : "";
  return {
    requestedMode,
    mode: requestedMode === "create" && existed ? "replace" : requestedMode,
    existed,
    beforeContent,
    baseHash: project.hash(beforeContent),
    versionSubmission: existed,
  };
}

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

export function documentMap(
  project: WriterProject,
  context?: ToolExecutionContext,
): Array<{ path: string; kind: string; lines: number; characters: number; headings: string[] }> {
  const result: Array<{ path: string; kind: string; lines: number; characters: number; headings: string[] }> = [];
  let budget = 6_000;
  for (const path of project.listDocuments()
    .filter(path => !project.isDocumentHidden(path))
    .filter(path => !context || proseReferenceReadAllowed(context, path))
    .slice(0, 100)) {
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

/** Block full outline document writes in outline mode until design_creative_outline runs. */
export function assertCreativeOutlineDesigned(
  context: { requireCreativeOutlineDesign?: boolean; creativeOutlineDesigned?: boolean },
  path: string,
  toolName: string,
): void {
  if (!context.requireCreativeOutlineDesign || context.creativeOutlineDesigned) return;
  if (documentKind(path) !== "outline") return;
  if (toolName === "edit_file") return;
  throw new Error(
    `${toolName} 写入大纲文档前须先成功调用 design_creative_outline 一次（本轮 outline 模式硬约束）。` +
    `局部节点字段修补请改用 edit_file，不受此限。`,
  );
}
