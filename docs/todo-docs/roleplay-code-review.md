# 角色扮演链路 Code Review 问题登记

状态：待修复

> 日期：2026-08-11 · 方式：只读审查 + 公开研究核对，未改动代码。范围：`src/roleplay.ts`（扮演主链路 / 感知编译 / 终审 / 记忆刷新）、`src/server.ts` roleplay 接线、`src/store.ts` 扮演存储。已对照 `roleplay.test.ts`、缓存契约（roleplay.ts:302-311 的 7 条规则）。

## 一、明确逻辑故障

### F1（高）失败/取消回合悬挂 user 消息，直接重试产生重复玩家回合

- 位置：`src/roleplay.ts:1493-1502`（user 消息在感知编译与模型调用前落库）＋ `src/roleplay.ts:1741`（assistant 回复延后才写）；`src/server.ts:2382-2394` 错误路径无任何回滚。
- 任何非 abort 失败（provider 错误、wire 格式无效、终审失败、context 超限）都会留下「无回复的玩家回合」；`saveRoleplayPerception` / `saveRoleplayModelInput`（roleplay.ts:1632-1641）同样已持久化。OOC 指令的 `applyRoleplayDirectorSceneUpdate`（roleplay.ts:1528-1531）在回合失败时也已改写 `state.scene`。
- 用户直接重试（新 chat 请求，不带 variantGroupId；rewind 只发生在 `prepareMessageRerun`）→ 历史出现两条相同 user 消息夹一条回复。模型会看到「未应答的玩家回合」并可能对其回应；记忆刷新把失败回合也折进摘要；`sameBeatTurns` 等计数被污染。
- 修法二选一：(a) 在 `runRoleplayChat` 的 catch（非 abort）中原子删除本次 user 消息及其 perception/model-input/场景更新副作用（store 增加删除 helper）；(b) 把 `addMessage` 推迟到回复定稿后（注意 source_message 事件与 perception 保存的依赖）。另补一条「失败后重试不产生重复玩家回合」的回归测试。

### F2（高）缓存批次无硬上限：切换扮演者/场景后 prompt 历史爆炸

- 位置：`src/roleplay.ts:1514-1527`（performerKey 变更 → memory 重置）＋ `src/roleplay.ts:1589-1593`（`roleplayCacheBatch` 返回全部 id > summarizedThroughId 的消息）＋ `src/roleplay.ts:2125-2126`（摘要回填固定 8 条/回合）。
- `performerKey` 变更（换角色/身份/场景 revision）→ `summarizedThroughId=0`，缓存批次随即包含**全部历史**，且每条 user 消息重放完整保存的 model input（含各自动态上下文），prompt 可能数倍膨胀。回填排水固定 8 条/回合，100+ 回合的旧对白需要几十回合排空，期间每回合 prompt 携带整段历史，极易超 context 上限；且模型流本身失败时不会触发 fold 兜底，排水停滞。
- 修法：`history` 设硬上限（如最近 30 条）；超出时在流式回复前同步执行 fold（推进 summarizedThroughId），而不是依赖每回合的异步排水。补「长对白切换扮演者后 prompt 长度有界」的测试。

### F3（高）lore 检索管线为死代码，场景 `loreBindings` 形同虚设

- 位置：`src/roleplay.ts:2006`（`retrieveRoleplayLore`，约 180 行：候选收集、缓存、rerank、`loreBindings`）无任何调用方；`src/roleplay.ts:1613` 硬编码 `lore: []`。
- `formatRoleplayMemorySlot` 的 lore 参数永远为空；场景卡 `loreBindings` 字段从未生效。玩家消息不做 lore 检索是对的，但场景显式绑定的世界观证据是可信来源，应接线。
- 修法二选一：(a) 在 `runRoleplayChat` 中按 `scene.loreBindings` 接入 `retrieveRoleplayLore`（仅绑定来源，不做玩家消息检索）；(b) 若确认不再需要，删除函数、类型与 `formatRoleplayMemorySlot` 的 lore 参数。

### F4（高）角色语义原地打转，现有反重复只防表面模板且创意权限没有正向出口

实现状态：**代码已完成（2026-08-11），待真实会话数据验收。**

