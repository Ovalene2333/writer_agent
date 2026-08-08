# 智能体：项目索引与 `writer.db` 查询

给排障 / 审计 Agent 用的**最短操作手册**。库结构细节以 `src/store.ts` 为准。

---

## 0. 改代码后

```bash
npm run build          # 或至少 npm run typecheck
```

整体改完再 build；不要只改 `src/` 就宣称可用。`dist/` 不提交。

---

## 1. 项目在哪

本仓库常见布局：

| 路径 | 含义 |
|------|------|
| `p/<name>/` | 本仓库内项目，例 `p/jn3` |
| `p/<name>/.writer/writer.db` | **该项目的主库** |
| `p/<name>/resource/` | 正文/设定 Markdown 源文件 |
| `p/<name>/writer.yaml` | 项目配置 |

启动示例：`writer web --share -p ./p/jn3`。

先确认库文件存在：

```bash
ls p/jn3/.writer/writer.db*
```

可能同时有 `writer.db`、`writer.db-wal`、`writer.db-shm`（WAL 模式，正常）。

---

## 2. 怎么安全打开（只读）

**原则：只读；写操作走应用。**

### 推荐：复制后再查（避免占用 / disk I/O error）

服务在跑时直接 `sqlite3` 偶发 `disk I/O error`。先拷贝：

```bash
cp p/jn3/.writer/writer.db /tmp/jn3-writer.db
cp p/jn3/.writer/writer.db-wal /tmp/jn3-writer.db-wal 2>/dev/null
cp p/jn3/.writer/writer.db-shm /tmp/jn3-writer.db-shm 2>/dev/null
sqlite3 /tmp/jn3-writer.db ".tables"
```

### Node 22+（`node:sqlite`，只读）

```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('p/jn3/.writer/writer.db', { readOnly: true });
const rows = db.prepare('select id, status, substr(prompt_preview,1,80), created_at from background_jobs order by created_at desc limit 5').all();
console.log(JSON.stringify(rows, null, 2));
" 2>/dev/null
```

约定：

- 始终 `readOnly: true`（或只拷贝副本）。
- 时间戳为 **ISO UTC**；本地东八区自行 +8h。
- 列名不确定时：`pragma table_info(messages);`

---

## 3. 表索引（先认这些）

### 排障主链

```
用户请求 → background_jobs / agent_runs
         → messages（source_message_id）
         → message_step_trails（逐步输出）
         → agent_run_events（语义事件）
         → proposals / revisions（落盘）
```

| 表 | 用途 |
|----|------|
| `background_jobs` | **HTTP/SSE Job**：id、session、status、prompt_preview、source_message_id、terminal_message、时间 |
| `agent_runs` | **语义 Run**：original_request、status、snapshot_json（交付项/进度） |
| `agent_run_events` | Run 事件流：`type` + `payload_json`，按 `sequence` 排 |
| `messages` | 对话。`channel`=`agent`\|`roleplay`；`role`=user/assistant/system |
| `message_step_trails` | 按 **user source_message_id** 存步骤 JSON；含 `job_id` |
| `proposals` | 文档提案；`status` pending/accepted/rejected/stale；含 path、全文 |
| `revisions` | 已应用修订；`undone=1` 已撤销 |
| `model_usage` | 每次模型调用 token/缓存/费用；可带 `job_id` |
| `session_context` | 活动文档、intent、todos_json |
| `context_nodes` / `context_edges` | 上下文图（诊断用） |

### 次要

- `change_sets` / `change_set_*`：多文件变更集  
- `character_revisions`：角色卡历史  
- `document_index`：FTS5（中文子串用 `instr`，见下）  
- `roleplay_*`：扮演链路，写作排障一般不碰  

---

## 4. 标准排查流程（按请求文本）

### 4.1 用提示词找最新 Job

```sql
SELECT id, session_id, status, source_message_id,
       substr(prompt_preview,1,100) AS preview,
       length(terminal_message) AS tlen,
       created_at, updated_at
FROM background_jobs
WHERE prompt_preview LIKE '%林千夏%' OR prompt_preview LIKE '%戈壁%'
ORDER BY updated_at DESC
LIMIT 10;
```

### 4.2 对齐 Agent Run

```sql
SELECT id, status, source_message_id,
       substr(original_request,1,80),
       created_at, updated_at
FROM agent_runs
WHERE original_request LIKE '%戈壁%'
ORDER BY updated_at DESC
LIMIT 5;
```

快照（交付是否完成）：

```sql
SELECT json(snapshot_json) FROM agent_runs WHERE id = '<runId>';
-- 或只看交付
SELECT json_extract(snapshot_json, '$.status'),
       json_extract(snapshot_json, '$.deliverables'),
       json_extract(snapshot_json, '$.progress')
FROM agent_runs WHERE id = '<runId>';
```

