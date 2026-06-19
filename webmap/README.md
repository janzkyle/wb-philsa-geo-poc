# PhilSA POC — webmap

Tier 1 map-first viewer (React + TypeScript + Vite + react-map-gl/MapLibre).

## What it shows

- **Admin boundaries** (adm0 country, adm1 regions, adm2 provinces) — vector
  outlines served as **PMTiles straight from public R2** via the `pmtiles://`
  protocol (no tile server). Built by
  `../pipelines/02-silver/ph-admin-boundaries/build_ph_admin_pmtiles.sh`.
- **Sentinel-2 True Colour**, **Sentinel-2 NDVI**, and **Sentinel-1 SAR (VV)** —
  silver COGs tiled on the fly by **TiTiler**. Each acquisition date is served as
  a **per-date MosaicJSON** (`../pipelines/02-silver/build_raster_mosaics.sh`) so that day's
  overlapping/partial granules stitch into one continuous, seamless layer instead
  of separate tilted footprints. The webmap discovers the available dates from
  the **STAC API** and builds the `/mosaicjson` tile URLs itself; NDVI gets a
  server-side rescale + colormap and SAR a grayscale rescale (both are
  single-band float32 and render black/flat otherwise).

Layer toggles and a **single-date selector** (dropdown + ◀ ▶ steppers over the
available acquisition dates) are in the panel; the map shows that one day's
mosaic per layer. Each raster layer carries a **data-availability indicator** —
a green dot when that collection has imagery on the selected date, grey + "no
data" when it doesn't. The map opens over Luzon where coverage overlaps.

> Note: the imagery still appears as separate patches where Sentinel-2 only made
> partial overpasses — the mosaic removes seams between *adjacent* same-day
> granules but can't invent pixels the satellite never captured.

## Run

```bash
# 1. catalog API (item discovery) — from repo root
cd ../stac-fastapi-pgstac && docker compose up -d      # :8082

# 2. raster tiler (Sentinel COGs) — from repo root
cd .. && docker compose --env-file .env -f compose.viz.yml up -d   # :8083

# 3. the webmap
npm install
npm run dev            # http://localhost:5173
```

Admin boundaries load even if the API/TiTiler are down (they come from public
R2). The raster layers need both `:8082` (discovery) and `:8083` (tiles).

## Config

Endpoints default to localhost; override via `.env` (see `.env.example`) or the
`VITE_STAC_API` / `VITE_TITILER` / `VITE_R2_PUBLIC_BASE` env vars. Layer
definitions live in `src/config.ts`.
