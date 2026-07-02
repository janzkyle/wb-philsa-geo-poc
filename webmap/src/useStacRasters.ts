import { useEffect, useState } from "react";
import { STAC_API, TITILER } from "./config";

export interface RasterItem {
  id: string;
  tileUrl: string; // XYZ template with {z}/{x}/{y}
  datetime?: string; // RFC 3339 acquisition time, if the item carries one
}

// Build a TiTiler XYZ template for a single COG. {z}/{x}/{y} stay as literal
// placeholders for MapLibre to fill; only the COG url is encoded.
function titilerTileUrl(cogUrl: string, params: string): string {
  const qs = `url=${encodeURIComponent(cogUrl)}${params ? "&" + params : ""}`;
  return `${TITILER}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${qs}`;
}

// XYZ template for a per-date MosaicJSON (many COGs stitched seamlessly).
// `mosaicUrl` points at the hosted .mosaicjson; TiTiler reads it server-side.
export function mosaicTileUrl(mosaicUrl: string, params: string): string {
  const qs = `url=${encodeURIComponent(mosaicUrl)}${params ? "&" + params : ""}`;
  return `${TITILER}/mosaicjson/tiles/WebMercatorQuad/{z}/{x}/{y}.png?${qs}`;
}

// Discover every item in a STAC collection and turn each item's COG `data`
// asset into a TiTiler raster source. The collection's COGs together tile the
// area of interest (Tier 1 has only ~9 items per collection).
export function useStacRasters(collection: string, params: string) {
  const [items, setItems] = useState<RasterItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${STAC_API}/collections/${collection}/items?limit=200`,
        );
        if (!res.ok) throw new Error(`STAC ${res.status}`);
        const fc = await res.json();
        const out: RasterItem[] = [];
        for (const f of fc.features ?? []) {
          const href = f.assets?.data?.href;
          if (!href) continue;
          out.push({
            id: f.id,
            tileUrl: titilerTileUrl(href, params),
            // STAC items use `datetime`, or start/end for a range item.
            datetime: f.properties?.datetime ?? f.properties?.start_datetime,
          });
        }
        if (!cancelled) setItems(out);
      } catch (e) {
        // POC: a failed collection just renders nothing; log so it's not silent.
        if (!cancelled) console.error(`useStacRasters(${collection}):`, e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collection, params]);

  return { items };
}
