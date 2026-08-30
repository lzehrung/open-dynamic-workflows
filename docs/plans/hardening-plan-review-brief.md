# Review brief — ODW hardening plan

Audience: a second engineer or agent reviewing [`hardening-plan.md`](hardening-plan.md).
Goal of the review: find where the plan is wrong, oversized, or dishonest — not to approve it.

## What the plan now claims

ODW is trusted-code workflow orchestration. Hardening therefore means making ODW's own seams correct
and truthful, and delegating everything else:

* **ODW owns** workflow-source trust policy, environment policy, subprocess lifecycle and limits,
  server ingress, workspace semantics, truthful capability reporting, run artifacts.
* **The harness owns** agent tool permissions, native sandboxing, approval flows.
* **The deployment owns** real containment (container, VM, least-privileged account).

Phase order: baseline/CI → adapter contracts (done) → process/env layer → capability model and
conformance → workspace semantics → inspection/artifacts → server/desktop regression tests →
restricted execution (gated) → resume (deferred) → `AGENTS.md`.

Eleven items were cut. Plan length dropped 1,097 → ~460 lines; PR count 18 → 10.

## Decisions to challenge, with the evidence behind them

| Decision | Evidence to check |
| --- | --- |
| ODW's runtime is not a sandbox, so untrusted workflow source needs an external OS boundary | `src/loader.ts:71,88` compiles workflow bodies with `new AsyncFunction(...)` in the host process; `process` and `await import("node:fs")` are reachable from that scope |
| Harness sandboxing cannot cover ODW | Claude Code's OS sandbox covers Bash and descendants, needs WSL2/container/VM on Windows, and leaves hooks/MCP as host processes; Codex `--sandbox` scopes model-generated shell commands |
| Server risk is prompt-driven, not workflow RCE | `src/runtime/server.ts:109` defines one fixed `CHAT_HOST_WORKFLOW_SOURCE`; `:932` launches it with `args: { prompt: text, sessionId }` |
| Environment control is the highest-value remaining work | `src/bridge.ts:181-184` merges `adapter.env` over `process.env` (additive only); `src/adapters/runner.ts:51` falls back to `process.env` |
| Capability reporting today is flag-shaped, not verified | `src/adapters/config.ts:282` `permissionNote()` derives a string from argv |
| Docs drift is the live bug class | `src/workspace.ts:35` is `"inplace" \| "worktree"`; four docs still describe a `copy` mode |
| Adapter defaults are a correctness surface | `--no-tools` on OMP returned confident guesswork; Gemini's positional prompt could attach to a TTY; the example config had silently dropped built-in capabilities |

## Weak points I want attacked

1. **`EnvPolicy` may be one field too big.** With `mode: "empty"` plus `allow`, is `deny` anything but
   a footgun for people who think it protects `inherit` mode?
2. **`verified: boolean` is probably too coarse.** Real state is per-capability: schema proven, cancel
   unproven, usage unavailable. Should it be `Record<keyof AdapterCapabilities, "proven" | "documented" | "unsupported">`?
3. **Mock-binary conformance can test our fixtures instead of reality.** What is the cheapest honest
   cadence for real-CLI runs, and who pays for it?
4. **`usage` tri-state may be dishonest.** `docs/tasks/cli.md` records that Kimi cannot report usage
   at all and that token counts are not comparable across CLIs. Is `estimated` a useful value, or
   should `budget` stop implying a token meter?
5. **`odw report` may be unnecessary surface.** The run directory already holds everything. Should a
   report artifact simply be written at run completion instead of adding a command?
6. **Phase 7 may deserve deletion, not gating.** If no containment provider is ever selected, is a
   gated phase better than a one-paragraph "ODW will not do this" statement?
7. **Generating the matrix into a human-edited skill reference invites churn.** Better as a generated
   include file the reference links to?
8. **`permissionNote()` survives untouched.** It is shown by `odw init --check`. Should it be tagged
   with verification status, or removed in favour of the capability model?
9. **Process-tree cleanup is platform-specific.** Is that in scope for a zero-dependency Node CLI, and
   what is the acceptable Windows behavior?
10. **Ordering:** env/process before capabilities assumes secrets exposure outranks false capability
    claims. Argue the reverse if you disagree.

## Questions that need an answer, not an opinion

1. Is "trusted workflow source" the right product position, or does an ODW user realistically paste
   generated workflow code from an agent today?
2. Does anything in the plan still claim a guarantee the code cannot deliver?
3. Which of the eleven cuts is actually load-bearing and should return?
4. Is `AdapterCapabilities` minimal enough to implement in one PR without a v2 tree?
5. What is missing entirely? Credential handling for adapter auth, prompt-file retention policy, and
   log redaction are the three I suspect.

## Out of scope for this review

The workflow dialect, zero runtime dependencies, SEA packaging, Node >= 20, and the existing
GUI/Tauri roadmap. Challenge them in a separate thread if needed; they are constraints here.

## Existing coverage the reviewer should know about

Several plan ideas already exist in other docs, some stale, several in Chinese:

* `docs/tasks/cli.md` — verified per-CLI flag matrix (model flag, system prompt, native schema,
  worktree, token usage) with an explicit proven-versus-documented marker, plus the "no silently
  dropped option" invariant and hard limits (model ids are not portable; token counts are not
  comparable). Also **stale**: describes `workspaceMode: copy | inplace` and worktree mapping to copy.
* `docs/ROADMAP.md` — the same no-silent-no-op principle, and the rule that dual-compat protection is
  a test, not a user command. This plan follows both.
* `docs/dynamic-workflows-tech-plan.md` — layer map, workspace semantics, and resume/journaling plus
  the replay-determinism guard already scoped as post-v1. Phase 8 defers to it. Also **stale** on copy
  isolation.
* `docs/dynamic-workflows-research.md` — Claude Code's own dialect rules: determinism enforcement,
  scripts having no filesystem/Node access, and same-session-only resume. Useful contrast: ODW's
  loader does not enforce the no-Node rule.
* `skills/open-dynamic-workflows/references/adapters.md` (+ zh-CN mirror) — per-built-in permission
  posture, including that headless Claude cannot run commands and that `--dangerously-skip-permissions`
  has no sandbox. The plan extends this file rather than adding a new adapter doc. Also **stale** on
  `copy` mode.
* `docs/tasks/gui.md` — Tauri capability allow-list model, and G5's note that the desktop shell has
  never been compiled here (no `cargo`/`rustc`). Phase 6 downgrades desktop checks to static
  assertions because of it.
* READMEs use "sandbox" only for the planned replay-determinism guard. Do not confuse it with security
  sandboxing.

## How to verify the plan's claims locally

```bash
npm ci
npm test          # 289 passing on main
npm run typecheck
codegraph links --json          # markdown link integrity
node --input-type=module -e "const A=Object.getPrototypeOf(async()=>{}).constructor; console.log(await new A('return [typeof process, typeof (await import(\'node:fs\')).readFileSync]')())"
```

The last line is the loader-escape demonstration in one command.

## Repository state

* Work lands on the fork `lzehrung/open-dynamic-workflows` (`origin`). Nothing is pushed to
  `xz1220/open-dynamic-workflows` (`upstream`) directly.
* `main` contains `upstream/main` plus the reviewed adapter fixes.
* Upstream PR [#34](https://github.com/xz1220/open-dynamic-workflows/pull/34) carries Phase 1.

## What a useful review returns

* A list of claims that are wrong, with the file or doc that disproves them.
* Cuts that should be restored, with the bug they prevent.
* Additions, each with an owner from the boundary table and the test that would prove it.
* A verdict on Phase 7: gate, delete, or start.
