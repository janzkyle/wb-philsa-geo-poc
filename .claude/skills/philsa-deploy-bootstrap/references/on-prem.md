# Deploying on-prem / in a government data center

How each component maps onto servers PhilSA runs itself, typically Linux VMs
with Docker. Read `portability.md` first for anything that moves off
Cloudflare or OpenRouter.

**Decide one question first: what network access do the servers have?**

| Situation | Recommended shape |
|---|---|
| Outbound internet OK, no inbound | Origins on-prem, reached through **Cloudflare Tunnel**. Keep the gateway and chat Workers and keep R2. Zero code changes. |
| Inbound + outbound OK | As above, or expose the origins through their own reverse proxy and keep the Workers in front. |
| Data must stay on-prem | Self-hosted S3-compatible storage + a self-hosted gateway (`portability.md` §1–2). Expect real porting work. |
| Air-gapped / no outbound | Same as above, plus a self-hosted LLM, plus a plan for getting data in (see "Outbound dependencies"). |

## Component mapping

| Component | On-prem choice | Notes |
|---|---|---|
| Database | `ghcr.io/stac-utils/pgstac:v0.9.8` container (same image as local) or a managed internal Postgres with `postgis`, `btree_gist`, `unaccent` | Persistent volume + **backups are now theirs** |
| STAC API | `deploy/stac-api/Dockerfile` (context `stac-fastapi-pgstac/`), port 8080 | `ENABLE_TRANSACTIONS_EXTENSIONS=false` |
| TiTiler | `deploy/titiler/Dockerfile`, port 8000 | Size RAM to `TITILER_MAX_CONCURRENT_RENDERS` × ~180 MB + headroom |
| Static sites | Built `webmap/dist` + `stac-browser/dist`, served by the reverse proxy | SPA fallback to `index.html` |
| Reverse proxy + TLS | **Caddy** (automatic TLS) or nginx | Their PKI or Let's Encrypt |
| Chat | Container running `node server/chat.mjs` from `webmap/` | Or keep the Worker |
| Storage | Keep R2, or **S3-compatible**: Ceph RGW, Garage, SeaweedFS, MinIO | Check the store's current licensing and support status before committing (MinIO's community edition has changed its terms) |
| Gateway | Keep Workers + Tunnel, or self-host (`portability.md` §2) | |
| LLM | OpenRouter (needs outbound), or vLLM/Ollama with a **tool-calling** model | Self-hosted needs the base-URL change |
| Identity | PhilSA/CopPhil **Keycloak** | Plain OIDC; set the roles claim via a protocol mapper |
| Dagster *(optional)* | `compose.orchestration.yml` on the same host | Already compose-based |

## A production compose file

There's no prod compose file in the repo yet. Write `deploy/onprem/compose.yml`
modeled on `stac-fastapi-pgstac/compose.yml` + `compose.viz.yml`, with these
differences from local dev:

- `database`: the pgSTAC image, a **named volume**, **not** published to
  `0.0.0.0`. Bind it to a LAN IP or the internal network only, and set a
  real password.
- `api`: built from `deploy/stac-api/Dockerfile` (the pinned prod deps, not
  the submodule's dev image). Set `ENABLE_TRANSACTIONS_EXTENSIONS=false` and
  take the env from `render.yaml`'s `philsa-stac-api`.
- `titiler`: built from `deploy/titiler`, env from `render.yaml`'s
  `philsa-titiler`, storage creds from an env file outside git.
- `chat`: a `node:22-slim` image, `webmap/` copied in, `npm ci`, run
  `node server/chat.mjs`. Set `OPENROUTER_API_KEY`, `CHAT_ALLOW_ORIGIN`,
  `CHAT_PORT`.
- `proxy`: Caddy serving `/` → webmap dist, a second host or path →
  STAC Browser dist, and reverse-proxying to `api:8080` and `titiler:8000`
  (or leave those to the Tunnel).
- `restart: unless-stopped` and healthchecks (`/_mgmt/ping`, `/healthz`) on
  everything.

Build the static sites with the **public** URLs baked in (`VITE_*`,
`SB_catalogUrl`). They're build-time values.

## Cloudflare Tunnel (no inbound ports)

1. Install `cloudflared` on the host and create a tunnel in the Cloudflare
   account that owns the Workers.
2. Route two hostnames to `http://localhost:8080` (API) and
   `http://localhost:8000` (TiTiler).
3. Set those hostnames as `ORIGIN` in `deploy/gateway/wrangler.toml`
   (`[env.stac.vars]` / `[env.tiles.vars]`) and redeploy both gateway
   environments.
4. Lock the origins as usual (SKILL.md step 8). The `X-Gateway-Auth` check in
   TiTiler still applies behind the tunnel.

Tunnel hostnames need a zone (domain) on that Cloudflare account; check that
before promising this path.

## Ingest: the two traps

`prod-ingest.sh` runs the throwaway write API **inside a Docker container**
and passes `PGHOST` into it:

- **`PGHOST=localhost` means the container itself, not the host.** Don't use
  it, even through an SSH tunnel. Use the DB host's LAN IP. Or run
  `prod-ingest.sh` on the DB host with Postgres bound to the host's IP, and
  point `PGHOST` at that IP.
- **SSL is forced.** `prod-ingest.sh` defaults to `PGSSLMODE=require`, and
  `db-migrate.sh` appends `sslmode=require`. For an internal Postgres without
  TLS, either enable TLS (preferred) or:
  - set `PGSSLMODE=disable` in the env file, and
  - set `PGSTAC_MIGRATE_URL` (a full DSN with `sslmode=disable`), which
    overrides the migration DSN.

## Outbound dependencies (for firewall allowlists)

Even an "on-prem" deployment talks to these unless they're replaced:

| Host | Used by |
|---|---|
| `stac.infra.copphil.philsa.gov.ph` | PhilSA mirror (ingest time) |
| CopPhil OData + Keycloak + `eodata` download hosts | Bronze downloads |
| `lulctimeseries.blob.core.windows.net` | ESRI LULC: loader *and* TiTiler/browser at view time (by reference) |
| `data.humdata.org` / HDX | Admin boundaries (build time) |
| `openrouter.ai` | Chat |
| `*.r2.cloudflarestorage.com`, `pub-*.r2.dev` | If R2 is kept |
| `ghcr.io`, Docker Hub, npm, PyPI | Builds |

By-reference collections (the mirror, ESRI) are browsed by **clients**
directly from upstream. An air-gapped user network can list them but can't
render their pixels.

## What changes vs. the reference stack
- **Gained:** data residency, no third-party dependency for the core, no
  free-tier sleep.
- **Now theirs:** OS patching, Docker updates, Postgres backups and restore
  tests (`pg_dump` nightly at minimum), TLS renewal, monitoring and alerting,
  log retention, and capacity for TiTiler render bursts.
