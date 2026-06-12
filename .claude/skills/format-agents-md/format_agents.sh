#!/usr/bin/env bash
#
# format_agents.sh — autoformat AGENTS.md (or any markdown file passed as $1)
# with mdformat + the GFM plugin (tables, task lists, strikethrough, autolinks).
#
# Line wrapping is preserved (--wrap keep), so the file's manual ~80-col wrapping
# is left intact; only markdown *style* is normalized (list markers, heading
# style, emphasis markers, fenced-code fences, table column padding/alignment).
# Idempotent: running it twice produces no further changes.
#
# Tool resolution, in order of preference (first one found wins):
#   1. uvx              — ephemeral, no install:  uvx --with mdformat-gfm mdformat
#   2. mdformat on PATH — used directly (assumes the gfm plugin is present)
#   3. pipx             — installs mdformat + injects mdformat-gfm
#   4. pip --user       — last resort
set -euo pipefail

# ---- resolve target file ----------------------------------------------------
TARGET="${1:-AGENTS.md}"
if [ ! -f "$TARGET" ]; then
  echo "!! '$TARGET' not found (run from the repo root, or pass a path)." >&2
  exit 1
fi

hash_of() { md5 -q "$1" 2>/dev/null || md5sum "$1" | awk '{print $1}'; }
before="$(hash_of "$TARGET")"

# ---- pick a runner and format ----------------------------------------------
run_mdformat() {
  if command -v uvx >/dev/null 2>&1; then
    echo ">> using uvx (ephemeral mdformat + mdformat-gfm)"
    uvx --with mdformat-gfm mdformat --wrap keep "$TARGET"
  elif command -v mdformat >/dev/null 2>&1; then
    echo ">> using mdformat on PATH"
    mdformat --wrap keep "$TARGET"
  elif command -v pipx >/dev/null 2>&1; then
    echo ">> installing mdformat via pipx (one-time)"
    pipx install mdformat >/dev/null 2>&1 || true
    pipx inject mdformat mdformat-gfm >/dev/null 2>&1 || true
    mdformat --wrap keep "$TARGET"
  elif command -v pip3 >/dev/null 2>&1; then
    echo ">> installing mdformat via pip --user (one-time)"
    pip3 install --user --quiet mdformat mdformat-gfm
    python3 -m mdformat --wrap keep "$TARGET"
  else
    echo "!! no runner found (need one of: uvx, mdformat, pipx, pip3)." >&2
    exit 1
  fi
}
run_mdformat

# ---- report -----------------------------------------------------------------
after="$(hash_of "$TARGET")"
if [ "$before" = "$after" ]; then
  echo ">> $TARGET already well-formatted — no changes."
else
  echo ">> formatted $TARGET (content changed)."
fi
