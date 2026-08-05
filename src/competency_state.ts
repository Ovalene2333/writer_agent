import type {
  Character,
  CharacterCompetency,
  CharacterCompetencyState,
  CompetencyAvailability,
  OutlineNode,
} from "./types.js";

export type CompetencyUseMode = "use" | "attempt" | "unlock" | "regain" | "lose";

export type SceneCompetencyUse = {
  competencyId: string;
  mode: CompetencyUseMode;
};

export type ResolvedCompetencyState = CharacterCompetencyState & {
  source: "story" | "legacy";
  storyStateId?: string;
};

const USE_MODES = new Set<CompetencyUseMode>(["use", "attempt", "unlock", "regain", "lose"]);
const AVAILABILITIES = new Set<CompetencyAvailability>(["available", "latent", "blocked", "lost", "unknown"]);

export function isCompetencyUseMode(value: unknown): value is CompetencyUseMode {
  return typeof value === "string" && USE_MODES.has(value as CompetencyUseMode);
}

export function isCompetencyAvailability(value: unknown): value is CompetencyAvailability {
  return typeof value === "string" && AVAILABILITIES.has(value as CompetencyAvailability);
}

export function legacyCompetencyState(competency: CharacterCompetency): ResolvedCompetencyState {
  return {
    id: `legacy:${competency.id}`,
    competencyId: competency.id,
    state: competency.unlocked ? "available" : "unknown",
    reason: competency.unlocked
      ? "旧版角色卡标记为已解锁；尚未迁移到剧情状态账本"
      : "旧版角色卡没有可解释的能力状态；不得据此推断为潜藏、封印或失去",
    source: "legacy",
  };
}

/**
 * Resolve the latest applicable state for every stable competency definition.
 * With an outline target, only anchored records at or before that target apply.
 * Without a target, array order is the author's current-state chronology and the
 * last record wins, including unanchored records used by outline-free projects.
 */
export function resolveCompetencyStates(
  character: Character,
  nodes: readonly OutlineNode[] = [],
  targetNodeId?: string,
): Map<string, ResolvedCompetencyState> {
  const resolved = new Map(character.competencies.map(item => [item.id, legacyCompetencyState(item)]));
  const order = new Map(nodes.map(node => [node.id, node.order]));
  const target = targetNodeId ? order.get(targetNodeId) : undefined;
  const indexed = character.storyStates.map((storyState, index) => ({ storyState, index }));
  const applicable = target === undefined
    ? indexed
    : indexed
      .filter(({ storyState }) => Boolean(storyState.outlineNodeId)
        && (order.get(storyState.outlineNodeId!) ?? Infinity) <= target)
      .sort((a, b) => {
        const nodeOrder = (order.get(a.storyState.outlineNodeId!) ?? -1) - (order.get(b.storyState.outlineNodeId!) ?? -1);
        return nodeOrder || a.index - b.index;
      });

  for (const { storyState } of applicable) {
    for (const state of storyState.competencyStates ?? []) {
      if (!resolved.has(state.competencyId)) continue;
      resolved.set(state.competencyId, { ...state, source: "story", storyStateId: storyState.id });
    }
  }
  return resolved;
}

export function competencyUsePolicy(
  availability: CompetencyAvailability,
  mode: CompetencyUseMode,
): { allowed: boolean; requirement: string } {
  if (availability === "available") {
    if (mode === "use") return { allowed: true, requirement: "可作为既有能力使用，但仍须遵守卡面限制与代价" };
    if (mode === "attempt") return { allowed: true, requirement: "可尝试使用，正文可以失败、受阻或只取得部分效果" };
    if (mode === "lose") return { allowed: true, requirement: "可在本场失去能力，正文须写明导致失去的事件与后果" };
    return { allowed: false, requirement: "能力入场时已经可用，不能把它重复写成首次觉醒或恢复" };
  }
  if (availability === "latent") {
    if (mode === "attempt") return { allowed: true, requirement: "只能尝试触发；没有成立的转变证据时不得稳定使用" };
    if (mode === "unlock") return { allowed: true, requirement: "本场可首次觉醒；正文须建立触发、来源与由不可用到可用的转变" };
    return { allowed: false, requirement: "潜藏能力不能直接使用；应选择 attempt 或 unlock" };
  }
  if (availability === "blocked") {
    if (mode === "attempt") return { allowed: true, requirement: "只能尝试突破阻断；失败或部分恢复均可" };
    if (mode === "regain") return { allowed: true, requirement: "本场可恢复；正文须解除既有阻断并写出恢复依据" };
    return { allowed: false, requirement: "受阻能力不能直接使用；应选择 attempt 或 regain" };
  }
  if (availability === "lost") {
    if (mode === "attempt") return { allowed: true, requirement: "只能尝试找回失去的能力；未恢复前不得直接生效" };
    if (mode === "regain") return { allowed: true, requirement: "本场可重获；正文须建立找回来源、触发与状态转变" };
    return { allowed: false, requirement: "已失去的能力不能直接使用；应选择 attempt 或 regain" };
  }
  if (mode === "attempt") return { allowed: true, requirement: "状态未知，只能试探；不得把成功当成既有事实" };
  if (mode === "unlock") return { allowed: true, requirement: "状态未知时可在本场建立首次获得，但必须写清来源、触发与转变" };
  return { allowed: false, requirement: "状态未知，不能直接承担关键因果；应选择 attempt 或有证据的 unlock" };
}

export function competencyUseInstruction(
  state: ResolvedCompetencyState,
  use: SceneCompetencyUse,
): string {
  const policy = competencyUsePolicy(state.state, use.mode);
  return `入场状态=${state.state}；本场模式=${use.mode}；${policy.requirement}。状态依据：${state.reason}`
    + (state.evidence ? `；状态证据：${state.evidence}` : "");
}
