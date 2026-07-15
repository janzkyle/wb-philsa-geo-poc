#!/usr/bin/env bash
# Populate a deployed (or local) catalog with the by-reference collections by
# running the loaders against that environment's STAC API.
#
#   deploy/scripts/load-reference-data.sh <local|prod>                 # PhilSA mirror only
#   deploy/scripts/load-reference-data.sh <local|prod> --with-silver   # + Sentinel silver COGs
#   deploy/scripts/load-reference-data.sh <local|prod> --silver-only   # JUST the silver COGs
#   YEAR=2025 deploy/scripts/load-reference-data.sh <local|prod> --with-esri
#   deploy/scripts/load-reference-data.sh <local|prod> --all           # mirror + esri + silver
#
# Loaders:
#   • PhilSA mirror  — diwata-2 / planetscope / skysat (always).
#   • ESRI 10 m LULC — --with-esri (or YEAR=). Needs GDAL ≥ 3.8.
#   • Silver derivs  — --with-silver: sentinel1-sar, sentinel1-flood,
#                      sentinel2-ndvi, sentinel2-truecolor, cataloged by reference
#                      from the R2 COGs (pipelines/03-gold/catalog_silver.py).
#                      Needs GDAL + R2 creds in the repo-root .env.
#
# Everything talks to a STAC API over HTTP (Transactions extension), so the
# target API must have ENABLE_TRANSACTIONS_EXTENSIONS=true. The PUBLIC prod API is
# now read-only (render.yaml), so you can't point this straight at it — run it via
# `prod-ingest.sh`, which stands up a private writable API bound to the same DB
# and passes its localhost URL in as INGEST_STAC_API (below). For `local`, the
# Docker compose API on :8082 has transactions on, so this runs directly.
# Nothing here re-hosts data; it only registers references.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

ENV_NAME="${1:-}"
load_env "$ENV_NAME"
shift || true

with_esri=false; with_silver=false; silver_only=false
for arg in "$@"; do
  case "$arg" in
    --with-esri)   with_esri=true ;;
    --with-silver) with_silver=true ;;
    --silver-only) with_silver=true; silver_only=true ;;
    --all)         with_esri=true; with_silver=true ;;
    *) die "unknown option: $arg (use --with-esri, --with-silver, --silver-only, --all)" ;;
  esac
done
if ! $silver_only; then
  [ -n "${YEAR:-}" ] && with_esri=true
fi

# A private ingest API (from prod-ingest.sh) overrides the env file's STAC_API,
# which for prod points at the public READ-ONLY URL and can't accept writes.
STAC_API="${INGEST_STAC_API:-${STAC_API:-}}"
[ -n "$STAC_API" ] || die "no write endpoint — set STAC_API in the env file or run via prod-ingest.sh."

# Guard: any non-local environment serves its STAC API read-only, so a direct
# run can only produce a wall of 405s. Rather than guessing writability from
# hostnames (a denylist fails open the moment prod moves to a new domain),
# require the explicit private write endpoint that prod-ingest.sh injects.
if [ "$ENV_NAME" != "local" ] && [ -z "${INGEST_STAC_API:-}" ]; then
  die "'$ENV_NAME' is served by a read-only public API — ingest it via: deploy/scripts/prod-ingest.sh $ENV_NAME [flags]"
fi

info "target write API: $STAC_API"
info "checking the API is reachable …"
curl -fsS "$STAC_API/collections" >/dev/null || die "cannot reach $STAC_API/collections"

export STAC_API DST="$STAC_API"

if $silver_only; then
  info "silver-only reload — skipping the PhilSA mirror."
else
  info "PhilSA catalog mirror (by reference) …"
  python3 "$REPO_ROOT/pipelines/reference/philsa-catalog/mirror_philsa_catalog.py"
fi

if $with_esri; then
  info "ESRI 10 m LULC (year ${YEAR:=2025}) — needs GDAL ≥ 3.8 …"
  YEAR="$YEAR" bash "$REPO_ROOT/pipelines/reference/esri-lulc/load_esri_lulc.sh"
else
  info "skipping ESRI LULC (pass --with-esri or set YEAR= to include it)."
fi

if $with_silver; then
  info "Silver derivatives → pgSTAC by reference (SAR / flood / NDVI / true-colour) — needs GDAL + R2 creds in repo-root .env …"
  python3 "$REPO_ROOT/pipelines/03-gold/catalog_silver.py"
else
  info "skipping silver derivatives (pass --with-silver for sentinel1-sar, sentinel2-ndvi, …)."
fi

info "done. Verify with: deploy/scripts/db-check.sh ${PHILSA_ENV:-<env>}"
