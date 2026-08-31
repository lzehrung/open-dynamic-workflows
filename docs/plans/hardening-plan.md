# ODW HARDENING PLAN

## Purpose

ODW runs trusted workflow code against local coding-agent CLIs. Hardening means ODW's own
boundaries are correct, bounded, and honest. ODW is not a sandbox provider.

Priorities:

1. Record what actually ran: adapter, model, permissions, workspace, limits, and result.
2. Control every child process: environment, output, timeout, cancellation, and cleanup.
3. Tie adapter claims to an exact contract, CLI version, platform, and test result.
4. Preserve enough run data to diagnose a failure without rerunning it.
5. Keep the workflow dialect, zero runtime npm dependencies, SEA packaging, Node >= 20, and the
   browser dashboard. The retired Tauri shell does not return.

## Responsibility boundary

| Layer | Owns | Does not provide |
| --- | --- | --- |
| ODW | workflow-source trust rules, environment selection, process lifecycle and limits, server ingress, workspace behavior, adapter reporting, run records | containment of its workflow runtime, harness tool policy, OS isolation |
| Harness | agent tool permissions, native sandbox features, provider approval and authentication | containment of ODW or unrelated host processes |
| Deployment | container, VM, account, filesystem, process, and network isolation | workflow intent or truthful ODW reporting |

ODW must report harness and deployment limits. It must not imitate them.

## Trust model

ODW is **trusted-code workflow orchestration**. `src/loader.ts` executes source twice: `meta` through
`new Function(...)` and the body through `AsyncFunction(...)`. Both can reach host globals. Compile
and validation steps are not security boundaries.

| Source | Rule |
| --- | --- |
| Local file or managed local workflow | The caller trusts it. Record the resolved path and content hash. |
| Fixed built-in inline source | Record its identity and hash. Server routes may launch only the reviewed built-in they name. |
| Agent-generated source | Show or save it for review. Never run it automatically. |
| Remote source | Unsupported by this plan. |
| Programmatic `startRunFromSource` | The caller is the trust decision. Record `origin` and source hash. |

`validate(source)` may warn about Node APIs, `process`, and dynamic imports. These are trust and
portability warnings, never containment claims.

## Current facts

Keep the existing concurrency limit, 1,000-dispatch guard, config warnings, detached run workers,
real git worktrees, per-call adapter routing, run directory, loopback server default, Host check,
JSON write guard, origin check, and remote-write refusal.

Do not overstate them:

- stop does not cancel an active harness process;
- timeout kills only the direct child;
- direct Chat Host Codex uses a separate unbounded spawn path;
- worktree diffs are not persisted by workflow runs;
- the budget is successful final reply characters divided by four, not provider tokens or cost;
- tests are not type-checked by the current `tsconfig.json`;
- Windows tests have exposed a detached-worker cleanup race after terminal completion;
- Tauri and Launch were retired and their files are absent.

## Permanent rules

- Every production child process has a named lifecycle policy.
- A requested option is honored or rejected, never silently downgraded.
- Every built-in command has an independent exact expected-value test.
- Every built-in adapter entry in `odw.config.example.json` matches its built-in contract. The
  example's overall settings are not identical to `defaultConfig()`.
- Built-ins are non-interactive and do not add a blanket tool-disable flag. Exact tools and
  restrictions remain harness-specific.
- Published evidence applies only to the exact normalized contract it tested. Any override makes
  that evidence unknown.
- Worktrees isolate edits; they are not a security boundary.
- `no_changes` and `not_observed` are different states.
- Reports never contain environment values, full prompts, or prompt-bearing expanded argv.
- Raw outputs, args, chat transcripts, and diffs are sensitive.
- Unsupported and unverified are different states.
- Generated capability data has one source and is not hand-edited.

## Out of scope

- in-process sandboxing or `node:vm` as security;
- static keyword rejection as containment;
- ODW network enforcement or cross-harness permission emulation;
- a parallel adapter V2 tree, compatibility shim, or new policy file;
- `copy` workspace mode;
- role-based, round-robin, or cost-aware routing;
- SQLite run state or a new secret store;
- generic log-redaction guarantees;
- new `inspect`, `tail`, `events`, `artifacts`, or `report` commands;
- Tauri or desktop-shell work;
- restricted execution without a selected external containment provider;
- durable resume.

