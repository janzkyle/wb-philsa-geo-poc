# Elective E1 — Orchestration with Dagster

**Goal:** they understand what the optional Dagster layer adds, how it wraps
the scripts without owning them, and how to run it safely. **Time:** ~20 min.
Best taken after Module 4.

## Read first
- `pipelines/orchestration/README.md` (all of it)
- `pipelines/orchestration/definitions.py`, and one asset file (e.g.
  `assets_silver.py`), skimmed
- `compose.orchestration.yml`

## Why it's built this way (the intent)
- **Optional, by design.** Scripts are the source of truth and run standalone.
  Dagster adds lineage, run history, backfills, and a trigger UI *on top*. If
  Dagster disappeared tomorrow, every pipeline would still run.
- **Pipes subprocesses, not imports.** Each asset shells out to its script and
  passes parameters as env vars or flags from run config. Dagster never
  imports or edits the scripts, so a Dagster upgrade can't break a pipeline,
  and a script change doesn't need a Dagster change.
- **The asset graph is the medallion graph.** The 11 assets mirror bronze →
  silver → gold, plus the reference loaders as standalone assets.
- **Automation ships OFF.** `copphil_new_scene_sensor` polls CopPhil hourly
  and launches the full chain when a new scene appears. That chain
  *downloads gigabytes and writes to R2*. Turning it on is a deliberate
  operator decision, never a side effect.

## Essentials (in order)
1. **The lineage diagram** in the orchestration README. Point out the
   non-obvious edges: flood depends on silver SAR, not bronze, and mosaics run
   after gold.
2. **Run config = script parameters.** `scene`, `force`, `dry_run`, `only`,
   `tolerance_m`. Pin `scene` to build one scene; leave it unset for batch
   mode (`build_silver.py --only <product>`).
3. **Two ways to run it:** `dagster dev` (ephemeral, :3000) for exploring, or
   the compose stack (:3030, run storage in a `dagster` DB on the pgSTAC
   Postgres) for persistence.
4. **Host-only assets:** `ph_admin_pmtiles` needs `tippecanoe` + `aws`, and
   `raster_mosaics` execs into the TiTiler container.

## Adapt
- **GIS first:** Dagster is the Graphical Modeler for scripts, with run
  history. An "asset" is a dataset Dagster knows how to (re)build.
- **Software first:** compare it with Airflow. These are software-defined
  assets, not tasks, so the graph is *data* lineage. Pipes means the
  orchestrator holds no business logic.

## Hands-on

```bash
cd pipelines/orchestration
uv venv && uv pip install -e .
uv run dagster definitions validate      # loads cleanly?
uv run dagster dev                        # UI on http://localhost:3000
```

In the UI:
- Open the asset graph and find `silver/sentinel1_flood`'s upstream.
- Materialize **`bronze/copphil_sentinel` with `dry_run: true`**. Use the
  Launchpad, or run it headless:
  `dagster asset materialize -m definitions --select 'bronze/copphil_sentinel' --config-json '{"ops":{"bronze__copphil_sentinel":{"config":{"dry_run":true}}}}'`
- Open the Automation tab and *look at* the sensor and schedule. **Do not
  start them.**

## Checkpoint
A dry-run materialization succeeded, and they can show where in the asset code
the script is invoked as a subprocess.

## Check understanding
- "You add a `--tile` flag to a silver script. What changes in Dagster?"
  (Only the asset's run config schema, to pass the flag through. The script
  must work with or without Dagster.)
- "Why does the sensor ship STOPPED?" (Starting it begins real downloads and
  R2 writes.)

## Dive deeper (offer as options)
- **The sensor's cursor logic** in `automation.py`: how it decides a scene is
  "new".
- **Production-izing Dagster:** where it would run in their deployment
  (`philsa-deploy-bootstrap` treats it as optional).
