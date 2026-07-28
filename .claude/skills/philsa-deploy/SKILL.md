---
name: philsa-deploy
description: Deploy and operate the PhilSA POC on free tiers — the Neon prod database, the Render Blueprint (STAC API, TiTiler, STAC Browser, webmap), the Cloudflare Worker chat backend and edge gateway, and R2 bucket setup/CORS. Use when deploying, redeploying, or bootstrapping any environment; ingesting or migrating data into prod; running the deploy/scripts; setting up an R2 bucket or its CORS policy; or debugging a deployed service (cold starts, read-only 405s, silent chat failures, AccessDenied on CORS).
---

# Deploying and operating the POC

Full runbook: **`deploy/DEPLOYMENT.md`** (accounts to create, step-by-step, caveats).
Component docs: **`deploy/gateway/README.md`** (edge gateway),
**`deploy/r2/README.md`** (public-bucket CORS). The app tier is one Blueprint —
**`render.yaml`**. This skill is the operator's cheat-sheet plus the traps that
otherwise cost a full run to find.

## The shape of it

| Layer | Where | Notes |
|---|---|---|
| Prod database | **Neon** (Postgres + PostGIS + pgSTAC) | Use the **Direct connection**, *not* the `-pooler` host — pgSTAC's `SET ROLE` migration needs a real session. |
| Local database | Docker, `stac-fastapi-pgstac/compose.yml` | Host port `5439`. This is the `local` env. |
| STAC API · TiTiler · Browser · webmap | **Render**, all four in `render.yaml` | Free web services sleep after ~15 min idle (~30–60 s wake). |
| Chat backend | **Cloudflare Worker**, `deploy/chat/` | A Worker so the first demo message doesn't eat a cold start. |
| Edge gateway | **Cloudflare Worker**, `deploy/gateway/` | Deployed twice — `-e stac` and `-e tiles`. |
| Object storage | **Cloudflare R2** | Public bucket for open COGs/mosaics/PMTiles. |

Environment config lives in `deploy/environments/{local,prod}.env` — copy from the
`.env.example` templates; the real files are gitignored. Every script takes the
environment name as its first argument (`local` or `prod`).

## Commands

```bash
deploy/scripts/db-migrate.sh prod            # install/upgrade pgSTAC (idempotent) — expect "pgstac 0.9.8"
deploy/scripts/db-check.sh   prod            # connection + pgSTAC version + collection/item counts
deploy/scripts/load-reference-data.sh local  # loaders against the LOCAL writable API

# prod ingest — private ephemeral transactions API bound to Neon, then torn down
deploy/scripts/prod-ingest.sh prod                # PhilSA mirror only
deploy/scripts/prod-ingest.sh prod --with-silver  # + Sentinel silver COGs (needs GDAL + R2 creds)
deploy/scripts/prod-ingest.sh prod --with-esri    # + ESRI 10 m LULC (YEAR= to override 2025)
deploy/scripts/prod-ingest.sh prod --all          # everything (~3–6 min, mostly the mirror)
deploy/scripts/prod-ingest.sh prod --silver-only  # re-catalog silver only (seconds)

cd deploy/gateway && wrangler deploy -e stac && wrangler deploy -e tiles
cd deploy/chat && wrangler secret put OPENROUTER_API_KEY && wrangler deploy
deploy/r2/apply-cors.sh [--show]             # public-bucket read CORS (one-time)
```

## Traps

- **Prod is read-only on purpose** (`ENABLE_TRANSACTIONS_EXTENSIONS=false` in
  `render.yaml`, re-blocked at the gateway). Pointing loaders at the public URL
  returns a wall of **405**s. Ingest goes through **`prod-ingest.sh`** only —
  `load-reference-data.sh` refuses any non-local env unless `prod-ingest.sh`
  injected its private write endpoint. **Never re-enable transactions on a public
  origin.** `INGEST_PORT=` overrides the default `8092`.
- **`apply-cors.sh` fails `AccessDenied` with the normal token.** `PutBucketCors`
  is a *bucket-admin* operation; the usual `.env` token is scoped Object Read &
  Write. Either paste the rules in the dashboard (R2 ▸ bucket ▸ Settings ▸ CORS
  Policy) **as a bare JSON array** — the contents of `cors.json`'s `CORSRules`, not
  the wrapper — or mint an **Admin Read & Write** token. `--show` usually works
  even when `put` doesn't, so verify with it.
- **Unset `VITE_CHAT_API` fails silently.** The webmap is a static site, so the
  relative `/api/chat` default resolves to the static host, which answers **empty
  200** — no error, no reply, chat just does nothing. Set it to the Worker's
  `<url>/api/chat` and redeploy the static site. Check `GET <worker>/health` for
  `keyConfigured` and the model chain **before** blaming the frontend.
- **`CHAT_ALLOW_ORIGIN` is a CORS allowlist, not auth.** It stops a stray page from
  spending OpenRouter credits; anyone with the URL can still curl it. Keep the URL
  unadvertised — see the hardening item in `TODO.md` before any external demo.
- **Render's predicted URLs may get a suffix.** The Blueprint pre-wires
  `philsa-stac-api` / `philsa-titiler`; if the names were taken, fix `SB_catalogUrl`
  and `VITE_STAC_API` / `VITE_TITILER`, then redeploy the two static sites.
- **pgSTAC is pinned to `0.9.8`** in `deploy/scripts/lib.sh` to match the local
  image. Bump both together.
- **Cold starts are expected** on free tier (Render ~30–60 s; Neon auto-suspends
  after ~5 min, wakes in ~1 s). Not a bug — retry once.

## R2 one-time setup

Bucket creation, the API token, the account ID, `R2_PUBLIC_BASE`, the endpoint,
and the tiered key layout are all in **`pipelines/README.md` → *R2 one-time setup*
and *R2 key layout*** — read it there rather than working from memory. Credentials
live in the single gitignored repo-root `.env`.

## Instructions for the assistant

- **Confirm before deploying, migrating, or ingesting** — these are outward-facing
  and hit shared infra. Read-only checks (`db-check.sh`, `--show`, `/health`) are
  fine to run unprompted when diagnosing.
- **Never echo secrets.** Neon passwords, R2 keys, and `OPENROUTER_API_KEY` are
  entered into Render/wrangler or the gitignored `.env` — don't print or commit them.
- When a deployed service misbehaves, check in this order: `/health` or
  `db-check.sh` → is it a cold start → is the env var actually set on the *right*
  service in `render.yaml` → only then the code.
- After a pipeline re-run, `--silver-only` re-catalogs in seconds; don't run `--all`
  just to refresh derivatives.
