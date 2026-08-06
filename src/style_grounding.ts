import { orderedChapterPaths, WriterProject } from "./project.js";
import { proseMannerismConstraintPrompt } from "./prose_quality.js";
import { proseRealizationContract } from "./prose_realization.js";
import { WriterStore } from "./store.js";

/**
 * Style prompt cache split (see also PROMPT / PREFIX-CACHE CONTRACT in agent.ts):
 * - stableStyleGroundingPrompt → agent stable-prefix slot 4 (project template
 *   constraints + craft/mannerism). Must be byte-stable across intensive/mode
 *   flips and must not depend on targetPath / selection / this-turn samples.
 * - dynamicStyleGroundingPrompt → agent dynamic-tail slot 3 (范文 bodies +
 *   chapter/selection voice evidence). Miss-priced; keep short.
 * When adding style rules: timeless constraints → stable; live prose samples →
 * dynamic. Never paste the same long checklist into both slots.
 */

export type StyleGroundingOptions = {
  /** Writing-related task modes get full grounding; others get a lighter block or nothing. */
  intensive: boolean;
  targetPath?: string;
  exampleIds?: number[];
  /** Extra prose already in hand (selection, draft context) to prefer as voice anchor. */
  preferredSample?: string;
  /** Full rewrites use project prose for facts, never as unvalidated voice evidence. */
  excludeProjectVoice?: boolean;
  /** Scene chains use recent project prose for continuity, not as a positive style exemplar. */
  projectSampleRole?: "voice_anchor" | "continuity";
  /** RNG for exemplar window sampling (tests inject a seeded fn). Defaults to Math.random. */
  random?: () => number;
};

/**
 * Random paragraph-aligned window from a long exemplar. Long 范文 are stored
 * whole; each prompt build samples a different slice so successive scenes see
 * different facets of the voice instead of overfitting one fixed excerpt. Only
 * used in the dynamic tail (always cache-miss), never in the stable prefix.
 */
export function sampleProseWindow(text: string, maxChars: number, random: () => number = Math.random): string {
  const cleaned = extractProseSample(text, Number.MAX_SAFE_INTEGER);
  if (cleaned.length <= maxChars) return cleaned;
  const paragraphs = cleaned.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean);
  // Last valid start keeps a full window available; +1 so every start is reachable.
  let tailLength = 0;
  let lastStart = paragraphs.length - 1;
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    tailLength += paragraphs[index].length + 2;
    if (tailLength >= maxChars) { lastStart = index; break; }
    lastStart = index;
  }
  const start = Math.min(lastStart, Math.floor(random() * (lastStart + 1)));
  const window: string[] = [];
  let used = 0;
  for (let index = start; index < paragraphs.length; index += 1) {
    const cost = paragraphs[index].length + (window.length ? 2 : 0);
    if (used + cost > maxChars && window.length) break;
    window.push(paragraphs[index]);
    used += cost;
  }
  return window.join("\n\n");
}

/**
 * Craft rules for the stable style block (cacheable project-level guidance).
 * Applies under every style template. Keep genre flavor in templates and the
 * small shared craft baseline here so all writing modes start from one source.
 */
export function naturalProseCraftPrompt(): string {
  return `自然叙事核心（项目原文与作者范文优先；这些原则只在没有更具体声线证据时提供方向）：
- 贴住当前视角人物的注意力。信息按人物会看见、误会、回避和确认的顺序出现，不为解释方便越过认知边界。
- 场景从人物此刻想完成的事情生长。行动招来阻力或回应，变化留下足以影响下一步的事实、关系或选择；静场也可以只完成理解与关系上的细微移动。
- 选择真正参与现场的细节。物件、环境、技术与感官应被人物使用、承受或误读，而不是作为设定清单陈列。
- 对白是人物在关系中采取的行动。直说、回避、沉默、玩笑或解释都可以，只要符合说话者的目的、知识与处境；人物差异首先来自各自在意和不愿承认的东西。说出口的直接对白统一使用「……」，其中嵌套引文使用『……』。
- 节奏服从现场。叙述需要展开时让句子自然延伸，压力逼近时可以收紧；段落在动作、发现、停顿或余波真正落定时结束，不按固定长短配额排列。
- 已经由动作、对白或后果传达的意义不必再解释。需要说明时只补充会改变理解或行动的新事实。
- 完整章节兑现本章承担的变化，并从结果自然留下后续条件；是否需要悬问、损失、和解或平静收束，由本章目标决定。`;
}

