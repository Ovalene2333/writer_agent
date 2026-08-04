# Writer Agent

面向长篇创作的写作 Agent。以项目目录管理设定、大纲、章节与角色，通过 **Web 工作台** 与模型协作；对正文的修改以**提案**形式提交，经作者审批后再写入文件。

本分支（`web`）以 Web 为唯一交互界面；终端仅保留 `init` / `web` / `run` / `export` / `session` 等 CLI 入口，不再提供 TUI。

## 功能概览

- **项目化写作**：`writer.yaml` + Markdown 文档树，设定、大纲、正文分目录存放
- **Web 写作工作台**：浏览器中对话、读文档、审批修改；支持局域网与临时公网分享
- **Web 权限与任务条**：Agent 面板可切换 Ask/Auto/Plan，实时显示 `manage_todos` 清单
- **一次生成（CLI）**：`writer run` 执行单次写作任务后退出，适合脚本或批处理
- **权限模式**：`ask`（提案审批）/ `auto`（自动写入）/ `plan`（只读规划）
- **任务清单**：`manage_todos` 多步任务跟踪，会话内可查看
- **工具模块化**：Agent 工具 schema 与 handler 拆分在 `src/tools/`（documents / outline / characters / proposals / meta）
- **项目指令**：自动加载 `WRITER.md` / `AGENTS.md` / `CLAUDE.md` / `.writer/instructions.md`
- **可加载技能**：内置 `chapter-planning` 章节规划 Skill；项目可通过 `.writer/skills/<id>/SKILL.md` 或 `.agents/skills/<id>/SKILL.md` 新增或覆盖，Agent 按描述调用 `load_skill`
- **修改提案与撤销**：Agent 默认不直接覆盖正文，提案可接受 / 拒绝，并支持 undo / redo
- **纯文本工作区与 change set**：Agent 可在 `resource/` 内读取和管理 UTF-8 纯文本；多文件写入、补丁、移动、删除及角色演进可整组预览、审批、回滚和重做
- **角色卡**：结构化角色资料，可供检索与写作引用
- **角色扮演试演**：扮演者和当前身份均支持简易/普通角色卡；可绑定独立场景卡，显式切换“角色内/导演”输入，查看、纠错和置顶带来源的事实记忆，并按当前对白语义选择相关 lore；试演按会话保存且不直接修改文档
- **结构化大纲**：幕 / 章 / 场景节点，可与正文对照校验
- **风格模板**：内置网文爽文、传统文学、轻小说、悬疑推理、玄幻仙侠等
- **现场感计量**：句式门禁与复用计量之外的加法层，测量对白占比、感官通道、具体物件锚点与句长起伏；只提示不拦截，并参与候选择优
- **多模型分工**：可为 agent / roleplay / writer / reviewer 等角色配置不同供应商与模型
- **图片生成**：可为图片生成分配独立模型（如 `gpt-image-2`），由 Agent 生成封面、插图和视觉参考并直接附到回复
- **导出**：按章节顺序导出完整作品为 Markdown 或纯文本

## 环境要求

