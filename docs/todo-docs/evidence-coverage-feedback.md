# 覆盖门禁反馈信息与交付验收证据面

状态：已修复

## 问题 1：覆盖门禁报错漏掉角色标识，导致 Agent 空转

### 数据证据（Job `jMXZDoHsIFNh-fRG`，jn3）

- `write_file` 连续失败 7 次，报错全部相同：`EVIDENCE_COVERAGE_REQUIRED：先 get_character(view=sections, sections=["motivations"]) 读取对白所需原始分区。`（事件 seq 30/34/36/46/50/54/58/61/65）。
- 实际缺口是**温晚（id=5）**的对白分区 `motivations`，但报错消息不含角色名/ID。
- `context_artifacts`（kind=`get_character`）显示 Agent 反复读错角色：
  - 15:14:59 读 id=1 `["motivations"]` view=sections（仍失败）；
  - 15:19:48 读 id=1 `["motivations"]` **view=edit**（`characters.ts:154` 仅 `view=="sections"` 才记录证据，白读）；
  - 15:21:35 读 id=1 `["motivations","voice"]` view=sections（仍失败）；
  - 15:22:26 才读 id=5 `["motivations"]` view=sections → 门禁通过。
- 期间每次失败后约 1-2 步才发起下一次 `write_file`，前后共耗时 15:14:36→15:22:26（约 8 分钟）。

### 信源（代码）

- `src/narrative_evidence.ts:299-331`：`characterCoverageGaps` 的 `gap` 对象带 `characterName`/`characterId`，但 `action` 字符串只写 `sections`，丢弃角色身份。错误经 `evidence_grounded_writer.ts:349` 拼接 `gap.action` 抛出。
- `src/tools/characters.ts:154-156`：`recordCharacterEvidenceRead` 只在 `view === "sections"` 时执行，`view=edit` 不记录证据读取。

## 问题 2：write/edit 提案摘要无内容信息，意图验收无法确认交付

### 数据证据（Job `jMXZDoHsIFNh-fRG`，jn3）

- 提案 366-369 的 `summary` 均为 `写入/编辑 <path>`（如 368：`编辑 chapters/林千夏启程/chapter-03.md`），不含正文内容摘要。
- chapter-03 已于 15:24:51 accepted（提案 368，`deliverable_recorded`），6 秒后意图验收仍判 `unsatisfied`："第三章尚未完整交付"（事件 seq 78）。
- 于是 run 重新 `compile_write_pack` + `write_file` 整章重写（提案 369，document-4，15:28:00），第二次验收仍 `unsatisfied`（seq 86），直到 15:29:14 模型把完整交付摘要写进 transcript 才 `satisfied`（seq 94）。
- 根因：验收模型看到的 `delivered` 证据 = `label：proposal.summary`，而 summary 只有工具动词+路径，无法确认正文已交付。

### 信源（代码）

- `src/tools/schema.ts:204-244`：Agent 侧 `write_file`/`edit_file` schema **没有 `summary` 字段**。
- `src/tools/files.ts:95-103`：`fileMutationSummary` 无 summary 时兜底为 `写入/编辑 <path>`，经 `submitWorkingTextFile`（`files.ts:105-119`）写入提案。
- `src/agent.ts:3922-3933`：`deliveredIntentEvidence` 只取 `proposal.summary`（不足 300 字）作为验收输入。
- `src/agent.ts:3986-4047`：意图验收是独立模型调用，只读 `deliveredIntentEvidence` 快照，无读文件能力。

## 修法

- 问题 1：`characterCoverageGaps` 的 `action` 加入角色身份，如 `角色「${evidence.name}」(id=${evidence.id})`；同时确认错误消息把 `characterName` 一起抛出。
- 问题 2：`write_file`/`edit_file` 落库时若无 `summary`，从 `after_content` 自动生成 2-3 行内容摘要写入提案（或由证据型 Writer 返回的摘要补齐），供 `deliveredIntentEvidence` 使用。

## 验收

- 构造缺 `motivations` 的场景，报错消息含角色名/ID；Agent 一次 `get_character(view=sections)` 后门禁通过。
- `write_file` 省略 content 委托 Writer 的提案 `summary` 非空且含正文信息；重跑同类任务不再出现"已 accepted 仍被判 unsatisfied 而整章重写"。
- 工具 schema 哈希与构建通过。

## 完成记录（2026-08-11）

- 覆盖缺口统一从结构化 `characterName` / `characterId` 格式化 Agent 指令，`view=edit` 仍不计入写作证据。
- 叙事提案复用已完成语义终审的 `chapterChange`；普通文件变更生成含标题、开头与结尾的有界正文摘要。
- 意图验收不再只依赖提案摘要，同时读取提案状态、正文长度及有界正文证据，兼容历史通用摘要。
- 未修改工具 schema 或稳定提示词槽位。
