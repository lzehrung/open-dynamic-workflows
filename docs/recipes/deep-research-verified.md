# deep-research-verified: fact-checked web research on the codex adapter

`examples/deep-research-verified.js` is the Claude Code built-in deep-research
workflow, unchanged except for its name. Pipeline: **Scope** (decompose the
question into 5 search angles) → **Search** (parallel web searches) →
**Fetch** (URL-dedup, fetch up to 15 sources, extract falsifiable claims) →
**Verify** (3-vote adversarial verification per claim, 2/3 refutes kill) →
**Synthesize** (merge, rank by confidence, cite sources).

Validated 2026-07-12 on a real research question: 100 agents, ~9 min
end-to-end at concurrency 8, zero infra failures; ≈7.2M tokens (74% cached
input) ≈ 4% of a Codex Pro 5-hour window.

## Adapter requirement

Search agents need web search; fetch/verify agents need to retrieve pages.
The stock codex adapter has neither. Add this to `~/.config/odw/config.json`:

```json
"codex-research": {
  "label": "Codex CLI (search + network)",
  "command": ["codex", "--search", "exec", "--skip-git-repo-check",
              "--sandbox", "workspace-write",
              "-c", "sandbox_workspace_write.network_access=true",
              "--cd", "{workspace}", "-"],
  "stdin": "{prompt}",
  "flags": { "model": ["--model"] }
}
```

`claude-web` (with `--allowedTools WebSearch WebFetch`) also works, at Claude
token prices.

## Run from the command line

```bash
# one-off, by name (register once: cp examples/deep-research-verified.js ~/.odw/workflows/)
odw run deep-research-verified --args '"your research question"' \
  --adapter codex-research --wait

# or via the wrapper, which also renders report.md and keeps artifacts
# under ~/.odw/reports/deep-research/<utc-timestamp>-<slug>/:
scripts/run-deep-research.sh "your research question"
scripts/run-deep-research.sh -s anysearch @question.txt   # custom slug, question from file
```

The wrapper's exit code is the run's real outcome (`--wait` semantics), and
its last stdout line is the report directory.

## Run on a schedule

Same contract as [cron.md](cron.md) — the wrapper is just a command with an
honest exit code:

```cron
PATH=/Users/you/.nvm/versions/node/v24.12.0/bin:/usr/bin:/bin
# Monday 09:00 weekly research; flock skips the tick if the last run is still going
0 9 * * 1 flock -n /tmp/odw-deep-research.lock \
  $HOME/repos/open-dynamic-workflows/scripts/run-deep-research.sh \
  @$HOME/.odw/reports/deep-research/question.txt \
  >> $HOME/.odw/log/deep-research.log 2>&1
```

(macOS has no `flock` by default — `brew install flock`, or drop it if overlap
is acceptable. `launchd` works identically: invoke the wrapper, key off its
exit status.)

## Known limitations (from the 2026-07-12 validation run)

- **Verify can kill true facts.** The rubric says "default to refuted if
  uncertain", so accurate single-source claims (e.g. a pricing page's own
  numbers) sometimes lose 1-2. Read the `refuted` list in the report before
  trusting it — treat it as "not independently confirmed", not "false".
- **403-walled sites stay dark.** Agents have no credentials; sites like
  Product Hunt need an API token woven into the question text (args) or a
  pre-fetched summary passed alongside.
- **Coverage follows searchability.** Angles whose sources are login-walled or
  thin (team/funding, community reaction) may produce zero findings while the
  product/technical angles saturate. The `openQuestions` section is honest
  about this — read it.
