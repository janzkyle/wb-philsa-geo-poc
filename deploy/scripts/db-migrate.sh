#!/usr/bin/env bash
# Install / upgrade the pgSTAC schema in a target database.
#
#   deploy/scripts/db-migrate.sh <local|prod>
#
# Runs `pypgstac migrate` against that environment's DATABASE_URL. Idempotent:
# a fresh database gets the full pgSTAC schema; an existing one is upgraded to
# the pinned version. This is the same tool `pypgstac` the local pgSTAC image
# runs at startup, so local and prod end up on identical schemas.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

load_env "${1:-}"
ensure_pypgstac

# pgSTAC's migration runs `SET ROLE pgstac_admin` / `pgstac_ingest`. On managed
# Postgres (e.g. Neon) the connecting role isn't a superuser, so it can only
# SET ROLE to roles it's a *member* of — and the migration only grants itself
# pgstac_admin, not pgstac_ingest. Pre-create the roles and grant membership so
# every SET ROLE succeeds. Idempotent, and a harmless no-op on local (where the
# role is already superuser). Needs psql.
if command -v psql >/dev/null 2>&1; then
  info "ensuring pgSTAC roles exist and are grantable to the current user …"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN CREATE ROLE pgstac_admin;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE pgstac_read;   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE pgstac_ingest; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- membership only (no WITH ADMIN OPTION — that errors when re-granting to the
-- role that created these). Plain GRANT gives SET capability, which is all the
-- migration's SET ROLE needs.
GRANT pgstac_admin  TO CURRENT_USER;
GRANT pgstac_read   TO CURRENT_USER;
GRANT pgstac_ingest TO CURRENT_USER;
SQL
else
  info "psql not found — skipping role pre-grant (fine on a superuser/local DB)."
fi

info "migrating pgSTAC (v${PGSTAC_VERSION}) into ${PHILSA_ENV:-$1} …"
"${PYPGSTAC[@]}" migrate --dsn "$(migrate_dsn)"

info "current pgSTAC version:"
"${PYPGSTAC[@]}" version --dsn "$DATABASE_URL"
info "done."
