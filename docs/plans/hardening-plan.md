# ODW HARDENING PLAN

## Goal

* Fork ODW into a production-ready, cross-harness dynamic workflow runtime.
* Preserve ODW’s Claude-style JavaScript workflow dialect.
* Add first-class support for:

  * Claude Code
  * OpenAI Codex
  * Cursor Agent CLI
  * OMP/Pi
  * OpenCode

## Priorities

1. Correct harness primitives.
2. Useful cross-harness workflow execution.
3. Production hardening.

## Non-goals

* Do not invent a new workflow language.
* Do not build a general LLM API framework first.
* Do not treat command templates as production-grade adapters.
* Do not claim copy/worktree isolation is a security sandbox.
* Do not silently downgrade permissions, schemas, events, or workspace mode.

---

# Phase 0 — Baseline and doctrine

## Deliverables

* `docs/compatibility-target.md`
* `docs/adapter-matrix.md`
* `docs/non-goals.md`
* `docs/threat-model.md`

## Keep

* Claude/ODW workflow dialect:

  * `export const meta`
  * top-level `await`
  * top-level `return`
  * injected `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`, `validate`
* ODW’s background run model.
* ODW’s existing examples and mock-adapter tests.

## Correct

* Current built-in adapters are command templates.
* Current adapter flags only model-select.
* Current runner inherits host env unless overridden.
* Current copy workspace mode protects the source tree, not the host.
* Current `AsyncFunction` loader is trusted-code execution, not sandboxing.

---

# Phase 1 — Adapter V2 contract

## Objective

* Define the runtime/harness boundary before changing functionality.

## Add

* `src/adapters/v2/types.ts`
* `src/adapters/v2/registry.ts`
* `src/adapters/v2/capabilities.ts`
* `src/adapters/v2/template-compat.ts`

## Core types

```ts
type PermissionMode =
  | "readOnly"
  | "workspaceWrite"
  | "dangerFullAccess";

type PromptTransport =
  | "argv"
  | "stdin"
  | "promptFile"
  | "jsonrpc"
  | "sdk"
  | "http";

type WorkspaceMode =
  | "copy"
  | "gitWorktree"
  | "inplace"
  | "external";

type SchemaMode =
  | "native"
  | "runtime"
  | "unsupported";

type EventMode =
  | "text"
  | "json"
  | "jsonl"
  | "rpc"
  | "sdk";

interface AdapterCapabilities {
  prompt: PromptTransport[];
  events: EventMode[];
  permissions: PermissionMode[];
  workspace: WorkspaceMode[];
  schema: SchemaMode;
  cancel: boolean;
  usage: boolean;
  fileEvents: boolean;
  toolEvents: boolean;
  sessions: boolean;
}

interface AgentInvocation {
  runId: string;
  stepId: string;
  prompt: string;
  cwd: string;
  adapterId: string;
  model?: string;
  agentType?: string;
  schema?: unknown;
  permissionMode: PermissionMode;
  workspaceMode: WorkspaceMode;
  timeoutMs: number;
  env: Record<string, string>;
  files?: string[];
}

interface AgentEvent {
  type:
    | "started"
    | "partial"
    | "text"
    | "tool_started"
    | "tool_finished"
    | "file_changed"
    | "usage"
    | "warning"
    | "error"
    | "completed";
  runId: string;
  stepId: string;
  adapterId: string;
  ts: string;
  data: unknown;
}

interface AgentResult {
  text: string;
  structured?: unknown;
  usage?: unknown;
  diff?: string;
  filesChanged?: string[];
  raw?: unknown;
}

interface AgentAdapterV2 {
  id: string;
  detect(): Promise<AdapterDetection>;
  capabilities(): Promise<AdapterCapabilities>;
  run(input: AgentInvocation): AsyncIterable<AgentEvent>;
  cancel(runId: string, stepId: string): Promise<void>;
}
```

## Rules

* Capability mismatch fails by default.
* Downgrade requires `allowDowngrade: true`.
* V1 command templates remain as compatibility only.
* Required harnesses must be V2 adapters.

## Tests

