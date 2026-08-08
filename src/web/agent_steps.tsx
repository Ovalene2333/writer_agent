import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronUp, Copy, MoreHorizontal, RotateCw } from "lucide-react";
import type { AgentJob, MessageStepTrail, StepUsage, StepUsageCall, StoredStepTrail, StreamStep, Usage } from "./types";
import { callKindLabel } from "./types";
import { Markdown } from "./markdown";
import { assistantPreviewText } from "./assistant_display";
import { formatGraphTokens, shortProviderName } from "./format_utils";

/** Pure visible completion (completion − reasoning when nested). */
export function pureOutputTokens(usage: { completionTokens: number; reasoningTokens?: number }): number {
  const reasoning = Math.max(0, Math.round(usage.reasoningTokens ?? 0));
  return Math.max(0, usage.completionTokens - Math.min(reasoning, usage.completionTokens));
}

export function formatDurationMs(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function activeStepIndex(steps: StreamStep[]): number {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].status === "running") return i;
  }
  return -1;
}

export const STEP_TRAIL_STORAGE_KEY = "writer-agent-step-trails";
export const STEP_TRAIL_MAX_SESSIONS = 20;
export const STEP_TRAIL_MAX_TEXT_LENGTH = 24_000;
export const STEP_TRAIL_MAX_STORAGE_LENGTH = 2_500_000;

export function compactStepTrailText(value: string): string {
  if (value.length <= STEP_TRAIL_MAX_TEXT_LENGTH) return value;
  const tailLength = 5_000;
  const headLength = STEP_TRAIL_MAX_TEXT_LENGTH - tailLength;
  return `${value.slice(0, headLength)}\n\n[内容过长，已截断]\n\n${value.slice(-tailLength)}`;
}

