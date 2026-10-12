# TODO

Running task list for the PhilSA POC. Check items off as they land; the
high-level narrative ("what's next") lives in `README.md` — this is the granular
version. Keep both honest.

Legend: `[x]` done · `[~]` partly done (the remaining work is spelled out inline)
· `[ ]` not started. **Last audited against the code and the live prod gateway
on 2026-10-11** for the handover to the PhilSA team; the item counts below
(scenes, collections, assets) are as of that date.

## Ingest

- [x] Mirror the PhilSA STAC (`stac.infra.copphil.philsa.gov.ph`) into pgSTAC by
      reference (`mirror_philsa_catalog.py`) — every collection, plus the 20 most
      recent items each (the upstream holds ~387k). Mirrored collections carry
      `philsa:mirrored_from` and sort **last** in the Browser so PhilSA's own
      products lead the list.
  - [x] Retired the legacy Satellite Imagery Catalog mirror (`diwata-2` /
        `planetscope` / `skysat`, from `api.catalog.data.philsa.gov.ph`) and the
        simulated MULA collection — all four dropped from local **and** prod
        pgSTAC, and `pipelines/reference/mula-mock/` deleted. The legacy host is
        still live, so `SRC=https://api.catalog.data.philsa.gov.ph
        mirror_philsa_catalog.py` would rebuild the first three if ever needed.
- [x] Load ESRI 10 m Annual LULC COGs by reference (`load_esri_lulc.sh`)
- [x] Build PH admin-boundary GeoParquet adm0–adm4 (`ph-admin-geoparquet` skill)
- [~] **CopPhil S3 — raw Sentinel / EODATA** (`COP`): ingest raw Sentinel-1
      (SAR) + Sentinel-2 (optical) scenes for the AOI; feeds the `clip · NDVI ·
      SAR flood` processing path
  - [x] Acquire scenes via the CopPhil API (`download_copphil_eodata.py`):
        Keycloak auth → OData search (latest S1 GRD + S2 L2A over the PH AOI) →
        token-authed download. Creds (`COPPHIL_USERNAME` / `COPPHIL_PASSWORD`)
        in the single gitignored repo-root `.env`. Default pulls the latest
        `--dates 3`; `--all` takes every scene CopPhil holds (large — `--dry-run`
        first, then bound with `--days` / `--limit` / `--aoi`).
  - [~] Process raw SAFE zips → derived COGs in R2 (silver) — all five products
        built and cataloged; what's left is the flood-method upgrades and
        backfilling the remaining scenes (below):
    - [x] Sentinel-2 NDVI COG (`02-silver/sentinel2-ndvi/build_ndvi.sh`)
    - [x] Sentinel-2 true-colour TCI COG (`02-silver/sentinel2-truecolor/build_truecolor.sh`)
    - [x] Sentinel-1 VV backscatter (dB) COG (`02-silver/sentinel1-sar/build_sar.sh`)
    - [~] **Sentinel-1 flood layer from our CopPhil S1** (`COP`) — derive an
          actual flood-extent product from the VV scenes we already ingest.
          **Built + cataloged (13 flood items in prod vs 26 SAR items):** `02-silver/sentinel1-flood/` —
          `otsu_flood.py` classifies the existing silver VV-dB COG into a Byte mask
          (1=water/0=land/2=permanent-water/255=nodata), **block-wise** for full
          ~28k×21k GRD scenes. Methods: **`sigma` (default, mean−k·std)**, `otsu`,
          `fixed`. Note: the silver SAR is *uncalibrated* 10·log10(DN²) (~25–57 dB,
          unimodal), so global Otsu just returns ~the mean — hence `sigma` is the
          robust default. Optional `--perm-water` mask + `--min-db` floor. Driven by
          `build_flood.sh` (stage from R2 silver → classify → COG → R2). Gold
          collection `sentinel1-flood` wired into `catalog_silver.py` (flood colormap
          render) + stac-browser tile rule. **Open tier** (`philsa:access: open`;
          it was restricted 2026-07-28 → 2026-08-04 to prove the auth layer, then
          returned — see *Auth & governance*). **Still to do:** backfill flood for
          the SAR scenes that don't have it yet (`build_silver.py --only flood`);
          slope masking (needs the DEM below); rigorous route — change-detection
          vs a dry-season reference (calibration · speckle · terrain-correction).
          Flood has no per-date mosaics (`build_raster_mosaics.sh` leaves it out
          by default; pass `COLLECTIONS=…` to include it).
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
          calibrated/validated crop product. **Built + verified (2026-07-11; 19
          items in prod as of 2026-10-11, vs 26 SAR items):** full chain first
          verified on the 2026-07-07 S1D scene —
          silver COG (1.8 GB), gold collection `sentinel1-ratio` (ylgn render,
          stretch −14…−2 dB = measured p2–p98; values land in the physical
          VH−VV range, confirming the gain cancellation), stac-browser tile
          rule, Dagster asset `silver/sentinel1_ratio` (auto-joins
          `copphil_chain_refresh`), webmap layer + legend + chat-assistant
          entry (verified in-browser: panel, date pick, tiles, legend).
          **Still to do:** backfill the remaining scenes (`build_silver.py
          --only ratio`; ~2 GB Float32 COG per scene — mind R2's 10 GB free
          tier). Per-date mosaics are built (it's in `build_raster_mosaics.sh`'s
          default list).
  - [x] Catalog silver COGs in pgSTAC by reference (gold,
        `pipelines/03-gold/catalog_silver.py`): S2 NDVI, S2 true-colour, S1 VV
        backscatter as STAC collections + items (asset hrefs → public R2)
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
- [ ] **For the PhilSA catalog team** (upstream fix, not POC work): the
      `stac.infra.copphil.philsa.gov.ph` catalog's `eo:bands.common_name` values
      (`red-edge`, `coastal_blue`, `green_i`) are outside the EO-extension
      vocabulary and fail STAC validation. Our mirror normalizes them on ingest,
      so this only matters to other consumers of the upstream catalog.
