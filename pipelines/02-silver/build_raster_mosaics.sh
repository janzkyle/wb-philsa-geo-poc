#!/usr/bin/env bash
# Build per-date MosaicJSON for the Sentinel raster silver collections and upload
# to R2.
#
# Each (collection, acquisition-date) -> one MosaicJSON that stitches that day's
# COG granules into a single seamless layer TiTiler serves via /mosaicjson. Raw
# granules otherwise render as separate tilted partial-overpass footprints; a
# per-date mosaic merges them into one continuous "tile-like" layer while keeping
# the webmap's date selector meaningful (one mosaic == one day).
#
# How: read COG hrefs from the STAC API, build the mosaic *inside* the TiTiler
# container (it already ships cogeo-mosaic + R2/GDAL access), upload with awscli.
#
# Creds come from the gitignored .env (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# / R2_ACCOUNT_ID / R2_BUCKET). Never hard-coded here.
#
#   bash pipelines/02-silver/build_raster_mosaics.sh                  # all collections
#   COLLECTIONS=sentinel1-sar bash pipelines/02-silver/build_raster_mosaics.sh  # one
set -euo pipefail

# Resolve the repo root by walking up to the .git/AGENTS.md marker; the shared
# .env and compose.viz.yml (TiTiler stack) live there, not next to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
while [ "$REPO_ROOT" != "/" ]; do
  if [ -e "$REPO_ROOT/.git" ] || [ -e "$REPO_ROOT/AGENTS.md" ]; then break; fi
  REPO_ROOT="$(dirname "$REPO_ROOT")"
done
cd "$REPO_ROOT"

STAC_API="${STAC_API:-http://localhost:8082}"
COLLECTIONS="${COLLECTIONS:-sentinel2-truecolor sentinel2-ndvi sentinel1-sar}"
DST_PREFIX="${DST_PREFIX:-02-silver}"   # <prefix>/<coll>/mosaics/<coll>_<date>.mosaicjson
MINZOOM="${MINZOOM:-8}"
MAXZOOM="${MAXZOOM:-14}"
COMPOSE="docker compose --env-file ${REPO_ROOT}/.env -f ${REPO_ROOT}/compose.viz.yml"

# R2 creds + S3 endpoint (path-style, region "auto"). Shared creds: repo-root .env.
for _envf in "${ENV_FILE:-}" "${PWD}/.env" "${REPO_ROOT}/.env" "${SCRIPT_DIR}/.env"; do
  if [ -n "$_envf" ] && [ -f "$_envf" ]; then set -a; . "$_envf"; set +a; break; fi
done
S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export AWS_DEFAULT_REGION=auto

WORKDIR="$(mktemp -d)"; trap 'rm -rf "$WORKDIR"' EXIT

for coll in $COLLECTIONS; do
  echo ">>> $coll"
  # (date href) pairs for every item in the collection.
  curl -s "${STAC_API}/collections/${coll}/items?limit=500" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for f in d.get('features', []):
    p = f.get('properties', {})
    dt = (p.get('datetime') or p.get('start_datetime') or '')[:10]
    href = f.get('assets', {}).get('data', {}).get('href')
    if dt and href:
        print(dt, href)
" > "$WORKDIR/pairs.txt"

  for date in $(awk '{print $1}' "$WORKDIR/pairs.txt" | sort -u); do
    awk -v d="$date" '$1==d {print $2}' "$WORKDIR/pairs.txt" > "$WORKDIR/hrefs.txt"
    n=$(wc -l < "$WORKDIR/hrefs.txt" | tr -d ' ')
    out="$WORKDIR/${coll}_${date}.mosaicjson"

    # Build the mosaic in the TiTiler container; hrefs over stdin (robust to spaces).
    $COMPOSE exec -T titiler python -c "
import sys, json
from cogeo_mosaic.mosaic import MosaicJSON
urls = [l.strip() for l in sys.stdin if l.strip()]
m = MosaicJSON.from_urls(urls, minzoom=$MINZOOM, maxzoom=$MAXZOOM)
sys.stdout.write(json.dumps(m.model_dump(exclude_none=True)))
" < "$WORKDIR/hrefs.txt" > "$out"

    key="${DST_PREFIX}/${coll}/mosaics/${coll}_${date}.mosaicjson"
    aws s3 cp "$out" "s3://${R2_BUCKET}/${key}" --endpoint-url "$S3_ENDPOINT" \
      --content-type application/json --only-show-errors
    echo "    ${date}: ${n} granule(s) -> ${key}"
  done
done

echo "Done. Per-date mosaics on R2 under <coll>/mosaics/."
