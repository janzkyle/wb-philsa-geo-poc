#!/usr/bin/env bash
# Populate a deployed (or local) catalog with the by-reference collections by
# running the reference-lane loaders against that environment's STAC API.
#
#   deploy/scripts/load-reference-data.sh <local|prod>
#   YEAR=2025 deploy/scripts/load-reference-data.sh prod --with-esri
#
# The loaders talk to the STAC API over HTTP (Transactions extension), so the
# target API must have ENABLE_TRANSACTIONS_EXTENSIONS=true — the Render blueprint
# sets this. Nothing here re-hosts data; it only registers references.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

load_env "${1:-}"
shift || true
[ -n "${STAC_API:-}" ] || die "STAC_API is not set in this environment file."

info "target STAC API: $STAC_API"
info "checking the API is reachable …"
curl -fsS "$STAC_API/collections" >/dev/null || die "cannot reach $STAC_API/collections"

export STAC_API DST="$STAC_API"

info "PhilSA catalog mirror (by reference) …"
python3 "$REPO_ROOT/pipelines/reference/philsa-catalog/mirror_philsa_catalog.py"

if [ "${1:-}" = "--with-esri" ] || [ -n "${YEAR:-}" ]; then
  info "ESRI 10 m LULC (year ${YEAR:=2023}) — needs GDAL ≥ 3.8 …"
  YEAR="$YEAR" bash "$REPO_ROOT/pipelines/reference/esri-lulc/load_esri_lulc.sh"
else
  info "skipping ESRI LULC (pass --with-esri or set YEAR= to include it)."
fi

info "done. Verify with: deploy/scripts/db-check.sh ${PHILSA_ENV:-<env>}"