* Type-level tests for adapter contracts.
* Unit tests for downgrade/fail behavior.
* Snapshot tests for capability matrix output.

---

# Phase 2 — Runner V2

## Objective

* Make subprocess execution reusable, streamable, cancellable, and safer.

## Add

* `src/process/runner.ts`
* `src/process/env-policy.ts`
* `src/process/tree-kill.ts`
* `src/process/stream-json.ts`
* `src/process/prompt-file.ts`

## Features

* Stream stdout/stderr incrementally.
* Emit structured process events.
* Kill process tree, not only parent process.
* Bound output bytes.
* Support prompt via:

  * argv
  * stdin
  * temp prompt file
* Support env allowlist.
* Support per-run temp `HOME`.
* Support timeout and cancellation.

## Env policy

Default trusted mode:

* Preserve current behavior.

Default hardened mode:

* Start from empty env.
* Allow:

  * `PATH`
  * harness auth vars explicitly configured
  * provider vars explicitly configured
* Deny by default:

  * `SSH_AUTH_SOCK`
  * `GITHUB_TOKEN`
  * cloud creds
  * npm tokens
  * Docker socket vars
  * arbitrary `.env`

## Tests

* Timeout kills descendants.
* Output cap kills process.
* Env allowlist works.
* Prompt file cleanup works.
* Stdin EPIPE does not crash runtime.
* Cross-platform process behavior tested with fixtures.

---

# Phase 3 — First-class adapters

## Objective

* Implement real harness integrations.

## 3.1 Codex

File:

* `src/adapters/v2/codex/`

Use:

* `codex exec`
* `--cd`
* `--sandbox`
* `--json`
* `--output-last-message`
* `--output-schema` when schema is supplied
* `-` for stdin prompt
* `--ephemeral` by default unless persistence requested

Permission mapping:

* `readOnly` -> `--sandbox read-only --ask-for-approval never`
* `workspaceWrite` -> `--sandbox workspace-write`
* `dangerFullAccess` -> reject unless `allowDangerFullAccess`

Later:

* Add `codex app-server` adapter for long-lived sessions and richer events.

Tests:

* JSONL parsing.
* Native schema.
* Sandbox flag mapping.
* Final-message file handling.
* Nonzero exit with usable JSON events.

## 3.2 Claude Code

File:

* `src/adapters/v2/claude/`

Use:

* `claude --bare -p`
* `--output-format stream-json` when possible
* `--output-format json` fallback
* explicit `--allowedTools`
* explicit `--permission-mode`

Permission mapping:

* `readOnly` -> allow read/search tools only.
* `workspaceWrite` -> `acceptEdits` plus constrained tools.
* `dangerFullAccess` -> reject unless outer isolation is enabled.

Notes:

* Keep native Claude Workflow passthrough separate.
* ODW-hosted Claude adapter should treat Claude as a worker, not as the workflow runtime.

Tests:

* JSON/stream-json parsing.
* `--bare` default.
* Permission flag mapping.
* Background task timeout handling.

## 3.3 OpenCode

File:

* `src/adapters/v2/opencode/`

Use:

* `opencode run`
* `--dir`
* `--format json`
* `--model`
* `--agent`
* `--auto` only for write mode
* `--attach` when using a running server

Permission mapping:

* `readOnly` -> `--agent plan` or generated config with write tools denied.
* `workspaceWrite` -> `--agent build` or configured agent with edit/write allowed.
* `dangerFullAccess` -> reject unless outer isolation is enabled.

Later:

* Add SDK/server adapter with `@opencode-ai/sdk`.

Tests:

* JSON event parsing.
* `plan` vs `build` behavior.
* Auto-approval gating.
* Attached-server mode.

## 3.4 OMP/Pi

File:

* `src/adapters/v2/omp/`

Preferred order:

1. Node SDK.
2. `omp --mode rpc --no-session`.
3. `omp -p` fallback.

Use RPC for:

* typed events
* cancellation
* model selection
* session control

Permission mapping:

* Prefer OMP-native tool selection / permission config.
* Fallback to prompt-level constraints only as degraded mode.

Tests:

* SDK adapter with fake session.
* RPC adapter with fixture frames.
* Abort command.
* Typed result extraction.

