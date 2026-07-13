#!/usr/bin/env bash
# Populate a deployed (or local) catalog with the by-reference collections by
# running the loaders against that environment's STAC API.
#
#   deploy/scripts/load-reference-data.sh <local|prod>                 # PhilSA mirror only
#   deploy/scripts/load-reference-data.sh <local|prod> --with-silver   # + Sentinel silver COGs
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
# Everything talks to the STAC API over HTTP (Transactions extension), so the
# target API must have ENABLE_TRANSACTIONS_EXTENSIONS=true — the Render blueprint
# sets this. Nothing here re-hosts data; it only registers references.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

load_env "${1:-}"
shift || true

with_esri=false; with_silver=false
for arg in "$@"; do
  case "$arg" in
    --with-esri)   with_esri=true ;;
    --with-silver) with_silver=true ;;
    --all)         with_esri=true; with_silver=true ;;
    *) die "unknown option: $arg (use --with-esri, --with-silver, --all)" ;;
  esac
done
[ -n "${YEAR:-}" ] && with_esri=true

[ -n "${STAC_API:-}" ] || die "STAC_API is not set in this environment file."
info "target STAC API: $STAC_API"
info "checking the API is reachable …"
curl -fsS "$STAC_API/collections" >/dev/null || die "cannot reach $STAC_API/collections"

export STAC_API DST="$STAC_API"

info "PhilSA catalog mirror (by reference) …"
python3 "$REPO_ROOT/pipelines/reference/philsa-catalog/mirror_philsa_catalog.py"

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
