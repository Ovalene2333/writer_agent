# Agent 质量报告取证闭环

状态：已完成

## 数据证据

- Job `ovTdNKYA8UnTkxjx` 修改前已有精确正文哈希对应的 `contrast_density` 报告，但 Agent 文件工具无法读取。
- Agent 人工通读后把命中从 14 次降至 7 次，修改后报告仍超限，运行仍因文件已落地而结束。

## 修法

- 新增 `get_document_quality_report`，按 `path + sourceHash` 读取报告；缺失或旧版本仅生成一次。
- 新增 `document_quality_reports` 持久化缓存，提案、修订、Web 与 Agent 共用。
- 确定性质量项持久化完整 `occurrences`，UI 展示继续使用有界 `examples`。
- 改写流程优先读取已有报告，必要时再做语义审计；报告保持建议性质，不升级为统一硬门禁。

## 验收

- 同一正文哈希跨 Store 重开后返回 `cached=true`，报告内容与创建时间不变。
- 报告 schema 版本升级后旧紧凑报告只重建一次。
- 工具 schema 哈希与构建通过。
