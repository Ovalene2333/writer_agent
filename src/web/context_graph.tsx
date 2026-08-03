import React, { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch } from "lucide-react";
import type { ContextGraphEdge, ContextGraphNode, ContextGraphView } from "./types";
import { formatGraphTokens } from "./format_utils";

export const CONTEXT_GRAPH_KIND_LABEL: Record<string, string> = {
  message: "消息",
  epoch: "任务",
  handoff: "衔接",
  artifact: "交付",
  assemble_slice: "装载",
  project_note: "索引",
};

export const CONTEXT_GRAPH_EDGE_LABEL: Record<string, string> = {
  caused_by: "触发",
  uses: "使用",
  produces: "产出",
  supersedes: "取代",
  archives: "归档",
  includes: "包含",
  replays: "续写",
  tree_child: "子节点",
  tree_next: "下一轮",
};

/** Child kind order under a turn (outline readability). */
export const CONTEXT_GRAPH_TURN_CHILD_ORDER: Record<string, number> = {
  epoch: 0,
  assemble_slice: 1,
  handoff: 2,
  artifact: 3,
  project_note: 4,
  message: 5,
};

export const CONTEXT_GRAPH_LAYER_LABEL: Record<string, string> = {
  L0: "规则与项目索引",
  L1: "历史续写",
  L2: "章节衔接",
  L3: "本轮过程",
};

/** Soften old graph payload jargon when rendering kept/dropped lines. */

export function humanizeContextCopy(text: string): string {
  return text
    .replace(/L0\s*/g, "")
    .replace(/L1\s*/g, "")
    .replace(/L2\s*/g, "")
    .replace(/L3\s*/g, "")
    .replace(/handoff/gi, "衔接")
    .replace(/replay/gi, "续写")
    .replace(/材料架/g, "已读材料")
    .replace(/项目树干/g, "项目索引")
    .replace(/树干/g, "索引")
    .replace(/冻块/g, "历史块")
    .replace(/稳定系统前缀/g, "写作规则")
    .replace(/稳定前缀/g, "写作规则")
    .replace(/工具 schema/g, "工具定义")
    .replace(/跨 turn /g, "跨轮 ")
    .replace(/跨章字节稳定[，,]?/g, "跨章可复用")
    .replace(/下一批 step 仍可前缀命中/g, "后续步骤可复用缓存")
    .replace(/前缀命中/g, "缓存命中")
    .replace(/actualState/g, "已写状态")
    .replace(/sourceHash 未变则 materials_shelf_hit/g, "文件未改则直接复用")
    .replace(/materials_shelf_hit/g, "直接复用")
    .replace(/同 session 持久 digests[；;]?/g, "本会话已读摘要；")
    .replace(/digests/g, "摘要")
    .replace(/tok\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[·.\-—]\s*$/g, "")
    .trim();
}

/**
 * The number the card shows, when the payload carries one worth showing.
 *
 * An assemble slice knows how its prompt split across L0~L3; an epoch knows what
 * it froze and — since the runtime writes provider usage back — how much of that
 * the cache actually covered. Everything else stays a plain card rather than
 * inventing a metric.
 */
export type ContextGraphNodeMetric =
  | { kind: "layers"; segments: Array<{ layer: string; label: string; tokens: number }>; total: number }
  | {
      kind: "steps";
      segments: Array<{ step: number; changeTokens: number; totalTokens: number }>;
      addedTokens: number;
      latestTokens: number;
    }
  | { kind: "cache"; frozenTokens?: number; hitRate?: number; promptTokens?: number }
  | null;

export function contextGraphNodeMetric(node: ContextGraphNode): ContextGraphNodeMetric {
  if (node.kind === "assemble_slice") {
    const rawSteps = Array.isArray(node.payload?.requestSteps)
      ? node.payload.requestSteps as Array<Record<string, unknown>>
      : [];
    const stepSegments = rawSteps.flatMap((row) => (
      typeof row.step === "number"
      && typeof row.changeTokens === "number"
      && typeof row.estimatedTokens === "number"
        ? [{
            step: row.step,
            changeTokens: row.changeTokens,
            totalTokens: row.estimatedTokens,
          }]
        : []
    ));
    if (stepSegments.length) {
      return {
        kind: "steps",
        segments: stepSegments,
        addedTokens: stepSegments.reduce((sum, segment) => sum + Math.max(0, segment.changeTokens), 0),
        latestTokens: stepSegments.at(-1)!.totalTokens,
      };
    }
    const raw = Array.isArray(node.payload?.layers) ? (node.payload.layers as Array<Record<string, unknown>>) : [];
    // Merge same layer code (e.g. L0 stable + L0 trunk) so the bar stays readable.
    const byLayer = new Map<string, { layer: string; label: string; tokens: number }>();
    for (const layer of raw) {
      const code = typeof layer.layer === "string" ? layer.layer : "L3";
      const tokens = typeof layer.estimatedTokens === "number" && layer.estimatedTokens > 0 ? layer.estimatedTokens : 0;
      if (tokens <= 0) continue;
      const label = typeof layer.label === "string" ? layer.label : "";
      const prev = byLayer.get(code);
      if (prev) {
        prev.tokens += tokens;
        if (label && !prev.label.includes(label.slice(0, 6))) prev.label = `${prev.label} · ${label}`;
      } else {
        byLayer.set(code, { layer: code, label, tokens });
      }
    }
    const segments = [...byLayer.values()];
    if (!segments.length) return null;
    return { kind: "layers", segments, total: segments.reduce((sum, segment) => sum + segment.tokens, 0) };
  }
  if (node.kind === "epoch") {
    const frozenTokens = typeof node.payload?.frozenTokens === "number" ? node.payload.frozenTokens : undefined;
    const cache = node.payload?.cache as { hitRate?: unknown; promptTokens?: unknown } | undefined;
    const hitRate = typeof cache?.hitRate === "number" ? cache.hitRate : undefined;
    const promptTokens = typeof cache?.promptTokens === "number" ? cache.promptTokens : undefined;
    if (frozenTokens == null && hitRate == null) return null;
    return { kind: "cache", frozenTokens, hitRate, promptTokens };
  }
  if (node.kind === "project_note" && node.payload?.kind === "trunk") {
    const estimatedTokens = typeof node.payload.estimatedTokens === "number" ? node.payload.estimatedTokens : undefined;
    if (estimatedTokens == null || estimatedTokens <= 0) return null;
    return {
      kind: "layers",
      segments: [{ layer: "L0", label: "项目索引", tokens: estimatedTokens }],
      total: estimatedTokens,
    };
  }
  return null;
}

/**
 * Session-level hit rate over the most recent measured turns.
 *
 * Token-weighted rather than a mean of per-turn rates: one tiny turn should not
 * count as much as a long one when the question is "how much of what we paid for
 * was already cached".
 */
