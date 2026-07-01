# TODO

Running task list for the PhilSA POC. Check items off as they land; the
high-level narrative ("what's next") lives in `README.md` — this is the granular
version. Keep both honest.

## Ingest

- [x] Mirror PhilSA Satellite Imagery Catalog into pgSTAC by reference
      (`mirror_philsa_catalog.py`)
- [x] Load ESRI 10 m Annual LULC COGs by reference (`load_esri_lulc.sh`)
- [x] Build PH admin-boundary GeoParquet adm0–adm4 (`ph-admin-geoparquet` skill)
- [ ] **CopPhil S3 — raw Sentinel / EODATA** (`COP`): ingest raw Sentinel-1
      (SAR) + Sentinel-2 (optical) scenes for the AOI; feeds the `clip · NDVI ·
      SAR flood` processing path
  - [x] Acquire scenes via the CopPhil API (`download_copphil_eodata.py`):
        Keycloak auth → OData search (latest S1 GRD + S2 L2A over the PH AOI) →
        token-authed download. Creds in gitignored `.env.copphil`.
  - [ ] Process raw SAFE zips → derived COGs in R2 (silver):
    - [x] Sentinel-2 NDVI COG (`02-silver/sentinel2-ndvi/build_ndvi.sh`)
    - [x] Sentinel-2 true-colour TCI COG (`02-silver/sentinel2-truecolor/build_truecolor.sh`)
    - [x] Sentinel-1 VV backscatter (dB) COG (`02-silver/sentinel1-sar/build_sar.sh`)
    - [~] **Sentinel-1 flood layer from our CopPhil S1** (`COP`) — derive an
          actual flood-extent product from the VV scenes we already ingest.
          **Built + cataloged (1 of 14 scenes):** `02-silver/sentinel1-flood/` —
          `otsu_flood.py` classifies the existing silver VV-dB COG into a Byte mask
          (1=water/0=land/2=permanent-water/255=nodata), **block-wise** for full
          ~28k×21k GRD scenes. Methods: **`sigma` (default, mean−k·std)**, `otsu`,
          `fixed`. Note: the silver SAR is *uncalibrated* 10·log10(DN²) (~25–57 dB,
          unimodal), so global Otsu just returns ~the mean — hence `sigma` is the
          robust default. Optional `--perm-water` mask + `--min-db` floor. Driven by
          `build_flood.sh` (stage from R2 silver → classify → COG → R2). Gold
          collection `sentinel1-flood` wired into `catalog_silver.py` (flood colormap
          render) + stac-browser tile rule. **One scene live in pgSTAC** (sigma k=2 →
          ~0.6% water). **Still to do:** batch the remaining 13 silver SAR scenes;
          slope masking; rigorous route — change-detection vs a dry-season reference
          (calibration · speckle · terrain-correction).
          **Complements** (not replaces) Copernicus EMS/GFM below — our own
          derived layer + the authoritative reference.
  - [x] Catalog silver COGs in pgSTAC by reference (gold,
        `pipelines/03-gold/catalog_silver.py`): S2 NDVI, S2 true-colour, S1 VV
        backscatter as STAC collections + items (asset hrefs → public R2)
    - [ ] also catalog ph-admin-boundaries GeoParquet (vector item) — follow-on
- [ ] **Copernicus EMS / GFM — flood** (`VEC`/`PUB`): the POC's **authoritative**
      flood layer (free, no partnership needed), paired with our own derived
      Sentinel-1 flood layer above. EMS Rapid Mapping delineation vectors (flood
      extent · affected-area · damage grading) → vector-to-PMTiles, tagged
      open/restricted; and/or GFM Sentinel-1 flood-extent rasters mirrored by
      reference.
- [ ] **OSM / synthetic** (`VEC`): ingest OSM features (roads · buildings · POIs)
      and/or synthetic test vectors → PMTiles
- [ ] **Earth Search** (`PUB`): query Sentinel-2 L2A asset URLs and mirror into
      pgSTAC by reference (ETL-only, mirror the Planetary Computer pattern)

## Storage — Cloudflare R2

- [x] Create the public bucket (open COGs + PMTiles) and confirm public read
- [x] Upload PH admin-boundary GeoParquet to R2 (skill already supports this)
- [ ] Create the private bucket (sensitive data + licensed imagery)
- [ ] Decide the open/restricted **sensitivity tagging** scheme on items/assets
- [ ] Presigned-URL flow for restricted assets

## Frontend

- [x] Stand up STAC Browser end-to-end against the local API
- [x] PhilSA-brand the catalog: STAC Browser (`config.js` — title, logo, favicon,
      blue accent) locked to our API only (`allowExternalAccess: false`); STAC API
      landing/docs branded via `STAC_FASTAPI_*` env in `compose.yml`
