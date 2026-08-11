# 提示词左右互搏与异常审查报告

状态：已完成（2026-08-11）

> 正文保留为修复前的定位证据；当前结论以文末「完成记录」为准。N2 经核实为误报，未因该项改动完成不变量。

> 初稿日期：2026-08-09 · 复审日期：2026-08-11 · 范围：主 Agent（`src/agent.ts` 6 固定槽 + 8 动态槽）、规划器、终审/章节终审、风格门禁、委派 Writer、角色扮演提示面 · 方式：只读，未改动任何代码。
>
> 复审说明：初稿后代码新增提交 `2bfbcc2..67b3dba`（卷路由/卷访问、统一叙事验证、会话产物仓库、交付证据）并有未提交工作区改动（`src/tools/proposals.ts`、`src/tools/files.ts`、`src/delivery_evidence.ts` 等）。本文已逐条重定位到当前 `file:line`，并补入新改动引入的问题。

评估标准参考 Opencode / Claude 类工具对提示词的核心要求：**同一上下文内不允许出现互相抵消的指令**，以及绝对化措辞（必须/只/唯一/永远）必须与其实际约束边界一致。

## 状态总览

| # | 问题 | 状态 |
| --- | --- | --- |
| 1—15 | 原审查项 | 已修复或收敛；8/12 按软张力清理，9/15 收敛为共享规则源 |
| N1 | 会话产物仓库绕过卷访问锁 | 已修复 |
| N2 | 「场景链可选」vs 已启动后必须终审 | 核销：误报，两者边界一致 |
| N3 | 目标卷路由被顶层同名文件截断 | 已修复 |
| N4 | 锁定卷 search_files 静默空结果 | 已修复 |
| N5 | 统一验证残留场景链工具名 | 已修复 |
| N6 | 终审 chapterChange 覆盖提交摘要 | 已修复 |

---

## 高严重度：同一请求内互相打架

### 1. 场景链交付 vs「写入：必须 write_file」（仍在，措辞软化）

- `src/agent.ts:663`：`必须成功调用 write_file、edit_file、move_file 或 delete_file 完成请求后结束，禁止用最终回复代替文件交付。`
- `src/agent.ts:692-694`（同块）：`完整交付：…自主选择直接成稿或场景草稿链；不要为了遵循流程而拆场。`
- `src/agent.ts:3002 / 3023`（场景链收尾）：`调用 inspect_chapter_draft` / `唯一下一步：立即调用 inspect_chapter_draft`。

场景链路径全程不调用 write_file，而 `inspect_chapter_draft` 的 `proposalSubmitted=true` 被认定为成功交付（`src/agent_runtime.ts:582`）。文案已增加「运行时自动绑定交付项…」，但两个相反的收尾指令仍在同一请求里。

### 2. 角色演进关闭时，稳定槽 0 与动态块冲突（已解决）

- 稳定槽现已限定：只有用户明确要求的角色资产才可新建或大改；正文临时人物不自动升格。
- 动态块根据本轮 `characterPersistenceIntent` 明确区分候选、简易卡与普通卡，不再用角色演进开关暗示正文可以新建项目卡。
- 运行时对正文任务中的建卡调用自动保存为 Session 人物候选，不报错、不重试，也不修改项目角色库。

### 3. audit 模式同一请求内重复同一套规则（仍在，措辞已漂移）

- `src/agent.ts:1540`（taskInstructions audit）：`先 audit_prose_style；按 diagnosis.actionableIssues 处理，优先 verdict=block；再审阅 aiTells.issues。warn 只在结合上下文仍明显模板化时改…`
- `src/agent.ts:5759`（REVIEW_PROMPT，`src/agent.ts:712/774` 在 audit 时追加）：`先 audit_prose_style；使用 diagnosis.actionableIssues，优先 verdict=block，并检查 aiTells.issues；warn 仅明显模板化时改…`

不再逐字重复但语义重叠，仍违反 AGENTS.md 的 DEDUPE 约定。统一叙事验证提交后此处是唯一残留的近似重复。

---

## 中严重度

### 4. 「仅事实红线可硬拦」与风格密度硬拦（部分缓解）

