# ODW HARDENING PLAN

## Purpose

ODW runs Claude-style dynamic workflows against coding-agent CLIs. Hardening means ODW's own seams
are correct, bounded, and honest. It does not mean ODW becomes a sandbox provider.

Goals, in priority order:

1. **Truthful execution.** What a run reports about its adapter, permissions, and workspace is what
   actually happened.
2. **Bounded child processes.** ODW controls environment, time, output, and process trees.
3. **Honest capability reporting.** Per-harness support is proven by conformance, never inferred
   from command flags.
4. **Debuggable runs.** A failure is diagnosable from run artifacts without a rerun.
5. **No product drift.** Same workflow dialect, zero runtime npm dependencies, SEA packaging,
   Node >= 20, existing server/Tauri hardening preserved.

## Design rules

* Every item names its owner. If the owner is a harness or the deployment, ODW documents and reports
  it — ODW does not reimplement it.
* Deleting a false claim beats implementing a weak imitation of it.
* No new subsystem without a test that a real bug class would trip.
* No new file format, command, or doc unless it removes ambiguity a user actually hits.
* Extend existing modules; do not grow a parallel "v2" tree beside working code.

## Security responsibility boundary

| Layer | Owns | Does not provide |
| --- | --- | --- |
| ODW | workflow-source trust policy, environment policy, subprocess lifecycle and limits, server ingress, workspace semantics, truthful capability reporting, run artifacts | containment of its own runtime, a harness's tool permissions, OS-level isolation |
| Harness | agent tool permissions, native sandboxing, provider approval flows | containment for ODW's workflow runtime or arbitrary helper processes |
| Deployment | real containment: container, VM, or least-privileged OS account | workflow intent; it cannot repair a false ODW claim |

Read the table as an assignment of work, not a disclaimer. Anything in row 2 or 3 is out of scope for
this plan except as something ODW must report accurately.

## Trust decision (settled)

ODW is **trusted-code workflow orchestration**.

* `src/loader.ts` compiles workflow source into a host-process `AsyncFunction` with injected
  primitives. Confirmed by construction: the compiled function reaches `process` and
  `await import("node:fs")`. It is a source transform, not a sandbox.
* Harness sandbox settings constrain the *agent's* tools, not ODW's parent process. Claude Code's OS
  sandbox covers Bash and its descendants, requires WSL2/container/VM on Windows, and leaves hooks
  and MCP servers as unconstrained host processes. Codex `--sandbox` scopes model-generated shell
  commands. These are not a portable security contract.
* Therefore unreviewed, generated, or remote workflow source requires an external OS boundary.
  Harness sandboxing alone is insufficient.
* Restricted in-process execution is **conditional** work (Phase 7), not a default direction.

Server exposure is narrower than earlier drafts claimed: the Chat Host launches one fixed built-in
workflow source and chat text arrives as `args.prompt`. The live risk is prompt-driven agent action,
not browser-supplied workflow RCE. Any future route that accepts arbitrary workflow source moves the
trust boundary and must clear the Phase 7 gate first.

## Cut from this plan, and why

| Cut | Reason |
| --- | --- |
| in-process JS sandbox, `node:vm` isolation | Node documents `node:vm` as not a security mechanism |
| static rejection of `import`/`require`/`process`/`fs` as containment | that is lint; a string-built dynamic import defeats it |
| ODW-enforced network policy (deny/allowlist/proxy) | ODW cannot constrain a child's network; owner is the OS/container |
| generic cross-harness permission emulation | map and report; never emulate another product's permission model |
| parallel `src/adapters/v2/**` tree with V1 compatibility shim | two adapter models is the larger risk; evolve the existing types |
| `odw.policy.json` as a new file format | fold the few real knobs into existing config |
| five hand-written harness docs | generate the capability matrix from conformance output |
| `copy` workspace mode | ODW has `inplace` (default) and `worktree`; a third mode adds cost, not safety |
| `roleBased` / `roundRobin` / `costAware` routing | no demonstrated need; explicit `adapter` already works |
| SQLite-backed run state | breaks zero-dependency/SEA constraints; the run directory stays the source of truth |
| `odw inspect` / `odw tail` / `odw events` commands | `odw status`, `odw logs [--follow]`, and `odw result` already cover this |
| `odw config migrate-env` command | the config linter already has a warning channel; print the converted shape there |
| Windows console-hiding as a hardening phase | completed platform maintenance; `windowsHide: true` is already set at every production spawn site |

