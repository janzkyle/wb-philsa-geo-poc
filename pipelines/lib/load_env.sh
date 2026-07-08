#!/usr/bin/env bash
# load_env.sh — sourceable helper to load a KEY=VALUE .env file WITHOUT shell
# expansion, so values containing '$', backticks, quotes, etc. (e.g. a password)
# are taken literally. Unlike `set -a; . .env`, this never evaluates the file,
# so it is safe under `set -euo pipefail` — a value like `p@ss$word` no longer
# aborts on "unbound variable". Mirrors download_copphil_eodata.py's loader
# (later duplicate keys and already-exported vars follow last-wins, as `.` did).
#
# Usage (after REPO_ROOT is known):
#   . "${REPO_ROOT}/pipelines/lib/load_env.sh"
#   load_env "/path/to/.env"          # no-ops if the file is missing
load_env() {
  local _f="${1:-}" _l _k _v
  [ -n "$_f" ] && [ -f "$_f" ] || return 0
  while IFS= read -r _l || [ -n "$_l" ]; do
    case "$_l" in ''|'#'*) continue ;; esac      # skip blanks and comments
    [ "${_l#*=}" != "$_l" ] || continue          # skip lines with no '='
    _k=${_l%%=*}; _k=${_k// /}; _v=${_l#*=}       # split; trim spaces from key
    case "$_v" in                                 # strip one layer of matching quotes
      '"'*'"') _v=${_v#\"}; _v=${_v%\"} ;;
      \'*\')   _v=${_v#\'}; _v=${_v%\'} ;;
    esac
    export "$_k=$_v"                              # literal assign — no re-expansion
  done < "$_f"
}
