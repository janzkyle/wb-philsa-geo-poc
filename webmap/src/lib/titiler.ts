// XYZ tile-URL builders for TiTiler. {z}/{x}/{y} stay literal placeholders
// for MapLibre to fill; only the source URL is encoded.

import { TITILER } from "../config";

// Single COG via /cog.
export function cogTileUrl(cogUrl: string, params: string): string {
  const qs = `url=${encodeURIComponent(cogUrl)}${params ? "&" + params : ""}`;
  return `${TITILER}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${qs}`;
}

// Per-date MosaicJSON (many COGs stitched seamlessly) via /mosaicjson.
export function mosaicTileUrl(mosaicUrl: string, params: string): string {
  const qs = `url=${encodeURIComponent(mosaicUrl)}${params ? "&" + params : ""}`;
  return `${TITILER}/mosaicjson/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${qs}`;
}