- 已实现一次短 JSON 下一拍规划：在写正文前生成 2—3 个开放策略候选，按当前压力、角色目标、近期策略和可验证的角色自身状态增量选择一项；规划失败时降级为原演员链路，不阻断正常回合。
- 已将策略放入既有最终 user 动态尾部，固定 4 个 system 槽位、顺序和稳定前缀未改变。
- active facts 先供规划器按相关性、重要性、消息新近程度选择，主演员只收到候选实际引用的少量 facts；规划不可用时最多回退 6 条，不再固定灌入 16 条。
- 终审已接入最近 3 条角色输出、选中策略和持久化表达/策略账本，支持 `semantic_self_echo`、`tactic_reuse_without_new_pressure`、`state_delta_missing` 三种语义退回；不能靠删减修好的候选交回主演员换备选策略一次，而非由低温编辑器发明内容。
- 已交付的策略、角色自身增量、最小表达命题、引用 fact IDs 和终审结果写入 `roleplay-strategy` session artifact；条目绑定真实 roleplay 用户消息，重跑/切分支后不在当前消息链的账本不会再参与规划。
- 没有采用多份完整回复并行生成：只生成多个抽象策略、一次主演出，只有语义终审明确退回时才追加一次主演员重试，以限制正常回合成本与延迟。

- 用户实感：角色创意有限，每轮倾向再次强调前面已经表达过的立场、承诺或情绪，只更换措辞而没有产生新的互动结果。
- 位置与机制：
  1. `runRoleplayChat` 每轮同时注入近期完整历史、滚动摘要、完整 working state、场景目标和最多 16 条 active facts（`src/roleplay.ts:1583-1628`）。同一事实可能同时出现在 history / summary / state / facts / scene card，多路重复会持续抬高其显著性。
  2. `extractAntiFormulaHints` / `formatRoleplayAntiFormulaSlot`（`src/roleplay.ts:1269-1330`）只检查最近回复的开头、动作词、场景词和问句收尾，无法识别「措辞不同但主张、情绪结论或交涉策略相同」的语义自复述。
  3. `finalizeRoleplayPerformance`（`src/roleplay.ts:1168-1218`）只接收 currentPerception 与本轮 candidatePerformance，看不到近期角色输出；它能删除对玩家输入的复述，却无法判断角色是否又说了一遍自己前两轮的话。终审又被禁止新增动作或台词，因此发现内容贫乏时也只能修剪，不能选择新的角色策略。
  4. 稳定规则同时强调「只使用已建立事实」「一个核心反应」「不得新增事件/结果」，但没有明确列出角色权限内可主动创造的低影响行为。模型为避免越权，容易退回最安全的已有观点。`initiative` 只是一句强弱提示，没有绑定目标、策略变化或可验证的状态增量。
- 这不是采样温度不足：`roleplaySampling` 已把演出 temperature 限制在 0.85—1.3。单纯继续升温会同时增加越权和事实漂移，不能解决语义循环。

#### 研究依据

