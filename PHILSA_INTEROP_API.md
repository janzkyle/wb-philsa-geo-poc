# PhilSA Open-Data Interoperability API — architecture & rollout

How other agencies (crop-insurance, agriculture, disaster-response, weather,
local governments) integrate PhilSA Earth-observation data into **their own**
systems, and how the webmap is positioned as a **reference consumer** that proves
the integration.

_Last updated: 2026-07-14_

---

## The core realisation: the API already exists — as open standards

There is **no bespoke "PhilSA API" to invent.** The POC already exposes its data
through three services the webmap consumes, and all three are open, standard, and
directly re-usable by any external agency with zero custom PhilSA client code:

| Service | Role | Standard | External agencies reuse it via |
|---|---|---|---|
| **`stac-fastapi-pgstac`** | **Discovery** — "what layers exist, where, when" | **STAC 1.0** + OGC API Features (an OGC/ISO-track spec) | QGIS, ArcGIS, `pystac-client` (Python), TerriaJS, any HTTP client |
| **TiTiler** | **Visualisation** — dynamic `{z}/{x}/{y}` raster tiles from the COGs | XYZ / OGC WMTS-style tiles + `/cog`, `/mosaicjson` | MapLibre, Leaflet, OpenLayers, Mapbox GL, Terria, any slippy-map lib |
| **Cloudflare R2 (public)** | **Bulk access** — the raw COGs, PMTiles, MosaicJSON | Cloud-Optimized GeoTIFF, PMTiles | GDAL/`rasterio` (`/vsicurl/`), QGIS, direct download |

**The strategic framing for stakeholders:** PhilSA is not building integrations
*for* each agency; PhilSA publishes an **open-data catalog on international
standards**, and each agency integrates it themselves against tools they already
own. This is the difference between N bespoke pipelines and one standard surface.

The webmap is the existence proof: it is *already* nothing more than an external
consumer of these three endpoints. An agency site is the same webmap pointed at
the same public endpoints, rendering PhilSA layers over that agency's own farm
parcels.

---

## Two consumer profiles (design for both)

Every hardening decision below is driven by supporting both:

### A. Browser consumers (like the webmap)
An agency embeds PhilSA layers in **their own web map** running in a user's
browser. Characteristics: cross-origin `fetch`/tile requests → **needs CORS**;
usually only wants **open** layers; no server to hold a secret → API keys are
awkward (a key in browser JS is public). This is the webmap's own profile.

In code: discover an item via STAC, drop its tiles on your map — ~10 lines of
standard MapLibre/Leaflet, no PhilSA-specific client. Copy-paste recipes (with
the current base URLs and per-layer render params) live in
**`INTEGRATION_GUIDE.md` §5a–b**; `partner-template/` is the same thing as a
runnable single-file page.

### B. Server / backend consumers
An agency pulls PhilSA data **server-side** into their own database, tiler, or
analytics pipeline. Characteristics: no browser → **CORS irrelevant**; can hold a
**secret → API keys work**; may want **bulk** COG reads and **restricted** layers;
cares about **stable URLs** and **rate limits** more than tiles.

In code: `pystac_client` search + a `rasterio` `/vsicurl` COG read — a farm's
NDVI history lands in the agency's own DB without downloading whole scenes. The
worked example (including the per-parcel zonal-stats recipe with correct nodata
handling) is **`INTEGRATION_GUIDE.md` §5c–d**.

---

## Target architecture

