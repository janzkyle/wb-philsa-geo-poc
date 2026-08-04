#!/usr/bin/env bash
# Move a collection's asset BYTES between the open (public) and restricted
# (private) R2 buckets, and repoint its STAC item hrefs to match.
#
#   move_assets_tier.sh prod sentinel1-flood restrict            # DRY RUN
#   move_assets_tier.sh prod sentinel1-flood restrict --apply    # open  -> restricted
#   move_assets_tier.sh prod sentinel1-flood open    --apply     # restricted -> open
#   ... --keep-source    # copy + repoint, but don't delete the origin copies
#   ... --yes            # skip the confirmation prompt when publishing
#
# WHY THIS EXISTS
# ---------------
# Listing a collection in the gateway's RESTRICTED_COLLECTIONS stops the CATALOG
# and the TILER from serving it. It does NOT stop anyone fetching the COG straight
# off the public r2.dev host — those objects are world-readable and the gateway is
# not in that path. Until the bytes move, the restriction is metadata only. This
# script is the difference between "restricted" and "actually restricted", and
# `open` is the same operation run backwards.
#
# ORDER OF OPERATIONS (both directions)
#   copy -> verify count AND bytes -> repoint the catalog -> delete the origin
# Nothing destructive happens until the destination is verified, and the hrefs are
# repointed before the delete, so there is never a window where the catalog points
# at bytes that no longer exist. A failure part-way leaves the data reachable
# rather than gone, and re-running is safe — the copy is idempotent.
set -euo pipefail

# Resolve the repo root by walking up for .git / AGENTS.md, the same convention
# every pipeline script uses, so this works from any cwd and from the skill dir.
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT=""
_d="$_here"
while [ "$_d" != "/" ]; do
  if [ -e "$_d/.git" ] || [ -f "$_d/AGENTS.md" ]; then REPO_ROOT="$_d"; break; fi
  _d="$(dirname "$_d")"
done
[ -n "$REPO_ROOT" ] || { printf 'error: could not locate the repo root from %s\n' "$_here" >&2; exit 1; }
# lib.sh derives DEPLOY_DIR/REPO_ROOT from its own location, so sourcing it from
# anywhere is safe — don't reimplement its helpers here.
. "$REPO_ROOT/deploy/scripts/lib.sh"

ENV_NAME="${1:-}"
COLLECTION="${2:-}"
DIRECTION="${3:-}"
case "$DIRECTION" in
  restrict|open) ;;
  *) die "usage: $0 <local|prod> <collection-id> <restrict|open> [--apply] [--keep-source] [--yes]" ;;
esac
[ -n "$COLLECTION" ] || die "usage: $0 <local|prod> <collection-id> <restrict|open> [--apply] [--keep-source] [--yes]"
load_env "$ENV_NAME"

APPLY=false
KEEP_SOURCE=false
ASSUME_YES=false
for a in "$@"; do
  case "$a" in
    --apply) APPLY=true ;;
    # --keep-public is the old name from move-assets-private.sh; still accepted.
    --keep-source|--keep-public) KEEP_SOURCE=true ;;
    --yes|-y) ASSUME_YES=true ;;
  esac
done

# R2 credentials come from the repo-root .env (the same ones TiTiler and the
# loaders use). Never committed.
[ -f "$REPO_ROOT/.env" ] || die "missing $REPO_ROOT/.env (needs AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_ACCOUNT_ID / R2_BUCKET)."
set -a; . "$REPO_ROOT/.env"; set +a

: "${R2_ACCOUNT_ID:?not set in .env}"
: "${R2_BUCKET:?not set in .env}"
: "${R2_PUBLIC_BASE:?not set in .env}"
PRIVATE_BUCKET="${R2_PRIVATE_BUCKET:-world-bank-philsa-geo-private}"
ENDPOINT="${AWS_ENDPOINT_URL_S3:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
PREFIX="${ASSET_PREFIX:-02-silver/${COLLECTION}/}"

# The one asymmetry between the two directions: which bucket is source, which is
# destination, and what the hrefs turn from and into. Everything below is shared.
#
# The restricted href is an `s3://` URI, NOT the bucket's https endpoint. TiTiler
# reads assets through GDAL, and only the s3:// form makes GDAL use /vsis3/ and
# SIGN the request with TiTiler's own R2 credentials. Handed the https endpoint it
# does a plain unsigned range GET and R2 rejects it — verified: the tiler returns
# 500 for the https form and 200 for s3://. s3:// also reads correctly as "these
# bytes are not directly fetchable"; clients exchange it for a time-limited URL at
# the gateway's /assets/sign.
if [ "$DIRECTION" = "restrict" ]; then
  SRC_BUCKET="$R2_BUCKET";      DST_BUCKET="$PRIVATE_BUCKET"
  OLD_BASE="${R2_PUBLIC_BASE}";  NEW_BASE="s3://${PRIVATE_BUCKET}"
  SRC_LABEL="public";            DST_LABEL="private"