/**
 * Dedicated style / voice grounding block for writing stability.
 * Priority: project existing prose > user writing examples > active style template example.
 * Templates supply rhythm rules; live chapter samples keep long-form voice consistent.
 */
export function styleGroundingPrompt(
  project: WriterProject,
  store: WriterStore,
  options: StyleGroundingOptions,
): string {
  return [
    stableStyleGroundingPrompt(project, store, options),
    dynamicStyleGroundingPrompt(project, store, options),
  ].filter(Boolean).join("\n\n");
}

/**
 * Project-stable style block for agent stable-prefix slot 4.
 * CACHE: Output must be independent of intensive / targetPath / preferredSample /
 * exampleIds so brainstorm→write→audit turns share the same prefix bytes.
 * 范文 bodies and chapter windows belong in dynamicStyleGroundingPrompt.
 */
export function stableStyleGroundingPrompt(
  project: WriterProject,
  _store: WriterStore,
  _options?: Pick<StyleGroundingOptions, "intensive">,
): string {
  const config = project.config();
  const template = config.style ? project.styleTemplate(config.style) : undefined;

  const sections: string[] = [
    "风格锚定（写正文 / 续写 / 改写时强制遵守；优先级：本轮动态声线证据中的原文片段 > 风格模板 > 泛化建议。声线学习以读原文为准，不以任何统计描述为准）",
  ];

  if (template) {
    sections.push(
      `激活模板：${template.name}`,
      `模板约束：\n${template.systemPromptAddition.trim()}`,
    );
  } else {
    sections.push("未激活风格模板：以本轮动态声线证据中的原文片段为准，避免切换成通用网文或翻译腔。");
  }

  // Craft + full mannerism once in the stable style slot; workflows only cross-ref preflight.
  sections.push(naturalProseCraftPrompt());
  sections.push(proseRealizationContract());
  sections.push(proseMannerismConstraintPrompt());

  return sections.join("\n\n");
}

/**
 * Per-turn voice evidence for agent dynamic-tail (after history/task).
 * CACHE: Always miss-priced — 范文 + one short project sample; no multi-chapter dumps.
 *
 * Normal form keeps the immediately preceding prose last as a voice anchor.
 * Scene-chain form marks it as continuity-only and puts approved exemplars last:
 * a recently generated chapter may contain the exact defect being corrected and
 * must not become the next chapter's sole positive demonstration.
 */
export function dynamicStyleGroundingPrompt(
  project: WriterProject,
  store: WriterStore,
  options: StyleGroundingOptions,
): string {
  if (!options.intensive) return "";
  const config = project.config();
  const template = config.style ? project.styleTemplate(config.style) : undefined;
  const random = options.random ?? Math.random;
  const projectSample = pickProjectVoiceSample(
    project,
    options.targetPath,
    options.preferredSample,
    options.excludeProjectVoice,
  );
  const catalogExamples = pickStyleExamples(store, template?.name, options.exampleIds, random);
  const selectedExamples = pickExplicitStyleExamples(store, options.exampleIds);
  // Prefer task-specified examples; otherwise default catalog / template seed (bodies only here).
  const examples = selectedExamples.length
    ? selectedExamples
    : catalogExamples.map(item => ({ title: item.title, content: item.content, notes: item.notes }));
  if (!projectSample && !examples.length) return "";

  const sections = ["本轮动态声线证据（只学句法、节奏与叙述姿态，不复述其中内容）："];
  const exemplarSection = examples.length
    ? examples.map((item, index) => {
      const body = sampleProseWindow(item.content, 1_500, random);
      const notes = item.notes.trim() ? `（${item.notes.trim().slice(0, 120)}）` : "";
      return `［正向范文 ${index + 1}·《${item.title}》${notes}］\n${body}`;
    }).join("\n\n")
    : "";
  const continuityOnly = options.projectSampleRole === "continuity";
  const projectSection = projectSample
    ? continuityOnly
      ? `［最近正文连续性材料（来源：${projectSample.source}）——只承接人物称谓、叙述距离、现场状态和语域；它未经风格验收，不模仿其中重复段首、固定句长或短对白节拍］\n${projectSample.text}`
      : `［紧接本次写作之前的正文（来源：${projectSample.source}）——新正文从这里的声线自然续下去，句法与节奏保持同一支笔的手感］\n${projectSample.text}`
    : "";
  if (continuityOnly) {
    if (projectSection) sections.push(projectSection);
    if (exemplarSection) sections.push(exemplarSection);
  } else {
    if (exemplarSection) sections.push(exemplarSection);
    if (projectSection) sections.push(projectSection);
  }
  return sections.join("\n\n");
}

