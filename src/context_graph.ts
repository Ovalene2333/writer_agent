/**
 * Manageable context graph for multi-chapter writing.
 *
 * Design (human terms):
 * - Notebook (result state): handoffs, delivered paths, todos — survives rewrites.
 * - Scratch paper (process): tool transcripts live only inside an epoch.
 * - Graph: versioned nodes + edges so edit/rerun can archive a branch and
 *   debugging can show exactly what each request assembled.
 *
 * The wire-format messages[] is still what the provider sees; this module is
 * the durable source of truth for *what should be assembled* and *why*.
 */

import { randomUUID } from "node:crypto";

export type ContextNodeKind =
  | "message"
  | "epoch"
  | "handoff"
  | "artifact"
  | "assemble_slice"
  | "project_note";

export type ContextNodeStatus = "active" | "archived";

export type ContextEdgeKind =
  | "caused_by"
  | "uses"
  | "produces"
  | "supersedes"
  | "archives"
  | "includes";

export type ContextNode = {
  id: string;
  sessionId: string;
  kind: ContextNodeKind;
  status: ContextNodeStatus;
  label: string;
  sourceMessageId?: number;
  jobId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ContextEdge = {
  id: string;
  sessionId: string;
  fromId: string;
  toId: string;
  kind: ContextEdgeKind;
  createdAt: string;
};

export type ChapterHandoffPayload = {
  kind: "chapter";
  path?: string;
  summary?: string;
  /** Last ~800 chars of delivered prose for continuity only. */
  tail?: string;
  finalActualState?: unknown;
  chapterKey?: string;
};

export type AssembleSlicePayload = {
  step?: number;
  layers: Array<{
    id: string;
    layer: "L0" | "L1" | "L2" | "L3";
    label: string;
    estimatedTokens?: number;
    nodeIds?: string[];
  }>;
  note?: string;
};

export type ContextGraphView = {
  sessionId: string;
  nodes: ContextNode[];
  edges: ContextEdge[];
  activeHandoffs: ContextNode[];
  activeEpochs: ContextNode[];
  recentSlices: ContextNode[];
  stats: {
    activeNodes: number;
    archivedNodes: number;
    edgeCount: number;
    handoffCount: number;
  };
};

export function newContextNodeId(prefix = "ctx"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function newContextEdgeId(): string {
  return `edge_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Compact prompt block from active chapter handoffs (L2 focus state). */
export function formatActiveHandoffsForPrompt(handoffs: ContextNode[], limit = 4): string {
  const active = handoffs
    .filter(node => node.kind === "handoff" && node.status === "active")
    .slice(-limit);
  if (!active.length) {
    return "【可管理上下文 · 交付交接】无活跃章交接（本焦点仅依赖当前任务与工具读取）。";
  }
  const lines = [
    "【可管理上下文 · 交付交接】以下为已结算的章结果态（过程工具链已丢弃）。续写以此为准；全文用工具按需读取，勿复述已交付过程。",
  ];
  for (const node of active) {
    const payload = node.payload as Partial<ChapterHandoffPayload>;
    lines.push(`- ${node.label}`);
    if (payload.path) lines.push(`  路径：${payload.path}`);
    if (payload.summary) lines.push(`  摘要：${String(payload.summary).replace(/\s+/g, " ").slice(0, 200)}`);
    if (payload.tail) lines.push(`  结尾衔接：…${String(payload.tail).trim().slice(-500)}`);
    if (payload.finalActualState != null) {
      try {
        lines.push(`  末场状态：${JSON.stringify(payload.finalActualState).slice(0, 600)}`);
      } catch {
        /* ignore */
      }
    }
  }
  return lines.join("\n");
}

export function buildContextGraphView(
  sessionId: string,
  nodes: ContextNode[],
  edges: ContextEdge[],
): ContextGraphView {
  const active = nodes.filter(node => node.status === "active");
  const archived = nodes.filter(node => node.status === "archived");
  const activeHandoffs = active.filter(node => node.kind === "handoff");
  const activeEpochs = active.filter(node => node.kind === "epoch");
  const recentSlices = nodes
    .filter(node => node.kind === "assemble_slice")
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30);
  return {
    sessionId,
    nodes: nodes.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    edges,
    activeHandoffs,
    activeEpochs,
    recentSlices,
    stats: {
      activeNodes: active.length,
      archivedNodes: archived.length,
      edgeCount: edges.length,
      handoffCount: activeHandoffs.length,
    },
  };
}

export function chapterHandoffLabel(parts: { path?: string; summary?: string; index?: number }): string {
  if (parts.path) return `章交接 · ${parts.path}`;
  if (parts.index != null) return `章交接 · #${parts.index}`;
  return `章交接 · ${parts.summary?.slice(0, 40) || "未命名"}`;
}