- [ ] Adopt `uv` for the Python environment and run every Python script through
      it. Today only `pipelines/orchestration/` has a `pyproject.toml`; the
      standalone scripts are stdlib + system GDAL with no lockfile.

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
      12 assets, bronze → silver → gold lineage — giving run history, backfills,
      and a manual-run/trigger UI. Covers both asks: **one-time/manual** runs
      (UI "Materialize" or `dagster asset materialize`) and a **daily update
      check** (`copphil_new_scene_sensor` polls CopPhil OData hourly and only
      fires the bronze→silver→gold `copphil_chain_refresh` job on new scenes;
      `copphil_daily_schedule` 06:00 Asia/Manila is the idempotent fallback —
      **both ship OFF**, enable in the UI). Run/event storage = a `dagster` DB on
      the existing pgSTAC Postgres; `compose.orchestration.yml` runs the
      webserver (UI :3030) + daemon on the pgSTAC network. See
      `pipelines/orchestration/README.md`.
  - [x] `tippecanoe` (built from source) + `awscli` are in the Dagster image
        (`pipelines/orchestration/Dockerfile`), so `silver/ph_admin_pmtiles` and
        `silver/raster_mosaics` can run in-container.

## Storage — Cloudflare R2

- [x] Create the public bucket (open COGs + PMTiles) and confirm public read
- [x] Upload PH admin-boundary GeoParquet to R2 (skill already supports this)
- [x] Create the private bucket (sensitive data + licensed imagery) —
      `world-bank-philsa-geo-private`, no public access, no `r2.dev` domain.
      Proven end-to-end with `sentinel1-flood` (moved in 2026-07-28, moved back
      out 2026-08-04). **Holds no published collection today** — every
      cataloged collection is open. Use the `collection-tier` skill to move one
      in or out.
