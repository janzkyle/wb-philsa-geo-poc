# `pipelines/` — data pipeline scripts (medallion-organized)

All PhilSA POC pipeline scripts live here, organized by the **medallion
architecture**: data flows through progressively refined tiers
(**bronze → silver → gold**), and each script is filed under the tier of data it
*produces*. The numeric prefixes (`01-`, `02-`, `03-`) make the tiers sort in
pipeline order.

Inside each tier, scripts are grouped into a **per-dataset subfolder** (named
after the source/product), so each dataset has room for its script plus any
config, notebook, or tests it grows later.

```
pipelines/
├── lib/                       # shared helpers: load_env.sh (shell), r2.py (Python SigV4 R2 client)
├── 01-bronze/                 # raw, as-acquired data — we own the bytes
│   └── copphil-sentinel/
├── 02-silver/                 # cleaned / conformed / derived assets → Cloudflare R2
│   ├── build_silver.py        # batch driver: every bronze scene → every silver product
│   ├── ph-admin-boundaries/
│   ├── sentinel2-ndvi/
│   ├── sentinel2-truecolor/
│   ├── sentinel1-sar/
│   ├── sentinel1-flood/
│   └── sentinel1-ratio/
│       (copernicus-ems/ … as built)
├── 03-gold/                   # catalog-served products → pgSTAC (by reference)
│   └── catalog_silver.py
│       (open/restricted tagging … as built)
└── reference/                 # by-reference loaders — NOT part of the medallion flow
    ├── philsa-catalog/
    └── esri-lulc/
```

## What each tier means here

This is an Earth-observation STAC POC, so the medallion tiers map to asset state:

| Tier          | Meaning                                                                                                             | Storage                                                                         | Example scripts                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **01-bronze** | Raw scenes pulled in verbatim, no transformation.                                                                   | Local `eodata/` (default); optional R2 `01-bronze/copphil-sentinel/` via `--r2` | `download_copphil_eodata.py` (raw Sentinel-1/2 SAFE zips from CopPhil)                                                                                                                                                                                   |
| **02-silver** | Cleaned, clipped, reprojected, or derived products (NDVI, SAR flood masks, conformed vectors → GeoParquet/PMTiles). | R2 (public/private COGs, GeoParquet, PMTiles)                                   | `build_ph_admin_geoparquet.sh`, `sentinel2-ndvi/build_ndvi.sh`, `sentinel2-truecolor/build_truecolor.sh`, `sentinel1-sar/build_sar.sh`, `sentinel1-flood/build_flood.sh`, `sentinel1-ratio/build_ratio.sh`; *planned:* `vector_to_pmtiles.py` (VEC path) |
| **03-gold**   | Serving-ready catalog entries — what end users discover and consume.                                                | pgSTAC Items (hrefs → R2)                                                       | `catalog_silver.py` (registers silver COGs as STAC items); *planned:* open/restricted tagging                                                                                                                                                            |

The full CopPhil path is the clean medallion example:
**bronze** (download raw S1/S2) → **silver** (compute NDVI / SAR-flood COGs to R2)
→ **gold** (register sensitivity-tagged Items in pgSTAC).

## Data lineage — where each came from, how it's processed, what it's for

