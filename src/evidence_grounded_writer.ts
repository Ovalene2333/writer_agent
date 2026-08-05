import { completeProviderCompletion, type ProviderUsage, type ProviderWireMessage } from "./model_api.js";
import { samplingRequestOptions } from "./model_compat.js";
import {
  adaptiveRevisionImproved,
  analyzeAdaptiveStyle,
  type AdaptiveStyleCode,
} from "./adaptive_style.js";
import {
  narrativeEvidenceForPrompt,
  readNarrativeEvidenceSource,
  type NarrativeEvidencePacket,
} from "./narrative_evidence.js";
import type { ChapterSceneCard, SceneActualState } from "./scene_pipeline.js";
import type { ModelConfig, ModelTokenUsage } from "./types.js";
import type { WriterProject } from "./project.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { formatWritePackForWriter, type WritePack } from "./write_pack.js";

export type EvidenceGroundedWriterInput = {
  path: string;
  outputKind: "document" | "scene";
  writePack: WritePack;
  evidence: NarrativeEvidencePacket;
  scene?: ChapterSceneCard;
  previousTail?: string;
  existingText?: string;
  styleEvidence: string;
  /** Dynamic diagnosis of already-written prose; never part of the stable style slot. */
  styleFeedback?: string[];
  /** Evidence-backed semantic blockers for a bounded rewrite of existing prose. */
  reviewIssues?: Array<{
    id: string;
    kind: string;
    evidence: string[];
    problem: string;
    action: string;
  }>;
  targetCharacters?: number;
};

export type EvidenceGroundedWriterResult = {
  content: string;
  usage?: ModelTokenUsage;
  requestCharacters: number;
  evidenceHash: string;
  evidenceReads: string[];
  styleRevision?: {
    triggeredBy: AdaptiveStyleCode[];
    applied: boolean;
    remaining: AdaptiveStyleCode[];
    error?: string;
  };
};

export type EvidenceGroundedWriterAccess = {
  project: WriterProject;
  context: ToolExecutionContext;
};

export type SceneStateExtractionResult = {
  actualState: SceneActualState;
  usage?: ModelTokenUsage;
  requestCharacters: number;
};

const WRITER_SYSTEM = `你是成熟的中文小说作者，只负责把已经取证的故事材料写成正文。你不参与项目规划、文件操作、质量审查或状态管理，也不向读者展示证据包、工具、字段名和写作流程。

事实边界与创作自由必须同时成立：身份、关系、知识来源、能力、时间、地点、伤势、物品与世界规则服从证据；普通动作、无因果负担的环境和感官细节可以现场创造。任何新细节一旦承担解题、定罪、转折或规则功能，就必须有证据。资料不足时先读取获准证据，不要靠常识补造关键事实。

一场戏从人物眼前想完成的事情生长。让行动得到回应，并在局面、理解、关系或选择中留下变化。场景目标和事件顺序是控制材料，不是需要逐项复述的清单。

对白是人物在关系中采取的行动。每一轮都承接前一轮带来的信息和压力；直答、解释、回避、沉默、误解、玩笑或让步均可。差异来自人物想得到、知道和不愿承认的内容，不靠口头禅、固定句长或随机口语词。

只输出可直接入稿的正文。不要标题、前言、总结、引用标记、JSON 或代码围栏。直接对白使用项目声线证据所采用的引号；证据不一致时使用「……」。`;

const STATE_SYSTEM = `你是小说场景状态提取器。只根据 previousState 与 sceneContent，提取正文结束时仍会约束后续场景的最小事实。nextScene 只用于相关性筛选，不是已经发生的事实。

只输出 JSON 对象：situation 最多3项、physical 2项、knowledge 3项、relationships 2项、goals 2项、openLoops 3项、usedMotifs 3项。不得把计划、推测、修辞、普通动作或未发生事项写成事实。`;