## Planning authority

* Supersedes prior CLI/runtime/adapter hardening plans only.
* The GUI/Tauri roadmap stays valid unless a phase below explicitly changes it.
* Reconcile once, in the first PR: `docs/ROADMAP.md`, `docs/tasks/launch.md`, `docs/tasks/gui.md`,
  `docs/tasks/cli.md`, `docs/dynamic-workflows-tech-plan.md`.

## Permanent invariants

Cheap, partly enforced today, and the reason this plan exists. Every future adapter change keeps them:

* Every built-in adapter is non-interactive and keeps its tools enabled. A tool-less or interactive
  default does not fail loudly — it returns confident guesswork.
* Built-in command vectors are asserted exactly in tests, never by substring.
* `odw.config.example.json` equals the built-ins, so copying the example cannot silently drop a
  capability.
* No capability exists in the capability model without a conformance check.
* Anything ODW cannot verify is reported as `unverified`, never as a guarantee.
* No silent downgrade of permission mode, workspace mode, schema handling, or event mode.

---

# Phase 0 — Baseline and CI

Owner: ODW.

## Objective

Make the plan executable and the claims checkable.

## Change

* PR CI: `npm ci`, `npm run typecheck`, `npm test`, cheap build smoke.
* Add `docs/security-boundary.md`: the boundary table, the trust decision, actors, attack surfaces,
  ODW-owned mitigations, harness-owned mitigations, residual risks.
* Add `docs/adapters.md`: what "first-class" and "experimental" mean, the required behaviors
  (detect, run, capture output, timeout, cancel where possible, schema handling, permission mapping,
  env policy, workspace mode, result normalization), and the generated capability matrix.
* Add a one-line precedence note to each overlapping planning doc.

## Inventory, do not rebuild

Existing strengths to document and keep: agent count cap, budget ceiling, output byte cap, timeout
kill, config linter warnings, in-place execution plus optional git-worktree isolation with diff
capture and cleanup, explicit per-call adapter routing, adversarial/cross-adapter examples, server
loopback default, write guard, Host allowlist, body size caps, remote-write refusal, and the Tauri
least-privilege sidecar capability model.

## Acceptance

* CI runs on PRs.
* Two security/adapter docs exist; no doc claims a guarantee the code does not provide.
* Roadmap conflicts are resolved in writing.

---

# Phase 1 — Adapter defaults and contracts

Owner: ODW. Status: implemented; upstream PR open.

## Objective

Remove the bug class where a harness runs but does not do the work.

## Change

* OMP keeps its tools (`--no-tools` removed).
* Gemini runs headlessly through `--prompt`, not a positional query that can attach to a TTY.
* `odw.config.example.json` reproduces every built-in contract exactly.
* Tests assert exact command vectors, example/built-in equality, and Gemini's headless invocation.

## Acceptance

* No built-in disables tools or depends on interactive mode.
* A copied example config behaves identically to the built-ins.
* Adding a built-in requires an exact-contract test.

---

# Phase 2 — Process and environment layer

Owner: ODW. This is the highest-value remaining work.

## Objective

Give ODW real control over what it spawns, since that is the part ODW actually owns.

## Problem

`Bridge.invoke()` and `runCommand()` default to `process.env`; adapter `env` is additive only, so a
config cannot subtract an inherited credential. A compromised or over-eager harness therefore
inherits host secrets.

## Change

```ts
interface EnvPolicy {
  mode: "inherit" | "empty";
  allow?: string[];
  set?: Record<string, string>;
  deny?: string[];
}
```

* `envPolicy` per adapter; `env` remains legacy shorthand for
  `{ mode: "inherit", set: { ... } }` for one release cycle.
* `envPolicy` wins when both are present, and the config linter prints the converted shape.
* Generalize the existing runner: per-stream output caps, process-tree cleanup where the platform
  supports it, an explicit timeout-vs-cancel distinction in the result, structured exit info.
* Keep prompt transport as is (stdin, argv, prompt file) — it already works.

## Tests

* timeout kills the child process tree
* per-stream output cap holds and preserves partial output on non-zero exit
* `mode: "empty"` yields only allowed variables
* `deny` removes an inherited secret
* legacy `env` still works; both fields present warns; converted shape is stable
* prompt-file cleanup runs on success and on failure

