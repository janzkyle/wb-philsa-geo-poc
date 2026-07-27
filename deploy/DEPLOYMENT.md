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
| **Chat backend** | map assistant (`webmap/server/`) | **Cloudflare Worker** (`chat/`) | Holds the OpenRouter key server-side. A Worker, not a Render service: always-on, so the first chat message of a demo doesn't eat a cold start. |
| **Object storage** | COGs / PMTiles | **Cloudflare R2** | Already set up — no change. |

Everything except the database is described in **`../render.yaml`** (one Blueprint),
so the app tier deploys in a single action. The database is on Neon and is
driven by the scripts in `scripts/`.

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

### Step 4b — Deploy the chat backend (map assistant)
The webmap is a **static** site, so it has no backend of its own. The assistant's
server must be deployed separately, and `philsa-webmap` must be told where it is —
if `VITE_CHAT_API` is unset the frontend falls back to the relative `/api/chat`,
which the static host answers with an **empty 200** and the chat silently does
nothing (no error, no reply).

```bash
cd deploy/chat
wrangler secret put OPENROUTER_API_KEY   # once — the key the browser must never see
wrangler deploy                          # -> https://philsa-chat.<account>.workers.dev
curl https://philsa-chat.<account>.workers.dev/health
```

`/health` returns `keyConfigured` and the model chain a real request would try —
check it before blaming the frontend. Then confirm two things in
`render.yaml` → `philsa-webmap`:
- `VITE_CHAT_API` = `<worker URL>/api/chat` (redeploy the static site after any change)
- the Worker's `CHAT_ALLOW_ORIGIN` (`deploy/chat/wrangler.toml`) lists the webmap's
  real origin. It's a **CORS allowlist, not auth** — it stops a stray page from
  spending your OpenRouter credits, but anyone who finds the URL can still call it
  with curl. Keep the URL unadvertised, and see the hardening item in `TODO.md`
  before any external demo.

### Step 5 — Ingest/migrate the catalog into prod

> **The public prod API is read-only.** It runs with
> `ENABLE_TRANSACTIONS_EXTENSIONS=false` (`render.yaml`) so no one on the internet
> can write to the catalog. You therefore **do not** point the loaders at the
> public URL — `load-reference-data.sh` refuses to run against any non-local env
> unless `prod-ingest.sh` has injected its private write endpoint, and the
> individual loaders check the target's `/conformance` and refuse read-only APIs.
> Ingest goes through `prod-ingest.sh`.

`prod-ingest.sh` stands up a **private, ephemeral** transactions-enabled STAC API
on `localhost`, binds it to the prod database (Neon, from `prod.env`), runs the
normal loaders against it, and tears it down. The writes land in Neon; the public
API then serves those same rows read-only. Nothing writable is ever
internet-reachable. Requires Docker.

```bash
deploy/scripts/prod-ingest.sh prod                 # PhilSA mirror only: diwata-2 / planetscope / skysat
deploy/scripts/prod-ingest.sh prod --with-silver   # + Sentinel silver: sentinel1-sar, sentinel1-flood, sentinel2-ndvi, sentinel2-truecolor
deploy/scripts/prod-ingest.sh prod --with-esri     # + ESRI 10 m LULC (default year 2025; override with YEAR=)
deploy/scripts/prod-ingest.sh prod --all           # mirror + esri + silver (the full catalog)
deploy/scripts/prod-ingest.sh prod --silver-only   # JUST re-catalog the silver COGs (skips the mirror)
deploy/scripts/db-check.sh prod                    # verify collection/item counts
```

Loaders and what they need (same as before — only the write endpoint moved):
- **mirror** (always) — pure stdlib, no extra deps.
- **`--with-silver`** — catalogs the R2 silver COGs by reference
  (`pipelines/03-gold/catalog_silver.py`); needs **GDAL** and the **R2 creds in
  the repo-root `.env`**. This is what creates `sentinel1-sar` et al.
- **`--with-esri`** (or `YEAR=`) — ESRI 10 m LULC; needs **GDAL ≥ 3.8**.

Timing: writes now go to a localhost API talking directly to Neon (no Render
round-trip, no cold starts), so a full `--all` load is faster than before —
roughly **3–6 minutes**, mostly the mirror. To re-catalog only the silver
derivatives after a pipeline re-run, use `--silver-only` (seconds, no mirror).
`INGEST_PORT=` overrides the default `8092` if that port is busy.

Open the Browser (`https://philsa-browser.onrender.com`) — the collections appear.

---

## Everyday local workflow (unchanged)

```bash
# bring up local DB + API (transactions on for ingest)
cd stac-fastapi-pgstac && ENABLE_TRANSACTIONS_EXTENSIONS=true docker compose up -d && cd ..
deploy/scripts/db-check.sh local
deploy/scripts/load-reference-data.sh local
```

Promoting the same data to prod uses `prod-ingest.sh prod` (not
`load-reference-data.sh prod` — the public prod API is read-only; see Step 5).

---

## Caveats & limits (free tier)

- **Cold starts** — the two Render web services sleep after ~15 min idle
  (~30–60 s first request). Expected on free.
- **Neon free** auto-suspends a database after ~5 min idle (it wakes on the next
  connection, ~1 s cold start) and caps you at 0.5 GB storage. A by-reference
  catalog is tiny, so storage is a non-issue; the auto-suspend is transparent.
- **CORS** — the STAC API and TiTiler allow all origins (declared explicitly in
  `render.yaml`), which is what lets the static frontends *and external agencies*
  call them cross-origin. This is the open-data contract; keep it for open
  collections and gate only the restricted tier (see `deploy/gateway/`).
- **Read-only prod / edge gateway** — prod writes are disabled at the origin
  (`ENABLE_TRANSACTIONS_EXTENSIONS=false`); ingest goes through `prod-ingest.sh`
  (Step 5). The optional `deploy/gateway/` Cloudflare Worker fronts the origins
  on `*.workers.dev` (no custom domains in this POC) with caching, rate limits,
  and a re-block on writes.
- **R2 CORS** — the public bucket needs a read CORS policy for browsers to fetch
  mosaics directly (else the webmap/template fall back to per-item COGs). Apply
  once with `deploy/r2/apply-cors.sh` — see `deploy/r2/README.md`.
- **pgSTAC version** is pinned to `0.9.8` in `scripts/lib.sh` to match the local
  Docker image (`ghcr.io/stac-utils/pgstac:v0.9.8`). Bump both together.
- **Secrets** never enter git: `*.env` and `deploy/.venv/` are gitignored, and
  Render holds the deploy secrets as `sync: false` env vars.

## Script reference (`deploy/scripts/`)

| Script | Does |
| --- | --- |
| `db-migrate.sh <env>` | Install/upgrade the pgSTAC schema on any env (this is the prod bootstrap too). |
| `db-check.sh <env>` | Connection + pgSTAC version + collection/item counts. |
| `load-reference-data.sh <env>` | Run the by-reference loaders against a writable STAC API. Direct for `local`; for any other env it refuses to run except *via* `prod-ingest.sh` (which injects the private write endpoint). |
| `prod-ingest.sh <env>` | Ingest/migrate into a deployed catalog via a private, ephemeral transactions API bound to that env's DB — the prod-safe way to load, since the public API is read-only. Needs Docker. |
| `../r2/apply-cors.sh [--show]` | Apply (or show) the read CORS policy on the public R2 bucket so browsers can fetch mosaics/COGs cross-origin. Needs the AWS CLI + `.env` R2 creds. |
| `lib.sh` | Shared helpers (env loading, pypgstac bootstrap). Sourced, not run. |
