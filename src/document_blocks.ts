export interface DocumentBlock {
  block: number;
  startLine: number;
  endLine: number;
  characters: number;
  content: string;
  startOffset: number;
  endOffset: number;
}

const DEFAULT_TARGET_CHARACTERS = 6_000;

/**
 * Split prose on structural boundaries. The target is soft: a complete sentence
 * is never cut merely to satisfy the character budget.
 */
export function documentBlocks(content: string, targetCharacters = DEFAULT_TARGET_CHARACTERS): DocumentBlock[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized) return [{ block: 1, startLine: 1, endLine: 1, characters: 0, content: "", startOffset: 0, endOffset: 0 }];

  const units = normalized.split(/\n{2,}/).flatMap((paragraph, paragraphIndex) =>
    splitLongParagraph(paragraph, targetCharacters).map((text, sentenceIndex) => ({
      text,
      separator: paragraphIndex === 0 && sentenceIndex === 0 ? "" : sentenceIndex === 0 ? "\n\n" : "",
    })),
  );
  const grouped: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current}${unit.separator}${unit.text}` : unit.text;
    if (current && candidate.length > targetCharacters) {
      grouped.push(current);
      current = unit.text;
    } else {
      current = candidate;
    }
  }
  if (current || !grouped.length) grouped.push(current);

  let searchFrom = 0;
  return grouped.map((blockContent, index) => {
    const startOffset = normalized.indexOf(blockContent, searchFrom);
    const safeOffset = startOffset >= 0 ? startOffset : searchFrom;
    const startLine = lineAt(normalized, safeOffset);
    const endLine = startLine + (blockContent.match(/\n/g)?.length ?? 0);
    searchFrom = safeOffset + blockContent.length;
    return {
      block: index + 1, startLine, endLine, characters: blockContent.length, content: blockContent,
      startOffset: safeOffset, endOffset: safeOffset + blockContent.length,
    };
  });
}

export function blockAtOffset(blocks: DocumentBlock[], content: string, offset: number): number {
  const line = lineAt(content.replace(/\r\n?/g, "\n"), offset);
  return blocks.find(block => line >= block.startLine && line <= block.endLine)?.block
    ?? blocks.find(block => line < block.startLine)?.block
    ?? blocks.at(-1)?.block
    ?? 1;
}

function splitLongParagraph(paragraph: string, targetCharacters: number): string[] {
  if (paragraph.length <= targetCharacters) return [paragraph];
  const sentences = paragraph.match(/.*?(?:[。！？!?；;…]+[”’」』》】）)]*|$)/gs)?.filter(Boolean) ?? [paragraph];
  if (sentences.length <= 1) return [paragraph];
  const result: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > targetCharacters) {
      result.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) result.push(current);
  return result;
}

function lineAt(content: string, offset: number): number {
  return (content.slice(0, Math.max(0, offset)).match(/\n/g)?.length ?? 0) + 1;
}
