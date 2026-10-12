"""stac_write.py — guard for scripts that WRITE to a STAC API.

The public prod STAC API is read-only (ENABLE_TRANSACTIONS_EXTENSIONS=false in
render.yaml); prod writes go through the private, ephemeral API that
deploy/scripts/prod-ingest.sh stands up on localhost. A writer pointed at a
read-only target would otherwise fail as a wall of 405s partway through a run.
ensure_writable() asks the target itself — via its advertised conformance
classes — so the check holds for any hostname, present or future.

Stdlib only, imported the same way as r2.py (sys.path.insert of this dir).
"""
import json
import sys
import urllib.request

TIMEOUT = 30

# STAC/OGC Transaction conformance markers (stac-fastapi advertises
# ".../ogcapi-features/extensions/transaction" and ".../conf/simpletx"
# only when transactions are enabled).
_TRANSACTION_MARKERS = ("/extensions/transaction", "/conf/simpletx")

# Cloudflare (which fronts the prod gateway) answers urllib's default
# "Python-urllib/x.y" User-Agent with 403, which made this probe fail open
# against exactly the host it exists to refuse. Identify ourselves instead.
USER_AGENT = "philsa-poc-pipelines (stac_write.ensure_writable)"


def ensure_writable(api, timeout=TIMEOUT):
    """Exit early, with a pointer to prod-ingest.sh, if `api` is read-only.

    Probes GET {api}/conformance for the Transaction extension. A network or
    parse failure is NOT fatal here — the writer's own first request will
    surface that error in context.
    """
    try:
        req = urllib.request.Request(
            f"{api.rstrip('/')}/conformance",
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            conforms = json.load(r).get("conformsTo", [])
    except Exception as e:  # fail open, but say so — a silent pass hides a misconfigured target
        print(f"warning: could not verify {api} is writable ({e}); continuing — "
              "the first write will report the real error.", file=sys.stderr)
        return
    if not any(m in c for c in conforms for m in _TRANSACTION_MARKERS):
        sys.exit(
            f"error: {api} is a READ-ONLY STAC API (no Transaction extension in "
            "/conformance) — every write would 405.\n"
            "Ingest a deployed environment through the private write API instead:\n"
            "  deploy/scripts/prod-ingest.sh <env> [flags]    # e.g. prod --silver-only"
        )
