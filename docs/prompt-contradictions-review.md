# 提示词左右互搏与异常审查报告

> 审查日期：2026-08-09 · 范围：主 Agent（`src/agent.ts` 6 固定槽 + 8 动态槽）、规划器、终审/章节终审、风格门禁、委派 Writer、角色扮演提示面 · 方式：只读，未改动任何代码。

评估标准参考 Opencode / Claude 类工具对提示词的核心要求：**同一上下文内不允许出现互相抵消的指令**，以及绝对化措辞（必须/只/唯一/永远）必须与其实际约束边界一致。

总体结论：本项目在缓存契约、交叉引用、占位槽设计上非常自律，绝大多数重复是刻意的交叉引用（如 `proseMannerismPreflightLine()`）；问题集中在三个根因：

1. 绝对化措辞放在了存在替代交付路径的地方；
2. 随开关/模式变化的规则写进了无条件稳定槽；
3. 提示词与工具/门禁的默认值漂移。

---

## 高严重度：同一请求内互相打架

### 1. 场景链交付 vs「写入：必须 write_file」

- `src/agent.ts:647`：`必须成功调用 write_file、edit_file、move_file 或 delete_file 完成请求后结束，禁止用最终回复代替文件交付。`
- `src/agent.ts:676-678`（同块）：`完整交付：…自主选择直接成稿或场景草稿链；不要为了遵循流程而拆场。`
- `src/agent.ts:2902 / 2920`（场景链收尾）：`调用 inspect_chapter_draft` / `唯一下一步：立即调用 inspect_chapter_draft`。

场景链路径（begin_chapter_draft → write_chapter_scene → inspect_chapter_draft）全程不调用 write_file，而 `inspect_chapter_draft` 的 `proposalSubmitted=true` 被运行时认定为成功交付（`src/agent_runtime.ts:582`）。模型在场景链任务中拿到两个相反的收尾指令。

### 2. 角色演进关闭时，稳定槽 0 与动态块冲突

- `src/agent.ts:575`（无条件稳定文本）：`正文落盘后的确认事实→apply_character_changes；伏笔/传闻/失败尝试不得解锁。`
- `src/agent.ts:645`（开关关时）：`关闭。不得调用 apply_character_changes；显式新建或编辑角色卡仍可使用 save_character。`
- 运行时在关闭时拒绝该工具：`src/tools/characters.ts:313-314`。

两条文本同时处于激活状态，模型遵循稳定槽会白白烧掉一步必被拒的调用。

### 3. audit 模式同一请求内重复同一套规则

- `src/agent.ts:1491-1492`（taskInstructions audit）：`先 audit_prose_style；按 diagnosis.actionableIssues 处理，优先 verdict=block；再审阅 aiTells.issues`
- `src/agent.ts:5514-5515`（REVIEW_PROMPT，`src/agent.ts:696` 在 audit 时紧接追加）：`先 audit_prose_style；使用 diagnosis.actionableIssues，优先 verdict=block，并检查 aiTells.issues`

两条几乎逐句重复，直接违反 AGENTS.md 的 DEDUPE 约定（「避免在 system、style、task workflow 和 review 中重复粘贴相同规则」）。

---

## 中严重度

### 4. 「仅事实红线可硬拦」与运行时风格密度硬拦矛盾

- `src/agent.ts:730`：`风格/句式类偏好不阻断首次交付；仅事实红线（如引号字数）可硬拦。`
- `src/prose_quality.ts:335-344`（`proseStyleIssuesError`）：高置信说明式写法 / 句式家族超预算会硬拦。
- `src/prose_quality.ts:158-167`（`sceneMannerismGateError`）：场景在入草稿前因风格密度被拒。
- `src/agent.ts:1480` 又承认门禁会因「达到密度」介入。

「风格永不阻断」的绝对承诺与「达到密度会介入」的运行时行为并存，措辞互相矛盾。

### 5. 作者政策默认 status 三处不一致 → 同一反馈不同入口得到不同强制力

| 来源 | 默认 status | 效果 |
| --- | --- | --- |
| `src/author_policies.ts:324/326`（政策编译器） | 永远 `draft` | 不进 `authorPolicyGateRules`（`src/author_policies.ts:283` 只收 trial/active） |
| `src/agent.ts:1124`（规划器候选格式） | `draft|trial`，「新风格偏好默认 trial+advise」 | trial 进 gate 但非阻断（`src/author_policies.ts:296`） |
| `src/agent.ts:601`（执行规则 10） | 「新偏好默认 trial，含糊反馈只存 draft」 | 与工具默认不一致 |
| `src/tools/meta.ts:51`（upsert 工具默认） | `draft` | 依赖默认时与规则 10 冲突 |