- [x] Decide the open/restricted **sensitivity tagging** scheme — `philsa:access`
      (`open`|`restricted`) on the **collection**, matching the existing
      `philsa:*` property convention. Per-collection, not per-item: that's how the
      data is actually licensed and it keeps enforcement off the hot path.
      See *Auth & governance*.
- [x] Presigned-URL flow for restricted assets — `/assets/sign` on the STAC
      gateway; R2 token widened to the private bucket and verified end-to-end
      (signed URL → `206`, 2026-07-28). See *Auth & governance*.

## Frontend — MapLibre webmap (ACTIVE track)

**Decision (2026-07-10): the webmap is the single active frontend.** It owns the
AI chat layer, the whole insurance-alignment roadmap targets it, and it deploys as a
plain static Vite build. *(The TerriaJS dashboard that once sat alongside it was
frozen at demoable and has since been deleted — see git history.)*

- [~] **MapLibre webmap (`webmap/`, AI-first rebuild)** — React+TS+Vite +
      react-map-gl/MapLibre + **Zustand + Vercel AI SDK**, replacing the Tier 1
      webmap (old version preserved in git history). Architecture: **one
      serializable layer store, two drivers** — a manual layer panel (browse
      collections, pick an acquisition date, legends, opacity) and a **chat
      assistant** whose client-side tools mutate the *same* store:
      `list_collections` · `resolve_region` (name→bbox from the R2
      `ph_admin_index.json` built by
      `pipelines/02-silver/ph-admin-boundaries/build_admin_search_index.py`) ·
      `resolve_point` · `highlight_location` · `search_catalog`
      (pgSTAC `/search`; on zero hits reports each collection's nearest available
      dates) · `get_available_dates` · `add_layers` / `remove_layers` /
      `update_layer` · `set_view`.
      "Show flood data for Central Luzon, first week of June" → resolve → search
      → add → zoom. Rasters via TiTiler — per-date **MosaicJSON when present**,
      falling back to per-item COG tiles (flood has no mosaics yet); admin
      outlines stream the same R2 PMTiles as before; per-layer legends kept.
      Chat backend: shared core `webmap/server/chatCore.mjs` (OpenRouter via the
      AI SDK), run locally by `server/chat.mjs` (Node; `OPENROUTER_API_KEY` in
      the repo-root `.env`) and in prod as a Cloudflare Worker
      (`server/worker.mjs`, config in `deploy/chat/wrangler.toml`, key as a
      Worker secret). Models: free-first — default
      `nvidia/nemotron-3-super-120b-a12b:free` (`GENAI_MODEL` overrides), with
      automatic fallback through tool-capable free models fetched live from the
      OpenRouter catalog when a stream errors before producing output. Still
      to do: **deck.gl overlay** (GPU date-range scrubbing via
      `DataFilterExtension`, GeoArrow vector layers); authenticated layers (see
      *Auth & governance*); footprint/discovery layer; surface EMS/GFM flood
      once ingested.
- [x] **GeoJSON upload → zoom-to-extent + raster clip** (2026-07-10): uploading
      a local file already flew to its bbox; now polygon uploads also add a
      **clip mask** layer (`buildClipMaskLayer` in `lib/geojson.ts` — world
      polygon minus the uploaded outer rings, rendered between the new
      `mask-slot` and `vector-slot` anchors in `MapView`) so rasters read only
      inside the boundaries — a client-side "spotlight" on the area of interest.
      It's an ordinary store layer ("Clip: <file>"): the panel's opacity
      slider sets dimming strength (1 = hard clip), uncheck/✕ un-clips, and the
      AI can clear it via `remove_layers(["clip-mask"])`. Needs an in-browser
      eyeball. Follow-on: true server-side pixel clip (TiTiler `/cog/feature`)
      once zonal stats land.
- [x] TiTiler for raster tiling (open COGs from R2 — `compose.viz.yml`, :8083).
      Restricted COGs (presigned) still to do.