export function contextGraphCacheSummary(
  nodes: ContextGraphNode[],
  recent = 20,
): { hitRate: number; promptTokens: number; turns: number } | null {
  const measured = nodes
    .filter((node) => node.kind === "epoch")
    .map((node) => node.payload?.cache as { promptTokens?: unknown; cacheHitTokens?: unknown } | undefined)
    .filter((cache): cache is { promptTokens: number; cacheHitTokens: number } =>
      typeof cache?.promptTokens === "number" && cache.promptTokens > 0 && typeof cache.cacheHitTokens === "number")
    .slice(-recent);
  if (!measured.length) return null;
  const promptTokens = measured.reduce((sum, cache) => sum + cache.promptTokens, 0);
  const hitTokens = measured.reduce((sum, cache) => sum + cache.cacheHitTokens, 0);
  return { hitRate: hitTokens / promptTokens, promptTokens, turns: measured.length };
}

export const CONTEXT_GRAPH_NODE_H = 58;
export const CONTEXT_GRAPH_NODE_H_TALL = 74;
export const CONTEXT_GRAPH_NODE_H_EXPANDED = 150;

/** Cards carrying a metric strip need the extra row; everything else stays compact. */
export function contextGraphNodeHeight(node: ContextGraphNode, expanded = false): number {
  if (expanded && Array.isArray(node.payload?.requestSteps)) return CONTEXT_GRAPH_NODE_H_EXPANDED;
  return contextGraphNodeMetric(node) ? CONTEXT_GRAPH_NODE_H_TALL : CONTEXT_GRAPH_NODE_H;
}

export type ContextGraphLayoutNode = ContextGraphNode & {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  treeRole: "root" | "turn" | "leaf";
};

export type ContextGraphTreeLink = {
  id: string;
  fromId: string;
  toId: string;
  /** next = turn chain (prefix grows); child = process under a turn */
  kind: "tree_next" | "tree_child";
  label: string;
};

export type ContextGraphLayout = {
  placed: ContextGraphLayoutNode[];
  width: number;
  height: number;
  nodeW: number;
  nodeHeights: number[];
  /** Only these edges are drawn — pure tree, no spaghetti. */
  treeLinks: ContextGraphTreeLink[];
};

export type ContextGraphTreeItem = {
  node: ContextGraphNode;
  role: "root" | "turn" | "leaf";
  children: ContextGraphTreeItem[];
};

export function epochHitRate(node: ContextGraphNode): number | undefined {
  const cache = node.payload?.cache as { hitRate?: unknown } | undefined;
  return typeof cache?.hitRate === "number" ? cache.hitRate : undefined;
}

export function assembleReplayTurns(node: ContextGraphNode): number | undefined {
  const replay = node.payload?.replay as { turns?: unknown } | undefined;
  return typeof replay?.turns === "number" ? replay.turns : undefined;
}

export function isTrunkNode(node: ContextGraphNode): boolean {
  return node.kind === "project_note" && node.payload?.kind === "trunk";
}

export function turnGroupKey(node: ContextGraphNode): string {
  if (node.sourceMessageId != null) return `msg:${node.sourceMessageId}`;
  if (node.jobId) return `job:${node.jobId}`;
  return `solo:${node.id}`;
}

/**
 * Older request diagnostics stored one assemble node per step. Collapse those
 * rows at read time so existing sessions get the compact growth strip too.
 */
export function collapseContextRequestNodes(nodes: ContextGraphNode[]): ContextGraphNode[] {
  const boundaries = new Map<string, Array<{ atStep: number; path?: string }>>();
  for (const node of nodes) {
    const transition = node.payload?.transition;
    if (!transition || typeof transition !== "object" || Array.isArray(transition)) continue;
    const row = transition as Record<string, unknown>;
    if (row.kind !== "chapter_boundary" || typeof row.atStep !== "number") continue;
    const key = turnGroupKey(node);
    const list = boundaries.get(key) ?? [];
    list.push({
      atStep: row.atStep,
      ...(typeof row.path === "string" && row.path ? { path: row.path } : {}),
    });
    boundaries.set(key, list);
  }
  for (const list of boundaries.values()) list.sort((a, b) => a.atStep - b.atStep);

  const groups = new Map<string, ContextGraphNode[]>();
  const chapterPathByGroup = new Map<string, string>();
  for (const node of nodes) {
    if (
      node.kind !== "assemble_slice"
      || !Array.isArray(node.payload?.requestComponents)
      || Array.isArray(node.payload?.requestSteps)
      || typeof node.payload?.step !== "number"
    ) continue;
    const turnKey = turnGroupKey(node);
    const cuts = boundaries.get(turnKey) ?? [];
    const segment = cuts.filter((cut) => Number(node.payload.step) > cut.atStep).length;
    const key = `${turnKey}:chapter:${segment}`;
    const chapterPath = cuts[segment]?.path;
    if (chapterPath) chapterPathByGroup.set(key, chapterPath);
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }

  const replacementById = new Map<string, ContextGraphNode | null>();
  for (const [groupKey, list] of groups) {
    if (list.length < 2) continue;
    const sorted = list.slice().sort((a, b) => (
      Number(a.payload.step) - Number(b.payload.step)
      || a.createdAt.localeCompare(b.createdAt)
    ));
    let previousTokens = 0;
    const requestSteps = sorted.flatMap((node) => {
      const request = node.payload.request && typeof node.payload.request === "object"
        && !Array.isArray(node.payload.request)
        ? node.payload.request as Record<string, unknown>
        : {};
      const estimatedTokens = typeof request.estimatedTokens === "number"
        ? request.estimatedTokens
        : 0;
      const step = Number(node.payload.step);
      const snapshot = {
        step,
        estimatedTokens,
        changeTokens: estimatedTokens - previousTokens,
        requestComponents: node.payload.requestComponents,
        ...(typeof request.providerPromptTokens === "number"
          ? { providerPromptTokens: request.providerPromptTokens }
          : {}),
        ...(typeof request.cacheHitTokens === "number" ? { cacheHitTokens: request.cacheHitTokens } : {}),
        ...(typeof request.cacheMissTokens === "number" ? { cacheMissTokens: request.cacheMissTokens } : {}),
        ...(request.estimatedUsage === true ? { estimatedUsage: true } : {}),
      };
      previousTokens = estimatedTokens;
      return estimatedTokens > 0 ? [snapshot] : [];
    });
    if (!requestSteps.length) continue;
    const first = sorted[0]!;
    const latest = sorted.at(-1)!;
    const firstStep = requestSteps[0]!.step;
    const lastStep = requestSteps.at(-1)!.step;
    const stepRange = firstStep === lastStep ? `Step ${firstStep}` : `Step ${firstStep}–${lastStep}`;
    const chapterPath = chapterPathByGroup.get(groupKey);
    const note = chapterPath ? `${chapterPath} · ${stepRange}` : `${stepRange} 上下文增长`;
    const { requestComponents: _components, request: _request, ...latestPayload } = latest.payload;
    const replacement: ContextGraphNode = {
      ...latest,
      label: `装载 · ${note}`,
      payload: {
        ...latestPayload,
        step: lastStep,
        requestSteps,
        note,
        ...(chapterPath ? { chapterPath } : {}),
      },
      createdAt: first.createdAt,
    };
    for (const node of sorted) replacementById.set(node.id, null);
    replacementById.set(latest.id, replacement);
  }

  if (!replacementById.size) return nodes;
  const result: ContextGraphNode[] = [];
  for (const node of nodes) {
    if (!replacementById.has(node.id)) {
      result.push(node);
      continue;
    }
    const replacement = replacementById.get(node.id);
    if (replacement) result.push(replacement);
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Build one session tree:
 *   root(trunk/L0)
 *     └─ turn1 ─┬─ epoch / assemble / handoff …
 *               └─ turn2 ─┬─ …
 *                         └─ turn3 …
 * Nesting turns expresses growing prefix cache; process nodes hang off each turn.
 */
export function buildContextGraphTree(nodes: ContextGraphNode[]): ContextGraphTreeItem | null {
  if (!nodes.length) return null;

  const trunks = nodes.filter(isTrunkNode).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rest = nodes.filter((node) => !isTrunkNode(node));

  const groups = new Map<string, ContextGraphNode[]>();
  for (const node of rest) {
    const key = turnGroupKey(node);
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }

  const turns = [...groups.entries()]
    .map(([key, list]) => {
      const sorted = list.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const message = sorted.find((node) => node.kind === "message");
      const epoch = sorted.find((node) => node.kind === "epoch");
      const sortAt = sorted[0]!.createdAt;
      const msgId = message?.sourceMessageId
        ?? sorted.find((node) => node.sourceMessageId != null)?.sourceMessageId
        ?? 0;
      return { key, list: sorted, message, epoch, sortAt, msgId };
    })
    .sort((a, b) => a.sortAt.localeCompare(b.sortAt) || a.msgId - b.msgId);

  const sessionId = nodes[0]!.sessionId;
  const rootNode: ContextGraphNode = trunks[0] ?? {
    id: `virtual-root-${sessionId}`,
    sessionId,
    kind: "project_note",
    status: "active",
    label: "会话共享基础",
    payload: { kind: "trunk", virtual: true, estimatedTokens: 0 },
    createdAt: turns[0]?.sortAt ?? new Date().toISOString(),
    updatedAt: turns[0]?.sortAt ?? new Date().toISOString(),
  };

  // Build turn chain from the end so each turn's last child is the next turn.
  let nextTurnItem: ContextGraphTreeItem | undefined;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const turnRoot = turn.message ?? turn.epoch ?? turn.list[0]!;
    const processKids = turn.list
      .filter((node) => node.id !== turnRoot.id)
      .slice()
      .sort((a, b) => {
        const oa = CONTEXT_GRAPH_TURN_CHILD_ORDER[a.kind] ?? 9;
        const ob = CONTEXT_GRAPH_TURN_CHILD_ORDER[b.kind] ?? 9;
        if (oa !== ob) return oa - ob;
        return a.createdAt.localeCompare(b.createdAt);
      })
      .map((node): ContextGraphTreeItem => ({ node, role: "leaf", children: [] }));

    const children: ContextGraphTreeItem[] = [...processKids];
    if (nextTurnItem) children.push(nextTurnItem);

    nextTurnItem = { node: turnRoot, role: "turn", children };
  }

  return {
    node: rootNode,
    role: "root",
    children: nextTurnItem ? [nextTurnItem] : [],
  };
}

/** Approximate display units: CJK ≈ 2, ASCII ≈ 1. Avoids SVG text overflowing cards. */
export function graphLabelUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += /[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe1f\ufe30-\ufe6f\uff00-\uffef]/.test(ch) ? 2 : 1;
  }
  return units;
}

