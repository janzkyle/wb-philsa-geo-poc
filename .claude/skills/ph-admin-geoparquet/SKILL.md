---
name: ph-admin-geoparquet
description: Generate Philippine administrative boundary GeoParquet files (levels adm0–adm4) from the OCHA COD-AB Philippines geodatabase on HDX, with an optional simplification tolerance in meters. Writes either to a local directory or straight to a Cloudflare R2 bucket (S3-compatible). Use when the user asks to build, regenerate, or refresh PH admin boundary GeoParquet, to produce simplified/generalized variants at a given tolerance, or to upload them to R2.
---

# PH Admin Boundary GeoParquet generator

This skill is a thin pointer. The actual pipeline lives in the repo and is
**runnable on its own without this skill**:

- **Script:** `pipelines/02-silver/ph-admin-boundaries/build_ph_admin_geoparquet.sh`
  — its header comment block is the full reference (parameters, output, caveats).
- **Shared R2 setup / creds / tiered-key conventions:** `pipelines/README.md`.

It generates one GeoParquet file per admin level (adm0 country → adm4 barangay)
from the authoritative OCHA COD-AB geodatabase on HDX, optionally simplified, to
a local dir or straight to Cloudflare R2. Output is GeoParquet 1.1 (WKB,
EPSG:4326, MultiPolygon, covering-bbox, ZSTD).

## How to run

Invoke the script with Bash; all parameters are optional environment variables
(see the script header for the full table — `TOLERANCE_M`, `LEVELS`, `OUTPUT_DIR`,
`GDB_ZIP`, and the `R2_*` / `AWS_*` set for R2 upload):

```bash
S=pipelines/02-silver/ph-admin-boundaries/build_ph_admin_geoparquet.sh
OUTPUT_DIR="$PWD" bash "$S"                                  # full res, local
TOLERANCE_M=100 OUTPUT_DIR="$PWD" bash "$S"                  # 100 m simplified, local
R2_BUCKET=philsa-geo R2_ACCOUNT_ID=abc123def456 \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  TOLERANCE_M=100 bash "$S"                                 # -> Cloudflare R2
```

Credentials: the script auto-loads the shared repo-root `.env.r2` (gitignored), so
R2 runs usually need no inline `AWS_*` / `R2_ACCOUNT_ID`. See `pipelines/README.md`.

## Behavior / instructions for the assistant

- **Tolerance is the key parameter.** When the user names a tolerance ("simplify
  to 250 m", "generalize at 1 km"), pass it as `TOLERANCE_M` (convert km→m). For
  "full resolution" / "exact", omit it (or `TOLERANCE_M=0`).
- Output naming: full res → `phl_adm{L}.parquet`; simplified →
  `phl_adm{L}_s{TOLERANCE_M}m.parquet` (same naming local or in R2, under `R2_PREFIX`).
- **R2 vs local:** set `R2_BUCKET` (+ `R2_ACCOUNT_ID` and AWS_* creds) to upload to
  R2 instead of writing locally — no local copy is kept. Never echo or store the keys.
- If a geodatabase was already downloaded this session, pass `GDB_ZIP=` to skip the
  ~344 MB re-download.
- Default `OUTPUT_DIR` to the user's current project directory unless they say
  otherwise (local mode only).
- After running, report per-level feature counts and (local) file sizes or (R2)
  the s3:// / public URLs the script prints, and confirm the destination.
