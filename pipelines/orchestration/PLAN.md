# Dagster orchestration — implementation plan (loop state file)

This file is the single source of truth for the /loop implementing Dagster
orchestration. Each iteration: pick the FIRST unchecked item, implement only
that, verify (Dagster definitions must import cleanly), check it off with a
one-line note, commit.

## Context (gathered iteration 1, 2026-07-02)

- Conventions: catalog by reference; idempotent scripts (never modify them);
  secrets only via repo-root `.env`; POC logic lives in `pipelines/`.
- Existing scripts (all wrapped as subprocesses, unmodified):
  - bronze: `01-bronze/copphil-sentinel/download_copphil_eodata.py`
  - silver raster: `02-silver/sentinel2-ndvi/build_ndvi.sh`,
    `02-silver/sentinel2-truecolor/build_truecolor.sh`,
    `02-silver/sentinel1-sar/build_sar.sh`,
    `02-silver/sentinel1-flood/build_flood.sh`,
    `02-silver/build_raster_mosaics.sh`
  - silver vector: `02-silver/ph-admin-boundaries/build_ph_admin_geoparquet.sh`,
    `02-silver/ph-admin-boundaries/build_ph_admin_pmtiles.sh`
  - gold: `03-gold/catalog_silver.py`
  - reference: `reference/philsa-catalog/mirror_philsa_catalog.py`,
    `reference/esri-lulc/load_esri_lulc.sh`
- Compose precedent: repo-root `compose.viz.yml` (TiTiler on :8083), brought up
  with `docker compose --env-file .env -f compose.viz.yml up -d`. Ports 8080
  (STAC Browser) and 8083 (TiTiler) are taken; pgSTAC Postgres lives in the
  `stac-fastapi-pgstac` submodule's compose.
- Guardrails: never trigger real bronze/silver materializations (large
  downloads) — validation/dry-run only; sensor + schedule ship OFF by default.

## Checklist

- [x] 1. Scaffold `pipelines/orchestration/` — `pyproject.toml` (dagster,
  dagster-webserver, dagster-postgres, dagster-pipes), empty `definitions.py`
  that loads, and a `dagster.yaml` pointing run/event storage at a `dagster`
  database on the existing pgSTAC Postgres instance.
  *Done: scaffolded with dagster 1.13.11 (uv venv in `.venv/`, gitignored);
  `dagster.yaml` reads `DAGSTER_PG_HOST`/`DAGSTER_PG_PASSWORD` (added to
  `.env.example`), pgSTAC Postgres = submodule compose svc `database`, host
  port 5439, needs one-time `CREATE DATABASE dagster`. Verify recipe:
  `DAGSTER_HOME=<empty tmp dir> .venv/bin/dagster definitions validate` from
  `pipelines/orchestration/` — cwd dagster.yaml otherwise triggers a live PG
  connection.*
- [x] 2. Bronze asset: wrap `01-bronze/copphil-sentinel/download_copphil_eodata.py`
  via `PipesSubprocessClient`. Do NOT modify the script.
  *Done: `assets_bronze.py` → asset `bronze/copphil_sentinel` (group `bronze`),
  config mirrors the CLI flags (`limit`/`days`/`max_cloud`/`dry_run`); script
  isn't Pipes-aware so a clean exit = success and the asset returns its own
  MaterializeResult. Verified with a real `--dry-run` materialization
  (CopPhil auth + search OK, RUN_SUCCESS, no downloads).*
- [ ] 3. Silver raster assets: `build_ndvi.sh`, `build_truecolor.sh`,
  `build_sar.sh`, `build_flood.sh` as assets depending on the bronze asset;
  `build_raster_mosaics.sh` depending on all four. Scripts wrapped as
  subprocesses, unmodified.
- [ ] 4. Silver vector assets: `build_ph_admin_geoparquet.sh` and
  `build_ph_admin_pmtiles.sh` (pmtiles depends on geoparquet). No upstream
  dependency — manual-run.
- [ ] 5. Gold asset: `03-gold/catalog_silver.py` depending on the silver raster
  + mosaic assets.
- [ ] 6. Reference assets: `mirror_philsa_catalog.py` and `load_esri_lulc.sh`
  as standalone manual-run assets.
- [ ] 7. Daily automation: sensor polling the CopPhil OData endpoint for new
  scenes (reuse the query logic from `download_copphil_eodata.py` by reading
  it) that triggers the bronze→silver→gold chain; plus a daily cron schedule
  as fallback. Both OFF by default.
- [ ] 8. Compose: dagster-webserver + dagster-daemon services (new
  `compose.orchestration.yml` or extend `compose.viz.yml`, whichever fits
  better), loading the repo-root `.env`, code mounted, UI on a free port.
- [ ] 9. Verify end-to-end: `dagster definitions validate` (or `dagster dev`
  smoke test) passes, compose services start, asset graph renders with correct
  lineage. Fix anything broken.
- [ ] 10. Docs: orchestration section in `pipelines/README.md` (manual runs via
  UI/CLI, enabling the sensor/schedule) and update `TODO.md`.
