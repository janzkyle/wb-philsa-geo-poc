#!/usr/bin/env bash
#
# build_ph_admin_geoparquet.sh
# Build Philippine administrative boundary GeoParquet files (one per level,
# adm0..adm4) from the OCHA COD-AB Philippines geodatabase on HDX.
#
#   Source : https://data.humdata.org/dataset/cod-ab-phl
#            resource "phl_admin_boundaries.gdb.zip" (Esri File Geodatabase)
#   Output : phl_adm{L}.parquet           (full resolution)
#            phl_adm{L}_s{TOL}m.parquet    (when TOLERANCE_M is set)
#
#   Destination:
#     - a local directory (default), OR
#     - a Cloudflare R2 bucket (S3-compatible) when R2_BUCKET is set. In that
#       case files are written straight to R2 via GDAL's /vsis3 virtual file
#       system — nothing is kept on local disk.
#
# The geodatabase is preferred over shapefile/GeoJSON because it preserves full
# field names, UTF-8 (e.g. Parañaque, Biñan), and real Date types for the
# valid_on / valid_to validity fields.
#
# Output is GeoParquet 1.1 (WKB geometry, EPSG:4326, MultiPolygon) with a
# covering-bbox column for spatial row-group pruning, ZSTD-compressed.
#
# Requirements: GDAL >= 3.8 (ogr2ogr with Parquet + OpenFileGDB drivers, and
# S3 write support for R2 — present in any curl-enabled GDAL build), curl.
#
# Parameters (all optional, via environment):
#   TOLERANCE_M   simplification tolerance in METERS. Unset/0 = full resolution.
#                 e.g. TOLERANCE_M=100 -> ~100 m Douglas-Peucker generalization.
#   LEVELS        space-separated admin levels to build (default "0 1 2 3 4").
#   OUTPUT_DIR    local dir for the .parquet files (default: this script's dir).
#                 Ignored when R2_BUCKET is set.
#   GDB_ZIP       path to an already-downloaded gdb.zip (skips the ~344 MB fetch).
#
#   --- Cloudflare R2 upload (set R2_BUCKET to switch from local to R2) ---
#   R2_BUCKET     R2 bucket name. When set, output goes to R2, not local disk.
#   R2_ACCOUNT_ID Cloudflare account id (forms the S3 endpoint). REQUIRED for R2.
#   R2_PREFIX     key prefix in the bucket (default "02-silver/ph-admin-boundaries").
#   R2_PUBLIC_BASE  optional public base URL (your r2.dev subdomain or a custom
#                   domain). If set, the summary prints each object's https URL.
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
#                 R2 API-token credentials, taken from the environment. Never
#                 hard-code these — export them in your shell or a gitignored
#                 env file. (These are the standard S3 vars; R2 honours them.)
#   ENV_FILE      path to a KEY=VALUE env file to load before running. If unset,
#                 auto-loads .env.r2 from cwd, the repo root, or this script's dir.
#
# Usage:
#   ./build_ph_admin_geoparquet.sh                                 # local, full res
#   TOLERANCE_M=100 ./build_ph_admin_geoparquet.sh                 # local, 100 m
#   R2_BUCKET=philsa-geo R2_ACCOUNT_ID=abc123def456 \
#     AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
#     TOLERANCE_M=100 ./build_ph_admin_geoparquet.sh               # -> Cloudflare R2
#
# Note on tolerance: simplification is planar Douglas-Peucker in degrees
# (TOLERANCE_M converted via 1 deg ~= 111320 m). It is per-feature, so shared
# borders between adjacent units are simplified independently (possible hairline
# slivers, invisible at display scales). Good for web/overview maps; for analysis
# keep the full-resolution files.
#
# Sizes: full-resolution total ~870 MB (adm4 ~207 MB); at TOLERANCE_M=100 ~13 MB
# total. Mind the full-res size when uploading to R2. Levels & feature counts:
# adm0 country=1, adm1 region=17, adm2 province=88, adm3 city/mun=1642, adm4 brgy=42048.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- optional env file (so R2 creds aren't typed on every run) --------------
# Loads KEY=VALUE lines (exported) BEFORE the parameters below are resolved.
# Search order: $ENV_FILE (if set), ./.env.r2 (cwd), <repo-root>/.env.r2,
# <script-dir>/.env.r2. The shared R2 creds live in the repo-root .env.r2.
# Keep this file OUT of git — it holds AWS_SECRET_ACCESS_KEY. See README.md.
if [ -n "${ENV_FILE:-}" ] && [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ENV_FILE=${ENV_FILE} not found"; exit 1
fi
REPO_ROOT="$SCRIPT_DIR"
while [ "$REPO_ROOT" != "/" ]; do
  if [ -e "$REPO_ROOT/.git" ] || [ -e "$REPO_ROOT/AGENTS.md" ]; then break; fi
  REPO_ROOT="$(dirname "$REPO_ROOT")"
done
for _envf in "${ENV_FILE:-}" "${PWD}/.env.r2" "${REPO_ROOT}/.env.r2" "${SCRIPT_DIR}/.env.r2"; do
  if [ -n "$_envf" ] && [ -f "$_envf" ]; then
    echo ">> loading env from ${_envf}"
    set -a; . "$_envf"; set +a
    break
  fi
done

LEVELS="${LEVELS:-0 1 2 3 4}"
OUTPUT_DIR="${OUTPUT_DIR:-$SCRIPT_DIR}"
TOLERANCE_M="${TOLERANCE_M:-0}"
GDB_URL="https://data.humdata.org/dataset/caf116df-f984-4deb-85ca-41b349d3f313/resource/3fa0dbcf-e07d-4506-9821-ba15baa6da07/download/phl_admin_boundaries.gdb.zip"

# Cloudflare R2 (S3-compatible) parameters
R2_BUCKET="${R2_BUCKET:-}"
R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}"
R2_PREFIX="${R2_PREFIX:-02-silver/ph-admin-boundaries}"
R2_PUBLIC_BASE="${R2_PUBLIC_BASE:-}"

