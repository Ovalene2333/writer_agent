# 自动校验与廉价模型日志分析工作流

状态：二期已完成（2026-08-11）

恢复基线：`45b0583 refactor(agent): introduce event-driven runtime kernel`

## 目标

建立一个可自动运行、可审计、可替换分析模型的日志校验闭环。Writer 宿主只负责只读取证、
脱敏、预算、证据引用校验和报告持久化；模型负责理解异常、提出假设并按需请求更多证据。
工作流不依赖固定关键词或写死的故障分支。

首版支持两种分析器：

- `direct`：复用 Writer 供应商目录中的 `summarizer` 模型，适合直接指定低价 DeepSeek。
- `opencode`：调用 `opencode run --agent plan --format json --model provider/model`，利用便宜模型
  做只读 Agent 分析；可覆盖可执行文件以兼容 WSL / Windows / CI。

## 架构约束

- 默认仅收集运行元数据、结构化事件、有界步骤摘录和 prefix-cache 汇总；不导出供应商密钥。
- 正文与完整对话不自动进入证据包；任何文本片段都经过字段级脱敏和长度上限。
- 分析器只能引用宿主发放的 evidence ID；无有效证据的 finding 降级或拒绝。
- 模型可返回 `need_evidence` 请求补充证据，由宿主按白名单能力和轮次/字节预算裁决。
- 外部分析器运行在只读 `plan` Agent；宿主不接受其文件修改作为分析结果。
- 每次运行在目标项目 `.writer/analysis/log-audit/<run-id>/` 保存 manifest、证据索引和最终报告。
- 不改变主 Agent 提示词槽位或工具 schema，避免破坏供应商缓存前缀。

## 实施清单

### A. 取证与安全边界

- [x] 定义 evidence、补取请求、finding、report、run manifest 的版本化结构。
- [x] 只读采集 `writer.db` 中近期 job/run/event/step/model usage 的诊断投影。
- [x] 聚合 `.writer/logs/prefix-cache.jsonl`，避免把数十 MB 原始日志直接送给模型。
- [x] 实现字段级秘密脱敏、单项/总字节预算、时间/会话/job 范围过滤。

### B. Agentic 分析循环

- [x] 实现分析协议：`need_evidence` 或 `complete`，允许模型基于假设自主补证。
- [x] 校验 evidence ID、严重度、置信度和重复 finding；记录被拒绝的模型输出。
- [x] direct 驱动复用 `completeProviderCompletion` 与 summarizer 模型配置。
- [x] OpenCode 驱动采用参数数组启动，无 shell 拼接；支持 bin/model/attach 覆盖与超时。

### C. CLI 与持久化

- [x] 新增 `writer log-audit`，支持 backend、model、scope、预算、collect-only、JSON 输出和严重度退出门禁。
- [x] 原子写入 manifest/evidence/report；失败时也保存阶段与错误，便于自动任务诊断。
- [x] 增加 package script 与使用文档，给出 OpenCode + DeepSeek 及 direct 示例。

### D. 验收

- [x] 轻量测试覆盖脱敏、预算、分析协议解析、证据引用校验和外部命令参数。
- [x] 使用本地项目执行 collect-only 烟测，不发送真实日志。
- [x] 完成源码后运行 `npm run build`。

### E. 面向上层 Agent 的纯文本快照

- [x] 每次 collect/audit 都生成有界 `snapshot.txt`，包含范围、结论、finding、证据索引与下钻路径。
- [x] 新增 `--text` 模式：stdout 仅输出快照正文，便于 Codex/Claude 直接作为低 token 上下文读取。
- [x] 支持 `-q/--question` 传递用户原始排障问题，使补证与结论围绕明确目标而非泛化体检。
- [x] OpenCode 后端允许省略 `--model`，复用用户已经配置的默认廉价模型。
- [x] 在 `AGENTS.md` 和 `CLAUDE.md` 登记“日志排障先快照、必要时再下钻”的默认协议。
- [x] 使用 WSL 原生 OpenCode 完成一次真实低成本端到端烟测，并复核快照体积。
- [x] 更新测试、文档并再次运行 `npm run build`。

## 决策记录

- OpenCode 官方 CLI 支持 `run` 非交互模式、`--format json`、`--model provider/model`、
  `--agent`、`--file`、`--attach` 和 `--dir`。适配器允许复用默认模型、显式指定原生可执行文件或
  headless server；2026-08-11 用户已在 WSL 安装并配置 OpenCode 1.18.16。
- 不让 OpenCode 自由扫描项目私有目录。宿主先生成最小证据包，OpenCode 只读取该文件并返回报告。
- direct 后端是稳定基线，OpenCode 是可选 Agent 外壳；两者共用同一证据和报告协议。

## 工作日志

- 2026-08-11：确认现有 Agent eval、prefix-cache 日志、model_usage 与供应商目录可复用；
  完成首版架构和安全边界设计，开始实施。
- 2026-08-11：实现版本化证据、主动补证循环、direct/OpenCode 双驱动、CLI、严重度退出门禁和报告归档。
  活跃 WAL 库在 WSL 挂载盘只读打开出现 `disk I/O error`，已从根因改为临时复制 db+wal+shm 后只读查询。
- 2026-08-11：协议/脱敏/预算/证据引用/OpenCode 参数测试 4/4 通过；`p/jn3` 以 96 KiB 预算完成
  collect-only 烟测，未调用模型，生成证据约 86 KiB，未发现密钥形态。
- 2026-08-11：`npm run build` 完整通过；Vite 仅报告既有第三方 `use client` 与动态/静态重复导入警告。
- 2026-08-11：二期增加 `snapshot.txt`/`--text`、OpenCode 默认模型、用户问题 `-q`、Codex/Claude
  仓库级先快照协议。修复 OpenCode 1.18.16 的 `--file` 数组吞掉 positional prompt、reasoning 事件误解析、
  `--fail-on none` 误返回 2 等真实烟测问题。
- 2026-08-11：WSL 原生 OpenCode 端到端验证通过；以“为什么这个 Job 当时没有输出？”为唯一问题，
  单轮生成 completed 快照并引用 Job/消息/Run/提案证据。快照硬上限收紧为 12,000 字符。
- 2026-08-11：二期完整构建通过，专项测试 6/6；Vite 仅保留既有第三方与 chunk 提示。
