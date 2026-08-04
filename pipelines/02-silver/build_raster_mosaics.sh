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
# NOTE: this reads item hrefs from the CATALOG, so it must run AFTER the gold
# step (catalog_silver.py) has registered the scenes it should stitch.
#
# COLLECTIONS defaults to the four *scene* collections; sentinel1-flood is
# deliberately excluded (categorical proxy mask, not a continuous layer) — pass
# COLLECTIONS="... sentinel1-flood" to include it. Keep this list in step with
# the temporal RasterDefs in webmap/src/config.ts: a temporal collection missing
# here has no mosaic, so the webmap's HEAD probe 404s on every one of its dates
# and silently falls back to per-item COG tiles (tilted partial footprints).
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
COLLECTIONS="${COLLECTIONS:-sentinel2-truecolor sentinel2-ndvi sentinel1-sar sentinel1-ratio}"
DST_PREFIX="${DST_PREFIX:-02-silver}"   # <prefix>/<coll>/mosaics/<coll>_<date>.mosaicjson
MINZOOM="${MINZOOM:-8}"
MAXZOOM="${MAXZOOM:-14}"
COMPOSE="docker compose --env-file ${REPO_ROOT}/.env -f ${REPO_ROOT}/compose.viz.yml"

# The mosaic itself is one cogeo-mosaic call. Run it *locally* when cogeo-mosaic
# is importable (e.g. inside the Dagster image, which pip-installs it) so no
# TiTiler container / docker socket is needed; otherwise fall back to exec-ing
# into the running TiTiler container (which ships cogeo-mosaic). Reading the COGs
# from R2 needs the same GDAL/AWS S3 env TiTiler uses (AWS_S3_ENDPOINT, creds…);
# the Dagster compose service sets those, mirroring compose.viz.yml.
read -r -d '' MOSAIC_PY <<'PY' || true
import os, sys, json
from cogeo_mosaic.mosaic import MosaicJSON
urls = [l.strip() for l in sys.stdin if l.strip()]
m = MosaicJSON.from_urls(urls, minzoom=int(os.environ["MINZOOM"]), maxzoom=int(os.environ["MAXZOOM"]))
sys.stdout.write(json.dumps(m.model_dump(exclude_none=True)))
PY
if python3 -c 'import cogeo_mosaic' 2>/dev/null; then
  build_mosaic() { MINZOOM="$MINZOOM" MAXZOOM="$MAXZOOM" python3 -c "$MOSAIC_PY"; }
  echo "mosaic builder: local cogeo-mosaic"
else
  build_mosaic() { $COMPOSE exec -T -e MINZOOM="$MINZOOM" -e MAXZOOM="$MAXZOOM" titiler python -c "$MOSAIC_PY"; }
  echo "mosaic builder: TiTiler container ($COMPOSE exec titiler)"
fi

# R2 creds + S3 endpoint (path-style, region "auto"). Shared creds: the single
# repo-root .env only (ENV_FILE overrides the path).
. "${REPO_ROOT}/pipelines/lib/load_env.sh"
for _envf in "${ENV_FILE:-}" "${REPO_ROOT}/.env"; do
  if [ -n "$_envf" ] && [ -f "$_envf" ]; then load_env "$_envf"; break; fi
done
S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export AWS_DEFAULT_REGION=auto

WORKDIR="$(mktemp -d)"; trap 'rm -rf "$WORKDIR"' EXIT

for coll in $COLLECTIONS; do
  echo ">>> $coll"
  # (date href) pairs for every item in the collection.
  curl -s "${STAC_API}/collections/${coll}/items?limit=1000" | python3 -c "
import sys, json
d = json.load(sys.stdin)
feats = d.get('features', [])
if len(feats) >= 1000:
    print('WARN: hit the 1000-item page cap — add pagination or newer scenes will be missed', file=sys.stderr)
for f in feats:
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

    # Rewrite each href to s3://$R2_BUCKET/<key> so the mosaic itself (and
    # TiTiler serving it) reads over the authenticated endpoint, not whatever
    # host the STAC item happened to publish (r2.dev or otherwise) - r2.dev
    # is rate-limited and not for production tile traffic.
    sed -E "s#^https?://[^/]+/#s3://${R2_BUCKET}/#" "$WORKDIR/hrefs.txt" > "$WORKDIR/hrefs.s3.txt"

    # Build the mosaic (local cogeo-mosaic or TiTiler exec, decided above);
    # hrefs over stdin (robust to spaces).
    build_mosaic < "$WORKDIR/hrefs.s3.txt" > "$out"

    key="${DST_PREFIX}/${coll}/mosaics/${coll}_${date}.mosaicjson"
    aws s3 cp "$out" "s3://${R2_BUCKET}/${key}" --endpoint-url "$S3_ENDPOINT" \
      --content-type application/json --only-show-errors
    echo "    ${date}: ${n} granule(s) -> ${key}"
  done
done

echo "Done. Per-date mosaics on R2 under <coll>/mosaics/."
