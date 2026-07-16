// Client-side GeoJSON ingest: parse a file the user picked, normalise it to a
// FeatureCollection, and turn it into a store MapLayer. Nothing here touches the
// network — the parsed features live in the browser and MapLibre renders them
// inline (see GeojsonLayer in MapView), the same "upload data" behaviour TerriaJS
// offers for local files.

import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import type { Bbox, MapLayer } from "../state/mapStore";

export class GeoJsonError extends Error {}

// A rotating palette so successive uploads are visually distinguishable. Colour
// is picked by the caller from the count of geojson layers already on the map.
export const GEOJSON_COLORS = [
  "#e6550d", // orange
  "#31a354", // green
  "#756bb1", // purple
  "#c51b8a", // magenta
  "#2c7fb8", // blue
  "#d95f0e", // amber
];

// Parse arbitrary text into a FeatureCollection, accepting the three shapes a
// GeoJSON file can legally take (FeatureCollection, a bare Feature, or a raw
// geometry) and wrapping the latter two so the rest of the app only ever sees a
// collection. Throws GeoJsonError with a user-readable reason on anything else.
export function parseGeoJson(text: string): FeatureCollection {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new GeoJsonError("Not valid JSON — is this a GeoJSON file?");
  }

  if (!obj || typeof obj !== "object" || !("type" in obj)) {
    throw new GeoJsonError("Missing a GeoJSON \"type\" — not a GeoJSON object.");
  }

  const type = (obj as { type: unknown }).type;

  if (type === "FeatureCollection") {
    const fc = obj as FeatureCollection;
    if (!Array.isArray(fc.features)) {
      throw new GeoJsonError("FeatureCollection has no \"features\" array.");
    }
    return fc;
  }

  if (type === "Feature") {
    return { type: "FeatureCollection", features: [obj as Feature] };
  }

  const GEOMETRY_TYPES = [
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
  ];
  if (typeof type === "string" && GEOMETRY_TYPES.includes(type)) {
    return {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: obj as Geometry, properties: {} },
      ],
    };
  }

  throw new GeoJsonError(`Unsupported GeoJSON type "${String(type)}".`);
}

// Extent of every coordinate in the collection, as [w, s, e, n], so the map can
// fly to the uploaded data. Returns undefined when there are no coordinates.
export function geojsonBbox(fc: FeatureCollection): Bbox | undefined {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;

  const walk = (coords: unknown): void => {
    if (typeof coords === "number") return;
    if (Array.isArray(coords)) {
      // A position is [lng, lat, ...]; anything else is a nested array of them.
      if (typeof coords[0] === "number" && typeof coords[1] === "number") {
        const [lng, lat] = coords as number[];
        if (lng < w) w = lng;
        if (lng > e) e = lng;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      } else {
        for (const c of coords) walk(c);
      }
    }
  };

  const walkGeom = (g: Geometry | null): void => {
    if (!g) return;
    if (g.type === "GeometryCollection") g.geometries.forEach(walkGeom);
    else walk(g.coordinates);
  };

  for (const f of fc.features) walkGeom(f.geometry);

  if (w === Infinity) return undefined;
  return [w, s, e, n];
}

// --- polygon area ------------------------------------------------------------
// Spherical-excess ring area (the same approximation turf.area uses) — accurate
// to well under a percent at parcel scale, and dependency-free.

const EARTH_R = 6371008.8; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

function ringAreaM2(ring: Position[]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % n];
    const p3 = ring[(i + 2) % n];
    sum += (rad(p3[0]) - rad(p1[0])) * Math.sin(rad(p2[1]));
  }
  return Math.abs((sum * EARTH_R * EARTH_R) / 2);
}

// Outer ring minus holes; clamped so degenerate rings can't go negative.
const polygonAreaM2 = (coords: Position[][]): number =>
  coords.length
    ? Math.max(
        0,
        coords.slice(1).reduce((a, hole) => a - ringAreaM2(hole), ringAreaM2(coords[0])),
      )
    : 0;

function geometryAreaM2(g: Geometry | null): number {
  if (!g) return 0;
  switch (g.type) {
    case "Polygon":
      return polygonAreaM2(g.coordinates);
    case "MultiPolygon":
      return g.coordinates.reduce((a, p) => a + polygonAreaM2(p), 0);
    case "GeometryCollection":
      return g.geometries.reduce((a, gg) => a + geometryAreaM2(gg), 0);
    default:
      return 0;
  }
}

