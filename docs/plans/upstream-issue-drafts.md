# Upstream issue drafts

Drafts for `xz1220/open-dynamic-workflows`. Not filed yet.

## 1. Let users keep secrets out of agent CLI environments

**Problem**

- Every agent CLI that odw starts gets the whole environment of `odw`: cloud
  credentials, `GITHUB_TOKEN`, and other vendors' API keys.
- The built-in adapters auto-approve tool use, and research workflows read web
  content. A prompt-injected agent can read those variables and send them out,
  with no human in the loop.
- One workflow starts CLIs from several vendors, and each one gets every
  vendor's keys.

**Why odw is the right place**

- odw starts every agent, on every platform, and builds its environment. A
  harness can filter what it passes to its own tools, but its own process
  already holds every variable.
- Harness filters are partial. Codex's `shell_environment_policy` covers the
  shell commands that Codex runs, not the Codex process. The other built-ins
  document no such filter.
- The workarounds are weak: `env -u NAME` in `command` works on POSIX only, and
  starting odw from a clean shell removes everything or nothing.

**Proposal**

Let an adapter's existing `env` map take a boolean as well as a string:

| Value | Meaning |
| --- | --- |
| `"text"` | Set the variable (today's behavior). |
| `false` | Do not pass the variable. |
| `true` | Pass the host value. Useful only with `"*": false`. |

The key `"*"` sets the default for every variable that is not listed. It is
`true` unless set:

```jsonc
// Remove two secrets, pass the rest:
"env": { "AWS_SECRET_ACCESS_KEY": false, "GITHUB_TOKEN": false }
// Pass only what the CLI needs:
"env": { "*": false, "PATH": true, "HOME": true, "ANTHROPIC_API_KEY": true }
```

- It extends an existing field. No new config key, and existing configs keep
  working: every value in them is a string.
- An exact name wins over `"*"`. On Windows, names match without case
  (`Path` = `PATH`).
- With `"*": false`, odw still finds the executable with its own `PATH`, so a
  short list does not stop the launch. The CLI itself may need more variables
  (for example `USERPROFILE`, `APPDATA`, `SystemRoot` on Windows), and the docs
  must say so.
- A top-level `env` with the same shape could set a default for all adapters
  later. It is not needed for the first step.
- Estimate: about 60 lines plus tests. A tested policy implementation exists
  on the fork (`hardening/integration`, commit `48e555e`), with the same
  semantics in a different shape.

## 2. Stricter permission defaults for the built-in adapters

The built-ins favor "works out of the box". This table shows what a
least-privilege default could look like. Each change needs a real run, because
an agent that cannot run commands can fail a workflow that needs tests or
builds.

| Built-in | Today | Stricter option | Status |
| --- | --- | --- | --- |
| `codex` | `--sandbox workspace-write` | Already sandboxed. `--sandbox read-only` for review-only roles. | Flags from `codex exec --help` |
| `claude` | `--permission-mode acceptEdits`, web tools allowed | No change: it cannot run commands. | Flags from `claude --help` |
| `omp` | `--approval-mode yolo` | `--approval-mode write` | `omp --help` lists `always-ask`, `write`, `yolo`. Behavior with `--print` not tested. |
| `cursor` | `--force --trust` | Add `--sandbox enabled`, or use `--auto-review` instead of `--force` | Flags from `agent --help`. Not tested. |
| `gemini`, `qwen` | `--approval-mode auto_edit` | Add `--sandbox` | CLI not installed here. To verify. |
| `kilo`, `opencode` | `--auto` | To research | CLI not installed here. |
| `kimi` | none | To research | CLI not installed here. |

Question for the maintainer: should the built-in defaults favor "works out of
the box" or "least privilege that still edits files"?
