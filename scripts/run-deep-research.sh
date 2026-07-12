#!/usr/bin/env bash
# Run the deep-research-verified workflow and persist the report under
# ~/.odw/reports/deep-research/<utc-timestamp>-<slug>/ (result.json, report.md, run.log).
#
# Usage:
#   run-deep-research.sh "your research question"
#   run-deep-research.sh @question.txt                 # question from a file
#   run-deep-research.sh -s anysearch "question ..."   # custom report folder slug
#   ADAPTER=claude-web run-deep-research.sh "..."      # override the agent adapter
#   OUT_ROOT=~/reports run-deep-research.sh "..."      # override the output root
#
# Exit code is honest: 0 only when the workflow run reached `done` (odw --wait).
# The last stdout line is the report directory, so callers can do:
#   dir=$(run-deep-research.sh "..." | tail -1)
set -euo pipefail

WORKFLOW="${WORKFLOW:-deep-research-verified}"
ADAPTER="${ADAPTER:-codex-research}"
OUT_ROOT="${OUT_ROOT:-$HOME/.odw/reports/deep-research}"

# cron ships a minimal PATH; fall back to the nvm bin dirs odw/codex live in.
if ! command -v odw >/dev/null 2>&1; then
  for d in "$HOME"/.nvm/versions/node/*/bin; do PATH="$d:$PATH"; done
  export PATH
fi
command -v odw >/dev/null 2>&1 || { echo "odw not found on PATH" >&2; exit 127; }

SLUG=""
while getopts "s:" opt; do
  case "$opt" in
    s) SLUG="$OPTARG" ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))

[ $# -ge 1 ] || { echo "usage: $(basename "$0") [-s slug] \"<question>\" | @question-file" >&2; exit 2; }
QUESTION="$1"
case "$QUESTION" in @*) QUESTION="$(cat "${QUESTION#@}")" ;; esac
[ -n "${QUESTION// /}" ] || { echo "empty question" >&2; exit 2; }

if [ -z "$SLUG" ]; then
  SLUG="$(printf '%s' "$QUESTION" | LC_ALL=C tr -cs '[:alnum:]' '-' \
    | tr '[:upper:]' '[:lower:]' | cut -c1-32 | sed 's/^-*//; s/-*$//')"
fi
[ -n "$SLUG" ] || SLUG="research"

OUT_DIR="$OUT_ROOT/$(date -u +%Y%m%d-%H%M%S)-$SLUG"
mkdir -p "$OUT_DIR"

python3 -c 'import json,sys; print(json.dumps(sys.argv[1], ensure_ascii=False))' \
  "$QUESTION" > "$OUT_DIR/args.json"

{
  echo "question: $QUESTION"
  echo "workflow: $WORKFLOW"
  echo "adapter:  $ADAPTER"
} > "$OUT_DIR/run.log"

started=$(date +%s)
status=0
odw run "$WORKFLOW" --args @"$OUT_DIR/args.json" --adapter "$ADAPTER" --wait \
  > "$OUT_DIR/result.json" 2>> "$OUT_DIR/run.log" || status=$?
echo "elapsed: $(( $(date +%s) - started ))s  exit: $status" >> "$OUT_DIR/run.log"

if [ "$status" -ne 0 ]; then
  echo "run failed (exit $status) — see $OUT_DIR/run.log" >&2
  echo "$OUT_DIR"
  exit "$status"
fi

python3 - "$OUT_DIR/result.json" "$OUT_DIR/report.md" <<'PY'
import json, sys

src, dst = sys.argv[1], sys.argv[2]
r = json.load(open(src))
out = []
sec = lambda t: out.append("\n## " + t + "\n\n")

if not isinstance(r, dict):
    out += ["# Deep research report\n\n```json\n",
            json.dumps(r, ensure_ascii=False, indent=2), "\n```\n"]
else:
    out.append("# Deep research report\n")
    if r.get("question"):
        out.append("\n**Question:** " + str(r["question"]) + "\n")
    if r.get("error"):
        out.append("\n**Error:** " + str(r["error"]) + "\n")
    if r.get("summary"):
        sec("Summary"); out.append(str(r["summary"]) + "\n")
    findings = r.get("findings") or []
    if findings:
        sec("Findings (%d, by confidence)" % len(findings))
        for i, f in enumerate(findings, 1):
            out.append("\n### %d. [%s] %s\n" % (i, f.get("confidence", "?"), f.get("claim", "")))
            if f.get("evidence"):
                out.append("\n" + str(f["evidence"]) + "\n")
            for s in f.get("sources") or []:
                out.append("- <" + str(s) + ">\n")
    if r.get("confirmed"):  # synthesis-failed salvage shape
        sec("Verified claims (unmerged)")
        for c in r["confirmed"]:
            out.append("- [%s] %s (%s)\n" % (c.get("vote", ""), c.get("claim", ""), c.get("source", "")))
    if r.get("refuted"):
        sec("Refuted by adversarial verification (%d)" % len(r["refuted"]))
        for c in r["refuted"]:
            out.append("- [vote %s] %s (%s)\n" % (c.get("vote", ""), c.get("claim", ""), c.get("source", "")))
    if r.get("unverified"):
        sec("Unverified (verifier infra failures)")
        for c in r["unverified"]:
            out.append("- %s (valid votes: %s)\n" % (c.get("claim", ""), c.get("validVotes", "?")))
    if r.get("caveats"):
        sec("Caveats"); out.append(str(r["caveats"]) + "\n")
    if r.get("openQuestions"):
        sec("Open questions")
        for q in r["openQuestions"]:
            out.append("- " + str(q) + "\n")
    if r.get("sources"):
        sec("Sources (%d)" % len(r["sources"]))
        for s in r["sources"]:
            out.append("- <%s> (%s, %s claims)\n" % (s.get("url", ""), s.get("quality", "?"), s.get("claimCount", "?")))
    if r.get("stats"):
        sec("Run stats")
        out.append("```json\n" + json.dumps(r["stats"], ensure_ascii=False, indent=2) + "\n```\n")

open(dst, "w").write("".join(out))
PY

echo "report: $OUT_DIR/report.md" >> "$OUT_DIR/run.log"
echo "$OUT_DIR"
