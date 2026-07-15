#!/usr/bin/env bash
# Apply (or show) the CORS policy on the PUBLIC R2 bucket, so browser apps can
# read mosaics/COGs cross-origin.
#
#   deploy/r2/apply-cors.sh          # apply deploy/r2/cors.json to $R2_BUCKET
#   deploy/r2/apply-cors.sh --show   # print the bucket's current CORS policy
#
# Why: the public r2.dev bucket ships with NO CORS headers, so a browser fetch/
# HEAD to a mosaic is blocked. Both the PhilSA webmap and the partner template
# then fall back from the single-source per-date MOSAIC to rendering each date's
# COGs individually (correct, just less efficient). This policy — GET/HEAD from
# any origin, Range allowed, range headers exposed — activates the mosaic
# fast-path and keeps GDAL/rasterio range reads working from the browser. It
# grants READ only; it does not expose writes (R2 API-token creds still gate PUT).
#
# Creds come from the gitignored repo-root .env (R2_BUCKET, R2_ACCOUNT_ID,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) — same as the pipelines. Needs the AWS
# CLI (the R2 S3 API is S3-compatible).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

. "${REPO_ROOT}/pipelines/lib/load_env.sh"
for _envf in "${ENV_FILE:-}" "${REPO_ROOT}/.env"; do
  if [ -n "$_envf" ] && [ -f "$_envf" ]; then load_env "$_envf"; break; fi
done

: "${R2_BUCKET:?set R2_BUCKET in .env}"
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID in .env}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID in .env}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY in .env}"
command -v aws >/dev/null 2>&1 || { echo "error: aws CLI not found" >&2; exit 1; }

export AWS_DEFAULT_REGION=auto
S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

if [ "${1:-}" = "--show" ]; then
  aws s3api get-bucket-cors --bucket "$R2_BUCKET" --endpoint-url "$S3_ENDPOINT" \
    || echo "(no CORS policy set on $R2_BUCKET)"
  exit 0
fi

echo ">> applying deploy/r2/cors.json to bucket '$R2_BUCKET' via $S3_ENDPOINT"
aws s3api put-bucket-cors \
  --bucket "$R2_BUCKET" \
  --cors-configuration "file://${SCRIPT_DIR}/cors.json" \
  --endpoint-url "$S3_ENDPOINT"
echo ">> done. Verify:  deploy/r2/apply-cors.sh --show"
echo ">> then confirm from a browser origin, e.g.:"
echo "   curl -sI -H 'Origin: https://example.org' \\"
echo "     \"\${R2_PUBLIC_BASE}/02-silver/sentinel2-ndvi/mosaics/<file>.mosaicjson\" | grep -i access-control"
