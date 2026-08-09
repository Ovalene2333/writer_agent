/**
 * Project-level chapter path/title conventions + session lock so multi-chapter
 * jobs keep one naming scheme for the whole conversation.
 */

import type { WriterProject } from "./project.js";
import type { WriterStore } from "./store.js";
import { parseChineseNumeral } from "./path_sort.js";

export type ChapterNamingPreset = "auto" | "cn-file-en" | "cn-file" | "cn-arabic" | "custom";
export type ChapterIndexStyle = "chinese" | "arabic" | "padded-arabic";

export interface ChapterNamingSettings {
  /** auto = infer from existing chapters; other presets expand to fixed patterns. */
  preset: ChapterNamingPreset;
  /** Templates: {index} {indexPad} {indexCn} {subtitleSlug} */
  pathPattern: string;
  indexPadWidth: number;
  titlePattern: string;
  titleWithSubtitle: string;
  requireSubtitle: boolean;
  subtitleMaxLen: number;
  indexStyle: ChapterIndexStyle;
  /** Rewrite filename-like H1 (e.g. # chapter-02) to the title template on write. */
  enforceHeading: boolean;
}

/** Fully expanded convention used at runtime (settings or session lock). */
export interface ResolvedChapterNaming {
  pathPattern: string;
  indexPadWidth: number;
  titlePattern: string;
  titleWithSubtitle: string;
  requireSubtitle: boolean;
  subtitleMaxLen: number;
  indexStyle: ChapterIndexStyle;
  enforceHeading: boolean;
  source: "session-lock" | "settings" | "inferred" | "default";
  preset: ChapterNamingPreset;
}

export type ChapterNameTokens = {
  index: number;
  indexPad: string;
  indexCn: string;
  subtitle?: string;
  subtitleSlug?: string;
};

const SESSION_LOCK_KEY = "chapter-naming:convention";
const PRESETS: ChapterNamingPreset[] = ["auto", "cn-file-en", "cn-file", "cn-arabic", "custom"];
const INDEX_STYLES: ChapterIndexStyle[] = ["chinese", "arabic", "padded-arabic"];

export const DEFAULT_CHAPTER_NAMING: ChapterNamingSettings = {
  preset: "auto",
  pathPattern: "chapters/chapter-{indexPad}.md",
  indexPadWidth: 2,
  titlePattern: "第{indexCn}章",
  titleWithSubtitle: "第{indexCn}章 {subtitle}",
  requireSubtitle: false,
  subtitleMaxLen: 16,
  indexStyle: "chinese",
  enforceHeading: true,
};

const PRESET_TABLE: Record<Exclude<ChapterNamingPreset, "auto" | "custom">, Omit<ChapterNamingSettings, "preset">> = {
  "cn-file-en": {
    pathPattern: "chapters/chapter-{indexPad}.md",
    indexPadWidth: 2,
    titlePattern: "第{indexCn}章",
    titleWithSubtitle: "第{indexCn}章 {subtitle}",
    requireSubtitle: false,
    subtitleMaxLen: 16,
    indexStyle: "chinese",
    enforceHeading: true,
  },
  "cn-file": {
    pathPattern: "chapters/第{indexPad}章.md",
    indexPadWidth: 2,
    titlePattern: "第{indexCn}章",
    titleWithSubtitle: "第{indexCn}章 {subtitle}",
    requireSubtitle: false,
    subtitleMaxLen: 16,
    indexStyle: "chinese",
    enforceHeading: true,
  },
  "cn-arabic": {
    pathPattern: "chapters/chapter-{indexPad}.md",
    indexPadWidth: 2,
    titlePattern: "第{index}章",
    titleWithSubtitle: "第{index}章 {subtitle}",
    requireSubtitle: false,
    subtitleMaxLen: 16,
    indexStyle: "arabic",
    enforceHeading: true,
  },
};