Restricted execution needs a separate provider-specific plan. Durable resume is declined here:
restarting arbitrary JavaScript can repeat filesystem, network, and process effects; cached agent
replies do not make those effects safe.

---

# Phase 0 — Baseline truth and CI

Owner: ODW.

## Deliver

- Add PR CI on Linux, Windows, and macOS with Node 20.
- Run `npm ci`, source and test type-checking, `npm test`, and `npm run build`.
- Fix the Windows cleanup race at its source; do not hide it with retries.
- Check generated dashboard and skill files, local Markdown links, the built CLI, and one mock
  workflow. Execute every SEA binary in release CI.
- Add `docs/security-boundary.md` and include it in the npm package.
- Mark stale plans as superseded by `docs/ROADMAP.md`, which says Tauri and Launch are retired.
- Correct all current `copy`-mode claims, false workspace-sandbox claims, the OMP `--no-tools`
  claim, broad “persists everything” wording, and hard-token-budget wording. Use a repository-wide
  check, not a fixed file list.
- Add the repository `AGENTS.md` now. Record strict TypeScript, zero runtime dependencies, SEA
  awareness, exact adapter fixtures, live-CLI gates, and the bans on silent downgrade and false
  sandbox claims.
- Until Phase 4 replaces it, label `permissionNote()` as **flag-derived and unverified**.

## Prove

- CI passes on all three OS families; tests are type-checked.
- The Windows terminal-run test releases its source directory.
- `npm pack --dry-run` includes the security document.
- Current docs contain none of the known false product claims above.

---

# Phase 1 — Complete adapter defaults and exact contracts

Owner: ODW. Current state: core OMP and Gemini fixes exist; acceptance is incomplete.

## Deliver

- Keep OMP tools enabled and Gemini headless through `--prompt`.
- Add independent exact expected objects for Codex, Claude, Gemini, Qwen, Kimi, OMP, Kilo,
  OpenCode, and Cursor. Replace substring assertions.
- Keep example-to-built-in equality for adapter entries only; correct its wording.
- Record prompt transport honestly. Gemini and Qwen put prompts in argv, which exposes them to
  process inspection and platform command-length limits.
- Prefer stdin for future built-ins. Fail before spawn when ODW can prove an expanded argv is too
  large.
- On Windows, every exact built-in contract declares its supported launch strategy.
- First-class Windows support requires a directly executable native image. A built-in distributed
  only as a script shim remains experimental or unsupported on Windows until an explicit strategy
  has live evidence.
- Direct `.exe` launch avoids a script interpreter; it does not prove the executable is trusted.
  PATH and installation integrity remain user and deployment concerns.

## Prove

- Every built-in has one exact contract test independent of the example file.
- No built-in needs an interactive terminal or a blanket tool-disable flag.
- Docs state argv prompt exposure and large-prompt limits where they apply.
- Exact built-in tests cover the declared Windows launch strategy.

---

# Phase 2 — Process lifecycle

Owner: ODW.

## Deliver

Every production spawn uses one policy:

| Policy | Use | Contract |
| --- | --- | --- |
| Managed | adapters and direct Chat Codex | timeout, abort, output limits, streamed chunks, tree cleanup, structured result |
| Detached worker | workflow worker | spawn error handling, PID, heartbeat, source-directory release, interruption detection |
| Bounded helper | git and other short helpers | timeout, output cap, structured failure |
| Browser handoff | open browser | detached best effort, no execution guarantee |

Keep one shared process layer. Do not create a second runner tree.

Windows launch:

- Resolve the exact launcher path before spawn and prefer a directly executable native image.
- Remove the automatic `.cmd` or `.bat` to sibling `.ps1` translation. ODW never adds
  `ExecutionPolicy Bypass` implicitly.
- A script-only CLI must name its interpreter explicitly in the adapter command and declare that
  strategy in its contract. ODW still passes arguments as a vector and does not use a shell.
- Reject undeclared script fallback with an error that names the adapter, resolved candidate, and
  accepted strategies.
- Return resolved path, extension, and actual strategy for the Phase 6 attempt record.

Replace `returncode + timedOut` inference with:

- termination: `exit`, `signal`, `timeout`, `cancelled`, `output_limit`, or `spawn_error`;
- exit code or signal, duration, retained stdout/stderr, observed byte counts, fired limit, and cleanup
  result;
- stdout, stderr, and total caps. The default total memory bound stays at or below 32 MiB;
- byte chunks or streamed files instead of repeated large string concatenation.

