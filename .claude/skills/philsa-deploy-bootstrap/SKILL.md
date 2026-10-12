---
name: philsa-deploy-bootstrap
description: Stand up a NEW deployment of the PhilSA POC from scratch, on the reference free stack (Neon + Render + Cloudflare R2/Workers + OpenRouter) or on the platforms the team actually has (Azure, on-prem / government data center, or a mix). Interviews the developer about their platforms and tools, maps each component onto them, flags the code that assumes Cloudflare R2 or OpenRouter, writes a deployment plan, then walks it step by step with a verification gate after each step. Use when deploying the POC for the first time, moving it to different infrastructure, handing it over to PhilSA-owned accounts, or planning a production deployment. For operating the EXISTING reference deployment, use philsa-deploy instead.
---

# Bootstrapping a PhilSA POC deployment

This skill takes someone from empty accounts to a running platform, **on
whatever infrastructure they have**. The reference deployment (Neon + Render +
Cloudflare + OpenRouter, all free tier) is the recommended default. It's
documented, scripted, and proven. Nothing about the architecture requires it,
though.

- **`philsa-deploy`** operates the deployment that already exists: redeploys,
  prod ingest, debugging, and traps.
- **This skill** builds a new one. When the result runs on the reference stack,
  `philsa-deploy` takes over day-two operations.

Canonical docs. Read them; don't re-derive them:
- `deploy/DEPLOYMENT.md`: the reference path, step by step
- `deploy/AUTH.md` → "First-time setup": gateway, private bucket, keys
- `render.yaml`: every app-tier env var, with comments explaining why
- `pipelines/README.md` → "R2 one-time setup"

## Two modes

- **Plan** (default, touches nothing). Interview, map components, list the
  porting work, and write the plan. About 20 minutes, safe to run any time.
- **Execute.** Walk the plan step by step. Every step that creates or changes
  infrastructure needs an explicit go-ahead.

Ask which mode they want. If they arrived from `philsa-onboarding` Module 7,
start with Plan.

## Step 1 — Interview (one AskUserQuestion, then follow-ups as needed)

Ask, keeping the reference stack as the recommended first option:

1. **Where should each layer run?** Options: reference free stack
   (Recommended) · Azure · on-prem / government data center · mixed. If
   `.onboarding/progress.md` exists, reuse the platforms recorded there.
2. **Which tools do you already use?** Multi-select: Docker Compose ·
   Kubernetes · Terraform / Bicep · GitHub Actions · Azure DevOps · nginx /
   Caddy. *Prefer the tools they know* over introducing new ones; a deployment
   they can't maintain is worse than a less elegant one they can.
3. **Constraints.** Options: must stay $0 · data must stay in-country or
   on-prem · no inbound internet to our servers · must use our identity
   provider (Keycloak / Entra ID).
4. **Goal.** Options: a demo/POC environment · a production-grade environment
   (always-on, backups, monitoring).

Follow up only where an answer changes the plan. Examples: "Is the
restriction on *inbound* traffic only, or is outbound internet restricted
too?" "Do you have a container registry?"

## Step 2 — Map the components

Every deployment has these components. Fill in one row per component for
*their* plan:

| # | Component | What it must provide | Reference stack |
|---|---|---|---|
| 1 | **Object storage** | S3-compatible API (SigV4), a public-read bucket for open COGs/PMTiles/MosaicJSON, a private bucket, browser CORS | Cloudflare R2 |
| 2 | **Database** | PostgreSQL with `postgis`, `btree_gist`, `unaccent`; pgSTAC **0.9.8** creates 3 roles and uses `SET ROLE`, so it needs a *direct* session (no transaction pooler) | Neon (direct connection) |
| 3 | **STAC API** | Container from `deploy/stac-api/Dockerfile` (context `stac-fastapi-pgstac/`), **read-only** (`ENABLE_TRANSACTIONS_EXTENSIONS=false`), health `/_mgmt/ping` | Render web service |
| 4 | **TiTiler** | Container from `deploy/titiler/Dockerfile`, storage creds, ≥ 512 MB RAM per concurrent render, health `/healthz` | Render web service |
| 5 | **Edge gateway** | Read-only allowlist, CORS, caching, API-key + JWT auth, collection RBAC, presigned URLs, origin-lock header | Cloudflare Workers ×2 (`deploy/gateway/`) |
| 6 | **Static sites** | STAC Browser + webmap builds with build-time URLs, SPA fallback to `index.html` | Render static sites |
| 7 | **Chat backend** | Node (`webmap/server/chat.mjs`) or Worker (`worker.mjs`) holding the LLM key server-side | Cloudflare Worker (`deploy/chat/`) |
| 8 | **LLM** | OpenAI-compatible chat API with **tool calling** | OpenRouter (Gemini BYOK + free fallbacks) |
| 9 | **Identity provider** *(optional)* | OIDC with JWKS + a roles claim | Auth0 (tenant not yet created) |
| 10 | **Partner template** | Static hosting for one `index.html` | GitHub Pages (`.github/workflows/pages.yml`) |
| 11 | **Orchestration** *(optional)* | Long-running Dagster webserver + daemon + Postgres | Not deployed; local only |
| 12 | **Ingest runner** | A machine with Docker + GDAL that can reach the DB directly | The operator's laptop (`prod-ingest.sh`) |

