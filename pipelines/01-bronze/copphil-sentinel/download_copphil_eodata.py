#!/usr/bin/env python3
"""
download_copphil_eodata.py — fetch the latest raw Sentinel scenes over the
Philippines from the CopPhil mirror, storing them locally (and, optionally, to
Cloudflare R2).

This is the acquisition half of the `COP` ingest path (TODO.md): pull raw
Sentinel-1 (SAR) + Sentinel-2 (optical) scenes for the AOI so they can feed the
`clip · NDVI · SAR flood` processing path. Raw EODATA is *transformed* downstream,
so it is downloaded (and only uploaded as bronze when `--r2` is given) rather
than cataloged in place.

Selection: by default each run pulls every scene from the `--dates N` (default 3)
most recent acquisition dates *per collection* nationwide, with Sentinel-2
filtered to `--max-cloud` (default 20%). That yields the freshest complete looks
at the country for change comparison. `--aoi WKT` narrows to a sub-region;
raising `--max-cloud` to 100 disables the cloud filter.

`--all` drops the date window entirely and takes every scene CopPhil holds for
the *remaining* filters — AOI, collection, product type, and (for S2) cloud
ceiling still apply. For a true full sweep:

    --all --max-cloud 100

Sizing matters here: a national run is large even at `--dates 3` (Sentinel
granules are ~1 GB each and the country takes many per pass), and `--all` is
many TB. Every run prints its scene count and total bytes per collection before
anything moves, so `--dry-run` first, then bound it with `--days N` (a rolling
window), `--limit N` (a hard per-collection ceiling), or `--aoi`.

CopPhil API (a Copernicus CSC OData catalog — same shape as the Copernicus Data
Space Ecosystem):

  1. Auth   POST {AUTH}/protocol/openid-connect/token  (Keycloak password grant)
  2. Search GET  {CATALOGUE}/odata/v1/Products?$filter=...&$orderby=...&$top=N&$skip=M
  3. Get    GET  {DOWNLOAD}/odata/v1/Products({id})/$value?token={access_token}

Destination: local staging dir (`--out`, default <repo>/eodata) — scenes are
downloaded there, verified against ContentLength, and KEPT for the downstream
silver step. Pass `--r2` to ALSO upload each scene as bronze under the
medallion-tiered key prefix `01-bronze/copphil-sentinel/` (hardcoded, per the
R2 conventions in pipelines/README.md); in that mode the local staging copy is
removed after a verified upload.

Credentials come from the environment, or the gitignored repo-root `.env`:
    COPPHIL_USERNAME, COPPHIL_PASSWORD   (required — your CopPhil account)
    COPPHIL_CLIENT_ID                    (default: copphil-public)
    COPPHIL_AOI_WKT                      (same as --aoi; default: the PH national box)
    R2_BUCKET        target bucket (only needed with --r2)
    R2_ACCOUNT_ID    Cloudflare account id (forms the S3 endpoint; --r2 only)
    R2_PUBLIC_BASE   optional public base URL for printed object URLs
    AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   R2 API-token creds (--r2 only)

Stdlib only (R2 uploads use AWS SigV4 signed with hashlib/hmac — no boto3).
Paths (.env, eodata/) resolve to the repo root, so it runs from any directory.
From the repo root:
    python3 pipelines/01-bronze/copphil-sentinel/download_copphil_eodata.py --dry-run
    python3 pipelines/01-bronze/copphil-sentinel/download_copphil_eodata.py            # latest 3 dates → local
    python3 pipelines/01-bronze/copphil-sentinel/download_copphil_eodata.py --r2       # also upload as bronze
    python3 pipelines/01-bronze/copphil-sentinel/download_copphil_eodata.py --all --dry-run   # size the full backfill
(CopPhil + R2 creds both come from the repo-root .env.)
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def _repo_root():
    """Walk up from this file to the repo root so paths work from any cwd."""
    d = os.path.dirname(os.path.abspath(__file__))
    while d != os.path.dirname(d):
        if os.path.exists(os.path.join(d, ".git")) or os.path.exists(os.path.join(d, "AGENTS.md")):
            return d
        d = os.path.dirname(d)
    return os.getcwd()


ROOT = _repo_root()
sys.path.insert(0, os.path.join(ROOT, "pipelines", "lib"))
from r2 import R2, load_env_file  # noqa: E402 — shared stdlib SigV4 R2 client

# --- endpoints (override via env if the mirror ever moves) -------------------
AUTH_URL = os.environ.get(
    "COPPHIL_AUTH_URL",
    "https://auth.copphil.cloudferro.com/auth/realms/copphilinfra/protocol/openid-connect/token",
)
CATALOGUE = os.environ.get(
    "COPPHIL_CATALOGUE_URL",
    "https://catalogue.infra.copphil.philsa.gov.ph/odata/v1/Products",
).rstrip("/")
DOWNLOAD = os.environ.get(
    "COPPHIL_DOWNLOAD_URL",
    "https://download.infra.copphil.philsa.gov.ph/odata/v1/Products",
).rstrip("/")

# Default AOI: the national bounding box (lon/lat, WGS84). CopPhil is the
# Philippine Copernicus mirror, so this is effectively "everything it holds" —
# it stays an explicit clause rather than an omitted one so the query states its
# own bounds. Narrow it with --aoi WKT (or the COPPHIL_AOI_WKT env var).
PH_AOI_WKT = "POLYGON((116.0 4.5,127.0 4.5,127.0 21.5,116.0 21.5,116.0 4.5))"

# Medallion-tiered R2 key prefix for this dataset: <tier>/<dataset>/...
DEFAULT_R2_PREFIX = "01-bronze/copphil-sentinel"

# Per-collection defaults: (OData Collection/Name, product-name token, supports cloudCover).
# CopPhil does not populate the `productType` attribute for Sentinel-1, so we match on a
# substring of the product Name instead — works uniformly for both collections.
COLLECTIONS = {
    "sentinel-1": ("SENTINEL-1", "IW_GRDH", False),  # GRD high-res IW; SAR-flood standard
    "sentinel-2": ("SENTINEL-2", "MSIL2A", True),    # L2A surface reflectance
}

TIMEOUT = 120


class Auth:
    """Keycloak password-grant token, re-fetched when close to expiry."""

    def __init__(self, username, password, client_id):
        self.username = username
        self.password = password
        self.client_id = client_id
        self._token = None
        self._expires_at = 0.0

    def token(self):
        # refresh a little early so long searches don't race the expiry
        if self._token and time.time() < self._expires_at - 30:
            return self._token
        data = urllib.parse.urlencode({
            "client_id": self.client_id,
            "grant_type": "password",
            "username": self.username,
            "password": self.password,
        }).encode()
        req = urllib.request.Request(AUTH_URL, data=data, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                body = json.load(r)
        except urllib.error.HTTPError as e:
            sys.exit(f"!! auth failed [{e.code}]: {e.read().decode()[:200]}\n"
                     f"   check COPPHIL_USERNAME / COPPHIL_PASSWORD in .env")
        self._token = body["access_token"]
        self._expires_at = time.time() + int(body.get("expires_in", 600))
        return self._token


def build_filter(collection_name, name_token, aoi_wkt, since_iso, max_cloud, supports_cloud):
    """Assemble an OData $filter string for one collection.

    `name_token` may be a comma-separated list (e.g. "MSIL2A,T50PRB"); each part
    becomes its own contains(Name,...) clause, AND-ed together. This lets a caller
    pin both processing level and MGRS tile for a clean single-tile time series.
    """
    clauses = [f"Collection/Name eq '{collection_name}'"]
    for tok in (t.strip() for t in name_token.split(",")):
        if tok:
            clauses.append(f"contains(Name,'{tok}')")
    clauses.append(f"OData.CSC.Intersects(area=geography'SRID=4326;{aoi_wkt}')")
    if since_iso:
        clauses.append(f"ContentDate/Start gt {since_iso}")
    if supports_cloud and max_cloud is not None and max_cloud < 100:
        clauses.append(
            "Attributes/OData.CSC.DoubleAttribute/any("
            "att:att/Name eq 'cloudCover' and "
            f"att/OData.CSC.DoubleAttribute/Value le {max_cloud:.2f})"
        )
    return " and ".join(clauses)


def search(filter_str, top, skip=0):
    """Return one page of products matching the filter (OData JSON 'value' list),
    newest first. `skip` offsets into the ordered result for pagination."""
    query = {
        "$filter": filter_str,
        "$orderby": "ContentDate/Start desc",
        "$top": str(top),
    }
    if skip:
        query["$skip"] = str(skip)
    params = urllib.parse.urlencode(query, quote_via=urllib.parse.quote)
    url = f"{CATALOGUE}?{params}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.load(r).get("value", [])
    except urllib.error.HTTPError as e:
        print(f"  !! search failed [{e.code}]: {e.read().decode()[:200]}", file=sys.stderr)
        return []


def _scene_date(product):
    """Acquisition date (UTC 'YYYY-MM-DD') from ContentDate/Start, or ''."""
    return ((product.get("ContentDate") or {}).get("Start") or "")[:10]


def search_latest_dates(filter_str, num_dates, cap=0, page_size=100, max_pages=100):
    """All scenes from the `num_dates` most-recent distinct acquisition dates.

    Pages the catalogue in date-desc order, keeping every scene whose date is
    among the first `num_dates` distinct dates seen. `num_dates` 0 disables the
    date window (see `search_all`). `cap` (>0) is a hard ceiling on scenes
    returned, as a safety valve against an unexpectedly huge day.
    """
    kept, dates, skip = [], [], 0
    for _ in range(max_pages):
        page = search(filter_str, page_size, skip)
        if not page:
            break
        for p in page:
            d = _scene_date(p)
            if d and d not in dates:
                if num_dates and len(dates) >= num_dates:
                    return kept  # crossed into an older, unwanted date — done
                dates.append(d)
            kept.append(p)
            if cap and len(kept) >= cap:
                return kept
        if len(page) < page_size:
            break
        skip += page_size
    else:
        # Ran the whole page budget without the catalogue running dry — the
        # result is silently truncated, so say so rather than look complete.
        print(f"  !! page ceiling hit at {len(kept)} scene(s) — result is TRUNCATED; "
              "narrow with --aoi/--days/--max-cloud", file=sys.stderr)
    return kept


def search_all(filter_str, cap=0, page_size=100, max_pages=2000):
    """Every scene matching the filter — pages until the catalogue runs dry.

    Backs `--all`: no date window, so the only bounds left are the filter itself
    (collection, product type, AOI, cloud) and `cap` (`--limit`, 0 = uncapped).
    `max_pages` is a runaway backstop (200k scenes), not an intended limit.
    """
    return search_latest_dates(filter_str, 0, cap=cap, page_size=page_size,
                               max_pages=max_pages)


def _describe(products):
    """'N scene(s) across M date(s), ~X GB: <dates>' — the pre-download summary.

    Long date lists (the `--all` case) collapse to first…last so a full-archive
    run doesn't print hundreds of dates.
    """
    dates = sorted({_scene_date(p) for p in products if _scene_date(p)}, reverse=True)
    total = sum(int(p["ContentLength"]) for p in products if p.get("ContentLength"))
    span = ", ".join(dates) if len(dates) <= 6 else f"{dates[-1]} … {dates[0]}"
    size = f", ~{total/1e9:.1f} GB" if total else ""
    return f"{len(products)} scene(s) across {len(dates)} date(s){size}: {span}"


def _fetch_to_file(pid, part, expected, auth, retries):
    """Stream product `pid` to `part`, verifying the full byte count. True on success.

    The CopPhil download endpoint can close the connection early; a short read is
    NOT raised by urllib, so we compare bytes written against ContentLength and retry.
    """
    for attempt in range(1, retries + 1):
        url = f"{DOWNLOAD}({pid})/$value?token={urllib.parse.quote(auth.token())}"
        try:
            written = 0
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r, open(part, "wb") as fh:
                while True:
                    chunk = r.read(1024 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
                    written += len(chunk)
            if expected and written != expected:
                raise OSError(f"truncated: got {written} of {expected} bytes")
            return True
        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
            if os.path.exists(part):
                os.remove(part)
            if attempt < retries:
                print(f"  .. download attempt {attempt}/{retries} failed: {e} — retrying")
                time.sleep(2 * attempt)
            else:
                print(f"  !! download failed after {retries} attempts: {e}", file=sys.stderr)
                return False


def handle(product, out_dir, auth, dry, r2, retries=3):
    """Download one product to `out_dir`, verify it against ContentLength, and
    either keep it locally (r2 is None) or upload it as bronze and drop the copy.

    Idempotent either way: an existing full-size local file (or, in R2 mode, an
    object of the right size) is skipped without re-downloading.
    """
    pid = product.get("Id")
    name = product.get("Name", pid)
    expected = int(product["ContentLength"]) if product.get("ContentLength") else None
    fname = name if name.lower().endswith(".zip") else f"{name}.zip"

    # ---- local-only mode (default): download + keep in out_dir ---------------
    if r2 is None:
        dest = os.path.join(out_dir, fname)
        if dry:
            size = f"{expected/1e9:.2f} GB" if expected else "unknown size"
            print(f"  · would download to {dest}  ({size})")
            return "dry-run"
        if expected is not None and os.path.exists(dest) and os.path.getsize(dest) == expected:
            print(f"  = skip (already local): {dest}")
            return "skipped"
        part = dest + ".part"
        if not _fetch_to_file(pid, part, expected, auth, retries):
            return "error"
        os.replace(part, dest)
        print(f"  + saved: {dest}  ({os.path.getsize(dest)/1e6:.0f} MB)")
        return "downloaded"

    # ---- R2 mode (--r2): stage, upload as bronze, remove the staging copy -----
    key = r2.key_for(fname)
    if not dry and expected is not None:
        try:
            if r2.head_size(key) == expected:
                print(f"  = skip (already in R2): {key}")
                return "skipped"
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"  .. R2 HEAD failed ({e}); will upload anyway")
    if dry:
        size = f"{expected/1e9:.2f} GB" if expected else "unknown size"
        print(f"  · would download + upload to R2: {key}  ({size})")
        return "dry-run"

    part = os.path.join(out_dir, fname + ".part")
    if not _fetch_to_file(pid, part, expected, auth, retries):
        return "error"
    mb = os.path.getsize(part) / 1e6
    for attempt in range(1, retries + 1):
        try:
            r2.put_file(key, part)
            os.remove(part)
            print(f"  + uploaded to R2: {r2.url_for(key)}  ({mb:.0f} MB)")
            return "uploaded"
        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
            if attempt < retries:
                print(f"  .. R2 upload attempt {attempt}/{retries} failed: {e} — retrying")
                time.sleep(2 * attempt)
            else:
                print(f"  !! R2 upload failed for {key}: {e} (staged file kept: {part})",
                      file=sys.stderr)
                return "error"


def iso_days_ago(days):
    if not days:
        return None
    t = time.gmtime(time.time() - days * 86400)
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", t)


def make_r2(dry):
    """Build the R2 client from the environment (only called with --r2)."""
    bucket = os.environ.get("R2_BUCKET")
    if not bucket:
        sys.exit("!! --r2 needs R2_BUCKET (set it in .env, or drop --r2 for "
                 "local-only download)")
    prefix = DEFAULT_R2_PREFIX  # hardcoded per tier/dataset — see pipelines/README.md
    public_base = os.environ.get("R2_PUBLIC_BASE")
    if dry:  # preview only — no creds needed to print the target keys
        return R2("", bucket, "", "", prefix, public_base)
    acct = os.environ.get("R2_ACCOUNT_ID")
    ak = os.environ.get("AWS_ACCESS_KEY_ID")
    sk = os.environ.get("AWS_SECRET_ACCESS_KEY")
    missing = [n for n, v in [("R2_ACCOUNT_ID", acct), ("AWS_ACCESS_KEY_ID", ak),
                              ("AWS_SECRET_ACCESS_KEY", sk)] if not v]
    if missing:
        sys.exit(f"!! R2 upload needs {', '.join(missing)} (set in .env)")
    return R2(acct, bucket, ak, sk, prefix, public_base)


def main():
    # Single repo-root .env holds both CopPhil and R2 creds (override with ENV_FILE).
    load_env_file(os.environ.get("ENV_FILE", os.path.join(ROOT, ".env")))

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--collections", nargs="*", default=list(COLLECTIONS),
                    choices=list(COLLECTIONS), help="which collections (default: both)")
    ap.add_argument("--aoi", default=None,
                    help="AOI as WGS84 WKT, to narrow the search (default: the PH "
                         "national box, i.e. everything the CopPhil mirror holds). "
                         "COPPHIL_AOI_WKT sets the same thing")
    ap.add_argument("--dates", type=int, default=3,
                    help="fetch every scene from the N most recent acquisition dates "
                         "per collection, nationwide (default 3; 0 = disable, use --limit)")
    ap.add_argument("--all", action="store_true", dest="fetch_all",
                    help="no date window — every scene CopPhil holds for the other "
                         "filters (AOI, product type, cloud). Overrides --dates. "
                         "Very large: --dry-run it first, and add --max-cloud 100 "
                         "for a true full archive")
    ap.add_argument("--limit", type=int, default=0,
                    help="cap scenes per collection (0 = no cap). With --dates 0, "
                         "this is the newest-N-scenes count instead (min 1)")
    ap.add_argument("--days", type=int, default=0,
                    help="only scenes from the last N days (0 = no time filter)")
    ap.add_argument("--max-cloud", type=float, default=20.0,
                    help="max cloudCover %% (Sentinel-2 only; default 20; 100 = no filter)")
    ap.add_argument("--s1-match", default=COLLECTIONS["sentinel-1"][1],
                    help="Sentinel-1 product-name substring (default IW_GRDH = GRD high-res)")
    ap.add_argument("--s2-match", default=COLLECTIONS["sentinel-2"][1],
                    help="Sentinel-2 product-name substring (default MSIL2A = L2A)")
    ap.add_argument(
        "--out", default=os.environ.get("COPPHIL_OUT_DIR", os.path.join(ROOT, "eodata")),
        help="local staging dir; scenes are deleted after upload (default <repo>/eodata)")
    ap.add_argument("--r2", action="store_true",
                    help="also upload each scene to R2 as bronze (default: local only)")
    ap.add_argument("--dry-run", action="store_true", help="search + list, no download/upload")
    args = ap.parse_args()

    # Precedence: --aoi > COPPHIL_AOI_WKT > the national default.
    aoi_env = os.environ.get("COPPHIL_AOI_WKT")
    aoi_wkt = args.aoi or aoi_env or PH_AOI_WKT
    aoi_label = "--aoi" if args.aoi else ("COPPHIL_AOI_WKT" if aoi_env else "philippines")
    since = iso_days_ago(args.days)
    name_token = {"sentinel-1": args.s1_match, "sentinel-2": args.s2_match}
    r2 = make_r2(args.dry_run) if args.r2 else None

    print(f">> catalogue: {CATALOGUE}")
    print(f">> AOI      : {aoi_label}  {aoi_wkt}")
    cloud = "" if args.max_cloud >= 100 else f", S2 cloud ≤ {args.max_cloud:g}%"
    if args.fetch_all:
        capped = f", capped at {args.limit} per collection" if args.limit else ""
        print(f">> select   : ALL scenes — no date window{cloud}{capped}")
    elif args.dates:
        print(f">> select   : latest {args.dates} acquisition date(s) per collection{cloud}")
    if r2 is not None:
        print(f">> dest     : local {args.out}  +  R2 s3://{r2.bucket}/{r2.prefix}/")
    else:
        print(f">> dest     : local {args.out}  (kept for downstream silver; no R2 upload)")
    if since:
        print(f">> since    : {since}")
    if args.dry_run:
        print(">> DRY RUN — search only, no downloads/uploads")

    auth = None
    if not args.dry_run:
        user = os.environ.get("COPPHIL_USERNAME")
        pw = os.environ.get("COPPHIL_PASSWORD")
        if not user or not pw:
            sys.exit("!! set COPPHIL_USERNAME and COPPHIL_PASSWORD (in .env)")
        auth = Auth(user, pw, os.environ.get("COPPHIL_CLIENT_ID", "copphil-public"))
        os.makedirs(args.out, exist_ok=True)

    totals = {"downloaded": 0, "uploaded": 0, "skipped": 0, "dry-run": 0, "error": 0}
    for key in args.collections:
        col_name, _default_token, supports_cloud = COLLECTIONS[key]
        token = name_token[key]
        print(f"\n>> {key} ({col_name} / Name~{token})")
        flt = build_filter(col_name, token, aoi_wkt, since,
                           args.max_cloud, supports_cloud)
        if args.fetch_all:
            products = search_all(flt, cap=args.limit)
        elif args.dates:
            products = search_latest_dates(flt, args.dates, cap=args.limit)
        else:
            products = search(flt, max(args.limit, 1))
        if not products:
            print("  (no matching scenes)")
            continue
        print(f"  {_describe(products)}")
        for p in products:
            res = handle(p, args.out, auth, args.dry_run, r2)
            totals[res] = totals.get(res, 0) + 1

    print(f"\n>> TOTAL: {totals}")
    print(">> done.")


if __name__ == "__main__":
    main()
