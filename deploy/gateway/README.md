# PhilSA Open Data API — edge gateway

A single Cloudflare Worker (`worker.js`) that fronts the two public POC origins —
the STAC API and TiTiler (see `../../render.yaml`) — and turns them into a
governed, read-only open-data API. This is the "API gateway" component from
`../../PHILSA_INTEROP_API.md`.

## What it does

| Concern | How |
| --- | --- |
| **Read-only** | Blocks every write/transaction method at the edge. Only `GET`/`HEAD`/`OPTIONS` pass, plus `POST /search` and `POST /aggregate` (STAC's POST-based *reads*). |
| **CORS** | One consistent open-data CORS contract for browser consumers; preflights answered at the edge. `Authorization`/`X-API-Key` are allow-listed so credentialed browser calls work. |
| **Auth & governance** | Anonymous callers get the **open** tier; a partner **API key** or an **Auth0 JWT** unlocks the **restricted** tier. `/assets/sign` mints short-lived presigned R2 URLs. See **[`../AUTH.md`](../AUTH.md)**. |
| **Caching** | `GET` responses cached at the POP — tiles hard (24 h), STAC short (60 s) — so TiTiler never re-renders an identical tile for two agencies. Cache keys are **scoped by access tier**, so a privileged response can't be replayed to an anonymous caller. |
| **Rate limiting** | Optional Cloudflare rate-limit binding — per API key for credentialed callers, per client IP for anonymous ones (see `wrangler.toml`). |

Anonymous requests pay nothing for the auth layer existing: with no credential
header the worker skips principal resolution entirely — no KV read, no JWKS
fetch.

**No custom domains in this POC.** Each deploy lands on a `*.workers.dev` URL. One
worker fronts one origin, so it's deployed **twice** (STAC + TiTiler) via wrangler
environments. (Custom domains are a later, non-POC step — the worker code doesn't
change, only where it's bound.)

## Why the gateway is *not* the only thing protecting writes

Defense-in-depth. Prod also runs the origin itself read-only
(`ENABLE_TRANSACTIONS_EXTENSIONS=false` in `render.yaml`), so even a request that
reached `philsa-stac-api.onrender.com` directly — bypassing the gateway — cannot
write. The gateway's write-block is the belt; the origin setting is the
suspenders. **Neither is a substitute for the other**: without the origin setting
the raw onrender URL stays writable; without the gateway you lose CORS/caching/
rate-limiting and the future key-auth surface.

Ingest/migration therefore no longer goes over the public API at all — see
**`../DEPLOYMENT.md` → "Ingesting/migrating data into prod"**.

## Deploy (two workers, one per origin)

```bash
cd deploy/gateway
npm i -g wrangler                 # or use: npx wrangler ...
wrangler dev -e stac              # local test against the real STAC origin
wrangler deploy -e stac           # -> https://philsa-stac-gateway.<account>.workers.dev
wrangler deploy -e tiles          # -> https://philsa-tiles-gateway.<account>.workers.dev
```

Both land on `*.workers.dev` — no DNS or zone setup needed.

## Point the frontends at the gateway

Once both workers are live, update `../../render.yaml`'s frontend build vars from
the `*.onrender.com` origins to the two `*.workers.dev` URLs, then redeploy the
static sites:

- `VITE_STAC_API` and `SB_catalogUrl` → `https://philsa-stac-gateway.<account>.workers.dev`
- `VITE_TITILER` → `https://philsa-tiles-gateway.<account>.workers.dev`

The consumer code is unchanged — only the base URLs move (this is exactly what the
`DATA_SOURCE` constants in `webmap/src/config.ts` are set up for). External
agencies then integrate against these same two workers.dev URLs.

## Restricted collections (Phase 3 — built)

Open collections stay anonymous; a valid credential gates the restricted tier and
mints a short-lived presigned R2 URL for the private-bucket COG. The policy is
two `wrangler.toml` vars — `RESTRICTED_COLLECTIONS` and
`RESTRICTED_ASSET_PREFIXES` — and the code lives in `lib/`:

| File | Does |
| --- | --- |
| `lib/auth.js` | Resolves the caller: API key (hashed, in Workers KV) or Auth0 JWT (RS256 against the tenant JWKS). Both collapse into one principal. |
| `lib/access.js` | Pure policy — which routes are refused, which responses are filtered, which object keys are restricted. |
| `lib/presign.js` | SigV4 presigned GET URLs for R2, via Web Crypto (no SDK in the bundle). |
| `scripts/mint-key.mjs` | Issue / list / revoke partner API keys. |

Full operator guide, the Auth0 tenant setup, and the enforcement matrix:
**[`../AUTH.md`](../AUTH.md)**.

```bash
node --test 'test/*.test.mjs'   # policy + presigner unit tests, no account needed
```
