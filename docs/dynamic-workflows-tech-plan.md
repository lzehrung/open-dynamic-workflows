# Open Dynamic Workflows — 技术方案与任务拆分（JS/TS 运行时）

> 文档日期：2026-06-01 ｜ 状态：方案已确认，实施中（M0 已合入 main） ｜ 关联：[`dynamic-workflows-research.md`](./dynamic-workflows-research.md)
>
> 目标：把 Claude Code 私有 runtime 内的 "dynamic workflow" 能力，做成一套**任意 coding agent、任意环境**可用的开源实现。本项目用 **TypeScript / Node 重写**，直接运行 **Claude Code 方言的 JS workflow 脚本**（如 [`examples/deep-research.js`](../examples/deep-research.js)）。

---

## 0. 已锁定的设计决策

| 维度 | 决策 | 说明 |
|---|---|---|
| **脚本语言** | **JavaScript（Claude Code 方言）** | workflow 脚本是纯 `.js`，由运行时**动态求值**，不编译、不类型检查——这是 Claude Code 生态的可移植标准。`agent()` 本质是"起一个外部 CLI 子进程等结果"。 |
| **引擎语言** | **TypeScript / Node** | 多层系统类型重，TS 在编译期抓 bug；编译成 ESM，**零运行时依赖**；附带 `.d.ts` 让脚本作者获得编辑器补全。早期的 Python 实现是一次技术误判，已删除。 |
| **执行模型** | **后台运行时** | 脚本在独立 Node 进程后台运行，宿主 fire-and-poll；`--wait` 提供同步等待。 |
| **配置** | **JSON（`odw.config.json`）** | Node 零依赖解析；不再用 TOML。 |
| **项目承载** | **全新 JS 实现** | 原 Python 包整体删除，不迁移、不兼容。 |
| **v1 范围** | **务实优先：跑通 `deep-research.js`** | 先全量做 `agent/parallel/pipeline/phase/log/args/schema` + `budget` 桩；`model/agentType/worktree/嵌套 workflow/真实 token 预算/resume` 作为 v1.5+ 增量。 |
| **命名** | 包 `open-dynamic-workflows`，CLI `odw` | 配置 `odw.config.json`，环境变量 `ODW_CONFIG`，run 目录 `~/.odw/runs`。 |

---

## 1. 背景与目标

[`dynamic-workflows-research.md`](./dynamic-workflows-research.md) 已把事实摸清：dynamic workflow 是"Claude 现写、后台 runtime 执行的一段 **JavaScript** 编排脚本，在上下文之外大规模调度 subagent"。它的价值——把编排搬进代码、中间产物不污染上下文、可大规模 fan-out——非常通用，**但它目前只存在于 Claude Code 的私有 runtime 里**。Codex CLI、Gemini CLI、Qwen、Kimi 以及任何自建 agent 都拿不到这个能力。

> 让**任意一个 coding agent**，在**任意环境**下，都拥有 dynamic workflow 能力；并且能**直接运行 Claude Code 生态里已经在产出的那些 JS workflow 脚本**。

由于真正会被分发的 workflow 脚本是 JS（Claude Code 最早布局、生态最全），早期"用 Python 实现原语"是一次方向性误判：那条路要求作者改写脚本，无法承接现成的 `*.js` workflow。本次重写把引擎换成 TS/Node，使 `deep-research.js` 这类脚本**原样可跑**。

---

## 2. 对齐 Claude Code 标准：workflow 方言与 loader（核心）

"对齐"的实质，是**复刻 Claude Code 的脚本方言**，并实现一个能解释它的运行时。

### 2.1 方言特征（逐条来自 `deep-research.js` 与本环境 Workflow 工具签名）

| 特征 | 写法 | 含义 |
|---|---|---|
| 元信息 | `export const meta = {...}`（**纯字面量**，置顶） | 必须先于执行被解析，用于登记 name/phases |
| 脚本体即工作流 | 文件其余部分直接是逻辑，含**顶层 `await`** 与**顶层 `return`** | 二者在标准 ESM/CJS 里都非法 → 运行时必须做**代码转换** |
| 原语是注入的全局 | 直接用 `agent/parallel/pipeline/phase/log/args/budget/workflow`，**无任何 import** | 注入到作用域，不是模块导入 |
| `agent` 选项 | `agent(prompt, { label, phase, schema, model, agentType, isolation })` | 无 schema→返回字符串；有 schema→返回校验过的对象 |
| `schema` | 原始 **JSON Schema 对象** | 直接写 dict，不用构造器 |
| `parallel` | 屏障；单个抛错→结果数组里的 `null` | |
| `pipeline` | 每个 stage 收 `(prevResult, originalItem, index)`；stage 抛错→该 item 变 `null` | |
| `budget` | `{ total, spent(), remaining() }` | 按 token 预算动态扩缩 |
| 沙箱 | `Date.now/Math.random/new Date()` 被禁（为可重放） | v1 不强制（无 resume） |

