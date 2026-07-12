#!/usr/bin/env bash
#
# build_ratio.sh
# Silver step: Sentinel-1 GRD dual-pol -> geocoded VH/VV cross-ratio (dB)
# Cloud-Optimized GeoTIFF on Cloudflare R2.
#
#   Input  : a raw S1 IW GRDH 1SDV .SAFE.zip (dual-pol VV+VH; CopPhil stores
#            measurement bands as COG), resolved local-first: local bronze dir
#            -> R2-download cache -> R2.
#   Steps  : warp VV and VH (ground-range, GCP-geolocated) to EPSG:4326 on an
#            identical grid -> ratio_dB = 10*log10(VH^2) - 10*log10(VV^2)
#            -> COG under 02-silver/sentinel1-ratio/.
#
# WHY a ratio — this is the single-index SAR product the parametric-trigger
# workflow needs (see TODO "SAR fallback"): VH is volume-scattering dominated,
# so the cross-ratio RISES with crop canopy growth ("up = more crop", like
# NDVI) and works through monsoon cloud. Dividing the two polarisations also
# cancels the per-scene gain of the uncalibrated dB backscatter to first
# order, so a fixed display stretch reads consistently scene-to-scene —
# unlike the single-pol VV layer.
#
# NOTE — honest limits: the input DNs are NOT radiometrically calibrated and
# the per-polarisation calibration LUTs do not cancel exactly, so absolute
# values carry a small per-scene offset; the ratio of two independently
# speckled channels is noisier per pixel than either band (zone-level
# statistics average it out — that is the intended use). This is an index
# layer for zone stats / trigger thresholds, not a calibrated crop product.
#
# Parameters (env): SCENE (default: newest *GRDH*.zip in BRONZE_DIR), SAFE,
#   BRONZE_DIR, BRONZE_PREFIX, OUTPUT_DIR, STAGING, FORCE, and the R2_* /
#   AWS_* creds from .env (output prefix hardcoded: 02-silver/sentinel1-ratio).
#   BRONZE_DIR = local dir of raw scenes (default <repo>/eodata; checked before R2).
# Requires GDAL >= 3.11 (`gdal vsi copy` for R2 staging), curl, unzip, python3.
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
while [ "$REPO_ROOT" != "/" ]; do
  if [ -e "$REPO_ROOT/.git" ] || [ -e "$REPO_ROOT/AGENTS.md" ]; then break; fi
  REPO_ROOT="$(dirname "$REPO_ROOT")"
done
# shared R2 creds — the single repo-root .env only (ENV_FILE overrides the path)
. "${REPO_ROOT}/pipelines/lib/load_env.sh"
for _envf in "${ENV_FILE:-}" "${REPO_ROOT}/.env"; do
  if [ -n "$_envf" ] && [ -f "$_envf" ]; then
    echo ">> loading env from ${_envf}"; load_env "$_envf"; break
  fi
done

BRONZE_PREFIX="${BRONZE_PREFIX:-01-bronze/copphil-sentinel}"
SCENE="${SCENE:-}"
BRONZE_DIR="${BRONZE_DIR:-${REPO_ROOT}/eodata}"        # local bronze scenes (download_copphil_eodata.py --out)
STAGING="${STAGING:-${REPO_ROOT}/eodata/_staging}"     # cache for scenes pulled from R2
OUTPUT_DIR="${OUTPUT_DIR:-${REPO_ROOT}/eodata}"
R2_BUCKET="${R2_BUCKET:-}"
R2_PREFIX="02-silver/sentinel1-ratio"   # hardcoded per tier/dataset — see pipelines/README.md
R2_PUBLIC_BASE="${R2_PUBLIC_BASE:-}"
mkdir -p "$STAGING"

# no SCENE/SAFE given: default to the newest local bronze S1 scene
if [ -z "$SCENE" ] && [ -z "${SAFE:-}" ]; then
  _latest="$(ls -t "${BRONZE_DIR}"/*GRDH*.zip 2>/dev/null | head -1 || true)"
  if [ -z "$_latest" ]; then
    echo "!! set SCENE=<bronze .SAFE.zip> or SAFE=<local path> (no *GRDH*.zip in ${BRONZE_DIR})" >&2
    exit 1
  fi
  SCENE="$(basename "$_latest")"
  echo ">> SCENE not set — using newest local bronze scene: ${SCENE}"
fi

