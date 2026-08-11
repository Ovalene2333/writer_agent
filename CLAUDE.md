# Claude 项目约定

完整协作规则见 `AGENTS.md`，必须同时遵守。

排查 Writer 的会话、Job、Agent Run、模型用量或缓存日志时，第一步运行：

```bash
npm run --silent snapshot:logs -- -p ./p/<name> -q "<用户原始排障问题>" [--job <id>] [--run-id <id>]
```

必须把用户的原始问题（例如“为什么 fail 了”“为什么没有输出”）原样传入 `-q`，让廉价模型围绕该问题取证，
不要先做无目标的全局日志分析。

先使用命令 stdout 的纯文本快照完成判断。只有快照明确指出证据不足，或需要核对其中的 `ev-*`
引用时，才读取同目录的 `evidence.json`，最后才按 `docs/db-query.md` 查询原始数据库。不要默认把完整日志、
steps 或数据库查询结果载入当前上下文。
