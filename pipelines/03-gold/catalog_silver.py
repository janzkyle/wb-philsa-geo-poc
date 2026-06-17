#!/usr/bin/env python3
"""
catalog_silver.py — gold step: register the silver COGs (in Cloudflare R2) as
STAC Collections + Items in the local pgSTAC catalog, **by reference**.

This does not move pixels: each Item's asset href points at the public R2 COG, and
geo-metadata (geometry, bbox, proj:*, raster:bands) is read from the COG at load
time via `gdalinfo -json` (over /vsis3). Idempotent: POST first, PUT on 409 — same
pattern as the by-reference mirror loader.

Discovers COGs by listing each silver prefix in R2 (S3 ListObjectsV2, SigV4 via
stdlib). Reads R2 creds from the repo-root `.env.r2`; pgSTAC URL from STAC_API.

Stdlib only. Usage (from repo root, with pgSTAC up on :8082):
    python3 pipelines/03-gold/catalog_silver.py
    python3 pipelines/03-gold/catalog_silver.py --dry-run
    STAC_API=http://localhost:8082 python3 pipelines/03-gold/catalog_silver.py
"""
import argparse
import datetime as dt
import hashlib
import hmac
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
STAC_API = os.environ.get("STAC_API", os.environ.get("DST", "http://localhost:8082")).rstrip("/")
TIMEOUT = 60
EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
PROJ_EXT = "https://stac-extensions.github.io/projection/v1.1.0/schema.json"
RASTER_EXT = "https://stac-extensions.github.io/raster/v1.1.0/schema.json"
RENDER_EXT = "https://stac-extensions.github.io/render/v1.0.0/schema.json"
COG_TYPE = "image/tiff; application=geotiff; profile=cloud-optimized"

# Silver products to catalogue: one Collection per family.
PRODUCTS = [
    {"collection": "sentinel2-ndvi", "prefix": "02-silver/sentinel2-ndvi",
     "title": "Sentinel-2 NDVI — Philippines",
     "description": "Per-scene NDVI = (B08-B04)/(B08+B04) from Sentinel-2 L2A over the "
                    "Philippines, as Cloud-Optimized GeoTIFF (silver tier).",
     "platform": "sentinel-2", "instruments": ["msi"], "gsd": 10,
     "asset_title": "NDVI (Float32 COG)",
     "renders": {"ndvi": {"title": "NDVI (red → green)", "assets": ["data"],
                          "rescale": [[-0.2, 0.8]], "colormap_name": "rdylgn",
                          "resampling": "bilinear"}}},
    {"collection": "sentinel2-truecolor", "prefix": "02-silver/sentinel2-truecolor",
     "title": "Sentinel-2 True-Colour — Philippines",
     "description": "Sentinel-2 L2A true-colour (TCI, 10 m) over the Philippines, as an "
                    "8-bit RGB Cloud-Optimized GeoTIFF (silver tier).",
     "platform": "sentinel-2", "instruments": ["msi"], "gsd": 10,
     "asset_title": "True-colour RGB (8-bit COG)",
     "renders": {"true-color": {"title": "True colour", "assets": ["data"],
                                "resampling": "nearest"}}},
    {"collection": "sentinel1-sar", "prefix": "02-silver/sentinel1-sar",
     "title": "Sentinel-1 VV Backscatter (dB) — Philippines",
     "description": "Geocoded Sentinel-1 IW GRD VV backscatter in dB over the Philippines, "
                    "as Cloud-Optimized GeoTIFF (silver tier). Backscatter base layer — "
                    "not a validated flood product.",
     "platform": "sentinel-1", "instruments": ["c-sar"], "gsd": 10,
     "asset_title": "VV backscatter dB (Float32 COG)",
     "renders": {"backscatter": {"title": "VV backscatter (dB)", "assets": ["data"],
                                 "rescale": [[15, 55]], "colormap_name": "gray",
                                 "resampling": "bilinear"}}},
]


def load_env_file(path):
    if not path or not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ---------- R2 (S3) listing via SigV4 ----------------------------------------
def _hmac(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def _signing_key(secret, datestamp, region, service):
    k = _hmac(("AWS4" + secret).encode(), datestamp)
    for part in (region, service, "aws4_request"):
        k = _hmac(k, part)
    return k


class R2:
    def __init__(self, account_id, bucket, ak, sk, region="auto"):
        self.bucket, self.ak, self.sk, self.region = bucket, ak, sk, region
        self.host = f"{account_id}.r2.cloudflarestorage.com"

    def _auth(self, method, uri, query, payload_hash):
        now = dt.datetime.now(dt.timezone.utc)
        amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
        hdr = {"host": self.host, "x-amz-content-sha256": payload_hash, "x-amz-date": amz}
        signed = ";".join(sorted(hdr))
        canon_h = "".join(f"{h}:{hdr[h]}\n" for h in sorted(hdr))
        canon = "\n".join([method, uri, query, canon_h, signed, payload_hash])
        scope = f"{day}/{self.region}/s3/aws4_request"
        sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
        sig = hmac.new(_signing_key(self.sk, day, self.region, "s3"), sts.encode(), hashlib.sha256).hexdigest()
        hdr["Authorization"] = (f"AWS4-HMAC-SHA256 Credential={self.ak}/{scope}, "
                                f"SignedHeaders={signed}, Signature={sig}")
        return hdr

    def list_keys(self, prefix, retries=3):
        """List object keys under prefix (no pagination — POC scale)."""
        params = {"list-type": "2", "prefix": prefix}
        q = "&".join(f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(v, safe='')}"
                     for k, v in sorted(params.items()))
        uri = "/" + self.bucket
        url = f"https://{self.host}{uri}?{q}"
        for attempt in range(1, retries + 1):
            try:
                hdr = self._auth("GET", uri, q, EMPTY_SHA256)
                with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=TIMEOUT) as r:
                    body = r.read().decode()
                return [k for k in re.findall(r"<Key>([^<]+)</Key>", body)]
            except (urllib.error.URLError, urllib.error.HTTPError) as e:
                if attempt < retries:
                    time.sleep(1.5 * attempt)
                else:
                    print(f"  !! R2 list failed for {prefix}: {e}", file=sys.stderr)
                    return []


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


