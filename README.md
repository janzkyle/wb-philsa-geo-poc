# PhilSA POC — geospatial data platform

A proof-of-concept geospatial data platform for the Philippine Space Agency
(PhilSA) / World Bank: a STAC-based catalog that **references** Earth-
observation assets in place rather than re-hosting them, fronted by a STAC
Browser and (planned) a webmap with vector tiling.

The end-to-end target architecture is in **`poc-architecture.mmd`** (render the
Mermaid diagram to see how the pieces connect). Contributing or working in this
repo? Read **`AGENTS.md`** for the conventions and guardrails — this README is
just *what it is* and *how to run it*.

## Repository layout

| Path                                  | What it is                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pipelines/`                          | All data pipeline scripts, organized by medallion tier (`01-bronze` / `02-silver` / `03-gold`) plus a `reference/` lane for by-reference loaders: PhilSA mirror, ESRI LULC, CopPhil raw-Sentinel download, and (planned) NDVI / SAR-flood derivation. See `pipelines/README.md`. |
| `.claude/skills/ph-admin-geoparquet/` | **Thin skill** that points at `pipelines/02-silver/ph-admin-boundaries/` so the agent can auto-invoke the PH admin-boundary build. The script there runs standalone without the skill.                                          |
| `poc-architecture.mmd`                | Mermaid diagram of the target architecture.                                                                                                                                                                                    |
| `stac-fastapi-pgstac/`                | **Git submodule** — the catalog API (brings up API + Postgres/pgSTAC locally). Points at our fork `janzkyle/wb-philsa-geo-stac-fastapi-pgstac`.                                                                                |
| `stac-browser/`                       | **Git submodule** — the catalog explorer UI. Points at our fork `janzkyle/wb-philsa-geo-stac-browser`.                                                                                                                         |

## Setup

```bash
# fresh clone: pull the submodules too (both point at our public forks)
git clone --recurse-submodules <repo-url>
# already cloned the plain way, or after a submodule bump:
git submodule update --init --recursive
```

Both submodules are cloned over **HTTPS** (the `janzkyle/wb-philsa-geo-*` forks
are public), so no SSH key or auth is needed to clone.

### Bring up the catalog API (pgSTAC)

Needed before any ingest script. The API + database come from the
`stac-fastapi-pgstac` submodule's own compose file, mapped to **port 8082**
locally (with the Transactions extension the ingest scripts rely on):

```bash
cd stac-fastapi-pgstac && ENABLE_TRANSACTIONS_EXTENSIONS=true docker compose up   # API on :8082 (transactions ON — ingest scripts need it)
```

Confirm it's up: `curl localhost:8082/collections`.

### Requirements

- **Docker** (for the API + pgSTAC).
- **GDAL ≥ 3.8** for the loaders — `gdalinfo`/`ogr2ogr` with the Parquet,
  OpenFileGDB, and `/vsis3` drivers — plus `curl` and `python3`.
- The PhilSA mirror (`mirror_philsa_catalog.py`) is pure stdlib Python and needs
  none of the above beyond `python3`.

## Quickstart — load data into the catalog

All ingest scripts default to `http://localhost:8082` and accept a
`STAC_API=` / `DST=` env override.

```bash
# by-reference loaders
python3 pipelines/reference/philsa-catalog/mirror_philsa_catalog.py --dry-run  # preview PhilSA mirror
python3 pipelines/reference/philsa-catalog/mirror_philsa_catalog.py            # mirror everything by reference
YEAR=2025 bash pipelines/reference/esri-lulc/load_esri_lulc.sh                 # load ESRI 10 m LULC for a year
# bronze: download latest raw Sentinel scenes from CopPhil (needs .env.copphil)
python3 pipelines/01-bronze/copphil-sentinel/download_copphil_eodata.py --dry-run
```

**PH admin boundaries** are built by
`pipelines/02-silver/ph-admin-boundaries/build_ph_admin_geoparquet.sh` (key knob
`TOLERANCE_M`, can write to R2 — see that folder's `README.md`). It runs
standalone; the `ph-admin-geoparquet` skill is just a thin pointer at it for
agent auto-invocation.

## Explore the catalog (STAC Browser)

Standard Vue app inside the `stac-browser/` submodule, **PhilSA-branded and
pre-wired to our own catalog**: its `config.js` pins `catalogUrl` to the local
API (`http://localhost:8082`) and sets `allowExternalAccess: false`, so the
Browser will *only* ever browse our `stac-fastapi-pgstac` — it can't be pointed
at any other STAC catalog. Title, header logo (`public/philsa-logo.png`),
favicon, and accent color (Philippine national blue) are PhilSA-specific.

```bash
cd stac-browser && npm install && npm start   # serves on http://localhost:8080, already pointed at the API
```

Overrides without editing the submodule: `SB_catalogUrl` (deployed API host) and
`SB_catalogImage` (logo URL) env vars, or `public/runtime-config.js`. The API
itself is branded via `STAC_FASTAPI_TITLE` / `STAC_FASTAPI_DESCRIPTION` /
`STAC_FASTAPI_LANDING_ID` in `stac-fastapi-pgstac/compose.yml` (env-overridable).

## Working with the submodules

Both submodules (`stac-fastapi-pgstac`, `stac-browser`) point at **our forks**
(`origin`), with the real upstream kept as the `upstream` remote. This is what
lets POC edits be shared: a plain `git clone` of an upstream-pointed submodule
can't carry your local commits, but a fork can. Keep edits minimal and
POC-specific — they track upstream.

**To edit a submodule and have collaborators get the change:**

```bash
cd stac-browser                       # or stac-fastapi-pgstac
# ...make your edits...
git commit -am "..."                  # commit inside the submodule
git push origin HEAD:main             # push to OUR fork
cd ..
git add stac-browser                  # record the new pinned commit (gitlink)
git commit -m "bump stac-browser submodule"   # in the PARENT repo
```

Both commits matter: the submodule push publishes the code; the parent commit
records *which* commit collaborators should check out. Skip the parent commit and
your edit stays invisible to everyone else.

To pull in upstream's updates later: `git fetch upstream && git merge upstream/main`
inside the submodule, push to `origin`, then record the new gitlink as above.

## Status & what's next

- 🔜 **Ingest.** PhilSA catalog mirror, ESRI 10 m LULC, and PH admin
  boundaries all load into pgSTAC today. Ingesting CopPhil S3 raw Sentinel/EODATA, Copernicus EMS vectors, OSM/synthetic vectors, and Earth Search Sentinel-2 L2A assets is next.
- 🔜 **Storage (Cloudflare R2).** Wire the public (open COGs + PMTiles) and
  private (sensitive/licensed imagery) buckets, with presigned URLs for
  restricted assets. The admin-boundary skill already supports R2 output.
- 🔜 **Frontend.** Stand up the STAC Browser end-to-end and the MapLibre webmap
  with TiTiler raster tiling.
- 🔜 **Auth & governance.** Identity provider + RBAC, collection-level access
  control, and the open/restricted data-sharing policy.

When you finish a milestone, update this list and `poc-architecture.mmd` so they
stay honest.