- `src/agent.ts:760`：`风格/句式类偏好不阻断首次交付；仅事实红线（如引号字数）可硬拦。`
- 提案门禁已缓解：`src/prose_quality.ts:354-368` 的 `hardProseStyleErrors` 现在豁免 `learned_rule`，仅 `quoted-text-count-consistency` 可硬拦，与提示词一致。
- 但场景门禁未豁免：`src/prose_quality.ts:158-167`（`sceneMannerismGateError`）仍按「句式家族预算超限 / 说明式写法过密」硬拦场景。
- `src/agent.ts:1528` 已承认门禁会因「达到密度」介入。

「仅事实红线可硬拦」在场景链入口仍不成立。

### 5. 作者政策默认 status 不一致 → 不同入口不同强制力（仍在）

| 来源 | 默认 status | 效果 |
| --- | --- | --- |
| `src/author_policies.ts:324/389`（政策编译器） | 永远 `draft` | 不进 `authorPolicyGateRules`（`src/author_policies.ts:283` 只收 trial/active） |
| `src/agent.ts:1164`（规划器候选格式） | `draft|trial`，「新风格偏好默认 trial+advise」 | trial 进 gate 但非阻断（`src/author_policies.ts:296`） |
| `src/agent.ts:616`（执行规则 10） | 「新偏好默认 trial，含糊反馈只存 draft」 | 与工具默认不一致 |
| `src/tools/meta.ts:51`（upsert 工具默认） | `draft` | 依赖默认时与规则 10 冲突 |

### 6. 委派 Writer 的篇幅口径与运行时验收相反（仍在，被放大）

- `src/evidence_grounded_writer.ts:321`：`字数是上限参考，不是目标。`
- `src/evidence_grounded_writer.ts:326`：`目标约 X 字。篇幅服从场景变化…`
- `src/prose_length.ts:145-149` + `src/tools/scene_pipeline.ts:416`：bounded 模式超上限硬拒。

Writer 被允许「篇幅服从场景变化」，但同轮运行时按上限硬拒。

### 7. 稳定槽 5 占位承诺「终审要求见动态区块」（仍在，低）

- `src/agent.ts:1817`：`模式附加：任务专则与终审要求见「当前任务」动态区块。`
- `src/agent.ts:712`：`REVIEW_PROMPT` 仅在 `task.mode === "audit"` 时注入。

write / rewrite / write_scene 任务的动态块里并没有「终审专则」，占位承诺过强。

### 8. 软张力：「不得把旧章当句式模板」vs 声线样本（仍在）

- `src/agent.ts:708`：`不得把旧章当句式模板或遍历寻找可复用结构。`
- `src/style_grounding.ts:177`：`新正文从这里的声线自然续下去，句法与节奏保持同一支笔的手感。`
- `src/style_grounding.ts:176` 新增 continuity 变体「不模仿其中重复段首、固定句长」收窄但仍未消解。

### 9. 「不是……而是」禁令口径不一，8+ 处并存（仍在，恶化）

- `src/roleplay.ts:448`（auto-reply）：绝对、无例外。
- `src/roleplay.ts:726`（扮演者稳定前缀规则 10）：允许 `对白中偶发、符合人物语气的即时纠正`。
- 同类句式另见 `src/prose_quality.ts:453/465`、`src/prose_construction_rules.ts:68`、`src/write_pack.ts:186`（「双否定点名破折号」）、`src/agent.ts:5761`、`src/chapter_review.ts:221`（construction_repetition）等，措辞与例外口径均不一。

---

## 低严重度 / 奇怪处

