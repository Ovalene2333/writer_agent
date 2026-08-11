# 门禁体系 Code Review 问题登记

状态：待修复

> 日期：2026-08-11 · 方式：只读审查 + 实证探针（已删除），未改动代码。范围：表面层门禁（surface_gates / meta leaks / 句式门禁 / 场景门禁 / 章级计量）、语义层（Flash 裁决 / 学习门禁 / 终审）、运行时门禁协议。

## 一、明确逻辑故障

### F1（高）`newProseStyleIssues` 降级绕过「必须修订」子类

- 位置：`src/prose_quality.ts:325-326`。`newProseStyleIssues` 对「新增且 error」的注册句式在**家族净计数未增加**时降为 warning（dialogue_correction → info，其余 → warning）。
- 与 `unified-narrative-validation.md` 2026-08-11 改动冲突：`escalateHardMannerisms`（`src/prose_quality.ts:186`）已把 `split_redefinition` / `abstract_reframing` 无条件置 error，但 diff 层又按净计数降级——净零替换（删一个「不是A而是B」换一个同型）即成为逃生通道。
- 实证：`before="他真正的想法，不是撤退，而是拖延。"` → `after="她真正的想法，不是恐惧，而是愤怒。"`，`newProseStyleIssues` 产出 `abstract_reframing:warning`，`proseStyleIssuesError` 返回 undefined（不拦截）。
- 修法：降级分支排除 `proseConstructionRequiresRevision(issue.constructionRuleId, issue.subtype)` 的实例（降级后重新执行该判定），或只在「非 revision-required」子类上做净计数降级。

### F2（高）单例硬拦与「家族预算」自相矛盾，报错文案误导

- 位置：`src/prose_quality.ts:159-168`（`sceneMannerismGateError`）＋ `src/prose_quality.ts:186-193`（revision-required 无条件 error）。
- 后果：千字场景内**1 个** `abstract_reframing`/`split_redefinition` 即阻断，而 `allowedOccurrences = max(1, chars*4/1万)`（1k 字允许 1 个）与 `reviewAtCount: 2` 未超限；报错头条仍为「本场句式家族预算超限」。章级同家族预算允许 4/万字，场景级 1 个就拒——同族两套标准，预算机制对这两个子类形同虚设。
- 实证：`sceneMannerismGateError("她看清了。这不是恐惧，而是愤怒。")` 返回「本场句式家族预算超限（1处硬拦截）」，`analyzeProseStyle` 仅 1 条 `abstract_reframing:error`。
- 修法二选一：(a) 确认为单例禁令 → 修正头条文案（如「叙述否定—改判句式必须修订」），删除该子类对预算的假引用；(b) 维持预算语义 → revision-required 子类在家族计数超限前不得硬拦，Flash 裁决仍负责判语义。

### F3（高）card_register 只识别「」角引号——对白样式盲区

- 位置：`src/register_risks.ts:435`（`splitDialogueAndNarration` 仅用 `/「([^」]*)」/gu` 切分对白）。
- 代码库明文允许三种对白引号样式（`src/dialogue_format.ts:40`：`「……」、“……”、"……" 均可`），`quoteDepthAt`（`src/prose_quality.ts:732`）已支持全样式，实现不一致。
- 后果：① dialogue 范围风险（voice_diction / voice_habit）在“”与 `"` 对白中**漏检**（区域判为叙述被 scope 过滤）；② 卡面措辞出现在“”对白时被计为**叙述命中**，可误触发「叙述命中 ≥ 2」阻断条件。
- 实证：同术语「回收协议」（scope=dialogue）：「」内 → warn（dialogue 1 处）；“”与 `"` 内 → pass（0 命中）。
- 修法：复用 `quoteDepthAt` 式引号栈（含「『“' 嵌套与 ascii 配对）重写 `splitDialogueAndNarration`，或统一抽取共享的引号区域切分工具。

### F4（高）`propose_document_patch` 门禁覆盖远弱于 edit_file——可绕行

