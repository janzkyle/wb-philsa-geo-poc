#!/usr/bin/env bash
# Ingest/migrate by-reference data into a deployed catalog WITHOUT exposing a
# writable STAC API to the internet.
#
#   deploy/scripts/prod-ingest.sh <local|prod> [loader flags...]
#   deploy/scripts/prod-ingest.sh prod --all
#   deploy/scripts/prod-ingest.sh prod --with-silver
#   deploy/scripts/prod-ingest.sh prod --silver-only   # targeted silver reload, no mirror
#
# Why this exists: the public STAC API runs read-only in prod
# (ENABLE_TRANSACTIONS_EXTENSIONS=false — see render.yaml), because a public
# Transactions endpoint means anyone can POST/PUT/DELETE catalog items. So we no
# longer point the loaders at the public URL. Instead this script:
#
#   1. brings up a PRIVATE, ephemeral transactions-enabled STAC API on localhost,
#      with its PG* pointed at the TARGET environment's database (Neon for prod),
#   2. runs the normal by-reference loaders against that localhost API — the
#      writes land in the real database,
#   3. tears the ephemeral API down.
#
# The public read-only API then serves those same rows from the same database.
# Nothing writable is ever internet-reachable. The loaders are unchanged; only
# the write endpoint moves from "public URL" to "localhost, bound to Neon".
set -euo pipefail
. "$(dirname "$0")/lib.sh"

ENV_NAME="${1:-}"
load_env "$ENV_NAME"
shift || true

INGEST_PORT="${INGEST_PORT:-8092}"          # distinct from local dev's 8082
CONTAINER="philsa-ingest-api-${ENV_NAME}"
# Dedicated tag for the ingest image so we don't clobber the local-dev compose
# image (stac-utils/stac-fastapi-pgstac).
IMAGE="philsa-stac-api-ingest"
INGEST_STAC_API="http://localhost:${INGEST_PORT}"

command -v docker >/dev/null 2>&1 || die "docker is required for prod-ingest."
[ -n "${PGHOST:-}" ] || die "$ENV_NAME env has no PGHOST — cannot bind the ingest API to its database."

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Build the SAME pinned image as prod (deploy/stac-api/Dockerfile), NOT the
# submodule's own Dockerfile. The submodule's `pip install .[server,catalogs]`
# resolves a newer stac-fastapi-extensions (6.3+) that moved `core.fields`, so
# the app crashes at import with `ModuleNotFoundError:
# stac_fastapi.extensions.core.fields`. The pinned Dockerfile reproduces the
# known-good 6.2.1 set. Context is the submodule root (COPYs are relative to it).
info "building the pinned STAC API image (same known-good deps as prod) …"
docker build -q -f "$DEPLOY_DIR/stac-api/Dockerfile" -t "$IMAGE" \
  "$REPO_ROOT/stac-fastapi-pgstac" >/dev/null

info "starting PRIVATE transactions-enabled API on $INGEST_STAC_API, bound to '$ENV_NAME' DB (PGHOST=$PGHOST) …"
cleanup
docker run --rm -d --name "$CONTAINER" \
  -p "127.0.0.1:${INGEST_PORT}:${INGEST_PORT}" \
  -e APP_HOST=0.0.0.0 -e APP_PORT="${INGEST_PORT}" \
  -e ENABLE_TRANSACTIONS_EXTENSIONS=true \
  -e PGHOST="$PGHOST" -e PGPORT="${PGPORT:-5432}" \
  -e PGUSER="$PGUSER" -e PGPASSWORD="$PGPASSWORD" -e PGDATABASE="$PGDATABASE" \
  -e PGSSLMODE="${PGSSLMODE:-require}" \
  -e DB_MIN_CONN_SIZE=1 -e DB_MAX_CONN_SIZE=1 \
  "$IMAGE" python -m stac_fastapi.pgstac.app >/dev/null

info "waiting for the ingest API to come up …"
for i in $(seq 1 30); do
  if curl -fsS "$INGEST_STAC_API/collections" >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && { docker logs "$CONTAINER" 2>&1 | tail -20; die "ingest API did not become ready — is the DB reachable / migrated?"; }
  sleep 2
done
info "ingest API is up."

# Hand off to the normal loader, redirecting its write endpoint to the private
# API via INGEST_STAC_API (which wins over the env file's public STAC_API).
info "running loaders against the private API …"
INGEST_STAC_API="$INGEST_STAC_API" bash "$DEPLOY_DIR/scripts/load-reference-data.sh" "$ENV_NAME" "$@"

info "done. The public read-only API now serves the ingested rows. Verify:"
info "  deploy/scripts/db-check.sh $ENV_NAME"