else
  SRC_BUCKET="$PRIVATE_BUCKET"; DST_BUCKET="$R2_BUCKET"
  OLD_BASE="s3://${PRIVATE_BUCKET}"; NEW_BASE="${R2_PUBLIC_BASE}"
  SRC_LABEL="private";           DST_LABEL="public"
fi

command -v aws >/dev/null 2>&1 || die "the AWS CLI is required (brew install awscli); it speaks R2's S3 API."

aws_r2() { AWS_DEFAULT_REGION=auto aws --endpoint-url "$ENDPOINT" "$@"; }

# R2 implements CopyObject but NOT the S3 object-tagging API, and `aws s3 cp`
# insists on tagging one way or another for a bucket-to-bucket copy:
#
#   --copy-props default (the default)  -> calls GetObjectTagging
#                                          "NotImplemented: GetObjectTagging"
#   --copy-props none                   -> sends x-amz-tagging-directive: REPLACE
#   --copy-props metadata-directive     -> also sends x-amz-tagging-directive
#                                          "NotImplemented: Header
#                                           'x-amz-tagging-directive' ... "
#
# All three were tried against R2; all three fail, and they fail *per object*, so
# a run leaves a partial copy behind. The low-level `s3api copy-object` sends only
# the headers we pass it, which R2 accepts — that's what copy_prefix uses. These
# COGs carry no tags or custom metadata, so nothing is lost in the switch.
# NB: iterate with `while read`, not `for key in $keys`. Unquoted word-splitting
# is a bash-ism — zsh leaves the whole listing as ONE word, which turns into a
# single copy-object call with every key concatenated ("InvalidObjectName").
# Reading line by line behaves the same in both shells. The here-string keeps the
# loop in the current shell, so `set -e` still aborts the script on a failed copy
# rather than swallowing it in a pipeline subshell.
copy_prefix() {
  local src_bucket="$1" dst_bucket="$2" prefix="$3" keys key
  keys=$(aws_r2 s3api list-objects-v2 --bucket "$src_bucket" --prefix "$prefix" \
           --query 'Contents[].Key' --output text | tr '\t' '\n')
  while IFS= read -r key; do
    [ -n "$key" ] && [ "$key" != "None" ] || continue
    aws_r2 s3api copy-object --copy-source "${src_bucket}/${key}" \
      --bucket "$dst_bucket" --key "$key" >/dev/null
    printf '    copied %s\n' "${key##*/}"
  done <<<"$keys"
}

# Total bytes under a prefix — compared source vs destination before we delete
# anything, so a truncated copy can't be mistaken for a complete one on count alone.
prefix_bytes() {
  aws_r2 s3api list-objects-v2 --bucket "$1" --prefix "$2" \
    --query 'sum(Contents[].Size)' --output text 2>/dev/null | sed 's/None/0/' | cut -d. -f1
}

psql_run() {
  if command -v psql >/dev/null 2>&1; then psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
  else
    command -v docker >/dev/null 2>&1 || die "need either psql or docker on PATH."
    docker run --rm -i postgres:16-alpine psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
  fi
}

info "collection : $COLLECTION"
info "direction  : $DIRECTION ($SRC_LABEL -> $DST_LABEL)"
info "prefix     : $PREFIX"
info "source     : s3://$SRC_BUCKET/$PREFIX"
info "destination: s3://$DST_BUCKET/$PREFIX"
info "hrefs      : ${OLD_BASE}/${PREFIX}…  ->  ${NEW_BASE}/${PREFIX}…"
$APPLY || info "MODE       : dry run (add --apply to make changes)"

count=$(aws_r2 s3 ls "s3://$SRC_BUCKET/$PREFIX" --recursive | wc -l | tr -d ' ')
[ "$count" != "0" ] || die "no objects under s3://$SRC_BUCKET/$PREFIX — nothing to move. (Already in the '$DST_LABEL' bucket?)"
info "found $count object(s) to move"

if ! $APPLY; then
  info "would copy these into s3://$DST_BUCKET/$PREFIX:"
  aws_r2 s3 ls "s3://$SRC_BUCKET/$PREFIX" --recursive | awk '{print "    " $NF}'
  info "dry run only — no objects copied, nothing deleted, catalog untouched."
  exit 0
fi

