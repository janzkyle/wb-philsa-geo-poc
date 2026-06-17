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
├── 01-bronze/                 # raw, as-acquired data — we own the bytes
│   └── copphil-sentinel/
├── 02-silver/                 # cleaned / conformed / derived assets → Cloudflare R2
│   ├── ph-admin-boundaries/
│   ├── sentinel2-ndvi/
│   ├── sentinel2-truecolor/
│   └── sentinel1-sar/
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

| Tier | Meaning | Storage | Example scripts |
| --- | --- | --- | --- |
| **01-bronze** | Raw scenes pulled in verbatim, no transformation. | R2 `01-bronze/copphil-sentinel/` (R2-only) | `download_copphil_eodata.py` (raw Sentinel-1/2 SAFE zips from CopPhil) |
| **02-silver** | Cleaned, clipped, reprojected, or derived products (NDVI, SAR flood masks, conformed vectors → GeoParquet/PMTiles). | R2 (public/private COGs, GeoParquet, PMTiles) | `build_ph_admin_geoparquet.sh`, `sentinel2-ndvi/build_ndvi.sh`, `sentinel2-truecolor/build_truecolor.sh`, `sentinel1-sar/build_sar.sh`; *planned:* `vector_to_pmtiles.py` (VEC path) |
| **03-gold** | Serving-ready catalog entries — what end users discover and consume. | pgSTAC Items (hrefs → R2) | `catalog_silver.py` (registers silver COGs as STAC items); *planned:* open/restricted tagging |

The full CopPhil path is the clean medallion example:
**bronze** (download raw S1/S2) → **silver** (compute NDVI / SAR-flood COGs to R2)
→ **gold** (register sensitivity-tagged Items in pgSTAC).

## Data lineage — where each came from, how it's processed, what it's for

| Dataset / product | Source (where from) | Processing (how) | Used for (where) |
| --- | --- | --- | --- |
| **PhilSA satellite catalog** *(reference)* | PhilSA's public STAC API | Mirrored **by reference** — STAC metadata copied into our pgSTAC, pixels left at source | Discovery of PhilSA imagery (Diwata-2, SkySat, PlanetScope) in one catalog |
| **ESRI 10 m LULC** *(reference)* | Esri / Impact Observatory *Living Atlas* (public COGs) | Registered **by reference** (no download/re-host) | Land-cover context layer in the catalog |
| **CopPhil Sentinel-1/2** *(bronze)* | CopPhil / CloudFerro OData catalog + token download (Keycloak auth) | Raw `.SAFE.zip` streamed to R2 verbatim, byte-count verified | Input to every silver Sentinel derivative below |
| **PH admin boundaries** *(silver)* | OCHA COD-AB geodatabase on HDX | `ogr2ogr` → GeoParquet (adm0–adm4, optional simplify tolerance) | AOI selection / overlay reference vector |
| **Sentinel-2 NDVI** *(silver)* | Bronze S2 L2A — 10 m B04 (red) + B08 (NIR) | `(B08−B04)/(B08+B04)` → Float32 COG; edge-granule fill masked to `-9999` NoData | Vegetation index; served as colorized tiles (`rdylgn`, −0.2…0.8) |
| **Sentinel-2 true-colour** *(silver)* | Bronze S2 L2A — 10 m TCI band | Extract TCI → 8-bit RGB COG; fill (`0`) flagged NoData | Visual reference imagery / basemap |
| **Sentinel-1 SAR** *(silver)* | Bronze S1 IW GRD, VV polarization | GCP warp → EPSG:4326, amplitude → dB → Float32 COG | Backscatter base layer (**not** a validated flood product); served grayscale (15…55 dB) |
| **STAC catalog** *(gold)* | All silver COGs already in R2 | `catalog_silver.py` registers collections + items **by reference**, with render-extension hints (rescale + colormap) | What users discover/consume via the STAC API |

The three silver Sentinel products are **single-/multi-band COGs in R2**; they're
visualized through **TiTiler** (repo-root [`compose.viz.yml`](../compose.viz.yml),
`:8083`), which reads them over the authenticated R2 S3 endpoint and serves styled
XYZ tiles to **STAC Browser** (per the `buildTileUrlTemplate` in its `config.js`).
Float32 rasters (NDVI, SAR) need the rescale + colormap or they render as a flat
tile — hence the render hints baked into each gold collection.