export function readStepTrailMap(): Record<string, StoredStepTrail> {
  try {
    const raw = localStorage.getItem(STEP_TRAIL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, StoredStepTrail>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveStepTrail(sessionId: string, messageId: number, steps: StreamStep[]): void {
  if (!sessionId || !steps.length) return;
  // Negative ids are optimistic anchors. Persist them too so a refresh during a job
  // does not erase the trail before the server assigns the real message id.
  if (!Number.isFinite(messageId) || messageId === 0) return;
  const map = readStepTrailMap();
  map[sessionId] = {
    sessionId,
    messageId,
    steps: steps.map((step) => ({
      ...step,
      output: compactStepTrailText(step.output),
      reasoning: compactStepTrailText(step.reasoning),
      expanded: false,
    })),
    updatedAt: new Date().toISOString(),
  };
  // Bound both session count and serialized size. Full model output can otherwise
  // exceed the browser quota and make setItem fail without preserving this run.
  const entries = Object.entries(map).sort((a, b) => (b[1].updatedAt || "").localeCompare(a[1].updatedAt || ""));
  const kept = entries.slice(0, STEP_TRAIL_MAX_SESSIONS);
  let serialized = JSON.stringify(Object.fromEntries(kept));
  while (serialized.length > STEP_TRAIL_MAX_STORAGE_LENGTH && kept.length > 1) {
    kept.pop();
    serialized = JSON.stringify(Object.fromEntries(kept));
  }
  try {
    localStorage.setItem(STEP_TRAIL_STORAGE_KEY, serialized);
  } catch {
    // Other local data may consume the quota. Retry after evicting older trails.
    while (kept.length > 1) {
      kept.pop();
      try {
        localStorage.setItem(STEP_TRAIL_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
        return;
      } catch {
        /* keep evicting */
      }
    }
  }
}

export function clearStepTrail(sessionId: string): void {
  if (!sessionId) return;
  const map = readStepTrailMap();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  try {
    localStorage.setItem(STEP_TRAIL_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function formatStepCost(usage: StepUsage): string | null {
  if (!(usage.cost > 0)) return null;
  const symbol = usage.currency === "CNY" ? "¥" : "$";
  return `${symbol}${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(3)}`;
}

export function stepUsageTitle(usage: StepUsage): string {
  const multi = (usage.callBreakdown?.length ?? 0) > 1 || usage.model === "多个模型";
  const cache = stepCacheRates(usage);
  const pureOut = pureOutputTokens(usage);
  const duration = formatDurationMs(usage.durationMs);
  const parts = [
    usage.estimated ? "估算" : null,
    multi ? "多模型合计" : usage.model ?? null,
    `输入 ${usage.promptTokens.toLocaleString()}`,
    `输出 ${pureOut.toLocaleString()}`,
    usage.reasoningTokens !== undefined
      ? `推理 ${usage.reasoningTokens.toLocaleString()}`
      : null,
    `缓存命中 ${usage.cacheHitTokens.toLocaleString()}`,
    cache.primary !== undefined && multi
      ? `Agent 主步命中率 ${(cache.primary * 100).toFixed(1)}%`
      : null,
    cache.total !== undefined
      ? `${multi ? "全调用合计命中率" : "命中率"} ${(cache.total * 100).toFixed(1)}%`
      : null,
    duration ? `耗时 ${duration}` : null,
    usage.cost > 0
      ? `费用 ${usage.currency === "CNY" ? "¥" : "$"}${usage.cost.toFixed(6)}`
      : null,
    multi && usage.callBreakdown?.length
      ? usage.callBreakdown
          .map(call => {
            const m = call.cacheHitTokens + call.cacheMissTokens;
            const rate = m > 0 ? `${((call.cacheHitTokens / m) * 100).toFixed(0)}%` : "—";
            return `${callKindLabel(call.callKind)}/${call.model ?? "?"} ${rate}`;
          })
          .join("；")
      : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function stepCacheRates(usage: StepUsage): { primary?: number; total?: number } {
  const measured = (usage.callBreakdown ?? []).filter(call => !call.estimated);
  const primary = measured.filter(call => call.callKind === "agent_step");
  const primaryHit = primary.reduce((sum, call) => sum + call.cacheHitTokens, 0);
  const primaryMiss = primary.reduce((sum, call) => sum + call.cacheMissTokens, 0);
  const totalHit = Math.max(0, usage.cacheHitTokens);
  const totalMiss = Math.max(0, usage.cacheMissTokens);
  return {
    ...(primaryHit + primaryMiss > 0 ? { primary: primaryHit / (primaryHit + primaryMiss) } : {}),
    ...(totalHit + totalMiss > 0
      ? { total: totalHit / (totalHit + totalMiss) }
      : usage.cacheHitRate !== undefined ? { total: usage.cacheHitRate } : {}),
  };
}

/** Compact per-step usage: in · out · cache · cost (no Σ total). */
export function StepTokenBadge({ usage, pending }: { usage?: StepUsage; pending?: boolean }) {
  if (!usage) {
    return (
      <span className={`agent-step-tokens pending`} title={pending ? "等待本步 token 统计…" : "本步未拿到 token 统计"}>
        {pending ? "token…" : "—"}
      </span>
    );
  }
  const cost = formatStepCost(usage);
  const cache = stepCacheRates(usage);
  const visibleCacheRate = cache.primary ?? cache.total;
  const cacheTitle = cache.primary !== undefined && cache.total !== undefined
    && Math.abs(cache.primary - cache.total) > 0.0005
    ? `Agent 主步命中 ${(cache.primary * 100).toFixed(1)}%；全调用合计 ${(cache.total * 100).toFixed(1)}%`
    : `缓存命中 ${usage.cacheHitTokens.toLocaleString()}${visibleCacheRate !== undefined ? `（${(visibleCacheRate * 100).toFixed(1)}%）` : ""}`;
  return (
    <span
      className={`agent-step-tokens${usage.estimated ? " estimated" : ""}`}
      title={stepUsageTitle(usage)}
    >
      <span className="tok-metric tok-in" title={`输入 ${usage.promptTokens.toLocaleString()}`}>
        <span className="tok-ico" aria-hidden="true">I</span>
        {formatTokenCount(usage.promptTokens)}
      </span>
      <span
        className="tok-metric tok-out"
        title={usage.reasoningTokens !== undefined
          ? `输出 ${pureOutputTokens(usage).toLocaleString()}（纯） · 推理 ${usage.reasoningTokens.toLocaleString()}`
          : `输出 ${usage.completionTokens.toLocaleString()}`}
      >
        <span className="tok-ico" aria-hidden="true">O</span>
        {formatTokenCount(pureOutputTokens(usage))}
      </span>
      <span className="tok-metric tok-cache" title={cacheTitle}>
        <span className="tok-ico" aria-hidden="true">C</span>
        {visibleCacheRate !== undefined ? `${Math.round(visibleCacheRate * 100)}%` : formatTokenCount(usage.cacheHitTokens)}
      </span>
      {cost && <span className="tok-metric tok-cost">{cost}</span>}
      {usage.estimated && <em className="est">估</em>}
    </span>
  );
}

const TOOL_LABELS: Record<string, string> = {
  list_documents: "文档",
  inspect_document: "检查文档",
  locate_document_span: "定位",
  read_document: "读文档",
  read_document_span: "读片段",
  search_project: "搜索项目",
  list_files: "文件",
  inspect_file: "检查文件",
  read_file: "读文件",
  search_files: "搜索文件",
  write_file: "写入",
  edit_file: "编辑",
  move_file: "移动",
  delete_file: "删除",
  design_creative_outline: "构思",
  audit_prose_style: "审文风",
  list_outline_nodes: "大纲",
  get_outline_node: "读大纲",
  propose_outline_patch: "改大纲",
  validate_outline: "校验大纲",
  compare_outline_with_draft: "对照大纲",
  compile_write_pack: "写作包",
  begin_chapter_draft: "开章",
  write_chapter_scene: "写场景",
  revise_chapter_scene_guide: "修场纲",
  revise_chapter_draft_style: "修文风",
  inspect_chapter_draft: "审章节",
  manage_todos: "任务",
  generate_image: "生图",
};

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replace(/_/g, " ");
}

function toolSummary(tools: string[]): { label: string; title: string } | null {
  if (!tools.length) return null;
  const labels = tools.map(toolLabel);
  return {
    label: tools.length === 1 ? labels[0] : `工具 ${tools.length}`,
    title: labels.map((label, index) => `${label} · ${tools[index]}`).join("\n"),
  };
}

export function sumStepUsage(steps: StreamStep[]): StepUsage | undefined {
  const withUsage = steps.filter((step) => step.usage);
  if (!withUsage.length) return undefined;
  const models = [...new Set(withUsage.flatMap(step =>
    step.usage?.callBreakdown?.map(call => call.model).filter((model): model is string => Boolean(model))
      ?? (step.usage?.model ? [step.usage.model] : []),
  ))];
  const currency = withUsage.find((step) => step.usage!.cost > 0)?.usage?.currency
    ?? withUsage[0].usage!.currency
    ?? "CNY";
  const measured = withUsage.filter(step => !step.usage?.estimated);
  const measuredHits = measured.reduce((sum, step) => sum + (step.usage?.cacheHitTokens ?? 0), 0);
  const measuredMisses = measured.reduce((sum, step) => sum + (step.usage?.cacheMissTokens ?? 0), 0);
  return {
    ...(models.length ? { model: models.length === 1 ? models[0] : "多个模型" } : {}),
    promptTokens: withUsage.reduce((sum, step) => sum + (step.usage?.promptTokens ?? 0), 0),
    completionTokens: withUsage.reduce((sum, step) => sum + (step.usage?.completionTokens ?? 0), 0),
    cacheHitTokens: withUsage.reduce((sum, step) => sum + (step.usage?.cacheHitTokens ?? 0), 0),
    cacheMissTokens: withUsage.reduce((sum, step) => sum + (step.usage?.cacheMissTokens ?? 0), 0),
    totalTokens: withUsage.reduce((sum, step) => sum + (step.usage?.totalTokens ?? 0), 0),
    cost: withUsage.reduce((sum, step) => sum + (step.usage?.cost ?? 0), 0),
    currency,
    estimated: withUsage.some((step) => step.usage?.estimated),
    ...(measuredHits + measuredMisses > 0 ? { cacheHitRate: measuredHits / (measuredHits + measuredMisses) } : {}),
    requestComponents: withUsage.flatMap(step => step.usage?.requestComponents ?? []),
    callBreakdown: withUsage.flatMap(step => step.usage?.callBreakdown ?? []),
  };
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

export function realCacheHitRate(usage: Pick<Usage, "cacheHitRate" | "cacheHitTokens" | "cacheMissTokens">): number {
  if (typeof usage.cacheHitRate === "number" && Number.isFinite(usage.cacheHitRate)) {
    return Math.max(0, Math.min(1, usage.cacheHitRate));
  }
  const hit = Number.isFinite(usage.cacheHitTokens) ? Math.max(0, usage.cacheHitTokens) : 0;
  const miss = Number.isFinite(usage.cacheMissTokens) ? Math.max(0, usage.cacheMissTokens) : 0;
  return hit + miss > 0 ? hit / (hit + miss) : 0;
}


export function messagePreview(content: string, max = 140): string {
  return assistantPreviewText(content, max);
}

export function stepsFromServerTrail(trail: MessageStepTrail): StreamStep[] {
  return trail.steps.map((step) => ({
    id: step.id,
    output: step.output ?? "",
    reasoning: step.reasoning ?? "",
    tools: Array.isArray(step.tools) ? step.tools : [],
    status: step.status === "running" || step.status === "failed" || step.status === "completed"
      ? step.status
      : "completed",
    expanded: step.status === "running",
    ...(step.usage ? { usage: step.usage } : {}),
  }));
}

/** Strip legacy in-body Job ID footers so chat stays clean; ids live in JobMetaMenu. */
export function stripExposedJobIdFooter(content: string): string {
  return content.replace(/(?:\n\n|\n)?Job ID:\s*\S+\s*$/u, "").trimEnd();
}

export type JobMetaView = {
  id: string;
  status?: string;
  kind?: string;
  createdAt?: string;
  updatedAt?: string;
  sourceMessageId?: number;
  stepCount?: number;
};

export function resolveJobMeta(input: {
  trail?: MessageStepTrail;
  liveJob?: AgentJob;
  sourceMessageId?: number;
  stepCount?: number;
}): JobMetaView | undefined {
  const id = input.liveJob?.id ?? input.trail?.jobId;
  if (!id) return undefined;
  return {
    id,
    status: input.liveJob?.status ?? input.trail?.jobStatus,
    kind: input.liveJob?.kind ?? input.trail?.jobKind,
    createdAt: input.liveJob?.createdAt ?? input.trail?.jobCreatedAt,
    updatedAt: input.liveJob?.updatedAt ?? input.trail?.jobUpdatedAt ?? input.trail?.updatedAt,
    sourceMessageId: input.liveJob?.sourceMessageId ?? input.trail?.sourceMessageId ?? input.sourceMessageId,
    stepCount: input.stepCount ?? input.trail?.steps.length,
  };
}

function formatJobMetaTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return value;
  }
}

const JOB_STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  suspended: "已暂停",
};

type JobMetaMenuPlacement = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "above" | "below";
};

const JOB_META_MENU_GAP = 6;
const JOB_META_MENU_EST_HEIGHT = 220;
const JOB_META_MENU_MIN_HEIGHT = 96;
const JOB_META_MENU_VIEW_PAD = 8;
const JOB_META_MENU_WIDTH = 260;

function computeJobMetaMenuPlacement(
  trigger: DOMRect,
  measuredHeight = JOB_META_MENU_EST_HEIGHT,
): JobMetaMenuPlacement {
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const spaceAbove = Math.max(0, trigger.top - JOB_META_MENU_VIEW_PAD);
  const spaceBelow = Math.max(0, viewportH - trigger.bottom - JOB_META_MENU_VIEW_PAD);
  // Prefer below near the chat top (first message); otherwise open above the actions row.
  const placement: "above" | "below" =
    spaceAbove < measuredHeight && spaceBelow >= Math.min(measuredHeight, spaceAbove + 1)
      ? "below"
      : spaceAbove >= measuredHeight
        ? "above"
        : spaceBelow >= spaceAbove ? "below" : "above";
  const available = placement === "below" ? spaceBelow : spaceAbove;
  const maxHeight = Math.max(
    JOB_META_MENU_MIN_HEIGHT,
    Math.min(measuredHeight, available > 0 ? available - JOB_META_MENU_GAP : JOB_META_MENU_EST_HEIGHT),
  );
  const width = Math.min(JOB_META_MENU_WIDTH, Math.max(200, viewportW - JOB_META_MENU_VIEW_PAD * 2));
  let left = trigger.right - width;
  left = Math.max(JOB_META_MENU_VIEW_PAD, Math.min(left, viewportW - width - JOB_META_MENU_VIEW_PAD));
  const top = placement === "below"
    ? Math.min(trigger.bottom + JOB_META_MENU_GAP, viewportH - maxHeight - JOB_META_MENU_VIEW_PAD)
    : Math.max(JOB_META_MENU_VIEW_PAD, trigger.top - JOB_META_MENU_GAP - maxHeight);
  return { top, left, width, maxHeight, placement };
}

/** Compact ⋯ control: job id/time stay hidden until opened. */
export function JobMetaMenu({ meta }: { meta: JobMetaView }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [placement, setPlacement] = useState<JobMetaMenuPlacement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updatePlacement = useCallback((measuredHeight?: number) => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    setPlacement(computeJobMetaMenuPlacement(trigger, measuredHeight));
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setPlacement(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    let onPointer: ((event: MouseEvent) => void) | undefined;
    // Defer outside-dismiss so the opening click cannot immediately close the menu.
    const dismissTimer = window.setTimeout(() => {
      onPointer = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
        closeMenu();
      };
      document.addEventListener("mousedown", onPointer);
    }, 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    const onReposition = () => {
      const natural = menuRef.current?.scrollHeight;
      updatePlacement(natural && natural > 0 ? natural : undefined);
    };
    const frame = window.requestAnimationFrame(() => {
      const natural = menuRef.current?.scrollHeight;
      if (natural && natural > 0) updatePlacement(natural);
    });
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    document.addEventListener("scroll", onReposition, true);
    return () => {
      window.clearTimeout(dismissTimer);
      window.cancelAnimationFrame(frame);
      if (onPointer) document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      document.removeEventListener("scroll", onReposition, true);
    };
  }, [open, closeMenu, updatePlacement]);

  const statusLabel = meta.status
    ? (JOB_STATUS_LABEL[meta.status] ?? meta.status)
    : "—";
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: "Job ID", value: meta.id, mono: true },
    { label: "状态", value: statusLabel },
    { label: "类型", value: meta.kind?.trim() || "agent" },
    { label: "开始", value: formatJobMetaTime(meta.createdAt) },
    { label: "更新", value: formatJobMetaTime(meta.updatedAt) },
  ];
  if (meta.sourceMessageId != null && meta.sourceMessageId > 0) {
    rows.push({ label: "消息", value: String(meta.sourceMessageId), mono: true });
  }
  if (meta.stepCount != null && meta.stepCount > 0) {
    rows.push({ label: "步骤", value: String(meta.stepCount) });
  }

  const menu = open && placement
    ? createPortal(
      <div
        ref={menuRef}
        className={`agent-job-meta-menu placement-${placement.placement}`}
        role="menu"
        style={{
          top: placement.top,
          left: placement.left,
          width: placement.width,
          maxHeight: placement.maxHeight,
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="agent-job-meta-head">
          <strong>任务元数据</strong>
          <button
            type="button"
            className="agent-job-meta-copy"
            title="复制 Job ID"
            onClick={() => {
              void navigator.clipboard?.writeText(meta.id).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              }).catch(() => undefined);
            }}
          >
            {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            <span>{copied ? "已复制" : "复制 ID"}</span>
          </button>
        </div>
        <dl className="agent-job-meta-list">
          {rows.map(row => (
            <div key={row.label} className="agent-job-meta-row">
              <dt>{row.label}</dt>
              <dd className={row.mono ? "mono" : undefined} title={row.value}>{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>,
      document.body,
    )
    : null;

  return (
    <div className={`agent-job-meta${open ? " open" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="agent-job-meta-trigger"
        title="任务元数据"
        aria-label="任务元数据"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (open) {
            closeMenu();
            return;
          }
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect) setPlacement(computeJobMetaMenuPlacement(rect));
          else {
            // Fallback so the card still mounts even if layout rect is momentarily unavailable.
            setPlacement({
              top: Math.max(JOB_META_MENU_VIEW_PAD, 72),
              left: Math.max(JOB_META_MENU_VIEW_PAD, window.innerWidth - JOB_META_MENU_WIDTH - JOB_META_MENU_VIEW_PAD),
              width: JOB_META_MENU_WIDTH,
              maxHeight: JOB_META_MENU_EST_HEIGHT,
              placement: "below",
            });
          }
          setOpen(true);
        }}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {menu}
    </div>
  );
}

/** One-line plain preview for collapsed assistant bubbles. */
export function detectStepContextReset(
  prev: StreamStep | undefined,
  step: StreamStep,
): { fromStep: number; toStep: number; before: number; after: number; ratio: number } | null {
  if (!prev || prev.id < 1 || step.id < 1) return null;
  const before = prev.usage?.promptTokens ?? 0;
  const after = step.usage?.promptTokens ?? 0;
  if (before < 8_000 || after < 1_000) return null;
  if (after >= before * 0.62) return null;
  // Prefer cuts after a document delivery / scene write.
  const prevTools = prev.tools.join(" ");
  const likelyBoundary = /write_file|edit_file|propose_chapter|write_chapter_scene/.test(prevTools)
    || before - after > 12_000;
  if (!likelyBoundary) return null;
  return {
    fromStep: prev.id,
    toStep: step.id,
    before,
    after,
    ratio: after / before,
  };
}

export function AgentStepContextResetBanner({
  reset,
}: {
  reset: { fromStep: number; toStep: number; before: number; after: number; ratio: number };
}) {
  const saved = reset.before - reset.after;
  const stepLabel = `${reset.fromStep} → ${reset.toStep}`;
  const tokenLabel = `${formatGraphTokens(reset.before)} → ${formatGraphTokens(reset.after)}`;
  return (
    <article
      className="agent-step completed context-reset"
      title="上下文收束：保留规则、索引和衔接；卸下过程细节。"
      aria-label={`上下文已收束，步骤 ${stepLabel}，上下文 ${tokenLabel}，减少 ${formatGraphTokens(saved)}`}
    >
      <div className="agent-step-header">
        <div className="agent-step-summary agent-step-context-reset-summary" role="status">
          <span className="agent-step-indicator" aria-hidden="true" />
          <strong>收束</strong>
          <span className="agent-step-context-reset-flow" title={`步骤 ${stepLabel}`}>
            {stepLabel}
          </span>
          <span className="agent-step-context-reset-tokens" title={`上下文 ${tokenLabel}`}>
            {tokenLabel}
          </span>
          <span className="agent-step-context-reset-saved" title={`减少 ${formatGraphTokens(saved)}`}>
            -{formatGraphTokens(saved)}
          </span>
        </div>
      </div>
    </article>
  );
}

export function AgentStepCard({
  step,
  prevStep,
  onToggle,
  resumeAction,
  onLocalLink,
}: {
  step: StreamStep;
  prevStep?: StreamStep;
  onToggle: () => void;
  /** Shown on the last step of a trail — continue an interrupted Agent run. */
  resumeAction?: {
    disabled?: boolean;
    onClick: () => void;
  };
  onLocalLink?: (href: string) => void;
}) {
  const label =
    step.id === 0
      ? "Planning"
      : `Step ${step.id}`;
  const reset = detectStepContextReset(prevStep, step);
  const tools = toolSummary(step.tools);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (step.status !== "running" || !step.expanded || !contentRef.current) return;
    contentRef.current.scrollTop = contentRef.current.scrollHeight;
  }, [step.status, step.expanded, step.output, step.reasoning, step.tools.length]);

  return (
    <>
    {reset ? <AgentStepContextResetBanner reset={reset} /> : null}
    <article className={`agent-step ${step.status}${reset ? " after-context-reset" : ""}${resumeAction ? " has-resume" : ""}`}>
      <div className="agent-step-header">
        <button className="agent-step-summary" onClick={onToggle} type="button" aria-expanded={step.expanded}>
          <span className="agent-step-indicator" />
          <strong>{label}</strong>
          <StepTokenBadge usage={step.usage} pending={step.status === "running"} />
          {tools ? (
            <span className="agent-step-tools" title={tools.title}>
              <span className="tool-chip">{tools.label}</span>
            </span>
          ) : null}
          <span className="agent-step-chevron" aria-hidden="true">
            {step.expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>
        {resumeAction ? (
          <button
            className="agent-step-resume"
            type="button"
            disabled={resumeAction.disabled}
            onClick={resumeAction.onClick}
            title="从中断处继续运行 Agent"
          >
            <RotateCw size={12} aria-hidden="true" />
            <span>续跑</span>
          </button>
        ) : null}
      </div>
      {step.expanded && (
        <div className="agent-step-content" ref={contentRef}>
          {reset ? (
            <div className="agent-step-context-reset-detail">
              <strong>重新装载</strong>
              <span>保留规则、索引、衔接</span>
              <span>卸下约 {formatGraphTokens(reset.before - reset.after)} 过程上下文</span>
            </div>
          ) : null}
          <div className="agent-step-usage-detail">
            {step.usage
              ? (
                <>
                  本步合计{step.usage.estimated ? "（含估算）" : ""}
                  {step.usage.model === "多个模型" || (step.usage.callBreakdown?.length ?? 0) > 1
                    ? " · 多模型"
                    : step.usage.model
                      ? ` · ${step.usage.model}`
                      : ""}
                  ：总计 {step.usage.totalTokens.toLocaleString()}
                  {" · "}
                  输入 {step.usage.promptTokens.toLocaleString()}
                  {" · "}输出 {pureOutputTokens(step.usage).toLocaleString()}
                  {step.usage.reasoningTokens !== undefined
                    ? ` · 推理 ${step.usage.reasoningTokens.toLocaleString()}`
                    : ""}
                  {" · "}缓存 {step.usage.cacheHitTokens.toLocaleString()}
                  {step.usage.cacheHitRate !== undefined
                    ? ` · 合计命中 ${(step.usage.cacheHitRate * 100).toFixed(1)}%`
                    : ""}
                  {formatDurationMs(step.usage.durationMs)
                    ? ` · 耗时 ${formatDurationMs(step.usage.durationMs)}`
                    : ""}
                  {step.usage.cost > 0
                    ? ` · ${step.usage.currency === "CNY" ? "¥" : "$"}${step.usage.cost.toFixed(6)}`
                    : ""}
                  {(step.usage.callBreakdown?.length ?? 0) > 1
                    ? "（展开查看各调用）"
                    : ""}
                </>
              )
              : "本步暂无 token 数据（供应商未返回 usage 且未能估算）"}
          </div>
          {step.usage && ((step.usage.callBreakdown?.length ?? 0) > 0 || step.usage.model) ? (
            <details className="agent-step-context-breakdown" open>
              <summary>
                模型调用明细
                {(step.usage.callBreakdown?.length ?? 0) > 1
                  ? `（${step.usage.callBreakdown!.length} 次）`
                  : ""}
              </summary>
              <div className="agent-step-context-list">
                {(step.usage.callBreakdown?.length
                  ? step.usage.callBreakdown
                  : [{
                      model: step.usage.model,
                      providerName: step.usage.providerName,
                      callKind: "本步汇总",
                      promptTokens: step.usage.promptTokens,
                      completionTokens: step.usage.completionTokens,
                      cacheHitTokens: step.usage.cacheHitTokens,
                      cacheMissTokens: step.usage.cacheMissTokens,
                      cost: step.usage.cost,
                      currency: step.usage.currency,
                      ...(step.usage.reasoningTokens !== undefined
                        ? { reasoningTokens: step.usage.reasoningTokens }
                        : {}),
                      ...(step.usage.durationMs !== undefined
                        ? { durationMs: step.usage.durationMs }
                        : {}),
                    }]).map((call, index) => {
                  const measured = call.cacheHitTokens + call.cacheMissTokens;
                  const rate = measured > 0 ? call.cacheHitTokens / measured : 0;
                  const kind = callKindLabel(call.callKind);
                  const pureOut = pureOutputTokens(call);
                  const duration = formatDurationMs(call.durationMs);
                  return (
                    <div className="agent-step-context-row agent-step-model-call-row" key={`${call.model ?? "unknown"}-${call.callKind}-${index}`}>
                      <div className="agent-step-model-call-heading">
                        <span className="agent-step-provider-chip" title={call.providerName?.trim() || "供应商信息未记录"}>
                          {shortProviderName(call.providerName)}
                        </span>
                        <strong title={call.model ?? "未知模型"}>{call.model && call.model !== "多个模型" ? call.model : "未知模型"}</strong>
                        <span title={call.callKind}>{kind}</span>
                        {duration ? <span className="agent-step-call-duration" title="本次模型调用耗时">{duration}</span> : null}
                      </div>
                      <div className="agent-step-model-call-metrics">
                        <span><small>总计</small>{(call.promptTokens + call.completionTokens).toLocaleString()}</span>
                        <span><small>输入</small>{call.promptTokens.toLocaleString()}</span>
                        <span title={call.reasoningTokens !== undefined ? `completion ${call.completionTokens.toLocaleString()} = 输出 ${pureOut.toLocaleString()} + 推理 ${call.reasoningTokens.toLocaleString()}` : undefined}>
                          <small>输出</small>{pureOut.toLocaleString()}
                        </span>
                        {call.reasoningTokens !== undefined
                          ? <span><small>推理</small>{call.reasoningTokens.toLocaleString()}</span>
                          : null}
                        <span><small>缓存</small>{call.cacheHitTokens.toLocaleString()} <em>{(rate * 100).toFixed(1)}%</em></span>
                        {duration
                          ? <span><small>耗时</small>{duration}</span>
                          : null}
                        {call.cost > 0
                          ? <span><small>费用</small>{call.currency === "CNY" ? "¥" : "$"}{call.cost.toFixed(6)}</span>
                          : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          ) : null}
          {step.usage?.requestComponents?.length ? (
            <details className="agent-step-context-breakdown">
              <summary>请求上下文组成（发送前估算）</summary>
              <div className="agent-step-context-list">
                {step.usage.requestComponents.map((component, index) => (
                  <div className="agent-step-context-row" key={`${component.callKind ?? "call"}-${component.kind}-${index}`}>
                    <span>
                      {component.callKind ? `${component.callKind} · ` : ""}
                      {component.label}
                      {component.fingerprint ? ` · #${component.fingerprint}` : ""}
                    </span>
                    <span>{component.estimatedTokens.toLocaleString()} tok · {component.characters.toLocaleString()} chars</span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {step.reasoning && (
            <div className="agent-step-reasoning">
              <Markdown content={step.reasoning} localLinksOnly onLocalLink={onLocalLink} />
            </div>
          )}
          {step.output && <Markdown content={step.output} localLinksOnly onLocalLink={onLocalLink} />}
          {!step.reasoning && !step.output && (
            <p className="agent-step-waiting">Waiting for model response…</p>
          )}
          {step.status === "running" && (step.reasoning || step.output) ? (
            <div className="agent-step-stream-status" role="status" aria-label="正在流式输出">
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </div>
          ) : null}
        </div>
      )}
    </article>
    </>
  );
}


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

export function mergeStepCallUsage(current: StepUsage | undefined, next: StepUsage, callKind = "unspecified"): StepUsage {
  const nextCalls: StepUsageCall[] = next.callBreakdown?.length
    ? next.callBreakdown
    : [{
        model: next.model,
        providerName: next.providerName,
        callKind,
        promptTokens: next.promptTokens,
        completionTokens: next.completionTokens,
        cacheHitTokens: next.cacheHitTokens,
        cacheMissTokens: next.cacheMissTokens,
        cost: next.cost,
        currency: next.currency,
        ...(next.estimated ? { estimated: true } : {}),
        ...(next.reasoningTokens !== undefined ? { reasoningTokens: next.reasoningTokens } : {}),
        ...(next.durationMs !== undefined ? { durationMs: next.durationMs } : {}),
      }];
  if (!current) return { ...next, callBreakdown: nextCalls };
  const cacheHitTokens = current.cacheHitTokens + next.cacheHitTokens;
  const cacheMissTokens = current.cacheMissTokens + next.cacheMissTokens;
  const estimated = Boolean(current.estimated || next.estimated);
  const models = [...new Set(
    [...(current.callBreakdown ?? []).map(call => call.model), ...nextCalls.map(call => call.model), current.model, next.model]
      .filter((value): value is string => Boolean(value) && value !== "多个模型"),
  )];
  const providers = [...new Set(
    [...(current.callBreakdown ?? []).map(call => call.providerName), ...nextCalls.map(call => call.providerName), current.providerName, next.providerName]
      .filter((value): value is string => Boolean(value?.trim())),
  )];
  const hasReasoning = current.reasoningTokens !== undefined || next.reasoningTokens !== undefined
    || nextCalls.some(call => call.reasoningTokens !== undefined)
    || (current.callBreakdown ?? []).some(call => call.reasoningTokens !== undefined);
  const hasDuration = current.durationMs !== undefined || next.durationMs !== undefined
    || nextCalls.some(call => call.durationMs !== undefined)
    || (current.callBreakdown ?? []).some(call => call.durationMs !== undefined);
  return {
    model: models.length <= 1 ? (models[0] ?? current.model ?? next.model) : "多个模型",
    ...(providers.length
      ? { providerName: providers.length === 1 ? providers[0] : providers.join(",") }
      : {}),
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    cacheHitTokens,
    cacheMissTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    cost: current.cost + next.cost,
    currency: current.cost > 0 ? current.currency : next.currency,
    ...(estimated ? { estimated: true } : {}),
    ...(!estimated && cacheHitTokens + cacheMissTokens > 0
      ? { cacheHitRate: cacheHitTokens / (cacheHitTokens + cacheMissTokens) }
      : {}),
    ...(hasReasoning
      ? { reasoningTokens: (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) }
      : {}),
    ...(hasDuration
      ? { durationMs: (current.durationMs ?? 0) + (next.durationMs ?? 0) }
      : {}),
    requestComponents: [...(current.requestComponents ?? []), ...(next.requestComponents ?? [])],
    callBreakdown: [...(current.callBreakdown ?? []), ...nextCalls],
  };
}