10. `src/agent.ts:617-618`：执行规则编号仍跳号——11 直接接 13，缺 12。
11. `src/agent.ts:602`：plan 模式禁令清单仍是 `WRITE_TOOLS`（`src/tools/schema.ts:1172-1179`，含场景链工具、manage_author_policies、manage_prose_gates、generate_image 等）的过期子集。工具本身不可见，文案弱化实际过滤面。
12. `src/agent.ts:723`：弱引导行尾悬句 `场景链仍按实际故事选择每场目标。`——bounded 分支（`src/agent.ts:730`）已是另一套措辞。
13. `src/agent.ts:618` vs `src/agent.ts:1687-1695`：规则 13 写死「动态『可用图片参考』」标签；该块仍只扫最近 80 条消息、封顶 8 张。
14. `src/agent.ts:1555` 注释：`other cards stay available through targeted get_character calls`，但 `src/tools/characters.ts:67/284/319` 对范围外角色直接抛错——注释与实现、与提示词（`src/agent.ts:652`）背离。
15. 写作记忆规则三处复述且措辞漂移：`src/writing_memory.ts:43`（「不是项目设定或永久事实，不得扩写」）、`src/agent.ts:6115`（「仅是…近期辅助状态…立即忽略」）、`src/narrative_evidence.ts:168`（「不是项目事实、角色卡或扩写许可」）——语义一致，冗余。

---

## 新改动引入的问题（复审新增）

### N1（高）会话产物仓库绕过卷访问锁，提示词绝对声明失真

- `src/agent.ts:741/747`：`默认只可见卷名，不能列出、搜索或读取未解锁卷内章节` / `本轮未解锁任何既有卷。`
- 但 `search_session_artifacts` / `read_context_artifact`（`src/tools/meta.ts:160-215`）只取 `{input, store, sessionId}`，不经 `assertVolumePathAllowed`；`read_context_artifact` 直接返回完整 `artifact.content`。
- 产物持久化完整正文（`src/agent.ts:2054-2065` 存修订稿、`src/write_pack.ts:34` 存 write pack；store.ts 跨轮保留）。

同一会话上一轮（未锁卷时）读过的锁定卷章节正文，本轮可通过产物仓库列出路径并读回全文，而提示词宣称「不能读取未解锁卷内章节」。所有文件/文档工具都上锁（`src/tools/helpers.ts`），唯这两个产物入口未上锁。

### N2（中-高）「场景链可选/可跳过」vs 无条件完成缺口

- `src/writing_workflow.ts:48/50`：`场景链是可选的连续性工具，不是正文交付前置流程` / `不是唯一正文交付流程…Agent 可根据工具结果跳过、回退或组合能力`。
- `src/writing_workflow.ts:100-102`：一旦记录 `shape_scene_chain` 且无 `inspect_chapter`，即缺口 `章节场景链已启动但尚未完成整章终审`，经 `src/agentic_runtime.ts:206` 的 `completionRecoveryPrompt` 强制回环。

提示词鼓励「跳过/回退」，但已启动的场景链不允许中途放弃（除非走 inspect_chapter_draft 收束），与 `src/agent.ts:1521`「不要为了展示流程而调用工具」叠加，形成张力。

### N3（中）「运行时会固定路由到该卷」vs 路径冲突回落

- `src/agent.ts:743`：`新建章节直接使用 chapters/ 下的常规文件名，运行时会固定路由到该卷；不要自行改卷。`
- `src/volume_policy.ts:110`：`routeNewChapterPath` 在顶层同名文件已存在时原样返回，不路由到卷。
- `src/chapter_naming.ts:585` 展示的「下一可用 path」只按卷内路径计算（`src/agent.ts:736`、`src/chapter_naming.ts:387-389`），忽略可冲突的顶层同名文件。

若历史存在 `chapters/chapter-01.md`，提示词承诺的「固定路由」会被静默覆盖为写入顶层旧文件。

### N4（低-中）锁定卷 search_files 静默空结果

- `src/agent.ts:607`：`需项目事实时先 search_files…每轮最多搜索 2 次` 无条件成立；`src/agent.ts:583`：`chapters/=主线正文`。
- `src/tools/files.ts:310-319`：`handleSearchFiles` 对锁定卷路径直接 `continue`，返回 `{query, matches: []}` 无任何锁定标记；而 `read_file` 会抛带说明的错误（`src/tools/helpers.ts:46`）。

Agent 可能用掉 2 次搜索预算却拿到空结果且不知道原因；唯一提示在动态 `volumeInstruction`。

### N5（低）统一验证后残留场景链工具名提示

