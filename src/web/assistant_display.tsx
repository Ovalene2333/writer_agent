/**
 * 助手最终气泡展示：把混在正文里的内部 id / ISO 时间等拆成元数据芯片，
 * 正文保留作者可读叙述。仅用于展示层降噪，不改服务端存档。
 */
import React, { useMemo } from "react";
import { Markdown } from "./markdown";

export type AssistantMetaChip = {
  id: string;
  kind: "id" | "time" | "field" | "hash";
  label: string;
};

export type AssistantDisplayParts = {
  /** 去掉内部书签后的正文 */
  prose: string;
  chips: AssistantMetaChip[];
};

const ISO_TS =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?(?:\d{2})?)/g;

const INTERNAL_FIELD_NAMES = [
  "expectedUpdatedAt",
  "sourceHash",
  "deliveryReady",
  "projectEpoch",
  "tool_call_id",
  "callKind",
  "cacheHitTokens",
  "cacheMissTokens",
] as const;

function formatChipTime(iso: string): string {
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

function pushChip(chips: AssistantMetaChip[], chip: Omit<AssistantMetaChip, "id">, seen: Set<string>) {
  const key = `${chip.kind}:${chip.label}`;
  if (seen.has(key)) return;
  seen.add(key);
  chips.push({ ...chip, id: key });
}

/**
 * 从助手最终文案中抽出内部 id / 时间戳 / 字段名，返回可读正文 + 芯片。
 * 审阅向展示：允许用固定模式匹配输出中的技术书签，不用于理解用户语义。
 */
export function splitAssistantDisplay(content: string): AssistantDisplayParts {
  const source = content ?? "";
  if (!source.trim()) return { prose: source, chips: [] };

  const chips: AssistantMetaChip[] = [];
  const seen = new Set<string>();
  let text = source;

  // (updatedAt=ISO) / updatedAt=ISO / (updatedAt: ISO)
  text = text.replace(
    /\(?\bupdatedAt\s*[=:：]\s*("?)(\d{4}-\d{2}-\d{2}T[^)\s"]+)\1\)?/gi,
    (_full, _q, iso: string) => {
      pushChip(chips, { kind: "time", label: `更新于 ${formatChipTime(iso)}` }, seen);
      return " ";
    },
  );

  // expectedUpdatedAt=... 或纯字段名旁的赋值
  text = text.replace(
    /\(?\bexpectedUpdatedAt\s*[=:：]\s*("?)([^)\s"]+)\1\)?/gi,
    () => {
      pushChip(chips, { kind: "field", label: "版本校验" }, seen);
      return " ";
    },
  );

  // (id=5) / (id: 5) / id=5
  text = text.replace(/\(?\bid\s*[=:：]\s*(\d+)\)?/gi, (_full, id: string) => {
    pushChip(chips, { kind: "id", label: `条目 #${id}` }, seen);
    return " ";
  });

  // sourceHash=abc...
  text = text.replace(/\(?\bsourceHash\s*[=:：]\s*([A-Za-z0-9._-]{6,})\)?/gi, (_full, hash: string) => {
    pushChip(chips, { kind: "hash", label: `校验 ${hash.slice(0, 8)}…` }, seen);
    return " ";
  });

  // Bare ISO timestamps remaining
  text = text.replace(ISO_TS, (iso) => {
    pushChip(chips, { kind: "time", label: formatChipTime(iso) }, seen);
    return " ";
  });

  // Standalone internal field names (no value) — common in process dumps
  for (const name of INTERNAL_FIELD_NAMES) {
    const re = new RegExp(`\\b${name}\\b`, "g");
    if (re.test(text)) {
      if (name === "expectedUpdatedAt") {
        pushChip(chips, { kind: "field", label: "版本校验" }, seen);
      } else if (name === "sourceHash") {
        pushChip(chips, { kind: "field", label: "内容校验" }, seen);
      } else if (name === "deliveryReady") {
        pushChip(chips, { kind: "field", label: "交付就绪" }, seen);
      }
      text = text.replace(re, " ");
    }
  }

  // Clean spacing left by removals
  let prose = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([，。；：、,.!?）】」])/g, "$1")
    .replace(/([（【「])[ \t]+/g, "$1")
    .trim();

  if (!prose && chips.length) {
    prose = "已完成相关操作。";
  }

  const kindOrder: Record<AssistantMetaChip["kind"], number> = { id: 0, field: 1, hash: 2, time: 3 };
  chips.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.label.localeCompare(b.label, "zh"));

  return { prose, chips };
}

/** 折叠预览用：去掉内部书签后再截断。 */
export function assistantPreviewText(content: string, max = 140): string {
  const { prose } = splitAssistantDisplay(content);
  const plain = prose
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#`|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return chipsPreviewFallback(content, max);
  return plain.length <= max ? plain : `${plain.slice(0, max)}…`;
}

function chipsPreviewFallback(content: string, max: number): string {
  const { chips } = splitAssistantDisplay(content);
  if (!chips.length) return "（空回复）";
  const label = chips.map(c => c.label).join(" · ");
  return label.length <= max ? label : `${label.slice(0, max)}…`;
}

export function AssistantMessageBody({
  content,
  collapsed,
  previewMax = 140,
}: {
  content: string;
  collapsed?: boolean;
  previewMax?: number;
}) {
  const parts = useMemo(() => splitAssistantDisplay(content), [content]);
  if (collapsed) {
    return <p className="msg-preview">{assistantPreviewText(content, previewMax)}</p>;
  }
  return (
    <div className="assistant-message-body">
      {parts.chips.length > 0 && (
        <div className="assistant-meta-chips" aria-label="操作元数据">
          {parts.chips.map(chip => (
            <span key={chip.id} className={`assistant-meta-chip kind-${chip.kind}`} title={chip.label}>
              {chip.label}
            </span>
          ))}
        </div>
      )}
      {parts.prose ? <Markdown content={parts.prose} /> : null}
    </div>
  );
}
