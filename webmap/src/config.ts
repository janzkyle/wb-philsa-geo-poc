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

// Legend for the panel guide. A `ramp` is a continuous gradient bar (with end
// labels) for rescaled single-band layers; `classes` is a swatch list for a
// categorical layer. Layers with no meaningful colour range (e.g. native RGB)
// omit it. Colours must mirror the TiTiler styling in `titilerParams`.
export type Legend =
  | { kind: "ramp"; stops: string[]; minLabel: string; maxLabel: string }
  | { kind: "classes"; items: { color: string; label: string }[] };

// Raster (COG) layers served through TiTiler. Each collection's items are
// discovered from the STAC API at runtime; `titilerParams` controls styling.
export interface RasterLayerDef {
  id: string;
  label: string;
  collection: string;
  titilerParams: string; // extra query string for /cog/tiles (no leading &)
  defaultOn: boolean;
  description: string; // one-line plain-language summary for the layer guide
  legend?: Legend; // colour-bar / class legend shown in the guide
  // Per-acquisition-date layers (true/omitted) participate in the date picker and
  // render via a per-date MosaicJSON. A date-independent layer (false) — e.g. an
  // annual product — is excluded from the date filter and renders its COGs directly.
  temporal?: boolean;
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
    // RdYlGn ramp, matching colormap_name=rdylgn over the rescale −0.2 … 0.9.
    legend: {
      kind: "ramp",
      stops: [
        "#a50026", "#d73027", "#f46d43", "#fdae61", "#fee08b", "#ffffbf",
        "#d9ef8b", "#a6d96a", "#66bd63", "#1a9850", "#006837",
      ],
      minLabel: "−0.2 · bare / water",
      maxLabel: "dense veg · 0.9",
    },
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
    // Grayscale ramp over the rescale 20 … 52 dB (no colormap = black→white).
    legend: {
      kind: "ramp",
      stops: ["#000000", "#ffffff"],
      minLabel: "20 dB · smooth / water",
      maxLabel: "rough / built · 52 dB",
    },
  },
  {
    id: "esri-lulc",
    label: "ESRI Land Cover (10 m, 2025)",
    collection: "esri-10m-lulc",
    // Categorical uint8 class codes — NOT a continuous index, so it needs a
    // DISCRETE colormap (class value -> RGBA), not rescale + colormap_name.
    // Palette is the Impact Observatory 9-class scheme (matches the STAC item's
    // classification:classes). nodata=0 is declared in the COG, so TiTiler masks
    // tile overlap automatically. The collection holds a single year (2025), 8 PH
    // tiles, so loading all items is exactly one seamless layer.
    titilerParams: `colormap=${encodeURIComponent(
      JSON.stringify({
        "1": [26, 91, 171, 255], // Water
        "2": [53, 130, 33, 255], // Trees
        "4": [135, 209, 158, 255], // Flooded vegetation
        "5": [255, 219, 92, 255], // Crops
        "7": [237, 2, 42, 255], // Built area
        "8": [237, 233, 228, 255], // Bare ground
        "9": [242, 250, 255, 255], // Snow/ice
        "10": [200, 200, 200, 255], // Clouds
        "11": [198, 173, 141, 255], // Rangeland
      }),
    )}`,
    defaultOn: false,
    // Annual product — not tied to a Sentinel acquisition date. Excluded from the
    // date picker and rendered directly from its COGs (no per-date mosaic exists).
    temporal: false,
    description:
      "Annual land-cover classes (Impact Observatory, 10 m, 2025): water, trees, crops, built-up, bare, rangeland. Categorical context layer, not authoritative ground truth.",
    // Discrete 9-class legend — same colours as the discrete colormap above.
    legend: {
      kind: "classes",
      items: [
        { color: "#1A5BAB", label: "Water" },
        { color: "#358221", label: "Trees" },
        { color: "#87D19E", label: "Flooded veg." },
        { color: "#FFDB5C", label: "Crops" },
        { color: "#ED022A", label: "Built area" },
        { color: "#EDE9E4", label: "Bare ground" },
        { color: "#C6AD8D", label: "Rangeland" },
        { color: "#F2FAFF", label: "Snow / ice" },
        { color: "#C8C8C8", label: "Clouds" },
      ],
    },
  },
];

// Initial view: Luzon, where the S2 true-colour / NDVI coverage overlaps.
export const INITIAL_VIEW = {
  longitude: 121.6,
  latitude: 16.2,
  zoom: 6.2,
};