| Dataset / product                     | Source (where from)                                                                                             | Processing (how)                                                                                                                                                                                                                           | Used for (where)                                                                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PhilSA STAC** *(reference)*         | PhilSA's public STAC API — `https://stac.infra.copphil.philsa.gov.ph/v1` (~104 Copernicus Sentinel collections) | Mirrored **by reference** — STAC metadata copied into our pgSTAC, pixels left at source (`s3://eodata/…` on CloudFerro). Collections in full; items **capped at the 20 most recent each** (~387k upstream), stamped `philsa:mirrored_from` | Discovery of everything PhilSA serves, in one catalog; the mirrored collections sort last in the Browser so PhilSA's own products lead                                                                                           |
| **ESRI 10 m LULC** *(reference)*      | Esri / Impact Observatory *Living Atlas* (public COGs)                                                          | Registered **by reference** (no download/re-host)                                                                                                                                                                                          | Land-cover context layer in the catalog                                                                                                                                                                                          |
| **CopPhil Sentinel-1/2** *(bronze)*   | CopPhil / CloudFerro OData catalog + token download (Keycloak auth)                                             | Raw `.SAFE.zip` downloaded to local `eodata/`, byte-count verified (default: nationwide, S2 ≤20% cloud, latest 3 dates; `--aoi` narrows, `--all` drops the date window for a full backfill; `--r2` also uploads as bronze)                 | Input to every silver Sentinel derivative below                                                                                                                                                                                  |
| **PH admin boundaries** *(silver)*    | OCHA COD-AB geodatabase on HDX                                                                                  | `ogr2ogr` → GeoParquet (adm0–adm4, optional simplify tolerance)                                                                                                                                                                            | AOI selection / overlay reference vector                                                                                                                                                                                         |
| **Sentinel-2 NDVI** *(silver)*        | Bronze S2 L2A — 10 m B04 (red) + B08 (NIR)                                                                      | `(B08−B04)/(B08+B04)` → Float32 COG; edge-granule fill masked to `-9999` NoData                                                                                                                                                            | Vegetation index; served as colorized tiles (`rdylgn`, −0.2…0.8)                                                                                                                                                                 |
| **Sentinel-2 true-colour** *(silver)* | Bronze S2 L2A — 10 m TCI band                                                                                   | Extract TCI → 8-bit RGB COG; fill (`0`) flagged NoData                                                                                                                                                                                     | Visual reference imagery / basemap                                                                                                                                                                                               |
| **Sentinel-1 SAR** *(silver)*         | Bronze S1 IW GRD, VV polarization                                                                               | GCP warp → EPSG:4326, amplitude → dB → Float32 COG                                                                                                                                                                                         | Backscatter base layer (**not** a validated flood product); served grayscale (15…55 dB)                                                                                                                                          |
| **Sentinel-1 flood** *(silver)*       | Silver S1 VV backscatter (dB) COG                                                                               | Dark-water threshold (`sigma` = mean−k·std default; `otsu`/`fixed` options), block-wise → Byte mask (1=water, 0=land, 2=perm-water, 255=nodata)                                                                                            | POC flood **proxy** (**not** validated; uncalibrated dB); pairs with Copernicus EMS/GFM; served via flood colormap                                                                                                               |
| **Sentinel-1 VH/VV ratio** *(silver)* | Bronze S1 IW GRD, both polarisations                                                                            | GCP warp both pols to one grid → `VH_dB − VV_dB` → Float32 COG                                                                                                                                                                             | Radar vegetation index (rises with crop canopy, works through cloud — the SAR fallback for parametric triggers); ratio cancels the per-scene gain of the uncalibrated dB, so the fixed stretch reads consistently; served `ylgn` |
| **STAC catalog** *(gold)*             | All silver COGs already in R2                                                                                   | `catalog_silver.py` registers collections + items **by reference**, reading COG metadata over the authenticated R2 endpoint; adds render hints + standards metadata. Needs a writable target — see [`../AGENTS.md`](../AGENTS.md)          | What users discover/consume via the STAC API                                                                                                                                                                                     |

The five silver Sentinel products are **single-/multi-band COGs in R2**; they're
visualized through **TiTiler** (repo-root [`compose.viz.yml`](../compose.viz.yml),
`:8083`), which reads them over the authenticated R2 S3 endpoint and serves styled
XYZ tiles to **STAC Browser** (per the `buildTileUrlTemplate` in its `config.js`).
Float32 rasters (NDVI, SAR) need the rescale + colormap, and the Byte flood mask
needs its categorical colormap, or they render as a flat tile — hence the render
hints baked into each gold collection.

## Script index

Per-script usage and parameters live in **each script's own header** — run a
Python script with `--help`, or read the comment block at the top of a shell
script. This table is just the map:

