#!/usr/bin/env python3
"""
mock_mula_catalog.py — register a SIMULATED "MULA" collection in pgSTAC for demos.

MULA (Multispectral Unit for Land Assessment) is PhilSA's upcoming 5 m, 9-band
Earth-observation satellite — **not yet launched**, so no real data exists. For
the POC demo we fabricate a believable near-real-time MULA feed by **reusing
recent Diwata-2 scenes over the Philippines by reference** (same cloud-hosted COG
hrefs — nothing is downloaded or re-processed) and **re-dating them to the last N
days**. Only STAC metadata is written; the imagery stays at its source.

Honest by construction: the collection is clearly marked simulated
(`mula:simulated: true`, description + keywords), and every item records the
Diwata-2 scene it borrows (`mula:source_item`). It is a placeholder, not MULA data.

Re-runnable for demo day — dates are relative to `--end-date` (default: today),
and item IDs are **stable slots** (`mula-01`…`mula-05`), so re-running just
PUT-updates the same items with fresher dates. No reprocessing; typically <1 s.

    # register 5 scenes dated for the last 5 days, ending today
    python3 pipelines/reference/mula-mock/mock_mula_catalog.py

    # shift to nearer dates right before a demo (newest = 2026-08-20)
    python3 pipelines/reference/mula-mock/mock_mula_catalog.py --end-date 2026-08-20

    python3 pipelines/reference/mula-mock/mock_mula_catalog.py --dry-run   # preview

Pure stdlib. Points at the local STAC API by default (STAC_API / --stac-api).
"""
import argparse
import copy
import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request

STAC_API = os.environ.get("STAC_API", os.environ.get("DST", "http://localhost:8082")).rstrip("/")
TIMEOUT = 30
RENDER_EXT = "https://stac-extensions.github.io/render/v1.0.0/schema.json"

# MULA true-colour render: bands 4/2/1 of the borrowed 9-band TOA COG (matches the
# dashboard's Diwata-2 style so the placeholder renders identically).
MULA_RENDER = {
    "true-color": {
        "title": "True colour (5 m)",
        "assets": ["top-of-atmosphere-reflectance"],
        "bidx": [4, 2, 1],
        "rescale": [[0, 257], [0, 206], [0, 130]],
        "resampling": "nearest",
    }
}


