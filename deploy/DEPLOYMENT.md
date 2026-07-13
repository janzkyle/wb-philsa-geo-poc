# Free deployment guide — PhilSA POC

This is the end-to-end recipe for standing the POC up on **free tiers**, plus the
scripts that make it repeatable. Everything here is additive — it doesn't change
how you run things locally.

## What we deploy, and why these services

| Layer | Component | Free service | Why |
| --- | --- | --- | --- |
| **Database (prod)** | Postgres + PostGIS + pgSTAC | **Neon** | Free managed Postgres with PostGIS and a normal IPv4 **direct** connection, so `pypgstac migrate` installs the pgSTAC schema in one command. |
| **Database (local)** | Postgres + pgSTAC | **Docker** (`stac-fastapi-pgstac/compose.yml`) | The existing dev database on host port `5439`. This is the `local` DB. |
| **STAC API** | `stac-fastapi-pgstac` | **Render** web service (Docker) | Runs the submodule's own Dockerfile; free tier is plenty for a by-reference catalog. |
| **Raster tiler** | TiTiler | **Render** web service (Docker) | Same platform, reads COGs straight from R2. |
| **STAC Browser** | catalog explorer | **Render** static site | Free static hosting, build-time `SB_catalogUrl`. |
| **Webmap** | MapLibre app | **Render** static site | Free static hosting, build-time `VITE_*`. |
| **Object storage** | COGs / PMTiles | **Cloudflare R2** | Already set up — no change. |

Everything except the database is described in **`../render.yaml`** (one Blueprint),
so the app tier deploys in a single action. The database is on Neon and is
driven by the scripts in `scripts/`.

> **Out of scope (for now):** the TerriaJS **dashboard** is a heavy CKAN/Terria
> build that doesn't fit a free static tier cleanly. It's intentionally left out
> of the Blueprint; deploy it separately later. The STAC Browser + webmap already
> cover the "explore the catalog" demo surface.

### Why Render for the app tier
One Blueprint file provisions all four app services, secrets are entered once and
never touch git, and the two backends run the projects' **own** Dockerfiles, so
there's no drift between local and prod. Trade-off to know about: **free web
services sleep after ~15 min idle** and take ~30–60 s to wake on the next
request. Fine for a POC/demo; if you need always-on later, bump those two
services to a paid instance — nothing else changes.

---

## The two database environments

Config lives in `environments/`. Copy the templates (the real files are
gitignored so secrets never get committed):

```bash
cp deploy/environments/local.env.example deploy/environments/local.env   # usable as-is
cp deploy/environments/prod.env.example  deploy/environments/prod.env    # fill in from Neon
```

Every script takes the environment name as its first argument: `local` or `prod`.

```bash
deploy/scripts/db-check.sh local     # health of the Docker pgSTAC
deploy/scripts/db-check.sh prod      # health of Neon
```

---

## Accounts you need to create

You already have **Cloudflare R2**. You need to create:

### 1. Neon (the prod database)
1. Sign up at <https://neon.tech> (GitHub/Google login works) → **New project**.
2. Name it (e.g. `world-bank-philsa-geo`) and pick a region close to the
   Philippines (**AWS `ap-southeast-1` Singapore**). Neon creates a default
   database `neondb` and role `neondb_owner`.
3. Open **Connect** → choose **Direct connection** (⚠️ *not* the pooled `-pooler`
   host). You'll get something like:
   `postgresql://neondb_owner:[PASSWORD]@ep-cool-name-12345678.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
   The direct connection is IPv4-reachable and gives a real session, so the
   pgSTAC migration (which uses `SET ROLE`) runs cleanly.
4. Fill those pieces into `deploy/environments/prod.env` (`PGHOST`, `PGUSER`
   `neondb_owner`, `PGPASSWORD`, `PGDATABASE=neondb`, and the full `DATABASE_URL`).

> **Why Neon and not Supabase:** pgSTAC is a heavy, `SET ROLE`-using schema.
> Supabase's free tier only offers an IPv6-only direct connection (unreachable on
> many networks, including a typical PH ISP) plus a pooler that terminates the
> migration, so `pypgstac migrate` can't complete. Neon's free tier has a normal
> IPv4 direct connection where it installs in one command, and PostGIS lands in
> `public` so pgSTAC finds it without search_path tweaks.

### 2. Render (the app tier)
1. Sign up at <https://render.com> with your **GitHub** account.
2. Push this repo to GitHub (Render deploys from a Git repo). The two submodules
   are public, so Render can pull them.
3. That's all for now — you'll create the Blueprint in step 4 below.

---

## Deploy, step by step

### Step 1 — Bootstrap the Neon database
Installs PostGIS + the pgSTAC schema into your empty Neon project, in one command.
Idempotent.

```bash
deploy/scripts/db-migrate.sh prod
```

Expected tail: `pgstac 0.9.8`. If it can't connect, re-check the direct-connection
host and password in `prod.env`. Then confirm: `deploy/scripts/db-check.sh prod`.

### Step 2 — Push to GitHub
```bash
git add deploy render.yaml .gitignore README.md
git commit -m "add free-tier deployment (Neon + Render)"
git push
```
(Real `*.env` files and `deploy/.venv/` are gitignored — only templates ship.)

### Step 3 — Create the Render Blueprint
1. Render dashboard → **New** → **Blueprint**.
2. Pick this GitHub repo. Render reads **`render.yaml`** and lists the 4 services.
3. It will prompt for the `sync: false` secrets — enter them:

   **philsa-stac-api** (from `prod.env` / Neon):
   - `PGHOST` = `ep-<...>.ap-southeast-1.aws.neon.tech`
   - `PGUSER` = `neondb_owner`
   - `PGPASSWORD` = your Neon password
   - (`PGPORT` `5432` and `PGDATABASE` `neondb` are pre-filled)
   - Neon requires SSL — also add `PGSSLMODE` = `require` on this service.

   **philsa-titiler** (from the repo-root `.env` / R2):
   - `AWS_ACCESS_KEY_ID` = your R2 access key id
   - `AWS_SECRET_ACCESS_KEY` = your R2 secret
   - `AWS_S3_ENDPOINT` = `<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`

4. **Apply**. Render builds all four. The two Docker services take a few minutes.

### Step 4 — Confirm the URLs (one-time)
The Blueprint pre-wires the frontends to the **predicted** URLs
`https://philsa-stac-api.onrender.com` and `https://philsa-titiler.onrender.com`.
If your Render account already uses those names, Render appends a suffix. Check
the actual URLs in the dashboard; if they differ, update these env vars and
redeploy the two static sites:
- `philsa-browser` → `SB_catalogUrl`
- `philsa-webmap` → `VITE_STAC_API`, `VITE_TITILER`

