# Web 前端代码审查待优化清单

> 依据：对 `src/web/` 全部组件、`connection.ts`、`api_client.ts` 的代码审查（`npm run typecheck` 通过）。
> 本文只列「明确问题 / 有确定修法」的条目；改动代码前先查本清单，完成后更新状态。

## 1. 明确缺陷（先修）

### 1.1 附图乐观气泡的 blob URL 被提前回收（高优先）

- 位置：`src/web/main.tsx:1902-1911`（乐观消息引用 `item.previewUrl`）、`main.tsx:1997`（POST 成功后 `clearPendingAttachments()` 同步 `URL.revokeObjectURL`）。
- 机制：发送后到任务结束 `refresh()` 用服务器 URL 替换消息前的整个窗口内，气泡 `<img src="blob:...">` 引用的 blob 已失效；大图（接近 4MB）或任何 remount 场景显示裂图。
- 修法：发送成功后延迟回收 object URL（如等刷新替换消息后再回收），或在乐观消息上不再直接引用将被回收的 blob。

### 1.2 Markdown 链接未过滤危险协议（高优先）

- 位置：`src/web/markdown.tsx:77` `link` 渲染器只 `escapeHtml`，未白名单化 `href` scheme。
- 机制：`isLocalMarkdownHref` 对 `javascript:`/`vbscript:` 返回 false（视为 external），但非 http 链接不加 `target=_blank`；文档阅读器中点击会在页面上下文执行 → XSS 隐患。
- 修法：渲染时按白名单（`http/https/mailto/#/./../`）过滤 `href`，其余脱敏或降级为纯文本。

## 2. 性能问题

### 2.1 `renderedMarkdownWordCount` 在渲染热路径重复解析

- 位置：`src/web/main.tsx:4727`（每条 roleplay 消息渲染时调用），`src/web/markdown.tsx:148-153`（每次 `renderMarkdownHtml` + 新建 `DOMParser`）。
- 机制：SSE 流式时 `streamSteps` 每帧更新触发整个会话列表重渲染，所有 roleplay 气泡的 Markdown 被反复解析。
- 修法：按「消息 id + content」做 memo；避免在列表渲染路径内建 `DOMParser`。

### 2.2 `FileTreeItem` 的 `onDragOver` 每次事件都 setState

- 位置：`src/web/document_sidebar.tsx:359-364`。
- 机制：dragover 高频触发，每个节点每次 move 都重渲染整棵树，大目录下拖动卡顿。
- 修法：用 ref 标记拖拽意向节点，仅在意向变化时触发渲染。

## 3. 架构与可维护性

### 3.1 `main.tsx` 单组件巨兽（7161 行）

- 约 90 个 useState + 全部 handler + 所有模态框/面板 JSX 堆在 `App` 内，消息渲染含大量 IIFE（`{(() => {...})()}`，如 `main.tsx:4671`）。
- 修法：按领域拆分（会话区、审阅区、各模态框），状态按领域收敛为 hooks。

### 3.2 `agentSettings` 默认对象重复 12 处

- 位置：`src/web/main.tsx:1540,1558,1769,1806,7020-7152` 等；8 个 `onXxxChanged` 回调（约 130 行）各自重建完整对象。
- 修法：收敛为 `DEFAULT_AGENT_SETTINGS` 常量 + `updateAgentSettings(partial)` helper。

### 3.3 常量重复定义

- 位置：`src/web/agent_steps.tsx:857-893` 与 `src/web/context_graph.tsx:6-42` 定义相同的 `CONTEXT_GRAPH_KIND_LABEL` / `EDGE_LABEL` / `TURN_CHILD_ORDER` / `LAYER_LABEL`；`agent_steps` 中的副本无引用（死导出）。
- 修法：删除 `agent_steps.tsx` 中的副本，统一从 `context_graph.tsx` 导入。

## 4. 死代码（约 600 行）

### 4.1 恒为 false 的开关保留整段不可达 JSX

- 位置：`src/web/main.tsx:3531-3534`（`showStylePicker` / `showConnectionPanel` / `showThemePicker` / `showLegacyProseGateManager`），对应 JSX 仍打进 bundle（连接面板 ~165 行、主题选择器 ~65 行、prose-gate 编辑器第二/第三份各 ~165 行）。
- 备注：`proseGatesSettingsContent` 同时被 `managementView` 分支渲染并传给 `ModelConfig`，`showLegacyProseGateManager` 下还有第三份完整副本。
- 修法：删除不可达 JSX 与多余副本。

## 5. 健壮性

### 5.1 SSE 解析无容错

- 位置：`src/web/main.tsx:1592` `JSON.parse(line.slice(5))`，畸形 `data:` 行会中断整个订阅循环并被当作断线。
- 修法：单行 try/catch 跳过畸形事件。

### 5.2 `saveDocument` 无错误处理

- 位置：`src/web/main.tsx:2212-2223`，PUT 失败成为未捕获 rejection，用户无反馈；其余写操作均有 try/catch。
- 修法：补 try/catch 并提示。

### 5.3 DnD 载荷解析无保护

- 位置：`src/web/document_sidebar.tsx:199,372` `JSON.parse(raw)` 未包 try/catch。
- 修法：解析失败直接忽略该 drop。

## 6. 次要提示（记录不改）

- `attachmentImageUrl`（`src/web/composer_media.ts:29-33`）把 token 放进 URL query，会进入浏览器历史/日志；自托管工具可接受。
- `startConnectionMonitor`（`src/web/connection.ts:492`）每 4s 后台探测，离线时持续空转。
- `aria-label="Close"`（`main.tsx:6278`）英文混杂，其余为中文。
- `markdown.tsx` 模块级可变状态（heading 索引/source 游标）依赖同步渲染，当前安全但脆弱。

## 7. 验收方式

- 修完后跑 `npm run typecheck` 与 `npm run build`。
- 1.1：发送附图后乐观气泡不出现裂图；1.2：含 `javascript:` 链接的正文点击不执行。
- 4.1：删除后 bundle 体积应明显下降。
