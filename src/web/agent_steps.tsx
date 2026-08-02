import React, { useEffect, useRef } from "react";
import { RotateCw } from "lucide-react";
import type { MessageStepTrail, StepUsage, StepUsageCall, StoredStepTrail, StreamStep, Usage } from "./types";
import { callKindLabel } from "./types";
import { Markdown } from "./markdown";
import { formatGraphTokens, shortProviderName } from "./format_utils";

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
  const parts = [
    usage.estimated ? "估算" : null,
    multi ? "多模型合计" : usage.model ?? null,
    `输入 ${usage.promptTokens.toLocaleString()}`,
    `输出 ${usage.completionTokens.toLocaleString()}`,
    `缓存命中 ${usage.cacheHitTokens.toLocaleString()}`,
    cache.primary !== undefined && multi
      ? `Agent 主步命中率 ${(cache.primary * 100).toFixed(1)}%`
      : null,
    cache.total !== undefined
      ? `${multi ? "全调用合计命中率" : "命中率"} ${(cache.total * 100).toFixed(1)}%`
      : null,
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
      <span className="tok-metric tok-out" title={`输出 ${usage.completionTokens.toLocaleString()}`}>
        <span className="tok-ico" aria-hidden="true">O</span>
        {formatTokenCount(usage.completionTokens)}
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
  const plain = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#`|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "（空回复）";
  return plain.length <= max ? plain : `${plain.slice(0, max)}…`;
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
  const likelyBoundary = /propose_document|propose_chapter|write_chapter_scene|write_document/.test(prevTools)
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
  return (
    <div
      className="agent-step-context-reset"
      title="完成一章或一场后会收束上下文：保留稳定规则、项目索引与章节衔接，丢弃上一章的过程细节。之后若再读设定或前章，属于按需补充，属正常行为。"
    >
      <span className="agent-step-context-reset-badge">
        <span className="agent-step-context-reset-indicator" aria-hidden="true" />
        上下文已收束
      </span>
      <span className="agent-step-context-reset-flow">
        <span>步骤</span>
        <strong>{reset.fromStep} → {reset.toStep}</strong>
      </span>
      <span className="agent-step-context-reset-tokens">
        <span>上下文</span>
        <strong>
          {formatGraphTokens(reset.before)} → {formatGraphTokens(reset.after)}
        </strong>
      </span>
      <span className="agent-step-context-reset-saved">
        减少 {formatGraphTokens(saved)}
      </span>
      <span className="agent-step-context-reset-hint">
        章节边界 · 保留规则与衔接 · 移除过程上下文
      </span>
    </div>
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
      : step.status === "running"
      ? `Step ${step.id}`
      : step.status === "failed"
        ? `Step ${step.id} failed`
        : `Step ${step.id} done`;
  const reset = detectStepContextReset(prevStep, step);
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
          {step.tools.length > 0 && (() => {
            const maxVisible = 2;
            const visible = step.tools.slice(0, maxVisible);
            const hidden = step.tools.length - visible.length;
            const allTitle = step.tools.join(" · ");
            return (
              <span className="agent-step-tools" title={allTitle}>
                {visible.map((tool, index) => (
                  <span className="tool-chip" key={`${step.id}-${index}-${tool}`} title={tool}>
                    {tool}
                  </span>
                ))}
                {hidden > 0 && (
                  <span className="tool-chip tool-chip-more" title={step.tools.slice(maxVisible).join(" · ")}>
                    +{hidden}
                  </span>
                )}
              </span>
            );
          })()}
          <span className="agent-step-chevron" aria-hidden="true">
            {step.expanded ? "▴" : "▾"}
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
              <strong>本章节起重新装载的上下文</strong>
              <ul>
                <li>写作规则与项目索引（跨章可复用）</li>
                <li>当前任务说明与上一章/场的衔接摘要</li>
                <li>
                  已卸下约 {formatGraphTokens(reset.before - reset.after)} 的过程痕迹
                  （草稿全文、重试与中间工具结果）
                </li>
                <li>
                  若随后仍读取设定或前章：索引不含全文细节，按需补充属正常
                </li>
              </ul>
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
                  {" · "}输出 {step.usage.completionTokens.toLocaleString()}
                  {" · "}缓存 {step.usage.cacheHitTokens.toLocaleString()}
                  {step.usage.cacheHitRate !== undefined
                    ? ` · 合计命中 ${(step.usage.cacheHitRate * 100).toFixed(1)}%`
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
                    }]).map((call, index) => {
                  const measured = call.cacheHitTokens + call.cacheMissTokens;
                  const rate = measured > 0 ? call.cacheHitTokens / measured : 0;
                  const kind = callKindLabel(call.callKind);
                  return (
                    <div className="agent-step-context-row agent-step-model-call-row" key={`${call.model ?? "unknown"}-${call.callKind}-${index}`}>
                      <div className="agent-step-model-call-heading">
                        <span className="agent-step-provider-chip" title={call.providerName?.trim() || "供应商信息未记录"}>
                          {shortProviderName(call.providerName)}
                        </span>
                        <strong title={call.model ?? "未知模型"}>{call.model && call.model !== "多个模型" ? call.model : "未知模型"}</strong>
                        <span title={call.callKind}>{kind}</span>
                      </div>
                      <div className="agent-step-model-call-metrics">
                        <span><small>总计</small>{(call.promptTokens + call.completionTokens).toLocaleString()}</span>
                        <span><small>输入</small>{call.promptTokens.toLocaleString()}</span>
                        <span><small>输出</small>{call.completionTokens.toLocaleString()}</span>
                        <span><small>缓存</small>{call.cacheHitTokens.toLocaleString()} <em>{(rate * 100).toFixed(1)}%</em></span>
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
    requestComponents: [...(current.requestComponents ?? []), ...(next.requestComponents ?? [])],
    callBreakdown: [...(current.callBreakdown ?? []), ...nextCalls],
  };
}