Verify the API is live: open `https://<your-api>.onrender.com/collections`
(first hit may be slow while it wakes).

### Step 5 — Load the catalog into prod
Point `STAC_API` in `prod.env` at the real API URL (default assumes the predicted
one), then choose how much to load:

```bash
deploy/scripts/load-reference-data.sh prod                 # PhilSA mirror only: diwata-2 / planetscope / skysat
deploy/scripts/load-reference-data.sh prod --with-silver   # + Sentinel silver: sentinel1-sar, sentinel1-flood, sentinel2-ndvi, sentinel2-truecolor
deploy/scripts/load-reference-data.sh prod --with-esri             # + ESRI 10 m LULC (default year 2025; override with YEAR=)
deploy/scripts/load-reference-data.sh prod --all           # mirror + esri + silver (the full catalog)
deploy/scripts/db-check.sh prod                            # verify collection/item counts
```

Loaders and what they need:
- **mirror** (always) — pure stdlib, no extra deps.
- **`--with-silver`** — catalogs the R2 silver COGs by reference
  (`pipelines/03-gold/catalog_silver.py`); needs **GDAL** and the **R2 creds in
  the repo-root `.env`**. This is what creates `sentinel1-sar` et al.
- **`--with-esri`** (or `YEAR=`) — ESRI 10 m LULC; needs **GDAL ≥ 3.8**.

Timing: over the free-tier Render API each item is a network round-trip, so a
full `--all` load is roughly **5–10 minutes** (mostly waiting on the API, not
CPU). To (re)load only the silver derivatives without re-running the mirror:
`STAC_API=<api-url> python3 pipelines/03-gold/catalog_silver.py`.

Open the Browser (`https://philsa-browser.onrender.com`) — the collections appear.

---

## Everyday local workflow (unchanged)

```bash
# bring up local DB + API (transactions on for ingest)
cd stac-fastapi-pgstac && ENABLE_TRANSACTIONS_EXTENSIONS=true docker compose up -d && cd ..
deploy/scripts/db-check.sh local
deploy/scripts/load-reference-data.sh local
```

Promoting the same data to prod is the same command with `prod`.

---

## Caveats & limits (free tier)

- **Cold starts** — the two Render web services sleep after ~15 min idle
  (~30–60 s first request). Expected on free.
- **Neon free** auto-suspends a database after ~5 min idle (it wakes on the next
  connection, ~1 s cold start) and caps you at 0.5 GB storage. A by-reference
  catalog is tiny, so storage is a non-issue; the auto-suspend is transparent.
- **CORS** — the STAC API allows all origins by default, which is what lets the
  static frontends call it cross-origin. Tighten later when auth lands.
- **pgSTAC version** is pinned to `0.9.8` in `scripts/lib.sh` to match the local
  Docker image (`ghcr.io/stac-utils/pgstac:v0.9.8`). Bump both together.
- **Secrets** never enter git: `*.env` and `deploy/.venv/` are gitignored, and
  Render holds the deploy secrets as `sync: false` env vars.

## Script reference (`deploy/scripts/`)

| Script | Does |
| --- | --- |
| `db-migrate.sh <env>` | Install/upgrade the pgSTAC schema on any env (this is the prod bootstrap too). |
| `db-check.sh <env>` | Connection + pgSTAC version + collection/item counts. |
| `load-reference-data.sh <env>` | Run the by-reference loaders against that env's STAC API. |
| `lib.sh` | Shared helpers (env loading, pypgstac bootstrap). Sourced, not run. |
