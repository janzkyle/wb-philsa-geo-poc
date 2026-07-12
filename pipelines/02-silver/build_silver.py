#!/usr/bin/env python3
"""
build_silver.py — batch driver: turn every raw bronze scene into its silver
COG(s), by invoking the per-product builders.

  ndvi       Sentinel-2 (MSIL2A) -> sentinel2-ndvi/build_ndvi.sh
  truecolor  Sentinel-2 (MSIL2A) -> sentinel2-truecolor/build_truecolor.sh
  sar        Sentinel-1 (GRDH)   -> sentinel1-sar/build_sar.sh
  flood      Sentinel-1 (GRDH)   -> sentinel1-flood/build_flood.sh
             (runs after `sar` for the same scene; reads the silver VV-dB COG)
  ratio      Sentinel-1 (GRDH)   -> sentinel1-ratio/build_ratio.sh
             (VH/VV cross-ratio dB; reads both pols from the bronze zip)

Scene discovery is LOCAL-FIRST: it enumerates the local bronze dir
(`eodata/`, where download_copphil_eodata.py stages scenes) and, if R2 creds are
present, unions in any scenes that live only in `01-bronze/copphil-sentinel/` on
R2. It then runs the matching builder(s) for each `.SAFE.zip`, passing SCENE=;
each builder itself resolves the bytes local-first (bronze dir → cache → R2), so
a scene present locally is never re-downloaded. Builders early-skip scenes whose
output already exists, so re-runs only build what's new. Exits nonzero if any
builder failed.

R2 is optional (used only to discover/fetch scenes not present locally); creds
come from the repo-root `.env`. Stdlib only. Usage (from repo root):
    python3 pipelines/02-silver/build_silver.py
    python3 pipelines/02-silver/build_silver.py --dry-run
    python3 pipelines/02-silver/build_silver.py --only ndvi
    python3 pipelines/02-silver/build_silver.py --only sentinel-1   # sar + flood
"""
import argparse, glob, os, subprocess, sys, urllib.error


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

BRONZE_DIR = os.environ.get("BRONZE_DIR", os.path.join(ROOT, "eodata"))  # local bronze scenes
BRONZE_PREFIX = "01-bronze/copphil-sentinel"
# product -> (scene-name token, builder script relative to ROOT). Order matters:
# `flood` must come after `sar` (it reads the silver VV-dB COG sar just built).
PRODUCTS = {
    "ndvi":      ("MSIL2A", "pipelines/02-silver/sentinel2-ndvi/build_ndvi.sh"),
    "truecolor": ("MSIL2A", "pipelines/02-silver/sentinel2-truecolor/build_truecolor.sh"),
    "sar":       ("GRDH",   "pipelines/02-silver/sentinel1-sar/build_sar.sh"),
    "flood":     ("GRDH",   "pipelines/02-silver/sentinel1-flood/build_flood.sh"),
    "ratio":     ("GRDH",   "pipelines/02-silver/sentinel1-ratio/build_ratio.sh"),
}
ALIASES = {"sentinel-2": ["ndvi", "truecolor"], "sentinel-1": ["sar", "flood", "ratio"]}


def scene_env(product, scene):
    """Env vars for one (product, scene) builder run."""
    env = {**os.environ, "BRONZE_DIR": BRONZE_DIR}
    if product == "flood":
        # flood's input is the silver VV-dB COG built from this scene, not the zip
        base = scene
        for suf in (".zip", ".SAFE"):
            if base.endswith(suf):
                base = base[: -len(suf)]
        sar_name = f"{base}_VV_dB.tif"
        env["SAR_NAME"] = sar_name
        local = os.path.join(os.environ.get("OUTPUT_DIR", os.path.join(ROOT, "eodata")), sar_name)
        if os.path.exists(local):
            env["SRC"] = local
    else:
        env["SCENE"] = scene
    return env


def main():
    load_env_file(os.environ.get("ENV_FILE", os.path.join(ROOT, ".env")))
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", choices=list(PRODUCTS) + list(ALIASES),
                    help="only this product (or all of a sensor's products)")
    ap.add_argument("--dry-run", action="store_true", help="list what would build, run nothing")
    args = ap.parse_args()
    # local-first discovery: the local bronze dir, then (if creds present) R2.
    local = sorted(os.path.basename(p) for p in glob.glob(os.path.join(BRONZE_DIR, "*.zip"))
                   if p.lower().endswith(".zip"))
    print(f">> {len(local)} local bronze scene(s) in {BRONZE_DIR}")

    acct, bucket = os.environ.get("R2_ACCOUNT_ID"), os.environ.get("R2_BUCKET")
    ak, sk = os.environ.get("AWS_ACCESS_KEY_ID"), os.environ.get("AWS_SECRET_ACCESS_KEY")
    r2_only = []
    if all([acct, bucket, ak, sk]):
        try:
            keys = [k for k in R2(acct, bucket, ak, sk).list_keys(BRONZE_PREFIX + "/")
                    if k.lower().endswith(".zip")]
            local_set = set(local)
            r2_only = sorted(b for b in (os.path.basename(k) for k in keys) if b not in local_set)
            print(f">> {len(r2_only)} additional scene(s) only in R2 {BRONZE_PREFIX}")
        except (urllib.error.URLError, OSError) as e:
            print(f">> R2 listing skipped ({e}); using local only")
    else:
        print(">> no R2 creds; using local only")

    scenes = local + r2_only  # local first, R2-only scenes appended
    if not scenes:
        sys.exit(f"!! no bronze scenes found (local {BRONZE_DIR} empty and no R2 scenes)")
    print(f">> {len(scenes)} bronze scene(s) total")
    products = ALIASES.get(args.only, [args.only] if args.only else list(PRODUCTS))
    totals = {"ok": 0, "failed": 0}
    failed = []
    for scene in scenes:
        for product in products:
            token, builder = PRODUCTS[product]
            if token not in scene:
                continue
            print(f"\n>> {scene}  ->  {product} ({os.path.basename(builder)})")
            if args.dry_run:
                continue
            rc = subprocess.run(["bash", os.path.join(ROOT, builder)],
                                env=scene_env(product, scene)).returncode
            if rc == 0:
                totals["ok"] += 1
            else:
                totals["failed"] += 1
                failed.append(f"{product}:{scene}")
    print(f"\n>> TOTAL builder runs: {totals}")
    if failed:
        print(">> failed:\n   " + "\n   ".join(failed), file=sys.stderr)
        sys.exit(1)
    print(">> done.")


if __name__ == "__main__":
    main()
