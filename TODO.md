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
    - [~] **Sentinel-1 VH/VV cross-ratio (radar vegetation index)** — the
          "SAR fallback index" the cloud-guardrails item (Frontend section)
          asks for: a single thresholdable band, VH−VV in dB
          (`02-silver/sentinel1-ratio/build_ratio.sh`; both pols are already
          in the bronze `1SDV` zips). VH (volume scattering) rises with crop
          canopy → reads "up = more crop" like NDVI but through monsoon
          cloud — post-plant confirmation + trigger input. The ratio also
          cancels the per-scene gain of the uncalibrated dB backscatter, so
          a **fixed stretch reads consistently scene-to-scene** (the SAR
          readability fix, done upstream — no colormap slider needed).
          Caveats: per-pol calibration LUTs don't cancel exactly; per-pixel
          ratio speckle is noisier (zone-level averaging handles it); NOT a
          calibrated/validated crop product. **Built + verified (2026-07-11,
          1 of 14 scenes):** full chain live for the 2026-07-07 S1D scene —
          silver COG (1.8 GB), gold collection `sentinel1-ratio` (ylgn render,
          stretch −14…−2 dB = measured p2–p98; values land in the physical
          VH−VV range, confirming the gain cancellation), stac-browser tile
          rule, Dagster asset `silver/sentinel1_ratio` (auto-joins
          `copphil_chain_refresh`), webmap layer + legend + chat-assistant
          entry (verified in-browser: panel, date pick, tiles, legend).
          **Still to do:** batch the remaining scenes (`build_silver.py
          --only ratio`; ~2 GB Float32 COG per scene — mind R2 usage),
          per-date mosaics.
  - [x] Catalog silver COGs in pgSTAC by reference (gold,
        `pipelines/03-gold/catalog_silver.py`): S2 NDVI, S2 true-colour, S1 VV
        backscatter as STAC collections + items (asset hrefs → public R2)
    - [ ] also catalog ph-admin-boundaries GeoParquet (vector item) — follow-on
- [ ] **CopPhil S3 — Sentinel-3 drought / heat-stress** (`COP`): the insurance-facing
      complement to the S1 flood + S2 NDVI layers. Ingest SLSTR LST
      (`SL_2_LST`, land-surface temperature → drought/heat-stress index) and
      OLCI land (`OL_2_LFR`, ~300 m near-daily vegetation — fills S2's monsoon
      cloud gaps) → derive LST/OTCI COGs (silver) → catalog in pgSTAC (gold).
      Nationwide daily coverage is cheap (~1 GB/day raw, checked 2026-07-07),
      so a rolling latest-N-dates retention works as-is — unlike raw S1/S2.
- [ ] **Copernicus DEM — GLO-30** (`PUB`): elevation layer the S1 flood path
      already wants (slope masking + terrain correction, above) plus
      flood/landslide hazard context. Source the AWS Open Data GLO-30 tiles by
      reference (or clip a PH mosaic COG into R2) — **not** from CopPhil: its
      `COP-DEM` collection is an empty shell (0 products via both STAC and
      OData, checked 2026-07-07).
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
- [x] Fix metadata (2026-07-13): all catalog records now pass STAC schema
      validation (stac-node-validator). Loaders emit providers, summaries,
      item_assets, classification classes, `processing:lineage`, and
      `derived_from`/`via` provenance links; mirror normalizes upstream
      `eo:bands.common_name` to the EO vocabulary
- [ ] Report upstream to PhilSA: their catalog's `eo:bands.common_name` values
      (`red-edge`, `coastal_blue`, `green_i`) are outside the EO-extension
      vocabulary and fail STAC validation (our mirror normalizes them on ingest)
- [ ] Use uv package manager for the environment. Use uv for all python scripts

## Geospatial AI

Two distinct tracks. **Pipeline models** generate data products (this section);
the **webmap chat assistant** only *drives the display* (see Frontend) and stays
a general tool-calling LLM — geospatial smarts belong in the pipeline + STAC
tools, not in the chat model's weights.