# early skip: if the R2 output already exists, do NOT download/stage anything
if [ -n "$R2_BUCKET" ] && [ "${FORCE:-0}" != "1" ] && [ -n "${R2_ACCOUNT_ID:-}" ]; then
  _src="$(basename "${SAFE:-$SCENE}")"; _b="${_src%.zip}"; _b="${_b%.SAFE}"
  export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_VIRTUAL_HOSTING=FALSE AWS_DEFAULT_REGION=auto
  if gdalinfo "/vsis3/${R2_BUCKET}/${R2_PREFIX}/${_b}_VHVV_dB.tif" >/dev/null 2>&1; then
    echo "= skip (already in R2): ${R2_PREFIX}/${_b}_VHVV_dB.tif"; exit 0
  fi
fi

# 1) stage the SAFE zip — local first (bronze dir, then R2-download cache), R2 last
if [ -n "${SAFE:-}" ] && [ -f "${SAFE}" ]; then ZIP="$SAFE"; echo ">> input: local ${ZIP}"
elif [ -s "${BRONZE_DIR}/${SCENE}" ]; then ZIP="${BRONZE_DIR}/${SCENE}"; echo ">> input: local bronze ${ZIP}"
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
OUT_NAME="${BASE}_VHVV_dB.tif"

# 2) locate the two measurement bands (dual-pol product required)
ENTRY_VV="$(unzip -Z1 "$ZIP" | grep -iE "measurement/.*-vv-.*\.tiff?$" | head -1 || true)"
ENTRY_VH="$(unzip -Z1 "$ZIP" | grep -iE "measurement/.*-vh-.*\.tiff?$" | head -1 || true)"
[ -n "$ENTRY_VV" ] || { echo "!! no vv measurement band in ${ZIP}" >&2; exit 1; }
[ -n "$ENTRY_VH" ] || { echo "!! no vh measurement band in ${ZIP} (single-pol product?)" >&2; exit 1; }
VV="/vsizip/${ZIP}/${ENTRY_VV}"; echo ">> VV: ${ENTRY_VV}"
VH="/vsizip/${ZIP}/${ENTRY_VH}"; echo ">> VH: ${ENTRY_VH}"

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

# 4) geocode both polarisations onto ONE grid, ratio in dB, write COG.
# The two bands share the same GCP set, so identical warps would already line
# up — but VH is pinned to VV's exact extent/size (-te/-ts) so the ratio never
# sees a half-pixel drift.
GEO_VV="${STAGING}/${BASE}_vv_geo.tif"
GEO_VH="${STAGING}/${BASE}_vh_geo.tif"
RATIO="${STAGING}/${BASE}_vhvv_db.tif"
echo ">> geocoding VV (GCP warp -> EPSG:4326) ..."
gdalwarp -q -overwrite -t_srs EPSG:4326 -r bilinear -dstnodata 0 \
  -multi -wo NUM_THREADS=ALL_CPUS "$VV" "$GEO_VV"
read -r XS YS XMIN YMIN XMAX YMAX < <(python3 - "$GEO_VV" <<'PY'
import json, subprocess, sys
info = json.loads(subprocess.check_output(["gdalinfo", "-json", sys.argv[1]]))
gt = info["geoTransform"]; xs, ys = info["size"]
xmin, ymax = gt[0], gt[3]
print(xs, ys, xmin, ymax + gt[5] * ys, xmin + gt[1] * xs, ymax)
PY
)
echo ">> geocoding VH (same grid: ${XS}x${YS}) ..."
gdalwarp -q -overwrite -t_srs EPSG:4326 -r bilinear -dstnodata 0 \
  -te "$XMIN" "$YMIN" "$XMAX" "$YMAX" -ts "$XS" "$YS" \
  -multi -wo NUM_THREADS=ALL_CPUS "$VH" "$GEO_VH"
echo ">> computing VH/VV cross-ratio (dB) ..."
gdal_calc.py --quiet --overwrite -A "$GEO_VV" -B "$GEO_VH" \
  --calc="numpy.where((A>0)&(B>0),10.0*numpy.log10(B.astype('float32')**2+1.0)-10.0*numpy.log10(A.astype('float32')**2+1.0),-9999)" \
  --NoDataValue=-9999 --type=Float32 --outfile="$RATIO"
echo ">> writing COG ..."
gdal_translate -q -of COG -co COMPRESS=DEFLATE -co PREDICTOR=3 -co RESAMPLING=AVERAGE \
  -a_nodata -9999 "$RATIO" "$DEST"
rm -f "$GEO_VV" "$GEO_VH" "$RATIO"

# 5) report
if [ -n "$R2_BUCKET" ] && [ -n "$R2_PUBLIC_BASE" ]; then
  echo "+ VH/VV cross-ratio COG: ${R2_PUBLIC_BASE%/}/${R2_PREFIX}/${OUT_NAME}"
else echo "+ VH/VV cross-ratio COG: ${DEST}"; fi
echo ">> done."