export function truncateGraphLabel(value: string, maxUnits = 18): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (graphLabelUnits(text) <= maxUnits) return text;
  let out = "";
  let units = 0;
  for (const ch of text) {
    const add = /[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe1f\ufe30-\ufe6f\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (units + add > maxUnits - 1) break;
    out += ch;
    units += add;
  }
  return `${out}…`;
}

export function contextGraphStatusLabel(status: string): string {
  if (status === "active") return "活跃";
  if (status === "archived") return "归档";
  return status;
}

export function contextGraphNodeTitle(node: ContextGraphNode): string {
  const raw = node.label.replace(/\s+/g, " ").trim();
  if (node.kind === "message") {
    return truncateGraphLabel(raw.replace(/^用户\s*[·.\-—]\s*/, ""), 22);
  }
  if (node.kind === "epoch") {
    return truncateGraphLabel(raw.replace(/^任务\s*[·.\-—]\s*/, ""), 20);
  }
  if (node.kind === "handoff" || node.kind === "artifact") {
    return truncateGraphLabel(raw.replace(/^(章节衔接|章交接|交付)\s*[·.\-—]\s*/, ""), 20);
  }
  if (node.kind === "project_note" && node.payload?.kind === "trunk") {
    const chars = typeof node.payload.characterCount === "number" ? node.payload.characterCount : undefined;
    const outline = typeof node.payload.outlineNodeCount === "number" ? node.payload.outlineNodeCount : undefined;
    if (chars != null || outline != null) {
      return truncateGraphLabel(`角色 ${chars ?? 0} · 大纲 ${outline ?? 0}`, 22);
    }
    return truncateGraphLabel(raw.replace(/^树干\s*[·.\-—]\s*/, "") || "项目索引", 18);
  }
  if (node.kind === "assemble_slice") {
    const note = typeof node.payload?.note === "string" ? node.payload.note : "";
    const step = typeof node.payload?.step === "number" ? node.payload.step : undefined;
    const transition = node.payload?.transition as { kind?: string } | undefined;
    const stepTag = step != null && step > 0 ? ` · Step ${step}` : "";
    if (transition?.kind === "chapter_boundary" || raw.includes("章边界") || note.includes("章边界") || /chapter boundary/i.test(note)) {
      return truncateGraphLabel(`章节切换${stepTag}`, 22);
    }
    if (transition?.kind === "scene_boundary" || raw.includes("场边界") || note.includes("场边界")) {
      return truncateGraphLabel(`场次切换${stepTag}`, 22);
    }
    if (transition?.kind === "open_turn" || note.includes("开轮") || /initial assemble/i.test(note)) {
      return "本轮开场";
    }
    if (note) return truncateGraphLabel(humanizeContextCopy(note), 20);
    return truncateGraphLabel(raw.replace(/^装配\s*[·.\-—]\s*/, "") || "本轮开场", 18);
  }
  return truncateGraphLabel(raw, 20);
}

export function contextGraphNodeMeta(node: ContextGraphNode): string {
  const time = new Date(node.createdAt).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (node.kind === "assemble_slice") {
    const t = node.payload?.transition as {
      beforeTokens?: number;
      afterTokens?: number;
      atStep?: number;
    } | undefined;
    if (typeof t?.beforeTokens === "number" && typeof t?.afterTokens === "number" && t.beforeTokens > t.afterTokens) {
      return `${formatGraphTokens(t.beforeTokens)}→${formatGraphTokens(t.afterTokens)} · ${time}`;
    }
  }
  if (node.sourceMessageId != null) return `#${node.sourceMessageId} · ${time}`;
  return time;
}

export type ContextTransitionView = {
  kind: string;
  atStep?: number;
  beforeTokens?: number;
  afterTokens?: number;
  beforeMessageCount?: number;
  afterMessageCount?: number;
  path?: string;
  kept: Array<{ id: string; label: string; detail?: string }>;
  dropped: Array<{ id: string; label: string; detail?: string }>;
  reReadHint?: string;
};

