# Portability: what assumes Cloudflare R2, Cloudflare Workers, or OpenRouter

Most of the platform is standard: Postgres, two Docker images, two static
builds. Three things assume a vendor. This file lists every place each
assumption lives, so a plan can price the move honestly.

Re-grep before trusting the list, because code moves:

```bash
EX='--exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=dist --exclude-dir=.git --exclude-dir=.wrangler --exclude-dir=worktrees'
grep -rln $EX 'r2.cloudflarestorage' .     # S3 endpoint host
grep -rln $EX 'r2\.dev' .                   # public bucket host
grep -rln $EX 'world-bank-philsa-geo' .     # bucket names
grep -rln $EX 'openrouter.ai' .             # LLM provider
grep -rln $EX 'philsa.workers.dev\|onrender.com' .   # deployed hostnames
```

---

## 1. Object storage: Cloudflare R2

**Cheapest path:** keep R2. It works from any platform (zero egress, nothing
to change), and only creds move. Choose another store only when a constraint
forces it, such as data residency or no third-party storage.

**If moving to another S3-compatible store** (MinIO, Ceph RGW, Garage,
SeaweedFS, AWS S3): the protocol is the same, but the **endpoint host is
hardcoded** as `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`. The clean fix is
one small refactor: add an `S3_ENDPOINT` env var (default: the R2 host) and
read it everywhere below.

| Where | What assumes R2 |
|---|---|
| `pipelines/lib/r2.py` | `self.host = f"{account_id}.r2.cloudflarestorage.com"` (SigV4 client used by the Python scripts) |
| `pipelines/02-silver/*/build_*.sh` (ndvi, truecolor, sar, flood, ratio), `build_ph_admin_geoparquet.sh` | `export AWS_S3_ENDPOINT="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"` for GDAL `/vsis3` |
| `build_raster_mosaics.sh`, `build_ph_admin_pmtiles.sh`, `build_admin_search_index.py` | `aws … --endpoint-url https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` |
| `compose.viz.yml`, `compose.orchestration.yml`, `render.yaml` (TiTiler) | `AWS_S3_ENDPOINT` / `AWS_ENDPOINT_URL_S3` built from the account id |
| `deploy/gateway/lib/presign.js` | `host = ${accountId}.r2.cloudflarestorage.com` for presigned URLs |
| `deploy/gateway/lib/access.js` | Recognizes `*.r2.dev` and `*.r2.cloudflarestorage.com/<bucket>/…` URL shapes when matching restricted prefixes |
| `deploy/r2/apply-cors.sh`, `.claude/skills/collection-tier/move_assets_tier.sh` | R2 endpoint for CORS and for moving objects between buckets |
| `webmap/src/lib/titiler.ts` | Rewrites hrefs whose host ends in `.r2.dev` to `s3://<bucket>/<key>` for TiTiler |
| `stac-browser/config.js` | Rewrites R2 hrefs to `s3://<bucket>/<key>` for TiTiler. Bucket and TiTiler base come from the `SB_r2Bucket` / `SB_titilerUrl` build vars (local-dev defaults otherwise) |
| `webmap/src/config.ts` | `R2_PUBLIC_BASE` and `R2_BUCKET` defaults (overridable via `VITE_R2_PUBLIC_BASE` / `VITE_R2_BUCKET`) |

The S3 settings that matter for any store: path-style addressing
(`AWS_VIRTUAL_HOSTING=FALSE`, already set), a region (`auto` for R2;
whatever the store expects otherwise), `AWS_HTTPS`, and anonymous public read
on the open bucket.

**Item hrefs.** Published items point at `R2_PUBLIC_BASE`
(`https://pub-….r2.dev/…`). New storage means new hrefs. Re-run the silver
builders with the new base (or copy the objects), then
`prod-ingest.sh <env> --silver-only` to re-catalog. The rewrite rules in
`titiler.ts` and `stac-browser/config.js` must recognize the new public host.

**Azure Blob is *not* S3-compatible.** Moving to Blob means porting:
- every SigV4 path above: `r2.py` to SharedKey or SAS, `/vsis3` to `/vsiaz`
  with `AZURE_STORAGE_*`, `aws s3` to `azcopy` / `az storage`
- `presign.js` from SigV4 to SAS tokens
- the TiTiler env (GDAL reads `/vsiaz/`; check that the MosaicJSON backend
  supports your Azure URL scheme, or serve mosaics over HTTPS)

