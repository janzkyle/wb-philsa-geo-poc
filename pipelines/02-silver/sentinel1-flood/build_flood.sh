#!/usr/bin/env bash
#
# build_flood.sh
# Silver step: Sentinel-1 VV backscatter (dB) -> open-water / flood mask
# Cloud-Optimized GeoTIFF on Cloudflare R2.
#
#   Input  : an EXISTING silver VV-dB COG (built by ../sentinel1-sar/build_sar.sh),
#            read from R2 silver or a local file. We deliberately build on the
#            silver primitive rather than re-deriving from the raw SAFE.
#   Steps  : Otsu (or fixed) dB threshold -> Byte mask (1=water,0=land,255=nodata)
#            -> COG under 02-silver/sentinel1-flood/.
#
# NOTE — POC flood proxy, NOT a validated product. No radiometric calibration,
# speckle filter or terrain correction; SAR shadow and smooth dry surfaces can
# read as false water. Complements (does not replace) Copernicus EMS / GFM, the
# authoritative reference layer. Rigorous route = change-detection vs a dry-season
# reference (SNAP / pyroSAR). See pipelines/README.md and TODO.md.
#
# Parameters (env): SAR_NAME (silver VV-dB COG basename) or SRC (local file),
#   SAR_PREFIX (silver SAR R2 prefix), OUTPUT_DIR, STAGING, FORCE, METHOD
#   (sigma|otsu|fixed; default sigma), THRESHOLD (dB, for fixed), K (sigma cut,
#   mean-K*std), MIN_DB, PERM_WATER (optional mask),
#   and the R2_* / AWS_* set from .env.
# Requires GDAL >= 3.8 (incl. python bindings) + numpy, curl.
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
    # disable -u while sourcing: unrelated values may contain a literal '$'
    # (e.g. a password) that would otherwise abort on "unbound variable".
    echo ">> loading env from ${_envf}"; set +u; set -a; . "$_envf"; set +a; set -u; break
  fi
done

SAR_PREFIX="${SAR_PREFIX:-02-silver/sentinel1-sar}"
SAR_NAME="${SAR_NAME:-S1D_IW_GRDH_1SDV_20260613T214635_20260613T214706_003223_0059FF_B12E_COG_VV_dB.tif}"
METHOD="${METHOD:-sigma}"
STAGING="${STAGING:-${REPO_ROOT}/eodata/_staging}"
OUTPUT_DIR="${OUTPUT_DIR:-${REPO_ROOT}/eodata}"
R2_BUCKET="${R2_BUCKET:-}"; R2_PREFIX="${R2_PREFIX:-02-silver/sentinel1-flood}"
R2_PUBLIC_BASE="${R2_PUBLIC_BASE:-}"
mkdir -p "$STAGING"

# derive output name from the source SAR COG: ..._VV_dB.tif -> ..._VV_flood.tif
SRC_BASE="$(basename "${SRC:-$SAR_NAME}")"
OUT_NAME="${SRC_BASE%.tif}"; OUT_NAME="${OUT_NAME%_dB}"; OUT_NAME="${OUT_NAME}_flood.tif"

# early skip: if the R2 output already exists, do nothing
if [ -n "$R2_BUCKET" ] && [ "${FORCE:-0}" != "1" ] && [ -n "${R2_ACCOUNT_ID:-}" ]; then
  export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto
  if gdalinfo "/vsis3/${R2_BUCKET}/${R2_PREFIX}/${OUT_NAME}" >/dev/null 2>&1; then
    echo "= skip (already in R2): ${R2_PREFIX}/${OUT_NAME}"; exit 0
  fi
fi

# 1) resolve the input silver VV-dB COG (prefer reading straight over /vsis3)
if [ -n "${SRC:-}" ] && [ -f "${SRC}" ]; then
  IN="$SRC"; echo ">> input: local ${IN}"
elif [ -n "$R2_BUCKET" ] && [ -n "${R2_ACCOUNT_ID:-}" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
  export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto
  IN="/vsis3/${R2_BUCKET}/${SAR_PREFIX}/${SAR_NAME}"; echo ">> input (vsis3): ${IN}"
else
  : "${R2_PUBLIC_BASE:?need R2_PUBLIC_BASE (or pass SRC=local.tif)}"
  IN="/vsicurl/${R2_PUBLIC_BASE%/}/${SAR_PREFIX}/${SAR_NAME}"; echo ">> input (vsicurl): ${IN}"
fi

# 2) classify -> Byte mask (intermediate GeoTIFF)
MASK="${STAGING}/${OUT_NAME%.tif}_mask.tif"
CLASSIFY=(python3 "${SCRIPT_DIR}/otsu_flood.py" "$IN" "$MASK" --method "$METHOD")
[ -n "${THRESHOLD:-}" ] && CLASSIFY+=(--threshold "$THRESHOLD")
[ -n "${K:-}" ] && CLASSIFY+=(--k "$K")
[ -n "${MIN_DB:-}" ] && CLASSIFY+=(--min-db "$MIN_DB")
[ -n "${PERM_WATER:-}" ] && CLASSIFY+=(--perm-water "$PERM_WATER")
echo ">> classifying flood (${METHOD}) ..."
"${CLASSIFY[@]}"

# 3) destination
if [ -n "$R2_BUCKET" ]; then
  : "${R2_ACCOUNT_ID:?}"; : "${AWS_ACCESS_KEY_ID:?}"; : "${AWS_SECRET_ACCESS_KEY:?}"
  export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto CPL_VSIL_USE_TEMP_FILE_FOR_RANDOM_WRITE=YES
  DEST="/vsis3/${R2_BUCKET}/${R2_PREFIX}/${OUT_NAME}"
  echo ">> destination: s3://${R2_BUCKET}/${R2_PREFIX}/${OUT_NAME}"
else
  mkdir -p "$OUTPUT_DIR"; DEST="${OUTPUT_DIR}/${OUT_NAME}"; echo ">> destination: ${DEST} (local)"
fi

# 4) write COG (nearest — categorical mask, must not be averaged)
echo ">> writing COG ..."
gdal_translate -q -of COG -co COMPRESS=DEFLATE -co RESAMPLING=NEAREST \
  -a_nodata 255 "$MASK" "$DEST"
rm -f "$MASK"

# 5) report
if [ -n "$R2_BUCKET" ] && [ -n "$R2_PUBLIC_BASE" ]; then
  echo "+ flood mask COG: ${R2_PUBLIC_BASE%/}/${R2_PREFIX}/${OUT_NAME}"
else echo "+ flood mask COG: ${DEST}"; fi
echo ">> done."
