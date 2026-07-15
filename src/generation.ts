import type { AgentEvent, Character, ModelConfig, StepUsage, UsageSummary } from "./types.js";
import { WriterProject } from "./project.js";
import { WriterStore } from "./store.js";
import { logModelRequest, logModelResponse } from "./model_debug.js";
import {
  analyzeProseStyle,
  contrastStyleError,
  proseMannerismConstraintPrompt,
  proseMannerismPreflightLine,
  type ProseStyleIssue,
} from "./prose_quality.js";
import { adjudicateProseStyleForAudit } from "./prose_adjudicate.js";
import { isIntensiveWritingMode, styleGroundingPrompt } from "./style_grounding.js";
import { calculateUsageCost } from "./pricing.js";
import { modelSupportsToolChoice } from "./model_compat.js";
import { modelFetch } from "./model_fetch.js";
import { characterPromptViews, emptyCharacter, normalizeV3Character } from "./characters.js";
import { OutlineStore } from "./outline.js";
import { compileWritePack, formatWritePackForWriter, writePackDraftContractPrompt } from "./write_pack.js";

export type WritingMode = "write" | "continue" | "rewrite" | "rewrite_document" | "polish";
export type ActionMode = WritingMode | "character";
export type ActionSuggestion = {
  mode: ActionMode;
  label: string;
  reason: string;
  characterId?: number;
  documentPaths?: string[];
};

export async function suggestActions(input: {
  model: ModelConfig;
  request: string;
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
  documents: string[];
  activePath?: string;
  hasSelection: boolean;
  characters: Array<{ id: number; name: string; aliases: string[] }>;
  signal?: AbortSignal;
}): Promise<ActionSuggestion[]> {
  if (!input.request.trim()) throw new Error("请求不能为空");
  if (input.activePath && requestsWholeDocumentRewrite(input.request)) {
    return [{
      mode: "rewrite_document",
      label: "修改全文档",
      reason: "指令明确要求修改当前完整文档",
    }];
  }
  const result = await completeText(input.model, [
    { role: "system", content: `你是写作应用的意图路由器，只负责提出可执行动作，不创作正文，也不修改数据。只输出 JSON 数组，包含 1 到 3 个对象。对象字段：mode（只能是 write/continue/rewrite/rewrite_document/polish/character）、label（简短中文按钮文案）、reason（不超过40字）、characterId（仅修改已有角色时使用，必须来自给定角色列表）、documentPaths（可选字符串数组）。规则：新建正文用 write；接续当前文档用 continue；修改选区内容用 rewrite；修改当前完整文档用 rewrite_document；仅改善选区语言用 polish；创建或修改角色资料用 character。rewrite_document 只有存在 activePath 时才能提出，且不要求文本选区。处理角色卡时，根据用户要求可从给定 documents 中选择最多 5 个可能相关的 lore/设定 或 outline/大纲 文档放入 documentPaths（优先 lore/ 与 outline/，不要选 archive 旧稿）；不需要资料时返回空数组。conversation 是当前请求之前的最近对话。必须结合它判断省略的操作对象和指代：若用户正在创建或修改角色卡，后续补充、调整、确认等请求仍应路由到 character；对话中提到的世界观或参考文档不代表要切换为正文或文档编辑。仅在用户明确改变任务时切换模式。不要发明文档、角色 ID 或其他工具。` },
    { role: "user", content: JSON.stringify({ request: input.request, conversation: input.conversation?.slice(-12) ?? [], activePath: input.activePath || null, hasSelection: input.hasSelection, documents: input.documents.slice(0, 100), characters: input.characters.slice(0, 100) }) },
  ], input.signal);
  const value = parseJsonArray(result.content);
  const validModes = new Set<ActionMode>(["write", "continue", "rewrite", "rewrite_document", "polish", "character"]);
  const characterIds = new Set(input.characters.map(item => item.id));
  const documents = new Set(input.documents);
  const suggestions = value.slice(0, 3).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const mode = raw.mode as ActionMode;
    if (!validModes.has(mode)) return [];
    if ((mode === "continue" || mode === "rewrite" || mode === "rewrite_document" || mode === "polish") && !input.activePath) return [];
    if ((mode === "rewrite" || mode === "polish") && !input.hasSelection) return [];
    const characterId = Number(raw.characterId);
    return [{
      mode,
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 24) : defaultActionLabel(mode),
      reason: typeof raw.reason === "string" ? raw.reason.trim().slice(0, 80) : "",
      ...(mode === "character" && characterIds.has(characterId) ? { characterId } : {}),
      ...(mode === "character" && Array.isArray(raw.documentPaths) ? {
        documentPaths: raw.documentPaths.filter((path): path is string => typeof path === "string" && documents.has(path)).slice(0, 5),
      } : {}),
    }];
  });
  return suggestions.length ? suggestions : [{ mode: input.activePath ? "continue" : "write", label: input.activePath ? "续写当前文档" : "新写正文", reason: "根据当前编辑上下文执行" }];
}

function requestsWholeDocumentRewrite(request: string): boolean {
  const text = request.trim().replace(/\s+/g, "");
  const editIntent = /(?:修改|改写|重写|调整|优化|修订|润色|完善|精简|扩写|重构|统一|检查并修改)/u;
  const wholeDocumentScope = /(?:全文档|全文|整个文档|整份文档|当前文档|这篇文档|本文档|整篇|通篇|全文内容|本章|整章|整篇文章|整篇正文|wholedocument|entiredocument)/iu;
  const genericDocumentRequest = /(?:修改|改写|重写|调整|优化|修订|润色|完善)(?:一下|下)?(?:当前|这篇|本文)?(?:文档|文章|正文)(?:吧|。|！|!)?$/u;
  const localScope = /(?:选区|所选|这段|这一段|该段|第[一二三四五六七八九十\d]+段|这句|该句|标题|开头|结尾|某一段|局部)/u;
  return !localScope.test(text) && ((editIntent.test(text) && wholeDocumentScope.test(text)) || genericDocumentRequest.test(text));
}

