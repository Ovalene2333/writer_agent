import { createHash } from "node:crypto";

export type DocumentSpan = {
  index: number;
  anchorId: string;
  spanHash: string;
  kind: "heading" | "paragraph";
  headingPath: string[];
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  characters: number;
  content: string;
};

type SourceLine = { text: string; start: number; end: number; line: number };

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sourceLines(content: string): SourceLine[] {
  if (!content) return [];
  const lines: SourceLine[] = [];
  let start = 0;
  let line = 1;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const fullEnd = newline < 0 ? content.length : newline;
    const end = fullEnd > start && content[fullEnd - 1] === "\r" ? fullEnd - 1 : fullEnd;
    lines.push({ text: content.slice(start, end), start, end, line });
    if (newline < 0) break;
    start = newline + 1;
    line += 1;
  }
  return lines;
}

/** Snapshot-scoped prose anchors. Blank lines are separators and headings are standalone spans. */
export function documentSpans(content: string, sourceHash: string): DocumentSpan[] {
  const lines = sourceLines(content);
  const raw: Array<Omit<DocumentSpan, "index" | "anchorId" | "spanHash" | "characters">> = [];
  const headings: string[] = [];
  let paragraph: SourceLine[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const first = paragraph[0];
    const last = paragraph[paragraph.length - 1];
    raw.push({
      kind: "paragraph",
      headingPath: headings.filter(Boolean),
      startOffset: first.start,
      endOffset: last.end,
      startLine: first.line,
      endLine: last.line,
      content: content.slice(first.start, last.end),
    });
    paragraph = [];
  };
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line.text);
    if (match) {
      flush();
      const level = match[1].length;
      const heading = match[2].replace(/\s+#+\s*$/, "").trim();
      headings.length = level - 1;
      headings[level - 1] = heading;
      raw.push({
        kind: "heading",
        headingPath: headings.filter(Boolean),
        startOffset: line.start,
        endOffset: line.end,
        startLine: line.line,
        endLine: line.line,
        content: line.text,
      });
      continue;
    }
    if (!line.text.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return raw.map((span, offset) => {
    const index = offset + 1;
    const spanHash = shortHash(span.content);
    return {
      ...span,
      index,
      spanHash,
      anchorId: `p${index}-${shortHash(`${sourceHash}:${span.startOffset}:${span.endOffset}:${spanHash}`).slice(0, 10)}`,
      characters: span.content.length,
    };
  });
}

export function resolveDocumentSpan(
  content: string,
  sourceHash: string,
  anchorId: string,
): DocumentSpan | undefined {
  return documentSpans(content, sourceHash).find(span => span.anchorId === anchorId);
}

export function documentSpanCatalog(span: DocumentSpan, previewCharacters = 100): Record<string, unknown> {
  const compact = span.content.replace(/\s+/g, " ").trim();
  return {
    anchorId: span.anchorId,
    spanHash: span.spanHash,
    kind: span.kind,
    headingPath: span.headingPath,
    startLine: span.startLine,
    endLine: span.endLine,
    characters: span.characters,
    preview: compact.length > previewCharacters ? `${compact.slice(0, previewCharacters)}…` : compact,
  };
}
