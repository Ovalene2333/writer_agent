/**
 * Manageable context graph for multi-chapter writing.
 *
 * Design (human terms):
 * - Notebook (result state): handoffs, delivered paths, todos — survives rewrites.
 * - Scratch paper (process): tool transcripts live only inside an epoch.
 * - Trunk (project materials): outline skeleton + character index + lore paths —
 *   shared across chapters; byte-stable until materials change (prefix-cache friendly).
 * - Graph: versioned nodes + edges so edit/rerun can archive a branch and
 *   debugging can show exactly what each request assembled.
 *
 * The wire-format messages[] is still what the provider sees; this module is
 * the durable source of truth for *what should be assembled* and *why*.
 */

import { createHash, randomUUID } from "node:crypto";

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
  | "includes"
  /** Newer epoch freezes/replays the prior turn's prefix (cross-msg cache chain). */
  | "replays";

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

/** Session-level shared materials (outline / characters / lore paths). */
export type ProjectTrunkPayload = {
  kind: "trunk";
  hash: string;
  characterCount: number;
  outlineNodeCount: number;
  lorePathCount: number;
  estimatedTokens: number;
};

/**
 * Human-facing explanation of a mid-job context cut (chapter / scene boundary).
 * The graph UI renders this as "what was kept vs dropped" — not raw JSON only.
 */
export type ContextTransition = {
  kind: "chapter_boundary" | "scene_boundary" | "open_turn";
  /** Agent tool-loop step that triggered the cut (1-based). Next step inherits after. */
  atStep?: number;
  /** Est. tokens in the request messages *before* truncation. */
  beforeTokens?: number;
  /** Est. tokens right after truncation + handoff append. */
  afterTokens?: number;
  beforeMessageCount?: number;
  afterMessageCount?: number;
  kept: Array<{ id: string; label: string; detail?: string }>;
  dropped: Array<{ id: string; label: string; detail?: string }>;
  /** Why the model may still call read_document / search_project after the cut. */
  reReadHint?: string;
  path?: string;
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
  /**
   * Why the replayed prefix looks the way it does this turn. A turn that
   * compacted or dropped frozen blocks is a turn whose cached prefix was
   * invalidated on purpose — without this the graph shows a cache miss with
   * no explanation.
   */
  replay?: {
    turns: number;
    estimatedTokens: number;
    compacted: boolean;
    droppedTurns: number;
    budgetTokens: number;
  };
  trunk?: {
    hash: string;
    estimatedTokens: number;
  };
  /** Keep/drop story for chapter/scene cuts — primary UI payload for inheritance. */
  transition?: ContextTransition;
  supersededHandoffs?: number;
  note?: string;
  proposalId?: number;
  /** Session materials shelf entry count at assemble time. */
  materialsShelfCount?: number;
};

/** Placeholder when the project has no outline/characters/lore yet — keeps the slot present. */
export const PROJECT_TRUNK_EMPTY =
  "【项目树干 · 跨章共享】本项目暂无可用的大纲骨架、角色索引或设定路径。完整材料仍用工具按需读取。";

/** Soft cap so the trunk stays a cheap shared prefix, not a second dynamic dump. */
const PROJECT_TRUNK_BUDGET_CHARS = 6_000;

export type ProjectTrunkCharacter = {
  id: number;
  name: string;
  aliases?: string[];
  narrativeRole?: string;
  summary?: string;
};

export type ProjectTrunkOutlineNode = {
  id: string;
  type: string;
  title: string;
  summary?: string;
  documentPath?: string;
  depth?: number;
};

export type ProjectTrunkBuildInput = {
  title?: string;
  characters: ProjectTrunkCharacter[];
  outline?: {
    sourcePath: string;
    nodes: ProjectTrunkOutlineNode[];
  };
  lorePaths: string[];
};

export type ProjectTrunkBuildResult = {
  content: string;
  hash: string;
  characterCount: number;
  outlineNodeCount: number;
  lorePathCount: number;
  estimatedTokens: number;
  empty: boolean;
};