Cancellation and cleanup:

- managed runs accept `AbortSignal`;
- stop aborts active adapter calls before blocking future dispatches;
- pause blocks new dispatches but does not claim to suspend active children;
- POSIX uses a process group, TERM grace period, then KILL;
- Windows uses `taskkill.exe /T /F` for best-effort descendant cleanup;
- partial output survives every failure path;
- descendant cleanup is reported as best effort, never containment.

Detached workers:

- spawn errors mark the run failed;
- workers write a heartbeat;
- inspection turns a dead worker with a stale heartbeat into terminal `interrupted`;
- workers release the source directory before terminal completion is visible;
- CLI, dashboard, and run folding understand `interrupted`.

## Prove

- timeout, cancellation, signal, output limit, and spawn error remain distinct;
- child and grandchild cleanup tests run on Linux and Windows;
- `odw stop` aborts an active mock harness;
- direct Chat Codex uses the managed path;
- dead workers become `interrupted`, `--wait` returns non-zero, and Windows can remove the source.
- Windows tests prefer and directly launch a native executable;
- implicit `.cmd`, `.bat`, and sibling `.ps1` fallback fails before an interpreter starts;
- an explicit custom interpreter receives literal arguments without shell interpolation;
- no built-in or runner path adds `ExecutionPolicy Bypass` automatically.

---

# Phase 3 — Environment policy

Owner: ODW for selection and reporting; Harness for authentication; Deployment for filesystem and
account isolation.

## Model

```ts
type EnvPolicy =
  | { mode: "inherit"; deny?: string[]; set?: Record<string, string> }
  | { mode: "allowlist"; allow: string[]; set?: Record<string, string> };
```

Use `envPolicy` per adapter and `chatEnvPolicy` for direct Chat Codex.

## Deliver

- `inherit`: copy host values, remove `deny`, then apply `set`.
- `allowlist`: copy only `allow`, then apply `set`.
- Reject `allow` in inherit mode and `deny` in allowlist mode.
- Match names case-insensitively on Windows.
- Resolve the top-level executable before filtering. Do not add `PATH`, `HOME`, `SystemRoot`, proxy,
  locale, or auth values silently.
- Reports may show key names and mode, never values.
- Warn that `set` is plain config and that filtering does not protect credential files.
- Map legacy `env` to inherit + set. If both fields exist, `envPolicy` wins and the warning prints
  the new shape. Name the release that removes `env`.
- Keep inherit as the compatibility default; recommend allowlist on sensitive hosts.

## Prove

- allow, deny, set precedence, malformed modes, and Windows name matching have tests;
- a resolved adapter launches without a child `PATH`;
- a denied sentinel never reaches mock adapter or Chat Codex;
- reports and warnings never expose values;
- legacy conversion is stable.

---

# Phase 4 — Adapter contract and evidence

Owner: ODW for the model and reporting; Harness for the behavior.

## Deliver

Replace the flat `AdapterCapabilities` proposal with three records:

1. **Contract:** exact normalized config facts—prompt transport and exposure, Windows launch
   strategy, output protocol, model carrier, runtime and optional native schema paths, native usage
   fields, harness-specific permission profile, and contract hash.
2. **Evidence:** per-claim `tested`, `documented`, `declared`, or `unknown`, with source, CLI version,
   platform, date, and contract hash. `unsupported` is a capability value, not evidence.
3. **Effective run facts:** adapter, contract hash, resolved executable and launch strategy, model,
   prompt transport, permission profile, schema path, workspace observation, environment mode,
   termination, and evidence used.

Rules:

- command, prompt transport, output, option carrier, or permission-declaration changes alter the
  contract hash and invalidate shipped evidence;
- environment policy is recorded separately and invalidates only claims that depend on it;
- a requested model without a carrier fails before spawn;
- runtime schema validation always exists; native schema is an extra path and names its dialect;
- permission profiles stay harness-specific, not a false portable enum;
- workspace and cancellation stay out of adapter capability data because ODW owns them;
- estimated output tokens stay out because ODW computes them;
- remove `permissionNote()` after displays use contract and evidence records;
- maturity lives in the reviewed evidence manifest, not in the contract hash;
- classify every built-in as first-class or experimental. Initial first-class candidates are Codex,
  Claude, OMP, and OpenCode; all others remain experimental until they meet the same evidence bar.

## Prove