// Stamp `area_ha` onto each polygon feature (source-provided values are kept)
// and total the collection's polygon area, in hectares.
export function annotateAreaHa(fc: FeatureCollection): {
  fc: FeatureCollection;
  totalHa: number;
} {
  let totalM2 = 0;
  const features = fc.features.map((f) => {
    const m2 = geometryAreaM2(f.geometry);
    totalM2 += m2;
    if (m2 === 0 || f.properties?.area_ha !== undefined) return f;
    return {
      ...f,
      properties: {
        ...f.properties,
        area_ha: Math.round((m2 / 10_000) * 100) / 100,
      },
    };
  });
  return { fc: { ...fc, features }, totalHa: totalM2 / 10_000 };
}

// --- raster clip mask ----------------------------------------------------------

// Fixed id so each upload's mask replaces the previous one (addLayer is
// replace-on-same-id) and the AI can clear it with remove_layers(["clip-mask"]).
export const CLIP_MASK_LAYER_ID = "clip-mask";

// Covers everything MapLibre draws (web-mercator latitude limit, not ±90).
const WORLD_RING: Position[] = [
  [-180, -85.051129],
  [180, -85.051129],
  [180, 85.051129],
  [-180, 85.051129],
  [-180, -85.051129],
];

// Outer rings of every polygon in the geometry — these become the mask's holes.
// Polygon holes (donuts) are ignored: the whole outer extent stays unmasked.
function collectOuterRings(g: Geometry | null): Position[][] {
  if (!g) return [];
  switch (g.type) {
    case "Polygon":
      return g.coordinates.length ? [g.coordinates[0]] : [];
    case "MultiPolygon":
      return g.coordinates.filter((p) => p.length).map((p) => p[0]);
    case "GeometryCollection":
      return g.geometries.flatMap(collectOuterRings);
    default:
      return [];
  }
}

// "Clip" the rasters to an uploaded boundary: a world-covering polygon with
// each uploaded outer ring punched out as a hole. MapView renders it above the
// raster stack (MaskLayer, pinned under `vector-slot`) so imagery reads only
// inside the boundaries — MapLibre can't cut raster tiles to a polygon, so this
// inverse mask is the client-side clip, same idea as the TerriaJS dashboard's
// spotlight focus mask. Returns undefined when the upload contains no polygons
// (nothing to clip to). An ordinary store layer: the panel's opacity slider sets
// the dimming strength, unchecking or removing it un-clips.
export function buildClipMaskLayer(
  name: string,
  fc: FeatureCollection,
): MapLayer | undefined {
  const holes = fc.features.flatMap((f) => collectOuterRings(f.geometry));
  if (holes.length === 0) return undefined;
  return {
    id: CLIP_MASK_LAYER_ID,
    kind: "geojson-mask",
    label: `Clip: ${name}`,
    tiles: [],
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [WORLD_RING, ...holes] },
        },
      ],
    },
    opacity: 0.75,
    visible: true,
    description:
      "Masks rasters and basemap outside the uploaded boundaries. Lower the opacity to fade the surroundings back in; uncheck or remove to un-clip.",
  };
}

// One place that turns a parsed collection into a store layer, mirroring
// buildRasterLayer so the panel produces a well-formed MapLayer.
export function buildGeojsonLayer(
  name: string,
  fc: FeatureCollection,
  color: string,
): MapLayer {
  const { fc: annotated, totalHa } = annotateAreaHa(fc);
  const areaNote =
    totalHa > 0
      ? ` · ${totalHa.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha`
      : "";
  // Polygon uploads double as the AOI for the time-series average
  // (each polygon = one area).
  const statsNote =
    totalHa > 0
      ? " Pick it under “Time series” to average an index over each area across dates and export the per-AOI CSV."
      : "";
  return {
    id: `upload:${name}:${Date.now()}`,
    kind: "geojson-local",
    label: name,
    tiles: [],
    geojson: annotated,
    color,
    opacity: 1,
    visible: true,
    description: `Uploaded file · ${annotated.features.length} feature${
      annotated.features.length === 1 ? "" : "s"
    }${areaNote} (rendered locally, not saved).${statsNote}`,
  };
}
