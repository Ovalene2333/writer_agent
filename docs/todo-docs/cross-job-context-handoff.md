# 跨 Job 上下文衔接风险登记

状态：待修复

> 日期：2026-08-11 · 方式：只读 Code Review，未改动代码。范围：session 内跨 job 的上下文衔接链路（agent_turn_blocks 回放、completed_job 边界、续跑恢复、材料架、交接节点、run 快照）。

## 机制摘要

- 每个 job 结束时 `freezeCurrentTurn()` 把本轮字节原样追加进 `agent_turn_blocks`；下一 job 经 `loadReplayMessages` 按预算回放（逐块压缩 + 丢头 + hysteresis）。
- 完成且末交付为叙事文档时：`persistChapterHandoff` → `applyContextBoundary("completed_job")` 截断到开 turn 前缀 → 注入紧凑交接块 → `clearAgentTurnBlocks` + 重冻结单块（`src/agent.ts:5800-5811`）；此后回放链 = 旧 turn 动态块 + 交接 + 交付摘要。
- 中断/取消/预算耗尽：保留完整链，续跑 job 回放恢复。
- 跨 job 持久状态：材料架（digest）、上下文图 handoff 节点（最近 5 个进 L2）、trunk pin + delta、`agent_checkpoint`（场景草稿）、`agent_runs`（run 快照）、session artifacts（修订案 / verdict receipts / 质量报告 / writing memory）。

## R1（高）clear-then-append 非原子 + freeze 静默吞错

- 位置：`src/agent.ts:5809-5811`（`clearAgentTurnBlocks` 与 `freezeCurrentTurn` 内的 `appendAgentTurnBlock` 两个独立事务）+ `src/agent.ts:4291`（`freezeCurrentTurn` 整体 `catch {}` 静默）。
- 风险：两者之间崩溃、或 append 失败被吞 → 链已清空且交接块未写入 → 下一 job 回放为空，整个对话历史与交接静默丢失，无日志可查；L2/shelf 只能兜底一部分。
- 修法：先 append 新块再清旧链（或两操作合并单事务）；freeze 失败至少 `recordDiagnostic`，不能只留空链。

## R2（中）续跑依赖 planner 重新分类任务，恢复可能错位

- 位置：`src/agent.ts:3261`（`compileWritingTaskContract` 用「续跑」提示词全新分类）+ `src/agent.ts:3290`（`task.continuation = true` 为事后标记）。
- 风险：分类漂移（非 write_scene / targetPath 不同）时 `restoreChapterDraftCheckpoint`（`src/agent.ts:6157`）、volume、修订案与中断现场错位；`agent_run_controller.resumableForSession` 按 `originalRequest` 匹配的兜底不覆盖 runAgent 内部的新规划。
- 修法：resume 时以 run 快照的 contract / targetPath / 活动修订案优先覆盖 planner 输出（或跳过 planner 直接续跑）。

## R3（中）跨 job 内存态全部重置，patch 路径首调成本重复

- 位置：`src/tools/proposals.ts:972-983`（verdict cache 重灌仅发生在 `submitFullDocumentProposal`）；`gateProseStyle`（edit_file patch 路径，`src/tools/proposals.ts:1524`）跨 job 首调 cache 为空。
- 风险：同一句子的 Flash 裁决跨 job 首次重复计费；`workingTextFiles` / `readSnapshots` / `registerRisks` / `factContracts` / `writePack` 均为 per-job，跨 job 恢复依赖 session artifacts。
- 修法：patch 路径复用与提案路径相同的 receipt 重灌逻辑（按 path + sourceHash + 规则上下文）。

## R4（中）completed_job 边界只覆盖「末交付为叙事文档」

- 位置：`src/agent.ts:5782-5785`（`isNarrativeDocumentDelivery(submittedProposalRef.path)` 为 false 时不截断、不清理）。
- 风险：混合 job（章节 + lore 收尾）或纯设定 job 保留整条工具链，多 job 后旧链被预算压缩/丢弃；L2 仅保留最近 5 个 handoff（`src/context_graph.ts:459-466`），早期 job 细节只能工具重读。
- 修法：对任何已稳定收尾的 job 采用同样的紧凑交接（handoff 节点已覆盖叙事与非叙事路径），或明确非叙事交付的链保留策略并记录预期。

## 低优先级（不阻断，仅记录）

- R5：completed 后新冻结块含旧 turn 动态块（截断点 = `initialMessageCount`），下一 job 回放中旧 targetPath/todos 成为历史，语义正确但缓存前缀在该点重建。
- R6：`KEEP_WARM_TURNS=1` 保活逻辑在 completed 后失真——紧凑交接块无工具体却永不压缩，链条增长略快。

## 验收

- R1：completed 路径 append 新块后再清旧链；freeze 失败产生诊断记录而非静默。中断/崩溃恢复测试覆盖「链清空但交接未写」场景。
- R2：resume 时任务契约与中断现场一致（mode/targetPath/volume）；分类漂移时 run 快照优先。
- R3：patch 路径跨 job 首调不再重复 Flash 裁决同一句子；与提案路径 verdict 一致。
- R4：非叙事收尾 job 的链策略有明确预期。
- `npm run build` 通过；`agent_cache.test` / `turn_replay.test` / `context_graph.test` / `agent_run.test` 通过。
