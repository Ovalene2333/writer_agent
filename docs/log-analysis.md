# Agent 日志自动校验

`writer log-audit` 从 Writer 项目只读取证，用低价模型分析 Agent 运行异常，并把可复核报告保存在：

```text
<project>/.writer/analysis/log-audit/<run-id>/
├── manifest.json
├── evidence.json
├── report.json
└── snapshot.txt
```

证据包默认不包含正文、完整对话或供应商凭据。步骤轨迹只保留状态、工具名、错误和文本字符数；
prefix-cache 原始 JSONL 会先在本地聚合。模型提出的结论必须引用包内 `ev-*` ID，否则不会进入最终报告。
`snapshot.txt` 是给 Codex/Claude 的首选入口：纯文本、有界、不超过 12,000 字符；只有它不够时
才读取 JSON 或原始数据库。

## Codex / Claude 默认入口

OpenCode 已配置默认廉价模型时，不需要再传模型名：

```bash
npm run --silent snapshot:logs -- -p ./p/jn3
```

该命令的 stdout 只有快照正文，适合直接作为上层 Agent 的工具结果。聚焦目标可以显著缩短快照：

```bash
npm run --silent snapshot:logs -- -p ./p/jn3 --job <job-id> --run-id <run-id>
```

如果用户有明确问题，必须原样传入 `-q/--question`；它会成为分析器的首要目标并写入快照：

```bash
npm run --silent snapshot:logs -- \
  -p ./p/jn3 \
  --job <job-id> \
  -q "为什么这次 Job fail 了？"
```

另一个典型例子：

```bash
npm run --silent snapshot:logs -- \
  -p ./p/jn3 \
  --run-id <run-id> \
  -q "文件已经写入，为什么聊天里没有最终输出？"
```

仓库的 `AGENTS.md` 和 `CLAUDE.md` 已规定日志排障优先调用该入口：先读快照，必要时读其引用的
`evidence.json`，最后才查询原始 DB/日志。

## 先检查取证内容

```bash
npm run build
npm run audit:logs -- -p ./p/jn3 --collect-only
```

也可聚焦一次运行：

```bash
npm run audit:logs -- -p ./p/jn3 --job <job-id> --run-id <run-id> --collect-only
```

## 直接使用 Writer 的廉价模型

`direct` 是默认后端，使用 `provider-project` 的 `summarizer` 模型分工。先在供应商设置中把
summarizer 指向 DeepSeek 等低价模型，然后运行：

```bash
npm run audit:logs -- -p ./p/jn3 --backend direct
```

分析其他项目但复用一份供应商配置：

```bash
npm run audit:logs -- -p ./p/jn3 --backend direct --provider-project ./p/jn2
```

## OpenCode + DeepSeek

OpenCode 需先自行完成 provider 认证。省略 `--model` 时使用 OpenCode 当前默认模型；显式覆盖时模型 ID
使用 `provider/model` 格式：

```bash
npm run audit:logs -- -p ./p/jn3 \
  --backend opencode \
  --model deepseek/deepseek-chat
```

工作流实际调用非交互命令：

```text
opencode run --format json --agent plan --model <provider/model> \
  --dir <audit-run-dir> --file=<evidence.json> <audit-prompt>
```

OpenCode 的工作目录被限制在单次审计目录，`plan` Agent 只负责读取证据并输出 JSON。也可用
`--opencode-bin` 指定另一安装，或启动 `opencode serve` 后传 `--attach http://127.0.0.1:4096`。

## 自动任务建议

定时器或 CI 应先运行 `--collect-only` 检查证据边界，再启用模型分析。常用预算参数：

- `--since-hours 24`：时间窗口。
- `--limit 80`：每类数据库证据最大行数。
- `--max-evidence-kb 160`：所有证据的总预算。
- `--max-rounds 3`：模型主动补证轮次上限。
- `--timeout 300`：OpenCode 单轮超时秒数。
- `-q "问题"`：本次排障的唯一首要问题；上层 Agent 应直接传递用户原话。
- `--fail-on high`：出现 high 或 critical finding 时返回退出码 2，供 CI/定时任务报警；默认不门禁。

分析器可请求 `run_trace`、`job_trace`、`model_usage` 或更完整的 `prefix_cache` 聚合；宿主会拒绝
未知能力、重复请求和超预算请求。分析失败也会在 manifest 中记录阶段与错误。

OpenCode 无头运行、`--format json`、`--model`、`--agent`、`--file`、`--attach` 与 `--dir` 参数见
[OpenCode CLI 官方文档](https://opencode.ai/docs/zh-cn/cli/)。
