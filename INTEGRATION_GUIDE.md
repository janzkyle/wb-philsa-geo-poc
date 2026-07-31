# Integrating PhilSA Earth-observation data - developer guide

This guide shows how to display or analyse PhilSA's satellite layers inside
**your own** maps and pipelines. You do not need any PhilSA-specific library,
account, or key for the open layers - PhilSA publishes its data on international
open standards (STAC + Cloud-Optimized GeoTIFF + XYZ tiles), so you integrate it
with tools you already use.

The deal in one line: **PhilSA hosts and serves the Earth-observation layers; you
render them over your own data** (farm parcels, road networks, admin units,
claims). Nothing here re-hosts PhilSA data - you point your app at PhilSA's URLs.

_Last updated: 2026-07-29_

> This file is the **canonical copy**. A webpage version ships with the partner
> template (`partner-template/guide.html`) with the markdown embedded verbatim -
> after editing this file, re-embed it there (command in that file's header
> comment).

---

## 1. What you're integrating

Two endpoints do everything:

| # | Endpoint | Standard | Use it to… |
|---|---|---|---|
| **STAC API** | *discovery* | STAC 1.0 / OGC API Features | Ask "what layers exist, where, on which dates?" - JSON over plain HTTP. |
| **TiTiler** | *tiles* | XYZ `/{z}/{x}/{y}.png` | Turn any layer into map tiles your slippy-map library drops straight in. |

Plus a public object store (Cloudflare R2) that holds the raw **COGs** and the
per-date **mosaics** - you rarely call it directly; the tiler reads it for you.

### Base URLs

```
STAC API   https://philsa-stac-gateway.philsa.workers.dev
TiTiler    https://philsa-tiles-gateway.philsa.workers.dev
Public R2  https://pub-17ab60a2ca7142a48ae8e2685cd853f7.r2.dev
```

> **The STAC and tile URLs are an always-on edge gateway** (Cloudflare, in front
> of the services) - stable and cached. If PhilSA later publishes custom domains
> (e.g. `stac.philsa.gov.ph`), **swap only the host** - every path, parameter, and
> recipe below is identical. Treat these three constants as your only configuration.

Two things to know up front:

- **Read-only, and mostly open.** These endpoints only ever *read*. Most layers
  need no key at all. A **restricted** tier exists and is live - see section 2a - and
  the open layers below will never require a key.
- **Always-on edge, but cold origins behind it.** The gateway itself never sleeps
  and caches repeat requests, but the free-tier services behind it sleep after
  ~15 min idle - so the *first uncached* request can take ~30–60 s while the origin
  wakes. Expected for a POC; retry once.

---

## 2. The catalog at a glance

Each layer is a STAC **collection**. This table is your cheat-sheet - the
`collection id` goes into every STAC and tile URL, and the **render params** are
what make a layer look right (skip them and a single-band layer renders black).
It is the **canonical copy** for integrators: the PhilSA webmap
(`webmap/src/config.ts`) and the partner template restate these params, and all
are kept in step with the `renders` metadata the catalog publishes.

| Collection id | What it is | Dated? | Access | Render params (TiTiler query string) | Value unit |
|---|---|---|---|---|---|
| `sentinel2-truecolor` | Natural-colour optical (Sentinel-2, 10 m) | yes | open | *(none - RGB auto-detected)* | - |
| `sentinel2-ndvi` | Vegetation health / greenness | yes | open | `rescale=-0.2,0.9&colormap_name=rdylgn` | NDVI |
| `sentinel1-ratio` | Radar vegetation index (VH/VV, sees through cloud) | yes | open | `rescale=-14,-2&colormap_name=ylgn` | dB (VH/VV) |
| `sentinel1-sar` | Radar backscatter (VV, all-weather) | yes | open | `rescale=20,52` | dB (VV) |
| `sentinel1-flood` | Open-water / flood mask ⚠️ POC proxy | yes | **restricted** | `colormap=` *(categorical, see section 6)* | - |
| `esri-10m-lulc` | Annual land cover (10 m, 2025) | no | open | `colormap=` *(categorical, see section 6)* | - |

