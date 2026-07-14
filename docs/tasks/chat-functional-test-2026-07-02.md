# Chat Host 功能测试记录（2026-07-02）

> 测试入口：`http://localhost:4328/#/chat`
> 测试方式：浏览器手工探索 + `/api/chat/*` HTTP 边界请求 + 响应式视口检查。
> 记录方式：本次选择写文档，方便后续拆成 GitHub Issues。

## 0. 测试环境与数据

- 时间：2026-07-02，Asia/Shanghai。
- 分支/目录：`/Users/danielxing/repos/open-dynamic-workflows`，当前本地服务端口 `4328`。
- 覆盖视口：
  - 默认桌面视口。
  - `820x900`。
  - `390x844`。
- 覆盖语言：
  - 英文默认界面。
  - 设置页切换为中文后复测 Chat。
- 测试期间创建的数据：
  - `chat_mr3bnyli-wey858`
  - `chat_mr3bo95u-u5wr6i`
  - `20260702-174914-12034a`
  - `20260702-175205-b68a06`

## 1. 已验证可用路径

- `GET /api/chat/sessions` 可以返回会话列表。
- `POST /api/chat/sessions` 可以创建会话，并持久化到本地存储。
- 普通消息可以追加到会话，并收到固定 assistant 回复。
- `Ctrl+Enter` 可以发送消息。
- 含 `ODW` / `workflow` 关键词的消息可以创建本地 `chat-host-bridge` run，并写入 linked run。
- 刷新页面后，会话、消息、linked run 能恢复。
- linked run 卡片可以跳转到 `#/job/<runId>`。
- 写保护边界可用：
  - 空文本返回 `400 {"error":"text must be a non-empty string"}`。
  - 非 JSON 返回 `400 {"error":"body must be a JSON object"}`。
  - 错误 Content-Type 返回 `415`。
  - 跨 Origin 写请求返回 `403`。

## 2. 问题清单

### CH-01：新建/切换会话后，Chat 视图不会继续轮询 active session

严重级别：P1

复现步骤：

1. 打开 `#/chat`。
2. 点击 `+ New` 新建会话，或点击左侧已有会话切换。
3. 发送一条会触发 ODW 的消息，例如 `请用 ODW workflow 记录这条切换会话后的测试`。
4. 等待 4 秒以上。

实际结果：

- UI 仍显示 `running` / `pending` / `Waiting for events...`。
- 左侧会话也仍显示 `running`。

后端证据：

- `GET /api/runs/20260702-175205-b68a06` 返回 `state: "done"`。
- `GET /api/chat/sessions/chat_mr3bnyli-wey858` 返回 `state: "done"`，tool status 也是 `done`，事件与 result 都已存在。

预期结果：

- Chat tool card、右侧 linked run、左侧会话状态应在 run 完成后自动变为 `done`。

可能原因：

- 新建会话和切换会话都使用 `history.replaceState(...)`，但没有触发 `hashchange`，也没有重新执行 `enterRoute()`。
- 原来的 poll interval 仍绑定旧的 `want`，切换后条件 `activeChatId !== want` 导致轮询停止。

建议拆 Issue 标题：

- `fix(chat): restart session polling after creating or selecting a chat session`

### CH-02：窄屏下无法新建/切换会话，主内容也被侧栏挤压

严重级别：P1

复现步骤：

1. 设置视口为 `390x844` 或 `820x900`。
2. 打开 `#/chat/<sessionId>`。

实际结果：

- `.chat-list` 在 `max-width: 820px` 下 `display: none`。
- `+ New` 和所有 session button 都宽高为 `0`，用户无法新建/切换会话。
- 整体 `.app` 仍是 `grid-template-columns: 228px 1fr`，左侧 rail 固定占据 228px。
- 在 `390x844` 下，composer 起始位置约为 `left: 228px`，输入区只剩约 220px 宽。

预期结果：

- 移动/窄屏至少应提供会话抽屉、顶部切换器或新建入口。
- App shell 应有移动端布局，不应把主内容挤到很窄。

建议拆 Issue 标题：

- `fix(chat): provide mobile session navigation and avoid squeezed chat layout`

### CH-03：不存在的 session 深链显示错误的空状态

严重级别：P2

复现步骤：

1. 打开 `#/chat/not-a-real-session`。
2. 本地已有至少一个 chat session。

实际结果：

- 左侧能看到已有会话。
- 中间区域却显示 `No chat sessions yet / Create a hosted turn to start.`。
- 没有 404、没有“会话不存在”、没有自动回退到第一条可用会话。
- 输入框可编辑，Send 按钮视觉上可点击，但没有真实发送入口。

预期结果：

- 应显示“会话不存在”，并提供回到第一条会话或新建会话的明确操作。