- contract hashes are deterministic and one-token changes invalidate evidence;
- custom and overridden adapters display unknown evidence;
- unsupported model requests fail before spawn;
- every claim has evidence or explicit unknown;
- no global `verified` boolean, workspace capability, or cancel capability remains.

---

# Phase 5 — Contract tests and live CLI evidence

Owner: ODW for testing and publication; Harness for the tested behavior.

## Deliver

**Every PR:** mock binaries test ODW only—resolution, argv/stdin/prompt file, cwd, environment,
decoding, schema routing, limits, cancellation, unsupported-option failure, and fact recording. Call
these contract tests, not conformance.

**Scheduled CI:** install available CLIs and record `--version` and `--help` facts on supported OSes.

**Before release and after a built-in contract change:** the release owner runs one authenticated
core scenario for each first-class candidate. Record CLI version, OS, time, ODW commit, contract
hash, and evidence source. Missing credentials mean “not tested,” never “passed.” Use dedicated
low-privilege accounts or profiles.

Core live checks: echo, large prompt, workspace posture, model selection, schema, output protocol,
native usage when claimed, timeout, cancellation, and absence of a denied environment sentinel.

Publication:

- keep reviewed evidence in one checked-in machine-readable manifest;
- generate `skills/open-dynamic-workflows/references/capabilities.generated.md` from it;
- link both language guides to that generated file;
- extend `odw init --check --json` to show the local contract, evidence, CLI version, and permission
  profile;
- local checks never rewrite published evidence or docs. Do not add `doctor` or `conformance`
  commands.

## Prove

- mock results are never labeled as real-CLI proof;
- first-class status requires current live evidence for the exact contract hash;
- all nine built-ins have a maturity state;
- the generated matrix has one source and ships with any skill release that links to it.

---

# Phase 6 — Workspace truth and attempt artifacts

Owner: ODW.

## Deliver

Workspace terms:

- `inplace`: run in the source; ODW does not observe changes;
- `worktree`: run at committed `HEAD`, capture a diff;
- external isolation is source provenance, not a third workspace mode.

Worktree mode fails before spawn if the repository has staged, tracked, or untracked changes. The
error explains that those changes would be missing and suggests commit or in-place mode. Do not
stash, create a temporary commit, or add dirty-copy behavior.

Persist each agent and schema attempt:

```text
agents/<agentId>/attempts/<attempt>/
  attempt.json
  stdout.log
  stderr.log
  diff.patch          # worktree only
```

`attempt.json` records effective facts, prompt hash and byte count, termination, output byte and
truncation state, diff state, warnings, and artifact paths. It contains no prompt or environment
values.

Rules:

- capture worktree diff before cleanup on success and failure;
- use `captured`, `no_changes`, or `not_observed`;
- normalize patch paths and line endings;
- record cleanup failure as a warning;
- keep capped stdout/stderr; do not retain per-agent prompts;
- use `0700` run directories and `0600` files on POSIX; document inherited Windows ACLs;
- run and chat data persist until the user deletes them;
- do not promise generic secret redaction;
- resolve the invocation before `agent_started`; terminal events link to exact attempts;
- add native usage or harness tool events only when observed by a tested parser;
- do not add `phase_finished` without a real closing API, or file-change events for in-place mode.

## Prove

- dirty worktree source fails before spawn;
- success, failure, and cancellation preserve diff and partial output;
- in-place records `not_observed`;
- cleanup failure is visible and locked cleanup remains covered;
- POSIX artifacts are private and records contain no prompt or environment values;
- legacy runs still load.

---

# Phase 7 — Run report and inspection

Owner: ODW.

## Deliver

Write versioned `report.json` at terminal completion. If a worker dies, the next inspection builds an
interrupted report from durable run and attempt records.

Report:

- workflow identity, origin, source path/hash, git commit, and dirty state at launch;
- terminal state and times;
- adapter, contract hash, CLI version, model, permission profile/evidence, environment mode, and
  workspace observation per agent;
- attempt count, termination, truncation, artifact references, and observed diff state;
- native provider usage with provider units;
- separate ODW `estimatedOutputTokens`;
- warnings, unsupported requests, failures, and cleanup problems.

It references existing `meta.json` args instead of copying them. It never contains prompts,
prompt-bearing argv, environment values, or cross-provider token comparisons.

Inspection:

