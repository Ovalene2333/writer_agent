# 句式门禁 Flash 二判超时硬化

状态：已修复

## 数据证据

- Job `pnI_xQaBtjNmg-f4`（run `8bb3253f`，source 3021，2026-08-10 16:15）在 write_file 依据修订包重交后，门禁二判模型调用被中止：`tool_observed` outcome=`interruption`，message=`句式候选需要语义裁决，但审核依赖未形成有效结论：model_error:The operation was aborted`（16:21:00），随后 `run_suspended`「文件审核依赖暂时不可用；恢复后可续跑」，Job 卡 `waiting`。
- 前一 run `53519f5a`（source 3018，16:07）为**相同失败签名**，非个例。
- 时间窗 16:20:48→16:21:00 ≈ **12s**，命中 `src/prose_adjudicate.ts:127` `DEFAULT_TIMEOUT_MS = 12_000`。
- 供应商未宕机：同会话 16:20:39 `prose_gate` 调用成功（847 tokens）；16:32-16:47 多次 `prose_gate`/`learned_prose_gate` 均成功；实测该调用典型耗时 7-9s，12s 上限仅剩 3-5s 余量。
- 失败时已持久化 revision case（`revision:14b08ad4d3ef4a04`），可续跑；用户撤销 #3021 后重提交（3024）虽成功接受前两章，但第三章再次以相同 12s 签名 suspended，进一步确认并非偶发。

## 根因

- `src/tools/proposals.ts:690` 调用 `adjudicateProseStyleForProposal` 时**未传 `timeoutMs`**，该路径回落到 12s 硬编码默认（`src/prose_adjudicate.ts:127`）。
- 运行时配置 `proseGateTimeouts`（默认 primary 60s / final 180s，`src/agent_runtime.ts:55-56`，经 `src/agent.ts:3519-3522` 注入 `reviewTimeoutsMs`）只接入 learned gate 路径（`src/tools/proposals.ts:732`），**Flash 二判路径漏接**。
- 同类问题已在 `src/tools/proposals.ts:643-647` 注释登记（"jn3's healthy reviewer regularly needs more than 60 seconds…"），但当时只修 learned gate 一路，Flash 二判仍死磕 12s。
- 次要：`src/model_fetch.ts:17` `DEFAULT_PROVIDER_QUEUE_TIMEOUT_MS = 600_000`（10 分钟）并发队列排队等待过长，可能让 Job 长时间静默排队而无进展，且与外层 12s 信号叠加时语义混乱。

## 修法

- 让 `proseStyleGateIssues` 的 Flash 二判（`adjudicateProseStyleForProposal`）与 learned gate 一致，使用 `proseGateReviewTimeoutMs(modelIndex, modelCount, context.proseAdjudicator.reviewTimeoutsMs)`，删除该路径对 12s 硬编码的依赖。
- 复核 `DEFAULT_PROVIDER_QUEUE_TIMEOUT_MS` 的合理值（对齐外层信号或降到分钟级），避免"排队即静默 10 分钟"。
- 复核偏紧辅助调用：`writing_memory.ts:151` 15s、`author_policies.ts:365` 20s、`roleplay.ts:51` 20s，按日志确认是否频繁 `model_error`/`skipped`。

## 验收

- jn3 整章在供应商正常延迟（>12s）下不再把门禁二判打成依赖中断；run 不再无端 suspended。
- 同一正文、规则版本与上下文下，门禁结论不因暂时失败而翻转。
- 单次 `runAgent` 任务中消息序列与缓存契约不受影响；工具 schema 与稳定前缀不变。
- `npm run build` 通过；相关测试（`write_pack` / `prose_adjudicate` / `tool_failure` / `agent_cache`）通过。

## 完成记录（2026-08-11）

- Flash 二判已接入统一 `proseGateTimeouts`：多模型主判使用 primary，最后回退或唯一模型使用 final。
- 默认正式提案预算由隐式 12s 放宽为 primary 60s / final 180s，并继续服从设置管理中的 10—900s 可配置范围。
- 12s 低层默认仅保留给未显式配置的独立轻量调用，不再作用于正式提案门禁。
- 全局供应商队列及 writing memory / author policy / roleplay 辅助超时没有本问题的直接失败证据，本次不联动修改。
