# Claude 项目约定

完整协作规则见 `AGENTS.md`，必须同时遵守。

排查 Writer 的会话、Job、Agent Run、模型用量或缓存日志时，第一步运行：

```bash
npm run --silent snapshot:logs -- -p ./p/<name> -q "<用户原始排障问题>" [--job <id>] [--run-id <id>]
```

必须把用户的原始问题（例如“为什么 fail 了”“为什么没有输出”）原样传入 `-q`。该命令不调用模型，
只生成 Job、Run、输出、提案、错误、用量和缓存的确定性 facts；先由当前 Claude 根据 facts 回答。

只有 facts 不足时才运行 `npm run --silent snapshot:logs:direct -- ...` 调用项目 summarizer/DeepSeek；只有确需
自主文件探索时才使用 `snapshot:logs:opencode`。需要核对 `ev-*` 时读取同目录 `evidence.json`，最后才按
`docs/db-query.md` 查询原始数据库。不要默认把完整日志、steps 或数据库查询结果载入当前上下文。