export interface GenerateWritingOptions {
  project: WriterProject;
  store: WriterStore;
  draftModel: ModelConfig;
  model: ModelConfig;
  summaryModel?: ModelConfig;
  sessionId: string;
  mode: WritingMode;
  instruction: string;
  path?: string;
  selection?: string;
  characterIds?: number[];
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export async function generateWriting(options: GenerateWritingOptions): Promise<void> {
  const emit = async (event: AgentEvent) => { await options.onEvent?.(event); };
  const pending = options.store.writingDraft(options.sessionId);
  const effective = pending
    ? { ...options, mode: pending.mode as WritingMode, instruction: pending.instruction, path: pending.path, selection: pending.selection }
    : options;
  validateWritingRequest(effective);
  const before = effective.path && effective.project.documentExists(effective.path)
    ? effective.project.read(effective.path)
    : "";
  const characters = selectedCharacters(effective.store, effective.characterIds);
  options.store.addMessage(options.sessionId, "user", options.instruction.trim());
  try {
    if (!pending || !isDraftConfirmation(options.instruction)) {
      await emit({ type: "step_start", step: 1 });
      const draftBase = pending
        ? { ...options, mode: pending.mode as WritingMode, instruction: pending.instruction, path: pending.path, selection: pending.selection }
        : options;
      const draftBefore = draftBase.path && draftBase.project.documentExists(draftBase.path) ? draftBase.project.read(draftBase.path) : "";
      const draftResult = await buildWritingDraft(draftBase, draftBefore, async (name) => {
        await emit({ type: "tool", name });
      }, pending ? { draft: pending.draft, revision: options.instruction } : undefined);
      draftBase.store.saveWritingDraft(draftBase.sessionId, {
        mode: draftBase.mode, instruction: draftBase.instruction, path: draftBase.path,
        selection: draftBase.selection, draft: draftResult.draft,
      });
      if (draftResult.usage) {
        await emit(buildUsageEvent(draftBase.store, draftBase.sessionId, draftBase.draftModel, draftResult.usage, 1));
      }
      const report = `${pending ? "草案已修改" : "写作草案已生成"}：\n\n${draftResult.draft}\n\n回复修改要求可继续调整草案；回复“确认开写”后才会调用正文模型。`;
      draftBase.store.addMessage(draftBase.sessionId, "assistant", report);
      await emit({ type: "text", text: report, channel: "output" });
      await emit({ type: "step_done", step: 1 });
      await emit({ type: "done", sessionId: draftBase.sessionId });
      return;
    }
    await emit({ type: "step_start", step: 1 });
    const messages = writingMessages(effective, before, characters, pending.draft);
    const result = await streamText(effective.model, messages, effective.signal, async text => {
      await emit({ type: "text", text, channel: "output" });
    });
    let generated = cleanModelText(result.content);
    if (!generated) throw new Error("模型没有返回正文");
    const usages = result.usage ? [result.usage] : [];
    const repaired = await repairGeneratedProse(effective.model, generated, effective.signal);
    if (repaired.changed) {
      generated = repaired.text;
      usages.push(...repaired.usages);
      await emit({ type: "text", text: `\n\n[已局部修订 ${repaired.repairedIssues} 处高置信度说明式写法]`, channel: "output" });
    }
    const styleError = contrastStyleError(generated);
    if (styleError) throw new Error(styleError);
    const path = targetPath(effective);
    const after = applyGeneratedText(effective.mode, before, effective.selection, generated);
    const proposal = effective.store.createProposal(effective.sessionId, path, after, proposalSummary(effective.mode));
    effective.store.clearWritingDraft(effective.sessionId);
    const fallbackSummary = `已生成${modeLabel(effective.mode)}提案：${path}`;
    const summary = await safeChangeSummary(effective.summaryModel ?? effective.model, {
      kind: "document", action: modeLabel(effective.mode), target: path, instruction: effective.instruction,
      before: summaryBefore(effective.mode, before, effective.selection), after: summaryAfter(effective.mode, generated),
    }, fallbackSummary, effective.signal);
    effective.store.addMessage(effective.sessionId, "assistant", summary);
    await emit({ type: "text", text: `\n\n${summary}`, channel: "output" });
    const totalUsage = sumModelUsage(usages);
    if (totalUsage) {
      await emit(buildUsageEvent(effective.store, effective.sessionId, effective.model, totalUsage, 1));
    }
    await emit({ type: "proposal", proposal });
    await emit({ type: "step_done", step: 1 });
    await emit({ type: "done", sessionId: effective.sessionId });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      await emit({ type: "cancelled", sessionId: options.sessionId });
      return;
    }
    await emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function generateCharacter(input: {
  model: ModelConfig;
  description: string;
  existing?: Partial<Character>;
  project?: WriterProject;
  allowedDocumentPaths?: string[];
  onTool?: (name: string, path: string) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<Omit<Character, "id" | "updatedAt">> {
  if (!input.description.trim()) throw new Error("角色描述不能为空");
  const messages: ToolLoopMessage[] = [
    { role: "system", content: `你是小说角色设计助手。只输出 schema v3 JSON 对象，不要 Markdown。顶层字段为 identity/profile/psychology/motivations/voice/competencies/storyStates/experiences/notes；结构化条目必须有稳定 ASCII id，演进记录包含 status/sourceRefs/validFrom/validUntil。competencies 每项必须填写 name、summary 和 unlocked；summary 是无论是否解锁都会展示的简短能力概述，详细机制写入 description 等其他字段。unlocked 表示当前剧情进度下是否已解锁：更新现有卡时默认保持原值；只有用户要求或已提供的确定剧情事实明确发生获得、觉醒、学会、恢复、封印或失去时才改变，伏笔、传闻、失败尝试或单纯提及不能改变它。experiences 为已确认经历条目（id/label/description，可选 sourceRefs/validFrom），不是 biography 散文。只填写用户已提供或可可靠归纳的事实，未知内容留空；不要自行拆解或补写事实，不要输出 relationships。identity.name 必须提供。` },
    { role: "user", content: `${input.existing ? `现有角色卡：\n${JSON.stringify(input.existing)}\n\n` : ""}${input.allowedDocumentPaths?.length ? `获准读取的参考文档：${input.allowedDocumentPaths.join("、")}\n` : "没有获准读取的参考文档。\n"}要求：${input.description.trim()}` },
  ];
  const result = input.project && input.allowedDocumentPaths?.length
    ? await runReadOnlyToolLoop(input.model, messages, input.project, input.allowedDocumentPaths, input.signal, input.onTool)
    : await completeText(input.model, messages, input.signal);
  const parsed = parseJsonObject(result.content);
  return normalizeCharacterDraft(parsed);
}

export async function summarizeCharacterCompetency(input: {
  model: ModelConfig;
  competency: {
    name?: string;
    level?: string;
    description?: string;
    resources?: string[];
    limitations?: string[];
    costs?: string[];
  };
  signal?: AbortSignal;
}): Promise<string> {
  const competency = {
    name: String(input.competency.name ?? "").trim().slice(0, 160),
    level: String(input.competency.level ?? "").trim().slice(0, 160),
    description: String(input.competency.description ?? "").trim().slice(0, 4_000),
    resources: (input.competency.resources ?? []).filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, 20),
    limitations: (input.competency.limitations ?? []).filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, 20),
    costs: (input.competency.costs ?? []).filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, 20),
  };
  if (![competency.name, competency.level, competency.description, ...competency.resources, ...competency.limitations, ...competency.costs].some(Boolean)) {
    throw new Error("能力内容不能为空");
  }
  const result = await completeText(input.model, [
    {
      role: "system",
      content: "你是角色卡能力摘要器。根据给定能力资料写一条简洁中文 summary，概括能力性质和核心效果。summary 即使能力未解锁也会展示，因此只写高层概述，不泄露具体机制、精确数值、资源清单、限制细节或代价细节。要求 20～80 个中文字符；只输出摘要正文，不加标题、引号、列表或解释；资料不足时忠实概括，不补造设定。",
    },
    { role: "user", content: JSON.stringify(competency) },
  ], input.signal);
  const summary = result.content
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:能力)?摘要[:：]\s*/, "")
    .replace(/^["“]|["”]$/g, "")
    .trim()
    .slice(0, 200);
  if (!summary) throw new Error("摘要模型没有返回有效内容");
  return summary;
}

