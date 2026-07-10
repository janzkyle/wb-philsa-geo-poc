"""r2.py — shared minimal Cloudflare R2 (S3-compatible) client for pipelines/.

Just enough S3 to HEAD, PUT, and LIST objects on R2, signed with AWS SigV4 via
hashlib/hmac — stdlib only, no boto3. Path-style addressing against
https://<account>.r2.cloudflarestorage.com. The Python pipeline scripts add
this directory to sys.path and import it, so each script stays runnable
standalone from the repo (no packaging/install step).

Also holds load_env_file(): populate os.environ from a KEY=VALUE .env file
without overwriting already-set vars — the Python twin of lib/load_env.sh.
"""
import datetime as dt
import hashlib
import hmac
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
TIMEOUT = 120


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


def _hmac(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret, datestamp, region, service):
    k = _hmac(("AWS4" + secret).encode("utf-8"), datestamp)
    for part in (region, service, "aws4_request"):
        k = _hmac(k, part)
    return k


class R2:
    """HEAD / PUT / LIST objects on Cloudflare R2 (path-style, SigV4)."""

    def __init__(self, account_id, bucket, access_key, secret_key, prefix="",
                 public_base=None, region="auto"):
        self.account_id = account_id
        self.bucket = bucket
        self.access_key = access_key
        self.secret_key = secret_key
        self.prefix = (prefix or "").strip("/")
        self.public_base = public_base
        self.region = region
        self.host = f"{account_id}.r2.cloudflarestorage.com"

    def key_for(self, fname):
        return f"{self.prefix}/{fname}" if self.prefix else fname

    def _url(self, key):
        return f"https://{self.host}/{self.bucket}/{urllib.parse.quote(key, safe='/')}"

    def _auth(self, method, uri, query, payload_hash):
        now = dt.datetime.now(dt.timezone.utc)
        amzdate, datestamp = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
        headers = {"host": self.host, "x-amz-content-sha256": payload_hash,
                   "x-amz-date": amzdate}
        signed = ";".join(sorted(headers))
        canonical_headers = "".join(f"{h}:{headers[h]}\n" for h in sorted(headers))
        canonical_request = "\n".join(
            [method, uri, query, canonical_headers, signed, payload_hash])
        scope = f"{datestamp}/{self.region}/s3/aws4_request"
        sts = "\n".join(["AWS4-HMAC-SHA256", amzdate, scope,
                         hashlib.sha256(canonical_request.encode()).hexdigest()])
        sig = hmac.new(_signing_key(self.secret_key, datestamp, self.region, "s3"),
                       sts.encode(), hashlib.sha256).hexdigest()
        headers["Authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={self.access_key}/{scope}, "
            f"SignedHeaders={signed}, Signature={sig}")
        return headers

    def _auth_headers(self, method, key, payload_hash):
        uri = "/" + self.bucket + "/" + urllib.parse.quote(key, safe="/")
        return self._auth(method, uri, "", payload_hash)

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
            req = urllib.request.Request(self._url(key), data=fh, method="PUT",
                                         headers=headers)
            with urllib.request.urlopen(req, timeout=max(TIMEOUT, 900)) as r:
                return r.status

    def list_keys(self, prefix, retries=3):
        """All object keys under `prefix`, following ListObjectsV2 pagination.

        Raises on repeated network failure (callers decide whether to
        skip-and-log or abort)."""
        keys, token = [], None
        while True:
            params = {"list-type": "2", "prefix": prefix}
            if token:
                params["continuation-token"] = token
            q = "&".join(
                f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(v, safe='')}"
                for k, v in sorted(params.items()))
            uri = "/" + self.bucket
            url = f"https://{self.host}{uri}?{q}"
            for attempt in range(1, retries + 1):
                try:
                    hdr = self._auth("GET", uri, q, EMPTY_SHA256)
                    req = urllib.request.Request(url, headers=hdr)
                    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                        body = r.read().decode()
                    break
                except (urllib.error.URLError, OSError):
                    if attempt == retries:
                        raise
                    time.sleep(1.5 * attempt)
            keys += re.findall(r"<Key>([^<]+)</Key>", body)
            m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", body)
            if not m:
                return keys
            token = m.group(1)

    def url_for(self, key):
        if self.public_base:
            return f"{self.public_base.rstrip('/')}/{key}"
        return f"s3://{self.bucket}/{key}"
