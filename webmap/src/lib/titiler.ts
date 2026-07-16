// XYZ tile-URL builders for TiTiler. {z}/{x}/{y} stay literal placeholders
// for MapLibre to fill; only the source URL is encoded.
//
// Tiles are requested at 512 px (tilesize=512 - TiTiler 2.x's replacement for
// the old @2x path suffix) and mounted with tileSize: 512: the same on-screen
// resolution from a quarter of the requests. TiTiler renders every tile on
// demand (open COG, range-read, warp, encode), so per-request overhead
// dominates; halving the tile grid in each axis is the single biggest
// render-latency win.

import { TITILER } from "../config";

// MapLibre source tileSize matching the tilesize=512 tiles below.
export const RASTER_TILE_SIZE = 512;

// Single COG via /cog.
export function cogTileUrl(cogUrl: string, params: string): string {
  const qs = `url=${encodeURIComponent(cogUrl)}${params ? "&" + params : ""}`;
  return `${TITILER}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?tilesize=${RASTER_TILE_SIZE}&${qs}`;
}

// Per-date MosaicJSON (many COGs stitched seamlessly) via /mosaicjson.
export function mosaicTileUrl(mosaicUrl: string, params: string): string {
  const qs = `url=${encodeURIComponent(mosaicUrl)}${params ? "&" + params : ""}`;
  return `${TITILER}/mosaicjson/tiles/WebMercatorQuad/{z}/{x}/{y}.png?tilesize=${RASTER_TILE_SIZE}&${qs}`;
}
