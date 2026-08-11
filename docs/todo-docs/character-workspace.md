# Session 角色工作区与角色卡收缩

状态：已完成

## 问题

- `save_character` 同时承担新建、嵌套 upsert、整节替换和删除，且工具 schema 让 Agent 自行猜测大量内部字段与条目 ID。
- `apply_character_changes` 又暴露第二套角色修改协议；创建、手工编辑和正文演进没有统一事务边界。
- ask/proposal 模式下显式角色卡修改仍可能直接写入 `characters/characters.jsonl`，与正文交付的审批语义不一致。
- 心理区的 traits/values/fears/conflicts 和 motivations 都是开放数组，模型容易不断追加近义标签、临时意图和已结束目标。
- JSONL 每次整体读取、整体校验、整体重写，适合版本管理和交换，不适合作为 Agent 的直接交互协议。

## 修法

- 增加 Session 内持久化角色工作副本：打开、增量编辑、提交均使用服务端生成的 draftId/revision。
- Agent 交互视图将心理收缩为 core/dominantValue/centralTension/pressureResponse，将目标收缩为 primary/secondary/longTerm。
- 只有明确编辑对应分区时才归并旧开放数组；被收缩的旧条目进入兼容归档，避免静默丢失。
- 工作副本内部仍保存完整 v3 Character，JSONL 暂时保留为项目权威持久化格式。
- ask 模式提交角色工作副本生成仅含角色变化的 change set；auto 模式走同一 change set 后自动接受。
- 创建、替换与演进统一进入 change set 的角色修订事务，支持并发冲突检查和撤销/重做。
- 旧角色工具保留为历史调用兼容入口，但不再发给新的 Agent 请求。

## 验收

- Agent 无需构造完整 v3 JSON 或管理心理/目标条目 ID 即可创建、修改角色。
- 工作副本跨工具调用、跨续跑任务可恢复；revision 不匹配时拒绝覆盖。
- ask 模式提交前项目 JSONL 不变，接受 change set 后才落盘；auto 模式自动接受。
- 新角色创建也能进入 proposal/auto 的统一审批和回滚路径。
- 旧 v3 卡可继续读取；未编辑的分区不发生迁移或信息损失。
- 工具 schema 哈希、提示词缓存槽位测试和角色相关测试通过。
