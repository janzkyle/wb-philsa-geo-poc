#!/usr/bin/env python3
"""
build_catalog_from_stac.py — generate a TerriaJS catalog init from our STAC API.

TerriaJS 8.x has no native STAC catalog type, so instead of pointing Terria at
the STAC API directly we *derive* a Terria catalog from it: query each STAC
collection's items and emit one Terria `url-template-imagery` member per item,
whose tiles come from TiTiler (the same dynamic tiler + styling the webmap uses).

Re-run this whenever the catalog changes to keep the dashboard in sync:

    python3 dashboard/build_catalog_from_stac.py            # writes wwwroot/init/philsa.json
    STAC_API=http://localhost:8082 TITILER=http://localhost:8083 python3 ...

It reads nothing secret; TiTiler reads the COGs from R2 server-side.
"""
import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

STAC_API = os.environ.get("STAC_API", "http://localhost:8082").rstrip("/")
TITILER = os.environ.get("TITILER", "http://localhost:8083").rstrip("/")
OUT = Path(__file__).parent / "wwwroot" / "init" / "philsa.json"

# ESRI LULC discrete 9-class colormap (Impact Observatory), URL-encoded for TiTiler.
LULC_COLORMAP = urllib.parse.quote(json.dumps({
    "1": [26, 91, 171, 255], "2": [53, 130, 33, 255], "4": [135, 209, 158, 255],
    "5": [255, 219, 92, 255], "7": [237, 2, 42, 255], "8": [237, 233, 228, 255],
    "9": [242, 250, 255, 255], "10": [200, 200, 200, 255], "11": [198, 173, 141, 255],
}), safe="")

# Per-collection presentation: human name + TiTiler style query (matches the webmap).
RASTER = {
    "sentinel2-truecolor": {
        "name": "Sentinel-2 True Colour",
        "style": "",  # native 8-bit RGB
        "blurb": "Natural-colour optical view (Sentinel-2, 10 m).",
    },
    "sentinel2-ndvi": {
        "name": "Sentinel-2 NDVI",
        "style": "rescale=-0.2,0.8&colormap_name=rdylgn",
        "blurb": "Vegetation greenness index. Green = dense vegetation, red = bare/water.",
    },
    "sentinel1-sar": {
        "name": "Sentinel-1 SAR (VV, dB)",
        "style": "rescale=20,52",
        "blurb": "Radar backscatter (grayscale). Sees through cloud; bright = rough/built.",
    },
    "esri-10m-lulc": {
        "name": "ESRI Land Cover (10 m, annual)",
        "style": f"colormap={LULC_COLORMAP}",
        "blurb": "Annual land-cover classes (Impact Observatory). Categorical context layer.",
    },
    "diwata-2": {
        "name": "Diwata-2 SMI (true colour)",
        "asset": "top-of-atmosphere-reflectance",  # public COG on GCS (by reference)
        # 9-band float32 TOA; true colour = V670 (b4) / V550 (b2) / V490 (b1),
        # per-band rescale from the COG's p98 stats.
        "style": "bidx=4&bidx=2&bidx=1&rescale=0,257&rescale=0,206&rescale=0,130",
        "blurb": "Philippine Diwata-2 multispectral imager (by reference; public COG on GCS).",
        "sample": 12,  # collection has 100+ scenes — show the most recent sample
    },
}

# By-reference collections with NO map-tileable asset (thumbnails + cloud metadata
# only). Represented as labelled info groups so the catalog is complete.
INFO_ONLY = {
    "skysat": "SkySat (Planet) — high-res optical",
    "planetscope": "PlanetScope (Planet) — daily optical",
}

# Draw order (workbench top -> bottom); raster basemaps below thematic layers.
ORDER = [
    "sentinel2-ndvi", "sentinel1-sar", "esri-10m-lulc",
    "sentinel2-truecolor", "diwata-2",
]

# Workbench legends per collection (Terria LegendTraits items, top -> bottom).
# Mirrors the TiTiler styling so the key is truthful to what's drawn.
LEGENDS = {
    "sentinel2-ndvi": [
        {"color": "#006837", "title": "0.8 — dense vegetation"},
        {"color": "#66bd63", "title": "0.5"},
        {"color": "#d9ef8b", "title": "0.2"},
        {"color": "#fee08b", "title": "0.0"},
        {"color": "#f46d43", "title": "−0.1"},
        {"color": "#a50026", "title": "−0.2 — bare soil / water"},
    ],
    "sentinel1-sar": [
        {"color": "#ffffff", "title": "52 dB — rough / built-up"},
        {"color": "#aaaaaa", "title": "40 dB"},
        {"color": "#555555", "title": "28 dB"},
        {"color": "#000000", "title": "20 dB — smooth / water"},
    ],
    "esri-10m-lulc": [
        {"color": "#1A5BAB", "title": "Water"},
        {"color": "#358221", "title": "Trees"},
        {"color": "#87D19E", "title": "Flooded vegetation"},
        {"color": "#FFDB5C", "title": "Crops"},
        {"color": "#ED022A", "title": "Built area"},
        {"color": "#EDE9E4", "title": "Bare ground"},
        {"color": "#C6AD8D", "title": "Rangeland"},
        {"color": "#F2FAFF", "title": "Snow / ice"},
        {"color": "#C8C8C8", "title": "Clouds"},
    ],
    # true-colour is native RGB — no legend
}


def get_json(url):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def tile_url(href, style):
    enc = urllib.parse.quote(href, safe="")
    qs = f"url={enc}" + (f"&{style}" if style else "")
    return f"{TITILER}/cog/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}.png?{qs}"


