import { orderedChapterPaths, WriterProject } from "./project.js";
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
  /** Full rewrites use project prose for facts, never as unvalidated voice evidence. */
  excludeProjectVoice?: boolean;
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
 * Applies under every style template — keep genre flavor in templates, keep
 * anti-mechanical / anti-stacking hygiene here so all modes share one baseline.
 *
 * Prefer showing what good prose does; hard density limits for AI-stacking are
 * explicit because positive-only hints fail on “one sentence, ten events”.
 * Exit gates still catch residual mannerisms; this block is generation-time.
 */
export function naturalProseCraftPrompt(): string {
  return `自然叙事原则（服从项目样本与激活模板；正文按此写，出口门禁复核密度，无需自我说明「我在写自然」）：

【写活一场戏】
- 注意顺序：信息按当前视角人物实际会先注意、误判、回避的顺序出现；叙述距离贴近谁，就停在谁的感知里，不因解释方便跳进他人内心。
- 场景发动：尽早让人物为一个可辨认的眼前结果采取行动；阻力针对他的办法，每次应对都改变退路、代价、暴露、关系、信息或时间条件。
- 张力累积：让读者看清人物在乎什么、可能失去什么、还有多少选择，同时保留结果的不确定；用期限、信息差、承诺、两难与对手的有效反制逐步收紧选择。
- 转折余波：关键变化由此前行动招致；重大受挫或发现之后，按篇幅留出反应、权衡与决定，使人物的新决定成为下一步的原因。静场也改变理解、关系或选择。
- 对白意图：人物说话是为了索取、隐瞒、试探、拒绝、拖延或改变关系；设定让人物在行动里试错撞出来，旁人只在关键处补一句。禁止全员讲课腔、轮流播报设定/数据。
- 对白摩擦：不是每个问题都该被回答。让人回避、答非所问、抢在对方说完前打断、说到一半停住，或答一件对方没问的事；至少一次让说出口的和真正想说的不是同一件。连着两轮以上一问一答直给，写的就是会议纪要。
- 对白声线：每个常出场的人物有一处别人不会有的说话方式——句子的长短习惯、爱用或回避的说法、口头禅、称呼对方的方式、说不利索的地方；遮住提示语要能认出是谁，别让人物的辨识度全落在旁白的描述里。句长跟处境走：被逼问的人话变碎，占上风的人话变长，说不出口的人半句就停。对白可以短，但别整章都短——通篇几个字的应答是电报，不是克制。
- 细节取舍：每处细节至少承担空间、习惯、冲突、因果或伏笔之一；用此时此地才成立的物件、动作或感官，代替随处可用的气氛标签。
- 具体性检查：一句话若换掉人名地点仍能套进多数故事，就换成本场独有的说法或后果；没有有效信息就删。

【一拍一事 · 反 AI 网剧堆叠（硬约束）】
- 一句话只推进一个主要事件或一个主要判断；下一拍再写连带后果。不要在同一句里连塞设定名、编号、关系、原因、后果与情绪（预告片旁白腔）。
- 一段默认只服务一个场面节拍（看见→反应→行动→代价中的一两步）；不要用「同时/与此同时/一边…一边…/不仅…还…/并且」把多条线索焊进一句。
- 专名与设定词克制出场：同一段首次需要时用一个可感锚点，不要清单式连抛组织名、计划名、等级、协议、武器名。
- 叙述保持可读的人称与主语：谁在看、谁在动写清楚；勿为「利落」整段省略人称、压成简报或操作日志。
- 限制把「物件/环境名词＋一个短动作」反复切成独立节拍（如手机又震、车出隧道、雨刷继续响）。环境变化要么确实改变人物的感知、行动或局面，要么并入人物反应、因果或空间变化；省略施事、受事等必要成分时，须能从紧邻上下文唯一还原。偶发重音、对白抢白和指代清楚的话题链不受此限。
- 禁止把章节写成功能清单或 HUD（醒来→说明→测试→评分→收束；指令—执行—确认连环短段）。

【反生成感（对齐常见 LLM 痕迹，生成时主动避开）】
- 句长与段长要有起伏（burstiness）：静场绵延、冲突收短、关键处可单句成段；勿整章句长、段长像同一模子浇出来。
- 用词要有「意外感」：优先此时此地才成立的物件、误判与口癖；少用最稳妥的通用搭配与成串四字套话（检测器最爱的低困惑度路径）。
- 信息密度降下来：一段只让读者记住一件新事；其余背景、设定与关系推到需要时再露，勿「一句话塞十个概念」。
- 情绪深度靠反应与选择，不靠标签与器官读数（心口一沉/喉咙发紧连打）；对白有各自目的与句长，勿全员书面同一口气。
- 结构允许不对称与半句：有的段落只过门、只停顿、只听错一句；勿每段都「起承转合+金句收口」。

【反机械感】
1. 连续单句独立成段不得超过 3 个；默认 2—5 句成段，长短随压力变化，不要机械轮换长短句或强凑「三段式」。单句成段是重音，省着用才有力。
2. 同一信息、情绪、感官公式、因果或主题只写一次；同类高清感官比喻一章最多 1 次；不要用同义词连打、排比金句或「气氛+眼神+决心」三件套填满段落。
3. 精确读数、百分比、等级评分一章合计尽量 ≤3 处；其余写成可感后果（器物轻响、对方停顿、地板闷震），禁止正文变日志/状态栏。
4. 难过、发慌、羞耻、兴奋刚起时，先给半拍体感或动作；不要立刻接设定说明、成分百分比或作者总结把情绪冲掉。
5. 流程、测试、赶路、说明为主的段落之后，不要硬接「迈出了第一步/这就够了/新的开始」式升华；收在具体后果、关系余波或未决问题上。
6. 勿把能力表字段写进叙述（「未解锁」「档案上还锁着」等）；本场不能用的能力直接不写，或只写人物此刻可感的限制。

【篇章完整与衔接】
- 章首接住可用前文留下的动作、压力与未决问题，保持时间、地点、人物位置、伤势、持有物、已知信息和承诺一致；用新行动承接，不复述前情。
- 承担完整章节时，开头立住本章当前问题，中段让预期、优势、目标或关系发生实质偏转，结尾兑现这个局部问题的阶段性结果，并让结果产生新的约束、代价或选择。
- 已有下一章时，以其开场状态为离场边界：本章铺成通往它的因果条件，把下一章的事件与决定留给下一章发生。
- 完整收束允许谜团继续存在；章尾的牵引力来自已经发生的变化及其未完后果，而非把本章应有的结果截在发生之前。

【节奏与质感】
- 静场与情感段落里安排绵延的长句（常 25–50 字），让读者呼吸；紧张段落才收短。每数百字至少一个 30 字以上的绵延句。
- 关键信息落地后给半拍落点（动作、停顿、环境），再推进；保留朴素功能句与不对称。
- 恢复常用双音节（感觉/恢复/身体/冷意等），不为利落压成单字，除非是角色固定口癖或对白抢白。
- 幽默与张力来自关系错位与现场反应，不靠段子拼贴或全员抖机灵。`;
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
  sections.push(proseMannerismConstraintPrompt());
  sections.push(
    `提交前自检：${proseMannerismPreflightLine()}`
      + "关键身体/暴力/情欲不无故含蓄化（作者未要求收敛时）。"
      + "句长与对白占比贴近动态声线证据；人物语气可区分；动作有后果后不重复解释意义。",
  );

  return sections.join("\n\n");
}

