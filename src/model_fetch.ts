import { setTimeout as delay } from "node:timers/promises";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { ModelConfig } from "./types.js";
import {
  ProviderError,
  providerErrorCodeFromHttp,
  providerErrorFromUnknown,
} from "./provider_error.js";

const proxyAgents = new Map<string, ProxyAgent>();

/** Default in-flight provider requests per concurrency key when not configured. */
export const DEFAULT_PROVIDER_MAX_CONCURRENT = 5;
export const PROVIDER_MAX_CONCURRENT_MIN = 1;
export const PROVIDER_MAX_CONCURRENT_MAX = 64;
export const DEFAULT_PROVIDER_MAX_RETRIES = 3;
export const DEFAULT_PROVIDER_QUEUE_TIMEOUT_MS = 600_000;

export type RequestPriority = "high" | "normal" | "low";

export type ProviderTransportStatus = {
  phase: "queued" | "rate_limited" | "retrying" | "circuit_open" | "dispatched";
  key: string;
  position?: number;
  attempt?: number;
  maxAttempts?: number;
  waitMs?: number;
  message?: string;
};

export type ModelFetchOptions = {
  proxyUrl?: string;
  /**
   * Stable pool key. Prefer provider profile id (`provider:<uuid>`).
   * When omitted, modelFetch derives a host key from the request URL.
   */
  concurrencyKey?: string;
  /** Max concurrent in-flight HTTP requests for this key. Default 5. */
  maxConcurrent?: number;
  /** Optional requests-per-minute cap for this key (sliding window). */
  maxRpm?: number;
  /** Queue fairness: high jump ahead of normal/low when a slot frees. */
  priority?: RequestPriority;
  /** Transport retries for 429/5xx/network (default 3). Set 0 to disable. */
  maxRetries?: number;
  /** Max time to wait in the concurrency queue (default 10 min). */
  queueTimeoutMs?: number;
  /**
   * Skip the concurrency gate (OAuth token refresh, health probes that must not
   * queue behind long completions). Prefer leaving this off.
   */
  bypassConcurrency?: boolean;
  /** Skip retry/circuit (raw one-shot probe). */
  bypassResilience?: boolean;
  /** Observation hook for UI/SSE (queued / retrying / circuit open). */
  onStatus?: (status: ProviderTransportStatus) => void;
};

type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  priority: number;
  enqueuedAt: number;
};

const PRIORITY_RANK: Record<RequestPriority, number> = { high: 0, normal: 1, low: 2 };

/**
 * Per-provider semaphore with priority queue. Slot is held from request start
 * until the response body is fully consumed or cancelled.
 */
