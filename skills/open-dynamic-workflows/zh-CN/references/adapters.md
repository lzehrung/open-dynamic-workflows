# 适配器与配置

<sub>[English](../../references/adapters.md) · 简体中文</sub>

**适配器**是 `odw` 调用某个 coding-agent CLI 的方式。`odw` 绝不直接调用模型 API——它只是
shell 出去执行一个本地命令，通过 stdin 或一个参数把拼好的 prompt 传进去，再从 stdout 读
回复。

## 内置适配器

九个开箱即用、无需配置文件：`codex`、`claude`、`gemini`、`qwen`、`kimi`、`omp`、`kilo`、
`opencode` 和 `cursor`。它们用各自 CLI 的非交互模式。

### 权限：每个内置适配器能做什么

命令模板刻意保守，而且内置适配器之间**权限并不相同**：

- `codex` 以 `--sandbox workspace-write` 运行：开箱即可在其工作区内**编辑文件并执行
  命令**。它还带着 `--search`，可以**原生搜索网页**。
- `claude` 以 `--permission-mode acceptEdits` 加 `--allowedTools WebSearch WebFetch`
  运行：**能编辑文件、能用网页工具，但不能执行命令**（要求它运行什么的 prompt 会卡住
  或被拒绝）。网页白名单很关键：headless 的 acceptEdits 否则会静默拒绝
  WebSearch/WebFetch，`examples/deep-research.js` 这类调研 workflow 会直接跑不通。要让 Claude 也能跑命令，用
  `--dangerously-skip-permissions` 覆盖该适配器——它**没有任何沙箱**，所以只能对着一个
  用完即弃的 `--source` 目录这么干，绝不要指向你的真实仓库：

```json
{
  "adapters": {
    "claude": {
      "command": ["claude", "--print", "--dangerously-skip-permissions", "--no-session-persistence"],
      "stdin": "{prompt}"
    }
  }
}
```

一种实用的最小权限分工：让 `claude` 写代码（acceptEdits）、让 `codex` 运行/验证
（workspace-write 沙箱）——见 `examples/codex-claude-loop.js`。

其他内置适配器带有以下权限参数。每个参数允许什么，由对应的 CLI 决定：

| 内置适配器 | 权限参数 |
| --- | --- |
| `gemini` | `--approval-mode auto_edit` |
| `qwen` | `--approval-mode auto-edit` |
| `kimi` | 无(`odw init` 显示 `no permission flags found; behavior not verified`) |
| `omp` | `--approval-mode yolo` |
| `kilo`、`opencode` | `--auto` |
| `cursor` | `--force --trust` |

## 配置文件

要改默认、调参，或加自己的 CLI，写一个 `odw.config.json`。它按优先级从高到低被发现：

1. 显式的 `--config <path>`
2. `$ODW_CONFIG`
3. `./odw.config.json`
4. `~/.config/odw/config.json`

用户文件会合并覆盖在内置之上，所以你只需写你要改的部分。

```json
{
  "defaultAdapter": "claude",
  "concurrency": 8,
  "maxAgents": 1000,
  "timeout": 1800,
  "schemaRetries": 2,
  "runsRoot": "~/.odw/runs",

  "adapters": {
    "my_wrapper": {
      "label": "My custom CLI",
      "command": ["my-agent", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"],
      "env": { "MY_FLAG": "1" },
      "timeout": 600,
      "flags": { "model": ["--model"] }
    }
  }
}
```

所有设置项都是**顶层键**——不要嵌套在 `"settings"` 包装层下。odw 会对未知或放错位置
的键在 stderr 上给出警告（附 did-you-mean 提示），而不是静默忽略。

### 设置项