- **Dated?** "yes" = a per-acquisition-date collection; you pick a `YYYY-MM-DD`
  and get that day's image. "no" = a single date-independent layer (annual LULC).
- **Access.** "open" needs no credential, ever. "restricted" needs an API key -
  section 2a. Every recipe in section 5 works as written for the open layers.
- ⚠️ **`sentinel1-flood` is a POC proxy, not a validated flood product.** Fine for
  visualisation/demos; do **not** drive payouts or official decisions off it
  without a validated source (Copernicus EMS/GFM) or ground calibration.

### 2a. The restricted tier

The **Access** column in section 2 is the current list of restricted
collections - treat it as the authority, since the tier grows over time.
`sentinel1-flood` was the first of them. A restricted collection behaves like any
other once you hold a credential, and like it does not exist until you do.
Concretely, without a key:

- it is **absent** from `GET /collections` - what you get back is the open subset;
- `GET /collections/<id>` and any `/search` naming it return **401**;
- its tiles return **401** from TiTiler;
- its pixels are **not** on the public R2 store - the `url=` recipes in sections 5
  and 6 will 404 against `pub-….r2.dev` for those collections.

None of that is an outage. It is the governance tier working as designed, and it
is why an app should treat a 401 as "you need access", not as a failure to retry.

**Getting a key.** Contact the PhilSA geospatial platform team; they issue one
per consuming organisation and can revoke it individually. Then send it as a
header on **both** gateways:

```bash
curl -H "X-API-Key: philsa_…" \
  https://philsa-stac-gateway.philsa.workers.dev/collections/sentinel1-flood
```

**An API key is a server-side secret.** It belongs in your backend's environment,
never in browser JavaScript or a public repo - anything shipped to a browser is
readable by every visitor. Browser apps should proxy through your own server, or
stick to the open layers. (A future Auth0 sign-in will cover browser users
properly; keys are for server-to-server consumers.)

**Downloading restricted pixels.** Restricted assets carry an
`s3://…` href that no client can fetch directly. Exchange it for a short-lived
signed URL, then range-read that with GDAL/rasterio/QGIS as usual:

```bash
curl -H "X-API-Key: philsa_…" \
  "https://philsa-stac-gateway.philsa.workers.dev/assets/sign?url=<asset href>"
# → {"url":"https://….r2.cloudflarestorage.com/…?X-Amz-Signature=…",
#    "expires_in":300,"expires_at":"…"}
```

The URL expires in 5 minutes by default (`&expires_in=` up to 900 s), so sign per
operation rather than caching one. Large COGs stream straight from storage - they
never proxy through the gateway. Every signing is logged against your key.

---

## 3. Two-minute quickstart (curl)

```bash
STAC=https://philsa-stac-gateway.philsa.workers.dev

# 1. What layers exist? (the endpoint pages at 10 by default — ask for the lot)
curl -s "$STAC/collections?limit=1000" | jq '.collections[].id'

# Most of those are the PhilSA STAC mirrored in *by reference*: browsable here,
# but their pixels live upstream (each carries "philsa:mirrored_from" plus a
# rel=via link to the original record). PhilSA's own ready-to-render products
# are the ones without that field — sort them to the front, or filter them out:
curl -s "$STAC/collections?limit=1000&sortby=-philsa:mirrored_from" | jq '.collections[].id'
curl -s "$STAC/collections?limit=1000" \
  | jq -r '.collections[] | select(has("philsa:mirrored_from") | not) | .id'

# 2. Which dates does NDVI have?
curl -s "$STAC/collections/sentinel2-ndvi/items?limit=100" \
  | jq -r '.features[].properties.datetime' | sort -u

# 3. What's over my area of interest? (bbox = minLon,minLat,maxLon,maxLat)
curl -s -X POST "$STAC/search" -H 'Content-Type: application/json' -d '{
  "collections": ["sentinel2-ndvi"],
  "bbox": [120.5, 15.5, 121.0, 16.0],
  "datetime": "2026-07-01T00:00:00Z/2026-07-14T23:59:59Z",
  "limit": 10
}' | jq '.features[] | {id, date: .properties.datetime, cog: .assets.data.href}'
```

