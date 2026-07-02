# PhilSA POC — TerriaJS Dashboard

A TerriaJS dashboard for the PhilSA POC, mirroring PhilSA's existing
[Space Data Dashboard](https://spacedata.philsa.gov.ph/) stack (TerriaJS) but
driven by **our STAC catalog + TiTiler**. Built from the official
[TerriaMap](https://github.com/TerriaJS/TerriaMap) template (terriajs 8.12.2).

## How it connects to our STAC

TerriaJS 8.x has **no native STAC catalog type**, so we don't point Terria at the
STAC API directly. Instead, [`build_catalog_from_stac.py`](./build_catalog_from_stac.py)
**generates** a Terria catalog from the live STAC API: it reads each collection's
items and emits one `url-template-imagery` member per item, whose tiles are
produced on the fly by **TiTiler** (`:8083`) — the same dynamic tiler + styling
the `webmap/` app uses (NDVI `rdylgn`, SAR grayscale, LULC categorical).

```
STAC API (:8082) ──► build_catalog_from_stac.py ──► wwwroot/init/philsa.json
                                                          │ url-template-imagery
                                                          ▼
                                      TiTiler (:8083) ──► styled XYZ tiles ──► Terria
```

## Run

Prereqs: the POC's **STAC API** (`:8082`) and **TiTiler** (`:8083`) must be up
(repo root: `cd stac-fastapi-pgstac && docker compose up -d`, and
`docker compose --env-file .env -f compose.viz.yml up -d`).

```bash
cd dashboard
yarn install                 # first time only (heavy: Cesium etc.)
python3 build_catalog_from_stac.py   # (re)generate the catalog from STAC
yarn gulp dev                # build + serve + watch on http://localhost:3001
```

## Add / update a layer (config, not code)

The dashboard is **catalog-driven** — the most common change is data, not code:

- **New imagery in STAC?** Re-run `python3 build_catalog_from_stac.py` and refresh
  the browser. New collections/items appear automatically.
- **Restyle a raster collection?** Edit its entry in the `RASTER` dict at the top
  of `build_catalog_from_stac.py` (the TiTiler `style` query string), then re-run.
- **Hand-add any other source** (WMS, GeoJSON, COG, ArcGIS, …)? Add a member to the
  `catalog` array in `wwwroot/init/philsa.json` — no rebuild needed, just reload.
  See the [Terria catalog docs](https://docs.terria.io/guide/connecting-to-data/catalog-items/).

## Endpoints (override with env vars)

`STAC_API` (default `http://localhost:8082`) and `TITILER`
(default `http://localhost:8083`) are read by the generator. The Terria proxy
whitelist (`serverconfig.json`) includes `localhost` so Terria can reach both.

## What's in the catalog

Generated groups under **PhilSA POC — STAC Catalog**:

- **Tiled rasters** (TiTiler, with workbench legends): Sentinel-2 NDVI (RdYlGn),
  Sentinel-1 SAR (grayscale, dB), ESRI Land Cover (9-class categorical),
  Sentinel-2 True Colour, and **Diwata-2 SMI** true colour (by-reference public
  COG on GCS; capped to the 12 most recent scenes — raise `sample` in the
  generator to show more).
- **Administrative boundaries** (`Administrative Boundaries (PH)`): adm0 (country),
  adm1 (regions), adm2 (provinces), adm3 (cities/municipalities) and adm4
  (barangays) as `mvt` outlines, off by default — **all five levels are open data,
  none restricted**. These stream the **same PMTiles the webmap uses**, straight
  from R2 (`02-silver/ph-admin-boundaries/pmtiles/phl_adm{0..4}.pmtiles`): Terria's
  `mvt` item feeds the `.pmtiles` URL to its Protomaps imagery provider, which
  range-reads the archive — so there's no separate GeoJSON and no duplicated data
  in the repo. Vector tiles also mean adm4's ~42,000 barangays stream tile-by-tile
  (only what's in view) instead of a single multi-MB download, and dense levels
  (adm3/adm4) appear only as you zoom in (their tiles start at z4/z6). Click any
  feature for its attributes (name, P-code, area). The canonical full-resolution
  geometry stays in the admin-boundary GeoParquet (silver tier).
- **Info-only groups**: `skysat` and `planetscope` expose only thumbnails +
  cloud-hosted metadata (no public COG), so they're listed as labelled
  by-reference groups rather than map layers.

### Provenance / metadata in the workbench

The generator maps each STAC collection's metadata into Terria so users can see
what they're looking at without leaving the dashboard — **only fields that are
actually present are shown** (no empty rows, no raw JSON):

- **Group `info` sections**: *About this dataset* (STAC description), *Coverage*
  (time span + bounding area), *Source & licence* (providers, licence, keywords),
  plus `metadataUrls` links — first to the human-facing **STAC Browser**
  (`:8080`, override with `STAC_BROWSER`), then the raw STAC collection JSON.
- **Per-item description**: acquisition date, platform / instrument, GSD / cloud
  cover where available, granule count for combined per-date layers, and a
  thumbnail preview for collections that publish one (Diwata-2, SkySat,
  PlanetScope).

Re-run `build_catalog_from_stac.py` to refresh all of this from STAC.

Branding (brand bar + disclaimer) uses PhilSA colours; the initial view frames
Luzon.

## Admin-area search ("fly to a region / province / city")

The search bar includes a custom **PH admin areas** provider: type a region,
province, or city/municipality name and pick a result to fly the camera straight
to that unit. It's a local lookup — no geocoder calls — over a small generated
index (`wwwroot/data/ph_admin_index.json`, ~1,700 adm0–adm3 units with
name + bbox), produced by [`build_admin_search_index.py`](./build_admin_search_index.py)
from the canonical admin GeoParquet (barangays/adm4 are excluded to keep the list
usable). The provider is `lib/Models/PhilSAAdminSearchProvider.ts`, registered in
`index.js` and configured under `searchProviders` in `wwwroot/config.json`. To
refresh after a boundary update, re-run the index script (it reads the parquet
from R2, or a local `SRC_DIR`).

Picking a result also drops a **spotlight focus mask**: everything outside the
selected unit is dimmed so the other (raster) layers read only inside that admin
area. It's a client-side overlay — `applyAdminFocusMask`
(`lib/Models/philsaAdminFocusMask.ts`) builds a polygon of a PH-region rectangle
*minus* the unit's shape (the unit becomes a hole) and adds it as a **"Focus area"**
item in the workbench, so you can lower its opacity or remove it to clear. The
unit geometry comes from small per-level files
(`wwwroot/data/ph_admin_geom_adm{0..3}.json`, loaded on demand), also produced by
`build_admin_search_index.py`. Note it's a *visual* focus (a dim overlay), not a
true server-side raster clip — pixels outside are dimmed, not removed.

## Temporal: comparing acquisition dates

The Sentinel collections are a real multi-date series. TerriaJS can only *animate*
time-aware layers (WMS/WMTS), and our `url-template-imagery` tiles aren't
time-aware — so instead of an animated slider, use Terria's built-in
**split-screen Compare** to swipe between two dates (a capability PhilSA's current
dashboard doesn't use):

1. Add two dated items from the same collection to the workbench.
2. On one item's `⋮` menu choose **Compare** (Split Screen).
3. Put a different date on each side and drag the slider to swipe.

## AI dashboard assistant (GenAI helper)

A floating **"✦ Ask AI"** button (bottom-right) opens a chat panel that
**interprets what's currently on the map**. Click **"Explain this view"** for a
plain-language summary of the active layers, or ask free-form follow-up
questions — the answer is grounded in the metadata of whatever you have
displayed, not generic knowledge.

How it works:

- **State snapshot (client).** On every send, `captureDashboardContext`
  (`lib/Models/genai/dashboardContext.ts`) reads Terria's live model state — the
  workbench items with the STAC metadata the generator injected (platform,
  instrument, date, GSD, cloud cover, licence, providers), each layer's `info`
  sections, and the current camera extent — into a compact JSON object. It reads
  the model, **not the DOM**, so answers reflect exactly what's enabled.
- **Proxy (server, holds the key).** The browser never sees the API key. It POSTs
  `{context, messages}` to a tiny zero-dependency proxy
  (`genai-proxy/server.js`) that holds `OPENROUTER_API_KEY`, calls **OpenRouter**
  with our free-model fall-through list, and streams the reply straight back
  (SSE). The panel (`lib/Views/GenAIAssistant/GenAIAssistant.tsx`) renders the
  stream token-by-token.
- **Models (free tier, with fallback).** OpenRouter is sent a `models` array so a
  down / rate-limited model auto-falls-through to the next. **OpenRouter caps this
  array at 3 items** (more is a hard 400). Order (edit in
  `lib/Models/genai/openrouterConfig.ts` **and** the mirror in `server.js`):
  `nvidia/nemotron-3-super-120b-a12b:free` → `qwen/qwen3-next-80b-a3b-instruct:free`
  → `openai/gpt-oss-120b:free`. All `:free`; ranked for reasoning over structured
  EO metadata + open chat. (`meta-llama/llama-3.3-70b-instruct:free` is a good 4th
  choice but doesn't fit the 3-item cap.)

  Note: the top model (nemotron) is a *reasoning* model — it streams internal
  reasoning tokens first, so the panel may show "…" for a moment before visible
  text appears.

Run it (in addition to `yarn gulp dev`):

```bash
cd genai-proxy
cp .env.example .env          # then paste your key from https://openrouter.ai/keys
set -a && source .env && set +a
node server.js                # listens on http://localhost:8084
```

The client defaults to `http://localhost:8084/api/chat`; override without a
rebuild via `window.GENAI_PROXY_URL`. If the proxy is down or the key is missing,
the panel shows a friendly error instead of crashing. `.env` is git-ignored so
the key can't be committed.

The streaming path (context injection, retained follow-up history, SSE
passthrough, model-fallback order) is covered by an integration test that mocks
the upstream, so it runs without a real key: `cd genai-proxy && npm test`.

**Future (nice-to-have):** feed **TiTiler `/cog/point` / `/statistics`** values
for the current view into the context so the assistant can interpret *actual
pixel values* — which would also close the "no click-to-read pixel values" gap
below.

## Known gaps (POC)

- **No animated time-slider.** Deliberate — a true slider would need a custom
  time-aware service (WMS/WMTS facade) over the date stack; out of scope for the
  POC. Date comparison is covered by split-screen above.
- **No click-to-read pixel values for rasters.** Vector layers (admin boundaries)
  are click-readable, but raster pixel read-out needs WMS `GetFeatureInfo` or a
  TiTiler `/cog/point` hook; legends convey the value ranges instead.
- **Admin boundaries are generalised for display.** The PMTiles are tippecanoe-
  generalised per zoom for fast rendering — the canonical, full-resolution geometry
  stays in the admin GeoParquet (silver tier).
- **Admin-area focus is a visual mask, not a raster clip.** Picking an admin area
  flies the camera there and dims everything outside it (spotlight overlay); the
  raster pixels outside are dimmed, not actually clipped/removed. A true clip would
  need server-side masking in TiTiler.
