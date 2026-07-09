// The single source of truth for what's on the map. Both drivers mutate it:
// the layer panel (human clicks) and the AI's client-executed tools. Keeping
// every layer a plain serializable object is what makes the map AI-drivable —
// `snapshot()` is sent with each chat turn so the model sees the live state.

import { create } from "zustand";
import type { FeatureCollection } from "geojson";
import type { Legend } from "../config";
import { ADMIN_LAYERS } from "../config";
import type { PassSummary } from "../lib/passes";

export type LayerKind =
  | "raster-mosaic"
  | "raster-cogs"
  | "vector-pmtiles"
  | "geojson-local";

export interface MapLayer {
  id: string; // unique, e.g. "sentinel1-flood:2026-06-05"
  kind: LayerKind;
  label: string;
  collection?: string; // STAC collection (raster layers)
  date?: string; // YYYY-MM-DD acquisition date (temporal rasters)
  tiles: string[]; // XYZ templates — one per MapLibre source
  pmtilesUrl?: string; // vector-pmtiles only
  sourceLayer?: string; // vector-pmtiles only
  // geojson-local only: inline features parsed from a file the user dropped in,
  // rendered entirely client-side (nothing is uploaded). Kept off snapshot() so
  // the raw geometry never gets shipped to the chat backend.
  geojson?: FeatureCollection;
  color?: string; // vector line / geojson stroke colour
  width?: number; // vector line width
  minzoom?: number;
  opacity: number; // 0..1 (rasters)
  visible: boolean;
  legend?: Legend;
  description?: string;
  // Satellite passes stitched into this date's mosaic. >1 means the date mixes
  // observations (different satellite/orbit/look geometry) — surfaced so users
  // aren't misled into treating the mosaic as a single coherent acquisition.
  passes?: PassSummary[];
}

export type Bbox = [number, number, number, number]; // [w, s, e, n]

// What the chat backend receives as "current map state" each turn.
export interface MapSnapshot {
  layers: {
    id: string;
    label: string;
    collection?: string;
    date?: string;
    visible: boolean;
    opacity: number;
  }[];
  view: { bbox?: Bbox };
}

interface MapStore {
  layers: MapLayer[];
  // fitBounds request: nonce bumps so MapView reacts even to the same bbox.
  view: { bbox?: Bbox; nonce: number };
  addLayer: (layer: MapLayer) => void;
  removeLayers: (ids: string[]) => string[];
  updateLayer: (
    id: string,
    patch: Partial<Pick<MapLayer, "visible" | "opacity">>,
  ) => boolean;
  setViewBbox: (bbox: Bbox) => void;
  // Written back by MapView on move-end so snapshots carry the real extent.
  reportViewport: (bbox: Bbox) => void;
  snapshot: () => MapSnapshot;
}

// Admin outlines are ordinary store layers, seeded at startup, so "hide the
// province outlines" works the same whether a human or the AI asks for it.
const seedLayers: MapLayer[] = ADMIN_LAYERS.map((a) => ({
  id: a.id,
  kind: "vector-pmtiles",
  label: a.label,
  tiles: [],
  pmtilesUrl: a.pmtilesUrl,
  sourceLayer: a.sourceLayer,
  color: a.color,
  width: a.width,
  minzoom: a.minzoom,
  opacity: 1,
  visible: a.defaultOn,
}));

let currentViewport: Bbox | undefined;

export const useMapStore = create<MapStore>((set, get) => ({
  layers: seedLayers,
  view: { bbox: undefined, nonce: 0 },

  addLayer: (layer) =>
    set((s) => ({
      // replace-on-same-id keeps adds idempotent (re-asking for a layer that's
      // already on just refreshes it instead of stacking duplicates)
      layers: [...s.layers.filter((l) => l.id !== layer.id), layer],
    })),

  removeLayers: (ids) => {
    const existing = get().layers.filter((l) => ids.includes(l.id));
    set((s) => ({ layers: s.layers.filter((l) => !ids.includes(l.id)) }));
    return existing.map((l) => l.id);
  },

  updateLayer: (id, patch) => {
    const found = get().layers.some((l) => l.id === id);
    if (found) {
      set((s) => ({
        layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      }));
    }
    return found;
  },

  setViewBbox: (bbox) =>
    set((s) => ({ view: { bbox, nonce: s.view.nonce + 1 } })),

  reportViewport: (bbox) => {
    currentViewport = bbox;
  },

  snapshot: () => ({
    layers: get().layers.map((l) => ({
      id: l.id,
      label: l.label,
      collection: l.collection,
      date: l.date,
      visible: l.visible,
      opacity: l.opacity,
    })),
    view: { bbox: currentViewport },
  }),
}));
