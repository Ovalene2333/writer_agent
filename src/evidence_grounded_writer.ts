import { completeProviderCompletion, type ProviderUsage, type ProviderWireMessage } from "./model_api.js";
import { samplingRequestOptions } from "./model_compat.js";
import {
  narrativeEvidenceForPrompt,
  readNarrativeEvidenceSource,
  type NarrativeEvidencePacket,
} from "./narrative_evidence.js";
import type { ProseLengthMode } from "./agent_runtime.js";
import type { ChapterSceneCard, SceneActualState } from "./scene_pipeline.js";
import type { ModelConfig, ModelTokenUsage } from "./types.js";
import type { WriterProject } from "./project.js";
import type { ToolExecutionContext } from "./tools/types.js";
import { formatWritePackForWriter, type WritePack } from "./write_pack.js";
import { formatRegisterRisksForWriter, type RegisterRisk } from "./register_risks.js";

export type EvidenceGroundedWriterInput = {
  path: string;
  outputKind: "document" | "scene";
  writePack: WritePack;
  evidence: NarrativeEvidencePacket;
  scene?: ChapterSceneCard;
  previousTail?: string;
  existingText?: string;
  styleEvidence: string;
  /** Evidence-backed semantic blockers for a bounded rewrite of existing prose. */
  reviewIssues?: Array<{
    id: string;
    kind: string;
    evidence: string[];
    problem: string;
    action: string;
  }>;
  targetCharacters?: number;
  /** Per-turn prose control; omitted legacy callers use bounded behavior. */
  lengthMode?: ProseLengthMode;
  /** Card phrasing that must not be quoted into lived prose. */
  registerRisks?: RegisterRisk[];
};

export type EvidenceGroundedWriterResult = {
  content: string;
  usage?: ModelTokenUsage;
  requestCharacters: number;
  evidenceHash: string;
  evidenceReads: string[];
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

创作时先抓住本场最有牵引力的动作、关系压力或发现，让其他材料围绕它自然进入；没有承担现场作用的材料可以保持隐含。硬事实、人物知识边界和明确须落地的信息必须成立，场景卡中的规划字段不要求各占一句、各占一段，也不要求制造感官、物件、对白或句长配额。

对白是人物在关系中采取的行动。每一轮都承接前一轮带来的信息和压力；直答、解释、回避、沉默、误解、玩笑或让步均可。差异来自人物想得到、知道和不愿承认的内容，不靠口头禅、固定句长或随机口语词。

只输出可直接入稿的正文。不要标题、前言、总结、引用标记、JSON 或代码围栏。直接对白使用项目声线证据所采用的引号；「……」、“……”与"……"均可，证据不一致时任选一种并在本章保持一致。`;
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
  if (input.writePack.realizationBoundaries?.length) {
    sections.push(
      "表达边界执行规则：先保证事实和本场变化，再按视角、人物知识、说话目的和专业程度选择表达。边界中的词语只是允许或倾向，不是逐字替换表；普通对白和贴身叙述不要为了“忠实设定”强行复述技术术语。",
    );
  }
  // Pack-attached risks already render inside formatWritePackForWriter; add live context risks once.
  if (input.registerRisks?.length && !input.writePack.registerRisks?.length) {
    const registerRiskText = formatRegisterRisksForWriter(input.registerRisks);
    if (registerRiskText) sections.push(registerRiskText);
  }
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
    sections.push("场景卡是当前导航，不是正文模板。先保证入场事实与本场变化成立；goal、characterIntent、obstacle、turn、outcome、readerQuestion、cost 和 oppositionMove 可在同一动作链中合并实现，不要逐字段分段、逐项解释或为可选字段补戏。");
  }
  if (input.targetCharacters) {
    sections.push(input.lengthMode === "guidance"
      ? `篇幅参考约 ${input.targetCharacters} 字（弱引导）。保持场景自然完整，不因偏离参考而缩句、扩句或重写；不用总结、复述和无关支线凑字。`
      : `目标约 ${input.targetCharacters} 字。篇幅服从场景变化，不用总结、复述和无关支线凑字。`);
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
    let evidenceTurns = 0;
    let continuationTurns = 0;
    let accumulated = "";
    while (evidenceTurns < 6) {
      const remainingCharacters = input.targetCharacters
        ? Math.max(600, input.targetCharacters - accumulated.length)
        : undefined;
      const result = await completeProviderCompletion({
        model,
        messages,
        tools: WRITER_TOOLS,
        maxTokens: writerMaxTokens(remainingCharacters ?? input.targetCharacters),
        ...samplingRequestOptions(model),
      }, signal);
      if (result.usage) {
        addUsage(usage, result.usage);
        hasUsage = true;
      }
      if (!result.toolCalls.length) {
        const content = cleanProse(result.content);
        if (!content) throw new Error("证据型 Writer 没有返回正文");
        accumulated = mergeProseContinuation(accumulated, content);
        if (result.finishReason !== "length") return accumulated;
        if (continuationTurns >= 2) {
          throw new Error("证据型 Writer 连续三段输出均达到长度上限；需要缩小单次正文范围");
        }
        continuationTurns += 1;
        messages.push({
          role: "assistant",
          content: result.content,
          ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
        });
        const target = input.targetCharacters ?? 3_000;
        const remaining = Math.max(600, target - accumulated.length);
        messages.push({
          role: "user",
          content: `上一次正文因输出长度上限中断。只从截断处继续，不要重写、概括或重复已经输出的内容。当前累计约 ${accumulated.length} 字，全文目标约 ${target} 字；请在约 ${remaining} 字内完成剩余动作并自然收束。只输出续写正文。`,
        });
        continue;
      }
      evidenceTurns += 1;
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

  const content = await completePhase();
  return writerResult(content, input, messages, evidenceReads, hasUsage ? usage : undefined);
}

/** Join a length-limited continuation without duplicating the model's repeated seam. */
export function mergeProseContinuation(current: string, continuation: string): string {
  const left = current.trimEnd();
  const right = continuation.trimStart();
  if (!left) return right;
  if (!right) return left;
  const maximumOverlap = Math.min(400, left.length, right.length);
  for (let overlap = maximumOverlap; overlap >= 8; overlap -= 1) {
    if (left.endsWith(right.slice(0, overlap))) return left + right.slice(overlap);
  }
  return `${left}\n\n${right}`;
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

function writerResult(
  content: string,
  input: EvidenceGroundedWriterInput,
  messages: ProviderWireMessage[],
  evidenceReads: string[],
  usage?: ModelTokenUsage,
): EvidenceGroundedWriterResult {
  return {
    content,
    ...(usage ? { usage } : {}),
    requestCharacters: messages.reduce((sum, message) => sum + messageText(message).length, 0),
    evidenceHash: input.evidence.hash,
    evidenceReads,
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
