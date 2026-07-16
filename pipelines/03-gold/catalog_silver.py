#!/usr/bin/env python3
"""
catalog_silver.py — gold step: register the silver COGs (in Cloudflare R2) as
STAC Collections + Items in the local pgSTAC catalog, **by reference**.

This does not move pixels: each Item's asset href points at the public R2 COG, and
geo-metadata (geometry, bbox, proj:*, raster:bands) is read from the COG at load
time via `gdalinfo -json` (over /vsis3). Idempotent: POST first, PUT on 409 — same
pattern as the by-reference mirror loader.

Records are built to validate against the STAC extension schemas and to carry
the discovery/lineage fields common metadata standards expect (ISO 19115 /
DCAT equivalents): collections get providers, summaries, item_assets, and the
Copernicus attribution; items get platform/constellation (from the granule
prefix), `processing:lineage`, per-product band metadata (curated eo:bands /
raster:bands, classification classes for the flood mask), and rel=derived_from
links — to the bronze granule in R2 when it exists there, and flood → its
source silver SAR item.

Discovers COGs by listing each silver prefix in R2 (S3 ListObjectsV2, SigV4 via
stdlib). Reads R2 creds from the repo-root `.env`; pgSTAC URL from STAC_API.

Stdlib only. Usage (from repo root, with pgSTAC up on :8082):
    python3 pipelines/03-gold/catalog_silver.py
    python3 pipelines/03-gold/catalog_silver.py --dry-run
    STAC_API=http://localhost:8082 python3 pipelines/03-gold/catalog_silver.py
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def _repo_root():
    d = os.path.dirname(os.path.abspath(__file__))
    while d != os.path.dirname(d):
        if os.path.exists(os.path.join(d, ".git")) or os.path.exists(os.path.join(d, "AGENTS.md")):
            return d
        d = os.path.dirname(d)
    return os.getcwd()


ROOT = _repo_root()
sys.path.insert(0, os.path.join(ROOT, "pipelines", "lib"))
from r2 import R2, load_env_file  # noqa: E402 — shared stdlib SigV4 R2 client
from stac_write import ensure_writable  # noqa: E402 — refuse read-only STAC targets

STAC_API = os.environ.get("STAC_API", os.environ.get("DST", "http://localhost:8082")).rstrip("/")
TIMEOUT = 60
PROJ_EXT = "https://stac-extensions.github.io/projection/v1.1.0/schema.json"
RASTER_EXT = "https://stac-extensions.github.io/raster/v1.1.0/schema.json"
RENDER_EXT = "https://stac-extensions.github.io/render/v1.0.0/schema.json"
EO_EXT = "https://stac-extensions.github.io/eo/v1.1.0/schema.json"
CLASSIFICATION_EXT = "https://stac-extensions.github.io/classification/v1.1.0/schema.json"
ITEM_ASSETS_EXT = "https://stac-extensions.github.io/item-assets/v1.0.0/schema.json"
PROCESSING_EXT = "https://stac-extensions.github.io/processing/v1.1.0/schema.json"
COG_TYPE = "image/tiff; application=geotiff; profile=cloud-optimized"
BRONZE_PREFIX = "01-bronze/copphil-sentinel"

# "Metadata Last Updated" stamp shown on every collection (PhilSA catalog review,
# Jul 2026). ISO date — the stac-browser fields.config renders it as "15 Jul 2026".
METADATA_UPDATED = "2026-07-15"

# Providers for the Sentinel-derived silver collections (ISO 19115 "responsible
# party" equivalent; also carries the Copernicus attribution obligation).
SENTINEL_PROVIDERS = [
    {"name": "European Space Agency (Copernicus)", "roles": ["producer", "licensor"],
     "url": "https://dataspace.copernicus.eu/"},
    {"name": "Copernicus Philippines (CopPhil)", "roles": ["host"],
     "url": "https://copphil.philsa.gov.ph/"},
    {"name": "Philippine Space Agency (PhilSA) / World Bank POC", "roles": ["processor"],
     "url": "https://philsa.gov.ph/"},
]

# Silver products to catalogue: one Collection per family.
PRODUCTS = [
    {"collection": "sentinel2-ndvi", "prefix": "02-silver/sentinel2-ndvi",
     "title": "Sentinel-2 NDVI — Philippines",
     "source_product": "sentinel2-ndvi", "extra_keywords": ["NDVI", "vegetation"],
     "description": "Per-scene NDVI = (B08-B04)/(B08+B04) from Sentinel-2 L2A over the "
                    "Philippines, as Cloud-Optimized GeoTIFF (silver tier).",
     "platform": "sentinel-2", "instruments": ["msi"], "gsd": 10,
     "asset_title": "NDVI (Float32 COG)",
     "raster_extra": {"nodata": -9999},
     "lineage": "NDVI = (B08 − B04) / (B08 + B04) computed at 10 m from the Copernicus "
                "Sentinel-2 L2A granule {source}; fill pixels set to nodata (−9999).",
     "renders": {"ndvi": {"title": "NDVI (red → green)", "assets": ["data"],
                          "rescale": [[-0.2, 0.8]], "colormap_name": "rdylgn",
                          "resampling": "bilinear"}}},
    {"collection": "sentinel2-truecolor", "prefix": "02-silver/sentinel2-truecolor",
     "title": "Sentinel-2 True-Colour (TCI) — Philippines",
     "source_product": "sentinel2-truecolor", "extra_keywords": ["true-colour", "TCI", "RGB"],
     "description": "Sentinel-2 L2A true-colour (TCI, 10 m) over the Philippines, as an "
                    "8-bit RGB Cloud-Optimized GeoTIFF (silver tier).",
     "platform": "sentinel-2", "instruments": ["msi"], "gsd": 10,
     "asset_title": "True-colour RGB (8-bit COG)",
     "eo_bands": [{"name": "Red", "common_name": "red"},
                  {"name": "Green", "common_name": "green"},
                  {"name": "Blue", "common_name": "blue"}],
     "lineage": "True-colour image (TCI_10m) extracted from the Copernicus Sentinel-2 "
                "L2A granule {source} as an 8-bit RGB COG.",
     "renders": {"true-color": {"title": "True colour", "assets": ["data"],
                                "resampling": "nearest"}}},
    {"collection": "sentinel1-sar", "prefix": "02-silver/sentinel1-sar",
     "title": "Sentinel-1 SAR VV Backscatter — Philippines",
     "source_product": "sentinel1-sar", "extra_keywords": ["SAR", "radar", "VV backscatter"],
     "description": "Geocoded Sentinel-1 IW GRD VV backscatter in dB over the Philippines, "
                    "as Cloud-Optimized GeoTIFF (silver tier). Backscatter base layer — "
                    "not a validated flood product.",
     "platform": "sentinel-1", "instruments": ["c-sar"], "gsd": 10,
     "asset_title": "VV backscatter dB (Float32 COG)",
     "raster_extra": {"unit": "dB"},
     "lineage": "VV amplitude from the Copernicus Sentinel-1 IW GRD granule {source} "
                "converted to backscatter in dB (10·log10(DN²)) and geocoded. No "
                "radiometric calibration, speckle filtering, or terrain correction.",
     "renders": {"backscatter": {"title": "VV backscatter (dB)", "assets": ["data"],
                                 "rescale": [[15, 55]], "colormap_name": "gray",
                                 "resampling": "bilinear"}}},
    {"collection": "sentinel1-ratio", "prefix": "02-silver/sentinel1-ratio",
     "title": "Sentinel-1 VH/VV Cross-Ratio — Philippines",
     "source_product": "sentinel1-ratio", "extra_keywords": ["SAR", "radar", "cross-ratio", "vegetation"],
     "description": "Sentinel-1 VH/VV cross-polarisation ratio in dB (VH_dB − VV_dB) over the "
                    "Philippines, as Cloud-Optimized GeoTIFF (silver tier). Volume scattering "
                    "makes the ratio rise with crop canopy growth, and it works through cloud — "
                    "a radar sibling of NDVI for wet-season monitoring. Index layer from "
                    "uncalibrated backscatter — not a calibrated crop product.",
     "platform": "sentinel-1", "instruments": ["c-sar"], "gsd": 10,
     "asset_title": "VH/VV cross-ratio dB (Float32 COG)",
     "raster_extra": {"unit": "dB"},
     "lineage": "Cross-polarisation ratio VH − VV in dB computed from the Copernicus "
                "Sentinel-1 IW GRD granule {source} (10·log10(VH²) − 10·log10(VV²), "
                "uncalibrated backscatter).",
     "renders": {"ratio": {"title": "VH/VV cross-ratio (dB)", "assets": ["data"],
                           "rescale": [[-14, -2]], "colormap_name": "ylgn",
                           "resampling": "bilinear"}}},
    {"collection": "sentinel1-flood", "prefix": "02-silver/sentinel1-flood",
     "title": "Sentinel-1 Flood / Water Mask — Philippines",
     "source_product": "sentinel1-flood", "extra_keywords": ["flood", "water", "SAR", "threshold"],
     "description": "Open-water / flood mask derived from Sentinel-1 VV backscatter (dB) by "
                    "dark-water thresholding (sigma default; otsu/fixed options) "
                    "(silver tier): 1 = water, 0 = land, 2 = permanent "
                    "water, 255 = nodata. POC flood proxy — NOT a validated product (no "
                    "calibration / speckle / terrain correction); complements the "
                    "authoritative Copernicus EMS / GFM reference layer.",
     "platform": "sentinel-1", "instruments": ["c-sar"], "gsd": 10,
     "asset_title": "Flood / water mask (Byte COG)",
     "raster_extra": {"nodata": 255},
     "classes": [
         {"value": 0, "name": "land", "description": "No water detected"},
         {"value": 1, "name": "water", "color_hint": "2166CC",
          "description": "Open water / flood detected by dark-water dB thresholding"},
         {"value": 2, "name": "permanent-water", "color_hint": "78AAE6",
          "description": "Water also present in the permanent-water reference mask"},
         {"value": 255, "name": "nodata", "description": "No data", "nodata": True},
     ],
     "derived_from_collection": "sentinel1-sar",
     "lineage": "Open-water mask thresholded from the silver Sentinel-1 VV backscatter "
                "COG of granule {source} (dark-water dB threshold: sigma default, "
                "otsu/fixed options). POC proxy — not a validated flood product.",
     "renders": {"flood": {"title": "Flood extent (water)", "assets": ["data"],
                           "colormap": {"1": [33, 102, 204, 255], "2": [120, 170, 230, 255]},
                           "resampling": "nearest"}}},
]


# ---------- COG metadata via gdalinfo ----------------------------------------
def gdalinfo_json(vsis3_path, retries=3):
    for attempt in range(1, retries + 1):
        p = subprocess.run(["gdalinfo", "-json", vsis3_path],
                           capture_output=True, text=True, env=os.environ)
        if p.returncode == 0 and p.stdout.strip():
            return json.loads(p.stdout)
        if attempt < retries:
            time.sleep(1.5 * attempt)  # transient DNS / network
    print(f"  !! gdalinfo failed: {vsis3_path}\n     {p.stderr.strip()[:160]}", file=sys.stderr)
    return None


def bbox_from_geom(geom):
    xs, ys = [], []
    for ring in geom["coordinates"]:
        for x, y in ring:
            xs.append(x); ys.append(y)
    return [min(xs), min(ys), max(xs), max(ys)]


def _iso(d, t):
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}T{t[:2]}:{t[2:4]}:{t[4:6]}Z"


def parse_dt(name):
    m = re.search(r"(\d{8})T(\d{6})", name)
    if not m:
        return None
    return _iso(m.group(1), m.group(2))


def acquisition_window(name, platform, dt0):
    """(start_datetime, end_datetime) for the granule. Sentinel-1 IW GRD names
    carry two sensing timestamps (acquisition start + stop, ~25 s apart) — use
    both. Sentinel-2 (and anything else) is a single sensing instant; its second
    filename timestamp is the processing time, not a sensing stop, so
    start == end == datetime."""
    if dt0 and platform.startswith("sentinel-1"):
        stamps = re.findall(r"(\d{8})T(\d{6})", name)
        if len(stamps) >= 2:
            return _iso(*stamps[0]), _iso(*stamps[1])
    return dt0, dt0


# Silver product suffixes appended to the source-granule basename by the
# 02-silver builders (build_ndvi/truecolor/sar/ratio/flood.sh).
SUFFIX_RE = re.compile(r"_(NDVI|TCI|(?:VV|VH|VHVV)_dB|(?:VV|VH)_flood)$")


def source_granule(iid):
    return SUFFIX_RE.sub("", iid)


def platform_from_name(name, default):
    """Specific satellite + constellation from the granule prefix (S2C_… →
    sentinel-2c / sentinel-2); falls back to the product's family platform."""
    m = re.match(r"S([12])([A-D])_", name)
    if not m:
        return default, None
    return f"sentinel-{m.group(1)}{m.group(2).lower()}", f"sentinel-{m.group(1)}"