- [ ] **Foundation-model flood upgrade** (silver): augment `otsu_flood.py`'s
      sigma/otsu proxy with a geospatial foundation-model fine-tune run as a
      Dagster asset over the existing silver VV COGs → same Byte-mask COG output
      → same `sentinel1-flood` gold cataloging (webmap needs no changes).
      Candidates (flood benchmark, arXiv:2511.01990): **Prithvi-EO-2.0** — best
      on Sentinel-1 (0.57 mIoU), off-the-shelf Sen1Floods11 flood fine-tune;
      **Clay** — 26M params (~3× faster than Prithvi's 650M), best few-shot
      (0.64 mIoU from 5 optical images). Harness: **TerraTorch** (or TorchGeo).
      Expectation-setting: cross-region S1 flood mIoU ≈ 0.5 — this
      *complements*, never replaces, the authoritative Copernicus EMS/GFM layer.
- [ ] **TerraMind S1→S2 synthesis** (exploratory): generate optical-like views
      from SAR for cloud-covered typhoon scenes (any-to-any generation, S1→S2
      MAE ≈ 0.07) — high demo value for PH monsoon season, but label outputs
      clearly as *synthetic imagery*.
- [ ] **Clay embeddings for catalog discovery** (later): per-scene embeddings →
      "find scenes like this" / semantic search over pgSTAC.
- [x] **AI chat control of the webmap** — general LLM + tool calling over STAC;
      see Frontend → *MapLibre webmap (AI-first rebuild)*.

## Orchestration — Dagster

- [x] **Dagster layer over `pipelines/`** (`pipelines/orchestration/`): every
      ingest/transform/catalog script wrapped as a software-defined **asset** via
      Pipes subprocesses (scripts stay standalone + unmodified; their env/CLI
      params surface as run config). The medallion tiers form the asset graph —
      11 assets, bronze → silver → gold lineage — giving run history, backfills,
      and a manual-run/trigger UI. Covers both asks: **one-time/manual** runs
      (UI "Materialize" or `dagster asset materialize`) and a **daily update
      check** (`copphil_new_scene_sensor` polls CopPhil OData hourly and only
      fires the bronze→silver→gold `copphil_chain_refresh` job on new scenes;
      `copphil_daily_schedule` 06:00 Asia/Manila is the idempotent fallback —
      **both ship OFF**, enable in the UI). Run/event storage = a `dagster` DB on
      the existing pgSTAC Postgres; `compose.orchestration.yml` runs the
      webserver (UI :3030) + daemon on the pgSTAC network. See
      `pipelines/README.md` → *Orchestration (Dagster)*.
  - [ ] Add `tippecanoe` + `aws` CLI to the Dagster image so
        `silver/ph_admin_pmtiles` and `silver/raster_mosaics` run in-container
        (today they run best from the host).
  - [ ] Fold the dashboard's `build_catalog_from_stac.py` daily refresh (see
        Frontend → *Daily catalog refresh*) into a Dagster asset/schedule instead
        of a separate cron — one orchestrator for the whole POC.

## Storage — Cloudflare R2

- [x] Create the public bucket (open COGs + PMTiles) and confirm public read
- [x] Upload PH admin-boundary GeoParquet to R2 (skill already supports this)
- [ ] Create the private bucket (sensitive data + licensed imagery)
- [ ] Decide the open/restricted **sensitivity tagging** scheme on items/assets
- [ ] Presigned-URL flow for restricted assets

## Frontend — MapLibre webmap (ACTIVE track)

**Decision (2026-07-10): the webmap is the single active frontend.** It owns the
AI chat layer, the whole insurance-alignment roadmap targets it, and it deploys as a
plain static Vite build. The TerriaJS dashboard is **frozen at demoable** (see
its own section below) as the "integrates with PhilSA's existing Terria stack"
exhibit — no new feature work there.

