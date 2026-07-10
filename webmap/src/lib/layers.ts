// Layer factory: turn (collection, date) into a serializable MapLayer.
// This is the one place that knows how a STAC collection becomes tiles, so the
// panel and the AI's add_layers tool produce byte-identical layers.

import { mosaicJsonUrl, rasterDef, RASTER_DEFS } from "../config";
import { cogTileUrl, mosaicTileUrl } from "./titiler";
import { searchStac } from "./stac";
import { describePasses, summarizePasses, type PassSummary } from "./passes";
import type { MapLayer } from "../state/mapStore";

// A day's mosaic exists only for collections build_raster_mosaics.sh covers
// (flood isn't among them yet) — probe with a HEAD and fall back to rendering
// each item's COG directly when absent.
async function mosaicExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

export class LayerBuildError extends Error {}

// Fold a per-date pass summary into the layer description so the hover/tooltip
// (and any AI read of the layer) carries it alongside the static blurb.
function withPasses(desc: string | undefined, passes: PassSummary[]): string | undefined {
  if (!passes.length) return desc;
  const note = describePasses(passes);
  return desc ? `${desc}\n\n${note}` : note;
}

// Build a raster layer for one collection: dated (temporal) or whole
// (date-independent, e.g. annual LULC). Throws LayerBuildError with a
// user/model-readable reason when there's nothing to show.
export async function buildRasterLayer(
  collection: string,
  date?: string,
): Promise<MapLayer> {
  const def = rasterDef(collection);
  if (!def) {
    throw new LayerBuildError(
      `Unknown collection "${collection}" — the webmap styles: ${RASTER_DEFS.map(
        (r) => r.id,
      ).join(", ")}.`,
    );
  }

  if (!def.temporal) {
    const items = await searchStac({ collections: [collection], limit: 100 });
    const tiles = items
      .filter((i) => i.cogHref)
      .map((i) => cogTileUrl(i.cogHref!, def.titilerParams));
    if (!tiles.length)
      throw new LayerBuildError(`No COG items found in "${collection}".`);
    return {
      id: collection,
      kind: "raster-cogs",
      label: def.label,
      collection,
      tiles,
      opacity: 1,
      visible: true,
      legend: def.legend,
      description: def.description,
    };
  }

  if (!date) {
    throw new LayerBuildError(
      `"${collection}" is a per-acquisition-date collection — pass a YYYY-MM-DD date (use search_catalog to find available dates).`,
    );
  }

  // Fetch this date's granules once: they drive the pass summary (so the panel
  // and AI can flag when a single date's mosaic combines multiple passes) and
  // the per-item fallback when no mosaic exists.
  const items = await searchStac({
    collections: [collection],
    datetime: date,
    limit: 100,
  });
  const passes = summarizePasses(items);

  const mosaic = mosaicJsonUrl(collection, date);
  if (await mosaicExists(mosaic)) {
    return {
      id: `${collection}:${date}`,
      kind: "raster-mosaic",
      label: `${def.label} — ${date}`,
      collection,
      date,
      tiles: [mosaicTileUrl(mosaic, def.titilerParams)],
      opacity: 1,
      visible: true,
      legend: def.legend,
      description: withPasses(def.description, passes),
      passes,
    };
  }

  // No per-date mosaic — render that day's item COGs individually.
  const tiles = items
    .filter((i) => i.cogHref)
    .map((i) => cogTileUrl(i.cogHref!, def.titilerParams));
  if (!tiles.length) {
    throw new LayerBuildError(
      `"${collection}" has no items on ${date} — use search_catalog to find dates with data.`,
    );
  }
  return {
    id: `${collection}:${date}`,
    kind: "raster-cogs",
    label: `${def.label} — ${date}`,
    collection,
    date,
    tiles,
    opacity: 1,
    visible: true,
    legend: def.legend,
    description: withPasses(def.description, passes),
    passes,
  };
}
