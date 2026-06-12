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
| `mirror_philsa_catalog.py`            | Mirrors every Collection + Item from the public PhilSA Satellite Imagery Catalog (`api.catalog.data.philsa.gov.ph`) into local pgSTAC, by reference. Stdlib only. `--dry-run`, `--only <ids>`, `--collections-only` supported. |
| `load_esri_lulc.sh`                   | Registers ESRI 10 m Annual LULC (Impact Observatory v003) COGs over the PH as a STAC collection, by reference to the public Azure blobs. Loops MGRS tiles, skips non-existent / out-of-bbox ones.                              |
| `.claude/skills/ph-admin-geoparquet/` | Skill that builds PH admin-boundary GeoParquet (adm0–adm4) from the OCHA COD-AB geodatabase on HDX; writes locally or to Cloudflare R2. See its `SKILL.md`.                                                                    |
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
cd stac-fastapi-pgstac && docker compose up   # API on http://localhost:8082
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
./mirror_philsa_catalog.py --dry-run     # preview the PhilSA mirror, no writes
./mirror_philsa_catalog.py               # mirror everything by reference
YEAR=2025 ./load_esri_lulc.sh            # load ESRI 10 m LULC tiles for a year
```

**PH admin boundaries** are built via the `ph-admin-geoparquet` skill (wraps
`build_ph_admin_geoparquet.sh`; key knob `TOLERANCE_M`, can write to R2). See the
skill's `SKILL.md` rather than running the script by hand.

## Explore the catalog (STAC Browser)

Standard Vue app inside the `stac-browser/` submodule; point it at the local API:

```bash
cd stac-browser && npm install && npm start   # then open it against http://localhost:8082
```

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

- ✅ **Ingest works.** PhilSA catalog mirror, ESRI 10 m LULC, and PH admin
  boundaries all load into pgSTAC today.
- 🔜 **Storage (Cloudflare R2).** Wire the public (open COGs + PMTiles) and
  private (sensitive/licensed imagery) buckets, with presigned URLs for
  restricted assets. The admin-boundary skill already supports R2 output.
- 🔜 **Frontend.** Stand up the STAC Browser end-to-end and the MapLibre webmap
  with TiTiler raster tiling.
- 🔜 **Auth & governance.** Identity provider + RBAC, collection-level access
  control, and the open/restricted data-sharing policy.

When you finish a milestone, update this list and `poc-architecture.mmd` so they
stay honest.
