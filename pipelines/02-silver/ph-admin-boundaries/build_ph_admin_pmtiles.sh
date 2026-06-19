#!/usr/bin/env bash
# Build PH admin-boundary PMTiles (adm0-adm2 by default) from the GeoParquet
# already on R2, and upload the vector tiles back to R2 for the webmap.
#
# Why PMTiles: the source GeoParquet has extremely dense coastlines (adm0 alone
# is ~170 MB for a single polygon). MapLibre can't read GeoParquet natively and
# has no level-of-detail; PMTiles gives per-zoom generalization + a single
# range-readable file the map loads directly via the `pmtiles://` protocol.
# GeoParquet stays the canonical source — this writes a *display* derivative.
#
# Pipeline per level:  R2 GeoParquet --ogr2ogr--> GeoJSONSeq --tippecanoe--> PMTiles --aws s3--> R2
#
# Conventions (mirrors the other pipelines/ scripts):
#   - Reads creds from the gitignored repo-root .env (R2_BUCKET, R2_ACCOUNT_ID,
#     R2_PUBLIC_BASE, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY). Never echoes them.
#   - Idempotent: re-running overwrites the PMTiles in place.
#   - Skip-and-log a level whose source parquet is missing; don't fail the run.
#
# Env overrides:
#   LEVELS="0 1 2"   admin levels to build (Tier 1 default)
#   SRC_PREFIX       R2 prefix of the source parquet   (default 02-silver/ph-admin-boundaries)
#   DST_PREFIX       R2 prefix to write PMTiles under   (default 02-silver/ph-admin-boundaries/pmtiles)
#   SRC_DIR          read phl_adm{L}.parquet from a local dir instead of R2
#   WORKDIR          where to stage intermediate/output files (default: mktemp)
#   DRY_RUN=1        build PMTiles but skip the R2 upload
#
# Requires: GDAL >= 3.8 (ogr2ogr w/ Parquet + /vsis3), tippecanoe, aws CLI.
set -euo pipefail

# Resolve the repo root by walking up to the .git/AGENTS.md marker, so the script
# finds the shared repo-root .env regardless of how deep it's nested or where
# it's invoked from (mirrors the other pipelines/ scripts).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
while [ "$REPO_ROOT" != "/" ]; do
  if [ -e "$REPO_ROOT/.git" ] || [ -e "$REPO_ROOT/AGENTS.md" ]; then break; fi
  REPO_ROOT="$(dirname "$REPO_ROOT")"
done
LEVELS="${LEVELS:-0 1 2}"
SRC_PREFIX="${SRC_PREFIX:-02-silver/ph-admin-boundaries}"
DST_PREFIX="${DST_PREFIX:-02-silver/ph-admin-boundaries/pmtiles}"

# --- credentials / R2 endpoint ------------------------------------------------
# Shared R2 creds live in the repo-root .env (search: $ENV_FILE, cwd, repo, script dir).
for _envf in "${ENV_FILE:-}" "${PWD}/.env" "${REPO_ROOT}/.env" "${SCRIPT_DIR}/.env"; do
  if [ -n "$_envf" ] && [ -f "$_envf" ]; then set -a; . "$_envf"; set +a; break; fi
done
: "${R2_BUCKET:?set R2_BUCKET (or provide .env)}"
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID (or provide .env)}"
R2_PUBLIC_BASE="${R2_PUBLIC_BASE:-}"
S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# GDAL S3 config for reading parquet from R2 over /vsis3 (path-style, region auto)
export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export AWS_VIRTUAL_HOSTING=FALSE
export AWS_DEFAULT_REGION=auto
export AWS_HTTPS=YES

# --- tooling check ------------------------------------------------------------
for bin in ogr2ogr tippecanoe; do
  command -v "$bin" >/dev/null || { echo "ERROR: '$bin' not found on PATH" >&2; exit 1; }
