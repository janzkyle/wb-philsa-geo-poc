#!/usr/bin/env python3
"""
build_silver.py — batch driver: turn every raw scene in R2 bronze into its silver
COG(s), by invoking the per-product builders.

  Sentinel-2 (MSIL2A)  -> sentinel2-ndvi/build_ndvi.sh  +  sentinel2-truecolor/build_truecolor.sh
  Sentinel-1 (GRDH)    -> sentinel1-sar/build_sar.sh

Lists `01-bronze/copphil-sentinel/` in R2 (S3 ListObjectsV2, SigV4 via stdlib) and
runs the matching builder for each `.SAFE.zip`, passing SCENE=. Each builder
early-skips scenes whose output already exists, so re-runs only build what's new.

Reads R2 creds from the repo-root `.env.r2`. Stdlib only. Usage (from repo root):
    python3 pipelines/02-silver/build_silver.py
    python3 pipelines/02-silver/build_silver.py --dry-run
    python3 pipelines/02-silver/build_silver.py --only sentinel-2
"""
import argparse, datetime as dt, hashlib, hmac, os, re, subprocess, sys, urllib.error, urllib.parse, urllib.request

def _repo_root():
    d = os.path.dirname(os.path.abspath(__file__))
    while d != os.path.dirname(d):
        if os.path.exists(os.path.join(d, ".git")) or os.path.exists(os.path.join(d, "AGENTS.md")):
            return d
        d = os.path.dirname(d)
    return os.getcwd()

ROOT = _repo_root()
BRONZE_PREFIX = "01-bronze/copphil-sentinel"
EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
# (sensor match, [builder scripts relative to ROOT])
BUILDERS = {
    "sentinel-2": ("MSIL2A", ["pipelines/02-silver/sentinel2-ndvi/build_ndvi.sh",
                              "pipelines/02-silver/sentinel2-truecolor/build_truecolor.sh"]),
    "sentinel-1": ("GRDH",   ["pipelines/02-silver/sentinel1-sar/build_sar.sh"]),
}

def load_env(path):
    if not os.path.exists(path): return
    for line in open(path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("="); os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

def _sk(secret, day, region, svc):
    k = hmac.new(("AWS4"+secret).encode(), day.encode(), hashlib.sha256).digest()
    for p in (region, svc, "aws4_request"): k = hmac.new(k, p.encode(), hashlib.sha256).digest()
    return k

def list_bronze(acct, bucket, ak, sk, prefix):
    host = f"{acct}.r2.cloudflarestorage.com"
    q = "&".join(f"{urllib.parse.quote(k,safe='')}={urllib.parse.quote(v,safe='')}"
                 for k, v in sorted({"list-type":"2","prefix":prefix+"/"}.items()))
    now = dt.datetime.now(dt.timezone.utc); amz = now.strftime("%Y%m%dT%H%M%SZ"); day = now.strftime("%Y%m%d")
    hdr = {"host": host, "x-amz-content-sha256": EMPTY, "x-amz-date": amz}
    signed = ";".join(sorted(hdr)); canon_h = "".join(f"{h}:{hdr[h]}\n" for h in sorted(hdr))
    canon = "\n".join(["GET", "/"+bucket, q, canon_h, signed, EMPTY])
    scope = f"{day}/auto/s3/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canon.encode()).hexdigest()])
    sig = hmac.new(_sk(sk, day, "auto", "s3"), sts.encode(), hashlib.sha256).hexdigest()
    hdr["Authorization"] = f"AWS4-HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders={signed}, Signature={sig}"
    url = f"https://{host}/{bucket}?{q}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=60) as r:
        return re.findall(r"<Key>([^<]+)</Key>", r.read().decode())

def main():
    load_env(os.environ.get("R2_ENV_FILE", os.path.join(ROOT, ".env.r2")))
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", choices=list(BUILDERS), help="only this sensor")
    ap.add_argument("--dry-run", action="store_true", help="list what would build, run nothing")
    args = ap.parse_args()
    acct, bucket = os.environ.get("R2_ACCOUNT_ID"), os.environ.get("R2_BUCKET")
    ak, sk = os.environ.get("AWS_ACCESS_KEY_ID"), os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not all([acct, bucket, ak, sk]): sys.exit("!! need R2_* / AWS_* in .env.r2")

    keys = [k for k in list_bronze(acct, bucket, ak, sk, BRONZE_PREFIX) if k.lower().endswith(".zip")]
    scenes = sorted(os.path.basename(k) for k in keys)
    print(f">> {len(scenes)} bronze scene(s)")
    sensors = [args.only] if args.only else list(BUILDERS)
    totals = {"ok": 0, "skip/err": 0}
    for scene in scenes:
        for sensor in sensors:
            token, builders = BUILDERS[sensor]
            if token not in scene: continue
            for b in builders:
                print(f"\n>> {scene}  ->  {os.path.basename(b)}")
                if args.dry_run: continue
                env = {**os.environ, "SCENE": scene}
                rc = subprocess.run(["bash", os.path.join(ROOT, b)], env=env).returncode
                totals["ok" if rc == 0 else "skip/err"] += 1
    print(f"\n>> TOTAL builder runs: {totals}")
    print(">> done.")

if __name__ == "__main__":
    main()
