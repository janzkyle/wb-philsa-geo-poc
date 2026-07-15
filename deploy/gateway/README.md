# PhilSA Open Data API — edge gateway

A single Cloudflare Worker (`worker.js`) that fronts the two public POC origins —
the STAC API and TiTiler (see `../../render.yaml`) — and turns them into a
governed, read-only open-data API. This is the "API gateway" component from
`../../PHILSA_INTEROP_API.md`.

## What it does

| Concern | How |
| --- | --- |
| **Read-only** | Blocks every write/transaction method at the edge. Only `GET`/`HEAD`/`OPTIONS` pass, plus `POST /search` and `POST /aggregate` (STAC's POST-based *reads*). |
| **CORS** | One consistent open-data CORS contract (`*`, no credentials) for browser consumers; preflights answered at the edge. |
| **Caching** | `GET` responses cached at the POP — tiles hard (24 h), STAC short (60 s) — so TiTiler never re-renders an identical tile for two agencies. |
| **Rate limiting** | Optional Cloudflare rate-limit binding, per client IP (see `wrangler.toml`). |

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

## Later: restricted collections (Phase 3)

The `API_KEYS` hook in `worker.js` is where per-key auth for the private/licensed
tier goes: open collections stay anonymous; a valid key gates restricted paths
and mints a short-lived presigned R2 URL for the private-bucket COG. Not needed
until the private bucket exists.
