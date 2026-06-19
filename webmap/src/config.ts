// Endpoints + layer definitions for the Tier 1 PhilSA webmap.
// Override any of these at build time with a VITE_* env var (see .env.example).

export const STAC_API =
  import.meta.env.VITE_STAC_API ?? "http://localhost:8082";

// TiTiler — dynamic raster tiler for the silver COGs (compose.viz.yml, port 8083).
export const TITILER =
  import.meta.env.VITE_TITILER ?? "http://localhost:8083";

// Public R2 base that serves the admin-boundary PMTiles (and COGs).
export const R2_PUBLIC_BASE =
  import.meta.env.VITE_R2_PUBLIC_BASE ??
  "https://pub-17ab60a2ca7142a48ae8e2685cd853f7.r2.dev";

const PMTILES_PREFIX = "02-silver/ph-admin-boundaries/pmtiles";
const SILVER_PREFIX = "02-silver";

// Public R2 URL of the per-date MosaicJSON for a raster collection. Built by
// `pipelines/02-silver/build_raster_mosaics.sh`; each one stitches a single day's
// COG granules into a seamless layer TiTiler serves via /mosaicjson. `date` is YYYY-MM-DD.
export function mosaicJsonUrl(collection: string, date: string): string {
  return `${R2_PUBLIC_BASE}/${SILVER_PREFIX}/${collection}/mosaics/${collection}_${date}.mosaicjson`;
}

// Admin-boundary vector layers, drawn as outlines over the basemap.
// `sourceLayer` is the tippecanoe layer name baked into each PMTiles archive.
export interface AdminLayer {
  id: string;
  label: string;
  sourceLayer: string;
  url: string; // pmtiles:// URL
  color: string;
  width: number;
  minzoom?: number;
}

export const ADMIN_LAYERS: AdminLayer[] = [
  {
    id: "adm0",
    label: "Country (adm0)",
    sourceLayer: "adm0",
    url: `pmtiles://${R2_PUBLIC_BASE}/${PMTILES_PREFIX}/phl_adm0.pmtiles`,
    color: "#1a237e",
    width: 1.6,
  },
  {
    id: "adm1",
    label: "Regions (adm1)",
    sourceLayer: "adm1",
    url: `pmtiles://${R2_PUBLIC_BASE}/${PMTILES_PREFIX}/phl_adm1.pmtiles`,
    color: "#3949ab",
    width: 1.0,
  },
  {
    id: "adm2",
    label: "Provinces (adm2)",
    sourceLayer: "adm2",
    url: `pmtiles://${R2_PUBLIC_BASE}/${PMTILES_PREFIX}/phl_adm2.pmtiles`,
    color: "#7986cb",
    width: 0.6,
    minzoom: 5,
  },
];

// Raster (COG) layers served through TiTiler. Each collection's items are
// discovered from the STAC API at runtime; `titilerParams` controls styling.
export interface RasterLayerDef {
  id: string;
  label: string;
  collection: string;
  titilerParams: string; // extra query string for /cog/tiles (no leading &)
  defaultOn: boolean;
  description: string; // one-line plain-language summary for the layer guide
}

export const RASTER_LAYERS: RasterLayerDef[] = [
  {
    id: "sentinel2-truecolor",
    label: "Sentinel-2 True Colour",
    collection: "sentinel2-truecolor",
    // 8-bit RGB TCI COG — TiTiler auto-detects the 3 bands.
    titilerParams: "",
    defaultOn: true,
    description:
      "Natural-colour optical view (Sentinel-2, 10 m). Land and clouds as the eye would see them; daylight only.",
  },
  {
    id: "sentinel2-ndvi",
    label: "Sentinel-2 NDVI",
    collection: "sentinel2-ndvi",
    // single-band float32 — needs a stretch + colormap or it renders black.
    titilerParams: "rescale=-0.2,0.9&colormap_name=rdylgn",
    defaultOn: false,
    description:
      "Vegetation greenness index (Sentinel-2). Green = dense/healthy vegetation, red = bare soil or water.",
  },
  {
    id: "sentinel1-sar",
    label: "Sentinel-1 SAR (VV)",
    collection: "sentinel1-sar",
    // single-band float32 VV backscatter (dB) — grayscale; rescale ≈ mean ±2σ.
    // NoData (-9999) is declared in the COG, so TiTiler masks it automatically.
    titilerParams: "rescale=20,52",
    defaultOn: false,
    description:
      "Radar backscatter (Sentinel-1 VV, grayscale). Sees through cloud and works day or night; bright = rough/built-up, dark = smooth/water.",
  },
];

// Initial view: Luzon, where the S2 true-colour / NDVI coverage overlaps.
export const INITIAL_VIEW = {
  longitude: 121.6,
  latitude: 16.2,
  zoom: 6.2,
};