def day_of(props):
    dt = props.get("datetime") or props.get("start_datetime") or ""
    return dt[:10] if dt else ""


def short_id(item_id):
    # a compact tile/scene token so same-day granules are distinguishable
    parts = item_id.replace(".", "_").replace("-", "_").split("_")
    for p in parts:
        # Sentinel MGRS tile like T51QWA
        if p.startswith("T") and len(p) == 6 and p[1:3].isdigit() and p[3:].isupper():
            return p
        # ESRI LULC grid-zone tile like 52P (uppercase band letter, not "10m")
        if len(p) == 3 and p[:2].isdigit() and p[2].isalpha() and p[2].isupper():
            return p
    # SAR (no tile): the unique scene id sits just before the "COG" token
    if "COG" in parts:
        i = parts.index("COG")
        if i > 0:
            return parts[i - 1]
    return parts[-1][:8]


def dt_of(props):
    return props.get("datetime") or props.get("start_datetime") or ""


def label(f):
    """Human label: date + a distinguishing token (MGRS tile, scene id, or time)."""
    props = f.get("properties", {})
    d = day_of(props)
    tok = short_id(f["id"])
    if tok in ("L1C", "L2A", "data") or len(tok) <= 2:
        t = dt_of(props)
        tok = t[11:16] if len(t) >= 16 else tok  # HH:MM
    return f"{d} · {tok}" if d else tok


def build_collection_group(coll_id):
    info = RASTER[coll_id]
    asset_key = info.get("asset", "data")
    fc = get_json(f"{STAC_API}/collections/{coll_id}/items?limit=200")
    feats = fc.get("features", [])
    # newest first, then optionally cap large collections to a recent sample
    feats.sort(key=lambda f: dt_of(f.get("properties", {})), reverse=True)
    if info.get("sample"):
        feats = feats[: info["sample"]]
    members = []
    for f in feats:
        href = (f.get("assets", {}).get(asset_key) or {}).get("href")
        if not href:
            continue
        member = {
            "type": "url-template-imagery",
            "id": f"philsa-{f['id']}",
            "name": label(f),
            "url": tile_url(href, info["style"]),
            "opacity": 0.85,
            "rectangle": rect(f.get("bbox")),
        }
        if coll_id in LEGENDS:
            member["legends"] = [{"title": info["name"], "items": LEGENDS[coll_id]}]
        members.append(member)
    return {
        "type": "group",
        "id": f"philsa-{coll_id}",
        "name": info["name"],
        "description": info["blurb"]
        + f" Tiled on the fly by TiTiler from the `{coll_id}` STAC collection ({len(members)} item(s)).",
        "members": members,
    }


def rect(bbox):
    if not bbox or len(bbox) < 4:
        return None
    return {"west": bbox[0], "south": bbox[1], "east": bbox[2], "north": bbox[3]}


def build_info_group(coll_id, label):
    """A non-tiled by-reference collection: count items, link a sample thumbnail."""
    fc = get_json(f"{STAC_API}/collections/{coll_id}/items?limit=200")
    feats = fc.get("features", [])
    thumb = ""
    for f in feats:
        t = (f.get("assets", {}).get("thumbnail") or {})
        if t.get("href", "").startswith("http"):
            thumb = f"\n\n![preview]({t['href']})"
            break
    return {
        "type": "group",
        "id": f"philsa-{coll_id}",
        "name": f"{label} (by reference, not tiled)",
        "description": (
            f"The `{coll_id}` STAC collection ({len(feats)} item(s)) is catalogued "
            "**by reference** — only thumbnails and cloud-hosted metadata are public, "
            "so there is no map-tileable COG to render here. Browse the items via the "
            f"STAC API: {STAC_API}/collections/{coll_id}/items" + thumb
        ),
        "members": [],
    }


def main():
    collections = get_json(f"{STAC_API}/collections").get("collections", [])
    have = {c["id"] for c in collections}
    groups = []
    for coll_id in ORDER:
        if coll_id in have:
            g = build_collection_group(coll_id)
            if g["members"]:
                groups.append(g)
    info_groups = [build_info_group(c, lbl) for c, lbl in INFO_ONLY.items() if c in have]
    # anything we don't explicitly handle (should be none)
    other = sorted(have - set(RASTER) - set(INFO_ONLY))
    catalog = [{
        "type": "group",
        "id": "philsa-poc",
        "name": "PhilSA POC — STAC Catalog",
        "description": (
            "Earth-observation products from the PhilSA POC STAC API. Raster collections "
            "are tiled live by TiTiler; by-reference optical collections without a public "
            "COG are listed as info groups. Generated by `dashboard/build_catalog_from_stac.py` "
            "— re-run to resync. "
            + (f"Unhandled collections: {', '.join(other)}." if other else "")
        ),
        "isOpen": True,
        "members": groups + info_groups,
    }]
    doc = {
        # Flat EO-raster dashboard: default to the 2D (Leaflet) map so it never
        # tries to load Cesium 3D terrain ("Terrain Server Not Responding").
        "viewerMode": "2d",
        "homeCamera": {"north": 21.5, "east": 127.0, "south": 4.0, "west": 116.0},
        "initialCamera": {"north": 18.9, "east": 123.6, "south": 13.4, "west": 119.4},
        "corsDomains": ["localhost", "127.0.0.1"],
        "catalog": catalog,
    }
    OUT.write_text(json.dumps(doc, indent=2) + "\n")
    n = sum(len(g["members"]) for g in groups)
    print(f"wrote {OUT} — {len(groups)} collection group(s), {n} tiled item(s)")
    if other:
        print(f"  (skipped non-tiled collections: {', '.join(other)})")


if __name__ == "__main__":
    main()