- [Generative Agents](https://arxiv.org/abs/2304.03442) 将 observation、memory retrieval、reflection、planning 分开，并按 recency / importance / relevance 动态取回记忆；消融结果显示 observation、planning、reflection 都影响行为可信度。对应本项目：不能把所有 active facts 和重复摘要等量灌入每轮，应先按当前压力检索，再由目标规划下一拍。
- [SOTOPIA](https://arxiv.org/abs/2310.11667) 用角色、场景和私有社会目标驱动交互，并把 goal completion、关系、可信度等分开评价；论文观察到模型相较人类缺少持续、策略化的目标行为。对应本项目：主动性应定义为推进角色目标的策略行为，而不是无条件多说、多问或凭空制造事件。
- [Investigating Proactivity in Task-Oriented Dialogues](https://aclanthology.org/2025.dnd-16.4/) 将主动行为定义为非纯反应且有助于长期目标，并发现主动回合并非均匀地每轮出现。对应本项目：主动动作应在停滞、目标受阻或出现机会时触发，不能写成固定的「每轮必须推进」模板。
- [Modeling the One-to-Many Property in Open-Domain Dialogue with LLMs](https://aclanthology.org/2025.gem-1.24/) 将开放域回复拆成多个语义/措辞不同的候选生成与偏好选择；[Reranking Overgenerated Responses](https://aclanthology.org/2024.lrec-main.1219/) 也表明单一高概率回复容易落入乏味、重复的 likelihood trap，而多候选再排序能找到被首选概率压低的优质回复。对应本项目：成本可控的做法是先生成多个「抽象策略候选」再写一份演出，不必并行生成多篇完整回复。
- [Measuring and Improving Semantic Diversity of Dialogue Generation](https://aclanthology.org/2022.findings-emnlp.66/) 指出词汇层多样性不能可靠代表语义多样性；[Don’t Say That!](https://aclanthology.org/2020.acl-main.428/) 也把复制上下文和重复作为需要显式负向约束的问题。对应本项目：不能只用开头、动作关键词或字符串重合审查，必须做语义级「是否仍在表达旧命题」裁决。

#### 根治方案

1. **把记忆分成“可知事实”与“本轮相关材料”，停止全量重复注入。** 保留数据库中的完整 perspective-bounded facts；构建 prompt 前，用当前 perception、角色目标、未决张力和场景状态做语义检索，综合 relevance、importance、recency，只注入少量真正相关事实。相同内容若已在 recent history 中清楚出现，不再从 summary/facts 重复注入；置顶只保证可被检索，不代表每轮强塞。
2. **新增角色表达/策略账本，而不是用字符串黑名单。** 记忆刷新从角色已交付回复中提取最小语义项：`proposition`（已经明确表达的立场/承诺/拒绝/信息）、`tactic`（追问、回避、让步、施压、示弱、转移等本轮实际策略）、`sourceMessageId`、`status(active/resolved/superseded)`、`repeatWhen`（局势变化、被直接质疑、承诺到期等重新表达条件）。它是动态尾部数据，不进入稳定前缀。已表达命题默认不再主动复述，但仍可在语境确实变化时自然回收。
3. **在主演出前做轻量“下一拍策略选择”，保持 Agentic 而非固定状态机。** 由短 JSON 调用基于角色目标、当前 perception、未决张力和近期 tactics 生成 2—3 个彼此语义不同的抽象策略候选；每项只包含 `intent`、`tactic`、`expectedSelfDelta`、`usesFacts`，不得写台词、不得确定他人反应。选择器按人设一致、认知合法、与近期策略不同、能产生角色自身状态增量排序，随后只让主演出模型写被选中的一项。无足够主动依据时允许沉默、维持边界或延后，不强制制造转折。
4. **明确“可创造但不越权”的正向权限。** 角色可以自主选择自己的措辞、注意对象、姿态、停顿、距离调整、是否兑现/拒绝/隐瞒、如何使用现场已建立物件，以及提出符合既有认知的主观判断；角色不可以建立新身世、新能力、新关键物件、精确机制、他人内心/动作/反应或未经环境确认的世界结果。把主动性从「发明世界事实」改成「改变自己的策略和可观察行为」。
5. **让终审看到近期角色语义，并把失败退回演员而非低温编辑器硬修。** `finalizeRoleplayPerformance` 增加最近 2—3 条已交付 assistant 回复、表达/策略账本和选中策略，语义判定：`semantic_self_echo`、`tactic_reuse_without_new_pressure`、`state_delta_missing`。若候选只是换词复述旧命题或没有实现预定 self delta，终审不得自行补写新内容，而是返回结构化 rejection，由主演出模型在同一事实边界内改用下一个策略候选，最多重试一次。
6. **主动性采用机会触发，不设机械配额。** 仅当当前目标受阻、对方没有提供新信息、同一 beat 停滞、承诺到期或现场出现已建立的可用机会时，提高 proactive move 权重；普通承接回合仍允许只作真实反应。不要落实为关键词/正则触发，由策略模型结合状态语义判断。
7. **保留确定性边界，语义质量交给模型裁决。** 引号/wire/权限范围等结构问题继续确定性检查；「是否重复旧观点」「是否换了策略」「是否真正推进」不得用关键词、n-gram 或固定动作表硬判。词面重合只可作为审查信号，不能单独阻断。

#### 分阶段落地

- 第一阶段（先止住复述）：终审加入近期 assistant 回复与 `semantic_self_echo` / `state_delta_missing`；记忆注入做跨 summary/state/facts/history 去重；补可观测日志，记录候选被拒的语义原因。
- 第二阶段（恢复主动创意）：增加抽象策略候选与选择，定义角色自身可创造权限；将 `initiative` 映射为策略选择倾向，而非直接要求模型“更主动”。
- 第三阶段（长期稳定）：落地表达/策略账本和相关性检索，按真实会话审计调整 retrieval 数量与重启条件。若一次短策略调用已足够，不升级为多份完整回复生成，避免成本和延迟无界增长。

## 二、逻辑缺陷（中）

### M1（中）记忆刷新永远滞后一整轮，与续演设计意图矛盾

- 位置：`src/roleplay.ts:1538`（prior 排除当前 user 消息）、`src/roleplay.ts:1583-1585`（refresh 输入不含当前回合）、`src/roleplay.ts:1711-1741`（refresh 先于 assistant 落库）。
- 摘要/state 永远不会包含「刚刚生成的那条回复」，滞后≥1 轮。续演路径注释（roleplay.ts:1602-1603）声称「refresh working state every continue so location/action anchors do not lag」，但刷新输入的是上一轮之前的内容，与意图矛盾。
- 修法：续演路径把刚产出的 reply 追加入刷新输入（或改为明确接受滞后并修正注释/文档为真实语义）。

### M2（中）`sameBeatTurns` 与节拍提示语义失真

- 位置：`src/roleplay.ts:1696-1703`（每轮 +1，仅 refresh 检测到 beat 变化才归零）、`src/roleplay.ts:1249-1251`（`sameBeatTurns >= 3` 提示「已连续 N 轮停留在「beat」」）。
- beat 由 `seedStateFromScene` 固定 seed 为「开场」，首次 refresh 在第 4 轮回复之后 → 第 3-4 轮就会注入「已连续 3 轮停留在「开场」」的提示，与实际剧情无关。提示文案实际含义是「自上次记忆刷新以来的轮数」。
- 修法：提示文案改为「自上次记忆刷新」语义，或 refresh 前先比较旧 beat 并清零计数。

### M3（中）感知终审第二调用失败直接判死回合，尽管 initial 可用

- 位置：`src/roleplay.ts:1024-1038`（`compileRoleplayPerception` 的 semantic_coverage_finalize 调用抛错直接传播）。
- `resolveRoleplayPerceptionAfterFinalize` 的存在本身就承认 initial 是兜底，但第二调用失败时异常直接传播 → 整个回合失败。
- 修法：catch 第二调用错误并回退 `initial`。

### M4（中）关闭终审时 wire 解析过严导致回合硬失败

- 位置：`src/roleplay.ts:1138-1166`（`readRoleplayWireBlock` 只接受精确 `<action>` 等，标签外任何文字 → `valid=false`）。
- `qualityFinalizeEnabled=false` 且模型输出 `<action class="…">` 或标签外文字时，无终审兜底 → 整个回合抛错。
- 修法：wire 解析容忍标签属性，或容忍标签外文字（只提取标签块）。

## 三、低优先级

- L1：`src/roleplay.ts:1488` 的 `inputMode === undefined && isRoleplayOocInput(...)` 自动检测分支在真实链路上永不触发——`src/server.ts:2304` 恒传 `"dialogue"`/`"director"`（死分支，或改为 server 对 undefined 也走自动检测）。
- L2：记忆刷新（`refreshRoleplayMemory`）的审计输入是感知编译产物而非原始玩家文本（`src/roleplay.ts:1583-1585`），感知编译的错分会直接传导进记忆；记忆模型的「认知审计」指令实际审的是编译措辞。可考虑把原始文本一并作为审计输入。
- L3：失败续演留下的 `<续演>` 标记（无回复）仍被 `countRoleplayContinuationStreak` 计入（`src/roleplay.ts:1540`），「连续第 N 次旁观续演」虚高。
- L4：`recommendRoleplayDirectorActions` / `generateRoleplayInterlocutor` 等 `completeJsonText` 调用未传 `strictJson`，依赖 `{}` 提取，解析一致性弱于感知/终审路径。
- L5：`openingVariants` 仅取 `[0]`（`src/roleplay.ts:1512`），前端无选择路径，其余 variant 属冗余字段。

## 验收

- F1：失败/取消后重试不产生重复玩家回合；失败回合的 perception/model-input/场景更新被回滚。
- F2：切换扮演者后 prompt 历史长度有界（硬上限生效），无需等待逐回合排水。
- F3：场景 `loreBindings` 生效或死代码删除（二选一）。
- F4：
  1. 同一事实不会在 recent history、summary、state、facts 和 scene card 中无差别重复注入；检索结果带来源与评分，能够解释本轮为何需要该事实。
  2. 候选若只是换词重申最近角色已经表达的命题，语义终审返回 `semantic_self_echo`，且不会把词面相似本身当作阻断依据；对方直接质疑、局势变化或承诺到期时允许有功能的重提。
  3. 主动回合必须产生角色权限内的 `expectedSelfDelta`，但不要求每轮主动；不得用新增世界事实、替玩家行动或确认环境结果伪造推进。
  4. 最小模型桩测试覆盖「旧立场换词复述被退回」「新压力下合理重提被放行」「更换策略但保持同一目标」「无主动机会时自然停顿」；不构造复杂模拟请求。另用真实会话日志抽样审计连续 8—12 轮的语义自复述率、策略变化、目标推进、角色一致性和认知越界，修复后不得以增加越权/幻觉换取表面多样性。
  5. 稳定 roleplay 4 槽位前缀与动态尾部顺序保持不变；新增策略、账本和检索内容进入既有动态上下文，相关缓存契约测试通过。
- M1—M4：滞后语义与注释一致；节拍提示与实际 beat 一致；感知终审失败可回退；wire 解析容忍属性。
- `npm run build` 通过；相关测试（`roleplay` / `agent_cache` / `server`）通过。
