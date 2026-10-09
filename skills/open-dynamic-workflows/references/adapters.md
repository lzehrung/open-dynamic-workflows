# Adapters & configuration

An **adapter** is how `odw` invokes one coding-agent CLI. `odw` never calls model
APIs directly — it only shells out to a local command, passing the composed
prompt via stdin or an argument and reading the reply from stdout.

## Built-in adapters

Five ship out of the box, usable with no config file: `codex`, `claude`,
`gemini`, `qwen`, `kimi`. They use each CLI's non-interactive mode.

### Permissions: what each built-in may do

The templates are intentionally conservative, and the built-ins are **not**
equally privileged:

- `codex` runs with `--sandbox workspace-write`: it can **edit files and run
  commands** inside its workspace out of the box. It also carries `--search`,
  so it can **search the web** natively.
- `claude` runs with `--permission-mode acceptEdits` plus
  `--allowedTools WebSearch WebFetch`: it can **edit files and use the web**,
  but **not run commands** (a prompt that asks it to execute something will
  stall or be refused). The web allowlist matters: headless acceptEdits
  silently denies WebSearch/WebFetch otherwise, which breaks research
  workflows like `examples/deep-research.js`. To let Claude run commands too, override the adapter with
  `--dangerously-skip-permissions` — which has **no sandbox**, so do that only
  against a throwaway `--source` directory, never your real repo:

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

A useful minimal-privilege split: let `claude` write code (acceptEdits) and let
`codex` run/verify it (workspace-write sandbox) — see
`examples/codex-claude-loop.js`.

## Config file

To change the default, tune flags, or add your own CLI, write an
`odw.config.json`. It is discovered, highest priority first:

1. an explicit `--config <path>`
2. `$ODW_CONFIG`
3. `./odw.config.json`
4. `~/.config/odw/config.json`

A user file is merged over the built-ins, so you only specify what you change.

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

All settings are **top-level keys** — do not nest them under a `"settings"`
wrapper. odw warns on stderr about unknown or misplaced keys (with a
did-you-mean hint) instead of silently ignoring them.

### Settings

| Key | Meaning |
| --- | --- |
| `defaultAdapter` | adapter used when a call does not name one. Unset: the sole configured adapter, or — on a fresh install — the sole adapter whose CLI can run: it is on PATH, and on Windows `odw` can launch it |
| `concurrency` | max agent CLIs running at once; omit for auto (`min(16, cpus-2)`) |
| `maxAgents` | hard cap on total dispatches per run (runaway guard) |
| `timeout` | per-agent CLI timeout in seconds |
| `schemaRetries` | extra attempts when a schema fails to validate |
| `runsRoot` | where runs are stored (default `~/.odw/runs`) |
| `workflowsRoot` | where workflows are resolved by name (default `~/.odw/workflows`) |
| `claudeWorkflowsRoot` | where Claude Code saved workflows are picked up (default `~/.claude/workflows`, honors `CLAUDE_CONFIG_DIR`) |
| `claudeJobsScope` | which Claude Code runs the dashboard shows: `"all"` (default) or `"project"` |

### Adapter fields

| Field | Meaning |
| --- | --- |
| `command` | argument vector; `{placeholder}` tokens are expanded per call (required) |
| `stdin` | optional template fed to the process's stdin (e.g. `"{prompt}"`) |
| `env` | extra environment variables layered over the process environment |
| `timeout` | per-call timeout in seconds (overrides the run-wide `timeout`) |
| `label` | human-friendly name for progress display |
| `flags` | capability declaration, e.g. `{ "model": ["--model"] }` — the native flag that carries a per-call `model`. Without it, `agent(..., { model })` is not honored for this adapter (a routing note appears in the logs) |

### Placeholders

Expanded in `command` and `stdin` before each call:

| Token | Value |
| --- | --- |
| `{prompt}` | the full composed prompt (independence framing + task + any schema instruction) |
| `{prompt_file}` | path to a temp file holding the prompt (written only when referenced) |
| `{workspace}` | the directory the agent runs in (an isolated copy in `copy` mode) |
| `{source}` | the original working tree |
| `{adapter}` / `{role}` | the adapter's name / label |

A CLI fits as long as it reads a prompt (via stdin or an argument) and prints its
reply to stdout. Non-zero exit, a timeout, or a missing executable surface as a
failed agent call.

### Windows launchers

On Windows, `odw` resolves the first `command` token with `PATH` and `PATHEXT`.
It reads them from the environment that the CLI gets: the process environment
with the adapter's `env` on top. So an `env.PATH` in the adapter changes where
`odw` looks, and `odw init` looks in the same place. `odw` reads both names in
any letter case, as Windows does. It starts the result without a shell. The
result decides what happens:

- A native `.exe` or `.com` file runs directly.
- An npm shim that starts Node runs as `node <script>`. An npm shim is a `.cmd`
  file that `npm install -g` creates. `odw` accepts a file as an npm shim only
  when its extension is `.cmd`, in any letter case, and its whole text is one
  that npm writes. A file that does more, for example one that sets
  `NODE_PATH`, is not an npm shim. `odw` runs the `node.exe` next to the shim,
  or else the `node.exe` on `PATH`. Arguments and stdin arrive unchanged.
- Any other `.cmd` launcher fails with exit code 127. This includes an npm shim
  that starts a program other than Node. A `.bat` file also fails, whatever its
  text, because npm does not write `.bat` shims. The error names the file. Set
  `command` to the real executable or to an explicit interpreter.
- Any other file fails with exit code 127. This includes a script, such as a
  `.ps1` or `.js` file, and a file with no extension. Windows cannot start a
  script directly. Set `command` to an interpreter and the script, for example
  `["node", "agent.js"]`.

A launcher or script that `odw` cannot run counts as not installed. `odw init`
shows the reason in its table. The zero-config default never picks an adapter
with such a launcher or script.

Cursor's Windows launcher, `agent.cmd`, runs a PowerShell script. `odw` cannot
run it as it is. Call PowerShell yourself. This override mirrors Cursor's own
`agent.cmd`:

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

Windows PowerShell 5.1 drops embedded `"` characters and empty arguments when a
script passes them to a program. The prompt goes on stdin, so this limit does
not affect the prompt.
