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
  /** Landed artifacts as compact path/summary evidence, in ledger order. */
  delivered: string[];
  /** Deliveries the agent opened but never landed. */
  stalled: string[];
  /** Non-document artifacts observed this run (character cards, images…). */
  otherArtifacts: string[];
  /** Author-selected execution permission; plan mode is reviewed as a plan, not a write. */
  permissionMode: "ask" | "auto" | "plan";
  /** Previously locked global commitment. The reviewer may advance it, never silently shrink it. */
  executionPlan?: { commitment: string; remaining: string };
}

export type RunFulfillmentVerdict =
  | { satisfied: true; reason: string; planCommitment?: string; remainingPlan?: string }
  | { satisfied: false; missing: string; nextStep: string; planCommitment?: string; remainingPlan?: string };

/** Unsatisfied verdicts tolerated before the run pauses for 续跑 instead of looping. */
export const RUN_FULFILLMENT_MAX_CONTINUATIONS = 3;

const REVIEW_RULES = `你是写作运行时的交付复审员。判断这一轮是否已经把用户要求的东西交付完毕。
只输出一个 JSON 对象，不要 Markdown、不要解释。
字段：satisfied(true|false)；reason(satisfied=true 时，一句话说明凭什么算交付完成)；missing(satisfied=false 时，一句话说明用户要求里还差什么)；nextStep(satisfied=false 时，一条可直接执行的局部下一步指令)；planCommitment(Agent 已明确采纳的全局交付计划，简洁保留数量、范围、顺序等承诺)；remainingPlan(扣除已交付证据后仍需完成的全局计划)。
判定原则：
- 以用户原话为准。用户要「五章」而只落地一章，未兑现；用户只要一章而落地一章，已兑现。
- 已交付项包含路径和提交摘要；据此核对数量、范围和明确内容条件。摘要证据不足时要求最小核验，不得自行假定正文满足。
- 用户没有要求写入产物（提问、讨论、评估、只做审阅），只要回答本身正面回应了请求就算已兑现，不得因为没有文档而判未兑现。
- 「开账未落地」表示 Agent 已经动手交付但没有成功提交，这通常意味着未兑现，除非用户的要求本来就不需要那份产物。
- permissionMode=plan 时，按“是否提供了可执行且回应原意图的计划”验收，不要求产生写入产物；其他模式按实际请求验收。
- 只看是否交付到位，不评价文笔质量，也不追加用户没提的工作。
- Agent 在可见回复中明确采纳的计划（例如“全书规划为六章”）属于执行承诺。若 existingExecutionPlan 已存在，除非用户原话与实际证据证明该计划不可能或已被用户取代，不得把六章缩成五章，也不得用局部 nextStep 覆盖全局计划。
- planCommitment 只收录明确承诺，不记录推理过程；没有明确承诺且没有既有计划时可省略。remainingPlan 应随交付推进缩短，但不得改写 commitment。
- 无法判断时返回 satisfied=false，并给出最小的核验或补齐动作；不得在证据不足时声称完成。`;

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
        permissionMode: snapshot.permissionMode,
        existingExecutionPlan: snapshot.executionPlan,
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
  const planCommitment = text(record.planCommitment);
  const remainingPlan = text(record.remainingPlan);
  const plan = {
    ...(planCommitment ? { planCommitment } : {}),
    ...(remainingPlan ? { remainingPlan } : {}),
  };
  if (record.satisfied === true) {
    return { satisfied: true, reason: text(record.reason) || "复审认为用户要求已交付", ...plan };
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
    ...plan,
  };
}

/** Stable semantic evidence used to distinguish productive continuation from stagnation. */
export function runFulfillmentEvidenceFingerprint(snapshot: RunFulfillmentSnapshot): string {
  const artifactEvidence = {
    delivered: snapshot.delivered,
    stalled: snapshot.stalled,
    otherArtifacts: snapshot.otherArtifacts,
  };
  const hasArtifactEvidence = artifactEvidence.delivered.length > 0
    || artifactEvidence.stalled.length > 0
    || artifactEvidence.otherArtifacts.length > 0;
  return JSON.stringify({
    ...artifactEvidence,
    // Pure-answer tasks have no artifact ledger, so their visible answer is the evidence.
    ...(hasArtifactEvidence ? {} : { finalText: snapshot.finalText.trim().slice(0, 1_200) }),
  });
}

export type RunFulfillmentStagnation = {
  fingerprint: string;
  stagnantReviews: number;
  shouldPause: boolean;
};

export function advanceRunFulfillmentStagnation(
  previous: Pick<RunFulfillmentStagnation, "fingerprint" | "stagnantReviews">,
  fingerprint: string,
): RunFulfillmentStagnation {
  const stagnantReviews = fingerprint === previous.fingerprint
    ? previous.stagnantReviews + 1
    : 0;
  return {
    fingerprint,
    stagnantReviews,
    shouldPause: stagnantReviews >= RUN_FULFILLMENT_MAX_CONTINUATIONS,
  };
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
