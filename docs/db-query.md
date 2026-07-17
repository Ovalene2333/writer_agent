# 项目数据库查询指南（协作文档）

每个写作项目的运行数据都存放在项目目录下的 SQLite 数据库中：

```
<项目根>/.writer/writer.db        # 例：D:/Code/jn/.writer/writer.db
<项目根>/.writer/writer.db-wal    # WAL 日志（服务运行时存在，勿删）
```

数据库由 [src/store.ts](../src/store.ts) 创建和迁移，WAL 模式，**服务运行中也可以安全地并发只读查询**。

## 查询方式

Node 22+ 自带 `node:sqlite`，无需安装任何依赖（`better-sqlite3` 未随项目安装）：

```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('D:/Code/jn/.writer/writer.db', { readOnly: true });
const rows = db.prepare('select id, title, updated_at from sessions order by updated_at desc limit 10').all();
for (const r of rows) console.log(JSON.stringify(r));
" 2>/dev/null
```

约定：

- **始终传 `{ readOnly: true }`**。写操作一律通过应用完成；确需手工修数据时先停服务并备份 `writer.db*` 三个文件。
- `2>/dev/null` 用于吞掉 `node:sqlite` 的 ExperimentalWarning，不影响结果。
- 所有 `created_at`/`updated_at` 均为 **ISO UTC** 字符串；本地时间（UTC+8）需自行 +8 小时。

## 表概览

### 会话与消息

| 表 | 说明 |
|---|---|
| `sessions` | 会话（id 为 UUID，title 自动生成） |
| `messages` | 对话消息。`channel`：`agent`（写作）/ `roleplay`（扮演）；`role`：user/assistant/system |
| `message_variants` | 同一条用户指令重跑产生的多版本回答（按 `group_id` 分组） |
| `session_context` | 每会话一行：活动文档、当前意图、`todos_json`（任务清单快照） |

**关键行为**：Agent 任务的 assistant 消息**在 run 结束时才落库**——正在运行的任务在 `messages` 里只能看到 user 指令；「撤销用户指令」会连带删除该指令之后的消息与修订（`ON DELETE CASCADE` + 撤销逻辑），所以被撤销的 run 在库里搜不到。

### 写作产物

| 表 | 说明 |
|---|---|
| `proposals` | 文档提案（`status`：pending/accepted/rejected；含 before/after 全文） |
| `revisions` | 已应用的文件修订（`undone=1` 表示已被撤销） |
| `character_revisions` | 角色卡修订历史 |
| `writing_examples` | 范文库 |
| `chapter_runner_checkpoints` | 章节流水线断点（`draft_json` 是完整的场景草稿：场景卡 + 各场正文 + actualState） |
| `document_index` | FTS5 全文索引（用 `MATCH` 查询，不要 LIKE 扫大文本） |

### 观测与成本

| 表 | 说明 |
|---|---|
| `model_usage` | **每次模型调用一行**：prompt/completion tokens、缓存命中/未命中、按价目折算的 cost。只记录主循环与规划器调用；工具内部调用（候选采样等）不记录 |
| `context_artifacts` | 工具结果缓存（按 `cache_key` 去重，含读取的文档内容摘要） |

### 扮演（roleplay_*）

`roleplay_interlocutors` / `active_roleplays` / `roleplay_memory` / `roleplay_scenes` / `roleplay_memory_facts` / `roleplay_memory_snapshots`——扮演会话的人设、工作记忆与事实库，写作调试一般用不到。

## 常用查询配方

以下均为实际排障中验证过的查询，替换路径与 session_id 即可复用。

### 1. 找一次提案对应的 run

```sql
select id, session_id, path, status, created_at, substr(summary,1,120)
from proposals where id = 353;
```

### 2. 看某个 run 的逐步 token / 缓存命中（性能排障主力）

```sql
select id, created_at, prompt_tokens, completion_tokens,
       cache_hit_tokens, cache_miss_tokens, cost
from model_usage
where session_id = '<sessionId>' and created_at > '2026-07-17T04:00'
order by id;
```

读法要点：

- `prompt_tokens` 相比上一步**下降** → 发生了场景/章节边界截断；
- 截断后一步的 `cache_miss_tokens` 应约等于交接消息大小（1.5–3k）。若接近全量 miss，说明缓存前缀被破坏（历史教训：中途注入 system 角色消息会让 DeepSeek 整体换模板渲染，见 agent.ts 缓存合同 §4）；
- `completion_tokens` 3–5k 的是写场步（thinking 模型含 reasoning），几十的是纯工具调用步（如 inspect）。

### 3. 按时间聚合各 run 的成本（间隔 >5 分钟视为新 run）

```js
const rows = db.prepare("select model, prompt_tokens as pin, completion_tokens as out, cache_hit_tokens as hit, cost, created_at from model_usage where created_at > '2026-07-14' order by id").all();
const runs = [];
let cur = null;
for (const r of rows) {
  const t = new Date(r.created_at).getTime();
  if (!cur || t - cur.end > 5 * 60 * 1000) { cur = { start: r.created_at, end: t, calls: 0, pin: 0, out: 0, hit: 0, cost: 0 }; runs.push(cur); }
  cur.end = t; cur.calls++; cur.pin += r.pin; cur.out += r.out; cur.hit += r.hit; cur.cost += r.cost;
}
```

### 4. 搜消息内容（定位某句话出自哪次对话）

```sql
select id, session_id, role, channel, created_at, substr(content,1,120)
from messages
where content like '%场景链%'
order by id desc limit 20;
```

### 5. 全文检索项目文档

`document_index` 是 FTS5 虚表，但默认分词器切不开连续中文——`MATCH '警报'` 对中文正文通常返回空（应用内的 `searchDocuments` 也因此带了子串回退，见 store.ts）。手查中文直接用子串扫描，该表正好存有全部已索引文档的全文：

```sql
select path, substr(content, max(1, instr(content, '警报') - 40), 100) as excerpt
from document_index
where instr(content, '警报') > 0
limit 10;
```

英文/代码类关键词才适合 `MATCH`：

```sql
select path from document_index where document_index match 'chapter' limit 10;
```

注意：该索引在应用触发重建时才刷新（全删全插），可能落后于磁盘上的最新文件。

### 6. 查看进行中/中断的章节草稿状态

```sql
select session_id, path, status, updated_at, length(draft_json)
from chapter_runner_checkpoints;
```

`draft_json` 解析后可看到 `scenes`（场景卡）与 `completed`（各场正文与 actualState），用于判断章节写到第几场。

### 7. 当前会话的任务清单

```sql
select todos_json, updated_at from session_context where session_id = '<sessionId>';
```

## 注意事项

- 表结构以 `store.ts` 的 `CREATE TABLE` + 后续 `ALTER TABLE` 迁移为准；手查列名用 `pragma table_info(<表名>)`。
- `writer.db-wal` 可能包含最新写入，`node:sqlite` 打开时会自动读 WAL，无需 checkpoint。
- 单元测试使用内存库，不会写入项目 db；`.writer/providers.json` 含 API Key，与 db 同目录，导出/分享数据时注意剔除。
