#!/usr/bin/env bash
#
# build_truecolor.sh
# Silver step: extract the Sentinel-2 L2A true-colour image (TCI, 10 m) and
# write it as a Cloud-Optimized GeoTIFF to Cloudflare R2.
#
#   Input  : a raw S2 L2A .SAFE.zip — staged from R2 bronze, or a local file.
#   Output : <scene>_TCI.tif (8-bit RGB COG) under 02-silver/sentinel2-truecolor/
#            in R2 (or a local dir if R2_BUCKET is unset).
#
# This is the "clip/extract" silver product: a ready-to-view RGB basemap COG.
# Cataloguing in pgSTAC is the later (gold) step. See pipelines/README.md.
#
# Parameters (env): SCENE, SAFE, BRONZE_PREFIX, OUTPUT_DIR, STAGING, FORCE,
#   and the R2_* / AWS_* set from .env.r2. Requires GDAL >= 3.8, curl, unzip.
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
while [ "$REPO_ROOT" != "/" ]; do
  if [ -e "$REPO_ROOT/.git" ] || [ -e "$REPO_ROOT/AGENTS.md" ]; then break; fi
  REPO_ROOT="$(dirname "$REPO_ROOT")"
done
for _envf in "${ENV_FILE:-}" "${PWD}/.env.r2" "${REPO_ROOT}/.env.r2" "${SCRIPT_DIR}/.env.r2"; do
  if [ -n "$_envf" ] && [ -f "$_envf" ]; then
    echo ">> loading env from ${_envf}"; set -a; . "$_envf"; set +a; break
  fi
done

BRONZE_PREFIX="${BRONZE_PREFIX:-01-bronze/copphil-sentinel}"
SCENE="${SCENE:-S2C_MSIL2A_20260615T021531_N0512_R003_T51QWA_20260615T054156.SAFE.zip}"
STAGING="${STAGING:-${REPO_ROOT}/eodata/_staging}"
OUTPUT_DIR="${OUTPUT_DIR:-${REPO_ROOT}/eodata}"
R2_BUCKET="${R2_BUCKET:-}"; R2_PREFIX="${R2_PREFIX:-02-silver/sentinel2-truecolor}"
R2_PUBLIC_BASE="${R2_PUBLIC_BASE:-}"
mkdir -p "$STAGING"

# early skip: if the R2 output already exists, do NOT download/stage anything
if [ -n "$R2_BUCKET" ] && [ "${FORCE:-0}" != "1" ] && [ -n "${R2_ACCOUNT_ID:-}" ]; then
  _src="$(basename "${SAFE:-$SCENE}")"; _b="${_src%.zip}"; _b="${_b%.SAFE}"
  export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto
  if gdalinfo "/vsis3/${R2_BUCKET}/${R2_PREFIX}/${_b}_TCI.tif" >/dev/null 2>&1; then
    echo "= skip (already in R2): ${R2_PREFIX}/${_b}_TCI.tif"; exit 0
  fi
fi

# 1) get the SAFE zip locally (cache)
if [ -n "${SAFE:-}" ] && [ -f "${SAFE}" ]; then ZIP="$SAFE"; echo ">> input: local ${ZIP}"
else
  ZIP="${STAGING}/${SCENE}"
  if [ -s "$ZIP" ]; then echo ">> input: cached ${ZIP}"
  elif [ -n "$R2_BUCKET" ] && [ -n "${R2_ACCOUNT_ID:-}" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
    # authenticated S3 endpoint has reliable DNS; public r2.dev can fail to resolve.
    export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto
    echo ">> staging bronze (vsis3): ${BRONZE_PREFIX}/${SCENE}"
    gdal vsi copy "/vsis3/${R2_BUCKET}/${BRONZE_PREFIX}/${SCENE}" "${ZIP}.part"; mv "${ZIP}.part" "$ZIP"
  else
    : "${R2_PUBLIC_BASE:?need R2_PUBLIC_BASE (or pass SAFE=local.zip)}"
    URL="${R2_PUBLIC_BASE%/}/${BRONZE_PREFIX}/${SCENE}"; echo ">> downloading bronze scene: ${URL}"
    curl -fL --retry 3 -o "${ZIP}.part" "$URL"; mv "${ZIP}.part" "$ZIP"
  fi
fi
BASE="$(basename "$ZIP")"; BASE="${BASE%.zip}"; BASE="${BASE%.SAFE}"; OUT_NAME="${BASE}_TCI.tif"

# 2) locate the 10 m TCI band
TCI_ENTRY="$(unzip -Z1 "$ZIP" | grep -E '_TCI_10m\.jp2$' | head -1 || true)"
[ -n "$TCI_ENTRY" ] || { echo "!! no TCI_10m band in ${ZIP}" >&2; exit 1; }
TCI="/vsizip/${ZIP}/${TCI_ENTRY}"; echo ">> TCI: ${TCI_ENTRY}"

# 3) destination
if [ -n "$R2_BUCKET" ]; then
  : "${R2_ACCOUNT_ID:?}"; : "${AWS_ACCESS_KEY_ID:?}"; : "${AWS_SECRET_ACCESS_KEY:?}"
  export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto
  export CPL_VSIL_USE_TEMP_FILE_FOR_RANDOM_WRITE=YES
  DEST="/vsis3/${R2_BUCKET}/${R2_PREFIX}/${OUT_NAME}"
  if [ "${FORCE:-0}" != "1" ] && gdalinfo "$DEST" >/dev/null 2>&1; then
    echo "= skip (already in R2): ${R2_PREFIX}/${OUT_NAME}"; exit 0; fi
  echo ">> destination: s3://${R2_BUCKET}/${R2_PREFIX}/${OUT_NAME}"
else
  mkdir -p "$OUTPUT_DIR"; DEST="${OUTPUT_DIR}/${OUT_NAME}"; echo ">> destination: ${DEST} (local)"
fi

# 4) TCI (already 8-bit RGB) -> COG with internal overviews
# Edge-granule fill is (0,0,0); flag 0 as NoData so viewers render it transparent
# instead of a black block. (TCI applies a gain, so genuine pixels are rarely 0.)
echo ">> writing true-colour COG ..."
gdal_translate -q -of COG -a_nodata 0 \
  -co COMPRESS=DEFLATE -co PREDICTOR=2 -co RESAMPLING=AVERAGE -co NUM_THREADS=ALL_CPUS \
  "$TCI" "$DEST"

# 5) report
if [ -n "$R2_BUCKET" ] && [ -n "$R2_PUBLIC_BASE" ]; then
  echo "+ true-colour COG: ${R2_PUBLIC_BASE%/}/${R2_PREFIX}/${OUT_NAME}"
else echo "+ true-colour COG: ${DEST}"; fi
echo ">> done."
