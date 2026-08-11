# 缓存前缀优化清单（基于 p/jn3 实测）

状态：已完成（2026-08-11）

> 依据：`src/agent.ts` 顶部 `PROMPT / PREFIX-CACHE CONTRACT`、`src/prefix_cache.ts`、
> `src/turn_replay.ts`，以及 p/jn3 `.writer/logs/prefix-cache.jsonl` 与 `model_usage` 实测。
> 本文只列「有数据支撑」的问题与修法；不改动契约的 6+8+1 槽位布局。

## 1. 现状基线（p/jn3 实测命中率）

| 区间 | 命中率 | 说明 |
|------|--------|------|
| 轮内 step→step | 85–99% | 预测误差 ±500 token 内，主链路健康 |
| 轮间（新 job 首步） | 21–71%，部分 0% | 主要漏损点，见 §2/§3 |
| `direct_chapter_review` | ~10%（~24k prompt） | 每章一次，≈20k×章数 全 miss |
| `evidence_grounded_document_writer` | 36–68%（26–43k） | 每场景一次，大提示 |
| `prose_gate` / `learned_prose_gate` | 13% / 35%（~3k） | 每场景都调，累计可观 |

## 2. 负优化（先修）

### 2.1 材料架 strip + 全量重注入 —— 轮间 replay 字节断裂（最高优先）

- 位置：`freezeCurrentTurn` 在 `src/agent.ts:3985` 调用 `stripFrozenMaterialsShelfMessages`
  从冻结块中删除材料架消息；同时每次开场 `src/agent.ts:3631` 又把材料架全量注入动态尾。
- 机制：本轮请求实际发给供应商的字节顺序是 `[merged][shelf][transcript]`；
  冻结块删掉 `[shelf]` 后，下一轮 replay 为 `[merged][transcript]`，
  字节在材料架处与缓存断开 → **上一整轮 transcript 全部 miss**（约占请求 40–50%），
  同时动态尾还要再付一次全量材料架的 miss 价。
- 数据印证：会话 `6628bbab` 第 3 个 job 起首步命中跌至 57–71%；
  角色卡改动使 `hydrateSessionMaterialsShelf`（`src/agent.ts:6379`）清理过期条目、
  材料架变空后，job8/9 首步恢复 90.8/99.5%。
- 修法：照抄 trunk 的「钉住快照 + 尾部增量」模式。
  冻结块**保留**材料架（字节与缓存一致）；材料架内容变化时才在动态尾注入权威更新。
  不要 strip，也不要每次全量重发。

### 2.2 项目 trunk 更新全量注入 —— 轮间动态尾过大

- 位置：`src/agent.ts:3543-3549`，`projectTrunkUpdate` 携带整个 `currentProjectTrunk.content`。
- 成本：改一张角色卡 → 全部角色索引 + 大纲骨架重发（字符编辑会话中一次边界 ~8–13k token miss）。
- 修法：按 section（大纲 / 角色索引 / lore 路径）或按角色卡做 diff，只发变化部分。

### 2.3 缓存 lease 过于乐观（次要）

- `src/prefix_cache.ts:16` `DEFAULT_CACHE_LEASE_MS = 55min`，
  实测 13–17 分钟间隔即出现 `provider_eviction_or_routing`。
- 只影响预测置信度与 `coldStartCause` 归因，不影响请求。可下调或按 provider 分级。

## 3. 可优化点（正向收益）

### 3.1 `direct_chapter_review` 提示结构 append-only 化

- 位置：`src/chapter_review.ts:236` `buildChapterReviewMessages`。
- 现状：`fullChapter` 在 user JSON 里，且 `scenes` 数组（含每次变化的 `actualState`）排在其前 →
  一发散整章全 miss（命中 ~10%）。
- 修法：`fullChapter` 恒放最后、先写 scene 只追加不重排；`revisionReview` 复审可命中
  上次审阅的整章前缀（10% → 80%+）。

### 3.2 prose_gate / learned_prose_gate 规则块前置

- 固定规则放块首、变化摘录放块尾；同章多 scene 调用可复用前缀。

### 3.3 子调用 namespace 隔离

- 各子调用 `requestProfile`（`src/agent.ts:7471`，temperature/thinking/api 不同）→ 独立 namespace、
  各自冷启动。与主链无法共享（system prompt 不同），但**同类子调用之间**（如每 scene 的 prose_gate）
  按 §3.2 的 append-only 原则可复用。

## 4. 已确认为设计内、不必改

- 场景/章节边界截断 + 尾部 user 衔接：数据确认截断后下一步恢复 88–99%，契约 §4 已测量接受。
- 轮内 material 编辑注入：trunk 钉住 + 尾部权威更新比「重钉 trunk 使全量 replay 失效」更优。
- 轮 2 起 mergedTurnContext 折叠、冻结 reasoning_content、`freezeTurnBlock` 防御性清理：
  均有测量支撑，保持现状。

## 5. 验收方式

- 修完后对照 `model_usage`：轮间首步命中率应从 21–71% 提升到 85%+。
- 跑 `npm run build` 与 `src/agent_cache.test.ts`、`src/turn_replay.test.ts`（槽位形状与哈希被测试锁定）。
- 不引入新槽位、不改变槽位顺序；材料架/trunk 更新仍走动态尾部。

## 6. 完成记录（2026-08-11）

- 冻结回合保留实际发送给供应商的材料架字节；开场和章节切换只在权威材料架变化时追加更新，
  材料架清空也使用显式权威 tombstone，不再 strip 后每轮全量重发。
- 项目 trunk 继续钉住旧基线，变化时按 `meta / outline / characters / lorePaths` section 发送
  权威 delta；无法解析旧格式时才回退完整 trunk。
- 默认 cache lease 从 55 分钟降为 12 分钟，13—17 分钟后的 provider eviction 不再被误报为高置信 warm。
- `direct_chapter_review` 的 `fullChapter` 固定为动态 payload 最后字段；项目上下文和审查规则仍位于其前。
- prose adjudication 与 learned gate 已保持固定规则在前、候选 passages 在后的结构，本次未重复改写。
- 稳定 6 槽、首轮动态 8+1、后续单 user、工具 schema 均未改变；相关缓存/AgentRun/上下文测试通过。
