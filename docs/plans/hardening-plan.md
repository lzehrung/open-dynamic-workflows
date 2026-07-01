# ODW HARDENING PLAN

## Purpose

* Harden ODW without turning it into a different project.
* Preserve the current Claude-style workflow dialect.
* Add production-grade cross-harness execution for:

  * Claude Code
  * OpenAI Codex
  * Cursor Agent CLI
  * OMP/Pi
  * OpenCode
* Respect current repo constraints:

  * zero runtime npm dependencies
  * Node SEA binary packaging
  * Node >=20 unless explicitly changed
  * existing server and Tauri hardening
  * existing roadmap/docs unless this plan explicitly supersedes them

## Planning authority

* This plan supersedes only CLI/runtime/adapter hardening work.
* Existing GUI/Tauri roadmap remains valid unless a phase below explicitly changes it.
* First PR must reconcile:

  * `docs/ROADMAP.md`
  * `docs/tasks/launch.md`
  * `docs/tasks/gui.md`
  * `docs/tasks/cli.md`
  * `docs/dynamic-workflows-tech-plan.md`
  * this plan
* Add a short precedence note to each overlapping planning doc.

## Non-goals

* Do not invent a new workflow language.
* Do not replace existing working examples with near-duplicates.
* Do not add runtime dependencies unless packaging impact is explicitly accepted.
* Do not assume SQLite is available under Node 20 + SEA.
* Do not treat command templates as first-class harness support.
* Do not claim copy/worktree isolation is a security boundary.
* Do not silently downgrade permissions, schema behavior, event mode, or workspace mode.

---

# Phase 0 — Repo baseline and CI

## Objective

* Make the plan executable in the real repo.

## Add

* PR CI workflow:

  * `npm ci`
  * `npm run typecheck`
  * `npm test`
  * build smoke test if cheap
* `docs/plans/hardening-plan.md`
* `docs/plans/plan-precedence.md`
* `docs/architecture/current-baseline.md`
* `docs/compatibility-target.md`
* `docs/threat-model.md`

## `docs/compatibility-target.md` must define

* target harnesses: Claude Code, OpenAI Codex, Cursor Agent CLI, OMP/Pi, OpenCode
* what "first-class adapter" means
* what "experimental adapter" means
* required minimum behavior: detect, run, stream or capture output, timeout, cancel where possible, schema handling, permission mapping, env policy, workspace mode, result normalization

## `docs/threat-model.md` must define

* actors: trusted local user, malicious workflow source, malicious generated workflow, malicious prompt/input, hostile local web page targeting `odw serve`, compromised harness CLI
* attack surfaces: workflow loader, server API, desktop sidecar, subprocess runner, env inheritance, workspace mounts/copies, network access, adapter config
* mitigations: restricted trust mode, env policy, server guards, Tauri capabilities, workspace isolation, process limits, adapter conformance
* residual risks: copy/worktree is not a security boundary; harness CLIs may perform their own side effects; host OS sandboxing is not fully implemented in MVP; trusted mode remains unsafe for unreviewed workflow code

## Inventory existing strengths

Document, do not rebuild blindly:

* agent count cap
* budget hard ceiling
* output byte cap
* timeout kill behavior
* config linter warnings
* copy workspace isolation and symlink handling
* explicit per-call adapter routing
* existing adversarial/cross-adapter examples
* server mitigations:

  * loopback default
  * write guard
  * Host allowlist
  * body size caps
  * remote-write refusal
* Tauri least-privilege sidecar capability model

## Acceptance

* CI runs on PRs.
* Existing roadmap conflicts are documented.
* This plan is clearly scoped to runtime/adapter hardening.

---

# Phase 1 — Security-critical execution baseline

## Objective

* Address the riskiest existing behavior before expanding adapters.

## Problems

* Workflow code is trusted-code execution today.
* Server paths can submit generated or inline workflow source.
* Runner currently inherits host env.
* Current adapter env model can add vars, not subtract them.

