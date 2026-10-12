# Module 4 — Data transformation: bronze → silver → gold

**Goal:** they can follow one product from raw scene to rendered tile, know
which script owns each step, and know where its caveats are written down.
**Time:** ~30 min (longer if they build a COG themselves).

## Read first
- `pipelines/README.md`: "What each tier means here", "Data lineage", "Script
  index", "R2 key layout"
- The header of `pipelines/02-silver/sentinel2-ndvi/build_ndvi.sh`, a
  representative silver builder
- `pipelines/03-gold/catalog_silver.py`: the module docstring and the
  `PRODUCTS` list, which is the single place each product's catalog metadata
  and render hints are defined
- `pipelines/02-silver/sentinel1-flood/otsu_flood.py --help` (the flood
  classifier's methods)

## Why it's built this way (the intent)
- **The folder you put a script in says what tier its output is.** Bronze
  is raw and untouched, silver is derived COGs in R2, and gold is catalog
  entries that point at silver. The R2 key prefix repeats the folder path
  (`02-silver/sentinel2-ndvi/…`). It is **hardcoded per script**, so a stray
  env var can't silently write into the wrong tier.
- **Silver files are COGs** (Cloud-Optimized GeoTIFFs), so TiTiler, QGIS, and
  `rasterio` can read just the bytes they need over HTTP. Nobody downloads a
  whole scene to look at it.
- **Gold is metadata only.** `catalog_silver.py` registers what's already in
  R2. It reads each COG's footprint and projection with `gdalinfo` rather than
  trusting hard-coded values, and it attaches **render hints**, so any client
  knows NDVI wants `rdylgn` over −0.2…0.9.
- **Lineage is recorded on every item.** It has `processing:lineage` (the
  formula and the source granule) and, where the source is reachable, a
  `rel=derived_from` link. This is how a claims analyst can audit an index
  value months later.
- **Re-running is the normal case.** The Sentinel builders skip outputs that
  already exist (set `FORCE=1` to rebuild). The loaders upsert (POST, then PUT
  on 409). Nothing should error on a second run.
- **Honest products.** The flood mask is a threshold on *uncalibrated* dB, so
  it's labeled a **proxy** everywhere. NDVI has no cloud masking yet
  (`TODO.md`: "Cloud-contamination guardrails"). Don't let anyone present
  either one as validated.

## Essentials (in order)

1. **The chain** (the CopPhil path is the clean example):
   - bronze: `download_copphil_eodata.py` → `eodata/` (and optionally R2
     `01-bronze/`)
   - silver: `build_silver.py`, a batch driver that runs every bronze scene
     through every product: `build_ndvi.sh`, `build_truecolor.sh`,
     `build_sar.sh`, `build_flood.sh`. `build_ratio.sh` has its own builder.
   - gold: `catalog_silver.py`, which registers the silver COGs as STAC items
     in pgSTAC
   - then `build_raster_mosaics.sh`, which writes per-date MosaicJSON to R2. It
     runs *after* gold because it reads hrefs from the catalog.
2. **The products in one breath:**
   - **NDVI:** (B08−B04)/(B08+B04), Float32, nodata −9999.
   - **True-colour:** the S2 TCI band as an 8-bit RGB COG.
   - **SAR:** S1 VV, geocoded to dB, Float32.
   - **Flood:** a dark-water threshold on the SAR dB, Byte classes
     (1 = water, 0 = land, 2 = permanent water, 255 = nodata).
   - **VH/VV ratio:** a radar vegetation index that works through cloud.
   - **Admin boundaries:** OCHA geodatabase → GeoParquet → PMTiles, plus a
     name → bbox search index the chat assistant uses.
3. **Render parameters live in five places**, and changing a stretch or
   colormap means changing all five:
   - `INTEGRATION_GUIDE.md` §2 (the source of truth)
   - `webmap/src/config.ts`
   - `catalog_silver.py` (what the catalog publishes as `renders`)
   - `partner-template/index.html`
   - `stac-browser/config.js` (a submodule)

   Never add a sixth.
4. **Open vs. restricted at gold.** A restricted product's hrefs become
   `s3://` into the private bucket, and it's tagged in the catalog. No product
   is restricted today. The `collection-tier` skill moves one, and Elective E2
   covers it.

## Adapt
- **Software first:**
  - Why Float32 + nodata: NDVI is a ratio in −1…1, and −9999 marks "no
    observation", which is different from "zero vegetation".
  - Why dB: radar backscatter spans orders of magnitude, so log scale makes
    thresholds workable.
  - Why per-date mosaics: one scene is a ~110 km tile. A "Luzon on July 5"
    layer stitches several of them.
- **GIS first:** `gdal_calc.py` and `gdal_translate -of COG` will look
  familiar. The new parts are the shell glue (env-var parameters,
  HEAD-then-skip against R2) and STAC as the output, where a QGIS user would
  have made a layer file.

## Hands-on

**A. Trace one NDVI item end to end.** This needs no credentials; it uses
prod, which is read-only:

```bash
G=https://philsa-stac-gateway.philsa.workers.dev
T=https://philsa-tiles-gateway.philsa.workers.dev
curl -s "$G/collections/sentinel2-ndvi/items?limit=1" > /tmp/ndvi_item.json
python3 -c '
import json; f=json.load(open("/tmp/ndvi_item.json"))["features"][0]
print("item:", f["id"]); print("lineage:", f["properties"].get("processing:lineage"))
print("href:", f["assets"]["data"]["href"])
print("derived_from:", [l["href"] for l in f["links"] if l["rel"]=="derived_from"] or "none (source scene not in R2 bronze)")'
HREF=$(python3 -c 'import json; print(json.load(open("/tmp/ndvi_item.json"))["features"][0]["assets"]["data"]["href"])')
gdalinfo "/vsicurl/$HREF" | grep -E 'Size is|Band 1|NoData|LAYOUT'   # reads only the header bytes
open "$T/cog/preview.png?url=$HREF&rescale=-0.2,0.9&colormap_name=rdylgn&max_size=512"   # xdg-open on Linux
```

Ask them to match each piece to its script. The formula comes from
`build_ndvi.sh`. The R2 key prefix is the hardcoded tier path. The lineage
string and render hint come from `catalog_silver.py`'s `PRODUCTS` entry.

Then ask them to compare a flood item's `derived_from` link, which points at
its source SAR *item*. Ask which host it must use, and why it can never be the
ingest endpoint. (It must be the public catalog, `STAC_PUBLIC_URL`, because the
private write API is gone once `prod-ingest.sh` finishes. Items cataloged
before that fix may still show `localhost:8092` until the next
`--silver-only` re-ingest.)

**B. Build one yourself (optional; needs GDAL ≥ 3.11 and ~1 GB download).**
Ask first, because this downloads a real Sentinel-2 scene:

```bash
python3 pipelines/01-bronze/copphil-sentinel/download_copphil_eodata.py --collections sentinel-2 --dates 1 --limit 1
: > /tmp/no-r2.env    # an EMPTY env file
ENV_FILE=/tmp/no-r2.env OUTPUT_DIR=/tmp/silver bash pipelines/02-silver/sentinel2-ndvi/build_ndvi.sh
gdalinfo /tmp/silver/*_NDVI.tif | grep -E 'Size is|NoData|LAYOUT'
```

⚠️ **Don't write `R2_BUCKET= bash build_ndvi.sh` to "keep it local".**
`load_env` re-exports the repo-root `.env` over the caller's environment, so
the bucket comes back and the COG uploads to the shared R2. Pointing
`ENV_FILE` at an empty file skips the repo `.env` entirely. This is a good
teaching moment about the env-loading convention. Re-check the script's
env-loading block before running it, in case it has changed.

## Checkpoint
They can name, for the NDVI item: the script that computed it, where the
bytes live, where the formula and stretch are recorded, and why the tile
renders without anyone downloading the 10980×10980 COG.

## Check understanding
- "You change NDVI's stretch to 0…1 in `config.ts` only. What breaks?" (The
  catalog, the integration guide, the partner template, and STAC Browser now
  disagree with the webmap; all five copies must change together.)
- "Why does `build_raster_mosaics.sh` run after gold, not before?" (It reads
  item hrefs from the catalog.)

## Dive deeper (offer as options)
- **The flood classifier:** `otsu_flood.py` (sigma/otsu/fixed thresholds,
  block-wise processing) and why it stays a proxy until DEM slope masking and
  EMS/GFM land.
- **SAR geocoding:** `build_sar.sh` (GCP warp to EPSG:4326, amplitude → dB) and
  the ratio's per-scene gain cancellation.
- **Admin boundaries:** the `ph-admin-geoparquet` skill and
  `build_admin_search_index.py`, which powers the chat's `resolve_region`.
- **Batch runs and orchestration:** `build_silver.py --dry-run`, then
  Elective E1 (Dagster).