| Script (under `pipelines/`)                                  | Tier      | Lang   | Does                                                                                                                                                                                    | Run from repo root            |
| ------------------------------------------------------------ | --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `reference/philsa-catalog/mirror_philsa_catalog.py`          | reference | Python | Mirror the PhilSA STAC by reference (all collections + `--max-items` recent items each)                                                                                                 | `python3 <path> --dry-run`    |
| `reference/esri-lulc/load_esri_lulc.sh`                      | reference | shell  | Register ESRI 10 m LULC COGs by reference                                                                                                                                               | `YEAR=2025 bash <path>`       |
| `01-bronze/copphil-sentinel/download_copphil_eodata.py`      | 01-bronze | Python | Download raw Sentinel scenes (nationwide, cloud-free, latest N dates; `--all` = no date window, `--aoi` narrows) → local `eodata/` (`--r2` also uploads as bronze)                      | `python3 <path>`              |
| `02-silver/ph-admin-boundaries/build_ph_admin_geoparquet.sh` | 02-silver | shell  | OCHA COD-AB geodatabase → GeoParquet (local or R2)                                                                                                                                      | `TOLERANCE_M=100 bash <path>` |
| `02-silver/ph-admin-boundaries/build_ph_admin_pmtiles.sh`    | 02-silver | shell  | GeoParquet → PMTiles (adm0–adm2) for the webmap → R2                                                                                                                                    | `bash <path>`                 |
| `02-silver/sentinel2-ndvi/build_ndvi.sh`                     | 02-silver | shell  | Sentinel-2 L2A SAFE → NDVI COG → R2                                                                                                                                                     | `bash <path>`                 |
| `02-silver/sentinel2-truecolor/build_truecolor.sh`           | 02-silver | shell  | Sentinel-2 TCI → true-colour RGB COG → R2                                                                                                                                               | `bash <path>`                 |
| `02-silver/sentinel1-sar/build_sar.sh`                       | 02-silver | shell  | Sentinel-1 GRD VV → geocoded backscatter (dB) COG → R2                                                                                                                                  | `bash <path>`                 |
| `02-silver/sentinel1-flood/build_flood.sh`                   | 02-silver | shell  | Silver VV-dB COG → flood/water Byte mask COG → R2                                                                                                                                       | `SAR_NAME=… bash <path>`      |
| `02-silver/sentinel1-ratio/build_ratio.sh`                   | 02-silver | shell  | Sentinel-1 GRD VV+VH → VH/VV cross-ratio (dB) COG → R2                                                                                                                                  | `bash <path>`                 |
| `02-silver/sentinel1-flood/otsu_flood.py`                    | 02-silver | Python | Classify VV-dB → flood Byte mask (`sigma`/`otsu`/`fixed`); called by `build_flood.sh`                                                                                                   | `python3 <path> --help`       |
| `02-silver/build_silver.py`                                  | 02-silver | Python | Batch driver: every bronze scene → every silver product (ndvi, truecolor, sar, flood)                                                                                                   | `python3 <path> --dry-run`    |
| `02-silver/build_raster_mosaics.sh`                          | 02-silver | shell  | Per-date MosaicJSON stitching same-day Sentinel COG granules (the 3 scene collections; flood excluded by default) → R2. Reads hrefs from the catalog, so run it **after** the gold step | `bash <path>`                 |
| `03-gold/catalog_silver.py`                                  | 03-gold   | Python | Register silver COGs in pgSTAC as STAC collections+items (by reference)                                                                                                                 | `python3 <path>`              |

## Orchestration (Dagster)

The scripts above stay runnable **standalone** — that's the contract. On top of
them, [`orchestration/`](./orchestration/) adds an **optional** Dagster layer that
wraps each script as a software-defined **asset** via **Pipes subprocesses** (it
never imports or edits the scripts — it shells out to them, passing their env-var
/ CLI parameters as run config). The medallion tiers become the asset graph, so
lineage, freshness, run history, backfills, and a manual-run/trigger UI come for
free. Nothing here is required to run a pipeline by hand.

**The operating detail lives in
[`orchestration/README.md`](./orchestration/README.md)**: the 11 assets and their
lineage, run config, the sensor/schedule (both ship OFF), `dagster dev` vs. the
compose stack, and the two assets that must run from the host. Read it when you
touch the orchestration layer — not when you run a script by hand.

## R2 key layout (mirrors the tiers)

Every script that writes to Cloudflare R2 stores objects under a **medallion-tiered
key prefix** — `<tier>/<dataset>/<file>` — so the bucket mirrors this directory:

```
s3://<bucket>/
  01-bronze/copphil-sentinel/   S1*/S2* .SAFE.zip      (download_copphil_eodata.py)
  02-silver/ph-admin-boundaries/ phl_adm*.parquet      (build_ph_admin_geoparquet.sh)
  02-silver/sentinel2-ndvi/      <scene>_NDVI.tif (COG)   (build_ndvi.sh)
  02-silver/sentinel2-truecolor/ <scene>_TCI.tif (COG)    (build_truecolor.sh)
  02-silver/sentinel1-sar/       <scene>_VV_dB.tif (COG)  (build_sar.sh)
  02-silver/sentinel1-flood/     <scene>_VV_flood.tif (COG)  (build_flood.sh)
  02-silver/ph-admin-boundaries/pmtiles/  phl_adm*.pmtiles        (build_ph_admin_pmtiles.sh)
  02-silver/<coll>/mosaics/      <coll>_<date>.mosaicjson         (build_raster_mosaics.sh)
  03-gold/…                      (curated, served products … as built)
```

