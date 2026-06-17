#!/usr/bin/env bash
#
# build_ndvi.sh
# Silver step: Sentinel-2 L2A SAFE -> NDVI Cloud-Optimized GeoTIFF -> Cloudflare R2.
#
#   NDVI = (B08 - B04) / (B08 + B04)   at 10 m (NIR / Red).
#   Input  : a raw S2 L2A .SAFE.zip — staged from R2 bronze, or a local file.
#   Output : <scene>_NDVI.tif (COG, Float32) under the medallion-tiered prefix
#            02-silver/sentinel2-ndvi/ in R2 (or a local dir if R2_BUCKET is unset).
#
# This produces the derived COG only. Cataloguing it in pgSTAC is the later
# (gold) step. See pipelines/README.md for the tier model and R2 conventions.
#
# Parameters (all via environment):
#   SCENE         bronze S2 .SAFE.zip filename to process (default: latest known).
#   SAFE          local path to an S2 L2A .SAFE.zip (skips the R2 download).
#   BRONZE_PREFIX R2 key prefix of the raw scenes (default 01-bronze/copphil-sentinel).
#   OUTPUT_DIR    local dir for the COG (used only when R2_BUCKET is unset).
#   STAGING       local staging/cache dir for the downloaded zip + temps
#                 (default <repo>/eodata/_staging).
#   FORCE         set to 1 to rebuild even if the R2 output already exists.
#   R2_BUCKET / R2_ACCOUNT_ID / R2_PREFIX(=02-silver/sentinel2-ndvi) /
#   R2_PUBLIC_BASE / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  — from .env.r2.
#
# Requires GDAL >= 3.8 (gdal_calc.py + COG driver), curl, unzip.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
while [ "$REPO_ROOT" != "/" ]; do
  if [ -e "$REPO_ROOT/.git" ] || [ -e "$REPO_ROOT/AGENTS.md" ]; then break; fi
  REPO_ROOT="$(dirname "$REPO_ROOT")"
done

# shared R2 creds (creds only — never R2_PREFIX). Search cwd, repo root, script dir.
for _envf in "${ENV_FILE:-}" "${PWD}/.env.r2" "${REPO_ROOT}/.env.r2" "${SCRIPT_DIR}/.env.r2"; do
  if [ -n "$_envf" ] && [ -f "$_envf" ]; then
    echo ">> loading env from ${_envf}"; set -a; . "$_envf"; set +a; break
  fi
done

BRONZE_PREFIX="${BRONZE_PREFIX:-01-bronze/copphil-sentinel}"
SCENE="${SCENE:-S2C_MSIL2A_20260615T021531_N0512_R003_T51QWA_20260615T054156.SAFE.zip}"
STAGING="${STAGING:-${REPO_ROOT}/eodata/_staging}"
OUTPUT_DIR="${OUTPUT_DIR:-${REPO_ROOT}/eodata}"
R2_BUCKET="${R2_BUCKET:-}"
R2_PREFIX="${R2_PREFIX:-02-silver/sentinel2-ndvi}"
R2_PUBLIC_BASE="${R2_PUBLIC_BASE:-}"
mkdir -p "$STAGING"

# early skip: if the R2 output already exists, do NOT download/stage anything
if [ -n "$R2_BUCKET" ] && [ "${FORCE:-0}" != "1" ] && [ -n "${R2_ACCOUNT_ID:-}" ]; then
  _src="$(basename "${SAFE:-$SCENE}")"; _b="${_src%.zip}"; _b="${_b%.SAFE}"
  export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto
  if gdalinfo "/vsis3/${R2_BUCKET}/${R2_PREFIX}/${_b}_NDVI.tif" >/dev/null 2>&1; then
    echo "= skip (already in R2): ${R2_PREFIX}/${_b}_NDVI.tif"; exit 0
  fi
fi

# ---- 1) get the SAFE zip locally (cache) ------------------------------------
if [ -n "${SAFE:-}" ] && [ -f "${SAFE}" ]; then
  ZIP="$SAFE"
  echo ">> input: local ${ZIP}"
