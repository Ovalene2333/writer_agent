/** 局域网 / Cloudflare 双通道：扫一次码后按可达性自动切换 API 基址。 */

export type ConnectionRoute = "lan" | "public" | "local";
/** 用户偏好：自动择优，或锁定某一通道。 */
export type ConnectionPreference = "auto" | "lan" | "public";
export type ConnectionProbeResult = {
  status: "ok" | "unreachable" | "blocked" | "unconfigured";
  latencyMs: number | null;
};
export type ConnectionProbeResults = Record<"lan" | "public", ConnectionProbeResult>;

export type ConnectionInfo = {
  route: ConnectionRoute;
  label: string;
  dualMode: boolean;
  base: string;
  lanBase: string | null;
  publicBase: string | null;
  preference: ConnectionPreference;
  /** 当前页是 HTTPS 时无法探测/调用局域网 HTTP（混合内容），仅能走公网。 */
  lanBlockedByMixedContent: boolean;
};

type StoredConnection = {
  token: string;
  tokenless?: boolean;
  lanBase?: string;
  publicBase?: string;
  preference?: ConnectionPreference;
};

const STORAGE_KEY = "writer-connection-v1";
const TOKEN_KEY = "writer-token";
const PROBE_MS = 1200;
const MONITOR_MS = 4000;

type Listener = (info: ConnectionInfo) => void;

let token = "";
let tokenless = false;
let lanBase: string | null = null;
let publicBase: string | null = null;
let activeBase = "";
let route: ConnectionRoute = "local";
let preference: ConnectionPreference = "auto";
let selecting: Promise<void> | null = null;
const listeners = new Set<Listener>();

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, "");
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Quick Tunnel 或 Named Tunnel 固定公网 HTTPS 源（非本机回环）。 */
function isPublicTunnelUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return Boolean(host)
      && host !== "localhost"
      && host !== "127.0.0.1"
      && host !== "[::1]";
  } catch {
    return false;
  }
}