## 3.5 Cursor

File:

* `src/adapters/v2/cursor/`

Status:

* Experimental until conformance passes.

Use:

* `cursor-agent` or `agent`, discovered locally.
* Parse `--help` and `--version`.
* Detect:

  * print/headless flag
  * workspace flag
  * output format flags
  * model flag
  * write/force/trust flags

Rules:

* Do not assume stable flags.
* Do not claim native schema unless proven.
* Treat nonzero exit with parsable success markers as adapter-specific warning, not immediate hard fail.
* Require strict timeout and process-tree kill.

Tests:

* Help-output fixtures.
* Stream JSON parsing fixtures.
* Known bad exit-code fixture.
* Schema fallback through runtime validator.

---

# Phase 4 — Adapter conformance suite

## Objective

* Make compatibility measurable.

## Add

* `src/conformance/`
* `odw adapters doctor`
* `odw adapters conformance --adapter <id>`
* `docs/adapter-matrix.md` generated from test metadata

## Required checks

* `detect`
* `echo`
* `largePrompt`
* `readOnly`
* `workspaceWrite`
* `schema`
* `events`
* `usage`
* `timeout`
* `cancel`
* `noSecrets`
* `workspaceIsolation`
* `diffCapture`
* `unsupportedCapabilityFails`

## Rules

* Local live tests are opt-in.
* CI uses mock binaries and event fixtures.
* Each adapter owns:

  * `detect.ts`
  * `command.ts`
  * `parse.ts`
  * `permissions.ts`
  * `fixtures/`
  * `*.test.ts`

## Acceptance

* No adapter marked `firstClass` without conformance.
* Matrix is generated, not manually edited.
* Failures show missing capability and fix path.

---

# Phase 5 — Workflow functionality

## Objective

* Execute useful workflows across harnesses.

## Extend `agent()` options

```ts
interface AgentOptionsV2 {
  adapter?: string;
  model?: string;
  agentType?: string;
  permissionMode?: PermissionMode;
  workspaceMode?: WorkspaceMode;
  schema?: unknown;
  timeoutMs?: number;
  files?: string[];
  requireCapabilities?: Partial<AdapterCapabilities>;
  allowDowngrade?: boolean;
}
```

## Add role presets

* `analyze`

  * read-only
  * no writes
* `implement`

  * workspace write
  * isolated workspace
* `verify`

  * read-only by default
  * write only for generated fixtures
* `review`

  * read-only
  * schema encouraged
* `research`

  * network allowed only by policy
* `judge`

  * no writes
  * schema required

## Add routing

* `explicit`
* `firstAvailable`
* `roleBased`
* `fallback`
* `roundRobin`
* `costAware` later, only after real usage data

## Examples

* `examples/repo-audit.js`
* `examples/refactor-review-loop.js`
* `examples/test-fix-loop.js`
* `examples/adversarial-review.js`
* `examples/research-cross-check.js`
* `examples/migration-plan.js`

## Acceptance

* Same example runs with:

  * Codex
  * Claude
  * OpenCode
* Cursor and OMP added after conformance.
* Outputs are structurally comparable.
* Harness differences are logged.

---

# Phase 6 — Schema and result handling

## Objective

* Use native schema where available; fallback consistently.

## Modes

* `native`

  * adapter validates final shape.
* `runtime`

  * ODW extracts JSON and validates.
* `unsupported`

  * rejected when schema is required.

## Rules

* Codex uses native `--output-schema` when available.
* Claude uses JSON/stream-json plus runtime validation unless native schema is confirmed.
* OpenCode uses JSON events plus runtime validation.
* OMP uses SDK/RPC typed results if available; else runtime validation.
* Cursor uses runtime validation unless native schema is confirmed.

## Tests

* Valid first result.
* Invalid then valid.
* Invalid until retries exhausted.
* Null JSON is valid only if schema permits.
* Free-text contamination is handled.

---

# Phase 7 — Workspace isolation

## Objective

* Improve edit isolation before security isolation.

## Modes

* `copy`

  * current default
  * safe from accidental source-tree mutation
  * not a security boundary
