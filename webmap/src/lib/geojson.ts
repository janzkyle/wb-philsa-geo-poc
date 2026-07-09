// Client-side GeoJSON ingest: parse a file the user picked, normalise it to a
// FeatureCollection, and turn it into a store MapLayer. Nothing here touches the
// network — the parsed features live in the browser and MapLibre renders them
// inline (see GeojsonLayer in MapView), the same "upload data" behaviour TerriaJS
// offers for local files.

import type { Feature, FeatureCollection, Geometry } from "geojson";
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

// One place that turns a parsed collection into a store layer, mirroring
// buildRasterLayer so the panel produces a well-formed MapLayer.
export function buildGeojsonLayer(
  name: string,
  fc: FeatureCollection,
  color: string,
): MapLayer {
  return {
    id: `upload:${name}:${Date.now()}`,
    kind: "geojson-local",
    label: name,
    tiles: [],
    geojson: fc,
    color,
    opacity: 1,
    visible: true,
    description: `Uploaded file · ${fc.features.length} feature${
      fc.features.length === 1 ? "" : "s"
    } (rendered locally, not saved)`,
  };
}