const WRITER_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_evidence_source",
      description: "读取本次已授权且带哈希的事实原文；证据预览不足时按 sourceId 和行号补读。",
      parameters: {
        type: "object",
        properties: {
          sourceId: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["sourceId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_character_evidence",
      description: "读取证据包中已经由主 Agent 授权并实际读取过的角色原始分区。",
      parameters: {
        type: "object",
        properties: {
          characterId: { type: "number" },
          section: { type: "string" },
        },
        required: ["characterId", "section"],
        additionalProperties: false,
      },
    },
  },
] as const;

export function buildEvidenceGroundedWriterMessages(input: EvidenceGroundedWriterInput): ProviderWireMessage[] {
  const sections = [
    `写作材料：\n${formatWritePackForWriter(input.writePack)}`,
    `共享事实证据（hash=${input.evidence.hash}）：\n${JSON.stringify(narrativeEvidenceForPrompt(input.evidence))}`,
  ];
  if (input.previousTail?.trim()) {
    sections.push(`故事刚停在这里。不要复述，接住动作、语气和未完成的压力：\n${input.previousTail.trim().slice(-2_000)}`);
  }
  if (input.existingText?.trim()) {
    sections.push(`这是需要完整重写的当前正文。保留其已成立事实、事件顺序和信息释放，不沿用僵硬句法：\n${input.existingText.trim().slice(0, 30_000)}`);
  }
  if (input.scene) {
    sections.push(`本场当前引导：\n${JSON.stringify({
      goal: input.scene.goal,
      entryState: input.scene.entryState,
      characterIntent: input.scene.characterIntent,
      obstacle: input.scene.obstacle,
      turn: input.scene.turn,
      outcome: input.scene.outcome,
      readerQuestion: input.scene.readerQuestion,
      cost: input.scene.cost,
      oppositionMove: input.scene.oppositionMove,
    })}`);
  }
  if (input.targetCharacters) {
    sections.push(`目标约 ${input.targetCharacters} 字。篇幅服从场景变化，不用总结、复述和无关支线凑字。`);
  }
  if (input.styleFeedback?.length) {
    sections.push(
      "既有正文暴露出的动态文风问题如下。它们只定位风险，不是要求凑齐的数字配额；结合本场语义避免继续复制：\n"
        + input.styleFeedback.join("\n"),
    );
  }
  if (input.reviewIssues?.length) {
    sections.push(
      "这是终审后的定向修订，不是重新创作。只解决下面有正文证据的问题；未涉及的事件、信息释放、人物选择和关系压力保持成立。若 action 与事实证据冲突，以证据为准：\n"
        + JSON.stringify(input.reviewIssues.slice(0, 8)),
    );
  }
  const style = input.styleEvidence.trim();
  return [
    { role: "system", content: WRITER_SYSTEM },
    { role: "system", content: style },
    { role: "user", content: sections.join("\n\n") },
  ];
}

