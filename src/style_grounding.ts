import { documentKind, WriterProject } from "./project.js";
import { proseMannerismConstraintPrompt, proseMannerismPreflightLine } from "./prose_quality.js";
import { WriterStore } from "./store.js";
import { getStyleTemplate } from "./templates.js";

/**
 * Style prompt cache split (see also PROMPT / PREFIX-CACHE CONTRACT in agent.ts):
 * - stableStyleGroundingPrompt → agent stable-prefix slot 4 (project template +
 *   default examples + craft/mannerism rules). Must not depend on targetPath /
 *   selection / this-turn sample windows.
 * - dynamicStyleGroundingPrompt → agent dynamic-tail slot 3 (chapter/selection
 *   voice evidence). OK to change every turn; keep short.
 * When adding style rules: put timeless constraints in stable; put live chapter
 * excerpts only in dynamic. Avoid duplicating the same long checklist in both.
 */

export type StyleGroundingOptions = {
  /** Writing-related task modes get full grounding; others get a lighter block or nothing. */
  intensive: boolean;
  targetPath?: string;
  exampleIds?: number[];
  /** Extra prose already in hand (selection, draft context) to prefer as voice anchor. */
  preferredSample?: string;
};

/** Craft rules for the stable style block (cacheable project-level guidance). */
export function naturalProseCraftPrompt(): string {
  return `自然叙事原则（服从项目样本；不要为了显得“自然”故意制造病句或随机变化）：
- 注意顺序：信息按当前视角人物实际会先注意、误判、回避的顺序出现。叙述距离一旦贴近某人，不因解释方便突然跳进他人内心。
- 场景推进：刺激必须引出反应、选择或代价，动作应改变人物关系、空间位置、掌握的信息或下一步可能性；不要写完动作又用旁白复述其意义。
- 细节取舍：每处细节至少承担空间定位、人物习惯、冲突、因果或伏笔之一。把“紧张、复杂、压迫感”等通用标签换成此时此地才成立的对象、动作或感官变化。
- 对白意图：人物说话是为了索取、隐瞒、试探、拒绝、拖延或改变关系，不是轮流播报设定。允许答非所问、半句、停顿和被动作打断，但须符合人物身份与当下目的。
- 节奏与留白：保留朴素功能句、轻重差和不对称；重要处才放慢或加强。不要每句都修辞、每段都转折、每个场景都总结，未说尽之处可由后续行动承接。
- 具体性检查：若一句话换掉人名和地点仍能无损套进多数故事（如泛泛的目光、气氛、情绪、决心），就把它落实为本场景独有的物件、说法、动作或后果；无有效信息则删除。
- 变化来自内容：句长、段长、修辞和对白密度随人物压力与事件节拍变化，并以样本分布为上限；不要机械轮换长短句、堆同义词或强凑“三段式”。`;
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
 * CACHE: Only `intensive` (and project-level template/examples) may affect output.
 * Do not read targetPath / preferredSample here — that belongs in dynamicStyleGroundingPrompt.
 * Empty intensive=false is replaced by a fixed placeholder in buildStableSystemPrefix.
 */
export function stableStyleGroundingPrompt(
  project: WriterProject,
  store: WriterStore,
  options: Pick<StyleGroundingOptions, "intensive">,
): string {
  if (!options.intensive) return "";

  const config = project.config();
  const template = config.style ? getStyleTemplate(config.style) : undefined;
  const examples = pickStyleExamples(store, template?.name);

  const sections: string[] = [
    "风格锚定（写正文 / 续写 / 改写时强制遵守；优先级：本项目既有正文声线 > 用户范文 > 风格模板范例 > 泛化文学建议）",
  ];

  if (template) {
    sections.push(
      `激活模板：${template.name}`,
      `模板约束：\n${template.systemPromptAddition.trim()}`,
      `模板声线指纹：${styleFingerprint(template.exampleContent, template.exampleNotes)}`,
    );
  } else {
    sections.push("未激活风格模板：以本项目既有正文与角色声线为准，避免切换成通用网文或翻译腔。");
  }

  if (examples.length) {
    const rendered = examples.map((item, index) => {
      const body = item.content.slice(0, 1_200);
      return `范文 ${index + 1}「${item.title}」${item.category ? `（${item.category}）` : ""}\n指纹：${styleFingerprint(item.content, item.notes)}\n${item.notes ? `备注：${item.notes.slice(0, 300)}\n` : ""}${body}${item.content.length > body.length ? "\n…" : ""}`;
    }).join("\n\n");
    sections.push(`正向范文（模仿节奏与声线，不要复述其情节）：\n${rendered}`);
  } else if (template?.exampleContent) {
    const body = template.exampleContent.slice(0, 1_200);
    sections.push(
      `模板正向范例（模仿节奏与声线，不要复述其情节）：\n${template.exampleNotes ? `备注：${template.exampleNotes}\n` : ""}${body}${template.exampleContent.length > body.length ? "\n…" : ""}`,
    );
  }

  sections.push(naturalProseCraftPrompt());

  // Constraint-first: mannerism rules before the model writes (reduces propose → reject loops).
  sections.push(proseMannerismConstraintPrompt());

  sections.push(`提交前自检：
1. 句长、段长、对白占比是否接近上方指纹（本项目样本优先）。
2. 人物用词是否符合身份与既有对白习惯；勿把所有角色写成同一语气。
3. 段落是否沿视角人物的注意顺序展开；是否为解释方便跳进了他人内心。
4. 动作是否产生可见后果；动作之后是否又重复解释意义。必要因果拆成独立句。
5. 对白是否各有目的与回避方式，而不是角色轮流完整播报信息。
6. 通用情绪、目光、气氛和总结句能否换成只属于本场景的动作、物件或后果；不能则删。
7. ${proseMannerismPreflightLine()}
8. 不引入样本、角色卡、lore 中未支撑的关键设定；空白处用可观察动作推进，勿用作者旁白补课。
9. 场景落在具体动作、决定、发现或未决问题上，避免段尾总结升华。
10. 直写检查：关键身体、暴力、情欲、脏话是否被无故换成含蓄说法或道德滤镜；作者未要求收敛时保持直接、具体。`);

  return sections.join("\n\n");
}

/**
 * Per-turn voice evidence for agent dynamic-tail (after history/task).
 * CACHE: Always miss-priced — prefer one short sample window over multi-chapter dumps.
 */
export function dynamicStyleGroundingPrompt(
  project: WriterProject,
  store: WriterStore,
  options: StyleGroundingOptions,
): string {
  if (!options.intensive) return "";
  const projectSample = pickProjectVoiceSample(project, options.targetPath, options.preferredSample);
  const selectedExamples = pickExplicitStyleExamples(store, options.exampleIds);
  if (!projectSample && !selectedExamples.length) return "";
  const sections = ["本轮动态声线证据（优先于固定模板；只学声线，不复述情节）："];
  if (projectSample) {
    sections.push(`本项目既有正文样本：\n---\n${projectSample.text}\n---\n来源：${projectSample.source} · 指纹：${styleFingerprint(projectSample.text, "")}`);
  }
  if (selectedExamples.length) {
    sections.push(selectedExamples.map((item, index) => {
      const body = item.content.slice(0, 1_200);
      return `任务指定范文 ${index + 1}《${item.title}》\n指纹：${styleFingerprint(item.content, item.notes)}\n${body}${item.content.length > body.length ? "\n…" : ""}`;
    }).join("\n\n"));
  }
  return sections.join("\n\n");
}

/** Lightweight fingerprint used in prompts (shared shape with agent creative context). */
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

function pickStyleExamples(
  store: WriterStore,
  templateName: string | undefined,
  exampleIds?: number[],
): Array<{ title: string; category: string; content: string; notes: string }> {
  const all = store.writingExamples();
  const wanted = new Set(exampleIds ?? []);
  const selected: typeof all = [];

  for (const id of wanted) {
    const hit = all.find((item) => item.id === id);
    if (hit && !hit.title.startsWith("[风格模板]")) selected.push(hit);
  }

  // Prefer non-template user examples for voice diversity.
  if (selected.length < 2) {
    for (const item of all) {
      if (item.title.startsWith("[风格模板]")) continue;
      if (selected.some((entry) => entry.id === item.id)) continue;
      selected.push(item);
      if (selected.length >= 2) break;
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
    .filter(item => wanted.has(item.id) && !item.title.startsWith("[风格模板]"))
    .slice(0, 2)
    .map(item => ({ title: item.title, content: item.content, notes: item.notes }));
}

function pickProjectVoiceSample(
  project: WriterProject,
  targetPath?: string,
  preferredSample?: string,
): { text: string; source: string } | undefined {
  const preferred = extractProseSample(preferredSample ?? "", 900);
  if (preferred) return { text: preferred, source: "本轮上下文/选区" };

  const candidates: string[] = [];
  if (targetPath && project.documentExists(targetPath) && !project.isDocumentHidden(targetPath)) {
    candidates.push(targetPath);
  }
  const chapters = project.listDocuments()
    .filter((path) => !project.isDocumentHidden(path) && documentKind(path) === "chapter")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
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
      const tail = extractProseSample(raw.slice(-2_400), 900);
      if (tail && tail.replace(/\s/g, "").length >= 80) {
        return { text: tail, source: path };
      }
      const body = extractProseSample(raw, 900);
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
