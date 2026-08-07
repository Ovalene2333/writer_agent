/**
 * Deterministic punctuation audit for written dialogue.
 *
 * Accepts multiple direct-speech delimiter styles without forcing one:
 *   「...」  『...』 (nestable)  “...”  "..."
 * Only reports unmatched / misnested pairs. Whether an unquoted sentence is
 * spoken dialogue remains a contextual judgment for chapter review.
 */

export type DialogueFormatIssueCode = "unmatched_quote" | "misnested_quote";

export type DialogueFormatIssue = {
  code: DialogueFormatIssueCode;
  blocksProposal: boolean;
  line: number;
  column: number;
  evidence: string;
  message: string;
  suggestion: string;
};

type QuoteKind = "corner" | "nested" | "curly" | "ascii";
type OpenQuote = {
  kind: QuoteKind;
  start: number;
  line: number;
  column: number;
  opener: string;
  closer: string;
};

const OPEN_QUOTES: Record<string, { kind: QuoteKind; closer: string }> = {
  "「": { kind: "corner", closer: "」" },
  "『": { kind: "nested", closer: "』" },
  "“": { kind: "curly", closer: "”" },
};

const CLOSE_QUOTES = new Set(["」", "』", "”"]);

const ALLOWED_STYLES = `「……」、“……”、"……" 均可；对白内嵌引文可用『……』`;

/**
 * Validate that quote openers and closers pair correctly. Style choice among
 * corner, curly, and ASCII double quotes is not enforced.
 */
export function auditDialogueFormat(text: string): DialogueFormatIssue[] {
  const issues: DialogueFormatIssue[] = [];
  const stack: OpenQuote[] = [];
  let line = 1;
  let column = 1;
  let offset = 0;

  const report = (
    code: DialogueFormatIssueCode,
    evidence: string,
    message: string,
    suggestion: string,
    blocksProposal = true,
    atLine = line,
    atColumn = column,
  ) => issues.push({ code, blocksProposal, line: atLine, column: atColumn, evidence, message, suggestion });

  const close = (character: string) => {
    const open = stack.at(-1);
    if (!open) {
      report("unmatched_quote", character, `引号 ${character} 没有对应的起始引号。`, "补上匹配的起始引号，或删除这个多余的结束引号。");
      return;
    }
    if (open.closer !== character) {
      report(
        "misnested_quote",
        character,
        `引号 ${character} 与 ${open.opener} 不配对；此处应先闭合 ${open.closer}。`,
        `按嵌套顺序闭合引号，并使开闭类型一致。${ALLOWED_STYLES}。`,
      );
      return;
    }
    stack.pop();
  };

  for (const character of text) {
    if (character === "\n") {
      line += 1;
      column = 1;
      offset += character.length;
      continue;
    }
    if (character === '"') {
      if (stack.at(-1)?.kind === "ascii") close(character);
      else stack.push({
        kind: "ascii", start: offset, line, column, opener: character, closer: character,
      });
    } else if (OPEN_QUOTES[character]) {
      const descriptor = OPEN_QUOTES[character];
      stack.push({
        kind: descriptor.kind, start: offset, line, column, opener: character, closer: descriptor.closer,
      });
    } else if (CLOSE_QUOTES.has(character)) {
      close(character);
    }
    column += 1;
    offset += character.length;
  }

  for (const open of stack.reverse()) {
    report(
      "unmatched_quote",
      open.opener,
      `引号 ${open.opener} 没有对应的结束引号 ${open.closer}。`,
      `补上 ${open.closer}，或删除这个多余的起始引号。`,
      true,
      open.line,
      open.column,
    );
  }
  return issues;
}

/** A compact, deterministic proposal gate; no model call or semantic inference. */
export function dialogueFormatGateError(text: string): string | undefined {
  const issues = auditDialogueFormat(text).filter(issue => issue.blocksProposal);
  if (!issues.length) return undefined;
  const details = issues.slice(0, 12).map(issue =>
    `第${issue.line}行第${issue.column}列「${issue.evidence}」：${issue.message} ${issue.suggestion}`,
  );
  const remaining = issues.length - details.length;
  return [
    `对白引号格式拦截：引号须成对且开闭一致；${ALLOWED_STYLES}，不强制统一样式。`,
    ...details,
    ...(remaining > 0 ? [`另有 ${remaining} 处同类问题。`] : []),
  ].join("\n");
}
