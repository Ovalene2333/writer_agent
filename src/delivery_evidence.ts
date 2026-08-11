/** Compact, content-bearing evidence for proposal metadata and terminal fulfillment review. */
export function documentContentEvidence(content: string, maxCharacters = 240): string {
  const paragraphs = content
    .split(/\r?\n\s*\r?\n/u)
    .map(paragraph => paragraph.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  if (!paragraphs.length) return "空文档";
  const heading = paragraphs[0]?.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim();
  const body = heading ? paragraphs.slice(1) : paragraphs;
  const first = body[0] ?? paragraphs[0]!;
  const last = body.at(-1);
  const clip = (value: string, limit: number): string => value.length <= limit
    ? value
    : `${value.slice(0, Math.max(1, limit - 1))}…`;
  const headingPart = heading ? `标题《${clip(heading, 56)}》` : "";
  const reserved = headingPart ? headingPart.length + 1 : 0;
  const available = Math.max(32, maxCharacters - reserved);
  const bodyParts = last && last !== first
    ? [
        clip(first, Math.floor((available - 4) / 2)),
        `结尾：${clip(last, Math.ceil((available - 4) / 2) - 3)}`,
      ]
    : [clip(first, available)];
  return [...(headingPart ? [headingPart] : []), ...bodyParts].join("；").slice(0, maxCharacters);
}

export function fallbackDocumentMutationSummary(
  verb: "write" | "edit",
  path: string,
  content: string,
): string {
  const label = verb === "write" ? "写入" : "编辑";
  return `${label} ${path}\n${content.length} 字；${documentContentEvidence(content, 260)}`;
}

export function deliveredDocumentEvidence(input: {
  path: string;
  summary: string;
  content: string;
  status: "accepted" | "pending";
}): string {
  const status = input.status === "accepted" ? "已接受" : "待审批";
  const summary = input.summary.replace(/\s+/gu, " ").trim().slice(0, 240);
  const contentEvidence = documentContentEvidence(input.content, 260);
  return [
    input.path,
    status,
    `${input.content.length} 字`,
    summary ? `提交摘要：${summary}` : "",
    `正文证据：${contentEvidence}`,
  ].filter(Boolean).join("；");
}