## Add runtime modes

```ts
type RuntimeTrustMode = "trusted" | "restricted";
```

## Trusted mode

* Current behavior.
* Intended for local reviewed workflows.
* Preserve compatibility.

## Restricted mode

* Separate coordinator process.
* Empty env by default.
* No direct shell.
* No direct network.
* No direct arbitrary filesystem access.
* Injected workflow primitives communicate through IPC.
* Static checks reject or warn on:

  * `import`
  * dynamic `import`
  * `require`
  * `process`
  * `fs`
  * `child_process`
  * obvious network globals
  * nondeterministic APIs when replay is requested

## Activation

* Restricted mode must not ship "wired but inaccessible."
* Interim activation paths land as part of the restricted coordinator MVP (PR3).

CLI:

```bash
odw run workflow.js --trust-mode restricted
odw serve --default-trust-mode restricted
```

Config:

```json
{
  "runtime": { "trustMode": "trusted" },
  "server": { "defaultTrustMode": "restricted" }
}
```

Rules:

* CLI flag overrides config.
* Server default applies to generated/inline workflow submissions.
* Per-request trust mode is rejected unless server config explicitly allows overrides.
* Restricted mode may be MVP-limited, but must be callable and tested.

## Env policy migration

Current state:

* `Adapter.env?: Record<string, string>` exists.
* `odw.config.json` adapter env blocks are additive.
* Current runner inherits `process.env`.
* Existing config cannot subtract inherited variables.

New shape:

```ts
interface EnvPolicy {
  mode: "inherit" | "empty";
  allow?: string[];
  set?: Record<string, string>;
  deny?: string[];
}
```

Compatibility:

* Keep `Adapter.env` for one release cycle.
* Treat `Adapter.env` as legacy shorthand: `env: { FOO: "bar" }` means `envPolicy: { mode: "inherit", set: { FOO: "bar" } }`.

Example config:

```json
{
  "adapters": {
    "codex": {
      "command": "codex",
      "envPolicy": {
        "mode": "empty",
        "allow": ["PATH", "HOME"],
        "set": { "OPENAI_API_KEY": "${OPENAI_API_KEY}" },
        "deny": ["SSH_AUTH_SOCK", "GITHUB_TOKEN"]
      }
    }
  }
}
```

Rules:

* `envPolicy` wins over `env`.
* If both are present, warn.
* In trusted mode, legacy `env` keeps current behavior.
* In restricted mode, legacy `env` is rejected unless `--allow-legacy-env` is passed.
* Add `odw config migrate-env` to print the converted shape.
* Remove `Adapter.env` after one major release.

Tests:

* legacy env still works in trusted mode
* `envPolicy` overrides legacy env
* both fields present produces a warning
* restricted mode rejects legacy env
* migration output is stable

## Defaults

* trusted: `inherit`
* restricted: `empty`

## Acceptance

* Restricted workflow cannot read arbitrary env.
* Restricted workflow cannot spawn commands except through injected primitives.
* Existing workflows still run in trusted mode.
* Breaking config changes are documented.

---

# Phase 2 — Runner V2

## Objective

* Generalize existing runner safeguards into a reusable process layer.

## Add or refactor

* `src/process/runner.ts`
* `src/process/env-policy.ts`
* `src/process/prompt.ts`
* `src/process/kill.ts`
* `src/process/output-limit.ts`

## Preserve existing behavior

* output cap
* timeout kill
* stdout/stderr capture

## Improve

* process-tree cleanup where supported
* prompt via stdin
* prompt via temp file
* incremental stdout/stderr events
* structured exit result
* max output bytes per stream
* clear timeout/cancel distinction
* env allowlist/denylist support

## Tests

* timeout kills child process
* output cap works
* env empty mode works
* env deny removes inherited secret
* prompt file cleanup works
* stdin prompt works
* nonzero exit preserves partial output