done
if [[ -z "${DRY_RUN:-}" ]]; then
  command -v aws >/dev/null || { echo "ERROR: 'aws' CLI not found (needed for upload; or set DRY_RUN=1)" >&2; exit 1; }
fi

WORKDIR="${WORKDIR:-$(mktemp -d -t ph-admin-pmtiles)}"
mkdir -p "$WORKDIR"
echo "workdir: $WORKDIR"

# Per-level zoom envelope. Coarse levels need fewer zooms; finer levels more.
minzoom_for() { case "$1" in 0) echo 0;; 1) echo 0;; 2) echo 2;; 3) echo 4;; 4) echo 6;; *) echo 0;; esac; }
maxzoom_for() { case "$1" in 0) echo 5;; 1) echo 7;; 2) echo 9;; 3) echo 11;; 4) echo 13;; *) echo 10;; esac; }

built=()
for L in $LEVELS; do
  layer="adm${L}"
  if [[ -n "${SRC_DIR:-}" ]]; then
    src="$SRC_DIR/phl_adm${L}.parquet"
    if [[ ! -f "$src" ]]; then echo "SKIP adm${L}: source not found ($src)"; continue; fi
  else
    src="/vsis3/${R2_BUCKET}/${SRC_PREFIX}/phl_adm${L}.parquet"
    # cheap existence probe via ogrinfo (reads footer only)
    if ! ogrinfo -so "$src" >/dev/null 2>&1; then echo "SKIP adm${L}: source not found ($src)"; continue; fi
  fi

  out="$WORKDIR/phl_adm${L}.pmtiles"
  Z="$(minzoom_for "$L")"; z="$(maxzoom_for "$L")"
  echo ">>> adm${L}: $src  ->  $out  (z${Z}-${z})"

  # GeoParquet -> GeoJSONSeq (newline-delimited) -> tippecanoe.
  # OGR2OGR_USE_ARROW_API NO: GDAL 3.11's Arrow-batch fast path fails
  # (WriteArrowBatch()) writing these dense parquet geoms; the classic path works.
  # --detect-shared-borders keeps adjacent admin polygons gap-free when simplified;
  # --no-tile-size-limit + --extend-zooms ensures no admin unit is dropped.
  ogr2ogr -f GeoJSONSeq /vsistdout/ "$src" -t_srs EPSG:4326 \
      --config OGR2OGR_USE_ARROW_API NO 2>/dev/null \
    | tippecanoe \
        -o "$out" \
        -l "$layer" \
        --minimum-zoom="$Z" \
        --maximum-zoom="$z" \
        --simplification=10 \
        --detect-shared-borders \
        --no-tile-size-limit \
        --extend-zooms-if-still-dropping \
        --preserve-input-order \
        --force \
        --quiet
  echo "    built $(du -h "$out" | cut -f1) pmtiles"
  built+=("$L:$out")
done

if [[ ${#built[@]} -eq 0 ]]; then
  echo "Nothing built." >&2; exit 1
fi

# --- upload to R2 -------------------------------------------------------------
echo
for entry in "${built[@]}"; do
  L="${entry%%:*}"; out="${entry#*:}"
  key="${DST_PREFIX}/phl_adm${L}.pmtiles"
  if [[ -n "${DRY_RUN:-}" ]]; then
    echo "DRY_RUN: would upload $out -> s3://${R2_BUCKET}/${key}"
    continue
  fi
  aws s3 cp "$out" "s3://${R2_BUCKET}/${key}" \
    --endpoint-url "$S3_ENDPOINT" \
    --content-type application/octet-stream \
    --only-show-errors
  if [[ -n "$R2_PUBLIC_BASE" ]]; then
    echo "uploaded adm${L} -> ${R2_PUBLIC_BASE}/${key}"
  else
    echo "uploaded adm${L} -> s3://${R2_BUCKET}/${key}"
  fi
done

echo
echo "Done. PMTiles for levels: ${LEVELS}"
