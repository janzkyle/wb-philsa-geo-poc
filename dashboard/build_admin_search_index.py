#!/usr/bin/env python3
"""
build_admin_search_index.py — emit a small name->bbox index for the dashboard's
PhilSA admin-area search (the "fly to a region/province" filter).

Why a separate index: the boundaries themselves render from PMTiles (mvt), but
Terria's native feature-search is wired only to 3D Tiles, so the custom
`philsa-admin-search-provider` needs a lightweight lookup of {name, tier, bbox}
to zoom the camera. This derives that index from the canonical admin GeoParquet
(silver tier) — it is metadata, not geometry, and is fully regenerable.

Levels: adm0 (country) .. adm3 (city/municipality). adm4 (≈42k barangays) is
intentionally excluded — too many to be a usable search list.

    # from local parquet (fast):
    SRC_DIR=/path/to/parquet python3 build_admin_search_index.py
    # or straight from R2 over /vsis3 (needs repo-root .env creds):
    python3 build_admin_search_index.py

Output: wwwroot/data/{ph_admin_index,ph_admin_geom_adm0..3}.json

The dashboard serves these from R2 (see the search provider's `url` /
`geomBaseUrl` in wwwroot/config.json), so on completion this uploads them to
`s3://$R2_BUCKET/$DST_PREFIX/` via the `aws` CLI. Auto-upload is skipped (with a
notice) when R2 creds / the aws CLI are absent; pass --no-upload to skip it
explicitly, or set UPLOAD=0.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def _repo_root():
    d = os.path.dirname(os.path.abspath(__file__))
    while d != os.path.dirname(d):
        if os.path.exists(os.path.join(d, ".git")) or os.path.exists(os.path.join(d, "AGENTS.md")):
            return d
        d = os.path.dirname(d)
    return os.getcwd()


def load_env_file(path):
    """Populate os.environ from a repo-root .env (does not clobber real env)."""
    if not path or not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# Load repo-root .env before reading any R2 config below (same as the pipelines).
load_env_file(os.environ.get("ENV_FILE", os.path.join(_repo_root(), ".env")))

OUT = Path(__file__).parent / "wwwroot" / "data" / "ph_admin_index.json"

# level -> (human tier label, simplify tolerance in degrees for the bbox pass)
LEVELS = {
    0: ("Country", 0.02),
    1: ("Region", 0.01),
    2: ("Province", 0.008),
    3: ("City / Municipality", 0.005),
}

SRC_DIR = os.environ.get("SRC_DIR", "").rstrip("/")
R2_BUCKET = os.environ.get("R2_BUCKET", "")
R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
SRC_PREFIX = os.environ.get("SRC_PREFIX", "02-silver/ph-admin-boundaries")
# Where the generated JSON is uploaded — must match config.json's url/geomBaseUrl.
DST_PREFIX = os.environ.get("DST_PREFIX", SRC_PREFIX).strip("/")


def src_for(level):
    if SRC_DIR:
        return f"{SRC_DIR}/phl_adm{level}.parquet"
    return f"/vsis3/{R2_BUCKET}/{SRC_PREFIX}/phl_adm{level}.parquet"


def bbox_of(geom):
    """Min/max lon/lat over any GeoJSON geometry's coordinate arrays."""
    xs, ys = [], []

    def walk(coords):
        if not coords:
            return
        if isinstance(coords[0], (int, float)):
            xs.append(coords[0])
            ys.append(coords[1])
        else:
            for c in coords:
                walk(c)

    walk(geom.get("coordinates"))
    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def features_for(level, tol):
    """Run ogr2ogr -> simplified GeoJSON and yield (name, parent, pcode, bbox, geom)."""
    name_f = f"adm{level}_name"
    parent_f = f"adm{max(level - 1, 0)}_name"
    pcode_f = f"adm{level}_pcode"
    sel = ",".join({name_f, parent_f, pcode_f})
    cmd = [
        "ogr2ogr", "-f", "GeoJSON", "/vsistdout/", src_for(level),
        "-t_srs", "EPSG:4326", "-simplify", str(tol),
        "-select", sel, "-lco", "COORDINATE_PRECISION=4",
        "--config", "OGR2OGR_USE_ARROW_API", "NO",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.stderr.write(out.stderr[-2000:])
        raise SystemExit(f"ogr2ogr failed for adm{level}")
    fc = json.loads(out.stdout)
    for f in fc.get("features", []):
        props = f.get("properties", {})
        geom = f.get("geometry") or {}
        bb = bbox_of(geom)
        if bb:
            yield props.get(name_f), props.get(parent_f), props.get(pcode_f), bb, geom


def upload_to_r2(paths):
    """Copy the generated JSON to s3://$R2_BUCKET/$DST_PREFIX/ via the aws CLI.

    Non-fatal: prints a notice and returns if creds / bucket / aws are missing,
    so a build without R2 access still succeeds (files remain available locally).
    """
    missing = [n for n, v in (("R2_BUCKET", R2_BUCKET),
                              ("R2_ACCOUNT_ID", R2_ACCOUNT_ID),
                              ("AWS_ACCESS_KEY_ID", os.environ.get("AWS_ACCESS_KEY_ID")),
                              ("AWS_SECRET_ACCESS_KEY", os.environ.get("AWS_SECRET_ACCESS_KEY")))
               if not v]
    if missing:
        print(f"skip R2 upload — missing {', '.join(missing)} (files are local only)")
        return
    if shutil.which("aws") is None:
        print("skip R2 upload — 'aws' CLI not found on PATH (files are local only)")
        return

    endpoint = f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    env = dict(os.environ)
    env.setdefault("AWS_DEFAULT_REGION", "auto")  # R2 ignores region but the CLI wants one
    print(f"uploading {len(paths)} file(s) to s3://{R2_BUCKET}/{DST_PREFIX}/ ...")
    for p in paths:
        dst = f"s3://{R2_BUCKET}/{DST_PREFIX}/{p.name}"
        r = subprocess.run(
            ["aws", "s3", "cp", str(p), dst,
             "--endpoint-url", endpoint, "--content-type", "application/json"],
            capture_output=True, text=True, env=env,
        )
        if r.returncode != 0:
            sys.stderr.write(r.stderr[-2000:])
            raise SystemExit(f"aws s3 cp failed for {p.name}")
        print(f"  -> {dst}")


def main(upload=True):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    entries = []
    outputs = []  # every JSON file written, in upload order
    for level, (tier, tol) in LEVELS.items():
        n = 0
        geom_features = []  # per-level geometry, keyed by pcode, for the spotlight mask
        for name, parent, pcode, bb, geom in features_for(level, tol):
            if not name:
                continue
            # Disambiguate cities/municipalities (many share names) with the province.
            label = name if level <= 1 or not parent or parent == name else f"{name}, {parent}"
            entries.append({
                "name": label, "tier": tier, "level": level, "pcode": pcode,
                "w": round(bb[0], 4), "s": round(bb[1], 4),
                "e": round(bb[2], 4), "n": round(bb[3], 4),
            })
            geom_features.append({
                "type": "Feature", "properties": {"pcode": pcode}, "geometry": geom,
            })
            n += 1
        gpath = OUT.parent / f"ph_admin_geom_adm{level}.json"
        gpath.write_text(json.dumps(
            {"type": "FeatureCollection", "features": geom_features},
            separators=(",", ":")) + "\n")
        outputs.append(gpath)
        print(f"  adm{level} ({tier}): {n} units  ->  {gpath.name} "
              f"({gpath.stat().st_size // 1024} KB)")
    OUT.write_text(json.dumps(entries, separators=(",", ":")) + "\n")
    outputs.append(OUT)
    print(f"wrote {OUT} — {len(entries)} searchable admin areas, "
          f"{OUT.stat().st_size // 1024} KB")

    if upload:
        upload_to_r2(outputs)


if __name__ == "__main__":
    # Auto-upload to R2 by default; --no-upload (or UPLOAD=0) keeps it local-only.
    do_upload = "--no-upload" not in sys.argv and os.environ.get("UPLOAD", "1") != "0"
    main(upload=do_upload)
