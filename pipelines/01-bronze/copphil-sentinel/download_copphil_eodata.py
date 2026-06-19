#!/usr/bin/env python3
"""
download_copphil_eodata.py — fetch the latest raw Sentinel scenes over the
Philippines from the CopPhil mirror, optionally storing them to Cloudflare R2.

This is the acquisition half of the `COP` ingest path (TODO.md): pull raw
Sentinel-1 (SAR) + Sentinel-2 (optical) scenes for the AOI so they can feed the
`clip · NDVI · SAR flood` processing path. Raw EODATA is *transformed* downstream,
so it is downloaded (and, in R2 mode, uploaded as bronze) rather than cataloged
in place.

CopPhil API (a Copernicus CSC OData catalog — same shape as the Copernicus Data
Space Ecosystem):

  1. Auth   POST {AUTH}/protocol/openid-connect/token  (Keycloak password grant)
  2. Search GET  {CATALOGUE}/odata/v1/Products?$filter=...&$orderby=...&$top=N
  3. Get    GET  {DOWNLOAD}/odata/v1/Products({id})/$value?token={access_token}

Destination: Cloudflare R2 (S3-compatible) — REQUIRED; there is no local-output
mode. Scenes land under the medallion-tiered key prefix
`01-bronze/copphil-sentinel/` (override R2_PREFIX). Each scene is staged to a temp
dir, verified against ContentLength, uploaded, then the staging copy removed.

Credentials come from the environment, or the gitignored repo-root `.env`:
    COPPHIL_USERNAME, COPPHIL_PASSWORD   (required — your CopPhil account)
    COPPHIL_CLIENT_ID                    (default: copphil-public)
    COPPHIL_AOI_WKT                      (default: PH bounding box)
    R2_BUCKET        target bucket (REQUIRED — this script writes only to R2)
    R2_ACCOUNT_ID    Cloudflare account id (forms the S3 endpoint)
    R2_PREFIX        key prefix (default: 01-bronze/copphil-sentinel)
    R2_PUBLIC_BASE   optional public base URL for printed object URLs
    AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY   R2 API-token creds

Stdlib only (R2 uploads use AWS SigV4 signed with hashlib/hmac — no boto3).
Paths (.env, eodata/) resolve to the repo root, so it runs from any directory.
From the repo root:
    python3 pipelines/01-bronze/copphil-sentinel/download_copphil_eodata.py --dry-run
    python3 pipelines/01-bronze/copphil-sentinel/download_copphil_eodata.py
(CopPhil + R2 creds both come from the repo-root .env.)
"""
import argparse
import datetime
import hashlib
import hmac
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

# Philippines bounding box (lon/lat, WGS84) — override with COPPHIL_AOI_WKT.
DEFAULT_AOI_WKT = (
    "POLYGON((116.0 4.5,127.0 4.5,127.0 21.5,116.0 21.5,116.0 4.5))"
)

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
EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def load_env_file(path):
    """Populate os.environ from a simple KEY=VALUE file (does not overwrite set vars)."""
    if not path or not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            os.environ.setdefault(key, val)


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


# --- minimal Cloudflare R2 (S3-compatible) client, AWS SigV4 via stdlib ------
def _hmac(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret, datestamp, region, service):
    k = _hmac(("AWS4" + secret).encode("utf-8"), datestamp)
    k = _hmac(k, region)
    k = _hmac(k, service)
    return _hmac(k, "aws4_request")