建议拆 Issue 标题：

- `fix(chat): handle missing chat session routes with an explicit not-found state`

### CH-04：关键词触发过于粗糙，否定语义也会启动 ODW run

严重级别：P2

复现步骤：

1. 在 Chat 中发送：`普通消息：hello chat host，不触发 workflow`。

实际结果：

- 因为文本包含 `workflow`，后端仍触发 `chat-host-bridge` run。
- 生成 run：`20260702-174914-12034a`。

预期结果：

- 明确否定“不要触发 / 不触发 workflow”的消息不应启动 run。
- 至少应在触发 run 前让用户确认。

可能原因：

- `wantsOdw(text)` 是关键词正则：`/\bodw\b|workflow|agent|fan[- ]?out|并行|工作流|智能体/i`。

建议拆 Issue 标题：

- `fix(chat): avoid false-positive ODW runs from negated workflow mentions`

### CH-05：前端吞掉写入错误，用户看不到失败原因

严重级别：P2

复现/证据：

- 后端对错误请求已有清晰返回：
  - 空文本：`400 text must be a non-empty string`
  - 不存在会话：`404 no such chat session`
  - 错误 Content-Type：`415 write requests require Content-Type: application/json`
  - 跨 Origin：`403 cross-origin write requests are rejected`
- 但 `store.createChatSession` 和 `store.sendChatMessage` 的 `catch` 只 `emit()` 或返回 `null`，UI 没有 toast / inline error / retry。
- 空输入点击 Send 只是无声无效。

预期结果：

- 写入失败时应在 composer 附近显示错误，保留用户输入，并允许重试。

建议拆 Issue 标题：

- `fix(chat): surface create/send failures in the composer`

### CH-06：空状态与空输入的控件没有真正禁用

严重级别：P2

复现步骤：

1. 打开无有效 session 的 Chat 状态，例如 `#/chat/not-a-real-session`。
2. 或在已有 session 里输入空白字符后点击 Send。

实际结果：

- 空状态 textarea 没有 `disabled` 属性。
- 空状态 Send button 只有 `class="disabled"`，没有 `disabled` 属性，也没有 `aria-disabled`。
- 已有 session 的 Send button 在空输入时仍 `isEnabled() === true`。
- 点击空输入 Send 后没有提示，空白仍留在输入框。

预期结果：

- 无 session 时 textarea 和 Send 应真正 disabled。
- 空输入时 Send 应禁用，或点击后给出可见提示并清理空白。

建议拆 Issue 标题：

- `fix(chat): disable composer controls when sending is not possible`

### CH-07：中文界面下 Chat 仍混有大量英文文案

严重级别：P3

复现步骤：

1. 到 Settings 切换为中文。
2. 回到 `#/chat/<sessionId>`。

实际结果示例：

- 后端生成的 assistant 文案仍是英文：
  - `This local Chat Host session is ready...`
  - `I linked this turn to a local ODW run...`
  - `I recorded this turn in the local Chat Host...`
- 顶部标签仍是英文：
  - `Codex host`
  - `ODW bridge`
- tool event 仍是内部事件名：
  - `run_started`
  - `phase_started`
  - `run_finished`
- Host activity 中仍出现 `1 linked run(s)`。

预期结果：

- UI 固定文案走 i18n。
- 后端固定回复应支持当前语言，或前端用 message kind 渲染本地化文案。
- 内部事件名应映射为用户可读文本。

建议拆 Issue 标题：

- `fix(chat): localize Chat Host system messages and tool event labels`

### CH-08：已完成的 Chat bridge run 仍显示 0% progress

严重级别：P3

复现步骤：

1. 发送触发 ODW 的消息。
2. 刷新页面，等待后端 run 已完成。

实际结果：

- API 返回 linked run `state: "done"`，但 `progress: 0`。
- Chat tool card 和 linked run 进度条为空。
- 跳到 Job 详情后，因为该 bridge run 没有 agents，图区域显示 `Waiting for the first agent...`，但 run 实际已经 done。

预期结果：

- done 状态至少应显示 100% 或隐藏进度条。
- phase-only run 的 Job 图不应显示“等待第一个智能体”。

建议拆 Issue 标题：

- `fix(chat): render completed phase-only bridge runs without empty progress`

### CH-09：缺少会话管理能力，测试/真实会话会持续堆积

严重级别：P3

现象：

- UI 只有 `+ New`。
- 后端只有 list / get / create / append message。
- 没有删除、重命名、归档、清空测试会话的能力。

预期结果：

- 至少提供删除/归档会话。
- 对测试场景提供清理路径，避免本地 `_chat/sessions.json` 长期堆积。

建议拆 Issue 标题：