Conventions for R2-writing scripts:

- The prefix is **hardcoded per script** (its tier + dataset) — it is not
  configurable via the environment, so a stray env var can't silently redirect
  a tier. `download_copphil_eodata.py` writes locally by default (`--r2` uploads);
  `build_ph_admin_geoparquet.sh` writes locally unless `R2_BUCKET` is set.
- **All credentials live in a single repo-root `.env`** (gitignored): R2 creds
  `R2_BUCKET`, `R2_ACCOUNT_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  optional `R2_PUBLIC_BASE`, plus CopPhil `COPPHIL_USERNAME` / `COPPHIL_PASSWORD`.
  Every script auto-loads it — and **only** it (override the path with
  `ENV_FILE=…`; a `.env` in the cwd is deliberately ignored so e.g. `webmap/.env`
  can't shadow the creds). See the repo-root `.env.example` for the full key list.
- Uploads are **idempotent**, two flavours: the bronze downloader and the four
  Sentinel builders HEAD/`gdalinfo` the object and **skip** if it already exists
  (`FORCE=1` rebuilds); the admin-boundary, PMTiles, and mosaic builders instead
  **overwrite in place** (re-runs converge but re-do the work).

### R2 one-time setup

Needed before the first R2 upload (any script):

1. **Enable R2** on the Cloudflare account (free tier: 10 GB, zero egress).
1. **Create a bucket** (e.g. `philsa-geo`).
1. **Create an R2 API token** (R2 → *Manage R2 API Tokens*), permission **Object
   Read & Write** scoped to the bucket → Access Key ID + Secret (shown once).
1. **Note the Account ID**.
1. *(Optional)* enable the bucket's `r2.dev` subdomain or a custom domain for
   public HTTPS and set it as `R2_PUBLIC_BASE`.

Endpoint is `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`. The Python scripts
sign with stdlib SigV4 (shared client: `pipelines/lib/r2.py`); the shell builders
write via GDAL `/vsis3` — no awscli/rclone needed for those. The exceptions are
`build_ph_admin_pmtiles.sh` and `build_raster_mosaics.sh`, which upload with the
`aws` CLI.

## Why `reference/` sits outside the medallion tiers

The medallion model assumes you **own the bytes and progressively refine them**.
Two loaders don't fit that: `mirror_philsa_catalog.py` and `load_esri_lulc.sh`
(and the planned Earth Search loader) follow the
project's [**catalog-by-reference**](../AGENTS.md) principle — they copy only STAC metadata
into pgSTAC and leave the pixels at their original source. Nothing is downloaded,
transformed, or re-hosted, so there is no bronze→silver→gold progression to place
them in. They register external, already-finished assets directly into the
catalog. Filing them under a dedicated `reference/` lane keeps the medallion tiers
honest (only owned/derived data flows through them) while still grouping all
pipeline scripts in one place.

> If you'd rather fold these into the medallion tree, `gold/` is the most
> defensible home (they produce serving-ready catalog entries). They were kept
> separate here deliberately — easy to move if the team prefers.

## Python or shell?

Both are fine — pick whichever keeps the script simplest, and document parameters
in the header either way:

- **Shell** for scripts that mostly orchestrate external CLI tools — GDAL
  (`ogr2ogr`/`gdalinfo`) and `curl`: `load_esri_lulc.sh`, `build_ph_admin_geoparquet.sh`.
- **Python** for scripts with real logic — HTTP auth, JSON/OData parsing, SigV4,
  retries: `mirror_philsa_catalog.py`, `download_copphil_eodata.py`.

## Conventions

The full rule set lives in **[`../AGENTS.md`](../AGENTS.md)** — catalog-by-
reference, idempotent POST→PUT-on-409 upserts, skip-and-log, secrets handling,
repo-root path resolution, and the four STAC-write traps (read-only prod,
non-null `datetime`, required `item_assets`, curated band metadata) together with
the vendored validator command. Read it before adding a script: it is the single
source of truth, and this section deliberately doesn't restate it.

Two details specific to the loaders here:

- **Skip-and-log covers *already-present* items**, not just missing or
  out-of-bbox ones — re-running a loader is the normal case and must stay quiet.
- **The PhilSA mirror normalizes upstream `eo:bands.common_name`** to the EO
  vocabulary as it copies records, so mirrored bands match our own.
