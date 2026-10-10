# ODW HARDENING PLAN

Verified against `main` at `aa1b3d5` (fork plus upstream `16f57ee`).

## Scope

- ODW runs trusted workflow code against local coding-agent CLIs.
- This plan hardens only the parts that ODW owns: child processes, environment, Windows launch,
  server ingress, run-data permissions, and security docs.
- ODW is not a sandbox. It does not contain workflow code or agents.

| Layer | Owns |
| --- | --- |
| ODW | process lifecycle and limits, environment selection, Windows launch, server ingress, run-data permissions, accurate docs |
| Harness | tool permissions, native sandboxing, approvals, authentication |
| Deployment | containment: container, VM, OS account, filesystem, network |

## Trust model

- The loader evaluates `meta` and runs the body as JavaScript in the ODW process
  (`src/loader.ts`). Both can reach `process` and other host globals.
- Run only trusted workflow source. Validation and portability warnings are not security controls.
- Review agent-generated source before it runs. No current code path runs it automatically.
- Chat Host runs one fixed built-in workflow. User text arrives as `args.prompt`, not as source.

## Already done

- OMP keeps its tools. Gemini runs headless with `--prompt` (PR #34).
- Linux CI runs build, type-check, and tests (`.github/workflows/ci.yml`).
- Release builds run each binary with `--version` before publishing.
- A worker that fails to start marks its run failed.
- `wait`, `logs`, and `attach` detect a dead worker (`src/runtime/run-liveness.ts`).
- Pause, stop, and the budget are checked before each dispatch.
- README says to run trusted scripts only and that the loader is not a sandbox.
- `.gitattributes` keeps text files at LF on every platform.

## Open gaps

### Security

- `odw stop` does not cancel a running agent. It only blocks new dispatches.
- Timeout and the output limit kill only the direct child process. In a probe, a grandchild
  survived a timeout on Linux but ended on Windows.
- Chat Host starts Codex directly, with no timeout, output limit, or cancellation. The process
  inherits the full environment.
- Adapter `env` only adds variables. A config cannot remove an inherited secret.
- On POSIX, run and chat files use the default umask. Other local users can often read them.
- The server body limit counts characters, not bytes.
- `odw serve --host <non-loopback>` exposes runs, workflow sources, and chat transcripts without
  authentication. Its warning does not say this or that writes are refused.
- The adapters reference calls `{workspace}` an isolated copy and counts five built-ins. There is no
  copy mode, and there are nine built-ins.

### Windows and cross-platform

- For a `.cmd` or `.bat` launcher, ODW runs the sibling `.ps1` under Windows PowerShell 5.1.
  A probe through `runCommand` with a real npm shim showed these changes:
  - non-ASCII stdin became `?`;
  - LF became CRLF, and a trailing newline was added;
  - arguments lost embedded `"` characters;
  - empty arguments were dropped.
- This affects every CLI installed with `npm install -g`, for example Gemini CLI, Qwen Code, or the
  npm build of Codex. Seven built-ins send the prompt on stdin. If one of them is installed with
  npm, a non-ASCII prompt is corrupted without an error.
- Cursor's Windows launcher (`agent.cmd`) runs a PowerShell script. It keeps stdin bytes but loses
  embedded quotes and empty arguments.
- On Windows, adapter `env` merges names with case. An override spelled `Path` is ignored when the
  host variable is `PATH`.
- CI runs only on Linux and only on Node 24. `engines.node` is `>=20`.
- On Windows, `npm test` fails one test with `EBUSY`. The detached worker keeps the source
  directory as its working directory for a short time after the run settles.
- On Windows, an atomic JSON write fails with `EPERM` while another process reads the file. In a
  probe, 783 of 3,000 `status.json` writes failed while one reader polled.
- `scripts/version-info.mjs` compares paths with the JavaScript `realpathSync`, which does not expand
  8.3 short names. Under a short temp path (GitHub's `RUNNER~1`), two version tests fail.

---

## Status

All seven items are implemented as one commit each on `upstream/main` (16f57ee). `hardening/integration`
holds all seven. Each item has a PR in the fork. The base of each PR is a branch in the fork, so
a PR shows only its own commit, and no PR can change fork `main`:

| Item | Branch | Fork PR | Base |
| --- | --- | --- | --- |
| 1. Cross-platform CI | `hardening/1-ci` | #2 | `odw-pr/upstream-main` |
| 2. Windows launch fidelity | `hardening/2-windows-launch` | #3 | `odw-pr/upstream-main` |
| 3. Process control | `hardening/3-process-control` | #4 | `odw-pr/upstream-main` |
| 4. Environment policy | `hardening/4-env-policy` | #5 | `odw-pr/4-base` (the other six) |
| 5. Private run data | `hardening/5-private-run-data` | #6 | `odw-pr/upstream-main` |
| 6. Server | `hardening/6-server` | #7 | `odw-pr/upstream-main` |
| 7. Security docs | `hardening/7-security-docs` | #8 | `odw-pr/upstream-main` |

- Items 1, 2, 3, 5, 6, and 7 are based on `upstream/main` and are independent.
- Item 4 is based on the integration of the other six. Send its upstream PR after they merge.
- Without item 1, the Windows `EBUSY` test can still fail on the other branches.
- Do not merge these branches into fork `main` before upstream merges them. Rebase
  `hardening/integration` onto `upstream/main` as each PR lands.
- Each upstream PR needs a "Why" section: the problem, the evidence, the impact, and why this fix.
  The fork PR bodies have it. Reuse them.

Verification of `hardening/integration` (head `9155822`):

- Fork CI passes on Linux (Node 20 and 24), Windows (Node 24), and macOS (Node 24).
- Local suite, measured at `9ae51d8`: Windows on Node 22 and on Node 24, 437 pass; Linux (WSL,
  Node 24), 448 pass; 0 failures. The Linux suite also passes on two CPUs with six busy loops
  competing.
- Real agents on `9155822` (rounds 3 to 5 are test and guard fixes), through the single-file
  binary (Windows) and the built CLI (Linux):
  - Windows: Codex (an npm shim) returned `héllo — 世界 [RUN]` unchanged; omp saw a host variable
    under `inherit` and did not see it under an `allowlist`; `odw stop` during an omp shell-tool
    call ended the run in 1.0 s, and the tool process was gone 2.3 s after the stop; a Chat Host
    turn with Codex finished with the reply `pong`.
  - Linux (WSL): the same four checks pass; `odw stop` ended the run in 0.4 s, and the tool
    process was gone at the same moment.
  - A real-agent run depends on the model. In two Linux runs, omp did not call its shell tool
    within 90 s. A run that starts the tool by a marker file, not by a process name, is reliable.

What the review rounds found:

- `review-and-correct` ran on every slice and on the integration, until no critical or important
  finding stayed open. Real-agent tests found one more bug: omp starts its shell tools in their own
  process group, so a group signal missed them. Item 3 now also signals every descendant found
  through parent links.
- Copilot reviewed the seven fork PRs twice. Round 1 gave 16 comments. Round 2 gave 8 new ones.
  All are fixed or answered in the PR threads. Changes that came from them:
  - Item 3: `runCommand` waits for the whole tree before it resolves, and waits again after
    `SIGKILL` (at most 1 s). The global tracker (`processTreesSettled`) is gone. A hung `taskkill`
    is bounded to 5 s.
  - Item 2: a `.cmd` file is an npm shim only when its whole text equals a known template. Only
    `.exe`, `.com`, and a `.cmd` shim can launch. `odw init` uses the same check as the launch.
  - Item 4: a bare command that the host `PATH` does not hold fails with exit code 127, even when
    the adapter `env` holds a `PATH` that has it. An already-aborted call is cancelled first.
  - Item 5: ODW sets its own directories to 0700 also on upgrade. It leaves an existing runs root.
  - Item 6: the warning names the three loopback hosts. Other spellings fail closed.
  - Item 7: the "no permission flag" fallback no longer claims the note was declared.
- Copilot round 3 gave 10 new comments on the final heads. All are fixed:
  - Item 3: the `ps` snapshot is force-killed at its bound (a wedged `ps` cannot hang a tree end),
    and the output cap cuts at a UTF-8 character boundary (no U+FFFD past the cap).
  - Item 5: a workflow bucket, run directory, or `_chat` that is already a symlink is refused;
    `chmod` would follow it and make the target private, and later writes would land there.
  - Item 6: a read is passive on a non-loopback bind. The chat reads appended a run result and
    could start a Codex turn; the same sync also ran on the 1 s tick, so a non-loopback `odw serve`
    would start turns with no request at all. All three sites are gated. The over-cap 400 now
    reaches the client, and a character split across request chunks is not corrupted.
  - Items 1, 2, 4: a 10 s worker guard raised to 30 s; README claims about Cursor's `agent.cmd`
    corrected; a leaked test temp directory cleaned up.
- Copilot round 4 gave 6 new comments. All are fixed:
  - Item 3: when the tree cannot be listed (a broken `ps`), `runCommand` says so on stderr instead
    of claiming a clean end. A detached descendant may still run in that case. The `ps` snapshot
    is force-killed at its bound.
  - Item 2: the resolver reads `PATH` the way the OS does. An empty entry is the current
    directory; a missing `PATH` still searches the platform default (`/bin` and `/usr/bin`).
  - Item 4: `Settings.envPolicy` is optional at the public boundary. A programmatic `Config`
    without it keeps the inherit default instead of throwing.
  - Item 5: the symlink rule now covers reads (`ChatStore.read` refuses a linked `_chat`), and the
    mode is set through a `O_NOFOLLOW` descriptor, so an entry swapped in after the check cannot
    be followed. A shared, writable runs root can still redirect later path writes: the root must
    stay owner-only, which is how odw creates it.
  - Item 1: the blocked-rename test accepts `EPERM`, `EACCES`, and `EBUSY`.
- Copilot round 5 gave 7 new comments. All are fixed:
  - Item 2: the resolver returns absolute paths and skips a directory that shares a command's name,
    so an agent's workspace cwd cannot re-resolve the command and a directory no longer wins over a
    real executable in a later entry. `resolveAdapter` names a CLI in its fix only when that CLI is
    installed.
  - Item 3: the output cap keeps a whole trailing character (the first fix dropped one and produced
    U+FFFD past the cap). The `taskkill` fallback reports an unverified tree end, like the broken
    `ps` case.
  - Item 4: the Chat Host environment is built per turn, so a variable that changes after the
    server starts still reaches the next launch.
  - Item 5: the symlink refusal is POSIX-only. Windows junctions stay valid storage there.
- CI on macOS caught one new test that compared `/var` with `/private/var` spellings. It compares
  real paths now.
- Copilot round 6 gave 4 new comments. All are fixed:
  - Item 2: a `.cmd` whose script is a rooted path is not an npm shim (the batch file would run it
    under the shim directory, a direct launch the rooted file). Off Windows, readiness needs a real
    executable file: the launcher diagnostic lookup no longer reports a directory as `ready`.
  - Item 3: a stop does not publish the terminal `stopped` status before the in-flight agents have
    settled, so `waitFor` cannot return before the process trees are gone.
  - Item 4: `buildChildEnv` writes entries as own properties, so a name like `__proto__` is kept.
- Copilot round 7 gave 4 new comments. Three are fixed:
  - Item 2: a directory named `tool.exe` or `tool.com` is not launchable (the loose diagnostic
    lookup can find one, and readiness must not call it ready).
  - Items 2 and 4: only Windows reads a backslash as a path separator. On POSIX, `foo\bar` is a
    bare name, so the host `PATH` alone selects it.
  - Item 5: the no-follow open also passes `O_DIRECTORY`, so a FIFO swapped in for a directory
    fails the open instead of blocking it.
- One comment is a documented limit, not fixed: a process that a descendant spawns during
  shutdown and that outlives its parent chain is out of reach (it is reparented to PID 1, so a
  parent-link walk cannot find it). Containment would need a process group or session per call,
  or OS job objects.
- Copilot round 8 gave 5 new comments. Three are fixed:
  - Item 2: an adjacent `node.exe` that is a directory is not Node; the PATH fallback applies.
  - Item 3: a terminated call no longer waits forever on `close` when a descendant holds the
    inherited pipes. A 2 s bound after the child exits finishes the call. A normal call still
    waits, so trailing output is kept.
  - Item 3: the chat shutdown waits with a 5 s bound, so a custom runner that ignores the abort
    cannot keep the server from closing.
- Two comments were the same gap. It is fixed: `CliResult.treeCleanup` (`verified` | `unverified`)
  is machine-readable now. `Bridge` carries it on `RunStopped`, the worker writes it into
  `status.json` and the `run_stopped` event, and the Chat Host failure text carries it. A call
  whose tree end was `unverified` keeps its worktree (`Workspace.retain()`), and the error names
  the path; a verified end still removes it.
- Copilot round 9 fixed the last two documentation gaps: the READMEs now state that
  `claudeJobsScope` defaults to `"all"` (a non-loopback bind exposes Claude Code runs from
  `~/.claude/projects` for every repository) and that `"project"` narrows it. Every review thread
  on the seven PRs is resolved.
- CI on the PR branches found flaky tests that the first CI runs on the integration missed:
  - Windows: upstream tests with 5 s or 10 s waits for a real worker (30 s now); a status-write
    test whose reader never paused; a cleanup that hit a just-exited process (retries now); a
    hung-`taskkill` test that Node 24 on Windows cannot run as written (the test now accepts the
    failed-helper fallback there).
  - macOS: a test that binds `127.0.0.2` (skipped on macOS, which has no such alias).
  - Linux: three tests that asserted a marker file stayed absent for 4 to 6 s failed on a starved
    machine. They now check that the descendant is dead when the call resolves.

Open items:

- Copilot rounds 3 to 9 ran on the successive heads (10, 6, 7, 4, 4, 5, and 2 comments). Every
  finding is fixed and every review thread on the seven PRs is resolved. The last two rounds added
  no security-class finding.
- Minor findings from the last `review-and-correct` round, not fixed: none. (The `node.exe`
  directory case it listed is fixed in round 8.)
- Known limits, documented in the PRs: a workflow that discards an `agent()` promise can finish
  before that call's process tree is gone; a PID reused inside one poll interval (about 50 ms) can
  receive the `SIGKILL` of the tree end; `odw serve` counts only `127.0.0.1`, `localhost`, and
  `::1` as loopback.
- On Windows, the retried rename can block the dashboard server for up to 500 ms while a chat
  write waits for a reader.
- Item 1: the new `waitFor` tests do not reproduce the old race in every run. The `cli-runs` rerun
  test reproduces it reliably.
- `package-lock.json` in the main checkout has local changes that are not part of this work.

## Work

- Propose this work in one upstream issue first. `docs/ROADMAP.md` does not cover it.
- Send each item as one PR to upstream, from a branch based on `upstream/main`. Do not include
  this plan file.
- Do items 1 and 2 first. The other items are independent.

### 1. Cross-platform CI

Change:

- Run CI on Linux, Windows, and macOS.
- Add one Linux job on the minimum Node version in `engines.node`.
- Make `waitFor` return only after the worker process exits, with a short upper limit. Then a
  caller can delete the source directory on Windows.
- On Windows, retry an atomic JSON rename for a short, bounded time when it fails with `EPERM`,
  `EACCES`, or `EBUSY`.
- Compare build paths with `realpathSync.native`, which expands 8.3 short names.

Test:

- The `EBUSY` test passes on Windows without retries.
- On Windows, status writes succeed while another process reads `status.json`.
- The version tests pass when `TEMP` is an 8.3 short path.

### 2. Windows launch fidelity

Change:

- When the resolved launcher is an npm shim, start its target directly: `node <script> <args>`.
  Use the `node.exe` next to the shim if it exists, else `node` on `PATH`. The shim does the same.
- Reject other `.cmd` and `.bat` launchers before spawn. The error names the file. It tells the
  user to set the real executable, or an explicit interpreter, in `command`.
- Remove the automatic sibling-`.ps1` route and its `-ExecutionPolicy Bypass`.
- Document an explicit Cursor command for Windows. State its limit: PowerShell 5.1 drops embedded
  quotes and empty arguments.

Test (Windows CI):

- Through an npm-shim fixture, argv (`"`, empty, `&`, `%`) and stdin (non-ASCII, LF) arrive
  byte-identical to a direct launch.
- An unknown `.cmd` fails before any interpreter starts.

### 3. Process control

Change:

- Add an `AbortSignal` to `runCommand`.
- The worker watches for a stop request and aborts running adapter calls.
- On timeout, stop, or output limit, end the whole process tree:
  - POSIX: start the child in its own process group. Signal the group and every descendant found
    through parent links (a harness can start tools in their own group). Send `SIGTERM`, then
    `SIGKILL` after a short delay, also after the direct child exits.
  - Windows: run `taskkill /T /F` on the child.
- Record why the process ended: `timeout`, `cancelled`, or `output_limit`.
- Run Chat Host's Codex through `runCommand`, with a stdout callback for streaming. Apply the same
  timeout, output limit, and environment policy. Cancel it when the server closes.

Test (Linux and Windows):

- A grandchild started by a fixture ends on timeout and on stop.
- Chat Codex stops at the timeout, at the output limit, and when the server closes.

Tree cleanup is best effort. A process that leaves its group or job can survive. The docs must say
this.

### 4. Environment policy

Change:

- Add `envPolicy`:

  ```ts
  type EnvPolicy =
    | { mode: "inherit"; deny?: string[] }
    | { mode: "allowlist"; allow: string[] };
  ```

- Set it at the top level for all harness processes, including Chat Codex. An adapter can override
  it.
- Keep `env`. ODW applies its values after the policy. No migration is necessary.
- Compare names without case on Windows.
- Find the executable with the full host environment before filtering.
- Keep `inherit` as the default.
- Docs recommend `allowlist` on shared hosts. Docs say that filtering does not protect credential
  files.

Test:

- `allow`, `deny`, and `env` apply in the correct order.
- On Windows, `Path` and `PATH` are the same name.
- A denied variable does not reach a mock adapter or Chat Codex.
- An adapter starts with no `PATH` in its environment.

### 5. Private run data

Change:

- On POSIX, create the runs root, run directories, and the chat store with mode `0700`. Create their
  files with mode `0600`.
- On Windows, keep the inherited user-profile ACL. Document it.

Test:

- POSIX mode checks for a new run and a new chat session.

### 6. Server

Change:

- Count the request body limit in bytes.
- On a non-loopback bind, print a warning: reads need no authentication, and writes are refused.

Test:

- A multi-byte body over the byte limit is rejected.
- A write to a non-loopback bind is refused.
- A non-loopback Host header is refused on a loopback bind.
- Chat Host archives exactly the fixed built-in source.

### 7. Security docs and posture tests

Change:

- Add a short Security section to `README.md` and `README.zh-CN.md`. Cover the trust model, the
  ownership table, environment inheritance (item 4 adds `envPolicy`), worktrees as edit isolation
  only, prompts in argv for Gemini and Qwen, sensitive run data, and non-loopback read exposure.
- Correct the adapters reference: `{workspace}` is the source or a temporary worktree, and there
  are nine built-ins. List the permission flags of each built-in.
- Label `permissionNote()` output as declared by flags, not verified.
- Add an exact expected command vector for each of the nine built-ins. This guards their permission
  flags.

Test:

- An exact-vector test fails when any built-in command changes.

---

## Done when

- CI passes on Linux, Windows, and macOS, and on the minimum Node version.
- No supported launch path changes argv or stdin bytes.
- Stop, timeout, and the output limit end the process tree, within the documented limits.
- A config can keep any inherited variable away from every harness process.
- Run data is private on POSIX.
- User docs make no false isolation or permission claims.

## Not in this plan

Deferred. These are useful, but security and platform parity do not need them:

- adapter contract and evidence model, live CLI evidence, and a generated capability matrix;
- saved per-agent results and diffs (upstream issue #24 covers results);
- run reports and `status --json`;
- a dirty-worktree guard;
- type-checking for tests, `AGENTS.md`, and source hashes.

Out of scope:

- in-process sandboxing, network policy, and permission emulation;
- restricted execution without a selected containment provider;
- durable resume;
- managed execution policy (the upstream triage of PR #30 declined it for the current scope).
