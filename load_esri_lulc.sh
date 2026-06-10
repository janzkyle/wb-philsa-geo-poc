#!/usr/bin/env bash
#
# load_esri_lulc.sh — register ESRI 10m Annual LULC (Impact Observatory v003)
# COGs covering the Philippines into the local stac-fastapi-pgstac, *by reference*.
#
# Asset hrefs point straight at the public Azure blobs; pgstac stores only the
# JSON pointer and clients stream pixels via HTTP range requests (/vsicurl/).
# All geo-metadata (footprint, bbox, proj:*) is read from each COG at runtime.
#
# By default it loads every MGRS grid-zone tile that covers the Philippines:
# UTM zones 50/51/52 x latitude bands N (0-8N), P (8-16N), Q (16-24N).
# Tiles that don't exist for the year, or whose footprint doesn't intersect the
# PH bounding box, are skipped automatically.
#
# Requirements: gdalinfo (GDAL), curl, python3.  API up on $STAC_API.
#
# Usage:
#   ./load_esri_lulc.sh                       # all PH tiles, year 2025
#   YEAR=2024 ./load_esri_lulc.sh             # all PH tiles, another year
#   TILES="51P 51Q" ./load_esri_lulc.sh       # a custom subset
#   STAC_API=http://localhost:8082 ./load_esri_lulc.sh
#
set -euo pipefail

# ---- parameters -------------------------------------------------------------
YEAR="${YEAR:-2025}"
STAC_API="${STAC_API:-http://localhost:8082}"
COLLECTION="${COLLECTION:-esri-10m-lulc}"
# MGRS grid-zone tiles covering the Philippines (override with TILES="...").
TILES="${TILES:-50N 50P 50Q 51N 51P 51Q 52N 52P}"
# PH bounding box "minx miny maxx maxy"; tiles not intersecting it are skipped.
PH_BBOX="${PH_BBOX:-116.0 4.0 127.0 21.5}"
BLOB_BASE="https://lulctimeseries.blob.core.windows.net/lulctimeseriesv003"

echo ">> year=${YEAR}  api=${STAC_API}  collection=${COLLECTION}"
echo ">> tiles: ${TILES}"

# ---- ensure the Collection exists (once) ------------------------------------
if curl -fsS "${STAC_API}/collections/${COLLECTION}" >/dev/null 2>&1; then
  echo ">> collection '${COLLECTION}' already exists"
else
  echo ">> creating collection '${COLLECTION}' ..."
  curl -fsS -X POST "${STAC_API}/collections" \
    -H 'Content-Type: application/json' -d @- <<JSON >/dev/null
{
  "type": "Collection",
  "stac_version": "1.0.0",
  "id": "${COLLECTION}",
  "title": "ESRI 10m Annual Land Use/Land Cover (Impact Observatory v003)",
  "description": "Sentinel-2 derived 10m annual global LULC, 9-class scheme. Items reference public Azure COGs by href (not re-hosted).",
  "license": "CC-BY-4.0",
  "providers": [
    {"name": "Impact Observatory", "roles": ["producer", "processor"], "url": "https://www.impactobservatory.com/"},
    {"name": "Esri", "roles": ["host"], "url": "https://livingatlas.arcgis.com/landcover/"}
  ],
  "extent": {
    "spatial": {"bbox": [[116.9, 4.6, 126.6, 21.1]]},
    "temporal": {"interval": [["2017-01-01T00:00:00Z", null]]}
  },
  "links": []
}
JSON
fi

# ---- per-tile loader --------------------------------------------------------
# load_tile <TILE>  ->  echoes a one-line status
load_tile() {
  local tile="$1"
  local href="${BLOB_BASE}/lc${YEAR}/${tile}_${YEAR}0101-${YEAR}1231.tif"
  local vsi="/vsicurl/${href}"
  local item_id="${COLLECTION}-${tile}-${YEAR}"

  # existence check (cheap 1-byte range request)
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -r 0-0 "$href" --max-time 30 || echo 000)
  if [ "$code" != "200" ] && [ "$code" != "206" ]; then
    echo "  [${tile}] not found for ${YEAR} (HTTP ${code}) — skipped"
    return 0
  fi

  local gdalinfo
  if ! gdalinfo="$(gdalinfo -json "$vsi" 2>/dev/null)"; then
    echo "  [${tile}] gdalinfo failed — skipped"
    return 0
  fi

  # Build the Item JSON. Python prints "SKIP" if the footprint misses PH_BBOX.
  local item_json
  item_json="$(
    HREF="$href" TILE="$tile" YEAR="$YEAR" COLLECTION="$COLLECTION" \
    PH_BBOX="$PH_BBOX" GDALINFO="$gdalinfo" \
    python3 - <<'PY'
import os, json, re, sys

