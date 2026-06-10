#!/usr/bin/env python3
"""
mirror_philsa_catalog.py — mirror every collection + item from the PhilSA
Satellite Imagery Catalog into the local stac-fastapi-pgstac, *by reference*.

Source (a STAC API):  https://api.catalog.data.philsa.gov.ph
Dest   (your pgstac): http://localhost:8082   (Transactions extension enabled)

Only the STAC metadata (Collections + Items) is copied. Item assets keep their
original absolute hrefs (storage.googleapis.com/dpad-bucket/...), so pixels are
streamed from PhilSA's storage — nothing is re-hosted.

Idempotent: POST first, and on 409 Conflict fall back to PUT, so re-running
updates in place instead of erroring.

Stdlib only. Usage:
    ./mirror_philsa_catalog.py                       # mirror everything
    ./mirror_philsa_catalog.py --dry-run             # show what would happen
    ./mirror_philsa_catalog.py --only diwata-2 skysat
    SRC=... DST=... ./mirror_philsa_catalog.py
    ./mirror_philsa_catalog.py --limit 100 --max-items 500
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

SRC = os.environ.get("SRC", "https://api.catalog.data.philsa.gov.ph").rstrip("/")
DST = os.environ.get("DST", os.environ.get("STAC_API", "http://localhost:8082")).rstrip("/")
TIMEOUT = 60


def get(url):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


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


def strip_links(obj):
    """Drop source-relative navigation links; pgstac rebuilds its own."""
    obj = dict(obj)
    obj["links"] = []
    return obj


def mirror_collection(col, dry):
    cid = col.get("id")
    payload = strip_links(col)
    payload.setdefault("type", "Collection")
    res = upsert(
        "collection",
        f"{DST}/collections",
        f"{DST}/collections/{urllib.parse.quote(cid)}",
        payload, dry,
    )
    print(f"  collection {cid!r}: {res}")
    return res.startswith(("created", "updated", "dry"))


def iter_items(cid, limit, max_items):
    """Yield items across all pages, following rel=next."""
    url = f"{SRC}/collections/{urllib.parse.quote(cid)}/items?limit={limit}"
    seen = 0
    while url:
        page = get(url)
        feats = page.get("features", [])
        for f in feats:
            yield f
            seen += 1
            if max_items and seen >= max_items:
                return
        nxt = [l["href"] for l in page.get("links", []) if l.get("rel") == "next"]
        url = nxt[0] if nxt and feats else None


def mirror_items(cid, limit, max_items, dry):
    counts = {"created": 0, "updated": 0, "error": 0, "dry-run": 0}
    for f in iter_items(cid, limit, max_items):
        f = strip_links(f)
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
    return counts


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", nargs="*", help="only these collection ids")
    ap.add_argument("--limit", type=int, default=100, help="items per page (default 100)")
    ap.add_argument("--max-items", type=int, default=0, help="cap items per collection (0 = all)")
    ap.add_argument("--dry-run", action="store_true", help="report without writing")
    ap.add_argument("--collections-only", action="store_true", help="skip items")
    args = ap.parse_args()

    print(f">> source: {SRC}")
    print(f">> dest  : {DST}")
    if args.dry_run:
        print(">> DRY RUN — no writes")

    cols = get(f"{SRC}/collections").get("collections", [])
    cols = [c for c in cols if c.get("id")]  # skip the phantom empty-id entry
    if args.only:
        wanted = set(args.only)
        cols = [c for c in cols if c["id"] in wanted]
    print(f">> {len(cols)} collection(s) to mirror: {[c['id'] for c in cols]}\n")

    grand = {"created": 0, "updated": 0, "error": 0, "dry-run": 0}
    for col in cols:
        cid = col["id"]
        # fetch the full collection object (list view can be trimmed)
        full = get(f"{SRC}/collections/{urllib.parse.quote(cid)}")
        if not mirror_collection(full, args.dry_run):
            print(f"  !! skipping items for {cid} (collection upsert failed)")
            continue
        if args.collections_only:
            continue
        counts = mirror_items(cid, args.limit, args.max_items, args.dry_run)
        print(f"  items: {counts}\n")
        for k, v in counts.items():
            grand[k] = grand.get(k, 0) + v

    print(f">> TOTAL items: {grand}")
    print(">> done.")


if __name__ == "__main__":
    main()