- [~] MapLibre webmap (`webmap/`, React+TS+Vite + react-map-gl): **Tier 1 open
      layers done** — adm0–adm2 PMTiles + Sentinel-2 true-colour & NDVI +
      Sentinel-1 SAR (VV) + **ESRI 10 m LULC** (discrete colormap, excluded from
      the date filter) via TiTiler, centred on Luzon. Rasters rendered as
      **per-date seamless mosaics** (MosaicJSON,
      `pipelines/02-silver/build_raster_mosaics.sh`) so a
      day's granules stitch into one continuous layer; a **single-date selector**
      (with a per-layer data-availability indicator) drives which day loads;
      per-layer collapsible legends. Still to do: restricted (authenticated)
      layers; footprint/discovery layer.
- [x] TiTiler for raster tiling (open COGs from R2 — `compose.viz.yml`, :8083).
      Restricted COGs (presigned) still to do.
- [x] Serve PMTiles — **open admin boundaries adm0–adm4 live on public R2**
      (`pipelines/02-silver/ph-admin-boundaries/build_ph_admin_pmtiles.sh`;
      r2.dev serves them with CORS + range). **One web format for both frontends:**
      the MapLibre webmap reads the `.pmtiles` directly, and the **TerriaJS
      dashboard** now reads the *same* PMTiles via its `mvt` item (Terria's
      Protomaps provider range-reads `.pmtiles` — the earlier "no PMTiles reader"
      assumption was wrong), so the per-level GeoJSON shim was retired. All admin
      levels (adm0–adm4) are **open** data, none restricted. Format strategy:
      GeoParquet = canonical source (silver), PMTiles = single web derivative. Still
      to do: other vector layers; restricted layers via presigned (separate from
      admin boundaries).
- [~] TerriaJS dashboard (`dashboard/`, TerriaMap template, terriajs 8.12.2):
      mirrors PhilSA's own stack but driven by **our STAC + TiTiler**. A
      re-runnable generator (`build_catalog_from_stac.py`) reads the live STAC API
      and emits a Terria catalog of `url-template-imagery` members tiled on the fly
      by TiTiler; same-date granules are combined into one layer per date via
      MosaicJSON. **Done:** S2 NDVI / true-colour, S1 SAR, ESRI LULC + Diwata-2
      groups; per-layer workbench legends; PhilSA branding; 2D default; info-only
      groups (skysat/planetscope); split-screen date compare. **STAC metadata is
      now surfaced** — each group carries `info` sections (About / Coverage /
      Source & licence) + a `metadataUrls` link to the STAC collection, and each
      item shows acquisition date, platform/instrument, and a thumbnail where
      present. **Admin boundaries (adm0–adm4, all open)** are in the catalog as
      `mvt` outlines streaming the **same R2 PMTiles the webmap uses** (Terria's
      Protomaps provider range-reads `.pmtiles`; click-to-read attributes), off by
      default — no more local GeoJSON. NDVI stretch aligned to the webmap
      (`-0.2…0.9`). Still to do:
  - [~] **Admin-area filter (search → fly + spotlight)** — *built; needs in-browser
        eyeball.* A custom **`LocationSearchProvider`**
        (`lib/Models/PhilSAAdminSearchProvider.ts`, registered in `index.js`,
        configured in `config.json`) searches a generated **name→bbox index**
        (`build_admin_search_index.py` → `ph_admin_index.json`, ~1,700 adm0–adm3
        units); picking a result flies the camera **and** drops a **spotlight focus
        mask** (`philsaAdminFocusMask.ts`) that dims everything outside the unit so
        the raster layers read only inside it (workbench "Focus area" item — toggle
        opacity / remove to clear; unit geometry from on-demand
        `ph_admin_geom_adm{0..3}.json`). Compiles + bundles cleanly. Still to do:
        verify render in-browser; optionally a **true raster clip** (server-side
        TiTiler polygon mask) instead of the visual dim.
  - [ ] **Tile-serving robustness** — the public `r2.dev` host has flaky DNS;
        move TiTiler to the authenticated `*.r2.cloudflarestorage.com` endpoint
        (add `boto3` to the TiTiler image + rebuild mosaics with `s3://` hrefs)
        so the dashboard isn't tied to `r2.dev` resolving. *(infra change — ask first;
        note: `catalog_silver.py` already reads COG metadata over the authenticated
        endpoint, so only TiTiler + the mosaics still depend on `r2.dev`.)*
  - [ ] **Deploy / host** the dashboard (static `gulp release` build behind a
        URL; wire `serverconfig.json` proxy + config for the hosted STAC/TiTiler,
        not just `localhost`) — *see the Deployment / hosting section below.*
  - [ ] **Daily catalog refresh (cron)** — re-run `build_catalog_from_stac.py`
        once a day so new STAC items appear in the dashboard automatically (the
        generator is idempotent, so a scheduled re-run is safe). Best tech depends
        on the deploy model above:
    - **Co-located on the compose stack (recommended for the POC):** a small
          **cron sidecar container** — base `python:3-slim` + `supercronic`
          (container-friendly cron with proper logging; plain `crond` is awkward in
          containers for env/stdout) — sharing the STAC network and the dashboard
          `wwwroot` volume, regenerating `wwwroot/init/philsa.json` in place. No
          public STAC needed; reaches `:8082` over the internal network.
    - **Single VM host:** a **systemd timer** (preferred over raw crontab for
          logging/retries via `journalctl`) running the script on a schedule.
    - **Static site built + deployed from CI (chosen):** a **GitHub Actions
          scheduled workflow** (`on: schedule`) that regenerates, commits
          `philsa.json`, and redeploys — viable once STAC is **publicly reachable**
          from the runner (delivered by the Deployment section below).
          *(low effort once hosting is settled)*
  - [ ] **Animated time-slider** — needs a time-aware service (WMS/WMTS facade)
        over the date stack; today only split-screen compare *(blocked: WMS infra)*
  - [~] **Click-to-read pixel values** — vector layers (admin boundaries) are
        click-readable now; **raster** pixel read-out still needs WMS
        `GetFeatureInfo` or a TiTiler `/cog/point` hook *(blocked: WMS infra)*
  - [ ] **Restricted/authenticated layers** in the catalog *(blocked: needs the
        private bucket + auth — see Auth & governance)*
  - [ ] Surface the **flood layers** in the dashboard (our derived S1 + EMS/GFM).
        S1 `sentinel1-flood` is now cataloged (1 scene) but not yet added to
        `build_catalog_from_stac.py`'s `RASTER` map; EMS/GFM not built yet.