Then load the platform reference for each non-default choice:
- **`references/azure.md`**: Azure mappings
- **`references/on-prem.md`**: on-prem / government data center mappings
- **`references/portability.md`**: *every* place the code assumes R2,
  Cloudflare, or OpenRouter, with the change each one needs. Read this
  whenever storage, gateway, or LLM moves off the reference stack.

**The default recommendation for mixed setups:** keep the components that are
free and portable where they are, and move what the constraints force. The
usual split:
- move the **database** and **containers** to the owned platform
- keep **R2** (zero egress, no code changes) unless data must stay
  in-country
- keep the **Cloudflare gateway and chat Workers** (free, and they front any
  origin) unless policy forbids a third-party edge

Moving storage or the gateway off Cloudflare is the expensive part. Say so
plainly, with the file list from `references/portability.md`.

## Step 3 — Write the plan

Write `deploy/plans/<env-name>.md`. It must contain **no secrets**, only
where each secret is stored. Include:

1. The filled-in component table, each row with platform, service/SKU, and
   region.
2. **Porting work** (from `references/portability.md`) with rough effort.
   This is empty for the reference stack.
3. **The ordered step list** from Step 4, with each verification command
   filled in for their hostnames.
4. **The secret inventory:** each secret, where it's stored (Render env, Key
   Vault, wrangler secret, `.env`, Vault, …), and who holds it.
5. **What they give up or gain** vs. the reference stack: cold starts,
   backups, monitoring, cost.

Ask whether to commit the plan; it's useful to whoever operates the
environment next.

## Step 4 — Execute, in this order (with a gate after each step)

The order matters. Frontends bake URLs in at build time, and the origin lock
must come *after* the gateway sends the secret.

| Step | Do | Gate (must pass before moving on) |
|---|---|---|
| 1 | **Storage:** public + private buckets, read/write token, public read on the open bucket, CORS (`deploy/r2/`) | List + put + get a test object; public GET of it works anonymously |
| 2 | **Database:** create it, allow-list the extensions, open the firewall to the operator + app tier; write the env file, including `STAC_PUBLIC_URL` (the gateway URL that links inside items will use) | `deploy/scripts/db-migrate.sh <env>` ends with `pgstac 0.9.8`; `db-check.sh <env>` connects |
| 3 | **STAC API + TiTiler containers**, env vars per `render.yaml` | `GET /_mgmt/ping` and `GET /collections` (empty) on the API; `GET /healthz` on TiTiler |
| 4 | **Data:** run the pipelines into the new storage if it isn't R2-with-existing-data, then `prod-ingest.sh <env> --all` | `db-check.sh <env>` counts; `GET /collections` lists the 6 PhilSA products + mirrored ones |
| 5 | **Gateway** (both environments), `ORIGIN` → the new API/TiTiler URLs, KV + secrets per `deploy/AUTH.md` | Gateway `/collections` = origin `/collections`; a POST returns **405** |
| 6 | **Static sites:** set `SB_catalogUrl`, `SB_titilerUrl`, `SB_catalogImage`, `VITE_STAC_API`, `VITE_TITILER`, `VITE_STAC_BROWSER`, `VITE_R2_PUBLIC_BASE`, `VITE_CHAT_API` to the *gateway* URLs, then build | Webmap loads, adds an NDVI layer, tiles render; Browser lists collections |
| 7 | **Chat:** deploy, set the LLM key, set `CHAT_ALLOW_ORIGIN` to the webmap origin | `GET <chat>/health` shows `keyConfigured: true`; a chat message adds a layer |
| 8 | **Lock the origins:** `ORIGIN_SHARED_SECRET` on the gateway *first*, then `GATEWAY_SHARED_SECRET` on TiTiler | Direct TiTiler tile URL → 403; the same tile via the gateway → 200 |
| 9 | **Auth** *(optional)*: mint a partner key; configure the OIDC provider | `mint-key.mjs --list` shows the key; with a collection restricted, its route answers with `X-API-Key` and is refused or hidden without it (see `deploy/AUTH.md` → "What the gateway actually enforces") |
| 10 | **Partner template:** point its base URLs at the gateway, then publish | The page renders PhilSA layers |

Verify each gate *yourself* where it's read-only (`curl`, `db-check.sh`), and
show the output.

## Rules

- **Confirm before every outward action**: creating resources, deploying,
  migrating, ingesting, DNS, secrets. Read-only checks are fine to run
  unprompted.
- **Never echo or commit secrets.** They go into the platform's secret store,
  `wrangler secret put`, or gitignored env files. The plan file records
  *where* each secret lives, never its value.
- **Never expose a writable STAC API.** On every platform the public API runs
  with transactions **off**, and ingest goes through `prod-ingest.sh` (a
  throwaway local API bound to the target DB).
- **Environment names:** `deploy/scripts/lib.sh` accepts only `local` and
  `prod`. For a second deployed environment, either point `prod.env` at it
  (one deployed env at a time) or add the name to the `case` in `load_env()`.
  The second option is a small, worthwhile change; propose it.
- **pgSTAC stays pinned at 0.9.8** to match the local image. Bump both
  together.
- **Keep the docs honest.** When the new environment is live, update
  `INTEGRATION_GUIDE.md` §1 base URLs (and re-embed `partner-template/guide.html`),
  the four render-param mirrors if anything moved, `README.md`, and the
  architecture diagram's platform labels.