| 键 | 含义 |
| --- | --- |
| `defaultAdapter` | 一次调用没指名适配器时用的适配器。未设置时：用唯一配置的那个，或——全新安装下——用唯一能运行的那个 CLI：它在 PATH 上，并且在 Windows 上 `odw` 能启动它 |
| `concurrency` | 同时运行的 agent CLI 上限；省略则自动（`min(16, cpus-2)`） |
| `maxAgents` | 单次运行总派发量的硬上限（防失控兜底） |
| `timeout` | 每个 agent CLI 的超时（秒） |
| `schemaRetries` | schema 校验失败时的额外重试次数 |
| `runsRoot` | run 的存放位置（默认 `~/.odw/runs`） |
| `workflowsRoot` | 按名字解析 workflow 的目录（默认 `~/.odw/workflows`） |
| `claudeWorkflowsRoot` | 读取 Claude Code 已保存 workflow 的目录（默认 `~/.claude/workflows`，遵循 `CLAUDE_CONFIG_DIR`） |
| `claudeJobsScope` | dashboard 显示哪些 Claude Code 运行：`"all"`（默认）或 `"project"` |
| `envPolicy` | 每个 agent CLI 和 Chat Host 的 Codex 能获得 `odw` 的哪些环境变量。默认：`{ "mode": "inherit" }`。见[环境策略](#环境策略) |

### 适配器字段

| 字段 | 含义 |
| --- | --- |
| `command` | 参数向量；`{placeholder}` 占位符每次调用时展开（必填） |
| `stdin` | 喂给进程 stdin 的可选模板（如 `"{prompt}"`） |
| `env` | 额外的环境变量。它们在 `envPolicy` 之后生效，并替换同名的继承变量 |
| `envPolicy` | 该适配器自己的环境策略。它会替换该适配器的顶层 `envPolicy`。见[环境策略](#环境策略) |
| `timeout` | 每次调用的超时（秒）（覆盖运行级的 `timeout`） |
| `label` | 进度显示用的友好名字 |
| `flags` | 能力声明，如 `{ "model": ["--model"] }`——承载每次调用 `model` 的原生旗标。不声明它，`agent(..., { model })` 对该适配器就不生效（日志里会出现一条路由说明） |

### 环境策略

默认情况下，agent CLI 会获得 `odw` 进程的完整环境变量，包括其中的所有机密。`envPolicy`
控制 CLI 获得哪些变量。在顶层设置它，对每个 agent CLI 生效。Chat Host 的 Codex 只使用顶层
策略。适配器可以设置自己的 `envPolicy`，它会替换该适配器的顶层策略。

| `mode` | 另一个键 | CLI 获得 |
| --- | --- | --- |
| `inherit`（默认） | `deny`：要删除的变量名（可选） | 除 `deny` 中的名字外的所有变量 |
| `allowlist` | `allow`：要传递的变量名（必填） | 只有 `allow` 中列出的变量 |

- 适配器的 `env` 值在策略之后生效。它们可以新增变量，也可以替换变量。
- `odw` 自己不添加任何变量。`odw` 只用自己的 `PATH` 查找可执行文件，所以删除 `PATH` 的策略不会
  让可执行文件找不到。适配器 `env` 里的 `PATH` 不影响查找：只在该 `PATH` 中才有的命令，会以退出码
  127 启动失败。如果 CLI 自己需要 `PATH`，它仍可能失败。
- 在 Windows 上，变量名不区分大小写：`Path` 和 `PATH` 是同一个名字。在其他系统上，区分
  大小写。
- 在 Windows 上，Node.js 会给缺少这些变量的子进程补上 `PATH`、`SystemRoot`、`TEMP`、
  `USERPROFILE` 和其他几个系统变量。任何策略都无法删除它们。
- 错误的 `envPolicy` 会让 `odw` 以配置错误停止。例如未知的键、`inherit` 搭配 `allow`，
  以及不是非空字符串的名字。

在共享主机上，请使用 `allowlist`。大多数 CLI 需要 `PATH`、一个主目录变量（`HOME` 或
`USERPROFILE`）和它们自己的认证变量。在 Windows 上，它们还需要 `SystemRoot`、`TEMP` 和
`TMP`。下面的策略只传递这些变量。请加入你所用每个 CLI 的认证变量：

```json
{
  "envPolicy": {
    "mode": "allowlist",
    "allow": ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "OPENAI_API_KEY"]
  }
}
```

过滤不能保护凭据文件。能读取你主目录中凭据文件的 CLI 仍然会读取它。要隔离 CLI，请使用
操作系统账户、容器或虚拟机。

### 占位符

每次调用前在 `command` 和 `stdin` 里展开：

| 占位符 | 值 |
| --- | --- |
| `{prompt}` | 完整拼好的 prompt（独立性引导语 + 任务 + 任何 schema 指令） |
| `{prompt_file}` | 存放 prompt 的临时文件路径（仅在被引用时才写） |
| `{workspace}` | agent 运行所在的目录：源目录；调用设置了 `isolation: "worktree"` 时是一个临时 git worktree |
| `{source}` | 原始的工作树 |
| `{adapter}` / `{role}` | 适配器的名字 / 标签 |

只要一个 CLI 能读取 prompt（经 stdin 或一个参数）并把回复打印到 stdout，它就能接入。非零
退出、超时，或可执行文件缺失，都会表现为一次失败的 agent 调用。

### Windows 启动器

在 Windows 上，`odw` 用 `PATH` 和 `PATHEXT` 解析 `command` 的第一个词元。这两个变量取自 `odw`
自己的进程环境，而不是适配器的 `env`（见[环境策略](#环境策略)），`odw init` 也在同一位置查找。
读取这两个名字时不区分大小写，与 Windows 一致。
然后 `odw` 不经过 shell 直接启动解析结果。结果的类型决定行为：

- 原生 `.exe` 或 `.com` 文件直接运行。
- 启动 Node 的 npm shim 以 `node <脚本>` 方式运行。npm shim 是 `npm install -g` 创建的
  `.cmd` 文件。只有扩展名是 `.cmd`（不区分大小写），且整个文件内容都是 npm 会写出的内容时，
  `odw` 才把它当作 npm shim。做了更多事的文件（例如设置了 `NODE_PATH`）不是 npm shim。
  `odw` 使用 shim 旁边的 `node.exe`，没有时使用 `PATH` 上的 `node.exe`。参数和 stdin
  原样送达。
- 其他 `.cmd` 启动器会以退出码 127 失败，其中包括启动 Node 以外程序的 npm shim。`.bat`
  文件无论内容是什么也会失败，因为 npm 不会写出 `.bat` shim。错误信息会指出该文件。请把
  `command` 设为真正的可执行文件，或设为明确的解释器。
- 其他任何文件也会以退出码 127 失败，包括 `.ps1`、`.js` 之类的脚本，以及没有扩展名的文件。
  Windows 不能直接启动脚本。请把 `command` 设为解释器加脚本，例如 `["node", "agent.js"]`。

`odw` 无法运行的启动器或脚本视为未安装。`odw init` 会在表格中显示原因。零配置的默认值绝不会
选择带有这种启动器或脚本的适配器。

Cursor 的 Windows 启动器 `agent.cmd` 会运行一个 PowerShell 脚本。`odw` 不能直接运行它，
请自己调用 PowerShell。下面的覆盖配置与 Cursor 自己的 `agent.cmd` 做法一致：

```json
{
  "adapters": {
    "cursor": {
      "command": ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                  "C:\\Users\\<you>\\AppData\\Local\\cursor-agent\\cursor-agent.ps1",
                  "--print", "--force", "--trust", "--output-format", "text", "--workspace", "{workspace}"],
      "stdin": "{prompt}",
      "flags": { "model": ["--model"] }
    }
  }
}
```

Windows PowerShell 5.1 在脚本把参数传给程序时，会丢掉内嵌的 `"` 字符和空参数。
prompt 走 stdin，所以这一限制不影响 prompt。