- [x] Serve PMTiles — **open admin boundaries adm0–adm4 live on public R2**
      (`pipelines/02-silver/ph-admin-boundaries/build_ph_admin_pmtiles.sh`;
      r2.dev serves them with CORS + range). The MapLibre webmap reads the
      `.pmtiles` directly, so the per-level GeoJSON shim was retired. All admin
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

- [~] `[generic]` **Zonal statistics** — the unlock for all three processes.
      **Built for uploaded areas:** the webmap's Time-series tab ("Window
      average", `webmap/src/lib/stats.ts`) calls TiTiler `/cog/statistics` per
      uploaded polygon × acquisition date. It reports the mean plus valid-pixel
      coverage, pools areas that span several granules, and exports CSV.
      **Not yet:** stats over *admin* zones (the adm3/adm4
      geometries exist as PMTiles; bboxes are in `ph_admin_index.json`), and
      access from the chat assistant:
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
  - [~] Zonal stats must report the **valid-pixel fraction** per zone and
        refuse/flag results below a threshold (e.g. <70 % valid) instead of
        returning a silently biased mean. The Time-series stats already compute
        and export `coveragePct`. Nothing flags or refuses a low-coverage
        result yet.
  - [ ] Parametric triggers read **temporal composites** (e.g. monthly median
        or max-NDVI per zone), never single scenes — standard index-insurance
        practice; also what the Sentinel-3 OLCI ingest (Ingest section) and
        SAR fallback are for when the monsoon gap is too long.
- [ ] `[generic core · insurance framing]` **Zone index-history chart** (underwriting
      / burn-cost): NDVI or flood-% per date over a selected zone, plotted with
      a draggable threshold line — the visual "how risky is this barangay"
      answer. The time-series-over-a-zone part is generic (drought monitoring,
      vegetation trend); the threshold overlay is the insurance flavor. The data
      already exists: the Time-series "Window average" produces the per-area ×
      per-date series, but only as a table/CSV. What's missing is the chart,
      the threshold line, and admin-zone selection.
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
      secret + rate limiting on `/api/chat`, and a deliberate model choice — the
      free-model fallback chain routes insurance queries (places/dates of
      interest ≈ claims activity) to arbitrary third-party providers.
      `CHAT_ALLOW_ORIGIN` is now pinned to the webmap origin
      (`deploy/chat/wrangler.toml`), but that is CORS, **not auth**: it stops a
      stray page from spending the OpenRouter key, not a direct curl. The
      endpoint is still unauthenticated and unmetered.
- [ ] `[generic]` **Shared tool schemas** between `server/chatCore.mjs` and
      `src/ai/executeTool.ts` (today kept in sync by comment discipline; needs
      a small build step or a plain shared module the server can import).
      The server side is already deduplicated — `chatCore.mjs` is the single
      copy shared by the Node dev server and the prod Worker — so this is now
      only the server↔browser half of the problem.

## Frontend — STAC Browser (FROZEN at demoable)

**Frozen 2026-07-10** — already demoable (PhilSA-branded, pointed at our STAC
API). No new feature work; items below are parked, not abandoned. Fixes only if
a demo breaks.

- [x] Stand up STAC Browser end-to-end against the local API
- [x] PhilSA-brand the catalog: STAC Browser (`config.js` — title, logo, favicon,
      blue accent) locked to our API only (`allowExternalAccess: false`); STAC API
      landing/docs branded via `STAC_FASTAPI_*` env in `compose.yml`
- [x] **Tile-serving robustness** — *(shared infra; see Deployment / hosting →
      Tile-serving robustness for the full item. Done 2026-07-17.)*

## Deployment / hosting (free-tier)

