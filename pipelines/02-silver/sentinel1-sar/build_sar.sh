#!/usr/bin/env bash
#
# build_sar.sh
# Silver step: Sentinel-1 GRD VV -> geocoded backscatter (dB) Cloud-Optimized
# GeoTIFF on Cloudflare R2.
#
#   Input  : a raw S1 IW GRD .SAFE.zip (CopPhil stores measurement bands as COG),
#            staged from R2 bronze or a local file.
#   Steps  : extract VV (ground-range, GCP-geolocated) -> gdalwarp to EPSG:4326
#            -> VV in dB = 10*log10(DN^2) -> COG under 02-silver/sentinel1-sar/.
#
# NOTE — this is geocoded *backscatter*, the honest SAR primitive. It is NOT a
# validated flood map. Flood delineation needs radiometric calibration, speckle
# filtering, terrain correction and change detection vs a dry reference (a SNAP /
# pyroSAR pipeline) — or use authoritative Copernicus EMS / GFM flood products.
# This COG is the base layer such processing would build on. See pipelines/README.md.
#
# Parameters (env): SCENE, SAFE, BRONZE_PREFIX, OUTPUT_DIR, STAGING, FORCE, POL
#   (polarisation, default vv), and the R2_* / AWS_* set from .env.
# Requires GDAL >= 3.8, curl, unzip.
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
while [ "$REPO_ROOT" != "/" ]; do
  if [ -e "$REPO_ROOT/.git" ] || [ -e "$REPO_ROOT/AGENTS.md" ]; then break; fi
  REPO_ROOT="$(dirname "$REPO_ROOT")"
done
for _envf in "${ENV_FILE:-}" "${PWD}/.env" "${REPO_ROOT}/.env" "${SCRIPT_DIR}/.env"; do
  if [ -n "$_envf" ] && [ -f "$_envf" ]; then
    echo ">> loading env from ${_envf}"; set -a; . "$_envf"; set +a; break
  fi
done

BRONZE_PREFIX="${BRONZE_PREFIX:-01-bronze/copphil-sentinel}"
SCENE="${SCENE:-S1D_IW_GRDH_1SDV_20260613T214635_20260613T214706_003223_0059FF_B12E_COG.SAFE.zip}"
POL="${POL:-vv}"
STAGING="${STAGING:-${REPO_ROOT}/eodata/_staging}"
OUTPUT_DIR="${OUTPUT_DIR:-${REPO_ROOT}/eodata}"
R2_BUCKET="${R2_BUCKET:-}"; R2_PREFIX="${R2_PREFIX:-02-silver/sentinel1-sar}"
R2_PUBLIC_BASE="${R2_PUBLIC_BASE:-}"
mkdir -p "$STAGING"

# early skip: if the R2 output already exists, do NOT download/stage anything
if [ -n "$R2_BUCKET" ] && [ "${FORCE:-0}" != "1" ] && [ -n "${R2_ACCOUNT_ID:-}" ]; then
  _src="$(basename "${SAFE:-$SCENE}")"; _b="${_src%.zip}"; _b="${_b%.SAFE}"
  export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto
  if gdalinfo "/vsis3/${R2_BUCKET}/${R2_PREFIX}/${_b}_${POL^^}_dB.tif" >/dev/null 2>&1; then
    echo "= skip (already in R2): ${R2_PREFIX}/${_b}_${POL^^}_dB.tif"; exit 0
  fi
fi

# 1) stage the SAFE zip
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
    curl -fsSL --retry 3 -o "${ZIP}.part" "$URL"; mv "${ZIP}.part" "$ZIP"
  fi
fi
BASE="$(basename "$ZIP")"; BASE="${BASE%.zip}"; BASE="${BASE%.SAFE}"
OUT_NAME="${BASE}_${POL^^}_dB.tif"

# 2) locate the measurement band for the requested polarisation
ENTRY="$(unzip -Z1 "$ZIP" | grep -iE "measurement/.*-${POL}-.*\.tiff?$" | head -1 || true)"
[ -n "$ENTRY" ] || { echo "!! no ${POL} measurement band in ${ZIP}" >&2; exit 1; }
VV="/vsizip/${ZIP}/${ENTRY}"; echo ">> ${POL^^}: ${ENTRY}"

# 3) destination
if [ -n "$R2_BUCKET" ]; then
  : "${R2_ACCOUNT_ID:?}"; : "${AWS_ACCESS_KEY_ID:?}"; : "${AWS_SECRET_ACCESS_KEY:?}"
  export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto CPL_VSIL_USE_TEMP_FILE_FOR_RANDOM_WRITE=YES
  DEST="/vsis3/${R2_BUCKET}/${R2_PREFIX}/${OUT_NAME}"
  if [ "${FORCE:-0}" != "1" ] && gdalinfo "$DEST" >/dev/null 2>&1; then
    echo "= skip (already in R2): ${R2_PREFIX}/${OUT_NAME}"; exit 0; fi
  echo ">> destination: s3://${R2_BUCKET}/${R2_PREFIX}/${OUT_NAME}"
else
  mkdir -p "$OUTPUT_DIR"; DEST="${OUTPUT_DIR}/${OUT_NAME}"; echo ">> destination: ${DEST} (local)"
fi

# 4) geocode (GCP -> EPSG:4326), convert amplitude DN -> dB, write COG
GEO="${STAGING}/${BASE}_${POL}_geo.tif"
DB="${STAGING}/${BASE}_${POL}_db.tif"
echo ">> geocoding VV (GCP warp -> EPSG:4326) ..."
gdalwarp -q -overwrite -t_srs EPSG:4326 -r bilinear -dstnodata 0 \
  -multi -wo NUM_THREADS=ALL_CPUS "$VV" "$GEO"
echo ">> converting amplitude -> dB ..."
gdal_calc.py --quiet --overwrite -A "$GEO" \
  --calc="numpy.where(A==0,-9999,10.0*numpy.log10(A.astype('float32')**2+1.0))" \
  --NoDataValue=-9999 --type=Float32 --outfile="$DB"
echo ">> writing COG ..."
gdal_translate -q -of COG -co COMPRESS=DEFLATE -co PREDICTOR=3 -co RESAMPLING=AVERAGE \
  -a_nodata -9999 "$DB" "$DEST"
rm -f "$GEO" "$DB"

# 5) report
if [ -n "$R2_BUCKET" ] && [ -n "$R2_PUBLIC_BASE" ]; then
  echo "+ SAR backscatter COG: ${R2_PUBLIC_BASE%/}/${R2_PREFIX}/${OUT_NAME}"
else echo "+ SAR backscatter COG: ${DEST}"; fi
echo ">> done."
