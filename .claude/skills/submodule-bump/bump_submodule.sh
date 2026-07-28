#!/usr/bin/env bash
# Land a submodule change the two-commit way: commit+push inside the submodule,
# then record the new gitlink in the parent repo. Skipping the second step is the
# classic trap — the edit stays invisible to everyone else.
#
#   bash .claude/skills/submodule-bump/bump_submodule.sh <submodule> [-m "message"]
#
#   <submodule>   stac-browser | stac-fastapi-pgstac (must be registered in .gitmodules)
#   -m MESSAGE    commit message for uncommitted changes inside the submodule.
#                 Required only if the submodule worktree is dirty.
#
# Env:
#   DRY_RUN=1     print what would run, change nothing
#   BRANCH=main   remote branch on our fork to push to (default: main)
#
# Does NOT push the parent repo — review and push that yourself.
set -euo pipefail

BRANCH="${BRANCH:-main}"
DRY_RUN="${DRY_RUN:-0}"
SUB=""
MSG=""

while [ $# -gt 0 ]; do
  case "$1" in
    -m) MSG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *)  SUB="$1"; shift ;;
  esac
done

run() {
  if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

[ -n "$SUB" ] || { echo "usage: bump_submodule.sh <submodule> [-m \"message\"]" >&2; exit 2; }
SUB="${SUB%/}"

# Only ever act on a registered submodule.
if ! git config --file .gitmodules --get-regexp '^submodule\..*\.path$' \
     | awk '{print $2}' | grep -qx "$SUB"; then
  echo "error: '$SUB' is not a registered submodule. Registered:" >&2
  git config --file .gitmodules --get-regexp '^submodule\..*\.path$' | awk '{print "  " $2}' >&2
  exit 1
fi

echo "==> $SUB"

if [ -n "$(git -C "$SUB" status --porcelain)" ]; then
  echo "--- uncommitted changes inside $SUB:"
  git -C "$SUB" status --short
  [ -n "$MSG" ] || {
    echo "error: worktree is dirty — pass -m \"message\" to commit it." >&2
    exit 1
  }
  run git -C "$SUB" commit -am "$MSG"
else
  echo "--- worktree clean; nothing to commit inside the submodule"
fi

# Push to OUR fork (origin), never upstream.
ORIGIN="$(git -C "$SUB" remote get-url origin)"
echo "--- pushing to origin ($ORIGIN) HEAD:$BRANCH"
run git -C "$SUB" push origin "HEAD:$BRANCH"

# Record the new pinned commit in the parent repo.
run git add "$SUB"
if [ "$DRY_RUN" != "1" ] && git diff --cached --quiet -- "$SUB"; then
  echo "--- gitlink unchanged; parent repo already points at this commit"
else
  SHA="$(git -C "$SUB" rev-parse --short HEAD)"
  run git commit -m "bump $SUB submodule to $SHA"
  echo "--- parent commit recorded ($SHA)"
fi

echo
echo "Done. The parent repo is NOT pushed — review, then: git push"