---

# Phase 3 — Adapter V2 contract

## Objective

* Define a real harness boundary.

## Add

* `src/adapters/v2/types.ts`
* `src/adapters/v2/registry.ts`
* `src/adapters/v2/capabilities.ts`
* `src/adapters/v2/template-compat.ts`

## Types

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
  envPolicy: EnvPolicy;
  files?: string[];
}
```

## Important semantic rule

* `agentType` remains persona/task-shaping only.
* `adapter` selects harness.
* Do not reintroduce ambiguity between persona and adapter routing.

## Rules

* Capability mismatch fails by default.
* Downgrade requires explicit `allowDowngrade: true`.
* V1 command templates remain compatibility-only.
* Required harnesses must use V2 adapters.

---

# Phase 4 — Conformance harness before adapters

## Objective

* Avoid adapter work without a test target.

## Add

* `src/conformance/`
* mock binary framework
* adapter fixture format
* `odw adapters doctor`
* `odw adapters conformance --adapter <id>`

## Required checks

* detect
* echo
* large prompt
* read-only
* workspace write
* schema
* events
* usage
* timeout
* cancel
* no secrets
* workspace isolation
* diff capture
* unsupported capability fails

## Rules

* Unit tests use mock binaries and event fixtures.
* Live CLI tests are opt-in.
* Capability matrix is generated.
* No adapter becomes `firstClass` without conformance.
* `usage` may pass as real usage, explicit `estimated`, or explicit `unsupported`.
* `workspaceIsolation` may delegate to the Phase 8 implementation, but adapter conformance must still report whether isolation is runtime-owned, harness-owned, or unsupported.
* No capability can exist in `AdapterCapabilities` without a corresponding conformance check.

---

# Phase 5 — First-class adapters

## Objective

* Add useful cross-harness execution with minimal custom logic per adapter.

## Adapter structure

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

## Codex

* Use `codex exec`.
* Prefer stdin prompt.
* Use explicit `--cd`.
* Use explicit sandbox mode.
* Use JSON output where available.
* Use native schema output where available.
* Default to read-only unless workflow requests write.

## Claude Code

* Use scripted/headless mode.
* Prefer bare output mode.
* Prefer JSON or stream JSON when available.
* Use explicit allowed tools / permission mode.
* Map `dangerFullAccess` to the documented skip-permissions escape hatch only when:

  * user explicitly requests it
  * workspace is throwaway or externally isolated
  * warning is logged

## OpenCode

* Use non-interactive run mode.
* Prefer JSON event output.
* Map model, agent, dir, auto/write behavior explicitly.
* Add SDK/server mode later if it improves events or cancellation.

## OMP/Pi

* Prefer SDK or RPC.
* Use one-shot CLI only as degraded fallback.
* Preserve typed events and cancellation where possible.

## Cursor

* Experimental until conformance passes.
* Detect installed binary and flags from local help/version.
* Do not assume stable flags.
* Runtime schema validation unless native schema is proven.
* Strict timeout required.

---

# Phase 6 — Workflow API extensions

## Objective

* Add capability-aware options without breaking existing workflows.

## Extend `agent()`

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

## Existing behavior to preserve

* `agent(prompt, { adapter: "codex" })` already means explicit adapter routing.
* Existing routing examples remain valid.

## New routing only

* `firstAvailable`
* `roleBased`
* `fallback`
* `roundRobin`
* `costAware` later, after real usage data exists

## Role presets

* analyze: read-only
* implement: workspace write
* verify: read-only by default
* review: read-only, schema encouraged
* research: network only if policy allows
* judge: no writes, schema preferred

## Acceptance

* Existing workflows still run unchanged.
* Existing explicit adapter routing still works: `await agent("Review this file", { adapter: "codex" });`
* `agentType` remains persona/task shaping only.
* `adapter` remains harness selection only.
* Capability mismatch fails by default.
* `allowDowngrade: true` emits a visible warning.
* At least one example workflow runs on Codex, Claude Code, and OpenCode.
* The same workflow produces structurally comparable results across those three adapters.
* Harness-specific differences appear in the report, not hidden in free text.

---

# Phase 7 — Cross-harness examples and docs cleanup

## Objective

* Prove real end-user workflows run across harnesses.

## Keep / update

* `examples/codex-claude-loop.js`
* `examples/adversarial-verify.js`
* `examples/routing.js`

## Add only if distinct

* `examples/repo-audit.js`
* `examples/test-fix-loop.js`
* `examples/migration-plan.js`

## Avoid

* adding `adversarial-review.js` unless replacing/renaming existing adversarial examples

## Required cross-harness example

Add `examples/cross-harness-repo-audit.js`. Must support:

```bash
odw run examples/cross-harness-repo-audit.js --adapter codex
odw run examples/cross-harness-repo-audit.js --adapter claude
odw run examples/cross-harness-repo-audit.js --adapter opencode
```

Output contract:

```ts
interface RepoAuditResult {
  summary: string;
  findings: Array<{
    severity: "low" | "medium" | "high";
    file?: string;
    issue: string;
    rationale: string;
  }>;
  suggestedNextSteps: string[];
}
```

## Acceptance

* Same schema across all supported adapters.
* Adapter-specific differences captured in report.
* No adapter-specific prompt fork unless justified in docs.
* Cursor and OMP/Pi added after conformance.

## Docs

* `docs/harnesses/codex.md`
* `docs/harnesses/claude.md`
* `docs/harnesses/opencode.md`
* `docs/harnesses/omp.md`
* `docs/harnesses/cursor.md`
* `docs/conformance.md`
* `docs/adapter-contract.md`

---

# Phase 8 — Workspace isolation

## Objective

* Improve edit isolation.

## Modes

* copy

  * current default
  * not a security boundary
* gitWorktree

  * preferred for large repos and parallel edits
* inplace

  * explicit opt-in
  * warning unless `--yes`
* external

  * caller provides already-isolated workspace

## Add

* `src/workspace/git-worktree.ts`
* stable diff helpers
* cleanup helpers
* dirty-tree checks

## Tests

* worktree cleanup
* parallel worktrees do not collide
* dirty tree behavior is explicit
* symlinks cannot escape snapshot/diff
* diff output is stable

---

# Phase 9 — Events, inspection, and reports

## Objective

* Make failures debuggable without rerun.

## Normalize events

* run started / finished / failed
* phase started / finished
* agent started / partial / text
* tool started / finished
* file changed
* usage
* warning
* error
* completed

## Commands

* `odw inspect <runId>`
* `odw tail <runId>`
* `odw events <runId>`
* `odw artifacts <runId>`
* `odw report <runId> --format markdown|json`

`odw artifacts` lists: final result, structured results, diffs, logs, raw adapter event files, report files, and prompt files (if retained by policy).

## Report includes

* workflow
* args
* git commit
* adapter/model per step
* permission mode
* workspace mode
* changed files
* diff
* usage
* retries
* downgrades
* warnings
* failures

---

# Phase 10 — Durable resume, without breaking SEA

## Objective

* Add resume carefully under repo packaging constraints.

## Do not assume SQLite first

Options:

1. JSONL + index files

   * zero dependency
   * SEA-safe
   * Node 20-safe
   * preferred MVP
2. SQLite through `node:sqlite`

   * requires Node version decision
   * not Node 20-compatible
3. external SQLite/native addon

   * breaks zero-runtime-dependency goal
   * avoid unless project explicitly changes packaging model

## MVP

* Keep run directory as source of truth.
* Add durable step index file.
* Use atomic writes.
* Restart coordinator from top.
* Completed matching steps return cached results.
* Failed/cancelled/timed-out steps rerun.

## Step key

Hash:

* workflow source hash
* agent call path/index
* prompt hash
* adapter ID
* model
* permission mode
* workspace mode
* schema hash
* relevant args hash

## Acceptance

* crash after N steps can resume
* changed prompt invalidates only affected step
* no runtime dependency added
* SEA build still works

---

# Phase 11 — Server and desktop hardening

## Objective

* Include shipped attack surfaces.

## Server

Inventory and test existing mitigations:

* loopback binding default
* Host allowlist
* write guard
* Content-Type checks
* same-origin checks
* body size cap
* remote write refusal

Add tests for:

* DNS rebinding attempt
* cross-origin write attempt
* oversized body
* non-loopback write refusal
* inline workflow execution policy

## Desktop/Tauri

Inventory current capability model:

* sidecar spawn restriction
* validated sidecar args
* loopback-only remote URL scope

Add tests/checks where feasible:

* capability file regression test
* sidecar arg validation
* no broad shell spawn permission
* no broad remote URL permission

## Explicit out-of-scope option

* If desktop is not in scope for a release, state that in release notes.

---

# Phase 12 — Policy and planning commands

## Objective

* Make risk visible before execution.

## Add

* `odw.policy.json`
* `odw doctor security`
* `odw plan workflow.js`

## Policy fields

* runtime trust mode
* env policy
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
* dangerous mode allowed

## `odw plan` prints

* adapters
* models
* permissions
* workspace modes
* env exposure
* network mode
* unsupported capabilities
* dangerous flags
* server/desktop exposure notes where relevant

---

# Phase 13 — AGENTS.md

## Objective

* Guide future agents toward small, safe changes.

## Rules

* Use TypeScript strict mode.
* Keep modules small.
* Prefer pure parsing/planning functions.
* Keep side effects at runner, adapter, workspace, and server boundaries.
* Add tests before changing behavior.
* Use fixtures for harness output.
* Do not call real CLIs in unit tests.
* Put live tests behind env flags.
* Preserve zero-runtime-dependency and SEA constraints unless explicitly changed.
* Document every downgrade.
* Update plan-precedence docs when changing scope.
* Keep docs concise and decision-focused.

## Acceptance

* `AGENTS.md` exists.
* It states repo constraints: TypeScript strict mode, zero runtime dependencies, SEA packaging awareness, tests before behavior changes, fixture-based adapter tests, live CLI tests behind env flags, no silent downgrades, concise docs.
* It tells agents where to add code: adapters, process, workspace, conformance, policy, server, desktop.
* It names forbidden shortcuts: direct real CLI calls in unit tests, broad env inheritance in restricted mode, copy/worktree described as sandboxing, adapter command templates marked first-class.

---

# First PR sequence

## PR 1 — CI and plan reconciliation

* Add PR test/typecheck workflow.
* Add plan precedence docs.
* Add `docs/compatibility-target.md`.
* Add `docs/threat-model.md`.
* Reconcile current roadmap/task docs.
* Add current-baseline doc.

## PR 2 — Env policy and runner refactor

* Add `EnvPolicy`.
* Add legacy `Adapter.env` migration.
* Add `odw config migrate-env`.
* Preserve trusted default.
* Add restricted empty-env path.
* Generalize existing timeout/output cap behavior.
* Add runner/env tests.

## PR 3 — Restricted coordinator MVP

* Separate-process coordinator mode.
* IPC primitives.
* Static checks.
* `--trust-mode restricted`.
* `odw serve --default-trust-mode restricted`.
* Server execution policy hook.
* Tests for CLI and server activation.

Acceptance:

* `odw run --trust-mode restricted` works.
* `odw serve --default-trust-mode restricted` applies to API-created runs.
* Trusted remains default for backward compatibility.
* Server execution policy hook is tested.

## PR 4 — Adapter V2 contract

* Add V2 types.
* Add capability model.
* Add template compatibility wrapper.
* Preserve V1 behavior.

## PR 5 — Conformance framework

* Mock binaries.
* Fixture format.
* Usage check.
* Workspace isolation check.
* `odw adapters doctor`.
* `odw adapters conformance`.

## PR 6 — Codex V2

* Command builder.
* Parser.
* Permission mapping.
* Native schema when available.
* Conformance tests.

## PR 7 — Claude V2

* Command builder.
* Parser.
* Permission mapping.
* Explicit dangerous skip-permissions handling.
* Conformance tests.

## PR 8 — OpenCode V2

* JSON parser.
* Command builder.
* Permission mapping.
* Conformance tests.

## PR 9 — OMP/Pi V2

* SDK/RPC path.
* One-shot fallback as degraded mode.
* Conformance tests.

## PR 10 — Cursor V2 experimental

* Help-driven detection.
* Parser fixtures.
* Strict timeout behavior.
* Experimental conformance status.

## PR 11 — Workflow options V2

* Permission mode.
* Workspace mode.
* Required capabilities.
* Downgrade policy.
* Preserve `agentType` semantics.
* Cross-harness API acceptance tests.

## PR 12 — Cross-harness examples

* Add/update examples from Phase 7.
* Add `cross-harness-repo-audit`.
* Verify Codex/Claude/OpenCode runs.
* Cursor and OMP/Pi documented as pending until conformance.

## PR 13 — Worktree mode

* Git worktree workspace strategy.
* Stable diff and cleanup.

## PR 14 — Reports and inspection

* Normalized events.
* Inspect/tail/events/artifacts/report commands.

## PR 15 — Durable resume MVP

* JSONL/index-based step cache.
* Atomic writes.
* Resume command.
* Crash/resume tests.

## PR 16 — Server/Tauri hardening tests

* Server guard regression tests.
* Tauri capability regression checks.

## PR 17 — Policy and planning

* `odw.policy.json`
* `odw doctor security`
* `odw plan`

## PR 18 — AGENTS.md

* Autonomous contributor guide.
* Repo constraints.
* Testing rules.
* Adapter folder conventions.
* Forbidden shortcuts.

---

# Release gates

## Alpha

* CI exists.
* Plan precedence resolved.
* Compatibility target exists.
* Threat model exists.
* Runner/env policy refactored.
* Legacy env migration documented and tested.
* Restricted coordinator MVP exists and is selectable.
* Adapter V2 exists.
* Conformance framework exists.
* Conformance includes usage and workspace isolation reporting.
* Codex, Claude, OpenCode pass core conformance.
* At least one useful example runs on Codex, Claude, and OpenCode.
* Example outputs are structurally comparable.
* No silent downgrades.

## Beta

* OMP/Pi passes conformance.
* Cursor has documented experimental status or passes conformance.
* Worktree mode exists.
* Reports/inspection work.
* `odw artifacts` works.
* Durable resume MVP works without SQLite.
* Server/Tauri hardening tests exist.
* AGENTS.md exists.

## 1.0

* All required adapters are either first-class or explicitly experimental.
* Restricted coordinator mode is documented and tested.
* Policy file and security doctor are stable.
* Durable resume is SEA-safe.
* Existing roadmap docs are reconciled.
* Cross-harness example suite passes against all first-class adapters.
* AGENTS.md is stable enough for autonomous contributors.
* Security limitations are explicit.

---

# Core design bet

Keep ODW’s language and product shape.

Harden the seams:

* execution environment
* adapter boundary
* capability checks
* env handling
* generated workflow execution
* run inspection
* resume state
* server/desktop attack surfaces

The fork should evolve ODW, not replace it.

---

# Patch v3 — net effect

This patch closes the remaining execution gaps: env migration is concrete, restricted mode is actually selectable, the threat model and compatibility target return, usage and workspace isolation return to conformance, examples have a PR owner, `AGENTS.md` has a PR owner, cross-harness parity is a release gate again, and `odw artifacts` is restored.