/**
 * Per-turn voice evidence for agent dynamic-tail (after history/task).
 * CACHE: Always miss-priced — 范文 + one short project sample; no multi-chapter dumps.
 *
 * Continuation-anchor form: raw exemplar prose first, then the immediately
 * preceding project prose LAST, framed as the text being continued. Style
 * imitation research shows raw text + completion framing anchors voice far
 * better than instructions, and statistical style summaries do not anchor at
 * all — so no fingerprints here, just prose.
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
  if (examples.length) {
    // Long exemplars: each build samples a different paragraph-aligned window.
    sections.push(examples.map((item, index) => {
      const body = sampleProseWindow(item.content, 1_500, random);
      const notes = item.notes.trim() ? `（${item.notes.trim().slice(0, 120)}）` : "";
      return `［范文 ${index + 1}·《${item.title}》${notes}］\n${body}`;
    }).join("\n\n"));
  }
  if (projectSample) {
    sections.push(`［紧接本次写作之前的正文（来源：${projectSample.source}）——新正文从这里的声线自然续下去，句法与节奏保持同一支笔的手感］\n${projectSample.text}`);
  }
  return sections.join("\n\n");
}

/**
 * Style constraints for the isolated scene writer.
 *
 * The prose-only call used to receive NONE of this: no active template, no craft
 * baseline — every rule the Agent path treats as mandatory was silently dropped
 * on the one call that actually produces chapter text. Mannerism prohibitions are
 * deliberately still excluded: ISOLATED_WRITER_SYSTEM already carries them, and
 * re-pasting a prohibition wall raises the salience of the patterns it bans.
 */
export function isolatedWriterStyleDirectives(project: WriterProject): string {
  const config = project.config();
  const template = config.style ? project.styleTemplate(config.style) : undefined;
  const sections: string[] = [];
  if (template) {
    sections.push(`本作品的激活风格模板：${template.name}`, template.systemPromptAddition.trim());
  }
  sections.push(naturalProseCraftPrompt());
  return sections.join("\n\n");
}

export type IsolatedWriterVoiceEvidence = {
  /** Imitation target: user 范文 or template example. Never the project's own prose. */
  exemplar: string;
  /** Continuity anchor: the work's existing prose. Used only when no in-chapter seam exists. */
  continuation: string;
};

/**
 * Two voice slots with different jobs, for the isolated scene writer.
 *
 * These must not substitute for each other. The single-slot predecessor returned
 * project prose whenever any existed, so on every chapter after the first the
 * writer's only stylistic target was its own previous output — a self-imitation
 * loop that regresses to the mean the longer a work runs, which is exactly when
 * voice matters most. The exemplar now always comes from outside the draft; the
 * continuation slot carries seam continuity separately.
 *
 * Unlike the Agent's dynamic grounding block both return bare prose: no notes,
 * source paths or workflow text — the prose-only call gets evidence, not
 * instructions.
 */
export function isolatedWriterVoiceEvidence(
  project: WriterProject,
  store: WriterStore,
  targetPath?: string,
  random: () => number = Math.random,
  options?: { excludeProjectVoice?: boolean },
): IsolatedWriterVoiceEvidence {
  const config = project.config();
  const template = config.style ? project.styleTemplate(config.style) : undefined;
  const example = pickStyleExamples(store, template?.name, undefined, random)[0];
  const exemplar = example
    ? sampleProseWindow(example.content, 1_200, random)
    : "";
  const projectSample = pickProjectVoiceSample(
    project,
    targetPath,
    undefined,
    options?.excludeProjectVoice,
  );
  return { exemplar, continuation: projectSample ? projectSample.text.slice(-1_200) : "" };
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
