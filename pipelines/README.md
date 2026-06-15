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
│   └── ph-admin-boundaries/
│       (sentinel2-ndvi/, sentinel1-flood/, copernicus-ems/ … as built)
├── 03-gold/                   # catalog-served, sensitivity-tagged products
│   └── (pgSTAC registration + open/restricted tagging … as built)
└── reference/                 # by-reference loaders — NOT part of the medallion flow
    ├── philsa-catalog/
    └── esri-lulc/
```

## What each tier means here

This is an Earth-observation STAC POC, so the medallion tiers map to asset state:

| Tier | Meaning | Storage | Example scripts |
| --- | --- | --- | --- |
| **01-bronze** | Raw scenes pulled in verbatim, no transformation. | R2 `01-bronze/copphil-sentinel/` (R2-only) | `download_copphil_eodata.py` (raw Sentinel-1/2 SAFE zips from CopPhil) |
| **02-silver** | Cleaned, clipped, reprojected, or derived products (NDVI, SAR flood masks, conformed vectors → GeoParquet/PMTiles). | R2 (public/private COGs, GeoParquet, PMTiles) | `ph-admin-boundaries/build_ph_admin_geoparquet.sh`; *planned:* `ndvi.py`, `sar_flood.py`, `vector_to_pmtiles.py` |
| **03-gold** | Serving-ready, sensitivity-tagged catalog entries — what end users discover and consume. | pgSTAC Items (hrefs → R2) | *planned:* pgSTAC registration / open-restricted tagging glue |

The full CopPhil path is the clean medallion example:
**bronze** (download raw S1/S2) → **silver** (compute NDVI / SAR-flood COGs to R2)
→ **gold** (register sensitivity-tagged Items in pgSTAC).

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

## R2 key layout (mirrors the tiers)

Every script that writes to Cloudflare R2 stores objects under a **medallion-tiered
key prefix** — `<tier>/<dataset>/<file>` — so the bucket mirrors this directory:

```
s3://<bucket>/
  01-bronze/copphil-sentinel/   S1*/S2* .SAFE.zip      (download_copphil_eodata.py)
  02-silver/ph-admin-boundaries/ phl_adm*.parquet      (build_ph_admin_geoparquet.sh)
  02-silver/…                    (NDVI / SAR-flood COGs, PMTiles … as built)
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