### 4.3 看消息有没有「可见回复」

```sql
SELECT id, role, channel, length(content),
       substr(content,1,120), created_at
FROM messages
WHERE session_id = '<sessionId>'
  AND id >= <source_message_id>
ORDER BY id
LIMIT 30;
```

**常见坑**：

- Job `status=completed`、提案已 `accepted`，但 **user 之后没有 assistant** → 历史 bug：文档交付捷径未 `persistAssistantMessage`（现应有「已交付 …」摘要）。
- `terminal_message` 为空仍可能成功（UI 以消息 + 提案为准；Job ID 不进聊天正文，在消息 ⋯ 元数据里）。

### 4.4 步骤轨迹

```sql
SELECT source_message_id, job_id, length(steps_json), updated_at
FROM message_step_trails
WHERE session_id = '<sessionId>' AND source_message_id = <id>;
```

解析 steps（Node/Python 均可）：

```bash
python3 - <<'PY'
import json, sqlite3
con = sqlite3.connect("/tmp/jn3-writer.db")
row = con.execute(
  "SELECT steps_json FROM message_step_trails WHERE source_message_id=?",
  (2665,),
).fetchone()
steps = json.loads(row[0])
for s in steps[-5:]:
    print(s.get("id"), s.get("status"),
          [t.get("name") if isinstance(t, dict) else t for t in (s.get("tools") or [])],
          repr((s.get("output") or "")[:80]))
PY
```

### 4.5 提案 / 落盘

```sql
SELECT id, path, status, substr(summary,1,80), created_at
FROM proposals
WHERE session_id = '<sessionId>'
  AND created_at >= '2026-08-07T16:52'
ORDER BY id;
```

### 4.6 Run 事件时间线

```sql
SELECT sequence, type, created_at, substr(payload_json,1,160)
FROM agent_run_events
WHERE run_id = '<runId>'
ORDER BY sequence;
```

`waiting_for_input` 会结束 SSE job，但 `agent_runs.status` 可能是 `suspended`（可续跑），不要当成「写失败」。

---

## 5. 其他常用配方

### Token / 缓存

```sql
SELECT id, created_at, prompt_tokens, completion_tokens,
       cache_hit_tokens, cache_miss_tokens, cost, job_id
FROM model_usage
WHERE session_id = '<sessionId>' AND created_at > '2026-08-07T16:00'
ORDER BY id;
```

- `prompt_tokens` 相对上一步**明显下降** → 章/场边界截断。  
- 截断后若 `cache_miss` 接近全量 → 怀疑前缀被破坏（见 `agent.ts` 缓存合同）。

### 搜对话原文

```sql
SELECT id, session_id, role, channel, created_at, substr(content,1,120)
FROM messages
WHERE content LIKE '%软垫%'
ORDER BY id DESC LIMIT 20;
```

### 正文全文（中文）

`document_index` 的 FTS5 对连续中文常无效，用子串：

```sql
SELECT path, substr(content, max(1, instr(content, '警报') - 40), 100)
FROM document_index
WHERE instr(content, '警报') > 0
LIMIT 10;
```

磁盘上的 `resource/` 才是最终真相；索引可能滞后。

### 会话 todos

```sql
SELECT todos_json, updated_at FROM session_context WHERE session_id = '<sessionId>';
```

---

## 6. UI 与库的对应

| UI | 库 |
|----|-----|
| 用户气泡下的步骤卡片 | `message_step_trails.steps_json` |
| 用户消息操作栏 ⋯「任务元数据」 | `job_id` + `background_jobs`（id/状态/时间） |
| 聊天正文 | `messages`（**不再**拼接 `Job ID:` 脚注） |
| 审阅/已接受文件 | `proposals` / `revisions` + `resource/` 文件 |

---

## 7. 注意

1. **不要**在未备份时手工改库；修数据先停服务并备份 `writer.db*`。  
2. `.writer/providers.json` 含密钥，导出/分享时剔除。  
3. 单元测试用内存库，不会写项目 db。  
4. 表结构以 `store.ts` 的 `CREATE` + `ALTER` 迁移为准；旧副本可能缺列。  
5. 撤销用户指令会删后续消息与相关状态；被撤销的 run 可能「搜不到」。

---

## 8. 一页速查

```text
1. 定位项目  →  p/<name>/.writer/writer.db
2. 拷贝只读  →  /tmp/...-writer.db
3. 找 job    →  background_jobs WHERE prompt_preview LIKE ...
4. 找 run    →  agent_runs WHERE original_request LIKE ...
5. 看交付    →  snapshot_json.deliverables + proposals
6. 看回复    →  messages after source_message_id
7. 看步骤    →  message_step_trails
8. 看事件    →  agent_run_events
```