* `gitWorktree`

  * preferred for large repos and parallel edits
  * preserves Git-native diffs
* `inplace`

  * explicit opt-in
  * warn unless `--yes`
* `external`

  * caller supplies already-isolated directory

## Add

* `src/workspace/git-worktree.ts`
* `src/workspace/copy.ts`
* `src/workspace/diff.ts`
* `src/workspace/merge.ts`

## Tests

* Symlinks cannot escape snapshot/diff.
* Large files skipped safely.
* Worktree cleanup.
* Dirty tree behavior.
* Parallel worktrees do not collide.
* Diff is stable and sorted.

---

# Phase 8 — Events, inspection, and reports

## Objective

* Make runs debuggable without rerunning.

## Normalize events

* `run_started`
* `phase_started`
* `agent_started`
* `agent_partial`
* `agent_tool_started`
* `agent_tool_finished`
* `agent_file_changed`
* `agent_usage`
* `agent_warning`
* `agent_finished`
* `agent_failed`
* `run_finished`

## Commands

* `odw inspect <runId>`
* `odw tail <runId>`
* `odw events <runId>`
* `odw artifacts <runId>`
* `odw report <runId> --format markdown|json`

## Report includes

* workflow
* args
* git commit
* adapter/model per step
* permissions
* workspace mode
* changed files
* diff
* usage
* retries
* downgrades
* warnings
* failures

## Tests

* Event stream survives partial/torn JSONL line.
* Report stable snapshot.
* Raw adapter events preserved.

---

# Phase 9 — Durable resume

## Objective

* Resume long workflows without relying on process memory.

## Add SQLite store

Tables:

* `runs`
* `steps`
* `events`
* `artifacts`
* `adapter_invocations`
* `leases`
* `approvals`

## Step key

Hash:

* workflow source hash
* agent call index/path
* prompt hash
* adapter ID
* model
* permission mode
* workspace mode
* schema hash
* relevant args hash

## MVP resume

* Restart coordinator from top.
* Completed matching steps return cached result.
* Failed/cancelled/timed-out steps rerun.
* Changed inputs invalidate cache.
* Cache hits are logged.

## Tests

* Crash after N steps.
* Resume skips completed steps.
* Changed prompt invalidates one step.
* Pause/resume survives worker restart.

---

# Phase 10 — Coordinator isolation

## Objective

* Reduce risk from generated workflow code.

## Modes

* `trusted`

  * current `AsyncFunction` behavior
  * default for local trusted scripts
* `isolated`

  * separate process
  * empty env
  * no direct fs
  * no direct network
  * no shell
  * primitives only through IPC

## Static checks

Reject or warn on:

* imports
* dynamic import
* `require`
* `process`
* `fs`
* `child_process`
* network globals
* `Date.now`
* `Math.random`
* arg-less `new Date`

## Tests

* Cannot read arbitrary host file.
* Cannot access env.
* Cannot spawn shell.
* Cannot open network.
* Can still call injected primitives.

---

# Phase 11 — Outer security hardening

## Objective

* Make unattended execution less dangerous.

## Add policy file

* `odw.policy.json`

## Policy fields

* env allowlist
* denied env
* network mode:

  * inherit
  * deny
  * allowlist
  * proxy
* writable roots
* readable roots
* max runtime
* max agents
* max output bytes
* max workspace bytes
* dangerous mode allowed:

  * true/false

## Commands

* `odw doctor security`
* `odw plan workflow.js`

## `odw plan` output

* agents expected
* adapters
* models
* permissions
* workspace modes
* network policy
* env exposure
* unsupported capabilities
* dangerous flags

## Tests

* Policy deny works.
* Dangerous mode requires explicit override.
* Network policy visible even if not enforceable on host.
* Security doctor flags SSH agent, Docker socket, cloud creds.

---

# Phase 12 — Docs and agent handoff

## Objective

* Let another agent work safely and incrementally.

## Add docs

* `AGENTS.md`
* `docs/architecture.md`
* `docs/adapter-contract.md`
* `docs/conformance.md`
* `docs/permissions.md`
* `docs/workspaces.md`
* `docs/security.md`
* `docs/harnesses/codex.md`
* `docs/harnesses/claude.md`
* `docs/harnesses/cursor.md`
* `docs/harnesses/omp.md`
* `docs/harnesses/opencode.md`