const CN_SIMPLE = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 1 → 一, 10 → 十, 11 → 十一, 20 → 二十, 21 → 二十一 (covers normal chapter ranges). */
export function toChineseNumeral(n: number): string {
  const value = Math.trunc(n);
  if (!Number.isFinite(value) || value < 0) return String(n);
  if (value < 10) return CN_SIMPLE[value] ?? String(value);
  if (value < 20) return value === 10 ? "十" : `十${CN_SIMPLE[value - 10]}`;
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return `${CN_SIMPLE[tens]}十${ones ? CN_SIMPLE[ones] : ""}`;
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100);
    const rest = value % 100;
    if (rest === 0) return `${CN_SIMPLE[hundreds]}百`;
    if (rest < 10) return `${CN_SIMPLE[hundreds]}百零${CN_SIMPLE[rest]}`;
    return `${CN_SIMPLE[hundreds]}百${toChineseNumeral(rest)}`;
  }
  return String(value);
}

export function isChapterNamingPreset(value: string): value is ChapterNamingPreset {
  return PRESETS.includes(value as ChapterNamingPreset);
}

export function isChapterIndexStyle(value: string): value is ChapterIndexStyle {
  return INDEX_STYLES.includes(value as ChapterIndexStyle);
}

export function normalizeChapterNamingSettings(value?: Partial<ChapterNamingSettings> | null): ChapterNamingSettings {
  const raw = value && typeof value === "object" ? value : {};
  const preset = typeof raw.preset === "string" && isChapterNamingPreset(raw.preset)
    ? raw.preset
    : DEFAULT_CHAPTER_NAMING.preset;
  const padRaw = Number(raw.indexPadWidth);
  const indexPadWidth = Number.isFinite(padRaw)
    ? Math.min(4, Math.max(1, Math.round(padRaw)))
    : DEFAULT_CHAPTER_NAMING.indexPadWidth;
  const subMax = Number(raw.subtitleMaxLen);
  const subtitleMaxLen = Number.isFinite(subMax)
    ? Math.min(40, Math.max(4, Math.round(subMax)))
    : DEFAULT_CHAPTER_NAMING.subtitleMaxLen;
  const base: ChapterNamingSettings = {
    preset,
    pathPattern: typeof raw.pathPattern === "string" && raw.pathPattern.trim()
      ? raw.pathPattern.trim().replaceAll("\\", "/")
      : DEFAULT_CHAPTER_NAMING.pathPattern,
    indexPadWidth,
    titlePattern: typeof raw.titlePattern === "string" && raw.titlePattern.trim()
      ? raw.titlePattern.trim()
      : DEFAULT_CHAPTER_NAMING.titlePattern,
    titleWithSubtitle: typeof raw.titleWithSubtitle === "string" && raw.titleWithSubtitle.trim()
      ? raw.titleWithSubtitle.trim()
      : DEFAULT_CHAPTER_NAMING.titleWithSubtitle,
    requireSubtitle: raw.requireSubtitle === true,
    subtitleMaxLen,
    indexStyle: typeof raw.indexStyle === "string" && isChapterIndexStyle(raw.indexStyle)
      ? raw.indexStyle
      : DEFAULT_CHAPTER_NAMING.indexStyle,
    enforceHeading: raw.enforceHeading !== false,
  };
  if (preset !== "auto" && preset !== "custom") {
    return { preset, ...PRESET_TABLE[preset] };
  }
  return base;
}

export function expandChapterNamingSettings(settings: ChapterNamingSettings): Omit<ResolvedChapterNaming, "source"> {
  const normalized = normalizeChapterNamingSettings(settings);
  if (normalized.preset !== "auto" && normalized.preset !== "custom") {
    const preset = PRESET_TABLE[normalized.preset];
    return { ...preset, preset: normalized.preset };
  }
  return {
    pathPattern: normalized.pathPattern,
    indexPadWidth: normalized.indexPadWidth,
    titlePattern: normalized.titlePattern,
    titleWithSubtitle: normalized.titleWithSubtitle,
    requireSubtitle: normalized.requireSubtitle,
    subtitleMaxLen: normalized.subtitleMaxLen,
    indexStyle: normalized.indexStyle,
    enforceHeading: normalized.enforceHeading,
    preset: normalized.preset,
  };
}

