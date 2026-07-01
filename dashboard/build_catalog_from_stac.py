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
R2_PUBLIC_BASE = os.environ.get(
    "R2_PUBLIC_BASE", "https://pub-17ab60a2ca7142a48ae8e2685cd853f7.r2.dev"
).rstrip("/")
OUT = Path(__file__).parent / "wwwroot" / "init" / "philsa.json"

# Collections with per-date MosaicJSON in R2 (built by build_raster_mosaics.sh).
# For these, same-day granules are combined into ONE layer per date (served via
# TiTiler /mosaicjson) instead of a separate layer per granule.
MOSAIC = {"sentinel2-ndvi", "sentinel2-truecolor", "sentinel1-sar", "esri-10m-lulc"}

# ESRI LULC discrete 9-class colormap (Impact Observatory), URL-encoded for TiTiler.
LULC_COLORMAP = urllib.parse.quote(json.dumps({
    "1": [26, 91, 171, 255], "2": [53, 130, 33, 255], "4": [135, 209, 158, 255],
    "5": [255, 219, 92, 255], "7": [237, 2, 42, 255], "8": [237, 233, 228, 255],
    "9": [242, 250, 255, 255], "10": [200, 200, 200, 255], "11": [198, 173, 141, 255],
}), safe="")

# Per-collection presentation: human name + TiTiler style query (matches the webmap).
RASTER = {
    "sentinel2-truecolor": {
        "name": "Natural-Colour Satellite Imagery",
        "style": "",  # native 8-bit RGB
        "blurb": "Natural-colour optical view (Sentinel-2, 10 m).",
    },
    "sentinel2-ndvi": {
        "name": "Vegetation Health (NDVI)",
        "style": "rescale=-0.2,0.9&colormap_name=rdylgn",  # matches webmap stretch
        "blurb": "Vegetation greenness index. Green = dense vegetation, red = bare/water.",
    },
    "sentinel1-sar": {
        "name": "All-Weather Radar Imagery",
        "style": "rescale=20,52",
        "blurb": "Radar backscatter (grayscale). Sees through cloud; bright = rough/built.",
    },
    "esri-10m-lulc": {
        "name": "ESRI Land Cover (10 m, annual)",
        "style": f"colormap={LULC_COLORMAP}",
        "blurb": "Annual land-cover classes (Impact Observatory). Categorical context layer.",
    },
    "mula": {
        "name": "MULA — True Colour (5 m)",
        "asset": "top-of-atmosphere-reflectance",  # simulated feed (Diwata-2 by reference)
        # true colour = V670 (b4) / V550 (b2) / V490 (b1), matching Diwata-2's stretch
        "style": "bidx=4&bidx=2&bidx=1&rescale=0,257&rescale=0,206&rescale=0,130",
        "blurb": "Philippine MULA 5 m true-colour multispectral imagery — near-real-time "
                 "demo feed (simulated: Diwata-2 scenes re-dated to recent days).",
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

# Administrative boundaries — read the SAME PMTiles the webmap uses, straight from
# R2. Terria's `mvt` item feeds its url to ProtomapsImageryProvider, which detects
# a `.pmtiles` suffix and range-reads the archive (protomaps-leaflet PmtilesSource).
# So there is no need for a separate per-level GeoJSON: GeoParquet stays the
# canonical source (silver), PMTiles is the single web derivative for BOTH frontends.
# `minz`/`maxz` mirror the per-level zoom envelopes baked by build_ph_admin_pmtiles.sh
# (tippecanoe), so dense levels only request tiles where they exist.
ADMIN = [
    {"level": 0, "name": "Country (adm0)",  "stroke": "#1d3557", "width": 2.2, "minz": 0, "maxz": 5},
    {"level": 1, "name": "Regions (adm1)",  "stroke": "#2a6f97", "width": 1.4, "minz": 0, "maxz": 7},
    {"level": 2, "name": "Provinces (adm2)", "stroke": "#4895ef", "width": 0.8, "minz": 2, "maxz": 9},
    {"level": 3, "name": "Cities / Municipalities (adm3)", "stroke": "#5fa8d3", "width": 0.6, "minz": 4, "maxz": 11},
    {"level": 4, "name": "Barangays (adm4)", "stroke": "#89c2d9", "width": 0.4, "minz": 6, "maxz": 13,
     "note": "Open data (not restricted). Barangay level — appears as you zoom in."},
]

# Public R2 base path holding the admin PMTiles (built by build_ph_admin_pmtiles.sh).
ADMIN_PMTILES_PREFIX = "02-silver/ph-admin-boundaries/pmtiles"

# Draw order (workbench top -> bottom); raster basemaps below thematic layers.
ORDER = [
    "mula",
    "sentinel2-ndvi", "sentinel1-sar", "esri-10m-lulc",
    "sentinel2-truecolor", "diwata-2",
]

# Workbench legends per collection (Terria LegendTraits items, top -> bottom).
# Mirrors the TiTiler styling so the key is truthful to what's drawn.
LEGENDS = {
    "sentinel2-ndvi": [
        {"color": "#006837", "title": "0.9 — dense vegetation"},
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


# ---- STAC metadata -> Terria description / info (only surface present fields) ----

_META_CACHE = {}


def coll_meta(coll_id):
    """Full STAC collection doc (cached) — title, description, license, extent, etc."""
    if coll_id not in _META_CACHE:
        try:
            _META_CACHE[coll_id] = get_json(f"{STAC_API}/collections/{coll_id}")
        except Exception:
            _META_CACHE[coll_id] = {}
    return _META_CACHE[coll_id]


def fmt_temporal(interval):
    if not interval or not interval[0]:
        return None
    s, e = (interval[0] + [None, None])[:2]
    s = (s or "")[:10]
    e = (e or "")[:10] or "present"
    return f"{s} → {e}" if s else e


def fmt_bbox(bbox):
    if not bbox or len(bbox) < 4:
        return None
    return (f"{bbox[1]:.2f}°–{bbox[3]:.2f}° N, "
            f"{bbox[0]:.2f}°–{bbox[2]:.2f}° E")


def providers_str(provs):
    out = []
    for p in provs or []:
        nm = p.get("name")
        roles = p.get("roles") or []
        if nm:
            out.append(nm + (f" ({', '.join(roles)})" if roles else ""))
    return "; ".join(out) if out else None


def coll_info_sections(coll_id):
    """Terria `info` sections built only from STAC fields that are present."""
    m = coll_meta(coll_id)
    secs = []
    desc = (m.get("description") or "").strip()
    if desc:
        secs.append({"name": "About this dataset", "content": desc})

    cov = []
    t = fmt_temporal((m.get("extent", {}).get("temporal", {}) or {}).get("interval"))
    if t:
        cov.append(f"**Time span:** {t}")
    bb = (m.get("extent", {}).get("spatial", {}) or {}).get("bbox") or [None]
    area = fmt_bbox(bb[0])
    if area:
        cov.append(f"**Coverage:** {area}")
    if cov:
        secs.append({"name": "Coverage", "content": "  \n".join(cov)})

    sl = []
    pr = providers_str(m.get("providers"))
    if pr:
        sl.append(f"**Provider:** {pr}")
    lic = m.get("license")
    if lic == "proprietary":
        sl.append("**Licence:** proprietary (restricted)")
    elif lic:
        sl.append(f"**Licence:** {lic}")
    kw = m.get("keywords")
    if kw:
        sl.append(f"**Keywords:** {', '.join(kw)}")
    if sl:
        secs.append({"name": "Source & licence", "content": "  \n".join(sl)})
    return secs


def coll_metadata_urls(coll_id):
    return [{
        "title": "STAC collection (JSON)",
        "url": f"{STAC_API}/collections/{coll_id}",
    }]


def plat_instr(props):
    """Compact per-item acquisition line from whichever fields exist."""
    bits = []
    plat = props.get("platform") or props.get("constellation")
    if plat:
        bits.append(f"*Platform:* {plat}")
    instr = props.get("instruments")
    if isinstance(instr, list):
        instr = ", ".join(instr)
    if instr:
        bits.append(f"*Instrument:* {instr}")
    gsd = props.get("gsd")
    if gsd:
        bits.append(f"*GSD:* {gsd} m")
    cc = props.get("eo:cloud_cover")
    if cc is not None:
        bits.append(f"*Cloud:* {cc}%")
    return " · ".join(bits)


def thumb_href(feat):
    t = (feat.get("assets", {}).get("thumbnail") or {})
    href = t.get("href", "")
    return href if href.startswith("http") else None


def tile_url(href, style):
    enc = urllib.parse.quote(href, safe="")
    qs = f"url={enc}" + (f"&{style}" if style else "")
    return f"{TITILER}/cog/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}.png?{qs}"


def mosaic_tile_url(coll, date, style):
    """One combined layer for a (collection, date): TiTiler tiles the per-date
    MosaicJSON that stitches that day's granules into a single seamless raster."""
    murl = f"{R2_PUBLIC_BASE}/02-silver/{coll}/mosaics/{coll}_{date}.mosaicjson"
    enc = urllib.parse.quote(murl, safe="")
    qs = f"url={enc}" + (f"&{style}" if style else "")
    return f"{TITILER}/mosaicjson/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}.png?{qs}"


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


def legends_for(coll_id, info):
    if coll_id in LEGENDS:
        return [{"title": info["name"], "items": LEGENDS[coll_id]}]
    return None


def date_mosaic_members(coll_id, info):
    """One combined layer per acquisition date (same-day granules merged)."""
    fc = get_json(f"{STAC_API}/collections/{coll_id}/items?limit=500")
    bydate = {}
    for f in fc.get("features", []):
        d = day_of(f.get("properties", {}))
        if d:
            bydate.setdefault(d, []).append(f)
    members = []
    for d in sorted(bydate, reverse=True):  # newest first
        feats = bydate[d]
        acq = plat_instr(feats[0].get("properties", {}))
        desc = f"**{info['name']}** — acquired **{d}**.  \n"
        desc += (f"{len(feats)} granule(s) combined into one seamless layer "
                 "for this date.")
        if acq:
            desc += "  \n" + acq
        m = {
            "type": "url-template-imagery",
            "id": f"philsa-{coll_id}-{d}",
            "name": d,  # date only — granules are combined, so no scene token
            "description": desc,
            "url": mosaic_tile_url(coll_id, d, info["style"]),
            "opacity": 0.85,
            "rectangle": rect(union_bbox(f.get("bbox") for f in feats)),
        }
        legs = legends_for(coll_id, info)
        if legs:
            m["legends"] = legs
        members.append(m)
    return members


def scene_members(coll_id, info, asset_key):
    """One layer per scene (collections without a per-date mosaic, e.g. Diwata-2)."""
    fc = get_json(f"{STAC_API}/collections/{coll_id}/items?limit=200")
    feats = sorted(
        fc.get("features", []),
        key=lambda f: dt_of(f.get("properties", {})), reverse=True,
    )
    if info.get("sample"):
        feats = feats[: info["sample"]]
    members = []
    for f in feats:
        href = (f.get("assets", {}).get(asset_key) or {}).get("href")
        if not href:
            continue
        props = f.get("properties", {})
        d = day_of(props)
        desc = f"**{info['name']}**"
        if d:
            desc += f" — acquired **{d}**"
        acq = plat_instr(props)
        if acq:
            desc += "  \n" + acq
        th = thumb_href(f)
        if th:
            desc += f"\n\n![preview]({th})"
        m = {
            "type": "url-template-imagery",
            "id": f"philsa-{f['id']}",
            "name": label(f),
            "description": desc,
            "url": tile_url(href, info["style"]),
            "opacity": 0.85,
            "rectangle": rect(f.get("bbox")),
        }
        legs = legends_for(coll_id, info)
        if legs:
            m["legends"] = legs
        members.append(m)
    return members


def build_collection_group(coll_id):
    info = RASTER[coll_id]
    if coll_id in MOSAIC:
        members = date_mosaic_members(coll_id, info)
        how = "Same-day granules are combined into one per-date layer (TiTiler /mosaicjson)"
        unit = "date"
    else:
        members = scene_members(coll_id, info, info.get("asset", "data"))
        how = "One layer per scene, tiled by TiTiler"
        unit = "scene"
    return {
        "type": "group",
        "id": f"philsa-{coll_id}",
        "name": info["name"],
        "description": info["blurb"]
        + f" {how} from the `{coll_id}` STAC collection ({len(members)} {unit}(s)).",
        "info": coll_info_sections(coll_id),
        "metadataUrls": coll_metadata_urls(coll_id),
        "members": members,
    }


def rect(bbox):
    if not bbox or len(bbox) < 4:
        return None
    return {"west": bbox[0], "south": bbox[1], "east": bbox[2], "north": bbox[3]}


def union_bbox(bboxes):
    bs = [b for b in bboxes if b and len(b) >= 4]
    if not bs:
        return None
    return [min(b[0] for b in bs), min(b[1] for b in bs),
            max(b[2] for b in bs), max(b[3] for b in bs)]


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
        "info": coll_info_sections(coll_id),
        "metadataUrls": coll_metadata_urls(coll_id),
        "members": [],
    }


def build_admin_group():
    """PH admin boundaries (adm0-4) as vector-tile (mvt/PMTiles) outlines from R2,
    off by default. Same PMTiles the webmap reads — no separate GeoJSON."""
    members = []
    for a in ADMIN:
        L = a["level"]
        layer = f"adm{L}"
        label = a["name"].split(" (")[0]
        members.append({
            "type": "mvt",
            "id": f"philsa-adm{L}",
            "name": a["name"],
            "url": f"{R2_PUBLIC_BASE}/{ADMIN_PMTILES_PREFIX}/phl_adm{L}.pmtiles",
            "description": (
                f"Philippine administrative boundaries — **{label}**. Vector tiles "
                "(PMTiles) streamed from R2 — the same web derivative the webmap uses; "
                "canonical geometry lives in the admin-boundary GeoParquet (silver "
                "tier). Click a feature to read its attributes (name, P-code, area)."
                + (f"\n\n_{a['note']}_" if a.get("note") else "")
            ),
            # `style` (Mapbox subset) gives line-width control; outlines only, no fill.
            "layer": layer,
            "style": {"layers": [{
                "type": "line", "source-layer": layer,
                "paint": {"line-color": a["stroke"], "line-width": a["width"],
                          "line-opacity": 1},
            }]},
            "idProperty": f"adm{L}_pcode",
            "nameProperty": f"adm{L}_name",
            "minimumZoom": a["minz"],
            "maximumNativeZoom": a["maxz"],
            "legends": [{"title": a["name"],
                         "items": [{"color": a["stroke"], "title": label}]}],
            "opacity": 1,
        })
    return {
        "type": "group",
        "id": "philsa-admin",
        "name": "Administrative Boundaries (PH)",
        "description": (
            "Philippine administrative boundaries — country, region, province, "
            "city/municipality and barangay (adm0–adm4). **All levels are open data.** "
            "Streamed as PMTiles vector tiles from R2 (the same derivative the webmap "
            "uses); the canonical geometry is the admin-boundary GeoParquet (silver "
            "tier). Off by default — enable a level to overlay it on any imagery. "
            "Dense levels (city/municipality, barangay) appear as you zoom in."
        ),
        "members": members,
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
    admin_group = build_admin_group()
    # anything we don't explicitly handle (should be none)
    other = sorted(have - set(RASTER) - set(INFO_ONLY))
    members = list(groups)
    if admin_group:
        members.append(admin_group)
    members += info_groups
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
        "members": members,
    }]
    doc = {
        # Flat EO-raster dashboard: default to the 2D (Leaflet) map so it never
        # tries to load Cesium 3D terrain ("Terrain Server Not Responding").
        "viewerMode": "2d",
        "homeCamera": {"north": 21.5, "east": 127.0, "south": 4.0, "west": 116.0},
        "initialCamera": {"north": 18.9, "east": 123.6, "south": 13.4, "west": 119.4},
        # List the R2 host as CORS-capable so Terria range-reads the admin PMTiles
        # directly (R2 serves CORS + range) instead of proxying through terriajs-server.
        "corsDomains": ["localhost", "127.0.0.1",
                        urllib.parse.urlparse(R2_PUBLIC_BASE).netloc],
        "catalog": catalog,
    }
    OUT.write_text(json.dumps(doc, indent=2) + "\n")
    n = sum(len(g["members"]) for g in groups)
    print(f"wrote {OUT} — {len(groups)} collection group(s), {n} tiled item(s)")
    if other:
        print(f"  (skipped non-tiled collections: {', '.join(other)})")


if __name__ == "__main__":
    main()
