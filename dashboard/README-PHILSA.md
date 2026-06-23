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
- **Info-only groups**: `skysat` and `planetscope` expose only thumbnails +
  cloud-hosted metadata (no public COG), so they're listed as labelled
  by-reference groups rather than map layers.

Branding (brand bar + disclaimer) uses PhilSA colours; the initial view frames
Luzon.

## Temporal: comparing acquisition dates

The Sentinel collections are a real multi-date series. TerriaJS can only *animate*
time-aware layers (WMS/WMTS), and our `url-template-imagery` tiles aren't
time-aware — so instead of an animated slider, use Terria's built-in
**split-screen Compare** to swipe between two dates (a capability PhilSA's current
dashboard doesn't use):

1. Add two dated items from the same collection to the workbench.
2. On one item's `⋮` menu choose **Compare** (Split Screen).
3. Put a different date on each side and drag the slider to swipe.

## Known gaps (POC)

- **No animated time-slider.** Deliberate — a true slider would need a custom
  time-aware service (WMS/WMTS facade) over the date stack; out of scope for the
  POC. Date comparison is covered by split-screen above.
- **No click-to-read pixel values.** Raster feature-info needs WMS `GetFeatureInfo`
  or a TiTiler `/cog/point` hook; legends convey the value ranges instead.