### 2.2 loader / transform（运行时里最关键、Python 版完全不存在的一块）

Python 版只是 `exec` 一个定义了 `workflow` 函数的模块。JS 版必须做一次**源码转换**，集中在 [`src/loader.ts`](../src/loader.ts)：

1. **抽出 `meta` 字面量**（先于执行，用于登记 name/phases）；
2. **去掉 `export` 关键字**；
3. 把其余脚本体**包进一个 async 函数**，其参数就是注入的原语（外加 `args`），于是脚本体的顶层 `return` 变成函数返回值、顶层 `await` 合法。

转换保持**零依赖**：复用 schema 提取器同款的"平衡括号扫描"来定位 `meta` 对象字面量。

### 2.3 为什么 Node 比 Python 更对

`agent()` 是纯 I/O-bound 子进程调用。Python 阻塞式调用必须靠线程池 + Semaphore 才能并发（`scheduler.py` 的复杂度全为此买单）。Node 的 `child_process` 天生异步、主线程从不阻塞，于是：

- `parallel` = `Promise.all`（每个 thunk `.catch(()=>null)`）
- `pipeline` = 每个 item 一条独立 async 链，再收口
- "并发上限"缩成一个 ~30 行的**异步信号量**

**线程模型整体删除**，这是 Node 比 Python 更贴合本问题的根本原因。

---

## 3. 编程原语（对外契约）

### 3.1 原语清单与 v1 对齐状态

| 原语 / 能力 | 语义 | v1 状态 |
|---|---|---|
| `agent(prompt, opts?)` | 调度一个 coding agent 跑一个子任务（唯一产出工作的原语）。`opts`：`label/phase/schema/adapter/model/agentType/isolation` | ✅ 全量（`model/agentType/isolation` 见下） |
| `parallel(thunks)` | 屏障：等齐全部再返回；单点失败以 `null` 占位 | ✅ |
| `pipeline(items, ...stages)` | 流式：条目各自穿过多阶段，无屏障；stage 收 `(prev, item, index)` | ✅ |
| `phase(title)` / `log(msg)` | 进度分组 / 进度消息 | ✅ |
| `meta` | 顶部声明工作流元信息（loader 解析） | ✅ |
| `args` | 工作流输入，运行时注入 | ✅ |
| `schema`（JSON Schema） | 给 agent 输出定类型：注入→提取→校验→重试 | ✅（M3） |
| 并发上限 `min(16, CPU-2)` + agent 总量兜底 1000 | 规模约束，运行时强制 | ✅ |
| `budget`（`total/spent()/remaining()`） | token 预算 | 🟡 **桩**：`total` 经 `--budget`/args 注入（默认 null），`spent()` best-effort；真实计量延后 |
| `agent` 的 `model` / `agentType` | 路由到适配器模型参数 / 命名适配器 | 🟡 v1.5 |
| `isolation:'worktree'` | git worktree 隔离 | 🟡 v1 先用 workspace `copy` 兜底 |
| `workflow()`（嵌套） | 内联调用另一个 workflow（一层） | 🟡 v2，先留清晰报错桩 |
| `Date.now/Math.random` 沙箱、resume/journaling | 可重放 | ⬜ v2 |

> **v1 验收**：上表 ✅ + `budget` 桩，足以让 `deep-research.js` 端到端跑通。

### 3.2 关系与组合（只讲逻辑）

- `agent` 是**执行原子**；`parallel/pipeline` 是**高阶编排算子**（每个节点是一次 `agent`）；`schema` 是**流经节点的数据类型**；`meta/phase/log` 是**横切标注**；`args` 是入口；并发/总量上限是**边界**。
- **屏障 vs 流式**：`parallel` 只在"下一步真需要全量结果"时用（去重、计票、汇总）；`pipeline` 是多阶段默认。纯逻辑归并发生在**原语之外的普通 JS 代码**里。
- **schema 是可靠流水线的黏合剂**：没有它，多阶段传自由文本、下游碰运气；有了它，`pipeline` 后一阶段才能稳定消费前一阶段。
- **常见形态**（原语 + 普通控制流）：fan-out→reduce→synthesize；对抗式校验（adversarial verify）；judge 面板；loop-until-dry。
- **确定性约束**：乱序 OK（只要归并顺序无关），按时序分支不 OK——这也是 v1 只提供 `parallel/pipeline`、把"裸 futures"推后的原因。

---

## 4. 架构与分层

分层结构 L1–L6 + 横切，整体保留；用 **ESM TypeScript** 实现，新增 `loader`。

