#!/usr/bin/env python3
"""
mirror_philsa_catalog.py — mirror every collection (plus a recent sample of
items) from the PhilSA STAC into the local stac-fastapi-pgstac, *by reference*.

Source (a STAC API):  https://stac.infra.copphil.philsa.gov.ph/v1
Dest   (your pgstac): http://localhost:8082   (Transactions extension enabled)

Only the STAC metadata (Collections + Items) is copied. Item assets keep their
original absolute hrefs (`s3://eodata/...` on CloudFerro, with an
`alternate.https` download URL), so nothing is re-hosted. Each mirrored record
keeps every content link — license/citation, `enclosure` (the upstream download),
extension-mandated links like `ceos-ard-specification` — and gains a rel=via link
to the original PhilSA record (mirror provenance); only the source's navigation
links are dropped, since pgstac rebuilds those. Upstream `eo:bands.common_name`
values outside the EO-extension vocabulary (`red-edge`, `coastal_blue`, …) are
normalized on ingest so the records validate.

Every mirrored collection is stamped `philsa:mirrored_from: <SRC>`. That field is
the marker for "this came from an upstream catalog by reference" — the STAC
Browser sorts collections carrying it *after* the catalog's own collections, so
PhilSA's own products keep the top of the list (stac-browser/config.js +
src/components/Catalogs.vue).

ITEM VOLUME — the source holds ~387k items across ~104 collections (sentinel-2-l1c
alone has ~117k), so a full item mirror is neither useful nor kind to the
upstream, which rate-limits (429). The default is therefore a **capped sample**
of the most recent items per collection (--max-items, default 20) purely so each
mirrored collection is browsable; the authoritative item list stays upstream,
one rel=via hop away. `--max-items 0` mirrors everything — expect hours and a
much larger DB. Every capped collection logs the cap and the true item count, so
a partial mirror never reads as a complete one.

Idempotent: POST first, and on 409 Conflict fall back to PUT, so re-running
updates in place instead of erroring.

Stdlib only. Usage:
    python3 pipelines/reference/philsa-catalog/mirror_philsa_catalog.py                       # collections + 20 recent items each
    python3 pipelines/reference/philsa-catalog/mirror_philsa_catalog.py --dry-run             # show what would happen
    python3 pipelines/reference/philsa-catalog/mirror_philsa_catalog.py --collections-only     # metadata only, no items
    python3 pipelines/reference/philsa-catalog/mirror_philsa_catalog.py --only sentinel-1-grd sentinel-2-l2a
    python3 pipelines/reference/philsa-catalog/mirror_philsa_catalog.py --max-items 0          # EVERY item (~387k — slow)
    SRC=... DST=... python3 pipelines/reference/philsa-catalog/mirror_philsa_catalog.py        # point at another STAC / target
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "lib"))
from stac_write import ensure_writable  # noqa: E402 — refuse read-only STAC targets

SRC = os.environ.get("SRC", "https://stac.infra.copphil.philsa.gov.ph/v1").rstrip("/")
DST = os.environ.get("DST", os.environ.get("STAC_API", "http://localhost:8082")).rstrip("/")
TIMEOUT = 60

# Items mirrored per collection by default. See the ITEM VOLUME note in the
# module docstring — this is a browsability sample, not the full catalog.
DEFAULT_MAX_ITEMS = 20

# PhilSA catalog review (Jul 2026): stamp every mirrored collection with a
# "Metadata Last Updated" date. The stac-browser fields.config renders the ISO
# date as "15 Jul 2026".
METADATA_UPDATED = "2026-07-15"


def augment(col):
    """Add the PhilSA-review metadata fields to a mirrored collection in place."""
    col["philsa:metadata_updated"] = METADATA_UPDATED
    # Marks the collection as mirrored-by-reference from an upstream catalog.
    # Doubles as the STAC Browser's sort key for "show these last".
    col["philsa:mirrored_from"] = SRC
    return col


def get(url, retries=4):
    """GET JSON with retries — a transient network error must not kill a long
    mirror run (the per-collection loop skip-and-logs if this still fails).
    The source rate-limits, so a 429 backs off on its Retry-After rather than
    burning one of the (short) generic retries."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == retries:
                raise
            wait = float(e.headers.get("Retry-After") or 0) or 5.0 * attempt
            print(f"  .. rate-limited (429) — waiting {wait:.0f}s", file=sys.stderr)
            time.sleep(wait)
        except (urllib.error.URLError, OSError, ValueError) as e:
            if attempt == retries:
                raise
            print(f"  .. GET failed ({e}) — retry {attempt}/{retries - 1}", file=sys.stderr)
            time.sleep(1.5 * attempt)