That's the whole discovery surface: `GET /collections`,
`GET /collections/{id}/items`, and `POST /search`.

---

## 4. Concepts you need (30 seconds)

- **Discover, then render.** Use STAC to find *which* image (collection + date +
  area); use TiTiler to *draw* it. They're separate calls.
- **Per-date mosaic, with a fallback.** For a dated layer, PhilSA usually
  publishes a seamless **MosaicJSON** stitching that day's granules into one
  layer. When a date has no mosaic, render the individual item **COGs** instead.
  (Both recipes are below; section 6 shows how to choose automatically.)
- **Tiles are `WebMercatorQuad` (EPSG:3857) at `tilesize=512`.** That matches
  every web map library's default grid. Mount 512-px sources as `tileSize: 512`.
- **No API key for the open layers, and no CORS setup on your side.** The STAC
  API and TiTiler send permissive CORS headers, so browser apps can call them
  cross-origin out of the box. (Restricted layers need a key and a server to hold
  it - section 2a.) The other exception is the public R2 store: until PhilSA applies its read CORS
  policy to the bucket (`deploy/r2/apply-cors.sh`, PhilSA-side, one-time), a
  browser can't probe the per-date mosaics directly, and the section 5 recipes silently
  fall back from the single-source mosaic to per-item COGs - still correct, just
  a few more tile sources.

---

## 5. Recipes

Set these once and reuse them in every snippet:

```js
const STAC  = "https://philsa-stac-gateway.philsa.workers.dev";
const TILER = "https://philsa-tiles-gateway.philsa.workers.dev";
const R2    = "https://pub-17ab60a2ca7142a48ae8e2685cd853f7.r2.dev";
```

### 5a. MapLibre GL JS

```js
// Add PhilSA's NDVI for a given date onto YOUR MapLibre map.
async function addPhilSANdvi(map, date /* "2026-07-07" */) {
  const params = "rescale=-0.2,0.9&colormap_name=rdylgn";  // from the section 2 table
  const tiles = await philsaTiles("sentinel2-ndvi", date, params);
  map.addSource("philsa-ndvi", { type: "raster", tileSize: 512, tiles });
  map.addLayer({ id: "philsa-ndvi", type: "raster", source: "philsa-ndvi" });
}

// Returns the XYZ tile-URL template(s) for a dated layer: the per-date mosaic if
// one exists, else that day's item COGs. Mirrors how the PhilSA webmap builds it.
async function philsaTiles(collection, date, params) {
  const mosaic = `${R2}/02-silver/${collection}/mosaics/${collection}_${date}.mosaicjson`;
  const head = await fetch(mosaic, { method: "HEAD" }).catch(() => null);
  if (head && head.ok) {
    return [`${TILER}/mosaicjson/tiles/WebMercatorQuad/{z}/{x}/{y}.png` +
            `?tilesize=512&url=${encodeURIComponent(mosaic)}&${params}`];
  }
  // fallback: one tile source per granule COG on that date
  const r = await fetch(`${STAC}/search`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collections: [collection], datetime:
      `${date}T00:00:00Z/${date}T23:59:59Z`, limit: 100 }),
  });
  if (r.status === 401) throw new Error(`"${collection}" is restricted - see section 2a`);
  const { features } = await r.json();
  return features.filter(f => f.assets?.data?.href).map(f =>
    `${TILER}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png` +
    `?tilesize=512&url=${encodeURIComponent(f.assets.data.href)}&${params}`);
}
```

This helper covers the **open** layers. Point it at a restricted collection from a
browser and both paths fail by design - the mosaic 404s (those bytes aren't on
public R2) and the search 401s - hence the explicit check. Restricted layers go
through your own backend, which holds the key and adds the `X-API-Key` header to
both the search and the tile requests.