- `src/prose_metrics.ts:99`：`用 revise_chapter_draft_style 把「S。S。」替换为单句` —— 该工具只存在于场景链；统一叙事验证现在对每条叙事提交（含直接 write_file 路径）跑此门禁（`src/tools/proposals.ts:1007-1012`）。提示指向错误工具，且「零容忍」措辞与 `src/chapter_review.ts:231`「统计字段只用于定位候选段落，不能单独成为证据」口径不一（修订包 action 已补偿，但浮出的 message 未纠正）。

### N6（低）交付复审「提交摘要」口径随 chapterChange 漂移

- `src/tools/proposals.ts:1025/1038`：`deliverySummary` 被终审返回的 `chapterChange`（描述「变化」而非「范围」）覆盖。
- `src/run_completion.ts:43`：`已交付项包含路径和提交摘要；据此核对数量、范围和明确内容条件`。
- `src/delivery_evidence.ts`（未提交改动，`src/agent.ts:3932`）已追加字数与正文证据补偿，故影响有限。

---

## 根因归纳与原修复方向（历史记录）

- **绝对化措辞限定到路径**：把「必须 write_file」「唯一下一步」「永不阻断」「固定路由到该卷」等表述改成按所选路径限定，或在动态块按 `scenePipelineEnabled` / `volumeAccess` 分支。
- **开关相关规则下沉动态块**：角色演进、终审承诺、图片参考标签等随开关/模式变化的文本不进无条件稳定槽。
- **默认值收敛单一口径**：作者政策 status（trial vs draft）收敛为「提示词 / 工具 / 编译入口」三者一致；篇幅上限在委派 Writer 文案与 `prose_length.ts` 之间对齐口径。
- **产物仓库对齐卷访问**：`search_session_artifacts` / `read_context_artifact` 纳入 `volumeAccess` 过滤，或提示词为产物入口声明豁免。
- **完成不变量与提示词对齐**：「场景链可跳过」与 `writingWorkflowCompletionGaps` 的已启动即需终审保持一致。
- **去重**：audit 的 taskInstructions 与 REVIEW_PROMPT 二选一；「不是……而是」禁令收敛为单一来源 + 单一例外口径；统一验证后清理 `prose_metrics.ts` 残留工具名。
- **顺带清理**：执行规则编号 12、plan 禁令清单、稳定槽 5 占位措辞、`scopedCharacterConstraintPackets` 过期注释。

## 完成记录（2026-08-11）

- 交付约束收敛为「成功产生文档交付物」：直接路径使用文件工具，已启动的场景链由 `inspect_chapter_draft` 终审并提交。N2 中「启动前可选」与「启动后必须收束」本来一致，按误报核销。
- 角色演进的稳定规则改为受动态开关授权；audit 只保留一份终审专则；稳定槽仍为 6 个，动态尾仍为 8 system + 1 user。
- 作者政策明确使用 `draft → trial → active`生命周期，upsert 必须显式传 status；提示词同时区分「作者偏好」与「内建确定格式/完整性检查」。
- 篇幅口径由 `prose_length.ts` 的目标边界统一生成：bounded 向委派 Writer 明示可接受范围和硬上限，guidance 才作不阻断参考。
- 会话产物的搜索和全文读取接入与文件工具相同的卷/正文访问边界；`search_files` 与产物搜索会显式返回被权限过滤的数量，不泄露路径或正文。
- 激活目标卷后，未分卷的章节路径始终先路由入该卷，顶层同名旧文件不再截断路由。
- 图片参考改为直接查询会话中最近的附件消息，不再受「最近 80 条普通消息」截断；固定规则也不再绑定动态区块标题。
- 否定—改判句式的生成边界收敛到 `prose_construction_rules.ts`；写作记忆的权威边界收敛到 `WRITING_MEMORY_AUTHORITY`。旧章声线材料明确只承接叙述距离/语域/节奏，不复用句式或事件结构。
- 统一叙事验证不再在诊断文案中写死场景链修订工具；提案保留原始提交摘要，终审 `chapterChange` 作为附加证据而不再覆盖范围摘要。