- [~] **MapLibre webmap (`webmap/`, AI-first rebuild)** — React+TS+Vite +
      react-map-gl/MapLibre + **Zustand + Vercel AI SDK**, replacing the Tier 1
      webmap (old version preserved in git history). Architecture: **one
      serializable layer store, two drivers** — a manual layer panel (browse
      collections, pick an acquisition date, legends, opacity) and a **chat
      assistant** whose client-side tools mutate the *same* store:
      `list_collections` · `resolve_region` (name→bbox from the R2
      `ph_admin_index.json` the dashboard search already uses) · `search_catalog`
      (pgSTAC `/search`; on zero hits reports each collection's nearest available
      dates) · `add_layers` / `remove_layers` / `update_layer` · `set_view`.
      "Show flood data for Central Luzon, first week of June" → resolve → search
      → add → zoom. Rasters via TiTiler — per-date **MosaicJSON when present**,
      falling back to per-item COG tiles (flood has no mosaics yet); admin
      outlines stream the same R2 PMTiles as before; per-layer legends kept.
      Chat backend: `webmap/server/chat.mjs` (Node, OpenRouter via the AI SDK;
      `OPENROUTER_API_KEY` in the repo-root `.env`). Models: free-first —
      default `qwen/qwen3-coder:free` (`GENAI_MODEL` overrides), with automatic
      fallback through tool-capable free models fetched live from the
      OpenRouter catalog when a stream errors before producing output. Still
      to do: **deck.gl overlay** (GPU date-range scrubbing via
      `DataFilterExtension`, GeoArrow vector layers); restricted (authenticated)
      layers; footprint/discovery layer; surface EMS/GFM flood once ingested.
- [x] **GeoJSON upload → zoom-to-extent + raster clip** (2026-07-10): uploading
      a local file already flew to its bbox; now polygon uploads also add a
      **clip mask** layer (`buildClipMaskLayer` in `lib/geojson.ts` — world
      polygon minus the uploaded outer rings, rendered between the new
      `mask-slot` and `vector-slot` anchors in `MapView`) so rasters read only
      inside the boundaries — client-side twin of the dashboard's spotlight
      mask. It's an ordinary store layer ("Clip: <file>"): the panel's opacity
      slider sets dimming strength (1 = hard clip), uncheck/✕ un-clips, and the
      AI can clear it via `remove_layers(["clip-mask"])`. Needs an in-browser
      eyeball. Follow-on: true server-side pixel clip (TiTiler `/cog/feature`)
      once zonal stats land.
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
### Insurance alignment — the webmap priority queue (2026-07-10 code review)

Feature gaps between the webmap and the parametric crop-insurance use cases
(`PCIC_WEBMAP_USE_CASES.md`), ordered by leverage. The common thread: every
insurance process (underwriting · post-plant · claims) needs zone-level *numbers*,
and today the webmap can only show pixels, not measure them.

Each item is tagged by audience: `[generic]` = valuable to any agency on the
platform (agriculture, disaster-response, environment, weather, local
governments); `[insurance]` = parametric-insurance specific. Only the trigger
console is truly insurance-shaped — and even there, build
the threshold-exceedance engine generic and keep the insurance vocabulary
(UAI, payout, policy count) in a thin presentation layer.

- [ ] `[generic]` **Zonal statistics** — the unlock for all three processes. TiTiler
      already exposes `/cog/statistics` (POST a GeoJSON geometry → band stats),
      and the zone geometries exist (adm3/adm4 PMTiles; bboxes in
      `ph_admin_index.json`). Surface it two ways:
  - [ ] `zone_stats` AI tool — `(collection, zone or bbox, date range)` →
        mean/median NDVI, % flood pixels, % crop pixels (LULC). Turns "show
        NDVI in Nueva Ecija" into "what was the average NDVI in June, vs May?"
        — which *is* the parametric-trigger question.
  - [ ] Click-to-identify — click a municipality/barangay → name + pcode +
        quick stats popup. Needs an invisible fill layer over the admin
        PMTiles for hit-testing (line-only today) and name labels; also makes
        uploaded-parcel properties (incl. the new `area_ha`) readable.
- [ ] `[generic]` **Cloud-contamination guardrails** — prerequisite for any NDVI statistic
      or trigger being trustworthy (a cloudy zone-mean NDVI reads as crop
      failure → false payouts). Defense in depth, cheapest first:
  - [ ] Mask clouds at the silver NDVI build (`build_ndvi.sh`): S2 L2A already
        contains the 20 m **SCL band** — set NDVI to nodata under SCL classes
        3 (cloud shadow), 8/9 (cloud medium/high), 10 (cirrus). One script
        change; everything downstream (display + future stats) becomes
        cloud-free by construction, and TiTiler masks nodata automatically.
  - [ ] Propagate per-item **`eo:cloud_cover`** (from L2A metadata) into the
        STAC items in `catalog_silver.py`, so the webmap/AI can rank dates and
        warn ("best cloud-free date near June 5 is …").
  - [ ] `zone_stats` must report the **valid-pixel fraction** per zone and
        refuse/flag results below a threshold (e.g. <70 % valid) instead of
        returning a silently biased mean.
  - [ ] Parametric triggers read **temporal composites** (e.g. monthly median
        or max-NDVI per zone), never single scenes — standard index-insurance
        practice; also what the Sentinel-3 OLCI ingest (Ingest section) and
        SAR fallback are for when the monsoon gap is too long.
