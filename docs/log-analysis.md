# Agent 日志快照与分级分析

本工作流的首要目标是减少 Codex/Claude 排障时占用的 token 和主上下文。默认路径完全不调用模型：
宿主只读采集 Writer 运行数据，投影成不超过 12,000 字符的纯文本事实快照，当前 Agent 直接据此回答。

## 四层数据边界

```text
原始 writer.db / prefix-cache.jsonl
        ↓ 只读快照、脱敏、限量
evidence.json（结构化证据）
        ↓ 确定性字段投影，不做语义判断
snapshot.txt / stdout（低 token facts）
        ↓ facts 不足时才升级
direct 廉价模型 → OpenCode 自主探索
```

每次运行保存在：

```text
<project>/.writer/analysis/log-audit/<run-id>/
├── manifest.json
├── evidence.json
├── snapshot.txt
└── report.json       # 仅运行模型分析时存在
```

四层含义不得混淆：

- `facts`：程序从数据库字段确定性投影的事实，可以直接引用。
- `summary/findings`：模型推断，必须附带 `ev-*` 证据引用，仍需当前 Agent 判断。
- `evidence.json`：有界结构化证据；只在快照不够或需要核对引用时读取。
- 原始 DB/log：最后手段，按 `docs/db-query.md` 只读下钻。

## 一级：零模型事实快照（默认）

用户提出明确问题时，原样传给 `-q`，并尽量提供 Job 或 Run ID：

```bash
npm run --silent snapshot:logs -- \
  -p ./p/jn3 \
  --job <job-id> \
  -q "为什么这次 Job fail 了？"
```

```bash
npm run --silent snapshot:logs -- \
  -p ./p/jn3 \
  --run-id <run-id> \
  -q "文件已经写入，为什么聊天里没有最终输出？"
```

该命令等价于 `writer log-audit --collect-only --text`，不会启动 OpenCode、DeepSeek 或任何子代理。
stdout 只包含纯文本快照，主要 facts 包括：

- `JOB/JOB_DETAIL/JOB_FAILURE`：状态、类型、source message、terminal 长度和错误文本。
- `RUN/RUN_FAILED_TOOLS/DELIVERABLE`：phase、pending effect、步骤、交付状态与失败工具。
- `OUTPUT/PROPOSALS`：请求后的 assistant 消息、最后输出预览和提案状态。
- `STEPS/STEP_ERROR/RUN_EVENTS`：步骤工具分布、错误及最近语义事件。
- `MODEL/CACHE`：调用量、token、费用、命中率和主要前缀分叉。

指定 `--job` 时，Job、Run 和 model usage 都按该 Job 的 session/source/job_id 关联过滤；指定 Job/Run 时
默认不加入无法精确归因的项目级 prefix-cache 汇总。无聚焦 ID 的通用快照才输出 `CACHE scope=project_log_tail`，
提醒调用方它是项目日志尾部而非单次运行事实。

Codex/Claude 应先依据这些 facts 回答。比如 `terminal_chars=0` 但 `assistant_messages=1`，只能证明 Job
终端字段为空而聊天消息已持久化；是否属于 bug，仍由当前 Agent结合问题和代码判断。

## 二级：direct 廉价模型

事实不足、需要语义归因时，调用 Writer 供应商目录分配给 `summarizer` 的模型。推荐将该角色指向
DeepSeek 等廉价模型：

```bash
npm run --silent snapshot:logs:direct -- \
  -p ./p/jn3 \
  --provider-project ./p/jn2 \
  --job <job-id> \
  -q "为什么这次 Job fail 了？"
```

direct 后端直接复用 `completeProviderCompletion`，没有 OpenCode 冷启动、文件工具、plan Agent 或 JSON
事件流。模型可以按白名单请求补充 `run_trace`、`job_trace`、`model_usage` 和 prefix-cache 聚合；宿主限制
轮次、字节数和 evidence ID。

## 三级：OpenCode（需要自主探索时）

只有分析确实需要外部 Agent 自主读取证据文件，才运行：

```bash
npm run --silent snapshot:logs:opencode -- \
  -p ./p/jn3 \
  --job <job-id> \
  -q "为什么这次 Job fail 了？"
```

省略 `--model` 时使用 OpenCode 已配置的默认模型；也可显式指定：

```bash
npm run --silent snapshot:logs:opencode -- \
  -p ./p/jn3 \
  --model deepseek/deepseek-chat \
  -q "分析这次运行为什么反复重试"
```

实际以 `opencode run --format json --agent plan --dir <audit-dir> --file=<evidence.json>` 运行；工作目录
限制在单次审计目录。可用 `--attach` 连接常驻 `opencode serve`，减少冷启动。OpenCode 仍是外部工具，
不是 Codex 原生子代理。

## 参数与自动化

- `-q, --question`：用户原始排障问题；明确问题时必须传递。
- `--job` / `--run-id`：聚焦目标，同时补充步骤/消息/事件事实。
- `--since-hours 24`：无明确 ID 时的时间窗口。
- `--limit 80`：每类数据库证据最大行数。
- `--max-evidence-kb 160`：所有 evidence 的总预算。
- `--max-rounds 3`：仅模型分析使用的补证轮次。
- `--timeout 300`：OpenCode 单轮墙钟上限；不影响零模型快照。
- `--fail-on high`：模型报告达到阈值时返回退出码 2；默认不门禁。
- `--json`：输出完整结构，不与 `--text` 同用。

自动任务应默认执行一级快照。只有调用方确认 facts 不足，才显式选择二级或三级；禁止失败后无上限
自动重试模型。

## 隐私与可靠性

- 不采集正文、完整对话或供应商凭据；focused Job 只保留有界 assistant 预览。
- Agent Run 原始请求、执行承诺和长 reasoning 不进入 evidence。
- 活跃 WAL 数据库先复制 `writer.db + -wal + -shm` 到临时目录，再只读查询并清理。
- prefix-cache 原始 JSONL 只做本地聚合，不直接进入模型上下文。
- 快照即使截断，也保留 `evidence_json` 路径，便于精确下钻。

仓库的 `agents.md` 与 `CLAUDE.md` 已登记同一分级协议。OpenCode 参数参考
[OpenCode CLI 官方文档](https://opencode.ai/docs/zh-cn/cli/)。
