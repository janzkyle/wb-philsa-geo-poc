#!/usr/bin/env bash
# Quick health check of a target database: connection, pgSTAC version, and how
# many collections / items are catalogued.
#
#   deploy/scripts/db-check.sh <local|prod>
set -euo pipefail
. "$(dirname "$0")/lib.sh"

load_env "${1:-}"
command -v psql >/dev/null 2>&1 || die "psql not found — install libpq / Postgres client tools."

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
\echo == connection ==
select current_user as role, current_database() as db, inet_server_addr() as host;
\echo == pgstac ==
select pgstac.get_version() as pgstac_version;
\echo == catalog contents ==
select (select count(*) from pgstac.collections) as collections,
       (select count(*) from pgstac.items)       as items;
SQL