## Acceptance

* An adapter can be given a minimal environment without editing ODW.
* Defaults stay `inherit`, so existing setups do not change behavior silently.

---

# Phase 3 — Capability model and conformance

Owner: ODW (reporting). Harness owns the underlying behavior.

## Objective

Replace flag-shaped guesses with proven, reported capability.

`permissionNote()` today derives a human string from command flags. It reports; it does not verify.
That is acceptable only while ODW says so plainly.

## Change

Extend `src/adapters/types.ts` in place:

```ts
type PermissionMode = "readOnly" | "workspaceWrite" | "fullAccess";
type PromptTransport = "argv" | "stdin" | "promptFile";
type WorkspaceMode = "inplace" | "worktree" | "external";
type EventMode = "text" | "json" | "jsonl";

interface AdapterCapabilities {
  prompt: PromptTransport[];
  events: EventMode[];
  permissions: PermissionMode[];
  workspace: WorkspaceMode[];
  schema: "native" | "runtime";
  cancel: boolean;
  usage: "reported" | "estimated" | "unsupported";
  verified: boolean;
}
```

* `agentType` stays persona/task shaping. `adapter` stays harness selection. No re-merging.
* Capability mismatch fails by default; `allowDowngrade: true` warns visibly.
* Conformance harness under `src/conformance/`: mock binaries plus event fixtures, driven by
  `odw adapters conformance --adapter <id>` and summarized by `odw adapters doctor`.
* Checks: detect, echo, large prompt, read-only, workspace write, schema, events, usage, timeout,
  cancel, no-secret-leak, workspace isolation reporting, unsupported-capability failure.
* Live-CLI runs stay opt-in behind an env flag.

## Acceptance

* The capability matrix in `docs/adapters.md` is generated, not hand-maintained.
* No adapter is `firstClass` without passing conformance.
* Workspace isolation is reported as runtime-owned, harness-owned, or unsupported — never implied.

---

# Phase 4 — Workspace semantics

Owner: ODW. Edit isolation only.

## Objective

Say exactly what the workspace modes do.

## Modes

* `inplace` — current default; the agent edits the source directory; no diff artifact; not a
  security boundary.
* `worktree` — throwaway `git worktree`; concurrent-edit isolation and a stable diff; not a security
  boundary; absolute paths and symlinks still escape.
* `external` — caller supplies an already-isolated workspace; ODW makes no isolation claim.

## Change

* Keep `src/workspace.ts` as the single implementation; strengthen dirty-tree handling and cleanup
  of locked worktrees (already covered by tests — keep them).
* Update every doc that calls a workspace mode "sandboxing".

## Acceptance

* Docs, `--help`, and dashboard text agree with the code's default (`inplace`).
* Diff output stays stable across platforms.

---

# Phase 5 — Run inspection and artifacts

Owner: ODW.

## Objective

Make a failed run diagnosable without rerunning it.

## Change

* Normalize the event vocabulary already emitted: run started/finished/failed, phase
  started/finished, agent started/text, tool started/finished where a harness reports it, file
  changed, usage, warning, error.
* Add `odw artifacts <runId>` (final result, structured results, diffs, logs, raw adapter event
  files, prompt files if policy retains them).
* Add `odw report <runId> --format markdown|json`: workflow, args, git commit, adapter/model per
  step, permission mode, workspace mode, changed files, diff, usage, retries, downgrades, warnings,
  failures.

## Acceptance

* Every downgrade and unverified capability appears in the report.
* No new command duplicates `status`, `logs`, or `result`.

---

# Phase 6 — Server and desktop regression tests

Owner: ODW.

## Objective

Lock the mitigations that already exist.

## Change

Add regression tests for: DNS-rebinding attempt, cross-origin write attempt, oversized body,
non-loopback write refusal, Chat Host launching only its fixed built-in workflow source, Tauri
capability file (no broad shell spawn, no broad remote URL), and sidecar argument validation.

## Acceptance

* Each server guard has a test that fails if the guard is removed.
* If desktop is out of scope for a release, release notes say so.

---

# Phase 7 — Conditional: restricted execution

Owner: Deployment (containment) with ODW integration. Do not start without the gate below.

## Gate

All four must hold before any code lands:

1. An external containment provider is selected (container, VM, or least-privileged OS account).
2. The coordinator and every launched harness run inside that provider.
3. The coordinator's environment is empty by default and its IPC surface is narrow and enumerated.
4. The behavior is tested on every supported platform.

