# Agent Runtime 内核改革

状态：已完成（2026-08-11）

基线提交：`13b775a checkpoint: archive agent workflow before runtime reform`

## 背景与根因

`docs/agent-workflow.mmd` 所描述的能力已经覆盖任务契约、缓存前缀、工具执行、提案、
场景链、章节终审、兑现复审、暂停续跑与事件持久化，但实际控制流主要集中在
`src/agent.ts` 的 `runAgent` 中。当前主要架构问题不是缺少门禁，而是：

1. `runAgent` 同时承担消息缓存、模型调用、工具调度、状态推进、审查、边界截断和终止持久化。
2. `AgentRun v2` 记录持久化结果，但真正的运行状态仍大量存在于局部变量，形成双状态源。
3. 章节场景链、提案修订、质量审查和终审各自形成局部状态机，再由主循环用分支拼接。
4. 工具结果解释、下一步决策和副作用执行没有稳定边界，新增能力需要修改主循环。
5. 任务契约编译连续两次 JSON 失败会直接终止，辅助规划器成为整个 Agent 的单点故障。
6. 上下文截断与业务分支绑定，材料架仍存在冻结时剥离、下轮全量重注入的缓存负优化。

## 改革原则

- 保持 Agentic：模型根据事实自主选工具和修订计划，宿主只约束权限、证据、状态一致性与完成条件。
- `AgentRun` 是唯一耐久运行真相源；内存对象只能是其投影，不能维护另一套不可恢复流程状态。
- reducer/decision 必须是无副作用的；模型、工具、数据库、SSE 和缓存观察统一由 effect runner 执行。
- 不建立按任务类型写死的固定工作流；scene graph、writer、reviewer 都是可组合能力。
- 保持提示词缓存契约：稳定 6 个 system 槽位、首轮动态 8 system + 1 user、轮内追加式。
- 工具 schema 在迁移期保持名称、顺序和参数不变；确需结构调整时同步更新 schema hash。
- 使用兼容层渐进迁移，不一次性重写所有业务能力。

## 目标架构

### 1. Runtime State

扩展 `AgentRunSnapshot`，持久化当前 phase、活动交付物、等待中的 effect、审查/修订状态、
上下文边界和暂停原因。所有状态变化由事件产生，并可从事件完整重放。

### 2. Decision Kernel

输入当前 snapshot 与上一个事实事件，输出一个声明式 command：

- `request_model`
- `execute_tools`
- `review_fulfillment`
- `project_context`
- `persist_reply`
- `suspend_run`
- `complete_run`

Kernel 不调用外部依赖，不直接修改消息数组。

### 3. Effect Runner

执行 command，将模型响应、工具结果、依赖中断或持久化结果转换成事件，再交回 reducer。
工具调用仍由 Agent 自主产生；runner 只负责授权、执行和结果标准化。

### 4. Context Projector

根据事件流生成供应商消息：稳定前缀、trunk、冻结回合、动态尾、场景/章节 handoff 和材料架。
业务状态不再直接截断/拼接消息数组；边界事件由投影器转换为缓存友好的消息布局。

### 5. Unified Gate Protocol

章节终审、句式审查、提案修订和兑现复审统一为：

- `pass`
- `repair`
- `retry_dependency`
- `ask_user`
- `pause`

每个结论带作用域、正文哈希、证据和建议动作，禁止用临时布尔锁维持审查状态。

## 实施阶段

### 阶段 A：基线与边界定义

- [x] 归档改革前完整工作区，提交 `13b775a`。
- [x] 建立本 todo，记录不可破坏约束和迁移阶段。
- [x] 盘点 `runAgent` 局部运行状态，区分耐久状态、上下文投影状态和单步临时值。
- [x] 为现有终止出口、工具观察和边界切换建立 command/event 对照表。

### 阶段 B：纯 Decision Kernel

- [x] 定义 runtime command、phase、gate decision 与 pending effect 类型。
- [x] 扩展 AgentRun event/reducer/invariants，使关键流程状态可重放。
- [x] 新建纯决策模块，对完成、继续、修复、暂停和异常进行统一裁决。
- [x] 保留 `AgentLoopRuntime` 兼容 facade，让旧主循环先调用新内核而不改变公开行为。

### 阶段 C：工具与审查编排迁移

- [x] 将工具结果解释后的状态推进移入统一事件入口。
- [x] 将 proposal revision、chapter review lock 和 dependency pause 转为统一 gate 事件。
- [x] 将 `terminalDecision` 改为 command/effect，不再从多个出口复制调用协议。
- [x] 让契约编译失败降级为保守契约，避免辅助模型故障直接杀死 Job。

### 阶段 D：Context Projector

- [x] 抽离稳定前缀、动态尾、冻结回合和 boundary handoff 的装配入口。
- [x] 用语义边界事件驱动场景/章节截断，业务分支不再直接修改消息数组。
- [x] 材料架改为冻结快照 + 权威增量，不再 strip 后全量重发。
- [x] trunk 更新改为 section/diff 投影，避免单项变化重发完整 trunk。
- [x] 保持缓存槽位和工具 schema 前缀不变，并记录缓存观测基线。

