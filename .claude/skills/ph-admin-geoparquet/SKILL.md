---
name: ph-admin-geoparquet
description: Generate Philippine administrative boundary GeoParquet files (levels adm0–adm4) from the OCHA COD-AB Philippines geodatabase on HDX, with an optional simplification tolerance in meters. Writes either to a local directory or straight to a Cloudflare R2 bucket (S3-compatible). Use when the user asks to build, regenerate, or refresh PH admin boundary GeoParquet, to produce simplified/generalized variants at a given tolerance, or to upload them to R2.
---

# PH Admin Boundary GeoParquet generator

Generates one GeoParquet file per administrative level for the Philippines from
the authoritative OCHA COD-AB dataset (a File Geodatabase published on HDX):

| Level | Unit                | Features |
|-------|---------------------|----------|
| adm0  | country             | 1        |
| adm1  | region              | 17       |
| adm2  | province            | 88       |
| adm3  | city/municipality   | 1,642    |
| adm4  | barangay            | 42,048   |

Output is **GeoParquet 1.1** — WKB geometry, **EPSG:4326**, MultiPolygon, a
covering-bbox column for spatial row-group pruning, ZSTD-compressed. P-codes are
kept as **text**, `valid_on`/`valid_to` as **Date**, names are UTF-8.

## How to run

The bundled script `build_ph_admin_geoparquet.sh` does everything (downloads the
geodatabase if needed, converts each level, writes locally or to R2). Invoke it
with Bash. All parameters are optional environment variables:

| Variable        | Meaning                                                              | Default            |
|-----------------|---------------------------------------------------------------------|--------------------|
| `TOLERANCE_M`   | **Simplification tolerance in meters.** `0`/unset = full resolution. | `0` (full res)     |
| `LEVELS`        | Space-separated levels to build                                     | `0 1 2 3 4`        |
| `OUTPUT_DIR`    | Local directory to write `.parquet` files (ignored when `R2_BUCKET` is set) | script's dir |
| `GDB_ZIP`       | Path to an already-downloaded `gdb.zip` (skips the ~344 MB download) | —                  |
| `R2_BUCKET`     | **Cloudflare R2 bucket name. When set, output goes to R2, not local disk.** | — (local mode)     |
| `R2_ACCOUNT_ID` | Cloudflare account id (forms the S3 endpoint). Required for R2.      | —                  |
| `R2_PREFIX`     | Key prefix inside the bucket                                         | `ph-admin-boundaries` |
| `R2_PUBLIC_BASE`| Optional public base URL (r2.dev subdomain or custom domain) for the printed URLs | —      |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | R2 API-token credentials, read from the environment. **Never hard-code these.** | — |

### Examples

Full-resolution, all levels, into the current project directory:
```bash
OUTPUT_DIR="$PWD" bash <skill-dir>/build_ph_admin_geoparquet.sh
```

Simplified at the tolerance the user asked for (e.g. 100 m), local:
```bash
TOLERANCE_M=100 OUTPUT_DIR="$PWD" bash <skill-dir>/build_ph_admin_geoparquet.sh
```

Upload straight to Cloudflare R2 (no local copy kept):
```bash
R2_BUCKET=philsa-geo R2_ACCOUNT_ID=abc123def456 \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  TOLERANCE_M=100 bash <skill-dir>/build_ph_admin_geoparquet.sh
```

## Cloudflare R2 setup (one-time, in the dashboard)

Needed before the first R2 run:

1. **Enable R2** on the account (first activation requires a billing method;
   free tier = 10 GB storage and **zero egress fees**).
2. **Create a bucket** (e.g. `philsa-geo`).
3. **Create an R2 API token**: R2 → *Manage R2 API Tokens* → *Create API Token*,
   permission **Object Read & Write**, scoped to that bucket. This yields the
   **Access Key ID** + **Secret Access Key** (the secret is shown only once).
4. **Note the Account ID** (R2 overview / endpoint URL).
5. *(Optional)* For public HTTPS access to the files (to reference them from STAC
   items or read them with DuckDB `read_parquet('https://…')`), enable the bucket's
   `r2.dev` dev subdomain or attach a **custom domain**, then pass it as
   `R2_PUBLIC_BASE`. Without this, objects are private (signed S3 requests only).

The endpoint is derived as `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`;
the script writes via GDAL's `/vsis3` (path-style), so **no awscli/rclone is
needed** — only GDAL. Credentials are taken from `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` in the environment; do not put secrets in the script.

### Env file (so creds aren't typed each run)

The script can load a `KEY=VALUE` env file before running. Put your values in
**`.env.r2`** — search order is `$ENV_FILE` (if set) → `./.env.r2` (cwd) →
`<skill-dir>/.env.r2`. Copy `.env.r2.example` (in the project root) to `.env.r2`
and fill it in. **`.env.r2` is gitignored** (the project `.gitignore` ignores
`.env*`); never commit the real secret. Then just:
```bash
TOLERANCE_M=100 bash <skill-dir>/build_ph_admin_geoparquet.sh   # reads ./.env.r2
```
Or point at an explicit file: `ENV_FILE=~/secrets/philsa.env bash …`.

## Behavior / instructions for the assistant

- **Tolerance is the key parameter.** When the user names a tolerance ("simplify
  to 250 m", "generalize at 1 km"), pass it as `TOLERANCE_M` (convert km→m). When
  they ask for "full resolution" / "exact", omit it (or `TOLERANCE_M=0`).
- Output naming: full res → `phl_adm{L}.parquet`; simplified →
  `phl_adm{L}_s{TOLERANCE_M}m.parquet`. So full-res and simplified sets coexist
  (same naming whether local or in R2, under `R2_PREFIX`).
- **R2 vs local:** set `R2_BUCKET` (plus `R2_ACCOUNT_ID` and the AWS_* creds) to
  upload to R2 instead of writing locally — no local copy is kept. Without
  `R2_BUCKET` it writes to `OUTPUT_DIR`. Never echo or store the secret keys.
- If a geodatabase has already been downloaded this session, pass its path via
  `GDB_ZIP=` to avoid re-downloading ~344 MB.
- Default `OUTPUT_DIR` to the user's current project directory unless they
  specify otherwise (local mode only).
- After running, report per-level feature counts and (local) file sizes or (R2)
  the s3:// / public URLs (the script prints them) and confirm the destination.

## Notes / caveats

- Simplification is planar Douglas-Peucker in degrees (meters converted via
  1° ≈ 111,320 m) and is **per-feature**, so shared borders between adjacent
  units are simplified independently — possible hairline slivers, invisible at
  display scales. Great for web/overview maps; for spatial analysis prefer the
  full-resolution files.
- Size reference: full-res total ≈ 870 MB; at 100 m ≈ 13 MB (adm4 207 MB → 8 MB).
  Mind the full-res size when uploading to R2.
- Requires GDAL ≥ 3.8 (`ogr2ogr` with the Parquet + OpenFileGDB drivers; R2
  upload also needs the S3 `/vsis3` write support present in curl-enabled GDAL)
  and curl. If a GDAL build lacks `/vsis3` write, build locally and upload the
  files with `aws s3 cp --endpoint-url https://<acct>.r2.cloudflarestorage.com`.
- Source dataset: https://data.humdata.org/dataset/cod-ab-phl