# Publishing is the direction that can't be un-leaked: once these bytes are on the
# public host they may be fetched and cached by anyone. Make it deliberate.
if [ "$DIRECTION" = "open" ] && ! $ASSUME_YES; then
  printf '\033[33mwarning:\033[0m this makes %s object(s) of "%s" WORLD-READABLE at %s\n' \
    "$count" "$COLLECTION" "$R2_PUBLIC_BASE"
  if [ -t 0 ]; then
    printf 'Type the collection id to confirm: '
    read -r reply
    [ "$reply" = "$COLLECTION" ] || die "confirmation did not match — nothing changed."
  else
    die "refusing to publish non-interactively without --yes."
  fi
fi

info "copying into the $DST_LABEL bucket …"
copy_prefix "$SRC_BUCKET" "$DST_BUCKET" "$PREFIX"

# Verify on BOTH count and total bytes before anything destructive happens. The
# copy is idempotent, so re-running after a partial failure is safe and cheap.
dst_count=$(aws_r2 s3 ls "s3://$DST_BUCKET/$PREFIX" --recursive | wc -l | tr -d ' ')
[ "$dst_count" = "$count" ] || die "copy incomplete ($dst_count/$count objects present) — $SRC_LABEL copy left untouched."
src_bytes=$(prefix_bytes "$SRC_BUCKET" "$PREFIX")
dst_bytes=$(prefix_bytes "$DST_BUCKET" "$PREFIX")
[ "$src_bytes" = "$dst_bytes" ] || die "byte totals differ ($SRC_LABEL $src_bytes vs $DST_LABEL $dst_bytes) — $SRC_LABEL copy left untouched."
info "verified $dst_count/$count objects, $dst_bytes bytes, in the $DST_LABEL bucket"

# Repoint the catalog BEFORE deleting the origin copies, so there is never a
# window where the hrefs point at bytes that no longer exist.
info "repointing STAC asset hrefs to the $DST_LABEL bucket …"
psql_run -q -c "
  UPDATE pgstac.items
     SET content = replace(content::text, '${OLD_BASE}/${PREFIX}', '${NEW_BASE}/${PREFIX}')::jsonb
   WHERE collection = '${COLLECTION}'
     AND content::text LIKE '%${OLD_BASE}/${PREFIX}%';
"
remaining=$(psql_run -At -c "SELECT count(*) FROM pgstac.items WHERE collection='${COLLECTION}' AND content::text LIKE '%${OLD_BASE}/${PREFIX}%';")
[ "$remaining" = "0" ] || die "$remaining item(s) still reference the $SRC_LABEL location — aborting before delete."
info "catalog hrefs updated"

if $KEEP_SOURCE; then
  info "--keep-source: leaving the $SRC_LABEL copies in place."
  [ "$DIRECTION" = "restrict" ] && info "the data is STILL publicly downloadable until you re-run without --keep-source."
else
  info "deleting the $SRC_LABEL copies …"
  aws_r2 s3 rm "s3://$SRC_BUCKET/$PREFIX" --recursive
  if [ "$DIRECTION" = "restrict" ]; then
    info "public copies removed — the restriction is now real."
  else
    info "private copies removed — the collection is now served from the public bucket."
  fi
fi

if [ "$DIRECTION" = "restrict" ]; then
  cat <<EOF

  Bytes are moved. The tier is NOT fully switched until you also:
    1. Add to BOTH gateway lists, then deploy BOTH workers:
         RESTRICTED_COLLECTIONS    += $COLLECTION      # [env.stac.vars] only
         RESTRICTED_ASSET_PREFIXES += $PREFIX          # [env.stac.vars] AND [env.tiles.vars]
       cd deploy/gateway && npx wrangler deploy -e stac && npx wrangler deploy -e tiles
    2. deploy/scripts/tag-collection-access.sh $ENV_NAME $COLLECTION restricted
    3. Mark it \`"access": "restricted"\` in pipelines/03-gold/catalog_silver.py
       so the next pipeline run doesn't republish it to the public bucket.
  Verify: the public host should now 404 for a moved object, and
    curl -H "X-API-Key: <key>" ".../assets/sign?url=<asset href>"  should sign it.

EOF
else
  cat <<EOF

  Bytes are public. The tier is NOT fully switched until you also:
    1. Remove from BOTH gateway lists, then deploy BOTH workers:
         RESTRICTED_COLLECTIONS    -= $COLLECTION      # [env.stac.vars] only
         RESTRICTED_ASSET_PREFIXES -= $PREFIX          # [env.stac.vars] AND [env.tiles.vars]
       cd deploy/gateway && npx wrangler deploy -e stac && npx wrangler deploy -e tiles
    2. deploy/scripts/tag-collection-access.sh $ENV_NAME $COLLECTION open
    3. Drop \`"access": "restricted"\` from pipelines/03-gold/catalog_silver.py
       so the next pipeline run keeps writing to the public bucket.
  Verify: an anonymous GET of an item's href should now return 200, and the
  collection should appear in an anonymous /collections listing.

EOF
fi