export async function updateCharacterFromConversation(input: {
  model: ModelConfig;
  summaryModel?: ModelConfig;
  store: WriterStore;
  sessionId: string;
  instruction: string;
  characterId?: number;
  allowedDocumentPaths?: string[];
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<void> {
  const emit = async (event: AgentEvent) => { await input.onEvent?.(event); };
  if (!input.store.sessionExists(input.sessionId)) throw new Error("写作会话不存在");
  const existing = input.characterId === undefined
    ? undefined
    : input.store.characters().find(item => item.id === input.characterId);
  if (input.characterId !== undefined && !existing) throw new Error("目标角色卡不存在");
  const userMessageId = input.store.addMessage(input.sessionId, "user", input.instruction.trim());
  await emit({ type: "step_start", step: 1 });
  try {
    const draft = await generateCharacter({
      model: input.model, description: input.instruction, existing,
      project: input.store.project, allowedDocumentPaths: input.allowedDocumentPaths,
      onTool: async () => { await emit({ type: "tool", name: "read_document" }); }, signal: input.signal,
    });
    const character = input.store.saveCharacterWithRevision(input.sessionId, userMessageId, {
      ...draft, id: existing?.id,
      relationships: existing?.relationships ?? draft.relationships,
    });
    const fallback = existing ? `已更新角色卡：${character.identity.name}` : `已创建角色卡：${character.identity.name}`;
    const message = await safeChangeSummary(input.summaryModel ?? input.model, {
      kind: "character", action: existing ? "更新角色卡" : "创建角色卡", target: character.identity.name,
      instruction: input.instruction,
      before: existing ? JSON.stringify(characterContext(existing), null, 2) : "（新建）",
      after: JSON.stringify(characterContext(character), null, 2),
    }, fallback, input.signal);
    input.store.addMessage(input.sessionId, "assistant", message);
    await emit({ type: "text", text: message, channel: "output" });
    await emit({ type: "character", character });
    await emit({ type: "step_done", step: 1 });
    await emit({ type: "done", sessionId: input.sessionId });
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      await emit({ type: "cancelled", sessionId: input.sessionId }); return;
    }
    await emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ToolLoopMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
};
type ChatMessage = ToolLoopMessage;

async function buildWritingDraft(
  options: GenerateWritingOptions,
  document: string,
  onTool: (name: string) => void | Promise<void>,
  revision?: { draft: string; revision: string },
): Promise<{ draft: string; usage?: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number } }> {
  const allowedCharacterIds = new Set(selectedCharacters(options.store, options.characterIds).map(item => item.id));
  const documents = options.project.listDocuments().filter(path => !options.project.isDocumentHidden(path)).slice(0, 100);
  const documentSet = new Set(documents);
  const characterDirectory = options.store.characters().filter(item => allowedCharacterIds.has(item.id)).map(item => ({ id: item.id, name: item.identity.name, aliases: item.identity.aliases, narrativeRole: item.identity.narrativeRole, identity: item.identity.summary }));
  // CACHE: free-form ids/paths (no project enum) keep this small tools JSON stable across growth.
  // Prefer the same discipline as agent TOOLS: do not inject live path lists into tool schemas.
  const tools = [
    { type: "function", function: { name: "list_characters", description: "列出本次获准读取的角色卡目录。", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    { type: "function", function: { name: "read_character", description: "读取一张与本次写作相关的完整角色卡（id 须在获准列表中）。", parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"], additionalProperties: false } } },
    { type: "function", function: { name: "list_documents", description: "列出可读取文档路径。约定：lore/=设定，outline/=大纲，chapters/=正文。先看目录，只选本次需要的文档。", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    { type: "function", function: { name: "read_document", description: "读取一份与本次情节或事实核对直接相关的文档（path 须在项目可见文档中）。", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
  ];
  const existingContext = options.mode === "continue" ? document.slice(-12_000)
    : options.mode === "rewrite_document" ? document.slice(0, 16_000)
      : options.selection?.trim() || document.slice(-6_000);
  const styleBlock = styleGroundingPrompt(options.project, options.store, {
    intensive: true,
    targetPath: options.path,
    preferredSample: options.selection?.trim() || existingContext.slice(-1_200) || undefined,
  });
  const messages: ToolLoopMessage[] = [
    { role: "system", content: `你是小说写作的草案编辑，使用成本较低的模型完成正文前准备。你不写正式正文，也不修改文件。
项目分区：lore/=设定事实，outline/=情节计划，chapters/=主线正文（分区名仅用于你选文档，不得写入草案正文）。先根据任务判断需要哪些事实，再通过工具读取相关角色卡；仅在确有必要时选择性读取 lore、outline 或前文 chapters，不得为了“全面”遍历资料，也不要把 archive/side 旧稿当现行事实。
草案语气保持直接：标出冲突、欲望、身体或暴力要点时用准确词，不要改成含蓄代称；不做道德评判。
${proseMannerismConstraintPrompt({ compact: true })}
${writePackDraftContractPrompt()}
不要伪造资料来源。不要写成小说正文。` },
    ...(styleBlock ? [{ role: "system" as const, content: styleBlock }] : []),
    { role: "user", content: revision
      ? `原始写作要求：${options.instruction.trim()}\n当前草案：\n${revision.draft}\n\n本轮草案修改要求：${revision.revision.trim()}\n请修改草案本身，不要开始写正式正文。必要时可继续使用工具核对资料。事实与回忆须用故事内锚点，禁止「比序章里…」等文档指称。`
      : `写作动作：${options.mode}\n写作要求：${options.instruction.trim()}\n目标文档（仅定位，勿写入草案）：${options.path ?? "新文档"}\n当前必要上下文：\n${existingContext || "（无）"}\n请按合同小标题输出草案；回忆先前情节时写故事内锚点，不要写章节名。` },
  ];
  const endpoint = `${options.draftModel.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const usage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
  let hasUsage = false;
  for (let turn = 0; turn < 7; turn += 1) {
    const requestBody = JSON.stringify({
      model: options.draftModel.model, messages, tools,
      ...(modelSupportsToolChoice(options.draftModel) ? { tool_choice: "auto" } : {}),
      stream: false,
      ...(options.draftModel.temperature === undefined ? {} : { temperature: options.draftModel.temperature }),
      ...(options.draftModel.topP === undefined ? {} : { top_p: options.draftModel.topP }),
    });
    logModelRequest(endpoint, requestBody);
    const response = await modelFetch(endpoint, { method: "POST", signal: options.signal, headers: { "content-type": "application/json", ...(options.draftModel.apiKey ? { authorization: `Bearer ${options.draftModel.apiKey}` } : {}) }, body: requestBody }, options.draftModel.proxyUrl);
    const responseBody = await response.text();
    logModelResponse(endpoint, responseBody);
    if (!response.ok) throw new Error(`草案模型请求失败（${response.status}）：${responseBody.slice(0, 500)}`);
    const payload = JSON.parse(responseBody) as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string; tool_calls?: ToolCall[] } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number } };
    if (payload.usage) {
      hasUsage = true;
      const promptTokens = Number(payload.usage.prompt_tokens ?? 0);
      const cacheHitTokens = Number(payload.usage.prompt_tokens_details?.cached_tokens ?? payload.usage.prompt_cache_hit_tokens ?? 0);
      usage.promptTokens += promptTokens;
      usage.completionTokens += Number(payload.usage.completion_tokens ?? 0);
      usage.cacheHitTokens += cacheHitTokens;
      usage.cacheMissTokens += Math.max(0, promptTokens - cacheHitTokens);
    }
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("草案模型没有返回有效响应");
    const calls = message.tool_calls ?? [];
    if (!calls.length) {
      const draft = message.content?.trim();
      if (!draft) throw new Error("草案模型没有生成写作草案");
      return { draft, ...(hasUsage ? { usage } : {}) };
    }
    messages.push({ role: "assistant", content: message.content ?? "", ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}), tool_calls: calls });
    for (const call of calls) {
      await onTool(call.function.name);
      let result: unknown;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        if (call.function.name === "list_characters") result = characterDirectory;
        else if (call.function.name === "read_character") {
          const id = Number(args.id);
          if (!allowedCharacterIds.has(id)) throw new Error("角色不在本次获准范围内");
          const character = options.store.characters().find(item => item.id === id);
          if (!character) throw new Error("角色不存在");
          result = characterContext(character, options.project, options.path, options.selection);
        } else if (call.function.name === "list_documents") result = documents.map(path => ({ path, characters: options.project.read(path).length }));
        else if (call.function.name === "read_document") {
          const path = typeof args.path === "string" ? args.path : "";
          if (!documentSet.has(path)) throw new Error("文档未获准或已被屏蔽");
          const content = options.project.read(path);
          result = { path, content: content.slice(0, 16_000), truncated: content.length > 16_000 };
        } else throw new Error("未知草案工具");
      } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error("草案模型的工具循环超过 7 轮，请缩小写作范围或资料范围");
}

function isDraftConfirmation(instruction: string): boolean {
  const text = instruction.trim().replace(/[\s，,。！!]/g, "");
  return /^(?:确认|确认开写|确认开始写|确认直接开写|开始写|开始正文|直接开写|按草案写|按这个草案写|就按这个写|草案没问题|通过|继续写正文)$/u.test(text);
}

function writingMessages(options: GenerateWritingOptions, document: string, characters: Character[], draft: string): ChatMessage[] {
  const context = options.mode === "continue" ? document.slice(-12_000)
    : options.mode === "rewrite_document" ? document
    : options.mode === "rewrite" || options.mode === "polish" ? selectionContext(document, options.selection!)
      : "";
  const task: Record<WritingMode, string> = {
    write: "创作一篇新的小说正文。只输出可直接写入 Markdown 文档的正文。使用 #/##/### 标记章、节或场景层级，必要时使用分隔线---；标题应简短稳定，便于浏览跳转和按节读取，但不要为每个自然段添加标题。",
    continue: "从给出的文档末尾自然续写。只输出新增正文，不要重复已有内容。延续既有 Markdown 标题层级；进入新节或新场景时使用合适的 ##/### 标题，但不要为每个自然段添加标题。",
    rewrite: "按要求改写选区。只输出替换选区的新文本，不要输出分析或原文。",
    rewrite_document: "按要求修改给出的完整文档。只输出修改后的完整正文，不要输出分析、摘要或原文对照。",
    polish: "润色选区，保持事实、视角、时序和人物声线不变。只输出替换选区的新文本。",
  };
  const styleBlock = styleGroundingPrompt(options.project, options.store, {
    intensive: isIntensiveWritingMode(options.mode),
    targetPath: options.path,
    preferredSample: options.selection?.trim() || (options.mode === "continue" ? document.slice(-2_000) : undefined),
  });
  // Write-pre compile: author draft → diegetic write pack (never inject raw draft chrome).
  const writePack = compileWritePack(draft, {
    targetPath: options.path,
    instruction: options.instruction,
  });
  const packText = formatWritePackForWriter(writePack);
  return [
    { role: "system", content: `你是小说写作助手。${task[options.mode]}
创作立场：成人向虚构写作；暴力、情欲、残酷、粗口等按剧情与作者要求直写，不做道德说教，不自行含蓄化或降级冲突。不协助现实犯罪；不写真实未成年人的性内容。
正文要求：
- 先写可观察的动作、选择、代价、对白和有对象的感官细节，避免用抽象性格或情绪标签包办人物。
- 不在动作、对白或细节之后重复说明人物的心理、潜台词、象征或“这意味着什么”；仅在省略会造成因果断裂时解释。
- 句长、段长和信息密度服从「风格锚定」与文档上下文的声线，不追求整齐、对称、三项并列或每段总结。不同人物的词汇、句长、礼貌程度和回避方式应可区分。
- 让动作产生结果，让可观察细节供读者判断；必要因果写成独立句。人物纠正事实、反驳误解时保留自然口语。
- 对白中的拖音、中断和迟疑按人物语气保留；叙述中的补充信息直接落到动作、名词或独立句。
- 通过具体且相关的内容差异降低机器感；不要随机换同义词、强行拆句、故意写病句、滥加口语或无关细节。
- 保留必要的朴素过渡、留白、轻重差别和不对称。新增细节必须来自现有上下文，并服务于行动、空间、因果或伏笔。
- 需要直写处用准确名词与动作，避免“那方面”“不可描述”等遮掩。
- 禁止在正文出现文档/流程元信息：章节名作指称（「序章里」「第一章中」）、路径、大纲/草案/分区名；回忆先前情节只用故事内时间、对白或物件。
${proseMannerismConstraintPrompt({ compact: true })}
不要解释写作过程，不要添加代码围栏，不要输出“以下是”等前言。不得虚构角色卡与已给材料之外的关键设定。` },
    ...(styleBlock ? [{ role: "system" as const, content: styleBlock }] : []),
    { role: "user", content: [
      `作品语言：${options.project.config().language}`,
      characters.length ? `相关角色卡：\n${JSON.stringify(characters.map(item => characterContext(item, options.project, options.path, options.selection)), null, 2)}` : "相关角色卡：无",
      packText,
      context ? `文档上下文（纯正文，用于衔接声线与事实）：\n${context}` : "",
      `写作要求：${options.instruction.trim()}`,
      `只输出正文。声线优先贴合文档上下文与风格样本。${proseMannerismPreflightLine()}`,
    ].filter(Boolean).join("\n\n") },
  ];
}

function validateWritingRequest(options: GenerateWritingOptions): void {
  if (!["write", "continue", "rewrite", "rewrite_document", "polish"].includes(options.mode)) throw new Error("写作动作无效");
  if (!options.store.sessionExists(options.sessionId)) throw new Error("写作会话不存在");
  if (!options.instruction.trim()) throw new Error("写作要求不能为空");
  if (options.mode !== "write" && !options.path) throw new Error("该写作动作需要目标文档");
  if (options.path && options.mode !== "write" && !options.project.documentExists(options.path)) throw new Error("目标文档不存在");
  if (options.path && options.project.isDocumentHidden(options.path)) throw new Error("目标文档已对 Agent 屏蔽，请先取消屏蔽");
  if ((options.mode === "rewrite" || options.mode === "polish") && !options.selection?.trim()) throw new Error("改写或润色需要文本选区");
  if (options.mode === "write" && options.path && options.project.documentExists(options.path)) throw new Error("新文档已经存在");
}

function targetPath(options: GenerateWritingOptions): string {
  if (options.path) return options.path;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `chapters/generated-${stamp}.md`;
}

function applyGeneratedText(mode: WritingMode, before: string, selection: string | undefined, generated: string): string {
  if (mode === "write") return generated.endsWith("\n") ? generated : `${generated}\n`;
  if (mode === "continue") return `${before.replace(/\s+$/, "")}\n\n${generated.trim()}\n`;
  if (mode === "rewrite_document") return generated.endsWith("\n") ? generated : `${generated}\n`;
  const needle = selection!.trim();
  const count = before.split(needle).length - 1;
  if (count !== 1) throw new Error(`选区在文档中出现 ${count} 次，无法安全替换；请扩大选区后重试`);
  return before.replace(needle, generated.trim());
}

function selectionContext(document: string, selection: string): string {
  const needle = selection.trim();
  const index = document.indexOf(needle);
  if (index < 0) throw new Error("选区已失效，请重新选择");
  const start = Math.max(0, index - 2_000);
  const end = Math.min(document.length, index + needle.length + 2_000);
  return `${document.slice(start, index)}\n<selection>\n${needle}\n</selection>\n${document.slice(index + needle.length, end)}`;
}

function selectedCharacters(store: WriterStore, ids?: number[]): Character[] {
  if (!ids?.length) return [];
  const allowed = new Set(ids);
  return store.characters().filter(item => allowed.has(item.id)).slice(0, 12);
}

function characterContext(item: Character, project?: WriterProject, path?: string, selection?: string) {
  if (!project) return characterPromptViews(item);
  const nodes = new OutlineStore(project).sync().nodes;
  const linked = path ? nodes.filter(node => node.documentPath === path) : [];
  const selected = selection ? linked.find(node => node.documentHeading && selection.includes(node.documentHeading)) : undefined;
  const target = selected?.id ?? (linked.length === 1 ? linked[0].id : undefined);
  return characterPromptViews(item, nodes, target);
}

function proposalSummary(mode: WritingMode): string { return `${modeLabel(mode)}生成内容，等待确认`; }

function buildUsageEvent(
  store: WriterStore,
  sessionId: string,
  model: ModelConfig,
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number },
  step?: number,
): AgentEvent {
  const cacheMissTokens = usage.cacheMissTokens || Math.max(0, usage.promptTokens - usage.cacheHitTokens);
  const normalized = { ...usage, cacheMissTokens };
  const call: StepUsage = {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens,
    totalTokens: usage.promptTokens + usage.completionTokens,
    cost: model.pricing ? calculateUsageCost(normalized, model.pricing) : 0,
    currency: model.pricing?.currency ?? "CNY",
  };
  let sessionUsage: UsageSummary = store.usage(sessionId);
  if (model.pricing) {
    sessionUsage = store.recordUsage(sessionId, model.model, usage, model.pricing);
  }
  return {
    type: "usage",
    usage: sessionUsage,
    call,
    ...(step !== undefined ? { step } : {}),
  };
}
function modeLabel(mode: WritingMode): string { return ({ write: "新写", continue: "续写", rewrite: "改写选区", rewrite_document: "修改全文档", polish: "润色" })[mode]; }
function cleanModelText(value: string): string { return value.trim().replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/, "").trim(); }

type ModelUsage = { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number };

async function repairGeneratedProse(
  model: ModelConfig,
  original: string,
  signal?: AbortSignal,
): Promise<{ text: string; changed: boolean; repairedIssues: number; usages: ModelUsage[] }> {
  let text = original;
  let repairedIssues = 0;
  const usages: ModelUsage[] = [];
  for (let round = 0; round < 2; round += 1) {
    const scanned = analyzeProseStyle(text);
    let issues: ProseStyleIssue[];
    if (round === 0 && scanned.some(issue => issue.severity !== "info")) {
      const reviewed = await adjudicateProseStyleForAudit(text, scanned, model, { signal });
      issues = reviewed.issues.filter(issue =>
        issue.severity === "error"
        || (issue.severity === "warning" && issue.confidence >= 0.95),
      ).slice(0, 8);
    } else {
      issues = scanned.filter(issue => issue.severity === "error").slice(0, 8);
    }
    if (!issues.length) break;
    const result = await completeText(model, repairMessages(text, issues), signal);
    if (result.usage) usages.push(result.usage);
    const edits = parseRepairEdits(result.content);
    let next = text;
    let applied = 0;
    for (const edit of edits) {
      if (!issues.some(issue => issue.sentence === edit.search)) continue;
      if (!edit.replace.trim() || countExact(next, edit.search) !== 1) continue;
      next = next.replace(edit.search, edit.replace.trim());
      applied += 1;
    }
    if (!applied || next === text) break;
    repairedIssues += applied;
    text = next;
  }
  return { text, changed: text !== original, repairedIssues, usages };
}

function repairMessages(text: string, issues: ProseStyleIssue[]): ChatMessage[] {
  return [
    { role: "system", content: "你是小说局部修订器。只修复给定问题句，保持事实、视角、时序、人物声线和其他句子不变。优先让动作产生结果、用可观察细节承载信息，必要因果拆为独立句。对白拖音、中断、迟疑和真实纠正不得修改。只输出 JSON 数组，每项为 {search,replace}，search 必须逐字等于问题句。" },
    { role: "user", content: JSON.stringify({
      issues: issues.map(issue => ({
        sentence: issue.sentence, subtype: issue.subtype, reason: issue.reason, suggestions: issue.suggestions,
      })),
      nearbyContext: issues.map(issue => text.slice(Math.max(0, issue.start - 180), Math.min(text.length, issue.end + 180))),
    }) },
  ];
}

function parseRepairEdits(value: string): Array<{ search: string; replace: string }> {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("["); const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const edit = item as Record<string, unknown>;
      return typeof edit.search === "string" && typeof edit.replace === "string"
        ? [{ search: edit.search, replace: edit.replace }] : [];
    }).slice(0, 8);
  } catch { return []; }
}

function countExact(text: string, search: string): number {
  if (!search) return 0;
  let count = 0, index = 0;
  while ((index = text.indexOf(search, index)) >= 0) { count += 1; index += search.length; }
  return count;
}

function sumModelUsage(usages: ModelUsage[]): ModelUsage | undefined {
  if (!usages.length) return undefined;
  return usages.reduce((sum, usage) => ({
    promptTokens: sum.promptTokens + usage.promptTokens,
    completionTokens: sum.completionTokens + usage.completionTokens,
    cacheHitTokens: sum.cacheHitTokens + usage.cacheHitTokens,
    cacheMissTokens: sum.cacheMissTokens + usage.cacheMissTokens,
  }), { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 });
}

function parseJsonObject(value: string): Record<string, unknown> {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回有效角色卡 JSON");
  try { return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>; }
  catch { throw new Error("模型返回的角色卡 JSON 无法解析"); }
}

function parseJsonArray(value: string): unknown[] {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("["); const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("意图路由器没有返回有效选项");
  try { const parsed = JSON.parse(cleaned.slice(start, end + 1)); return Array.isArray(parsed) ? parsed : []; }
  catch { throw new Error("意图路由器返回的选项无法解析"); }
}

function defaultActionLabel(mode: ActionMode): string {
  return ({ write: "新写正文", continue: "续写当前文档", rewrite: "改写选区", rewrite_document: "修改全文档", polish: "润色选区", character: "处理角色卡" })[mode];
}

async function safeChangeSummary(model: ModelConfig, change: {
  kind: "document" | "character"; action: string; target: string;
  instruction: string; before: string; after: string;
}, fallback: string, signal?: AbortSignal): Promise<string> {
  try {
    const result = await completeText(model, [
      { role: "system", content: `你是写作应用的改动总结器。只根据操作前后内容说明实际变化，不继续创作，不评价质量，不提出下一步建议。使用简洁中文：先用一句话说明结果，再列出 1 至 5 条最重要的具体改动。正文指出情节、段落、措辞或新增内容发生在哪里；角色卡指出哪些结构化字段改变。没有证据的变化不要声称。不要输出 Markdown 标题。` },
      { role: "user", content: JSON.stringify({ ...change, before: change.before.slice(-6_000), after: change.after.slice(0, 6_000) }) },
    ], signal);
    return result.content.trim() || fallback;
  } catch { return fallback; }
}

const DEFAULT_SESSION_TITLES = new Set([
  "新会话",
  "写作会话",
  "New session",
  "Writer session",
]);

function isDefaultSessionTitle(title: string): boolean {
  const t = title.trim();
  if (DEFAULT_SESSION_TITLES.has(t)) return true;
  // createSession / API may append nothing; also allow bare "Session N" style defaults later
  return /^新会话\s*\d*$/u.test(t) || /^写作会话\s*\d*$/u.test(t);
}

/**
 * Auto-generate a short session title from early conversation messages.
 * Runs at most once per session (auto_title_done). Skips non-default titles
 * (manual rename) and marks them done without overwriting.
 */
export async function maybeAutoTitleSession(options: {
  store: WriterStore;
  model: ModelConfig;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<{ title?: string; skipped?: string }> {
  const session = options.store.getSession(options.sessionId);
  if (!session) return { skipped: "missing" };
  if (session.autoTitleDone) return { skipped: "already_done" };

  if (!isDefaultSessionTitle(session.title)) {
    options.store.markAutoTitleDone(options.sessionId);
    return { skipped: "custom_title" };
  }

  const history = options.store.messages(options.sessionId, 24)
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content.trim());
  if (history.length === 0) return { skipped: "no_messages" };

  // Need at least one user turn with a bit of substance before naming.
  const userText = history.filter((m) => m.role === "user").map((m) => m.content.trim()).join("\n");
  if (userText.length < 4) return { skipped: "too_short" };

  const transcript = history.slice(0, 12).map((message) => {
    const role = message.role === "user" ? "用户" : "助手";
    const body = message.content.trim().slice(0, 800);
    return `${role}：${body}`;
  }).join("\n\n").slice(0, 4_500);

  try {
    const result = await completeText(options.model, [
      {
        role: "system",
        content: "你是写作应用的会话标题生成器。根据对话内容生成一个简短中文标题，概括本会话的写作任务、主题或场景。要求：8～18个字；不要加书名号/引号/句号；不要输出解释或多行；不要以「会话」「对话」开头。",
      },
      { role: "user", content: `请为以下写作会话生成标题：\n\n${transcript}` },
    ], options.signal);

    let title = result.content.trim().split(/\r?\n/)[0]?.trim() ?? "";
    title = title
      .replace(/^["'「『《]+/, "")
      .replace(/["'」』》]+$/, "")
      .replace(/^[标题：:]\s*/u, "")
      .trim();
    if (!title || title.length > 40) return { skipped: "invalid_title" };

    options.store.renameSession(options.sessionId, title, { fromAutoTitle: true });
    return { title };
  } catch {
    // Leave auto_title_done unset so a later successful turn can still name the session.
    return { skipped: "model_error" };
  }
}

function summaryBefore(mode: WritingMode, before: string, selection?: string): string {
  if (mode === "write") return "（新建文档）";
  if (mode === "rewrite" || mode === "polish") return selection?.trim() ?? "";
  if (mode === "rewrite_document") return before;
  return before.slice(-6_000);
}

function summaryAfter(mode: WritingMode, generated: string): string {
  return mode === "continue" ? `（续写新增内容）\n${generated}` : generated;
}

function normalizeCharacterDraft(value: Record<string, unknown>): Omit<Character, "id" | "updatedAt"> {
  const normalized = normalizeV3Character({ ...emptyCharacter(), ...value, id: 1, updatedAt: "" });
  if (!normalized.identity.name) throw new Error("生成的角色卡缺少 identity.name");
  const { id: _id, updatedAt: _updatedAt, ...draft } = normalized;
  return draft;
}

async function runReadOnlyToolLoop(
  model: ModelConfig,
  messages: ToolLoopMessage[],
  project: WriterProject,
  allowedPaths: string[],
  signal?: AbortSignal,
  onTool?: (name: string, path: string) => void | Promise<void>,
): Promise<{ content: string }> {
  if (!model.apiKey) throw new Error("请先配置模型 API Key");
  const allowed = new Set(allowedPaths.filter(path => project.documentExists(path) && !project.isDocumentHidden(path)).slice(0, 5));
  const read = new Map<string, string>();
  const tools = [{ type: "function", function: {
    name: "read_document",
    description: "读取一份已获用户批准的 lore/设定 或 outline/大纲 文档。仅在角色设计确实需要时调用。",
    parameters: { type: "object", properties: { path: { type: "string", enum: [...allowed] } }, required: ["path"], additionalProperties: false },
  } }];
  for (let turn = 0; turn < 4; turn += 1) {
    const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const requestBody = JSON.stringify({ model: model.model, messages, tools,
      ...(modelSupportsToolChoice(model) ? { tool_choice: "auto" } : {}), stream: false,
      ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
      ...(model.topP === undefined ? {} : { top_p: model.topP }) });
    logModelRequest(endpoint, requestBody);
    const response = await modelFetch(endpoint, {
      method: "POST", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${model.apiKey}` },
      body: requestBody,
    }, model.proxyUrl);
    const responseBody = await response.text();
    logModelResponse(endpoint, responseBody);
    if (!response.ok) throw new Error(`角色卡上下文读取失败（${response.status}）：${responseBody.slice(0, 500)}`);
    const payload = JSON.parse(responseBody) as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string; tool_calls?: ToolCall[] } }> };
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("角色模型没有返回有效响应");
    const calls = message.tool_calls ?? [];
    if (!calls.length) return { content: message.content ?? "" };
    messages.push({ role: "assistant", content: message.content ?? "", ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}), tool_calls: calls });
    for (const call of calls) {
      let result: Record<string, unknown>;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as { path?: unknown };
        const path = typeof args.path === "string" ? args.path : "";
        if (call.function.name !== "read_document") throw new Error("工具不在允许列表中");
        if (!allowed.has(path)) throw new Error("文档未获用户批准或已被屏蔽");
        if (!read.has(path)) {
          if (read.size >= 5) throw new Error("读取文档数量已达到上限");
          await onTool?.("read_document", path);
          read.set(path, project.read(path).slice(0, 8_000));
        }
        result = { path, content: read.get(path), truncated: project.read(path).length > 8_000 };
      } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error("角色模型读取文档超过 4 轮限制，请缩小参考文档范围后重试");
}

async function completeText(model: ModelConfig, messages: ChatMessage[], signal?: AbortSignal) {
  let content = "";
  const result = await streamText(model, messages, signal, text => { content += text; });
  return { ...result, content: content || result.content };
}

async function streamText(model: ModelConfig, messages: ChatMessage[], signal: AbortSignal | undefined, onText: (text: string) => void | Promise<void>) {
  if (!model.apiKey) throw new Error("请先配置模型 API Key");
  const endpoint = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const requestBody = JSON.stringify({ model: model.model, messages, stream: true, stream_options: { include_usage: true }, ...(model.temperature === undefined ? {} : { temperature: model.temperature }), ...(model.topP === undefined ? {} : { top_p: model.topP }) });
  logModelRequest(endpoint, requestBody);
  const response = await modelFetch(endpoint, {
    method: "POST", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${model.apiKey}` },
    body: requestBody,
  }, model.proxyUrl);
  if (!response.ok) {
    const responseBody = await response.text();
    logModelResponse(endpoint, responseBody);
    throw new Error(`模型请求失败（${response.status}）：${responseBody.slice(0, 500)}`);
  }
  if (!response.body) throw new Error("模型响应没有内容");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let content = "";
  let usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number } | undefined;
  const consume = async (block: string) => {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim(); if (!data || data === "[DONE]") continue;
      const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>; usage?: Record<string, unknown> };
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) { content += text; await onText(text); }
      if (chunk.usage) {
        const cached = Number((chunk.usage.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0);
        const prompt = Number(chunk.usage.prompt_tokens ?? 0);
        usage = { promptTokens: prompt, completionTokens: Number(chunk.usage.completion_tokens ?? 0), cacheHitTokens: cached, cacheMissTokens: Math.max(0, prompt - cached) };
      }
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() ?? "";
    for (const block of blocks) await consume(block);
    if (done) break;
  }
  if (buffer.trim()) await consume(buffer);
  const completed = { content, usage };
  logModelResponse(endpoint, JSON.stringify(completed, null, 2));
  return completed;
}