- [ ] `[generic core · insurance framing]` **Zone index-history chart** (underwriting
      / burn-cost): NDVI or flood-% per date over a selected zone, plotted with
      a draggable threshold line — the visual "how risky is this barangay"
      answer. The time-series-over-a-zone part is generic (drought monitoring,
      vegetation trend); the threshold overlay is the insurance flavor. The
      TimeSeries scrubber is the skeleton; this is its numeric sibling (needs
      zonal stats above).
- [ ] `[generic]` **Compare mode** (post-plant / pre-post event): swipe or
      side-by-side of two dates of one collection. Cheap on the existing layer
      factory.
- [ ] `[insurance]` **Trigger console** (claims): pick event date + threshold →
      compute breach per zone → choropleth + exportable CSV of breaching zones.
      The exceedance engine itself doubles as a generic early-warning /
      alert-prioritization report; only the payout semantics are insurance-specific.
- [ ] `[generic]` **Permalink / report export** (transparent evidence): URL-encoded map
      state so a view is shareable, and a printable snapshot (map + stats +
      dates) as the payout justification. Today a refresh loses everything.
- [ ] `[generic]` **Chat server hardening before any external demo**: auth or shared
      secret + rate limiting on `/api/chat`, pin `CHAT_ALLOW_ORIGIN`, and a
      deliberate model choice — the free-model fallback chain routes insurance
      queries (places/dates of interest ≈ claims activity) to arbitrary
      third-party providers.
- [ ] `[generic]` **Shared tool schemas** between `server/chat.mjs` and
      `src/ai/executeTool.ts` (today kept in sync by comment discipline; needs
      a small build step or a plain shared module the server can import).

## Frontend — TerriaJS dashboard & STAC Browser (FROZEN at demoable)

**Frozen 2026-07-10** — kept as the "we also integrate with PhilSA's existing
Terria stack" exhibit; already demoable (branded, STAC-driven, admin boundaries,
split-screen compare). No new feature work; items below are parked, not
abandoned. Fixes only if a demo breaks.

- [x] Stand up STAC Browser end-to-end against the local API
- [x] PhilSA-brand the catalog: STAC Browser (`config.js` — title, logo, favicon,
      blue accent) locked to our API only (`allowExternalAccess: false`); STAC API
      landing/docs branded via `STAC_FASTAPI_*` env in `compose.yml`
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
      (`-0.2…0.9`). Parked items:
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
  - [~] **Tile-serving robustness** — *(shared infra, not dashboard-specific;
        see Deployment / hosting → Tile-serving robustness for the full item —
        `mosaic_tile_url` here now emits `s3://` too.)*
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
  - [ ] When picking a date in the dropdown, show the same date or nearest available in the other layers (NDVI, SAR, LULC)

## Deployment / hosting (free-tier)

Goal: lift the whole POC off `localhost` onto free-tier hosting for a shareable
demo. The stack is a managed DB + two Docker web services (STAC API, TiTiler) +
three static frontends + R2. Component → free-tier pick:

- [x] **pgSTAC database (Postgres + PostGIS)** — **live on Neon (prod).** pgSTAC
      is pure SQL schema + functions, so any Postgres ≥14 with PostGIS can host it
      via `pypgstac migrate`. **Neon** chosen (free tier, **no auto-pause**,
      PostGIS, branching); **Supabase** free works too (PostGIS + a nice console)
      but **pauses after ~7 days idle** and needs care with pgSTAC roles/grants.
- [x] **STAC API (`stac-fastapi-pgstac`)** — **live on Render** (`philsa-stac-api`,
      read-only, behind the gateway), Docker web service pointed at the managed
      Postgres. Heads-up: free tiers **spin down on idle** (Render ~15 min) → cold
      start on first request (see *Interoperability → keep-warm the origins* for
      the fix).