export async function requestEvidenceGroundedProse(
  model: ModelConfig,
  input: EvidenceGroundedWriterInput,
  access: EvidenceGroundedWriterAccess,
  signal?: AbortSignal,
): Promise<EvidenceGroundedWriterResult> {
  if (input.evidence.coverageGaps.length) {
    throw new Error(`EVIDENCE_COVERAGE_REQUIRED：${input.evidence.coverageGaps.map(gap => gap.action).join("；")}`);
  }
  const messages = buildEvidenceGroundedWriterMessages(input);
  const usage = emptyUsage();
  let hasUsage = false;
  const evidenceReads: string[] = [];
  const completePhase = async (): Promise<string> => {
    for (let turn = 0; turn < 6; turn += 1) {
      const result = await completeProviderCompletion({
        model,
        messages,
        tools: WRITER_TOOLS,
        maxTokens: writerMaxTokens(input.targetCharacters),
        ...samplingRequestOptions(model),
      }, signal);
      if (result.usage) {
        addUsage(usage, result.usage);
        hasUsage = true;
      }
      if (!result.toolCalls.length) {
        if (result.finishReason === "length") throw new Error("证据型 Writer 输出达到长度上限");
        const content = cleanProse(result.content);
        if (!content) throw new Error("证据型 Writer 没有返回正文");
        return content;
      }
      messages.push({
        role: "assistant",
        content: result.content,
        ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
        tool_calls: result.toolCalls.map(call => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const call of result.toolCalls) {
        const toolResult = executeEvidenceTool(call.name, call.arguments, input.evidence, access);
        evidenceReads.push(toolResult);
        messages.push({ role: "tool", tool_call_id: call.id, content: toolResult });
      }
    }
    throw new Error("证据型 Writer 取证轮次超过上限；需要主 Agent 缩小场景或补齐证据");
  };

  const firstDraft = await completePhase();
  const firstAnalysis = analyzeAdaptiveStyle(firstDraft);
  const triggeredBy = firstAnalysis.issues
    .filter(issue => issue.reviseCurrentDraft)
    .map(issue => issue.code);
  if (!triggeredBy.length) {
    return writerResult(firstDraft, input, messages, evidenceReads, hasUsage ? usage : undefined);
  }

  messages.push(
    { role: "assistant", content: firstDraft },
    { role: "user", content: buildGroundedAdaptiveRevisionPrompt(
      firstAnalysis.issues.filter(issue => issue.reviseCurrentDraft).map(issue => issue.message),
    ) },
  );
  try {
    const revisedDraft = await completePhase();
    const revisedAnalysis = analyzeAdaptiveStyle(revisedDraft);
    const improved = adaptiveRevisionImproved(firstAnalysis, revisedAnalysis)
      && groundedRevisionLengthSafe(firstDraft, revisedDraft, input.targetCharacters);
    const content = improved ? revisedDraft : firstDraft;
    return writerResult(content, input, messages, evidenceReads, hasUsage ? usage : undefined, {
      triggeredBy,
      applied: improved,
      remaining: (improved ? revisedAnalysis : firstAnalysis).issues
        .filter(issue => issue.reviseCurrentDraft)
        .map(issue => issue.code),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return writerResult(firstDraft, input, messages, evidenceReads, hasUsage ? usage : undefined, {
      triggeredBy,
      applied: false,
      remaining: triggeredBy,
      error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
    });
  }
}

export function buildGroundedAdaptiveRevisionPrompt(instructions: readonly string[]): string {
  return [
    "上面是已经完成取证的首稿。现在只做一次完整文风修订。身份、关系、能力、知识来源、时间地点、物品、事件顺序、信息释放、因果、场景结果和所有不确定项必须原样成立；不得增加新事实，也不得删掉承载这些事实的动作或对白。",
    "机器统计只定位可能有问题的形状。逐段通读后只改语义上真实命中的地方，不为阈值凑长句、短句、口语词或段落变化；命令、停顿、克制和必要复沓都可以保留。",
    `本次需要复核：\n${instructions.map(item => `- ${item}`).join("\n")}`,
    "输出修订后的完整正文，不要解释修改，不要输出标题或清单。",
  ].join("\n\n");
}

export async function requestSceneStateExtraction(
  model: ModelConfig,
  input: {
    previousState?: SceneActualState;
    sceneContent: string;
    nextScene?: Pick<ChapterSceneCard, "goal" | "entryState" | "characterIntent" | "obstacle">;
  },
  signal?: AbortSignal,
): Promise<SceneStateExtractionResult> {
  const messages: ProviderWireMessage[] = [
    { role: "system", content: STATE_SYSTEM },
    { role: "user", content: JSON.stringify(input) },
  ];
  const requestCharacters = messages.reduce((sum, message) => sum + messageText(message).length, 0);
  const result = await completeProviderCompletion({
    model,
    messages,
    temperature: 0,
    topP: 1,
    maxTokens: 1_800,
    responseFormat: { type: "json_object" },
  }, signal);
  if (result.finishReason === "length") throw new Error("场景状态提取输出达到长度上限");
  return {
    actualState: parseSceneActualState(result.content),
    ...(result.usage ? { usage: modelUsage(result.usage) } : {}),
    requestCharacters,
  };
}

export function parseSceneActualState(raw: string): SceneActualState {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("场景状态提取没有返回 JSON 对象");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  return {
    situation: stateList(parsed.situation, 3),
    physical: stateList(parsed.physical, 2),
    knowledge: stateList(parsed.knowledge, 3),
    relationships: stateList(parsed.relationships, 2),
    goals: stateList(parsed.goals, 2),
    openLoops: stateList(parsed.openLoops, 3),
    usedMotifs: stateList(parsed.usedMotifs, 3),
  };
}

function executeEvidenceTool(
  name: string,
  rawArguments: string,
  packet: NarrativeEvidencePacket,
  access: EvidenceGroundedWriterAccess,
): string {
  try {
    const args = JSON.parse(rawArguments || "{}") as Record<string, unknown>;
    if (name === "read_evidence_source") {
      const sourceId = typeof args.sourceId === "string" ? args.sourceId : "";
      const startLine = optionalLine(args.startLine);
      const endLine = optionalLine(args.endLine);
      return JSON.stringify(readNarrativeEvidenceSource(
        access.project,
        access.context,
        packet,
        sourceId,
        startLine,
        endLine,
      ));
    }
    if (name === "read_character_evidence") {
      const characterId = Number(args.characterId);
      const section = typeof args.section === "string" ? args.section : "";
      const character = packet.characters.find(item => item.id === characterId);
      if (!character) throw new Error("角色不在本次证据范围内");
      if (!character.availableSections.includes(section) || !(section in character.sections)) {
        throw new Error("该角色分区未由主 Agent 读取并授权");
      }
      return JSON.stringify({ characterId, name: character.name, section, content: character.sections[section] });
    }
    throw new Error("未知证据工具");
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}

function optionalLine(value: unknown): number | undefined {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function cleanProse(value: string): string {
  return value.trim().replace(/^```(?:markdown|md)?\s*/iu, "").replace(/\s*```$/u, "").trim();
}

function stateList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string")
    .map(item => item.trim().slice(0, 180)).filter(Boolean))].slice(0, limit);
}

function writerMaxTokens(targetCharacters?: number): number {
  const characters = targetCharacters ?? 3_000;
  return Math.min(16_000, Math.max(2_400, Math.ceil(characters * 2.4)));
}

function groundedRevisionLengthSafe(original: string, revised: string, targetCharacters?: number): boolean {
  const before = original.replace(/\s/g, "").length;
  const after = revised.replace(/\s/g, "").length;
  if (!before || after < before * 0.7) return false;
  if (targetCharacters && before < targetCharacters * 0.7) {
    return after <= targetCharacters * 1.2;
  }
  return after <= before * 1.3;
}

function writerResult(
  content: string,
  input: EvidenceGroundedWriterInput,
  messages: ProviderWireMessage[],
  evidenceReads: string[],
  usage?: ModelTokenUsage,
  styleRevision?: NonNullable<EvidenceGroundedWriterResult["styleRevision"]>,
): EvidenceGroundedWriterResult {
  return {
    content,
    ...(usage ? { usage } : {}),
    requestCharacters: messages.reduce((sum, message) => sum + messageText(message).length, 0),
    evidenceHash: input.evidence.hash,
    evidenceReads,
    ...(styleRevision ? { styleRevision } : {}),
  };
}

function messageText(message: ProviderWireMessage): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
}

function emptyUsage(): ModelTokenUsage {
  return { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
}

function addUsage(target: ModelTokenUsage, source: ProviderUsage): void {
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.cacheHitTokens += source.cacheHitTokens;
  target.cacheMissTokens += source.cacheMissTokens;
  if (source.cacheWriteTokens) target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + source.cacheWriteTokens;
}

function modelUsage(source: ProviderUsage): ModelTokenUsage {
  return {
    promptTokens: source.promptTokens,
    completionTokens: source.completionTokens,
    cacheHitTokens: source.cacheHitTokens,
    cacheMissTokens: source.cacheMissTokens,
    ...(source.cacheWriteTokens ? { cacheWriteTokens: source.cacheWriteTokens } : {}),
  };
}