def send(method, url, payload):
    """Return (status, body_text). Does not raise on HTTP error status."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read().decode()[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def upsert(kind, post_url, put_url, payload, dry):
    """POST, and on 409 Conflict PUT. Returns 'created' | 'updated' | 'error:...'."""
    if dry:
        return "dry-run"
    status, body = send("POST", post_url, payload)
    if status in (200, 201):
        return "created"
    if status == 409:
        status, body = send("PUT", put_url, payload)
        if status in (200, 201, 204):
            return "updated"
    return f"error[{status}]: {body}"


# EO extension v1.x common_name vocabulary; upstream PhilSA records use values
# outside it (e.g. "red-edge", "coastal_blue"), which fail schema validation.
EO_COMMON_NAMES = {"coastal", "blue", "green", "red", "rededge", "yellow", "pan",
                   "nir", "nir08", "nir09", "cirrus", "swir16", "swir22",
                   "lwir", "lwir11", "lwir12"}
EO_COMMON_FIX = {"red-edge": "rededge", "red edge": "rededge",
                 "coastal_blue": "coastal", "coastal-blue": "coastal"}


def fix_eo_bands(bands):
    """Map non-vocabulary common_name values to the EO vocabulary, or drop the
    field (a band without common_name is valid; a wrong one is not)."""
    for b in bands or []:
        cn = b.get("common_name")
        if cn is None:
            continue
        cn = EO_COMMON_FIX.get(cn, cn)
        if cn in EO_COMMON_NAMES:
            b["common_name"] = cn
        else:
            del b["common_name"]


def normalize(obj):
    fix_eo_bands(obj.get("properties", {}).get("eo:bands"))
    for a in obj.get("assets", {}).values():
        fix_eo_bands(a.get("eo:bands"))
    fix_eo_bands(obj.get("summaries", {}).get("eo:bands"))
    return obj


# Navigation links that stac-fastapi/pgstac rebuilds for our own catalog — they
# point back at the *source* API, so carrying them over would send clients on a
# round trip out of this catalog. Everything else is content and is preserved:
# `license` / `cite-as`, `enclosure` (the upstream download URL — the whole point
# of a by-reference record), `version-history`, and extension-mandated links such
# as `ceos-ard-specification`, whose absence fails the CEOS-ARD schema.
NAV_RELS = {
    "self", "root", "parent", "child", "children", "collection", "item", "items",
    "next", "prev", "previous", "first", "last", "data", "search", "conformance",
    "service-desc", "service-doc", "queryables", "aggregate", "aggregations",
    "http://www.opengis.net/def/rel/ogc/1.0/queryables",
}


def rewrite_links(obj):
    """Drop source-relative navigation links (pgstac rebuilds its own) and keep
    every content link, then record provenance: the source record's rel=self
    becomes rel=via — the canonical marker for a by-reference mirror."""
    obj = dict(obj)
    links = obj.get("links") or []
    kept = [l for l in links if l.get("rel") not in NAV_RELS]
    self_href = next((l.get("href") for l in links if l.get("rel") == "self"), None)
    if self_href:
        kept.append({"rel": "via", "href": self_href, "type": "application/json",
                     "title": "Original record in the PhilSA catalog"})
    obj["links"] = kept
    return obj


def mirror_collection(col, dry):
    cid = col.get("id")
    payload = augment(normalize(rewrite_links(col)))
    payload.setdefault("type", "Collection")
    res = upsert(
        "collection",
        f"{DST}/collections",
        f"{DST}/collections/{urllib.parse.quote(cid)}",
        payload, dry,
    )
    print(f"  collection {cid!r}: {res}")
    return res.startswith(("created", "updated", "dry"))


def iter_items(cid, limit, max_items, stats=None):
    """Yield items across all pages, following rel=next. Never asks for a bigger
    page than the cap needs. Records the upstream's total in stats['matched'] (if
    it reports one) so the caller can say how much of the collection it took."""
    page_size = min(limit, max_items) if max_items else limit
    url = f"{SRC}/collections/{urllib.parse.quote(cid)}/items?limit={page_size}"
    seen = 0
    first = True
    while url:
        page = get(url)
        if first and stats is not None:
            stats["matched"] = page.get("numberMatched")
            first = False
        feats = page.get("features", [])
        for f in feats:
            yield f
            seen += 1
            if max_items and seen >= max_items:
                return
        nxt = [l["href"] for l in page.get("links", []) if l.get("rel") == "next"]
        url = nxt[0] if nxt and feats else None


def augment_item(f):
    """Give each mirrored item a Time of Data Start/End. Upstream items carry a
    single sensing instant (`datetime`) with no start/end; mirror that instant to
    start == end so every item shows both, without inventing a fake window."""
    p = f.setdefault("properties", {})
    dtv = p.get("datetime")
    if dtv and not p.get("start_datetime") and not p.get("end_datetime"):
        p["start_datetime"] = dtv
        p["end_datetime"] = dtv
    return f


def mirror_items(cid, limit, max_items, dry):
    counts = {"created": 0, "updated": 0, "error": 0, "dry-run": 0}
    stats = {}
    for f in iter_items(cid, limit, max_items, stats):
        f = augment_item(normalize(rewrite_links(f)))
        f["collection"] = cid
        iid = f.get("id")
        res = upsert(
            "item",
            f"{DST}/collections/{urllib.parse.quote(cid)}/items",
            f"{DST}/collections/{urllib.parse.quote(cid)}/items/{urllib.parse.quote(iid)}",
            f, dry,
        )
        key = res.split(":")[0].split("[")[0]
        if key in counts:
            counts[key] += 1
        else:
            counts["error"] += 1
            print(f"    item {iid!r}: {res}", file=sys.stderr)
        total = sum(counts.values())
        if total % 25 == 0:
            print(f"    ... {total} items processed", flush=True)
    # Never let a capped mirror read as a complete one.
    matched, taken = stats.get("matched"), sum(counts.values())
    if max_items and isinstance(matched, int) and matched > taken:
        print(f"    (capped: took the {taken} most recent of {matched:,} upstream "
              f"items — the rest stay upstream, one rel=via hop away)")
    return counts


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", nargs="*", help="only these collection ids")
    ap.add_argument("--limit", type=int, default=100, help="items per page (default 100)")
    ap.add_argument("--max-items", type=int, default=DEFAULT_MAX_ITEMS,
                    help=f"cap items per collection (default {DEFAULT_MAX_ITEMS}; "
                         "0 = every item — ~387k on the PhilSA STAC, expect hours)")
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    ap.add_argument("--collections-only", action="store_true", help="skip items")
    args = ap.parse_args()

    print(f">> source: {SRC}")
    print(f">> dest  : {DST}")
    if args.collections_only:
        print(">> collections only — no items")
    elif args.max_items:
        print(f">> items : up to {args.max_items} most recent per collection "
              "(--max-items 0 for all)")
    else:
        print(">> items : ALL — this mirrors the full upstream item set and will take hours")
    if args.dry_run:
        print(">> DRY RUN — no writes")
    else:
        ensure_writable(DST)

    cols = get(f"{SRC}/collections").get("collections", [])
    cols = [c for c in cols if c.get("id")]  # skip the phantom empty-id entry
    if args.only:
        wanted = set(args.only)
        cols = [c for c in cols if c["id"] in wanted]
    ids = [c["id"] for c in cols]
    shown = ids if len(ids) <= 12 else ids[:12] + [f"… +{len(ids) - 12} more"]
    print(f">> {len(cols)} collection(s) to mirror: {shown}\n")

    grand = {"created": 0, "updated": 0, "error": 0, "dry-run": 0}
    for col in cols:
        cid = col["id"]
        try:
            # fetch the full collection object (list view can be trimmed)
            full = get(f"{SRC}/collections/{urllib.parse.quote(cid)}")
            if not mirror_collection(full, args.dry_run):
                print(f"  !! skipping items for {cid} (collection upsert failed)")
                continue
            if args.collections_only:
                continue
            counts = mirror_items(cid, args.limit, args.max_items, args.dry_run)
        except (urllib.error.URLError, OSError, ValueError) as e:
            # skip-and-log: one bad collection must not abort the whole mirror
            print(f"  !! {cid}: skipped after repeated errors ({e})", file=sys.stderr)
            grand["error"] += 1
            continue
        print(f"  items: {counts}\n")
        for k, v in counts.items():
            grand[k] = grand.get(k, 0) + v

    print(f">> TOTAL items: {grand}")
    print(">> done.")


if __name__ == "__main__":
    main()
