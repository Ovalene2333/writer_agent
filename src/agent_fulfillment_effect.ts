import {
  parseRunFulfillmentVerdict,
  runFulfillmentMessages,
  type RunFulfillmentSnapshot,
  type RunFulfillmentVerdict,
} from "./run_completion.js";

export type FulfillmentReviewEffectResult =
  | { status: "reviewed"; verdict: RunFulfillmentVerdict }
  | { status: "unavailable"; reason: string };

/** Isolated semantic review effect; parsing/dependency failure never masquerades as a verdict. */
export async function executeFulfillmentReviewEffect(input: {
  snapshot: RunFulfillmentSnapshot;
  complete: (messages: ReturnType<typeof runFulfillmentMessages>) => Promise<string>;
}): Promise<FulfillmentReviewEffectResult> {
  try {
    const content = await input.complete(runFulfillmentMessages(input.snapshot));
    const verdict = parseRunFulfillmentVerdict(content);
    return verdict
      ? { status: "reviewed", verdict }
      : { status: "unavailable", reason: "意图验收未返回可解析结论" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "unavailable", reason: reason.slice(0, 400) || "意图验收调用失败" };
  }
}
