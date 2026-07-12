/** Token-level change for inline strikethrough / background diff display. */
export type DiffPart = {
  type: "equal" | "add" | "remove";
  text: string;
};

/**
 * Compute a track-changes style diff (deleted + added + equal) between two
 * full-document strings. Uses line-level LCS, then word-level LCS on replaced
 * line blocks so prose edits stay readable.
 */
export function documentDiff(before: string, after: string): DiffPart[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return b.map((text) => ({ type: "add" as const, text }));
  if (b.length === 0) return a.map((text) => ({ type: "remove" as const, text }));

  const lineOps = lcsOps(a, b);
  const parts: DiffPart[] = [];
  let i = 0;
  while (i < lineOps.length) {
    if (lineOps[i].type === "equal") {
      parts.push(lineOps[i]);
      i += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (i < lineOps.length && lineOps[i].type !== "equal") {
      if (lineOps[i].type === "remove") removed.push(lineOps[i].text);
      else added.push(lineOps[i].text);
      i += 1;
    }
    if (removed.length && added.length) {
      parts.push(...wordDiff(removed.join(""), added.join("")));
    } else {
      for (const text of removed) parts.push({ type: "remove", text });
      for (const text of added) parts.push({ type: "add", text });
    }
  }
  return mergeAdjacent(parts);
}

/** Escape text and wrap add/remove spans for safe HTML insertion. */
export function renderDiffHtml(parts: DiffPart[]): string {
  return parts.map((part) => {
    const text = escapeHtml(part.text);
    if (part.type === "add") return `<ins class="diff-add">${text}</ins>`;
    if (part.type === "remove") return `<del class="diff-remove">${text}</del>`;
    return text;
  }).join("");
}

function splitLines(text: string): string[] {
  if (!text) return [];
  // Keep newline on each line except possibly the last, so reassembly is exact.
  const matches = text.match(/[^\n]*\n|[^\n]+/g);
  return matches ?? [];
}

function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  if (!a.length) return b.map((text) => ({ type: "add" as const, text }));
  if (!b.length) return a.map((text) => ({ type: "remove" as const, text }));
  return mergeAdjacent(lcsOps(a, b));
}

/** Split into CJK chars, words, and whitespace/punctuation runs. */
function tokenize(text: string): string[] {
  return text.match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_\u4e00-\u9fff]+/gu) ?? [text];
}

function lcsOps(a: string[], b: string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  // Space-optimized path lengths; reconstruct via backtrack table.
  const prev = new Int32Array(m + 1);
  const curr = new Int32Array(m + 1);
  const table: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  // 0 = diag (equal), 1 = up (remove), 2 = left (add)
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        table[i][j] = 0;
      } else if (prev[j] > curr[j - 1]) {
        // Prefer "add" when scores tie so reverse-backtrack emits remove then add.
        curr[j] = prev[j];
        table[i][j] = 1;
      } else {
        curr[j] = curr[j - 1];
        table[i][j] = 2;
      }
    }
    prev.set(curr);
    curr.fill(0);
  }

  const ops: DiffPart[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && table[i][j] === 0) {
      ops.push({ type: "equal", text: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || table[i][j] === 2)) {
      ops.push({ type: "add", text: b[j - 1] });
      j -= 1;
    } else {
      ops.push({ type: "remove", text: a[i - 1] });
      i -= 1;
    }
  }
  ops.reverse();
  return ops;
}

function mergeAdjacent(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const last = out[out.length - 1];
    if (last && last.type === part.type) last.text += part.text;
    else out.push({ type: part.type, text: part.text });
  }
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