export function contextTransitionFromPayload(payload: Record<string, unknown> | undefined): ContextTransitionView | null {
  if (!payload) return null;
  const raw = payload.transition;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  const kept = Array.isArray(t.kept)
    ? t.kept.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.label !== "string") return [];
      return [{
        id: typeof row.id === "string" ? row.id : row.label,
        label: row.label,
        ...(typeof row.detail === "string" ? { detail: row.detail } : {}),
      }];
    })
    : [];
  const dropped = Array.isArray(t.dropped)
    ? t.dropped.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.label !== "string") return [];
      return [{
        id: typeof row.id === "string" ? row.id : row.label,
        label: row.label,
        ...(typeof row.detail === "string" ? { detail: row.detail } : {}),
      }];
    })
    : [];
  if (!kept.length && !dropped.length && t.kind !== "open_turn") return null;
  return {
    kind: typeof t.kind === "string" ? t.kind : "unknown",
    ...(typeof t.atStep === "number" ? { atStep: t.atStep } : {}),
    ...(typeof t.beforeTokens === "number" ? { beforeTokens: t.beforeTokens } : {}),
    ...(typeof t.afterTokens === "number" ? { afterTokens: t.afterTokens } : {}),
    ...(typeof t.beforeMessageCount === "number" ? { beforeMessageCount: t.beforeMessageCount } : {}),
    ...(typeof t.afterMessageCount === "number" ? { afterMessageCount: t.afterMessageCount } : {}),
    ...(typeof t.path === "string" ? { path: t.path } : {}),
    kept,
    dropped,
    ...(typeof t.reReadHint === "string" ? { reReadHint: t.reReadHint } : {}),
  };
}

