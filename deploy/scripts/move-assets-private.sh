#!/usr/bin/env bash
# Move a restricted collection's asset bytes from the PUBLIC R2 bucket into the
# PRIVATE one, and repoint its STAC item hrefs at the private location.
#
#   deploy/scripts/move-assets-private.sh prod sentinel1-flood            # DRY RUN
#   deploy/scripts/move-assets-private.sh prod sentinel1-flood --apply    # do it
#   deploy/scripts/move-assets-private.sh prod sentinel1-flood --apply --keep-public
#
# WHY THIS EXISTS
# ---------------
# Tagging a collection `philsa:access=restricted` and listing it in the gateway's
# RESTRICTED_COLLECTIONS stops the CATALOG and the TILER from serving it. It does
# NOT stop anyone from fetching the COG straight off the public r2.dev host, since
# those objects are world-readable by design and the gateway is not in that path.
# Until the bytes move, the restriction is metadata only. This script closes that
# gap — it is the difference between "restricted" and "actually restricted".
#
# Order of operations matters. We COPY first and only delete the public copy once
# the private copy is verified, so a failure part-way leaves the data reachable
# rather than gone. --keep-public skips the delete entirely (useful for a rehearsal
# where you want to compare old and new behaviour side by side).
#
# Reversal: `aws s3 cp` the objects back and re-run tag-collection-access.sh with
# `open`. Nothing here is one-way except the public delete, which --keep-public
# defers.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

ENV_NAME="${1:-}"
COLLECTION="${2:-}"
[ -n "$COLLECTION" ] || die "usage: $0 <local|prod> <collection-id> [--apply] [--keep-public]"
load_env "$ENV_NAME"

APPLY=false
KEEP_PUBLIC=false
for a in "$@"; do
  [ "$a" = "--apply" ] && APPLY=true
  [ "$a" = "--keep-public" ] && KEEP_PUBLIC=true
done

# R2 credentials come from the repo-root .env (same ones TiTiler and the loaders
# use). They are never committed.
[ -f "$REPO_ROOT/.env" ] || die "missing $REPO_ROOT/.env (needs AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_ACCOUNT_ID / R2_BUCKET)."
set -a; . "$REPO_ROOT/.env"; set +a

: "${R2_ACCOUNT_ID:?not set in .env}"
: "${R2_BUCKET:?not set in .env}"
PRIVATE_BUCKET="${R2_PRIVATE_BUCKET:-world-bank-philsa-geo-private}"
ENDPOINT="${AWS_ENDPOINT_URL_S3:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
PREFIX="${ASSET_PREFIX:-02-silver/${COLLECTION}/}"

command -v aws >/dev/null 2>&1 || die "the AWS CLI is required (brew install awscli); it speaks R2's S3 API."

aws_r2() { AWS_DEFAULT_REGION=auto aws --endpoint-url "$ENDPOINT" "$@"; }

psql_run() {
  if command -v psql >/dev/null 2>&1; then psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
  else
    command -v docker >/dev/null 2>&1 || die "need either psql or docker on PATH."
    docker run --rm -i postgres:16-alpine psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
  fi
}

info "collection : $COLLECTION"
info "prefix     : $PREFIX"
info "public     : s3://$R2_BUCKET/$PREFIX"
info "private    : s3://$PRIVATE_BUCKET/$PREFIX"
$APPLY || info "MODE       : dry run (add --apply to make changes)"

count=$(aws_r2 s3 ls "s3://$R2_BUCKET/$PREFIX" --recursive | wc -l | tr -d ' ')
[ "$count" != "0" ] || die "no objects under s3://$R2_BUCKET/$PREFIX — nothing to move."
info "found $count object(s) to move"

if ! $APPLY; then
  aws_r2 s3 cp "s3://$R2_BUCKET/$PREFIX" "s3://$PRIVATE_BUCKET/$PREFIX" --recursive --dryrun
  info "dry run only — no objects copied, nothing deleted, catalog untouched."
  exit 0
fi

info "copying into the private bucket …"
aws_r2 s3 cp "s3://$R2_BUCKET/$PREFIX" "s3://$PRIVATE_BUCKET/$PREFIX" --recursive

private_count=$(aws_r2 s3 ls "s3://$PRIVATE_BUCKET/$PREFIX" --recursive | wc -l | tr -d ' ')
[ "$private_count" = "$count" ] || die "copy incomplete ($private_count/$count objects present) — public copy left untouched."
info "verified $private_count/$count objects in the private bucket"

# Repoint the catalog BEFORE deleting the public copy, so there is never a window
# where the hrefs point at bytes that no longer exist.
info "repointing STAC asset hrefs to the private bucket …"
PUBLIC_BASE="${R2_PUBLIC_BASE:?not set in .env}"
PRIVATE_BASE="${ENDPOINT}/${PRIVATE_BUCKET}"
psql_run -q -c "
  UPDATE pgstac.items
     SET content = replace(content::text, '${PUBLIC_BASE}/${PREFIX}', '${PRIVATE_BASE}/${PREFIX}')::jsonb
   WHERE collection = '${COLLECTION}'
     AND content::text LIKE '%${PUBLIC_BASE}/${PREFIX}%';
"
remaining=$(psql_run -At -c "SELECT count(*) FROM pgstac.items WHERE collection='${COLLECTION}' AND content::text LIKE '%${PUBLIC_BASE}/${PREFIX}%';")
[ "$remaining" = "0" ] || die "$remaining item(s) still reference the public host — aborting before delete."
info "catalog hrefs updated"

if $KEEP_PUBLIC; then
  info "--keep-public: leaving the public copies in place. The data is STILL"
  info "publicly downloadable until you re-run without --keep-public."
else
  info "deleting the public copies …"
  aws_r2 s3 rm "s3://$R2_BUCKET/$PREFIX" --recursive
  info "public copies removed — the restriction is now real."
fi

cat <<EOF

  Next:
    • Partners fetch a usable URL from the gateway:
        curl -H "X-API-Key: <key>" \\
          "https://philsa-stac-gateway.philsa.workers.dev/assets/sign?url=<asset href>"
    • Confirm the public host now 404s for a moved object.
    • Re-run deploy/scripts/tag-collection-access.sh $ENV_NAME $COLLECTION restricted
      if the tag isn't set yet.

EOF
