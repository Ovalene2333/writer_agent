import { ProxyAgent, fetch as undiciFetch } from "undici";

const proxyAgents = new Map<string, ProxyAgent>();

/** Fetch a model-provider endpoint, optionally through an explicit HTTP(S) proxy. */
export function modelFetch(input: string | URL, init: RequestInit, proxyUrl?: string): Promise<Response> {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return fetch(input, init);
  let dispatcher = proxyAgents.get(normalized);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(normalized);
    proxyAgents.set(normalized, dispatcher);
  }
  return undiciFetch(input, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

export function normalizeProxyUrl(value?: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `http://${text}`);
  } catch {
    throw new Error("代理地址格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("代理地址仅支持 HTTP 或 HTTPS 协议");
  }
  if (!url.hostname || !url.port) throw new Error("代理地址必须包含主机和端口");
  return url.toString().replace(/\/$/, "");
}