- 位置：`src/tools/proposals.ts:1402`（`handleProposeDocumentPatch`）仅调用 `gateProseStyle`；对比 edit_file → `submitWorkingTextFile` → `handleProposeDocument` → `submitFullDocumentProposal`（全量门禁）。
- 提示词把 `propose_document_patch` 设为局部修改首选（`src/tools/documents.ts:428/509/527`「下一步直接调用 propose_document_patch」），同一 .md 章节两条路径门禁不对等：patch 路径缺 dialogue_format、card_register、章级计量（相邻复读/逐字回收）、语义终审；提案也不带 qualityReport。
- 修法：patch 路径补齐与 edit_file 一致的门禁面（或让 patch 走 `submitFullDocumentProposal` 的收尾段），至少补 surface gates 与 `chapterMetricsBlockError`；并补一条「patch 引入引号错配/卡面措辞必须被拦截」的回归测试。

## 二、风险点（门禁姿态与信任链）

### M1（中）语义裁决失败姿态三处不一致

- `src/tools/proposals.ts:763-768`：Flash 裁决仅在有硬错误时 fail-closed（`ToolDependencyError`）；临届密度（无 error、仅接近上限的 warning）在模型宕机时**静默放行**。
- 学习门禁：提案路径 `failClosed: true`（`src/tools/proposals.ts:782-792`），场景链 inspect（`src/tools/scene_pipeline.ts:1015`）未传 failClosed → fail-open。
- 同一次提交内两个语义门禁一闭一开。修法：明确临届 case 的期望姿态（fail-closed 或显式 `skipped` 标记随提案返回），并让场景链与提案路径统一。

### M2（中）场景链 receipt 自证 `styleReviewed/semanticReviewed`

- `src/tools/scene_pipeline.ts:1692`：`submitChapterDraftProposal` 自行构造 receipt（hash + 双 true），`submitFullDocumentProposal`（`src/tools/proposals.ts:956/1059`）据此整体跳过 style 门禁与语义终审；凭证未绑定实际 review 产物 ID（无 `narrative_validation` / `chapter_review` artifact 引用）。
- 若 inspect 时门禁以 fail-open 状态通过（模型降级），提交时不再复核。修法：receipt 绑定持久化 review artifact id / 通过记录，提交时校验其存在性与 inspectedVersion 一致。

### M3（低-中）`gateProseMetaLeaks` 抛普通 Error，不入门禁协议

- `src/tools/proposals.ts:108-112`：普通 `Error`，`agent_tool_outcome.ts:36-48` 的 `gateName` 匹配不到 → 不消耗 gate attempt、无 repairPacket，Agent 只能凭字符串盲改。
- 修法：改抛 `ToolRevisionRequiredError`（带证据与最小修法），或至少在消息中给出逐字命中与可替换文本。

## 三、低优先级

- L1：`gateProseStyleWithSparseAutoRepair` 尾部 return（`src/tools/proposals.ts:579-594`）不可达，死代码（循环在 `attempt >= MAX_ATTEMPTS` 时必然 return）。
- L2：dialogue_format 门禁 `.filter(issue => issue.blocksProposal)`（`src/surface_gates.ts:63`）恒真，死过滤。
- L3：`hardProseStyleErrors` 对无 policyId 的 learned_rule 靠 `issue.id/reason` 字符串嗅探 `quoted-text-count`（`src/prose_quality.ts:363-367`），改文案即失效，应改为显式字段。
- L4：verdict 缓存键为 `subtype|normalizedSentence`（`src/prose_adjudicate.ts:81-83`），跨文档/跨上下文复用语义裁决，存在上下文相关的误判固化风险（成本权衡，暂不改，需留意）。

## 验收

- F1：净零替换（删一增一同型句）不再放行 revision-required 子类；`prose_adjudicate.test.ts` 补对应用例。
- F2：场景门禁的阻断标准与报错文案自洽（二选一方案落地）。
- F3：card_register 对「」、“”、`"` 三种样式一致识别；补三样式对照测试。
- F4：patch 路径补齐缺失门禁面；补「patch 引入格式/措辞问题被拦截」回归测试。
- M1—M3：姿态一致化、receipt 绑定产物、meta leaks 入门禁协议。
- `npm run build` 通过；相关测试（`prose_quality` / `prose_adjudicate` / `register_risks` / `write_pack` / `agent_cache`）通过。