- [Node.js](https://nodejs.org/) **≥ 22**（内置 `node:sqlite`）
- 兼容 OpenAI Chat Completions 协议的模型 API（内置 DeepSeek 与 OpenAI 兼容配置）
- （可选）[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/)：`writer web --share` / `--share-once` 公网分享时需要

## 安装

```bash
git clone <本仓库地址>
cd writer_agent
npm install
npm run build
```

开发时可不构建，直接用：

```bash
npm run dev -- <子命令>
# 例如
npm run dev -- init ./my-novel --title "未命名作品"
```

构建后可把 `writer` 链到全局（可选）：

```bash
npm link
# 之后可直接使用
writer init ./my-novel
```

## 快速开始

```bash
# 1. 初始化写作项目
writer init ./my-novel --title "我的小说"
cd my-novel

# 2. 启动 Web 工作台（推荐）
writer web

# 3. 在浏览器中配置 API Key，开始对话创作
```

也可在不进入浏览器的情况下做一次生成：

```bash
writer run "根据大纲写第一章开场，约 1500 字"
writer run "只出大纲方案，不改文件" --mode plan
writer run "续写并自动落盘" --mode auto -c   # -c 继续最近会话
```

## 命令行

| 命令 | 说明 |
|------|------|
| `writer [项目目录]` | 启动本地 Web 工作台并打开浏览器（默认当前目录） |
| `writer init [目录] [--title 名称]` | 初始化写作项目 |
| `writer web` / `writer serve` | 启动 Web 写作工作台 |
| `writer run <指令>` | 执行一次写作生成后退出 |
| `writer grok-proxy` | 将 Grok Build 订阅接口反代为 OpenAI Chat Completions |
| `writer export` | 按章节顺序导出作品 |
| `writer session list` | 列出会话 |

### `writer web` 常用选项

```bash
writer web -p ./my-novel          # 指定项目目录
writer web --port 4096            # 端口，默认 4096
writer web --lan                  # 监听 0.0.0.0，允许局域网访问
writer web --host 0.0.0.0         # 自定义监听地址
writer web --share                # 固定域名 Named Tunnel（需 CF_TUNNEL_TOKEN + CF_TUNNEL_HOSTNAME）
writer web --share-once           # 一次性临时域名 *.trycloudflare.com（重启会变）
writer web --share --share-host other.example.com   # 覆盖固定域名
writer web --no-open              # 不自动打开浏览器
writer web --no-token             # 关闭 API 鉴权；可与 --lan / --share 同用
writer web --share --no-token     # 建立无令牌公网入口（终端会打印安全警告）
writer web --debug                # 打印 step 内容 + 模型请求/响应体
writer web --debug-steps          # 仅打印 Agent 每步 reasoning / tools / output（推荐排查 UI step）
```

**`--share`（固定域名）** 需要 Cloudflare Named Tunnel：

```bash
export CF_TUNNEL_TOKEN='<Cloudflare 隧道 connector token>'
export CF_TUNNEL_HOSTNAME='ovalene.dpdns.org'
# 可选：WSL 下指定二进制
# export WRITER_CLOUDFLARED=/mnt/d/software/cloudflared/cloudflared.exe
writer web --share -p ./p/jn3
```

CF 控制台里 Public Hostname 的服务地址须指向本机端口（默认 `http://localhost:4096`）。

**`--share-once`** 走 Quick Tunnel，无需 token，地址每次随机。

cloudflared 会自行切换边缘节点；若进程仍退出，Writer 会按 2 秒、5 秒退避自动重建，连续 3 次未连接后输出故障分类。Named Tunnel 固定域名不变；Quick Tunnel 中断后旧临时地址失效。

### `writer run` 常用选项

```bash
writer run "续写第二章" -p ./my-novel
writer run "润色大纲" --session <会话ID>
writer run "继续刚才的修改" -c
writer run "先出计划" --mode plan
writer run "自动写入" --mode auto
writer run "检查人设一致性" --json    # 逐行输出 JSON 事件
writer run "..." --debug
writer run "..." --debug-steps      # 仅 step 调试输出
```

### Grok Build 本地反代

`writer grok-proxy` 参考 Sub2API 的 Grok OAuth 与 Responses 桥接方式，把 xAI 订阅侧的
`grok-build-0.1` 转换为 Writer 可直接使用的 OpenAI Chat Completions 接口：

```bash
writer grok-proxy -p ./my-novel
```

首次运行会打开 xAI OAuth 授权页；若页面显示一次性代码，将其粘贴回终端并按回车。
授权后，终端会打印本地 Base URL、模型名和 API Key；
工具会自动在当前项目的 `providers.json` 中新增或更新“Grok Build 本地反代”供应商，
但不会改动现有模型分工。xAI 凭据仅保存在 `.writer/grok-proxy.json`。需要换号时运行：

```bash
writer grok-proxy -p ./my-novel --login
```

默认只监听 `127.0.0.1:4101`。上游需要网络代理时可传
`--proxy-url http://127.0.0.1:7890`；未传时会依次读取 `HTTPS_PROXY` 和 `HTTP_PROXY`
环境变量。除非明确需要局域网接入，不要修改监听地址。

### 权限模式与项目指令

| 模式 | 行为 |
|------|------|
| `ask`（默认） | 文档修改以提案提交，需作者审批 |
| `auto` | 提案创建后自动写入文件（可 undo） |
| `plan` | 禁止写入类工具，只做检索与规划 |

设置保存在 `.writer/agent.json`。Web 端“写作”设置可关闭角色演进；关闭后叙事任务不会自动追加角色经历或故事状态，显式角色卡编辑不受影响。

项目指令（自动注入 system prompt，按优先级取第一个存在的文件）：

1. `WRITER.md`
2. `AGENTS.md`
3. `CLAUDE.md`
4. `.writer/instructions.md`

项目技能目录：

- `.writer/skills/<id>/SKILL.md`
- `.agents/skills/<id>/SKILL.md`

### `writer export`

```bash
writer export -f md -o book.md    # Markdown
writer export -f txt -o book.txt  # 纯文本
writer export                     # 写到标准输出
```

## 项目结构

初始化后大致如下：

```text
my-novel/
├── writer.yaml              # 作品元数据（标题、语言、章节列表、风格）
├── resource/                # 作品 Markdown（Agent 可读写的文档树）
│   ├── lore/                # 设定与事实源（世界规则、专名、组织等）
│   │   └── world.md
│   ├── outline/             # 情节计划（卷/章/场景）
│   │   └── outline.md
│   ├── chapters/            # 主线正文（导出与续写默认区）
│   │   └── chapter-001.md
│   ├── side/                # 支线 / 间章（可选）
│   └── archive/             # 旧稿 / 弃用版（可对 Agent 隐藏）
├── characters/              # 角色卡（jsonl / 单卡 JSON）
├── WRITER.md                # 项目指令（仿 AGENTS.md，init 时生成模板）
└── .writer/                 # 运行时私有数据（勿手改关键文件）
    ├── writer.db            # 会话、提案、用量等
    ├── providers.json       # 模型供应商配置（含 API Key；可整文件迁移）
    ├── agent.json           # 权限模式等 Agent 设置
    ├── skills/              # 可选项目技能
    └── ...
```

文档分区约定：

| 目录 | 写什么 | 不写什么 |
|------|--------|----------|
| `lore/` | 可检索的设定事实 | 章节散文、对白 |
| `outline/` | 情节计划与场景节点 | 可发表正文 |
| `chapters/` | 主线正文 | 设定清单、作者草稿 |
| `side/` | 支线正文 | 主线导出内容 |
| `archive/` | 旧稿 | 现行 canon |

`writer.yaml` 示例：

```yaml
title: 我的小说
language: zh-CN
chapters:
  - chapters/chapter-001.md
style: ""   # 可设为风格模板 id，如 light-novel
```

## 模型配置

### 在 Web 界面中配置

打开工作台后配置供应商与 API Key。支持：

- **DeepSeek**（如 `deepseek-v4-flash`、`deepseek-v4-pro`）
- **OpenAI 兼容** 接口（任意提供 `/v1/chat/completions` 的服务）

可为不同用途分配模型，例如：

| 角色 | 用途 |
|------|------|
| `agent` | 任务规划与工具调用 |
| `roleplay` | 角色试演、身份设定与沉浸式对白 |
| `writer` | 正文生成 |
| `inline` | 局部改写等 |
| `reviewer` | 审阅 / 质检 |
| `summarizer` | 摘要 |

### 环境变量（可选，优先级高于项目配置）

CLI 启动时会自动读取当前工作目录下的 `.env`；已经在 shell 中设置的同名变量优先。`.env` 已被 Git 忽略，不会提交密钥。

| 变量 | 说明 |
|------|------|
| `WRITER_API_KEY` | API Key |
| `WRITER_BASE_URL` | API Base URL，如 `https://api.deepseek.com` |
| `WRITER_MODEL` | 模型名 |
| `WRITER_IMAGE_BASE_URL` | 可选；生图 API Base URL，默认复用供应商或 `WRITER_BASE_URL` |
| `WRITER_IMAGE_API_KEY` | 可选；生图 API Key，默认复用供应商或 `WRITER_API_KEY` |
| `WRITER_IMAGE_MODEL` | 可选；生图模型名，覆盖“图片生成”角色分配 |
| `WRITER_IMAGE_PROXY_URL` | 可选；仅生图请求使用的 HTTP(S) 代理 |
| `WRITER_PROVIDERS_FILE` | 供应商配置文件路径（默认 `.writer/providers.json`；可指向共享文件以便跨项目迁移） |
| `WRITER_DEBUG` | 设为 `1` / `true` 时打印 **step 内容** 与模型请求/原始返回 |
| `WRITER_DEBUG_STEPS` | 设为 `1` / `true` 时**仅**打印 Agent step（reasoning / tools / output），不含模型 HTTP 原文 |
| `WRITER_TUNNEL_PROTOCOL` | cloudflared 传输协议，默认 `http2` |
| `CF_TUNNEL_HOSTNAME` | `--share` 固定域名（必需） |
| `CF_TUNNEL_TOKEN` | Named Tunnel connector token（`--share` 必需） |
| `WRITER_CLOUDFLARED` | 可选；cloudflared 可执行文件路径 |

#### 禁用采样参数

部分较新的模型（GPT-5、o 系列及其兼容实现）不再忽略 `temperature`，而是直接拒绝整个请求，并且同时拒绝 `top_p` 与惩罚项。在**模型配置 → 编辑供应商 → 对应模型**中选择「采样参数：不发送」后，Writer 对该模型的所有调用（正文、状态提取、终审、候选重写与评选、角色扮演、局部改写等）都不再发送这组参数，改由供应商使用自身默认值。风格模板不再包含或改写模型采样参数。

OpenAI 兼容模型还可逐模型配置 `reasoning_effort` 与 `verbosity`；未选择时不发送，交给供应商默认值。`reasoning_effort` 和 `verbosity` 独立于采样参数开关。

漏发采样参数不会导致请求失败，多发一个被弃用的参数会——所以该开关一次性抑制整组，不需要逐项判断供应商弃用了哪些。

供应商与计费配置集中在 **单独文件** `.writer/providers.json`（含 API Key、模型单价、峰谷计费、角色分工）。复制该文件即可迁移到另一项目；旧版 `.writer/provider.json` 会在首次启动时自动迁移。

#### Step 调试输出格式（`--debug-steps`）

启动 Web 后在同一终端会看到类似：

```text
[WRITER STEP] ▸ job start session=a1b2c3d4 job=e5f6g7h8
[WRITER STEP] prompt: 创建第三章大纲…
[WRITER STEP] ══ Step 1 start ══  session=a1b2c3d4 job=e5f6g7h8 (agent)
[WRITER STEP] tool → list_documents
[WRITER STEP] ══ Step 1 done (1234ms) ══  ...
[WRITER STEP] tools: list_documents, list_outline_nodes
[WRITER STEP] --- reasoning ---
...
[WRITER STEP] --- output ---
...
```

把从 `job start` 到 `done` 的整段复制出来即可用于分析。

## 写作工作流（Agent 行为）

1. **编译任务契约**：识别交付物、事实依据、写入义务与规划复杂度；模式只影响领域表达，不裁掉工具能力
2. **自主执行与重规划**：Agent 根据每次工具结果选择下一步；路径失败或范围变化时通过 `manage_todos` 修订计划
3. **按需获取事实**：检索设定 / 大纲 / 正文，加载角色与范文，而不是无脑铺全文
4. **运行时完成检查**：事实、目标读取、提案、角色保存和动态清单等必要条件未满足时禁止提前结束
5. **提案、审批与追问**：修改以提案交付；仅在缺少不可推断的关键决策时暂停并询问用户

每次任务同时写入追加式 `agent_runs` / `agent_run_events`。恢复、完成判定和多文档交付均由事件 reducer 生成的唯一快照决定，todos 只用于模型规划。提案应用采用 `prepared -> committed` 记录，进程在文件写入后中断时可按内容 hash 继续提交数据库状态。

Agent 可用的主要能力包括：列出与检视 Markdown 文档、按块 / 节 / 行读取、全文检索、大纲节点读写与校验、通用纯文本文件读取，以及通过 change set 整组提议文件创建 / 补丁 / 移动 / 删除与角色演进。

正文交付不绑定固定场景流水线。Agent 可以直接提交完整文档、按锚点局部修改、按需编译 write pack，或在长篇连续状态和逐场修订确有收益时主动启用场景草稿链；这些能力互不构成形式上的前置条件。

### 正文质量的四个方向

句式门禁（`prose_quality`）、复用计量（`prose_metrics`）与整章终审（`chapter_review`）都是**减法**：它们回答"有没有 AI 腔"。一段平淡、正确、无破折号的稿子在这些关卡上全部满分通过，所以另有一层**加法**：

- `prose_vividness` 测量对白起始段占比、出场的感官通道数、具体物件锚点密度、泛化氛围词密度与句长起伏，给出 0—100 的现场感分。**它从不拦截**，只在 `write_chapter_scene` 返回下一场的补位建议、在 `inspect_chapter_draft` 给出 `vividnessWarnings`，并作为终审的 `proseSignals`。
- 整章终审新增 `generic_prose` 维度：换掉人名地点仍能原样放进别的故事的句子。只有整场都停留在泛化叙述时才判 blocker。
- 逐场候选采样（`scenePipeline.candidateCount`，默认 2）在场景**同时干净且有现场感**时跳过；否则生成一份保事实重写稿，由 reviewer 模型按"哪一稿更值得读下去"择优，评选失败则回退到确定性打分。设为 1 可关闭，代价是平淡但无错的场景不再有第二次机会。

第三层是**张力**。加法层测的是"看不看得见"，不是"有没有人在乎"，所以一场干净、有画面、无风险的戏依然会全线通过：

- 场景卡带三个压力字段：`readerQuestion`（本场收尾时读者最想知道什么，每场必填且各场不得逐字重复）、`cost`（谁付出了不可撤销的代价，整章至少一场必填）、`oppositionMove`（阻力方主动做了什么）。校验在场景链层面而非单卡层面，由 `begin_chapter_draft` 与 `revise_chapter_scene_guide` 硬拦截。
- `chapterDriveSignals` 从场景卡与各场 `actualState` 计算结构化数字：`knowledgeOnlyStreak`（连续多少场只改变了信息）、`scenesWithoutCost`、`passiveOppositionScenes`、`openLoopsNeverDischarged`。与现场感分同一契约——测量、上报、从不拦截，只作为终审的 `proseSignals.drive` 提示往哪看。
- 整章终审据此新增 `drive_flat`（全章无人在争取一件他在乎且可能失败的事）与 `stakes_absent`（变化发生了但代价从头到尾不存在）两类驳回项。零星平淡列 warning，整章成立才判 blocker，且必须逐字引用正文证据；刻意的静场或收束章不因节奏平缓判错。快速模式下候选采样被强制关闭，这两类是唯一在读者层面判断"要不要继续读"的环节。

第四层是**对白**。前三层合起来对短促对白有净奖励：`prose_vividness` 按"以引号开头的段落数"给分，一句「知道。」独占一段就能拿满；而 `prose_metrics` 的碎句门禁在统计前会剥掉引号内容，短对白因此不受任何节奏惩罚。结果是通篇电报式应答在每一关都是最优解：

- `dialogue_texture` 测量对白自身的形状，按"声称知道多少"分三族：**形式**（句数、长度中位数与均值、≤6 字与 ≥30 字占比、句长起伏 p80−p20）、**句式**（并列分句共用的起头词，代词剥离后按结构匹配，不看词汇）、**言语动作**（应答／承诺／命令／提问／拒绝／陈述，词表判定）。触发 `dialogue_clipped`（全章只剩确认与应答）、`dialogue_monotone`（不论谁说、说什么长度都在同一档）、`construction_shared`（同一个并列句式在全章反复出现——是作者的手，不是人物的嘴）、`act_compliant`（应答＋承诺占比过高，人物大多在接受和表态而不在争取）四类**提示**。**从不拦截**。
- 前三类判定与说话人归属无关，这是刻意的：承载作者手癖的台词往往挂在「他说」上，或所在段落里出现的名字只是被提及而非在说话；一旦要求归属，`construction_shared` 在真实章节上恒为空。归属成功时才把人名附在提示里。
- 言语动作是本模块唯一读语义的地方，只按分布上报、从不对单句下判断；判定阈值用的是**应答＋承诺**的合计占比而非最大类占比——`陈述` 是兜底类，恒占六到八成，用它衡量只会在每一章都触发。
- 说话人归属优先使用项目角色卡里的真实姓名，且要求姓名后紧跟提示语动词，否则宁可不归属（只是被"看着"的人不算在说话）。没有名册时回落到「X说」提示语解析，会漏掉代词与无提示语的台词，`attributedLines` 偏低不代表对白少。归属只用于提供参考数字，"谁在说分不分得出来"始终由终审模型判断，不由规则判断。
- `prose_vividness` 的对白得分改用**成句**对白起始段占比：内容 3 字以内的纯应答不计分，五个字的问句仍然计分。目的是掐掉"多写几句「嗯。」就能加分"的路径，而不是惩罚简洁。
- 整章终审新增 `dialogue_frictionless`（每个问题都在下一句被正面回答，没有人回避、误解、打断或说一件对方没问的事），并把 `voice_homogenization` 的 blocker 门槛降低一档：不必"全章无一处可区分"，主要人物通篇共用同一套句长与句式即可判罚。

`prose_vividness` 与 `prose_metrics` 的高频微动作词表刻意正交：后者压降"目光/呼吸/指尖"这类身体填充词，前者奖励"光线/声响/铁锈味"这类对世界的知觉，同一个词不会被两边同时计分。

真实 Agent 轨迹可用 `npm run eval:agent` 自动评测。默认从 `../jn2` 只读加载各角色供应商配置，在 `writer-agent-data/agent-eval-project` 的独立项目中运行；任务契约、工具序列、终止状态、提案结果和失败原因会持久化到该项目的 `.writer/writer.db`。编译后可用 `node dist/cli.js agent-eval --list` 查看历史结果。

## 内置风格模板

| ID | 名称 | 适合 |
|----|------|------|
| `webnovel-power` | 网文爽文 | 连载、升级流、系统文 |
| `literary` | 传统文学 | 严肃文学、历史题材 |
| `light-novel` | 轻小说 | 校园、日常、恋爱喜剧 |
| `mystery` | 悬疑推理 | 推理、悬疑、犯罪 |
| `xianxia` | 玄幻仙侠 | 修仙、东方玄幻 |

在项目配置中设置 `style`，或在 Web 工作台中切换风格模板。

## 开发

本分支以 Web 为主开发面；不要重新引入 TUI / ink 依赖。

```bash
npm run dev -- web          # 用 tsx 启动 Web 工作台
npm run dev -- <cli 参数>   # 其他 CLI 子命令
npm run build               # 编译 Node 端 + 构建 Web 静态资源
npm run typecheck           # 类型检查
npm test                    # 编译并跑测试
```

主要源码：

| 路径 | 说明 |
|------|------|
| `src/cli.ts` | 命令行入口（web / run / init / export） |
| `src/agent.ts` | 写作 Agent 的提示词、模型消息与缓存边界 |
| `src/agent_loop.ts` | 薄 Agent 执行循环入口 |
| `src/agent_run_*` | 运行事件、reducer、持久化、恢复与不变量 |
| `src/server.ts` | Web API（Hono + SSE） |
| `src/project.ts` | 项目文件与安全路径 |
| `src/store.ts` | SQLite 会话 / 提案 / 用量 |
| `src/provider_catalog.ts` | 模型供应商目录 |
| `src/generation.ts` | 意图路由与生成辅助 |
| `src/outline.ts` | 结构化大纲 |
| `src/creative_outline.ts` | 创意大纲规划器（多路线发散、证据化评分与反俗套约束） |
| `src/templates.ts` | 风格模板 |
| `src/web/` | Web 前端（Vite + React） |

排障与数据分析：[docs/db-query.md](docs/db-query.md)（如何只读查询项目的 `.writer/writer.db`：表结构、成本/缓存命中分析等常用配方）。

## 安全提示

- `.writer/providers.json`（或 `WRITER_PROVIDERS_FILE` 指向的文件）含 API Key，**不要提交到公开仓库**
- `writer web --share` / `--share-once` 会把带令牌的公网地址暴露到外网；只发给可信设备，结束进程后隧道关闭
- `writer web --no-token` 会关闭全部 API 访问鉴权；可与公网分享同用，但拿到公网地址的任何人都能读写项目，终端会明确警告
- 公网分享会同时监听局域网：终端二维码为**局域网入口**（hash 里带公网地址）。手机在家扫一次后，Web 端会探测 `/api/health`，在家走局域网、出门自动改打 Cloudflare；`--share` 固定域名可长期复用，`--share-once` 重启后临时地址会变需重扫
- 请在**家中 Wi‑Fi** 下扫推荐二维码。若先打开纯公网 HTTPS 页，浏览器会拦截对局域网 HTTP 的探测（混合内容），无法自动切回局域网
- `--lan` 会允许同一局域网内的设备访问工作台，请注意网络安全环境

## 许可证

当前仓库未附带许可证文件；使用与分发前请自行确认项目所有者意图。
