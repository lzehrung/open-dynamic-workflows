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
  authentication. It prints no warning.
- User docs say that built-in `omp` runs with `--no-tools`. It runs with tools and
  `--approval-mode yolo`.

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

---

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

Test:

- The `EBUSY` test passes on Windows without retries.

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
  - POSIX: start the child in its own process group. Send `SIGTERM`, then `SIGKILL` after a short
    delay.
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
  ownership table, `envPolicy`, worktrees as edit isolation only, prompts in argv for Gemini and
  Qwen, and non-loopback read exposure.
- Fix false claims:
  - built-in `omp` with `--no-tools` (`SKILL.md` and both `adapters.md` files);
  - `{workspace}` as an isolated copy (both `adapters.md` files).
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