## AGENTS.md rules

* Use TypeScript, strict mode.
* Keep modules small.
* Prefer pure functions around parsing/planning.
* Keep side effects at runner/adapter boundaries.
* Add tests before changing behavior.
* Use fixtures for harness output.
* Do not hit real CLIs in unit tests.
* Add live tests behind env flags.
* Document every downgrade.
* Keep prose concise and decision-focused.

## Code structure rule

Adapter folders:

```text
src/adapters/v2/<adapter>/
  index.ts
  detect.ts
  command.ts
  parse.ts
  permissions.ts
  capabilities.ts
  fixtures/
  *.test.ts
```

Shared helpers:

```text
src/process/
src/schema/
src/workspace/
src/conformance/
src/events/
src/policy/
```

---

# First PR sequence

## PR 1 — Docs and contracts

* Add compatibility docs.
* Add threat model.
* Add Adapter V2 types.
* No behavior change.

## PR 2 — Runner V2

* Streaming runner.
* Env policy.
* Prompt file helper.
* Process-tree kill.
* Tests only with local fixture commands.

## PR 3 — Template adapter wrapper

* Wrap V1 adapters as V2 compatibility adapters.
* Mark as `templateOnly`.

## PR 4 — Adapter doctor

* Detect binaries.
* Print versions.
* Print capability matrix.

## PR 5 — Codex V2

* Native schema.
* JSONL parsing.
* Sandbox mapping.
* Conformance fixtures.

## PR 6 — Claude V2

* Bare mode.
* JSON/stream-json parsing.
* Permission mapping.
* Conformance fixtures.

## PR 7 — OpenCode V2

* JSON event parsing.
* Agent/model/dir/auto mapping.
* Optional server attach.

## PR 8 — Conformance CLI

* `odw adapters conformance`.
* Mock binary framework.
* Matrix generation.

## PR 9 — OMP V2

* SDK or RPC path.
* One-shot fallback only as degraded mode.

## PR 10 — Cursor V2 experimental

* Help-driven detection.
* Stream parsing fixtures.
* Strict timeout and warnings.

## PR 11 — Workflow options V2

* Permission mode.
* Workspace mode.
* Required capabilities.
* Downgrade policy.

## PR 12 — Examples

* Cross-harness repo audit.
* Refactor-review loop.
* Test-fix loop.

## PR 13 — Worktree mode

* Git worktree isolation.
* Stable diff capture.
* Cleanup.

## PR 14 — Inspect/report

* Normalized events.
* Markdown/JSON report.

## PR 15 — SQLite resume

* Step cache.
* Resume command.
* Crash tests.

## PR 16 — Coordinator isolation

* Isolated process mode.
* IPC primitives.
* Static checks.

## PR 17 — Security doctor

* Env/network/workspace audit.
* Policy file.
* `odw plan`.

---

# Release gates

## Alpha

* Adapter V2.
* Runner V2.
* Codex, Claude, OpenCode pass conformance.
* Cursor and OMP experimental.
* Useful examples run on three harnesses.
* No silent downgrades.

## Beta

* All five required adapters pass conformance.
* Worktree mode.
* Normalized event reports.
* Security doctor.
* Basic SQLite resume.

## 1.0

* Hardened coordinator mode.
* Durable resume.
* Policy file.
* Cross-harness CI fixtures.
* Live adapter smoke tests documented.
* Security limitations documented.
* AGENTS.md stable enough for autonomous contributors.

---

# Central bet

* Keep ODW’s language.
* Replace weak seams:

  * adapter templates
  * inherited env
  * stdout-only parsing
  * copy-only isolation
  * file-only run state
* Build small, tested modules around:

  * detection
  * command planning
  * event parsing
  * permission mapping
  * workspace management
  * durable steps

The fork succeeds if the same workflow can run on Claude Code, Codex, Cursor, OMP/Pi, and OpenCode with visible capability differences and no hidden safety downgrade.