That's a **multi-day port**. Prefer keeping R2, or putting an S3-compatible
layer in front.

## 2. Edge gateway and chat: Cloudflare Workers

**Cheapest path:** keep both Workers. They proxy *any* HTTPS origin; moving
the API and TiTiler only changes `ORIGIN` in `deploy/gateway/wrangler.toml`
(both `[env.*.vars]`). For origins with no public inbound access (on-prem),
put **Cloudflare Tunnel** (`cloudflared`) in front of them and set `ORIGIN` to
the tunnel hostname.

**Workers-specific APIs in `deploy/gateway/worker.js`:**
- `caches.default` (edge cache)
- the `API_KEYS` **KV** binding (hashed partner keys)
- the optional `RATE_LIMITER` binding
- `scheduled()` + cron triggers (keep-warm pings to the origins)
- `ctx.waitUntil`

The policy and crypto in `lib/` are plain JS + Web Crypto.
`lib/access.js` and `lib/presign.js` already run under Node 20+; their tests
(`node --test test/*.test.mjs`) prove it. `lib/auth.js` is the same, except
that it reads keys through `env.API_KEYS.get(<hash>, "json")`. Pass any object
with that `get` shape (backed by Redis or Postgres) and it works unchanged.

**Self-hosting the gateway** means a small Node service (Hono or Express) that:
- imports `lib/*.js` unchanged
- swaps KV for Redis or a Postgres table (`mint-key.mjs` needs the same swap)
- swaps `caches.default` for nginx `proxy_cache` in front
- replaces the cron with a systemd timer or k8s CronJob, or drops it (an
  always-on origin doesn't need keep-warm)
- keeps the `X-Gateway-Auth` header injection for the TiTiler origin lock

Estimate **2–4 days** including tests. A thinner option is nginx alone:
read-only method allowlist, CORS, caching. It covers the open tier only, with
**no** API keys, RBAC, or presigning. That's acceptable only while no
collection is restricted.

**Chat:** `webmap/server/chatCore.mjs` is runtime-agnostic. Run
`node webmap/server/chat.mjs` (port `CHAT_PORT`, default 8087) in any
container instead of the Worker. Its env vars are `OPENROUTER_API_KEY`,
`GENAI_MODEL`, and `CHAT_ALLOW_ORIGIN`. Set `VITE_CHAT_API` to
`<its URL>/api/chat`.

## 3. LLM: OpenRouter

`chatCore.mjs` hardcodes `baseURL: "https://openrouter.ai/api/v1"` and fetches
`https://openrouter.ai/api/v1/models` to build the free-model fallback chain.

- **Azure OpenAI, a self-hosted vLLM/Ollama, or any OpenAI-compatible
  endpoint:** make the base URL and model list configurable (e.g.
  `LLM_BASE_URL`, `GENAI_MODEL`), and skip the OpenRouter catalog fetch when
  the base URL isn't OpenRouter. That's a small change (about half a day). The
  model **must support tool calling**; the assistant is useless without it.
- **Data governance:** with Gemini BYOK on Google's free tier, prompts may be
  used for training. That's fine for public data, not for restricted data
  (`webmap/README.md`). An owned endpoint, whether Azure OpenAI in their
  tenant or on-prem, removes that concern.

## 4. Identity: Auth0 (not yet created)

`lib/auth.js` is plain OIDC discovery + RS256 JWKS verification. Any OIDC
provider works: Keycloak (CopPhil/PhilSA), Entra ID, Auth0. Set
`AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, and `AUTH0_ROLES_CLAIM` in `wrangler.toml`
(the names say Auth0; the code doesn't care). For Entra ID, app roles arrive
in the `roles` claim. For Keycloak, map realm or client roles into a claim
with a protocol mapper.

## 5. Hostnames baked into docs and builds

Changing hosts means updating:
- `render.yaml` (frontend `VITE_*` / `SB_catalogUrl`)
- `partner-template/index.html` (the `stac` / `tiler` constants)
- `INTEGRATION_GUIDE.md` §1, then re-embedding `partner-template/guide.html`
- `deploy/gateway/wrangler.toml` (`ORIGIN`)
- `deploy/chat/wrangler.toml` (`CHAT_ALLOW_ORIGIN`)
- `webmap/.env.example`
- the narrative docs (`deploy/*.md`, `PHILSA_INTEROP_API.md`)