class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private limit: number;

  constructor(limit: number) {
    this.limit = normalizeMaxConcurrent(limit);
  }

  get stats(): { active: number; waiting: number; limit: number } {
    return { active: this.active, waiting: this.waiters.length, limit: this.limit };
  }

  setLimit(limit: number): void {
    this.limit = normalizeMaxConcurrent(limit);
    this.pump();
  }

  queuePosition(priority: RequestPriority): number {
    if (this.active < this.limit) return 0;
    const rank = PRIORITY_RANK[priority];
    let ahead = 0;
    for (const waiter of this.waiters) {
      if (waiter.priority <= rank) ahead += 1;
    }
    return ahead + 1;
  }

  async acquire(
    signal?: AbortSignal,
    priority: RequestPriority = "normal",
    queueTimeoutMs = DEFAULT_PROVIDER_QUEUE_TIMEOUT_MS,
  ): Promise<() => void> {
    if (signal?.aborted) throw abortAsProviderError(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseOnce();
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          signal,
          priority: PRIORITY_RANK[priority],
          enqueuedAt: Date.now(),
        };
        if (signal) {
          waiter.onAbort = () => {
            this.removeWaiter(waiter);
            reject(abortAsProviderError(signal));
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        if (queueTimeoutMs > 0) {
          timeoutId = setTimeout(() => {
            this.removeWaiter(waiter);
            reject(new ProviderError(
              "PROVIDER_QUEUE_TIMEOUT",
              `供应商并发队列等待超时（${Math.round(queueTimeoutMs / 1000)}s）`,
              { retryable: true },
            ));
          }, queueTimeoutMs);
        }
        this.insertWaiter(waiter);
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    return this.releaseOnce();
  }

  private insertWaiter(waiter: Waiter): void {
    let index = this.waiters.length;
    for (let i = 0; i < this.waiters.length; i += 1) {
      const current = this.waiters[i];
      if (waiter.priority < current.priority
        || (waiter.priority === current.priority && waiter.enqueuedAt < current.enqueuedAt)) {
        index = i;
        break;
      }
    }
    this.waiters.splice(index, 0, waiter);
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  private releaseSlot(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      if (next.signal?.aborted) {
        next.reject(abortAsProviderError(next.signal));
        continue;
      }
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      if (next.onAbort && next.signal) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      if (next.signal?.aborted) {
        next.reject(abortAsProviderError(next.signal));
        continue;
      }
      this.active += 1;
      next.resolve();
    }
  }
}

/** Sliding-window requests-per-minute limiter. */
class RpmLimiter {
  private timestamps: number[] = [];
  private limit: number;

  constructor(limit: number) {
    this.limit = Math.max(0, Math.round(limit));
  }

  setLimit(limit: number): void {
    this.limit = Math.max(0, Math.round(limit));
  }

  get stats(): { limit: number; used: number } {
    this.prune(Date.now());
    return { limit: this.limit, used: this.timestamps.length };
  }

  async wait(signal?: AbortSignal, onWait?: (waitMs: number) => void): Promise<void> {
    if (this.limit <= 0) return;
    while (true) {
      if (signal?.aborted) throw abortAsProviderError(signal);
      const now = Date.now();
      this.prune(now);
      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = Math.max(50, this.timestamps[0]! + 60_000 - now + 10);
      onWait?.(waitMs);
      await delay(waitMs, undefined, { signal }).catch((error) => {
        throw providerErrorFromUnknown(error, "PROVIDER_ABORTED");
      });
    }
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    while (this.timestamps.length && this.timestamps[0]! < cutoff) this.timestamps.shift();
  }
}

type CircuitState = "closed" | "open" | "half_open";

class CircuitBreaker {
  private failures = 0;
  private state: CircuitState = "closed";
  private openedAt = 0;
  private halfOpenInFlight = false;
  private readonly failureThreshold: number;
  private readonly openMs: number;

  constructor(failureThreshold = 5, openMs = 30_000) {
    this.failureThreshold = failureThreshold;
    this.openMs = openMs;
  }

  get stats(): { state: CircuitState; failures: number; openRemainingMs: number } {
    this.maybeHalfOpen();
    const openRemainingMs = this.state === "open"
      ? Math.max(0, this.openedAt + this.openMs - Date.now())
      : 0;
    return { state: this.state, failures: this.failures, openRemainingMs };
  }

  assertClosed(key: string): void {
    this.maybeHalfOpen();
    if (this.state === "open") {
      const waitMs = Math.max(0, this.openedAt + this.openMs - Date.now());
      throw new ProviderError(
        "PROVIDER_CIRCUIT_OPEN",
        `供应商熔断开启，约 ${Math.ceil(waitMs / 1000)}s 后半开探测`,
        { retryable: true, providerKey: key, retryAfterMs: waitMs },
      );
    }
    if (this.state === "half_open" && this.halfOpenInFlight) {
      throw new ProviderError(
        "PROVIDER_CIRCUIT_OPEN",
        "供应商熔断半开探测进行中，请稍后重试",
        { retryable: true, providerKey: key, retryAfterMs: 1_000 },
      );
    }
  }

  /** Mark half-open probe in-flight only once the HTTP attempt actually starts. */
  beginAttempt(): void {
    if (this.state === "half_open") this.halfOpenInFlight = true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
    this.halfOpenInFlight = false;
  }

  recordFailure(countsTowardCircuit: boolean): void {
    this.halfOpenInFlight = false;
    if (!countsTowardCircuit) return;
    this.failures += 1;
    if (this.state === "half_open" || this.failures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
      metrics.circuitOpens += 1;
    }
  }

  private maybeHalfOpen(): void {
    if (this.state === "open" && Date.now() - this.openedAt >= this.openMs) {
      this.state = "half_open";
      this.halfOpenInFlight = false;
    }
  }
}

type KeyRuntime = {
  gate: ConcurrencyGate;
  rpm: RpmLimiter;
  circuit: CircuitBreaker;
};

const runtimes = new Map<string, KeyRuntime>();
const registeredLimits = new Map<string, number>();
const registeredRpm = new Map<string, number>();

type TransportMetrics = {
  requests: number;
  successes: number;
  failures: number;
  retries: number;
  rateLimitHits: number;
  circuitOpens: number;
  totalQueueWaitMs: number;
  lastErrorAt?: string;
  lastErrorCode?: string;
};

const metrics: TransportMetrics = {
  requests: 0,
  successes: 0,
  failures: 0,
  retries: 0,
  rateLimitHits: 0,
  circuitOpens: 0,
  totalQueueWaitMs: 0,
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export function normalizeMaxConcurrent(value: unknown): number {
  const fallback = envInt("WRITER_PROVIDER_MAX_CONCURRENT", DEFAULT_PROVIDER_MAX_CONCURRENT);
  if (typeof value !== "number" || !Number.isFinite(value)) return clamp(fallback, PROVIDER_MAX_CONCURRENT_MIN, PROVIDER_MAX_CONCURRENT_MAX);
  return clamp(Math.round(value), PROVIDER_MAX_CONCURRENT_MIN, PROVIDER_MAX_CONCURRENT_MAX);
}

export function normalizeMaxRpm(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded <= 0) return undefined;
  return clamp(rounded, 1, 10_000);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function registerProviderConcurrency(profile: {
  id: string;
  baseUrl: string;
  maxConcurrent?: number;
  maxRpm?: number;
}): void {
  const limit = normalizeMaxConcurrent(profile.maxConcurrent);
  const rpm = normalizeMaxRpm(profile.maxRpm);
  const keys = [providerConcurrencyKey(profile.id), hostConcurrencyKey(profile.baseUrl)].filter(
    (key): key is string => Boolean(key),
  );
  for (const key of keys) {
    registeredLimits.set(key, limit);
    if (rpm !== undefined) registeredRpm.set(key, rpm);
    else registeredRpm.delete(key);
    const runtime = runtimes.get(key);
    if (runtime) {
      runtime.gate.setLimit(limit);
      runtime.rpm.setLimit(rpm ?? 0);
    }
  }
}

export function syncProviderConcurrencyRegistry(
  profiles: ReadonlyArray<{ id: string; baseUrl: string; maxConcurrent?: number; maxRpm?: number }>,
): void {
  registeredLimits.clear();
  registeredRpm.clear();
  for (const profile of profiles) registerProviderConcurrency(profile);
}

export function providerConcurrencyKey(providerId: string): string {
  return `provider:${providerId.trim()}`;
}

export function hostConcurrencyKey(baseUrlOrEndpoint: string): string | undefined {
  try {
    const url = new URL(baseUrlOrEndpoint.includes("://") ? baseUrlOrEndpoint : `https://${baseUrlOrEndpoint}`);
    return `host:${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

function resolveConcurrencyKey(input: string | URL, explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) {
    return trimmed.startsWith("provider:") || trimmed.startsWith("host:") || trimmed.startsWith("raw:")
      ? trimmed
      : providerConcurrencyKey(trimmed);
  }
  return hostConcurrencyKey(String(input)) ?? `raw:${String(input)}`;
}

function getRuntime(key: string, maxConcurrent: number, maxRpm: number): KeyRuntime {
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = {
      gate: new ConcurrencyGate(maxConcurrent),
      rpm: new RpmLimiter(maxRpm),
      circuit: new CircuitBreaker(
        envInt("WRITER_PROVIDER_CIRCUIT_FAILURES", 5),
        envInt("WRITER_PROVIDER_CIRCUIT_OPEN_MS", 30_000),
      ),
    };
    runtimes.set(key, runtime);
  } else {
    runtime.gate.setLimit(maxConcurrent);
    runtime.rpm.setLimit(maxRpm);
  }
  return runtime;
}

function resolveMaxConcurrent(key: string, explicit?: number): number {
  if (explicit !== undefined) return normalizeMaxConcurrent(explicit);
  return registeredLimits.get(key) ?? normalizeMaxConcurrent(undefined);
}

function resolveMaxRpm(key: string, explicit?: number): number {
  if (explicit !== undefined) return normalizeMaxRpm(explicit) ?? 0;
  return registeredRpm.get(key)
    ?? normalizeMaxRpm(envInt("WRITER_PROVIDER_MAX_RPM", 0))
    ?? 0;
}

function abortAsProviderError(signal?: AbortSignal): ProviderError {
  const reason = signal && "reason" in signal ? signal.reason : undefined;
  if (reason instanceof ProviderError) return reason;
  if (reason instanceof Error) {
    return new ProviderError("PROVIDER_ABORTED", reason.message || "请求已取消", { cause: reason, retryable: false });
  }
  return new ProviderError(
    "PROVIDER_ABORTED",
    typeof reason === "string" && reason ? reason : "请求已取消",
    { retryable: false },
  );
}

function attachRelease(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  let released = false;
  const once = () => {
    if (released) return;
    released = true;
    release();
  };
  const source = response.body;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        once();
      }
    },
    cancel(reason) {
      once();
      return source.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function normalizeFetchOptions(proxyUrlOrOptions?: string | ModelFetchOptions): ModelFetchOptions {
  if (proxyUrlOrOptions == null) return {};
  if (typeof proxyUrlOrOptions === "string") return { proxyUrl: proxyUrlOrOptions };
  return proxyUrlOrOptions;
}

export function modelRequestOptions(
  model: Pick<ModelConfig, "proxyUrl" | "providerId" | "baseUrl" | "maxConcurrent" | "maxRpm" | "requestPriority">,
  extra?: Partial<ModelFetchOptions>,
): ModelFetchOptions {
  return {
    proxyUrl: model.proxyUrl,
    concurrencyKey: model.providerId
      ? providerConcurrencyKey(model.providerId)
      : hostConcurrencyKey(model.baseUrl),
    maxConcurrent: model.maxConcurrent,
    maxRpm: model.maxRpm,
    priority: model.requestPriority ?? "normal",
    ...extra,
  };
}

export function providerConcurrencySnapshot(): Array<{
  key: string;
  active: number;
  waiting: number;
  limit: number;
  rpmLimit: number;
  rpmUsed: number;
  circuit: CircuitState;
  circuitFailures: number;
  circuitOpenRemainingMs: number;
}> {
  return [...runtimes.entries()]
    .map(([key, runtime]) => ({
      key,
      ...runtime.gate.stats,
      rpmLimit: runtime.rpm.stats.limit,
      rpmUsed: runtime.rpm.stats.used,
      circuit: runtime.circuit.stats.state,
      circuitFailures: runtime.circuit.stats.failures,
      circuitOpenRemainingMs: runtime.circuit.stats.openRemainingMs,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function providerTransportMetrics(): TransportMetrics & { keys: number } {
  return { ...metrics, keys: runtimes.size };
}

export function resetProviderConcurrencyForTests(): void {
  runtimes.clear();
  registeredLimits.clear();
  registeredRpm.clear();
  metrics.requests = 0;
  metrics.successes = 0;
  metrics.failures = 0;
  metrics.retries = 0;
  metrics.rateLimitHits = 0;
  metrics.circuitOpens = 0;
  metrics.totalQueueWaitMs = 0;
  delete metrics.lastErrorAt;
  delete metrics.lastErrorCode;
}

function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.min(120_000, asNumber * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(120_000, Math.max(0, date - Date.now()));
  return undefined;
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return retryAfterMs;
  const base = 500 * (2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(30_000, base + jitter);
}

function shouldCountTowardCircuit(status?: number, code?: string): boolean {
  if (code === "PROVIDER_AUTH" || code === "PROVIDER_CONFIG" || code === "PROVIDER_ABORTED") return false;
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 425 && status !== 429) {
    return false;
  }
  return true;
}

async function rawFetch(
  input: string | URL,
  init: RequestInit,
  proxyUrl?: string,
): Promise<Response> {
  const normalizedProxy = normalizeProxyUrl(proxyUrl);
  if (!normalizedProxy) return fetch(input, init);
  let dispatcher = proxyAgents.get(normalizedProxy);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(normalizedProxy);
    proxyAgents.set(normalizedProxy, dispatcher);
  }
  return undiciFetch(input, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

/** Fetch a model-provider endpoint with concurrency, RPM, retry and circuit breaking. */
export async function modelFetch(
  input: string | URL,
  init: RequestInit = {},
  proxyUrlOrOptions?: string | ModelFetchOptions,
): Promise<Response> {
  const options = normalizeFetchOptions(proxyUrlOrOptions);
  const signal = init.signal ?? undefined;

  if (options.bypassConcurrency && options.bypassResilience) {
    return rawFetch(input, init, options.proxyUrl);
  }

  const key = resolveConcurrencyKey(input, options.concurrencyKey);
  const maxConcurrent = resolveMaxConcurrent(key, options.maxConcurrent);
  const maxRpm = resolveMaxRpm(key, options.maxRpm);
  const runtime = getRuntime(key, maxConcurrent, maxRpm);
  const priority = options.priority ?? "normal";
  const maxRetries = options.bypassResilience
    ? 0
    : clamp(
      options.maxRetries ?? envInt("WRITER_PROVIDER_MAX_RETRIES", DEFAULT_PROVIDER_MAX_RETRIES),
      0,
      8,
    );
  const queueTimeoutMs = options.queueTimeoutMs
    ?? envInt("WRITER_PROVIDER_QUEUE_TIMEOUT_MS", DEFAULT_PROVIDER_QUEUE_TIMEOUT_MS);
  const maxAttempts = maxRetries + 1;
  metrics.requests += 1;

  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) throw abortAsProviderError(signal);

    if (!options.bypassResilience) {
      try {
        runtime.circuit.assertClosed(key);
      } catch (error) {
        if (error instanceof ProviderError && error.code === "PROVIDER_CIRCUIT_OPEN") {
          options.onStatus?.({
            phase: "circuit_open",
            key,
            waitMs: error.retryAfterMs,
            message: error.message,
          });
          metrics.failures += 1;
          metrics.lastErrorAt = new Date().toISOString();
          metrics.lastErrorCode = error.code;
          throw error;
        }
        throw error;
      }
    }

    if (!options.bypassConcurrency) {
      await runtime.rpm.wait(signal, (waitMs) => {
        metrics.rateLimitHits += 1;
        options.onStatus?.({
          phase: "rate_limited",
          key,
          waitMs,
          message: `达到 RPM 上限，等待 ${Math.ceil(waitMs / 1000)}s`,
        });
      });
    }

    let release: (() => void) | undefined;
    if (!options.bypassConcurrency) {
      const position = runtime.gate.queuePosition(priority);
      if (position > 0) {
        options.onStatus?.({
          phase: "queued",
          key,
          position,
          message: `供应商并发队列中（第 ${position} 位）`,
        });
      }
      const waitStarted = Date.now();
      release = await runtime.gate.acquire(signal, priority, queueTimeoutMs);
      metrics.totalQueueWaitMs += Math.max(0, Date.now() - waitStarted);
    }

    options.onStatus?.({
      phase: attempt > 0 ? "retrying" : "dispatched",
      key,
      attempt: attempt + 1,
      maxAttempts,
      message: attempt > 0 ? `重试供应商请求（${attempt + 1}/${maxAttempts}）` : undefined,
    });

    try {
      if (!options.bypassResilience) runtime.circuit.beginAttempt();
      const response = await rawFetch(input, init, options.proxyUrl);
      if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt >= maxAttempts - 1 || options.bypassResilience) {
        if (response.ok) {
          runtime.circuit.recordSuccess();
          metrics.successes += 1;
        } else {
          runtime.circuit.recordFailure(shouldCountTowardCircuit(response.status));
          if (!response.ok) {
            metrics.failures += 1;
            metrics.lastErrorAt = new Date().toISOString();
            metrics.lastErrorCode = providerErrorCodeFromHttp(response.status);
          }
        }
        return release ? attachRelease(response, release) : response;
      }

      // Retryable HTTP status: drain body, release slot, backoff.
      const retryAfterMs = parseRetryAfterMs(response);
      const bodySnippet = (await response.text().catch(() => "")).slice(0, 200);
      release?.();
      release = undefined;
      runtime.circuit.recordFailure(shouldCountTowardCircuit(response.status));
      metrics.retries += 1;
      if (response.status === 429) metrics.rateLimitHits += 1;
      lastError = new ProviderError(
        providerErrorCodeFromHttp(response.status, bodySnippet),
        `模型请求失败（${response.status}）：${bodySnippet || response.statusText}`,
        {
          httpStatus: response.status,
          providerKey: key,
          attempt: attempt + 1,
          retryAfterMs,
          retryable: true,
        },
      );
      const waitMs = backoffMs(attempt, retryAfterMs);
      options.onStatus?.({
        phase: "retrying",
        key,
        attempt: attempt + 1,
        maxAttempts,
        waitMs,
        message: lastError.message,
      });
      await delay(waitMs, undefined, { signal }).catch((error) => {
        throw providerErrorFromUnknown(error, "PROVIDER_ABORTED");
      });
      continue;
    } catch (error) {
      release?.();
      if (error instanceof ProviderError && error.code === "PROVIDER_ABORTED") throw error;
      if (error instanceof Error && error.name === "AbortError") throw abortAsProviderError(signal);
      const mapped = providerErrorFromUnknown(error, "PROVIDER_NETWORK");
      runtime.circuit.recordFailure(shouldCountTowardCircuit(undefined, mapped.code));
      lastError = mapped;
      if (attempt >= maxAttempts - 1 || options.bypassResilience) {
        metrics.failures += 1;
        metrics.lastErrorAt = new Date().toISOString();
        metrics.lastErrorCode = mapped.code;
        throw mapped;
      }
      metrics.retries += 1;
      const waitMs = backoffMs(attempt);
      options.onStatus?.({
        phase: "retrying",
        key,
        attempt: attempt + 1,
        maxAttempts,
        waitMs,
        message: mapped.message,
      });
      await delay(waitMs, undefined, { signal }).catch((err) => {
        throw providerErrorFromUnknown(err, "PROVIDER_ABORTED");
      });
    }
  }

  metrics.failures += 1;
  metrics.lastErrorAt = new Date().toISOString();
  metrics.lastErrorCode = lastError?.code ?? "PROVIDER_NETWORK";
  throw lastError ?? new ProviderError("PROVIDER_NETWORK", "供应商请求失败", { providerKey: key });
}

export function normalizeProxyUrl(value?: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `http://${text}`);
  } catch {
    throw new ProviderError("PROVIDER_CONFIG", "代理地址格式无效", { retryable: false });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError("PROVIDER_CONFIG", "代理地址仅支持 HTTP 或 HTTPS 协议", { retryable: false });
  }
  if (!url.hostname || !url.port) {
    throw new ProviderError("PROVIDER_CONFIG", "代理地址必须包含主机和端口", { retryable: false });
  }
  return url.toString().replace(/\/$/, "");
}

/** Throw a typed ProviderError for a non-OK completion response body. */
export function throwProviderHttpError(status: number, body: string, providerKey?: string): never {
  const snippet = body.slice(0, 600);
  const code = providerErrorCodeFromHttp(status, snippet);
  throw new ProviderError(code, `模型请求失败（${status}）：${snippet}`, {
    httpStatus: status,
    providerKey,
    retryable: RETRYABLE_STATUS.has(status),
  });
}
