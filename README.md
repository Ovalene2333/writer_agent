# Writer Agent

面向长篇创作的写作 Agent。以项目目录管理设定、大纲、章节与角色，通过 Web 工作台或命令行与模型协作；对正文的修改以**提案**形式提交，经作者审批后再写入文件。

## 功能概览

- **项目化写作**：`writer.yaml` + Markdown 文档树，设定、大纲、正文分目录存放
- **Web 写作工作台**：浏览器中对话、读文档、审批修改；支持局域网与临时公网分享
- **终端 REPL（TUI）**：`writer chat` 交互式对话，斜杠命令 / 提案审查，对齐主流 code agent 终端体验
- **Web 权限与任务条**：Agent 面板可切换 Ask/Auto/Plan，实时显示 `manage_todos` 清单
- **一次生成（CLI）**：`writer run` 执行单次写作任务后退出，适合脚本或批处理
- **权限模式**：`ask`（提案审批）/ `auto`（自动写入）/ `plan`（只读规划），类似 code agent 的 auto-run / plan mode
- **任务清单**：`manage_todos` 多步任务跟踪，会话内可查看
- **工具模块化**：Agent 工具 schema 与 handler 拆分在 `src/tools/`（documents / outline / characters / proposals / meta）
- **项目指令**：自动加载 `WRITER.md` / `AGENTS.md` / `CLAUDE.md` / `.writer/instructions.md`
- **项目技能**：`.writer/skills/<id>/SKILL.md` 或 `.agents/skills/<id>/SKILL.md`，按需 `load_skill`
- **修改提案与撤销**：Agent 默认不直接覆盖正文，提案可接受 / 拒绝，并支持 undo / redo
- **角色卡**：结构化角色资料，可供检索与写作引用
- **角色扮演试演（测试性）**：`/roleplay <角色>` 或 Web 顶部「扮演」——扮演者和当前身份都可选简易/普通角色卡，当前身份也可由 Agent 按需查询角色卡与世界观生成（默认保存为简易角色卡）；当前试演按会话保存，刷新后自动恢复；纯对话、不改文档
- **结构化大纲**：幕 / 章 / 场景节点，可与正文对照校验
- **风格模板**：内置网文爽文、传统文学、轻小说、悬疑推理、玄幻仙侠等
- **多模型分工**：可为 agent / roleplay / writer / reviewer 等角色配置不同供应商与模型
- **导出**：按章节顺序导出完整作品为 Markdown 或纯文本

## 环境要求

