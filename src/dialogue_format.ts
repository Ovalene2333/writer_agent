/**
 * Deterministic punctuation audit for written dialogue.
 *
 * This deliberately validates only visible delimiters. Whether an unquoted
 * sentence is spoken dialogue is a contextual judgment left to chapter review;
 * guessing it from nearby speech verbs would turn a format gate into a brittle
 * semantic parser.
 */

export type DialogueFormatIssueCode = "nonstandard_quote" | "unmatched_quote" | "misnested_quote";

export type DialogueFormatIssue = {
  code: DialogueFormatIssueCode;
  /** False when a noncanonical pair may be a written quotation rather than speech. */
  blocksProposal: boolean;
  line: number;
  column: number;
  evidence: string;
  message: string;
  suggestion: string;
};

type QuoteKind = "direct" | "nested" | "curly" | "ascii";
type OpenQuote = {
  kind: QuoteKind;
  start: number;
  line: number;
  column: number;
  opener: string;
  closer: string;
  insideDirect: boolean;
};

const OPEN_QUOTES: Record<string, { kind: QuoteKind; closer: string }> = {
  "「": { kind: "direct", closer: "」" },
  "『": { kind: "nested", closer: "』" },
  "“": { kind: "curly", closer: "”" },
};

const CLOSE_QUOTES = new Set(["」", "』", "”"]);

/**
 * Direct spoken dialogue uses 「...」. 『...』 remains available for a quotation
 * nested inside a line. Curly and ASCII double quotes are always reported, but
 * only block when their context clearly makes them spoken dialogue. They can
 * also quote a note, screen or written text, which requires semantic context.
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
        "按嵌套顺序闭合引号；直接对白用「……」，其内引用用『……』。",
      );
      return;
    }
    stack.pop();
    if (open.kind === "curly" || open.kind === "ascii") {
      const span = text.slice(open.start, offset + character.length);
      report(
        "nonstandard_quote",
        span.length <= 160 ? span : `${span.slice(0, 157)}...`,
        `${open.opener}${character} 不是正文对白的统一引号。`,
        "把这组引号改为「……」；只有对白中的嵌套引文使用『……』。",
        open.insideDirect || looksLikeSpokenDialogue(text, open.start, offset + character.length),
        open.line,
        open.column,
      );
    }
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
        insideDirect: stack.some(item => item.kind === "direct"),
      });
    } else if (OPEN_QUOTES[character]) {
      const descriptor = OPEN_QUOTES[character];
      stack.push({
        kind: descriptor.kind, start: offset, line, column, opener: character, closer: descriptor.closer,
        insideDirect: stack.some(item => item.kind === "direct"),
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
    "对白引号格式拦截：直接对白统一使用「……」，对白内嵌引用使用『……』。",
    ...details,
    ...(remaining > 0 ? [`另有 ${remaining} 处同类问题。`] : []),
  ].join("\n");
}

/** A narrow audit heuristic, never used to infer any other dialogue semantics. */
function looksLikeSpokenDialogue(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 16), start);
  const after = text.slice(end, end + 20);
  const speechBefore = /(?:说|问|道|答|喊|叫|开口|低声|沉声|补充|回答|反问|打断)[：:\s]*$/u;
  const speechAfter = /^[，,。！？!?…\s]*[一-鿿]{0,6}(?:说|问|道|答|喊|叫|开口|低声|沉声|补充|回答|反问|打断)/u;
  return speechBefore.test(before) || speechAfter.test(after);
}