# ---- sanity: drivers --------------------------------------------------------
command -v ogr2ogr >/dev/null || { echo "ERROR: ogr2ogr (GDAL) not found"; exit 1; }
ogr2ogr --formats 2>/dev/null | grep -qi parquet || { echo "ERROR: GDAL lacks the Parquet driver"; exit 1; }

# ---- destination: local dir or Cloudflare R2 (/vsis3) -----------------------
USE_R2=0
if [ -n "$R2_BUCKET" ]; then
  USE_R2=1
  : "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID (your Cloudflare account id) for R2 uploads}"
  : "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID (R2 token Access Key ID)}"
  : "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY (R2 token Secret Access Key)}"
  # Point GDAL's /vsis3 at the R2 S3 endpoint (path-style addressing).
  export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_VIRTUAL_HOSTING="FALSE"
  export AWS_DEFAULT_REGION="auto"
  DEST_DESC="s3://${R2_BUCKET}/${R2_PREFIX}  (R2 endpoint ${AWS_S3_ENDPOINT})"
else
  mkdir -p "$OUTPUT_DIR"
  DEST_DESC="${OUTPUT_DIR}"
fi
echo ">> destination: ${DEST_DESC}"

# ---- resolve simplification --------------------------------------------------
SIMPLIFY_ARGS=()
SUFFIX=""
if [ -n "$TOLERANCE_M" ] && [ "$TOLERANCE_M" != "0" ]; then
  TOL_DEG=$(python3 -c "print(${TOLERANCE_M}/111320.0)")
  SIMPLIFY_ARGS=(-simplify "$TOL_DEG" -makevalid)
  SUFFIX="_s${TOLERANCE_M}m"
  echo ">> simplifying at ${TOLERANCE_M} m (= ${TOL_DEG} deg Douglas-Peucker)"
else
  echo ">> full resolution (no simplification)"
fi

# ---- acquire the geodatabase ------------------------------------------------
CLEANUP=""
if [ -n "${GDB_ZIP:-}" ] && [ -f "${GDB_ZIP}" ]; then
  echo ">> using provided GDB_ZIP=${GDB_ZIP}"
else
  WORKDIR="$(mktemp -d)"
  CLEANUP="${WORKDIR}"
  GDB_ZIP="${WORKDIR}/phl_admin_boundaries.gdb.zip"
  echo ">> downloading geodatabase (~344 MB) ..."
  curl -sSL "${GDB_URL}" -o "${GDB_ZIP}" --max-time 600
fi
GDB="/vsizip/${GDB_ZIP}"
echo ">> source: ${GDB}"

# full output path for a level (local path or /vsis3 R2 path)
out_path() {
  local L="$1"
  local name="phl_adm${L}${SUFFIX}.parquet"
  if [ "$USE_R2" = "1" ]; then
    echo "/vsis3/${R2_BUCKET}/${R2_PREFIX}/${name}"
  else
    echo "${OUTPUT_DIR}/${name}"
  fi
}

# ---- convert each level -----------------------------------------------------
for L in ${LEVELS}; do
  LAYER="phl_admin${L}"
  OUT="$(out_path "$L")"
  echo ">> [adm${L}] ${LAYER} -> ${OUT}"
  ogr2ogr \
    -overwrite \
    -f Parquet \
    -t_srs EPSG:4326 \
    "${SIMPLIFY_ARGS[@]}" \
    -nlt PROMOTE_TO_MULTI \
    -nln "phl_adm${L}${SUFFIX}" \
    -lco COMPRESSION=ZSTD \
    -lco GEOMETRY_NAME=geometry \
    -lco GEOMETRY_ENCODING=WKB \
    -lco WRITE_COVERING_BBOX=YES \
    -lco ROW_GROUP_SIZE=8192 \
    "${OUT}" "${GDB}" "${LAYER}"
done

# ---- summary ----------------------------------------------------------------
echo
echo ">> built GeoParquet at ${DEST_DESC}:"
for L in ${LEVELS}; do
  OUT="$(out_path "$L")"
  LYR="phl_adm${L}${SUFFIX}"
  N=$(ogrinfo -so "${OUT}" "${LYR}" 2>/dev/null | grep "Feature Count" | grep -oE "[0-9]+" || echo "?")
  if [ "$USE_R2" = "1" ]; then
    if [ -n "$R2_PUBLIC_BASE" ]; then
      printf "   %-28s features=%-6s %s\n" "${LYR}.parquet" "${N}" "${R2_PUBLIC_BASE%/}/${R2_PREFIX}/${LYR}.parquet"
    else
      printf "   %-28s features=%-6s s3://%s/%s/%s.parquet\n" "${LYR}.parquet" "${N}" "${R2_BUCKET}" "${R2_PREFIX}" "${LYR}"
    fi
  else
    [ -f "${OUT}" ] || continue
    SZ=$(ls -lh "${OUT}" | awk '{print $5}')
    printf "   %-28s %-7s features=%s\n" "${LYR}.parquet" "${SZ}" "${N}"
  fi
done

[ -n "${CLEANUP}" ] && rm -rf "${CLEANUP}"
echo ">> done."
