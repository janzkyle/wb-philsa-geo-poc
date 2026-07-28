# Orchestration (Dagster)

The **optional** Dagster layer over `pipelines/`. Script index, medallion tiers,
and the shared conventions live in [`../README.md`](../README.md); the
cross-cutting rules in [`../../AGENTS.md`](../../AGENTS.md).

The pipeline scripts stay runnable **standalone** — that's the contract. On top
of them, this directory wraps each script as a software-defined **asset** via
**Pipes subprocesses** (it never imports or edits the scripts — it shells out to
them, passing their env-var / CLI parameters as run config). The medallion tiers
become the asset graph, so lineage, freshness, run history, backfills, and a
manual-run/trigger UI come for free. Nothing here is required to run a pipeline
by hand.

The 11 assets and their lineage:

```
bronze/copphil_sentinel
   ├─ silver/sentinel2_ndvi ─┐
   ├─ silver/sentinel2_truecolor ─┤
   ├─ silver/sentinel1_sar ─┬─────┤
   │      └─ silver/sentinel1_flood ─┤   (flood reads the silver VV-dB COG)
   │                                 └─ gold/stac_catalog ─ silver/raster_mosaics
silver/ph_admin_geoparquet ─ silver/ph_admin_pmtiles   (manual-run, no upstream)
reference/philsa_catalog                                (by-reference loaders,
reference/esri_lulc                                      standalone/manual-run)
```

`raster_mosaics` sits **after** gold because the mosaic script reads item
hrefs from the STAC API — it can only stitch scenes the gold step has already
registered. The per-scene Sentinel silver assets run in **batch mode** when no
`scene` is set in run config: they invoke `build_silver.py --only <product>`,
which builds that product for every bronze scene (local + R2) — so a
sensor-triggered chain run actually processes the newly downloaded scenes.
Pin `scene` (or `sar_name` for flood) in run config to build a single scene.

**Run modes — both from the checklist ask:**

- **One-time / manual:** materialize any asset from the UI ("Materialize"), or
  headless: `dagster asset materialize -m definitions --select 'bronze/copphil_sentinel'`
  (add `--config-json '{"ops":{"bronze__copphil_sentinel":{"config":{"dry_run":true}}}}'`
  to preview without downloading). Every script's own params are exposed as
  **run config** (e.g. `scene`, `force`, `tolerance_m`, `dry_run`, `only`).
- **Daily update check:** `copphil_new_scene_sensor` polls the CopPhil OData
  catalogue hourly and launches the `copphil_chain_refresh` job (bronze +
  everything downstream) **only when a scene newer than its cursor appears**;
  `copphil_daily_schedule` (06:00 Asia/Manila) is a blind-but-idempotent
  fallback. **Both ship OFF** (`STOPPED`) — enable deliberately in the UI's
  Automation tab, or `dagster sensor start copphil_new_scene_sensor`.

**Local dev (no server):** from `orchestration/`, `uv venv && uv pip install -e .`
then `dagster dev` (ephemeral storage, UI on :3000) or `dagster definitions validate`.

**Full stack (compose):** run/event storage lives in a `dagster` database on the
existing pgSTAC Postgres. One-time, **from the repo root**:

```
docker compose -f stac-fastapi-pgstac/compose.yml up -d          # Postgres + STAC API
docker compose -f stac-fastapi-pgstac/compose.yml exec database \
  psql -U username -d postgis -c 'CREATE DATABASE dagster'       # once
docker compose -f compose.orchestration.yml up -d --build        # webserver + daemon
```

UI at **http://localhost:3030**. The webserver+daemon join the pgSTAC compose
network (reaching Postgres as `database`, the STAC API as `app:8082`) and
bind-mount the repo. Two assets still run best from the **host**, not the
container image: `silver/ph_admin_pmtiles` (needs `tippecanoe` + the `aws` CLI)
and `silver/raster_mosaics` (execs into the TiTiler container).
