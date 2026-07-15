# Partner Agency starter template

A **forkable, single-file** starting point for an agency (PCIC, DA, PAGASA,
NDRRMC, an LGU…) that wants its own web map showing **PhilSA's satellite layers
under its own data**. Not a demo to admire — a scaffold to clone and make yours.

It's one `index.html` with no build step: open it in a browser and it works.

## Run it

```bash
# any static server works; e.g.
python3 -m http.server -d partner-template 8000
# then open http://localhost:8000
```

Or just double-click `index.html` (the CDN MapLibre + PhilSA endpoints are all
remote, so `file://` works too).

## Make it yours — two edits

Both are at the top of `index.html`, clearly marked:

1. **`MY_DATA`** — ships as `null` (the starter shows PhilSA's layers only). Set
   it to your own GeoJSON FeatureCollection (farms, assets, claims, road
   segments…) and it's drawn on top of the satellite layers. That's what turns
   this into *your* agency's map.
2. **`PHILSA`** — the STAC + tiler base URLs. Leave as-is to use the current
   endpoints; if PhilSA gives you gateway URLs (`…workers.dev`), swap only the
   hosts.

Everything else (layer picker, per-date selection, the mosaic-or-COG tile logic,
opacity) already works and needs no changes.

## What it demonstrates

- Discovering PhilSA layers and dates via **STAC** (`/collections`, `/search`).
- Rendering them as **tiles** through TiTiler — with the exact render params per
  layer, so it looks identical to the PhilSA webmap.
- Drawing **your own vectors on top** (via `MY_DATA`) — the whole integration
  pattern in ~40 lines of real logic. The `MY_DATA` block in `map.on("load")` is
  also the hook where you'd wire a parcel-click popup showing your attributes, or
  a per-parcel zonal-stats call to your backend (recipe in the integration
  guide).

## Where to go deeper

- **`../INTEGRATION_GUIDE.md`** — the full developer guide: every collection's
  render params, Leaflet/QGIS/Python recipes, per-parcel zonal statistics, and the
  rules of the road (read-only, rate limits, attribution, the flood-is-a-proxy
  caveat).
- **The PhilSA webmap** — the full-featured reference app if you want to see the
  layers in a richer UI before wiring your own.

## Notes

- **No PhilSA key needed** for these open layers; the endpoints are read-only.
- **Cold starts:** the free-tier services sleep after idle — the first tile
  request can take ~30–60 s. The page shows a "loading…" status; just wait.
- **CDN vs bundling:** this template loads MapLibre from a CDN for zero-setup. If
  your agency bundles its frontend, install `maplibre-gl` from npm instead and
  drop the two `<script>`/`<link>` CDN tags.
- **Basemap:** OpenStreetMap raster tiles, fine for a template. Swap for your
  agency's preferred basemap in the `style` block.
- **Mosaic fast-path & R2 CORS:** for a date with a published per-date mosaic the
  page prefers it (one tile source); it probes the mosaic with a browser `HEAD`
  first. The public R2 bucket doesn't currently send CORS headers, so that probe
  is blocked in the browser and the page falls back to rendering the date's
  individual COGs — correct, just a few more sources. Run
  `deploy/r2/apply-cors.sh` (PhilSA side, one-time) to add a read CORS policy to
  the bucket and activate the single-source fast-path; tiles themselves render
  either way.