def parse_dt(name):
    m = re.search(r"(\d{8})T(\d{6})", name)
    if not m:
        return None
    d, t = m.group(1), m.group(2)
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}T{t[:2]}:{t[2:4]}:{t[4:6]}Z"


# ---------- STAC build + pgSTAC upsert ----------------------------------------
def build_item(prod, key, info, href):
    name = os.path.basename(key)
    iid = name[:-4] if name.lower().endswith(".tif") else name
    geom = info["wgs84Extent"]
    stac = info.get("stac", {})
    props = {"datetime": parse_dt(name), "platform": prod["platform"],
             "instruments": prod.get("instruments"), "gsd": prod.get("gsd")}
    for k in ("proj:epsg", "proj:shape", "proj:transform", "proj:projjson"):
        if k in stac:
            props[k] = stac[k]
    asset = {"href": href, "type": COG_TYPE, "title": prod["asset_title"], "roles": ["data"]}
    if "raster:bands" in stac:
        asset["raster:bands"] = stac["raster:bands"]
    if "eo:bands" in stac:
        asset["eo:bands"] = stac["eo:bands"]
    return {
        "type": "Feature", "stac_version": "1.0.0",
        "stac_extensions": [PROJ_EXT, RASTER_EXT],
        "id": iid, "collection": prod["collection"],
        "geometry": geom, "bbox": bbox_from_geom(geom),
        "properties": {k: v for k, v in props.items() if v is not None},
        "assets": {"data": asset}, "links": [],
    }


def build_collection(prod, bbox, dts):
    interval = [min(dts) if dts else None, max(dts) if dts else None]
    col = {
        "type": "Collection", "stac_version": "1.0.0", "stac_extensions": [],
        "id": prod["collection"], "title": prod["title"], "description": prod["description"],
        "license": "CC-BY-4.0",
        "extent": {"spatial": {"bbox": [bbox]}, "temporal": {"interval": [interval]}},
        "keywords": ["sentinel", "philippines", "silver", prod["platform"]],
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
    load_env_file(os.environ.get("R2_ENV_FILE", os.path.join(ROOT, ".env.r2")))
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="build + list, no writes to pgSTAC")
    ap.add_argument("--only", nargs="*", help="only these collection ids")
    args = ap.parse_args()

    bucket = os.environ.get("R2_BUCKET")
    acct = os.environ.get("R2_ACCOUNT_ID")
    public = os.environ.get("R2_PUBLIC_BASE", "").rstrip("/")
    if not (bucket and acct and public):
        sys.exit("!! need R2_BUCKET, R2_ACCOUNT_ID, R2_PUBLIC_BASE in .env.r2")
    r2 = R2(acct, bucket, os.environ.get("AWS_ACCESS_KEY_ID"), os.environ.get("AWS_SECRET_ACCESS_KEY"))

    print(f">> pgSTAC : {STAC_API}")
    print(f">> bucket : {bucket}")
    if args.dry_run:
        print(">> DRY RUN — no writes")

    products = [p for p in PRODUCTS if not args.only or p["collection"] in args.only]
    grand = {"created": 0, "updated": 0, "error": 0, "dry-run": 0}
    for prod in products:
        cid = prod["collection"]
        keys = [k for k in r2.list_keys(prod["prefix"] + "/") if k.lower().endswith(".tif")]
        print(f"\n>> {cid}: {len(keys)} COG(s) under {prod['prefix']}/")
        if not keys:
            continue
        items, bbox, dts = [], None, []
        for key in keys:
            info = gdalinfo_json(f"/vsicurl/{public}/{key}")
            if not info or "wgs84Extent" not in info:
                print(f"  !! skip (no metadata): {key}", file=sys.stderr)
                continue
            it = build_item(prod, key, info, f"{public}/{key}")
            items.append(it)
            b = it["bbox"]
            bbox = b if bbox is None else [min(bbox[0], b[0]), min(bbox[1], b[1]),
                                          max(bbox[2], b[2]), max(bbox[3], b[3])]
            if it["properties"].get("datetime"):
                dts.append(it["properties"]["datetime"])
        if not items:
            continue
        col = build_collection(prod, bbox or [116, 4.5, 127, 21.5], dts)
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
