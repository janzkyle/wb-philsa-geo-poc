// XYZ tile-URL builders for TiTiler. {z}/{x}/{y} stay literal placeholders
// for MapLibre to fill; only the source URL is encoded.
//
// Tiles are requested at 512 px (tilesize=512 - TiTiler 2.x's replacement for
// the old @2x path suffix) and mounted with tileSize: 512: the same on-screen
// resolution from a quarter of the requests. TiTiler renders every tile on
// demand (open COG, range-read, warp, encode), so per-request overhead
// dominates; halving the tile grid in each axis is the single biggest
// render-latency win.

import { R2_BUCKET, TITILER } from "../config";

// MapLibre source tileSize matching the tilesize=512 tiles below.
export const RASTER_TILE_SIZE = 512;

// STAC asset hrefs are catalogued on the public r2.dev host (browser-reachable
// for direct fetches), but TiTiler's own R2 reads should go over the
// authenticated endpoint - r2.dev is rate-limited and not for production tile
// traffic. Rewrite any r2.dev href to s3://<bucket>/<key> before handing it to
// TiTiler as a url= parameter; hrefs on other hosts (e.g. the ESRI LULC Azure
// blob, Diwata-2's GCS COG) pass through unchanged.
export function toR2S3Url(href: string): string {
  try {
    const u = new URL(href);
    if (u.hostname.endsWith(".r2.dev")) return `s3://${R2_BUCKET}${u.pathname}`;
  } catch {
    // not an absolute URL - fall through unchanged
  }
  return href;
}

// Single COG via /cog.
export function cogTileUrl(cogUrl: string, params: string): string {
  const qs = `url=${encodeURIComponent(toR2S3Url(cogUrl))}${params ? "&" + params : ""}`;
  return `${TITILER}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?tilesize=${RASTER_TILE_SIZE}&${qs}`;
}

// Per-date MosaicJSON (many COGs stitched seamlessly) via /mosaicjson.
export function mosaicTileUrl(mosaicUrl: string, params: string): string {
  const qs = `url=${encodeURIComponent(mosaicUrl)}${params ? "&" + params : ""}`;
  return `${TITILER}/mosaicjson/tiles/WebMercatorQuad/{z}/{x}/{y}.png?tilesize=${RASTER_TILE_SIZE}&${qs}`;
}
