import { useMemo, type MouseEvent } from "react";
import { Marked, type Token, type Tokens } from "marked";
import { getActiveBase } from "./connection";
import type { MarkdownHeading } from "./types";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Links emitted by Agent steps may point at project documents, never the public web. */
export function isLocalMarkdownHref(href: string): boolean {
  const value = href.trim();
  if (!value || value.startsWith("//")) return false;
  return value.startsWith("#")
    || value.startsWith("/")
    || value.startsWith("./")
    || value.startsWith("../")
    || !/^[a-z][a-z\d+.-]*:/i.test(value);
}

export function normalizeMarkdownSource(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
}

/** Shared GFM parser for document reader + agent chat. */
export const markdownParser = new Marked({
  gfm: true,
  // Single newlines → <br> — better for Chinese prose / novel drafts without blank lines.
  breaks: true,
  pedantic: false,
  silent: true,
});

let markdownHeadingIndex = 0;
let markdownHeadingPrefix = "";
let markdownSourceText = "";
let markdownSourceCursor = 0;
let markdownSourceRangesEnabled = false;

export function markdownSourceRangeAttributes(raw: string): string {
  if (!markdownSourceRangesEnabled || !raw) return "";
  let start = markdownSourceText.indexOf(raw, markdownSourceCursor);
  if (start < 0) start = markdownSourceText.indexOf(raw);
  if (start < 0) return "";
  const end = start + raw.length;
  markdownSourceCursor = end;
  return ` data-source-start="${start}" data-source-end="${end}"`;
}

markdownParser.use({
  renderer: {
    heading({ tokens, depth, raw }: Tokens.Heading) {
      const text = this.parser.parseInline(tokens);
      const id = markdownHeadingPrefix
        ? ` id="${markdownHeadingPrefix}-section-${++markdownHeadingIndex}"`
        : "";
      return `<h${depth}${id}${markdownSourceRangeAttributes(raw)}>${text}</h${depth}>\n`;
    },
    paragraph({ tokens, raw }: Tokens.Paragraph) {
      return `<p${markdownSourceRangeAttributes(raw)}>${this.parser.parseInline(tokens)}</p>\n`;
    },
    // Never execute raw HTML from documents / model output.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      const safeHref = href ?? "";
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      const external = /^https?:\/\//i.test(safeHref);
      const rel = external ? ' target="_blank" rel="noreferrer noopener"' : "";
      const scope = isLocalMarkdownHref(safeHref) ? "local" : "external";
      return `<a href="${escapeHtml(safeHref)}" data-link-scope="${scope}"${titleAttr}${rel}>${text}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      const alt = escapeHtml(text || "");
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(href || "")}" alt="${alt}"${titleAttr} loading="lazy" />`;
    },
    codespan({ text }: Tokens.Codespan) {
      return `<code>${escapeHtml(text)}</code>`;
    },
    code({ text, lang }: Tokens.Code) {
      const language = lang ? ` class="language-${escapeHtml(lang.split(/\s+/)[0] ?? "")}"` : "";
      return `<pre><code${language}>${escapeHtml(text)}</code></pre>\n`;
    },
  },
});

/** Walk block tokens in render order (matches marked's heading traversal for IDs). */
export function walkBlockTokens(tokens: Token[], visit: (token: Token) => void): void {
  for (const token of tokens) {
    visit(token);
    if (token.type === "blockquote" && "tokens" in token && token.tokens) {
      walkBlockTokens(token.tokens, visit);
    } else if (token.type === "list") {
      for (const item of token.items) {
        if (item.tokens) walkBlockTokens(item.tokens, visit);
      }
    }
  }
}

export function markdownHeadings(content: string, prefix: string): MarkdownHeading[] {
  const normalized = normalizeMarkdownSource(content);
  if (!normalized.trim()) return [];
  const tokens = markdownParser.lexer(normalized);
  const headings: MarkdownHeading[] = [];
  let index = 0;
  walkBlockTokens(tokens, (token) => {
    if (token.type !== "heading") return;
    index += 1;
    headings.push({
      id: `${prefix}-section-${index}`,
      level: token.depth,
      text: token.text.replace(/\s+#+\s*$/, "").trim(),
    });
  });
  return headings;
}

export function renderMarkdownHtml(content: string, headingPrefix?: string): string {
  const normalized = normalizeMarkdownSource(content);
  if (!normalized.trim()) return "";
  markdownHeadingIndex = 0;
  markdownHeadingPrefix = headingPrefix ?? "";
  markdownSourceText = normalized;
  markdownSourceCursor = 0;
  markdownSourceRangesEnabled = headingPrefix === "document";
  try {
    const html = markdownParser.parse(normalized, { async: false });
    return typeof html === "string" ? html : "";
  } catch {
    // Fallback: plain escaped text so the reader never goes blank.
    return `<p>${escapeHtml(normalized).replace(/\n/g, "<br/>")}</p>`;
  }
}

export function documentWordCount(content: string): number {
  return Array.from(content).filter(character => !/\s/u.test(character)).length;
}

/** Count the text a reader actually sees, excluding Markdown presentation markers. */
export function renderedMarkdownWordCount(content: string): number {
  const html = renderMarkdownHtml(content);
  if (!html) return 0;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return documentWordCount(parsed.body.textContent ?? "");
}

export function originalOffsetForNormalized(source: string, normalizedOffset: number): number {
  let original = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let normalized = 0;
  while (original < source.length && normalized < normalizedOffset) {
    if (source[original] === "\r" && source[original + 1] === "\n") original += 2;
    else original += 1;
    normalized += 1;
  }
  return original;
}

export type DocumentContextSelection = {
  id: string;
  path: string;
  text: string;
};

export type ReaderTextSelection = DocumentContextSelection & {
  start: number;
  end: number;
  blockCount: number;
  left: number;
  top: number;
};

export function readingProgressStorageKey(path: string): string {
  return `writer-reading-progress:v1:${getActiveBase()}:${path}`;
}

export function loadReadingProgress(path: string): number | undefined {
  if (!path) return undefined;
  const value = Number(localStorage.getItem(readingProgressStorageKey(path)));
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
}

export function saveReadingProgress(path: string, ratio: number): void {
  if (!path) return;
  localStorage.setItem(readingProgressStorageKey(path), String(Math.max(0, Math.min(1, ratio))));
}

export function Markdown({
  content,
  className,
  headingPrefix,
  localLinksOnly = false,
  onLocalLink,
}: {
  content: string;
  className?: string;
  headingPrefix?: string;
  localLinksOnly?: boolean;
  onLocalLink?: (href: string) => void;
}) {
  const html = useMemo(
    () => renderMarkdownHtml(content, headingPrefix),
    [content, headingPrefix],
  );
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!localLinksOnly) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (isLocalMarkdownHref(href)) onLocalLink?.(href);
  };
  return (
    <div
      className={`markdown${localLinksOnly ? " markdown-local-links" : ""}${className ? ` ${className}` : ""}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html || "<p></p>" }}
    />
  );
}
