# 统一正文验证与交付裁决

状态：已完成

## 数据证据

- 写作包 + 正文模型通过普通 `write_file` 提交，场景链通过 `inspect_chapter_draft` 提交，两条路径使用了不同的章级指标裁决。
- `chapters/林千夏故事/chapter-01.md` 的持久化质量报告记录 `contrast_density` 10 次（18/万字），提案仍被接受；同一指标在场景链曾由 `chapterMetricsBlockError` 直接阻断。
- 逐句语义裁决把 `allow` 实例完全排除出句式家族统计，与 `countsTowardFamilyBudget` 的独立含义冲突。

## 目标

- 正文来源只决定如何生成，不决定使用哪套质量标准。
- 所有 `chapters/`、`side/` 候选正文共享按 `path + sourceHash` 持久化的验证快照。
- 确定性事实、格式、重复与逐字回收可以阻断；审美密度作为整章语义终审的定位证据，不按数字机械拒收。
- 场景链复用与当前正文哈希匹配的验证凭证，不使用无版本约束的布尔跳过参数。
- Agent 可按需读取质量报告；不把读取报告固化为每次写作的前置步骤。

## 验收

- 普通正文、写作包正文和场景链正文生成相同的质量报告与确定性 blocker。
- `contrast_density`、`dash_density` 在全部路径中均为整章语义信号，不再只在场景链形成数字硬门禁。
- `semanticVerdict=allow` 但 `countsTowardFamilyBudget=true` 的实例仍参与家族计数。
- 场景链终审通过后的提交只复用相同 `sourceHash` 的凭证。
- 同一正文哈希的质量报告跨 Store 重开继续复用。
