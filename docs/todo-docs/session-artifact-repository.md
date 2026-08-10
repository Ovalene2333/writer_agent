# Session 统一资料库与草稿修订事务

状态：已完成

## 数据证据

- Job `bQt6dWwoKITPXAIE` 的三个章节均由写作包 + 正文模型生成，但门禁失败后没有形成可恢复的 revision case。
- 第一章同一正文第一次被句式门禁拒绝、第二次未修改即通过；第二次没有调用正文 Writer。
- 第二、三章的修订退化为主 Agent `read_file + edit_file`，写作包没有作为修订来源继续持有正文。
- 现有 `context_artifacts`、`document_quality_reports`、`narrative_semantic_reviews`、工作副本和 proposal 各自持久化，缺少统一状态与派生关系。

## 根因

- 提案产生前的草稿验证事务依赖后置 `deliverableId`，首次门禁失败时无法可靠保存和恢复。
- 写作包、草稿、修订包、门禁裁决、质量报告与 proposal 没有形成同一 artifact 版本链。
- 语义句式裁决未形成有效结论时仍可能按确定性扫描结果驳回，导致同一正文重试后翻转。

## 修法

- 将 `context_artifacts` 演进为 Session Artifact Repository：增加状态、元数据、更新时间与 artifact 关系。
- 写作包、工作草稿、修订案、句式门禁凭据、质量报告、语义终审和 proposal 自动登记，不要求 Agent 执行固定“保存”步骤。
- 门禁失败形成独立的 path-scoped revision case；proposal/auto 成功后才绑定 submitted/applied 交付结果。
- revision case 保存 write-pack artifact 引用；同一路径修订自动交回持有事实包的正文 Writer。
- 语义裁决失败或空结果返回 dependency unavailable，不得冒充正文 revision required。
- 同一正文哈希与门禁上下文复用持久化语义 verdict cache。

## 验收

- proposal 与 auto 模式均可在 proposal 产生前保存修订事务，不产生虚假交付证据。
- 首次门禁失败后 `write_file({path})` 会调用正文 Writer 定向修订，而不是原文重新送检。
- 同一正文、规则版本与上下文的门禁结论不会因依赖暂时失败而翻转。
- Session 重开或 Job 续跑后仍可恢复写作包、草稿、修订包、报告与裁决。
- 完整构建通过，既有工具 schema 与稳定提示槽位不变。

## 验收结果

- Session artifact 支持状态、元数据、版本化 key 与 `derived_from / supersedes / supported_by / validated_by / repairs` 等关系。
- `search_session_artifacts` 只返回目录摘要，`read_context_artifact` 按 ID 分页读取正文，避免把资料库全量注入提示词。
- path-scoped revision case 可在没有 proposal/deliverable 时持久化，并在同一 Session 的续跑任务中恢复。
- 写作包引用随 revision case 保存；驳回工作副本再次 `write_file({path})` 的测试确认会调用 evidence Writer 并携带 repair issues。
- proposal 测试确认状态为 `submitted`；只有接受后 artifact 才转为 `applied`。
- `npm run build` 通过；`agent_cache + tools/schema + write_pack` 共 109 项针对性测试全部通过。