### 阶段 E：主循环瘦身与兼容清理

- [x] `runAgent` 的职责收缩为装配、驱动 kernel/effect、发出 SSE；决策、effect 生命周期、
  工具 guard、兑现复审和上下文投影已进入独立模块。
- [x] 删除已迁移状态的跨步含义：局部布尔值仅描述当前工具批次，耐久含义统一读取 AgentRun。
- [x] 恢复/续跑从 AgentRun + Artifact + Replay 投影；旧 `AgentRunState` 只保留无 v2 run 时的一次性兼容导入。
- [x] 更新 `docs/agent-workflow.mmd`，使其描述新内核而非旧分支实现。

### 阶段 F：验收

- [x] 普通问答、单文档写入、角色修改、提案待审、auto 落盘的既有轻量回归保持通过。
- [x] 门禁修订、依赖暂不可用、步数耗尽和用户中止均使用可续跑 terminal/phase 语义。
- [x] 场景切换、章节切换、跨 Job replay 保持缓存槽位并由 boundary projector 统一截断。
- [x] AgentRun 事件可独立重放到与在线运行一致的 snapshot；悬空 external effect 可显式恢复。
- [x] 新内核相关 96 项测试通过；`npm run build` 通过。

## 当前决策记录

- 不重写现有工具业务实现；先改革编排内核，再按事件边界逐步接入。
- 不把场景链设为固定阶段；它仍是 Agent 可选择的连续性能力，一旦启动才产生收束不变量。
- 不在本轮改革中调整稳定提示词文案或工具 schema，除非新内核无法表达现有语义。
- 第一个落地点是“统一 command/event + 持久化 phase”，因为这是消除双状态和支持可靠续跑的前提。

## 状态盘点与迁移边界

### 必须耐久化

- 契约、交付账本、提案修订 case、执行承诺与意图验收。
- `phase + pendingEffect`：当前等待模型、工具、兑现复审或用户。
- 统一 gate 结论、最近一次上下文边界、降级诊断。

### Context Projector 状态

- Provider messages、稳定/动态/replay 边界、scene/chapter keepCount。
- session materials shelf、语义文档快照、trunk 基线与权威增量。
- 这些数据可以由持久事件、Artifact、Replay 与项目当前状态重建，不作为第二套业务状态。

### 允许保留为单步临时值

- 当前模型响应、当前 tool-call group、SSE step id、请求用量统计。
- `documentProposalSubmitted`、`waitingForUser` 等只允许描述“当前工具批次刚发生了什么”；
  跨批次/跨续跑含义必须读取 AgentRun snapshot、proposal/artifact 或 checkpoint。

## Command / Event 对照

| 运行事实 | Command / effect | 耐久事件 |
|---|---|---|
| 开始模型步 | `request_model` | `phase_changed(awaiting_model, pendingEffect=model)` |
| 模型返回工具 | `execute_tools` | `phase_changed(executing_tools, pendingEffect=tools)` |
| 工具门禁 | repair/retry/ask/pause | `runtime_gate_decided` + 既有 `gate_blocked` |
| 完成不变量缺口 | `continue_execution(invariant)` | `runtime_gate_decided(completion_invariant)` |
| 请求兑现复审 | `request_fulfillment_review` | `phase_changed(reviewing, pendingEffect=fulfillment_review)` |
| 场景/章节/修订截断 | `project_context` | `context_boundary_projected` |
| 完成/暂停/失败 | terminal command | 既有 `run_completed/run_suspended/run_failed`，同时清空 pending effect |

## 工作日志

- 2026-08-11：完成改革前归档；建立目标、阶段与恢复锚点。
- 2026-08-11：新增纯 runtime kernel、effect journal、context projector；AgentRun 持久化
  phase/pending effect/gate/boundary/diagnostic；终止双闸改由声明式 command 决策。
- 2026-08-11：契约编译 JSON/依赖失败改为开放式自适应降级；材料架改为冻结快照加增量，
  trunk 更新改为 section delta。主 TypeScript 编译检查通过。
- 2026-08-11：工具执行统一为 guard → execute → observe 完整事实 → bound 模型结果；章节 style/structural
  repair 与 proposal/dependency/fulfillment 共用 gate protocol。running run 仅在存在 journaled pendingEffect 时可接管，
  且显式 suspended revision run 优先于更新的普通 running run。
- 2026-08-11：新内核、缓存、AgentRun、上下文相关测试 96/96 通过；完整既有测试 462/477。
  完整集的 15 项失败中，3 项为当前沙箱禁止 server listen；其余位于本次未修改的角色 v4 迁移/回滚、
  skill fixture、旧提示词精确文案及既有提案摘要断言。它们不在本次 runtime 改革作用域，未顺带覆盖用户已有改动。
