import { documentKind, WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { getStyleTemplate } from "./templates.js";

export type StyleGroundingOptions = {
  /** Writing-related task modes get full grounding; others get a lighter block or nothing. */
  intensive: boolean;
  targetPath?: string;
  exampleIds?: number[];
  /** Extra prose already in hand (selection, draft context) to prefer as voice anchor. */
  preferredSample?: string;
};

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

/** Project-stable rules and default examples. Keep this before all per-turn context for KV-cache reuse. */
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

  sections.push(`提交前自检：
1. 句长、段长、对白占比是否接近上方指纹（本项目样本优先）。
2. 人物用词是否符合身份与既有对白习惯；勿把所有角色写成同一语气。
3. 动作之后不重复解释意义；让细节供读者判断，必要因果拆成独立句。保留人物对白中的拖音、中断、迟疑和真实纠正。
4. 不引入样本、角色卡、lore 中未支撑的关键设定；空白处用可观察动作推进，勿用作者旁白补课。
5. 场景落在具体动作、决定、发现或未决问题上，避免段尾总结升华。
6. 直写检查：关键身体、暴力、情欲、脏话是否被无故换成含蓄说法或道德滤镜；作者未要求收敛时保持直接、具体。`);

  return sections.join("\n\n");
}

/** Per-turn voice evidence. It intentionally follows history/task data because it changes frequently. */
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
  const averageSentenceLength = sentences.length
    ? Math.round(sentences.reduce((sum, item) => sum + item.length, 0) / sentences.length)
    : 0;
  const dialogueParagraphs = paragraphs.filter((item) => /^[“「『"']/.test(item)).length;
  const dialogueRatio = paragraphs.length ? Math.round((dialogueParagraphs / paragraphs.length) * 100) : 0;
  const avgParagraphChars = paragraphs.length
    ? Math.round(paragraphs.reduce((sum, item) => sum + item.length, 0) / paragraphs.length)
    : 0;
  const rhythm = averageSentenceLength <= 16 ? "短促" : averageSentenceLength >= 32 ? "绵长" : "长短适中";
  const density = avgParagraphChars <= 80 ? "段落偏短" : avgParagraphChars >= 200 ? "段落偏长" : "段落适中";
  return `句法节奏=${rhythm}；平均句长≈${averageSentenceLength}字；${density}；对白段落≈${dialogueRatio}%${notes.trim() ? `；显式要求=${notes.trim().slice(0, 300)}` : ""}`;
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