def get_json(url):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def send(method, url, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read().decode()[:200]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def upsert(post_url, put_url, payload, dry):
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


def source_scenes(collection, bbox, count):
    """The `count` most-recent source scenes intersecting the AOI, with a usable COG."""
    url = (f"{STAC_API}/collections/{urllib.parse.quote(collection)}/items"
           f"?bbox={bbox}&limit=200")
    feats = get_json(url).get("features", [])
    feats = [f for f in feats
             if (f.get("assets", {}).get("top-of-atmosphere-reflectance") or {}).get("href")]
    feats.sort(key=lambda f: f.get("properties", {}).get("datetime") or "", reverse=True)
    return feats[:count]


def re_dated(src, slot, new_date):
    """A MULA item cloned from a source scene: same geometry + asset hrefs (by
    reference), new id / date / platform. Preserves the source's time-of-day."""
    src_dt = src.get("properties", {}).get("datetime") or "1970-01-01T00:00:00Z"
    tod = src_dt[10:] if len(src_dt) >= 19 else "T03:00:00Z"  # keep HH:MM:SSZ
    return {
        "type": "Feature",
        "stac_version": "1.0.0",
        "stac_extensions": src.get("stac_extensions", []),
        "id": f"mula-{slot:02d}",
        "collection": "mula",
        "geometry": src["geometry"],
        "bbox": src.get("bbox"),
        "properties": {
            "datetime": f"{new_date.isoformat()}{tod}",
            "platform": "mula",
            "instruments": ["truecolour-imager"],
            "gsd": 5,
            "mula:simulated": True,
            "mula:source_item": src["id"],
            **{k: v for k, v in src.get("properties", {}).items()
               if k in ("proj:epsg", "proj:shape", "proj:transform")},
        },
        "assets": copy.deepcopy(src.get("assets", {})),  # same hrefs — by reference
        "links": [],
    }


def build_collection(bbox, dates):
    return {
        "type": "Collection",
        "stac_version": "1.0.0",
        "stac_extensions": [RENDER_EXT],
        "id": "mula",
        "title": "MULA — Multispectral Unit for Land Assessment",
        "description": (
            "**Simulated demo dataset.** MULA is PhilSA's upcoming 5 m, 9-band "
            "Earth-observation satellite (built with SSTL; not yet launched). These "
            "placeholder scenes reuse recent **Diwata-2 SMI** imagery **by reference**, "
            "re-dated to the last few days to illustrate a near-real-time MULA feed. "
            "This is **not** actual MULA data — see each item's `mula:source_item`."
        ),
        "license": "proprietary",
        "keywords": ["mula", "philsa", "philippines", "true-colour", "simulated", "demo"],
        "providers": [
            {"name": "Philippine Space Agency (PhilSA)", "roles": ["producer", "licensor"]},
            {"name": "Surrey Satellite Technology Ltd (SSTL)", "roles": ["processor"]},
        ],
        "extent": {
            "spatial": {"bbox": [bbox]},
            "temporal": {"interval": [[f"{min(dates).isoformat()}T00:00:00Z",
                                       f"{max(dates).isoformat()}T23:59:59Z"]]},
        },
        "renders": MULA_RENDER,
        "links": [],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source-collection", default="diwata-2",
                    help="STAC collection to borrow scenes from (default diwata-2)")
    ap.add_argument("--count", type=int, default=5, help="number of scenes/dates (default 5)")
    ap.add_argument("--end-date", default=None,
                    help="newest MULA date, YYYY-MM-DD (default: today)")
    ap.add_argument("--step-days", type=int, default=1,
                    help="days between scenes going back from --end-date (default 1)")
    ap.add_argument("--bbox", default="116,4.5,127,21.5",
                    help="AOI to pick source scenes from (default: Philippines)")
    ap.add_argument("--dry-run", action="store_true", help="build + preview, no writes")
    args = ap.parse_args()

    end = (dt.date.fromisoformat(args.end_date) if args.end_date else dt.date.today())
    dates = [end - dt.timedelta(days=i * args.step_days) for i in range(args.count)]

    print(f">> pgSTAC : {STAC_API}")
    print(f">> source : {args.source_collection}  (bbox {args.bbox})")
    print(f">> dates  : {dates[-1]} … {dates[0]} ({args.count} scenes)"
          + ("  [DRY RUN]" if args.dry_run else ""))

    scenes = source_scenes(args.source_collection, args.bbox, args.count)
    if len(scenes) < args.count:
        print(f"!! only {len(scenes)} source scene(s) over the AOI — need {args.count}",
              file=sys.stderr)
        if not scenes:
            sys.exit(1)

    items = [re_dated(src, slot, date)
             for slot, (src, date) in enumerate(zip(scenes, dates), start=1)]
    bbox_union = [min(i["bbox"][0] for i in items), min(i["bbox"][1] for i in items),
                  max(i["bbox"][2] for i in items), max(i["bbox"][3] for i in items)]
    col = build_collection(bbox_union, dates)

    res = upsert(f"{STAC_API}/collections",
                 f"{STAC_API}/collections/mula", col, args.dry_run)
    print(f"  collection mula: {res}")
    tally = {}
    for it in items:
        r = upsert(f"{STAC_API}/collections/mula/items",
                   f"{STAC_API}/collections/mula/items/{it['id']}", it, args.dry_run)
        tally[r.split(":")[0].split("[")[0]] = tally.get(r.split(":")[0].split("[")[0], 0) + 1
        print(f"    {it['id']}  {it['properties']['datetime'][:10]}  "
              f"(from {it['properties']['mula:source_item']}): {r}")
    print(f">> items: {tally}")


if __name__ == "__main__":
    main()
