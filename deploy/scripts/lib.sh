#!/usr/bin/env bash
# Shared helpers for the PhilSA deploy scripts. Sourced, not run.
#
# load_env <local|prod>  — export the vars from deploy/environments/<env>.env
# ensure_pypgstac        — make `pypgstac` runnable, print how to invoke it
#
# The pgSTAC version is pinned to match the local Docker image
# (ghcr.io/stac-utils/pgstac:v0.9.8); bump both together.
PGSTAC_VERSION="0.9.8"

# Resolve deploy/ regardless of where the caller runs from.
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

load_env() {
  local env_name="${1:-}"
  case "$env_name" in
    local|prod) ;;
    *) die "usage: <script> <local|prod>  (got '${env_name:-nothing}')" ;;
  esac
  local env_file="$DEPLOY_DIR/environments/${env_name}.env"
  [ -f "$env_file" ] || die "missing $env_file — copy ${env_name}.env.example to ${env_name}.env and fill it in."
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
  [ -n "${DATABASE_URL:-}" ] || die "$env_file does not set DATABASE_URL"
  info "loaded '$env_name' environment (PGHOST=${PGHOST:-?})"
}

# Build a resilient DSN for the (large, slow) pgSTAC migration: require SSL, add
# TCP keepalives so a busy server doesn't look idle, and disable any statement
# timeout. Override the whole DSN with PGSTAC_MIGRATE_URL if needed.
migrate_dsn() {
  if [ -n "${PGSTAC_MIGRATE_URL:-}" ]; then printf '%s' "$PGSTAC_MIGRATE_URL"; return; fi
  local sep='?'; case "$DATABASE_URL" in *\?*) sep='&';; esac
  printf '%s%ssslmode=require&keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=5&options=-c%%20statement_timeout%%3D0' \
    "$DATABASE_URL" "$sep"
}

# Ensure a runnable pypgstac. Sets PYPGSTAC to the command to invoke.
ensure_pypgstac() {
  if command -v uvx >/dev/null 2>&1; then
    PYPGSTAC=(uvx --from "pypgstac[psycopg]==${PGSTAC_VERSION}" pypgstac)
    return
  fi
  local venv="$DEPLOY_DIR/.venv"
  if [ ! -x "$venv/bin/pypgstac" ]; then
    info "creating venv at $venv and installing pypgstac==${PGSTAC_VERSION} (one-time)"
    python3 -m venv "$venv"
    "$venv/bin/pip" install --quiet --upgrade pip
    "$venv/bin/pip" install --quiet "pypgstac[psycopg]==${PGSTAC_VERSION}"
  fi
  PYPGSTAC=("$venv/bin/pypgstac")
}
