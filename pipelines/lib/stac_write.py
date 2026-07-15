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


def ensure_writable(api, timeout=TIMEOUT):
    """Exit early, with a pointer to prod-ingest.sh, if `api` is read-only.

    Probes GET {api}/conformance for the Transaction extension. A network or
    parse failure is NOT fatal here — the writer's own first request will
    surface that error in context.
    """
    try:
        req = urllib.request.Request(
            f"{api.rstrip('/')}/conformance",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            conforms = json.load(r).get("conformsTo", [])
    except Exception:
        return
    if not any(m in c for c in conforms for m in _TRANSACTION_MARKERS):
        sys.exit(
            f"error: {api} is a READ-ONLY STAC API (no Transaction extension in "
            "/conformance) — every write would 405.\n"
            "Ingest a deployed environment through the private write API instead:\n"
            "  deploy/scripts/prod-ingest.sh <env> [flags]    # e.g. prod --silver-only"
        )
