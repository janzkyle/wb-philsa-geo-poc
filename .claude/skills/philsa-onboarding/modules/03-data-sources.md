# Module 3 — Data sources

**Goal:** they know every source the platform draws from, how each one enters
(referenced vs. downloaded), and what it's for. **Time:** ~20 min.

## Read first
- `pipelines/README.md` → "Data lineage" (the source → processing → use table)
- `poc-architecture.mmd` → the "Authoritative data sources" subgraph
- `TODO.md` → "Ingest" (done items for context, open items for what's planned)
- The header docstrings of `mirror_philsa_catalog.py` and
  `download_copphil_eodata.py`, and the comment block of `load_esri_lulc.sh`

## Why it's built this way (the intent)
- **Two ways in, decided by one question: will we transform it?**
  - If not, **reference** it: copy the STAC metadata, leave the pixels at the
    source. Examples are the PhilSA STAC mirror and ESRI LULC.
  - If yes, **download** it as bronze, because we need the bytes to derive
    from. Examples are CopPhil raw scenes and OCHA admin boundaries.
- **Authoritative sources only.** Data comes from the official publisher:
  Copernicus via CopPhil (the Philippine Copernicus mirror), OCHA for
  boundaries, Esri/Impact Observatory for land cover. When an authoritative
  product exists (Copernicus EMS/GFM for flood), it outranks our own
  derivation. Our S1 flood mask is explicitly a **proxy**.
- **Capped mirrors on purpose.** The PhilSA STAC holds ~387k items. We mirror
  every collection but only the 20 most recent items each, so the catalog is
  browsable without hammering the upstream. The full list is one `rel=via` hop
  away.

## Essentials (in order)

1. **The live sources:**

   | Source | Enters as | Gives us | Auth |
   |---|---|---|---|
   | **PhilSA STAC** (`stac.infra.copphil.philsa.gov.ph/v1`) | reference → pgSTAC | ~104 Copernicus collections (S1/2/3/5P/6), 20 items each | none |
   | **CopPhil DIAS / CloudFerro** (OData) | download → bronze | raw Sentinel-1 GRD + Sentinel-2 L2A `.SAFE.zip` | Keycloak user/password |
   | **ESRI 10 m LULC** (Living Atlas, public Azure blobs) | reference → pgSTAC | annual land cover, PH tiles | none |
   | **OCHA COD-AB on HDX** | download → silver | PH admin boundaries adm0–adm4 | none |

2. **How to recognize each in the catalog:**
   - Mirrored collections carry `philsa:mirrored_from` and a `rel=via` link,
     and their asset hrefs are `s3://eodata/…` with an `alternate.https`.
   - Our own derived collections have hrefs into R2.
   - ESRI hrefs point at the Azure blob URLs.
3. **The bronze downloader's defaults:**
   - nationwide, the latest 3 acquisition dates per collection
   - Sentinel-2 at ≤ 20% cloud
   - files land in local `eodata/`, which is gitignored
   - `--r2` also uploads to `01-bronze/` in R2
4. **Planned sources** (all ⏳ in `TODO.md`): Copernicus EMS/GFM flood (the
   authoritative flood layer), Sentinel-3 for drought and heat stress,
   Copernicus DEM GLO-30 (a slope mask for the flood proxy), OSM vectors, and
   Earth Search Sentinel-2 L2A.

## Adapt
- **Software first:**
  - A `.SAFE.zip` is ESA's packaging for one scene: a folder of band images
    plus XML metadata.
  - S1 GRD is radar backscatter on a ground-range grid. S2 L2A is
    atmospherically corrected surface reflectance.
  - OData is just the search API CopPhil exposes; Keycloak is its login
    server.
- **GIS first:** the new idea is "by reference". Their QGIS habit is to
  download the GeoTIFF. Here we deliberately don't, and range requests make
  that viable. Show `gdalinfo /vsicurl/<https href>` reading a remote COG's
  header without downloading it.

## Hands-on
Use the items mirrored in Module 2. If the local catalog isn't up, use the
prod gateway instead (`https://philsa-stac-gateway.philsa.workers.dev`).

```bash
API=http://localhost:8082
# 1. one mirrored item — find the provenance markers
curl -s "$API/collections/sentinel-2-l2a/items?limit=1" | python3 -c '
import json,sys; f=json.load(sys.stdin)["features"][0]
print("id:", f["id"]); print("datetime:", f["properties"].get("datetime"))
print("via:", [l["href"] for l in f["links"] if l["rel"]=="via"])
a=next(iter(f["assets"].values())); print("asset href:", a["href"])'
curl -s "$API/collections/sentinel-2-l2a" | grep -o '"philsa:mirrored_from":"[^"]*"'

# 2. follow the rel=via link — the same record, upstream at PhilSA
curl -s "<via-href-from-above>" | head -c 400; echo

# 3. what bronze WOULD download (needs no credentials in dry-run mode)
python3 pipelines/01-bronze/copphil-sentinel/download_copphil_eodata.py --dry-run --dates 1
```

If GDAL is installed, try a by-reference read of an ESRI tile header:
`gdalinfo /vsicurl/<an ESRI asset href>`. Get an href from the prod
`esri-lulc` collection's items if it isn't loaded locally.

## Checkpoint
They traced a mirrored item to its upstream record via `rel=via`. They can
explain why its `s3://eodata/…` href is *not* in our R2: it's referenced, not
re-hosted.

## Check understanding
- "PhilSA asks us to add Copernicus DEM. Referenced or downloaded?" It
  depends. If it's only a display layer, reference it. If it feeds the flood
  slope mask, we derive from it, so it goes through bronze → silver.
- "Why only 20 items per mirrored collection?" (Browsability without hammering
  a rate-limited upstream; the full list stays upstream.)

## Dive deeper (offer as options)
- **The CopPhil auth flow:** the `Auth` class in `download_copphil_eodata.py`
  (Keycloak password grant, token refresh). `deploy/AUTH.md` notes that the
  same Keycloak could later replace Auth0.
- **Mirror internals:** how `mirror_philsa_catalog.py` rewrites links,
  normalizes `eo:bands.common_name`, and handles 429s.
- **Adding a new source end to end:** walk through `TODO.md`'s Earth Search
  item against the "catalog by reference" corollaries in `AGENTS.md`
  (idempotent upserts, `gdalinfo`-derived geo-metadata, skip-and-log,
  sensitivity tags).