```
   ┌───────────── UPSTREAM: CopPhil DIAS (Copernicus PH node) ─────────────┐
   │  raw Sentinel-1/2 · EODATA S3 · JupyterLab · Data Explorer            │
   │  docs: knowledgebase.infra.copphil.philsa.gov.ph                      │
   │  audience: EO analysts/data engineers who PROCESS raw data            │
   └───────────────────────────────┬──────────────────────────────────────┘
                                    │ PhilSA pipelines process bronze→silver/gold
                                    │ (download_copphil_eodata.py → NDVI · SAR flood · …)
                                    ▼
                        ┌──────────────────── external agencies ────────────────────┐
                        │  insurance  agriculture  weather  disaster  QGIS/ArcGIS  pystac│
                        └───────┬───────────┬────────┬────────┬────────┬───────────┬────┘
                                │ browser    │        │ server-side       │
                                ▼            ▼        ▼        ▼          ▼
        ┌─────────────────────────── API gateway (edge) ───────────────────────────┐
        │  *.workers.dev · TLS · CORS · read-only · rate limit · cache · (keys) │
        │  → fronts the POC origins below (currently *.onrender.com, see render.yaml)│
        └───────┬───────────────────────────┬───────────────────────────┬──────────┘
                ▼                            ▼                           ▼
        ┌───────────────┐          ┌──────────────────┐        ┌──────────────────┐
        │ stac-fastapi  │          │     TiTiler      │        │ Cloudflare R2     │
        │  (discovery)  │◄────────►│  (raster tiles)  │───────►│  public  (open)   │
        │ philsa-stac-  │          │ philsa-titiler   │        │  private (restr.) │
        │ api.onrender  │          │  .onrender.com   │        │  reads COGs from  │
        └───────────────┘          └──────────────────┘        └──────────────────┘
                                   (public COGs direct; restricted via presigned URL)
```

**Upstream vs. this API.** CopPhil DIAS (top box) is the *raw-data-and-processing*
platform PhilSA pulls from — `download_copphil_eodata.py` authenticates against it
and downloads raw Sentinel scenes, which the pipelines turn into the derived
silver/gold products. It serves analysts who **process** data. This interop API is
the **downstream, last-mile** product: PhilSA's already-processed layers served as
STAC + tiles for agencies that just want to **consume** them, no processing. The
two are complementary layers of one stack, not alternatives.

The gateway is the **only new architectural component.** Everything behind it
already runs — the current POC origins are `philsa-stac-api.onrender.com`,
`philsa-titiler.onrender.com`, and the public R2 bucket
(`pub-17ab60a2ca7142a48ae8e2685cd853f7.r2.dev`), all defined in `render.yaml`. The
gateway is what turns those into a "governed public API" — served on
`*.workers.dev` for this POC (custom domains are a later step) — and it is where
the open/restricted split from `poc-architecture.mmd`'s Auth/Governance box
becomes real.

---

## What actually needs to change (internal POC → external product)

Ordered by leverage. Items marked ✅ are already true in the repo.

### 1. CORS — ✅ already permissive, make it explicit
Both services already default `cors_origins` to `*` (STAC-FastAPI
`config.py:213`; TiTiler `TITILER_API_CORS_ORIGINS: "*"` in `render.yaml`).
So **browser consumers work today.** The only gap is that STAC's CORS is
*defaulted*, not *declared* — a dependency bump could silently change it. Fix:
pin it explicitly in `render.yaml` (done — see the hardening changes) so
open-data CORS is a deliberate contract, not an accident.

- STAC methods must include **`POST`** (the `/search` endpoint is POST) and
  **`OPTIONS`** (browser preflight). Default already covers these.
- Keep `cors_credentials: false` for open data (no cookies) — this is what lets
  `origins: *` be safe.

### 2. Stable public URLs — the credibility gap
**This POC uses no custom domains.** The published base URLs are the gateway's
two `*.workers.dev` endpoints, now deployed:
`https://philsa-stac-gateway.philsa.workers.dev` and
`https://philsa-tiles-gateway.philsa.workers.dev` — stable, always-on (unlike the
origins), and fronting the `*.onrender.com` services. These are the canonical base
URLs in the developer docs; the webmap and partner template read them from
build-time env (`render.yaml` `VITE_STAC_API`/`VITE_TITILER`, already repointed).

- **Custom domains (`stac.philsa.gov.ph`, …) are a later, non-POC step** — the
  worker code and consumer URLs move, nothing else. Out of scope here.