| 层 | 职责 | 模块 |
|---|---|---|
| **L1 适配层** | 把任意 CLI 抽象成统一调用：命令模板 + 占位符 + stdin + 工作目录；内置 5 个适配器 | [`src/adapters/`](../src/adapters/) |
| **L2 执行桥接** | 一次 `agent` 调用 → 选适配器 → 组装独立 prompt →（隔离运行）→ 收结果 →（schema 校验+重试） | [`src/bridge.ts`](../src/bridge.ts) |
| **L3 调度层** | **异步并发限流器** + agent 总量兜底（无线程） | [`src/scheduler.ts`](../src/scheduler.ts) |
| **L4 原语层 + 数据契约** | `agent/parallel/pipeline/phase/log` 等 + `schema` 注入/提取/校验/重试 | [`src/primitives.ts`](../src/primitives.ts)、[`src/schema.ts`](../src/schema.ts) |
| **loader（核心）** | meta 抽取 + 脚本体包裹 + 原语注入 | [`src/loader.ts`](../src/loader.ts) |
| **L5 运行时层** | 后台 worker、run 目录、状态/进度/控制 | [`src/runtime/`](../src/runtime/) |
| **L6 接口层** | `odw` CLI（run/status/logs/result/list/pause/stop + `--wait`）、skill 文档、示例 | [`src/cli.ts`](../src/cli.ts) |
| **工作区隔离**（横切） | 每次 agent 调用在隔离副本运行、回收 diff，默认不污染主工作区 | [`src/workspace.ts`](../src/workspace.ts) |

调用关系：

```
odw(cli) ──> runtime(worker) ──加载并转换──> workflow 脚本(.js, Claude 方言)
                                              │ 注入原语
                                         primitives ──用──> scheduler(并发/上限)
                                              │ agent() 经
                                            bridge ──用──> adapters ──> 真实 CLI 子进程
                                              │             workspace(隔离运行 + diff)
                                            schema(校验 agent 输出)
```

一句话：**宿主用 `odw` 发起 run → runtime 在后台 Node 进程里读脚本、由 loader 转换并注入原语 → 脚本调用 primitives → `parallel/pipeline` 经 scheduler 受控并发 → 每个 `agent` 经 bridge 选适配器、在 workspace 隔离里调真实 CLI、必要时由 schema 校验 → 结果回到脚本 → 最终值写回 run，供宿主查询。**

工程约定：workflow 脚本始终是**纯 `.js`**、从不编译；引擎是 **TS**（编译成 `dist/` 的 ESM，**零运行时依赖**），并发布 `.d.ts`（[`types/workflow.d.ts`](../types/workflow.d.ts)）给脚本作者做补全。

---

## 5. MVP 范围与分期

| 范畴 | 一期-A（最小可用） | 一期-B（可靠组合） | 二期（fast-follow） |
|---|---|---|---|
| 原语 | agent / parallel / pipeline / phase / log / meta / args + **loader** | + schema（注入+校验+重试） | budget 真实计量、嵌套 workflow、model/agentType、worktree、裸 futures |
| 调度 | 异步并发上限 + agent 总量兜底 | — | — |
| 运行时 | 后台 worker、run 目录、status/logs、pause/stop、`run`(fire-and-poll)+`--wait` | — | **resume**（journaling）、worktree 隔离 |
| 接口 | CLI + 内置适配器 + `deep-research.js` 验收 | skill 文档 + 原语参考 + 全套示例 | 更多适配器 / MCP 包装、TUI/Web 观测 |

**明确不在一期**：resume/journaling、真实 token budget、嵌套 workflow、worktree、`Date.now/Math.random` 沙箱。一期先验证"原语能否把多 agent 编排成有用的工作流，并跑通 Claude 方言脚本"这一核心命题。

---

## 6. 任务拆分（里程碑）

每个 M 可独立合并、测试绿。关键路径：`M0 → M1 → M2 → {M3, M4} → M5 → M6`。

### M0 — 项目骨架 ✅ 已完成（commit `507ff7a`，已在 main）
- `package.json`（包 `open-dynamic-workflows`、bin `odw`、ESM、零运行时依赖）+ strict `tsconfig`；分层 `src/` 骨架（errors/events/placeholders/builtin/control 实现，其余按里程碑打桩）；`odw.config.example.json`、`types/workflow.d.ts`、`examples/deep-research.js`；`node:test` 脚手架。
- **验收**：`npm run build` 干净；`npm test` 11/11；`odw --help`/`--version` 可用；Python 清零。✅

### M1 — 适配层 + 执行桥接 + 工作区隔离
> 依赖：M0。
- adapters：JSON 配置解析、占位符/命令模板、`child_process` 调用与捕获（stdout/stderr/退出码/超时）、内置适配器。
- workspace：copy 隔离副本运行 + diff 采集；inplace 模式。
- bridge：一次 agent 调用（选适配器 → 组装独立 prompt → 隔离运行 → 收结果）。
- **验收**：用 mock 适配器，能在隔离工作区跑一次 agent 调用并取回 stdout 与 diff。

