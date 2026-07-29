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
