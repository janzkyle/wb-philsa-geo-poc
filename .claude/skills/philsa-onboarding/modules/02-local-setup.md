# Module 2 — Local setup

**Goal:** a working local catalog (pgSTAC + STAC API + STAC Browser) with real
data in it, plus a clear picture of which extra tools and credentials unlock
which parts of the repo. **Time:** ~30–45 min, mostly installs.

## Read first
- `README.md` → "Setup", "Requirements", "Quickstart", "Explore the catalog"
- `.env.example` (the key list and what each group is for)
- `deploy/environments/local.env.example`

## Why it's built this way (the intent)
- **One repo-root `.env` for every backend secret.** Scripts load *only* that
  file (override with `ENV_FILE=`), so a stray `.env` in a subfolder can't
  shadow credentials. `webmap/.env` is separate on purpose: it holds build-time
  URLs, not secrets.
- **The catalog runs from the submodule's own compose file** (local
  transactions ON, port 8082), so local and prod run the same API code.
- **Requirements are tiered.** Each layer of the platform unlocks with one
  more tool or credential. They don't need everything on day one.

## Essentials (in order)

1. **The capability ladder.** Each step adds a tool or credential:

   | To run… | You need |
   |---|---|
   | Catalog + STAC Browser + PhilSA mirror | git, Docker, Python 3, Node ≥ 20.19 / 22.12 |
   | + ESRI loader, admin boundaries | GDAL ≥ 3.8 (with Parquet + OpenFileGDB drivers) |
   | + Sentinel silver builds, local TiTiler, `catalog_silver.py` | GDAL ≥ 3.11 + **R2 credentials** |
   | + Bronze downloads | **CopPhil** account (Keycloak username/password) |
   | + Map assistant chat | **OpenRouter** API key |
   | Optional extras | `uv` (recommended), `aws` CLI (mosaics/PMTiles/CORS), `tippecanoe` (admin PMTiles) |

   Credentials come from whoever handed over the project, or from their own
   accounts once Module 7 stands up a PhilSA-owned environment.
2. **The port map.** It's worth memorizing, because "connection refused" is
   always one of these:

   | Port | Service |
   |---|---|
   | 5439 | Postgres + pgSTAC (Docker) |
   | 8082 | STAC API (Docker, transactions ON locally) |
   | 8083 | TiTiler (`compose.viz.yml`) |
   | 8080 | STAC Browser (`npm start`) |
   | 5173 | Webmap (Vite) |
   | 8087 | Chat backend (`npm run chat`) |
   | 3000 / 3030 | Dagster (`dagster dev` / compose) |
   | 8092 | Ephemeral prod-ingest API (Module 7) |

3. **Env files:** repo-root `.env` holds secrets, `deploy/environments/*.env`
   is the per-environment DB config, and `webmap/.env` holds Vite URLs.

## Adapt
- **GIS first:** explain Docker as "a packaged, isolated app with its own
  dependencies, so you don't install Postgres or the API by hand". Point out
  that `docker compose up` here starts two containers (database + API).
- **Software first:** explain why GDAL version matters. The silver builders
  stage scenes with the unified `gdal vsi copy` CLI, which only exists in
  3.11+. The easiest installs are `brew install gdal` on macOS and
  `conda-forge` or the `ubuntugis` PPA on Linux. Distro packages are often too
  old.
- **Windows:** do everything inside WSL2 (Ubuntu), including Docker Desktop's
  WSL backend. The shell scripts assume bash.

## Hands-on

```bash
# 1. clone with submodules (use the URL you were given; the repo may have moved to a PhilSA org)
git clone --recurse-submodules <repo-url> && cd <repo>
#    already cloned?   git submodule update --init --recursive

# 2. see what you have
bash .claude/skills/philsa-onboarding/doctor.sh

# 3. config files (fill in only the credentials you actually have)
cp .env.example .env
cp deploy/environments/local.env.example deploy/environments/local.env

# 4. the catalog
cd stac-fastapi-pgstac && ENABLE_TRANSACTIONS_EXTENSIONS=true docker compose up -d && cd ..
curl -s localhost:8082/collections | head -c 300; echo   # empty list on a fresh DB
deploy/scripts/db-check.sh local                          # pgSTAC version + counts

# 5. first data: a small, fast slice of the PhilSA mirror (no credentials needed)
python3 pipelines/reference/philsa-catalog/mirror_philsa_catalog.py --only sentinel-2-l2a --max-items 5 --dry-run
python3 pipelines/reference/philsa-catalog/mirror_philsa_catalog.py --only sentinel-2-l2a --max-items 5

# 6. browse it
cd stac-browser && npm install && npm start   # http://localhost:8080
```

Go through `doctor.sh`'s output together and fix any ✘ before step 4. Ask
before running steps 4–6 for them; they may prefer to type them.

## Checkpoint
- `doctor.sh` reports "Local catalog + STAC Browser + PhilSA mirror: yes".
- `curl localhost:8082/collections` shows `sentinel-2-l2a`, and STAC Browser
  at :8080 shows it with 5 items.
- Running the mirror command **again** logs updates or skips, not errors.
  Point out that this is the idempotent upsert convention in action.

## Check understanding
- "The mirror just failed with a wall of 405s. What's the first thing you
  check?" (Is the API running with `ENABLE_TRANSACTIONS_EXTENSIONS=true`?
  `doctor.sh` checks this.)
- "Where does a new pipeline script read the R2 key from?" (The repo-root
  `.env`, and only that file.)

## Dive deeper (offer as options)
- **What's inside the compose stack:** `stac-fastapi-pgstac/compose.yml`,
  which pins the pgSTAC image to 0.9.8 to match `deploy/scripts/lib.sh`.
- **Loading the full reference catalog locally:**
  `deploy/scripts/load-reference-data.sh local --with-esri` (full mirror +
  ESRI; `--all` adds the silver catalog, which needs R2 creds). It takes a few
  minutes.
- **STAC Browser branding and lock-down:** `stac-browser/config.js`
  (`catalogUrl`, `allowExternalAccess: false`) and the `SB_*` env overrides.