### M2 — 核心原语 + 异步调度 + 🌟loader
> 依赖：M1。
- scheduler：异步并发限流器 + agent 总量兜底。
- primitives：`agent/parallel/pipeline/phase/log`（Promise 实现，含 pipeline 三参约定与 null 容错）。
- **loader**：meta 抽取 + 脚本体包裹 + 原语注入。
- **验收**：能加载并运行一个最小 `export const meta` + 顶层 `return` 脚本；单测覆盖 parallel 屏障、pipeline 流式与错误传播、并发上限、总量兜底。

### M3 — schema 结构化输出
> 依赖：M2。
- schema：注入结构要求 → 提取 → 校验 → 重试；接入 `agent`。
- **验收**：mock 模拟"先吐脏结果再吐合法结果"，断言重试后命中；耗尽后按策略行为正确。

### M4 — 后台运行时 + CLI
> 依赖：M2（可与 M3 并行）。
- runtime：后台 Node worker（detached spawn）、run 目录（原子写）、状态/进度事件、`pause`/`stop`、FileControl。
- cli：`run`(fire-and-poll)/`--wait`/`status`/`list`/`logs`/`pause`/`stop`/`result`。
- **验收**：长跑 mock 工作流可后台启动、`status`/`logs` 可观测、`pause`/`stop` 生效、`result` 取到最终值。

### M5 — 🎯 `deep-research.js` 端到端
> 依赖：M3、M4。
- `budget` 桩 + 全原语联调，把 [`examples/deep-research.js`](../examples/deep-research.js) 当验收用例（mock 适配器）跑通。
- **验收**：`odw run examples/deep-research.js --wait --args '"<问题>"'` 跑出最终结果对象。

### M6 — skill + 文档 + 示例
> 依赖：M5。
- 重写 `skills/open-dynamic-workflows/SKILL.md`（=skills.md）+ `references/`（JS 版原语参考）；补 `examples/`（fan-out→reduce、对抗式校验、loop-until-dry）；README/agent 自安装提示词改 npm。
- **验收**：示例全部能 `run` 跑通（mock 适配器）；文档自检无指向不存在的命令/原语。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| loader 转换对边角脚本不鲁棒 | 个别脚本加载失败 | 零依赖平衡括号扫描 + 清晰报错；必要时引入 `acorn` 仅做解析 |
| 异构 CLI 不稳定吐结构化结果 | `schema` 命中率低 | 注入要求 + 提取 + 校验 + 重试；失败可观测；二期走适配器原生 JSON 模式 |
| 一期无 resume，长跑中断需重跑 | 浪费已完成工作 | 一期接受重跑；二期补 journaling。先用并发上限/总量兜底/`stop` 控成本 |
| token/时长成本失控 | 费用/限流 | 并发上限 + 总量兜底 + `pause`/`stop`；二期 `budget` 硬上限 |
| 后台进程生命周期 | 运维困难 | run 目录 + 状态心跳；明确"宿主退出后 run 不跨进程续跑" |

---

## 8. 验收总纲

1. **能力达成**：任一配置好的 coding-agent CLI，可被一段 **Claude 方言的 JS workflow 脚本**编排成 fan-out→reduce→synthesize / 对抗式校验 / loop-until-dry，且能后台运行、可观测、可停止。
2. **可移植 / 同源**：`deep-research.js` 这类为 Claude Code 写的脚本**原样可跑**；换一组适配器即可换底层 agent。
3. **可被 agent 自助使用**：宿主 agent 仅凭 `skills/open-dynamic-workflows/SKILL.md` 即可写出并运行新 workflow。

---

## 附录 A — 与 research 文档的术语映射

| research 术语 | 本方案落点 |
|---|---|
| who holds the plan | 脚本变量（后台 Node worker 进程内），上下文只回传最终值 |
| 脚本方言（meta + 注入全局 + 顶层 await/return） | [`src/loader.ts`](../src/loader.ts) 的源码转换 |
| fan out → reduce → synthesize | `parallel/pipeline` 扇出 → 纯 JS 归并 → 收尾 `agent` 综合 |
| barrier vs streaming | `parallel`（屏障）/ `pipeline`（流式，默认） |
| adversarial verify / judge panel | 原语 + 普通控制流的组合形态 |
| loop-until-dry | 脚本 `while` + `parallel` + 去重 |
| structured handoff | `schema`（注入 + 校验 + 重试） |
| 并发上限 / 总量兜底 | `scheduler`（异步信号量 + 硬上限） |
| resume / journaling | 运行时能力，**不在一期** |