function isLoopbackBase(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** HTTPS 页面不能 fetch HTTP 局域网（浏览器混合内容拦截）。 */
export function canFetchBase(base: string): boolean {
  try {
    const url = new URL(base);
    if (typeof location !== "undefined" && location.protocol === "https:" && url.protocol === "http:") {
      return false;
    }
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function timeoutSignal(ms: number): AbortSignal {
  const AbortSignalWithTimeout = AbortSignal as typeof AbortSignal & {
    timeout?: (delay: number) => AbortSignal;
  };
  if (typeof AbortSignalWithTimeout.timeout === "function") {
    return AbortSignalWithTimeout.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function readStored(): StoredConnection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredConnection;
    if (!parsed || typeof parsed.token !== "string" || (!parsed.token && parsed.tokenless !== true)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(data: StoredConnection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode / quota */
  }
}

function routeLabel(next: ConnectionRoute): string {
  if (next === "lan") return "局域网";
  if (next === "public") return "公网";
  return "本机";
}

function currentInfo(): ConnectionInfo {
  const dualMode = Boolean(lanBase && publicBase);
  const lanBlockedByMixedContent = Boolean(
    lanBase && publicBase && !canFetchBase(lanBase) && canFetchBase(publicBase),
  );
  return {
    route,
    label: routeLabel(route),
    dualMode,
    base: activeBase || (typeof location !== "undefined" ? location.origin : ""),
    lanBase,
    publicBase,
    preference,
    lanBlockedByMixedContent,
  };
}

function persist(): void {
  if (!token && !tokenless) return;
  writeStored({
    token,
    ...(tokenless ? { tokenless: true } : {}),
    ...(lanBase ? { lanBase } : {}),
    ...(publicBase ? { publicBase } : {}),
    preference,
  });
}

function emit(): void {
  const info = currentInfo();
  for (const listener of listeners) listener(info);
}

function setRoute(next: ConnectionRoute, base: string): void {
  const normalized = normalizeBase(base);
  if (route === next && activeBase === normalized) return;
  route = next;
  activeBase = normalized;
  emit();
}

function parseBootstrapHash(): { token?: string; tokenless?: boolean; lan?: string; public?: string } {
  const hash = typeof location !== "undefined" ? location.hash.slice(1) : "";
  if (!hash) return {};
  const params = new URLSearchParams(hash);
  const tokenValue = params.get("token")?.trim() || undefined;
  const lan = params.get("lan")?.trim() || undefined;
  const pub = params.get("public")?.trim() || undefined;
  return {
    token: tokenValue,
    tokenless: params.get("auth") === "none",
    lan: lan && isHttpUrl(lan) ? normalizeBase(lan) : undefined,
    public: pub && isPublicTunnelUrl(pub) ? new URL(pub).origin : undefined,
  };
}

/**
 * 从 URL hash / localStorage 恢复连接配置。
 * hash 形态：`#token=...&public=https://xxx.trycloudflare.com`（局域网入口）
 * 或 `#token=...&lan=http://192.168.x.x:4096`（公网入口）。
 * Named Tunnel 固定域名同样走 public=https://your.domain。
 */
export function initConnection(): string {
  const boot = parseBootstrapHash();
  const stored = readStored();
  const pageOrigin = typeof location !== "undefined" ? normalizeBase(location.origin) : "";
  const pageIsLocal = isLoopbackBase(pageOrigin);
  const hasBootstrap = Boolean(boot.token || boot.tokenless || boot.lan || boot.public);
  // A plain loopback URL is the dedicated no-token entry. Do not revive stale
  // LAN/tunnel routing from an earlier QR-code session on this origin.
  const restoreStoredConnection = !pageIsLocal || hasBootstrap;

  tokenless = boot.tokenless === true
    || (!boot.token && restoreStoredConnection && stored?.tokenless === true);
  token = tokenless ? "" : boot.token
    || (restoreStoredConnection ? stored?.token : "")
    || (restoreStoredConnection ? localStorage.getItem(TOKEN_KEY) : "")
    || (restoreStoredConnection ? sessionStorage.getItem(TOKEN_KEY) : "")
    || "";

  const pageIsLan = pageOrigin.startsWith("http://") && !/localhost|127\.0\.0\.1/i.test(pageOrigin);
  // HTTPS 非回环页视为公网入口（trycloudflare 临时域或 Named Tunnel 固定域）。
  const pageIsTunnel = typeof location !== "undefined"
    && location.protocol === "https:"
    && !pageIsLocal;

  lanBase = boot.lan
    || (pageIsLan ? pageOrigin : null)
    || (restoreStoredConnection ? stored?.lanBase : undefined)
    || null;

  publicBase = boot.public
    || (pageIsTunnel ? pageOrigin : null)
    || (restoreStoredConnection && stored?.publicBase && isPublicTunnelUrl(stored.publicBase)
      ? new URL(stored.publicBase).origin
      : undefined)
    || null;

  // 当前页自身也是一端时补全
  if (!lanBase && pageIsLan) lanBase = pageOrigin;
  if (!publicBase && pageIsTunnel) publicBase = pageOrigin;

  if (lanBase) lanBase = normalizeBase(lanBase);
  if (publicBase) publicBase = normalizeBase(publicBase);

  // 初始基址：优先当前页 origin，随后 ensureConnection 会探测切换
  activeBase = pageOrigin || publicBase || lanBase || "";
  if (lanBase && activeBase === lanBase) route = "lan";
  else if (publicBase && activeBase === publicBase) route = "public";
  else route = "local";

  const storedPref = restoreStoredConnection ? stored?.preference : undefined;
  preference = storedPref === "lan" || storedPref === "public" || storedPref === "auto"
    ? storedPref
    : "auto";

  if (token || tokenless) persist();

  if (boot.token || boot.tokenless || boot.lan || boot.public) {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      /* ignore */
    }
  }

  return token;
}

export function getAccessToken(): string {
  return token;
}

export function getActiveBase(): string {
  return activeBase || (typeof location !== "undefined" ? location.origin : "");
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = getActiveBase();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function getConnectionInfo(): ConnectionInfo {
  return currentInfo();
}

export function subscribeConnection(listener: Listener): () => void {
  listeners.add(listener);
  listener(currentInfo());
  return () => {
    listeners.delete(listener);
  };
}

function syncPublicBase(value: unknown): void {
  let next: string | null;
  if (value === null) {
    next = null;
  } else {
    if (typeof value !== "string" || !isPublicTunnelUrl(value)) return;
    try {
      const parsed = new URL(value);
      next = parsed.origin;
    } catch {
      return;
    }
  }
  if (publicBase === next) return;
  publicBase = next;
  persist();
  emit();
}

async function probe(base: string): Promise<boolean> {
  if (!canFetchBase(base) || (!token && !tokenless && !isLoopbackBase(base))) return false;
  try {
    const response = await fetch(`${normalizeBase(base)}/api/health`, {
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      signal: timeoutSignal(PROBE_MS),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const health = await response.json().catch(() => null) as { publicOrigin?: unknown } | null;
    if (health && Object.prototype.hasOwnProperty.call(health, "publicOrigin")) {
      syncPublicBase(health.publicOrigin);
    }
    return true;
  } catch {
    return false;
  }
}

async function measureProbe(base: string | null): Promise<ConnectionProbeResult> {
  if (!base) return { status: "unconfigured", latencyMs: null };
  if (!canFetchBase(base)) return { status: "blocked", latencyMs: null };
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const reachable = await probe(base);
  const finishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  return reachable
    ? { status: "ok", latencyMs: Math.max(1, Math.round(finishedAt - startedAt)) }
    : { status: "unreachable", latencyMs: null };
}

/** 用户主动重新探测时，并行测量局域网和公网健康检查的往返耗时。 */
export async function probeConnectionRoutes(): Promise<ConnectionProbeResults> {
  const [lan, publicRoute] = await Promise.all([
    measureProbe(lanBase),
    measureProbe(publicBase),
  ]);
  return { lan, public: publicRoute };
}

/** 带 token 的入口链接（可复制 / 在新标签打开 / 整页跳转）。 */
export function buildEntryUrl(kind: "lan" | "public"): string | null {
  if (!token && !tokenless) return null;
  if (kind === "lan") {
    if (!lanBase) return null;
    const params = new URLSearchParams();
    if (token) params.set("token", token);
    else params.set("auth", "none");
    if (publicBase) params.set("public", publicBase);
    return `${lanBase}/#${params.toString()}`;
  }
  if (!publicBase) return null;
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  else params.set("auth", "none");
  if (lanBase) params.set("lan", lanBase);
  return `${publicBase}/#${params.toString()}`;
}

/** Build a bearer link that authenticates with the server's read-only token. */
export function buildReadonlyEntryUrl(readonlyToken: string): string | null {
  const safeToken = readonlyToken.trim();
  if (!safeToken) return null;
  const base = publicBase || activeBase || lanBase
    || (typeof location !== "undefined" ? normalizeBase(location.origin) : "");
  if (!base || !isHttpUrl(base)) return null;
  const params = new URLSearchParams({ token: safeToken, readonly: "1" });
  if (publicBase && base === publicBase && lanBase) params.set("lan", lanBase);
  if (lanBase && base === lanBase && publicBase) params.set("public", publicBase);
  return `${normalizeBase(base)}/#${params.toString()}`;
}

/**
 * 用户手动指定通道偏好。
 * - auto：局域网优先，失败走公网
 * - lan / public：尽量锁定；若本页因混合内容无法调用，会返回 needNavigate 让 UI 引导整页打开
 */
export async function setConnectionPreference(
  next: ConnectionPreference,
): Promise<ConnectionInfo & { needNavigate?: "lan" | "public"; error?: string }> {
  preference = next;
  persist();
  emit();

  if (next === "auto") {
    await ensureConnection();
    return currentInfo();
  }

  const base = next === "lan" ? lanBase : publicBase;
  if (!base) {
    return { ...currentInfo(), error: next === "lan" ? "未配置局域网地址" : "未配置公网地址" };
  }
  if (!canFetchBase(base)) {
    return { ...currentInfo(), needNavigate: next, error: "当前页无法直接调用该通道（混合内容），请用下方链接打开" };
  }
  if (!(await probe(base))) {
    return { ...currentInfo(), error: next === "lan" ? "局域网不可达，请确认在同一 Wi‑Fi" : "公网隧道不可达" };
  }
  setRoute(next, base);
  return currentInfo();
}

/** 按优先级选择可达基址：偏好锁定 > 局域网 > 公网 > 当前页。 */
export async function ensureConnection(): Promise<ConnectionInfo> {
  if (selecting) {
    await selecting;
    return currentInfo();
  }
  selecting = (async () => {
    // Capture candidates for this selection pass. A health response may update the
    // latest tunnel address while these probes are in flight.
    const preferredLan = lanBase;
    const preferredPublic = publicBase;
    if (preference === "lan" && preferredLan && canFetchBase(preferredLan)) {
      if (await probe(preferredLan)) {
        setRoute("lan", preferredLan);
        return;
      }
      // 锁定局域网但不可达：若公网可用则降级并保留偏好（回家后监控会再试局域网）
      if (preferredPublic && canFetchBase(preferredPublic) && await probe(preferredPublic)) {
        setRoute("public", preferredPublic);
        return;
      }
    }
    if (preference === "public" && preferredPublic && canFetchBase(preferredPublic)) {
      if (await probe(preferredPublic)) {
        setRoute("public", preferredPublic);
        return;
      }
    }
    if (preference === "auto" || preference === "lan") {
      if (preferredLan && canFetchBase(preferredLan) && await probe(preferredLan)) {
        setRoute("lan", preferredLan);
        return;
      }
    }
    if (preferredPublic && canFetchBase(preferredPublic) && await probe(preferredPublic)) {
      setRoute("public", preferredPublic);
      return;
    }
    // 保底：当前页同源（可能尚未写入 public/lan）
    const origin = typeof location !== "undefined" ? normalizeBase(location.origin) : activeBase;
    if (origin && await probe(origin)) {
      if (lanBase && origin === lanBase) setRoute("lan", origin);
      else if (publicBase && origin === publicBase) setRoute("public", origin);
      else setRoute("local", origin);
      return;
    }
    // 探测全失败时仍保留上次基址，让业务请求自行报错
  })().finally(() => {
    selecting = null;
  });
  await selecting;
  return currentInfo();
}

/**
 * 请求失败时尝试切到另一条通道并重试一次。
 * 返回是否已切换（调用方应重试请求）。
 */
export async function failoverFrom(failedBase?: string): Promise<boolean> {
  const from = normalizeBase(failedBase || activeBase || "");
  const candidates: Array<{ route: ConnectionRoute; base: string }> = [];
  if (lanBase && canFetchBase(lanBase) && normalizeBase(lanBase) !== from) {
    candidates.push({ route: "lan", base: lanBase });
  }
  if (publicBase && canFetchBase(publicBase) && normalizeBase(publicBase) !== from) {
    candidates.push({ route: "public", base: publicBase });
  }
  for (const candidate of candidates) {
    if (await probe(candidate.base)) {
      setRoute(candidate.route, candidate.base);
      return true;
    }
  }
  return false;
}

/** 后台监控：回家庭局域网、离开后切公网。 */
export function startConnectionMonitor(): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped || (!lanBase && !publicBase)) return;
    void ensureConnection();
  };

  const timer = setInterval(tick, MONITOR_MS);
  const onOnline = () => tick();
  const onVisible = () => {
    if (document.visibilityState === "visible") tick();
  };
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  tick();

  return () => {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