function applyTemplate(pattern: string, tokens: ChapterNameTokens): string {
  return pattern
    .replaceAll("{indexPad}", tokens.indexPad)
    .replaceAll("{indexCn}", tokens.indexCn)
    .replaceAll("{index}", String(tokens.index))
    .replaceAll("{subtitleSlug}", tokens.subtitleSlug ?? "")
    .replaceAll("{subtitle}", tokens.subtitle ?? "");
}

export function chapterNameTokens(
  index: number,
  options: { indexPadWidth: number; subtitle?: string; subtitleMaxLen?: number },
): ChapterNameTokens {
  const pad = Math.min(4, Math.max(1, options.indexPadWidth || 2));
  const rawSub = (options.subtitle ?? "").trim().replace(/\s+/gu, " ");
  const maxLen = options.subtitleMaxLen ?? 16;
  const subtitle = rawSub ? rawSub.slice(0, maxLen) : undefined;
  const subtitleSlug = subtitle
    ? subtitle
      .replace(/[\\/:*?"<>|]+/gu, "")
      .replace(/\s+/gu, "-")
      .slice(0, maxLen)
    : undefined;
  return {
    index,
    indexPad: String(index).padStart(pad, "0"),
    indexCn: toChineseNumeral(index),
    ...(subtitle ? { subtitle } : {}),
    ...(subtitleSlug ? { subtitleSlug } : {}),
  };
}

export function formatChapterTitle(
  resolved: Pick<ResolvedChapterNaming, "titlePattern" | "titleWithSubtitle" | "indexPadWidth" | "subtitleMaxLen" | "indexStyle">,
  index: number,
  subtitle?: string,
): string {
  const tokens = chapterNameTokens(index, {
    indexPadWidth: resolved.indexPadWidth,
    subtitle,
    subtitleMaxLen: resolved.subtitleMaxLen,
  });
  // indexStyle only affects title tokens that use {index}/{indexPad}/{indexCn} as configured in patterns.
  if (resolved.indexStyle === "arabic") {
    // Keep patterns as authored; callers should use 第{index}章 in arabic preset.
  } else if (resolved.indexStyle === "padded-arabic") {
    // Patterns may use {indexPad}.
  }
  const pattern = tokens.subtitle ? resolved.titleWithSubtitle : resolved.titlePattern;
  return applyTemplate(pattern, tokens).replace(/\s+/gu, " ").trim();
}

export function formatChapterPath(
  resolved: Pick<ResolvedChapterNaming, "pathPattern" | "indexPadWidth" | "subtitleMaxLen">,
  index: number,
  subtitle?: string,
): string {
  const tokens = chapterNameTokens(index, {
    indexPadWidth: resolved.indexPadWidth,
    subtitle,
    subtitleMaxLen: resolved.subtitleMaxLen,
  });
  return applyTemplate(resolved.pathPattern, tokens)
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\//, "");
}

/** Parse chapter ordinal from common path shapes. */
export function parseChapterIndexFromPath(path: string): number | undefined {
  const normalized = path.replaceAll("\\", "/");
  const file = normalized.split("/").pop() ?? normalized;
  const patterns = [
    /^chapter-0*(\d+)\.md$/iu,
    /^ch0*(\d+)\.md$/iu,
    /^第0*(\d+)章(?:[-_.].*)?\.md$/u,
    /^0*(\d+)[-_.].+\.md$/u,
    /^0*(\d+)\.md$/u,
  ];
  for (const re of patterns) {
    const match = file.match(re);
    if (match) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  const cn = file.match(/^第([零〇一二两三兩叁四五六七八九壹贰肆伍陆柒捌玖十拾百佰千仟万萬]+)章/u);
  if (cn) {
    const n = parseChineseNumeral(cn[1]!);
    if (n != null && n > 0) return n;
  }
  return undefined;
}

export function parseChapterHeading(heading: string): { index?: number; subtitle?: string; raw: string } {
  const raw = heading.trim();
  const cn = raw.match(/^第([零〇一二两三兩叁四五六七八九壹贰肆伍陆柒捌玖十拾百佰千仟万萬\d]+)章(?:\s*[·:：—\-]?\s*(.+))?$/u);
  if (cn) {
    const indexPart = cn[1]!;
    const index = /^\d+$/u.test(indexPart) ? Number(indexPart) : parseChineseNumeral(indexPart) ?? undefined;
    const subtitle = cn[2]?.trim() || undefined;
    return {
      ...(index && index > 0 ? { index } : {}),
      ...(subtitle ? { subtitle } : {}),
      raw,
    };
  }
  const en = raw.match(/^chapter[-\s]?0*(\d+)(?:\s+(.+))?$/iu);
  if (en) {
    return {
      index: Number(en[1]),
      ...(en[2]?.trim() ? { subtitle: en[2].trim() } : {}),
      raw,
    };
  }
  return { raw };
}

/** True when H1 is clearly a machine path stem rather than a reader title. */
export function headingLooksLikeFilename(heading: string, path?: string): boolean {
  const raw = heading.trim();
  if (!raw) return true;
  if (/^chapter[-\s]?\d+$/iu.test(raw)) return true;
  if (/^ch\d+$/iu.test(raw)) return true;
  if (path) {
    const stem = path.split("/").pop()?.replace(/\.md$/iu, "") ?? "";
    if (stem && raw.toLowerCase() === stem.toLowerCase()) return true;
  }
  return false;
}

export function extractH1(content: string): string | undefined {
  const match = content.match(/^\s*#\s+(.+)$/mu);
  return match?.[1]?.trim();
}

export function replaceOrInsertH1(content: string, title: string): string {
  const heading = title.trim();
  if (!heading) return content;
  if (/^\s*#\s+/mu.test(content)) {
    return content.replace(/^\s*#\s+.+$/mu, `# ${heading}`);
  }
  const body = content.replace(/^\uFEFF?/, "");
  return body.trim() ? `# ${heading}\n\n${body.replace(/^\s+/, "")}` : `# ${heading}\n\n`;
}

/**
 * Soft-normalize first H1 for chapters/* when it is filename-like or empty.
 * Keeps intentional literary titles (e.g. 第四章 余波) unless requireSubtitle
 * forces regeneration from index only when heading is bad.
 */
export function normalizeChapterDocumentContent(
  path: string,
  content: string,
  resolved: ResolvedChapterNaming,
): { content: string; corrected: boolean; title?: string } {
  if (!path.replaceAll("\\", "/").startsWith("chapters/") || !path.toLowerCase().endsWith(".md")) {
    return { content, corrected: false };
  }
  if (!resolved.enforceHeading) return { content, corrected: false };

  const index = parseChapterIndexFromPath(path);
  if (!index) return { content, corrected: false };

  const h1 = extractH1(content);
  const parsed = h1 ? parseChapterHeading(h1) : { raw: "" };
  const bad = !h1 || headingLooksLikeFilename(h1, path);
  if (!bad) {
    // Already a reader title — leave alone.
    return { content, corrected: false, title: h1 };
  }

  const subtitle = parsed.subtitle && !headingLooksLikeFilename(parsed.subtitle)
    ? parsed.subtitle
    : undefined;
  if (resolved.requireSubtitle && !subtitle) {
    // Cannot invent subtitle; still fix pure filename H1 to ordinal-only title.
  }
  const title = formatChapterTitle(resolved, index, subtitle);
  const next = replaceOrInsertH1(content, title);
  return {
    content: next,
    corrected: next !== content,
    title,
  };
}

export function listChapterPaths(project: WriterProject): string[] {
  return project.listDocuments().filter(path => path.startsWith("chapters/") && path.toLowerCase().endsWith(".md"));
}

export function maxChapterIndex(paths: readonly string[]): number {
  let max = 0;
  for (const path of paths) {
    const index = parseChapterIndexFromPath(path);
    if (index && index > max) max = index;
  }
  return max;
}

export function nextChapterIndex(paths: readonly string[]): number {
  return maxChapterIndex(paths) + 1;
}

/** Infer pad width / path shape from existing files. */
export function inferChapterNamingFromPaths(paths: readonly string[]): Partial<ChapterNamingSettings> {
  const chapterPaths = paths.filter(path => path.startsWith("chapters/"));
  if (!chapterPaths.length) return {};

  let enPad = 0;
  let enCount = 0;
  let cnFileCount = 0;
  let cnPad = 0;

  for (const path of chapterPaths) {
    const file = path.split("/").pop() ?? "";
    const en = file.match(/^chapter-(\d+)\.md$/iu);
    if (en) {
      enCount += 1;
      enPad = Math.max(enPad, en[1]!.length);
      continue;
    }
    const cn = file.match(/^第(\d+)章(?:[-_.].*)?\.md$/u);
    if (cn) {
      cnFileCount += 1;
      cnPad = Math.max(cnPad, cn[1]!.length);
    }
  }

  if (enCount >= cnFileCount && enCount > 0) {
    return {
      preset: "custom",
      pathPattern: "chapters/chapter-{indexPad}.md",
      indexPadWidth: Math.min(4, Math.max(2, enPad || 2)),
      titlePattern: "第{indexCn}章",
      titleWithSubtitle: "第{indexCn}章 {subtitle}",
      indexStyle: "chinese",
    };
  }
  if (cnFileCount > 0) {
    return {
      preset: "custom",
      pathPattern: "chapters/第{indexPad}章.md",
      indexPadWidth: Math.min(4, Math.max(2, cnPad || 2)),
      titlePattern: "第{indexCn}章",
      titleWithSubtitle: "第{indexCn}章 {subtitle}",
      indexStyle: "chinese",
    };
  }
  return {};
}

export function resolveChapterNaming(
  settings: ChapterNamingSettings,
  project: WriterProject,
  options?: { sourceHint?: ResolvedChapterNaming["source"] },
): ResolvedChapterNaming {
  const normalized = normalizeChapterNamingSettings(settings);
  if (normalized.preset === "auto") {
    const inferred = inferChapterNamingFromPaths(listChapterPaths(project));
    if (Object.keys(inferred).length) {
      const merged = normalizeChapterNamingSettings({
        ...DEFAULT_CHAPTER_NAMING,
        ...inferred,
        preset: "custom",
        enforceHeading: normalized.enforceHeading,
        requireSubtitle: normalized.requireSubtitle,
        subtitleMaxLen: normalized.subtitleMaxLen,
      });
      const expanded = expandChapterNamingSettings(merged);
      return {
        ...expanded,
        source: options?.sourceHint ?? "inferred",
        preset: "auto",
      };
    }
    const fallback = expandChapterNamingSettings({ ...DEFAULT_CHAPTER_NAMING, preset: "cn-file-en" });
    return {
      ...fallback,
      enforceHeading: normalized.enforceHeading,
      requireSubtitle: normalized.requireSubtitle,
      source: options?.sourceHint ?? "default",
      preset: "auto",
    };
  }
  const expanded = expandChapterNamingSettings(normalized);
  return {
    ...expanded,
    source: options?.sourceHint ?? "settings",
  };
}

export function loadSessionChapterNaming(store: WriterStore, sessionId: string): ResolvedChapterNaming | undefined {
  try {
    const artifact = store.contextArtifact(sessionId, SESSION_LOCK_KEY);
    if (!artifact?.content) return undefined;
    const parsed = JSON.parse(artifact.content) as Partial<ResolvedChapterNaming>;
    if (!parsed || typeof parsed.pathPattern !== "string") return undefined;
    const normalized = normalizeChapterNamingSettings({
      preset: typeof parsed.preset === "string" && isChapterNamingPreset(parsed.preset) ? parsed.preset : "custom",
      pathPattern: parsed.pathPattern,
      indexPadWidth: parsed.indexPadWidth,
      titlePattern: parsed.titlePattern,
      titleWithSubtitle: parsed.titleWithSubtitle,
      requireSubtitle: parsed.requireSubtitle,
      subtitleMaxLen: parsed.subtitleMaxLen,
      indexStyle: parsed.indexStyle,
      enforceHeading: parsed.enforceHeading,
    });
    const expanded = expandChapterNamingSettings({ ...normalized, preset: "custom" });
    return {
      ...expanded,
      source: "session-lock",
      preset: typeof parsed.preset === "string" && isChapterNamingPreset(parsed.preset) ? parsed.preset : "custom",
    };
  } catch {
    return undefined;
  }
}

export function saveSessionChapterNaming(
  store: WriterStore,
  sessionId: string,
  resolved: ResolvedChapterNaming,
): void {
  const payload: ResolvedChapterNaming = {
    ...resolved,
    source: "session-lock",
  };
  const content = JSON.stringify(payload);
  store.saveContextArtifact(sessionId, {
    cacheKey: SESSION_LOCK_KEY,
    kind: "chapter_naming",
    sourceHash: store.project.hash(content),
    content,
    digest: `chapter-naming ${resolved.pathPattern} / ${resolved.titlePattern}`,
  });
}

/**
 * Resolve naming for a session: locked convention wins; otherwise settings (+auto
 * infer) and lock on first call so the rest of the conversation stays consistent.
 */
export function resolveSessionChapterNaming(
  project: WriterProject,
  store: WriterStore,
  sessionId: string,
  settings: ChapterNamingSettings,
  options?: { lock?: boolean },
): ResolvedChapterNaming {
  const locked = loadSessionChapterNaming(store, sessionId);
  if (locked) return locked;
  const resolved = resolveChapterNaming(settings, project);
  if (options?.lock !== false) {
    try {
      saveSessionChapterNaming(store, sessionId, resolved);
    } catch {
      // Non-fatal: still return resolved for this call.
    }
  }
  return {
    ...resolved,
    source: options?.lock === false ? resolved.source : "session-lock",
  };
}

export function suggestNextChapter(
  resolved: ResolvedChapterNaming,
  project: WriterProject,
  options?: { subtitle?: string; folder?: string },
): { index: number; path: string; title: string; heading: string } {
  const paths = listChapterPaths(project);
  const index = nextChapterIndex(paths);
  let path = formatChapterPath(resolved, index, options?.subtitle);
  if (options?.folder) {
    const folder = options.folder.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    const file = path.split("/").pop() ?? path;
    path = folder ? `${folder}/${file}` : path;
  }
  const title = formatChapterTitle(resolved, index, options?.subtitle);
  return { index, path, title, heading: title };
}

export function chapterNamingAgentPrompt(
  resolved: ResolvedChapterNaming,
  project: WriterProject,
): string {
  const next = suggestNextChapter(resolved, project);
  const padExample = String(next.index).padStart(resolved.indexPadWidth, "0");
  return [
    "章节命名（本会话锁定，须全程一致）：",
    `- 路径模板：${resolved.pathPattern}（例：${next.path}）`,
    `- 文内 H1：${resolved.requireSubtitle ? resolved.titleWithSubtitle : `${resolved.titlePattern} 或 ${resolved.titleWithSubtitle}`}`,
    `- 下一可用：path=${next.path} · title=# ${next.title}`,
    `- 序号示例：index=${next.index} · pad=${padExample} · 中文=${toChineseNumeral(next.index)}`,
    "- 禁止把文件名（如 chapter-02）当作 H1；已有章节改写时保持原 path。",
    resolved.enforceHeading ? "- 写入 chapters/ 时若 H1 为文件名形态，运行时会校正为规范标题。" : "- 标题校正已关闭；请自行保证 H1 与规范一致。",
    `- 约定来源：${resolved.source}${resolved.preset && resolved.preset !== "custom" ? ` · preset=${resolved.preset}` : ""}`,
  ].join("\n");
}

export function chapterNamingNeedsAgentContext(task: {
  documentProposalRequired?: boolean;
  mode?: string;
  targetPath?: string;
  documentDeliverables?: readonly string[];
}): boolean {
  if (task.mode === "write_scene" || task.mode === "rewrite") return true;
  if (task.documentProposalRequired) return true;
  if (task.targetPath?.startsWith("chapters/")) return true;
  if (task.documentDeliverables?.some(label => /章|chapter/i.test(label))) return true;
  return false;
}
