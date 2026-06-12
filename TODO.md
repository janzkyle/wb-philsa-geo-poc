# TODO

Running task list for the PhilSA POC. Check items off as they land; the
high-level narrative ("what's next") lives in `README.md` — this is the granular
version. Keep both honest.

## ✅ Done — ingest

- [x] Mirror PhilSA Satellite Imagery Catalog into pgSTAC by reference
      (`mirror_philsa_catalog.py`)
- [x] Load ESRI 10 m Annual LULC COGs by reference (`load_esri_lulc.sh`)
- [x] Build PH admin-boundary GeoParquet adm0–adm4 (`ph-admin-geoparquet` skill)

## 🔜 Storage — Cloudflare R2

- [x] Create the public bucket (open COGs + PMTiles) and confirm public read
- [x] Upload PH admin-boundary GeoParquet to R2 (skill already supports this)
- [ ] Create the private bucket (sensitive data + licensed imagery)
- [ ] Decide the open/restricted **sensitivity tagging** scheme on items/assets
- [ ] Presigned-URL flow for restricted assets

## 🔜 Frontend

- [x] Stand up STAC Browser end-to-end against the local API
- [ ] MapLibre webmap: open layers (public) + restricted (authenticated)
- [ ] TiTiler for raster tiling (fetch COGs from R2 — open + restricted)
- [ ] Serve PMTiles (open direct from public R2; restricted via presigned)

## 🔜 Auth & governance

- [ ] Identity provider + token issuance
- [ ] RBAC / collection-level access control on the catalog API
- [ ] Data-sharing policy: who sees open vs. restricted

## Housekeeping / open questions

- [ ] Commit the POC scaffold (submodule gitlinks, docs, skills, scripts)
- [ ] Decide submodule push target: fork `main` vs. a dedicated `philsa` branch
- [ ] Pin/document GDAL ≥ 3.8 install for contributors