## Deployment / hosting (free-tier)

Goal: lift the whole POC off `localhost` onto free-tier hosting for a shareable
demo. The stack is a managed DB + two Docker web services (STAC API, TiTiler) +
three static frontends + R2. Component → free-tier pick:

- [ ] **pgSTAC database (Postgres + PostGIS)** — pgSTAC is pure SQL schema +
      functions, so any Postgres ≥14 with PostGIS can host it via
      `pypgstac migrate`. **Neon** recommended (free tier, **no auto-pause**,
      PostGIS, branching); **Supabase** free works too (PostGIS + a nice console)
      but **pauses after ~7 days idle** and needs care with pgSTAC roles/grants.
- [ ] **STAC API (`stac-fastapi-pgstac`)** — Docker web service pointed at the
      managed Postgres. **Render** free web service (your pick) or **Fly.io** free
      allowance. Heads-up: free tiers **spin down on idle** (Render ~15 min) →
      cold start on first request; fine for a demo (optionally a keep-alive ping).
- [ ] **TiTiler** — Docker web service next to the STAC API (Render/Fly), reading
      COGs from R2 (public `r2.dev` or the authenticated endpoint — see *Tile-
      serving robustness*). Memory is the constraint: 512 MB free is borderline
      under heavy requests but OK for POC traffic.
- [ ] **Static frontends — TerriaJS dashboard, MapLibre webmap, STAC Browser** —
      build to static and host on **Cloudflare Pages** (recommended: generous free
      tier, unlimited bandwidth, **same vendor as R2**) or Netlify / Vercel /
      GitHub Pages. For the dashboard, prefer a pure-static `gulp release` relying
      on `corsDomains` + CORS headers from the hosted STAC/TiTiler, so the
      `terriajs-server` proxy isn't needed; if a proxy turns out unavoidable, run
      `terriajs-server` as a small Render service too.
- [x] **R2 object storage** — already on Cloudflare R2 free tier (10 GB).
- [ ] **Catalog refresh via GitHub Actions** (preferred) — an `on: schedule`
      workflow regenerates `philsa.json` against the **public** STAC URL (reachable
      once the STAC API is deployed above), commits it, which triggers the
      Cloudflare Pages rebuild. Supersedes the compose cron-sidecar once hosted;
      store STAC/TiTiler URLs as repo **variables** (the generator reads nothing
      secret). *(See "Daily catalog refresh" under the dashboard above.)*

Caveats to design around (none block a POC demo): free web tiers **sleep on idle**
(cold starts); Supabase free DB **pauses** on inactivity (Neon doesn't); keep
TiTiler requests light. Secrets (R2 keys) stay out of static builds — only the
server-side TiTiler needs them.

## Auth & governance

- [ ] Identity provider + token issuance
- [ ] RBAC / collection-level access control on the catalog API
- [ ] Data-sharing policy: who sees open vs. restricted
