#!/usr/bin/env bash
# Tag a STAC collection's sensitivity in pgSTAC.
#
#   deploy/scripts/tag-collection-access.sh <local|prod> <collection-id> <open|restricted>
#   deploy/scripts/tag-collection-access.sh prod sentinel1-flood restricted
#   deploy/scripts/tag-collection-access.sh prod --list        # show every collection's tag
#
# What this writes: a `philsa:access` property on the collection document,
# alongside the `philsa:source_product` / `philsa:metadata_updated` properties the
# catalog already carries.
#
# IMPORTANT — this tag is DOCUMENTATION, not enforcement. It exists so a consumer
# (or an auditor) can see which tier a collection belongs to. The thing that
# actually refuses the request is the gateway's RESTRICTED_COLLECTIONS var in
# deploy/gateway/wrangler.toml. Change one and you must change the other; they are
# deliberately separate because the enforcement point must keep working even if
# the database is unreachable, and because a compromised catalog writer must not
# be able to silently open the restricted tier.
#
# Writes go straight to the database, not over the public API — prod's STAC API is
# read-only (ENABLE_TRANSACTIONS_EXTENSIONS=false), which is the whole point.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

ENV_NAME="${1:-}"
load_env "$ENV_NAME"

psql_run() {
  if command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
  else
    # No local psql? Borrow the one inside the postgres image.
    command -v docker >/dev/null 2>&1 || die "need either psql or docker on PATH."
    docker run --rm -i postgres:16-alpine psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
  fi
}

if [ "${2:-}" = "--list" ]; then
  info "collection sensitivity tags in '$ENV_NAME':"
  psql_run -At -c "
    SELECT id || E'\t' || COALESCE(content->>'philsa:access', 'open (untagged)')
    FROM pgstac.collections
    ORDER BY (content->>'philsa:access') IS NULL, id;
  " | column -t -s $'\t'
  exit 0
fi

COLLECTION="${2:-}"
ACCESS="${3:-}"
[ -n "$COLLECTION" ] || die "usage: $0 <local|prod> <collection-id> <open|restricted>"
case "$ACCESS" in
  open|restricted) ;;
  *) die "access tier must be 'open' or 'restricted' (got '${ACCESS:-nothing}')" ;;
esac

# Fail loudly on a typo'd id rather than silently updating zero rows.
exists=$(psql_run -At -c "SELECT count(*) FROM pgstac.collections WHERE id = '$COLLECTION';")
[ "$exists" = "1" ] || die "collection '$COLLECTION' does not exist in the '$ENV_NAME' catalog."

info "tagging '$COLLECTION' as philsa:access=$ACCESS in '$ENV_NAME' …"

# pgstac.update_collection() re-runs the collection's triggers (partition and
# search bookkeeping), which a bare UPDATE on the table would skip.
psql_run -q -c "
  SELECT pgstac.update_collection(
    (SELECT content || jsonb_build_object('philsa:access', '$ACCESS')
     FROM pgstac.collections WHERE id = '$COLLECTION')
  );
"

updated=$(psql_run -At -c "SELECT content->>'philsa:access' FROM pgstac.collections WHERE id = '$COLLECTION';")
[ "$updated" = "$ACCESS" ] || die "tag did not stick (read back '$updated')."
info "done — '$COLLECTION' is now tagged '$updated'."

if [ "$ACCESS" = "restricted" ]; then
  cat <<EOF

  Reminder — tagging alone changes nothing about who can read the data. To make
  this restriction real, all three must be true:

    1. deploy/gateway/wrangler.toml  RESTRICTED_COLLECTIONS includes '$COLLECTION'
       and RESTRICTED_ASSET_PREFIXES covers its R2 objects  (then redeploy both
       gateway environments).
    2. The collection's asset bytes live in the PRIVATE R2 bucket, not the public
       one — otherwise they stay downloadable from the public r2.dev host, which
       bypasses the gateway entirely. See deploy/scripts/move-assets-private.sh.
    3. The item asset hrefs point at the gateway's /assets/sign endpoint.

EOF
fi