### 5b. Leaflet

```js
// Same idea, Leaflet flavour. Grab tiles with the helper from 5a, then:
const tiles = await philsaTiles("sentinel1-ratio", "2026-07-07",
                                "rescale=-14,-2&colormap_name=ylgn");
tiles.forEach(url =>
  L.tileLayer(url, { tileSize: 512, zoomOffset: 0, opacity: 0.9,
                     attribution: "EO layer © PhilSA" }).addTo(map));
```

### 5c. QGIS (desktop, no code)

Two ways in:

- **As an XYZ tile layer** - Browser panel ▸ right-click **XYZ Tiles** ▸ **New
  Connection**, and paste a full tile URL with the placeholders left literal, e.g.
  NDVI via the per-date mosaic:

  ```
  https://philsa-tiles-gateway.philsa.workers.dev/mosaicjson/tiles/WebMercatorQuad/{z}/{x}/{y}.png?tilesize=512&url=https://pub-17ab60a2ca7142a48ae8e2685cd853f7.r2.dev/02-silver/sentinel2-ndvi/mosaics/sentinel2-ndvi_2026-07-07.mosaicjson&rescale=-0.2,0.9&colormap_name=rdylgn
  ```

- **As a STAC catalog** - install the **STAC API Browser** plugin, add
  `https://philsa-stac-gateway.philsa.workers.dev` as a connection, search a collection, and
  load an item's `data` (COG) asset directly. Open COGs are public, so QGIS
  streams only the pixels in view. For a restricted layer, paste a freshly signed
  URL from section 2a instead - and mind that it expires in five minutes.

### 5d. Python (server-side: zonal stats over your own parcels)

This is the pattern for computing a per-parcel index - e.g. average NDVI over each
insured farm polygon - straight into your own database.

```python
# pip install pystac-client rasterio shapely
from pystac_client import Client
import rasterio, rasterio.mask, numpy as np

STAC = "https://philsa-stac-gateway.philsa.workers.dev"
cat = Client.open(STAC)

# your farm polygon, GeoJSON geometry in EPSG:4326
farm = {"type": "Polygon", "coordinates": [[[120.7,15.7],[120.72,15.7],
                                            [120.72,15.72],[120.7,15.72],[120.7,15.7]]]}

# find NDVI images intersecting the farm in a date window
items = cat.search(
    collections=["sentinel2-ndvi"],
    intersects=farm,
    datetime="2026-07-01/2026-07-14",
).item_collection()

for it in items:
    href = it.assets["data"].href           # public COG on R2
    with rasterio.open(href) as src:         # streamed via /vsicurl, no download
        # filled=False returns a MASKED array: pixels outside the parcel and the
        # COG's declared nodata are masked, whatever the nodata convention. Then
        # masked_invalid() also drops NaN pixels (COGs that mark nodata as NaN
        # without a tag) - never compare against np.nan, NaN != NaN.
        arr, _ = rasterio.mask.mask(src, [farm], crop=True, filled=False)
        data = np.ma.masked_invalid(arr[0].astype("float32"))
        valid = data.compressed()            # 1-D array of in-parcel, valid pixels
        if valid.size:
            print(it.datetime.date(), "mean NDVI =", round(float(valid.mean()), 3),
                  "| coverage =", round(valid.size / data.size, 2))
```

Report that **coverage** ratio next to the mean: a small parcel or a cloudy swath
may cover only part of the field, and you want low-confidence values flagged, not
silently trusted.

---

## 6. Building tile URLs precisely

Every TiTiler tile URL is the same shape - a base path, the `url=` of what to
render, and the **render params** from section 2:

```
# a single COG (per-item / fallback):
{TILER}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?tilesize=512&url=<COG_HREF>&<PARAMS>

# a per-date mosaic (seamless day):
{TILER}/mosaicjson/tiles/WebMercatorQuad/{z}/{x}/{y}.png?tilesize=512&url=<MOSAIC_URL>&<PARAMS>
```

Where:

