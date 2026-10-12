# Deploying on Azure

How each component maps onto Azure, and the traps specific to doing so. Read
`portability.md` first for anything that moves off Cloudflare or OpenRouter.

**Recommended shape:** a hybrid.
- **On Azure:** the database, the API, TiTiler, and the static sites.
- **Kept on Cloudflare:** R2 storage and the two gateway Workers plus the chat
  Worker. Point the gateway's `ORIGIN` at the Azure URLs. This needs zero code
  changes.

A full Azure move (Blob storage, a self-hosted gateway) is possible but is the
multi-day port described in `portability.md`. Recommend it only when policy
requires it.

**Region:** there may be no Philippines region. Use the closest available one,
likely **Southeast Asia (Singapore)**, and confirm what their subscription
offers. Keep the DB and the containers in the same region.

## Component mapping

| Component | Azure service | Notes |
|---|---|---|
| Database | **Azure Database for PostgreSQL – Flexible Server** | Burstable tier is enough for a by-reference catalog |
| STAC API, TiTiler | **Azure Container Apps** (+ Azure Container Registry) | Same Dockerfiles as Render |
| Static sites | **Azure Static Web Apps** (or Blob static website + Front Door) | Build in GitHub Actions / Azure DevOps |
| Chat | Keep the Cloudflare Worker, *or* a Container App running `node webmap/server/chat.mjs` | |
| LLM | Keep OpenRouter, *or* **Azure OpenAI** in their tenant | Azure OpenAI needs the `chatCore.mjs` base-URL change (`portability.md` §3) |
| Identity | **Microsoft Entra ID** (OIDC) | App roles arrive in the `roles` claim; set `AUTH0_ROLES_CLAIM=roles` |
| Secrets | **Key Vault**, referenced from Container Apps secrets | |
| Storage | Keep **R2** | Blob is not S3-compatible (`portability.md` §1) |
| Dagster *(optional)* | Container Apps (webserver + daemon) or a small VM | Run storage in a `dagster` DB on the same server |

## Database: Flexible Server

1. Create the server with a PostgreSQL major version the pgSTAC 0.9.8
   migration supports (current versions are fine).
2. **Allow-list the extensions.** Server parameters → `azure.extensions` →
   `POSTGIS`, `BTREE_GIST`, `UNACCENT`. pgSTAC's migration creates all three
   and fails if any is missing.
3. **Networking:**
   - add a firewall rule for the operator's IP (migrations and ingest run from
     their machine)
   - allow access from the Container Apps environment, via "Allow Azure
     services" or VNet integration (preferred for production)
4. **Connect directly on port 5432**, not the built-in PgBouncer on 6432. The
   migration needs a real session for `SET ROLE`.
5. TLS is enforced by default, which matches the scripts (`sslmode=require`).
6. **Roles:** the admin user is not a superuser, but it can create roles. If
   `db-migrate.sh` fails on `SET ROLE pgstac_admin`, run
   `GRANT pgstac_admin, pgstac_ingest, pgstac_read TO <admin_user>;` and
   re-run. The migration is idempotent.
7. Fill `deploy/environments/prod.env` (or a new env name; see the
   environment-names rule in `SKILL.md`), then run `db-migrate.sh` and
   `db-check.sh`.

## Containers: Container Apps + ACR

Build locally and push. `az acr build` can't use a Dockerfile that sits
outside its build context, and the STAC API's does:

```bash
ACR=<registry>.azurecr.io; TAG=$(git rev-parse --short HEAD)
az acr login -n <registry>
docker build -f deploy/stac-api/Dockerfile -t $ACR/philsa-stac-api:$TAG stac-fastapi-pgstac
docker build -t $ACR/philsa-titiler:$TAG deploy/titiler
docker push $ACR/philsa-stac-api:$TAG && docker push $ACR/philsa-titiler:$TAG
```

On Apple Silicon, add `--platform linux/amd64` to both builds.

| App | Target port | Env (copy from `render.yaml`) | Health probe |
|---|---|---|---|
| `philsa-stac-api` | **8080** (the Dockerfile's CMD; Render overrides it with `$PORT`) | `PG*` (+ `PGSSLMODE=require`), `ENABLE_TRANSACTIONS_EXTENSIONS=false`, `DB_*_CONN_SIZE`, `CORS_ORIGINS=*`, `CORS_METHODS=GET,POST,OPTIONS`, branding vars | `/_mgmt/ping` |
| `philsa-titiler` | **8000** (`PORT`, set in its Dockerfile) | R2 creds + `AWS_S3_ENDPOINT` / `AWS_ENDPOINT_URL_S3`, GDAL vars, `TITILER_API_CORS_ORIGINS=*`, `TITILER_MAX_CONCURRENT_RENDERS`, `GATEWAY_SHARED_SECRET` (step 8 only) | `/healthz` |

- **Scale-to-zero means cold starts.** Container Apps defaults to min
  replicas 0. Set **min replicas = 1** on both apps for an always-on demo;
  that's the main cost lever.
- **Sizing:** each TiTiler render peaks around 180 MB. At 1 GiB, keep
  `TITILER_MAX_CONCURRENT_RENDERS=2`, and raise both together.
- **Secrets:** use Container Apps secrets, backed by Key Vault references, for
  `PGPASSWORD`, the R2 keys, and `GATEWAY_SHARED_SECRET`.
- **CI:** a GitHub Actions workflow that builds, pushes, and runs
  `az containerapp update --image …` on changes to `stac-fastapi-pgstac/**`,
  `deploy/stac-api/**`, or `deploy/titiler/**` reproduces Render's
  `buildFilter`.

## Static sites: Static Web Apps

Two SWA resources (webmap, STAC Browser), built by GitHub Actions:

- **Checkout needs submodules** (`actions/checkout` with `submodules: true`),
  because STAC Browser *is* a submodule.
- Webmap: `app_location: webmap`, `output_location: dist`, with the `VITE_*`
  vars set as build env pointing at the **gateway** URLs.
- STAC Browser: `app_location: stac-browser`, `output_location: dist`, build
  env `SB_catalogUrl=<stac gateway URL>`, `SB_titilerUrl=<tiles gateway URL>`,
  and `SB_catalogImage=<browser URL>/philsa-logo.png` (plus `SB_r2Bucket` if the
  bucket name changed). Unset, map previews and the logo point at localhost.
- **SPA fallback:** add `staticwebapp.config.json` with
  `{"navigationFallback": {"rewrite": "/index.html"}}` to each build output.
  This replaces Render's `/* → /index.html` rewrite.
- Then add the webmap's SWA origin to `CHAT_ALLOW_ORIGIN` on the chat backend.

## Ingest

`deploy/scripts/prod-ingest.sh` works unchanged. It runs the ephemeral write
API in Docker on the operator's machine, bound to Flexible Server through the
firewall rule from the database section. Run it from a machine with GDAL and
the R2 creds (for `--with-silver`).

## What changes vs. the reference stack
- **Gained:** an owned tenant, Entra ID, Key Vault, no 15-minute sleep (with
  min replicas = 1), and the option of Azure OpenAI for data governance.
- **Costs money:** Flexible Server and always-on Container Apps aren't free.
  Have them check current pricing for their region and SKU.
- **Operated by them:** backups (Flexible Server has automatic backups; set
  the retention), monitoring (Container Apps logs → Log Analytics), and
  certificate and domain setup if they use custom domains.
