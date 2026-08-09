/**
 * 请求兑现复审：一次运行是否真的把用户要的东西交出来了。
 *
 * 为什么这一层必须存在，且必须在这里而不是在编译期：
 * 「这轮要产出几份文档」在第一次调用工具之前是猜的。猜少了，写五章的请求交完第一章
 * 就被判为完成；猜多了，只需要一句回答的请求被逼着造一份文档。是否兑现是对已完成工作
 * 的语义判断，只有在工作已经摆在桌面上时才答得出来，所以它属于终止环节，不属于契约。
 *
 * 判定由模型做，不做关键词匹配：请求里「再多写几章」「顺便把设定补上」这类要求没有
 * 稳定字面形式，正则只会制造新的误判。运行时只负责把事实（原始请求、已落地交付、
 * 开账未落地、最终回复）摆给复审，并把「未兑现」翻译成一条继续执行的指令。
 */

export interface RunFulfillmentSnapshot {
  /** The user's own words for this turn. Never a planner paraphrase. */
  originalRequest: string;
  /** Assistant text this turn, already stripped of tool markup. */
  finalText: string;
  /** Documents whose delivery actually landed, in ledger order. */
  delivered: string[];
  /** Deliveries the agent opened but never landed. */
  stalled: string[];
  /** Non-document artifacts observed this run (character cards, images…). */
  otherArtifacts: string[];
}

export type RunFulfillmentVerdict =
  | { satisfied: true; reason: string }
  | { satisfied: false; missing: string; nextStep: string };

/** Unsatisfied verdicts tolerated before the run pauses for 续跑 instead of looping. */
export const RUN_FULFILLMENT_MAX_CONTINUATIONS = 3;

const REVIEW_RULES = `你是写作运行时的交付复审员。判断这一轮是否已经把用户要求的东西交付完毕。
只输出一个 JSON 对象，不要 Markdown、不要解释。
字段：satisfied(true|false)；reason(satisfied=true 时，一句话说明凭什么算交付完成)；missing(satisfied=false 时，一句话说明用户要求里还差什么)；nextStep(satisfied=false 时，一条可直接执行的下一步指令，指明还要写/改哪一份具体产物)。
判定原则：
- 以用户原话为准。用户要「五章」而只落地一章，未兑现；用户只要一章而落地一章，已兑现。
- 用户没有要求写入产物（提问、讨论、评估、只做审阅），只要回答本身正面回应了请求就算已兑现，不得因为没有文档而判未兑现。
- 「开账未落地」表示 Agent 已经动手交付但没有成功提交，这通常意味着未兑现，除非用户的要求本来就不需要那份产物。
- 只看是否交付到位，不评价文笔质量，也不追加用户没提的工作。
- 无法从事实判断时，倾向 satisfied=true，不要用猜测把运行拖住。`;

export function runFulfillmentMessages(
  snapshot: RunFulfillmentSnapshot,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    // CACHE: rules first, run facts last — same layout as the other tool-free calls.
    { role: "system", content: REVIEW_RULES },
    {
      role: "user",
      content: JSON.stringify({
        request: snapshot.originalRequest.slice(0, 2_000),
        deliveredDocuments: snapshot.delivered.slice(0, 12),
        stalledDeliveries: snapshot.stalled.slice(0, 12),
        otherArtifacts: snapshot.otherArtifacts.slice(0, 12),
        finalReply: snapshot.finalText.slice(0, 1_200),
      }),
    },
  ];
}

export function parseRunFulfillmentVerdict(content: string): RunFulfillmentVerdict | undefined {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced ?? trimmed;
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const text = (value: unknown): string => typeof value === "string" ? value.trim().slice(0, 400) : "";
  if (record.satisfied === true) {
    return { satisfied: true, reason: text(record.reason) || "复审认为用户要求已交付" };
  }
  if (record.satisfied !== false) return undefined;
  const missing = text(record.missing);
  const nextStep = text(record.nextStep);
  // A refusal with nothing actionable behind it would loop the run without moving it.
  if (!missing && !nextStep) return undefined;
  return {
    satisfied: false,
    missing: missing || "用户要求尚未完全交付",
    nextStep: nextStep || "继续完成用户请求中尚未交付的产物。",
  };
}

/**
 * The review is worth a model call only when the turn could plausibly have
 * under-delivered. Plan mode forbids writes by the author's own choice, and a run
 * that never touched a tool has nothing to audit beyond its own answer.
 */
export function shouldReviewFulfillment(input: {
  permissionMode: string;
  toolCallsMade: number;
  continuations: number;
}): boolean {
  if (input.permissionMode === "plan") return false;
  if (input.toolCallsMade === 0) return false;
  return input.continuations < RUN_FULFILLMENT_MAX_CONTINUATIONS;
}

export function runFulfillmentContinuationPrompt(
  verdict: Extract<RunFulfillmentVerdict, { satisfied: false }>,
  attempt: number,
): string {
  return [
    "交付复审判定本轮尚未兑现用户请求，请继续执行，不要用文字声称已经完成。",
    `还差：${verdict.missing}`,
    `下一步：${verdict.nextStep}`,
    attempt + 1 >= RUN_FULFILLMENT_MAX_CONTINUATIONS
      ? "这是最后一次复审补齐机会；若仍无法完成，请交付当前能确定的部分并说明剩余工作。"
      : "先完成这一项可验证交付，再判断是否还有剩余。",
  ].join("\n");
}

/** Pause text used when the review kept refusing until the continuation budget ran out. */
export function runFulfillmentPauseReason(
  verdict: Extract<RunFulfillmentVerdict, { satisfied: false }>,
): string {
  return `交付复审仍未通过：${verdict.missing}。已保留上下文，可点「续跑」继续。`;
}