### 6. 委派 Writer 的篇幅口径与运行时验收相反

- `src/evidence_grounded_writer.ts:325`：`目标约 X 字。篇幅服从场景变化，不用总结、复述和无关支线凑字。`
- `src/evidence_grounded_writer.ts:320`：`字数是上限参考，不是目标。`
- `src/prose_length.ts:145-149`：bounded 模式超上限硬拒（`超出可接受上限…重新提交`）。

Writer 被允许「篇幅服从场景变化」，但同轮运行时按上限硬拒。

### 7. 稳定槽 5 占位承诺「终审要求见动态区块」，但终审专则只对 audit 注入

- `src/agent.ts:1769`：`模式附加：任务专则与终审要求见「当前任务」动态区块。`
- `src/agent.ts:696`：`REVIEW_PROMPT` 仅在 `task.mode === "audit"` 时追加。

write / rewrite / write_scene 任务的动态块里并没有「终审专则」。

### 8. 软张力：「不得把旧章当句式模板」vs 动态声线样本「接住同一支笔的手感」

- `src/agent.ts:692`：`不得把旧章当句式模板或遍历寻找可复用结构。`
- `src/style_grounding.ts:174`（project 常态样本）：`新正文从这里的声线自然续下去，句法与节奏保持同一支笔的手感。`

一个禁止模仿句式，一个主动要求接住前章句法节奏；靠「手感 vs 模板」的措辞软化，但两条指令仍可能把模型往相反方向拉。

### 9. 扮演「不是……而是」禁令内部矛盾，且全库五种措辞并存

- `src/roleplay.ts:448`（auto-reply）：`禁用「不是……是/而是……」…；直接写要做的事或要说的话。` —— 绝对、无例外。
- `src/roleplay.ts:726`（扮演者稳定前缀规则 10）：同类禁令但 `对白中偶发、符合人物语气的即时纠正可以保留，禁止连发。` —— 允许例外。
- 同一句式在 `src/prose_quality.ts`、`src/prose_construction_rules.ts:59`、`src/write_pack.ts:186`、`src/agent.ts:5517` 另有措辞、例外口径不一的表述。委派 Writer（`src/dialogue_texture.ts:113` 的 DIALOGUE_HARD_BANS）则完全不包含该禁令。

---

## 低严重度 / 奇怪处

10. `src/agent.ts:602-603`：执行规则编号跳号——11 直接接 13，缺 12。
11. `src/agent.ts:587`：plan 模式禁令清单是 `WRITE_TOOLS`（`src/tools/schema.ts:1139-1154`，还包含 begin_chapter_draft、write_chapter_scene、inspect_chapter_draft、manage_author_policies、manage_prose_gates、generate_image 等）的过期子集。工具本身不可见，不算模型可见矛盾，但文案弱化了实际过滤面。
12. `src/agent.ts:707`：篇幅弱引导行尾悬着 `场景链仍按实际故事选择每场目标。`——挂在一句讲单章目标的句子末尾很突兀。
13. `src/agent.ts:603`：规则 13 把动态标签「动态『可用图片参考』」写死在稳定槽；该块实际只扫最近 80 条消息（`src/agent.ts:1640`），比规则暗示的「既有图片」窄。
14. `src/agent.ts:1506-1507` 注释：`other cards stay available through targeted get_character calls`，但运行时对范围外角色直接抛错（`src/tools/characters.ts:67`）——注释与实现、与提示词（`src/agent.ts:636`「不得读取/关联范围外已有角色」）背离。
15. 写作记忆规则三处复述措辞不同但语义一致（`src/writing_memory.ts:43`、`src/agent.ts:5863`、`src/narrative_evidence.ts:158`）——冗余但无害。

---

## 根因归纳与修复方向（供决策，未实施）

- **绝对化措辞限定到路径**：把「必须 write_file」「唯一下一步」「永不阻断」等表述改成按所选路径限定（场景链 / 直接交付 / 分工模式），或在动态块按 `scenePipelineEnabled` 分支。
- **开关相关规则下沉动态块**：角色演进、终审承诺、图片参考标签等随开关/模式变化的文本不进无条件稳定槽。
- **默认值收敛单一口径**：作者政策 status（trial vs draft）收敛为「提示词 / 工具 / 编译入口」三者一致；篇幅上限在委派 Writer 文案与 `prose_length.ts` 之间对齐口径。
- **去重**：audit 的 taskInstructions 与 REVIEW_PROMPT 二选一；「不是……而是」禁令收敛为单一来源 + 单一例外口径。
- **顺带清理**：执行规则编号 12、plan 禁令清单、稳定槽 5 占位措辞、`scopedCharacterConstraintPackets` 过期注释。
