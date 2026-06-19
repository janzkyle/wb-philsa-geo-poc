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
    - [ ] _(stretch)_ Sentinel-1 flood delineation from S1 — full SAR chain
          (calibration · speckle · terrain-correction · change-detection vs a dry
          reference). High effort; for the POC prefer authoritative Copernicus
          EMS / GFM instead (see the flood ingest item below).
  - [x] Catalog silver COGs in pgSTAC by reference (gold,
        `pipelines/03-gold/catalog_silver.py`): S2 NDVI, S2 true-colour, S1 VV
        backscatter as STAC collections + items (asset hrefs → public R2)
    - [ ] also catalog ph-admin-boundaries GeoParquet (vector item) — follow-on
- [ ] **Copernicus EMS / GFM — flood** (`VEC`/`PUB`): the POC's authoritative
      flood layer. EMS Rapid Mapping delineation vectors (flood extent ·
      affected-area · damage grading) → vector-to-PMTiles, tagged open/restricted;
      and/or GFM Sentinel-1 flood-extent rasters mirrored by reference.
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
      Sentinel-1 SAR (VV) via TiTiler, centred on Luzon. Rasters rendered as
      **per-date seamless mosaics** (MosaicJSON,
      `pipelines/02-silver/build_raster_mosaics.sh`) so a
      day's granules stitch into one continuous layer; a **single-date selector**
      (with a per-layer data-availability indicator) drives which day loads.
      Still to do: restricted (authenticated) layers, more open layers (LULC,
      footprint discovery).
- [x] TiTiler for raster tiling (open COGs from R2 — `compose.viz.yml`, :8083).
      Restricted COGs (presigned) still to do.
- [~] Serve PMTiles — **open admin boundaries (adm0–adm2) live on public R2**
      (`pipelines/02-silver/ph-admin-boundaries/build_ph_admin_pmtiles.sh`;
      r2.dev serves them with CORS + range).
      Still to do: adm3/adm4, other vector layers, restricted via presigned.

## Auth & governance

- [ ] Identity provider + token issuance
- [ ] RBAC / collection-level access control on the catalog API
- [ ] Data-sharing policy: who sees open vs. restricted
