// Client-side execution of the chat assistant's tools. The server
// (server/chat.mjs) declares the tool schemas but defines no `execute`, so the
// AI SDK forwards every call here - where the STAC API, the admin index and
// the layer store all live. Tool names/inputs must stay in sync with the
// schemas in server/chat.mjs.

import { searchStac, listCollections, collectionPassesByDate } from "../lib/stac";
import { resolveRegion } from "../lib/regions";
import { pointToBbox, buildHighlightLayer } from "../lib/geo";
import { buildRasterLayer, LayerBuildError } from "../lib/layers";
import { formatPass } from "../lib/passes";
import { useMapStore } from "../state/mapStore";
import type { Bbox } from "../state/mapStore";

// Tool results go back into the model's context - keep them small and, on
// failure, actionable (say what to try instead, not just "error").

interface SearchInput {
  collections?: string[];
  bbox?: Bbox;
  datetime?: string;
  limit?: number;
}

async function searchCatalog(input: SearchInput) {
  const items = await searchStac({
    collections: input.collections,
    bbox: input.bbox,
    datetime: input.datetime,
    limit: input.limit ?? 100,
  });

  if (items.length === 0 && input.datetime) {
    // Nothing in the requested window - tell the model what IS available so
    // "no data" becomes "nearest dates are …" instead of a dead end.
    const fallback = await searchStac({
      collections: input.collections,
      bbox: input.bbox,
      limit: 200,
    });
    const datesByCollection: Record<string, string[]> = {};
    for (const it of fallback) {
      if (!it.date) continue;
      (datesByCollection[it.collection] ??= []).push(it.date);
    }
    for (const c of Object.keys(datesByCollection)) {
      datesByCollection[c] = [...new Set(datesByCollection[c])].sort();
    }
    return {
      matched: 0,
      note: "No items in the requested datetime range (for this area, if a bbox was given). Available acquisition dates per collection follow - offer the nearest ones to the user.",
      available_dates: datesByCollection,
    };
  }

  const datesByCollection: Record<string, string[]> = {};
  for (const it of items) {
    if (!it.date) continue;
    (datesByCollection[it.collection] ??= []).push(it.date);
  }
  for (const c of Object.keys(datesByCollection)) {
    datesByCollection[c] = [...new Set(datesByCollection[c])].sort();
  }
  return {
    matched: items.length,
    dates_by_collection: datesByCollection,
    items: items.slice(0, 25).map((i) => ({
      id: i.id,
      collection: i.collection,
      date: i.date,
    })),
  };
}

interface AddLayersInput {
  layers: { collection: string; date?: string }[];
}

async function addLayers(input: AddLayersInput) {
  const store = useMapStore.getState();
  const added: string[] = [];
  const errors: string[] = [];
  for (const req of input.layers ?? []) {
    try {
      const layer = await buildRasterLayer(req.collection, req.date);
      store.addLayer(layer);
      added.push(layer.id);
    } catch (e) {
      if (e instanceof LayerBuildError) errors.push(e.message);
      else throw e;
    }
  }
  return { added, errors: errors.length ? errors : undefined };
}

export async function executeTool(
  toolName: string,
  input: unknown,
): Promise<unknown> {
  const store = useMapStore.getState();
  try {
    switch (toolName) {
      case "list_collections": {
        const cols = await listCollections();
        // Collections mirrored by reference from the PhilSA STAC keep their
        // assets upstream (s3://eodata/…), so they're discoverable but not
        // renderable here. They also outnumber the POC's own layers ~10:1, so
        // they go last with a trimmed description and an explicit flag — the
        // assistant should reach for a renderable layer first.
        const own = cols.filter((c) => !c.mirroredFrom);
        const mirrored = cols.filter((c) => c.mirroredFrom);
        return {
          collections: [
            ...own.map((c) => ({
              id: c.id,
              title: c.title,
              description: c.description?.slice(0, 200),
              temporal_extent: c.extent?.temporal?.[0],
            })),
            ...mirrored.map((c) => ({
              id: c.id,
              title: c.title,
              description: c.description?.slice(0, 100),
              temporal_extent: c.extent?.temporal?.[0],
              reference_only: true,
              mirrored_from: c.mirroredFrom,
            })),
          ],
        };
      }
      case "resolve_region": {
        const { query, level } = input as { query: string; level?: number };
        const matches = await resolveRegion(query, level);
        if (!matches.length)
          return {
            matches: [],
            note: `No admin unit matched "${query}". Try a shorter name or the official one (e.g. "Region III (Central Luzon)" is matched by "Central Luzon").`,
          };
        return { matches };
      }
      case "resolve_point": {
        const { lat, lon, radius_km } = input as {
          lat: number;
          lon: number;
          radius_km?: number;
        };
        const radiusKm = radius_km ?? 5;
        const bbox = pointToBbox(lat, lon, radiusKm);
        return { bbox, center: [lon, lat], radius_km: radiusKm };
      }
      case "highlight_location": {
        const { bbox, label } = input as { bbox: Bbox; label?: string };
        const layer = buildHighlightLayer(bbox, label);
        store.addLayer(layer);
        return { highlighted: layer.id, bbox, label: label ?? null };
      }
      case "search_catalog":
        return await searchCatalog(input as SearchInput);
      case "get_available_dates": {
        const { collection } = input as { collection: string };
        const passesByDate = await collectionPassesByDate(collection);
        const dates = Object.keys(passesByDate).sort();
        // Only flag dates that combine >1 pass - single-pass dates need no caveat
        // and would just bloat the model's context.
        const multiPass: Record<string, string[]> = {};
        for (const d of dates) {
          if (passesByDate[d].length > 1)
            multiPass[d] = passesByDate[d].map(formatPass);
        }
        const hasMulti = Object.keys(multiPass).length > 0;
        return {
          collection,
          dates,
          multi_pass_dates: hasMulti ? multiPass : undefined,
          note: hasMulti
            ? "Dates in multi_pass_dates stitch several satellite passes (different orbit/look geometry) into one mosaic; SAR backscatter across passes is not directly comparable - mention this if the user measures or compares values."
            : undefined,
        };
      }
      case "add_layers":
        return await addLayers(input as AddLayersInput);
      case "remove_layers": {
        const { ids } = input as { ids: string[] };
        const removed = store.removeLayers(ids);
        const missing = ids.filter((id) => !removed.includes(id));
        return { removed, not_found: missing.length ? missing : undefined };
      }
      case "update_layer": {
        const { id, visible, opacity } = input as {
          id: string;
          visible?: boolean;
          opacity?: number;
        };
        const ok = store.updateLayer(id, {
          ...(visible !== undefined ? { visible } : {}),
          ...(opacity !== undefined ? { opacity } : {}),
        });
        return ok
          ? { updated: id }
          : { error: `No layer with id "${id}" - check the map state for current ids.` };
      }
      case "set_view": {
        const { bbox } = input as { bbox: Bbox };
        store.setViewBbox(bbox);
        return { view: bbox };
      }
      default:
        return { error: `Unknown tool "${toolName}".` };
    }
  } catch (e) {
    // Network/STAC failures surface to the model as plain results so it can
    // apologize usefully instead of the stream erroring out.
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