class R2:
    """Just enough S3 to HEAD and PUT objects on Cloudflare R2 (path-style)."""

    def __init__(self, account_id, bucket, access_key, secret_key, prefix,
                 public_base=None, region="auto"):
        self.account_id = account_id
        self.bucket = bucket
        self.access_key = access_key
        self.secret_key = secret_key
        self.prefix = prefix.strip("/")
        self.public_base = public_base
        self.region = region
        self.host = f"{account_id}.r2.cloudflarestorage.com"

    def key_for(self, fname):
        return f"{self.prefix}/{fname}" if self.prefix else fname

    def _url(self, key):
        return f"https://{self.host}/{self.bucket}/{urllib.parse.quote(key, safe='/')}"

    def _auth_headers(self, method, key, payload_hash):
        now = datetime.datetime.now(datetime.timezone.utc)
        amzdate = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")
        canonical_uri = "/" + self.bucket + "/" + urllib.parse.quote(key, safe="/")
        headers = {
            "host": self.host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amzdate,
        }
        signed = ";".join(sorted(headers))
        canonical_headers = "".join(f"{h}:{headers[h]}\n" for h in sorted(headers))
        canonical_request = "\n".join(
            [method, canonical_uri, "", canonical_headers, signed, payload_hash])
        scope = f"{datestamp}/{self.region}/s3/aws4_request"
        sts = "\n".join(["AWS4-HMAC-SHA256", amzdate, scope,
                         hashlib.sha256(canonical_request.encode()).hexdigest()])
        sig = hmac.new(_signing_key(self.secret_key, datestamp, self.region, "s3"),
                       sts.encode(), hashlib.sha256).hexdigest()
        headers["Authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={self.access_key}/{scope}, "
            f"SignedHeaders={signed}, Signature={sig}")
        return headers

    def head_size(self, key):
        """Object size in bytes, or None if it doesn't exist (404)."""
        headers = self._auth_headers("HEAD", key, EMPTY_SHA256)
        req = urllib.request.Request(self._url(key), method="HEAD", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                cl = r.headers.get("Content-Length")
                return int(cl) if cl is not None else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def put_file(self, key, filepath):
        """Upload a local file to R2 with a single PUT (unsigned payload)."""
        size = os.path.getsize(filepath)
        headers = self._auth_headers("PUT", key, "UNSIGNED-PAYLOAD")
        headers["Content-Length"] = str(size)
        with open(filepath, "rb") as fh:
            req = urllib.request.Request(self._url(key), data=fh, method="PUT", headers=headers)
            with urllib.request.urlopen(req, timeout=max(TIMEOUT, 900)) as r:
                return r.status

    def url_for(self, key):
        if self.public_base:
            return f"{self.public_base.rstrip('/')}/{key}"
        return f"s3://{self.bucket}/{key}"


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


def search(filter_str, top):
    """Return the newest `top` products matching the filter (OData JSON 'value' list)."""
    params = urllib.parse.urlencode(
        {
            "$filter": filter_str,
            "$orderby": "ContentDate/Start desc",
            "$top": str(top),
        },
        quote_via=urllib.parse.quote,
    )
    url = f"{CATALOGUE}?{params}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.load(r).get("value", [])
    except urllib.error.HTTPError as e:
        print(f"  !! search failed [{e.code}]: {e.read().decode()[:200]}", file=sys.stderr)
        return []


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
    """Stage one product, verify it, upload to R2, then remove the staging copy."""
    pid = product.get("Id")
    name = product.get("Name", pid)
    expected = int(product["ContentLength"]) if product.get("ContentLength") else None
    fname = name if name.lower().endswith(".zip") else f"{name}.zip"
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
    """Build the R2 client from the environment. R2 is required (no local mode)."""
    bucket = os.environ.get("R2_BUCKET")
    if not bucket:
        sys.exit("!! R2_BUCKET is required — this script writes only to R2 "
                 "(set R2_BUCKET in .env)")
    prefix = os.environ.get("R2_PREFIX", DEFAULT_R2_PREFIX)
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
    ap.add_argument("--limit", type=int, default=1,
                    help="newest scenes per collection (default 1 = latest)")
    ap.add_argument("--days", type=int, default=0,
                    help="only scenes from the last N days (0 = no time filter)")
    ap.add_argument("--max-cloud", type=float, default=100.0,
                    help="max cloudCover %% (Sentinel-2 only; default 100 = no filter)")
    ap.add_argument("--s1-match", default=COLLECTIONS["sentinel-1"][1],
                    help="Sentinel-1 product-name substring (default IW_GRDH = GRD high-res)")
    ap.add_argument("--s2-match", default=COLLECTIONS["sentinel-2"][1],
                    help="Sentinel-2 product-name substring (default MSIL2A = L2A)")
    ap.add_argument(
        "--out", default=os.environ.get("COPPHIL_OUT_DIR", os.path.join(ROOT, "eodata")),
        help="local staging dir; scenes are deleted after upload (default <repo>/eodata)")
    ap.add_argument("--dry-run", action="store_true", help="search + list, no download/upload")
    args = ap.parse_args()

    aoi_wkt = os.environ.get("COPPHIL_AOI_WKT", DEFAULT_AOI_WKT)
    since = iso_days_ago(args.days)
    name_token = {"sentinel-1": args.s1_match, "sentinel-2": args.s2_match}
    r2 = make_r2(args.dry_run)

    print(f">> catalogue: {CATALOGUE}")
    print(f">> AOI      : {aoi_wkt}")
    print(f">> dest     : R2 s3://{r2.bucket}/{r2.prefix}/  (staging in {args.out})")
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

    totals = {"uploaded": 0, "skipped": 0, "dry-run": 0, "error": 0}
    for key in args.collections:
        col_name, _default_token, supports_cloud = COLLECTIONS[key]
        token = name_token[key]
        print(f"\n>> {key} ({col_name} / Name~{token})")
        flt = build_filter(col_name, token, aoi_wkt, since,
                           args.max_cloud, supports_cloud)
        products = search(flt, args.limit)
        if not products:
            print("  (no matching scenes)")
            continue
        for p in products:
            res = handle(p, args.out, auth, args.dry_run, r2)
            totals[res] = totals.get(res, 0) + 1

    print(f"\n>> TOTAL: {totals}")
    print(">> done.")


if __name__ == "__main__":
    main()