/**
 * Lightweight rhythm fingerprint. No longer injected into writing prompts
 * (statistical style summaries do not anchor imitation — raw prose does);
 * kept for diagnostics, tests and potential UI display.
 */
export function styleFingerprint(content: string, notes: string): string {
  const paragraphs = content.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const sentences = content.split(/[。！？!?]+/).map((item) => item.trim()).filter(Boolean);
  const sentenceLengths = sentences.map(proseLength).filter(length => length > 0);
  const paragraphLengths = paragraphs.map(proseLength).filter(length => length > 0);
  const averageSentenceLength = average(sentenceLengths);
  const medianSentenceLength = percentile(sentenceLengths, 0.5);
  const upperSentenceLength = percentile(sentenceLengths, 0.8);
  const dialogueParagraphs = paragraphs.filter((item) => /^[“「『"']/.test(item)).length;
  const dialogueRatio = paragraphs.length ? Math.round((dialogueParagraphs / paragraphs.length) * 100) : 0;
  const singleSentenceParagraphs = paragraphs.filter(item =>
    item.split(/[。！？!?]+/).map(part => part.trim()).filter(Boolean).length <= 1,
  ).length;
  const singleSentenceRatio = paragraphs.length ? Math.round((singleSentenceParagraphs / paragraphs.length) * 100) : 0;
  const avgParagraphChars = average(paragraphLengths);
  const shortSentenceRatio = sentenceLengths.length
    ? Math.round((sentenceLengths.filter(length => length <= 12).length / sentenceLengths.length) * 100)
    : 0;
  const longSentenceRatio = sentenceLengths.length
    ? Math.round((sentenceLengths.filter(length => length >= 30).length / sentenceLengths.length) * 100)
    : 0;
  const commaCount = (content.match(/[，,；;]/g) ?? []).length;
  const commaRhythm = sentences.length ? (commaCount / sentences.length).toFixed(1) : "0.0";
  const rhythm = averageSentenceLength <= 16 ? "短促" : averageSentenceLength >= 32 ? "绵长" : "长短适中";
  const density = avgParagraphChars <= 80 ? "段落偏短" : avgParagraphChars >= 200 ? "段落偏长" : "段落适中";
  return `句法节奏=${rhythm}；句长均值≈${averageSentenceLength}字/中位≈${medianSentenceLength}字/八成不超过≈${upperSentenceLength}字；短句(≤12字)≈${shortSentenceRatio}%/长句(≥30字)≈${longSentenceRatio}%；${density}(均值≈${avgParagraphChars}字)；单句段≈${singleSentenceRatio}%；对白起始段≈${dialogueRatio}%；每句逗号/分号≈${commaRhythm}${notes.trim() ? `；显式要求=${notes.trim().slice(0, 300)}` : ""}`;
}

function proseLength(value: string): number {
  return [...value.replace(/\s/g, "")].length;
}

function average(values: number[]): number {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

/**
 * Placeholder exemplars（占位条目，等作者粘贴正文）must never reach a prompt:
 * skip entries that still carry the placeholder marker or have no real prose.
 */
export function isPlaceholderStyleExample(example: { content: string }): boolean {
  if (example.content.includes("【范文占位】")) return true;
  return example.content.replace(/\s/g, "").length < 120;
}

function pickStyleExamples(
  store: WriterStore,
  templateName: string | undefined,
  exampleIds?: number[],
  random: () => number = Math.random,
): Array<{ title: string; category: string; content: string; notes: string }> {
  const all = store.writingExamples().filter(item => item.gatePassed && !isPlaceholderStyleExample(item));
  const wanted = new Set(exampleIds ?? []);
  const selected: typeof all = [];

  for (const id of wanted) {
    const hit = all.find((item) => item.id === id);
    if (hit && !hit.title.startsWith("[风格模板]")) selected.push(hit);
  }

  // Fill from non-template user examples, sampled randomly so a 3+ item 范文库
  // rotates across turns instead of always showing the same two entries.
  if (selected.length < 2) {
    const pool = all.filter(item =>
      !item.title.startsWith("[风格模板]") && !selected.some(entry => entry.id === item.id));
    while (selected.length < 2 && pool.length) {
      const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
      selected.push(pool.splice(index, 1)[0]);
    }
  }

  // Fall back to seeded style-template example once.
  if (!selected.length && templateName) {
    const seeded = all.find((item) => item.title === `[风格模板] ${templateName}`);
    if (seeded) selected.push(seeded);
  }

  return selected.slice(0, 2).map((item) => ({
    title: item.title,
    category: item.category,
    content: item.content,
    notes: item.notes,
  }));
}

function pickExplicitStyleExamples(
  store: WriterStore,
  exampleIds?: number[],
): Array<{ title: string; content: string; notes: string }> {
  if (!exampleIds?.length) return [];
  const wanted = new Set(exampleIds);
  return store.writingExamples()
    .filter(item => item.gatePassed && wanted.has(item.id) && !item.title.startsWith("[风格模板]"))
    .slice(0, 2)
    .map(item => ({ title: item.title, content: item.content, notes: item.notes }));
}

function pickProjectVoiceSample(
  project: WriterProject,
  targetPath?: string,
  preferredSample?: string,
  excludeProjectVoice = false,
): { text: string; source: string } | undefined {
  const preferred = extractProseSample(preferredSample ?? "", 1_200);
  if (preferred) return { text: preferred, source: "本轮上下文/选区" };
  if (excludeProjectVoice) return undefined;

  const candidates: string[] = [];
  if (targetPath && project.documentExists(targetPath) && !project.isDocumentHidden(targetPath)) {
    candidates.push(targetPath);
  }
  const chapters = orderedChapterPaths(project);
  if (targetPath) {
    const index = chapters.indexOf(targetPath);
    if (index > 0) candidates.push(chapters[index - 1]);
  }
  for (const path of chapters.slice(-3).reverse()) {
    if (!candidates.includes(path)) candidates.push(path);
  }

  for (const path of candidates) {
    try {
      const raw = project.read(path);
      // Prefer ending (voice continuity for续写); fall back to a mid window if ending is tiny.
      const tail = extractProseSample(raw.slice(-3_000), 1_200);
      if (tail && tail.replace(/\s/g, "").length >= 80) {
        return { text: tail, source: path };
      }
      const body = extractProseSample(raw, 1_200);
      if (body && body.replace(/\s/g, "").length >= 80) {
        return { text: body, source: path };
      }
    } catch {
      /* skip unreadable */
    }
  }
  return undefined;
}

/** Strip heavy heading-only / front-matter noise; keep a readable prose window. */
export function extractProseSample(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  const withoutCode = normalized.replace(/```[\s\S]*?```/g, "\n");
  const lines = withoutCode.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^#{1,6}\s/.test(trimmed)) return false;
    if (/^---+$/.test(trimmed)) return false;
    return true;
  });
  const joined = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (joined.length <= maxChars) return joined;
  // Take from the end to preserve latest voice for continuation.
  const slice = joined.slice(-maxChars);
  const cut = slice.search(/[。！？!?\n]/);
  return (cut > 0 && cut < 80 ? slice.slice(cut + 1) : slice).trim();
}

export function isIntensiveWritingMode(mode: string): boolean {
  return mode === "write_scene" || mode === "rewrite" || mode === "write" || mode === "continue"
    || mode === "rewrite_document" || mode === "polish";
}
