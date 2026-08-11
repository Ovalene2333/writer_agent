# 角色知识库 v4 与用途投影

状态：已完成

## 问题

- v3 将身份、事实、心理、目标、事件、剧情状态和表达偏好塞进一张整卡；任何小改都容易变成整对象读写，工具结果随上下文反复累积。
- `open → update → submit` 把资料修改固化成工作流，Agent 需要记住 draftId、revision 和内部条目 ID；简单修改也会产生多轮工具修复。
- 普通角色卡、正文人物候选和简易角色卡是三套实体，创建后难以晋升、复用和按用途裁剪。
- 稳定事实、时间状态、已发生事件与“不要怎样表述”没有权威分层，表达修订可能误伤事实。
- 心理和目标使用开放数组，长期追加近义标签与过期目标，导致卡片和上下文持续膨胀。

## 方案

- 停止把 `characters/characters.jsonl` 作为普通角色权威来源；新权威存储为 `characters/entities/char_<id>.json`、`characters/events/char_<id>.jsonl` 和 `characters/policies.json`。
- 普通角色与 Session 人物候选统一为 v4 `CharacterKnowledgeEntity`；实体包含生命周期、修订号和有类型的原子知识记录。旧 `Character` 仅作为内部消费者的兼容投影，不再暴露给 Agent。
- 稳定知识记录、时间状态、事件和表达政策分层。心理只有一个 active `psychological_model`；目标是带 horizon/status/priority 的生命周期记录，结束目标进入历史投影。
- 提供按目的生成并缓存的 `catalog | author | writing | roleplay | review | history` 投影；默认只返回摘要或分页记录，正文/评审继续获得可执行约束而不读取整卡。
- Agent 工具收敛为 `search_characters`、`get_character_context`、`change_character_knowledge`、`revise_character_expression`。修改工具内部统一处理 Session 暂存、ask 提案与 auto 接受，不要求显式工作流。
- mutation 返回紧凑 receipt，不回传完整实体。表达修改仅创建/更新表达政策，并校验事实记录哈希未变化。
- 旧 v3 文件只备份为 `characters.v3.backup.jsonl`，不自动迁移也不再读取；旧角色工作副本失效。后续只允许人工选择性迁移。
- 保留 `simple-characters.jsonl` 及简易卡 API，作为角色扮演兼容资产；它不进入普通写作知识库，也不替代普通角色实体。

## Agentic 边界

- Agent 可以直接搜索、读取目的投影或提交一个知识事务，不强制先打开/后提交。
- 硬门禁只覆盖实体/引用存在性、expectedRevision 冲突、记录生命周期非法、关系目标越界，以及表达修订改变事实哈希。
- 内容密度、证据充分度和相似项只作为 receipt/advisory，不用数值规则阻塞普通资料整理。
- 正文任务中新人物默认写入 Session 候选实体；明确的项目角色资产任务才可提交项目级实体。

## 验收

- 新 Agent 请求中不存在 v3 整卡、`open/update/submit_character_draft`、`save_character` 或 `apply_character_changes` 工具。
- 普通角色读取来自 v4 文件；`characters.jsonl` 即使存在也不会参与索引或写作。
- 新建、更新和表达政策在 ask/auto 下使用同一事务语义，并返回不含完整实体的紧凑 receipt。
- 写作包、正文、场景链和终审可继续获得角色能力、状态、声线与事实约束。
- 心理至多一个 active 模型；目标按生命周期查询，已结束目标不进入默认 writing 投影。
- 简易角色卡的创建、读取和角色扮演选择保持兼容。
- 工具 schema 哈希与缓存契约测试更新，源码完成后统一 `npm run build`。

## 实施结果

- v4 实体、事件、表达政策分层存储与用途投影缓存已落地；旧 v3 在项目首次打开时归档，不再进入运行时索引。
- 主 Agent、正文模型、写作包、场景链、终审和普通角色编辑统一从用途投影取数；角色模式不再走独立整卡生成链。
- 四个知识工具已成为 Agent 公开接口，旧整卡/工作副本工具只保留为历史记录回放的内部兼容代码。
- 简易角色卡存储与角色扮演入口保持不变，且与普通写作知识实体明确隔离。
- 已通过构建及角色知识、工具 schema、提示词缓存、Agentic 交付账本相关测试。