- `feat(chat): add basic chat session management`

## 3. 建议优先级

1. 先修 CH-01：这是核心 live data 体验，直接导致用户误以为 run 仍在运行。
2. 再修 CH-02 / CH-03：避免窄屏和深链把用户困在不可操作状态。
3. 再修 CH-04 / CH-05 / CH-06：降低误触发和失败无反馈。
4. 最后修 CH-07 / CH-08 / CH-09：完善本地化、展示细节和会话管理。

## 4. 回归测试建议

- 前端加轻量 Playwright/DOM 测试：
  - 新建会话后发送 workflow 消息，mock `/api/chat/sessions/:id` 从 running 变 done，断言 UI 自动更新。
  - 点击已有会话后发送 workflow 消息，断言 UI 自动更新。
  - `#/chat/not-real` 显示 not-found 状态。
  - `390x844` 下能打开会话列表/新建会话。
- 后端保留现有 `tests/server.test.ts` Chat Host 测试，并补：
  - 否定语义不触发 run。
  - phase-only bridge run done 时 progress 语义。
  - localized/system message strategy 一旦确定后补 contract test。

## 5. 证券 ETF / RW 端到端复测

测试时间：2026-07-02 22:29-22:35，Asia/Shanghai。

测试会话：`chat_mr3kyy3s-wi3c7e`。

测试任务：

```text
请用 ODW workflow / RW 跑一个简单任务：调研一下 A 股证券 ETF，给出 3-5 只主要产品、核心区别、适用场景和风险提示。请把调研正文作为 ODW 结果返回。
```

### 5.1 结果结论

- 新 run：`20260702-222925-2f598a`。
- 旧 run：`20260702-220957-42ba04`，仍是修复前产生的占位结果；本次只作为历史对照。
- 新 run 走到了真实 `agent()` 调用，`workflow.js` 中不再是硬编码 `{summary, prompt, sessionId}`。
- 新 run 最终 `done`，耗时约 329 秒。
- `/api/runs/20260702-222925-2f598a/result` 返回了真实调研正文，长度约 1566 字符，包含产品表、核心区别、适用场景、风险提示和来源链接。
- `/api/chat/sessions/chat_mr3kyy3s-wi3c7e` 自动追加了 `kind: "chat.odw_result"` 的 user message。
- ODW result 回灌后，Codex follow-up 被自动触发，并最终 `status: "done"`。
- 浏览器 DOM 中能看到新 run id、`A 股证券 ETF 简要调研` 正文和 `ODW / RW 已完成` follow-up。

### 5.2 关键证据

run event：

```text
run_started -> phase Capture -> phase Execute -> agent_started(codex) -> agent_finished -> phase Return -> run_finished
```

result 摘要：

```text
# A 股证券 ETF 简要调研

产品覆盖：512880 证券ETF国泰、512000 券商ETF华宝、159841 证券ETF天弘、159993 证券ETF鹏华、515010 证券ETF华夏。
内容覆盖：跟踪指数、规模、费率、核心区别、适用场景、风险提示、来源链接。
```

### 5.3 UI 回归

- 消息区在 run 完成后保持贴底：`nearBottom: true`。
- 将 `.chat-messages` 滚到中间后等待超过两个轮询周期，`scrollTop` 从 `2566` 到 `2566`，未回跳。
- 再滚到底部等待轮询，仍保持底部。
- 输入框填入 `测试中文输入中` 后等待超过两个轮询周期，输入值保留，焦点仍在 `#chat-input`。
- 说明：程序化测试只能覆盖输入值和焦点保留；真实中文 IME composition 仍建议人工再手测一次。

### 5.4 新观察点

### CH-10：运行中缺少可见中间进度，长任务容易被误判为卡住

严重级别：P3

现象：

- 本次证券 ETF 任务从 `agent_started` 到 `agent_finished` 约 329 秒。
- 期间 `events.jsonl` 没有新事件，`worker.log` 为 0 字节。
- UI 只能显示 tool card `running`，没有 CLI stderr/stdout、心跳、耗时、预计超时或“Codex 子进程仍在运行”的解释。
- 直接 `codex exec` 和同 temp workspace 的短探针都能在 10 秒内返回，说明不是 CLI 启动挂死，而是长 agent 调用期间缺少可见进度。

预期结果：

- 长任务 running 状态应显示已运行时长和最后一次事件时间。
- 如果 stdout/stderr 只能在子进程结束后进入内存，也应至少发心跳事件或展示 adapter timeout。
- 可考虑在 tool card 上提示“正在等待 Codex 子进程返回，最长超时 1800s”。

建议拆 Issue 标题：

- `ux(chat): show heartbeat and elapsed time while a Chat ODW agent is running`
