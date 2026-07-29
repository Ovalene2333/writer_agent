import {
  apiUrl,
  failoverFrom,
  getAccessToken,
  getActiveBase,
  initConnection,
} from "./connection";

const token = initConnection();

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${getAccessToken() || token}` };
  if (init?.body != null) headers["content-type"] = "application/json";
  if (init?.headers) Object.assign(headers, init.headers);

  const run = async () => {
    const response = await fetch(apiUrl(path), { ...init, headers });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { error: text.slice(0, 200) };
      }
    }
    return { response, body };
  };

  try {
    let { response, body } = await run();
    if (!response.ok && response.status >= 502) {
      if (await failoverFrom(getActiveBase())) {
        ({ response, body } = await run());
      }
    }
    if (!response.ok) throw new Error((body.error as string) || `Request failed: ${response.status}`);
    return body as T;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Request failed:")) throw error;
    if (await failoverFrom(getActiveBase())) {
      const { response, body } = await run();
      if (!response.ok) throw new Error((body.error as string) || `Request failed: ${response.status}`);
      return body as T;
    }
    throw error;
  }
}

/** fetch 包装：用于 SSE 等非 JSON 请求，失败时自动 failover 一次。 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${getAccessToken() || token}`);
  }
  const attempt = () => fetch(apiUrl(path), { ...init, headers });
  try {
    const response = await attempt();
    if (response.ok || response.status < 502) return response;
    if (await failoverFrom(getActiveBase())) return attempt();
    return response;
  } catch (error) {
    if (await failoverFrom(getActiveBase())) return attempt();
    throw error;
  }
}