# ---------- STAC build + pgSTAC upsert ----------------------------------------
def build_item(prod, key, info, href, extra_links=None):
    name = os.path.basename(key)
    iid = name[:-4] if name.lower().endswith(".tif") else name
    geom = info["wgs84Extent"]
    stac = info.get("stac", {})
    platform, constellation = platform_from_name(name, prod["platform"])
    dt0 = parse_dt(name)
    start_dt, end_dt = acquisition_window(name, platform, dt0)
    props = {"datetime": dt0, "start_datetime": start_dt, "end_datetime": end_dt,
             "platform": platform, "constellation": constellation,
             "instruments": prod.get("instruments"), "gsd": prod.get("gsd")}
    # proj:projjson deliberately not copied — proj:epsg carries the same CRS in
    # a few bytes instead of ~2 KB per item.
    for k in ("proj:epsg", "proj:shape", "proj:transform"):
        if k in stac:
            props[k] = stac[k]
    exts = [PROJ_EXT, RASTER_EXT]
    if prod.get("lineage"):
        props["processing:lineage"] = prod["lineage"].format(source=source_granule(iid))
        exts.append(PROCESSING_EXT)
    asset = {"href": href, "type": COG_TYPE, "title": prod["asset_title"], "roles": ["data"]}
    bands = stac.get("raster:bands") or ([{}] if prod.get("raster_extra") else None)
    if bands:
        # gdalinfo emits explicit nulls (e.g. "nodata": null), so a plain
        # setdefault would keep them; treat null as absent, then drop the rest.
        for b in bands:
            for k, v in prod.get("raster_extra", {}).items():
                if b.get(k) is None:
                    b[k] = v
        asset["raster:bands"] = [{k: v for k, v in b.items() if v is not None}
                                 for b in bands]
    # gdalinfo's eo:bands guesses ("b1"/"Gray") are colour-interp noise, not
    # spectral metadata — only emit eo:bands the product config names explicitly.
    if prod.get("eo_bands"):
        asset["eo:bands"] = prod["eo_bands"]
        exts.append(EO_EXT)
    if prod.get("classes"):
        asset["classification:classes"] = prod["classes"]
        exts.append(CLASSIFICATION_EXT)
    return {
        "type": "Feature", "stac_version": "1.0.0",
        "stac_extensions": exts,
        "id": iid, "collection": prod["collection"],
        "geometry": geom, "bbox": bbox_from_geom(geom),
        "properties": {k: v for k, v in props.items() if v is not None},
        "assets": {"data": asset}, "links": extra_links or [],
    }