g = json.loads(os.environ["GDALINFO"])
href = os.environ["HREF"]; tile = os.environ["TILE"]
year = int(os.environ["YEAR"]); collection = os.environ["COLLECTION"]
ph = [float(x) for x in os.environ["PH_BBOX"].split()]

# WGS84 footprint
ext = g["wgs84Extent"]["coordinates"]
xs = [p[0] for ring in ext for p in ring]
ys = [p[1] for ring in ext for p in ring]
bbox = [min(xs), min(ys), max(xs), max(ys)]

# skip tiles whose footprint doesn't intersect the PH bbox
if bbox[0] > ph[2] or bbox[2] < ph[0] or bbox[1] > ph[3] or bbox[3] < ph[1]:
    print("SKIP"); sys.exit(0)

# native grid + EPSG (fall back to 326<zone> for northern UTM zones)
gt = g["geoTransform"]; W, H = g["size"]
m = re.search(r'ID\["EPSG",\s*(\d+)\]\s*\]\s*$', g["coordinateSystem"]["wkt"].strip())
epsg = int(m.group(1)) if m else 32600 + int(tile[:2])
proj_bbox_native = [gt[0], gt[3] + gt[5]*H, gt[0] + gt[1]*W, gt[3]]

classes = [
    {"value": 1,  "name": "Water",              "color_hint": "1A5BAB"},
    {"value": 2,  "name": "Trees",              "color_hint": "358221"},
    {"value": 4,  "name": "Flooded vegetation", "color_hint": "87D19E"},
    {"value": 5,  "name": "Crops",              "color_hint": "FFDB5C"},
    {"value": 7,  "name": "Built area",         "color_hint": "ED022A"},
    {"value": 8,  "name": "Bare ground",        "color_hint": "EDE9E4"},
    {"value": 9,  "name": "Snow/ice",           "color_hint": "F2FAFF"},
    {"value": 10, "name": "Clouds",             "color_hint": "C8C8C8"},
    {"value": 11, "name": "Rangeland",          "color_hint": "C6AD8D"},
]

item = {
    "type": "Feature",
    "stac_version": "1.0.0",
    "stac_extensions": [
        "https://stac-extensions.github.io/projection/v1.1.0/schema.json",
        "https://stac-extensions.github.io/classification/v1.1.0/schema.json",
        "https://stac-extensions.github.io/raster/v1.1.0/schema.json"
    ],
    "id": f"{collection}-{tile}-{year}",
    "collection": collection,
    "geometry": {"type": "Polygon", "coordinates": ext},
    "bbox": bbox,
    "properties": {
        "datetime": None,
        "start_datetime": f"{year}-01-01T00:00:00Z",
        "end_datetime":   f"{year}-12-31T23:59:59Z",
        "esri:tile": tile,
        "proj:epsg": epsg,
        "proj:shape": [H, W],
        "proj:transform": [gt[1], gt[2], gt[0], gt[4], gt[5], gt[3]],
        "proj:bbox": proj_bbox_native
    },
    "assets": {
        "data": {
            "href": href,
            "type": "image/tiff; application=geotiff; profile=cloud-optimized",
            "title": f"ESRI 10m Annual LULC {year} — MGRS {tile}",
            "roles": ["data"],
            "raster:bands": [{"data_type": "uint8", "nodata": 0, "spatial_resolution": 10}],
            "classification:classes": classes
        }
    },
    "links": []
}
print(json.dumps(item))
PY
  )"

  if [ "$item_json" = "SKIP" ]; then
    echo "  [${tile}] footprint outside PH bbox — skipped"
    return 0
  fi

  # POST, and on 409 (exists) PUT — idempotent
  local code2
  code2=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
            "${STAC_API}/collections/${COLLECTION}/items" \
            -H 'Content-Type: application/json' -d "$item_json")
  if [ "$code2" = "409" ]; then
    curl -fsS -X PUT "${STAC_API}/collections/${COLLECTION}/items/${item_id}" \
      -H 'Content-Type: application/json' -d "$item_json" >/dev/null
    echo "  [${tile}] updated (${item_id})"
  elif [ "$code2" = "200" ] || [ "$code2" = "201" ]; then
    echo "  [${tile}] created (${item_id})"
  else
    echo "  [${tile}] ERROR HTTP ${code2}"
    return 1
  fi
}

# ---- loop over tiles --------------------------------------------------------
rc=0
for t in $TILES; do
  load_tile "$t" || rc=1
done

# ---- summary ----------------------------------------------------------------
echo ">> items now in '${COLLECTION}':"
curl -fsS -X POST "${STAC_API}/search" -H 'Content-Type: application/json' \
  -d "{\"collections\":[\"${COLLECTION}\"],\"limit\":1000}" \
  | python3 -c "import sys,json;fs=json.load(sys.stdin).get('features',[]);print('   count:',len(fs));[print('   -',f['id'],f['bbox']) for f in sorted(fs,key=lambda x:x['id'])]"
echo ">> done."
exit $rc