Goal: lift the whole POC off `localhost` onto free-tier hosting for a shareable
demo. The stack is a managed DB + two Docker web services (STAC API, TiTiler) +
two static frontends + R2. Component → free-tier pick:

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
  - [x] **Tile-serving robustness** (done 2026-07-17) — finished the `r2.dev` →
        authenticated-endpoint move (`r2.dev` is rate-limited, not for production
        tile traffic). TiTiler
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
    - [x] Mosaic consumers (`webmap/src/config.ts` `mosaicUrlFor`) point
          TiTiler at the `s3://` mosaicjson URL; the webmap's browser-side
          existence probe stays on the public r2.dev URL
          (`mosaicPublicUrlFor`) since the browser can't read `s3://`.
    - [x] Per-item COG tile URLs fed to TiTiler get the same r2.dev → `s3://`
          rewrite (`webmap/src/lib/titiler.ts` `toR2S3Url`, reused by
          `stats.ts`'s `/cog/statistics` calls), leaving non-R2 hrefs (ESRI LULC's
          Azure blob) untouched. STAC asset hrefs in the catalog and
          all other client-side fetches (PMTiles, `ph_admin_index.json`,
          GeoParquet) intentionally stay on the public r2.dev base.
    - [x] Redeploys landed (verified 2026-07-17): `philsa-titiler` runs the
          boto3 image, the live webmap bundle contains the `toR2S3Url` rewrite,
          and prod TiTiler serves per-item `s3://` COGs (GDAL `/vsis3`,
          `/cog/info` verified through the tiles gateway).
    - [x] **boto3 needs its own endpoint var** (found + fixed 2026-07-17):
          cogeo-mosaic's S3 backend ignores GDAL's `AWS_S3_ENDPOINT`, so prod
          `/mosaicjson` `s3://` reads hit `s3.auto.amazonaws.com` and failed.
          Fix = `AWS_ENDPOINT_URL_S3=https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`
          — added to `compose.viz.yml`, declared (`sync: false`) in
          `render.yaml`, and set on `philsa-titiler` in the Render dashboard.
    - [x] Mosaics regenerated + re-uploaded with `s3://` COG hrefs
          (`build_raster_mosaics.sh` against the prod STAC gateway,
          2026-07-17). **End-to-end verified in prod:** `/mosaicjson/info` and
          a real NDVI mosaic tile render (200, image/png) through the tiles
          gateway with the `s3://` mosaicjson URL. TiTiler-side reads no
          longer touch `r2.dev`; only deliberate browser-side fetches
          (PMTiles, `ph_admin_index.json`, mosaic existence probe) remain on
          the public host.
- [x] **Static frontends — MapLibre webmap + STAC Browser** — both **live as
      Render static sites** (repointed to the gateway URLs; auto-deploy +
      `buildFilter` on). Alternative host for the statics is **Cloudflare Pages**
      (generous free tier, unlimited bandwidth, **same vendor as R2**) or
      Netlify / Vercel / GitHub Pages.