def build_collection(prod, bbox, dts, items):
    interval = [min(dts) if dts else None, max(dts) if dts else None]
    # The STAC `title` is the original/technical product name (what the catalog
    # browser shows); layman-friendly framing lives in the webmap layer labels
    # (webmap RASTER_DEFS). The underlying silver product name is preserved as a
    # queryable property + keyword so the technical lineage is never lost.
    # `source_product` defaults to the collection id (display-only rename).
    source_product = prod.get("source_product", prod["collection"])
    keywords = ["sentinel", "philippines", "silver", prod["platform"],
                source_product, *prod.get("extra_keywords", [])]
    description = prod["description"]
    if prod["platform"].startswith("sentinel") and dts:
        yrs = sorted({d[:4] for d in dts})
        span = yrs[0] if len(yrs) == 1 else f"{yrs[0]}–{yrs[-1]}"
        description += f" Contains modified Copernicus Sentinel data ({span})."
    # Summaries of the item properties (faceted-search hooks for clients).
    summaries = {}
    for field in ("platform", "constellation", "instruments", "gsd", "proj:epsg"):
        vals = []
        for it in items:
            v = it["properties"].get(field)
            vals.extend(v if isinstance(v, list) else [v] if v is not None else [])
        if vals:
            summaries[field] = sorted(set(vals))
    col = {
        "type": "Collection", "stac_version": "1.0.0",
        "stac_extensions": [ITEM_ASSETS_EXT],
        "id": prod["collection"], "title": prod["title"], "description": description,
        "license": "CC-BY-4.0",
        "providers": prod.get("providers", SENTINEL_PROVIDERS),
        "extent": {"spatial": {"bbox": [bbox]}, "temporal": {"interval": [interval]}},
        "keywords": keywords,
        "summaries": summaries,
        "philsa:source_product": source_product,
        "philsa:metadata_updated": METADATA_UPDATED,
        "item_assets": {"data": {"type": COG_TYPE, "title": prod["asset_title"],
                                 "roles": ["data"]}},
        "links": [],
    }
    # Render extension: tell viewers how to display these COGs (rescale + colormap),
    # so single-band Float32 rasters don't render as a black tile. A TiTiler-backed
    # client (or our stac-browser config) turns these into XYZ tile params.
    if prod.get("renders"):
        col["stac_extensions"].append(RENDER_EXT)
        col["renders"] = prod["renders"]
    return col