- [Node.js](https://nodejs.org/) **≥ 22**（内置 `node:sqlite`）
- 兼容 OpenAI Chat Completions 协议的模型 API（内置 DeepSeek 与 OpenAI 兼容配置）
- （可选）[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/)：`writer web --share` 创建临时公网地址时需要

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

# 2a. 终端 REPL（推荐，类 code agent）
writer chat

# 2b. 或启动 Web 工作台
writer web

# 3. 配置 API Key（/connect 或 Web 设置），开始对话创作
```

也可在不进入交互界面的情况下做一次生成：

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
| `writer chat` / `writer tui` | 交互式终端 Agent（默认续接最近会话） |
| `writer web` / `writer serve` | 启动常驻 Web 工作台 |
| `writer run <指令>` | 执行一次写作生成后退出 |
| `writer export` | 按章节顺序导出作品 |
| `writer session list` | 列出会话 |

### `writer web` 常用选项

```bash
writer web -p ./my-novel          # 指定项目目录
writer web --port 4096            # 端口，默认 4096
writer web --lan                  # 监听 0.0.0.0，允许局域网访问
writer web --host 0.0.0.0         # 自定义监听地址
writer web --share                # 局域网 + cloudflared；扫一次码，进出家自动切换通道
writer web --no-open              # 不自动打开浏览器
writer web --debug                # 打印 step 内容 + 模型请求/响应体
writer web --debug-steps          # 仅打印 Agent 每步 reasoning / tools / output（推荐排查 UI step）
```

### `writer chat` 常用选项

```bash
writer chat -p ./my-novel
writer chat -c                      # 续接最近会话（默认行为）
writer chat -s <会话ID>
writer chat --mode plan             # 只读规划
writer chat --mode auto             # 提案自动写入
```

TUI 斜杠命令要点：`/mode`、`/plan`、`/todos`、`/skills`、`/accept`、`/proposals`、`/status`、`/models`（Ctrl+P）、`/connect`、`/roles`、`/thinking`、`/details`、`/roleplay`（测试性角色扮演）。

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

### 权限模式与项目指令

| 模式 | 行为 |
|------|------|
| `ask`（默认） | 文档修改以提案提交，需作者审批 |
| `auto` | 提案创建后自动写入文件（可 undo） |
| `plan` | 禁止写入类工具，只做检索与规划 |

设置保存在 `.writer/agent.json`。

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

| 变量 | 说明 |
|------|------|
| `WRITER_API_KEY` | API Key |
| `WRITER_BASE_URL` | API Base URL，如 `https://api.deepseek.com` |
| `WRITER_MODEL` | 模型名 |
| `WRITER_PROVIDERS_FILE` | 供应商配置文件路径（默认 `.writer/providers.json`；可指向共享文件以便跨项目迁移） |
| `WRITER_DEBUG` | 设为 `1` / `true` 时打印 **step 内容** 与模型请求/原始返回 |
| `WRITER_DEBUG_STEPS` | 设为 `1` / `true` 时**仅**打印 Agent step（reasoning / tools / output），不含模型 HTTP 原文 |
| `WRITER_TUNNEL_PROTOCOL` | cloudflared 传输协议，默认 `http2` |

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

1. **理解任务**：根据指令判断构思、大纲、写场景、改写、审计等模式  
2. **按需读资料**：检索设定 / 大纲 / 正文，加载角色与范文，而不是无脑铺全文  
3. **生成提案**：新建或局部补丁修改 Markdown；**须作者审批**后才落盘  
4. **可中断 / 可追问**：支持取消作业，也可在关键决策点向用户提问  

Agent 可用的主要能力包括：列出与检视文档、按块 / 节 / 行读取、全文检索、大纲节点读写与校验、文档提案、角色卡读写、向用户提问等。

## 内置风格模板

| ID | 名称 | 适合 |
|----|------|------|
| `webnovel-power` | 网文爽文 | 连载、升级流、系统文 |
| `literary` | 传统文学 | 严肃文学、历史题材 |
| `light-novel` | 轻小说 | 校园、日常、恋爱喜剧 |
| `mystery` | 悬疑推理 | 推理、悬疑、犯罪 |
| `xianxia` | 玄幻仙侠 | 修仙、东方玄幻 |

在项目配置中设置 `style`，或在 Web / 会话中切换风格模板。

## 开发

```bash
npm run dev -- <cli 参数>   # 用 tsx 直接跑 CLI
npm run build               # 编译 Node 端 + 构建 Web 静态资源
npm run typecheck           # 类型检查
npm test                    # 编译并跑测试
```

主要源码：

| 路径 | 说明 |
|------|------|
| `src/cli.ts` | 命令行入口 |
| `src/agent.ts` | 写作 Agent 与工具 |
| `src/server.ts` | Web API（Hono + SSE） |
| `src/project.ts` | 项目文件与安全路径 |
| `src/store.ts` | SQLite 会话 / 提案 / 用量 |
| `src/provider_catalog.ts` | 模型供应商目录 |
| `src/generation.ts` | 意图路由与生成辅助 |
| `src/outline.ts` | 结构化大纲 |
| `src/creative_outline.ts` | 创意大纲规划器（多路线发散、证据化评分与反俗套约束） |
| `src/templates.ts` | 风格模板 |
| `src/web/` | Web 前端（Vite + React） |

## 安全提示

- `.writer/providers.json`（或 `WRITER_PROVIDERS_FILE` 指向的文件）含 API Key，**不要提交到公开仓库**
- `writer web --share` 会把带令牌的公网地址暴露到外网；只发给可信设备，结束进程后隧道关闭
- `--share` 会同时监听局域网：终端二维码为**局域网入口**（hash 里带公网地址）。手机在家扫一次后，Web 端会探测 `/api/health`，在家走局域网、出门自动改打 Cloudflare；下次重启 Writer 需重新扫码（临时隧道地址会变）
- 请在**家中 Wi‑Fi** 下扫推荐二维码。若先打开纯公网 HTTPS 页，浏览器会拦截对局域网 HTTP 的探测（混合内容），无法自动切回局域网
- `--lan` 会允许同一局域网内的设备访问工作台，请注意网络安全环境

## 许可证

当前仓库未附带许可证文件；使用与分发前请自行确认项目所有者意图。