else
  ZIP="${STAGING}/${SCENE}"
  if [ -s "$ZIP" ]; then
    echo ">> input: cached ${ZIP}"
  elif [ -n "$R2_BUCKET" ] && [ -n "${R2_ACCOUNT_ID:-}" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
    # prefer the authenticated S3 endpoint: its DNS is reliable, whereas the
    # public r2.dev host can fail to resolve on some networks (e.g. hotspots).
    export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto
    echo ">> staging bronze (vsis3): ${BRONZE_PREFIX}/${SCENE}"
    gdal vsi copy "/vsis3/${R2_BUCKET}/${BRONZE_PREFIX}/${SCENE}" "${ZIP}.part"
    mv "${ZIP}.part" "$ZIP"
  else
    : "${R2_PUBLIC_BASE:?need R2_PUBLIC_BASE (or pass SAFE=local.zip) to fetch the bronze scene}"
    URL="${R2_PUBLIC_BASE%/}/${BRONZE_PREFIX}/${SCENE}"
    echo ">> downloading bronze scene: ${URL}"
    curl -fL --retry 3 -o "${ZIP}.part" "$URL"
    mv "${ZIP}.part" "$ZIP"
  fi
fi

BASE="$(basename "$ZIP")"; BASE="${BASE%.zip}"; BASE="${BASE%.SAFE}"
OUT_NAME="${BASE}_NDVI.tif"

# ---- 2) locate the 10 m Red (B04) and NIR (B08) bands inside the zip --------
B04_ENTRY="$(unzip -Z1 "$ZIP" | grep -E '_B04_10m\.jp2$' | head -1 || true)"
B08_ENTRY="$(unzip -Z1 "$ZIP" | grep -E '_B08_10m\.jp2$' | head -1 || true)"
if [ -z "$B04_ENTRY" ] || [ -z "$B08_ENTRY" ]; then
  echo "!! could not find B04_10m / B08_10m bands in ${ZIP}" >&2; exit 1
fi
B04="/vsizip/${ZIP}/${B04_ENTRY}"
B08="/vsizip/${ZIP}/${B08_ENTRY}"
echo ">> red  (B04): ${B04_ENTRY}"
echo ">> nir  (B08): ${B08_ENTRY}"

# ---- 3) destination (R2 /vsis3 or local) ------------------------------------
if [ -n "$R2_BUCKET" ]; then
  : "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID for R2}"
  : "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID for R2}"
  : "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY for R2}"
  export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto
  export CPL_VSIL_USE_TEMP_FILE_FOR_RANDOM_WRITE=YES   # COG driver needs this for /vsis3
  DEST="/vsis3/${R2_BUCKET}/${R2_PREFIX}/${OUT_NAME}"
  if [ "${FORCE:-0}" != "1" ] && gdalinfo "$DEST" >/dev/null 2>&1; then
    echo "= skip (already in R2): ${R2_PREFIX}/${OUT_NAME}"; exit 0
  fi
  echo ">> destination: s3://${R2_BUCKET}/${R2_PREFIX}/${OUT_NAME}"
else
  mkdir -p "$OUTPUT_DIR"; DEST="${OUTPUT_DIR}/${OUT_NAME}"
  echo ">> destination: ${DEST}  (local)"
fi

# ---- 4) compute NDVI -> Float32, then write a COG ---------------------------
# Fill pixels (edge granules: no acquisition) have B04==B08==0. We mask those to
# the NoData sentinel so viewers render them transparent instead of as NDVI==0
# (which a colormap would otherwise paint as a solid block of colour).
TMP="${STAGING}/${BASE}_ndvi_f32.tif"
NODATA=-9999
echo ">> computing NDVI (this decodes two 10 m bands; takes a minute) ..."
gdal_calc.py --quiet --overwrite \
  -A "$B08" -B "$B04" \
  --calc="where((A+B)==0, ${NODATA}, (A.astype('float32')-B.astype('float32'))/(A.astype('float32')+B.astype('float32')+1e-6))" \
  --NoDataValue=${NODATA} --type=Float32 --outfile="$TMP"

echo ">> writing COG ..."
gdal_translate -q -of COG -a_nodata ${NODATA} \
  -co COMPRESS=DEFLATE -co PREDICTOR=3 -co RESAMPLING=AVERAGE \
  "$TMP" "$DEST"
rm -f "$TMP"

# ---- 5) report --------------------------------------------------------------
if [ -n "$R2_BUCKET" ]; then
  if [ -n "$R2_PUBLIC_BASE" ]; then
    echo "+ NDVI COG: ${R2_PUBLIC_BASE%/}/${R2_PREFIX}/${OUT_NAME}"
  else
    echo "+ NDVI COG: s3://${R2_BUCKET}/${R2_PREFIX}/${OUT_NAME}"
  fi
else
  echo "+ NDVI COG: ${DEST}"
fi
echo ">> done."