/**
 * Build the shared project trunk: stable across turns until materials change.
 *
 * CACHE: Sits after the 6 stable system slots and before turn replay. Same hash
 * ⇒ same bytes ⇒ provider prefix can hit through the trunk. Never put timestamps,
 * current chapter focus, todos, or full prose bodies here.
 */
export function buildProjectTrunk(input: ProjectTrunkBuildInput): ProjectTrunkBuildResult {
  const characters = input.characters
    .slice()
    .sort((a, b) => a.id - b.id || a.name.localeCompare(b.name, "zh-CN"))
    .slice(0, 40)
    .map((item) => ({
      id: item.id,
      name: item.name.replace(/\s+/g, " ").trim().slice(0, 40),
      ...(item.aliases?.length
        ? { aliases: item.aliases.map(value => value.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 4) }
        : {}),
      ...(item.narrativeRole?.trim()
        ? { narrativeRole: item.narrativeRole.replace(/\s+/g, " ").trim().slice(0, 40) }
        : {}),
      ...(item.summary?.trim()
        ? { summary: item.summary.replace(/\s+/g, " ").trim().slice(0, 120) }
        : {}),
    }));

  const outlineNodes = (input.outline?.nodes ?? [])
    .slice(0, 48)
    .map((node) => ({
      id: node.id,
      type: node.type,
      title: node.title.replace(/\s+/g, " ").trim().slice(0, 60),
      ...(node.summary?.trim()
        ? { summary: node.summary.replace(/\s+/g, " ").trim().slice(0, 80) }
        : {}),
      ...(node.documentPath ? { documentPath: node.documentPath } : {}),
      ...(typeof node.depth === "number" ? { depth: node.depth } : {}),
    }));

  const lorePaths = [...new Set(input.lorePaths.map(path => path.replace(/\\/g, "/").replace(/^\.\//, "")))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, 40);

  if (!characters.length && !outlineNodes.length && !lorePaths.length) {
    const content = PROJECT_TRUNK_EMPTY;
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    return {
      content,
      hash,
      characterCount: 0,
      outlineNodeCount: 0,
      lorePathCount: 0,
      estimatedTokens: Math.ceil(Buffer.byteLength(content, "utf8") / 4),
      empty: true,
    };
  }

  const body = {
    title: input.title?.trim() || undefined,
    outlineSource: input.outline?.sourcePath,
    outlineNodes,
    characters,
    lorePaths,
  };

  let serialized = JSON.stringify(body);
  if (serialized.length > PROJECT_TRUNK_BUDGET_CHARS) {
    // Prefer keeping characters + lore paths; shrink outline first, then character summaries.
    let nodes = outlineNodes;
    while (serialized.length > PROJECT_TRUNK_BUDGET_CHARS && nodes.length > 8) {
      nodes = nodes.slice(0, Math.max(8, Math.floor(nodes.length * 0.7)));
      serialized = JSON.stringify({ ...body, outlineNodes: nodes });
    }
    let chars = characters;
    while (serialized.length > PROJECT_TRUNK_BUDGET_CHARS && chars.length > 6) {
      chars = chars.map((item, index) => (
        index < chars.length - 2
          ? { id: item.id, name: item.name, ...(item.narrativeRole ? { narrativeRole: item.narrativeRole } : {}) }
          : item
      )).slice(0, Math.max(6, chars.length - 2));
      serialized = JSON.stringify({ ...body, outlineNodes: nodes, characters: chars });
    }
  }

  const content = [
    "【项目树干 · 跨章共享】以下材料跨任务字节稳定（大纲/角色/设定变更后换新版本）。",
    "这是索引与骨架，不是已读正文；需要细节时用 get_outline_node / get_character / read_document 按 id 或路径读取。",
    "禁止因树干存在而重复 list_outline_nodes 或通读整本大纲。",
    serialized,
  ].join("\n");
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return {
    content,
    hash,
    characterCount: characters.length,
    outlineNodeCount: outlineNodes.length,
    lorePathCount: lorePaths.length,
    estimatedTokens: Math.ceil(Buffer.byteLength(content, "utf8") / 4),
    empty: false,
  };
}

export function isProjectTrunkNode(node: ContextNode): boolean {
  return node.kind === "project_note" && (node.payload as { kind?: unknown }).kind === "trunk";
}

/** Measured provider cache usage for one user turn, written back on freeze. */
export type EpochCacheStats = {
  promptTokens: number;
  cacheHitTokens: number;
  /** cacheHitTokens / promptTokens, or undefined when nothing was measured. */
  hitRate?: number;
  steps: number;
};

export type ContextGraphView = {
  sessionId: string;
  nodes: ContextNode[];
  edges: ContextEdge[];
  activeHandoffs: ContextNode[];
  activeEpochs: ContextNode[];
  activeTrunks: ContextNode[];
  recentSlices: ContextNode[];
  stats: {
    activeNodes: number;
    archivedNodes: number;
    edgeCount: number;
    handoffCount: number;
    trunkCount: number;
    /** Nodes in the session, before `limit` was applied. */
    totalNodes: number;
  };
  /** True when `nodes` is a recent window rather than the whole session. */
  truncated: boolean;
};

export const CONTEXT_GRAPH_DEFAULT_LIMIT = 300;

export function newContextNodeId(prefix = "ctx"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function newContextEdgeId(): string {
  return `edge_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export type HandoffPromptOptions = {
  /** Newest N handoffs keep tail + final scene state; older ones collapse to one line. */
  detailed?: number;
  /** Hard cap on how many handoffs appear at all. */
  limit?: number;
  /** Character budget for the whole block; oldest entries are dropped to fit. */
  budgetChars?: number;
};

/** Normalized identity of a delivered chapter, so a rewrite can supersede its predecessor. */
export function chapterHandoffKey(parts: { path?: string; index?: number }): string {
  const path = parts.path?.trim().replace(/^\.?\//, "").replace(/\\/g, "/").toLowerCase();
  if (path) return `path:${path}`;
  if (parts.index != null) return `index:${parts.index}`;
  return "";
}

/**
 * Compact prompt block from active chapter handoffs (L2 focus state).
 *
 * Tiered on purpose. Only the chapter immediately behind the cursor needs its
 * seam tail and final scene state — that is what the next paragraph has to
 * continue from. Chapters further back only need to be *known to exist* at a
 * path; pasting their tails too spent ~1.3k tokens a turn restating prose the
 * model can read on demand, and gave it four competing "结尾衔接" to continue.
 */
export function formatActiveHandoffsForPrompt(
  handoffs: ContextNode[],
  options: HandoffPromptOptions = {},
): string {
  const detailed = Math.max(0, options.detailed ?? 1);
  const limit = Math.max(1, options.limit ?? 5);
  const budgetChars = Math.max(400, options.budgetChars ?? 2_600);

  const all = handoffs.filter(node => node.kind === "handoff" && node.status === "active");
  if (!all.length) {
    return "【可管理上下文 · 交付交接】无活跃章交接（本焦点仅依赖当前任务与工具读取）。";
  }
  const shown = all.slice(-limit);

  const header = "【可管理上下文 · 交付交接】以下为已结算的章结果态（过程工具链已丢弃）。续写以此为准；全文用工具按需读取，勿复述已交付过程。";
  // Newest last, so `index >= shown.length - detailed` is the detailed tier.
  const entries = shown.map((node, index) => {
    const payload = node.payload as Partial<ChapterHandoffPayload>;
    const summary = payload.summary ? String(payload.summary).replace(/\s+/g, " ") : "";
    if (index < shown.length - detailed) {
      const where = payload.path ?? node.label.replace(/\s+/g, " ");
      return summary ? `- 已交付 ${where} — ${summary.slice(0, 60)}` : `- 已交付 ${where}`;
    }
    const lines = [`- ${node.label.replace(/\s+/g, " ")}`];
    if (payload.path) lines.push(`  路径：${payload.path}`);
    if (summary) lines.push(`  摘要：${summary.slice(0, 200)}`);
    if (payload.tail) lines.push(`  结尾衔接：…${String(payload.tail).trim().slice(-500)}`);
    if (payload.finalActualState != null) {
      try {
        lines.push(`  末场状态：${JSON.stringify(payload.finalActualState).slice(0, 600)}`);
      } catch {
        /* A non-serializable state is diagnostic only; the seam tail still carries continuity. */
      }
    }
    return lines.join("\n");
  });

  // Drop from the oldest end until the block fits. Never drop the detailed tier:
  // losing the seam is the one thing that actually breaks continuity.
  let kept = entries;
  const size = (list: string[]) => list.reduce((sum, entry) => sum + entry.length + 1, header.length);
  while (kept.length > detailed && size(kept) > budgetChars) kept = kept.slice(1);

  const omitted = all.length - kept.length;
  return [
    header,
    ...kept,
    ...(omitted > 0
      ? [`- 更早交付共 ${omitted} 章，未在此展开；需要时用 list_documents / read_document 按路径读取。`]
      : []),
  ].join("\n");
}

/**
 * Assemble the view the debugger reads.
 *
 * `limit` bounds the returned node window — a long session accumulates a node
 * per message, epoch, handoff and assemble slice, and shipping all of them plus
 * every edge over one JSON response is the kind of payload that only grows.
 * Active handoffs are always kept regardless of the window: they are the actual
 * source of the L2 prompt block, so a view that hides them is misleading.
 * `stats` stays whole-session so the counters never silently shrink.
 */
export function buildContextGraphView(
  sessionId: string,
  nodes: ContextNode[],
  edges: ContextEdge[],
  options: { limit?: number } = {},
): ContextGraphView {
  const active = nodes.filter(node => node.status === "active");
  const archived = nodes.filter(node => node.status === "archived");
  const activeHandoffs = active.filter(node => node.kind === "handoff");
  const activeEpochs = active.filter(node => node.kind === "epoch");
  const activeTrunks = active.filter(isProjectTrunkNode);
  const recentSlices = nodes
    .filter(node => node.kind === "assemble_slice")
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30);

  const ordered = nodes.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const limit = Math.max(1, Math.floor(options.limit ?? CONTEXT_GRAPH_DEFAULT_LIMIT));
  const truncated = ordered.length > limit;
  let visible = ordered;
  if (truncated) {
    const window = new Set(ordered.slice(-limit).map(node => node.id));
    for (const handoff of activeHandoffs) window.add(handoff.id);
    // Trunk is the shared L0 materials node — hide it and the graph cannot explain prefix hits.
    for (const trunk of activeTrunks) window.add(trunk.id);
    visible = ordered.filter(node => window.has(node.id));
  }
  const visibleIds = new Set(visible.map(node => node.id));
  // Dangling edges would render as arrows into nothing.
  const visibleEdges = truncated
    ? edges.filter(edge => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId))
    : edges;

  return {
    sessionId,
    nodes: visible,
    edges: visibleEdges,
    activeHandoffs,
    activeEpochs,
    activeTrunks,
    recentSlices,
    stats: {
      activeNodes: active.length,
      archivedNodes: archived.length,
      edgeCount: edges.length,
      handoffCount: activeHandoffs.length,
      trunkCount: activeTrunks.length,
      totalNodes: nodes.length,
    },
    truncated,
  };
}

export function chapterHandoffLabel(parts: { path?: string; summary?: string; index?: number }): string {
  if (parts.path) return `章交接 · ${parts.path}`;
  if (parts.index != null) return `章交接 · #${parts.index}`;
  return `章交接 · ${parts.summary?.slice(0, 40) || "未命名"}`;
}