export function ContextTransitionDetail({ transition }: { transition: ContextTransitionView }) {
  const kindLabel = transition.kind === "chapter_boundary"
    ? "章节切换"
    : transition.kind === "scene_boundary"
      ? "场次切换"
      : transition.kind === "open_turn"
        ? "本轮开场"
        : "上下文变化";
  const saved = transition.beforeTokens != null && transition.afterTokens != null
    ? Math.max(0, transition.beforeTokens - transition.afterTokens)
    : undefined;
  return (
    <div className="context-transition-detail">
      <h4>上下文收束 · {kindLabel}</h4>
      {transition.atStep != null ? (
        <p className="context-transition-step">
          Step {transition.atStep}
          {transition.path ? ` · ${transition.path}` : ""}
        </p>
      ) : null}
      {transition.beforeTokens != null && transition.afterTokens != null ? (
        <div className="context-transition-bar" aria-hidden="true">
          <div className="context-transition-bar-before" title={`收束前 ${transition.beforeTokens.toLocaleString()}`}>
            <span>前 {formatGraphTokens(transition.beforeTokens)}</span>
          </div>
          <div
            className="context-transition-bar-after"
            style={{
              width: `${Math.max(12, Math.min(100, (transition.afterTokens / Math.max(1, transition.beforeTokens)) * 100))}%`,
            }}
            title={`收束后 ${transition.afterTokens.toLocaleString()}`}
          >
            <span>后 {formatGraphTokens(transition.afterTokens)}</span>
          </div>
          {saved != null && saved > 0 ? (
            <em className="context-transition-saved" title={`减少 ${formatGraphTokens(saved)}`}>
              -{formatGraphTokens(saved)}
            </em>
          ) : null}
        </div>
      ) : null}
      {transition.kept.length ? (
        <div className="context-transition-col keep">
          <strong>继续携带</strong>
          <ul>
            {transition.kept.map((item) => (
              <li key={item.id}>
                <span>{humanizeContextCopy(item.label)}</span>
                {item.detail ? <small>{humanizeContextCopy(item.detail)}</small> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {transition.dropped.length ? (
        <div className="context-transition-col drop">
          <strong>卸下不带</strong>
          <ul>
            {transition.dropped.map((item) => (
              <li key={item.id}>
                <span>{humanizeContextCopy(item.label)}</span>
                {item.detail ? <small>{humanizeContextCopy(item.detail)}</small> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {transition.reReadHint ? (
        <p className="context-transition-reread">
          <strong>按需补读</strong>
          {humanizeContextCopy(transition.reReadHint)}
        </p>
      ) : null}
    </div>
  );
}

export type ContextRequestComponentView = {
  kind: string;
  layer: "L0" | "L1" | "L2" | "L3";
  label: string;
  characters: number;
  estimatedTokens: number;
  preview?: string;
  fingerprint?: string;
};

export type ContextRequestView = {
  step?: number;
  estimatedTokens: number;
  providerPromptTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  estimatedUsage: boolean;
  components: ContextRequestComponentView[];
};

export type ContextRequestSeriesView = {
  steps: Array<ContextRequestView & { step: number; changeTokens: number }>;
  addedTokens: number;
  latestTokens: number;
  chapterPath?: string;
};

export function contextRequestFromPayload(
  payload: Record<string, unknown> | undefined,
): ContextRequestView | null {
  if (!payload || !Array.isArray(payload.requestComponents)) return null;
  const components = payload.requestComponents.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row.kind !== "string"
      || typeof row.label !== "string"
      || typeof row.characters !== "number"
      || typeof row.estimatedTokens !== "number"
      || row.estimatedTokens < 0
    ) return [];
    const layer: ContextRequestComponentView["layer"] =
      row.layer === "L0" || row.layer === "L1" || row.layer === "L2" || row.layer === "L3"
      ? row.layer
      : "L3";
    return [{
      kind: row.kind,
      layer,
      label: row.label,
      characters: row.characters,
      estimatedTokens: row.estimatedTokens,
      ...(typeof row.preview === "string" ? { preview: row.preview } : {}),
      ...(typeof row.fingerprint === "string" ? { fingerprint: row.fingerprint } : {}),
    }];
  });
  if (!components.length) return null;
  const request = payload.request && typeof payload.request === "object" && !Array.isArray(payload.request)
    ? payload.request as Record<string, unknown>
    : {};
  const componentTotal = components.reduce((sum, component) => sum + component.estimatedTokens, 0);
  return {
    ...(typeof payload.step === "number" ? { step: payload.step } : {}),
    estimatedTokens: typeof request.estimatedTokens === "number"
      ? request.estimatedTokens
      : componentTotal,
    ...(typeof request.providerPromptTokens === "number"
      ? { providerPromptTokens: request.providerPromptTokens }
      : {}),
    ...(typeof request.cacheHitTokens === "number" ? { cacheHitTokens: request.cacheHitTokens } : {}),
    ...(typeof request.cacheMissTokens === "number" ? { cacheMissTokens: request.cacheMissTokens } : {}),
    estimatedUsage: request.estimatedUsage === true,
    components,
  };
}

export function contextRequestSeriesFromPayload(
  payload: Record<string, unknown> | undefined,
): ContextRequestSeriesView | null {
  if (!payload || !Array.isArray(payload.requestSteps)) return null;
  const steps = payload.requestSteps.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row.step !== "number"
      || typeof row.estimatedTokens !== "number"
      || typeof row.changeTokens !== "number"
      || !Array.isArray(row.requestComponents)
    ) return [];
    const request = contextRequestFromPayload({
      step: row.step,
      requestComponents: row.requestComponents,
      request: {
        estimatedTokens: row.estimatedTokens,
        ...(typeof row.providerPromptTokens === "number" ? { providerPromptTokens: row.providerPromptTokens } : {}),
        ...(typeof row.cacheHitTokens === "number" ? { cacheHitTokens: row.cacheHitTokens } : {}),
        ...(typeof row.cacheMissTokens === "number" ? { cacheMissTokens: row.cacheMissTokens } : {}),
        ...(row.estimatedUsage === true ? { estimatedUsage: true } : {}),
      },
    });
    if (!request || request.step == null) return [];
    return [{ ...request, step: request.step, changeTokens: row.changeTokens }];
  });
  if (!steps.length) return null;
  return {
    steps,
    addedTokens: steps.reduce((sum, step) => sum + Math.max(0, step.changeTokens), 0),
    latestTokens: steps.at(-1)!.estimatedTokens,
    ...(typeof payload.chapterPath === "string" ? { chapterPath: payload.chapterPath } : {}),
  };
}

export function ContextRequestSeriesDetail({ series }: { series: ContextRequestSeriesView }) {
  const latestStep = series.steps.at(-1)!.step;
  const [selectedStep, setSelectedStep] = useState(latestStep);
  useEffect(() => {
    if (!series.steps.some((step) => step.step === selectedStep)) setSelectedStep(latestStep);
  }, [latestStep, selectedStep, series.steps]);
  const selected = series.steps.find((step) => step.step === selectedStep) ?? series.steps.at(-1)!;
  const denominator = Math.max(1, series.addedTokens);
  return (
    <section className="context-request-series">
      <header>
        <div>
          <h4>{series.chapterPath ? "章节请求增长" : "Step 请求增长"}</h4>
          <span>{series.steps.length} 个步骤合并展示</span>
          {series.chapterPath ? <code title={series.chapterPath}>{series.chapterPath}</code> : null}
        </div>
        <strong>当前 {formatGraphTokens(series.latestTokens)} tok</strong>
      </header>
      <div className="context-request-growth-bar" aria-label="各步骤新增上下文">
        {series.steps.map((step, index) => {
          const added = Math.max(0, step.changeTokens);
          return (
            <button
              key={step.step}
              type="button"
              className={`tone-${index % 4}${step.step === selected.step ? " active" : ""}${step.changeTokens < 0 ? " reset" : ""}`}
              style={{
                flexGrow: added / denominator,
                flexBasis: added > 0 ? 18 : 4,
                animationDelay: `${Math.min(index, 12) * 45}ms`,
              }}
              title={`Step ${step.step} ${step.changeTokens >= 0 ? "+" : "−"}${formatGraphTokens(Math.abs(step.changeTokens))} · 总计 ${formatGraphTokens(step.estimatedTokens)}`}
              onClick={() => setSelectedStep(step.step)}
            >
              <span>Step {step.step}</span>
              <strong>{step.changeTokens >= 0 ? "+" : "−"}{formatGraphTokens(Math.abs(step.changeTokens))}</strong>
            </button>
          );
        })}
      </div>
      <ContextRequestDetail key={selected.step} request={selected} />
    </section>
  );
}

export function ContextRequestDetail({ request }: { request: ContextRequestView }) {
  const total = Math.max(1, request.estimatedTokens);
  const components = request.components;
  const cacheMeasured = request.cacheHitTokens != null && request.cacheMissTokens != null
    && request.cacheHitTokens + request.cacheMissTokens > 0;
  const cacheHitRate = cacheMeasured
    ? request.cacheHitTokens! / (request.cacheHitTokens! + request.cacheMissTokens!)
    : undefined;
  return (
    <section className="context-request-detail">
      <header>
        <div>
          <h4>{request.step != null ? `Step ${request.step} 请求上下文` : "请求上下文"}</h4>
          <span>{components.length} 个组成项 · 按装配顺序</span>
        </div>
        <strong>
          {request.providerPromptTokens != null
            ? `${formatGraphTokens(request.providerPromptTokens)} tok`
            : `约 ${formatGraphTokens(request.estimatedTokens)} tok`}
        </strong>
      </header>
      <div className="context-request-summary">
        <span>组成估算 {request.estimatedTokens.toLocaleString()} tok</span>
        {request.providerPromptTokens != null ? (
          <span>{request.estimatedUsage ? "供应商未返回用量，本项仍为估算" : "供应商输入总量"}</span>
        ) : null}
        {cacheHitRate != null ? <span>缓存命中 {Math.round(cacheHitRate * 100)}%</span> : null}
      </div>
      <ol>
        {components.map((component, index) => {
          const percentage = component.estimatedTokens / total;
          return (
            <li key={`${component.kind}-${component.label}-${index}`}>
              <div className="context-request-row-head">
                <span className={`context-request-layer layer-${component.layer}`}>
                  {component.layer}
                </span>
                <span className="context-request-label" title={component.label}>{component.label}</span>
                <strong>{component.estimatedTokens.toLocaleString()} tok</strong>
                <em>{Math.round(percentage * 1000) / 10}%</em>
              </div>
              <div className="context-request-row-track" aria-hidden="true">
                <span
                  className={`layer-${component.layer}`}
                  style={{ width: `${Math.max(0.8, percentage * 100)}%` }}
                />
              </div>
              <small>
                {component.characters.toLocaleString()} chars
                {component.fingerprint ? ` · #${component.fingerprint}` : ""}
              </small>
              {component.preview ? (
                <p className="context-request-preview" title={component.preview}>
                  {component.preview}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function treeChildEdgeLabel(item: ContextGraphTreeItem): string {
  if (item.node.kind === "epoch") return "任务";
  if (item.node.kind === "handoff" || item.node.kind === "artifact") return "产出";
  if (item.node.kind === "assemble_slice") return "装载";
  return "子节点";
}

/**
 * Flatten nested turn chain into sibling turns under the root for left→right layout.
 * Process leaves stay attached to their turn.
 */
export function flattenContextGraphTurns(tree: ContextGraphTreeItem): Array<{
  turn: ContextGraphTreeItem;
  leaves: ContextGraphTreeItem[];
}> {
  const bands: Array<{ turn: ContextGraphTreeItem; leaves: ContextGraphTreeItem[] }> = [];
  let cursor: ContextGraphTreeItem | undefined = tree.role === "root"
    ? tree.children.find((child) => child.role === "turn")
    : tree.role === "turn"
      ? tree
      : undefined;
  while (cursor) {
    const leaves = cursor.children.filter((child) => child.role !== "turn");
    const next = cursor.children.find((child) => child.role === "turn");
    bands.push({ turn: cursor, leaves });
    cursor = next;
  }
  return bands;
}

export type ContextGraphMeasure = {
  item: ContextGraphTreeItem;
  height: number;
  children: ContextGraphMeasure[];
};

/**
 * Left→right tidy tree (参考：父节点在左，子节点在右同列纵向平铺，竖轨连接).
 *
 *   [root]──┬──[turn1]──┬── process
 *           │           └── process
 *           ├──[turn2]── process
 *           └──[turn3]──┬── process
 *                       └── process
 *
 * Turns are siblings under root so the graph grows sideways, not a diagonal staircase.
 */
export function layoutContextGraphNodes(nodes: ContextGraphNode[], expandedId?: string | null): ContextGraphLayout {
  const nodeW = 176;
  const colGap = 56; // horizontal gap between parent column and child column
  const vGap = 12;   // vertical gap between sibling cards
  const padX = 20;
  const padTop = 16;
  const padBottom = 20;
  const padRight = 20;

  const tree = buildContextGraphTree(nodes);
  const placed: ContextGraphLayoutNode[] = [];
  const treeLinks: ContextGraphTreeLink[] = [];
  if (!tree) {
    return { placed: [], width: 520, height: 200, nodeW, nodeHeights: [], treeLinks };
  }

  // Display tree: root → turns (siblings) → process leaves
  const turns = flattenContextGraphTurns(tree);
  const displayRoot: ContextGraphTreeItem = {
    node: tree.node,
    role: "root",
    children: turns.map(({ turn, leaves }) => ({
      node: turn.node,
      role: "turn" as const,
      children: leaves,
    })),
  };

  const measure = (item: ContextGraphTreeItem): ContextGraphMeasure => {
    const selfH = contextGraphNodeHeight(item.node, item.node.id === expandedId);
    if (!item.children.length) {
      return { item, height: selfH, children: [] };
    }
    const childMeasures = item.children.map(measure);
    const childrenH = childMeasures.reduce((sum, child, index) => (
      sum + child.height + (index > 0 ? vGap : 0)
    ), 0);
    return {
      item,
      height: Math.max(selfH, childrenH),
      children: childMeasures,
    };
  };

  const measured = measure(displayRoot);

  const place = (m: ContextGraphMeasure, depth: number, x: number, yTop: number): void => {
    const selfH = contextGraphNodeHeight(m.item.node, m.item.node.id === expandedId);
    // Parent vertically centered against the whole child block (or just itself).
    const y = yTop + Math.max(0, (m.height - selfH) / 2);
    placed.push({
      ...m.item.node,
      x,
      y,
      w: nodeW,
      h: selfH,
      depth,
      treeRole: m.item.role,
    });

    if (!m.children.length) return;
    const childX = x + nodeW + colGap;
    let childY = yTop;
    // If children block is shorter than parent, center the block under parent.
    const childrenH = m.children.reduce((sum, child, index) => (
      sum + child.height + (index > 0 ? vGap : 0)
    ), 0);
    if (childrenH < m.height) {
      childY = yTop + (m.height - childrenH) / 2;
    }
    for (const child of m.children) {
      place(child, depth + 1, childX, childY);
      childY += child.height + vGap;
    }
  };

  place(measured, 0, padX, padTop);

  const link = (
    fromId: string,
    toId: string,
    kind: ContextGraphTreeLink["kind"],
    label: string,
  ) => {
    treeLinks.push({
      id: `tree-${fromId}-${toId}`,
      fromId,
      toId,
      kind,
      label,
    });
  };

  // Root → each turn; turn → process leaves; consecutive turns "下一轮"
  for (const turnItem of displayRoot.children) {
    link(
      displayRoot.node.id,
      turnItem.node.id,
      "tree_child",
      "轮次",
    );
    for (const leaf of turnItem.children) {
      link(turnItem.node.id, leaf.node.id, "tree_child", treeChildEdgeLabel(leaf));
    }
  }
  for (let index = 0; index < displayRoot.children.length - 1; index += 1) {
    const a = displayRoot.children[index]!;
    const b = displayRoot.children[index + 1]!;
    link(a.node.id, b.node.id, "tree_next", "下一轮");
  }

  const seen = new Set<string>();
  const unique = placed.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });

  const maxX = unique.reduce((m, node) => Math.max(m, node.x + node.w), padX + nodeW);
  const maxY = unique.reduce((m, node) => Math.max(m, node.y + node.h), padTop + CONTEXT_GRAPH_NODE_H);

  return {
    placed: unique,
    width: Math.max(480, maxX + padRight),
    height: Math.max(180, maxY + padBottom),
    nodeW,
    nodeHeights: [...new Set(unique.map((node) => node.h))],
    treeLinks,
  };
}

/**
 * Parent→child elbow with a vertical bus in the column gutter
 * (matches the left-parent / right-stacked-children diagram).
 * Same-column links (e.g. 下一轮 between sibling turns) use a short side rail.
 */
export function treeEdgeRoute(from: ContextGraphLayoutNode, to: ContextGraphLayoutNode): {
  d: string;
  labelX: number;
  labelY: number;
} {
  const tip = 6;
  const fromCy = from.y + from.h / 2;
  const toCy = to.y + to.h / 2;
  const sameColumn = Math.abs(to.x - from.x) < 8;

  // Sibling stack in one column (turn → next turn): rail on the left gutter.
  if (sameColumn) {
    const goingDown = to.y >= from.y;
    const startY = goingDown ? from.y + from.h : from.y;
    const endY = goingDown ? to.y - tip : to.y + to.h + tip;
    const railX = from.x - 14;
    return {
      d: `M ${from.x} ${startY} L ${railX} ${startY} L ${railX} ${endY} L ${to.x} ${endY}`,
      labelX: railX - 2,
      labelY: (startY + endY) / 2,
    };
  }

  const goingRight = to.x > from.x;
  const startX = goingRight ? from.x + from.w : from.x;
  const endX = goingRight ? to.x - tip : to.x + to.w + tip;
  const busX = goingRight
    ? from.x + from.w + Math.max(16, (to.x - (from.x + from.w)) * 0.45)
    : from.x - Math.max(16, (from.x - (to.x + to.w)) * 0.45);

  // Same row: straight horizontal.
  if (Math.abs(toCy - fromCy) < 1.5) {
    return {
      d: `M ${startX} ${fromCy} L ${endX} ${toCy}`,
      labelX: (startX + endX) / 2,
      labelY: fromCy - 10,
    };
  }

  // Bracket: out from parent mid → vertical bus → into child mid-left/right.
  return {
    d: `M ${startX} ${fromCy} L ${busX} ${fromCy} L ${busX} ${toCy} L ${endX} ${toCy}`,
    labelX: busX,
    labelY: (fromCy + toCy) / 2,
  };
}

export function ContextGraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  // Layout uses only the filtered `nodes`; tree structure is rebuilt from them.
  const layout = React.useMemo(() => layoutContextGraphNodes(nodes, selectedId), [nodes, selectedId]);
  const pos = React.useMemo(() => {
    const map = new Map<string, ContextGraphLayoutNode>();
    for (const node of layout.placed) map.set(node.id, node);
    return map;
  }, [layout.placed]);

  const relatedIds = React.useMemo(() => {
    if (!selectedId) return new Set<string>();
    const set = new Set<string>([selectedId]);
    // Walk tree links both ways so selecting a turn highlights its process + next turn.
    let grew = true;
    while (grew) {
      grew = false;
      for (const link of layout.treeLinks) {
        if (set.has(link.fromId) && !set.has(link.toId)) {
          set.add(link.toId);
          grew = true;
        }
        if (set.has(link.toId) && !set.has(link.fromId)) {
          set.add(link.fromId);
          grew = true;
        }
      }
    }
    return set;
  }, [selectedId, layout.treeLinks]);

  /** Handoffs a later delivery of the same chapter retired. */
  const supersededIds = React.useMemo(() => {
    const set = new Set<string>();
    for (const edge of edges) if (edge.kind === "supersedes") set.add(edge.toId);
    return set;
  }, [edges]);

  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [viewport, setViewport] = React.useState({ scale: 1, tx: 0, ty: 0 });
  const dragRef = React.useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const [panning, setPanning] = React.useState(false);

  const toUserSpace = React.useCallback((event: { clientX: number; clientY: number }) => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }, []);

  const zoomAround = React.useCallback((factor: number, anchor: { x: number; y: number } | null) => {
    setViewport((current) => {
      const scale = Math.min(2.4, Math.max(0.4, current.scale * factor));
      if (Math.abs(scale - current.scale) < 1e-4) return current;
      const point = anchor ?? { x: current.tx, y: current.ty };
      const cx = (point.x - current.tx) / current.scale;
      const cy = (point.y - current.ty) / current.scale;
      return { scale, tx: point.x - cx * scale, ty: point.y - cy * scale };
    });
  }, []);

  React.useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAround(Math.exp(-event.deltaY * 0.0016), toUserSpace(event));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAround, toUserSpace, nodes.length]);

  if (!nodes.length) {
    return (
      <div className="context-graph-canvas empty">
        <div className="context-graph-empty-card">
          <GitBranch size={22} aria-hidden="true" />
          <strong>暂无上下文节点</strong>
          <span>跑一轮写作任务后，这里会展示会话树：共享基础 → 各轮消息 → 任务与衔接。</span>
        </div>
      </div>
    );
  }

  const svgHeight = Math.min(560, Math.max(220, layout.height + 4));

  return (
    <div className="context-graph-canvas" role="img" aria-label="上下文会话树">
      <div className="context-graph-legend" aria-hidden="true">
        {(["project_note", "message", "epoch", "handoff", "assemble_slice"] as const).map((kind) => (
          <span key={kind} className={`context-graph-legend-item kind-${kind}`}>
            <i />
            {CONTEXT_GRAPH_KIND_LABEL[kind]}
          </span>
        ))}
        <span className="context-graph-legend-sep" />
        <span className="context-graph-legend-item edge-replays"><i />下一轮 · 续写</span>
        <span className="context-graph-legend-item status-archived"><i />归档</span>
        <span className="context-graph-legend-hint">
          左右平铺 · 父在左 · 子在右纵向排列
        </span>
      </div>
      <div className="context-graph-viewport-controls">
        <button type="button" onClick={() => zoomAround(1 / 1.2, null)} aria-label="缩小" title="缩小">−</button>
        <button type="button" onClick={() => setViewport({ scale: 1, tx: 0, ty: 0 })} title="适应画布">适应</button>
        <button type="button" onClick={() => zoomAround(1.2, null)} aria-label="放大" title="放大">＋</button>
        <span className="context-graph-viewport-readout">{Math.round(viewport.scale * 100)}% · {layout.placed.length} 节点</span>
      </div>
      <svg
        ref={svgRef}
        className={panning ? "panning" : ""}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width="100%"
        height={svgHeight}
        preserveAspectRatio="xMinYMin meet"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const point = toUserSpace(event);
          if (!point) return;
          dragRef.current = { x: point.x, y: point.y, tx: viewport.tx, ty: viewport.ty };
          setPanning(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          const point = toUserSpace(event);
          if (!point) return;
          setViewport((current) => ({ ...current, tx: drag.tx + (point.x - drag.x), ty: drag.ty + (point.y - drag.y) }));
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          setPanning(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { dragRef.current = null; setPanning(false); }}
      >
        <defs>
          <filter id="ctx-node-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="2.4" floodOpacity="0.16" />
          </filter>
          {layout.nodeHeights.map((height) => (
            <clipPath key={height} id={`ctx-node-clip-${height}`}>
              <rect x="0" y="0" width={layout.nodeW} height={height} rx="12" ry="12" />
            </clipPath>
          ))}
          {/* userSpaceOnUse keeps arrow size stable regardless of stroke width */}
          <marker id="ctx-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0.5 L9,4.5 L0,8.5 Z" className="context-graph-arrow" />
          </marker>
          <marker id="ctx-arrow-active" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0.5 L9,4.5 L0,8.5 Z" className="context-graph-arrow active" />
          </marker>
          <marker id="ctx-arrow-next" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0.5 L9,4.5 L0,8.5 Z" className="context-graph-arrow next" />
          </marker>
        </defs>

        <g transform={`translate(${viewport.tx}, ${viewport.ty}) scale(${viewport.scale})`}>
        {/* Edges under cards (paths only). Labels are painted after nodes so chips never sit under cards. */}
        {layout.treeLinks.map((link) => {
          const from = pos.get(link.fromId);
          const to = pos.get(link.toId);
          if (!from || !to) return null;
          const route = treeEdgeRoute(from, to);
          const isNext = link.kind === "tree_next";
          const edgeActive = Boolean(selectedId && (link.fromId === selectedId || link.toId === selectedId));
          const inCluster = Boolean(selectedId && relatedIds.has(link.fromId) && relatedIds.has(link.toId));
          const lit = edgeActive || (inCluster && isNext) || (!selectedId && isNext);
          return (
            <g
              key={`path-${link.id}`}
              className={`context-graph-edge-g${lit ? " active" : selectedId && !edgeActive ? " dim" : ""}${isNext ? " replays" : ""}`}
              pointerEvents="none"
            >
              <path
                d={route.d}
                className={`context-graph-edge-line kind-${link.kind}${lit ? " active" : ""}`}
                markerEnd={isNext ? "url(#ctx-arrow-next)" : lit ? "url(#ctx-arrow-active)" : "url(#ctx-arrow)"}
              />
            </g>
          );
        })}

        {layout.placed.map((node) => {
          const selected = node.id === selectedId;
          const related = relatedIds.has(node.id);
          const dim = Boolean(selectedId && !related);
          const kindLabel = node.treeRole === "root"
            ? "会话根"
            : node.treeRole === "turn"
              ? "轮次"
              : (CONTEXT_GRAPH_KIND_LABEL[node.kind] ?? node.kind);
          const title = contextGraphNodeTitle(node);
          const meta = contextGraphNodeMeta(node);
          const metric = contextGraphNodeMetric(node);
          const superseded = supersededIds.has(node.id);
          const pillText = superseded ? "已被取代" : "归档";
          const pillW = Math.max(30, graphLabelUnits(pillText) * 5.4 + 10);
          const barX = 12;
          const barW = node.w - 24;
          const requestSeries = metric?.kind === "steps"
            ? contextRequestSeriesFromPayload(node.payload)
            : null;
          const requestExpanded = selected && requestSeries != null;
          const barY = node.h - 10;
          const expandedStep = requestExpanded ? requestSeries.steps.at(-1) : undefined;
          const expandedComponents = expandedStep
            ? expandedStep.components.slice(0, 2)
            : [];
          const replayTurns = node.kind === "assemble_slice" ? assembleReplayTurns(node) : undefined;
          return (
            <g
              key={node.id}
              className={`context-graph-svg-node kind-${node.kind} role-${node.treeRole} status-${node.status}${superseded ? " superseded" : ""}${selected ? " selected" : ""}${related && !selected ? " related" : ""}${dim ? " dim" : ""}`}
              transform={`translate(${node.x}, ${node.y})`}
              onClick={() => onSelect(selected ? null : node.id)}
              style={{ cursor: "pointer" }}
            >
              <title>{`${kindLabel}: ${node.label}`}</title>
              <rect width={node.w} height={node.h} rx={10} ry={10} className="context-graph-svg-card" filter="url(#ctx-node-shadow)" />
              <g clipPath={`url(#ctx-node-clip-${node.h})`}>
                <rect x={0} y={0} width={3} height={node.h} className="context-graph-svg-accent" />
                <text x={12} y={18} className="context-graph-svg-kind">{kindLabel}</text>
                {metric?.kind === "steps" ? (
                  <text x={node.w - 12} y={18} textAnchor="end" className="context-graph-svg-expand">
                    {requestExpanded ? "− 收起" : "＋ 展开"}
                  </text>
                ) : null}
                {node.status === "archived" ? (
                  <g transform={`translate(${node.w - pillW - 10}, 8)`}>
                    <rect width={pillW} height={12} rx={6} className="context-graph-status-pill" />
                    <text x={pillW / 2} y={9} textAnchor="middle" className="context-graph-status-pill-text">{pillText}</text>
                  </g>
                ) : null}
                <text x={12} y={36} className="context-graph-svg-label">{title}</text>
                <text x={12} y={50} className="context-graph-svg-meta">
                  {meta}{replayTurns != null && replayTurns > 0 ? ` · 历史 ${replayTurns} 轮` : ""}
                </text>
                {metric?.kind === "steps" ? (
                  <text x={12} y={63} className="context-graph-svg-metric">
                    {`${metric.segments.length} 步 · 当前 ${formatGraphTokens(metric.latestTokens)}`}
                  </text>
                ) : null}
                {metric?.kind === "layers" ? (
                  <>
                    <text x={12} y={63} className="context-graph-svg-metric">
                      {`共 ${formatGraphTokens(metric.total)}`}
                    </text>
                    {(() => {
                      let offset = 0;
                      return metric.segments.map((segment) => {
                        const width = Math.max(2, (segment.tokens / metric.total) * barW);
                        const x = barX + offset;
                        offset += width;
                        return (
                          <rect
                            key={`${segment.layer}-${segment.label}`}
                            x={x}
                            y={barY}
                            width={Math.min(width, barX + barW - x)}
                            height={6}
                            className={`context-graph-layer-seg layer-${segment.layer}`}
                          >
                            <title>{`${CONTEXT_GRAPH_LAYER_LABEL[segment.layer] ?? segment.layer} · ${formatGraphTokens(segment.tokens)} tok`}</title>
                          </rect>
                        );
                      });
                    })()}
                  </>
                ) : null}
                {metric?.kind === "cache" ? (
                  <>
                    <text x={12} y={63} className="context-graph-svg-metric">
                      {[
                        metric.frozenTokens != null ? `冻结 ${formatGraphTokens(metric.frozenTokens)}` : null,
                        metric.hitRate != null ? `命中 ${Math.round(metric.hitRate * 100)}%` : "命中 未实测",
                      ].filter(Boolean).join(" · ")}
                    </text>
                    <rect x={barX} y={barY} width={barW} height={6} rx={3} className="context-graph-hit-track" />
                    {metric.hitRate != null ? (
                      <rect
                        x={barX}
                        y={barY}
                        width={Math.max(2, Math.min(1, metric.hitRate) * barW)}
                        height={6}
                        rx={3}
                        className="context-graph-hit-fill"
                      >
                        <title>{`缓存命中 ${Math.round(metric.hitRate * 100)}%${metric.promptTokens ? ` · 输入 ${formatGraphTokens(metric.promptTokens)}` : ""}`}</title>
                      </rect>
                    ) : null}
                  </>
                ) : null}
                {requestExpanded && expandedStep ? (
                  <g className="context-graph-node-expand">
                    <line x1={12} y1={70} x2={node.w - 12} y2={70} className="context-graph-expand-divider" />
                    <text x={12} y={84} className="context-graph-expand-heading">
                      {`最近 Step ${expandedStep.step} · 主要组成`}
                    </text>
                    {expandedComponents.map((component, index) => {
                      const labelY = 101 + index * 30;
                      return (
                        <g key={`${component.kind}-${component.label}`}>
                          <text x={12} y={labelY} className="context-graph-expand-label">
                            {truncateGraphLabel(`${component.label} · ${formatGraphTokens(component.estimatedTokens)}`, 24)}
                          </text>
                          <text x={12} y={labelY + 13} className="context-graph-expand-preview">
                            {truncateGraphLabel(component.preview || "暂无内容预览", 28)}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                ) : null}
              </g>
            </g>
          );
        })}

        {/* Edge chips above cards, anchored in the depth gutter (never under a node face). */}
        {layout.treeLinks.map((link) => {
          const from = pos.get(link.fromId);
          const to = pos.get(link.toId);
          if (!from || !to) return null;
          const isNext = link.kind === "tree_next";
          const edgeActive = Boolean(selectedId && (link.fromId === selectedId || link.toId === selectedId));
          // Default: only annotate turn-chain links. Child edges stay quiet unless that edge is selected.
          if (!isNext && !edgeActive) return null;
          const route = treeEdgeRoute(from, to);
          const childEpochHit = isNext
            ? (() => {
                const turnNode = pos.get(link.toId);
                if (!turnNode) return undefined;
                for (const node of layout.placed) {
                  if (node.kind !== "epoch") continue;
                  if (node.sourceMessageId != null && turnNode.sourceMessageId === node.sourceMessageId) {
                    return epochHitRate(node);
                  }
                }
                return undefined;
              })()
            : undefined;
          const label = isNext && childEpochHit != null
            ? `下一轮 ${Math.round(childEpochHit * 100)}%`
            : link.label;
          // Keep chips narrow so they fit inside depthGap.
          const labelW = Math.min(76, Math.max(28, graphLabelUnits(label) * 5.6 + 12));
          return (
            <g
              key={`label-${link.id}`}
              className={`context-graph-edge-g${isNext ? " replays" : ""}${edgeActive ? " active" : ""}`}
              pointerEvents="none"
            >
              <rect
                x={route.labelX - labelW / 2}
                y={route.labelY - 8}
                width={labelW}
                height={15}
                rx={7}
                className={`context-graph-edge-chip${isNext || edgeActive ? " active" : ""}${isNext ? " replays" : ""}`}
              />
              <text
                x={route.labelX}
                y={route.labelY + 3}
                textAnchor="middle"
                className={`context-graph-edge-label${isNext || edgeActive ? " active" : ""}`}
              >
                {label}
              </text>
            </g>
          );
        })}
        </g>
      </svg>
    </div>
  );

}