## Script index

Per-script usage and parameters live in **each script's own header** — run a
Python script with `--help`, or read the comment block at the top of a shell
script. This table is just the map:

| Script (under `pipelines/`) | Tier | Lang | Does | Run from repo root |
| --- | --- | --- | --- | --- |
| `reference/philsa-catalog/mirror_philsa_catalog.py` | reference | Python | Mirror the PhilSA STAC catalog by reference | `python3 <path> --dry-run` |
| `reference/esri-lulc/load_esri_lulc.sh` | reference | shell | Register ESRI 10 m LULC COGs by reference | `YEAR=2025 bash <path>` |
| `01-bronze/copphil-sentinel/download_copphil_eodata.py` | 01-bronze | Python | Download latest raw Sentinel scenes → R2 | `python3 <path>` |
| `02-silver/ph-admin-boundaries/build_ph_admin_geoparquet.sh` | 02-silver | shell | OCHA COD-AB geodatabase → GeoParquet (local or R2) | `TOLERANCE_M=100 bash <path>` |
| `02-silver/sentinel2-ndvi/build_ndvi.sh` | 02-silver | shell | Sentinel-2 L2A SAFE → NDVI COG → R2 | `bash <path>` |
| `02-silver/sentinel2-truecolor/build_truecolor.sh` | 02-silver | shell | Sentinel-2 TCI → true-colour RGB COG → R2 | `bash <path>` |
| `02-silver/sentinel1-sar/build_sar.sh` | 02-silver | shell | Sentinel-1 GRD VV → geocoded backscatter (dB) COG → R2 | `bash <path>` |
| `03-gold/catalog_silver.py` | 03-gold | Python | Register silver COGs in pgSTAC as STAC collections+items (by reference) | `python3 <path>` |

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
  02-silver/…                    (PMTiles … as built)
  03-gold/…                      (curated, served products … as built)
```

Conventions for R2-writing scripts:
- The prefix is **hardcoded per script** (its tier + dataset), not read from the
  shared env file. `download_copphil_eodata.py` is **R2-only** (requires `R2_BUCKET`);
  `build_ph_admin_geoparquet.sh` writes locally unless `R2_BUCKET` is set.
- **Shared R2 credentials live in the repo-root `.env.r2`** (gitignored):
  `R2_BUCKET`, `R2_ACCOUNT_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  optional `R2_PUBLIC_BASE`. **Do not** put `R2_PREFIX` there — it would override
  each script's per-tier prefix.
- Uploads are **idempotent**: a script HEADs the object and skips if it already
  exists at the expected size.

### R2 one-time setup

Needed before the first R2 upload (any script):

1. **Enable R2** on the Cloudflare account (free tier: 10 GB, zero egress).
2. **Create a bucket** (e.g. `philsa-geo`).
3. **Create an R2 API token** (R2 → *Manage R2 API Tokens*), permission **Object
   Read & Write** scoped to the bucket → Access Key ID + Secret (shown once).
4. **Note the Account ID**.
5. *(Optional)* enable the bucket's `r2.dev` subdomain or a custom domain for
   public HTTPS and set it as `R2_PUBLIC_BASE`.

Endpoint is `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`. The Python uploader
(`download_copphil_eodata.py`) signs with stdlib SigV4; the shell builder writes via
GDAL `/vsis3` — **no awscli/rclone needed**.

## Why `reference/` sits outside the medallion tiers

The medallion model assumes you **own the bytes and progressively refine them**.
Two loaders don't fit that: `mirror_philsa_catalog.py` and `load_esri_lulc.sh`
(and the planned Earth Search loader) follow the project's
[**catalog-by-reference**](../AGENTS.md) principle — they copy only STAC metadata
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

## Conventions (see [`../AGENTS.md`](../AGENTS.md) for the full set)

- **Catalog by reference** wherever possible; only the bronze→silver→gold path
  re-hosts bytes (derived assets to R2).
- **Idempotent upserts** into pgSTAC: POST, then PUT on `409 Conflict`.
- **Skip-and-log**, don't fail, on missing / out-of-bbox / already-present items.
- **Secrets via env** (`.env.copphil`, `.env.r2`), never committed.
- Scripts resolve repo-relative paths (e.g. `.env.copphil`, `eodata/`) to the
  **repo root**, so they run from any working directory.