- [x] **TiTiler** — **live on Render** (`philsa-titiler`, behind the gateway),
      Docker web service next to the STAC API, reading COGs from R2 (public
      `r2.dev` or the authenticated endpoint — see *Tile-serving robustness*).
      Memory is the constraint: 512 MB free is borderline under heavy requests but
      OK for POC traffic.
  - [~] **Tile-serving robustness** — finish the `r2.dev` → authenticated-endpoint
        move (`r2.dev` is rate-limited, not for production tile traffic). TiTiler
        itself already reads over the authenticated `*.r2.cloudflarestorage.com`
        endpoint in both deployments (`compose.viz.yml`, `philsa-titiler` in
        `render.yaml`); this item is about getting every URL *fed to* TiTiler
        onto `s3://` too, mirroring the pattern stac-browser's `config.js`
        already uses (`buildTileUrlTemplate` rewrites r2.dev asset hrefs to
        `s3://world-bank-philsa-geo/<key>`):
    - [x] `deploy/titiler/Dockerfile` installs `boto3` (missing from the
          upstream image) — required by cogeo-mosaic's S3 backend for
          `/mosaicjson` to read `s3://` mosaicjson URLs.
    - [x] `pipelines/02-silver/build_raster_mosaics.sh` rewrites each COG href
          to `s3://$R2_BUCKET/<key>` before `MosaicJSON.from_urls`, so emitted
          mosaicjson files reference COGs via the authenticated endpoint.
    - [x] Mosaic consumers (`webmap/src/config.ts` `mosaicUrlFor`,
          `dashboard/build_catalog_from_stac.py` `mosaic_tile_url`) point
          TiTiler at the `s3://` mosaicjson URL; the webmap's browser-side
          existence probe stays on the public r2.dev URL
          (`mosaicPublicUrlFor`) since the browser can't read `s3://`.
    - [x] Per-item COG tile URLs fed to TiTiler get the same r2.dev → `s3://`
          rewrite (`webmap/src/lib/titiler.ts` `toR2S3Url`, reused by
          `stats.ts`'s `/cog/statistics` calls; `dashboard/build_catalog_from_stac.py`
          `to_r2_s3_url`), leaving non-R2 hrefs (ESRI LULC's Azure blob,
          Diwata-2's GCS COG) untouched. STAC asset hrefs in the catalog and
          all other client-side fetches (PMTiles, `ph_admin_index.json`,
          GeoParquet) intentionally stay on the public r2.dev base.
    - [ ] **Operator action (needs R2 creds, not run here):** rerun
          `build_raster_mosaics.sh` to regenerate + re-upload the mosaics with
          `s3://` hrefs; redeploy `philsa-titiler` so the `boto3` image change
          lands; redeploy the webmap static site.
- [~] **Static frontends — TerriaJS dashboard, MapLibre webmap, STAC Browser** —
      **webmap + STAC Browser live as Render static sites** (repointed to the
      gateway URLs; auto-deploy + `buildFilter` on). Dashboard still local
      (frozen). Alternative host for the statics is **Cloudflare Pages** (generous
      free tier, unlimited bandwidth, **same vendor as R2**) or Netlify / Vercel /
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

## Interoperability API — external-agency access (gateway)

How other agencies (crop-insurance, agriculture, disaster-response, weather,
local governments) consume PhilSA data from
**their own** systems: the POC's STAC + TiTiler + R2, fronted by one governed
edge gateway, published on open standards so there's no bespoke client to build.
Architecture + rollout in `PHILSA_INTEROP_API.md`; the external developer guide
is `INTEGRATION_GUIDE.md`; `partner-template/` is a runnable single-file sample.
**Phases 0–2 done; Phase 3 (govern) is next.**

- [x] **Phase 1 — declare the contract** (2026-07-15): explicit open-data CORS
      pinned in `render.yaml` (`CORS_ORIGINS`/`CORS_METHODS` — note the pgstac
      settings take **no** `STAC_FASTAPI_` prefix, unlike TiTiler's `TITILER_API_*`);
      `INTEGRATION_GUIDE.md` (base URLs, collection cheat-sheet, MapLibre/Leaflet/
      QGIS/pystac recipes, per-parcel zonal stats); webmap surfaces a "Data via
      PhilSA Open Data API" footer (`LayerPanel` + `DATA_SOURCE` in `config.ts`).
- [x] **Phase 2 — front + cache** (2026-07-15): Cloudflare Worker gateway
      (`deploy/gateway/`) deployed as two envs on `philsa.workers.dev` —
      `philsa-stac-gateway` (fronts stac-api) + `philsa-tiles-gateway` (fronts
      titiler). Read-only allowlist (blocks writes at the edge; POST only for
      `/search`+`/aggregate`), open-data CORS, edge cache (tiles 24 h / STAC 60 s —
      verified `cf-cache-status: HIT`), Host-rewrite so Render routes correctly +
      stac-fastapi self-links point at the gateway, CORS'd 502 on origin
      cold-start, Workers Logs on. **Frontends + docs repointed** to the gateway
      URLs (`render.yaml` `VITE_*`/`SB_catalogUrl`, partner template, both guides);
      webmap + STAC Browser redeployed and verified serving the gateway.
- [x] Prod STAC write access **CLOSED** (2026-07-15): public origin runs
      `ENABLE_TRANSACTIONS_EXTENSIONS=false`; the gateway re-blocks writes; ingest
      moved to a private, ephemeral transactions API bound to Neon
      (`prod-ingest.sh`), and every STAC writer refuses a read-only target
      (`pipelines/lib/stac_write.py` `ensure_writable` + `--silver-only` targeted
      reload). Nothing writable is internet-reachable.
- [x] Render **auto-deploy on commit** + per-service `buildFilter` (2026-07-15)
      so a push only rebuilds the service whose paths changed.

**Next — POC polish (cheap, removes the visible warts):**
- [ ] **Keep-warm the origins** — the free-tier Render STAC API + TiTiler sleep
      after ~15 min idle, so the first uncached request is ~30–60 s (the one
      visible wart in a demo). Add a **Cloudflare Cron Trigger** to the gateway
      worker: a `scheduled()` handler that pings its `ORIGIN` every ~10 min. Free,
      same account, no new service. (A custom domain would NOT fix this; only a
      warm/paid origin does.)
- [ ] **Apply R2 CORS** (`deploy/r2/apply-cors.sh`) — the public bucket ships with
      no CORS, so browsers can't HEAD-probe the per-date mosaics and the webmap/
      partner template fall back to per-item COGs. One command (needs `.env` R2
      creds) activates the single-source mosaic fast-path.
- [ ] **Enable the rate-limit binding** — uncomment the `RATE_LIMITER` block in
      `deploy/gateway/wrangler.toml` (the worker already calls it and no-ops if
      absent). Confirm it's available on the account plan first.
- [ ] **Smoke-test the prod ingest path** — run `prod-ingest.sh prod --silver-only`
      on the next catalog refresh to exercise the read-only guards +
      `ensure_writable` conformance check end-to-end (needs Docker + Neon; couldn't
      be run at review time).

**Next — Phase 3 (govern it; only once an agency actually commits):**
- [ ] **API keys** for server/restricted consumers — the per-key hook is stubbed
      in `worker.js`. A key identifies the agency, not a person; open collections
      stay anonymous.
- [ ] **Usage metrics / attribution** — with Workers Logs on, aggregate
      who-pulled-what for reporting + capacity planning.
- [ ] **Restricted-data tier** — presigned-URL path for the private R2 bucket
      (see *Storage → private bucket / presigned* and *Auth & governance*). Blocked
      on the private bucket existing; today "restricted" is a design, not a
      capability.

**Next — Phase 4 (graduate; only if adoption warrants the ops cost):**
- [ ] Custom domains (`stac.philsa.gov.ph`) — worker code + consumer URLs move,
      nothing else. Full API-management (APISIX/Kong), SLAs, per-agency quotas.

**Next — adoption (the actual point):**
- [ ] **Get one agency (a crop-insurer) to fork `partner-template/`** — the "integrate in an
      afternoon" existence proof the whole story rests on. To make it land harder,
      ship the template with real sample Central-Luzon parcels + a click-popup
      (today it's `MY_DATA = null`; the README was trimmed to match).

## Auth & governance

- [ ] Identity provider + token issuance
- [ ] RBAC / collection-level access control on the catalog API
- [ ] Data-sharing policy: who sees open vs. restricted