- add `odw status <runId> --json` for report or current partial facts;
- add `odw status <runId> --dir` for the run directory;
- keep logs for events and result for the final value;
- render the same report in the dashboard;
- keep old runs readable with absent facts shown as unknown;
- keep zero runtime dependencies and SEA support.

## Prove

- success, failure, cancellation, timeout, output limit, and interruption produce truthful reports;
- schema retries preserve every attempt;
- custom overrides, worktree, and in-place appear correctly;
- report JSON is stable across OSes and contains no sensitive prompt or environment values;
- status, logs, result, dashboard, and report agree.

---

# Phase 8 — Server hardening and regression tests

Owner: ODW.

## Boundary

Chat Host ODW turns launch one fixed built-in workflow. User text is `args.prompt`, not workflow
source. The request may still select an adapter and existing working directory, so the agent has that
adapter's authority there. Normal chat turns also launch direct read-only Codex.

## Deliver

- keep direct Chat Codex on the managed process path with `chatEnvPolicy`, and cancel it when the
  server closes;
- bound stored Chat responses and mark truncation;
- enforce body limits in bytes, not JavaScript string characters;
- require an allowed Host on loopback requests, including when Host is missing;
- keep JSON Content-Type, same-origin checks, and all remote writes disabled;
- keep off-loopback reads as a trusted-network choice and print that run, workflow, and chat data are
  exposed without authentication;
- keep the fixed workflow source invariant;
- do not add remote writes or token authentication here;
- remove all Tauri acceptance items.

Keep current cross-origin, MIME, and oversized-body tests. Add only missing tests: hostile/missing
Host, Unicode byte overflow, actual off-loopback write refusal, fixed source replacement attempts,
direct Chat timeout/cancel/output/close behavior, denied environment sentinel, and remote-read
warning.

## Prove

- every server-started child is managed;
- removing any guard breaks a focused test;
- browser and server wording agree on unauthenticated remote reads and refused remote writes.

---

# PR sequence

This is merge order, not remote PR status.

| PR | Content | Depends on |
| --- | --- | --- |
| 1 | CI, security boundary, doc fixes, AGENTS.md, unverified permission label | — |
| 2 | Complete exact built-in contracts and example wording | 1 |
| 3 | Process lifecycle, cancellation, worker interruption, Chat process path | 1 |
| 4 | Adapter and Chat environment policy | 3 |
| 5 | Contract, evidence, and effective-run-fact model | 2–4 |
| 6 | Contract tests, live evidence, generated matrix, `init --check --json` | 5 |
| 7 | Dirty-worktree rule and per-attempt artifacts | 3, 5 |
| 8 | Versioned report and current-command inspection options | 6–7 |
| 9 | Remaining server hardening and regression tests | 3–4, 8 |

No restricted-execution or resume PR is reserved.

# Release gates

## Alpha

- CI passes on Linux, Windows, and macOS with Node 20; source and tests type-check.
- Security, trust, workspace, budget, and adapter docs match code.
- Every built-in has an exact command test.
- Process lifecycle and environment policy ship with stated compatibility defaults.
- Stop cancels active harnesses and dead workers become interrupted.

## Beta

- Contract, evidence, and effective-run-fact records ship.
- All built-ins are first-class or experimental; first-class entries have reviewed live evidence.
- Attempt artifacts are durable and private by default.
- `report.json`, status JSON, and dashboard agree.
- Server regression tests pass.

## 1.0

- The generated matrix comes from the reviewed evidence manifest.
- No doc presents a flag, mock result, or override as verified harness behavior.
- Codex, Claude, OMP, and OpenCode release checks produce the same report structure while preserving
  provider-specific differences.
- SEA binaries are smoke-tested on every release platform.
- Limits are explicit: trusted source, no ODW containment, environment filtering does not protect
  files, worktrees are edit isolation, tree cleanup is platform-limited, and remote reads have no
  authentication.
- Restricted execution and durable resume remain out of scope.

# Core decision

Keep ODW's language and product shape. Harden only the boundaries ODW owns: source trust, process and
environment control, adapter truth, workspace behavior, server ingress, and durable run facts.
Harnesses own their permissions; deployments own containment. ODW reports those limits instead of
approximating them.

# Revision note

This revision removes Tauri, gated restricted execution, and speculative resume; moves AGENTS.md and
known doc fixes to the baseline; splits process and environment work; replaces the flat capability
model with contract, evidence, and effective facts; separates mock tests from live CLI evidence; and
persists attempt data before adding reports.