def send(method, url, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read().decode()[:200]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def upsert(kind, post_url, put_url, payload, dry):
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


def main():
    load_env_file(os.environ.get("ENV_FILE", os.path.join(ROOT, ".env")))
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="build + list, no writes to pgSTAC")
    ap.add_argument("--only", nargs="*", help="only these collection ids")
    args = ap.parse_args()

    bucket = os.environ.get("R2_BUCKET")
    acct = os.environ.get("R2_ACCOUNT_ID")
    public = os.environ.get("R2_PUBLIC_BASE", "").rstrip("/")
    ak, sk = os.environ.get("AWS_ACCESS_KEY_ID"), os.environ.get("AWS_SECRET_ACCESS_KEY")
    missing = [n for n, v in [("R2_BUCKET", bucket), ("R2_ACCOUNT_ID", acct),
                              ("R2_PUBLIC_BASE", public), ("AWS_ACCESS_KEY_ID", ak),
                              ("AWS_SECRET_ACCESS_KEY", sk)] if not v]
    if missing:
        sys.exit(f"!! need {', '.join(missing)} in .env (listing the silver prefixes "
                 "requires the R2 API-token creds)")
    r2 = R2(acct, bucket, ak, sk)

    # Read COG metadata over the authenticated /vsis3 endpoint: the public r2.dev
    # host has flaky DNS (see TODO "Tile-serving robustness"), while
    # <account>.r2.cloudflarestorage.com resolves reliably. Asset hrefs stay public.
    os.environ["AWS_S3_ENDPOINT"] = f"{acct}.r2.cloudflarestorage.com"
    os.environ["AWS_VIRTUAL_HOSTING"] = "FALSE"
    os.environ["AWS_DEFAULT_REGION"] = "auto"

    def read_path(key):
        return f"/vsis3/{bucket}/{key}"

    print(f">> pgSTAC : {STAC_API}")
    print(f">> bucket : {bucket}")
    print(">> read   : vsis3 (authenticated)")
    if args.dry_run:
        print(">> DRY RUN — no writes")
    else:
        ensure_writable(STAC_API)

    # Bronze granules in R2, keyed by basename (minus .SAFE/.zip) — lets each
    # silver item carry a rel=derived_from link to its source granule.
    bronze_map = {}
    try:
        for k in r2.list_keys(BRONZE_PREFIX + "/"):
            b = os.path.basename(k)
            b = re.sub(r"(\.SAFE)?\.zip$", "", b, flags=re.I)
            b = re.sub(r"\.SAFE$", "", b, flags=re.I)
            if b:
                bronze_map[b] = k
    except (urllib.error.URLError, OSError) as e:
        print(f"  !! bronze list failed ({e}) — items get no derived_from links",
              file=sys.stderr)

    products = [p for p in PRODUCTS if not args.only or p["collection"] in args.only]
    grand = {"created": 0, "updated": 0, "error": 0, "dry-run": 0}
    for prod in products:
        cid = prod["collection"]
        try:
            keys = [k for k in r2.list_keys(prod["prefix"] + "/") if k.lower().endswith(".tif")]
        except (urllib.error.URLError, OSError) as e:
            print(f"  !! skip {cid}: R2 list failed for {prod['prefix']} ({e})", file=sys.stderr)
            continue
        print(f"\n>> {cid}: {len(keys)} COG(s) under {prod['prefix']}/")
        if not keys:
            continue
        items, bbox, dts = [], None, []
        for key in keys:
            info = gdalinfo_json(read_path(key))
            if not info or "wgs84Extent" not in info:
                print(f"  !! skip (no metadata): {key}", file=sys.stderr)
                continue
            name = os.path.basename(key)
            iid = name[:-4] if name.lower().endswith(".tif") else name
            links = []
            src = source_granule(iid)
            if src in bronze_map:
                links.append({"rel": "derived_from", "type": "application/zip",
                              "href": f"{public}/{bronze_map[src]}",
                              "title": f"Source granule {src}"})
            # flood is built from the silver SAR COG, which IS a catalogued item
            sib = prod.get("derived_from_collection")
            if sib and iid.endswith("_flood"):
                sar_id = iid[:-len("_flood")] + "_dB"
                links.append({"rel": "derived_from", "type": "application/geo+json",
                              "href": f"{STAC_API}/collections/{sib}/items/{sar_id}",
                              "title": f"Silver VV backscatter item {sar_id}"})
            it = build_item(prod, key, info, f"{public}/{key}", links)
            items.append(it)
            b = it["bbox"]
            bbox = b if bbox is None else [min(bbox[0], b[0]), min(bbox[1], b[1]),
                                          max(bbox[2], b[2]), max(bbox[3], b[3])]
            if it["properties"].get("datetime"):
                dts.append(it["properties"]["datetime"])
        if not items:
            continue
        col = build_collection(prod, bbox or [116, 4.5, 127, 21.5], dts, items)
        res = upsert("collection", f"{STAC_API}/collections",
                     f"{STAC_API}/collections/{urllib.parse.quote(cid)}", col, args.dry_run)
        print(f"  collection: {res}")
        for it in items:
            r = upsert("item", f"{STAC_API}/collections/{urllib.parse.quote(cid)}/items",
                       f"{STAC_API}/collections/{urllib.parse.quote(cid)}/items/{urllib.parse.quote(it['id'])}",
                       it, args.dry_run)
            key = r.split(":")[0].split("[")[0]
            grand[key] = grand.get(key, 0) + 1
            print(f"    item {it['id']}: {r}")

    print(f"\n>> TOTAL items: {grand}")
    print(">> done.")


if __name__ == "__main__":
    main()