- **Cold starts are the origin, not the edge.** The Cloudflare Worker never
  sleeps and its cache absorbs repeat hits, but a cache-*miss* still wakes the
  free-tier Render origin (~30–60 s). The real fix is a paid/always-on origin or
  a keep-warm ping — a domain wouldn't change it.

### 3. API gateway — the one new component
A single edge layer fronting all three services. **Built** as a Cloudflare Worker
in `deploy/gateway/` (`worker.js` + `wrangler.toml` + README); it provides:

- **Read-only enforcement** — blocks every write/transaction method at the edge
  (defense-in-depth alongside the read-only origin), so the public API can only
  ever be read.
- **API keys** for server consumers and for **restricted** collections (open
  collections stay anonymous — this is the open/restricted governance split made
  real). A key identifies the agency, not a person.
- **Rate limiting** per key / per IP so shared free-tier infra survives a bulk
  backfill by one agency.
- **Usage metrics / attribution** — who pulled what, for reporting and capacity
  planning.
- **CORS at the edge** (so the origin services don't each need to be right).

**Recommended implementation for this POC's stage: Cloudflare.** The data is
already in Cloudflare R2, so the account exists. Cloudflare provides, at the
edge, with no new server to run:
- automatic TLS on a `*.workers.dev` URL (no domain/DNS needed for the POC),
- **Rate Limiting** (native rate-limit binding) in front of the Render origins,
- **caching of tiles** (huge — TiTiler renders every tile on demand; the edge
  cache in front of the tiler collapses repeat cost),
- a lightweight per-key check against restricted paths — **built and deployed**;
  see `deploy/AUTH.md`.

Heavier alternatives if PhilSA later standardises on a full API-management
product: **APISIX** or **Kong** (self-host) — more knobs, more ops. Not warranted
at POC stage; note them in the doc as the "graduation" path.

### 4. Restricted-data path — presigned URLs
Open layers: TiTiler reads public R2 COGs directly; browsers hit public tiles.
Restricted/licensed layers (the private R2 bucket in the architecture diagram):
- STAC item `data` asset href points at the **private** bucket.
- A valid API key (via the gateway) mints a **short-lived presigned R2 URL**;
  TiTiler (or the agency's own GDAL) reads the COG through it.
- This keeps licensed imagery governed without re-hosting or copying it.

**Built** — `GET /assets/sign?url=<asset href>` on the STAC gateway, gated on the
`partner` role, capped at 15 min, and refusing to sign anything outside the
restricted prefixes so a leaked key can't proxy the whole bucket. Every signing is
logged with the principal and object key. Full detail, including how to issue and
revoke partner keys: **`deploy/AUTH.md`**.

Two follow-ups before this path is real end-to-end: the R2 API token needs to
cover `world-bank-philsa-geo-private`, and the restricted objects have to be moved
off the public `r2.dev` host (`deploy/scripts/move-assets-private.sh`). Until then
`sentinel1-flood` is restricted in the catalog and the tiler but still downloadable
directly from public R2.

### 5. Tile caching — cost & latency (do this early, it's cheap)
Per `webmap/src/lib/titiler.ts`, every tile is rendered on demand (open COG,
range-read, warp, encode). With multiple agencies hitting the same layers, an
**edge cache keyed on the full tile URL** (Cloudflare cache, or a CDN) is the
single biggest cost/latency win and needs no code change — just cache headers +
a caching gateway.

### 6. Developer enablement — docs + a sample consumer
Standards only pay off if agency developers can copy-paste. Ship:
- **An integration guide** — ✅ **built: `INTEGRATION_GUIDE.md`** (standalone,
  written for agency developers): base URLs, the collection cheat-sheet with exact
  render params, and copy-paste recipes for MapLibre, Leaflet, QGIS, and
  `pystac-client` (incl. per-parcel zonal stats). Kept separate from the CopPhil
  knowledge base — PhilSA-owned, versioned with this repo.
- **The webmap, reframed as a reference consumer** — see next section.
- Optionally a **standalone minimal agency sample page** (one self-contained
  HTML file, no build) that renders a PhilSA layer over farm parcels, as the
  "integrate in an afternoon" proof.

---

## The webmap as reference consumer

The webmap already *is* a pure external consumer of the public endpoints — it
just doesn't *say so*. To make it read as "the sample an agency could build":

- **Surface the data source.** A small "Data via PhilSA Open Data API" affordance
  that links to the STAC landing page / integration docs, so a visiting agency
  dev immediately sees *this map is drawing from an API you can also call*.
- **Treat the config endpoints as the published API contract.** `config.ts`'s
  `STAC_API` / `TITILER` / `R2_PUBLIC_BASE` are exactly the base URLs an external
  consumer needs; document them as such and point them at the gateway
  `*.workers.dev` URLs once the gateway is deployed.
- **Keep the consumer code exemplary.** `lib/stac.ts` and `lib/titiler.ts` are
  already thin, standard STAC/TiTiler clients with no PhilSA-private assumptions —
  they double as **worked examples** for agency developers. Preserve that: no
  private endpoints, no undocumented params, in the consumer path.
- **Agency overlay = the agency's own data.** The upload-GeoJSON farm-parcel flow
  (see `PCIC_WEBMAP_USE_CASES.md`) is precisely the pattern an agency follows:
  **PhilSA supplies the EO layers via the API; the agency supplies its own
  vectors** (farms, claims) and renders them together. This is the integration
  story in miniature.

---

## Rollout phases

| Phase | Deliverable | Gates |
|---|---|---|
| **0 — today** | Internal POC: STAC + TiTiler + R2 on Render, webmap consumes them; CORS already open | ✅ done |
| **1 — declare the contract** | Explicit CORS in `render.yaml`; integration docs with base URLs + MapLibre/Leaflet/QGIS/pystac recipes; webmap surfaces "Data via PhilSA API" | no infra change; docs + config only |
| **2 — front + cache (POC)** | Cloudflare Worker gateway on `*.workers.dev` (`deploy/gateway/`): read-only enforcement, CORS, edge **tile caching**, optional rate limits. **No custom domains.** | ✅ deployed on `philsa.workers.dev`; frontends + docs repointed |
| **3 — govern it** | Gateway keys for server/restricted access, usage metrics; presigned-URL path for the private R2 bucket | identity for key issuance; restricted collection tagging |
| **4 — graduate (if needed)** | Custom domains (`*.philsa.gov.ph`); full API-management (APISIX/Kong), SLAs, quotas per agency | only if adoption warrants the ops cost |

---

## Honesty flags

- **Free-tier Render origin sleeps.** The `*.workers.dev` gateway is always-on and
  its cache absorbs repeat hits, but a cache-miss still wakes the Render origin
  (~30–60 s). A custom domain would not change this — the fix is a paid/always-on
  origin or a keep-warm ping. Fine for a POC/demo; decide before a real SLA.
- **A browser API key is not a secret.** Do not gate *browser*-facing open layers
  behind a key expecting it to stay private — gate by origin/rate-limit instead.
  Keys are for **server** consumers and **restricted** data.
- **Restricted data needs the private bucket + presigned path first.** Until the
  private R2 bucket and presigned-URL flow exist (POC has only the public
  bucket), "restricted collections" are a design, not a capability.
- **STAC write access — CLOSED (was the top risk).** Prod previously ran with
  `ENABLE_TRANSACTIONS_EXTENSIONS=true` and no auth, so anyone could
  `POST/PUT/DELETE` catalog items. Now: the prod origin runs **read-only**
  (`ENABLE_TRANSACTIONS_EXTENSIONS=false` in `render.yaml`), the edge gateway
  (`deploy/gateway/`) **re-blocks** writes as defense-in-depth, and ingest moved
  off the public API to a **private, ephemeral** transactions API bound to Neon
  (`deploy/scripts/prod-ingest.sh`). Nothing writable is internet-reachable.
  Keep it that way: never re-enable transactions on a public origin.