- `<COG_HREF>` comes from a STAC item's `assets.data.href`.
- `<MOSAIC_URL>` is `{R2}/02-silver/<collection>/mosaics/<collection>_<DATE>.mosaicjson`.
- `<PARAMS>` is the render string for the collection (section 2). **URL-encode** the
  `url=` value; leave `{z}/{x}/{y}` literal for your map library to fill.

### Categorical layers (colormap JSON)

Two layers use a discrete class→RGBA colormap instead of a rescale. Pass it as a
**URL-encoded** JSON object in `colormap=`:

```jsonc
// sentinel1-flood  (water classes coloured; land left transparent) - restricted, section 2a
colormap = {"1":[33,102,204,255], "2":[120,170,230,255]}

// esri-10m-lulc  (Impact Observatory 9-class palette)
colormap = {"1":[26,91,171,255],  "2":[53,130,33,255],  "4":[135,209,158,255],
            "5":[255,219,92,255],  "7":[237,2,42,255],   "8":[237,233,228,255],
            "9":[242,250,255,255], "10":[200,200,200,255],"11":[198,173,141,255]}
```

```js
const params = "colormap=" + encodeURIComponent(JSON.stringify(
  {"1":[33,102,204,255], "2":[120,170,230,255]}));   // → sentinel1-flood tiles
```

`esri-10m-lulc` is **date-independent**: it has no per-date mosaic - search its
items (`POST /search` with just `{"collections":["esri-10m-lulc"]}`) and render
each `assets.data.href` COG with the categorical `colormap` above.

---

## 7. Overlaying your own data - the integration pattern

The point of all this is to draw PhilSA's layers *underneath or beside your own*.
The division of labour:

- **PhilSA provides** the EO layers (this guide) - and, if useful, PH admin
  boundaries as vector **PMTiles** on the same public R2
  (`…/02-silver/ph-admin-boundaries/pmtiles/phl_adm{0..4}.pmtiles`).
- **You provide** your own vectors - farm parcels, claims, assets, road networks -
  as your own GeoJSON/vector layers in the same map.

So a typical agency map is: your parcels on top → PhilSA NDVI/radar tiles below →
basemap at the bottom. In code that's just adding a PhilSA raster source (sections 5a and 5b)
and your own `geojson` source to the same map instance. For analysis (section 5d), it's
your geometries × PhilSA COGs → your numbers in your database.

---

## 8. Rules of the road

- **Read-only.** The API never accepts writes. Don't build a workflow that expects
  to push data back - you pull and render.
- **Two tiers, and a 401 is an answer.** Most of section 2 is open and needs no key; the
  layers marked *restricted* need one (section 2a). Treat `401` as "request access", not
  as an error to retry - and never ship a key to a browser.
- **Be gentle (rate limits).** Shared free-tier infra. Cache tiles on your side,
  don't hammer `POST /search` in tight loops, and prefer the per-date **mosaic**
  (one source) over many per-item COG sources when a mosaic exists.
- **Expect cold starts** (~30–60 s after idle) and retry once.
- **Attribute.** Credit **PhilSA** (and the underlying mission - Sentinel /
  Copernicus, ESRI/Impact Observatory for LULC) on maps and derived products.
- **Mind the caveats.** `sentinel1-flood` is a POC proxy; NDVI/SAR indices are not
  calibrated crop products; optical layers are cloud- and daylight-limited (use
  the radar layers through monsoon cloud). Report per-parcel **coverage %** with
  any zonal statistic.

---

## 9. Where to look

- **Browse the catalog visually** - the STAC Browser and the PhilSA webmap render
  exactly these endpoints; use them to eyeball a layer/date before you wire it up.
- **Every collection's metadata** - `GET /collections/{id}` returns its extent,
  license, and description. Restricted collections also carry
  `"philsa:access": "restricted"`; open ones omit the property, so treat *absent*
  as open. It's a label for humans and auditors - the gateway enforces the tier
  regardless of what the metadata says.
- **Questions / a restricted-tier key / a new layer** - contact the PhilSA
  geospatial platform team.
