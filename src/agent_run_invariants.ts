import type { AgentRunSnapshotV2 } from "./agent_run_types.js";
import { pendingAgentRunDeliverables } from "./agent_run_reducer.js";

export function agentRunInvariantViolations(snapshot: AgentRunSnapshotV2): string[] {
  const violations: string[] = [];
  const artifactKeys = snapshot.deliverables.flatMap(item => item.evidence?.artifactKey ? [item.evidence.artifactKey] : []);
  if (new Set(artifactKeys).size !== artifactKeys.length) violations.push("同一文档产物被重复绑定到多个交付项");
  for (const item of snapshot.deliverables) {
    if ((item.state === "submitted" || item.state === "applied") && !item.evidence) {
      violations.push(`交付项 ${item.label} 缺少产物证据`);
    }
    if (item.state === "applied" && item.evidence?.proposalStatus !== "accepted") {
      violations.push(`交付项 ${item.label} 标记为已落盘，但提案证据未接受`);
    }
  }
  if (snapshot.status === "completed" && pendingAgentRunDeliverables(snapshot).length) {
    violations.push("运行已完成但仍有未完成交付项");
  }
  if (snapshot.status === "suspended" && !snapshot.nextAction?.trim()) {
    violations.push("暂停运行缺少可执行的 nextAction");
  }
  return violations;
}

export function assertAgentRunInvariants(snapshot: AgentRunSnapshotV2): void {
  const violations = agentRunInvariantViolations(snapshot);
  if (violations.length) throw new Error(`AgentRun 状态不一致：${violations.join("；")}`);
}