## Change, once gated

* Separate-process coordinator; injected primitives over IPC.
* `odw run --trust-mode restricted` and `odw serve --default-trust-mode restricted`.
* Per-request trust escalation rejected unless the server config explicitly allows it.

## Acceptance

* `restricted` is absent rather than misleading when no provider is available.
* When present, the provider demonstrably prevents access outside the declared environment,
  filesystem, network, and process policy.
* `trusted` remains the compatibility default.

---

# Phase 8 — Deferred: durable resume

Owner: ODW. Deferred until Phases 2–6 are done.

If it happens: JSONL step index beside the run directory, atomic writes, coordinator restarts from
the top, completed steps return cached results, failed/cancelled/timed-out steps rerun. Step key
hashes workflow source, call path, prompt, adapter, model, permission mode, workspace mode, schema,
and relevant args. No new runtime dependency. SEA build must still work.

---

# Phase 9 — AGENTS.md

Owner: ODW.

State the repo constraints and the shortcuts that are forbidden: TypeScript strict mode, zero runtime
dependencies, SEA awareness, tests before behavior changes, fixture-based adapter tests, live CLI
tests behind env flags, no silent downgrades, concise docs. Name where code goes (adapters, process,
workspace, conformance, server, desktop) and what is banned (real CLI calls in unit tests, broad env
inheritance, calling copy/worktree "sandboxing", calling a command template a first-class harness
contract).

---

# PR sequence

| PR | Content | State |
| --- | --- | --- |
| 1 | Adapter defaults and exact contracts (Phase 1) | open upstream |
| 2 | CI, `docs/security-boundary.md`, `docs/adapters.md`, precedence notes (Phase 0) | next |
| 3 | `EnvPolicy` + runner generalization (Phase 2) | after 2 |
| 4 | Capability model on existing adapter types (Phase 3) | after 3 |
| 5 | Conformance harness, `odw adapters doctor` / `odw adapters conformance`, generated matrix (Phase 3) | after 4 |
| 6 | Conformance runs for Codex, Claude, OMP, OpenCode; Cursor marked experimental (Phase 3) | after 5 |
| 7 | Workspace semantics and doc corrections (Phase 4) | after 3 |
| 8 | Artifacts and report (Phase 5) | after 5 |
| 9 | Server/Tauri regression tests (Phase 6) | parallel to 7–8 |
| 10 | `AGENTS.md` (Phase 9) | last |
| — | Restricted execution (Phase 7) | blocked on gate |
| — | Durable resume (Phase 8) | deferred |

---

# Release gates

## Alpha

* CI green on PRs.
* Boundary and adapter docs exist and match the code.
* Permanent invariants enforced by tests.
* `EnvPolicy` and the generalized runner shipped, defaults unchanged.
* Capability model plus conformance harness exist; Codex, Claude, OMP, and OpenCode pass core
  conformance; Cursor is explicitly experimental.
* Workspace docs match the `inplace` default.

## Beta

* Artifacts and report commands work.
* Server and Tauri regression tests exist.
* `AGENTS.md` exists.
* One cross-harness example produces structurally comparable results on Codex, Claude, and OpenCode,
  with harness differences visible in the report.

## 1.0

* Capability matrix is generated and published; no doc claims an unverified capability.
* Restricted execution is either shipped behind a real containment provider or documented as out of
  scope.
* Durable resume is decided: shipped SEA-safe, or explicitly declined.
* Security limitations are explicit, including that ODW's own runtime is not contained.

---

# Core bet

Keep ODW's language and product shape. Harden only the seams ODW owns: adapter truthfulness,
environment and process control, workspace semantics, server ingress, and run inspection. Delegate
agent-tool sandboxing to each harness and real containment to the deployment, and say so in the
product rather than approximating it in code.

---

# Revision note

This revision narrows ownership. It adds the responsibility boundary, records the trusted-source
decision with the evidence behind it, promotes adapter truthfulness to a permanent invariant after a
real `--no-tools` incident, and removes eleven work items ODW should not own — including the
in-process sandbox, network policy enforcement, a parallel adapter V2 tree, a new policy file, three
redundant inspection commands, and SQLite state. Phase count drops from fourteen to ten, and the PR
sequence from eighteen to ten with two explicitly blocked or deferred.
