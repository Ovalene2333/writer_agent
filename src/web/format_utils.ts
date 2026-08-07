/** Tiny display helpers shared by agent steps and context graph. */

export function shortProviderName(value?: string): string {
  const full = value?.trim();
  return full ? Array.from(full).slice(0, 2).join("") : "未知";
}

export function formatGraphTokens(tokens: number): string {
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

export function formatVersionTime(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Startup / project-switch default: open project instructions when present. */
export function defaultBrowserDocument(documents: readonly string[]): string | undefined {
  const writer = documents.find((path) => {
    const base = path.split("/").pop() ?? path;
    return base.toLowerCase() === "writer.md";
  });
  return writer ?? documents[0];
}