- [x] **R2 object storage** — already on Cloudflare R2 free tier (10 GB).

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
**Phases 0–2 done; Phase 3 (govern) is mostly built.** API keys and the
restricted tier are live. Usage metrics and the Auth0 tenant are left.

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
- [x] **Keep-warm the origins** (done 2026-07-17) — the free-tier Render STAC
      API + TiTiler sleep after ~15 min idle, so the first uncached request was
      ~30–60 s (the one visible wart in a demo). Added a `scheduled()` handler to
      the gateway `worker.js` that pings its origin's lightweight health endpoint
      (`WARM_PATHS`: STAC `/_mgmt/ping`, TiTiler `/healthz`; overridable via the
      `WARM_PATH` var) + a **Cloudflare Cron Trigger** (`[env.*.triggers]
      crons = ["*/5 * * * *"]` — triggers aren't inherited, so each env has its
      own). Free, same account, no new service. (A custom domain would NOT fix
      this; only a warm/paid origin — or this cron — does.)
    - **Gotcha (fixed 2026-07-17):** the tiles gateway's first cron registration
      was **stuck** — deploy reported `schedule: */10` but the trigger never
      fired (verified: `wrangler tail` showed STAC's scheduled events but none
      for tiles across 4 windows; a clean 16-min idle test left the TiTiler
      origin spun down → 7.6 s cold wake). A plain no-config redeploy didn't
      fix it (wrangler no-op'd the "unchanged" trigger). **Changing the schedule
      (`*/10` → `*/5`) forced a real re-registration** and it now fires — tail
      shows `outcome: ok` + `keep-warm ping … status:200`. The 5-min interval
      also survives a skipped best-effort fire better than 10 min did. STAC's
      cron worked from the first deploy; the flaky registration was tiles-only.
- [x] **Apply R2 CORS** (`deploy/r2/apply-cors.sh`) — verified live 2026-07-17:
      preflight 204 + `Access-Control-Allow-Origin: *` with ETag/Content-Range/
      Accept-Ranges exposed, so browsers can HEAD-probe the per-date mosaics and
      the webmap/partner template use the single-source mosaic fast-path.
- [ ] **Enable the rate-limit binding** — uncomment the `RATE_LIMITER` block in
      `deploy/gateway/wrangler.toml` (the worker already calls it and no-ops if
      absent). Confirm it's available on the account plan first.
- [ ] **Smoke-test the prod ingest path** — run `prod-ingest.sh prod --silver-only`
      on the next catalog refresh to exercise the read-only guards +
      `ensure_writable` conformance check end-to-end (needs Docker + Neon). Prod
      has been written to since (13 flood / 19 ratio items, tier moves), so the
      path works in practice, but no one has recorded a deliberate run of the
      guard checks.

**Next — Phase 3 (govern it; only once an agency actually commits):**
- [x] **API keys** for server/restricted consumers — implemented
      (`deploy/gateway/lib/auth.js`, minted/revoked with
      `deploy/gateway/scripts/mint-key.mjs`; see *Auth & governance*). A key
      identifies the agency, not a person; open collections stay anonymous.
      What's left is operational: actually issuing keys to agencies.
- [ ] **Usage metrics / attribution** — with Workers Logs on, aggregate
      who-pulled-what for reporting + capacity planning.
- [x] **Restricted-data tier** — built and proven end-to-end (private bucket,
      `/assets/sign` presigned URLs, gateway RBAC, TiTiler locked to the
      gateway). It's a working capability with no collection in it today. See
      *Auth & governance*.

**Next — Phase 4 (graduate; only if adoption warrants the ops cost):**
- [ ] Custom domains (`stac.philsa.gov.ph`) — worker code + consumer URLs move,
      nothing else. Full API-management (APISIX/Kong), SLAs, per-agency quotas.

**Next — adoption (the actual point):**
- [ ] **Get one agency (a crop-insurer) to fork `partner-template/`** — the "integrate in an
      afternoon" existence proof the whole story rests on. To make it land harder,
      ship the template with real sample Central-Luzon parcels + a click-popup
      (today it's `MY_DATA = null`; the README was trimmed to match).

## Auth & governance

Enforced at the **edge gateway** (`deploy/gateway/`), which already fronts both
public origins — no new service in the request path, and anonymous open-data
traffic pays nothing for it (no KV read, no JWKS fetch without a credential).
Operator guide + Auth0 tenant setup: **`deploy/AUTH.md`**.

- [x] **Identity provider + token issuance** — two credential types, one
      principal (`gateway/lib/auth.js`): **API keys** for server consumers that
      can hold a secret (hashed SHA-256 in Workers KV, minted/revoked with
      `gateway/scripts/mint-key.mjs`), and **Auth0 JWTs** (RS256 verified against
      the tenant JWKS, `alg` pinned) for browser users who can't. Roles:
      `public` / `partner` / `admin`. Nothing is Auth0-specific — it's plain OIDC
      discovery, so repointing at CopPhil/PhilSA **Keycloak** later is a var
      change. *Auth0 tenant not created yet: `AUTH0_DOMAIN` ships empty, which
      disables JWTs and leaves API-key auth fully working.*
- [x] **RBAC / collection-level access control on the catalog API** — deployed and
      verified live (2026-07-28) with `sentinel1-flood` as the test restricted
      collection: stripped from `/collections` (110 → 109 anonymously), `401` on
      its collection/item routes, `401` on a search naming it, and filtered out
      of an **unscoped** `/search` (the bypass that matters — origin returns 30
      items for a given date window, the gateway returns 28 with zero flood). The
      tiles gateway refuses to render restricted COGs, including via the
      `urls`/`url_1` mosaic params. Edge-cache keys are tier-scoped so a
      privileged response can't be replayed to an anonymous caller.
      **Today no collection is restricted:** `sentinel1-flood` was returned to
      the open tier on 2026-08-04, so `RESTRICTED_COLLECTIONS` /
      `RESTRICTED_ASSET_PREFIXES` are commented out in
      `deploy/gateway/wrangler.toml` and all 110 collections are anonymous.
- [x] **Data-sharing policy: who sees open vs. restricted** — written up in
      `deploy/AUTH.md` (tier table, roles, enforcement matrix, known limits).
      Sensitivity is tagged on collections as `philsa:access` via
      `deploy/scripts/tag-collection-access.sh` — **documentation**; the gateway's
      `RESTRICTED_COLLECTIONS` var is the **enforcement authority**. Deliberately
      two places: enforcement must survive the DB being unreachable, and a
      catalog writer must not be able to quietly open the restricted tier.
- [x] **Presigned URLs for restricted assets** — `/assets/sign` is built and
      deployed; it refuses anonymous callers, refuses to sign open assets (so a
      leaked key can't proxy the bucket), and logs every signing with the
      principal + object key (that log is the access record). The SigV4
      implementation is verified **byte-identical to botocore**. The R2 token
      was widened to cover the private bucket, and a private-bucket object then
      signed and returned `206` (2026-07-28).
- [x] **Move the restricted bytes** — scripted both ways by the
      `collection-tier` skill (`move_assets_tier.sh <env> <collection>
      restrict|open`, dry-run by default; copies, verifies count + bytes,
      repoints hrefs, then deletes the source copies). Run against prod for all
      13 `sentinel1-flood` COGs (2026-07-28) and reversed on 2026-08-04.
      `catalog_silver.py` (`access: "restricted"` per product) and
      `build_flood.sh` (`R2_DEST_BUCKET`) keep a re-run from republishing a
      restricted product to the public bucket.
- [x] **TiTiler origin locked to the gateway** — the gateway injects
      `X-Gateway-Auth` (`ORIGIN_SHARED_SECRET`) and the origin's
      `gateway_guard.py` refuses requests without it (health paths excepted), so
      the public Render hostname can't render private-bucket COGs.
- [ ] **Close the last bypass: the STAC API origin** still serves restricted
      *metadata* directly on its public Render hostname, around the gateway. Its
      image builds from the submodule, so the TiTiler guard can't simply be
      copied in — see *Known limits* in `deploy/AUTH.md`. This only matters
      once a collection is restricted again.
- [ ] **Decide which collections are restricted** (PhilSA call): the tier
      works but nothing is in it. Licensed imagery and sensitive derivatives
      are the obvious candidates. Apply each with the `collection-tier` skill.
- [ ] **Auth0 tenant** — create it and fill `AUTH0_DOMAIN` in both `[env.*.vars]`
      blocks to switch on browser logins (`deploy/AUTH.md` has the click-path:
      API + audience, RBAC, roles, and the post-login Action that emits the roles
      claim). Or skip Auth0 and point the same OIDC vars at PhilSA/CopPhil
      Keycloak.
- [~] **Restricted layers in the frontends** — the webmap now shows a
      restricted layer as *restricted* instead of a stuck spinner (2026-07-29).
      Still anonymous everywhere (webmap, STAC Browser), so restricted data
      can't actually be viewed there. Wire the Auth0/OIDC SPA login and pass
      the bearer token through, or ship a partner key server-side for the
      template.
