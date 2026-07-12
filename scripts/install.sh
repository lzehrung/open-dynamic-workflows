#!/bin/sh
# Open Dynamic Workflows — one-command installer.
#
# Downloads the self-contained `odw` binary (no Node.js required) and installs
# the workflow skill into your coding agent's skills directory. The whole install
# is a binary + a skill.
#
#   curl -fsSL https://raw.githubusercontent.com/xz1220/open-dynamic-workflows/main/scripts/install.sh | sh
#
# Env overrides: ODW_VERSION (default: latest), ODW_BIN_DIR (default: ~/.local/bin),
#                ODW_REF (skill source ref, default: main).
set -eu

REPO="xz1220/open-dynamic-workflows"
VERSION="${ODW_VERSION:-latest}"
REF="${ODW_REF:-main}"
BIN_DIR="${ODW_BIN_DIR:-$HOME/.local/bin}"

# --- pick the right binary for this machine ---------------------------------
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) echo "unsupported OS: $os — on Windows, download odw-win-x64.exe.gz from Releases" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

# No prebuilt binary for Intel macs (GitHub's Intel runners are retiring).
# odw is NOT on npm yet, so until then the working path is build-from-source.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
  echo "No prebuilt binary for Intel macs. Build from source (needs Node >=20):" >&2
  echo "  git clone https://github.com/$REPO && cd open-dynamic-workflows" >&2
  echo "  npm ci && npm run build && npm i -g ." >&2
  echo "then copy the skill:" >&2
  echo "  cp -r skills/open-dynamic-workflows ~/.claude/skills/open-dynamic-workflows" >&2
  exit 1
fi

ASSET="odw-$OS-$ARCH.gz"   # the binary is ~110 MB; the release ships it gzipped (~35 MB)

# Release tags carry a `v` prefix; accept ODW_VERSION both with and without it.
case "$VERSION" in
  latest|v*) ;;
  *) VERSION="v$VERSION" ;;
esac

if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

# Stage downloads in a temp dir and move into place only when complete, so a
# failed/interrupted download never clobbers a working install.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- the binary (download compressed, decompress, then move into place) ------
echo "→ downloading $ASSET ($VERSION)"
mkdir -p "$BIN_DIR"
curl -fSL "$BASE/$ASSET" -o "$TMP/odw.gz"
gzip -dc "$TMP/odw.gz" > "$TMP/odw"
chmod +x "$TMP/odw"
mv -f "$TMP/odw" "$BIN_DIR/odw"

# --- the skill (into Claude Code's skills dir, else Codex's) -----------------
SKILL_DIR="$HOME/.claude/skills/open-dynamic-workflows"
if [ ! -d "$HOME/.claude" ]; then
  if [ -d "$HOME/.codex" ]; then
    SKILL_DIR="$HOME/.codex/skills/open-dynamic-workflows"
  else
    echo "  note: neither ~/.claude nor ~/.codex exists — installing the skill to $SKILL_DIR anyway;" >&2
    echo "        your agent will pick it up once it reads that skills directory" >&2
  fi
fi
echo "→ installing skill → $SKILL_DIR"
mkdir -p "$TMP/open-dynamic-workflows/references"
RAW="https://raw.githubusercontent.com/$REPO/$REF/skills/open-dynamic-workflows"
curl -fSL "$RAW/SKILL.md"                 -o "$TMP/open-dynamic-workflows/SKILL.md"
curl -fSL "$RAW/references/primitives.md" -o "$TMP/open-dynamic-workflows/references/primitives.md"
curl -fSL "$RAW/references/adapters.md"   -o "$TMP/open-dynamic-workflows/references/adapters.md"
mkdir -p "$SKILL_DIR/references"
mv -f "$TMP/open-dynamic-workflows/SKILL.md" "$SKILL_DIR/SKILL.md"
mv -f "$TMP/open-dynamic-workflows/references/primitives.md" "$SKILL_DIR/references/primitives.md"
mv -f "$TMP/open-dynamic-workflows/references/adapters.md" "$SKILL_DIR/references/adapters.md"

# A checked assignment: a binary that cannot run on this machine must abort the
# install loudly here, not slip past inside an echo's command substitution.
ODW_VER="$("$BIN_DIR/odw" --version)"
echo "✓ installed $ODW_VER"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "  note: $BIN_DIR is not on your PATH — add it to your shell profile, e.g.:"
    echo "        echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
    ;;
esac

# --- pick the default agent ---------------------------------------------------
# With several agent CLIs installed, odw needs to know which one bare agent()
# calls drive; `odw init` detects what's on PATH and settles it now instead of
# at the first failing run. All the logic lives in the binary — the shell only
# routes a keyboard to it: under curl|sh stdin is the script stream, so the
# interactive pick reads /dev/tty; with no keyboard (agent-driven installs, CI)
# init degrades to a report telling the agent to ask its user and run
# `odw init --adapter <name>`. The --help probe skips all of this when
# ODW_VERSION pins a release that predates `odw init`.
if HELP_OUT="$("$BIN_DIR/odw" --help 2>/dev/null)"; then
  if printf '%s\n' "$HELP_OUT" | grep -q "odw init"; then
    echo ""
    # Interactive only as the terminal's FOREGROUND job: a backgrounded install
    # (`curl … | sh &`) that read /dev/tty would be stopped cold by SIGTTIN.
    FG_PGID="$(ps -o tpgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
    MY_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
    if [ -z "${CI:-}" ] && [ -z "${ODW_DETACH:-}" ] && [ "$FG_PGID" = "$MY_PGID" ] \
       && ( : </dev/tty ) 2>/dev/null; then
      "$BIN_DIR/odw" init </dev/tty || true
    else
      "$BIN_DIR/odw" init --check || true
    fi
  fi   # release predates `odw init`: nothing to run
else
  echo "  warning: $BIN_DIR/odw --help failed — the binary may not run on this machine" >&2
fi

echo ""
echo "next steps:"
echo "  odw --version                       # confirm the binary works"
echo "  odw init                            # (re)pick the default agent, if you skipped it above"
echo "  odw run <workflow.js> --wait        # run your first workflow"
echo "  or just ask your agent: \"use Open Dynamic Workflows to …\" — it picked up the skill"
