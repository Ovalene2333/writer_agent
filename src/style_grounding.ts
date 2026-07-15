import { documentKind, WriterProject } from "./project.js";
import { proseMannerismConstraintPrompt, proseMannerismPreflightLine } from "./prose_quality.js";
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
};

/**
 * Craft rules for the stable style block (cacheable project-level guidance).
 * Applies under every style template — keep genre flavor in templates, keep
 * anti-mechanical / anti-stacking hygiene here so all modes share one baseline.
 */
export function naturalProseCraftPrompt(): string {
  return `自然叙事原则（服从项目样本与激活模板；不要为了显得“自然”故意制造病句或随机变化）：

【活着写，不要“组装”】
- 注意顺序：信息按当前视角人物实际会先注意、误判、回避的顺序出现。叙述距离一旦贴近某人，不因解释方便突然跳进他人内心。
- 场景推进：刺激必须引出反应、选择或代价；动作应改变关系、位置、信息或下一步可能。禁止把章节写成功能清单（醒来→说明→测试→评分→收束）或「指令—执行—确认」连环短段。
- 对白意图：人物说话是为了索取、隐瞒、试探、拒绝、拖延或改关系，不是轮流播报设定、规则或数据。禁止全员讲课腔；设定优先让人物试错撞出来，旁人只在关键处插一句。
- 细节取舍：每处细节至少承担空间、习惯、冲突、因果或伏笔之一。把“紧张/复杂/压迫感”等通用标签换成此时此地才成立的对象、动作或感官。

【反机械感（全模板强制）】
1. 禁止机关枪短段：连续单句独立成段不得超过 3 个；默认 2—5 句中段，长短随压力变化，不要机械轮换长短句或强凑“三段式”。
2. 禁止无聊堆砌：同一信息、情绪、感官公式、因果或主题只写一次；同类高清感官比喻（“一根根纤维/放大镜式清晰”等）一章内最多 1 次；不要用同义词连打、排比金句或“气氛+眼神+决心”三件套填满段落。
3. 禁止数字/指标刷屏：精确读数、百分比、等级评分一章合计 ≤3 处（类型必需时也尽量压到后果感写法）；其余用可感后果（器物轻响、对方停顿、地板闷震），禁止正文变 HUD/日志。
4. 禁止解释掐情绪：难过、发慌、羞耻、兴奋刚起时，先给半拍体感或动作；禁止立刻接设定说明、成分百分比、系统提示或作者总结把情绪冲掉。
5. 禁止贴金句收尾：流程、测试、赶路、说明为主的段落之后，不要硬接“迈出了第一步/这就够了/新的开始”式升华；收在具体后果、关系余波或未决问题上。
6. 具体性检查：若一句话换掉人名地点仍能套进多数故事，就落实为本场独有的物件、说法、动作或后果；无有效信息则删。
7. 禁止角色卡/系统腔污染：勿把能力表字段写进叙述（「未解锁」「还锁着」「档案上…锁着」「专属武装还锁着」）；勿用「不是A，不是B——还锁着」点名否定列举未出场武装；本场不能用的能力直接不写，或只写人物此刻可感的限制（抬不起、唤不出、伤口还在），不要播报卡面状态。

【节奏与留白】
- 关键信息落地后给半拍落点（动作、停顿、环境），再推进；保留朴素功能句与不对称，未说尽处可由后续行动承接。
- 不要每句都修辞、每段都转折、每个场景都总结；幽默/张力来自关系错位与现场反应，不靠段子拼贴或全员抖机灵。`;
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
    "风格锚定（写正文 / 续写 / 改写时强制遵守；优先级：本轮动态声线证据 > 本项目既有正文 > 用户范文 > 风格模板 > 泛化建议）",
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

  // Compact craft + mannerism once here; do not re-paste into system / task workflows.
  sections.push(naturalProseCraftPrompt());
  sections.push(proseMannerismConstraintPrompt({ compact: true }));
  sections.push(`提交前自检：句长/对白占比贴近动态声线证据与上方指纹；人物语气可区分；动作产生后果后不重复解释；${proseMannerismPreflightLine()}；关键身体/暴力/情欲未无故含蓄化（作者未要求收敛时）。`);

  return sections.join("\n\n");
}

/**
 * Per-turn voice evidence for agent dynamic-tail (after history/task).
 * CACHE: Always miss-priced — 范文 + one short project sample; no multi-chapter dumps.
 */
export function dynamicStyleGroundingPrompt(
  project: WriterProject,
  store: WriterStore,
  options: StyleGroundingOptions,
): string {
  if (!options.intensive) return "";
  const config = project.config();
  const template = config.style ? project.styleTemplate(config.style) : undefined;
  const projectSample = pickProjectVoiceSample(project, options.targetPath, options.preferredSample);
  const catalogExamples = pickStyleExamples(store, template?.name, options.exampleIds);
  const selectedExamples = pickExplicitStyleExamples(store, options.exampleIds);
  // Prefer task-specified examples; otherwise default catalog / template seed (bodies only here).
  const examples = selectedExamples.length
    ? selectedExamples
    : catalogExamples.map(item => ({ title: item.title, content: item.content, notes: item.notes }));
  if (!projectSample && !examples.length && !template?.exampleContent) return "";

  const sections = ["本轮动态声线证据（优先于固定模板；只学声线，不复述情节）："];
  if (projectSample) {
    sections.push(`本项目既有正文样本：\n---\n${projectSample.text}\n---\n来源：${projectSample.source} · 指纹：${styleFingerprint(projectSample.text, "")}`);
  }
  if (examples.length) {
    sections.push(examples.map((item, index) => {
      const body = item.content.slice(0, 900);
      return `范文 ${index + 1}《${item.title}》\n指纹：${styleFingerprint(item.content, item.notes)}\n${body}${item.content.length > body.length ? "\n…" : ""}`;
    }).join("\n\n"));
  } else if (template?.exampleContent) {
    const body = template.exampleContent.slice(0, 900);
    sections.push(
      `模板正向范例：\n${template.exampleNotes ? `备注：${template.exampleNotes}\n` : ""}${body}${template.exampleContent.length > body.length ? "\n…" : ""}`,
    );
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
